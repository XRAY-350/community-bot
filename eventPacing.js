// eventPacing.js — one shared "when did ANY cross-tribe event last start" timestamp, checked by the
// arena/sealed/trials auto-schedulers so back-to-back events from DIFFERENT systems don't stack up just
// because each system's own per-type cooldown was individually satisfied. (owner, 2026-08-15: "arena
// events are happening too often" — traced to 3 independent auto-schedulers, each respecting its own
// cap/gap, with nothing accounting for how recently a DIFFERENT system's event fired.)
//
// Only gates AUTO-starts — a staff member manually launching something is a deliberate decision, not the
// "too often" problem this exists to fix (same split arena.js's own COOLDOWN_MS/AUTO_GAP already draw).
const fs = require('fs');
const { statePath } = require('./statepath');
const STATE_FILE = process.env.FUBU_EVENT_PACING_FILE || statePath('event_pacing.json');
const COMBINED_MIN_GAP_MS = 2 * 3600000;   // at least 2h since ANY auto-started event (arena/sealed/trials)

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[eventPacing] save:', e.message); } }
// Call when ANY system (arena/sealed/trials) actually starts an event — auto or manual, doesn't matter;
// what matters for the gate is just "something is happening now," not who triggered it.
function recordEvent(nowMs) { save({ lastStartedAt: nowMs }); }
function combinedGapMet(nowMs) { const s = load(); return !s.lastStartedAt || (nowMs - s.lastStartedAt) >= COMBINED_MIN_GAP_MS; }
function nextAllowedAt() { const s = load(); return s.lastStartedAt ? s.lastStartedAt + COMBINED_MIN_GAP_MS : 0; }

module.exports = { COMBINED_MIN_GAP_MS, recordEvent, combinedGapMet, nextAllowedAt };
