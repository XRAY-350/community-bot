// suggest.js — watchlist TERM RECOMMENDER. Scans the last N hours of public messages and proposes
// English terms to add to the strict / loose / welfare lists, grounded in what members actually said.
// Two sources, both filtered against what's already covered (so we never re-suggest a near-duplicate):
//   1. a curated high-precision safety LEXICON (each term pre-tagged with the list it belongs in), and
//   2. DISCOVERY — frequent English bigrams drawn only from messages that sit in a "concern context",
//      so novel phrasings the lexicon doesn't know still surface (suggested as loose for a human to place).
// Mods run /watchlist-suggest; an ADMINS-★ picks the good ones from a multi-select → they're added.
// Nothing is auto-added. Ignored suggestions are remembered so they don't nag next scan.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelType } = require('discord.js');
const watchlist = require('./watchlist');

const IGNORE_FILE = process.env.FUBU_SUGGEST_IGNORE_FILE || '/home/ubuntu/.fubu_watchlist_suggest_ignore.json';
const US = '␟'; // unit separator for customId/select-value encoding (never appears in a term)

// ---- curated lexicon: term → the list it should live on --------------------------------------------
// strict  = watchlisted-member ban alerts (narrow audience → aggressive threat/dox/raid variants ok)
// loose   = everyone → quiet #watch-log (must stay low-false-positive: predatory / scam / solicitation)
// welfare = everyone → soft support check-in (self-directed distress)
const LEXICON = [
  // strict — kys/threat evasion variants the list tends to miss
  ['off yourself', 'strict'], ['go off yourself', 'strict'], ['unalive yourself', 'strict'],
  ['rope yourself', 'strict'], ['go rope', 'strict'], ['hang urself', 'strict'],
  ['you should die', 'strict'], ['hope you die', 'strict'], ['i hope you die', 'strict'],
  ['kill u', 'strict'], ['ill kill you', 'strict'], ['catch you outside', 'strict'],
  ['jump you', 'strict'], ['jump him', 'strict'], ['curb stomp', 'strict'], ['snap your neck', 'strict'],
  ['hunt you down', 'strict'], ['find where you live', 'strict'], ['come to your house', 'strict'],
  // strict — dox / IP tooling
  ['ip grabber', 'strict'], ['ip logger', 'strict'], ['ip puller', 'strict'], ['grab your ip', 'strict'],
  ['pull your ip', 'strict'], ['your real name', 'strict'], ['your home address', 'strict'],
  ['leak your address', 'strict'], ['post your info', 'strict'],
  // strict — raid / server-attack tooling
  ['token grabber', 'strict'], ['token logger', 'strict'], ['self bot', 'strict'], ['selfbot', 'strict'],
  ['mass report', 'strict'], ['crash the server', 'strict'], ['get you banned', 'strict'],
  ['nuke this server', 'strict'],
  // loose — predatory / minor-safety (a live theme in FUBU; kept in loose = quiet log, not blunt bans)
  ['are you underage', 'loose'], ['you look underage', 'loose'], ['send me nudes', 'loose'],
  ['send nudes', 'loose'], ['send me pics', 'loose'], ['show me your body', 'loose'],
  ['dm me your', 'loose'], ['add me on snap', 'loose'], ['whats your snap', 'loose'],
  ['child porn', 'loose'], ['cp link', 'loose'],
  // loose — scam / solicitation gaps
  ['venmo me', 'loose'], ['paypal me', 'loose'], ['my onlyfans', 'loose'], ['dm to buy', 'loose'],
  ['discord nitro free', 'loose'], ['gift card', 'loose'], ['promo my', 'loose'],
  // welfare — self-directed distress the welfare list is missing
  ['kill myself', 'welfare'], ['i want to kill myself', 'welfare'], ['end my life', 'welfare'],
  ['end it all', 'welfare'], ['no reason to live', 'welfare'], ['dont want to be here', 'welfare'],
  ['wish i was dead', 'welfare'], ['hurting myself', 'welfare'], ['want to disappear', 'welfare'],
  ['im relapsing', 'welfare'], ['starve myself', 'welfare'],
];

// ---- discovery: only mine phrases from messages that sit in a concern context ----------------------
const CONCERN_CTX = /\b(kill|die|dead|suicide|kys|unalive|rope|hang|bleach|blade|cut|harm|dox|address|ip\b|threat|stab|shoot|gun|beat|jump|rape|nudes|underage|minor|groom|pedo|scam|venmo|cashapp|nitro|raid|nuke|token|leak)\b/i;
const STOP = new Set(('the a an and or but if to of in on at for with is are was were be been being i you he she it we they me my your our their this that these those not no yes do does did so as up out just get got go going gonna wanna like lol lmao bro fr ngl idk omg what when where who how why can will would should could im ive u ur dont cant its').split(' '));

function loadIgnore() { try { const a = JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveIgnore(list) { try { fs.writeFileSync(IGNORE_FILE, JSON.stringify([...new Set(list)])); } catch (e) { console.error('[suggest] ignore save:', e.message); } }
function addIgnore(term) { const l = loadIgnore(); if (!l.some(x => x.toLowerCase() === term.toLowerCase())) { l.push(term); saveIgnore(l); } }

// A candidate is "already covered" if any existing term matches it (dedupes near-dups + obfuscations).
function covered(term, existing) { return watchlist.matchTerms(term, existing).length > 0; }

async function drain(ch, cutoff, rows) {
  let before;
  for (let page = 0; page < 6; page++) { // cap 600 msgs/channel — recommender, not an archive
    let batch; try { batch = await ch.messages.fetch({ limit: 100, before }); } catch { return; }
    if (!batch || batch.size === 0) return;
    let old = false;
    for (const m of batch.values()) {
      if (m.createdTimestamp < cutoff) { old = true; continue; }
      if (m.author?.bot) continue;
      rows.push(m);
    }
    before = batch.last().id;
    if (old || batch.size < 100) return;
  }
}

// Scan → ranked suggestions. staffRoleIds = roles whose messages we skip (staff talk casually).
async function scan(guild, config, hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const channels = await guild.channels.fetch();
  const staffChannels = new Set([config.modConflictChannelId, config.cornerChannelId].filter(Boolean));
  const rows = [];
  for (const ch of channels.values()) {
    if (!ch || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type)) continue;
    if (staffChannels.has(ch.id)) continue;
    await drain(ch, cutoff, rows);
  }
  // skip staff authors (their casual language shouldn't seed the watchlist)
  const isStaff = (m) => {
    const r = m.member?.roles?.cache;
    return !!(r && ((config.modRoleId && r.has(config.modRoleId)) ||
      (config.strikeRoleIds || []).some(() => false))); // memberTier handled below via role check
  };
  const msgs = rows.filter(m => m.content && !isStaff(m));

  const existing = [...new Set([...watchlist.loadTerms(), ...watchlist.loadLoose(), ...watchlist.loadWelfare()])];
  const ignored = loadIgnore();
  const isIgnored = (t) => ignored.some(x => x.toLowerCase() === t.toLowerCase());

  const out = new Map(); // term -> {term, scope, count, example, source}
  const bump = (term, scope, source, msg) => {
    const key = term.toLowerCase();
    if (!out.has(key)) out.set(key, { term, scope, count: 0, example: '', source });
    const e = out.get(key); e.count++;
    if (!e.example) e.example = msg.content.replace(/\s+/g, ' ').slice(0, 140);
  };

  // 1) lexicon hits
  for (const [term, scope] of LEXICON) {
    if (covered(term, existing) || isIgnored(term)) continue;
    for (const m of msgs) if (watchlist.matchTerms(m.content, [term]).length) bump(term, scope, 'lexicon', m);
  }
  // 2) discovery — English bigrams from concern-context messages only
  const bigramCount = new Map(); const bigramEx = new Map();
  for (const m of msgs) {
    if (!CONCERN_CTX.test(m.content)) continue;
    const toks = (m.content.toLowerCase().match(/[a-z][a-z']{1,}/g) || []).filter(w => !STOP.has(w));
    for (let i = 0; i < toks.length - 1; i++) {
      const bg = toks[i] + ' ' + toks[i + 1];
      bigramCount.set(bg, (bigramCount.get(bg) || 0) + 1);
      if (!bigramEx.has(bg)) bigramEx.set(bg, m);
    }
  }
  for (const [bg, n] of bigramCount) {
    if (n < 3) continue;                          // needs to recur to be worth a look
    if (covered(bg, existing) || isIgnored(bg)) continue;
    if (!CONCERN_CTX.test(bg)) continue;          // the bigram itself must carry a concern word
    const e = bigramEx.get(bg);
    if (!out.has(bg)) out.set(bg, { term: bg, scope: 'loose', count: n, example: e.content.replace(/\s+/g, ' ').slice(0, 140), source: 'discovered' });
  }

  const ranked = [...out.values()].sort((a, b) => b.count - a.count).slice(0, 25);
  return { ranked, scanned: msgs.length, hours };
}

function render(result) {
  const { ranked, scanned, hours } = result;
  const emb = new EmbedBuilder().setTitle('🧠 Watchlist term suggestions')
    .setColor(0x9B59B6)
    .setDescription(ranked.length
      ? `From **${scanned}** messages over the last **${hours}h**. English only; already-covered terms filtered out.\n` +
        `Pick the good ones below — an **ADMINS-★** click adds each to its suggested list. The rest are ignored so they won't nag again.`
      : `Scanned **${scanned}** messages over the last **${hours}h** — nothing new worth flagging. The lists already cover what came up. 👌`);
  const SCOPE_EMO = { strict: '🛑', loose: '🔎', welfare: '🫂' };
  for (const s of ranked.slice(0, 12)) {
    emb.addFields({ name: `${SCOPE_EMO[s.scope]} \`${s.term}\`  ·  ${s.count}×  ·  ${s.scope}${s.source === 'discovered' ? '  ·  discovered' : ''}`,
      value: s.example ? `> ${s.example.slice(0, 120)}` : '​' });
  }
  const components = [];
  if (ranked.length) {
    const menu = new StringSelectMenuBuilder().setCustomId('wlsug_add')
      .setPlaceholder('Add suggested terms…').setMinValues(1).setMaxValues(Math.min(ranked.length, 25))
      .addOptions(ranked.map(s => ({
        label: `${s.term}`.slice(0, 100),
        description: `→ ${s.scope}  ·  ${s.count}× seen`.slice(0, 100),
        value: `${s.scope}${US}${s.term}`.slice(0, 100),
        emoji: SCOPE_EMO[s.scope],
      })));
    components.push(new ActionRowBuilder().addComponents(menu));
  }
  return { embeds: [emb], components };
}

// Apply a multi-select of `scope␟term` values. Returns a human summary line.
function applySelection(values) {
  const adder = { strict: watchlist.addTerm, loose: watchlist.addLoose, welfare: watchlist.addWelfare };
  const done = [];
  for (const v of values) {
    const [scope, term] = v.split(US);
    if (!adder[scope] || !term) continue;
    adder[scope](term);
    done.push(`${term} → ${scope}`);
  }
  return done;
}

module.exports = { scan, render, applySelection, addIgnore, loadIgnore, IGNORE_FILE, LEXICON };
