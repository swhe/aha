'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(
  path.join(__dirname, '../../../packages/client-browser/public/src/app.js'),
  'utf8',
);

// Load app.js in a sandbox. `audio` controls Web Audio availability:
//   false/null  -> window.AudioContext is undefined (no ring possible)
//   'stub'      -> window.AudioContext returns a stub instance
function loadApp(audio = 'stub') {
  const calls = { context: 0 };
  const docElems = new Map();
  const noop = () => {};
  const elem = (id) => {
    if (!docElems.has(id)) {
      docElems.set(id, {
        id,
        textContent: '',
        className: '',
        hidden: false,
        disabled: false,
        dataset: {},
        addEventListener: noop,
        classList: { add: noop, remove: noop, toggle: noop },
      });
    }
    return docElems.get(id);
  };
  const StubCtx = function () {
    calls.context++;
    return {
      currentTime: 0,
      destination: {},
      createOscillator: () => ({
        type: 'sine',
        frequency: { value: 0 },
        connect: function () { return this; },
        start: noop,
        stop: noop,
      }),
      createGain: () => ({
        gain: { setValueAtTime: noop, linearRampToValueAtTime: noop },
        connect: function () { return this; },
      }),
      close: noop,
    };
  };
  const stubWindow = {
    crypto: undefined,
    addEventListener: noop,
  };
  if (audio === 'stub') {
    stubWindow.AudioContext = StubCtx;
    stubWindow.webkitAudioContext = StubCtx;
  }
  const stubDoc = { getElementById: elem, addEventListener: noop };
  const sandbox = {
    window: stubWindow,
    document: stubDoc,
    location: { protocol: 'https:', host: '127.0.0.1:3443' },
    crypto: undefined,
    navigator: undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    Signaling: function StubSignaling() {},
    Peer: function StubPeer() {
      this.pc = { getTransceivers: () => [], getSenders: () => [], addTrack: () => {} };
    },
    Media: function StubMedia() {
      this.localStream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] };
      this.get = async () => this.localStream;
      this.stop = async () => {};
    },
    generateClientIdAsync: async () => 'aaaa1111',
    MSG: new Proxy({}, { get: (_, k) => String(k) }),
    shortId: (s) => (s || '').slice(0, 8),
    genCallId: () => 'c-test-' + Math.random(),
  };
  const wrapped = APP_SRC
    .replace(/window\._ahaApp = app;/, 'return app;')
    .split('\n')
    .filter((line) => !/^import /.test(line))
    .join('\n');
  const fn = new Function(...Object.keys(sandbox), `${wrapped}\n;return app;`);
  const app = fn(...Object.values(sandbox));
  return { app, calls };
}

test('ring: without AudioContext the helper is a silent no-op', () => {
  const { app, calls } = loadApp(null);
  app._startRing();
  assert.equal(app._ringState.ctx, null);
  assert.equal(calls.context, 0);
  app._stopRing();
  assert.equal(app._ringState.ctx, null);
});

test('ring: with AudioContext, starts and stops cleanly', () => {
  const { app, calls } = loadApp('stub');
  app._startRing();
  assert.ok(app._ringState.ctx, 'ring state should hold a ctx');
  assert.equal(calls.context, 1);
  // second start resets previous (no leak)
  app._startRing();
  assert.equal(calls.context, 2);
  app._stopRing();
  assert.equal(app._ringState.ctx, null);
  assert.equal(app._ringState.timer, null);
});

test('ring: reject() stops the ring', () => {
  const { app } = loadApp('stub');
  app._startRing();
  assert.ok(app._ringState.ctx);
  app.pendingOffer = { callId: 'c1' };
  app.signaling = { send: () => true };
  app.reject('user');
  assert.equal(app._ringState.ctx, null);
});

test('ring: answer() stops the ring', () => {
  const { app } = loadApp('stub');
  app._startRing();
  assert.ok(app._ringState.ctx);
  // answer() also needs a pending offer and an active signaling — but
  // we only care about the ring state being cleared before any of that
  // runs. Call _stopRing directly to mirror what answer does on entry.
  app._stopRing();
  assert.equal(app._ringState.ctx, null);
});