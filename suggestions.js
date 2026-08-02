// suggestions.js - bot-gated suggestions forum. Members can't open posts directly (the forum denies
// Create Posts to @everyone); they run /suggest and the BOT opens the post on their behalf, which lets
// us enforce real growth caps that Discord's native slowmode can't:
//   • max 1 OPEN suggestion per member (frees when staff approve/deny)   • per-member cooldown
//   • content filtered through the watchlist matcher (no slurs/threats)  • required "Pending" tag
//   • ⬆/⬇ member voting + staff ✅approve/❌deny → auto-archives the post
// Self-contained: owns two JSON files (config = forum/tag ids; state = per-post records + cooldowns),
// mirroring how watchlist.js manages its own store. Nothing here needs a redeploy to reconfigure.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const watchlist = require('./watchlist');
const copy = require('./copy');

const CONFIG_FILE = process.env.FUBU_SUGGESTIONS_FILE || '/home/ubuntu/.fubu_suggestions.json';
const STATE_FILE = process.env.FUBU_SUGGESTIONS_STATE_FILE || '/home/ubuntu/.fubu_suggestions_state.json';
const COOLDOWN_MS = 10 * 60 * 1000;   // 10 min between suggestions per member
const MAX_OPEN = 3;                    // open suggestions a member may hold at once
const MIN_LEN = 5, MAX_LEN = 500;

const P = PermissionsBitField.Flags;
const TAGS = [                          // moderated:true → only the bot (ManageThreads) can apply/remove
  { key: 'pending', name: 'Pending', emoji: '🕐' },
  { key: 'approved', name: 'Approved', emoji: '✅' },
  { key: 'denied', name: 'Denied', emoji: '❌' },
  { key: 'implemented', name: 'Implemented', emoji: '🎉' },
];

function _load(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[suggestions] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { counter: 0, posts: {}, cooldown: {} });
const saveState = s => _save(STATE_FILE, s);

function isConfigured() { const c = loadConfig(); return !!(c.forumId && c.tags && c.tags.pending); }

// ---- one-time setup: create the forum + tags, lock post-creation to the bot -------------------------
async function setup(guild, config) {
  let c = loadConfig();
  if (c.forumId) {
    const existing = await guild.channels.fetch(c.forumId).catch(() => null);
    if (existing) return { forum: existing, created: false };
  }
  const everyone = guild.id;
  const perms = [
    { id: everyone, deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads],
      allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions, P.SendMessagesInThreads] },
  ];
  // verified role (if configured) mirrors @everyone - comment+react+vote but not create posts
  const forum = await guild.channels.create({
    name: '💡┆suggestions', type: ChannelType.GuildForum,
    topic: 'Use /suggest to post an idea. The bot opens it here with ⬆/⬇ voting. One open suggestion per person; staff approve or deny.',
    permissionOverwrites: perms,
    availableTags: TAGS.map(t => ({ name: t.name, moderated: true, emoji: { id: null, name: t.emoji } })),
    defaultAutoArchiveDuration: 4320,          // 3 days idle → archive (staff action archives sooner)
    defaultThreadRateLimitPerUser: 10,         // in-post slowmode
    reason: 'Bot-gated suggestions forum (owner request)',
  });
  const fresh = await guild.channels.fetch(forum.id);
  const tagMap = {};
  for (const t of TAGS) { const found = fresh.availableTags.find(x => x.name === t.name); if (found) tagMap[t.key] = found.id; }
  c = { forumId: forum.id, tags: tagMap };
  saveConfig(c);
  return { forum: fresh, created: true };
}

// ---- vote button rows -------------------------------------------------------------------------------
// customIds are STATIC (no thread id baked in) - a button lives on the post's starter message, so at
// click time interaction.channelId IS the thread id. That avoids the create-then-edit race.
function voteRow(up, down, resolved) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sug_up').setEmoji('⬆️').setLabel(String(up)).setStyle(ButtonStyle.Success).setDisabled(!!resolved),
    new ButtonBuilder().setCustomId('sug_down').setEmoji('⬇️').setLabel(String(down)).setStyle(ButtonStyle.Danger).setDisabled(!!resolved),
  );
}
function staffRow(resolved) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sug_ok').setEmoji('✅').setLabel('Approve').setStyle(ButtonStyle.Secondary).setDisabled(!!resolved),
    new ButtonBuilder().setCustomId('sug_no').setEmoji('❌').setLabel('Deny').setStyle(ButtonStyle.Secondary).setDisabled(!!resolved),
  );
}
function postEmbed(num, text, authorId, { up = 0, down = 0, resolution } = {}) {
  const e = new EmbedBuilder().setColor(resolution === 'approved' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0xFEE75C)
    .setTitle(`💡 Suggestion #${num}`).setDescription(text)
    .addFields({ name: 'Suggested by', value: `<@${authorId}>`, inline: true }, { name: 'Votes', value: `⬆️ ${up} · ⬇️ ${down}`, inline: true });
  if (resolution) e.addFields({ name: 'Status', value: resolution === 'approved' ? '✅ Approved' : '❌ Denied', inline: true });
  return e;
}

// ---- submit a suggestion ----------------------------------------------------------------------------
function openCountFor(state, authorId) {
  return Object.values(state.posts).filter(p => p.authorId === authorId && p.status === 'open').length;
}
async function submit(guild, member, text) {
  const c = loadConfig();
  if (!c.forumId) return { ok: false, msg: copy.suggestions.notSetup };
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (text.length < MIN_LEN) return { ok: false, msg: copy.suggestions.tooShort(MIN_LEN) };
  if (text.length > MAX_LEN) return { ok: false, msg: copy.suggestions.tooLong(MAX_LEN) };
  // content filter - reuse the watchlist matcher across all three lists
  const bad = watchlist.matchTerms(text, [...new Set([...watchlist.loadTerms(), ...watchlist.loadLoose(), ...watchlist.loadWelfare()])]);
  if (bad.length) return { ok: false, msg: copy.suggestions.filtered };

  const state = loadState();
  const last = state.cooldown[member.id] || 0;
  const waitLeft = COOLDOWN_MS - (Date.now() - last);
  if (last && waitLeft > 0) return { ok: false, msg: copy.common.onCooldown(Math.ceil(waitLeft / 60000)) };
  if (openCountFor(state, member.id) >= MAX_OPEN) return { ok: false, msg: copy.suggestions.openLimit };

  const forum = await guild.channels.fetch(c.forumId).catch(() => null);
  if (!forum) return { ok: false, msg: copy.suggestions.forumMissing };
  const num = (state.counter || 0) + 1;
  const title = `#${num} · ${text}`.slice(0, 95);
  const thread = await forum.threads.create({
    name: title,
    message: { embeds: [postEmbed(num, text, member.id)], components: [voteRow(0, 0), staffRow()] },
    appliedTags: c.tags.pending ? [c.tags.pending] : [],
    reason: `Suggestion by ${member.user.tag}`,
  });
  state.counter = num;
  state.posts[thread.id] = { num, authorId: member.id, status: 'open', up: [], down: [], text };
  state.cooldown[member.id] = Date.now();
  saveState(state);
  return { ok: true, threadId: thread.id, num };
}

// ---- voting -----------------------------------------------------------------------------------------
async function vote(interaction, dir) {
  const threadId = interaction.channelId;
  const state = loadState();
  const post = state.posts[threadId];
  if (!post) return interaction.reply({ content: copy.suggestions.untracked, flags: MessageFlags.Ephemeral });
  if (post.status !== 'open' && post.status !== 'approved') return interaction.reply({ content: copy.suggestions.votingClosed, flags: MessageFlags.Ephemeral });
  const uid = interaction.user.id;
  const up = new Set(post.up), down = new Set(post.down);
  if (dir === 'up') { if (up.has(uid)) up.delete(uid); else { up.add(uid); down.delete(uid); } }
  else { if (down.has(uid)) down.delete(uid); else { down.add(uid); up.delete(uid); } }
  post.up = [...up]; post.down = [...down];
  saveState(state);
  const emb = postEmbed(post.num, post.text, post.authorId, { up: up.size, down: down.size });
  return interaction.update({ embeds: [emb], components: [voteRow(up.size, down.size), staffRow()] });
}

// ---- staff resolve (approve/deny) -------------------------------------------------------------------
async function resolve(interaction, approve, config) {
  const threadId = interaction.channelId;
  const state = loadState();
  const post = state.posts[threadId];
  if (!post) return interaction.reply({ content: copy.suggestions.untracked, flags: MessageFlags.Ephemeral });
  if (post.status !== 'open') return interaction.reply({ content: copy.suggestions.alreadyResolved, flags: MessageFlags.Ephemeral });
  const c = loadConfig();
  post.status = approve ? 'approved' : 'denied';
  saveState(state);
  const emb = postEmbed(post.num, post.text, post.authorId, { up: post.up.length, down: post.down.length, resolution: post.status });
  emb.addFields({ name: approve ? 'Approved by' : 'Denied by', value: `<@${interaction.user.id}>`, inline: true });
  // Approved suggestions stay OPEN + VISIBLE so members keep voting; only DENIED ones get closed.
  await interaction.update({ embeds: [emb], components: [voteRow(post.up.length, post.down.length, !approve), staffRow(true)] });
  const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
  if (thread) {
    const tagId = approve ? c.tags.approved : c.tags.denied;
    await thread.setAppliedTags(tagId ? [tagId] : []).catch(() => {});
    if (!approve) { await thread.setLocked(true).catch(() => {}); await thread.setArchived(true).catch(() => {}); }
  }
}

async function handleButton(interaction, config) {
  const id = interaction.customId;
  if (id === 'sug_up') return vote(interaction, 'up');
  if (id === 'sug_down') return vote(interaction, 'down');
  if (id === 'sug_ok') return resolve(interaction, true, config);
  if (id === 'sug_no') return resolve(interaction, false, config);
}

module.exports = { setup, submit, handleButton, isConfigured, loadConfig, CONFIG_FILE, STATE_FILE };
