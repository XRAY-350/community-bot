// modapps.js — mod applications, two-sided:
//   • APPLICANT side: a PRIVATE THREAD the applicant is added to — they view their application and talk
//     to staff there (staff post to ask questions, they reply). They see only their own.
//   • STAFF side: a post in the private, staff-only mod-applications FORUM — mods give an ANONYMOUS
//     👍/👎 (advisory; counts shown, never who voted), and admins/owners make the final Accept/Deny
//     (no auto-decide). The advisory tally STARTS NEGATIVE based on the applicant's punishment record
//     (−2 per strike · −3 if watchlisted · −1 if cornered — cornering barely counts since it's often
//     just a joke; watchlist + strikes are the real signals). Accept grants the Trial Mod role.
//   • Private staff talk happens in #mod-discussion or the staff post — the applicant can't see either.
const fs = require('fs');
const { statePath } = require('./statepath');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const opspanel = require('./opspanel');
const copy = require('./copy');
const langmods = require('./langmods');
const ownerlog = require('./ownerlog');
const watchlist = require('./watchlist');

const CONFIG_FILE = process.env.FUBU_MODAPPS_FILE || statePath('modapps.json');
const STATE_FILE = process.env.FUBU_MODAPPS_STATE_FILE || statePath('modapps_state.json');
const P = PermissionsBitField.Flags;
// A vote's weight is the voter's staff tier — an admin's 👍/👎 counts double a mod's, an owner's triple.
const VOTE_WEIGHT = { mod: 1, admin: 2, owner: 3 };
// up/down entries are { id, w }; tolerate plain-ID strings from before weighted voting shipped (weight 1).
const idOf = e => (typeof e === 'object' && e !== null) ? e.id : e;
const weightOf = e => (typeof e === 'object' && e !== null) ? (e.w || 1) : 1;
const sumWeight = list => (list || []).reduce((s, e) => s + weightOf(e), 0);

const QUESTIONS = [
  { id: 'age', label: 'Your age', style: TextInputStyle.Short, required: true, max: 10 },
  { id: 'tz', label: 'Timezone + when you’re usually active', style: TextInputStyle.Short, required: true, max: 100 },
  { id: 'why', label: 'Why do you want to be a mod?', style: TextInputStyle.Paragraph, required: true, max: 700 },
  { id: 'exp', label: 'Past moderation experience (if any)', style: TextInputStyle.Paragraph, required: false, max: 500 },
  { id: 'extra', label: 'Anything else we should know?', style: TextInputStyle.Paragraph, required: false, max: 500 },
];
const TAGS = [
  { key: 'pending', name: 'Pending', emoji: '🕐' },
  { key: 'accepted', name: 'Accepted', emoji: '✅' },
  { key: 'denied', name: 'Denied', emoji: '❌' },
];

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[modapps] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { posts: {}, cooldown: {} });
const saveState = s => _save(STATE_FILE, s);
function isConfigured() { const c = loadConfig(); return !!(c.forumId && c.appsChannelId && c.tags); }

// ---- punishment handicap: read straight off the member's roles -------------------------------------
function punishment(member, config) {
  const roles = member.roles.cache;
  // Per-unit strike roles (Strike 1..9): a member wears exactly one, and its LEVEL is their unit total.
  // Read the highest held (= units) rather than COUNTING roles held (which is always 0 or 1 now).
  const ids = config.strikeRoleIds || [];
  let strikeUnits = 0;
  for (let i = ids.length - 1; i >= 0; i--) if (roles.has(ids[i])) { strikeUnits = i + 1; break; }
  const cornered = config.cornerRoleId && roles.has(config.cornerRoleId);
  const watchlisted = watchlist.isWatched(member.id);
  const points = -(strikeUnits * 2) - (watchlisted ? 3 : 0) - (cornered ? 1 : 0);
  const parts = [];
  if (strikeUnits) parts.push(`${strikeUnits} strike unit${strikeUnits > 1 ? 's' : ''}`);
  if (watchlisted) parts.push('watchlisted');
  if (cornered) parts.push('in the corner');
  return { points, reason: parts.join(' · ') || 'clean record' };
}

// ---- setup: staff-only review forum + a member-visible channel that hosts the applicant threads -----
async function setup(guild, config) {
  let c = loadConfig();
  const wl = config?.watchLogChannelId ? await guild.channels.fetch(config.watchLogChannelId).catch(() => null) : null;
  const staffOverwrites = (wl && wl.permissionOverwrites.cache.size)
    ? [...wl.permissionOverwrites.cache.values()].map(o => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
    : [{ id: guild.id, deny: [P.ViewChannel] }];
  // staff review forum
  let forum = c.forumId ? await guild.channels.fetch(c.forumId).catch(() => null) : null;
  if (!forum) {
    forum = await guild.channels.create({
      name: '📋┆ᴍᴏᴅ-ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴs', type: ChannelType.GuildForum,
      topic: 'Mod applications - staff review. Anonymous mod 👍/👎; admins/owners decide.',
      permissionOverwrites: staffOverwrites,
      availableTags: TAGS.map(t => ({ name: t.name, moderated: true, emoji: { id: null, name: t.emoji } })),
      defaultAutoArchiveDuration: 10080, reason: 'Mod applications review forum',
    });
    // Mods VOTE only (buttons); they must NOT be able to add/remove review-thread members — that's the
    // thread-membership leak vector (a mod hand-adds a non-mod, bypassing the channel view-deny). Deny
    // ManageThreads for the mod role here; admins/owners keep it, and the bot keeps it for auto-strip.
    if (opspanel.MOD_ROLE_ID) await forum.permissionOverwrites.edit(opspanel.MOD_ROLE_ID, { ManageThreads: false }, { reason: 'mods vote only; thread-member management is admin+' }).catch(() => {});
    const fresh = await guild.channels.fetch(forum.id);
    const tagMap = {}; for (const t of TAGS) { const f = fresh.availableTags.find(x => x.name === t.name); if (f) tagMap[t.key] = f.id; }
    c.forumId = forum.id; c.tags = tagMap;
  }
  // applicant-thread host channel: members can VIEW (so they can see their own private thread) but can't
  // post in the root or open their own threads. Their private thread + SendMessagesInThreads let them reply.
  let apps = c.appsChannelId ? await guild.channels.fetch(c.appsChannelId).catch(() => null) : null;
  if (!apps) {
    apps = await guild.channels.create({
      name: '📋┆ᴍᴏᴅ-ᴀᴘᴘs', type: ChannelType.GuildText,
      topic: 'Apply with /apply-mod. Your application opens as a private thread here that only you + staff can see.',
      permissionOverwrites: [{ id: guild.id,
        allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads],
        deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
      reason: 'Mod application applicant threads',
    });
    c.appsChannelId = apps.id;
  }
  saveConfig(c);
  return { forum, apps, created: true };
}

// track: 'mod' (Trial Mod) or 'lang' (a language mini-mod for `lang`). The customId carries the track so
// the modal submit knows which position the application is for.
function buildModal(track = 'mod', lang = null) {
  const customId = track === 'lang' ? `modapp_submit:lang:${lang}` : 'modapp_submit';
  const m = new ModalBuilder().setCustomId(customId).setTitle((track === 'lang' ? `${lang} mini-mod` : 'Mod application').slice(0, 45));
  for (const q of QUESTIONS) m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(q.id).setLabel(q.label).setStyle(q.style).setRequired(q.required).setMaxLength(q.max)));
  return m;
}
// Step 1 of applying: pick the POSITION (only shown when mini-mod scopes are configured — otherwise
// /apply-mod goes straight to the mod modal). Moderator → mod modal; Mini-mod → scope picker.
const positionRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('modapp_pos_mod').setEmoji('🛡️').setLabel('Moderator').setStyle(ButtonStyle.Primary).setDisabled(!applicationsOpen('mod')),
  new ButtonBuilder().setCustomId('modapp_pos_lang').setEmoji('🌐').setLabel('Mini-mod').setStyle(ButtonStyle.Secondary).setDisabled(!applicationsOpen('lang')));
function languageSelectRow() {
  const menu = new StringSelectMenuBuilder().setCustomId('modapp_pos_langsel').setPlaceholder('Which language?')
    .addOptions(langmods.languages().map(l => ({ label: `${l} mini-mod`, value: l, emoji: '🌐' })));
  return new ActionRowBuilder().addComponents(menu);
}
// Human label for a post's position (mod vs a specific language mini-mod).
const positionLabel = (post) => post?.track === 'lang' ? `🌐 Mini-mod: ${post.lang}` : '🛡️ Moderator';

const voteRow = (up, down, done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('modapp_up').setEmoji('👍').setLabel(String(up)).setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('modapp_down').setEmoji('👎').setLabel(String(down)).setStyle(ButtonStyle.Danger).setDisabled(!!done));
const decideRow = (done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('modapp_accept').setEmoji('✅').setLabel('Accept').setStyle(ButtonStyle.Secondary).setDisabled(!!done),
  new ButtonBuilder().setCustomId('modapp_deny').setEmoji('❌').setLabel('Deny').setStyle(ButtonStyle.Secondary).setDisabled(!!done));
// Staff can message the applicant WITHOUT revealing who — relayed to their thread as the bot.
const askRow = (done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('modapp_askanon').setEmoji('🕵️').setLabel('Ask anonymously').setStyle(ButtonStyle.Secondary).setDisabled(!!done));
// Shown only on a RESOLVED post — a way back if a decision was a mistake (fat-finger accept, or a
// reversal-on-reflection). Reverses the Trial Mod grant + reopens the application for a fresh decision.
const undoRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('modapp_undo').setEmoji('↩️').setLabel('Undo decision').setStyle(ButtonStyle.Secondary));
const reviewComponents = (post, done) => [voteRow(post.up?.length || 0, post.down?.length || 0, done), decideRow(done), askRow(done)];

function reviewEmbed(post, answers, resolution, byId) {
  const tally = (post.startPoints || 0) + sumWeight(post.up) - sumWeight(post.down);
  const e = new EmbedBuilder().setColor(resolution === 'accepted' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0x5865F2)
    .setTitle('📋 Mod application').addFields(
      { name: 'Applicant', value: `<@${post.applicantId}>`, inline: true },
      { name: 'Applying for', value: positionLabel(post), inline: true },
      { name: 'Age', value: answers.age || '-', inline: true },
      { name: 'Active', value: (answers.tz || '-').slice(0, 100), inline: true },
      { name: 'Why mod?', value: (answers.why || '-').slice(0, 1024) });
  if (answers.exp) e.addFields({ name: 'Experience', value: answers.exp.slice(0, 1024) });
  if (answers.extra) e.addFields({ name: 'Anything else', value: answers.extra.slice(0, 1024) });
  e.addFields({ name: '💬 Applicant thread', value: post.appThreadId ? `<#${post.appThreadId}> · jump here to message them (opens only for staff)` : '-', inline: false });
  e.addFields(
    { name: 'Record', value: `${post.recordReason} → starts at **${post.startPoints}**`, inline: true },
    { name: 'Mod tally (anon)', value: `👍 ${post.up?.length || 0} · 👎 ${post.down?.length || 0} voter(s) · **weighted = ${tally}**`, inline: true });
  if (resolution) e.addFields({ name: resolution === 'accepted' ? '✅ Accepted by' : '❌ Denied by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: 'Mod 👍/👎 is anonymous + advisory. Admins/owners decide. Talk privately in #mod-discussion.' });
  return e;
}

// keep the applicant's answers on the review post so we can re-render on vote (embed field-based)
function answersFromEmbed(e) {
  const g = n => e?.fields?.find(f => f.name === n)?.value;
  return { age: g('Age'), tz: g('Active'), why: g('Why mod?'), exp: g('Experience'), extra: g('Anything else') };
}

async function submitFromModal(interaction, config) {
  const c = loadConfig();
  if (!c.forumId || !c.appsChannelId) return interaction.reply({ content: copy.modapps.notSetup, flags: MessageFlags.Ephemeral });
  // Which position? customId is 'modapp_submit' (Moderator) or 'modapp_submit:lang:<Language>'.
  const idParts = (interaction.customId || '').split(':');
  const track = idParts[1] === 'lang' ? 'lang' : 'mod';
  const lang = track === 'lang' ? idParts[2] : null;
  if (!applicationsOpen(track)) return interaction.reply({ content: closedNotice(track), flags: MessageFlags.Ephemeral });
  const state = loadState();
  if (Object.values(state.posts).find(p => p.applicantId === interaction.user.id && p.status === 'open'))
    return interaction.reply({ content: copy.modapps.alreadyApplied, flags: MessageFlags.Ephemeral });
  const answers = {}; for (const q of QUESTIONS) { try { answers[q.id] = interaction.fields.getTextInputValue(q.id); } catch { answers[q.id] = ''; } }
  const member = interaction.member;
  const pun = punishment(member, config);
  const forum = await interaction.guild.channels.fetch(c.forumId).catch(() => null);
  const appsCh = await interaction.guild.channels.fetch(c.appsChannelId).catch(() => null);
  if (!forum || !appsCh) return interaction.reply({ content: copy.modapps.notSetupNow, flags: MessageFlags.Ephemeral });

  // 1) applicant private thread
  const appThread = await appsCh.threads.create({
    name: `Application · ${member.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false,
    reason: `Mod application by ${member.user.tag}`,
  });
  await appThread.members.add(member.id).catch(() => {});
  await appThread.send({ content: copy.modapps.applicantWelcome(member.id),
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Your application').addFields(
      { name: 'Age', value: answers.age || '-', inline: true }, { name: 'Active', value: (answers.tz || '-').slice(0, 100), inline: true },
      { name: 'Why mod?', value: (answers.why || '-').slice(0, 1024) },
      ...(answers.exp ? [{ name: 'Experience', value: answers.exp.slice(0, 1024) }] : []),
      ...(answers.extra ? [{ name: 'Anything else', value: answers.extra.slice(0, 1024) }] : []))],
    allowedMentions: { users: [member.id] } }).catch(() => {});

  // 2) staff review post
  const post = { applicantId: member.id, appThreadId: appThread.id, status: 'open', up: [], down: [], startPoints: pun.points, recordReason: pun.reason, track, lang };
  const review = await forum.threads.create({
    name: `App · ${member.user.username}`.slice(0, 95),
    message: { embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) },
    appliedTags: c.tags.pending ? [c.tags.pending] : [], reason: `Mod application review - ${member.user.tag}`,
  });
  state.posts[review.id] = post; saveState(state);
  return interaction.reply({ content: copy.modapps.submitted(appThread.id), flags: MessageFlags.Ephemeral });
}

// ---- anonymous mod vote (mods+; gated in index.js) --------------------------------------------------
async function vote(interaction, dir) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: copy.modapps.untracked, flags: MessageFlags.Ephemeral });
  if (post.status !== 'open') return interaction.reply({ content: copy.modapps.votingClosed, flags: MessageFlags.Ephemeral });
  const uid = interaction.user.id;
  // Weight is locked in at the moment you vote (your tier right now) — a later promotion/demotion doesn't
  // retroactively reweigh a vote you already cast; vote again if you want it to count at your new tier.
  const tier = opspanel.memberTier(interaction.member);
  const w = VOTE_WEIGHT[tier] || 1;
  let up = (post.up || []).filter(e => idOf(e) !== uid);
  let down = (post.down || []).filter(e => idOf(e) !== uid);
  const wasInDir = ((dir === 'up' ? post.up : post.down) || []).some(e => idOf(e) === uid);
  if (!wasInDir) (dir === 'up' ? up : down).push({ id: uid, w });
  post.up = up; post.down = down; saveState(state);
  const answers = answersFromEmbed(interaction.message.embeds[0]);
  // ephemeral personal ack (so THEY know their vote registered) — but the post shows only counts, anonymously
  await interaction.update({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) });
  const ack = wasInDir ? `Your ${dir === 'up' ? '👍' : '👎'} was removed.`
    : `Your ${dir === 'up' ? '👍' : '👎'} is counted (anonymous). As **${tier || 'staff'}**, it's worth **${w}**.`;
  return interaction.followUp({ content: ack, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// ---- accept / deny (admins+; gated in index.js) ----------------------------------------------------
// Reply to whichever interaction is resolving this, correctly whether it's fresh, deferred, or already
// replied — resolve() gets called both from a direct Deny click AND from the accept-grant picker below
// (a SEPARATE interaction from whatever originally opened it), so it can't assume its own reply state.
// editReply (not followUp) when already deferred/replied — edits the SAME message into its final state
// rather than leaving a stale "thinking…"/"Processing…" placeholder next to a separate result message.
function respond(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => interaction.followUp(payload));
  return interaction.reply(payload);
}
// grantOverride: null = grant whatever they applied for (post.track/post.lang), same as always. Or
// { track: 'mod' } / { track: 'lang', lang } to grant a DIFFERENT position than applied for (owner,
// 2026-08-14: staff sometimes want to accept someone as Trial Mod instead of the mini-mod they applied
// for, or vice versa) — post.track/post.lang stay untouched as the historical record of what they
// actually applied for; post.grantedAs records what they were actually given, when it differs.
async function resolve(interaction, accepted, config, grantOverride = null) {
  // Ack immediately — the work below (role grant, message edits, applicant notify, ownerlog) is several
  // awaits deep and can easily clear Discord's 3s interaction-response window otherwise. A no-op if the
  // caller (finishAccept) already deferred this same interaction.
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return respond(interaction, { content: copy.modapps.untracked, flags: MessageFlags.Ephemeral });
  if (post.status !== 'open') return respond(interaction, { content: copy.modapps.alreadyResolved, flags: MessageFlags.Ephemeral });
  const c = loadConfig();
  post.status = accepted ? 'accepted' : 'denied';
  if (accepted && grantOverride) post.grantedAs = grantOverride;
  saveState(state);
  const member = await interaction.guild.members.fetch(post.applicantId).catch(() => null);
  const effTrack = grantOverride ? grantOverride.track : post.track;
  const effLang = grantOverride ? grantOverride.lang : post.lang;
  const grantRoleId = effTrack === 'lang' && effLang ? langmods.roleForLang(effLang) : c.trialModRoleId;
  const grantLabel = effTrack === 'lang' && effLang ? `${effLang} Mini-Mod` : 'Trial Mod';
  const differed = accepted && (effTrack !== post.track || (effTrack === 'lang' && effLang !== post.lang));
  let roleGiven = false;
  if (accepted && grantRoleId && member)
    roleGiven = await member.roles.add(grantRoleId, `Mod app accepted by ${interaction.user.tag}${differed ? ' (granted a different position than applied for)' : ''}`).then(() => true).catch(() => false);
  // Edit the review post directly — the acting interaction may be on a DIFFERENT message (the accept-grant
  // picker's ephemeral reply), not the review post itself, so interaction.update() can't be relied on here.
  const reviewThread = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  const reviewMsg = reviewThread && await reviewThread.fetchStarterMessage().catch(() => null);
  if (reviewMsg) {
    const answers = answersFromEmbed(reviewMsg.embeds[0]);
    await reviewMsg.edit({ embeds: [reviewEmbed(post, answers, post.status, interaction.user.id)], components: [...reviewComponents(post, true), undoRow()] }).catch(() => {});
  }
  // notify the applicant IN THEIR THREAD, then close both
  const appThread = await interaction.guild.channels.fetch(post.appThreadId).catch(() => null);
  if (appThread) {
    await appThread.send(accepted
      ? `🎉 Your application was **accepted**!${roleGiven ? ` You’ve been given the **${grantLabel}** role. 🌱` : ''} Staff will guide you from here.`
      : `Thanks for applying. Your application wasn’t accepted this time. You’re welcome to apply again later. 💛`).catch(() => {});
    await appThread.setArchived(true).catch(() => {});
  }
  if (reviewThread) { await reviewThread.setAppliedTags([accepted ? c.tags.accepted : c.tags.denied].filter(Boolean)).catch(() => {}); await reviewThread.setLocked(true).catch(() => {}); await reviewThread.setArchived(true).catch(() => {}); }
  await ownerlog.log(interaction.guild, { emoji: accepted ? '✅' : '❌', title: `Mod application ${accepted ? 'accepted' : 'denied'}`, color: accepted ? 0x57F287 : 0xED4245,
    detail: `<@${post.applicantId}> — ${positionLabel(post)}${differed ? ` (granted **${grantLabel}** instead)` : ''}${accepted && roleGiven ? ` (granted ${grantLabel})` : ''} — by <@${interaction.user.id}>.` });
  return respond(interaction, { content: accepted ? (roleGiven ? `✅ Accepted. Gave <@${post.applicantId}> the **${grantLabel}** role.${differed ? ' (different from what they applied for.)' : ''}` : `✅ Accepted (couldn’t assign the **${grantLabel}** role, check role hierarchy).`) : `❌ Denied. Applicant was notified in their thread.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

// ---- accept-as-different-position picker ------------------------------------------------------------
// Accept no longer grants immediately — it shows an ephemeral picker (defaulting to whatever they
// actually applied for) so staff can grant a DIFFERENT position when that's the right call.
function acceptGrantRow(post) {
  const opts = [{ label: 'Trial Mod', value: 'mod', emoji: '🛡️', default: post.track !== 'lang' }];
  for (const lang of langmods.languages()) opts.push({ label: `${lang} Mini-Mod`, value: `lang:${lang}`, emoji: '🌐', default: post.track === 'lang' && post.lang === lang });
  const menu = new StringSelectMenuBuilder().setCustomId('modapp_accept_grant').setPlaceholder('Grant which role?').addOptions(opts.slice(0, 25));
  return new ActionRowBuilder().addComponents(menu);
}
async function beginAccept(interaction) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: copy.modapps.untracked, flags: MessageFlags.Ephemeral });
  if (post.status !== 'open') return interaction.reply({ content: copy.modapps.alreadyResolved, flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: `Accepting <@${post.applicantId}> — which role should they actually get? Defaults to what they applied for (**${positionLabel(post)}**).`, components: [acceptGrantRow(post)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
async function finishAccept(interaction, config) {
  await interaction.deferUpdate();
  const picked = interaction.values[0];   // 'mod' or 'lang:<Label>'
  const grantOverride = picked === 'mod' ? { track: 'mod' } : { track: 'lang', lang: picked.slice(5) };
  await interaction.editReply({ content: 'Processing…', components: [] }).catch(() => {});
  return resolve(interaction, true, config, grantOverride);
}

function applicantEmbed(answers) {
  return new EmbedBuilder().setColor(0x5865F2).setTitle('Your application').addFields(
    { name: 'Age', value: answers.age || '-', inline: true }, { name: 'Active', value: (answers.tz || '-').slice(0, 100), inline: true },
    { name: 'Why mod?', value: (answers.why || '-').slice(0, 1024) },
    ...(answers.exp ? [{ name: 'Experience', value: answers.exp.slice(0, 1024) }] : []),
    ...(answers.extra ? [{ name: 'Anything else', value: answers.extra.slice(0, 1024) }] : []));
}

// Convert an OLD-format review post (single post, accept/deny only) into the new two-sided format:
// spin up the applicant's private thread, re-render the review post with anon votes + the punishment
// handicap, and re-track it in state.
async function migrateLegacy(guild, reviewThreadId, config) {
  const c = loadConfig();
  const review = await guild.channels.fetch(reviewThreadId).catch(() => null);
  const starter = review && await review.fetchStarterMessage().catch(() => null);
  const e = starter && starter.embeds[0];
  if (!e) return { ok: false, why: 'no starter embed' };
  const applicantId = e.fields?.find(f => /Applicant/i.test(f.name))?.value?.match(/(\d+)/)?.[1];
  if (!applicantId) return { ok: false, why: 'no applicant id' };
  const answers = answersFromEmbed(e);
  const member = await guild.members.fetch(applicantId).catch(() => null);
  const pun = member ? punishment(member, config) : { points: 0, reason: 'unknown (left the server?)' };
  let appThreadId = null;
  const appsCh = await guild.channels.fetch(c.appsChannelId).catch(() => null);
  if (appsCh && member) {
    const appThread = await appsCh.threads.create({ name: `Application · ${member.user.username}`.slice(0, 95), type: ChannelType.PrivateThread, invitable: false, reason: 'migrate legacy mod app' }).catch(() => null);
    if (appThread) {
      await appThread.members.add(member.id).catch(() => {});
      await appThread.send({ content: copy.modapps.applicantWelcome(member.id), embeds: [applicantEmbed(answers)], allowedMentions: { users: [member.id] } }).catch(() => {});
      appThreadId = appThread.id;
    }
  }
  const post = { applicantId, appThreadId, status: 'open', up: [], down: [], startPoints: pun.points, recordReason: pun.reason };
  await starter.edit({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) }).catch(() => {});
  const state = loadState(); state.posts[reviewThreadId] = post; saveState(state);
  return { ok: true, applicantId, appThreadId, startPoints: pun.points, record: pun.reason };
}

// Staff hit "Ask anonymously" → modal → the question is relayed to the applicant's thread AS THE BOT,
// so the applicant sees it without knowing which staffer asked. (Normal named messages: just type in
// the applicant thread.) The modal carries the applicant thread id so we know where to send it.
async function askAnonModal(interaction) {
  const post = loadState().posts[interaction.channelId];
  if (!post) return interaction.reply({ content: copy.modapps.untracked, flags: MessageFlags.Ephemeral });
  if (!post.appThreadId) return interaction.reply({ content: copy.modapps.noThread, flags: MessageFlags.Ephemeral });
  const m = new ModalBuilder().setCustomId(`modapp_ask:${post.appThreadId}`).setTitle('Ask the applicant (anonymous)');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('q').setLabel('Question (sent without your name)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
  return interaction.showModal(m);
}
async function handleAskModal(interaction) {
  const appThreadId = interaction.customId.split(':')[1];
  const q = interaction.fields.getTextInputValue('q');
  const thread = await interaction.guild.channels.fetch(appThreadId).catch(() => null);
  if (!thread) return interaction.reply({ content: copy.modapps.threadGone, flags: MessageFlags.Ephemeral });
  await thread.send({ embeds: [new EmbedBuilder().setColor(0x9B59B6).setAuthor({ name: '🕵️ A staff member asks…' }).setDescription(q)] }).catch(() => {});
  return interaction.reply({ content: copy.modapps.sentAnon, flags: MessageFlags.Ephemeral });
}

// ---- undo a resolved decision (owner/approver-gated in index.js) -----------------------------------
// Reverses an accept/deny: on an ACCEPT it strips the Trial Mod role it granted; either way it reopens
// the application (status → open, vote/decide buttons re-enabled) and un-archives both the review post
// and the applicant thread so the conversation can continue and a fresh decision can be made.
async function undo(interaction, config) {
  const state = loadState();
  const post = state.posts[interaction.channelId];
  if (!post) return interaction.reply({ content: copy.modapps.untrackedUndo, flags: MessageFlags.Ephemeral });
  if (post.status === 'open') return interaction.reply({ content: copy.modapps.alreadyOpen, flags: MessageFlags.Ephemeral });
  const c = loadConfig();
  const wasAccepted = post.status === 'accepted';
  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(post.applicantId).catch(() => null);
  // Undo what was ACTUALLY granted (post.grantedAs, when accept used a different position than applied
  // for) — falling back to what they applied for otherwise. Removing the wrong role here would leave the
  // real one stuck on them with no record of why.
  const effTrack = post.grantedAs ? post.grantedAs.track : post.track;
  const effLang = post.grantedAs ? post.grantedAs.lang : post.lang;
  const grantRoleId = effTrack === 'lang' && effLang ? langmods.roleForLang(effLang) : c.trialModRoleId;
  const grantLabel = effTrack === 'lang' && effLang ? `${effLang} Mini-Mod` : 'Trial Mod';
  let roleRemoved = false;
  if (wasAccepted && grantRoleId && member)
    roleRemoved = await member.roles.remove(grantRoleId, `Mod app acceptance undone by ${interaction.user.tag}`).then(() => true).catch(() => false);
  post.status = 'open'; delete post.lastRelayPingAt; delete post.grantedAs; saveState(state);
  // reopen the review post: unlock + unarchive + back to the Pending tag, re-enable the decision buttons
  const review = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  if (review) {
    await review.setArchived(false).catch(() => {});
    await review.setLocked(false).catch(() => {});
    await review.setAppliedTags(c.tags?.pending ? [c.tags.pending] : []).catch(() => {});
  }
  const answers = answersFromEmbed(interaction.message.embeds[0]);
  await interaction.editReply({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) }).catch(() => {});
  // reopen the applicant thread with a gentle, honest note (avoids a silent role-yank with no context)
  const appThread = post.appThreadId ? await interaction.guild.channels.fetch(post.appThreadId).catch(() => null) : null;
  if (appThread) {
    await appThread.setArchived(false).catch(() => {});
    await appThread.send('↩️ Quick update: your application has been reopened for another look. Hang tight; staff will follow up here. 🌱').catch(() => {});
  }
  await ownerlog.log(interaction.guild, { emoji: '↩️', title: 'Mod application decision undone', color: 0xF1C40F,
    detail: `<@${post.applicantId}> — was ${wasAccepted ? 'accepted' : 'denied'}, reopened${roleRemoved ? ` (removed ${grantLabel})` : ''} — by <@${interaction.user.id}>.` });
  return interaction.followUp({ content: `↩️ Reopened the application${wasAccepted ? (roleRemoved ? ` and removed the **${grantLabel}** role` : ` (⚠️ couldn’t remove **${grantLabel}**, check the role/hierarchy)`) : ''}. It’s back to **open** for a fresh decision.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
}

async function handleButton(interaction, config) {
  const id = interaction.customId;
  if (id === 'modapp_up') return vote(interaction, 'up');
  if (id === 'modapp_down') return vote(interaction, 'down');
  if (id === 'modapp_accept') return beginAccept(interaction);
  if (id === 'modapp_accept_grant') return finishAccept(interaction, config);
  if (id === 'modapp_deny') return resolve(interaction, false, config);
  if (id === 'modapp_askanon') return askAnonModal(interaction);
  if (id === 'modapp_undo') return undo(interaction, config);
  // applicant-facing position picker (not staff-gated in index.js): Moderator → mod modal; Language
  // mini-mod → show the language dropdown.
  // Re-check the closed gate here too — a stale position picker (opened while apps were open, clicked after
  // they closed) shouldn't reach the form. Turn them away up front instead of after they've typed it all.
  if (id === 'modapp_pos_mod') {
    if (!applicationsOpen('mod')) return interaction.reply({ content: closedNotice('mod'), flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildModal('mod'));
  }
  if (id === 'modapp_pos_lang') {
    if (!applicationsOpen('lang')) return interaction.reply({ content: closedNotice('lang'), flags: MessageFlags.Ephemeral });
    return interaction.update({ content: copy.modapps.whichLang, components: [languageSelectRow()] });
  }
}
// The language dropdown chosen → open the mini-mod modal for that language.
async function handlePositionSelect(interaction) {
  if (!applicationsOpen('lang')) return interaction.reply({ content: closedNotice('lang'), flags: MessageFlags.Ephemeral });
  return interaction.showModal(buildModal('lang', interaction.values?.[0]));
}

// One-time self-heal (idempotent, safe to run every boot): votes cast before weighted voting shipped
// are plain ID strings (weight 1 by the idOf/weightOf tolerance above) — upgrade them to {id, w} using
// each voter's CURRENT tier, so a vote already cast (e.g. an owner's, before this shipped) gets the
// weight it should've had, without making anyone re-click. Re-renders any post it actually changed.
async function upgradeLegacyVotes(guild) {
  const state = loadState();
  const touched = [];
  for (const [reviewThreadId, post] of Object.entries(state.posts)) {
    if (post.status !== 'open') continue;
    let changed = false;
    for (const dir of ['up', 'down']) {
      const list = post[dir] || [];
      for (let i = 0; i < list.length; i++) {
        if (typeof list[i] === 'string') {
          const uid = list[i];
          const member = await guild.members.fetch(uid).catch(() => null);
          const tier = member && opspanel.memberTier(member);
          list[i] = { id: uid, w: VOTE_WEIGHT[tier] || 1 };
          changed = true;
        }
      }
      post[dir] = list;
    }
    if (changed) touched.push(reviewThreadId);
  }
  if (touched.length) saveState(state);
  for (const reviewThreadId of touched) await rerender(guild, reviewThreadId);
  return touched.length;
}

// Enforce mod+-only membership on a review-forum thread: Discord lets ANY member with Manage Threads
// (i.e. any mod+) manually add someone to a specific thread — and that grant works even for someone whose
// CHANNEL-level permission is explicitly denied (thread membership bypasses the parent's ViewChannel deny).
// So a channel/category lockout alone can't stop a mod from hand-adding a trial mod to one review thread to
// ask their opinion — which is exactly how a real leak happened (found 2026-07-30: a trial mod was added to
// a specific application's review thread and could see + post there). This removes anyone below mod+ the
// moment they're found in a review thread, regardless of how they got there. Returns the list removed.
// Fetch a member, RETRYING transient failures (rate limits / network) so a sweep never silently SKIPS a
// leaker just because one fetch got 429'd — that bug let two demoted mods linger in every review thread
// (2026-08-01). Returns {member} on success, {gone:true} on a real Unknown Member (they left), or
// {unknown:true} if we still couldn't tell after retries — on which the caller must SKIP, never remove.
async function fetchMemberResilient(guild, userId, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return { member: await guild.members.fetch(userId) }; }
    catch (e) {
      if (e?.code === 10007) return { gone: true };            // Unknown Member — genuinely left the guild
      if (i === tries - 1) return { unknown: true };           // transient (rate limit / network) — give up
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
  return { unknown: true };
}
async function enforceReviewThreadMembers(guild, thread) {
  const removed = [];
  const tm = await thread.members.fetch().catch(() => null);
  if (!tm) return removed;
  for (const [, m] of tm) {
    const userId = m.id;
    if (userId === guild.client.user.id) continue;
    const r = await fetchMemberResilient(guild, userId);
    if (r.unknown) continue;                                   // couldn't verify — never remove on uncertainty
    if (r.member && opspanel.memberTier(r.member)) continue;   // legitimately mod+ — belongs here
    await thread.members.remove(userId).catch(() => {});       // non-staff, or left the guild → strip
    if (r.member) removed.push(r.member);
  }
  return removed;
}
// Applicant PRIVATE threads (in the apps channel) should hold ONLY the applicant + staff. Same
// thread-membership-bypass risk as review threads, but the applicant themselves legitimately belongs — so
// strip anyone who is neither staff NOR this thread's applicant. If we can't identify the applicant (state
// lost), we SKIP rather than risk removing the legit applicant.
async function enforceApplicantThreadMembers(guild, thread) {
  const removed = [];
  const post = Object.values(loadState().posts).find(p => p.appThreadId === thread.id);
  const applicantId = post?.applicantId;
  if (!applicantId) return removed;                            // unknown applicant → don't touch (safety)
  const tm = await thread.members.fetch().catch(() => null);
  if (!tm) return removed;
  for (const [, m] of tm) {
    const userId = m.id;
    if (userId === guild.client.user.id || userId === applicantId) continue;
    const r = await fetchMemberResilient(guild, userId);
    if (r.unknown) continue;
    if (r.member && opspanel.memberTier(r.member)) continue;   // staff belong
    await thread.members.remove(userId).catch(() => {});
    if (r.member) removed.push(r.member);
  }
  return removed;
}
// When someone drops below mod+ (demoted), Discord KEEPS their existing review-thread memberships — an
// ex-mod would still see staff deliberations. Sweep this specific user out of every review thread on the
// demotion event (the guildMemberUpdate handler already confirmed they're now non-staff). Returns count.
async function removeDemotedFromReviewThreads(guild, userId) {
  const c = loadConfig();
  if (!c.forumId) return 0;
  const active = await guild.channels.fetchActiveThreads().catch(() => ({ threads: new Map() }));
  const forum = await guild.channels.fetch(c.forumId).catch(() => null);
  if (!forum) return 0;
  const archived = await forum.threads.fetchArchived({ limit: 100 }).catch(() => ({ threads: new Map() }));
  const all = [...active.threads.values(), ...archived.threads.values()].filter(t => t.parentId === c.forumId);
  let removed = 0;
  for (const t of all) {
    const tm = await t.members.fetch().catch(() => null);
    if (tm && tm.has(userId)) { await t.members.remove(userId).catch(() => {}); removed++; }
  }
  return removed;
}
// Sweep every review thread (active + archived) in the forum on boot — catches anything added while the
// bot was offline, or before this enforcement existed. Returns the total removed.
async function sweepReviewThreadMembers(guild) {
  const c = loadConfig();
  if (!c.forumId) return 0;
  const active = await guild.channels.fetchActiveThreads().catch(() => ({ threads: new Map() }));
  const forum = await guild.channels.fetch(c.forumId).catch(() => null);
  if (!forum) return 0;
  const archived = await forum.threads.fetchArchived().catch(() => ({ threads: new Map() }));
  const all = [...active.threads.values(), ...archived.threads.values()].filter(t => t.parentId === c.forumId);
  let total = 0;
  for (const t of all) total += (await enforceReviewThreadMembers(guild, t)).length;
  return total;
}

// Applicant → staff relay: applicants talk in their PRIVATE thread, but no staff are members of that
// thread (it's private, only the applicant is added), so their replies notify nobody. Mirror each reply
// onto the STAFF review post so the whole two-sided conversation lives in one anonymous place, and ping
// the mod role so staff actually get notified. Ping is debounced (RELAY_PING_MS) so a chatty applicant
// firing off several lines pings once, not once per line — every line still mirrors.
const RELAY_PING_MS = 90 * 1000;
async function relayApplicantReply(msg, config) {
  const ch = msg.channel;
  if (!ch?.isThread?.()) return false;
  const c = loadConfig();
  if (!c.appsChannelId || ch.parentId !== c.appsChannelId) return false;  // cheap gate: only mod-app threads
  const state = loadState();
  const entry = Object.entries(state.posts).find(([, p]) => p.appThreadId === ch.id && p.status === 'open');
  if (!entry) return false;                       // resolved/untracked app thread - nothing to mirror
  const [reviewThreadId, post] = entry;
  if (msg.author.id !== post.applicantId) return true;  // it's an app thread, but not the applicant - swallow, don't relay
  const review = await msg.guild.channels.fetch(reviewThreadId).catch(() => null);
  if (!review) return true;
  const now = Date.now();
  const doPing = !!config.modRoleId && (now - (post.lastRelayPingAt || 0) > RELAY_PING_MS);
  const body = (msg.content || '').slice(0, 4000);
  const atts = [...msg.attachments.values()].map(a => a.url);
  const icon = msg.author.displayAvatarURL?.();  // empty/invalid → omit (discord.js rejects a non-URL iconURL)
  const e = new EmbedBuilder().setColor(0x2ECC71)
    .setAuthor({ name: '💬 Applicant replied', ...(icon ? { iconURL: icon } : {}) })
    .setDescription(body || (atts.length ? '*(attachment only)*' : '*(no text)*'))
    .setFooter({ text: `Reply in-thread with 🕵️ Ask anonymously · ${new Date(now).toISOString().slice(11, 16)} UTC` });
  if (atts.length) e.addFields({ name: 'Attachments', value: atts.slice(0, 5).join('\n').slice(0, 1024) });
  await review.send({
    content: doPing ? `<@&${config.modRoleId}> 📬 new reply from the applicant` : undefined,
    embeds: [e],
    allowedMentions: doPing ? { roles: [config.modRoleId] } : { parse: [] },
  }).catch(err => console.error('[modapps] relay send:', err.message));
  if (doPing) { post.lastRelayPingAt = now; saveState(state); }
  return true;
}

// Owner-only archive channel: created once, cached in the modapps config (same file/pattern as
// forumId/appsChannelId). @everyone AND MODS/ADMINS explicitly denied (they'd otherwise inherit view from
// the mod-activities category) — only the OWNER roles can see it. This is where a mod+'s own application
// is moved (see archiveOwnApplication) once they can browse the whole forum and would otherwise find it.
async function ensureArchiveChannel(guild) {
  let c = loadConfig();
  if (c.archiveChannelId) { const ex = await guild.channels.fetch(c.archiveChannelId).catch(() => null); if (ex) return ex; }
  const forum = c.forumId ? await guild.channels.fetch(c.forumId).catch(() => null) : null;
  const overwrites = [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: opspanel.MOD_ROLE_ID, deny: [P.ViewChannel] },
    { id: opspanel.ADMIN_ROLE_ID, deny: [P.ViewChannel] },
    ...opspanel.OWNER_ROLE_IDS.map(id => ({ id, allow: [P.ViewChannel, P.ReadMessageHistory] })),
  ];
  const channel = await guild.channels.create({
    name: '🔐┆application-archive', type: ChannelType.GuildText, parent: forum?.parentId || undefined,
    topic: 'Owner-only. Applications moved here once the applicant is staff and could otherwise browse to their own in the review forum.',
    permissionOverwrites: overwrites, reason: 'Owner-only application archive (owner request)',
  });
  c.archiveChannelId = channel.id; saveConfig(c);
  return channel;
}

// A mod+ can browse the ENTIRE review forum (that's the job) — so unlike a trial mod (blocked from the
// forum outright), removing them from their own applicant thread isn't enough; they'd still find their own
// review post just by scrolling the forum. So instead: post a static archived copy to the owner-only
// archive channel, then DELETE both the review post and the applicant thread from the forum/apps channel.
// History is kept (the archive), but nobody below owner — including the person themselves — can browse to
// it anymore. Idempotent (posts are removed from state as they're archived). Returns count archived.
async function archiveOwnApplication(guild, memberId) {
  const state = loadState();
  const mine = Object.entries(state.posts).filter(([, p]) => p.applicantId === memberId);
  if (!mine.length) return 0;
  const archiveCh = await ensureArchiveChannel(guild).catch(() => null);
  if (!archiveCh) return 0;
  let archived = 0;
  for (const [reviewThreadId, post] of mine) {
    const review = await guild.channels.fetch(reviewThreadId).catch(() => null);
    const starter = review && await review.fetchStarterMessage().catch(() => null);
    const answers = starter ? answersFromEmbed(starter.embeds[0]) : {};
    const e = reviewEmbed(post, answers, post.status !== 'open' ? post.status : null, post.decidedBy)
      .setTitle('🔐 Archived application').setFooter({ text: `Moved here once <@${memberId}> gained staff access to the review forum. Owner-only.` });
    await archiveCh.send({ embeds: [e] }).catch(() => {});
    if (review) await review.delete('own-application archive (owner request)').catch(() => {});
    if (post.appThreadId) { const at = await guild.channels.fetch(post.appThreadId).catch(() => null); if (at) await at.delete('own-application archive (owner request)').catch(() => {}); }
    delete state.posts[reviewThreadId];
    archived++;
  }
  saveState(state);
  return archived;
}

// Trial-mod-only fix: a trial mod can't see the review forum at all (category-gated), so their only handle
// on their own application is the private applicant thread they're a member of — remove their membership
// (thread + review post stay for staff). Idempotent. NOT sufficient for mod+ — see archiveOwnApplication.
async function sealOwnApplication(guild, memberId) {
  const state = loadState();
  const mine = Object.values(state.posts).filter(p => p.applicantId === memberId && p.appThreadId);
  let sealed = 0;
  for (const p of mine) {
    const thread = await guild.channels.fetch(p.appThreadId).catch(() => null);
    if (!thread) continue;
    const wasArchived = !!thread.archived;
    if (wasArchived) await thread.setArchived(false).catch(() => {});
    const ok = await thread.members.remove(memberId).then(() => true).catch(() => false);
    if (wasArchived) await thread.setArchived(true).catch(() => {});
    if (ok) sealed++;
  }
  return sealed;
}

// One-time (idempotent) backfill: the ↩️ Undo button was added after some applications were already
// resolved, so their review posts have no way back. Walk every RESOLVED post and add the Undo button to
// its starter message if it's missing. Archived review threads are briefly un-archived to edit, then
// re-archived, so the backfill leaves the thread's archive state as it found it.
async function backfillUndoButtons(guild) {
  const state = loadState();
  let added = 0;
  for (const [reviewThreadId, post] of Object.entries(state.posts)) {
    if (post.status === 'open') continue;   // open posts still have live accept/deny - undo is for resolved ones
    const review = await guild.channels.fetch(reviewThreadId).catch(() => null);
    if (!review) continue;
    const starter = await review.fetchStarterMessage().catch(() => null);
    if (!starter) continue;
    const hasUndo = (starter.components || []).some(row => (row.components || []).some(c => c.customId === 'modapp_undo'));
    if (hasUndo) continue;
    const wasArchived = !!review.archived;
    try {
      if (wasArchived) await review.setArchived(false).catch(() => {});
      await starter.edit({ embeds: starter.embeds, components: [...reviewComponents(post, true), undoRow()] });
      added++;
      if (wasArchived) await review.setArchived(true).catch(() => {});
    } catch (e) { console.error('[modapps] backfill undo', reviewThreadId, e.message); }
  }
  return added;
}

// Re-render an OPEN review post's embed from state (used to push new fields like the applicant link).
async function rerender(guild, reviewThreadId) {
  const state = loadState();
  const post = state.posts[reviewThreadId];
  if (!post || post.status !== 'open') return { ok: false };
  const review = await guild.channels.fetch(reviewThreadId).catch(() => null);
  const starter = review && await review.fetchStarterMessage().catch(() => null);
  if (!starter) return { ok: false };
  const answers = answersFromEmbed(starter.embeds[0]);
  await starter.edit({ embeds: [reviewEmbed(post, answers)], components: reviewComponents(post, false) }).catch(() => {});
  return { ok: true, appThreadId: post.appThreadId };
}

// --- applications open/closed intake toggle ------------------------------------------------------
// Close intake when the team is full: new /apply-mod attempts are turned away, but applications ALREADY
// under review keep going (the gate is only at the entry + modal submit, never on existing threads).
// Owner, 2026-08-17: "mini mods and regular mods should have to separate closing/opening states" — the
// Moderator track and the Mini-mod track close/open INDEPENDENTLY now (e.g. the mod team can be full
// while mini-mod slots stay open, or vice versa), instead of one shared flag closing both. "Mini-mod"
// covers every scope langmods.js manages, not just languages — e.g. the LGBTQ+ chat mini-mod too.
const DEFAULT_CLOSED_NOTICE = '🚫 Applications for that position are currently **closed** right now. Thanks for the interest, and keep an eye out for when they reopen!';
// Back-compat migration: a pre-per-track config only has the old `applicationsClosed` boolean — treat it
// as both tracks starting in that same state, once, then always read/write the new shape from then on.
function closedTracks() {
  const c = loadConfig();
  if (c.closedTracks) return c.closedTracks;
  return { mod: c.applicationsClosed === true, lang: c.applicationsClosed === true };
}
function applicationsOpen(track = 'mod') { return closedTracks()[track] !== true; }
function closedNotice(track = 'mod') {
  const c = loadConfig();
  const n = (c.closedNotices?.[track] || c.closedNotice || '').trim();
  return n || DEFAULT_CLOSED_NOTICE;
}
async function setApplicationsOpen(guild, open, message, track = 'both') {
  const c = loadConfig();
  const tracks = closedTracks();
  const affected = track === 'both' ? ['mod', 'lang'] : [track];
  for (const t of affected) tracks[t] = !open;
  c.closedTracks = tracks;
  delete c.applicationsClosed;   // fully migrated onto closedTracks from here on
  if (typeof message === 'string' && message.trim()) {
    c.closedNotices = c.closedNotices || {};
    for (const t of affected) c.closedNotices[t] = message.trim();
  }
  saveConfig(c);
  // reflect the state on the applicant forum's topic so it's visible at a glance
  try {
    const ch = c.appsChannelId && await guild.channels.fetch(c.appsChannelId).catch(() => null);
    if (ch && ch.setTopic) {
      const base = 'Apply with /apply-mod. Your application opens as a private thread here that only you + staff can see.';
      const closedBits = [];
      if (tracks.mod) closedBits.push('Moderator');
      if (tracks.lang) closedBits.push('Mini-mod');
      await ch.setTopic(closedBits.length ? `🚫 CLOSED for: ${closedBits.join(', ')}. ${base}` : base).catch(() => {});
    }
  } catch { /* topic update is best-effort */ }
  return { open };
}

module.exports = { setup, buildModal, positionRow, submitFromModal, handleButton, handlePositionSelect, handleAskModal, isConfigured, loadConfig, migrateLegacy, rerender, upgradeLegacyVotes, relayApplicantReply, backfillUndoButtons, sealOwnApplication, archiveOwnApplication,
  enforceReviewThreadMembers, enforceApplicantThreadMembers, removeDemotedFromReviewThreads, sweepReviewThreadMembers, applicationsOpen, closedNotice, setApplicationsOpen };
