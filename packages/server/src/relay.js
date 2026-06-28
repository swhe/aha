'use strict';

const { MSG } = require('./types');

class Relay {
  constructor({ registry, broadcast } = {}) {
    this.registry = registry;
    this.broadcast = broadcast || (() => {});
    this.sessions = new Map();
  }

  start({ callId, requesterId, peerId, mediaType }) {
    const requester = this.registry.get(requesterId);
    const peer = this.registry.get(peerId);
    if (!requester || !peer) {
      this._send(requester, MSG.ERROR, { message: 'relay: peer unavailable' });
      return false;
    }
    this.sessions.set(callId, { requesterId, peerId, mediaType: mediaType || 'audio' });
    this._send(requester, MSG.RELAY_START_ACK, { callId, mediaType: mediaType || 'audio', role: 'requester' });
    this._send(peer, MSG.RELAY_START_ACK, { callId, mediaType: mediaType || 'audio', role: 'peer' });
    return true;
  }

  forward(callId, fromId, payload) {
    const s = this.sessions.get(callId);
    if (!s) return false;
    const targetId = fromId === s.requesterId ? s.peerId : s.requesterId;
    const target = this.registry.get(targetId);
    if (!target || target.ws.readyState !== 1) return false;
    try {
      target.ws.send(JSON.stringify({
        type: MSG.RELAY_AUDIO,
        from: fromId,
        payload: {
          callId,
          seq: payload.seq,
          data: payload.data,
          ts: payload.ts,
          encoding: payload.encoding || 'opus',
        },
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  stop(callId) {
    this.sessions.delete(callId);
  }

  isActive(callId) {
    return this.sessions.has(callId);
  }

  _send(peer, type, payload) {
    if (!peer || !peer.ws || peer.ws.readyState !== 1) return;
    try {
      peer.ws.send(JSON.stringify({ type, payload }));
    } catch (_) {}
  }
}

module.exports = Relay;