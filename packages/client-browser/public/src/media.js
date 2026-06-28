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
    // navigator.mediaDevices is undefined on non-secure contexts (plain http on
    // a non-loopback host). Surface a clear error instead of an opaque
    // "Cannot read properties of undefined (reading 'getUserMedia')".
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const err = new Error('需要安全上下文才能访问麦克风/摄像头:请用 https:// 或 http://localhost/127.0.0.1 访问');
      err.code = 'NO_MEDIA_DEVICES';
      throw err;
    }
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
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const err = new Error('需要安全上下文才能访问摄像头:请用 https:// 或 http://localhost/127.0.0.1 访问');
      err.code = 'NO_MEDIA_DEVICES';
      throw err;
    }
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