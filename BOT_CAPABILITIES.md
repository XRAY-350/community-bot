# FUBU-Verify-Bot — Complete Capabilities Reference

_The authoritative "everything this bot does" document. Complements the design specs
(`TRIBE_PHASE5_SPEC.md`, `TRIBE_PHASE6_SPEC.md`), the flag runbook (`FEATURES_RUNBOOK.md`), and the
auto-generated command map (`COPY-REGISTRY.md`). Last major update: 2026-08-04._

## How the bot is organized
- **Feature registry (`features.js`) is the single source of truth.** Every capability is a feature keyed in
  the registry; a feature is ON only if its flag is explicitly `true` in `~/.fubu_features.json` (fail-off).
  The registry drives command **registration**, handler **gating**, `/help`, and the server guide.
- **Staff tiers** (highest to lowest): **bot-owner** → **owner** (personal admin roles + guild owner) →
  **admin** (ADMINS-★, ManageRoles, NOT the Administrator permission) → **mod** (MODS-✰) → **trial mod**.
  Actions re-check the clicker's tier and refuse if too low.
- **Surfaces:** member-facing **`/dashboard`** hub (buttons), staff **`/panel`** ops dashboard (tier-gated
  pages), the **#roles** self-assign picker, right-click **context-menu** commands, and a shrinking set of
  slash commands (many were consolidated into the two hubs).
- **Two communities, two bots:** this is the FUBU bot; the Girls-Masc community runs a separate bot.

---

# 1. Verification & onboarding
The bot's original purpose: gate the server behind human verification, and reap members who never complete it.

- **The flow:** a new member opens a **thread in the verify channel**; the bot posts a **Verify / Deny panel**.
  A mod clicks **✅ Verify** (swaps Unverified → Verified, archives the thread) or **🚫 Deny & kick** (removes
  them, leaving a one-click **🔨 Ban** escalation). The bot never auto-verifies; it only reacts to staff.
- **Commands:** `/verify @member` and `/pending` (paginated list of open verify threads). Both usable by
  **mods and trial mods** (verifying is a trial-mod training task).
- **Roles:** Verified, Unverified (auto-assigned to anyone missing both, starting their clock), a **minor age
  role** (blocks 18+/MDNI access), and adult age roles. Age/gender/country roles are self-assigned in #roles.
- **Auto warn-then-kick sweep** (~hourly, master **dry-run** switch defaults ON for safety): un-verified
  members are **warned** after ~6 days and **kicked** after ~7 (with a guaranteed grace gap; a warning always
  precedes a kick). Also deletes orphaned/verified threads, nudges mods about stale pending threads, and
  purges chatter. Every destructive pass is individually feature-toggleable.
- **Both-roles conflict** (a glitch member holding Verified + Unverified): the bot won't reap them; instead it
  posts a **weekly react-to-resolve** message (react → Unverified removed) and flags them to a mod channel with
  fix buttons (throttled + capped so a mass glitch can't flood).

# 2. Moderation: corner, strikes, tiers

## 2.1 The Corner (timed jail)
"Send to corner" is a **timed (or indefinite) jail**: the member's roles are **stripped and stored**, they're
locked to a limited channel set, and on release their roles are **restored**.
- **Entry points:** right-click **"Send to corner"** (reason modal), `/corner @member [duration] [rule]
  [reason] [sweep]`, and the ops-panel Corner/Moderation buttons.
- **Kept roles:** identifying roles survive the jail, age, gender, country, MDNI, and Unverified, so a jailed
  member keeps their identity and doesn't fall out of the verification pipeline.
- **Duration:** parsed like `30s / 10m / 2h / 1d` (blank = 15 min default). Precise per-corner timers, re-armed
  on restart, with a periodic poller backstop; release posts a "time served" note.
- **Release:** `/uncorner @member [duration]` (immediate, or reschedule), `/cornered` (roster with one-click
  release buttons), and auto-release when the timer fires. Discord native timeouts are handled around the role
  swap.
- **Auto-corner threads:** opening a thread in the wrong category (rule 9, "right channel right conversation")
  auto-corners the opener briefly and deletes the thread (configurable category allow/deny lists).
- **Tier guard:** you can only corner someone at or below your tier; the **guild owner is never cornerable**;
  the bot owner can corner anyone. **Trial mods** are restricted (must give a rule or reason, and a duration
  ≤ 1h). A **repeat-corner alert** nudges staff to consider a strike after N corners for the same rule.
- Self-healing corner-channel permissions on boot.

## 2.2 Strikes (weighted units)
A weighted-unit model (replaced the old flat Strike I/II/III ladder).
- Each strike carries a **weight of 1-3 units**, cumulative, never auto-expiring. A member wears a **Strike N**
  role at N floored units (green→red gradient).
- **Ban threshold: 10 units.** Crossing it shows a **Confirm** button; the bot **never auto-bans** (staff must
  click). The threshold-crossing strike isn't self-serve appealable.
- A **timeout applied with a strike** adds a linear bonus (up to +2 units: 1h = +1, 2h+ = +2).
- **Giving a strike:** pick a **rule** and/or type a **reason** (at least one), set a **weight** (or auto-fill
  from the rule), optionally attach a **timeout** and/or a **corner** in the same action. Via `/strike add`,
  right-click **"Strike"**, or the panel. `/strike view`, `/strike remove`, and `/weights` (the rule→weight
  guide) round it out. **Admin tier** to act; trial mods see the panel read-only.

## 2.3 Staff tiers & permission model
Tiers are **role-based, not the Administrator permission** (the ADMINS-★ convention):
- **bot-owner** (by user ID, supreme, passes every gate) > **owner** (an owner role **and** Administrator, or
  the guild owner) > **admin** (ADMINS-★, ManageRoles) > **mod** (MODS-✰) > **trial mod** (restricted: verify +
  limited corner only).
- Every action re-checks the clicker's tier. `opspanel.memberTier()` computes it; commands gate with
  `meets(tier, needed)`. Promotions (`promote.js`) run as **advisory votes** and auto-nest roles.

# 3. Monitoring & filters
A layered message-safety pipeline that runs on every message: word filter → smart-watch lab → strict → welfare
→ loose. All monitoring is invisible to members. Term lists live in editable JSON files (2s cache, no restart).

- **Watchlist** — term monitoring with **three overlap-free scopes**:
  - **Strict**: only on messages from members on the **watched-user-ID list** (a plain ID list, not a role, so
    it survives leaves/bans). Posts to **#mod-announcements** with a ping + **Ban / Dismiss / Add-to-watchlist**
    buttons.
  - **Loose**: on anyone (except staff), a quiet, no-ping heads-up to **#watch-log** for day-to-day chatter.
  - **Welfare**: distress signals ("i want to die", "sh") → a soft **🫂 welfare check** in #watch-log, no ban
    buttons, framed as support not rule-breaking.
  - **De-obfuscating matcher**: tolerates separators (`k y s`), leet (`k1ll`, `@ss`), repeats (`killlll`), and
    accents, with word boundaries so `ass` ≠ `classy`. Reused by the word filter.
  - Commands: `/watchlist` (list mod+; add/remove admin), `/watchlist-terms` (list mod+; edit admin, per
    scope), `/watchlist-suggest` (mod+, scans recent chat and recommends new terms), `/unban <id>` (admin,
    unban by raw ID, optional re-watch on rejoin), and right-click **"Report to watchlist"** (mod+ or a
    language mini-mod in-language).
- **Word filter** (`/wordfilter`, mod+): arm any word/phrase to be **silently auto-deleted** from non-staff
  messages for a set duration (or indefinitely). Logs a count to corner-log. Uses the watchlist matcher.
- **Level check** (`/levelcheck`, mod+ view / admin fix): audits members against the **Arcane** leveling bot
  by reading its level-up posts in #bot-commands, flags anyone missing their earned level roles, and (with
  `fix`) grants them.
- **Smart-watch** (feature `smartWatch`, enabled; the judge runs only when an API key is set): an **LLM contextual judge** (Claude
  Haiku) that reads each keyword-matched message **in context** and rules real-concern vs false-positive, to
  cut keyword noise. **Fail-open** (any error → post the raw flag), **shadow-mode first** (annotates, doesn't
  suppress, until `SMARTWATCH_LIVE`), and a hardcoded **never-suppress** floor for child-safety / threats /
  doxxing. Community-aware (a profile file tells it FUBU's norms, e.g. reclaimed language is normal). Owner
  trains it with **`/grade`** (grades feed few-shot exemplars + an accuracy score).
- **Smart-watch lab** (feature `smartWatchLab`, off): runs the judge on **broader** term lists into a private
  admin channel only (public log reverts to plain keyword flags), so admins can evaluate + grade the judge,
  and it can propose strikes/corners on other messages in context. A training sandbox.
- **Freshwatch**: a human-only "⚠️ recently joined" note on flags for unusually new accounts, self-calibrating
  to the server's join distribution (auto percentile mode), plus a one-time **"📈 influx detected"** alert when
  joins spike (possible raid heads-up). Never fed to the AI judge.
- **Language mini-mods** (feature `langMiniMod`, enabled; dormant until languages are configured): per-language
  mini-mod roles that may use **Send to corner** + **Report to watchlist** only within their language's
  channels. With it on, `/apply-mod` adds a language-position picker.

# 4. Community & anonymous tools
Most of these are surfaced as buttons on the member **`/dashboard`** (each opens a modal); several also keep a
slash command. Each has its own per-member cooldown + daily cap and is watchlist-filtered.

- **Suggestions** (`/suggest`, 💡 dashboard): posts a numbered entry to a **bot-gated forum** for 👍/👎 voting;
  staff Approve/Deny on the post. **Named** (not anonymous). ~10-min cooldown, max 3 open.
- **Confessions** (`/confess`, 💭 dashboard): posts **anonymously** to #confessions (bot is the author). A
  mods-only **#confession-log** mirrors each with the real author + a delete button. ~3-min cooldown, 20/day.
- **Whistleblow** (`/whistleblow`): privately flag a problem; the sender **chooses who (if anyone) can ever
  unseal them** — head admin ("you"), owner ("her"), both, or fully **anonymous** (no identity ever stored,
  unmaskable). Delivered by **DM**, never a channel. Recipients get an Unseal button (except anonymous).
- **Reports** (`/report`, 🚩 dashboard, right-click **Report**): report a member or a specific message to a
  staff **#anon-reports** channel. **Reporter sealed**; admins+ can Reveal (logged).
- **Modmail** (`/modmail`, ✉️ dashboard): a private anonymous note to the mod **#mod-inbox**. **Sender sealed**;
  only owners can Reveal.
- **Mod applications** (`/apply-mod`): a 5-question modal → creates a **private applicant thread** (staff can
  ask questions anonymously; applicant replies mirror to the review post) and a **staff review forum thread**
  showing the applicant's answers + a **punishment handicap** (−2/strike unit, −3 if watchlisted, −1 if
  cornered). Mods+ cast **anonymous, tier-weighted advisory votes** (mod 1 / admin 2 / owner 3); **admins+**
  Approve (grants Trial Mod, or a language mini-mod role) or Deny; owners can Undo. `/promote-trial`,
  `/promote-mod` open weighted promotion **votes**; `/demote-trial` strips the role.
- **Role requests** (`/request-role`): ask for or drop a **cosmetic** role → staff Approve/Deny. Hard-blocks
  any role that's managed, above the bot, carries a permission, or is a known system/staff role.
- **Contests** (`/contest`, `/contest-submit`): monthly **Drawing / Photography / Writing** contests with a
  theme, in dedicated channels. Enter by posting (named) or `/contest-submit` (**anonymous**, bot reposts);
  vote with **🩷**; `/contest end` tallies and grants the **🏆 Contest Winner** role (ties = joint winners).
  Auto-closes at month-end. Organizer tools also on the ops panel.
- **Appeals** (feature-flagged): **Ban appeals** (`/appeal ban`) — a **friend** opens a private thread
  (up to 5 friends join to make the case); mods+ advisory-vote, **owner** decides Approve (unban)/Deny;
  the **4 non-negotiable ban categories** (false verification, verification bypass, ban evasion, confirmed
  grooming) are never appealable. **Strike appeals** (`/appeal strike`) — a member appeals their **own**
  strike in a private thread; mods+ advisory-vote, admins+ Approve (remove) / **Reduce** (knock down units) /
  Deny (starts a cooldown). The ban-threshold strike isn't appealable. `/appeal-reset` (admin) clears a
  decided appeal.
- **Member dashboard** (`/dashboard`, pubdash.js): the public hub. Action buttons (Confess, Suggest, Message
  staff, Report, Appeal a strike) open their modals; info buttons show **My Status** (tribe/level/perks/
  strikes), **My Tribe**, **Server Info**, and a link to **#roles**. Everything ephemeral, re-rendered fresh
  each call.

# 5. Structure, admin & infrastructure

## 5.1 Ops panel (`/panel`)
A tier-gated staff dashboard (a pinned message in #mod-dashboard, plus a private `/panel`). Every mod+ can view
every page; each action re-checks tier. Pages:
- **Overview** (mod): status at a glance. **Moderation** (mod): pick a member → corner / verify / uncorner /
  bulk-corner. **Corner** (mod): who's jailed + release buttons. **Strikes** (mod): everyone with strikes →
  manage. **Conflicts** (mod): scan + fix dual-role members. **Anon Tools** (mod): read-only summary of the
  reporting pipes. **Watchlist** (admin): watched IDs + terms + unban. **Actions** (admin): run the sweep now,
  ban, toggle mod-app intake. **Promotions** (admin): open trial→mod / mod→admin votes. **Settings** (admin):
  operational toggles (nudge, conflict-ping, react-resolve, digest, orphan-reap). **🧩 Setup** (admin): the
  consolidated create/repair buttons (replaced the 10 old `*-setup` commands; idempotent). **Danger** (owner):
  the removal policy, test-mode (dry-run), reaping on/off, stale-kick, and timings.

## 5.2 Feature-flag system (`features.js` + `/features`)
The single source of truth (§ intro). **Fail-off**: a feature is on only if explicitly `true` in
`~/.fubu_features.json`. The registry drives command registration, handler gating, `/help`, and the guide.
`/features` (owner) lists + toggles flags live (registration-affecting ones need a restart). "Dark" features
ship inert until flipped on. **Current dark features:** `recruitment`, `smartWatchLab`, `cornerReason`,
`timeServed` (plus the retired `strikeReason`/`fiveStrikes`). Everything else is enabled. (Note: `smartWatch`
is enabled but its LLM judge only actually runs when an API key is set; it fails open otherwise.)

## 5.3 Roles picker (`#roles`, roleselect.js)
A fixed self-assign block (never edited in place; rebuilt from the changed index down): **age** (single-select,
one at a time), **MDNI** toggle, **region / language / notifications / pronouns / misc** toggle buttons,
**color** single-select, and the **Tribes** pledge dropdown. Admins manage sections with `/roleselect-role
add|remove`. Self-heals dead roles hourly.

## 5.4 Permission tooling
- **`/perms`** (bot-owner): a permission inspector, three modes, **tier** (what a tier can see vs a plain
  member), **channel** (per-tier access grid), and **audit** (a grand sweep flagging 🔴 members-can-reach-staff
  / 🟠 over-permissioned-staff / 🟡 missing-@everyone-deny / 🟢 correct).
- **`/permguard`** (owner): guards channel permissions against a **golden manifest** snapshot. Auto-sweeps
  every ~20 min and reverts **role-level** drift (member overwrites are reported, never auto-reverted; managed
  bot roles skipped). `/permguard resnapshot` opens an interactive Keep/Undo reconcile and re-snapshots.
- **MDNI minor-staff lock:** the 18+ channel excludes minors even when they're staff, via a **member-level view
  deny** (a role-deny alone is overridden by the staff-role allow, since Discord OR's role overwrites).
  Real-time + hourly sweeps maintain it; permguard is told to treat those denies as golden.

## 5.5 Transparency & records
- **Digest** (digest.js): a once-daily recap of the bot's jobs (threads deleted, members warned/kicked, role
  assigns, nudges) with Run-sweep-now + Cornered buttons.
- **Owner log** (ownerlog.js): an owner-only #owner-log stream combining **bot actions** (strikes, corners,
  bans, promotions, appeals, permission fixes) and a **mirror of the server audit log** (polled every 2 min,
  grouped by who did it).
- **Rules** (rules.js): the 10 enforceable rules + preamble, used by the corner/strike **rule pickers**;
  per-rule **strike weights** are staff-decided and persisted.

## 5.6 Infrastructure
- **state.js**: tiny JSON persistence (thread/member reap bookkeeping, processed-verified set, daily counters,
  cornered map) with atomic writes.
- **config.js**: all tunables, channel/role IDs, timings (warn/kick days, sweep interval, nudge), feature and
  behavior toggles, corner infra, smart-watch, arena/tribe, MDNI, and language-mod settings. Dashboard toggles
  persist to an override file that's merged over env on boot.
- **memberCache.js / mutex.js / throneExpire.js**: a member-fetch cache (rate-limit friendly), a per-key async
  mutex (used for appeal state), and the tribe-throne message auto-expiry queue.
- Other supporting modules: `copy.js` (public-text source of truth), `pubdash.js` (member dashboard),
  `verifypanel.js`, `strikeAppeals.js`, `promote.js`, `contest.js`, etc.

---

## Feature status snapshot (2026-08-04)
**Live:** verify, panel, features, help, dashboard, corner, strikes, wordFilter, levelCheck, tribes, watchlist,
suggestions, confessions, whistleblow, reports, modmail, modapps, rolereq, roleselect, permguard, perms,
contest, appeals, strikeAppeals, **achievements**, smartWatch (judge needs an API key), langMiniMod
(active per-language once configured).
**Dark (built, off):** recruitment, smartWatchLab, cornerReason, timeServed (and the retired strikeReason,
fiveStrikes).

_Cross-reference note: this document was built by surveying the live code (2026-08-04) and reconciled against
`features.js`, `COPY-REGISTRY.md` (regenerated this session), and the tribe specs. `FEATURES_RUNBOOK.md`
predates the achievements/recruitment features and the command consolidation, so treat this file as the current
source for the feature list._

---

# 6. The Tribe system (member factions)
A full faction/RPG layer: members join tribes, earn activity, climb ranks, run an economy, compete for weekly
crowns and season championships, play cross-tribe games, and wage wars that play out as a live spectacle.

## 6.1 What a tribe is
- A **hoisted role + colour**, its own **private land** (a category with a **throne** control channel, a
  **hall** chat channel, and a **voice** channel; more unlockable), an internal **rank ladder**, and a
  **leader** (each tribe names its own leader title, e.g. Warden/Chief).
- **Rank ladder** (auto-promotion by tenure + Tides, never demotes): Initiate → Member → Veteran → Elder.
  Staff who join as regular members sit in a separate **General** rank above the ladder.
- Channels are grouped under the tribe's category; new tribes are auto-placed and themed.

## 6.2 Founding & membership
- **Founding:** an **admin** can create a tribe outright (guided builder: identity, colours, land). A **mod**
  can found one too, but only backed by **two other mods** who co-sign; all three lead it **together**, and a
  mod-founded tribe must keep **three leaders** to stay standing (drops below → perks freeze until restored).
- **Joining:** your **first tribe is a free self-join** from the #roles Tribes picker. After that you can't
  self-switch: a new tribe must **accept** you via **nomination** (any member proposes → leader/staff approve →
  the nominee accepts), a leader **invite**, or your own **join request**. An optional **entrance gate**
  (a prove-yourself question) can gate acceptance.
- **Loyalty:** once you've been in any tribe you're a "veteran" and can't free-join again. A leader (or staff)
  must **release** you before you can join another. Staff get an instant self-leave.

## 6.3 The three meters
| Meter | Scope | Resets | Spent |
|---|---|---|---|
| **Tides** | per member | never | never (only tithed into Treasury) |
| **Treasury** | per tribe (a bank) | never | yes, in the shop |
| **Glory** | per tribe (weekly flow) | every week | no — decides the Crown |

- **Tides** = personal activity, earned by chatting in your tribe hall (rate-limited) and by playing arenas.
  They rank you up and are your **war power**.
- **Treasury** = the tribe's permanent, spendable bank (crown wins, war raids, ally gifts, offerings, growth).
- **Glory** = this week's competitive standing; whoever has the most on Sunday reset takes the Crown.
- **Offerings / Tithe:** a member can convert their own Tides into their tribe's Treasury (`/tribe offer` or
  the throne **Tithe** button).

## 6.4 Weekly Crown & Seasons
- **Weekly Crown:** every Sunday 00:00 UTC, the highest-Glory tribe takes the shared **👑 Crown role** (+500
  treasury), Glory resets, and it's announced publicly. Tie-break: treasury, then member count.
- **Seasons:** a **6-week** container on top of the weekly crown. Each weekly Crown also banks a **season
  crown**. At season end the tribe with the most season crowns becomes **🏆 Season Champion** — recorded in a
  permanent **Hall of Fame**, granted a rotating champion role, announced publicly — then season crowns
  soft-reset and a new season opens. Treasury, Tides, ranks, and unlocks all carry over.

## 6.5 The Shop (`/tribe expand`, or the throne Shop button)
Milestone-gated tech tree; each unlock needs a **members-OR-crowns** gate plus a **treasury cost**:
2nd text channel, re-theme (recolour + rename), external sounds, 2nd voice channel, voice-quality boost,
faster Tides earning, and a **custom tribe icon** (emoji or uploaded image). Channel cap is 6 per tribe.
- **🏰 Stronghold Tiers** (repeatable, uncapped): **war DEFENSE**. Each tier adds **+10% defensive war power**
  and, if the tribe defends and still loses, **shrinks the treasury raid** (−5 pts/tier, floored at 10%) and
  **captures** (−1 per 2 tiers). The infinite treasury sink with real teeth, and a catch-up turtle for small
  tribes.

## 6.6 Rituals
- **Muster** (`/tribe muster` or throne button): a leader calls a roll-call in the hall (~once a day). Every
  member who clicks "I'm here" within the 2h window earns the tribe **+3 treasury and +3 glory each**
  (underdog catch-up bonus applies). Survives restarts.

## 6.7 The Arena (cross-tribe games)
- **16 game types:** Reaction Race, Trivia Sprint, Word Scramble, Activity Blitz, Math Sprint, Fast Fingers,
  Riddle Rush, Emoji Decode, True or False, Reaction Rush, Number Pattern, Geography/Science/History/Animal
  quizzes, Reverse Word. (Typed, button, reaction, and activity-based mechanics; trivia/quizzes pull from an
  infinite online bank, generated types are infinite.)
- **Auto-runs on its own** through the day (no manual start needed; staff can still `/tribe-admin arena`).
  Scheduling by timezone (default Central Europe):
  - **Peak** (10:00–24:00): full slate, all types, tribe pings, random 1–2h spacing.
  - **Downtime** (a 6–8h block, default 00:00–08:00): calm low-interaction games only, sparser (2–3.5h), and
    pays **2× Treasury but no Glory** (rewards off-hours play without hijacking the crown race).
  - **Dead** (the ~2h gap): nothing.
  Daily cap 16; a hard 1h floor between any events.
- **5-minute lobby** before each event (a heads-up so people gather), announced in a **tribe-announcements**
  channel and each throne, deleted after.
- **Rewards & the daily hook:** the winning tribe banks Glory + Treasury; every point you score also gives
  **you personal Tides**, an **MVP** is crowned per event (bonus Tides), and your **first play each day** pays
  a bonus + ticks a **daily streak**.

## 6.8 Wars & Alliances
- **Declaring war:** a leader proposes; the attacker's OWN members **vote** (24h, needs ≥30% turnout + a
  majority). If it passes, the **defender's leader** chooses **Accept** (fight) or **Decline** → a **coin
  flip** decides whether it happens anyway (ignore it 24h and the coin flip auto-resolves). 72h cooldown after.
- **Resolution is a live spectacle** (the "Madden quicksim"): a **best-of-7 of Tides-power-weighted skirmishes**
  (stronghold walls boost the defender), broadcast to the whole server as a **live-updating scoreboard +
  momentum bar** with **key-moment drops** (first blood, lead changes, match point, final blow). Real members
  star as heroes each skirmish; a **Battle MVP** is crowned. Outcome commits before the show, so it's
  restart-safe.
- **Spoils:** the winner raids ~25% of the loser's treasury (mitigated by the loser's stronghold), banks +100
  glory, and **captures** a few of the loser's regular members (never the leader, never wiped out;
  captured members are locked for 36h).
- **Alliances** (max 1 per tribe): the proposer's members vote, then the target leader accepts. Allies
  **defend each other** in wars (their power adds) and can **gift treasury** to each other.

## 6.9 Achievements & titles (live)
Per-member recognition. Members auto-earn achievements for arena MVPs, daily-play streaks, Tides milestones,
war wins, weekly crowns, and season championships; unlocks are announced in the arena result / war summary.
Each member can equip one **title** (e.g. "the Warrior", "the Champion") shown next to their name in the
roster. Surfaced via the throne **🏅 Trophies** button; **🏛️ Hall of Fame** shows past Season Champions.

## 6.10 Recruitment rewards (built, currently OFF/dark)
Grows the server: when a member you nominate/invite joins **and stays 7 days**, you earn Tides + your tribe
banks treasury (deferred + stick-gated so alts can't farm it), plus one-time treasury bonuses at tribe
growth milestones (10/25/50 members). Enable with `/features toggle recruitment on` after tuning.

## 6.11 Catch-up & spectacle
- **Underdog bonus:** tribes in the bottom half of the standings earn **1.5×** on arena wins and musters, so
  last place can climb.
- **Public spectacle:** war results, weekly crownings, and season champions broadcast to a public channel so
  the whole server (and lurkers/newcomers) see the drama.

## 6.12 Tribe commands & entry points (summary)
- **Members:** `/dashboard` (status/hub), the **#roles** Tribes picker (first join), `/tribe info | roster |
  list`, and the **hub** + **throne** panel buttons (Standings, Rosters, Leaderboards, Shop, Join, Leave,
  Tithe, Trophies, Hall of Fame).
- **Leaders:** the throne panel (Invite, Banish, Note, Set Rank, Retheme, Icon, Announce, Motto, Muster,
  Declare War, Alliances, Gift Treasury).
- **Admins/staff:** `/tribe-admin` (create/register a tribe, set-leader, staffrank-set, run an arena).

---

_Sections 1–5 are filled in from the subsystem surveys below._
