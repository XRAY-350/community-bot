# community-bot

A Discord bot built for **FUBU** and its sister community **Melanin** — the same codebase runs both,
each with its own bot account, its own config, and its own feature switches. It started as a small
verification helper and grew into a full moderation + community platform: a jail-style timeout system,
weighted strikes, layered message filtering, anonymous reporting tools, staff applications, and an
entire member-faction ("tribe") game layer with wars, arenas, and a live economy.

This doc is for **anyone who wants to understand what the bot does**, and for **anyone who wants to run
their own copy of it** for their own server.

---

## What it does

### Verification & onboarding
New members open a thread in the verify channel; a mod reviews it and clicks **Verify** or **Deny**.
The bot never verifies anyone itself — it just runs the workflow around that decision: assigning the
Unverified role on join, warning members who've gone quiet on verification, and (after a further grace
period) removing anyone who never completes it. Every destructive step is individually toggleable, and
a **dry-run mode** lets a new deployment watch what the bot *would* do before it does anything for real.

### The Corner — a timed jail
"Send to corner" strips a member's roles (storing them for later), locks them to a limited channel set,
and restores everything automatically when their time is up — or immediately if a mod releases them
early. Durations parse naturally (`30m`, `2h`, `1d`, or indefinite). A tier system governs who can corner
whom (you can only act on your own tier or below), with an override-vote path for reversing a call made
by someone above your tier. Verified members can even be given a very limited, capped ability to corner
each other, if you want that.

### Strikes
A weighted-unit system (not a flat 3-strikes ladder) — each strike is worth 1-3 units depending on
severity, and a member visibly wears a role showing their running total. Cross a configurable threshold
and the bot flags it for a ban decision, but never bans automatically — a human always clicks Confirm.

### Message filtering
A layered pipeline runs on every message: a temporary **word filter** (auto-delete anything containing
a phrase, for a set duration), specific-**media blocking** (block one exact GIF link, or one exact
uploaded file by content hash — so a rename doesn't dodge it), and a **watchlist** system with three
scopes (strict per-user monitoring, quiet server-wide heads-ups, and a gentler "welfare check" flow for
distress language) built on a de-obfuscating matcher that catches leetspeak and spaced-out slurs. An
optional LLM pass can read flagged messages in context to cut down false positives, fails open if
anything goes wrong, and never suppresses child-safety, threat, or doxxing flags regardless.

### Anonymous & community tools
Confessions, suggestions, anonymous reports, whistleblows (the sender picks who — if anyone — can ever
unmask them), and a private mod-mail inbox. Each has its own cooldown and daily cap. There's also a
member-facing dashboard (one command, buttons for everything) and a staff ops panel with tier-gated pages
for moderation, strikes, permission auditing, and setup.

### Staff applications
Members apply to become a mod (or a narrower, scope-limited "mini-mod" — e.g. a language channel or a
specific community space) through a form that opens a private thread; staff cast an anonymous advisory
vote, and admins make the final call. The same shape now also runs **Event Organizer** applications for
members who want to run community events. Accepted applications grant the role automatically; a mistaken
decision can be undone.

### The Tribe system
The biggest piece: members join a tribe (a faction with its own role, colour, and private "land" —
a control channel, a chat, a voice channel), climb an activity-based rank ladder, and compete for a
weekly Crown and season championships. Tribes run their own economy (three currencies: personal Tides,
a tribe treasury, and a weekly Glory score), auto-running cross-tribe arena games throughout the day,
declared wars resolved as a live, broadcast best-of-7 skirmish series, alliances, a shop with unlockable
perks, and lore/path systems members can specialize into. It's designed to give a large server something
to actually do together, not just a leaderboard nobody looks at.

### Staff infrastructure
A permission-drift guard that snapshots channel permissions and reverts unintended changes, an audit
tool that flags over- or under-permissioned roles, an owner-only activity log mirroring both the bot's
own actions and the server's audit log, and a raid-detection watchdog for webhook/integration abuse and
join floods.

---

## How it's built

- **One codebase, many deployments.** Every server-specific value — the bot token, role/channel IDs,
  which features are on — lives in an env file, not in the code. FUBU and Melanin run the exact same
  `index.js` with two different env files and two different feature-flag files.
- **Feature flags are fail-off.** `features.js` is the single source of truth for what's enabled; a
  feature only turns on if explicitly flagged `true`. This is how the same bot can run a stripped-down
  Melanin (smaller team, fewer of the heavier systems) alongside the full FUBU deployment without any
  code branching.
- **Staff tiers, not raw Discord permissions.** The bot has its own tier ladder (trial mod → mod → admin
  → owner → bot-owner) checked on every action, independent of whether someone happens to hold Discord's
  native Administrator permission.
- **Plain JSON state**, one file per subsystem, cached in memory and written through on change — no
  database to stand up.

## Setting up your own instance

You'll need a Discord bot application (create one at the
[Discord Developer Portal](https://discord.com/developers/applications)), Node.js, and a place to run it
(a small VM with systemd works well, but any process manager does).

1. **Create the bot application**, copy its token, and enable the **Server Members** privileged intent
   (required — a lot of the bot's logic reacts to role changes).
2. **Invite it to your server** with at minimum: View Channels, Send Messages, Send Messages in Threads,
   Read Message History, Manage Roles, Manage Threads, Manage Messages, Kick/Ban Members, Moderate
   Members, Mention @everyone/roles. (Manage Roles needs the bot's own role positioned above anything
   it'll need to add or remove.)
3. **Set the four required env vars**: `DISCORD_BOT_TOKEN`, `GUILD_ID`, `VERIFY_CHANNEL_ID`,
   `VERIFIED_ROLE_ID`. Everything else in `config.js` has a sane default or is optional — read through it
   for the full list of what's tunable (channel/role IDs, timings, corner/strike behavior, tribe/arena
   settings, and so on).
4. **Install and run:**
   ```bash
   npm install
   node index.js
   ```
   For a persistent deployment, run it under a process supervisor (systemd, pm2, whatever you're already
   using) with the env file loaded and `Restart=on-failure`.
5. **Turn features on deliberately.** Everything ships fail-off beyond the verification core — use
   `/features` (bot-owner) to enable the pieces you actually want, and the ops panel's **Setup** page to
   create the channels/forums each one needs (mod applications, appeals, suggestions, and so on all
   create their own infrastructure on first setup).
6. **Start in dry-run** for the reap/removal sweep specifically — it defaults to observe-only so you can
   watch what it *would* do before anything becomes irreversible.

## Multi-server notes

If you want to run more than one community off this same codebase (the way FUBU and Melanin do):
duplicate the env file and the feature-flag file, point each at its own `GUILD_ID` and state directory,
and run two separate processes. Nothing in the code assumes a single guild.
