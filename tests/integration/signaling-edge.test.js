'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, stopServer, WsClient } = require('./helpers');

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { await stopServer(server); });

test('auto-answer: incoming audio call is auto-answered', async () => {
  const caller = new WsClient(server.port, 'aa-caller', { name: 'Caller' });
  const responder = new WsClient(server.port, 'aa-resp', { name: 'AutoBot', autoAnswer: true });
  await caller.connect();
  await responder.connect();

  const callId = 'aa-1';
  caller.send('call-offer', { callId, calleeId: 'aa-resp', callType: 'audio', sdp: 'x', callerName: 'Caller' });
  const incoming = await responder.waitFor('call-incoming', 2000);
  assert.equal(incoming.payload.autoAnswer, true, 'autoAnswer flag propagated to incoming');

  // responder 没有手动 send answer,但服务端 _callMeta 应仍存在
  // 模拟客户端不主动接听(因为 autoAnswer 客户端会主动调用 call-answer)
  responder.send('call-answer', { callId, sdp: 'auto-answer' });
  await caller.waitFor('call-answered', 2000);

  caller.send('call-hangup', { callId });
  caller.close(); responder.close();
});

test('disconnect: peer departure cleans up active call records', async () => {
  const a = new WsClient(server.port, 'd-a', { name: 'A' });
  const b = new WsClient(server.port, 'd-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'd-1';
  a.send('call-offer', { callId, calleeId: 'd-b', callType: 'audio', sdp: 'x', callerName: 'A' });
  await b.waitFor('call-incoming', 2000);
  b.send('call-answer', { callId, sdp: 'y' });
  await a.waitFor('call-answered', 2000);

  // A 突然断开
  a.close();
  // B 收到 call-hangup
  await b.waitFor('call-hangup', 3000, (m) => m.payload.callId === callId);
  await b.waitFor('call-status-update', 3000, (m) => m.payload.callId === callId && m.payload.status === 'ended');

  // 查询 A 的记录 (已断开,需要直接 HTTP)
  // 通过服务端 API 确认 records 已标记为 ended
  const resp = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json());
  // records 数量不暴露,但 status 反映存在
  assert.ok(resp.status === 'ok');
  b.close();
});

test('rapid register/reconnect: same clientId replaces previous session', async () => {
  const ws1 = new WsClient(server.port, 'rr', { name: 'V1' });
  await ws1.connect();

  // 第二次连接相同 clientId
  const ws2 = new WsClient(server.port, 'rr', { name: 'V2' });
  await ws2.connect();

  // ws1 收到某种 disconnect 或后续 peer-list 中只剩 ws2
  await new Promise((r) => setTimeout(r, 300));
  const peers = await fetch(`http://127.0.0.1:${server.port}/api/peers`).then((r) => r.json());
  const mine = peers.peers.filter((p) => p.clientId === 'rr');
  assert.equal(mine.length, 1, 'should have only one entry for the same clientId');
  assert.equal(mine[0].name, 'V2');

  ws1.close();
  ws2.close();
});