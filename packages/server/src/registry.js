'use strict';

const { MSG } = require('./types');

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

class Registry {
  constructor({ onPeerListChanged, onPeerGone, broadcast } = {}) {
    this.peers = new Map();
    this.sweeper = null;
    this.onPeerListChanged = onPeerListChanged || (() => {});
    this.onPeerGone = onPeerGone || (() => {});
    this.broadcast = broadcast || (() => {});
    this.start();
  }

  start() {
    this.sweeper = setInterval(() => this.sweep(), HEARTBEAT_INTERVAL_MS);
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  register(ws, { clientId, deviceType, name, autoAnswer }) {
    if (this.peers.has(clientId)) {
      const prev = this.peers.get(clientId);
      try { prev.ws.close(); } catch (_) {}
    }
    this.peers.set(clientId, {
      ws,
      clientId,
      deviceType: deviceType || 'unknown',
      name: name || clientId.slice(0, 8),
      autoAnswer: !!autoAnswer,
      status: 'online',
      lastHeartbeat: Date.now(),
    });
    this.broadcast(MSG.PEER_LEFT, { clientId: this._staleGhostId(clientId) });
    this.onPeerListChanged();
    return this.publicInfo(clientId);
  }

  heartbeat(clientId) {
    const peer = this.peers.get(clientId);
    if (peer) peer.lastHeartbeat = Date.now();
  }

  remove(clientId) {
    if (!this.peers.has(clientId)) return;
    this.peers.delete(clientId);
    this.onPeerGone(clientId);
    this.onPeerListChanged();
  }

  get(clientId) {
    return this.peers.get(clientId);
  }

  setStatus(clientId, status) {
    const peer = this.peers.get(clientId);
    if (peer) {
      peer.status = status;
      this.onPeerListChanged();
    }
  }

  size() {
    return this.peers.size;
  }

  listPublic() {
    return Array.from(this.peers.values()).map((p) => ({
      clientId: p.clientId,
      deviceType: p.deviceType,
      name: p.name,
      status: p.status,
      autoAnswer: p.autoAnswer,
    }));
  }

  sweep() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        try { peer.ws.close(); } catch (_) {}
        this.peers.delete(id);
        this.onPeerGone(id);
        this.onPeerListChanged();
      }
    }
  }

  publicInfo(clientId) {
    const p = this.peers.get(clientId);
    if (!p) return null;
    return {
      clientId: p.clientId,
      deviceType: p.deviceType,
      name: p.name,
      autoAnswer: p.autoAnswer,
      status: p.status,
    };
  }

  _staleGhostId(_id) {
    return null;
  }
}

module.exports = Registry;