// birthday.js — self-serve birthdays (month/day + a required UTC offset, e.g. "-5" or "+5:30") + a
// per-person, ephemeral "Birthday" role: created fresh for that member when their day starts (in THEIR
// offset, not the server's), positioned just above their own highest role, then deleted outright when
// their local day ends. Per-person and ephemeral — NOT one shared role positioned above everyone — because
// a role shared across members and pinned high in the hierarchy would outrank staff roles too, blocking
// moderation on whoever's role it is that day.
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_BIRTHDAY_FILE || statePath('birthdays.json');

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } return _cache; }
function save(s) { _cache = s; try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[birthday] save:', e.message); } }

// utcOffsetMin: whole minutes offset from UTC (e.g. -300 for UTC-5, 330 for UTC+5:30). Always required —
// there's no "default UTC" here, the caller must always pass a value.
function set(userId, month, day, utcOffsetMin) {
  const s = load(); s.dates = s.dates || {};
  s.dates[userId] = { month, day, utcOffsetMin };
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

// "month-day" for a given timestamp shifted by a fixed UTC offset (minutes).
function localDayKey(nowMs, utcOffsetMin) {
  const shifted = new Date((nowMs || Date.now()) + (utcOffsetMin || 0) * 60000);
  return `${shifted.getUTCMonth() + 1}-${shifted.getUTCDate()}`;
}
// Accepts "-5", "+5", "5", "-5:30", "+5:30", "UTC-8", "utc+5:30", "GMT+1" → minutes, or null if unparseable
// or out of the real-world UTC-12..UTC+14 range.
function parseOffset(input) {
  const s = String(input || '').trim().toUpperCase().replace(/^(UTC|GMT)\s*/, '');
  const m = s.match(/^([+-]?)(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = parseInt(m[2], 10);
  const mins = m[3] ? parseInt(m[3], 10) : 0;
  if (mins >= 60) return null;
  const total = sign * (hours * 60 + mins);
  if (total < -720 || total > 840) return null;   // UTC-12:00 .. UTC+14:00
  return total;
}
function formatOffset(min) {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${sign}${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}

module.exports = { set, get, clear, allDates, active, setActive, clearActive, lastRunHour, setLastRunHour, localDayKey, parseOffset, formatOffset };
