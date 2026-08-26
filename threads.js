// threads.js — shared helpers for locating and closing verification threads.
// "Close" = archive + lock (reversible; keeps history). Never deletes.

const { SnowflakeUtil } = require('discord.js');
const config = require('./config');

// All threads in the verify channel owned (created) by a given member — active + archived
// (public AND private, via allThreads), matched by thread.ownerId. This is how the verified→delete
// trigger finds the thread THEY opened, even if it has since auto-archived (as a private thread).
async function memberThreads(channel, userId) {
  const all = await allThreads(channel); // includes private archived (fetchAll:true)
  return all.filter(t => t.ownerId === userId);
}

// Active (open) threads in the verify channel.
async function activeThreads(channel) {
  try {
    const active = await channel.threads.fetchActive();
    return [...active.threads.values()];
  } catch (err) {
    console.error(`[threads] fetchActive failed: ${err.message}`);
    return [];
  }
}

// All ARCHIVED (closed-but-not-deleted) threads — BOTH public and private — paginated.
// CRITICAL: for private threads we MUST pass fetchAll:true, or discord.js hits the "@me/joined"
// endpoint and returns only threads the bot has joined (0 for us). fetchAll:true uses the
// Manage-Threads endpoint that returns EVERY private archived thread. Verification threads are
// private, so without this the sweep sees none of them.
async function archivedThreads(channel) {
  const out = [];
  for (const type of ['public', 'private']) {
    let before;
    try {
      for (let i = 0; i < 50; i++) { // safety cap (~5000 per type) against a runaway loop
        const opts = type === 'private'
          ? { type, fetchAll: true, limit: 100, before }
          : { type, limit: 100, before };
        const page = await channel.threads.fetchArchived(opts);
        const arr = [...page.threads.values()];
        if (arr.length === 0) break;
        out.push(...arr);
        const oldest = arr.reduce((a, b) => (a.archivedTimestamp ?? 0) <= (b.archivedTimestamp ?? 0) ? a : b);
        if (!page.hasMore || !oldest.archivedTimestamp) break;
        before = new Date(oldest.archivedTimestamp);
      }
    } catch (err) {
      console.error(`[threads] fetchArchived(${type}) failed: ${err.message}`);
    }
  }
  return out;
}

// Every thread in a channel — active + archived (public + private), scoped to the channel.
async function allThreads(channel) {
  const active = await activeThreads(channel);
  const archived = await archivedThreads(channel);
  return active.concat(archived).filter(t => t.parentId === channel.id); // defensive scoping
}

// Timestamp (ms) of the last activity in a thread, derived from the last message's snowflake id
// (which encodes its creation time) — no API call, which keeps sweeps well under rate limits.
// Falls back to the thread's own creation time when it has no messages.
function lastActivity(thread) {
  if (thread.lastMessageId) {
    try { return SnowflakeUtil.timestampFrom(thread.lastMessageId); } catch (err) { /* fall through */ }
  }
  return thread.createdTimestamp || Date.now();
}

// Delete a thread outright. IRREVERSIBLE — history is lost. Requires Manage Threads.
// Returns true only if it actually deleted (false on dry-run or error).
// Returns { ok, real }: ok = the thread is gone (caller should forget it); real = we actually
// deleted it THIS call (vs it was already gone). `real` is what the digest counts, so re-processing
// eventually-consistent ghosts doesn't inflate the daily totals.
async function deleteThread(thread, { reason, dryRun, state, alertChannel }) {
  // Owner-protected threads (config.protectedThreadIds) are never auto-deleted — a persistent verify
  // thread kept as a reference (owner, 2026-08-23). Skip before any dry-run/real delete.
  if ((config.protectedThreadIds || []).includes(thread.id)) {
    console.log(`[delete] SKIP protected thread ${thread.id} "${thread.name}" — ${reason}`);
    return { ok: false, real: false, protected: true };
  }
  if (dryRun) {
    console.log(`[dry-run] would DELETE thread ${thread.id} "${thread.name}" — ${reason}`);
    return { ok: false, real: false };
  }
  // The thread is being removed → remove the pending-verification reminder we posted for it (if any)
  // and forget its state. Runs on real deletes AND on 10003 (already-gone) so reminders never linger.
  const cleanupNudge = async () => {
    if (!state) return;
    const nid = state.thread(thread.id).nudgeMessageId;
    if (nid && alertChannel) await alertChannel.messages.delete(nid).catch(() => {});
    state.forgetThread(thread.id);
  };
  try {
    await thread.delete(reason);
    console.log(`[delete] deleted thread ${thread.id} "${thread.name}" — ${reason}`);
    await cleanupNudge();
    return { ok: true, real: true };
  } catch (err) {
    // 10003 Unknown Channel = already deleted (Discord's archived list is eventually-consistent
    // and re-lists gone threads for a while). Gone, but not a real new deletion.
    if (err.code === 10003) { await cleanupNudge(); return { ok: true, real: false }; }
    console.error(`[delete] failed on thread ${thread.id}: ${err.message}`);
    return { ok: false, real: false };
  }
}

// Kick a member from the guild. IRREVERSIBLE removal (they can only return via a new invite).
// Requires the Kick Members permission and the bot's role ranked above the target's roles.
// Returns true only if the kick actually happened, so the caller can gate the thread delete on it.
async function kickMember(guild, userId, reason, { dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] would KICK member ${userId} — ${reason}`);
    return false;
  }
  try {
    const member = await guild.members.fetch(userId);
    await member.kick(reason);
    console.log(`[kick] kicked ${member.user.tag} (${userId}) — ${reason}`);
    return true;
  } catch (err) {
    console.error(`[kick] failed on member ${userId}: ${err.message}`);
    return false;
  }
}

// Snapshot a thread's messages (oldest→newest) into a compact array — used to preserve an appeal's whole
// discussion in the bot's OWN state at decision time, so the record survives even if the thread is later
// deleted (a mod deleted a decided appeal thread once, 2026-08-01). Captures text + a flattened form of any
// embeds. Capped so a runaway thread can't bloat the state file.
async function snapshotTranscript(thread, cap = 200) {
  if (!thread || !thread.messages) return [];
  const out = [];
  let before;
  for (let p = 0; p < 3 && out.length < cap; p++) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    for (const m of batch.values()) out.push({
      ts: m.createdTimestamp, authorId: m.author?.id, authorTag: m.author?.tag,
      content: (m.content || '').slice(0, 2000),
      embeds: (m.embeds || []).map(e => `${e.title || ''}${e.description ? ' — ' + e.description.slice(0, 500) : ''}${(e.fields || []).map(f => `\n${f.name}: ${f.value}`).join('')}`.trim()).filter(Boolean),
    });
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

module.exports = { memberThreads, activeThreads, archivedThreads, allThreads, lastActivity, deleteThread, kickMember, snapshotTranscript };
