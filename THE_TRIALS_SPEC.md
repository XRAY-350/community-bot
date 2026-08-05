# The Trials, Spec (v1)

**Status:** spec only, not built. Second of three throne-competition modes. Gets its own
net-new game pool (like Proving Grounds), and is framed as an evolution of the Muster.

## Concept
Collective effort. Where the sealed arena is individual speed and Proving Grounds is solo
mastery, The Trials is the whole tribe pulling together: the tribe rallies in its VOICE channel
plus its throne, collaborates on a challenge, and the reward is for how many of you show up and
contribute, not for one carry. A grand, live Muster.

## Locked decisions (owner 2026-08-05)
- **Competitive:** tribes are ranked against each other in a staged reveal, not a shared
  cooperative threshold.
- **Two per day, one of each trigger:**
  - **Scheduled Trial (simultaneous):** the bot fires one a day, all tribes at once, blind, with
    a staged competitive reveal after (reuses the sealed-arena plumbing).
  - **Muster Trial (leader-rallied):** a leader can call one a day for their tribe on their own
    schedule. Its score posts to a daily board so tribes still compete, just asynchronously.
- **Evolution of the Muster:** the leader-rallied Trial IS the grand version of the Muster
  (rally the tribe, act together). Lore and naming tie to the Muster.
- **Collaborative + breadth-scored:** not first-to-buzz. Any member answers any task; the tribe
  accumulates points from everyone's correct answers, multiplied by how many DISTINCT members
  contributed. Broad turnout beats one soloist.
- **No participant minimum:** no quorum floor (owner). Breadth is a multiplier, never a gate.
- **Voice is a BONUS, not a gate:**
  - Members in the tribe VC during a Trial add to the collaboration multiplier (a voice bonus),
    capped and underdog-curved so a big tribe does not auto-win.
  - Members NOT in the VC still earn points for their tribe. Nobody is locked out.
  - The rally ping points members to the tribe VC and can show a live count of who is in.
- **Games (net-new, its own pool):** The Assembly, The Relay, The Mosaic. All three are in. A
  game MODE may repeat, but QUESTIONS must not (owner): reuse the cross-game recency de-dup so a
  repeated mode always draws fresh questions.

## The two triggers
### Scheduled Trial (the showdown)
1. The bot fires one a day. A rally ping hits every throne: "gather in your tribe VC, a Trial
   begins soon," with a live VC head-count.
2. At T, the same trial drops in every throne simultaneously (blind, like the sealed arena).
3. The tribe collaborates over the window (15 to 20 minutes): any member answers any task; the
   tribe accumulates a collective score.
4. Sealed until it closes, then a staged Herald reveal ranks the tribes bottom to top.

### Muster Trial (the rally)
1. A leader calls one (once a day per tribe) whenever they choose, evolving the current Muster.
2. Same collaborative window in the tribe's own throne plus VC.
3. The tribe's score posts to a running DAILY board, so tribes compete asynchronously across
   their leader-run Trials. A day's-end wrap names the best.

## Scoring
- **Base:** the tribe's total correct answers across the window.
- **Breadth multiplier:** scales with the number of DISTINCT members who landed at least one
  correct answer. This is the core mechanic; broad turnout is the win condition.
- **Voice bonus:** members present in the tribe VC during the Trial add an extra bump to the
  multiplier, capped and underdog-curved. Non-VC contributors still score normally.
- **No quorum:** any turnout counts, more is just better.
- The existing underdog multiplier applies, so a small active tribe can beat a big lazy one.

## The game pool (net-new, collaborative)
- **The Assembly:** a big question set. The tribe collectively answers as many as it can in the
  window; score scales with distinct contributors. Reuses the trivia/quiz banks, but the FORMAT
  is collaborative accumulation, not first-to-buzz.
- **The Relay:** a chain where each correct answer must come from a DIFFERENT member than the
  last, forcing rotation around the roster (rewards a broad, awake tribe).
- **The Mosaic:** a puzzle split into pieces; different members solve different pieces; the tribe
  assembles the whole. Shines with voice coordination.
- **Question freshness:** modes may repeat freely, but questions cannot (owner). Reuse the
  cross-game recency store so a repeated mode always draws fresh questions.

## Rewards
- **Tribe (the focus):** Treasury plus Glory scaled by the collaborative score. This is a team
  mode, so the tribe is the main beneficiary.
- **Members:** participation points, with a bit more for VC presence and for being a distinct
  contributor. Feeds quests, achievements, and the Chronicle.
- The scheduled showdown winner banks a premium; the daily Muster-Trial board pays the day's best.

## Architecture notes
- Reuses the sealed-arena per-throne plumbing for the scheduled simultaneous Trial (N concurrent
  per-throne games, blind, staged reveal).
- Voice presence is read from the tribe VC's connected-member list (tribe.vcId), sampled across
  the window so late joiners and early leavers are handled fairly.
- Collaborative scoring: track distinct contributors and their correct counts per throne, not
  first-to-buzz. New scoring path (breadth multiplier plus voice bonus).
- Likely an extension of the sealed-arena module plus new game generators (Assembly bank driver,
  Relay rotation rule, Mosaic piece-splitter).
- Reuses the recency de-dup for question freshness, the Herald voice, the Muster hooks, and the
  spectacle/Chronicle reporting.
- Feature flag: `theTrials`, fail-off, seeded dark until built and tuned, then flipped live.

## Build order (when we build it)
1. Collaborative scoring engine (distinct contributors, breadth multiplier, voice bonus).
2. The Assembly (reuse banks, collaborative accumulation) as the first game.
3. Scheduled simultaneous Trial (reuse sealed plumbing) plus the staged reveal.
4. Muster Trial (leader-rallied) plus the daily board and day's-end wrap.
5. The Relay and The Mosaic games.
6. Rewards, quests, achievements, and Chronicle hooks.
7. `theTrials` feature flag, tuning, go-live.

## Open call (flag your preference)
The existing lightweight Muster (a quick roll-call that banks turnout Treasury/Glory): keep it as
the fast option alongside the grand Muster Trial, or retire it so the Trial becomes the only
Muster? My lean: keep both (the quick roll-call for a fast rally, the Trial for a real event).
