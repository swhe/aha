// 客户端唯一ID: MAC(浏览器中无法获取,使用浏览器特征) + 随机字符
function pseudoMac() {
  const nav = navigator;
  const parts = [];
  const seed = [
    (nav.userAgent || '').length,
    (nav.language || 'xx').charCodeAt(0),
    screen.width || 0,
    screen.height || 0,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || 1,
  ];
  let h = 0;
  for (const v of seed) h = ((h << 5) - h + v) | 0;
  const base = (h >>> 0).toString(16).padStart(8, '0');
  const m = base.match(/.{2}/g) || [];
  while (m.length < 6) m.push('00');
  return m.slice(0, 6).join(':');
}

function randHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateClientId() {
  const macHash = sha256(pseudoMac()).slice(0, 8);
  const rnd = randHex(4);
  return `${macHash}-${rnd}`;
}

function sha256(s) {
  const data = new TextEncoder().encode(s);
  return crypto.subtle.digest('SHA-256', data).then((buf) => {
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  });
}

export async function generateClientIdAsync() {
  const mh = await sha256(pseudoMac());
  return `${mh.slice(0, 8)}-${randHex(4)}`;
}