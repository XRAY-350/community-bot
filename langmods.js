// langmods.js — per-scope mini-mod roles. Originally per-language (French/German/Dutch/Hispanic), each
// with its OWN role whose holder may use Send-to-corner + Report-to-watchlist, but ONLY in that scope's
// channels (text + VC). Generic enough to reuse for any topic-scoped mini-mod, not just languages (e.g.
// the LGBTQ+ chat mini-mod, 2026-08-13) — the "language" key is just a label, nothing validates it's an
// actual language. Config file:
//   /home/ubuntu/.fubu_langmods.json = { "<Label>": { roleId, channelIds: [textId, vcId, forumId, ...] }, ... }
const fs = require('fs');
const { statePath } = require('./statepath');
const CONFIG_FILE = process.env.FUBU_LANGMODS_FILE || statePath('langmods.json');

function load() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function languages() { return Object.keys(load()); }
function roleForLang(lang) { return load()[lang]?.roleId || null; }
// { lang, roleId, channelIds } for a given role id, or null.
function entryForRole(roleId) { const m = load(); for (const lang of Object.keys(m)) if (m[lang].roleId === roleId) return { lang, ...m[lang] }; return null; }
// True iff the member holds a mini-mod role whose channels include channelId — OR, when a channel object
// is passed instead of a bare id (or `guild` is given so a thread's parent can be resolved), the THREAD's
// parent channel. Needed for forum-backed scopes (e.g. the LGBTQ+ forum): a flagged message inside one of
// the forum's topic posts has the POST's own thread id, not the forum's — without resolving the parent, a
// mini-mod configured for the forum would never match inside any of its actual discussion threads.
// Feature-gating is the caller's job — this only answers the role↔channel scoping question.
function canActOn(member, channelId, guild) {
  if (!member?.roles?.cache || !channelId) return false;
  const ids = [channelId];
  if (guild) {
    const ch = guild.channels.cache.get(channelId);
    if (ch?.isThread?.() && ch.parentId) ids.push(ch.parentId);
  }
  const m = load();
  for (const lang of Object.keys(m)) {
    const e = m[lang];
    if (e.roleId && member.roles.cache.has(e.roleId) && (e.channelIds || []).some(id => ids.includes(id))) return true;
  }
  return false;
}
function isConfigured() { return languages().length > 0; }

module.exports = { load, languages, roleForLang, entryForRole, canActOn, isConfigured, CONFIG_FILE };
