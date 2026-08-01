// corner.js — "the corner" jail. Cornering a member strips all of their non-identifying,
// non-managed roles (storing them), gives the corner role (which can only see the corner +
// verify/rules channels), and optionally auto-releases after a duration. Releasing restores the
// stored roles and removes the corner role.

const { PermissionsBitField } = require('discord.js');
const config = require('./config');

// ---- precise per-corner release timers -----------------------------------------------------------
// A timed corner arms a setTimeout that releases the member at EXACTLY their time (down to the second),
// instead of relying on the periodic poller — which now only survives as a restart backstop. index.js
// registers the real release+announce via setReleaseHandler; corner.js just fires it on schedule.
const _timers = new Map();            // userId -> Timeout handle
let _releaseHandler = null;           // async (guild, userId) => { uncorner + announce } (set by index.js)
const MAX_TIMER_MS = 2 ** 31 - 1;     // setTimeout ceiling (~24.8d); longer corners lean on the poller
function setReleaseHandler(fn) { _releaseHandler = fn; }
function clearTimer(userId) { const t = _timers.get(userId); if (t) { clearTimeout(t); _timers.delete(userId); } }
function armTimer(guild, userId, releaseAt) {
  clearTimer(userId);
  if (!releaseAt) return;                                   // indefinite → no timer
  const delay = releaseAt - Date.now();
  if (delay > MAX_TIMER_MS) return;                         // too far out for setTimeout; poller/rearm handles it
  const t = setTimeout(() => {
    _timers.delete(userId);
    if (_releaseHandler) Promise.resolve(_releaseHandler(guild, userId)).catch(e => console.error('[corner] timed release:', e.message));
  }, Math.max(0, delay));
  _timers.set(userId, t);
}
// Re-arm every currently-cornered member's timer after a restart (timers don't survive a process exit).
function rearmAll(guild, state) {
  let n = 0;
  for (const [uid, rec] of Object.entries(state.listCornered())) if (rec.releaseAt) { armTimer(guild, uid, rec.releaseAt); n++; }
  return n;
}

// Does the corner role's (or given id's) overwrite on a channel already match the desired allow/deny?
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

// Self-heal the corner permissions on boot (and can be re-run anytime): the corner role sees ONLY
// the corner channel + the verify/rules category (view-only); every other channel is hidden from
// it. In the corner channel, non-cornered members (@everyone) can ONLY see + react — they can view,
// read history, and add reactions, but NOT send messages or use threads; the corner role + mods can
// text. Drift-correcting: only edits overwrites that don't already match (fast when nothing changed).
async function ensureCornerPerms(guild) {
  const everyone = guild.roles.everyone.id;
  let fixed = 0;
  const chans = [...(await guild.channels.fetch()).values()].filter(Boolean);
  for (const ch of chans) {
    try {
      if (ch.id === config.cornerChannelId) {
        // Non-cornered members: see + react ONLY — view, read history, add reactions; no send, no threads.
        const everyoneDesired = {
          ViewChannel: true, ReadMessageHistory: true, AddReactions: true,
          SendMessages: false, SendMessagesInThreads: false,
          CreatePublicThreads: false, CreatePrivateThreads: false,
        };
        if (!overwriteMatches(ch, everyone, everyoneDesired)) {
          await ch.permissionOverwrites.edit(everyone, everyoneDesired, { reason: 'corner self-heal' }); fixed++;
        }
        const cornerDesired = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AddReactions: true };
        if (!overwriteMatches(ch, config.cornerRoleId, cornerDesired)) {
          await ch.permissionOverwrites.edit(config.cornerRoleId, cornerDesired, { reason: 'corner self-heal' }); fixed++;
        }
        if (config.modRoleId && !overwriteMatches(ch, config.modRoleId, { ViewChannel: true, SendMessages: true })) {
          await ch.permissionOverwrites.edit(config.modRoleId, { ViewChannel: true, SendMessages: true }, { reason: 'corner self-heal' }); fixed++;
        }
        continue;
      }
      if (ch.id === config.cornerVcId) {
        // Corner VC: @everyone can SEE but not join; cornered can join + talk (no screen-share/soundboard);
        // mods get full voice moderation. (This channel sits IN the view category, so it needs its own
        // case — the generic view-only rule below would grant View but not Connect.)
        const eDesired = { ViewChannel: true, Connect: false };
        if (!overwriteMatches(ch, everyone, eDesired)) { await ch.permissionOverwrites.edit(everyone, eDesired, { reason: 'corner self-heal' }); fixed++; }
        const rDesired = { ViewChannel: true, Connect: true, Speak: true, SendMessages: true, ReadMessageHistory: true, AddReactions: true, EmbedLinks: true, Stream: false, UseSoundboard: false, UseExternalSounds: false };
        if (!overwriteMatches(ch, config.cornerRoleId, rDesired)) { await ch.permissionOverwrites.edit(config.cornerRoleId, rDesired, { reason: 'corner self-heal' }); fixed++; }
        if (config.modRoleId) {
          const mDesired = { ViewChannel: true, Connect: true, Speak: true, MuteMembers: true, MoveMembers: true, DeafenMembers: true };
          if (!overwriteMatches(ch, config.modRoleId, mDesired)) { await ch.permissionOverwrites.edit(config.modRoleId, mDesired, { reason: 'corner self-heal' }); fixed++; }
        }
        continue;
      }
      // Cornered members get view-only on: the verify-and-rules category AND the corner-log channel
      // (so they can read the log of their own corner entries/exits/sentence changes). Everything else
      // stays hidden from them.
      const viewOnly = ch.id === config.cornerViewCategoryId || ch.parentId === config.cornerViewCategoryId
        || ch.id === config.cornerLogChannelId;
      // View-only channels (verify/rules + corner-log): let cornered SEE past messages (ReadMessageHistory
      // — the fix for "can't see the log", since the category denies history by default) and react, but
      // not send. Everything else stays hidden.
      const desired = viewOnly
        ? { ViewChannel: true, ReadMessageHistory: true, AddReactions: true, SendMessages: false }
        : { ViewChannel: false };
      if (!overwriteMatches(ch, config.cornerRoleId, desired)) {
        await ch.permissionOverwrites.edit(config.cornerRoleId, desired, { reason: 'corner self-heal' }); fixed++;
      }
    } catch (err) {
      console.error(`[corner] perm self-heal on #${ch.name}: ${err.message}`);
    }
  }
  return fixed;
}

// Parse a duration like "30m", "2h", "3d". Returns ms, or null if unparseable.
function parseDuration(str) {
  const m = String(str || '').trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  const unit = m[2].toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return n * mult;   // note: auto-release is checked on a timer (~20s), so sub-20s precision is approximate
}

// The roles that get stripped when cornering: everything the member has except @everyone,
// bot-managed roles (can't remove those), the identifying roles, and the corner role itself.
// The Unverified role is also kept — so cornering an unverified member preserves their verification
// state (they come out of the corner still unverified, not in limbo with neither role).
function rolesToStrip(guild, member) {
  const keep = new Set(config.identifyingRoleIds);
  if (config.unverifiedRoleId) keep.add(config.unverifiedRoleId);
  return [...member.roles.cache.values()]
    .filter(r => r.id !== guild.roles.everyone.id && !r.managed
      && r.id !== config.cornerRoleId && !keep.has(r.id))
    .map(r => r.id);
}

// Append a corner-history entry (survives release, unlike the ephemeral `cornered` active-status —
// that record is deleted on release, this one never is) and return how many times this member has now
// been cornered for the SAME rule (or just 1 if no rule was given). Used to alert staff when a repeat
// crosses a threshold — never auto-escalates to a Strike; a human always converts. Covers both halves
// of the escalation rule: repeating while still cornered (the "already cornered" branch below) and
// separate trips over time (a fresh corner after a prior release).
function logCornerHistory(state, memberId, ruleIndex) {
  const all = state.getMeta('cornerLog') || {};
  const list = all[memberId] || [];
  list.push({ ruleIndex: ruleIndex || null, at: Date.now() });
  all[memberId] = list;
  state.setMeta('cornerLog', all);
  if (!ruleIndex) return 1;
  return list.filter(e => e.ruleIndex === ruleIndex).length;
}

// Send a member to the corner. durationMs null = indefinite. ruleIndex (optional, from /corner's rule
// dropdown) drives the repeat-history count above. Returns {ok, ..., repeatCount}.
async function corner(guild, member, durationMs, state, byId, ruleIndex) {
  const now = Date.now();
  // Nobody can corner themselves — every entry point (slash /corner, "Send to corner", the dashboard
  // picker, the re-corner button) funnels through here, so one central guard closes them all. The tier
  // check upstream lets equal tiers act on each other (mod↔mod), which — with no self-check — also let a
  // mod corner their OWN account and self-strip their roles. Auto-corner (rule 9) passes the bot's id as
  // byId against a member target, so byId===member.id only ever means a genuine self-corner attempt.
  if (byId && byId === member.id) {
    return { ok: false, error: "you can't corner yourself." };
  }
  const existing = state.getCornered(member.id);
  if (existing) {
    // Already cornered — just update the release time (don't re-strip).
    state.setCornered(member.id, { ...existing, releaseAt: durationMs ? now + durationMs : null, by: byId });
    armTimer(guild, member.id, durationMs ? now + durationMs : null);   // re-arm on a re-corner / duration change
    const repeatCount = logCornerHistory(state, member.id, ruleIndex);
    return { ok: true, updated: true, stripped: (existing.roles || []).length, repeatCount };
  }
  // Guard: the bot can't touch roles positioned at/above its OWN highest role — trying would fail with a
  // raw "Missing Permissions". Only roles we'd actually STRIP matter here — a KEPT role above the bot
  // (e.g. OWNER⚜️, an identifying role) is fine, because we never touch it. So an owner can still be
  // cornered — their owner role stays (identifying) and everything else is stripped.
  const me = await guild.members.fetchMe();
  const stripIds = new Set(rolesToStrip(guild, member));
  const blockers = member.roles.cache.filter(r => stripIds.has(r.id) && r.position >= me.roles.highest.position);
  if (blockers.size) {
    return { ok: false, error: `she has a role I'd need to strip that sits above mine (${[...blockers.values()].map(r => r.name).join(', ')}), so I can't corner her. ask an admin to drag my role above hers in Server Settings → Roles.` };
  }
  // Discord rejects role edits on a TIMED-OUT member with a raw "Missing Permissions". Lift the timeout
  // just long enough to change roles, then RESTORE it (with its original expiry) so it still stands.
  let restoreTimeoutUntil = null;
  if (member.isCommunicationDisabled?.()) {
    restoreTimeoutUntil = member.communicationDisabledUntilTimestamp;
    await member.timeout(null, 'temporarily lifting timeout to edit roles').catch(e => console.error('[corner] clear timeout:', e.message));
  }
  const restoreTimeout = async () => {
    if (restoreTimeoutUntil && restoreTimeoutUntil > Date.now())
      await member.timeout(restoreTimeoutUntil - Date.now(), 'restoring timeout after corner').catch(e => console.error('[corner] restore timeout:', e.message));
  };
  const strip = rolesToStrip(guild, member);
  // Persist BEFORE mutating roles so a mid-way failure is still recoverable via /uncorner.
  state.setCornered(member.id, { roles: strip, releaseAt: durationMs ? now + durationMs : null, by: byId, at: now });
  try {
    if (strip.length) await member.roles.remove(strip, 'Sent to the corner');
    await member.roles.add(config.cornerRoleId, 'Sent to the corner');
  } catch (err) {
    await restoreTimeout();
    state.clearCornered(member.id); // don't leave a stale "cornered" record on a failed corner
    return { ok: false, error: err.message };
  }
  await restoreTimeout(); // put the Discord timeout back - cornering doesn't cancel it
  armTimer(guild, member.id, durationMs ? now + durationMs : null);   // precise auto-release at exactly the set time
  const repeatCount = logCornerHistory(state, member.id, ruleIndex);
  return { ok: true, stripped: strip.length, repeatCount };
}

// Release a member: remove the corner role and restore the roles we stripped.
async function uncorner(guild, userId, state, reason = 'Released from the corner') {
  const rec = state.getCornered(userId);
  const servedMs = rec && rec.at ? Date.now() - rec.at : null;   // how long they were in the corner
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) { clearTimer(userId); state.clearCornered(userId); return { ok: true, left: true, servedMs }; }
  // Same as corner: role edits fail on a timed-out member — lift the timeout, restore roles, put it back.
  let restoreTimeoutUntil = null;
  if (member.isCommunicationDisabled?.()) {
    restoreTimeoutUntil = member.communicationDisabledUntilTimestamp;
    await member.timeout(null, 'temporarily lifting timeout to restore roles').catch(() => {});
  }
  const restoreTimeout = async () => {
    if (restoreTimeoutUntil && restoreTimeoutUntil > Date.now())
      await member.timeout(restoreTimeoutUntil - Date.now(), 'restoring timeout after release').catch(() => {});
  };
  try {
    await member.roles.remove(config.cornerRoleId, reason).catch(() => {});
    if (rec && Array.isArray(rec.roles) && rec.roles.length) {
      const valid = rec.roles.filter(id => guild.roles.cache.has(id)); // skip roles deleted since
      if (valid.length) await member.roles.add(valid, reason);
    }
  } catch (err) {
    await restoreTimeout();
    return { ok: false, error: err.message };
  }
  await restoreTimeout(); // keep any active timeout after release
  clearTimer(userId);
  state.clearCornered(userId);
  return { ok: true, restored: rec && rec.roles ? rec.roles.length : 0, servedMs };
}

// Release everyone whose timed corner has expired. Returns the list of released user ids (so the
// caller can post a "time served" announcement for each).
async function releaseExpired(guild, state) {
  const now = Date.now();
  const released = [];
  for (const [uid, rec] of Object.entries(state.listCornered())) {
    if (rec.releaseAt && rec.releaseAt <= now) {
      const r = await uncorner(guild, uid, state, 'Corner duration expired');
      if (r.ok) released.push({ uid, servedMs: r.servedMs });
    }
  }
  return released;
}

module.exports = { parseDuration, rolesToStrip, corner, uncorner, releaseExpired, ensureCornerPerms,
  setReleaseHandler, armTimer, clearTimer, rearmAll };
