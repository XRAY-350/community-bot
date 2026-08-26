// rolecat.js — the role-category manifest: which category each role belongs to, plus the category ORDER
// (top→bottom, which for Discord roles is also the permission hierarchy). Pure data layer; the live
// enforcement (keep each role inside its category band, auto-correct drift) lives in rolecatguard.js, and
// the human controls live in index.js's /role-category command + the roleCreate category-picker prompt.
//
// Seeded once from the hand-built reorder plan (role_classified.json groupings + the group order). Shape:
//   { "order": ["bot-top", "ownership", ..., "uncategorized"],   // top→bottom
//     "labels": { "ownership": "Ownership · Admin · Mod", ... },
//     "roles":  { "<roleId>": "<categoryKey>", ... } }
//
// No in-memory cache on purpose: reads are infrequent and a stale cache would clobber an external seed or a
// concurrent /role-category write (the same lesson tribes.js's cache taught us). Every op is read→modify→save.
const fs = require('fs');
const { statePath } = require('./statepath');

const FILE = process.env.FUBU_ROLECAT_FILE || statePath('role_categories.json');
const UNCATEGORIZED = 'uncategorized';   // the bottom holding bucket for unfiled/new roles

// Roles EXEMPT from the category structure entirely — dynamic/ephemeral roles the guard must never touch or
// file. The per-person day-of Birthday role positions ITSELF (just above the member's own highest role, so
// their name shows the birthday colour); the guard dragging it to the 'uncategorized' band breaks that and
// churns the bottom. Match by name so it covers every day's fresh role without a hardcoded id.
const EXEMPT_NAME_RES = [/^🎉 Birthday — /];
function isExempt(role) { const n = role && (role.name || (typeof role === 'string' ? role : '')); return !!n && EXEMPT_NAME_RES.some(re => re.test(n)); }

function load() {
  let m;
  try { m = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { m = {}; }
  m.order = m.order || [];
  m.labels = m.labels || {};
  m.roles = m.roles || {};
  return m;
}
function save(m) { try { fs.writeFileSync(FILE, JSON.stringify(m, null, 2)); } catch (e) { console.error('[rolecat] save:', e.message); } }

function isSeeded() { return load().order.length > 0; }
function order() { return load().order.slice(); }
function labelOf(key) { const m = load(); return (m.labels && m.labels[key]) || key; }
function categoryOf(roleId) { return load().roles[roleId] || null; }
// The role's category LABEL (for alerts/UI), or '' when the manifest isn't seeded / role isn't filed.
function categoryLabelFor(roleId) { const k = categoryOf(roleId); return k ? labelOf(k) : ''; }
function rolesIn(key) { const m = load(); return Object.keys(m.roles).filter(id => m.roles[id] === key); }
function counts() {
  const m = load(); const c = {};
  for (const k of m.order) c[k] = 0;
  for (const id in m.roles) c[m.roles[id]] = (c[m.roles[id]] || 0) + 1;
  return c;
}
// Assign a role to a category (create/move). Returns { ok, error }.
function setCategory(roleId, key) {
  const m = load();
  if (!m.order.includes(key)) return { ok: false, error: `Unknown category "${key}".` };
  m.roles[roleId] = key;
  save(m);
  return { ok: true };
}
function removeRole(roleId) { const m = load(); if (m.roles[roleId]) { delete m.roles[roleId]; save(m); } }

module.exports = {
  FILE, UNCATEGORIZED, load, save, isSeeded, order, labelOf, isExempt,
  categoryOf, categoryLabelFor, rolesIn, counts, setCategory, removeRole,
};
