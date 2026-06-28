'use strict';

const { MSG, CALL_STATUS } = require('./types');

class SignalingRouter {
  constructor({ registry, callRecords, relay }) {
    this.registry = registry;
    this.callRecords = callRecords;
    this.relay = relay;
    this._callMeta = new Map();
  }

  handle(ws, msg, rawText) {
    if (!msg || typeof msg !== 'object' || !msg.type) {
      this._sendToWs(ws, MSG.ERROR, { message: 'invalid message' });
      return;
    }

    const session = ws._ahaSession || (ws._ahaSession = { clientId: null });

    switch (msg.type) {
      case MSG.REGISTER:
        this._onRegister(ws, session, msg.payload || {});
        break;
      case MSG.HEARTBEAT:
        this._onHeartbeat(session);
        break;
      case MSG.CALL_OFFER:
        this._onCallOffer(session, msg.payload || {}, msg);
        break;
      case MSG.CALL_ANSWER:
        this._onCallAnswer(session, msg.payload || {}, msg);
        break;
      case MSG.CALL_ICE:
        this._onCallIce(session, msg.payload || {}, msg);
        break;
      case MSG.CALL_REJECT:
        this._onCallReject(session, msg.payload || {}, msg);
        break;
      case MSG.CALL_HANGUP:
        this._onCallHangup(session, msg.payload || {}, msg);
        break;
      case MSG.CALL_STATUS:
        this._onCallStatus(session, msg.payload || {});
        break;
      case MSG.CALL_RECORDS_REQUEST:
        this._onCallRecordsRequest(session, msg.payload || {});
        break;
      case MSG.RELAY_START:
        this._onRelayStart(session, msg.payload || {});
        break;
      case MSG.RELAY_AUDIO:
        this._onRelayAudio(session, msg.payload || {});
        break;
      case MSG.RELAY_STOP:
        this._onRelayStop(session, msg.payload || {});
        break;
      case MSG.CONTROL:
        this._onControl(session, msg.payload || {});
        break;
      default:
        this._sendToWs(ws, MSG.ERROR, { message: `unknown type: ${msg.type}` });
    }
  }

  _onRegister(ws, session, payload) {
    if (!payload.clientId) {
      this._sendToWs(ws, MSG.ERROR, { message: 'clientId required' });
      return;
    }
    const info = this.registry.register(ws, payload);
    session.clientId = payload.clientId;
    this._sendToWs(ws, MSG.REGISTER_ACK, {
      self: info,
      peers: this.registry.listPublic().filter((p) => p.clientId !== info.clientId),
    });
    this._broadcastPeerList();
  }

  _onHeartbeat(session) {
    if (session.clientId) this.registry.heartbeat(session.clientId);
  }

  _onCallOffer(session, payload, raw) {
    const callerId = session.clientId;
    const { calleeId, callId, callType, sdp, callerName, callName } = payload;
    if (!callerId || !calleeId || !callId || !callType) {
      this._sendErr(session, 'call-offer missing fields');
      return;
    }
    const callee = this.registry.get(calleeId);
    if (!callee) {
      this._sendErr(session, `callee ${calleeId} not online`);
      return;
    }
    const caller = this.registry.get(callerId);
    this.callRecords.create({
      callId,
      callerId,
      calleeId,
      callerName: callerName || (caller ? caller.name : callerId.slice(0, 8)),
      calleeName: callee.name,
      callType,
      customName: callName,
    });
    this._callMeta.set(callId, { callerId, calleeId });
    this.registry.setStatus(callerId, 'in-call');
    this._sendTo(calleeId, MSG.CALL_INCOMING, {
      callId,
      callType,
      callerId,
      callerName: caller ? caller.name : callerId.slice(0, 8),
      sdp,
      autoAnswer: callee.autoAnswer,
    });
  }

  _onCallAnswer(session, payload, raw) {
    const calleeId = session.clientId;
    const { callId, sdp } = payload;
    const meta = this._callMeta.get(callId);
    if (!meta) return;
    const callerId = meta.callerId;
    this.callRecords.update(callId, { status: CALL_STATUS.CONNECTED });
    this._sendTo(callerId, MSG.CALL_ANSWERED, { callId, calleeId, sdp });
    this._broadcastStatus(callId, CALL_STATUS.CONNECTED);
  }

  _onCallIce(session, payload, raw) {
    const { callId, candidate, sdpMid, sdpMLineIndex } = payload;
    const meta = this._callMeta.get(callId);
    if (!meta) return;
    const fromId = session.clientId;
    const targetId = fromId === meta.callerId ? meta.calleeId : meta.callerId;
    this._sendTo(targetId, MSG.CALL_ICE, {
      callId,
      candidate,
      sdpMid,
      sdpMLineIndex,
      from: fromId,
    });
  }

  _onCallReject(session, payload, raw) {
    const { callId, reason } = payload;
    const meta = this._callMeta.get(callId);
    if (!meta) return;
    this.callRecords.update(callId, { status: CALL_STATUS.REJECTED });
    const otherId = session.clientId === meta.callerId ? meta.calleeId : meta.callerId;
    this._sendTo(otherId, MSG.CALL_REJECT, { callId, reason, from: session.clientId });
    this._broadcastStatus(callId, CALL_STATUS.REJECTED, reason);
    this.registry.setStatus(meta.callerId, 'online');
    this.registry.setStatus(meta.calleeId, 'online');
    this.relay.stop(callId);
    this._callMeta.delete(callId);
  }

  _onCallHangup(session, payload, raw) {
    const { callId, reason } = payload;
    const meta = this._callMeta.get(callId);
    if (!meta) return;
    this.callRecords.update(callId, { status: CALL_STATUS.ENDED });
    const otherId = session.clientId === meta.callerId ? meta.calleeId : meta.callerId;
    this._sendTo(otherId, MSG.CALL_HANGUP, { callId, reason: reason || 'hangup', from: session.clientId });
    this._broadcastStatus(callId, CALL_STATUS.ENDED, reason);
    this.registry.setStatus(meta.callerId, 'online');
    this.registry.setStatus(meta.calleeId, 'online');
    this.relay.stop(callId);
    this._callMeta.delete(callId);
  }

  _onCallStatus(session, payload) {
    const { callId, status } = payload;
    if (!callId || !status) return;
    const meta = this._callMeta.get(callId);
    if (!meta) return;
    this.callRecords.update(callId, { status });
    this._broadcastStatus(callId, status);
    if ([CALL_STATUS.ENDED, CALL_STATUS.REJECTED, CALL_STATUS.MISSED].includes(status)) {
      this.registry.setStatus(meta.callerId, 'online');
      this.registry.setStatus(meta.calleeId, 'online');
      this.relay.stop(callId);
      this._callMeta.delete(callId);
    }
  }

  _onCallRecordsRequest(session, payload) {
    if (!session.clientId) return;
    const records = this.callRecords.list({ clientId: session.clientId });
    this._sendTo(session.clientId, MSG.CALL_RECORDS, { records });
  }

  _onRelayStart(session, payload) {
    const { callId, mediaType } = payload;
    const meta = this._callMeta.get(callId);
    if (!meta) return this._sendErr(session, 'relay: unknown callId');
    const requesterId = session.clientId;
    const peerId = requesterId === meta.callerId ? meta.calleeId : meta.callerId;
    const ok = this.relay.start({ callId, requesterId, peerId, mediaType });
    if (ok) this.callRecords.setRelayMode(callId, true);
  }

  _onRelayAudio(session, payload) {
    if (!session.clientId) return;
    this.relay.forward(payload.callId, session.clientId, payload);
  }

  _onRelayStop(session, payload) {
    if (payload.callId) this.relay.stop(payload.callId);
  }

  _onControl(session, payload) {
    const { callId, action, params } = payload;
    if (!callId || !action) return;
    const meta = this._callMeta.get(callId);
    if (!meta) return;
    const otherId = session.clientId === meta.callerId ? meta.calleeId : meta.callerId;
    this._sendTo(otherId, MSG.CONTROL, { callId, action, params, from: session.clientId });
  }

  onPeerGone(clientId) {
    for (const [callId, meta] of this._callMeta) {
      if (meta.callerId === clientId || meta.calleeId === clientId) {
        const otherId = meta.callerId === clientId ? meta.calleeId : meta.callerId;
        this.callRecords.update(callId, { status: CALL_STATUS.ENDED });
        this._sendTo(otherId, MSG.CALL_HANGUP, { callId, reason: 'peer-disconnected' });
        this.relay.stop(callId);
        this._callMeta.delete(callId);
      }
    }
  }

  _broadcastPeerList() {
    const peers = this.registry.listPublic();
    for (const peer of this.registry.peers.values()) {
      this._sendTo(peer.clientId, MSG.PEER_LIST, {
        peers: peers.filter((p) => p.clientId !== peer.clientId),
      });
    }
  }

  _broadcastStatus(callId, status, extra) {
    const meta = this._callMeta.get(callId);
    if (!meta) return;
    const payload = { callId, status, ...(extra ? { reason: extra } : {}) };
    this._sendTo(meta.callerId, MSG.CALL_STATUS_UPDATE, payload);
    this._sendTo(meta.calleeId, MSG.CALL_STATUS_UPDATE, payload);
  }

  _sendTo(clientId, type, payload) {
    const peer = this.registry.get(clientId);
    if (!peer || peer.ws.readyState !== 1) return;
    try {
      peer.ws.send(JSON.stringify({ type, payload }));
    } catch (_) {}
  }

  _sendToWs(ws, type, payload) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({ type, payload }));
    } catch (_) {}
  }

  _sendErr(session, message) {
    if (!session.clientId) return;
    this._sendTo(session.clientId, MSG.ERROR, { message });
  }
}

module.exports = SignalingRouter;