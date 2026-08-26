// raidguard.js — active raid prevention, built directly from a real incident (2026-08-12, Melanin): a
// bot/webhook got posting rights with NO audit-log trail we could ever find, an over-permissioned bot sat
// unnoticed for a day, and a message flood ran for ~20 minutes before anyone could react by hand. This
// module closes those three specific gaps instead of being generic "security theater":
//   1. Integration/webhook watchdog — alert the SECOND a new bot or webhook shows up, don't wait for
//      someone to stumble onto it hours/days later.
//   2. Dangerous-permission alarm — alert when any channel overwrite newly grants ManageRoles/
//      ManageWebhooks/Administrator/etc. to a role or member, whether or not it's malicious (an honest
//      misconfiguration like the TTS Bot incident is worth catching too).
//   3. Message-flood auto-quarantine — the same author (a real member OR a webhook) posting faster than a
//      human can type gets shut down on sight, not after a mod notices and reacts.
// Join-spike detection already exists (freshwatch.js's influx warning) — deliberately not duplicated here.
const { PermissionsBitField, AuditLogEvent, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const fs = require('fs');
const { statePath } = require('./statepath');
const config = require('./config');
const permguard = require('./permguard');

const FILE = process.env.FUBU_RAIDGUARD_FILE || statePath('raidguard.json');
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { knownWebhookIds: {}, authorizedWebhookIds: {} }; } }
function save(s) { try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[raidguard] save:', e.message); } }

// ---- 0) webhook allowlist -----------------------------------------------------------------------
// Every webhook message is blocked UNLESS its webhook id is on this per-guild allowlist (owner,
// 2026-08-12, following the incident: "block all messages from webhooks unless authorized through the
// bot"). Authorizing happens via the ✅ button on the watchdog alert below — deliberately no way to
// pre-authorize a webhook that hasn't posted/been seen yet, so there's always a real alert + a real
// decision on record, not a silently-growing exception list.
function isAuthorized(guildId, webhookId) {
  const s = load();
  return !!(s.authorizedWebhookIds && s.authorizedWebhookIds[guildId] && s.authorizedWebhookIds[guildId].includes(webhookId));
}
function authorize(guildId, webhookId) {
  const s = load();
  s.authorizedWebhookIds = s.authorizedWebhookIds || {};
  s.authorizedWebhookIds[guildId] = s.authorizedWebhookIds[guildId] || [];
  if (!s.authorizedWebhookIds[guildId].includes(webhookId)) s.authorizedWebhookIds[guildId].push(webhookId);
  save(s);
}
function revoke(guildId, webhookId) {
  const s = load();
  if (s.authorizedWebhookIds && s.authorizedWebhookIds[guildId]) s.authorizedWebhookIds[guildId] = s.authorizedWebhookIds[guildId].filter(id => id !== webhookId);
  save(s);
}

const P = PermissionsBitField.Flags;
const DANGEROUS_PERMS = [
  ['Administrator', P.Administrator], ['ManageGuild', P.ManageGuild], ['ManageRoles', P.ManageRoles],
  ['ManageWebhooks', P.ManageWebhooks], ['BanMembers', P.BanMembers], ['KickMembers', P.KickMembers],
  ['ManageChannels', P.ManageChannels],
];

async function alertMods(guild, content, components = []) {
  if (!config.modAnnounceChannelId) return;
  const ch = await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return;
  await ch.send({ content: `${config.modRoleId ? `<@&${config.modRoleId}> ` : ''}${content}`, components, allowedMentions: { roles: config.modRoleId ? [config.modRoleId] : [] } }).catch(() => {});
}

// Best-effort: the role's category label from the role-category manifest (empty until that system is
// seeded). Read fresh each call — this alarm fires rarely, so no caching needed.
function roleCategoryLabel(roleId) {
  try {
    const m = JSON.parse(fs.readFileSync(process.env.FUBU_ROLECAT_FILE || statePath('role_categories.json'), 'utf8'));
    const key = m.roles && m.roles[roleId];
    return key ? ((m.labels && m.labels[key]) || key) : '';
  } catch { return ''; }
}

// The audit log lags the gateway event by up to a couple seconds, so a single immediate fetch routinely
// misses the entry — leaving executorId unknown, which is exactly why the bot's OWN permission work used to
// slip past the exemption and cry wolf (the "90 alerts in one pass" incident). Retry a few times before
// deciding. Returns the newest matching audit entry for targetId, or null if none appears.
// TYPE-FILTERED, bigger page (audit A3): the old unfiltered limit:8 page was trivially displaced during
// the bot's own bulk permission passes (syncModManageChannels edits 100+ overwrites in a row), so the
// matching entry was never on the page, the executor stayed unknown, and the alert fell through as
// "unknown actor" — the mechanism behind the historical 90-alerts-in-one-pass incident. Filtering by the
// FIRST action type server-side keeps the page relevant no matter how noisy the log is; remaining action
// types (callers pass at most two) are checked client-side against the same filtered page plus, if needed,
// their own filtered fetch.
async function resolveAuditEntry(guild, actions, targetId, { tries = 4, delayMs = 800 } = {}) {
  for (let i = 0; i < tries; i++) {
    for (const type of actions) {
      const page = await guild.fetchAuditLogs({ type, limit: 25 }).catch(() => null);
      const matches = page ? [...page.entries.values()]
        .filter(e => e.target?.id === targetId)
        .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1) : [];
      if (matches.length) return matches[matches.length - 1];
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

// A dangerous permission grant made by the bot itself or a trusted owner is never a raid signal — the bot's
// grant is this codebase's own deliberate permission work; an owner's is a deliberate decision on record.
async function isSelfOrOwnerEdit(guild, executorId) {
  if (!executorId) return false;
  if (executorId === guild.client.user.id) return true;
  return await permguard.isTrustedOwner(guild, executorId).catch(() => false);
}

// A Discord snowflake encodes its own creation time — decode it to flag freshly-registered bot accounts
// (a strong raid-tool signal, though not proof on its own: TTS Bot in the real incident was legitimate and
// 7+ years old, while the actual raid tools were weeks-to-days old).
function snowflakeAgeDays(id) {
  try {
    const ms = (BigInt(id) >> 22n) + 1420070400000n;
    return Math.floor((Date.now() - Number(ms)) / 86400000);
  } catch { return null; }
}

// Fires the SAME alert as onWebhooksUpdate, but directly from the point a message actually gets
// blocked — using the webhook id straight off the message, not a live re-fetch of the channel's webhook
// list. Owner-reported (2026-08-13): a webhook that's created, used once, and deleted immediately (a
// common "fire and forget" integration pattern, not just malicious use) never showed up in
// onWebhooksUpdate's diff by the time it re-fetched — the message still got blocked correctly, but no
// alert ever fired, so there was nothing to click Authorize on. This is now the primary alert path;
// onWebhooksUpdate stays as a backstop for webhooks that stick around. Deduped per webhook id for 10
// minutes so a flood doesn't spam mod-announce once per message.
const _blockedAlertedAt = new Map(); // webhookId -> timestamp
const BLOCKED_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
async function alertBlockedWebhookMessage(guild, msg) {
  try {
    const webhookId = msg.webhookId;
    const last = _blockedAlertedAt.get(webhookId) || 0;
    if (Date.now() - last < BLOCKED_ALERT_COOLDOWN_MS) return;
    _blockedAlertedAt.set(webhookId, Date.now());
    const ageDays = snowflakeAgeDays(webhookId);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`raidguard_authwh:${webhookId}`).setEmoji('✅').setLabel('Authorize (legit)').setStyle(ButtonStyle.Success));
    await alertMods(guild, `🪝 **Blocked a webhook message**: \`${msg.author.username}\` in <#${msg.channelId}> (webhook \`${webhookId}\`, not on the allowlist).`
      + (ageDays !== null && ageDays > 0 ? ` Underlying app account is **${ageDays}d old**${ageDays < 30 ? ' ⚠️ (young — worth a look)' : ''}.` : '')
      + ' If this is a real integration (e.g. a bot bridge that creates/deletes its own webhook per message), click Authorize below.', [row]);
  } catch (e) { console.error('[raidguard] alertBlockedWebhookMessage:', e.message); }
}

// ---- 1) integration/webhook watchdog --------------------------------------------------------------
// webhooksUpdate fires the moment ANY webhook in a channel is created/updated/deleted — a live gateway
// event, not a poll, so this reacts in seconds. Diffs against the last-known webhook set for that channel.
async function onWebhooksUpdate(channel) {
  try {
    const guild = channel.guild;
    const current = await channel.fetchWebhooks().catch(() => null);
    if (!current) return;
    const s = load();
    s.knownWebhookIds = s.knownWebhookIds || {};
    const prevIds = new Set(s.knownWebhookIds[channel.id] || []);
    const nowIds = [...current.keys()];
    const added = current.filter(w => !prevIds.has(w.id));
    s.knownWebhookIds[channel.id] = nowIds;
    save(s);
    for (const wh of added.values()) {
      const ageDays = snowflakeAgeDays(wh.id);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raidguard_authwh:${wh.id}`).setEmoji('✅').setLabel('Authorize (legit)').setStyle(ButtonStyle.Success));
      await alertMods(guild, `🪝 **New webhook created**: \`${wh.name}\` in <#${channel.id}>${wh.owner ? ` by ${wh.owner.tag}` : ''}.`
        + (ageDays !== null && ageDays > 0 ? ` Underlying app account is **${ageDays}d old**${ageDays < 30 ? ' ⚠️ (young — worth a look)' : ''}.` : '')
        + ' **Its messages are blocked by default** — click Authorize below if this is legitimate.', [row]);
    }
  } catch (e) { console.error('[raidguard] onWebhooksUpdate:', e.message); }
}

// guildIntegrationsUpdate fires when a bot/app integration is added or removed, but carries no detail —
// immediately re-poll the audit log's most recent INTEGRATION_CREATE entries to get who/what.
let _lastIntegrationAuditId = null;
async function onGuildIntegrationsUpdate(guild) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.IntegrationCreate }).catch(() => null);
    if (!logs) return;
    const entries = [...logs.entries.values()].filter(e => !_lastIntegrationAuditId || BigInt(e.id) > BigInt(_lastIntegrationAuditId));
    if (!entries.length) return;
    _lastIntegrationAuditId = [...logs.entries.keys()][0]; // newest first
    for (const e of entries.reverse()) {
      const name = (e.changes || []).find(c => c.key === 'name')?.new || 'unknown';
      const targetId = e.target?.id || e.targetId;
      const ageDays = targetId ? snowflakeAgeDays(targetId) : null;
      await alertMods(guild, `🤖 **New bot/integration added**: \`${name}\` — by ${e.executor ? `<@${e.executor.id}>` : 'unknown'}.`
        + (ageDays !== null ? ` Bot's own account is **${ageDays}d old**${ageDays < 30 ? ' ⚠️ (young — worth a look)' : ''}.` : '')
        + ' Check its granted permissions before leaving it be.');
    }
  } catch (e) { console.error('[raidguard] onGuildIntegrationsUpdate:', e.message); }
}

// ---- 2) dangerous-permission alarm -----------------------------------------------------------------
// channelUpdate gives before/after PermissionOverwriteManager caches — diff each overwrite's `allow`
// bitfield; if a dangerous permission is newly present that wasn't before (on either the old overwrite or
// a brand-new one), flag it. Never auto-reverts — a false positive shouldn't break a legitimate setup.
async function onChannelUpdate(oldChannel, newChannel) {
  try {
    if (!newChannel.permissionOverwrites) return;
    const guild = newChannel.guild;
    const flagged = [];
    for (const [id, newOw] of newChannel.permissionOverwrites.cache) {
      const oldOw = oldChannel.permissionOverwrites?.cache?.get(id);
      const oldAllow = oldOw ? oldOw.allow.bitfield : 0n;
      const newAllow = newOw.allow.bitfield;
      const newlyGranted = DANGEROUS_PERMS.filter(([, bit]) => (newAllow & bit) && !(oldAllow & bit));
      if (newlyGranted.length) flagged.push({ id, type: newOw.type, newlyGranted });
    }
    if (!flagged.length) return;
    // Who actually made this change? Retry the audit lookup so the bot's own work (and trusted-owner edits)
    // reliably resolve and get suppressed — the single immediate fetch this used to do raced the audit log
    // and let the bot alarm on itself (90 alerts in one pass, 2026-08-21). If it truly can't be resolved,
    // fall through and alert anyway — a false positive is far cheaper than silently swallowing a real one.
    const entry = await resolveAuditEntry(guild,
      [AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate], newChannel.id);
    if (await isSelfOrOwnerEdit(guild, entry?.executorId)) return;
    const by = entry?.executorId ? ` — granted by <@${entry.executorId}>` : '';
    for (const { id, type, newlyGranted } of flagged) {
      const cat = type === 0 ? roleCategoryLabel(id) : '';
      const subject = type === 0
        ? (guild.roles.cache.get(id)?.name ? `role **${guild.roles.cache.get(id).name}**` : `role \`${id}\``) + (cat ? ` (category: ${cat})` : '')
        : `<@${id}>`;
      await alertMods(guild, `⚠️ **Dangerous permission granted** in <#${newChannel.id}> to ${subject}: `
        + `**${newlyGranted.map(([n]) => n).join(', ')}**${by}. If this wasn't intentional, remove it and check who has channel-manage access there.`);
    }
  } catch (e) { console.error('[raidguard] onChannelUpdate:', e.message); }
}

// ---- 2b) dangerous ROLE base-permission alarm ------------------------------------------------------
// The channelUpdate alarm above only catches per-channel overwrites. This catches a role's OWN base
// permissions changing server-wide — e.g. a role directly granted Administrator/Manage Roles. Same
// diff-against-DANGEROUS_PERMS logic, same bot/owner suppression, and it names who granted it + the role's
// category (from the role-category manifest, when seeded).
async function onRoleUpdate(oldRole, newRole) {
  try {
    if (!oldRole?.permissions || !newRole?.permissions) return;
    const oldBits = oldRole.permissions.bitfield, newBits = newRole.permissions.bitfield;
    const newlyGranted = DANGEROUS_PERMS.filter(([, bit]) => (newBits & bit) && !(oldBits & bit));
    if (!newlyGranted.length) return;
    const guild = newRole.guild;
    const entry = await resolveAuditEntry(guild, [AuditLogEvent.RoleUpdate], newRole.id);
    if (await isSelfOrOwnerEdit(guild, entry?.executorId)) return;
    const by = entry?.executorId ? ` — granted by <@${entry.executorId}>` : '';
    const cat = roleCategoryLabel(newRole.id);
    await alertMods(guild, `⚠️ **Dangerous permission granted** to role **${newRole.name}**${cat ? ` (category: ${cat})` : ''}: `
      + `**${newlyGranted.map(([n]) => n).join(', ')}**${by}. If this wasn't intentional, remove it — a role with this can bypass channel restrictions server-wide.`);
  } catch (e) { console.error('[raidguard] onRoleUpdate:', e.message); }
}

// ---- 3) message-flood auto-quarantine --------------------------------------------------------------
const FLOOD_WINDOW_MS = Number(process.env.FUBU_RAIDGUARD_FLOOD_WINDOW_MS) || 4000;
const FLOOD_THRESHOLD = Number(process.env.FUBU_RAIDGUARD_FLOOD_THRESHOLD) || 6; // messages within the window
const TIMEOUT_MS = 5 * 60 * 1000; // 5 min — long enough to break an automated burst, short enough not to need staff to undo it
const _recent = new Map(); // authorId -> timestamps[]
const _lastAlert = new Map(); // authorId -> ts, so a multi-minute burst pings mods once, not every message
// Eviction sweep (audit N14): entries were only ever pruned for authors who POSTED AGAIN — a busy day's
// one-time posters accumulated forever. Hourly sweep drops anything stale; .unref() keeps shutdown clean.
setInterval(() => {
  const now = Date.now();
  for (const [id, arr] of _recent) { const live = arr.filter(t => now - t < 60000); if (live.length) _recent.set(id, live); else _recent.delete(id); }
  for (const [id, ts] of _lastAlert) if (now - ts > 3600000) _lastAlert.delete(id);
}, 3600000).unref();

// Returns true for the message that CROSSES the threshold (caller should delete that message and call
// quarantine() once). Suppresses repeat "crossed" results for the same author within the timeout window,
// so a burst that keeps going doesn't re-flag on every single message.
function checkFlood(authorId) {
  const now = Date.now();
  const arr = (_recent.get(authorId) || []).filter(t => now - t < FLOOD_WINDOW_MS);
  arr.push(now);
  _recent.set(authorId, arr);
  if (arr.length < FLOOD_THRESHOLD) return false;
  const last = _lastAlert.get(authorId) || 0;
  if (now - last < TIMEOUT_MS) return false;
  _lastAlert.set(authorId, now);
  return true;
}

// Called once per author the FIRST time they cross the threshold in a burst (caller should gate repeat
// calls so a real member isn't re-timed-out every single message while already in timeout).
async function quarantine(guild, msg) {
  try {
    if (msg.webhookId) {
      // A webhook has no "member" to timeout — the caller is expected to also delete the webhook itself
      // (or rely on the Melanin blanket webhook-block, which already deletes every webhook message there).
      await alertMods(guild, `🌊 **Message flood** from webhook \`${msg.author.username}\` in <#${msg.channelId}> — ${FLOOD_THRESHOLD}+ messages in ${FLOOD_WINDOW_MS / 1000}s.`);
      return;
    }
    const member = msg.member || await guild.members.fetch(msg.author.id).catch(() => null);
    if (member && member.moderatable) await member.timeout(TIMEOUT_MS, 'raidguard: message flood auto-quarantine').catch(() => {});
    await alertMods(guild, `🌊 **Message flood** from <@${msg.author.id}> in <#${msg.channelId}> — ${FLOOD_THRESHOLD}+ messages in ${FLOOD_WINDOW_MS / 1000}s.`
      + (member?.moderatable ? ` Timed out for ${TIMEOUT_MS / 60000} min.` : ' Could not time out (role hierarchy?) — needs a manual look.'));
  } catch (e) { console.error('[raidguard] quarantine:', e.message); }
}

function register(client) {
  client.on('webhooksUpdate', ch => onWebhooksUpdate(ch));
  client.on('guildIntegrationsUpdate', g => onGuildIntegrationsUpdate(g));
  client.on('channelUpdate', (o, n) => onChannelUpdate(o, n));
  client.on('roleUpdate', (o, n) => onRoleUpdate(o, n));
  console.log('[raidguard] webhook/integration watchdog + permission alarm (channel + role) + flood detection armed');
}

const BTN_PREFIX = 'raidguard_authwh:';
function isAuthorizeButton(interaction) { return interaction.isButton?.() && interaction.customId?.startsWith(BTN_PREFIX); }
// Mod-gated (same tier as verify) — one click on the watchdog alert allowlists that exact webhook id for
// this guild going forward. No bulk/wildcard authorize by design: each webhook gets its own conscious decision.
async function handleAuthorizeButton(interaction) {
  const roles = interaction.member?.roles?.cache;
  const canAuth = (config.modRoleId && roles?.has(config.modRoleId)) || interaction.memberPermissions?.has(P.Administrator);
  if (!canAuth) return interaction.reply({ content: 'Only staff (mods+) can authorize a webhook.', flags: MessageFlags.Ephemeral });
  const webhookId = interaction.customId.slice(BTN_PREFIX.length);
  authorize(interaction.guild.id, webhookId);
  await interaction.reply({ content: `✅ Webhook \`${webhookId}\` authorized — its messages will no longer be blocked.`, flags: MessageFlags.Ephemeral });
  await interaction.message.edit({ content: interaction.message.content + `\n-# ✅ Authorized by <@${interaction.user.id}>`, components: [] }).catch(() => {});
}

module.exports = {
  register, checkFlood, quarantine, alertMods, snowflakeAgeDays, DANGEROUS_PERMS,
  isAuthorized, authorize, revoke, isAuthorizeButton, handleAuthorizeButton, alertBlockedWebhookMessage,
};
