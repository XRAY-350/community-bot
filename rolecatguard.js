// rolecatguard.js — keeps every role inside its category's contiguous position band. Roles may reorder
// FREELY within a category; a role that drifts OUT of its band (crosses into another category's block) is
// moved back on the next sweep — the same auto-correct model permguard uses for channel-permission drift.
//
// Owner-made moves are best-effort ADOPTED rather than reverted (an owner dragging a role into a new block
// re-categorizes it). CAVEAT: Discord's audit log does not reliably record role position/reorder changes
// (unlike the channel-overwrite edits permguard relies on), so this adopt is best-effort and may miss — the
// RELIABLE way to move a role to another category is `/role-category set` (or `/role-category bless`). When
// the guard can't confirm an owner move, it reverts: a false revert is cheap (owner re-blesses), a missed
// escape is not.
const fs = require('fs');
const { AuditLogEvent } = require('discord.js');
const { statePath } = require('./statepath');
const rolecat = require('./rolecat');
const permguard = require('./permguard');
const ownerlog = require('./ownerlog');

const AUDIT_STATE = process.env.FUBU_ROLECAT_AUDIT_FILE || statePath('rolecat_audit.json');
// If more than this fraction of managed roles are unfiled, the manifest is probably not fully seeded —
// bail rather than risk mass-reordering every unfiled role to the bottom on a bad/partial manifest.
const MAX_UNFILED_FRACTION = 0.3;

// Roles the guard positions, top→bottom by live position. EVERY role is movable via the bulk PATCH and is
// included — third-party bot/integration roles AND the Server Booster (premiumSubscriber) role (both verified
// live: HTTP 200). Only these are skipped:
//   - @everyone (r.id === guild.id) and exempt roles (isExempt) — the ephemeral day-of Birthday role positions
//     ITSELF above the member's own highest role; see rolecat.isExempt.
//   - our OWN top role and anything at/above it (r.position >= myTop) — the one genuine exception: we leave the
//     bot's own integration role at bot-top rather than churn it, and a bot cannot reposition a role above its
//     top role anyway, so skip those cleanly rather than let one un-movable role fail the whole PATCH.
// NOTE: we check position, NOT role.editable — the editable getter returns false for EVERY managed role (you
// can't edit a managed role's name/perms), but a managed role's POSITION is still movable via the raw PATCH.
function managedList(guild) {
  const myTop = guild.members.me?.roles?.highest?.position ?? Infinity;
  return [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id
      && !rolecat.isExempt(r)
      && r.position < myTop)
    .sort((a, b) => b.position - a.position);
}

// Order-index of a role's category within manifest.order; unfiled roles map to the 'uncategorized' bucket.
function catIndex(m, roleId) {
  const key = m.roles[roleId] || rolecat.UNCATEGORIZED;
  const i = m.order.indexOf(key);
  return i === -1 ? m.order.length : i;
}

// Desired top→bottom ordering: concatenate category blocks in manifest order, preserving each role's
// current relative order within its own block (so within-category reorders are respected, not undone).
function desiredOrder(m, roles) {
  const byCat = new Map();
  for (const r of roles) {  // roles already sorted top→bottom
    const key = m.roles[r.id] || rolecat.UNCATEGORIZED;
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(r.id);
  }
  const ordered = [];
  for (const key of m.order) for (const id of (byCat.get(key) || [])) ordered.push(id);
  for (const [key, ids] of byCat) if (!m.order.includes(key)) ordered.push(...ids);  // safety trailer
  return ordered;
}

// Walking top→bottom, category order-indices must be non-decreasing (every category contiguous AND in
// manifest order). A role whose index dips below the running max has escaped its band.
// UNFILED roles never advance the running max (audit A1 blast-radius clamp): an unfiled role maps to
// 'uncategorized' — the LAST index — so one stray unfiled role sitting high used to set maxSeen to the
// maximum and mark every single role below it as drifted, turning a one-role fix into a full-hierarchy
// PATCH. Unfiled roles are instead drifted iff they sit above ANY filed role (they belong in the bottom
// holding band, below every filed category).
function driftedRoles(m, roles) {
  const out = [];
  let maxSeen = -1;
  let lastFiled = -1;
  roles.forEach((r, i) => { if (m.roles[r.id]) lastFiled = i; });
  roles.forEach((r, i) => {
    if (!m.roles[r.id]) { if (i < lastFiled) out.push(r.id); return; }
    const idx = catIndex(m, r.id);
    if (idx < maxSeen) out.push(r.id);
    else maxSeen = idx;
  });
  return out;
}

// Which category block does a role's CURRENT position fall into? = the category of its nearest filed
// neighbor (above first, then below). Used to adopt an owner drag into whatever block it landed in.
function blockKeyAt(guild, m, roleId) {
  const roles = managedList(guild);
  const i = roles.findIndex(r => r.id === roleId);
  if (i === -1) return null;
  for (let j = i - 1; j >= 0; j--) { const k = m.roles[roles[j].id]; if (k) return k; }
  for (let j = i + 1; j < roles.length; j++) { const k = m.roles[roles[j].id]; if (k) return k; }
  return null;
}

function loadWM() { try { return JSON.parse(fs.readFileSync(AUDIT_STATE, 'utf8')); } catch { return { lastId: null }; } }
function saveWM(s) { try { fs.writeFileSync(AUDIT_STATE, JSON.stringify(s)); } catch (e) { console.error('[rolecatguard] wm save:', e.message); } }

// Best-effort: role ids a trusted owner touched via a RoleUpdate audit entry since the last poll.
// Returns null (NOT an empty set) when the audit fetch itself fails (audit A3): "couldn't read the audit
// log" and "no owner touched anything" must be distinguishable — treating a failed fetch as "nothing
// owner-made" meant the sweep REVERTED legitimate owner role moves during audit-log floods/outages.
async function ownerTouchedRoles(guild) {
  const set = new Set();
  const page = await guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 25 }).catch(() => null);
  if (!page) return null;
  const wm = loadWM();
  let newest = wm.lastId;
  for (const e of page.entries.values()) {
    if (wm.lastId && BigInt(e.id) <= BigInt(wm.lastId)) continue;
    if (!newest || BigInt(e.id) > BigInt(newest)) newest = e.id;
    if (e.executorId && e.target?.id && await permguard.isTrustedOwner(guild, e.executorId).catch(() => false)) set.add(e.target.id);
  }
  if (newest && newest !== wm.lastId) saveWM({ lastId: newest });
  return set;
}

async function sweep(guild, { apply = true, skipAdopt = false } = {}) {
  // Fresh role fetch (audit A8): the pick-time sweep right after a roleCreate computed the PATCH from a
  // stale cache and got "Missing Permissions" 3× on 2026-08-26; the 20-min sweep later self-healed. The
  // fetch is one API call and makes positions authoritative for the slots computation below.
  await guild.roles.fetch().catch(() => {});
  const m = rolecat.load();
  if (!m.order.length) return { seeded: false };
  const roles = managedList(guild);
  if (!roles.length) return { seeded: true, drift: 0 };

  const unfiled = roles.filter(r => !m.roles[r.id]).length;
  if (unfiled / roles.length > MAX_UNFILED_FRACTION) {
    console.warn(`[rolecatguard] ${unfiled}/${roles.length} roles unfiled — manifest looks unseeded, skipping sweep`);
    return { seeded: true, skipped: 'manifest-sparse', unfiled };
  }

  const drift = driftedRoles(m, roles);
  if (!drift.length) return { seeded: true, drift: 0 };

  // Adopt owner moves first (re-categorize), then re-check what still needs reverting. skipAdopt is passed by
  // the explicit-file paths (/role-category set + the new-role picker): the user just NAMED the category, so we
  // must reposition the role to MATCH that name — not let position-based adopt re-file it to whatever band it
  // happens to sit in right now. A freshly-picked role is still at its old/low position, so adopt would read its
  // neighbours and clobber the explicit pick. (Exact bug: picking "Personal / vanity" for a role sitting at the
  // bottom among the gate roles got silently re-filed back to 'gate', so it never moved.)
  const adopted = [];
  if (!skipAdopt) {
    const ownerTouched = await ownerTouchedRoles(guild).catch(() => null);
    // Audit fetch FAILED (null, not empty) → we cannot tell owner moves from drift, so revert nothing this
    // pass (audit A3, fail OPEN): a false skip costs 20 minutes; a false revert undoes an owner's change.
    if (ownerTouched === null) {
      console.warn('[rolecatguard] audit-log fetch failed — skipping this sweep rather than risking a revert of an owner move');
      return { seeded: true, drift: drift.length, skipped: 'audit-unavailable' };
    }
    for (const id of drift) {
      if (!ownerTouched.has(id)) continue;
      const key = blockKeyAt(guild, m, id);
      if (key && key !== (m.roles[id] || rolecat.UNCATEGORIZED)) { rolecat.setCategory(id, key); adopted.push({ id, key }); }
    }
  }
  const m2 = rolecat.load();
  const roles2 = managedList(guild);
  const stillDrift = driftedRoles(m2, roles2);

  let applied = false;
  if (stillDrift.length && apply) {
    const want = desiredOrder(m2, roles2);                        // top→bottom
    const slots = roles2.map(r => r.position).sort((a, b) => b - a);  // high→low
    const positions = want.map((id, i) => ({ id, position: slots[i] }));
    await guild.client.rest.patch(`/guilds/${guild.id}/roles`, { body: positions })
      .then(() => { applied = true; })
      .catch(e => console.error('[rolecatguard] reorder patch:', e.message));
  }

  for (const a of adopted) await ownerlog.log(guild, { emoji: '📥', title: 'Role re-categorized (owner move adopted)', color: 0x5865F2, detail: `<@&${a.id}> → **${rolecat.labelOf(a.key)}**.` }).catch(() => {});
  if (applied) {
    const names = stillDrift.map(id => guild.roles.cache.get(id)?.name || id).slice(0, 10).join(', ');
    await ownerlog.log(guild, { emoji: '↩️', title: 'Role category drift corrected', color: 0xFEE75C, detail: `Moved back into their categories: ${names}${stillDrift.length > 10 ? ` (+${stillDrift.length - 10} more)` : ''}.` }).catch(() => {});
  }
  return { seeded: true, drift: drift.length, adopted: adopted.length, reverted: applied ? stillDrift.length : 0, applied };
}

function register(client, { intervalMin = 20 } = {}) {
  const run = async () => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    try { const r = await sweep(guild); if (r.reverted || r.adopted) console.log(`[rolecatguard] sweep: ${r.reverted || 0} reverted, ${r.adopted || 0} adopted`); }
    catch (e) { console.error('[rolecatguard] sweep failed:', e.message); }
  };
  setTimeout(run, 60 * 1000);
  setInterval(run, intervalMin * 60 * 1000);
  console.log(`[rolecatguard] role-category drift guard armed (sweep every ${intervalMin}min)`);
}

module.exports = { sweep, desiredOrder, driftedRoles, blockKeyAt, managedList, register };
