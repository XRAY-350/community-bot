// modapps.js — mod applications. Members run /apply-mod, fill a modal, and the bot files their
// application as a post in a PRIVATE, staff-only forum (members can't see it or each other's apps).
// Each post carries the applicant's answers + ✅ Accept / ❌ Deny buttons (admins+ only). Accepting/
// denying tags + archives the post and DMs the applicant. Mirrors the suggestions-forum pattern.
// Note: Accept does NOT auto-grant the mod role (too sensitive) — staff assign it by hand.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField,
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const CONFIG_FILE = process.env.FUBU_MODAPPS_FILE || '/home/ubuntu/.fubu_modapps.json';
const STATE_FILE = process.env.FUBU_MODAPPS_STATE_FILE || '/home/ubuntu/.fubu_modapps_state.json';
const COOLDOWN_MS = 60 * 1000;   // small anti-double-submit guard
const P = PermissionsBitField.Flags;

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
function isConfigured() { const c = loadConfig(); return !!(c.forumId && c.tags); }

// ---- setup: private staff-only forum (cloned from the watch-log's mod-only visibility) --------------
async function setup(guild, config) {
  let c = loadConfig();
  if (c.forumId) { const ex = await guild.channels.fetch(c.forumId).catch(() => null); if (ex) return { forum: ex, created: false }; }
  const wl = config?.watchLogChannelId ? await guild.channels.fetch(config.watchLogChannelId).catch(() => null) : null;
  const staffOverwrites = (wl && wl.permissionOverwrites.cache.size)
    ? [...wl.permissionOverwrites.cache.values()].map(o => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
    : [{ id: guild.id, deny: [P.ViewChannel] }];
  // ensure @everyone can't create posts either (bot-gated + hidden)
  const forum = await guild.channels.create({
    name: '📋┆ᴍᴏᴅ-ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴs', type: ChannelType.GuildForum,
    topic: 'Mod applications — staff only. Members apply with /apply-mod; the bot files them here.',
    permissionOverwrites: staffOverwrites,
    availableTags: TAGS.map(t => ({ name: t.name, moderated: true, emoji: { id: null, name: t.emoji } })),
    defaultAutoArchiveDuration: 10080,
    reason: 'Mod applications forum (owner request)',
  });
  const fresh = await guild.channels.fetch(forum.id);
  const tagMap = {};
  for (const t of TAGS) { const f = fresh.availableTags.find(x => x.name === t.name); if (f) tagMap[t.key] = f.id; }
  c = { forumId: forum.id, tags: tagMap };
  saveConfig(c);
  return { forum: fresh, created: true };
}

function buildModal() {
  const m = new ModalBuilder().setCustomId('modapp_submit').setTitle('Mod application');
  for (const q of QUESTIONS) {
    m.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(q.id).setLabel(q.label).setStyle(q.style).setRequired(q.required).setMaxLength(q.max)));
  }
  return m;
}

const staffRow = (resolved) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('modapp_accept').setEmoji('✅').setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(!!resolved),
  new ButtonBuilder().setCustomId('modapp_deny').setEmoji('❌').setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(!!resolved));

function appEmbed(member, answers, resolution, byId) {
  const e = new EmbedBuilder().setColor(resolution === 'accepted' ? 0x57F287 : resolution === 'denied' ? 0xED4245 : 0x5865F2)
    .setTitle(`📋 Mod application`).setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
    .addFields(
      { name: 'Applicant', value: `<@${member.id}>`, inline: true },
      { name: 'Age', value: answers.age || '—', inline: true },
      { name: 'Active', value: (answers.tz || '—').slice(0, 1024), inline: true },
      { name: 'Why mod?', value: (answers.why || '—').slice(0, 1024) });
  if (answers.exp) e.addFields({ name: 'Experience', value: answers.exp.slice(0, 1024) });
  if (answers.extra) e.addFields({ name: 'Anything else', value: answers.extra.slice(0, 1024) });
  if (resolution) e.addFields({ name: resolution === 'accepted' ? '✅ Accepted by' : '❌ Denied by', value: `<@${byId}>`, inline: true });
  return e;
}

// ---- submit (from the modal) ------------------------------------------------------------------------
async function submitFromModal(interaction) {
  const c = loadConfig();
  if (!c.forumId) return interaction.reply({ content: 'Applications aren’t open right now.', flags: MessageFlags.Ephemeral });
  const state = loadState();
  const mine = Object.values(state.posts).find(p => p.applicantId === interaction.user.id && p.status === 'open');
  if (mine) return interaction.reply({ content: 'You already have an application under review — hang tight.', flags: MessageFlags.Ephemeral });
  const last = state.cooldown[interaction.user.id] || 0;
  if (last && Date.now() - last < COOLDOWN_MS) return interaction.reply({ content: 'One sec before submitting again.', flags: MessageFlags.Ephemeral });

  const answers = {};
  for (const q of QUESTIONS) { try { answers[q.id] = interaction.fields.getTextInputValue(q.id); } catch { answers[q.id] = ''; } }
  const forum = await interaction.guild.channels.fetch(c.forumId).catch(() => null);
  if (!forum) return interaction.reply({ content: 'Applications aren’t set up right now — tell an admin.', flags: MessageFlags.Ephemeral });
  const member = interaction.member;
  const thread = await forum.threads.create({
    name: `Mod app · ${member.user.username}`.slice(0, 95),
    message: { embeds: [appEmbed(member, answers)], components: [staffRow(false)] },
    appliedTags: c.tags.pending ? [c.tags.pending] : [],
    reason: `Mod application by ${member.user.tag}`,
  });
  state.posts[thread.id] = { applicantId: member.id, status: 'open' };
  state.cooldown[member.id] = Date.now();
  saveState(state);
  return interaction.reply({ content: '✅ Your mod application is in — staff will review it. Thanks for stepping up 🙌', flags: MessageFlags.Ephemeral });
}

// ---- staff accept / deny (gated to admins+ in index.js) ---------------------------------------------
async function resolve(interaction, accepted) {
  const threadId = interaction.channelId;   // the button lives on the post's starter message
  const state = loadState();
  const post = state.posts[threadId];
  if (!post) return interaction.reply({ content: 'This application is no longer tracked.', flags: MessageFlags.Ephemeral });
  if (post.status !== 'open') return interaction.reply({ content: 'Already resolved.', flags: MessageFlags.Ephemeral });
  const c = loadConfig();
  post.status = accepted ? 'accepted' : 'denied';
  saveState(state);
  const member = await interaction.guild.members.fetch(post.applicantId).catch(() => null);
  const emb = appEmbed(member || { id: post.applicantId, user: { tag: 'applicant', displayAvatarURL: () => null } },
    { age: interaction.message.embeds[0]?.fields?.find(f => f.name === 'Age')?.value }, post.status, interaction.user.id);
  // simpler: rebuild from the existing embed to preserve answers
  const existing = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(accepted ? 0x57F287 : 0xED4245)
    .addFields({ name: accepted ? '✅ Accepted by' : '❌ Denied by', value: `<@${interaction.user.id}>`, inline: true });
  await interaction.update({ embeds: [existing], components: [staffRow(true)] });
  const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
  if (thread) {
    const tagId = accepted ? c.tags.accepted : c.tags.denied;
    await thread.setAppliedTags(tagId ? [tagId] : []).catch(() => {});
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  if (member) await member.send(accepted
    ? '🎉 Your mod application was **accepted**! Staff will reach out about next steps.'
    : 'Thanks for applying to mod — your application wasn’t accepted this time. You’re welcome to apply again later. 💛').catch(() => {});
  return interaction.followUp({ content: accepted ? `✅ Accepted — remember to assign <@${post.applicantId}> the mod role manually.` : `❌ Denied. Applicant was notified.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handleButton(interaction) {
  if (interaction.customId === 'modapp_accept') return resolve(interaction, true);
  if (interaction.customId === 'modapp_deny') return resolve(interaction, false);
}

module.exports = { setup, buildModal, submitFromModal, handleButton, isConfigured, loadConfig };
