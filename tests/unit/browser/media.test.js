'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MEDIA_PATH = path.join(__dirname, '../../../packages/client-browser/public/src/media.js');

function loadMediaWith({ navigator, mediaDevices }) {
  const src = fs.readFileSync(MEDIA_PATH, 'utf8');
  const cjs = src.replace(/export\s+class\s+(\w+)/g, 'class $1');
  const fn = new Function('navigator', 'module', cjs + '\nmodule.exports = { Media };');
  const m = { exports: {} };
  // Bind navigator into the function scope. We expose a mutable object so we
  // can pretend the runtime changes (e.g. mediaDevices appears later).
  const nav = navigator || {};
  nav.mediaDevices = mediaDevices;
  fn(nav, m);
  return m.exports;
}

test('Media.get: throws clear error when navigator.mediaDevices is missing', async () => {
  const { Media } = loadMediaWith({ navigator: {}, mediaDevices: undefined });
  const m = new Media();
  await assert.rejects(
    () => m.get(false),
    (err) => {
      assert.equal(err.code, 'NO_MEDIA_DEVICES');
      assert.match(err.message, /安全上下文/);
      assert.match(err.message, /https/);
      return true;
    },
  );
});

test('Media.get: throws clear error when mediaDevices is present but has no getUserMedia', async () => {
  const { Media } = loadMediaWith({ navigator: {}, mediaDevices: {} });
  const m = new Media();
  await assert.rejects(
    () => m.get(false),
    (err) => err.code === 'NO_MEDIA_DEVICES',
  );
});

test('Media.get: invokes getUserMedia when available', async () => {
  const fakeStream = {
    getTracks: () => [],
    getAudioTracks: () => [],
    getVideoTracks: () => [],
  };
  let calledWith = null;
  const gUM = async (c) => { calledWith = c; return fakeStream; };
  const { Media } = loadMediaWith({ navigator: {}, mediaDevices: { getUserMedia: gUM } });
  const m = new Media();
  const stream = await m.get(false);
  assert.equal(stream, fakeStream);
  assert.ok(calledWith, 'getUserMedia should have been called');
  assert.deepEqual(calledWith.video, false);
  assert.equal(calledWith.audio.echoCancellation, true);
});

test('Media.ensureVideo: throws clear error on non-secure context', async () => {
  const { Media } = loadMediaWith({ navigator: {}, mediaDevices: undefined });
  const m = new Media();
  await assert.rejects(
    () => m.ensureVideo(),
    (err) => err.code === 'NO_MEDIA_DEVICES',
  );
});