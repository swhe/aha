'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// stub blessed so TUI can construct without a tty
const stubWidget = () => {
  const w = {
    setContent: () => {},
    setItems: (items) => {
      w.ritems = items.slice();
      w.items = items.map(() => ({}));
    },
    focus: () => { w._focused = true; },
    on: () => {},
    key: () => {},
    removeKey: () => {},
    readInput: () => {},
    ask: () => {},
    destroy: () => {},
    display: () => {},
    render: () => {},
  };
  return w;
};

const stubBlessed = {
  screen: () => stubWidget(),
  box: () => stubWidget(),
  list: () => Object.assign(stubWidget(), { items: [], ritems: [], selected: 0 }),
  message: () => stubWidget(),
  prompt: () => stubWidget(),
  question: () => Object.assign(stubWidget(), { ask: () => {} }),
};

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'blessed') return stubBlessed;
  return origLoad.call(this, req, ...rest);
};

const TUI = require('../../../packages/client-tui/src/tui');

test('setPeers: populated peers are rendered into the list', () => {
  const tui = new TUI({ on: {} });
  tui.setPeers([
    { clientId: 'abc12345-001', deviceType: 'browser', name: 'browser-A', status: 'online', autoAnswer: false },
    { clientId: 'xyz98765-002', deviceType: 'tui', name: 'tui-B', status: 'in-call', autoAnswer: true },
  ]);
  assert.equal(tui.peerList.items.length, 2);
  assert.equal(tui.peerList.ritems[0].includes('browser-A'), true);
  assert.equal(tui.peerList.ritems[1].includes('tui-B'), true);
  assert.equal(tui._peerIdByIndex[0], 'abc12345-001');
  assert.equal(tui._peerIdByIndex[1], 'xyz98765-002');
});

test('setPeers: empty list clears items', () => {
  const tui = new TUI({ on: {} });
  tui.setPeers([{ clientId: 'a', deviceType: 'browser', name: 'x', status: 'online', autoAnswer: false }]);
  tui.setPeers([]);
  assert.equal(tui.peerList.items.length, 0);
});

test('constructor: peerList receives focus so arrow keys route correctly', () => {
  const tui = new TUI({ on: {} });
  assert.equal(tui.peerList._focused, true);
});

test('setMuted: shows notification on both mute and unmute', () => {
  const tui = new TUI({ on: {} });
  let lastStatus = null;
  const origSetStatus = tui.setStatus.bind(tui);
  tui.setStatus = (s) => { lastStatus = s; origSetStatus(s); };

  tui.setMuted(true);
  assert.equal(lastStatus.includes('麦克风已静音'), true);

  tui.setMuted(false);
  assert.equal(lastStatus.includes('麦克风已恢复'), true);
});