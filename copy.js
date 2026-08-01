// copy.js — SINGLE SOURCE OF TRUTH for public-facing text.
//
// Why: user-facing strings were scattered across index.js / opspanel.js / modapps.js / freshwatch.js, so a
// behaviour change meant hunting down every copy of a description and hoping you didn't miss one (we didn't
// always — see the "30s" duration drift). This module fixes that: change a string HERE and every render site
// updates. Text that depends on FEATURE STATE is a function of that state, so it can't drift out of sync.
//
// Two kinds of entries:
//   • constants  — a string reused in ≥2 places (change once, propagates).
//   • functions  — text DERIVED from live state (e.g. the watch-log panel label depends on whether the AI
//                  judge is live), so callers render it fresh and it always matches reality.
//
// Coverage is being migrated feature-by-feature (owner ruling: full sweep over time). Progress + a map of
// every reference site: see COPY-REGISTRY.md (regenerate with `node scripts/copy-registry.js`). When you add
// a user-facing string, put it HERE and reference it, rather than inlining it.

// ── common ────────────────────────────────────────────────────────────────────────────────────────
// Short notices reused across many call sites (the "no member" line alone was in 10 places) — centralised
// so they read identically everywhere and a re-word happens once.
const common = {
  noMemberInServer: 'That member is no longer in the server.',
  noWatchlistRole: 'No Watchlist role configured.',
  whichRule: 'Which rule (optional)?',
  // Parameterised notices shared by the anonymous member tools (confessions / reports / modmail) — identical
  // wording in all three, so they live here.
  onCooldown: min => `You’re on cooldown — try again in ${min} min.`,
  dailyLimit: max => `You’ve hit today’s limit of ${max}. Try again tomorrow.`,
};

// ── tiers ─────────────────────────────────────────────────────────────────────────────────────────
const tiers = {
  mod: 'MODS-✰',
  admin: 'ADMINS-★',
  owner: 'OWNER role + Administrator permission',
};

// ── corner ────────────────────────────────────────────────────────────────────────────────────────
// The single list of duration units parseDuration accepts. Everything else derives from it, so adding a
// unit (or fixing the "30s" drift) happens in ONE place.
const corner = {
  units: '30s, 30m, 2h, 3d',
  unitsDot: '30s·30m·2h·3d',                                  // compact form for the pinned command reference
  durationOpt: 'e.g. 30s, 30m, 2h, 3d — blank = indefinite',  // slash-option / modal description
  badDuration: 'Bad duration — use e.g. `30s`, `30m`, `2h`, `3d`.',
};

// ── watch-log / smartWatch (STATE-DERIVED) ─────────────────────────────────────────────────────────
// The ops-panel Watchlist status line and any "what does the watch-log do right now" copy derive from the
// judge's actual state, so flipping SMARTWATCH_LIVE (or toggling the lab) updates the text automatically —
// no remembering to hand-edit the panel. Pass the live booleans in at render time.
const watchlist = {
  // labActive: the smartWatchLab feature is on (judge runs in the private lab; public log = plain keywords).
  // live: SMARTWATCH_LIVE (judge suppresses false positives in production).
  monitorStatus(labActive, live) {
    if (labActive) return 'AI judge is in the **lab** — the public watch-log shows plain keyword flags while it’s evaluated.';
    if (live) return 'AI judge is **live** — it hides likely false positives before a flag reaches the log.';
    return 'plain keyword flags — the AI judge is off.';
  },
};

const smartwatch = {
  modeLabel(live) { return live ? '🟢 LIVE — suppressing false positives' : '🟡 shadow — annotating only'; },
};

// ── appeals (ban + strike appeal family — shared notices) ───────────────────────────────────────────
const appeals = {
  untracked: 'This appeal is no longer tracked.',
  denied: '⛔ Appeal denied and closed.',
};

// ── anonymous member tools (each posts anonymously; the noun differs, so one section each) ────────────
const reports = {
  notSetup: 'Reports aren’t set up yet — an admin needs to run `/report-setup`.',
  channelMissing: 'The reports channel is missing — an admin needs to run `/report-setup` again.',
  tooShort: min => `Give a bit more detail — at least ${min} characters.`,
  tooLong: max => `Keep it under ${max} characters.`,
  filtered: 'That tripped the safety filter — describe the behaviour without threats/slurs and resend.',
  untracked: 'This report is no longer tracked.',
  revealLabel: revealed => revealed ? 'Revealed' : 'Reveal reporter (admins)',
};
const modmail = {
  notSetup: 'Modmail isn’t set up yet — an admin needs to run `/modmail-setup`.',
  channelMissing: 'The modmail inbox is missing — an admin needs to run `/modmail-setup` again.',
  tooShort: min => `That’s too short — at least ${min} characters.`,
  tooLong: max => `Keep it under ${max} characters.`,
  filtered: 'That tripped the safety filter — reword without threats/slurs and resend.',
  untracked: 'This modmail is no longer tracked.',
  revealLabel: revealed => revealed ? 'Revealed' : 'Reveal sender (owners)',
};
const confessions = {
  notSetup: 'Confessions aren’t set up yet — an admin needs to run `/confess-setup`.',
  channelMissing: 'The confessions channel is missing — an admin needs to run `/confess-setup` again.',
  tooShort: min => `That’s too short — give at least ${min} characters.`,
  tooLong: max => `That’s too long — keep it under ${max} characters.`,
  filtered: 'That confession tripped the word filter, so it wasn’t posted. Rephrase it and try again.',
  untracked: 'This confession is no longer tracked.',
  alreadyDeleted: 'Already deleted.',
  delLabel: deleted => deleted ? 'Deleted' : 'Delete confession',
};

module.exports = { common, tiers, corner, watchlist, smartwatch, appeals, reports, modmail, confessions };
