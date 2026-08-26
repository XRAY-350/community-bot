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
        StringSelectMenuBuilder, EmbedBuilder, MessageFlags, ActivityType } = require('discord.js');
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
// Unconditional unmute for someone LEAVING the game VC — setMute()'s channelId guard exists so we never
// try to mute someone who isn't there to receive it, but that same guard was blocking the UNMUTE on a
// full disconnect (owner, 2026-08-18: "if anyone leaves mid game they should be un server muted so they
// aren't muted next time they join a vc"). By the time this fires, newState.member.voice.channelId is
// already null (they've left, not just moved), so the shared setMute() silently no-op'd — their
// server-mute flag stayed set and carried into whatever VC they joined next. Discord's mute edit works
// regardless of current connection (it just has no visible effect until they're in voice again), so skip
// the channelId check entirely here.
async function forceUnmute(member) {
  try { await member.voice.setMute(false, 'Among Us mode — left mid-game'); } catch { /* not in voice / perms — best-effort */ }
}

// Discord's voice-channel "status" (the short text under the channel name in the sidebar) has no
// discord.js helper in this version, so it's a raw REST call. Best-effort — a missing ManageChannels
// permission or a transient API error just no-ops rather than breaking the game (owner, 2026-08-18:
// "/amongus also doesn't properly set the status of the channel" — it never set it at all before this).
async function setVcStatus(client, vcId, status) {
  try { await client.rest.put(`/channels/${vcId}/voice-status`, { body: { status: (status || '').slice(0, 500) } }); }
  catch (e) { console.error('[amongus] voice status:', e.message); }
}
function phaseStatus(phase) {
  return phase === 'play' ? '▶️ Among Us: Play' : phase === 'discussion' ? '💬 Among Us: Discussion' : '🛋️ Among Us: Lobby';
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
  // Anyone we muted before but shouldn't be now (left the VC, revived, phase→lobby): unmute — also in
  // parallel. forceUnmute, not setMute — someone who left the VC entirely (not just revived/lobby'd while
  // still present) has no channelId for setMute's guard to see, so it would silently no-op and leave them
  // stuck server-muted into their next voice session.
  for (const id of game.mutedIds || []) {
    if (!nowMuted.includes(id)) {
      const cached = ch.guild.members.cache.get(id);
      if (cached) tasks.push(forceUnmute(cached));
      else tasks.push(ch.guild.members.fetch(id).then(m => forceUnmute(m)).catch(() => {}));
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
    .setDescription(`**Phase:** ${phaseLabel(game.phase)}\n**Dead:** ${deadNames}\n\nAnyone in <#${game.vcId}> can drive rounds. Ending the game is staff-only.`)
    .setFooter({ text: 'Play mutes everyone · Discussion unmutes the living · New Round revives everyone' });
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`amongus_play:${game.vcId}`).setEmoji('▶️').setLabel('Play').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`amongus_discussion:${game.vcId}`).setEmoji('💬').setLabel('Discussion').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`amongus_lobby:${game.vcId}`).setEmoji('🔄').setLabel('New Round').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`amongus_end:${game.vcId}`).setEmoji('⏹️').setLabel('End Game').setStyle(ButtonStyle.Secondary));
  // Dead picker lives directly on the panel — a string-select of ONLY the current VC members (kept fresh by
  // re-rendering the panel on every VC join/leave). Selecting sets the dead instantly; no "open picker" step.
  const vc = guild && guild.channels && guild.channels.cache.get(game.vcId);
  const members = vc && vc.members ? [...vc.members.values()] : [];
  const deadSet = new Set(game.dead);
  const sel = new StringSelectMenuBuilder().setCustomId(`amongus_deadpick:${game.vcId}`)
    .setPlaceholder('☠️ Mark dead — pick players in the VC (stay muted in Discussion)').setMinValues(0);
  if (members.length) {
    const opts = members.slice(0, 25).map(m => ({ label: (m.displayName || m.user.username).slice(0, 100), value: m.id, default: deadSet.has(m.id) }));
    sel.addOptions(opts).setMaxValues(opts.length);
  } else {
    sel.addOptions([{ label: '(nobody in the voice channel yet)', value: 'none' }]).setMaxValues(1).setDisabled(true);
  }
  const row2 = new ActionRowBuilder().addComponents(sel);
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
  await interaction.reply(panel(game, interaction.guild));
  const sent = await interaction.fetchReply().catch(() => null);
  if (sent) { game.panelMessageId = sent.id; save(); }
}

async function handleCommand(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) return interaction.reply({ content: 'Join a voice channel first, then run `/amongus` to start a game there.', flags: EPH });
  // Must be run from that VC's own text chat, not a regular text channel (owner, 2026-08-18: "It should
  // only work in the text channel of a voice call") — a voice channel's chat tab shares its VC's own id,
  // so the panel/game can only ever live where the players actually are.
  if (interaction.channelId !== vc.id) return interaction.reply({ content: `Run \`/amongus\` from **${vc.name}**'s own text chat (the chat tab inside the voice call), not here.`, flags: EPH });
  const existing = games[vc.id];
  if (existing) return postPanel(interaction, existing);   // game already running → just refresh/re-post its panel (keep phase + dead)
  // Mutual exclusion with Mafia (audit A17): both modes fight over server-mute on every join/leave if
  // they ever claim the same VC. Lazy require avoids a load-order cycle.
  try { if (require('./mafia').isActive(vc.id)) return interaction.reply({ content: 'A Mafia game is running in this VC. Finish it before starting Among Us here.', flags: EPH }); } catch { /* mafia absent */ }
  const g = { vcId: vc.id, guildId: interaction.guildId, textChannelId: interaction.channelId, panelMessageId: null,
    phase: 'lobby', dead: [], mutedIds: [], startedBy: interaction.user.id };
  games[vc.id] = g; save();
  refreshPresence(interaction.client);   // → "Playing Among Us"
  await setVcStatus(interaction.client, vc.id, phaseStatus(g.phase));
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
    game.dead = (interaction.values || []).filter(v => v !== 'none'); save();
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
    await setVcStatus(interaction.client, game.vcId, phaseStatus(game.phase));
    return updatePanel(interaction.client, game);
  }
  if (action === 'amongus_end') {
    // Players can drive rounds (Play/Discussion/New Round) and mark dead, but only staff can end the game
    // entirely and dismiss the panel (owner, 2026-08-18: "members can start rounds ... but they can't
    // dismiss the pop-up, only staff can do that") — same permission the /amongus command itself requires.
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return interaction.reply({ content: 'Only staff can end the game.', flags: EPH });
    await interaction.deferUpdate().catch(() => {});
    game.phase = 'lobby'; game.dead = []; await applyPhase(guild, game);   // unmute everyone the bot muted
    delete games[vcId]; save();
    refreshPresence(interaction.client);   // clear "Playing Among Us" if that was the last game
    await setVcStatus(interaction.client, vcId, '');   // clear the VC status too
    await interaction.message.delete().catch(() => {});   // remove the panel entirely
    return;
  }
}

// Voice joins/leaves during a game: new joiners get the current phase's mute; leavers are unmuted + dropped;
// an emptied VC auto-ends the game.
function register(client) {
  load();
  // Boot RESUME: games PERSIST across restarts (owner). Re-sync each surviving game to its saved phase (re-apply
  // the right mutes), refresh its panel, and restore the "Playing Among Us" presence. Only a game whose VC is
  // gone or now empty is ended (unmute its tracked players + delete its panel).
  (async () => {
    const active = Object.values(games);
    if (!active.length) return;
    let resumed = 0, dropped = 0;
    for (const g of active) {
      const guild = client.guilds.cache.get(g.guildId) || await client.guilds.fetch(g.guildId).catch(() => null);
      const vc = guild && (guild.channels.cache.get(g.vcId) || await guild.channels.fetch(g.vcId).catch(() => null));
      if (!guild || !vc || !vc.members || vc.members.size === 0) {
        if (guild) for (const id of g.mutedIds || []) { const m = await guild.members.fetch(id).catch(() => null); if (m) await forceUnmute(m); }
        if (guild) await setVcStatus(client, g.vcId, '');
        await deletePanel(client, g).catch(() => {});
        delete games[g.vcId]; dropped++;
        continue;
      }
      await applyPhase(guild, g).catch(e => console.error('[amongus] resume applyPhase:', e.message));   // re-mute to saved phase
      await setVcStatus(client, g.vcId, phaseStatus(g.phase));
      await updatePanel(client, g).catch(() => {});   // refresh the panel (its buttons already survive the restart)
      resumed++;
    }
    save(); refreshPresence(client);
    if (resumed || dropped) console.log(`[amongus] boot: resumed ${resumed} game(s)${dropped ? `, dropped ${dropped} empty/gone` : ''}`);
  })();

  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const left = oldState.channelId && games[oldState.channelId] && newState.channelId !== oldState.channelId;
      const joined = newState.channelId && games[newState.channelId] && oldState.channelId !== newState.channelId;
      if (left) {
        const g = games[oldState.channelId];
        // unmute the leaver (so they aren't stuck muted elsewhere) and drop them from tracking
        const m = newState.member || oldState.member;
        if (m) await forceUnmute(m);
        g.dead = (g.dead || []).filter(id => id !== (m?.id));
        g.mutedIds = (g.mutedIds || []).filter(id => id !== (m?.id));
        save();
        // auto-end if the VC is now empty; otherwise refresh the panel so the dead-picker drops the leaver
        const ch = oldState.guild.channels.cache.get(g.vcId);
        if (ch && ch.members && ch.members.size === 0) { delete games[g.vcId]; save(); refreshPresence(client); await setVcStatus(client, g.vcId, ''); await deletePanel(client, g).catch(() => {}); }
        else await updatePanel(client, g).catch(() => {});
      }
      if (joined) {
        const g = games[newState.channelId];
        const m = newState.member;
        if (m) { const shouldMute = g.phase === 'play' ? true : g.phase === 'discussion' ? new Set(g.dead).has(m.id) : false; await setMute(m, shouldMute); if (shouldMute && !g.mutedIds.includes(m.id)) { g.mutedIds.push(m.id); save(); } }
        await updatePanel(client, g).catch(() => {});   // new member now shows up in the dead-picker
      }
    } catch (e) { console.error('[amongus] voiceStateUpdate:', e.message); }
  });
}

module.exports = { commandBuilder, handleCommand, isInteraction, handleInteraction, register, isActive: (vcId) => !!games[vcId] };
