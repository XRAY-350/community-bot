// state.js — tiny JSON persistence for bubble girl :3. Survives restarts. Holds:
//   - meta: message ids of the pinned role-picker / verify-info posts (so we edit, not re-post)
//   - cornered: { userId -> { roles:[stripped ids], releaseAt|null, by, at } } for the Corner jail
//   - confessionCount: running number for anonymous confessions
// Read once at boot, write-through on each change. Volume is tiny.

const fs = require('fs');

class State {
  constructor(path) {
    this.path = path;
    this.data = { meta: {}, cornered: {}, confessionCount: 0 };
    this._load();
  }
  _load() {
    try {
      const p = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.data = {
        meta: p.meta || {},
        cornered: p.cornered || {},
        confessionCount: p.confessionCount || 0,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[state] read ${this.path}: ${err.message} — starting empty`);
    }
  }
  _save() {
    try { const tmp = `${this.path}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2)); fs.renameSync(tmp, this.path); }
    catch (err) { console.error(`[state] write ${this.path}: ${err.message}`); }
  }

  // pinned-message ids (role picker, verify info)
  getMeta(k) { return this.data.meta[k]; }
  setMeta(k, v) { this.data.meta[k] = v; this._save(); }

  // The Corner
  getCornered(id) { return this.data.cornered[id]; }
  setCornered(id, rec) { this.data.cornered[id] = rec; this._save(); }
  clearCornered(id) { if (this.data.cornered[id]) { delete this.data.cornered[id]; this._save(); } }
  listCornered() { return this.data.cornered; }

  // Confessions
  nextConfession() { this.data.confessionCount = (this.data.confessionCount || 0) + 1; this._save(); return this.data.confessionCount; }
}

module.exports = State;
