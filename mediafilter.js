// mediafilter.js — auto-delete filters for GIFs/attachments, two independent mechanisms:
//   1) BLANKET toggles (owner, 2026-08-17: "i already use word filter to ban embeds by link but it would
//      be nice if I could do that natively") — same on/off + optional-duration shape as wordfilter.js.
//      'gifs' catches ANY GIF link/file, 'attachments' catches ANY uploaded file.
//   2) SPECIFIC blocklists (owner, 2026-08-17: "i only want to be blocking specific gifs or attachments",
//      not every one) — block one exact GIF link, or one exact file's content (by hash, so a rename/
//      re-upload doesn't dodge it). Independent of the blanket toggles; both can be active at once.
// State lives in the shared state store: meta key 'mediaFilters' = { gifs?: entry, attachments?: entry }
// for the blanket toggles (entry = { byId, at, expiresAt, count }); meta keys 'blockedGifs' / 'blockedHashes'
// are arrays of { key|hash, byId, at, expiresAt, count, name? } for the specific blocklists.
const KEY = 'mediaFilters';
const GIF_RE = /(tenor\.com|giphy\.com|klipy\.com|\.gif(\?|$))/i;

function all(state) { return state.getMeta(KEY) || {}; }
function saveMap(state, map) { state.setMeta(KEY, map); }

// Active (non-expired) entry for a type, or null. Self-cleans an expired entry as a side effect.
function active(state, type) {
  const map = all(state);
  const f = map[type];
  if (!f) return null;
  if (f.expiresAt && f.expiresAt <= Date.now()) { delete map[type]; saveMap(state, map); return null; }
  return f;
}
function activeAll(state) { return ['gifs', 'attachments'].map(t => ({ type: t, filter: active(state, t) })).filter(x => x.filter); }

// Arm (or re-arm) a filter. durationMs null = indefinite. Returns {ok, filter, updated}.
function set(state, type, durationMs, byId) {
  const map = all(state);
  const now = Date.now();
  const updated = !!map[type];
  map[type] = { byId, at: now, expiresAt: durationMs ? now + durationMs : null, count: (map[type]?.count) || 0 };
  saveMap(state, map);
  return { ok: true, updated, filter: map[type] };
}
// Stop a filter early. Returns {ok, removed}.
function clear(state, type) {
  const map = all(state);
  if (!map[type]) return { ok: false, error: `no active ${type} filter.` };
  const removed = map[type];
  delete map[type];
  saveMap(state, map);
  return { ok: true, removed };
}
function bump(state, type) { const map = all(state); if (map[type]) { map[type].count = (map[type].count || 0) + 1; saveMap(state, map); } }

const isGifAttachment = att => (att.contentType || '').startsWith('image/gif') || /\.gif$/i.test(att.name || '');

// Which active filter (if any) this message trips: 'gifs' | 'attachments' | null. Bumps that filter's count.
function check(state, msg) {
  const attF = active(state, 'attachments');
  const gifsF = active(state, 'gifs');
  if (!attF && !gifsF) return null;
  const hasAttachment = msg.attachments && msg.attachments.size > 0;
  if (attF && hasAttachment) { bump(state, 'attachments'); return 'attachments'; }
  if (gifsF) {
    const byContent = GIF_RE.test(msg.content || '');
    const byAttachment = hasAttachment && [...msg.attachments.values()].some(isGifAttachment);
    if (byContent || byAttachment) { bump(state, 'gifs'); return 'gifs'; }
  }
  return null;
}

// ---- specific-GIF / specific-attachment blocklists -------------------------------------------------
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

// GIF-hosting link inside `content`, or null. Broader than GIF_RE's plain test — needs the ACTUAL url
// substring so a right-click ("Block this GIF") can hand it straight to addGif.
const URL_RE = /https?:\/\/\S+/gi;
function findGifLink(content) {
  const urls = String(content || '').match(URL_RE) || [];
  return urls.find(u => GIF_RE.test(u)) || null;
}

// Async — checks a message's attachments against the specific-hash blocklist (downloads + hashes each
// one, so only called when blockedHashes actually has entries). Which specific list (if any) this message
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

module.exports = { active, activeAll, set, clear, check, isGifAttachment,
  blockedGifs, blockedHashes, addGif, removeGif, hashUrl, addHash, removeHash, findGifLink, checkSpecific };
