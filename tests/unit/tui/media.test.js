'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { SAMPLE_RATE, CHANNELS, FRAME_SIZE } = require('../../../packages/client-tui/src/media');

test('media constants: 48kHz mono 20ms', () => {
  assert.equal(SAMPLE_RATE, 48000);
  assert.equal(CHANNELS, 1);
  assert.equal(FRAME_SIZE, 960); // 48000 * 0.02
});

test('opusscript round-trip: encode then decode returns samples', () => {
  const OpusScript = require('opusscript');
  const encoder = new OpusScript(SAMPLE_RATE, CHANNELS);
  const decoder = new OpusScript(SAMPLE_RATE, CHANNELS);
  // 静音 20ms PCM (960 samples * 2 bytes)
  const pcm = Buffer.alloc(FRAME_SIZE * 2, 0);
  const opus = encoder.encode(pcm, FRAME_SIZE);
  assert.ok(Buffer.isBuffer(opus));
  assert.ok(opus.length > 0 && opus.length < 4000, 'opus packet < 4KB');
  const decoded = decoder.decode(opus);
  assert.ok(Buffer.isBuffer(decoded) || Array.isArray(decoded));
  assert.equal(decoded.length, FRAME_SIZE * 2, 'decoded PCM should be 16-bit samples');
  encoder.delete();
  decoder.delete();
});

test('ffmpeg: silent audio generation runs and emits PCM', async () => {
  const ff = spawn('ffmpeg', [
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`,
    '-t', '0.1',
    '-ac', String(CHANNELS),
    '-ar', String(SAMPLE_RATE),
    '-f', 's16le',
    '-loglevel', 'error',
    'pipe:1',
  ]);
  const chunks = [];
  ff.stdout.on('data', (c) => chunks.push(c));
  ff.stderr.on('data', () => {}); // suppress
  const [code] = await once(ff, 'exit');
  assert.equal(code, 0, 'ffmpeg should exit 0');
  const total = Buffer.concat(chunks);
  // 0.1s @ 48kHz mono 16-bit = 9600 bytes
  assert.ok(total.length >= 9000, `expected ~9600 PCM bytes, got ${total.length}`);
});