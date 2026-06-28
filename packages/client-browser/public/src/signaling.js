import { MSG } from './utils.js';

export class Signaling {
  constructor({ url, clientId, onMessage, onOpen, onClose }) {
    this.url = url;
    this.clientId = clientId;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.ws = null;
    this.heartbeatTimer = null;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
  }

  connect(payload) {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.send(MSG.REGISTER, payload);
        this._startHeartbeat();
        if (this.onOpen) this.onOpen();
        resolve();
      };

      this.ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (this.onMessage) this.onMessage(msg);
      };

      this.ws.onclose = () => {
        this._stopHeartbeat();
        if (this.onClose) this.onClose();
        if (this.shouldReconnect) this._scheduleReconnect(payload);
      };

      this.ws.onerror = (e) => {
        // onclose 随后触发
      };
    });
  }

  send(type, payload) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ type, payload }));
      return true;
    } catch (_) {
      return false;
    }
  }

  sendTo(to, type, payload) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ type, to, payload }));
      return true;
    } catch (_) {
      return false;
    }
  }

  close() {
    this.shouldReconnect = false;
    this._stopHeartbeat();
    try { this.ws && this.ws.close(); } catch (_) {}
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send(MSG.HEARTBEAT, {}), 15_000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _scheduleReconnect(payload) {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 15_000);
    setTimeout(() => {
      if (!this.shouldReconnect) return;
      this.connect(payload).catch(() => {});
    }, delay);
  }
}