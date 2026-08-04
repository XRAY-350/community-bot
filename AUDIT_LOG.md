# FUBU-Verify-Bot — Audit Log

Read-only, ground-up inspections (forward + reverse). Newest on top. Tiers: 🔴 URGENT · 🟠 ADVISORY · 🟡 NITPICK · 🟢 APPROVED.

---

## 2026-08-04 — post-Tribes-buildout audit

Focus: this session's changes (memberCache, appeals mutex, corner owner-guard, tribe leader requirement, rank ordering, shop rebalance, vote early-resolve + throne relocation, war defender-consent, throne cleanup, tithe button, the Arena challenges). Bot active, 54/54 commands, all 12 modules parse clean.

### 🔴 URGENT
- **Corner modal crashed on every use** → the multi-day `Invalid string length` RangeError + "bot doesn't respond in time." The native-timeout field added to the Send-to-corner modal had a 46-char label; Discord caps TextInput labels at 45, so `cornerReasonModal` threw on every open and the interaction died. **FIXED** (label → 41 chars, `6c867b3`), modal build re-verified.

### 🟠 ADVISORY
- **War `awaiting_target` had no expiry** — a defender ignoring the Accept/Decline prompt vetoed by inaction. **RESOLVED**: auto coin-flip after **24h** via `sweepStuckWars` (boot + hourly); `awaitingSince` timestamp added; coin-flip logic shared with the Decline button (`resolveWarByChance`).
- **`enforceRankOrder` uses a subset `setPositions`** which can nudge other roles ±1 when it fires. Owner clarified the observed General-above-mods placement was a manual move (correcting earlier behavior), not this code. Kept as-is; low risk, no-op while ordering is correct.
- **Pre-session RangeError bursts (Jul 30+)** predate stack logging and may differ from the corner bug. Owner: **keep the client/shard stack logging** until confirmed gone.

### 🟡 NITPICK
- Deleted leftover standalone scripts: `send-tribes-announcement.js` (one-shot, fired), `fix_mod_appcommands.js` (one-off), `_resolveall.js` (debug), plus 3 untracked `_*.js` debug scripts.

### 🟢 APPROVED
- **memberCache** — 12 sites; zero raw `guild.members.fetch()` left in interaction paths; rate-limit contention resolved.
- **appeals/strikeAppeals** — `withLock` serializes state writes; lost-update race closed.
- **corner** — owner guard centralized in `corner()`; server owner un-cornerable via all paths.
- **Leader requirement** — grace → freeze-at-midpoint → disband-pending; free-retheme on loss; non-staff leaders stripped; `set-leader` gated to leader + admin.
- **Rank ordering** — all 5 tribes verified `r1<r2<r3<member<r4<General`; maintainer no-op when correct.
- **Shop** — prices 150–800, gates 5–20; all active tribes clear gates; Tribe Icon mid-ladder.
- **Votes** — `voteLocked` early-resolve; posted to throne; war defender-consent (Accept / coin-flip decline); `liveVotes` drops departed members.
- **Throne hygiene** — nomination/join/leave prompts delete on resolution; tithe button; boot refresh keeps hub + panels in sync.
- **Arena** — 4 types, cached state, boot recovery, logic unit-tested.
- No orphan modules, no stuck war/vote records, no secrets in code.
