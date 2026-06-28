import { Signaling } from './signaling.js';
import { Peer } from './peer.js';
import { Media } from './media.js';
import { generateClientIdAsync } from './id.js';
import { MSG, shortId, genCallId } from './utils.js';

const DEFAULT_WS = `ws://${location.host || 'localhost:3000'}`;

class App {
  constructor() {
    this.clientId = null;
    this.peers = [];
    this.signaling = null;
    this.media = new Media();
    this.currentCall = null;
    this.pendingOffer = null;
    this.relayActive = false;
    this.records = [];
    this.isAutoAnswer = false;
    this.displayName = '';
    this.connected = false;

    this.$ = (id) => document.getElementById(id);
    this._bindUi();
  }

  async start() {
    this.clientId = await generateClientIdAsync();
    this.$('self-id').textContent = shortId(this.clientId);
    this.$('connect-btn').addEventListener('click', () => this.connect());
    this.$('auto-answer').addEventListener('change', (e) => {
      this.isAutoAnswer = e.target.checked;
    });
    this.$('display-name').addEventListener('change', (e) => {
      this.displayName = e.target.value.trim();
    });
  }

  _bindUi() {
    this.$('call-audio-btn').addEventListener('click', () => this.startCall('audio'));
    this.$('call-video-btn').addEventListener('click', () => this.startCall('video'));
    this.$('answer-btn').addEventListener('click', () => this.answer());
    this.$('reject-btn').addEventListener('click', () => this.reject());
    this.$('answer-main-btn').addEventListener('click', () => this.answer());
    this.$('hangup-btn').addEventListener('click', () => this.hangup());
    this.$('mute-btn').addEventListener('click', () => this.toggleMute());
    this.$('cam-btn').addEventListener('click', () => this.toggleCam());
    this.$('refresh-records').addEventListener('click', () => this.requestRecords());
  }

  setStatus(text, cls) {
    const el = this.$('status-text');
    el.textContent = text;
    el.className = `status ${cls || 'idle'}`;
  }

  toast(text, type) {
    const el = this.$('toast');
    el.textContent = text;
    el.className = `toast ${type || ''}`;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  connect() {
    if (this.connected) return;
    this.setStatus('连接中...', 'connecting');
    const url = (this.$('connect-btn').dataset.url) || DEFAULT_WS;
    this.signaling = new Signaling({
      url,
      clientId: this.clientId,
      onMessage: (m) => this._onMessage(m),
      onClose: () => {
        this.connected = false;
        this.setStatus('已断开,重连中...', 'error');
        this._setCallButtons(false);
      },
      onOpen: () => {},
    });
    this.signaling.connect({
      clientId: this.clientId,
      deviceType: 'browser',
      name: this.displayName || shortId(this.clientId),
      autoAnswer: this.isAutoAnswer,
    });
    setTimeout(() => {
      if (this.signaling && this.signaling.ws && this.signaling.ws.readyState === 1) {
        this.connected = true;
        this.setStatus('已连接', 'online');
        this._setCallButtons(true);
        this.$('connect-btn').textContent = '已连接';
        this.$('connect-btn').disabled = true;
      }
    }, 100);
  }

  _onMessage(m) {
    switch (m.type) {
      case MSG.REGISTER_ACK: this._onRegisterAck(m); break;
      case MSG.PEER_LIST: this._onPeerList(m); break;
      case MSG.PEER_LEFT: this._onPeerLeft(m); break;
      case MSG.CALL_INCOMING: this._onCallIncoming(m); break;
      case MSG.CALL_ANSWERED: this._onCallAnswered(m); break;
      case MSG.CALL_ICE: this._onCallIce(m); break;
      case MSG.CALL_REJECT: this._onCallReject(m); break;
      case MSG.CALL_HANGUP: this._onCallHangup(m); break;
      case MSG.CALL_STATUS_UPDATE: this._onCallStatus(m); break;
      case MSG.CALL_RECORDS: this._onCallRecords(m); break;
      case MSG.RELAY_START_ACK: this._onRelayStartAck(m); break;
      case MSG.RELAY_AUDIO: this._onRelayAudio(m); break;
      case MSG.CONTROL: this._onControl(m); break;
      case MSG.ERROR: this.toast('错误: ' + (m.payload?.message || 'unknown'), 'error'); break;
    }
  }

  _onRegisterAck(m) {
    this.peers = m.payload.peers || [];
    this._renderPeers();
  }

  _onPeerList(m) {
    this.peers = m.payload.peers || [];
    this._renderPeers();
  }

  _onPeerLeft(m) {
    this.peers = this.peers.filter((p) => p.clientId !== m.payload.clientId);
    this._renderPeers();
  }

  _onCallIncoming(m) {
    const p = m.payload;
    this.pendingOffer = { callId: p.callId, sdp: p.sdp, callType: p.callType, callerId: p.callerId, callerName: p.callerName };
    this.$('incoming-from').textContent = `${p.callerName} (${shortId(p.callerId)}) 来电`;
    this.$('incoming-type').textContent = p.callType === 'video' ? '视频通话' : '音频通话';
    this.$('incoming-panel').hidden = false;
    this.$('answer-main-btn').disabled = false;
    this.setStatus('来电...', 'ringing');
    // TUI 占位符 sdp:自动走中继模式(忽略浏览器手动接听按钮)
    const isPlaceholder = p.sdp === 'terminal-call-no-sdp';
    if (this.isAutoAnswer && p.callType === 'audio') {
      this.toast(isPlaceholder ? '自动应答(中继模式)' : '自动应答(仅音频)', 'success');
      setTimeout(() => this.answer(), 400);
    } else if (this.isAutoAnswer && p.callType === 'video') {
      this.toast('自动应答模式只接听音频,拒绝视频', 'error');
      this.reject('auto-answer-audio-only');
    }
  }

  _onCallAnswered(m) {
    const p = m.payload;
    if (!this.currentCall || p.callId !== this.currentCall.callId) return;
    if (p.sdp && p.sdp !== 'terminal-answer-no-sdp') {
      this.peer.setRemote(p.sdp).catch(() => {});
    } else {
      this.relayActive = true;
    }
    this.setStatus(this.relayActive ? '通话中(中继)' : '通话中', 'in-call');
    this.$('hangup-btn').disabled = false;
    this.$('mute-btn').disabled = false;
    this.$('cam-btn').disabled = this.currentCall.callType !== 'video';
    this.$('remote-placeholder').textContent = this.relayActive ? '等待中继...' : '连接中...';
  }

  _onCallIce(m) {
    if (!this.peer) return;
    const c = { candidate: m.payload.candidate, sdpMid: m.payload.sdpMid, sdpMLineIndex: m.payload.sdpMLineIndex };
    this.peer.addIce(c).catch(() => {});
  }

  _onCallReject(m) {
    this.toast(`对方${m.payload.reason === 'busy' ? '忙' : '拒绝了'}`, 'error');
    this._cleanupCall();
    this.setStatus('已连接', 'online');
  }

  _onCallHangup(m) {
    this.toast('对方已挂断', 'error');
    this._cleanupCall();
    this.setStatus('已连接', 'online');
  }

  _onCallStatus(m) {
    if (m.payload.status === 'ended' || m.payload.status === 'rejected') {
      this._cleanupCall();
    }
  }

  _onCallRecords(m) {
    this.records = m.payload.records || [];
    this._renderRecords();
  }

  _onRelayStartAck(m) {
    this.relayActive = true;
    this.toast(`已切换到中继模式 (${m.payload.mediaType})`, 'success');
    this.setStatus('通话中(中继)', 'in-call');
  }

  _onRelayAudio(m) {
    if (!this.peer) return;
    if (this.relayActive && this.peer.onRelayAudio) this.peer.onRelayAudio(m.payload);
  }

  _onControl(m) {
    const { action, params } = m.payload;
    this._handleRemoteControl(action, params);
  }

  async _handleRemoteControl(action, params) {
    if (!this.currentCall) return;
    switch (action) {
      case 'mute-mic':
        this.media.setAudioEnabled(false);
        this.$('mute-btn').classList.add('muted');
        this.$('mute-btn').textContent = '🎙 已静音';
        this.toast('对方将你静音', 'error');
        break;
      case 'unmute-mic':
        this.media.setAudioEnabled(true);
        this.$('mute-btn').classList.remove('muted');
        this.$('mute-btn').textContent = '🎙 静音';
        this.toast('对方解除你的静音', 'success');
        break;
      case 'cam-on':
        if (this.currentCall.callType === 'video') {
          try {
            await this.media.ensureVideo();
            const videoTracks = this.media.localStream.getVideoTracks();
            for (const t of videoTracks) {
              const sender = await this.peer.pc.addTrack(t, this.media.localStream);
              this._videoSenders = this._videoSenders || [];
              this._videoSenders.push(sender);
            }
            this.media.setVideoEnabled(true);
            this.$('local-video').srcObject = this.media.localStream;
            this.$('cam-btn').textContent = '📷 关闭';
            this.$('cam-btn').classList.remove('cam-off');
            this.toast('对方请求开启你的摄像头', 'success');
          } catch (e) {
            this.toast('无法启用摄像头: ' + e.message, 'error');
          }
        }
        break;
      case 'cam-off':
        if (this._videoSenders) {
          for (const s of this._videoSenders) {
            try { await this.peer.pc.removeTrack(s); } catch (_) {}
          }
        }
        this.media.setVideoEnabled(false);
        this.$('cam-btn').textContent = '📷 开启';
        this.$('cam-btn').classList.add('cam-off');
        this.toast('对方请求关闭你的摄像头', 'error');
        break;
      case 'global-mute':
        this.media.setAudioEnabled(false);
        this.toast(`对方启用了全局静音(${params?.duration || 0}s)`, 'error');
        break;
      case 'type-switch':
        if (params?.newType) {
          this.toast(`对方请求切换为${params.newType === 'video' ? '视频' : '音频'}`, 'success');
        }
        break;
    }
  }

  _setCallButtons(enabled) {
    this.$('call-audio-btn').disabled = !enabled;
    this.$('call-video-btn').disabled = !enabled;
  }

  _renderPeers() {
    const ul = this.$('peer-list');
    ul.innerHTML = '';
    const sel = this.$('call-target');
    const cur = sel.value;
    sel.innerHTML = '<option value="">选择被叫...</option>';
    this.$('peer-count').textContent = String(this.peers.length);
    for (const p of this.peers) {
      const li = document.createElement('li');
      li.dataset.clientId = p.clientId;
      const name = document.createElement('div');
      name.className = 'name';
      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = p.name;
      const id = document.createElement('div');
      id.className = 'id';
      id.textContent = shortId(p.clientId);
      name.appendChild(n); name.appendChild(id);
      const badge = document.createElement('span');
      badge.className = 'badge ' + p.deviceType;
      badge.textContent = p.deviceType;
      const auto = p.autoAnswer ? '<span class="badge auto">A</span>' : '';
      const busy = p.status === 'in-call' ? '<span class="badge busy">通话中</span>' : '';
      li.appendChild(name);
      const right = document.createElement('div');
      right.appendChild(badge);
      if (auto) {
        const a = document.createElement('span');
        a.className = 'badge auto';
        a.textContent = 'A';
        right.appendChild(a);
      }
      if (busy) {
        const b = document.createElement('span');
        b.className = 'badge busy';
        b.textContent = '通话中';
        right.appendChild(b);
      }
      li.appendChild(right);
      if (p.status === 'in-call') li.classList.add('disabled');
      else li.addEventListener('click', () => this._selectPeer(p));
      ul.appendChild(li);

      const opt = document.createElement('option');
      opt.value = p.clientId;
      opt.textContent = `${p.name} (${shortId(p.clientId)})`;
      if (p.status === 'in-call') opt.disabled = true;
      sel.appendChild(opt);
    }
    if (cur) sel.value = cur;
  }

  _renderRecords() {
    const ul = this.$('records-list');
    ul.innerHTML = '';
    for (const r of this.records) {
      const li = document.createElement('li');
      const row1 = document.createElement('div');
      row1.className = 'row1';
      const name = document.createElement('span');
      name.textContent = r.name;
      const badge = document.createElement('span');
      badge.className = 'badge ' + r.status;
      badge.textContent = r.status;
      row1.appendChild(name); row1.appendChild(badge);
      const row2 = document.createElement('div');
      row2.className = 'row2';
      const dur = r.duration != null ? `${r.duration}s` : '—';
      row2.textContent = `${r.callType} • ${r.callerName}→${r.calleeName} • ${dur} • ${r.startTime}`;
      li.appendChild(row1); li.appendChild(row2);
      ul.appendChild(li);
    }
  }

  _selectPeer(p) {
    this.$('call-target').value = p.clientId;
  }

  async startCall(type) {
    if (!this.connected) return;
    const target = this.$('call-target').value;
    if (!target) { this.toast('请选择被叫', 'error'); return; }
    const callId = genCallId();
    try {
      const stream = await this.media.get(type === 'video');
      this.$('local-video').srcObject = stream;
      const peer = new Peer({
        signaling: this.signaling,
        callId,
        isInitiator: true,
        onLocalOffer: (offer) => {
          this.signaling.send(MSG.CALL_OFFER, {
            callId, calleeId: target, callType: type, sdp: offer.sdp,
            callerName: this.displayName || shortId(this.clientId),
          });
        },
        onLocalIce: (c) => {
          this.signaling.send(MSG.CALL_ICE, {
            callId, candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex,
          });
        },
        onRemoteStream: (stream) => {
          const v = this.$('remote-video');
          v.srcObject = stream;
          v.play().catch(() => {});
          this.$('remote-placeholder').textContent = '';
          const tracks = stream.getAudioTracks();
          if (tracks.length > 0 && !tracks[0].enabled) {
            // 音频关闭
          }
        },
        onIceConnectionStateChange: (s) => {
          if (s === 'connected' || s === 'completed') {
            this.setStatus('通话中', 'in-call');
            this.$('remote-placeholder').textContent = '';
          }
        },
        onControlMessage: (msg) => this._handleRemoteControl(msg.action, msg.params),
        onRelayNeeded: () => {
          this.relayActive = true;
          this.toast('P2P 失败,切换到中继模式', 'error');
          this.signaling.send(MSG.RELAY_START, { callId, mediaType: type === 'video' ? 'audio' : 'audio' });
        },
      });
      peer.addLocalStream(stream);
      this.peer = peer;
      this.currentCall = { callId, type, peer: target, isInitiator: true };
      await peer.createOffer();
      this.setStatus(`呼叫 ${shortId(target)}...`, 'calling');
      this.$('hangup-btn').disabled = false;
    } catch (e) {
      this.toast('发起通话失败: ' + e.message, 'error');
      this._cleanupCall();
    }
  }

  async answer() {
    if (!this.pendingOffer) return;
    const { callId, sdp, callType, callerId, callerName } = this.pendingOffer;
    try {
      console.log('[aha] answer start, type=', callType);
      const stream = await this.media.get(callType === 'video');
      this.$('local-video').srcObject = stream;
      const peer = new Peer({
        signaling: this.signaling,
        callId,
        isInitiator: false,
        onLocalAnswer: (ans) => {
          this.signaling.send(MSG.CALL_ANSWER, { callId, sdp: ans.sdp });
        },
        onLocalIce: (c) => {
          this.signaling.send(MSG.CALL_ICE, {
            callId, candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex,
          });
        },
        onRemoteStream: (stream) => {
          const v = this.$('remote-video');
          v.srcObject = stream;
          v.play().catch(() => {});
          this.$('remote-placeholder').textContent = '';
        },
        onIceConnectionStateChange: (s) => {
          if (s === 'connected' || s === 'completed') {
            this.setStatus('通话中', 'in-call');
            this.$('remote-placeholder').textContent = '';
          }
        },
        onControlMessage: (msg) => this._handleRemoteControl(msg.action, msg.params),
        onRelayNeeded: () => {
          this.relayActive = true;
          this.toast('P2P 失败,切换到中继模式', 'error');
          this.signaling.send(MSG.RELAY_START, { callId, mediaType: 'audio' });
        },
      });
      peer.addLocalStream(stream);
      if (sdp && sdp !== 'terminal-call-no-sdp') {
        await peer.setRemote(sdp, 'offer');
        await peer.createAnswer();
      } else {
        this.relayActive = true;
        this.signaling.send(MSG.RELAY_START, { callId, mediaType: 'audio' });
      }
      this.peer = peer;
      this.currentCall = { callId, type: callType, peer: callerId, isInitiator: false, callerName };
      this.setStatus(this.relayActive ? '通话中(中继)' : '通话中', 'in-call');
      this.$('incoming-panel').hidden = true;
      this.$('answer-main-btn').disabled = true;
      this.$('hangup-btn').disabled = false;
      this.$('mute-btn').disabled = false;
      this.$('cam-btn').disabled = callType !== 'video';
      this.signaling.send(MSG.CALL_STATUS, { callId, status: 'connected' });
      this.pendingOffer = null;
    } catch (e) {
      this.toast('接听失败: ' + e.message, 'error');
      this.reject('error');
    }
  }

  reject(reason) {
    if (!this.pendingOffer) return;
    const { callId } = this.pendingOffer;
    this.signaling.send(MSG.CALL_REJECT, { callId, reason: reason || 'reject' });
    this.pendingOffer = null;
    this.$('incoming-panel').hidden = true;
    this.$('answer-main-btn').disabled = true;
    this.setStatus('已连接', 'online');
  }

  hangup() {
    if (!this.currentCall) return;
    const { callId } = this.currentCall;
    this.signaling.send(MSG.CALL_HANGUP, { callId, reason: 'hangup' });
    this._cleanupCall();
    this.setStatus('已连接', 'online');
  }

  toggleMute() {
    if (!this.currentCall) return;
    const enabled = this.media.toggleAudio();
    if (this.peer) this.peer.sendControl(enabled ? 'unmute-mic' : 'mute-mic');
    this.$('mute-btn').textContent = enabled ? '🎙 静音' : '🎙 已静音';
    this.$('mute-btn').classList.toggle('muted', !enabled);
  }

  async toggleCam() {
    if (!this.currentCall) return;
    if (this.currentCall.type !== 'video') {
      this.toast('当前是音频通话', 'error');
      return;
    }
    const has = this.media.hasVideo();
    if (!has) {
      try {
        await this.media.ensureVideo();
        this.$('local-video').srcObject = this.media.localStream;
        const senders = this.peer.pc.getSenders();
        const videoTracks = this.media.localStream.getVideoTracks();
        for (const t of videoTracks) {
          const exists = senders.find((s) => s.track === t);
          if (!exists) await this.peer.pc.addTrack(t, this.media.localStream);
        }
        this.media.setVideoEnabled(true);
        this.$('cam-btn').textContent = '📷 关闭';
        this.$('cam-btn').classList.remove('cam-off');
        this.peer.sendControl('cam-on');
      } catch (e) {
        this.toast('无法启用摄像头: ' + e.message, 'error');
      }
    } else {
      const enabled = this.media.toggleVideo();
      this.peer.sendControl(enabled ? 'cam-on' : 'cam-off');
      this.$('cam-btn').textContent = enabled ? '📷 关闭' : '📷 开启';
      this.$('cam-btn').classList.toggle('cam-off', !enabled);
    }
  }

  requestRecords() {
    if (!this.signaling) return;
    this.signaling.send(MSG.CALL_RECORDS_REQUEST, {});
  }

  _cleanupCall() {
    if (this.peer) { this.peer.close(); this.peer = null; }
    this.currentCall = null;
    this.pendingOffer = null;
    this.relayActive = false;
    this._videoSenders = null;
    this.media.stop();
    this.$('local-video').srcObject = null;
    this.$('remote-video').srcObject = null;
    this.$('remote-placeholder').textContent = '等待通话...';
    this.$('incoming-panel').hidden = true;
    this.$('hangup-btn').disabled = true;
    this.$('mute-btn').disabled = true;
    this.$('cam-btn').disabled = true;
    this.$('answer-main-btn').disabled = true;
    this.$('mute-btn').textContent = '🎙 静音';
    this.$('mute-btn').classList.remove('muted');
    this.$('cam-btn').textContent = '📷 关闭';
    this.$('cam-btn').classList.remove('cam-off');
    this.requestRecords();
  }
}

const app = new App();
app.start();
window._ahaApp = app;