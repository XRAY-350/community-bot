// botdeletes.js — a short-lived registry of message ids THIS BOT deleted on purpose.
//
// Why this exists: the #deletion-log listener has no reliable way to tell "a human deleted this" from
// "the bot auto-moderated this". messageDelete carries no executor, and the audit-log correlation it
// falls back on is racy in exactly the case that matters:
//   • the gateway messageDelete event normally arrives BEFORE Discord has written the MESSAGE_DELETE
//     audit entry, so the lookup finds nothing, and
//   • Discord COALESCES repeated MESSAGE_DELETE entries for the same (target, channel) pair into one
//     entry with a bumped count instead of writing a fresh one, so a second auto-delete for the same
//     member often has no new entry to find at all.
// Both failure modes look identical to "no audit entry exists", which the logger reads as a self-delete
// — which is why filter-deleted messages were showing up in the log as "deleted by <member> (themselves)"
// (owner, 2026-08-20).
//
// So instead of inferring after the fact, the deleting code declares its intent up front: call mark(id)
// immediately BEFORE any bot-initiated delete of a message that shouldn't be logged, and the listener
// skips anything marked. Ids are held briefly and swept, since they're only needed for the moment
// between the delete call and its gateway event.
const TTL_MS = 60 * 1000;
const _ids = new Map();   // messageId -> expiry ts

function sweep() {
  const now = Date.now();
  for (const [id, exp] of _ids) if (exp <= now) _ids.delete(id);
}

// Mark one id, or several (bulkDelete). Safe to call with undefined/null.
function mark(id) {
  if (!id) return;
  if (Array.isArray(id) || id instanceof Set) { for (const one of id) mark(one); return; }
  if (_ids.size > 5000) sweep();   // cheap bound; normal load never gets near this
  _ids.set(String(id), Date.now() + TTL_MS);
}

// True if the bot deleted this message on purpose. Consumes the entry — each delete fires exactly one
// messageDelete event, so holding it after that only risks a stale match on a recycled id.
function was(id) {
  if (!id) return false;
  const key = String(id);
  const exp = _ids.get(key);
  if (exp === undefined) return false;
  _ids.delete(key);
  return exp > Date.now();
}

setInterval(sweep, TTL_MS).unref?.();

module.exports = { mark, was, sweep, TTL_MS };
