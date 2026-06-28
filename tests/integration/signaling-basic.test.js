'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, stopServer, WsClient } = require('./helpers');

let server;
test.before(async () => {
  server = await startServer();
});

test.after(async () => {
  await stopServer(server);
});

test('signaling: two clients register and see each other', async () => {
  const a = new WsClient(server.port, 'int-a', { name: 'A' });
  const b = new WsClient(server.port, 'int-b', { name: 'B' });
  await a.connect();
  await b.connect();

  // B 在注册时,server 在 register-ack 里把已在线的 A 发给它
  const bAck = b.inbox.find((m) => m.type === 'register-ack');
  assert.equal(bAck.payload.peers.length, 1);
  assert.equal(bAck.payload.peers[0].clientId, 'int-a');

  // A 后注册完毕,通过 peer-list 广播看到 B
  await a.waitFor('peer-list', 1000, (m) => m.payload.peers.some((p) => p.clientId === 'int-b'));
  const latestPl = a.inbox.filter((m) => m.type === 'peer-list').pop();
  assert.equal(latestPl.payload.peers.length, 1);
  assert.equal(latestPl.payload.peers[0].clientId, 'int-b');

  a.close(); b.close();
});

test('signaling: peer-list broadcast on connect', async () => {
  const a = new WsClient(server.port, 'pl-a', { name: 'A' });
  await a.connect();
  await a.waitForN('peer-list', 1);

  const b = new WsClient(server.port, 'pl-b', { name: 'B' });
  await b.connect();
  // a 收到包含 pl-b 的 peer-list
  await a.waitFor('peer-list', 1000, (m) => m.payload.peers.some((p) => p.clientId === 'pl-b'));
  a.close(); b.close();
});

test('signaling: heartbeat keeps peer alive', async () => {
  const a = new WsClient(server.port, 'hb-a', { name: 'A' });
  await a.connect();
  for (let i = 0; i < 3; i++) {
    a.send('heartbeat', {});
    await new Promise((r) => setTimeout(r, 100));
  }
  const resp = await fetch(`http://127.0.0.1:${server.port}/api/peers`).then((r) => r.json());
  assert.ok(resp.peers.find((p) => p.clientId === 'hb-a'));
  a.close();
});

test('signaling: server returns error on register without clientId', async () => {
  const ws = new WsClient(server.port, 'never-set');
  await new Promise((resolve, reject) => {
    ws.ws = new (require('ws'))(`ws://127.0.0.1:${server.port}`);
    ws.ws.on('open', () => {
      ws.ws.send(JSON.stringify({ type: 'register', payload: { deviceType: 'browser' } }));
    });
    ws.ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'error') resolve(m);
    });
    ws.ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 2000);
  }).then((m) => {
    assert.equal(m.type, 'error');
    assert.match(m.payload.message, /clientId/);
    ws.ws.close();
  });
});

test('signaling: peer-list reflects peer departure', async () => {
  const a = new WsClient(server.port, 'pll-a', { name: 'A' });
  const b = new WsClient(server.port, 'pll-b', { name: 'B' });
  await a.connect();
  await b.connect();
  // a 看到 b
  await a.waitFor('peer-list', 1000, (m) => m.payload.peers.some((p) => p.clientId === 'pll-b'));

  // 清空 a inbox,等 b 断开后 peer-list 不再包含 b
  a.inbox.length = 0;
  b.close();
  await a.waitFor('peer-list', 2000, (m) => !m.payload.peers.some((p) => p.clientId === 'pll-b'));
  a.close();
});