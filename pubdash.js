// pubdash.js - the public member hub. Pinned in #bot-guide and opened by /dashboard. It is ACTION-based:
// the buttons DO the thing (open a modal, run the flow), they are not just a list of commands. Member
// features take their text as a slash option, so from a button we pop a modal to collect it, then hand
// it to the module's submit(). All views/replies are ephemeral. Hybrid embed+markdown, no em dashes.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const tribes = require('./tribes');
const strikes = require('./strikes');
const rules = require('./rules');
const config = require('./config');

const HUB_COLOR = 0x5865F2;
const LEVELS = [
  ['NOLIFE', '1529121471946035330'],
  ['Elite Chatter', '1529121191384842330'],
  ['Intermediate Chatter', '1529121181767176313'],
  ['Novice Chatter', '1529120692845674687'],
];

function hubButtons(guildId) {
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pubact_confess').setEmoji('💭').setLabel('Confess').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pubact_suggest').setEmoji('💡').setLabel('Suggest').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pubact_modmail').setEmoji('✉️').setLabel('Message staff').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pubact_report').setEmoji('🚩').setLabel('Report').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pubact_appeal').setEmoji('⚖️').setLabel('Appeal a strike').setStyle(ButtonStyle.Secondary));
  const trust = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pubact_whistleblow').setEmoji('🕊️').setLabel('Whistleblow').setStyle(ButtonStyle.Secondary));
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pubdash_status').setEmoji('👤').setLabel('My Status').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pubact_tribe').setEmoji('🏴').setLabel('My Tribe').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pubdash_info').setEmoji('📖').setLabel('Server Info').setStyle(ButtonStyle.Secondary));
  if (config.rolesChannelId && guildId) nav.addComponents(new ButtonBuilder().setEmoji('🎓').setLabel('Pick roles').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guildId}/${config.rolesChannelId}`));
  return [actions, trust, nav];
}

function hubPanel(guildId) {
  const embed = new EmbedBuilder().setColor(HUB_COLOR).setTitle('🤖 Member Hub')
    .setDescription([
      'Tap a button to *do* it. No commands to remember.',
      '',
      '💭 **Confess** anonymously   💡 **Suggest** an idea   ✉️ **Message staff** privately',
      '🚩 **Report** something   ⚖️ **Appeal a strike**',
      '🕊️ **Whistleblow** — a problem about the server or staff, straight to the top, no channel',
      '👤 **My Status**   🏴 **My Tribe**   📖 **Server Info**   🎓 **Pick roles**',
    ].join('\n'));
  return { embeds: [embed], components: hubButtons(guildId) };
}

// ---- text-collecting modals (one per action) ----
function textModal(customId, title, label, placeholder) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000).setPlaceholder(placeholder || '')));
}
const confessModal = () => textModal('pubmodal_confess', 'Anonymous confession', 'Your confession', 'Posted anonymously. Your name stays hidden.');
const suggestModal = () => textModal('pubmodal_suggest', 'Suggestion', 'Your suggestion', 'Others can vote. Staff approve or deny.');
const modmailModal = () => textModal('pubmodal_modmail', 'Message the mod team', 'Your message', 'Sent to staff privately. They can reply.');
const reportModal = () => textModal('pubmodal_report', 'Report to staff', 'What happened?', 'Sent to staff anonymously.');

// Whistleblow needs one extra choice (who it goes to, and whether it can ever be unmasked) that a modal
// can't collect alongside text — so the button flow asks for that first, THEN opens the text modal with
// the choice baked into its customId (pubmodal_whistleblow:<choice>).
const WB_CHOICE_LABEL = { you: 'Head admin only', her: 'Server owner only', both: 'Head admin + owner', anonymous: 'Anonymous — no one can unmask' };
function whistleblowPicker() {
  const row = new ActionRowBuilder().addComponents(
    ...Object.entries(WB_CHOICE_LABEL).map(([choice, label]) =>
      new ButtonBuilder().setCustomId(`pubact_wb_to:${choice}`).setLabel(label).setStyle(choice === 'anonymous' ? ButtonStyle.Danger : ButtonStyle.Secondary)));
  return {
    content: '🕊️ **Whistleblow** — a private DM straight to the top, never posted in any channel. Who should it go to?\n' +
      '_"Anonymous" is never traceable, even by the recipients — nothing identifying is ever stored._',
    components: [row],
  };
}
function whistleblowModal(choice) {
  return textModal(`pubmodal_whistleblow:${choice}`, `Whistleblow (${WB_CHOICE_LABEL[choice] || choice})`, 'What\'s going on?',
    choice === 'anonymous' ? 'Never traceable, not even by the recipients.' : 'Delivered privately by DM. Can be unsealed only on cause.');
}

// ---- ephemeral views ----
function statusView(member, state) {
  const level = LEVELS.find(([, id]) => member.roles.cache.has(id));
  const tribe = tribes.myTribe(member);
  const rankIdx = tribe ? tribes.currentRankIndex(member, tribe) : -1;
  const rankName = !tribe ? null : tribes.isLeader(member, tribe) ? tribes.leaderTitle(tribe) : (tribe.staffRankRoleId && member.roles.cache.has(tribe.staffRankRoleId)) ? tribes.staffRankTitle(tribe) : (rankIdx >= 0 && tribe.ranks && tribe.ranks[rankIdx]) ? tribe.ranks[rankIdx].name : null;
  const units = strikes.totalUnits(state, member.id);
  const perks = [];
  if (level) {
    const ln = level[0];
    perks.push('GIFs');
    if (['NOLIFE', 'Elite Chatter', 'Intermediate Chatter'].includes(ln)) perks.push('images');
    if (['NOLIFE', 'Elite Chatter'].includes(ln)) perks.push('voice messages');
    if (ln === 'NOLIFE') perks.push('external sounds');
  }
  const lines = [
    `**🏴 Tribe:** ${tribe ? `${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}${rankName ? ` (${rankName})` : ''}` : '_none yet. Pledge one in the #roles channel._'}`,
    `**📈 Level:** ${level ? level[0] : '_not leveled yet. Keep chatting._'}`,
    `**🎁 Unlocked:** ${perks.length ? perks.join(', ') : '_level up to unlock GIFs and images_'}`,
    `**⚖️ Strikes:** ${units > 0 ? `${strikes.formatUnits(units)} units (${strikes.tierName(units)})` : 'clean, nice work'}`,
  ];
  const embed = new EmbedBuilder().setColor(tribe && tribe.color ? tribe.color : HUB_COLOR)
    .setAuthor({ name: `${member.displayName}: your status`, iconURL: member.displayAvatarURL() })
    .setDescription(lines.join('\n'));
  return { embeds: [embed] };
}

function tribeView(member) {
  const tribe = tribes.myTribe(member);
  if (!tribe) return { content: 'You are not in a tribe yet. Head to the #roles channel and pledge to one.' };
  const memberCount = member.guild.roles.cache.get(tribe.roleId)?.members.size ?? 0;
  const rankIdx = tribes.currentRankIndex(member, tribe);
  const rankName = tribes.isLeader(member, tribe) ? `👑 ${tribes.leaderTitle(tribe)}` : (tribe.staffRankRoleId && member.roles.cache.has(tribe.staffRankRoleId)) ? `⭐ ${tribes.staffRankTitle(tribe)}` : (rankIdx >= 0 && tribe.ranks && tribe.ranks[rankIdx]) ? tribe.ranks[rankIdx].name : 'unranked';
  const pts = tribe.pointsName || 'points';
  const mine = tribes.getTides(tribe.key, member.id);
  const embed = new EmbedBuilder().setColor(tribe.color || HUB_COLOR).setTitle(`${tribe.emoji || '🏴'} ${tribe.name}`)
    .setDescription(tribe.motto ? `_${tribe.motto}_` : '_no motto yet_')
    .addFields(
      { name: 'Your rank', value: rankName, inline: true },
      { name: `Your ${pts}`, value: String(mine), inline: true },
      { name: 'Members', value: String(memberCount), inline: true },
      { name: '👑 Glory (this week)', value: String(tribe.glory || 0), inline: true },
      { name: '🪙 Treasury', value: String(tribe.treasury || 0), inline: true });
  return { embeds: [embed] };
}

function infoView() {
  const rlines = rules.RULES.map((r, i) => `**${i + 1}.** ${r.title}`);
  const embed = new EmbedBuilder().setColor(HUB_COLOR).setTitle('📖 Server Info').setDescription([
    '**Getting in:** new members verify within 7 days. A bot thread walks you through it.',
    '**Discipline:** minor slips get a Corner, a timed cool-off. Real or repeated issues are Strikes, which stack toward a ban.',
    '**Media:** GIFs and images unlock as you level up by chatting (Arcane levels).',
    '',
    '**The rules:**',
    rlines.join('\n'),
  ].join('\n'));
  return { embeds: [embed] };
}

module.exports = { hubPanel, hubButtons, statusView, tribeView, infoView, confessModal, suggestModal, modmailModal, reportModal, whistleblowPicker, whistleblowModal };
