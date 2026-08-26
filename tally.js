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
  if (tribeKey) { a.counts = a.counts || {}; a.counts[tribeKey] = Math.max(0, (a.counts[tribeKey] || 0) + n); }
  if (userId) { a.memberCounts = a.memberCounts || {}; a.memberCounts[userId] = Math.max(0, (a.memberCounts[userId] || 0) + n); }
  set(a);
}
// One score per (message, reactor) — audit A11, 2026-08-26: without this, removing and re-adding the ➕
// scored the author AGAIN every cycle (an unbounded Treasury/points farm, and no way to undo a mis-click).
// Returns false if this reactor already scored this message. unrecordScore reverses it on reaction-remove.
function recordScore(messageId, reactorId) {
  const a = get(); if (!a) return false;
  a.scored = a.scored || {};
  const list = a.scored[messageId] = a.scored[messageId] || [];
  if (list.includes(reactorId)) return false;
  list.push(reactorId); set(a); return true;
}
function unrecordScore(messageId, reactorId) {
  const a = get(); if (!a) return false;
  const list = (a.scored || {})[messageId];
  if (!list || !list.includes(reactorId)) return false;
  a.scored[messageId] = list.filter(id => id !== reactorId); set(a); return true;
}
// Individual leaderboard, highest first — this is what decides the event's own winner (tribe or not). n
// defaults to EVERYONE who scored (owner, 2026-08-25, from #organizer-chat: "is it possible to show more
// than the top 10? ppl would like to know how many points they got but when they didn't get enough, it
// doesn't show" — a top-10 cutoff hid every non-placing participant's own score entirely). Callers that
// genuinely want a short preview (a dashboard snippet, not the real standings) still pass an explicit n.
function topMembers(a, n = Infinity) {
  return Object.entries((a && a.memberCounts) || {}).sort((x, y) => y[1] - x[1]).slice(0, n);
}

module.exports = { POINT_EMOJI, get, isActive, set, clear, update, addPoint, topMembers, recordScore, unrecordScore };
