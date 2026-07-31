// config.js — read + validate configuration from the environment (systemd EnvironmentFile).
// Nothing secret is hardcoded; the token lives only in the env file. Fails fast with a clear
// message if a required value is missing, so a misconfigured deploy never silently no-ops.

function req(name) {
  const v = (process.env[name] || '').trim();
  if (!v) {
    console.error(`[config] FATAL: required env ${name} is not set`);
    process.exit(1);
  }
  return v;
}

function opt(name, fallback) {
  const v = (process.env[name] || '').trim();
  return v || fallback;
}

function num(name, fallback) {
  const v = (process.env[name] || '').trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`[config] FATAL: env ${name}='${v}' is not a number`);
    process.exit(1);
  }
  return n;
}

function bool(name, fallback) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const config = {
  token: req('DISCORD_BOT_TOKEN'),
  guildId: req('GUILD_ID'),

  // The text channel where members open verification threads.
  verifyChannelId: req('VERIFY_CHANNEL_ID'),

  // Assigning this role to a member is the "they've been verified" signal.
  verifiedRoleId: req('VERIFIED_ROLE_ID'),
  rolesChannelId: opt('ROLES_CHANNEL_ID', '1500589790750572555'),  // 🎓┆ʀᴏʟᴇs - bot-owned self-assign pickers
  // Category for member-facing, thread-based moderation tools (ban/strike appeals) — same home as the
  // mod-apps applicant channel, which the owner already confirmed is a fine spot for this shape of thing.
  appealsCategoryId: opt('APPEALS_CATEGORY_ID', '1531845194134196254'),  // 💭 ᴄᴏɴꜰᴇssɪᴏɴs

  // Optional. If set, a thread counts as "pending" (eligible for nudge/stale) only when its
  // owner still holds this Unverified role — a precise signal that skips people who've left or
  // aren't in the verification flow. If unset, "pending" falls back to "owner lacks Verified".
  unverifiedRoleId: opt('UNVERIFIED_ROLE_ID', ''),

  // --- The Corner (jail) ---
  cornerRoleId: opt('CORNER_ROLE_ID', '1529459820795789382'),
  cornerChannelId: opt('CORNER_CHANNEL_ID', '1529552895262068846'),
  cornerLogChannelId: opt('CORNER_LOG_CHANNEL_ID', '1531004789025013982'),  // public read-only audit log
  cornerVcId: opt('CORNER_VC_ID', '1531113277776724189'),  // corner voice channel: public see, cornered+mods join+talk
  // Repeat-cornering-for-the-same-rule alert threshold (NOT auto-strike — just tells staff to consider
  // converting to a Strike, with a one-click button). Deliberately tunable: the enforcement-model spec
  // doesn't finalize an exact number, so this is a clearly-labeled default, not a guess baked into logic.
  cornerRepeatAlertThreshold: Number(opt('CORNER_REPEAT_ALERT_THRESHOLD', '3')) || 3,
  // Default duration for a message-flagged Corner (right-click "Send to corner" / the optional-reason
  // modal) — this is "casual, temporary" per the rules, so it should NOT default to indefinite. Timed,
  // tunable; staff can still /uncorner early or extend via the corner announcement's buttons.
  cornerDefaultDurationMs: Number(opt('CORNER_DEFAULT_DURATION_MS', String(15 * 60 * 1000))) || 15 * 60 * 1000,
  // How long after a DENIED strike appeal before that same strike can be re-appealed. Not specified by
  // the enforcement-model spec — tunable, not a silent guess baked into logic.
  strikeAppealCooldownDays: Number(opt('STRIKE_APPEAL_COOLDOWN_DAYS', '7')) || 7,
  // Auto-corner (Rule 9, Right Channel Right Conversation): opening a thread in a general/chat category
  // gets the member a quick timed Corner + the thread deleted. Scoped by CATEGORY (not a hardcoded
  // channel list) so newly-added chat channels are covered automatically. Excludes the sanctioned
  // discussion channel (#debates), the anonymous suggestions channel, #bot-commands, and the gated 18+
  // MDNI channel (a special sanctioned space, not general chat, even though it shares a category).
  autoCornerThreadCategoryIds: opt('AUTO_CORNER_THREAD_CATEGORY_IDS',
    '1500215550020812850,1528704969094463499,1528540190958813344').split(',').map(s => s.trim()).filter(Boolean),
  autoCornerThreadExcludedChannelIds: opt('AUTO_CORNER_THREAD_EXCLUDED_CHANNEL_IDS',
    '1526925881371529336,1528361653526335640,1528704767466016870,1531720395357687868').split(',').map(s => s.trim()).filter(Boolean),
  autoCornerThreadDurationMs: Number(opt('AUTO_CORNER_THREAD_DURATION_MS', String(15 * 60 * 1000))) || 15 * 60 * 1000,
  // The category cornered people CAN see (view-only): "ᴠᴇʀɪꜰʏ ᴀɴᴅ ʀᴜʟᴇs".
  cornerViewCategoryId: opt('CORNER_VIEW_CATEGORY_ID', '1500938647132704818'),
  // Identifying roles KEPT when someone is cornered (age / gender / country / MDNI). Everything
  // else (non-managed) is stripped and restored on release.
  identifyingRoleIds: opt('IDENTIFYING_ROLE_IDS',
    '1516185172213628989,1516185300492222618,1516185358415433739,1516209186839466113,' + // age 15-17,18-21,21-25,25-30+
    '1517716868650242098,1517717292392251483,1517717104399220856,1526939765667008615,' + // gender she/they/he/others
    '1501649800968278192,1501649801677111508,1501649802642063380,1501649802759508235,1501649803774267422,1501649805045141694,' + // country EU/NA/SA/ASIA/OCE/AFR
    '1519408206370308197,' + // MDNI
    '1527430885287264438' // OWNER⚜️ - kept when cornering (bot can't strip it until the role order is fixed); everything else is still stripped
  ).split(',').map(s => s.trim()).filter(Boolean),

  // Backfill: give the Unverified role to members who have NEITHER verified nor unverified. Their
  // reap clock starts when tagged (unverifiedSince), not their join date, so long-time members
  // aren't instantly past the kick line.
  assignUnverified: bool('ASSIGN_UNVERIFIED', true),

  // Role pinged by the pending-thread nudge, and channel the nudge is posted to
  // (defaults to the verify channel if no separate alert channel is given).
  modRoleId: opt('MOD_ROLE_ID', ''),
  adminRoleId: opt('ADMIN_ROLE_ID', '1516179051105226833'),                      // ADMINS-★
  adminDiscussionChannelId: opt('ADMIN_DISCUSSION_CHANNEL_ID', '1530793201751953508'), // 👤┆ᴀᴅᴍɪɴ-ᴅɪsᴄᴜssɪᴏɴ (no admin-announcements, so promotions post here)
  // Trial Mod — a restricted training tier: may VERIFY, view the dashboard read-only, and CORNER (rule +
  // reason required, ≤ 1h). Everything else stays mod+. Kept here so every gate can see it without reading
  // the modapps config file (same id as .fubu_modapps.json trialModRoleId).
  trialModRoleId: opt('TRIAL_MOD_ROLE_ID', '1532037321740779860'),
  modAlertChannelId: opt('MOD_ALERT_CHANNEL_ID', ''), // falls back to verifyChannelId at use
  watchlistRoleId: opt('WATCHLIST_ROLE_ID', '1528541994652270793'),
  modAnnounceChannelId: opt('MOD_ANNOUNCE_CHANNEL_ID', '1526926690637578362'), // strict watchlist alerts + ban buttons
  watchLogChannelId: opt('WATCH_LOG_CHANNEL_ID', '1531382379342729428'), // loose day-to-day monitor reports (mod-only, no ping)
  // Strike ladder (least → most severe). Watch-log reports escalate through these before a ban.
  // For the 5-strike model, add a 4th role here (Strike IV) so the 5th strike lands on the existing
  // ban-confirm; the ladder logic is already generic in the count.
  strikeRoleIds: opt('STRIKE_ROLE_IDS', '1531339206406701127,1531339284731138159,1531339368235798538').split(',').map(s => s.trim()).filter(Boolean),

  // Language mini-mods: a single role that (when the 'langMiniMod' feature is on) may use Send-to-corner
  // and Report-to-watchlist, but ONLY on messages in the language channels below. Empty roleId = dormant.
  langMiniModRoleId: opt('LANG_MINI_MOD_ROLE_ID', ''),
  langChannelIds: opt('LANG_CHANNEL_IDS',
    '1528348302318506074,1528449234121003008,1528533652890325143,1528534210950856744' // French / German / Dutch / Hispanic
  ).split(',').map(s => s.trim()).filter(Boolean),

  // MDNI (18+) enforcement: the MDNI role must be backed by an ADULT age role. Onboarding lets a minor
  // self-select MDNI with no age check, so the bot strips it from anyone lacking an adult age role.
  mdniEnforce: bool('MDNI_ENFORCE', true),
  mdniRoleId: opt('MDNI_ROLE_ID', '1519408206370308197'),                    // 𝗠𝗗𝗡𝗜 (18+ opt-in, onboarding)
  minorAgeRoleId: opt('MINOR_AGE_ROLE_ID', '1516185172213628989'),           // ✰ • 16-17
  adultAgeRoleIds: opt('ADULT_AGE_ROLE_IDS', '1516185300492222618,1516185358415433739,1516209186839466113').split(',').map(s => s.trim()).filter(Boolean), // 18-21 / 21-25 / 25-30+
  // Mod-dashboard channel — its non-pinned messages get tidied weekly (the pinned panel stays).
  dashboardChannelId: opt('DASHBOARD_CHANNEL_ID', '1531087673760944331'),

  // Channel where the pre-kick warning is @mentioned to unverified members who have NO thread.
  // (Members who DO have a thread are warned inside their thread.) Falls back to verify channel.
  unverifiedChatChannelId: opt('UNVERIFIED_CHAT_CHANNEL_ID', ''),

  // Role-conflict resolution: members holding BOTH the verified and unverified role are flagged
  // to mods in this channel (the bot won't act on them until a human resolves the conflict).
  modConflictChannelId: opt('MOD_CONFLICT_CHANNEL_ID', ''),
  conflictPing: bool('CONFLICT_PING', true),
  conflictRepingHours: num('CONFLICT_REPING_HOURS', 24), // don't re-flag the same member more often
  conflictMaxPerSweep: num('CONFLICT_MAX_PER_SWEEP', 25), // cap flags per sweep so the channel isn't flooded

  // Daily digest — a 24h recap of every job (posted to the mod-conflict channel) as an embed.
  digestEnabled: bool('DIGEST_ENABLED', true),
  digestHour: num('DIGEST_HOUR', 9), // local server-time hour (0-23) to post the daily digest

  // Weekly react-to-resolve message in the unverified-chat channel: members with BOTH roles react
  // to auto-fix their conflict (Unverified removed). Reposted weekly (old one deleted) so it
  // re-surfaces, and reactors are resolved both in real-time and on the hourly sweep.
  reactResolveEnabled: bool('REACT_RESOLVE_ENABLED', true),
  reactRepostDays: num('REACT_REPOST_DAYS', 7),
  reactEmoji: opt('REACT_EMOJI', '✅'),
  reactPingRole: bool('REACT_PING_ROLE', true), // ping the Unverified role so members re-see it

  // Feature toggles — all three ship on by default (owner chose "all three").
  featureNudge: bool('FEATURE_NUDGE', true),
  featureStale: bool('FEATURE_STALE', true),

  // When a thread goes stale (unverified past the window), also KICK the owner from the guild
  // before deleting their thread. Safety valve: set false to delete the stale thread but not kick.
  staleKick: bool('STALE_KICK', true),

  // Delete threads whose owner has LEFT the server (orphaned — nobody to verify or kick).
  reapOrphans: bool('REAP_ORPHANS', true),

  // Delete ALL threads created in the unverified-chat channel, regardless of status or owner
  // (no threads are allowed there — it's a chat channel, not a thread channel).
  purgeWarnThreads: bool('PURGE_WARN_CHANNEL_THREADS', true),

  // Nudge timing: flag a pending (unverified) thread once it is older than N hours,
  // then re-nudge no more often than every M hours.
  nudgeAfterHours: num('NUDGE_AFTER_HOURS', 24),
  nudgeEveryHours: num('NUDGE_EVERY_HOURS', 24),
  // Only nudge mods once the applicant has actually posted a PHOTO in her thread (she's done her part).
  // No image → the ball's in the user's court, not the mods' → don't ping the mods. Off = nudge regardless.
  nudgeRequireImage: bool('NUDGE_REQUIRE_IMAGE', true),

  // Reap timing, measured from when a member RECEIVED the Unverified role (unverifiedSince):
  //   WARN_DAYS — warn (with @mention) this many days after becoming unverified.
  //   KICK_DAYS — kick this many days after becoming unverified. Must be > WARN_DAYS.
  warnDays: num('WARN_DAYS', 6),
  kickDays: num('KICK_DAYS', 7),
  // For members already unverified with no recorded date, reconstruct the clock: use their JOIN
  // date if they joined on/after this cutoff, otherwise start "now" (fresh grace for old members).
  reapJoinCutoffMs: Date.parse(opt('REAP_JOIN_CUTOFF', '2026-07-19') + 'T00:00:00'),

  // How often the periodic sweep (nudge + stale) runs.
  sweepIntervalMin: num('SWEEP_INTERVAL_MIN', 60),

  // Smart-watch LLM judge (feature 'smartWatch'). LIVE=false → SHADOW mode: the judge annotates flags +
  // logs what it WOULD suppress, but suppresses nothing (safe first run). Flip LIVE=true only after the
  // shadow log shows it's accurate. suppressThreshold: only auto-suppress a benign verdict at/above this
  // confidence (and never for child-safety/threat/doxxing — enforced in smartwatch.js).
  smartWatchLive: bool('SMARTWATCH_LIVE', false),
  smartWatchSuppressThreshold: num('SMARTWATCH_SUPPRESS_THRESHOLD', 0.85),

  // Observe-only: log every intended action but perform none. Default ON so the first
  // live run proves it targets the right threads before anything is actually closed.
  dryRun: bool('DRY_RUN', true),

  // Where the small persistence file lives (last-nudge / warned timestamps, processed members).
  stateFile: opt('STATE_FILE', '/home/ubuntu/.fubu_verify_state.json'),
};

config.alertChannelId = config.modAlertChannelId || config.verifyChannelId;
config.warnChannelId = config.unverifiedChatChannelId || config.verifyChannelId;

// Runtime overrides written by the ops dashboard (Settings/Danger toggles + timings). They persist
// across restarts and take precedence over the env, so a live toggle survives a reboot. Only keys that
// already exist in config are honored, so a stray override can't inject anything unexpected.
config.overrideFile = opt('FUBU_CONFIG_OVERRIDE_FILE', `${process.env.HOME || '/home/ubuntu'}/.fubu_config_overrides.json`);
try {
  const _ov = JSON.parse(require('fs').readFileSync(config.overrideFile, 'utf8'));
  const applied = Object.keys(_ov).filter(k => k in config);
  for (const k of applied) config[k] = _ov[k];
  if (applied.length) console.log(`[config] applied ${applied.length} dashboard override(s): ${applied.join(', ')}`);
} catch { /* no overrides file yet - env values stand */ }

if (config.warnDays >= config.kickDays) {
  console.error(`[config] FATAL: WARN_DAYS (${config.warnDays}) must be less than KICK_DAYS (${config.kickDays})`);
  process.exit(1);
}

module.exports = config;
