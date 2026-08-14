// tally.js — live point tally for manually-refereed events (owner: spent an hour hand-counting reactions
// after an event ended). ONE active tally at a time. An Event Organizer or mod reacts with POINT_EMOJI on
// a participant's OWN message (posted in the event's chat channel) to award them a point. Two separate
// things get tracked: a per-tribe tally (feeds that tribe's Treasury, tribe members only) and a per-member
// tally (EVERY participant, tribe or not — this is what decides the event's own individual winner). index.js
// owns the Discord I/O (reaction listener, the live-standings post in the announce channel); this module
// just owns the state.
const fs = require('fs');
const { statePath } = require('./statepath');
const STATE_FILE = process.env.FUBU_TALLY_FILE || statePath('tally.json');

const POINT_EMOJI = '➕';   // the one reaction that scores — react with this on a participant's message
// (deliberately not in arena.REACTION_EMOJIS — if a tally and Reaction Rush were ever live in the same
// channel at once, a shared emoji would mean one swallows the other's scoring reactions)

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[tally] save:', e.message); } }
function get() { return load().active || null; }
function isActive() { return !!get(); }
function set(a) { const s = load(); s.active = a; save(s); }
function clear() { const s = load(); delete s.active; save(s); }
function update(patch) { const a = get(); if (!a) return null; const n = { ...a, ...patch }; set(n); return n; }

// +n (default 1) to the scoring member's individual tally (always), and to tribeKey's tally too if they're
// in one (tribeKey may be null — a participant with no tribe still racks up an individual score). Returns
// nothing meaningful; callers re-read get() for the fresh totals.
function addPoint(tribeKey, userId, n = 1) {
  const a = get(); if (!a) return null;
  if (tribeKey) { a.counts = a.counts || {}; a.counts[tribeKey] = (a.counts[tribeKey] || 0) + n; }
  if (userId) { a.memberCounts = a.memberCounts || {}; a.memberCounts[userId] = (a.memberCounts[userId] || 0) + n; }
  set(a);
}
// Individual leaderboard, highest first — this is what decides the event's own winner (tribe or not).
function topMembers(a, n = 10) {
  return Object.entries((a && a.memberCounts) || {}).sort((x, y) => y[1] - x[1]).slice(0, n);
}

module.exports = { POINT_EMOJI, get, isActive, set, clear, update, addPoint, topMembers };
