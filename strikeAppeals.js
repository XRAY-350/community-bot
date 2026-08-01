// strikeAppeals.js — self-service strike appeals. A struck member appeals ONE of their own strikes,
// alone (no friends/vouching — reuses appeals.js's thread+review-buttons architecture, minus that
// mechanic). Staff review the private thread and Approve (removes the strike, lifts any still-live
// timeout it carried) or Deny (starts a cooldown before the SAME strike can be re-appealed).
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const config = require('./config');
const strikes = require('./strikes');
const ownerlog = require('./ownerlog');
const copy = require('./copy');

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
    name: '⚖️┆sᴛʀɪᴋᴇ-ᴀᴘᴘᴇᴀʟs', type: ChannelType.GuildText, parent: config.appealsCategoryId || undefined,
    topic: 'Appeal one of your own strikes: /appeal strike <strike>. Opens a private thread only you + staff can see.',
    permissionOverwrites: [{ id: guild.id,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
      deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
    reason: 'Strike appeals (owner request)',
  });
  c = { ...c, channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

// Appeal card rows (returns an ARRAY of ActionRows). `outcome` (once decided) is 'approved'|'reduced'|'denied'.
// `snapshotWeight` drives the partial-approval "Approve → Nu" buttons — one per integer weight below the
// strike's current weight (so a 3-unit strike can be knocked to 2 or 1 instead of fully removed).
function buttons(done, outcome, snapshotWeight) {
  const topLabel = done ? (outcome === 'approved' ? 'Approved — removed' : outcome === 'reduced' ? 'Approved — reduced' : 'Approve & remove') : 'Approve & remove';
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('strikeappeal_approve').setEmoji(outcome === 'reduced' ? '⚖️' : '✅').setLabel(topLabel).setStyle(outcome === 'reduced' ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(!!done),
    new ButtonBuilder().setCustomId('strikeappeal_deny').setEmoji('⛔').setLabel(done && outcome === 'denied' ? 'Denied' : 'Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done))];
  const w = Math.floor(Number(snapshotWeight) || 0);
  if (!done && w > 1) {
    const reduceRow = new ActionRowBuilder();
    for (let n = 1; n < w && reduceRow.components.length < 5; n++)
      reduceRow.addComponents(new ButtonBuilder().setCustomId(`strikeappeal_reduce:${n}`).setEmoji('⚖️').setLabel(`Approve → ${n}u`).setStyle(ButtonStyle.Primary));
    rows.push(reduceRow);
  }
  return rows;
}

function appealEmbed(rec, resolution, byId) {
  const e = new EmbedBuilder()
    .setColor(resolution === 'denied' ? 0xED4245 : (resolution === 'approved' || resolution === 'reduced') ? 0x57F287 : 0x5865F2)
    .setTitle('⚖️ Strike appeal').addFields(
      { name: 'Appealing', value: `<@${rec.memberId}> \`${rec.memberTag}\``, inline: false },
      { name: 'Strike', value: strikes.entryLabel(rec.strikeSnapshot), inline: false });
  if (rec.note) e.addFields({ name: 'Their note', value: String(rec.note).slice(0, 1024), inline: false });
  if (resolution) e.addFields({ name: resolution === 'approved' ? '✅ Removed by' : resolution === 'reduced' ? `⚖️ Reduced to ${rec.reducedTo}u by` : '⛔ Denied by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: 'Only the member who received it can appeal. Staff decide — Approve removes it, or reduce its units.' });
  return e;
}

// Submit a new strike appeal. `state` is the bot's shared State instance (needed to read the ledger).
async function submit(guild, member, state, strikeId, note) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Strike appeals aren’t set up yet — an admin needs to run `/appeal-strike-setup`.' };
  const entry = strikes.ledger(state, member.id).find(e => e.id === strikeId);
  if (!entry || !entry.active) return { ok: false, msg: 'I couldn’t find an active strike with that ID on your record. It may already be removed, or the ID’s wrong. Use the autocomplete list instead of typing it by hand.' };
  if (entry.crossedBan) return { ok: false, msg: 'That’s the strike that crossed the ban threshold — it isn’t appealable here. If you were banned over it, use `/appeal ban` instead (a friend still in the server has to open that one for you).' };

  const st = loadState();
  const openExisting = Object.values(st.appeals).find(a => a.memberId === member.id && a.status === 'open');
  if (openExisting) return { ok: false, msg: `You already have an open strike appeal → <#${openExisting.threadId}>. Wait for staff to decide that one first.` };
  // Cooldown after a denial — must key off the MOST-RECENT denial. A plain .find() returns the oldest
  // record, so after a 2nd denial the stale (long-past) deniedAt would make the cooldown look expired and
  // let the same strike be re-appealed on repeat. Take the max deniedAt across all denials of this strike.
  const deniedAts = Object.values(st.appeals).filter(a => a.strikeId === strikeId && a.status === 'denied').map(a => a.deniedAt || 0);
  if (deniedAts.length) {
    const readyAt = Math.max(...deniedAts) + (config.strikeAppealCooldownDays || 7) * 86400000;
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
    embeds: [appealEmbed(rec)], components: buttons(false, null, entry.weight), allowedMentions: { users: [member.id] },
  });
  rec.starterId = msg.id;
  st.appeals[thread.id] = rec; saveState(st);
  await notifyNew(guild, member.id, thread.id).catch(() => {});
  await ensureBoard(guild).catch(() => {});
  return { ok: true, threadId: thread.id };
}

// staff Approve/Deny — gated to mods+ in index.js. Needs `state` to actually remove the strike.
async function handleButton(interaction, state) {
  const guild = interaction.guild;
  const st = loadState();
  const rec = st.appeals[interaction.channelId];
  if (!rec) return interaction.reply({ content: copy.appeals.untracked, flags: MessageFlags.Ephemeral });
  if (rec.status !== 'open') return interaction.reply({ content: 'This appeal was already decided.', flags: MessageFlags.Ephemeral });
  const cid = interaction.customId;
  const isDeny = cid === 'strikeappeal_deny';
  const reduceTo = cid.startsWith('strikeappeal_reduce:') ? Number(cid.split(':')[1]) : null;   // partial approve
  const isApprove = cid === 'strikeappeal_approve' || reduceTo !== null;

  if (isApprove) {
    const member = await guild.members.fetch(rec.memberId).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn’t in the server anymore — can’t safely change the strike/timeout from here. If they come back, use `/strike`.', flags: MessageFlags.Ephemeral });
    if (reduceTo !== null) {
      const r = await strikes.setStrikeWeight(guild, member, state, rec.strikeId, reduceTo, interaction.user.tag);
      if (!r.ok) return interaction.reply({ content: 'Couldn’t find that strike anymore — it may have already been changed. Nothing was done.', flags: MessageFlags.Ephemeral });
      rec.reducedTo = reduceTo;
    } else {
      const r = await strikes.removeStrike(guild, member, state, rec.strikeId, interaction.user.tag);
      if (!r.ok) return interaction.reply({ content: 'Couldn’t find that strike anymore — it may have already been removed some other way. Nothing was changed.', flags: MessageFlags.Ephemeral });
      if (rec.strikeSnapshot.timeoutMs && member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now())
        await member.timeout(null, `Strike appeal approved by ${interaction.user.tag}`).catch(() => {});   // full removal lifts the timeout; a reduction leaves it
    }
  }
  const outcome = isDeny ? 'denied' : reduceTo !== null ? 'reduced' : 'approved';
  rec.status = isDeny ? 'denied' : 'approved'; rec.decidedBy = interaction.user.id;
  if (isDeny) rec.deniedAt = Date.now();
  saveState(st);
  await interaction.update({ embeds: [appealEmbed(rec, outcome, interaction.user.id)], components: buttons(true, outcome, rec.strikeSnapshot?.weight) }).catch(() => {});
  const thread = await guild.channels.fetch(rec.threadId).catch(() => null);
  if (thread) {
    const msg = isDeny
      ? `⛔ <@${rec.memberId}> — your appeal was **denied** by <@${interaction.user.id}>. The strike stands.`
      : reduceTo !== null
        ? `⚖️ <@${rec.memberId}> — your appeal was **partially approved** by <@${interaction.user.id}>. The strike was reduced to **${reduceTo} unit${reduceTo > 1 ? 's' : ''}**.`
        : `✅ <@${rec.memberId}> — your appeal was **approved** by <@${interaction.user.id}>. The strike has been removed.`;
    await thread.send({ content: msg, allowedMentions: { users: [rec.memberId] } }).catch(() => {});
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  await ensureBoard(guild).catch(() => {});
  await ownerlog.log(guild, { emoji: isDeny ? '⛔' : reduceTo !== null ? '⚖️' : '✅',
    title: `Strike appeal ${isDeny ? 'denied' : reduceTo !== null ? `partially approved (→ ${reduceTo}u)` : 'approved (strike removed)'}`, color: isDeny ? 0xED4245 : 0x57F287,
    detail: `<@${rec.memberId}> — strike \`${rec.strikeId}\` — by <@${interaction.user.id}>.` });
  return interaction.followUp({ content: isDeny ? copy.appeals.denied : reduceTo !== null ? `⚖️ Strike reduced to ${reduceTo} units and appeal closed.` : '✅ Strike removed and appeal closed.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
}

// Public "open strike appeals" board — pinned in the (member-visible) base channel: WHO has an open
// appeal + a link. The appeal content stays in the private thread. Strikes are already announced publicly,
// so naming who's appealing exposes nothing new.
async function ensureBoard(guild) {
  const c = loadConfig();
  if (!c.channelId) return;
  const ch = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!ch) return;
  const open = Object.values(loadState().appeals).filter(a => a.status === 'open');
  const lines = open.length
    ? open.map(a => `• <@${a.memberId}> — appealing a strike → <#${a.threadId}>`).join('\n').slice(0, 4000)
    : '_No open strike appeals right now._';
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`📋 Open strike appeals (${open.length})`)
    .setDescription(lines).setFooter({ text: 'Appeal your own strike: /appeal strike' });
  const existing = c.boardId ? await ch.messages.fetch(c.boardId).catch(() => null) : null;
  if (existing) return void existing.edit({ embeds: [embed] }).catch(() => {});
  const m = await ch.send({ embeds: [embed] }).catch(() => null);
  if (m) { await m.pin().catch(() => {}); c.boardId = m.id; saveConfig(c); }
}
async function notifyNew(guild, memberId, threadId) {
  const c = loadConfig();
  const ch = c.channelId && await guild.channels.fetch(c.channelId).catch(() => null);
  if (!ch) return;
  await ch.send({ content: `${config.modRoleId ? `<@&${config.modRoleId}> ` : ''}⚖️ new **strike appeal** from <@${memberId}> → <#${threadId}>`,
    allowedMentions: { roles: config.modRoleId ? [config.modRoleId] : [], users: [] } }).catch(() => {});
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, ensureBoard };
