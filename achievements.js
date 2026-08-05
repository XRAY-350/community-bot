// achievements.js — per-member tribe achievements + equippable titles (Phase 6 recognition layer). Pure
// state/logic; index.js does the awarding at the right moments (arena MVP/streak/Tides, war wins, crowns,
// season) and the Discord I/O. GATED behind the `achievements` feature flag at every call site, so this is
// fully inert until an owner flips it on (build-then-tune-then-enable). All the tunables live in CATALOG.
const fs = require('fs');
const FILE = process.env.FUBU_ACHIEVEMENTS_FILE || '/home/ubuntu/.fubu_achievements.json';

// Each achievement is counter-based: it unlocks when the member's `counter` reaches `threshold`. `title` (if
// present) is the equippable title the achievement grants. Tune freely while the feature is still dark.
const CATALOG = [
  // Arena MVP (cumulative count)
  { id: 'mvp1',     counter: 'mvp',    threshold: 1,  emoji: '🥇', name: 'First Blood',   desc: 'Be the MVP of an arena.',            title: 'the MVP' },
  { id: 'mvp10',    counter: 'mvp',    threshold: 10, emoji: '🎯', name: 'Arena Regular',  desc: 'Earn 10 arena MVPs.',                title: 'the Contender' },
  { id: 'mvp25',    counter: 'mvp',    threshold: 25, emoji: '🏆', name: 'Arena Master',   desc: 'Earn 25 arena MVPs.',                title: 'the Arena Master' },
  // Daily play streak (current streak value)
  { id: 'streak3',  counter: 'streak', threshold: 3,  emoji: '🔥', name: 'Warming Up',     desc: 'Play the arena 3 days running.' },
  { id: 'streak7',  counter: 'streak', threshold: 7,  emoji: '🔥', name: 'Dedicated',      desc: 'Play the arena 7 days running.',     title: 'the Dedicated' },
  { id: 'streak30', counter: 'streak', threshold: 30, emoji: '⚡', name: 'Relentless',     desc: 'Play the arena 30 days running.',    title: 'the Relentless' },
  // Tides (current total)
  { id: 'tides500', counter: 'tides',  threshold: 500,  emoji: '🌊', name: 'Rising Tide',  desc: 'Reach 500 points.' },
  { id: 'tides2500',counter: 'tides',  threshold: 2500, emoji: '🌊', name: 'Tidebringer',  desc: 'Reach 2500 points.',                title: 'the Tidebringer' },
  // War (cumulative wins)
  { id: 'warwin1',  counter: 'warwin', threshold: 1,  emoji: '⚔️', name: 'Bloodied',       desc: 'Win a tribe war.',                   title: 'the Warrior' },
  { id: 'warwin5',  counter: 'warwin', threshold: 5,  emoji: '🗡️', name: 'Conqueror',      desc: 'Win 5 tribe wars.',                  title: 'the Conqueror' },
  // Crown + Season (cumulative)
  { id: 'crown1',   counter: 'crown',  threshold: 1,  emoji: '👑', name: 'Crowned',        desc: 'Hold a weekly Crown with your tribe.', title: 'the Crowned' },
  { id: 'season1',  counter: 'season', threshold: 1,  emoji: '🏆', name: 'Champion',       desc: 'Win an Age with your tribe.',        title: 'the Champion' },
  // Prestige (cumulative) — earned by Prestiging at the top rung; each grants a permanent honour title.
  { id: 'prestige1',counter: 'prestige', threshold: 1, emoji: '⭐', name: 'Ascended',       desc: 'Prestige once from the top rank.',   title: 'the Ascended' },
  { id: 'prestige3',counter: 'prestige', threshold: 3, emoji: '🌟', name: 'Exalted',        desc: 'Prestige three times.',              title: 'the Exalted' },
  { id: 'prestige5',counter: 'prestige', threshold: 5, emoji: '✨', name: 'Eternal',        desc: 'Prestige five times.',               title: 'the Eternal' },
];
const _byId = {}; for (const a of CATALOG) _byId[a.id] = a;
function byId(id) { return _byId[id] || null; }

let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _cache = {}; } if (!_cache.users) _cache.users = {}; return _cache; }
function save() { try { fs.writeFileSync(FILE, JSON.stringify(load())); } catch (e) { console.error('[achievements] save:', e.message); } }
function rec(uid) { const s = load(); if (!s.users[uid]) s.users[uid] = { earned: [], counters: {}, title: null }; return s.users[uid]; }

function has(uid, id) { return rec(uid).earned.includes(id); }
function award(uid, id) { const r = rec(uid); const ach = byId(id); if (!ach || r.earned.includes(id)) return null; r.earned.push(id); save(); return ach; }
function bump(uid, key, n = 1) { const r = rec(uid); r.counters[key] = (r.counters[key] || 0) + n; save(); return r.counters[key]; }
function getCounter(uid, key) { return rec(uid).counters[key] || 0; }
// Award every not-yet-earned achievement for `key` whose threshold <= value. Returns the newly-earned achs.
function checkValue(uid, key, value) {
  const out = [];
  for (const a of CATALOG) if (a.counter === key && value >= a.threshold && !has(uid, a.id)) { const got = award(uid, a.id); if (got) out.push(got); }
  return out;
}
// Bump a cumulative counter and award any milestones it crossed (mvp/warwin/crown/season). Returns newly-earned.
function bumpAndCheck(uid, key, n = 1) { return checkValue(uid, key, bump(uid, key, n)); }

function earnedList(uid) { const set = new Set(rec(uid).earned); return CATALOG.map(a => ({ ...a, earned: set.has(a.id) })); }
function earnedCount(uid) { return rec(uid).earned.length; }
function titles(uid) { const set = new Set(rec(uid).earned); return CATALOG.filter(a => a.title && set.has(a.id)); }   // equippable titles the member has unlocked
function equip(uid, id) { const r = rec(uid); if (id && (!r.earned.includes(id) || !byId(id)?.title)) return false; r.title = id || null; save(); return true; }
function titleOf(uid) { const r = rec(uid); if (!r.title) return ''; const a = byId(r.title); return a && a.title ? a.title : ''; }

module.exports = { CATALOG, byId, has, award, bump, getCounter, checkValue, bumpAndCheck, earnedList, earnedCount, titles, equip, titleOf, FILE };
