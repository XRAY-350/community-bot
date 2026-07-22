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
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Case-insensitive, boundary-aware match (so "ass" won't fire inside "class"); phrases match too.
function matchTerms(content, terms) {
  if (!content) return [];
  return (terms || []).filter(t => {
    const term = String(t).trim();
    if (!term) return false;
    try { return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(term)}([^\\p{L}\\p{N}]|$)`, 'iu').test(content); }
    catch { return content.toLowerCase().includes(term.toLowerCase()); }
  });
}
module.exports = { loadTerms, saveTerms, addTerm, removeTerm, matchTerms, TERMS_FILE };
