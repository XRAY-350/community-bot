// index.js — bubble girl :3. VC voice/face verification + self-assign roles for the Girls-Masc server.
// Flow: new member joins → tagged Unverified (gated to the verification area) → they hop into the private
// Verification VC → the bot pings verifiers in #verify-alerts with a ✅ button → a mod/admin checks them by
// voice/camera and clicks Verify → they get MEMBERS (verified) and full access. Self-assign roles live on a
// button picker in #roles. NO auto-kick (unverified members stay). Provisioning is a one-time `setup.js`.
const fs = require('fs');
const {
  Client, GatewayIntentBits, Partials, PermissionsBitField, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const config = require('./config');

const PINK = 0xEB6EA5, GREEN = 0x63C083, GREY = 0x8A8699;

// --- tiny persisted state (role-picker message id) + in-memory ping cooldown --------------------------
function loadState() { try { return JSON.parse(fs.readFileSync(config.stateFile, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(config.stateFile, JSON.stringify(s)); } catch (e) { console.error('[state]', e.message); } }
const lastPing = new Map();   // userId -> ts (dedupe #verify-alerts)

// --- helpers ------------------------------------------------------------------------------------------
function isVerifier(interactionOrMember) {
  const m = interactionOrMember.member || interactionOrMember;
  const roles = m && m.roles && m.roles.cache;
  const perms = interactionOrMember.memberPermissions || (m && m.permissions);
  if (perms && perms.has(PermissionsBitField.Flags.Administrator)) return true;
  return !!(roles && config.verifierRoleIds.some(id => roles.has(id)));
}
function isVerified(member) { return !!(config.verifiedRoleId && member.roles.cache.has(config.verifiedRoleId)); }

// dry-run-aware role changes
async function grantVerified(member, byTag) {
  if (config.dryRun) { console.log(`[DRY_RUN] would verify ${member.user.tag} (grant MEMBERS, remove Unverified)`); return; }
  if (config.verifiedRoleId) await member.roles.add(config.verifiedRoleId, `Verified by ${byTag}`).catch(e => console.error('[verify] add MEMBERS:', e.message));
  if (config.unverifiedRoleId && member.roles.cache.has(config.unverifiedRoleId))
    await member.roles.remove(config.unverifiedRoleId, `Verified by ${byTag}`).catch(e => console.error('[verify] rm Unverified:', e.message));
}

// --- verification alert -------------------------------------------------------------------------------
async function notifyVerifiers(guild, member) {
  const now = Date.now();
  if (now - (lastPing.get(member.id) || 0) < config.verifyRepingSec * 1000) return;
  lastPing.set(member.id, now);
  const ch = config.verifyAlertChannelId && await guild.channels.fetch(config.verifyAlertChannelId).catch(() => null);
  if (!ch) return;
  const ping = config.verifierRoleIds.map(id => `<@&${id}>`).join(' ');
  const embed = new EmbedBuilder().setColor(PINK)
    .setDescription(`🎤 <@${member.id}> (\`${member.user.tag}\`) is waiting in the **Verification VC**.\n\n`
      + 'Hop in, check them by **voice or camera**, then click **✅ Verify** to give them access.')
    .setFooter({ text: 'Verifiers: mods + admins' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`verify:${member.id}`).setEmoji('✅').setLabel('Verify').setStyle(ButtonStyle.Success));
  await ch.send({ content: ping || undefined, embeds: [embed], components: [row],
    allowedMentions: { roles: config.verifierRoleIds, users: [] } }).catch(e => console.error('[alert]', e.message));
}

// --- self-assign role picker --------------------------------------------------------------------------
function buildRolePicker() {
  const groups = {};
  for (const r of config.selfAssign) (groups[r.group] = groups[r.group] || []).push(r);
  const embed = new EmbedBuilder().setColor(PINK).setTitle('🫧 Pick your roles')
    .setDescription('Tap a button to give yourself a role — tap again to remove it. Grab as many as you like!\n\n'
      + Object.keys(groups).map(g => `**${g}**`).join(' · '));
  const rows = Object.values(groups).slice(0, 5).map(list =>
    new ActionRowBuilder().addComponents(list.slice(0, 5).map(r =>
      new ButtonBuilder().setCustomId(`role:${r.roleId}`).setLabel(r.label).setEmoji(r.emoji).setStyle(ButtonStyle.Secondary))));
  return { content: '', embeds: [embed], components: rows };
}
async function ensureRolePicker(guild) {
  if (!config.rolesChannelId || !config.selfAssign.length) return;
  const ch = await guild.channels.fetch(config.rolesChannelId).catch(() => null);
  if (!ch) return;
  const st = loadState();
  const payload = buildRolePicker();
  if (st.rolePickerMessageId) {
    const msg = await ch.messages.fetch(st.rolePickerMessageId).catch(() => null);
    if (msg) { await msg.edit(payload).catch(() => {}); return; }
  }
  const msg = await ch.send(payload).catch(e => { console.error('[roles]', e.message); return null; });
  if (msg) { saveState({ ...loadState(), rolePickerMessageId: msg.id }); console.log(`[roles] picker posted ${msg.id}`); }
}

// --- client -------------------------------------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember],
});

client.once('clientReady', async () => {
  console.log(`bubble girl :3 online as ${client.user.tag}${config.dryRun ? ' [DRY_RUN]' : ''}`);
  try {
    const guild = await client.guilds.fetch(config.guildId);
    // Register /verify (mods+ only) as a guild command — instant, no global wait.
    await guild.commands.set([
      new SlashCommandBuilder().setName('verify').setDescription('Manually verify a member (grants MEMBERS)')
        .addUserOption(o => o.setName('user').setDescription('Member to verify').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles).toJSON(),
    ]).catch(e => console.error('[cmd]', e.message));
    await ensureRolePicker(guild);
  } catch (e) { console.error('[ready]', e.message); }
});

// New member → tag Unverified (gates them to the verification area).
client.on('guildMemberAdd', async (member) => {
  if (member.user.bot || !config.assignUnverifiedOnJoin || !config.unverifiedRoleId) return;
  if (isVerified(member) || member.roles.cache.has(config.unverifiedRoleId)) return;
  if (config.dryRun) return console.log(`[DRY_RUN] would tag ${member.user.tag} Unverified on join`);
  await member.roles.add(config.unverifiedRoleId, 'New member — awaiting verification').catch(e => console.error('[join]', e.message));
});

// Unverified member joins the Verification VC → ping verifiers.
client.on('voiceStateUpdate', async (oldS, newS) => {
  try {
    if (!config.verifyVcId) return;
    const joined = newS.channelId === config.verifyVcId && oldS.channelId !== config.verifyVcId;
    if (!joined) return;
    const member = newS.member;
    if (!member || member.user.bot || isVerified(member)) return;   // only unverified trigger a ping
    await notifyVerifiers(newS.guild, member);
  } catch (e) { console.error('[voice]', e.message); }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton?.()) {
      const id = interaction.customId || '';
      // Self-assign role toggle — any member.
      if (id.startsWith('role:')) {
        const roleId = id.slice('role:'.length);
        if (!config.selfAssign.some(r => r.roleId === roleId)) return interaction.reply({ content: 'That role is no longer available.', ephemeral: true });
        const has = interaction.member.roles.cache.has(roleId);
        try {
          if (has) await interaction.member.roles.remove(roleId, 'Self-assign toggle');
          else await interaction.member.roles.add(roleId, 'Self-assign toggle');
        } catch (e) { return interaction.reply({ content: `Couldn't change that role: ${e.message}`, ephemeral: true }); }
        return interaction.reply({ content: `${has ? '➖ Removed' : '➕ Added'} <@&${roleId}>.`, ephemeral: true, allowedMentions: { parse: [] } });
      }
      // Verify a waiting member — verifiers only.
      if (id.startsWith('verify:')) {
        if (!isVerifier(interaction)) return interaction.reply({ content: 'Only mods & admins can verify.', ephemeral: true });
        const uid = id.slice('verify:'.length);
        const member = await interaction.guild.members.fetch(uid).catch(() => null);
        if (!member) return interaction.reply({ content: 'That member is no longer in the server.', ephemeral: true });
        await grantVerified(member, interaction.user.tag);
        // Freeze the alert: mark verified + drop the button.
        const done = new EmbedBuilder().setColor(GREEN)
          .setDescription(`✅ <@${uid}> was **verified** by <@${interaction.user.id}>${config.dryRun ? ' _(dry-run — no roles changed)_' : ''}.`);
        await interaction.update({ embeds: [done], components: [] }).catch(async () => {
          await interaction.reply({ content: `✅ Verified <@${uid}>.`, ephemeral: true }).catch(() => {});
        });
        return;
      }
      return;
    }
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'verify') {
      if (!isVerifier(interaction)) return interaction.reply({ content: 'Only mods & admins can verify.', ephemeral: true });
      const user = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'That member is not in the server.', ephemeral: true });
      await grantVerified(member, interaction.user.tag);
      return interaction.reply({ content: `✅ Verified <@${user.id}>${config.dryRun ? ' _(dry-run)_' : ''}.`, ephemeral: true });
    }
  } catch (e) {
    console.error('[interaction]', e.message);
    if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred)
      interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
  }
});

client.on('error', e => console.error('[client]', e.message));
client.login(config.token);
