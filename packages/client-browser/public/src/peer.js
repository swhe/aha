// RTCPeerConnection 封装 + 信令事件转发
export class Peer {
  constructor({ signaling, callId, isInitiator, iceServers, onRemoteStream, onIceConnectionStateChange, onDataChannel, onLocalOffer, onLocalAnswer, onLocalIce, onControlMessage, onRelayNeeded, onRelayAudio }) {
    this.signaling = signaling;
    this.callId = callId;
    this.isInitiator = isInitiator;
    this.iceServers = iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    this.onRemoteStream = onRemoteStream;
    this.onIceConnectionStateChange = onIceConnectionStateChange;
    this.onDataChannel = onDataChannel;
    this.onLocalOffer = onLocalOffer;
    this.onLocalAnswer = onLocalAnswer;
    this.onLocalIce = onLocalIce;
    this.onControlMessage = onControlMessage;
    this.onRelayNeeded = onRelayNeeded;
    this.onRelayAudio = onRelayAudio;

    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.dataChannel = null;
    this.pendingIce = [];
    this.remoteDescSet = false;
    this._relayPlayer = null;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        if (this.onLocalIce) this.onLocalIce(e.candidate);
      }
    };

    this.pc.ontrack = (e) => {
      if (this.onRemoteStream) this.onRemoteStream(e.streams[0]);
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.onIceConnectionStateChange) {
        this.onIceConnectionStateChange(this.pc.iceConnectionState);
      }
      if (this.pc.iceConnectionState === 'failed') {
        if (this.onRelayNeeded) this.onRelayNeeded('audio');
      }
    };

    if (isInitiator) {
      this.dataChannel = this.pc.createDataChannel('control', { ordered: true });
      this._bindDataChannel(this.dataChannel);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._bindDataChannel(this.dataChannel);
        if (this.onDataChannel) this.onDataChannel(this.dataChannel);
      };
    }
  }

  _bindDataChannel(dc) {
    dc.onopen = () => {};
    dc.onclose = () => {};
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const msg = JSON.parse(e.data);
        if (this.onControlMessage) this.onControlMessage(msg);
      } catch (_) {}
    };
  }

  addLocalStream(stream) {
    for (const t of stream.getTracks()) {
      this.pc.addTrack(t, stream);
    }
  }

  async addLocalTrack(track, stream) {
    const sender = this.pc.addTrack(track, stream);
    return sender;
  }

  async removeTrackByKind(kind) {
    const senders = this.pc.getSenders();
    for (const s of senders) {
      if (s.track && s.track.kind === kind) {
        try { await this.pc.removeTrack(s); } catch (_) {}
      }
    }
  }

  async createOffer(opts) {
    const offer = await this.pc.createOffer(opts || {});
    await this.pc.setLocalDescription(offer);
    if (this.onLocalOffer) this.onLocalOffer(offer);
    return offer;
  }

  async createAnswer() {
    const ans = await this.pc.createAnswer();
    await this.pc.setLocalDescription(ans);
    if (this.onLocalAnswer) this.onLocalAnswer(ans);
    return ans;
  }

  async setRemote(sdp, kind) {
    let desc;
    if (typeof sdp === 'string') {
      const type = kind || 'answer';
      desc = { type, sdp };
    } else {
      desc = sdp;
    }
    await this.pc.setRemoteDescription(desc);
    this.remoteDescSet = true;
    while (this.pendingIce.length) {
      const c = this.pendingIce.shift();
      try { await this.pc.addIceCandidate(c); } catch (_) {}
    }
  }

  async addIce(c) {
    if (!this.remoteDescSet) {
      this.pendingIce.push(c);
      return;
    }
    try { await this.pc.addIceCandidate(c); } catch (_) {}
  }

  sendControl(action, params) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify({ action, params: params || {} }));
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  _ensureRelayPlayer(sampleRate = 48000, channels = 1) {
    if (this._relayPlayer && this._relayPlayer.sampleRate === sampleRate && this._relayPlayer.channels === channels) {
      return this._relayPlayer;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    const ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    const gain = ctx.createGain();
    gain.gain.value = 1.0;
    gain.connect(ctx.destination);
    this._relayPlayer = { ctx, gain, sampleRate, channels, queue: [], playing: false };
    return this._relayPlayer;
  }

  _drainRelay() {
    const p = this._relayPlayer;
    if (!p || p.playing) return;
    p.playing = true;
    const tick = () => {
      if (!this._relayPlayer || p !== this._relayPlayer) { p.playing = false; return; }
      const item = p.queue.shift();
      if (!item) { p.playing = false; return; }
      const src = p.ctx.createBufferSource();
      src.buffer = item;
      src.connect(p.gain);
      src.onended = () => tick();
      src.start();
    };
    tick();
  }

  feedRelayAudio({ data, encoding }) {
    if (!data) return;
    // payload: base64-encoded PCM s16le 48k mono (encoded at TUI capture stage)
    let raw;
    try { raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); } catch (_) { return; }
    if (encoding !== 'pcm-s16le') {
      // unknown encoding (legacy opus-over-relay); drop until server sends PCM
      return;
    }
    const sampleRate = 48000;
    const channels = 1;
    const frameSamples = raw.length / 2; // s16le mono
    const player = this._ensureRelayPlayer(sampleRate, channels);
    if (!player) return;
    const audioBuf = player.ctx.createBuffer(channels, frameSamples, sampleRate);
    const ch = audioBuf.getChannelData(0);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < frameSamples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    player.queue.push(audioBuf);
    this._drainRelay();
  }

  close() {
    try { this.dataChannel && this.dataChannel.close(); } catch (_) {}
    try { this.pc.close(); } catch (_) {}
    if (this._relayPlayer) {
      try { this._relayPlayer.ctx.close(); } catch (_) {}
      this._relayPlayer = null;
    }
  }

  getStats() {
    return this.pc.getStats();
  }
}