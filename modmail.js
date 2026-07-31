// modmail.js — anon pipe: /modmail. An anonymous line to the mod team. The message lands in a mod-only
// inbox (staff read + act); WHO sent it is sealed and revealable only to owners (per the locked model:
// modmail → author visible to owners), via a button. Intake v1 (member → staff); a staff
// reply-relay can be layered on later. Mirrors the confessions/reports pattern.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');

const CONFIG_FILE = process.env.FUBU_MODMAIL_FILE || '/home/ubuntu/.fubu_modmail.json';
const STATE_FILE = process.env.FUBU_MODMAIL_STATE_FILE || '/home/ubuntu/.fubu_modmail_state.json';
const COOLDOWN_MS = 30 * 60 * 1000, DAILY_MAX = 6;
const MIN_LEN = 5, MAX_LEN = 1000;
const P = PermissionsBitField.Flags;

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[modmail] save:', e.message); } }
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
    name: '📨┆mod-inbox', type: ChannelType.GuildText,
    topic: 'Anonymous messages to the mod team. Only owners can reveal who sent one.',
    permissionOverwrites: overwrites, reason: 'Anonymous modmail inbox (owner request)',
  });
  c = { channelId: channel.id }; saveConfig(c);
  return { channel, created: true };
}

function mailEmbed(num, text, revealedBy, senderId) {
  const e = new EmbedBuilder().setColor(0x1ABC9C).setTitle(`📨 Modmail #${num}`).setDescription(text);
  if (revealedBy) e.addFields({ name: 'Sender (revealed)', value: `<@${senderId}> — by <@${revealedBy}>`, inline: true });
  else e.setFooter({ text: 'Sender hidden. Only owners can reveal.' });
  return e;
}
const revealRow = (disabled) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('mm_reveal').setEmoji('🔍').setLabel(disabled ? 'Revealed' : 'Reveal sender (owners)')
    .setStyle(ButtonStyle.Secondary).setDisabled(!!disabled));

async function submit(guild, member, text) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Modmail isn’t set up yet — an admin needs to run `/modmail-setup`.' };
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (text.length < MIN_LEN) return { ok: false, msg: `That’s too short — at least ${MIN_LEN} characters.` };
  if (text.length > MAX_LEN) return { ok: false, msg: `Keep it under ${MAX_LEN} characters.` };
  if (watchlist.matchTerms(text, watchlist.loadTerms()).length) return { ok: false, msg: 'That tripped the safety filter — reword without threats/slurs and resend.' };
  const state = loadState();
  const last = state.cooldown[member.id] || 0, waitLeft = COOLDOWN_MS - (Date.now() - last);
  if (last && waitLeft > 0) return { ok: false, msg: `You’re on cooldown — try again in ${Math.ceil(waitLeft / 60000)} min.` };
  const day = new Date().toISOString().slice(0, 10);
  const dc = (state.daily || {})[member.id];
  if (dc && dc.day === day && dc.n >= DAILY_MAX) return { ok: false, msg: `You’ve hit today’s limit of ${DAILY_MAX}. Try again tomorrow.` };
  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The modmail inbox is missing — an admin needs to run `/modmail-setup` again.' };
  const num = (state.counter || 0) + 1;
  const msg = await channel.send({ embeds: [mailEmbed(num, text)], components: [revealRow(false)] });
  state.counter = num; state.cooldown[member.id] = Date.now();
  state.daily = state.daily || {}; state.daily[member.id] = (dc && dc.day === day) ? { day, n: dc.n + 1 } : { day, n: 1 };
  state.posts[msg.id] = { num, senderId: member.id };
  saveState(state);
  return { ok: true, num };
}

// reveal is gated to OWNERS in index.js before this runs
async function reveal(interaction) {
  const state = loadState();
  const post = state.posts[interaction.message.id];
  if (!post) return interaction.reply({ content: 'This modmail is no longer tracked.', flags: MessageFlags.Ephemeral });
  if (post.revealedBy) return interaction.reply({ content: `Already revealed (by <@${post.revealedBy}>). Sender: <@${post.senderId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  post.revealedBy = interaction.user.id; saveState(state);
  await interaction.update({ embeds: [mailEmbed(post.num, interaction.message.embeds[0]?.description || '', interaction.user.id, post.senderId)], components: [revealRow(true)] });
  return interaction.followUp({ content: `🔍 Sender of Modmail #${post.num}: <@${post.senderId}>. Logged.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handleButton(interaction) { if (interaction.customId === 'mm_reveal') return reveal(interaction); }

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, CONFIG_FILE, STATE_FILE };
