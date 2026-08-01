// ownerlog.js — one owner-only channel combining two feeds owners otherwise can't easily see:
//   1) BOT ACTIONS — a curated, plain-language record of what the bot did (strikes, corners, verifies,
//      bans, mod-app decisions, promotions, appeals...), NOT raw server/process logs (those can leak
//      secrets and are mostly noise — an owner wants "what happened", not stack traces).
//   2) SERVER AUDIT LOG — Discord's own audit log (who banned/kicked/edited roles/channels/etc.),
//      mirrored here because Discord's own audit log has limited retention and needs the Server
//      Settings UI + permission to view — this makes it a permanent, readable record in one place.
// Both are POLL/EVENT-DRIVEN pushes into the SAME channel so an owner has one running timeline instead
// of two places to check.
const { EmbedBuilder, ChannelType, PermissionsBitField, AuditLogEvent } = require('discord.js');
const opspanel = require('./opspanel');

const CONFIG_FILE = process.env.FUBU_OWNERLOG_FILE || '/home/ubuntu/.fubu_ownerlog.json';
const STATE_FILE = process.env.FUBU_OWNERLOG_STATE_FILE || '/home/ubuntu/.fubu_ownerlog_state.json';
const P = PermissionsBitField.Flags;
const fs = require('fs');
function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error('[ownerlog] save:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { lastAuditLogId: null });
const saveState = s => _save(STATE_FILE, s);

// Owner-only, same shape as modapps.js's ensureArchiveChannel — @everyone/MODS/ADMINS explicitly denied
// (they'd otherwise inherit view from whatever category this sits in), only OWNER roles allowed.
async function ensureChannel(guild) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return ex; }
  const overwrites = [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: opspanel.MOD_ROLE_ID, deny: [P.ViewChannel] },
    { id: opspanel.ADMIN_ROLE_ID, deny: [P.ViewChannel] },
    ...opspanel.OWNER_ROLE_IDS.map(id => ({ id, allow: [P.ViewChannel, P.ReadMessageHistory] })),
  ];
  const channel = await guild.channels.create({
    name: '📜┆owner-log', type: ChannelType.GuildText,
    topic: 'Owner-only. Bot actions + a mirror of the server audit log — one running record.',
    permissionOverwrites: overwrites, reason: 'Owner log (owner request)',
  });
  c.channelId = channel.id; saveConfig(c);
  return channel;
}

// ---- 1) bot actions -----------------------------------------------------------------------------
// Call this from wherever a significant bot action already completes. Kept deliberately low-ceremony
// (one function, plain fields) so adding a new call site is a one-liner, not a new pattern each time.
async function log(guild, { emoji = '🤖', title, detail, color = 0x5865F2 }) {
  try {
    const ch = await ensureChannel(guild);
    // Mentions go in the message CONTENT, not an embed: a `<@id>` in content is resolved by Discord for
    // every viewer (a clickable @name → opens the profile), while embed mentions only resolve from the
    // viewer's local cache and render "@unknown-user" in a locked/restricted channel. parse:[] keeps them
    // from pinging anyone. Content-only (no embed) — the emoji + bold title carry the type; a color-only
    // embed would just render as an empty box.
    await ch.send({ content: `${emoji} **${title}**\n${detail}`, allowedMentions: { parse: [] } });
  } catch (e) { console.error('[ownerlog] log:', e.message); }
}

// ---- 2) server audit log mirror -----------------------------------------------------------------
// Curated allowlist — Discord's audit log has ~40 action types; most (emoji/sticker/webhook/stage
// events) are noise for a small community. These are the ones an owner actually wants visibility into.
const WATCHED_EVENTS = new Set([
  AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberRoleUpdate, AuditLogEvent.MemberUpdate, AuditLogEvent.MemberPrune,
  AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelUpdate, AuditLogEvent.ChannelDelete,
  AuditLogEvent.RoleCreate, AuditLogEvent.RoleUpdate, AuditLogEvent.RoleDelete,
  AuditLogEvent.InviteCreate, AuditLogEvent.InviteDelete, AuditLogEvent.GuildUpdate,
]);
const EVENT_LABEL = {
  [AuditLogEvent.MemberKick]: '👢 Kicked', [AuditLogEvent.MemberBanAdd]: '🔨 Banned',
  [AuditLogEvent.MemberBanRemove]: '🔓 Unbanned', [AuditLogEvent.MemberRoleUpdate]: '🎭 Roles changed',
  [AuditLogEvent.MemberUpdate]: '👤 Member updated', [AuditLogEvent.MemberPrune]: '🧹 Pruned inactive members',
  [AuditLogEvent.ChannelCreate]: '➕ Channel created', [AuditLogEvent.ChannelUpdate]: '✏️ Channel edited',
  [AuditLogEvent.ChannelDelete]: '🗑️ Channel deleted', [AuditLogEvent.RoleCreate]: '➕ Role created',
  [AuditLogEvent.RoleUpdate]: '✏️ Role edited', [AuditLogEvent.RoleDelete]: '🗑️ Role deleted',
  [AuditLogEvent.InviteCreate]: '🔗 Invite created', [AuditLogEvent.InviteDelete]: '🔗 Invite deleted',
  [AuditLogEvent.GuildUpdate]: '⚙️ Server settings changed',
};

// Turn an audit-log entry's raw field diffs into a readable line or two — e.g. role add/remove shows the
// actual role name(s), not just "roles changed". Without this the entry says nothing an owner can act on.
function describeChanges(e) {
  if (!e.changes || !e.changes.length) return '';
  const parts = [];
  for (const c of e.changes) {
    const newVal = c.new, oldVal = c.old;
    if (c.key === '$add' || c.key === '$remove') {
      const names = (newVal || []).map(r => r.name).filter(Boolean);
      if (names.length) parts.push(`${c.key === '$add' ? '➕' : '➖'} ${names.join(', ')}`);
      continue;
    }
    if (['permissions', 'permission_overwrites', 'icon_hash', 'avatar_hash'].includes(c.key)) continue; // noisy, not human-readable
    const fmt = v => (v === undefined || v === null) ? '_none_' : (typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60));
    if (oldVal !== undefined && newVal !== undefined) parts.push(`${c.key}: ${fmt(oldVal)} → ${fmt(newVal)}`);
    else if (newVal !== undefined) parts.push(`${c.key} → ${fmt(newVal)}`);
  }
  return parts.length ? `\n${parts.join('\n')}` : '';
}

// Poll Discord's audit log for entries newer than the last one we've posted. First run only seeds the
// watermark (doesn't dump the entire history) — after that, every new watched entry gets mirrored.
async function pollAuditLog(guild) {
  try {
    const st = loadState();
    const page = await guild.fetchAuditLogs({ limit: 50 }).catch(() => null);
    if (!page) return 0;
    const entries = [...page.entries.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1); // oldest→newest
    if (!st.lastAuditLogId) {
      // First run: just seed the watermark to "now" so we don't flood the channel with server history.
      const newest = entries[entries.length - 1];
      saveState({ lastAuditLogId: newest ? newest.id : '0' });
      return 0;
    }
    // Skip entries the BOT ITSELF caused (strikes/corners/verifies/etc. already get their own, more
    // detailed manual log line above) — this feed is for genuine out-of-band human actions taken
    // directly through Discord, bypassing the bot (manual bans, manual role edits, channel changes...).
    const fresh = entries.filter(e => BigInt(e.id) > BigInt(st.lastAuditLogId) && WATCHED_EVENTS.has(e.action) && e.executorId !== guild.client.user.id);
    if (!fresh.length) return 0;
    const ch = await ensureChannel(guild);
    for (const e of fresh) {
      const label = EVENT_LABEL[e.action] || `Action ${e.action}`;
      // Real <@id> mentions — clickable, opens their profile card — but allowedMentions:{parse:[]} below
      // means it never actually pings/notifies them. "Visible, not tagging" for a passive log feed.
      const actor = e.executor ? `<@${e.executor.id}>` : 'Unknown';
      // Users (the common case: kicked/banned/role-changed/updated member) get a clickable mention too;
      // Roles/Channels/the Guild itself aren't people, so those stay plain bold text.
      const targetIsUser = e.target && (e.target.tag !== undefined || e.target.username !== undefined);
      const target = e.target ? (targetIsUser ? `<@${e.target.id}>` : `**${e.target.name || e.targetId || 'unknown'}**`) : null;
      const reason = e.reason ? ` — _${e.reason}_` : '';
      // CONTENT, not an embed — so @mentions resolve to clickable names for every viewer (embed mentions
      // show "@unknown-user" when the viewer's client hasn't cached that member). parse:[] = no pings.
      // '-#' renders the label as small subtext, marking this as the passive audit feed vs the manual logs.
      const line = `${actor}${target ? ` → ${target}` : ''}${describeChanges(e)}${reason}`;
      await ch.send({ content: `-# 🗒️ Server audit log · ${label}\n${line}`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    saveState({ lastAuditLogId: entries[entries.length - 1].id });
    return fresh.length;
  } catch (e) { console.error('[ownerlog] pollAuditLog:', e.message); return 0; }
}

function register(client) {
  const run = async () => {
    const guild = client.guilds.cache.first();
    if (guild) await pollAuditLog(guild);
  };
  setTimeout(run, 30 * 1000);
  setInterval(run, 2 * 60 * 1000);
  console.log('[ownerlog] audit-log poll every 2min');
}

module.exports = { ensureChannel, log, pollAuditLog, register };
