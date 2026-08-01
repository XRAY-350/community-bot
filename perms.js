// perms.js — bot-owner permission inspector & auditor (the /perms command). Three modes:
//   • tier    — what a whole tier (member/trial/mod/admin/owner) can see, vs a plain member.
//   • channel — who can see/use one channel, per tier.
//   • audit   — a full tiered sweep for permission problems (view leaks, dangerous perms, thread-add exposure).
//
// KEY: effective permissions are computed for a HYPOTHETICAL member holding a tier's ROLE SET (always incl.
// VERIFIED, which carries base ViewChannel) — NOT the bare @everyone role. @everyone here has ViewChannel
// removed at the guild level, so testing it reads "hidden" even when real members can see a channel — the
// exact blind spot that hid the mod-call leak. We also use only each channel's OWN overwrites, matching
// Discord (category overwrites aren't walked at compute time; synced channels already carry copies). See
// memory: category-perms-dont-propagate.
const { PermissionsBitField, ChannelType } = require('discord.js');
const opspanel = require('./opspanel');
const config = require('./config');
const P = PermissionsBitField.Flags;

const TIERS = ['member', 'trial', 'mod', 'admin', 'owner'];
const TIER_LABEL = { member: 'Regular member', trial: 'Trial mod', mod: 'Mod', admin: 'Admin', owner: 'Owner' };

function tierRoleIds(tier) {
  const V = config.verifiedRoleId;
  switch (tier) {
    case 'member': return [V];
    case 'trial':  return [V, config.trialModRoleId];
    case 'mod':    return [V, opspanel.MOD_ROLE_ID];
    case 'admin':  return [V, opspanel.MOD_ROLE_ID, opspanel.ADMIN_ROLE_ID];
    case 'owner':  return [V, opspanel.MOD_ROLE_ID, opspanel.ADMIN_ROLE_ID, opspanel.OWNER_DISPLAY_ROLE_ID, ...opspanel.OWNER_ROLE_IDS];
    default: return [V];
  }
}

// Effective perms for a member holding {@everyone + roleIds} in this channel, using the channel's OWN overwrites.
function effPerms(channel, roleIds, guild) {
  const resolvables = [guild.roles.everyone.permissions];
  for (const id of roleIds) { const r = id && guild.roles.cache.get(id); if (r) resolvables.push(r.permissions); }
  const perms = new PermissionsBitField(resolvables);
  if (perms.has(P.Administrator)) return new PermissionsBitField(PermissionsBitField.All);
  const ow = channel.permissionOverwrites?.cache;
  if (!ow) return perms;
  const ev = ow.get(guild.id);
  if (ev) { perms.remove(ev.deny); perms.add(ev.allow); }
  const allow = new PermissionsBitField(), deny = new PermissionsBitField();
  for (const id of roleIds) { const o = id && ow.get(id); if (o) { allow.add(o.allow); deny.add(o.deny); } }
  perms.remove(deny); perms.add(allow);
  return perms;
}
const canView = (ch, roleIds, guild) => effPerms(ch, roleIds, guild).has(P.ViewChannel);

const realChannels = guild => [...guild.channels.cache.values()].filter(ch =>
  [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice].includes(ch.type));

const staffRoleIds = () => new Set([opspanel.MOD_ROLE_ID, opspanel.ADMIN_ROLE_ID, opspanel.OWNER_DISPLAY_ROLE_ID, ...opspanel.OWNER_ROLE_IDS].filter(Boolean));
// Is a channel EXPLICITLY meant for members? True if @everyone or VERIFIED is allowed ViewChannel at the
// channel OR its category level — i.e. a public/member channel (even if staff also have an overwrite there).
function memberIntended(ch, guild) {
  const ids = [guild.id, config.verifiedRoleId].filter(Boolean);
  const cat = ch.parentId ? guild.channels.cache.get(ch.parentId) : null;
  for (const src of [ch.permissionOverwrites?.cache, cat?.permissionOverwrites?.cache])
    for (const id of ids) if (src?.get(id)?.allow.has(P.ViewChannel)) return true;
  return false;
}
// "staff-intended" = grants ViewChannel to a staff role via its own overwrite AND is not a member channel.
function isStaffIntended(ch, guild) {
  const staff = staffRoleIds();
  const grantsStaff = [...(ch.permissionOverwrites?.cache.values() || [])].some(o => o.type === 0 && staff.has(o.id) && o.allow.has(P.ViewChannel));
  return grantsStaff && !memberIntended(ch, guild);
}
const hostsThreads = ch => [ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildAnnouncement].includes(ch.type);

// ---- tier mode ------------------------------------------------------------------------------------
function tierReport(guild, tier) {
  const memberIds = tierRoleIds('member'), tierIds = tierRoleIds(tier);
  const chans = realChannels(guild);
  const elevated = [], missing = [];
  let visible = 0;
  for (const ch of chans) {
    const t = canView(ch, tierIds, guild), m = canView(ch, memberIds, guild);
    if (t) visible++;
    if (t && !m) elevated.push(ch);
    if (!t && m) missing.push(ch);
  }
  const chLine = ch => `• <#${ch.id}>${ch.type === ChannelType.GuildVoice ? ' 🔊' : ch.type === ChannelType.GuildForum ? ' 🧵' : ''}`;
  const lines = [`## 👁️ What **${TIER_LABEL[tier]}** can see`, `-# sees ${visible} of ${chans.length} channels`];
  if (tier === 'member') {
    lines.push(`\nThis is the baseline everyone is measured against — all the non-staff chat, hobby, country and event channels.`);
  } else {
    lines.push(`\nSees everything a regular member sees, **plus these ${elevated.length} restricted channel(s):**`);
    lines.push(elevated.length ? elevated.map(chLine).join('\n') : '_(none — no elevated access)_');
    if (missing.length) lines.push(`\n⚠️ **${missing.length}** channel(s) a regular member sees but ${TIER_LABEL[tier]} does NOT:\n${missing.map(chLine).join('\n')}`);
  }
  return lines.join('\n');
}

// ---- channel mode ---------------------------------------------------------------------------------
function channelReport(guild, channel) {
  const isVoice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
  const lines = [`## 🔐 Access to <#${channel.id}>`, `-# ${channel.name}`, ''];
  for (const tier of TIERS) {
    const p = effPerms(channel, tierRoleIds(tier), guild);
    const v = p.has(P.ViewChannel), s = p.has(P.SendMessages) || p.has(P.SendMessagesInThreads), cn = p.has(P.Connect);
    const extra = v ? [s ? 'send' : null, isVoice && cn ? 'connect' : null].filter(Boolean).join(' + ') : '';
    lines.push(`${v ? '✅' : '🚫'} **${TIER_LABEL[tier]}** — ${v ? 'can see' : 'hidden'}${extra ? ` (${extra})` : ''}`);
  }
  const grant = [...(channel.permissionOverwrites?.cache.values() || [])].filter(o => o.type === 0 && o.allow.has(P.ViewChannel)).map(o => guild.roles.cache.get(o.id)?.name || o.id);
  const denyEv = channel.permissionOverwrites?.cache.get(guild.id)?.deny.has(P.ViewChannel);
  lines.push(`\n-# view granted to: ${grant.join(', ') || '—'}\n-# own @everyone View-deny: ${denyEv ? '✅ present' : '❌ MISSING (relies on category)'}`);
  return lines.join('\n');
}

// ---- audit mode -----------------------------------------------------------------------------------
const DANGER = { ManageMessages: P.ManageMessages, ManageThreads: P.ManageThreads, MentionEveryone: P.MentionEveryone,
  ManageChannels: P.ManageChannels, ManageRoles: P.ManageRoles, KickMembers: P.KickMembers, BanMembers: P.BanMembers,
  ModerateMembers: P.ModerateMembers, ManageWebhooks: P.ManageWebhooks, ManageGuild: P.ManageGuild,
  ManageEvents: P.ManageEvents, MoveMembers: P.MoveMembers, MuteMembers: P.MuteMembers, Administrator: P.Administrator };
const BROADCAST = /rules|announcement|welcome|goodbye|┆ʀᴏʟᴇs|guide/i;
const LOGCH = /log|audit/i;

function grandAudit(guild) {
  const chans = realChannels(guild);
  const memberIds = tierRoleIds('member'), modIds = tierRoleIds('mod');
  const U = [], A = [], N = []; let lockedStaff = 0;
  for (const ch of chans) {
    const staff = isStaffIntended(ch, guild);
    const memberP = effPerms(ch, memberIds, guild), everyoneP = effPerms(ch, [], guild), modP = effPerms(ch, modIds, guild);
    const memberSees = memberP.has(P.ViewChannel);
    if (staff && memberSees) U.push(`<#${ch.id}> — **regular members can VIEW this staff channel**`);
    if (staff && !memberSees) lockedStaff++;
    for (const [who, p] of [['@everyone', everyoneP], ['members', memberP]]) {
      if (!p.has(P.ViewChannel)) continue;
      const d = Object.entries(DANGER).filter(([, f]) => p.has(f)).map(([k]) => k);
      if (d.length) U.push(`<#${ch.id}> — ${who} hold **${d.join(', ')}**`);
    }
    if (BROADCAST.test(ch.name) && memberSees && (memberP.has(P.SendMessages) || memberP.has(P.SendMessagesInThreads)))
      U.push(`<#${ch.id}> — members can **send** in a broadcast/read-only channel`);
    if (staff && hostsThreads(ch) && modP.has(P.ViewChannel) && modP.has(P.ManageThreads))
      A.push(`<#${ch.id}> — mods can **ManageThreads** (add non-staff into threads here)`);
    if (LOGCH.test(ch.name) && !BROADCAST.test(ch.name) && staff && modP.has(P.ViewChannel) && modP.has(P.SendMessages))
      A.push(`<#${ch.id}> — mods can **send** in a log channel (intended read-only?)`);
    if (staff && !ch.permissionOverwrites?.cache.get(guild.id)?.deny.has(P.ViewChannel))
      N.push(`<#${ch.id}> — no own @everyone View-deny (relies on category — add an explicit deny)`);
  }
  const out = [`## 🔎 Permission audit`, `-# ${chans.length} channels scanned · computed against real tier role-sets`];
  const sec = (emoji, title, arr, tip) => { out.push(`\n### ${emoji} ${title} — ${arr.length}`); if (arr.length && tip) out.push(`-# ${tip}`); out.push(arr.length ? [...new Set(arr)].map(x => '• ' + x).join('\n') : '_none_ ✓'); };
  sec('🔴', 'URGENT', U, 'members can reach staff space or hold moderator powers');
  sec('🟠', 'ADVISORY', A, 'staff over-permissioned in a way that can leak');
  sec('🟡', 'NITPICK', N, 'hardening — an explicit channel override beats relying on the category');
  out.push(`\n### 🟢 APPROVED — ${lockedStaff}`, `-# staff channel(s) correctly locked to staff only`);
  return out.join('\n');
}

function chunk(text, max = 1900) {
  const chunks = []; let cur = '';
  for (const ln of text.split('\n')) { if (cur.length + ln.length + 1 > max) { chunks.push(cur); cur = ''; } cur += (cur ? '\n' : '') + ln; }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : ['(empty)'];
}

module.exports = { tierReport, channelReport, grandAudit, chunk, TIERS };
