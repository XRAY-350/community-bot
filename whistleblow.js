// whistleblow.js — Phase 2 of the anon pipe: the whistleblower lane, DM-DELIVERED.
// A channel can't be hidden from anyone holding Discord's Administrator permission, and several FUBU
// staff do — so a "private" oversight channel would leak to them. The only truly-private delivery on a
// server where others have Administrator is a bot DM (no one can read another user's DMs). So a
// whistleblow is DMed straight to the person(s) the sender entrusts — never posted in any channel.
//
// The sender chooses, per report, WHO it goes to and whether they can ever be unmasked:
//   you        → DM to the head admin only; he can unseal on cause
//   her        → DM to the server owner only; she can unseal on cause
//   both       → DM to both; either can unseal on cause
//   anonymous  → DM to both, but NO identity is stored — heard, never unmaskable
// Unsealing reveals the author to the entrusted holder (ephemerally) and is recorded on the report.
// For `anonymous`, nothing identifying is ever written to disk (verified). Cooldown is in-memory only.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');
const copy = require('./copy');

const CONFIG_FILE = process.env.FUBU_WHISTLEBLOW_FILE || '/home/ubuntu/.fubu_whistleblow.json';
const STATE_FILE = process.env.FUBU_WHISTLEBLOW_STATE_FILE || '/home/ubuntu/.fubu_whistleblow_state.json';
const COOLDOWN_MS = 60 * 60 * 1000, DAILY_MAX = 4;
const MIN_LEN = 10, MAX_LEN = 1500;

const _cooldown = new Map();   // userId -> ts, in-memory only so `anonymous` leaves no trace
const _daily = new Map();      // userId -> {day,n}, in-memory only (daily cap; no on-disk trace either)

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[whistleblow] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { counter: 0, posts: {} });
const saveState = s => _save(STATE_FILE, s);
function isConfigured() { const c = loadConfig(); return !!(c.you && c.her); }

const CHOICES = { you: 'Head admin only', her: 'Server owner only', both: 'Head admin + owner', anonymous: 'Anonymous: no one can unmask' };
function recipientsFor(choice, c) { return choice === 'you' ? [c.you] : choice === 'her' ? [c.her] : [c.you, c.her]; }
function allowedUnsealers(choice, c) { return choice === 'you' ? [c.you] : choice === 'her' ? [c.her] : choice === 'both' ? [c.you, c.her] : []; }

// ---- setup: store the two entrusted people; tear down any old (insecure) channel ---------------------
async function setup(guild, headAdminId) {
  const c = loadConfig();
  if (c.channelId) {   // migration: remove the old channel-based delivery
    const old = await guild.channels.fetch(c.channelId).catch(() => null);
    if (old) await old.delete('Whistleblow moved to DM delivery (a channel can’t hide from Administrators)').catch(() => {});
  }
  const cfg = { you: headAdminId, her: guild.ownerId };
  saveConfig(cfg);
  return cfg;
}

function reportEmbed(num, text, choice, unsealedBy) {
  const e = new EmbedBuilder().setColor(unsealedBy ? 0xE67E22 : 0x9B59B6).setTitle(`🕊️ Whistleblow #${num}`).setDescription(text)
    .addFields({ name: 'Sender chose', value: CHOICES[choice] || choice, inline: true });
  e.setFooter({ text: choice === 'anonymous'
    ? 'Anonymous. No identity was stored. This can never be unmasked.'
    : 'Sealed. Unseal only on cause (threats / doxxing / targeted harassment). It will be logged.' });
  if (unsealedBy) e.addFields({ name: '🔓 Unsealed by', value: `<@${unsealedBy}>`, inline: true });
  return e;
}
const unsealRow = (num, disabled) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`wb_unseal:${num}`).setEmoji('🔓').setLabel(disabled ? 'Unsealed' : 'Unseal author (on cause)')
    .setStyle(ButtonStyle.Secondary).setDisabled(!!disabled));

// ---- submit -----------------------------------------------------------------------------------------
async function submit(guild, member, text, choice) {
  const c = loadConfig();
  if (!c.you || !c.her) return { ok: false, msg: copy.whistleblow.notSetup };
  if (!CHOICES[choice]) return { ok: false, msg: copy.whistleblow.pickWho };
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (text.length < MIN_LEN) return { ok: false, msg: copy.whistleblow.tooShort(MIN_LEN) };
  if (text.length > MAX_LEN) return { ok: false, msg: copy.whistleblow.tooLong(MAX_LEN) };
  const bad = watchlist.matchTerms(text, watchlist.loadTerms());   // light filter: threats/doxxing only
  if (bad.length) return { ok: false, msg: copy.whistleblow.filtered };
  const last = _cooldown.get(member.id) || 0;
  const waitLeft = COOLDOWN_MS - (Date.now() - last);
  if (last && waitLeft > 0) return { ok: false, msg: copy.common.onCooldown(Math.ceil(waitLeft / 60000)) };
  const day = new Date().toISOString().slice(0, 10);
  const d = _daily.get(member.id);
  if (d && d.day === day && d.n >= DAILY_MAX) return { ok: false, msg: copy.common.dailyLimit(DAILY_MAX) };

  const state = loadState();
  const num = (state.counter || 0) + 1;
  const embed = reportEmbed(num, text, choice);
  const comps = choice === 'anonymous' ? [] : [unsealRow(num, false)];
  const recipients = recipientsFor(choice, c);
  const delivered = [];
  for (const uid of recipients) {
    const m = await guild.members.fetch(uid).catch(() => null);
    if (!m) continue;
    const ok = await m.send({ embeds: [embed], components: comps }).then(() => true).catch(() => false);
    if (ok) delivered.push(uid);
  }
  if (!delivered.length) return { ok: false, msg: copy.whistleblow.deliverFail };
  state.counter = num;
  state.posts[num] = { choice, authorId: choice === 'anonymous' ? null : member.id };   // anonymous → no identity
  saveState(state);
  _cooldown.set(member.id, Date.now());
  _daily.set(member.id, (d && d.day === day) ? { day, n: d.n + 1 } : { day, n: 1 });
  return { ok: true, num, choice, delivered: delivered.length };
}

// ---- unseal (on cause) — button lives in the recipient's DM -----------------------------------------
async function unseal(interaction) {
  const c = loadConfig();
  const num = interaction.customId.split(':')[1];
  const state = loadState();
  const post = state.posts[num];
  if (!post) return interaction.reply({ content: copy.whistleblow.untracked, flags: MessageFlags.Ephemeral });
  if (!post.authorId) return interaction.reply({ content: copy.whistleblow.fullyAnon, flags: MessageFlags.Ephemeral });
  if (!allowedUnsealers(post.choice, c).includes(interaction.user.id))
    return interaction.reply({ content: copy.whistleblow.notAuthorized, flags: MessageFlags.Ephemeral });
  if (post.unsealedBy) return interaction.reply({ content: `Already unsealed (by <@${post.unsealedBy}>). Author: <@${post.authorId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  post.unsealedBy = interaction.user.id;
  saveState(state);
  await interaction.update({ embeds: [reportEmbed(num, interaction.message.embeds[0]?.description || '', post.choice, interaction.user.id)], components: [unsealRow(num, true)] });
  return interaction.followUp({ content: `🔓 Author of Whistleblow #${num}: <@${post.authorId}>. This unseal is recorded.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handleButton(interaction) {
  if (interaction.customId.startsWith('wb_unseal:')) return unseal(interaction);
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, CHOICES, CONFIG_FILE, STATE_FILE };
