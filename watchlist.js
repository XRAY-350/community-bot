// watchlist.js — flagged-term monitoring for members on the Watchlist role, plus the editable term store.
// The term list lives in a JSON file (no redeploy to edit) that the /watchlist-terms command manages.
const fs = require('fs');
const TERMS_FILE = process.env.FUBU_WATCHLIST_TERMS_FILE || '/home/ubuntu/.fubu_watchlist_terms.json';

function loadTerms() {
  try { const a = JSON.parse(fs.readFileSync(TERMS_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }                                   // missing/empty file → no terms → monitor is dormant
}
function saveTerms(terms) {
  const clean = [...new Set((terms || []).map(t => String(t).trim()).filter(Boolean))];
  try { fs.writeFileSync(TERMS_FILE, JSON.stringify(clean)); return clean; }
  catch (e) { console.error('[watchlist] save:', e.message); return loadTerms(); }
}
function addTerm(term) {
  const t = loadTerms(); const v = String(term).trim();
  if (v && !t.some(x => x.toLowerCase() === v.toLowerCase())) t.push(v);
  return saveTerms(t);
}
function removeTerm(term) {
  const v = String(term).trim().toLowerCase();
  return saveTerms(loadTerms().filter(x => x.toLowerCase() !== v));
}
// De-obfuscating matcher. Each term compiles ONCE (cached) to a regex that tolerates the usual evasions:
//   • separators between letters — "k y s", "k.y.s", "k-y-s"   (SEP allows up to 3 non-word chars)
//   • leet / look-alikes — "k1ll", "@ss", "sh1t", "he11o"      (per-letter character classes)
//   • repeated letters — "killlll", "kysss"                    (each class is +)
//   • accents/decomposable unicode on the message side (NFKD + strip combining marks)
// It still won't fire on an intervening LETTER (SEP is non-word only), so "kys" ≠ "keys".
const LEET = { a: 'a4@∆', b: 'b8', c: 'c(<', d: 'd', e: 'e3€', f: 'f', g: 'g9', h: 'h#', i: 'i1!|íì',
  j: 'j', k: 'k', l: 'l1|', m: 'm', n: 'n', o: 'o0()°', p: 'p', q: 'q', r: 'r', s: 's5$', t: 't7+',
  u: 'uüúù', v: 'v', w: 'w', x: 'x', y: 'y', z: 'z2' };
const escCls = s => s.replace(/[\]\\^-]/g, '\\$&');
const escLit = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\s\\W_]{0,3}';
function termToRegex(term) {
  const parts = [];
  for (const ch of String(term).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')) {
    if (LEET[ch]) parts.push(`[${escCls(LEET[ch])}]+`);
    else if (/[0-9]/.test(ch)) parts.push(`${ch}+`);
    // else (spaces, apostrophes, any punctuation) → skip; SEP between letters absorbs it, so
    // "i'm worthless" also matches "im worthless" / "imworthless".
  }
  if (!parts.length) return null;
  // Boundaries so a term inside a bigger word won't fire (e.g. "ass" in "classy"): the match must not be
  // immediately preceded/followed by an alphanumeric char. (Leet/separators inside the match still work.)
  try { return new RegExp(`(?<![a-z0-9])${parts.join(SEP)}(?![a-z0-9])`, 'i'); } catch { return null; }
}
const _reCache = new Map();
function _termRe(term) { if (!_reCache.has(term)) _reCache.set(term, termToRegex(term)); return _reCache.get(term); }
function matchTerms(content, terms) {
  if (!content) return [];
  const norm = content.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return (terms || []).filter(t => { const re = _termRe(String(t).trim()); return re && re.test(norm); });
}
// Pending watchlist: user IDs to auto-apply the Watchlist role to WHEN THEY REJOIN (unban keeps them
// watched — but an unbanned user isn't in the guild, so the role can only be added once they come back).
const PENDING_FILE = process.env.FUBU_WATCHLIST_PENDING_FILE || '/home/ubuntu/.fubu_watchlist_pending.json';
function loadPending() { try { const a = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function savePending(ids) { try { fs.writeFileSync(PENDING_FILE, JSON.stringify([...new Set(ids)])); } catch (e) { console.error('[watchlist] pending save:', e.message); } }
function addPending(id) { const p = loadPending(); if (!p.includes(id)) { p.push(id); savePending(p); } }
function removePending(id) { savePending(loadPending().filter(x => x !== id)); }
function isPending(id) { return loadPending().includes(id); }

// Loose "day-to-day" term list — a second, softer set matched against everyone-except-staff, reported
// quietly to #watch-log (no ping). Same matcher; its own editable file.
const LOOSE_FILE = process.env.FUBU_WATCHLIST_LOOSE_FILE || '/home/ubuntu/.fubu_watchlist_loose.json';
function loadLoose() { try { const a = JSON.parse(fs.readFileSync(LOOSE_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveLoose(terms) {
  const clean = [...new Set((terms || []).map(t => String(t).trim()).filter(Boolean))];
  try { fs.writeFileSync(LOOSE_FILE, JSON.stringify(clean)); return clean; } catch (e) { console.error('[watchlist] loose save:', e.message); return loadLoose(); }
}
function addLoose(term) { const t = loadLoose(); const v = String(term).trim(); if (v && !t.some(x => x.toLowerCase() === v.toLowerCase())) t.push(v); return saveLoose(t); }
function removeLoose(term) { const v = String(term).trim().toLowerCase(); return saveLoose(loadLoose().filter(x => x.toLowerCase() !== v)); }

// Welfare list — distress signals ("i want to die", "sh") matched against everyone-except-staff, reported
// to #watch-log as a SUPPORT check-in (soft, no ban button), kept separate so it reads differently.
const WELFARE_FILE = process.env.FUBU_WATCHLIST_WELFARE_FILE || '/home/ubuntu/.fubu_watchlist_welfare.json';
function loadWelfare() { try { const a = JSON.parse(fs.readFileSync(WELFARE_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveWelfare(terms) {
  const clean = [...new Set((terms || []).map(t => String(t).trim()).filter(Boolean))];
  try { fs.writeFileSync(WELFARE_FILE, JSON.stringify(clean)); return clean; } catch (e) { console.error('[watchlist] welfare save:', e.message); return loadWelfare(); }
}
function addWelfare(term) { const t = loadWelfare(); const v = String(term).trim(); if (v && !t.some(x => x.toLowerCase() === v.toLowerCase())) t.push(v); return saveWelfare(t); }
function removeWelfare(term) { const v = String(term).trim().toLowerCase(); return saveWelfare(loadWelfare().filter(x => x.toLowerCase() !== v)); }

// LAB expansion lists (feature 'smartWatchLab') — EXTRA strict/loose terms that ONLY feed the private
// admin eval channel, never the public watch-log. Deliberately broad/noisy: they exist to stress-test the
// AI judge with more borderline candidates (reclaimed words, benign homonyms, mild profanity) so admins can
// see whether it correctly hides the false positives and surfaces the real ones. Same matcher, own files.
const LAB_STRICT_FILE = process.env.FUBU_WATCHLIST_LAB_STRICT_FILE || '/home/ubuntu/.fubu_watchlist_lab_strict.json';
const LAB_LOOSE_FILE = process.env.FUBU_WATCHLIST_LAB_LOOSE_FILE || '/home/ubuntu/.fubu_watchlist_lab_loose.json';
function _loadArr(file) { try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function _saveArr(file, terms, label) {
  const clean = [...new Set((terms || []).map(t => String(t).trim()).filter(Boolean))];
  try { fs.writeFileSync(file, JSON.stringify(clean)); return clean; } catch (e) { console.error(`[watchlist] ${label} save:`, e.message); return _loadArr(file); }
}
function loadLabStrict() { return _loadArr(LAB_STRICT_FILE); }
function loadLabLoose() { return _loadArr(LAB_LOOSE_FILE); }
function addLabStrict(term) { const t = loadLabStrict(); const v = String(term).trim(); if (v && !t.some(x => x.toLowerCase() === v.toLowerCase())) t.push(v); return _saveArr(LAB_STRICT_FILE, t, 'lab-strict'); }
function removeLabStrict(term) { const v = String(term).trim().toLowerCase(); return _saveArr(LAB_STRICT_FILE, loadLabStrict().filter(x => x.toLowerCase() !== v), 'lab-strict'); }
function addLabLoose(term) { const t = loadLabLoose(); const v = String(term).trim(); if (v && !t.some(x => x.toLowerCase() === v.toLowerCase())) t.push(v); return _saveArr(LAB_LOOSE_FILE, t, 'lab-loose'); }
function removeLabLoose(term) { const v = String(term).trim().toLowerCase(); return _saveArr(LAB_LOOSE_FILE, loadLabLoose().filter(x => x.toLowerCase() !== v), 'lab-loose'); }

module.exports = { loadTerms, saveTerms, addTerm, removeTerm, matchTerms, TERMS_FILE,
  addPending, removePending, isPending, loadPending,
  loadLoose, addLoose, removeLoose, LOOSE_FILE,
  loadWelfare, addWelfare, removeWelfare, WELFARE_FILE,
  loadLabStrict, loadLabLoose, addLabStrict, removeLabStrict, addLabLoose, removeLabLoose, LAB_STRICT_FILE, LAB_LOOSE_FILE };
