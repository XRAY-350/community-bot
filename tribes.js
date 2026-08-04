// tribes.js — the FUBU TRIBE FRAMEWORK. A "tribe" is a member-run faction: a hoisted role, a leader
// role, and (usually) a private category of channels ("their land"). This module is the single source of
// truth for which tribes exist + their metadata, and the helpers every tribe feature builds on
// (membership, leadership, roster, motto, and points for the future territory/rivalry system). All state
// lives in one JSON file so tribes survive restarts. Any tribe (Cobalt Vigil, Valith, future ones) plugs
// in the same way — this is a framework, not a one-off.
const fs = require('fs');
const STATE_FILE = process.env.FUBU_TRIBES_FILE || '/home/ubuntu/.fubu_tribes.json';

// In-memory cache — load() is called MANY times per message (memberTribe, the Tides hall lookup, the arena
// blitz, etc.), so a sync fs.readFileSync each time saturates the event loop under high message volume (this
// is what lagged interactions during a blitz). The bot is the only writer, so caching is safe; save() keeps
// it fresh. NOTE: an external process that edits the file needs a bot restart to be seen (rare — recovery ops).
let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { _cache = { tribes: {} }; } return _cache; }
function save(s) { _cache = s; try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[tribes] save:', e.message); } }

function all() { return Object.values(load().tribes || {}); }
function get(key) { return (load().tribes || {})[key] || null; }
function getByRole(roleId) { return all().find(t => t.roleId === roleId) || null; }

// The Tribes Hub — a standing reference + button-panel channel (owner, 2026-08-03: "consolidate commands
// into dashboards and panels because it's getting really long"). One channel, one message; tracked here so
// a restart or a content refresh can find + edit it without re-creating the channel each time.
function getHubInfo() { return load().hub || null; }
function setHubInfo(channelId, messageId) { const s = load(); s.hub = { channelId, messageId }; save(s); }
// Tribe-announcements channel (owner, 2026-08-04) — sits above the hub, shows challenge results + tribe news.
function getAnnounceInfo() { return load().announce || null; }
function setAnnounceInfo(channelId) { const s = load(); s.announce = { channelId }; save(s); }
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
// The "General" rank (owner, 2026-08-03: "mods or admins should get a special role like general"): any staff
// member (mod or admin tier) who is a tribe MEMBER (not its leader — leader already outranks everything)
// automatically holds this, sitting above the whole normal rank ladder. Per-tribe customizable, like
// leaderTitle. tribe.staffRankRoleId stores the actual Discord role (created in buildTribe()).
const DEFAULT_STAFF_RANK_TITLE = 'General';
function staffRankTitle(tribe) { return (tribe && tribe.staffRankTitle) || DEFAULT_STAFF_RANK_TITLE; }
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
// A direct /tribe invite now needs the TARGET's consent too (owner, 2026-08-03: "invite should get consent")
// — reuses the same nomination record shape, just starting straight at 'pending_accept' since the leader
// inviting IS the approval step (no separate head/staff sign-off needed, unlike a member's /tribe nominate).
function createDirectInvite(tribeKey, inviterId, targetId) {
  const s = load(); if (!s.nominations) s.nominations = {};
  s.nominations[targetId] = { tribeKey, nominatorId: inviterId, targetId, status: 'pending_accept', approvedBy: inviterId, createdAt: Date.now() };
  save(s); return s.nominations[targetId];
}

// A member's own request to LEAVE their tribe (owner, 2026-08-03: only exit path was the leader/staff-run
// /tribe banish — members had no formal way to ask). Posted to the tribe's throne for the leader (or staff)
// to Approve/Deny, mirroring the nominate/invite consent pattern rather than an instant self-release, which
// would undercut the loyalty design ("can't leave or switch on your own"). Persisted, keyed by memberId —
// one active request per person at a time.
function startLeaveRequest(tribeKey, memberId) {
  const s = load(); if (!s.leaveRequests) s.leaveRequests = {};
  s.leaveRequests[memberId] = { tribeKey, memberId, status: 'pending', createdAt: Date.now() };
  save(s); return s.leaveRequests[memberId];
}
function getLeaveRequest(memberId) { return (load().leaveRequests || {})[memberId] || null; }
function clearLeaveRequest(memberId) { const s = load(); if (s.leaveRequests) delete s.leaveRequests[memberId]; save(s); }

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

// ---- Rituals (section 8): musters — member-participation roll-calls, per tribe. (The old server-wide
// staff-authored weekly challenge was retired 2026-08-04 in favour of the interactive Arena — see arena.js.) ----
function startMuster(key, byId, durationMs) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return null;
  t.muster = { startedBy: byId, startedAt: Date.now(), expiresAt: Date.now() + durationMs, participants: [] };
  t.lastMusterAt = Date.now();
  save(s); return t.muster;
}
function getMuster(key) { return (get(key) || {}).muster || null; }
function setMusterMessage(key, channelId, messageId) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t || !t.muster) return;
  t.muster.channelId = channelId; t.muster.messageId = messageId; save(s);
}
function joinMuster(key, userId) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t || !t.muster) return false;
  if (t.muster.participants.includes(userId)) return false;
  t.muster.participants.push(userId); save(s); return true;
}
// Pays the tribe +3 treasury / +3 glory PER participant (uncapped, bounded naturally by real headcount),
// clears the muster record. Returns the closed muster (with its final count + reward), or null if none active.
function closeMuster(key) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t || !t.muster) return null;
  const m = t.muster; const n = m.participants.length; const reward = n * 3;
  t.treasury = (t.treasury || 0) + reward;
  t.glory = (t.glory || 0) + reward;
  delete t.muster;
  save(s);
  return { ...m, count: n, reward };
}

// A mod founding their own tribe needs 2 OTHER mods to co-sign first (owner: "if a mod wants to start a
// tribe it must be in a group of three" — the founder + 2 co-signers). Admin-founded tribes skip this
// entirely. Keyed by founder id since a person can only have one pending founding request at a time.
function startFoundingRequest(founderId) {
  const s = load(); if (!s.foundingRequests) s.foundingRequests = {};
  s.foundingRequests[founderId] = { cosigns: [], createdAt: Date.now() };
  save(s); return s.foundingRequests[founderId];
}
function getFoundingRequest(founderId) { return (load().foundingRequests || {})[founderId] || null; }
function setFoundingMessage(founderId, channelId, messageId) {
  const s = load(); const r = s.foundingRequests && s.foundingRequests[founderId]; if (!r) return;
  r.channelId = channelId; r.messageId = messageId; save(s);
}
// Returns the updated request, or null if this cosigner already signed (no-op) or there's no pending request.
function cosignFounding(founderId, cosignerId) {
  const s = load(); const r = s.foundingRequests && s.foundingRequests[founderId]; if (!r) return null;
  if (r.cosigns.includes(cosignerId)) return null;
  r.cosigns.push(cosignerId); save(s); return r;
}
function clearFoundingRequest(founderId) { const s = load(); if (s.foundingRequests) delete s.foundingRequests[founderId]; save(s); }

// Entrance gate: an optional per-tribe question a new applicant must answer correctly to SELF-join via the
// #roles picker (owner, 2026-08-03: Valith wanted one, "will mean all of them will have to get one as well" —
// so this is a general tribe feature, not Valith-only, just OFF by default for tribes that don't set one).
// { prompt, optionA, optionB, correct: 'a'|'b' }. Does not apply to /tribe invite (leader already vouches) or
// nomination-accept (already has its own 3-step approval).
function setEntranceGate(key, gate) { const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return null; t.entranceGate = gate; save(s); return t.entranceGate; }
function getEntranceGate(key) { return (get(key) || {}).entranceGate || null; }
function clearEntranceGate(key) { const s = load(); const t = s.tribes && s.tribes[key]; if (t) delete t.entranceGate; save(s); }

// ---- War & Alliances (Phase 6, 2026-08-03) — owner: "add war and alliances at the request of the other
// leaders." Declaring is a real DECISION, not a click: the proposing tribe's OWN members vote (no consent
// needed from the target), and the outcome is a probabilistic simulation, not a guaranteed stomp — a small,
// active tribe can beat a bigger sloppy one. Power is Tides-based specifically because Tides can't be
// manufactured on demand (rank-based power could be gamed by mass-promoting members right before a fight;
// Tides only come from real, rate-limited hall activity — owner's own correction, 2026-08-03).
const WAR_VOTE_MS = 24 * 60 * 60 * 1000;          // 24h vote window
const WAR_VOTE_TURNOUT = 0.30;                    // ≥30% of current members must vote
const WAR_COOLDOWN_MS = 72 * 60 * 60 * 1000;      // 72h before either side can war again
const CAPTURE_LOCK_MS = WAR_COOLDOWN_MS / 2;       // 36h — captured members can't leave (any path) until this passes
const WAR_TREASURY_RAID_PCT = 0.25;               // winner takes 25% of loser's treasury
const WAR_GLORY_BONUS = 100;                       // flat, not stolen — Glory is a weekly flow, not a stock to raid
const WAR_CAPTURE_PCT = 0.10;                      // winner captures ~10% of loser's regular members
const WAR_CAPTURE_CAP = 5;                         // ...capped at 5 regardless of loser's size
const WAR_CAPTURE_FLOOR = 3;                       // ...and never below this many members left in the loser

// Tides-based combat power: everyone (including leaders/staff, who earn Tides same as anyone) contributes
// at least 1 (bare presence) plus their real accumulated Tides. Needs `guild` to enumerate live role holders.
function warPower(guild, tribe) {
  const role = guild.roles.cache.get(tribe.roleId);
  if (!role) return 0;
  let power = 0;
  for (const m of role.members.values()) power += 1 + getTides(tribe.key, m.id);
  return power;
}
function onWarCooldown(tribe, nowMs = Date.now()) { return !!tribe.lastWarAt && (nowMs - tribe.lastWarAt) < WAR_COOLDOWN_MS; }
function warCooldownEndsAt(tribe) { return (tribe.lastWarAt || 0) + WAR_COOLDOWN_MS; }

function startWarVote(attackerKey, defenderKey, proposerId) {
  const s = load(); if (!s.wars) s.wars = {};
  const id = `w_${Date.now()}`;
  s.wars[id] = { id, attackerKey, defenderKey, proposerId, status: 'voting', votes: {}, createdAt: Date.now(), voteEndsAt: Date.now() + WAR_VOTE_MS };
  save(s); return s.wars[id];
}
function getWar(id) { return (load().wars || {})[id] || null; }
function voteOnWar(id, userId, choice) {
  const s = load(); const w = s.wars && s.wars[id]; if (!w || w.status !== 'voting') return null;
  w.votes[userId] = choice; save(s); return w;
}
// "Active" = a vote in flight OR (structurally) already resolved this tick — resolution is instant once a
// vote passes, so the only real in-flight state IS the vote window; the cooldown covers the period after.
function activeWarVoteFor(tribeKey) {
  return Object.values(load().wars || {}).find(w => w.status === 'voting' && w.attackerKey === tribeKey) || null;
}
function anyActiveWarInvolving(tribeKey) {
  return Object.values(load().wars || {}).some(w => w.status === 'voting' && (w.attackerKey === tribeKey || w.defenderKey === tribeKey));
}
function expiredWarVotes(nowMs) {
  return Object.values(load().wars || {}).filter(w => w.status === 'voting' && w.voteEndsAt <= nowMs);
}
function resolveWarRecord(id, patch) {
  const s = load(); const w = s.wars && s.wars[id]; if (!w) return null;
  Object.assign(w, patch); save(s); return w;
}
// Pure decision: who wins, what changes hands. Does NOT mutate anything (no treasury/glory/role changes) —
// the caller (index.js, which has live Discord objects) applies the result, since moving captured members
// needs real role operations this module deliberately doesn't do (see roster()/standings() for the same
// read-only-guild precedent). Alliance power is added on BOTH sides if either has an active ally (mutual
// defense doesn't cost the ally anything directly, it just reinforces).
function simulateWar(guild, attacker, defender) {
  const allyOf = t => (t.allyKey && get(t.allyKey)) || null;
  const powerA = warPower(guild, attacker) + (allyOf(attacker) ? warPower(guild, allyOf(attacker)) : 0);
  const powerB = warPower(guild, defender) + (allyOf(defender) ? warPower(guild, allyOf(defender)) : 0);
  const attackerWinChance = powerA / (powerA + powerB || 1);
  const attackerWins = Math.random() < attackerWinChance;
  const winner = attackerWins ? attacker : defender;
  const loser = attackerWins ? defender : attacker;
  const loserRole = guild.roles.cache.get(loser.roleId);
  const loserMembers = loserRole ? [...loserRole.members.values()].filter(m => !isLeader(m, loser)) : [];
  const maxCapturable = Math.max(0, loserMembers.length - WAR_CAPTURE_FLOOR);
  const captureCount = Math.min(WAR_CAPTURE_CAP, maxCapturable, Math.floor(loserMembers.length * WAR_CAPTURE_PCT));
  const shuffled = [...loserMembers].sort(() => Math.random() - 0.5);
  const capturedIds = shuffled.slice(0, captureCount).map(m => m.id);
  const raidAmount = Math.floor((loser.treasury || 0) * WAR_TREASURY_RAID_PCT);
  return { winnerKey: winner.key, loserKey: loser.key, powerA, powerB, attackerWinChance, raidAmount, capturedIds };
}

function setCaptureLock(userId, untilMs) { const s = load(); if (!s.captureLocks) s.captureLocks = {}; s.captureLocks[userId] = untilMs; save(s); }
function captureLockUntil(userId) { return (load().captureLocks || {})[userId] || 0; }
function isCaptureLocked(userId, nowMs = Date.now()) { return captureLockUntil(userId) > nowMs; }

// ---- Alliances: mutual defense (see simulateWar) + a shared treasury pool. Capped at ONE ally per tribe —
// with 5 tribes, unlimited alliances would make the politics meaningless. Bilateral: the proposer's own
// members vote first (same mechanic as war), then the TARGET tribe's leader/staff accept or deny — mirrors
// every other cross-tribe consent flow in this framework (nominate/invite/join-request), rather than
// inventing a second full membership vote on the receiving end.
function startAllianceVote(proposerKey, targetKey, proposerId) {
  const s = load(); if (!s.allianceVotes) s.allianceVotes = {};
  const id = `a_${Date.now()}`;
  s.allianceVotes[id] = { id, proposerKey, targetKey, proposerId, status: 'voting', votes: {}, createdAt: Date.now(), voteEndsAt: Date.now() + WAR_VOTE_MS };
  save(s); return s.allianceVotes[id];
}
function getAllianceVote(id) { return (load().allianceVotes || {})[id] || null; }
function voteOnAlliance(id, userId, choice) {
  const s = load(); const v = s.allianceVotes && s.allianceVotes[id]; if (!v || v.status !== 'voting') return null;
  v.votes[userId] = choice; save(s); return v;
}
function activeAllianceVoteFor(tribeKey) {
  return Object.values(load().allianceVotes || {}).find(v => v.status === 'voting' && v.proposerKey === tribeKey) || null;
}
function expiredAllianceVotes(nowMs) {
  return Object.values(load().allianceVotes || {}).filter(v => v.status === 'voting' && v.voteEndsAt <= nowMs);
}
function resolveAllianceVoteRecord(id, patch) {
  const s = load(); const v = s.allianceVotes && s.allianceVotes[id]; if (!v) return null;
  Object.assign(v, patch); save(s); return v;
}
function getAlly(tribeKey) { const t = get(tribeKey); return (t && t.allyKey) ? get(t.allyKey) : null; }
function setAlly(keyA, keyB) {
  const s = load();
  if (s.tribes[keyA]) s.tribes[keyA].allyKey = keyB;
  if (s.tribes[keyB]) s.tribes[keyB].allyKey = keyA;
  save(s);
}
function breakAlliance(keyA, keyB) {
  const s = load();
  if (s.tribes[keyA] && s.tribes[keyA].allyKey === keyB) delete s.tribes[keyA].allyKey;
  if (s.tribes[keyB] && s.tribes[keyB].allyKey === keyA) delete s.tribes[keyB].allyKey;
  save(s);
}

// ── Mod-tribe leadership requirement (owner, 2026-08-04: "a tribe of mods requires three leaders, it's not
// a suggestion") ──────────────────────────────────────────────────────────────────────────────────────
// A tribe FOUNDED BY MODS must keep MIN_MOD_LEADERS staff-leaders at all times. Admin-founded tribes (an
// admin can lead solo) are exempt — flagged by tribe.foundedByMod. Enforcement is an escalation ladder
// (owner picked all three tiers): a shortfall first ALERTS with a grace window, then FREEZES the tribe's
// perks (war/alliances/shop) if unfixed, then queues DISBAND. State lives on tribe.leaderEnforce so it
// survives restarts; the sweep in index.js drives the transitions and clears it instantly on recovery.
const MIN_MOD_LEADERS = 3;
// One grace window from the moment a shortfall is detected. Perks FREEZE at the HALFWAY point (owner,
// 2026-08-04) and the tribe goes disband-pending at the end if still short.
const LEADER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
function isModFounded(tribe) { return !!(tribe && tribe.foundedByMod); }
function getLeaderEnforce(key) { const t = get(key); return (t && t.leaderEnforce) || null; }
function setLeaderEnforce(key, obj) { return update(key, { leaderEnforce: obj }); }
function clearLeaderEnforce(key) { return update(key, { leaderEnforce: null }); }
// A tribe is "frozen" (perks blocked) once enforcement reaches the freeze/disband stages.
function isFrozen(tribe) { const e = tribe && tribe.leaderEnforce; return !!(e && (e.stage === 'frozen' || e.stage === 'disband_pending')); }
// Remove a tribe's record entirely (disband). Returns the removed record so the caller can clean up the
// Discord roles/channels — this only touches the framework's own state.
function removeTribe(key) { const s = load(); const rec = s.tribes && s.tribes[key]; if (!rec) return null; delete s.tribes[key]; save(s); return rec; }
// Free retheme tokens (owner, 2026-08-04: "when a tribe loses a leader they get a free retheme"). Granted
// when a tribe drops a leader, spendable on /tribe retheme even without the paid Re-theme unlock. A counter,
// so losing leaders more than once accrues more (each consumed one at a time).
function grantFreeRetheme(key) { const t = get(key); if (!t) return; update(key, { freeRethemes: (t.freeRethemes || 0) + 1 }); }
function hasFreeRetheme(tribe) { return !!(tribe && (tribe.freeRethemes || 0) > 0); }
function consumeFreeRetheme(key) { const t = get(key); if (!t || !(t.freeRethemes > 0)) return false; update(key, { freeRethemes: t.freeRethemes - 1 }); return true; }

module.exports = { load, save, all, get, getByRole, resolve, memberTribe, isMember, isLeader, leaderTribe, myTribe,
  MIN_MOD_LEADERS, LEADER_GRACE_MS, isModFounded, getLeaderEnforce, setLeaderEnforce, clearLeaderEnforce, isFrozen, removeTribe,
  grantFreeRetheme, hasFreeRetheme, consumeFreeRetheme,
  addNote, getNotes, register, update, setMotto, roster, standings, RANK_LADDER, DEFAULT_LEADER_TITLE, leaderTitle, setRankNames,
  DEFAULT_STAFF_RANK_TITLE, staffRankTitle,
  addTides, getTides, topTides, recordJoin, tenureDays, earnedRankIndex, currentRankIndex,
  markVeteran, isVeteran, setMembership, isAuthorized, STATE_FILE,
  createNomination, getNomination, updateNomination, clearNomination, createDirectInvite,
  startLeaveRequest, getLeaveRequest, clearLeaveRequest, getHubInfo, setHubInfo, getAnnounceInfo, setAnnounceInfo,
  addTreasury, getTreasury, spendTreasury, addGlory, getGlory, resetWeeklyGlory,
  dueForWeeklyCrown, markWeeklyCrownDone,
  hasUnlock, addUnlock, removeUnlock, addStrongholdTier,
  startMuster, getMuster, setMusterMessage, joinMuster, closeMuster,
  startFoundingRequest, getFoundingRequest, setFoundingMessage, cosignFounding, clearFoundingRequest,
  setEntranceGate, getEntranceGate, clearEntranceGate,
  WAR_VOTE_MS, WAR_VOTE_TURNOUT, WAR_COOLDOWN_MS, CAPTURE_LOCK_MS, WAR_TREASURY_RAID_PCT, WAR_GLORY_BONUS,
  WAR_CAPTURE_PCT, WAR_CAPTURE_CAP, WAR_CAPTURE_FLOOR,
  warPower, onWarCooldown, warCooldownEndsAt, simulateWar,
  startWarVote, getWar, voteOnWar, activeWarVoteFor, anyActiveWarInvolving, expiredWarVotes, resolveWarRecord,
  setCaptureLock, captureLockUntil, isCaptureLocked,
  startAllianceVote, getAllianceVote, voteOnAlliance, activeAllianceVoteFor, expiredAllianceVotes, resolveAllianceVoteRecord,
  getAlly, setAlly, breakAlliance };
