'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MSG, CALL_STATUS } = require('../../../packages/server/src/types');

test('MSG: all expected message types defined', () => {
  const required = [
    'REGISTER', 'REGISTER_ACK', 'HEARTBEAT', 'PEER_LIST', 'PEER_LEFT',
    'CALL_OFFER', 'CALL_INCOMING', 'CALL_ANSWER', 'CALL_ANSWERED', 'CALL_ICE',
    'CALL_REJECT', 'CALL_HANGUP', 'CALL_STATUS', 'CALL_STATUS_UPDATE',
    'CALL_RECORDS_REQUEST', 'CALL_RECORDS',
    'RELAY_START', 'RELAY_START_ACK', 'RELAY_AUDIO', 'RELAY_STOP',
    'CONTROL', 'ERROR',
  ];
  for (const k of required) {
    assert.ok(MSG[k], `MSG.${k} missing`);
  }
});

test('MSG: values are non-empty strings and unique', () => {
  const vals = Object.values(MSG);
  for (const v of vals) {
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0);
  }
  const unique = new Set(vals);
  assert.equal(unique.size, vals.length, 'duplicate MSG values');
});

test('CALL_STATUS: contains expected lifecycle states', () => {
  for (const s of ['RINGING', 'CONNECTED', 'ENDED', 'REJECTED', 'MISSED']) {
    assert.ok(CALL_STATUS[s], `CALL_STATUS.${s} missing`);
  }
});