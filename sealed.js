// sealed.js — state for a CONCURRENT multi-throne event (Sealed Arena + the scheduled Trial). Unlike arena.js
// (one game in one channel), this holds N per-throne games running at the same time, one per tribe, keyed by
// tribe, plus a channel->tribe lookup so an answer posted in a throne is routed to the right game. Persisted so
// it survives a restart: the Sealed Arena resolves-on-boot (short), the Trial RESUMES (long VC event).
//
// Shape of active:
//   { mode: 'sealed'|'trial', gameType, startedAt, endsAt, phase, seed,
//     thrones: { <tribeKey>: { channelId, promptMessageId, promptTs, qNum, done,
//                              score, correct,               // sealed: running score/correct count
//                              contributors: {uid:count}, answered: [ids] } } }
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_SEALED_FILE || statePath('sealed.json');

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } return _cache; }
function save(s) { _cache = s; try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[sealed] save:', e.message); } }

function get() { return load().active || null; }
function isActive() { return !!get(); }
function set(a) { const s = load(); s.active = a; save(s); }
function clear() { const s = load(); delete s.active; save(s); }
function update(patch) { const a = get(); if (!a) return null; set({ ...a, ...patch }); return get(); }

// ---- per-throne sub-state ----
function throne(tribeKey) { const a = get(); return a && a.thrones ? (a.thrones[tribeKey] || null) : null; }
function throneByChannel(channelId) {
  const a = get(); if (!a || !a.thrones) return null;
  for (const k of Object.keys(a.thrones)) if (a.thrones[k].channelId === channelId) return { tribeKey: k, ...a.thrones[k] };
  return null;
}
function updateThrone(tribeKey, patch) {
  const a = get(); if (!a || !a.thrones || !a.thrones[tribeKey]) return null;
  a.thrones[tribeKey] = { ...a.thrones[tribeKey], ...patch }; set(a); return a.thrones[tribeKey];
}
// Record a scoring answer for a throne: +correct, +score, and credit the contributor (for breadth in the Trial).
function scoreThrone(tribeKey, uid, addScore) {
  const a = get(); if (!a || !a.thrones || !a.thrones[tribeKey]) return null;
  const t = a.thrones[tribeKey];
  t.correct = (t.correct || 0) + 1;
  t.score = (t.score || 0) + (addScore || 0);
  if (uid) { t.contributors = t.contributors || {}; t.contributors[uid] = (t.contributors[uid] || 0) + 1; }
  set(a); return t;
}
function allThronesDone() { const a = get(); if (!a || !a.thrones) return true; return Object.values(a.thrones).every(t => t.done); }
function thronesArr() { const a = get(); return a && a.thrones ? Object.entries(a.thrones).map(([tribeKey, t]) => ({ tribeKey, ...t })) : []; }

// ---- daily cap + last-run tracking (root of the file, independent of the active event) ----
function dayKey(nowMs) { const d = new Date(nowMs); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; }
function dailyCount(nowMs) { const s = load(); return s.dayKey === dayKey(nowMs || Date.now()) ? (s.count || 0) : 0; }
function bumpDaily(nowMs) { const s = load(); const k = dayKey(nowMs || Date.now()); if (s.dayKey !== k) { s.dayKey = k; s.count = 0; } s.count = (s.count || 0) + 1; s.lastRunAt = nowMs || Date.now(); save(s); }
function lastRunAt() { return load().lastRunAt || 0; }
// scheduled-Trial once-a-day marker (separate from the sealed cap)
function trialDoneToday(nowMs) { const s = load(); return s.lastTrialDay === dayKey(nowMs || Date.now()); }
function markTrialDay(nowMs) { const s = load(); s.lastTrialDay = dayKey(nowMs || Date.now()); save(s); }

module.exports = { FILE, load, save, get, isActive, set, clear, update, throne, throneByChannel, updateThrone, scoreThrone, allThronesDone, thronesArr, dailyCount, bumpDaily, lastRunAt, trialDoneToday, markTrialDay };
