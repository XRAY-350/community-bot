// mafia.js — "Mafia mode" for a voice channel (owner: "build something like /amongus" but a FULL
// self-contained engine — the bot tracks alive/dead, resolves night actions itself, and calls the win
// condition, unlike /amongus which just toggles mute phases for a human host to drive by eye).
//
// No DMs, no separate per-role channels (owner, explicit): role reveal is a button anyone can click any
// time for an ephemeral look at their own role; night actions go through ONE shared "Night Actions"
// panel whose 3 buttons are gated by checking the clicker's actual role server-side, not by who can see
// what. Voice-mode Night additionally mutes+DEAFENS every living non-Mafia player (can't hear OR talk)
// while living Mafia stay fully live in the SAME shared VC — so they can just talk it over, no separate
// mafia voice channel needed. Text-mode Night additionally opens a private Mafia-only thread (mirrors
// appeals.js's multi-member private-thread pattern) for discussion; the kill vote itself still goes
// through the shared Night Actions panel either way.
//
// Mode (voice vs text) is auto-detected at lobby close: voice only if every joined player is actually
// connected to the game's VC at that moment, else text (owner: "auto detect").
//
// Timer-driven (lobby countdown, Night, Day) via ONE periodic sweep (see sweepExpiredPhases) rather than
// a setTimeout per transition — simpler to reason about and makes boot-reconcile a non-issue (an overdue
// phase is just picked up on the next tick after restart, no special resume logic needed).
const fs = require('fs');
const { SlashCommandBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        StringSelectMenuBuilder, EmbedBuilder, MessageFlags, ChannelType } = require('discord.js');
const { statePath } = require('./statepath');
const opspanel = require('./opspanel');

const STATE_FILE = process.env.FUBU_MAFIA_FILE || statePath('mafia.json');
const EPH = MessageFlags.Ephemeral;
const COLOR = 0x6E1423;

const MIN_PLAYERS = 5, MAX_PLAYERS = 15;
const LOBBY_MS = 60 * 1000, NIGHT_MS = 90 * 1000, DAY_MS = 120 * 1000;
const SWEEP_MS = 15 * 1000;

const ROLE_LABEL = { mafia: '🔪 Mafia', villager: '🧑‍🌾 Villager', doctor: '💉 Doctor', detective: '🔎 Detective' };
const ROLE_DESC = {
  mafia: 'Each Night, vote with the rest of the Mafia on who to kill. Try not to get caught.',
  villager: 'No powers. Survive, and vote out the Mafia during the Day.',
  doctor: 'Each Night, pick one living player to protect. If Mafia targets them, they survive.',
  detective: 'Each Night, investigate one living player — you\'ll learn if they\'re Mafia-aligned.',
};

// State file holds BOTH the live games and the persistent role settings:
//   { games: { [vcId]: {...game} }, settings: {...} }
// (v1 wrote a bare games map at the root; load() still reads that shape so an in-flight game from an
// older build isn't lost on the upgrade.)
let games = {}, settings = null;
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && raw.games && typeof raw.games === 'object') { games = raw.games; settings = raw.settings || null; }
    else { games = raw || {}; settings = null; }                       // v1 flat shape
  } catch { games = {}; settings = null; }
  return games;
}
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ games, settings })); } catch (e) { console.error('[mafia] save:', e.message); } }
function get(vcId) { return games[vcId] || null; }
function isActive(vcId) { return !!get(vcId); }
function update(vcId, patch) { games[vcId] = { ...games[vcId], ...patch }; save(); return games[vcId]; }
function clear(vcId) { delete games[vcId]; save(); }
function allActive() { return Object.values(games); }

// ---- role settings (Among Us style: per-role COUNT + percent CHANCE that each slot actually spawns).
// 'auto' keeps the original player-count scaling (mafia = n/4, Doctor at 5+, Detective at 6+) and is the
// default, so an unconfigured server behaves exactly as it did before this existed. Settings persist
// across games, like a host's lobby settings. -----------------------------------------------------------
const DEFAULT_SETTINGS = { mafia: { count: 'auto' }, doctor: { count: 'auto', chance: 100 }, detective: { count: 'auto', chance: 100 } };
function getSettings() {
  if (!settings) load();
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
function setRoleSetting(role, patch) {
  const s = getSettings();
  s[role] = { ...s[role], ...patch };
  settings = s; save();
  return s;
}
function describeRole(role, s) {
  const c = s[role];
  if (c.count === 'auto') return 'Auto';
  if (!c.count) return 'Off';
  return `${c.count}×${role === 'mafia' ? '' : ` ${c.chance}%`}`;
}
function describeSettings(s = getSettings()) {
  return `🔪 Mafia **${describeRole('mafia', s)}** · 💉 Doctor **${describeRole('doctor', s)}** · 🔎 Detective **${describeRole('detective', s)}**`;
}

// ---- role assignment ---------------------------------------------------------------------------------
// Rolls each configured slot independently against its chance (so "2× 50%" can yield 0, 1, or 2), then
// clamps: Mafia must be at least 1 and must stay a MINORITY at the start (mafia >= town is an instant
// win, so a mis-set count can't hand the game away before it begins), and special roles can never
// outnumber the remaining town slots.
function roleCounts(n, s = getSettings()) {
  let mafiaN = s.mafia.count === 'auto' ? Math.max(1, Math.floor(n / 4)) : Number(s.mafia.count) || 1;
  mafiaN = Math.max(1, Math.min(mafiaN, Math.floor((n - 1) / 2)));
  const special = {};
  for (const role of ['doctor', 'detective']) {
    const cfg = s[role];
    if (cfg.count === 'auto') { special[role] = (role === 'doctor' ? n >= 5 : n >= 6) ? 1 : 0; continue; }
    let got = 0;
    for (let i = 0; i < (Number(cfg.count) || 0); i++) if (Math.random() * 100 < (Number(cfg.chance) ?? 100)) got++;
    special[role] = got;
  }
  // clamp special roles into the town slots that actually exist
  let townSlots = n - mafiaN;
  for (const role of ['doctor', 'detective']) { special[role] = Math.min(special[role], Math.max(0, townSlots)); townSlots -= special[role]; }
  return { mafia: mafiaN, doctor: special.doctor, detective: special.detective, villager: n - mafiaN - special.doctor - special.detective };
}
function assignRoles(joinOrder, s = getSettings()) {
  const ids = [...joinOrder];
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[ids[i], ids[j]] = [ids[j], ids[i]]; }
  const counts = roleCounts(ids.length, s);
  const players = {};
  let idx = 0;
  for (let i = 0; i < counts.mafia; i++) players[ids[idx++]] = { role: 'mafia', alive: true };
  for (let i = 0; i < counts.doctor; i++) players[ids[idx++]] = { role: 'doctor', alive: true };
  for (let i = 0; i < counts.detective; i++) players[ids[idx++]] = { role: 'detective', alive: true };
  while (idx < ids.length) players[ids[idx++]] = { role: 'villager', alive: true };
  return players;
}

// ---- game-state helpers -------------------------------------------------------------------------------
function livingIds(game) { return Object.entries(game.players).filter(([, p]) => p.alive).map(([id]) => id); }
function livingMafiaIds(game) { return livingIds(game).filter(id => game.players[id].role === 'mafia'); }
function findRoleHolder(game, role) { return livingIds(game).find(id => game.players[id].role === role) || null; }
function checkWin(game) {
  const mafiaAlive = livingMafiaIds(game).length;
  const townAlive = livingIds(game).length - mafiaAlive;
  if (mafiaAlive === 0) return 'town';
  if (mafiaAlive >= townAlive) return 'mafia';
  return null;
}
// Plurality winner of a {voterId: targetId} map, restricted to targets still alive. Ties: first seen
// at the highest count (acceptable, non-critical tie-break — not specified by the owner).
function pluralityTarget(votes, aliveSet) {
  const tally = {};
  for (const targetId of Object.values(votes || {})) { if (!aliveSet.has(targetId)) continue; tally[targetId] = (tally[targetId] || 0) + 1; }
  let best = null, bestN = 0, tie = false;
  for (const [id, n] of Object.entries(tally)) {
    if (n > bestN) { best = id; bestN = n; tie = false; }
    else if (n === bestN && bestN > 0) tie = true;
  }
  return { target: best, count: bestN, tie };
}

// ---- voice muting (Night: mute+deafen everyone but living Mafia; Day: everyone free; dead: always
// muted+deafened). Self-contained here — amongus.js has no deafen concept to reuse. ----------------------
async function setVoiceState(member, mute, deaf) {
  try {
    if (!member || !member.voice) return;
    if (member.voice.serverMute !== mute) await member.voice.setMute(mute, 'Mafia mode');
    if (member.voice.serverDeaf !== deaf) await member.voice.setDeaf(deaf, 'Mafia mode');
  } catch { /* hierarchy / perms / not in voice — skip */ }
}
async function releaseVoice(member) {
  try { if (member?.voice) { await member.voice.setMute(false, 'Mafia mode ended'); await member.voice.setDeaf(false, 'Mafia mode ended'); } } catch { /* best-effort */ }
}
async function applyVoicePhase(guild, game) {
  if (game.mode !== 'voice') return;
  const vc = guild.channels.cache.get(game.vcId) || await guild.channels.fetch(game.vcId).catch(() => null);
  if (!vc || !vc.members) return;
  const mafiaAlive = new Set(livingMafiaIds(game));
  const tasks = [];
  for (const m of vc.members.values()) {
    const p = game.players[m.id];
    const isDead = p && !p.alive;
    const isLivingMafia = p && p.alive && mafiaAlive.has(m.id);
    const shouldLock = isDead || (game.phase === 'night' && !isLivingMafia && !!p);
    tasks.push(setVoiceState(m, shouldLock, shouldLock));
  }
  await Promise.allSettled(tasks);
}
// Everyone the bot ever locked gets fully released — used on game end / abort so nobody is left stuck.
async function releaseAllVoices(guild, game) {
  if (game.mode !== 'voice') return;
  const tasks = [];
  for (const id of Object.keys(game.players || {})) {
    const m = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    if (m) tasks.push(releaseVoice(m));
  }
  await Promise.allSettled(tasks);
}

// ---- panels --------------------------------------------------------------------------------------------
const roleRow = vcId => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`mafia_role:${vcId}`).setEmoji('🎭').setLabel('My Role').setStyle(ButtonStyle.Secondary));

function lobbyPanel(game) {
  const names = game.joinOrder.map(id => `<@${id}>`).join('\n') || '_nobody yet_';
  const e = new EmbedBuilder().setColor(COLOR).setTitle('🔪 Mafia — Lobby')
    .setDescription(`Starting in <#${game.vcId}>. Tap **Join** to play.\n\n**Roles:** ${describeSettings()}\n\n**Players (${game.joinOrder.length}/${MAX_PLAYERS}):**\n${names}`)
    .setFooter({ text: `Need at least ${MIN_PLAYERS} to start · auto-starts <t:${Math.floor(game.lobbyDeadline / 1000)}:R>` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mafia_join:${game.vcId}`).setEmoji('✅').setLabel('Join / Leave').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mafia_startnow:${game.vcId}`).setEmoji('⏩').setLabel('Start Now').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mafia_settings:${game.vcId}`).setEmoji('⚙️').setLabel('Roles').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mafia_end:${game.vcId}`).setEmoji('⏹️').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row] };
}

// Role-setup panel (ephemeral, staff-only). Count and chance are combined into one preset per role so
// each change is a single click instead of two selects to reconcile — Discord caps a message at 5 rows,
// and this keeps the whole setup on one screen.
const MAFIA_COUNT_OPTS = [['auto', 'Auto (scales with player count)'], ['1', '1 Mafia'], ['2', '2 Mafia'], ['3', '3 Mafia'], ['4', '4 Mafia']];
const SPECIAL_OPTS = [['auto', 'Auto (1 if enough players)'], ['off', 'Off — never spawns'],
  ['1:100', '1× · always'], ['1:75', '1× · 75% chance'], ['1:50', '1× · 50% chance'], ['1:25', '1× · 25% chance'],
  ['2:100', '2× · always'], ['2:50', '2× · 50% chance each']];
function settingValue(role, s) {
  const c = s[role];
  if (c.count === 'auto') return 'auto';
  if (!c.count) return 'off';
  return role === 'mafia' ? String(c.count) : `${c.count}:${c.chance}`;
}
function settingsPanel(vcId) {
  const s = getSettings();
  const e = new EmbedBuilder().setColor(COLOR).setTitle('⚙️ Mafia — Role setup')
    .setDescription(`${describeSettings(s)}\n\nPick how many of each role, and the chance each slot actually spawns. **Auto** scales with the player count. These stick for future games.`)
    .setFooter({ text: 'Mafia is always at least 1 and always a minority at the start, whatever you set.' });
  const sel = (role, opts, placeholder) => {
    const cur = settingValue(role, s);
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`mafia_setrole:${vcId}:${role}`).setPlaceholder(placeholder)
      .addOptions(opts.map(([value, label]) => ({ label, value, default: value === cur }))));
  };
  return { embeds: [e], components: [
    sel('mafia', MAFIA_COUNT_OPTS, '🔪 Mafia count'),
    sel('doctor', SPECIAL_OPTS, '💉 Doctor'),
    sel('detective', SPECIAL_OPTS, '🔎 Detective'),
  ] };
}

function nightPanel(game) {
  const alive = livingIds(game);
  const e = new EmbedBuilder().setColor(0x1B1F3B).setTitle(`🌙 Night ${game.dayNum} falls`)
    .setDescription(game.mode === 'voice'
      ? `Mafia can still talk in <#${game.vcId}> — everyone else is muted and can't hear a thing. If you have a Night action, use the buttons below.`
      : `Mafia, coordinate in your private thread. If you have a Night action, use the buttons below.`)
    .addFields({ name: 'Living', value: String(alive.length), inline: true })
    .setFooter({ text: `Resolves <t:${Math.floor(game.phaseDeadline / 1000)}:R>` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mafia_act:${game.vcId}:kill`).setEmoji('🔪').setLabel('Mafia: Kill').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mafia_act:${game.vcId}:save`).setEmoji('💉').setLabel('Doctor: Save').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mafia_act:${game.vcId}:investigate`).setEmoji('🔎').setLabel('Detective: Investigate').setStyle(ButtonStyle.Primary));
  return { embeds: [e], components: [row, roleRow(game.vcId)] };
}

function dayPanel(game, resultLine) {
  const alive = livingIds(game);
  const votes = game.day.votes || {};
  const tally = {};
  for (const t of Object.values(votes)) tally[t] = (tally[t] || 0) + 1;
  const voteLines = alive.filter(id => tally[id]).map(id => `**${tally[id]}** — <@${id}>`).join('\n');
  const e = new EmbedBuilder().setColor(0xE8B923).setTitle(`☀️ Day ${game.dayNum}`)
    .setDescription(`${resultLine}\n\nDiscuss, then vote to eliminate someone.${voteLines ? `\n\n**Votes:**\n${voteLines}` : ''}`)
    .addFields({ name: 'Living', value: String(alive.length), inline: true })
    .setFooter({ text: `Vote closes <t:${Math.floor(game.phaseDeadline / 1000)}:R>` });
  const sel = new StringSelectMenuBuilder().setCustomId(`mafia_vote:${game.vcId}`).setPlaceholder('🗳️ Vote to eliminate…')
    .addOptions(alive.slice(0, 25).map(id => ({ label: game.players[id]?.name || id, value: id })));
  const row = new ActionRowBuilder().addComponents(sel);
  return { embeds: [e], components: [row, roleRow(game.vcId)] };
}

function revealLines(game) {
  return Object.entries(game.players).map(([id, p]) => `${p.alive ? '🟢' : '💀'} ${ROLE_LABEL[p.role]} — <@${id}>`).join('\n');
}
function endPanel(game, winner) {
  const e = new EmbedBuilder().setColor(winner === 'mafia' ? 0xED4245 : 0x57F287)
    .setTitle(winner === 'mafia' ? '🔪 Mafia wins' : '🧑‍🌾 Town wins')
    .setDescription(`Game over. Here's who was who:\n\n${revealLines(game)}`);
  return { embeds: [e], components: [] };
}

async function postPanel(client, game, payload) {
  const ch = await client.channels.fetch(game.textChannelId).catch(() => null);
  if (!ch) return null;
  if (game.panelMessageId) { const old = await ch.messages.fetch(game.panelMessageId).catch(() => null); if (old) await old.delete().catch(() => {}); }
  const sent = await ch.send(payload).catch(() => null);
  if (sent) update(game.vcId, { panelMessageId: sent.id });
  return sent;
}
async function announce(client, game, content) {
  const ch = await client.channels.fetch(game.textChannelId).catch(() => null);
  if (ch) await ch.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

// ---- phase transitions ----------------------------------------------------------------------------------
async function startLobby(client, guild, vc, hostId) {
  const g = update(vc.id, {
    vcId: vc.id, guildId: guild.id, textChannelId: vc.id, hostId,
    mafiaThreadId: null, phase: 'lobby', dayNum: 0, mode: null,
    lobbyDeadline: Date.now() + LOBBY_MS, phaseDeadline: null,
    players: {}, joinOrder: [], night: { mafiaVotes: {}, doctorPick: null, detectivePick: null, resolved: false },
    day: { votes: {}, resolved: false }, deathLog: [], mutedIds: [], panelMessageId: null,
  });
  await postPanel(client, g, lobbyPanel(g));
}

async function closeLobby(client, guild, game) {
  if (game.joinOrder.length < MIN_PLAYERS) {
    await announce(client, game, `🔪 Not enough players joined (need ${MIN_PLAYERS}, got ${game.joinOrder.length}) — Mafia game cancelled.`);
    return endGame(client, guild, game, null);
  }
  // Snapshot display names for panel rendering without extra fetches later.
  const players = assignRoles(game.joinOrder);
  for (const id of Object.keys(players)) {
    const m = guild.members.cache.get(id);
    players[id].name = (m?.displayName || m?.user?.username || id).slice(0, 100);
  }
  // Auto-detect mode: voice only if every joined player is CURRENTLY connected to the game's VC.
  const vc = guild.channels.cache.get(game.vcId) || await guild.channels.fetch(game.vcId).catch(() => null);
  const connected = new Set(vc?.members ? [...vc.members.keys()] : []);
  const mode = game.joinOrder.every(id => connected.has(id)) ? 'voice' : 'text';
  update(game.vcId, { players, mode, phase: 'night', dayNum: 1, phaseDeadline: Date.now() + NIGHT_MS });
  const fresh = get(game.vcId);

  if (mode === 'text') {
    const ch = await client.channels.fetch(game.textChannelId).catch(() => null);
    if (ch) {
      const thread = await ch.threads.create({ name: 'Mafia', type: ChannelType.PrivateThread, invitable: false, reason: 'Mafia mode: private team chat' }).catch(() => null);
      if (thread) {
        for (const id of livingMafiaIds(fresh)) await thread.members.add(id).catch(() => {});
        await thread.send({ content: `🔪 ${livingMafiaIds(fresh).map(id => `<@${id}>`).join(', ')} — this is your private line. Talk it over, then submit your kill on the Night Actions panel in the main channel.`, allowedMentions: { users: livingMafiaIds(fresh) } }).catch(() => {});
        update(game.vcId, { mafiaThreadId: thread.id });
      }
    }
  } else {
    await applyVoicePhase(guild, fresh);
  }
  await announce(client, fresh, `🔪 Roles are assigned (**${fresh.mode}** mode). Check yours with **My Role** on the panel below.`);
  await postPanel(client, fresh, nightPanel(fresh));
}

async function resolveNight(client, guild, game) {
  const alive = new Set(livingIds(game));
  const { target: killTarget } = pluralityTarget(game.night.mafiaVotes, alive);
  const saved = game.night.doctorPick;
  let resultLine;
  if (killTarget && killTarget !== saved) {
    game.players[killTarget].alive = false;
    game.deathLog.push({ day: game.dayNum, phase: 'night', userId: killTarget, cause: 'killed' });
    resultLine = `☠️ <@${killTarget}> was killed during the night.`;
  } else if (killTarget && killTarget === saved) {
    resultLine = `💉 Mafia struck, but the Doctor saved their target — nobody died last night.`;
  } else {
    resultLine = `😴 Nobody died last night.`;
  }
  save();
  if (game.mafiaThreadId) { const t = await guild.channels.fetch(game.mafiaThreadId).catch(() => null); if (t && killTarget && !game.players[killTarget].alive) await t.members.remove(killTarget).catch(() => {}); }

  const winner = checkWin(game);
  if (winner) return endGame(client, guild, game, winner);

  update(game.vcId, { phase: 'day', phaseDeadline: Date.now() + DAY_MS, day: { votes: {}, resolved: false }, lastResultLine: resultLine });
  const fresh = get(game.vcId);
  if (fresh.mode === 'voice') await applyVoicePhase(guild, fresh);
  await postPanel(client, fresh, dayPanel(fresh, resultLine));
}

async function resolveDay(client, guild, game) {
  const alive = new Set(livingIds(game));
  const { target, tie } = pluralityTarget(game.day.votes, alive);
  let resultLine;
  if (target && !tie) {
    game.players[target].alive = false;
    game.deathLog.push({ day: game.dayNum, phase: 'day', userId: target, cause: 'eliminated' });
    resultLine = `⚖️ <@${target}> (**${ROLE_LABEL[game.players[target].role]}**) was voted out.`;
  } else {
    resultLine = tie ? `⚖️ The vote was tied — nobody was eliminated today.` : `⚖️ Not enough votes — nobody was eliminated today.`;
  }
  save();
  if (game.mafiaThreadId && target && !game.players[target].alive) { const t = await guild.channels.fetch(game.mafiaThreadId).catch(() => null); if (t) await t.members.remove(target).catch(() => {}); }

  const winner = checkWin(game);
  await announce(client, game, resultLine);
  if (winner) return endGame(client, guild, game, winner);

  update(game.vcId, { phase: 'night', dayNum: game.dayNum + 1, phaseDeadline: Date.now() + NIGHT_MS, night: { mafiaVotes: {}, doctorPick: null, detectivePick: null, resolved: false } });
  const fresh = get(game.vcId);
  if (fresh.mode === 'voice') await applyVoicePhase(guild, fresh);
  await postPanel(client, fresh, nightPanel(fresh));
}

async function endGame(client, guild, game, winner) {
  if (winner) await postPanel(client, game, endPanel(game, winner));
  if (guild) await releaseAllVoices(guild, game).catch(() => {});
  if (game.mafiaThreadId) { const t = guild && await guild.channels.fetch(game.mafiaThreadId).catch(() => null); if (t) { await t.setLocked(true).catch(() => {}); await t.setArchived(true).catch(() => {}); } }
  clear(game.vcId);
}

// ---- entry points ------------------------------------------------------------------------------------
function commandBuilder() {
  return new SlashCommandBuilder().setName('mafia').setDescription('Play Mafia in your voice channel (staff starts, anyone can join)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
    .addSubcommand(s => s.setName('start').setDescription('Start a Mafia lobby in your current VC (staff)'))
    .addSubcommand(s => s.setName('status').setDescription('Check the game running in your VC'))
    .addSubcommand(s => s.setName('end').setDescription('Force-end the game in your VC (staff)'));
}

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const vc = interaction.member?.voice?.channel;
  if (sub === 'start') {
    if (!opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'Only staff can start a Mafia game.', flags: EPH });
    if (!vc) return interaction.reply({ content: 'Join a voice channel first, then run `/mafia start` there.', flags: EPH });
    if (interaction.channelId !== vc.id) return interaction.reply({ content: `Run \`/mafia start\` from **${vc.name}**'s own text chat (the chat tab inside the voice call), not here.`, flags: EPH });
    if (isActive(vc.id)) return interaction.reply({ content: 'A Mafia game is already running in this VC.', flags: EPH });
    await interaction.reply({ content: '🔪 Starting a Mafia lobby…', flags: EPH });
    return startLobby(interaction.client, interaction.guild, vc, interaction.user.id);
  }
  if (sub === 'status') {
    const game = vc && get(vc.id);
    if (!game) return interaction.reply({ content: 'No Mafia game running in your current voice channel.', flags: EPH });
    const alive = livingIds(game);
    return interaction.reply({ content: `🔪 Phase: **${game.phase}**${game.dayNum ? ` (Day/Night ${game.dayNum})` : ''} · Mode: **${game.mode || 'not set yet'}** · Living: **${alive.length}**/${game.joinOrder.length}`, flags: EPH });
  }
  if (sub === 'end') {
    if (!opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'Only staff can end a Mafia game.', flags: EPH });
    const game = vc && get(vc.id);
    if (!game) return interaction.reply({ content: 'No Mafia game running in your current voice channel.', flags: EPH });
    await interaction.reply({ content: '⏹️ Ending the game…', flags: EPH });
    await announce(interaction.client, game, `⏹️ Game ended early by <@${interaction.user.id}>.`);
    return endGame(interaction.client, interaction.guild, game, null);
  }
}

function isInteraction(i) {
  return (i.isButton?.() || i.isAnySelectMenu?.()) && typeof i.customId === 'string' && i.customId.startsWith('mafia_');
}

async function handleInteraction(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[0], vcId = parts[1];
  const game = get(vcId);
  if (!game) return interaction.reply({ content: 'That game is no longer running.', flags: EPH }).catch(() => {});
  const guild = interaction.guild;

  if (action === 'mafia_join') {
    if (game.phase !== 'lobby') return interaction.reply({ content: 'The lobby has already closed.', flags: EPH });
    const uid = interaction.user.id;
    const inLobby = game.joinOrder.includes(uid);
    if (inLobby) { update(vcId, { joinOrder: game.joinOrder.filter(id => id !== uid) }); }
    else {
      if (game.joinOrder.length >= MAX_PLAYERS) return interaction.reply({ content: `Lobby's full (max ${MAX_PLAYERS}).`, flags: EPH });
      update(vcId, { joinOrder: [...game.joinOrder, uid] });
    }
    await interaction.deferUpdate().catch(() => {});
    return postPanel(interaction.client, get(vcId), lobbyPanel(get(vcId)));
  }
  if (action === 'mafia_startnow') {
    if (!opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'Only staff can start early.', flags: EPH });
    if (game.phase !== 'lobby') return interaction.reply({ content: 'Already started.', flags: EPH });
    await interaction.deferUpdate().catch(() => {});
    return closeLobby(interaction.client, guild, game);
  }
  if (action === 'mafia_settings') {
    if (!opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'Only staff can change the role setup.', flags: EPH });
    return interaction.reply({ ...settingsPanel(vcId), flags: EPH });
  }
  if (action === 'mafia_setrole') {
    if (!opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'Only staff can change the role setup.', flags: EPH });
    const role = parts[2], v = interaction.values[0];
    if (v === 'auto') setRoleSetting(role, { count: 'auto' });
    else if (v === 'off') setRoleSetting(role, { count: 0 });
    else if (role === 'mafia') setRoleSetting(role, { count: Number(v) });
    else { const [c, ch] = v.split(':'); setRoleSetting(role, { count: Number(c), chance: Number(ch) }); }
    await interaction.update(settingsPanel(vcId)).catch(() => {});
    // keep the public lobby panel's "Roles:" line in sync with what staff just picked
    if (get(vcId)?.phase === 'lobby') await postPanel(interaction.client, get(vcId), lobbyPanel(get(vcId))).catch(() => {});
    return;
  }
  if (action === 'mafia_end') {
    if (!opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'Only staff can cancel.', flags: EPH });
    await interaction.deferUpdate().catch(() => {});
    await announce(interaction.client, game, `⏹️ Cancelled by <@${interaction.user.id}>.`);
    return endGame(interaction.client, guild, game, null);
  }
  if (action === 'mafia_role') {
    const p = game.players[interaction.user.id];
    if (!p) return interaction.reply({ content: 'You\'re not in this game.', flags: EPH });
    if (!p.alive) return interaction.reply({ content: `You were **${ROLE_LABEL[p.role]}**. You're out — spectate the rest.`, flags: EPH });
    const teammates = p.role === 'mafia' ? livingMafiaIds(game).filter(id => id !== interaction.user.id) : [];
    return interaction.reply({ content: `${ROLE_LABEL[p.role]}\n${ROLE_DESC[p.role]}${teammates.length ? `\n\n**Your fellow Mafia:** ${teammates.map(id => `<@${id}>`).join(', ')}` : ''}`, flags: EPH, allowedMentions: { parse: [] } });
  }
  if (action === 'mafia_act') {
    const kind = parts[2];   // kill | save | investigate
    const needRole = kind === 'kill' ? 'mafia' : kind === 'save' ? 'doctor' : 'detective';
    const p = game.players[interaction.user.id];
    if (game.phase !== 'night') return interaction.reply({ content: 'It\'s not Night.', flags: EPH });
    if (!p || !p.alive || p.role !== needRole) return interaction.reply({ content: `That's not your role.`, flags: EPH });
    const targets = livingIds(game).filter(id => id !== interaction.user.id && !(kind === 'kill' && game.players[id].role === 'mafia'));
    if (!targets.length) return interaction.reply({ content: 'No valid targets right now.', flags: EPH });
    const sel = new StringSelectMenuBuilder().setCustomId(`mafia_target:${vcId}:${kind}`).setPlaceholder('Pick a target…')
      .addOptions(targets.slice(0, 25).map(id => ({ label: game.players[id]?.name || id, value: id })));
    return interaction.reply({ content: kind === 'kill' ? '🔪 Vote for who Mafia kills tonight:' : kind === 'save' ? '💉 Who do you protect tonight?' : '🔎 Who do you investigate tonight?', components: [new ActionRowBuilder().addComponents(sel)], flags: EPH });
  }
  if (action === 'mafia_target') {
    const kind = parts[2];
    const targetId = interaction.values[0];
    if (game.phase !== 'night') return interaction.update({ content: 'It\'s not Night anymore.', components: [] }).catch(() => {});
    if (kind === 'kill') {
      const votes = { ...game.night.mafiaVotes, [interaction.user.id]: targetId };
      update(vcId, { night: { ...game.night, mafiaVotes: votes } });
      return interaction.update({ content: `🔪 Your vote: <@${targetId}>. The team's plurality target is used when Night resolves.`, components: [], allowedMentions: { parse: [] } });
    }
    if (kind === 'save') {
      update(vcId, { night: { ...game.night, doctorPick: targetId } });
      return interaction.update({ content: `💉 You'll protect <@${targetId}> tonight.`, components: [], allowedMentions: { parse: [] } });
    }
    // investigate — reveal immediately (no DM/later delivery mechanism; ephemeral now is the only option)
    update(vcId, { night: { ...game.night, detectivePick: targetId } });
    const isMafia = get(vcId).players[targetId]?.role === 'mafia';
    return interaction.update({ content: `🔎 <@${targetId}> is **${isMafia ? 'Mafia-aligned' : 'not Mafia-aligned'}**.`, components: [], allowedMentions: { parse: [] } });
  }
  if (action === 'mafia_vote') {
    const targetId = interaction.values[0];
    if (game.phase !== 'day') return interaction.reply({ content: 'It\'s not Day.', flags: EPH });
    const p = game.players[interaction.user.id];
    if (!p || !p.alive) return interaction.reply({ content: 'You\'re not in this game (or already out).', flags: EPH });
    const votes = { ...game.day.votes, [interaction.user.id]: targetId };
    update(vcId, { day: { ...game.day, votes } });
    await interaction.reply({ content: `🗳️ Voted <@${targetId}>.`, flags: EPH, allowedMentions: { parse: [] } });
    return postPanel(interaction.client, get(vcId), dayPanel(get(vcId), get(vcId).lastResultLine || ''));
  }
}

// ---- backstop sweep: advances any game whose phase deadline has passed. Sole timer driver (see file
// header) — also doubles as boot-reconcile for free, since an overdue phase just gets picked up here. ---
async function sweepExpiredPhases(client) {
  for (const game of allActive()) {
    const guild = client.guilds.cache.get(game.guildId) || await client.guilds.fetch(game.guildId).catch(() => null);
    if (!guild) { clear(game.vcId); continue; }
    if (game.phase === 'lobby') { if (Date.now() >= game.lobbyDeadline) await closeLobby(client, guild, game).catch(e => console.error('[mafia] closeLobby:', e.message)); continue; }
    if (game.phase === 'night') { if (Date.now() >= game.phaseDeadline) await resolveNight(client, guild, game).catch(e => console.error('[mafia] resolveNight:', e.message)); continue; }
    if (game.phase === 'day') { if (Date.now() >= game.phaseDeadline) await resolveDay(client, guild, game).catch(e => console.error('[mafia] resolveDay:', e.message)); continue; }
  }
}

// Boot RESUME: games persist across restarts. State is written on every mutation, so the game itself
// survives on disk — what needs re-establishing is the live Discord side: a game whose VC/channel is
// gone can never finish (drop it, releasing anyone it had muted), and a surviving voice game's
// mute/deafen state has to be re-applied (server-mutes do outlive a restart, but someone who joined
// the VC while the bot was down, or a phase that advanced in the meantime, would be out of sync).
// Panels need no repair — their buttons carry the vcId and every handler reads live state.
async function bootResume(client) {
  const active = allActive();
  if (!active.length) return;
  let resumed = 0, dropped = 0;
  for (const g of active) {
    const guild = client.guilds.cache.get(g.guildId) || await client.guilds.fetch(g.guildId).catch(() => null);
    const vc = guild && (guild.channels.cache.get(g.vcId) || await guild.channels.fetch(g.vcId).catch(() => null));
    if (!guild || !vc) {
      if (guild) await releaseAllVoices(guild, g).catch(() => {});
      clear(g.vcId); dropped++; continue;
    }
    if (g.mode === 'voice' && (g.phase === 'night' || g.phase === 'day')) await applyVoicePhase(guild, g).catch(e => console.error('[mafia] resume voice:', e.message));
    resumed++;
  }
  if (resumed || dropped) console.log(`[mafia] boot: resumed ${resumed} game(s)${dropped ? `, dropped ${dropped} (VC gone)` : ''}`);
}

function register(client) {
  load();
  // Resume first, THEN sweep immediately — a phase whose deadline passed while the bot was down
  // resolves right away instead of idling up to a full tick.
  bootResume(client)
    .catch(e => console.error('[mafia] bootResume:', e.message))
    .then(() => sweepExpiredPhases(client).catch(e => console.error('[mafia] boot sweep:', e.message)));
  setInterval(() => sweepExpiredPhases(client).catch(e => console.error('[mafia] sweep:', e.message)), SWEEP_MS);

  // Voice disconnect handling (voice-mode games only): unconditionally release anyone leaving a game's VC
  // so they're never left stuck muted/deafened elsewhere (mirrors amongus's own leave-handling reasoning).
  // Grace period: leaving mid-phase doesn't ghost them by itself — only an unresolved Night action still
  // missing when that phase's deadline hits (checked in resolveNight, which only counts votes/picks that
  // were actually submitted) counts as "disrupted the game." Villagers/Day voting are never penalized for
  // being disconnected — abstaining is normal.
  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const left = oldState.channelId && games[oldState.channelId] && newState.channelId !== oldState.channelId;
      if (!left) return;
      const g = games[oldState.channelId];
      if (g.mode !== 'voice') return;
      const m = newState.member || oldState.member;
      if (m) await releaseVoice(m);
    } catch (e) { console.error('[mafia] voiceStateUpdate:', e.message); }
  });
}

module.exports = { commandBuilder, handleCommand, isInteraction, handleInteraction, register, isActive, get,
  // pure helpers, exported for verification (no Discord dependency)
  roleCounts, assignRoles, checkWin, pluralityTarget, livingIds, livingMafiaIds,
  getSettings, setRoleSetting, describeSettings, load, save, update, clear, allActive };
