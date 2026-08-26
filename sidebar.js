// sidebar.js — /sidebar (+ right-click a member → Apps → Sidebar): a mod pulls a member aside for a
// private 1:1 chat. Not punishment — unlike /corner, it strips nothing, restricts nothing anywhere
// else, and carries no rule/reason picker. Mirrors reports.js's thread shape (a hidden staff-only
// channel, one private thread per pull, Close/Reopen buttons that lock+archive) since that's already
// the proven "private space, staff can see it, member can't be seen by other members" pattern.
const fs = require('fs');
const { statePath } = require('./statepath');
const { withLock } = require('./mutex');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags, UserSelectMenuBuilder } = require('discord.js');
const config = require('./config');

const CONFIG_FILE = process.env.FUBU_SIDEBAR_FILE || statePath('sidebar.json');
const STATE_FILE = process.env.FUBU_SIDEBAR_STATE_FILE || statePath('sidebar_state.json');
const P = PermissionsBitField.Flags;

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[sidebar] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { counter: 0, posts: {} });
const saveState = s => _save(STATE_FILE, s);
function isConfigured() { return !!loadConfig().channelId; }

// VERIFIED-gated root (owner, 2026-08-26 preview-leak sweep — see SERVER_CONFIG.md). @everyone is
// view-DENIED so it never shows to a previewer/unverified account; VERIFIED gets ViewChannel on the ROOT
// so the bot CAN pull a plain (verified) member into a private thread here — adding someone to a private
// thread needs them to at least see the parent, or the add fails "Missing Access". Verified can't post in
// the root or start their own threads. Other members' threads stay invisible regardless — Discord only
// shows a private thread to its own members or to ManageThreads holders. Unlike #anon-reports (fully
// staff-only, one-way), sidebars deliberately keep the pulled member reachable, which is why this is
// Verified rather than staff-only.
async function setup(guild) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const overwrites = [{ id: guild.id, deny: [P.ViewChannel] }];
  if (config.verifiedRoleId) overwrites.push({ id: config.verifiedRoleId,
    allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
    deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] });
  const channel = await guild.channels.create({
    name: '🗣️┆ꜱɪᴅᴇʙᴀʀꜱ', type: ChannelType.GuildText,
    topic: 'Private 1:1 chats staff opened with a member. Not punishment, just a quiet space to talk something through.',
    permissionOverwrites: overwrites,
    reason: 'Sidebars channel (owner request) — verified-gated',
  });
  c = { channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

function sidebarEmbed(num, targetIds, byId, reason, status) {
  const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
  const who = ids.map(id => `<@${id}>`).join(', ');
  const many = ids.length > 1;
  const e = new EmbedBuilder().setColor(status === 'closed' ? 0x99AAB5 : 0x5865F2).setTitle(`🗣️ Sidebar #${num}`)
    .setDescription(`<@${byId}> wants to talk something through with ${who} here. Nothing's wrong — this isn't a corner, just a private space to chat.`)
    .addFields({ name: many ? 'With' : 'With', value: who.slice(0, 1024), inline: true }, { name: 'Started by', value: `<@${byId}>`, inline: true });
  if (reason) e.addFields({ name: 'What about', value: String(reason).slice(0, 500), inline: false });
  e.setFooter({ text: status === 'closed' ? 'Closed. Staff can reopen it if needed.' : `Only ${many ? 'the people here' : 'the two of you'} and staff can see this thread.` });
  return e;
}
const closeRow = (closed) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('sb_add').setEmoji('➕').setLabel('Add someone').setStyle(ButtonStyle.Secondary).setDisabled(!!closed),
  new ButtonBuilder().setCustomId('sb_close').setEmoji('🔒').setLabel('Close').setStyle(ButtonStyle.Secondary).setDisabled(!!closed),
  new ButtonBuilder().setCustomId('sb_reopen').setEmoji('🔓').setLabel('Reopen').setStyle(ButtonStyle.Secondary).setDisabled(!closed));

// `targets` is one member or several — a sidebar can be a 1:1 or a small group (owner: "can we sidebar
// multiple people"). More can be pulled in later via the ➕ button, so the thread grows the way
// appeals.js's friend threads do rather than being fixed at creation.
// Serialized behind the module lock (audit U10): this is a load->awaits->save read-modify-write; two
// concurrent calls used to lose the earlier one's record (the documented appeals.js incident class).
async function pull(guild, byMember, targets, reason) { return withLock('sidebar', () => _pull(guild, byMember, targets, reason)); }
async function _pull(guild, byMember, targets, reason) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Sidebars aren’t set up yet. An admin needs to run `/sidebar-setup`.' };
  const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  const seen = new Set();
  const members = list.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  if (!members.length) return { ok: false, msg: 'Pick at least one person to sidebar.' };
  if (members.some(m => m.id === byMember.id)) return { ok: false, msg: 'You can’t sidebar yourself.' };
  if (members.some(m => m.user?.bot)) return { ok: false, msg: 'Can’t sidebar a bot.' };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The sidebars channel is missing. An admin needs to re-run `/sidebar-setup`.' };

  const state = loadState();
  const num = (state.counter || 0) + 1;
  const title = members.length === 1 ? members[0].user.username : `${members[0].user.username} +${members.length - 1}`;
  const thread = await channel.threads.create({
    name: `Sidebar #${num} · ${title}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Sidebar opened by ${byMember.user.tag} with ${members.map(m => m.user.tag).join(', ')}`,
  });
  const targetIds = members.map(m => m.id);
  for (const id of targetIds) await thread.members.add(id).catch(() => {});
  const msg = await thread.send({
    content: targetIds.map(id => `<@${id}>`).join(' '),
    embeds: [sidebarEmbed(num, targetIds, byMember.id, reason, 'open')], components: [closeRow(false)], allowedMentions: { users: targetIds },
  });
  state.counter = num;
  state.posts[thread.id] = { num, targetIds, byId: byMember.id, reason: reason || null, starterId: msg.id, status: 'open' };
  saveState(state);
  return { ok: true, num, threadId: thread.id, count: targetIds.length };
}

// Member-initiated sidebar (owner, 2026-08-26: after a one-way report "the person can optionally create a
// sidebar after the fact"). The reporter opens a quiet space with staff themselves — no staff initiator,
// no target-picking. Reuses the same thread/record shape as _pull so Close/Reopen/Add all work identically.
async function openSelfSidebar(guild, member, reason) { return withLock('sidebar', () => _openSelf(guild, member, reason)); }
async function _openSelf(guild, member, reason) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Sidebars aren’t set up yet. An admin needs to run `/sidebar-setup`.' };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The sidebars channel is missing. An admin needs to re-run `/sidebar-setup`.' };
  const state = loadState();
  const num = (state.counter || 0) + 1;
  const thread = await channel.threads.create({
    name: `Sidebar #${num} · ${member.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Sidebar opened by ${member.user.tag} (self, after a report)`,
  });
  const added = await thread.members.add(member.id).then(() => true).catch(() => false);
  if (!added) { await thread.delete('sidebar open failed — could not add member').catch(() => {}); return { ok: false, msg: 'I couldn’t open a sidebar for you (couldn’t add you to the thread). Let staff know.' }; }
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`🗣️ Sidebar #${num}`)
    .setDescription(`<@${member.id}> opened a sidebar with staff to talk something through. Nothing's wrong — this is just a private space to chat.`)
    .addFields({ name: 'Opened by', value: `<@${member.id}>`, inline: true });
  if (reason) e.addFields({ name: 'What about', value: String(reason).slice(0, 500), inline: false });
  e.setFooter({ text: 'Only you and staff can see this thread.' });
  const msg = await thread.send({ content: `<@${member.id}>`, embeds: [e], components: [closeRow(false)], allowedMentions: { users: [member.id] } });
  state.counter = num;
  state.posts[thread.id] = { num, targetIds: [member.id], byId: member.id, reason: reason || null, starterId: msg.id, status: 'open' };
  saveState(state);
  return { ok: true, num, threadId: thread.id };
}

// Pull additional people into an existing sidebar (staff-gated in index.js).
// Serialized behind the module lock (audit U10): this is a load->awaits->save read-modify-write; two
// concurrent calls used to lose the earlier one's record (the documented appeals.js incident class).
async function addPeople(interaction, memberIds) { return withLock('sidebar', () => _addPeople(interaction, memberIds)); }
async function _addPeople(interaction, memberIds) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: 'This sidebar is no longer tracked.', flags: MessageFlags.Ephemeral });
  const thread = interaction.channel;
  const already = new Set(post.targetIds || []);
  const added = [];
  for (const id of memberIds) {
    if (already.has(id) || id === post.byId) continue;
    const m = await interaction.guild.members.fetch(id).catch(() => null);
    if (!m || m.user.bot) continue;
    const ok = await thread.members.add(id).then(() => true).catch(() => false);
    if (ok) { added.push(id); already.add(id); }
  }
  if (!added.length) return interaction.reply({ content: 'Nobody new to add (already here, a bot, or I couldn’t add them).', flags: MessageFlags.Ephemeral });
  post.targetIds = [...already];
  saveState(state);
  const starter = await thread.messages.fetch(post.starterId).catch(() => null);
  if (starter) await starter.edit({ embeds: [sidebarEmbed(post.num, post.targetIds, post.byId, post.reason, post.status)], components: [closeRow(post.status === 'closed')] }).catch(() => {});
  await thread.send({ content: `➕ ${added.map(id => `<@${id}>`).join(', ')} pulled in by <@${interaction.user.id}>.`, allowedMentions: { users: added } }).catch(() => {});
  return interaction.reply({ content: `➕ Added ${added.length} ${added.length === 1 ? 'person' : 'people'}.`, flags: MessageFlags.Ephemeral });
}

async function setStatus(interaction, status) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: 'This sidebar is no longer tracked.', flags: MessageFlags.Ephemeral });
  const thread = interaction.channel;
  if (status === 'open' && (thread.archived || thread.locked)) { await thread.setArchived(false).catch(() => {}); await thread.setLocked(false).catch(() => {}); }
  post.status = status; saveState(state);
  const starter = await thread.messages.fetch(post.starterId).catch(() => null);
  if (starter) await starter.edit({ embeds: [sidebarEmbed(post.num, post.targetIds || post.targetId, post.byId, post.reason, status)], components: [closeRow(status === 'closed')] }).catch(() => {});
  await thread.send(status === 'closed' ? `🔒 Closed by <@${interaction.user.id}>.` : `🔓 Reopened by <@${interaction.user.id}>.`).catch(() => {});
  if (status === 'closed') { await thread.setLocked(true).catch(() => {}); await thread.setArchived(true).catch(() => {}); }
  return interaction.reply({ content: status === 'closed' ? '🔒 Closed.' : '🔓 Reopened.', flags: MessageFlags.Ephemeral });
}

async function handleButton(interaction) {
  if (interaction.customId === 'sb_close') return setStatus(interaction, 'closed');
  if (interaction.customId === 'sb_reopen') return setStatus(interaction, 'open');
  if (interaction.customId === 'sb_add') {
    const menu = new UserSelectMenuBuilder().setCustomId('sb_addpick').setPlaceholder('Who else should be in here?').setMinValues(1).setMaxValues(10);
    return interaction.reply({ content: '➕ Pick who to pull into this sidebar:', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'sb_addpick') return addPeople(interaction, interaction.values || []);
}

// Thread ids where this member is a PARTICIPANT — corner's thread-strip must not eject someone from a
// sidebar they were pulled into (audit U6, 2026-08-26). Covers the legacy single-target shape too.
function threadsFor(memberId) {
  const s = loadState();
  return Object.entries(s.posts || {})
    .filter(([, p]) => p && ((p.targetIds || []).includes(memberId) || p.targetId === memberId))
    .map(([tid]) => tid);
}

module.exports = { setup, pull, openSelfSidebar, addPeople, handleButton, isConfigured, loadConfig, threadsFor, CONFIG_FILE, STATE_FILE };
