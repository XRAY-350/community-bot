// reports.js — anon pipe: /report. A member reports another member's behaviour without exposing
// themselves to the person they're reporting. The report lands in a mod-only channel (staff act on it),
// but WHO reported is sealed and revealable only to admins+ (per the locked visibility model:
// report → author visible to admins), via a button. Mirrors the confessions pattern.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');
const copy = require('./copy');

const CONFIG_FILE = process.env.FUBU_REPORTS_FILE || '/home/ubuntu/.fubu_reports.json';
const STATE_FILE = process.env.FUBU_REPORTS_STATE_FILE || '/home/ubuntu/.fubu_reports_state.json';
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

async function setup(guild, config) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const wl = config?.watchLogChannelId ? await guild.channels.fetch(config.watchLogChannelId).catch(() => null) : null;
  const overwrites = (wl && wl.permissionOverwrites.cache.size)
    ? [...wl.permissionOverwrites.cache.values()].map(o => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
    : [{ id: guild.id, deny: [P.ViewChannel] }];
  const channel = await guild.channels.create({
    name: '🚩┆anon-reports', type: ChannelType.GuildText,
    topic: 'Anonymous member reports. Staff act on them; only admins can reveal who reported.',
    permissionOverwrites: overwrites, reason: 'Anonymous reports channel (owner request)',
  });
  c = { channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

function reportEmbed(num, text, reportedId, revealedBy, reporterId) {
  const e = new EmbedBuilder().setColor(0xE74C3C).setTitle(`🚩 Report #${num}`).setDescription(text)
    .addFields({ name: 'About', value: reportedId ? `<@${reportedId}>` : '_unspecified_', inline: true });
  if (revealedBy) e.addFields({ name: 'Reporter (revealed)', value: `<@${reporterId}>, revealed by <@${revealedBy}>`, inline: true });
  else e.setFooter({ text: 'Reporter hidden. Admins can reveal on cause.' });
  return e;
}
const revealRow = (disabled) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('rep_reveal').setEmoji('🔍').setLabel(copy.reports.revealLabel(disabled))
    .setStyle(ButtonStyle.Secondary).setDisabled(!!disabled));

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
  const msg = await channel.send({ embeds: [reportEmbed(num, text, reportedId)], components: [revealRow(false)] });
  state.counter = num; state.cooldown[member.id] = Date.now();
  state.daily = state.daily || {}; state.daily[member.id] = (dc && dc.day === day) ? { day, n: dc.n + 1 } : { day, n: 1 };
  state.posts[msg.id] = { num, reporterId: member.id, reportedId };
  saveState(state);
  return { ok: true, num };
}

async function reveal(interaction) {
  const state = loadState();
  const post = state.posts[interaction.message.id];
  if (!post) return interaction.reply({ content: copy.reports.untracked, flags: MessageFlags.Ephemeral });
  if (post.revealedBy) return interaction.reply({ content: `Already revealed (by <@${post.revealedBy}>). Reporter: <@${post.reporterId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  post.revealedBy = interaction.user.id; saveState(state);
  await interaction.update({ embeds: [reportEmbed(post.num, interaction.message.embeds[0]?.description || '', post.reportedId, interaction.user.id, post.reporterId)], components: [revealRow(true)] });
  return interaction.followUp({ content: `🔍 Reporter of Report #${post.num}: <@${post.reporterId}>. Logged on the report.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handleButton(interaction) { if (interaction.customId === 'rep_reveal') return reveal(interaction); }

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, CONFIG_FILE, STATE_FILE };
