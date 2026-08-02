// strikes.js — weighted, cumulative strike ledger. Replaces the old flat role-ladder: a strike now
// carries a weight (1-3 units, staff-chosen), strikes never expire on their own, and total units
// (not a role position) is the record. Ban threshold is 10 cumulative units — this module NEVER
// auto-bans; it only reports whether the threshold was crossed so the caller can surface a staff
// Confirm button (this bot has never auto-banned anywhere; that stays true here too).
const crypto = require('crypto');
const config = require('./config');
const rules = require('./rules');

const BAN_THRESHOLD = 10;
// A timeout adds bonus units LINEAR with its length (1h = 1 unit, 30m = 0.5), capped at 2 units so a
// multi-day timeout doesn't dwarf the whole 10-unit ban scale (owner-decided 2026-07-30). Totals can now
// be fractional (e.g. 2.5) — tierRole/tierName floor them, since a role tier only fully applies once you
// cross the whole unit (matches the ban check itself, which is an exact >=10, never rounded early).
const TIMEOUT_BONUS_CAP = 2;
function timeoutBonusUnits(timeoutMs) { return timeoutMs ? Math.min(timeoutMs / 3600000, TIMEOUT_BONUS_CAP) : 0; }
// Clean display for a possibly-fractional unit count — "2", "2.5", never "2.500000000004".
function formatUnits(n) { return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString(); }

// Visible tier roles: ONE role per unit total (Strike 1..9), a smooth green→red gradient. A member's role
// == their FLOORED unit total (capped at 9; 10 units = ban). strikeRoleIds is ordered unit-1-first.
function tierRole(totalUnits) {
  const ids = (config.strikeRoleIds || []).filter(Boolean);
  const floored = Math.floor(totalUnits);
  if (floored < 1 || !ids.length) return null;
  return ids[Math.min(floored, ids.length) - 1] || null;
}
function tierName(totalUnits) {
  const floored = Math.floor(totalUnits);
  if (floored < 1) return 'clean';
  return `Strike ${Math.min(floored, 9)}`;
}

function ledger(state, memberId) { return (state.getMeta('strikes') || {})[memberId] || []; }
function activeEntries(state, memberId) { return ledger(state, memberId).filter(e => e.active); }

// Human-readable label for one strike entry — "Rule 5: Respect Everyone — 2 units — 3d ago" (or the
// custom reason if no rule was picked). Used everywhere a person needs to pick a strike WITHOUT already
// knowing its raw ID: staff /strike remove autocomplete, the dashboard's strike picker, and (once built)
// the member-facing /appeal strike autocomplete.
function entryLabel(entry) {
  const ageMs = Date.now() - entry.at;
  const days = Math.floor(ageMs / 86400000);
  const ageStr = days > 0 ? `${days}d ago` : `${Math.max(1, Math.floor(ageMs / 3600000))}h ago`;
  const ruleTitle = entry.ruleIndex ? rules.byIndex(Number(entry.ruleIndex))?.title : null;
  const what = ruleTitle ? `Rule ${entry.ruleIndex}: ${ruleTitle}` : (entry.reason ? entry.reason.slice(0, 60) : 'No reason given');
  return `${what} · ${formatUnits(entry.weight)} unit${entry.weight === 1 ? '' : 's'} · ${ageStr}`;
}
// Autocomplete choices for a member's active strikes — { name, value } pairs, Discord's 25-choice cap
// applied, newest first. excludeCrossedBan drops the strike that pushed them over the ban threshold
// (not appeal-eligible — used by /appeal strike; staff's /strike remove doesn't need that exclusion).
function autocompleteChoices(state, memberId, { excludeCrossedBan = false, query = '' } = {}) {
  const q = query.toLowerCase();
  return activeEntries(state, memberId)
    .filter(e => !excludeCrossedBan || !e.crossedBan)
    .sort((a, b) => b.at - a.at)
    .map(e => ({ name: entryLabel(e).slice(0, 100), value: e.id }))
    .filter(c => c.name.toLowerCase().includes(q))
    .slice(0, 25);
}
function totalUnits(state, memberId) { return activeEntries(state, memberId).reduce((s, e) => s + e.weight, 0); }

// Every member with at least one active strike — for a dashboard roster page (mirrors listCornered()'s
// role in the Corner page: list everyone, click one to act, no need to already know who to look up).
function activeMembers(state) {
  const all = state.getMeta('strikes') || {};
  return Object.keys(all)
    .map(memberId => ({ memberId, units: totalUnits(state, memberId), count: activeEntries(state, memberId).length }))
    .filter(m => m.count > 0)
    .sort((a, b) => b.units - a.units);
}

function saveLedger(state, memberId, entries) {
  const all = state.getMeta('strikes') || {};
  all[memberId] = entries;
  state.setMeta('strikes', all);
}

// Swap the member's visible tier role to match their current total, if it doesn't already match.
// Handles both directions — escalation (new strike) and de-escalation (appeal removal / clear).
async function recomputeTier(guild, member, state, byTag) {
  const ids = (config.strikeRoleIds || []).filter(Boolean);
  const target = tierRole(totalUnits(state, member.id));
  const held = ids.find(id => member.roles.cache.has(id)) || null;
  if (held === target) return;
  if (held) await member.roles.remove(held, `strike tier recompute by ${byTag}`).catch(() => {});
  if (target) await member.roles.add(target, `strike tier recompute by ${byTag}`).catch(() => {});
}

// Append a strike, apply the native Discord timeout if given, recompute the visible tier role.
// Returns { id, totalUnits, tier, crossedBan }.
async function addStrike(guild, member, state, { weight, ruleIndex, reason, timeoutMs, byId, byTag }) {
  const entries = ledger(state, member.id);
  const totalBefore = totalUnits(state, member.id);
  // A timeout adds bonus units ON TOP of the base weight — linear with length, capped (see
  // timeoutBonusUnits): 30m=+0.5, 1h=+1, 2h+=+2 max. This is the ONE place that combines them, so every
  // caller (slash command, modal, dashboard quick-strike) gets it automatically.
  const effectiveWeight = weight + timeoutBonusUnits(timeoutMs);
  // Persisted (not just returned) so eligibility checks — e.g. "the strike that crossed the ban
  // threshold isn't appealable" — stay correct later, regardless of subsequent strikes/removals
  // shifting the running total.
  const crossedBan = (totalBefore + effectiveWeight) >= BAN_THRESHOLD;
  const entry = {
    id: crypto.randomBytes(4).toString('hex'), weight: effectiveWeight, ruleIndex: ruleIndex || null,
    reason: reason || null, timeoutMs: timeoutMs || null, byId: byId || null, at: Date.now(), active: true,
    crossedBan,
  };
  entries.push(entry);
  saveLedger(state, member.id, entries);
  if (timeoutMs) await member.timeout(timeoutMs, reason || 'Strike + timeout').catch(e => console.error('[strikes] timeout:', e.message));
  await recomputeTier(guild, member, state, byTag);
  const total = totalUnits(state, member.id);
  return { id: entry.id, weight: effectiveWeight, totalUnits: total, tier: tierName(total), crossedBan };
}

// Deactivate ONE specific strike by id (the appeal-removal primitive — the guided appeal workflow
// itself, thread + review + buttons, is separate future work). Returns { ok, totalUnits, tier }.
async function removeStrike(guild, member, state, strikeId, byTag) {
  const entries = ledger(state, member.id);
  const entry = entries.find(e => e.id === strikeId && e.active);
  if (!entry) return { ok: false };
  entry.active = false;
  saveLedger(state, member.id, entries);
  await recomputeTier(guild, member, state, byTag);
  const total = totalUnits(state, member.id);
  return { ok: true, totalUnits: total, tier: tierName(total) };
}

// Change ONE active strike's weight (units) — the "partial appeal / re-weigh" primitive. newWeight <= 0
// deactivates it (same effect as removeStrike). Otherwise the weight is updated and the tier role recomputed.
// Returns { ok, oldWeight, newWeight, removed, totalUnits, tier }.
async function setStrikeWeight(guild, member, state, strikeId, newWeight, byTag) {
  const entries = ledger(state, member.id);
  const entry = entries.find(e => e.id === strikeId && e.active);
  if (!entry) return { ok: false };
  const oldWeight = entry.weight;
  const removed = newWeight <= 0;
  if (removed) entry.active = false; else entry.weight = newWeight;
  saveLedger(state, member.id, entries);
  await recomputeTier(guild, member, state, byTag);
  const total = totalUnits(state, member.id);
  return { ok: true, oldWeight, newWeight: removed ? 0 : newWeight, removed, totalUnits: total, tier: tierName(total) };
}

// Deactivate every active strike a member holds (full reset). Returns { cleared }.
async function clearStrikes(guild, member, state, byTag) {
  const entries = ledger(state, member.id);
  let cleared = 0;
  for (const e of entries) if (e.active) { e.active = false; cleared++; }
  if (cleared) saveLedger(state, member.id, entries);
  await recomputeTier(guild, member, state, byTag);
  return { cleared };
}

// One-time boot self-heal: a member holding a Strike I/II/III role today (the old flat-ladder system)
// but with NO ledger entries yet gets seeded with one legacy entry at that role's position as weight
// (I=1, II=2, III=3) — so switching to weighted units doesn't erase anyone's standing or hand out a
// free reset. Idempotent: a member who already has ledger entries is skipped. Returns the count seeded.
async function migrateLegacyStrikes(guild, state) {
  const ids = (config.strikeRoleIds || []).filter(Boolean);
  if (!ids.length) return 0;
  await guild.members.fetch().catch(() => {}); // ensure role.members is populated below
  const all = state.getMeta('strikes') || {};
  let seeded = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    const role = await guild.roles.fetch(ids[i]).catch(() => null);
    if (!role) continue;
    for (const member of role.members.values()) {
      if (all[member.id]) continue; // already has ledger entries (or already seeded this pass)
      all[member.id] = [{
        id: crypto.randomBytes(4).toString('hex'), weight: i + 1, ruleIndex: null,
        reason: 'carried over from the old strike system', timeoutMs: null, byId: null, at: Date.now(), active: true,
      }];
      seeded++;
    }
  }
  if (seeded) state.setMeta('strikes', all);
  return seeded;
}

// Re-sync EVERY member's visible strike role to their current unit total. Run once after switching from
// the old 3-band model to per-unit roles (a member at 8 units wearing the old band role gets moved to
// Strike 8). recomputeTier no-ops when already correct, so this is idempotent + safe on every boot.
async function resyncTierRoles(guild, state) {
  const all = state.getMeta('strikes') || {};
  const ids = (config.strikeRoleIds || []).filter(Boolean);
  let synced = 0;
  for (const memberId of Object.keys(all)) {
    const member = await guild.members.fetch(memberId).catch(() => null);
    if (!member) continue;
    const target = tierRole(totalUnits(state, memberId));
    const held = ids.find(id => member.roles.cache.has(id)) || null;
    if (held !== target) { await recomputeTier(guild, member, state, 'per-unit strike-role migration'); synced++; }
  }
  return synced;
}

module.exports = {
  BAN_THRESHOLD, tierRole, tierName, ledger, activeEntries, totalUnits,
  addStrike, removeStrike, setStrikeWeight, clearStrikes, recomputeTier, migrateLegacyStrikes, resyncTierRoles,
  entryLabel, autocompleteChoices, activeMembers, formatUnits, timeoutBonusUnits, TIMEOUT_BONUS_CAP,
};
