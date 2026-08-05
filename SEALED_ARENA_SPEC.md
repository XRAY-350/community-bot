# Sealed Arena, Spec (v1)

**Status:** BUILT + deployed DARK (2026-08-05), pending owner test + flag flip (`sealedArena`).
First of three planned throne-competition modes
(this one first, by owner priority). The other two are sketched at the bottom.

## Concept
The same intense, live arena competition, but each tribe races **behind closed doors**
in its own throne, **blind** to the others, with a dramatic **public reveal** after.
Owner's own framing (2026-08-05): "still the intense competition of the regular arena,
but instead of competing in front of each tribe, each tribe competes behind closed doors."

Different from the other two modes on purpose:
- **Regular Arena** (exists, unchanged): all tribes race together in ONE public channel.
- **Sealed Arena** (this): all tribes race the SAME live event at the SAME time, each in
  its OWN throne, results hidden until the reveal.
- **The Trials** (later): tribe solves as a team, collaborative.
- **Proving Grounds** (later): async, individual, answer whenever.

## Locked decisions (owner-confirmed 2026-08-05)
- **Name:** Sealed Arena.
- **Live + simultaneous**, not async. The intensity is the point.
- **Blind:** no throne can see another during play.
- **Games:** draws from the **same shared pool as the regular arena** (which it already does),
  using the **13 timing-precise types** (button + typed). This IS the sealed arena's final game
  set, no new games for this mode (owner 2026-08-05); new games belong to the other two modes.
  Reaction Race, Reaction Rush, and
  Activity Blitz are EXCLUDED (reactions lack a precise server tap-time; Blitz is a
  server-wide async message count, not a per-throne race). Pool:
  - Button (7): Trivia, True or False, Number Pattern, Geography/Science/History/Animal Quiz.
  - Typed (6): Word Scramble, Math Sprint, Fast Fingers, Riddle Rush, Emoji Decode, Reverse Word.
- **Scoring:** per-throne RELATIVE timing (fair regardless of send skew), see below.
- **Cadence:** 1 to 3 times a day at peak, with its OWN daily cap, separate from the
  regular arena so the two never collide.
- **Reveal:** staged Herald reveal in the public spectacle channel, bottom to top,
  after every throne finishes. Recorded to the Lore Log -> weekly Chronicle.
- **Rewards:** winner banks Glory + Treasury (a premium over the normal arena, since it
  is rarer/bigger); everyone who answered earns participation (Tides + daily-play tick);
  feeds tribeQuests + achievements + the Chronicle.

## The loop
1. **Scheduler** picks a start moment inside a peak window (own cap, tracked separately
   from the regular arena). Plus a staff manual launch (`/tribe-admin sealed-arena`).
2. **Heads-up:** a short "Sealed Arena starting soon, gather in your throne" ping is
   posted to every tribe throne so members can rally.
3. **Coordinated start:** at T, the same challenge (one game type, one seed so all tribes
   get identical questions) drops in EVERY throne via a single `Promise.all` fan-out.
   Each throne's prompt message timestamp is captured at send.
4. **Blind play:** each throne runs the standard live arena round flow internally
   (button flow / typed flow, first member of THAT tribe to answer scores, tight timer,
   a live scoreboard for that throne only). No cross-throne visibility.
5. **Silent recording:** per tribe, the bot records correct count + each answer's relative
   time (see scoring). Nothing is announced publicly yet.
6. **Finish:** when every throne has completed its questions (or a max window elapses),
   the bot ranks the tribes.
7. **Reveal:** a Herald-voiced staged reveal in the spectacle channel, bottom to top,
   building to the winner, showing each tribe's score (+ a Battle-MVP shout). Rewards
   paid. Recorded to Lore.

## Scoring
- **Per-throne relative timing** is the whole trick to fairness: for each throne, capture
  its prompt's `createdTimestamp`, and score each answer as
  `answer.createdTimestamp - thatThronePrompt.createdTimestamp`. Because both are Discord
  SERVER-side timestamps and each tribe is measured from its OWN prompt, the ~100-300ms
  skew between the 5 near-simultaneous sends cancels out completely. Comparable to the ms.
  - Typed answers: message `createdTimestamp`. Button answers: interaction `createdTimestamp`.
  - This is why reaction games are excluded: no precise server tap-time.
- **Race the clock, NOT the headcount (size-fairness, critical).** Naive "fastest tribe wins"
  lets a 40-person tribe roll 40 dice per question vs a 6-person tribe's 6, so big tribes would
  win the raw race every time and the reveal (the emotional product) would decay. Instead each
  tribe scores per question against a FIXED speed curve, not against each other's fastest: a
  correct answer under ~2s (relative time) = full speed points, decaying to zero by the timeout,
  plus a flat correctness point. A small sharp tribe maxes the same question a big one does; size
  becomes insurance (more chances someone is fast/knows it), not a linear multiplier. A small
  tribe can genuinely top the reveal.
- **Rank:** by total score (correctness points + clock-speed points), summed across questions.
- **Underdog multiplier** (existing) applies to the PAYOUT on top, softening the residual
  knowledge-coverage edge a big roster still has.
- **Battle-MVP:** the single fastest/most-correct individual across all thrones gets a
  shout + a Tides bonus in the reveal (mirrors the war-spectacle MVP).

## Architecture notes (the real new plumbing)
- Today `arena.js` holds ONE active game (`state.active`). The sealed arena needs **N
  concurrent per-throne games at once.** Plan: a separate sealed-arena state holding a map
  `channelId/tribeKey -> gameState`, running independently of the regular arena's single-
  active model (so the two can even coexist if ever needed).
- **Answer routing:** the `messageCreate` (typed) and interaction (button) handlers must
  look up which sealed game owns the answer's channel and score it there. Today they key
  off the single active arena's `channelId`; extend to a per-channel lookup.
- **Timers:** N thrones each advancing rounds. One tick loop or a per-throne timer set.
  Restart-safety like the regular arena's `reconcileArena`: on boot, resolve/finalize an
  in-flight sealed arena (it is short, so resolve-on-restart is acceptable).
- **Coordinated start:** one scheduler fires, sends to all thrones via `Promise.all`,
  stamps each throne's prompt time.
- **Reveal:** reuse the war-spectacle / coronation staging (`warSleep` delays) for the
  bottom-to-top reveal.
- **Shared announcement queue (cross-mode):** big Herald moments (this reveal, coronation, Age
  champion, Chronicle, Prover of the Week, Trial results) must SERIALIZE in a fixed priority
  order with spacing, or reset day becomes a wall of stacked embeds. Build a small spectacle
  scheduler/queue shared by all modes rather than each firing independently.
- **Feature flag:** new `sealedArena` flag, fail-off, seeded dark until built + tuned,
  then flipped live (same pattern as quests/relics/prestige).
- **Reused wholesale:** arena.js question banks + the cross-game recency de-dup, the typed
  + button round flows, the throne-send pattern, the spectacle engine, lore/quests hooks.

## Build order (when we build it)
1. Sealed-game state module (N concurrent per-throne games + per-channel routing).
2. Coordinated simultaneous start + per-throne prompt-timestamp capture.
3. Per-throne internal round flow (reuse the arena's button + typed flows).
4. Answer routing + per-throne relative timing recording.
5. Finish detection + cross-tribe ranking (correct, tie-break speed).
6. Herald reveal (reuse spectacle engine) + rewards + lore + quests.
7. Scheduler (peak cadence, own daily cap) + staff manual launch.
8. `sealedArena` feature flag, tuning, go-live.

## New games are NOT for this mode
Decided (owner 2026-08-05): the sealed arena shares the regular arena's EXISTING game pool,
so it needs no new games of its own. The "entirely new sets of games" effort belongs to the
OTHER two modes (The Trials, Proving Grounds), which each get their OWN pool, designed when
we build them. (Any game the sealed arena ever uses still has to be timing-precise, typed or
button, but that is not a v1 concern since it just reuses the shared pool.)

## Deferred (v2+)
- Sealed wager: a leader stakes Treasury on placing top-N (bank it or lose it).
- Blind head-to-head: only two rival tribes, ties into the war/rivalry layer.
- Quorum: a tribe only qualifies with at least K participants.

## The other two modes (later, sketched)
Both get their OWN expanded game pool (the "new games" effort), designed when we build them.
- **The Trials:** same sealed simultaneous format, but scored on breadth (how many distinct
  members contributed), collaborative, "the tribe comes together." Rewards turnout.
- **Proving Grounds:** async, longer window (hours), individual contributions anytime.
  Fits different timezones; lower intensity, higher accessibility.
