// strikeAppeals.js — self-service strike appeals. A struck member appeals ONE of their own strikes,
// alone (no friends/vouching — reuses appeals.js's thread+review-buttons architecture, minus that
// mechanic). Staff review the private thread and Approve (removes the strike, lifts any still-live
// timeout it carried) or Deny (starts a cooldown before the SAME strike can be re-appealed).
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const config = require('./config');
const strikes = require('./strikes');

const CONFIG_FILE = process.env.FUBU_STRIKE_APPEALS_FILE || '/home/ubuntu/.fubu_strike_appeals.json';
const STATE_FILE = process.env.FUBU_STRIKE_APPEALS_STATE_FILE || '/home/ubuntu/.fubu_strike_appeals_state.json';
const P = PermissionsBitField.Flags;

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[strikeAppeals] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { appeals: {} });
const saveState = s => _save(STATE_FILE, s);
const isConfigured = () => !!loadConfig().channelId;

// #strike-appeals: same shape as #ban-appeals — members can VIEW + type in threads they're added to,
// but can't post in the root or open their own threads (appeals only open via /appeal strike).
async function setup(guild) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const channel = await guild.channels.create({
    name: '⚖️┆sᴛʀɪᴋᴇ-ᴀᴘᴘᴇᴀʟs', type: ChannelType.GuildText,
    topic: 'Appeal one of your own strikes: /appeal strike <strike>. Opens a private thread only you + staff can see.',
    permissionOverwrites: [{ id: guild.id,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
      deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
    reason: 'Strike appeals (owner request)',
  });
  c = { ...c, channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

const buttons = (done, approved) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('strikeappeal_approve').setEmoji('✅').setLabel(done && approved ? 'Approved — removed' : 'Approve & remove').setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('strikeappeal_deny').setEmoji('⛔').setLabel(done && !approved ? 'Denied' : 'Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done));

function appealEmbed(rec, resolution, byId) {
  const e = new EmbedBuilder()
    .setColor(resolution === 'approved' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0x5865F2)
    .setTitle('⚖️ Strike appeal').addFields(
      { name: 'Appealing', value: `<@${rec.memberId}> \`${rec.memberTag}\``, inline: false },
      { name: 'Strike', value: strikes.entryLabel(rec.strikeSnapshot), inline: false });
  if (rec.note) e.addFields({ name: 'Their note', value: String(rec.note).slice(0, 1024), inline: false });
  if (resolution) e.addFields({ name: resolution === 'approved' ? '✅ Approved by' : '⛔ Denied by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: 'Only the member who received it can appeal. Staff decide — Approve removes the strike.' });
  return e;
}

// Submit a new strike appeal. `state` is the bot's shared State instance (needed to read the ledger).
async function submit(guild, member, state, strikeId, note) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Strike appeals aren’t set up yet — an admin needs to run `/appeal-strike-setup`.' };
  const entry = strikes.ledger(state, member.id).find(e => e.id === strikeId);
  if (!entry || !entry.active) return { ok: false, msg: 'I couldn’t find an active strike with that ID on your record — it may already be removed, or the ID’s wrong. Use the autocomplete list instead of typing it by hand.' };
  if (entry.crossedBan) return { ok: false, msg: 'That’s the strike that crossed the ban threshold — it isn’t appealable here. If you were banned over it, use `/appeal ban` instead (a friend still in the server has to open that one for you).' };

  const st = loadState();
  const openExisting = Object.values(st.appeals).find(a => a.memberId === member.id && a.status === 'open');
  if (openExisting) return { ok: false, msg: `You already have an open strike appeal → <#${openExisting.threadId}>. Wait for staff to decide that one first.` };
  const deniedBefore = Object.values(st.appeals).find(a => a.strikeId === strikeId && a.status === 'denied');
  if (deniedBefore) {
    const readyAt = deniedBefore.deniedAt + (config.strikeAppealCooldownDays || 7) * 86400000;
    if (Date.now() < readyAt) return { ok: false, msg: `That strike’s appeal was already denied — you can try again <t:${Math.floor(readyAt / 1000)}:R>.` };
  }

  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The strike-appeals channel is missing — an admin needs to run `/appeal-strike-setup` again.' };

  const rec = { memberId: member.id, memberTag: member.user.tag, strikeId, strikeSnapshot: { ...entry }, note: note || '', status: 'open' };
  const thread = await channel.threads.create({
    name: `Strike appeal · ${member.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Strike appeal by ${member.user.tag} for strike ${strikeId}`,
  });
  rec.threadId = thread.id;
  await thread.members.add(member.id).catch(() => {});
  const msg = await thread.send({
    content: `<@${member.id}> — this is your appeal for the strike below. Explain why here; staff will read it and decide. You don’t need anyone else to join.${note ? `\n\n> ${note.slice(0, 800)}` : ''}`,
    embeds: [appealEmbed(rec)], components: [buttons(false)], allowedMentions: { users: [member.id] },
  });
  rec.starterId = msg.id;
  st.appeals[thread.id] = rec; saveState(st);
  return { ok: true, threadId: thread.id };
}

// staff Approve/Deny — gated to mods+ in index.js. Needs `state` to actually remove the strike.
async function handleButton(interaction, state) {
  const guild = interaction.guild;
  const st = loadState();
  const rec = st.appeals[interaction.channelId];
  if (!rec) return interaction.reply({ content: 'This appeal is no longer tracked.', flags: MessageFlags.Ephemeral });
  if (rec.status !== 'open') return interaction.reply({ content: 'This appeal was already decided.', flags: MessageFlags.Ephemeral });
  const approve = interaction.customId === 'strikeappeal_approve';

  if (approve) {
    const member = await guild.members.fetch(rec.memberId).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn’t in the server anymore — can’t safely remove the strike/timeout from here. If they come back, use `/strike remove`.', flags: MessageFlags.Ephemeral });
    const r = await strikes.removeStrike(guild, member, state, rec.strikeId, interaction.user.tag);
    if (!r.ok) return interaction.reply({ content: 'Couldn’t find that strike anymore — it may have already been removed some other way. Nothing was changed.', flags: MessageFlags.Ephemeral });
    if (rec.strikeSnapshot.timeoutMs && member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
      await member.timeout(null, `Strike appeal approved by ${interaction.user.tag}`).catch(() => {});
    }
  }
  rec.status = approve ? 'approved' : 'denied'; rec.decidedBy = interaction.user.id;
  if (!approve) rec.deniedAt = Date.now();
  saveState(st);
  await interaction.update({ embeds: [appealEmbed(rec, rec.status, interaction.user.id)], components: [buttons(true, approve)] }).catch(() => {});
  const thread = await guild.channels.fetch(rec.threadId).catch(() => null);
  if (thread) {
    await thread.send({ content: approve
      ? `✅ <@${rec.memberId}> — your appeal was **approved** by <@${interaction.user.id}>. The strike has been removed.`
      : `⛔ <@${rec.memberId}> — your appeal was **denied** by <@${interaction.user.id}>. The strike stands.`,
      allowedMentions: { users: [rec.memberId] } }).catch(() => {});
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  return interaction.followUp({ content: approve ? '✅ Strike removed and appeal closed.' : '⛔ Appeal denied and closed.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig };
