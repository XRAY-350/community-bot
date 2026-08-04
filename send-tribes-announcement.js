// One-shot: posts the tribes announcement to #announcements as N separate messages (a standalone @everyone
// ping, then the content parts), 0.5s apart. REWRITTEN FROM SCRATCH 2026-08-03 — this is genuinely the FIRST
// thing members will ever see about tribes (no prior announcement fired), so there is no "new feature"/
// "now has"/"by popular demand" framing anywhere in here — it just describes the whole system, once, as it
// exists today. Re-schedule via a fresh systemd one-shot timer when a send time is picked; delete this file +
// the timer after it fires — it is not meant to be reusable.
// If any message in the sequence fails partway through, the ones that DID send this attempt are deleted
// (so the channel never ends up with a broken half-announcement) and the whole sequence retries from the top.
const { Client, GatewayIntentBits } = require('discord.js');
const config = require('./config');
const tribes = require('./tribes');

const ANNOUNCE_CHANNEL_ID = '1502947340389060658'; // #announcements
const DELAY_MS = 500;
const MAX_ATTEMPTS = 3;

const PING = '@everyone';

// Real channel mentions (<#id>), not plain "#name" text — plain text never renders as a clickable link.
const ROLES_CH = `<#${config.rolesChannelId}>`;
const HUB_CH = `<#${tribes.getHubInfo().channelId}>`;

const MSG1 = `# 🏴 Tribes

The server runs on **tribes**: member factions, each with its own private land (a throne, a hall, a voice channel), its own colour, an internal rank ladder, and an economy. Pick a side, climb the ranks, represent your people.

**To join:** open ${ROLES_CH} and pick a tribe from the **Tribes** section. Your **first tribe is a free choice**, just click and you're in.

Everything else, standings, rosters, the shop, wars, alliances, and your own tribe's tools, lives in ${HUB_CH}. Start there.

Tribes open right now: 🌊 **The Cobalt Vigil of the Drowning Night** · ⚔️ **Valith** · 🦀 **Kayena's Cute Crabs** · 🪇 **Whyamiissuperiortribe** · 🐻 **Crimson Cave**. Find your people.`;

const SEQUENCE = [
  { content: PING, allowedMentions: { parse: ['everyone'] } },
  { content: MSG1, allowedMentions: { parse: [] } },
];

// One pass through the whole sequence. On any failure, deletes whatever THIS attempt already sent (so a
// retry never leaves duplicates alongside the broken remainder) and reports failure to the caller.
async function attemptSend(ch) {
  const sentIds = [];
  try {
    for (let i = 0; i < SEQUENCE.length; i++) {
      const msg = await ch.send(SEQUENCE[i]);
      sentIds.push(msg.id);
      if (i < SEQUENCE.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
    }
    return { ok: true };
  } catch (e) {
    for (const id of sentIds) await ch.messages.delete(id).catch(() => {});
    return { ok: false, error: e };
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const ch = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
    let result = { ok: false };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !result.ok; attempt++) {
      result = await attemptSend(ch);
      if (!result.ok) {
        console.error(`[tribes-announce] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${result.error.message}`);
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 3000));
      }
    }
    console.log(result.ok ? 'Tribes announcement sent.' : `FAILED after ${MAX_ATTEMPTS} attempts.`);
  } catch (e) {
    console.error('FAILED to send announcement', e);
  } finally {
    client.destroy();
    process.exit(0);
  }
});
client.login(config.token);
