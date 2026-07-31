// confessions.js — Phase 1 of the anonymous pipe. Members run /confess; the bot posts it ANONYMOUSLY
// to #confessions (bot is the author, so no member ever sees who wrote it). Per the locked visibility
// model, a confession's author is visible to staff (owner + you + all mods) via a separate MOD-ONLY
// #confession-log that carries the same text tagged with the real author + a delete button.
//   • members can't post in #confessions directly (Create/Send denied) — only the bot does
//   • content filtered through the watchlist matcher · per-member cooldown · verified-only (gated in index)
//   • numbered #1, #2… · staff can delete a bad one, which removes the public post too
// Self-contained: owns its config (channel ids) + state (counter/cooldown/author map) files.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');

const CONFIG_FILE = process.env.FUBU_CONFESSIONS_FILE || '/home/ubuntu/.fubu_confessions.json';
const STATE_FILE = process.env.FUBU_CONFESSIONS_STATE_FILE || '/home/ubuntu/.fubu_confessions_state.json';
const COOLDOWN_MS = 3 * 60 * 1000, DAILY_MAX = 20;
const MIN_LEN = 5, MAX_LEN = 1000;
const P = PermissionsBitField.Flags;

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[confessions] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { counter: 0, cooldown: {}, posts: {} });
const saveState = s => _save(STATE_FILE, s);

function isConfigured() { const c = loadConfig(); return !!(c.channelId && c.logChannelId); }

// ---- one-time setup: create the public + mod-only-log channels ---------------------------------------
async function setup(guild, config) {
  let c = loadConfig();
  if (c.channelId) {
    const existing = await guild.channels.fetch(c.channelId).catch(() => null);
    if (existing) return { channel: existing, created: false };
  }
  // Public confessions channel — everyone can read + react, only the bot can post.
  const channel = await guild.channels.create({
    name: '💭┆confessions', type: ChannelType.GuildText,
    topic: 'Anonymous confessions. Use /confess to send one — the bot posts it, your name is hidden from other members. Staff can see who wrote a confession.',
    permissionOverwrites: [{ id: guild.id,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions],
      deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads] }],
    reason: 'Anonymous confessions channel (owner request)',
  });
  // Mod-only author log — clone the watch-log's overwrites so it's staff-visible exactly like that channel.
  const wl = config?.watchLogChannelId ? await guild.channels.fetch(config.watchLogChannelId).catch(() => null) : null;
  const logOverwrites = (wl && wl.permissionOverwrites.cache.size)
    ? [...wl.permissionOverwrites.cache.values()].map(o => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
    : [{ id: guild.id, deny: [P.ViewChannel] }];
  const logChannel = await guild.channels.create({
    name: '💭┆confession-log', type: ChannelType.GuildText,
    topic: 'Who wrote each confession — staff only. Members never see this.',
    permissionOverwrites: logOverwrites,
    reason: 'Confession author log (staff-only)',
  });
  c = { channelId: channel.id, logChannelId: logChannel.id };
  saveConfig(c);
  return { channel, logChannel, created: true };
}

function publicEmbed(num, text) {
  return new EmbedBuilder().setColor(0x2B2D31).setTitle(`💭 Confession #${num}`).setDescription(text)
    .setFooter({ text: 'anonymous · /confess to send yours' });
}
function logEmbed(num, text, authorId, deletedBy) {
  const e = new EmbedBuilder().setColor(deletedBy ? 0xED4245 : 0x5865F2).setTitle(`Confession #${num}`).setDescription(text)
    .addFields({ name: 'Author', value: `<@${authorId}>`, inline: true });
  if (deletedBy) e.addFields({ name: 'Deleted by', value: `<@${deletedBy}>`, inline: true });
  return e;
}
const delRow = (disabled) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('conf_del').setEmoji('🗑️').setLabel(disabled ? 'Deleted' : 'Delete confession')
    .setStyle(ButtonStyle.Danger).setDisabled(!!disabled));

// ---- submit -----------------------------------------------------------------------------------------
async function submit(guild, member, text) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Confessions aren’t set up yet — an admin needs to run `/confess-setup`.' };
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (text.length < MIN_LEN) return { ok: false, msg: `That’s too short — give at least ${MIN_LEN} characters.` };
  if (text.length > MAX_LEN) return { ok: false, msg: `That’s too long — keep it under ${MAX_LEN} characters.` };
  const bad = watchlist.matchTerms(text, [...new Set([...watchlist.loadTerms(), ...watchlist.loadLoose(), ...watchlist.loadWelfare()])]);
  if (bad.length) return { ok: false, msg: 'That confession tripped the word filter, so it wasn’t posted. Rephrase it and try again.' };

  const state = loadState();
  const last = state.cooldown[member.id] || 0;
  const waitLeft = COOLDOWN_MS - (Date.now() - last);
  if (last && waitLeft > 0) return { ok: false, msg: `You’re on cooldown — try again in ${Math.ceil(waitLeft / 60000)} min.` };
  const day = new Date().toISOString().slice(0, 10);
  const dc = (state.daily || {})[member.id];
  if (dc && dc.day === day && dc.n >= DAILY_MAX) return { ok: false, msg: `You’ve hit today’s limit of ${DAILY_MAX}. Try again tomorrow.` };

  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  const logChannel = c.logChannelId ? await guild.channels.fetch(c.logChannelId).catch(() => null) : null;
  if (!channel) return { ok: false, msg: 'The confessions channel is missing — an admin needs to run `/confess-setup` again.' };

  const num = (state.counter || 0) + 1;
  const pub = await channel.send({ embeds: [publicEmbed(num, text)] });
  let logId = null;
  if (logChannel) {
    const lg = await logChannel.send({ embeds: [logEmbed(num, text, member.id)], components: [delRow(false)] }).catch(() => null);
    logId = lg ? lg.id : null;
  }
  state.counter = num;
  state.cooldown[member.id] = Date.now();
  state.daily = state.daily || {}; state.daily[member.id] = (dc && dc.day === day) ? { day, n: dc.n + 1 } : { day, n: 1 };
  // key by log message id (that's where the delete button lives); keep the public id to remove it too
  state.posts[logId || pub.id] = { num, authorId: member.id, publicId: pub.id, deleted: false };
  saveState(state);
  return { ok: true, num };
}

// ---- staff delete (from the log message's button) ---------------------------------------------------
async function del(interaction) {
  const state = loadState();
  const post = state.posts[interaction.message.id];
  if (!post) return interaction.reply({ content: 'This confession is no longer tracked.', flags: MessageFlags.Ephemeral });
  if (post.deleted) return interaction.reply({ content: 'Already deleted.', flags: MessageFlags.Ephemeral });
  const c = loadConfig();
  const ch = c.channelId ? await interaction.guild.channels.fetch(c.channelId).catch(() => null) : null;
  if (ch && post.publicId) await ch.messages.delete(post.publicId).catch(() => {});
  post.deleted = true;
  saveState(state);
  return interaction.update({ embeds: [logEmbed(post.num, interaction.message.embeds[0]?.description || '', post.authorId, interaction.user.id)], components: [delRow(true)] });
}

async function handleButton(interaction) {
  if (interaction.customId === 'conf_del') return del(interaction);
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, CONFIG_FILE, STATE_FILE };
