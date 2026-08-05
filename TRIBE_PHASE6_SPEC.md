# Tribe Phase 6 — Sustainability build-out: LIVING SPEC

Owner goal (2026-08-04): "really build out this tribe system... hopefully it will draw people to the server
as well as keep it alive... I'm not sure how sustainable it will be before people get bored." The diagnosis:
the mechanics are deep, but there was no reason to show up on a given day and, once one tribe pulls ahead, the
race felt decided. Phase 6 adds the retention layer on top of the Phase 5 economy.

Build order is by DEPENDENCY (owner: "the only order that matters is what's structural and then what builds on
top of it"): structural container first, then what layers on it.

## Design principles carried forward (do not drift)
- **Registry-driven, fail-off features** (`features.js` + `.fubu_features.json`). New commands register only via
  the registry. Phase 6 adds NO new top-level commands (all under the existing `tribes` feature), so the
  registry is unchanged. Regenerate `COPY-REGISTRY.md` (`node scripts/copy-registry.js`) whenever commands change.
- **Mentions live in message CONTENT, never embeds** (so they resolve for uncached viewers).
- **Hybrid output**: coloured embeds + Discord markdown (headers, subtext, blockquotes), not plain-embed-only.
- **No em dashes** in new public copy or owner chat replies. Use commas, colons, parentheses, periods, hyphens.
  (Existing copy predates this and is saturated with them; a historical sweep is a separate task.)
- **Everything persists except the competition.** Seasons soft-reset the season race only; Treasury, Tides,
  ranks, unlocks, and lifetime crowns carry over.

---

## 1. Stronghold = war defense — DONE (commit ab11ea4)
Owner: "stronghold means nothing but it can be a defense against war." Stronghold Tiers were cosmetic; now they
DEFEND (defender only, in `tribes.simulateWar`):
- **+10% defensive war power per tier** (`STRONGHOLD_DEF_PER_TIER`). Walls multiply the defender's side;
  attackers cannot carry walls into a fight.
- If the defender still LOSES, walls blunt the sack: treasury raid drops 5 pts per tier
  (`STRONGHOLD_RAID_REDUCE_PER_TIER`, floored at `WAR_RAID_MIN_PCT` = 10%), and 1 fewer member captured per 2 tiers.
- The war-result summary shows a "🏰 stronghold softened the blow" line when it applied.
- Doubles as catch-up: a smaller tribe can turtle instead of being farmed. Shop copy updated.

## 2. Seasons — DONE (commit 1cbe582)
The long-term competitive container ON TOP of the weekly crown.
- A season spans **6 weeks** (`SEASON_LEN_MS`, tunable). Every weekly Crown also banks a **season crown**
  (`resetWeeklyGlory` ticks `seasonCrowns`).
- At season end (`processSeasonEndIfDue`, boot + hourly, idempotent), the tribe with the most season crowns is
  the **🏆 Season Champion**: recorded in a permanent hall of fame (`seasonHistory`), granted a rotating
  champion role, announced in tribe-announcements + its throne. Then season crowns soft-reset and the next
  season opens.
- Tie-break: season crowns, then treasury, then live member count. No crown claimed → no champion, season still
  rolls over.
- Surfaced: hub embed "Seasons" section; the Standings button shows the current season, time left, and the
  season-crown leader.
- State: `s.season {number, startedAt, endsAt}`, `s.seasonHistory[]`, per-tribe `seasonCrowns`,
  `s.seasonChampRoleId`. Helpers in `tribes.js`; rotation unit-tested.

## 3. Daily hook — IN PROGRESS
Convert weekly check-ins into daily logins by making the (now auto-running) arena pay PERSONAL progress and by
adding a light daily quest. Folds in the "arena engagement layer".
- **Arena scoring pays personal Tides.** Scoring a point in any arena awards the scorer Tides (personal,
  permanent, ranks you up in your tribe), tracked per member per event.
- **Arena MVP.** Track the top scorer per event; announce an MVP at the end (bonus Tides / shout-out).
- **Daily play bonus + streak.** A member's first arena score of the UTC day pays a bonus and ticks a daily
  streak; the streak resets if a day is missed. Auto-tracked, no new command.

## 4. Public spectacle + catch-up — PLANNED
Make the drama visible (draws lurkers/newcomers) and keep last place from quitting.
- **Public broadcast** of big moments (war results, weekly crownings, season champions) to a public spectacle
  channel, not just the private thrones.
- **Underdog catch-up**: bottom-standing tribes earn a bonus multiplier on event payouts (arena/muster) so the
  gap does not run away. Optionally a bounty for beating the reigning champion.

## 5. Arena expansion — ONGOING
Keep variety high. 11 types live (race, trivia, scramble, blitz, math, typing, riddle, emoji, truefalse,
reaction, pattern), auto-started through the day (`maybeAutoStartArena`) with a 5-min lobby, daily cap 5,
3h cooldown. More to add: themed trivia categories (opentdb `category`), plus additional generated games.

---

## Status
- [x] 1. Stronghold defense
- [x] 2. Seasons
- [ ] 3. Daily hook
- [ ] 4. Public spectacle + catch-up
- [ ] 5. More arena games
