// smartwatch.js — LLM contextual judge for the watch pipeline.
//
// Problem: the watchlist/watch-log is pure keyword matching, so it can't read MEANING — reclaimed
// in-community language, hyperbole, quotes, and dialect all trip the same wires as a real problem,
// burying mods in false positives.
//
// This adds a contextual judge BEHIND the keyword matcher: when a term matches, the flagged message
// (plus a little context + who the author is) is read in context by a small, cheap model (Haiku), which
// decides whether the flag is genuine or a false positive — encoding FUBU's actual rules + norms. The
// human gate stays; mods just see the ~real flags instead of 100% of keyword noise.
//
// Design invariants:
//   • Runs ONLY on already-keyword-matched messages → cost scales with flag volume, not chat volume.
//   • FAIL-OPEN: no API key, SDK missing, API error, or unparseable verdict → returns {ran:false} and
//     the caller keeps today's behavior (post the raw flag). The judge can only ADD precision, never
//     swallow a flag on a hiccup.
//   • Feature-flagged ('smartWatch', OFF by default) + shadow-mode-first: even when enabled it only
//     annotates + logs what it WOULD suppress until SMARTWATCH_LIVE is turned on.
//   • Community-specific facts live in an owner-editable profile file, NOT hardcoded (demographics drift).
//   • Hard safety floor: child-safety / threats / doxxing are never auto-suppressed regardless of verdict.
const fs = require('fs');
const config = require('./config');
const opspanel = require('./opspanel');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* SDK not installed yet - feature stays dark */ }

const MODEL = process.env.SMARTWATCH_MODEL || 'claude-haiku-4-5';
const API_KEY = (process.env.ANTHROPIC_API_KEY || process.env.SMARTWATCH_API_KEY || '').trim();
const PROFILE_FILE = process.env.FUBU_COMMUNITY_PROFILE_FILE || '/home/ubuntu/.fubu_community_profile.txt';
const SHADOW_LOG = process.env.SMARTWATCH_SHADOW_LOG || '/home/ubuntu/.fubu_smartwatch_shadow.jsonl';
const CTX_MESSAGES = Number(process.env.SMARTWATCH_CONTEXT_MSGS || 10) || 10;
// Categories the judge is NEVER allowed to auto-suppress, even at high confidence — belt-and-suspenders
// beyond the system-prompt instruction.
const NEVER_SUPPRESS = new Set(['child-safety', 'threat', 'doxxing']);

let client = null;
function getClient() {
  if (!Anthropic || !API_KEY) return null;
  if (!client) { try { client = new Anthropic({ apiKey: API_KEY }); } catch { client = null; } }
  return client;
}
function available() { return !!getClient(); }

// ---- owner-editable community profile (the mutable, drift-prone specifics) ------------------------
const DEFAULT_PROFILE =
  'Members span the Black diaspora, so vernacular varies widely - AAVE, European/UK Black slang, and ' +
  'French or other multilingual code-switching all appear. Don\'t assume a term carries the same meaning ' +
  'across dialects, and don\'t mistake unfamiliar diaspora slang for hostility.';
function communityProfile() {
  try { const t = fs.readFileSync(PROFILE_FILE, 'utf8').trim(); if (t) return t; } catch { /* use default */ }
  return DEFAULT_PROFILE;
}

// ---- prompt (stable core in code; the profile is injected) ---------------------------------------
function systemPrompt() {
  return [
    'You are the moderation-context judge for F.U.B.U. ("For Us By Us") - a Black-only community (Rule 1).',
    'A keyword matcher flagged a message for a watched term. You are NOT the moderator; a human makes every',
    'real call. Your job: decide whether this flag is a genuine concern worth a mod\'s attention or a false',
    'positive, so the log stays signal, not noise. Judge MEANING and INTENT in context - never the bare',
    'presence of a word.',
    '',
    'Community norms a naive word list gets wrong:',
    '- The n-word is normal here. Casual / limited / reclaimed use among members (camaraderie, venting,',
    '  lyrics) is NOT a violation. What breaks the rules is spamming the hard-R ("-er") form, or aiming a',
    '  slur AT someone as an attack. Flag the spam or weaponization, not the word\'s presence.',
    '- ' + communityProfile(),
    '- Channel matters: sexual/suggestive talk is banned in general channels (Rule 4) but allowed in the',
    '  MDNI space; debates/arguments belong only in discussion channels (Rule 9). You are told the channel.',
    '- Judge direction: aimed AT someone as an attack/threat, vs. reclaimed use, a joke, a quote, someone',
    '  REPORTING another\'s message, or hyperbole. Weigh who is speaking and at whom.',
    '- LANGUAGE: this is a multilingual space, but the watched terms are ENGLISH. If the flagged message is',
    '  NOT in English (French, Spanish, an African language, etc.), an English-keyword match on it is almost',
    '  always a coincidental false positive - set surface:false, category "non-english" (the non-English',
    '  channels have their own mini-mods). EXCEPTION: things that transcend language - a credible threat, a',
    '  child-safety issue, doxxing, or a slur weaponized at someone - still surface with the REAL category.',
    '',
    'FUBU rules you map a flag to (1-11): 1 Black-only space; 2 child safety (grooming, or jokes about',
    'grooming/rape/pedophilia - always a flag); 3 verification; 4 no sexual/suggestive language in general',
    'channels; 5 respect everyone (harassment, personal attacks, hate speech - hate carries extra weight);',
    '6 privacy (no doxxing / sharing DMs); 7 respect the space (no intentional disruption/drama); 8 no spam',
    '(repeated messages, emoji/mention spam, flooding, excessive caps - hard-R spam lands here + rule 5);',
    '9 right channel right conversation; 10 don\'t weaponize the anon tools; 11 staff decisions final.',
    '',
    'When genuinely unsure, SURFACE it (do not suppress). Only mark a false positive when clearly confident',
    'it is benign. NEVER suppress: a credible threat of violence, a slur weaponized at a specific person,',
    'hard-R spam, doxxing (Rule 6), or anything touching child safety (Rule 2).',
    exemplarBlock(),
    '',
    'Respond with ONLY a JSON object (no prose, no markdown fences) of exactly this shape:',
    '{"surface": <bool, true=show a mod / false=benign false positive>, "confidence": <0.0-1.0, how sure of surface>,',
    ' "severity": "none"|"low"|"medium"|"high", "likelyRule": <the FUBU rule 1-11 this message VIOLATES, or 0 if it is not a rule violation - welfare/distress cases and benign false positives are ALWAYS 0 (a member\'s wellbeing is not a rule)>,',
    ' "category": "reclaimed"|"hostile"|"threat"|"distress"|"quote-report"|"joke-hyperbole"|"sexual"|"doxxing"|"child-safety"|"spam"|"non-english"|"unclear",',
    ' "reason": "<one plain sentence a mod reads at a glance>"}',
  ].join('\n');
}

const SCOPE_RUBRIC = {
  strict: 'SCOPE - STRICT (watchlisted member): this message is from someone on the WATCHLIST - previously ' +
    'banned or a repeat problem, being actively monitored. The bar is behavioral, not lexical: is this person ' +
    'actually being disruptive, hostile, rule-breaking, or resuming what got them watched - or is it ordinary ' +
    'participation any member could say freely? Surface anything genuinely concerning; do not flag them for ' +
    'normal in-community talk.',
  loose: 'SCOPE - LOOSE (day-to-day watch): posts to a mods-only log with NO ping - a "worth a glance", not an ' +
    'alarm. Surface only genuine rule-tension, escalating conflict, hostility aimed at someone, or content off ' +
    'for the space. Suppress ordinary chatter, jokes, venting, reclaimed language, and quotes that merely ' +
    'contain a watched word.',
  welfare: 'SCOPE - WELFARE (support check): about a member\'s OWN wellbeing, not rule-breaking. Does this person ' +
    'genuinely seem in distress or reaching for help right now - vs. hyperbole ("kms, I have work tomorrow"), ' +
    'jokes, or lyrics? Surface genuine distress with a LOW bar (a kind check-in beats missing one), but suppress ' +
    'obvious hyperbole. NEVER suppress a specific, sincere statement of self-harm intent. severity = urgency.',
};

function parseVerdict(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let v; try { v = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  if (typeof v.surface !== 'boolean') return null;
  v.confidence = Math.max(0, Math.min(1, Number(v.confidence) || 0));
  v.severity = ['none', 'low', 'medium', 'high'].includes(v.severity) ? v.severity : 'low';
  v.likelyRule = Number.isInteger(v.likelyRule) ? v.likelyRule : 0;
  v.category = typeof v.category === 'string' ? v.category : 'unclear';
  v.reason = typeof v.reason === 'string' ? v.reason.slice(0, 300) : '';
  return v;
}

// One Haiku call. Returns a validated verdict, or null (→ fail-open) on any error.
async function callJudge(scope, payload) {
  const c = getClient();
  if (!c) return null;
  const rubric = SCOPE_RUBRIC[scope] || SCOPE_RUBRIC.loose;
  const ctx = (payload.context || []).map(m => `${m.reply ? '↳ ' : ''}${m.who}: ${m.text}`).join('\n') || '(no prior context)';
  const user = [
    rubric, '',
    `CHANNEL: #${payload.channelName}`,
    `AUTHOR: onWatchlist=${!!payload.onWatchlist} · staff=${!!payload.isStaff} · joined ~${payload.joinedDaysAgo ?? '?'}d ago`,
    `MATCHED TERM(S): ${(payload.matchedTerms || []).join(', ') || '(unspecified)'}`,
    '', 'RECENT CONTEXT (older → newer; "↳" marks messages in the reply chain the flagged message is answering):', ctx, '',
    ...(payload.replyingTo ? [`NOTE: the flagged message is a REPLY to ${payload.replyingTo.who}: "${(payload.replyingTo.text || '').slice(0, 300)}"`, ''] : []),
    '>>> FLAGGED MESSAGE (most recent, from AUTHOR above):',
    payload.content || '(no text - attachment/embed only)',
    '', 'Return only the JSON verdict.',
  ].join('\n');
  const resp = await c.messages.create({
    model: MODEL, max_tokens: 300,
    system: systemPrompt(),
    messages: [{ role: 'user', content: user }],
  });
  const textBlock = (resp.content || []).find(b => b.type === 'text');
  const v = parseVerdict(textBlock && textBlock.text);
  if (v && resp.usage) v._usage = { in: resp.usage.input_tokens, out: resp.usage.output_tokens };
  return v;
}

function logShadow(entry) {
  try { fs.appendFileSync(SHADOW_LOG, JSON.stringify(entry) + '\n'); }
  catch (e) { console.error('[smartwatch] shadow log:', e.message); }
}

// ---- calibration examples (the human-in-the-loop "training") -------------------------------------
// When an admin grades a lab post (🔨 strike-worthy / ⛓️ corner-only / ⬜ fine), that message + verdict is
// appended here. We DON'T fine-tune; instead the most recent labels are injected into the judge prompt as
// few-shot exemplars, so the model learns THIS community's actual bar. Each grade also tells us whether the
// AI's own would-surface call matched the admin — that's the accuracy tally the lab reports.
const EXAMPLES_FILE = process.env.SMARTWATCH_EXAMPLES_FILE || '/home/ubuntu/.fubu_smartwatch_examples.jsonl';
const EXEMPLARS_IN_PROMPT = Number(process.env.SMARTWATCH_EXEMPLARS || 14) || 14;
// verdict → (does the community surface it?) + a short label the prompt shows.
const VERDICT_META = {
  strike: { surface: true,  label: 'STRIKE-WORTHY (a real violation — surface it)' },
  corner: { surface: true,  label: 'CORNER-ONLY (minor — surface, a cool-off not a strike)' },
  fine:   { surface: false, label: 'FINE (benign — a false positive, hide it)' },
};
function loadExamples() {
  try {
    return fs.readFileSync(EXAMPLES_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function addExample(e) {
  try { fs.appendFileSync(EXAMPLES_FILE, JSON.stringify(e) + '\n'); return true; }
  catch (err) { console.error('[smartwatch] example append:', err.message); return false; }
}
// Few-shot block from the most recent labels (both directions), for injection into the judge prompt.
function exemplarBlock() {
  const ex = loadExamples().filter(e => e.verdict && VERDICT_META[e.verdict]).slice(-EXEMPLARS_IN_PROMPT);
  if (!ex.length) return '';
  const lines = ex.map(e => `- "${String(e.content || '').replace(/\s+/g, ' ').slice(0, 180)}" -> ${VERDICT_META[e.verdict].label}`);
  return ['', 'ADMIN-LABELED EXAMPLES from THIS community (real calls the admins made — match this bar; these override your priors when a new message is similar):', ...lines].join('\n');
}
// Accuracy of the AI's own surface/hide call vs. the admin's verdict, over all graded examples.
function labStats() {
  const ex = loadExamples().filter(e => e.verdict && VERDICT_META[e.verdict] && typeof e.aiWouldSurface === 'boolean');
  let right = 0;
  for (const e of ex) if (e.aiWouldSurface === VERDICT_META[e.verdict].surface) right++;
  const byVerdict = { strike: 0, corner: 0, fine: 0 };
  for (const e of ex) if (byVerdict[e.verdict] !== undefined) byVerdict[e.verdict]++;
  return { total: ex.length, right, wrong: ex.length - right, byVerdict };
}
function verdictSurfaces(v) { return VERDICT_META[v]?.surface; }

// ---- public: evaluate one flagged message --------------------------------------------------------
// Returns { ran, verdict, suppress, note }. On ANY problem returns { ran:false } so the caller posts
// the flag exactly as it does today (fail-open).
async function evaluate(scope, msg, matchedTerms) {
  try {
    if (!available()) return { ran: false };
    // gather context: (a) the N messages right before the flagged one, and (b) if it's a reply, the reply
    // chain up to N hops back (following each message's referenced parent). Merge + dedupe by id (the two
    // can overlap), oldest -> newest; reply-chain messages are marked so the judge sees what's being answered.
    let context = [], replyingTo = null;
    try {
      const byId = new Map();
      const fmt = m => ({ id: m.id, ts: m.createdTimestamp, reply: false,
        who: m.author?.bot ? `${m.author.username}(bot)` : (m.author?.username || 'user'),
        text: (m.content || '[embed/attachment]').replace(/\s+/g, ' ').slice(0, 300) });
      const prior = await msg.channel.messages.fetch({ limit: CTX_MESSAGES, before: msg.id }).catch(() => null);
      if (prior) for (const m of prior.values()) byId.set(m.id, fmt(m));
      let ref = msg.reference, hops = 0;
      while (ref && ref.messageId && hops < CTX_MESSAGES) {
        const rch = ref.channelId === msg.channelId ? msg.channel
          : await msg.client.channels.fetch(ref.channelId).catch(() => null);
        const rm = rch && rch.messages ? await rch.messages.fetch(ref.messageId).catch(() => null) : null;
        if (!rm) break;
        const e = byId.get(rm.id) || fmt(rm); e.reply = true; byId.set(rm.id, e);
        if (hops === 0) replyingTo = { who: e.who, text: e.text };   // the message THIS one directly replies to
        ref = rm.reference; hops++;
      }
      context = [...byId.values()].sort((a, b) => a.ts - b.ts);
    } catch { /* context is best-effort */ }
    const member = msg.member;
    const payload = {
      content: (msg.content || '').slice(0, 1500),
      matchedTerms, channelName: msg.channel?.name || 'unknown', replyingTo,
      onWatchlist: !!(config.watchlistRoleId && member?.roles?.cache?.has(config.watchlistRoleId)),
      isStaff: !!opspanel.memberTier(member),
      joinedDaysAgo: member?.joinedTimestamp ? Math.round((Date.now() - member.joinedTimestamp) / 86400000) : null,
    };
    const verdict = await callJudge(scope, payload);
    if (!verdict) { logShadow({ ts: Date.now(), scope, ran: false, channel: payload.channelName, terms: matchedTerms, content: payload.content }); return { ran: false }; }

    const live = !!config.smartWatchLive;
    // Non-English messages tripping an English keyword are noise (their channels have own mini-mods); the
    // judge only tags 'non-english' for benign non-English (real cross-language threats keep the real
    // category), so skip these regardless of shadow/live mode.
    const nonEnglishSkip = verdict.category === 'non-english';
    const wouldSuppress = verdict.surface === false
      && verdict.confidence >= (config.smartWatchSuppressThreshold || 0.85)
      && !NEVER_SUPPRESS.has(verdict.category);
    const suppress = nonEnglishSkip || (live && wouldSuppress);
    logShadow({ ts: Date.now(), scope, ran: true, mode: live ? 'live' : 'shadow', channel: payload.channelName,
      author: msg.author?.id, onWatchlist: payload.onWatchlist, terms: matchedTerms,
      content: payload.content, verdict, wouldSuppress, suppressed: suppress });

    const conf = verdict.confidence.toFixed(2);
    const rule = verdict.likelyRule ? `, Rule ${verdict.likelyRule}` : '';
    const wouldTag = (!live && wouldSuppress) ? ' · would auto-suppress when live' : '';
    const note = `🤖 ${verdict.surface ? 'looks real' : 'likely false positive'} — ${verdict.reason} _(conf ${conf}${rule}${wouldTag})_`;
    return { ran: true, verdict, suppress, note, wouldSuppress };
  } catch (e) {
    console.error('[smartwatch] evaluate:', e.message);
    return { ran: false };   // fail-open on anything unexpected
  }
}

// status line for logs / a future dashboard tile
function status() {
  return { enabled: config.smartWatchLive !== undefined, sdk: !!Anthropic, key: !!API_KEY, live: !!config.smartWatchLive, model: MODEL };
}

module.exports = { evaluate, available, communityProfile, DEFAULT_PROFILE, PROFILE_FILE, status, MODEL, _judge: callJudge,
  loadExamples, addExample, exemplarBlock, labStats, verdictSurfaces, EXAMPLES_FILE, VERDICT_META };
