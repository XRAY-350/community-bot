// permguard.js — periodic reconciliation of channel ROLE permission overwrites against a golden
// manifest snapshot. Built 2026-07-30 after a plain mod could post in #mod-announcements: the channel's
// own overwrite for MODS-✰ only ALLOWed View+ReadHistory with no explicit DENY, so it silently stopped
// inheriting the category's "deny everything by default" rule (Discord replaces, not merges, a
// category's overwrite once a channel has its own) and the mod's base-role Send Messages leaked
// through. That's a structural risk for ANY channel with a partial role overwrite, not just this one —
// this sweep catches drift of that shape automatically, on a schedule, instead of waiting for a report.
const { Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, AuditLogEvent } = require('discord.js');
const { statePath } = require('./statepath');
const fs = require('fs');
const ownerlog = require('./ownerlog');
const opspanel = require('./opspanel');   // for the owner-tier gate on the reconcile popup

const MANIFEST_FILE = process.env.FUBU_PERM_MANIFEST_FILE || statePath('perm_manifest.json');
const EPH = 1 << 6;   // MessageFlags.Ephemeral
const PERM_NAMES = Object.fromEntries(Object.entries(PermissionsBitField.Flags).map(([k, v]) => [v.toString(), k]));
const permList = bf => { const o = []; let b = BigInt(bf || '0'); for (const [v, k] of Object.entries(PERM_NAMES)) if (b & BigInt(v)) o.push(k); return o; };

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return null; }
}

// The manifest is the "should be" snapshot, taken once (2026-07-30, right after the full permission
// audit + the mod-announcements fix) and re-taken whenever the owner deliberately changes a channel's
// permission structure — see resnapshot() below. It is NOT auto-regenerated from live state on every
// sweep; that would just make every future drift "correct by definition" and defeat the point.
async function resnapshot(guild, { exclude } = {}) {
  const channels = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const roles = await guild.roles.fetch();
  const manifest = {};
  for (const ch of channels) {
    if (exclude && exclude.has(ch.id)) continue;   // channels the owner chose to leave unguarded
    manifest[ch.id] = {
      name: ch.name, type: ch.type, parentId: ch.parentId || null,
      overwrites: [...ch.permissionOverwrites.cache.values()].map(o => ({
        id: o.id, type: o.type, name: o.type === 0 ? (roles.get(o.id)?.name || o.id) : `member:${o.id}`,
        allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString(),
      })),
    };
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  return { channels: channels.length, overwrites: Object.values(manifest).reduce((n, c) => n + c.overwrites.length, 0) };
}

// Re-snapshot ONE channel's overwrites (role + member) into the golden manifest. For when another module
// legitimately changes a channel's overwrites (e.g. the MDNI minor-staff lock adds member-level denies) and
// wants permguard to treat the new state as correct — otherwise every sweep would re-flag it as drift.
async function blessChannel(guild, channelId) {
  const man = loadManifest(); if (!man) return false;
  const ch = await guild.channels.fetch(channelId).catch(() => null); if (!ch) return false;
  const roles = await guild.roles.fetch();
  man[channelId] = {
    name: ch.name, type: ch.type, parentId: ch.parentId || null,
    overwrites: [...ch.permissionOverwrites.cache.values()].map(o => ({
      id: o.id, type: o.type, name: o.type === 0 ? (roles.get(o.id)?.name || o.id) : `member:${o.id}`,
      allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString(),
    })),
  };
  try { fs.writeFileSync(MANIFEST_FILE, JSON.stringify(man, null, 2)); return true; } catch { return false; }
}

// Compare + fix ROLE overwrites (type 0) only. Member-specific overwrites (bot integrations, one-off
// grants) are far more likely to be a deliberate, still-valid special case added after the snapshot —
// auto-reverting those could undo something the owner meant to keep. Those are only ever REPORTED
// (a brand-new one appearing), never auto-corrected.
async function sweepPermissions(guild, { notify = true } = {}) {
  const manifest = loadManifest();
  if (!manifest) return { fixed: 0, corrections: [], newMemberOverwrites: [], unmanagedChannels: 0 };
  const channels = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const roles = await guild.roles.fetch();
  const corrections = [];
  const newMemberOverwrites = [];
  let unmanagedChannels = 0;

  for (const ch of channels) {
    const golden = manifest[ch.id];
    if (!golden) { unmanagedChannels++; continue; } // channel created after the snapshot - not managed

    const liveRole = new Map();
    const liveMember = new Map();
    for (const o of ch.permissionOverwrites.cache.values()) {
      (o.type === 0 ? liveRole : liveMember).set(o.id, o);
    }
    const goldenRole = new Map(golden.overwrites.filter(o => o.type === 0).map(o => [o.id, o]));
    const goldenMember = new Map(golden.overwrites.filter(o => o.type === 1).map(o => [o.id, o]));

    // Every role the manifest knows about for this channel — golden's value must match exactly.
    const allRoleIds = new Set([...liveRole.keys(), ...goldenRole.keys()]);
    for (const roleId of allRoleIds) {
      const live = liveRole.get(roleId);
      const desired = goldenRole.get(roleId);
      // Managed roles = bot/integration roles Discord auto-creates (Carl-bot, boosters, other bots). A
      // channel overwrite for one is a deliberate integration grant, not drift, so NEVER auto-revert it
      // (else we keep undoing the owner's bot setup — e.g. Carl-bot's welcome-message SendMessages getting
      // stripped every sweep). Left in place silently, exactly like member-specific overwrites below.
      if (roles.get(roleId)?.managed) continue;
      const liveAllow = live ? live.allow.bitfield.toString() : '0';
      const liveDeny = live ? live.deny.bitfield.toString() : '0';
      const desiredAllow = desired ? desired.allow : '0';
      const desiredDeny = desired ? desired.deny : '0';
      if (liveAllow === desiredAllow && liveDeny === desiredDeny) continue;

      const roleName = desired?.name || live?.name || roleId;
      try {
        if (desired) {
          await guild.client.rest.put(Routes.channelPermission(ch.id, roleId), { body: { id: roleId, type: 0, allow: desiredAllow, deny: desiredDeny } });
        } else {
          await guild.client.rest.delete(Routes.channelPermission(ch.id, roleId));
        }
        corrections.push({ channel: ch.name, channelId: ch.id, role: roleName, before: { allow: liveAllow, deny: liveDeny }, after: { allow: desiredAllow, deny: desiredDeny } });
      } catch (err) {
        console.error(`[permguard] fix ${ch.name}/${roleName}: ${err.message}`);
      }
    }

    // Member overwrites: only flag brand-new ones the manifest never saw. Never auto-remove.
    for (const [memberId, live] of liveMember) {
      if (!goldenMember.has(memberId)) {
        newMemberOverwrites.push({ channel: ch.name, channelId: ch.id, memberId });
      }
    }
  }

  if (corrections.length) {
    console.log(`[permguard] corrected ${corrections.length} drifted overwrite(s)`);
    if (notify) {
      const lines = corrections.slice(0, 10).map(c => `• **#${c.channel}** — ${c.role}: restored to allow=${c.after.allow}/deny=${c.after.deny}`).join('\n');
      await ownerlog.log(guild, {
        emoji: '🛡️', title: `Permission drift auto-corrected (${corrections.length})`, color: 0xE67E22,
        detail: lines + (corrections.length > 10 ? `\n…and ${corrections.length - 10} more.` : ''),
      });
    }
  }
  if (newMemberOverwrites.length && notify) {
    const lines = newMemberOverwrites.slice(0, 10).map(m => `• **#${m.channel}** — new member-specific override for <@${m.memberId}> (not auto-reviewed, check it's intentional)`).join('\n');
    await ownerlog.log(guild, { emoji: '🔍', title: `New per-member channel override(s) detected (${newMemberOverwrites.length})`, color: 0x99AAB5, detail: lines });
  }
  return { fixed: corrections.length, corrections, newMemberOverwrites, unmanagedChannels };
}

// ---- auto-adopt trusted (owner) permission changes -------------------------------------------------
// Discord doesn't push overwrite changes to the bot directly, so this polls the audit log the same way
// ownerlog.js does. When a channel-overwrite (or brand-new channel) entry's executor is the owner —
// bot owner by ID, or the live guild owner, or OWNER-role+Admin tier — that channel is immediately
// re-blessed into the baseline. Nobody else's changes get this treatment; those still show up as drift
// on the next sweep and get reverted/flagged as before. Note: blessChannel snapshots the channel's
// FULL current live state, not just the one changed overwrite — if someone else's change landed on the
// same channel in between, it rides along. Same tradeoff every other blessChannel() call site accepts.
const AUDIT_STATE_FILE = process.env.FUBU_PERMGUARD_AUDIT_STATE_FILE || statePath('permguard_audit_state.json');
const OVERWRITE_EVENTS = new Set([
  AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete, AuditLogEvent.ChannelCreate,
]);

function loadAuditState() { try { return JSON.parse(fs.readFileSync(AUDIT_STATE_FILE, 'utf8')); } catch { return { lastId: null }; } }
function saveAuditState(s) { try { fs.writeFileSync(AUDIT_STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[permguard] audit state save:', e.message); } }

async function isTrustedOwner(guild, userId) {
  if (!userId) return false;
  if (userId === opspanel.BOT_OWNER_ID || userId === guild.ownerId) return true;
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  return !!member && opspanel.memberTier(member) === 'owner';
}

async function pollOwnerOverwrites(guild) {
  if (!loadManifest()) return 0;   // no baseline yet — nothing to auto-adopt into
  try {
    const st = loadAuditState();
    const page = await guild.fetchAuditLogs({ limit: 50 }).catch(() => null);
    if (!page) return 0;
    const entries = [...page.entries.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    if (!st.lastId) {   // first run: seed the watermark to "now", don't rescan server history
      const newest = entries[entries.length - 1];
      saveAuditState({ lastId: newest ? newest.id : '0' });
      return 0;
    }
    const fresh = entries.filter(e => BigInt(e.id) > BigInt(st.lastId) && OVERWRITE_EVENTS.has(e.action));
    if (fresh.length) {
      const blessed = new Set();
      for (const e of fresh) {
        const channelId = e.action === AuditLogEvent.ChannelCreate ? e.targetId : e.target?.id;
        if (!channelId || blessed.has(channelId)) continue;
        if (!(await isTrustedOwner(guild, e.executorId))) continue;
        if (await blessChannel(guild, channelId)) blessed.add(channelId);
      }
      if (blessed.size) {
        console.log(`[permguard] auto-adopted ${blessed.size} owner permission change(s) into the baseline`);
        await ownerlog.log(guild, {
          emoji: '🛡️', title: `Permission baseline auto-updated (${blessed.size})`, color: 0x57F287,
          detail: [...blessed].map(id => `• <#${id}>`).join('\n') + '\n(Adopted automatically — you made these changes directly.)',
        });
      }
    }
    saveAuditState({ lastId: entries[entries.length - 1].id });
    return fresh.length;
  } catch (e) { console.error('[permguard] pollOwnerOverwrites:', e.message); return 0; }
}

function register(client, { intervalMin = 20, ownerPollMin = 2 } = {}) {
  const run = async () => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    // Bless any owner-made changes FIRST so this sweep never reverts something you just changed.
    try { await pollOwnerOverwrites(guild); } catch (err) { console.error('[permguard] owner-poll (pre-sweep) failed:', err.message); }
    try { await sweepPermissions(guild); } catch (err) { console.error('[permguard] sweep failed:', err.message); }
  };
  const runOwnerPoll = async () => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    try { await pollOwnerOverwrites(guild); } catch (err) { console.error('[permguard] owner-poll failed:', err.message); }
  };
  setTimeout(run, 45 * 1000); // after boot self-heal + ownerlog channel are set up
  setInterval(run, intervalMin * 60 * 1000);
  setTimeout(runOwnerPoll, 30 * 1000);
  setInterval(runOwnerPoll, ownerPollMin * 60 * 1000);
  console.log(`[permguard] permission-drift sweep every ${intervalMin}min, owner-change auto-adopt poll every ${ownerPollMin}min`);
}

// ---- interactive reconcile ("diff + per-item Keep/Undo + Commit") -------------------------------
// Instead of blindly adopting whatever's live as the new golden (which enshrines any UNINTENDED change
// that crept in), this shows every difference vs the last baseline and lets the owner decide each one:
//   Keep  = adopt the change into the new baseline
//   Undo  = restore the OLD baseline's permission on the live channel, right here
// New channels get Adopt (guard it) / Ignore (leave unguarded). Deleted channels are dropped.

// One readable line describing how a live overwrite differs from golden (+/- allow, +/- deny perms).
function describeDelta(la, ld, ga, gd) {
  const parts = [];
  const laS = new Set(permList(la)), gaS = new Set(permList(ga));
  const ldS = new Set(permList(ld)), gdS = new Set(permList(gd));
  for (const p of laS) if (!gaS.has(p)) parts.push(`+allow ${p}`);
  for (const p of gaS) if (!laS.has(p)) parts.push(`−allow ${p}`);
  for (const p of ldS) if (!gdS.has(p)) parts.push(`+deny ${p}`);
  for (const p of gdS) if (!ldS.has(p)) parts.push(`−deny ${p}`);
  return parts.join(', ') || 'no effective change';
}

// Read-only: compute every difference between live perms and the golden manifest.
async function computeDiff(guild) {
  const manifest = loadManifest();
  if (!manifest) return { noManifest: true, items: [], removedChannels: [] };
  const channels = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const roles = await guild.roles.fetch();
  const liveIds = new Set(channels.map(c => c.id));
  const items = [];

  for (const ch of channels) {
    const golden = manifest[ch.id];
    if (!golden) {                                   // whole channel is new/unguarded
      items.push({ key: `ch|${ch.id}`, kind: 'newchannel', channelId: ch.id, channelName: ch.name,
        summary: `**NEW channel** (not yet guarded). Adopting it will lock its current permissions in.` });
      continue;
    }
    const live = { 0: new Map(), 1: new Map() };
    for (const o of ch.permissionOverwrites.cache.values()) live[o.type].set(o.id, o);
    const gold = { 0: new Map(), 1: new Map() };
    for (const o of golden.overwrites) gold[o.type].set(o.id, o);

    for (const type of [0, 1]) {
      for (const id of new Set([...live[type].keys(), ...gold[type].keys()])) {
        const L = live[type].get(id), G = gold[type].get(id);
        const la = L ? L.allow.bitfield.toString() : '0', ld = L ? L.deny.bitfield.toString() : '0';
        const ga = G ? G.allow : '0', gd = G ? G.deny : '0';
        if (la === ga && ld === gd) continue;        // identical → not a diff
        const name = type === 0 ? (G?.name || roles.get(id)?.name || id) : `member ${id}`;
        const who = type === 0 ? `role **${name}**` : `<@${id}>`;
        let summary;
        if (L && !G) summary = `#${ch.name}: NEW overwrite for ${who}: ${describeDelta(la, ld, ga, gd)}`;
        else if (!L && G) summary = `#${ch.name}: overwrite for ${who} was REMOVED (baseline had allow [${permList(ga).join(', ') || '-'}])`;
        else summary = `#${ch.name}: ${who}: ${describeDelta(la, ld, ga, gd)}`;
        items.push({ key: `${ch.id}|${type}|${id}`, kind: type === 0 ? 'role' : 'member',
          channelId: ch.id, channelName: ch.name, targetId: id, targetType: type,
          la, ld, ga, gd, presentLive: !!L, presentGolden: !!G, summary });
      }
    }
  }
  const removedChannels = Object.keys(manifest).filter(id => !liveIds.has(id)).map(id => ({ id, name: manifest[id].name }));
  return { items, removedChannels };
}

// Short-lived per-session state for the popup (transient; fine to lose on restart).
const sessions = new Map();
let _sidN = 0;
const newSid = () => 'p' + Date.now().toString(36) + (_sidN++).toString(36);
const PER_PAGE = 4;

function renderReconcile(sid, s) {
  const { items, decisions } = s;
  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const pg = Math.min(s.page, pages - 1);
  const slice = items.slice(pg * PER_PAGE, pg * PER_PAGE + PER_PAGE);
  const undecided = items.filter(i => !decisions[i.key]).length;
  const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('🛡️ Reconcile permission changes')
    .setDescription(`**${items.length}** change(s) since the last baseline`
      + (s.removedChannels.length ? ` · ${s.removedChannels.length} guarded channel(s) no longer exist (will be dropped)` : '')
      + `\n**Keep** = adopt into the new baseline · **Undo** = restore the old permission live.`
      + `\nPage ${pg + 1}/${pages} · ${undecided} left to decide`);
  const rows = [];
  for (const it of slice) {
    const idx = items.indexOf(it);
    const d = decisions[it.key];
    embed.addFields({ name: `${d === 'keep' ? '✅ KEEP' : d === 'undo' ? '↩️ UNDO' : '• undecided'}: ${it.channelName}`.slice(0, 256), value: it.summary.slice(0, 1000) });
    const isNew = it.kind === 'newchannel';
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pg_keep:${sid}:${idx}`).setEmoji('✅').setLabel(isNew ? 'Adopt' : 'Keep').setStyle(d === 'keep' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`pg_undo:${sid}:${idx}`).setEmoji(isNew ? '🚫' : '↩️').setLabel(isNew ? 'Ignore' : 'Undo').setStyle(d === 'undo' ? ButtonStyle.Danger : ButtonStyle.Secondary)));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pg_prev:${sid}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(pg === 0),
    new ButtonBuilder().setCustomId(`pg_next:${sid}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(pg >= pages - 1),
    new ButtonBuilder().setCustomId(`pg_keepall:${sid}`).setLabel('Keep all').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`pg_undoall:${sid}`).setLabel('Undo all').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`pg_commit:${sid}`).setEmoji('✔️').setLabel(undecided ? `Commit (${undecided} left)` : 'Commit').setStyle(ButtonStyle.Primary).setDisabled(undecided > 0)));
  return { embeds: [embed], components: rows };
}

// Entry point from /permguard resnapshot (no force). The interaction is already deferred (ephemeral).
async function openReconcile(interaction) {
  // purge stale sessions (>15min) so the map can't grow unbounded
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of sessions) if (v.createdAt < cutoff) sessions.delete(k);

  const diff = await computeDiff(interaction.guild);
  if (diff.noManifest) return interaction.editReply('No baseline exists yet. Run `/permguard resnapshot force:true` once to create the first one.');
  if (!diff.items.length && !diff.removedChannels.length)
    return interaction.editReply('✅ Nothing has changed since the last baseline. Nothing to reconcile.');
  const sid = newSid();
  sessions.set(sid, { items: diff.items, removedChannels: diff.removedChannels, decisions: {}, page: 0, createdAt: Date.now(), userId: interaction.user.id });
  return interaction.editReply(renderReconcile(sid, sessions.get(sid)));
}

function isReconcileInteraction(i) {
  return i.isButton?.() && i.customId?.startsWith('pg_');
}

async function handleReconcile(interaction) {
  if (!['owner', 'botowner'].includes(opspanel.tierOf(interaction)))
    return interaction.reply({ content: '🔒 Owner only.', flags: EPH });
  const [action, sid, idxStr] = interaction.customId.split(':');
  const s = sessions.get(sid);
  if (!s) return interaction.update({ content: 'This reconcile session expired. Run `/permguard resnapshot` again.', embeds: [], components: [] }).catch(() => interaction.reply({ content: 'Session expired. Run `/permguard resnapshot` again.', flags: EPH }));

  if (action === 'pg_prev') { s.page = Math.max(0, s.page - 1); return interaction.update(renderReconcile(sid, s)); }
  if (action === 'pg_next') { s.page = s.page + 1; return interaction.update(renderReconcile(sid, s)); }
  if (action === 'pg_keep') { const it = s.items[Number(idxStr)]; if (it) s.decisions[it.key] = 'keep'; return interaction.update(renderReconcile(sid, s)); }
  if (action === 'pg_undo') { const it = s.items[Number(idxStr)]; if (it) s.decisions[it.key] = 'undo'; return interaction.update(renderReconcile(sid, s)); }
  if (action === 'pg_keepall') { for (const it of s.items) if (!s.decisions[it.key]) s.decisions[it.key] = 'keep'; return interaction.update(renderReconcile(sid, s)); }
  if (action === 'pg_undoall') { for (const it of s.items) if (!s.decisions[it.key]) s.decisions[it.key] = 'undo'; return interaction.update(renderReconcile(sid, s)); }
  if (action === 'pg_commit') {
    await interaction.deferUpdate();
    const res = await applyDecisions(interaction.guild, s, interaction.user.id);
    sessions.delete(sid);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🛡️ Reconcile committed').setDescription(res.summary)], components: [] });
  }
}

// Apply the owner's per-item decisions: Undo restores the old baseline live; Keep leaves live as-is;
// then re-snapshot the (now-resolved) live state as the new golden, excluding any ignored new channels.
async function applyDecisions(guild, s, userId) {
  let reverted = 0, kept = 0, adopted = 0, ignored = 0;
  const dropped = s.removedChannels.length;
  const exclude = new Set();
  for (const it of s.items) {
    const d = s.decisions[it.key] || 'keep';
    if (it.kind === 'newchannel') { if (d === 'keep') adopted++; else { ignored++; exclude.add(it.channelId); } continue; }
    if (d === 'keep') { kept++; continue; }                       // live stays; the resnapshot below blesses it
    try {                                                         // undo → put the old baseline back on the live channel
      if (it.presentGolden) await guild.client.rest.put(Routes.channelPermission(it.channelId, it.targetId), { body: { id: it.targetId, type: it.targetType, allow: it.ga, deny: it.gd } });
      else await guild.client.rest.delete(Routes.channelPermission(it.channelId, it.targetId));
      reverted++;
    } catch (e) { console.error(`[permguard] reconcile revert ${it.key}: ${e.message}`); }
  }
  const snap = await resnapshot(guild, { exclude });
  await ownerlog.log(guild, { emoji: '🛡️', title: 'Permission baseline reconciled', color: 0x57F287,
    detail: `By <@${userId}> — reverted ${reverted}, kept ${kept}, new channels adopted ${adopted}${ignored ? `, ignored ${ignored}` : ''}${dropped ? `, dropped ${dropped} deleted channel(s)` : ''}. New baseline: ${snap.channels} channels.` });
  return { summary: `Reverted **${reverted}** change(s) to the old baseline, kept **${kept}**, adopted **${adopted}** new channel(s)${ignored ? `, left **${ignored}** unguarded` : ''}${dropped ? `, dropped **${dropped}** deleted channel(s)` : ''}.\n\n📸 New baseline saved: **${snap.channels}** channels, **${snap.overwrites}** overwrite entries.` };
}

module.exports = { sweepPermissions, resnapshot, loadManifest, blessChannel, register, computeDiff, openReconcile, isReconcileInteraction, handleReconcile, renderReconcile };
