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
  whichRule: 'Which rule (optional)?',
  // Parameterised notices shared by the anonymous member tools (confessions / reports / modmail) — identical
  // wording in all three, so they live here.
  onCooldown: min => `You’re on cooldown. Try again in ${min} min.`,
  dailyLimit: max => `You’ve hit today’s limit of ${max}. Try again tomorrow.`,
  notInServer: 'That member isn’t in the server.',
  alreadySetup: 'ℹ️ Already set up:',
};

// ── guards (recurring staff/owner permission denials — reused across index.js/opspanel.js) ────────────
const guards = {
  ownerSetupOnly: 'Only owners can set this up.',
  modRoleOnly: 'Only the mod role can use this.',
  staffOnly: 'Only staff (mods+) can use this.',
  staffOnlyStrike: 'Only staff (mods+) can strike.',
  cantReadMessage: 'Could not read that message.',
  somethingWrong: 'Something went wrong.',
  couldNotFindMember: 'Could not find that member.',
  needsAdmin: 'Needs Admin (or Owner).',
  refuseBanStaff: 'Refusing to ban an admin/owner.',
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
  durationOpt: 'e.g. 30s, 30m, 2h, 3d. Blank = indefinite',  // slash-option / modal description
  badDuration: 'Bad duration. Use e.g. `30s`, `30m`, `2h`, `3d`.',
};

// ── watch-log / smartWatch (STATE-DERIVED) ─────────────────────────────────────────────────────────
// The ops-panel Watchlist status line and any "what does the watch-log do right now" copy derive from the
// judge's actual state, so flipping SMARTWATCH_LIVE (or toggling the lab) updates the text automatically —
// no remembering to hand-edit the panel. Pass the live booleans in at render time.
const watchlist = {
  // labActive: the smartWatchLab feature is on (judge runs in the private lab; public log = plain keywords).
  // live: SMARTWATCH_LIVE (judge suppresses false positives in production).
  monitorStatus(labActive, live) {
    if (labActive) return 'AI judge is in the **lab**. The public watch-log shows plain keyword flags while it’s evaluated.';
    if (live) return 'AI judge is **live**. It hides likely false positives before a flag reaches the log.';
    return 'plain keyword flags, the AI judge is off.';
  },
};

const smartwatch = {
  modeLabel(live) { return live ? '🟢 LIVE: suppressing false positives' : '🟡 shadow: annotating only'; },
};

// ── appeals (ban + strike appeal family — shared notices) ───────────────────────────────────────────
const appeals = {
  untracked: 'This appeal is no longer tracked.',
  denied: '⛔ Appeal denied and closed.',
};

// ── anonymous member tools (each posts anonymously; the noun differs, so one section each) ────────────
const reports = {
  notSetup: 'Reports aren’t set up yet. An admin needs to run `/report-setup`.',
  channelMissing: 'The reports channel is missing. An admin needs to run `/report-setup` again.',
  tooShort: min => `Give a bit more detail: at least ${min} characters.`,
  tooLong: max => `Keep it under ${max} characters.`,
  filtered: 'That tripped the safety filter. Describe the behaviour without threats/slurs and resend.',
  untracked: 'This report is no longer tracked.',
  revealLabel: revealed => revealed ? 'Revealed' : 'Reveal reporter (admins)',
};
const modmail = {
  notSetup: 'Modmail isn’t set up yet. An admin needs to run `/modmail-setup`.',
  channelMissing: 'The modmail inbox is missing. An admin needs to run `/modmail-setup` again.',
  tooShort: min => `That’s too short: at least ${min} characters.`,
  tooLong: max => `Keep it under ${max} characters.`,
  filtered: 'That tripped the safety filter. Reword without threats/slurs and resend.',
  untracked: 'This modmail is no longer tracked.',
  revealLabel: revealed => revealed ? 'Revealed' : 'Reveal sender (owners)',
};
const confessions = {
  notSetup: 'Confessions aren’t set up yet. An admin needs to run `/confess-setup`.',
  channelMissing: 'The confessions channel is missing. An admin needs to run `/confess-setup` again.',
  tooShort: min => `That’s too short. Give at least ${min} characters.`,
  tooLong: max => `That’s too long. Keep it under ${max} characters.`,
  filtered: 'That confession tripped the word filter, so it wasn’t posted. Rephrase it and try again.',
  untracked: 'This confession is no longer tracked.',
  alreadyDeleted: 'Already deleted.',
  delLabel: deleted => deleted ? 'Deleted' : 'Delete confession',
};

const rolereq = {
  notSetup: 'Role requests aren’t set up yet. An admin needs to run `/request-role-setup`.',
  channelMissing: 'The role-requests channel is missing. An admin needs to run `/request-role-setup` again.',
  cantRequest: why => `You can’t request that role: ${why}.`,
  dontHave: 'You don’t have that role, so there’s nothing to remove.',
  alreadyHave: 'You already have that role.',
  noRole: 'That role no longer exists.',
  couldntApply: removing => `Couldn’t ${removing ? 'remove' : 'assign'} it (is it above my role?).`,
};
const suggestions = {
  notSetup: 'The suggestions forum isn’t set up yet. An admin needs to run `/suggest-setup`.',
  forumMissing: 'The suggestions forum is missing. An admin needs to run `/suggest-setup` again.',
  tooShort: min => `That’s too short. Give at least ${min} characters.`,
  tooLong: max => `That’s too long. Keep it under ${max} characters.`,
  filtered: 'That suggestion tripped the word filter, so it wasn’t posted. Rephrase it and try again.',
  openLimit: 'You already have an open suggestion. Wait for staff to resolve it before posting another (keeps the forum tidy).',
  untracked: 'This suggestion is no longer tracked.',
  votingClosed: 'Voting is closed on this suggestion.',
  alreadyResolved: 'Already resolved.',
};
const whistleblow = {
  notSetup: 'Whistleblow isn’t set up yet. The head admin needs to run `/whistleblow-setup`.',
  pickWho: 'Pick who (if anyone) may unmask you.',
  tooShort: min => `Give a bit more detail: at least ${min} characters.`,
  tooLong: max => `Keep it under ${max} characters.`,
  filtered: 'That tripped the safety filter (threats/doxxing aren’t allowed even here). Reword the concern itself and resend.',
  deliverFail: 'Couldn’t deliver: the recipient has DMs closed. Ask an admin to open DMs from server members, then retry.',
  untracked: 'This whistleblow is no longer tracked.',
  fullyAnon: 'This one is fully anonymous. The sender chose “no one”, so there’s no identity to unseal.',
  notAuthorized: 'You’re not authorized to unseal this. The sender entrusted it to someone else.',
};

const modapps = {
  notSetup: 'Mod applications aren’t set up yet. Tell an admin.',
  notSetupNow: 'Applications aren’t set up right now. Tell an admin.',
  alreadyApplied: 'You already have an application under review. Hang tight.',
  submitted: threadId => `✅ Application submitted. View it + chat with staff here: <#${threadId}>`,
  applicantWelcome: memberId => `<@${memberId}>, thanks for applying to mod! 🌱 This thread is just you + staff. Staff may reach out here with questions; reply anytime.`,
  untracked: 'This application is no longer tracked.',
  votingClosed: 'Voting is closed. This application was resolved.',
  alreadyResolved: 'Already resolved.',
  noThread: 'There’s no applicant thread to message.',
  threadGone: 'That applicant thread is gone.',
  sentAnon: '🕵️ Sent to the applicant anonymously. Their reply lands in the thread.',
  untrackedUndo: 'This application is no longer tracked, so there’s nothing to undo.',
  alreadyOpen: 'This application is already open, nothing to undo.',
  whichLang: '🌐 Which language do you want to help moderate?',
};

const contest = {
  noOpenRound: 'No open round to end.',
  needVerified: 'You need to be verified to enter a contest.',
  noRoundNow: 'There isn’t an open contest round right now.',
  notRunning: 'That contest isn’t running this month.',
  channelMissing: 'The contest channel is missing. Tell an organizer to run `/contest setup`.',
  alreadyEntered: label => `You’ve already entered the **${label}** contest this month. One entry per theme 🩷.`,
  needImage: label => `The **${label}** contest needs an **image**. Attach one to \`image:\`.`,
  needWriting: label => `The **${label}** contest needs your **writing**. Put it in \`text:\` (or attach it).`,
  notImage: 'That attachment isn’t an image.',
  postFailed: 'Something went wrong posting your entry. Try again, or post it directly in the channel.',
  posted: (label, channelId) => `✅ Your **${label}** entry is posted anonymously in <#${channelId}>. Your name is hidden. Good luck! 🩷`,
  organizersOnly: 'This dashboard is for event organizers and staff.',
};

const roleselect = {
  alreadyInSection: 'That role is already in this section.',
  notInSection: 'That role isn’t in this section.',
  sectionEmpty: heading => `${heading}\n_Nothing here yet._`,
  header: '# 🎓 Get Your Roles\nPick from each section below. Click a button to toggle it on/off, or use the dropdowns for age and color (those replace your current pick, one at a time).',
  ageHeading: '## 🎂 Age: pick once at registration, locked after you verify (see rule 3)',
  mdniHeading: '## 🔞 MDNI: adults only, also locked after verification',
  colorHeading: '## 🎨 Color',
};
const promote = {
  unknownKind: 'Unknown promotion kind.',
  alreadyOpen: 'There’s already an open promotion vote for them.',
  noChannel: 'Couldn’t reach the promotion channel.',
  voteClosed: 'This vote is closed.',
  alreadyDecided: 'Already decided.',
};

// ── herald (Phase 7: the grand tribe layer's one narrator + shared palette/iconography) ───────────────
// Coronations, the Chronicle, Age ends, wars, quests, relics and prestige all read as a single storyteller
// and share ONE colour/icon per concept. Template-only, no LLM. New grand copy pulls its colour/icon/voice
// from here rather than inlining a hex or emoji, so the whole layer stays visually + tonally consistent.
const SMALL_CAPS = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
const herald = {
  sc: s => String(s).split('').map(ch => SMALL_CAPS[ch.toLowerCase()] || ch).join(''),
  COLORS: {
    age: 0xF1C40F, crown: 0xF1C40F,   // gold — Ages, Hall of Fame, Champions, the Crown
    war: 0xC0392B,                     // blood red
    relic: 0x9B59B6,                   // relic purple
    quest: 0x27AE60,                   // quest green
    prestige: 0xE67E22,                // honour amber
    chronicle: 0x8E7B5A,               // parchment brown
    herald: 0x2A426A,                  // default tribe blue
  },
  ICONS: { age: '🏆', crown: '👑', war: '⚔️', relic: '🏺', quest: '🎯', prestige: '⭐', chronicle: '📜', muster: '🪖', founding: '🏴', herald: '📯' },
  OPENERS: ['Hear ye, hear ye.', 'Let it be known.', 'Attend, all tribes.', 'Sound the horns.', 'Gather and hear.', 'By proclamation.'],
  open() { return this.OPENERS[Math.floor(Math.random() * this.OPENERS.length)]; },
  SIGNOFF: 'So it is written.',
};

module.exports = { common, guards, tiers, corner, watchlist, smartwatch, appeals, reports, modmail, confessions, rolereq, suggestions, whistleblow, modapps, contest, roleselect, promote, herald };
