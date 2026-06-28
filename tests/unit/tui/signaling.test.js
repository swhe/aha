'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load the source and extract shouldTrustTls for testing without dragging in 'ws'.
const src = fs.readFileSync(
  path.join(__dirname, '../../../packages/client-tui/src/signaling.js'),
  'utf8',
);
const fnSrc = src.match(/function shouldTrustTls[\s\S]+?\n}/)[0];
const fn = new Function(`${fnSrc}; return shouldTrustTls;`)();

test('shouldTrustTls: ws:// schemes pass through (no TLS)', () => {
  assert.equal(fn('ws://localhost:3000'), true);
  assert.equal(fn('ws://192.168.1.34:3000'), true);
  assert.equal(fn('ws://example.com:80'), true);
});

test('shouldTrustTls: loopback hosts trust self-signed', () => {
  assert.equal(fn('wss://localhost'), true);
  assert.equal(fn('wss://localhost:3443'), true);
  assert.equal(fn('wss://127.0.0.1:3443'), true);
  assert.equal(fn('wss://[::1]:3443'), true);
});

test('shouldTrustTls: RFC1918 private ranges trust self-signed', () => {
  assert.equal(fn('wss://10.0.0.1'), true);
  assert.equal(fn('wss://192.168.1.34:3443'), true);
  assert.equal(fn('wss://172.16.0.1'), true);
  assert.equal(fn('wss://172.31.255.255:3443'), true);
});

test('shouldTrustTls: RFC1918 adjacent ranges still require a real cert', () => {
  assert.equal(fn('wss://172.15.0.1'), false); // just outside 172.16/12
  assert.equal(fn('wss://172.32.0.1'), false);
});

test('shouldTrustTls: .local and ULA IPv6 trust self-signed', () => {
  assert.equal(fn('wss://aha.local'), true);
  assert.equal(fn('wss://[fc00::1]'), true);
  assert.equal(fn('wss://[fd12:3456::1]:3443'), true);
});

test('shouldTrustTls: public hostnames/IPs require a real cert', () => {
  assert.equal(fn('wss://example.com'), false);
  assert.equal(fn('wss://example.com:443'), false);
  assert.equal(fn('wss://8.8.8.8'), false);
  assert.equal(fn('wss://1.1.1.1:443'), false);
});

test('shouldTrustTls: malformed URL falls back to strict', () => {
  assert.equal(fn('not a url'), false);
  assert.equal(fn(''), false);
});
