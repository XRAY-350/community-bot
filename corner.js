// corner.js — "the corner" jail for the naughty girls 🚫. Cornering a member strips all of her
// non-identifying, non-managed roles (storing them), gives the 🚫 Corner role (which can only see
// the-corner + corner-log + the welcome/info category, view-only), and optionally auto-releases
// after a duration. Releasing removes the corner role and restores the stored roles.
// Ported from the FUBU verify bot; config-driven, adapted to bubble girl's config fields.

const { PermissionsBitField } = require('discord.js');
const config = require('./config');

function overwriteMatches(channel, id, desired) {
  const ow = channel.permissionOverwrites.cache.get(id);
  const allow = ow ? ow.allow : new PermissionsBitField(0n);
  const deny = ow ? ow.deny : new PermissionsBitField(0n);
  for (const [perm, val] of Object.entries(desired)) {
    const flag = PermissionsBitField.Flags[perm];
    if (val === true && !allow.has(flag)) return false;
    if (val === false && !deny.has(flag)) return false;
  }
  return true;
}

// Self-heal the corner permissions on boot (re-runnable): the corner role sees ONLY the-corner +
// corner-log + the welcome/info category (view-only); every other channel is hidden. In the-corner,
// non-cornered @everyone can view+react but NOT send; the corner role + mods can text. Drift-
// correcting — only edits overwrites that don't already match (fast when nothing changed).
async function ensureCornerPerms(guild) {
  if (!config.cornerRoleId) return 0;
  const everyone = guild.roles.everyone.id;
  let fixed = 0;
  const chans = [...(await guild.channels.fetch()).values()].filter(Boolean);
  for (const ch of chans) {
    try {
      if (ch.id === config.cornerChannelId) {
        const everyoneDesired = {
          ViewChannel: true, ReadMessageHistory: true, AddReactions: true,
          SendMessages: false, SendMessagesInThreads: false,
          CreatePublicThreads: false, CreatePrivateThreads: false,
        };
        if (!overwriteMatches(ch, everyone, everyoneDesired)) { await ch.permissionOverwrites.edit(everyone, everyoneDesired, { reason: 'corner self-heal' }); fixed++; }
        const cornerDesired = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AddReactions: true };
        if (!overwriteMatches(ch, config.cornerRoleId, cornerDesired)) { await ch.permissionOverwrites.edit(config.cornerRoleId, cornerDesired, { reason: 'corner self-heal' }); fixed++; }
        for (const mod of config.verifierRoleIds) {
          if (!overwriteMatches(ch, mod, { ViewChannel: true, SendMessages: true })) { await ch.permissionOverwrites.edit(mod, { ViewChannel: true, SendMessages: true }, { reason: 'corner self-heal' }); fixed++; }
        }
        continue;
      }
      if (ch.id === config.cornerVcId) {
        const eDesired = { ViewChannel: true, Connect: false };
        if (!overwriteMatches(ch, everyone, eDesired)) { await ch.permissionOverwrites.edit(everyone, eDesired, { reason: 'corner self-heal' }); fixed++; }
        const rDesired = { ViewChannel: true, Connect: true, Speak: true, SendMessages: true, ReadMessageHistory: true, AddReactions: true, EmbedLinks: true, Stream: false, UseSoundboard: false, UseExternalSounds: false };
        if (!overwriteMatches(ch, config.cornerRoleId, rDesired)) { await ch.permissionOverwrites.edit(config.cornerRoleId, rDesired, { reason: 'corner self-heal' }); fixed++; }
        for (const mod of config.verifierRoleIds) {
          const mDesired = { ViewChannel: true, Connect: true, Speak: true, MuteMembers: true, MoveMembers: true, DeafenMembers: true };
          if (!overwriteMatches(ch, mod, mDesired)) { await ch.permissionOverwrites.edit(mod, mDesired, { reason: 'corner self-heal' }); fixed++; }
        }
        continue;
      }
      // Cornered get view-only on: the welcome/info category (rules etc.) AND the corner-log channel.
      // Everything else hidden. (corner-log lives in that category anyway, but keep it explicit.)
      const viewOnly = ch.id === config.cornerViewCategoryId || ch.parentId === config.cornerViewCategoryId
        || ch.id === config.cornerLogChannelId;
      const desired = viewOnly
        ? { ViewChannel: true, ReadMessageHistory: true, AddReactions: true, SendMessages: false }
        : { ViewChannel: false };
      if (!overwriteMatches(ch, config.cornerRoleId, desired)) { await ch.permissionOverwrites.edit(config.cornerRoleId, desired, { reason: 'corner self-heal' }); fixed++; }
    } catch (err) {
      console.error(`[corner] perm self-heal on #${ch.name}: ${err.message}`);
    }
  }
  return fixed;
}

// Parse "30m" / "2h" / "3d" → ms, or null.
function parseDuration(str) {
  const m = String(str || '').trim().match(/^(\d+)\s*([mhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  const mult = m[2].toLowerCase() === 'm' ? 60000 : m[2].toLowerCase() === 'h' ? 3600000 : 86400000;
  return n * mult;
}

// Roles stripped on corner = everything except @everyone, managed/bot roles, identifying roles,
// the Unverified role (preserve verification state), and the corner role itself.
function rolesToStrip(guild, member) {
  const keep = new Set(config.identifyingRoleIds);
  if (config.unverifiedRoleId) keep.add(config.unverifiedRoleId);
  return [...member.roles.cache.values()]
    .filter(r => r.id !== guild.roles.everyone.id && !r.managed && r.id !== config.cornerRoleId && !keep.has(r.id))
    .map(r => r.id);
}

async function corner(guild, member, durationMs, state, byId) {
  const now = Date.now();
  const existing = state.getCornered(member.id);
  if (existing) {
    state.setCornered(member.id, { ...existing, releaseAt: durationMs ? now + durationMs : null, by: byId });
    return { ok: true, updated: true, stripped: (existing.roles || []).length };
  }
  const strip = rolesToStrip(guild, member);
  state.setCornered(member.id, { roles: strip, releaseAt: durationMs ? now + durationMs : null, by: byId, at: now });
  try {
    if (strip.length) await member.roles.remove(strip, 'Sent to the corner');
    await member.roles.add(config.cornerRoleId, 'Sent to the corner');
  } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, stripped: strip.length };
}

async function uncorner(guild, userId, state, reason = 'Released from the corner') {
  const rec = state.getCornered(userId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) { state.clearCornered(userId); return { ok: true, left: true }; }
  try {
    await member.roles.remove(config.cornerRoleId, reason).catch(() => {});
    if (rec && Array.isArray(rec.roles) && rec.roles.length) {
      const valid = rec.roles.filter(id => guild.roles.cache.has(id));
      if (valid.length) await member.roles.add(valid, reason);
    }
  } catch (err) { return { ok: false, error: err.message }; }
  state.clearCornered(userId);
  return { ok: true, restored: rec && rec.roles ? rec.roles.length : 0 };
}

async function releaseExpired(guild, state) {
  const now = Date.now();
  const released = [];
  for (const [uid, rec] of Object.entries(state.listCornered())) {
    if (rec.releaseAt && rec.releaseAt <= now) {
      const r = await uncorner(guild, uid, state, 'Corner duration expired');
      if (r.ok) released.push(uid);
    }
  }
  return released;
}

module.exports = { parseDuration, rolesToStrip, corner, uncorner, releaseExpired, ensureCornerPerms };
