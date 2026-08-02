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
  { key: 'r0', name: 'Initiate', days: 0, tides: 0 },
  { key: 'r1', name: 'Member', days: 1, tides: 50 },
  { key: 'r2', name: 'Veteran', days: 5, tides: 250 },
  { key: 'r3', name: 'Elder', days: 14, tides: 750 },
];
const DEFAULT_LEADER_TITLE = 'Chief';

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
// Live standings for the crown race — same ranking the weekly reset itself uses (Glory, then treasury, then
// member count), so /tribe list always shows "who's currently leading" honestly, not a dead placeholder field.
function standings(guild) {
  return all().map(t => ({ ...t, memberCount: guild.roles.cache.get(t.roleId)?.members.size ?? 0 }))
    .sort((a, b) => (b.glory || 0) - (a.glory || 0) || (b.treasury || 0) - (a.treasury || 0) || b.memberCount - a.memberCount);
}

// The label a tribe uses for its head. Personalized per tribe (tribe.leaderTitle); falls back to the default.
function leaderTitle(tribe) { return (tribe && tribe.leaderTitle) || DEFAULT_LEADER_TITLE; }
// Rename a tribe's rank rungs in state (Discord role renames happen in the command handler). names is an
// array aligned to tribe.ranks by position; blank/undefined entries keep the existing name.
function setRankNames(key, names) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t || !Array.isArray(t.ranks)) return null;
  t.ranks.forEach((r, i) => { if (names[i] && String(names[i]).trim()) r.name = String(names[i]).trim().slice(0, 40); });
  save(s); return t.ranks;
}

// Nominations: a THIRD route into a tribe alongside self-join and a leader's direct /tribe invite. Any
// member proposes -> the tribe's head or staff approves -> the NOMINEE gets their own accept prompt and only
// joins if they accept. Persisted (not in-memory) since approval/accept can land hours or days later. Keyed
// by targetId — one active nomination per person at a time.
function createNomination(tribeKey, nominatorId, targetId) {
  const s = load(); if (!s.nominations) s.nominations = {};
  s.nominations[targetId] = { tribeKey, nominatorId, targetId, status: 'pending_approval', createdAt: Date.now() };
  save(s); return s.nominations[targetId];
}
function getNomination(targetId) { return (load().nominations || {})[targetId] || null; }
function updateNomination(targetId, patch) {
  const s = load(); if (!s.nominations || !s.nominations[targetId]) return null;
  s.nominations[targetId] = { ...s.nominations[targetId], ...patch };
  save(s); return s.nominations[targetId];
}
function clearNomination(targetId) { const s = load(); if (s.nominations) delete s.nominations[targetId]; save(s); }

// ---- Treasury (a bank, never resets, spent by the head in the shop) + Glory (weekly flow, decides the crown
// only, never spent) — see TRIBE_PHASE5_SPEC.md section 1 for why these are kept separate. ----
function addTreasury(key, n) { const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return 0; t.treasury = (t.treasury || 0) + n; save(s); return t.treasury; }
function getTreasury(key) { return (get(key) || {}).treasury || 0; }
function spendTreasury(key, n) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t || (t.treasury || 0) < n) return false;
  t.treasury -= n; save(s); return true;
}
function addGlory(key, n) { const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return 0; t.glory = (t.glory || 0) + n; save(s); return t.glory; }
function getGlory(key) { return (get(key) || {}).glory || 0; }
// Weekly crown reset: pick the highest-Glory tribe (tie-break: treasury, then live member count via `guild`),
// award it +500 treasury and a crownsWon tick, then zero every tribe's Glory for the new week. Returns the
// winning tribe's { key, glory }, or null if NO tribe earned any Glory this week — the reset still happens,
// but no crown is awarded for a week nobody actually contested (own call, not explicit in the spec: awarding
// a crown off a bare tie-break with zero real activity felt hollow, especially before any Glory faucets exist).
function resetWeeklyGlory(guild) {
  const s = load(); if (!s.tribes || !Object.keys(s.tribes).length) return null;
  const list = Object.values(s.tribes).map(t => ({
    key: t.key, glory: t.glory || 0, treasury: t.treasury || 0,
    memberCount: guild.roles.cache.get(t.roleId)?.members.size ?? 0,
  })).sort((a, b) => b.glory - a.glory || b.treasury - a.treasury || b.memberCount - a.memberCount);
  for (const t of Object.values(s.tribes)) t.glory = 0;
  const winner = list[0];
  if (winner && winner.glory > 0) {
    s.tribes[winner.key].treasury = (s.tribes[winner.key].treasury || 0) + 500;
    s.tribes[winner.key].crownsWon = (s.tribes[winner.key].crownsWon || 0) + 1;
  }
  save(s);
  return (winner && winner.glory > 0) ? { key: winner.key, glory: winner.glory } : null;
}
// Has the weekly crown reset already run for the CURRENT week (Sunday 00:00 UTC boundary)? A setInterval tick
// doesn't need to land exactly on the boundary, just run at least once after it passes — tracked so it only
// actually fires once per week no matter how often the caller checks.
function weekStartMs(nowMs) { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay(), 0, 0, 0, 0); }
function dueForWeeklyCrown(nowMs) { const s = load(); return !s.lastGloryResetWeek || s.lastGloryResetWeek < weekStartMs(nowMs); }
function markWeeklyCrownDone(nowMs) { const s = load(); s.lastGloryResetWeek = weekStartMs(nowMs); save(s); }

// ---- The land shop: milestone-gated unlocks (see TRIBE_PHASE5_SPEC.md section 3) + the uncapped Stronghold
// Tier sink (section 3a). The unlock CATALOG (gates, costs, what each one does) lives in index.js since
// applying most of them needs live Discord objects (channels/roles) — this module just tracks what's owned.
function hasUnlock(tribe, unlockKey) { return !!(tribe.unlocks || []).includes(unlockKey); }
function addUnlock(key, unlockKey) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return null;
  if (!t.unlocks) t.unlocks = [];
  if (!t.unlocks.includes(unlockKey)) t.unlocks.push(unlockKey);
  save(s); return t.unlocks;
}
function removeUnlock(key, unlockKey) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t || !t.unlocks) return null;
  t.unlocks = t.unlocks.filter(u => u !== unlockKey);
  save(s); return t.unlocks;
}
function addStrongholdTier(key) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return 0;
  t.strongholdTier = (t.strongholdTier || 0) + 1;
  save(s); return t.strongholdTier;
}

module.exports = { load, save, all, get, getByRole, resolve, memberTribe, isMember, isLeader, leaderTribe, myTribe,
  addNote, getNotes, register, update, setMotto, roster, standings, RANK_LADDER, DEFAULT_LEADER_TITLE, leaderTitle, setRankNames,
  addTides, getTides, topTides, recordJoin, tenureDays, earnedRankIndex, currentRankIndex,
  markVeteran, isVeteran, setMembership, isAuthorized, STATE_FILE,
  createNomination, getNomination, updateNomination, clearNomination,
  addTreasury, getTreasury, spendTreasury, addGlory, getGlory, resetWeeklyGlory,
  dueForWeeklyCrown, markWeeklyCrownDone,
  hasUnlock, addUnlock, removeUnlock, addStrongholdTier };
