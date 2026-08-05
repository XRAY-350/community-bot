# Proving Grounds, Spec (v1)

**Status:** spec only, not built. Third of three throne-competition modes, and the FIRST
mode to introduce net-new games (its own pool). The regular arena and sealed arena share the
existing game pool; Proving Grounds gets brand-new games.

## Concept
A solo async gauntlet. Where the regular and sealed arenas are tribe-vs-tribe and loud,
Proving Grounds is you against the challenge, on your own time. You prove YOURSELF. Individual
spotlight, but your results still feed your tribe.

## Locked decisions (owner 2026-08-05)
- **Individual + feeds the tribe:** personal spotlight (daily leaderboard, streak, a weekly
  Prover track), and your score also banks a little Treasury/Glory for your tribe. Not purely
  personal.
- **Daily challenge, async:** a new challenge opens each day and stays open all day, so members
  play whenever (fits FUBU's timezone spread). Refreshes daily.
- **Both layers of progression, the long track is a WEEK:**
  - **Daily:** each day's challenge has its own leaderboard, rewards, and a play streak.
  - **Weekly Prover track:** daily scores accumulate over the week into a Prover total that
    culminates at the weekly boundary (same reset as the Crown/Glory) with a "Prover of the
    Week" recognition, then resets. A week-long track, not an endless climb.
- **Game pool (net-new, its own):** Knowledge Gauntlet, Puzzles, Score-Attack. Daily one-shots
  are OPTIONAL (owner impartial, parked for now). Skill/memory games are OUT (owner ruled out).

## Delivery: private + ephemeral (design call)
Because it is individual and async, a member runs their attempt PRIVATELY via an ephemeral bot
reply, so nobody sees their answers and there is no live audience. Entry via a `/proving-grounds`
command and/or a button in a Proving Grounds channel (or the dashboard). No per-throne channels
and no concurrent live-game plumbing, so it is much lighter than the sealed arena.

## The daily loop
1. At the daily reset, a new challenge opens (one game family, rotating day to day, so everyone
   faces the same game that day and the leaderboard is comparable).
2. A member runs it privately/ephemerally, whenever they like that day.
3. Their score is recorded: they land on the day's leaderboard, earn personal points, tick their
   play streak, and bank a little Treasury/Glory for their tribe.
4. At day's end, a public wrap posts the top provers and which tribe's provers showed up most.
5. Scores roll into the weekly Prover total.

## The weekly track
- Daily scores sum into a weekly Prover total per member.
- At the weekly boundary (same as the Crown/Glory reset), a "Prover of the Week" reveal names the
  top provers (a weekly title plus a points bonus, tied into achievements), and the tribe whose
  provers totalled most gets a tribe reward. Then it resets. Feeds the Chronicle.

## The game pool (net-new)
All must be async-friendly and self-scored (no live cross-player timing needed).
1. **Knowledge Gauntlet:** streak survival. Questions drawn from the existing trivia/quiz banks
   (reuse). Answer correctly to continue; a wrong answer, or running out of a few lives, ends the
   run. Score = streak length. Button-answered.
2. **Puzzles:** a rotating set:
   - Cryptogram: decode a short phrase (letter substitution).
   - Word ladder: change one word into another, one letter at a time.
   - Anagram chain: unscramble a themed series.
   - Logic sequence: a harder "what comes next" than the arena's Number Pattern.
   Typed-answered. Score = solved, with a bonus for speed or fewer hints.
3. **Score-Attack:** an endless ladder of rising difficulty (escalating trivia / math / pattern).
   Keep clearing rungs until you miss. Score = rungs cleared.
- **Daily one-shots (optional, parked):** a single daily puzzle (a daily word, guess-from-hints).
  Owner impartial, so not in v1 unless we want a light-touch add.
- **Ruled OUT (owner):** skill/memory games (Simon-style recall, typing gauntlet).

## Rewards
- **Personal:** points scaled by score, daily leaderboard placement, a play-streak bonus, and the
  weekly Prover title. Ties into achievements (a Prover counter) and the existing title system.
- **Tribe:** each attempt banks a little Treasury/Glory for the member's tribe, so active provers
  lift their tribe; the weekly top-prover tribe gets a bonus.

## Architecture notes
- New module (proving.js): per-member per-day attempt records (played? score), weekly accumulation,
  daily + weekly resets aligned to the existing weekly boundary.
- Delivery via ephemeral interactions (command/button), so no per-throne channels or concurrent
  live-game state (unlike the sealed arena).
- Reuses the arena trivia/quiz banks plus the cross-game recency de-dup for the Knowledge Gauntlet;
  new generators for the puzzles and the score-attack ladder.
- Reporting reuses the Herald voice and the spectacle/Chronicle hooks.
- Feature flag: `provingGrounds`, fail-off, seeded dark until built and tuned, then flipped live.

## Build order (when we build it)
1. proving.js state (daily attempt records, weekly accumulation, resets).
2. Entry point (command/button) plus the ephemeral attempt flow.
3. Knowledge Gauntlet (reuse the banks, streak survival).
4. Score-Attack ladder.
5. Puzzles (cryptogram, word ladder, anagram, logic-sequence generators).
6. Daily leaderboard plus the day's-end wrap.
7. Weekly Prover track, weekly reveal, tribe rewards, Chronicle/quests/achievements hooks.
8. `provingGrounds` feature flag, tuning, go-live.

## Format rules (owner-confirmed 2026-08-05)
- Delivery is private and ephemeral (individual, no audience).
- One attempt per member per day (keeps the leaderboard fair, no grinding).
- One game family per day, rotating, rather than all three available at once (so the daily
  leaderboard compares like for like).
