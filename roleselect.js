// roleselect.js - bot-owned self-assign role pickers for #roles, replacing the old plain-text +
// Carl-bot-reaction system (no code, no exclusivity, no way for this bot to intervene). Mirrors
// bubble-girl's self-assign picker pattern (index.js's buildRolePicker/ensureRolePicker), extended with
// a single-select category type for colors + age (age also gets real exclusivity + the registration-lock
// backstop in index.js - this module only renders the picker and does the toggle/single-select mechanic).
//
// #roles messages are NEVER edited in place (the owner doesn't want the Discord "(edited)" marker) - any
// change deletes the affected message and every message after it (to keep the fixed section order), then
// reposts from there. The block list below is a FIXED 16-slot layout so a given section always lands at
// the same index regardless of which sections currently have roles in them (an empty section still posts
// its heading with a placeholder line, so indices never shift).
const fs = require('fs');
const copy = require('./copy');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');

const DIVIDER_IMAGE = path.join(__dirname, 'assets', 'roles_divider.png');
const STATE_FILE = process.env.FUBU_ROLESELECT_FILE || '/home/ubuntu/.fubu_roleselect.json';
const SECTIONS_FILE = process.env.FUBU_ROLESELECT_SECTIONS_FILE || '/home/ubuntu/.fubu_roleselect_sections.json';

function _load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { messageIds: [] }; } }
function _save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[roleselect] save:', e.message); } }

// key -> { title, roleId } for name lookups; COLOR/AGE render as a single-select dropdown, everything
// else renders as toggle buttons (add-if-missing/remove-if-present - same as the old reactions did).
const COLORS = [
  ['Light Red', '1526943410269716561'], ['Red', '1526943228790706247'], ['Dark Red', '1516193430064201758'],
  ['Light Orange', '1526943020124078290'], ['Orange', '1516193779202392094'], ['Dark Orange', '1526942927023247550'],
  ['Light Yellow', '1526942462462132265'], ['Yellow', '1516194519526408223'], ['Dark Yellow', '1526942347504521236'],
  ['Light Green', '1526941426187763772'], ['Green', '1526941282923188327'], ['Dark Green', '1516194696530100296'],
  ['Light Blue', '1526943835727593573'], ['Blue', '1516194836078657577'], ['Dark Blue', '1526943715850190879'],
  ['Light Purple', '1526941929986719911'], ['Purple', '1516194924402446448'], ['Dark Purple', '1526941828811591710'],
  ['Light Pink', '1526940998545182931'], ['Pink', '1526940905095823482'], ['Dark Pink', '1516195011463614555'],
];
const AGE = [
  ['16-17', '1516185172213628989'], ['18-21', '1516185300492222618'],
  ['21-25', '1516185358415433739'], ['25-30+', '1516209186839466113'],
];

// Generic toggle-button sections - persisted + admin-editable via /roleselect-role, seeded once from
// these defaults. After the first load the FILE is the source of truth, not these consts.
const SECTION_ORDER = ['region', 'language', 'notifications', 'pronouns', 'misc'];
const SECTION_TITLE = {
  region: '🌍 Region', language: '🗣️ Language', notifications: '🔔 Notifications',
  pronouns: '🏳️‍🌈 Pronouns', misc: '✨ Misc',
};
// Fixed block index (0-based) for each section's HEADING message - stable regardless of section
// content, so "which message(s) to delete+resend" never needs to be recomputed from scratch.
const SECTION_BLOCK_INDEX = { region: 5, language: 7, notifications: 9, pronouns: 11, misc: 13 };
const DEFAULT_SECTIONS = {
  region: [
    ['🦒 Africa', '1501649805045141694'], ['🐼 Asia', '1501649802759508235'], ['🐂 Europe', '1501649800968278192'],
    ['🦈 Oceania', '1501649803774267422'], ['🐆 South America', '1501649802642063380'], ['🦅 North America', '1501649801677111508'],
  ],
  language: [
    ['🇫🇷 French', '1529939544391159979'], ['🇩🇪 German', '1532221881631903795'],
    ['🇳🇱 Dutch', '1532221882563301468'], ['🇪🇸 Hispanic', '1532221883385380924'],
  ],
  notifications: [
    ['🎮 Gaming', '1527426980226797680'], ['🎶 Music', '1527427317125746778'], ['📞 Calling', '1527427436827119686'],
    ['⚠️ Important pings', '1527427606977314956'], ['🎥 Movies', '1527427164427784214'], ['❤️‍🩹 Revive', '1527427714401697842'],
    ['🤾 Event ping', '1531010348126044412'], ['😂 OK to be tagged for jokes', '1529934697688465458'],
  ],
  pronouns: [
    ['She/Her', '1517716868650242098'], ['He/Him', '1517717104399220856'],
    ['They/Them', '1517717292392251483'], ['Others (ask)', '1526939765667008615'],
  ],
  misc: [],
};

function loadSections() {
  try { return JSON.parse(fs.readFileSync(SECTIONS_FILE, 'utf8')); }
  catch { const seeded = JSON.parse(JSON.stringify(DEFAULT_SECTIONS)); saveSections(seeded); return seeded; }
}
function saveSections(s) { try { fs.writeFileSync(SECTIONS_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[roleselect] sections save:', e.message); } }

// Add/remove a role from a persisted section. Returns { ok, error } - caller (index.js) still has to
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

function colorSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('roleselect_color').setPlaceholder('Pick your color…')
      .addOptions(
        ...COLORS.map(([label, roleId]) => ({ label, value: roleId })),
        { label: '🚫 No color (clear)', value: 'none' }));
}
function ageSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('roleselect_age').setPlaceholder('Pick your age bracket…')
      .addOptions(AGE.map(([label, roleId]) => ({ label, value: roleId }))));
}

function dividerAttachment() {
  return fs.existsSync(DIVIDER_IMAGE) ? [new AttachmentBuilder(DIVIDER_IMAGE, { name: 'divider.png' })] : [];
}

function sectionBlock(key) {
  const items = loadSections()[key] || [];
  const heading = `## ${SECTION_TITLE[key]}`;
  if (!items.length) return { content: copy.roleselect.sectionEmpty(heading) };
  return { content: heading, components: chunk(items, 5).map(c => toggleRow('roleselect_toggle', c)) };
}

// The Tribes block - a descriptive section + a pledge dropdown. The loyalty rules (first tribe free,
// then release + acceptance) are enforced in the roleselect_tribe handler, not here. Null if no tribes.
function tribeBlock() {
  const tribes = require('./tribes');
  const list = tribes.all();
  if (!list.length) return null;
  const lines = list.map(t => `> ${t.emoji || '🏴'} **${t.shortName || t.name}**${t.motto ? ` - *${t.motto}*` : ''}`);
  const content = '## 🏴 Tribes\n'
    + 'Pledge your allegiance. Your **first** tribe is a free choice - but once you join, you can’t leave or switch on your own: a **Warden must release you**, and after that any new tribe must **accept you** (`/request-role` or a Warden invite).\n\n'
    + lines.join('\n');
  const menu = new StringSelectMenuBuilder().setCustomId('roleselect_tribe').setPlaceholder('Pledge to a tribe…')
    .addOptions(list.slice(0, 25).map(t => ({ label: `${t.emoji || '🏴'} ${t.shortName || t.name}`.slice(0, 100), value: t.key, description: (t.motto || 'A tribe of the server').slice(0, 100) })));
  return { content, components: [new ActionRowBuilder().addComponents(menu)] };
}

// Fixed 16-slot layout - index N always means the same thing, so a section's heading never moves even
// when other sections gain/lose roles. Keep this in sync with SECTION_BLOCK_INDEX above.
function buildBlocks() {
  return [
    { content: copy.roleselect.header },
    { content: copy.roleselect.ageHeading, components: [ageSelectRow()] },
    { files: dividerAttachment() },
    { content: copy.roleselect.mdniHeading, components: [toggleRow('roleselect_mdni', [['🔞 MDNI (Minors Do Not Interact)', '1519408206370308197']])] },
    { files: dividerAttachment() },
    sectionBlock('region'),
    { files: dividerAttachment() },
    sectionBlock('language'),
    { files: dividerAttachment() },
    sectionBlock('notifications'),
    { files: dividerAttachment() },
    sectionBlock('pronouns'),
    { files: dividerAttachment() },
    sectionBlock('misc'),
    { files: dividerAttachment() },
    { content: copy.roleselect.colorHeading, components: [colorSelectRow()] },
    { files: dividerAttachment() },
    tribeBlock(),
  ].filter(Boolean);
}

// Append the Tribes block to an ALREADY-BUILT #roles (the picker is idempotent-built, so a full rebuild
// would skip). Posts a divider + the block and tracks the new message IDs. Skips if already appended.
async function appendTribeBlock(guild, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return { ok: false, error: 'roles channel not found' };
  const block = tribeBlock();
  if (!block) return { ok: false, error: 'no tribes registered' };
  const st = _load();
  // idempotency: bail if a roleselect_tribe menu is already posted in the channel
  const existing = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (existing && [...existing.values()].some(m => m.components?.some(r => r.components?.some(c => c.customId === 'roleselect_tribe'))))
    return { ok: true, alreadyPosted: true };
  const div = dividerAttachment();
  if (div.length) { const dm = await ch.send({ files: div }); (st.messageIds ||= []).push(dm.id); await new Promise(r => setTimeout(r, 500)); }
  const m = await ch.send(block); (st.messageIds ||= []).push(m.id); _save(st);
  return { ok: true, id: m.id };
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

  const posted = [];
  for (const block of buildBlocks()) {
    const m = await ch.send(block);
    posted.push(m.id);
    await new Promise(r => setTimeout(r, 700));
  }
  st.messageIds = posted; _save(st);
  return { ok: true, posted: posted.length };
}

// Partial update: delete the message at fromIndex and every message after it (never edit in place -
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

  const blocks = buildBlocks();
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
  COLORS, AGE, colorSelectRow, ageSelectRow, toggleRow, rebuild, rebuildFromIndex, appendTribeBlock,
  loadSections, addRoleToSection, removeRoleFromSection, SECTION_ORDER, SECTION_TITLE, SECTION_BLOCK_INDEX,
};
