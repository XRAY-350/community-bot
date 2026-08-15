// nestedRoles.js — tracks which (userId, roleId) role grants were purely AUTO-added by tier nesting
// (owner⊇admin⊇mod — index.js's enforceTierNesting), as opposed to independently held or genuinely earned
// through a real promotion (promote.js). A nested-only grant must not silently outlive the higher tier
// that justified it.
//
// Real incident that prompted this (2026-08-14): an owner manually granted someone Admin directly in
// Discord; enforceTierNesting auto-added Mod a third of a second later (owner⊇admin⊇mod); 21 seconds
// after that the Admin grant was undone — but the auto-added Mod role had no matching cleanup, so it sat
// on them for ~20 hours until a human happened to notice and strip it by hand.
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_NESTED_ROLES_FILE || statePath('nested_roles.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(s) { try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[nestedRoles] save:', e.message); } }

// Called by enforceTierNesting right after it auto-adds a role — marks it as nesting-only provenance.
function mark(userId, roleId) {
  const s = load();
  s[userId] = [...new Set([...(s[userId] || []), roleId])];
  save(s);
}
// Called whenever a role is confirmed as a REAL, independent grant (a genuine promotion via promote.js,
// or enforceTierNesting finding the role already held before it touched anything) — clears nesting-only
// status so a later tier drop won't strip a role the member actually earned in their own right.
function clear(userId, roleId) {
  const s = load();
  if (!s[userId]) return;
  s[userId] = s[userId].filter(id => id !== roleId);
  if (!s[userId].length) delete s[userId];
  save(s);
}
function isNested(userId, roleId) { return ((load()[userId]) || []).includes(roleId); }

module.exports = { mark, clear, isNested };
