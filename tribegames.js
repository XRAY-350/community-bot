// tribegames.js — state for Tribe Games: staff-recorded tribe-vs-tribe events using external games the bot
// can't referee (Among Us, Roblox titles, ...). One active event at a time, mirrors sealed.js's shape.
// Each catalog entry declares its own result FORMAT because several of these games have hidden/asymmetric
// roles (Among Us's imposter/crewmate, MM2's murderer/sheriff/hero/innocent) rather than a simple ranked
// or single-winner outcome — the format drives both how /tribe panel's Report Result modal is built and how
// rewards are computed. See index.js's tribe-games block for the actual Discord-facing logic; this module
// only owns state + the catalog.
const fs = require('fs');
const { statePath, atomicWriteJson } = require('./statepath');
const FILE = process.env.FUBU_TRIBEGAMES_FILE || statePath('tribegames.json');

// format: 'versus' (single winner, no hidden roles) | 'roleOutcome2' (2 asymmetric sides) |
// 'roleOutcome3' (MM2's own case: 4 role labels, 3 reward tiers — see index.js's TRIBEGAME_ROLE3_MULT).
// category (combat/social/collective) feeds the winning tribe's attribute-power reward bonus (index.js) —
// picked by each game's actual core skill: classic Among Us + MM2 are deduction/deception (social), Flee the
// Facility + Hide & Seek are group evasion (collective), ABA is direct 1v1 combat, 'other' defaults combat.
const GAME_CATALOG = {
  amongus_classic: { label: 'Among Us — Classic (killing)', format: 'roleOutcome2', roles: ['imposter', 'crewmate'], category: 'social' },
  amongus_hs:      { label: 'Among Us — Hide & Seek',       format: 'roleOutcome2', roles: ['imposter', 'crewmate'], category: 'collective' },
  ftf:              { label: 'Flee the Facility',           format: 'roleOutcome2', roles: ['beast', 'guard'], category: 'collective' },
  mm2:              { label: 'Murder Mystery 2',            format: 'roleOutcome3', roles: ['murderer', 'sheriff', 'hero', 'innocent'], category: 'social' },
  aba:              { label: 'Anime Battle Arena',          format: 'versus', category: 'combat' },
  other:            { label: 'Other',                       format: 'versus', category: 'combat' },
  // minecraft: intentionally not added yet — pending MCFleet coordination (see PROGRESS_LOG/agentmsg thread
  // 'tribe-games-minecraft'). Add it here once scoped; nothing else needs to change to support a new entry.
};

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } return _cache; }
function save(s) { try { atomicWriteJson(FILE, s); _cache = s; } catch (e) { _cache = s; console.error('[tribegames] SAVE FAILED - state is IN MEMORY ONLY and will be lost on restart:', e.message); } }

function get() { return load().active || null; }
function isActive() { return !!get(); }
function set(ev) { const s = load(); s.active = ev; save(s); }
function clear() { const s = load(); delete s.active; save(s); }
function update(patch) { const a = get(); if (!a) return null; const n = { ...a, ...patch }; set(n); return n; }

// Auto-start pacing (owner, 2026-08-17: "they just weren't running automatically" — Tribe Games had no
// scheduler at all, unlike Arena/Sealed/Trial). A wider gap than Arena's on purpose: a Tribe Game needs
// tribe leaders to actually set a rep AND staff to manually report the result afterward, so firing it too
// often risks lobbies nobody's around to fill and results nobody follows up on.
const AUTO_GAP_MIN_MIN = 240;      // never sooner than 4h after the last auto-started game
const AUTO_GAP_SPREAD_MIN = 240;   // ...plus a random 0..240 min, so the gap is 4h..8h
function randInt(n) { return Math.floor(Math.random() * n); }
function recordStart(nowMs) { const s = load(); s.nextAutoAt = nowMs + (AUTO_GAP_MIN_MIN + randInt(AUTO_GAP_SPREAD_MIN + 1)) * 60000; save(s); }
function autoStartDue(nowMs) { const s = load(); return !s.nextAutoAt || (nowMs || Date.now()) >= s.nextAutoAt; }

// Per-tribe entrant helpers — active.entrants: { [tribeKey]: { repIds: [userId,...], role: null|string } }
function setEntrant(tribeKey, repIds) {
  const a = get(); if (!a) return null;
  a.entrants = a.entrants || {};
  a.entrants[tribeKey] = { repIds, role: (a.entrants[tribeKey] || {}).role || null };
  set(a); return a.entrants[tribeKey];
}
function setEntrantRole(tribeKey, role) {
  const a = get(); if (!a || !a.entrants || !a.entrants[tribeKey]) return null;
  a.entrants[tribeKey].role = role; set(a); return a.entrants[tribeKey];
}
function entrantTribeKeys() { const a = get(); return a && a.entrants ? Object.keys(a.entrants) : []; }

// Root-level (not part of the transient `active` event) — cached Discord role id for the rotating
// "Tribe Games winner" role, created once on first award and reused thereafter.
function getChampionRoleId() { return load().championRoleId || null; }
function setChampionRoleId(id) { const s = load(); s.championRoleId = id; save(s); }

module.exports = {
  FILE, GAME_CATALOG,
  get, isActive, set, clear, update,
  setEntrant, setEntrantRole, entrantTribeKeys,
  getChampionRoleId, setChampionRoleId,
  recordStart, autoStartDue,
};
