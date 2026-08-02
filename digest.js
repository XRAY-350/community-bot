// digest.js - a once-a-day embed recap of every job the bot ran in the last 24h, posted to the
// mod-conflict channel. Conflict resolution is tracked across sweeps (received / resolved / remaining).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Mod-control buttons on the daily digest, so any mod (not just the owner) can drive the bot.
function buildDigestButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('digest_sweep').setEmoji('🧹').setLabel('Run sweep now').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('digest_cornered').setEmoji('🚫').setLabel('Cornered').setStyle(ButtonStyle.Secondary),
  )];
}
const config = require('./config');

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// On the very first run, seed the conflict baseline and mark today as already-digested, so we don't
// count all pre-existing conflicts as "new today" nor post an immediate near-empty digest. Returns
// true if it just baselined (caller should skip the received/resolved diff this sweep).
function baselineIfFirstRun(state, currentConflictIds) {
  if (state.getMeta('lastDigestDate') != null) return false;
  state.setMeta('knownConflicts', currentConflictIds);
  state.setMeta('lastDigestDate', localDateStr(new Date()));
  return true;
}

// Post once per calendar day, at/after the configured hour (server local time).
function shouldPost(state) {
  if (!config.digestEnabled) return false;
  const now = new Date();
  if (now.getHours() < config.digestHour) return false;
  return state.getMeta('lastDigestDate') !== localDateStr(now);
}

// The digest is a recap of the bot's JOBS only. Role conflicts are handled separately (the weekly
// react-to-resolve message), so they are intentionally NOT included here.
function buildEmbed(daily) {
  const since = new Date(daily.since || Date.now());
  // Title lives in the message CONTENT header (see maybePost) so it renders big; embed keeps the
  // color + structured fields.
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription(`Recap of the last 24h (since ${since.toLocaleString()}).`)
    .addFields(
      { name: '🧹 Verified threads deleted', value: `${daily.delVerified}`, inline: true },
      { name: '👋 Left-member threads deleted', value: `${daily.delLeft}`, inline: true },
      { name: '🗑️ Unverified-chat purged', value: `${daily.purged}`, inline: true },
      { name: '🏷️ Unverified role assigned', value: `${daily.unverifiedAssigned || 0}`, inline: true },
      { name: '⏰ Members warned', value: `${daily.warned}`, inline: true },
      { name: '🚪 Members kicked', value: `${daily.kicked}`, inline: true },
      { name: '📣 Mod nudges', value: `${daily.nudged}`, inline: true },
    )
    .setTimestamp(new Date());
}

// Post the digest if it's due. Resets the daily counters and records the date on success.
async function maybePost(state, channel) {
  if (!shouldPost(state)) return false;
  if (!channel) { console.error('[digest] no channel configured to post the digest'); return false; }
  const daily = state.daily();
  try {
    await channel.send({ content: '## 📋 FUBU Verify - Daily Digest', embeds: [buildEmbed(daily)], components: buildDigestButtons() });
    console.log(`[digest] posted (kicked=${daily.kicked} delVerified=${daily.delVerified} delLeft=${daily.delLeft} purged=${daily.purged} warned=${daily.warned} conflictsResolved=${daily.conflictsResolved})`);
    state.resetDaily();
    state.setMeta('lastDigestDate', localDateStr(new Date()));
    return true;
  } catch (err) {
    console.error(`[digest] post failed: ${err.message}`);
    return false;
  }
}

module.exports = { maybePost, buildEmbed, shouldPost, baselineIfFirstRun };
