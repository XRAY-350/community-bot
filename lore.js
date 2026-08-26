// lore.js — the tribe world's append-only chronicle (Phase 7). Everything grand records an event here:
// foundings, weekly crowns, Age champions, wars, arena wins, musters, relics. The Hall of Fame and the
// weekly Chronicle read from it. Deliberately tiny + dependency-free; capped so it can't grow without bound.
const fs = require('fs');
const { statePath, atomicWriteJson } = require('./statepath');
const FILE = process.env.FUBU_LORE_FILE || statePath('lore.json');
const MAX = 3000;   // keep the most recent N events (a chapter is written weekly, so this is many months)

let _cache = null;
function load() { if (_cache) return _cache; try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); _cache = Array.isArray(j) ? j : []; } catch { _cache = []; } return _cache; }
function save() { try { atomicWriteJson(FILE, load()); } catch (e) { console.error('[lore] SAVE FAILED - changes lost on restart:', e.message); } }

// Record an event. ev = { type, title, detail?, tribes?: [keys], ...extra }. Returns the stored event.
function record(ev, nowMs) {
  const a = load();
  const e = { ts: nowMs || Date.now(), ...ev };
  a.push(e);
  if (a.length > MAX) a.splice(0, a.length - MAX);
  save();
  return e;
}
function since(ms) { return load().filter(e => e.ts >= ms); }
function between(fromMs, toMs) { return load().filter(e => e.ts >= fromMs && e.ts < toMs); }
function recent(n = 25) { return load().slice(-n); }
function byType(type, n) { const list = load().filter(e => e.type === type); return n ? list.slice(-n) : list; }
function all() { return load().slice(); }

module.exports = { record, since, between, recent, byType, all, MAX, FILE };
