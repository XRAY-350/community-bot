// corner.js — "the corner" jail. Cornering a member strips all of their non-identifying,
// non-managed roles (storing them), gives the corner role (which can only see the corner +
// verify/rules channels), and optionally auto-releases after a duration. Releasing restores the
// stored roles and removes the corner role.

const { PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const hitsquad = require('./hitsquad');
const opspanel = require('./opspanel');
const overridesManager = require('./overridesManager');
const permguard = require('./permguard');

// ---- severity tiering (owner, 2026-08-13) ---------------------------------------------------------
// /corner already refuses to corner someone of a HIGHER tier than the actor. This closes the mirror
// gap: /uncorner (and shortening/lowering an active corner) previously had NO such check — any mod or
// trial mod could undo a decision an admin or owner deliberately made. Canonical RANK lives here now;
// index.js and opspanel.js reference corner.RANK instead of each keeping their own copy.
const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };

function canBypassCornerTier(actorId, targetId, actorTier = null) {
  return overridesManager.canBypassTier(actorId, targetId, actorTier);
}
// Owner-cornering gate: solo bypass (a BYPASS_TIER override rule, toggleable in /panel -> Overrides) OR a
// GROUP_REQUIRED rule — N distinct staff of a chosen tier each attempting within a time window, mirroring
// the existing lowering/release override-vote mechanic but for INITIATING a corner (owner, 2026-08-23:
// "a separate tier I can add to a corner that turns it back on" / "the need for 3 admins to override a
// corner" — a per-ATTEMPT group override, not a standing on/off switch). This is the SINGLE place a group
// vote is ever registered — call it only where a corner is actually about to execute (corner()'s own
// gate below), never from an earlier "can I even try" UI pre-check (see ownerCornerPossible for that).
function ownerCornerGate(targetId, guild, byId, actorMember, actorTier) {
  if (targetId !== guild.ownerId) return { ok: true };
  if (byId && canBypassCornerTier(actorMember || byId, targetId, actorTier)) return { ok: true };
  if (!byId) return { ok: false, error: "you can't corner the server owner." };
  const grp = overridesManager.checkGroupRequired(targetId, byId, actorMember, actorTier);
  if (!grp.applicable) return { ok: false, error: "you can't corner the server owner." };
  if (grp.ok) return { ok: true, groupOverride: true };
  const mins = Math.max(1, Math.round((grp.windowMs || overridesManager.DEFAULT_GROUP_WINDOW_MS) / 60000));
  return {
    ok: false, pending: true, have: grp.have, need: grp.need,
    error: `cornering the server owner needs **${grp.need} admins** to each try within **${mins}m** of each other — you're vote **${grp.have}/${grp.need}**. Get ${grp.need - grp.have} more admin(s) to run this within the window.`,
  };
}
// Read-only counterpart: is there ANY plausible path (bypass, or a GROUP_REQUIRED rule this actor's tier
// qualifies for) for this actor to eventually corner this target — regardless of the current vote tally?
// Used by early pre-modal UI gates so a non-qualifying actor is told "no" immediately without a vote being
// registered; a qualifying actor is let through to the flow that actually calls corner() (and casts their
// real vote) instead of being wrongly hard-blocked before they ever get the chance.
function ownerCornerPossible(targetId, guild, byId, actorMember, actorTier) {
  if (targetId !== guild.ownerId) return true;
  if (byId && canBypassCornerTier(actorMember || byId, targetId, actorTier)) return true;
  return !!byId && overridesManager.canAttemptGroupRequired(targetId, byId, actorMember, actorTier);
}
// Multi-person override: a group of SAME-TIER staff can force a release/lowering through even below the
// tier that applied it — 1 owner/botowner solo, or 3 mods together, acting within a 5-minute window of
// each other. Admins act solo BY DEFAULT (see canActSolo) — UNLESS this specific corner has
// rec.requireAdminGroup set (owner, 2026-08-23: "There was a rule that requires 3 admin override that was
// removed... I want to bring it back situationally" -> corrected twice: "it's a per corner config not a
// toggle" — a property of ONE corner instance, not a global switch. Set/cleared per-corner via the
// 🛡️ button on the post-corner check-in prompt, same place as the joke flag — see jokeCheckIn/
// setRequireAdminGroup). `admin: 3` in the threshold below only ever matters once canActSolo falls
// through, which now only happens for a corner that's explicitly flagged this way.
// Trial mods (and anyone with no recognized tier) have NO override path — no number of them unlocks it;
// provisional, revisit once there's a sense of how often this comes up.
const OVERRIDE_THRESHOLD = { botowner: 1, owner: 1, mod: 3, admin: 3 };
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
// corner-er (always gets a solo override on their own case, any tier), they're an ADMIN (owner,
// 2026-08-14: admins no longer need a 3-admin override vote on an owner's corner; owner, 2026-08-21:
// "i thought i asked for the ⅓ limit to be removed from admins" — that first pass only covered
// owner-applied corners, this removes the threshold for admins entirely, including botowner-applied
// ones), or their current tier outranks/matches whatever tier last touched this corner's severity.
// rec.uncornerLock (owner, 2026-08-25: "two new tiers ... owner only uncorner ... server owner only
// uncorner", confirmed "hard lock — no override at all") is a HARD lock, checked BEFORE the joke waiver and
// the original-corner-er exception — unlike every other protection here, nothing waives it once set:
//   'owner'       — only actorTier at/above RANK.owner (Owner-role staff, or bot-owner) can act, solo.
//   'serverowner' — only the literal Discord guild owner account can act (NOT just bot-owner tier, which
//                   also covers the owner's alt — this is narrower, the exact guild.ownerId only).
// guildOwnerId is optional so existing callers that never pass it just can't satisfy a 'serverowner' lock
// (fails closed, never open).
function canActSolo(rec, actorId, actorTier, guildOwnerId = null) {
  if (rec.uncornerLock === 'serverowner') return actorId === guildOwnerId;
  if (rec.uncornerLock === 'owner') return (RANK[actorTier] || 0) >= RANK.owner;
  if (rec.joke) return true;   // joke corner — release/lowering gate is waived entirely, any tier can act solo
  if (rec.by === actorId) return true;
  if (actorTier === 'admin' && !rec.requireAdminGroup) return true;
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
function attemptSeverityChange(state, userId, actorId, actorTier, newReleaseAt, guildOwnerId = null) {
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
  if (canActSolo(rec, actorId, actorTier, guildOwnerId)) {
    rec.appliedByRank = RANK[actorTier] || 0;
    rec.overrideVotes = [];
    applyNewTime();
    state.setCornered(userId, rec);
    return { ok: true, needsOverride: false };
  }
  // A hard uncornerLock has NO override path at all, not even a group vote — that's the whole point of it
  // being a HARD lock (owner confirmed: distinct from requireAdminGroup, which still lets a group through).
  if (rec.uncornerLock) {
    state.setCornered(userId, rec);
    return { ok: false, needsOverride: false, hardLocked: rec.uncornerLock };
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
// Apply (or clear) ONE role's overwrite on a channel, self-healing style: no-op if it already matches,
// edits if a specific shape is desired, deletes outright if desired is null (the role should have NO
// special access here at all — used to retire the old shared-role grant off the adult corner channel).
async function applyRoleOverwrite(ch, roleId, desired, reason) {
  if (!roleId) return 0;
  if (desired === null) {
    if (!ch.permissionOverwrites.cache.has(roleId)) return 0;
    await ch.permissionOverwrites.delete(roleId, reason);
    return 1;
  }
  if (overwriteMatches(ch, roleId, desired)) return 0;
  await ch.permissionOverwrites.edit(roleId, desired, { reason });
  return 1;
}

async function ensureCornerPerms(guild) {
  const everyone = guild.roles.everyone.id;
  let fixed = 0;
  let blessed = 0;
  const chans = [...(await guild.channels.fetch()).values()].filter(Boolean);
  // The two corner roles are mutually exclusive (see config.js's comment on adultCornerRoleId) — each
  // channel below grants full corner access to exactly ONE of them, never both, so Discord's own
  // permission resolution keeps a member out of the corner channel they aren't actually in, with no
  // per-member overwrite bookkeeping needed anywhere.
  for (const ch of chans) {
    const before = fixed;
    try {
      if (ch.id === config.cornerChannelId) {
        // Non-cornered members: see + react ONLY — view, read history, add reactions; no send, no threads.
        const everyoneDesired = {
          ViewChannel: true, ReadMessageHistory: true, AddReactions: true,
          SendMessages: false, SendMessagesInThreads: false,
          CreatePublicThreads: false, CreatePrivateThreads: false,
        };
        fixed += await applyRoleOverwrite(ch, everyone, everyoneDesired, 'corner self-heal');
        const cornerDesired = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AddReactions: true };
        fixed += await applyRoleOverwrite(ch, config.cornerRoleId, cornerDesired, 'corner self-heal');
        // adultCornerRoleId gets NO overwrite here on purpose — they fall through to @everyone's grant
        // above (ViewChannel:true, SendMessages:false), which is exactly "can see the public corner,
        // can't talk in it". Explicitly retire any leftover grant from before the roles were split.
        fixed += await applyRoleOverwrite(ch, config.adultCornerRoleId, null, 'corner self-heal: adult-corner role should not speak here');
        if (config.modRoleId) fixed += await applyRoleOverwrite(ch, config.modRoleId, { ViewChannel: true, SendMessages: true }, 'corner self-heal');
        // Trial mods can speak in the corner too (talk to / moderate cornered members).
        if (config.trialModRoleId) fixed += await applyRoleOverwrite(ch, config.trialModRoleId, { ViewChannel: true, SendMessages: true }, 'corner self-heal');
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
        // Adult Corner: @everyone denied view; 16-17 role explicitly denied; the ADULT corner role +
        // staff allowed. The regular corner role gets NO overwrite here — retire any leftover grant.
        fixed += await applyRoleOverwrite(ch, everyone, { ViewChannel: false }, 'adult corner self-heal');
        const minorRoleId = '1516185172213628989';   // ✰ • 16-17 role
        const minorDesired = { ViewChannel: false, SendMessages: false, ReadMessageHistory: false };
        fixed += await applyRoleOverwrite(ch, minorRoleId, minorDesired, 'adult corner minor deny self-heal').catch(() => 0);
        const cornerDesired = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AddReactions: true };
        fixed += await applyRoleOverwrite(ch, config.adultCornerRoleId, cornerDesired, 'adult corner self-heal');
        fixed += await applyRoleOverwrite(ch, config.cornerRoleId, null, 'adult corner self-heal: regular-corner role should not speak here');
        if (config.modRoleId) fixed += await applyRoleOverwrite(ch, config.modRoleId, { ViewChannel: true, SendMessages: true }, 'adult corner self-heal');
        if (config.trialModRoleId) fixed += await applyRoleOverwrite(ch, config.trialModRoleId, { ViewChannel: true, SendMessages: true }, 'adult corner self-heal');
        // The role-level minor deny above is NOT enough by itself (Discord unions denies-then-allows
        // ACROSS a member's held roles, so a minor who also holds mod/trial-mod/admin has that role's
        // ViewChannel allow win over the minor role's deny). That's the exact class index.js's
        // enforceMdniStaffLock()/sweepMdniStaffLock() already exists to close, and it's already wired to
        // this channel (boot sweep + live on every guildMemberUpdate) via a member-level deny, which DOES
        // beat every role. Do not duplicate that here — a second system pinning its own member-overwrite
        // on the same channel fights the first one's cleanup pass and each deletes the other's fix (hit
        // live 2026-08-22, see PROGRESS_LOG). If a minor-staff leak shows up on THIS channel specifically,
        // the fix belongs in enforceMdniStaffLock's tier check, not here.
        continue;
      }
      if (ch.id === config.cornerVcId) {
        // Corner VC: shared by both corner types (there's no separate adult VC) — @everyone can SEE but
        // not join; either corner role can join + talk (no screen-share/soundboard); mods get full voice
        // moderation. (This channel sits IN the view category, so it needs its own case — the generic
        // view-only rule below would grant View but not Connect.)
        fixed += await applyRoleOverwrite(ch, everyone, { ViewChannel: true, Connect: false }, 'corner self-heal');
        const rDesired = { ViewChannel: true, Connect: true, Speak: true, SendMessages: true, ReadMessageHistory: true, AddReactions: true, EmbedLinks: true, Stream: false, UseSoundboard: false, UseExternalSounds: false };
        fixed += await applyRoleOverwrite(ch, config.cornerRoleId, rDesired, 'corner self-heal');
        fixed += await applyRoleOverwrite(ch, config.adultCornerRoleId, rDesired, 'corner self-heal');
        const mDesired = { ViewChannel: true, Connect: true, Speak: true, MuteMembers: true, MoveMembers: true, DeafenMembers: true };
        if (config.modRoleId) fixed += await applyRoleOverwrite(ch, config.modRoleId, mDesired, 'corner self-heal');
        // Trial mods can join + speak in the corner VC (participate, not full voice-mod: no mute/move/deafen).
        if (config.trialModRoleId) fixed += await applyRoleOverwrite(ch, config.trialModRoleId, { ViewChannel: true, Connect: true, Speak: true }, 'corner self-heal');
        // Admins outrank mods, so they get at least the same full voice-mod access mods have (owner,
        // 2026-08-24: "make sure staff tier people that our moderators can join. Corner VC" — FUBU's ADMIN
        // role has no Administrator permission bypass, unlike Melanin's, so without this explicit grant
        // admins were actually blocked from joining, same as a regular member).
        if (config.adminRoleId) fixed += await applyRoleOverwrite(ch, config.adminRoleId, mDesired, 'corner self-heal');
        // Every other staff-floor role (Mini-Mod, Event Organizer) gets the same participate-only access as
        // Trial Mod — they already have scoped corner/moderation duties elsewhere, so being able to sit in
        // the corner VC is consistent. Media Team/Greeter/Support Helper are deliberately EXCLUDED — those
        // positions carry no moderation powers by design (see their /panel descriptions), so extending
        // corner VC access to them would contradict that.
        const staffFloorParticipate = { ViewChannel: true, Connect: true, Speak: true };
        try {
          const langmods = require('./langmods');
          for (const lang of langmods.languages()) {
            const rid = langmods.roleForLang(lang);
            if (rid) fixed += await applyRoleOverwrite(ch, rid, staffFloorParticipate, 'corner self-heal');
          }
        } catch { /* langmods not available in this context */ }
        try {
          const eventorgapps = require('./eventorgapps');
          if (eventorgapps.ORGANIZER_ROLE_ID) fixed += await applyRoleOverwrite(ch, eventorgapps.ORGANIZER_ROLE_ID, staffFloorParticipate, 'corner self-heal');
        } catch { /* eventorgapps not available in this context */ }
        continue;
      }
      if (ch.id === config.cornerLogChannelId) {
        // The corner-log is PUBLIC read-only: everyone can SEE it (view + history + react) but only
        // staff/the bot post. Both corner roles keep the same view-only access.
        const readOnly = { ViewChannel: true, ReadMessageHistory: true, AddReactions: true, SendMessages: false };
        fixed += await applyRoleOverwrite(ch, everyone, readOnly, 'corner self-heal: log is public');
        if (config.verifiedRoleId) {
          const vOw = ch.permissionOverwrites.cache.get(config.verifiedRoleId);
          if (vOw && vOw.deny.has(PermissionsBitField.Flags.ViewChannel)) {
            await ch.permissionOverwrites.edit(config.verifiedRoleId, { ViewChannel: null }, { reason: 'corner self-heal: log is public' }); fixed++;
          }
        }
        fixed += await applyRoleOverwrite(ch, config.cornerRoleId, readOnly, 'corner self-heal');
        fixed += await applyRoleOverwrite(ch, config.adultCornerRoleId, readOnly, 'corner self-heal');
        continue;
      }
      // Cornered members (either role) get view-only on the verify-and-rules category (so they can read
      // the rules). Everything else stays hidden from them.
      const viewOnly = ch.id === config.cornerViewCategoryId || ch.parentId === config.cornerViewCategoryId;
      // View-only channels (verify/rules + corner-log): let cornered SEE past messages (ReadMessageHistory
      // — the fix for "can't see the log", since the category denies history by default) and react, but
      // not send. Everything else stays hidden.
      const desired = viewOnly
        ? { ViewChannel: true, ReadMessageHistory: true, AddReactions: true, SendMessages: false }
        : { ViewChannel: false };
      fixed += await applyRoleOverwrite(ch, config.cornerRoleId, desired, 'corner self-heal');
      fixed += await applyRoleOverwrite(ch, config.adultCornerRoleId, desired, 'corner self-heal');
    } catch (err) {
      console.error(`[corner] perm self-heal on #${ch.name}: ${err.message}`);
    } finally {
      // permguard's drift sweep only knows a channel's overwrites are correct if they match its golden
      // manifest snapshot — anything we just changed here but never bless() into that manifest gets
      // silently reverted on permguard's next pass (its OWN boot sweep can run within seconds of this
      // one). Found live 2026-08-22: the whole two-role split got wiped back to the old shared-role grant
      // by permguard 40s after this function first applied it, because nothing here ever blessed the
      // channels it touched — see PROGRESS_LOG. Bless only channels we actually changed this pass, not
      // every channel unconditionally, so untouched channels' drift detection stays live.
      if (fixed > before) {
        const ok = await permguard.blessChannel(guild, ch.id).catch(() => false);
        if (ok) blessed++;
      }
    }
  }
  if (blessed) console.log(`[corner] blessed ${blessed} channel(s) into permguard's baseline after self-heal`);
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
      && r.id !== config.cornerRoleId && r.id !== config.adultCornerRoleId && !keep.has(r.id))
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
// DUE-PROCESS threads survive the strip (audit U6, 2026-08-26): the member's own report threads, ban/strike
// appeals, sidebars they're in, and their open staff-application thread. Stripping those contradicted the
// stated design ("you can reach [your appeal] even while cornered") and — since uncorner never re-adds
// thread memberships — permanently locked a member out of their own appeal. Lazy-required to keep corner.js
// free of load-order coupling with the five modules.
function dueProcessThreads(memberId) {
  const ids = new Set();
  for (const mod of ['reports', 'sidebar', 'appeals', 'strikeAppeals', 'modapps']) {
    try { for (const tid of require(`./${mod}`).threadsFor(memberId)) ids.add(tid); }
    catch (e) { console.error(`[corner] dueProcessThreads/${mod}:`, e.message); }
  }
  return ids;
}
async function stripThreadMemberships(guild, memberId, exceptThreadId) {
  try {
    const keep = dueProcessThreads(memberId);
    const active = await guild.channels.fetchActiveThreads().catch(() => null);
    if (!active) return;
    for (const thread of active.threads.values()) {
      if (thread.id === exceptThreadId || keep.has(thread.id)) continue;
      if (thread.type !== ChannelType.PrivateThread) continue;
      const tm = await thread.members.fetch(memberId).catch(() => null);
      if (tm) await thread.members.remove(memberId, 'Sent to the corner: thread membership stripped').catch(() => {});
    }
  } catch (e) { console.error('[corner] stripThreadMemberships:', e.message); }
}

// Post the staff ➕/➖ controls into a jail thread and pin them. Called on thread CREATION and again on
// every REUSE (owner, 2026-08-26: the buttons "don't resend on every corner and get stuck at the top") —
// so the controls are near the bottom for each fresh corner AND always findable in the pins. Old pinned
// copies are unpinned first so the pin list doesn't accumulate one per corner.
async function sendJailControls(thread) {
  try {
    const pins = await thread.messages.fetchPins().catch(() => null);
    const items = pins ? (pins.items ? pins.items.map(p => p.message) : [...pins.values()]) : [];
    for (const m of items) {
      if (m?.author?.id === thread.client.user.id && m.components?.length && /cornerthread_add/.test(JSON.stringify(m.components))) {
        await m.unpin().catch(() => {});
      }
    }
  } catch { /* best-effort unpin */ }
  const msg = await thread.send({
    content: '-# Staff: pull someone else in here if this needs both sides.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cornerthread_add').setEmoji('➕').setLabel('Add someone').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cornerthread_remove').setEmoji('➖').setLabel('Remove someone').setStyle(ButtonStyle.Secondary))],
  }).catch(() => null);
  if (msg) await msg.pin().catch(() => {});
}

// Find existing dedicated jail thread or create a new private thread for cornered member
// A thread-jailed member must be silenced in the SHARED corner channel — they only speak in their own
// private jail thread. This is a DENY-ONLY member overwrite ON PURPOSE: granting ViewChannel/ReadHistory
// at the member level trips permguard's self-grant auto-deletion (it wipes any member overwrite whose ALLOW
// includes ViewChannel — permguard.js:132), which took the SendMessages deny down with it and let the
// jailed member speak in the shared corner again (owner-reported 2026-08-26 — several thread-jailed people
// talking in #the-corner, and a trail of hand-added -Send overwrites trying to plug it one by one). The
// Corner role already grants View + ReadHistory on the corner channel, so the overwrite only needs to DENY
// main-channel Send while still allowing thread posting.
async function applyThreadLockout(guild, memberId, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return;
  await ch.permissionOverwrites.edit(memberId, {
    SendMessages: false, SendMessagesInThreads: true, ViewChannel: null, ReadMessageHistory: null,
  }, { reason: 'Corner thread imprisonment: shared-corner lockout (deny-only, survives permguard)' })
    .catch(e => console.error('[corner] thread lockout overwrite:', e.message));
}
// Clear a member's shared-corner lockout on release (both regular + adult corner) — without this the
// deny-only overwrite lingered after release, which is the other half of the "leftover individual perms"
// the owner saw on the corner channel.
async function clearThreadLockout(guild, memberId) {
  for (const chId of [config.cornerChannelId, config.adultCornerChannelId].filter(Boolean)) {
    const ch = await guild.channels.fetch(chId).catch(() => null);
    if (ch) await ch.permissionOverwrites.delete(memberId, 'Corner release: clear shared-corner lockout').catch(() => {});
  }
}

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
      // Reused thread: apply the requested slowmode, or explicitly CLEAR a leftover one when this corner
      // didn't ask for slowmode. Release already clears it, but a release that couldn't reach the thread
      // (bot down, thread temporarily unfetchable) would otherwise leave the old limit in place and
      // silently apply it to the next person cornered here.
      // Set unconditionally rather than diffing against thread.rateLimitPerUser — a stale cached read
      // would skip the clear, which IS the bug being guarded against.
      const wantSlow = slowmodeSec != null ? slowmodeSec : 0;
      await thread.setRateLimitPerUser(wantSlow, slowmodeSec != null ? 'Corner slowmode set by staff' : 'Corner: clearing slowmode left over from a previous corner').catch(e => console.error('[corner] slowmode (reused thread):', e.message));
      // Re-send the ➕/➖ staff controls on every REUSE (owner, 2026-08-26: "the add someone and remove
      // someone buttons don't resend on every corner and get stuck at the top") — the original controls
      // message scrolls away and was only ever posted once at creation. Pinned too, so it's always one
      // click away in the pins even between corners.
      await sendJailControls(thread).catch(() => {});
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
    // picker so there's one add-people flow, not two. Pinned + re-sent on every reuse (owner, 2026-08-26).
    await sendJailControls(newThread).catch(() => {});
    return newThread.id;
  } catch (err) {
    console.error('[corner] getOrCreateCornerJailThread error:', err.message);
    return null;
  }
}

// The regular corner and the Adult Corner used to share ONE Discord role, whose channel overwrites
// granted SendMessages in BOTH channels — a member cornered in either one could also talk in the other
// (owner, 2026-08-21: "people in the adult corner shouldn't be able to talk in the regular corner").
// First fix was a per-member overwrite locking the "other" channel; owner's follow-up ("what about an
// adult corner role? seems more simple") replaced that with a SECOND, mutually-exclusive Discord role —
// ensureCornerPerms above now grants each corner channel to exactly one role, so Discord's own
// permission resolution keeps the separation with no per-member bookkeeping at all. These two helpers
// are what keep the roles genuinely exclusive (never both held at once — see config.js's comment on why
// that specifically matters for how Discord combines multiple roles' overwrites).
function cornerRoleFor(adult) { return adult ? config.adultCornerRoleId : config.cornerRoleId; }
function isCorneredRole(roleId) { return roleId === config.cornerRoleId || (!!config.adultCornerRoleId && roleId === config.adultCornerRoleId); }
function memberIsCornered(member) { return !!member?.roles?.cache && (member.roles.cache.has(config.cornerRoleId) || (!!config.adultCornerRoleId && member.roles.cache.has(config.adultCornerRoleId))); }

// Send a member to the corner. durationMs null = indefinite. ruleIndex (optional, from /corner's rule
// dropdown) drives the repeat-history count above. Returns {ok, ..., repeatCount}.
async function corner(guild, member, durationMs = null, state, byId = null, ruleIndex = null, actorTier = null, opts = {}) {
  const { forceReal = false, adult = false, thread = false, anon = false, viaMemberCorner = false, slowmodeSec = null } = opts || {};
  const now = Date.now();
  // A hit-squad corner is chaos, not discipline — it must never carry a rule (owner, 2026-08-20: "we
  // don't want them polluting the rule count for corner to strike"). logCornerHistory() counts prior
  // corners sharing the SAME ruleIndex and that repeatCount is what alerts staff to convert a pattern
  // into a Strike, so a squad corner tagged with a rule would inflate a real member's escalation count
  // for something that was never a genuine offence. Stripped HERE rather than only at the /corner
  // handler so every entry path (slash, context menu, modal, panel buttons) is covered by one guard;
  // the history entry itself is still written, just with ruleIndex null, which returns 1 and matches no
  // rule's filter. Window-scoped: isSquadMember is false the moment the activation expires.
  if (byId && ruleIndex && hitsquad.isSquadMember(byId)) ruleIndex = null;
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

  const ownerGate = ownerCornerGate(member.id, guild, byId, actorMember, actorTier);
  if (!ownerGate.ok) return { ok: false, error: ownerGate.error, pending: ownerGate.pending, have: ownerGate.have, need: ownerGate.need };
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
    const res = attemptSeverityChange(state, member.id, byId, actorTier, newReleaseAt, guild.ownerId);
    if (!res.ok) return { ok: false, error: 'gated', needsOverride: res.needsOverride, have: res.have, need: res.need, hardLocked: res.hardLocked };
    armTimer(guild, member.id, newReleaseAt);   // re-arm on a re-corner / duration change
    // A re-corner can flip `adult` from what it was — swap the exclusive role to match (AWAITED: this
    // role membership IS the security boundary, a race window here would defeat it). No-op the common
    // case where it's unchanged; role.remove()/add() on a role already absent/present is a harmless no-op.
    const wantRole = cornerRoleFor(adult), otherRole = cornerRoleFor(!adult);
    if (otherRole) await member.roles.remove(otherRole, 'Corner: switched corner type').catch(() => {});
    if (wantRole) await member.roles.add(wantRole, 'Corner: switched corner type').catch(() => {});
    const repeatCount = logCornerHistory(state, member.id, ruleIndex, durationMs, now);
    let threadId = existing.threadId || null;
    if (thread && !threadId) {
      threadId = await getOrCreateCornerJailThread(guild, targetChannelId, member, slowmodeSec);
      if (threadId) {
        existing.threadId = threadId;
        state.setCornered(member.id, existing);
        await applyThreadLockout(guild, member.id, targetChannelId);
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
    if (threadId) await applyThreadLockout(guild, member.id, targetChannelId);
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
    const targetRoles = [...new Set([...keptIds, cornerRoleFor(adult)].filter(Boolean))];
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
      const th = await guild.channels.fetch(rec.threadId).catch(() => null);
      if (th && th.isThread()) {
        // Drop any slowmode the corner set (owner, 2026-08-20: "the slowmode on a corner should turn off
        // when the person is released"), then lock, and archive LAST. Discord rejects every edit to an
        // archived thread ("Thread is archived"), so anything attempted after setArchived silently
        // no-ops through its .catch. Verified live: with archive first, the slowmode stayed at its old
        // value AND `locked` stayed false — this code was never actually locking released jail threads.
        await th.setRateLimitPerUser(0, reason).catch(e => console.error('[corner] slowmode clear on release:', e.message));
        await th.setLocked(true, reason).catch(() => {});
        await th.setArchived(true, reason).catch(() => {});
      }
    } catch (e) { console.error('[corner] thread archive on release:', e.message); }
  }
  const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  if (!member) { await clearThreadLockout(guild, userId); clearTimer(userId); state.clearCornered(userId); return { ok: true, left: true, servedMs }; }
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
    for (const r of [config.cornerRoleId, config.adultCornerRoleId].filter(Boolean)) {
      await member.roles.remove(r, reason).catch(() => {});
    }
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
  await clearThreadLockout(guild, userId);   // drop the shared-corner send-lockout so it doesn't linger post-release
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

// Per-corner config (not a global mode — owner, 2026-08-23): does THIS specific active corner require a
// 3-admin group (see canActSolo/OVERRIDE_THRESHOLD.admin) to release or lower it? Returns false if the
// member isn't currently cornered (prompt is stale). Read the live value with corner.requiresAdminGroup.
function setRequireAdminGroup(state, userId, val) {
  const rec = state.getCornered(userId);
  if (!rec) return false;
  rec.requireAdminGroup = !!val;
  if (val) rec.uncornerLock = null;   // mutually exclusive with a hard lock — group beats nothing, but a
  state.setCornered(userId, rec);     // hard lock is strictly stronger, so setting group clears any hard lock
  return true;
}
function requiresAdminGroup(state, userId) {
  const rec = state.getCornered(userId);
  return !!(rec && rec.requireAdminGroup);
}

// Per-corner HARD release lock (owner, 2026-08-25): 'owner' or 'serverowner', or null to clear. Unlike
// requireAdminGroup, there is no group-vote fallback — see canActSolo/attemptSeverityChange's hardLocked
// branch. Setting a lock clears requireAdminGroup (mutually exclusive — the lock is strictly stronger).
function setUncornerLock(state, userId, lock) {
  const rec = state.getCornered(userId);
  if (!rec) return false;
  rec.uncornerLock = lock || null;
  if (lock) rec.requireAdminGroup = false;
  state.setCornered(userId, rec);
  return true;
}
function getUncornerLock(state, userId) {
  const rec = state.getCornered(userId);
  return rec ? (rec.uncornerLock || null) : null;
}

module.exports = { parseDuration, rolesToStrip, corner, uncorner, releaseExpired, ensureCornerPerms,
  logCornerHistory,   // exported for verification: the corner->strike repeat counter

  cornerRoleFor, isCorneredRole, memberIsCornered,

  setReleaseHandler, armTimer, clearTimer, rearmAll, setJoke, setRequireAdminGroup, requiresAdminGroup, clearThreadLockout,
  setUncornerLock, getUncornerLock,
  RANK, canBypassCornerTier, OVERRIDE_THRESHOLD, OVERRIDE_WINDOW_MS, LOWER_FLOOR_MS, isLowering, canActSolo, registerOverrideVote, bumpAppliedRank, attemptSeverityChange,
  ownerCornerGate, ownerCornerPossible };
