const { Client, GatewayIntentBits } = require('discord.js');
const config = require('./config');
const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
c.once('ready', async () => {
  const g = await c.guilds.fetch(config.guildId);
  await g.members.fetch();
  const both = [...g.members.cache.values()].filter(m => !m.user.bot
    && m.roles.cache.has(config.verifiedRoleId) && m.roles.cache.has(config.unverifiedRoleId));
  console.log(`Resolving ${both.length} conflicts (removing Unverified, keeping Verified)...`);
  let ok=0, fail=0;
  for (const m of both) {
    try { await m.roles.remove(config.unverifiedRoleId, 'Conflict cleanup - resolved to Verified'); ok++; }
    catch (e) { console.log(`  FAIL ${m.user.tag}: ${e.message}`); fail++; }
  }
  console.log(`Done: ${ok} resolved, ${fail} failed.`);
  process.exit(0);
});
c.login(config.token);
setTimeout(()=>{console.log('timeout');process.exit(1);}, 180000);
