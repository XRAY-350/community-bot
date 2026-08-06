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
const path = require('path');

const STATE_DIR = process.env.FUBU_STATE_DIR || '/var/lib/fubu-bot';

// Join a bare state name (e.g. 'tribes.json', 'tribe_banners') onto the configured state dir.
function statePath(name) { return path.join(STATE_DIR, name); }

module.exports = { statePath, STATE_DIR };
