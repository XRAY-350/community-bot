// index.js — entry point. Boots the discord.js client, resolves the verify + alert channels
// once at ready, and wires the verify trigger (role → close) and the periodic sweep (nudge + stale).
//
// Intents: Guilds (channels/threads) + GuildMembers (PRIVILEGED — required to receive
// guildMemberUpdate so we can see the Verified role being assigned). The GuildMembers intent
// must also be enabled in the Discord Developer Portal for this application.

const { Client, GatewayIntentBits, Partials, PermissionsBitField, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContextMenuCommandBuilder, ApplicationCommandType, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { MessageFlags } = require('discord.js');
const config = require('./config');
const State = require('./state');
const verify = require('./verify');
const sweep = require('./sweep');
const reactresolve = require('./reactresolve');
const corner = require('./corner');
const { buildVerifyPanel, handleVerifyButton, isVerifyButton } = require('./verifypanel');
const { activeThreads } = require('./threads');
const opspanel = require('./opspanel');
const watchlist = require('./watchlist');
const suggest = require('./suggest');
const suggestions = require('./suggestions');
const confessions = require('./confessions');
const whistleblow = require('./whistleblow');
const reports = require('./reports');
const modmail = require('./modmail');
const modapps = require('./modapps');
const langmods = require('./langmods');
const promote = require('./promote');
const ownerlog = require('./ownerlog');
const permguard = require('./permguard');
const rolereq = require('./rolereq');
const appeals = require('./appeals');
const strikeAppeals = require('./strikeAppeals');
const features = require('./features');
const contest = require('./contest');
const smartwatch = require('./smartwatch');
const rules = require('./rules');
const strikes = require('./strikes');
const roleselect = require('./roleselect');
const fs = require('fs');

// ── Themed corner announcements (serious, jail-themed embeds posted in the corner channel) ──
const CORNER_RED = 0x992D22;    // sent to the corner
const CORNER_GREEN = 0x2ECC71;  // released
const CORNER_AMBER = 0xE67E22;  // sentence changed / release scheduled (a modification, not entry/exit)
// The server's 11 rules (rules.js is the single source of truth — text + per-rule weight live there
// now) — TITLES is a drop-in replacement for the old hardcoded array, used by the /corner + /strike
// add "why" pickers.
const SERVER_RULES = rules.TITLES;
// Sent to the corner. whenPhrase = `until <t:…:f>` or `indefinitely`. reason optional.
// Humanize a duration in ms → "2d 3h" / "45m" / "30s" (compact, up to two units).
function humanDur(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
  if (h) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  if (m) return `${m}m`;
  return `${s}s`;
}
// "Time served" suffix for release messages — only when the timeServed feature is on.
function servedSuffix(servedMs) {
  return (features.enabled('timeServed') && servedMs) ? ` · in for **${humanDur(servedMs)}**` : '';
}

function cornerSentMessage(userId, whenPhrase, reason) {
  return {
    // Hybrid: big rendered header in message CONTENT (headers don't render inside embeds), with the
    // colored embed below so the meaningful red/green signal is kept. The mention is in CONTENT (not
    // just the embed) because embeds can never ping — this is a real notification, it should reach them.
    content: `## ⛓️ SENT TO THE CORNER\n<@${userId}>`,
    embeds: [new EmbedBuilder().setColor(CORNER_RED)
      .setDescription(`<@${userId}> has been stripped of their roles and confined here **${whenPhrase}**.`
        + (reason ? `\n\n**Reason:** ${reason}` : '')
        + `\n\nThis is the only channel you may speak in. Reflect on what brought you here.`)],
    // Mod controls: release now, add time (+1h / +1d), or set indefinite (no auto-release) — one click.
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:0`).setEmoji('🔓').setLabel('Release now').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:3600000`).setEmoji('⏰').setLabel('+1h').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:86400000`).setEmoji('⏰').setLabel('+1d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:indef`).setEmoji('♾️').setLabel('Indefinite').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { users: [userId] },
  };
}

// Post a FULLY STYLIZED audit entry to the public corner-log channel for every corner event
// (entry / exit / sentence change). Each entry mirrors the channel style — a `## HEADER` in content
// plus a colored embed — but folds in the audit facts the user-facing message omits (who acted,
// target, release time). No mod buttons: the log is a read-only record, not an action surface.
// allowedMentions parse:[] renders the @names without pinging anyone on every line.
async function logCorner(guild, entry) {
  try {
    const ch = await guild.channels.fetch(config.cornerLogChannelId).catch(() => null);
    if (ch) {
      // Back-compat: a bare string still posts as a plain line.
      if (typeof entry === 'string') await ch.send({ content: entry, allowedMentions: { parse: [] } });
      else {
        const { emoji, title, color, desc } = entry;
        await ch.send({ content: `## ${emoji} ${title}`, embeds: [new EmbedBuilder().setColor(color).setDescription(desc)], allowedMentions: { parse: [] } });
      }
    }
    // Mirror to the owner-only log too — covers every corner/uncorner call site in one place.
    if (typeof entry !== 'string') await ownerlog.log(guild, { emoji: entry.emoji, title: entry.title, detail: entry.desc, color: entry.color });
  } catch (e) { console.error(`[corner-log] ${e.message}`); }
}
// Small helper: "<t:..:R> (<t:..:f>)" from an epoch-ms release time, for audit embeds.
function relPhrase(releaseAt) {
  const s = Math.floor(releaseAt / 1000);
  return `<t:${s}:R> (<t:${s}:f>)`;
}

// Mod gate shared by the button handlers below (MOD role, Administrator overrides).
function modClicked(interaction) {
  return (config.modRoleId && interaction.member?.roles?.cache?.has(config.modRoleId))
    || interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

// /pending — paginated, read-only list of open verify threads (verifying happens in-thread, not here).
async function renderPending(page) {
  const verifyCh = getVerifyChannel();
  let threads = verifyCh ? await activeThreads(verifyCh) : [];
  threads = threads.filter(t => t.parentId === config.verifyChannelId)
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));   // oldest first
  const PER = 10;
  const pages = Math.max(1, Math.ceil(threads.length / PER));
  page = Math.min(Math.max(0, page || 0), pages - 1);
  const slice = threads.slice(page * PER, page * PER + PER);
  const lines = slice.map((t, i) =>
    `${page * PER + i + 1}. ${t} — <@${t.ownerId}> · opened <t:${Math.floor((t.createdTimestamp || Date.now()) / 1000)}:R>`);
  const content = `## 🧵 Pending Verify Threads (${threads.length})\n${lines.join('\n') || '_none open_'}\n-# Page ${page + 1}/${pages}`;
  const components = pages > 1 ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pending_page:${page - 1}`).setEmoji('◀️').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`pending_page:${page + 1}`).setEmoji('▶️').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  )] : [];
  return { content, components };
}

// Daily-digest mod-control buttons: run the sweep on demand, or pull up the corner list.
async function handleDigestButton(interaction) {
  if (!modClicked(interaction)) return interaction.reply({ content: 'Only the mod role can use this.', flags: MessageFlags.Ephemeral });
  if (interaction.customId === 'digest_cornered') return handleCorneredList(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });   // digest_sweep
  try {
    await sweep.runOnce(client, state, { getVerifyChannel, getAlertChannel, getWarnChannel, getConflictChannel });
    return interaction.editReply('🧹 Sweep complete — threads, warnings and conflicts refreshed.');
  } catch (e) {
    return interaction.editReply(`Sweep failed: ${e.message}`);
  }
}

// /cornered — mod tool: list everyone in the corner, each with a one-click Release button.
async function handleCorneredList(interaction) {
  if (!modClicked(interaction)) return interaction.reply({ content: 'Only the mod role can use this.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const cornered = state.listCornered();
  const ids = Object.keys(cornered);
  if (!ids.length) return interaction.editReply('✅ No one is in the corner.');
  const shown = ids.slice(0, 20);                    // Discord caps at 5 buttons/row × 5 rows
  const lines = [];
  const rows = [];
  let row = new ActionRowBuilder();
  for (const id of shown) {
    const rec = cornered[id] || {};
    const rel = rec.releaseAt ? `<t:${Math.floor(rec.releaseAt / 1000)}:R>` : 'indefinite';
    const inFor = rec.at ? `in since <t:${Math.floor(rec.at / 1000)}:R> · ` : '';
    const m = await interaction.guild.members.fetch(id).catch(() => null);
    const tag = m?.user?.tag || id;
    lines.push(`• <@${id}> (\`${tag}\`) — ${inFor}release ${rel}`);
    row.addComponents(new ButtonBuilder().setCustomId(`corner_rel:${id}:0`).setEmoji('🔓')
      .setLabel(`Release ${tag}`.slice(0, 80)).setStyle(ButtonStyle.Success));
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  }
  if (row.components.length) rows.push(row);
  const extra = ids.length > shown.length ? `\n…and ${ids.length - shown.length} more.` : '';
  return interaction.editReply({ content: `## 🚫 In the Corner (${ids.length})\n${lines.join('\n')}${extra}`, components: rows });
}

// Corner announcement buttons: 🔓 Release now / ⏰ +1h / ⏰ +1d (add time, or from now if indefinite).
// Shared "send this member to the corner for THIS message" — used by the immediate right-click path
// and (when the cornerReason feature is on) the reason-modal path. Optional reason is surfaced in the
// corner channel + the audit log. Defaults to a TIMED corner (config.cornerDefaultDurationMs) — Corner
// is meant to be casual/temporary, not indefinite by default. Returns { ok, stripped, error }.
async function cornerFromMessage(guild, actorId, member, target, reason) {
  const durationMs = config.cornerDefaultDurationMs;
  const r = await corner.corner(guild, member, durationMs, state, actorId);
  if (!r.ok) return { ok: false, error: r.error };
  const relSec = Math.floor((Date.now() + durationMs) / 1000);
  const whenPhrase = `until <t:${relSec}:f>`;
  try {
    const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
    if (cornerCh) {
      await cornerCh.send(cornerSentMessage(member.id, whenPhrase, reason || null));
      const emb = new EmbedBuilder().setColor(CORNER_RED)
        .setAuthor({ name: target.author.tag, iconURL: target.author.displayAvatarURL() })
        .setDescription(target.content?.slice(0, 4000) || '_[no text — see attachment/link]_')
        .addFields({ name: 'Why they’re here', value: `Cornered for this message by <@${actorId}>${reason ? `\n**Reason:** ${reason}` : ''}` })
        .setFooter({ text: `originally in #${target.channel?.name || '?'}` }).setTimestamp(target.createdTimestamp);
      const files = [...(target.attachments?.values() || [])].slice(0, 5).map(a => a.url);
      await cornerCh.send({ embeds: [emb], content: files.length ? files.join('\n') : undefined, allowedMentions: { parse: [] } });
    }
  } catch (e) { console.error(`[corner-msg] forward failed: ${e.message}`); }
  // In-channel notice on the flagged message (no DM) — same pattern the Strike flows use.
  await target.reply(`⛓️ This message got <@${member.id}> sent to the corner${reason ? `: ${reason}` : '.'}`).catch(e => console.error('[corner-msg] reply on original failed:', e.message));
  await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER (via message)', color: CORNER_RED,
    desc: `<@${member.id}> was cornered until ${relPhrase(relSec * 1000)} for a message.\n**By:** <@${actorId}>${reason ? `\n**Reason:** ${reason}` : ''}\n**Message:** ${target.url}` });
  return { ok: true, stripped: r.stripped };
}

async function handleCornerButton(interaction) {
  const [, userId, msStr] = interaction.customId.split(':');   // corner_rel:<userId>:<ms>  or  corner_recorner:<userId>
  const ms = Number(msStr || 0);
  if (!modClicked(interaction)) return interaction.reply({ content: 'Only the mod role can use this.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });   // ack is private; the corner-log channel is the public record
  const guild = interaction.guild;
  // Re-corner (from a release announcement): send them straight back, indefinitely.
  if (interaction.customId.startsWith('corner_recorner:')) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return interaction.editReply('That member is no longer in the server.');
    if (member.permissions.has(PermissionsBitField.Flags.Administrator) || member.id === guild.ownerId) {
      return interaction.editReply('You cannot corner an admin.');
    }
    const r = await corner.corner(guild, member, null, state, interaction.user.id);
    if (!r.ok) return interaction.editReply(`Failed to re-corner: ${r.error}`);
    try {
      const ch = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
      if (ch) await ch.send(cornerSentMessage(userId, 'indefinitely'));
    } catch (e) { console.error(`[recorner] announce failed: ${e.message}`); }
    await logCorner(guild, { emoji: '⛓️', title: 'RE-CORNERED', color: CORNER_RED,
      desc: `<@${userId}> was sent straight back to the corner **indefinitely**.\n**By:** <@${interaction.user.id}>` });
    return interaction.editReply(`⛓️ Re-cornered <@${userId}> — stripped **${r.stripped}** role(s).`);
  }
  if (msStr === 'indef') {
    const rec = state.getCornered(userId);
    if (!rec) return interaction.editReply(`<@${userId}> is not in the corner.`);
    state.setCornered(userId, { ...rec, releaseAt: null });   // null = never auto-released
    await logCorner(guild, { emoji: '♾️', title: 'SENTENCE CHANGED', color: CORNER_AMBER,
      desc: `<@${userId}>'s corner is now **indefinite** (no auto-release).\n**By:** <@${interaction.user.id}>` });
    return interaction.editReply(`♾️ <@${userId}> is now cornered **indefinitely** — they stay until manually released.`);
  }
  if (ms === 0) {
    const r = await corner.uncorner(guild, userId, state);
    if (!r.ok) return interaction.editReply(`Failed to release: ${r.error}`);
    const served = servedSuffix(r.servedMs);
    try {
      const ch = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
      if (ch) await ch.send(cornerReleasedMessage(userId));
    } catch (e) { console.error(`[corner-btn] announce failed: ${e.message}`); }
    await logCorner(guild, { emoji: '🔓', title: 'RELEASED', color: CORNER_GREEN,
      desc: `<@${userId}> was released — roles restored.\n**By:** <@${interaction.user.id}>${served}` });
    return interaction.editReply(`✅ Released <@${userId}> — restored **${r.restored}** role(s)${served}.`);
  }
  const rec = state.getCornered(userId);
  if (!rec) return interaction.editReply(`<@${userId}> is not in the corner.`);
  const baseline = (rec.releaseAt && rec.releaseAt > Date.now()) ? rec.releaseAt : Date.now();
  const releaseAt = baseline + ms;
  state.setCornered(userId, { ...rec, releaseAt });
  await logCorner(guild, { emoji: '⏰', title: 'SENTENCE CHANGED', color: CORNER_AMBER,
    desc: `<@${userId}>'s release time was changed.\n**New release:** ${relPhrase(releaseAt)}\n**By:** <@${interaction.user.id}>` });
  return interaction.editReply(`⏳ <@${userId}> will now be released <t:${Math.floor(releaseAt / 1000)}:R> (<t:${Math.floor(releaseAt / 1000)}:f>).`);
}

// Conflict-flag buttons: strip exactly one of the two conflicting roles (mod chooses which stays).
async function handleConflictButton(interaction) {
  const [, userId, which] = interaction.customId.split(':');  // conflict_rm:<userId>:<unver|ver>
  if (!modClicked(interaction)) return interaction.reply({ content: 'Only the mod role can resolve conflicts.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!member) return interaction.editReply('That member is no longer in the server.');
  const roleId = which === 'unver' ? config.unverifiedRoleId : config.verifiedRoleId;
  const roleName = which === 'unver' ? 'Unverified' : 'Verified';
  const kept = which === 'unver' ? 'Verified' : 'Unverified';
  try {
    await member.roles.remove(roleId, `Conflict resolved by ${interaction.user.tag}`);
  } catch (e) {
    return interaction.editReply(`Failed to remove ${roleName}: ${e.message}`);
  }
  await interaction.editReply(`✅ Removed **${roleName}** from ${member.user.tag} (now **${kept}**).`);
  await interaction.message.edit({
    content: `## ✅ Conflict Resolved\n<@${userId}> — **${roleName}** removed by <@${interaction.user.id}> (kept **${kept}**).`,
    components: [],
    allowedMentions: { parse: [] }, // mod-only conflict channel - the flagged member can't see it, never actually ping them here
  }).catch(() => {});
}
// Released manually via /uncorner (no duration).
// Re-corner button for the release announcements — one click puts them straight back if they act up.
function recornerRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`corner_recorner:${userId}`).setEmoji('⛓️').setLabel('Re-corner').setStyle(ButtonStyle.Danger),
  );
}
function cornerReleasedMessage(userId) {
  return {
    content: '## 🔓 RELEASED FROM THE CORNER',
    embeds: [new EmbedBuilder().setColor(CORNER_GREEN)
      .setDescription(`<@${userId}> has been released. Your roles have been restored. Do not end up back here.`)],
    components: [recornerRow(userId)],
    allowedMentions: { users: [userId] },
  };
}
// Released automatically when a timed corner expires ("time served").
function cornerTimeServedMessage(userId) {
  return {
    content: '## ⛓️‍💥 TIME SERVED',
    embeds: [new EmbedBuilder().setColor(CORNER_GREEN)
      .setDescription(`<@${userId}>'s sentence has ended. The Corner releases you — roles restored, `
        + `access returned. Consider this your warning.`)],
    components: [recornerRow(userId)],
    allowedMentions: { users: [userId] },
  };
}

const state = new State(config.stateFile);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],   // watchlist keyword monitor
  // GuildMember partial lets guildMemberUpdate fire even when the old member wasn't cached.
  // Message/Reaction partials let messageReactionAdd fire for the (old, uncached) weekly message.
  partials: [Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User],
});

let verifyChannel = null;
let alertChannel = null;
let warnChannel = null;
let conflictChannel = null;
const getVerifyChannel = () => verifyChannel;
const getAlertChannel = () => alertChannel;
const getWarnChannel = () => warnChannel;
const getConflictChannel = () => conflictChannel;

// Inject the bot's own logic into the tier-gated ops dashboard so it reuses corner/sweep/state/etc.
opspanel.wire({ client, config, state, corner, sweep, activeThreads,
  getVerifyChannel, getAlertChannel, getWarnChannel, getConflictChannel,
  logAction: ownerlog.log,
  strike: {
    BAN_THRESHOLD: strikes.BAN_THRESHOLD,
    total: member => strikes.totalUnits(state, member.id),
    up: async (guild, member, byTag) => {
      const res = await strikes.addStrike(guild, member, state, { weight: 1, reason: 'Quick 1-unit strike via dashboard picker', byTag });
      await ownerlog.log(guild, { emoji: '⚠️', title: 'Strike given', color: 0xED4245, detail: `<@${member.id}> — 1 unit (quick dashboard strike) — by ${byTag}. Now ${strikes.formatUnits(res.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return res;
    },
    down: async (guild, member, byTag) => {
      const active = strikes.activeEntries(state, member.id);
      if (!active.length) return { ok: false };
      const r = await strikes.removeStrike(guild, member, state, active[active.length - 1].id, byTag);
      if (r.ok) await ownerlog.log(guild, { emoji: '➖', title: 'Strike removed', color: 0x57F287, detail: `Most recent strike from <@${member.id}> — by ${byTag}. Now ${strikes.formatUnits(r.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return r;
    },
    clear: async (guild, member, byTag) => {
      const r = await strikes.clearStrikes(guild, member, state, byTag);
      if (r.cleared) await ownerlog.log(guild, { emoji: '🧹', title: 'Strikes cleared', color: 0x57F287, detail: `All strikes (${r.cleared}) on <@${member.id}> — by ${byTag}.` });
      return r;
    },
    entries: member => strikes.activeEntries(state, member.id),
    label: entry => strikes.entryLabel(entry),
    removeById: async (guild, member, strikeId, byTag) => {
      const r = await strikes.removeStrike(guild, member, state, strikeId, byTag);
      if (r.ok) await ownerlog.log(guild, { emoji: '➖', title: 'Strike removed', color: 0x57F287, detail: `\`${strikeId}\` from <@${member.id}> — by ${byTag}. Now ${strikes.formatUnits(r.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return r;
    },
    activeMembers: () => strikes.activeMembers(state),
    format: strikes.formatUnits,
    // Reuses the SAME rule-picker → reason+weight-modal → addStrike flow already wired for the
    // watch-log/right-click Strike buttons (strike_rule_pick:/strike_reason: handlers below) — the
    // dashboard just needs to kick it off with channelId/messageId=0 (no specific flagged message).
    ruleRow: uid => ruleRow(`strike_rule_pick:${uid}:0:0`),
  } });

async function resolveChannels() {
  const guild = await client.guilds.fetch(config.guildId);
  verifyChannel = await guild.channels.fetch(config.verifyChannelId);
  if (!verifyChannel || !verifyChannel.threads) {
    throw new Error(`VERIFY_CHANNEL_ID ${config.verifyChannelId} is not a thread-capable text channel`);
  }
  alertChannel = config.alertChannelId === config.verifyChannelId
    ? verifyChannel
    : await guild.channels.fetch(config.alertChannelId);
  warnChannel = config.warnChannelId === config.verifyChannelId
    ? verifyChannel
    : await guild.channels.fetch(config.warnChannelId);
  conflictChannel = config.modConflictChannelId
    ? await guild.channels.fetch(config.modConflictChannelId).catch(() => null)
    : null;
}

// Report whether the bot actually holds every permission its actions require. Kick is a
// guild-level permission; the thread/message ones are checked in the specific channels. Logs a
// clear OK/MISSING table at boot so "ready for prod" is verified, not assumed.
async function checkPermissions() {
  const F = PermissionsBitField.Flags;
  const me = await verifyChannel.guild.members.fetch(client.user.id);
  const rows = [];
  const add = (name, has) => rows.push(`${has ? 'OK     ' : 'MISSING'}  ${name}`);

  add('Kick Members (server)', me.permissions.has(F.KickMembers));
  const vp = verifyChannel.permissionsFor(me);
  add('View Channel (verify)', vp.has(F.ViewChannel));
  add('Manage Threads (verify)', vp.has(F.ManageThreads));
  add('Send Messages in Threads (verify)', vp.has(F.SendMessagesInThreads));
  add('Read Message History (verify)', vp.has(F.ReadMessageHistory));
  add('Send Messages (warn channel)', warnChannel.permissionsFor(me).has(F.SendMessages));
  add('Send Messages (alert channel)', alertChannel.permissionsFor(me).has(F.SendMessages));
  if (conflictChannel) add('Send Messages (conflict channel)', conflictChannel.permissionsFor(me).has(F.SendMessages));

  console.log('[perms] capability check:\n  ' + rows.join('\n  '));
  const missing = rows.filter(r => r.startsWith('MISSING')).length;
  if (missing) console.warn(`[perms] ${missing} permission(s) MISSING — those actions will fail until granted`);
  else console.log('[perms] all required permissions present ✓');
  return missing;
}

// Self-heal: if the bot can't post in the verify channel but DOES have Manage Roles, grant itself
// Send Messages + Send Messages in Threads there via a channel permission overwrite. This is why
// the owner granted Manage Roles. Runs each boot but only acts when something is actually missing.
async function healPermissions() {
  const F = PermissionsBitField.Flags;
  const me = await verifyChannel.guild.members.fetch(client.user.id);
  const hasManageRoles = me.permissions.has(F.ManageRoles);

  // (channel, {threads}) → add a self-overwrite granting posting perms if the bot lacks them.
  const ensurePosting = async (channel, threads) => {
    if (!channel) return;
    const p = channel.permissionsFor(me);
    const need = !p.has(F.SendMessages) || (threads && !p.has(F.SendMessagesInThreads));
    if (!need) return;
    if (!hasManageRoles) {
      console.warn(`[perms] can't self-heal posting in #${channel.name} (no Manage Roles) — grant it or the perms manually`);
      return;
    }
    try {
      const grant = { ViewChannel: true, SendMessages: true };
      if (threads) grant.SendMessagesInThreads = true;
      await channel.permissionOverwrites.edit(client.user.id, grant,
        { reason: 'fubu-verify-bot self-heal: grant own posting perms' });
      console.log(`[perms] self-heal applied — granted the bot posting perms in #${channel.name}`);
    } catch (err) {
      console.error(`[perms] self-heal failed for #${channel.name}: ${err.message}`);
    }
  };

  await ensurePosting(verifyChannel, true);
  if (conflictChannel && conflictChannel.id !== verifyChannel.id) await ensurePosting(conflictChannel, false);
}

// Keep the mod-dashboard channel tidy (weekly): delete non-pinned messages; the pinned panel stays.
// Discord's bulkDelete only removes messages < 14 days old; older ones are left (rare for weekly).
async function cleanDashboard(guild) {
  if (!config.dashboardChannelId) return 0;
  const ch = await guild.channels.fetch(config.dashboardChannelId).catch(() => null);
  if (!ch) return 0;
  let panelId = null; // never delete the dashboard panel, pinned or not
  try { panelId = JSON.parse(require('fs').readFileSync(opspanel.PANEL_FILE, 'utf8')).messageId; } catch { /* no ref */ }
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs || !msgs.size) break;
    const del = [...msgs.values()].filter(m => !m.pinned && m.id !== panelId);
    if (!del.length) break;
    const done = await ch.bulkDelete(del, true).catch(e => { console.error('[dashclean]', e.message); return null; });
    const n = done ? done.size : 0;
    total += n;
    if (n < del.length) break; // remaining are >14d - stop
  }
  return total;
}
// Weekly gate: clean when it's been ≥7 days since the last clean (checked hourly + on boot).
async function dashCleanTick(guild) {
  const WEEK = 7 * 24 * 3600 * 1000;
  if (Date.now() - (state.getMeta('lastDashCleanTs') || 0) < WEEK) return;
  state.setMeta('lastDashCleanTs', Date.now());
  const n = await cleanDashboard(guild);
  if (n) console.log(`[dashclean] removed ${n} message(s) from mod-dashboard`);
}

// --- Member-facing bot guide: one embed, shown by /help AND kept as a single continuously-edited
// message in the server-guide channel (re-rendered on every startup so it never goes stale).
const GUIDE_FILE = process.env.FUBU_GUIDE_FILE || '/home/ubuntu/.fubu_guide.json';
const SERVER_GUIDE_CH = process.env.FUBU_SERVER_GUIDE_CHANNEL_ID || '1516378825712472104';
function helpEmbed(guild) {
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle('🤖 What you can use the bot for')
    .setDescription('Most of these are **anonymous** — use any of them in any channel:')
    .addFields(...features.memberHelp())
    .setFooter({ text: 'Be kind, keep it real. 💛' });
  const icon = guild.iconURL({ size: 128 });
  if (icon) e.setThumbnail(icon);
  return e;
}
async function ensureGuide(guild) {
  const ch = await guild.channels.fetch(SERVER_GUIDE_CH).catch(() => null);
  if (!ch) return;
  let ref = {}; try { ref = JSON.parse(fs.readFileSync(GUIDE_FILE, 'utf8')); } catch {}
  const embed = helpEmbed(guild);
  if (ref.messageId) {
    const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
    if (msg) { await msg.edit({ content: '', embeds: [embed] }).catch(() => {}); return; }
  }
  const msg = await ch.send({ embeds: [embed] });
  fs.writeFileSync(GUIDE_FILE, JSON.stringify({ channelId: ch.id, messageId: msg.id }));
}

client.once('ready', async () => {
  console.log(`fubu-verify-bot online as ${client.user.tag}`);
  console.log(`Guilds: ${client.guilds.cache.map(g => `${g.name} (${g.id})`).join(', ') || '(none)'}`);
  try {
    await resolveChannels();
    // type 0 = text, 15 = forum. We built for text-with-threads; warn if it's a forum.
    const typeName = verifyChannel.type === 0 ? 'text' : verifyChannel.type === 15 ? 'FORUM' : `type ${verifyChannel.type}`;
    console.log(`Verify channel: #${verifyChannel.name} (${verifyChannel.id}) [${typeName}]`);
    console.log(`Alert channel:  #${alertChannel.name} (${alertChannel.id})`);
    console.log(`Warn channel:   #${warnChannel.name} (${warnChannel.id})  [thread-less warnings]`);
    console.log(`Conflict channel: ${conflictChannel ? `#${conflictChannel.name} (${conflictChannel.id})` : '(none set)'}  [dual-role flags]`);
    if (verifyChannel.type === 15) {
      console.warn('[boot] NOTE: verify channel is a FORUM. Nudges post to the forum root, which may fail; tell the maintainer if nudges error.');
    }
  } catch (err) {
    console.error(`[boot] FATAL resolving channels: ${err.message}`);
    process.exit(1);
  }
  try {
    const missing = await checkPermissions();
    if (missing) { await healPermissions(); await checkPermissions(); } // fix + confirm
  } catch (err) { console.error(`[perms] check failed: ${err.message}`); }
  if (config.dryRun) {
    console.log('DRY_RUN=true — actions will be LOGGED, not performed. Set DRY_RUN=false to go live.');
  }
  verify.register(client, state, getVerifyChannel);
  sweep.register(client, state, { getVerifyChannel, getAlertChannel, getWarnChannel, getConflictChannel });

  // Ops dashboard: create/refresh the pinned tier-gated panel in the mod-only dashboard channel
  // (channel id persisted in the panel ref file). Light 5-min refresh keeps counts current.
  opspanel.ensurePanel(client).catch(err => console.error('[fops] init:', err.message));
  // Static staff command reference — its own pinned message at the top of #mod-dashboard (kept off the
  // Overview page so the live panel stays lean as the toolkit grows).
  opspanel.ensureCommandRef(client).catch(err => console.error('[fops] cmdref init:', err.message));
  // Every 60s: refresh the shared panel's live counts AND run the idle auto-return (so an abandoned
  // page snaps back to Overview within ~90–150s). The private /panel isn't affected.
  setInterval(() => opspanel.refreshPanel(client).catch(() => {}), 60 * 1000);

  // Register the /corner and /uncorner slash commands to this guild (instant, no global wait).
  try {
    features.ensureSeeded(); // must run before allCmds is built - feature-gated options below read it
    const allCmds = [
      new SlashCommandBuilder().setName('corner').setDescription('Send a member to the corner (strips roles, jails them)')
        .addUserOption(o => o.setName('user').setDescription('Member to corner').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 3d — blank = indefinite').setRequired(false))
        .addStringOption(o => o.setName('rule').setDescription('Which rule did they break? (optional)').setRequired(false)
          .addChoices(...SERVER_RULES.map((r, i) => ({ name: `${i + 1}. ${r}`, value: String(i + 1) }))))
        .addStringOption(o => o.setName('reason').setDescription('Or type a custom reason (optional)').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('uncorner').setDescription('Release a member from the corner (or schedule a release)')
        .addUserOption(o => o.setName('user').setDescription('Member to release').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Optional — e.g. 30m, 2h, 3d — release automatically after this instead of now').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('cornered').setDescription('List everyone in the corner, with one-click release buttons')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('pending').setDescription('Browse open verify threads (paginated)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      // No Discord-level perm gate: trial mods (who lack Manage Roles) need to reach it too. The handler
      // gates — mod+ get the full panel, trial mods get the read-only view, everyone else is refused.
      new SlashCommandBuilder().setName('panel').setDescription('Open your private FUBU control panel (only you see it)'),
      new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID (optionally re-watchlist on rejoin)')
        .addStringOption(o => o.setName('user_id').setDescription("The banned user's ID — start typing a name to search").setRequired(true).setAutocomplete(true))
        .addBooleanOption(o => o.setName('watchlist').setDescription('Give them the Watchlist role when they rejoin'))
        .addStringOption(o => o.setName('reason').setDescription('Audit-log reason'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers),
      new SlashCommandBuilder().setName('watchlist').setDescription('Manage the Watchlist role on members')
        .addSubcommand(s => s.setName('add').setDescription('Put a member on the Watchlist').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Take a member off the Watchlist').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List everyone on the Watchlist'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('watchlist-terms').setDescription('Manage flagged terms — strict / loose / welfare')
        .addSubcommand(s => s.setName('add').setDescription('Flag a word or phrase')
          .addStringOption(o => o.setName('term').setDescription('Word or phrase').setRequired(true))
          .addStringOption(o => o.setName('scope').setDescription('Which list (default strict)').addChoices({ name: 'strict — watchlist ban alerts', value: 'strict' }, { name: 'loose — day-to-day watch-log', value: 'loose' }, { name: 'welfare — support check-ins', value: 'welfare' })))
        .addSubcommand(s => s.setName('remove').setDescription('Unflag a word or phrase')
          .addStringOption(o => o.setName('term').setDescription('Word or phrase').setRequired(true))
          .addStringOption(o => o.setName('scope').setDescription('Which list (default strict)').addChoices({ name: 'strict', value: 'strict' }, { name: 'loose', value: 'loose' }, { name: 'welfare', value: 'welfare' })))
        .addSubcommand(s => s.setName('list').setDescription('List flagged terms')
          .addStringOption(o => o.setName('scope').setDescription('Which list (default all)').addChoices({ name: 'strict', value: 'strict' }, { name: 'loose', value: 'loose' }, { name: 'welfare', value: 'welfare' })))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('watchlist-suggest').setDescription('Scan recent messages and recommend new watchlist terms')
        .addIntegerOption(o => o.setName('hours').setDescription('How far back to scan (default 6, max 24)').setMinValue(1).setMaxValue(24)),

      new SlashCommandBuilder().setName('suggest').setDescription('Post a suggestion to the suggestions forum')
        .addStringOption(o => o.setName('text').setDescription('Your suggestion').setRequired(true).setMaxLength(500)),
      new SlashCommandBuilder().setName('suggest-setup').setDescription('Create/repair the bot-gated suggestions forum (admin)'),

      new SlashCommandBuilder().setName('confess').setDescription('Send an anonymous confession')
        .addStringOption(o => o.setName('text').setDescription('Your confession (your name is hidden from other members)').setRequired(true).setMaxLength(1000)),
      new SlashCommandBuilder().setName('confess-setup').setDescription('Create/repair the confessions + staff log channels (admin)'),


      new SlashCommandBuilder().setName('whistleblow').setDescription('Privately DM a problem about the server/staff to the top — no channel, admins can’t snoop')
        .addStringOption(o => o.setName('to').setDescription('Who it goes to / who may unmask you').setRequired(true)
          .addChoices({ name: 'Head admin only', value: 'you' }, { name: 'Server owner only', value: 'her' },
            { name: 'Both', value: 'both' }, { name: 'Anonymous — both see it, no one can unmask', value: 'anonymous' }))
        .addStringOption(o => o.setName('text').setDescription('What’s the problem?').setRequired(true).setMaxLength(1500)),
      new SlashCommandBuilder().setName('whistleblow-setup').setDescription('Set who receives whistleblows — run as the head admin'),

      new SlashCommandBuilder().setName('report').setDescription('Anonymously report a member to staff')
        .addStringOption(o => o.setName('text').setDescription('What happened?').setRequired(true).setMaxLength(1000))
        .addUserOption(o => o.setName('user').setDescription('Who are you reporting? (optional)')),
      new SlashCommandBuilder().setName('report-setup').setDescription('Create the anon-reports channel (admin)'),
      new SlashCommandBuilder().setName('modmail').setDescription('Send an anonymous message to the mod team')
        .addStringOption(o => o.setName('text').setDescription('Your message').setRequired(true).setMaxLength(1000)),
      new SlashCommandBuilder().setName('modmail-setup').setDescription('Create the mod-inbox channel (admin)'),

      new SlashCommandBuilder().setName('apply-mod').setDescription('Apply to become a moderator'),
      new SlashCommandBuilder().setName('apply-mod-setup').setDescription('Create the private mod-applications forum (admin)'),
      new SlashCommandBuilder().setName('mod-applications').setDescription('Open or close mod applications when the team is full (admin)')
        .addSubcommand(s => s.setName('status').setDescription('Are mod applications open or closed right now?'))
        .addSubcommand(s => s.setName('open').setDescription('Reopen mod applications — accept new /apply-mod again'))
        .addSubcommand(s => s.setName('close').setDescription('Close mod applications (team full); in-flight applications still finish')
          .addStringOption(o => o.setName('message').setDescription('Optional custom note shown to members who try to apply').setRequired(false).setMaxLength(400)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('staff').setDescription('Staff census — how many of each tier (deduped by highest)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('promote-trial').setDescription('Open a promotion vote for a trial mod (posts in mod-announcements)')
        .addUserOption(o => o.setName('member').setDescription('The trial mod to consider for full Mod').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('promote-mod').setDescription('Open a promotion vote for a mod → admin (posts in admin-discussion)')
        .addUserOption(o => o.setName('member').setDescription('The mod to consider for Admin').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('demote-trial').setDescription('Remove the Trial Mod role from a member (owner)')
        .addUserOption(o => o.setName('member').setDescription('The trial mod to demote').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Optional note, kept internal').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

      // #roles picker management — one-up on the old Carl-bot setup: add/remove a self-assign role in a
      // section with one command, no manual message editing (admin).
      new SlashCommandBuilder().setName('roleselect-role').setDescription('Add or remove a self-assign role in #roles (admin)')
        .addSubcommand(s => s.setName('add').setDescription('Add a role to a #roles section')
          .addStringOption(o => o.setName('section').setDescription('Which section').setRequired(true)
            .addChoices({ name: 'Region', value: 'region' }, { name: 'Language', value: 'language' },
              { name: 'Notifications', value: 'notifications' }, { name: 'Pronouns', value: 'pronouns' }, { name: 'Misc', value: 'misc' }))
          .addRoleOption(o => o.setName('role').setDescription('The role to add').setRequired(true))
          .addStringOption(o => o.setName('label').setDescription('Button text (default: the role name, add your own emoji if you want one)').setRequired(false)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a role from a #roles section')
          .addStringOption(o => o.setName('section').setDescription('Which section').setRequired(true)
            .addChoices({ name: 'Region', value: 'region' }, { name: 'Language', value: 'language' },
              { name: 'Notifications', value: 'notifications' }, { name: 'Pronouns', value: 'pronouns' }, { name: 'Misc', value: 'misc' }))
          .addRoleOption(o => o.setName('role').setDescription('The role to remove').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

      new SlashCommandBuilder().setName('request-role').setDescription('Request a casual role — staff approves it')
        .addRoleOption(o => o.setName('role').setDescription('The role you want (or already have, if removing)').setRequired(true))
        .addBooleanOption(o => o.setName('remove').setDescription('Request to give this role UP instead of getting it (default: no)').setRequired(false)),
      new SlashCommandBuilder().setName('request-role-setup').setDescription('Create the role-requests channel (admin)'),

      // Appeals — unified /appeal ban|strike. Each subcommand is gated by its OWN feature flag
      // ('appeals' for ban, 'strikeAppeals' for strike — see the gate check near the interaction
      // handler, and the comment in features.js on why one command needs two flags).
      new SlashCommandBuilder().setName('appeal').setDescription('Appeal a ban (for a friend) or one of your own strikes')
        .addSubcommand(s => s.setName('ban').setDescription('Appeal a ban on a friend’s behalf — opens a private thread')
          .addStringOption(o => o.setName('username').setDescription('The banned person’s @username').setRequired(true))
          .addStringOption(o => o.setName('note').setDescription('Optional: a line to open the appeal with').setRequired(false)))
        .addSubcommand(s => s.setName('strike').setDescription('Appeal one of your own strikes, alone — opens a private thread')
          .addStringOption(o => o.setName('strike_id').setDescription('Which strike — pick from your own active strikes').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('note').setDescription('Optional: a line to open the appeal with').setRequired(false))),
      new SlashCommandBuilder().setName('appeal-setup').setDescription('Create the ban-appeals channel (admin)'),
      new SlashCommandBuilder().setName('appeal-strike-setup').setDescription('Create the strike-appeals channel (admin)'),

      new SlashCommandBuilder().setName('help').setDescription('What can this bot do? — the member features'),

      new SlashCommandBuilder().setName('strike').setDescription('Manage a member’s strikes — weighted units, bans at 10')
        .addSubcommand(s => s.setName('view').setDescription('See a member’s current units + strike history')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(s => s.setName('add').setDescription('Give a strike')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
          .addStringOption(o => o.setName('rule').setDescription('Which rule (pick a rule, a reason, or both)').setRequired(false)
            .addChoices(...SERVER_RULES.map((r, i) => ({ name: `${i + 1}. ${r}`, value: String(i + 1) }))))
          .addStringOption(o => o.setName('reason').setDescription('Why — posted publicly, no DMs (pick a rule, a reason, or both)').setRequired(false))
          .addIntegerOption(o => o.setName('weight').setDescription('Severity — omit to use the picked rule’s decided weight').setRequired(false)
            .addChoices({ name: '1 — minor', value: 1 }, { name: '2 — moderate', value: 2 }, { name: '3 — severe', value: 3 }))
          .addStringOption(o => o.setName('timeout').setDescription('Attach a native Discord timeout, e.g. 30m/2h/3d — adds bonus units (linear by length, capped at +2)').setRequired(false)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove ONE specific strike — start typing to search their strikes')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
          .addStringOption(o => o.setName('strike_id').setDescription('Which strike — pick from the list').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('clear').setDescription('Remove ALL of a member’s active strikes')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('verify').setDescription('Verify a member — no need to open the panel')
        .addUserOption(o => o.setName('user').setDescription('Member to verify').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('features').setDescription('View or toggle bot features (Owner only)')
        .addSubcommand(s => s.setName('list').setDescription('Show every feature and whether it’s on'))
        .addSubcommand(s => s.setName('toggle').setDescription('Turn a feature on or off')
          .addStringOption(o => o.setName('feature').setDescription('Which feature').setRequired(true)
            .addChoices(...features.REGISTRY.map(r => ({ name: r.key, value: r.key }))))
          .addBooleanOption(o => o.setName('on').setDescription('On or off').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('permguard').setDescription('Permission-drift guard (Owner only)')
        .addSubcommand(s => s.setName('status').setDescription('Run a sweep now and show what it found (no changes made silently — this DOES fix drift)'))
        .addSubcommand(s => s.setName('resnapshot').setDescription('Review changes since the baseline, then keep/undo each before saving')
          .addBooleanOption(o => o.setName('force').setDescription('Skip the review and blindly adopt current permissions (old behaviour)').setRequired(false)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      // Monthly contests — management (organizers have the ManageEvents guild perm, so this shows to
      // them + admins + owner natively). The member-facing /contest-submit is separate + ungated.
      new SlashCommandBuilder().setName('contest').setDescription('Run the monthly community contests (organizers/staff)')
        .addSubcommand(s => s.setName('setup').setDescription('Create the contest channels + winner role and post the rules'))
        .addSubcommand(s => s.setName('start').setDescription('Open a new monthly round with a theme')
          .addStringOption(o => o.setName('theme').setDescription('This month\'s theme, e.g. "summer vacations"').setRequired(true).setMaxLength(120))
          .addStringOption(o => o.setName('contests').setDescription('Which contests (default: all three)')
            .addChoices({ name: 'All three', value: 'all' }, { name: 'Drawing only', value: 'drawing' },
              { name: 'Photography only', value: 'photography' }, { name: 'Writing only', value: 'writing' },
              { name: 'Drawing + Photography', value: 'drawing,photography' })))
        .addSubcommand(s => s.setName('status').setDescription('Show the current theme, entry counts and 🩷 leaders'))
        .addSubcommand(s => s.setName('end').setDescription('Close the round now — tally 🩷, crown winners, assign the role'))
        .addSubcommand(s => s.setName('panel').setDescription('Open the event organizer dashboard (buttons)'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageEvents),
      new SlashCommandBuilder().setName('contest-submit').setDescription('Enter this month\'s contest anonymously (your name stays hidden)')
        .addStringOption(o => o.setName('contest').setDescription('Which contest').setRequired(true)
          .addChoices({ name: '🎨 Drawing', value: 'drawing' }, { name: '📸 Photography', value: 'photography' }, { name: '✍️ Writing', value: 'writing' }))
        .addAttachmentOption(o => o.setName('image').setDescription('Your entry image (Drawing/Photography — required there)').setRequired(false))
        .addStringOption(o => o.setName('text').setDescription('Your written entry (Writing)').setRequired(false).setMaxLength(2000)),
      new ContextMenuCommandBuilder().setName('Report to watchlist').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Send to corner').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Strike').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Report').setType(ApplicationCommandType.Message),   // member-facing anon report
    ];
    // Only register commands whose feature is enabled (fail-off). Disabled features' commands
    // simply don't appear in the server. (Seeded above, before allCmds was built.)
    const enabledNames = features.enabledCommandNames();
    const cmds = allCmds.filter(b => enabledNames.has(b.name)).map(c => c.toJSON());
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(cmds);
    console.log(`[features] registered ${cmds.length}/${allCmds.length} commands (disabled features hidden): ${[...enabledNames].sort().join(', ')}`);
    await ensureGuide(guild).catch(e => console.error('[guide]', e.message));
  } catch (err) {
    console.error(`[corner] command registration failed: ${err.message}`);
  }

  // Self-heal the corner role's channel permissions on boot (in case someone changed them).
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const fixed = await corner.ensureCornerPerms(guild);
    console.log(`[corner] perm self-heal on boot: ${fixed} overwrite(s) corrected`);
  } catch (err) {
    console.error(`[corner] perm self-heal failed: ${err.message}`);
  }

  // Upgrade any mod-app votes cast before weighted voting shipped (plain IDs -> {id, weight}), so an
  // owner/admin's earlier vote gets its proper weight without them needing to re-click. Idempotent.
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const upgraded = await modapps.upgradeLegacyVotes(guild);
    console.log(`[modapps] vote-weight self-heal on boot: ${upgraded} open application(s) upgraded`);
    // Backfill the ↩️ Undo button onto applications resolved before it existed. Idempotent.
    const undoAdded = await modapps.backfillUndoButtons(guild);
    console.log(`[modapps] undo-button backfill on boot: ${undoAdded} resolved application(s) updated`);
    // Sweep every review thread for anyone below mod+ (catches manual adds made while the bot was
    // offline, or from before this enforcement existed). Idempotent.
    const nonStaffRemoved = await modapps.sweepReviewThreadMembers(guild);
    console.log(`[modapps] review-thread membership sweep on boot: ${nonStaffRemoved} non-staff member(s) removed`);
  } catch (err) {
    console.error(`[modapps] vote-weight self-heal failed: ${err.message}`);
  }

  // Seed weighted-strike ledger entries for members still holding a Strike I/II/III role from before
  // this model shipped, so nobody's standing gets erased or reset by the switch. Idempotent.
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const seeded = await strikes.migrateLegacyStrikes(guild, state);
    console.log(`[strikes] legacy migration: ${seeded} member(s) seeded`);
    // Re-sync everyone onto the per-unit strike roles (Strike 1..9). Idempotent.
    const resynced = await strikes.resyncTierRoles(guild, state);
    console.log(`[strikes] per-unit role resync: ${resynced} member(s) updated`);
    // Tier auto-nest sweep: owner⊇admin⊇mod, strip Trial Mod from mod+. Idempotent.
    await guild.members.fetch().catch(() => {});
    let nested = 0;
    for (const m of guild.members.cache.values()) if (await enforceTierNesting(m)) nested++;
    console.log(`[tier-nest] boot sweep: ${nested} staff member(s) nested`);
    // Refresh the public "open appeals" boards pinned in the base channels.
    if (features.enabled('appeals')) await appeals.ensureBoard(guild).catch(e => console.error('[appeals board]', e.message));
    if (features.enabled('strikeAppeals')) await strikeAppeals.ensureBoard(guild).catch(e => console.error('[strikeAppeals board]', e.message));
    console.log('[appeals] open-appeals boards refreshed');
    // Owner-only log: bot actions (hooked at each action site) + a mirrored, curated server audit log.
    await ownerlog.ensureChannel(guild).catch(e => console.error('[ownerlog] channel init:', e.message));
    ownerlog.register(client);
    // Permission-drift guard: reconcile every channel's ROLE overwrites against the golden manifest
    // snapshot (see permguard.js) — catches the "channel overwrite silently stopped inheriting the
    // category's deny-by-default" class of bug (found 2026-07-30, #mod-announcements) automatically.
    const permResult = await permguard.sweepPermissions(guild, { notify: false }).catch(e => { console.error('[permguard] boot sweep failed:', e.message); return null; });
    if (permResult) console.log(`[permguard] boot sweep: ${permResult.fixed} overwrite(s) corrected, ${permResult.newMemberOverwrites.length} new member-overwrite(s) flagged, ${permResult.unmanagedChannels} channel(s) unmanaged (created after snapshot)`);
    permguard.register(client);
    // Monthly contests: arm the auto-close tick (crowns winners on the 1st of the month if a round's open).
    if (features.enabled('contest')) contest.register(client);
    // Sweep every current staff member's own application: mod+ gets archived (owner-only channel, removed
    // from the forum), trial-only gets sealed (removed from their applicant thread). Keeps history either way.
    let archived = 0, sealed = 0;
    for (const m of guild.members.cache.values()) {
      if (opspanel.memberTier(m)) archived += await modapps.archiveOwnApplication(guild, m.id).catch(() => 0);
      else if (m.roles.cache.has(config.trialModRoleId)) sealed += await modapps.sealOwnApplication(guild, m.id).catch(() => 0);
    }
    console.log(`[modapps] own-application sweep: ${archived} archived (mod+), ${sealed} sealed (trial)`);
  } catch (err) {
    console.error(`[strikes] legacy migration failed: ${err.message}`);
  }

  // Backfill sweep: auto-corner + delete any threads opened in general/chat channels BEFORE the
  // auto-corner-on-thread rule shipped. Idempotent — a no-op on every boot after the first.
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const swept = await sweepExistingAutoCornerThreads(guild);
    console.log(`[auto-corner-thread] backfill sweep: ${swept} pre-existing thread(s) handled`);
  } catch (err) {
    console.error(`[auto-corner-thread] backfill sweep failed: ${err.message}`);
  }

  // Auto-release expired corners every minute (survives restarts via state), announcing each in the
  // corner channel ("time served") — otherwise a timed release is silent.
  setInterval(async () => {
    try {
      const guild = await client.guilds.fetch(config.guildId);
      const released = await corner.releaseExpired(guild, state);
      if (released.length) {
        console.log(`[corner] auto-released ${released.length} member(s)`);
        const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
        for (const { uid, servedMs } of released) {
          if (cornerCh) {
            await cornerCh.send(cornerTimeServedMessage(uid))
              .catch(e => console.error(`[corner] time-served announce failed: ${e.message}`));
          }
          await logCorner(guild, { emoji: '⛓️‍💥', title: 'TIME SERVED', color: CORNER_GREEN,
            desc: `<@${uid}>'s sentence ended — auto-released, roles restored.\n**By:** the Corner (automatic)${servedSuffix(servedMs)}` });
        }
      }
    } catch (err) { console.error(`[corner] release loop: ${err.message}`); }
  }, 60 * 1000);

  // Weekly mod-dashboard tidy (catch-up on boot if due, then hourly gate check).
  const dguild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (dguild) await dashCleanTick(dguild).catch(() => {});
  setInterval(() => client.guilds.fetch(config.guildId).then(g => dashCleanTick(g)).catch(() => {}), 3600000);

  // MDNI (18+) enforcement backstop: strip MDNI from any non-adult holder on boot, then hourly.
  // Real-time enforcement is guildMemberUpdate; this catches pre-existing holders + missed events.
  if (dguild) await sweepMdni(dguild).catch(e => console.error(`[mdni] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepMdni(g)).catch(() => {}), 3600000);

  // Age-role exclusivity + registration-lock backstops (boot + hourly, same cadence as MDNI above).
  if (dguild) {
    await dguild.members.fetch().catch(() => {});
    for (const m of dguild.members.cache.values()) await enforceAgeExclusivity(m).catch(() => {});
    const seeded = await sweepRegistrationLocks(dguild).catch(e => { console.error(`[registration-lock] boot sweep: ${e.message}`); return 0; });
    console.log(`[registration-lock] boot sweep: ${seeded} member(s) grandfathered in`);
  }
  setInterval(async () => {
    const g = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!g) return;
    await g.members.fetch().catch(() => {});
    for (const m of g.members.cache.values()) await enforceAgeExclusivity(m).catch(() => {});
  }, 3600000);
});

// Real-time conflict resolution: when someone reacts to the current weekly react-to-resolve
// message, fix them immediately (the hourly sweep is the safety net for missed events).
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
    const msgId = state.getMeta('reactMsgId');
    if (!msgId || reaction.message.id !== msgId) return;
    const guild = reaction.message.guild;
    if (!guild || guild.id !== config.guildId) return;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) await reactresolve.resolveMember(member);
  } catch (err) {
    console.error(`[react] reaction handler error: ${err.message}`);
  }
});

// New members get the Unverified role on join. This used to be handled by the onboarding
// "Unverified" question (the only place it was assigned); moved here so that question can be
// dropped from onboarding while the gate stays intact. Skips bots and anyone already verified.
client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== config.guildId || member.user.bot) return;
    // Re-apply the Watchlist role to a member who was unbanned with "watchlist on rejoin".
    if (config.watchlistRoleId && watchlist.isPending(member.id)) {
      await member.roles.add(config.watchlistRoleId, 'Watchlist on rejoin (unbanned with watchlist)').catch(e => console.error('[watchlist] rejoin add:', e.message));
      watchlist.removePending(member.id);
      console.log(`[watchlist] re-applied Watchlist to rejoining ${member.user.tag} (${member.id})`);
    }
    if (!config.unverifiedRoleId) return;
    if (member.roles.cache.has(config.verifiedRoleId)) return;   // already verified
    if (member.roles.cache.has(config.unverifiedRoleId)) return; // already tagged
    await member.roles.add(config.unverifiedRoleId, 'Auto-assign Unverified on join');
    console.log(`[verify] assigned Unverified to new member ${member.user.username} (${member.id})`);
  } catch (err) {
    console.error(`[verify] guildMemberAdd failed for ${member.id}: ${err.message}`);
  }
});

// Track the Unverified role clock in real time: when a member GAINS the role (mod un-verifies as
// punishment, or autorole), stamp now so their reap clock starts then — not their join date. When
// they LOSE it (verified/resolved), drop their reap bookkeeping. Only acts on a confirmed
// transition (non-partial old member); pre-existing members are reconstructed by the sweep.
// MDNI (18+) must be backed by an ADULT age role. Onboarding lets a 16-17 member self-select MDNI with
// no age check, so we strip it from anyone who isn't a confirmed adult (minors, or adults who later
// switch their age to 16-17). Flags the MINOR case to mods — a minor reaching for 18+ is worth a look.
async function enforceMdni(member, { notify = true } = {}) {
  if (!config.mdniEnforce || !config.mdniRoleId || member.user?.bot) return null;
  if (!member.roles.cache.has(config.mdniRoleId)) return null;
  if (config.adultAgeRoleIds.some(id => member.roles.cache.has(id))) return null; // confirmed adult → keep
  await member.roles.remove(config.mdniRoleId, 'MDNI requires an adult age role').catch(e => console.error('[mdni] remove:', e.message));
  const isMinor = !!(config.minorAgeRoleId && member.roles.cache.has(config.minorAgeRoleId));
  console.log(`[mdni] stripped MDNI from ${member.user.tag}${isMinor ? ' (MINOR 16-17)' : ' (no adult age role)'}`);
  if (notify && isMinor && config.modAnnounceChannelId) {   // real-time single-member notice (sweep summarizes instead)
    const ch = await member.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
    if (ch) ch.send({ content: `## ⚠️ MDNI removed from a minor\n<@${member.id}> (\`${member.user.tag}\`) has the **16-17** age role but selected **MDNI** — auto-removed. Heads up in case it needs a closer look.`, allowedMentions: { parse: [] } }).catch(() => {});
  }
  return { id: member.id, tag: member.user.tag, minor: isMinor };
}
// Backstop: sweep every current MDNI holder (catches existing minors + any missed role-change event).
// Posts ONE summary of any minors stripped (vs. real-time enforcement's per-member notice) to avoid flooding.
async function sweepMdni(guild) {
  if (!config.mdniEnforce || !config.mdniRoleId) return;
  await guild.members.fetch().catch(() => {});   // role.members only reflects the cache
  const role = guild.roles.cache.get(config.mdniRoleId) || await guild.roles.fetch(config.mdniRoleId).catch(() => null);
  if (!role) return;
  const stripped = [];
  for (const m of [...role.members.values()]) {
    const r = await enforceMdni(m, { notify: false });
    if (r) stripped.push(r);
  }
  if (!stripped.length) return;
  const minors = stripped.filter(s => s.minor);
  console.log(`[mdni] sweep stripped ${stripped.length} non-adult MDNI holder(s) (${minors.length} minor)`);
  if (minors.length && config.modAnnounceChannelId) {
    const ch = await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
    if (ch) await ch.send({
      content: `## ⚠️ MDNI removed from ${minors.length} minor${minors.length > 1 ? 's' : ''}\nThese members have the **16-17** age role but held **MDNI** (18+) — auto-removed by the age-gate:\n${minors.map(m => `• <@${m.id}> (\`${m.tag}\`)`).join('\n')}`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

// Only one age bracket at a time. Nothing previously enforced this — a member could hold multiple age
// roles simultaneously (whatever assigned them, e.g. the old external selector, had no exclusivity check).
// Real-time (guildMemberUpdate, oldMember diff picks the newly-added one to keep) + boot sweep (no diff
// available, so it just keeps the first held in canonical order and flags the case as ambiguous for staff).
function ageRoleIds() { return [config.minorAgeRoleId, ...config.adultAgeRoleIds].filter(Boolean); }
function currentAgeRole(member) { return ageRoleIds().find(id => member.roles.cache.has(id)) || null; }
async function enforceAgeExclusivity(member, oldMember) {
  const ids = ageRoleIds();
  const held = ids.filter(id => member.roles.cache.has(id));
  if (held.length <= 1) return null;
  const newlyAdded = oldMember && !oldMember.partial ? held.filter(id => !oldMember.roles.cache.has(id)) : [];
  const ambiguous = newlyAdded.length !== 1;
  const keep = ambiguous ? held[0] : newlyAdded[0];
  const strip = held.filter(id => id !== keep);
  await member.roles.remove(strip, 'Only one age bracket allowed at a time').catch(e => console.error('[age-exclusivity] remove:', e.message));
  console.log(`[age-exclusivity] ${member.user.tag} held ${held.length} age roles — kept ${keep}, stripped ${strip.join(',')}${ambiguous ? ' (ambiguous, picked first)' : ''}`);
  return { keep, strip, ambiguous };
}

// Age bracket + MDNI are a ONE-TIME choice made "during registration" (Rule 3) — not something to keep
// re-picking. The moment a member is first observed as Verified, their current age role + MDNI status is
// snapshotted as their permanent choice; any change after that gets reverted and flagged to staff. This is
// the backstop against the external role-selector (Discord onboarding or similar) that this bot doesn't
// control — even if that path is still reachable, anything it does post-verification gets undone here.
function snapshotRegistrationLock(member) {
  return { ageRoleId: currentAgeRole(member), mdni: !!(config.mdniRoleId && member.roles.cache.has(config.mdniRoleId)) };
}
async function enforceRegistrationLock(member, notify = true) {
  if (!config.verifiedRoleId || !member.roles.cache.has(config.verifiedRoleId)) return;
  const locks = state.getMeta('registrationLock') || {};
  if (!locks[member.id]) { locks[member.id] = snapshotRegistrationLock(member); state.setMeta('registrationLock', locks); return; }
  const lock = locks[member.id];
  const curAge = currentAgeRole(member);
  const curMdni = !!(config.mdniRoleId && member.roles.cache.has(config.mdniRoleId));
  const roleName = id => id ? (member.guild.roles.cache.get(id)?.name || id) : 'none';
  const changes = [];
  if (curAge !== lock.ageRoleId) {
    if (curAge) await member.roles.remove(curAge, 'Registration lock: age bracket can’t change after verification').catch(() => {});
    if (lock.ageRoleId) await member.roles.add(lock.ageRoleId, 'Registration lock: restoring original age bracket').catch(() => {});
    changes.push(`age bracket: tried **${roleName(curAge)}**, reverted to **${roleName(lock.ageRoleId)}**`);
  }
  if (curMdni !== lock.mdni) {
    if (curMdni) await member.roles.remove(config.mdniRoleId, 'Registration lock: MDNI can’t change after verification').catch(() => {});
    else await member.roles.add(config.mdniRoleId, 'Registration lock: restoring original MDNI choice').catch(() => {});
    changes.push(`MDNI: tried to ${curMdni ? 'add it' : 'remove it'}, reverted`);
  }
  if (changes.length) {
    console.log(`[registration-lock] reverted change(s) for ${member.user.tag}: ${changes.join('; ')}`);
    if (notify && config.modAnnounceChannelId) {
      const ch = await member.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
      if (ch) await ch.send({ content: `## 🔒 Registration lock enforced\n<@${member.id}> (\`${member.user.tag}\`) tried to change their age/MDNI choice after verifying — reverted:\n${changes.map(c => `• ${c}`).join('\n')}`, allowedMentions: { parse: [] } }).catch(() => {});
    }
  }
}
// Boot self-heal: grandfather in every currently-Verified member with no lock snapshot yet (their
// CURRENT state becomes their locked baseline — doesn't retroactively punish existing members).
async function sweepRegistrationLocks(guild) {
  if (!config.verifiedRoleId) return 0;
  await guild.members.fetch().catch(() => {});
  const role = guild.roles.cache.get(config.verifiedRoleId) || await guild.roles.fetch(config.verifiedRoleId).catch(() => null);
  if (!role) return 0;
  const locks = state.getMeta('registrationLock') || {};
  let seeded = 0;
  for (const m of role.members.values()) { if (!locks[m.id]) { locks[m.id] = snapshotRegistrationLock(m); seeded++; } }
  if (seeded) state.setMeta('registrationLock', locks);
  return seeded;
}

// ── Tier auto-nesting ───────────────────────────────────────────────────────────────────────────────
// Owner ⊇ Admin ⊇ Mod: higher tiers hold the lower ROLES, so @Mod reaches everyone above AND every
// admin/owner inherits the MODS-✰ role's perks (embed/attach/voice) by being a mod. Trial Mod is
// DELIBERATELY EXCLUDED — becoming a real mod/admin/owner STRIPS Trial Mod, so @Trial Mod only ever
// pings genuine trial mods (owner ruling 2026-07-30). Idempotent → safe on every role change + on boot.
const NEST_MOD_ROLE = config.modRoleId || '1528316361665675316';
const NEST_ADMIN_ROLE = process.env.FUBU_ADMIN_ROLE_ID || '1516179051105226833';
async function enforceTierNesting(member) {
  if (!member || member.user?.bot) return false;
  const tier = opspanel.memberTier(member);           // owner / admin / mod / null (highest tier)
  if (!tier) return false;                             // not staff - nothing to nest
  const has = id => id && member.roles.cache.has(id);
  const add = [], remove = [];
  if ((tier === 'owner' || tier === 'admin') && NEST_MOD_ROLE && !has(NEST_MOD_ROLE)) add.push(NEST_MOD_ROLE);
  if (tier === 'owner' && NEST_ADMIN_ROLE && !has(NEST_ADMIN_ROLE)) add.push(NEST_ADMIN_ROLE);
  const trial = modapps.loadConfig().trialModRoleId;   // mod+ never keep Trial Mod
  if (trial && has(trial)) remove.push(trial);
  if (!add.length && !remove.length) return false;
  if (add.length) await member.roles.add(add, 'tier auto-nest (owner⊇admin⊇mod)').catch(() => {});
  if (remove.length) await member.roles.remove(remove, 'tier auto-nest: mod+ drops Trial Mod').catch(() => {});
  return true;
}

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (newMember.guild.id !== config.guildId) return;
    await enforceTierNesting(newMember).catch(e => console.error('[tier-nest]', e.message));
    // Nobody should be able to browse to their own application. A mod+ can see the WHOLE review forum, so
    // removing thread membership isn't enough — archive their own post to the owner-only channel instead
    // (record kept, just moved out of reach). A trial mod can't see the forum at all; sealing their
    // applicant-thread membership is sufficient there. Idempotent either way.
    if (opspanel.memberTier(newMember)) await modapps.archiveOwnApplication(newMember.guild, newMember.id).catch(e => console.error('[modapps archive]', e.message));
    else if (newMember.roles.cache.has(config.trialModRoleId)) await modapps.sealOwnApplication(newMember.guild, newMember.id).catch(e => console.error('[modapps seal]', e.message));
    await enforceMdni(newMember).catch(() => {});   // keep MDNI ⟹ adult on every role change
    await enforceAgeExclusivity(newMember, oldMember).catch(e => console.error('[age-exclusivity]', e.message));
    await enforceRegistrationLock(newMember).catch(e => console.error('[registration-lock]', e.message));
    if (!config.unverifiedRoleId || !oldMember || oldMember.partial) return;
    const hadU = oldMember.roles.cache.has(config.unverifiedRoleId);
    const hasU = newMember.roles.cache.has(config.unverifiedRoleId);
    if (hasU && !hadU) {
      state.setMember(newMember.id, { unverifiedSince: Date.now(), warnedAt: undefined });
    } else if (!hasU && hadU) {
      state.forgetMember(newMember.id);
    }
  } catch (err) {
    console.error(`[unverified-track] ${err.message}`);
  }
});

// Mod-application review threads are mod+ only — but Discord lets any mod+ member (via Manage Threads)
// manually add someone to a SPECIFIC thread, and that add works even if the added person's own CHANNEL
// permission denies them entirely (thread membership bypasses the parent's view-deny). A channel/category
// lockout alone can't stop that. React the moment anyone below mod+ is added: remove them + notify.
client.on('threadMembersUpdate', async (addedMembers, removedMembers, thread) => {
  try {
    if (!addedMembers.size) return;
    const forumId = modapps.loadConfig().forumId;
    if (!forumId || thread.parentId !== forumId) return;
    const removed = await modapps.enforceReviewThreadMembers(thread.guild, thread);
    if (!removed.length) return;
    console.log(`[modapps] auto-removed non-staff member(s) from review thread ${thread.id}: ${removed.map(m => m.user.tag).join(', ')}`);
    const ch = config.modAnnounceChannelId ? await thread.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null) : null;
    if (ch) await ch.send({ content: `🔒 Auto-removed ${removed.map(m => `<@${m.id}>`).join(', ')} from a mod-application review thread — that's mod+ only.`, allowedMentions: { parse: [] } }).catch(() => {});
  } catch (e) { console.error('[modapps] threadMembersUpdate enforcement:', e.message); }
});

// Verify panel: post Verify / Deny&kick buttons in every thread opened in the verify-here channel.
client.on('threadCreate', async (thread, newlyCreated) => {
  try {
    if (!newlyCreated) return;                                   // ignore re-syncs on restart
    if (thread.parentId !== config.verifyChannelId) return;
    if (!thread.ownerId) return;                                 // need an applicant to target
    await thread.join().catch(() => {});                         // ensure the bot can post (private threads)
    const m = await thread.guild.members.fetch(thread.ownerId).catch(() => null);
    // Ping the mod role AND trial mods (verifying is their task) so both are notified even if the
    // applicant never tags anyone.
    const panel = buildVerifyPanel(thread.ownerId, m?.user?.tag || null);
    const pingRoles = [config.modRoleId, config.trialModRoleId].filter(Boolean);
    const rolePing = pingRoles.map(r => `<@&${r}>`).join(' ');
    const modPing = pingRoles.length ? `${rolePing} — a member is waiting to be verified.\n` : '';
    await thread.send({
      ...panel,
      content: `${modPing}${panel.content}`,
      allowedMentions: { users: [thread.ownerId], roles: pingRoles },
    });
    console.log(`[verify-panel] posted in thread ${thread.id} (owner ${thread.ownerId}, mods + trial mods pinged)`);
  } catch (err) {
    console.error(`[verify-panel] threadCreate failed: ${err.message}`);
  }
});

// Auto-corner (Rule 9, Right Channel Right Conversation): opening a thread in a general/chat category is
// a quick, automatic Corner + the thread gets deleted (nothing left to salvage once the owner's cornered).
// Staff are exempt — this is member-facing enforcement, not a staff restriction. Feeds the same
// repeat-alert tracking as a manual /corner with rule 9, so a repeat offender still surfaces to staff.
// Shared by the live threadCreate listener AND the boot-time backfill sweep (for threads opened before
// this rule existed). Returns true if the thread was acted on (cornered + deleted), false if skipped.
async function autoCornerThread(guild, thread) {
  const parent = thread.parent || await guild.channels.fetch(thread.parentId).catch(() => null);
  if (!parent || !config.autoCornerThreadCategoryIds.includes(parent.parentId)) return false;
  if (config.autoCornerThreadExcludedChannelIds.includes(thread.parentId)) return false;
  if (!thread.ownerId) return false;
  const member = await guild.members.fetch(thread.ownerId).catch(() => null);
  if (!member) { await thread.delete('Auto-corner: owner no longer in the server').catch(() => {}); return true; }
  if (opspanel.memberTier(member)) return false; // staff exempt
  const r = await corner.corner(guild, member, config.autoCornerThreadDurationMs, state, client.user.id, '9');
  await thread.delete('Auto-corner: thread opened in a general/chat channel').catch(e => console.error('[auto-corner-thread] thread delete:', e.message));
  if (!r.ok) { console.error(`[auto-corner-thread] corner failed for ${member.id}: ${r.error}`); return false; }
  const relSec = Math.floor((Date.now() + config.autoCornerThreadDurationMs) / 1000);
  const reasonText = `Rule 9: ${SERVER_RULES[8]} — opened a thread in <#${thread.parentId}>`;
  try {
    const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
    if (cornerCh) await cornerCh.send(cornerSentMessage(member.id, `until <t:${relSec}:f>`, reasonText));
  } catch (e) { console.error('[auto-corner-thread] announce failed:', e.message); }
  await logCorner(guild, { emoji: '⛓️', title: 'AUTO-CORNERED (thread in chat channel)', color: CORNER_RED,
    desc: `<@${member.id}> was auto-cornered for 15m for opening a thread in <#${thread.parentId}> (now deleted).` });
  await maybeAlertCornerRepeat(guild, member, '9', r.repeatCount);
  console.log(`[auto-corner-thread] cornered ${member.id} for a thread in ${thread.parentId}, thread deleted`);
  return true;
}
client.on('threadCreate', async (thread, newlyCreated) => {
  try {
    if (!newlyCreated) return;
    await autoCornerThread(thread.guild, thread);
  } catch (err) {
    console.error(`[auto-corner-thread] failed: ${err.message}`);
  }
});
// One-time boot self-heal: sweep every covered channel for threads that predate this rule (opened before
// the feature shipped) and apply the same treatment retroactively. Idempotent — after the first sweep,
// the live threadCreate listener above catches everything instantly, so later boots find nothing to do.
async function sweepExistingAutoCornerThreads(guild) {
  let swept = 0;
  const channels = await guild.channels.fetch();
  for (const ch of channels.values()) {
    if (!ch || ch.type !== 0) continue; // text channels only
    if (config.autoCornerThreadExcludedChannelIds.includes(ch.id)) continue;
    if (!config.autoCornerThreadCategoryIds.includes(ch.parentId)) continue;
    // Existing threads may already be auto-archived (Discord's own inactivity timeout) by the time this
    // sweep runs — check both active AND archived, or a merely-quiet pre-existing thread gets missed.
    const active = await ch.threads.fetchActive().catch(() => null);
    const archived = await ch.threads.fetchArchived().catch(() => null);
    const threads = [...(active?.threads.values() || []), ...(archived?.threads.values() || [])];
    for (const thread of threads) {
      try { if (await autoCornerThread(guild, thread)) swept++; }
      catch (e) { console.error(`[auto-corner-thread] backfill sweep on ${thread.id}:`, e.message); }
    }
  }
  return swept;
}

// ── Watchlist: keyword monitor + ban/dismiss buttons ────────────────────────────────────────────────
// Tier gates via the ops-panel's ROLE-based tiers (NOT the Administrator permission, per owner):
//   canBan   = any staff tier (mod / admin / owner) — any mod can ban on a violation.
//   canWLAdmin = ADMINS-★ role or owner ONLY — unban + editing the watchlist/terms.
const canBan = (i) => !!opspanel.memberTier(i.member);
const canWLAdmin = (i) => ['admin', 'owner'].includes(opspanel.memberTier(i.member));
const isOwner = (i) => opspanel.memberTier(i.member) === 'owner';   // owner tier only (role-based, any owner)
// Trial Mod — a restricted training tier BELOW mod. Not staff for canBan purposes, but may do a few
// low-risk, bounded things: VERIFY, view the dashboard read-only, and CORNER (rule+reason, ≤1h).
const isTrialMod = (i) => !!(config.trialModRoleId && i.member?.roles?.cache?.has(config.trialModRoleId));
const canVerify = (i) => canBan(i) || isTrialMod(i);
// A language mini-mod may use Send-to-corner + Report-to-watchlist, but ONLY on messages in THEIR OWN
// language's channels (per-language roles now — French Mini-Mod acts only in French chat/VC, etc.), and
// only when the 'langMiniMod' feature is on. Dormant if no languages are configured.
function miniModCanActOn(interaction, channelId) {
  return features.enabled('langMiniMod') && langmods.canActOn(interaction.member, channelId);
}
// Member-facing anon-pipe commands are confined to the bot-commands channel (keeps them out of chat).
const BOT_COMMANDS_CH = process.env.FUBU_BOT_COMMANDS_CHANNEL_ID || '1528704767466016870';
function inBotCommands(interaction) {
  if (interaction.channelId === BOT_COMMANDS_CH) return true;
  interaction.reply({ content: `Please use this in <#${BOT_COMMANDS_CH}> 🤖`, flags: MessageFlags.Ephemeral }).catch(() => {});
  return false;
}

// Alert a mod channel when a member trips a flagged term. Self-contained: it copies the message text AND
// mirrors the attachments into the report, so the record survives even if the author deletes the original.
// opts lets the looser general monitor reuse it with a different channel/title/colour and no ban buttons.
async function watchlistAlert(msg, hits, opts = {}) {
  const chId = opts.channelId || config.modAnnounceChannelId;
  const ch = chId && await msg.guild.channels.fetch(chId).catch(() => null);
  if (!ch) return;
  // Smart-watch contextual judge (feature-gated, fail-open). Reads the flagged message in context and
  // either suppresses an obvious false positive (LIVE mode only) or annotates the alert with its verdict.
  // In shadow mode it only annotates + logs; a null/errored verdict falls through to today's behavior.
  let smartNote = null;
  if (features.enabled('smartWatch')) {
    try {
      const d = await smartwatch.evaluate(opts.scope || 'strict', msg, hits);
      if (d.ran && d.suppress) return;                 // live mode, high-confidence benign → don't post
      if (d.ran && d.note) smartNote = d.note;
    } catch (e) { console.error('[smartwatch] alert hook:', e.message); }
  }
  const atts = [...msg.attachments.values()];
  const embed = new EmbedBuilder().setColor(opts.color ?? 0xED4245).setTitle(opts.title || '🚨 Watchlist match')
    .setDescription(`<@${msg.author.id}> (\`${msg.author.tag}\`) ${opts.verb || 'tripped the watchlist'} in <#${msg.channel.id}>.`)
    .addFields(
      { name: 'Matched', value: (hits.map(h => `\`${h}\``).join(', ') || '-').slice(0, 1024) },
      { name: 'What they said (saved copy)', value: (msg.content || (atts.length ? '_(no text — see mirrored attachment)_' : '-')).slice(0, 1024) },
      { name: 'Original', value: `[jump to it](${msg.url}) · this report keeps a copy even if they delete it`, inline: true })
    .setFooter({ text: `user ${msg.author.id}` }).setTimestamp(new Date());
  if (atts.length) embed.addFields({ name: 'Attachments', value: `${atts.length} mirrored below (deletion-proof)`, inline: true });
  if (smartNote) embed.addFields({ name: 'AI context read', value: smartNote.slice(0, 1024) });
  // Re-upload the attachments to the report (fetched immediately, so a later delete can't remove them).
  const files = atts.slice(0, 10).map(a => ({ attachment: a.url, name: a.name || 'attachment' }));
  // opts.buttons: 'full' (Ban+Dismiss, default) · 'dismiss' (welfare — no ban) · 'none'.
  let components = [];
  if (opts.buttons === 'dismiss') components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_dismiss:${msg.author.id}`).setEmoji('🗑️').setLabel('Dismiss').setStyle(ButtonStyle.Secondary))];
  else if (opts.buttons !== 'none') components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_strike:${msg.author.id}`).setEmoji('⚠️').setLabel('Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wl_dismiss:${msg.author.id}`).setEmoji('🗑️').setLabel('Dismiss').setStyle(ButtonStyle.Secondary))];
  const ping = (opts.ping !== false && config.modRoleId) ? `<@&${config.modRoleId}>` : undefined;
  const mentions = { roles: (opts.ping !== false && config.modRoleId) ? [config.modRoleId] : [] };
  // Send with mirrored files; if a re-upload fails (expired/large), fall back to text-only so the report still lands.
  await ch.send({ content: ping, embeds: [embed], components, files, allowedMentions: mentions })
    .catch(async e => {
      console.error('[watchlist] alert (with files):', e.message);
      await ch.send({ content: ping, embeds: [embed], components, allowedMentions: mentions }).catch(e2 => console.error('[watchlist] alert:', e2.message));
    });
}

// Reason+weight modal for a message-based strike. Carries the flagged message ref so the submit
// handler can strike + reply on that message with the reason (public, in-channel, no DM). Weight is a
// typed field (1/2/3) rather than a dropdown — Discord modals can't hold select menus. ruleN (optional,
// picked via the strike_rule_pick select BEFORE this modal shows) is carried in the customId so the
// submit handler can build the same "Rule N: <title> — <reason>" text /strike add uses. prefillNote
// (optional) seeds the reason field's default text (e.g. context from a repeat-Corner conversion).
function strikeReasonModal(memberId, channelId, messageId, ruleN, prefillNote) {
  const ruleSeg = ruleN || 'x';
  const ruleObj = ruleN ? rules.byIndex(Number(ruleN)) : null;
  const ruleTitle = ruleObj?.title || null;
  // If the picked rule already has a decided weight, pre-fill it and stop requiring the field — the
  // mod can just submit as-is. Otherwise fall back to the old "type it, default 1" behavior.
  const ruleWeight = ruleObj ? rules.weightOf(ruleObj.key) : null;
  const m = new ModalBuilder().setCustomId(`strike_reason:${memberId}:${channelId || 0}:${messageId || 0}:${ruleSeg}`)
    .setTitle(ruleTitle ? `Strike — Rule ${ruleN}: ${ruleTitle}`.slice(0, 45) : 'Strike — reason + weight');
  // Required only when no rule was picked (rule OR reason, not both) — the strike_rule_pick select
  // beforehand already covers the "gave a rule" half of that requirement.
  // Discord caps a TextInput label at 45 chars — anything longer makes showModal throw "Invalid string
  // length", which (thrown from a select handler) leaves the interaction unacked → "didn't respond in
  // time". Keep labels short AND slice(0,45) as a hard backstop so no label can ever overflow again.
  const reasonInput = new TextInputBuilder().setCustomId('reason')
    .setLabel((ruleN ? 'Reason (optional — rule already picked)' : 'Reason — posted publicly, no DMs').slice(0, 45))
    .setStyle(TextInputStyle.Short).setRequired(!ruleN).setMaxLength(300);
  if (prefillNote) reasonInput.setValue(prefillNote.slice(0, 300));
  const weightInput = new TextInputBuilder().setCustomId('weight')
    .setLabel((ruleWeight ? `Weight — Rule ${ruleN} default (edit if needed)` : 'Weight: 1 minor / 2 moderate / 3 severe').slice(0, 45))
    .setStyle(TextInputStyle.Short).setRequired(!ruleWeight).setValue(String(ruleWeight || 1)).setMaxLength(1);
  m.addComponents(new ActionRowBuilder().addComponents(reasonInput), new ActionRowBuilder().addComponents(weightInput));
  return m;
}
// Alert staff when a member has been repeatedly cornered for the SAME rule (config.cornerRepeatAlertThreshold,
// default 3) — never auto-strikes; the button opens the normal strike modal pre-filled so a human decides.
async function maybeAlertCornerRepeat(guild, member, ruleN, repeatCount) {
  if (!ruleN || repeatCount < config.cornerRepeatAlertThreshold) return;
  const ch = config.modAnnounceChannelId && await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return;
  const ruleTitle = SERVER_RULES[Number(ruleN) - 1] || `rule ${ruleN}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`corner_convert:${member.id}:${ruleN}`).setEmoji('⚠️').setLabel('Convert to Strike').setStyle(ButtonStyle.Danger));
  await ch.send({
    content: `🔁 <@${member.id}> has been sent to the Corner **${repeatCount} times** for the same rule — **${ruleN}. ${ruleTitle}**. Consider converting to a Strike.`,
    components: [row], allowedMentions: { parse: [] },
  }).catch(e => console.error('[corner] repeat alert:', e.message));
}
// Rule-picker select shown BEFORE the strike reason+weight modal (a modal can't hold a dropdown).
// customId: strike_rule_pick:<memberId>:<channelId>:<messageId>
function ruleRow(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Which rule? (optional)').addOptions(
      ...SERVER_RULES.map((r, i) => ({ label: `${i + 1}. ${r}`.slice(0, 100), value: String(i + 1) })),
      { label: 'Other / no specific rule', value: 'none' }));
}
function banConfirmRow(userId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_banok:${userId}`).setEmoji('🔨').setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wl_dismiss:${userId}`).setEmoji('✖️').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
}

// wl_strike:<id> → escalate one strike (→ ban confirm at max) · wl_banok:<id> → ban ·
// wl_dismiss:<id> → clear. Mod-gated; edits the alert in place.
// Pull the flagged message's {channelId, messageId} out of a watch-log alert embed's jump link.
function originalRefFromAlert(embed) {
  const hay = ((embed?.fields || []).map(f => f.value).join('\n')) + '\n' + (embed?.description || '');
  const m = hay.match(/channels\/\d+\/(\d+)\/(\d+)/);   // /channels/<guild>/<channel>/<message>
  return m ? { channelId: m[1], messageId: m[2] } : null;
}

async function handleWatchlistButton(interaction) {
  if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can use this.', flags: MessageFlags.Ephemeral });
  const [action, userId] = interaction.customId.split(':');
  const keep = interaction.message.embeds;
  if (action === 'wl_dismiss')
    return interaction.update({ content: `🗑️ Dismissed by <@${interaction.user.id}>.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  if (action === 'wl_add') {   // "Add to watchlist" from a report - ADMINS-★ only
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can add to the watchlist.', flags: MessageFlags.Ephemeral });
    if (!config.watchlistRoleId) return interaction.reply({ content: 'No Watchlist role configured.', flags: MessageFlags.Ephemeral });
    const m = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!m) return interaction.reply({ content: "That member isn't in the server.", flags: MessageFlags.Ephemeral });
    await m.roles.add(config.watchlistRoleId, `Watchlist via report by ${interaction.user.tag}`).catch(() => {});
    return interaction.update({ content: `👁️ <@${userId}> added to the Watchlist by <@${interaction.user.id}>.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (action === 'wl_strike') {
    const keep = interaction.message.embeds;
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) // already left - the only escalation left is a ban so they can't rejoin
      return interaction.update({ content: `⚠️ <@${userId}> already left. Ban so they can’t rejoin?`, embeds: keep, components: [banConfirmRow(userId, 'Confirm ban')], allowedMentions: { parse: [] } }).catch(() => {});
    // Rule → reason+weight modal (two steps — a modal can't hold the rule dropdown).
    const ref = originalRefFromAlert(keep[0]);
    return interaction.reply({ content: 'Which rule (optional)?', components: [ruleRow(`strike_rule_pick:${userId}:${ref?.channelId || 0}:${ref?.messageId || 0}`)], flags: MessageFlags.Ephemeral });
  }
  if (action === 'wl_ban') { // legacy direct-ban buttons on older reports
    return interaction.update({ components: [banConfirmRow(userId, 'Confirm ban')] }).catch(() => {});
  }
  if (action === 'wl_banok') {
    try {
      await interaction.guild.members.ban(userId, { reason: `Watchlist ban by ${interaction.user.tag}` });
      await ownerlog.log(interaction.guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `<@${userId}> — by <@${interaction.user.id}>.` });
      return interaction.update({ content: `🔨 Banned <@${userId}> — by <@${interaction.user.id}>.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    } catch (e) {
      return interaction.update({ content: `❌ Ban failed: ${e.message}`, components: [] }).catch(() => {});
    }
  }
}

// Manual report: a mod right-clicks a message → "Report to watchlist" → deletion-proof report in
// mod-announcements with Add-to-watchlist (admin) / Ban (mod) / Dismiss buttons.
async function manualWatchReport(message, reporter) {
  const ch = config.modAnnounceChannelId && await message.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return false;
  const atts = [...message.attachments.values()];
  const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('🚩 Reported message')
    .setDescription(`<@${reporter.id}> reported <@${message.author.id}> (\`${message.author.tag}\`) in <#${message.channel.id}>.`)
    .addFields(
      { name: 'What they said (saved copy)', value: (message.content || (atts.length ? '_(no text — see mirrored attachment)_' : '-')).slice(0, 1024) },
      { name: 'Original', value: `[jump to it](${message.url}) · saved here even if they delete it`, inline: true })
    .setFooter({ text: `user ${message.author.id}` }).setTimestamp(new Date());
  if (atts.length) embed.addFields({ name: 'Attachments', value: `${atts.length} mirrored below`, inline: true });
  const files = atts.slice(0, 10).map(a => ({ attachment: a.url, name: a.name || 'attachment' }));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_add:${message.author.id}`).setEmoji('👁️').setLabel('Add to watchlist').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wl_strike:${message.author.id}`).setEmoji('⚠️').setLabel('Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wl_dismiss:${message.author.id}`).setEmoji('🗑️').setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
  const ping = config.modRoleId ? `<@&${config.modRoleId}>` : undefined;
  const mentions = { roles: config.modRoleId ? [config.modRoleId] : [] };
  await ch.send({ content: ping, embeds: [embed], components: [row], files, allowedMentions: mentions })
    .catch(async e => { console.error('[report] with files:', e.message); await ch.send({ content: ping, embeds: [embed], components: [row], allowedMentions: mentions }).catch(e2 => console.error('[report]', e2.message)); });
  return true;
}

// Monitor: a member ON the Watchlist role who trips a flagged term → alert mods. Dormant until terms exist.
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot || !msg.guild) return;
    // Monthly contest channels: record entries (auto-🩷), enforce one-per-person, delete chatter/dupes.
    // If it removed the message there's nothing left to scan, so stop here.
    if (contest.isContestChannel(msg.channelId)) { const r = await contest.onMessage(msg); if (r.deleted) return; }
    // Mod-application applicant reply → mirror onto the staff review post + ping (private app threads have
    // no staff members, so replies would otherwise notify nobody). Runs before the content guard so an
    // attachment-only reply still relays; returns early so we don't watchlist-scan the private app thread.
    if (msg.channel?.isThread?.()) {
      try { if (await modapps.relayApplicantReply(msg, config)) return; }
      catch (e) { console.error('[modapps] relay:', e.message); }
    }
    if (!msg.content) return;
    const member = msg.member || await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (!member) return;
    // STRICT: a watchlisted member trips a strict term → mod-announcements alert (ban buttons + ping).
    // Strict ENCOMPASSES loose — a watchlisted member is matched against strict + loose combined, so you
    // only ever add strict-ONLY extras to the strict list (every loose term is auto-included here).
    if (config.watchlistRoleId && member.roles.cache.has(config.watchlistRoleId)) {
      const strict = [...new Set([...watchlist.loadTerms(), ...watchlist.loadLoose()])];
      const hits = strict.length ? watchlist.matchTerms(msg.content, strict) : [];
      if (hits.length) { await watchlistAlert(msg, hits, { scope: 'strict' }); return; }   // strict wins - one report per message
    }
    // Everyone EXCEPT staff → the day-to-day #watch-log (no ping). WELFARE (support) takes priority over LOOSE.
    if (config.watchLogChannelId && !opspanel.memberTier(member)) {
      const welfare = watchlist.loadWelfare();
      const wHits = welfare.length ? watchlist.matchTerms(msg.content, welfare) : [];
      if (wHits.length) {
        await watchlistAlert(msg, wHits, { scope: 'welfare', channelId: config.watchLogChannelId, title: '🫂 Welfare check',
          color: 0x5DADE2, verb: 'may need support — flagged on the welfare watch', ping: false, buttons: 'dismiss' });
        return;
      }
      const loose = watchlist.loadLoose();
      const lHits = loose.length ? watchlist.matchTerms(msg.content, loose) : [];
      if (lHits.length) await watchlistAlert(msg, lHits, { scope: 'loose', channelId: config.watchLogChannelId,
        title: '🔎 Watch-log flag', color: 0xE7AC4E, verb: 'said something on the day-to-day watch list', ping: false });
    }
  } catch (e) { console.error('[watchlist] messageCreate:', e.message); }
});

// If a contest entry message is deleted (by its author or a mod), free that member to enter again.
client.on('messageDelete', async (msg) => {
  try { if (msg.channelId && contest.isContestChannel(msg.channelId)) await contest.onMessageDelete(msg); }
  catch (e) { console.error('[contest] messageDelete:', e.message); }
});

// Button routing (verify panel · corner controls · conflict resolve) + /corner /uncorner below.
client.on('interactionCreate', async (interaction) => {
  // /unban's user_id: autocomplete search over the actual ban list (see the names, don't paste a raw ID blind).
  if (interaction.isAutocomplete?.()) {
    if (interaction.commandName === 'unban') {
      try {
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const bans = await interaction.guild.bans.fetch().catch(() => null);
        const list = bans ? [...bans.values()] : [];
        const matches = list.filter(b => b.user.tag.toLowerCase().includes(focused) || b.user.id.includes(focused)).slice(0, 25);
        return interaction.respond(matches.map(b => ({ name: `${b.user.tag} (${b.user.id})`.slice(0, 100), value: b.user.id })));
      } catch (e) { console.error('[unban] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    if (interaction.commandName === 'strike' && interaction.options.getSubcommand() === 'remove') {
      try {
        const user = interaction.options.getUser('user');
        if (!user) return interaction.respond([]);
        const focused = interaction.options.getFocused() || '';
        return interaction.respond(strikes.autocompleteChoices(state, user.id, { query: focused }));
      } catch (e) { console.error('[strike-remove] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    if (interaction.commandName === 'appeal' && interaction.options.getSubcommand() === 'strike') {
      try {
        const focused = interaction.options.getFocused() || '';
        // Scoped to the CALLER's own strikes only — self-service, and excludes the strike that
        // crossed the ban threshold (not appealable this way — see strikeAppeals.js's submit()).
        return interaction.respond(strikes.autocompleteChoices(state, interaction.user.id, { query: focused, excludeCrossedBan: true }));
      } catch (e) { console.error('[appeal-strike] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    return interaction.respond([]).catch(() => {});
  }
  // Tier-gated ops dashboard (buttons / select / modal, all customId 'fops_*'). Handles its own tier
  // checks; must run before the isChatInputCommand guard which would drop selects + modal submits.
  if (opspanel.isPanelInteraction(interaction)) {
    try { await opspanel.handlePanel(interaction); }
    catch (e) {
      console.error(`[fops] ${e.message}`);
      const msg = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
    return;
  }
  // Event organizer dashboard (buttons/modal, customId 'evp_*') — its own namespace, gated to organizers.
  if (contest.isEventPanelInteraction(interaction)) {
    try { await contest.handleEventPanel(interaction); }
    catch (e) {
      console.error(`[contest] evp: ${e.message}`);
      const msg = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
    return;
  }
  // Permguard reconcile popup (buttons, customId 'pg_*') — owner-only, gated inside the handler.
  if (permguard.isReconcileInteraction(interaction)) {
    try { await permguard.handleReconcile(interaction); }
    catch (e) {
      console.error(`[permguard] reconcile: ${e.message}`);
      const msg = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
    return;
  }
  // Rule picker shown before the strike reason+weight modal (watch-log Strike button + right-click Strike) —
  // a modal can't hold a dropdown, so this is a select-then-modal step, same shape as the dashboard's
  // Corner/Ban pickers. customId: strike_rule_pick:<memberId>:<channelId>:<messageId>
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('strike_rule_pick:')) {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can strike.', flags: MessageFlags.Ephemeral });
    const [, memberId, channelId, messageId] = interaction.customId.split(':');
    const ruleN = interaction.values[0] === 'none' ? null : interaction.values[0];
    return interaction.showModal(strikeReasonModal(memberId, channelId, messageId, ruleN));
  }
  // #roles pickers (roleselect.js) — any member, no staff gate.
  // Age/Color: single-select dropdown — swap to the chosen role, stripping any other held role in the
  // same group. Age additionally refuses outright once Verified (registration lock; index.js's
  // enforceRegistrationLock is the backstop either way, but this avoids the confusing "applied then
  // silently reverted" experience).
  if (interaction.isStringSelectMenu?.() && (interaction.customId === 'roleselect_age' || interaction.customId === 'roleselect_color')) {
    const isAge = interaction.customId === 'roleselect_age';
    if (isAge && config.verifiedRoleId && interaction.member.roles.cache.has(config.verifiedRoleId)) {
      return interaction.reply({ content: 'Your age bracket is locked once you’re verified. That’s a one-time registration choice. Ask staff if something’s wrong.', flags: MessageFlags.Ephemeral });
    }
    const group = (isAge ? roleselect.AGE : roleselect.COLORS).map(([, id]) => id);
    const chosen = interaction.values[0];
    const clearing = chosen === 'none'; // color-only - age has no clear option, always a real bracket
    const toRemove = group.filter(id => id !== chosen && interaction.member.roles.cache.has(id));
    try {
      if (toRemove.length) await interaction.member.roles.remove(toRemove, 'Role picker: single-select swap');
      if (!clearing && !interaction.member.roles.cache.has(chosen)) await interaction.member.roles.add(chosen, 'Role picker: single-select pick');
    } catch (e) { return interaction.reply({ content: `Couldn’t update that: ${e.message}`, flags: MessageFlags.Ephemeral }); }
    return interaction.reply({ content: clearing ? '✅ Color cleared.' : `✅ Set to <@&${chosen}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // Watchlist-suggest approve menu — an ADMINS-★ picks terms to add from the recommender's multi-select.
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'wlsug_add') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can add terms.', flags: MessageFlags.Ephemeral });
    const done = suggest.applySelection(interaction.values);
    return interaction.reply({ flags: MessageFlags.Ephemeral,
      content: done.length ? `➕ Added:\n${done.map(d => `• \`${d}\``).join('\n')}` : 'Nothing added.' });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('modapp_submit')) {   // 'modapp_submit' or 'modapp_submit:lang:<Language>'
    try { return await modapps.submitFromModal(interaction, config); }
    catch (e) { console.error(`[modapps] modal ${e.message}`); return interaction.reply({ content: 'Could not submit that — try again.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'modapp_pos_langsel') {
    try { return await modapps.handlePositionSelect(interaction); }
    catch (e) { console.error(`[modapps] langsel ${e.message}`); return interaction.reply({ content: 'Could not open that.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('modapp_ask:')) {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can do that.', flags: MessageFlags.Ephemeral });
    try { return await modapps.handleAskModal(interaction); }
    catch (e) { console.error(`[modapps] ask ${e.message}`); return interaction.reply({ content: 'Could not send.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  // Send-to-corner reason modal (cornerReason feature). customId: corner_reason:<memberId>:<channelId>:<messageId>
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('corner_reason:')) {
    try {
      const [, memberId, channelId, messageId] = interaction.customId.split(':');
      const reason = (interaction.fields.getTextInputValue('reason') || '').trim() || null;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return interaction.editReply('That member isn’t in the server anymore.');
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      const target = ch && await ch.messages.fetch(messageId).catch(() => null);
      if (!target) return interaction.editReply('That message is gone. Can’t corner from it.');
      const res = await cornerFromMessage(guild, interaction.user.id, member, target, reason);
      if (!res.ok) return interaction.editReply(`Failed to corner: ${res.error}`);
      return interaction.editReply(`🚫 Sent <@${member.id}> to the corner${reason ? ` — ${reason}` : ''}. Stripped **${res.stripped}** role(s).`);
    } catch (e) { console.error(`[corner-reason] ${e.message}`); return (interaction.deferred ? interaction.editReply('Could not corner.') : interaction.reply({ content: 'Could not corner.', flags: MessageFlags.Ephemeral })).catch(() => {}); }
  }
  // Strike reason+weight modal. customId: strike_reason:<memberId>:<channelId>:<messageId>
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('strike_reason:')) {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can strike.', flags: MessageFlags.Ephemeral });
    try {
      const [, memberId, channelId, messageId, ruleSeg] = interaction.customId.split(':');
      const ruleN = ruleSeg && ruleSeg !== 'x' ? ruleSeg : null;
      const rawReason = (interaction.fields.getTextInputValue('reason') || '').trim();
      if (!ruleN && !rawReason) return interaction.reply({ content: 'Give a reason — pick a rule beforehand, type a reason, or both.', flags: MessageFlags.Ephemeral });
      const reason = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${rawReason ? ` — ${rawReason}` : ''}` : rawReason;
      const weightRaw = (interaction.fields.getTextInputValue('weight') || '').trim();
      // Blank field (allowed when the rule's weight was pre-filled and the field made optional) → use
      // the rule's own decided weight. Anything typed always wins, even if it differs from the rule's
      // default — that's a deliberate override, not an error.
      const ruleObj = ruleN ? rules.byIndex(Number(ruleN)) : null;
      const ruleWeight = ruleObj ? rules.weightOf(ruleObj.key) : null;
      const weight = weightRaw ? Number(weightRaw) : ruleWeight;
      if (![1, 2, 3].includes(weight)) return interaction.reply({ content: 'Weight must be 1, 2, or 3.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return interaction.editReply('That member isn’t in the server.');
      const res = await strikes.addStrike(guild, member, state, { weight, ruleIndex: ruleN, reason, byId: interaction.user.id, byTag: interaction.user.tag });
      // In-channel notice on the flagged message (no DM) — public, carries the reason.
      if (channelId !== '0' && messageId !== '0') {
        const ch = await guild.channels.fetch(channelId).catch(() => null);
        const orig = ch && await ch.messages.fetch(messageId).catch(() => null);
        // Strikes are a real notification the member should get, not a reference-only mention — ping them.
        if (orig) await orig.reply({ content: `⚠️ <@${member.id}> — a strike was given for this message: ${reason} (${weight} unit${weight > 1 ? 's' : ''}). Strike ID: \`${res.id}\` — appealable with \`/appeal strike\`.`, allowedMentions: { users: [member.id] } }).catch(() => {});
      }
      const banNote = res.crossedBan ? banConfirmRow(member.id, 'Confirm ban') : null;
      await ownerlog.log(guild, { emoji: '⚠️', title: 'Strike given', color: 0xED4245,
        detail: `<@${member.id}> — ${strikes.formatUnits(weight)} unit(s), ${reason} — by <@${interaction.user.id}>. Now ${strikes.formatUnits(res.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return interaction.editReply({ content: `⚠️ Gave <@${member.id}> a **${weight}-unit** strike — now **${strikes.formatUnits(res.totalUnits)}/${strikes.BAN_THRESHOLD} units** (${res.tier})${res.crossedBan ? ' — 🔨 **crossed the ban threshold**' : ''}.`,
        components: banNote ? [banNote] : [] });
    } catch (e) { console.error(`[strike-reason] ${e.message}`); return (interaction.deferred ? interaction.editReply('Could not strike.') : interaction.reply({ content: 'Could not strike.', flags: MessageFlags.Ephemeral })).catch(() => {}); }
  }
  if (interaction.isButton?.()) {
    const id = interaction.customId || '';
    try {
      if (id.startsWith('vpanel_')) return await handleVerifyButton(interaction);
      // #roles pickers (roleselect.js) — generic multi-toggle (regions/notifications/pronouns/misc):
      // add if missing, remove if present. Same mechanic the old Carl-bot reactions had, just bot-owned.
      if (id.startsWith('roleselect_toggle:')) {
        const roleId = id.split(':')[1];
        const has = interaction.member.roles.cache.has(roleId);
        try { if (has) await interaction.member.roles.remove(roleId, 'Role picker toggle'); else await interaction.member.roles.add(roleId, 'Role picker toggle'); }
        catch (e) { return interaction.reply({ content: `Couldn’t update that: ${e.message}`, flags: MessageFlags.Ephemeral }); }
        return interaction.reply({ content: `${has ? '➖ Removed' : '➕ Added'} <@&${roleId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      // MDNI toggle — gated to holding an adult age bracket, and locked once Verified (backed by
      // enforceRegistrationLock either way; this just avoids the confusing apply-then-revert experience).
      if (id.startsWith('roleselect_mdni:')) {
        const roleId = id.split(':')[1];
        const has = interaction.member.roles.cache.has(roleId);
        if (config.verifiedRoleId && interaction.member.roles.cache.has(config.verifiedRoleId)) {
          return interaction.reply({ content: 'MDNI is locked once you’re verified. That’s a one-time choice made during registration. Ask staff if something’s wrong.', flags: MessageFlags.Ephemeral });
        }
        if (!has && !config.adultAgeRoleIds.some(aid => interaction.member.roles.cache.has(aid))) {
          return interaction.reply({ content: 'Pick an adult age bracket (18+) first — MDNI requires it.', flags: MessageFlags.Ephemeral });
        }
        try { if (has) await interaction.member.roles.remove(roleId, 'Role picker toggle'); else await interaction.member.roles.add(roleId, 'Role picker toggle'); }
        catch (e) { return interaction.reply({ content: `Couldn’t update that: ${e.message}`, flags: MessageFlags.Ephemeral }); }
        return interaction.reply({ content: `${has ? '➖ Removed' : '➕ Added'} MDNI.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      if (id.startsWith('corner_convert:')) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can strike.', flags: MessageFlags.Ephemeral });
        const [, memberId, ruleN] = id.split(':');
        return interaction.showModal(strikeReasonModal(memberId, 0, 0, ruleN, '(repeat Corner escalation)'));
      }
      if (id.startsWith('corner_')) return await handleCornerButton(interaction);
      if (id.startsWith('conflict_')) return await handleConflictButton(interaction);
      if (id.startsWith('digest_')) return await handleDigestButton(interaction);
      if (id.startsWith('wl_')) return await handleWatchlistButton(interaction);
      if (id.startsWith('sug_')) {
        if ((id === 'sug_ok' || id === 'sug_no') && !canBan(interaction))
          return interaction.reply({ content: 'Only staff (mods+) can approve or deny suggestions.', flags: MessageFlags.Ephemeral });
        return await suggestions.handleButton(interaction, config);
      }
      if (id.startsWith('conf_')) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can do that.', flags: MessageFlags.Ephemeral });
        return await confessions.handleButton(interaction);
      }
      if (id.startsWith('rolereq_')) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can approve/deny role requests.', flags: MessageFlags.Ephemeral });
        return await rolereq.handleButton(interaction);
      }
      if (id.startsWith('appeal_')) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can approve or deny ban appeals.', flags: MessageFlags.Ephemeral });
        return await appeals.handleButton(interaction);
      }
      if (id.startsWith('strikeappeal_')) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can approve or deny strike appeals.', flags: MessageFlags.Ephemeral });
        return await strikeAppeals.handleButton(interaction, state);
      }
      if (id.startsWith('promote_')) {
        if (id === 'promote_confirm' || id === 'promote_reject') {
          const approvers = modapps.loadConfig().approvers || [];
          if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id))
            return interaction.reply({ content: 'Only the **server owner** can confirm or reject a promotion.', flags: MessageFlags.Ephemeral });
        } else if (!canBan(interaction)) {
          return interaction.reply({ content: 'Only staff (mods+) can vote on promotions.', flags: MessageFlags.Ephemeral });
        }
        return await promote.handleButton(interaction, config);
      }
      if (id.startsWith('wb_')) return await whistleblow.handleButton(interaction);   // unseal self-gates to the entrusted holder
      if (id.startsWith('modapp_')) {
        if (id === 'modapp_accept' || id === 'modapp_deny' || id === 'modapp_undo') {
          // The ACTUAL server owner (guild.ownerId, dynamic) — plus any temporary approvers in config
          // (used while the real owner is inactive; clear the list once they're back). Undoing a decision
          // is as consequential as making one, so it takes the same tier.
          const approvers = modapps.loadConfig().approvers || [];
          if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id))
            return interaction.reply({ content: `Only the **server owner** can ${id === 'modapp_undo' ? 'undo' : 'accept or deny'} mod applications.`, flags: MessageFlags.Ephemeral });
        }
        if ((id === 'modapp_up' || id === 'modapp_down' || id === 'modapp_askanon') && !canBan(interaction))
          return interaction.reply({ content: 'Only staff (mods+) can do that.', flags: MessageFlags.Ephemeral });
        return await modapps.handleButton(interaction, config);
      }
      if (id === 'rep_reveal') {
        if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can reveal a reporter.', flags: MessageFlags.Ephemeral });
        return await reports.handleButton(interaction);
      }
      if (id === 'mm_reveal') {
        if (opspanel.memberTier(interaction.member) !== 'owner') return interaction.reply({ content: 'Only owners can reveal a modmail sender.', flags: MessageFlags.Ephemeral });
        return await modmail.handleButton(interaction);
      }
      if (id.startsWith('pending_page:')) return await interaction.update(await renderPending(Number(id.split(':')[1] || 0)));
    } catch (err) {
      console.error(`[button] ${id}: ${err.message}`);
      const m = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
      (interaction.deferred || interaction.replied) ? interaction.editReply(m).catch(() => {}) : interaction.reply(m).catch(() => {});
    }
    return;
  }
  // Feature gate — belt-and-suspenders on top of not registering disabled commands: if a command
  // whose feature is turned off is somehow invoked, decline it.
  if (interaction.isChatInputCommand?.() || interaction.isMessageContextMenuCommand?.()) {
    // /appeal has two subcommands owned by two independently-toggleable features — the generic
    // one-command-to-one-feature lookup can't tell them apart, so check the subcommand directly.
    const fk = interaction.commandName === 'appeal'
      ? (interaction.options.getSubcommand() === 'strike' ? 'strikeAppeals' : 'appeals')
      : features.featureForCommand(interaction.commandName);
    if (fk && !features.enabled(fk))
      return interaction.reply({ content: 'That feature is currently turned off.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Report to watchlist') {
    if (!canBan(interaction) && !miniModCanActOn(interaction, interaction.targetMessage?.channelId)) return interaction.reply({ content: 'Only staff (mods+) can report.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: 'Could not read that message.', flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't report a bot's message.", flags: MessageFlags.Ephemeral });
    const ok = await manualWatchReport(target, interaction.user).catch(() => false);
    return interaction.reply({ content: ok ? `🚩 Reported <@${target.author.id}> to the mods — an admin can add them to the watchlist from there.` : 'Failed to post the report.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Report') {
    // Member-facing: right-click a message → Apps → Report → anonymous report to staff (works anywhere).
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified to report.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: 'Could not read that message.', flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't report a bot's message.", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = `Reported message: "${(target.content || '[no text — see link]').slice(0, 400)}" — ${target.url}`;
    const r = await reports.submit(interaction.guild, interaction.member, target.author, text);
    return interaction.editReply(r.ok ? `✅ Reported that message to staff anonymously (Report #${r.num}). They won’t know it was you.` : `❌ ${r.msg}`);
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Send to corner') {
    // Same access + tier rules as /corner, but the trigger is a specific message — and that message
    // gets forwarded into the corner so the member (and mods) see exactly what put them there.
    const isMod = (config.modRoleId && interaction.member?.roles?.cache?.has(config.modRoleId)) || interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isMod && !miniModCanActOn(interaction, interaction.targetMessage?.channelId)) return interaction.reply({ content: 'Only the mod role can use this.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: 'Could not read that message.', flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't corner a bot.", flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const member = await guild.members.fetch(target.author.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn’t in the server.', flags: MessageFlags.Ephemeral });
    if (member.id === client.user.id) return interaction.reply({ content: 'I can’t corner myself.', flags: MessageFlags.Ephemeral });
    const RANK = { owner: 3, admin: 2, mod: 1 };
    const actorRank = RANK[opspanel.tierOf(interaction)] || 0;
    const targetTier = opspanel.memberTier(member);
    if (member.id === guild.ownerId) return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
    if ((RANK[targetTier] || 0) > actorRank) return interaction.reply({ content: `You can’t corner someone of a higher staff tier than you (they’re **${targetTier}**).`, flags: MessageFlags.Ephemeral });
    // When the cornerReason feature is on, ask for an OPTIONAL reason first (modal → corner_reason submit).
    if (features.enabled('cornerReason')) {
      const modal = new ModalBuilder().setCustomId(`corner_reason:${member.id}:${target.channelId}:${target.id}`).setTitle('Send to corner');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)));
      return interaction.showModal(modal);
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await cornerFromMessage(guild, interaction.user.id, member, target, null);
    if (!res.ok) return interaction.editReply(`Failed to corner: ${res.error}`);
    return interaction.editReply(`🚫 Sent <@${member.id}> to the corner and forwarded their message there. Stripped **${res.stripped}** role(s).`);
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Strike') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can strike.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: 'Could not read that message.', flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't strike a bot.", flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(target.author.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn’t in the server.', flags: MessageFlags.Ephemeral });
    // Rule → reason+weight modal (two steps — a modal can't hold the rule dropdown).
    return interaction.reply({ content: 'Which rule (optional)?', components: [ruleRow(`strike_rule_pick:${member.id}:${target.channelId}:${target.id}`)], flags: MessageFlags.Ephemeral });
  }
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  if (name === 'cornered') {
    try { return await handleCorneredList(interaction); }
    catch (e) { console.error(`[cornered] ${e.message}`); return; }
  }
  if (name === 'pending') {
    if (!modClicked(interaction) && !isTrialMod(interaction)) return interaction.reply({ content: 'Only staff can use this.', flags: MessageFlags.Ephemeral });
    try { return await interaction.reply({ ...(await renderPending(0)), flags: MessageFlags.Ephemeral }); }
    catch (e) { console.error(`[pending] ${e.message}`); return; }
  }
  if (name === 'panel') {
    try {
      // Event organizers who aren't staff get the EVENT dashboard instead of the mod-only ops panel.
      if (features.enabled('contest') && !opspanel.memberTier(interaction.member) && !isTrialMod(interaction)
          && interaction.member?.roles?.cache?.has('1529976148706984110'))
        return await contest.openEventPanel(interaction);
      // Trial mods (not mod+) get the read-only view; mod+ get the full interactive panel.
      if (!opspanel.memberTier(interaction.member) && isTrialMod(interaction)) return await opspanel.openReadOnly(interaction);
      return await opspanel.openPersonalPanel(interaction);
    } catch (e) { console.error(`[fops] /panel ${e.message}`); return interaction.reply({ content: 'Could not open the panel.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'unban') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can unban.', flags: MessageFlags.Ephemeral });
    const id = (interaction.options.getString('user_id') || '').replace(/\D/g, '');
    if (!id) return interaction.reply({ content: 'Give a valid user ID.', flags: MessageFlags.Ephemeral });
    const keepWatch = interaction.options.getBoolean('watchlist') || false;
    const reason = interaction.options.getString('reason') || `Unban by ${interaction.user.tag}`;
    try { await interaction.guild.bans.remove(id, reason); }
    catch (e) { return interaction.reply({ content: `❌ Unban failed: ${e.message} (are they actually banned?)`, flags: MessageFlags.Ephemeral }); }
    if (keepWatch) watchlist.addPending(id);
    await ownerlog.log(interaction.guild, { emoji: '🔓', title: 'Unbanned', color: 0x57F287, detail: `\`${id}\` — ${reason} — by <@${interaction.user.id}>.${keepWatch ? ' Will be re-watchlisted on rejoin.' : ''}` });
    return interaction.reply({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      content: `✅ Unbanned <@${id}>.` + (keepWatch ? ' They\'ll get the **Watchlist** role automatically when they rejoin.' : '') });
  }
  if (name === 'contest-submit') {
    try { return await contest.submit(interaction); }
    catch (e) { console.error('[contest] submit:', e.message); return interaction.reply({ content: 'Something went wrong entering the contest.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'contest') {
    // Organizers (Event Organizer role holds ManageEvents), staff (mod+), and admins may manage contests.
    const canManage = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageEvents)
      || opspanel.memberTier(interaction.member)
      || interaction.member?.roles?.cache?.has('1529976148706984110');
    if (!canManage) return interaction.reply({ content: 'Only organizers or staff can manage contests.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'setup') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await contest.setup(interaction.guild);
        const chLines = r.channels.map(m => `• <#${m.ch.id}>${m.created ? ' _(created)_' : ''}`).join('\n');
        return interaction.editReply(`✅ Contest system ready.\n${chLines}\nWinner role: <@&${r.role.id}>\n\nNext: open a round with \`/contest start theme:<theme>\`. Optionally run \`/permguard resnapshot\` to bring these channels under the permission drift-guard.`);
      }
      if (sub === 'start') {
        const theme = interaction.options.getString('theme');
        const which = interaction.options.getString('contests') || 'all';
        const keys = which === 'all' ? null : which.split(',');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await contest.start(interaction.guild, theme, keys);
        return interaction.editReply(`✅ Opened the **${r.theme}** round for: ${r.active.map(k => contest.CONTESTS.find(c => c.key === k)?.label).join(', ')}. Announcements are posted + pinned.`);
      }
      if (sub === 'panel') {
        return contest.openEventPanel(interaction);
      }
      if (sub === 'status') {
        const embed = await contest.status(interaction.guild);
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      if (sub === 'end') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await contest.endRound(interaction.guild);
        if (!r.ok) return interaction.editReply(`⚠️ ${r.msg}`);
        const lines = Object.entries(r.results).map(([k, v]) => {
          const c = contest.CONTESTS.find(x => x.key === k);
          if (!v) return `• ${c.label}: no winner (no votes)`;
          return `• ${c.label}: ${v.winners.map(w => w.anonymous ? 'anon' : `<@${w.memberId}>`).join(' & ')} — ${v.votes} 🩷`;
        }).join('\n');
        return interaction.editReply(`🏁 Round closed, winners crowned + role assigned. Results also posted to <#1529981479331827722>.\n${lines}`);
      }
    } catch (e) {
      console.error('[contest]', e.message);
      const m = { content: `⚠️ ${e.message}`, flags: MessageFlags.Ephemeral };
      return (interaction.deferred || interaction.replied) ? interaction.editReply(m).catch(() => {}) : interaction.reply(m).catch(() => {});
    }
    return;
  }
  if (name === 'strike') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage strikes.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn’t in the server.', flags: MessageFlags.Ephemeral });
    const cap = strikes.BAN_THRESHOLD;
    const R = txt => interaction.reply({ content: txt, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (sub === 'view') {
      const total = strikes.totalUnits(state, user.id);
      const active = strikes.activeEntries(state, user.id);
      const lines = active.map(e => `\`${e.id}\` — **${strikes.formatUnits(e.weight)}** unit${e.weight === 1 ? '' : 's'} — ${e.ruleIndex ? `Rule ${e.ruleIndex}: ${SERVER_RULES[Number(e.ruleIndex) - 1]} — ` : ''}${e.reason || '_(no reason)_'}${e.timeoutMs ? ' ⏱️' : ''} — <t:${Math.floor(e.at / 1000)}:d>`);
      return R(`⚠️ <@${user.id}> is at **${strikes.formatUnits(total)}/${cap} units** (${strikes.tierName(total)}).${lines.length ? `\n${lines.join('\n')}` : ' No active strikes.'}`);
    }
    if (sub === 'add') {
      const reason = (interaction.options.getString('reason') || '').trim();
      const ruleN = interaction.options.getString('rule');
      if (!ruleN && !reason) return R('Give a reason — pick **which rule** they broke, type a **custom reason**, or both.');
      // weight omitted → use the picked rule's already-decided weight. Manually given always wins, even
      // over a rule with a different default (a deliberate override, not an error).
      const ruleObj = ruleN ? rules.byIndex(Number(ruleN)) : null;
      const ruleWeight = ruleObj ? rules.weightOf(ruleObj.key) : null;
      let weight = interaction.options.getInteger('weight');
      let weightAutoFilled = false;
      if (weight == null) {
        if (ruleWeight == null) return R(ruleN ? `Rule ${ruleN} doesn’t have a decided weight yet — specify one (1-3) manually.` : 'Specify a **weight** (1-3), or pick a rule that already has one decided.');
        weight = ruleWeight; weightAutoFilled = true;
      }
      const timeoutStr = interaction.options.getString('timeout');
      let timeoutMs = null;
      if (timeoutStr) {
        timeoutMs = corner.parseDuration(timeoutStr);
        if (!timeoutMs) return R('Bad timeout duration — use e.g. `30m`, `2h`, `3d`.');
      }
      const reasonText = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${reason ? ` — ${reason}` : ''}` : reason;
      const res = await strikes.addStrike(interaction.guild, member, state, { weight, ruleIndex: ruleN, reason: reasonText, timeoutMs, byId: interaction.user.id, byTag: interaction.user.tag });
      // res.weight is the EFFECTIVE weight (base + the timeout's linear-capped bonus) — always show
      // that, never the raw input, so the mod sees what was actually recorded.
      const bonus = strikes.timeoutBonusUnits(timeoutMs);
      // Public, no DMs: post in the channel the command was run in, in addition to the mod's ephemeral ack.
      // Strike ID included so the member can look up + appeal it without asking staff what it is.
      // Public, no DMs, but a real notification — ping the struck member (unlike reference-only mentions).
      await interaction.channel.send({ content: `⚠️ <@${user.id}> was given a strike — ${reasonText}${timeoutMs ? ' (+ timeout)' : ''}. Strike ID: \`${res.id}\` — appealable with \`/appeal strike\`.`, allowedMentions: { users: [user.id] } }).catch(() => {});
      const banNote = res.crossedBan ? banConfirmRow(user.id, 'Confirm ban') : null;
      await ownerlog.log(interaction.guild, { emoji: '⚠️', title: 'Strike given', color: 0xED4245,
        detail: `<@${user.id}> — ${strikes.formatUnits(res.weight)} unit(s), ${reasonText}${timeoutMs ? ' + timeout' : ''} — by <@${interaction.user.id}>. Now ${strikes.formatUnits(res.totalUnits)}/${cap}.` });
      return interaction.reply({ content: `⚠️ Gave <@${user.id}> a **${strikes.formatUnits(res.weight)}-unit** strike${weightAutoFilled ? ` (${weight} — Rule ${ruleN}’s decided weight)` : ''}${timeoutMs ? ` (${weight} base + ${strikes.formatUnits(bonus)} for the timeout)` : ''} — now **${strikes.formatUnits(res.totalUnits)}/${cap} units** (${res.tier})${res.crossedBan ? ' — 🔨 **crossed the ban threshold**' : ''}.`,
        components: banNote ? [banNote] : [], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'remove') {
      const strikeId = interaction.options.getString('strike_id');
      const r = await strikes.removeStrike(interaction.guild, member, state, strikeId, interaction.user.tag);
      if (!r.ok) return R(`No active strike \`${strikeId}\` found on <@${user.id}> — check \`/strike view\` for the right ID.`);
      await ownerlog.log(interaction.guild, { emoji: '➖', title: 'Strike removed', color: 0x57F287,
        detail: `\`${strikeId}\` from <@${user.id}> — by <@${interaction.user.id}>. Now ${strikes.formatUnits(r.totalUnits)}/${cap}.` });
      return R(`✅ Removed strike \`${strikeId}\` from <@${user.id}> — now **${strikes.formatUnits(r.totalUnits)}/${cap} units** (${r.tier}).`);
    }
    if (sub === 'clear') {
      const r = await strikes.clearStrikes(interaction.guild, member, state, interaction.user.tag);
      if (r.cleared) await ownerlog.log(interaction.guild, { emoji: '🧹', title: 'Strikes cleared', color: 0x57F287, detail: `All strikes (${r.cleared}) on <@${user.id}> — by <@${interaction.user.id}>.` });
      return R(r.cleared ? `🧹 Cleared all strikes on <@${user.id}> (removed ${r.cleared}).` : `<@${user.id}> had no strikes.`);
    }
    return;
  }
  if (name === 'verify') {
    if (!canVerify(interaction)) return interaction.reply({ content: 'Only staff (mods+ or trial mods) can verify members.', flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn’t in the server.', flags: MessageFlags.Ephemeral });
    if (config.verifiedRoleId && member.roles.cache.has(config.verifiedRoleId))
      return interaction.reply({ content: `<@${user.id}> is already verified.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    await member.roles.add(config.verifiedRoleId, `Verified via /verify by ${interaction.user.tag}`).catch(() => {});
    if (config.unverifiedRoleId) await member.roles.remove(config.unverifiedRoleId, 'Verified via /verify').catch(() => {});
    return interaction.reply({ content: `✅ Verified <@${user.id}> (\`${user.tag}\`).`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (name === 'features') {
    const ftier = opspanel.tierOf(interaction);
    if (ftier !== 'owner') return interaction.reply({ content: '🔒 Feature toggles are **Owner** only.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const flags = features.load();
      const lines = features.REGISTRY.map(r => `${flags[r.key] === true ? '🟢' : '⚫'} \`${r.key}\` — ${r.audience}${r.built ? '' : ' (planned)'}`).join('\n');
      return interaction.reply({ content: `**Features:**\n${lines}`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'toggle') {
      const key = interaction.options.getString('feature');
      const on = interaction.options.getBoolean('on');
      if (!features.get(key)) return interaction.reply({ content: `Unknown feature \`${key}\`.`, flags: MessageFlags.Ephemeral });
      features.setEnabled(key, on);
      const restart = features.needsRestart(key);
      await ownerlog.log(interaction.guild, { emoji: on ? '🟢' : '⚫', title: `Feature ${on ? 'enabled' : 'disabled'}`, color: on ? 0x57F287 : 0x99AAB5, detail: `\`${key}\` — by <@${interaction.user.id}>.` });
      return interaction.reply({ content: `${on ? '🟢' : '⚫'} \`${key}\` → **${on ? 'ON' : 'OFF'}**.`
        + (restart ? ' ⚠️ Restart the bot for this to fully take effect (it adds/removes commands or options).' : ' Takes effect immediately — no restart needed.'),
        flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (name === 'permguard') {
    const ptier = opspanel.tierOf(interaction);
    if (ptier !== 'owner') return interaction.reply({ content: '🔒 Permission-guard controls are **Owner** only.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'status') {
      const r = await permguard.sweepPermissions(interaction.guild, { notify: true });
      const lines = [`🛡️ Sweep complete.`, `Corrected: **${r.fixed}** overwrite(s).`, `New per-member overrides flagged: **${r.newMemberOverwrites.length}**.`, `Unmanaged channels (created after last snapshot): **${r.unmanagedChannels}**.`];
      if (r.fixed) lines.push('', ...r.corrections.slice(0, 15).map(c => `• #${c.channel} — ${c.role}`));
      return interaction.editReply(lines.join('\n'));
    }
    if (sub === 'resnapshot') {
      if (interaction.options.getBoolean('force')) {
        const r = await permguard.resnapshot(interaction.guild);
        await ownerlog.log(interaction.guild, { emoji: '📸', title: 'Permission baseline re-snapshotted (forced)', color: 0x5865F2, detail: `${r.channels} channels, ${r.overwrites} overwrite entries — by <@${interaction.user.id}>. Whatever's live right now is the new "correct" state (no review).` });
        return interaction.editReply(`📸 New baseline saved: **${r.channels}** channels, **${r.overwrites}** overwrite entries. This is now what permguard will enforce.`);
      }
      // Default: interactive review — show every change since the baseline, keep/undo each, then commit.
      return permguard.openReconcile(interaction);
    }
    return;
  }
  if (name === 'watchlist') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can use this.', flags: MessageFlags.Ephemeral });
    if (!config.watchlistRoleId) return interaction.reply({ content: 'No Watchlist role configured.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      await interaction.guild.members.fetch().catch(() => {});
      const role = interaction.guild.roles.cache.get(config.watchlistRoleId);
      const members = role ? [...role.members.values()] : [];
      const pend = watchlist.loadPending();
      return interaction.reply({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        content: `**On the Watchlist (${members.length}):**\n${members.map(m => `• <@${m.id}> \`${m.user.tag}\``).join('\n') || '_none_'}`
          + (pend.length ? `\n\n**Pending (watchlist on rejoin, ${pend.length}):** ${pend.map(x => `<@${x}>`).join(', ')}` : '') });
    }
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can edit the watchlist.', flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn\'t in the server.', flags: MessageFlags.Ephemeral });
    try {
      if (sub === 'add') { await member.roles.add(config.watchlistRoleId, `Watchlist by ${interaction.user.tag}`); return interaction.reply({ content: `👁 <@${user.id}> added to the Watchlist.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); }
      if (sub === 'remove') { await member.roles.remove(config.watchlistRoleId, `Un-watchlist by ${interaction.user.tag}`); watchlist.removePending(user.id); return interaction.reply({ content: `✅ <@${user.id}> removed from the Watchlist.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); }
    } catch (e) { return interaction.reply({ content: `❌ ${e.message}`, flags: MessageFlags.Ephemeral }); }
    return;
  }
  if (name === 'watchlist-suggest') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can use this.', flags: MessageFlags.Ephemeral });
    const hours = interaction.options.getInteger('hours') || 6;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await suggest.scan(interaction.guild, config, hours);
      return await interaction.editReply(suggest.render(result));
    } catch (e) {
      console.error(`[suggest] ${e.message}`);
      return interaction.editReply({ content: `Scan failed: ${e.message}` }).catch(() => {});
    }
  }
  if (name === 'suggest-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set up the forum.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { forum, created } = await suggestions.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : 'ℹ️ Already set up:'} the suggestions forum <#${forum.id}>. Members post with \`/suggest\`.`);
    } catch (e) { console.error(`[suggestions] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'suggest') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can post suggestions.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await suggestions.submit(interaction.guild, interaction.member, interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Posted **Suggestion #${r.num}** → <#${r.threadId}>. Others can vote; staff will approve or deny.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[suggestions] submit ${e.message}`); return interaction.editReply('Could not post that suggestion.').catch(() => {}); }
  }
  if (name === 'confess-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set this up.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { channel, logChannel, created } = await confessions.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : 'ℹ️ Already set up:'} confessions <#${channel.id}>${logChannel ? ` + staff log <#${logChannel.id}>` : ''}. Members post with \`/confess\`.`);
    } catch (e) { console.error(`[confessions] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'confess') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can confess.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await confessions.submit(interaction.guild, interaction.member, interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Posted **Confession #${r.num}** anonymously. Your name is hidden from other members.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[confessions] submit ${e.message}`); return interaction.editReply('Could not post that confession.').catch(() => {}); }
  }
  if (name === 'whistleblow-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set this up. Run it as the head admin — you become the “you” who can unseal.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const cfg = await whistleblow.setup(interaction.guild, interaction.user.id);
      return interaction.editReply(`✅ Whistleblows now DM **you** (<@${cfg.you}>) and/or the **owner** (<@${cfg.her}>) per the sender’s choice — delivered privately, never in a channel, so no one with Administrator can snoop. Members report with \`/whistleblow\`.`);
    } catch (e) { console.error(`[whistleblow] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'whistleblow') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await whistleblow.submit(interaction.guild, interaction.member, interaction.options.getString('text'), interaction.options.getString('to'));
      return interaction.editReply(r.ok
        ? `✅ Sent **Whistleblow #${r.num}** — delivered privately by DM. You chose: **${whistleblow.CHOICES[r.choice]}**.${r.choice === 'anonymous' ? ' No identity was stored — this can never be traced to you.' : ''}`
        : `❌ ${r.msg}`);
    } catch (e) { console.error(`[whistleblow] submit ${e.message}`); return interaction.editReply('Could not send that.').catch(() => {}); }
  }
  if (name === 'apply-mod-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set this up.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { forum, apps } = await modapps.setup(interaction.guild, config);
      return interaction.editReply(`✅ Mod applications ready — staff review forum <#${forum.id}> (anon 👍/👎, admins decide) + applicant threads in <#${apps.id}>. Members apply with \`/apply-mod\`.`);
    } catch (e) { console.error(`[modapps] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'apply-mod') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can apply.', flags: MessageFlags.Ephemeral });
    if (!modapps.isConfigured()) return interaction.reply({ content: 'Mod applications aren’t open right now.', flags: MessageFlags.Ephemeral });
    if (!modapps.applicationsOpen()) return interaction.reply({ content: modapps.closedNotice(), flags: MessageFlags.Ephemeral });
    // If language mini-mods are set up, ask which position first; otherwise go straight to the mod modal.
    if (features.enabled('langMiniMod') && langmods.isConfigured()) {
      return interaction.reply({ content: 'What are you applying for?', components: [modapps.positionRow()], flags: MessageFlags.Ephemeral });
    }
    try { return await interaction.showModal(modapps.buildModal()); }
    catch (e) { console.error(`[modapps] showModal ${e.message}`); }
    return;
  }
  if (name === 'mod-applications') {
    const mtier = opspanel.memberTier(interaction.member);
    if (mtier !== 'admin' && mtier !== 'owner' && !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: 'Only admins can open or close mod applications.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const open = modapps.applicationsOpen();
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: open
        ? '✅ Mod applications are **OPEN**. Members can `/apply-mod`.'
        : `🚫 Mod applications are **CLOSED**.\nMembers who try to apply see:\n> ${modapps.closedNotice()}` });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'close') {
      const msg = interaction.options.getString('message');
      await modapps.setApplicationsOpen(interaction.guild, false, msg);
      await ownerlog.log(interaction.guild, { emoji: '🚫', title: 'Mod applications CLOSED', color: 0xED4245, detail: `Closed by <@${interaction.user.id}> (team full). New \`/apply-mod\` is turned away; in-flight applications still finish.${msg ? `\nNote to applicants: ${msg}` : ''}` });
      return interaction.editReply(`🚫 Mod applications are now **CLOSED**. New \`/apply-mod\` attempts are turned away; applications already under review still finish. Reopen anytime with \`/mod-applications open\`.`);
    }
    if (sub === 'open') {
      await modapps.setApplicationsOpen(interaction.guild, true);
      await ownerlog.log(interaction.guild, { emoji: '✅', title: 'Mod applications REOPENED', color: 0x57F287, detail: `Reopened by <@${interaction.user.id}> — members can \`/apply-mod\` again.` });
      return interaction.editReply('✅ Mod applications are now **OPEN**. Members can `/apply-mod` again.');
    }
    return;
  }
  if (name === 'staff') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can view the census.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await interaction.guild.members.fetch().catch(() => null);
    if (!members) return interaction.editReply('Couldn’t load the member list — try again.').catch(() => {});
    const trialId = modapps.loadConfig().trialModRoleId;
    // Counted by HIGHEST tier so nobody is double-counted (higher tiers absorb the lower). memberTier
    // returns owner→admin→mod (the bot's canonical tier); Trial Mod is only counted for people below mod.
    let owner = 0, admin = 0, mod = 0, trial = 0, humans = 0;
    for (const m of members.values()) {
      if (m.user.bot) continue;
      humans++;
      const t = opspanel.memberTier(m);
      if (t === 'owner') owner++;
      else if (t === 'admin') admin++;
      else if (t === 'mod') mod++;
      else if (trialId && m.roles.cache.has(trialId)) trial++;
    }
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('👥 Staff census')
      .setDescription('Counted by **highest tier** — each person once (higher tiers absorb the lower).')
      .addFields(
        { name: '🟣 Owner', value: String(owner), inline: true },
        { name: '🔵 Admin', value: String(admin), inline: true },
        { name: '🟢 Mod', value: String(mod), inline: true },
        { name: '✧ Trial Mod', value: String(trial), inline: true },
        { name: '- Total unique staff', value: `**${owner + admin + mod + trial}**`, inline: true })
      .setFooter({ text: `${humans} human members` }).setTimestamp(new Date());
    return interaction.editReply({ embeds: [embed] }).catch(() => {});
  }
  if (name === 'promote-trial' || name === 'promote-mod') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can open a promotion vote.', flags: MessageFlags.Ephemeral });
    const target = interaction.options.getMember('member');
    if (!target) return interaction.reply({ content: 'Couldn’t find that member in the server.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const kind = name === 'promote-mod' ? 'mod' : 'trial';
    const r = await promote.start(interaction.guild, target, interaction.user.id, config, kind);
    return interaction.editReply(r.ok ? `✅ Promotion vote opened in <#${r.channelId}> — staff vote 👍/👎, an owner confirms.` : `❌ ${r.msg}`).catch(() => {});
  }
  if (name === 'demote-trial') {
    // Owner/approver only — the inverse of accepting an application, so it takes the same tier.
    const approvers = modapps.loadConfig().approvers || [];
    if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id))
      return interaction.reply({ content: 'Only the **server owner** can demote a trial mod.', flags: MessageFlags.Ephemeral });
    const roleId = modapps.loadConfig().trialModRoleId;
    if (!roleId) return interaction.reply({ content: 'No Trial Mod role is configured — run `/apply-mod-setup` first.', flags: MessageFlags.Ephemeral });
    const target = interaction.options.getMember('member');
    if (!target) return interaction.reply({ content: 'Couldn’t find that member in the server.', flags: MessageFlags.Ephemeral });
    if (!target.roles.cache.has(roleId)) return interaction.reply({ content: `<@${target.id}> isn’t a **Trial Mod**, so there’s nothing to remove.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason');
    const ok = await target.roles.remove(roleId, `Trial Mod demoted by ${interaction.user.tag}${reason ? ` - ${reason}` : ''}`).then(() => true).catch(() => false);
    return interaction.editReply(ok
      ? `✅ Removed the **Trial Mod** role from <@${target.id}>.${reason ? ` (noted: ${reason})` : ''}`
      : '❌ Couldn’t remove the role — make sure the bot’s own role sits above **Trial Mod**.').catch(() => {});
  }
  if (name === 'help') {
    return interaction.reply({ embeds: [helpEmbed(interaction.guild)], flags: MessageFlags.Ephemeral });
  }
  if (name === 'roleselect-role') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can manage #roles.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const section = interaction.options.getString('section');
    const role = interaction.options.getRole('role');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = sub === 'add'
        ? roleselect.addRoleToSection(section, interaction.options.getString('label') || role.name, role.id)
        : roleselect.removeRoleFromSection(section, role.id);
      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      await roleselect.rebuildFromIndex(interaction.guild, config.rolesChannelId, roleselect.SECTION_BLOCK_INDEX[section]);
      return interaction.editReply(`✅ ${sub === 'add' ? 'Added' : 'Removed'} <@&${role.id}> ${sub === 'add' ? 'to' : 'from'} **${roleselect.SECTION_TITLE[section]}** — #roles updated.`);
    } catch (e) { console.error(`[roleselect-role] ${e.message}`); return interaction.editReply(`Failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'request-role-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set this up.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try { const { channel, created } = await rolereq.setup(interaction.guild, config); return interaction.editReply(`${created ? '✅ Created' : 'ℹ️ Already set up:'} <#${channel.id}>. Members use \`/request-role\`.`); }
    catch (e) { console.error(`[rolereq] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'request-role') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can request a role.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const removing = interaction.options.getBoolean('remove') || false;
      const r = await rolereq.submit(interaction.guild, interaction.member, interaction.options.getRole('role'), config, removing);
      return interaction.editReply(r.ok ? `✅ Requested ${removing ? 'to give up' : ''} **${r.role}** — staff will review it.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[rolereq] ${e.message}`); return interaction.editReply('Could not send that request.').catch(() => {}); }
  }
  if (name === 'appeal-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set this up.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { channel, created } = await appeals.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : 'ℹ️ Already set up:'} <#${channel.id}>. Friends of a banned member appeal with \`/appeal ban <username>\` — it opens a private thread; staff Approve (unbans) or Deny.`);
    } catch (e) { console.error(`[appeals] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'appeal-strike-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set this up.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { channel, created } = await strikeAppeals.setup(interaction.guild);
      return interaction.editReply(`${created ? '✅ Created' : 'ℹ️ Already set up:'} <#${channel.id}>. A struck member appeals their own strike with \`/appeal strike <strike>\` — it opens a private thread; staff Approve (removes it) or Deny.`);
    } catch (e) { console.error(`[strikeAppeals] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'appeal') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can open an appeal.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'ban') {
      try {
        const r = await appeals.submit(interaction.guild, interaction.member, interaction.options.getString('username'), interaction.options.getString('note'));
        return interaction.editReply(r.ok
          ? (r.joined ? `🤝 Added you to the open appeal for **${r.name}** → <#${r.threadId}>.` : `✅ Opened an appeal for **${r.name}** → <#${r.threadId}>. Make the case there; up to 5 friends can join. Staff will decide.`)
          : `❌ ${r.msg}`);
      } catch (e) { console.error(`[appeals] ${e.message}`); return interaction.editReply('Could not open that appeal.').catch(() => {}); }
    }
    try {
      const r = await strikeAppeals.submit(interaction.guild, interaction.member, state, interaction.options.getString('strike_id'), interaction.options.getString('note'));
      return interaction.editReply(r.ok ? `✅ Opened your strike appeal → <#${r.threadId}>. Explain your side there — staff will decide.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[strikeAppeals] ${e.message}`); return interaction.editReply('Could not open that appeal.').catch(() => {}); }
  }
  if (name === 'report-setup' || name === 'modmail-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can set this up.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const mod = name === 'report-setup' ? reports : modmail;
      const { channel, created } = await mod.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : 'ℹ️ Already set up:'} <#${channel.id}>.`);
    } catch (e) { console.error(`[${name}] ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'report') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await reports.submit(interaction.guild, interaction.member, interaction.options.getUser('user'), interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Sent **Report #${r.num}** to staff anonymously.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[reports] ${e.message}`); return interaction.editReply('Could not send that report.').catch(() => {}); }
  }
  if (name === 'modmail') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await modmail.submit(interaction.guild, interaction.member, interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Sent **Modmail #${r.num}** to the mod team anonymously.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[modmail] ${e.message}`); return interaction.editReply('Could not send that.').catch(() => {}); }
  }
  if (name === 'watchlist-terms') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can use this.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const scope = interaction.options.getString('scope');
    if (sub === 'list') {
      const s = watchlist.loadTerms(), l = watchlist.loadLoose(), w = watchlist.loadWelfare();
      const parts = [];
      if (!scope || scope === 'strict') parts.push(`**Strict (${s.length} + all ${l.length} loose)** → watchlisted members, ban alerts:\n${s.map(t => `\`${t}\``).join(' · ') || '_(only the loose terms)_'}`);
      if (!scope || scope === 'loose') parts.push(`**Loose (${l.length})** → #watch-log:\n${l.map(t => `\`${t}\``).join(' · ') || '_none_'}`);
      if (!scope || scope === 'welfare') parts.push(`**Welfare (${w.length})** → #watch-log check-in:\n${w.map(t => `\`${t}\``).join(' · ') || '_none_'}`);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: parts.join('\n\n').slice(0, 1900) });
    }
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can edit the terms.', flags: MessageFlags.Ephemeral });
    const term = interaction.options.getString('term');
    const which = scope || 'strict';
    const adder = { strict: watchlist.addTerm, loose: watchlist.addLoose, welfare: watchlist.addWelfare }[which];
    const remover = { strict: watchlist.removeTerm, loose: watchlist.removeLoose, welfare: watchlist.removeWelfare }[which];
    if (sub === 'add') { const t = adder(term); return interaction.reply({ content: `➕ Added ${which} term \`${term}\`. ${t.length} ${which} term(s) now.`, flags: MessageFlags.Ephemeral }); }
    if (sub === 'remove') { const t = remover(term); return interaction.reply({ content: `➖ Removed ${which} term \`${term}\`. ${t.length} left.`, flags: MessageFlags.Ephemeral }); }
    return;
  }
  if (name !== 'corner' && name !== 'uncorner') return;
  try {
    // Access is tied to the MOD ROLE (not a permission). Admins can always use it as an override. Trial
    // mods may ALSO corner — but only regular members (the tier check below stops them cornering staff)
    // and under restrictions (rule + reason required, ≤1h), enforced in the corner block.
    const trial = isTrialMod(interaction);
    const isMod = (config.modRoleId && interaction.member?.roles?.cache?.has(config.modRoleId))
      || interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isMod && !trial) return interaction.reply({ content: 'Only staff (mods+ or trial mods) can use this.', flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const user = interaction.options.getUser('user');
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member is not in the server.', flags: MessageFlags.Ephemeral });
    if (member.id === client.user.id) return interaction.reply({ content: 'I cannot corner myself.', flags: MessageFlags.Ephemeral });

    if (name === 'corner') {
      // Tier hierarchy: you may corner your OWN staff tier or LOWER — never a higher tier. So equal
      // tiers can corner each other (mod↔mod, admin↔admin), staff can corner regular members, but a mod
      // can't corner an admin. Ranks: owner > admin > mod > member. The guild owner is never cornerable
      // (and OWNER⚜️ sits above the bot's role, so the bot couldn't strip it regardless).
      const RANK = { owner: 3, admin: 2, mod: 1 };
      const actorRank = RANK[opspanel.tierOf(interaction)] || 0;      // actor's tier (admin if Administrator-perm)
      const targetTier = opspanel.memberTier(member);                 // target's role-only tier
      const targetRank = RANK[targetTier] || 0;
      if (member.id === guild.ownerId) {
        return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
      }
      if (targetRank > actorRank) {
        return interaction.reply({ content: `You can’t corner someone of a higher staff tier than you (they’re **${targetTier}**).`, flags: MessageFlags.Ephemeral });
      }
      const durStr = interaction.options.getString('duration');
      let durationMs = null;
      if (durStr) {
        durationMs = corner.parseDuration(durStr);
        if (!durationMs) return interaction.reply({ content: 'Bad duration — use e.g. `30m`, `2h`, `3d`.', flags: MessageFlags.Ephemeral });
      }
      // Reason: a picked rule and/or a custom typed reason. Show both when present.
      const ruleN = interaction.options.getString('rule');
      const customReason = interaction.options.getString('reason');
      const reasonText = [ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}` : null, customReason].filter(Boolean).join(' — ') || null;
      // Trial-mod restrictions: must give a rule OR a reason (same "not both required" convention as
      // /strike elsewhere), and the corner can't exceed 1 hour.
      if (trial) {
        if (!ruleN && !customReason) return interaction.reply({ content: 'As a **trial mod**, you must pick a **rule** or give a **reason** to corner someone.', flags: MessageFlags.Ephemeral });
        if (!durationMs) return interaction.reply({ content: 'As a **trial mod**, you must set a **duration** — max **1 hour** (e.g. `30m`, `1h`).', flags: MessageFlags.Ephemeral });
        if (durationMs > 3600000) return interaction.reply({ content: 'As a **trial mod**, a corner can be **at most 1 hour**.', flags: MessageFlags.Ephemeral });
      }
      // Hide the mod ack if the command is run IN the corner channel (the themed embed already posts there).
      const inCorner = interaction.channelId === config.cornerChannelId;
      await interaction.deferReply({ flags: inCorner ? MessageFlags.Ephemeral : undefined });
      const r = await corner.corner(guild, member, durationMs, state, interaction.user.id, ruleN);
      if (!r.ok) return interaction.editReply(`Failed to corner: ${r.error}`);
      await maybeAlertCornerRepeat(guild, member, ruleN, r.repeatCount);
      const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
      const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
      // Announce in the corner channel so the cornered member sees it there.
      try {
        const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
        if (cornerCh) await cornerCh.send(cornerSentMessage(user.id, whenPhrase, reasonText));
      } catch (e) { console.error(`[corner] channel announce failed: ${e.message}`); }
      const modWhen = relSec ? `until <t:${relSec}:f>` : 'indefinitely (until manually released)';
      await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER', color: CORNER_RED,
        desc: `<@${user.id}> was cornered ${relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**'}.\n**By:** <@${interaction.user.id}>${reasonText ? `\n**Reason:** ${reasonText}` : ''}` });
      return interaction.editReply(`🚫 Sent ${user} to the corner ${modWhen}${reasonText ? ` — ${reasonText}` : ''}. Stripped **${r.stripped}** role(s).`);
    } else {
      const inCorner = interaction.channelId === config.cornerChannelId;
      const durStr = interaction.options.getString('duration');
      let durationMs = null;
      if (durStr) {
        durationMs = corner.parseDuration(durStr);
        if (!durationMs) return interaction.reply({ content: 'Bad duration — use e.g. `30m`, `2h`, `3d`.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: inCorner ? MessageFlags.Ephemeral : undefined });
      if (durationMs) {
        // Schedule a future release (e.g. give an indefinitely-cornered member a release time). The
        // auto-release loop frees them + posts the "time served" embed when it expires.
        const rec = state.getCornered(user.id);
        if (!rec) return interaction.editReply(`${user} is not in the corner.`);
        const releaseAt = Date.now() + durationMs;
        state.setCornered(user.id, { ...rec, releaseAt });
        await logCorner(guild, { emoji: '⏳', title: 'RELEASE SCHEDULED', color: CORNER_AMBER,
          desc: `<@${user.id}>'s release was scheduled.\n**Release:** ${relPhrase(releaseAt)}\n**By:** <@${interaction.user.id}>` });
        return interaction.editReply(`⏳ Scheduled ${user}'s release <t:${Math.floor(releaseAt / 1000)}:R> (at <t:${Math.floor(releaseAt / 1000)}:f>). The corner will release them automatically.`);
      }
      const r = await corner.uncorner(guild, user.id, state);
      if (!r.ok) return interaction.editReply(`Failed to release: ${r.error}`);
      const served = servedSuffix(r.servedMs);
      try {
        const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
        if (cornerCh) await cornerCh.send(cornerReleasedMessage(user.id));
      } catch (e) { console.error(`[corner] channel announce failed: ${e.message}`); }
      await logCorner(guild, { emoji: '🔓', title: 'RELEASED', color: CORNER_GREEN,
        desc: `<@${user.id}> was released — roles restored.\n**By:** <@${interaction.user.id}>${served}` });
      return interaction.editReply(`✅ Released ${user} from the corner. Restored **${r.restored}** role(s)${served}.`);
    }
  } catch (err) {
    console.error(`[corner] command error: ${err.message}`);
    const msg = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.on('error', err => console.error(`[client] ${err.message}`));
client.on('shardError', err => console.error(`[shard] ${err.message}`));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

client.login(config.token);
