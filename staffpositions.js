// staffpositions.js — the application-gated staff-floor positions built on the staffapps.js factory
// (owner, 2026-08-22). Each is a small spec; the factory provides the whole application flow (forum,
// vote, accept/deny/undo, role grant, coordination channel). All are memberTier 'staff' with NO
// cornering (see index.js — deliberately excluded from every corner helper).
//   • Content Creator (LIVE): submit clips/art/memes via /create submit → staff approve → posts to #showcase.
//   • Greeter (dark): welcomes + helps onboard newcomers.
//   • Support Helper (dark): answers questions in a help space.
const { makeStaffApp, placeSensibly } = require('./staffapps');
const { ChannelType, PermissionsBitField, TextInputStyle } = require('discord.js');
const config = require('./config');
const P = PermissionsBitField.Flags;

// Content Creator ------------------------------------------------------------------------------------
// Media Team (owner, 2026-08-22: "i was thinking advertisers would be creators" → merged the Advertiser
// + Content Creator positions into one "media team adjacent" role that does BOTH: make content for the
// public #showcase (/create submit) AND stage promo clips for TikTok (/advertise submit).
const media = makeStaffApp({
  key: 'media', label: 'Media Team', emoji: '🎬', applyCmd: 'apply-media',
  roleId: () => config.mediaRoleId,
  questions: [
    { id: 'why', field: 'Why join the Media Team?', label: 'Why do you want to join the Media Team?', style: TextInputStyle.Paragraph, required: true, max: 700 },
    { id: 'handles', field: 'Socials / portfolio', label: 'Your socials or a link to your work', style: TextInputStyle.Short, required: false, max: 300, inline: true },
    { id: 'idea', field: 'An idea', label: 'A clip / post / meme you’d want to make', style: TextInputStyle.Paragraph, required: true, max: 700 },
  ],
  forumName: '🎬┆ᴍᴇᴅɪᴀ-ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴꜱ',
  appsName: '🎬┆ᴍᴇᴅɪᴀ-ᴀᴘᴘꜱ',
  coordName: '🎬┆ᴍᴇᴅɪᴀ-ᴄʜᴀᴛ',
  coordTopic: 'Media Team + staff coordination. Draft ideas, WIP clips, promos, and feedback live here.',
  acceptedMsg: roleGiven => `🎉 Your Media Team application was **accepted**!${roleGiven ? ' You’ve been given the **Media Team** role. 🎬' : ''} Submit showcase content with \`/create submit\` and promos with \`/advertise submit\`, and open \`/panel\` for your tools.`,
  // Public showcase channel: everyone sees + reacts, only the bot/staff post (approved content is posted by the bot).
  extraSetup: async (guild, appConfig, c) => {
    if (c.showcaseChannelId && await guild.channels.fetch(c.showcaseChannelId).catch(() => null)) return;
    // Public channel → gets the public category (owner: bot channels must have a category).
    const publicParent = (appConfig?.publicCategoryId && await guild.channels.fetch(appConfig.publicCategoryId).catch(() => null)) ? appConfig.publicCategoryId : null;
    const ch = await guild.channels.create({
      name: '🎬┆ꜱʜᴏᴡᴄᴀꜱᴇ', type: ChannelType.GuildText, parent: publicParent,
      topic: 'Community content by our Media Team — approved clips, art, and memes land here. React to show love 🩷',
      permissionOverwrites: [
        { id: guild.id, allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions], deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] },
      ],
      reason: 'Media Team showcase channel',
    });
    c.showcaseChannelId = ch.id;
    // Slot it near the creative/content channels (selfies, hobbies, art), not at the top of the category.
    await placeSensibly(guild, ch, ['ꜱᴇʟꜰɪᴇꜱ', 'ʜᴏʙʙɪᴇꜱ', 'ᴀʀᴛ', 'ᴍᴜꜱɪᴄ', 'ɢᴀᴍɪɴɢ']);
  },
});
function mediaShowcaseId() { return media.loadConfig().showcaseChannelId || null; }

// Greeter (dark) -------------------------------------------------------------------------------------
const greeter = makeStaffApp({
  key: 'greeter', label: 'Greeter', emoji: '👋', applyCmd: 'apply-greeter',
  roleId: () => config.greeterRoleId,
  questions: [
    { id: 'why', field: 'Why greet?', label: 'Why do you want to welcome members?', style: TextInputStyle.Paragraph, required: true, max: 700 },
    { id: 'avail', field: 'Availability', label: 'Availability / timezone', style: TextInputStyle.Short, required: true, max: 100, inline: true },
    { id: 'style', field: 'Your welcome', label: 'How would you welcome a new member?', style: TextInputStyle.Paragraph, required: true, max: 700 },
  ],
  forumName: '👋┆ɢʀᴇᴇᴛᴇʀ-ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴꜱ',
  appsName: '👋┆ɢʀᴇᴇᴛᴇʀ-ᴀᴘᴘꜱ',
  coordName: '👋┆ɢʀᴇᴇᴛᴇʀ-ᴄʜᴀᴛ',
  coordTopic: 'Greeter + staff coordination for welcoming and onboarding new members.',
});

// Support Helper (dark) ------------------------------------------------------------------------------
const support = makeStaffApp({
  key: 'support', label: 'Support Helper', emoji: '🛟', applyCmd: 'apply-support',
  roleId: () => config.supportRoleId,
  questions: [
    { id: 'why', field: 'Why help?', label: 'Why do you want to help members?', style: TextInputStyle.Paragraph, required: true, max: 700 },
    { id: 'expertise', field: 'What you can help with', label: 'What are you good at helping with?', style: TextInputStyle.Short, required: true, max: 200, inline: true },
    { id: 'avail', field: 'Availability', label: 'Availability / timezone', style: TextInputStyle.Short, required: true, max: 100, inline: true },
  ],
  forumName: '🛟┆ꜱᴜᴘᴘᴏʀᴛ-ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴꜱ',
  appsName: '🛟┆ꜱᴜᴘᴘᴏʀᴛ-ᴀᴘᴘꜱ',
  coordName: '🛟┆ꜱᴜᴘᴘᴏʀᴛ-ᴄʜᴀᴛ',
  coordTopic: 'Support Helper + staff coordination for the help space.',
});

// The set, and a per-position feature key. index.js iterates these for command registration + dispatch.
const POSITIONS = [
  { app: media, featureKey: 'mediaApps' },
  { app: greeter, featureKey: 'greeterApps' },
  { app: support, featureKey: 'supportApps' },
];

module.exports = { media, greeter, support, POSITIONS, mediaShowcaseId };
