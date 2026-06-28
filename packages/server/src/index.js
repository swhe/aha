'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const Registry = require('./registry');
const CallRecords = require('./call-records');
const Relay = require('./relay');
const SignalingRouter = require('./signaling');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

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
const fs = require('fs');

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

const server = http.createServer((req, res) => {
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
});

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
    // 只移除当前 ws 仍是这个 clientId 的活跃连接时才清理,
    // 否则可能是被新连接强制关闭的旧 ws
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

server.listen(PORT, HOST, () => {
  console.log(`[aha-server] listening on http://${HOST}:${PORT}`);
  console.log(`[aha-server] WebSocket endpoint: ws://${HOST}:${PORT}`);
});

function shutdown() {
  console.log('[aha-server] shutting down');
  registry.stop();
  clearInterval(pingInterval);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);