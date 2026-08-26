// pingrelay.js — DM the bot owner whenever a watched role (Mod / Admin / any tribe Leader) is @-pinged in a
// message, so they still see the summons even while they don't hold that role. Owner deliberately drops
// their staff/leader roles (this session), which means they'd otherwise never see an @mod/@admin/@leader
// ping. This relays it as a DM with a jump link, but ONLY for roles the owner doesn't currently hold (if
// they DO hold it, Discord already pinged them natively, so no relay).
const config = require('./config');
const opspanel = require('./opspanel');
const tribes = require('./tribes');

// Light per-(role, channel) cooldown so a rapid re-ping in the same place doesn't flood the DM. Distinct
// channels, and distinct roles, still notify. In-memory (resets on restart) is fine for spam-dedup.
const COOLDOWN_MS = 60 * 1000;
const _last = new Map();   // `${roleId}:${channelId}` -> ts
setInterval(() => { const now = Date.now(); for (const [k, ts] of _last) if (now - ts > 3600000) _last.delete(k); }, 3600000).unref();   // audit N14: bounded

// The roles worth relaying: Mod, Admin, and every tribe's Leader role.
function watchedRoles() {
  const ids = new Set();
  if (config.modRoleId) ids.add(config.modRoleId);
  if (config.adminRoleId) ids.add(config.adminRoleId);
  for (const t of tribes.all()) if (t.leaderRoleId) ids.add(t.leaderRoleId);
  return ids;
}

async function handleMessage(message) {
  try {
    if (!message.guild || message.author?.bot || message.system) return;
    const recipientId = opspanel.BOT_OWNER_ID;
    if (!recipientId || message.author.id === recipientId) return;   // never relay the owner's own pings
    const mentioned = message.mentions?.roles;
    if (!mentioned || !mentioned.size) return;
    const watched = watchedRoles();
    const hits = [...mentioned.values()].filter(r => watched.has(r.id));
    if (!hits.length) return;

    // Only relay roles the owner does NOT currently hold (otherwise Discord already pinged them).
    const owner = await message.guild.members.fetch(recipientId).catch(() => null);
    if (!owner) return;   // owner isn't in this guild (e.g. the Melanin deployment) — nothing to relay
    const now = Date.now();
    const relay = hits.filter(r => {
      if (owner.roles.cache.has(r.id)) return false;
      const key = `${r.id}:${message.channelId}`;
      if (now - (_last.get(key) || 0) < COOLDOWN_MS) return false;
      _last.set(key, now);
      return true;
    });
    if (!relay.length) return;

    const user = await message.client.users.fetch(recipientId).catch(() => null);
    if (!user) return;
    const roleList = relay.map(r => `**${r.name}**`).join(', ');
    const snippet = (message.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    await user.send(
      `🔔 ${roleList} was pinged in <#${message.channelId}> by **${message.author.tag}**:\n` +
      (snippet ? `> ${snippet}\n` : '') +
      message.url
    ).catch(() => { /* owner may have DMs closed */ });
  } catch (e) { console.error('[pingrelay]', e.message); }
}

module.exports = { handleMessage, watchedRoles };
