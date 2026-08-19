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
