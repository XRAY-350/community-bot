// birthday.js — self-serve birthdays + a rotating "Birthday" role granted on the day and stripped after.
// Dates are month/day only (no year) — mirrors sealed.js's dayKey pattern (UTC-based, keeps the whole fleet
// on one clock rather than per-member timezones).
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_BIRTHDAY_FILE || statePath('birthdays.json');

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } return _cache; }
function save(s) { _cache = s; try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[birthday] save:', e.message); } }

function set(userId, month, day) { const s = load(); s.dates = s.dates || {}; s.dates[userId] = { month, day }; save(s); }
function get(userId) { return (load().dates || {})[userId] || null; }
function clear(userId) { const s = load(); if (s.dates) delete s.dates[userId]; save(s); }
function allDates() { return load().dates || {}; }

function roleId() { return load().roleId || null; }
function setRoleId(id) { const s = load(); s.roleId = id; save(s); }

// Who currently holds the role + which day (dayKey) they got it, so the sweep knows to strip it once
// that day has passed — not exactly 24h, "all day" on the calendar day it lands (UTC).
function active() { return load().active || {}; }
function setActive(userId, dayKey) { const s = load(); s.active = s.active || {}; s.active[userId] = dayKey; save(s); }
function clearActive(userId) { const s = load(); if (s.active) delete s.active[userId]; save(s); }

function lastRunDay() { return load().lastRunDay || null; }
function setLastRunDay(key) { const s = load(); s.lastRunDay = key; save(s); }

function dayKey(nowMs) { const d = new Date(nowMs || Date.now()); return `${d.getUTCMonth() + 1}-${d.getUTCDate()}`; }

module.exports = { set, get, clear, allDates, roleId, setRoleId, active, setActive, clearActive, lastRunDay, setLastRunDay, dayKey };
