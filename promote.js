// promote.js — staff promotion votes. Two kinds, same shape:
//   • trial → Mod: /promote-trial opens a post in #mod-announcements (@Mod ping); mods vote advisory 👍/👎,
//     OWNER confirms → adds the Mod role (auto-nester then strips Trial Mod).
//   • Mod → Admin: /promote-mod opens a post in #admin-discussion (no admin-announcements) (@Admin ping);
//     staff vote advisory, OWNER confirms → adds the Admin role.
// The candidate can't see the channel the vote runs in, so it stays private from them either way.
const fs = require('fs');
const { statePath } = require('./statepath');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const ownerlog = require('./ownerlog');
const copy = require('./copy');
const nestedRoles = require('./nestedRoles');

// Per-kind wiring, resolved against config at call time.
const KINDS = {
  trial: { requireKey: 'trialModRoleId', addKey: 'modRoleId', channelKey: 'modAnnounceChannelId', pingKey: 'modRoleId', fromLabel: 'Trial Mod', toLabel: 'Mod', note: ' (Trial Mod is auto-removed)' },
  mod:   { requireKey: 'modRoleId', addKey: 'adminRoleId', channelKey: 'adminDiscussionChannelId', pingKey: 'adminRoleId', fromLabel: 'Mod', toLabel: 'Admin', note: '' },
};

const STATE_FILE = process.env.FUBU_PROMOTIONS_FILE || statePath('promotions.json');
function _load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { posts: {} }; } }
function _save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[promote] save:', e.message); } }

const voteRow = (up, down, done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('promote_up').setEmoji('👍').setLabel(String(up)).setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('promote_down').setEmoji('👎').setLabel(String(down)).setStyle(ButtonStyle.Danger).setDisabled(!!done));
const decideRow = (done, approved) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('promote_confirm').setEmoji('✅').setLabel(done && approved ? 'Promoted' : 'Confirm promotion').setStyle(ButtonStyle.Secondary).setDisabled(!!done),
  new ButtonBuilder().setCustomId('promote_reject').setEmoji('⛔').setLabel(done && !approved ? 'Rejected' : 'Reject').setStyle(ButtonStyle.Secondary).setDisabled(!!done));

function embed(rec, resolution, byId) {
  const k = KINDS[rec.kind || 'trial'];
  const e = new EmbedBuilder().setColor(resolution === 'promoted' ? 0x57F287 : resolution === 'rejected' ? 0xED4245 : 0xF1C40F)
    .setTitle(`🏅 ${k.fromLabel} → ${k.toLabel} promotion vote`).addFields(
      { name: 'Candidate', value: `<@${rec.candidateId}>`, inline: true },
      { name: 'Nominated by', value: `<@${rec.byId}>`, inline: true },
      { name: 'Staff vote (anon)', value: `👍 ${rec.up?.length || 0} · 👎 ${rec.down?.length || 0}`, inline: true });
  if (resolution) e.addFields({ name: resolution === 'promoted' ? '✅ Promoted by' : '⛔ Rejected by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: '👍/👎 is anonymous + advisory. The owner makes the final call.' });
  return e;
}

// Open a promotion vote of the given kind ('trial' → Mod, 'mod' → Admin). Returns { ok, channelId } or { ok:false, msg }.
async function start(guild, candidate, byId, config, kind = 'trial') {
  const k = KINDS[kind]; if (!k) return { ok: false, msg: copy.promote.unknownKind };
  const channelId = config[k.channelKey];
  if (!channelId) return { ok: false, msg: `No channel is configured for ${k.fromLabel}→${k.toLabel} promotions.` };
  const requireRole = config[k.requireKey];
  if (requireRole && !candidate.roles.cache.has(requireRole))
    return { ok: false, msg: `<@${candidate.id}> isn’t a **${k.fromLabel}**, so there’s nothing to promote.` };
  if (config[k.addKey] && candidate.roles.cache.has(config[k.addKey]))
    return { ok: false, msg: `<@${candidate.id}> is already **${k.toLabel}**.` };
  const state = _load();
  if (Object.values(state.posts).find(p => p.candidateId === candidate.id && p.status === 'open'))
    return { ok: false, msg: copy.promote.alreadyOpen };
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return { ok: false, msg: copy.promote.noChannel };
  const pingRole = config[k.pingKey];
  const rec = { candidateId: candidate.id, byId, up: [], down: [], status: 'open', kind };
  const msg = await ch.send({
    content: `${pingRole ? `<@&${pingRole}> ` : ''}Promotion vote: should **${candidate.user.username}** become ${k.toLabel === 'Admin' ? 'an' : 'a full'} **${k.toLabel}**?`,
    embeds: [embed(rec)], components: [voteRow(0, 0, false), decideRow(false)],
    allowedMentions: { roles: pingRole ? [pingRole] : [] },
  });
  rec.messageId = msg.id; state.posts[msg.id] = rec; _save(state);
  return { ok: true, channelId: ch.id, messageId: msg.id };
}

async function vote(interaction, dir) {
  const state = _load(); const rec = state.posts[interaction.message.id];
  if (!rec || rec.status !== 'open') return interaction.reply({ content: copy.promote.voteClosed, flags: MessageFlags.Ephemeral });
  const uid = interaction.user.id;
  const up = (rec.up || []).filter(x => x !== uid), down = (rec.down || []).filter(x => x !== uid);
  const wasIn = ((dir === 'up' ? rec.up : rec.down) || []).includes(uid);
  if (!wasIn) (dir === 'up' ? up : down).push(uid);
  rec.up = up; rec.down = down; _save(state);
  await interaction.update({ embeds: [embed(rec)], components: [voteRow(up.length, down.length, false), decideRow(false)] });
  return interaction.followUp({ content: wasIn ? `Your ${dir === 'up' ? '👍' : '👎'} was removed.` : `Your ${dir === 'up' ? '👍' : '👎'} is counted (anonymous).`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// Owner-gated in index.js. Confirm → add the Mod role (auto-nester strips Trial Mod after).
async function resolve(interaction, confirmed, config) {
  const state = _load(); const rec = state.posts[interaction.message.id];
  if (!rec || rec.status !== 'open') return interaction.reply({ content: copy.promote.alreadyDecided, flags: MessageFlags.Ephemeral });
  rec.status = confirmed ? 'promoted' : 'rejected'; rec.decidedBy = interaction.user.id; _save(state);
  const k = KINDS[rec.kind || 'trial'];
  const member = await interaction.guild.members.fetch(rec.candidateId).catch(() => null);
  let promoted = false;
  if (confirmed && member && config[k.addKey]) {
    promoted = await member.roles.add(config[k.addKey], `Promoted to ${k.toLabel} by ${interaction.user.tag}`).then(() => true).catch(() => false);
    // A genuine, voted-on promotion — not a tier-nesting byproduct. Clear any nested-only flag so a later
    // loss of a HIGHER tier doesn't strip a role this person actually earned in their own right.
    if (promoted) nestedRoles.clear(rec.candidateId, config[k.addKey]);
  }
  await interaction.update({ embeds: [embed(rec, rec.status, interaction.user.id)], components: [voteRow(rec.up.length, rec.down.length, true), decideRow(true, confirmed)] });
  await ownerlog.log(interaction.guild, { emoji: confirmed ? '🏅' : '⛔', title: `Promotion ${confirmed ? 'confirmed' : 'rejected'}`, color: confirmed ? 0x57F287 : 0xED4245,
    detail: `<@${rec.candidateId}> — ${k.fromLabel} → ${k.toLabel} — by <@${interaction.user.id}>.` });
  return interaction.followUp({ content: confirmed
    ? (promoted ? `✅ Promoted <@${rec.candidateId}> to **${k.toLabel}**${k.note}.` : `✅ Confirmed, but couldn’t add the ${k.toLabel} role (check role hierarchy).`)
    : '⛔ Promotion rejected. Nothing changed.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
}

async function handleButton(interaction, config) {
  const id = interaction.customId;
  if (id === 'promote_up') return vote(interaction, 'up');
  if (id === 'promote_down') return vote(interaction, 'down');
  if (id === 'promote_confirm') return resolve(interaction, true, config);
  if (id === 'promote_reject') return resolve(interaction, false, config);
}

// Cancel an OPEN promotion record whose poll message was deleted, so the orphaned record can't keep
// blocking a re-open. Returns the cancelled record (with candidateId) or null if there was nothing open.
function cancelByMessageId(messageId, reason = 'poll message deleted') {
  const state = _load();
  const rec = state.posts[messageId];
  if (!rec || rec.status !== 'open') return null;
  rec.status = 'cancelled';
  rec.cancelledReason = reason;
  _save(state);
  return rec;
}

module.exports = { start, handleButton, cancelByMessageId };
