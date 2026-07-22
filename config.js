// config.js — bubble girl :3. All config comes from the environment (systemd EnvironmentFile); nothing
// secret is hardcoded. Fails fast on the two essentials (token + guild). Role/channel IDs are filled in
// by setup.js at deploy time — until then they're blank and the bot logs what's missing rather than
// crashing, so you can start it to sanity-check the login before provisioning.
function req(name) {
  const v = (process.env[name] || '').trim();
  if (!v) { console.error(`[config] FATAL: required env ${name} is not set`); process.exit(1); }
  return v;
}
function opt(name, fallback) { const v = (process.env[name] || '').trim(); return v || fallback; }
function bool(name, fallback) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const config = {
  token: req('DISCORD_BOT_TOKEN'),
  guildId: req('GUILD_ID'),

  // --- roles ---
  verifiedRoleId: opt('VERIFIED_ROLE_ID', ''),     // MEMBERS💙 — granted when a member passes verification
  unverifiedRoleId: opt('UNVERIFIED_ROLE_ID', ''), // assigned on join; gates them to the verification area
  // Verifier tiers (any of these, or Administrator, may verify): MODS + ADMIN + OWNER.
  modRoleId: opt('MOD_ROLE_ID', ''),
  adminRoleId: opt('ADMIN_ROLE_ID', ''),
  ownerRoleId: opt('OWNER_ROLE_ID', ''),

  // --- channels ---
  verifyVcId: opt('VERIFY_VC_ID', ''),                 // private VC: joiner + verifiers only
  verifyInfoChannelId: opt('VERIFY_INFO_CHANNEL_ID', ''), // #verify-here instructions (unverified can see)
  verifyAlertChannelId: opt('VERIFY_ALERT_CHANNEL_ID', ''), // mod-only: "someone's waiting" pings
  rolesChannelId: opt('ROLES_CHANNEL_ID', ''),         // #roles — the self-assign button picker

  // Self-assign roles: JSON array of { key, label, emoji, roleId, group }. Written by setup.js.
  selfAssign: (() => { try { return JSON.parse(opt('SELF_ASSIGN_JSON', '[]')); } catch { return []; } })(),

  // --- behavior ---
  assignUnverifiedOnJoin: bool('ASSIGN_UNVERIFIED_ON_JOIN', true), // tag new joins Unverified automatically
  // Observe-only default: log intended role changes but don't perform them, so the first run proves the
  // flow before anything is actually granted/removed. Flip DRY_RUN=false to go live.
  dryRun: bool('DRY_RUN', true),
  // Re-ping cooldown so a member toggling the VC doesn't spam #verify-alerts (seconds).
  verifyRepingSec: Number(opt('VERIFY_REPING_SEC', '300')),

  stateFile: opt('STATE_FILE', '/home/ubuntu/.bubblegirl_state.json'),
};

// Verifier-role id list (blank entries dropped) for the isVerifier() check.
config.verifierRoleIds = [config.modRoleId, config.adminRoleId, config.ownerRoleId].filter(Boolean);

module.exports = config;
