#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { generateClientId, shortId } = require('./id');
const Signaling = require('./signaling');
const { AudioPipeline, detectAlsaDevice } = require('./media');
const TUI = require('./tui');
const { MSG, CALL_STATUS, genCallId } = require('./protocol');

const DEFAULT_WS = process.env.AHA_WS || 'ws://localhost:3000';

const program = new Command();
program
  .name('aha-tui')
  .description('AHA terminal client (audio + control)')
  .option('-s, --server <url>', 'signaling server ws URL', DEFAULT_WS)
  .option('-n, --name <name>', 'display name')
  .option('-a, --auto-answer', 'enable auto-answer (audio only)', false)
  .option('--capture <dev>', 'ALSA capture device (e.g. hw:0,0)')
  .option('--playback <dev>', 'ALSA playback device (e.g. hw:0,0)')
  .parse(process.argv);

const opts = program.opts();

const state = {
  clientId: generateClientId(),
  name: opts.name || null,
  autoAnswer: !!opts.autoAnswer,
  connected: false,
  peers: [],
  currentCall: null,
  pendingOffer: null,
  pipeline: null,
  recording: false,
  records: [],
};

const tui = new TUI({
  on: {
    call: (type) => startCall(type),
    answer: () => answer(),
    reject: () => reject(),
    hangup: () => hangup(),
    toggleMute: () => toggleMute(),
    listRecords: () => requestRecords(),
    toggleAuto: () => toggleAuto(),
    selectPeer: (id) => selectPeer(id),
    quit: () => quit(),
  },
});

const log = (s) => {
  if (process.env.AHA_DEBUG) {
    process.stderr.write(`[aha-tui] ${s}\n`);
  }
};

// 显式注册 SIGPIPE 忽略,避免管道关闭退出
process.on('SIGPIPE', () => {});

const signaling = new Signaling({
  url: opts.server,
  clientId: state.clientId || 'pending',
  onMessage: (m) => handle(m),
  onClose: () => {
    state.connected = false;
    tui.setHeader({ clientId: state.clientId, name: state.name, autoAnswer: state.autoAnswer, connected: false });
    tui.setStatus('已断开,正在重连...');
  },
});

async function main() {
  log('starting, server=' + opts.server);
  tui.setStatus('连接信令服务器...');
  try {
    await signaling.connect({
      clientId: state.clientId,
      deviceType: 'tui',
      name: state.name || shortId(state.clientId),
      autoAnswer: state.autoAnswer,
    });
    log('registered as ' + state.clientId);
    state.connected = true;
    tui.setHeader({ clientId: state.clientId, name: state.name, autoAnswer: state.autoAnswer, connected: true });
    tui.setStatus('已连接,等待通话...');
    setInterval(refreshDetail, 1000);
    startHeartbeatTick();
  } catch (e) {
    log('connect failed: ' + e.message);
    tui.setStatus('连接失败: ' + e.message);
    setTimeout(() => main(), 3000);
  }
}

function startHeartbeatTick() {}

function handle(m) {
  try {
    _handle(m);
  } catch (e) {
    log('handle error: ' + (e && e.stack ? e.stack : e));
  }
}

function _handle(m) {
  switch (m.type) {
    case MSG.REGISTER_ACK: {
      const p = m.payload || {};
      state.clientId = p.self?.clientId || state.clientId;
      state.name = p.self?.name || state.name;
      state.peers = p.peers || [];
      tui.setHeader({ clientId: state.clientId, name: state.name, autoAnswer: state.autoAnswer, connected: true });
      tui.setPeers(state.peers);
      tui.setStatus(`在线: ${state.peers.length} 个客户端`);
      break;
    }
    case MSG.PEER_LIST: {
      state.peers = m.payload.peers || [];
      tui.setPeers(state.peers);
      tui.setStatus(`在线: ${state.peers.length} 个客户端`);
      break;
    }
    case MSG.PEER_LEFT: {
      state.peers = state.peers.filter((p) => p.clientId !== m.payload.clientId);
      tui.setPeers(state.peers);
      break;
    }
    case MSG.CALL_INCOMING: {
      const p = m.payload;
      state.pendingOffer = p;
      if (state.autoAnswer && p.callType === 'audio') {
        tui.showNotification(`自动应答: ${p.callerName}`);
        setTimeout(() => answer(), 400);
      } else if (state.autoAnswer && p.callType === 'video') {
        tui.showNotification(`自动应答模式: 拒绝视频来电(${p.callerName})`);
        rejectCall('auto-answer-audio-only');
      } else {
        tui.promptIncoming(p,
          () => answer(),
          () => rejectCall('reject'),
        );
        tui.setStatus(`来电: ${p.callerName} (${p.callType === 'video' ? '视频' : '音频'})`);
      }
      break;
    }
    case MSG.CALL_ANSWERED: {
      state.currentCall = state.currentCall || {};
      state.currentCall.callId = m.payload.callId;
      state.currentCall.calleeId = m.payload.calleeId;
      state.currentCall.startedAt = Date.now();
      state.currentCall.relayMode = false;
      tui.setDetail({
        clientId: state.currentCall.peer,
        name: state.currentCall.peerName,
        callType: state.currentCall.callType,
        status: '已连接',
        startedAt: state.currentCall.startedAt,
      });
      tui.setStatus('通话中');
      break;
    }
    case MSG.CALL_REJECT: {
      const reason = m.payload.reason || 'reject';
      tui.showNotification(`对方${reason === 'busy' ? '忙' : '拒绝了'}`);
      cleanupCall();
      tui.setStatus('已连接,等待通话...');
      break;
    }
    case MSG.CALL_HANGUP: {
      tui.showNotification(`对方已挂断 (${m.payload.reason || ''})`);
      cleanupCall();
      tui.setStatus('已连接,等待通话...');
      break;
    }
    case MSG.CALL_STATUS_UPDATE: {
      if ([CALL_STATUS.ENDED, CALL_STATUS.REJECTED, CALL_STATUS.MISSED].includes(m.payload.status)) {
        cleanupCall();
        tui.setStatus('已连接,等待通话...');
      }
      break;
    }
    case MSG.CALL_RECORDS: {
      state.records = m.payload.records || [];
      showRecords();
      break;
    }
    case MSG.RELAY_START_ACK: {
      if (state.currentCall) state.currentCall.relayMode = true;
      tui.showNotification(`已进入中继模式 (${m.payload.mediaType})`);
      tui.setStatus('通话中(中继)');
      break;
    }
    case MSG.RELAY_AUDIO: {
      if (state.pipeline && state.currentCall && state.currentCall.callId === m.payload.callId) {
        state.pipeline.feedAudio({ data: m.payload.data, encoding: m.payload.encoding || 'opus' });
      }
      break;
    }
    case MSG.CONTROL: {
      handleRemoteControl(m.payload);
      break;
    }
    case MSG.ERROR: {
      tui.showNotification(`错误: ${m.payload?.message || ''}`);
      break;
    }
  }
}

function refreshDetail() {
  if (state.currentCall) {
    tui.setDetail({
      clientId: state.currentCall.peer,
      name: state.currentCall.peerName,
      callType: state.currentCall.callType,
      status: state.currentCall.relayMode ? '中继中' : 'P2P',
      startedAt: state.currentCall.startedAt,
    });
  }
}

function showRecords() {
  if (!state.records.length) {
    tui.showNotification('无通话记录');
    return;
  }
  const lines = state.records.slice(0, 10).map((r) => {
    const dur = r.duration != null ? `${r.duration}s` : '—';
    return `${r.name} [${r.callType}] ${r.status} ${dur} ${r.callerName}→${r.calleeName}`;
  });
  tui.showNotification('最近记录:\n' + lines.join('\n'), 5000);
}

function selectPeer(id) {
  const p = state.peers.find((x) => x.clientId === id);
  if (!p) return;
  state.selectedPeer = id;
  state.selectedPeerName = p.name;
  tui.setDetail({ clientId: id, name: p.name, callType: 'audio', status: '已选择' });
}

function startPipeline() {
  if (state.pipeline) return state.pipeline;
  state.pipeline = new AudioPipeline({
    log,
    onError: (kind, code) => {
      const dev = kind === 'capture' ? (opts.capture || detectAlsaDevice('capture')) : (opts.playback || detectAlsaDevice('playback'));
      tui.showNotification(
        `音频${kind === 'capture' ? '采集' : '播放'}失败 (${dev}): ffmpeg exit=${code} — 同机 ALSA 设备一次只能被一个进程独占,可能已有另一个 TUI 占用`,
      );
    },
    onOpusFrame: (frame) => {
      if (state.currentCall && state.currentCall.relayMode && signaling.isOpen()) {
        signaling.send(MSG.RELAY_AUDIO, {
          callId: state.currentCall.callId,
          seq: frame.seq,
          data: frame.data,
          ts: frame.ts,
          encoding: frame.encoding || 'pcm-s16le',
        });
      }
    },
  });
  state.pipeline.setDevices({ capture: opts.capture, playback: opts.playback });
  state.pipeline.start().catch((e) => {
    log('pipeline start failed: ' + e.message);
    tui.showNotification(
      '音频管线启动失败:同机 ALSA 设备一次只能被一个进程独占,可能已有另一个 TUI 占用,请关闭其它 TUI 后重试',
    );
  });
  return state.pipeline;
}

function stopPipeline() {
  if (state.pipeline) {
    state.pipeline.stop();
    state.pipeline = null;
  }
}

async function startCall(type) {
  if (state.currentCall) return tui.showNotification('已在通话中');
  if (!state.selectedPeer) return tui.showNotification('请先用 ↑/↓ 选择被叫 (回车确认)');
  const target = state.peers.find((p) => p.clientId === state.selectedPeer);
  if (!target) return tui.showNotification('被叫不在线');
  if (target.status === 'in-call') return tui.showNotification('对方忙');
  if (type === 'video') {
    tui.showNotification('终端模式不支持视频,降级为音频');
    type = 'audio';
  }
  const callId = genCallId();
  state.currentCall = {
    callId,
    callType: type,
    peer: state.selectedPeer,
    peerName: target.name,
    isInitiator: true,
    startedAt: null,
    relayMode: false,
  };
  signaling.send(MSG.CALL_OFFER, {
    callId,
    calleeId: target.clientId,
    callType: type,
    sdp: 'terminal-call-no-sdp',
    callerName: state.name || shortId(state.clientId),
  });
  tui.setDetail({
    clientId: target.clientId, name: target.name, callType: '音频', status: '呼叫中...', startedAt: null,
  });
  tui.setStatus('呼叫 ' + target.name + '...');
  // 终端模式无法建立 P2P,主动请求中继
  setTimeout(() => {
    if (state.currentCall && state.currentCall.callId === callId) {
      signaling.send(MSG.RELAY_START, { callId, mediaType: 'audio' });
      startPipeline();
    }
  }, 800);
}

async function answer() {
  if (!state.pendingOffer) return tui.showNotification('没有来电');
  const p = state.pendingOffer;
  if (p.callType === 'video') {
    tui.showNotification('终端模式不支持视频,降级为音频接听');
  }
  const callType = 'audio';
  state.currentCall = {
    callId: p.callId,
    callType,
    peer: p.callerId,
    peerName: p.callerName,
    isInitiator: false,
    startedAt: Date.now(),
    relayMode: false,
  };
  startPipeline();
  // 终端直接进入中继模式,绕过 SDP 协商
  // 仍发送 call-answer (占位符) 让服务端正常发 CALL_ANSWERED 给主叫
  signaling.send(MSG.CALL_ANSWER, { callId: p.callId, sdp: 'terminal-answer-no-sdp' });
  signaling.send(MSG.CALL_STATUS, { callId: p.callId, status: CALL_STATUS.CONNECTED });
  signaling.send(MSG.RELAY_START, { callId: p.callId, mediaType: 'audio' });
  state.pendingOffer = null;
  tui.setDetail({
    clientId: p.callerId, name: p.callerName, callType: '音频', status: '已连接(中继)', startedAt: state.currentCall.startedAt,
  });
  tui.setStatus('通话中(中继)');
}

function rejectCall(reason) {
  if (!state.pendingOffer) return;
  signaling.send(MSG.CALL_REJECT, { callId: state.pendingOffer.callId, reason: reason || 'reject' });
  state.pendingOffer = null;
  tui.setStatus('已拒绝');
}

function reject() {
  if (state.pendingOffer) {
    rejectCall('reject');
    return;
  }
  hangup();
}

function hangup() {
  if (!state.currentCall) return;
  signaling.send(MSG.CALL_HANGUP, { callId: state.currentCall.callId, reason: 'hangup' });
  cleanupCall();
  tui.setStatus('已挂断');
  requestRecords();
}

function cleanupCall() {
  stopPipeline();
  state.currentCall = null;
  state.pendingOffer = null;
  tui.setDetail({});
}

function toggleMute() {
  if (!state.pipeline) return tui.showNotification('未在通话中');
  const muted = !state.pipeline.isMuted();
  state.pipeline.setMuted(muted);
  tui.setMuted(muted);
  if (state.currentCall) {
    signaling.send(MSG.CONTROL, {
      callId: state.currentCall.callId,
      action: muted ? 'mute-mic' : 'unmute-mic',
    });
  }
}

function handleRemoteControl(payload) {
  const { action } = payload;
  if (!state.currentCall) return;
  switch (action) {
    case 'mute-mic':
      if (state.pipeline) state.pipeline.setMuted(true);
      tui.showNotification('对方将你静音');
      break;
    case 'unmute-mic':
      if (state.pipeline) state.pipeline.setMuted(false);
      tui.showNotification('对方解除你的静音');
      break;
    case 'cam-on':
    case 'cam-off':
      tui.showNotification('终端模式:忽略摄像头指令');
      break;
    case 'global-mute':
      if (state.pipeline) state.pipeline.setMuted(true);
      tui.showNotification(`对方启用全局静音(${payload.params?.duration || 0}s)`);
      break;
    case 'type-switch':
      tui.showNotification(`对方请求切换为${payload.params?.newType === 'video' ? '视频' : '音频'} - 终端模式仅支持音频`);
      break;
  }
}

function toggleAuto() {
  state.autoAnswer = !state.autoAnswer;
  tui.setHeader({ clientId: state.clientId, name: state.name, autoAnswer: state.autoAnswer, connected: state.connected });
  tui.showNotification(`自动应答已${state.autoAnswer ? '开启' : '关闭'} (重新连接后生效)`);
}

function requestRecords() {
  if (!signaling.isOpen()) return;
  signaling.send(MSG.CALL_RECORDS_REQUEST, {});
}

function quit() {
  if (state.currentCall) {
    signaling.send(MSG.CALL_HANGUP, { callId: state.currentCall.callId, reason: 'quit' });
  }
  signaling.close();
  stopPipeline();
  tui.destroy();
  process.exit(0);
}

process.on('SIGINT', () => quit());
process.on('SIGTERM', () => quit());

main();