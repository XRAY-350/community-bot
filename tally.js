// tally.js — live point tally for manually-refereed events (owner: spent an hour hand-counting reactions
// after an event ended; the Event Organizer wants to just react to a participant's own message and have
// it count for their tribe). ONE active tally at a time, scoped to a single channel: an Event Organizer
// or mod reacting with the fixed POINT_EMOJI on ANY member's message in that channel adds a point to
// whichever tribe that message's author belongs to. index.js owns the Discord I/O (the reaction listener,
// the live-standings announcement message); this module just owns the state.
const fs = require('fs');
const { statePath } = require('./statepath');
const STATE_FILE = process.env.FUBU_TALLY_FILE || statePath('tally.json');

const POINT_EMOJI = '➕';   // the one reaction that scores — react with this on a participant's message
// (deliberately not in arena.REACTION_EMOJIS — Reaction Rush shares the same event channel, and a
// collision there would mean an EO's tally react gets swallowed as a Reaction Rush score, or vice versa)

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[tally] save:', e.message); } }
function get() { return load().active || null; }
function isActive() { return !!get(); }
function set(a) { const s = load(); s.active = a; save(s); }
function clear() { const s = load(); delete s.active; save(s); }
function update(patch) { const a = get(); if (!a) return null; const n = { ...a, ...patch }; set(n); return n; }

// +n (default 1) to a tribe's live count, and to that member's own tally within it (for an MVP line).
// Returns the tribe's new total, or null if nothing's active.
function addPoint(tribeKey, userId, n = 1) {
  const a = get(); if (!a) return null;
  a.counts = a.counts || {};
  a.counts[tribeKey] = (a.counts[tribeKey] || 0) + n;
  if (userId) { a.memberCounts = a.memberCounts || {}; a.memberCounts[userId] = (a.memberCounts[userId] || 0) + n; }
  set(a);
  return a.counts[tribeKey];
}

module.exports = { POINT_EMOJI, get, isActive, set, clear, update, addPoint };
