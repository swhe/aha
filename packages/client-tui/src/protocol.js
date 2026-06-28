'use strict';

const MSG = {
  REGISTER: 'register',
  REGISTER_ACK: 'register-ack',
  HEARTBEAT: 'heartbeat',
  PEER_LIST: 'peer-list',
  PEER_LEFT: 'peer-left',
  CALL_OFFER: 'call-offer',
  CALL_INCOMING: 'call-incoming',
  CALL_ANSWER: 'call-answer',
  CALL_ANSWERED: 'call-answered',
  CALL_ICE: 'call-ice',
  CALL_REJECT: 'call-reject',
  CALL_HANGUP: 'call-hangup',
  CALL_STATUS: 'call-status',
  CALL_STATUS_UPDATE: 'call-status-update',
  CALL_RECORDS_REQUEST: 'call-records-request',
  CALL_RECORDS: 'call-records',
  RELAY_START: 'relay-start',
  RELAY_START_ACK: 'relay-start-ack',
  RELAY_AUDIO: 'relay-audio',
  RELAY_STOP: 'relay-stop',
  CONTROL: 'control',
  ERROR: 'error',
};

const CALL_STATUS = {
  RINGING: 'ringing',
  CONNECTED: 'connected',
  ENDED: 'ended',
  REJECTED: 'rejected',
  MISSED: 'missed',
};

function genCallId() {
  return 'c-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

module.exports = { MSG, CALL_STATUS, genCallId };