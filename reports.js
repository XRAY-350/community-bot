// reports.js — /report opens a private thread with staff instead of a one-shot message (owner,
// 2026-08-20: "so people can open tickets if we miss a situation... mods look at it, and sort the
// situation out on the thread... the thread gets closed after" — the old one-shot-message design had
// no way to follow up). As of 2026-08-26 the channel is STAFF-ONLY and the report thread is ONE-WAY: the
// reporter is never added (owner: "the report creates the one way and the person can optionally create a
// sidebar after the fact or a mod+ can after the reporter has been revealed"). The reporter is shown to
// staff for context but the person they reported never sees it. Staff close the thread (locks + archives)
// once it's sorted; it can be reopened if something new comes up. See setup() + SERVER_CONFIG.md.
const fs = require('fs');
const { statePath } = require('./statepath');
const { withLock } = require('./mutex');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');
const copy = require('./copy');
const sidebar = require('./sidebar');
const config = require('./config');

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

// STAFF-ONLY channel (owner, 2026-08-26: "only staff should see anon reports" — see SERVER_CONFIG.md,
// the "@everyone base has no ViewChannel; only explicit allows are seen" model). @everyone is view-DENIED
// so it never shows in a previewer/unverified/regular-member's channel list; mods + admins get view via
// their role overwrites (Send comes from their base role perms, matching every other Staff-category
// channel like #mod-inbox). The report thread is now ONE-WAY: the reporter is NOT added to it (a member
// can't be in a private thread inside a channel they can't see anyway), so reports live purely as staff
// records. Follow-up with the reporter is a separate, deliberate step — the reporter can open a sidebar
// themselves from their report confirmation, or a mod+ can via the "Sidebar with reporter" button once
// they see who reported.
async function setup(guild) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const staffAllow = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.SendMessagesInThreads, P.ManageThreads, P.ManageMessages, P.EmbedLinks, P.AttachFiles];
  const overwrites = [{ id: guild.id, deny: [P.ViewChannel, P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }];
  for (const rid of [config.modRoleId, config.adminRoleId]) if (rid) overwrites.push({ id: rid, allow: staffAllow });
  for (const rid of [config.cornerRoleId, config.adultCornerRoleId]) if (rid) overwrites.push({ id: rid, deny: [P.ViewChannel] });
  const channel = await guild.channels.create({
    name: '🚩┆reports', type: ChannelType.GuildText,
    topic: 'Member reports. Each one opens a private, staff-only thread so it can actually get sorted out.',
    permissionOverwrites: overwrites,
    reason: 'Reports channel (owner request) — staff-only',
  });
  c = { channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

function reportEmbed(num, text, reportedId, status) {
  const e = new EmbedBuilder().setColor(status === 'closed' ? 0x99AAB5 : 0xE74C3C).setTitle(`🚩 Report #${num}`).setDescription(text)
    .addFields({ name: 'About', value: reportedId ? `<@${reportedId}>` : '_unspecified_', inline: true });
  e.setFooter({ text: status === 'closed' ? 'Closed. Staff can reopen it if needed.' : 'Staff-only. The reporter is not in this thread.' });
  return e;
}
const closeRow = (closed) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('rep_close').setEmoji('🔒').setLabel('Close').setStyle(ButtonStyle.Secondary).setDisabled(!!closed),
  new ButtonBuilder().setCustomId('rep_reopen').setEmoji('🔓').setLabel('Reopen').setStyle(ButtonStyle.Secondary).setDisabled(!closed),
  // Escalate to a proper 1:1 in #sidebars (owner, 2026-08-25: "the report system has two functions one for
  // the reports which end up in the channel and should stay private, there's also the option for sidebars
  // with mods after a report which should take place in the sidebar channel" — reports stays where it is,
  // this just opens the SEPARATE sidebar system with the reporter for any follow-up talk).
  new ButtonBuilder().setCustomId('rep_sidebar').setEmoji('🗣️').setLabel('Sidebar with reporter').setStyle(ButtonStyle.Secondary));

// Serialized behind the module lock (audit U10): this is a load->awaits->save read-modify-write; two
// concurrent calls used to lose the earlier one's record (the documented appeals.js incident class).
async function submit(guild, member, reportedUser, text) { return withLock('reports', () => _submit(guild, member, reportedUser, text)); }
async function _submit(guild, member, reportedUser, text) {
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
  // ONE-WAY: the reporter is NOT added — this is a staff-only channel, so the report is a staff record.
  // The reporter's identity is shown here for staff context; follow-up happens via a sidebar (reporter- or
  // staff-initiated), never in this thread.
  const msg = await thread.send({
    content: `New report from <@${member.id}>.`,
    embeds: [reportEmbed(num, text, reportedId, 'open')], components: [closeRow(false)], allowedMentions: { users: [] },
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

// Open a #sidebars thread with the REPORTER (never the reported person — same "reporter hidden from who
// they reported" rule the report thread itself follows) for any follow-up conversation. The report thread
// itself is untouched — stays open/closed exactly as it was; this just links off to the separate system.
async function pullToSidebar(interaction) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: copy.reports.untracked, flags: MessageFlags.Ephemeral });
  const reporter = await interaction.guild.members.fetch(post.reporterId).catch(() => null);
  if (!reporter) return interaction.reply({ content: 'Couldn’t find the reporter (they may have left).', flags: MessageFlags.Ephemeral });
  const r = await sidebar.pull(interaction.guild, interaction.member, [reporter], `Follow-up on Report #${post.num}`);
  if (!r.ok) return interaction.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
  await interaction.channel.send(`🗣️ Follow-up opened with the reporter in <#${r.threadId}> (Sidebar #${r.num}) by <@${interaction.user.id}>.`).catch(() => {});
  return interaction.reply({ content: `🗣️ Opened **Sidebar #${r.num}** with the reporter → <#${r.threadId}>.`, flags: MessageFlags.Ephemeral });
}

async function handleButton(interaction) {
  if (interaction.customId === 'rep_close') return setStatus(interaction, 'closed');
  if (interaction.customId === 'rep_reopen') return setStatus(interaction, 'open');
  if (interaction.customId === 'rep_sidebar') return pullToSidebar(interaction);
}

// Thread ids where this member is the REPORTER — corner's thread-strip must not eject someone from their
// own report thread (audit U6, 2026-08-26): due process stays reachable while cornered.
function threadsFor(memberId) {
  const s = loadState();
  return Object.entries(s.posts || {}).filter(([, p]) => p && p.reporterId === memberId).map(([tid]) => tid);
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, threadsFor, CONFIG_FILE, STATE_FILE };
