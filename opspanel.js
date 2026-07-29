// opspanel.js — a single pinned, self-updating "Ops" control panel in #commands. Shows live pipeline
// status (apps, last check, governor mode, Apple throttle, failed queue) and the most-used actions as
// buttons, so the owner drives the pipeline without typing slash commands. The panel's message ID is
// persisted locally so it survives restarts — edit-in-place, pinned once, never reposted.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { jsonFile, latestWorkflowRun, dispatchWorkflowRun, github } = require('./github');
const { channelIdForCategory } = require('./channels');

const PANEL_FILE = process.env.SOURCEKIT_PANEL_FILE || `${process.env.HOME || '/home/ubuntu'}/.sourcekit_ops_panel.json`;

function loadRef() { try { return JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8')); } catch { return {}; } }
function saveRef(ref) { try { fs.writeFileSync(PANEL_FILE, JSON.stringify(ref)); } catch (e) { console.error('[opspanel] save:', e.message); } }

async function repoVar(name) {
  try { const v = await github(`/actions/variables/${name}`); return (v && v.value) || null; } catch { return null; }
}

async function gatherStatus() {
  const [apps, failed, igg, lastRun, gov] = await Promise.all([
    jsonFile('apps_config.json', { apps: {} }),
    jsonFile('failed_patches.json', {}),
    jsonFile('iosgods_notifications_state.json', {}),
    latestWorkflowRun('check_versions.yml').catch(() => null),
    repoVar('SOURCEKIT_RATE_GOVERNOR'),
  ]);
  const rl = (igg && igg.rate_limit) || {};
  return {
    appCount: Object.keys((apps && apps.apps) || {}).length,
    failedCount: Object.keys(failed || {}).length,
    throttle: Number(rl.throttle_level || 0),
    lastAlert: Number(rl.last_alert || 0),
    lastRun,
    gov: gov || 'shadow',
  };
}

function buildPanel(s) {
  const healthy = s.throttle === 0 && s.failedCount === 0;
  const runLine = s.lastRun
    ? `<t:${Math.floor(new Date(s.lastRun.created_at).getTime() / 1000)}:R> · ${s.lastRun.conclusion || s.lastRun.status}`
    : 'unknown';
  const embed = new EmbedBuilder()
    .setColor(healthy ? 0x34c759 : (s.throttle ? 0xff3b30 : 0xff9500))
    .setDescription(
      `**Apps tracked:** ${s.appCount}\n` +
      `**Last version check:** ${runLine}\n` +
      `**Rate governor:** \`${s.gov}\`\n` +
      `**Apple throttle:** ${s.throttle === 0 ? 'Level 0 — clear ✅' : `⚠️ Level ${s.throttle}`}` +
        `${s.lastAlert ? ` · last alert <t:${Math.floor(s.lastAlert)}:R>` : ''}\n` +
      `**Failed patches queued:** ${s.failedCount}`)
    .setFooter({ text: 'Auto-refreshes · click a button to act' })
    .setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ops_recheck').setEmoji('🔄').setLabel('Re-check now').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ops_retry').setEmoji('🔁').setLabel(`Retry failed${s.failedCount ? ` (${s.failedCount})` : ''}`).setStyle(ButtonStyle.Secondary).setDisabled(s.failedCount === 0),
    new ButtonBuilder().setCustomId('ops_refresh').setEmoji('📊').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  return { content: '## 🛠️ SourceKit Ops', embeds: [embed], components: [row] };
}

async function ensurePanel(client) {
  try {
    const chId = channelIdForCategory('commands');
    if (!chId) return console.error('[opspanel] no commands channel configured');
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) return;
    const payload = buildPanel(await gatherStatus());
    const ref = loadRef();
    if (ref.channelId === chId && ref.messageId) {
      const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
      if (msg) { await msg.edit(payload); return; }   // edit the existing panel in place
    }
    const msg = await ch.send(payload);
    await msg.pin().catch(() => {});
    saveRef({ channelId: chId, messageId: msg.id });
    console.log(`[opspanel] created + pinned panel ${msg.id}`);
  } catch (e) { console.error('[opspanel] ensure:', e.message); }
}

async function refreshPanel(client) {
  try {
    const ref = loadRef();
    if (!ref.messageId || !ref.channelId) return ensurePanel(client);
    const ch = await client.channels.fetch(ref.channelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
    if (!msg) return ensurePanel(client);
    await msg.edit(buildPanel(await gatherStatus()));
  } catch (e) { console.error('[opspanel] refresh:', e.message); }
}

function isPanelButton(interaction) {
  return interaction.isButton?.() && interaction.customId?.startsWith('ops_');
}

async function handlePanelButton(interaction) {
  const id = interaction.customId;
  await interaction.deferReply({ ephemeral: true });
  try {
    if (id === 'ops_recheck') {
      await dispatchWorkflowRun('check_versions.yml', {});
      await interaction.editReply('🔄 Version check dispatched.');
    } else if (id === 'ops_retry') {
      const queue = await jsonFile('failed_patches.json', {});
      const entries = Object.values(queue).filter(e => e && e.retryable !== false);
      for (const e of entries) {
        await dispatchWorkflowRun('auto_patch.yml', { bundle_id: e.bundle_id, version: e.version || '', delay: '', dry_run: 'false' });
      }
      await interaction.editReply(entries.length ? `🔁 Dispatched retry for ${entries.length} patch(es).` : 'Nothing retryable in the queue.');
    } else if (id === 'ops_refresh') {
      await interaction.editReply('📊 Refreshed.');
    } else {
      await interaction.editReply('Unknown action.');
    }
  } catch (e) {
    await interaction.editReply(`Error: ${e.message}`);
  }
  await refreshPanel(interaction.client);   // reflect the action immediately
}

module.exports = { ensurePanel, refreshPanel, isPanelButton, handlePanelButton };
