// overridesManager.js — Persistent Personal Corner Overrides Manager
const fs = require('fs');
const { statePath } = require('./statepath');

const OVERRIDES_FILE = process.env.FUBU_CORNER_OVERRIDES_FILE || statePath('personal_overrides.json');

const DEFAULT_OVERRIDES = [
  {
    id: 'ov_knylvr_exclusive',
    actorId: '865843812907089940',
    targetId: '1211024269149081620',
    type: 'EXCLUSIVE_CORNERER',
    note: 'Only server owner can corner knylvr'
  },
  {
    id: 'ov_knylvr_ownerpower',
    actorId: '1211024269149081620',
    targetId: '*',
    type: 'GRANT_POWER',
    powerTier: 'owner',
    note: 'Knylvr has owner-level cornering authority'
  },
  {
    id: 'ov_approved_1',
    actorId: '1415112053823242250',
    targetId: '989615671178575972',
    type: 'BYPASS_TIER',
    note: 'Approved actor -> target bypass'
  },
  {
    id: 'ov_approved_2',
    actorId: '593371777569390602',
    targetId: '989615671178575972',
    type: 'BYPASS_TIER',
    note: 'Second approved actor -> target bypass'
  },
  {
    id: 'ov_owner_optin',
    actorId: '*',
    targetId: '865843812907089940',
    type: 'BYPASS_TIER',
    note: 'Server owner opted-in as cornerable target'
  }
];

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

function addOverride({ actorId, targetId, type, powerTier = null, note = '' }) {
  const list = loadOverrides();
  const id = `ov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, actorId: actorId.trim(), targetId: targetId.trim(), type: type.toUpperCase(), powerTier, note: note.trim() };
  list.push(entry);
  saveOverrides(list);
  return entry;
}

function removeOverride(id) {
  const list = loadOverrides();
  const next = list.filter(o => o.id !== id);
  saveOverrides(next);
  return next.length < list.length;
}

function checkExclusiveProtection(targetId, actorId) {
  const list = loadOverrides();
  const rule = list.find(o => o.type === 'EXCLUSIVE_CORNERER' && (o.targetId === targetId || o.targetId === '*'));
  if (rule) {
    if (rule.actorId !== actorId && rule.actorId !== '*') {
      return { allowed: false, requiredActorId: rule.actorId };
    }
  }
  return { allowed: true };
}

function getGrantedPower(actorId) {
  const list = loadOverrides();
  const rule = list.find(o => o.type === 'GRANT_POWER' && (o.actorId === actorId || o.actorId === '*'));
  return rule ? rule.powerTier || 'owner' : null;
}

function canBypassTier(actorId, targetId, actorTier = null) {
  const list = loadOverrides();
  return list.some(o => {
    if (o.type !== 'BYPASS_TIER') return false;
    if (o.targetId !== '*' && o.targetId !== targetId) return false;
    if (o.actorId === '*') return !!actorTier; // wildcard matches staff actors
    return o.actorId === actorId;
  });
}

module.exports = {
  getOverrides,
  addOverride,
  removeOverride,
  checkExclusiveProtection,
  getGrantedPower,
  canBypassTier
};
