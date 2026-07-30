// appeals.js — friends-on-the-outside ban appeals. A banned member can't touch the server, so their
// FRIENDS who are still here run /appeal <username> to open a shared PRIVATE THREAD in #ban-appeals and
// argue the case on their behalf. One appeal thread per banned person; up to 5 supporters can join it.
// Staff review the thread and Approve (unbans them) or Deny — nothing hits anyone's DMs.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');

const CONFIG_FILE = process.env.FUBU_APPEALS_FILE || '/home/ubuntu/.fubu_appeals.json';
const STATE_FILE = process.env.FUBU_APPEALS_STATE_FILE || '/home/ubuntu/.fubu_appeals_state.json';
const P = PermissionsBitField.Flags;
const MAX_FRIENDS = 5;

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[appeals] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { appeals: {} });
const saveState = s => _save(STATE_FILE, s);
const isConfigured = () => !!loadConfig().channelId;

// #ban-appeals: members can VIEW + type in threads they're added to, but can't post in the root or open
// their own threads — appeals only ever open via /appeal, as private threads. Staff see the private
// threads through Manage Threads (same model as the mod-applications applicant threads).
async function setup(guild, config) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const channel = await guild.channels.create({
    name: '⚖️┆ʙᴀɴ-ᴀᴘᴘᴇᴀʟs', type: ChannelType.GuildText,
    topic: 'Appeal a ban on a friend’s behalf: /appeal <their @username>. Opens a private thread only you + staff can see.',
    permissionOverwrites: [{ id: guild.id,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
      deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
    reason: 'Ban appeals (owner request)',
  });
  c = { ...c, channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

const buttons = (done, approved) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('appeal_approve').setEmoji('✅').setLabel(done && approved ? 'Approved — unbanned' : 'Approve & unban').setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('appeal_deny').setEmoji('⛔').setLabel(done && !approved ? 'Denied' : 'Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done));

function appealEmbed(rec, resolution, byId) {
  const e = new EmbedBuilder()
    .setColor(resolution === 'approved' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0x5865F2)
    .setTitle('⚖️ Ban appeal').addFields(
      { name: 'For (banned)', value: `<@${rec.bannedId}> \`${rec.bannedTag}\``, inline: false },
      { name: 'Opened by', value: `<@${rec.openedBy}>`, inline: true },
      { name: 'Supporters', value: `${rec.friends.length}/${MAX_FRIENDS}`, inline: true });
  if (rec.banReason) e.addFields({ name: 'Original ban reason', value: String(rec.banReason).slice(0, 1024), inline: false });
  if (resolution) e.addFields({ name: resolution === 'approved' ? '✅ Approved by' : '⛔ Denied by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: 'Friends make the case in this thread. Staff decide — Approve unbans them.' });
  return e;
}

// Find a banned user by username (Discord usernames no longer carry a discriminator).
async function findBan(guild, username) {
  const q = username.replace(/^@/, '').trim().toLowerCase();
  if (!q) return null;
  const bans = await guild.bans.fetch().catch(() => null);
  if (!bans) return null;
  return bans.find(b => b.user.username.toLowerCase() === q) || bans.find(b => (b.user.tag || '').toLowerCase() === q) || null;
}

async function submit(guild, member, username, note) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Ban appeals aren’t set up yet — an admin needs to run `/appeal-setup`.' };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The ban-appeals channel is missing — an admin needs to run `/appeal-setup` again.' };
  const ban = await findBan(guild, username);
  if (!ban) return { ok: false, msg: `I couldn’t find a **banned** user with the username \`${username.replace(/^@/, '')}\`. Double-check the spelling (it’s their @username) — if they aren’t banned, there’s nothing to appeal.` };
  const bannedId = ban.user.id;

  const state = loadState();
  const existing = Object.values(state.appeals).find(a => a.bannedId === bannedId);

  if (existing && existing.status === 'open') {
    if (existing.openedBy === member.id || existing.friends.includes(member.id))
      return { ok: false, msg: `You’re already part of the open appeal for **${ban.user.username}** → <#${existing.threadId}>.` };
    if (existing.friends.length >= MAX_FRIENDS)
      return { ok: false, msg: `The appeal for **${ban.user.username}** already has the max of ${MAX_FRIENDS} supporters. Staff are reviewing it.` };
    const thread = await guild.channels.fetch(existing.threadId).catch(() => null);
    if (!thread) return { ok: false, msg: 'That appeal’s thread went missing — tell an admin.' };
    existing.friends.push(member.id); saveState(state);
    await thread.members.add(member.id).catch(() => {});
    await thread.send({ content: `🤝 <@${member.id}> joined to support this appeal.${note ? `\n> ${note.slice(0, 500)}` : ''}`, allowedMentions: { users: [member.id] } }).catch(() => {});
    await refreshStarter(guild, existing);
    return { ok: true, joined: true, threadId: existing.threadId, name: ban.user.username };
  }
  if (existing && existing.status !== 'open')
    return { ok: false, msg: existing.status === 'approved'
      ? `**${ban.user.username}**’s appeal was already **approved** — they were unbanned. If they’ve been banned again, an admin can reset it.`
      : `**${ban.user.username}**’s appeal was already reviewed and **denied**. It’s one appeal per person.` };

  // brand-new appeal
  const rec = { bannedId, bannedTag: ban.user.tag || ban.user.username, openedBy: member.id, friends: [member.id],
    status: 'open', banReason: ban.reason || '', note: note || '' };
  const thread = await channel.threads.create({
    name: `Appeal · ${ban.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Ban appeal for ${ban.user.tag || ban.user.username} opened by ${member.user.tag}`,
  });
  rec.threadId = thread.id;
  await thread.members.add(member.id).catch(() => {});
  const msg = await thread.send({
    content: `<@${member.id}> — this is the appeal for **${ban.user.username}**. Make the case for them here; up to ${MAX_FRIENDS} friends can join with \`/appeal\`. Staff will read it and decide.${note ? `\n\n> ${note.slice(0, 800)}` : ''}`,
    embeds: [appealEmbed(rec)], components: [buttons(false)], allowedMentions: { users: [member.id] },
  });
  rec.starterId = msg.id;
  state.appeals[thread.id] = rec; saveState(state);
  return { ok: true, joined: false, threadId: thread.id, name: ban.user.username };
}

// keep the pinned embed's supporter count / resolution fresh
async function refreshStarter(guild, rec) {
  const thread = await guild.channels.fetch(rec.threadId).catch(() => null);
  if (!thread) return;
  const msg = rec.starterId ? await thread.messages.fetch(rec.starterId).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [appealEmbed(rec, rec.status === 'open' ? null : rec.status, rec.decidedBy)], components: [buttons(rec.status !== 'open', rec.status === 'approved')] }).catch(() => {});
}

// staff Approve/Deny — gated to mods+ in index.js
async function handleButton(interaction) {
  const state = loadState();
  const rec = state.appeals[interaction.channelId];
  if (!rec) return interaction.reply({ content: 'This appeal is no longer tracked.', flags: MessageFlags.Ephemeral });
  if (rec.status !== 'open') return interaction.reply({ content: 'This appeal was already decided.', flags: MessageFlags.Ephemeral });
  const approve = interaction.customId === 'appeal_approve';

  if (approve) {
    const ok = await interaction.guild.bans.remove(rec.bannedId, `Ban appeal approved by ${interaction.user.tag}`).then(() => true).catch(() => false);
    if (!ok) return interaction.reply({ content: 'Couldn’t unban them — are they still actually banned? Nothing was changed.', flags: MessageFlags.Ephemeral });
  }
  rec.status = approve ? 'approved' : 'denied'; rec.decidedBy = interaction.user.id; saveState(state);
  await interaction.update({ embeds: [appealEmbed(rec, rec.status, interaction.user.id)], components: [buttons(true, approve)] }).catch(() => {});
  const friendPings = rec.friends.map(f => `<@${f}>`).join(' ');
  const thread = await interaction.guild.channels.fetch(rec.threadId).catch(() => null);
  if (thread) {
    await thread.send({ content: approve
      ? `✅ ${friendPings} — the appeal for **${rec.bannedTag}** was **approved** by <@${interaction.user.id}>. They’ve been unbanned and can rejoin. 💛`
      : `⛔ ${friendPings} — the appeal for **${rec.bannedTag}** was **denied** by <@${interaction.user.id}>. The ban stands.`,
      allowedMentions: { users: rec.friends } }).catch(() => {});
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  return interaction.followUp({ content: approve ? `✅ Unbanned <@${rec.bannedId}> and closed the appeal.` : '⛔ Appeal denied and closed.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig };
