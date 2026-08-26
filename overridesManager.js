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
    actors: [{ type: 'user', id: '1211024269149081620' }],
    targetType: '*',
    targetId: '*',
    type: 'GRANT_POWER',
    powerTier: 'owner',
    note: 'Knylvr owner-level cornering authority'
  },
  {
    id: 'ov_approved_1',
    actors: [{ type: 'user', id: '1415112053823242250' }],
    targetType: 'user',
    targetId: '989615671178575972',
    type: 'BYPASS_TIER',
    note: 'Approved actor -> target bypass'
  },
  {
    id: 'ov_approved_2',
    actors: [{ type: 'user', id: '593371777569390602' }],
    targetType: 'user',
    targetId: '989615671178575972',
    type: 'BYPASS_TIER',
    note: 'Second approved actor -> target bypass'
  },
  {
    id: 'ov_owner_optin',
    // A tier-type actor entry ("admin+ staff") instead of a wildcard actor + a separate minActorTier field
    // — same meaning, one mechanism. owner, 2026-08-17: "change the everyone corner to only staff (mod+)",
    // then 2026-08-18: "should be admin/owner" — a plain mod no longer qualifies.
    actors: [{ type: 'tier', id: 'admin' }],
    targetType: 'user',
    targetId: '865843812907089940',
    type: 'BYPASS_TIER',
    note: 'Server owner opted-in as cornerable target (admin+ only)'
  }
];
// Tier rank, for tier-type actor entries ("staff+ / mod+ / admin+ / owner+ / botowner") — the general-purpose
// version of what used to be a BYPASS_TIER-only minActorTier field (owner, 2026-08-19: "there are more
// tiers in between" all-members and a single named actor — this is available on every rule type now).
// Mirrors opspanel.js's RANK exactly (owner, 2026-08-20: "generalized to the staff tier everywhere") —
// 'staff' is Trial Mod / any Mini-Mod / Event Organizer, the floor rank below Mod. actorTier is whatever
// opspanel.tierOf(interaction) returned at the call site, so it already carries 'staff' correctly; no
// special-casing needed here beyond having it in the ladder.
const TIER_RANK = { staff: 1, mod: 2, admin: 3, owner: 4, botowner: 5 };

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

// 5 minutes, matching the existing lowering/release override vote window (corner.js OVERRIDE_WINDOW_MS) —
// GROUP_REQUIRED reuses the same "N same-tier staff, one window" shape for INITIATING a corner instead.
const DEFAULT_GROUP_WINDOW_MS = 5 * 60 * 1000;

function addOverride({ actorType = 'user', actorId, actors = null, denied = null, hitSquadExempt = false, targetType = 'user', targetId, type, powerTier = null, requiredCount = null, windowMs = null, note = '', createdBy = null }) {
  const list = loadOverrides();
  const id = `ov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const t = type.toUpperCase();
  const entry = {
    id,
    targetType,
    targetId: (targetId || '*').trim(),
    type: t,
    powerTier,
    note: note.trim(),
    createdBy,
    createdAt: Date.now()
  };
  if (t === 'ALLOW_SELF_CORNER') {
    // Self-corner is inherently one target = one actor — a role target already covers "many people", so
    // this is the one type that doesn't need the multi-actor list.
    entry.actorType = actorType;
    entry.actorId = (actorId || '*').trim();
  } else if (t === 'PROTECT_FROM') {
    // Deny-list, not allow-list (owner, 2026-08-20: "there are different reasons someone could be
    // cornered — hit squad, by staff, or by a member" — an allow-list means enumerating every OTHER
    // legitimate actor just to block one source). Entries: {type:'user'|'role', id}, {type:'tier', id:
    // 'staff'|'mod'|'admin'|'owner'} (that tier and above), {type:'hitsquad'}, {type:'membercorner'}.
    // Anyone/anything NOT matching an entry here can still corner them normally.
    entry.denied = Array.isArray(denied) ? denied : [];
  } else {
    // Every other type can name MULTIPLE allowed actors (users and/or roles), not just one — see
    // normalizeActors() for the legacy-entry fallback (single actorId/actorType), and addRuleActor /
    // removeRuleActor to grow or shrink this list on an existing rule without recreating it.
    entry.actors = Array.isArray(actors) && actors.length ? actors : (actorId ? [{ type: actorType, id: actorId }] : []);
    if (t === 'EXCLUSIVE_CORNERER') entry.hitSquadExempt = !!hitSquadExempt;
    if (t === 'GROUP_REQUIRED') {
      // A per-ATTEMPT group override (owner, 2026-08-23: "a separate tier I can add to a corner that
      // turns it back on" / "the need for 3 admins to override a corner") — NOT a standing on/off switch.
      // `actors` names WHICH tier/people can cast a vote; requiredCount/windowMs are how many of them,
      // within how long, before the corner actually goes through. pendingVotes lives on the rule itself
      // (file-backed, survives a restart) and is consumed the moment the threshold is met.
      entry.requiredCount = Math.max(1, Number(requiredCount) || 3);
      entry.windowMs = Math.max(60000, Number(windowMs) || DEFAULT_GROUP_WINDOW_MS);
      entry.pendingVotes = [];
    }
  }
  list.push(entry);
  saveOverrides(list);
  return entry;
}

// EXCLUSIVE_CORNERER, BYPASS_TIER, and GRANT_POWER rules moved from a single actorId/actorType to a real
// `actors` array (owner, 2026-08-19: "I shouldn't have to create a new rule" to add a second allowed actor —
// originally built for protection rules only, then extended to every type for consistency). Old entries
// (including the seeded DEFAULT_OVERRIDES, and anything saved to disk before this deploy) only have the
// legacy singular fields — normalize those into the same shape on read so every caller has one code path.
function normalizeActors(rule) {
  if (Array.isArray(rule.actors)) return rule.actors;
  if (rule.actorId) return [{ type: rule.actorType || 'user', id: rule.actorId }];
  return [];
}

function addRuleActor(ruleId, actorType, actorId) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId);
  if (!rule || rule.type === 'ALLOW_SELF_CORNER') return null;
  const actors = normalizeActors(rule);
  if (!actors.some(a => a.type === actorType && a.id === actorId)) actors.push({ type: actorType, id: actorId });
  rule.actors = actors;
  delete rule.actorId; delete rule.actorType;
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

function removeRuleActor(ruleId, actorType, actorId) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId);
  if (!rule || rule.type === 'ALLOW_SELF_CORNER') return null;
  rule.actors = normalizeActors(rule).filter(a => !(a.type === actorType && a.id === actorId));
  delete rule.actorId; delete rule.actorType;
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

// Same shape as normalizeActors, for PROTECT_FROM's denied[] list.
function normalizeDenied(rule) { return Array.isArray(rule.denied) ? rule.denied : []; }

function addDeniedEntry(ruleId, type, id) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId && o.type === 'PROTECT_FROM');
  if (!rule) return null;
  const denied = normalizeDenied(rule);
  if (!denied.some(d => d.type === type && d.id === id)) denied.push(id ? { type, id } : { type });
  rule.denied = denied;
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

function removeDeniedEntry(ruleId, type, id) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId && o.type === 'PROTECT_FROM');
  if (!rule) return null;
  rule.denied = normalizeDenied(rule).filter(d => !(d.type === type && d.id === id));
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

// The deny-list model (owner, 2026-08-20): checked ALONGSIDE checkExclusiveProtection (legacy
// allow-list rules keep working unchanged), never replacing it — a target can have either or both kinds
// of rule. `source` tells this which non-tier corner PATHS the actor is currently using: { hitSquad,
// memberCorner } — both false for a normal staff/trial corner attempt.
function matchDenied(entry, actorMember, actorId, actorTier, source) {
  if (entry.type === 'hitsquad') return !!source?.hitSquad;
  if (entry.type === 'membercorner') return !!source?.memberCorner;
  if (entry.type === 'tier') return (TIER_RANK[actorTier] || 0) >= (TIER_RANK[entry.id] || 0);
  return matchEntity(entry.type, entry.id, actorMember || actorId);
}
function checkProtectFrom(targetMember, actorId, actorMember = null, actorTier = null, source = null) {
  const list = loadOverrides();
  const rules = list.filter(o => isEnabled(o) && o.type === 'PROTECT_FROM' && matchEntity(o.targetType, o.targetId, targetMember));
  for (const rule of rules) {
    const hit = normalizeDenied(rule).find(d => matchDenied(d, actorMember, actorId, actorTier, source));
    if (hit) return { allowed: false, deniedEntry: hit, note: rule.note };
  }
  return { allowed: true };
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

// Soft on/off, distinct from removeOverride (owner, 2026-08-23: "I'd like to be able to add it back
// situationally" re: the owner opt-in-to-cornering rule) — flip a rule off without losing its actors/
// target/note, then flip it back on later instead of deleting and re-building it from scratch. Every
// checker below treats a missing `enabled` field as true (existing rules predate this field).
function isEnabled(o) { return o.enabled !== false; }
function setEnabled(id, enabled) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === id);
  if (!rule) return null;
  rule.enabled = !!enabled;
  rule.updatedAt = Date.now();
  saveOverrides(list);
  return rule;
}

// Editable in place, without a delete+recreate: just the note — the actor/target/type identity is what
// defines what a rule DOES, and changing WHO it applies to is a structural change, done via the actor
// list (addRuleActor/removeRuleActor) or delete + re-add, so a mis-click can't silently repurpose a live
// security rule.
function updateOverride(id, { note } = {}) {
  const list = loadOverrides();
  const entry = list.find(o => o.id === id);
  if (!entry) return null;
  if (note !== undefined) entry.note = String(note).trim();
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

// One actor-entry matcher used everywhere an actors[] list is checked. Three entry shapes:
//  - { type: 'user'|'role', id }   — a named person or role (matchEntity, so a role entry matches by
//    membership even when only a bare actorId string is available — no member object required).
//  - { type: 'tier', id: 'mod'|'admin'|'owner'|'botowner' }  — anyone AT OR ABOVE that staff tier. This is
//    the general form of what used to be BYPASS_TIER's one-off minActorTier field.
//  - { id: '*' } (any type) — literally anyone, no floor at all.
function matchActor(entry, actorMember, actorId, actorTier) {
  if (entry.id === '*') return true;
  if (entry.type === 'tier') return (TIER_RANK[actorTier] || 0) >= (TIER_RANK[entry.id] || 0);
  return matchEntity(entry.type, entry.id, actorMember || actorId);
}

// actorMember (optional, full GuildMember) lets a role-based allowed-actor entry match — a bare actorId
// string can only ever match a user-type entry, same class of gap fixed elsewhere this session (N1).
// actorTier lets a tier-type actor entry match (e.g. "admin+ staff can corner them, not just this list").
function checkExclusiveProtection(targetMember, actorId, actorMember = null, actorTier = null) {
  const list = loadOverrides();
  const rules = list.filter(o => isEnabled(o) && o.type === 'EXCLUSIVE_CORNERER' && matchEntity(o.targetType, o.targetId, targetMember));
  if (!rules.length) return { allowed: true };
  const hitsquad = require('./hitsquad');
  for (const rule of rules) {
    const actors = normalizeActors(rule);
    if (actors.some(a => matchActor(a, actorMember, actorId, actorTier))) return { allowed: true };
    if (rule.hitSquadExempt && actorId && hitsquad.isSquadMember(actorId)) return { allowed: true };
  }
  return { allowed: false, requiredActors: normalizeActors(rules[0]), hitSquadExempt: rules.some(r => r.hitSquadExempt) };
}

// actorTier is the actor's OWN current tier (not a granted one) — needed to evaluate a tier-type actor
// entry on a GRANT_POWER rule itself. Callers pass the raw tier (e.g. opspanel.tierOf), never the result
// of this same function, to avoid a rule granting itself eligibility.
function getGrantedPower(actorMember, targetMember = null, actorTier = null) {
  const list = loadOverrides();
  if (!actorMember) return null;
  const actorId = typeof actorMember === 'string' ? actorMember : actorMember?.id;
  for (const o of list) {
    if (!isEnabled(o) || o.type !== 'GRANT_POWER') continue;
    if (!targetMember || matchEntity(o.targetType, o.targetId, targetMember)) {
      if (normalizeActors(o).some(a => matchActor(a, actorMember, actorId, actorTier))) return o.powerTier || 'owner';
    }
  }
  return null;
}

function canSelfCorner(member) {
  const list = loadOverrides();
  if (!member) return false;
  // Standing personal exception
  if (member.id === '1415112053823242250') return true;
  return list.some(o => isEnabled(o) && o.type === 'ALLOW_SELF_CORNER' && matchEntity(o.targetType, o.targetId, member));
}

// Register this actor's vote on ONE specific GROUP_REQUIRED rule and report the tally. Mutating — this is
// the single place a vote is ever counted, called only at actual corner-execution time (corner.js's
// ownerCornerGate), never from an earlier "can I even try" UI pre-check (see canAttemptGroupRequired).
// Stale votes (outside the rule's own window) are dropped before counting; hitting the threshold consumes
// all pending votes so the NEXT corner attempt on this target starts a fresh group from zero.
function registerGroupVote(ruleId, actorId) {
  const list = loadOverrides();
  const rule = list.find(o => o.id === ruleId && o.type === 'GROUP_REQUIRED');
  if (!rule) return null;
  const windowMs = rule.windowMs || DEFAULT_GROUP_WINDOW_MS;
  const now = Date.now();
  rule.pendingVotes = (rule.pendingVotes || []).filter(v => now - v.at < windowMs);
  if (!rule.pendingVotes.some(v => v.id === actorId)) rule.pendingVotes.push({ id: actorId, at: now });
  const need = rule.requiredCount || 3;
  const have = rule.pendingVotes.length;
  const voters = rule.pendingVotes.map(v => v.id);
  const ok = have >= need;
  if (ok) rule.pendingVotes = [];
  saveOverrides(list);
  return { ok, have, need, voters, windowMs };
}

// The real (mutating) check for this target — call ONLY where a corner is actually being executed.
// Finds the first enabled GROUP_REQUIRED rule targeting them that this actor's tier is even allowed to
// vote on, and registers that vote. `applicable: false` means no such rule exists for this target/actor
// at all, so the caller should fall back to its normal (e.g. hard-block) behavior.
function checkGroupRequired(targetMember, actorId, actorMember = null, actorTier = null) {
  const list = loadOverrides();
  const rules = list.filter(o => isEnabled(o) && o.type === 'GROUP_REQUIRED' && matchEntity(o.targetType, o.targetId, targetMember));
  for (const rule of rules) {
    if (!normalizeActors(rule).some(a => matchActor(a, actorMember, actorId, actorTier))) continue;
    return { applicable: true, ...registerGroupVote(rule.id, actorId) };
  }
  return { applicable: false };
}

// Read-only: does ANY enabled GROUP_REQUIRED rule exist for this target that this actor's tier could vote
// on — regardless of the current tally? Used for early "is this worth showing a modal for" UX checks,
// BEFORE any vote is actually registered (that only happens in checkGroupRequired, at execution time).
function canAttemptGroupRequired(targetMember, actorId, actorMember = null, actorTier = null) {
  const list = loadOverrides();
  return list.some(o => isEnabled(o) && o.type === 'GROUP_REQUIRED' && matchEntity(o.targetType, o.targetId, targetMember)
    && normalizeActors(o).some(a => matchActor(a, actorMember, actorId, actorTier)));
}

function canBypassTier(actorMember, targetMember, actorTier = null) {
  const list = loadOverrides();
  const actorId = typeof actorMember === 'string' ? actorMember : actorMember?.id;
  const targetId = typeof targetMember === 'string' ? targetMember : targetMember?.id;
  return list.some(o => {
    if (!isEnabled(o) || o.type !== 'BYPASS_TIER') return false;
    const tType = o.targetType || 'user';
    if (!matchEntity(tType, o.targetId, targetMember || targetId)) return false;
    return normalizeActors(o).some(a => matchActor(a, actorMember, actorId, actorTier));
  });
}

module.exports = {
  getOverrides,
  getOverride,
  addOverride,
  updateOverride,
  removeOverride,
  checkExclusiveProtection,
  checkProtectFrom,
  normalizeActors,
  normalizeDenied,
  addRuleActor,
  removeRuleActor,
  addDeniedEntry,
  removeDeniedEntry,
  setExclusiveHitSquadExempt,
  getGrantedPower,
  canSelfCorner,
  canBypassTier,
  isEnabled,
  setEnabled,
  checkGroupRequired,
  canAttemptGroupRequired,
  DEFAULT_GROUP_WINDOW_MS
};
