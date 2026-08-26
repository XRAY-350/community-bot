// features.js — single source of truth for the bot's features. Drives command registration,
// handler gating, /help, and the server-guide. The registry holds each feature's display info
// AND design metadata, so features stay coherent (the "thought process") instead of being islands.
//
// FAIL-OFF: a feature is enabled only if its flag is EXPLICITLY true in .fubu_features.json.
// Nothing is on by default. The already-built features are seeded true because they exist and are
// running today — not because they're privileged. Planned features are seeded false (dark) until
// someone flips them on.
const fs = require('fs');
const { statePath } = require('./statepath');
const FLAGS_FILE = process.env.FUBU_FEATURES_FILE || statePath('features.json');

// audience: 'core'  = structural, never shown in /help
//           'staff' = mod tools
//           'member'= shown in /help + the server-guide
// commands / contexts: the slash + right-click command names this feature owns
//   (these drive both command REGISTRATION and handler GATING)
// help: { name, value } — the entry rendered in /help + the guide (member features only)
// built: seeds the flag file. true = already built + live (ON) · false = planned (OFF/dark)
const REGISTRY = [
  { key: 'verify',      audience: 'core',   built: true,  commands: ['pending', 'verify'] },
  { key: 'panel',       audience: 'staff',  built: true,  commands: ['panel', 'staff'] },
  { key: 'features',    audience: 'core',   built: true,  commands: ['features'] }, // owner-only feature toggle command
  { key: 'help',        audience: 'core',   built: true,  commands: ['help'] },
  { key: 'dashboard',   audience: 'member', built: true,  commands: ['dashboard'], // public member hub: status, server info, feature guide (setup folded into /panel → Setup)
    help: { name: '🤖 Member hub', value: 'Open `/dashboard` for your status, the rules, and every member feature in one place.' } },
  { key: 'corner',      audience: 'staff',  built: true,  commands: ['corner', 'uncorner', 'corner-status', 'stats', 'ban'], contexts: ['Send to corner', 'Ban'] },   // 'cornered' folded into /panel → Corner page
  { key: 'strikes',     audience: 'staff',  built: true,  commands: ['strike', 'weights'], contexts: ['Strike'] },
  { key: 'wordFilter',  audience: 'staff',  built: true,  commands: ['wordfilter', 'mediafilter'], contexts: ['Block this GIF', 'Block this attachment'] }, // temporary auto-delete of messages containing a set word/phrase, or GIFs/attachments
  { key: 'levelCheck',  audience: 'staff',  built: true,  commands: ['levelcheck'] }, // audit Arcane level roles landing (reads #bot-commands log) + admin resync-fix
  { key: 'tribes',      audience: 'member', built: true,  commands: ['tribe', 'tribe-admin'], // member-run factions: hub/roster/standings/motto + Warden tools + admin create/register (ranks + rivalry to come)
    help: { name: '🏴 Tribes', value: 'Join a tribe with `/request-role`, then `/tribe info`, `/tribe roster`, and `/tribe list` for standings. Leaders set the vibe with `/tribe motto`.' } },
  { key: 'watchlist',   audience: 'staff',  built: true,  commands: ['watchlist', 'watchlist-terms', 'watchlist-suggest', 'unban'], contexts: ['Report to watchlist'] },
  { key: 'suggestions', audience: 'member', built: true,  commands: [],   // /suggest → /dashboard button; /suggest-setup → /panel Setup
    help: { name: '💡 Suggest an idea', value: 'Have an idea to make the server better? Open **/dashboard** and tap **💡 Suggest**. It posts for the community to vote 👍/👎, and staff review the ones people like. One clear idea per suggestion works best.' } },
  { key: 'confessions', audience: 'member', built: true,  commands: [],   // /confess → /dashboard button; /confess-setup → /panel Setup
    help: { name: '🤫 Anonymous confession', value: 'Get something off your chest. Open **/dashboard** and tap **💭 Confess**. It posts to the confessions channel with **your name hidden from other members**. Vents, shy shout-outs, hot takes. Be kind; the safety filter still applies.' } },
  { key: 'whistleblow', audience: 'member', built: true,  commands: ['whistleblow'],   // whistleblow-setup → /panel Setup
    help: { name: '🕊️ `/whistleblow`: flag a problem safely', value: 'Privately raise a problem with the server or a mod. **You** choose who (if anyone) can ever see it was you, even “no one.” Nobody gets in trouble for being honest. Use it when a normal report isn’t enough.' } },
  { key: 'reports',     audience: 'member', built: true,  commands: [], contexts: ['Report'],   // /report → /dashboard button + right-click; /report-setup → /panel Setup
    help: { name: '🚩 Report a member or message', value: 'Report a member or a specific message to staff **without them knowing it was you**. Open **/dashboard** and tap **🚩 Report**, or right-click any message → Apps → Report to attach it. Staff see what you send, not that it came from you.' } },
  { key: 'sidebar',     audience: 'staff',  built: true,  commands: ['sidebar', 'sidebar-setup'], contexts: ['Sidebar'],   // staff pull a member (or several) aside into a private thread; not punishment, no role strips
    help: { name: '🗣️ `/sidebar`', value: 'Staff can pull someone aside for a quiet private chat — `/sidebar @member`, or right-click them → Apps → Sidebar. Opens a private thread only they and staff can see.' } },
  { key: 'modmail',     audience: 'member', built: true,  commands: [],   // /modmail → /dashboard button; /modmail-setup → /panel Setup
    help: { name: '📨 Message the mods privately', value: 'Send the mod team a private, anonymous note: a question, a concern, or a heads-up you’d rather not say out loud. Open **/dashboard** and tap **✉️ Message staff**. It lands in a mods-only inbox; you can reply if they follow up.' } },
  { key: 'modapps',     audience: 'member', built: true,  commands: ['apply-mod', 'demote-trial', 'demote-mod', 'demote-admin', 'mod-applications', 'promote-trial', 'promote-mod'],   // apply-mod-setup → /panel Setup. mod-applications/promote-trial/promote-mod were all BUILT (full SlashCommandBuilder + handlers) but missing from this list, so Discord never registered any of them — same class of bug as the /ban registry gap (2026-08-14). All 3 also reachable via /panel (Actions/Promotions). demote-mod/demote-admin added 2026-08-16 alongside the existing demote-trial.
    help: { name: '📋 `/apply-mod`: apply to be a mod', value: 'Want to help run the place? `/apply-mod` opens a short form (age, timezone, why, experience). It creates a private thread where staff can ask follow-ups and you’ll hear back, nothing is public.' } },
  { key: 'eventOrgApps', audience: 'member', built: true, commands: ['apply-event-organizer', 'event-organizer-applications'],   // event-organizer-setup → /panel Setup, same consolidation as apply-mod-setup
    help: { name: '🎪 `/apply-event-organizer`: apply to run events', value: 'Want to run community events? `/apply-event-organizer` opens a short form (why, availability, an event idea). Staff review it in a private thread; you’ll hear back either way.' } },
  // Media Team (LIVE) — the merged Advertiser + Content Creator position (owner, 2026-08-22: "i was
  // thinking advertisers would be creators"). Owns the application commands AND both submission flows:
  // /create (→ #showcase) and /advertise (→ TikTok staging).
  { key: 'mediaApps', audience: 'member', built: true, commands: ['apply-media', 'media-applications', 'create', 'advertise'],
    help: { name: '🎬 `/apply-media`: join the Media Team', value: 'Love making clips, art, memes, or promos? `/apply-media` opens a short form. Media Team members use `/create submit` to post content to **#showcase**, and `/advertise submit` to send promo clips for the server’s socials — both go through staff approval.' } },
  // Greeter + Support Helper: application-gated helper positions, DARK until turned on with /features.
  { key: 'greeterApps', audience: 'member', built: false, commands: ['apply-greeter', 'greeter-applications'],
    help: { name: '👋 `/apply-greeter`: welcome new members', value: 'Enjoy making people feel at home? `/apply-greeter` opens a short form. Greeters help welcome and onboard new members.' } },
  { key: 'supportApps', audience: 'member', built: false, commands: ['apply-support', 'support-applications'],
    help: { name: '🛟 `/apply-support`: help members in the support space', value: 'Good at helping people out? `/apply-support` opens a short form. Support Helpers answer questions in the help space.' } },
  // Hit squad (owner, 2026-08-17): grants named members temporary corner power against almost anyone,
  // even staff, for a 10-minute window. Starts DARK — deliberately not on by default given the blast
  // radius; an admin turns it on with /features when they actually want it live.
  { key: 'hitsquad', audience: 'core', built: false, commands: ['hitsquad'] },
  { key: 'rolereq',     audience: 'member', built: true,  commands: ['request-role'],   // request-role-setup → /panel Setup
    help: { name: '🎭 `/request-role`: ask for (or drop) a role', value: 'Ask for a casual role, or hand one back. Staff get your request with one-click approve/deny; if approved it’s added (or removed) for you. Cosmetic/interest roles only, not staff or age roles.' } },
  { key: 'roleselect',  audience: 'staff',  built: true,  commands: ['roleselect-role'] }, // #roles picker itself has no command (built by a one-off script); this is just the admin add/remove tool
  { key: 'birthday',    audience: 'member', built: true,  commands: ['birthday'],
    help: { name: '🎂 `/birthday`: set your birthday', value: 'Set your birthday with `/birthday set` and you\'ll get a 🎂 Birthday role for the day, every year.' } },
  { key: 'awards',      audience: 'member', built: true,  commands: ['awards'],
    help: { name: '🏆 `/awards`: weekly member awards', value: 'Vote for someone (not yourself) in a category like Funniest Member with `/awards vote`. Winners are announced every Friday and get the role for the week.' } },
  { key: 'diceRoll',    audience: 'member', built: true,  commands: ['roll'],   // owner, 2026-08-25 (#organizer-chat): "add a command to roll 1 die and 2 dice" — generalized to N dice/N sides
    help: { name: '🎲 `/roll`: roll dice', value: 'Roll dice for an event or a game — `/roll` rolls 1d6, or set `sides`/`dice` for anything else (e.g. `sides:12 dice:2`).' } },
  { key: 'partners',    audience: 'staff',  built: true,  commands: ['partner'] },   // owner, 2026-08-26: partner-server cards in a dedicated channel; /partner setup|add|remove|list|reveal (admin+). Channel builds hidden, revealed as a separate step.
  { key: 'permguard',   audience: 'core',   built: true,  commands: ['permguard'] }, // channel-permission drift guard (auto-sweep + owner resnapshot command)
  { key: 'roleCategory', audience: 'core',  built: false, commands: ['role-category'] }, // role-category band guard: keeps roles inside their category, prompts to file new roles. DARK until the manifest is seeded from the reorder, then /features toggle roleCategory on + restart.
  { key: 'ownerPingRelay', audience: 'core', built: false }, // DM the owner when Mod/Admin/tribe-Leader roles they don't hold get @-pinged (backfills pings they'd miss). No command; enable per-guild via /features. FUBU-only.
  { key: 'perms',       audience: 'core',   built: true,  commands: ['perms'] }, // bot-owner permission inspector/auditor (tier view, channel access, grand audit)
  { key: 'contest',     audience: 'member', built: true,  commands: ['contest', 'contest-submit', 'event-award'],
    help: { name: '🎨 `/contest-submit`: enter the monthly contest', value: 'Each month there\'s a **Drawing**, **Photography** and **Writing** contest with a theme. Post your entry in its channel (one per person) and **vote with 🩷**: most reactions wins the 🏆 Contest Winner role! Want to stay anonymous? `/contest-submit` posts your entry with your name hidden. Organizers run it with `/contest`.' } },

  // ---- planned / dark (seeded OFF) ----
  // 'appeal' is shared by BOTH appeal features below (ban subcommand vs. strike subcommand) — it's
  // listed in both features' commands[] so the command registers if EITHER is on; index.js gates each
  // subcommand against its own feature flag individually (a single command -> single feature isn't
  // enough once one command has independently-toggleable subcommands).
  { key: 'appeals',      audience: 'member', built: false, commands: ['appeal', 'appeal-reset'],   // appeal-setup → /panel Setup
    help: { name: '⚖️ `/appeal ban`: appeal a friend’s ban', value: 'A banned friend can’t reach the server, so **you** can appeal for them: `/appeal ban <their @username>` opens a private thread for you and staff, and up to 5 friends can join to make the case. Not eligible for the 4 non-negotiable ban categories (false verification, verification bypass, ban evasion, confirmed grooming).' } },
  { key: 'strikeAppeals', audience: 'member', built: false, commands: ['appeal'],   // appeal-strike-setup → /panel Setup
    help: { name: '⚖️ `/appeal strike`: appeal your own strike', value: 'Think a strike was unfair? `/appeal strike` opens a private thread just for you and staff to explain your side. One at a time; a denied appeal has a short cooldown before you can retry. The strike that crossed the ban threshold isn’t appealable this way.' } },
  { key: 'smartWatch',   audience: 'core',   built: false,  commands: ['grade'] }, // LLM contextual judge on the watch pipeline - cuts keyword false positives (needs ANTHROPIC_API_KEY; shadow-mode-first via SMARTWATCH_LIVE). /grade = owner-only card grading.
  { key: 'smartWatchLab', audience: 'core',  built: false }, // Eval sandbox: expanded terms + AI verdicts posted to a private admin lab channel, gradable to train the judge. When ON, the public watch-log reverts to plain keyword flags (AI moves to the lab). Needs SMARTWATCH_LAB_CHANNEL_ID.
  { key: 'achievements', audience: 'member', built: true,    // tribe achievements + equippable titles (Phase 6). Surfaced via the throne 🏅 Trophies button; no new commands. LIVE (owner: achievements go live now).
    help: { name: '🏅 Achievements & titles', value: 'Earn achievements for your tribe deeds (arena MVPs, play streaks, war wins, crowns, Ages) and equip a title to show off. Open your tribe’s throne panel and tap 🏅 Trophies.' } },
  { key: 'recruitment', audience: 'member', built: false,   // reward recruiting members in + tribe growth milestones (Phase 6). No new commands; auto-awards on nomination/invite accept. DARK until tuned + flipped on (/features toggle recruitment on).
    help: { name: '🌱 Recruitment rewards', value: 'Bring people into your tribe: when someone you nominate or invite joins, you earn points and your tribe banks treasury, and every tribe earns a bonus at member-count milestones.' } },
  { key: 'tribeQuests', audience: 'member', built: true,    // weekly tribe objectives that pay Treasury/Glory (Phase 7 depth). No new command; surfaced on the throne + hub, auto-pays on completion. LIVE.
    help: { name: '🎯 Weekly quests', value: 'Every week the tribes share three objectives (win Arena contests, answer musters, win a war, take the Crown). Finish one and your tribe banks Treasury and Glory. See them on your throne’s 🎯 Quests view.' } },
  { key: 'relics',      audience: 'member', built: true,    // Age-end trophies: permanent name/lore + a tiny, capped, cross-Age-decaying perk; raidable in wars (Phase 7 depth). On the throne. LIVE.
    help: { name: '🏺 Relics', value: 'A tribe that wins an Age is minted a Relic: a permanent trophy on your throne, plus a small edge that stacks with more Relics but fades over the Ages so nobody runs away with it forever. Relics can be lost in war.' } },
  { key: 'prestige',    audience: 'member', built: true,    // capped-out members Prestige for a permanent title (Phase 7 depth), ties into achievements. Throne button. LIVE.
    help: { name: '⭐ Prestige', value: 'Maxed out your tribe rank? Prestige to reset your climb for a permanent honour title and a lasting mark in your tribe’s history. Find it on your throne once you reach the top rung.' } },
  // ---- Throne-competition modes (specs: SEALED_ARENA / THE_TRIALS / PROVING_GROUNDS). Built DARK, flipped when tuned. ----
  { key: 'sealedArena',   audience: 'member', built: false,  // sealed arena: every tribe runs the same live challenge blind in its own throne, race-the-clock scored, staged reveal. No new command; scheduled + staff launch.
    help: { name: '🚪 Sealed Arena', value: 'The whole server competes at once, but each tribe races behind closed doors in its own throne, blind to the rest. Go all out, then the results are revealed to everyone.' } },
  { key: 'theTrials',     audience: 'member', built: false,  // the trials: collaborative sealed mode, breadth + voice scored, evolution of the Muster. Scheduled + leader-rallied.
    help: { name: '⚔️ The Trials', value: 'Rally your tribe into your voice channel and take on a Trial together. Everyone who chips in counts, and the tribe that pulls together best wins the reveal.' } },
  { key: 'provingGrounds', audience: 'member', built: false, commands: ['prove'], // proving grounds: solo async daily gauntlet, per-member seeds, weekly Prover track. Ephemeral.
    help: { name: '🏅 Proving Grounds', value: 'A solo daily gauntlet you run on your own time. Climb the daily leaderboard and the weekly Prover track, and your score still earns for your tribe.' } },
  // Member-founded tribe: a regular member (not staff) may found ONE tribe, backed by 9 member/trial-mod cosigns,
  // one at a time server-wide (owner 2026-08-05). Gated on the `/tribe found` subcommand handler. Built DARK.
  { key: 'memberFoundedTribe', audience: 'member', built: false }, // no help entry → stays out of the bot guide; no own command (subcommand of /tribe)
  { key: 'cornerReason', audience: 'core',   built: false }, // right-click "Send to corner" asks for an optional reason
  { key: 'timeServed',   audience: 'core',   built: false }, // release shows how long they were in the corner
  { key: 'langMiniMod',  audience: 'core',   built: false }, // language mini-mod role may use Send-to-corner + Report-to-watchlist
  { key: 'memberCorner', audience: 'core',   built: false }, // FUBU-only: a VERIFIED member may corner one non-staff member (≤5m, 3/day cap, NO rule/reason so it never feeds corner→strike conversion). Off elsewhere. Registration-affecting: flips /corner + "Send to corner" visibility.
  { key: 'amongUs',      audience: 'member', built: false, commands: ['amongus'], // VC "Among Us mode": staff /amongus starts a game for their VC; a panel toggles mute phases (Lobby/Play/Discussion) + dead tracking. Anyone in the VC drives it. Registration-affecting.
    help: { name: '🔴 Among Us mode', value: 'Playing Among Us in a voice channel? A mod runs `/amongus` to start a game, then anyone in the VC uses the panel to mute for the round and unmute for discussion (dead players stay muted).' } },
  { key: 'mafia',        audience: 'member', built: false, commands: ['mafia'], // VC "Mafia mode": a FULL engine (unlike amongUs) — the bot deals secret roles, collects night actions, resolves them, and calls the win condition. Voice mode mutes+deafens the town at Night so only Mafia can talk; text mode gives Mafia a private thread. Registration-affecting.
    help: { name: '🔪 Mafia mode', value: 'A mod runs `/mafia start` in a voice channel\'s chat to open a lobby. Join, get a secret role, then survive: Mafia kill each Night, the Doctor saves, the Detective investigates, and everyone votes someone out each Day.' } },
  // Tribe Games (staff-recorded external-game events) + Tribe Lore evolution paths + Propaganda's daily
  // reaction payout, all reached via /tribe panel (a subcommand of the always-on 'tribes' feature, so gating
  // visibility means gating the HANDLER, not command registration). Built 2026-08-10, kept DARK on purpose
  // (owner: "let's keep it dark for now, I need details first") — /tribe panel replies "not live yet" while off.
  { key: 'tribePanel',   audience: 'member', built: false,
    help: { name: '🏛️ Tribe Panel', value: '`/tribe panel` — one place for Tribe Games (staff), your tribe\'s lore/evolution paths, and rep-setting.' } },
  // Button-entry timed giveaways (owner, 2026-08-23). Admin-hosted: /giveaway start posts an embed with an
  // Enter button; members click to join (must be Verified + have joined before it started); a sweep draws
  // random winner(s) when the window closes. Registration-affecting. Starts DARK — flip on with /features.
  { key: 'giveaways',    audience: 'member', built: false, commands: ['giveaway'],
    help: { name: '🎀 Giveaways', value: 'Staff run **/giveaway start** with a prize and a time window. Hit the **🎀 Enter** button to join — you must be Verified and have been in the server since before the giveaway started. Winners are drawn at random when it ends.' } },
  // Copy (or move) a recent window of messages from one channel to another, reposted under each original
  // author's name/avatar via a self-authorized webhook (owner, 2026-08-23). Admin-only, built + live.
  { key: 'messageMigrate', audience: 'staff', built: true, commands: ['migrate-messages'] },
];
// Retired (superseded by the weighted-strike model in strikes.js — always on now, not flag-gated):
// 'strikeReason' (weight+reason are core to every strike now) and 'fiveStrikes' (replaced by the
// 10-unit ban threshold, which always shows a Confirm button, never auto-bans).

// enabled() is called on every message (word-filter + smart-watch gates), so a sync readFileSync each time
// saturates the event loop in busy channels (this starved interactions like Send-to-corner). 2s TTL cache;
// save() refreshes it immediately, so a toggle takes effect at once and reads between toggles are cheap.
let _cache = null, _cacheAt = 0;
// On a read FAILURE, keep the last good cache instead of resetting to {} (audit U9): with FAIL-OFF
// semantics below, a transient EACCES/ENOENT (the root-owned-state-file class, hit twice on this fleet)
// used to flip EVERY feature off live within 2 seconds, silently. Only a file that genuinely parses
// replaces the cache; the very first load having no fallback still yields {} (correct: nothing seeded yet).
const load = () => {
  const n = Date.now();
  if (_cache && n - _cacheAt < 2000) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')); }
  catch (e) {
    if (_cache) { console.error(`[features] read failed (${e.message}) — keeping last good flags`); }
    else { _cache = {}; }
  }
  _cacheAt = n;
  return _cache;
};
const save = f => { _cache = f; _cacheAt = Date.now(); try { fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.error('[features] save:', e.message); } };

// FAIL-OFF: on only when explicitly true.
function enabled(key) { return load()[key] === true; }
// Flip a flag and persist it. Registration-affecting flags (own commands/contexts) need a bot restart
// to fully take effect; everything else (checked live via enabled() at interaction time) applies immediately.
function setEnabled(key, on) { const f = load(); f[key] = !!on; save(f); }
function needsRestart(key) { const r = get(key); return !!(r && (r.commands || r.contexts)); }
// Seed any missing keys from the registry (built => true). Never overrides an existing value.
function ensureSeeded() { const f = load(); let ch = false; for (const r of REGISTRY) if (!(r.key in f)) { f[r.key] = !!r.built; ch = true; } if (ch) save(f); return f; }
function get(key) { return REGISTRY.find(r => r.key === key); }
// slash + context command names that should be registered (enabled features only)
function enabledCommandNames() { const s = new Set(); for (const r of REGISTRY) if (enabled(r.key)) { (r.commands || []).forEach(n => s.add(n)); (r.contexts || []).forEach(n => s.add(n)); } return s; }
// map a command / context-menu name -> its feature key
function featureForCommand(name) { return REGISTRY.find(r => (r.commands || []).includes(name) || (r.contexts || []).includes(name))?.key; }
// Tribe features document themselves in the Tribe Hub (its own guide) — they don't belong in the
// general bot guide, which is for what a normal member uses the bot for. Excluded from memberHelp.
const TRIBE_HELP_KEYS = new Set(['tribes', 'achievements', 'recruitment', 'tribeQuests', 'relics', 'prestige', 'sealedArena', 'theTrials', 'provingGrounds']);
// member-facing help entries for enabled features (for /help + the guide) — tribe features excluded (see above)
function memberHelp() { return REGISTRY.filter(r => r.audience === 'member' && enabled(r.key) && r.help && !TRIBE_HELP_KEYS.has(r.key)).map(r => r.help); }

module.exports = { REGISTRY, enabled, setEnabled, needsRestart, load, save, ensureSeeded, get, enabledCommandNames, featureForCommand, memberHelp };
