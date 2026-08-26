// partnerships.js — server partnerships (owner, 2026-08-26: "Need a system for partnerships. A channel
// and a way to add them"). One channel holds an embed per partner server; staff manage the list entirely
// through /partner (no hand-edited JSON — the no-agent-only-capabilities rule).
//
// Build-hidden-until-done (standing owner rule): setup creates the channel STAFF-ONLY HIDDEN in the info
// category; /partner reveal flips it member-visible in a separate, deliberate step. Both perm states are
// blessed into permguard so the sweep protects rather than reverts them.
//
// Invites are VALIDATED on add via client.fetchInvite — a dead/mistyped invite is rejected up front, and
// the resolved guild gives us the real server name, icon and member counts for the embed for free.
const fs = require('fs');
const { statePath, atomicWriteJson } = require('./statepath');
const { withLock } = require('./mutex');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const config = require('./config');
const permguard = require('./permguard');

const CONFIG_FILE = process.env.FUBU_PARTNERS_FILE || statePath('partnerships.json');
const STATE_FILE = process.env.FUBU_PARTNERS_STATE_FILE || statePath('partnerships_state.json');
const P = PermissionsBitField.Flags;
// The info category the channel lives in (same home as rules/welcome/roles). Overridable per guild.
const CATEGORY_ID = process.env.FUBU_PARTNERS_CATEGORY_ID || '1500938647132704818';

function _load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function _save(f, o) { try { atomicWriteJson(f, o); } catch (e) { console.error('[partners] SAVE FAILED - changes lost on restart:', e.message); } }
const loadConfig = () => _load(CONFIG_FILE, {});
const saveConfig = c => _save(CONFIG_FILE, c);
const loadState = () => _load(STATE_FILE, { counter: 0, partners: {} });
const saveState = s => _save(STATE_FILE, s);
function isConfigured() { return !!loadConfig().channelId; }

// ---- setup: create the channel, HIDDEN, in the info category, blessed --------------------------------
async function setup(guild) {
  let c = loadConfig();
  if (c.channelId) { const ex = await guild.channels.fetch(c.channelId).catch(() => null); if (ex) return { channel: ex, created: false }; }
  const channel = await guild.channels.create({
    name: '🤝┆ᴘᴀʀᴛɴᴇʀꜱ', type: ChannelType.GuildText,
    parent: CATEGORY_ID || undefined,
    topic: 'Servers we partner with. Check them out!',
    // Hidden from members until /partner reveal (build-hidden-until-done). Read-only either way:
    // only the bot posts here, so nobody needs Send.
    permissionOverwrites: [{ id: guild.id, deny: [P.ViewChannel, P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] }],
    reason: 'Partnerships channel (owner request), hidden until revealed',
  });
  c = { channelId: channel.id, revealed: false }; saveConfig(c);
  await permguard.blessChannel(guild, channel.id).catch(() => {});
  return { channel, created: true };
}

// ---- reveal: flip member-visible (the deliberate second step) ----------------------------------------
async function reveal(guild) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Partnerships aren’t set up yet. Run `/partner setup` first.' };
  const ch = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!ch) return { ok: false, msg: 'The partners channel is missing. Re-run `/partner setup`.' };
  await ch.permissionOverwrites.edit(guild.id, { ViewChannel: true, SendMessages: false, CreatePublicThreads: false, CreatePrivateThreads: false },
    { reason: 'Partnerships revealed to members' });
  c.revealed = true; saveConfig(c);
  await permguard.blessChannel(guild, ch.id).catch(() => {});
  return { ok: true, channelId: ch.id };
}

function partnerEmbed(p) {
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`🤝 ${p.name}`)
    .setDescription(p.blurb.slice(0, 2000));
  if (p.iconUrl) e.setThumbnail(p.iconUrl);
  const facts = [];
  if (p.memberCount) facts.push({ name: 'Members', value: `~${p.memberCount.toLocaleString('en-US')}`, inline: true });
  if (p.repId) facts.push({ name: 'Their rep', value: `<@${p.repId}>`, inline: true });
  facts.push({ name: 'Partnered since', value: `<t:${Math.floor((p.at || Date.now()) / 1000)}:D>`, inline: true });
  e.addFields(facts).setFooter({ text: `Partner #${p.num} · id ${p.id}` });
  return e;
}
const joinRow = (invite) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join their server').setURL(invite));

// ---- add: validate the invite, post the embed, record ------------------------------------------------
// Serialized behind the module lock (load->awaits->save read-modify-write, the U10 class).
async function add(guild, byId, inviteStr, blurb, { name = null, repId = null } = {}) { return withLock('partners', () => _add(guild, byId, inviteStr, blurb, { name, repId })); }
async function _add(guild, byId, inviteStr, blurb, { name = null, repId = null } = {}) {
  const c = loadConfig();
  if (!c.channelId) return { ok: false, msg: 'Partnerships aren’t set up yet. Run `/partner setup` first.' };
  const ch = await guild.channels.fetch(c.channelId).catch(() => null);
  if (!ch) return { ok: false, msg: 'The partners channel is missing. Re-run `/partner setup`.' };
  const code = (inviteStr || '').trim().replace(/^(https?:\/\/)?(www\.)?(discord\.(gg|com\/invite)\/)?/i, '');
  if (!code) return { ok: false, msg: 'Give me their invite link (discord.gg/whatever).' };
  const invite = await guild.client.fetchInvite(code).catch(() => null);
  if (!invite || !invite.guild) return { ok: false, msg: 'That invite doesn’t resolve. Double-check it (it may be expired or mistyped).' };
  // Permanent-invite nudge: an expiring invite dies in the channel silently later.
  if (invite.maxAge) return { ok: false, msg: 'That invite EXPIRES (it has a time limit). Ask them for a permanent invite so the button doesn’t go dead.' };
  const st = loadState();
  const dupe = Object.values(st.partners).find(p => p.guildId === invite.guild.id);
  if (dupe) return { ok: false, msg: `Already partnered with **${dupe.name}** (id ${dupe.id}). Remove it first to re-add.` };
  // Blurb defaults to the partner server's OWN description off the resolved invite (owner, 2026-08-26:
  // "can the blurb not be the info on the invite?") — staff only type one to override it, or when the
  // partner server never set a description.
  const effectiveBlurb = String(blurb || '').trim() || String(invite.guild.description || '').trim();
  if (!effectiveBlurb) return { ok: false, msg: `**${invite.guild.name}** has no server description on their invite. Give a \`blurb:\` for their card.` };
  const num = (st.counter || 0) + 1;
  const p = {
    id: Math.random().toString(36).slice(2, 8), num,
    guildId: invite.guild.id,
    name: (name || invite.guild.name).slice(0, 100),
    blurb: effectiveBlurb.slice(0, 2000),
    invite: `https://discord.gg/${invite.code}`,
    iconUrl: invite.guild.iconURL?.({ size: 256 }) || null,
    memberCount: invite.memberCount || null,
    repId, addedBy: byId, at: Date.now(),
  };
  const msg = await ch.send({ embeds: [partnerEmbed(p)], components: [joinRow(p.invite)] }).catch(e => { console.error('[partners] post:', e.message); return null; });
  if (!msg) return { ok: false, msg: 'Couldn’t post in the partners channel.' };
  p.messageId = msg.id;
  st.counter = num; st.partners[p.id] = p; saveState(st);
  return { ok: true, partner: p };
}

// ---- remove: delete the embed + the record -----------------------------------------------------------
async function remove(guild, partnerId) { return withLock('partners', () => _remove(guild, partnerId)); }
async function _remove(guild, partnerId) {
  const st = loadState();
  const p = st.partners[(partnerId || '').trim()];
  if (!p) return { ok: false, msg: `No partner with id \`${partnerId}\`. Use \`/partner list\` for ids.` };
  const c = loadConfig();
  if (c.channelId && p.messageId) {
    const ch = await guild.channels.fetch(c.channelId).catch(() => null);
    if (ch) { const m = await ch.messages.fetch(p.messageId).catch(() => null); if (m) await m.delete().catch(() => {}); }
  }
  delete st.partners[p.id]; saveState(st);
  return { ok: true, partner: p };
}

function list() {
  return Object.values(loadState().partners).sort((a, b) => a.num - b.num);
}

module.exports = { setup, reveal, add, remove, list, isConfigured, loadConfig, CONFIG_FILE, STATE_FILE };
