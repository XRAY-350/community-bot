# Tribe Phase 5 — Rituals & Territory Rivalry: LOCKED SPEC

Status as of 2026-08-02. This is the working plan, negotiated with the owner turn by turn. Written down so
nothing gets lost to context compaction or an error mid-build. Update this file as decisions change; do not
re-derive from memory of the conversation, this file is the source of truth for the plan.

Phases 1-4 of the tribe framework are DONE and live (framework/hub, Warden/leader tools + admin create/register,
ranks + Tides, loyalty join model). Personalization (leader title + rank names per tribe) is DONE and live
(commit 9f88923). This spec covers everything still to build.

## 0. Vocabulary
- **Head** = the tribe's leader. Must hold the **ADMINS-★ role** (not the Administrator permission) — confirmed.
  Display label is per-tribe (`tribes.leaderTitle()`), default "Chief", Cobalt Vigil = "Warden".
- **Tides** = a tribe's personalizable name for personal activity points (Cobalt Vigil = "Tides").
- **The land** = a tribe's private channel category (throne/hall/voice by default, now expandable).

## 1. The three meters (LOCKED)
| Meter | Scope | Resets? | Spent? |
|---|---|---|---|
| **Tides** | per member | never | never (only converted via Offerings, see §4) |
| **Treasury** | per tribe, a bank | never (a stock) | yes, by the head, in the shop (§5) |
| **Glory** | per tribe, weekly flow | every week (§6) | no — decides the crown only |

Why split Treasury from Glory: spending the bank must never cost a tribe the crown race. Competitions/rituals
generally pay into BOTH (an event win compounds: crown progress now + bank for later).

## 2. Faucets (what pays into Treasury / Glory)
- **Weekly crown win:** +500 treasury (paid at reset, see §6)
- **Monthly server contest** (drawing/photo/writing), paid to the winning entrant's tribe:
  1st +300 treasury & +300 glory · 2nd +150 each · 3rd +75 each
- **Ritual: weekly challenge complete:** +200 treasury / +200 glory (ritual design still open, §8)
- **Ritual: muster roll-call:** smaller glory + treasury share for participating members (§8)
- **Offerings** (see §4): treasury only, never glory — an old stockpile can't be laundered into a crown.

## 3. Milestone-gated unlock ladder (LOCKED — this is the "tech tree")
Two paths to each gate: **members OR crowns won** (a small elite tribe can climb by dominating, a large tribe
climbs by recruiting). 1348-member server confirmed, so these are real, reachable tiers, not aspirational.
**Channel cap: 6 total per tribe** (base 3 + up to 3 bought). A bought channel can be torn down by the head,
no refund.

| # | Unlock | Gate (members / crowns) | Treasury cost |
|---|---|---|---|
| 1 | 2nd text channel | 50 / 5 | 500 |
| 2 | Re-theme (head can recolor the tribe gradient AND rename it, anytime after) | 60 / 6 | 400 |
| 3 | External Sounds (tribe voice channel) | 75 / 10 | 700 |
| 4 | 2nd voice channel | 85 / 14 | 900 |
| 5 | Voice quality boost (bitrate/video on tribe VC) | 100 / 18 | 800 |
| 6 | Faster Tides (hall earn-cap 60s → 45s) | 120 / 25 | 2500 |
| ∞ | **Stronghold Tier** (see §3a) | 120 / 25 (same as tier 6 — always available once you're there) | scales, see §3a |

**Explicitly cut from the shop** (owner said no): custom tribe emoji (shared server resource), tribe bulletin
board, rally-ping-as-a-perk (role icon is already granted to every tribe, not a shop item at all).

### 3a. Stronghold Tier — the recurring/infinite sink (NEW, this turn)
Owner: "we should have recurring ones so once you get the last one the shop isn't [complete]." A maxed-out
tribe (bought all 6 fixed unlocks) still needs somewhere to put treasury, so above tier 6 the shop offers an
**uncapped, repeatable purchase**: buying it increments `tribe.strongholdTier` by 1 (starts at 0). Purely
cosmetic/prestige, NEVER touches gameplay balance (unlike Faster Tides, which is why that one is capped at
buying once) — shows as a flourish in `/tribe info`, the leaderboard, and crown announcements (e.g. "🏰 Tier 4
Stronghold"). Cost scales per purchase: **cost = 1000 × (current tier + 1)** (tier 0→1 costs 1000, 1→2 costs
2000, 2→3 costs 3000, etc.) — a genuine treasury sink for a rich, maxed tribe, never "solved."
Open detail to decide when building: exact cosmetic payoff per tier (title flourish text, does it show on the
member-side My Tribe view, does a big tier get its own crown-announcement line). Default to a simple numeric
badge unless the owner wants something showier.

## 4. Offerings — voluntary tithe (LOCKED, owner's idea, better than the original auto-drip pitch)
`/tribe offer <amount>` (or a throne button): a member converts THEIR OWN Tides into their tribe's Treasury.
**Rate: 1:1.** Safe because ranks are promotion-only (never demote) — tithing doesn't knock you down a rank,
it only slows your climb to the NEXT rank (opportunity cost, not punishment). Feeds Treasury only, never Glory.

## 5. The shop — `/tribe expand` (head only)
Lists every unlock from §3 in order: locked (greyed, shows the gate + progress toward it), unlocked-but-unbought
(shows price, Buy button), or bought (shows owned + a Sell/teardown option for channels only). Stronghold Tier
always shows at the bottom once reachable, with its live scaling price.

## 6. Weekly crown cycle (LOCKED)
- **Reset: Sunday 00:00 UTC.** Glory sums reset to 0 for all tribes.
- At reset: the tribe with the highest Glory for the week just ended takes a **single shared "Crown" role**
  (strip from last week's holder, grant to this week's). Throne announcement in the winning tribe. +500
  treasury banked. Tie-break: treasury, then live member count.
- Crown role is a role/bragging-rights reward ONLY (owner: "the reward should just be a role/bragging rights"),
  no channel or territory control — simpler and avoids fights over who controls what.
- Needs a scheduled job (node-cron or equivalent) in the bot process — check for an existing cron pattern
  before adding a new dependency (e.g. does levelcheck or wordfilter already run on a timer?).

## 7. Nominate-a-member flow — DONE 2026-08-02, build order item #5
Three steps, nobody dragged in against their will: `/tribe nominate <user>` (any tribe member, not just the
head) → posts to the tribe's **throne** with Approve/Deny buttons (gated to `tribes.isLeader` or staff) → on
Approve, posts to the PUBLIC **#bot-commands** channel (`BOT_COMMANDS_CH`) pinging the nominee with their own
Accept/Decline buttons (gated to `interaction.user.id === targetId`).
**No DMs anywhere** — checked first (`grep` for `.user.send(`/`createDM` across `index.js` came back empty),
this bot has never DMed a user; the established pattern is public-channel-ping + gated buttons (see the corner
appeal flow) or ephemeral self-serve. Followed that instead of introducing DMs as a first for this codebase.
State is **persisted** (not in-memory like the tribe-builder wizard) since approval/accept can land hours or
days later — added `tribes.createNomination/getNomination/updateNomination/clearNomination`, keyed by targetId
(one active nomination per person), status `pending_approval` → `pending_accept` → cleared on accept/decline.
Re-validates eligibility (not already in a tribe) at both approve-time and accept-time in case things changed
while it was pending. This is IN ADDITION to the existing head-run `/tribe invite`, which stays a direct add.

## 8. Rituals — DONE 2026-08-02, build order item #10, final Phase 5 item
Designed and built in the same session (owner: "Let's do it" — no further back-and-forth needed, proposed the
concrete design and built straight through).

**Muster (roll-call).** `/tribe muster` (leader/staff, one active at a time, ~20h cooldown via
`tribe.lastMusterAt` — `MUSTER_COOLDOWN_MS`) posts to the tribe's **hall** (not throne — hall is where members
actually are and can act; buttons work there regardless of channel send-permissions) with a role ping and a
"🪖 I'm here!" button. Any ACTUAL tribe member (`member.roles.cache.has(tribe.roleId)` checked at click-time)
who clicks is counted once (`tribes.joinMuster`, de-duped). After a 2-hour window (`MUSTER_DURATION_MS`) an
auto-sweep (`sweepExpiredMusters`, boot + every 5 minutes — tighter cadence than the hourly crown check since
the window itself is only 2h) closes it: pays the tribe **+3 treasury and +3 glory PER participant** (naturally
scales with real turnout, no artificial cap — a big muster is worth more), edits the original message to
remove the button, and posts the final tally. State is per-tribe and persisted (`tribe.muster = {startedBy,
startedAt, expiresAt, participants, channelId, messageId}`), survives a bot restart mid-muster.

**Weekly challenge.** Staff-authored, NOT auto-generated (arbitrary goals — "win the voice call marathon",
"most creative confession" — can't be auto-tracked, so staff judges completion by hand, matching how this bot
already treats things like `/wordfilter` and `/weights` as staff-configured rather than automatic).
`/tribe-admin challenge-set <text>` stores ONE server-wide challenge (`s.currentChallenge`, not per-tribe) and
posts it to EVERY tribe's throne. `/tribe-admin challenge-complete <tribe>` marks that tribe done and pays the
spec's exact **+200 treasury / +200 glory**, announced in that tribe's throne. **Not exclusive** — multiple
tribes can complete the same challenge; a tribe just can't double-claim it (`ch.completedBy` tracks who has).
The crown already covers the zero-sum "who's #1" competition, so the challenge doesn't need to duplicate that.
`/tribe-admin challenge-clear` retires the current challenge without setting a new one.

Throne guide (§12) updated a third time: mentions musters in the member section, `/tribe muster` in the
head-only section. This closes the entire Phase 5 build order — every item from the original spec (economy,
builder, nominate, shop, rituals) is now live.

## 9. Valith revamp (LOCKED to happen — MOVED TO BUILD ORDER #1, owner: "we should do it first")
**Current-state audit (done 2026-08-02):** Valith was only ever adopted via `/tribe-admin register`, never
fully built. It has: name "The Tribe Of Valith" / short "Valith", emoji ⚔️, color `#311414`, a role + leader
role, a hall channel, and ranks Initiate/Watcher/Sentinel/Vanguard (identical to Cobalt Vigil's — leftover
default from before personalization existed). It has **no motto, no leaderTitle (defaults "Chief"), no throne
channel, no voice channel, no category** — it's missing real land entirely, unlike Cobalt Vigil. Current
leader-role holder is `brew.d` (515565313098776600) — already confirmed ADMINS-★, so the head requirement is
already satisfied, no reassignment needed.
**DONE 2026-08-02.** Owner's answers: keep the current name/emoji/color, give Valith its own rank names
(distinct from Cobalt Vigil), custom leader title. Proposed and executed (no objection):
- Name/theme: unchanged — "The Tribe Of Valith" / "Valith", ⚔️, `#311414`.
- Leader title: **Warlord**.
- Rank names: **Sellsword → Blade → Reaver → Warbringer** (r0→r3, no collision with Warlord).
- Motto: left blank — settable anytime via `/tribe motto` (existing feature), not re-asked.

Built via a one-off standalone script (`/home/ubuntu/apps/fubu-verify-bot/.valith-revamp-tmp.js`, deleted after
running — do NOT require `index.js` for one-off scripts, it unconditionally `client.login()`s at the bottom
and isn't guarded, so a second require would double-login). The script: created Valith's category
(`1533559899240534168`, "⚔️ ᴠᴀʟɪᴛʜ"), throne (`1533559900419133502`), and voice channel
(`1533559901270442134`), each using Valith's EXISTING role (`1529572527129755738`) and leader role
(`1531593278665789550`) — no new roles created. Moved the pre-existing hall channel (`1529586412381409462`,
was named "our-land" sitting in an unrelated shared category) into the new land and renamed it to match the
framework pattern ("⚔️┆ʜᴀʟʟ"). Renamed the 4 rank roles to match. Updated tribe state (`leaderTitle`,
`categoryId`, `throneId`, `vcId`, rank names via `tribes.setRankNames`). Blessed every touched channel into
permguard. State file ownership restored to `ubuntu:ubuntu` after (script ran as root since the bot token env
file `/home/ubuntu/.fubu_verify_env` is root-only 600, read by systemd before it drops to the `ubuntu` user for
the live service — a plain `sudo -u ubuntu` can't source it directly).

## 9a. Staff oversight of tribe land (DONE 2026-08-02, owner: "allow admins and mods to see all tribes not
just the ones they're a part of. trial mods can stay restricted")
ADMINS-★ and MODS-✰ now get baked-in access to EVERY tribe's private land (category + throne + hall + voice),
not just tribes they personally belong to — parity with that tribe's own leader role on each channel (view +
post + manage-messages on text, view + connect + speak + mute/move on voice). **Trial mods are deliberately
excluded** — they fall through to the ordinary `@everyone` deny, same as any non-member, so they stay
restricted exactly as before.
- **Future tribes:** baked into `buildTribe()` in `index.js` — a `staffAllow(perms)` helper adds
  `opspanel.ADMIN_ROLE_ID` + `opspanel.MOD_ROLE_ID` overwrites alongside the existing leader-role overwrite on
  every channel `buildTribe()` creates. Live for any `/tribe-admin create` from now on (bot restarted to load
  it).
- **Existing tribes:** retrofitted by the same one-off script as the Valith revamp (§9) — applied directly to
  Cobalt Vigil's 4 existing channels and baked into Valith's newly-built land from the start. Every touched
  channel re-blessed into permguard so this isn't flagged as drift.
- If a THIRD tribe is later `register`-adopted (not `create`-built) rather than `create`-built, this same
  retrofit step needs to be repeated by hand for its existing channels — `register` doesn't touch permission
  overwrites at all, it just adopts an existing role/channel by id.

## 9b. Category + role hierarchy grouping (DONE 2026-08-02, owner: "make sure new tribes are place under the
one before it. also make sure roles are put in the correct place/order")
Fourth tribe surfaced mid-session: **Kayena's Cute Crabs** (key `kayena-s-cute-crabs`), created independently by
an admin via the now-working `/tribe-admin create` (validates the framework works end to end — role, leader
role, full land, staff overwrites all came out correct automatically since it was built AFTER the 9a restart).
Also found ~5 orphaned duplicate role-pairs from earlier failed create attempts (`Kayena's Cute Crabs`/`Leader`
x4 variants, `The cute tribe`/`cuties! Leader`), all sitting inert at role position 1 — **not yet cleaned up,
flagged to the owner, no action taken** (deleting roles is destructive; needs explicit go-ahead, not asked yet).
- **Categories:** fixed live — Cobalt Vigil → Valith → Kayena's Cute Crabs categories are now contiguous
  (positions 1/2/3), right after Verify/Rules. **Baked into `buildTribe()` for future tribes**: computes
  `slotCatPos = Math.max(existing tribe category positions) + 1` from the currently-registered tribes before
  creating the new category, then `cat.setPosition(slotCatPos)`. NOTE: channel/category position and role
  position run in OPPOSITE directions in Discord's model (higher channel-position = further down the list;
  higher role-position = further UP the hierarchy) — caught and fixed a bug where the first draft used the same
  `min - 1` formula for both, which would have put a 4th tribe's category at the TOP of the server instead of
  the bottom.
- **Roles:** also baked into `buildTribe()` — `slotRolePos`/`slotLeaderPos` = `Math.min(existing tribe
  role/leader-role positions) - 1`, so a new tribe's role lands directly under the previous tribe's, and its
  leader role lands directly under the previous tribe's leader role.
- **Live fix for the existing 3 tribes:** the TRIBE-role cluster (Cobalt Vigil → Valith → Kayena's Cute Crabs,
  contiguous, right under the anchor) was fixed by the bot via a bulk role-position PATCH — safe because it only
  touched tribe roles + Server Booster + Event Winner, no staff roles. The LEADER-role cluster (Warden → Valith's
  leader → Kayena's leader, near the owner's own roles) required shifting ADMINS-★/MODS-✰/TRIAL MODS/mini-mod
  roles down a few numeric slots to close the gap (no permission change, purely position) — the auto-mode
  classifier correctly blocked the bot from doing this unprompted (shared/staff role hierarchy on production).
  **The owner did this part by hand** via Discord's UI. Final state confirmed by the bot via the API: Warden
  (142) → [Pelz!/Pwincess Perk/Perk!/Chrissy — owner's personal roles, untouched by design] → Valith! (137) →
  Kayena's Cute Crabs Leader (136) → ADMINS-★ (135). Good enough grouping per the owner, no further bot action
  taken here.
- **A bulk role-position PATCH is fragile with multiple simultaneous cross-region moves** — learned the hard way
  this session: sending `{id, position}` for roles in two different clusters in ONE call produced an
  unpredictable interleaved result (Discord doesn't do a clean "insert and shift" per entry when a batch spans
  disjoint regions). The reliable pattern going forward: EITHER move one role at a time via the single-role PATCH
  (like a manual drag), OR if using the bulk endpoint, explicitly list every single role in the affected
  contiguous range with a fully pinned position (not just the ones you're moving), so there's no room for Discord
  to infer wrong. `buildTribe()`'s per-tribe-creation calls use single-role `setPosition()` (one role, one call),
  which is the safe pattern — the fragile case is specifically "reorder several already-existing roles across
  a wide/discontiguous span in one shot."
- **NOT deployed yet** — `buildTribe()` has the 9a + 9b code changes but the bot has not been restarted since;
  holding the restart until the next build step starts (owner: "we'll restart the bot when we start making the
  other stuff"), per §10 below.

## 10. Guided (non-inline) tribe builder — DONE 2026-08-02, build order item #4
`/tribe-admin create` now takes ONLY `leader` inline (validated against ADMINS-★/owner via `opspanel.memberTier`
before anything else opens). Flow, all in `index.js`:
1. Command handler stores `{ leaderId }` in `_tribeWizards` (in-memory, keyed by the founding admin's user id,
   20-minute TTL via `wizardGet`/`wizardTouch`) and immediately `showModal(tribeIdentityModal())` — name*,
   short_name, emoji, points_name, leader_title (5 fields, the modal cap).
2. On submit, replies with an ephemeral **status card** (`wizardStatusMessage`) showing everything captured so
   far plus buttons: ✏️ Identity (re-open modal 1, pre-filled), 🎨 Colours (modal: color* hex, color2 optional),
   🏠 Land (modal: throne/hall names + PURPOSE text for throne/hall, voice name — purpose becomes the channel's
   real Discord **topic**, new `chNames`/`chTopics` support added to `buildTribe()`), a style select
   (small-caps/plain), and ✅ Build / ❌ Cancel.
3. Each modal submit re-renders the SAME status card via `interaction.update()` (a `ModalSubmitInteraction`
   retains `.message` when the modal was opened from a button on that message — falls back to `.reply()` for
   the very first submit, which came from the slash command, not a button).
4. **Build** is disabled until name + colour are both set (the only two hard requirements, matching the old
   inline command's required options). Re-validates the leader still holds ADMINS-★/owner at build time (they
   could've been demoted mid-wizard), then calls the existing `buildTribe()` unchanged otherwise.
Land is fully optional — skip it and channels get the old default names/no topic, exactly like before.
**NOT interactively tested** — I can restart the bot and confirm the command registers with the right options,
but I can't click Discord buttons/submit modals from this environment. The owner should run `/tribe-admin
create` once live and click through Identity → Colours → (optionally Land) → Build before trusting this for a
real tribe.

## 11. Rank-role creation was silently MISSING from buildTribe() — found + fixed 2026-08-02
While writing the throne guide (§12), found that `buildTribe()` never actually created the 4 rank roles or
populated `tribe.ranks` — Kayena's Cute Crabs (the first tribe actually built end-to-end through the WORKING
`/tribe-admin create`, post the 9a staff-oversight fix) had `ranks: undefined`. Cobalt Vigil and Valith only
had ranks because they were built/backfilled by hand outside this code path, which is why the gap went
unnoticed. `/tribe rank`, auto-promotion, and rank display in `/tribe info`/pubdash were all silently no-op-ing
for any tribe actually built the "real" way. **Fixed**: `buildTribe()` now creates the 4 `tribes.RANK_LADDER`
roles (colorless, non-hoisted, pushed to position 1 — matching how Cobalt Vigil's/Valith's rank roles already
look) and stores them in `tribe.ranks` at registration. **Backfilled** Kayena's Cute Crabs with its own 4 rank
roles (Initiate/Member/Veteran/Elder, its own emoji) via a one-off script — this is a genuine "fix the class"
case, not just a Kayena patch.

## 12. Throne pinned guide — DONE 2026-08-02, build order item #8 (pulled forward, owner: "we also need a
pinned artifact in the throne")
`tribeThroneGuide(tribe)` builds a hybrid embed+markdown reference (how to earn the tribe's points, the rank
ladder, every member command, every head/staff-only command, the loyalty/no-self-leave rule) and
`postThroneGuide(guild, tribe)` posts + pins it — both in `index.js`, called automatically at the end of
`buildTribe()` for every future tribe. Backfilled onto all 3 existing tribes' thrones via a one-off script.
Best-effort (missing throne / send failure / pin failure — e.g. 50-pin cap — all fail silently, never blocks
tribe creation). **Needs a manual re-post later**: this guide references `/tribe nominate` (done) but NOT
`/tribe offer` (Offerings, not built yet) — once Treasury/Glory/Offerings ship (build order #7), re-run
`postThroneGuide` for all 3 tribes (or write a `/tribe-admin` refresh command) so the pinned guide stays current
instead of drifting stale.

## 13. Treasury / Glory meters + weekly crown cron + Offerings — DONE 2026-08-02, build order item #8
Implements §1/§2/§4/§6 as locked. In `tribes.js`: `addTreasury/getTreasury/spendTreasury/addGlory/getGlory`
(plain state math), `resetWeeklyGlory(guild)` (picks the winner by Glory → treasury → live member count, zeroes
every tribe's Glory, banks the winner +500 treasury + a `crownsWon` tick, returns the winner or `null`),
`dueForWeeklyCrown`/`markWeeklyCrownDone` (idempotency tracking via a `lastGloryResetWeek` timestamp so a
setInterval tick doesn't need to land exactly on the Sunday 00:00 UTC boundary, just run at least once after it
passes). In `index.js`: `ensureCrownRole(guild)` lazily creates a single server-wide **👑 Tribe Champions**
role (hoisted, gold) the first time it's needed and caches its id in tribe state — self-healing if manually
deleted. `processWeeklyCrownIfDue(guild)` does the actual work: strips the crown role from everyone currently
holding it, grants it to every CURRENT member of the winning tribe's role, posts a throne announcement. Wired
into the boot-catch-up + hourly-check pattern already used for MDNI/dashboard sweeps elsewhere in `index.js`.
**Own interpretation, not explicit in the original spec text**: if EVERY tribe has 0 Glory for the week (no
faucets have paid in — true right now, since contests/rituals aren't wired), `resetWeeklyGlory` still resets
but awards NO crown, rather than crowning an arbitrary tribe off a bare treasury/member-count tie-break with
zero real activity. Confirmed via first live boot: "[tribe crown] weekly reset ran; no tribe earned Glory this
week, no crown awarded" — correct, expected behavior until contests/rituals actually feed Glory.
**Offerings**: `/tribe offer <amount>` — any tribe member converts their OWN Tides into their tribe's Treasury
at 1:1, feeds Treasury only (never Glory, so an old stockpile can't be laundered into a crown). Safe by
construction since ranks are promotion-only.
**`/tribe-admin grant <tribe> <treasury|glory> <amount>`** — added, NOT explicitly in the original spec text,
but necessary: monthly-contest and ritual payouts (§2) can't be auto-wired yet (contests have no code hook for
"pay the winner's tribe" and rituals aren't designed, §8), so this is the stopgap lever admins use to award
those manually until they're automated. Supports negative amounts to correct a mistake.
**`/tribe list` and `/tribe info` now show real data** — found and fixed a related dead-field bug while doing
this: both were already wired to show a `tribe.points` field with a footer literally saying "Points arrive
with the territory system," but `.points` was NEVER incremented anywhere, so every tribe always showed 0 and
`/tribe list`'s sort order was arbitrary. That field WAS the intended hook for exactly this build — replaced
with real Glory (this week) + Treasury (the bank), and `tribes.standings()` now sorts by the same Glory → 
treasury → member-count order the crown itself uses, so the list is an honest "who's currently leading."
Pubdash's My Tribe view also got Glory + Treasury fields for consistency.
**Throne guide refreshed** — added the new `/tribe offer` line to `tribeThroneGuide()` and re-ran the pin
refresh on all 3 existing tribes (edited the existing pinned message in place rather than re-posting, found via
`fetchPinned()` + matching the bot's own message content).

## 14. The land shop — DONE 2026-08-02, build order item #9
`/tribe expand` (leader or staff) opens `tribeShopView(tribe, guild)`: every §3 unlock shown as 🔒 locked
(with progress toward its members-OR-crowns gate), 🔓 unlocked-and-buyable (with a Buy button, disabled if
treasury is short), or ✅ owned — plus the uncapped Stronghold Tier (§3a) always at the bottom with its live
scaling price (`1000 × (tier + 1)`). All catalog data (`TRIBE_UNLOCKS`) and purchase logic
(`applyTribeUnlock`) live in `index.js`, since most unlocks need live Discord objects; `tribes.js` only tracks
what's owned (`hasUnlock`/`addUnlock`/`removeUnlock`/`addStrongholdTier`).
- **`text2`/`voice2`** actually create a channel in the tribe's category, permissioned to match the framework
  defaults (member + leader + staff), blessed into permguard. Gated by `TRIBE_CHANNEL_CAP = 6` — checked before
  allowing the buy.
- **`extsounds`** grants `UseSoundboard`+`UseExternalSounds` on the tribe's existing voice channel (merged onto
  the existing overwrite via `.edit()`, not `.set()`, so it doesn't clobber other perms).
- **`vcboost`** sets the tribe VC's bitrate to 96kbps and video quality to Full.
- **`fastertides`** sets `tribe.tideCooldownMs = 45000`; the message-earning hook (previously a hardcoded
  60000ms constant) now reads this per-tribe, defaulting to 60000. Also fixed that same hook to recognize a
  bought `text2` channel as a valid Tides-earning channel, not just the original hall.
- **`retheme`** has no purchase-time effect — it just flips on a new `/tribe retheme <color> [color2]` command
  (leader/staff, requires the unlock) that edits the tribe's role color(s) anytime after.
- **Every purchase is refunded on failure** — `applyTribeUnlock` throws, the button handler catches and calls
  `tribes.addTreasury` back before reporting the error, so a tribe is never charged for something it didn't get.
- **Teardown** (`text2`/`voice2` only, no refund, per spec) deletes the channel and clears both the channel id
  and the unlock flag, via a 🗑️ button that only appears for owned channel-unlocks.
- Stronghold Tier and `crownsWon` now show as flourishes in `/tribe info` (title line + footer), `/tribe list`
  (🏰N next to the tribe name), and pubdash's My Tribe view (Glory/Treasury fields).
- Throne guide (§12) updated again to mention `/tribe expand` + `/tribe retheme` in the head-only section.
- **Current live state**: all 3 tribes are at 0 treasury/0 crowns/no unlocks, so the shop is fully functional
  but shows everything locked or unaffordable until crowns are won / treasury is earned. Confirmed via direct
  state read, not a live click-through (same caveat as the guided builder, §10 — can't submit Discord
  interactions from this environment).

## Build order (REORDERED 2026-08-02, owner: "we should do it first" re: Valith — do NOT skip ahead without checking in)
1. ~~Valith revamp (§9)~~ — DONE 2026-08-02.
2. ~~Staff oversight of all tribe land (§9a)~~ — DONE 2026-08-02.
3. ~~Category + role hierarchy grouping (§9b)~~ — DONE 2026-08-02.
4. ~~Guided non-inline tribe builder (§10)~~ — DONE 2026-08-02 (owner should click-through test it live).
5. ~~Nominate → approve → accept flow (§7)~~ — DONE 2026-08-02.
6. ~~Rank-role creation bug fix + backfill (§11)~~ — DONE 2026-08-02.
7. ~~Pin the member action guide in each tribe's throne (§12)~~ — DONE 2026-08-02, refreshed twice (§13, §14).
8. ~~Treasury / Glory meters + weekly crown cron + Offerings (§13)~~ — DONE 2026-08-02.
9. ~~The land shop / `/tribe expand` + Stronghold Tier (§14)~~ — DONE 2026-08-02 (owner should click-through
   test it live once a tribe actually has treasury to spend).
10. ~~Rituals: muster + weekly challenge (§8)~~ — DONE 2026-08-02.

## PHASE 5 BUILD ORDER COMPLETE (2026-08-02)
Every item is live: economy (Treasury/Glory/weekly crown/Offerings), the guided tribe builder, nominate, the
land shop + Stronghold Tier, and rituals. **Not yet done** — genuinely open items, not part of the build order:
- Monthly server contests still pay out via the manual `/tribe-admin grant` stopgap, not automatically — there's
  no code hook in the contest system for "pay the winner's tribe." Wire this if/when it becomes annoying to do
  by hand, or leave it manual indefinitely, owner's call.
- The launch announcement (see the dedicated section below) — genuinely worth writing now that the WHOLE
  roadmap is live, not just a partial slice.
- Click-through testing: the guided builder (§10), the shop (§14), and now musters/challenges have never been
  exercised live by clicking real Discord buttons/modals — all reasoned through carefully and syntax/registration
  verified, but this environment can't submit interactions. Worth a real test pass before leaning on them hard.

## Outstanding: launch announcement, revisited
Still not written. Worth asking the owner if they want an announcement now — Valith has real land, tribes are
visually grouped, ranks actually work on every tribe now, nominate is live, and every throne has a reference
guide. That's a lot of visible, member-facing improvement even before the economy/rituals land. Otherwise keep
holding until more of the roadmap is live.

## Decisions still genuinely open (ask, don't guess)
- Stronghold Tier's exact cosmetic payoff per tier (flourish text/visual) — default to a simple numeric badge.
- Whether Valith's actual Discord LEADER ROLE object should be renamed from "Valith!" to something reflecting
  its new leaderTitle "Warlord" — owner said "wait" (2026-08-02), hold off, don't touch it.

## Resolved this round (2026-08-02)
- Rally-ping-as-perk: owner confirmed "it was a nah" — correctly excluded from the shop, no change needed.
- The ~5 orphaned duplicate role-pairs from failed Kayena tribe-creation attempts: owner said "cleanup" — all
  10 orphan roles deleted via the API (204 on each, some hit rate-limits and were retried with a delay). Only
  the active `Kayena's Cute Crabs` / `Kayena's Cute Crabs Leader` pair remains, verified after.

## Outstanding: launch announcement (owner, 2026-08-02: "We also need to create the announcement for when
we're done")
DONE 2026-08-03. Rewritten as a genuine from-scratch introduction (not just "here's what's new") after
realizing the ORIGINAL tribe-launch announcement, drafted much earlier in the framework's history, was ALSO
never sent — meaning most members have never been told tribes exist at all. Merged that old draft's "what is a
tribe" framing with the full current feature set. Sent via a one-shot systemd timer (`fubu-tribes-announce.timer`
+ `send-tribes-announcement.js`) at 2026-08-03 09:00 America/New_York to #announcements: a standalone `@everyone`
message, then the two content halves, 0.5s apart, with a whole-sequence rollback-and-retry (delete what THIS
attempt sent, retry up to 3 times) if any message in the pass fails — so a scheduled unattended send never
leaves a broken half-announcement live.

## 15. Entrance gate — DONE 2026-08-03, general tribe feature (not Valith-specific), REVISED same day
Owner, relaying a request from Valith's leader for an entrance question to self-join: "will mean all of them
will have to get one as well" — built as an opt-in per-tribe feature, OFF by default, not hardcoded to Valith.
`/tribe-admin gate-set <tribe> <prompt> <option_a> <option_b> <correct>` stores `tribe.entranceGate =
{prompt, optionA, optionB, correct}`; `gate-clear` removes it. When a tribe has a gate, the applicant sees the
prompt + two buttons instead of joining immediately; wrong answer never locks anyone out, it just re-shows the
question (or, on the #roles path specifically, tells them to re-pick the tribe — see below). Correct answer
proceeds through `joinTribeSelfServe()`, one shared helper used by every join path so they all do identical
membership-state + role-grant + hall-welcome-post logic (now takes an optional `reason` param so the Discord
audit-log entry reads correctly per path, not always "self-join via #roles").
**Original scoping (superseded within the hour, owner: "I agree that invite shouldn't have it but nomination
should"):**
- ~~Applies to self-join AND nomination-accept~~ → **gate applies to self-join (#roles) AND nomination-accept.
  Confirmed correct** — nomination already has 3-step vetting, but the gate is the applicant's OWN final
  step, not redundant with who vouched for them. Wrong answer at nomination-accept re-shows the SAME quiz
  buttons in place (doesn't destroy the nomination — someone already vouched for them, losing that over one
  miss felt punitive) — asymmetric from the self-join path's "go re-pick from #roles" wording, but each fits
  its own UI shape (nomination is one persistent editable message; self-join starts from a dropdown).
- **Gate does NOT apply to `/tribe invite`** — confirmed, unchanged. The leader already personally vouches for
  that specific person, a quiz on top of a personal invite would be redundant.
**Second, unrelated fix same message: "invite should get consent."** `/tribe invite` previously added the
target DIRECTLY with no consent step at all — a real gap, now fixed. It reuses the nomination/accept machinery
(`tribes.createDirectInvite()` creates a nomination record that starts straight at `pending_accept`, skipping
the approval step since the leader inviting up front already IS the approval) and posts through the same
`postAcceptPrompt()` helper (extracted so both the nomination-approve step and a direct invite show the
identical Accept/Decline card in #bot-commands). The invite path stays gate-free per the point above — only
the ACCEPT step is new, not a quiz.
**Valith is configured**: prompt "Every applicant must choose their weapon.", Spear vs Shield, **Spear is
correct**. Its motto is also now set: "Bound by spears, guarded against foes." (picker + throne guide both
refreshed to reflect the new motto, the gate, and invite's new consent step).

## 16. The "General" rank — DONE 2026-08-03, general tribe feature
Owner: "I think mods or admins should get a special role like general or something." Confirmed via 3 quick
questions: sits ABOVE the whole normal rank ladder (like the tribe leader, one step below them), per-tribe
customizable title (default "General", like leaderTitle), applies to BOTH mod and admin tier.
`tribe.staffRankRoleId` is a real Discord role (created in `buildTribe()` for future tribes, backfilled for the
3 existing ones via a one-off script), `tribe.staffRankTitle` the customizable name (`/tribe-admin
staffrank-set` — also renames the actual role to match, mirroring how `title`/`ranks` already work).
`syncStaffRank(guild, member, tribe)` is the single source of truth: grants the role the instant someone holds
BOTH the tribe's base role AND mod/admin tier and ISN'T the tribe's leader (leader already outranks everything,
so a leader who's also staff just stays leader); revokes it the instant either stops being true (demoted from
staff, banished, or promoted to leader). Called at JOIN time (inside `joinTribeSelfServe`, so all 3 join paths —
self-join, invite-accept, nomination-accept — get it instantly) and swept hourly (`sweepStaffRanks`, boot +
hourly like the other drift sweeps) to catch LATER promotions/demotions of members who were already in a tribe
before gaining or losing staff.
`maybePromoteTribeRank` now also skips staff (in addition to leaders) — they sit in the General slot instead of
climbing the normal ladder underneath. Rank display (pubdash `statusView`/`tribeView`) checks
`member.roles.cache.has(tribe.staffRankRoleId)` directly (the role itself is the source of truth, no need to
re-derive staff tier at display time).
Backfill results on existing tribes: Valith had 2 current members who are staff (ete5785, beautyinelijah) —
both granted General immediately. Cobalt Vigil and Kayena's Cute Crabs had no staff among their existing
members yet, so nothing to grant there (correct — not a bug, just nobody staff had joined yet).

## 17. Mod tribe-founding: two real bugs found + fixed — 2026-08-03
Owner reported: a mod gathered 3 co-signs, ran `/tribe-admin create` again as instructed, got "the application
did not respond," and it just re-opened a fresh co-sign request from scratch. Traced via message history in
#mod-announcements: the SAME founder hit "✅ 3 mods reached" at 01:41 UTC, then 11 hours later got a brand-new
"wants to found a tribe" message needing 2 fresh co-signs — no tribe was ever actually created (`tribes.all()`
still showed only the original 3). Two real bugs, both fixed:
1. **`tribes.clearFoundingRequest()` fired BEFORE `showModal()`** in the create handler, not after actual
   success. If the modal call ever failed, or the founder didn't finish the wizard, the founding request was
   already gone with nothing to show for it. Moved the clear to `tribewiz_build`'s actual success path (right
   next to `_tribeWizards.delete`) — re-running `/tribe-admin create` is now always safe to retry regardless
   of what happened mid-wizard.
2. **The bigger one**: the final Build-step eligibility check only ever accepted `['admin', 'owner']` tier,
   never checking for a mod founding their own tribe. This meant a mod who legitimately gathered 3 co-signs
   could STILL never actually complete founding a tribe — they'd sail through the whole wizard and get
   rejected at the very last click with a confusing "no longer holds the admin role" error. This is almost
   certainly what actually happened to the reported founder: cleared founding request (bug 1) + rejected at
   Build (bug 2) = stuck with no path forward and no visible reason why. Fixed to mirror the exact same
   eligibility rule used at the initial `/tribe-admin create` check (admin/owner unrestricted, OR mod tier
   AND still the same person who started the wizard).
Checked live state after the fix: 2 OTHER founding requests were sitting at 1/2 co-signs (unaffected, still in
progress correctly), no currently-stuck 3-co-sign request needing manual intervention.

## 18. The ACTUAL root cause of "did not respond" — 2026-08-03 (owner caught it)
Owner remembered a known Discord constraint and asked "don't modals need a 45-char label limit? Could that be
the issue?" — checked, and yes: `tribeIdentityModal()`'s `leader_title` field label was **47 characters**
("What the head is called, e.g. Warden (optional)"), 2 over Discord's cap. This makes `showModal()` throw
synchronously, with nothing catching it anywhere in the tribe-wizard code — so the interaction never got ANY
response, exactly matching "the application did not respond." This is the actual root cause of the incident in
§17, not a race/timing issue as first suspected. Audited EVERY `.setLabel()` call in the whole file (`grep`
+ length sort) — this was the ONLY one over 45 chars, an isolated bug, not a systemic pattern. Shortened to
"Head title, e.g. Warden (optional)" (34 chars).
Also added a class-level safety net: `safeShowModal(interaction, modal)` wraps every tribe-wizard `showModal()`
call (5 sites: the identity/colors/land re-edit buttons, and the initial create command's two paths) in a
try/catch — logs the real error AND tells the user "this is a bug, not something you did" instead of a silent,
undiagnosable "did not respond." Scoped to the tribe wizard specifically, not a blanket refactor of every
showModal() call in the codebase (corner/strike modals have been stable and untouched this whole session).

## 19. #roles tribe picker now shows the leader(s) — 2026-08-03
`roleselect.js`'s `tribeBlock()` was pure text from `tribes.all()` data, no live Discord role lookup. Owner
asked for the picker line to show who currently leads each tribe. `tribeBlock()` now takes `guild` and appends
`(led by <@id>, <@id>, ...)` per tribe by reading `guild.roles.cache.get(tribe.leaderRoleId).members` — plural
by design, since a role can technically have more than one holder even though the framework expects exactly
one leader. Threaded `guild` through the 5 call sites that build a tribes block (`buildBlocks`, `appendTribeBlock`,
`refreshTribeBlock`, and both `buildBlocks()` calls inside `rebuild`/`rebuildFromIndex`), each already had `guild`
in scope. Added `guild.members.fetch()` before each (role.members only reflects the cache, same caution as
elsewhere in this file). Pushed live immediately via `refreshTribeBlock()` rather than waiting for the next
tribe-creation trigger — verified the live message now reads correctly for all 4 tribes (Cobalt Vigil, Valith,
Kayena's Cute Crabs, Trib).

## 20. Mod tribe-founding: co-signers lead TOGETHER, plus a real base-membership bug — 2026-08-03
Owner: "why did the other two mods not get the role" (re: Zaire's newly founded tribe) → "No they are meant
to lead it together." Co-signing was previously PURE gate-keeping: it let the founder retry `/tribe-admin
create`, nothing else. Added `addCoLeader(guild, tribe, leaderRole, member)` in index.js — grants a co-signer
the tribe's base role + the SAME leaderRoleId (a Discord role can hold multiple members; `/tribe info` and the
#roles picker's leader line, see §19, already render every current holder, not just one). `tribewiz_build`'s
success path now reads `foundingRequests[founderId].cosigns` *before* `clearFoundingRequest` wipes it, adds
each cosigner as a co-leader, and lists all leaders in the confirmation message. A cosigner already pledged to
a DIFFERENT tribe is skipped (loyalty rule outranks a co-founding grant) and named in the reply, not silently
dropped. Checked every `isLeader()` gate in the file (7 call sites, all `!isLeader && !staffTier` permission
checks) — none assume a single holder, multi-leader is already safe everywhere it matters.

While wiring this up, found a SEPARATE, pre-existing bug via live verification: `buildTribe()` only ever
granted the founder the **leader** role, never the tribe's own **base** role or a `members` entry. The founder
could still see/use their own land (leaderRole carries its own channel overwrites), but never counted as a
real tribe member: no Tides earned in the hall, excluded from the member count and `/tribe roster`, not
blocked from pledging to a different tribe later. Confirmed live on both tribes actually built through this
code path — Kayena (Kayena's Cute Crabs) and Zaire (Trib) both held their leader role but not their base role.
Fixed `buildTribe()` to grant both going forward, and backfilled the base role for Kayena and Zaire directly,
plus granted Trib's 2 co-signers (**562320011981619211**, **922164824094441473** — the "Triangle Nigga" nickname
from §17's incident) full co-leadership (base role + leader role). Posted a confirmation in Trib's throne,
refreshed the #roles picker, and Trib's line now correctly shows all 3 as leaders.

## 21. Tribe colour drift: leader role wasn't kept in sync, never had gradient support — 2026-08-03
Owner hand-recoloured Trib's **leader** role directly in Discord (a new gradient) and asked for it to reflect
on the tribe's other roles. Checked live: `leaderRole` was created SOLID-only in `buildTribe()` (`color:
opts.color`, no `colors:`/gradient), so it had never been able to carry a gradient at all, and `/tribe retheme`
only ever touched the base `tribe.roleId`, never `leaderRoleId` or `staffRankRoleId` — so the 3 roles could
silently drift apart the moment anyone (owner by hand, or retheme) recoloured just one of them. Also found
`color2` (the gradient's second hex) was never persisted to the tribe record at all, only used transiently at
creation then discarded.
Fixed: `buildTribe()` now creates `leaderRole` with the same gradient `roleColors` as the base/staff-rank roles
(falls back to solid on API rejection, matching the existing pattern). `tribes.register()` now stores `color2`.
`/tribe retheme` now applies the same `colors` to base + leader + staff-rank roles together in one pass (loops
over all 3, each falling back to solid individually) and persists `color2` in its patch — a retheme can never
again leave one role's colour behind. `/tribe retheme`'s `color2` option already existed as a command param
(this wasn't new), the actual gap was the leader role itself never honoring it.
Backfilled Trib live: read the leader role's actual current gradient (`primaryColor` `#c2f794` / `secondaryColor`
~`#8ce31f`) and pushed it onto Trib's base role and staff-rank role, plus stored `color`/`color2` on the tribe
record so future retheme calls or a repaired staff-rank role won't fall back to the stale founding colours.

## 22. Colour-entry help: link to an existing visual picker, not a custom one — 2026-08-03
Owner: founders who don't know hex have typed literal garbage into the colour field ("some guy... just put
random letters"), asked if we could give them "their own UI" like Rhythm. Clarified: Discord's component set
is closed (no custom widgets, no colour-picker component exists — confirmed against the official modal-
components docs the same session), and the owner then clarified they meant either (a) point to an EXISTING
site rather than build/host our own, or (b) richer use of Discord's OWN components (Rhythm-style embeds +
buttons), not something outside them. Went with (a): no infra to host or maintain, zero-signup answer.
Added a Link button "🖍️ Pick a colour visually" → `htmlcolorcodes.com/color-picker/` (free, no signup, hex
output front and center) to the founding wizard's status message row, AND to both bad-hex error replies
(wizard modal submit + `/tribe retheme`) via a new shared `badHexReply()` helper — shows up right when someone
already got it wrong, not just as a standing hint they may not notice.

## 23. `/request-role` let members request a tribe's Leader/General role — real bug, fixed — 2026-08-03
Owner: "Remove the tribe leader and general ranks from the role request." `rolereq.js`'s `systemRoleIds()`
blocklist was a hand-maintained list from before the tribe framework existed — it happened to contain Cobalt
Vigil's leaderRoleId (added by hand when Cobalt Vigil was built manually) but NOTHING for Valith, Kayena's
Cute Crabs, or Trib, and never anything for ANY tribe's `staffRankRoleId` ("General") at all. Neither role
carries elevated Discord permissions (they're colour/channel-overwrite roles, not permission roles), so the
POWER-permission check in `whyNotRequestable()` didn't catch them either — a member could `/request-role` a
tribe's Leader or General role and, if staff clicked Approve without noticing, actually be granted it.
Fixed `systemRoleIds()` to pull every registered tribe's `leaderRoleId` + `staffRankRoleId` live via
`tribes.all()` instead of relying on a hand-maintained list, so a newly founded tribe is covered automatically,
no code change needed per tribe going forward. Deliberately left tribe's own BASE role (`roleId`) OUT of this
set — that one stays requestable on purpose, it's the sanctioned `/request-role` petition path for a veteran
who wants into a tribe (see the `roleselect_tribe` handler's veteran message). Verified live against all 4
tribes: Leader + General now correctly blocked, base role still requestable for all 4.
Note on "refresh the list": `/request-role`'s role picker is Discord's own native role-select widget (an
`addRoleOption()`), not something this bot renders or caches — there's no stale list to refresh, the fix is
live immediately on the next `/request-role` use, no further action needed.

## 24. Trib renamed to Whyamiissuperiortribe — found + fixed a 3rd rename-sync gap — 2026-08-03
Owner: Trib's members are renaming to "Whyamiissuperiortribe." Ran the rename directly (leader hasn't
unlocked Re-theme yet — memberGate 60/crownGate 6, Trib has 7 members — so did it as an owner-directed admin
action, same authority level as `/tribe-admin`, not through the gated leader command).
While doing it, found ANOTHER instance of the same rename-drift class from §21/§23: `/tribe retheme` renamed
the base role and leader role on a name change, but never `staffRankRoleId` ("General") — it would've been
stuck on the OLD name forever. Fixed: retheme now also renames the staff-rank role to `${name} General}` to
match, right next to the leader-role rename it already did.
Category channel names were deliberately NOT added to this fix — unlike leader/staff-rank role names (always
`${name} Leader` / `${name} General`, no exceptions), a tribe's land category can be hand-customized at
founding via the land modal (Cobalt Vigil's category is "🌊 ᴛʜᴇ ᴅʀᴏᴡɴɪɴɢ ɴɪɢʜᴛ 彡", nothing like its shortName),
so auto-renaming it on every retheme would clobber a deliberate customization for tribes that have one. Trib's
category was still the untouched auto-generated default, so renamed it by hand for this one instance instead
of writing a heuristic to guess "was this customized." Final state, all verified live: tribe record name+short,
base role, leader role, staff-rank role, and land category all read "Whyamiissuperiortribe" consistently.

## 25. Tribe invite/nomination accept prompts: DM-first, channel fallback — 2026-08-03
Owner: these were getting missed in a busy #bot-commands. Considered DM-only vs DM+fallback vs leave as-is —
picked DM+fallback (owner's choice): a bot DM can fail SILENTLY if the recipient has DMs from server members
off, which is common, so DM-only risks an invite just vanishing with no visible sign anything went wrong.
`postAcceptPrompt()` now tries `member.send()` with the same Accept/Decline buttons first; only posts to
#bot-commands if that DM send fails.
The 3 button handlers this feeds (`tribenom_accept`, `tribenomgate`, `tribenom_decline`) previously assumed
`interaction.guild`/`interaction.member` always exist — true for a channel-posted button, but a DM-originated
component interaction carries neither (DM interactions only ever have `.user`, not `.guild`/`.member`). Fixed
`tribenom_accept` and `tribenomgate` (the two that actually touch guild state) to resolve both explicitly:
`interaction.guild || client.guilds.fetch(config.guildId)`, then `interaction.member || guild.members.fetch(targetId)`.
`tribenom_decline` needed no change, it never touches guild/member. Verified the fallback path still posts to
#bot-commands exactly as before when DM send fails.
