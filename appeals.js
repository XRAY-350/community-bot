// appeals.js — friends-on-the-outside ban appeals. A banned member can't touch the server, so their
// FRIENDS who are still here run /appeal <username> to open a shared PRIVATE THREAD in #ban-appeals and
// argue the case on their behalf. One appeal thread per banned person; up to 5 supporters can join it.
// Staff review the thread and Approve (unbans them) or Deny — nothing hits anyone's DMs.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const { CATEGORY_LABEL } = require('./opspanel');
const config = require('./config');
const ownerlog = require('./ownerlog');
const copy = require('./copy');
const threads = require('./threads');

const CONFIG_FILE = process.env.FUBU_APPEALS_FILE || '/home/ubuntu/.fubu_appeals.json';
const STATE_FILE = process.env.FUBU_APPEALS_STATE_FILE || '/home/ubuntu/.fubu_appeals_state.json';
const P = PermissionsBitField.Flags;
const MAX_FRIENDS = 5;

// "More limited" ban appeals (owner-confirmed): the 4 instant-ban categories are non-negotiable and
// never appealable here. Only reliable for bans issued THROUGH the bot's own categorized flows (the
// dashboard Ban modal / strike-threshold confirm) — those write one of these exact labels into the
// ban's reason. A native/other-tool ban won't carry it; instead of guessing, such a ban is ALLOWED to
// proceed but flagged in the thread for staff to check manually (see submit()).
const RESTRICTED_CATEGORIES = [CATEGORY_LABEL.false_verification, CATEGORY_LABEL.verification_bypass, CATEGORY_LABEL.ban_evasion, CATEGORY_LABEL.grooming];
function instantBanCategory(reason) {
  if (!reason) return null;
  return RESTRICTED_CATEGORIES.find(label => reason.startsWith(label)) || null;
}

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
    name: '⚖️┆ʙᴀɴ-ᴀᴘᴘᴇᴀʟs', type: ChannelType.GuildText, parent: config.appealsCategoryId || undefined,
    topic: 'Appeal a ban on a friend’s behalf: /appeal <their @username>. Opens a private thread only you + staff can see.',
    permissionOverwrites: [{ id: guild.id,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
      deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] },
      // Mods can review + Approve/Deny via buttons but CANNOT delete/manage appeal threads — the record of a
      // decided appeal must survive (a mod deleted a denied appeal thread once, 2026-08-01). Admins+ keep it.
      ...(config.modRoleId ? [{ id: config.modRoleId, deny: [P.ManageThreads] }] : [])],
    reason: 'Ban appeals (owner request)',
  });
  c = { ...c, channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

// Vote row is ADVISORY only (owner, 2026-08-03, after the mass-unban incident: tightened the actual DECIDE
// step to owner-only, but kept a voting layer for admins+ — the tier that used to be able to decide outright
// — so the process still gets input from more than one person). Toggle-style, same shape as promote.js's vote.
const voteRow = (rec, done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('appeal_vote_up').setEmoji('👍').setLabel(String((rec.votes?.up || []).length)).setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('appeal_vote_down').setEmoji('👎').setLabel(String((rec.votes?.down || []).length)).setStyle(ButtonStyle.Danger).setDisabled(!!done));
const decideRow = (done, approved) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('appeal_approve').setEmoji('✅').setLabel(done && approved ? 'Approved: unbanned' : 'Approve & unban').setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('appeal_deny').setEmoji('⛔').setLabel(done && !approved ? 'Denied' : 'Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done));

function appealEmbed(rec, resolution, byId) {
  const e = new EmbedBuilder()
    .setColor(resolution === 'approved' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0x5865F2)
    .setTitle('⚖️ Ban appeal').addFields(
      { name: 'For (banned)', value: `<@${rec.bannedId}> \`${rec.bannedTag}\``, inline: false },
      { name: 'Opened by', value: `<@${rec.openedBy}>`, inline: true },
      { name: 'Supporters', value: `${rec.friends.length}/${MAX_FRIENDS}`, inline: true },
      { name: 'Staff vote (advisory)', value: `👍 ${(rec.votes?.up || []).length} · 👎 ${(rec.votes?.down || []).length}`, inline: true });
  if (rec.banReason) e.addFields({ name: 'Original ban reason', value: String(rec.banReason).slice(0, 1024), inline: false });
  if (rec.originAmbiguous) e.addFields({ name: '⚠️ Heads up', value: 'This ban’s reason doesn’t match one of the bot’s known categories, so its origin (threshold strike vs. something else) couldn’t be auto-verified. Check manually before deciding.', inline: false });
  if (resolution) e.addFields({ name: resolution === 'approved' ? '✅ Approved by' : '⛔ Denied by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: 'Friends make the case in this thread. Staff (mods+) vote (advisory), the owner decides: Approve unbans them.' });
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
  if (!c.channelId) return { ok: false, msg: 'Ban appeals aren’t set up yet. An admin needs to run `/appeal-setup`.' };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The ban-appeals channel is missing. An admin needs to run `/appeal-setup` again.' };
  const ban = await findBan(guild, username);
  if (!ban) return { ok: false, msg: `I couldn’t find a **banned** user with the username \`${username.replace(/^@/, '')}\`. Double-check the spelling (it’s their @username). If they aren’t banned, there’s nothing to appeal.` };
  const category = instantBanCategory(ban.reason);
  if (category) return { ok: false, msg: `This ban was for **${category}**. That’s one of the 4 categories that aren’t eligible for a friend-appeal. If you believe this was made in error, reach out to staff directly instead.` };
  const bannedId = ban.user.id;

  const state = loadState();
  const existing = Object.values(state.appeals).find(a => a.bannedId === bannedId);

  if (existing && existing.status === 'open') {
    if (existing.openedBy === member.id || existing.friends.includes(member.id))
      return { ok: false, msg: `You’re already part of the open appeal for **${ban.user.username}** → <#${existing.threadId}>.` };
    if (existing.friends.length >= MAX_FRIENDS)
      return { ok: false, msg: `The appeal for **${ban.user.username}** already has the max of ${MAX_FRIENDS} supporters. Staff are reviewing it.` };
    const thread = await guild.channels.fetch(existing.threadId).catch(() => null);
    if (!thread) return { ok: false, msg: 'That appeal’s thread went missing. Tell an admin.' };
    existing.friends.push(member.id); saveState(state);
    await thread.members.add(member.id).catch(() => {});
    await thread.send({ content: `🤝 <@${member.id}> joined to support this appeal.${note ? `\n> ${note.slice(0, 500)}` : ''}`, allowedMentions: { users: [member.id] } }).catch(() => {});
    await refreshStarter(guild, existing);
    await ensureBoard(guild).catch(() => {});
    return { ok: true, joined: true, threadId: existing.threadId, name: ban.user.username };
  }
  if (existing && existing.status !== 'open')
    return { ok: false, msg: existing.status === 'approved'
      ? `**${ban.user.username}**’s appeal was already **approved**. They were unbanned. If they’ve been banned again, an admin can reset it.`
      : `**${ban.user.username}**’s appeal was already reviewed and **denied**. It’s one appeal per person.` };

  // brand-new appeal
  const rec = { bannedId, bannedTag: ban.user.tag || ban.user.username, openedBy: member.id, friends: [member.id],
    status: 'open', banReason: ban.reason || '', note: note || '', votes: { up: [], down: [] },
    originAmbiguous: !Object.values(CATEGORY_LABEL).some(label => (ban.reason || '').startsWith(label)) };
  const thread = await channel.threads.create({
    name: `Appeal · ${ban.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Ban appeal for ${ban.user.tag || ban.user.username} opened by ${member.user.tag}`,
  });
  rec.threadId = thread.id;
  await thread.members.add(member.id).catch(() => {});
  // Mods lack ManageThreads on this channel (can't delete/archive a decided appeal), which also strips the
  // passive ability to SEE private threads here — add them explicitly so they can still find + open it.
  if (config.modRoleId) await threads.addRoleToThread(guild, thread, config.modRoleId).catch(() => {});
  const msg = await thread.send({
    content: `<@${member.id}>, this is the appeal for **${ban.user.username}**. Make the case for them here; up to ${MAX_FRIENDS} friends can join with \`/appeal\`. Staff will read it and decide.${note ? `\n\n> ${note.slice(0, 800)}` : ''}`,
    embeds: [appealEmbed(rec)], components: [voteRow(rec, false), decideRow(false)], allowedMentions: { users: [member.id] },
  });
  rec.starterId = msg.id;
  state.appeals[thread.id] = rec; saveState(state);
  await notifyNew(guild, ban, thread.id).catch(() => {});
  await ensureBoard(guild).catch(() => {});
  return { ok: true, joined: false, threadId: thread.id, name: ban.user.username };
}

// keep the pinned embed's supporter count / resolution fresh
async function refreshStarter(guild, rec) {
  const thread = await guild.channels.fetch(rec.threadId).catch(() => null);
  if (!thread) return;
  const msg = rec.starterId ? await thread.messages.fetch(rec.starterId).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [appealEmbed(rec, rec.status === 'open' ? null : rec.status, rec.decidedBy)], components: [voteRow(rec, rec.status !== 'open'), decideRow(rec.status !== 'open', rec.status === 'approved')] }).catch(() => {});
}

// Advisory vote — toggle-style (click again to remove your vote), same shape as promote.js. Gated to
// admins+ in index.js. Doesn't decide anything by itself; the owner still has to click Approve/Deny.
async function vote(interaction, dir) {
  const state = loadState();
  const rec = state.appeals[interaction.channelId];
  if (!rec) return interaction.reply({ content: copy.appeals.untracked, flags: MessageFlags.Ephemeral });
  if (rec.status !== 'open') return interaction.reply({ content: 'This appeal was already decided.', flags: MessageFlags.Ephemeral });
  if (!rec.votes) rec.votes = { up: [], down: [] };
  const uid = interaction.user.id;
  const up = rec.votes.up.filter(x => x !== uid), down = rec.votes.down.filter(x => x !== uid);
  const wasIn = (dir === 'up' ? rec.votes.up : rec.votes.down).includes(uid);
  if (!wasIn) (dir === 'up' ? up : down).push(uid);
  rec.votes = { up, down }; saveState(state);
  await interaction.update({ embeds: [appealEmbed(rec)], components: [voteRow(rec, false), decideRow(false)] }).catch(() => {});
  return interaction.followUp({ content: wasIn ? `Your ${dir === 'up' ? '👍' : '👎'} was removed.` : `Your ${dir === 'up' ? '👍' : '👎'} is counted.`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// staff Approve/Deny — gated to owner+ in index.js (vote is admins+, see vote() above)
async function handleButton(interaction) {
  if (interaction.customId === 'appeal_vote_up') return vote(interaction, 'up');
  if (interaction.customId === 'appeal_vote_down') return vote(interaction, 'down');
  const state = loadState();
  const rec = state.appeals[interaction.channelId];
  if (!rec) return interaction.reply({ content: copy.appeals.untracked, flags: MessageFlags.Ephemeral });
  if (rec.status !== 'open') return interaction.reply({ content: 'This appeal was already decided.', flags: MessageFlags.Ephemeral });
  const approve = interaction.customId === 'appeal_approve';

  if (approve) {
    const ok = await interaction.guild.bans.remove(rec.bannedId, `Ban appeal approved by ${interaction.user.tag}`).then(() => true).catch(() => false);
    if (!ok) return interaction.reply({ content: 'Couldn’t unban them. Are they still actually banned? Nothing was changed.', flags: MessageFlags.Ephemeral });
  }
  rec.status = approve ? 'approved' : 'denied'; rec.decidedBy = interaction.user.id; saveState(state);
  await interaction.update({ embeds: [appealEmbed(rec, rec.status, interaction.user.id)], components: [voteRow(rec, true), decideRow(true, approve)] }).catch(() => {});
  const friendPings = rec.friends.map(f => `<@${f}>`).join(' ');
  const thread = await interaction.guild.channels.fetch(rec.threadId).catch(() => null);
  if (thread) {
    await thread.send({ content: approve
      ? `✅ ${friendPings}, the appeal for **${rec.bannedTag}** was **approved** by <@${interaction.user.id}>. They’ve been unbanned and can rejoin. 💛`
      : `⛔ ${friendPings}, the appeal for **${rec.bannedTag}** was **denied** by <@${interaction.user.id}>. The ban stands.`,
      allowedMentions: { users: rec.friends } }).catch(() => {});
    // Preserve the whole discussion in the bot BEFORE archiving, so the record survives even if the thread
    // is later deleted (the reason a decided appeal's contents were lost once).
    rec.transcript = await threads.snapshotTranscript(thread); rec.transcriptAt = Date.now(); saveState(state);
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  await ensureBoard(interaction.guild).catch(() => {});
  await ownerlog.log(interaction.guild, { emoji: approve ? '✅' : '⛔', title: `Ban appeal ${approve ? 'approved (unbanned)' : 'denied'}`, color: approve ? 0x57F287 : 0xED4245,
    detail: `**${rec.bannedTag}** — by <@${interaction.user.id}>.` });
  return interaction.followUp({ content: approve ? `✅ Unbanned <@${rec.bannedId}> and closed the appeal.` : copy.appeals.denied, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
}

// Public "open appeals" board — a pinned message in the (member-visible) base channel listing WHO has an
// open appeal + a link. The appeal CONTENT stays private in each thread (members see the board but can't
// open the threads). Bans are already announced publicly, so naming who's appealing exposes nothing new.
async function ensureBoard(guild) {
  const c = loadConfig();
  if (!c.channelId) return;
  const ch = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!ch) return;
  const open = Object.values(loadState().appeals).filter(a => a.status === 'open');
  const lines = open.length
    ? open.map(a => `• For **${a.bannedTag}** · opened by <@${a.openedBy}> · ${a.friends.length} supporter(s) → <#${a.threadId}>`).join('\n').slice(0, 4000)
    : '_No open ban appeals right now._';
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`📋 Open ban appeals (${open.length})`)
    .setDescription(lines).setFooter({ text: 'Appeal a friend’s ban: /appeal ban <their @username>' });
  const existing = c.boardId ? await ch.messages.fetch(c.boardId).catch(() => null) : null;
  if (existing) return void existing.edit({ embeds: [embed] }).catch(() => {});
  const m = await ch.send({ embeds: [embed] }).catch(() => null);
  if (m) { await m.pin().catch(() => {}); c.boardId = m.id; saveConfig(c); }
}
// Ping mods in the base channel when a new appeal opens.
async function notifyNew(guild, ban, threadId) {
  const c = loadConfig();
  const ch = c.channelId && await guild.channels.fetch(c.channelId).catch(() => null);
  if (!ch) return;
  await ch.send({ content: `${config.modRoleId ? `<@&${config.modRoleId}> ` : ''}⚖️ new **ban appeal** for **${ban.user.username}** → <#${threadId}>`,
    allowedMentions: { roles: config.modRoleId ? [config.modRoleId] : [] } }).catch(() => {});
}

// Admin reset: clear a DECIDED (denied/approved) appeal record so the person can be appealed again —
// for when a denial was premature, or an approved person got re-banned. Archives the old record (keeps
// any stored transcript) instead of hard-deleting, so history survives. id = bannedId or @username.
function reset(identifier) {
  const id = String(identifier || '').trim().replace(/^@/, '');
  if (!id) return { ok: false, msg: 'Give the banned person’s @username or user ID.' };
  const state = loadState();
  const entry = Object.entries(state.appeals || {}).find(([, a]) =>
    a.bannedId === id || (a.bannedTag || '').toLowerCase() === id.toLowerCase());
  if (!entry) return { ok: false, msg: `No appeal record found for \`${id}\`. (They may never have been appealed, or it was already reset.)` };
  const [key, rec] = entry;
  if (rec.status === 'open') return { ok: false, msg: `**${rec.bannedTag}**’s appeal is still **open**. Decide it (approve/deny) or let it run; reset is for clearing an already-decided one.` };
  if (!Array.isArray(state.archived)) state.archived = [];
  state.archived.push({ ...rec, resetAt: Date.now() });   // keep history (incl. transcript if present)
  delete state.appeals[key];
  saveState(state);
  return { ok: true, bannedTag: rec.bannedTag, bannedId: rec.bannedId, status: rec.status };
}

// Decided (denied/approved) appeals — for /appeal-reset's autocomplete, so an admin picks from a real list
// instead of having to already know/type the exact @username or ID (owner, 2026-08-03).
function listDecided() {
  return Object.values(loadState().appeals || {}).filter(a => a.status !== 'open');
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, ensureBoard, reset, listDecided };
