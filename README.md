# fubu-verify-bot

A small standalone Discord bot for the **FUBU** server that helps run the verification workflow.
It does **not** perform verification. A human moderator still decides and verifies; this bot only:

1. **Deletes verified threads** — when a mod assigns the **Verified role** to a member, the bot
   **deletes** the verification thread(s) that member opened. (Irreversible.)
2. **Nudges mods** — periodically pings a mod role about verification threads still pending.
3. **Reaps unverified members** — ANY member still unverified (whether or not they have a thread)
   is warned with an **@mention** `WARN_DAYS` after **joining**, then **kicked and any thread(s)
   they own deleted** `KICK_DAYS` after joining (defaults: warn day 6, kick day 7; irreversible;
   kick gated by `STALE_KICK`). Members with a thread are warned inside it; thread-less members
   are warned in the **unverified-chat channel** (`UNVERIFIED_CHAT_CHANNEL_ID`).
4. **Cleans up orphans** — a thread whose owner has **left the server** is deleted (nobody to verify
   or kick). Gated by `REAP_ORPHANS`.
5. **Nudges mods** — pings the mod role about still-pending threads (owner unverified, not yet
   past the deadline).
6. **Purges the unverified-chat channel** — deletes EVERY thread created there (any status, any
   owner); no threads are allowed in that channel. Gated by `PURGE_WARN_CHANNEL_THREADS`.
7. **Flags role conflicts** — a member holding BOTH the verified and unverified role is ambiguous;
   the bot takes **no** destructive action on them (no kick, no thread delete). Conflicts are
   surfaced in the **daily digest** (below); optional per-message flagging exists via `CONFLICT_PING`
   (default off). Once a mod removes one role, normal handling resumes.
8. **Daily digest** — once a day at `DIGEST_HOUR` it posts an embed to `MOD_CONFLICT_CHANNEL_ID`
   recapping the last 24h of every job (threads deleted verified/left, unverified-chat purged,
   members warned/kicked, mod nudges) plus role-conflict tracking ("X resolved today out of Y,
   Z remaining") and the list of unresolved conflicts. Gated by `DIGEST_ENABLED`.

All user references in mod-facing messages show the **username + ID** (not just a `<@id>` mention),
so they stay readable even when a client can't resolve the mention in a large guild.

All thread reads are channel-scoped (parent-id filtered), and cover open + archived (public and
private), so the bot only ever touches the verify and unverified-chat channels — nothing else.

Separate process from the MC Fleet bot (its own Discord application, token, and systemd unit).

## Owner setup (the parts only you can do on discord.com)

1. **Create the application + bot** in the Discord Developer Portal → copy the **bot token**.
2. **Privileged intent:** on the app's *Bot* page, enable **SERVER MEMBERS INTENT**. Required — the
   Verified-role trigger relies on `guildMemberUpdate`, which needs this intent.
3. **Invite the bot** to FUBU (OAuth2 → URL Generator, scope `bot`) with permissions:
   **View Channels, Send Messages, Send Messages in Threads, Read Message History, Manage Threads,
   Kick Members, Mention @everyone/roles.** `Manage Threads` lets it delete threads it doesn't own;
   `Kick Members` lets it remove unverified members at the stale deadline; `Send Messages in Threads`
   lets it post the stale warning inside a thread.
   (Permissions integer for a prebuilt invite URL: `70643622284290`.)
   Already invited without Kick Members? Add it via **Server Settings → Roles → the bot's role →
   Kick Members**, no re-invite needed.
4. **Grab IDs** (Discord → enable Developer Mode → right-click → Copy ID): the **server**, the
   **verify channel**, the **Verified role**, and the **mod role** to ping.

## Configure + run (on the box)

```bash
cp /home/ubuntu/apps/fubu-verify-bot/.env.example /home/ubuntu/.fubu_verify_env
# fill in token + IDs, then lock it down:
chmod 600 /home/ubuntu/.fubu_verify_env

cd /home/ubuntu/apps/fubu-verify-bot && npm install    # discord.js

sudo cp fubu-verify-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fubu-verify-bot
journalctl -u fubu-verify-bot -f
```

## First run is observe-only

`DRY_RUN=true` (default) makes the bot **log** every intended action but perform none. Watch the
logs, assign the Verified role to a test account, confirm it identifies the right thread, then set
`DRY_RUN=false` in the env file and `sudo systemctl restart fubu-verify-bot` to go live.

## How it finds "their" thread

The verify channel is a **text channel with member-created threads**, so the bot matches a verified
member to their thread by **thread owner** (`ownerId` = the person who started the thread). If a
member opened more than one, all of theirs are closed.

## Tunables (env)

See `.env.example`. Key ones: `NUDGE_AFTER_HOURS`, `NUDGE_EVERY_HOURS`, `STALE_DAYS`,
`STALE_WARN_HOURS`, `SWEEP_INTERVAL_MIN`, and the `FEATURE_NUDGE` / `FEATURE_STALE` toggles.
