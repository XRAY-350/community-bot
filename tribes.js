// tribes.js — the FUBU TRIBE FRAMEWORK. A "tribe" is a member-run faction: a hoisted role, a leader
// role, and (usually) a private category of channels ("their land"). This module is the single source of
// truth for which tribes exist + their metadata, and the helpers every tribe feature builds on
// (membership, leadership, roster, motto, and points for the future territory/rivalry system). All state
// lives in one JSON file so tribes survive restarts. Any tribe (Cobalt Vigil, Valith, future ones) plugs
// in the same way — this is a framework, not a one-off.
const fs = require('fs');
const { statePath } = require('./statepath');
const STATE_FILE = process.env.FUBU_TRIBES_FILE || statePath('tribes.json');

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
function getArenaInfo() { return load().arena || null; }
function setArenaInfo(channelId) { const s = load(); s.arena = { channelId }; save(s); }
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
// Is the member in ANY tribe, by ANY of its roles — base, leader, General, or a rank role? memberTribe/myTribe
// only look at base+leader, so a leader/general/ranked member who somehow lacks the base role slips through the
// "already in a tribe" join gates and can pledge a second tribe. This closes that for the loyalty model.
function inAnyTribe(member) {
  if (!member) return null;
  return all().find(t => {
    const ids = [t.roleId, t.leaderRoleId, t.staffRankRoleId, ...((t.ranks || []).map(r => r.roleId))].filter(Boolean);
    return ids.some(id => member.roles.cache.has(id));
  }) || null;
}

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
// `category` (optional) is one of PATH_CATEGORY's values ('combat'|'social'|'collective') — when it matches
// the credited member's CHOSEN evolution path, their personal path attribute scales this specific award (see
// pathAttribute below). Uncategorized calls (the vast majority — donations, staff grants, etc.) are untouched.
function addTides(key, userId, n = 1, category = null) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return 0;
  if (!t.tides) t.tides = {};
  let credited = n;
  if (category) {
    const path = memberPath(key, userId);
    if (path && PATH_CATEGORY[path] === category) {
      const mult = 1 + pathAttribute(key, userId) * BONUS_PER_ATTR_POINT;
      credited = Math.round(n * mult);
      if (!t.pathStats) t.pathStats = {};
      if (!t.pathStats[userId]) t.pathStats[userId] = { tidesOnPath: 0, bonusHits: 0 };
      t.pathStats[userId].tidesOnPath += credited;
      t.pathStats[userId].bonusHits += 1;
    }
  }
  t.tides[userId] = (t.tides[userId] || 0) + credited;
  save(s); return t.tides[userId];
}
function pathStats(key, userId) { const t = get(key); return ((t && t.pathStats) || {})[userId] || { tidesOnPath: 0, bonusHits: 0 }; }
function getTides(key, userId) { const t = get(key); return ((t && t.tides) || {})[userId] || 0; }

// ---- Prestige (Phase 7 depth): a capped-out member resets their Tides climb for a permanent honour + a lasting
// mark in the tribe's history. No fourth currency: prestige is a Tides SINK; the reward is a title (achievements)
// + a name in t.prestigeLog. Tenure is NOT reset (only Tides), so the second climb only needs the Tides again.
function getPrestige(key, userId) { const t = get(key); return ((t && t.prestige) || {})[userId] || 0; }
function resetMemberTides(key, userId) { const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return; if (!t.tides) t.tides = {}; t.tides[userId] = 0; save(s); }
function addPrestige(key, userId, nowMs) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return 0;
  if (!t.prestige) t.prestige = {};
  const lvl = (t.prestige[userId] || 0) + 1;
  t.prestige[userId] = lvl;
  if (!t.prestigeLog) t.prestigeLog = [];
  t.prestigeLog.push({ userId, level: lvl, at: nowMs || Date.now() });
  if (t.prestigeLog.length > 200) t.prestigeLog.splice(0, t.prestigeLog.length - 200);
  save(s); return lvl;
}
function prestigeLog(key) { const t = get(key); return (t && t.prestigeLog) || []; }

// Daily arena play tracking (Phase 6 daily hook): a member's FIRST scoring play each UTC day earns a bonus and
// ticks a streak; the streak resets to 1 if a day was missed. Returns { firstToday, streak }.
function recordArenaPlay(userId, nowMs) {
  const s = load(); if (!s.arenaDaily) s.arenaDaily = {};
  const now = nowMs || Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const rec = s.arenaDaily[userId] || { lastDay: null, streak: 0 };
  if (rec.lastDay === day) return { firstToday: false, streak: rec.streak };
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
  rec.streak = (rec.lastDay === yesterday) ? (rec.streak + 1) : 1;
  rec.lastDay = day; s.arenaDaily[userId] = rec; save(s);
  return { firstToday: true, streak: rec.streak };
}
function getArenaStreak(userId) { const r = (load().arenaDaily || {})[userId]; return r ? r.streak : 0; }

// "Veterans" = anyone who has EVER been in a tribe. Loyalty model: your first tribe is a free self-join,
// but once you've been in one you can't self-join again — a new tribe must accept you (request/invite).
// Marked whenever any tribe role is added (guildMemberUpdate) — permanent history, survives release.
function markVeteran(userId) { const s = load(); if (!s.veterans) s.veterans = {}; if (!s.veterans[userId]) { s.veterans[userId] = Date.now(); save(s); } }
function isVeteran(userId) { return !!(load().veterans || {})[userId]; }

// Authoritative tribe membership — the SOURCE OF TRUTH for who is legitimately in a tribe. Set ONLY by
// sanctioned flows (picker first-join / invite / request-approve / banish / reconcileTribeRoles restoring
// a rank-holder's lost base role — index.js). The guildMemberUpdate guard reverts any manual role add/strip
// that disagrees with this. Joining also stamps veteran + join-time.
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
// A tribe is in "path mode" once Edit Lore has replaced its flat 4-rank ladder with the 12-entry, pathKey-
// tagged one (see setLore below). Every tribe stays in plain flat-ladder mode — today's exact behavior —
// until its leader-or-staff opts in; nothing here changes for a tribe that hasn't touched lore/paths.
function isPathMode(tribe) { return (tribe.ranks || []).some(r => r.pathKey); }
// Highest rank index a member has EARNED (days AND tides both met). Rank 0 always qualifies — EXCEPT in path
// mode with no path chosen yet, where a member has earned nothing until they pick one (returns -1).
function earnedRankIndex(tribe, userId) {
  const ranks = tribe.ranks || []; const days = tenureDays(tribe, userId); const tides = (tribe.tides || {})[userId] || 0;
  if (!isPathMode(tribe)) {
    let idx = 0;
    for (let i = 0; i < ranks.length; i++) if (days >= (ranks[i].days || 0) && tides >= (ranks[i].tides || 0)) idx = i;
    return idx;
  }
  const path = memberPath(tribe.key, userId);
  if (!path) return -1;
  let idx = -1;
  ranks.forEach((r, i) => { if (r.pathKey === path && days >= (r.days || 0) && tides >= (r.tides || 0)) idx = i; });
  return idx;
}
// The rank index a member CURRENTLY holds (by which rank role they have), or -1 if none. Path mode only
// looks at the member's own chosen path's 4 role slots — the other 8 don't apply to them.
function currentRankIndex(member, tribe) {
  const ranks = tribe.ranks || [];
  const path = isPathMode(tribe) ? memberPath(tribe.key, member.id) : null;
  if (isPathMode(tribe) && !path) return -1;
  for (let i = ranks.length - 1; i >= 0; i--) {
    if (path && ranks[i].pathKey !== path) continue;
    if (ranks[i].roleId && member.roles.cache.has(ranks[i].roleId)) return i;
  }
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

// ---- Tribe Lore + Evolution Paths (Phase 8: owner, 2026-08-10 — "I don't want it to just be cosmetic") ----
// Every tribe gets exactly 3 mechanical path SLOTS (path0/path1/path2), each mapped to a fixed activity
// category so the bonus-hook code in index.js never needs to know a tribe's own path NAMES, only its slot.
// A tribe's tribe.ranks array grows from the flat 4-rank RANK_LADDER to 12 entries (3 paths x 4 ranks),
// each tagged with pathKey — see isPathMode() above for how the rank functions detect + branch on this.
const PATH_SLOTS = ['path0', 'path1', 'path2'];
const PATH_CATEGORY = { path0: 'combat', path1: 'social', path2: 'collective' };
const ATTR_BASE = 1, ATTR_PER_RANK = 2;          // rank 0 -> attribute 1, rank 3 (maxed) -> attribute 7
const BONUS_PER_ATTR_POINT = 0.05;               // attribute 1 -> +5%, attribute 7 -> +35%
// ---- Tribe-pair relations (Phase 8b, owner correction 2026-08-10: "not elements at all... I'll feed you
// the lore when it's created and you determine the attribute and its relation to others") — deliberately
// NOT a category/formula system. Each pairwise relation is a CURATED judgment call (owner + Claude read a
// tribe's actual lore against tribes already known and decide synergy/clash/neutral), stored once decided.
// Unset pairs default to 'neutral' (no effect) — so nothing changes for any tribe until its relations are
// actually curated, there's no automatic blanket bonus for merely having lore.
const RELATION_MULT = { synergy: 1.3, clash: 0.7, neutral: 1.0 };
function relKey(a, b) { return [a, b].sort().join('|'); }
function setRelation(keyA, keyB, relation) {
  const s = load(); if (!s.relations) s.relations = {};
  if (!RELATION_MULT[relation] || relation === 'neutral') delete s.relations[relKey(keyA, keyB)];
  else s.relations[relKey(keyA, keyB)] = relation;
  save(s); return relation;
}
function getRelation(keyA, keyB) { return (load().relations || {})[relKey(keyA, keyB)] || 'neutral'; }
function allRelations() { return load().relations || {}; }

// NOTE for future editors: index.js already has `const lore = require('./lore')` (the separate append-only
// world-chronicle module) — this `tribe.lore` object is just a field on a tribe record and doesn't collide
// in JS terms, but never destructure a bare `lore` local out of a tribe object; it would shadow that import.
function setLore(key, { title, myth, pathNames, attributeNames, rankTitles }) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return null;
  t.lore = {
    title: String(title || '').slice(0, 100),
    myth: String(myth || '').slice(0, 4000),
    pathNames: PATH_SLOTS.map((_, i) => (pathNames && pathNames[i] && String(pathNames[i]).trim().slice(0, 40)) || `Path ${i + 1}`),
    attributeNames: PATH_SLOTS.map((_, i) => (attributeNames && attributeNames[i] && String(attributeNames[i]).trim().slice(0, 40)) || 'Attribute'),
  };
  // Rebuild tribe.ranks as the 12-entry path-tagged ladder. roleId is preserved when a matching rank already
  // exists (re-editing lore shouldn't orphan already-created Discord roles); index.js's Edit-Lore handler is
  // responsible for actually creating any still-missing roles afterward (it has the live guild, this doesn't).
  const titles = (rankTitles || []).slice(0, 12);
  const oldByKey = new Map((t.ranks || []).map(r => [r.key, r]));
  const newRanks = [];
  PATH_SLOTS.forEach((pathKey, pi) => {
    RANK_LADDER.forEach((base, ri) => {
      const idx = pi * 4 + ri;
      const rkey = `${pathKey}_${base.key}`;
      const existing = oldByKey.get(rkey);
      newRanks.push({
        key: rkey, pathKey,
        name: (titles[idx] && String(titles[idx]).trim().slice(0, 40)) || base.name,
        days: base.days, tides: base.tides,
        roleId: existing ? existing.roleId : null,
      });
    });
  });
  t.ranks = newRanks;
  save(s); return t.lore;
}
function getLore(key) { return (get(key) || {}).lore || null; }

function memberPath(key, userId) { const t = get(key); return (t && t.memberPaths && t.memberPaths[userId] && t.memberPaths[userId].path) || null; }
// Switching paths starts the NEW path at rank 0 — no progress carries over (owner's call). The member simply
// stops holding any old-path rank role next time maybePromoteTribeRank/applyTribeRank run in index.js, since
// currentRankIndex/earnedRankIndex now only look at the new path's 4 slots.
function setMemberPath(key, userId, pathSlot) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t || !PATH_SLOTS.includes(pathSlot)) return null;
  if (!t.memberPaths) t.memberPaths = {};
  t.memberPaths[userId] = { path: pathSlot, since: Date.now() };
  save(s); return t.memberPaths[userId];
}
// A member's personal attribute value for their chosen path — grows with THEIR rank within that path, not a
// flat per-tribe number. 0 if they haven't picked a path (or haven't earned that path's rank 0 yet, which
// shouldn't normally happen since rank 0's thresholds are always met once a path is picked).
function pathAttribute(key, userId) {
  const t = get(key); if (!t) return 0;
  const path = memberPath(key, userId); if (!path) return 0;
  const idx = earnedRankIndex(t, userId); if (idx < 0) return 0;
  const withinPath = idx - PATH_SLOTS.indexOf(path) * 4;
  return withinPath < 0 ? 0 : ATTR_BASE + withinPath * ATTR_PER_RANK;
}
// Tribe-wide compile-up (owner, 2026-08-12: "path attributes... compile into" tribe-level effects) — sums
// every member's OWN pathAttribute across everyone currently on this tribe's category-matching path. Not a
// separate tribe-level stat; it's purely derived from current roster + rank composition, so it moves as
// members join/leave/rank up. Grows the tribe's actual disposition/event-earning power in that category —
// used by warPower (combat) and the Arena/Sealed Arena/Tribe Games reward bonus (index.js).
function tribeAttributePower(key, category) {
  const t = get(key); if (!t) return 0;
  let power = 0;
  for (const userId of Object.keys(t.members || {})) {
    const path = memberPath(key, userId);
    if (path && PATH_CATEGORY[path] === category) power += pathAttribute(key, userId);
  }
  return power;
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
    s.tribes[winner.key].seasonCrowns = (s.tribes[winner.key].seasonCrowns || 0) + 1;   // counts toward the Season Champion
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
// The weekly Chronicle chapter (Phase 7) runs once per week, on the same boundary but AFTER the crown so it
// captures it. Separate marker so it's independent of the crown's.
function dueForChronicle(nowMs) { const s = load(); return !s.lastChronicleWeek || s.lastChronicleWeek < weekStartMs(nowMs); }
function markChronicleDone(nowMs) { const s = load(); s.lastChronicleWeek = weekStartMs(nowMs); save(s); }
// Daily marker for the Propaganda forum's reaction sweep (Phase 8) — same shape as the weekly crown/chronicle
// markers above, just UTC-day-boundary instead of UTC-week-boundary.
function dayStartMs(nowMs) { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0); }
function dueForPropagandaDay(nowMs) { const s = load(); return !s.lastPropagandaDay || s.lastPropagandaDay < dayStartMs(nowMs); }
function markPropagandaDayDone(nowMs) { const s = load(); s.lastPropagandaDay = dayStartMs(nowMs); save(s); }

// ---- Seasons (owner build-out: the long-term competitive container ON TOP of the weekly crown). A season
// spans several weeks; every weekly Crown also banks a "season crown" (see resetWeeklyGlory). At season end
// the tribe with the most season crowns is the Season Champion (permanent hall-of-fame + a rotating role),
// then season crowns soft-reset and a fresh season opens. Treasury, Tides, shop unlocks, and lifetime
// crownsWon all PERSIST — only the season race resets, so the competition re-opens without erasing progress.
const SEASON_LEN_MS = 6 * 7 * 24 * 60 * 60 * 1000;   // 6 weeks (tunable)
// Each Season is a named AGE (Phase 7, owner: "each 6-week season becomes a named Age"). Names are generated
// from a template bank (no external dependency), so the Hall of Fame reads like a history book.
const AGE_NOUNS = ['Embers', 'Ash', 'Iron', 'Storms', 'Tides', 'Crowns', 'Ravens', 'Wolves', 'Frost', 'Dawn',
  'Ruin', 'Thorns', 'Serpents', 'Dragons', 'Blades', 'Echoes', 'Shadows', 'Gold', 'Flame', 'Stone', 'Roots',
  'Stars', 'the Long Night', 'the Broken Crown', 'the Red Sun', 'Kings', 'Wanderers', 'Oaths', 'Vultures',
  'Lions', 'the Deep', 'the Ninth Wave', 'Sails', 'the Quiet War', 'Hollow Crowns', 'the Gathering Storm'];
function makeAgeName() { return `The Age of ${AGE_NOUNS[Math.floor(Math.random() * AGE_NOUNS.length)]}`; }
function ensureSeason(nowMs) {
  const s = load(); const now = nowMs || Date.now();
  if (!s.season) { s.season = { number: 1, name: makeAgeName(), startedAt: now, endsAt: now + SEASON_LEN_MS }; save(s); }
  else if (!s.season.name) { s.season.name = makeAgeName(); save(s); }   // backfill the pre-Phase-7 season
  return s.season;
}
function getSeason() { return load().season || null; }
function addSeasonCrown(key) { const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return 0; t.seasonCrowns = (t.seasonCrowns || 0) + 1; save(s); return t.seasonCrowns; }
function seasonStandings(guild) {
  return all().map(t => ({ ...t, seasonCrowns: t.seasonCrowns || 0, memberCount: guild.roles.cache.get(t.roleId)?.members.size ?? 0 }))
    .sort((a, b) => b.seasonCrowns - a.seasonCrowns || (b.treasury || 0) - (a.treasury || 0) || b.memberCount - a.memberCount);
}
function dueForSeasonEnd(nowMs) { const s = load(); return !!s.season && (nowMs || Date.now()) >= s.season.endsAt; }
function seasonHistory() { return load().seasonHistory || []; }
function currentChampionKey() { const h = load().seasonHistory || []; return h.length ? h[h.length - 1].championKey : null; }
// End the current season: crown the champion (most season crowns; tie-break treasury, members), record it in
// the hall of fame, zero every tribe's season crowns, and open the next season. Returns
// { previousNumber, champion: {key,name,crowns}|null, season }.
function endSeasonAndRotate(guild, nowMs) {
  const s = load(); const now = nowMs || Date.now();
  const cur = s.season || { number: 1, startedAt: now - SEASON_LEN_MS, endsAt: now };
  const board = Object.values(s.tribes || {}).map(t => ({ key: t.key, name: t.shortName || t.name, crowns: t.seasonCrowns || 0, treasury: t.treasury || 0, memberCount: guild.roles.cache.get(t.roleId)?.members.size ?? 0 }))
    .sort((a, b) => b.crowns - a.crowns || b.treasury - a.treasury || b.memberCount - a.memberCount);
  const top = board[0];
  const champion = (top && top.crowns > 0) ? { key: top.key, name: top.name, crowns: top.crowns } : null;
  if (!s.seasonHistory) s.seasonHistory = [];
  s.seasonHistory.push({ number: cur.number, name: cur.name || null, championKey: champion ? champion.key : null, championName: champion ? champion.name : null, crowns: champion ? champion.crowns : 0, endedAt: now });
  for (const t of Object.values(s.tribes || {})) t.seasonCrowns = 0;
  s.season = { number: cur.number + 1, name: makeAgeName(), startedAt: now, endsAt: now + SEASON_LEN_MS };
  save(s);
  return { previousNumber: cur.number, previousName: cur.name || `Age ${cur.number}`, champion, season: s.season };
}

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

// A leader-initiated disband needs EVERY current leader to agree before it goes through (owner, 2026-08-17:
// "If a leader does the command/button each leader must agree with it before it goes through"). The owner/
// bot-owner may disband any tribe directly, no agreement needed — that gate lives in index.js, not here.
// Keyed by tribe key (one pending request per tribe); the initiator counts as already agreed.
function startDisbandRequest(key, initiatorId) {
  const s = load(); if (!s.disbandRequests) s.disbandRequests = {};
  s.disbandRequests[key] = { initiatorId, agreed: [initiatorId], createdAt: Date.now() };
  save(s); return s.disbandRequests[key];
}
function getDisbandRequest(key) { return (load().disbandRequests || {})[key] || null; }
function setDisbandMessage(key, channelId, messageId) {
  const s = load(); const r = s.disbandRequests && s.disbandRequests[key]; if (!r) return;
  r.channelId = channelId; r.messageId = messageId; save(s);
}
// Returns the updated request, or null if this leader already agreed (no-op) or there's no pending request.
function agreeToDisband(key, userId) {
  const s = load(); const r = s.disbandRequests && s.disbandRequests[key]; if (!r) return null;
  if (r.agreed.includes(userId)) return null;
  r.agreed.push(userId); save(s); return r;
}
function clearDisbandRequest(key) { const s = load(); if (s.disbandRequests) delete s.disbandRequests[key]; save(s); }

// ---- Member-founded tribe (owner 2026-08-05): ONE regular member may found ONE tribe, backed by 9 cosigns
// from members (or trial mods) — no mod/admin/owner. Only one such petition, and one such tribe, at a time
// server-wide. Kept in its OWN state (single object, not keyed by founder) so it never touches the mod path.
const MEMBER_FOUND_COSIGNS = 9;                        // cosigns needed on top of the founder (10 founders total)
const MEMBER_FOUND_EXPIRY_MS = 48 * 60 * 60 * 1000;    // petition lapses if it doesn't reach 9 in 48h
function getMemberFounding() { return load().memberFounding || null; }
function getMemberFoundedTribeKey() { return load().memberFoundedTribeKey || null; }
// Returns the new request, or null if one is already open / a member-founded tribe already exists (one-at-a-time).
function startMemberFounding(founderId, identity) {
  const s = load();
  if (s.memberFounding || s.memberFoundedTribeKey) return null;
  s.memberFounding = { founderId, identity, cosigns: [], createdAt: Date.now() };
  save(s); return s.memberFounding;
}
// Returns the updated request, or null if no request / founder tried to self-sign / already signed.
function cosignMemberFounding(cosignerId) {
  const s = load(); const r = s.memberFounding; if (!r) return null;
  if (cosignerId === r.founderId || r.cosigns.includes(cosignerId)) return null;
  r.cosigns.push(cosignerId); save(s); return r;
}
function setMemberFoundingMessage(channelId, messageId) { const s = load(); if (s.memberFounding) { s.memberFounding.channelId = channelId; s.memberFounding.messageId = messageId; save(s); } }
function clearMemberFounding() { const s = load(); delete s.memberFounding; save(s); }
// On successful founding: record the live slot AND clear the pending petition, atomically.
function setMemberFoundedTribe(key) { const s = load(); s.memberFoundedTribeKey = key; delete s.memberFounding; save(s); }

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
const WAR_VOTE_MS = 6 * 60 * 60 * 1000;           // 6h vote window (also used for alliance votes) — kept short so wars don't drag
const WAR_VOTE_TURNOUT = 0.30;                    // ≥30% of current members must vote
const WAR_COOLDOWN_MS = 24 * 60 * 60 * 1000;      // 24h before either side can war again
const CAPTURE_LOCK_MS = 48 * 60 * 60 * 1000;       // 48h — captured members can't leave (any path) until this passes (independent of the cooldown)
const WAR_TREASURY_RAID_PCT = 0.25;               // winner takes 25% of loser's treasury
const WAR_GLORY_BONUS = 100;                       // flat, not stolen — Glory is a weekly flow, not a stock to raid
const WAR_CAPTURE_PCT = 0.10;                      // winner captures ~10% of loser's regular members
const WAR_CAPTURE_CAP = 5;                         // ...capped at 5 regardless of loser's size
const WAR_CAPTURE_FLOOR = 3;                       // ...and never below this many members left in the loser
// Stronghold = war DEFENSE (owner: "stronghold means nothing but it can be a defense against war"). Walls
// only help the DEFENDER: they boost defensive power, and if the defender still loses, they blunt the sack.
const STRONGHOLD_DEF_PER_TIER = 0.10;             // +10% defensive war power per Stronghold Tier (defender only)
const STRONGHOLD_RAID_REDUCE_PER_TIER = 0.05;     // each tier shaves 5 pts off the treasury-raid % if the defender loses
const WAR_RAID_MIN_PCT = 0.10;                     // ...but a successful raid always takes at least 10%

// ---- Relics (Phase 7 depth): permanent trophy + a tiny, stacking, capped, cross-Age-DECAYING war-power edge.
// Minted to the Age Champion at Age end; raidable in wars. The decay is what keeps a dynasty from running away:
// a fresh relic is worth +3% war power the Age it's won and halves every Age after, so old glory fades.
const RELIC_BASE_PERK = 0.03;      // a relic won THIS Age adds +3% war power
const RELIC_DECAY = 0.5;           // ...halving each Age that passes (fades toward nothing)
const RELIC_PERK_CAP = 0.10;       // total relic war-power bonus is capped at +10% (no runaway)
const RELIC_ADJ = ['Ember', 'Tide', 'Ashen', 'Iron', 'Storm', 'Bone', 'Gilded', 'Obsidian', 'Crimson', 'Frost', 'Thorn', 'Dusk'];
const RELIC_NOUN = ['Crown', 'Chalice', 'Banner', 'Blade', 'Sigil', 'Horn', 'Cinder', 'Reliquary', 'Standard', 'Idol', 'Fang', 'Lantern'];
function makeRelicName(seed) { return `The ${RELIC_ADJ[seed % RELIC_ADJ.length]} ${RELIC_NOUN[(seed * 7 + 3) % RELIC_NOUN.length]}`; }
function relicsOf(key) { const t = get(key); return (t && t.relics) || []; }
function mintRelic(key, { age, ageName } = {}) {
  const s = load(); const t = s.tribes && s.tribes[key]; if (!t) return null;
  if (!t.relics) t.relics = [];
  const relic = { id: `relic_${age || 0}_${t.relics.length}`, name: makeRelicName((age || 0) * 13 + t.relics.length), age: age || 0, ageName: ageName || `Age ${age || 0}`, mintedAt: Date.now() };
  t.relics.push(relic); save(s); return relic;
}
// The current tiny/capped/decaying war-power bonus from a tribe's relics. currentAge defaults to the live season.
function relicPerk(key, currentAge) {
  const relics = relicsOf(key);
  if (!relics.length) return 0;
  const age = currentAge != null ? currentAge : (getSeason() ? getSeason().number : 0);
  let sum = 0;
  for (const r of relics) sum += RELIC_BASE_PERK * Math.pow(RELIC_DECAY, Math.max(0, age - (r.age || 0)));
  return Math.min(sum, RELIC_PERK_CAP);
}
// War raid: the winner seizes the loser's NEWEST relic (its strongest). Trophy + lore carry to the winner.
function stealRelic(fromKey, toKey) {
  const s = load(); const from = s.tribes && s.tribes[fromKey], to = s.tribes && s.tribes[toKey];
  if (!from || !to || !(from.relics && from.relics.length)) return null;
  const relic = from.relics.pop();
  if (!to.relics) to.relics = [];
  relic.raidedFrom = fromKey; relic.raidedAt = Date.now();
  to.relics.push(relic); save(s); return relic;
}

// Tides-based combat power: everyone (including leaders/staff, who earn Tides same as anyone) contributes
// at least 1 (bare presence) plus their real accumulated Tides. Needs `guild` to enumerate live role holders.
// Relics (if any) add a small, capped, decaying multiplier on top.
const WAR_ATTR_SCALE = 0.01, WAR_ATTR_CAP = 0.5;   // combat tribeAttributePower of 50 -> +50% (capped), tunable
function warPower(guild, tribe) {
  const role = guild.roles.cache.get(tribe.roleId);
  if (!role) return 0;
  let power = 0;
  for (const m of role.members.values()) power += 1 + getTides(tribe.key, m.id);
  const combatMult = 1 + Math.min(tribeAttributePower(tribe.key, 'combat') * WAR_ATTR_SCALE, WAR_ATTR_CAP);
  return power * (1 + relicPerk(tribe.key)) * combatMult;
}
function onWarCooldown(tribe, nowMs = Date.now()) { return !!tribe.lastWarAt && (nowMs - tribe.lastWarAt) < WAR_COOLDOWN_MS; }
function warCooldownEndsAt(tribe) { return (tribe.lastWarAt || 0) + WAR_COOLDOWN_MS; }
// Separate inbound/outbound war cooldowns (owner 2026-08-05): a tribe's cooldown on ATTACKING is independent of
// its cooldown on BEING attacked. Falls back to the legacy single lastWarAt so existing cooldowns carry over.
function onOutboundCooldown(tribe, nowMs = Date.now()) { const t = tribe.lastOutboundWarAt || tribe.lastWarAt; return !!t && (nowMs - t) < WAR_COOLDOWN_MS; }
function outboundCooldownEndsAt(tribe) { return (tribe.lastOutboundWarAt || tribe.lastWarAt || 0) + WAR_COOLDOWN_MS; }
function onInboundCooldown(tribe, nowMs = Date.now()) { const t = tribe.lastInboundWarAt || tribe.lastWarAt; return !!t && (nowMs - t) < WAR_COOLDOWN_MS; }
function inboundCooldownEndsAt(tribe) { return (tribe.lastInboundWarAt || tribe.lastWarAt || 0) + WAR_COOLDOWN_MS; }

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
// One outbound (as attacker) AND one inbound (as defender) war allowed concurrently (owner 2026-08-05). "Active"
// = still resolving: a vote in flight OR a passed vote awaiting the defender's consent.
function activeOutboundWar(tribeKey) { return Object.values(load().wars || {}).find(w => (w.status === 'voting' || w.status === 'awaiting_target') && w.attackerKey === tribeKey) || null; }
function activeInboundWar(tribeKey) { return Object.values(load().wars || {}).find(w => (w.status === 'voting' || w.status === 'awaiting_target') && w.defenderKey === tribeKey) || null; }
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
  // A curated tribe-pair relation (see setRelation/getRelation above) scales the ally's contributed power —
  // a synergy alliance fights harder, a clash alliance (allied on paper but thematically opposed) actually
  // fights WORSE together. Unrated pairs are neutral (1.0x, no change from before curation happens).
  const allyPower = t => { const ally = allyOf(t); if (!ally) return 0; return warPower(guild, ally) * RELATION_MULT[getRelation(t.key, ally.key)]; };
  // Stronghold walls multiply the DEFENDER's total defensive power (attackers can't carry walls into a fight).
  const wall = 1 + STRONGHOLD_DEF_PER_TIER * (defender.strongholdTier || 0);
  const powerA = warPower(guild, attacker) + allyPower(attacker);
  const powerB = (warPower(guild, defender) + allyPower(defender)) * wall;
  const attackerWinChance = powerA / (powerA + powerB || 1);
  const attackerWins = Math.random() < attackerWinChance;
  const winner = attackerWins ? attacker : defender;
  const loser = attackerWins ? defender : attacker;
  const loserRole = guild.roles.cache.get(loser.roleId);
  const loserMembers = loserRole ? [...loserRole.members.values()].filter(m => !isLeader(m, loser)) : [];
  // Walls blunt the sack only when the DEFENDER lost (they defended and still fell): fewer captured, smaller raid.
  const defWallTiers = (loser.key === defender.key) ? (defender.strongholdTier || 0) : 0;
  const captureReduce = Math.floor(defWallTiers / 2);   // -1 captured per 2 tiers
  const maxCapturable = Math.max(0, loserMembers.length - WAR_CAPTURE_FLOOR);
  const captureCount = Math.max(0, Math.min(WAR_CAPTURE_CAP, maxCapturable, Math.floor(loserMembers.length * WAR_CAPTURE_PCT)) - captureReduce);
  const shuffled = [...loserMembers].sort(() => Math.random() - 0.5);
  const capturedIds = shuffled.slice(0, captureCount).map(m => m.id);
  const raidPct = Math.max(WAR_RAID_MIN_PCT, WAR_TREASURY_RAID_PCT - STRONGHOLD_RAID_REDUCE_PER_TIER * defWallTiers);
  const raidAmount = Math.floor((loser.treasury || 0) * raidPct);
  return { winnerKey: winner.key, loserKey: loser.key, powerA, powerB, attackerWinChance, raidAmount, capturedIds, defWallTiers, raidPct };
}

// Spectacle war (owner: "I want it to be grand, like a Madden quicksim"). Instead of a single roll, the war is
// a best-of-(2*WAR_WIN_ROUNDS-1) series of power-weighted skirmishes, so it produces momentum swings + comebacks
// that index.js narrates live. Same strength model (Tides power + stronghold wall) and same spoils as
// simulateWar. Returns the round-by-round data plus everything executeWar needs.
const WAR_WIN_ROUNDS = 4;   // first tribe to this many skirmish wins takes the war (best-of-7)
function simulateWarMatch(guild, attacker, defender) {
  const allyOf = t => (t.allyKey && get(t.allyKey)) || null;
  const allyPower = t => { const ally = allyOf(t); if (!ally) return 0; return warPower(guild, ally) * RELATION_MULT[getRelation(t.key, ally.key)]; };
  const wall = 1 + STRONGHOLD_DEF_PER_TIER * (defender.strongholdTier || 0);
  const powerA = warPower(guild, attacker) + allyPower(attacker);
  const powerB = (warPower(guild, defender) + allyPower(defender)) * wall;
  const pA = powerA / (powerA + powerB || 1);
  const rosterOf = t => { const r = guild.roles.cache.get(t.roleId); return r ? [...r.members.values()].map(m => m.id) : []; };
  const aRoster = rosterOf(attacker), dRoster = rosterOf(defender);
  const pick = arr => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
  const rounds = []; let sA = 0, sD = 0, prevLeader = 0;
  while (sA < WAR_WIN_ROUNDS && sD < WAR_WIN_ROUNDS) {
    const attackerWins = Math.random() < pA;
    if (attackerWins) sA++; else sD++;
    const lead = sA > sD ? 1 : sD > sA ? -1 : 0;
    const leadChange = lead !== 0 && prevLeader !== 0 && lead !== prevLeader;
    if (lead !== 0) prevLeader = lead;
    rounds.push({ side: attackerWins ? 'attacker' : 'defender', starId: pick(attackerWins ? aRoster : dRoster), sA, sD, leadChange });
  }
  const attackerWon = sA >= WAR_WIN_ROUNDS;
  const winner = attackerWon ? attacker : defender, loser = attackerWon ? defender : attacker;
  const loserRole = guild.roles.cache.get(loser.roleId);
  const loserMembers = loserRole ? [...loserRole.members.values()].filter(m => !isLeader(m, loser)) : [];
  const defWallTiers = (loser.key === defender.key) ? (defender.strongholdTier || 0) : 0;
  const captureReduce = Math.floor(defWallTiers / 2);
  const maxCapturable = Math.max(0, loserMembers.length - WAR_CAPTURE_FLOOR);
  const captureCount = Math.max(0, Math.min(WAR_CAPTURE_CAP, maxCapturable, Math.floor(loserMembers.length * WAR_CAPTURE_PCT)) - captureReduce);
  const capturedIds = [...loserMembers].sort(() => Math.random() - 0.5).slice(0, captureCount).map(m => m.id);
  const raidPct = Math.max(WAR_RAID_MIN_PCT, WAR_TREASURY_RAID_PCT - STRONGHOLD_RAID_REDUCE_PER_TIER * defWallTiers);
  const raidAmount = Math.floor((loser.treasury || 0) * raidPct);
  return { winnerKey: winner.key, loserKey: loser.key, rounds, scoreA: sA, scoreD: sD, powerA, powerB, attackerWinChance: pA, raidAmount, capturedIds, defWallTiers, raidPct };
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
// Configurable per-deployment (owner, 2026-08-17: Melanin already lets a mod found a tribe solo — see
// config.modFoundingCosignsRequired — so requiring 3 leaders to KEEP it standing afterward made a
// solo-founded tribe start the freeze/disband countdown immediately. FUBU keeps the original 3; Melanin's
// env overrides this down to 1 (just the founder) to match its own founding rule.
const MIN_MOD_LEADERS = Number(process.env.MIN_MOD_LEADERS) || 3;
// One grace window from the moment a shortfall is detected. Perks FREEZE at the HALFWAY point (owner,
// 2026-08-04) and the tribe goes disband-pending at the end if still short.
const LEADER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
function isModFounded(tribe) { return !!(tribe && tribe.foundedByMod); }
// Member-founded tribe: led by regular-member co-leaders (the founder + cosigners), so it's EXEMPT from the
// "a tribe leader must be a mod/admin" sweep AND the mod-leader-count requirement.
function isMemberFounded(tribe) { return !!(tribe && tribe.foundedByMember); }
function getLeaderEnforce(key) { const t = get(key); return (t && t.leaderEnforce) || null; }
function setLeaderEnforce(key, obj) { return update(key, { leaderEnforce: obj }); }
function clearLeaderEnforce(key) { return update(key, { leaderEnforce: null }); }
// A tribe is "frozen" (perks blocked) once enforcement reaches the freeze/disband stages.
function isFrozen(tribe) { const e = tribe && tribe.leaderEnforce; return !!(e && (e.stage === 'frozen' || e.stage === 'disband_pending')); }
// Remove a tribe's record entirely (disband). Returns the removed record so the caller can clean up the
// Discord roles/channels — this only touches the framework's own state.
function removeTribe(key) { const s = load(); const rec = s.tribes && s.tribes[key]; if (!rec) return null; delete s.tribes[key]; if (s.memberFoundedTribeKey === key) delete s.memberFoundedTribeKey; save(s); return rec; }
// Free retheme tokens (owner, 2026-08-04: "when a tribe loses a leader they get a free retheme"). Granted
// when a tribe drops a leader, spendable on /tribe retheme even without the paid Re-theme unlock. A counter,
// so losing leaders more than once accrues more (each consumed one at a time).
function grantFreeRetheme(key) { const t = get(key); if (!t) return; update(key, { freeRethemes: (t.freeRethemes || 0) + 1 }); }
function hasFreeRetheme(tribe) { return !!(tribe && (tribe.freeRethemes || 0) > 0); }
function consumeFreeRetheme(key) { const t = get(key); if (!t || !(t.freeRethemes > 0)) return false; update(key, { freeRethemes: t.freeRethemes - 1 }); return true; }

module.exports = { load, save, all, get, getByRole, resolve, memberTribe, inAnyTribe, isMember, isLeader, leaderTribe, myTribe,
  MIN_MOD_LEADERS, LEADER_GRACE_MS, isModFounded, isMemberFounded, getLeaderEnforce, setLeaderEnforce, clearLeaderEnforce, isFrozen, removeTribe,
  grantFreeRetheme, hasFreeRetheme, consumeFreeRetheme,
  addNote, getNotes, register, update, setMotto, roster, standings, RANK_LADDER, DEFAULT_LEADER_TITLE, leaderTitle, setRankNames,
  DEFAULT_STAFF_RANK_TITLE, staffRankTitle,
  addTides, getTides, topTides, recordJoin, tenureDays, earnedRankIndex, currentRankIndex, isPathMode,
  setLore, getLore, memberPath, setMemberPath, pathAttribute, pathStats, tribeAttributePower,
  PATH_SLOTS, PATH_CATEGORY, ATTR_BASE, ATTR_PER_RANK, BONUS_PER_ATTR_POINT, WAR_ATTR_SCALE, WAR_ATTR_CAP,
  setRelation, getRelation, allRelations, RELATION_MULT,
  getPrestige, resetMemberTides, addPrestige, prestigeLog,
  markVeteran, isVeteran, setMembership, isAuthorized, STATE_FILE,
  createNomination, getNomination, updateNomination, clearNomination, createDirectInvite,
  startLeaveRequest, getLeaveRequest, clearLeaveRequest, getHubInfo, setHubInfo, getAnnounceInfo, setAnnounceInfo, getArenaInfo, setArenaInfo,
  addTreasury, getTreasury, spendTreasury, addGlory, getGlory, resetWeeklyGlory,
  dueForWeeklyCrown, markWeeklyCrownDone, dueForChronicle, markChronicleDone, weekStartMs,
  dueForPropagandaDay, markPropagandaDayDone,
  SEASON_LEN_MS, ensureSeason, getSeason, addSeasonCrown, seasonStandings, dueForSeasonEnd, seasonHistory, currentChampionKey, endSeasonAndRotate,
  recordArenaPlay, getArenaStreak,
  hasUnlock, addUnlock, removeUnlock, addStrongholdTier,
  startMuster, getMuster, setMusterMessage, joinMuster, closeMuster,
  startFoundingRequest, getFoundingRequest, setFoundingMessage, cosignFounding, clearFoundingRequest,
  startDisbandRequest, getDisbandRequest, setDisbandMessage, agreeToDisband, clearDisbandRequest,
  MEMBER_FOUND_COSIGNS, MEMBER_FOUND_EXPIRY_MS, getMemberFounding, getMemberFoundedTribeKey, startMemberFounding,
  cosignMemberFounding, setMemberFoundingMessage, clearMemberFounding, setMemberFoundedTribe,
  setEntranceGate, getEntranceGate, clearEntranceGate,
  WAR_VOTE_MS, WAR_VOTE_TURNOUT, WAR_COOLDOWN_MS, CAPTURE_LOCK_MS, WAR_TREASURY_RAID_PCT, WAR_GLORY_BONUS,
  WAR_CAPTURE_PCT, WAR_CAPTURE_CAP, WAR_CAPTURE_FLOOR,
  warPower, onWarCooldown, warCooldownEndsAt, onOutboundCooldown, outboundCooldownEndsAt, onInboundCooldown, inboundCooldownEndsAt,
  activeOutboundWar, activeInboundWar, simulateWar, simulateWarMatch, WAR_WIN_ROUNDS,
  relicsOf, mintRelic, relicPerk, stealRelic, RELIC_PERK_CAP,
  startWarVote, getWar, voteOnWar, activeWarVoteFor, anyActiveWarInvolving, expiredWarVotes, resolveWarRecord,
  setCaptureLock, captureLockUntil, isCaptureLocked,
  startAllianceVote, getAllianceVote, voteOnAlliance, activeAllianceVoteFor, expiredAllianceVotes, resolveAllianceVoteRecord,
  getAlly, setAlly, breakAlliance };
