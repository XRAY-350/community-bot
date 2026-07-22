// reactresolve.js — a weekly "react to fix your role conflict" message in the unverified-chat
// channel. Members holding BOTH the verified and unverified role react; the bot removes their
// Unverified role (→ clean verified). Resolution runs in real-time (on each reaction) AND on the
// hourly sweep (safety net). The message reposts weekly — the old one is deleted so it re-surfaces.

const { EmbedBuilder } = require('discord.js');
const config = require('./config');

function buildPromptEmbed() {
  return new EmbedBuilder()
    .setTitle('⚠️ Role Check — react to fix')
    .setColor(0xfee75c)
    .setDescription(
      `A glitch gave some members **both** the Verified and Unverified role. If you can see this and `
      + `you're already verified, tap ${config.reactEmoji} below — the bot will fix it for you `
      + `automatically. (If you're not verified yet, this doesn't apply to you.)`
    );
}

// True only for members holding BOTH roles.
function isConflict(member) {
  return config.unverifiedRoleId
    && member.roles.cache.has(config.verifiedRoleId)
    && member.roles.cache.has(config.unverifiedRoleId);
}

// Remove the Unverified role from a conflicted member. Returns true if it resolved one.
async function resolveMember(member) {
  if (!isConflict(member)) return false;
  try {
    await member.roles.remove(config.unverifiedRoleId, 'Role conflict resolved via unverified-chat reaction');
    console.log(`[react] resolved ${member.user.tag} (${member.id}) — removed Unverified`);
    return true;
  } catch (err) {
    console.error(`[react] failed to resolve ${member.id}: ${err.message}`);
    return false;
  }
}

// Post this week's message (deleting last week's) if it's due. Adds the react emoji so members can
// one-tap. Stores the current message id + timestamp in state meta.
async function ensureWeeklyMessage(state, channel) {
  if (!channel) return;
  const now = Date.now();
  const lastId = state.getMeta('reactMsgId');
  const lastAt = state.getMeta('reactMsgAt') || 0;
  const due = !lastId || (now - lastAt) >= config.reactRepostDays * 24 * 3600 * 1000;
  if (!due) return;

  let msg;
  try {
    msg = await channel.send({
      content: config.reactPingRole && config.unverifiedRoleId ? `<@&${config.unverifiedRoleId}>` : null,
      embeds: [buildPromptEmbed()],
      allowedMentions: { roles: config.reactPingRole && config.unverifiedRoleId ? [config.unverifiedRoleId] : [] },
    });
    await msg.react(config.reactEmoji).catch(err => console.error(`[react] add emoji failed: ${err.message}`));
  } catch (err) {
    console.error(`[react] failed to post weekly message: ${err.message}`);
    return;
  }
  if (lastId) {
    try { const old = await channel.messages.fetch(lastId); await old.delete(); } catch { /* already gone */ }
  }
  state.setMeta('reactMsgId', msg.id);
  state.setMeta('reactMsgAt', now);
  console.log(`[react] posted weekly react-to-resolve message ${msg.id} (removed old ${lastId || 'none'})`);
}

// Hourly safety net: recheck EVERY reactor on the current message and resolve conflicts (catches
// reactions added while the bot was down, or missed events). Returns count resolved.
async function resolveAllReactors(state, channel, members) {
  const id = state.getMeta('reactMsgId');
  if (!id || !channel) return 0;
  let msg;
  try { msg = await channel.messages.fetch(id); } catch { return 0; }

  const ids = new Set();
  for (const reaction of msg.reactions.cache.values()) {
    let after;
    for (let i = 0; i < 30; i++) {
      const users = await reaction.users.fetch({ limit: 100, after });
      if (!users.size) break;
      for (const u of users.values()) if (!u.bot) ids.add(u.id);
      after = users.last().id;
      if (users.size < 100) break;
    }
  }
  let resolved = 0;
  for (const uid of ids) {
    const m = members.get(uid);
    if (m && await resolveMember(m)) resolved += 1;
  }
  return resolved;
}

module.exports = { ensureWeeklyMessage, resolveAllReactors, resolveMember, isConflict, buildPromptEmbed };
