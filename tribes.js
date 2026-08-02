// tribes.js — the FUBU TRIBE FRAMEWORK. A "tribe" is a member-run faction: a hoisted role, a leader
// role, and (usually) a private category of channels ("their land"). This module is the single source of
// truth for which tribes exist + their metadata, and the helpers every tribe feature builds on
// (membership, leadership, roster, motto, and points for the future territory/rivalry system). All state
// lives in one JSON file so tribes survive restarts. Any tribe (Cobalt Vigil, Valith, future ones) plugs
// in the same way — this is a framework, not a one-off.
const fs = require('fs');
const STATE_FILE = process.env.FUBU_TRIBES_FILE || '/home/ubuntu/.fubu_tribes.json';

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { tribes: {} }; } }
function save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[tribes] save:', e.message); } }

function all() { return Object.values(load().tribes || {}); }
function get(key) { return (load().tribes || {})[key] || null; }
function getByRole(roleId) { return all().find(t => t.roleId === roleId) || null; }
// Resolve a tribe from a free-text arg: exact key, or case-insensitive name/shortName contains.
function resolve(query) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  return get(q) || all().find(t => (t.name || '').toLowerCase() === q || (t.shortName || '').toLowerCase() === q)
    || all().find(t => (t.name || '').toLowerCase().includes(q) || (t.shortName || '').toLowerCase().includes(q)) || null;
}

// The tribe a member belongs to (by tribe role), or null. A member is only ever in one tribe.
function memberTribe(member) {
  if (!member) return null;
  return all().find(t => member.roles.cache.has(t.roleId)) || null;
}
function isMember(member, tribe) { return !!(member && tribe && member.roles.cache.has(tribe.roleId)); }
// A leader holds the tribe's leader role. (Server staff can also manage any tribe — callers add that.)
function isLeader(member, tribe) { return !!(member && tribe && tribe.leaderRoleId && member.roles.cache.has(tribe.leaderRoleId)); }
// The tribe a member LEADS (holds the leader role of), or null. A leader often isn't a rank-and-file
// member of their own tribe (holds the leader role, not the member role) — so "my tribe" checks both.
function leaderTribe(member) { if (!member) return null; return all().find(t => t.leaderRoleId && member.roles.cache.has(t.leaderRoleId)) || null; }
function myTribe(member) { return leaderTribe(member) || memberTribe(member); }

// Private leader notes on a member: tribe.notes[userId] = [{ text, by, at }].
function addNote(key, userId, text, byId) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return null;
  if (!t.notes) t.notes = {}; if (!Array.isArray(t.notes[userId])) t.notes[userId] = [];
  t.notes[userId].push({ text: String(text || '').slice(0, 500), by: byId, at: Date.now() });
  save(s); return t.notes[userId];
}
function getNotes(key, userId) { return (get(key) && get(key).notes || {})[userId] || []; }

// Upsert a tribe record (merges, so re-registering keeps points/motto/ranks).
function register(tribe) {
  const s = load();
  if (!s.tribes) s.tribes = {};
  s.tribes[tribe.key] = { points: 0, motto: '', rankRoleIds: [], notes: {}, joinedAt: {}, ...s.tribes[tribe.key], ...tribe };
  save(s);
  return s.tribes[tribe.key];
}
function update(key, patch) {
  const s = load();
  if (!s.tribes || !s.tribes[key]) return null;
  s.tribes[key] = { ...s.tribes[key], ...patch };
  save(s);
  return s.tribes[key];
}
function setMotto(key, motto) { return update(key, { motto: String(motto || '').slice(0, 300) }); }

// Default rank ladder — the per-tribe rank ROLES are created from this; each tribe stores its own copy
// in tribe.ranks (so names/thresholds are tunable per tribe). Ordered lowest→highest. Rank 0 = on join.
const RANK_LADDER = [
  { key: 'initiate', name: 'Initiate', days: 0, tides: 0 },
  { key: 'watcher', name: 'Watcher', days: 1, tides: 50 },
  { key: 'sentinel', name: 'Sentinel', days: 5, tides: 250 },
  { key: 'vanguard', name: 'Vanguard', days: 14, tides: 750 },
];

// ---- Tides (activity points) + tenure ----
function addTides(key, userId, n = 1) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return 0;
  if (!t.tides) t.tides = {};
  t.tides[userId] = (t.tides[userId] || 0) + n;
  save(s); return t.tides[userId];
}
function getTides(key, userId) { const t = get(key); return ((t && t.tides) || {})[userId] || 0; }

// "Veterans" = anyone who has EVER been in a tribe. Loyalty model: your first tribe is a free self-join,
// but once you've been in one you can't self-join again — a new tribe must accept you (request/invite).
// Marked whenever any tribe role is added (guildMemberUpdate) — permanent history, survives release.
function markVeteran(userId) { const s = load(); if (!s.veterans) s.veterans = {}; if (!s.veterans[userId]) { s.veterans[userId] = Date.now(); save(s); } }
function isVeteran(userId) { return !!(load().veterans || {})[userId]; }

// Authoritative tribe membership — the SOURCE OF TRUTH for who is legitimately in a tribe. Set ONLY by
// sanctioned flows (picker first-join / invite / request-approve / banish). The guildMemberUpdate guard
// reverts any manual role add/strip that disagrees with this. Joining also stamps veteran + join-time.
function setMembership(key, userId, isMember) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return;
  if (!t.members) t.members = {};
  if (isMember) {
    t.members[userId] = true;
    if (!s.veterans) s.veterans = {}; if (!s.veterans[userId]) s.veterans[userId] = Date.now();
    if (!t.joinedAt) t.joinedAt = {}; if (!t.joinedAt[userId]) t.joinedAt[userId] = Date.now();
  } else { delete t.members[userId]; }
  save(s);
}
function isAuthorized(key, userId) { return !!((get(key) || {}).members || {})[userId]; }
function topTides(key, n = 15) {
  const tides = (get(key) || {}).tides || {};
  return Object.entries(tides).sort((a, b) => b[1] - a[1]).slice(0, n).map(([userId, points]) => ({ userId, points }));
}
// Stamp a member's tribe join-time once (for tenure). Called when they first earn a Tide / are invited.
function recordJoin(key, userId) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return;
  if (!t.joinedAt) t.joinedAt = {};
  if (!t.joinedAt[userId]) { t.joinedAt[userId] = Date.now(); save(s); }
}
function tenureDays(tribe, userId) { const at = (tribe.joinedAt || {})[userId]; return at ? (Date.now() - at) / 86400000 : 0; }
// Highest rank index a member has EARNED (days AND tides both met). Rank 0 always qualifies.
function earnedRankIndex(tribe, userId) {
  const ranks = tribe.ranks || []; const days = tenureDays(tribe, userId); const tides = (tribe.tides || {})[userId] || 0;
  let idx = 0;
  for (let i = 0; i < ranks.length; i++) if (days >= (ranks[i].days || 0) && tides >= (ranks[i].tides || 0)) idx = i;
  return idx;
}
// The rank index a member CURRENTLY holds (by which rank role they have), or -1 if none.
function currentRankIndex(member, tribe) {
  const ranks = tribe.ranks || [];
  for (let i = ranks.length - 1; i >= 0; i--) if (ranks[i].roleId && member.roles.cache.has(ranks[i].roleId)) return i;
  return -1;
}

// Members currently holding a tribe's role (needs a populated member cache — fetch members first).
function roster(guild, tribe) {
  const role = guild.roles.cache.get(tribe.roleId);
  return role ? [...role.members.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)) : [];
}

// Standings for the rivalry board: tribes sorted by points (desc), with live member counts.
function standings(guild) {
  return all().map(t => ({ ...t, memberCount: guild.roles.cache.get(t.roleId)?.members.size ?? 0 }))
    .sort((a, b) => (b.points || 0) - (a.points || 0) || b.memberCount - a.memberCount);
}

module.exports = { load, save, all, get, getByRole, resolve, memberTribe, isMember, isLeader, leaderTribe, myTribe,
  addNote, getNotes, register, update, setMotto, roster, standings, RANK_LADDER,
  addTides, getTides, topTides, recordJoin, tenureDays, earnedRankIndex, currentRankIndex,
  markVeteran, isVeteran, setMembership, isAuthorized, STATE_FILE };
