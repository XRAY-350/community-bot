// corner.js — "the corner" jail. Cornering a member strips all of their non-identifying,
// non-managed roles (storing them), gives the corner role (which can only see the corner +
// verify/rules channels), and optionally auto-releases after a duration. Releasing restores the
// stored roles and removes the corner role.

const { PermissionsBitField } = require('discord.js');
const config = require('./config');
const hitsquad = require('./hitsquad');

// ---- severity tiering (owner, 2026-08-13) ---------------------------------------------------------
// /corner already refuses to corner someone of a HIGHER tier than the actor. This closes the mirror
// gap: /uncorner (and shortening/lowering an active corner) previously had NO such check — any mod or
// trial mod could undo a decision an admin or owner deliberately made. Canonical RANK lives here now;
// index.js and opspanel.js reference corner.RANK instead of each keeping their own copy.
const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
// One-off personal overrides (owner request, 2026-08-14/15): specific actors may corner specific targets,
// bypassing the normal higher-tier block below — regardless of either party's tier now or later. Not a
// general rule; keep this list short and named, same pattern as index.js's SELF_CORNER_EXEMPT_ID.
// actorId '*' = ANY actor (still subject to their own tier's normal duration/reason/daily-cap limits —
// this only lifts the "can't touch someone above your tier" gate, nothing else) — used for the real
// Discord server owner opting themselves in as a cornerable target (2026-08-15): purely cosmetic for them
// specifically, since the actual guild owner keeps full Discord permissions regardless of stripped roles.
const PERSONAL_CORNER_OVERRIDES = [
  { actorId: '1415112053823242250', targetId: '989615671178575972' },   // approved actor -> approved target
  { actorId: '593371777569390602', targetId: '989615671178575972' },    // second approved actor -> same target
  { actorId: '*', targetId: '865843812907089940' },                     // any STAFF actor -> the server owner (opted in) — narrowed from any verified member (owner, 2026-08-17: "change the everyone corner to only staff (mod+)")
];
// actorTier: pass the actor's recognized staff tier (opspanel.tierOf/memberTier — 'mod'/'admin'/'owner'/
// 'botowner'), or null/undefined for a plain verified member. Named overrides (exact actorId match) work
// regardless of tier; the wildcard '*' entry only matches a STAFF actorTier now — a regular member no
// longer qualifies for it even though the target opted in to being corner-able by "anyone."
function canBypassCornerTier(actorId, targetId, actorTier = null) {
  return PERSONAL_CORNER_OVERRIDES.some(o => {
    if (o.targetId !== targetId) return false;
    if (o.actorId === actorId) return true;
    if (o.actorId === '*') return !!actorTier;
    return false;
  });
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
  // durationMs = the sentence length (null = indefinite); servedMs is filled in on release (uncorner).
  // `at` is passed from corner() so it MATCHES the active record's start time, letting uncorner attribute
  // served time to the right entry.
  list.push({ ruleIndex: ruleIndex || null, at, durationMs: durationMs || null, servedMs: null });
  all[memberId] = list;
  state.setMeta('cornerLog', all);
  if (!ruleIndex) return 1;
  return list.filter(e => e.ruleIndex === ruleIndex).length;
}

// Send a member to the corner. durationMs null = indefinite. ruleIndex (optional, from /corner's rule
// dropdown) drives the repeat-history count above. Returns {ok, ..., repeatCount}.
async function corner(guild, member, durationMs, state, byId, ruleIndex, actorTier = null) {
  const now = Date.now();
  // Nobody can corner themselves — every entry point (slash /corner, "Send to corner", the dashboard
  // picker, the re-corner button) funnels through here, so one central guard closes them all. The tier
  // check upstream lets equal tiers act on each other (mod↔mod), which — with no self-check — also let a
  // mod corner their OWN account and self-strip their roles. Auto-corner (rule 9) passes the bot's id as
  // byId against a member target, so byId===member.id only ever means a genuine self-corner attempt.
  if (byId && byId === member.id) {
    return { ok: false, error: "you can't corner yourself." };
  }
  // The server owner is never cornerable, full stop — centralized here (not left to each of the ~8
  // callers to remember) after finding one caller (the Send-to-corner reason-modal submit handler) with
  // NO owner check at all: the upstream command that opens the modal validates the target, but the modal
  // submit step that actually strips roles trusted the embedded id with no re-check. One guard here closes
  // every entry point, present and future, regardless of what each caller does or forgets to do upstream.
  if (member.id === guild.ownerId && !(byId && canBypassCornerTier(byId, member.id, actorTier))) {
    return { ok: false, error: "you can't corner the server owner." };
  }
  // A current hit-squad member is immune to being cornered (by anyone, staff included) for as long as
  // their activation window is live (owner, 2026-08-17: "they can't be cornered during the window") — same
  // central choke point every entry point already funnels through, so this can't be dodged via a path that
  // forgot to check it.
  if (hitsquad.isSquadMember(member.id)) {
    return { ok: false, error: "they're on hit squad duty right now and can't be cornered until the window ends." };
  }
  // Refresh the member so .roles.cache is COMPLETE before we snapshot + strip. discord.js role edits
  // use PUT semantics computed off the LOCAL cache — a stale/partial member (e.g. from a message event,
  // or roles changed since it was last fetched) would (a) store an incomplete snapshot AND (b) silently
  // WIPE any role that's on Discord but missing from the cache (it's not in the PUT, so it's removed) —
  // and since it was never snapshotted, it's lost forever on release. This is the root of "came back
  // from the corner missing some roles". Fetching fresh here closes that whole class.
  try { member = await member.fetch(true); } catch (e) { console.error('[corner] member refresh before strip:', e.message); }
  const existing = state.getCornered(member.id);
  if (existing) {
    // Already cornered — just update the release time (don't re-strip). Routed through the same
    // severity gate as /uncorner's reschedule (owner, 2026-08-13) — re-running /corner with a shorter
    // duration is just as much a "lowering" as scheduling one via /uncorner, and this path used to
    // bypass the gate entirely AND silently reassign `by` to whoever re-ran it (letting anyone "adopt"
    // solo-override rights over someone else's corner just by re-cornering them). `by` is preserved now.
    const newReleaseAt = durationMs ? now + durationMs : null;
    const res = attemptSeverityChange(state, member.id, byId, actorTier, newReleaseAt);
    if (!res.ok) return { ok: false, error: 'gated', needsOverride: res.needsOverride, have: res.have, need: res.need };
    armTimer(guild, member.id, newReleaseAt);   // re-arm on a re-corner / duration change
    const repeatCount = logCornerHistory(state, member.id, ruleIndex, durationMs, now);
    return { ok: true, updated: true, stripped: (existing.roles || []).length, repeatCount };
  }
  // Guard: the bot can't touch roles positioned at/above its OWN highest role — trying would fail with a
  // raw "Missing Permissions". Only roles we'd actually STRIP matter here — a KEPT role above the bot is
  // fine, because we never touch it. (The bot's role sits at the very top by design, so this is mostly a
  // backstop.) The actual guild owner is already fully blocked above; someone who merely HOLDS the
  // OWNER⚜️ role without being guild.ownerId (owner tier also requires the Administrator permission — see
  // opspanel.memberTier) is still cornerable by an equal-or-higher tier actor, and OWNER⚜️ strips along
  // with everything else — it's an access-granting role, not a kept identifying one.
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
  state.setCornered(member.id, { roles: strip, releaseAt: durationMs ? now + durationMs : null, by: byId, at: now, appliedByRank: RANK[actorTier] || 0 });
  try {
    // ONE atomic role.set() instead of a separate remove() then add() (owner-reported, 2026-08-12: "cornered
    // people are still getting tribe roles back"). Two separate calls fired two separate guildMemberUpdate
    // events — in the gap between them (roles stripped, corner role not yet added), enforceTribeMembership's
    // guildMemberUpdate handler saw no corner role, treated the tribe-role strip as unauthorized tampering,
    // and immediately re-added it, moments before the corner role itself landed. A single set() has only one
    // resulting state, with the corner role already present in it — no gap for that race to land in.
    const stripSet = new Set(strip);
    const keptIds = member.roles.cache.filter(r => r.id !== guild.id && !stripSet.has(r.id)).map(r => r.id);
    await member.roles.set([...keptIds, config.cornerRoleId], 'Sent to the corner');
  } catch (err) {
    await restoreTimeout();
    state.clearCornered(member.id); // don't leave a stale "cornered" record on a failed corner
    return { ok: false, error: err.message };
  }
  await restoreTimeout(); // put the Discord timeout back - cornering doesn't cancel it
  // They just lost access to every normal channel, but Discord does NOT reliably eject someone from a voice
  // channel they're already in on a permission change — so pull them out of voice explicitly.
  if (member.voice?.channelId) await member.voice.disconnect('Sent to the corner').catch(e => console.error('[corner] vc disconnect:', e.message));
  armTimer(guild, member.id, durationMs ? now + durationMs : null);   // precise auto-release at exactly the set time
  const repeatCount = logCornerHistory(state, member.id, ruleIndex);
  return { ok: true, stripped: strip.length, repeatCount };
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

module.exports = { parseDuration, rolesToStrip, corner, uncorner, releaseExpired, ensureCornerPerms,
  setReleaseHandler, armTimer, clearTimer, rearmAll,
  RANK, canBypassCornerTier, OVERRIDE_THRESHOLD, OVERRIDE_WINDOW_MS, LOWER_FLOOR_MS, isLowering, canActSolo, registerOverrideVote, bumpAppliedRank, attemptSeverityChange };
