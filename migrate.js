// migrate.js — copy (or move) a window of recent messages from one channel to another, reposted under
// each original author's name/avatar via a dedicated webhook, oldest-first so the conversation reads in
// order. The webhook is self-authorized with raidguard the moment it's created — raidguard blocks every
// webhook message server-wide by default (2026-08-12 incident response) unless its id is explicitly
// authorized, and this IS the sanctioned path for it (see index.js's messageCreate raidguard comment:
// "FUBU's legitimate 'History Migration' webhook just needs (and has) its own explicit authorization").
const raidguard = require('./raidguard');
const botdeletes = require('./botdeletes');

const WEBHOOK_NAME = 'Message Migration';

// Reuses an existing "Message Migration" webhook in the destination channel if one's already there
// (repeat runs don't pile up webhooks), else creates one and authorizes it immediately — before anything
// is ever sent through it, so raidguard never blocks/alerts on our own migration traffic.
async function ensureWebhook(guild, channel) {
  const existing = await channel.fetchWebhooks().catch(() => null);
  let hook = existing?.find(w => w.name === WEBHOOK_NAME && w.owner?.id === guild.client.user.id);
  if (!hook) {
    hook = await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Message migration tool' }).catch(() => null);
    if (!hook) return null;
  }
  raidguard.authorize(guild.id, hook.id);
  return hook;
}

// Pull every message in `channel` newer than `sinceMs` (a real Date.now() cutoff, not a duration), oldest
// first. Paginates backward with fetch({limit:100, before}) until a page's oldest message crosses the
// cutoff or the channel runs out of history.
async function fetchWindow(channel, sinceMs) {
  const out = [];
  let before;
  for (let page = 0; page < 50; page++) {   // safety cap (~5000 msgs) against a runaway loop
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    const arr = [...batch.values()];
    let hitCutoff = false;
    for (const m of arr) {
      if (m.createdTimestamp < sinceMs) { hitCutoff = true; continue; }
      out.push(m);
    }
    before = arr[arr.length - 1].id;
    if (hitCutoff || arr[arr.length - 1].createdTimestamp < sinceMs) break;
  }
  return out.reverse();   // oldest first
}

// Core migration. sinceMs = absolute lower-bound cutoff (Date.now() - windowMs for a duration, or a
// specific message's own createdTimestamp for "from this message onward" — see index.js). untilMs
// (optional) = absolute upper bound, inclusive — another specific message's timestamp, for "from this
// message THROUGH this message" instead of all the way to now.
// deleteOriginals: after a message is successfully reposted, delete it from the source channel too.
// Returns { ok, migrated, deleted, skipped, failed, total }.
async function migrate(guild, fromChannel, toChannel, sinceMs, { deleteOriginals = false, untilMs = null } = {}) {
  const hook = await ensureWebhook(guild, toChannel);
  if (!hook) return { ok: false, error: 'Could not create/find a webhook in the destination channel — I need Manage Webhooks there.' };
  let messages = await fetchWindow(fromChannel, sinceMs);
  if (untilMs != null) messages = messages.filter(m => m.createdTimestamp <= untilMs);
  let migrated = 0, deleted = 0, skipped = 0, failed = 0;
  for (const m of messages) {
    // Skip pure system notices (member join, boost, pin-added, ...) and our own migration webhook's past
    // posts (repeat/overlapping runs shouldn't re-migrate what this tool itself already reposted).
    if (m.system || m.webhookId === hook.id) { skipped++; continue; }
    if (!m.content && !m.attachments.size) { skipped++; continue; }   // nothing to carry over
    const ts = Math.floor(m.createdTimestamp / 1000);
    const content = [m.content, `-# <t:${ts}:f> in #${fromChannel.name}`].filter(Boolean).join('\n').slice(0, 2000);
    try {
      await hook.send({
        content, username: (m.member?.displayName || m.author.username).slice(0, 80),
        avatarURL: m.author.displayAvatarURL({ size: 128 }),
        files: [...m.attachments.values()].map(a => a.url).slice(0, 10),
        allowedMentions: { parse: [] },
      });
      migrated++;
      // botdeletes.mark BEFORE the delete (audit A18): these are bot-side cleanup deletes, not human
      // moderation — without the mark, a 200-message migration flooded #deletion-log with re-uploads.
      if (deleteOriginals) { botdeletes.mark(m.id); const ok = await m.delete().then(() => true).catch(() => false); if (ok) deleted++; }
    } catch (e) { console.error(`[migrate] send failed for ${m.id}: ${e.message}`); failed++; }
    await new Promise(r => setTimeout(r, 700));   // stay well under webhook rate limits
  }
  return { ok: true, migrated, deleted, skipped, failed, total: messages.length };
}

module.exports = { migrate, ensureWebhook, fetchWindow };
