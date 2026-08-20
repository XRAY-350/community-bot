// reports.js — /report opens a private thread with staff instead of a one-shot message (owner,
// 2026-08-20: "so people can open tickets if we miss a situation... mods look at it, and sort the
// situation out on the thread... the thread gets closed after" — the old one-shot-message design had
// no way to follow up). The reporter is still hidden from the person they're reporting (never added to
// the thread), but IS visible to staff once inside — a live back-and-forth can't stay sealed from the
// people having it, unlike whistleblow's DM-only, never-stored anonymous lane. Staff close the thread
// (locks + archives it) once it's sorted; it can be reopened if something new comes up.
const fs = require('fs');
const { statePath } = require('./statepath');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');
const copy = require('./copy');

const CONFIG_FILE = process.env.FUBU_REPORTS_FILE || statePath('reports.json');
const STATE_FILE = process.env.FUBU_REPORTS_STATE_FILE || statePath('reports_state.json');
const COOLDOWN_MS = 30 * 60 * 1000, DAILY_MAX = 6;
const MIN_LEN = 10, MAX_LEN = 1000;
const P = PermissionsBitField.Flags;

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[reports] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { counter: 0, cooldown: {}, posts: {} });
const saveState = s => _save(STATE_FILE, s);
function isConfigured() { return !!loadConfig().channelId; }

// @everyone gets ViewChannel on the ROOT (so the bot can add a plain member to a thread here — adding
// someone to a private thread needs them to at least be able to see the parent channel, or the bot's
// add call fails with "Missing Access"), but can't post in the root or start their own threads. Other
// members' threads stay invisible regardless — Discord only shows a private thread to its own members
// or to ManageThreads holders, same shape as strikeAppeals.js's channel.
async function setup(guild) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const channel = await guild.channels.create({
    name: '🚩┆reports', type: ChannelType.GuildText,
    topic: 'Member reports. Each one opens a private thread with staff so it can actually get sorted out.',
    permissionOverwrites: [{ id: guild.id,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
      deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
    reason: 'Reports channel (owner request)',
  });
  c = { channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

function reportEmbed(num, text, reportedId, status) {
  const e = new EmbedBuilder().setColor(status === 'closed' ? 0x99AAB5 : 0xE74C3C).setTitle(`🚩 Report #${num}`).setDescription(text)
    .addFields({ name: 'About', value: reportedId ? `<@${reportedId}>` : '_unspecified_', inline: true });
  e.setFooter({ text: status === 'closed' ? 'Closed. Staff can reopen it if needed.' : 'Only you and staff can see this thread.' });
  return e;
}
const closeRow = (closed) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('rep_close').setEmoji('🔒').setLabel('Close').setStyle(ButtonStyle.Secondary).setDisabled(!!closed),
  new ButtonBuilder().setCustomId('rep_reopen').setEmoji('🔓').setLabel('Reopen').setStyle(ButtonStyle.Secondary).setDisabled(!closed));

async function submit(guild, member, reportedUser, text) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: copy.reports.notSetup };
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (text.length < MIN_LEN) return { ok: false, msg: copy.reports.tooShort(MIN_LEN) };
  if (text.length > MAX_LEN) return { ok: false, msg: copy.reports.tooLong(MAX_LEN) };
  if (watchlist.matchTerms(text, watchlist.loadTerms()).length) return { ok: false, msg: copy.reports.filtered };
  const state = loadState();
  const last = state.cooldown[member.id] || 0, waitLeft = COOLDOWN_MS - (Date.now() - last);
  if (last && waitLeft > 0) return { ok: false, msg: copy.common.onCooldown(Math.ceil(waitLeft / 60000)) };
  const day = new Date().toISOString().slice(0, 10);
  const dc = (state.daily || {})[member.id];
  if (dc && dc.day === day && dc.n >= DAILY_MAX) return { ok: false, msg: copy.common.dailyLimit(DAILY_MAX) };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: copy.reports.channelMissing };

  const num = (state.counter || 0) + 1;
  const reportedId = reportedUser ? reportedUser.id : null;
  const thread = await channel.threads.create({
    name: `Report #${num} · ${member.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Report by ${member.user.tag}${reportedUser ? ` about ${reportedUser.tag}` : ''}`,
  });
  await thread.members.add(member.id).catch(() => {});
  const msg = await thread.send({
    content: `<@${member.id}>, staff can see this thread. Add anything else that'll help below, screenshots included.`,
    embeds: [reportEmbed(num, text, reportedId, 'open')], components: [closeRow(false)], allowedMentions: { users: [member.id] },
  });
  state.counter = num; state.cooldown[member.id] = Date.now();
  state.daily = state.daily || {}; state.daily[member.id] = (dc && dc.day === day) ? { day, n: dc.n + 1 } : { day, n: 1 };
  state.posts[thread.id] = { num, reporterId: member.id, reportedId, starterId: msg.id, status: 'open' };
  saveState(state);
  return { ok: true, num, threadId: thread.id };
}

async function setStatus(interaction, status) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: copy.reports.untracked, flags: MessageFlags.Ephemeral });
  const thread = interaction.channel;
  if (status === 'open' && (thread.archived || thread.locked)) { await thread.setArchived(false).catch(() => {}); await thread.setLocked(false).catch(() => {}); }
  post.status = status; saveState(state);
  const starter = await thread.messages.fetch(post.starterId).catch(() => null);
  if (starter) await starter.edit({ embeds: [reportEmbed(post.num, starter.embeds[0]?.description || '', post.reportedId, status)], components: [closeRow(status === 'closed')] }).catch(() => {});
  await thread.send(status === 'closed' ? `🔒 Closed by <@${interaction.user.id}>.` : `🔓 Reopened by <@${interaction.user.id}>.`).catch(() => {});
  if (status === 'closed') { await thread.setLocked(true).catch(() => {}); await thread.setArchived(true).catch(() => {}); }
  return interaction.reply({ content: status === 'closed' ? '🔒 Closed.' : '🔓 Reopened.', flags: MessageFlags.Ephemeral });
}

async function handleButton(interaction) {
  if (interaction.customId === 'rep_close') return setStatus(interaction, 'closed');
  if (interaction.customId === 'rep_reopen') return setStatus(interaction, 'open');
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, CONFIG_FILE, STATE_FILE };
