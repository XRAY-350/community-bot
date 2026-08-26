// throneExpire.js — per-message 24h auto-expiry for tribe THRONE channels (owner, 2026-08-04: "each message
// gets its own timer" to keep the throne clear). The throne is a bot/leader announcement channel (regular
// members can't post there), so its TRANSIENT system messages — join/leave requests, war + alliance vote
// prompts, Crown notices, coin-flip results — pile up. Each such message is scheduled to self-delete 24h
// after IT was posted (its own timer, not a single blanket sweep). The PERSISTENT throne panel (the
// Tithe/control buttons) and the arena start-pings (which self-delete at event end) are never scheduled here.
//
// Deadlines are PERSISTED so a bot restart re-arms them from disk instead of orphaning the message forever
// (a plain in-process setTimeout is lost on restart, which would defeat the whole "keep it clear" point).
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_THRONE_EXPIRE_FILE || statePath('throne_expire.json');
const TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours

let _q = null;
function load() {
  if (_q) return _q;
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); _q = Array.isArray(j) ? j : []; } catch { _q = []; }
  return _q;
}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(load())); } catch (e) { console.error('[throneExpire] save:', e.message); } }

// Record (or UPDATE) a message's delete deadline. Upsert: re-recording an existing message pushes its
// deadline, which is how a vote message that gets edited (tally update / result) resets to 24h-after-edit.
function add(channelId, messageId, deleteAt) {
  const q = load();
  const at = deleteAt || (Date.now() + TTL_MS);
  const e = q.find(x => x.messageId === messageId);
  if (e) { e.deleteAt = at; e.channelId = channelId; } else q.push({ channelId, messageId, deleteAt: at });
  save();
}
// Drop an entry (called after the message is deleted, or when it's already gone).
function remove(messageId) { _q = load().filter(e => e.messageId !== messageId); save(); }
function all() { return load().slice(); }

module.exports = { add, remove, all, TTL_MS, FILE };
