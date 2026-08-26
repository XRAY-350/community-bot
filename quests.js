// quests.js — weekly tribe objectives (Phase 7, Depth). NO fourth currency: a completed quest pays the tribe's
// Treasury/Glory, nothing more. Progress is DERIVED from the Lore Log (arena wins, war wins, musters, crowns),
// so there are no separate counters to drift out of sync; this module only holds the week's active quest set and
// which tribe has already CLAIMED which reward. Deterministic weekly rotation (no Math.random — reproducible on
// restart). Registry fail-off via the 'tribeQuests' flag, checked in index.js.
const fs = require('fs');
const { statePath, atomicWriteJson } = require('./statepath');
const FILE = process.env.FUBU_QUESTS_FILE || statePath('quests.json');

// Each quest measures ONE lore-derived stat across the week. Same set for every tribe (a fair race: who gets
// there first, or at all). reward pays the tribe once, on first completion.
//   stat ∈ arena_wins | war_wins | musters | crown  (all read straight from lore event types)
const CATALOG = [
  { id: 'arena3',  stat: 'arena_wins', target: 3, desc: 'Win 3 Arena contests',  reward: { treasury: 300, glory: 40 } },
  { id: 'muster3', stat: 'musters',    target: 3, desc: 'Answer 3 musters',       reward: { treasury: 250, glory: 30 } },
  { id: 'war1',    stat: 'war_wins',   target: 1, desc: 'Win a war',              reward: { treasury: 400, glory: 60 } },
  { id: 'arena5',  stat: 'arena_wins', target: 5, desc: 'Win 5 Arena contests',  reward: { treasury: 550, glory: 70 } },
  { id: 'crown1',  stat: 'crown',      target: 1, desc: 'Claim the weekly Crown', reward: { treasury: 500, glory: 0 } },
  { id: 'arena8',  stat: 'arena_wins', target: 8, desc: 'Win 8 Arena contests',  reward: { treasury: 900, glory: 120 } },
  { id: 'war2',    stat: 'war_wins',   target: 2, desc: 'Win 2 wars',            reward: { treasury: 750, glory: 100 } },
];
const PER_WEEK = 3;   // how many quests are live each week

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } if (!_cache.claimed) _cache.claimed = {}; return _cache; }
function save() { try { atomicWriteJson(FILE, load()); } catch (e) { console.error('[quests] SAVE FAILED - changes lost on restart:', e.message); } }

// Deterministic rotation: index the week, take PER_WEEK consecutive quests wrapping the catalog. Every tribe on
// the server sees the same three quests that week, and the set advances each week.
function weekIndexOf(weekStartMs) { return Math.floor(weekStartMs / (7 * 86400000)); }
function activeQuests(weekStartMs) {
  const idx = weekIndexOf(weekStartMs);
  const out = [];
  for (let i = 0; i < PER_WEEK; i++) out.push(CATALOG[(idx + i) % CATALOG.length]);
  return out;
}
// On a new week, wipe last week's claims so the fresh set can be earned again.
function ensureWeek(weekStartMs) { const s = load(); if (s.week !== weekStartMs) { s.week = weekStartMs; s.claimed = {}; save(); } return s; }
function isClaimed(tribeKey, questId) { const s = load(); return !!(s.claimed[tribeKey] && s.claimed[tribeKey][questId]); }
function markClaimed(tribeKey, questId) { const s = load(); (s.claimed[tribeKey] = s.claimed[tribeKey] || {})[questId] = true; save(); }

module.exports = { CATALOG, PER_WEEK, activeQuests, ensureWeek, isClaimed, markClaimed, weekIndexOf, FILE };
