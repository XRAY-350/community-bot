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
const COOLDOWN_MS = 60 * 60 * 1000;        // HARD FLOOR: at least 1h between events (owner) — for manual + auto
const DAILY_CAP = 16;                       // max/UTC day: peak (~14h) + downtime (~8h) both run, so this is raised
// Auto events don't fire on a fixed cadence: each next auto event is scheduled at a RANDOM time after the last
// one ends (owner: "at least an hour between, but random"). PEAK gap 1h..2h; DOWNTIME gap is longer (2h..3.5h)
// so the quiet hours stay sparse. Which range is used depends on the mode passed to recordEnd.
const AUTO_GAP_MIN_MIN = 60;                // peak: never sooner than 1h after the last event
const AUTO_GAP_SPREAD_MIN = 60;            // ...plus a random 0..60 min, so the peak gap is 1h..2h
const AUTO_GAP_NIGHT_MIN = 120;            // downtime: never sooner than 2h
const AUTO_GAP_NIGHT_SPREAD = 90;          // ...plus a random 0..90 min, so the downtime gap is 2h..3.5h

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
// Per-member scoring within a game (for the MVP + personal rewards, Phase 6 daily hook). Kept separate from
// tribe scores. topMemberScorer returns the single highest-scoring member, or null if nobody scored.
function addMemberScore(userId, n = 1) { const a = get(); if (!a) return 0; a.memberScores = a.memberScores || {}; a.memberScores[userId] = (a.memberScores[userId] || 0) + n; set(a); return a.memberScores[userId]; }
function topMemberScorer() { const a = get(); if (!a || !a.memberScores) return null; let best = null, bs = 0; for (const [uid, v] of Object.entries(a.memberScores)) if (v > bs) { bs = v; best = uid; } return best ? { userId: best, score: bs } : null; }
// Newly-earned achievements accrued during the current event (Phase 6), announced together in endArena.
function pushNewAch(userId, achId) { const a = get(); if (!a) return; a.newAch = a.newAch || []; a.newAch.push({ u: userId, id: achId }); set(a); }
function getNewAch() { const a = get(); return (a && a.newAch) || []; }
// Mark a member as having participated this round/challenge (dedup). Returns false if already counted.
function markOnce(bucket, id) { const a = get(); if (!a) return false; a[bucket] = a[bucket] || []; if (a[bucket].includes(id)) return false; a[bucket].push(id); set(a); return true; }
function resetBucket(bucket) { const a = get(); if (!a) return; a[bucket] = []; set(a); }
// Highest-scoring tribe, or null if nobody scored.
function winner() { const a = get(); if (!a) return null; let best = null, bs = 0; for (const [k, v] of Object.entries(a.scores || {})) if (v > bs) { bs = v; best = k; } return best ? { key: best, score: bs } : null; }

// Cooldown + daily cap (owner). recordEnd() stamps the end of a challenge and bumps today's count (reset on
// a new UTC day). startBlocked() returns a reason string if a new one can't start yet, or null if it can.
function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function recordEnd(nowMs, downtime) {
  const s = load(); const now = nowMs || Date.now(); const day = utcDay(now);
  if (s.day !== day) { s.day = day; s.count = 0; }
  s.count = (s.count || 0) + 1; s.lastEndedAt = now;
  const [gmin, gspread] = downtime ? [AUTO_GAP_NIGHT_MIN, AUTO_GAP_NIGHT_SPREAD] : [AUTO_GAP_MIN_MIN, AUTO_GAP_SPREAD_MIN];
  s.nextAutoAt = now + (gmin + randInt(gspread + 1)) * 60000;   // random gap (1h..2h peak, 2h..3.5h downtime)
  save(s);
}
// Is an AUTO event due? True once we've passed the randomly-scheduled next-auto time (or if none is set yet).
function autoStartDue(nowMs) { const s = load(); return !s.nextAutoAt || (nowMs || Date.now()) >= s.nextAutoAt; }
function getNextAutoAt() { return load().nextAutoAt || 0; }
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

// --- cross-game recency (owner: "questions shouldn't repeat as often as possible") -------------------
// The per-game `used` arrays only stop repeats WITHIN a single game; the small fixed banks (riddles, emoji,
// reaction targets) would otherwise cycle back every game or two. This persistent store remembers the last
// chunk of each bank's items so a fresh game keeps drawing from the not-recently-seen remainder and only
// recycles an item once most of the bank has been through. FIFO, capped per type. Fail-open: any read/write
// error just means "nothing remembered", never a crash.
const RECENT_FILE = process.env.FUBU_ARENA_RECENT_FILE || `${process.env.HOME || '/home/ubuntu'}/.fubu_arena_recent.json`;
let _recent = null;
function loadRecent() { if (_recent) return _recent; try { const j = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')); _recent = (j && typeof j === 'object') ? j : {}; } catch { _recent = {}; } return _recent; }
function saveRecent() { try { fs.writeFileSync(RECENT_FILE, JSON.stringify(loadRecent())); } catch (e) { console.error('[arena] saveRecent:', e.message); } }
function recentSet(type) { return new Set(loadRecent()[type] || []); }
function noteRecent(type, key, cap) {
  const r = loadRecent();
  const list = (r[type] || []).filter(k => k !== key);
  list.push(key);
  const max = Math.max(1, cap || 40);
  if (list.length > max) list.splice(0, list.length - max);
  r[type] = list; saveRecent();
}
// Pick from `items` avoiding BOTH the per-game `used` keys and the persistent recent set for `type`. keyOf maps
// an item (+index) to a stable key. Records the pick as recent (cap ≈ capFrac of the bank). Degrades to the
// per-game-only pool, then the whole bank, so it always returns something.
function pickFresh(type, items, used, keyOf, capFrac = 0.7) {
  const usedSet = new Set(used || []);
  const recent = recentSet(type);
  let pool = items.filter((it, i) => { const k = keyOf(it, i); return !usedSet.has(k) && !recent.has(k); });
  if (!pool.length) pool = items.filter((it, i) => !usedSet.has(keyOf(it, i)));
  if (!pool.length) pool = items.slice();
  const chosen = pick(pool);
  const idx = items.indexOf(chosen);
  noteRecent(type, keyOf(chosen, idx), Math.floor(items.length * capFrac));
  return { chosen, idx };
}
// Cross-game dedupe for the pre-assembled trivia/TF question sets: prefer questions not asked in recent games
// (matched by normalized text), top up with recently-asked ones only if there aren't enough fresh, then note
// the chosen set. Online fetches a few extra so the trim actually removes repeats; the local fallback rotates.
function qKey(q) { return String((q && q.q) || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 90); }
function freshenQuestions(type, questions, want) {
  if (!Array.isArray(questions) || !questions.length) return questions || [];
  const n = want || questions.length;
  const recent = recentSet(type);
  const fresh = questions.filter(q => !recent.has(qKey(q)));
  const stale = questions.filter(q => recent.has(qKey(q)));
  const chosen = (fresh.length >= n ? fresh : fresh.concat(stale)).slice(0, n);
  const cap = Math.max(60, n * 6);   // remember several games' worth of questions per type
  for (const q of chosen) noteRecent(type, qKey(q), cap);
  return chosen;
}

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
// Remote word bank (owner: source quizzes from a bank, don't hardcode). Pulls a large COMMON-word list
// (google-10000-english, filtered to solvable 4-8 letter words) so Scramble/Reverse are effectively infinite and
// never wrap. Cached to disk; the curated WORDS_DEFAULT stays as flavour + offline fallback. Generic random-word
// APIs were rejected on purpose: they return unsolvable obscure words (piolets/furazolidones), a common list does not.
const WORDS_CACHE = process.env.FUBU_ARENA_WORDS_FILE || `${process.env.HOME || '/home/ubuntu'}/.fubu_arena_words.json`;
const WORDS_URL = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-usa-no-swears-medium.txt';
let _remoteWords = null;
function loadCachedWords() { if (_remoteWords) return _remoteWords.length; try { const j = JSON.parse(fs.readFileSync(WORDS_CACHE, 'utf8')); if (Array.isArray(j.words) && j.words.length > 500) _remoteWords = j.words; } catch { /* no cache yet */ } return _remoteWords ? _remoteWords.length : 0; }
async function fetchWordBank() {
  try {
    const res = await fetch(WORDS_URL, { signal: AbortSignal.timeout(9000) });
    const txt = await res.text();
    const words = [...new Set(txt.split('\n').map(w => w.trim().toLowerCase()).filter(w => /^[a-z]{4,8}$/.test(w)))];
    if (words.length > 500) { _remoteWords = words; try { fs.writeFileSync(WORDS_CACHE, JSON.stringify({ at: Date.now(), words })); } catch { /* cache best-effort */ } }
    return _remoteWords ? _remoteWords.length : 0;
  } catch (e) { console.error('[arena] word bank fetch:', e.message); return 0; }
}
function loadBank() {
  let extra = { words: [], trivia: [] };
  try { const j = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); if (Array.isArray(j.words)) extra.words = j.words; if (Array.isArray(j.trivia)) extra.trivia = j.trivia; } catch { /* no file = defaults only */ }
  return { words: [...WORDS_DEFAULT, ...(_remoteWords || []), ...extra.words.filter(w => typeof w === 'string' && /^[a-z]{3,12}$/i.test(w))],
    trivia: [...TRIVIA_DEFAULT, ...extra.trivia.filter(t => t && t.q && Array.isArray(t.options) && t.options.length >= 2 && Number.isInteger(t.answer))] };
}

// ---- More game types (owner: "add at least 6 more arena events") ------------------------------------
// TYPED types are answered by typing in the channel (like scramble) and are time-boxed — they keep posting
// fresh prompts until the end timer fires, so no round count is needed. nextTyped(type, used) returns
// { answer, display, key }: `answer` is what a player types to score, `display` is what's shown, `key` is
// what to add to the per-game `used` list so a prompt doesn't repeat. index.js renders `display` per type.
const TYPED_TYPES = ['scramble', 'math', 'typing', 'riddle', 'emoji', 'reverse'];
// Themed quizzes reuse the trivia button flow, just with a fixed Open Trivia DB category (virtually infinite).
const TRIVIA_CATEGORY = { geoquiz: 22, sciquiz: 17, histquiz: 23, animalquiz: 27 };
const BUTTON_TYPES = ['trivia', 'truefalse', 'pattern', ...Object.keys(TRIVIA_CATEGORY)];   // answered by clicking an option button
const TF_QUESTIONS = 12;    // statements per True-or-False sprint
const PATTERN_QUESTIONS = 8; // sequences per Number Pattern sprint

const MATH_OPS = ['+', '-', '×'];
function nextMath(used) {
  for (let i = 0; i < 60; i++) {
    const op = pick(MATH_OPS);
    let a, b, ans;
    if (op === '×') { a = 2 + randInt(11); b = 2 + randInt(11); ans = a * b; }
    else if (op === '+') { a = 5 + randInt(45); b = 5 + randInt(45); ans = a + b; }
    else { a = 12 + randInt(48); b = 1 + randInt(a - 1); ans = a - b; }
    const prompt = `${a} ${op} ${b}`;
    if (!(used || []).includes(prompt)) return { display: prompt, answer: String(ans), key: prompt };
  }
  const a = 2 + randInt(11), b = 2 + randInt(11);
  return { display: `${a} × ${b}`, answer: String(a * b), key: `${a}×${b}#` };
}
// Fast Fingers — retype an exact short phrase from the common word bank.
function nextTyping(used) {
  const words = loadBank().words;
  for (let i = 0; i < 60; i++) {
    const phrase = [pick(words), pick(words), pick(words)].join(' ');
    if (!(used || []).includes(phrase)) return { display: phrase, answer: phrase, key: phrase };
  }
  const p = [pick(words), pick(words), pick(words)].join(' ');
  return { display: p, answer: p, key: p };
}
// Riddle Rush — a curated bank (answers are one word / short, matched case-insensitively).
const RIDDLES = [
  { q: 'What has keys but no locks, space but no room, and you can enter but not go inside?', a: 'keyboard' },
  { q: 'What has to be broken before you can use it?', a: 'egg' },
  { q: 'What has hands but cannot clap?', a: 'clock' },
  { q: 'What has a neck but no head?', a: 'bottle' },
  { q: 'What gets wetter the more it dries?', a: 'towel' },
  { q: 'What has many teeth but cannot bite?', a: 'comb' },
  { q: 'What has an eye but cannot see?', a: 'needle' },
  { q: 'What can travel around the world while staying in a corner?', a: 'stamp' },
  { q: 'What has a thumb and four fingers but is not alive?', a: 'glove' },
  { q: 'What has legs but cannot walk?', a: 'table' },
  { q: 'What has one head, one foot, and four legs?', a: 'bed' },
  { q: 'What building has the most stories?', a: 'library' },
  { q: 'What goes up but never comes down?', a: 'age' },
  { q: 'What has words but never speaks?', a: 'book' },
  { q: 'What has a bed but never sleeps, and runs but never walks?', a: 'river' },
  { q: 'What can you catch but not throw?', a: 'cold' },
  { q: 'What has ears but cannot hear?', a: 'corn' },
  { q: 'What kind of coat is best put on wet?', a: 'paint' },
  { q: 'What has cities but no houses, forests but no trees, and water but no rivers?', a: 'map' },
  { q: 'What has branches but no fruit, trunk, or leaves?', a: 'bank' },
  { q: 'The more you take, the more you leave behind. What are they?', a: 'footsteps' },
  { q: 'What is full of holes but still holds water?', a: 'sponge' },
  { q: 'What can fill a room but takes up no space?', a: 'light' },
  { q: 'What has a tail and a head but no body?', a: 'coin' },
  { q: 'I am tall when I am young and short when I am old. What am I?', a: 'candle' },
  { q: 'What kind of tree can you carry in your hand?', a: 'palm' },
  { q: 'What can you keep only after giving it to someone?', a: 'word' },
  { q: 'What comes down but never goes up?', a: 'rain' },
  { q: 'What has a heart that does not beat?', a: 'artichoke' },
  { q: 'What runs all around a yard yet never moves?', a: 'fence' },
  { q: 'What has a face and two hands but no arms or legs?', a: 'clock' },
  { q: 'What can you break, even if you never pick it up or touch it?', a: 'promise' },
  { q: 'What goes through towns and hills but never moves?', a: 'road' },
  { q: 'The more of this there is, the less you see. What is it?', a: 'darkness' },
  { q: 'What has a bottom at the top?', a: 'leg' },
  { q: 'What five-letter word becomes shorter when you add two letters to it?', a: 'short' },
  { q: 'What has many keys but opens no doors?', a: 'piano' },
  { q: 'What kind of band never plays music?', a: 'rubber band' },
  { q: 'What has a ring but no finger?', a: 'telephone' },
  { q: 'What gets bigger the more you take away from it?', a: 'hole' },
  { q: 'What invention lets you look right through a wall?', a: 'window' },
  { q: 'What word is spelled wrong in every dictionary?', a: 'wrong' },
  { q: 'What flies without wings?', a: 'time' },
  { q: 'It belongs to you, but other people use it more than you do. What is it?', a: 'name' },
  { q: 'What goes up and down but never moves?', a: 'stairs' },
  { q: 'What has a bark but no bite?', a: 'tree' },
  { q: 'What has roots nobody sees and is taller than trees?', a: 'mountain' },
  { q: 'What can be cracked, made, told, and played?', a: 'joke' },
  { q: 'What kind of room has no doors or windows?', a: 'mushroom' },
  { q: 'What is always in front of you but cannot be seen?', a: 'future' },
  { q: 'What is so fragile that saying its name breaks it?', a: 'silence' },
  { q: 'What is easy to lift but hard to throw?', a: 'feather' },
  { q: 'What is black when clean and white when dirty?', a: 'blackboard' },
  { q: 'I speak without a mouth and hear without ears. What am I?', a: 'echo' },
  { q: 'What has teeth but no mouth and cuts through wood?', a: 'saw' },
  { q: 'What runs but has no legs?', a: 'water' },
  { q: 'What is always coming but never arrives?', a: 'tomorrow' },
  { q: 'What is taken before you can get it?', a: 'picture' },
  { q: 'What kind of ship has two mates but no captain?', a: 'relationship' },
  { q: 'What word contains 26 letters but only three syllables?', a: 'alphabet' },
  { q: 'What starts and ends with the letter e but holds only one letter?', a: 'envelope' },
  { q: 'What can be measured but has no length, width, or height?', a: 'temperature' },
  { q: 'What has a tongue but cannot talk?', a: 'shoe' },
  { q: 'What walks on four legs in the morning, two at noon, and three at night?', a: 'man' },
  { q: 'What kind of cup cannot hold water?', a: 'cupcake' },
  { q: 'What can be broken but never held?', a: 'heart' },
  { q: 'What gets sharper the more you use it?', a: 'brain' },
  { q: 'What falls in winter but never gets hurt?', a: 'snow' },
  { q: 'What has a crown and a root but is not a king or a plant?', a: 'tooth' },
  { q: 'What has a neck and two arms but no hands, and you wear it?', a: 'shirt' },
  { q: 'What kind of key opens a banana?', a: 'monkey' },
  { q: 'What has a ring but no jewel, and wakes you in the morning?', a: 'alarm' },
  { q: 'What flies all day but never leaves its pole?', a: 'flag' },
  { q: 'What has a trunk but is not a tree or a car?', a: 'elephant' },
  { q: 'What can you hear and make but never see or touch?', a: 'sound' },
  { q: 'What is orange, crunchy, and rabbits love?', a: 'carrot' },
  { q: 'What weighs things with two arms and a pointer?', a: 'scale' },
  { q: 'What is a giant ball of fire that lights up the day?', a: 'sun' },
  { q: 'What glows at night, has craters, and orbits the earth?', a: 'moon' },
  { q: 'What twinkles in the night sky and is a distant ball of fire?', a: 'star' },
  { q: 'What has a shell, moves slowly, and leaves a trail?', a: 'snail' },
  { q: 'What has a mane, roars, and is called king of the jungle?', a: 'lion' },
  { q: 'What is frozen water you skate on?', a: 'ice' },
];
function nextRiddle(used) {
  const { chosen, idx } = pickFresh('riddle', RIDDLES, used, (_, i) => i);
  return { display: chosen.q, answer: chosen.a, key: idx };
}
// Emoji Decode — the emojis spell a word/thing; answer matched case-insensitively.
const EMOJI_REBUS = [
  { e: '🐱🐟', a: 'catfish' }, { e: '🔥🦊', a: 'firefox' }, { e: '⭐🐟', a: 'starfish' },
  { e: '🌞🌻', a: 'sunflower' }, { e: '🦶⚽', a: 'football' }, { e: '🌙🚶', a: 'moonwalk' },
  { e: '🌊🏄', a: 'surfing' }, { e: '🕷️🕸️', a: 'spiderweb' }, { e: '🌞🕶️', a: 'sunglasses' },
  { e: '🔥🚒', a: 'firetruck' }, { e: '🐛📚', a: 'bookworm' }, { e: '🏠🪰', a: 'housefly' },
  { e: '🌊🐴', a: 'seahorse' }, { e: '🐄👦', a: 'cowboy' }, { e: '❄️⛄', a: 'snowman' },
  { e: '🐝🍯', a: 'honeybee' }, { e: '🔑⌨️', a: 'keyboard' }, { e: '🌈', a: 'rainbow' },
  { e: '🦋', a: 'butterfly' }, { e: '🐙', a: 'octopus' }, { e: '🦄', a: 'unicorn' },
  { e: '🌋', a: 'volcano' }, { e: '🎃', a: 'pumpkin' }, { e: '🍍', a: 'pineapple' },
];
function nextEmoji(used) {
  const { chosen, idx } = pickFresh('emoji', EMOJI_REBUS, used, (_, i) => i);
  return { display: chosen.e, answer: chosen.a, key: idx };
}
// Unified typed-prompt picker used by scramble/math/typing/riddle/emoji.
function nextTyped(type, used) {
  if (type === 'math') return nextMath(used);
  if (type === 'typing') return nextTyping(used);
  if (type === 'riddle') return nextRiddle(used);
  if (type === 'emoji') return nextEmoji(used);
  if (type === 'reverse') { const w = nextWord(used); return { display: w.split('').reverse().join('').toUpperCase(), answer: w, key: w }; }
  const w = nextWord(used);   // scramble
  return { display: w, answer: w, key: w };
}

// True or False — online boolean bank (opentdb, virtually infinite), local fallback. Returns the SAME shape
// as trivia questions ({q, options, answer index}) so it reuses the trivia flow (askNextTrivia + arena_ans).
const TF_DEFAULT = [
  { q: 'The Great Wall of China is visible from space with the naked eye.', a: false },
  { q: 'Honey never spoils.', a: true },
  { q: 'Bats are blind.', a: false },
  { q: 'An octopus has three hearts.', a: true },
  { q: 'Goldfish have a three-second memory.', a: false },
  { q: 'Lightning never strikes the same place twice.', a: false },
  { q: 'A group of flamingos is called a flamboyance.', a: true },
  { q: 'Humans only use 10% of their brains.', a: false },
  { q: 'The Eiffel Tower can grow taller in summer.', a: true },
  { q: 'Sharks are mammals.', a: false },
  { q: 'Bananas are berries, botanically speaking.', a: true },
  { q: 'The heart of a shrimp is located in its head.', a: true },
  { q: 'Mount Everest is the tallest mountain on Earth measured base to peak.', a: false },
  { q: 'Sound travels faster in water than in air.', a: true },
];
async function fetchBoolean(n) {
  try {
    const res = await fetch(`https://opentdb.com/api.php?amount=${n}&type=boolean&encode=url3986`, { signal: AbortSignal.timeout(6000) });
    const d = await res.json();
    if (d.response_code !== 0 || !Array.isArray(d.results) || !d.results.length) return null;
    return d.results.map(r => {
      const correct = decodeURIComponent(r.correct_answer);   // "True" | "False"
      const options = ['True', 'False'];
      return { q: decodeURIComponent(r.question), options, answer: options.indexOf(correct) };
    });
  } catch (e) { console.error('[arena] fetchBoolean:', e.message); return null; }
}
function localBoolean(n) {
  return shuffle(TF_DEFAULT).slice(0, Math.min(n, TF_DEFAULT.length)).map(t => ({ q: t.q, options: ['True', 'False'], answer: t.a ? 0 : 1 }));
}

// Number Pattern (owner's idea): a 4-term sequence + 4 choices; pick the term that completes it. Fully
// generated (infinite), returned in the SAME shape as trivia questions ({q, options, answer index}) so it
// reuses the button flow (askNextTrivia + arena_ans). Four sub-patterns keep it varied.
function genPattern(n) {
  const out = [], seen = new Set();
  let guard = 0;
  while (out.length < n && guard++ < n * 25) {
    const kind = randInt(4);
    let seq, next;
    if (kind === 0) { const a = 1 + randInt(9), d = 2 + randInt(9); seq = [a, a + d, a + 2 * d, a + 3 * d]; next = a + 4 * d; }        // arithmetic
    else if (kind === 1) { const a = 1 + randInt(4), r = 2 + randInt(2); seq = [a, a * r, a * r * r, a * r * r * r]; next = a * r ** 4; } // geometric
    else if (kind === 2) { const s = 1 + randInt(5); seq = [s * s, (s + 1) ** 2, (s + 2) ** 2, (s + 3) ** 2]; next = (s + 4) ** 2; }    // squares
    else { let a = 1 + randInt(3), b = 1 + randInt(3); const seqF = [a, b]; for (let i = 0; i < 2; i++) { const c = a + b; seqF.push(c); a = b; b = c; } seq = seqF; next = a + b; } // fibonacci-like
    const qKey = seq.join(',');
    if (seen.has(qKey)) continue; seen.add(qKey);
    const opts = new Set([next]);
    let g2 = 0;
    while (opts.size < 4 && g2++ < 40) { const cand = next + (1 + randInt(4)) * (randInt(2) ? 1 : -1); if (cand > 0 && !opts.has(cand)) opts.add(cand); }
    while (opts.size < 4) opts.add(next + opts.size + 1);
    const options = shuffle([...opts]).map(String);
    out.push({ q: `What comes next?  \`${seq.join(', ')}, ?\``, options, answer: options.indexOf(String(next)) });
  }
  return out;
}

// Reaction Rush — each round targets one easy-to-click emoji; first tribe member to react scores.
const REACTION_EMOJIS = ['🔥', '⚡', '🎯', '🏆', '💎', '🌟', '🚀', '🎉', '👑', '🐉', '🛡️', '⚔️', '🌈', '💯', '🍀',
  '🎈', '🎁', '🎵', '🍎', '🌙', '☀️', '❤️', '🐾', '🌸', '🍕', '🎸', '🦋', '🍦', '🎲', '🪁', '🌊', '🦄', '🍉', '🎺', '🧊'];
function nextReaction(used) { return pickFresh('reaction', REACTION_EMOJIS, used, e => e).chosen; }

// Pick a scramble word not used this game NOR in recent games (owner: no in-game repeats + rare cross-game ones).
function nextWord(used) { return pickFresh('word', loadBank().words, used, w => w).chosen; }
// Local trivia fallback picker (excludes already-asked-this-game).
function localTrivia(n, asked) {
  const pool = loadBank().trivia.filter((_, i) => !(asked || []).includes(i));
  return shuffle(pool.length >= n ? pool : loadBank().trivia).slice(0, n);
}

// Fetch a batch of trivia from the Open Trivia DB (owner: "an online list that's virtually infinite").
// url3986 encoding decodes cleanly with decodeURIComponent. Returns [{q, options, answer}] or null on any
// failure (caller falls back to the local bank). Options are shuffled so the answer isn't always first.
async function fetchTrivia(n, category) {
  try {
    const cat = category ? `&category=${category}` : '';
    const res = await fetch(`https://opentdb.com/api.php?amount=${n}&type=multiple&encode=url3986${cat}`, { signal: AbortSignal.timeout(6000) });
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
  TYPED_TYPES, BUTTON_TYPES, TF_QUESTIONS, PATTERN_QUESTIONS, TRIVIA_CATEGORY,
  get, isActive, set, clear, update, addScore, addMemberScore, topMemberScorer, pushNewAch, getNewAch, markOnce, resetBucket, winner,
  recordEnd, startBlocked, autoStartDue, getNextAutoAt,
  scrambleWord, nextWord, fetchTrivia, localTrivia, loadBank,
  nextTyped, nextMath, nextTyping, nextRiddle, nextEmoji, fetchBoolean, localBoolean, nextReaction, REACTION_EMOJIS, genPattern,
  freshenQuestions, loadCachedWords, fetchWordBank,
};
