// config.js — read + validate configuration from the environment (systemd EnvironmentFile).
// Nothing secret is hardcoded; the token lives only in the env file. Fails fast with a clear
// message if a required value is missing, so a misconfigured deploy never silently no-ops.
const { statePath } = require('./statepath');

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
  // Per-community banner image used as the #roles divider between sections — was a single hardcoded FUBU
  // asset shared across every guild running this codebase (Melanin got FUBU's banner). Blank = no image,
  // falls back to a plain text divider.
  rolesDividerImage: opt('ROLES_DIVIDER_IMAGE', ''),
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
  adultCornerChannelId: opt('ADULT_CORNER_CHANNEL_ID', ''),  // 18+/MDNI adult corner channel
  // Separate role for Adult Corner (owner, 2026-08-21: "what about an adult corner role? seems more
  // simple to me" — replaced an earlier per-member-overwrite fix with this). The two corner roles are
  // MUTUALLY EXCLUSIVE by design: a member holds ONE, never both. This isn't just tidiness — Discord
  // combines a member's role overwrites by unioning denies from every held role, then applying allows
  // from every held role ON TOP (allow beats deny across different roles). So if a member held BOTH
  // corner roles, cornerRoleId's SendMessages:true on the regular channel would silently override
  // adultCornerRoleId's SendMessages:false there — the whole point of separate roles only holds if
  // membership in the two is exclusive. corner.js enforces that on every corner()/uncorner() call.
  adultCornerRoleId: opt('ADULT_CORNER_ROLE_ID', ''),
  cornerLogChannelId: opt('CORNER_LOG_CHANNEL_ID', '1531004789025013982'),  // public read-only audit log
  cornerVcId: opt('CORNER_VC_ID', '1531113277776724189'),  // corner voice channel: public see, cornered+mods join+talk
  // --- Welcome / Goodbye (native replacement for Carl-bot + Mimu, 2026-08-19: their embed-title mention
  // stopped resolving to a real name for brand-new members — Discord only resolves an <@id> mention inside
  // an embed from the viewer's own client cache, which a just-joined member is never in yet) ---
  welcomeChannelId: opt('WELCOME_CHANNEL_ID', '1516225366191116409'),
  goodbyeChannelId: opt('GOODBYE_CHANNEL_ID', '1516225452187062395'),
  // Repeat-cornering-for-the-same-rule alert threshold (NOT auto-strike — just tells staff to consider
  // converting to a Strike, with a one-click button). Deliberately tunable: the enforcement-model spec
  // doesn't finalize an exact number, so this is a clearly-labeled default, not a guess baked into logic.
  cornerRepeatAlertThreshold: Number(opt('CORNER_REPEAT_ALERT_THRESHOLD', '3')) || 3,
  // Verified-member cornering (feature 'memberCorner', FUBU-only). Max duration a non-staff member may set
  // (blank defaults to this), and how many member-initiated corners each member may do per UTC day. Member
  // corners carry NO rule/reason, so they never feed the corner→strike repeat-conversion count.
  memberCornerMaxMs: Number(opt('MEMBER_CORNER_MAX_MS', String(5 * 60 * 1000))) || 5 * 60 * 1000,
  memberCornerDailyCap: Number(opt('MEMBER_CORNER_DAILY_CAP', '3')) || 3,
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
  // Identifying roles KEPT when someone is cornered (age / gender / country — purely self-ID, grants no
  // actual access). Everything else (non-managed) is stripped and restored on release, including MDNI and
  // tribe roles — both grant real access (18+ content, tribe channels/perks), so a cornered member loses
  // them like anything else. MDNI used to be on this list (a member cornered while MDNI'd kept 18+ access
  // the whole time they were jailed) — moved off deliberately, not an oversight.
  // No hardcoded default: this used to default to FUBU's own role IDs, which silently meant a fresh guild
  // running this codebase (Melanin) kept NOTHING extra when cornering — none of FUBU's IDs matched any of
  // its roles, so age/gender/country got stripped too, right along with everything else. Set explicitly
  // per guild via IDENTIFYING_ROLE_IDS now.
  identifyingRoleIds: opt('IDENTIFYING_ROLE_IDS', '').split(',').map(s => s.trim()).filter(Boolean),

  // Backfill: give the Unverified role to members who have NEITHER verified nor unverified. Their
  // reap clock starts when tagged (unverifiedSince), not their join date, so long-time members
  // aren't instantly past the kick line.
  assignUnverified: bool('ASSIGN_UNVERIFIED', true),

  // Role pinged by the pending-thread nudge, and channel the nudge is posted to
  // (defaults to the verify channel if no separate alert channel is given).
  modRoleId: opt('MOD_ROLE_ID', '1528316361665675316'), // MODS-✰ — was '' with no fallback, silently dropped mods from every ping (verify threads, watchlist strict alerts) once MOD_ROLE_ID fell out of .community_env post-migration (found 2026-08-08)
  adminRoleId: opt('ADMIN_ROLE_ID', '1516179051105226833'),                      // ADMINS-★
  adminDiscussionChannelId: opt('ADMIN_DISCUSSION_CHANNEL_ID', '1530793201751953508'), // 👤┆ᴀᴅᴍɪɴ-ᴅɪsᴄᴜssɪᴏɴ (no admin-announcements, so promotions post here)
  // Trial Mod — a restricted training tier: may VERIFY, view the dashboard read-only, and CORNER (rule +
  // reason required, ≤ 1h). Everything else stays mod+. Kept here so every gate can see it without reading
  // the modapps config file (same id as .fubu_modapps.json trialModRoleId).
  trialModRoleId: opt('TRIAL_MOD_ROLE_ID', '1532037321740779860'),
  modAlertChannelId: opt('MOD_ALERT_CHANNEL_ID', ''), // falls back to verifyChannelId at use
  modAnnounceChannelId: opt('MOD_ANNOUNCE_CHANNEL_ID', '1526926690637578362'), // strict watchlist alerts + ban buttons
  awardsAnnounceChannelId: opt('AWARDS_ANNOUNCE_CHANNEL_ID', ''), // weekly peer-vote reminder + results — a real "general" channel, set per-guild
  birthdayChannelId: opt('BIRTHDAY_CHANNEL_ID', ''), // public "Happy Birthday" post the moment someone's ephemeral role is granted
  birthdayPingRoleId: opt('BIRTHDAY_PING_ROLE_ID', ''), // opt-in via #roles notifications section; pinged on each birthday post
  eventPingRoleId: opt('EVENT_PING_ROLE_ID', ''), // existing #roles "🤾 Event ping" role, reused for the weekly-awards Wednesday reminder
  watchLogChannelId: opt('WATCH_LOG_CHANNEL_ID', '1531382379342729428'), // loose day-to-day monitor reports (mod-only, no ping)
  modCategoryId: opt('MOD_CATEGORY_ID', '1516233713250471976'), // "Mod Activities" category - staff-only channels excluded from strict watchlist scanning of a watched mod
  deletionLogChannelId: opt('DELETION_LOG_CHANNEL_ID', '1538530956401447033'), // deleted-message re-uploads — split from watch-log (owner, 2026-08-16), same permission shape
  propagandaForumId: opt('PROPAGANDA_FORUM_ID', '1536421958449893477'), // per-tribe forum tags; propagandaDailyIfDue reads reactions from here
  // Admin-only alert channel — MODS explicitly excluded (owner, 2026-08-08: watched staff members must not
  // be able to see their own watchlist hits). Strict watchlist alerts route here instead of the normal
  // mod-visible modAnnounceChannelId whenever the watched member is themselves staff.
  adminAnnounceChannelId: opt('ADMIN_ANNOUNCE_CHANNEL_ID', '1535453964592488559'),
  // Optional public punishment feeds (Melanin has dedicated channels for these; FUBU leaves them unset → no-op).
  punishmentLogChannelId: opt('PUNISHMENT_LOG_CHANNEL_ID', ''), // public feed of strikes + bans (corner-log already covers corners)
  bannedChannelId: opt('BANNED_CHANNEL_ID', ''),                // a clean announcement each time someone is banned
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
  mdniRoleId: opt('MDNI_ROLE_ID', '1519408206370308197'),                    // 𝗠𝗗𝗡𝗜 (18+ opt-in, onboarding; kept as a free-standing preference for confirmed adults, no longer gates the base channel)
  mdniChannelId: opt('MDNI_CHANNEL_ID', '1531720395357687868'),              // 🔞┆ɢᴇɴᴇʀᴀʟ (owner, 2026-08-18: gated on adultAgeRoleIds directly now, not the MDNI opt-in)
  minorAgeRoleId: opt('MINOR_AGE_ROLE_ID', '1516185172213628989'),           // ✰ • 16-17
  adultAgeRoleIds: opt('ADULT_AGE_ROLE_IDS', '1516185300492222618,1516185358415433739,1516209186839466113').split(',').map(s => s.trim()).filter(Boolean), // 18-21 / 21-25 / 25-30+
  mdniNsfwChannelId: opt('MDNI_NSFW_CHANNEL_ID', '1538353269146128545'),    // 🔞┆ɢᴇɴᴇʀᴀʟ-ɴsꜰᴡ (age-restricted, gated on mdniVerifiedRoleId)
  mdniVerifiedVcId: opt('MDNI_VERIFIED_VC_ID', '1538955040868532355'),      // 📞┆ɴsꜰᴡ-ᴠᴄ (age-restricted, gated on mdniVerifiedRoleId — same overwrites as mdniNsfwChannelId)
  // Adult Verified (owner, 2026-08-18): auto-managed combined role, Verified + adult age bracket, both.
  // Gates the whole Adults area. Replaced an earlier per-member-overwrite lock design that would have
  // scaled with (members × channels) and hit Discord's per-channel overwrite cap; a role scales with
  // membership only, same shape as the MDNI-Verified role this pattern was originally built for.
  adultVerifiedRoleId: opt('ADULT_VERIFIED_ROLE_ID', '1539335835848278066'),  // 🔒 Adult Verified
  // MDNI Verified v2 (FUBU only — Melanin has no MDNI concept): one level up from Adult Verified, ALSO
  // requires the MDNI opt-in. Gates general-nsfw/nsfw-vc. (A same-named role existed before 2026-08-18,
  // keyed on the raw adult age bracket instead of Adult Verified — retired same day for being redundant
  // with plain MDNI gating, then reinstated same day once it turned out the raw age bracket didn't
  // imply Verified after all. This is a fresh role instance, not the same Discord role id.)
  mdniVerifiedRoleId: opt('MDNI_VERIFIED_ROLE_ID', '1539335837295190026'),   // 🔞 MDNI Verified
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

  // Arena auto-start: the bot randomly launches arena challenges through the active day (up to the daily
  // cap, respecting the cooldown) so activity happens without a leader manually starting one.
  arenaAutoStart: bool('ARENA_AUTO_START', true),
  // Tribe Games are MANUAL ONLY (owner, 2026-08-21: "it's supposed to be manual only"). Unlike Arena,
  // a Tribe Game needs tribe leaders to set a rep AND staff to report the result afterwards, so an
  // auto-started one just posts a lobby nobody fills — it had fired 3 times in 24h with zero entrants
  // before this was turned off. Staff launch them from /tribe panel. Flip the env var to re-enable.
  tribeGamesAutoStart: bool('TRIBE_GAMES_AUTO_START', false),
  // Active window is in this timezone (majority of the server is Central Europe, so default there, not US).
  arenaAutoTimezone: opt('ARENA_AUTO_TIMEZONE', 'Europe/Berlin'),
  arenaAutoStartHour: num('ARENA_AUTO_START_HOUR', 10),  // PEAK window: earliest local hour (full events, all types)
  arenaAutoEndHour: num('ARENA_AUTO_END_HOUR', 24),      // PEAK window: latest (exclusive) local hour
  // DOWNTIME window (calm low-ping events that pay bonus Treasury but no Glory). Outside both windows is
  // dead (no events). Downtime 00:00-06:00 local, dead lull 06:00-10:00 local (owner, 2026-08-16: the old
  // 00:00-08:00 downtime window still fired events deep into US-evening/midnight and early-morning Europe
  // at once — shrunk so the truly quiet hours land ~04:00-08:00 UTC, night for both regions).
  arenaDowntimeStartHour: num('ARENA_DOWNTIME_START_HOUR', 0),
  arenaDowntimeEndHour: num('ARENA_DOWNTIME_END_HOUR', 6),
  // TRUE PEAK: a narrower slice INSIDE the peak window above (owner, 2026-08-16) — the busiest realistic
  // overlap across regions (European evening, still daytime for Africa, US afternoon/evening). Only here:
  // Activity Blitz becomes possible (it measures server-wide message activity, so it needs a lot of people
  // online to mean anything) and auto-events fire noticeably more often.
  arenaTruePeakStartHour: num('ARENA_TRUE_PEAK_START_HOUR', 17),
  arenaTruePeakEndHour: num('ARENA_TRUE_PEAK_END_HOUR', 22),

  // Public "spectacle" channel for big tribe moments (war results, crownings, season champions) so lurkers
  // and newcomers see the drama. Empty = fall back to the tribe-announcements channel.
  tribeSpectacleChannelId: opt('TRIBE_SPECTACLE_CHANNEL_ID', ''),

  // A mod founding their own tribe needs this many OTHER mods to co-sign first (owner: "if a mod wants to
  // start a tribe it must be in a group of three" — FUBU default, 2 more cosigns on top of the founder).
  // Melanin's mod team is much smaller, so its env overrides this to 0 — a mod there can found solo, no
  // cosigns needed (owner, 2026-08-16: "let's allow mods to create tribe on their own").
  modFoundingCosignsRequired: num('MOD_FOUNDING_COSIGNS_REQUIRED', 2),
  // The Chronicle channel: where the weekly history chapter is written. Empty = fall back to the spectacle chan.
  tribeChronicleChannelId: opt('TRIBE_CHRONICLE_CHANNEL_ID', ''),

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
  // Smart-watch LAB (feature 'smartWatchLab'): a private, admin-only evaluation channel. When set (and the
  // feature is on) the judge runs on an EXPANDED term set and posts its would-hide/would-surface verdict
  // there for admins to grade — and the public watch-log reverts to plain keyword flags (no AI). Dormant
  // until an id is given. The expanded terms only feed the lab (see watchlist.js lab lists).
  smartWatchLabChannelId: opt('SMARTWATCH_LAB_CHANNEL_ID', ''),
  // Fresh-account flag (dashboard-tunable, Watchlist page): mark a watch/lab flag with "⚠ brand-new account"
  // as a HUMAN heads-up — deliberately NOT fed to the AI judge (which judges the message, not tenure).
  //   mode 'auto'   → self-calibrating: flag only accounts in the newest N% of the server, so the threshold
  //                   tightens during a growth spike and loosens as growth slows — no number to babysit.
  //   mode 'manual' → flag accounts that joined within smartWatchFreshHours hours (a fixed override).
  //   mode 'off'    → no note.
  smartWatchFreshMode: opt('SMARTWATCH_FRESH_MODE', 'auto'),
  smartWatchFreshHours: num('SMARTWATCH_FRESH_HOURS', 0),          // manual-mode threshold (hours)
  smartWatchFreshPercentile: num('SMARTWATCH_FRESH_PERCENTILE', 1), // auto-mode sensitivity: newest N% of members
  smartWatchFreshMaxDays: num('SMARTWATCH_FRESH_MAX_DAYS', 30),     // absolute cap: never flag joins older than this
  // Influx detection: when joins in the last hour spike to influxFactor× the 30-day baseline (and clear an
  // absolute floor), post a one-time "📈 influx detected" heads-up. Warns admins a spike/raid is underway
  // AND explains why the auto fresh-flag just tightened. Cooldown avoids spamming across a sustained wave.
  influxFactor: num('INFLUX_FACTOR', 5),
  influxMinJoins: num('INFLUX_MIN_JOINS', 10),                      // min joins/hour to even consider an influx
  influxWarnCooldownHours: num('INFLUX_WARN_COOLDOWN_HOURS', 6),
  influxWarnChannelId: opt('INFLUX_WARN_CHANNEL_ID', ''),           // falls back to modAnnounceChannelId

  // Observe-only: log every intended action but perform none. Default ON so the first
  // live run proves it targets the right threads before anything is actually closed.
  dryRun: bool('DRY_RUN', true),

  // Where the small persistence file lives (last-nudge / warned timestamps, processed members).
  stateFile: opt('STATE_FILE', statePath('verify_state.json')),
};

// Verification nudges ping mods about a pending thread — that's staff business, not something to post in
// the public verify channel itself (the bug: no MOD_ALERT_CHANNEL_ID was ever set, so this fell all the way
// back to verifyChannelId). Default to the existing mod-only alerts channel instead; verifyChannelId is only
// a last resort if even that isn't configured.
config.alertChannelId = config.modAlertChannelId || config.modAnnounceChannelId || config.verifyChannelId;
config.warnChannelId = config.unverifiedChatChannelId || config.verifyChannelId;

// Runtime overrides written by the ops dashboard (Settings/Danger toggles + timings). They persist
// across restarts and take precedence over the env, so a live toggle survives a reboot. Only keys that
// already exist in config are honored, so a stray override can't inject anything unexpected.
config.overrideFile = opt('FUBU_CONFIG_OVERRIDE_FILE', statePath('config_overrides.json'));
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
