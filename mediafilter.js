// mediafilter.js — auto-delete SPECIFIC GIFs/attachments (owner, 2026-08-17: "i only want to be blocking
// specific gifs or attachements", not every one — a blanket on/off toggle was built first per an earlier,
// broader ask, then explicitly removed once the actual want was clear). Block one exact GIF link, or one
// exact file's content by hash (so a rename/re-upload doesn't dodge it).
// State lives in the shared state store: meta keys 'blockedGifs' / 'blockedHashes', each an array of
// { key|hash, byId, at, expiresAt, count, name? }.
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

async function hashUrl(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return require('crypto').createHash('sha256').update(buf).digest('hex');
}
function addHash(state, hash, durationMs, byId, name) {
  const list = blockedHashes(state);
  const now = Date.now();
  const expiresAt = durationMs ? now + durationMs : null;
  const existing = list.find(e => e.hash === hash);
  if (existing) { existing.expiresAt = expiresAt; existing.byId = byId; existing.at = now; if (name) existing.name = name; state.setMeta('blockedHashes', list); return { ok: true, updated: true, entry: existing }; }
  const entry = { hash, byId, at: now, expiresAt, count: 0, name: name || null };
  list.push(entry); state.setMeta('blockedHashes', list);
  return { ok: true, entry };
}
function removeHash(state, hash) {
  const list = blockedHashes(state);
  const idx = list.findIndex(e => e.hash === hash);
  if (idx === -1) return { ok: false, error: 'no active block for that hash.' };
  const [removed] = list.splice(idx, 1); state.setMeta('blockedHashes', list);
  return { ok: true, removed };
}

// GIF-hosting link inside `content`, or null. Needs the ACTUAL url substring (not just a true/false test)
// so a right-click ("Block this GIF") can hand it straight to addGif.
const URL_RE = /https?:\/\/\S+/gi;
function findGifLink(content) {
  const urls = String(content || '').match(URL_RE) || [];
  return urls.find(u => GIF_RE.test(u)) || null;
}

// Async — checks a message against both blocklists (the hash check downloads + hashes each attachment,
// so it only does that work when blockedHashes actually has entries). Which list (if any) this message
// trips: {type:'gif', key} | {type:'attachment', hash} | null. Bumps that entry's count.
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
      let h; try { h = await hashUrl(att.url); } catch { continue; }
      const hit = hashes.find(e => e.hash === h);
      if (hit) { hit.count = (hit.count || 0) + 1; state.setMeta('blockedHashes', hashes); return { type: 'attachment', hash: h }; }
    }
  }
  return null;
}

module.exports = { isGifAttachment, blockedGifs, blockedHashes, addGif, removeGif, hashUrl, addHash, removeHash, findGifLink, checkSpecific };
