// rolereq.js — casual role requests. A member runs /request-role, picks a role, and it goes to a
// staff-only channel where anyone mod+ can Approve (assigns it) or Deny. Only SAFE/casual roles are
// requestable — never staff/important roles. A role is refused if it: is @everyone, is a bot/integration
// (managed) role, sits at/above the bot (unassignable), carries ANY power permission, or is a known
// system/staff role (mod/admin/owner/trial/verified/unverified/corner/watchlist/strike).
const fs = require('fs');
const copy = require('./copy');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');

const CONFIG_FILE = process.env.FUBU_ROLEREQ_FILE || '/home/ubuntu/.fubu_rolereq.json';
const P = PermissionsBitField.Flags;
// Any of these on a role = "important", not requestable.
const POWER = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers,
  P.ModerateMembers, P.ManageMessages, P.MentionEveryone, P.ManageWebhooks, P.ManageEvents, P.ManageThreads,
  P.ManageNicknames, P.ViewAuditLog, P.ManageGuildExpressions];
// Known staff/system roles, never requestable (belt-and-suspenders on top of the power check).
const STAFF = ['1528316361665675316', '1516179051105226833', '1532037321740779860',
  '1516235123841040394', '1517718734989693038', '1517718258784927814', '1517717893415047328'];
// NOTE: OWNER⚜️ (1527430885287264438) intentionally REMOVED from this blocklist (owner 2026-08-05) — it was
// stripped to zero permissions + zero channel overwrites to become a cosmetic joke role, so it's now
// self-requestable via /request-role (the power check keeps any FUTURE perms from sneaking it through).

const loadConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
const saveConfig = c => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c)); } catch (e) { console.error('[rolereq] save:', e.message); } };
function isConfigured() { return !!loadConfig().channelId; }

// Per-member daily cap on role requests (owner, 2026-08-05) — keeps staff from being spammed.
const REQUEST_DAILY_CAP = 3;
const _today = () => new Date().toISOString().slice(0, 10);
function requestsToday(userId) { const r = (loadConfig().daily || {})[userId]; return (r && r.day === _today()) ? r.count : 0; }
function bumpRequests(userId) { const c = loadConfig(); if (!c.daily) c.daily = {}; const day = _today(); const r = c.daily[userId]; c.daily[userId] = (r && r.day === day) ? { day, count: r.count + 1 } : { day, count: 1 }; saveConfig(c); }

function systemRoleIds(config) {
  // Tribe LEADER + General (staff auto-rank) roles are earned/appointed, never self-requestable — the base
  // tribe role stays OUT of this set on purpose, it's the sanctioned /request-role petition path for a
  // veteran wanting into a tribe (see the roleselect_tribe handler). Read live so a newly founded tribe's
  // roles are covered without a code change (owner, 2026-08-03: "remove the tribe leader and general ranks").
  const tribes = require('./tribes');
  // Leader + General (staff auto-rank) AND the earned rank-ladder rungs (Initiate..Elder) are never
  // self-requestable — ranks are earned by tenure + Tides, not asked for (owner, 2026-08-05). The base tribe
  // role stays OUT of this set on purpose: it's the sanctioned /request-role petition path for a veteran
  // wanting into a tribe (see the roleselect_tribe handler).
  const tribeRoles = tribes.all().flatMap(t => [t.leaderRoleId, t.staffRankRoleId, ...((t.ranks || []).map(r => r.roleId))]);
  return new Set([...STAFF, ...tribeRoles, config.modRoleId, config.verifiedRoleId, config.unverifiedRoleId,
    config.cornerRoleId, ...(config.strikeRoleIds || [])].filter(Boolean));
}
// Why a role can't be requested (null = it's fine).
function whyNotRequestable(role, guild, me, config) {
  if (role.id === guild.id) return 'that’s @everyone';
  if (role.managed) return 'that’s a bot/integration role';
  if (role.position >= me.roles.highest.position) return 'that role is above me, I can’t assign it';
  if (POWER.some(p => role.permissions.has(p))) return 'that’s a staff/permission role, not requestable';
  if (systemRoleIds(config).has(role.id)) return 'that’s a staff/system role, not requestable';
  return null;
}

async function setup(guild, config) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const wl = config?.watchLogChannelId ? await guild.channels.fetch(config.watchLogChannelId).catch(() => null) : null;
  const overwrites = (wl && wl.permissionOverwrites.cache.size)
    ? [...wl.permissionOverwrites.cache.values()].map(o => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
    : [{ id: guild.id, deny: [P.ViewChannel] }];
  const channel = await guild.channels.create({
    name: '🎭┆ʀᴏʟᴇ-ʀᴇqᴜᴇsᴛs', type: ChannelType.GuildText,
    topic: 'Casual role requests from members. Approve to assign, or deny.',
    permissionOverwrites: overwrites, reason: 'Role requests (owner request)',
  });
  c = { ...c, channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

// customId carries the action (add|remove) so handleButton knows which direction to apply on approval.
const btns = (userId, roleId, act, done, byId, ok) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`rolereq_ok:${userId}:${roleId}:${act}`).setEmoji('✅').setLabel(done ? (ok ? (act === 'remove' ? 'Removed' : 'Granted') : 'Approve') : 'Approve').setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId(`rolereq_no:${userId}:${roleId}:${act}`).setEmoji('❌').setLabel(done ? (!ok ? 'Denied' : 'Deny') : 'Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done));

// removing=true: request that a role you HOLD be taken away (self-service opt-out), instead of the
// default request-to-be-granted. Same safety net (whyNotRequestable) and same staff approve/deny channel.
async function submit(guild, member, role, config, removing = false) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: copy.rolereq.notSetup };
  const me = await guild.members.fetchMe();
  const why = whyNotRequestable(role, guild, me, config);
  if (why) return { ok: false, msg: copy.rolereq.cantRequest(why) };
  if (removing && !member.roles.cache.has(role.id)) return { ok: false, msg: copy.rolereq.dontHave };
  if (!removing && member.roles.cache.has(role.id)) return { ok: false, msg: copy.rolereq.alreadyHave };
  if (requestsToday(member.id) >= REQUEST_DAILY_CAP) return { ok: false, msg: `You’ve hit the daily limit of ${REQUEST_DAILY_CAP} role requests. Try again tomorrow.` };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: copy.rolereq.channelMissing };
  const embed = new EmbedBuilder().setColor(role.color || 0x5865F2).setTitle(removing ? '🎭 Role removal request' : '🎭 Role request')
    .setDescription(`<@${member.id}> is requesting to ${removing ? 'GIVE UP' : 'be given'} the <@&${role.id}> role.`)
    .setFooter({ text: `Any mod+ can approve (${removing ? 'removes it' : 'assigns it'}) or deny.` }).setTimestamp(new Date());
  await channel.send({ embeds: [embed], components: [btns(member.id, role.id, removing ? 'remove' : 'add')], allowedMentions: { parse: [] } });
  bumpRequests(member.id);   // count it only once it's actually sent to staff
  return { ok: true, role: role.name };
}

// Approve/deny — gated to staff (mods+) in index.js.
async function handleButton(interaction) {
  const [action, userId, roleId, act] = interaction.customId.split(':');
  const removing = act === 'remove';
  const approve = action === 'rolereq_ok';
  const keep = interaction.message.embeds;
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
  if (approve) {
    if (!member) return interaction.reply({ content: copy.common.noMemberInServer, flags: MessageFlags.Ephemeral });
    if (!role) return interaction.reply({ content: copy.rolereq.noRole, flags: MessageFlags.Ephemeral });
    const verb = removing ? 'remove' : 'add';
    const ok = await member.roles[verb](roleId, `Role ${removing ? 'removal' : 'request'} approved by ${interaction.user.tag}`).then(() => true).catch(() => false);
    if (!ok) return interaction.reply({ content: copy.rolereq.couldntApply(removing), flags: MessageFlags.Ephemeral });
    await member.send(removing ? `✅ Your request to give up the **${role.name}** role was approved.` : `✅ Your request for the **${role.name}** role was approved!`).catch(() => {});
    return interaction.update({ content: `✅ <@${userId}> ${removing ? 'had **' + role.name + '** removed' : 'was given **' + role.name + '**'} by <@${interaction.user.id}>.`, embeds: keep, components: [btns(userId, roleId, act, true, interaction.user.id, true)], allowedMentions: { parse: [] } });
  }
  if (member) await member.send(`Your request to ${removing ? 'give up' : 'get'} the **${role ? role.name : 'requested'}** role was denied.`).catch(() => {});
  return interaction.update({ content: `❌ <@${userId}>'s request to ${removing ? 'give up' : 'get'} **${role ? role.name : 'the role'}** was denied by <@${interaction.user.id}>.`, embeds: keep, components: [btns(userId, roleId, act, true, interaction.user.id, false)], allowedMentions: { parse: [] } });
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, whyNotRequestable };
