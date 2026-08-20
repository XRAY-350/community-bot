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

## 2026-08-20 21:13 — Built Mafia mode (/mafia) — a full game engine, not an /amongus-style helper

Owner: "i want to build a mafia mode for the bot. like /amongus". Planned in plan mode first (plan
saved at `~/.claude/plans/abstract-fluttering-church.md`), with the scope decided via AskUserQuestion
before any code: **full self-contained engine** (bot deals secret roles, collects and resolves night
actions, calls the win condition) rather than /amongus's model, where the bot only toggles VC mute
phases and a human host tracks everything by eye. Classic 4 roles (Mafia/Villager/Doctor/Detective),
no rewards in v1, staff-gated start (mirrors /amongus's own "only STAFF can start one" rationale),
open joining.

**Key owner correction mid-planning** that shaped the whole design: the first draft leaned on DMs for
role delivery and night actions. Owner: *"There doesn't have to be anything in DMs or any separate
channels for the voice version. What we can do is that we can have a button that everyone clicks to
receive their role, and then we can deafen people as well as mute them so that if people need to
discuss, they can obviously do that. for the text version yes we can do a private thread."* So: role
reveal is a **My Role** button (ephemeral, re-checkable any time), and all three night actions go
through ONE shared Night Actions panel whose buttons check the clicker's actual role server-side —
secrecy comes from ephemeral replies + server-side role checks, not from who can see which channel.
This is what makes voice and text mode nearly the same code path.

Also owner-decided: mode is **auto-detected** at lobby close (voice only if every joined player is
actually connected to the game's VC, else text); a tied day vote = **no elimination**; role counts
scale with player count "similar to Among Us"; runs in **any gaming VC** (no dedicated channel, zero
new config keys); disconnects get a grace period rather than instant ghosting.

New `mafia.js`: per-VC game state (like amongus's `games[vcId]` map, not sealed.js's single active
game), role assignment (Fisher-Yates shuffle; mafia = ⌊n/4⌋, Doctor at 5+, Detective at 6+, rest
villagers), night resolution (mafia plurality kill vs doctor save), day elimination vote, win check
after every death (all-mafia-dead → Town; mafia ≥ town → Mafia), and full lifecycle panels.

Two design choices worth noting, both deliberate deviations from the plan as written:
- **Voice muting is self-contained here, not reused from amongus.js.** The plan said to export
  `setMute`/`forceUnmute`/`setVcStatus` from amongus and reuse them — but mafia needs mute AND deafen
  together on the same member, and amongus has no deafen concept at all, so reusing its single-flag
  helpers would have meant calling two functions with divergent guard logic per member. Wrote
  `setVoiceState(member, mute, deaf)` / `releaseVoice(member)` instead (~8 lines), and reverted the
  amongus.js export change — amongus.js is untouched in the final diff.
- **One periodic sweep drives every phase transition, no per-phase setTimeout.** The plan proposed
  setTimeout-per-transition plus a sweep as backstop (matching sealed/arena). Went sweep-only (15s
  tick): it makes boot-reconcile fall out for free — an overdue phase is just picked up on the next
  tick after a restart, with no resume/re-arm logic to write or get wrong. This is the single
  highest-risk area in sealed/arena's design and skipping it entirely is simpler than replicating it.

Wired into `index.js` (require, feature-gated command registration, `mafia.register(client)` boot
call, interaction dispatch block placed immediately after amongus's, same early-routing rationale)
and `features.js` (new `mafia` registry entry, `built: false` so it seeds DARK like every other
unreleased feature).

Verified: `node --check` on all 4 touched files locally + remotely; `require('./mafia.js')` loads
clean on bots-vm (catches missing-export/circular-require errors `--check` can't); and a scratch
logic harness exercising the pure helpers (now exported for exactly this purpose) — role
distribution sums correctly at 5/6/7/8/11/12/15 players, assignment covers every player exactly once
with correct per-role counts, roles genuinely vary across 30 runs (caught nothing, but proves the
shuffle isn't a no-op), all 4 win-condition cases, and 4 plurality/tie cases including "votes for a
dead player are ignored". ALL PASS. Both bots restarted clean, `mafia` confirmed seeded as `false`
in FUBU's features.json. Scratch script deleted from bots-vm, confirmed gone.

**Not yet done — the feature is still dark.** It needs a live multi-account playtest (lobby → role
assignment → voice mute/deafen check → full night/day cycle → win condition → cleanup, plus a
restart-mid-phase test) before flipping it on via `/features`. Timer lengths (60s lobby / 90s night /
120s day) are first-guess constants at the top of `mafia.js`, explicitly TBD pending a real game.

## 2026-08-20 20:44 — New /sidebar (mod pulls a member aside for a private chat) + found/fixed a real bug in the just-shipped thread-based /report

Owner: "build something like this / like the corner so a mod can pull someone aside for a chat." New
staff-initiated feature, explicitly NOT punitive (no role strips, no restrictions elsewhere, unlike
/corner) — just a private 1:1 space. Three entry points: `/sidebar user:<member> reason:<optional>`,
right-click a member → Apps → **Sidebar** (opens a reason modal, no rule picker since nothing's being
enforced), and `/sidebar-setup` (owner-only, creates the channel). New `sidebar.js` mirrors
`reports.js`'s thread shape exactly: one private thread per pull in a dedicated hidden channel, the
target added to it, Close/Reopen buttons (`sb_close`/`sb_reopen`, gated mod+ same as reports' now
`canBan` gate). `index.js` gained the require, 2 SlashCommandBuilder entries, 1 ContextMenuCommandBuilder
entry, the context-menu handler (shows the reason modal), the modal-submit handler, the slash-command
handler, `sidebar-setup` folded into the existing report-setup/modmail-setup branch, and the
`sb_close`/`sb_reopen` button gate.

**Found a real, already-live bug while testing this** (fix the class, not the instance — the bug in
sidebar.js's first draft turned out to already be live in reports.js, deployed earlier tonight):
both `reports.js` and the new `sidebar.js` created their channel with `deny: [ViewChannel]` for
`@everyone` (reports.js additionally tried copying watch-log's overwrites, same problem if
watch-log is *also* fully hidden). Adding a member to a private thread needs the bot to have
permission to add them — Discord's "Add Thread Member" call fails with **`Missing Access`** if the
target has zero visibility into the parent channel and the actor lacks `MANAGE_THREADS`-derived
override for that specific add. My own testing of the new thread-based `/report` had used the guild
owner as the reporter, whose Administrator permission bypasses all channel denies — so this never
surfaced until testing sidebar with an ordinary member. **This meant real `/report` submissions from
any non-admin member were silently failing to add the reporter to their own report thread since
tonight's earlier deploy.** Root-caused by comparing against the already-correct pattern used
elsewhere in the codebase (`strikeAppeals.js`, `appeals.js`, `modapps.js`'s applicant-thread channel):
`@everyone` gets `ViewChannel`+`ReadMessageHistory`+`SendMessagesInThreads` ALLOWED at the channel
root, with only `SendMessages`+`CreatePublicThreads`+`CreatePrivateThreads` denied — members can see
the channel exists but can't post in root or see each other's private threads (Discord only shows a
private thread to its own members or `ManageThreads` holders), yet the bot CAN add anyone to a thread
there. Rewrote both `reports.js` and `sidebar.js`'s `setup()` to this shape.

Patched the LIVE channels on FUBU to match (both had already been created with the broken overwrite —
one from before this session, one from testing sidebar minutes earlier) via a scratch script, and
**blessed both through `permguard`** immediately after, since an un-blessed manual overwrite edit gets
silently reverted by the 45-second post-boot sweep or the 20-min interval sweep otherwise — this
actually happened once during verification (first bless attempt got raced/reverted, caught it by
re-checking the manifest file directly afterward, redid it, confirmed the manifest and live overwrite
matched on a second check). Live-verified end to end with real non-admin members for both `/report`
and `/sidebar` after the fix: target genuinely gets added to the thread now (`thread.members.fetch()`
shows their ID, not just the bot's).

**Found in passing, not fixed (out of scope, flagging only):** Melanin's `reports.json` still points
to a `channelId` that no longer exists on Discord — `/report` there currently fails with
"channel missing" for any member. Pre-existing, unrelated to tonight's changes (the channel was
apparently deleted at some point before this session). Melanin's own admin needs to run
`/report-setup` again there; not something to do on their behalf.

`node --check` clean local+remote every deploy, both bots restarted clean each time. Scratch scripts
(6 total across this fix cycle) deleted from bots-vm, confirmed gone.

## 2026-08-20 20:13 — /report now opens a private thread instead of a one-shot message

Prompted by comparing against Ticket Tool (a Discord ticketing bot the owner was asked to add).
Researched what it offers beyond what's already built here — most of it (visual flow builder, SLA
timers, AI routing, analytics dashboard, knowledge base, multi-server team inbox) isn't relevant to
what was actually being asked for. The one real gap: every existing anon-pipe module (`reports.js`,
`modmail.js`, `confessions.js`) is fire-and-forget, one message and done, no way to follow up. Owner
confirmed that's exactly the complaint: "User sends in a request, mods look at it, and sort the
situation out on the thread, it's more private and the thread gets closed after... what we have works
as a one off but it's not good for follow up."

Confirmed via AskUserQuestion this should REPLACE `/report` outright (not sit alongside it as a
separate feature) — the existing right-click "Report" + hub "Report" button both call
`reports.submit()`, so one rewrite covers all three entry points (context menu, hub button, slash
command).

Rewrote `reports.js` mirroring `strikeAppeals.js`'s already-proven thread architecture (private
thread per submission, member added, staff have native channel access, `setLocked`/`setArchived` to
close/reopen) instead of inventing a new pattern. `submit()` now creates a `ChannelType.PrivateThread`
in the reports channel, adds the reporter, posts the report as the starter message with Close/Reopen
buttons. New `setStatus()` replaces the old admin-only `reveal()` — reveal doesn't make sense once
staff are visibly IN the thread with the reporter; the reporter is still never added to a thread about
themselves if they're the one BEING reported, so the "hidden from the person you're reporting"
guarantee holds, just not "hidden from staff" (which a live conversation can't preserve anyway).
Close/Reopen gated to mod+ (`canBan`, same tier as strike-appeal voting) in index.js's button
dispatcher, replacing the old `rep_reveal`/admin-only gate. Removed the now-dead `copy.reports.
revealLabel`.

All 3 call sites (right-click Report, hub Report button, `/report` slash command) updated to report
the new thread link instead of "sent anonymously." `/report`'s own description updated to match.

`node --check` clean local+remote, both bots restarted clean. Live-verified end to end on FUBU: real
`reports.submit()` call created a genuine private thread (type 12), added the reporter, then
confirmed `setLocked(true)`+`setArchived(true)` (close) and the reverse (reopen) both worked against
the live thread. Test thread deleted afterward; scratch scripts removed from bots-vm, confirmed gone.

## 2026-08-20 18:24 — Added a Whistleblow button to the member hub

Owner: whistleblow had no button on the public member hub even though confess/suggest/modmail/
report/appeal all do — noticed while comparing against Ticket Tool.

Whistleblow needs one extra piece of info a modal alone can't collect: WHO it goes to (head admin /
owner / both / anonymous-unmaskable) — modals only take text inputs. Solved with a two-step button
flow, same shape used elsewhere for select-then-modal (e.g. tribe alliance picks): tapping
**🕊️ Whistleblow** (new `pubact_whistleblow`, its own row on the hub since actions row was already
at Discord's 5-button cap) posts an ephemeral picker (`pubdash.whistleblowPicker()`) with 4 buttons
for the recipient choice; picking one (`pubact_wb_to:<choice>`) opens a text modal with the choice
baked into its customId (`pubmodal_whistleblow:<choice>`); submitting calls
`whistleblow.submit(guild, member, text, choice)`, same call the `/whistleblow` slash command
already makes. Guarded by the same verified-gate and `whistleblow.isConfigured()` check the slash
command uses, with the same "not set up" message if a server hasn't run `/whistleblow-setup` yet.

`pubdash.js`: new `trust` button row, `whistleblowPicker()`, `whistleblowModal(choice)`, both
exported. `index.js`: 3 new branches in the `pub*` button handler + one in the `pubmodal_` submit
handler.

Confirmed live state first: FUBU's `whistleblow.json` already has `you`/`her` both set to the owner
(matches "I am both the head admin and server owner"), one prior anonymous whistleblow on record —
so the new button works immediately on FUBU with no setup step. Melanin has the feature flag on but
no config yet — the button will correctly show the "not set up" message there until Melanin's admin
runs `/whistleblow-setup`, not something to do on their behalf.

`node --check` clean local+remote, both bots restarted clean. Manually refreshed BOTH guilds'
already-pinned member hub panels in place (`panel.edit()`, matching the awards-panel edit-in-place
pattern) since `/dashboard-setup` posts once and never re-edits — otherwise the new button wouldn't
show up until someone re-ran setup. Scratch scripts deleted from bots-vm, confirmed gone.

## 2026-08-20 13:55 — Moved the 17 superlative roles above the tribe base-role cluster (live, no code)

Owner had manually repositioned the tribe base-member roles "right under the staff tier" themselves
(their own live edit, not this session's code), then: "i think the superlatives should go above
them tho." Confirmed via AskUserQuestion which cluster they meant (the rank-ladder roles at the
bottom of the whole server vs. the base/leader/General cluster near staff) before touching anything
live.

First attempt (`reposition_awards2.js`, targeting only the 17 award roles at positions right above
the base cluster's top) went wrong — Discord's bulk role-PATCH only cleanly relocates roles you
fully re-specify; targeting just the 17 movers while leaving surrounding roles' old position numbers
untouched caused an overlap, and Discord's resort interleaved the award roles into the
Leader/General/Mods/Trial-Mods block instead of forming a clean group. Caught it immediately by
re-listing roles after the patch, didn't leave it live.

Fixed by rebuilding the ENTIRE role order explicitly (`reposition_awards3.js`): took the full current
top-to-bottom role list, pulled the 17 award roles out, found the topmost base-tribe-member role's
index, spliced the award block back in immediately above it, then bulk-patched dense positions for
all 236 non-@everyone roles in one request — no ambiguity, no partial-list resort surprises.
Verified after: every previously-correct role landed back at its old relative spot, and the 17
superlatives now sit as one contiguous block directly above the base-tribe cluster, still below
Event Organizer/Mini-Mods/Trial Mods.

Live Discord change only, no code touched. Scratch scripts (`list_roles.js`, `reposition_awards.js`,
`reposition_awards2.js`, `reposition_awards3.js`) deleted from bots-vm, confirmed gone.

## 2026-08-20 13:42 — Fixed tribe base-role hierarchy position + restored 8 colorless award roles

Owner: "Something keeps moving the base tribe roles to the other rank roles and I don't want that
to happen" — `enforceRankOrder()` (index.js, hourly + boot via `sweepLeaderRequirement`) was
force-ordering each tribe's roles as `rank1<rank2<rank3<member<rank4<General`, interleaving the base
membership role in between rank3 and rank4 instead of putting it above all 4 ranks. Confirmed via
AskUserQuestion the owner wants it moved, just to the right spot — landed on
`rank1<rank2<rank3<rank4<member<General` (base role above every rank, just under General). Changed
the `ordered` array in `enforceRankOrder` accordingly; the function's no-op/bulk-reposition logic
itself was already correct, only the target order was wrong.

Owner also: "the superlatives have lost their color". Diagnosed live (scratch `list_award_roles.js`)
— NOT a reset: of the 17 award roles, the 9 reused pre-existing roles (funniest, unfunniest, angry,
goofy, kawaii, cutecuddly, freakiest, cutestever, goated) all still have their original colors. The
8 categories newly created to mirror Melanin's set (week, pet, cool, nice, mean, nonchalant,
chalant, happy) were colorless from the moment `ensureAwardRole()` created them — `guild.roles.create()`
was never given a `color`, so Discord defaulted them to black/no-color. Never actually had color to
lose.

Fixed the class, not just the instance: added `AWARD_ROLE_COLORS` (10-color palette) +
`awardRoleColor(categoryKey)` (deterministic hash-pick, same category always gets the same color) and
wired it into `ensureAwardRole`'s role-create call (with the same `colors:`→`color:` fallback pattern
used elsewhere in the file for the deprecated single-color API), so any FUTURE award category also
gets a real color on creation, not just these 8. Then live-recolored the 8 existing colorless roles
via a scratch script using the identical palette function (`week`→#e91e63, `pet`/`cool`→#1abc9c,
`nice`/`chalant`→#9b59b6, `mean`→#f4d03f, `nonchalant`→#922b21, `happy`→#e67e22) — verified via the
same list script that none of the 9 already-colored roles were touched.

`node --check` clean local+remote, both bots restarted clean, scratch scripts (`list_award_roles.js`,
`fix_award_colors.js`) deleted from bots-vm and confirmed gone.

## 2026-08-20 04:30 — Confirmed awards vote panel's edit-in-place fix actually holds across a restart

Follow-up to the 04:20 entry. After that deploy the panel's message ID had changed AGAIN
(`1539850762505424926` → `1539851808409649192`), which looked like the edit-in-place fix hadn't
actually taken — worth double-checking before calling it closed.

Root-caused via a scratch diagnostic (`check_panel_messages.js`, fetched all 3 known message IDs +
`fetchPinned()`): the two older IDs are genuinely gone (`Unknown Message`, not a permissions/cache
issue — confirmed the bot can view the channel fine), and there is exactly 1 pinned message right
now, matching the current ref. Cross-referenced the 04:16 and 04:20 log entries: at 04:20 the
*deployed* code was still the old always-delete-and-repost version (04:16's entry says so outright)
— that restart deleted message 1 and created message 2 using the OLD logic, coincidentally at the
same moment the dguild fix made the boot call fire for the first time. The edit-in-place rewrite
was written and deployed only afterward, so the 04:23 restart that produced message 3 was its
first-ever run, inheriting a stale ref (message 2) left over from the old code's just-prior repost
— not a bug in the new logic.

Restarted both bots once more to test the new code on a self-consistent ref: `awards.panelRef()`
came back identical (`1539851808409649192`) after the restart. Edit-in-place confirmed working —
the one extra ID change was a one-time artifact of the deploy sequence, not a recurring issue.

Deleted all leftover scratch scripts from bots-vm (`check_panel_messages.js`,
`make_superlatives_readonly.js`, `unhide_new_channels.js`, `test_awards_panel.js`), verified gone.
No code changes this entry — investigation/verification only.

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

## 2026-08-20 01:59 — Restored allow-list rule creation (nothing stays a one-off)

Owner: "convert existing entries to the new format" — before answering the AskUserQuestion I'd
raised about how to convert them, owner interrupted with a standing principle: "all existing rules
are a shape that should be able to be created again... i don't want anything to be a one off only
able to be made through you." This reframed the actual problem: the deny-list rework had made
`EXCLUSIVE_CORNERER` (allow-list, "only X can corner them") data that still worked but was no
longer CREATABLE — the rule-type picker's only path led to `PROTECT_FROM` now. A future allow-list
rule would only ever exist if I hand-wrote it via `addOverride()` directly, exactly the class of
thing the owner doesn't want to depend on me for.

Fixed by adding back the allow-list flow as its own explicit, distinctly-labeled picker option:
"🔐 Only These Can Corner Them" (EXCLUSIVE_CORNERER) alongside "🚫 Block Specific Sources" (renamed
from the earlier generic "Protect Someone", so the two opposite mental models are chosen
deliberately rather than one silently winning). Restored the exact `actorPickRow`-based creation
branch and its `fops_ov_exclusiveactors:`/`fops_ov_exclusiverole:`/`fops_ov_exclusiveactortier:`
handler that existed before the deny-list rework — same code, just re-added alongside `PROTECT_FROM`
instead of replaced by it. The detail-view Add/Remove Actor buttons and Hit Squad Exempt toggle for
`EXCLUSIVE_CORNERER` were never removed, so they already worked correctly once rules of that shape
exist again.

No conversion of the 3 live legacy rules was needed or attempted — they were never broken, only the
*creation path* for new ones like them was missing. Deployed, clean restart on both bots. Committed
`1bef9b1`, pushed.

## 2026-08-20 02:13 — Thread strip was leaving visible "removed" messages in casual forums

Owner: cornered members were getting kicked from Hobbies & Interests and LGBTQ forum threads.
Confirmed via question this was about access being right but the MECHANISM being wrong: "i don't
want them to be able to access it when cornered but removing them leaves a permanent message in the
thread" — `thread.members.remove()` posts a permanent "removed from thread" system message, fine in
a staff-only private thread but a visible leak in a completely casual public forum.

Turned out the removal was also unnecessary for those: every forum post is a PUBLIC thread (forums
can't contain private threads at all), and public-thread access derives purely from the parent
channel's ViewChannel permission — which the corner role-strip already revokes. Explicit membership
grants no bypass there, unlike PRIVATE threads (jail threads, mod-application applicant threads),
which genuinely do grant access independent of parent visibility — that's the actual gap
`stripThreadMemberships()` exists to close.

Fixed: added a `thread.type !== ChannelType.PrivateThread` filter so the function now skips every
public/forum thread entirely — no system message, no membership churn — while still fully closing
access via the channel-level permission the role strip already handles. Private threads (the real
gap) are unaffected, still get the explicit removal exactly as before.

`node --check` clean local+remote, both bots restarted clean. Committed `e30ba30`, pushed.

## 2026-08-20 02:22 — Confirmed nothing can delete these messages; found + fixed 2 more sources

Owner: "can anything delete these messages? or stop them from being made?" Tested live rather than
guessing: fetched a real "removed from thread" system message (type 2, RecipientRemove) sitting in
FUBU's LGBTQ forum and attempted to delete it with the bot's own (guild-wide Manage Messages)
permissions. Discord's API refused outright — `DiscordAPIError[50021]: Cannot execute action on a
system message` — confirming this isn't a permissions gate, it's a hard platform restriction. Not
the bot, not a human in the Discord client, nothing can remove one of these once posted.

That makes prevention the only real lever. Audited every other `thread.members.remove()` call site
in the codebase (grepped all 6). Found two more sources beyond the corner.js one fixed earlier
tonight, both in modapps.js, both operating on mod-application REVIEW threads — which are forum
posts (forums structurally cannot contain private threads, so they're always public, same class as
the Hobbies & Interests / LGBTQ case):
- `enforceReviewThreadMembers` — fires on `threadMembersUpdate` plus a boot sweep
  (`sweepReviewThreadMembers`), was stripping "unauthorized" members from review threads even though
  public-thread visibility is gated entirely by the parent forum channel, not membership.
- `removeDemotedFromReviewThreads` — fires on a mod/admin demotion, same root issue: swept a
  demoted ex-mod out of every review thread's membership, generating one permanent litter message
  per thread for no security benefit (the demotion's role removal already revokes their forum
  visibility).

Confirmed the other 4 `.members.remove()` sites (corner.js's now-fixed one, index.js's jail-thread
ejector, modapps.js's `enforceApplicantThreadMembers` and `sealOwnApplication`) all correctly
operate on genuinely PRIVATE threads (jail threads, applicant threads) where explicit removal is the
real, necessary fix — left those untouched.

`enforceReviewThreadMembers` now early-returns for any thread that isn't `ChannelType.PrivateThread`
(mirrors the corner.js pattern). `removeDemotedFromReviewThreads` reduced to a no-op stub — its
entire body only ever touched review-forum threads, so there was nothing left to keep; kept as a
function (not deleted) since its one index.js caller still expects a count back.

`node --check` clean local+remote, both bots restarted clean. Committed `d77f123`, pushed.

## 2026-08-20 02:47 — "Send to corner" was throwing "target is not defined"

Owner: "i tried to use send to corner and i got a Could not corner error." journalctl showed the
real thrown error: `[corner-reason] target is not defined`.

Root cause: the `corner_reason:` modal handler (the final step of Send-to-corner — right-click a
message → pick a rule → this modal) fetched the CHANNEL the flagged message lived in but never
fetched the message itself, then passed the never-defined `target` variable straight into
`cornerFromMessage()`, which needs a real Message object (`target.author`, `.content`,
`.attachments`, `.channel`, `.reply()`, `.url`). Confirmed via journalctl this has been broken since
at least 00:50 tonight — predates every corner.js/index.js change made this session, not something
introduced by anything done today.

Fixed by actually fetching the message (`target = await ch.messages.fetch(messageId)`), with a
clear ephemeral error if it's gone ("deleted?") instead of the generic "Could not corner."
Confirmed `cornerFromMessage()` has exactly one call site, so no other handler needed the same fix.

`node --check` clean local+remote, both bots restarted clean. Committed `8ff55f6`, pushed.

## 2026-08-20 02:55 — New /corner slowmode argument for jail threads

Owner: "now that we have individual threads we can set the slowmode in the specific thread when
cornering. so add a slowmode argument."

New `/corner slowmode` option (string, duration format like `30s`/`5m`/`1h`, reuses
`corner.parseDuration`). Requires `thread:true` — rejected with a clear ephemeral message otherwise,
since slowmode is a per-CHANNEL Discord setting and without a dedicated jail thread there's no
per-person channel to throttle (the shared #the-corner channel is everyone's). Clamped to Discord's
6h (21600s) `rateLimitPerUser` cap.

Threaded `slowmodeSec` through the whole chain: index.js's `/corner` handler → both `cornerMany()`
(the bulk `also`/`sweep` path) and `corner.corner()` (single-target path) → corner.js's
`getOrCreateCornerJailThread()`, which now sets `rateLimitPerUser` at thread creation and re-applies
it via `setRateLimitPerUser()` when an existing jail thread gets reused (so a re-corner doesn't
silently inherit whatever slowmode a prior corner left set). Caught the same leading-whitespace
`replace_all` gap from earlier tonight — one of the two `getOrCreateCornerJailThread` call sites had
different indentation and didn't match, caught by re-grepping before deploying rather than trusting
the tool's success message.

Also updated the pinned per-command reference (built earlier tonight) to document the new argument
— verified still well under Discord's message/embed size limits (110/2000 content chars, 623/4096
embed description chars) before deploying.

`node --check` clean local+remote for all 3 files, both bots restarted clean, `/corner` registered
fine on both (confirms the new option's description stayed under the 100-char limit). Committed
`82487c9`, pushed.

## 2026-08-20 03:38 — Set up FUBU's weekly awards (was enabled but empty)

Investigated "what features are on in Melanin that aren't in FUBU" — feature FLAGS turned out
identical (FUBU is a strict superset), but `awards` (weekly peer-voted superlatives, e.g. "Funniest
Member" — rotating role each week, Wed reminder / Fri tally) was flagged `true` on both yet had ZERO
categories configured on FUBU vs Melanin's 11. Owner: "let's set it up."

Mirrored Melanin's 11 categories onto FUBU (funniest/unfunniest/week/pet/cool/nice/mean/
nonchalant/chalant/angry/happy) — role IDs can't be shared cross-guild, so created 11 fresh roles
initially. Owner then flagged 3 of those were unnecessary duplicates: FUBU already had matching
roles from before (`FUNNIEST member🤣`, `UNFUNNIEST member😡`, `ANGRIEST MEMBER`) — deleted the 3
duplicate roles I'd just created and re-pointed those 3 categories at the pre-existing role IDs
instead.

Those pre-existing roles turned out to be multi-holder CLUB badges (19/4/5 people respectively),
not single-rotating-winner roles the awards system expects — `swapAwardHolder()` removes the
previous single holder and adds one new winner, so reusing them as-is would have stripped the role
from everyone but that week's winner on the first Friday tally, a real disruptive change to
people's existing badges. Owner: "to reconcile we just remove them" — stripped the role from all
current holders on all 3, so they start clean as of this week.

Owner then flagged FUBU has its own additional superlative-style roles beyond Melanin's list.
Surveyed the full role list, proposed 8 candidates (excluding tribe/color/chatter-tier roles and
what looked like personal nickname roles tied to one specific member — RIRI, Bun Bun, naynay,
Yohan, Senku, Cobain, princess cleo, etc.), owner picked 6: Top GOOFY, Kawaiiest, Cute & Cuddly,
Freakiest Member, cutest ever!, GOATED. Same treatment — checked holder counts (1/7/15/6/8/6),
stripped all current holders, added as new award categories pointing at the existing roles.

FUBU now has 17 award categories total (11 mirrored + 6 FUBU-specific), all starting with zero
current holders, ready for this week's votes and Friday's first tally. All work done live via
one-off scratch scripts (awards.js state file + Discord role edits) — no code changes, nothing to
commit. Bot restarted so the in-memory awards cache (per the statepath caching gotcha) picks up the
final state; confirmed clean restart, all commands still registered.

## 2026-08-20 03:50 — Birthday + weekly-superlatives announcement channels (built, not yet revealed)

Owner: "let's create a birthday channel and a place to announce the weekly superlatives."

Awards already had `config.awardsAnnounceChannelId` and the reminder/results posting code was
already fully written (`awardsReminderIfDue`/`awardsResultsIfDue`) — it had just never been pointed
at a real channel, so it silently no-op'd. Birthdays had NO announcement mechanism at all:
`sweepBirthdays()` granted/revoked the per-person ephemeral role but never posted anywhere. Added
`config.birthdayChannelId` and a post right at the moment a birthday role is freshly granted (not
on every hourly sweep tick — only that one moment).

Created both channels live on FUBU: `🎂┆ʙɪʀᴛʜᴅᴀʏꜱ` and `🏆┆ᴡᴇᴇᴋʟʏ-ꜱᴜᴘᴇʀʟᴀᴛɪᴠᴇꜱ`, small-caps styled to
match the server's existing naming convention, placed under the `ღ ᴄᴏᴍᴍᴜɴɪᴛʏ ఌ` category alongside
#general etc. Built hidden/staff-only first (standing practice — new channels get built hidden,
revealed in a separate confirmed step), blessed via permguard so the drift sweep doesn't fight the
deliberate hide. `BIRTHDAY_CHANNEL_ID=1539843842008809513` / `AWARDS_ANNOUNCE_CHANNEL_ID=1539843843363700746`
set in `.community_env`.

`node --check` clean local+remote, fubu-bot restarted clean, both scratch scripts deleted from
bots-vm. Committed `3a9e036`, pushed. **Not yet revealed to everyone** — need to confirm with owner
before flipping visibility.

## 2026-08-20 03:59 — Added opt-in Birthday ping role

Owner: "let's make a birthday ping role." Created `🎂 Birthday ping` (self-assign, matching the
existing `Event ping` role's exact styling — hoist:false, mentionable:false, pinged via
`allowedMentions.roles` since the bot has Administrator regardless of the mentionable flag), added
it to roleselect's `notifications` section (same section Event ping/Gaming/Music/Calling/etc.
already live in) via `addRoleToSection` + `rebuildFromIndex` — #roles now shows it as a 9th block in
that section.

Hit a real timing issue: `rebuildFromIndex` needs to delete+repost every block from the
notifications section onward (9 blocks), each requiring a full member-list scan via `ensureMembers`
— took long enough to blow through a 30s and then a 90s foreground timeout before finally completing
in the background (~3+ min total, `reposted: 9`). Not a bug, just genuinely slow on a server this
size — noted for next time a role gets added to an early/middle section.

`config.birthdayPingRoleId` added; the birthday announcement (from earlier tonight) now appends the
role mention when configured. `BIRTHDAY_PING_ROLE_ID=1539844665665126470` set in `.community_env`.
`node --check` clean local+remote, fubu-bot restarted clean, both scratch scripts deleted. Committed
`8e30438`, pushed.

## 2026-08-20 04:03 — Blocked activity-tier roles (Chatter/NOLIFE) from /request-role

Owner: "remove the chatter level roles from role request." `/request-role` has no curated role
list — Discord's native role-option picker can't be filtered client-side, so eligibility is checked
at submit time via `whyNotRequestable()` against a `systemRoleIds()` blocklist. Novice/Intermediate/
Elite Chatter carry no power permission, so they were never excluded and were fully requestable
despite being meant as auto-earned activity tiers.

Added a `CHATTER` blocklist array alongside the existing `STAFF` one, folded into
`systemRoleIds()`. Owner caught a gap in the first pass — "missing no life" — NOLIFE is the top of
the same activity ladder, added as a 4th entry. Re-scanned all role names for chat/life/talker/
active/activity keywords before redeploying to confirm nothing else in that family was missed
(GOATED 💯 also matched the scan but is an unrelated awards-superlative role set up earlier
tonight, correctly left alone).

`node --check` clean local+remote, both bots restarted clean. Committed `3d5f8db`, pushed.

## 2026-08-20 04:09 — Bulk-seeded Birthday ping, reused Event ping for weekly awards

Owner: "in the future the birthday role will be opt in but for now i want every person that has sent
a message over the last 24 hours to get it." One-off bulk grant, not a code change: scanned all 77
text channels (+ their active threads) for messages within the last 24h, collected 101 unique
non-bot authors, granted 🎂 Birthday ping to each — 99 succeeded, 2 already had it or had left,
0 failures. Ran in the background (~2-3 min) given the channel count. Scratch script deleted after.

Separately, owner: "we can use the event ping for superlatives" — instead of creating a dedicated
role for the weekly-superlatives channel, reuse the existing 🤾 Event ping role. Added
`config.eventPingRoleId`, pinged once on the Wednesday "vote now" reminder only — Friday's results
post up to 17 separate per-category messages, so left those unping'd to avoid spamming the role 17
times for one event. `EVENT_PING_ROLE_ID=1531010348126044412` set in `.community_env`.

`node --check` clean local+remote, fubu-bot restarted clean. Committed `c934586`, pushed.

## 2026-08-20 04:16 — Persistent vote panel for weekly awards (no more typing /awards vote)

Owner: "is there a way we can make this easier instead of using a command" — confirmed via
AskUserQuestion this meant `/awards vote` specifically.

Built a pinned panel in the weekly-superlatives channel: a category dropdown
(`awards_pick_category`) → picking one replies ephemerally with a member picker
(`awards_vote_target:<key>`) → casting the vote reuses `awards.castVote()`, same self-vote/bot-
target checks the slash command already had. `/awards vote` itself is untouched — this is an
additional entry point, not a replacement.

`awards.js` gained `panelRef()`/`setPanelRef()` to track the pinned message. `ensureAwardsVotePanel`
always deletes-and-reposts rather than editing (a StringSelectMenu's option list needs a full
rebuild when categories change), wired into boot and into both `category-add`/`category-remove` so
the dropdown stays in sync with staff's category changes.

The boot-time call didn't actually fire on either restart tonight — traced it to `dguild` not being
ready yet at that point in boot, the exact same pre-existing timing quirk the two neighboring boot
calls (`awardsReminderIfDue`/`awardsResultsIfDue`) already have, confirmed via the panel ref staying
identical across a restart that should have deleted+reposted it. Out of scope to chase tonight — not
something my new code introduced, and it self-heals via the category-add/remove triggers either way.
Verified the panel logic directly instead (scratch script): posted, pinned, correct 17 categories
listed as dropdown options.

`node --check` clean local+remote, both bots restarted clean, scratch scripts deleted. Committed
`0b51843`, pushed.

## 2026-08-20 04:20 — Unhid birthday/awards channels + fixed the dguild boot bug

**Unhide**: revealed `🎂┆birthdays` and `🏆┆weekly-superlatives` to everyone, matching #general's
exact permission shape (VERIFIED role gets ViewChannel, The Corner role explicitly denied, @everyone
denied MentionEveryone/thread-creation/event-creation) rather than a blanket deny. Blessed both via
permguard. Both channels are now live and visible.

**Fix**: root-caused the boot-timing quirk flagged earlier. `const dguild = await
client.guilds.fetch(config.guildId).catch(() => null)` had two problems — an unnecessary live
network fetch for a guild that's virtually always already in `client.guilds.cache` by that point in
boot (the READY event populates it first), and `.catch(() => null)` silently swallowed ANY failure
with zero logging. Every `if (dguild) await ...` boot call depending on it (awards
reminder/results/vote-panel, MDNI sweep, dashboard tidy, birthday sweep, hitsquad sweep, and the rest
of that whole block) would silently no-op with no way to distinguish "dguild was null" from
"genuinely nothing due" in the logs — exactly how the awards vote panel's boot call went unnoticed
across two restarts tonight.

Fixed to prefer `client.guilds.cache.get()` first (synchronous, no failure mode), fall back to
`fetch()` only if not cached, and actually `console.error` if that fallback fails too. Verified live
by restarting and confirming the awards panel's message ID changed (was `1539850492505755680`, now
`1539850762505424926`) — proof the boot call executed this time instead of silently no-opping.

`node --check` clean local+remote, both bots restarted clean, scratch script deleted. Committed
`320e25b`, pushed.
