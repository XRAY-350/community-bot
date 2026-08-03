// memberCache.js — guild.members.fetch() (a bulk request over the gateway, opcode 8) has a strict, easily
// exhausted rate limit. ~20 places across the bot called it independently — nearly every interaction handler
// that needed fresh role-membership data ("role.members only reflects the cache"), plus every background
// sweep (several on a 15min/hourly cadence) — all hammering the same gateway channel. That's why
// "[sweep] members.fetch failed: rate limited" was showing up on nearly every 15-minute tick (174 times in
// 3 days): the calls were saturating each other. A slow/rate-limited fetch sitting inside an interaction
// handler BEFORE that interaction was acknowledged (which has only 3s to ack) is what caused "the bot keeps
// thinking forever" reports, spanning totally unrelated commands (tribe motto, corner, strikes) — the
// contention was shared, not any one command's bug.
//
// Fix: one shared, cooldown-guarded fetch. A real gateway request happens at most once per COOLDOWN_MS;
// every other call in that window reuses guild.members.cache, which discord.js already keeps live via
// guildMemberAdd/Update/Remove events once populated. Concurrent callers during an in-flight fetch share
// the same promise instead of each starting their own.
const COOLDOWN_MS = 60_000;
let lastFetch = 0;
let inFlight = null;

async function ensureMembers(guild) {
  if (Date.now() - lastFetch < COOLDOWN_MS) return guild.members.cache;
  if (!inFlight) {
    inFlight = guild.members.fetch()
      .then(() => { lastFetch = Date.now(); })
      .catch(e => console.error('[memberCache] fetch failed:', e.message))
      .finally(() => { inFlight = null; });
  }
  await inFlight;
  return guild.members.cache;
}

module.exports = { ensureMembers };
