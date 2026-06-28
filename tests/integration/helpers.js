'use strict';

// 共享测试工具:启动内存中的 aha-server,创建 ws 客户端

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForHttp(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      const req = require('node:http').get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('server start timeout'));
        setTimeout(check, 100);
      });
    }
    check();
  });
}

async function startServer() {
  const port = await findFreePort();
  const proc = spawn('node', [path.join(__dirname, '..', '..', 'packages', 'server', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', () => {}); // 抑制
  proc.stdout.on('data', () => {});
  await waitForHttp(port);
  return { proc, port };
}

function stopServer(s) {
  if (!s || !s.proc) return Promise.resolve();
  return new Promise((resolve) => {
    s.proc.once('exit', () => resolve());
    s.proc.kill('SIGTERM');
    setTimeout(() => {
      if (!s.proc.killed) {
        try { s.proc.kill('SIGKILL'); } catch (_) {}
      }
    }, 2000);
  });
}

class WsClient {
  constructor(port, clientId, opts = {}) {
    this.port = port;
    this.clientId = clientId;
    this.opts = opts;
    this.ws = null;
    this.inbox = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          type: 'register',
          payload: {
            clientId: this.clientId,
            deviceType: this.opts.deviceType || 'browser',
            name: this.opts.name || this.clientId,
            autoAnswer: !!this.opts.autoAnswer,
          },
        }));
      });
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.inbox.push(msg);
        const waiters = this.waiters.splice(0);
        for (const w of waiters) {
          if (w.match(msg)) {
            w.resolve(msg);
          } else {
            this.waiters.push(w); // 重排队
          }
        }
      });
      this.ws.on('error', (e) => {
        for (const w of this.waiters) w.reject(e);
        reject(e);
      });
      this.ws.on('close', () => {
        for (const w of this.waiters) w.reject(new Error('closed before match'));
      });

      this.waitFor('register-ack', 2000).then(resolve, reject);
    });
  }

  waitFor(type, timeoutMs = 2000, extraMatch) {
    const found = this.inbox.find((m) => m.type === type && (!extraMatch || extraMatch(m)));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { match: (m) => m.type === type && (!extraMatch || extraMatch(m)), resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`timeout waiting for ${type}`));
        }
      }, timeoutMs);
    });
  }

  waitForN(type, n, timeoutMs = 3000) {
    const matches = this.inbox.filter((m) => m.type === type);
    if (matches.length >= n) return Promise.resolve(matches.slice(0, n));
    return new Promise((resolve, reject) => {
      const w = {
        match: (m) => {
          if (m.type === type) {
            const all = this.inbox.filter((x) => x.type === type);
            return all.length >= n;
          }
          return false;
        },
        resolve: () => resolve(this.inbox.filter((m) => m.type === type).slice(0, n)),
        reject,
      };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`timeout waiting for ${n} ${type}, got ${this.inbox.filter((m) => m.type === type).length}`));
        }
      }, timeoutMs);
    });
  }

  send(type, payload) {
    return this.ws.send(JSON.stringify({ type, payload }));
  }

  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

module.exports = { startServer, stopServer, WsClient };