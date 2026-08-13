// roleselect.js — bot-owned self-assign role pickers for #roles, replacing the old plain-text +
// Carl-bot-reaction system (no code, no exclusivity, no way for this bot to intervene). Mirrors
// bubble-girl's self-assign picker pattern (index.js's buildRolePicker/ensureRolePicker), extended with
// a single-select category type for colors + age (age also gets real exclusivity + the registration-lock
// backstop in index.js — this module only renders the picker and does the toggle/single-select mechanic).
//
// #roles messages are NEVER edited in place (the owner doesn't want the Discord "(edited)" marker) — any
// change deletes the affected message and every message after it (to keep the fixed section order), then
// reposts from there. The block list below is a FIXED 16-slot layout so a given section always lands at
// the same index regardless of which sections currently have roles in them (an empty section still posts
// its heading with a placeholder line, so indices never shift).
const fs = require('fs');
const { statePath } = require('./statepath');
const copy = require('./copy');
const config = require('./config');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
const { ensureMembers } = require('./memberCache');

const STATE_FILE = process.env.FUBU_ROLESELECT_FILE || statePath('roleselect.json');
const SECTIONS_FILE = process.env.FUBU_ROLESELECT_SECTIONS_FILE || statePath('roleselect_sections.json');

function _load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { messageIds: [] }; } }
function _save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[roleselect] save:', e.message); } }

// Every section — including age/colors — is persisted per-guild in SECTIONS_FILE (resolved via
// statePath(), which is FUBU_STATE_DIR-scoped, so FUBU and Melanin each get their own file). DEFAULT_SECTIONS
// only seeds a guild that has NO sections file yet at all, and is deliberately empty: this file used to hold
// FUBU's specific role IDs as the "default" for every guild, which silently broke Melanin's picker (every
// age/color option pointed at a role that only exists on FUBU) the first time it needed a fresh seed. Age and
// colors need real per-guild role IDs added via /roleselect-role before they'll show any options.
const SECTION_ORDER = ['age', 'colors', 'region', 'language', 'notifications', 'pronouns', 'misc'];
// Rendered as an exclusive single-select dropdown (pick one, picking another swaps it) instead of toggle
// buttons — 'colors' also gets a "no color (clear)" option appended.
const EXCLUSIVE_SECTIONS = new Set(['age', 'colors']);
const SECTION_TITLE = {
  age: '🎂 Age', colors: '🎨 Color', region: '🌍 Region', language: '🗣️ Language', notifications: '🔔 Notifications',
  pronouns: '🏳️‍🌈 Identity', misc: '✨ Misc',
};
// Fixed block index (0-based) for each section's HEADING message — stable regardless of section
// content, so "which message(s) to delete+resend" never needs to be recomputed from scratch.
const SECTION_BLOCK_INDEX = { age: 1, region: 5, language: 7, notifications: 9, pronouns: 11, misc: 13, colors: 15 };
const DEFAULT_SECTIONS = { age: [], colors: [], region: [], language: [], notifications: [], pronouns: [], misc: [] };

function loadSections() {
  try { return JSON.parse(fs.readFileSync(SECTIONS_FILE, 'utf8')); }
  catch { const seeded = JSON.parse(JSON.stringify(DEFAULT_SECTIONS)); saveSections(seeded); return seeded; }
}
function saveSections(s) { try { fs.writeFileSync(SECTIONS_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[roleselect] sections save:', e.message); } }

// Add/remove a role from a persisted section. Returns { ok, error } — caller (index.js) still has to
// call rebuildFromIndex(SECTION_BLOCK_INDEX[section]) afterward to actually push the change to Discord.
function addRoleToSection(section, label, roleId) {
  if (!SECTION_ORDER.includes(section)) return { ok: false, error: `Unknown section "${section}".` };
  const s = loadSections();
  if (s[section].some(([, id]) => id === roleId)) return { ok: false, error: copy.roleselect.alreadyInSection };
  s[section].push([label, roleId]);
  saveSections(s);
  return { ok: true };
}
function removeRoleFromSection(section, roleId) {
  if (!SECTION_ORDER.includes(section)) return { ok: false, error: `Unknown section "${section}".` };
  const s = loadSections();
  const before = s[section].length;
  s[section] = s[section].filter(([, id]) => id !== roleId);
  if (s[section].length === before) return { ok: false, error: copy.roleselect.notInSection };
  saveSections(s);
  return { ok: true };
}

function toggleRow(customPrefix, items) {
  return new ActionRowBuilder().addComponents(items.map(([label, roleId]) =>
    new ButtonBuilder().setCustomId(`${customPrefix}:${roleId}`).setLabel(label).setStyle(ButtonStyle.Secondary)));
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function AGE() { return loadSections().age || []; }
function COLORS() { return loadSections().colors || []; }
function colorSelectRow() {
  const items = COLORS();
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('roleselect_color').setPlaceholder('Pick your color…')
      .addOptions(
        ...items.map(([label, roleId]) => ({ label, value: roleId })),
        { label: '🚫 No color (clear)', value: 'none' }));
}
function ageSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('roleselect_age').setPlaceholder('Pick your age bracket…')
      .addOptions(AGE().map(([label, roleId]) => ({ label, value: roleId }))));
}
// Right below the age bracket picker — same idea (age-adjacent), opens the same modal /birthday set drives.
function birthdayButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('roleselect_birthday_open').setLabel('Set Birthday').setEmoji('🎉').setStyle(ButtonStyle.Secondary));
}

// Replaces the old static "Others (ask)" toggle role (owner, 2026-08-13) — instead of a generic role that
// just signaled "ask me", this opens a modal so a member can directly say what role they're actually
// looking for. Posts to the same staff channel /request-role already uses; index.js's handler does the rest.
function askRoleButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('roleselect_askrole').setLabel('Others (ask)').setEmoji('🙋').setStyle(ButtonStyle.Secondary));
}

// Separator between blocks — config.rolesDividerImage is per-community (env var), so each guild gets its
// OWN banner instead of one shared asset (the bug: a single hardcoded FUBU-branded image got posted into
// every other guild's #roles too, found live on Melanin). Falls back to a plain text divider when unset
// or the file's missing, rather than posting nothing (an empty message payload isn't valid).
function dividerBlock() {
  if (config.rolesDividerImage && fs.existsSync(config.rolesDividerImage)) {
    return { files: [new AttachmentBuilder(config.rolesDividerImage, { name: 'divider.png' })] };
  }
  return { content: '⸻⸻⸻' };
}

function sectionBlock(key) {
  const items = loadSections()[key] || [];
  if (key === 'age') {
    // The birthday button is independent of age brackets — always show it, even on a guild with no
    // age-bracket roles configured yet (e.g. Melanin, which never had equivalent roles to FUBU's).
    const rows = items.length ? [ageSelectRow(), birthdayButtonRow()] : [birthdayButtonRow()];
    return { content: copy.roleselect.ageHeading, components: rows };
  }
  if (key === 'colors') {
    if (!items.length) return { content: copy.roleselect.sectionEmpty(copy.roleselect.colorHeading) };
    return { content: copy.roleselect.colorHeading, components: [colorSelectRow()] };
  }
  const heading = `## ${SECTION_TITLE[key]}`;
  if (key === 'pronouns') {
    // Identity section (pronouns + LGBTQ+/Ally + whatever gets added later) always carries the
    // "Ask for a role" button, even with zero toggle roles configured yet.
    const rows = items.length ? [...chunk(items, 5).map(c => toggleRow('roleselect_toggle', c)), askRoleButtonRow()] : [askRoleButtonRow()];
    return { content: heading, components: rows };
  }
  if (!items.length) return { content: copy.roleselect.sectionEmpty(heading) };
  return { content: heading, components: chunk(items, 5).map(c => toggleRow('roleselect_toggle', c)) };
}

// The Tribes block — a descriptive section + a pledge dropdown. The loyalty rules (first tribe free,
// then release + acceptance) are enforced in the roleselect_tribe handler, not here. Null if no tribes.
// Each line also shows the tribe's current leader(s) as mentions — a role can technically have more than
// one holder even though the framework expects one leader, so this lists everyone currently holding it.
function tribeBlock(guild) {
  const tribes = require('./tribes');
  const list = tribes.all();
  if (!list.length) return null;
  const lines = list.map(t => {
    const leaderRole = guild && t.leaderRoleId ? guild.roles.cache.get(t.leaderRoleId) : null;
    const leaderIds = leaderRole ? [...leaderRole.members.keys()] : [];
    const leaderText = leaderIds.length ? ` (led by ${leaderIds.map(id => `<@${id}>`).join(', ')})` : '';
    return `> ${t.emoji || '🏴'} **${t.shortName || t.name}**${t.motto ? ` · *${t.motto}*` : ''}${leaderText}`;
  });
  const content = '## 🏴 Tribes\n'
    + 'Pledge your allegiance. Your **first** tribe is a free choice, but once you join, you can’t leave or switch on your own: a tribe’s **leader must release you**, and after that any new tribe must **accept you** (`/request-role` or a leader’s invite).\n\n'
    + lines.join('\n');
  const menu = new StringSelectMenuBuilder().setCustomId('roleselect_tribe').setPlaceholder('Pledge to a tribe…')
    .addOptions(list.slice(0, 25).map(t => ({ label: `${t.emoji || '🏴'} ${t.shortName || t.name}`.slice(0, 100), value: t.key, description: (t.motto || 'A tribe of the server').slice(0, 100) })));
  return { content, components: [new ActionRowBuilder().addComponents(menu)] };
}

// Fixed 16-slot layout — index N always means the same thing, so a section's heading never moves even
// when other sections gain/lose roles. Keep this in sync with SECTION_BLOCK_INDEX above.
function buildBlocks(guild) {
  return [
    { content: copy.roleselect.header },
    sectionBlock('age'),
    dividerBlock(),
    { content: copy.roleselect.mdniHeading, components: [toggleRow('roleselect_mdni', [['🔞 MDNI (Minors Do Not Interact)', config.mdniRoleId]])] },
    dividerBlock(),
    sectionBlock('region'),
    dividerBlock(),
    sectionBlock('language'),
    dividerBlock(),
    sectionBlock('notifications'),
    dividerBlock(),
    sectionBlock('pronouns'),
    dividerBlock(),
    sectionBlock('misc'),
    dividerBlock(),
    sectionBlock('colors'),
    dividerBlock(),
    tribeBlock(guild),
  ].filter(Boolean);
}

// Append the Tribes block to an ALREADY-BUILT #roles (the picker is idempotent-built, so a full rebuild
// would skip). Posts a divider + the block and tracks the new message IDs. Skips if already appended.
async function appendTribeBlock(guild, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return { ok: false, error: 'roles channel not found' };
  await ensureMembers(guild);   // role.members only reflects the cache
  const block = tribeBlock(guild);
  if (!block) return { ok: false, error: 'no tribes registered' };
  const st = _load();
  // idempotency: bail if a roleselect_tribe menu is already posted in the channel
  const existing = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (existing && [...existing.values()].some(m => m.components?.some(r => r.components?.some(c => c.customId === 'roleselect_tribe'))))
    return { ok: true, alreadyPosted: true };
  const dm = await ch.send(dividerBlock()); (st.messageIds ||= []).push(dm.id); await new Promise(r => setTimeout(r, 500));
  const m = await ch.send(block); (st.messageIds ||= []).push(m.id); _save(st);
  return { ok: true, id: m.id };
}

// Self-heal: drop any section entry whose role no longer exists in the server (an admin can delete a custom
// role from Discord's UI directly, with no way for the bot to know — found live: "OK to be tagged for jokes"
// pointed at a role deleted a while back, and stayed clickable-but-broken in #roles until spotted by hand).
// Sweeps every SECTION_ORDER section, removes dead entries, and re-renders only the sections that changed.
// Returns { sectionKey: [removedLabel, ...] } for whatever it cleaned up (empty object if nothing was stale).
async function sweepDeadRoles(guild, channelId) {
  await guild.roles.fetch().catch(() => {});
  const sections = loadSections();
  const removed = {};
  for (const key of SECTION_ORDER) {
    const dead = (sections[key] || []).filter(([, id]) => !guild.roles.cache.has(id));
    if (!dead.length) continue;
    for (const [, id] of dead) removeRoleFromSection(key, id);
    removed[key] = dead.map(([label]) => label);
  }
  for (const key of Object.keys(removed)) await rebuildFromIndex(guild, channelId, SECTION_BLOCK_INDEX[key]).catch(() => {});
  return removed;
}

// Re-render the ALREADY-POSTED tribe picker with the current tribe list — call this whenever a tribe is
// founded so a newly created tribe actually shows up as a pledge option, not just in tribes.all() internally.
// The picker's OPTIONS are baked into the message at send time, so a new tribe never appears on its own.
async function refreshTribeBlock(guild, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return { ok: false, error: 'roles channel not found' };
  await ensureMembers(guild);   // role.members only reflects the cache
  const block = tribeBlock(guild);
  if (!block) return { ok: false, error: 'no tribes registered' };
  const existing = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  const msg = existing && [...existing.values()].find(m => m.components?.some(r => r.components?.some(c => c.customId === 'roleselect_tribe')));
  if (!msg) return appendTribeBlock(guild, channelId);   // picker was never posted — post it now instead
  await msg.edit(block).catch(() => {});
  return { ok: true, id: msg.id };
}

// Delete every existing message in #roles (the old plain-text + Carl-bot-reaction system) and post the
// new bot-owned pickers in the same section order, with the same divider image between each. Tracks the
// posted message IDs so a re-run doesn't need to re-delete (idempotent: skips if already posted).
async function rebuild(guild, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return { ok: false, error: 'roles channel not found' };
  const st = _load();
  if (st.messageIds && st.messageIds.length) return { ok: true, alreadyBuilt: true };

  const old = await ch.messages.fetch({ limit: 100 });
  for (const m of old.values()) { await m.delete().catch(() => {}); await new Promise(r => setTimeout(r, 350)); }

  await ensureMembers(guild);   // role.members only reflects the cache
  const posted = [];
  for (const block of buildBlocks(guild)) {
    const m = await ch.send(block);
    posted.push(m.id);
    await new Promise(r => setTimeout(r, 700));
  }
  st.messageIds = posted; _save(st);
  return { ok: true, posted: posted.length };
}

// Partial update: delete the message at fromIndex and every message after it (never edit in place —
// owner preference, avoids the "(edited)" marker), then repost fresh from that point on. Used whenever
// a section's role list changes after the initial build.
async function rebuildFromIndex(guild, channelId, fromIndex) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return { ok: false, error: 'roles channel not found' };
  const st = _load();
  const ids = st.messageIds || [];
  if (!ids.length) return rebuild(guild, channelId);

  for (let i = fromIndex; i < ids.length; i++) {
    const m = await ch.messages.fetch(ids[i]).catch(() => null);
    if (m) await m.delete().catch(() => {});
    await new Promise(r => setTimeout(r, 350));
  }

  await ensureMembers(guild);   // role.members only reflects the cache
  const blocks = buildBlocks(guild);
  const newIds = ids.slice(0, fromIndex);
  for (let i = fromIndex; i < blocks.length; i++) {
    const m = await ch.send(blocks[i]);
    newIds.push(m.id);
    await new Promise(r => setTimeout(r, 700));
  }
  st.messageIds = newIds; _save(st);
  return { ok: true, reposted: blocks.length - fromIndex };
}

module.exports = {
  COLORS, AGE, colorSelectRow, ageSelectRow, toggleRow, rebuild, rebuildFromIndex, appendTribeBlock, refreshTribeBlock, sweepDeadRoles,
  loadSections, addRoleToSection, removeRoleFromSection, SECTION_ORDER, SECTION_TITLE, SECTION_BLOCK_INDEX,
};
