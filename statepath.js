// statepath.js — single source of truth for where this bot keeps its state on disk.
//
// This one bot codebase runs as TWO independent processes (FUBU + Melanin), differing ONLY by which
// directory their state lives in. That directory comes from FUBU_STATE_DIR in each service's env file
// (FUBU → /var/lib/fubu-bot, Melanin → /var/lib/melanin-bot). Every module builds its state-file path via
// statePath('<name>') instead of hardcoding '/home/ubuntu/.fubu_<name>', so the same code serves both bots
// with no per-copy edits (this replaced the old sed-a-duplicate-repo workflow).
//
// Individual modules may still override a specific file with their own FUBU_*_FILE env var (kept for
// back-compat); statePath is just the default base every unset one falls back to.
//
// NOTE: STATE_DIR is captured at require time. That is safe today ONLY because this codebase has no
// dotenv — env comes fully populated from the systemd EnvironmentFile before node starts. If dotenv is
// ever added, it must be required BEFORE this module or every state file silently falls back to
// /var/lib/fubu-bot (audit N17).
const path = require('path');
const fs = require('fs');

const STATE_DIR = process.env.FUBU_STATE_DIR || '/var/lib/fubu-bot';

// Join a bare state name (e.g. 'tribes.json', 'tribe_banners') onto the configured state dir.
function statePath(name) { return path.join(STATE_DIR, name); }

// Atomic JSON write (audit A23): tmp + rename, so a crash/ENOSPC mid-write can never leave torn JSON —
// every loader in this codebase treats unparseable state as "empty", which silently turned a torn
// tribes.json into "no tribes". THROWS on failure (does not swallow) so callers can decide; the shared
// save-helper pattern is: try { atomicWriteJson(FILE, obj) } catch (e) { console.error(...); return false }
function atomicWriteJson(file, obj, pretty = false) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

module.exports = { statePath, STATE_DIR, atomicWriteJson };
