// staffapps.js — a factory for application-gated staff-floor positions (owner, 2026-08-22). The mod /
// event-organizer / advertiser application flows are all the same shape: a forum review post with an
// anonymous 👍/👎 advisory vote, a private applicant thread, admin Accept/Deny/Undo, and Accept grants a
// role. Rather than copy that ~250-line module a fourth/fifth/sixth time, makeStaffApp(spec) builds one
// from a small spec. (eventorgapps.js predates this and stays as-is — proven + live; it could migrate
// onto this later. advertiserapps.js was retired when Advertiser merged into the Media Team position.)
//
// A position also gets a private coordination channel under the Staff category, plus any EXTRA channels
// its spec asks for (e.g. Content Creator's public #showcase) via spec.extraSetup.
//
// spec = {
//   key,                    // 'creator' — customId prefix (`${key}app_*`), state-file base, feature key base
//   label,                  // 'Content Creator' — human name in copy
//   emoji,                  // '🎬'
//   roleId: () => string,   // getter for the role this grants (empty => whole feature inert)
//   applyCmd,               // 'apply-creator' — shown in "aren't set up" hints
//   questions: [{ id, label, field, style, required, max }],  // label = modal prompt, field = embed field name
//   forumName, appsName, coordName,   // channel names (small-caps per server style)
//   coordTopic,             // topic for the coordination channel
//   extraSetup?: async (guild, cfg, c) => {},  // create/repair extra channels, mutate c (saved after)
//   acceptedMsg?, deniedMsg?,          // applicant-thread messages (functions of roleGiven)
// }
const fs = require('fs');
const { statePath } = require('./statepath');
const { withLock } = require('./mutex');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const opspanel = require('./opspanel');
const ownerlog = require('./ownerlog');

const P = PermissionsBitField.Flags;
const VOTE_WEIGHT = { mod: 1, admin: 2, owner: 3 };
const TAGS = [
  { key: 'pending', name: 'Pending', emoji: '🕐' },
  { key: 'accepted', name: 'Accepted', emoji: '✅' },
  { key: 'denied', name: 'Denied', emoji: '❌' },
];
// Slot a just-created channel into a SENSIBLE spot in its category (owner, 2026-08-22: "keep an order
// as well. don't just place at the top" + "insert at a place that makes sense") — Discord drops a new
// channel at the TOP of its parent, shoving everything down. Instead, place it right after the most
// similar existing sibling: first preference is a name-token match (e.g. an application forum lands
// next to the other "…ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴꜱ"/"…ᴀᴘᴘꜱ" channels), else next to the last sibling of the SAME TYPE
// (forum-with-forums), else the bottom. Higher position = further down (channel convention). No-op for
// a parent-less channel. `hintTokens` = extra words to match on beyond the name's own.
async function placeSensibly(guild, channel, hintTokens = []) {
  try {
    if (!channel.parentId) return;
    await guild.channels.fetch();
    const sibs = [...guild.channels.cache.values()].filter(c => c && c.parentId === channel.parentId && c.id !== channel.id
      && c.type !== ChannelType.GuildVoice && c.type !== ChannelType.GuildStageVoice);
    if (!sibs.length) return;
    // Tokenize the smallcaps names into comparable ascii-ish chunks (strip the emoji/separator prefix).
    const toks = name => (name.split('┆').pop() || name).split(/[-\s]+/).filter(t => t.length >= 3);
    const mine = new Set([...toks(channel.name), ...hintTokens]);
    const scored = sibs.map(c => ({ c, score: toks(c.name).filter(t => mine.has(t)).length }));
    const best = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score || b.c.rawPosition - a.c.rawPosition)[0];
    const sameType = sibs.filter(c => c.type === channel.type).sort((a, b) => b.rawPosition - a.rawPosition)[0];
    const anchor = best?.c || sameType || sibs.sort((a, b) => b.rawPosition - a.rawPosition)[0];
    // Place immediately AFTER the anchor. Use the BULK setPositions endpoint, not channel.setPosition() —
    // the latter proved unreliable for cross-category moves (it silently left the channel at the top);
    // guild.channels.setPositions([{ channel, position }]) actually moves it (verified live 2026-08-22).
    await guild.channels.setPositions([{ channel: channel.id, position: anchor.rawPosition + 1 }]).catch(() => {});
  } catch { /* ordering is best-effort */ }
}
const idOf = e => (typeof e === 'object' && e !== null) ? e.id : e;
const weightOf = e => (typeof e === 'object' && e !== null) ? (e.w || 1) : 1;
const sumWeight = list => (list || []).reduce((s, e) => s + weightOf(e), 0);

function makeStaffApp(spec) {
  const CONFIG_FILE = process.env[`FUBU_${spec.key.toUpperCase()}APPS_FILE`] || statePath(`${spec.key}apps.json`);
  const STATE_FILE = process.env[`FUBU_${spec.key.toUpperCase()}APPS_STATE_FILE`] || statePath(`${spec.key}apps_state.json`);
  const roleId = () => (spec.roleId() || '');
  const cid = s => `${spec.key}app_${s}`;   // customId helper

  function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
  function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error(`[${spec.key}apps] save:`, e.message); } }
  const loadConfig = () => _load(CONFIG_FILE, {});
  const saveConfig = c => _save(CONFIG_FILE, c);
  const loadState = () => _load(STATE_FILE, { posts: {} });
  const saveState = s => _save(STATE_FILE, s);
  function isConfigured() { const c = loadConfig(); return !!(roleId() && c.forumId && c.appsChannelId && c.tags); }
  function canVote(member) { return !!(opspanel.memberTier(member) || (roleId() && member?.roles?.cache?.has(roleId()))); }
  function coordChannelId() { return loadConfig().coordChannelId || null; }

  const DEFAULT_CLOSED_NOTICE = `🚫 ${spec.label} applications are currently **closed**. Thanks for the interest, keep an eye out for when they reopen!`;
  function applicationsOpen() { return loadConfig().closed !== true; }
  function closedNotice() { const n = (loadConfig().closedNotice || '').trim(); return n || DEFAULT_CLOSED_NOTICE; }
  async function setApplicationsOpen(guild, open, message) {
    const c = loadConfig();
    c.closed = !open;
    if (typeof message === 'string' && message.trim()) c.closedNotice = message.trim();
    saveConfig(c);
    try {
      const ch = c.appsChannelId && await guild.channels.fetch(c.appsChannelId).catch(() => null);
      if (ch && ch.setTopic) {
        const base = `Apply with /${spec.applyCmd}. Your application opens as a private thread here that only you + staff can see.`;
        await ch.setTopic(open ? base : `🚫 Applications are CLOSED. ${base}`).catch(() => {});
      }
    } catch { /* best-effort */ }
    return { open };
  }

  async function setup(guild, appConfig) {
    if (!roleId()) return { error: 'no-role' };
    let c = loadConfig();
    const wl = appConfig?.watchLogChannelId ? await guild.channels.fetch(appConfig.watchLogChannelId).catch(() => null) : null;
    const staffOverwrites = (wl && wl.permissionOverwrites.cache.size)
      ? [...wl.permissionOverwrites.cache.values()].map(o => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
      : [{ id: guild.id, deny: [P.ViewChannel] }];
    // Staff-facing channels get a parent category (owner, 2026-08-22: "stop creating channels with no
    // category" — only the public-facing applicant channel below may be category-less). Review forum +
    // coord both sit under the Staff category.
    const staffParent = (appConfig?.staffCategoryId && await guild.channels.fetch(appConfig.staffCategoryId).catch(() => null)) ? appConfig.staffCategoryId : null;
    let forum = c.forumId ? await guild.channels.fetch(c.forumId).catch(() => null) : null;
    if (!forum) {
      forum = await guild.channels.create({
        name: spec.forumName, type: ChannelType.GuildForum, parent: staffParent,
        topic: `${spec.label} applications - staff + current ${spec.label}s review. Anonymous 👍/👎; admins/owners decide.`,
        permissionOverwrites: [...staffOverwrites, { id: roleId(), allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads] }],
        availableTags: TAGS.map(t => ({ name: t.name, moderated: true, emoji: { id: null, name: t.emoji } })),
        defaultAutoArchiveDuration: 10080, reason: `${spec.label} applications review forum`,
      });
      if (opspanel.MOD_ROLE_ID) await forum.permissionOverwrites.edit(opspanel.MOD_ROLE_ID, { ManageThreads: false }, { reason: 'vote only; thread-member management is admin+' }).catch(() => {});
      await forum.permissionOverwrites.edit(roleId(), { ManageThreads: false }, { reason: 'vote only; thread-member management is admin+' }).catch(() => {});
      const fresh = await guild.channels.fetch(forum.id);
      const tagMap = {}; for (const t of TAGS) { const f = fresh.availableTags.find(x => x.name === t.name); if (f) tagMap[t.key] = f.id; }
      c.forumId = forum.id; c.tags = tagMap;
      await placeSensibly(guild, forum, ['ᴀᴘᴘꜱ', 'ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴꜱ']);
    }
    // The applicant channel is the ONE exception to the category rule — it's the public-facing application,
    // deliberately left category-less (owner, 2026-08-22).
    let apps = c.appsChannelId ? await guild.channels.fetch(c.appsChannelId).catch(() => null) : null;
    if (!apps) {
      apps = await guild.channels.create({
        name: spec.appsName, type: ChannelType.GuildText,
        topic: `Apply with /${spec.applyCmd}. Your application opens as a private thread here that only you + staff can see.`,
        permissionOverwrites: [{ id: guild.id,
          allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
          deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
        reason: `${spec.label} application applicant threads`,
      });
      c.appsChannelId = apps.id;
    }
    // Private coordination channel, under the Staff category so it inherits the staff-only structure.
    let coord = c.coordChannelId ? await guild.channels.fetch(c.coordChannelId).catch(() => null) : null;
    if (!coord) {
      const staffAllow = [opspanel.MOD_ROLE_ID, opspanel.ADMIN_ROLE_ID, ...(opspanel.OWNER_ROLE_IDS || [])]
        .filter(Boolean).map(id => ({ id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] }));
      coord = await guild.channels.create({
        name: spec.coordName, type: ChannelType.GuildText, parent: staffParent,
        topic: spec.coordTopic || `${spec.label} + staff coordination.`,
        permissionOverwrites: [
          { id: guild.id, deny: [P.ViewChannel] },
          { id: roleId(), allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
          ...staffAllow,
        ],
        reason: `${spec.label} coordination channel (under Staff category)`,
      });
      c.coordChannelId = coord.id;
      await placeSensibly(guild, coord);   // shares its label token with the forum → they sit together
    }
    if (spec.extraSetup) await spec.extraSetup(guild, appConfig, c);   // e.g. the Media Team's #showcase
    saveConfig(c);
    return { forum, apps, coord, config: c, created: true };
  }

  function buildModal() {
    const m = new ModalBuilder().setCustomId(cid('submit')).setTitle(`${spec.label} application`.slice(0, 45));
    for (const q of spec.questions) m.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(q.id).setLabel(q.label).setStyle(q.style).setRequired(q.required).setMaxLength(q.max)));
    return m;
  }

  const voteRow = (up, down, done) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('up')).setEmoji('👍').setLabel(String(up)).setStyle(ButtonStyle.Success).setDisabled(!!done),
    new ButtonBuilder().setCustomId(cid('down')).setEmoji('👎').setLabel(String(down)).setStyle(ButtonStyle.Danger).setDisabled(!!done));
  const decideRow = (done) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('accept')).setEmoji('✅').setLabel('Accept').setStyle(ButtonStyle.Secondary).setDisabled(!!done),
    new ButtonBuilder().setCustomId(cid('deny')).setEmoji('❌').setLabel('Deny').setStyle(ButtonStyle.Secondary).setDisabled(!!done));
  const undoRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('undo')).setEmoji('↩️').setLabel('Undo decision').setStyle(ButtonStyle.Secondary));
  const reviewComponents = (post, done) => [voteRow(post.up?.length || 0, post.down?.length || 0, done), decideRow(done)];

  function reviewEmbed(post, answers, resolution, byId) {
    const tally = sumWeight(post.up) - sumWeight(post.down);
    const e = new EmbedBuilder().setColor(resolution === 'accepted' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0x5865F2)
      .setTitle(`${spec.emoji} ${spec.label} application`)
      .addFields({ name: 'Applicant', value: `<@${post.applicantId}>`, inline: true });
    for (const q of spec.questions) e.addFields({ name: q.field, value: (answers[q.id] || '-').slice(0, 1024), inline: !!q.inline });
    e.addFields({ name: '💬 Applicant thread', value: post.appThreadId ? `<#${post.appThreadId}> · jump here to message them (opens only for staff)` : '-', inline: false });
    e.addFields({ name: 'Staff tally (anon)', value: `👍 ${post.up?.length || 0} · 👎 ${post.down?.length || 0} voter(s) · **weighted = ${tally}**`, inline: true });
    if (resolution) e.addFields({ name: resolution === 'accepted' ? '✅ Accepted by' : '❌ Denied by', value: `<@${byId}>`, inline: true });
    e.setFooter({ text: 'Staff 👍/👎 is anonymous + advisory. Admins/owners decide.' });
    return e;
  }
  function answersFromEmbed(em) {
    const g = n => em?.fields?.find(f => f.name === n)?.value;
    const out = {}; for (const q of spec.questions) out[q.id] = g(q.field); return out;
  }

  // Serialized behind a per-position lock (audit U10): load->awaits->save read-modify-write — two
  // concurrent applications used to lose the earlier one's record (the appeals.js incident class).
  async function submitFromModal(interaction) { return withLock(`staffapp:${spec.key}`, () => _submitFromModal(interaction)); }
  async function _submitFromModal(interaction) {
    const c = loadConfig();
    if (!isConfigured()) return interaction.reply({ content: `${spec.label} applications aren’t set up yet. An admin needs to open \`/panel\` → 🧩 Setup → ${spec.emoji} ${spec.label} apps.`, flags: MessageFlags.Ephemeral });
    if (!applicationsOpen()) return interaction.reply({ content: closedNotice(), flags: MessageFlags.Ephemeral });
    const state = loadState();
    if (Object.values(state.posts).find(p => p.applicantId === interaction.user.id && p.status === 'open'))
      return interaction.reply({ content: 'You already have an open application — wait for a decision before applying again.', flags: MessageFlags.Ephemeral });
    const answers = {}; for (const q of spec.questions) { try { answers[q.id] = interaction.fields.getTextInputValue(q.id); } catch { answers[q.id] = ''; } }
    const member = interaction.member;
    const forum = await interaction.guild.channels.fetch(c.forumId).catch(() => null);
    const appsCh = await interaction.guild.channels.fetch(c.appsChannelId).catch(() => null);
    if (!forum || !appsCh) return interaction.reply({ content: `Something’s misconfigured — ask an admin to re-run \`/panel\` → 🧩 Setup → ${spec.emoji} ${spec.label} apps.`, flags: MessageFlags.Ephemeral });

    const appThread = await appsCh.threads.create({
      name: `Application · ${member.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
      reason: `${spec.label} application by ${member.user.tag}`,
    });
    await appThread.members.add(member.id).catch(() => {});
    const applicantEmbed = new EmbedBuilder().setColor(0x5865F2).setTitle('Your application');
    for (const q of spec.questions) applicantEmbed.addFields({ name: q.field, value: (answers[q.id] || '-').slice(0, 1024), inline: !!q.inline });
    await appThread.send({ content: `${spec.emoji} <@${member.id}>, this is your ${spec.label} application. Staff will review it and follow up here if they have questions.`,
      embeds: [applicantEmbed], allowedMentions: { users: [member.id] } }).catch(() => {});

    const post = { applicantId: member.id, appThreadId: appThread.id, status: 'open', up: [], down: [] };
    const review = await forum.threads.create({
      name: `App · ${member.user.username}`.slice(0, 95),
      message: { embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) },
      appliedTags: c.tags.pending ? [c.tags.pending] : [], reason: `${spec.label} application review - ${member.user.tag}`,
    });
    state.posts[review.id] = post; saveState(state);
    return interaction.reply({ content: `${spec.emoji} Application submitted! Follow along or answer follow-ups in <#${appThread.id}>.`, flags: MessageFlags.Ephemeral });
  }

  async function vote(interaction, dir) {
    const state = loadState(); const post = state.posts[interaction.channelId];
    if (!post || post.status !== 'open') return interaction.reply({ content: 'This application isn’t open for voting.', flags: MessageFlags.Ephemeral });
    const uid = interaction.user.id;
    const w = VOTE_WEIGHT[opspanel.memberTier(interaction.member)] || 1;
    const up = (post.up || []).filter(e => idOf(e) !== uid), down = (post.down || []).filter(e => idOf(e) !== uid);
    const wasIn = ((dir === 'up' ? post.up : post.down) || []).some(e => idOf(e) === uid);
    if (!wasIn) (dir === 'up' ? up : down).push({ id: uid, w });
    post.up = up; post.down = down; saveState(state);
    const starter = await interaction.channel.fetchStarterMessage().catch(() => null);
    const answers = starter ? answersFromEmbed(starter.embeds[0]) : {};
    await interaction.update({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) });
    return interaction.followUp({ content: wasIn ? `Your ${dir === 'up' ? '👍' : '👎'} was removed.` : `Your ${dir === 'up' ? '👍' : '👎'} is counted (anonymous).`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  async function resolve(interaction, accepted) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const state = loadState(); const post = state.posts[interaction.channelId];
    if (!post) return interaction.editReply({ content: 'This application isn’t tracked (posted before a restart, or already resolved).' });
    if (post.status !== 'open') return interaction.editReply({ content: 'Already resolved.' });
    post.status = accepted ? 'accepted' : 'denied'; saveState(state);
    const member = await interaction.guild.members.fetch(post.applicantId).catch(() => null);
    let roleGiven = false;
    if (accepted && member && roleId()) roleGiven = await member.roles.add(roleId(), `${spec.label} app accepted by ${interaction.user.tag}`).then(() => true).catch(() => false);
    const reviewThread = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
    const reviewMsg = reviewThread && await reviewThread.fetchStarterMessage().catch(() => null);
    if (reviewMsg) {
      const answers = answersFromEmbed(reviewMsg.embeds[0]);
      await reviewMsg.edit({ embeds: [reviewEmbed(post, answers, post.status, interaction.user.id)], components: [...reviewComponents(post, true), undoRow()] }).catch(() => {});
    }
    const appThread = await interaction.guild.channels.fetch(post.appThreadId).catch(() => null);
    if (appThread) {
      await appThread.send(accepted
        ? (spec.acceptedMsg ? spec.acceptedMsg(roleGiven) : `🎉 Your ${spec.label} application was **accepted**!${roleGiven ? ` You’ve been given the **${spec.label}** role. ${spec.emoji}` : ''} Open \`/panel\` for your tools.`)
        : (spec.deniedMsg || `Thanks for applying. Your ${spec.label} application wasn’t accepted this time. You’re welcome to apply again later.`)).catch(() => {});
      await appThread.setArchived(true).catch(() => {});
    }
    const tagCfg = loadConfig();
    if (reviewThread) { await reviewThread.setAppliedTags([accepted ? tagCfg.tags.accepted : tagCfg.tags.denied].filter(Boolean)).catch(() => {}); await reviewThread.setLocked(true).catch(() => {}); await reviewThread.setArchived(true).catch(() => {}); }
    await ownerlog.log(interaction.guild, { emoji: accepted ? '✅' : '❌', title: `${spec.label} application ${accepted ? 'accepted' : 'denied'}`, color: accepted ? 0x57F287 : 0xED4245,
      detail: `<@${post.applicantId}> — by <@${interaction.user.id}>.` });
    return interaction.editReply({ content: accepted ? (roleGiven ? `✅ Accepted. Gave them the **${spec.label}** role.` : `✅ Accepted (couldn’t assign the role, check role hierarchy).`) : '❌ Denied. Applicant was notified in their thread.' });
  }

  async function undo(interaction) {
    const state = loadState(); const post = state.posts[interaction.channelId];
    if (!post) return interaction.reply({ content: 'This application isn’t tracked.', flags: MessageFlags.Ephemeral });
    if (post.status === 'open') return interaction.reply({ content: 'Already open.', flags: MessageFlags.Ephemeral });
    const c = loadConfig();
    const wasAccepted = post.status === 'accepted';
    await interaction.deferUpdate();
    const member = await interaction.guild.members.fetch(post.applicantId).catch(() => null);
    let roleRemoved = false;
    if (wasAccepted && member && roleId()) roleRemoved = await member.roles.remove(roleId(), `${spec.label} acceptance undone by ${interaction.user.tag}`).then(() => true).catch(() => false);
    post.status = 'open'; saveState(state);
    const review = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
    if (review) { await review.setArchived(false).catch(() => {}); await review.setLocked(false).catch(() => {}); await review.setAppliedTags(c.tags?.pending ? [c.tags.pending] : []).catch(() => {}); }
    const answers = answersFromEmbed(interaction.message.embeds[0]);
    await interaction.editReply({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) }).catch(() => {});
    const appThread = post.appThreadId ? await interaction.guild.channels.fetch(post.appThreadId).catch(() => null) : null;
    if (appThread) { await appThread.setArchived(false).catch(() => {}); await appThread.send('↩️ Quick update: your application has been reopened for another look. Hang tight; staff will follow up here.').catch(() => {}); }
    await ownerlog.log(interaction.guild, { emoji: '↩️', title: `${spec.label} decision undone`, color: 0xF1C40F,
      detail: `<@${post.applicantId}> — was ${wasAccepted ? 'accepted' : 'denied'}, reopened${roleRemoved ? ` (removed ${spec.label})` : ''} — by <@${interaction.user.id}>.` });
    return interaction.followUp({ content: `↩️ Reopened the application${wasAccepted ? (roleRemoved ? ` and removed the **${spec.label}** role` : ' (⚠️ couldn’t remove the role, check role hierarchy)') : ''}. It’s back to **open** for a fresh decision.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // customId router — index.js checks isInteraction() then calls handleInteraction().
  function isInteraction(interaction) {
    const id = interaction.customId || '';
    return id.startsWith(`${spec.key}app_`);
  }
  async function handleInteraction(interaction) {
    const id = interaction.customId;
    if (interaction.isModalSubmit?.() && id === cid('submit')) return submitFromModal(interaction);
    if (id === cid('up')) return vote(interaction, 'up');
    if (id === cid('down')) return vote(interaction, 'down');
    // gates (admin+ to decide; staff/role to vote) are applied by index.js before calling this
    if (id === cid('accept')) return resolve(interaction, true);
    if (id === cid('deny')) return resolve(interaction, false);
    if (id === cid('undo')) return undo(interaction);
  }

  return {
    KEY: spec.key, LABEL: spec.label, EMOJI: spec.emoji, applyCmd: spec.applyCmd,
    roleId, isConfigured, canVote, coordChannelId, loadConfig,
    applicationsOpen, closedNotice, setApplicationsOpen,
    setup, buildModal, submitFromModal, isInteraction, handleInteraction,
    // expose the decision customIds so index.js can gate accept/deny/undo vs up/down
    isDecision: id => [cid('accept'), cid('deny'), cid('undo')].includes(id),
    isVote: id => [cid('up'), cid('down')].includes(id),
  };
}

module.exports = { makeStaffApp, placeSensibly };
