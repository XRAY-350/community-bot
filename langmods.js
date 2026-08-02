// langmods.js - per-language mini-mod roles. Each language (French/German/Dutch/Hispanic) has its OWN
// role whose holder may use Send-to-corner + Report-to-watchlist, but ONLY in that language's channels
// (text + VC). Replaces the old single langMiniModRoleId model. Config file:
//   /home/ubuntu/.fubu_langmods.json = { "<Language>": { roleId, channelIds: [textId, vcId] }, ... }
const fs = require('fs');
const CONFIG_FILE = process.env.FUBU_LANGMODS_FILE || '/home/ubuntu/.fubu_langmods.json';

function load() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function languages() { return Object.keys(load()); }
function roleForLang(lang) { return load()[lang]?.roleId || null; }
// { lang, roleId, channelIds } for a given role id, or null.
function entryForRole(roleId) { const m = load(); for (const lang of Object.keys(m)) if (m[lang].roleId === roleId) return { lang, ...m[lang] }; return null; }
// True iff the member holds a language-mini-mod role whose channels include channelId. (Feature-gating is
// the caller's job - this only answers the role↔channel scoping question.)
function canActOn(member, channelId) {
  if (!member?.roles?.cache || !channelId) return false;
  const m = load();
  for (const lang of Object.keys(m)) {
    const e = m[lang];
    if (e.roleId && member.roles.cache.has(e.roleId) && (e.channelIds || []).includes(channelId)) return true;
  }
  return false;
}
function isConfigured() { return languages().length > 0; }

module.exports = { load, languages, roleForLang, entryForRole, canActOn, isConfigured, CONFIG_FILE };
