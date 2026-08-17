// mediafilter.js — temporary "auto-delete GIFs / attachments" filters, same on/off + optional-duration
// shape as wordfilter.js (owner, 2026-08-17: "i already use word filter to ban embeds by link but it
// would be nice if I could do that natively"). Two independent toggles, either can be armed on its own:
//   'gifs'        — a GIF link (tenor.com/giphy.com/a bare .gif URL) OR an uploaded .gif file
//   'attachments' — ANY uploaded file, gif or not
// State lives in the shared state store under meta key 'mediaFilters': { gifs?: entry, attachments?: entry },
// entry = { byId, at, expiresAt, count }.
const KEY = 'mediaFilters';
const GIF_RE = /(tenor\.com|giphy\.com|\.gif(\?|$))/i;

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

module.exports = { active, activeAll, set, clear, check };
