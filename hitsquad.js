// hitsquad.js — a temporary chaos squad (owner, 2026-08-17: "a 'hit squad' that can be activated for
// ... and they will be assigned to any admin/owner that runs the command. they role in to ensure chaos
// (cornering people, etc.)" — refined in discussion: squad picked at activation time, 10-minute window,
// max 3 activations/day PER SUMMONER, only one squad active server-wide at a time). For the window, named
// members can /corner almost ANYONE — even staff — with the normal corner tier-gate lifted, except: each
// other, the server owner (protected separately by corner.js's own owner-guard, never touched here), and
// whoever summoned them. Every corner they land is forced to release exactly at the window's end,
// regardless of what duration was typed. Squad members are themselves immune to being cornered (by
// anyone) for as long as the window is live.
// State: { dailyDate, counts: { [summonerId]: n } (resets at UTC midnight), active: { squadIds,
// summonerId, startedAt, expiresAt } | absent }.
const fs = require('fs');
const { statePath } = require('./statepath');
const FILE = process.env.FUBU_HITSQUAD_FILE || statePath('hitsquad.json');

const DAILY_CAP_PER_PERSON = 3;
const DURATION_MS = 10 * 60000;

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(s) { try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { console.error('[hitsquad] save:', e.message); } }
const todayKey = () => new Date().toISOString().slice(0, 10);

function countsToday() { const s = load(); return s.dailyDate === todayKey() ? (s.counts || {}) : {}; }
function dailyCountFor(summonerId) { return countsToday()[summonerId] || 0; }
function isActive() { const s = load(); return !!(s.active && s.active.expiresAt > Date.now()); }
function getActive() { const s = load(); return isActive() ? s.active : null; }
// Raw active record regardless of expiry — for cleanup code that needs the squad list even a moment AFTER
// the window technically ended (e.g. the auto-revert timer firing right at expiresAt).
function peekActive() { return load().active || null; }
// One squad running at a time server-wide; the daily cap is per-summoner.
function canActivate(summonerId) { return !isActive() && dailyCountFor(summonerId) < DAILY_CAP_PER_PERSON; }

function activate(squadIds, summonerId) {
  const s = load();
  const counts = s.dailyDate === todayKey() ? (s.counts || {}) : {};
  counts[summonerId] = (counts[summonerId] || 0) + 1;
  const now = Date.now();
  const active = { squadIds, summonerId, startedAt: now, expiresAt: now + DURATION_MS };
  save({ dailyDate: todayKey(), counts, roleId: s.roleId, active });
  return active;
}
function clear() { const s = load(); delete s.active; save(s); }

function getRoleId() { return load().roleId || null; }
function setRoleId(id) { const s = load(); s.roleId = id; save(s); }

function isSquadMember(userId) { const a = getActive(); return !!(a && a.squadIds.includes(userId)); }
// Can `actorId` bypass the normal corner tier-gate against `targetId`, via an active hit-squad grant?
// Owner protection is untouched — this is only ever consulted at the RANK-comparison gate, never the
// separate `member.id === guild.ownerId` guard, so the owner stays uncorner-able regardless of this.
function canBypass(actorId, targetId) {
  const a = getActive();
  if (!a || !a.squadIds.includes(actorId)) return false;
  if (a.squadIds.includes(targetId)) return false;   // can't hit a fellow squad member
  if (targetId === a.summonerId) return false;        // can't hit whoever summoned them
  return true;
}

module.exports = { DAILY_CAP_PER_PERSON, DURATION_MS, dailyCountFor, isActive, getActive, peekActive, canActivate, activate, clear, getRoleId, setRoleId, isSquadMember, canBypass };
