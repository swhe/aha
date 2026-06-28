'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, stopServer, WsClient } = require('./helpers');

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { await stopServer(server); });

test('call flow: offer → answer → status updates reach both peers', async () => {
  const a = new WsClient(server.port, 'cf-a', { name: 'A' });
  const b = new WsClient(server.port, 'cf-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'test-cf-1';
  a.send('call-offer', {
    callId, calleeId: 'cf-b', callType: 'audio', sdp: 'fake-sdp', callerName: 'A',
  });

  // B 收到来电
  const incoming = await b.waitFor('call-incoming', 2000);
  assert.equal(incoming.payload.callId, callId);
  assert.equal(incoming.payload.callerId, 'cf-a');
  assert.equal(incoming.payload.callType, 'audio');

  // 服务端创建记录 (通过 call-records-request 验证)
  b.send('call-answer', { callId, sdp: 'fake-answer' });

  // A 收到 answered
  const answered = await a.waitFor('call-answered', 2000);
  assert.equal(answered.payload.callId, callId);
  assert.equal(answered.payload.calleeId, 'cf-b');

  // 双方都收到 status=connected
  const statusA = await a.waitFor('call-status-update', 2000, (m) => m.payload.callId === callId && m.payload.status === 'connected');
  const statusB = await b.waitFor('call-status-update', 2000, (m) => m.payload.callId === callId && m.payload.status === 'connected');
  assert.equal(statusA.payload.status, 'connected');
  assert.equal(statusB.payload.status, 'connected');

  // A 挂断
  a.send('call-hangup', { callId });
  await a.waitFor('call-status-update', 2000, (m) => m.payload.callId === callId && m.payload.status === 'ended');
  await b.waitFor('call-hangup', 2000);

  a.close(); b.close();
});

test('call flow: rejected call sets status=rejected on both', async () => {
  const a = new WsClient(server.port, 'rj-a', { name: 'A' });
  const b = new WsClient(server.port, 'rj-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'test-rj-1';
  a.send('call-offer', { callId, calleeId: 'rj-b', callType: 'audio', sdp: 'x', callerName: 'A' });
  await b.waitFor('call-incoming', 2000);

  b.send('call-reject', { callId, reason: 'busy' });
  await a.waitFor('call-reject', 2000, (m) => m.payload.callId === callId);
  await a.waitFor('call-status-update', 2000, (m) => m.payload.callId === callId && m.payload.status === 'rejected');
  await b.waitFor('call-status-update', 2000, (m) => m.payload.callId === callId && m.payload.status === 'rejected');

  a.close(); b.close();
});

test('call flow: ICE candidates are forwarded between peers', async () => {
  const a = new WsClient(server.port, 'ice-a', { name: 'A' });
  const b = new WsClient(server.port, 'ice-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'test-ice-1';
  a.send('call-offer', { callId, calleeId: 'ice-b', callType: 'audio', sdp: 'x', callerName: 'A' });
  await b.waitFor('call-incoming', 2000);

  a.send('call-ice', { callId, candidate: 'cand-1', sdpMid: '0', sdpMLineIndex: 0 });
  const ice = await b.waitFor('call-ice', 2000);
  assert.equal(ice.payload.candidate, 'cand-1');
  assert.equal(ice.payload.from, 'ice-a');

  b.send('call-ice', { callId, candidate: 'cand-2', sdpMid: '0', sdpMLineIndex: 0 });
  const ice2 = await a.waitFor('call-ice', 2000);
  assert.equal(ice2.payload.candidate, 'cand-2');
  assert.equal(ice2.payload.from, 'ice-b');

  // 清理
  a.send('call-hangup', { callId });
  a.close(); b.close();
});

test('control: relay control message between peers', async () => {
  const a = new WsClient(server.port, 'ctrl-a', { name: 'A' });
  const b = new WsClient(server.port, 'ctrl-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'test-ctrl-1';
  a.send('call-offer', { callId, calleeId: 'ctrl-b', callType: 'audio', sdp: 'x', callerName: 'A' });
  await b.waitFor('call-incoming', 2000);
  b.send('call-answer', { callId, sdp: 'y' });
  await a.waitFor('call-answered', 2000);

  a.send('control', { callId, action: 'mute-mic' });
  const ctrl = await b.waitFor('control', 2000);
  assert.equal(ctrl.payload.action, 'mute-mic');
  assert.equal(ctrl.payload.from, 'ctrl-a');

  a.send('call-hangup', { callId });
  a.close(); b.close();
});

test('call records: created on offer, accessible via records request', async () => {
  const a = new WsClient(server.port, 'rec-a', { name: 'A' });
  const b = new WsClient(server.port, 'rec-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'test-rec-1';
  a.send('call-offer', { callId, calleeId: 'rec-b', callType: 'video', sdp: 'x', callerName: 'A' });
  await b.waitFor('call-incoming', 2000);
  b.send('call-answer', { callId, sdp: 'y' });
  await a.waitFor('call-answered', 2000);

  a.send('call-records-request', {});
  const resp = await a.waitFor('call-records', 2000);
  const rec = resp.payload.records.find((r) => r.callId === callId);
  assert.ok(rec);
  assert.equal(rec.callType, 'video');
  assert.equal(rec.status, 'connected');
  assert.equal(rec.callerName, 'A');
  assert.equal(rec.calleeName, 'B');
  assert.match(rec.name, /^rec-a-/);

  a.send('call-hangup', { callId });
  a.close(); b.close();
});

test('error: call-offer with missing fields returns error', async () => {
  const a = new WsClient(server.port, 'err-a', { name: 'A' });
  await a.connect();
  a.send('call-offer', { callId: 'c', callType: 'audio' }); // 缺 calleeId
  const err = await a.waitFor('error', 2000);
  assert.match(err.payload.message, /missing/);
  a.close();
});

test('error: call-offer to offline callee returns error', async () => {
  const a = new WsClient(server.port, 'ol-a', { name: 'A' });
  await a.connect();
  a.send('call-offer', { callId: 'c', calleeId: 'nonexistent', callType: 'audio', sdp: 'x' });
  const err = await a.waitFor('error', 2000);
  assert.match(err.payload.message, /not online/);
  a.close();
});