// RTCPeerConnection 封装 + 信令事件转发
export class Peer {
  constructor({ signaling, callId, isInitiator, iceServers, onRemoteStream, onIceConnectionStateChange, onDataChannel, onLocalOffer, onLocalAnswer, onLocalIce, onControlMessage, onRelayNeeded }) {
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

    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.dataChannel = null;
    this.pendingIce = [];
    this.remoteDescSet = false;

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

  close() {
    try { this.dataChannel && this.dataChannel.close(); } catch (_) {}
    try { this.pc.close(); } catch (_) {}
  }

  getStats() {
    return this.pc.getStats();
  }
}