// pubdash.js - the public member hub. A pinned panel and the /dashboard command open the same hub:
// a personal status view, server info, and a feature guide. All member-facing, hybrid embed+markdown.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const tribes = require('./tribes');
const strikes = require('./strikes');
const rules = require('./rules');

const HUB_COLOR = 0x5865F2;
// Arcane level roles, high to low, with the media each tier unlocks.
const LEVELS = [
  ['NOLIFE', '1529121471946035330'],
  ['Elite Chatter', '1529121191384842330'],
  ['Intermediate Chatter', '1529121181767176313'],
  ['Novice Chatter', '1529120692845674687'],
];

function hubButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pubdash_status').setEmoji('👤').setLabel('My Status').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pubdash_info').setEmoji('📖').setLabel('Server Info').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pubdash_features').setEmoji('🧩').setLabel('Features').setStyle(ButtonStyle.Secondary));
}

// The main hub message (used by /dashboard and the pinned panel).
function hubPanel() {
  const embed = new EmbedBuilder().setColor(HUB_COLOR).setTitle('🤖 Member Hub')
    .setDescription([
      'Everything the bot does for you, in one place. Tap a button.',
      '',
      '> 👤 **My Status** for your tribe, rank, level, and standing',
      '> 📖 **Server Info** for the rules and how things work here',
      '> 🧩 **Features** for every member tool and its command',
    ].join('\n'));
  return { embeds: [embed], components: [hubButtons()] };
}

// Personal snapshot for the clicking member. state = the strike/meta store.
function statusView(member, state) {
  const level = LEVELS.find(([, id]) => member.roles.cache.has(id));
  const tribe = tribes.myTribe(member);
  const rankIdx = tribe ? tribes.currentRankIndex(member, tribe) : -1;
  const rankName = (tribe && rankIdx >= 0 && tribe.ranks && tribe.ranks[rankIdx]) ? tribe.ranks[rankIdx].name : null;
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

function featuresView() {
  const embed = new EmbedBuilder().setColor(HUB_COLOR).setTitle('🧩 Member Features').setDescription([
    '**🎓 Roles:** pick yours in the #roles channel',
    '**🏴 Tribes:** `/tribe info`, `/tribe roster`, `/tribe list`, `/tribe leaderboard`',
    '**💭 Confessions:** `/confess` to post anonymously',
    '**🚩 Reports:** right-click a message, then Apps, then Report',
    '**✉️ Modmail:** `/modmail` to message staff privately',
    '**💡 Suggestions:** `/suggest` to propose an idea',
    '**➕ Request a role:** `/request-role` for a casual role',
    '**⚖️ Appeals:** `/appeal ban` for a friend, `/appeal strike` for your own strike',
    '**🎨 Contest:** `/contest-submit` to enter the monthly contest',
    '**❓ Help:** `/help` for the full list',
  ].join('\n'));
  return { embeds: [embed] };
}

module.exports = { hubPanel, hubButtons, statusView, infoView, featuresView };
