// rules.js - single source of truth for FUBU's rule text + per-rule strike weight.
// Feeds: /corner + /strike add's rule dropdown (via TITLES, a drop-in replacement for the old
// hardcoded SERVER_RULES array), the mod-announce sign-off posts, and the public rules post.
// weight is null until that rule's mod weight-poll concludes - nothing here is guessed.
const fs = require('fs');
const WEIGHTS_FILE = process.env.FUBU_RULE_WEIGHTS_FILE || '/home/ubuntu/.fubu_rule_weights.json';

const PREAMBLE = {
  title: 'How Enforcement Works',
  text: `**Corner** - A casual, temporary timeout for minor or heat-of-the-moment stuff. No permanent record, and it can happen more than once. If the same behavior keeps happening while you're in the Corner, or keeps happening enough times overall, it becomes a Strike.

**Strike** - The real disciplinary mark. Each Strike is posted publicly in the channel where it happened, no DMs. Strikes don't expire on their own, but can be appealed and removed by staff. Enough strikes, and you're banned.

**Timeout** - Discord's actual mute feature, blocks you from talking anywhere. Not its own step, it can get attached to certain Strikes as an extra consequence.

**Watchlist** - Probation. Mainly used for people let back in after a ban, or anyone staff wants to keep a close eye on.

**Ban** - Permanent removal. Either from racking up enough Strikes, or instantly for the offenses serious enough to skip everything else (false verification, ban evasion, actual grooming, and similar).`,
};

// weighable: false for rules that never result in a weighed Strike (always instant-ban, or non-punitive,
// or a pure grant of authority) - these don't get a weight poll in Step 0.
const RULES = [
  { key: 'black-space', title: 'This Is a Black Space', weighable: false,
    text: `FUBU is a Black-only community. Non-Black people may not join or participate, period. If you falsely verify or don't actually meet membership requirements, that's a permanent ban, no warning. If you try to bypass verification, misrepresent who you are, or come back on an alt after getting banned, that's also an instant permanent ban. This isn't up for debate.` },
  { key: 'child-safety', title: 'Zero Tolerance on Child Safety', weighable: true,
    text: `Look out for each other. If an adult is grooming a minor, that's an instant permanent ban and it gets reported. No exceptions, no discussion.
Jokes about grooming, rape, or pedophilia (Epstein jokes included) aren't "just jokes" here. They're a Strike. If you're not sure whether something crosses the line, it does. Don't post it.` },
  { key: 'verify-or-move-on', title: 'Verify or Move On', weighable: false,
    text: `New members have 7 days to complete verification. You'll get a warning from the bot on day 6, and if you're still not verified by day 7, you're removed automatically. If you want the MDNI (Minors Do Not Interact) role, that's a choice you make during registration, it's not automatic just for being 18+.` },
  { key: 'respectful-language', title: 'Respectful Language, No Exceptions', weighable: true,
    text: `This server has minors in it, so sexual jokes, innuendo, flirting, and suggestive language aren't allowed in general channels. This applies to everyone, adults and minors alike, no exceptions either way. Being a minor doesn't get you a pass, and "they said it first" doesn't get an adult one either.
If you want that kind of conversation, the MDNI (Minors Do Not Interact) role and its space exist for a reason. Outside of that, if you're unsure whether something crosses the line, it does. Don't post it.` },
  { key: 'respect-everyone', title: 'Respect Everyone', weighable: true,
    text: `No harassment, bullying, name-calling, personal attacks, hate speech, or discrimination. Don't shame people without reason. Minor stuff gets you a trip to the Corner to cool off. Real harassment, or repeated behavior after a Corner, is a Strike. Hate speech carries extra weight.` },
  { key: 'privacy-sacred', title: 'Privacy Is Sacred', weighable: true,
    text: `Don't share anyone's personal information, private messages, or identifying details without their consent. Depending on what's exposed, this can be a Strike or an instant permanent ban, staff will judge severity case by case.` },
  { key: 'respect-space', title: 'Respect the Space', weighable: true,
    text: `Respect this community and follow staff instructions. Don't intentionally disrupt conversations or stir up unnecessary drama. First time, that's a trip to the Corner. Keep doing it, and it becomes a Strike.` },
  { key: 'no-spam', title: 'No Spam', weighable: true,
    text: `No repeated messages, emoji/GIF spam, mention spam, channel flooding, excessive caps, or generally disruptive posting. First offense is a Corner. Keep it up, and it becomes a Strike.` },
  { key: 'right-channel', title: 'Right Channel, Right Conversation', weighable: true,
    text: `Use channels for what they're actually for. Debates and arguments belong in the designated discussion channels only, don't drag them into unrelated conversations or let them run until they become disruptive. This one's usually a Corner.` },
  { key: 'no-weaponize', title: 'Don’t Weaponize the Tools', weighable: true,
    text: `Anonymous reports, whistleblowing, confessions, and modmail exist to protect this community, not to be used against someone. Filing false or exaggerated reports, using confessions to out or harass someone while hiding behind anonymity, or tagging staff to go after someone without real cause are all violations. If you've got a real issue, use the tools the right way and let staff handle it. This one starts as a Strike.` },
  { key: 'staff-authority', title: 'Staff Keeps the Lights On', weighable: false,
    text: `Staff decisions are final. Mods and admins can remove messages, send you to the Corner, issue a Strike, or ban whenever it's necessary to protect the community, even for stuff not spelled out in these rules.` },
];

// Drop-in replacement for the old hardcoded SERVER_RULES array - same shape (array of title strings),
// so /corner + /strike add's rule dropdowns and any `${i+1}. ${title}` formatting need no other changes.
const TITLES = RULES.map(r => r.title);

function loadWeights() { try { return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); } catch { return {}; } }
function saveWeights(w) { try { fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2)); } catch (e) { console.error('[rules] save:', e.message); } }
// null = not decided yet (staff still voting) - never guessed.
function weightOf(key) { const w = loadWeights()[key]; return (w === 1 || w === 2 || w === 3) ? w : null; }
function setWeight(key, w) { const all = loadWeights(); all[key] = w; saveWeights(all); }
function byIndex(i) { return RULES[i - 1]; } // 1-indexed, matching the existing "Rule N" convention

// Staff-facing handling summary per rule (Corner vs Strike vs instant-ban). Kept here next to the rule
// text + weight so the staff weight list (/weights) stays a single source of truth and never drifts.
const ENFORCE = {
  'black-space': 'Instant permanent ban',
  'child-safety': 'Grooming → instant ban · "jokes" → Strike',
  'verify-or-move-on': 'Auto-removal at day 7 - not a strike',
  'respectful-language': 'Strike - sexual talk in general channels',
  'respect-everyone': 'Minor → Corner · real/repeat → Strike (hate = extra)',
  'privacy-sacred': 'Strike - or instant ban if severe (staff judge)',
  'respect-space': 'First → Corner · repeat → Strike',
  'no-spam': 'First → Corner · repeat → Strike',
  'right-channel': 'Usually Corner · repeat → Strike',
  'no-weaponize': 'Starts as a Strike',
  'staff-authority': 'Staff authority - not an infraction',
};

// One row per rule for the staff weight list: { n, title, weighable, weight, weightStr, enforce }.
// weight is the live decided value (null until its weight-poll concludes); weightStr renders it.
function infractionLines() {
  return RULES.map((r, i) => {
    const weight = r.weighable ? weightOf(r.key) : null;
    const weightStr = !r.weighable ? '-' : (weight ? `${weight}u` : 'TBD');
    return { n: i + 1, title: r.title, weighable: r.weighable, weight, weightStr, enforce: ENFORCE[r.key] || '' };
  });
}

module.exports = { PREAMBLE, RULES, TITLES, weightOf, setWeight, loadWeights, byIndex, ENFORCE, infractionLines };
