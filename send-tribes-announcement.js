// One-shot: posts the tribes announcement to #announcements as 3 separate messages (a standalone @everyone
// ping, then the two content halves), 0.5s apart. Scheduled via a systemd one-shot timer for 2026-08-03 09:00
// America/New_York. Delete this file + the timer after it fires — it is not meant to be reusable.
// If any message in the sequence fails partway through, the ones that DID send this attempt are deleted
// (so the channel never ends up with a broken half-announcement) and the whole sequence retries from the top.
const { Client, GatewayIntentBits } = require('discord.js');
const config = require('./config');

const ANNOUNCE_CHANNEL_ID = '1502947340389060658'; // #announcements
const DELAY_MS = 500;
const MAX_ATTEMPTS = 3;

const PING = '@everyone';

const MSG1 = `# 🏴 Introducing Tribes

The server has a full **tribe system**: member factions, each with its own private territory, roles, ranks, and economy. Pledge your allegiance, rise through the ranks, and represent your people.

## What a tribe is
Every tribe has its own hoisted role and color, a private land only its members can see (a throne for announcements, a hall for chatting, a voice channel), an internal rank ladder, and a leader who runs it (each tribe names its own title for this, Warden, Warlord, whatever fits).

## How to join
Open the #roles channel and pick a tribe from the **Tribes** section.
- Your **first tribe is a free choice**. Click it and you're in.
- After that, you **can't leave or switch on your own**. Your tribe's leader has to release you first, and any new tribe has to accept you, by request, invite, or a fellow member's **nomination** (\`/tribe nominate @user\`, they approve, then the nominee decides for themselves).

Your first pledge is the only one you make freely, so choose it well.

## Rising through the ranks
Being active in your tribe's hall moves you up its rank ladder automatically, ranks only ever go up, never down. Check where you stand with \`/tribe leaderboard\`.`;

const MSG2 = `## Treasury, Glory, and the Weekly Crown
Your activity also earns your tribe **Glory**, this week's live standing. Every Sunday, whichever tribe has the most Glory takes the **👑 Weekly Crown** and everyone in it wears the badge for the week. Glory resets each week, but **Treasury** doesn't: it's your tribe's permanent bank, built from crown wins, staff-set weekly challenges, and members giving up their own points with \`/tribe offer\`.

## The Shop
\`/tribe expand\` spends the tribe's treasury on real upgrades once you hit a members-or-crowns milestone: extra channels, external sounds, faster point-earning, and more.

## Musters and Challenges
Your tribe's leader can call a **muster**, a roll-call in the hall. Answer it and your tribe banks treasury and glory for every member who shows up. Staff will also post **weekly challenges** for every tribe to take a shot at.

## Handy commands
\`/tribe info\` for your tribe's overview, \`/tribe roster\` for the member list, \`/tribe list\` for every tribe and the standings, \`/tribe leaderboard\` for the top members.

> Tribes are founded by **admins**, or by a **mod backed by two other mods**. Have an idea for a tribe? Bring it to an admin. Are you a mod who wants to lead one? Rally two other mods to back you.

Tribes open right now: 🌊 **The Cobalt Vigil of the Drowning Night**, ⚔️ **Valith**, and 🦀 **Kayena's Cute Crabs**. Find your people.`;

const SEQUENCE = [
  { content: PING, allowedMentions: { parse: ['everyone'] } },
  { content: MSG1, allowedMentions: { parse: [] } },
  { content: MSG2, allowedMentions: { parse: [] } },
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
