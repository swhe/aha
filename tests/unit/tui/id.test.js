'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateClientId, shortId } = require('../../../packages/client-tui/src/id');

test('generateClientId: format "<8 hex>-<8 hex>"', () => {
  const id = generateClientId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
});

test('generateClientId: two calls produce different ids', () => {
  const a = generateClientId();
  const b = generateClientId();
  assert.notEqual(a, b);
});

test('shortId: returns first 8 chars', () => {
  assert.equal(shortId('abcdef12-34567890'), 'abcdef12');
  assert.equal(shortId('short'), 'short');
  assert.equal(shortId(''), 'unknown');
  assert.equal(shortId(null), 'unknown');
});