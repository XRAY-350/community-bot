# Tribe Phase 7 — Grandeur: Lore, Spectacle, Depth, Voice

Owner: make the tribe system feel **grand** (Madden-quicksim energy), a living history the server watches.
Three pillars from a design pass, adjusted by the owner:

## Locked decisions
- **No fourth currency.** Everything spends/chases the existing three meters (Tides / Treasury / Glory). Depth
  comes from goals + sinks, never a new spreadsheet.
- **No hard dependency on Haiku.** All flavor (war names, Age names, the Chronicle) is TEMPLATE-generated and
  deterministic. Haiku (the smart-watch infra) may only ever *enhance*, never be required.
- **Relics: permanent trophy, resettable perk.** The trophy (name/lore) is permanent (throne + Hall of Fame),
  but the *perk* is tiny, stacking, capped, and DECAYS across Ages, so a dynasty gets an edge now but new
  tribes aren't perpetually behind.
- **Banner art is in.** Members make the art; the bot just displays a per-tribe uploaded banner.
- Carry-forward principles: registry-driven fail-off features, mentions in message CONTENT, no em dashes in new
  copy, everything persists except the competition.

## Build order
### Phase 1 — Backbone + fast wins (the soul)
- **Lore Log** (`lore.js`): an append-only event log everything records into (foundings, crowns, Ages, wars,
  arena wins, musters, relics). The Hall of Fame + Chronicle read from it.
- **Ages**: each 6-week Season becomes a named **Age** ("The Age of Embers"), generated from a template bank.
  Hall of Fame reads like a history book.
- **Banner art**: a member-uploaded banner image per tribe, shown on the throne/hub/info embeds.

### Phase 2 — Spectacle
- **Named wars**: auto-generated war names + a written aftermath ("The War of the Broken Gate, won in six"),
  shown in the live war spectacle and recorded to the Lore Log.
- **Coronation ceremony**: the Sunday weekly crown becomes a staged sequence (herald, crown transfer, fallen
  rivals acknowledged, closing proclamation), reusing the war-spectacle engine.

### Phase 3 — Permanence
- **The Chronicle**: a weekly chapter auto-composed from the Lore Log (crowns, wars, MVPs, foundings, relics),
  posted to a public channel.

### Phase 4 — Deeper systems (goals + sinks)
- **Tribe quests**: weekly objectives ("win 3 arenas", "muster 10 strong") paying treasury/glory.
- **Relics**: minted at Age end; permanent trophy + tiny stacking/capped/decaying perk; raidable in wars.
- **Prestige**: for capped-out Elders, tied to the achievement titles already built.

### Phase 5 — The voice
- **Herald voice**: unify all tribe-facing copy under one narrator through copy.js.
- **UI polish**: consistent embed colours/iconography; throne + dashboard as "the citizen's ledger".

## Status
- [x] 1. Lore Log + Ages + Banners — lore.js event log (crowns/ages/arena/muster recorded); Seasons are now
  named Ages (generated names, history-book Hall of Fame, "Age Champion" role); /tribe banner sets a
  disk-stored member-made banner shown on /tribe info.
- [ ] 2. Named wars + Coronation
- [ ] 3. Chronicle
- [ ] 4. Quests + Relics + Prestige
- [ ] 5. Herald voice + polish
