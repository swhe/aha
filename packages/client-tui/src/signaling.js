'use strict';

const WebSocket = require('ws');
const { MSG } = require('./protocol');

// Permit self-signed certs only for non-public hosts so users don't have to
// set NODE_TLS_REJECT_UNAUTHORIZED=0 in their shell. Public addresses and
// hostnames still require a trusted cert.
function shouldTrustTls(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'wss:') return true; // ws:// has no TLS
    const h = u.hostname.replace(/^\[|\]$/g, ''); // strip brackets on IPv6
    // Local-loopback and RFC1918 / link-local hosts commonly run self-signed
    // certs in LAN testing; permit them so users don't have to set
    // NODE_TLS_REJECT_UNAUTHORIZED=0 manually.
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    if (h.endsWith('.local')) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // ULA fc00::/7
    // public hostnames/IPs: require a real cert
    return false;
  } catch (_) {
    return false;
  }
}

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
        const opts = { rejectUnauthorized: !shouldTrustTls(this.url) };
        if (process.env.AHA_DEBUG) console.error('[aha-tui] ws connect ' + this.url + ' rejectUnauthorized=' + opts.rejectUnauthorized);
        this.ws = new WebSocket(this.url, undefined, opts);
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