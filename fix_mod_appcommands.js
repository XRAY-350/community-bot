// fix_mod_appcommands.js - staff can VIEW many channels but a server-wide "no slash commands"
// restriction (denying @everyone Use Application Commands) also blocks the MOD/ADMIN roles, so mods
// get a native "Missing Permissions" trying to run /corner etc. in e.g. #mod-discussion.
// This grants the staff roles Use Application Commands on every channel where they can view but can't
// currently command. PREVIEW-FIRST: prints the list; pass --apply to grant.
const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require('discord.js');
const F = PermissionsBitField.Flags;
const cfg = require('./config');
const APPLY = process.argv.includes('--apply');

const STAFF_ROLES = [cfg.modRoleId, '1516179051105226833'].filter(Boolean); // MODS-✰, ADMINS-★

const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once('clientReady', async () => {
  try {
    const g = await c.guilds.fetch(cfg.guildId);
    await g.roles.fetch();
    const all = [...(await g.channels.fetch()).values()].filter(Boolean);
    const roles = STAFF_ROLES.map(id => g.roles.cache.get(id)).filter(Boolean);
    console.log(`\nStaff roles: ${roles.map(r => r.name).join(', ')}\n${'='.repeat(60)}`);
    let fixCount = 0;
    const plan = []; // {channel, roles:[]}
    for (const ch of all) {
      if (ch.type === ChannelType.GuildCategory) continue;
      const need = [];
      for (const role of roles) {
        const p = ch.permissionsFor(role);
        // Only where the role can SEE the channel but can't use app commands there.
        if (p.has(F.ViewChannel) && !p.has(F.UseApplicationCommands)) need.push(role);
      }
      if (need.length) { plan.push({ ch, need }); fixCount += need.length; }
    }
    if (!plan.length) { console.log('Nothing to fix - staff can already use commands everywhere they can view.'); c.destroy(); return process.exit(0); }
    console.log(`${APPLY ? '*** APPLYING ***' : 'PREVIEW'} - grant Use Application Commands to staff on ${plan.length} channel(s):\n`);
    for (const { ch, need } of plan) {
      console.log(`  ${APPLY ? '✓' : '•'} #${ch.name}  →  ${need.map(r => r.name).join(', ')}`);
      if (APPLY) for (const role of need) await ch.permissionOverwrites.edit(role, { UseApplicationCommands: true }, { reason: 'staff can use mod commands where they moderate' });
    }
    console.log(`\n${plan.length} channels · ${fixCount} role-grants. ${APPLY ? 'Done.' : 'Re-run with --apply to grant.'}`);
    c.destroy(); process.exit(0);
  } catch (e) { console.error('FATAL', e); c.destroy(); process.exit(1); }
});
c.login(cfg.token);
