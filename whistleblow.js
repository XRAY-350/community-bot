// whistleblow.js — Phase 2 of the anon pipe: the whistleblower lane. Members run /whistleblow to raise a
// complaint about the server or its staff. It posts ANONYMOUSLY to an oversight channel that ONLY the two
// people at the top (the head admin = "you", and the server owner = "her") can see — regular mods/admins
// are deliberately excluded, since the complaint might be about them.
//
// The sender chooses, per submission, who (if anyone) may ever unmask them:
//   you   → only the head admin can unseal, on cause
//   her   → only the server owner can unseal, on cause
//   both  → either can unseal, on cause
//   none  → NO identity is stored at all; nobody can ever unmask it. Genuinely anonymous.
// Unsealing (you/her/both) reveals the author to the authorized holder and is logged on the post.
//
// Honesty notes baked in: for `none` we persist NOTHING that identifies the sender (no id, no hash).
// Cooldown is enforced from an IN-MEMORY map only (raw id never written to disk, cleared on restart), so
// an anonymous whistleblow leaves no on-disk trace of who sent it.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');

const CONFIG_FILE = process.env.FUBU_WHISTLEBLOW_FILE || '/home/ubuntu/.fubu_whistleblow.json';
const STATE_FILE = process.env.FUBU_WHISTLEBLOW_STATE_FILE || '/home/ubuntu/.fubu_whistleblow_state.json';
const COOLDOWN_MS = 10 * 60 * 1000;
const MIN_LEN = 10, MAX_LEN = 1500;
const P = PermissionsBitField.Flags;

const _cooldown = new Map();   // userId -> ts, in-memory ONLY (never persisted) so `none` leaves no trace

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[whistleblow] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { counter: 0, posts: {} });
const saveState = s => _save(STATE_FILE, s);
function isConfigured() { const c = loadConfig(); return !!(c.channelId && c.you && c.her); }

const CHOICES = {
  you: 'Head admin only', her: 'Server owner only', both: 'Head admin + owner', none: 'No one — fully anonymous',
};
// who may unseal a post given its choice
function allowedUnsealers(choice, cfg) {
  if (choice === 'you') return [cfg.you];
  if (choice === 'her') return [cfg.her];
  if (choice === 'both') return [cfg.you, cfg.her];
  return []; // none
}

// ---- setup: create the oversight channel visible only to head-admin (setup runner) + server owner ------
async function setup(guild, headAdminId) {
  let c = loadConfig();
  const herId = guild.ownerId;
  if (c.channelId) {
    const existing = await guild.channels.fetch(c.channelId).catch(() => null);
    if (existing) {
      // keep channel; refresh the two apex ids (head admin may be re-running setup)
      c = { ...c, you: headAdminId, her: herId };
      saveConfig(c);
      await existing.permissionOverwrites.set([
        { id: guild.id, deny: [P.ViewChannel] },
        { id: headAdminId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
        { id: herId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
      ], 'refresh whistleblow oversight viewers').catch(() => {});
      return { channel: existing, created: false, you: headAdminId, her: herId };
    }
  }
  const channel = await guild.channels.create({
    name: '🕊️┆whistleblow', type: ChannelType.GuildText,
    topic: 'Whistleblower reports about the server/staff. Visible only to the head admin + owner. Members submit with /whistleblow.',
    permissionOverwrites: [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: headAdminId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
      { id: herId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
    ],
    reason: 'Whistleblower oversight channel (owner request)',
  });
  c = { channelId: channel.id, you: headAdminId, her: herId };
  saveConfig(c);
  return { channel, created: true, you: headAdminId, her: herId };
}

function postEmbed(num, text, choice, unsealedBy) {
  const e = new EmbedBuilder().setColor(unsealedBy ? 0xE67E22 : 0x9B59B6).setTitle(`🕊️ Whistleblow #${num}`).setDescription(text)
    .addFields({ name: 'Sender chose', value: CHOICES[choice] || choice, inline: true });
  if (choice === 'none') e.setFooter({ text: 'Fully anonymous — no identity was stored. This can never be unmasked.' });
  else e.setFooter({ text: 'Sealed. Unseal only on cause (threats / doxxing / targeted harassment) — it will be logged.' });
  if (unsealedBy) e.addFields({ name: '🔓 Unsealed by', value: `<@${unsealedBy}>`, inline: true });
  return e;
}
const unsealRow = (disabled) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('wb_unseal').setEmoji('🔓').setLabel(disabled ? 'Unsealed' : 'Unseal author (on cause)')
    .setStyle(ButtonStyle.Secondary).setDisabled(!!disabled));

// ---- submit -----------------------------------------------------------------------------------------
async function submit(guild, member, text, choice) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'The whistleblow channel isn’t set up yet — the head admin needs to run `/whistleblow-setup`.' };
  if (!CHOICES[choice]) return { ok: false, msg: 'Pick who (if anyone) may unmask you.' };
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (text.length < MIN_LEN) return { ok: false, msg: `Give a bit more detail — at least ${MIN_LEN} characters.` };
  if (text.length > MAX_LEN) return { ok: false, msg: `Keep it under ${MAX_LEN} characters.` };
  // LIGHTER filter — block only threats/doxxing/raid (strict list), NOT criticism or anger
  const bad = watchlist.matchTerms(text, watchlist.loadTerms());
  if (bad.length) return { ok: false, msg: 'That tripped the safety filter (threats/doxxing aren’t allowed even here). Reword the concern itself and resend.' };
  // cooldown — in-memory only, so `none` leaves no on-disk trace of the sender
  const last = _cooldown.get(member.id) || 0;
  const waitLeft = COOLDOWN_MS - (Date.now() - last);
  if (last && waitLeft > 0) return { ok: false, msg: `You’re on cooldown — try again in ${Math.ceil(waitLeft / 60000)} min.` };

  const channel = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!channel) return { ok: false, msg: 'The whistleblow channel is missing — the head admin needs to run `/whistleblow-setup` again.' };
  const state = loadState();
  const num = (state.counter || 0) + 1;
  const msg = await channel.send({ embeds: [postEmbed(num, text, choice)], components: choice === 'none' ? [] : [unsealRow(false)] });
  state.counter = num;
  // store the author ONLY when the sender allowed a holder to unseal; `none` stores null
  state.posts[msg.id] = { num, choice, authorId: choice === 'none' ? null : member.id };
  saveState(state);
  _cooldown.set(member.id, Date.now());
  return { ok: true, num, choice };
}

// ---- unseal (on cause) ------------------------------------------------------------------------------
async function unseal(interaction) {
  const c = loadConfig();
  const state = loadState();
  const post = state.posts[interaction.message.id];
  if (!post) return interaction.reply({ content: 'This whistleblow is no longer tracked.', flags: MessageFlags.Ephemeral });
  if (!post.authorId) return interaction.reply({ content: 'This one is fully anonymous — the sender chose “no one”, so there is no identity stored to unseal.', flags: MessageFlags.Ephemeral });
  const allowed = allowedUnsealers(post.choice, c);
  if (!allowed.includes(interaction.user.id))
    return interaction.reply({ content: 'You’re not authorized to unseal this one — the sender entrusted it to someone else.', flags: MessageFlags.Ephemeral });
  if (post.unsealedBy) return interaction.reply({ content: `Already unsealed (by <@${post.unsealedBy}>). Author: <@${post.authorId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  post.unsealedBy = interaction.user.id;
  saveState(state);
  // edit the post to record the unseal (visible to the two viewers), then privately reveal the author
  await interaction.update({ embeds: [postEmbed(post.num, interaction.message.embeds[0]?.description || '', post.choice, interaction.user.id)], components: [unsealRow(true)] });
  return interaction.followUp({ content: `🔓 Author of Whistleblow #${post.num}: <@${post.authorId}>. This unseal is logged on the post.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handleButton(interaction) {
  if (interaction.customId === 'wb_unseal') return unseal(interaction);
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, CHOICES, CONFIG_FILE, STATE_FILE };
