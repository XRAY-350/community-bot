// giveaway.js — timed, button-entry giveaways. An admin runs /giveaway start with a prize, a duration,
// and a winner count; the bot posts an embed with an "Enter" button. Members click to join; entry is
// checked LIVE against two always-on requirements (owner, 2026-08-23):
//   1) must hold the Verified role, and
//   2) must have joined the server BEFORE this giveaway started (so their time in the server is at least
//      the giveaway's open window — kills the "join an alt just to enter" case).
// When the window closes a sweep draws N random winners from the still-eligible entrants and announces
// them; /giveaway reroll draws again, /giveaway end closes one early. State is persisted so a restart
// resumes the timer and never loses entrants.
const fs = require('fs');
const { statePath } = require('./statepath');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const config = require('./config');

const FILE = process.env.FUBU_GIVEAWAYS_FILE || statePath('giveaways.json');
const EMOJI = '🎀';

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(d) { try { fs.writeFileSync(FILE, JSON.stringify(d)); } catch (e) { console.error('[giveaway] save:', e.message); } }
function get(id) { return load()[id] || null; }
function activeList() { return Object.values(load()).filter(g => g && !g.ended); }

// Re-load-mutate-save so concurrent Enter clicks don't clobber each other's entrant additions.
function addEntrant(messageId, userId) {
  const d = load(); const g = d[messageId];
  if (!g || g.ended) return null;
  if (!g.entrants.includes(userId)) g.entrants.push(userId);
  save(d); return g;
}
function removeEntrant(messageId, userId) {
  const d = load(); const g = d[messageId];
  if (!g) return null;
  g.entrants = (g.entrants || []).filter(i => i !== userId);
  save(d); return g;
}

function randInt(n) { return Math.floor(Math.random() * n); }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Compact human duration, e.g. 90000000 -> "1d 1h". Used to tell entrants how long they had to be here.
function humanDur(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(`${d}d`); if (h) parts.push(`${h}h`); if (m) parts.push(`${m}m`); if (s && !d && !h) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}
function durationOf(g) { return Math.max(0, (g.endsAt || 0) - (g.createdAt || 0)); }

// The two always-on gates. Returns null if eligible, else a short human reason. `member` must be a full
// GuildMember (has joinedTimestamp + roles). Re-checked at draw time too, so someone who leaves or loses
// Verified after entering is dropped.
function ineligibleReason(member, g) {
  if (!member) return 'you are no longer in the server';
  if (config.verifiedRoleId && !member.roles.cache.has(config.verifiedRoleId)) return 'you must be **Verified** to enter';
  // Tenure AT THE START must be at least the giveaway's whole length (owner: for a 24h giveaway you had to
  // have joined 24h before it started, not merely before it started). So joined <= start - duration.
  const dur = durationOf(g);
  if ((member.joinedTimestamp || Infinity) > g.createdAt - dur)
    return `you must have been in the server at least **${humanDur(dur)}** (the giveaway’s length) before it started`;
  return null;
}

function embedFor(g) {
  const endsSec = Math.floor(g.endsAt / 1000);
  const lines = [
    `Click **${EMOJI} Enter** below to join.`,
    g.ended ? `Ended <t:${endsSec}:R>` : `Ends: <t:${endsSec}:R>  (<t:${endsSec}:t>)`,
    `Hosted by: <@${g.hostId}>`,
    `Winners: **${g.winners}**`,
    `To win: must be **Verified** · in the server for **${humanDur(durationOf(g))}+** before this started`,
  ];
  if (g.note) lines.push(`\n> ${String(g.note).slice(0, 500)}`);
  if (g.ended) {
    lines.push('');
    lines.push((g.winnerIds && g.winnerIds.length)
      ? `🎉 Winner${g.winnerIds.length > 1 ? 's' : ''}: ${g.winnerIds.map(id => `<@${id}>`).join(', ')}`
      : '_No valid entries — no winner drawn._');
  }
  return new EmbedBuilder()
    .setColor(g.ended ? 0x2b2d31 : 0xEB459E)
    .setTitle(`${EMOJI} ${g.ended ? '[ENDED] ' : ''}${g.prize}`.slice(0, 256))
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${(g.entrants || []).length} entered` })
    .setTimestamp(new Date(g.endsAt));
}

function rowFor(g) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gw_enter:${g.messageId}`).setEmoji(EMOJI).setLabel('Enter').setStyle(ButtonStyle.Success).setDisabled(!!g.ended),
    new ButtonBuilder().setCustomId('gw_count_noop').setLabel(`${(g.entrants || []).length} entered`).setStyle(ButtonStyle.Secondary).setDisabled(true));
}

// Post a new giveaway into `channel` — always the dedicated giveaways channel now (owner, 2026-08-26:
// "remove the channel option ... they should never be in the giveaway channel" — kept the param instead of
// hardcoding the channel HERE so the caller still owns fetching/validating it; index.js no longer offers a
// picker). `pingRoleId` (the EVENT ping role, per the owner's same message) is pinged in the message
// CONTENT, not the embed — pings don't fire from inside embeds.
async function start(channel, { prize, durationMs, winners, hostId, note, pingRoleId = null }) {
  const g = {
    messageId: 'pending', channelId: channel.id, guildId: channel.guild.id,
    prize: String(prize).slice(0, 240), hostId, winners: Math.max(1, winners || 1), note: note || null,
    entrants: [], createdAt: Date.now(), endsAt: Date.now() + durationMs, ended: false, winnerIds: [],
  };
  const content = pingRoleId ? `<@&${pingRoleId}>` : undefined;
  // Post first to get the message id, then bake it into the button + save.
  const msg = await channel.send({ content, embeds: [embedFor(g)], components: [rowFor({ ...g, messageId: '0' })],
    allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] } });
  g.messageId = msg.id;
  await msg.edit({ content, embeds: [embedFor(g)], components: [rowFor(g)] });
  const d = load(); d[g.messageId] = g; save(d);
  return { ok: true, message: msg, giveaway: g };
}

// Enter button. Toggles: first click enters (if eligible), a second click leaves. Always answers the
// clicker ephemerally, and edits the public message so the "N entered" counter stays live.
async function handleEnter(interaction) {
  const messageId = interaction.customId.split(':')[1];
  const g = get(messageId);
  if (!g) return interaction.reply({ content: 'That giveaway no longer exists.', flags: MessageFlags.Ephemeral });
  if (g.ended) return interaction.reply({ content: 'That giveaway has already ended.', flags: MessageFlags.Ephemeral });
  const member = interaction.member;
  if ((g.entrants || []).includes(member.id)) {
    const ng = removeEntrant(messageId, member.id) || g;
    await interaction.message.edit({ embeds: [embedFor(ng)], components: [rowFor(ng)] }).catch(() => {});
    return interaction.reply({ content: `You’ve left the giveaway. Changed your mind? Click ${EMOJI} Enter again.`, flags: MessageFlags.Ephemeral });
  }
  const reason = ineligibleReason(member, g);
  if (reason) return interaction.reply({ content: `You can’t enter — ${reason}.`, flags: MessageFlags.Ephemeral });
  const ng = addEntrant(messageId, member.id) || g;
  await interaction.message.edit({ embeds: [embedFor(ng)], components: [rowFor(ng)] }).catch(() => {});
  return interaction.reply({ content: `You’re in! ${EMOJI} Good luck. (Click Enter again to leave.)`, flags: MessageFlags.Ephemeral });
}

// Draw winners for one giveaway. reroll=true re-draws from entrants NOT already won, on an ended one.
// Returns { ok, winners, msg }.
async function draw(client, messageId, { reroll = false } = {}) {
  const d = load(); const g = d[messageId];
  if (!g) return { ok: false, msg: 'No giveaway found for that message.' };
  if (reroll && !g.ended) return { ok: false, msg: 'That giveaway hasn’t ended yet — use `/giveaway end` first.' };
  if (!reroll && g.ended) return { ok: false, msg: 'That giveaway already ended. Use `/giveaway reroll` to draw again.' };
  // Mark ended FIRST (audit A27): the per-entrant fetch loop below is O(entrants) API calls — a
  // 100-entrant giveaway could outlast the 60s sweep tick, and the next tick saw ended:false and drew a
  // SECOND, different winner set. Marking up front makes the sweep's next tick skip it; a crash mid-draw
  // is recovered with /giveaway reroll.
  if (!reroll) { g.ended = true; d[messageId] = g; save(d); }
  const guild = await client.guilds.fetch(g.guildId).catch(() => null);
  if (!guild) return { ok: false, msg: 'Could not reach the server.' };
  const exclude = reroll ? new Set(g.winnerIds || []) : new Set();
  const eligible = [];
  for (const id of (g.entrants || [])) {
    if (exclude.has(id)) continue;
    const m = await guild.members.fetch(id).catch(() => null);
    if (m && !ineligibleReason(m, g)) eligible.push(id);
  }
  const winners = shuffle(eligible).slice(0, g.winners);
  g.ended = true;
  g.winnerIds = winners;                 // latest draw is what the embed shows
  d[messageId] = g; save(d);
  // Update the original message + announce in-channel.
  const channel = await guild.channels.fetch(g.channelId).catch(() => null);
  if (channel) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [embedFor(g)], components: [rowFor(g)] }).catch(() => {});
    const text = winners.length
      ? `${EMOJI} **${reroll ? 'Reroll' : 'Giveaway ended'}!** Congratulations ${winners.map(id => `<@${id}>`).join(', ')} — you won **${g.prize}**!`
        + `${g.note ? `\n-# ${String(g.note).slice(0, 300)}` : ''}\n-# Hosted by <@${g.hostId}>.`
      : `${EMOJI} **${reroll ? 'Reroll' : 'Giveaway ended'}** — no valid entries, so no winner. (Entrants must be Verified and have been in the server at least ${humanDur(durationOf(g))} before it started.)`;
    await channel.send({
      content: text,
      reply: msg ? { messageReference: messageId, failIfNotExists: false } : undefined,
      allowedMentions: { users: [...winners, g.hostId] },
    }).catch(() => {});
  }
  return { ok: true, winners, msg: winners.length ? `Drew ${winners.length} winner(s).` : 'No eligible entries — no winner.' };
}

// Any giveaway whose window has closed gets drawn. Runs on a timer + boot catch-up.
async function sweep(client) {
  for (const g of activeList()) {
    if (g.endsAt <= Date.now()) await draw(client, g.messageId, {}).catch(e => console.error('[giveaway] draw:', e.message));
  }
}

module.exports = { start, handleEnter, draw, sweep, get, activeList, EMOJI };
