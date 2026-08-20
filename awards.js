// awards.js — weekly peer-voted member awards (e.g. "😂 Funniest Member"). Staff configure the category
// list; any member can vote for any OTHER member (never themselves), one vote per category per week.
// Wednesday: a reminder to vote. Friday: tally, swap the rotating role to the winner, reset for next week.
// Category state persists across weeks (categories + each one's current role); votes reset every week.
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_AWARDS_FILE || statePath('awards.json');

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } return _cache; }
function save(s) { _cache = s; try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[awards] save:', e.message); } }

function weekStartMs(nowMs) { const d = new Date(nowMs || Date.now()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay(), 0, 0, 0, 0); }

// ---- categories: { [key]: { name, roleId } } — staff-managed, persists across weeks ----
function categories() { return load().categories || {}; }
function getCategory(key) { return categories()[key] || null; }
function addCategory(key, name) {
  const s = load(); s.categories = s.categories || {};
  s.categories[key] = { name, roleId: (s.categories[key] || {}).roleId || null };
  save(s);
}
function removeCategory(key) { const s = load(); if (s.categories) delete s.categories[key]; if (s.votes) delete s.votes[key]; if (s.holders) delete s.holders[key]; save(s); }
function setCategoryRoleId(key, roleId) { const s = load(); if (!s.categories || !s.categories[key]) return false; s.categories[key].roleId = roleId; save(s); return true; }

// ---- votes: { [categoryKey]: { [voterId]: targetId } } — cleared every week by clearVotes ----
function votes(categoryKey) { return (load().votes || {})[categoryKey] || {}; }
function castVote(categoryKey, voterId, targetId) {
  const s = load(); s.votes = s.votes || {}; s.votes[categoryKey] = s.votes[categoryKey] || {};
  s.votes[categoryKey][voterId] = targetId; save(s);
}
function myVote(categoryKey, voterId) { return votes(categoryKey)[voterId] || null; }
// Ranked [{ userId, count }], highest first.
function tally(categoryKey) {
  const counts = {};
  for (const targetId of Object.values(votes(categoryKey))) counts[targetId] = (counts[targetId] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([userId, count]) => ({ userId, count }));
}
function clearVotes(categoryKey) { const s = load(); if (s.votes) delete s.votes[categoryKey]; save(s); }

// ---- current holder per category (who holds the role right now) ----
function holder(categoryKey) { return (load().holders || {})[categoryKey] || null; }
function setHolder(categoryKey, userId) { const s = load(); s.holders = s.holders || {}; s.holders[categoryKey] = userId; save(s); }

// ---- weekly cadence markers — Wednesday reminder, Friday results, each once per week ----
function dueForReminder(nowMs) {
  const s = load();
  if (new Date(nowMs || Date.now()).getUTCDay() < 3) return false;   // before Wednesday
  return !s.lastReminderWeek || s.lastReminderWeek < weekStartMs(nowMs);
}
function markReminderDone(nowMs) { const s = load(); s.lastReminderWeek = weekStartMs(nowMs); save(s); }
function dueForResults(nowMs) {
  const s = load();
  if (new Date(nowMs || Date.now()).getUTCDay() < 5) return false;   // before Friday
  return !s.lastResultsWeek || s.lastResultsWeek < weekStartMs(nowMs);
}
function markResultsDone(nowMs) { const s = load(); s.lastResultsWeek = weekStartMs(nowMs); save(s); }

// ---- pinned vote-panel message ref (owner, 2026-08-20: "is there a way we can make this easier
// instead of using a command" — a persistent category/target picker replacing /awards vote) ----
function panelRef() { return load().panel || null; }
function setPanelRef(channelId, messageId) { const s = load(); s.panel = { channelId, messageId }; save(s); }

module.exports = {
  categories, getCategory, addCategory, removeCategory, setCategoryRoleId,
  votes, castVote, myVote, tally, clearVotes,
  holder, setHolder,
  dueForReminder, markReminderDone, dueForResults, markResultsDone, weekStartMs,
  panelRef, setPanelRef,
};
