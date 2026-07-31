// state.js — tiny JSON persistence so the bot survives restarts without spamming or
// re-processing. Holds: per-thread {lastNudge, warnedAt} and a set of member ids already
// processed as verified (so a single role-add closes their threads exactly once).
// Deliberately simple: read once at boot, write-through on each change. Volume is low.

const fs = require('fs');

class State {
  constructor(path) {
    this.path = path;
    this.data = {
      threads: {}, processedMembers: {}, members: {},
      daily: this._freshDaily(),
      meta: { lastDigestDate: null, knownConflicts: [], cornered: {} },
    };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        threads: parsed.threads || {},
        processedMembers: parsed.processedMembers || {},
        members: parsed.members || {},
        daily: parsed.daily || this._freshDaily(),
        meta: parsed.meta || { lastDigestDate: null, knownConflicts: [], cornered: {} },
      };
      if (!this.data.meta.cornered) this.data.meta.cornered = {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[state] could not read ${this.path} (${err.message}); starting empty`);
      }
    }
  }

  _save() {
    try {
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.path); // atomic replace
    } catch (err) {
      console.error(`[state] could not write ${this.path}: ${err.message}`);
    }
  }

  thread(id) {
    return this.data.threads[id] || {};
  }

  setThread(id, patch) {
    this.data.threads[id] = { ...this.data.threads[id], ...patch };
    this._save();
  }

  forgetThread(id) {
    if (this.data.threads[id]) {
      delete this.data.threads[id];
      this._save();
    }
  }

  // Per-member reap bookkeeping (warnedAt) for the unverified-member sweep.
  member(id) {
    return this.data.members[id] || {};
  }

  setMember(id, patch) {
    this.data.members[id] = { ...this.data.members[id], ...patch };
    this._save();
  }

  forgetMember(id) {
    if (this.data.members[id]) {
      delete this.data.members[id];
      this._save();
    }
  }

  // --- Daily digest accumulators ---
  _freshDaily() {
    return {
      since: Date.now(),
      kicked: 0, warned: 0, unverifiedAssigned: 0,
      delVerified: 0, delLeft: 0, purged: 0, nudged: 0,
      conflictsReceived: 0, conflictsResolved: 0,
    };
  }

  daily() {
    return this.data.daily;
  }

  bumpDaily(key, n = 1) {
    if (n <= 0) return;
    this.data.daily[key] = (this.data.daily[key] || 0) + n;
    this._save();
  }

  resetDaily() {
    this.data.daily = this._freshDaily();
    this._save();
  }

  // --- The Corner (jail) bookkeeping ---
  getCornered(id) {
    return (this.data.meta.cornered || {})[id];
  }

  setCornered(id, rec) {
    (this.data.meta.cornered = this.data.meta.cornered || {})[id] = rec;
    this._save();
  }

  clearCornered(id) {
    if (this.data.meta.cornered && this.data.meta.cornered[id]) {
      delete this.data.meta.cornered[id];
      this._save();
    }
  }

  listCornered() {
    return this.data.meta.cornered || {};
  }

  getMeta(key) {
    return this.data.meta[key];
  }

  setMeta(key, val) {
    this.data.meta[key] = val;
    this._save();
  }

  isProcessed(memberId) {
    return Boolean(this.data.processedMembers[memberId]);
  }

  markProcessed(memberId) {
    this.data.processedMembers[memberId] = Date.now();
    this._save();
  }

  unmarkProcessed(memberId) {
    if (this.data.processedMembers[memberId]) {
      delete this.data.processedMembers[memberId];
      this._save();
    }
  }
}

module.exports = State;
