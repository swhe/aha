'use strict';

const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const fs = require('fs');

const Registry = require('./registry');
const CallRecords = require('./call-records');
const Relay = require('./relay');
const SignalingRouter = require('./signaling');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TLS_KEY = process.env.TLS_KEY;
const TLS_CERT = process.env.TLS_CERT;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || String(PORT + 443), 10);

function broadcastPeers(_msgType, _payload) {}

const registry = new Registry({
  onPeerListChanged: () => router._broadcastPeerList(),
  onPeerGone: (clientId) => router.onPeerGone(clientId),
  broadcast: broadcastPeers,
});

const callRecords = new CallRecords();

const relay = new Relay({
  registry,
  broadcast: (type, payload, targetId) => {
    const peer = registry.get(targetId);
    if (peer && peer.ws.readyState === 1) {
      try { peer.ws.send(JSON.stringify({ type, payload })); } catch (_) {}
    }
  },
});

const router = new SignalingRouter({ registry, callRecords, relay });

const path = require('path');

const BROWSER_DIR = path.resolve(__dirname, '../../client-browser/public');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function handleRequest(req, res) {
  const url = req.url.split('?')[0];

  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: registry.size(),
      calls: callRecords.records.size,
      uptime: process.uptime(),
    }));
    return;
  }

  if (url === '/api/peers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ peers: registry.listPublic() }));
    return;
  }

  let filePath = null;
  if (url === '/' || url === '/index.html') {
    filePath = path.join(BROWSER_DIR, 'index.html');
  } else if (url.startsWith('/src/') || url === '/styles.css') {
    filePath = path.join(BROWSER_DIR, url.replace(/^\//, ''));
  }

  if (filePath && fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime(filePath) });
    res.end(data);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    ws._ahaSession = { clientId: null };
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'error', payload: { message: 'invalid json' } })); } catch (_) {}
        return;
      }
      router.handle(ws, msg);
    });

    ws.on('close', () => {
      const sid = ws._ahaSession && ws._ahaSession.clientId;
      if (!sid) return;
      const current = registry.get(sid);
      if (current && current.ws === ws) {
        registry.remove(sid);
        router.onPeerGone(sid);
      }
    });

    ws.on('error', () => {});
  });

  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (_) {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30_000);

  wss.on('close', () => clearInterval(pingInterval));
  return { wss, pingInterval };
}

const servers = [];

if (TLS_KEY && TLS_CERT) {
  const tlsOptions = {
    key: fs.readFileSync(TLS_KEY),
    cert: fs.readFileSync(TLS_CERT),
  };
  const httpsServer = https.createServer(tlsOptions, handleRequest);
  attachWebSocket(httpsServer);
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`[aha-server] listening on https://${HOST}:${HTTPS_PORT}`);
    console.log(`[aha-server] WebSocket endpoint: wss://${HOST}:${HTTPS_PORT}`);
  });
  servers.push(httpsServer);
} else {
  const httpServer = http.createServer(handleRequest);
  attachWebSocket(httpServer);
  httpServer.listen(PORT, HOST, () => {
    console.log(`[aha-server] listening on http://${HOST}:${PORT}`);
    console.log(`[aha-server] WebSocket endpoint: ws://${HOST}:${PORT}`);
    console.log(`[aha-server] (set TLS_KEY + TLS_CERT to enable https/wss)`);
  });
  servers.push(httpServer);
}

function shutdown() {
  console.log('[aha-server] shutting down');
  registry.stop();
  for (const s of servers) {
    try { s.close(() => {}); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);