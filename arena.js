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
const TRIVIA_QUESTIONS = 5; // questions per trivia sprint
const SCRAMBLE_ROUNDS = 5;  // rounds per scramble

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

// --- banks -------------------------------------------------------------------------------------------
const WORDS = ['tribe', 'warden', 'treasury', 'glory', 'muster', 'alliance', 'crown', 'vigil', 'banner',
  'throne', 'loyalty', 'rally', 'conquest', 'victory', 'honor', 'valor', 'kingdom', 'champion', 'legion', 'fortune'];
function randInt(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[randInt(arr.length)]; }
function scrambleWord(w) {
  const a = w.split('');
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  const s = a.join('');
  return s === w ? scrambleWord(w) : s;   // never hand back the unscrambled word
}
// {q, options:[4], answer: index}
const TRIVIA = [
  { q: 'What resets to zero every week?', options: ['Treasury', 'Glory', 'Tides', 'Crowns'], answer: 1 },
  { q: 'How many mods must back a mod-founded tribe?', options: ['1', '2', '3', '5'], answer: 2 },
  { q: 'What does a tribe win for the highest weekly Glory?', options: ['Treasury reset', 'The Crown', 'A retheme', 'A war'], answer: 1 },
  { q: 'Who has NO say in whether a war starts?', options: ['The attacker', 'The members', 'The target', 'The admins'], answer: 2 },
  { q: 'What is a tribe leader’s auto-title default?', options: ['Warden', 'King', 'Chief', 'Boss'], answer: 0 },
  { q: 'How often can a tribe call a muster?', options: ['Hourly', '~Once a day', 'Weekly', 'Anytime'], answer: 1 },
  { q: 'What sits above the whole rank ladder for staff?', options: ['Elder', 'General', 'Veteran', 'Initiate'], answer: 1 },
  { q: 'What can you spend Treasury on?', options: ['Glory', 'Shop unlocks', 'Crowns', 'Votes'], answer: 1 },
  { q: 'What can only ever go up, never down?', options: ['Treasury', 'Your rank', 'Glory', 'Members'], answer: 1 },
  { q: 'A declined war drops to a…', options: ['Revote', 'Coin flip', 'Refund', 'Truce'], answer: 1 },
];
function nextWord() { return pick(WORDS); }
function nextTrivia(asked) { const pool = TRIVIA.filter((_, i) => !(asked || []).includes(i)); const q = pick(pool.length ? pool : TRIVIA); return { q, idx: TRIVIA.indexOf(q) }; }

module.exports = {
  STATE_FILE, WIN_TREASURY, WIN_GLORY, RACE_TARGET, TRIVIA_QUESTIONS, SCRAMBLE_ROUNDS,
  get, isActive, set, clear, update, addScore, markOnce, resetBucket, winner,
  scrambleWord, nextWord, nextTrivia, TRIVIA,
};
