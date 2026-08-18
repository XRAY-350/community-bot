---
## ⚠ PINNED — READ THIS FIRST, EVERY SESSION

**Deploy model:** this checkout (on box `mc25`) is source only. The bots run on `bots-vm`
(Tailscale `100.123.250.73`, GCP project `discord-bots-504720` — a DIFFERENT project from this
box). Deploy = `scp` the changed file(s) to `~/bots/community-bot/` on bots-vm, `node --check`
there, `sudo systemctl restart community-bot melanin-bot`, then grep the restart logs for
`registered` and no `error`/`fatal`. There is no git-on-box workflow for the bots themselves.

**One codebase, two deployments:** `community-bot` (systemd unit) = FUBU, `melanin-bot` = Melanin.
Same code, separate `.env`/state dirs (`/var/lib/fubu-bot` vs `/var/lib/melanin-bot`). Always
restart both, always check both restart logs — a change that's fine for FUBU can still break
Melanin if a feature/config differs (e.g. `smartWatch` is on for FUBU, off for Melanin).

**Cornering strips roles, not staff identity.** A cornered mod/admin's LIVE roles are stripped —
`opspanel.memberTier()` now falls back to the pre-corner role snapshot when someone is currently
cornered, so their real tier still holds. Don't "fix" this back to raw `member.roles.cache` checks.
Demoting a cornered target must go through `holdsRoleEffective`/`removeRoleEffective`/
`addRoleEffective` (index.js), not `member.roles.remove()` directly — that's a no-op on a role
they don't currently hold while jailed.

**Repo visibility:** this repo is PRIVATE on GitHub and stays that way unless explicitly told to
flip it public. A PII scrub was done in anticipation of going public, but the visibility flip
itself was explicitly declined ("don't flip yet") and has not happened since.

**No em dashes in member-facing text** (announcements, panels, embeds). Code comments/commits are
fine — this rule is about copy real members read.

---

## 2026-08-18 18:43 — Age-gated channels actually require Verified now (took 3 iterations)

Reported: unverified members could see Melanin's Adults area just by holding an age-bracket role
(age roles were self-selectable pre-verification, e.g. via Discord onboarding, with no check that
holding one requires being Verified). Landed on a role-based fix after two false starts:

1. **First attempt**: strip the age role from anyone unverified who held one. WRONG — owner corrected
   it: "People should be allowed to hold age roles when they join, we just have to make sure they
   can't access the channels because of their unverified status." This had already stripped roles
   from ~6 FUBU + 117 Melanin members before being caught; all restored afterward (117/118 restored
   automatically, 1 Melanin user not found by username, likely left/renamed).
2. **Second attempt**: a member-level `ViewChannel: false` overwrite per age-gated channel for anyone
   unverified-but-age-bracketed (mirrors `enforceMdniStaffLock`'s pattern). Owner caught the real
   problem before it shipped: Discord caps overwrites per channel, and with 100+ members already in
   this exact state on Melanin alone, this design scales with (members × channels) and would blow
   through that cap as the community grows.
3. **Final design**: a new auto-managed **Adult Verified** role (Verified + adult age bracket, both —
   same "Discord can't express role-AND" workaround as the old MDNI-Verified role, just checking
   different prerequisites) gates the whole Adults area on both servers. FUBU's `general-nsfw`/
   `nsfw-vc` also got a fresh **MDNI Verified** role (Adult Verified + MDNI opt-in) — a NEW role
   instance, not the one retired earlier today, since the old one's logic (MDNI alone implies adult)
   no longer holds once age roles don't imply Verified. `enforceAdultVerified`/`sweepAdultVerified`
   and `enforceMdniVerified2`/`sweepMdniVerified2` (index.js) manage them, real-time + boot/hourly.

**Real deploy gotcha hit twice**: both role-to-channel permission swaps (FUBU's, then Melanin's) got
silently reverted by `permguard`'s 20-minute drift sweep because the swap script didn't call
`permguard.blessChannel()` afterward — same class of mistake as earlier today's MDNI-Verified
retirement. Caught via direct spot-checks (`haniii101` on FUBU, `dada068639` on Melanin) rather than
trusting the initial "looks done" state. Both are now blessed and confirmed holding via a fresh
force-fetch. **Lesson reinforced**: any live permission-overwrite edit in this repo needs an
immediate `permguard.blessChannel()` call, or the very next 20-minute sweep undoes it.

Backfilled `Adult Verified`/`MDNI Verified` for every currently-qualifying member on both guilds
(85 FUBU, 0 Melanin needed it after the permguard-revert fix — everyone else already had it from
real-time enforcement or the first backfill pass).

## 2026-08-18 16:51 — Simplified MDNI: general gates on age brackets, retired MDNI Verified role

Prompted by comparing the new age-bracket-gated Adults area against the older MDNI setup. Changes:

- **`general` (the base MDNI channel) now gates on `adultAgeRoleIds` directly**, not the MDNI opt-in
  role — matches the new Adults area's pattern. MDNI role's overwrite removed from that channel.
- **`general-nsfw`/`nsfw-vc` still require the MDNI opt-in** (owner: "keep the gating but only on
  general-nsfw/nsfw-vc") — but now gate on the plain `mdniRoleId` directly instead of the derived
  "MDNI Verified" role. **Retired `enforceMdniVerified`/`sweepMdniVerified`** (index.js) and their
  boot/hourly/real-time call sites — the combined role only ever existed because Discord can't
  express "requires role A AND role B" natively; gating on plain MDNI alone is exactly as strong,
  since `enforceMdni` already continuously strips MDNI from anyone without a confirmed adult age
  role. `config.mdniVerifiedRoleId` removed. The now-fully-unused `🔞 𝗠𝗗𝗡𝗜 𝗩𝗘𝗥𝗜𝗙𝗜𝗘𝗗` Discord role
  itself was deleted shortly after (had 0 members at deletion, confirming nothing still needed it).
- **Registration lock relaxed for MDNI**: `enforceRegistrationLock` no longer reverts a self-toggle
  of the MDNI role for anyone who currently holds an adult age bracket role (owner: "remove the
  registration lock for mdni for people who hold an 18+ role") — MDNI is now a free-standing
  preference for confirmed adults, not a one-time choice locked at verification. The age-bracket
  lock itself is unchanged; only the MDNI half was relaxed, and only for adults (impossible for a
  non-adult to hold it anyway, since `enforceMdni` strips it).
- Melanin needed no changes — its own env already notes "Adults space is age-gated, not an MDNI
  space" and has no MDNI-verified/NSFW/VC config at all.
- Deployed to both bots, restarted clean. Live permission overwrites updated on FUBU via one-off
  script (created + deleted per usual pattern); verified via a fresh force-fetch read after an
  initial verify attempt gave a false negative from stale cache (a `channels.fetch(id)` without
  `{force:true}` can return pre-edit cached state even in a brand-new client connection).

## 2026-08-18 16:25 — Ported Melanin's Adults area to FUBU (live server change, no code)

New `🔞 ᴀᴅᴜʟᴛs` category on FUBU, modeled on Melanin's 9-channel Adults area, built and confirmed
hidden first (owner: "keep it hidden until it's done") before revealing. Final structure:

- **general / general-nsfw / nsfw-vc** = FUBU's PRE-EXISTING MDNI / MDNI-NSFW / MDNI-VC channels
  (same channel IDs — `config.mdniChannelId`/`mdniNsfwChannelId`/`mdniVerifiedVcId` need no changes),
  reparented into the new category and renamed. Their existing permission overwrites were left
  untouched throughout — no visibility change for anyone who could already see them.
- **rules, photos, venting, debates, adult voice, gaming (text), gaming voice** = new channels.
  Rules content ported from Melanin's `🔞┆RULES` channel (posted + pinned, em dash swapped for a
  comma). Gaming was briefly 2 text channels per Melanin's split, corrected to 1 text + 1 voice per
  the owner's actual intent ("we only need one gaming chat and 1 gaming vc").
- Permissions: the 7 new channels use FUBU's existing age-bracket roles (18-21/21-25/25-30+ can
  view, 16-17 and Cornered blocked, same as MDNI) — NOT the `nsfw`/age-restricted platform flag,
  which the owner deliberately restricted to only `general-nsfw` and `nsfw-vc` ("that way if people
  don't want to verify with discord they don't have to").
- No `config.js`/bot code changes at all — this was pure live Discord structure + one content post,
  done via one-off scratchpad scripts (created, used, deleted per the usual pattern).

## 2026-08-18 15:52 — Watchlist: narrower strict watch for mods, both deployments configured

`opspanel`-tier watched members now get keyword-only strict scanning (no AI behavioral read) and
are skipped entirely inside the mod category (`config.modCategoryId`, `MOD_CATEGORY_ID` env override).
FUBU's "Mod Activities" category (`1516233713250471976`) was already the config default. Melanin's
equivalent, "STAFF CHATS" (`1534385817999376434`), is now set via `MOD_CATEGORY_ID` in
`/home/Administrator/.melanin_env` on bots-vm (env-only, not in git) — found by listing Melanin's
categories for the hidden-from-@everyone one, per the owner's note that almost every FUBU channel
has a Melanin equivalent. `melanin-bot` restarted to pick it up.

## 2026-08-18 15:29 — Corner joke-flag system, tier-persists-through-corner fix, dead-command sweep, live watchlist AI, tribe announcement posted

Big session, several independent fixes/features. All deployed to both `community-bot` and
`melanin-bot` on bots-vm and pushed to `origin/main`.

**Watchlist "Smart-Watch Lab" taken live for strict-watched members** (`watchlistAlert`, the
`messageCreate` handler): previously the AI judge's full-behavioral read (every message from a
strictly-watched member, not just keyword hits) only posted to the private admin lab channel. Now
a genuine AI surface with no keyword hit posts a REAL alert through the same routing a keyword hit
uses (mod-announcements, or the admin-only channel if the watched member is staff). Added an
"➕ Add term" button on these no-keyword alerts so staff can recommend the missed word straight to
the strict/loose list. The private Lab sandbox itself is untouched.

**Corner "joke" flag** — new mechanic, several iterations to land right:
- Every staff-performed corner (mod+/trial) now carries a `joke` flag on its state record.
  Staff-on-staff corners default to `joke: true` (waives `/uncorner`'s tier/override gate for that
  one corner instance); staff-on-a-regular-member defaults to `joke: false`. Computed in
  `corner.corner()` from the actor's tier + the target's role snapshot at strip time.
- A one-button ephemeral follow-up ("It was a joke" / "No, it's real") lets the actor flip the
  default right after the corner lands. Shared via a `jokeCheckIn()` helper wired into EVERY
  single-target corner entry point: `/corner`, "Send to corner" (right-click + the watchlist
  `wl_corner` button, same modal), `corner_recorner`, and — narrower — nothing on strike-attached
  corners (see below). Bulk corners (`/corner also`/`sweep`, Send-to-corner's `also`/`sweep`) get a
  plain-text "treated as joke" note per target instead, since a button-per-target doesn't scale.
- **Real bug found and fixed along the way:** Discord only honors a follow-up's ephemeral flag if
  the interaction's INITIAL response was also ephemeral. `/corner`'s initial reply was public
  whenever it wasn't run in the corner channel, so the joke prompt was visible/clickable to
  everyone. Fixed by always deferring ephemeral now; the previously-public ack is sent as its own
  plain channel message instead when not run in the corner channel.
- **Strike-attached corners are always real, never a joke** (`corner.corner()`'s new `forceReal`
  option) — a corner tied to a strike is inherently serious regardless of staff-on-staff, so those
  two paths (strike modal's corner field, `/strike`'s `corner:` option) skip the default and the
  prompt entirely.
- Also narrowed `PERSONAL_CORNER_OVERRIDES`'s wildcard entry (owner's "anyone can corner me"
  opt-in) from any staff tier to admin+/owner only.

**Staff tier now persists through a corner, unless demoted through the bot**
(`opspanel.memberTier`): previously read live roles only, so a cornered mod/admin looked tier-less
to every check built on `memberTier` (re-corner tier gate, `/strike`'s tier check,
`canBypassCornerTier` callers, the joke default itself). Now falls back to the pre-corner role
snapshot corner.js stores while someone is currently cornered — real tier holds the whole time
they're jailed. This ALSO fixed `/demote-mod`/`/demote-admin`/`/demote-trial`, which checked and
edited only live roles: demoting a currently-cornered target was previously a silent no-op (they
don't hold the role right now, so `.remove()` did nothing, and the command wrongly said "isn't a
Mod"). New `holdsRoleEffective`/`removeRoleEffective`/`addRoleEffective` helpers (index.js) check
and edit the corner snapshot directly for a cornered target.

**`/mediafilter list` silently failing** — 19 blocked GIF links pushed the plain-content reply past
Discord's 2000-char cap, so the reply never sent at all (confirmed live: `DiscordAPIError[50035]`
in the logs at the exact moment the command ran). Switched to an embed (4096-char budget) with
defensive truncation.

**Dead `*-setup` command references swept (11 places)** — the 10 old `*-setup` slash commands
(report/modmail/confess/request-role/suggest/whistleblow/appeal/appeal-strike/apply-mod/
event-organizer-setup) were consolidated into `/panel` → 🧩 Setup a while back, but every "not set
up yet" error message across the bot still told admins to run the dead command name. Found via a
real report ("`/event-organizer-setup` doesn't exist") and swept the whole class rather than just
that one instance — `copy.js`, `appeals.js`, `strikeAppeals.js`, `eventorgapps.js`, `index.js`.

**Tribe features announcement posted** — Tribe Games + Tribe Lore (Evolution Paths) + Propaganda
had all shipped in a prior session (commit `544a8ea` "tribe games + tribe lore evolution paths +
propaganda" and follow-ups) but were never announced to the community. Recovered a lost draft from
an Aug 12 scratchpad file (already cleaned up) via the session transcript, corrected two tribes'
stale/placeholder path names against live server data (Biomedical biohazard, Woeful Vagabonds),
added the missing Propaganda section, trimmed it down (owner: too long, members won't read it),
scrubbed em dashes, and posted the final version to `#📣┆tribe-announcements` on FUBU
(`https://discord.com/channels/1500215548938817626/1534268207127335165/1539294993993179217`).
**Melanin was NOT announced** — its tribes have no lore paths set yet, so the copy wouldn't be
accurate there. Open item — see below.

**Files touched this session:** `index.js`, `corner.js`, `opspanel.js`, `copy.js`, `appeals.js`,
`strikeAppeals.js`, `eventorgapps.js`. Commits `c5f61b8` through `b6d61ea` on `main`, all pushed.
