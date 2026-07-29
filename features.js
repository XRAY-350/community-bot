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
  { key: 'verify',      audience: 'core',   built: true,  commands: ['pending'] },
  { key: 'panel',       audience: 'staff',  built: true,  commands: ['panel'] },
  { key: 'help',        audience: 'core',   built: true,  commands: ['help'] },
  { key: 'corner',      audience: 'staff',  built: true,  commands: ['corner', 'uncorner', 'cornered'], contexts: ['Send to corner'] },
  { key: 'strikes',     audience: 'staff',  built: true,  commands: ['strike'], contexts: ['Strike'] },
  { key: 'watchlist',   audience: 'staff',  built: true,  commands: ['watchlist', 'watchlist-terms', 'watchlist-suggest', 'unban'], contexts: ['Report to watchlist'] },
  { key: 'suggestions', audience: 'member', built: true,  commands: ['suggest', 'suggest-setup'],
    help: { name: '💡 `/suggest`', value: 'Drop an idea for the server — the community votes, staff review.' } },
  { key: 'confessions', audience: 'member', built: true,  commands: ['confess', 'confess-setup'],
    help: { name: '🤫 `/confess`', value: 'Post a confession anonymously — your name is hidden from other members.' } },
  { key: 'whistleblow', audience: 'member', built: true,  commands: ['whistleblow', 'whistleblow-setup'],
    help: { name: '🕊️ `/whistleblow`', value: 'Privately flag a problem with the server or a mod. **You** choose who (if anyone) can ever see it was you — even “no one.” Nobody gets banned for being honest.' } },
  { key: 'reports',     audience: 'member', built: true,  commands: ['report', 'report-setup'], contexts: ['Report'],
    help: { name: '🚩 `/report`  ·  or right-click a message → **Apps → Report**', value: 'Report someone without them knowing it was you.' } },
  { key: 'modmail',     audience: 'member', built: true,  commands: ['modmail', 'modmail-setup'],
    help: { name: '📨 `/modmail`', value: 'Send the mod team a private, anonymous message.' } },
  { key: 'modapps',     audience: 'member', built: true,  commands: ['apply-mod', 'apply-mod-setup'],
    help: { name: '📋 `/apply-mod`', value: 'Apply to become a moderator.' } },
  { key: 'rolereq',     audience: 'member', built: true,  commands: ['request-role', 'request-role-setup'],
    help: { name: '🎭 `/request-role`', value: 'Ask for a casual role — staff approve and it’s yours.' } },

  // ---- planned / dark (seeded OFF) ----
  { key: 'appeals',      audience: 'member', built: false, commands: ['appeal', 'appeal-setup'],
    help: { name: '⚖️ `/appeal`', value: 'Appeal a friend’s ban on their behalf — opens a private thread for you and staff.' } },
  { key: 'strikeReason', audience: 'core',   built: false }, // strikes record + show a reason (in-channel, no DM)
  { key: 'cornerReason', audience: 'core',   built: false }, // right-click "Send to corner" asks for an optional reason
  { key: 'timeServed',   audience: 'core',   built: false }, // release shows how long they were in the corner
  { key: 'fiveStrikes',  audience: 'core',   built: false }, // 5-strike ladder; the 5th strike = ban (with a confirm)
  { key: 'langMiniMod',  audience: 'core',   built: false }, // language mini-mod role may use Send-to-corner + Report-to-watchlist
];

const load = () => { try { return JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')); } catch { return {}; } };
const save = f => { try { fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.error('[features] save:', e.message); } };

// FAIL-OFF: on only when explicitly true.
function enabled(key) { return load()[key] === true; }
// Seed any missing keys from the registry (built => true). Never overrides an existing value.
function ensureSeeded() { const f = load(); let ch = false; for (const r of REGISTRY) if (!(r.key in f)) { f[r.key] = !!r.built; ch = true; } if (ch) save(f); return f; }
function get(key) { return REGISTRY.find(r => r.key === key); }
// slash + context command names that should be registered (enabled features only)
function enabledCommandNames() { const s = new Set(); for (const r of REGISTRY) if (enabled(r.key)) { (r.commands || []).forEach(n => s.add(n)); (r.contexts || []).forEach(n => s.add(n)); } return s; }
// map a command / context-menu name -> its feature key
function featureForCommand(name) { return REGISTRY.find(r => (r.commands || []).includes(name) || (r.contexts || []).includes(name))?.key; }
// member-facing help entries for enabled features (for /help + the guide)
function memberHelp() { return REGISTRY.filter(r => r.audience === 'member' && enabled(r.key) && r.help).map(r => r.help); }

module.exports = { REGISTRY, enabled, load, save, ensureSeeded, get, enabledCommandNames, featureForCommand, memberHelp };
