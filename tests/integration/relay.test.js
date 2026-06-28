'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, stopServer, WsClient } = require('./helpers');

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { await stopServer(server); });

test('relay: full audio forwarding path A↔B', async () => {
  const a = new WsClient(server.port, 'rl-a', { name: 'A' });
  const b = new WsClient(server.port, 'rl-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'rl-1';
  a.send('call-offer', { callId, calleeId: 'rl-b', callType: 'audio', sdp: 'x', callerName: 'A' });
  await b.waitFor('call-incoming', 2000);
  b.send('call-answer', { callId, sdp: 'y' });
  await a.waitFor('call-answered', 2000);

  // A 请求中继
  a.send('relay-start', { callId, mediaType: 'audio' });
  await a.waitFor('relay-start-ack', 2000, (m) => m.payload.callId === callId);
  await b.waitFor('relay-start-ack', 2000, (m) => m.payload.callId === callId);

  // A 发送音频帧
  b.inbox.length = 0;
  a.send('relay-audio', { callId, seq: 1, data: 'opus-frame-1', ts: 1000 });
  a.send('relay-audio', { callId, seq: 2, data: 'opus-frame-2', ts: 1020 });
  const audio = await b.waitForN('relay-audio', 2, 2000);
  assert.equal(audio[0].payload.seq, 1);
  assert.equal(audio[0].payload.data, 'opus-frame-1');
  assert.equal(audio[0].from, 'rl-a');
  assert.equal(audio[1].payload.seq, 2);

  // B 回复音频帧给 A
  a.inbox.length = 0;
  b.send('relay-audio', { callId, seq: 1, data: 'reply-1', ts: 1030 });
  const bAudio = await a.waitFor('relay-audio', 2000, (m) => m.payload.data === 'reply-1');
  assert.equal(bAudio.from, 'rl-b');

  a.send('call-hangup', { callId });
  a.close(); b.close();
});

test('relay: relay-audio before relay-start is dropped', async () => {
  const a = new WsClient(server.port, 'drop-a', { name: 'A' });
  const b = new WsClient(server.port, 'drop-b', { name: 'B' });
  await a.connect();
  await b.connect();

  // 不建立 call 也不请求 relay,直接发送 relay-audio
  a.send('relay-audio', { callId: 'unknown', seq: 1, data: 'x', ts: 1 });
  // B 不应收到任何 relay-audio (因为没有 session)
  await new Promise((r) => setTimeout(r, 500));
  const got = b.inbox.find((m) => m.type === 'relay-audio');
  assert.equal(got, undefined);
  a.close(); b.close();
});

test('relay: stop removes active session', async () => {
  const a = new WsClient(server.port, 'st-a', { name: 'A' });
  const b = new WsClient(server.port, 'st-b', { name: 'B' });
  await a.connect();
  await b.connect();

  const callId = 'st-1';
  a.send('call-offer', { callId, calleeId: 'st-b', callType: 'audio', sdp: 'x', callerName: 'A' });
  await b.waitFor('call-incoming', 2000);
  b.send('call-answer', { callId, sdp: 'y' });
  await a.waitFor('call-answered', 2000);
  a.send('relay-start', { callId, mediaType: 'audio' });
  await a.waitFor('relay-start-ack', 2000);
  await b.waitFor('relay-start-ack', 2000);

  a.send('relay-stop', { callId });
  await new Promise((r) => setTimeout(r, 200));
  b.inbox.length = 0;
  a.send('relay-audio', { callId, seq: 1, data: 'x', ts: 1 });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(b.inbox.find((m) => m.type === 'relay-audio'), undefined);

  a.send('call-hangup', { callId });
  a.close(); b.close();
});