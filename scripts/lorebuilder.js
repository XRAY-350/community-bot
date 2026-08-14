#!/usr/bin/env node
// scripts/lorebuilder.js — generates a tribe's lore (title, myth, 3 evolution paths, 12 rank names, leader
// title, staff-rank title) from a short founder's brief, using the same Anthropic API key smartwatch.js
// already uses (ANTHROPIC_API_KEY / SMARTWATCH_API_KEY). Tribe creation is rare, so this is a manual CLI
// tool, not a live bot feature — hand-writing 6 tribes' worth of lore start-to-finish is exactly the slow
// part this replaces, but every draft still gets reviewed by a human before it touches anything live (the
// exact lesson from this session's tribe-lore work: never apply lore changes unilaterally).
//
// Two-step, on purpose — generating and applying in one command would make "review the draft" a fiction:
//   1) generate — calls the API, writes lore_drafts/<key>.json, prints a readable proposal. Nothing live
//      touched. Re-run generate as many times as you want; each run overwrites the draft.
//   2) apply    — reads that draft file (does NOT call the API again), writes it into tribes.json via the
//      same tribes.setLore()/update() calls used everywhere else this session, then creates/renames the 12
//      Discord rank roles to match. Requires the tribe to already exist (created via /tribe-admin create)
//      and the bot to be STOPPED first (same tribes.json-write-race rule as every other manual edit this
//      session): `sudo systemctl stop community-bot melanin-bot` before, `start` after.
//
// Usage (run from the bots-vm checkout, where tribes.json + Discord creds actually live):
//   node scripts/lorebuilder.js generate --key new-tribe --brief "desert nomads who worship a buried sun god"
//   node scripts/lorebuilder.js apply --key new-tribe
//
// Env: ANTHROPIC_API_KEY (or SMARTWATCH_API_KEY) for generate; DISCORD_BOT_TOKEN + GUILD_ID (or a
// .community_env file in cwd) for apply's role sync.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const tribes = require(path.join(ROOT, 'tribes'));

const DRAFT_DIR = path.join(__dirname, 'lore_drafts');
const MODEL = process.env.LOREBUILDER_MODEL || 'claude-sonnet-5';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

// House style, distilled from the 6 hand-written tribes this session finished (Valith, Cobalt Vigil, K.C.,
// Azania, Three-Eyed Council, Woeful Vagabonds) — not their full text (too long for a prompt), just the
// pattern a new tribe's lore needs to match so it doesn't stand out as obviously auto-generated.
const SYSTEM_PROMPT = `You write tribe lore for a Discord community's tribe-vs-tribe game system. Every tribe needs
EXACTLY this structure — it's a hard mechanical constraint, not a style choice:
- A short lore TITLE (the tribe's own name for itself/its order, distinct from its Discord display name).
- A MYTH: 2-4 short paragraphs of founding lore. Evocative but concise — this session's 6 tribes each ran
  roughly 150-400 words, not a novel.
- Exactly 3 PATHS a member can specialize into. Each needs: a short path name ("Path of X" or a proper noun
  like "Court of Fihen"), one single-word or short ATTRIBUTE name (e.g. Wrath, Vigilance, Resolve — the
  personal trait that grows as a member ranks up in that path), and exactly 4 RANKS from lowest to highest.
- Rank 0 of ALL THREE paths must be the SAME name — one shared "initiate" rank every new member holds before
  their path fully differentiates (examples from existing tribes: "Squire", "Fimawo", "Seekers", "Workers").
  Ranks 1-3 are path-specific and should escalate in seniority/power, ending on each path's own distinct
  leadership-flavored top rank.
- Exactly one LEADER TITLE for the whole tribe (its supreme leader's title, e.g. "The Black Bear", "Oli
  Sariw", "Manman-Krab", "The Circus Master") — short, evocative, used as a role name.
- Exactly one STAFF-RANK TITLE — the title staff members hold automatically when they're a member of this
  tribe, sitting above the whole rank ladder (e.g. "Iron Monarchs", "Overseer Directors", "Play Masters").

Tone: keep rank names SHORT (1-4 words) — they become Discord role names. Avoid modern/mundane words; lean
into whatever the founder's brief suggests (military, mystical, criminal-underworld, corporate-dystopian,
whatever fits). Each of the 3 paths should feel mechanically distinct from the other two (e.g. one combat-
flavored, one social/cunning-flavored, one knowledge/craft-flavored) so members have a real reason to pick
one path over another — this maps to hidden game categories, so genuine thematic variety matters.

Return ONLY a single JSON object, no other text, no markdown fences, shaped exactly like this:
{
  "title": "...",
  "myth": "...",
  "leaderTitle": "...",
  "staffRankTitle": "...",
  "paths": [
    { "name": "...", "attribute": "...", "ranks": ["rank0 (shared initiate)", "rank1", "rank2", "rank3 (top)"] },
    { "name": "...", "attribute": "...", "ranks": ["rank0 (shared initiate)", "rank1", "rank2", "rank3 (top)"] },
    { "name": "...", "attribute": "...", "ranks": ["rank0 (shared initiate)", "rank1", "rank2", "rank3 (top)"] }
  ]
}`;

function parseLoreJSON(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let v; try { v = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  if (!v.title || !v.myth || !v.leaderTitle || !Array.isArray(v.paths) || v.paths.length !== 3) return null;
  for (const p of v.paths) { if (!p.name || !p.attribute || !Array.isArray(p.ranks) || p.ranks.length !== 4) return null; }
  return v;
}

async function generate(args) {
  const key = args.key;
  const brief = args.brief;
  if (!key || !brief) { console.error('Usage: node scripts/lorebuilder.js generate --key <tribe-key> --brief "<short pitch>"'); process.exit(1); }

  let Anthropic; try { Anthropic = require('@anthropic-ai/sdk'); } catch { console.error('@anthropic-ai/sdk not installed — run npm install in the bot dir first.'); process.exit(1); }
  const apiKey = (process.env.ANTHROPIC_API_KEY || process.env.SMARTWATCH_API_KEY || '').trim();
  if (!apiKey) { console.error('No API key — set ANTHROPIC_API_KEY or SMARTWATCH_API_KEY.'); process.exit(1); }
  const client = new Anthropic({ apiKey });

  console.log(`[lorebuilder] asking ${MODEL} for lore on "${key}"...`);
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Tribe key: ${key}\nFounder's brief: ${brief}` }],
  });
  const textBlock = (resp.content || []).find(b => b.type === 'text');
  const lore = parseLoreJSON(textBlock && textBlock.text);
  if (!lore) { console.error('Model returned something that did not parse into the expected shape. Raw output:\n' + (textBlock && textBlock.text)); process.exit(1); }
  // Force rank 0 identical across all 3 paths — the model is told to, but don't trust it blindly.
  const sharedInitiate = lore.paths[0].ranks[0];
  for (const p of lore.paths) p.ranks[0] = sharedInitiate;

  fs.mkdirSync(DRAFT_DIR, { recursive: true });
  const draftPath = path.join(DRAFT_DIR, `${key}.json`);
  fs.writeFileSync(draftPath, JSON.stringify(lore, null, 2));

  console.log(`\n=== ${lore.title} ===`);
  console.log(lore.myth);
  console.log(`\nLeader: ${lore.leaderTitle}   |   Staff rank: ${lore.staffRankTitle}`);
  for (const p of lore.paths) console.log(`\n${p.name} (${p.attribute}): ${p.ranks.join(' → ')}`);
  console.log(`\nDraft saved: ${draftPath}`);
  console.log(`Review it, edit the JSON file by hand if anything's off, then:  node scripts/lorebuilder.js apply --key ${key}`);
}

async function apply(args) {
  const key = args.key;
  if (!key) { console.error('Usage: node scripts/lorebuilder.js apply --key <tribe-key>'); process.exit(1); }
  const draftPath = path.join(DRAFT_DIR, `${key}.json`);
  let lore; try { lore = JSON.parse(fs.readFileSync(draftPath, 'utf8')); } catch { console.error(`No draft at ${draftPath} — run generate first.`); process.exit(1); }

  const t = tribes.get(key);
  if (!t) { console.error(`No tribe registered under key "${key}" — create it first (/tribe-admin create or register), then apply.`); process.exit(1); }

  tribes.update(key, { leaderTitle: lore.leaderTitle, staffRankTitle: lore.staffRankTitle });
  tribes.setLore(key, {
    title: lore.title,
    myth: lore.myth,
    pathNames: lore.paths.map(p => p.name),
    attributeNames: lore.paths.map(p => p.attribute),
    rankTitles: lore.paths.flatMap(p => p.ranks),
  });
  console.log(`[lorebuilder] tribes.json updated for "${key}".`);

  // Role sync: create any still-missing rank role, rename every rank role to match. Same shape as
  // index.js's syncTribeRankRoles, standalone here since this script runs offline from the live bot.
  const { Client, GatewayIntentBits } = require(path.join(ROOT, 'node_modules', 'discord.js'));
  if (fs.existsSync('.community_env')) {
    fs.readFileSync('.community_env', 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
    });
  }
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.GUILD_ID) {
    console.log('[lorebuilder] no DISCORD_BOT_TOKEN/GUILD_ID available — tribes.json is updated, but the 12');
    console.log('rank roles still need creating/renaming. Run this again from a directory with a');
    console.log('.community_env file (or set those env vars), or open Edit Lore in /tribe panel once to');
    console.log('trigger the bot\'s own role sync instead.');
    return;
  }
  const SMALL_CAPS = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
  const toSmallCaps = s => String(s).split('').map(ch => SMALL_CAPS[ch.toLowerCase()] || ch).join('');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise((resolve, reject) => {
    client.once('clientReady', async () => {
      try {
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const fresh = tribes.get(key);
        for (const r of fresh.ranks) {
          const want = `${fresh.emoji || '🏴'} ${toSmallCaps(r.name)}`;
          let role = r.roleId ? await guild.roles.fetch(r.roleId).catch(() => null) : null;
          if (!role) {
            role = await guild.roles.create({ name: want, hoist: false, mentionable: false, reason: `Lore builder: ${key}/${r.key}` }).catch(e => { console.log('  role create failed:', r.key, e.message); return null; });
            if (role) { r.roleId = role.id; console.log('  created:', r.key, '->', want); }
          } else if (role.name !== want) {
            await role.setName(want, 'Lore builder role sync').catch(e => console.log('  rename failed:', r.key, e.message));
            console.log('  renamed:', r.key, '->', want);
          } else {
            console.log('  already correct:', r.key, want);
          }
        }
        tribes.update(key, { ranks: fresh.ranks });
        console.log('[lorebuilder] role sync complete.');
      } catch (e) { console.error('ERROR', e); }
      finally { client.destroy(); resolve(); }
    });
    client.login(process.env.DISCORD_BOT_TOKEN).catch(reject);
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(3));
  const cmd = process.argv[2];
  if (cmd === 'generate') await generate(args);
  else if (cmd === 'apply') await apply(args);
  else { console.error('Usage: node scripts/lorebuilder.js <generate|apply> --key <tribe-key> [--brief "..."]'); process.exit(1); }
})();
