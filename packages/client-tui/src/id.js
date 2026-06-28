'use strict';

const os = require('os');
const crypto = require('crypto');

function firstMac() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (name === 'lo' || name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth')) continue;
    const list = ifaces[name] || [];
    for (const a of list) {
      if (a.mac && a.mac !== '00:00:00:00:00:00' && !a.internal) return a.mac;
    }
  }
  return '00:00:00:00:00:00';
}

function generateClientId() {
  const mac = firstMac();
  const macHash = crypto.createHash('sha256').update(mac).digest('hex').slice(0, 8);
  const random = crypto.randomBytes(4).toString('hex');
  return `${macHash}-${random}`;
}

function shortId(id) {
  return (id || 'unknown').slice(0, 8);
}

module.exports = { generateClientId, shortId };