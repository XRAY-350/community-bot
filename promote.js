// promote.js — Trial Mod → full Mod promotion vote. /promote-trial opens a post in #mod-announcements
// (which trial mods can't see, so the vote is private from the candidate): @Mod is pinged, mods give an
// anonymous advisory 👍/👎, and the OWNER makes the final call with Confirm/Reject. Confirm adds the Mod
// role — the tier auto-nester then strips Trial Mod, so the graduate stops pinging as @Trial Mod.
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

const STATE_FILE = process.env.FUBU_PROMOTIONS_FILE || '/home/ubuntu/.fubu_promotions.json';
function _load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { posts: {} }; } }
function _save(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('[promote] save:', e.message); } }

const voteRow = (up, down, done) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('promote_up').setEmoji('👍').setLabel(String(up)).setStyle(ButtonStyle.Success).setDisabled(!!done),
  new ButtonBuilder().setCustomId('promote_down').setEmoji('👎').setLabel(String(down)).setStyle(ButtonStyle.Danger).setDisabled(!!done));
const decideRow = (done, approved) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('promote_confirm').setEmoji('✅').setLabel(done && approved ? 'Promoted' : 'Confirm promotion').setStyle(ButtonStyle.Secondary).setDisabled(!!done),
  new ButtonBuilder().setCustomId('promote_reject').setEmoji('⛔').setLabel(done && !approved ? 'Rejected' : 'Reject').setStyle(ButtonStyle.Secondary).setDisabled(!!done));

function embed(rec, resolution, byId) {
  const e = new EmbedBuilder().setColor(resolution === 'promoted' ? 0x57F287 : resolution === 'rejected' ? 0xED4245 : 0xF1C40F)
    .setTitle('🏅 Trial Mod promotion vote').addFields(
      { name: 'Candidate', value: `<@${rec.candidateId}>`, inline: true },
      { name: 'Nominated by', value: `<@${rec.byId}>`, inline: true },
      { name: 'Mod vote (anon)', value: `👍 ${rec.up?.length || 0} · 👎 ${rec.down?.length || 0}`, inline: true });
  if (resolution) e.addFields({ name: resolution === 'promoted' ? '✅ Promoted by' : '⛔ Rejected by', value: `<@${byId}>`, inline: true });
  e.setFooter({ text: 'Mods: 👍/👎 is anonymous + advisory — the owner makes the final call.' });
  return e;
}

// Open a promotion vote. Returns { ok, channelId, messageId } or { ok:false, msg }.
async function start(guild, candidate, byId, config) {
  if (!config.modAnnounceChannelId) return { ok: false, msg: 'No mod-announcements channel is configured.' };
  if (config.trialModRoleId && !candidate.roles.cache.has(config.trialModRoleId))
    return { ok: false, msg: `<@${candidate.id}> isn’t a **Trial Mod**, so there’s nothing to promote.` };
  const state = _load();
  if (Object.values(state.posts).find(p => p.candidateId === candidate.id && p.status === 'open'))
    return { ok: false, msg: 'There’s already an open promotion vote for them.' };
  const ch = await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return { ok: false, msg: 'Couldn’t reach the mod-announcements channel.' };
  const rec = { candidateId: candidate.id, byId, up: [], down: [], status: 'open' };
  const msg = await ch.send({
    content: `${config.modRoleId ? `<@&${config.modRoleId}> ` : ''}— promotion vote: should **${candidate.user.username}** become a full **Mod**?`,
    embeds: [embed(rec)], components: [voteRow(0, 0, false), decideRow(false)],
    allowedMentions: { roles: config.modRoleId ? [config.modRoleId] : [] },
  });
  rec.messageId = msg.id; state.posts[msg.id] = rec; _save(state);
  return { ok: true, channelId: ch.id, messageId: msg.id };
}

async function vote(interaction, dir) {
  const state = _load(); const rec = state.posts[interaction.message.id];
  if (!rec || rec.status !== 'open') return interaction.reply({ content: 'This vote is closed.', flags: MessageFlags.Ephemeral });
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
  if (!rec || rec.status !== 'open') return interaction.reply({ content: 'Already decided.', flags: MessageFlags.Ephemeral });
  rec.status = confirmed ? 'promoted' : 'rejected'; rec.decidedBy = interaction.user.id; _save(state);
  const member = await interaction.guild.members.fetch(rec.candidateId).catch(() => null);
  let promoted = false;
  if (confirmed && member && config.modRoleId)
    promoted = await member.roles.add(config.modRoleId, `Promoted to Mod by ${interaction.user.tag}`).then(() => true).catch(() => false);
  await interaction.update({ embeds: [embed(rec, rec.status, interaction.user.id)], components: [voteRow(rec.up.length, rec.down.length, true), decideRow(true, confirmed)] });
  return interaction.followUp({ content: confirmed
    ? (promoted ? `✅ Promoted <@${rec.candidateId}> to **Mod** — Trial Mod is auto-removed.` : `✅ Confirmed, but couldn’t add the Mod role (check role hierarchy).`)
    : '⛔ Promotion rejected. Nothing changed.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
}

async function handleButton(interaction, config) {
  const id = interaction.customId;
  if (id === 'promote_up') return vote(interaction, 'up');
  if (id === 'promote_down') return vote(interaction, 'down');
  if (id === 'promote_confirm') return resolve(interaction, true, config);
  if (id === 'promote_reject') return resolve(interaction, false, config);
}

module.exports = { start, handleButton };
