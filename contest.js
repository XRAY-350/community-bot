// contest.js — monthly community art contests (Drawing / Photography / Writing) for FUBU.
//
// Designed with the event organizer (superami) in #📋┆organizer-chat, 2026-07-30/31. Her model:
//   • one dedicated channel per contest, under the 🎉 ᴇᴠᴇɴᴛs category
//   • members post ONE entry per theme; everyone can view, post, and vote by reacting 🩷
//   • the channel is for entries + voting ONLY — no chatting
//   • a monthly theme; whoever gets the most 🩷 wins a role (+ the owner may gift Nitro)
//   • anonymous entries allowed (she offered to repost DMs by hand — automated here via /contest-submit)
//
// This module automates all of that:
//   /contest setup   — create the 3 channels + the 🏆 Contest Winner role, post the rules, snapshot perms
//   /contest start   — open a new monthly round with a theme (fresh announcement in each channel)
//   /contest status  — theme, per-channel entry counts, current 🩷 leader
//   /contest end     — tally 🩷, crown winners, assign the role, ping the owner for the Nitro gift
//   /contest-submit  — a member posts an entry ANONYMOUSLY (bot reposts, name hidden)
//   onMessage()      — enforces "entries + voting only": one entry/person, auto-🩷, deletes chatter/dupes
//   register()       — a daily-ish tick that auto-ends the round on the 1st of the month
//
// State lives in one JSON file (self-contained, same pattern as ownerlog/permguard), NOT the shared
// state.js — a contest round is its own concern with its own lifecycle.
const fs = require('fs');
const { EmbedBuilder, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const config = require('./config');
const ownerlog = require('./ownerlog');
const opspanel = require('./opspanel');
const copy = require('./copy');

const P = PermissionsBitField.Flags;
const CFG_FILE = process.env.FUBU_CONTEST_FILE || '/home/ubuntu/.fubu_contest.json';
const VOTE_EMOJI = '🩷';

// Known FUBU ids (env-overridable, same convention as the rest of the bot). Discovered from the live
// server 2026-07-31 by mirroring the sibling event channels' permission model.
const CATEGORY_ID      = process.env.FUBU_EVENTS_CATEGORY_ID || '1532092259963502712'; // 🎉 ᴇᴠᴇɴᴛs
const ORGANIZER_CHAT_ID= process.env.FUBU_ORGANIZER_CHAT_ID  || '1529981479331827722'; // 📋┆organizer-chat
const ORGANIZER_ROLE_ID= process.env.FUBU_EVENT_ORGANIZER_ROLE_ID || '1529976148706984110';
const UNVERIFIED_ROLE_ID = config.unverifiedRoleId || '1500983204293906683';
const CORNER_ROLE_ID   = config.cornerRoleId || '1529459820795789382';
const MOD_ROLE_ID      = opspanel.MOD_ROLE_ID;
const OWNER_ROLE_IDS   = opspanel.OWNER_ROLE_IDS;

// The three contests. `kind` decides what counts as a valid entry:
//   image → the message must carry an image attachment (a text-only post there is chatter)
//   text  → the message body itself is the entry (writing)
const CONTESTS = [
  { key: 'drawing',     label: 'Drawing',     emoji: '🎨', name: '🎨┆drawing-contest',      kind: 'image' },
  { key: 'photography', label: 'Photography', emoji: '📸', name: '📸┆photography-contest',   kind: 'image' },
  { key: 'writing',     label: 'Writing',     emoji: '✍️', name: '✍️┆writing-contest',        kind: 'text'  },
];
const byKey = k => CONTESTS.find(c => c.key === k);
const GOLD = 0xF1C40F;

// ---- persistence ---------------------------------------------------------------------------------
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch { return { channels: {}, winnerRoleId: null, round: null, entries: {}, history: [], lastEndedMonth: null }; }
}
function saveCfg(c) {
  try { const t = CFG_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(c, null, 2)); fs.renameSync(t, CFG_FILE); }
  catch (e) { console.error('[contest] save:', e.message); }
}

const ymKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthName = (d = new Date()) => d.toLocaleString('en-US', { month: 'long', year: 'numeric' });

// contest key for a given channel id (or null if it isn't a contest channel)
function contestKeyForChannel(channelId) {
  const c = loadCfg();
  for (const k of Object.keys(c.channels || {})) if (c.channels[k] === channelId) return k;
  return null;
}
function isContestChannel(channelId) { return !!contestKeyForChannel(channelId); }

// ---- permissions ---------------------------------------------------------------------------------
// Mirrors the sibling event channels: verified members see + post + react; unverified and The Corner
// are locked out; organizers/mods get management bits. Everyone is denied threads + @everyone pings so
// the channel stays a clean stream of entries.
function channelOverwrites(guild) {
  const ow = [
    { id: guild.id, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks, P.AddReactions],
      deny: [P.MentionEveryone, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads] },
    { id: ORGANIZER_ROLE_ID, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.ManageMessages] },
    { id: MOD_ROLE_ID, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.ManageMessages] },
  ];
  if (UNVERIFIED_ROLE_ID) ow.push({ id: UNVERIFIED_ROLE_ID, deny: [P.ViewChannel] });
  if (CORNER_ROLE_ID) ow.push({ id: CORNER_ROLE_ID, deny: [P.ViewChannel, P.SendMessages] });
  return ow;
}

// ---- setup ---------------------------------------------------------------------------------------
async function ensureWinnerRole(guild, cfg) {
  if (cfg.winnerRoleId) {
    const ex = await guild.roles.fetch(cfg.winnerRoleId).catch(() => null);
    if (ex) return ex;
  }
  const role = await guild.roles.create({
    name: '🏆 Contest Winner', color: GOLD, hoist: true, mentionable: false,
    permissions: [], reason: 'Monthly contest winner badge (event organizer request)',
  });
  cfg.winnerRoleId = role.id;
  return role;
}

async function ensureChannel(guild, contest, cfg) {
  // 1) stored id still valid?
  const stored = cfg.channels[contest.key];
  if (stored) { const ex = await guild.channels.fetch(stored).catch(() => null); if (ex) return ex; }
  // 2) an existing channel by name under the events category (recover a lost config)?
  const all = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const found = all.find(c => c.parentId === CATEGORY_ID && c.name === contest.name);
  if (found) { cfg.channels[contest.key] = found.id; return found; }
  // 3) create it
  const ch = await guild.channels.create({
    name: contest.name, type: ChannelType.GuildText, parent: CATEGORY_ID,
    topic: `${contest.emoji} Monthly ${contest.label.toLowerCase()} contest. Post ONE entry, vote with ${VOTE_EMOJI}. No chatting here.`,
    permissionOverwrites: channelOverwrites(guild),
    reason: 'Monthly contest channel (event organizer request)',
  });
  cfg.channels[contest.key] = ch.id;
  return ch;
}

function rulesEmbed(contest, theme) {
  const lines = [
    'The rules are simple ⋆｡˚',
    '',
    `✧ **One entry per person.** You have all month to post and to vote.`,
    `✧ **Your own work only. No AI.** AI-generated art, photos, or writing aren't allowed. Keep it human. 🤝`,
    `✧ **Don't chat here.** This channel is only for posting entries and voting.`,
    `✧ **To vote, react with ${VOTE_EMOJI}** on your favourite entry.`,
    `✧ Want to enter **anonymously**? Use \`/contest-submit\` and I'll post it for you, name hidden.`,
    '✧ Have fun! 🩷',
  ];
  const e = new EmbedBuilder().setColor(GOLD)
    .setTitle(`${contest.emoji} ${contest.label} Contest`)
    .setDescription(lines.join('\n'));
  if (theme) e.addFields({ name: '✧ This month\'s theme', value: `**${theme}**` });
  else e.addFields({ name: '✧ Theme', value: '_The theme will be announced when the round opens._' });
  e.setFooter({ text: 'FUBU monthly contests' });
  return e;
}

async function postRules(channel, contest, theme) {
  const msg = await channel.send({ embeds: [rulesEmbed(contest, theme)], allowedMentions: { parse: [] } });
  try { await msg.pin(); } catch { /* pin is best-effort */ }
  return msg;
}

async function setup(guild) {
  const cfg = loadCfg();
  const role = await ensureWinnerRole(guild, cfg);
  const made = [];
  for (const contest of CONTESTS) {
    const before = cfg.channels[contest.key];
    const ch = await ensureChannel(guild, contest, cfg);
    made.push({ contest, ch, created: !before || before !== ch.id });
  }
  // Post the rules now only if there's no active round — an open round's announcement is owned by
  // /contest start (re-posting here would just duplicate it).
  const roundActive = !!(cfg.round && cfg.round.active);
  if (!roundActive) for (const m of made) await postRules(m.ch, m.contest, null);
  saveCfg(cfg);
  // NOTE: we deliberately do NOT auto-resnapshot permguard here. New channels are "unmanaged" by the
  // drift guard (it leaves them alone — no reversion risk), and re-baselining the WHOLE server's
  // permission manifest as a side effect of contest setup would be too broad. To bring these channels
  // under the drift guard, the owner runs `/permguard resnapshot` deliberately (surfaced in the reply).
  await ownerlog.log(guild, { emoji: '🎨', title: 'Contest system set up', color: GOLD,
    detail: `Channels: ${made.map(m => `<#${m.ch.id}>`).join(' ')}\nWinner role: <@&${role.id}>` });
  return { channels: made, role };
}

// ---- start a round -------------------------------------------------------------------------------
async function start(guild, theme, keys) {
  const cfg = loadCfg();
  if (!Object.keys(cfg.channels || {}).length) throw new Error('Run `/contest setup` first. No contest channels exist yet.');
  const active = (keys && keys.length ? keys : CONTESTS.map(c => c.key)).filter(k => cfg.channels[k]);
  const prevAnnounce = (cfg.round && cfg.round.announce) || {};   // unpin last month's card so pins don't stack
  cfg.round = { theme, startedAt: Date.now(), month: ymKey(), active: true, contests: active, announce: {} };
  cfg.entries = {};                              // fresh round - clear last month's entries
  for (const k of active) {
    const ch = await guild.channels.fetch(cfg.channels[k]).catch(() => null);
    if (!ch) continue;
    if (prevAnnounce[k]) { const old = await ch.messages.fetch(prevAnnounce[k]).catch(() => null); if (old && old.pinned) await old.unpin().catch(() => {}); }
    cfg.entries[cfg.channels[k]] = {};
    const msg = await postRules(ch, byKey(k), theme);
    cfg.round.announce[k] = msg.id;
  }
  saveCfg(cfg);
  await ownerlog.log(guild, { emoji: '🎨', title: 'Contest round opened', color: GOLD,
    detail: `Theme: **${theme}**\nContests: ${active.map(k => byKey(k).label).join(', ')}` });
  return { active, theme };
}

// ---- vote counting -------------------------------------------------------------------------------
// Count the real (non-bot) 🩷 reactors on an entry message. Fetches the message fresh so the count is
// live, not whatever happened to be cached.
async function countVotes(channel, messageId) {
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return { votes: 0, gone: true };
  const rx = msg.reactions.cache.find(r => (r.emoji.name === VOTE_EMOJI));
  if (!rx) return { votes: 0, gone: false };
  const users = await rx.users.fetch().catch(() => null);
  const votes = users ? users.filter(u => !u.bot).size : Math.max(0, rx.count - 1);
  return { votes, gone: false };
}

// Tally one contest channel → sorted [{ memberId, messageId, anonymous, votes }] desc.
async function tallyChannel(guild, key, cfg) {
  const channelId = cfg.channels[key];
  const ch = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  const entries = (cfg.entries && cfg.entries[channelId]) || {};
  const out = [];
  if (!ch) return out;
  for (const [memberId, e] of Object.entries(entries)) {
    const { votes } = await countVotes(ch, e.messageId);
    out.push({ memberId, messageId: e.messageId, anonymous: !!e.anonymous, votes });
  }
  out.sort((a, b) => b.votes - a.votes || String(a.messageId).localeCompare(String(b.messageId)));
  return out;
}

// ---- status --------------------------------------------------------------------------------------
async function status(guild) {
  const cfg = loadCfg();
  const e = new EmbedBuilder().setColor(GOLD).setTitle('🎨 Contest status');
  if (!cfg.round || !cfg.round.active) {
    e.setDescription('No round is currently open. Use `/contest start` to open one.');
    if (cfg.lastEndedMonth) e.setFooter({ text: `Last round ended: ${cfg.lastEndedMonth}` });
    return e;
  }
  e.setDescription(`**Theme:** ${cfg.round.theme}\n**Opened:** <t:${Math.floor(cfg.round.startedAt / 1000)}:R>`);
  for (const key of cfg.round.contests) {
    const ranked = await tallyChannel(guild, key, cfg);
    const c = byKey(key);
    const leader = ranked[0];
    const leaderTxt = leader
      ? `${leader.votes} ${VOTE_EMOJI} · ${leader.anonymous ? '_anonymous_' : `<@${leader.memberId}>`}`
      : '_no entries yet_';
    e.addFields({ name: `${c.emoji} ${c.label}: ${ranked.length} entr${ranked.length === 1 ? 'y' : 'ies'}`, value: `Leader: ${leaderTxt}` });
  }
  return e;
}

// ---- end a round: crown winners ------------------------------------------------------------------
async function endRound(guild, { auto = false } = {}) {
  const cfg = loadCfg();
  if (!cfg.round || !cfg.round.active) return { ok: false, msg: copy.contest.noOpenRound };
  const role = cfg.winnerRoleId ? await guild.roles.fetch(cfg.winnerRoleId).catch(() => null) : null;
  const theme = cfg.round.theme;
  const monthLabel = cfg.round.month || ymKey();
  const results = {};
  const winnerMentions = [];

  for (const key of cfg.round.contests) {
    const ranked = await tallyChannel(guild, key, cfg);
    const c = byKey(key);
    const channelId = cfg.channels[key];
    const ch = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
    if (!ch) continue;
    const top = ranked[0];
    if (!top || top.votes === 0) {
      results[key] = null;
      await ch.send({ embeds: [new EmbedBuilder().setColor(GOLD)
        .setTitle(`${c.emoji} ${c.label} Contest: closed`)
        .setDescription(`This round's theme was **${theme}**.\nNo votes were cast this time. See you next month! 🩷`)], allowedMentions: { parse: [] } }).catch(() => {});
      continue;
    }
    // ties: everyone sharing the top vote count wins
    const winners = ranked.filter(r => r.votes === top.votes);
    results[key] = { theme, winners, votes: top.votes };
    // assign the badge role
    if (role) for (const w of winners) {
      const mem = await guild.members.fetch(w.memberId).catch(() => null);
      if (mem && !mem.roles.cache.has(role.id)) await mem.roles.add(role.id, `Won the ${c.label} contest (${monthLabel})`).catch(() => {});
    }
    const nameList = winners.map(w => w.anonymous ? '**an anonymous entry**' : `<@${w.memberId}>`).join(' & ');
    winners.forEach(w => { if (!w.anonymous) winnerMentions.push(w.memberId); });
    // link to the winning entry
    const link = `https://discord.com/channels/${guild.id}/${channelId}/${winners[0].messageId}`;
    await ch.send({
      embeds: [new EmbedBuilder().setColor(GOLD)
        .setTitle(`${c.emoji} ${c.label} Contest winner!`)
        .setDescription(`Theme: **${theme}**\n\n🏆 ${nameList} won with **${top.votes}** ${VOTE_EMOJI}!\n[See the winning entry](${link})\n\nThank you everyone who entered and voted. A new theme is on the way. 🩷`)],
      allowedMentions: { users: winners.filter(w => !w.anonymous).map(w => w.memberId) },
    }).catch(() => {});
  }

  // close the round
  cfg.round.active = false;
  cfg.lastEndedMonth = ymKey();
  cfg.history = cfg.history || [];
  cfg.history.push({ month: monthLabel, theme, endedAt: Date.now(), results: Object.fromEntries(
    Object.entries(results).map(([k, v]) => [k, v ? { votes: v.votes, winners: v.winners.map(w => ({ memberId: w.memberId, anonymous: w.anonymous })) } : null]) ) });
  saveCfg(cfg);

  // organizer-chat summary + Nitro reminder to the owner
  const org = await guild.channels.fetch(ORGANIZER_CHAT_ID).catch(() => null);
  if (org) {
    const summary = cfg.round.contests.map(key => {
      const r = results[key]; const c = byKey(key);
      if (!r) return `${c.emoji} **${c.label}**: no winner (no votes)`;
      const who = r.winners.map(w => w.anonymous ? `an anonymous entry _(real: <@${w.memberId}>)_` : `<@${w.memberId}>`).join(' & ');
      return `${c.emoji} **${c.label}**: ${who} · ${r.votes} ${VOTE_EMOJI}`;
    }).join('\n');
    const anyWinner = Object.values(results).some(Boolean);
    const embed = new EmbedBuilder().setColor(GOLD)
      .setTitle(`🏁 ${monthName()} contest results${auto ? ' (auto-closed)' : ''}`)
      .setDescription(`Theme: **${theme}**\n\n${summary}`);
    if (anyWinner) embed.addFields({ name: '🎁 Nitro reminder',
      value: `The 🏆 Contest Winner role is assigned. If you're gifting **Nitro**, send it to the winner(s) above. I can't gift it for you.` });
    embed.addFields({ name: '▶️ Next month', value: 'Open the next round with `/contest start theme:<your theme>` whenever you\'re ready.' });
    // ping the owner tier so they see the Nitro reminder
    const pingRoles = anyWinner ? OWNER_ROLE_IDS : [];
    await org.send({ content: pingRoles.length ? pingRoles.map(r => `<@&${r}>`).join(' ') : undefined,
      embeds: [embed], allowedMentions: { roles: pingRoles } }).catch(() => {});
  }
  await ownerlog.log(guild, { emoji: '🏁', title: `Contest round ended${auto ? ' (auto)' : ''}`, color: GOLD,
    detail: `Theme: **${theme}**\n` + cfg.round.contests.map(key => {
      const r = results[key]; const c = byKey(key);
      return r ? `${c.label}: ${r.winners.length} winner(s), ${r.votes} ${VOTE_EMOJI}` : `${c.label}: no winner`;
    }).join('\n') });
  return { ok: true, results };
}

// ---- entry tracking on plain messages ------------------------------------------------------------
const hasImage = msg => [...msg.attachments.values()].some(a =>
  (a.contentType && a.contentType.startsWith('image/')) || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(a.name || ''));

function memberIsStaff(member) {
  if (!member) return false;
  const tier = opspanel.memberTier(member);            // owner/admin/mod
  return !!tier || member.roles.cache.has(ORGANIZER_ROLE_ID);
}

async function notify(user, text) { try { await user.send(text); } catch { /* DMs closed - the delete is signal enough */ } }

// Returns { deleted: bool } so the caller can stop processing a message it removed.
async function onMessage(msg) {
  try {
    if (msg.author?.bot || !msg.guild) return { deleted: false };
    const key = contestKeyForChannel(msg.channelId);
    if (!key) return { deleted: false };
    const cfg = loadCfg();
    if (!cfg.round || !cfg.round.active || !(cfg.round.contests || []).includes(key)) {
      return { deleted: false };                          // no open round → don't police the channel
    }
    const contest = byKey(key);
    const member = msg.member || await msg.guild.members.fetch(msg.author.id).catch(() => null);
    const staff = memberIsStaff(member);
    const entries = (cfg.entries[msg.channelId] = cfg.entries[msg.channelId] || {});

    // Is this a valid entry for this contest kind?
    const valid = contest.kind === 'image' ? hasImage(msg) : ((msg.content && msg.content.trim().length >= 3) || msg.attachments.size > 0);

    if (!valid) {
      if (staff) return { deleted: false };               // trust staff (announcements, moderation)
      await msg.delete().catch(() => {});
      await notify(msg.author, `Your message in **${contest.label} Contest** was removed. That channel is only for posting entries and voting 🩷. ${contest.kind === 'image' ? 'Please post your entry as an image.' : 'Please post your written entry.'} For chatting, use the event chat!`);
      return { deleted: true };
    }
    // valid entry — enforce one per person
    if (entries[msg.author.id]) {
      if (staff) return { deleted: false };
      await msg.delete().catch(() => {});
      await notify(msg.author, `You've already entered the **${contest.label} Contest** this month. One entry per theme 🩷. Your first entry still stands; ask a mod if you'd like to swap it.`);
      return { deleted: true };
    }
    entries[msg.author.id] = { messageId: msg.id, anonymous: false, at: Date.now() };
    saveCfg(cfg);
    try { await msg.react(VOTE_EMOJI); } catch { /* seed the vote reaction; non-fatal */ }
    return { deleted: false };
  } catch (e) { console.error('[contest] onMessage:', e.message); return { deleted: false }; }
}

// Keep the entry map honest: if an entry message is deleted (by its author or a mod), free that member
// to submit again.
async function onMessageDelete(msg) {
  try {
    const cfg = loadCfg();
    const entries = cfg.entries && cfg.entries[msg.channelId];
    if (!entries) return;
    const memberId = Object.keys(entries).find(id => entries[id].messageId === msg.id);
    if (memberId) { delete entries[memberId]; saveCfg(cfg); }
  } catch (e) { console.error('[contest] onMessageDelete:', e.message); }
}

// ---- anonymous submission (/contest-submit) ------------------------------------------------------
async function submit(interaction) {
  const cfg = loadCfg();
  if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
    return interaction.reply({ content: copy.contest.needVerified, flags: 1 << 6 });
  if (!cfg.round || !cfg.round.active) return interaction.reply({ content: copy.contest.noRoundNow, flags: 1 << 6 });
  const key = interaction.options.getString('contest');
  const contest = byKey(key);
  if (!contest || !cfg.round.contests.includes(key)) return interaction.reply({ content: copy.contest.notRunning, flags: 1 << 6 });
  const channelId = cfg.channels[key];
  const ch = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
  if (!ch) return interaction.reply({ content: copy.contest.channelMissing, flags: 1 << 6 });

  const entries = (cfg.entries[channelId] = cfg.entries[channelId] || {});
  if (entries[interaction.user.id]) return interaction.reply({ content: copy.contest.alreadyEntered(contest.label), flags: 1 << 6 });

  const image = interaction.options.getAttachment('image');
  const text = interaction.options.getString('text');
  if (contest.kind === 'image' && !image) return interaction.reply({ content: copy.contest.needImage(contest.label), flags: 1 << 6 });
  if (contest.kind === 'text' && !text && !image) return interaction.reply({ content: copy.contest.needWriting(contest.label), flags: 1 << 6 });
  if (image && !((image.contentType && image.contentType.startsWith('image/')) || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(image.name || '')))
    return interaction.reply({ content: copy.contest.notImage, flags: 1 << 6 });

  await interaction.deferReply({ flags: 1 << 6 });
  const embed = new EmbedBuilder().setColor(GOLD)
    .setAuthor({ name: `Anonymous ${contest.label} entry` })
    .setFooter({ text: `${cfg.round.theme} · vote with ${VOTE_EMOJI}` });
  if (text) embed.setDescription(text.slice(0, 4000));
  if (image) embed.setImage(`attachment://${(image.name || 'entry').replace(/[^\w.\-]/g, '_')}`);
  const files = image ? [{ attachment: image.url, name: (image.name || 'entry').replace(/[^\w.\-]/g, '_') }] : [];
  const posted = await ch.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(e => { console.error('[contest] submit send:', e.message); return null; });
  if (!posted) return interaction.editReply(copy.contest.postFailed);
  try { await posted.react(VOTE_EMOJI); } catch { /* non-fatal */ }
  entries[interaction.user.id] = { messageId: posted.id, anonymous: true, at: Date.now() };
  saveCfg(cfg);
  return interaction.editReply(copy.contest.posted(contest.label, channelId));
}

// ---- monthly auto-close tick ---------------------------------------------------------------------
function register(client) {
  const tick = async () => {
    try {
      const cfg = loadCfg();
      if (!cfg.round || !cfg.round.active) return;
      const now = new Date();
      if (now.getDate() !== 1) return;                    // only crown on the 1st
      if (cfg.lastEndedMonth === ymKey(now)) return;      // already ended this month
      const guild = client.guilds.cache.first() || await client.guilds.fetch(config.guildId).catch(() => null);
      if (!guild) return;
      console.log('[contest] month rolled over — auto-ending the open round');
      await endRound(guild, { auto: true });
    } catch (e) { console.error('[contest] tick:', e.message); }
  };
  setTimeout(tick, 90 * 1000);
  setInterval(tick, 6 * 60 * 60 * 1000);                  // every 6h catches the 1st regardless of boot time
  console.log('[contest] monthly auto-close tick armed');
}

// ---- event organizer dashboard (private, ephemeral /panel-style) ---------------------------------
// A per-caller ephemeral control panel — same idea as the mod /panel, scoped to contests. Anyone with
// the Event Organizer role (or staff) can open it. Ephemeral = private + no shared pinned message to
// maintain, so each refresh just re-renders the caller's own message.
const EPH = 1 << 6;   // MessageFlags.Ephemeral, without importing the enum here
function canManageEvents(interaction) {
  return !!(interaction.memberPermissions?.has(P.ManageEvents)
    || opspanel.memberTier(interaction.member)
    || interaction.member?.roles?.cache?.has(ORGANIZER_ROLE_ID));
}
function isEventOrganizer(member) {
  return !!(member?.roles?.cache?.has(ORGANIZER_ROLE_ID) || opspanel.memberTier(member));
}

// Fast panel: entry COUNTS come straight from state (no vote fetch), so refresh is instant. Live 🩷
// standings are one click away on the "📊 Standings" button (which does the real tally).
async function buildEventPanel(guild) {
  const cfg = loadCfg();
  const setUp = CONTESTS.every(c => cfg.channels[c.key]);
  const e = new EmbedBuilder().setColor(GOLD).setTitle('🎉 Event Organizer Dashboard');
  if (!setUp) {
    e.setDescription('The contest channels aren\'t created yet.\nPress **🎨 Setup** to create them + the 🏆 winner role.');
  } else if (cfg.round && cfg.round.active) {
    const lines = cfg.round.contests.map(k => {
      const c = byKey(k); const n = Object.keys((cfg.entries || {})[cfg.channels[k]] || {}).length;
      return `${c.emoji} **${c.label}**: ${n} entr${n === 1 ? 'y' : 'ies'} · <#${cfg.channels[k]}>`;
    }).join('\n');
    e.setDescription(`**Open round** · theme: **${cfg.round.theme}**\nOpened <t:${Math.floor(cfg.round.startedAt / 1000)}:R>\n\n${lines}\n\n_Press 📊 Standings for live 🩷 counts._`);
  } else {
    e.setDescription('No round is open right now.\nPress **▶️ Start round** to open one with a theme.' +
      (cfg.lastEndedMonth ? `\n\n_Last round ended: ${cfg.lastEndedMonth}._` : ''));
  }
  const active = !!(cfg.round && cfg.round.active);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('evp_start').setEmoji('▶️').setLabel('Start round').setStyle(ButtonStyle.Success).setDisabled(active || !setUp),
    new ButtonBuilder().setCustomId('evp_end').setEmoji('🏁').setLabel('End round').setStyle(ButtonStyle.Danger).setDisabled(!active));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('evp_status').setEmoji('📊').setLabel('Standings').setStyle(ButtonStyle.Primary).setDisabled(!active),
    new ButtonBuilder().setCustomId('evp_refresh').setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('evp_setup').setEmoji('🎨').setLabel(setUp ? 'Repair setup' : 'Setup').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row1, row2] };
}

async function openEventPanel(interaction) {
  if (!canManageEvents(interaction)) return interaction.reply({ content: copy.contest.organizersOnly, flags: EPH });
  return interaction.reply({ ...(await buildEventPanel(interaction.guild)), flags: EPH });
}

function isEventPanelInteraction(i) {
  return (i.isButton?.() || i.isModalSubmit?.()) && i.customId?.startsWith('evp_');
}

async function handleEventPanel(interaction) {
  if (!canManageEvents(interaction)) return interaction.reply({ content: copy.contest.organizersOnly, flags: EPH });
  const id = interaction.customId;
  const guild = interaction.guild;

  if (id === 'evp_refresh') return interaction.update(await buildEventPanel(guild));

  if (id === 'evp_status') {
    const embed = await status(guild);
    return interaction.reply({ embeds: [embed], flags: EPH });
  }

  if (id === 'evp_setup') {
    await interaction.deferUpdate();
    try { await setup(guild); } catch (e) { console.error('[contest] evp_setup:', e.message); }
    await interaction.editReply(await buildEventPanel(guild));
    return interaction.followUp({ content: '✅ Channels + 🏆 winner role are ready. Tip: run `/permguard resnapshot` to bring the new channels under the drift-guard.', flags: EPH }).catch(() => {});
  }

  if (id === 'evp_start') {
    const modal = new ModalBuilder().setCustomId('evp_start_modal').setTitle('Open a new contest round');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('theme').setLabel('This month\'s theme').setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. summer vacations').setRequired(true).setMaxLength(120)));
    return interaction.showModal(modal);
  }
  if (id === 'evp_start_modal') {
    const theme = interaction.fields.getTextInputValue('theme').trim();
    await interaction.deferUpdate();
    try { await start(guild, theme, null); }   // all three contests from the dashboard fast-path
    catch (e) { return interaction.followUp({ content: `⚠️ ${e.message}`, flags: EPH }).catch(() => {}); }
    await interaction.editReply(await buildEventPanel(guild));
    return interaction.followUp({ content: `✅ Opened the **${theme}** round for all three contests. Announcements posted + pinned.`, flags: EPH }).catch(() => {});
  }

  if (id === 'evp_end') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('evp_end_yes').setEmoji('🏁').setLabel('Yes, end + crown winners').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('evp_end_no').setEmoji('↩️').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    return interaction.update({ embeds: [new EmbedBuilder().setColor(GOLD).setTitle('End the round?')
      .setDescription('This tallies 🩷, crowns the winner(s), assigns the 🏆 role, and posts results to <#' + ORGANIZER_CHAT_ID + '>. This can\'t be undone.')], components: [row] });
  }
  if (id === 'evp_end_no') return interaction.update(await buildEventPanel(guild));
  if (id === 'evp_end_yes') {
    await interaction.deferUpdate();
    let r; try { r = await endRound(guild); } catch (e) { r = { ok: false, msg: e.message }; }
    await interaction.editReply(await buildEventPanel(guild));
    if (!r.ok) return interaction.followUp({ content: `⚠️ ${r.msg}`, flags: EPH }).catch(() => {});
    return interaction.followUp({ content: '🏁 Round closed. Winners crowned, role assigned, results posted to <#' + ORGANIZER_CHAT_ID + '>.', flags: EPH }).catch(() => {});
  }
}

module.exports = {
  CONTESTS, VOTE_EMOJI, isContestChannel, contestKeyForChannel,
  setup, start, status, endRound, submit, onMessage, onMessageDelete, register, loadCfg,
  openEventPanel, isEventPanelInteraction, handleEventPanel, isEventOrganizer, buildEventPanel, rulesEmbed,
};
