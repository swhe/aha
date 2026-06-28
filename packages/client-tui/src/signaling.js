'use strict';

const WebSocket = require('ws');
const { MSG } = require('./protocol');

class Signaling {
  constructor({ url, clientId, onMessage, onClose }) {
    this.url = url;
    this.clientId = clientId;
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.heartbeatTimer = null;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.handlers = {};
  }

  connect(payload) {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.send(MSG.REGISTER, payload);
        this._startHeartbeat();
        resolve();
      });
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        if (msg.type === MSG.ERROR) {
          console.error('[aha] server error:', msg.payload && msg.payload.message);
        }
        this.onMessage(msg);
      });
      this.ws.on('close', () => {
        this._stopHeartbeat();
        this.onClose();
        if (this.shouldReconnect) this._scheduleReconnect(payload);
      });
      this.ws.on('error', (e) => {
        // ignore; onclose follows
      });
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

  close() {
    this.shouldReconnect = false;
    this._stopHeartbeat();
    try { this.ws && this.ws.close(); } catch (_) {}
  }

  isOpen() {
    return this.ws && this.ws.readyState === 1;
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

module.exports = Signaling;