// overridesManager.js — Persistent Personal Corner Overrides Manager
const fs = require('fs');
const { statePath } = require('./statepath');

const OVERRIDES_FILE = process.env.FUBU_CORNER_OVERRIDES_FILE || statePath('personal_overrides.json');

const DEFAULT_OVERRIDES = [
  {
    id: 'ov_knylvr_exclusive',
    actors: [{ type: 'user', id: '865843812907089940' }],
    hitSquadExempt: false,
    targetType: 'user',
    targetId: '1211024269149081620',
    type: 'EXCLUSIVE_CORNERER',
    note: 'Only server owner can corner knylvr'
  },
  {
    id: 'ov_knylvr_ownerpower',
    actorType: 'user',
    actorId: '1211024269149081620',
    targetType: '*',
    targetId: '*',
    type: 'GRANT_POWER',
    powerTier: 'owner',
    note: 'Knylvr owner-level cornering authority'
  },
  {
    id: 'ov_approved_1',
    actorType: 'user',
    actorId: '1415112053823242250',
    targetType: 'user',
    targetId: '989615671178575972',
    type: 'BYPASS_TIER',
    note: 'Approved actor -> target bypass'
  },
  {
    id: 'ov_approved_2',
    actorType: 'user',
    actorId: '593371777569390602',
    targetType: 'user',
    targetId: '989615671178575972',
    type: 'BYPASS_TIER',
    note: 'Second approved actor -> target bypass'
  },
  {
    id: 'ov_owner_optin',
    actorType: '*',
    actorId: '*',
    targetType: 'user',
    targetId: '865843812907089940',
    type: 'BYPASS_TIER',
    minActorTier: 'admin',   // owner, 2026-08-17: "change the everyone corner to only staff (mod+)", then
                              // 2026-08-18: "should be admin/owner" — a plain mod no longer qualifies
    note: 'Server owner opted-in as cornerable target (admin+ only)'
  }
];
// Tier rank, for minActorTier comparisons on a wildcard-actor BYPASS_TIER rule (an exact-actorId rule
// always bypasses regardless of tier — minActorTier only matters for the '*' actor case).
const TIER_RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };

function loadOverrides() {
  try {
    if (!fs.existsSync(OVERRIDES_FILE)) {
      fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(DEFAULT_OVERRIDES, null, 2));
      return DEFAULT_OVERRIDES;
    }
    const raw = fs.readFileSync(OVERRIDES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_OVERRIDES;
  } catch (err) {
    console.error(`[overridesManager] error loading ${OVERRIDES_FILE}:`, err.message);
    return DEFAULT_OVERRIDES;
  }
}

function saveOverrides(list) {
  try {
    const tmp = `${OVERRIDES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, OVERRIDES_FILE);
    return true;
  } catch (err) {
    console.error(`[overridesManager] error saving ${OVERRIDES_FILE}:`, err.message);
    return false;
  }
}

function getOverrides() {
  return loadOverrides();
}

function addOverride({ actorType = 'user', actorId, actors = null, hitSquadExempt = false, targetType = 'user', targetId, type, powerTier = null, minActorTier = null, note = '', createdBy = null }) {
  const list = loadOverrides();
  const id = `ov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const t = type.toUpperCase();
  const entry = {
    id,
    targetType,
    targetId: (targetId || '*').trim(),
    type: t,
    powerTier,
    // Only meaningful on a BYPASS_TIER rule with a wildcard ('*') actor — an exact actorId always bypasses
    // regardless of tier, same as before.
    minActorTier: (minActorTier || '').trim().toLowerCase() || null,
    note: note.trim(),
    createdBy,
    createdAt: Date.now()
  };
  if (t === 'EXCLUSIVE_CORNERER') {
    // Protection rules can name MULTIPLE allowed actors (users and/or roles), not just one — see
    // normalizeExclusiveActors() for the legacy-entry fallback (single actorId/actorType).
    entry.actors = Array.isArray(actors) && actors.length ? actors : (actorId ? [{ type: actorType, id: actorId }] : []);
    entry.hitSquadExempt = !!hitSquadExempt;
  } else {
    entry.actorType = actorType;
    entry.actorId = (actorId || '*').trim();
  }
  list.push(entry);
  saveOverrides(list);
  return entry;
}

// EXCLUSIVE_CORNERER rules moved from a single actorId/actorType to a real `actors` array (owner, 2026-08-19:
// "I shouldn't have to create a new rule" to add a second allowed actor). Old entries (including the seeded
// DEFAULT_OVERRIDES before this change, and anything saved to disk before this deploy) only have the legacy
// singular fields — normalize those into the same shape on read so every caller has one code path.
function normalizeExclusiveActors(rule) {
  if (Array.isArray(rule.actors)) return rule.actors;
  if (rule.actorId) return [{ type: rule.actorType || 'user', id: rule.actorId }];
  return [];
}

function addExclusiveActor(ruleId, actorType, actorId) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId && o.type === 'EXCLUSIVE_CORNERER');
  if (!rule) return null;
  const actors = normalizeExclusiveActors(rule);
  if (!actors.some(a => a.type === actorType && a.id === actorId)) actors.push({ type: actorType, id: actorId });
  rule.actors = actors;
  delete rule.actorId; delete rule.actorType;
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

function removeExclusiveActor(ruleId, actorType, actorId) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId && o.type === 'EXCLUSIVE_CORNERER');
  if (!rule) return null;
  rule.actors = normalizeExclusiveActors(rule).filter(a => !(a.type === actorType && a.id === actorId));
  delete rule.actorId; delete rule.actorType;
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

function setExclusiveHitSquadExempt(ruleId, exempt) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId && o.type === 'EXCLUSIVE_CORNERER');
  if (!rule) return null;
  rule.hitSquadExempt = !!exempt;
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

function removeOverride(id) {
  const list = loadOverrides();
  const next = list.filter(o => o.id !== id);
  saveOverrides(next);
  return next.length < list.length;
}

function getOverride(id) {
  return loadOverrides().find(o => o.id === id) || null;
}

// Editable in place, without a delete+recreate: just the note and (for a wildcard-actor BYPASS_TIER rule)
// its tier floor — both are metadata, not the actor/target/type identity that defines what a rule DOES.
// Changing WHO a rule applies to or what it grants is a structural change, done as delete + re-add via the
// wizard, so a mis-click can't silently repurpose a live security rule.
function updateOverride(id, { note, minActorTier } = {}) {
  const list = loadOverrides();
  const entry = list.find(o => o.id === id);
  if (!entry) return null;
  if (note !== undefined) entry.note = String(note).trim();
  if (minActorTier !== undefined) entry.minActorTier = (String(minActorTier || '').trim().toLowerCase()) || null;
  entry.updatedAt = Date.now();
  saveOverrides(list);
  return entry;
}

function matchEntity(ruleType, ruleId, entity) {
  if (ruleId === '*') return true;
  if (!entity) return false;
  const userId = typeof entity === 'string' ? entity : entity.id;
  const roleIds = typeof entity === 'object' && entity.roles?.cache ? [...entity.roles.cache.keys()] : [];
  return userId === ruleId || roleIds.includes(ruleId);
}

// actorMember (optional, full GuildMember) lets a role-based allowed-actor entry match — a bare actorId
// string can only ever match a user-type entry, same class of gap fixed elsewhere this session (N1).
function checkExclusiveProtection(targetMember, actorId, actorMember = null) {
  const list = loadOverrides();
  const rules = list.filter(o => o.type === 'EXCLUSIVE_CORNERER' && matchEntity(o.targetType, o.targetId, targetMember));
  if (!rules.length) return { allowed: true };
  const hitsquad = require('./hitsquad');
  for (const rule of rules) {
    const actors = normalizeExclusiveActors(rule);
    if (actors.some(a => a.id === '*')) return { allowed: true };
    if (actors.some(a => matchEntity(a.type, a.id, actorMember || actorId))) return { allowed: true };
    if (rule.hitSquadExempt && actorId && hitsquad.isSquadMember(actorId)) return { allowed: true };
  }
  return { allowed: false, requiredActors: normalizeExclusiveActors(rules[0]), hitSquadExempt: rules.some(r => r.hitSquadExempt) };
}

function getGrantedPower(actorMember, targetMember = null) {
  const list = loadOverrides();
  if (!actorMember) return null;
  for (const o of list) {
    if (o.type !== 'GRANT_POWER') continue;
    if (matchEntity(o.actorType, o.actorId, actorMember) && (!targetMember || matchEntity(o.targetType, o.targetId, targetMember))) {
      return o.powerTier || 'owner';
    }
  }
  return null;
}

function canSelfCorner(member) {
  const list = loadOverrides();
  if (!member) return false;
  // Standing personal exception
  if (member.id === '1415112053823242250') return true;
  return list.some(o => o.type === 'ALLOW_SELF_CORNER' && matchEntity(o.targetType, o.targetId, member));
}

function canBypassTier(actorMember, targetMember, actorTier = null) {
  const list = loadOverrides();
  const actorId = typeof actorMember === 'string' ? actorMember : actorMember?.id;
  const targetId = typeof targetMember === 'string' ? targetMember : targetMember?.id;
  return list.some(o => {
    if (o.type !== 'BYPASS_TIER') return false;
    const tType = o.targetType || 'user';
    const aType = o.actorType || 'user';
    if (!matchEntity(tType, o.targetId, targetMember || targetId)) return false;
    if (o.actorId === '*') {
      // A wildcard actor may still require a minimum staff tier (e.g. the owner opt-in is admin+ only,
      // not "any staff/any member") — named/exact-actorId rules below are unaffected by minActorTier.
      if (!o.minActorTier) return true;
      return (TIER_RANK[actorTier] || 0) >= (TIER_RANK[o.minActorTier] || 0);
    }
    return matchEntity(aType, o.actorId, actorMember || actorId);
  });
}

module.exports = {
  getOverrides,
  getOverride,
  addOverride,
  updateOverride,
  removeOverride,
  checkExclusiveProtection,
  normalizeExclusiveActors,
  addExclusiveActor,
  removeExclusiveActor,
  setExclusiveHitSquadExempt,
  getGrantedPower,
  canSelfCorner,
  canBypassTier
};
