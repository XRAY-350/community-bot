// recruitment.js — grow the server: reward members for bringing people in, and tribes for growth milestones
// (Phase 6). Pure state/logic; index.js does the awarding + Discord I/O, GATED behind the `recruitment`
// feature flag, so this is fully inert until an owner tunes the numbers and flips it on. Tunables up top.
const fs = require('fs');
const FILE = process.env.FUBU_RECRUITMENT_FILE || '/home/ubuntu/.fubu_recruitment.json';

const RECRUITER_TIDES = 25;      // personal Tides to the recruiter when their invitee STICKS (see below)
const RECRUITER_TREASURY = 50;   // treasury to the recruiter's tribe
const STICK_DAYS = 7;            // the invitee must stay in the tribe this long before the reward pays out
const STICK_MS = STICK_DAYS * 86400000;   // (stops reward-farming with alts that instantly leave)
const GROWTH_MILESTONES = [       // one-time treasury bonus when a tribe crosses each member count
  { members: 10, treasury: 200 },
  { members: 25, treasury: 500 },
  { members: 50, treasury: 1000 },
];

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } if (!_cache.recruits) _cache.recruits = {}; if (!_cache.growth) _cache.growth = {}; if (!_cache.pending) _cache.pending = {}; return _cache; }
function save() { try { fs.writeFileSync(FILE, JSON.stringify(load())); } catch (e) { console.error('[recruitment] save:', e.message); } }

// A recruit joins as PENDING (keyed by invitee). It only pays out once they've stuck for STICK_DAYS (checked
// by the sweep). Won't re-pend an invitee who's already pending or already been credited.
function addPending(recruiterId, inviteeId, tribeKey, nowMs) { const s = load(); if (s.recruits[inviteeId] || s.pending[inviteeId]) return false; s.pending[inviteeId] = { recruiterId, tribeKey, joinedAt: nowMs || Date.now() }; save(); return true; }
function duePending(nowMs) { const s = load(); const now = nowMs || Date.now(); return Object.entries(s.pending).filter(([, p]) => now - p.joinedAt >= STICK_MS).map(([inviteeId, p]) => ({ inviteeId, ...p })); }
function resolvePending(inviteeId) { const s = load(); delete s.pending[inviteeId]; save(); }
// Record a completed recruit (keyed by invitee, once ever). Returns true if newly credited.
function creditRecruit(recruiterId, inviteeId) { const s = load(); if (s.recruits[inviteeId]) return false; s.recruits[inviteeId] = recruiterId; save(); return true; }
function recruitCount(recruiterId) { return Object.values(load().recruits).filter(r => r === recruiterId).length; }
// Award the next not-yet-awarded growth milestone for a tribe at `count` members; returns it, or null.
function checkGrowth(tribeKey, count) {
  const s = load(); const done = s.growth[tribeKey] || [];
  for (const m of GROWTH_MILESTONES) if (count >= m.members && !done.includes(m.members)) { done.push(m.members); s.growth[tribeKey] = done; save(); return m; }
  return null;
}

module.exports = { RECRUITER_TIDES, RECRUITER_TREASURY, STICK_DAYS, STICK_MS, GROWTH_MILESTONES, addPending, duePending, resolvePending, creditRecruit, recruitCount, checkGrowth, FILE };
