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

## 7. Nominate-a-member flow (LOCKED — replaces plain head-invite for member-initiated adds)
Three steps, nobody dragged in against their will:
1. A **member** (not necessarily the head) proposes someone via a command/button — "I'd like to add X."
2. **Head or admin approves** the proposal (approve/deny buttons).
3. On approval, the **nominee gets their own accept prompt** — they only join if THEY accept.
This is in addition to (not a replacement for) the existing head-run `/tribe invite`, which stays a direct add
for when the head already has the person's buy-in.

## 8. Rituals — still open, needs its own design pass
"Muster roll-call" and "weekly challenge" are named as concepts (§2 faucets reference them) but not designed.
Design when we get to this step: what a muster actually asks members to do, what a weekly challenge is (staff-set
prompt? auto-generated? contest-adjacent?), and how participation is measured/paid out. Do this AFTER the
economy + builder + nominate flow are live, since it's the smallest, most flexible piece.

## 9. Valith revamp (LOCKED to happen, content TBD)
Owner wants Valith rebuilt using the new guided builder once it exists (name/colors/leader title/rank names/
motto/land purpose all re-set through the new flow rather than hand-edited). **Still need from the owner:**
Valith's intended identity (keep name? new colors/motto/leader title/rank names?) before actually rebuilding it.
Don't rebuild it blind — ask when this step comes up.

## 10. Guided (non-inline) tribe builder — build order item #1
Owner: "given all of these details the command should probably not be inline." `/tribe-admin create` currently
takes ~8 inline options and is about to need per-channel name+purpose on top — too much for one slash command.
New shape: `/tribe-admin create` takes ONLY `leader` inline (must resolve to an ADMINS-★ holder — validate
before opening anything else), then opens a **modal** for identity (name, short name, emoji, motto), a
follow-up step (select menus / buttons) for colors + style, then a step to name + set the purpose of the
starter channels (throne/hall/voice, or fewer if the owner wants), ending on a **Build** confirm button that
calls the existing `buildTribe()`. Member-nominate (§7) gets a similar small modal (who + why).

## Build order (current plan, do NOT skip ahead without checking in)
1. Guided non-inline tribe builder (§10) — IN PROGRESS NEXT
2. Nominate → approve → accept flow (§7)
3. Treasury / Glory meters + weekly crown cron (§6) + Offerings (§4)
4. The shop / `/tribe expand` (§3, §5) including Stronghold Tier (§3a)
5. Pin the member action guide in each tribe's throne channel (owner: "we also need this pinned in the throne
   so all members know what they can do" — separate from the shop UI, a static reference post)
6. Valith revamp (§9) — ask owner for Valith's identity first
7. Rituals (§8) — design pass, then build

## Decisions still genuinely open (ask, don't guess)
- Rally-ping-as-perk: owner said "nsh" which was read as a soft no and NOT included in the shop. If that
  was meant as a yes, it needs to be added back with a gate + price.
- Stronghold Tier's exact cosmetic payoff per tier (flourish text/visual) — default to a simple numeric badge.
- Valith's new identity for the revamp (§9).
