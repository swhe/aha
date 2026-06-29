'use strict';

const blessed = require('blessed');
const { spawn } = require('child_process');
const { shortId } = require('./id');
const { detectAlsaDevice } = require('./media');

class TUI {
  constructor({ on, audioBackend, playbackDevice }) {
    this.on = on || {};
    this.audioBackend = audioBackend || 'alsa';
    this.playbackDevice = playbackDevice;
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'AHA Terminal Client',
      fullUnicode: true,
    });

    this.header = blessed.box({
      parent: this.screen,
      top: 0, left: 0, right: 0, height: 1,
      tags: true,
      style: { fg: 'white', bg: 'blue' },
      content: ' {bold}AHA{/bold} | 正在连接... ',
    });

    this.peerList = blessed.list({
      parent: this.screen,
      label: ' 在线客户端 (空格选择, Enter 呼叫) ',
      top: 1, left: 0, width: '40%', bottom: 8,
      border: 'line',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' },
        selected: { bg: 'cyan', fg: 'black' },
        item: { fg: 'white' },
      },
    });

    this.detail = blessed.box({
      parent: this.screen,
      label: ' 通话详情 ',
      top: 1, left: '40%', right: 0, bottom: 8,
      border: 'line',
      tags: true,
      content: this._renderDetail({}),
    });

    this.footer = blessed.box({
      parent: this.screen,
      bottom: 0, left: 0, right: 0, height: 3,
      tags: true,
      border: 'line',
      style: { border: { fg: 'gray' } },
      content: this._renderFooter(),
    });

    this.statusLine = blessed.box({
      parent: this.screen,
      bottom: 3, left: 0, right: 0, height: 1,
      tags: true,
      style: { fg: 'gray', bg: 'black' },
      content: ' {gray-fg}●{/} 状态: 空闲',
    });

    this.toast = blessed.message({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 'shrink',
      border: 'line',
      hidden: true,
      style: { border: { fg: 'yellow' } },
    });

    this.dialog = null;

    this._bindKeys();
    this.peerList.focus();
    this.screen.render();
  }

  _renderFooter() {
    return [
      ' {bold}C{/bold} 语音呼叫   {bold}V{/bold} 视频呼叫(拒绝,仅音频)   {bold}A{/bold} 接听   {bold}R{/bold} 拒绝   {bold}H{/bold} 挂断',
      ' {bold}M{/bold} 静音切换   {bold}L{/bold} 通话记录   {bold}U{/bold} 切换自动应答   {bold}Q{/bold} 退出',
    ].join('\n');
  }

  _renderDetail({ clientId, name, callType, status, startedAt }) {
    if (!clientId) {
      return '\n  尚未选择通话对象\n  \n  ↑/↓ 在左侧选择用户\n  按 C 发起语音呼叫';
    }
    const dur = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    const mm = String(Math.floor(dur / 60)).padStart(2, '0');
    const ss = String(dur % 60).padStart(2, '0');
    return [
      '',
      `  {bold}对端{/bold}   : ${name || '?'} (${shortId(clientId)})`,
      `  {bold}类型{/bold}   : ${callType === 'video' ? '视频' : '音频'}`,
      `  {bold}状态{/bold}   : ${status || '—'}`,
      `  {bold}时长{/bold}   : ${mm}:${ss}`,
      '',
      '  {gray-fg}按 H 挂断, M 静音, U 切换自动应答{/}',
    ].join('\n');
  }

  _bindKeys() {
    const handlers = {
      c: () => this.on.call && this.on.call('audio'),
      v: () => this.on.call && this.on.call('video'),
      a: () => this.on.answer && this.on.answer(),
      r: () => this.on.reject && this.on.reject(),
      h: () => this.on.hangup && this.on.hangup(),
      m: () => this.on.toggleMute && this.on.toggleMute(),
      l: () => this.on.listRecords && this.on.listRecords(),
      u: () => this.on.toggleAuto && this.on.toggleAuto(),
      q: () => this.on.quit && this.on.quit(),
    };
    for (const [k, h] of Object.entries(handlers)) {
      this.screen.key(k, h);
    }

    this.peerList.on('select', (_item) => {
      const idx = this.peerList.selected || 0;
      const c = this._peerIdByIndex && this._peerIdByIndex[idx];
      if (c && this.on.selectPeer) this.on.selectPeer(c);
    });

    // Incoming-call dialog handles Escape via question.ask() callback.
  }

  setHeader({ clientId, name, autoAnswer, connected, backend }) {
    const conn = connected ? '{green-fg}●已连接{/}' : '{red-fg}●未连接{/}';
    const auto = autoAnswer ? '{green-fg}自动应答:开{/}' : '{gray-fg}自动应答:关{/}';
    const bk = backend ? `{gray-fg}audio:${backend}{/}` : '';
    this.header.setContent(` {bold}AHA{/bold} | ${conn} | ${auto} | ID: ${shortId(clientId)} (${name || '匿名'}) | ${bk} `);
    this.screen.render();
  }

  setPeers(peers) {
    this._peerIdByIndex = {};
    const items = peers.map((p, i) => {
      const status = p.status === 'in-call' ? '{red-fg}[忙]{/}' : '{green-fg}[空闲]{/}';
      const auto = p.autoAnswer ? '{yellow-fg}[自动]{/}' : '';
      const type = `{${p.deviceType === 'browser' ? 'cyan' : 'magenta'}-fg}${p.deviceType[0].toUpperCase()}{/}`;
      const text = ` ${type} ${status} ${auto} ${p.name.padEnd(20, ' ')} ${shortId(p.clientId)}`;
      this._peerIdByIndex[i] = p.clientId;
      return text;
    });
    this.peerList.setItems(items);
    this.screen.render();
  }

  setDetail(opts) {
    this.detail.setContent(this._renderDetail(opts));
    this.screen.render();
  }

  setStatus(text) {
    this.statusLine.setContent(` {gray-fg}●{/} 状态: ${text}`);
    this.screen.render();
  }

  setMuted(muted) {
    if (muted) this.setStatus('{yellow-fg}●{/} 麦克风已静音');
    else this.setStatus('{green-fg}●{/} 麦克风已恢复');
  }

  showNotification(text, duration = 2000) {
    this.toast.display(text, duration, () => {});
  }

  _startRing() {
    if (this._ringProc) return;
    // Synthesize a two-tone ring (440 Hz 0.4s + 480 Hz 0.4s, 3 s period)
    // matching the browser's Web Audio ringtone, and play it through ffmpeg.
    const sampleRate = 48000;
    const period = 3;
    const toneDur = 0.4;
    const totalSamples = sampleRate * period;
    const buf = Buffer.alloc(totalSamples * 2);
    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      let sample = 0;
      if (t < toneDur) {
        sample = Math.sin(2 * Math.PI * 440 * t);
      } else if (t < toneDur * 2) {
        sample = Math.sin(2 * Math.PI * 480 * (t - toneDur));
      }
      // fade in/out (20 ms) to avoid clicks
      const fade = 0.02;
      let env = 1;
      if (t < fade) env = t / fade;
      else if (t > toneDur - fade && t < toneDur) env = (toneDur - t) / fade;
      else if (t > toneDur * 2 - fade && t < toneDur * 2) env = (toneDur * 2 - t) / fade;
      const val = Math.max(-1, Math.min(1, sample * env * 0.3));
      buf.writeInt16LE(Math.round(val * 32767), i * 2);
    }
    const dev = this.audioBackend === 'pulse'
      ? 'default'
      : (this.playbackDevice || detectAlsaDevice('playback'));
    const args = this.audioBackend === 'pulse'
      ? ['-f', 's16le', '-ac', '1', '-ar', '48000', '-i', 'pipe:0', '-f', 'pulse', dev]
      : ['-f', 's16le', '-ac', '1', '-ar', '48000', '-i', 'pipe:0', '-f', 'alsa', dev];
    this._ringProc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    this._ringProc.stdin.on('error', () => {});
    this._ringProc.on('exit', () => { this._ringProc = null; });
    const writeLoop = () => {
      if (!this._ringProc || !this._ringProc.stdin.writable) return;
      const ok = this._ringProc.stdin.write(buf);
      if (ok) setImmediate(writeLoop);
      else this._ringProc.stdin.once('drain', writeLoop);
    };
    writeLoop();
  }

  _stopRing() {
    if (this._ringProc) {
      try { this._ringProc.stdin.end(); } catch (_) {}
      try { this._ringProc.kill('SIGTERM'); } catch (_) {}
      this._ringProc = null;
    }
  }

  _cleanupDialogKeys() {
    if (this._dialogKeyHandlers) {
      for (const [key, handler] of this._dialogKeyHandlers) {
        this.screen.removeKey(key, handler);
      }
      this._dialogKeyHandlers = null;
    }
  }

  promptIncoming({ callerName, callerId, callType }, onAnswer, onReject) {
    if (this.dialog) { this.dialog.destroy(); this.dialog = null; }
    this._cleanupDialogKeys();
    this.dialog = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 9,
      border: 'line',
      tags: true,
      style: { border: { fg: 'yellow' } },
      label: ' 来电 ',
      content: `\n  [${callType === 'video' ? '视频' : '音频'}] ${callerName} (${shortId(callerId)})\n\n  按 Enter 接听 / Esc 拒绝`,
    });
    this.screen.render();
    this._startRing();
    const onEnter = () => {
      this._cleanupDialogKeys();
      this.dialog.destroy();
      this.dialog = null;
      this.screen.render();
      this._stopRing();
      onAnswer();
    };
    const onEsc = () => {
      this._cleanupDialogKeys();
      this.dialog.destroy();
      this.dialog = null;
      this.screen.render();
      this._stopRing();
      onReject();
    };
    this.screen.key(['enter'], onEnter);
    this.screen.key(['escape'], onEsc);
    this._dialogKeyHandlers = [['enter', onEnter], ['escape', onEsc]];
  }

  destroy() {
    this._stopRing();
    try { this.screen.destroy(); } catch (_) {}
  }
}

module.exports = TUI;