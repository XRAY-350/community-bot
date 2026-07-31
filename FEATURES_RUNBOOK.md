# FUBU bot — feature flags & activation runbook

Single source of truth: **`features.js`** (registry) + **`/home/ubuntu/.fubu_features.json`** (flags).

**Fail-off:** a feature is ON only if its flag is *explicitly* `true`. Missing/false = off. Existing
features are `true` because they're built + running — not because they're privileged.

The registry drives four things automatically: command **registration**, handler **gating**, **`/help`**,
and the **server-guide** message. Add a feature to the registry (with a `help` entry) and it surfaces
itself everywhere once enabled.

## Toggling
- **`/features list` / `/features toggle <feature> <on>`** — Owner-tier only. Flips the flag live; the reply
  tells you whether a restart is needed (registration-affecting flags do; pure-behavior ones don't).
- **Runtime gating** (cornerReason, timeServed, langMiniMod): flags are read live from
  the JSON on each interaction — flip the flag, effect is immediate, **no restart**.
- **Command/option registration** (appeals): a disabled feature's slash commands/options aren't
  registered. Flipping it on requires a **restart** (`sudo systemctl restart fubu-verify-bot`) so they register.
- **Env/role changes** (mini-mod role id): edit `/home/ubuntu/.fubu_verify_env`, then restart.

## Dark features — activation steps

### `appeals` — ban appeals (friends vouch on behalf)
1. `"appeals": true` in the flags file.
2. Restart (registers `/appeal`, `/appeal-setup`).
3. An admin runs `/appeal-setup` to create `#ban-appeals`.
Members then use `/appeal <username>`. Auto-surfaces in `/help` + guide once on.

## Strikes — weighted, cumulative units (`strikes.js`), not a feature flag
Superseded the old flat 3-role ladder (`fiveStrikes` and `strikeReason` are retired — this is always on,
not gated). A strike now carries a **weight** (1/2/3 units, staff-chosen every time via `/strike add`, the
right-click **Strike**, or the watch-log strike button/modal) instead of just moving one role at a time.
Total units (sum of every *active* strike) — not a role position — is the record; strikes never expire on
their own. **Ban threshold is 10 units** — crossing it always surfaces a staff **Confirm ban** button, it
never auto-bans (same "never auto-ban" precedent `fiveStrikes` used to hold, now baked into the core model).
- **Rule picker** (optional, on `/strike add`) is pulled live from `rules.js`'s `TITLES` (via `SERVER_RULES`
  in `index.js`) — edit `rules.js` and the dropdown follows, no other code change needed. **Reason is now
  mandatory** on every strike path (the spec requires every strike be shown publicly) — no more "give one
  or the other."
- **Timeout bundling**: `/strike add`'s optional `timeout` field attaches a real native Discord timeout
  (`member.timeout()` — previously never used for moderation, only to temporarily lift/restore an existing
  one during Corner role edits) — **only accepted at weight 1** (bundling makes it 2 units, the one case the
  spec confirms; higher-weight math isn't decided yet, so the command refuses rather than guessing).
- **Visible tier roles**: the same 3 existing Strike I/II/III role IDs (`STRIKE_ROLE_IDS`) are kept — no new
  roles — but what triggers holding one changed from "which level you escalated to" to "which unit-band
  you're in" (I = 1–3 units, II = 4–6, III = 7–9, ban-confirm at 10+). `strikes.recomputeTier()` swaps the
  role automatically after every add/remove/clear.
- **Legacy migration**: on every boot, any member still holding a Strike I/II/III role from before this
  shipped, with no ledger entries yet, gets seeded one legacy entry at that role's old position as weight
  (I=1/II=2/III=3) — idempotent, logged as `[strikes] legacy migration: N member(s) seeded`.
- **Appeal-removal primitive**: `/strike remove <user> <strike_id>` deactivates ONE specific strike (see the
  ID via `/strike view`) without erasing it from the audit trail. The full guided appeal *workflow* (a
  private thread + staff review + buttons, mirroring `appeals.js`'s ban-appeal pattern) is separate future
  work, not built yet — this is just the raw mechanic it will call.

### `cornerReason` — right-click Send-to-corner asks for an OPTIONAL reason
1. `"cornerReason": true`. No restart.
Effect: right-click **Send to corner** shows a modal (reason optional); the reason appears in the corner
channel + audit log. (`/corner` already had a reason.)

### `timeServed` — release shows how long they were in
1. `"timeServed": true`. No restart.
Effect: manual + auto releases append `· in for **2d 3h**` to the release notice + corner log.

### `langMiniMod` — language mini-mod may Send-to-corner + Report-to-watchlist in the language channels only
1. Create a **Language Mini Mod** role.
2. Set `LANG_MINI_MOD_ROLE_ID=<roleId>` in `/home/ubuntu/.fubu_verify_env`.
3. Grant that role **Manage Messages + Manage Threads** on the 4 language channels.
4. `"langMiniMod": true`.
5. Restart (for the env change).
The 4 language channels are pre-set in `config.langChannelIds` (French/German/Dutch/Hispanic). The gate is
scoped: a mini-mod can only use those two tools on messages *in* those channels.

## Member-picking (dashboard + `/unban`)
Every dashboard button that used to open a "type a username/ID" modal (Corner, Verify, Uncorner, Ban,
Watchlist add/remove) now opens a **UserSelect** — Discord's native searchable member list — instead; you
pick from real names, you don't type and hope it resolves. Corner and Ban still ask one short follow-up
question (duration / reason) via a modal *after* you've picked, since the member is already known by then.
**Unban** is the one case that can't use UserSelect (a banned user isn't a guild member anymore): the
dashboard button now shows a **StringSelect** built from the live ban list (name + reason, alphabetical) —
capped at Discord's 25-option limit; past that, use `/unban`, whose `user_id` option has **autocomplete**
searching the *entire* ban list as you type (no cap).

## Design principles the registry encodes (keep features coherent)
- Ladder has meaning: corner = casual · strikes = formal→ban · watchlist = probation.
- Every action carries a reason, shown where it happened. **No DMs** except the anonymous pipe.
- Power lives in roles/tiers, not individuals.
- Lightweight tools flag/escalate to heavier ones.
- Everything toggleable + self-describing (registry drives help/guide/gating).
