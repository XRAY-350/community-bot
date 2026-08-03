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

The server has a full **tribe system**: member factions, each with its own private territory, roles, ranks, and economy. Pledge your allegiance, rise through the ranks, and represent your people.

## What a tribe is
Every tribe has its own hoisted role and color, a private land only its members can see (a throne for announcements, a hall for chatting, a voice channel), an internal rank ladder, and a leader who runs it (each tribe names its own title, Warden, Warlord, whatever fits).

## How to join
Open ${ROLES_CH} and pick a tribe from the **Tribes** section.
- Your **first tribe is a free choice**. Click it and you're in.
- After that, you can't switch on your own. Your leader has to release you (or, for staff, an instant **Leave** button, no approval needed), and a new tribe has to accept you: by nomination, an invite, or your own **Join Request** if you've pledged before.

## Rising through the ranks
Being active in your tribe's hall moves you up its rank ladder automatically, ranks only ever go up, never down.`;

const MSG2 = `## The Tribes Hub
${HUB_CH} is your one-stop panel: **Standings** for every tribe's Glory and treasury, **All Rosters** and **All Leaderboards** across every tribe, plus **Shop**, **Join Request**, and **Leave** for your own. All buttons, nothing to type.

## Every tribe's Throne
Each tribe's throne channel has its own control panel pinned at the top. Members get Roster / Leaderboard / Shop / Leave buttons scoped to that tribe. Leaders (or staff) get the full toolkit too: Invite, Banish, Note, Set Rank, Retheme, Announce, Motto, Muster, Declare War, and Alliances, click a button instead of typing a command.

## Treasury, Glory, and the Weekly Crown
Your activity earns your tribe **Glory**, this week's live standing. Every Sunday at 00:00 UTC, whichever tribe has the most Glory takes the **👑 Weekly Crown**, and everyone in it wears the badge for the week. Glory resets each week, but **Treasury** doesn't: it's your tribe's permanent bank.`;

const MSG3 = `## The Shop
Once your tribe hits a members-or-crowns milestone, its leader can spend the treasury on real upgrades: extra channels, external sounds, faster point-earning, and more.

## Musters
Your tribe's leader can call a **muster**, a roll-call in the hall. Answer it and your tribe banks treasury and glory for every member who shows up.

## War & Alliances
A leader can **Declare War** on another tribe. Your OWN members vote first, the target gets no say in whether it starts. It resolves by a strength simulation, not a guaranteed win, and the loser gets raided for treasury and can lose a few members for a while. **Alliances** defend each other in wars and can gift treasury to each other.

> Tribes are founded by **admins**, or by a **mod backed by two other mods**. Have an idea for a tribe? Bring it to an admin. Are you a mod who wants to lead one? Rally two other mods to back you.

Tribes open right now: 🌊 **The Cobalt Vigil of the Drowning Night**, ⚔️ **Valith**, 🦀 **Kayena's Cute Crabs**, 🪇 **Whyamiissuperiortribe**, and **CC, Crimson, Cave**. Find your people.`;

const SEQUENCE = [
  { content: PING, allowedMentions: { parse: ['everyone'] } },
  { content: MSG1, allowedMentions: { parse: [] } },
  { content: MSG2, allowedMentions: { parse: [] } },
  { content: MSG3, allowedMentions: { parse: [] } },
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
