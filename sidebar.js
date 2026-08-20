// sidebar.js — /sidebar (+ right-click a member → Apps → Sidebar): a mod pulls a member aside for a
// private 1:1 chat. Not punishment — unlike /corner, it strips nothing, restricts nothing anywhere
// else, and carries no rule/reason picker. Mirrors reports.js's thread shape (a hidden staff-only
// channel, one private thread per pull, Close/Reopen buttons that lock+archive) since that's already
// the proven "private space, staff can see it, member can't be seen by other members" pattern.
const fs = require('fs');
const { statePath } = require('./statepath');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');

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

// @everyone gets ViewChannel on the ROOT (so the bot can add a plain member to a thread here — adding
// someone to a private thread needs them to at least be able to see the parent channel, or the bot's
// add call fails with "Missing Access"), but can't post in the root or start their own threads. Other
// members' threads stay invisible regardless — Discord only shows a private thread to its own members
// or to ManageThreads holders, same shape as strikeAppeals.js's channel.
async function setup(guild) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const channel = await guild.channels.create({
    name: '🗣️┆sidebars', type: ChannelType.GuildText,
    topic: 'Private 1:1 chats staff opened with a member. Not punishment, just a quiet space to talk something through.',
    permissionOverwrites: [{ id: guild.id,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
      deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
    reason: 'Sidebars channel (owner request)',
  });
  c = { channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

function sidebarEmbed(num, targetId, byId, reason, status) {
  const e = new EmbedBuilder().setColor(status === 'closed' ? 0x99AAB5 : 0x5865F2).setTitle(`🗣️ Sidebar #${num}`)
    .setDescription(`<@${byId}> wants to talk something through with <@${targetId}> here. Nothing's wrong — this isn't a corner, just a private space to chat.`)
    .addFields({ name: 'With', value: `<@${targetId}>`, inline: true }, { name: 'Started by', value: `<@${byId}>`, inline: true });
  if (reason) e.addFields({ name: 'What about', value: String(reason).slice(0, 500), inline: false });
  e.setFooter({ text: status === 'closed' ? 'Closed. Staff can reopen it if needed.' : 'Only the two of you and staff can see this thread.' });
  return e;
}
const closeRow = (closed) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('sb_close').setEmoji('🔒').setLabel('Close').setStyle(ButtonStyle.Secondary).setDisabled(!!closed),
  new ButtonBuilder().setCustomId('sb_reopen').setEmoji('🔓').setLabel('Reopen').setStyle(ButtonStyle.Secondary).setDisabled(!closed));

async function pull(guild, byMember, targetMember, reason) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Sidebars aren’t set up yet. An admin needs to run `/sidebar-setup`.' };
  if (targetMember.id === byMember.id) return { ok: false, msg: 'You can’t sidebar yourself.' };
  if (targetMember.user?.bot) return { ok: false, msg: 'Can’t sidebar a bot.' };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The sidebars channel is missing. An admin needs to re-run `/sidebar-setup`.' };

  const state = loadState();
  const num = (state.counter || 0) + 1;
  const thread = await channel.threads.create({
    name: `Sidebar #${num} · ${targetMember.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Sidebar opened by ${byMember.user.tag} with ${targetMember.user.tag}`,
  });
  await thread.members.add(targetMember.id).catch(() => {});
  const msg = await thread.send({
    content: `<@${targetMember.id}>`,
    embeds: [sidebarEmbed(num, targetMember.id, byMember.id, reason, 'open')], components: [closeRow(false)], allowedMentions: { users: [targetMember.id] },
  });
  state.counter = num;
  state.posts[thread.id] = { num, targetId: targetMember.id, byId: byMember.id, reason: reason || null, starterId: msg.id, status: 'open' };
  saveState(state);
  return { ok: true, num, threadId: thread.id };
}

async function setStatus(interaction, status) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: 'This sidebar is no longer tracked.', flags: MessageFlags.Ephemeral });
  const thread = interaction.channel;
  if (status === 'open' && (thread.archived || thread.locked)) { await thread.setArchived(false).catch(() => {}); await thread.setLocked(false).catch(() => {}); }
  post.status = status; saveState(state);
  const starter = await thread.messages.fetch(post.starterId).catch(() => null);
  if (starter) await starter.edit({ embeds: [sidebarEmbed(post.num, post.targetId, post.byId, post.reason, status)], components: [closeRow(status === 'closed')] }).catch(() => {});
  await thread.send(status === 'closed' ? `🔒 Closed by <@${interaction.user.id}>.` : `🔓 Reopened by <@${interaction.user.id}>.`).catch(() => {});
  if (status === 'closed') { await thread.setLocked(true).catch(() => {}); await thread.setArchived(true).catch(() => {}); }
  return interaction.reply({ content: status === 'closed' ? '🔒 Closed.' : '🔓 Reopened.', flags: MessageFlags.Ephemeral });
}

async function handleButton(interaction) {
  if (interaction.customId === 'sb_close') return setStatus(interaction, 'closed');
  if (interaction.customId === 'sb_reopen') return setStatus(interaction, 'open');
}

module.exports = { setup, pull, handleButton, isConfigured, loadConfig, CONFIG_FILE, STATE_FILE };
