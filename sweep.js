// sweep.js — periodic housekeeping. One bulk member fetch per sweep powers three passes:
//   1) REAP members: any member still unverified — WHETHER OR NOT they have a thread — is warned
//      with an @mention WARN_DAYS after joining, then KICKED and any thread(s) they own deleted
//      KICK_DAYS after joining. Members with a thread are warned inside it; thread-less members
//      are warned in the unverified-chat channel.
//   2) THREAD CLEANUP (open AND archived): delete any thread whose owner has left (orphan) or is
//      already verified (leftover verification thread). Pending owners are left to pass 1.
//   3) NUDGE: ping mods about still-pending OPEN threads (owner unverified, not past the deadline).
//   4) PURGE unverified-chat: delete EVERY thread (any status/owner) in the unverified-chat channel
//      — no threads are allowed there. Gated by PURGE_WARN_CHANNEL_THREADS.
//   5) ROLE CONFLICTS: members holding BOTH the verified and unverified role are ambiguous — the bot
//      takes no destructive action on them and instead flags them to mods to resolve (CONFLICT_PING).
// All actions are gated by DRY_RUN (log only) and the feature toggles. Kick needs STALE_KICK.
// All thread reads are channel-scoped (parentId-filtered) so the bot only ever touches its channels.

const config = require('./config');
const { activeThreads, archivedThreads, allThreads, lastActivity, deleteThread, kickMember } = require('./threads');
const { ensureMembers } = require('./memberCache');
const digest = require('./digest');
const reactresolve = require('./reactresolve');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_LOG = 40; // cap per-item dry-run lines so the journal stays readable
// Gap between a member's warning and their kick — the same 1 day as WARN_DAYS→KICK_DAYS by default.
// Enforced from the warning timestamp so even already-overdue backlog members get a full grace.
const GRACE_MS = Math.max(0, config.kickDays - config.warnDays) * DAY;

// Nudge-worthy only if the applicant has actually submitted a PHOTO in her thread — then she's done her
// part and it's on the mods to review. If the owner never posted an image, the ball is in the USER's court
// (not the mods'), so we don't ping the mods. Returns false on any read error (errs toward not-nudging).
async function ownerSentImage(thread, ownerId) {
  try {
    const msgs = await thread.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs) return false;
    for (const m of msgs.values()) {
      if (m.author.id !== ownerId) continue;
      const hasImg = [...m.attachments.values()].some(a =>
        (a.contentType && a.contentType.startsWith('image/')) ||
        /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test((a.name || a.url || '').split('?')[0]));
      if (hasImg) return true;
    }
    return false;
  } catch { return false; }
}

function register(client, state, ctx) {
  const intervalMs = Math.max(1, config.sweepIntervalMin) * 60 * 1000;
  const run = () => sweep(client, state, ctx).catch(err =>
    console.error(`[sweep] run error: ${err.message}`));
  setTimeout(run, 15 * 1000); // first sweep shortly after boot
  setInterval(run, intervalMs);
  console.log(`[sweep] every ${config.sweepIntervalMin}min (warn=${config.warnDays}d, kick=${config.kickDays}d, doKick=${config.staleKick}, orphans=${config.reapOrphans}, nudge=${config.featureNudge}, conflictPing=${config.conflictPing})`);
}

async function sweep(client, state, ctx) {
  const channel = ctx.getVerifyChannel();
  if (!channel) return;
  const guild = channel.guild;
  const now = Date.now();
  const alertChannel = ctx.getAlertChannel();   // where nudges live; passed to deleteThread so it can
                                                // remove the pending-reminder when its thread is deleted.

  // One bulk fetch — far cheaper on rate limits than per-thread member lookups, and it drives
  // every pass below. Needs the (privileged) GuildMembers intent.
  const members = await ensureMembers(guild);

  // Fetch BOTH open and archived threads — archived (closed-but-not-deleted) threads must be
  // cleaned up too. `active` is used for nudges (only open threads make sense to nudge); `all`
  // (active + archived) drives owner-indexing and thread cleanup.
  // Defensive .parentId filter guarantees we only ever act on THIS channel's threads, even though
  // the channel-bound fetch is already scoped (verified empirically).
  const active = (await activeThreads(channel)).filter(t => t.parentId === channel.id);
  const archived = (await archivedThreads(channel)).filter(t => t.parentId === channel.id);
  const all = active.concat(archived);
  const byOwner = new Map();
  for (const t of all) {
    if (!t.ownerId) continue;
    if (!byOwner.has(t.ownerId)) byOwner.set(t.ownerId, []);
    byOwner.get(t.ownerId).push(t);
  }

  const isVerified = m => m.roles.cache.has(config.verifiedRoleId);
  const isUnverified = m => config.unverifiedRoleId
    ? m.roles.cache.has(config.unverifiedRoleId)
    : !isVerified(m);
  // Conflict = holds BOTH roles. Ambiguous state — the bot takes NO destructive action on these
  // members (no kick, no thread delete); it flags them to mods (Pass 5) to resolve.
  const isConflict = m => config.unverifiedRoleId
    && m.roles.cache.has(config.verifiedRoleId)
    && m.roles.cache.has(config.unverifiedRoleId);

  // ---- PASS 1: reap unverified members (with or without a thread) ----
  // Timing is measured from JOIN: warn at WARN_DAYS, kick at KICK_DAYS. A kick is only performed
  // once a warning has actually been recorded, so a warning always precedes a kick even if the
  // bot was down across the warn window.
  let wouldWarn = 0;
  let wouldKick = 0;
  let warned = 0;
  let kicked = 0;
  let wouldAssign = 0;
  let assigned = 0;
  if (config.featureStale || config.assignUnverified) {
    for (const m of members.values()) {
      if (m.user.bot) continue;
      // Cornered members have their roles stripped (incl. Verified) and stored for restore on
      // release. Skip them entirely: don't backfill Unverified onto them (they'd wrongly show as
      // unverified) and don't reap them (a jailed member isn't an unverified one).
      if (config.cornerRoleId && m.roles.cache.has(config.cornerRoleId)) continue;
      if (isConflict(m)) continue;   // dual-role → leave for mod resolution (Pass 5)
      if (isVerified(m)) continue;
      const st = state.member(m.id);
      const hasUnverified = config.unverifiedRoleId && m.roles.cache.has(config.unverifiedRoleId);

      // Backfill: member has NEITHER role → give them Unverified. Clock starts NOW (unverifiedSince),
      // not their join date, so a long-time member isn't instantly past the kick line.
      if (!hasUnverified) {
        if (!config.assignUnverified || !config.unverifiedRoleId) continue;
        if (config.dryRun) {
          wouldAssign += 1;
          if (wouldAssign <= MAX_LOG) console.log(`[dry-run] ASSIGN: <@${m.id}> (${m.user.tag}) has neither role → would add Unverified`);
        } else {
          try {
            await m.roles.add(config.unverifiedRoleId, 'Backfill: member had neither verified nor unverified');
            state.setMember(m.id, { unverifiedSince: now });
            assigned += 1;
          } catch (err) {
            console.error(`[assign] failed to add Unverified to ${m.id}: ${err.message}`);
          }
        }
        continue; // just tagged - the reap clock for them begins next sweep
      }

      // Has Unverified → reap. Clock = when they became unverified. If there's no stamp yet
      // (unverified before the bot, and no role-change event captured it), reconstruct once:
      // join date if they joined on/after the cutoff, else "now" (fresh grace for older members).
      if (!config.featureStale) continue;
      let unvSince = st.unverifiedSince;
      if (!unvSince) {
        const joined = m.joinedTimestamp || now;
        unvSince = joined >= config.reapJoinCutoffMs ? joined : now;
        // Fresh clock → also clear any stale warnedAt (e.g. a warning from the old join-date logic)
        // so they get a clean warn→kick cycle on the new clock.
        if (!config.dryRun) state.setMember(m.id, { unverifiedSince: unvSince, warnedAt: undefined });
        st.warnedAt = undefined;
      }
      const ageMs = now - unvSince;
      if (ageMs < config.warnDays * DAY) continue; // too new to warn
      const own = byOwner.get(m.id) || [];
      const days = Math.floor(ageMs / DAY);
      const dueKick = ageMs >= config.kickDays * DAY;

      if (config.dryRun) {
        if (dueKick) {
          wouldKick += 1;
          if (wouldKick <= MAX_LOG) console.log(`[dry-run] REAP: <@${m.id}> (${m.user.tag}) unverified ${days}d, threads=${own.length} → would warn then ${config.staleKick ? 'KICK' : 'no-kick'} (after ~${config.kickDays - config.warnDays}d) + delete thread(s)`);
        } else {
          wouldWarn += 1;
          if (wouldWarn <= MAX_LOG) console.log(`[dry-run] WARN: <@${m.id}> (${m.user.tag}) unverified ${days}d → would warn (@mention)`);
        }
      } else if (!st.warnedAt) {
        // First sweep past the warn threshold → warn and record when (never kick unwarned).
        await warnMember(m, own, ctx);
        state.setMember(m.id, { warnedAt: now });
        warned += 1;
      } else if (now - st.warnedAt >= GRACE_MS && dueKick) {
        // Warned at least the grace ago AND past the kick day → kick + delete their thread(s).
        if (await reapMember(guild, m, own, state)) kicked += 1;
      }
    }
    if (config.dryRun && wouldAssign > MAX_LOG) console.log(`[dry-run] ASSIGN: …and ${wouldAssign - MAX_LOG} more with neither role`);
    if (config.dryRun && wouldKick > MAX_LOG) console.log(`[dry-run] REAP: …and ${wouldKick - MAX_LOG} more past ${config.kickDays}d`);
    if (config.dryRun && wouldWarn > MAX_LOG) console.log(`[dry-run] WARN: …and ${wouldWarn - MAX_LOG} more in the ${config.warnDays}–${config.kickDays}d window`);
  }

  // ---- PASS 2: thread cleanup over ALL threads (active + archived) ----
  // Delete any thread — open OR archived — whose owner has LEFT (orphan) or is already VERIFIED
  // (leftover verification thread the trigger didn't catch, e.g. verified before the bot existed).
  // Threads owned by still-pending members are left alone here — Pass 1 handles those members.
  let orphans = 0;
  let verifiedCleaned = 0;
  let realDelLeft = 0;      // actual (non-ghost) deletions, for the daily digest
  let realDelVerified = 0;
  for (const t of all) {
    if (!t.ownerId) continue;
    const owner = members.get(t.ownerId);
    if (owner && isConflict(owner)) continue; // dual-role owner → leave thread for mod resolution
    if (!owner) {
      if (!config.reapOrphans) continue;
      orphans += 1;
      if (config.dryRun) {
        if (orphans <= MAX_LOG) console.log(`[dry-run] ORPHAN: owner ${t.ownerId} left → would DELETE ${t.archived ? 'archived ' : ''}thread "${t.name}"`);
      } else {
        const r = await deleteThread(t, { reason: 'Thread owner left the server', dryRun: false, state, alertChannel });
        if (r.ok) { state.forgetThread(t.id); if (r.real) realDelLeft += 1; }
      }
    } else if (isVerified(owner)) {
      verifiedCleaned += 1;
      if (config.dryRun) {
        if (verifiedCleaned <= MAX_LOG) console.log(`[dry-run] VERIFIED-CLEANUP: <@${t.ownerId}> already verified → would DELETE ${t.archived ? 'archived ' : ''}thread "${t.name}"`);
      } else {
        const r = await deleteThread(t, { reason: 'Owner already verified', dryRun: false, state, alertChannel });
        if (r.ok) { state.forgetThread(t.id); if (r.real) realDelVerified += 1; }
      }
    }
    // else: owner still pending → left for Pass 1's member reap
  }
  if (config.dryRun && orphans > MAX_LOG) console.log(`[dry-run] ORPHAN: …and ${orphans - MAX_LOG} more`);
  if (config.dryRun && verifiedCleaned > MAX_LOG) console.log(`[dry-run] VERIFIED-CLEANUP: …and ${verifiedCleaned - MAX_LOG} more`);

  // ---- PASS 3: nudge mods about still-pending OPEN threads (archived ones aren't nudged) ----
  if (config.featureNudge) {
    const pending = [];
    for (const t of active) {
      const m = members.get(t.ownerId);
      if (!m || isVerified(m) || !isUnverified(m)) continue;
      if (now - (t.createdTimestamp || now) < config.nudgeAfterHours * HOUR) continue;
      const st = state.thread(t.id);
      if (st.nudgeMessageId) continue;   // already have a live reminder for this thread - no duplicates
      // Only nudge the mods once she's actually submitted a photo — otherwise it's on the user, not the mods.
      if (config.nudgeRequireImage && !(await ownerSentImage(t, t.ownerId))) continue;
      pending.push(t);
    }
    let realNudged = 0;
    if (pending.length) {
      if (config.dryRun) console.log(`[dry-run] would nudge mods about ${pending.length} pending thread(s)`);
      else { await postNudge(alertChannel, pending, now, members, state); realNudged = pending.length; }
    }
    if (!config.dryRun) state.bumpDaily('nudged', realNudged);
  }

  // ---- PASS 4: purge ALL threads in the unverified-chat channel (no threads allowed there) ----
  let warnPurged = 0;
  let realPurged = 0;
  const warnCh = ctx.getWarnChannel();
  if (config.purgeWarnThreads && warnCh && warnCh.id !== channel.id && warnCh.threads) {
    const wThreads = await allThreads(warnCh);
    for (const t of wThreads) {
      warnPurged += 1;
      if (config.dryRun) {
        if (warnPurged <= MAX_LOG) console.log(`[dry-run] PURGE #${warnCh.name}: would DELETE ${t.archived ? 'archived ' : ''}thread "${t.name}" (owner ${t.ownerId})`);
      } else {
        const r = await deleteThread(t, { reason: 'No threads allowed in the unverified-chat channel', dryRun: false, state, alertChannel });
        if (r.ok) { state.forgetThread(t.id); if (r.real) realPurged += 1; }
      }
    }
    if (config.dryRun && warnPurged > MAX_LOG) console.log(`[dry-run] PURGE #${warnCh.name}: …and ${warnPurged - MAX_LOG} more`);
  }

  // ---- PASS 5: weekly react-to-resolve message in unverified-chat + resolve conflict-reactors ----
  // (Conflicts are handled here, NOT in the digest.) Post/repost the weekly message, then recheck
  // all its reactors and resolve any who hold both roles.
  let conflictsResolved = 0;
  if (!config.dryRun && config.reactResolveEnabled && config.unverifiedRoleId && warnCh) {
    await reactresolve.ensureWeeklyMessage(state, warnCh);
    conflictsResolved = await reactresolve.resolveAllReactors(state, warnCh, members);
  }
  const conflictMembers = config.unverifiedRoleId
    ? [...members.values()].filter(m => !m.user.bot && isConflict(m))
    : [];
  const conflictsRemaining = conflictMembers.length;
  const conflictCh = ctx.getConflictChannel && ctx.getConflictChannel();

  // ---- PASS 5b: flag dual-role members to mods for MANUAL resolution. Since punishment moved to
  //      the corner, a "both roles" state is now always an error worth flagging. Throttled per
  //      member (CONFLICT_REPING_HOURS); username + ID so the mention always resolves for mods. ----
  if (!config.dryRun && config.conflictPing && conflictCh) {
    let flagged = 0;
    for (const m of conflictMembers) {
      if (flagged >= config.conflictMaxPerSweep) break;
      const st = state.member(m.id);
      if (st.conflictPingedAt && now - st.conflictPingedAt < config.conflictRepingHours * HOUR) continue;
      try {
        await conflictCh.send({
          content: `## ⚠️ Role Conflict\n**${m.user.tag}** (<@${m.id}> · \`${m.id}\`) holds **both** the Verified and Unverified roles. Please resolve.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`conflict_rm:${m.id}:unver`).setLabel('Remove Unverified').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`conflict_rm:${m.id}:ver`).setLabel('Remove Verified').setStyle(ButtonStyle.Secondary),
          )],
          // Mod-only channel the flagged member can't see — the mention is for staff to identify/click
          // through, never an actual ping (they'd never see the notification's source anyway).
          allowedMentions: { parse: [] },
        });
        state.setMember(m.id, { conflictPingedAt: now });
        flagged += 1;
      } catch (err) {
        console.error(`[conflict] flag for ${m.id} failed: ${err.message}`);
      }
    }
    if (flagged) console.log(`[conflict] flagged ${flagged} dual-role member(s) to #${conflictCh.name}`);
  }

  // ---- Accumulate the daily-digest counters (jobs only), then post the digest if it's due ----
  if (!config.dryRun) {
    state.bumpDaily('kicked', kicked);
    state.bumpDaily('warned', warned);
    state.bumpDaily('unverifiedAssigned', assigned);
    state.bumpDaily('delVerified', realDelVerified);
    state.bumpDaily('delLeft', realDelLeft);
    state.bumpDaily('purged', realPurged);
    await digest.maybePost(state, conflictCh);
  }

  console.log(`[sweep] done — ${config.dryRun ? `would-assign:${wouldAssign}, would-kick:${wouldKick}, would-warn:${wouldWarn}` : `assigned:${assigned}, kicked:${kicked}, warned:${warned}, conflicts-resolved:${conflictsResolved}`}, orphans:${orphans}, verified-cleanup:${verifiedCleaned}, unverified-chat-purge:${warnPurged}, conflicts-remaining:${conflictsRemaining} (verify: ${active.length} open + ${archived.length} archived)${config.dryRun ? ' [DRY_RUN]' : ''}`);
}

// Pre-kick warning that @mentions the member. In their thread if they have one, else the
// unverified-chat channel.
async function warnMember(member, ownThreads, ctx) {
  const graceDays = config.kickDays - config.warnDays;
  const consequence = config.staleKick
    ? `you'll be removed (kicked) from the server`
    : `your verification thread will be deleted`;
  // Bold username + raw ID alongside the mention, so it's always readable (and identifiable by
  // mods reading the channel) even if a client can't resolve the mention. The user IS in
  // allowedMentions so the mention resolves and they're notified of the pending kick.
  const text = `## ⏳ Verification Reminder\n`
    + `<@${member.id}> (**${member.user.tag}** · \`${member.id}\`). You still aren't verified. `
    + `If you're not verified within **${graceDays} day${graceDays === 1 ? '' : 's'}**, ${consequence}. `
    + `Please complete verification, or ping a moderator if you need help.`;
  const target = ownThreads.length ? ownThreads[0] : ctx.getWarnChannel();
  if (!target) {
    console.error(`[warn] no channel to warn member ${member.id}`);
    return;
  }
  await target.send({ content: text, allowedMentions: { users: [member.id] } })
    .catch(err => console.error(`[warn] failed for ${member.id}: ${err.message}`));
}

// Live-only: warning grace elapsed and still unverified → kick (if enabled), then delete their
// thread(s). If a required kick fails (e.g. missing permission), we DON'T delete — leaving state
// so it retries and the permission problem stays visible. Returns true if the member was kicked.
async function reapMember(guild, member, ownThreads, state) {
  const reason = `Unverified ${config.kickDays}d after joining`;
  if (config.staleKick) {
    const ok = await kickMember(guild, member.id, reason, { dryRun: false });
    if (!ok) {
      console.error(`[reap] kick failed for ${member.id}; leaving to retry next sweep`);
      return false;
    }
  }
  for (const t of ownThreads) {
    const r = await deleteThread(t, { reason, dryRun: false, state, alertChannel });
    if (r.ok) state.forgetThread(t.id);
  }
  state.forgetMember(member.id);
  return true;
}

// Post ONE reminder per pending thread and remember its message id on the thread's state, so the
// reminder can be deleted (by deleteThread) the moment the thread is resolved + deleted. One live
// reminder per thread (no duplicate spam) — a thread only gets here if it has no nudgeMessageId yet.
async function postNudge(alertChannel, threads, now, members, state) {
  if (!alertChannel) {
    console.error('[nudge] alert channel unavailable');
    return;
  }
  const ping = config.modRoleId ? `<@&${config.modRoleId}> ` : '';
  for (const t of threads.slice(0, 25)) {
    const ageH = Math.floor((now - (t.createdTimestamp || now)) / HOUR);
    const owner = members && members.get(t.ownerId);
    // Username as text — a bare <@id> renders as "unknown-user" for mods (not in allowedMentions).
    const who = owner ? `**${owner.user.tag}**` : `id \`${t.ownerId}\``;
    const body = `${ping}🧵 **Pending verification**: ${t} (owner: ${who}) has submitted a photo and is waiting ~${ageH}h for a mod to review.`;
    const msg = await alertChannel.send({
      content: body,
      allowedMentions: { roles: config.modRoleId ? [config.modRoleId] : [] },
    }).catch(err => { console.error(`[nudge] post failed: ${err.message}`); return null; });
    if (msg && state) state.setThread(t.id, { nudgeMessageId: msg.id });
  }
}

module.exports = { register, runOnce: sweep };
