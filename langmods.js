// langmods.js — per-scope mini-mod roles. Originally per-language (French/German/Dutch/Hispanic), each
// with its OWN role whose holder may use Send-to-corner + Report-to-watchlist, but ONLY in that scope's
// space. Generic enough to reuse for any topic-scoped mini-mod, not just languages (e.g. the LGBTQ+ chat
// mini-mod, 2026-08-13) — the "language" key is just a label, nothing validates it's an actual language.
//
// SCOPE = the whole CATEGORY when one is set (owner, 2026-08-22: "lang minimods have authority in the
// whole category"). A scope covers a category ONLY via an EXPLICIT `categoryId`/`categoryIds` on the entry
// — deliberately NOT auto-derived from the channels' parent, because a scope's channels can live in a
// SHARED category (e.g. LGBTQ's channels sit in the general Community category alongside 15+ unrelated
// ones); deriving there would hand the mini-mod the whole general community. So: set categoryId when a
// scope has its own dedicated category (a mini-mod then covers every channel in it, present + future);
// leave it unset to stay scoped to the explicit `channelIds` only.
// Config file: statePath('langmods.json') =
//   { "<Label>": { roleId, channelIds: [textId, vcId, forumId, ...], categoryId?, categoryIds?[] }, ... }
const fs = require('fs');
const { statePath } = require('./statepath');
const CONFIG_FILE = process.env.FUBU_LANGMODS_FILE || statePath('langmods.json');
const CATEGORY_TYPE = 4;   // ChannelType.GuildCategory

function load() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function languages() { return Object.keys(load()); }
function roleForLang(lang) { return load()[lang]?.roleId || null; }
// { lang, roleId, channelIds, categoryId? } for a given role id, or null.
function entryForRole(roleId) { const m = load(); for (const lang of Object.keys(m)) if (m[lang].roleId === roleId) return { lang, ...m[lang] }; return null; }

// The set of category ids a scope covers — EXPLICIT only (categoryId / categoryIds). No derive-from-parent
// (see the header note: a scope's channels can sit in a shared category, so deriving over-broadens).
function scopeCategories(entry) {
  return new Set([...(entry.categoryIds || []), entry.categoryId].filter(Boolean));
}

// True iff the member holds a mini-mod role whose scope covers channelId — by explicit channel match OR by
// the channel living under the scope's category. `guild` lets us resolve categories AND a thread's parent
// (a flagged message inside a forum post carries the POST's thread id, not the forum's — without resolving
// the parent, a forum-backed scope would never match inside its own discussion threads).
// Feature-gating is the caller's job — this only answers the role↔channel scoping question.
function canActOn(member, channelId, guild) {
  if (!member?.roles?.cache || !channelId) return false;
  const ids = [channelId];
  let targetCat = null;
  if (guild) {
    const ch = guild.channels.cache.get(channelId);
    if (ch) {
      if (ch.type === CATEGORY_TYPE) targetCat = ch.id;    // the channel IS a category
      else targetCat = ch.parentId || null;
      if (ch.isThread?.() && ch.parentId) {
        ids.push(ch.parentId);
        const parent = guild.channels.cache.get(ch.parentId);
        if (parent?.parentId) targetCat = parent.parentId; // thread → its parent channel's category
      }
    }
  }
  const m = load();
  for (const lang of Object.keys(m)) {
    const e = m[lang];
    if (!e.roleId || !member.roles.cache.has(e.roleId)) continue;
    if ((e.channelIds || []).some(id => ids.includes(id))) return true;
    if (targetCat && scopeCategories(e).has(targetCat)) return true;
  }
  return false;
}
function isConfigured() { return languages().length > 0; }

module.exports = { load, languages, roleForLang, entryForRole, canActOn, scopeCategories, isConfigured, CONFIG_FILE };
