'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Relay = require('../../../packages/server/src/relay');

function makeFakeRegistry(peerIds) {
  const map = new Map();
  for (const id of peerIds) {
    map.set(id, {
      clientId: id,
      ws: {
        readyState: 1,
        sent: [],
        send(data) { this.sent.push(JSON.parse(data)); },
      },
    });
  }
  return {
    get: (id) => map.get(id),
    _map: map,
  };
}

test('Relay: start creates session and notifies both peers', () => {
  const reg = makeFakeRegistry(['A', 'B']);
  const relay = new Relay({ registry: reg, broadcast: () => {} });
  const ok = relay.start({ callId: 'c1', requesterId: 'A', peerId: 'B', mediaType: 'audio' });
  assert.equal(ok, true);
  assert.equal(relay.sessions.size, 1);
  assert.equal(relay.isActive('c1'), true);
  const ackA = reg.get('A').ws.sent.find((m) => m.type === 'relay-start-ack');
  const ackB = reg.get('B').ws.sent.find((m) => m.type === 'relay-start-ack');
  assert.ok(ackA, 'A should receive ack');
  assert.ok(ackB, 'B should receive ack');
  assert.equal(ackA.payload.role, 'requester');
  assert.equal(ackB.payload.role, 'peer');
  assert.equal(ackA.payload.mediaType, 'audio');
});

test('Relay: start fails when peer is not in registry', () => {
  const reg = makeFakeRegistry(['A']);
  const relay = new Relay({
    registry: reg,
    broadcast: () => {},
  });
  const ok = relay.start({ callId: 'c2', requesterId: 'A', peerId: 'unknown', mediaType: 'audio' });
  assert.equal(ok, false);
  assert.equal(relay.isActive('c2'), false);
  // requester 收到 ERROR 消息
  const errMsg = reg.get('A').ws.sent.find((m) => m.type === 'error');
  assert.ok(errMsg, 'requester should receive error');
});

test('Relay: forward routes audio from A to B (and vice versa)', () => {
  const reg = makeFakeRegistry(['A', 'B']);
  const relay = new Relay({ registry: reg, broadcast: () => {} });
  relay.start({ callId: 'c3', requesterId: 'A', peerId: 'B', mediaType: 'audio' });

  // 清空 ack
  reg.get('A').ws.sent.length = 0;
  reg.get('B').ws.sent.length = 0;

  relay.forward('c3', 'A', { seq: 1, data: 'opus-data', ts: 1234 });
  const bMsg = reg.get('B').ws.sent.find((m) => m.type === 'relay-audio');
  assert.ok(bMsg);
  assert.equal(bMsg.from, 'A');
  assert.equal(bMsg.payload.seq, 1);
  assert.equal(bMsg.payload.data, 'opus-data');
  // A 不应收到自己的音频
  assert.equal(reg.get('A').ws.sent.length, 0);

  relay.forward('c3', 'B', { seq: 2, data: 'reply', ts: 1235 });
  const aMsg = reg.get('A').ws.sent.find((m) => m.type === 'relay-audio');
  assert.ok(aMsg);
  assert.equal(aMsg.from, 'B');
});

test('Relay: forward returns false for unknown callId', () => {
  const reg = makeFakeRegistry(['A', 'B']);
  const relay = new Relay({ registry: reg, broadcast: () => {} });
  assert.equal(relay.forward('unknown', 'A', { seq: 1, data: 'x' }), false);
});

test('Relay: stop removes session', () => {
  const reg = makeFakeRegistry(['A', 'B']);
  const relay = new Relay({ registry: reg, broadcast: () => {} });
  relay.start({ callId: 'c4', requesterId: 'A', peerId: 'B', mediaType: 'audio' });
  assert.equal(relay.isActive('c4'), true);
  relay.stop('c4');
  assert.equal(relay.isActive('c4'), false);
});