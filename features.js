// features.js — single source of truth for the bot's features. Drives command registration,
// handler gating, /help, and the server-guide. The registry holds each feature's display info
// AND design metadata, so features stay coherent (the "thought process") instead of being islands.
//
// FAIL-OFF: a feature is enabled only if its flag is EXPLICITLY true in .fubu_features.json.
// Nothing is on by default. The already-built features are seeded true because they exist and are
// running today — not because they're privileged. Planned features are seeded false (dark) until
// someone flips them on.
const fs = require('fs');
const FLAGS_FILE = process.env.FUBU_FEATURES_FILE || '/home/ubuntu/.fubu_features.json';

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
  { key: 'corner',      audience: 'staff',  built: true,  commands: ['corner', 'uncorner', 'cornered', 'stats'], contexts: ['Send to corner'] },
  { key: 'strikes',     audience: 'staff',  built: true,  commands: ['strike', 'weights'], contexts: ['Strike'] },
  { key: 'wordFilter',  audience: 'staff',  built: true,  commands: ['wordfilter'] }, // temporary auto-delete of messages containing a set word/phrase
  { key: 'levelCheck',  audience: 'staff',  built: true,  commands: ['levelcheck'] }, // audit Arcane level roles landing (reads #bot-commands log) + admin resync-fix
  { key: 'tribes',      audience: 'member', built: true,  commands: ['tribe', 'tribe-admin'], // member-run factions: hub/roster/standings/motto + Warden tools + admin create/register (ranks + rivalry to come)
    help: { name: '🏴 Tribes', value: 'Join a tribe with `/request-role`, then `/tribe info`, `/tribe roster`, and `/tribe list` for standings. Leaders set the vibe with `/tribe motto`.' } },
  { key: 'watchlist',   audience: 'staff',  built: true,  commands: ['watchlist', 'watchlist-terms', 'watchlist-suggest', 'unban'], contexts: ['Report to watchlist'] },
  { key: 'suggestions', audience: 'member', built: true,  commands: ['suggest', 'suggest-setup'],
    help: { name: '💡 `/suggest` — pitch an idea', value: 'Have an idea to make the server better? `/suggest` posts it for the community to vote 👍/👎, and staff review the ones people like. One clear idea per suggestion works best.' } },
  { key: 'confessions', audience: 'member', built: true,  commands: ['confess', 'confess-setup'],
    help: { name: '🤫 `/confess` — anonymous confession', value: 'Get something off your chest — `/confess` posts it to the confessions channel with **your name hidden from other members**. Vents, shy shout-outs, hot takes. Be kind; the safety filter still applies.' } },
  { key: 'whistleblow', audience: 'member', built: true,  commands: ['whistleblow', 'whistleblow-setup'],
    help: { name: '🕊️ `/whistleblow` — flag a problem safely', value: 'Privately raise a problem with the server or a mod. **You** choose who (if anyone) can ever see it was you — even “no one.” Nobody gets in trouble for being honest. Use it when a normal report isn’t enough.' } },
  { key: 'reports',     audience: 'member', built: true,  commands: ['report', 'report-setup'], contexts: ['Report'],
    help: { name: '🚩 `/report` · or right-click a message → **Apps → Report**', value: 'Report a member or a specific message to staff **without them knowing it was you**. Right-click any message → Apps → Report to attach it. Staff see what you send — not that it came from you.' } },
  { key: 'modmail',     audience: 'member', built: true,  commands: ['modmail', 'modmail-setup'],
    help: { name: '📨 `/modmail` — message the mods privately', value: 'Send the mod team a private, anonymous note — a question, a concern, or a heads-up you’d rather not say out loud. It lands in a mods-only inbox; you can reply if they follow up.' } },
  { key: 'modapps',     audience: 'member', built: true,  commands: ['apply-mod', 'apply-mod-setup', 'mod-applications', 'demote-trial', 'promote-trial', 'promote-mod'],
    help: { name: '📋 `/apply-mod` — apply to be a mod', value: 'Want to help run the place? `/apply-mod` opens a short form (age, timezone, why, experience). It creates a private thread where staff can ask follow-ups and you’ll hear back — nothing is public.' } },
  { key: 'rolereq',     audience: 'member', built: true,  commands: ['request-role', 'request-role-setup'],
    help: { name: '🎭 `/request-role` — ask for (or drop) a role', value: 'Ask for a casual role — or hand one back. Staff get your request with one-click approve/deny; if approved it’s added (or removed) for you. Cosmetic/interest roles only — not staff or age roles.' } },
  { key: 'roleselect',  audience: 'staff',  built: true,  commands: ['roleselect-role'] }, // #roles picker itself has no command (built by a one-off script); this is just the admin add/remove tool
  { key: 'permguard',   audience: 'core',   built: true,  commands: ['permguard'] }, // channel-permission drift guard (auto-sweep + owner resnapshot command)
  { key: 'perms',       audience: 'core',   built: true,  commands: ['perms'] }, // bot-owner permission inspector/auditor (tier view, channel access, grand audit)
  { key: 'contest',     audience: 'member', built: true,  commands: ['contest', 'contest-submit'],
    help: { name: '🎨 `/contest-submit` — enter the monthly contest', value: 'Each month there\'s a **Drawing**, **Photography** and **Writing** contest with a theme. Post your entry in its channel (one per person) and **vote with 🩷** — most reactions wins the 🏆 Contest Winner role! Want to stay anonymous? `/contest-submit` posts your entry with your name hidden. Organizers run it with `/contest`.' } },

  // ---- planned / dark (seeded OFF) ----
  // 'appeal' is shared by BOTH appeal features below (ban subcommand vs. strike subcommand) — it's
  // listed in both features' commands[] so the command registers if EITHER is on; index.js gates each
  // subcommand against its own feature flag individually (a single command -> single feature isn't
  // enough once one command has independently-toggleable subcommands).
  { key: 'appeals',      audience: 'member', built: false, commands: ['appeal', 'appeal-setup', 'appeal-reset'],
    help: { name: '⚖️ `/appeal ban` — appeal a friend’s ban', value: 'A banned friend can’t reach the server, so **you** can appeal for them: `/appeal ban <their @username>` opens a private thread for you and staff, and up to 5 friends can join to make the case. Not eligible for the 4 non-negotiable ban categories (false verification, verification bypass, ban evasion, confirmed grooming).' } },
  { key: 'strikeAppeals', audience: 'member', built: false, commands: ['appeal', 'appeal-strike-setup'],
    help: { name: '⚖️ `/appeal strike` — appeal your own strike', value: 'Think a strike was unfair? `/appeal strike` opens a private thread just for you and staff to explain your side. One at a time; a denied appeal has a short cooldown before you can retry. The strike that crossed the ban threshold isn’t appealable this way.' } },
  { key: 'smartWatch',   audience: 'core',   built: false,  commands: ['grade'] }, // LLM contextual judge on the watch pipeline - cuts keyword false positives (needs ANTHROPIC_API_KEY; shadow-mode-first via SMARTWATCH_LIVE). /grade = owner-only card grading.
  { key: 'smartWatchLab', audience: 'core',  built: false }, // Eval sandbox: expanded terms + AI verdicts posted to a private admin lab channel, gradable to train the judge. When ON, the public watch-log reverts to plain keyword flags (AI moves to the lab). Needs SMARTWATCH_LAB_CHANNEL_ID.
  { key: 'cornerReason', audience: 'core',   built: false }, // right-click "Send to corner" asks for an optional reason
  { key: 'timeServed',   audience: 'core',   built: false }, // release shows how long they were in the corner
  { key: 'langMiniMod',  audience: 'core',   built: false }, // language mini-mod role may use Send-to-corner + Report-to-watchlist
];
// Retired (superseded by the weighted-strike model in strikes.js — always on now, not flag-gated):
// 'strikeReason' (weight+reason are core to every strike now) and 'fiveStrikes' (replaced by the
// 10-unit ban threshold, which always shows a Confirm button, never auto-bans).

const load = () => { try { return JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')); } catch { return {}; } };
const save = f => { try { fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.error('[features] save:', e.message); } };

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
// member-facing help entries for enabled features (for /help + the guide)
function memberHelp() { return REGISTRY.filter(r => r.audience === 'member' && enabled(r.key) && r.help).map(r => r.help); }

module.exports = { REGISTRY, enabled, setEnabled, needsRestart, load, save, ensureSeeded, get, enabledCommandNames, featureForCommand, memberHelp };
