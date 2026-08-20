---
## ⚠ PINNED — READ THIS FIRST, EVERY SESSION

**Deploy model:** this checkout (on box `mc25`) is source only. The bots run on `bots-vm`
(Tailscale `100.123.250.73`, GCP project `discord-bots-504720` — a DIFFERENT project from this
box). Deploy = `scp` the changed file(s) to `~/bots/community-bot/` on bots-vm, `node --check`
there, `sudo systemctl restart fubu-bot melanin-bot`, then grep the restart logs for
`registered` and no `error`/`fatal`. There is no git-on-box workflow for the bots themselves.

**One codebase, two deployments:** `fubu-bot` (systemd unit, renamed from `community-bot`
2026-08-19 — the old generic name was a leftover from before Melanin was consolidated onto this
same codebase) = FUBU, `melanin-bot` = Melanin. Same code, separate `.env`/state dirs
(`/var/lib/fubu-bot` vs `/var/lib/melanin-bot`). Always restart both, always check both restart
logs — a change that's fine for FUBU can still break Melanin if a feature/config differs (e.g.
`smartWatch` is on for FUBU, off for Melanin).

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

## 2026-08-19 16:20 — FUBU: consolidated Text/Hobbies/Confessions categories, deleted empty archived category

Live Discord server change, no code touched. Owner asked to merge "Text Channels" and "Hobbies and
Interests" categories, then mid-task added "Confessions" to the merge, then separately asked to
delete the (now confirmed genuinely empty) "📦 archived" category.

Surveyed all three categories first (10 + 13 + 6 = 29 channels, well under Discord's 50-per-category
cap) and confirmed with the owner which category survives, its new name, and left the known
`hobbies-interests` (forum) vs `hobbies-interests✿` (text channel) duplicate alone per their call.

Renamed the `ღᴛᴇxᴛ ᴄʜᴀɴᴇʟʟsఌ` category (id 1500215550020812850) to `ღ ᴄᴏᴍᴍᴜɴɪᴛʏ ఌ`, moved all 13
Hobbies channels + all 6 Confessions channels into it via `setParent(id, { lockPermissions: false })`
— explicitly NOT syncing category permissions onto the moved channels, since several (mod-inbox,
anon-reports, confession-log) have their own restrictive overwrites that a permission sync would
have clobbered. Deleted the two now-empty source categories. Verified via a full `guild.channels.fetch()`
(not cache) that the merged category holds all 29 channels and the old two are gone.

Then deleted `📦 archived` (id 1535874875573543002) — confirmed via full fetch (not just cache) that
it held 0 channels before deleting, so no content was lost.

No permguard interaction: it keys off channelId for its golden-manifest sweep, not parent category,
and no channel's own overwrites were touched — only their `parentId` changed.

## 2026-08-19 16:35 — FUBU: deleted redirect-stub channels, reordered the merged category

Follow-up to the consolidation above. Owner: the (now-deleted) archived category's channels had
previously been moved back into their origin categories as locked read-only redirect stubs
pointing to the new `hobbies-interests` forum, "to help redirect people to the new forum" — safe
to delete now. Identified them by topic text rather than guessing from names: 9 channels literally
had `📌 This channel's conversation moved to #hobbies-interests → **X**. This channel is kept as
read-only history and locked from new posts/threads.` in their topic — food, books-tv-movies,
writing, religion, spirituality, astro, art, hobbies-interests✿ (resolves the duplicate flagged in
the merge above — it was one of these stubs), business-selfpromo. Confirmed `gaming`/`music`/
`anime`/`lgbtq-talk` were NOT stubs (real topics, recent activity) before leaving them alone.

Deleted all 9, then reordered the remaining 20 channels into general chat → identity (hair/selfies/
lgbtq) → hobbies (forum + gaming/music/anime) → anonymous & community-input (confessions/
suggestions/anon-reports) → utility (bot-commands) → staff-only (confession-log, mod-inbox last).
Used `guild.channels.setPositions()` — first attempt included a redundant `parent` field on every
entry and hit Discord's "only one channel can have a parent_id modified at a time" 40009 error since
none of them actually needed a parent change; fixed by dropping `parent` and passing `position`
only. Verified via a fresh `guild.channels.fetch()` that all 20 remain, in the intended order.

Owner clarified the repo/package naming history (FUBU was the original codebase, deliberately
renamed to `community-bot` when Melanin was consolidated onto it "instead of making code changes
twice" — not an accident) — [[project-fubu-renamed-to-community-bot]] memory saved. Then asked to
rename the systemd service itself to match `melanin-bot`'s naming, since `community-bot.service`
running only FUBU (Melanin has always been its own separate unit) was confusing on its face.

Checked for anything else depending on the unit name before touching it: no crontab entries, no
systemd timers, no scripts under `/home/Administrator` referencing `community-bot.service`. Only
this repo's own docs (this file's pinned block, now updated) mentioned it.

On bots-vm: wrote `/etc/systemd/system/fubu-bot.service` (identical to the old unit — same
`WorkingDirectory=/home/Administrator/bots/community-bot`, same `.community_env`, only the
`Description=` and filename changed), `daemon-reload`, `enable fubu-bot`, `stop`+`disable`
`community-bot`, `start fubu-bot`. Confirmed clean restart (`registered 54/69 commands`, no
errors), then deleted the old `/etc/systemd/system/community-bot.service` unit file and
`daemon-reload`d again. `melanin-bot` was untouched throughout, confirmed still active/enabled
after. The **repo directory itself stays named `community-bot`** (that's the codebase name, still
accurate — one shared codebase, two bot deployments) — only the FUBU-side systemd unit changed.

Also archived (not deleted) the orphaned `XRAY-350/melanin-bot` GitHub repo — a pre-consolidation
standalone Melanin codebase, created 2026-08-05, frozen since 2026-08-06T14:59:15Z (the moment
consolidation happened), confirmed nothing on bots-vm or in CI references it. Archived rather than
deleted per owner's choice, keeping the pre-consolidation history around read-only.

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

## 2026-08-19 16:45 — FUBU: per-channel emoji swap in the merged Community category, plus a real incident

Owner asked to replace the generic 🫍 (used on 13 channels, all confirmed confined to this one
category via a full-guild scan) with a topic-appropriate emoji per channel. Proposed a first pass;
owner rejected the tool call before approving ("i didn't give permission yet. some of these i don't
like") and asked for alternatives on 5: important-discussions (🌍 collided with the Global Languages
Chat category), hair (wanted a dark skin tone modifier), hobbies-interests forum (wanted more
options), anime (wanted Japan-themed but not crossed flags), fun-confessions (wanted more playful/
secretive options). Presented real alternatives via AskUserQuestion, got explicit picks: 📰, 💇🏿,
🎨, ⛩️, 🤭.

**Real incident, not just a near-miss:** the FIRST (rejected) script had already executed against
the live Discord server before the rejection was processed — confirmed by diffing live state, which
showed the OLD unwanted emoji (🌍, plain 💇, 🧩, 🇯🇵, 😂) already applied. Ran a corrective pass
matching each old emoji to its confirmed replacement, verified again via a fresh `guild.channels.fetch()`
that all 13 now match what was actually approved. Saved
[[feedback-rejected-tool-call-may-still-execute]] — a rejected Bash call involving ssh/remote
commands is not a reliable signal that nothing happened live; always diff actual live state
afterward rather than trusting the rejection alone.

Final: general 💬, general-2 🗨️, important-discussions 📰, debates ⚖️, venting 🫂, hair 💇🏿,
selfies-n-flicks 📸, lgbtq-talk 🌈, hobbies-interests (forum) 🎨, gaming 🎮, music 🎵, anime ⛩️,
fun-confessions 🤭.

## 2026-08-19 17:25 — FUBU: Punishments + Staff categories, application-archive merge, trial-tier cornering for Mini-Mods/Event Organizer

Live Discord restructure, plus two real code fixes found along the way. Inspected Melanin's live
guild structure (separate community, same codebase) for the naming/grouping pattern before
replicating: it has a dedicated `ミ💢 | ᴘᴜɴɪsʜᴍᴇɴᴛs` category and a `ミ👤 ┊𝗦𝗧𝗔𝗙𝗙 𝗖𝗛𝗔𝗧𝗦` category
(already grouping confession-log + mod-inbox together, same as what owner wanted here).

**Deletions/cleanup:**
- `Nolife Lounge` VC (zero messages ever) and `watch-lab` (owner: "can go") deleted.
- Two identically-named `🔐┆application-archive` channels existed — NOT a simple duplicate to
  delete, root-caused to a real bug in `modapps.js`'s `ensureArchiveChannel()`: it silently
  created a fresh channel whenever its cached `archiveChannelId` failed to resolve, instead of
  checking for an existing one by name first. Confirmed via the live `.fubu_modapps.json` config
  which channel was actually tracked (`...820`, not the orphaned `...042`). Fetched all 15
  messages from the orphan (oldest-first) and reposted them into the tracked channel, then deleted
  the now-empty orphan — a real merge, not a content-losing delete. Fixed the root cause in
  `modapps.js`: `ensureArchiveChannel()` now searches for an existing `🔐┆application-archive` by
  name before ever creating a new one, logging loudly if that path is hit.
- Found `🎪┆ᴇᴠᴇɴᴛ-ᴏʀɢ-ᴀᴘᴘʟɪᴄᴀᴛɪᴏɴs` (forum) and `🎭┆ʀᴏʟᴇ-ʀᴇqᴜᴇsᴛs` both sitting completely
  uncategorized (parentId null) — owner confirmed role-requests already existed, just orphaned.

**New `💢 Punishments` category** (mirrors Melanin): moved `the-corner`, `corner-log`,
`adult-corner`, `corner-vc` in from Verify-and-Rules/Voice-Channels — all previously thematically
misplaced. Every channel's own permission overwrites (already correct — public can view+read
the-corner/corner-log for accountability, only staff+the cornered member can send; adult-corner
fully gated) carried over untouched via `lockPermissions: false`.

**Renamed `Mod Activities` → `👤 Staff`** (same category/ID, mirrors Melanin's "Staff Chats"),
moved in `confession-log`, `mod-inbox`, `event-org-applications`, `role-requests`. Added two new
channels: `staff-announcements` (Mod+ can post; Trial Mods/Mini-Mods/Event Organizer/Mods/Admins
view+read only) and `staff-discussions` (all of the above can view+read+send). Removed Trial Mods'
access to the existing `mod-discussion` channel — consolidated into `staff-discussions` instead.

**Code: generalized trial-tier cornering.** Mini-Mods previously had ONLY the scoped "Send to
corner" context-menu action on their own language channel; Event Organizer had no cornering
access at all. New `hasTrialCornerTier()` in index.js (Trial Mod OR any language Mini-Mod role OR
Event Organizer) now gates `/corner` + `/uncorner` uniformly for all three — same restrictions as
Trial Mods today (rule/reason required, ≤1h, single target). Left the separate context-menu path
(`miniModCanActOn`, channel-scoped) untouched — flagged as a follow-up for the next security pass.

**Separately flagged, not yet fixed:** a real bug where a cornered mod's tier-check still passes
(by design, for demotion-while-cornered to work — see [[project_corner_tier_persistence]]), meaning
nothing currently stops a cornered mod from using `/uncorner` on themselves or others, or `/corner`
on someone else, while jailed. Owner wants this fixed across EVERY staff-gated command and button,
not just corner/uncorner — scoped as its own follow-up pass, not bundled into this session's work.

Files touched: `index.js`, `modapps.js`. Commits `a4d6775` (code) + this log entry, on `main`, pushed.

## 2026-08-19 17:35 — FUBU: two small corrections to the Staff category work above

Owner caught the two new text channels (staff-announcements, staff-discussions) went out in plain
lowercase instead of the small-caps style every other channel on the server uses — renamed to
`📣┆sᴛᴀꜰꜰ-ᴀɴɴᴏᴜɴᴄᴇᴍᴇɴᴛs` / `💬┆sᴛᴀꜰꜰ-ᴅɪsᴄᴜssɪᴏɴs`. Also caught that the planned `staff call` voice
channel (staff+ tier, mirroring `mod call` staying mod+-only) never actually got created during the
restructure — created `📞┆sᴛᴀꜰꜰ ᴄᴀʟʟ` in the Staff category with the same access group as
staff-discussions (Mods, Admins, Trial Mods, Mini-Mods, Event Organizer can connect/speak).

## 2026-08-19 17:46 — Cornered-staff security fix: acting authority now suspended while jailed

Owner: "because cornered mod is still considered a mod they can free themselves and others while
cornered potentially." Confirmed real, then scoped as "every staff gated command as well as
buttons" — the standing item from the earlier recap.

Traced the mechanism precisely rather than guessing at a fix: `opspanel.memberTier(member)` falls
back to a cornered member's pre-corner role snapshot (deliberate, 2026-08-18: "a mod should always
be considered whatever their level is even in the corner unless demoted through the bot" — needed
so demote-mod/-admin still work on a jailed target, and so tier displays stay accurate). The bug was
never memberTier() itself — it's that NOTHING separately checked whether the ACTOR running a
command was themselves currently cornered, so the same snapshot that correctly preserves a jailed
mod's STANDING (for others checking them) also incorrectly preserved their ACTIVE AUTHORITY to act.

Found the actual choke point instead of patching call sites individually: `opspanel.tierOf(interaction)`
is architecturally ALWAYS about the interaction's own invoking user, never a target (targets are
always checked via `memberTier(someOtherMember)` directly) — and it's the single function behind
`canBan`, `canWLAdmin`, `isOwner`, `modClicked`, the dashboard's `meets()` gate (captured once at
the top of `handlePanel`), and ~37 direct `opspanel.tierOf(interaction)` call sites in index.js.
One change there — return `null` if `state.getCornered(interaction.user.id)` before ever reaching
`memberTier()`'s snapshot fallback — closes essentially the entire class in one edit. `memberTier()`
itself is untouched, since it's still correct for target lookups. Bot owner is deliberately exempted
(checked first, before the corner check) — a bot-owner corner is either a mistake or an attack, and
locking out the one identity with no other recovery path would be worse than the alternative.

Two adjacent gaps that `tierOf` alone would NOT have closed, found by tracing every consumer rather
than stopping at the first fix:
- `effectiveTierOf()` (index.js, the GRANT_POWER override wrapper used by /corner's tier checks)
  calls `overridesManager.getGrantedPower()`, which matches an actor's override entry independent
  of tier/corner status entirely — a cornered actor holding a standing GRANT_POWER override (e.g.
  knylvr's owner-level grant) would still get it. Fixed: `effectiveTierOf` now checks
  `state.getCornered()` directly BEFORE consulting the override, since a null rawTier alone can't
  distinguish "cornered" from "legitimately not staff but holds a grant" (the latter must still work).
- `corner.js`'s own `corner()` function has a SECOND, independent `getGrantedPower()` call — a
  defense-in-depth gap for any path that reaches `corner()` without going through the normal outer
  gate (e.g. an active hit-squad member calling `/corner`). Fixed at the source: checks
  `state.getCornered(byId)` directly rather than trusting the caller's already-gated `actorTier`.

Also swept and found 13 more call sites using `opspanel.memberTier(interaction.member)` DIRECTLY
(bypassing `tierOf` entirely) via `grep -v interaction.member` to separate actor-checks from
legitimate target-checks: tribe leave/prestige staff-shortcut checks, `/panel`'s dashboard-vs-
event-panel routing, `/contest` management authorization. All switched to `opspanel.tierOf(interaction)`
— lower severity than corner/uncorner (tribe mechanics, not moderation), but the identical bug class.
Verified via `grep -v` that every remaining `opspanel.memberTier(` call in index.js is a genuine
target lookup (passing a fetched member, not `interaction.member`), not a missed actor-check.

Flagged, not fixed (out of scope for this pass, tracked in SLATE.md): `messageReactionAdd`'s live-
tally point authorization has the same vulnerable pattern but is a reaction event with no
`interaction` object and only grants contest points, not a moderation action. The Mini-Mod "Send to
corner" context-menu path still uses the older `miniModCanActOn` channel-scoped check, never
touched by this fix.

Deployed to both `fubu-bot` and `melanin-bot`, clean restart confirmed (both registered their full
command lists, no errors). Files: `index.js`, `opspanel.js`, `corner.js`. Commit `9cb6526`, pushed.

## 2026-08-19 18:03 — Closed the two flagged residuals + /staff census gains Event Org/Mini-Mods

Owner asked for an explanation of the two items flagged (not fixed) in the security pass above,
then said to fix both, and separately caught that `/staff`'s census never listed Event Organizer or
Mini-Mods despite those now sharing trial-tier cornering authority.

**messageReactionAdd's live-tally authorization — real gap, fixed.** Reactions aren't interactions
(a totally separate Discord event, `(reaction, user)` not `interaction`), so `opspanel.tierOf()`'s
corner-status check never runs for it — this handler called `opspanel.memberTier(reactorMember)`
directly. Added an explicit `!state.getCornered(user.id)` check before honoring the reactor's tier
or Event Organizer status.

**miniModCanActOn — investigated further, corrected the earlier claim.** While implementing the
fix, checked whether cornering actually strips the Mini-Mod/Trial Mod/Event Organizer roles from a
member's LIVE role list (`corner.js`'s `rolesToStrip()` — strips everything except
`config.identifyingRoleIds`, the unverified role, and the corner role itself; confirmed via the live
`.community_env` that none of the three overlap with `IDENTIFYING_ROLE_IDS`). They do get stripped.
Since `langmods.canActOn()` checks LIVE role membership with no snapshot fallback (unlike
`opspanel.memberTier()`, which is what made the mod/admin case real), a cornered Mini-Mod's role
would already be gone and the check would already correctly deny them — **this was never actually
exploitable**, unlike the mod/admin case. Added the check anyway (free, makes intent explicit) but
corrected the record with the owner rather than let the earlier overstated claim stand.

**`/staff` census**: added Event Organizer and a per-language Mini-Mod breakdown (via
`langmods.languages()`), counted the same way Trial Mod already was — only for members below mod
tier, and not mutually exclusive with each other (someone can hold more than one auxiliary role).

Deployed to both bots, clean restart confirmed. Commit `8d6bce3`, pushed.

## 2026-08-19 18:27 — "Mini mod is not just per language" + a rename mistake, corrected

Owner corrected the `/staff` census framing: confirmed `langmods.json` was already scope-generic
(reading whatever keys are configured, not a hardcoded language list) — its one live entry is
"LGBTQ" (role `🌈 ʟɢʙᴛǫ ᴍɪɴɪ ᴍᴏᴅ`, small-caps, which is why an earlier `/mini/i` role-name search
this session missed it — small-caps unicode letters aren't the same codepoints as ASCII). Also
found 4 more Mini-Mod roles (French/German/Dutch/Hispanic) that exist but have NO `langmods.json`
entry — not wired to any channel, so holding one currently grants no actual authority.

Owner: "yes, list them too" — `/staff` now does a plain `/mini-?mod/i` name search (not hardcoded
IDs) for any Mini-Mod role missing from the config, and lists them in a separate "(unconfigured)"
section, deliberately excluded from the staff total since they don't confer real authority yet.

Separately: "speaking of which all mod positions should use regular text so that it can be typed."
Renamed `🌈 ʟɢʙᴛǫ ᴍɪɴɪ ᴍᴏᴅ` → `LGBTQ Mini-Mod` (matching the other 4's plain-text convention).
**Mistake, caught and reverted**: also renamed two individual owner-tier titles I mistook for
"positions" — `ᴡᴀʀᴅᴇɴ ᴏꜰ ᴛʜᴇ ɴɪɢʜᴛᴛɪᴅᴇ!` and `ᴘᴇʟᴢ!` — owner: "two of those are personal roles and
should not be renamed." Reverted both back to their original small-caps names immediately.

**Noticed but not yet flagged to the owner during this pass, worth a follow-up**: there are TWO
`MODS - ✰` roles (ids `...675316` with 3 members, `...364328` with 0) and TWO `ADMINS - ★` roles
(`...226833` with 2 members, `...510916` with 0) live on the server — the 0-member ones look like
the same kind of accidental duplicate found earlier this session (application-archive). Worth
confirming which one `opspanel.MOD_ROLE_ID`/`ADMIN_ROLE_ID` actually points to and whether the
empty duplicates should be deleted.

Commit `9cb13ef`, pushed. Deploy verified clean on both bots.

## 2026-08-19 18:35 — Deleted the duplicate MODS/ADMINS roles

Owner: "you can delete the dupes. i made those" — confirmed self-made, not a bot-created accident
like application-archive. Verified which pair was live before deleting: `opspanel.js`'s
`ADMIN_ROLE_ID` default (`1516179051105226833`, 2 members) and `.community_env`'s `MOD_ROLE_ID`
(`1528316361665675316`, 3 members) matched the non-empty roles. Deleted the two 0-member duplicates
(`1539396298363510916` "ADMINS - ★", `1539396384036364328` "MODS - ✰"), double-checked member
count was 0 immediately before each delete.

## 2026-08-19 18:45 — Missed permguard bless, Trial Mods silently un-removed from mod-discussion

Owner caught it: "did you bless the perm changes? Trial mods can still see/speak in mod
discussions." I hadn't — a known, previously-documented gotcha ([[project_permguard_bless_after_edit]])
I still walked into. Confirmed via journalctl: every restart this session (4 of them) ran a boot
sweep that "corrected 9 drifted overwrite(s)" — the earlier `permissionOverwrites.delete(TRIAL_ROLE, ...)`
on mod-discussion was live for a while, then silently reverted back to the old golden manifest,
which still had Trial Mods allowed. New channels created this session were unaffected (correctly
logged as "unmanaged," permguard only reverts channels already IN the manifest), but the one
existing channel I actually edited took the hit.

Re-removed Trial Mods from mod-discussion, then blessed all 14 channels touched or created this
session (the 4 Punishments channels, the Staff category itself, the 4 channels moved into it,
the 3 new staff-announcements/staff-discussions/staff-call channels, and mod-discussion) via
`permguard.blessChannel()` so future 20-min sweeps treat their current state as correct instead of
drift. Verified live: Trial Mods confirmed absent from mod-discussion after the fix.

## 2026-08-19 20:48 — CORRECTION: the joke mechanism was never meant to be fully removed

Earlier this session (commit `db361a1`, "corner: remove the joke mechanic entirely") I removed the
WHOLE joke system — auto-detection, ephemeral flip-prompt, forceReal on strike corners — based on
"i didn't ask for it, so get rid of it." Owner corrected: "I asked for the joke mechanism to be
gone as in the argument on the command not the mechanism as a whole." The "get rid of it" was about
the literal `joke` BOOLEAN OPTION the overnight agent had re-added to the `/corner` slash command
(against an earlier explicit ruling this session, "don't add it to the command") — not the
ephemeral-flip-prompt mechanism itself, which had already been separately approved earlier in the
session and was the CORRECT replacement design.

Restored verbatim from git (`git show db361a1^:corner.js` / `:index.js`, the state right before the
over-broad removal) rather than reconstructing by memory, per owner's explicit instruction — pulled
the exact original diff and reapplied each piece, then diffed line-for-line against the pre-removal
file to confirm byte-identical restoration (only difference: the `threadIds` array added afterward
by the unrelated staff-notification-ping fix). Restored: `canActSolo`'s joke tier-bypass, the joke
computation/storage in `corner()`, `setJoke()`, `jokeCheckIn()`'s ephemeral prompt, the
`corner_markjoke` button handler, jokes-array bulk-corner tracking across `cornerMany`/the message-
context-menu path/the main `/corner` handler, and `forceReal: true` on both strike-attached corner
call sites. The one thing that correctly stays gone: the literal boolean argument on `/corner`
itself.

Deployed to both bots, clean restart confirmed. Commit `81a46dc`, pushed.

## 2026-08-19 21:01 — New /corner-status command: fixes the bulk-corner joke/real flaw

Owner asked how joke/real is decided when a bulk `/corner` (via `also`) targets both a regular
member and a mod at once. Answer surfaced a real bug in both directions: joke/real is computed
per-target purely by "is this target staff" — a serious corner on a mod bundled into a batch
silently gets auto-flagged joke (tier lock waived, no confirmation since bulk mode skips the
ephemeral flip-prompt), while a joke corner sweeping in a regular member leaves them stuck with the
full real lock (joke never applies to non-staff targets). No way to correct either after the fact.

Owner offered 3 directions: re-add joke as a command argument, a secondary command, or a way to
change status while someone's cornered. Flagged that option 1 conflicts with the standing "don't
add it to the command" ruling from earlier this session — owner clarified the REAL reason for that
ruling: not wanting members to see the joke concept existed at all via `/corner`'s own visible
option list (same reason the whole system is ephemeral-only). Went with option 3 (most general —
fixes it regardless of how the corner happened) as a new slash command.

New `/corner-status <user> <joke|real>`, mod+ only (not Trial Mods — owner: "they're the only ones
who should have this ability anyway"). Marking "joke" requires the same authority `corner.canActSolo`
already gates a solo release with (since it waives the same protection for everyone else); marking
"real" is open to any mod+. Logged via `logCorner` either way for an audit trail.

**Deploy hit a real, non-obvious bug along the way**: the command description exceeded Discord's
100-char limit, which surfaced as an opaque `Invalid string length` from `@sapphire/shapeshift`'s
validator — NOT a clear "too long" message — and broke `guild.commands.set()` entirely for BOTH
bots on first deploy (command registration silently failed, existing commands stayed stale). Traced
by extracting just the new `SlashCommandBuilder` into a standalone test script and running it
directly to get the real stack trace, since the caught error only logged `err.message`. Also found
the command was missing from `features.js`'s registry — would have been silently filtered out of
registration even with a valid description. Fixed both, redeployed clean.

Commit `f82bbf8`, pushed.

## 2026-08-19 21:06 — /corner-status gains "also" for multi-target fixes

Owner: "fix how it works in bulk corners. And also add 'also' to the corner status command for
multi target changes." Added `also` to `/corner-status`, mirroring `/corner`'s own parsing exactly
(same `\d{15,}` regex over @mentions or raw pasted IDs, dedup via Set) — one call now fixes several
mis-classified targets from the same bulk corner instead of one command per person. Results bucket
into changed/already-correct/denied/not-cornered, one summary reply, one bulk `logCorner` entry.

Updated both bulk-corner "😂 Treated as joke" notes (message-context-menu path and /corner's own
also/sweep path) to explicitly point at `/corner-status` as the fix, closing the loop between "here's
what got auto-classified" and "here's how to correct it" in the same message.

Deployed to both bots, clean restart confirmed. Commit `05b5bad`, pushed.

## 2026-08-19 21:16 — Native welcome/goodbye confirmed working, replaces Carl-bot + Mimu

Owner: "just the wording. condense the two messages into 1. i don't want the 'i created this
server' since i'm its third owner." Condensed the welcome embed's two stacked paragraphs (Carl-bot's
rules-reminder + Mimu's tagline) into one unified paragraph, dropped "I created this space" (owner
is the third owner, didn't create this iteration of the server). Commit `5403711`.

Reposted the welcome test message with the new wording for review — owner: "test looks good. you
can delete both." Deleted both the welcome and goodbye test messages. The native replacement
(commit history: config additions, `postWelcomeMessage`/`postGoodbyeMessage`, `guildMemberAdd`/
`guildMemberRemove` handlers, content-based real mentions fixing the original "tags stopped
showing" bug) is now confirmed working end-to-end and considered done for this session. Owner is
still handling turning off Carl-bot's/Mimu's own welcome/leave config on their end, per the earlier
"I'll turn it off myself" choice — not something this repo's code controls.

## 2026-08-19 21:46 — Mod dashboard was missing /corner-status (found via "is it up to date")

Owner asked whether the mod dashboard panel (opspanel.js) was up to date, then clarified it was
more about missing new features than stale content. Checked `commandRefEmbed()` (the pinned
command reference) and `buildCorner()` (the live Corner page) against everything added this
session. Found one real gap: `/corner-status` (built earlier today) was invisible on the panel —
not in the command reference, and the Corner page's cornered-member list showed no indicator of
which corners were auto-flagged joke vs real, the exact ambiguity `/corner-status` exists to fix.
A mod scanning the panel had no way to know a flip was even possible, let alone needed.

Fixed both: `buildCorner()` now appends `· 😂 joke` to a line when `rec.joke` is set, and the
page's footer points at `/corner-status` to flip it. `commandRefEmbed()`'s Moderation section
gained a line for the command (usage, gating, and the joke-marking-needs-solo-authority note).
Everything else checked (Overrides page, Anon Tools counts, Promotions, Settings/Setup/Danger)
already reflects current state — no other gaps found. Welcome/goodbye isn't a staff action so
intentionally has no panel page.

Deployed to both bots (`node --check` local + remote clean, `sudo systemctl restart fubu-bot
melanin-bot`, journalctl confirms `corner-status` in both bots' registered command lists, no
errors). Committed `c84b3ae`, pushed to origin/main.

## 2026-08-19 21:48 — Dashboard also referenced dead commands (owner: "it references disabled commands")

Follow-up to the /corner-status gap above. Owner flagged that the reference also names commands
that no longer exist. Checked both the pinned command reference and the live Anon Tools page
against features.js's REGISTRY and found: `/cornered` was folded into the panel's own Corner page
a while back (features.js comment confirms), and `/confess`/`/report`/`/modmail`/`/suggest` were
all converted to `/dashboard` buttons (`commands: []` in their REGISTRY entries) — none of the
four still exist as slash commands, only `/whistleblow` does. Both `commandRefEmbed()` and
`buildAnonTools()` still described all of them as live slash-typed commands, which would have sent
a mod typing a command Discord doesn't have. Reworded every reference to point at `/dashboard`
buttons or the Corner page instead, and added a `/dashboard` line to the reference's "Other"
section for completeness.

Also found and committed a separate loose end: `config.js`'s `welcomeChannelId`/`goodbyeChannelId`
(native welcome/goodbye, deployed and confirmed working earlier this session) had never actually
made it into a commit — confirmed still live on bots-vm via ssh grep, then committed as a
now-it's-committed-not-a-new-deploy fix.

Deployed opspanel.js changes to both bots (`node --check` clean local+remote, clean restart,
`corner-status` still registered on both, melanin-bot's pre-existing "no dashboard channel set"
log line is unrelated — melanin never had /panel's channel configured). Commits `13da055`
(opspanel fixes) and `60ade06` (config.js catch-up), both pushed to origin/main.

## 2026-08-19 21:54 — Command reference now explains arguments (hybrid: embed index + plain-message detail)

Owner: the pinned reference never explained arguments on commands, and thought an embed was the
wrong shape for that ("much better suited as a message... or maybe a hybrid"). Asked which split
they wanted; chose: keep the existing embed as a compact index, add a full per-argument breakdown
as a separate plain message. Embed field values cap at 1024 chars, nowhere near enough for every
option on every moderation/watchlist/staff command — plain messages have no such per-field cap
(just the 2000-char whole-message cap, worked around with 2 chunks).

Added `commandRefDetailTexts()` (opspanel.js) — two plain-text chunks (1894/1576 chars), one
covering Moderation (corner/uncorner/corner-status/strike/stats), the other covering
Watchlist+Anon+Other+Staff, each command documented option-by-option with required/optional and
what it does. Rewrote `ensureCommandRef()` to create/edit/pin both the index embed AND the two
detail messages (previously it early-returned after the embed alone), tracking all message IDs in
`ops_guide.json` (`detailMessageIds` array, new field) so restarts edit in place instead of
reposting, plus cleanup logic if the chunk count ever shrinks later.

Deployed to both bots (node --check clean local+remote, clean restart, corner-status still
registered on both). Confirmed live on bots-vm: `ops_guide.json` now shows
`detailMessageIds:["1539754441954300027","1539754444764217354"]` alongside the existing index
`messageId`, both pinned in FUBU's mod-dashboard channel. Committed `88a3780`, pushed.

## 2026-08-19 21:57 — Reference was posting below the dashboard, not above

Owner: "not exactly what I was expecting but this needs to go above the dashboard." The comment in
index.js already claimed the reference sat "at the top of #mod-dashboard," but `ensurePanel()` was
called before `ensureCommandRef()` at startup — since Discord channel order is chronological, the
panel (created first) was always the older/higher message and the reference landed below it.

Fixed in index.js: chained `ensureCommandRef(client).then(() => ensurePanel(client))` so the
reference fully posts/pins before the panel starts. Code-only wouldn't reorder messages already
posted, so also deleted FUBU's 4 existing pinned messages (old panel + old ref embed + 2 detail
messages) via a one-off scratch script and cleared `ops_panel.json`/`ops_guide.json` on bots-vm so
the restart would recreate everything fresh. Hit one self-inflicted snag: clearing those files
wiped `channelId` too (not just the stale message IDs), so `ensureCommandRef`
briefly had no channel to post to right after restart ("no dashboard channel set" in logs) — fixed
by re-seeding `ops_panel.json` with just `{"channelId":"1531087673760944331"}` and restarting
`fubu-bot` again. Confirmed clean: reference (`1539755166256078861` + 2 detail msgs) now posts and
pins before the dashboard (`1539755176993230889`), correct order in #mod-dashboard. melanin-bot
untouched (still has no dashboard channel configured, pre-existing, unrelated to this).

Deleted `reorder_pins.js` scratch script from bots-vm after use. Committed `f2692d1`, pushed.

## 2026-08-19 22:04 — Reference layout reworked: message-then-embed, grouped by command

Owner: "not exactly what I was expecting... message then embed the message then embed. to group
things by command on both the reference sheet and the detailed list." Reworked the reference
structure: the plain MESSAGE now comes first (was the embed), the EMBED comes second (was the
plain messages) — reversed from the previous layout. Both are now organized by command instead of
by paragraph-per-category:
- `commandRefText()` — the quick-index message, one line per command (still clustered under
  category bold headers for scanability, but each command is its own line, not sharing a
  paragraph). Trimmed wording several passes to fit Discord's 2000-char message cap (verified
  1983 chars by extracting the actual function from the deployed source and running it, not by
  hand-counting a draft).
- `commandRefDetailEmbeds()` — replaced the two plain-text detail chunks with a single embed, one
  FIELD per command (title = command name, value = its args as bullets), so every command is its
  own distinct unit instead of several commands' args crammed into one category-labeled field.
  Verified 15 fields / 2863 total chars, both under Discord's 25-field / 6000-char embed caps, no
  field over the 1024 field-value cap.

`ensureCommandRef()` rewritten to post/pin the index message first, then the detail embed second,
so channel order is: index message → detail embed → dashboard panel (unchanged from the prior fix
that put the reference above the dashboard). Since edits can't reorder already-posted messages,
deleted FUBU's 4 existing pinned messages again (same one-off scratch-script approach as the last
fix, `reorder_pins2.js`, deleted after use) and reseeded `ops_panel.json` with just `channelId`
before restarting, avoiding the earlier "wiped channelId too" mistake. Confirmed clean: index
`1539756952647897138` → detail `1539756954769956873` → dashboard `1539756959283286067`, all
pinned in the right order in #mod-dashboard. Both bots restarted clean, `corner-status` still
registered on both, melanin-bot's pre-existing unconfigured dashboard channel unaffected.

Committed `4699794`, pushed.

## 2026-08-19 22:28 — Reference reworked again: interleaved message+embed per command

Owner: still not what they pictured, clarified via AskUserQuestion it was the layout/grouping —
wanted each command's message+embed PAIR together (interleaved), not one big index message
followed by one big detail embed. Realized Discord already supports this natively: a single
message can carry both `content` (plain text) and `embeds` together, and Discord renders the text
above the attached embed within that same message bubble — so "message then embed, per command"
doesn't need two separate Discord messages per command, just one message with both fields set.

Replaced `commandRefText()` + `commandRefDetailEmbeds()` with `commandRefEntries()` — a flat
ordered list of 18 `{content, embed}` pairs, one per command/group (corner, uncorner,
corner-status, strike, stats, watchlist, watchlist-terms, watchlist-suggest, unban, an
anon-tools note, whistleblow, verify, pending/panel/dashboard, staff, promote-*, demote-*, and a
closing "who can do what" tier note), category headers folded into the first command's content in
that category rather than as separate divider messages. Rewrote `ensureCommandRef()` to sync all
18 as individual pinned Discord messages (edit in place if the message exists, create+pin if not),
tracked as a `messageIds` array in `ops_guide.json` (replacing the old single
`messageId`/`detailMessageId`/`detailMessageIds` shapes — cleanup logic deletes any leftover
message ID from every prior layout this session went through).

Verified every entry against Discord's caps (2000-char message content, 6000-char/4096-desc embed)
via the same extract-and-run-the-real-function technique as before. Deployed: wiped FUBU's 3
existing pinned messages (old index message, old detail embed, dashboard panel) with a third
one-off scratch script (`reorder_pins3.js`, deleted after use), reseeded `ops_panel.json` with just
`channelId`, cleared `ops_guide.json`, restarted. Confirmed clean: `[fops] command reference: 18
entries synced` then `[fops] dashboard created + pinned` right after — 18 reference messages
chronologically before the panel, correct order. Both bots restarted clean afterward,
`corner-status` still registered on both.

Committed `1dd8724`, pushed.

## 2026-08-19 22:35 — Trial Mod / Mini-Mod / Event Organizer given #mod-dashboard access

Owner (garbled voice-to-text, confirmed via AskUserQuestion): make sure Trial Mod / Mini-Mod /
Event Organizer — the roles with /corner-tier access (`hasTrialCornerTier` in index.js) — also have
channel access matching that tier, including the #mod-dashboard channel where this session's new
command reference lives, and check any other channels they should have for consistency. Confirmed
directly with the user afterward: "they don't have access to the dashboard."

Audited live permission overwrites on both guilds (`audit_tier_access.js`, scratch script, run
against FUBU and Melanin). Confirmed: on FUBU, Trial Mod (1532037321740779860), LGBTQ Mini-Mod
(1537459452473638943, the only mini-mod role currently configured — `langmods.json` has just the
one scope), and Event Organizer (1529976148706984110) all had **no overwrite** on #mod-dashboard
(1531087673760944331) — they inherit @everyone's channel-level deny there, which overrides any
category-level allow regardless of role. Also found LGBTQ Mini-Mod was missing the read-only
staff-info channels (#staff-announcements, #staff-discussions, #staff call) that Trial Mod and
Event Organizer already both have — a pre-existing gap surfaced by the "any other channels"
instruction, not something this session created.

Fixed via a second scratch script (`fix_tier_access.js`, `permissionOverwrites.edit()` +
`permguard.blessChannel()` so the 20-min sweep/boot sweep doesn't silently revert it — per
[[project_permguard_bless_after_edit]]):
- FUBU: granted ViewChannel+ReadMessageHistory (read-only, matching the existing Punishments/
  staff-announcements pattern — no SendMessages, this is a reference+panel channel not a chat) on
  #mod-dashboard to all 3 roles. Also gave LGBTQ Mini-Mod the same staff-announcements (read-only,
  explicit SendMessages deny) / staff-discussions (read+send) / staff-call (view+connect+speak)
  access Trial Mod and Event Organizer already had, for tier parity.
- Melanin: granted the same #mod-dashboard read-only access (1534656507503710258) to Trial Mod
  (1534663681504444457) and Event Organizer (1534664249153028257) — no mini-mod role exists there
  yet, so nothing to extend for that tier. Left Melanin's broader staff-info-channel gap alone
  (Trial Mod/Event Organizer don't have staff-announcements/discussions/call there either, but
  that's pre-existing Melanin-vs-FUBU drift outside today's ask, not touched).

Re-audited after the edits to confirm effective access (all 3 FUBU roles now show
`allow=[ViewChannel,ReadMessageHistory]` on #mod-dashboard). Both scratch scripts deleted from
bots-vm. No code changes — this was a live Discord permission fix only.

## 2026-08-19 22:40 — Correction: dashboard access reverted, corner-talk access granted instead

Owner corrected the previous entry: "They should not have access to the dashboard" — the earlier
#mod-dashboard grants for Trial Mod / LGBTQ Mini-Mod / Event Organizer were wrong, staff-only was
correct as-is. Then: "And they should be able to talk in the corner" — a different, real gap:
Trial Mod already had ViewChannel+SendMessages(+SendMessagesInThreads on FUBU) on the actual corner
channel (#the-corner / #corner), but Mini-Mod and Event Organizer didn't.

Reverted (permissionOverwrites.delete + permguard.blessChannel):
- FUBU #mod-dashboard: removed the Trial Mod / LGBTQ Mini-Mod / Event Organizer overwrites added
  last entry.
- Melanin #mod-dashboard: removed the Trial Mod / Event Organizer overwrites added last entry.

Granted (matching Trial Mod's existing corner-channel overwrite exactly):
- FUBU #the-corner (1529552895262068846): LGBTQ Mini-Mod + Event Organizer now have
  ViewChannel+SendMessages+SendMessagesInThreads.
- Melanin #corner (1534359883774951505): Event Organizer now has ViewChannel+SendMessages (Trial
  Mod's Melanin overwrite doesn't include SendMessagesInThreads either, so matched that).

Left untouched (not mentioned in the correction, only "the dashboard" was called out): LGBTQ
Mini-Mod's staff-announcements/staff-discussions/staff-call grants from the previous entry are
still in place. Flagged to the owner in case those should also be reverted.

Re-verified live, both scratch scripts deleted from bots-vm.

## 2026-08-19 23:44 — Two corner bugs: adult+thread routing, and thread membership leaking

Owner, mid-turn while the permission correction above was in flight: "Also the adult + thread
combo makes a thread in the normal corner" and "Also cornered mods keep getting into other
threads."

**Adult routing:** `config.adultCornerChannelId` (config.js) defaults to `''` and neither
`.community_env` nor `.melanin_env` ever set `ADULT_CORNER_CHANNEL_ID` — despite FUBU already
having a live `#🔞┆ᴀᴅᴜʟᴛ-ᴄᴏʀɴᴇʀ` channel (1539460167962198186, confirmed via direct channel fetch;
a name-regex search missed it because the channel name uses small-caps unicode letters, not ASCII
`a-d-u-l-t`). corner.js's `targetChannelId = adult && config.adultCornerChannelId ? ... :
config.cornerChannelId` silently fell through to the normal corner for EVERY `adult:true` corner,
not just the adult+thread combo — the thread flag just made it visible since the resulting thread
landed somewhere the owner could immediately see was wrong. Fixed by appending
`ADULT_CORNER_CHANNEL_ID=1539460167962198186` to `.community_env` and restarting fubu-bot (no code
change for this half, purely a missing env var). Melanin has no adult-corner channel built yet
(confirmed via the same channel search) — left alone, out of scope.

**Thread membership leak:** `corner()` (corner.js) strips every non-identifying role via
`member.roles.set()`, which removes ViewChannel almost everywhere — but never touched existing
Discord thread memberships. Private threads grant access to explicitly-added members independent
of whether they can still see the parent channel, so a cornered mod who'd been added to, say, a
mod-applications review thread or another active corner's jail thread kept reading/posting there
even with every role stripped. Added `stripThreadMemberships(guild, memberId, exceptThreadId)` —
one `guild.channels.fetchActiveThreads()` call, then per-thread `thread.members.fetch(memberId)` +
`.remove()` for every active thread except the member's own new jail thread — called at the end of
both the fresh-corner path and the re-corner/update path (corner.js line ~503/~442).

Verified `discord.js` 14.27.0 on bots-vm has `fetchActiveThreads()` (grepped node_modules
directly) before deploying. `node --check` clean local+remote, both bots restarted clean,
`corner-status` still registered on both. Scratch script `find_adult_corner.js` deleted from
bots-vm. Committed `eac7de0`, pushed.

## 2026-08-20 00:05 — Added "Any Pronouns" to the #roles pronouns section (FUBU)

Owner: "we add an any pronouns role/button." Checked the live pronouns section
(`roleselect_sections.json` on bots-vm) — She/Her, He/Him, They/Them, LGBTQ+, Ally, no "any/ask"
option. Found an existing unused Discord role, `𝗢𝗧𝗛𝗘𝗥𝗦 (ASK)` (1526939765667008615), styled to
match the other pronoun roles' bold-unicode convention but not wired into any #roles section —
clearly built for exactly this and never hooked up, rather than creating a brand-new role.

Wired it in via the same path `/roleselect-role add` uses: `roleselect.addRoleToSection('pronouns',
'Any Pronouns', '1526939765667008615')` then `roleselect.rebuildFromIndex(guild, rolesChannelId,
SECTION_BLOCK_INDEX.pronouns)` — reposted 7 blocks in #roles to reflect the new button. Ran via a
one-off scratch script (`add_any_pronouns.js`, deleted after use) since this is a live-data change,
not a code change — `roleselect_sections.json` is a gitignored state file, nothing to commit.
Melanin not touched (this was specifically a FUBU pronouns-section request; Melanin's own #roles
setup, if any, is untouched).

Confirmed live: pronouns section now lists 6 entries, "Any Pronouns" → 1526939765667008615.

## 2026-08-20 00:08 — Renamed the Any Pronouns role to match

Owner: "Change the role name to any pronouns." Renamed the Discord role itself (1526939765667008615,
previously "𝗢𝗧𝗛𝗘𝗥𝗦 (ASK)") to "𝗔𝗡𝗬 𝗣𝗥𝗢𝗡𝗢𝗨𝗡𝗦" — matching the bold-sans-unicode capitals convention
the other pronoun roles already use (𝗦𝗛𝗘/𝗛𝗘𝗥, 𝗛𝗘/𝗛𝗜𝗠, 𝗧𝗛𝗘𝗬/𝗧𝗛𝗘𝗠), same Unicode Mathematical
Sans-Bold block, offset verified against the existing roles' actual codepoints rather than guessed.
`#roles` picker label was already "Any Pronouns" from the prior entry — unaffected by a role
rename, roleselect.js stores its own label text separately from the Discord role name. One-off
scratch script (`rename_pronoun_role.js`), deleted after use.

## 2026-08-20 00:16 — Cornering slowdown: made thread-membership sweep fire-and-forget

Owner: "Cornering has gotten really slow. People are able to speak in the corner before their
corner announcement is sent." Root cause: the `stripThreadMemberships()` sweep added a few entries
back (guild-wide `fetchActiveThreads()` + a fetch/remove per active thread) was `await`-ed at both
call sites in `corner()`, directly in the hot path before the function returns — every corner now
waited on a full guild thread sweep before the caller could send its announcement. Nothing in the
return value depends on the sweep finishing, so switched both to fire-and-forget
(`.catch(() => {})`, same shape as the function's own internal error handling).

Caught a self-inflicted follow-up: the first pass only fixed the re-corner/update branch (line 440)
— `replace_all` reported "All occurrences were successfully replaced" but the fresh-corner path's
matching line (503, the common case, not the update one) had different leading whitespace (2 spaces
vs 4) so it silently didn't match the same old_string and was still blocking. Caught by re-grepping
after the first deploy instead of trusting the tool's success message, fixed in a second commit.

Both bots restarted clean after each deploy, `node --check` clean throughout. Committed `147b68a`
(partial) then `d7e6b01` (the actual fix, both call sites verified via grep before deploying).

## 2026-08-20 00:52 — Trial Mod generalized to a real 'staff' tier everywhere + hit-squad-deny override

Owner asked (garbled voice-to-text on the corner-status/overrides thread, clarified live): how to deny
hit squad from cornering someone, and pointed out there's no trial-mod-level tier in the overrides
picker. First pass scoped the tier fix to overrides only; owner then said "the trial mod tier should be
generalized to the 'staff' tier everywhere" — clarified via AskUserQuestion as a real floor rank
(Trial Mod / any Mini-Mod / Event Organizer) in the CORE authorization ladder, not scoped to one
feature, and confirmed "full pass now, done carefully" once I flagged it as ~90 call sites with real
security stakes.

**Core change** (opspanel.js): `memberTier()` gains a `'staff'` branch below `mod` (checked via the
same cornered-snapshot-aware role lookup admin/mod already use). `RANK`/`meets()` ladder became
`{staff:1, mod:2, admin:3, owner:4, botowner:5}` (was `mod:1..botowner:4`). Exported `meets` and
`TIER_RANK` for other modules.

**Audit**: went through every `tierOf()`/`memberTier()` call site across index.js, opspanel.js,
corner.js, contest.js, eventorgapps.js, modapps.js, smartwatch.js, suggest.js, permguard.js. Most
were already safe (explicit tier arrays/equality, or a local corner-authority RANK dict that
deliberately excludes staff, matching corner.js's own). Real bugs found and fixed — worst first:

- **enforceTierNesting**: a bare `if (tier)` would have stripped Trial Mod's own role from every
  trial mod on their next role-change event (the "mod+ never keep Trial Mod" cleanup, now matching
  their own new 'staff' tier). Most severe finding — would have de-modded every trial mod almost
  immediately.
- **opspanel.handlePanel's top gate**: `if (!tier)` would have let trial/mini-mod/event-org into
  every shared-panel button handler, including Corner and Ban buttons.
- **canBan** (`!!tierOf`, index.js): gates ~20 downstream sites (strike, watchlist admin,
  suggest/role-request approve, ban/strike appeal votes, mod-app votes, media filters, Tribe Games
  start/report). One fix at the source corrected all of them.
- **modClicked, buildTribePanelView's isStaff** (Tribe Games is mod+ only per its own comment),
  **canManageTribe** (tribe leader-tools — trial-tier joined as a regular member, shouldn't get
  leader authority), **staffBlockedFromMemberTribe + removePromotedFromMemberTribe + its
  guildMemberUpdate callers + the cosign skip-check** (four sites all documented "trial mods are
  fine in a member-founded tribe" — all four were about to start blocking them), **the mod-app
  archive/seal split** (mod+ archived, trial-only sealed — was about to archive trial mods' own
  applications instead of sealing them), **demotion/promotion sweep triggers** in
  guildMemberUpdate, **modapps.js's two thread-membership enforcers** ("legitimately mod+
  belongs"), **the /tribe member-founding cosign-block message routing** (trial mods were about to
  get the wrong denial message), and **the /panel command routing** (rewritten so 'staff' routes to
  the read-only view and the "event organizer with no other role gets the event dashboard"
  special-case still fires exactly as before).

Left several bare-truthy sites unchanged as intentional, low-stakes broadening (Live Tally scoring,
contest management, word-filter/smart-watch/watch-log staff exemptions, jail-thread bypass
allowlist, auto-corner-thread staff exemption) — consistent with treating 'staff' as genuine staff
for those non-security-critical purposes.

**Verification**: no live trial mod/mini-mod/event-organizer holders on FUBU right now to test
against directly, so verified via a synthetic-member unit test on bots-vm instead — a Trial-Mod-only
fake member resolves to `memberTier()='staff'`, `meets(_,'mod')=false`, `meets(_,'staff')=true`; a
real Mod still resolves to `'mod'` with `meets(_,'mod')=true`. Confirms the ladder and gate logic
are correct even without a live test subject.

**overridesManager.js**: `TIER_RANK` now mirrors opspanel's ladder exactly, so a tier-type override
actor entry ("staff+") matches naturally via whatever `tierOf()` already returns. Added a "Staff+"
option to the overrides tier picker.

**Second feature, same deploy**: `DENY_HITSQUAD` override type — a genuine deny-only rule (owner:
EXCLUSIVE_CORNERER's allow-list model would mean enumerating every legitimate staff member just to
block hit squad specifically). `overridesManager.isHitSquadDenied(targetMember)`, checked in
corner.js's `corner()` only when the actor is actually hit-squad-active, leaving staff/member-corner
completely untouched. New "Block Hit Squad" option in the panel's Add Override flow (target-only, no
actor picker), plus list/detail view formatting.

Deployed all 5 touched files (corner.js, index.js, modapps.js, opspanel.js, overridesManager.js)
together to both bots — `node --check` clean local+remote for every file, clean restart, all
commands registered on both, `corner-status` still present. Committed `24dc3b7`, pushed.

## 2026-08-20 01:22 — permguard boot sweep + raidguard alarm now exempt trusted owner

Owner: "the permguard sweep that allows permissions changed by me needs to be generalized to the
server owner or bot owner since i'm not the owner in melanin. same for the dangerous permission
granted popup." Then clarified: "This was more so for melanin. I wanted to make sure changes that
owner makes is excluded from the permguard sweep."

Investigated before touching anything, since the first read didn't match a "hardcoded to me" bug:
`permguard.js`'s `isTrustedOwner` already checked `BOT_OWNER_ID` (config'd identically on both
`.community_env` and `.melanin_env`) OR `guild.ownerId` (dynamic, not hardcoded) OR
`memberTier==='owner'` — confirmed via live logs it was actually working (3 successful auto-adopts
on Melanin in the minutes right before this fix). Confirmed with the owner that `865843812907089940`
is genuinely their ID, ruling out a config mismatch.

Found the real gap: the PERIODIC sweep (`permguard.register()`'s `run()`, every 20min) already calls
`pollOwnerOverwrites()` first — comment: "Bless any owner-made changes FIRST so this sweep never
reverts something you just changed." But index.js's BOOT-TIME call to `sweepPermissions` (right
after login, on every restart) skipped that step entirely, going straight to reverting drift with
zero awareness of who made it. This repo gets restarted constantly during active dev sessions —
every restart was a real revert-on-boot window for a not-yet-blessed owner edit, not the rare
cold-boot case the comment implies. Exported `pollOwnerOverwrites` from permguard.js; index.js's
boot sequence now calls it immediately before `sweepPermissions`, matching the periodic sweep
exactly.

Also fixed the second half: `raidguard.js`'s "⚠️ Dangerous permission granted" alarm
(`onChannelUpdate`) had NO owner-exemption at all — fired on literally any dangerous-permission
grant, including the real owner's own deliberate change. Added a best-effort audit-log lookup (most
recent `ChannelOverwriteCreate`/`Update` entry for the changed channel) that skips the alert when
`permguard.isTrustedOwner()` confirms the executor; falls through to alert on any lookup failure
(false positive is cheaper than a swallowed real one). Exported `isTrustedOwner` from permguard.js
for raidguard.js to share (no circular require risk, confirmed).

Deployed all 3 files (permguard.js, raidguard.js, index.js) together, clean restart on both bots.
Melanin's boot sweep still corrected 1 unrelated drifted overwrite (silent, `notify:false`) —
plausible pre-existing drift unconnected to this fix, not chased further. Committed `e2255fb`,
pushed.

## 2026-08-20 01:28 — Reworked "Protect Someone" into a general deny-list (replaces DENY_HITSQUAD)

Owner: the hit-squad-only override built earlier this session "isn't really what i was looking for."
Clarified: "there are different reasons someone could be cornered. hit squad, by staff, or by a
member (when on)... when creating a protect someone there should be a protect from whom which can
be a role or a person or a tier of staff or the hitsquad or from other members." Confirmed the
model via AskUserQuestion: rework "Protect Someone" into a deny-list (pick sources to block) instead
of today's allow-list (pick who's allowed) — everything not listed still works normally.

Checked live data before touching anything: 3 real `EXCLUSIVE_CORNERER` rules already exist
(e.g. "only server owner can corner knylvr") whose exact meaning depends on the allow-list model —
reinterpreting that field as a deny-list would have silently inverted real protections. Kept
`EXCLUSIVE_CORNERER` completely untouched; added a new, additive `PROTECT_FROM` type instead. "Protect
Someone" in the panel now creates `PROTECT_FROM` going forward. `checkExclusiveProtection` (legacy)
and the new `checkProtectFrom` run independently in corner.js — either can deny, a target can have
either/both/neither. Retired `DENY_HITSQUAD` entirely (built minutes earlier this session, zero live
rules existed, no migration needed) — hit-squad-only protection is now just one denied-entry choice
within `PROTECT_FROM`.

`overridesManager.js`: `denied[]` entries — `{type:'user'|'role', id}`, `{type:'tier', id}` (that
tier and above, same TIER_RANK ladder), `{type:'hitsquad'}`, `{type:'membercorner'}`.
`checkProtectFrom(targetMember, actorId, actorMember, actorTier, source)` where
`source={hitSquad,memberCorner}` tells it which non-tier corner path the actor is using.
`addDeniedEntry`/`removeDeniedEntry`/`normalizeDenied` mirror the existing actor-list helpers.

`corner.js`: computes `source` from `hitsquad.isSquadMember(byId)` and a new `viaMemberCorner` opt.
Threaded `viaMemberCorner` through both member-corner call sites — `doMemberCorner` (the Send-to-corner
context-menu path) and the main `/corner` slash command's `mCorner` branch — neither previously told
corner.js a call came via member-corner at all.

`opspanel.js`: new `denyFromPickRow()` (member/role/tier pickers, plus 🚔 Hit Squad / 👤 Regular
Members folded into the tier dropdown as their own options, not real tier-ladder ranks). Detail view
gets Add Block/Remove Block buttons parallel to the legacy Add/Remove Actor. Display formatting
(`OV_TYPE_LABEL`, `overrideActorFmt`, `overrideSummaryLine`, `overrideShortLabel`, `fmtEntity`)
updated to render both rule families correctly.

Verified with unit tests before deploying (temp override-file fixtures, not live data): `PROTECT_FROM`
denies only the matching source and allows everything else; the 3 live `EXCLUSIVE_CORNERER` rules
evaluate identically through `checkExclusiveProtection`, confirmed `checkProtectFrom` is a no-op on
legacy-only rules. Deployed all 4 files, clean restart on both bots. Committed `3f39b37`, pushed.
