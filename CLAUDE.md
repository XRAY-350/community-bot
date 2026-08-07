# community-bot — read `/root/.claude/CLAUDE.md` first

This box (`agents`) is one of 3 GCP boxes in a fleet rebuilt after Oracle terminated the OCI account
that used to host everything (2026-08-06). **`/root/.claude/CLAUDE.md`** has the full topology.

The important bit for this repo: **the bots do NOT run on this box.** community-bot (FUBU + Melanin),
bubble-girl-bot, sourcekit-bot, and mcfleet-bot all run on `bots-vm` (Tailscale `100.123.250.73`, GCP
project `discord-bots-504720` — a **different** project from this box's `sourcekit-server`), reachable
from here via `ssh -i /root/.ssh/fleet_agents Administrator@100.123.250.73` or the shared-FS mount at
`/mnt/fleet/bots`. This checkout on `agents` is for code changes; deploy + restart happens on bots-vm
(`~/bots/community-bot/` there).
