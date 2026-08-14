// tally.js — live point tally for manually-refereed events (owner: spent an hour hand-counting reactions
// after an event ended). ONE active tally at a time. Bot posts a single message with one pre-added
// reaction per tribe (that tribe's own emoji); an Event Organizer or mod+ reacting with a tribe's emoji
// adds a point for that tribe LIVE (the message text is edited to show the running count), so standings
// are visible throughout the event instead of counted up afterward. Reactions from anyone else are just
// ignored for scoring (left in place — not stripped, to avoid fighting genuine spectator reactions).
const fs = require('fs');
const { statePath } = require('./statepath');
const STATE_FILE = process.env.FUBU_TALLY_FILE || statePath('tally.json');

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[tally] save:', e.message); } }
function get() { return load().active || null; }
function isActive() { return !!get(); }
function set(a) { const s = load(); s.active = a; save(s); }
function clear() { const s = load(); delete s.active; save(s); }
function update(patch) { const a = get(); if (!a) return null; const n = { ...a, ...patch }; set(n); return n; }

// +n (default 1) to a tribe's live count. Returns the new total, or null if nothing's active.
function addPoint(tribeKey, n = 1) {
  const a = get(); if (!a) return null;
  a.counts = a.counts || {};
  a.counts[tribeKey] = (a.counts[tribeKey] || 0) + n;
  set(a);
  return a.counts[tribeKey];
}

module.exports = { get, isActive, set, clear, update, addPoint };
