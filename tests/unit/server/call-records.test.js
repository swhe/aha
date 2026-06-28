'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CallRecords = require('../../../packages/server/src/call-records');
const { CALL_STATUS } = require('../../../packages/server/src/types');

test('CallRecords: create assigns default name "<shortId>-<timestamp>"', () => {
  const cr = new CallRecords();
  const r = cr.create({
    callId: 'c1', callerId: 'abcdefgh-1234', calleeId: 'wxyz-5678',
    callerName: 'Alice', calleeName: 'Bob', callType: 'audio',
  });
  assert.equal(r.callId, 'c1');
  assert.equal(r.callType, 'audio');
  assert.equal(r.status, CALL_STATUS.RINGING);
  assert.match(r.name, /^abcdefgh-[a-z0-9]+$/);
  assert.ok(r.startTime);
  cr.cleanupForClient('anyone');
});

test('CallRecords: customName overrides default', () => {
  const cr = new CallRecords();
  const r = cr.create({
    callId: 'c2', callerId: 'a', calleeId: 'b',
    callerName: 'A', calleeName: 'B', callType: 'video',
    customName: 'team-meeting',
  });
  assert.equal(r.name, 'team-meeting');
});

test('CallRecords: update to connected records connectedTime', () => {
  const cr = new CallRecords();
  cr.create({ callId: 'c3', callerId: 'a', calleeId: 'b', callerName: 'A', calleeName: 'B', callType: 'audio' });
  cr.update('c3', { status: CALL_STATUS.CONNECTED });
  assert.equal(cr.get('c3').status, CALL_STATUS.CONNECTED);
  assert.ok(cr.get('c3').connectedTime);
});

test('CallRecords: update to ended computes duration', async () => {
  const cr = new CallRecords();
  cr.create({ callId: 'c4', callerId: 'a', calleeId: 'b', callerName: 'A', calleeName: 'B', callType: 'audio' });
  cr.update('c4', { status: CALL_STATUS.CONNECTED });
  // 等 1.1s 让 duration >= 1
  await new Promise((r) => setTimeout(r, 1100));
  cr.update('c4', { status: CALL_STATUS.ENDED });
  assert.equal(cr.get('c4').status, CALL_STATUS.ENDED);
  assert.ok(cr.get('c4').duration >= 1);
  assert.ok(cr.get('c4').endTime);
});

test('CallRecords: update to rejected/ended/missed all set endTime', () => {
  const cr = new CallRecords();
  for (const s of [CALL_STATUS.REJECTED, CALL_STATUS.MISSED, CALL_STATUS.ENDED]) {
    cr.create({ callId: 's-' + s, callerId: 'a', calleeId: 'b', callerName: 'A', calleeName: 'B', callType: 'audio' });
    cr.update('s-' + s, { status: s });
    assert.equal(cr.get('s-' + s).status, s);
    assert.ok(cr.get('s-' + s).endTime);
  }
});

test('CallRecords: list filters by clientId and sorts descending', async () => {
  const cr = new CallRecords();
  cr.create({ callId: 'l1', callerId: 'me', calleeId: 'other', callerName: 'Me', calleeName: 'Other', callType: 'audio' });
  await new Promise((r) => setTimeout(r, 5));
  cr.create({ callId: 'l2', callerId: 'other', calleeId: 'me', callerName: 'Other', calleeName: 'Me', callType: 'video' });
  await new Promise((r) => setTimeout(r, 5));
  cr.create({ callId: 'l3', callerId: 'stranger', calleeId: 'stranger2', callerName: 'X', calleeName: 'Y', callType: 'audio' });
  const mine = cr.list({ clientId: 'me' });
  assert.equal(mine.length, 2);
  assert.equal(mine[0].callId, 'l2'); // 最新优先
  assert.equal(mine[1].callId, 'l1');
});

test('CallRecords: cleanupForClient ends active calls of disconnected client', () => {
  const cr = new CallRecords();
  cr.create({ callId: 'x1', callerId: 'gone', calleeId: 'alive', callerName: 'G', calleeName: 'A', callType: 'audio' });
  cr.update('x1', { status: CALL_STATUS.CONNECTED });
  cr.cleanupForClient('gone');
  assert.equal(cr.get('x1').status, CALL_STATUS.ENDED);
});

test('CallRecords: setRelayMode toggles flag', () => {
  const cr = new CallRecords();
  cr.create({ callId: 'r1', callerId: 'a', calleeId: 'b', callerName: 'A', calleeName: 'B', callType: 'audio' });
  assert.equal(cr.get('r1').relayMode, false);
  cr.setRelayMode('r1', true);
  assert.equal(cr.get('r1').relayMode, true);
});

test('CallRecords: update unknown callId returns null', () => {
  const cr = new CallRecords();
  assert.equal(cr.update('nonexistent', { status: CALL_STATUS.ENDED }), null);
});

test('CallRecords: list respects limit', () => {
  const cr = new CallRecords();
  for (let i = 0; i < 5; i++) {
    cr.create({ callId: 'lim-' + i, callerId: 'a', calleeId: 'b', callerName: 'A', calleeName: 'B', callType: 'audio' });
  }
  assert.equal(cr.list({ limit: 2 }).length, 2);
});