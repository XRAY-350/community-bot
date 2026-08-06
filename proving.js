// proving.js — Proving Grounds: a solo, async, per-member daily gauntlet. Ephemeral, with PER-MEMBER question
// draws so there is no single daily answer to leak. Tracks one attempt per member per day, a daily leaderboard,
// and a weekly Prover total that culminates + resets at the weekly boundary (aligned to the Sunday Crown reset).
// v1 game: the Knowledge Gauntlet (streak survival). Score-Attack + Puzzles rotate in as they are built.
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_PROVING_FILE || statePath('proving.json');

// One game family per day, rotating, so everyone faces the same family that day (comparable leaderboard).
const GAME_ROTATION = ['gauntlet', 'scoreattack', 'puzzle'];
function dayKey(nowMs) { const d = new Date(nowMs || Date.now()); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
function dayIndex(nowMs) { return Math.floor((nowMs || Date.now()) / 86400000); }
function todaysGame(nowMs, builtOnly) { const pool = builtOnly && builtOnly.length ? builtOnly : GAME_ROTATION; return pool[dayIndex(nowMs) % pool.length]; }
// week start (Sunday 00:00 UTC), same boundary as the weekly Crown.
function weekKey(nowMs) { const d = new Date(nowMs || Date.now()); return String(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay())); }

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } if (!_cache.daily) _cache.daily = {}; if (!_cache.weekly) _cache.weekly = {}; if (!_cache.weeklyTribe) _cache.weeklyTribe = {}; return _cache; }
function save() { try { fs.writeFileSync(FILE, JSON.stringify(load())); } catch (e) { console.error('[proving] save:', e.message); } }

// Prune daily records older than a few days so the file cannot grow without bound.
function prune(nowMs) { const s = load(); const keep = new Set([0, 1, 2, 3].map(d => dayKey((nowMs || Date.now()) - d * 86400000))); for (const k of Object.keys(s.daily)) if (!keep.has(k)) delete s.daily[k]; }

function playedToday(uid, nowMs) { const s = load(); const d = s.daily[dayKey(nowMs)]; return !!(d && d[uid]); }
// Claim the day's attempt up front (score 0) so a member cannot abandon a hard run and retry.
function startAttempt(uid, tribeKey, nowMs) {
  const s = load(); const dk = dayKey(nowMs);
  if (!s.daily[dk]) s.daily[dk] = {};
  if (s.daily[dk][uid]) return false;   // already attempted today
  s.daily[dk][uid] = { score: 0, tribeKey: tribeKey || null, at: nowMs || Date.now(), done: false };
  prune(nowMs); save(); return true;
}
// Finalize the day's attempt: set the score, add to the weekly totals once.
function finishAttempt(uid, tribeKey, score, nowMs) {
  const s = load(); const dk = dayKey(nowMs);
  if (!s.daily[dk] || !s.daily[dk][uid] || s.daily[dk][uid].done) return;
  s.daily[dk][uid].score = score; s.daily[dk][uid].done = true;
  if (!s.weekStart) s.weekStart = weekKey(nowMs);
  s.weekly[uid] = (s.weekly[uid] || 0) + score;
  if (tribeKey) s.weeklyTribe[tribeKey] = (s.weeklyTribe[tribeKey] || 0) + score;
  save();
}
function dailyBoard(nowMs, n = 15) { const s = load(); const d = s.daily[dayKey(nowMs)] || {}; return Object.entries(d).filter(([, v]) => v.done).map(([uid, v]) => ({ uid, score: v.score, tribeKey: v.tribeKey })).sort((a, b) => b.score - a.score).slice(0, n); }
function weeklyBoard(n = 15) { const s = load(); return Object.entries(s.weekly).map(([uid, score]) => ({ uid, score })).sort((a, b) => b.score - a.score).slice(0, n); }
function weeklyTribeBoard() { const s = load(); return Object.entries(s.weeklyTribe).map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score); }
// weekly rollover: due when the stored week has rolled past. Returns the just-ended board, then resets.
function weeklyDue(nowMs) { const s = load(); return !!s.weekStart && s.weekStart !== weekKey(nowMs); }
function rolloverWeek(nowMs) { const prev = { provers: weeklyBoard(50), tribes: weeklyTribeBoard() }; const s = load(); s.weekly = {}; s.weeklyTribe = {}; s.weekStart = weekKey(nowMs); save(); return prev; }

module.exports = { FILE, GAME_ROTATION, todaysGame, dayKey, weekKey, playedToday, startAttempt, finishAttempt, dailyBoard, weeklyBoard, weeklyTribeBoard, weeklyDue, rolloverWeek };
