// amongus.js — "Among Us mode" for voice channels. Staff start a game for the VC they're in; a control
// panel then toggles mute PHASES that anyone in that VC can drive:
//   • Lobby      — everyone unmuted (game start / between games; the "everyone can talk" state)
//   • Play       — everyone in the VC server-muted (host included — they're playing too)
//   • Discussion — ALIVE unmuted, DEAD stay muted (dead picked via a multi-select of VC members)
// Marking dead resets on New Round. Ending unmutes everyone. A bot restart force-ends any game and
// unmutes whoever it had muted (persisted to state), so no one is ever left stuck muted.
//
// Gate: muting only happens while a game is ACTIVE, and only STAFF can start one — so nobody can weaponise
// it to mute a VC that isn't actually playing. Once started, any member IN that VC can use the controls.
const fs = require('fs');
const { SlashCommandBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        UserSelectMenuBuilder, EmbedBuilder, MessageFlags, ActivityType } = require('discord.js');
const { statePath } = require('./statepath');

const STATE_FILE = process.env.FUBU_AMONGUS_FILE || statePath('amongus.json');
const EPH = MessageFlags.Ephemeral;
const COLOR = 0xE0392B;

// games: { [vcId]: { vcId, guildId, textChannelId, panelMessageId, phase, dead:[id], mutedIds:[id], startedBy } }
let games = {};
function load() { try { games = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { games = {}; } return games; }
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(games)); } catch (e) { console.error('[amongus] save:', e.message); } }

// Show "Playing Among Us" on the bot while ANY game is running; clear it when the last one ends. (The bot
// sets no other presence, so clearing back to nothing is the correct default.)
function refreshPresence(client) {
  try {
    if (Object.keys(games).length) client.user.setPresence({ activities: [{ name: 'Among Us', type: ActivityType.Playing }] });
    else client.user.setPresence({ activities: [] });
  } catch (e) { console.error('[amongus] presence:', e.message); }
}

// Set a member's server-mute, best-effort (needs Mute Members; ignores members not in voice / perm issues).
async function setMute(member, on) {
  try {
    if (member && member.voice && member.voice.channelId && member.voice.serverMute !== on) {
      await member.voice.setMute(on, 'Among Us mode');
    }
  } catch { /* hierarchy / perms / not-in-voice — skip this member */ }
}

// Apply the game's current phase to everyone in its VC, and unmute anyone the bot previously muted who
// should no longer be. Recomputes game.mutedIds (the set the bot is responsible for).
async function applyPhase(guild, game) {
  const ch = guild.channels.cache.get(game.vcId) || await guild.channels.fetch(game.vcId).catch(() => null);
  if (!ch || !ch.members) return;
  const dead = new Set(game.dead);
  const members = [...ch.members.values()];
  const nowMuted = [];
  const tasks = [];   // fire every mute/unmute CONCURRENTLY — sequential awaits made round transitions laggy
  for (const m of members) {
    const shouldMute = game.phase === 'play' ? true : game.phase === 'discussion' ? dead.has(m.id) : false;
    tasks.push(setMute(m, shouldMute));
    if (shouldMute) nowMuted.push(m.id);
  }
  // Anyone we muted before but shouldn't be now (left the VC, revived, phase→lobby): unmute — also in parallel.
  for (const id of game.mutedIds || []) {
    if (!nowMuted.includes(id)) {
      const cached = ch.guild.members.cache.get(id);
      if (cached) tasks.push(setMute(cached, false));
      else tasks.push(ch.guild.members.fetch(id).then(m => setMute(m, false)).catch(() => {}));
    }
  }
  await Promise.allSettled(tasks);
  game.mutedIds = nowMuted;
  save();
}

function phaseLabel(p) { return p === 'play' ? '▶️ Play — everyone muted' : p === 'discussion' ? '💬 Discussion — alive talk, dead muted' : '🛋️ Lobby — everyone can talk'; }

function panel(game, guild) {
  const deadNames = (game.dead || []).map(id => `<@${id}>`).join(', ') || '_none_';
  const e = new EmbedBuilder().setColor(COLOR).setTitle('🔴 Among Us — VC control')
    .setDescription(`**Phase:** ${phaseLabel(game.phase)}\n**Dead:** ${deadNames}\n\nAnyone in <#${game.vcId}> can use the buttons.`)
    .setFooter({ text: 'Play mutes everyone · Discussion unmutes the living · New Round revives everyone' });
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`amongus_play:${game.vcId}`).setEmoji('▶️').setLabel('Play').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`amongus_discussion:${game.vcId}`).setEmoji('💬').setLabel('Discussion').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`amongus_lobby:${game.vcId}`).setEmoji('🔄').setLabel('New Round').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`amongus_end:${game.vcId}`).setEmoji('⏹️').setLabel('End Game').setStyle(ButtonStyle.Secondary));
  // Dead picker lives directly on the panel (a user-select) — no extra "open picker" round-trip. Selecting
  // sets the dead instantly; they go muted at the next Discussion.
  const dead = new UserSelectMenuBuilder().setCustomId(`amongus_deadpick:${game.vcId}`)
    .setPlaceholder('☠️ Mark dead — pick players (they stay muted in Discussion)').setMinValues(0).setMaxValues(25);
  try { if (game.dead && game.dead.length) dead.setDefaultUsers(game.dead.slice(0, 25)); } catch { /* older discord.js: skip pre-select */ }
  const row2 = new ActionRowBuilder().addComponents(dead);
  return { embeds: [e], components: [row1, row2] };
}

async function updatePanel(client, game) {
  try {
    const ch = await client.channels.fetch(game.textChannelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(game.panelMessageId).catch(() => null);
    if (msg) await msg.edit(panel(game, ch.guild));
  } catch (e) { console.error('[amongus] panel update:', e.message); }
}

// Remove the control panel entirely (on game end — don't leave a dead panel behind).
async function deletePanel(client, game) {
  if (!game.panelMessageId) return;
  try {
    const ch = await client.channels.fetch(game.textChannelId).catch(() => null);
    const msg = ch && await ch.messages.fetch(game.panelMessageId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
  } catch { /* panel already gone */ }
}

// Must be IN the game's VC to drive it.
function inGameVc(interaction, game) { return interaction.member?.voice?.channelId === game.vcId; }
const notInVc = (interaction, game) => interaction.reply({ content: `Join <#${game.vcId}> to control the game.`, flags: EPH });

function commandBuilder() {
  return new SlashCommandBuilder().setName('amongus')
    .setDescription('Start Among Us VC mode in your current voice channel (staff only to start)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers);
}

// Post a fresh control panel for a game and track it, deleting the previous panel so there's only one.
async function postPanel(interaction, game) {
  if (game.panelMessageId) {
    try {
      const oldCh = await interaction.client.channels.fetch(game.textChannelId).catch(() => null);
      const old = oldCh && await oldCh.messages.fetch(game.panelMessageId).catch(() => null);
      if (old) await old.delete().catch(() => {});
    } catch { /* old panel gone */ }
  }
  game.textChannelId = interaction.channelId; save();
  await interaction.reply(panel(game));
  const sent = await interaction.fetchReply().catch(() => null);
  if (sent) { game.panelMessageId = sent.id; save(); }
}

async function handleCommand(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) return interaction.reply({ content: 'Join a voice channel first, then run `/amongus` to start a game there.', flags: EPH });
  const existing = games[vc.id];
  if (existing) return postPanel(interaction, existing);   // game already running → just refresh/re-post its panel (keep phase + dead)
  const g = { vcId: vc.id, guildId: interaction.guildId, textChannelId: interaction.channelId, panelMessageId: null,
    phase: 'lobby', dead: [], mutedIds: [], startedBy: interaction.user.id };
  games[vc.id] = g; save();
  refreshPresence(interaction.client);   // → "Playing Among Us"
  await postPanel(interaction, g);
}

function isInteraction(i) {
  return (i.isButton?.() || i.isAnySelectMenu?.()) && typeof i.customId === 'string' && i.customId.startsWith('amongus_');
}

async function handleInteraction(interaction) {
  const [action, vcId] = interaction.customId.split(':');
  const game = games[vcId];
  if (!game) return interaction.reply({ content: 'That game is no longer running.', flags: EPH }).catch(() => {});
  const guild = interaction.guild;

  if (action === 'amongus_deadpick') {   // user-select on the panel: sets the dead set
    if (!inGameVc(interaction, game)) return interaction.reply({ content: `Join <#${game.vcId}> to control the game.`, flags: EPH });
    await interaction.deferUpdate().catch(() => {});   // ack instantly; re-render the panel with the new dead
    game.dead = interaction.values || []; save();
    if (game.phase === 'discussion') await applyPhase(guild, game);   // apply immediately if we're mid-discussion
    return updatePanel(interaction.client, game);
  }

  if (!inGameVc(interaction, game)) return notInVc(interaction, game);

  if (action === 'amongus_play' || action === 'amongus_discussion' || action === 'amongus_lobby') {
    await interaction.deferUpdate().catch(() => {});   // ack the button INSTANTLY, then mute in parallel (no 3s-window risk)
    if (action === 'amongus_play') game.phase = 'play';
    else if (action === 'amongus_discussion') game.phase = 'discussion';
    else { game.phase = 'lobby'; game.dead = []; }
    save();
    await applyPhase(guild, game);
    return updatePanel(interaction.client, game);
  }
  if (action === 'amongus_end') {
    await interaction.deferUpdate().catch(() => {});
    game.phase = 'lobby'; game.dead = []; await applyPhase(guild, game);   // unmute everyone the bot muted
    delete games[vcId]; save();
    refreshPresence(interaction.client);   // clear "Playing Among Us" if that was the last game
    await interaction.message.delete().catch(() => {});   // remove the panel entirely
    return;
  }
}

// Voice joins/leaves during a game: new joiners get the current phase's mute; leavers are unmuted + dropped;
// an emptied VC auto-ends the game.
function register(client) {
  load();
  // Boot cleanup: force-end any game that survived a restart — unmute whoever we had muted, then clear.
  (async () => {
    const active = Object.values(games);
    if (!active.length) return;
    for (const g of active) {
      const guild = client.guilds.cache.get(g.guildId) || await client.guilds.fetch(g.guildId).catch(() => null);
      if (guild) for (const id of g.mutedIds || []) { const m = await guild.members.fetch(id).catch(() => null); if (m) await setMute(m, false); }
    }
    games = {}; save(); refreshPresence(client);
    if (active.length) console.log(`[amongus] boot cleanup: force-ended ${active.length} stale game(s), unmuted their players`);
  })();

  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const left = oldState.channelId && games[oldState.channelId] && newState.channelId !== oldState.channelId;
      const joined = newState.channelId && games[newState.channelId] && oldState.channelId !== newState.channelId;
      if (left) {
        const g = games[oldState.channelId];
        // unmute the leaver (so they aren't stuck muted elsewhere) and drop them from tracking
        const m = newState.member || oldState.member;
        if (m) await setMute(m, false);
        g.dead = (g.dead || []).filter(id => id !== (m?.id));
        g.mutedIds = (g.mutedIds || []).filter(id => id !== (m?.id));
        save();
        // auto-end if the VC is now empty
        const ch = oldState.guild.channels.cache.get(g.vcId);
        if (ch && ch.members && ch.members.size === 0) { delete games[g.vcId]; save(); refreshPresence(client); await deletePanel(client, g).catch(() => {}); }
      }
      if (joined) {
        const g = games[newState.channelId];
        const m = newState.member;
        if (m) { const shouldMute = g.phase === 'play' ? true : g.phase === 'discussion' ? new Set(g.dead).has(m.id) : false; await setMute(m, shouldMute); if (shouldMute && !g.mutedIds.includes(m.id)) { g.mutedIds.push(m.id); save(); } }
      }
    } catch (e) { console.error('[amongus] voiceStateUpdate:', e.message); }
  });
}

module.exports = { commandBuilder, handleCommand, isInteraction, handleInteraction, register };
