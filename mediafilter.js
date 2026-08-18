// mediafilter.js — auto-delete SPECIFIC GIFs/attachments (owner, 2026-08-17: "i only want to be blocking
// specific gifs or attachements", not every one — a blanket on/off toggle was built first per an earlier,
// broader ask, then explicitly removed once the actual want was clear). Block one exact GIF link, or one
// exact file's content by hash (so a rename/re-upload doesn't dodge it).
// Upgraded 2026-08-18 with Perceptual Image Hashing (dHash) to prevent re-upload bypasses.
const crypto = require('crypto');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const GIF_RE = /(tenor\.com|giphy\.com|klipy\.com|\.gif(\?|$))/i;

function pruneList(state, key) {
  const now = Date.now();
  const list = state.getMeta(key) || [];
  const live = list.filter(e => !e.expiresAt || e.expiresAt > now);
  if (live.length !== list.length) state.setMeta(key, live);
  return live;
}
const blockedGifs = state => pruneList(state, 'blockedGifs');
const blockedHashes = state => pruneList(state, 'blockedHashes');
const normalizeGifUrl = url => String(url || '').trim().toLowerCase();

const isGifAttachment = att => (att.contentType || '').startsWith('image/gif') || /\.gif$/i.test(att.name || '');

function addGif(state, url, durationMs, byId) {
  const key = normalizeGifUrl(url);
  if (!key) return { ok: false, error: 'give a GIF link to block.' };
  const list = blockedGifs(state);
  const now = Date.now();
  const expiresAt = durationMs ? now + durationMs : null;
  const existing = list.find(e => e.key === key);
  if (existing) { existing.expiresAt = expiresAt; existing.byId = byId; existing.at = now; state.setMeta('blockedGifs', list); return { ok: true, updated: true, entry: existing }; }
  const entry = { key, byId, at: now, expiresAt, count: 0 };
  list.push(entry); state.setMeta('blockedGifs', list);
  return { ok: true, entry };
}
function removeGif(state, url) {
  const key = normalizeGifUrl(url);
  const list = blockedGifs(state);
  const idx = list.findIndex(e => e.key === key);
  if (idx === -1) return { ok: false, error: 'no active block for that link.' };
  const [removed] = list.splice(idx, 1); state.setMeta('blockedGifs', list);
  return { ok: true, removed };
}

// --- Perceptual Image Hashing (dHash) ---
function computeDHashFromRawPixels(width, height, data) {
  if (!width || !height || !data || data.length < width * height * 4) return null;
  const grays = new Float32Array(9 * 8);
  for (let y = 0; y < 8; y++) {
    const srcY = Math.floor(((y + 0.5) * height) / 8);
    for (let x = 0; x < 9; x++) {
      const srcX = Math.floor(((x + 0.5) * width) / 9);
      const idx = (srcY * width + srcX) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      grays[y * 9 + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  let hashHex = '';
  for (let y = 0; y < 8; y++) {
    let rowByte = 0;
    for (let x = 0; x < 8; x++) {
      rowByte <<= 1;
      if (grays[y * 9 + x] > grays[y * 9 + x + 1]) {
        rowByte |= 1;
      }
    }
    hashHex += rowByte.toString(16).padStart(2, '0');
  }
  return hashHex;
}

function computeDHash(buffer, nameOrUrl = '') {
  if (!buffer || buffer.length < 8) return null;
  try {
    // Check PNG magic bytes: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const png = PNG.sync.read(buffer);
      return computeDHashFromRawPixels(png.width, png.height, png.data);
    }
    // Check JPEG magic bytes: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      const raw = jpeg.decode(buffer, { useTolerant: true });
      if (raw && raw.data && raw.width && raw.height) {
        return computeDHashFromRawPixels(raw.width, raw.height, raw.data);
      }
    }
    // Fallback attempts
    try {
      const png = PNG.sync.read(buffer);
      return computeDHashFromRawPixels(png.width, png.height, png.data);
    } catch {
      const raw = jpeg.decode(buffer, { useTolerant: true });
      if (raw && raw.data && raw.width && raw.height) {
        return computeDHashFromRawPixels(raw.width, raw.height, raw.data);
      }
    }
  } catch { /* ignored */ }
  return null;
}

function hammingDistance(hex1, hex2) {
  if (!hex1 || !hex2 || hex1.length !== 16 || hex2.length !== 16) return 999;
  let dist = 0;
  for (let i = 0; i < 16; i += 2) {
    const b1 = parseInt(hex1.slice(i, i + 2), 16);
    const b2 = parseInt(hex2.slice(i, i + 2), 16);
    let xor = b1 ^ b2;
    while (xor > 0) {
      if (xor & 1) dist++;
      xor >>= 1;
    }
  }
  return dist;
}

async function hashUrl(url, name = '') {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const dhash = computeDHash(buf, name || url);
  return { hash, dhash };
}

function addHash(state, hash, durationMs, byId, name, dhash = null) {
  const list = blockedHashes(state);
  const now = Date.now();
  const expiresAt = durationMs ? now + durationMs : null;
  // Match exact SHA-256 OR visual dHash within Hamming distance <= 8
  const existing = list.find(e => e.hash === hash || (dhash && e.dhash && hammingDistance(e.dhash, dhash) <= 8));
  if (existing) {
    existing.expiresAt = expiresAt;
    existing.byId = byId;
    existing.at = now;
    if (name) existing.name = name;
    if (dhash && !existing.dhash) existing.dhash = dhash;
    state.setMeta('blockedHashes', list);
    return { ok: true, updated: true, entry: existing };
  }
  const entry = { hash, dhash: dhash || null, byId, at: now, expiresAt, count: 0, name: name || null };
  list.push(entry);
  state.setMeta('blockedHashes', list);
  return { ok: true, entry };
}

function removeHash(state, hash) {
  const list = blockedHashes(state);
  const idx = list.findIndex(e => e.hash === hash || e.dhash === hash);
  if (idx === -1) return { ok: false, error: 'no active block for that hash.' };
  const [removed] = list.splice(idx, 1); state.setMeta('blockedHashes', list);
  return { ok: true, removed };
}

// GIF-hosting link inside `content`, or null.
const URL_RE = /https?:\/\/\S+/gi;
function findGifLink(content) {
  const urls = String(content || '').match(URL_RE) || [];
  return urls.find(u => GIF_RE.test(u)) || null;
}

// Async — checks a message against both blocklists.
// Attachment check uses SHA-256 for exact byte matches AND visual dHash (Hamming distance <= 8) for re-uploads.
async function checkSpecific(state, msg) {
  const gifs = blockedGifs(state);
  if (gifs.length) {
    const content = (msg.content || '').toLowerCase();
    const hit = gifs.find(e => content.includes(e.key));
    if (hit) { hit.count = (hit.count || 0) + 1; state.setMeta('blockedGifs', gifs); return { type: 'gif', key: hit.key }; }
  }
  const hashes = blockedHashes(state);
  if (hashes.length && msg.attachments && msg.attachments.size) {
    for (const att of msg.attachments.values()) {
      let result; try { result = await hashUrl(att.url, att.name); } catch { continue; }
      const { hash, dhash } = result;
      let hit = hashes.find(e => e.hash === hash);
      if (!hit && dhash) {
        hit = hashes.find(e => e.dhash && hammingDistance(e.dhash, dhash) <= 8);
      }
      if (hit) {
        hit.count = (hit.count || 0) + 1;
        if (dhash && !hit.dhash) hit.dhash = dhash;
        state.setMeta('blockedHashes', hashes);
        return { type: 'attachment', hash: hit.hash, dhash };
      }
    }
  }
  return null;
}

module.exports = { isGifAttachment, blockedGifs, blockedHashes, addGif, removeGif, hashUrl, addHash, removeHash, findGifLink, checkSpecific, computeDHash, hammingDistance };
