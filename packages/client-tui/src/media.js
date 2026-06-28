'use strict';

const { spawn } = require('child_process');
const OpusScript = require('opusscript');

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960; // 20ms @ 48kHz
const FRAME_BYTES = FRAME_SIZE * 2;

function detectAlsaDevice(kind) {
  // kind: 'capture' or 'playback'
  try {
    const { execSync } = require('child_process');
    const out = execSync(kind === 'capture' ? 'arecord -l 2>/dev/null' : 'aplay -l 2>/dev/null', { encoding: 'utf8' });
    const m = out.match(/card (\d+).*?device (\d+)/);
    if (m) return `hw:${m[1]},${m[2]}`;
  } catch (_) {}
  return kind === 'capture' ? 'default' : 'default';
}

class AudioPipeline {
  constructor({ onOpusFrame, onError, log = () => {} } = {}) {
    this.onOpusFrame = onOpusFrame || (() => {});
    this.onError = onError || (() => {});
    this.log = log;
    this.captureProc = null;
    this.playbackProc = null;
    this.encoder = null;
    this.decoder = null;
    this.muted = false;
    this.playbackBuffer = Buffer.alloc(0);
    this._seq = 0;
    this._captureDevice = null;
    this._playbackDevice = null;
  }

  _device(kind) {
    if (kind === 'capture') return this._captureDevice || detectAlsaDevice('capture');
    return this._playbackDevice || detectAlsaDevice('playback');
  }

  setDevices({ capture, playback } = {}) {
    this._captureDevice = capture || null;
    this._playbackDevice = playback || null;
  }

  async start() {
    if (this.captureProc || this.playbackProc) return;
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS);
    this.encoder.encoder_ctl && (this.encoder.encoder_ctl(4010, 32000), this.encoder.encoder_ctl(4012, 1101)); // bitrate, application=voip
    this.decoder = new OpusScript(SAMPLE_RATE, CHANNELS);
    this.captureEncoding = 'pcm-s16le';

    const captureDev = this._device('capture');
    this.captureProc = spawn('ffmpeg', [
      '-f', 'alsa',
      '-i', captureDev,
      '-ac', String(CHANNELS),
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      '-loglevel', 'error',
      'pipe:1',
    ]);

    let buf = Buffer.alloc(0);
    this.captureProc.stdout.on('data', (chunk) => {
      if (this.muted) return;
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= FRAME_BYTES) {
        const pcm = buf.slice(0, FRAME_BYTES);
        buf = buf.slice(FRAME_BYTES);
        // Emit raw PCM (s16le 48k mono) for relay — keeps browser side trivial
        // (Web Audio API plays PCM directly). Opus encoding remains available
        // on this.encoder for future use.
        this._seq++;
        this.onOpusFrame({ seq: this._seq, data: pcm.toString('base64'), ts: Date.now(), encoding: 'pcm-s16le' });
      }
    });

    this.captureProc.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.toLowerCase().includes('error') || s.toLowerCase().includes('device')) {
        this.log('ffmpeg-capture: ' + s.trim());
      }
    });

    this.captureProc.on('exit', (code) => {
      this.log(`capture ffmpeg exit code=${code}`);
      if (code !== 0 && code !== null) {
        this.onError('capture', code);
      }
    });

    const playbackDev = this._device('playback');
    this.playbackProc = spawn('ffmpeg', [
      '-f', 's16le',
      '-ac', String(CHANNELS),
      '-ar', String(SAMPLE_RATE),
      '-i', 'pipe:0',
      '-f', 'alsa',
      '-loglevel', 'error',
      playbackDev,
    ]);

    this.playbackProc.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.toLowerCase().includes('error') || s.toLowerCase().includes('device')) {
        this.log('ffmpeg-playback: ' + s.trim());
      }
    });

    this.playbackProc.on('exit', (code) => {
      this.log(`playback ffmpeg exit code=${code}`);
      if (code !== 0 && code !== null) {
        this.onError('playback', code);
      }
    });

    this.playbackProc.stdin.on('error', (e) => {
      this.log('playback stdin error: ' + e.message);
    });
  }

  feedAudio({ data, encoding }) {
    if (!this.playbackProc || !this.decoder) return;
    if (this.playbackProc.exitCode !== null) {
      this.log(`feedAudio: playback ffmpeg already exited (code=${this.playbackProc.exitCode})`);
      return;
    }
    try {
      const raw = Buffer.from(data, 'base64');
      if (encoding === 'pcm-s16le') {
        const ok = this.playbackProc.stdin.write(raw);
        if (!ok) this.playbackProc.stdin.once('drain', () => {});
        return;
      }
      // legacy opus-over-relay fallback
      const pcm = this.decoder.decode(raw);
      const ok = this.playbackProc.stdin.write(pcm);
      if (!ok) this.playbackProc.stdin.once('drain', () => {});
    } catch (e) {
      this.log('feedAudio error: ' + e.message);
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
  }

  isMuted() {
    return this.muted;
  }

  stop() {
    const cap = this.captureProc;
    const pb = this.playbackProc;
    this.captureProc = null;
    this.playbackProc = null;
    if (this.encoder) {
      try { this.encoder.delete(); } catch (_) {}
      this.encoder = null;
    }
    if (this.decoder) {
      try { this.decoder.delete(); } catch (_) {}
      this.decoder = null;
    }
    if (cap) {
      try { cap.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { cap.kill('SIGKILL'); } catch (_) {} }, 1500).unref?.();
    }
    if (pb) {
      try { pb.stdin.end(); } catch (_) {}
      try { pb.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { pb.kill('SIGKILL'); } catch (_) {} }, 1500).unref?.();
    }
  }
}

module.exports = { AudioPipeline, SAMPLE_RATE, CHANNELS, FRAME_SIZE };