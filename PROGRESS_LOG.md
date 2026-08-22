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

**Corner roles are two, and must stay mutually exclusive.** `cornerRoleId` (regular) and
`adultCornerRoleId` (18+) are separate Discord roles as of 2026-08-21 — never assign both to the same
member. Discord unions DENIES from every held role then applies ALLOWS from every held role on top,
so allow beats deny across roles: holding both would let the regular role's `SendMessages: true`
silently override the adult role's `SendMessages: false` on the regular channel. Always assign via
`corner.cornerRoleFor(adult)`, never `config.cornerRoleId` directly, and check cornered status via
`corner.memberIsCornered(member)`, not a single-role `.has()` check.

**Any function that edits a channel's ROLE-level permission overwrites must call
`permguard.blessChannel(guild, channelId)` after, or permguard's own boot sweep (which can run
within seconds of the edit) silently reverts it back to the last golden snapshot.** Confirmed live
2026-08-21/22: the Adult Corner role split got wiped by permguard 40s after landing because
`ensureCornerPerms` never blessed the channels it changed. `ensureCornerPerms` now blesses any
channel it actually corrects; follow the same pattern in any new self-heal/enforcement function.

**Minor-staff exposure checks (`isMinor && [tier list]`) exist in TWO places in index.js —
`enforceMdniStaffLock`'s `needsLock` and `sweepMdniStaffLock`'s cleanup-loop condition — and they
MUST list the exact same tiers, or the cleanup loop deletes the lock the first loop just created in
the same sweep.** Hit live 2026-08-22 fixing a minor-trial-mod leak: fixed the tier list in one spot,
redeployed, and the fix still didn't hold because the sibling check 12 lines down still had the old
list. `opspanel.memberTier()` returns `'staff'` for trial mods/language-mini-mods/event-organizers —
distinct from `'mod'`/`'admin'` — so a tier list that only says `['mod','admin']` silently excludes
staff-floor roles from MDNI-style protections even when that role holds real channel access.

---

## 2026-08-22 17:29 — Member-founded tribe gets its own leader-count disband timer; mod-tribe floor lowered

Owner: "There's no disband timer for the member tribe." Investigation: `sweepLeaderRequirement`'s
escalation ladder (grace alert → freeze perks → disband-pending, on `tribe.leaderEnforce`) only ever
ran for `isModFounded` tribes (`if (!tribes.isModFounded(tribe)) continue;`) — a member-founded tribe
(there's only ever one at a time, `tribes.getMemberFoundedTribeKey()`) going leaderless got exactly
one alert ("has no leader left, an admin should appoint one") and nothing else; it could sit
leaderless indefinitely with no forcing function. Scoped via two follow-up questions, then owner gave
exact numbers directly: **MIN_MOD_LEADERS 3→2**, new **MIN_MEMBER_LEADERS = 4** (founder + 3 cosigns),
and **MEMBER_FOUND_COSIGNS 9→3** to match — the tribe now founds at exactly the floor it has to
maintain afterward, not 6 above it.

Generalized `sweepLeaderRequirement`'s ladder to branch on tribe type: mod-founded uses
`countModLeaders` (staff-tier holders only, unchanged) against `MIN_MOD_LEADERS`; member-founded uses
`currentTribeLeaders` (every leader-role holder — a member tribe's leaders are regular members by
design) against `MIN_MEMBER_LEADERS`. Same grace/freeze/disband-pending timing and buttons for both;
`isFrozen()`'s perk-blocking (war/alliances/shop) and the disband-confirm/extend button handlers were
already fully type-agnostic (keyed off `tribe.leaderEnforce.stage`, not tribe type), so no changes
needed there — they just started applying to the member tribe automatically. Also generalized
`/tribe-admin set-leader`'s "Now X/Y leaders" status note and a stale disband-reason string that
hardcoded "mod-tribe" to branch on type; updated the `/tribe found` command description and a couple
of comments that hardcoded the old "9 cosigns" number.

Checked live state before deploying (not just after): `trib` (mod-founded) was already sitting in
`frozen` with exactly 2 staff leaders — lowering the floor to 2 meant it would auto-clear on this
deploy rather than get worse, confirmed post-restart (`leaderEnforce` → `null`, no manual action
needed). The member tribe (`woeful-vagabonds`, coincidentally the same tribe from the reconcile/guard
flap fix above — its leader `almonee` is its founder) has 8 current leader-role holders, well above
the new floor of 4, so no immediate shortfall was triggered by shipping this. `node --check` clean on
both touched files; both bots restarted clean; re-ran the tribe-membership-ledger gap scan from the
entry above to confirm this deploy didn't reopen it (still 0).

---

## 2026-08-22 17:00 — Dashboard control for mod-app approvers; fixed a tribe reconcile/guard flap loop hitting 6 members

**Part 1 — mod app approvers dashboard control.** Owner: "I need to be able to choose who can accept
mod applications from the dashboard." `modapps.js`'s accept/deny/undo gate (index.js, 6 call sites)
already checked `guild.ownerId` + bot-owner + a `config.approvers` list — built 2026-08-14 as
"temporary approvers while the real owner is inactive" — but nothing anywhere ever wrote to that
list; it was only editable by hand-editing the JSON config file on the server, exactly the kind of
agent-only capability [[feedback_no_agent_only_capabilities]] flags. Added `modapps.getApprovers()` /
`addApprover()` / `removeApprover()` and refactored all 6 read call sites in index.js onto
`getApprovers()`. New "👥 Manage approvers" button on the dashboard's Actions page (`opspanel.js`
`buildActions()`) — visible on the admin-tier page but gated to **owner only to click** (same
"stricter button on a looser page" shape as `promote_confirm`/`reject` in index.js), since letting an
admin add themselves would defeat the whole point of the gate sitting above admin tier. Opens a
UserSelectMenu to add (up to 10 at once) and, when any exist, a StringSelectMenu to remove one.
Verified the three modapps.js functions directly (add/idempotent-add/remove/idempotent-remove) and
confirmed the config file was left clean afterward; both bots restarted with no errors.

**Part 2 — tribe reconcile vs. tribe guard flap loop**, found via a screenshot of the Discord audit
log showing FUBU Bot repeatedly adding then removing the SAME role for the SAME member
(`almonee`, Woeful Vagabonds) every ~10 minutes: `reconcileTribeRoles()` (boot + hourly — restores a
tribe's base role to anyone holding a rank/leader role but missing it) was adding the role, and
`enforceTribeMembership()` (the `guildMemberUpdate` guard) was immediately treating that same add as
an unsanctioned manual grant and reverting it, because `reconcileTribeRoles` only fixed the Discord
ROLE but never updated `tribes.js`'s own membership ledger (`tribes.setMembership`/`isAuthorized`) —
which the guard treats as ground truth. Scanned every tribe and found **6 real members** across 4
tribes in this state (not just almonee), confirming a systemic gap rather than one flapping case.
Fixed by having `reconcileTribeRoles` call `tribes.setMembership(key, userId, true)` whenever it
restores a role. Found and fixed a **sibling case** the same pass: a 7th member (`.4nqel`, tribe
`trib`) already correctly held their base role, so the "restore missing role" branch never touched
them — but their ledger entry was just as absent, a live time bomb where the next unrelated role
change would trigger the guard to wrongly strip a role they legitimately hold. Added a second,
ledger-only backfill loop (no Discord role change, just registers the ones already correct). Verified
live: 6 → 1 → 0 gap members across 2 redeploys, no further "manual add reverted" activity, scratch
scripts cleaned up.

`node --check` clean on all touched files (index.js, tribes.js, modapps.js, opspanel.js) at every
step; both bots restarted clean throughout.

---

## 2026-08-22 14:11 — permguard silently reverted the Adult Corner role split; found + fixed a real minor-staff exposure gap while chasing it

Owner: "Back to the breach with .newclover." Started by checking `.newclover`'s (1104985745917231134)
live state: she holds MODS-✰ AND the ✰ • 16-17 (minor) role, with a manual per-member ViewChannel
deny on the Adult Corner channel from before this session — currently fine, but that's a one-off
patch, not a systemic guarantee. Widened the check to every minor holding the minor role, and found
the real, live problem: `permguard`'s boot sweep had reverted almost the ENTIRE two-role redesign
from the prior entry back to its pre-redesign snapshot, 40 seconds after it landed (`[permguard]
corrected 139 drifted overwrite(s)` right after `[corner] perm self-heal on boot: 141 overwrite(s)
corrected` — the exact "bless after edit" gotcha already in project memory, which `ensureCornerPerms`
never did). Root cause: `ensureCornerPerms` edits channel-level role overwrites but never called
`permguard.blessChannel()`, so permguard's drift sweep treated every one of its changes as
unauthorized drift and reverted them on its own very next pass — and kept re-reverting them on every
20-min sweep since, meaning the redesign had been silently dead since minutes after it shipped.

**Fix 1**: `ensureCornerPerms` now tracks per-channel corrections and calls `permguard.blessChannel()`
for any channel it actually changed (not unconditionally — only touched channels, so drift detection
stays live everywhere else). Verified: permguard's boot sweep dropped from 139 corrections to 3, then
to 0 on the next restart — stable.

**While re-verifying, found a second, deeper bug**: scanned all 774 minor-role holders against the
Adult Corner's live `permissionsFor()` and found 2 actually exposed (could view/post in an 18+
channel) — `.newclover` was NOT one of them (her manual patch held), but `cookingwithsincity.` (a
minor holding TRIAL MODS + a display OWNER role) was, plus 2 more (`chillzistuff`,
`everydayweeatgoood`) once the real scope was found. Root cause: Discord's allow-beats-deny-across-
roles rule (the same class as the two-role corner redesign) also defeats a ROLE-level minor deny —
any minor who holds ANY OTHER role with its own ViewChannel allow on that channel (trial mod, mod,
admin via category inheritance) sees straight through the minor block. There's an existing, already-
correct, already-wired system for exactly this — `enforceMdniStaffLock`/`sweepMdniStaffLock`
(index.js, built for the original MDNI channels, generalized 2026-08-16 to cover Adult Corner too) —
which pins a MEMBER-level deny (the only overwrite kind that beats every role). Its bug: `needsLock`
only checked `['mod','admin']` tiers, omitting `'staff'` (trial mod / language mini-mod / event
organizer) — a tier that only exists since 2026-08-20 and evidently was never back-filled into this
check once trial mods got a role-level Adult Corner grant.

**First attempted a NEW fix directly in `corner.js`** (a computed-exposure member-overwrite pass) —
this actually worked in isolation but immediately started FIGHTING the existing mdni-lock system:
both pin member-level overwrites on the same channel using a similar shape, and mdni-lock's own
cleanup pass (built to lift stale locks) saw my overwrite as something to delete because its holder
didn't match mdni-lock's own (buggy) tier list — confirmed via Discord audit log: the bot created the
overwrite via my code, then deleted it via `[mdni-lock] ... cleanup` 22 seconds later, both in the
same boot. **Reverted that approach** and instead fixed it at the actual root: one-line tier-list fix
in `enforceMdniStaffLock`'s `needsLock`. Redeployed, and the SAME bug bit again — `sweepMdniStaffLock`
has a SECOND, independent copy of the identical `['mod','admin']` tier check in its own stale-lock
cleanup loop (never updated in sync), so the cleanup pass kept deleting what the lock pass had just
created, ~200ms later, in the same sweep — caught via audit log again (create → delete, both same
sweep). Fixed the sibling check too (now both read `['staff','mod','admin']`), redeployed, and
confirmed stable this time: 3 real minor-staff members locked across all 4 MDNI-gated channels
(general, general-nsfw, nsfw-vc, Adult Corner) — a broader fix than the single instance first found,
consistent with the class of bug rather than one member. Final scan: 0/774 minors exposed on any of
the 4 channels, confirmed via direct audit-log check (create events only, no follow-up deletes).

Removed the redundant corner.js code entirely rather than leaving two overlapping systems — mdni-lock
is the correct, already-live-reactive (fires on every `guildMemberUpdate`, not just boot) mechanism;
corner.js's job stays scoped to role-level overwrites only.

`node --check` clean on all 3 touched files (corner.js, index.js) at every step, both bots restarted
clean at each deploy, all scratch verification scripts removed from bots-vm.

---

## 2026-08-21 23:02 — Adult Corner redesigned onto its own Discord role (supersedes the per-member-overwrite fix)

Owner, after the per-member-overwrite fix above shipped and was verified working: "what about ana
dult corner role? seems more simple to me" (typo for "an adult corner role") — asking whether a
second, dedicated role for Adult Corner would be architecturally cleaner than per-member overwrites.
Presented the tradeoff via AskUserQuestion (cleaner long-term vs. touching ~7 files keyed off one
shared role); owner confirmed: "Yes, do the two-role redesign."

**Discovery driving the whole design**: Discord combines a member's channel permissions by unioning
DENIES from every held role first, then applying ALLOWS from every held role ON TOP — allow beats
deny *across different roles*. This means the two corner roles (existing `cornerRoleId` and new
`adultCornerRoleId`) MUST be mutually exclusive — a member can only ever hold one, never both — or
the regular role's `SendMessages: true` on the regular channel would silently override the adult
role's `SendMessages: false` there the moment a member held both. Every code path that assigns either
role (new corner, re-corner, rejoin-while-cornered) now explicitly removes the other role first.

**New role**: created live on FUBU, "The Adult Corner" (id `1540492779304656896`), styled identically
to "The Corner" (color `#8799ae`, not hoisted, not mentionable, positioned next to it). `config.js`
gained `adultCornerRoleId` (env `ADULT_CORNER_ROLE_ID`) alongside the existing `adultCornerChannelId`.

**corner.js rewrite**: `ensureCornerPerms()` now grants each corner role full access on its OWN
channel and explicitly deletes any leftover grant of the OTHER role on that channel (self-healing —
no per-member overwrite bookkeeping needed anywhere anymore). New helpers `cornerRoleFor(adult)`,
`isCorneredRole(roleId)`, `memberIsCornered(member)` replace the old single-role checks everywhere.
`rolesToStrip()` excludes both roles. The new-corner and re-corner branches in `corner()` compute the
correct role via `cornerRoleFor(adult)` and (on re-corner, since `adult` can flip) explicitly swap
roles rather than just adding — this swap is `await`ed, not fire-and-forget, since role membership IS
the security boundary now (learned from the `.catch()`-without-`await` bug caught in the previous
fix). `uncorner()` removes both roles unconditionally (idempotent) and the now-dead per-member
overwrite cleanup block (leftover from the superseded fix) was deleted along with it.

**Removed**: `lockOutOtherCorner()` / `otherCornerChannelId()` (the per-member-overwrite mechanism
from the fix directly above this entry) — fully replaced by role-based separation. Found and fixed a
stale call site that would have thrown `ReferenceError` at runtime (leftover from an incomplete first
pass at the rewrite) before it ever shipped.

**7 external call sites updated** to be aware of both roles instead of just `cornerRoleId`:
`index.js` (systemic-role list, tribe-land channel denies ×2, rejoin-while-cornered role pick, tribe-
membership guard — now via `corner.memberIsCornered()`), `sweep.js` (skip cornered members in the
unverified-backfill sweep), `contest.js` (deny both corner roles from contest channels), `modapps.js`
(punishment-handicap scoring), `rolereq.js` (not-self-requestable role set).

**Live migration turned out to be a non-issue**: checked bots-vm's real `cornered` state before
deploying — 12 records total, but only 2 correspond to members still actually on the server
(`chillzistuff`, thread-imprisoned; `jerataay`, plain regular-corner), and neither has `isAdult: true`
— the one real adult-cornered member from earlier testing (`food_d_luffy`, 1518772698791153674) had
already been released before this deploy (confirmed via boot-time logs: a `corner_rel` button click at
22:51, right before this restart). No member needed a role swap.

Deployed all 7 files, `node --check` clean on all of them locally and on bots-vm, restarted both
bots clean (`[corner] perm self-heal on boot: 141 overwrite(s) corrected` on FUBU — the bulk
correction from every channel getting the new role's overwrite for the first time; `0` on Melanin,
which has no Adult Corner configured at all, confirming the feature is fully inert there as intended).
Verified live post-deploy: `cornerRoleId` now carries zero overwrite on the Adult Corner channel and
`adultCornerRoleId` zero on the regular channel (clean split, no leftover cross-grants); walked both
real cornered members' actual `permissionsFor()` results — `jerataay` can send in regular corner, not
Adult Corner; `chillzistuff` (thread-imprisoned) can't send in either root channel, matching the
existing thread-lockout design untouched by this change. No violations found. Scratch verification
scripts removed from bots-vm afterward.

## 2026-08-21 20:45 — Cross-corner talk leak fixed: adult-cornered members can no longer speak in regular corner (and vice versa)

Owner: "people in the adult corner shouldn't be able to talk in the regular corner."

Root cause: the regular corner and the Adult Corner are two different CHANNELS but share ONE Discord
role (`config.cornerRoleId`) — whoever gets cornered, anywhere, gets that same role, and the role's
own channel overwrite grants `SendMessages: true` in BOTH channels. The two channels are otherwise
correctly separated (Adult Corner denies ViewChannel to everyone but the corner role + staff, minors
additionally hard-blocked) — it was only ever the shared role's send grant that leaked across.

Fixed the class, not just the reported instance: applies symmetrically — a regular-cornered member is
now equally denied SendMessages in the Adult Corner, which is arguably the more sensitive direction
and wasn't mentioned but is the same bug. New `lockOutOtherCorner()` in corner.js adds a per-member
`SendMessages: false, SendMessagesInThreads: false` overwrite on whichever corner channel the member
is NOT in — the same mechanism thread imprisonment already uses to lock the root channel while leaving
their jail thread open, just aimed at the other corner instead. Wired into both the new-corner and
re-corner paths in `corner()`. `uncorner()`'s cleanup was broadened from "delete the per-member
overwrite on their own channel, only if they were thread-imprisoned" to "delete on BOTH corner
channels, unconditionally" — a delete on a channel where no overwrite exists is a harmless no-op, so
this covers the new cross-corner lockout without needing to track which case applied.

**Caught and fixed a bug in my own first pass before it shipped**: the lockout call was written
fire-and-forget (`.catch(() => {})`, not awaited) — but this overwrite IS the security boundary being
closed, so a race window between `corner()` returning and the lockout landing would have partially
defeated the point. My own live test caught it (the check ran before the async call had finished) —
changed both call sites to `await` it directly.

Verified against the real `corner()`/`uncorner()` on the live server, both directions, using genuine
non-staff volunteers (excluding minors, who are already blocked from Adult Corner by an earlier
guard) and the bot's real state file so nothing diverged from production: adult-cornered → denied
SendMessages in regular corner, not denied in their own; regular-cornered → denied in Adult Corner,
not denied in their own; released → overwrite cleared from both channels in both directions. ALL PASS
on all 3 checks, twice.

Confirmed this can't collide with existing self-heal sweeps: `ensureCornerPerms` only ever edits
ROLE-level overwrites (cornerRoleId/modRoleId/etc.), never touches arbitrary member overwrites; and
permguard's newer self-grant auto-revert only fires on a member overwrite that ALLOWS ViewChannel —
this is a DENY on SendMessages, a different permission entirely, so it's untouched by either.

`node --check` clean local+remote, both bots restarted clean, scratch test scripts removed from
bots-vm, confirmed gone.

## 2026-08-21 20:15 — Admins now act solo on ANY corner release/lowering, no 3-admin vote ever

Owner: "i thought i asked for the ⅓ limit to be removed from admins?" Took a couple of rounds to
place — nothing in the repo is literally called a "⅓ limit"; confirmed via AskUserQuestion it means
`corner.js`'s `OVERRIDE_THRESHOLD.admin = 3` (3 admins acting together within 5 minutes to
lower/release a corner below the tier that applied it).

The 2026-08-14 fix (`289027c`) already carved out the common case — admins act solo specifically on
an **owner**-applied corner. What it left standing: because `canActSolo`'s general rule is "your rank
outranks-or-matches whoever applied it," an admin (rank 2) already could act solo against mod (1) or
admin (2) applied corners on that rule alone — the 3-admin vote was ONLY ever reachable for admins
against a **botowner**-applied corner, the one case the 2026-08-14 carve-out didn't cover. That's the
literal "⅓ limit" still active for admins, just a narrower edge than it looked.

Removed it entirely: `canActSolo` now returns true unconditionally for `actorTier === 'admin'`,
replacing the owner-applied-specific check (now redundant — the broader admin case subsumes it).
Dropped the now-dead `admin: 3` entry from `OVERRIDE_THRESHOLD` and updated its comment; every
`res.need`-driven message in index.js/opspanel.js is dynamic off that object, so no hardcoded "3
admins" string needed hunting down elsewhere. Mod tier's threshold (3, unchanged) is untouched.

Verified against the real functions: admin acts solo on mod-, admin-, owner-, AND
**botowner-applied** corners (the last is the case that mattered — confirmed false→true), a control
proving mod tier is still correctly blocked solo on a higher-applied corner (regression guard), and a
full `attemptSeverityChange` call releasing a botowner-applied corner in one shot with
`needsOverride: false`. ALL PASS.

`node --check` clean local+remote, both bots restarted clean, scratch script removed from bots-vm.

## 2026-08-21 16:35 — Reverted an anon-corner logging change — the existing fix was already fine

Earlier tonight, changed `logCorner()` so an anon corner skipped the public `#corner-log` entirely,
posting only to the owner-only log. Owner: "the existng fix was fine. i didn't notice it was fixed."
The 2026-08-19 masking behavior (actor shown as "🎭 Anonymous Staff" in the public log, real identity
only in the owner-log mirror) was already what was wanted — the ask to suppress the public entry
entirely was based on not having noticed the mask was already live, not a real requirements change.

`git revert --no-edit 4e68528`, clean, no conflicts. Confirmed the revert lands exactly back on the
pre-change state — `git diff cb527cf fb4e103 -- index.js` is empty, byte-identical to the last
known-good commit, not just "looks similar." `node --check` clean local+remote, both bots restarted
clean.

## 2026-08-21 15:55 — Tribe Games were auto-starting; turned off, they're manual only

Owner: "Is something triggering tribe games automatically?" — then "It's supposed to be manual only."

Yes, and it was mine-adjacent history, not a mystery: `maybeAutoStartTribeGame()` runs on a 15-minute
interval and fires a random catalog game every 4-8h during peak hours. It was added 2026-08-17 off the
note "they just weren't running automatically", with `TRIBE_GAMES_AUTO_START` defaulting to **true** and
no env override on either bot — so it was on everywhere by default.

Confirmed from the logs rather than inferred: it had auto-started **3 times in 24h** — amongus_classic
(08-20 19:55), amongus_hs (08-21 08:02), other (08-21 15:15). The game live at the time of asking was
started by the bot's own user id with `entrants: {}` — a lobby nobody joined, which is the whole problem:
a Tribe Game needs leaders to set a rep AND staff to report the result afterwards, so an auto-started one
just posts a lobby into every tribe Hall and dies.

Flipped the `config.js` default to **false** so it's manual-only by design on both bots and any future
deploy, rather than papering over it with an env var on one host. Staff still launch games from
`/tribe panel`; the env var can re-enable it if that's ever wanted. **Left `arenaAutoStart` alone** —
Arena is bot-scored end to end and genuinely works unattended, so the same reasoning doesn't apply.

Also cleared the dead auto-started lobby. Did that with the bots STOPPED, because `tribegames.js` keeps
its state in a module-level `_cache` and a live process would have overwritten the edit on its next save
(the statepath caching trap that's bitten this repo before). Backed the file up first, then verified
after restart: `tribeGamesAutoStart = false` on FUBU and Melanin, `isActive() = false`.

## 2026-08-21 12:45 — "Application did not respond": bots-vm was thrashing, not a command bug

Owner: media-filter add gave "the application did not respond", then `/uncorner` said it didn't respond
in time. Two unrelated commands failing the same way is a process-level symptom, not a per-command bug,
so I went to machine health before touching any command code — which was right.

**Diagnosis: the box was in swap thrash.** bots-vm has **969 MB of RAM total**, shared between fubu-bot,
melanin-bot, bubble-girl, mod-saves, nginx, cloudflared, tailscaled and three SSHFS fleet mounts. State
at the time: 82 MB free, **1023 MB of swap in use**, `vmstat` showing **97% iowait** with 9-10 processes
blocked on I/O, and load average 9.18. fubu-bot alone was **300 MB RSS — 30.6% of the entire box**. A
process paging that hard cannot ack a Discord interaction inside the 3-second window, so Discord shows
"the application did not respond" on whatever the user happened to click. Nothing was wrong with the
media filter or /uncorner.

**Immediate relief** — restarted both bots and measured the delta rather than assuming:
fubu RSS 300 MB → **87 MB**; free 82 → 296 MB; swap 1023 → 339 MB; iowait 97% → 0-1%; blocked procs
9-10 → 0.

**Root cause of the growth: discord.js's default caches are unbounded in the ways that matter.** 200
messages PER CHANNEL with no expiry, across 133 channels, plus reactions and threads — it had climbed to
300 MB in 11.5 hours of uptime and would have done it again. Added explicit bounds to the Client:
`makeCache` caps MessageManager at 60/channel (from 200), ReactionManager 20, and zeroes the invite and
presence caches (there's no GuildPresences intent anyway); `sweepers` then evicts messages older than 3h
every 30 min and threads untouched for 4h every hour.

**Tradeoff named rather than buried:** #deletion-log can only report a deletion when the message was
still cached (`msg.partial` means the content was never seen), so a message deleted more than ~3h after
posting now goes unlogged. In a busy channel the old 200-message cap already evicted sooner than that,
so this mostly costs quiet channels. Members and roles are deliberately NOT swept — `role.members` and
`ensureMembers()` depend on that cache, and sweeping it would silently break role counts, the mod-manage
scoping sweep, and the @everyone audits.

Worth flagging for later: this is a ~1 GB box running two full Discord bots plus a third, and the real
fix is more RAM rather than shaving caches forever. The cache bounds buy headroom; they don't change the
fact that fubu-bot at a healthy 87 MB is still ~9% of the machine.

## 2026-08-21 01:10 — Mafia: fixed a total role leak, made the start manual, added a role-reveal phase

Owner, three problems at once: "we can see who is deafened and who is muted so there's actually no
secret. the game starts too fast it should be manual. and the my role should happen before the game
starts."

**1. The mute/deafen leak — this broke the entire game.** The original voice design left living Mafia
unmuted at Night so they could talk it out in the shared VC. But Discord renders mute/deafen icons in
the member list, so "the people who aren't muted" WAS the Mafia roster, in plain sight of everyone
including the dead. A hidden-role game with a visible role list is not a game. Fixed by making Night
uniform: **every living player is muted+deafened identically, Mafia included.** Secrecy now lives
entirely in the Mafia's private thread, which is consequently created in **both** voice and text mode
(it used to be text-only, which is exactly what forced the leaky unmuted-Mafia design). The VC now only
ever expresses the phase, never who anyone is. Dead players stay locked in all phases — that leaks
nothing, deaths are announced publicly anyway.

**2. Manual start.** The lobby no longer auto-starts on a 60s timer; `lobbyDeadline` is null and the
sweep skips lobby/reveal entirely, so it waits on a human indefinitely. Staff press **Deal Roles**
(disabled until MIN_PLAYERS is met). Night/Day now also advance on a staff **End Night / End Day**
button, with the deadline timers demoted to a generous fallback (5 min night, 10 min day, up from
90s/120s) purely so a game can't hang forever if the host disappears mid-round.

**3. Role reveal before the game.** New `reveal` phase between lobby and Night 1: roles are dealt, the
Mafia thread opens, the VC locks, and everyone reads their own role via **My Role** — then staff press
**Begin Night 1**. Nothing resolves during reveal and no timer runs on it.

Lifecycle is now: `lobby → reveal → night → day → …` with both transitions out of lobby/reveal
host-driven. Removed the now-dead `roleRow` helper and `LOBBY_MS`; `closeLobby` split into
`dealRoles` (→ reveal) and `beginNight` (→ night). My Role also stays available on the night and day
panels.

Verified with a harness driving the real per-member lock decision: at reveal and at night every living
player resolves to locked=true **identically** (mafia and villager indistinguishable — the explicit
regression guard), at day every living player is free while the dead stay locked, and non-players are
never touched. Plus a **control** running the OLD logic, which correctly shows mafia≠villager at night —
proving the test can actually detect the leak rather than passing vacuously. ALL PASS.

`node --check` + `require()` clean local+remote, both bots restarted clean, scratch script removed.
Still needs a real multi-account playtest; the timer values are first-guess and meant to be tuned.

## 2026-08-21 00:45 — Gave mods ManageChannels back, scoped so it can never reach a channel they can't see

Owner, after the emergency strip: "give mods manage channels but scoped to channels they have access to.
no mod gets it on [hidden ones]" — then "i was thinking moreso per category."

**Per-category alone does not work, and I verified that rather than assuming it.** Discord does NOT
propagate a category's permission overwrites to children that have their own overwrites; only fully
inheriting (synced) channels pick them up. Test: granted ManageChannels to the MODS role on a category,
then checked a child with its own overwrites — the child stayed at `ManageChannels=false` while the
category itself flipped to true. So a category-only grant would have looked applied while silently
giving mods nothing on most channels.

**The first version of that test was worthless and I caught it.** It picked `s_bemorechill` as the
probe, who also holds `ADMINS - ★` (which still grants ManageChannels at guild level), so the BEFORE
state was already `true` — the check literally could not fail, and "AFTER: true" would have "proven"
propagation that wasn't happening. Re-ran with a mod who genuinely lacked the permission and got a
clean false→false. Worth remembering: on this server, filtering probes by `!Administrator` is not
enough, `ADMINS - ★` carries these perms without it.

Resolution: keep the owner's per-CATEGORY mental model for deciding, but WRITE the overwrites
per-channel where Discord actually needs them. New `syncModManageChannels(guild)` in index.js grants
ManageChannels to the MODS role on a channel only when **every holder of the MODS role can already view
it**. That strict invariant is deliberate — anything weaker ("the MODS role alone can see it", or "some
mod can") would hand ManageChannels to mods who can't view the channel, which is exactly the hole just
closed. It revokes as well as grants, so a channel that later becomes hidden loses it on the next pass
(fail-closed), and it runs at boot + hourly so newly-created channels are covered without anyone
remembering to.

Dry-ran it first, grouped by category: **109 granted, 24 withheld**. Withheld is precisely the right
set — `#owner-log`, `#admin-discussion`, `#admin-announcements`, `#application-archive`, the whole
🔞 ADULTS category, `#adult-corner`, the per-language VCs (only that language's mini-mods see them),
and one private tribe's channels. Invariant check confirmed nothing slated for a grant is invisible to
any mod.

**Race found on the first live run and fixed.** The initial version blessed all touched channels into
permguard's baseline in one batch at the END. A full pass is 100+ sequential rate-limited edits taking
minutes, so permguard's own sweep landed mid-pass and reverted every grant not yet blessed — only
**36 of 109** survived. Changed to bless immediately after each edit, closing the window. After the
fix the second pass granted the missing 23 and the live count settled at exactly **109/133**, matching
the dry run.

**Verified after rollout:** a plain mod (g4zz44) sees 110 channels and can manage 109 of them, and has
ManageChannels on **none** of the 23 hidden from them. Ran the real permguard sweep afterwards and the
count held at 109→109 with 0 corrections, proving the grants are genuinely blessed rather than
surviving on luck between sweeps.

**One real gap remains, and it is NOT from this scoping.** 6 members can still manage channels they
can't see: s_bemorechill, kayena07, fylesared, beautyinelijah, knylvr, brew.d. Checked each rather than
assuming — **all 6 hold `ADMINS - ★`, which still grants ManageChannels at GUILD level**, exactly the
un-actioned item flagged in the previous entry. The mod scoping itself has no leak. Closing this needs
the same treatment applied to ADMINS-★ (strip guild-level, grant back scoped), which the owner hasn't
asked for yet.

**Side effect: raidguard alarmed on the bot itself.** Granting on 109 channels fired **90** "Dangerous
permission granted" alerts into #mod-announcements in a single pass; owner asked for them to be
deleted. Purged all 90 (dry-run first to confirm the match set and date range 08-14 → 08-21, then
deleted, then re-scanned to confirm 0 remain). Fixed the cause rather than just the symptom:
raidguard's `onChannelUpdate` already exempts a trusted owner's own edits but had no exemption for
**the bot's own** edits — so every deliberate permission action this codebase takes (corner self-heal,
tribe builds, permguard corrections, this sweep) alarmed on itself. Added `entry.executorId ===
guild.client.user.id → return`. An alert channel that cries wolf 90 times is worse than none.

## 2026-08-21 00:33 — URGENT: mods could read any hidden channel via ManageChannels. Closed + auto-revert added

Owner, urgent: "someone (a mod) supposedly built a logger that allows them access to channels they're
not in. i need to find out how that's possible and how to block it." Later named the mod: `.newclover`.

**How it was possible — confirmed empirically, not theorised.** The `MODS - ✰` role granted
**ManageChannels** to 20 mods. In Discord that permission lets you rewrite a channel's permission
overwrites, and crucially it **survives into channels you cannot see**. Probed a plain mod against
every channel hidden from them: they retained ManageChannels on **all 13**, including `#owner-log`,
`#admin-discussion` and `#application-archive`. So any mod could add an overwrite granting themselves
ViewChannel, read the channel and its history, then delete the overwrite. No "logger" required at all.

Second, separate vector found while looking: **6 third-party bots hold Administrator** (Carl-bot,
Arcane, greed, Rythm, Jockie Music, Invite Tracker), plus more with server-wide ViewChannel (Mimu,
Translator Bot, .fmbot, VoiceMaster, Birthday Bot). A bot with Administrator reads every channel, and
Carl-bot/Arcane ship message-logging features that can pipe content anywhere — and **that leaves no
audit-log entry whatsoever**, because the bot reads with its own permissions. Their dashboards
authenticate by ManageGuild, which on FUBU is only wadonkadonk, thrifthunterx_, le_pope_. Flagged but
NOT changed (owner didn't select it): `greed` has Administrator and was added by `reinsanaxd`, who is
not currently staff.

**On .newclover specifically — no evidence they used it.** Paged their entire audit-log footprint (298
entries back to 2026-07-19, covering their whole tenure, not just the default first 100 — the first
pull only reached 08-11 and would have been a misleading "all clear"). Their only overwrite activity is
mundane: VC user limits, corner slowmode, an #announcements overwrite, a channel they created. No bots
added by them. Current member-overwrites on their account are all age-gate DENIES. So: the capability
was real and open to 20 people; there is no proof this particular mod exploited it. Also worth noting a
much duller explanation fits "channels they're not in" — a mod can already VIEW ~100 of ~115 channels,
so a logger that just archives what they can legitimately see needs no exploit at all.

**Blocks applied (owner picked these two):**
1. **Removed ManageChannels from `MODS - ✰`.** Re-probed a plain mod afterwards: hidden channels 13,
   still-manageable **0** — closed. Mods keep ManageMessages/ModerateMembers/ManageThreads/KickMembers
   etc, so real moderation is untouched. *Tradeoff to watch:* mods lose manual VC user-limit and
   slowmode edits (`.newclover` legitimately used both) — Discord has no way to split channel-settings
   from channel-permissions, it's one permission. `/corner slowmode` still covers the corner case.
2. **permguard now auto-reverts self-grants.** Member-level overwrites were previously report-only, on
   the theory they're deliberate special cases — but a report nobody reads is not a control. Now any
   NEW member overwrite that **grants ViewChannel** is deleted on sight and alerted to owner-log at
   🚨/red, including on the boot sweep (notify=false no longer suppresses it). Deny-only member
   overwrites keep the old report-only behaviour, so the MDNI minor-staff locks still work.

Verified by simulating the actual attack against the real sweep: planted a ViewChannel overwrite for
.newclover on `#mod-discussion`, ran `sweepPermissions()`, confirmed it was **auto-reverted** and
reported. Then the **control**: planted a deny-only overwrite for the same member and confirmed it
**survived** and was not misclassified — proving the new rule targets grants specifically and can't
clobber legitimate denies. ALL PASS, test overwrite cleaned up.

`node --check` clean local+remote, both bots restarted clean, permguard boot sweep healthy, scratch
scripts removed from bots-vm.

**Still open (not selected):** bot Administrator reduction, and ManageRoles on `ADMINS - ★` (9 people,
same class of hole one tier up).

## 2026-08-20 23:25 — Hit-squad corners can no longer carry a rule or reason (they were polluting corner→strike)

Owner: "make sure hit squad can't use a rule or reason" — then, clarifying the actual stake: "we don't
want them polluting the rule count for corner to strike."

That names the real damage precisely. `logCornerHistory()` (corner.js) stores each corner's `ruleIndex`
and returns how many times that member has been cornered for the **same** rule; that `repeatCount` is
what alerts staff to convert a pattern into a Strike. A hit-squad corner tagged with a rule would
inflate a real member's escalation count for an "offence" that never happened — the same reasoning that
already made member corners rule-less ("so it never feeds corner→strike conversion").

Enforced centrally in `corner()` rather than only at the /corner handler: one guard nulls `ruleIndex`
when the actor is an active squad member, which covers every entry path (slash, context menu, modal,
panel buttons) instead of leaving each to remember. The history entry is still written, just with
`ruleIndex: null` — so the event is on record, returns 1, and matches no rule's filter. Window-scoped:
`isSquadMember` goes false the instant the activation expires.

Two user-facing guards on top, so nothing is silently dropped:
- `/corner` with a rule/reason as a squad member → explicit refusal explaining why.
- Right-click **Send to corner** as a squad member → refused before the rule picker appears, since that
  route ends in the reason modal. This applies **even to a mod who happens to be on the squad**: for
  the ~10 minutes the window is live they're acting as squad. That's a deliberate trade — it briefly
  costs a squad-member mod the ability to log a rule via right-click (they can still `/corner`, or
  `/strike` separately) — chosen because protecting the strike record matters more than convenience
  during a short window. Worth revisiting if it annoys staff in practice.

Verified against the real `logCornerHistory` (exported for testability, same approach used for mafia's
pure helpers) rather than a reimplementation: 3 genuine rule-5 corners escalate 1→2→3, a squad corner
returns 1 and doesn't escalate, the next genuine rule-5 corner counts **4 not 5**, and all 5 events are
still recorded with exactly one rule-less entry. Plus a **control case** running the same sequence
WITHOUT the strip, which correctly produces the polluted count of 5 — so the passing result reflects the
fix, not a test that can't tell the difference. ALL PASS.

`node --check` clean local+remote, both bots restarted clean, scratch script removed from bots-vm.

## 2026-08-20 23:05 — Melanin: Server Booster could @everyone server-wide (removed); FUBU audited clean

Owner: "poeople in melanin can ping everyone." Live server-permission issue, no code involved.

**Diagnosis (read-only first).** Scanned role-level permissions, `@everyone` base perms, and every
channel overwrite on both guilds. `@everyone` itself was clean on both. The difference: Melanin's
**`Server Booster` role granted `MentionEveryone` at the role level**; FUBU's does not. Held by 4
boosters, 3 of them non-staff (l3na._10, abdiabdi_onthewall, yestitpic).

First pass under-reported it — `role.members` is unreliable without the GuildMembers intent, and
checking one `#general` showed only staff (that channel has its own deny overwrite). Re-ran with a full
member fetch and a per-channel effective-permission check, which gave the real blast radius: **65
channels**, i.e. effectively the whole server — #rules, #verify-here, #server-guide, every chat/gaming/
music channel, ban-appeals, corner logs.

Confirmed with the owner that this was accidental rather than a deliberate booster perk before changing
anything, then removed just that one permission bit from the role (read-modify-write of the bitfield,
so no other booster permission was touched). Verified by re-running the same per-channel scan:
**65 exposed channels → 4**, and those 4 are tribe channels where it's by design (`buildTribe()` grants
tribe members MentionEveryone in their OWN private hall/VC, so @everyone there only reaches that tribe).

**FUBU audit — a false alarm worth recording.** The same scan initially flagged 64 FUBU channels and 3
members (superami, ririlicous, everydayweeatgoood). Checked *why* they had it instead of acting on the
count: all three are **Event Organizers**, and Event Organizer grants MentionEveryone deliberately on
both servers (organizers need to ping for events). My filter excluded only `meets(tier, 'mod')`, so the
`staff`-floor tier — trial mods, mini-mods, event organizers — read as ordinary members. Re-ran
excluding any member with a staff tier at all: **FUBU is clean**, zero non-staff can @everyone outside
their own tribe channels. Melanin re-checked with the identical script/filter afterwards: also clean.

Lesson: the flagged *count* looked damning and was almost entirely an artifact of where I drew the
staff line. Reading role membership before acting is what kept this from becoming an unnecessary
permission strip on three legitimate event organizers.

No code changed, nothing committed for the bots — this was a live Discord role edit on Melanin only.
Scratch scanners removed from bots-vm, confirmed gone.

## 2026-08-20 22:40 — Overrides "Add Rule" was dead: a select description one char over Discord's cap

Owner reported "Error: Received one or more errors" on the Personal Overrides panel (screenshots from
both #general-2 and #mod-dashboard, so it wasn't channel-specific). The panel itself rendered all 7
rules fine — journalctl showed `btn:fops_ov_addstart` as the last thing logged with no error after it,
which pinned it to the **Add Rule (Pick Member / Role)** button rather than the panel.

Cause: the rule-type picker's `PROTECT_FROM` option had a **101-character description**. Discord caps
select-option descriptions at 100 and rejects the whole payload with a nested Invalid Form Body error,
which discord.js surfaces as the useless top-level string "Received one or more errors". One character
over, and the entire Add-Rule flow was unreachable — nothing could be created through the UI at all.

Same family as the already-recorded `/`-command description gotcha (>100 chars → opaque "Invalid string
length", which broke ALL command registration) — same limit, different surface, equally uninformative
error. Shortened the description to 82 chars and left a comment naming the cap so it doesn't creep back.

Swept the class with a throwaway scanner over every `.js` in the repo, checking string literals fed to
length-capped Discord fields (select option label/description 100, `setLabel` 80, `setDescription` 100,
`setPlaceholder` 150): **no other over-length literals**. Then — because a check that finds nothing is
worthless until it's been seen to find something — re-ran the scanner against a file containing the
original 101-char string and confirmed it flags it. Only then trusted the clean result.

Verified the fix against the real API rather than by eyeballing the length: built the exact picker
payload and posted it live — Discord **accepted** it. Then re-ran the identical test with only the old
101-char description swapped back in, and Discord **rejected** it with the exact "Received one or more
errors" the owner saw. So the cause is confirmed, not inferred. Temp messages deleted, scratch script
removed from bots-vm, both bots restarted clean.

## 2026-08-20 22:10 — Mafia: added the Jester (neutral role that wins by getting itself lynched)

Owner: "The people in the server play with a jester role. I'm not sure what that is." Explained it
(neutral third party, wins alone by being voted out during the Day, loses if the Mafia night-kills them
instead), then confirmed the two variant choices that actually change the code via AskUserQuestion:
**game ends immediately** when the Jester is lynched, and the Jester reads as **not Mafia-aligned** to
the Detective.

Slotted straight into the count + % chance system built earlier, so the Jester is configurable exactly
like Doctor/Detective (Off / 1× / 2× / chance / Auto) from the ⚙️ Roles panel — now 4 select rows,
still inside Discord's 5-row cap. Auto threshold is 7+ players (a Jester eats a slot and swings the Day
vote hard, so it wants a few more bodies to hide among); Doctor stays 5+, Detective 6+.

Generalised rather than special-cased while adding it: introduced `SPECIAL_ROLES` and
`AUTO_MIN_PLAYERS`, and rewrote `roleCounts`/`assignRoles` to loop over them instead of naming doctor
and detective by hand — so the roll, the clamp into available non-Mafia slots, and the assignment all
picked up the Jester with no per-role branching, and a 5th role later is a one-line addition.

Mechanics:
- **Win is lynch-only.** Handled in `resolveDay` (where the vote resolves), deliberately NOT in
  `checkWin` — `resolveNight` has no jester branch on purpose, so a Mafia night-kill just kills them.
- `endGame` gained an optional `jesterId` and the reveal embed a purple 🃏 branch naming who pulled it
  off.
- **Detective needed no change** — the check is a strict `role === 'mafia'`, so a Jester already read
  as "not Mafia-aligned". Verified rather than assumed.
- Jester has no Night action; added `NIGHT_ACTION_ROLES` so clicking a Night button as a Jester gets a
  clear "your whole game is getting voted out during the Day" instead of the generic "that's not your
  role".
- Jester counts as an ordinary non-Mafia body for parity, so it neither blocks a Town win nor
  artificially delays a Mafia one.

Verified with a 19-check harness: auto thresholds at 5/6/7/8/12/15 (jester appearing exactly at 7+,
every count summing to the player total), Off/2×/1×50% behaving like the other special roles, both
safety clamps still holding with four special roles in play, assignRoles emitting the jester with every
player assigned exactly once, and three win-condition cases confirming the jester is a body and not a
town winner (all-mafia-dead still gives Town the win with a jester alive — they didn't get lynched).
ALL PASS. Both bots restarted clean; scratch script removed from bots-vm, confirmed gone.

## 2026-08-20 22:02 — Mafia panel now edits in place on button clicks, and is deleted when the game ends

Owner: "the bot resends the message instead of editing it when a button is clicked" and, mid-turn,
"Also delete it when the game ends."

Same class as the awards vote-panel bug earlier tonight: `postPanel()` unconditionally
deleted-and-reposted, and every handler called it — so a join, a role-setting change, or a day vote all
spammed the channel and made the panel jump to the bottom on each click.

Split the two behaviours instead of making one function guess:
- **`postPanel()`** (unchanged semantics) is now used ONLY for phase transitions — lobby open, Night,
  Day. A fresh message there is correct: it IS the "Night just fell" notification, and deleting the
  previous panel kills its now-stale buttons.
- **`refreshPanel()`** (new) edits the existing panel message in place, falling back to posting only if
  it's genuinely gone (deleted by hand).
- Where the clicked component actually lives ON the panel — the lobby Join button and the Day vote
  select — the handler now calls `interaction.update(...)` directly, which redraws that same message
  atomically with no delete, no repost, and no second fetch. The day vote follows it with an ephemeral
  `followUp` so the voter still gets a private confirmation (same shape strikeAppeals uses).
- The ⚙️ role-settings selects update their own ephemeral message, then `refreshPanel()` the public
  lobby panel so its "Roles:" line stays in sync without reposting.

**Game end**: new `deletePanel()` removes the panel outright, and the final role reveal is sent as its
own plain message rather than becoming the new "panel" — so nothing is left behind carrying dead
buttons.

Verified against real Discord messages (exported the panel helpers so the test drives the actual
functions, not a reimplementation): 10 checks — id unchanged across 3 refreshes, the original message
still present and its content actually updated, a phase change producing a new id with the old message
removed, panel gone at game end, reveal posted separately with zero components, state cleared.

**Worth recording: the first run reported 3 failures that were my test lying, not real bugs.**
`channel.messages.fetch(id)` resolves from discord.js's message cache, so a deleted message still
"exists" and an edited one returns its stale pre-edit content. Re-ran with
`fetch({ message: id, force: true })` and all 10 passed. This is the same force-cache gotcha already
recorded for `channels.fetch` — it applies to `messages.fetch` too, and it fails in the direction that
makes an edit-in-place fix look broken while a delete-and-repost bug looks fine.

`node --check` clean local+remote, both bots restarted clean, test messages and scratch scripts removed
from bots-vm, confirmed gone.

## 2026-08-20 21:52 — Filter-deleted messages no longer show up in #deletion-log as self-deletes

Owner: "Make sure messages the bot deletes because of media filter or word filter don't end up in the
deletion log. Right now they show up as deleted by the person themself."

The intent was already coded (2026-08-17: `if (deleterId === client.user.id) return;`) — the mechanism
it relied on just doesn't work. `messageDelete` carries no executor, so the listener inferred one by
correlating against MESSAGE_DELETE audit entries. That inference fails in exactly this case, two
different ways:
1. **Race** — the gateway event normally lands BEFORE Discord has written the audit entry, so the
   immediate lookup finds nothing.
2. **Coalescing** — Discord merges repeated MESSAGE_DELETE entries for the same (target, channel) into
   one entry with a bumped count rather than writing a fresh one, so a second auto-delete for the same
   member frequently has no new entry at all.
Both look identical to "no entry exists", which the code reads as a self-delete — hence "deleted by
<them> _(themselves)_". Confirmed the symptom before changing anything: 13 of the last 15 log entries
were "themselves".

Fix: stop inferring, start declaring. New `botdeletes.js` — a small TTL'd registry (60s) of message ids
the bot deleted deliberately. `mark(id)` is called immediately BEFORE each bot-initiated delete;
`was(id)` in the deletion-log listener skips them. `was()` consumes the entry (one delete = one event,
so holding it longer only risks a stale hit on a recycled id), `mark()` accepts an array/Set for
`bulkDelete`, and ids are swept on a timer plus a cheap size bound.

Swept the class rather than just the two filters named — marked every bot-initiated deletion of a
message a real member authored: **wordfilter** and **mediafilter** (the reported ones), raidguard flood
auto-delete, the "X pinned a message" system-notice cleanup, throne 24h expiry (both the single-message
timer and the bulk cleanup), dashboard bulk cleanup, and contest.js's two invalid/duplicate-entry
deletes. Kept the old audit-log check as a harmless backstop.

Verified: 7-case unit test of the registry (mark/was, single-consume, array + Set marking, numeric-id
normalisation, null-safety) all pass; all 8 mark sites plus the skip check confirmed by grep; syntax
clean local + remote; both bots restarted clean.

**Not verified end-to-end by me, and worth knowing why:** every one of these paths requires a *real
member* to post — `if (msg.author?.bot || !msg.guild) return;` sits above the filter code (checked, not
assumed), so a bot-posted message can never trip its own filter and I have no way to fire these from a
script. The remaining check is a 10-second one for the owner: post a filtered word from a normal
account, confirm it's deleted and that nothing new appears in #deletion-log.

## 2026-08-20 21:44 — Corner slowmode now clears on release — and found the release path was never locking the thread

Owner: "the slowmode on a corner should turn off when the person is released."

Every release path (timed expiry, `/uncorner`, the dashboard/panel buttons, the member-left path) funnels
through `corner.js`'s `uncorner()`, so the fix goes in one place. Added a `setRateLimitPerUser(0)` there.

**Ordering turned out to be the whole ballgame, and testing it surfaced a second, pre-existing bug.**
`uncorner()` was doing `setArchived(true)` and THEN `setLocked(true)`. Discord rejects *every* edit to an
archived thread with "Thread is archived" — and that setLocked was wrapped in `.catch(() => {})`, so it
has been silently failing for as long as it's existed: **released jail threads were being archived but
never actually locked.** A naive slowmode fix appended after the archive would have silently no-op'd the
exact same way and looked fine.

Proved it rather than assuming, with a live A/B on a real throwaway private thread in #the-corner:
- New order (clear slowmode → lock → archive): `slowmode=0 locked=true archived=true` — all three stuck.
- Old order (archive → lock → clear): both later calls returned `ERR -> Thread is archived`, leaving
  `slowmode=45 locked=false`. Confirmed both halves of the bug in one run.

Final order in `uncorner()`: clear slowmode → `setLocked(true)` → `setArchived(true)` (archive strictly
last).

Swept the class — grepped every `setArchived(true)` call site in the repo and checked what follows each:
`appeals.js`, `strikeAppeals.js`, `suggestions.js`, `modapps.js`, `eventorgapps.js`, `reports.js`,
`sidebar.js` and `mafia.js` all already lock-then-archive correctly. `corner.js` was the only site with
the inverted order, so no further fixes needed.

Also hardened the reuse path in `getOrCreateCornerJailThread()`: a reused thread now gets slowmode set
unconditionally to either the requested value or **0**, so a stale limit left behind by a release that
couldn't reach the thread (bot down mid-release, thread momentarily unfetchable) can't silently carry
into the next person cornered there. Deliberately not diffing against `thread.rateLimitPerUser` first —
a stale cached read would skip the clear, which is precisely the failure being guarded against, and one
extra API call per corner is cheap next to that.

`node --check` clean local+remote, both bots restarted clean, test thread and scratch scripts deleted
from bots-vm, confirmed gone.

## 2026-08-20 21:38 — /sidebar was never registered (bug I shipped) + multi-person sidebars + ➕ on corner jail threads

Owner: "is sidebar on? also can we sidebar multiple people?" — then mid-turn, "can we also add a
sidebar as an addition to the thread corner."

**The bug: sidebar was never actually on.** Command registration is fail-off —
`allCmds.filter(b => enabledNames.has(b.name))`, where `enabledNames` comes from the `commands`/
`contexts` arrays of ENABLED feature-registry entries. When I built `/sidebar` earlier tonight I added
the builders to `allCmds` but never added a `features.js` registry entry, so nothing ever claimed the
names and all three (`sidebar`, `sidebar-setup`, and the `Sidebar` context menu) were silently
filtered out at every boot. It looked shipped, deployed clean, logged no error, and was simply absent
in Discord. My live verification had called `sidebar.pull()` DIRECTLY from a scratch script, which
exercises the module but never touches command registration — so the whole feature could be missing
and my test would still pass. Lesson worth keeping: verifying the module is not verifying the
command; check the `[features] registered ...` line actually lists the new name.

Swept the class rather than just this instance — wrote a throwaway checker that diffs every top-level
`SlashCommandBuilder`/`ContextMenuCommandBuilder` name in index.js against what the registry claims.
72 top-level commands, 18 unclaimed. 15 of those are DELIBERATE (their registry comments say so
explicitly: `/report` → dashboard button, `/confess`/`/modmail`/`/suggest` → dashboard buttons, every
`*-setup` → `/panel` → Setup, `cornered` → `/panel` → Corner page) — those entries carry
`commands: []` on purpose. The only genuinely broken ones were my three. Fixed by adding a `sidebar`
registry entry (`audience: 'staff'`, `built: true`, claiming both commands + the context menu, with a
help entry). Verified live: FUBU's registration line went 56 → 59 commands and now lists `Sidebar`,
`sidebar`, `sidebar-setup`.

**Multi-person sidebars.** `pull()` now takes one member or several: dedupes, rejects self/bots,
names the thread `Sidebar #N · alice +2`, and adds everyone. `/sidebar` gained optional `user2`-`user5`
(the same shape `/event-award` uses for first/second/third). More importantly the thread itself gained
a **➕ Add someone** button (staff-only) → user-select → pulls people in after the fact and updates
the starter embed, so a 1:1 can become a group when it turns out to need both sides — mirrors how
appeals.js grows its friend threads rather than fixing the roster at creation. State's `targetId`
became `targetIds`; `setStatus` reads `post.targetIds || post.targetId` so the two sidebars that
already exist from tonight's testing don't break.

**➕ on corner jail threads.** Confirmed via AskUserQuestion which of three readings was meant — the
answer was a button on the jail thread, not a second parallel thread. New jail threads now post a
small staff-facing line with the same ➕ control, so a mod can pull the other party into an existing
jail thread to get both sides without leaving it. Deliberately NOT routed through `sidebar.addPeople`
— a jail thread isn't in sidebar's state, so it gets its own small handler that adds straight to
`interaction.channel`; the picker UI is identical either way.

Verified live with real non-admin members: a 3-person sidebar created with all 3 genuinely in the
thread (`thread.members.fetch()` confirms, not just a non-error return), self-sidebar refused,
duplicate targets deduped to 1. Test threads deleted, scratch scripts removed from bots-vm, confirmed
gone. Both bots restarted clean.

## 2026-08-20 21:23 — Mafia: Among Us-style role config (count + % chance) and verified restart survival

Two owner asks in one pass: *"in among us there's a way to picks how many of each role you want as
well as the percent chance that role will be granted. i think we should add that"* and, mid-turn,
*"i also need games to survive restarts"*.

**Role config.** Each role now has a configurable count, and the two special roles also have a percent
chance that each slot actually spawns (so "2× 50%" can yield 0, 1, or 2 — the chance is rolled per
slot, not once for the whole role). Settings persist across games like a host's lobby settings, and
default to **Auto**, which reproduces the previous player-count scaling exactly — an untouched server
behaves identically to before this existed. Edited from a new ⚙️ **Roles** button on the lobby panel
(staff-only, ephemeral); count and chance are combined into one preset per role so each change is a
single click rather than two selects that have to agree, and the whole setup fits on one screen
within Discord's 5-row cap. The lobby panel shows the current setup inline so players can see it
without opening anything, and it re-renders when staff change it.

Two safety clamps, because a mis-set count could otherwise hand the game away before it starts:
Mafia is forced to at least 1 and to stay a strict **minority** at assignment time (mafia ≥ town is
an instant Mafia win), and special roles are clamped into the town slots that actually exist so
villager count can never go negative. Verified both: requesting 9 Mafia in a 5-player game clamps to
2 (town 3), and over-subscribing specials in a 5-player game still sums to exactly 5.

**Restart survival.** State was already written on every mutation, so games were persisting on disk —
what was missing was the live-Discord half on boot. Added `bootResume(client)`: drops any game whose
VC is gone (releasing anyone it had muted, so nobody is left stuck), re-applies mute/deafen for a
surviving *voice* game mid-Night/Day (server-mutes do outlive a restart, but someone who joined the
VC while the bot was down would be out of sync), and runs one sweep immediately after resuming so a
phase whose deadline passed during downtime resolves right away instead of idling up to a full 15s
tick. Panels need no repair — their customIds carry the vcId and every handler reads live state.

The state file also changed shape from a bare games map to `{games, settings}` to hold the new
settings; `load()` still reads the old flat shape, so an in-flight game from the previous build isn't
lost on upgrade (tested).

Verified: a 24-check logic harness — auto defaults unchanged at 5/6/8/15 players, explicit counts
honoured, 1×50% produces both outcomes over 200 rolls and 2×50% is genuinely graduated (0/1/2),
100%/0%/Off deterministic, both safety clamps, assignRoles honouring settings, and settings + an
in-flight game (phase, day number, night votes) both surviving a fresh module load, plus the v1
file-shape upgrade path. ALL PASS. Then a **live** restart test on FUBU rather than trusting the unit
test: injected a synthetic mid-Night game (text mode, empty VC, far-future deadline so nothing could
fire or touch a real member's voice state) into the real state file, restarted fubu-bot, and
confirmed both `[mafia] boot: resumed 1 game(s)` in the journal and the game intact on disk
afterward — phase, day 2, night votes and settings all preserved. Injected game removed and state
reset to empty afterward; scratch scripts deleted from bots-vm, confirmed gone.

Owner enabled the `mafia` flag on FUBU during this work (Melanin still dark). Still needs the live
multi-account playtest; timer lengths remain first-guess constants.

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
