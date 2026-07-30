// roleselect.js — bot-owned self-assign role pickers for #roles, replacing the old plain-text +
// Carl-bot-reaction system (no code, no exclusivity, no way for this bot to intervene). Mirrors
// bubble-girl's self-assign picker pattern (index.js's buildRolePicker/ensureRolePicker), extended with
// a single-select category type for colors + age (age also gets real exclusivity + the registration-lock
// backstop in index.js — this module only renders the picker and does the toggle/single-select mechanic).
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');

const DIVIDER_IMAGE = path.join(__dirname, '..', '..', 'apps', 'fubu-verify-bot', 'assets', 'roles_divider.png');
const STATE_FILE = process.env.FUBU_ROLESELECT_FILE || '/home/ubuntu/.fubu_roleselect.json';

function _load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { messageIds: [] }; } }
function _save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[roleselect] save:', e.message); } }

// key -> { title, roleId } for name lookups; COLOR/AGE render as a single-select dropdown, everything
// else renders as toggle buttons (add-if-missing/remove-if-present — same as the old reactions did).
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
const REGIONS = [
  ['🦒 Africa', '1501649805045141694'], ['🐼 Asia', '1501649802759508235'], ['🐂 Europe', '1501649800968278192'],
  ['🦈 Oceania', '1501649803774267422'], ['🐆 South America', '1501649802642063380'], ['🦅 North America', '1501649801677111508'],
];
const INTERESTS = [
  ['🎮 Gaming', '1527426980226797680'], ['🎶 Music', '1527427317125746778'], ['📞 Calling', '1527427436827119686'],
  ['⚠️ Important pings', '1527427606977314956'], ['🎥 Movies', '1527427164427784214'], ['❤️‍🩹 Revive', '1527427714401697842'],
];
const PRONOUNS = [
  ['She/Her', '1517716868650242098'], ['He/Him', '1517717104399220856'],
  ['They/Them', '1517717292392251483'], ['Others (ask)', '1526939765667008615'],
];
const MISC = [
  ['🇫🇷 French chat access', '1529939544391159979'], ['🤾 Event ping', '1531010348126044412'], ['😂 OK to be tagged for jokes', '1529934697688465458'],
];

function toggleRow(customPrefix, items) {
  return new ActionRowBuilder().addComponents(items.map(([label, roleId]) =>
    new ButtonBuilder().setCustomId(`${customPrefix}:${roleId}`).setLabel(label).setStyle(ButtonStyle.Secondary)));
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function colorSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('roleselect_color').setPlaceholder('Pick your color…')
      .addOptions(COLORS.map(([label, roleId]) => ({ label, value: roleId }))));
}
function ageSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('roleselect_age').setPlaceholder('Pick your age bracket…')
      .addOptions(AGE.map(([label, roleId]) => ({ label, value: roleId }))));
}

function dividerAttachment() {
  return fs.existsSync(DIVIDER_IMAGE) ? [new AttachmentBuilder(DIVIDER_IMAGE, { name: 'divider.png' })] : [];
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
  const post = async payload => { const m = await ch.send(payload); posted.push(m.id); await new Promise(r => setTimeout(r, 700)); };

  await post({ content: '# 🎓 Get Your Roles\nPick from each section below — click a button to toggle it on/off, or use the dropdowns for color and age (those replace your current pick, one at a time).' });
  await post({ content: '## 🎨 Color', components: [colorSelectRow()] });
  await post({ files: dividerAttachment() });
  await post({ content: '## 🎂 Age — pick once at registration, locked after you verify (see rule 3)', components: [ageSelectRow()] });
  await post({ files: dividerAttachment() });
  await post({ content: '## 🌍 Region', components: chunk(REGIONS, 5).map(c => toggleRow('roleselect_toggle', c)) });
  await post({ files: dividerAttachment() });
  await post({ content: '## 🔔 Notifications', components: chunk(INTERESTS, 5).map(c => toggleRow('roleselect_toggle', c)) });
  await post({ files: dividerAttachment() });
  await post({ content: '## 🔞 MDNI — adults only, also locked after verification', components: [toggleRow('roleselect_mdni', [['🔞 MDNI (Minors Do Not Interact)', '1519408206370308197']])] });
  await post({ files: dividerAttachment() });
  await post({ content: '## 🏳️‍🌈 Pronouns', components: chunk(PRONOUNS, 5).map(c => toggleRow('roleselect_toggle', c)) });
  await post({ files: dividerAttachment() });
  await post({ content: '## ✨ Misc', components: chunk(MISC, 5).map(c => toggleRow('roleselect_toggle', c)) });

  st.messageIds = posted; _save(st);
  return { ok: true, posted: posted.length };
}

module.exports = { COLORS, AGE, REGIONS, INTERESTS, PRONOUNS, MISC, colorSelectRow, ageSelectRow, toggleRow, rebuild };
