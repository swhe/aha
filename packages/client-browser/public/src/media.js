// 媒体设备管理
export class Media {
  constructor() {
    this.localStream = null;
    this.audioEnabled = true;
    this.videoEnabled = false;
    this.audioMutedByRemote = false;
  }

  async get(enableVideo) {
    await this.stop();
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: enableVideo ? {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24 },
      } : false,
    };
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.videoEnabled = enableVideo;
      this.audioEnabled = true;
      return this.localStream;
    } catch (e) {
      if (enableVideo) {
        console.warn('[media] camera failed, fallback to audio', e);
        return this.get(false);
      }
      throw e;
    }
  }

  async ensureVideo() {
    if (!this.localStream || this.localStream.getVideoTracks().length === 0) {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: true });
      const audioTracks = this.localStream ? this.localStream.getAudioTracks() : [];
      this.localStream = new MediaStream([...fresh.getVideoTracks(), ...audioTracks]);
      this.videoEnabled = true;
      return this.localStream;
    }
    return this.localStream;
  }

  toggleAudio() {
    if (!this.localStream) return false;
    this.audioEnabled = !this.audioEnabled;
    for (const t of this.localStream.getAudioTracks()) t.enabled = this.audioEnabled;
    return this.audioEnabled;
  }

  setAudioEnabled(enabled) {
    if (!this.localStream) return;
    this.audioEnabled = !!enabled;
    for (const t of this.localStream.getAudioTracks()) t.enabled = this.audioEnabled;
  }

  toggleVideo() {
    if (!this.localStream) return false;
    if (this.localStream.getVideoTracks().length === 0) return false;
    this.videoEnabled = !this.videoEnabled;
    for (const t of this.localStream.getVideoTracks()) t.enabled = this.videoEnabled;
    return this.videoEnabled;
  }

  setVideoEnabled(enabled) {
    if (!this.localStream) return;
    const tracks = this.localStream.getVideoTracks();
    if (tracks.length === 0) return;
    this.videoEnabled = !!enabled;
    for (const t of tracks) t.enabled = this.videoEnabled;
  }

  hasVideo() {
    return !!(this.localStream && this.localStream.getVideoTracks().length > 0);
  }

  async stop() {
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        try { t.stop(); } catch (_) {}
      }
    }
    this.localStream = null;
    this.audioEnabled = true;
    this.videoEnabled = false;
  }
}