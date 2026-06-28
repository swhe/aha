'use strict';

const { CALL_STATUS } = require('./types');

class CallRecords {
  constructor() {
    this.records = new Map();
  }

  create({ callId, callerId, calleeId, callerName, calleeName, callType, customName }) {
    const shortId = (callerId || 'unknown').slice(0, 8);
    const ts = Date.now().toString(36);
    const name = customName || `${shortId}-${ts}`;
    const record = {
      callId,
      callerId,
      calleeId,
      callerName: callerName || shortId,
      calleeName: calleeName || (calleeId ? calleeId.slice(0, 8) : ''),
      callType,
      status: CALL_STATUS.RINGING,
      startTime: new Date().toISOString(),
      connectedTime: null,
      endTime: null,
      duration: null,
      name,
      relayMode: false,
    };
    this.records.set(callId, record);
    return record;
  }

  update(callId, patch) {
    const r = this.records.get(callId);
    if (!r) return null;
    Object.assign(r, patch);
    if (patch.status === CALL_STATUS.CONNECTED && !r.connectedTime) {
      r.connectedTime = new Date().toISOString();
    }
    if ([CALL_STATUS.ENDED, CALL_STATUS.REJECTED, CALL_STATUS.MISSED].includes(patch.status)) {
      r.endTime = new Date().toISOString();
      const baseTime = r.connectedTime || r.startTime;
      r.duration = Math.max(0, Math.floor((Date.parse(r.endTime) - Date.parse(baseTime)) / 1000));
    }
    return r;
  }

  get(callId) {
    return this.records.get(callId);
  }

  list({ clientId, limit = 100 } = {}) {
    let arr = Array.from(this.records.values());
    if (clientId) {
      arr = arr.filter((r) => r.callerId === clientId || r.calleeId === clientId);
    }
    arr.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
    return arr.slice(0, limit);
  }

  cleanupForClient(clientId) {
    for (const [callId, r] of this.records) {
      if ((r.callerId === clientId || r.calleeId === clientId) &&
          (r.status === CALL_STATUS.RINGING || r.status === CALL_STATUS.CONNECTED)) {
        this.update(callId, { status: CALL_STATUS.ENDED });
      }
    }
  }

  setRelayMode(callId, enabled) {
    const r = this.records.get(callId);
    if (r) r.relayMode = enabled;
  }
}

module.exports = CallRecords;