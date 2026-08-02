// freshwatch.js — self-calibrating "brand-new account" heads-up + influx detection.
//
// The AI judge deliberately IGNORES account age (a recent join is not evidence of intent — see smartwatch.js).
// But a HUMAN mod glancing at a flag benefits from knowing "this account just joined." So this computes, from
// the server's OWN join distribution, what counts as unusually fresh RIGHT NOW: tight during a growth spike,
// looser as growth slows. As a byproduct it also detects influxes and warns admins. Purely human-facing — the
// note never enters the AI prompt and never triggers an automatic action; it's a label on an already-surfaced flag.
const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const STATE_FILE = process.env.FUBU_FRESHWATCH_STATE || '/home/ubuntu/.fubu_freshwatch.json';
const DAY = 86400000, HOUR = 3600000;

// cache: recomputed periodically from the full membership. recentJoins: rolling window for real-time influx.
let cache = { autoCutoffTs: null, sampleSize: 0, baselineDaily: 0, computedAt: 0 };
let recentJoins = [];
let persisted = load();

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { influxActive: false, lastInfluxWarnTs: 0 }; } }
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(persisted)); } catch (e) { console.error('[freshwatch] save:', e.message); } }

function agoText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(ms / HOUR); if (h < 48) return `${h}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

// Recompute the auto cutoff + join-rate baseline from the full membership. Cheap enough hourly. Fail-soft:
// on any error the previous cache stands (and auto simply produces no note until a good sample lands).
async function recompute(guild) {
  try {
    const members = await guild.members.fetch();
    const now = Date.now();
    const joins = [...members.values()].map(m => m.joinedTimestamp).filter(Boolean).sort((a, b) => b - a); // newest first
    const n = joins.length;
    let cutoff = null;
    if (n >= 50) {                                        // percentile is meaningless on a tiny server
      const P = Math.max(0.1, Math.min(50, Number(config.smartWatchFreshPercentile) || 1));
      cutoff = joins[Math.max(0, Math.floor(n * P / 100) - 1)];
      const capTs = now - (Number(config.smartWatchFreshMaxDays) || 30) * DAY;
      if (cutoff < capTs) cutoff = capTs;                 // never treat an "old" account as fresh, even if newest N%
    }
    const monthAgo = now - 30 * DAY;
    const baselineDaily = joins.filter(t => t >= monthAgo).length / 30;
    cache = { autoCutoffTs: cutoff, sampleSize: n, baselineDaily, computedAt: now };
    recentJoins = joins.filter(t => t >= now - 2 * DAY).sort((a, b) => a - b);   // seed the real-time window
    checkInflux(guild, now);
    return cache;
  } catch (e) { console.error('[freshwatch] recompute:', e.message); return cache; }
}

// Real-time hook: called on every join so an influx is caught within the hour, not at the next recompute.
function onMemberJoin(guild, member) {
  const now = Date.now();
  recentJoins.push(member.joinedTimestamp || now);
  recentJoins = recentJoins.filter(t => t >= now - 2 * DAY);
  checkInflux(guild, now);
}

function checkInflux(guild, now) {
  const lastHour = recentJoins.filter(t => t >= now - HOUR).length;
  const baseHourly = (cache.baselineDaily || 0) / 24;
  const factor = Number(config.influxFactor) || 5;
  const minJoins = Number(config.influxMinJoins) || 10;
  const isInflux = lastHour >= minJoins && lastHour >= factor * Math.max(baseHourly, 0.1);
  if (isInflux && !persisted.influxActive) {
    persisted.influxActive = true;
    const cooldownMs = (Number(config.influxWarnCooldownHours) || 6) * HOUR;
    if (now - (persisted.lastInfluxWarnTs || 0) >= cooldownMs) { persisted.lastInfluxWarnTs = now; warnInflux(guild, lastHour, baseHourly).catch(() => {}); }
    save();
  } else if (!isInflux && persisted.influxActive) {
    persisted.influxActive = false; save();               // reset so the NEXT spike can warn again (after cooldown)
  }
}

async function warnInflux(guild, lastHour, baseHourly) {
  const chId = config.influxWarnChannelId || config.modAnnounceChannelId;
  const ch = chId && await guild.channels.fetch(chId).catch(() => null);
  if (!ch) return;
  const mult = baseHourly > 0 ? `~${Math.round(lastHour / baseHourly)}×` : 'well above';
  const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('📈 Influx detected')
    .setDescription(`**${lastHour} members joined in the last hour**: ${mult} the normal rate.`)
    .addFields(
      { name: 'What the bot is doing', value: 'During a spike the **new-account flag naturally tightens** as the join distribution shifts (refreshed hourly), so only the very freshest accounts keep the ⚠ note, not every new arrival.' },
      { name: 'Worth a glance', value: 'If this is a **raid** (coordinated joins + immediate rule-breaking) rather than organic growth, consider pausing invites / raising verification. If it’s just growth, nothing to do.' })
    .setFooter({ text: 'Auto heads-up · influx sensitivity = influxFactor / influxMinJoins (env)' }).setTimestamp(new Date());
  await ch.send({ embeds: [embed] }).catch(e => console.error('[freshwatch] influx warn:', e.message));
}

// The human-facing note for a flag/lab card, or null. NEVER passed to the AI judge.
function noteFor(member) {
  const mode = config.smartWatchFreshMode || 'off';
  const joined = member?.joinedTimestamp;
  if (mode === 'off' || !joined) return null;
  const now = Date.now();
  let fresh = false, tail = '';
  if (mode === 'manual') {
    const h = Number(config.smartWatchFreshHours) || 0;
    fresh = h > 0 && (now - joined) <= h * HOUR;
  } else {                                                // auto
    if (cache.autoCutoffTs) { fresh = joined >= cache.autoCutoffTs; tail = ` · _newest ~${Number(config.smartWatchFreshPercentile) || 1}% of the server_`; }
  }
  return fresh ? `⚠️ **Recently joined**: ${agoText(now - joined)}${tail}` : null;
}

// Dashboard summary.
function status() {
  const mode = config.smartWatchFreshMode || 'off';
  return { mode, hours: Number(config.smartWatchFreshHours) || 0, percentile: Number(config.smartWatchFreshPercentile) || 1,
    influxActive: !!persisted.influxActive, sampleSize: cache.sampleSize, cutoffTs: cache.autoCutoffTs, computedAt: cache.computedAt };
}

module.exports = { recompute, onMemberJoin, noteFor, status };
