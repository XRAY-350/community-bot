// verifypanel.js — mod-facing Verify / Deny&kick button panel, posted by the bot in every thread
// opened in the verify-here channel. One click does the role swap (Unverified -> Verified) or kicks
// the applicant, instead of a mod editing roles by hand. Mod-gated; verified/left owners get swept.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { MessageFlags } = require('discord.js');
const config = require('./config');
const { kickMember } = require('./threads');
const ownerlog = require('./ownerlog');

const PREFIX = 'vpanel_';

// The panel targets the thread OWNER (the applicant who opened the thread). The target id is baked
// into the button customId so the click knows who to act on even months later.
function buildVerifyPanel(ownerId, ownerTag) {
  const who = ownerTag ? `**${ownerTag}** (<@${ownerId}> · \`${ownerId}\`)` : `<@${ownerId}> (\`${ownerId}\`)`;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription(`Verification request from ${who}.\n\n`
      + `Mods: **Verify** to grant access (swaps Unverified → Verified), or **Deny & kick** to remove them.`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}verify:${ownerId}`).setEmoji('✅').setLabel('Verify').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}deny:${ownerId}`).setEmoji('🚫').setLabel('Deny & kick').setStyle(ButtonStyle.Danger),
  );
  // Mention only lives in the embed (embeds never ping); allowedMentions.users attaches the user's
  // data so it renders as their name instead of "unknown-user" in a large guild.
  return { content: '## Verification', embeds: [embed], components: [row], allowedMentions: { users: [ownerId] } };
}

function isVerifyButton(interaction) {
  return interaction.isButton?.() && interaction.customId?.startsWith(PREFIX);
}

async function handleVerifyButton(interaction) {
  const [kind, targetId] = interaction.customId.slice(PREFIX.length).split(':');

  // Verifying is open to the mod role, Administrators, AND trial mods (it's their training task).
  const roles = interaction.member?.roles?.cache;
  const canVerify = (config.modRoleId && roles?.has(config.modRoleId))
    || (config.trialModRoleId && roles?.has(config.trialModRoleId))
    || interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  if (!canVerify) return interaction.reply({ content: 'Only staff (mods+ or trial mods) can verify.', flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const member = await guild.members.fetch(targetId).catch(() => null);

  if (kind === 'verify') {
    if (!member) return interaction.editReply('That member is no longer in the server.');
    try {
      if (config.unverifiedRoleId && member.roles.cache.has(config.unverifiedRoleId)) {
        await member.roles.remove(config.unverifiedRoleId, `Verified by ${interaction.user.tag}`);
      }
      if (!member.roles.cache.has(config.verifiedRoleId)) {
        await member.roles.add(config.verifiedRoleId, `Verified by ${interaction.user.tag}`);
      }
    } catch (e) {
      return interaction.editReply(`Failed to verify: ${e.message}`);
    }
    await interaction.editReply(`✅ Verified **${member.user.tag}**.`);
    await ownerlog.log(guild, { emoji: '✅', title: 'Member verified', color: 0x57F287, detail: `<@${member.id}> (${member.user.tag}) — by <@${interaction.user.id}>.` });
    // Freeze the panel to a persistent record; the now-verified owner's thread is swept normally.
    // Real notification (they're still in the server and can see this thread) — mention in CONTENT,
    // not just the embed, since embeds never ping.
    await interaction.message.edit({
      content: `## ✅ Verified\n<@${targetId}>`,
      embeds: [new EmbedBuilder().setColor(0x2ecc71)
        .setDescription(`<@${targetId}> was **verified** by <@${interaction.user.id}>.`)],
      components: [],
      allowedMentions: { users: [targetId] },
    }).catch(() => {});
    return;
  }

  if (kind === 'deny') {
    let ok = false;
    try {
      ok = await kickMember(guild, targetId, `Verification denied by ${interaction.user.tag}`, { dryRun: false });
    } catch (e) {
      return interaction.editReply(`Failed to kick: ${e.message}`);
    }
    const nameStr = member ? `**${member.user.tag}**` : `\`${targetId}\``;
    await interaction.editReply(ok ? `🚫 Denied & kicked ${nameStr}.` : `Couldn't kick ${nameStr} (permission/hierarchy?).`);
    if (ok) await ownerlog.log(guild, { emoji: '🚫', title: 'Verification denied + kicked', color: 0xED4245, detail: `${nameStr} — by <@${interaction.user.id}>.` });
    // Escalation: leave a Ban button so a repeat / bad-faith join can be banned in one more click.
    await interaction.message.edit({
      content: '## 🚫 Denied',
      embeds: [new EmbedBuilder().setColor(0xed4245)
        .setDescription(`<@${targetId}> was **denied & kicked** by <@${interaction.user.id}>.\nEscalate to a ban if this is a repeat / bad-faith join.`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}ban:${targetId}`).setEmoji('🔨').setLabel('Ban').setStyle(ButtonStyle.Danger),
      )],
    }).catch(() => {});
    return;
  }

  if (kind === 'ban') {
    try {
      await guild.bans.create(targetId, { reason: `Banned by ${interaction.user.tag}` });
    } catch (e) {
      return interaction.editReply(`Failed to ban: ${e.message}`);
    }
    await interaction.editReply(`🔨 Banned \`${targetId}\`.`);
    await ownerlog.log(guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `\`${targetId}\` — by <@${interaction.user.id}> (via verify-panel escalation).` });
    await interaction.message.edit({
      content: '## 🔨 Banned',
      embeds: [new EmbedBuilder().setColor(0x992d22)
        .setDescription(`<@${targetId}> was **banned** by <@${interaction.user.id}>.`)],
      components: [],
    }).catch(() => {});
    return;
  }
}

module.exports = { buildVerifyPanel, handleVerifyButton, isVerifyButton };
