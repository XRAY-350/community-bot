// strikes.js — weighted, cumulative strike ledger. Replaces the old flat role-ladder: a strike now
// carries a weight (1-3 units, staff-chosen), strikes never expire on their own, and total units
// (not a role position) is the record. Ban threshold is 10 cumulative units — this module NEVER
// auto-bans; it only reports whether the threshold was crossed so the caller can surface a staff
// Confirm button (this bot has never auto-banned anywhere; that stays true here too).
const crypto = require('crypto');
const config = require('./config');

const BAN_THRESHOLD = 10;

// Visible tier roles reuse the existing 3 Strike I/II/III role IDs — same roles, new meaning: which
// unit-band you're in, not which level you escalated to one at a time. Roughly even 3-wide bands
// under the ban line (owner chose: keep the Roman-numeral roles, don't invent new ones).
function tierRole(totalUnits) {
  const ids = config.strikeRoleIds || [];
  if (totalUnits >= 7) return ids[2] || null;
  if (totalUnits >= 4) return ids[1] || null;
  if (totalUnits >= 1) return ids[0] || null;
  return null;
}
function tierName(totalUnits) {
  if (totalUnits >= 7) return 'Strike III';
  if (totalUnits >= 4) return 'Strike II';
  if (totalUnits >= 1) return 'Strike I';
  return 'clean';
}

function ledger(state, memberId) { return (state.getMeta('strikes') || {})[memberId] || []; }
function activeEntries(state, memberId) { return ledger(state, memberId).filter(e => e.active); }
function totalUnits(state, memberId) { return activeEntries(state, memberId).reduce((s, e) => s + e.weight, 0); }

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
  const entry = {
    id: crypto.randomBytes(4).toString('hex'), weight, ruleIndex: ruleIndex || null,
    reason: reason || null, timeoutMs: timeoutMs || null, byId: byId || null, at: Date.now(), active: true,
  };
  const entries = ledger(state, member.id);
  entries.push(entry);
  saveLedger(state, member.id, entries);
  if (timeoutMs) await member.timeout(timeoutMs, reason || 'Strike + timeout').catch(e => console.error('[strikes] timeout:', e.message));
  await recomputeTier(guild, member, state, byTag);
  const total = totalUnits(state, member.id);
  return { id: entry.id, totalUnits: total, tier: tierName(total), crossedBan: total >= BAN_THRESHOLD };
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

module.exports = {
  BAN_THRESHOLD, tierRole, tierName, ledger, activeEntries, totalUnits,
  addStrike, removeStrike, clearStrikes, recomputeTier, migrateLegacyStrikes,
};
