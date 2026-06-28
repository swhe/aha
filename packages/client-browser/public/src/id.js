// 客户端唯一ID:浏览器特征(pseudoMac) + 随机后缀
function pseudoMac() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const seed = [
    (nav.userAgent || '').length,
    (nav.language || 'xx').charCodeAt(0),
    (typeof screen !== 'undefined' ? screen.width : 0) || 0,
    (typeof screen !== 'undefined' ? screen.height : 0) || 0,
    new Date().getTimezoneOffset(),
    nav.hardwareConcurrency || 1,
  ];
  let h = 0;
  for (const v of seed) h = ((h << 5) - h + v) | 0;
  const base = (h >>> 0).toString(16).padStart(8, '0');
  const m = base.match(/.{2}/g) || [];
  while (m.length < 6) m.push('00');
  return m.slice(0, 6).join(':');
}

function getCrypto() {
  if (typeof crypto !== 'undefined') return crypto;
  if (typeof window !== 'undefined' && window.crypto) return window.crypto;
  return null;
}

function fillRandom(bytes) {
  const c = getCrypto();
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
}

function randHex(n) {
  const bytes = new Uint8Array(n);
  fillRandom(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// FNV-1a 32-bit hash → 8 hex chars. Stable per (input, browser session).
function fnv1aHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function sha256(s) {
  const c = getCrypto();
  if (c && c.subtle && typeof c.subtle.digest === 'function') {
    const data = new TextEncoder().encode(s);
    const buf = await c.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure context (e.g. http://192.168.x.x): crypto.subtle is undefined.
  // Use a stable non-crypto hash so client IDs are still deterministic per session.
  return fnv1aHex(s).repeat(8);
}

export function generateClientId() {
  return `${fnv1aHex(pseudoMac())}-${randHex(4)}`;
}

export async function generateClientIdAsync() {
  const mh = await sha256(pseudoMac());
  return `${mh.slice(0, 8)}-${randHex(4)}`;
}