'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const MEDIA_PATH = path.join(__dirname, '../../../packages/client-tui/src/media.js');

function loadMediaFresh() {
  delete require.cache[MEDIA_PATH];
  return require(MEDIA_PATH);
}

const { SAMPLE_RATE, CHANNELS, FRAME_SIZE } = loadMediaFresh();

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

test('AudioPipeline.feedAudio: forwards pcm-s16le payload to playback stdin', () => {
  const { AudioPipeline } = loadMediaFresh();
  const written = [];
  const p = new AudioPipeline({
    onOpusFrame: () => {},
    log: () => {},
  });
  // Stub decoder and playbackProc
  p.decoder = { decode: () => Buffer.alloc(0) };
  p.playbackProc = { exitCode: null, stdin: { write: (b) => { written.push(Buffer.from(b)); return true; }, once: () => {} } };
  const pcm = Buffer.alloc(FRAME_SIZE * 2, 0);
  for (let i = 0; i < FRAME_SIZE; i++) pcm.writeInt16LE(i % 1000, i * 2);
  p.feedAudio({ data: pcm.toString('base64'), encoding: 'pcm-s16le' });
  assert.equal(written.length, 1);
  assert.ok(written[0].equals(pcm), 'written buffer equals input PCM');
});

test('AudioPipeline.feedAudio: skips when playbackProc has exited', () => {
  const { AudioPipeline } = loadMediaFresh();
  let writeCount = 0;
  const p = new AudioPipeline({ onOpusFrame: () => {}, log: () => {} });
  p.decoder = { decode: () => Buffer.alloc(0) };
  p.playbackProc = { exitCode: 1, stdin: { write: () => { writeCount++; return true; }, once: () => {} } };
  p.feedAudio({ data: Buffer.alloc(10).toString('base64'), encoding: 'pcm-s16le' });
  assert.equal(writeCount, 0);
});

// ----- ALSA device detection -----
// Use the AHA_FAKE_ALSA env hook in media.js: write a JSON file, point the
// env at it, and reload the module fresh.

function loadMediaWithFakeAlsa(captureOut, playbackOut) {
  const f = `/tmp/aha-test-fake-alsa-${process.pid}.json`;
  fs.writeFileSync(f, JSON.stringify({ capture: captureOut, playback: playbackOut }));
  process.env.AHA_FAKE_ALSA = f;
  return loadMediaFresh();
}

const ARECORD_USER = `**** List of CAPTURE Hardware Devices ****
card 0: sofhdadsp [sof-hda-dsp], device 0: HDA Analog (*) []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sofhdadsp [sof-hda-dsp], device 6: DMIC (*) []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sofhdadsp [sof-hda-dsp], device 7: DMIC16kHz (*) []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
`;

const APLAY_USER = `**** List of PLAYBACK Hardware Devices ****
card 0: sofhdadsp [sof-hda-dsp], device 0: HDA Analog (*) []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sofhdadsp [sof-hda-dsp], device 3: HDMI 0 (*) []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
`;

test('detectAlsaDevice: capture picks DMIC over HDA Analog (with plughw prefix)', () => {
  const { detectAlsaDevice } = loadMediaWithFakeAlsa(ARECORD_USER, APLAY_USER);
  assert.equal(detectAlsaDevice('capture'), 'plughw:0,6');
});

test('detectAlsaDevice: playback picks HDA Analog (raw hw: for low latency)', () => {
  const { detectAlsaDevice } = loadMediaWithFakeAlsa(ARECORD_USER, APLAY_USER);
  assert.equal(detectAlsaDevice('playback'), 'hw:0,0');
});

test('detectAlsaDevice: falls back to "default" when arecord/aplay missing', () => {
  const { detectAlsaDevice } = loadMediaWithFakeAlsa('', '');
  assert.equal(detectAlsaDevice('capture'), 'default');
  assert.equal(detectAlsaDevice('playback'), 'default');
});

test('detectAlsaDevice: USB / headset names also win over HDA Analog', () => {
  const cap = `card 0: hda [HDA Intel], device 0: ALC285 Analog (*)\ncard 1: webcam [USB Microphone], device 0: USB Audio (*)\n`;
  const { detectAlsaDevice } = loadMediaWithFakeAlsa(cap, '');
  assert.equal(detectAlsaDevice('capture'), 'plughw:1,0');
});

test('detectAlsaDevice: when only HDA Analog is available, capture still uses plughw', () => {
  // Some laptops only expose HDA Analog for both directions; capture should
  // still go through the plughw plugin so software can upmix/reroute.
  const { detectAlsaDevice } = loadMediaWithFakeAlsa('card 0: hda [HDA Intel], device 0: ALC285 Analog (*)\n', '');
  assert.equal(detectAlsaDevice('capture'), 'plughw:0,0');
});

// ----- audio backend resolution -----

test('resolveAudioBackend: explicit "pulse" wins regardless of pactl', () => {
  const { resolveAudioBackend } = loadMediaFresh();
  assert.equal(resolveAudioBackend('pulse'), 'pulse');
});

test('resolveAudioBackend: explicit "alsa" wins regardless of pactl', () => {
  const { resolveAudioBackend } = loadMediaFresh();
  assert.equal(resolveAudioBackend('alsa'), 'alsa');
});

test('resolveAudioBackend: undefined (auto) picks whatever pactl says', () => {
  const { resolveAudioBackend } = loadMediaFresh();
  // This box either has pulse or not — either is fine; we just assert the
  // function returns one of the two known values.
  assert.match(resolveAudioBackend(undefined), /^(pulse|alsa)$/);
});