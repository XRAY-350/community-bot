// creator.js — Content Creator submission flow (owner, 2026-08-22). A Content Creator submits a clip /
// art / meme via /create submit (a slash command, not a modal — modals can't take file attachments). It
// posts a review card into the creator-chat; a mod+ Approves or Requests changes. On Approve the content
// is re-posted into the public #showcase channel, credited to the creator. Mirrors advertise.js, but the
// approved content posts to a PUBLIC channel instead of staging for a manual external post.
const fs = require('fs');
const { statePath } = require('./statepath');
const { withLock } = require('./mutex');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags } = require('discord.js');
const { media, mediaShowcaseId } = require('./staffpositions');
const ownerlog = require('./ownerlog');

const STATE_FILE = process.env.FUBU_CREATE_STATE_FILE || statePath('creator_submissions.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { subs: {} }; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[creator] save:', e.message); } }

const reviewRow = (id, done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`content_approve:${id}`).setEmoji('✅').setLabel('Approve → showcase').setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId(`content_changes:${id}`).setEmoji('✏️').setLabel('Request changes').setStyle(ButtonStyle.Secondary).setDisabled(!!done));

function reviewEmbed(sub, statusLine) {
  const e = new EmbedBuilder().setColor(sub.status === 'posted' ? 0x57F287 : sub.status === 'changes' ? 0xF1C40F : 0x5865F2)
    .setTitle('🎬 Content submission').addFields(
      { name: 'From', value: `<@${sub.submitterId}>`, inline: true },
      { name: 'Kind', value: sub.kind || 'content', inline: true },
      { name: 'Caption', value: (sub.caption || '_(none)_').slice(0, 1024) });
  if (statusLine) e.addFields({ name: 'Status', value: statusLine.slice(0, 1024) });
  e.setFooter({ text: 'A mod+ approves. Approved content posts to #showcase.' });
  return e;
}

// Called from /create submit. `interaction` already gated (creator or staff) in index.js.
// Serialized behind the module lock (audit U10): this is a load->awaits->save read-modify-write; two
// concurrent calls used to lose the earlier one's record (the documented appeals.js incident class).
async function submit(interaction) { return withLock('creator', () => _submit(interaction)); }
async function _submit(interaction) {
  if (!media.isConfigured()) return interaction.reply({ content: 'Media Team tools aren’t set up yet. Ask an admin to run `/panel` → 🧩 Setup → 🎬 Media Team apps.', flags: MessageFlags.Ephemeral });
  const coordId = media.coordChannelId();
  const coord = coordId && await interaction.guild.channels.fetch(coordId).catch(() => null);
  if (!coord) return interaction.reply({ content: 'The media coordination channel is missing — ask an admin to re-run `/panel` → 🧩 Setup → 🎬 Media Team apps.', flags: MessageFlags.Ephemeral });
  const file = interaction.options.getAttachment('file');
  const caption = (interaction.options.getString('caption') || '').trim();
  if (!file) return interaction.reply({ content: 'Attach a clip, image, or meme to submit.', flags: MessageFlags.Ephemeral });
  const ct = file.contentType || '';
  const isImage = ct.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.name || '');
  const isVideo = ct.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name || '');
  if (!isImage && !isVideo) return interaction.reply({ content: 'That file isn’t an image or video. Submit a clip, image, or meme.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const id = `${interaction.user.id}-${interaction.id}`;
  const sub = { id, submitterId: interaction.user.id, caption, kind: isVideo ? 'video' : 'image', status: 'pending' };
  const card = await coord.send({
    content: `🎬 New content from <@${interaction.user.id}> — a mod+ can approve it to #showcase.`,
    embeds: [reviewEmbed(sub)], components: [reviewRow(id, false)],
    files: [{ attachment: file.url, name: file.name || (isVideo ? 'clip.mp4' : 'art.png') }],
    allowedMentions: { users: [] },
  }).catch(e => { console.error('[creator] post card:', e.message); return null; });
  if (!card) return interaction.editReply('Couldn’t post the submission (maybe the file is too large for me to re-upload). Try a smaller file.');
  sub.reviewChannelId = coord.id; sub.reviewMsgId = card.id; sub.fileName = file.name;
  const s = loadState(); s.subs[id] = sub; saveState(s);
  return interaction.editReply(`✅ Submitted for review in <#${coord.id}>. Staff will approve it to #showcase or ask for changes.`);
}

async function handleButton(interaction) {
  const [act, id] = interaction.customId.split(':');
  const s = loadState(); const sub = s.subs[id];
  if (!sub) return interaction.reply({ content: 'This submission isn’t tracked (it may predate a restart).', flags: MessageFlags.Ephemeral });
  if (act === 'content_changes') {
    const modal = new ModalBuilder().setCustomId(`content_changes_modal:${id}`).setTitle('Request changes')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('note').setLabel('What should they change?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
    return interaction.showModal(modal);
  }
  if (act === 'content_approve') {
    if (sub.status !== 'pending') return interaction.reply({ content: `Already ${sub.status}.`, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const showcaseId = mediaShowcaseId();
    const showcase = showcaseId && await interaction.guild.channels.fetch(showcaseId).catch(() => null);
    if (!showcase) return interaction.editReply('The #showcase channel is missing — ask an admin to re-run `/panel` → 🧩 Setup → 🎬 Media Team apps.');
    // Re-fetch the review message for a fresh attachment URL, then re-post the file into #showcase.
    let att = null;
    try {
      const ch = await interaction.guild.channels.fetch(sub.reviewChannelId).catch(() => null);
      const msg = ch && await ch.messages.fetch(sub.reviewMsgId).catch(() => null);
      att = msg && [...msg.attachments.values()][0];
    } catch (e) { console.error('[creator] fetch clip:', e.message); }
    if (!att) return interaction.editReply('Couldn’t retrieve the file from the submission message. Ask them to re-submit.');
    let posted = null;
    try {
      posted = await showcase.send({
        content: `🎬 **by <@${sub.submitterId}>**${sub.caption ? `\n${sub.caption}` : ''}`,
        files: [{ attachment: att.url, name: sub.fileName || att.name }],
        allowedMentions: { users: [] },
      });
    } catch (e) { console.error('[creator] showcase post:', e.message); }
    if (!posted) return interaction.editReply('Couldn’t post to #showcase (file too large, or missing permission there).');
    sub.status = 'posted'; sub.showcaseMsgId = posted.id; saveState(s);
    try {
      const ch = await interaction.guild.channels.fetch(sub.reviewChannelId).catch(() => null);
      const msg = ch && await ch.messages.fetch(sub.reviewMsgId).catch(() => null);
      if (msg) await msg.edit({ embeds: [reviewEmbed(sub, `✅ Approved by <@${interaction.user.id}> → posted to <#${showcase.id}>.`)], components: [reviewRow(id, true)] }).catch(() => {});
    } catch { /* best-effort */ }
    await ownerlog.log(interaction.guild, { emoji: '🎬', title: 'Content approved → showcase', color: 0x57F287, detail: `<@${sub.submitterId}>’s ${sub.kind}, approved by <@${interaction.user.id}> → <#${showcase.id}>.` }).catch(() => {});
    return interaction.editReply(`✅ Approved and posted to <#${showcase.id}>.`);
  }
}

async function handleModal(interaction) {
  const [, id] = interaction.customId.split(':');
  const s = loadState(); const sub = s.subs[id];
  if (!sub) return interaction.reply({ content: 'This submission isn’t tracked.', flags: MessageFlags.Ephemeral });
  const note = (interaction.fields.getTextInputValue('note') || '').trim();
  sub.status = 'changes'; saveState(s);
  try {
    const ch = await interaction.guild.channels.fetch(sub.reviewChannelId).catch(() => null);
    const msg = ch && await ch.messages.fetch(sub.reviewMsgId).catch(() => null);
    if (msg) await msg.edit({ embeds: [reviewEmbed(sub, `✏️ Changes requested by <@${interaction.user.id}>: ${note}`)], components: [reviewRow(id, true)] }).catch(() => {});
    if (ch) await ch.send({ content: `✏️ <@${sub.submitterId}>, a change was requested on your content: ${note}\nTweak it and re-submit with \`/create submit\`.`, allowedMentions: { users: [sub.submitterId] } }).catch(() => {});
  } catch (e) { console.error('[creator] changes:', e.message); }
  return interaction.reply({ content: 'Sent them the requested changes.', flags: MessageFlags.Ephemeral });
}

module.exports = { submit, handleButton, handleModal };
