'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Registry = require('../../../packages/server/src/registry');

function makeFakeWs() {
  return { readyState: 1, close: () => {} };
}

test('Registry: register adds peer and triggers onPeerListChanged', () => {
  const events = [];
  const reg = new Registry({
    onPeerListChanged: () => events.push('list'),
    onPeerGone: (id) => events.push(['gone', id]),
  });

  const ws = makeFakeWs();
  reg.register(ws, { clientId: 'a-1', deviceType: 'browser', name: 'A', autoAnswer: false });
  assert.equal(reg.size(), 1);
  assert.equal(reg.get('a-1').name, 'A');
  assert.equal(reg.get('a-1').status, 'online');
  assert.deepEqual(events, ['list']);
  reg.stop();
});

test('Registry: register replaces existing peer with same clientId', () => {
  let ev = 0;
  const reg = new Registry({ onPeerListChanged: () => ev++ });
  const ws1 = makeFakeWs();
  const ws2 = makeFakeWs();
  reg.register(ws1, { clientId: 'x', deviceType: 'browser', name: 'X' });
  assert.equal(reg.size(), 1);
  reg.register(ws2, { clientId: 'x', deviceType: 'browser', name: 'X2' });
  assert.equal(reg.size(), 1);
  assert.equal(reg.get('x').name, 'X2');
  assert.equal(reg.get('x').ws, ws2);
  assert.ok(ev >= 2);
  reg.stop();
});

test('Registry: heartbeat updates lastHeartbeat', () => {
  const reg = new Registry();
  const ws = makeFakeWs();
  reg.register(ws, { clientId: 'hb', deviceType: 'tui', name: 'HB' });
  const before = reg.get('hb').lastHeartbeat;
  reg.heartbeat('hb');
  const after = reg.get('hb').lastHeartbeat;
  assert.ok(after >= before);
  reg.stop();
});

test('Registry: remove triggers onPeerListChanged and onPeerGone', () => {
  const events = [];
  const reg = new Registry({
    onPeerListChanged: () => events.push('list'),
    onPeerGone: (id) => events.push(['gone', id]),
  });
  const ws = makeFakeWs();
  reg.register(ws, { clientId: 'g', deviceType: 'browser', name: 'G' });
  reg.remove('g');
  assert.equal(reg.size(), 0);
  assert.deepEqual(events, ['list', ['gone', 'g'], 'list']);
  reg.stop();
});

test('Registry: listPublic excludes self when filtered', () => {
  const reg = new Registry();
  const a = makeFakeWs(), b = makeFakeWs();
  reg.register(a, { clientId: 'a', deviceType: 'browser', name: 'A' });
  reg.register(b, { clientId: 'b', deviceType: 'tui', name: 'B', autoAnswer: true });
  const all = reg.listPublic();
  assert.equal(all.length, 2);
  const noA = all.filter((p) => p.clientId !== 'a');
  assert.equal(noA.length, 1);
  assert.equal(noA[0].clientId, 'b');
  assert.equal(noA[0].autoAnswer, true);
  reg.stop();
});

test('Registry: setStatus updates peer status', () => {
  const reg = new Registry();
  reg.register(makeFakeWs(), { clientId: 's', deviceType: 'browser', name: 'S' });
  assert.equal(reg.get('s').status, 'online');
  reg.setStatus('s', 'in-call');
  assert.equal(reg.get('s').status, 'in-call');
  reg.setStatus('s', 'online');
  assert.equal(reg.get('s').status, 'online');
  reg.stop();
});

test('Registry: sweep removes timed-out peers', () => {
  let goneIds = [];
  const reg = new Registry({ onPeerGone: (id) => goneIds.push(id) });
  reg.register(makeFakeWs(), { clientId: 'stale', deviceType: 'browser', name: 'S' });
  // 强制让 lastHeartbeat 老化
  reg.get('stale').lastHeartbeat = Date.now() - 70_000;
  reg.sweep();
  assert.equal(reg.size(), 0);
  assert.deepEqual(goneIds, ['stale']);
  reg.stop();
});

test('Registry: sweep keeps fresh peers', () => {
  const reg = new Registry();
  reg.register(makeFakeWs(), { clientId: 'fresh', deviceType: 'browser', name: 'F' });
  reg.get('fresh').lastHeartbeat = Date.now();
  reg.sweep();
  assert.equal(reg.size(), 1);
  reg.stop();
});

test('Registry: publicInfo returns null for unknown peer', () => {
  const reg = new Registry();
  assert.equal(reg.publicInfo('nonexistent'), null);
  reg.stop();
});