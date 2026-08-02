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
| 2 | Re-theme (head can recolor the tribe gradient anytime after) | 60 / 6 | 400 |
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

## 8. Rituals — still open, needs its own design pass
"Muster roll-call" and "weekly challenge" are named as concepts (§2 faucets reference them) but not designed.
Design when we get to this step: what a muster actually asks members to do, what a weekly challenge is (staff-set
prompt? auto-generated? contest-adjacent?), and how participation is measured/paid out. Do this AFTER the
economy + builder + nominate flow are live, since it's the smallest, most flexible piece.

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
10. Rituals (§8) — design pass, then build. CURRENT NEXT STEP. Once built, wire ritual payouts + monthly
    contest payouts to replace the `/tribe-admin grant` stopgap.

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
Owner wants an announcement drafted for when the tribe Phase 5 work ships (or a relevant milestone within it —
clarify scope when we get there: the whole Phase 5 rollout, or just the next feature going live). Do NOT write
this now — nothing in the build order (guided builder, nominate flow, economy, shop, rituals) is live yet. Draft
it when we're actually close to shipping, pull from the FEATURES_RUNBOOK.md / COPY-REGISTRY.md conventions this
repo already uses for member-facing copy (no em dashes, hybrid embed+markdown per [[hybrid-embeds-and-markdown]]
memory). Revisit this line each time a build-order item ships to decide if "done" has arrived yet.
