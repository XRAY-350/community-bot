// advertise.js — promo submission + staff approval (owner, 2026-08-22). A Media Team member submits a
// promo CLIP via /advertise submit (a slash command, not a modal — modals can't take file attachments).
// It posts a review card into the media-chat; a mod+ Approves or Requests changes. On Approve the clip is
// STAGED for a human to post to TikTok manually (owner dropped the direct-to-TikTok API posting) — the
// card is marked approved and a "ready to post" note is dropped in the chat, with the clip already
// attached above. (Advertiser was merged into the Media Team position — see staffpositions.js.)
const fs = require('fs');
const { statePath } = require('./statepath');
const { withLock } = require('./mutex');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags } = require('discord.js');
const { media } = require('./staffpositions');
const ownerlog = require('./ownerlog');

const STATE_FILE = process.env.FUBU_ADVERTISE_STATE_FILE || statePath('advertise_state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { subs: {} }; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[advertise] save:', e.message); } }

const reviewRow = (id, done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`promo_approve:${id}`).setEmoji('✅').setLabel('Approve + post').setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId(`promo_changes:${id}`).setEmoji('✏️').setLabel('Request changes').setStyle(ButtonStyle.Secondary).setDisabled(!!done));

function reviewEmbed(sub, statusLine) {
  const e = new EmbedBuilder().setColor(sub.status === 'approved' ? 0x57F287 : sub.status === 'changes' ? 0xF1C40F : 0x5865F2)
    .setTitle('📣 Promo submission').addFields(
      { name: 'From', value: `<@${sub.submitterId}>`, inline: true },
      { name: 'Platform', value: sub.platform || 'TikTok', inline: true },
      { name: 'Caption', value: (sub.caption || '_(none)_').slice(0, 1024) });
  if (statusLine) e.addFields({ name: 'Status', value: statusLine.slice(0, 1024) });
  e.setFooter({ text: 'A mod+ approves. Approved clips are staged here to post to TikTok manually.' });
  return e;
}

// Called from /advertise submit. `interaction` already gated (advertiser or staff) in index.js.
// Serialized behind the module lock (audit U10): this is a load->awaits->save read-modify-write; two
// concurrent calls used to lose the earlier one's record (the documented appeals.js incident class).
async function submit(interaction) { return withLock('advertise', () => _submit(interaction)); }
async function _submit(interaction) {
  if (!media.isConfigured()) return interaction.reply({ content: 'Media Team tools aren’t set up yet. Ask an admin to run `/panel` → 🧩 Setup → 🎬 Media Team apps.', flags: MessageFlags.Ephemeral });
  const coordId = media.coordChannelId();
  const coord = coordId && await interaction.guild.channels.fetch(coordId).catch(() => null);
  if (!coord) return interaction.reply({ content: 'The media coordination channel is missing — ask an admin to re-run `/panel` → 🧩 Setup → 🎬 Media Team apps.', flags: MessageFlags.Ephemeral });
  const video = interaction.options.getAttachment('video');
  const caption = (interaction.options.getString('caption') || '').trim();
  const platform = (interaction.options.getString('platform') || 'TikTok').trim();
  if (!video) return interaction.reply({ content: 'Attach a video clip to submit.', flags: MessageFlags.Ephemeral });
  const isVideo = (video.contentType || '').startsWith('video/') || /\.(mp4|mov|webm)$/i.test(video.name || '');
  if (!isVideo) return interaction.reply({ content: 'That attachment isn’t a video. TikTok posts need a video clip (mp4/mov).', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Re-attach the clip onto a bot message in the coord channel so we can re-fetch fresh bytes at approval.
  const id = `${interaction.user.id}-${interaction.id}`;
  const sub = { id, submitterId: interaction.user.id, caption, platform, status: 'pending' };
  const card = await coord.send({
    content: `📣 New promo from <@${interaction.user.id}> — a mod+ can approve it.`,
    embeds: [reviewEmbed(sub)], components: [reviewRow(id, false)],
    files: [{ attachment: video.url, name: video.name || 'promo.mp4' }],
    allowedMentions: { users: [] },
  }).catch(e => { console.error('[advertise] post card:', e.message); return null; });
  if (!card) return interaction.editReply('Couldn’t post the submission (maybe the clip is too large for me to re-upload). Try a smaller file or share it in the coord channel directly.');
  sub.reviewChannelId = coord.id; sub.reviewMsgId = card.id;
  const s = loadState(); s.subs[id] = sub; saveState(s);
  return interaction.editReply(`✅ Submitted for review in <#${coord.id}>. Staff will approve or ask for changes.`);
}

async function handleButton(interaction) {
  const [act, id] = interaction.customId.split(':');
  const s = loadState(); const sub = s.subs[id];
  if (!sub) return interaction.reply({ content: 'This submission isn’t tracked (it may predate a restart).', flags: MessageFlags.Ephemeral });
  if (act === 'promo_changes') {
    const modal = new ModalBuilder().setCustomId(`promo_changes_modal:${id}`).setTitle('Request changes')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('note').setLabel('What should they change?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
    return interaction.showModal(modal);
  }
  if (act === 'promo_approve') {
    if (sub.status !== 'pending') return interaction.reply({ content: `Already ${sub.status}.`, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Owner dropped direct-to-TikTok posting — approving just STAGES the clip for a human to post. The clip
    // is already attached to the review card above, so no download needed; mark it approved and drop a
    // "ready to post" note in the chat.
    sub.status = 'approved'; saveState(s);
    try {
      const ch = await interaction.guild.channels.fetch(sub.reviewChannelId).catch(() => null);
      const msg = ch && await ch.messages.fetch(sub.reviewMsgId).catch(() => null);
      if (msg) await msg.edit({ embeds: [reviewEmbed(sub, `✅ Approved by <@${interaction.user.id}> — ready to post to TikTok manually (clip above).`)], components: [reviewRow(id, true)] }).catch(() => {});
      if (ch) await ch.send({ content: `✅ **Ready to post to TikTok** — <@${sub.submitterId}>’s clip is above.\n**Caption:** ${sub.caption || '_(none)_'}`, allowedMentions: { users: [] } }).catch(() => {});
    } catch (e) { console.error('[advertise] approve:', e.message); }
    await ownerlog.log(interaction.guild, { emoji: '📣', title: 'Promo approved', color: 0x57F287, detail: `<@${sub.submitterId}>’s clip, approved by <@${interaction.user.id}> — staged for a manual TikTok post.` }).catch(() => {});
    return interaction.editReply('✅ Approved and staged in the advertiser-chat for a manual TikTok post.');
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
    if (ch) await ch.send({ content: `✏️ <@${sub.submitterId}>, a change was requested on your promo: ${note}\nTweak it and re-submit with \`/advertise submit\`.`, allowedMentions: { users: [sub.submitterId] } }).catch(() => {});
  } catch (e) { console.error('[advertise] changes:', e.message); }
  return interaction.reply({ content: 'Sent them the requested changes.', flags: MessageFlags.Ephemeral });
}

module.exports = { submit, handleButton, handleModal };
