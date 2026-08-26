// mutex.js — tiny per-key async mutex. appeals.js and strikeAppeals.js each do loadState() -> mutate ->
// saveState() across several awaited Discord API calls (thread creation, message sends) in between. Two
// concurrent calls (e.g. two friends appealing for different banned people seconds apart) can both load
// the same starting state, then the second save clobbers the first's write — a classic lost update. Real
// incident: two decided appeals (from two different members) had working starter cards and real decision messages,
// but their records vanished from state.appeals entirely, lost to exactly this race.
// One lock per key (module name) — concurrent appeals for DIFFERENT people still queue behind each other,
// which is fine: this is a rare, human-paced action, not a hot path.
const locks = new Map();

function withLock(key, fn) {
  const prior = locks.get(key) || Promise.resolve();
  const run = prior.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

module.exports = { withLock };
