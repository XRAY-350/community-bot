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
        StringSelectMenuBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { statePath } = require('./statepath');

const STATE_FILE = process.env.FUBU_AMONGUS_FILE || statePath('amongus.json');
const EPH = MessageFlags.Ephemeral;
const COLOR = 0xE0392B;

// games: { [vcId]: { vcId, guildId, textChannelId, panelMessageId, phase, dead:[id], mutedIds:[id], startedBy } }
let games = {};
function load() { try { games = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { games = {}; } return games; }
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(games)); } catch (e) { console.error('[amongus] save:', e.message); } }

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
  const nowMuted = [];
  for (const m of ch.members.values()) {
    const shouldMute = game.phase === 'play' ? true : game.phase === 'discussion' ? dead.has(m.id) : false;
    await setMute(m, shouldMute);
    if (shouldMute) nowMuted.push(m.id);
  }
  // Anyone we muted before but shouldn't be now (left the VC, revived, phase→lobby): unmute.
  for (const id of game.mutedIds || []) {
    if (!nowMuted.includes(id)) {
      const m = ch.guild.members.cache.get(id) || await ch.guild.members.fetch(id).catch(() => null);
      if (m) await setMute(m, false);
    }
  }
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
    new ButtonBuilder().setCustomId(`amongus_lobby:${game.vcId}`).setEmoji('🔄').setLabel('New Round').setStyle(ButtonStyle.Secondary));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`amongus_dead:${game.vcId}`).setEmoji('☠️').setLabel('Mark Dead').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`amongus_end:${game.vcId}`).setEmoji('⏹️').setLabel('End Game').setStyle(ButtonStyle.Secondary));
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

// Must be IN the game's VC to drive it.
function inGameVc(interaction, game) { return interaction.member?.voice?.channelId === game.vcId; }
const notInVc = (interaction, game) => interaction.reply({ content: `Join <#${game.vcId}> to control the game.`, flags: EPH });

function commandBuilder() {
  return new SlashCommandBuilder().setName('amongus')
    .setDescription('Start Among Us VC mode in your current voice channel (staff only to start)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers);
}

async function handleCommand(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) return interaction.reply({ content: 'Join a voice channel first, then run `/amongus` to start a game there.', flags: EPH });
  if (games[vc.id]) return interaction.reply({ content: `A game is already running in <#${vc.id}>. Its control panel is above — use **End Game** to close it.`, flags: EPH });
  const g = { vcId: vc.id, guildId: interaction.guildId, textChannelId: interaction.channelId, panelMessageId: null,
    phase: 'lobby', dead: [], mutedIds: [], startedBy: interaction.user.id };
  games[vc.id] = g; save();
  await interaction.reply(panel(g, interaction.guild));
  const sent = await interaction.fetchReply().catch(() => null);
  if (sent) { g.panelMessageId = sent.id; save(); }
}

function isInteraction(i) {
  return (i.isButton?.() || i.isStringSelectMenu?.()) && typeof i.customId === 'string' && i.customId.startsWith('amongus_');
}

async function handleInteraction(interaction) {
  const [action, vcId] = interaction.customId.split(':');
  const game = games[vcId];
  if (!game) return interaction.reply({ content: 'That game is no longer running.', flags: EPH }).catch(() => {});
  const guild = interaction.guild;

  if (action === 'amongus_deadpick') {   // multi-select submit
    if (!inGameVc(interaction, game)) return notInVc(interaction, game);
    game.dead = interaction.values || []; save();
    if (game.phase === 'discussion') await applyPhase(guild, game);
    await updatePanel(interaction.client, game);
    return interaction.update({ content: `☠️ Dead set: ${game.dead.length ? game.dead.map(id => `<@${id}>`).join(', ') : 'none'}.`, components: [], embeds: [] }).catch(() => {});
  }

  if (!inGameVc(interaction, game)) return notInVc(interaction, game);

  if (action === 'amongus_dead') {   // open the multi-select of current VC members
    const ch = guild.channels.cache.get(vcId) || await guild.channels.fetch(vcId).catch(() => null);
    const members = ch ? [...ch.members.values()] : [];
    if (!members.length) return interaction.reply({ content: 'Nobody is in the voice channel.', flags: EPH });
    const dead = new Set(game.dead);
    const opts = members.slice(0, 25).map(m => ({ label: (m.displayName || m.user.username).slice(0, 100), value: m.id, default: dead.has(m.id) }));
    const menu = new StringSelectMenuBuilder().setCustomId(`amongus_deadpick:${vcId}`).setPlaceholder('Pick who is DEAD (they stay muted in Discussion)')
      .setMinValues(0).setMaxValues(opts.length).addOptions(opts);
    return interaction.reply({ content: 'Select the dead players:', components: [new ActionRowBuilder().addComponents(menu)], flags: EPH });
  }

  if (action === 'amongus_play') { game.phase = 'play'; save(); await applyPhase(guild, game); await updatePanel(interaction.client, game); return interaction.deferUpdate().catch(() => {}); }
  if (action === 'amongus_discussion') { game.phase = 'discussion'; save(); await applyPhase(guild, game); await updatePanel(interaction.client, game); return interaction.deferUpdate().catch(() => {}); }
  if (action === 'amongus_lobby') { game.phase = 'lobby'; game.dead = []; save(); await applyPhase(guild, game); await updatePanel(interaction.client, game); return interaction.deferUpdate().catch(() => {}); }
  if (action === 'amongus_end') {
    game.phase = 'lobby'; game.dead = []; await applyPhase(guild, game);   // unmute everyone the bot muted
    delete games[vcId]; save();
    try { const m = await interaction.message.fetch?.() || interaction.message; await m.edit({ content: '🔴 Among Us game ended — everyone unmuted.', embeds: [], components: [] }); } catch { /* panel gone */ }
    return interaction.deferUpdate().catch(() => {});
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
    games = {}; save();
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
        if (ch && ch.members && ch.members.size === 0) { delete games[g.vcId]; save(); await updatePanel(client, { ...g }).catch(() => {}); }
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
