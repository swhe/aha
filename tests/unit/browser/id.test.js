'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ID_PATH = path.join(__dirname, '../../../packages/client-browser/public/src/id.js');

function loadWith({ crypto, navigator = {}, screen = {} }) {
  // Strip ESM exports and evaluate as CommonJS so we can require it as a module.
  const src = fs.readFileSync(ID_PATH, 'utf8');
  const cjs = src.replace(/export\s+async\s+function\s+(\w+)/g, 'async function $1')
                 .replace(/export\s+function\s+(\w+)/g, 'function $1');
  const fn = new Function('crypto', 'navigator', 'screen', 'module', cjs + '\nmodule.exports = { generateClientId, generateClientIdAsync };');
  const m = { exports: {} };
  fn(crypto, navigator, screen, m);
  return m.exports;
}

const fakeNav = { userAgent: 'ua-test', language: 'en', hardwareConcurrency: 4 };
const fakeScreen = { width: 1280, height: 720 };

function fakeCryptoNoSubtle() {
  return {
    getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (i * 17 + 3) & 0xff; return b; },
  };
}

function fakeCryptoFull() {
  return {
    subtle: { digest: async () => new Uint8Array(32).fill(0xab) },
    getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = 0xcd; return b; },
  };
}

test('id: generateClientIdAsync works without crypto.subtle (non-secure context)', async () => {
  const mod = loadWith({ crypto: fakeCryptoNoSubtle(), navigator: fakeNav, screen: fakeScreen });
  const id = await mod.generateClientIdAsync();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
});

test('id: generateClientIdAsync works with full crypto.subtle', async () => {
  const mod = loadWith({ crypto: fakeCryptoFull(), navigator: fakeNav, screen: fakeScreen });
  const id = await mod.generateClientIdAsync();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
});

test('id: generateClientId (sync) works without crypto.subtle', () => {
  const mod = loadWith({ crypto: fakeCryptoNoSubtle(), navigator: fakeNav, screen: fakeScreen });
  const id = mod.generateClientId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
});

test('id: stable pseudoMac fingerprint across calls (same browser)', async () => {
  const mod = loadWith({ crypto: fakeCryptoNoSubtle(), navigator: fakeNav, screen: fakeScreen });
  const a = (await mod.generateClientIdAsync()).slice(0, 8);
  const b = (await mod.generateClientIdAsync()).slice(0, 8);
  assert.equal(a, b);
});