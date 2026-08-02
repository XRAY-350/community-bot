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

module.exports = { load, save, all, get, getByRole, resolve, memberTribe, isMember, isLeader, register, update, setMotto, roster, standings, STATE_FILE };
