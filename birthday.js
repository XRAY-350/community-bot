// birthday.js — self-serve birthdays (month/day + optional IANA timezone) + a per-person, ephemeral
// "Birthday" role: created fresh for that member when their day starts (in THEIR timezone, not the
// server's), positioned just above their own highest role, then deleted outright when their local day
// ends. Per-person and ephemeral — NOT one shared role positioned above everyone — because a role shared
// across members and pinned high in the hierarchy would outrank staff roles too, blocking moderation on
// whoever's role it is that day.
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_BIRTHDAY_FILE || statePath('birthdays.json');

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } return _cache; }
function save(s) { _cache = s; try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[birthday] save:', e.message); } }

// tz is an IANA zone name (e.g. "America/New_York") or null/undefined → UTC. Passing tz===undefined on an
// update preserves whatever was already saved, so `/birthday set` can update just the date without
// clobbering a previously-set timezone (and vice versa).
function set(userId, month, day, tz) {
  const s = load(); s.dates = s.dates || {};
  const prev = s.dates[userId] || {};
  s.dates[userId] = { month, day, tz: tz !== undefined ? tz : (prev.tz || null) };
  save(s);
}
function get(userId) { return (load().dates || {})[userId] || null; }
function clear(userId) { const s = load(); if (s.dates) delete s.dates[userId]; save(s); }
function allDates() { return load().dates || {}; }

// Per-person ephemeral role while it's currently their day: { [userId]: { roleId, localDay } }.
// localDay is the localDayKey it was granted on, so the sweep knows when their local date has rolled over.
function active() { return load().active || {}; }
function setActive(userId, roleId, localDay) { const s = load(); s.active = s.active || {}; s.active[userId] = { roleId, localDay }; save(s); }
function clearActive(userId) { const s = load(); if (s.active) delete s.active[userId]; save(s); }

function lastRunHour() { return load().lastRunHour || null; }
function setLastRunHour(key) { const s = load(); s.lastRunHour = key; save(s); }

// "month-day" for a given timestamp in a given IANA timezone (defaults to UTC on a bad/unknown zone rather
// than throwing — a stale/mistyped saved tz shouldn't take the whole sweep down).
function localDayKey(nowMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', month: 'numeric', day: 'numeric' }).formatToParts(new Date(nowMs || Date.now()));
    return `${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
  } catch { return tz ? localDayKey(nowMs, null) : '1-1'; }
}
function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

module.exports = { set, get, clear, allDates, active, setActive, clearActive, lastRunHour, setLastRunHour, localDayKey, isValidTz };
