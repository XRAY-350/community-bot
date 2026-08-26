// verify.js — the core trigger. When a moderator assigns the Verified role to a member,
// archive+lock the verification thread(s) that member opened. The bot never grants the role
// or judges verification; it only reacts to the role a human already assigned.

const config = require('./config');
const { memberThreads, deleteThread } = require('./threads');
const { cleanupWarnMsg } = require('./sweep');

// Wire the guildMemberUpdate handler. `state` gives us idempotency across restarts and
// partial-member gaps; `getChannel` returns the (cached) verify channel.
function register(client, state, getChannel) {
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      if (newMember.guild.id !== config.guildId) return;
      // Cornered members are corner.js's territory (audit A9, 2026-08-26) — same guard index.js's own
      // guildMemberUpdate uses. The corner strips Verified and the release restores it; without this
      // guard that restore looked like a fresh verification and REPLAYED onVerified, deleting any open
      // verification thread the member had (and the strip spuriously unmarked them as processed).
      if (state.getCornered && state.getCornered(newMember.id)) return;

      const hasRole = newMember.roles.cache.has(config.verifiedRoleId);

      // Role removed (or absent): clear the processed mark so a future re-grant re-triggers.
      if (!hasRole) {
        state.unmarkProcessed(newMember.id);
        return;
      }

      // Has the role now. Was this a *new* grant? If oldMember is complete we can tell directly;
      // if it's partial (not cached) we fall back to the processed-set so we don't act twice.
      const hadRoleBefore = oldMember && !oldMember.partial
        ? oldMember.roles.cache.has(config.verifiedRoleId)
        : state.isProcessed(newMember.id); // unknown → treat "already processed" as "had it"

      if (hadRoleBefore) return;             // no change we care about
      if (state.isProcessed(newMember.id)) return; // already handled this grant

      state.markProcessed(newMember.id);
      await onVerified(newMember, state, getChannel);
    } catch (err) {
      console.error(`[verify] guildMemberUpdate error: ${err.message}`);
    }
  });
}

async function onVerified(member, state, getChannel) {
  const channel = getChannel();
  if (!channel) {
    console.error('[verify] verify channel unavailable; cannot close threads');
    return;
  }

  const threads = await memberThreads(channel, member.id);
  if (threads.length === 0) {
    console.log(`[verify] ${member.user.tag} (${member.id}) verified — no verification thread found to close`);
    return;
  }

  // The pending-verification reminder (nudge) for this thread lives in the alert channel — pass `state`
  // + `alertChannel` so deleteThread's cleanupNudge() actually removes it (and forgets the thread's
  // state itself). The old code passed NEITHER and then force-forgot the state here, which dropped the
  // reminder's message id BEFORE it could be deleted — orphaning the ping on a now-gone thread.
  const alertChannel = config.alertChannelId
    ? await member.guild.channels.fetch(config.alertChannelId).catch(() => null)
    : null;
  for (const thread of threads) {
    await deleteThread(thread, {
      reason: `Owner ${member.user.tag} received the Verified role`,
      dryRun: config.dryRun,
      state,
      alertChannel,
    });
    if (config.dryRun) state.forgetThread(thread.id); // live path: deleteThread already forgot it post-cleanup
  }
  // A member who never opened a thread could still have a standalone "Verification Reminder" ping sitting
  // in the unverified-chat channel (warnMember posts there when there's no thread to attach to) — clean it
  // up now that they're verified, same as reapMember does on kick.
  if (!config.dryRun) await cleanupWarnMsg(member.guild, member, state);
  console.log(`[verify] ${member.user.tag} verified — ${config.dryRun ? 'would delete' : 'deleted'} ${threads.length} thread(s)`);
}

module.exports = { register };
