// wordfilter.js — temporary "auto-delete any message containing this word" filters. A staffer arms a
// word/phrase for a duration (or indefinitely); every NEW non-staff message that matches is deleted on
// the spot until the timer runs out. State lives in the shared state store under meta key 'wordFilters':
// an array of { word, byId, at, expiresAt, count }. Matching reuses the watchlist's normalized,
// word-boundary regex (matchTerms) so it dodges the same accent/leet obfuscations.
const watchlist = require('./watchlist');
const KEY = 'wordFilters';

function all(state) { return state.getMeta(KEY) || []; }
function saveList(state, list) { state.setMeta(KEY, list); }

// Active (non-expired) filters. Prunes expired entries as a side effect so the list self-cleans.
function active(state) {
  const now = Date.now();
  const list = all(state);
  const live = list.filter(f => !f.expiresAt || f.expiresAt > now);
  if (live.length !== list.length) saveList(state, live);
  return live;
}

// Arm (or re-arm) a filter. durationMs null = indefinite (until removed). Returns {ok, filter, updated}.
function add(state, word, durationMs, byId) {
  word = String(word || '').trim();
  if (!word) return { ok: false, error: 'give a word or phrase to filter.' };
  const now = Date.now();
  const list = active(state);
  const expiresAt = durationMs ? now + durationMs : null;
  const existing = list.find(f => f.word.toLowerCase() === word.toLowerCase());
  if (existing) { existing.expiresAt = expiresAt; existing.byId = byId; existing.at = now; saveList(state, list); return { ok: true, updated: true, filter: existing }; }
  const filter = { word, byId, at: now, expiresAt, count: 0 };
  list.push(filter); saveList(state, list);
  return { ok: true, filter };
}

// Stop a filter early. Returns {ok, removed}.
function remove(state, word) {
  const list = active(state);
  const idx = list.findIndex(f => f.word.toLowerCase() === String(word || '').trim().toLowerCase());
  if (idx === -1) return { ok: false, error: 'no active filter for that word.' };
  const [removed] = list.splice(idx, 1); saveList(state, list);
  return { ok: true, removed };
}

// The first active filter whose word appears in `content`, or null. Bumps that filter's delete count.
function check(state, content) {
  if (!content) return null;
  const list = active(state);
  if (!list.length) return null;
  const hits = watchlist.matchTerms(content, list.map(f => f.word));
  if (!hits.length) return null;
  const hitLower = new Set(hits.map(h => h.toLowerCase()));
  const f = list.find(x => hitLower.has(x.word.toLowerCase()));
  if (f) { f.count = (f.count || 0) + 1; saveList(state, list); }
  return f || null;
}

module.exports = { all, active, add, remove, check };
