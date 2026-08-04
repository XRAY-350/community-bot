// arena.js — interactive cross-tribe challenges (owner, 2026-08-04: "add interactive challenges").
// ONE active challenge server-wide at a time. Four types:
//   race     — first tribe to N button-clicks (from distinct members) wins.
//   trivia   — bot asks questions with answer buttons; first correct per question scores that member's tribe.
//   scramble — bot posts a scrambled word; first tribe member to type it scores; best over the rounds.
//   blitz    — a timed window; the tribe that earns the most hall activity (messages) wins.
// Per-tribe scoring; the winning tribe banks Glory + Treasury. This module owns the STATE + banks + pure
// scoring; index.js does the Discord I/O (posting, buttons, message-watching, the end timer) since those
// are tightly bound to discord.js. On restart, index.js reconciles the active challenge (resolve if its
// window passed, else re-arm the timer).
const fs = require('fs');
const STATE_FILE = process.env.FUBU_ARENA_FILE || '/home/ubuntu/.fubu_arena.json';

const WIN_TREASURY = 150;   // the winning tribe banks this
const WIN_GLORY = 100;
const RACE_TARGET = 10;     // clicks to win a race
const TRIVIA_QUESTIONS = 10; // questions per trivia sprint (owner: the online bank is huge, so ask more)
const SCRAMBLE_ROUNDS = 5;  // rounds per scramble
const COOLDOWN_MS = 3 * 60 * 60 * 1000;   // min gap between challenges (owner: cooldown, kept at 3h)
const DAILY_CAP = 4;                       // max challenges per UTC day (owner: 4 so you can run 1 of each type)

// In-memory cache — get() runs on EVERY message (blitz/scramble hooks), so avoid a sync file read each time.
// This process is the only writer, so caching is safe; save() refreshes it.
let _cache = null;
function load() { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { _cache = {}; } return _cache; }
function save(s) { _cache = s; try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[arena] save:', e.message); } }
function get() { return load().active || null; }
function isActive() { return !!get(); }
function set(a) { const s = load(); s.active = a; save(s); }
function clear() { const s = load(); delete s.active; save(s); }
function update(patch) { const a = get(); if (!a) return null; const n = { ...a, ...patch }; set(n); return n; }

// +score to a tribe; returns its new total.
function addScore(tribeKey, n = 1) { const a = get(); if (!a) return 0; a.scores = a.scores || {}; a.scores[tribeKey] = (a.scores[tribeKey] || 0) + n; set(a); return a.scores[tribeKey]; }
// Mark a member as having participated this round/challenge (dedup). Returns false if already counted.
function markOnce(bucket, id) { const a = get(); if (!a) return false; a[bucket] = a[bucket] || []; if (a[bucket].includes(id)) return false; a[bucket].push(id); set(a); return true; }
function resetBucket(bucket) { const a = get(); if (!a) return; a[bucket] = []; set(a); }
// Highest-scoring tribe, or null if nobody scored.
function winner() { const a = get(); if (!a) return null; let best = null, bs = 0; for (const [k, v] of Object.entries(a.scores || {})) if (v > bs) { bs = v; best = k; } return best ? { key: best, score: bs } : null; }

// Cooldown + daily cap (owner). recordEnd() stamps the end of a challenge and bumps today's count (reset on
// a new UTC day). startBlocked() returns a reason string if a new one can't start yet, or null if it can.
function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function recordEnd(nowMs) {
  const s = load(); const now = nowMs || Date.now(); const day = utcDay(now);
  if (s.day !== day) { s.day = day; s.count = 0; }
  s.count = (s.count || 0) + 1; s.lastEndedAt = now; save(s);
}
function startBlocked(nowMs) {
  const s = load(); const now = nowMs || Date.now();
  if (s.active) return 'A challenge is already running — let it finish first.';
  const count = (s.day === utcDay(now)) ? (s.count || 0) : 0;
  if (count >= DAILY_CAP) return `The daily challenge limit (**${DAILY_CAP}**) is reached — try again tomorrow.`;
  if (s.lastEndedAt && now - s.lastEndedAt < COOLDOWN_MS) return `On cooldown — the next challenge can start <t:${Math.floor((s.lastEndedAt + COOLDOWN_MS) / 1000)}:R>.`;
  return null;
}

// --- banks -------------------------------------------------------------------------------------------
function randInt(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[randInt(arr.length)]; }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function scrambleWord(w) { const s = shuffle(w.split('')).join(''); return s === w ? scrambleWord(w) : s; }   // never hand back the word unscrambled

// SCRAMBLE words — a large CURATED bank of common, solvable words. (Online random-word APIs return obscure
// words like "piolets"/"pallidly" that nobody can unscramble, so a big common list beats infinite-but-unfair.)
const WORDS_DEFAULT = ['tribe', 'warden', 'treasury', 'glory', 'muster', 'alliance', 'crown', 'vigil', 'banner', 'throne',
  'loyalty', 'rally', 'conquest', 'victory', 'honor', 'valor', 'kingdom', 'champion', 'legion', 'fortune',
  'castle', 'dragon', 'knight', 'shield', 'sword', 'arrow', 'battle', 'legend', 'quest', 'treasure',
  'silver', 'jewel', 'crystal', 'mountain', 'river', 'ocean', 'island', 'desert', 'valley', 'meadow',
  'garden', 'flower', 'thunder', 'storm', 'winter', 'summer', 'autumn', 'spring', 'morning', 'evening',
  'shadow', 'bright', 'silent', 'gentle', 'mighty', 'ancient', 'golden', 'frozen', 'hidden', 'secret',
  'whisper', 'dream', 'memory', 'journey', 'courage', 'wisdom', 'freedom', 'justice', 'friendship', 'family',
  'village', 'empire', 'warrior', 'hunter', 'ranger', 'wizard', 'archer', 'guardian', 'captain', 'soldier',
  'rival', 'enemy', 'triumph', 'wonder', 'marvel', 'mystery', 'riddle', 'puzzle', 'magic', 'potion',
  'scroll', 'tower', 'bridge', 'harbor', 'market', 'tavern', 'feast', 'festival', 'anthem', 'ballad',
  'melody', 'rhythm', 'harmony', 'canvas', 'palette', 'statue', 'temple', 'palace', 'fortress', 'beacon',
  'lantern', 'torch', 'ember', 'flame', 'spark', 'comet', 'planet', 'galaxy', 'cosmos', 'horizon',
  'sunrise', 'sunset', 'rainbow', 'breeze', 'blossom', 'harvest', 'orchard', 'canyon', 'glacier', 'volcano',
  'tornado', 'blizzard', 'compass', 'voyage', 'mission', 'anchor', 'falcon', 'phoenix', 'griffin', 'serpent'];
// Local trivia fallback (used only if the online fetch fails) — tribe-lore themed. {q, options, answer index}.
const TRIVIA_DEFAULT = [
  { q: 'What resets to zero every week?', options: ['Treasury', 'Glory', 'Tides', 'Crowns'], answer: 1 },
  { q: 'How many mods must back a mod-founded tribe?', options: ['1', '2', '3', '5'], answer: 2 },
  { q: 'What does the highest weekly Glory win?', options: ['Treasury reset', 'The Crown', 'A retheme', 'A war'], answer: 1 },
  { q: 'A tribe leader’s default auto-title is…', options: ['Warden', 'King', 'Chief', 'Boss'], answer: 0 },
  { q: 'What sits above the whole rank ladder for staff?', options: ['Elder', 'General', 'Veteran', 'Initiate'], answer: 1 },
  { q: 'What can only ever go up, never down?', options: ['Treasury', 'Your rank', 'Glory', 'Members'], answer: 1 },
  { q: 'A declined war drops to a…', options: ['Revote', 'Coin flip', 'Refund', 'Truce'], answer: 1 },
  { q: 'What do you spend Treasury on?', options: ['Glory', 'Shop unlocks', 'Crowns', 'Votes'], answer: 1 },
];
// Optional editable bank file (owner: make them editable) — { words: [...], trivia: [{q,options,answer}] }.
// Its entries ADD to the defaults, so mods can grow the pools without a code change.
const BANK_FILE = process.env.FUBU_ARENA_BANK_FILE || `${process.env.HOME || '/home/ubuntu'}/.fubu_arena_bank.json`;
function loadBank() {
  let extra = { words: [], trivia: [] };
  try { const j = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); if (Array.isArray(j.words)) extra.words = j.words; if (Array.isArray(j.trivia)) extra.trivia = j.trivia; } catch { /* no file = defaults only */ }
  return { words: [...WORDS_DEFAULT, ...extra.words.filter(w => typeof w === 'string' && /^[a-z]{3,12}$/i.test(w))],
    trivia: [...TRIVIA_DEFAULT, ...extra.trivia.filter(t => t && t.q && Array.isArray(t.options) && t.options.length >= 2 && Number.isInteger(t.answer))] };
}

// Pick a scramble word not already used THIS game (owner: no in-game repeats).
function nextWord(used) { const pool = loadBank().words.filter(w => !(used || []).includes(w)); return pick(pool.length ? pool : loadBank().words); }
// Local trivia fallback picker (excludes already-asked-this-game).
function localTrivia(n, asked) {
  const pool = loadBank().trivia.filter((_, i) => !(asked || []).includes(i));
  return shuffle(pool.length >= n ? pool : loadBank().trivia).slice(0, n);
}

// Fetch a batch of trivia from the Open Trivia DB (owner: "an online list that's virtually infinite").
// url3986 encoding decodes cleanly with decodeURIComponent. Returns [{q, options, answer}] or null on any
// failure (caller falls back to the local bank). Options are shuffled so the answer isn't always first.
async function fetchTrivia(n) {
  try {
    const res = await fetch(`https://opentdb.com/api.php?amount=${n}&type=multiple&encode=url3986`, { signal: AbortSignal.timeout(6000) });
    const d = await res.json();
    if (d.response_code !== 0 || !Array.isArray(d.results) || !d.results.length) return null;
    return d.results.map(r => {
      const correct = decodeURIComponent(r.correct_answer);
      const options = shuffle([correct, ...r.incorrect_answers.map(decodeURIComponent)]);
      return { q: decodeURIComponent(r.question), options, answer: options.indexOf(correct) };
    });
  } catch (e) { console.error('[arena] fetchTrivia:', e.message); return null; }
}

module.exports = {
  STATE_FILE, BANK_FILE, WIN_TREASURY, WIN_GLORY, RACE_TARGET, TRIVIA_QUESTIONS, SCRAMBLE_ROUNDS, COOLDOWN_MS, DAILY_CAP,
  get, isActive, set, clear, update, addScore, markOnce, resetBucket, winner,
  recordEnd, startBlocked,
  scrambleWord, nextWord, fetchTrivia, localTrivia, loadBank,
};
