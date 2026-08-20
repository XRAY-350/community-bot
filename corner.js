// corner.js — "the corner" jail. Cornering a member strips all of their non-identifying,
// non-managed roles (storing them), gives the corner role (which can only see the corner +
// verify/rules channels), and optionally auto-releases after a duration. Releasing restores the
// stored roles and removes the corner role.

const { PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const hitsquad = require('./hitsquad');
const opspanel = require('./opspanel');
const overridesManager = require('./overridesManager');

// ---- severity tiering (owner, 2026-08-13) ---------------------------------------------------------
// /corner already refuses to corner someone of a HIGHER tier than the actor. This closes the mirror
// gap: /uncorner (and shortening/lowering an active corner) previously had NO such check — any mod or
// trial mod could undo a decision an admin or owner deliberately made. Canonical RANK lives here now;
// index.js and opspanel.js reference corner.RANK instead of each keeping their own copy.
const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };

function canBypassCornerTier(actorId, targetId, actorTier = null) {
  return overridesManager.canBypassTier(actorId, targetId, actorTier);
}
// Multi-person override: a group of SAME-TIER staff can force a release/lowering through even below the
// tier that applied it — 1 owner/botowner solo, 3 admins together, or 3 mods together, acting within a
// 5-minute window of each other. Trial mods (and anyone with no recognized tier) have NO override path —
// no number of them unlocks it; provisional, revisit once there's a sense of how often this comes up.
const OVERRIDE_THRESHOLD = { botowner: 1, owner: 1, admin: 3, mod: 3 };
const OVERRIDE_WINDOW_MS = 5 * 60 * 1000;
// Setting a defined release time sooner than this counts as a "lowering" (gated), not a neutral
// "defining" of an indefinite corner (ungated) — closes the obvious bypass (define it 10 seconds out to
// dodge the release gate entirely).
const LOWER_FLOOR_MS = 15 * 60 * 1000;

// Is a proposed new releaseAt a LOWERING of this corner's current severity? Indefinite (null) is treated
// as maximally severe, so any defined time counts as lowering UNLESS it clears the 15-minute floor; from
// an existing defined time, only a SOONER new time is a lowering (later, or back to indefinite, is not).
function isLowering(rec, newReleaseAt) {
  const cur = rec.releaseAt;
  if (cur == null) return newReleaseAt != null && (newReleaseAt - Date.now()) < LOWER_FLOOR_MS;
  if (newReleaseAt == null) return false;
  return newReleaseAt < cur;
}

// Can this actor act SOLO on a lowering/release, no override needed? Either they're the ORIGINAL
// corner-er (always gets a solo override on their own case, any tier), their current tier outranks — or
// matches — whatever tier last touched this corner's severity (rec.appliedByRank), OR they're an admin
// acting on an owner-applied corner specifically (owner, 2026-08-14: admins no longer need a 3-admin
// override vote to act on an owner's corner — botowner-applied corners are unaffected, still gated).
function canActSolo(rec, actorId, actorTier) {
  if (rec.joke) return true;   // joke corner — release/lowering gate is waived entirely, any tier can act solo
  if (rec.by === actorId) return true;
  if (actorTier === 'admin' && (rec.appliedByRank || 0) === RANK.owner) return true;
  return (RANK[actorTier] || 0) >= (rec.appliedByRank || 0);
}

// Record a lowering/release attempt and report whether enough same-tier staff have now tried within the
// window to force it through. Mutates rec.overrideVotes in place — caller persists via setCornered
// regardless of outcome, since a failed attempt still counts toward the threshold.
function registerOverrideVote(rec, actorId, actorTier) {
  const threshold = OVERRIDE_THRESHOLD[actorTier];
  if (!threshold) return { ok: false, have: 0, need: null };   // no override path at this tier
  const now = Date.now();
  rec.overrideVotes = (rec.overrideVotes || []).filter(v => now - v.at < OVERRIDE_WINDOW_MS);
  if (!rec.overrideVotes.some(v => v.id === actorId)) rec.overrideVotes.push({ id: actorId, tier: actorTier, at: now });
  const have = rec.overrideVotes.filter(v => v.tier === actorTier).length;
  return { ok: have >= threshold, have, need: threshold };
}

// The strongest tier that has ever touched this corner's severity is the bar for LOWERING it — never
// downgraded by a later, lower-tier person merely extending it further.
function bumpAppliedRank(rec, actorTier) {
  rec.appliedByRank = Math.max(rec.appliedByRank || 0, RANK[actorTier] || 0);
}

// Single entry point for both "reschedule this corner's release time" and "release them right now"
// (pass newReleaseAt: 'RELEASE' for the latter — full release is unconditionally the strongest possible
// lowering). Handles the gate + override bookkeeping AND persists state, so a caller whose gate passes
// just proceeds with the actual effect (arm a timer, or call uncorner() for a real release); a caller
// whose gate fails should report the vote tally and stop. A solo-authorized OR successfully-overridden
// lowering resets the record's protective tier to the acting tier (once overridden, the corner is now
// only as protected as that group's tier — not permanently locked to the original higher one).
function attemptSeverityChange(state, userId, actorId, actorTier, newReleaseAt) {
  const rec = state.getCornered(userId);
  if (!rec) return { ok: false, notFound: true };
  const lowering = newReleaseAt === 'RELEASE' ? true : isLowering(rec, newReleaseAt);
  const applyNewTime = () => { if (newReleaseAt !== 'RELEASE') rec.releaseAt = newReleaseAt; };
  if (!lowering) {
    bumpAppliedRank(rec, actorTier);
    applyNewTime();
    state.setCornered(userId, rec);
    return { ok: true, needsOverride: false };
  }
  if (canActSolo(rec, actorId, actorTier)) {
    rec.appliedByRank = RANK[actorTier] || 0;
    rec.overrideVotes = [];
    applyNewTime();
    state.setCornered(userId, rec);
    return { ok: true, needsOverride: false };
  }
  const vote = registerOverrideVote(rec, actorId, actorTier);
  if (vote.ok) { rec.appliedByRank = RANK[actorTier] || 0; rec.overrideVotes = []; applyNewTime(); }
  state.setCornered(userId, rec);   // persisted either way — a failed attempt still counts toward the threshold
  return { ok: vote.ok, needsOverride: true, have: vote.have, need: vote.need };
}

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
        // Trial mods can speak in the corner too (talk to / moderate cornered members).
        if (config.trialModRoleId && !overwriteMatches(ch, config.trialModRoleId, { ViewChannel: true, SendMessages: true })) {
          await ch.permissionOverwrites.edit(config.trialModRoleId, { ViewChannel: true, SendMessages: true }, { reason: 'corner self-heal' }); fixed++;
        }
        // The corner is PUBLIC — everyone (including verified members) can see it. Clear any VERIFIED
        // view-deny that would otherwise hide the corner from the general verified population.
        if (config.verifiedRoleId) {
          const vOw = ch.permissionOverwrites.cache.get(config.verifiedRoleId);
          if (vOw && vOw.deny.has(PermissionsBitField.Flags.ViewChannel)) {
            await ch.permissionOverwrites.edit(config.verifiedRoleId, { ViewChannel: null }, { reason: 'corner self-heal: corner is public' }); fixed++;
          }
        }
        continue;
      }
      if (config.adultCornerChannelId && ch.id === config.adultCornerChannelId) {
        // Adult Corner: @everyone denied view; 16-17 role explicitly denied; corner role + staff allowed
        const everyoneDesired = { ViewChannel: false };
        if (!overwriteMatches(ch, everyone, everyoneDesired)) {
          await ch.permissionOverwrites.edit(everyone, everyoneDesired, { reason: 'adult corner self-heal' }); fixed++;
        }
        const minorRoleId = '1516185172213628989';   // ✰ • 16-17 role
        const minorDesired = { ViewChannel: false, SendMessages: false, ReadMessageHistory: false };
        if (!overwriteMatches(ch, minorRoleId, minorDesired)) {
          await ch.permissionOverwrites.edit(minorRoleId, minorDesired, { reason: 'adult corner minor deny self-heal' }).catch(() => {}); fixed++;
        }
        const cornerDesired = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AddReactions: true };
        if (!overwriteMatches(ch, config.cornerRoleId, cornerDesired)) {
          await ch.permissionOverwrites.edit(config.cornerRoleId, cornerDesired, { reason: 'adult corner self-heal' }); fixed++;
        }
        if (config.modRoleId && !overwriteMatches(ch, config.modRoleId, { ViewChannel: true, SendMessages: true })) {
          await ch.permissionOverwrites.edit(config.modRoleId, { ViewChannel: true, SendMessages: true }, { reason: 'adult corner self-heal' }); fixed++;
        }
        if (config.trialModRoleId && !overwriteMatches(ch, config.trialModRoleId, { ViewChannel: true, SendMessages: true })) {
          await ch.permissionOverwrites.edit(config.trialModRoleId, { ViewChannel: true, SendMessages: true }, { reason: 'adult corner self-heal' }); fixed++;
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
        // Trial mods can join + speak in the corner VC (participate, not full voice-mod: no mute/move/deafen).
        if (config.trialModRoleId && !overwriteMatches(ch, config.trialModRoleId, { ViewChannel: true, Connect: true, Speak: true })) {
          await ch.permissionOverwrites.edit(config.trialModRoleId, { ViewChannel: true, Connect: true, Speak: true }, { reason: 'corner self-heal' }); fixed++;
        }
        continue;
      }
      if (ch.id === config.cornerLogChannelId) {
        // The corner-log is PUBLIC read-only: everyone can SEE it (view + history + react) but only
        // staff/the bot post. Cornered members keep the same view-only access.
        const readOnly = { ViewChannel: true, ReadMessageHistory: true, AddReactions: true, SendMessages: false };
        if (!overwriteMatches(ch, everyone, readOnly)) {
          await ch.permissionOverwrites.edit(everyone, readOnly, { reason: 'corner self-heal: log is public' }); fixed++;
        }
        if (config.verifiedRoleId) {
          const vOw = ch.permissionOverwrites.cache.get(config.verifiedRoleId);
          if (vOw && vOw.deny.has(PermissionsBitField.Flags.ViewChannel)) {
            await ch.permissionOverwrites.edit(config.verifiedRoleId, { ViewChannel: null }, { reason: 'corner self-heal: log is public' }); fixed++;
          }
        }
        if (!overwriteMatches(ch, config.cornerRoleId, readOnly)) {
          await ch.permissionOverwrites.edit(config.cornerRoleId, readOnly, { reason: 'corner self-heal' }); fixed++;
        }
        continue;
      }
      // Cornered members get view-only on the verify-and-rules category (so they can read the rules).
      // Everything else stays hidden from them.
      const viewOnly = ch.id === config.cornerViewCategoryId || ch.parentId === config.cornerViewCategoryId;
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
function logCornerHistory(state, memberId, ruleIndex, durationMs = null, at = Date.now()) {
  const all = state.getMeta('cornerLog') || {};
  const list = all[memberId] || [];
  list.push({ ruleIndex: ruleIndex || null, at, durationMs: durationMs || null, servedMs: null });
  all[memberId] = list;
  state.setMeta('cornerLog', all);
  if (!ruleIndex) return 1;
  return list.filter(e => e.ruleIndex === ruleIndex).length;
}

// Role-strip removes ViewChannel on every normal channel. For PUBLIC threads (including every forum
// post — forums can't contain private threads at all) that's already sufficient: access derives from
// the parent channel's visibility, not thread membership, so leaving membership alone is both harmless
// AND avoids Discord posting a permanent "removed from thread" system message into what might be a
// completely casual channel (Hobbies & Interests, LGBTQ, etc.) — owner, 2026-08-20: "i don't want them
// to be able to access it when cornered but removing them leaves a permanent message in the thread".
// PRIVATE threads are the real gap Discord grants an explicitly-added member access independent of
// parent-channel visibility — jail threads and mod-application applicant threads are the ones built
// that way. Only those need the explicit removal, and only staff/the applicant themselves would ever
// see that system message there, not a random member of a hobby forum.
async function stripThreadMemberships(guild, memberId, exceptThreadId) {
  try {
    const active = await guild.channels.fetchActiveThreads().catch(() => null);
    if (!active) return;
    for (const thread of active.threads.values()) {
      if (thread.id === exceptThreadId) continue;
      if (thread.type !== ChannelType.PrivateThread) continue;
      const tm = await thread.members.fetch(memberId).catch(() => null);
      if (tm) await thread.members.remove(memberId, 'Sent to the corner: thread membership stripped').catch(() => {});
    }
  } catch (e) { console.error('[corner] stripThreadMemberships:', e.message); }
}

// Find existing dedicated jail thread or create a new private thread for cornered member
async function getOrCreateCornerJailThread(guild, targetChannelId, member, slowmodeSec = null) {
  try {
    const parentChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (!parentChannel || !parentChannel.threads) return null;

    const threadName = `⛓️ Jail · ${member.user?.username || member.displayName || member.id}`;

    // Search active threads
    const activeThreads = await parentChannel.threads.fetchActive().catch(() => null);
    let thread = activeThreads?.threads?.find(t => t.name === threadName || t.name.includes(member.id));

    // Search archived threads if not in active
    if (!thread) {
      const archived = await parentChannel.threads.fetchArchived({ type: 'private', fetchAll: true }).catch(() => null);
      thread = archived?.threads?.find(t => t.name === threadName || t.name.includes(member.id));
    }

    if (thread) {
      if (thread.archived) await thread.setArchived(false).catch(() => {});
      if (thread.locked) await thread.setLocked(false).catch(() => {});
      await thread.members.add(member.id).catch(() => {});
      if (slowmodeSec != null) await thread.setRateLimitPerUser(slowmodeSec, `Corner slowmode set by staff`).catch(e => console.error('[corner] slowmode (reused thread):', e.message));
      return thread.id;
    }

    // Create new private thread (Type 12 PrivateThread)
    const newThread = await parentChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      type: 12, // ChannelType.PrivateThread
      rateLimitPerUser: slowmodeSec != null ? slowmodeSec : undefined,
      reason: `Corner jail thread for ${member.user?.tag || member.id}`
    });

    await newThread.members.add(member.id).catch(() => {});
    // A jail thread is often about a situation BETWEEN two members, and staff shouldn't have to leave it
    // to get the other person's side (owner, 2026-08-20: "add a sidebar as an addition to the thread
    // corner"). Same ➕ control the sidebar threads have — staff-gated in index.js, reuses sidebar's own
    // picker so there's one add-people flow, not two.
    await newThread.send({
      content: '-# Staff: pull someone else in here if this needs both sides.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cornerthread_add').setEmoji('➕').setLabel('Add someone').setStyle(ButtonStyle.Secondary))],
    }).catch(() => {});
    return newThread.id;
  } catch (err) {
    console.error('[corner] getOrCreateCornerJailThread error:', err.message);
    return null;
  }
}

// Send a member to the corner. durationMs null = indefinite. ruleIndex (optional, from /corner's rule
// dropdown) drives the repeat-history count above. Returns {ok, ..., repeatCount}.
async function corner(guild, member, durationMs = null, state, byId = null, ruleIndex = null, actorTier = null, opts = {}) {
  const { forceReal = false, adult = false, thread = false, anon = false, viaMemberCorner = false, slowmodeSec = null } = opts || {};
  const now = Date.now();
  // Fetch actor member if byId provided to evaluate role-based granted powers
  let actorMember = null;
  if (byId && guild) {
    actorMember = await guild.members.fetch(byId).catch(() => null);
  }
  // Defense in depth (found 2026-08-19): a GRANT_POWER override doesn't depend on role/tier at all, so it
  // must be checked against corner status directly here too, not just trusted from the caller's already-
  // gated actorTier — a path that bypasses the normal tier gate (e.g. an active hit-squad member calling
  // /corner) would otherwise still let a currently-cornered actor's grant apply.
  const actorCurrentlyCornered = byId && !!state.getCornered(byId);
  const grantedPower = !actorCurrentlyCornered && overridesManager.getGrantedPower(actorMember || byId, member, actorTier);
  if (grantedPower) actorTier = grantedPower;
  else if (actorCurrentlyCornered) actorTier = null;

  if (member.id === guild.ownerId && !(byId && canBypassCornerTier(actorMember || byId, member, actorTier))) {
    return { ok: false, error: "you can't corner the server owner." };
  }
  if (byId && byId === member.id) {
    // Self-cornering is blocked by default — without this guard, staff could dodge accountability by
    // "cornering themselves" for a token duration instead of taking a real action, or a joke-corner could
    // be self-inflicted to game the joke/real detection below. Only an explicit ALLOW_SELF_CORNER override
    // (or the standing personal exception in overridesManager) lifts it.
    const selfCornerAllowed = overridesManager.canSelfCorner(member);
    if (!selfCornerAllowed) return { ok: false, error: "you can't corner yourself." };
  }
  if (hitsquad.isSquadMember(member.id)) {
    return { ok: false, error: "they're on hit squad duty right now and can't be cornered until the window ends." };
  }
  // Dynamic Exclusive Target Protection check
  const exclusive = overridesManager.checkExclusiveProtection(member, byId, actorMember, actorTier);
  if (!exclusive.allowed) {
    const who = (exclusive.requiredActors || []).map(a => a.type === 'role' ? `<@&${a.id}>` : `<@${a.id}>`);
    if (exclusive.hitSquadExempt) who.push('🚔 hit squad (while active)');
    return { ok: false, error: `only ${who.join(', ') || 'nobody currently allowed'} can corner ${member.displayName || member.user?.username || 'this member'}.` };
  }
  // Protect-from deny-list (owner, 2026-08-20): blocks specific corner SOURCES — hit squad, a staff tier,
  // member-corner, or a named person/role — without restricting everything else the way an
  // EXCLUSIVE_CORNERER allow-list would (that'd mean enumerating every other legitimate actor just to
  // block one source). Independent of checkExclusiveProtection above; a target can have either or both.
  const protectFrom = overridesManager.checkProtectFrom(member, byId, actorMember, actorTier,
    { hitSquad: !!(byId && hitsquad.isSquadMember(byId)), memberCorner: !!viaMemberCorner });
  if (!protectFrom.allowed) {
    const d = protectFrom.deniedEntry;
    const who = d.type === 'hitsquad' ? 'hit squad' : d.type === 'membercorner' ? 'regular members'
      : d.type === 'tier' ? `${d.id}+ staff` : d.type === 'role' ? `<@&${d.id}>` : `<@${d.id}>`;
    return { ok: false, error: `${who} ${d.type === 'user' || d.type === 'role' ? 'is' : 'are'} blocked from cornering ${member.displayName || member.user?.username || 'this member'}.` };
  }
  // Adult Corner protection: members with the 16-17 role (1516185172213628989) are denied Adult Corner
  const MINOR_ROLE_ID = '1516185172213628989';
  if (adult && member.roles?.cache?.has(MINOR_ROLE_ID)) {
    return { ok: false, error: 'members with the 16-17 role cannot be sent to the 18+ Adult Corner.' };
  }
  // Refresh the member so .roles.cache is COMPLETE before we snapshot + strip. discord.js role edits
  // use PUT semantics computed off the LOCAL cache — a stale/partial member (e.g. from a message event,
  // or roles changed since it was last fetched) would (a) store an incomplete snapshot AND (b) silently
  // WIPE any role that's on Discord but missing from the cache (it's not in the PUT, so it's removed) —
  // and since it was never snapshotted, it's lost forever on release. This is the root of "came back
  // from the corner missing some roles". Fetching fresh here closes that whole class.
  try { member = await member.fetch(true); } catch (e) { console.error('[corner] member refresh before strip:', e.message); }
  const targetChannelId = adult && config.adultCornerChannelId ? config.adultCornerChannelId : config.cornerChannelId;
  const existing = state.getCornered(member.id);
  if (existing) {
    const newReleaseAt = durationMs ? now + durationMs : null;
    const res = attemptSeverityChange(state, member.id, byId, actorTier, newReleaseAt);
    if (!res.ok) return { ok: false, error: 'gated', needsOverride: res.needsOverride, have: res.have, need: res.need };
    armTimer(guild, member.id, newReleaseAt);   // re-arm on a re-corner / duration change
    const repeatCount = logCornerHistory(state, member.id, ruleIndex, durationMs, now);
    let threadId = existing.threadId || null;
    if (thread && !threadId) {
      threadId = await getOrCreateCornerJailThread(guild, targetChannelId, member, slowmodeSec);
      if (threadId) {
        existing.threadId = threadId;
        state.setCornered(member.id, existing);
        const ch = await guild.channels.fetch(targetChannelId).catch(() => null);
        if (ch) {
          await ch.permissionOverwrites.edit(member.id, {
            SendMessages: false,
            SendMessagesInThreads: true,
            ViewChannel: true,
            ReadMessageHistory: true
          }, { reason: 'Corner thread imprisonment: root channel lockout' }).catch(e => console.error('[corner] root lockout overwrite error:', e.message));
        }
      }
    }
    stripThreadMemberships(guild, member.id, threadId).catch(() => {});   // fire-and-forget: don't hold up the announcement on a guild-wide thread sweep
    return { ok: true, updated: true, stripped: (existing.roles || []).length, repeatCount, threadId, targetChannelId };
  }
  const me = await guild.members.fetchMe();
  const stripIds = new Set(rolesToStrip(guild, member));
  const blockers = member.roles.cache.filter(r => stripIds.has(r.id) && r.position >= me.roles.highest.position);
  if (blockers.size) {
    return { ok: false, error: `she has a role I'd need to strip that sits above mine (${[...blockers.values()].map(r => r.name).join(', ')}), so I can't corner her. ask an admin to drag my role above hers in Server Settings → Roles.` };
  }
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
  const targetIsStaff = !!(opspanel.memberTier(member) || (config.trialModRoleId && member.roles.cache.has(config.trialModRoleId)));
  const joke = !forceReal && !!actorTier && targetIsStaff;

  // Optional Thread Imprisonment & Adult Corner routing
  let threadId = null;
  if (thread) {
    threadId = await getOrCreateCornerJailThread(guild, targetChannelId, member, slowmodeSec);
    if (threadId) {
      const ch = await guild.channels.fetch(targetChannelId).catch(() => null);
      if (ch) {
        await ch.permissionOverwrites.edit(member.id, {
          SendMessages: false,
          SendMessagesInThreads: true,
          ViewChannel: true,
          ReadMessageHistory: true
        }, { reason: 'Corner thread imprisonment: root channel lockout' }).catch(e => console.error('[corner] root lockout overwrite error:', e.message));
      }
    }
  }

  state.setCornered(member.id, { roles: strip, releaseAt: durationMs ? now + durationMs : null, by: byId, at: now, appliedByRank: RANK[actorTier] || 0, joke, threadId, isAdult: !!adult, channelId: targetChannelId });
  try {
    // Use .set() with the full computed role list, not sequential .remove()/.add() calls — each role
    // edit is its own API round-trip and a crash/rate-limit between them would leave the member in a
    // half-stripped state (some roles gone, corner role never added, or vice versa). One PUT is atomic:
    // either the whole swap lands or nothing does, and there's no window where they're neither fully
    // stripped nor fully cornered.
    const stripSet = new Set(strip);
    const keptIds = member.roles.cache.filter(r => r.id !== guild.id && !stripSet.has(r.id)).map(r => r.id);
    const targetRoles = [...new Set([...keptIds, config.cornerRoleId])];
    await member.roles.set(targetRoles, 'Sent to the corner');
  } catch (err) {
    await restoreTimeout();
    state.clearCornered(member.id); // don't leave a stale "cornered" record on a failed corner
    return { ok: false, error: err.message };
  }
  await restoreTimeout(); // put the Discord timeout back - cornering doesn't cancel it
  // Disconnect from voice after the role swap: they just lost access to every normal channel (voice
  // included, since the corner role strip removes View/Connect on regular VCs), so leaving them connected
  // would either strand them in a channel they can no longer see/manage in, or (worse) let them keep
  // talking in a space they're no longer supposed to have any presence in at all.
  if (member.voice?.channelId) await member.voice.disconnect('Sent to the corner').catch(e => console.error('[corner] vc disconnect:', e.message));
  armTimer(guild, member.id, durationMs ? now + durationMs : null);   // precise auto-release at exactly the set time
  const repeatCount = logCornerHistory(state, member.id, ruleIndex);
  stripThreadMemberships(guild, member.id, threadId).catch(() => {});   // fire-and-forget: don't hold up the announcement on a guild-wide thread sweep
  return { ok: true, stripped: strip.length, repeatCount, joke, threadId, targetChannelId };
}

// Release a member: remove the corner role and restore the roles we stripped.
async function uncorner(guild, userId, state, reason = 'Released from the corner') {
  const rec = state.getCornered(userId);
  const servedMs = rec && rec.at ? Date.now() - rec.at : null;   // how long they were in the corner
  // Record served time back onto the matching corner-history entry (same start timestamp) so /stats can
  // total "time served" over a period. Best-effort; covers the member-left path too since it runs first.
  if (rec && rec.at && servedMs != null) {
    const all = state.getMeta('cornerLog') || {};
    const list = all[userId];
    if (Array.isArray(list)) {
      const entry = [...list].reverse().find(e => e.at === rec.at);
      if (entry && entry.servedMs == null) { entry.servedMs = servedMs; state.setMeta('cornerLog', all); }
    }
  }
  if (rec && rec.threadId) {
    try {
      const targetChId = rec.channelId || (rec.isAdult && config.adultCornerChannelId ? config.adultCornerChannelId : config.cornerChannelId);
      const ch = await guild.channels.fetch(targetChId).catch(() => null);
      if (ch) {
        await ch.permissionOverwrites.delete(userId, 'Released from corner thread imprisonment').catch(() => {});
      }
      const th = await guild.channels.fetch(rec.threadId).catch(() => null);
      if (th && th.isThread()) {
        await th.setArchived(true, reason).catch(() => {});
        await th.setLocked(true, reason).catch(() => {});
      }
    } catch (e) { console.error('[corner] thread archive on release:', e.message); }
  }
  const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
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
  const missed = [];   // stored roles we could NOT put back (deleted / above the bot / add failed)
  try {
    await member.roles.remove(config.cornerRoleId, reason).catch(() => {});
    if (rec && Array.isArray(rec.roles) && rec.roles.length) {
      const me = await guild.members.fetchMe();
      const botTop = me.roles.highest.position;
      // Only try roles that still exist, sit below the bot's top role, and aren't bot-managed — anything
      // else can't be added and would make Discord reject the WHOLE bulk add, costing them every role.
      const restorable = [], skip = [];
      for (const id of rec.roles) {
        const r = guild.roles.cache.get(id);
        (r && !r.managed && r.position < botTop ? restorable : skip).push(id);
      }
      missed.push(...skip);
      if (restorable.length) {
        try {
          await member.roles.add(restorable, reason);
        } catch (bulkErr) {
          // One unexpected bad role shouldn't cost them the rest — fall back to per-role adds.
          for (const id of restorable) { await member.roles.add(id, reason).catch(() => missed.push(id)); }
          console.error(`[uncorner] ${userId}: bulk restore failed (${bulkErr.message}); fell back to per-role.`);
        }
      }
    }
  } catch (err) {
    await restoreTimeout();
    return { ok: false, error: err.message };
  }
  if (missed.length) console.error(`[uncorner] ${userId}: ${missed.length} stored role(s) could not be restored: ${missed.join(', ')}`);
  await restoreTimeout(); // keep any active timeout after release
  clearTimer(userId);
  state.clearCornered(userId);
  return { ok: true, restored: rec && rec.roles ? rec.roles.length - missed.length : 0, missed, servedMs };
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

// Flip an active corner's joke flag (the "mark as real" / "mark as joke" follow-up prompt). Returns false
// if the member isn't currently cornered (prompt is stale — e.g. they were already released).
function setJoke(state, userId, joke) {
  const rec = state.getCornered(userId);
  if (!rec) return false;
  rec.joke = !!joke;
  state.setCornered(userId, rec);
  return true;
}

module.exports = { parseDuration, rolesToStrip, corner, uncorner, releaseExpired, ensureCornerPerms,
  setReleaseHandler, armTimer, clearTimer, rearmAll, setJoke,
  RANK, canBypassCornerTier, OVERRIDE_THRESHOLD, OVERRIDE_WINDOW_MS, LOWER_FLOOR_MS, isLowering, canActSolo, registerOverrideVote, bumpAppliedRank, attemptSeverityChange };
