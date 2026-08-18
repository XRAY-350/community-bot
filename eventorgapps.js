// eventorgapps.js — Event Organizer applications (owner, 2026-08-17: "set up event organizer
// applications"). Same shape as modapps.js's mod applications, trimmed down: one role (no track/language
// split), no punishment-record handicap on the vote, no "own-application" forum-leak concern (the
// Organizer role doesn't grant memberTier or forum access, unlike Mod), so no archive-on-promotion needed.
//   • APPLICANT side: a PRIVATE THREAD the applicant is added to.
//   • STAFF side: a post in a private, staff-only review FORUM — any staff gives an anonymous 👍/👎
//     (advisory); admins/owners make the final Accept/Deny. Accept grants the Event Organizer role.
const fs = require('fs');
const { statePath } = require('./statepath');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const opspanel = require('./opspanel');
const ownerlog = require('./ownerlog');

const CONFIG_FILE = process.env.FUBU_EVENTORGAPPS_FILE || statePath('eventorgapps.json');
const STATE_FILE = process.env.FUBU_EVENTORGAPPS_STATE_FILE || statePath('eventorgapps_state.json');
const P = PermissionsBitField.Flags;
const ORGANIZER_ROLE_ID = process.env.FUBU_EVENT_ORGANIZER_ROLE_ID || '1529976148706984110';
const VOTE_WEIGHT = { mod: 1, admin: 2, owner: 3 };

const QUESTIONS = [
  { id: 'why', label: 'Why do you want to organize events?', style: TextInputStyle.Paragraph, required: true, max: 700 },
  { id: 'avail', label: 'Availability / timezone', style: TextInputStyle.Short, required: true, max: 100 },
  { id: 'idea', label: 'An event idea you’d want to run', style: TextInputStyle.Paragraph, required: true, max: 700 },
];
const TAGS = [
  { key: 'pending', name: 'Pending', emoji: '🕐' },
  { key: 'accepted', name: 'Accepted', emoji: '✅' },
  { key: 'denied', name: 'Denied', emoji: '❌' },
];

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[eventorgapps] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { posts: {} });
const saveState = s => _save(STATE_FILE, s);
function isConfigured() { const c = loadConfig(); return !!(c.forumId && c.appsChannelId && c.tags); }
// Who may VOTE on a review post: staff, or a current Event Organizer holder (owner, 2026-08-17). Accept/
// deny/undo stays admin+ only — voting is the only thing current Organizers get.
function canVote(member) { return !!(opspanel.memberTier(member) || member?.roles?.cache?.has(ORGANIZER_ROLE_ID)); }

const DEFAULT_CLOSED_NOTICE = '🚫 Event Organizer applications are currently **closed**. Thanks for the interest, keep an eye out for when they reopen!';
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
      const base = 'Apply with /apply-event-organizer. Your application opens as a private thread here that only you + staff can see.';
      await ch.setTopic(open ? base : `🚫 Applications are CLOSED. ${base}`).catch(() => {});
    }
  } catch { /* topic update is best-effort */ }
  return { open };
}

// ---- setup: staff-only review forum + a member-visible channel that hosts the applicant threads -----
async function setup(guild, config) {
  let c = loadConfig();
  const wl = config?.watchLogChannelId ? await guild.channels.fetch(config.watchLogChannelId).catch(() => null) : null;
  const staffOverwrites = (wl && wl.permissionOverwrites.cache.size)
    ? [...wl.permissionOverwrites.cache.values()].map(o => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
    : [{ id: guild.id, deny: [P.ViewChannel] }];
  let forum = c.forumId ? await guild.channels.fetch(c.forumId).catch(() => null) : null;
  if (!forum) {
    // Current Event Organizer holders get the same view + vote access as staff (owner, 2026-08-17: "how
    // would current event organizers interact with the application?" — they weigh in on new applicants
    // too), but not ManageThreads — same "vote only, no thread management" restriction as the mod role.
    forum = await guild.channels.create({
      name: '🎪┆ᴇᴠᴇɴᴛ-ᴏʀɢ-ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴs', type: ChannelType.GuildForum,
      topic: 'Event Organizer applications - staff + current Organizers review. Anonymous 👍/👎; admins/owners decide.',
      permissionOverwrites: [...staffOverwrites, { id: ORGANIZER_ROLE_ID, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads] }],
      availableTags: TAGS.map(t => ({ name: t.name, moderated: true, emoji: { id: null, name: t.emoji } })),
      defaultAutoArchiveDuration: 10080, reason: 'Event Organizer applications review forum',
    });
    if (opspanel.MOD_ROLE_ID) await forum.permissionOverwrites.edit(opspanel.MOD_ROLE_ID, { ManageThreads: false }, { reason: 'vote only; thread-member management is admin+' }).catch(() => {});
    await forum.permissionOverwrites.edit(ORGANIZER_ROLE_ID, { ManageThreads: false }, { reason: 'vote only; thread-member management is admin+' }).catch(() => {});
    const fresh = await guild.channels.fetch(forum.id);
    const tagMap = {}; for (const t of TAGS) { const f = fresh.availableTags.find(x => x.name === t.name); if (f) tagMap[t.key] = f.id; }
    c.forumId = forum.id; c.tags = tagMap;
  }
  let apps = c.appsChannelId ? await guild.channels.fetch(c.appsChannelId).catch(() => null) : null;
  if (!apps) {
    apps = await guild.channels.create({
      name: '🎪┆ᴇᴠᴇɴᴛ-ᴏʀɢ-ᴀᴘᴘs', type: ChannelType.GuildText,
      topic: 'Apply with /apply-event-organizer. Your application opens as a private thread here that only you + staff can see.',
      permissionOverwrites: [{ id: guild.id,
        allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
        deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
      reason: 'Event Organizer application applicant threads',
    });
    c.appsChannelId = apps.id;
  }
  saveConfig(c);
  return { forum, apps, created: true };
}

function buildModal() {
  const m = new ModalBuilder().setCustomId('eventorgapp_submit').setTitle('Event Organizer application');
  for (const q of QUESTIONS) m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(q.id).setLabel(q.label).setStyle(q.style).setRequired(q.required).setMaxLength(q.max)));
  return m;
}

const voteRow = (up, down, done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('eventorgapp_up').setEmoji('👍').setLabel(String(up)).setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('eventorgapp_down').setEmoji('👎').setLabel(String(down)).setStyle(ButtonStyle.Danger).setDisabled(!!done));
const decideRow = (done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('eventorgapp_accept').setEmoji('✅').setLabel('Accept').setStyle(ButtonStyle.Secondary).setDisabled(!!done),
  new ButtonBuilder().setCustomId('eventorgapp_deny').setEmoji('❌').setLabel('Deny').setStyle(ButtonStyle.Secondary).setDisabled(!!done));
const undoRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('eventorgapp_undo').setEmoji('↩️').setLabel('Undo decision').setStyle(ButtonStyle.Secondary));
const reviewComponents = (post, done) => [voteRow(post.up?.length || 0, post.down?.length || 0, done), decideRow(done)];

const idOf = e => (typeof e === 'object' && e !== null) ? e.id : e;
const weightOf = e => (typeof e === 'object' && e !== null) ? (e.w || 1) : 1;
const sumWeight = list => (list || []).reduce((s, e) => s + weightOf(e), 0);

function reviewEmbed(post, answers, resolution, byId) {
  const tally = sumWeight(post.up) - sumWeight(post.down);
  const e = new EmbedBuilder().setColor(resolution === 'accepted' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0x5865F2)
    .setTitle('🎪 Event Organizer application').addFields(
      { name: 'Applicant', value: `<@${post.applicantId}>`, inline: true },
      { name: 'Availability', value: (answers.avail || '-').slice(0, 100), inline: true },
      { name: 'Why organize events?', value: (answers.why || '-').slice(0, 1024) },
      { name: 'Event idea', value: (answers.idea || '-').slice(0, 1024) });
  e.addFields({ name: '💬 Applicant thread', value: post.appThreadId ? `<#${post.appThreadId}> · jump here to message them (opens only for staff)` : '-', inline: false });
  e.addFields({ name: 'Staff tally (anon)', value: `👍 ${post.up?.length || 0} · 👎 ${post.down?.length || 0} voter(s) · **weighted = ${tally}**`, inline: true });
  if (resolution) e.addFields({ name: resolution === 'accepted' ? '✅ Accepted by' : '❌ Denied by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: 'Staff 👍/👎 is anonymous + advisory. Admins/owners decide.' });
  return e;
}
function answersFromEmbed(e) {
  const g = n => e?.fields?.find(f => f.name === n)?.value;
  return { avail: g('Availability'), why: g('Why organize events?'), idea: g('Event idea') };
}

async function submitFromModal(interaction) {
  const c = loadConfig();
  if (!c.forumId || !c.appsChannelId) return interaction.reply({ content: 'Event Organizer applications aren’t set up yet. An admin needs to open `/panel` → 🧩 Setup → 🎪 Event Organizer apps.', flags: MessageFlags.Ephemeral });
  if (!applicationsOpen()) return interaction.reply({ content: closedNotice(), flags: MessageFlags.Ephemeral });
  const state = loadState();
  if (Object.values(state.posts).find(p => p.applicantId === interaction.user.id && p.status === 'open'))
    return interaction.reply({ content: 'You already have an open application — wait for a decision before applying again.', flags: MessageFlags.Ephemeral });
  const answers = {}; for (const q of QUESTIONS) { try { answers[q.id] = interaction.fields.getTextInputValue(q.id); } catch { answers[q.id] = ''; } }
  const member = interaction.member;
  const forum = await interaction.guild.channels.fetch(c.forumId).catch(() => null);
  const appsCh = await interaction.guild.channels.fetch(c.appsChannelId).catch(() => null);
  if (!forum || !appsCh) return interaction.reply({ content: 'Something’s misconfigured — ask an admin to re-run `/panel` → 🧩 Setup → 🎪 Event Organizer apps.', flags: MessageFlags.Ephemeral });

  const appThread = await appsCh.threads.create({
    name: `Application · ${member.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Event Organizer application by ${member.user.tag}`,
  });
  await appThread.members.add(member.id).catch(() => {});
  await appThread.send({ content: `🎪 <@${member.id}>, this is your Event Organizer application. Staff will review it and follow up here if they have questions.`,
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Your application').addFields(
      { name: 'Availability', value: (answers.avail || '-').slice(0, 100), inline: true },
      { name: 'Why organize events?', value: (answers.why || '-').slice(0, 1024) },
      { name: 'Event idea', value: (answers.idea || '-').slice(0, 1024) })],
    allowedMentions: { users: [member.id] } }).catch(() => {});

  const post = { applicantId: member.id, appThreadId: appThread.id, status: 'open', up: [], down: [] };
  const review = await forum.threads.create({
    name: `App · ${member.user.username}`.slice(0, 95),
    message: { embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) },
    appliedTags: c.tags.pending ? [c.tags.pending] : [], reason: `Event Organizer application review - ${member.user.tag}`,
  });
  state.posts[review.id] = post; saveState(state);
  return interaction.reply({ content: `🎪 Application submitted! Follow along or answer follow-ups in <#${appThread.id}>.`, flags: MessageFlags.Ephemeral });
}

async function vote(interaction, dir) {
  const state = loadState(); const post = state.posts[interaction.channelId];
  if (!post || post.status !== 'open') return interaction.reply({ content: 'This application isn’t open for voting.', flags: MessageFlags.Ephemeral });
  const uid = interaction.user.id;
  const tier = opspanel.memberTier(interaction.member);
  const w = VOTE_WEIGHT[tier] || 1;
  const up = (post.up || []).filter(e => idOf(e) !== uid), down = (post.down || []).filter(e => idOf(e) !== uid);
  const wasIn = ((dir === 'up' ? post.up : post.down) || []).some(e => idOf(e) === uid);
  if (!wasIn) (dir === 'up' ? up : down).push({ id: uid, w });
  post.up = up; post.down = down; saveState(state);
  const starter = await interaction.channel.fetchStarterMessage().catch(() => null);
  const answers = starter ? answersFromEmbed(starter.embeds[0]) : {};
  await interaction.update({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) });
  return interaction.followUp({ content: wasIn ? `Your ${dir === 'up' ? '👍' : '👎'} was removed.` : `Your ${dir === 'up' ? '👍' : '👎'} is counted (anonymous).`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function resolve(interaction, accepted, config) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  const state = loadState(); const post = state.posts[interaction.channelId];
  if (!post) return interaction.editReply({ content: 'This application isn’t tracked (posted before a restart, or already resolved).' });
  if (post.status !== 'open') return interaction.editReply({ content: 'Already resolved.' });
  post.status = accepted ? 'accepted' : 'denied'; saveState(state);
  const member = await interaction.guild.members.fetch(post.applicantId).catch(() => null);
  let roleGiven = false;
  if (accepted && member) roleGiven = await member.roles.add(ORGANIZER_ROLE_ID, `Event Organizer app accepted by ${interaction.user.tag}`).then(() => true).catch(() => false);
  const reviewThread = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  const reviewMsg = reviewThread && await reviewThread.fetchStarterMessage().catch(() => null);
  if (reviewMsg) {
    const answers = answersFromEmbed(reviewMsg.embeds[0]);
    await reviewMsg.edit({ embeds: [reviewEmbed(post, answers, post.status, interaction.user.id)], components: [...reviewComponents(post, true), undoRow()] }).catch(() => {});
  }
  const appThread = await interaction.guild.channels.fetch(post.appThreadId).catch(() => null);
  if (appThread) {
    await appThread.send(accepted
      ? `🎉 Your Event Organizer application was **accepted**!${roleGiven ? ' You’ve been given the **Event Organizer** role. 🎪' : ''}`
      : `Thanks for applying. Your Event Organizer application wasn’t accepted this time. You’re welcome to apply again later.`).catch(() => {});
    await appThread.setArchived(true).catch(() => {});
  }
  const tagCfg = loadConfig();
  if (reviewThread) { await reviewThread.setAppliedTags([accepted ? tagCfg.tags.accepted : tagCfg.tags.denied].filter(Boolean)).catch(() => {}); await reviewThread.setLocked(true).catch(() => {}); await reviewThread.setArchived(true).catch(() => {}); }
  await ownerlog.log(interaction.guild, { emoji: accepted ? '✅' : '❌', title: `Event Organizer application ${accepted ? 'accepted' : 'denied'}`, color: accepted ? 0x57F287 : 0xED4245,
    detail: `<@${post.applicantId}> — by <@${interaction.user.id}>.` });
  return interaction.editReply({ content: accepted ? (roleGiven ? '✅ Accepted. Gave them the **Event Organizer** role.' : '✅ Accepted (couldn’t assign the role, check role hierarchy).') : '❌ Denied. Applicant was notified in their thread.' });
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
  if (wasAccepted && member) roleRemoved = await member.roles.remove(ORGANIZER_ROLE_ID, `Event Organizer acceptance undone by ${interaction.user.tag}`).then(() => true).catch(() => false);
  post.status = 'open'; saveState(state);
  const review = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  if (review) { await review.setArchived(false).catch(() => {}); await review.setLocked(false).catch(() => {}); await review.setAppliedTags(c.tags?.pending ? [c.tags.pending] : []).catch(() => {}); }
  const answers = answersFromEmbed(interaction.message.embeds[0]);
  await interaction.editReply({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) }).catch(() => {});
  const appThread = post.appThreadId ? await interaction.guild.channels.fetch(post.appThreadId).catch(() => null) : null;
  if (appThread) { await appThread.setArchived(false).catch(() => {}); await appThread.send('↩️ Quick update: your application has been reopened for another look. Hang tight; staff will follow up here.').catch(() => {}); }
  await ownerlog.log(interaction.guild, { emoji: '↩️', title: 'Event Organizer decision undone', color: 0xF1C40F,
    detail: `<@${post.applicantId}> — was ${wasAccepted ? 'accepted' : 'denied'}, reopened${roleRemoved ? ' (removed Event Organizer)' : ''} — by <@${interaction.user.id}>.` });
  return interaction.followUp({ content: `↩️ Reopened the application${wasAccepted ? (roleRemoved ? ' and removed the **Event Organizer** role' : ' (⚠️ couldn’t remove the role, check role hierarchy)') : ''}. It’s back to **open** for a fresh decision.`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function handleButton(interaction, config) {
  const id = interaction.customId;
  if (id === 'eventorgapp_up') return vote(interaction, 'up');
  if (id === 'eventorgapp_down') return vote(interaction, 'down');
  if (id === 'eventorgapp_accept') return resolve(interaction, true, config);
  if (id === 'eventorgapp_deny') return resolve(interaction, false, config);
  if (id === 'eventorgapp_undo') return undo(interaction);
}

module.exports = { setup, buildModal, submitFromModal, handleButton, isConfigured, loadConfig, applicationsOpen, closedNotice, setApplicationsOpen, ORGANIZER_ROLE_ID, canVote };
