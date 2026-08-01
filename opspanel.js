// opspanel.js — pinned, TIER-GATED ops dashboard for the FUBU bot, in the mod-only dashboard channel.
// One pinned message, edited in place, nav via a select menu. TIERS (owner ⊇ admin ⊇ mod) gate actions:
// the pinned panel shows everything, but each action re-checks the clicker's tier and refuses if they
// don't meet it. Deps (state/corner/sweep/config/…) are injected by index.js via wire() so the panel
// reuses the bot's own logic. Members are targeted by @username / display name / ID (resolved live).
const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } = require('discord.js');
const { MessageFlags } = require('discord.js');
const copy = require('./copy');   // single source of truth for public-facing text (see copy.js)

const PANEL_FILE = process.env.FUBU_OPS_PANEL_FILE || `${process.env.HOME || '/home/ubuntu'}/.fubu_ops_panel.json`;
// Separate pinned message: a static staff command reference (the "what every command does" list that used
// to bloat the Overview page). Kept as its own pinned message at the top of #mod-dashboard so the live
// panel stays lean. Its own ref file so it never collides with the interactive panel's ref.
const GUIDE_REF_FILE = process.env.FUBU_OPS_GUIDE_FILE || `${process.env.HOME || '/home/ubuntu'}/.fubu_ops_guide.json`;

// --- tiers (role-based, so they survive the admin restructure: personal roles carry Admin, ADMINS-★
// will lose it). owner = 4 personal-admin roles + guild owner; admin = ADMINS-★; mod = MODS-✰. ------
const OWNER_ROLE_IDS = (process.env.FUBU_OWNER_ROLE_IDS ||
  '1516235123841040394,1517718734989693038,1517718258784927814,1517717893415047328').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_ROLE_ID = process.env.FUBU_ADMIN_ROLE_ID || '1516179051105226833';
const MOD_ROLE_ID = process.env.MOD_ROLE_ID || '1528316361665675316';
// The single VISIBLE OWNER⚜️ role (what members actually see/reference in-server; also in config.identifyingRoleIds,
// kept when cornering). Owner-tier MEMBERSHIP is still keyed off the 4 personal-admin roles + guild owner above —
// this is purely the role to DISPLAY for the owner tier (e.g. the /staff header), so it resolves + carries its colour.
const OWNER_DISPLAY_ROLE_ID = process.env.FUBU_OWNER_DISPLAY_ROLE_ID || '1527430885287264438';
// The BOT owner — the single supreme authority (distinct from the Discord SERVER owner and from the OWNER
// role). Ranks above everyone: passes every gate ("no command the bot owner can't run") and can hold
// commands NOBODY else can run. Structural, not role-dependent.
const BOT_OWNER_ID = process.env.FUBU_BOT_OWNER_ID || '865843812907089940';
const RANK = { mod: 1, admin: 2, owner: 3, botowner: 4 };
const meets = (tier, needed) => (RANK[tier] || 0) >= (RANK[needed] || 99);
// True for the bot owner ONLY. Accepts an interaction (.user.id) or a member (.id).
function isBotOwner(x) { const id = x && (x.user ? x.user.id : x.id); return !!id && id === BOT_OWNER_ID; }

// ROLE-ONLY tier (no Administrator-permission fallback) — used for the watchlist gates, staff detection,
// AND who-can-be-cornered TARGETING. Deliberately role-based: the bot owner is NOT special here, so they
// are treated as their role tier and remain cornerable/targetable (their COMMAND authority is separate —
// see isBotOwner/tierOf). server owner + OWNER role both sit at 'owner'.
function memberTier(member) {
  const roles = member && member.roles && member.roles.cache;
  if (!roles) return null;
  // OWNER tier is a SAFEGUARD: the OWNER role AND the Administrator permission must BOTH be true (a partial
  // owner — one without the other — is not recognized). The Discord SERVER owner is always owner regardless.
  const ownerCombo = OWNER_ROLE_IDS.some(id => roles.has(id)) && !!(member.permissions && member.permissions.has(PermissionsBitField.Flags.Administrator));
  if ((member.guild && member.id === member.guild.ownerId) || ownerCombo) return 'owner';
  if (roles.has(ADMIN_ROLE_ID)) return 'admin';
  if (roles.has(MOD_ROLE_ID)) return 'mod';
  return null;
}
// ACTOR authority tier — who can USE things. Ladder: mod (MODS-✰) < admin (ADMINS-★ role) < owner < server
// owner < bot owner. The bot owner is supreme BY USER ID (role-independent → keeps access even role-stripped).
// OWNER tier requires BOTH the OWNER role AND the Administrator permission (safeguard; see memberTier).
// Note "admin" = the ADMINS-★ role, NOT the Administrator permission.
function tierOf(interaction) {
  if (isBotOwner(interaction)) return 'botowner';
  return memberTier(interaction.member);   // owner requires OWNER role AND Admin perm (in memberTier); no perm-alone shortcut
}

// page tiers: min tier to USE the actions on the page (everyone mod+ can VIEW every page).
// Order: status → day-to-day mod (mod tier) → anon tools (mod) → admin pages → owner-only Danger last.
const PAGES = [
  { emoji: '📊', name: 'Overview', tier: 'mod', blurb: 'status at a glance' },
  { emoji: '🛡️', name: 'Moderation', tier: 'mod', blurb: 'corner · verify · release a member' },
  { emoji: '⛓️', name: 'Corner', tier: 'mod', blurb: "who's timed-out + release them" },
  { emoji: '⚠️', name: 'Strikes', tier: 'mod', blurb: 'everyone with active strikes — click to remove one' },
  { emoji: '⚖️', name: 'Conflicts', tier: 'mod', blurb: 'fix members who have both roles' },
  { emoji: '🔒', name: 'Anon Tools', tier: 'mod', blurb: 'confessions · reports · modmail · whistleblow · suggestions' },
  { emoji: '👁️', name: 'Watchlist', tier: 'admin', blurb: 'unban · watchlist · flagged terms — needs Admin' },
  { emoji: '🔨', name: 'Actions', tier: 'admin', blurb: 'run the bot now · ban — needs Admin' },
  { emoji: '⚙️', name: 'Settings', tier: 'admin', blurb: 'turn helpers on/off — needs Admin' },
  { emoji: '⚠️', name: 'Danger', tier: 'owner', blurb: 'removal policy — needs Owner' },
];
const pageIdx = (name) => PAGES.findIndex(p => p.name === name);   // reorder-safe page lookup
const watchlist = require('./watchlist');
const features = require('./features');

// Instant-ban reason categories — used to write the ban's audit-log reason AND (in appeals.js) to
// recognize which bans the "more limited" ban-appeal path must refuse outright.
const CATEGORY_LABEL = { false_verification: 'False verification / not eligible', verification_bypass: 'Verification bypass / misrepresenting identity', ban_evasion: 'Ban evasion (alt account)', grooming: 'Confirmed grooming of a minor', other: 'Other' };
// Per-category emoji for the ban-reason select — keyed by the same values as CATEGORY_LABEL so the dropdown
// derives its labels from that single const (change a label there → the select updates too).
const CATEGORY_EMOJI = { false_verification: '🚫', verification_bypass: '🎭', ban_evasion: '👤', grooming: '⚠️', other: '❓' };

let D = null;
function wire(deps) { D = deps; }
const _cornerMultiStash = new Map();   // modId -> {ids, at}: carries a multi-corner selection to its duration modal
function loadRef() { try { return JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8')); } catch { return {}; } }
function saveRef(r) { try { fs.writeFileSync(PANEL_FILE, JSON.stringify(r)); } catch (e) { console.error('[fops] save:', e.message); } }

// Persist a config override (survives restart via config.js merge) AND apply it live.
function persistOverride(patch) {
  const f = (D.config && D.config.overrideFile) || `${process.env.HOME || '/home/ubuntu'}/.fubu_config_overrides.json`;
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  Object.assign(cur, patch);
  fs.writeFileSync(f, JSON.stringify(cur, null, 2));
  Object.assign(D.config, patch);
}

// --- data -------------------------------------------------------------------------------------------
async function pendingCount() {
  try {
    const vc = D.getVerifyChannel && D.getVerifyChannel();
    if (!vc) return 0;
    const th = await D.activeThreads(vc);
    return th.filter(t => t.parentId === D.config.verifyChannelId).length;
  } catch { return 0; }
}
function corneredMap() { try { return D.state.listCornered() || {}; } catch { return {}; } }

// A member's label for a dashboard ROSTER line that sits next to a per-member button. Every such button is
// labelled `…${id.slice(-4)}` (Discord button labels can't be mentions), so pair this with `memberTag(id)` and
// the two line up — you can tell which "Manage …8228" button belongs to whom. Uses the bot's cached display
// name (markdown-sanitised) so it renders even where an embed mention would show a raw <@id> for uncached
// members; falls back to a clickable mention when the name isn't cached.
function memberLabel(id) {
  try {
    const guild = D.client.guilds.cache.get(D.config.guildId) || D.client.guilds.cache.first();
    const n = guild?.members?.cache.get(id)?.displayName;
    return n ? `**${n.replace(/[*_`~|<>@:]/g, '').slice(0, 40) || id}**` : `<@${id}>`;
  } catch { return `<@${id}>`; }
}
const memberTag = id => `\`…${String(id).slice(-4)}\``;   // matches the per-member button's last-4 label

// --- render helpers ---------------------------------------------------------------------------------
function navRow(page) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fops_nav')
      .setPlaceholder(`${PAGES[page].emoji} ${PAGES[page].name} — jump to a page…`)
      .addOptions(PAGES.map((p, i) => ({
        label: p.name, value: String(i), emoji: p.emoji, default: i === page,
        description: p.blurb.slice(0, 100),
      }))));
}
function toggleBtn(key, label) {
  const on = !!D.config[key];
  return new ButtonBuilder().setCustomId(`fops_toggle:${key}`).setLabel(`${label}: ${on ? 'ON' : 'OFF'}`)
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// Personal panel (/panel): a private, per-user ephemeral copy. Its nav is FILTERED to the pages the
// caller's tier can actually use (customId fops_pnav, so it routes separately from the shared pinned
// panel and never touches the shared page-state). Since pages are tier-homogeneous, a page the caller
// can open means every action on it is usable by them.
function navRowPersonal(page, tier) {
  const opts = PAGES.map((p, i) => ({ p, i })).filter(({ p }) => meets(tier, p.tier))
    .map(({ p, i }) => ({ label: p.name, value: String(i), emoji: p.emoji, default: i === page, description: p.blurb.slice(0, 100) }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fops_pnav')
      .setPlaceholder(`${PAGES[page].emoji} ${PAGES[page].name} — jump to a page…`).addOptions(opts));
}
// Render a page for the personal panel: same content as the shared pages, but with the tier-filtered
// nav swapped in (it's always the last component) and marked ephemeral.
async function buildPersonal(page, tier) {
  const payload = await buildPage(page);
  payload.components = [...payload.components];
  payload.components[payload.components.length - 1] = navRowPersonal(page, tier);
  payload.ephemeral = true;
  return payload;
}
async function openPersonalPanel(interaction) {
  const tier = tierOf(interaction);
  if (!tier) return interaction.reply({ content: 'This panel is for the mod team.', flags: MessageFlags.Ephemeral });
  return interaction.reply(await buildPersonal(0, tier));
}
// Read-only dashboard for trial mods: the live Overview status, with NO action components — genuinely
// look-but-don't-touch (they can't act, because there are no buttons/menus to act with). Routed from
// /panel in index.js when the caller is a trial mod but not mod+.
async function openReadOnly(interaction) {
  const p = await buildOverview();
  const cmds = new EmbedBuilder().setColor(0x1abc9c).setTitle('🔰 Trial Mod — what you can do')
    .setDescription(
      '`/verify @member` — verify a waiting member (or hit the ✅ **Verify** button in their thread)\n' +
      '`/pending` — flip through everyone waiting to be verified\n' +
      '`/corner @member` — time a member out — **you must pick a rule OR give a reason, max 1 hour**\n' +
      '`/uncorner @member` — release someone from the corner\n' +
      '`/panel` — open this read-only dashboard\n\n' +
      '_You’ll get pinged when someone needs verifying. Ban / strike / watchlist stay mod-only — those unlock when you’re promoted._')
    .setFooter({ text: 'Trial Mod — restricted training tier.' });
  return interaction.reply({ content: `${p.content}\n_(read-only — trial mod view)_`, embeds: [p.embeds[0], cmds], flags: MessageFlags.Ephemeral });
}

// --- pages ------------------------------------------------------------------------------------------
async function buildOverview() {
  const [pending, cornered] = [await pendingCount(), corneredMap()];
  const c = D.config;
  const embed = new EmbedBuilder().setColor(0x5865f2).setDescription(
    '**Status right now.** Use the **dropdown below** to act. 📖 A full **command reference** is pinned at the top of this channel.\n\n' +
    `**🧵 Waiting to be verified:** ${pending} — opened a thread, need a mod to check them.\n` +
    `**⛓️ In the corner:** ${Object.keys(cornered).length} — timed-out (roles removed, locked to the corner).\n` +
    `**🧹 Auto-removal:** ${c.dryRun ? '🟡 **TEST MODE** — *not* removing anyone' : '🟢 **ON** — removing for real'} · warns after **${c.warnDays}d**, removes after **${c.kickDays}d**.\n` +
    `**🔔 Helpers:** mod-nudges ${c.featureNudge ? 'on' : 'off'} · double-role flag ${c.conflictPing ? 'on' : 'off'} · weekly self-fix ${c.reactResolveEnabled ? 'on' : 'off'} · daily recap ${c.digestEnabled ? `${c.digestHour}:00` : 'off'}.`)
    .setFooter({ text: 'Anything marked 🔒 needs a higher role (Admin or Owner). Full command list is the pinned reference above.' }).setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_refresh').setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary));
  return { content: '## 🛡️ FUBU Ops · Overview', embeds: [embed], components: [row, navRow(pageIdx('Overview'))] };
}

// --- Anon Tools page: the anonymous reporting/feedback system at a glance (read-only reference + counts).
function _stateCount(file, key) { try { return JSON.parse(fs.readFileSync(file, 'utf8'))[key] || 0; } catch { return 0; } }
function buildAnonTools() {
  const home = process.env.HOME || '/home/ubuntu';
  const conf = _stateCount(`${home}/.fubu_confessions_state.json`, 'counter');
  const rep = _stateCount(`${home}/.fubu_reports_state.json`, 'counter');
  const mm = _stateCount(`${home}/.fubu_modmail_state.json`, 'counter');
  const wb = _stateCount(`${home}/.fubu_whistleblow_state.json`, 'counter');
  const sug = _stateCount(`${home}/.fubu_suggestions_state.json`, 'counter');
  let sugOpen = 0;
  try { const s = JSON.parse(fs.readFileSync(`${home}/.fubu_suggestions_state.json`, 'utf8')); sugOpen = Object.values(s.posts || {}).filter(p => p.status === 'open').length; } catch {}
  const embed = new EmbedBuilder().setColor(0x9b59b6).setDescription(
    'The anonymous **reporting + feedback** system. Members run these in any chat channel; the mod-side actions (reveal / delete / unseal / approve) live **on the posts themselves**, not here.')
    .addFields(
      { name: '📈 Totals so far', value: `🤫 Confessions **${conf}** · 🚩 Reports **${rep}** · 📨 Modmail **${mm}** · 🕊️ Whistleblows **${wb}** · 💡 Suggestions **${sug}** (**${sugOpen}** open)` },
      { name: '🤫 /confess', value: 'Anonymous in **#confessions**; real author + **🗑 Delete** in **#confession-log**. Every mod sees the author.' },
      { name: '🚩 /report · right-click → Apps → Report', value: 'Lands in **#anon-reports**. Reporter hidden; **admins** hit **🔍 Reveal reporter** (with cause · logged).' },
      { name: '📨 /modmail', value: 'Lands in **#mod-inbox**. Only **owners** can **🔍 Reveal sender**.' },
      { name: '🕊️ /whistleblow', value: 'DMed to who the sender picked (head-admin / owner / both / anonymous). Sealed → **🔓 Unseal** by the entrusted person only (logged). "No one" = never unmaskable.' },
      { name: '💡 /suggest', value: 'Forum post with ⬆/⬇ votes; staff **✅ Approve** / **❌ Deny** → auto-archives. Not anonymous.' },
      { name: '🔑 Who can reveal', value: 'confessions = all mods · reports = admins · modmail = owners · whistleblow = only who the sender chose. Reveal only with cause.' },
      { name: '⏱️ Limits / member', value: 'confess 3m · 20/day · suggest 10m · 3 open · report+modmail 30m · 6/day · whistleblow 60m · 4/day' })
    .setFooter({ text: 'Members use these in any chat channel.' }).setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_refresh').setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary));
  return { content: '## 🔒 FUBU Ops · Anon Tools', embeds: [embed], components: [row, navRow(pageIdx('Anon Tools'))] };
}

function buildModeration() {
  const embed = new EmbedBuilder().setColor(0x4ec5c1).setDescription(
    '**Easiest way:** pick a member from the **dropdown** below, then choose Corner / Verify / Uncorner / Ban. ' +
    'No typing needed.\n_(Prefer typing? The buttons under it still take a username or ID.)_\n\n' +
    '⛓️ **Corner** — times them out: removes their roles and locks them to the corner channel until you release them.\n' +
    '✅ **Verify** — gives the **Verified** role and removes **Unverified**.\n' +
    '🔓 **Uncorner** — lets them out early and gives their roles back.\n' +
    '⛓️ **Corner several…** — pick up to 10 members and corner them all for the same duration.')
    .setFooter({ text: 'Any mod can use these. The full corner list is on the ⛓️ Corner page.' });
  const pick = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('fops_modpick').setPlaceholder('🎯 pick a member to act on…').setMaxValues(1));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_corner').setEmoji('⛓️').setLabel('Corner (type)').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('fops_verify').setEmoji('✅').setLabel('Verify (type)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('fops_uncorner').setEmoji('🔓').setLabel('Uncorner (type)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_corner_multi').setEmoji('⛓️').setLabel('Corner several…').setStyle(ButtonStyle.Danger));
  return { content: '## 🛡️ FUBU Ops · Moderation', embeds: [embed], components: [pick, row, navRow(pageIdx('Moderation'))] };
}

async function buildCorner() {
  const cornered = corneredMap();
  const ids = Object.keys(cornered);
  const lines = [];
  const rows = [];
  let row = new ActionRowBuilder();
  for (const id of ids.slice(0, 20)) {
    const rec = cornered[id] || {};
    const rel = rec.releaseAt ? `<t:${Math.floor(rec.releaseAt / 1000)}:R>` : 'indefinite';
    lines.push(`• ${memberLabel(id)} ${memberTag(id)} — release ${rel}`);
    row.addComponents(new ButtonBuilder().setCustomId(`corner_rel:${id}:0`).setEmoji('🔓').setLabel(`Release …${id.slice(-4)}`).setStyle(ButtonStyle.Success));
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  }
  if (row.components.length) rows.push(row);
  while (rows.length > 4) rows.pop();
  const embed = new EmbedBuilder().setColor(ids.length ? 0x992d22 : 0x2ecc71)
    .setDescription(ids.length
      ? 'Members currently **timed-out** in the corner. Click a **Release** button to let someone out now and give their roles back.\n\n' + lines.join('\n') + (ids.length > 20 ? `\n…and ${ids.length - 20} more` : '')
      : '✅ Nobody is in the corner right now.')
    .setFooter({ text: 'Any mod can release someone. To PUT someone in, use ⛓️ Corner on the Moderation page.' });
  rows.push(navRow(pageIdx('Corner')));
  return { content: `## ⛓️ FUBU Ops · Corner (${ids.length})`, embeds: [embed], components: rows };
}

async function buildStrikes() {
  const members = D.strike ? D.strike.activeMembers() : [];
  const lines = [];
  const rows = [];
  let row = new ActionRowBuilder();
  const cap = D.strike ? D.strike.BAN_THRESHOLD : 10;
  for (const m of members.slice(0, 20)) {
    lines.push(`• ${memberLabel(m.memberId)} ${memberTag(m.memberId)} — **${D.strike ? D.strike.format(m.units) : m.units}/${cap} units** (${m.count} strike${m.count > 1 ? 's' : ''})`);
    row.addComponents(new ButtonBuilder().setCustomId(`fops_pick_strikeremove:${m.memberId}`).setEmoji('🎯').setLabel(`Manage …${m.memberId.slice(-4)}`).setStyle(ButtonStyle.Danger));
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  }
  if (row.components.length) rows.push(row);
  while (rows.length > 4) rows.pop();
  const embed = new EmbedBuilder().setColor(members.length ? 0x992d22 : 0x2ecc71)
    .setDescription(members.length
      ? 'Members with **active strikes**. Click **Manage** to pick which one of theirs to remove.\n\n' + lines.join('\n') + (members.length > 20 ? `\n…and ${members.length - 20} more` : '')
      : '✅ Nobody has an active strike right now.')
    .setFooter({ text: 'To GIVE a strike, use ⚠️ Strike on the Moderation page or /strike add.' });
  rows.push(navRow(pageIdx('Strikes')));
  return { content: `## ⚠️ FUBU Ops · Strikes (${members.length})`, embeds: [embed], components: rows };
}

function buildConflicts() {
  const embed = new EmbedBuilder().setColor(0xe67e22).setDescription(
    'Sometimes a member ends up with **both** the Verified *and* Unverified role (usually a glitch). ' +
    'That confuses the bot, so it leaves them alone until a human sorts it out.\n\n' +
    'Click **Scan for conflicts** to find anyone like that, then for each one choose which role to keep. ' +
    '(The bot also fixes these on its own via the hourly check and the weekly self-fix message.)')
    .setFooter({ text: 'Any mod can resolve these. Scan checks every member, so it only runs when you click.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_conflicts_scan').setEmoji('🔍').setLabel('Scan for conflicts').setStyle(ButtonStyle.Primary));
  return { content: '## ⚖️ FUBU Ops · Role conflicts', embeds: [embed], components: [row, navRow(pageIdx('Conflicts'))] };
}

function buildActions() {
  const modapps = require('./modapps');   // lazy — modapps requires opspanel (avoid the circular at load)
  const appsOpen = modapps.applicationsOpen();
  const embed = new EmbedBuilder().setColor(0xff453a).setDescription(
    '**⭐ Needs Admin.** (Mods can read this page, but the buttons will show 🔒.)\n\n' +
    '🧹 **Run housekeeping now** — the bot normally tidies up once an hour; this makes it run **right now**: warn or remove overdue unverified members, delete dead verification threads, and flag anyone with both roles. ⚠️ It can **actually remove people**, unless Test Mode is on (see the ⚠️ Danger page).\n' +
    '🔨 **Ban a member** — permanently removes them and blocks them from rejoining. Can\'t be undone here.\n' +
    `📋 **Mod applications** — currently **${appsOpen ? '🟢 OPEN' : '🔴 CLOSED'}**. Close intake when the team is full (applications already under review still finish); reopen anytime.`)
    .setFooter({ text: copy.guards.needsAdmin });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_sweep').setEmoji('🧹').setLabel('Run housekeeping now').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_modapps_toggle').setEmoji(appsOpen ? '🚫' : '✅').setLabel(appsOpen ? 'Close mod applications' : 'Reopen mod applications').setStyle(appsOpen ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('fops_ban').setEmoji('🔨').setLabel('Ban a member').setStyle(ButtonStyle.Danger));
  return { content: '## 🔨 FUBU Ops · Actions', embeds: [embed], components: [row, navRow(pageIdx('Actions'))] };
}

function buildSettings() {
  const embed = new EmbedBuilder().setColor(0xe7ac4e).setDescription(
    '**⭐ Needs Admin.** Turn the bot\'s helper features on or off. Changes apply **immediately** and stay after a restart. ' +
    'Each button shows its current state — click to flip it. (The actual *removal policy* lives on the ⚠️ Danger page.)\n\n' +
    '🔔 **Nudge** — ping mods when a verification thread has been waiting too long.\n' +
    '⚖️ **Conflict-ping** — automatically flag members who somehow have both roles.\n' +
    '✅ **React-resolve** — post a weekly message those members can react to, to fix themselves.\n' +
    '🗒️ **Digest** — a once-a-day recap of everything the bot did.\n' +
    '🧵 **Orphan-reap** — delete verification threads whose owner already left the server.')
    .setFooter({ text: copy.guards.needsAdmin });
  const row1 = new ActionRowBuilder().addComponents(
    toggleBtn('featureNudge', 'Nudge'), toggleBtn('conflictPing', 'Conflict-ping'),
    toggleBtn('reactResolveEnabled', 'React-resolve'), toggleBtn('digestEnabled', 'Digest'), toggleBtn('reapOrphans', 'Orphan-reap'));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_refresh').setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary));
  return { content: '## ⚙️ FUBU Ops · Settings', embeds: [embed], components: [row1, row2, navRow(pageIdx('Settings'))] };
}

function buildDanger() {
  const c = D.config;
  const dryOn = !!c.dryRun;
  const embed = new EmbedBuilder().setColor(dryOn ? 0xff9f0a : 0xff453a).setDescription(
    '**👑 Owner only.** This controls **whether and when the bot removes people** — the highest-stakes settings on the bot. Admins and mods can see it but can\'t change it.\n\n' +
    `**Right now:** ${dryOn ? '🟡 **TEST MODE** — the bot only *pretends* to remove members. Safe.' : '🟢 **LIVE** — the bot **actually removes** unverified members.'}\n\n` +
    '🟡/🟢 **Test Mode** — the master safety switch. Keep it ON while testing; turning it OFF makes real removals begin.\n' +
    '🧹 **Reaping** — the whole warn-then-remove system, on or off.\n' +
    '👢 **Stale-kick** — ON: overdue members get removed. OFF: their thread is cleaned up but they stay in the server.\n' +
    '⏱️ **Timings** — how many days before a warning, before removal, and how often the bot checks.\n\n' +
    `**Current timings:** warns after **${c.warnDays}d** · removes after **${c.kickDays}d** · checks every **${c.sweepIntervalMin}m**.`)
    .setFooter({ text: 'Owner only — this is the removal policy.' });
  const dryBtn = new ButtonBuilder().setCustomId('fops_toggle:dryRun')
    .setLabel(dryOn ? 'Turn OFF Test Mode → go LIVE' : 'Turn ON Test Mode (safe)').setEmoji(dryOn ? '🟢' : '🟡')
    .setStyle(dryOn ? ButtonStyle.Danger : ButtonStyle.Secondary);
  const row1 = new ActionRowBuilder().addComponents(
    dryBtn, toggleBtn('featureStale', 'Reaping'), toggleBtn('staleKick', 'Stale-kick'),
    new ButtonBuilder().setCustomId('fops_timings').setEmoji('⏱️').setLabel('Timings…').setStyle(ButtonStyle.Secondary));
  return { content: '## ⚠️ FUBU Ops · Danger', embeds: [embed], components: [row1, navRow(pageIdx('Danger'))] };
}

function buildWatchlist() {
  const c = D.config;
  const strict = watchlist.loadTerms();
  const loose = watchlist.loadLoose();
  const welfare = watchlist.loadWelfare();
  const pending = watchlist.loadPending();
  const fw = D.freshwatch ? D.freshwatch.status() : { mode: c.smartWatchFreshMode || 'off', hours: c.smartWatchFreshHours || 0, percentile: c.smartWatchFreshPercentile || 1, influxActive: false };
  const freshLine = fw.mode === 'auto'
    ? `**auto** — tags the newest **~${fw.percentile}%** of members as ⚠ brand-new (self-calibrates to growth${fw.influxActive ? '; 📈 **influx active → tightened**' : ''}). A mod heads-up only — the AI never sees account age.`
    : fw.mode === 'manual'
      ? `**manual** — tags accounts that joined **< ${fw.hours}h ago**. A mod heads-up only — the AI never sees account age.`
      : '**off** — no new-account note.';
  const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(
    '**⭐ Needs Admin.** Two monitors:\n' +
    '• **Strict watchlist** — a flagged member posts a **strict term** → alert in **mod-announcements** with **Strike / Corner / Dismiss** buttons (+ mod ping).\n' +
    "• **Loose watch-log** — *anyone except staff* posts a **loose term** → quiet report in **#watch-log** (buttons, no ping).\n" +
    "• **Welfare** — a distress term (e.g. `i want to die`, `sh`) → soft **check-in** report in #watch-log (no ban button).\n" +
    "All reports keep a **saved copy + mirrored attachments**, so deleting the message can't hide it.\n\n" +
    '👁️ **Watchlist** add/remove · 🔓 **Unban** (opt. re-watchlist on rejoin) · 🏷️ **Terms** for each list.\n' +
    `🌱 **New-account flag:** ${freshLine}\n` +
    `🤖 **Monitor mode:** ${copy.watchlist.monitorStatus(features.enabled('smartWatchLab'), !!D.config.smartWatchLive && features.enabled('smartWatch'))}\n\n` +
    `**Now:** ${strict.length} strict · ${loose.length} loose · ${welfare.length} welfare term(s) · ${pending.length} pending.`)
    .setFooter({ text: 'Watchlist + unban + terms = ADMINS-★ role. Banning a flagged message = any mod.' });
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_wl_add').setEmoji('👁️').setLabel('Add to watchlist').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('fops_wl_remove').setEmoji('🙈').setLabel('Remove').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_wl_unban').setEmoji('🔓').setLabel('Unban…').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('fops_wl_list').setEmoji('📋').setLabel('List watchlisted').setStyle(ButtonStyle.Secondary));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_wl_termadd').setEmoji('➕').setLabel('Strict term +').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_wl_termdel').setEmoji('➖').setLabel('Strict term −').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_wl_termlist').setEmoji('🏷️').setLabel('List all terms').setStyle(ButtonStyle.Secondary));
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_wl_ltermadd').setEmoji('➕').setLabel('Loose +').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_wl_ltermdel').setEmoji('➖').setLabel('Loose −').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_wl_wtermadd').setEmoji('➕').setLabel('Welfare +').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_wl_wtermdel').setEmoji('➖').setLabel('Welfare −').setStyle(ButtonStyle.Secondary));
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_freshflag').setEmoji('🌱').setLabel('New-account flag…').setStyle(ButtonStyle.Secondary));
  return { content: '## 👁️ FUBU Ops · Watchlist', embeds: [embed], components: [row1, row2, row3, row4, navRow(pageIdx('Watchlist'))] };
}
function termModal(customId, title) {
  const m = new ModalBuilder().setCustomId(customId).setTitle(title);
  m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('term').setLabel('Word or phrase').setStyle(TextInputStyle.Short).setRequired(true)));
  return m;
}

async function buildPage(page) {
  const name = PAGES[page] && PAGES[page].name;   // name-based so the array can be reordered freely
  if (name === 'Moderation') return buildModeration();
  if (name === 'Corner') return await buildCorner();
  if (name === 'Strikes') return await buildStrikes();
  if (name === 'Conflicts') return buildConflicts();
  if (name === 'Anon Tools') return buildAnonTools();
  if (name === 'Watchlist') return buildWatchlist();
  if (name === 'Actions') return buildActions();
  if (name === 'Settings') return buildSettings();
  if (name === 'Danger') return buildDanger();
  return await buildOverview();
}

// --- lifecycle --------------------------------------------------------------------------------------
// Static staff command reference — the "what every command does" list, moved off the Overview page into
// its own pinned message so the live panel stays lean as the toolkit grows. Includes the tier breakdown
// (who can do what). Staff-only by virtue of living in the mod-only #mod-dashboard channel.
function commandRefEmbed() {
  return new EmbedBuilder().setColor(0x2b2d31).setTitle('📖 FUBU Ops — Staff Command Reference')
    .setDescription('Everything the staff toolkit can do. The **live dashboard** — status + point-and-click actions — is the other pinned message in this channel.')
    .addFields(
      { name: '🛡️ Moderation', value:
        `\`/corner @member [${copy.corner.unitsDot}]\` — time-out: strips roles + locks them to the corner (blank = until released)\n` +
        '`/uncorner @member [time]` — release now, or schedule a release later\n' +
        '`/cornered` — list who’s in the corner, each with a release button\n' +
        '`/strike view·add·remove·clear @member` — raise **or lower** strikes (each carries **weight**; a ban is offered once they add up to **10 units**)' },
      { name: '👁️ Watchlist & safety', value:
        '`/watchlist add·remove·list @member` — put/lift the **Watchlist** role (their messages get flagged to mods)\n' +
        '`/watchlist-terms add·remove·list` — edit flagged words · scopes: **strict** / **loose** / **welfare**\n' +
        '`/watchlist-suggest [hours]` — scan recent chat and recommend new flagged terms\n' +
        '**Right-click a message → “Report to watchlist”** — file a deletion-proof report\n' +
        '`/unban <user-id> [watchlist]` — unban by ID (admin); can re-flag them if they rejoin' },
      { name: '🔒 Anonymous tools & Send-to-corner', value:
        '`/confess` `/report` `/modmail` `/whistleblow` `/suggest` — anonymous reporting + feedback (members can use them in any chat channel)\n' +
        '**Right-click a message → “Send to corner”** — jail the author + copy that message into the corner\n' +
        '**Right-click a message → “Strike”** — strike the author for that message (auto-replies on it)\n' +
        '_Who-can-reveal, limits + live counts are on the **🔒 Anon Tools** page._' },
      { name: '🧰 Other', value:
        '`/verify @member` · `/pending` — verify members / flip through the ones waiting\n' +
        '`/panel` — open this dashboard privately (only you see it)\n' +
        '_Also: watch-log reports carry **⚠️ Strike / 🗑️ Dismiss** buttons, and the 🛡️ Moderation page lets you pick a member from a dropdown and act with no typing._' },
      { name: '👥 Staff & mod-team', value:
        '`/staff` — how many of each tier we have (unique, deduped by highest)\n' +
        '`/promote-trial @member` — open a promotion vote in mod-announcements (mods vote 👍/👎, **owner** confirms → adds Mod, drops Trial)\n' +
        '`/demote-trial @member` — remove someone’s **Trial Mod** role (**owner**)\n' +
        '_Trial mods can **verify** + **corner** (rule + reason, ≤1h) + a read-only `/panel`; ban/strike/watchlist unlock at full Mod._' },
      { name: '👥 Who can do what', value:
        '**🟢 Mods (MODS-✰)** — day-to-day: corner, strike, watchlist, verify, and all the review/anon tools.\n' +
        '**🔵 Admins (ADMINS-★)** — everything mods can, **plus** ban/unban, running the bot on-demand, and helper settings.\n' +
        '**🟣 Owner** — everything, **plus** removal policy (⚠️ Danger page), mod-application decisions, and feature toggles.' })
    .setFooter({ text: '🔒 = needs a higher role. This is the reference — use the dashboard to actually do things.' });
}
async function ensureCommandRef(client, channelId) {
  try {
    let ref = {}; try { ref = JSON.parse(fs.readFileSync(GUIDE_REF_FILE, 'utf8')); } catch {}
    const chId = channelId || ref.channelId || loadRef().channelId;
    if (!chId) return console.error('[fops] no dashboard channel for command reference');
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) return console.error('[fops] command-ref channel not found');
    const payload = { embeds: [commandRefEmbed()] };
    if (ref.channelId === chId && ref.messageId) {
      const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
      if (msg) { await msg.edit(payload); if (!msg.pinned) await msg.pin().catch(() => {}); return; }
    }
    const msg = await ch.send(payload);
    await msg.pin().catch(() => {});
    fs.writeFileSync(GUIDE_REF_FILE, JSON.stringify({ channelId: chId, messageId: msg.id }));
    console.log(`[fops] command reference created + pinned ${msg.id} in ${chId}`);
  } catch (e) { console.error('[fops] ensureCommandRef:', e.message); }
}

async function ensurePanel(client, channelId) {
  try {
    const ref = loadRef();
    const chId = channelId || ref.channelId;
    if (!chId) return console.error('[fops] no dashboard channel set');
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) return console.error('[fops] dashboard channel not found');
    const payload = await buildPage(ref.page || 0);
    if (ref.channelId === chId && ref.messageId) {
      const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
      if (msg) { await msg.edit(payload); if (!msg.pinned) await msg.pin().catch(() => {}); return; }
    }
    const msg = await ch.send(payload);
    await msg.pin().catch(() => {});
    saveRef({ channelId: chId, messageId: msg.id, page: 0 });
    console.log(`[fops] dashboard created + pinned ${msg.id} in ${chId}`);
  } catch (e) { console.error('[fops] ensure:', e.message); }
}

async function refreshPanel(client) {
  try {
    const ref = loadRef();
    if (!ref.messageId || !ref.channelId) return;
    // Idle auto-return: if nobody has navigated for a while, snap the shared panel back to Overview so
    // it isn't left parked on whatever page the last person opened. (Single pinned message = same for all.)
    let page = ref.page || 0;
    // Shared board = a noticeboard: return to Overview quickly once nobody's navigating (90s default).
    // Lingering on a specific page is what the private /panel is for. Tunable via FUBU_OPS_IDLE_RESET_MS.
    const IDLE = Number(process.env.FUBU_OPS_IDLE_RESET_MS || 90 * 1000);
    if (page !== 0 && ref.navAt && (Date.now() - ref.navAt) > IDLE) { page = 0; saveRef({ ...ref, page: 0 }); }
    const ch = await client.channels.fetch(ref.channelId).catch(() => null);
    const msg = ch && await ch.messages.fetch(ref.messageId).catch(() => null);
    if (msg) await msg.edit(await buildPage(page));
  } catch (e) { console.error('[fops] refresh:', e.message); }
}

function isPanelInteraction(i) {
  return (i.isButton?.() || i.isStringSelectMenu?.() || i.isUserSelectMenu?.() || i.isModalSubmit?.()) && i.customId?.startsWith('fops_');
}

// --- interactions ---------------------------------------------------------------------------------
// Member picker: a native Discord UserSelect (shows real names/avatars from the server to pick from,
// not a typed guess) — replaces the old "type a username/ID" modal for every action below.
function pickerRow(customId, placeholder) {
  return new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMaxValues(1));
}
// Follow-up modal AFTER a member's been picked — only for the extra field(s) an action still needs
// (the target member is already known, carried in the customId, so no "who" field here).
function followupModal(customId, title, fields) {
  const m = new ModalBuilder().setCustomId(customId).setTitle(title);
  for (const f of fields) m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(TextInputStyle.Short).setRequired(!!f.required).setPlaceholder(f.placeholder || '')));
  return m;
}
const LABEL = { mod: '✰ Mod', admin: '⭐ Admin', owner: '👑 Owner' };

async function handlePanel(interaction) {
  const id = interaction.customId;
  const tier = tierOf(interaction);
  const roleTier = isBotOwner(interaction) ? 'botowner' : memberTier(interaction.member);   // role-only (ADMINS-★, not the Admin perm) — but the bot owner passes by user id even role-stripped
  if (!tier) return interaction.reply({ content: 'This dashboard is for the mod team.', flags: MessageFlags.Ephemeral });
  // Gate helper for pre-defer (reply) responses.
  const denyReply = needed => interaction.reply({ content: `🔒 That's **${LABEL[needed]}+** only. You're ${LABEL[tier]}.`, flags: MessageFlags.Ephemeral });

  if (id === 'fops_nav') {
    const page = Math.max(0, Math.min(PAGES.length - 1, Number(interaction.values?.[0] || 0)));
    saveRef({ ...loadRef(), page, navAt: Date.now() });   // navAt drives the idle auto-return-to-Overview
    return interaction.update(await buildPage(page));   // everyone may VIEW any page; actions gate below
  }
  if (id === 'fops_pnav') {   // personal panel nav - private + tier-filtered, no shared page-state
    const page = Math.max(0, Math.min(PAGES.length - 1, Number(interaction.values?.[0] || 0)));
    if (!meets(tier, PAGES[page].tier)) return interaction.reply({ content: "🔒 You don't have access to that page.", flags: MessageFlags.Ephemeral });
    return interaction.update(await buildPersonal(page, tier));
  }
  // Member picker (UserSelect) → offer per-member action buttons privately.
  if (id === 'fops_modpick') {
    const uid = interaction.values[0];
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.reply({ content: copy.guards.couldNotFindMember, flags: MessageFlags.Ephemeral });
    const units = D.strike ? D.strike.total(member) : 0;
    const cap = D.strike ? D.strike.BAN_THRESHOLD : 10;
    const actions = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fops_do_corner:${uid}`).setEmoji('⛓️').setLabel('Corner').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`fops_do_verify:${uid}`).setEmoji('✅').setLabel('Verify').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`fops_do_uncorner:${uid}`).setEmoji('🔓').setLabel('Uncorner').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`fops_do_ban:${uid}`).setEmoji('🔨').setLabel('Ban').setStyle(ButtonStyle.Danger));
    const strikes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fops_pick_strikegive:${uid}`).setEmoji('📋').setLabel('Give a strike…').setStyle(ButtonStyle.Danger).setDisabled(units >= cap),
      new ButtonBuilder().setCustomId(`fops_do_strikeup:${uid}`).setEmoji('⚠️').setLabel('Strike +1 (1 unit)').setStyle(ButtonStyle.Danger).setDisabled(units >= cap),
      new ButtonBuilder().setCustomId(`fops_do_strikedown:${uid}`).setEmoji('➖').setLabel('Undo last strike').setStyle(ButtonStyle.Secondary).setDisabled(units <= 0),
      new ButtonBuilder().setCustomId(`fops_pick_strikeremove:${uid}`).setEmoji('🎯').setLabel('Manage a strike…').setStyle(ButtonStyle.Secondary).setDisabled(units <= 0),
      new ButtonBuilder().setCustomId(`fops_do_strikeclear:${uid}`).setEmoji('🧹').setLabel('Clear strikes').setStyle(ButtonStyle.Secondary).setDisabled(units <= 0));
    const unitsDisplay = D.strike ? D.strike.format(units) : units;
    return interaction.reply({ content: `🎯 Selected <@${uid}> (\`${member.user.tag}\`) — currently **${unitsDisplay}/${cap} units**. Pick an action. _(Corner here is indefinite; for a timed corner use the Corner button (asks duration) or \`/corner\`. "Give a strike…" picks a rule/reason/weight/timeout, same as \`/strike add\`; "Strike +1" is a quick no-reason 1-unit shortcut.)_`, components: [actions, strikes], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // "Give a strike…" — hands off to the SAME rule-picker → reason+weight-modal → addStrike flow the
  // watch-log/right-click Strike buttons already use (strike_rule_pick:/strike_reason: handlers in
  // index.js). This customId is NOT fops_-prefixed, so it falls through to those top-level handlers —
  // nothing else to wire here, the dashboard is just a second entry point into the existing flow.
  if (id.startsWith('fops_pick_strikegive:')) {
    const uid = id.split(':')[1];
    if (!D.strike?.ruleRow) return interaction.reply({ content: 'Strike-giving isn’t wired up.', flags: MessageFlags.Ephemeral });
    return interaction.reply({ content: copy.common.whichRule, components: [D.strike.ruleRow(uid)], flags: MessageFlags.Ephemeral });
  }
  // Pick exactly which strike to remove (not just the most recent) — a StringSelect of the member's
  // active strikes, human-readable labels via D.strike.label (reuses strikes.js's entryLabel).
  if (id.startsWith('fops_pick_strikeremove:')) {
    const uid = id.split(':')[1];
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.reply({ content: copy.guards.couldNotFindMember, flags: MessageFlags.Ephemeral });
    const entries = D.strike ? D.strike.entries(member) : [];
    if (!entries.length) return interaction.reply({ content: `<@${uid}> has no active strikes.`, flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder().setCustomId(`fops_strike_manage:${uid}`).setPlaceholder('Which strike?')
      .addOptions(entries.slice(0, 25).map(e => ({ label: D.strike.label(e).slice(0, 100), value: e.id })));
    return interaction.reply({ content: `Manage a strike on <@${uid}> — pick which one:`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // Picked a specific strike → offer Remove OR re-weight it (partial leniency / correction). Each button
  // carries the target weight (0 = remove); the strike's CURRENT weight button is disabled so it's obvious.
  if (id.startsWith('fops_strike_manage:') && interaction.isStringSelectMenu?.()) {
    const uid = id.split(':')[1];
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.update({ content: copy.common.noMemberInServer, components: [] });
    const strikeId = interaction.values[0];
    const entry = (D.strike.entries(member) || []).find(e => e.id === strikeId);
    if (!entry) return interaction.update({ content: 'That strike is gone — it may already have been changed.', components: [] });
    const cur = entry.weight;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fops_strike_setw:${uid}:${strikeId}:0`).setEmoji('🗑️').setLabel('Remove').setStyle(ButtonStyle.Danger),
      ...[1, 2, 3].map(w => new ButtonBuilder().setCustomId(`fops_strike_setw:${uid}:${strikeId}:${w}`).setLabel(`${w} unit${w > 1 ? 's' : ''}`).setStyle(ButtonStyle.Secondary).setDisabled(cur === w)));
    return interaction.update({ content: `Strike \`${strikeId}\` on <@${uid}> — currently **${D.strike.format(cur)} unit${cur === 1 ? '' : 's'}**.\nRemove it, or set a new weight:`, components: [row] });
  }
  if (id.startsWith('fops_strike_setw:') && interaction.isButton?.()) {
    const [, uid, strikeId, wStr] = id.split(':');
    const w = Number(wStr);
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.update({ content: copy.common.noMemberInServer, components: [] });
    const r = w <= 0
      ? await D.strike.removeById(interaction.guild, member, strikeId, interaction.user.tag)
      : await D.strike.setWeight(interaction.guild, member, strikeId, w, interaction.user.tag);
    if (!r.ok) return interaction.update({ content: 'Couldn’t find that strike anymore — it may already have been changed.', components: [] });
    const what = w <= 0 ? `Removed strike \`${strikeId}\`` : `Set strike \`${strikeId}\` to **${w} unit${w > 1 ? 's' : ''}**`;
    return interaction.update({ content: `✅ ${what} on <@${uid}> — now **${D.strike.format(r.totalUnits)}/${D.strike.BAN_THRESHOLD} units** (${r.tier}).`, components: [] });
  }
  // Single-purpose pickers (fops_pick_*) — a member was just chosen via UserSelect for one specific
  // action opened by the buttons below. corner/ban still need one more field, so they show a short
  // follow-up modal (customId carries the uid); everything else executes straight away.
  if (id === 'fops_pick_corner') {
    const uid = interaction.values[0];
    return interaction.showModal(followupModal(`fops_cornermodal2:${uid}`, 'Corner — duration',
      [{ id: 'dur', label: `Duration (${copy.corner.units} — blank = indefinite)` }]));
  }
  if (id === 'fops_pick_cornermulti') {
    _cornerMultiStash.set(interaction.user.id, { ids: interaction.values, at: Date.now() });
    return interaction.showModal(followupModal('fops_cornermulti_dur', `Corner ${interaction.values.length} member(s) — duration`,
      [{ id: 'dur', label: `Duration (${copy.corner.units} — blank = indefinite)` }]));
  }
  if (id === 'fops_pick_ban') {
    if (!meets(tier, 'admin')) return denyReply('admin');
    const uid = interaction.values[0];
    const menu = new StringSelectMenuBuilder().setCustomId(`fops_ban_category:${uid}`).setPlaceholder('Why are you banning them?')
      .addOptions(Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ label, value, emoji: CATEGORY_EMOJI[value] || '❓' })));
    return interaction.reply({ content: 'Why are you banning them? (this gets logged with the ban, for audit)', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }
  if (id.startsWith('fops_ban_category:')) {
    if (!meets(tier, 'admin')) return denyReply('admin');
    const uid = id.split(':')[1];
    const category = interaction.values[0];
    return interaction.showModal(followupModal(`fops_banmodal2:${uid}:${category}`, `Ban — ${CATEGORY_LABEL[category]}`, [{ id: 'reason', label: 'Additional detail (optional)' }]));
  }
  if (id === 'fops_pick_verify') {
    const uid = interaction.values[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.editReply(copy.common.noMemberInServer);
    await member.roles.add(D.config.verifiedRoleId, `Verified via dashboard picker by ${interaction.user.tag}`).catch(() => {});
    if (D.config.unverifiedRoleId) await member.roles.remove(D.config.unverifiedRoleId, 'Verified via dashboard').catch(() => {});
    return interaction.editReply(`✅ Verified <@${uid}> (\`${member.user.tag}\`).`);
  }
  if (id === 'fops_pick_uncorner') {
    const uid = interaction.values[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await D.corner.uncorner(interaction.guild, uid, D.state);
    return interaction.editReply(r.ok ? `🔓 Released <@${uid}> — restored ${r.restored} role(s).` : `Failed: ${r.error}`);
  }
  if (id === 'fops_pick_wladd' || id === 'fops_pick_wlremove') {
    if (!meets(roleTier, 'admin')) return denyReply('admin');
    if (!D.config.watchlistRoleId) return interaction.reply({ content: copy.common.noWatchlistRole, flags: MessageFlags.Ephemeral });
    const uid = interaction.values[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.editReply(copy.common.noMemberInServer);
    if (id === 'fops_pick_wladd') { await member.roles.add(D.config.watchlistRoleId, `Watchlist via dashboard by ${interaction.user.tag}`); return interaction.editReply(`👁️ <@${uid}> (\`${member.user.tag}\`) added to the Watchlist.`); }
    await member.roles.remove(D.config.watchlistRoleId, `Un-watchlist via dashboard by ${interaction.user.tag}`).catch(() => {}); watchlist.removePending(uid);
    return interaction.editReply(`✅ <@${uid}> (\`${member.user.tag}\`) removed from the Watchlist.`);
  }
  if (id === 'fops_pick_unban') {
    if (!meets(roleTier, 'admin')) return denyReply('admin');
    const uid = interaction.values[0];
    return interaction.showModal(followupModal(`fops_unbanmodal2:${uid}`, 'Unban — confirm',
      [{ id: 'watchlist', label: 'Watchlist on rejoin? (yes/no)', placeholder: 'no' }]));
  }
  if (id.startsWith('fops_do_')) {
    const [key, uid] = id.split(':');
    const act = key.slice('fops_do_'.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.editReply(copy.common.noMemberInServer);
    if (act === 'corner') {
      const r = await D.corner.corner(interaction.guild, member, null, D.state, interaction.user.id);
      return interaction.editReply(r.ok ? `⛓️ Cornered <@${uid}> indefinitely — stripped ${r.stripped} role(s). Release from the ⛓️ Corner page when ready.` : `Failed: ${r.error}`);
    }
    if (act === 'verify') {
      await member.roles.add(D.config.verifiedRoleId, `Verified via dashboard picker by ${interaction.user.tag}`).catch(() => {});
      if (D.config.unverifiedRoleId) await member.roles.remove(D.config.unverifiedRoleId, 'Verified via dashboard').catch(() => {});
      return interaction.editReply(`✅ Verified <@${uid}> (\`${member.user.tag}\`).`);
    }
    if (act === 'uncorner') {
      const r = await D.corner.uncorner(interaction.guild, uid, D.state);
      return interaction.editReply(r.ok ? `🔓 Released <@${uid}> — restored ${r.restored} role(s).` : `Failed: ${r.error}`);
    }
    if (act === 'ban') {
      if (!meets(tier, 'admin')) return interaction.editReply('🔒 Banning is **admin+** only.');
      if (member.permissions.has(PermissionsBitField.Flags.Administrator) || member.id === interaction.guild.ownerId)
        return interaction.editReply(copy.guards.refuseBanStaff);
      try {
        await member.ban({ reason: `Banned via dashboard by ${interaction.user.tag}` });
        if (D.logAction) await D.logAction(interaction.guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `<@${uid}> (${member.user.tag}) — via dashboard — by <@${interaction.user.id}>.` });
        return interaction.editReply(`🔨 Banned <@${uid}> (\`${member.user.tag}\`).`);
      } catch (e) { return interaction.editReply(`❌ Ban failed: ${e.message}`); }
    }
    if (act.startsWith('strike')) {
      if (!D.strike) return interaction.editReply('Strikes aren’t set up.');
      const cap = D.strike.BAN_THRESHOLD;
      if (act === 'strikeup') {
        const r = await D.strike.up(interaction.guild, member, interaction.user.tag);
        return interaction.editReply(`⚠️ Gave <@${uid}> a 1-unit strike — now **${D.strike.format(r.totalUnits)}/${cap} units**.${r.crossedBan ? ' 🔨 **Crossed the ban threshold** — use the Ban button if staff confirms.' : ''}`);
      }
      if (act === 'strikedown') {
        const r = await D.strike.down(interaction.guild, member, interaction.user.tag);
        if (!r.ok) return interaction.editReply(`<@${uid}> has no active strikes to undo.`);
        return interaction.editReply(`➖ Undid <@${uid}>’s most recent strike — now **${D.strike.format(r.totalUnits)}/${cap} units**${r.totalUnits === 0 ? ' — clean again 💗' : ''}.`);
      }
      if (act === 'strikeclear') { const r = await D.strike.clear(interaction.guild, member, interaction.user.tag); return interaction.editReply(r.cleared ? `🧹 Cleared all strikes on <@${uid}> (removed ${r.cleared}).` : `<@${uid}> had no strikes.`); }
    }
    return interaction.editReply('Unknown action.');
  }

  // Picker openers — gate BEFORE showing the picker. Each replies with a UserSelect; picking triggers
  // fops_pick_* below (either straight to the action, or a short follow-up modal for extra fields).
  if (id === 'fops_corner') return interaction.reply({ content: 'Pick who to corner:', components: [pickerRow('fops_pick_corner', 'Pick a member to corner…')], flags: MessageFlags.Ephemeral });
  if (id === 'fops_corner_multi') {
    const menu = new UserSelectMenuBuilder().setCustomId('fops_pick_cornermulti').setPlaceholder('Pick members to corner (up to 10)…').setMinValues(1).setMaxValues(10);
    return interaction.reply({ content: 'Pick everyone to corner (same duration for all):', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }
  if (id === 'fops_verify') return interaction.reply({ content: 'Pick who to verify:', components: [pickerRow('fops_pick_verify', 'Pick a member to verify…')], flags: MessageFlags.Ephemeral });
  if (id === 'fops_uncorner') return interaction.reply({ content: 'Pick who to release:', components: [pickerRow('fops_pick_uncorner', 'Pick a member to release…')], flags: MessageFlags.Ephemeral });
  if (id === 'fops_ban') return meets(tier, 'admin') ? interaction.reply({ content: 'Pick who to ban:', components: [pickerRow('fops_pick_ban', 'Pick a member to ban…')], flags: MessageFlags.Ephemeral }) : denyReply('admin');
  if (id === 'fops_timings') {
    if (!meets(tier, 'owner')) return denyReply('owner');
    const c = D.config;
    const m = new ModalBuilder().setCustomId('fops_timingsmodal').setTitle('Reaping timings');
    m.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('warn').setLabel('Warn after (days)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(c.warnDays))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('kick').setLabel('Kick after (days, must be > warn)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(c.kickDays))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sweep').setLabel('Sweep interval (minutes)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(c.sweepIntervalMin))));
    return interaction.showModal(m);
  }

  // Watchlist pickers — edits need the ADMINS-★ ROLE (roleTier, not the Admin perm). Gate before showing.
  if (id === 'fops_wl_add') return meets(roleTier, 'admin') ? interaction.reply({ content: 'Pick who to add to the Watchlist:', components: [pickerRow('fops_pick_wladd', 'Pick a member…')], flags: MessageFlags.Ephemeral }) : denyReply('admin');
  if (id === 'fops_wl_remove') return meets(roleTier, 'admin') ? interaction.reply({ content: 'Pick who to remove from the Watchlist:', components: [pickerRow('fops_pick_wlremove', 'Pick a member…')], flags: MessageFlags.Ephemeral }) : denyReply('admin');
  if (id === 'fops_wl_unban') {
    if (!meets(roleTier, 'admin')) return denyReply('admin');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const bans = await interaction.guild.bans.fetch().catch(() => null);
    if (!bans || bans.size === 0) return interaction.editReply('Nobody is banned.');
    const sorted = [...bans.values()].sort((a, b) => a.user.tag.localeCompare(b.user.tag)).slice(0, 25);
    const menu = new StringSelectMenuBuilder().setCustomId('fops_pick_unban').setPlaceholder('Pick who to unban…')
      .addOptions(sorted.map(b => ({ label: b.user.tag.slice(0, 100), value: b.user.id, description: (b.reason || '').slice(0, 100) || undefined })));
    const note = bans.size > 25 ? `\n_Showing 25 of ${bans.size} banned users (alphabetical). Use \`/unban\` (it can search all of them) for anyone outside this list._` : '';
    return interaction.editReply({ content: `Pick who to unban:${note}`, components: [new ActionRowBuilder().addComponents(menu)] });
  }
  if (id === 'fops_wl_termadd') return meets(roleTier, 'admin') ? interaction.showModal(termModal('fops_wl_termaddmodal', 'Add a strict watchlist term')) : denyReply('admin');
  if (id === 'fops_wl_termdel') return meets(roleTier, 'admin') ? interaction.showModal(termModal('fops_wl_termdelmodal', 'Remove a strict watchlist term')) : denyReply('admin');
  if (id === 'fops_wl_ltermadd') return meets(roleTier, 'admin') ? interaction.showModal(termModal('fops_wl_ltermaddmodal', 'Add a loose watch-log term')) : denyReply('admin');
  if (id === 'fops_wl_ltermdel') return meets(roleTier, 'admin') ? interaction.showModal(termModal('fops_wl_ltermdelmodal', 'Remove a loose watch-log term')) : denyReply('admin');
  if (id === 'fops_wl_wtermadd') return meets(roleTier, 'admin') ? interaction.showModal(termModal('fops_wl_wtermaddmodal', 'Add a welfare term')) : denyReply('admin');
  if (id === 'fops_wl_wtermdel') return meets(roleTier, 'admin') ? interaction.showModal(termModal('fops_wl_wtermdelmodal', 'Remove a welfare term')) : denyReply('admin');
  if (id === 'fops_freshflag') {
    if (!meets(roleTier, 'admin')) return denyReply('admin');
    const c = D.config;
    const m = new ModalBuilder().setCustomId('fops_freshmodal').setTitle('New-account flag');
    m.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('auto / off / a number = hours').setStyle(TextInputStyle.Short).setRequired(true).setValue(c.smartWatchFreshMode === 'manual' ? String(Number(c.smartWatchFreshHours) || 0) : (c.smartWatchFreshMode || 'auto'))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pct').setLabel('Auto sensitivity: newest % (e.g. 1)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(Number(c.smartWatchFreshPercentile) || 1))));
    return interaction.showModal(m);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const deny = needed => interaction.editReply(`🔒 That's **${LABEL[needed]}+** only. You're ${LABEL[tier]}.`);
  try {
    if (id === 'fops_refresh') { await interaction.editReply('🔄 Refreshed.'); return refreshPanel(interaction.client); }

    if (id.startsWith('fops_toggle:')) {
      const key = id.slice('fops_toggle:'.length);
      // Owner own the removal POLICY (dry-run / reaping-enable / stale-kick); admins own notifications.
      const need = ['dryRun', 'featureStale', 'staleKick'].includes(key) ? 'owner' : 'admin';
      if (!meets(tier, need)) return deny(need);
      const next = !D.config[key];
      persistOverride({ [key]: next });
      await interaction.editReply(`⚙️ **${key}** → ${next ? 'ON' : 'OFF'}${key === 'dryRun' && !next ? ' — ⚠️ reaping is now **LIVE** (members will be kicked).' : ''}`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_modapps_toggle') {
      if (!meets(tier, 'admin')) return deny('admin');
      const modapps = require('./modapps');
      const nowOpen = !modapps.applicationsOpen();   // flip current state
      await modapps.setApplicationsOpen(interaction.guild, nowOpen);
      try { require('./ownerlog').log(interaction.guild, { emoji: nowOpen ? '✅' : '🚫', title: nowOpen ? 'Mod applications REOPENED' : 'Mod applications CLOSED', color: nowOpen ? 0x57F287 : 0xED4245, detail: `${nowOpen ? 'Reopened' : 'Closed'} via dashboard by <@${interaction.user.id}>.${nowOpen ? '' : ' In-flight applications still finish.'}` }); } catch { /* ownerlog best-effort */ }
      await interaction.editReply(nowOpen ? '✅ Mod applications are now **OPEN**. Members can `/apply-mod`.' : '🚫 Mod applications are now **CLOSED** (team full). Applications already under review still finish.');
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_freshmodal') {
      if (!meets(roleTier, 'admin')) return deny('admin');
      const raw = (interaction.fields.getTextInputValue('mode') || '').trim().toLowerCase();
      const pctRaw = (interaction.fields.getTextInputValue('pct') || '').trim();
      const patch = {};
      if (raw === 'auto') patch.smartWatchFreshMode = 'auto';
      else if (['off', '0', 'no', 'none'].includes(raw)) patch.smartWatchFreshMode = 'off';
      else {
        const h = Number(raw);
        if (!Number.isFinite(h) || h <= 0) return interaction.editReply('Enter **auto**, **off**, or a number of **hours** (e.g. `12`).');
        patch.smartWatchFreshMode = 'manual'; patch.smartWatchFreshHours = h;
      }
      if (pctRaw) { const p = Number(pctRaw); if (Number.isFinite(p) && p > 0 && p <= 50) patch.smartWatchFreshPercentile = p; }
      persistOverride(patch);
      if (D.freshwatch && patch.smartWatchFreshMode === 'auto') D.freshwatch.recompute(interaction.guild);   // apply the new cutoff now
      const desc = patch.smartWatchFreshMode === 'auto' ? `**auto** (newest ${D.config.smartWatchFreshPercentile}%)`
        : patch.smartWatchFreshMode === 'manual' ? `**manual** (< ${patch.smartWatchFreshHours}h)` : '**off**';
      await interaction.editReply(`🌱 New-account flag set to ${desc}.`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_timingsmodal') {
      if (!meets(tier, 'owner')) return deny('owner');
      const warn = Number(interaction.fields.getTextInputValue('warn'));
      const kick = Number(interaction.fields.getTextInputValue('kick'));
      const sweep = Number(interaction.fields.getTextInputValue('sweep'));
      if (![warn, kick, sweep].every(Number.isFinite) || warn < 0 || sweep < 1) return interaction.editReply('Values must be numbers (sweep ≥ 1).');
      if (warn >= kick) return interaction.editReply(`Warn (${warn}d) must be less than kick (${kick}d).`);
      persistOverride({ warnDays: warn, kickDays: kick, sweepIntervalMin: sweep });
      await interaction.editReply(`⏱️ Timings updated — warn ${warn}d → kick ${kick}d · sweep ${sweep}m.`);
      return refreshPanel(interaction.client);
    }

    if (id.startsWith('fops_cornermodal2:')) {
      const uid = id.split(':')[1];
      const member = await interaction.guild.members.fetch(uid).catch(() => null);
      if (!member) return interaction.editReply(copy.common.noMemberInServer);
      const dur = interaction.fields.getTextInputValue('dur').trim();
      const ms = dur ? D.corner.parseDuration(dur) : null;
      if (dur && !ms) return interaction.editReply(copy.corner.badDuration);
      const r = await D.corner.corner(interaction.guild, member, ms, D.state, interaction.user.id);
      if (!r.ok) return interaction.editReply(`Failed: ${r.error}`);
      await interaction.editReply(`⛓️ Cornered <@${member.id}> (\`${member.user.tag}\`)${dur ? ` for ${dur}` : ' indefinitely'} — stripped ${r.stripped} role(s).`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_cornermulti_dur') {
      const stash = _cornerMultiStash.get(interaction.user.id);
      _cornerMultiStash.delete(interaction.user.id);
      if (!stash || !stash.ids?.length) return interaction.editReply('That selection expired — pick the members again.');
      const dur = (interaction.fields.getTextInputValue('dur') || '').trim();
      const ms = dur ? D.corner.parseDuration(dur) : null;
      if (dur && !ms) return interaction.editReply('Bad duration — use `30m`, `2h`, `3d`, `30s`.');
      const members = [];
      for (const uid of stash.ids) { const m = await interaction.guild.members.fetch(uid).catch(() => null); if (m) members.push(m); }
      const actorRank = { owner: 3, admin: 2, mod: 1 }[tierOf(interaction)] || 0;
      const { done, skipped } = await D.cornerMany(interaction.guild, interaction.user.id, actorRank, members, ms, {});
      const lines = [];
      if (done.length) lines.push(`⛓️ Cornered **${done.length}**${dur ? ` for ${dur}` : ' indefinitely'}: ${done.map(x => `<@${x}>`).join(', ')}`);
      if (skipped.length) lines.push(`⚠️ Skipped: ${skipped.join(', ')}`);
      await interaction.editReply({ content: lines.join('\n') || 'Nobody cornered.', allowedMentions: { parse: [] } });
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_banmodal2:')) {
      if (!meets(tier, 'admin')) return deny('admin');
      const [, uid, category] = id.split(':');
      const member = await interaction.guild.members.fetch(uid).catch(() => null);
      if (!member) return interaction.editReply(copy.common.noMemberInServer);
      if (member.permissions.has(PermissionsBitField.Flags.Administrator) || member.id === interaction.guild.ownerId)
        return interaction.editReply(copy.guards.refuseBanStaff);
      const detail = (interaction.fields.getTextInputValue('reason') || '').trim();
      const reason = `${CATEGORY_LABEL[category] || 'Other'}${detail ? ` — ${detail}` : ''} (via dashboard by ${interaction.user.tag})`;
      await member.ban({ reason });
      return interaction.editReply(`🔨 Banned <@${member.id}> (\`${member.user.tag}\`) — **${CATEGORY_LABEL[category] || 'Other'}**.`);
    }

    if (id === 'fops_sweep') {
      if (!meets(tier, 'admin')) return deny('admin');
      await D.sweep.runOnce(interaction.client, D.state, {
        getVerifyChannel: D.getVerifyChannel, getAlertChannel: D.getAlertChannel,
        getWarnChannel: D.getWarnChannel, getConflictChannel: D.getConflictChannel });
      await interaction.editReply('🧹 Sweep complete.');
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_conflicts_scan') {
      const unv = D.config.unverifiedRoleId, ver = D.config.verifiedRoleId;
      if (!unv) return interaction.editReply('No unverified role configured — nothing to check.');
      const members = await interaction.guild.members.fetch();
      const dual = [...members.filter(m => m.roles.cache.has(ver) && m.roles.cache.has(unv)).values()];
      if (!dual.length) return interaction.editReply('✅ No role conflicts.');
      const rows = [];
      for (const m of dual.slice(0, 4)) {
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`conflict_rm:${m.id}:unver`).setLabel(`${m.user.tag}: keep Verified`.slice(0, 80)).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`conflict_rm:${m.id}:ver`).setLabel('keep Unverified').setStyle(ButtonStyle.Secondary)));
      }
      const extra = dual.length > 4 ? `\n…and ${dual.length - 4} more — a sweep flags the rest to the conflict channel.` : '';
      return interaction.editReply({ content: `⚖️ **${dual.length}** role conflict(s):\n${dual.slice(0, 10).map(m => `• <@${m.id}> (\`${m.user.tag}\`)`).join('\n')}${extra}`, components: rows });
    }

    // ── Watchlist actions (edits gate on roleTier = ADMINS-★; list buttons = any staff, view-only) ──
    if (id.startsWith('fops_unbanmodal2:')) {
      if (!meets(roleTier, 'admin')) return deny('admin');
      const uid = id.split(':')[1];
      const keep = /^(y|yes|true|1|on)/i.test((interaction.fields.getTextInputValue('watchlist') || '').trim());
      try { await interaction.guild.bans.remove(uid, `Unban via dashboard by ${interaction.user.tag}`); }
      catch (e) { return interaction.editReply(`❌ Unban failed: ${e.message} (are they actually banned?)`); }
      if (keep) watchlist.addPending(uid);
      return interaction.editReply(`✅ Unbanned <@${uid}>.${keep ? " They'll get the Watchlist role when they rejoin." : ''}`);
    }
    if (id === 'fops_wl_termaddmodal' || id === 'fops_wl_termdelmodal') {
      if (!meets(roleTier, 'admin')) return deny('admin');
      const term = (interaction.fields.getTextInputValue('term') || '').trim();
      if (!term) return interaction.editReply('Enter a term.');
      const t = id === 'fops_wl_termaddmodal' ? watchlist.addTerm(term) : watchlist.removeTerm(term);
      await interaction.editReply(`${id === 'fops_wl_termaddmodal' ? '➕ Added' : '➖ Removed'} strict term \`${term}\`. ${t.length} strict term(s) now.`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_wl_ltermaddmodal' || id === 'fops_wl_ltermdelmodal') {
      if (!meets(roleTier, 'admin')) return deny('admin');
      const term = (interaction.fields.getTextInputValue('term') || '').trim();
      if (!term) return interaction.editReply('Enter a term.');
      const t = id === 'fops_wl_ltermaddmodal' ? watchlist.addLoose(term) : watchlist.removeLoose(term);
      await interaction.editReply(`${id === 'fops_wl_ltermaddmodal' ? '➕ Added' : '➖ Removed'} loose term \`${term}\`. ${t.length} loose term(s) now.`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_wl_wtermaddmodal' || id === 'fops_wl_wtermdelmodal') {
      if (!meets(roleTier, 'admin')) return deny('admin');
      const term = (interaction.fields.getTextInputValue('term') || '').trim();
      if (!term) return interaction.editReply('Enter a term.');
      const t = id === 'fops_wl_wtermaddmodal' ? watchlist.addWelfare(term) : watchlist.removeWelfare(term);
      await interaction.editReply(`${id === 'fops_wl_wtermaddmodal' ? '➕ Added' : '➖ Removed'} welfare term \`${term}\`. ${t.length} welfare term(s) now.`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_wl_termlist') {
      const s = watchlist.loadTerms(), l = watchlist.loadLoose(), w = watchlist.loadWelfare();
      return interaction.editReply(`**Strict (${s.length})** → ban:\n${s.map(t => `\`${t}\``).join(' · ') || '_none_'}\n\n**Loose (${l.length})** → #watch-log:\n${l.map(t => `\`${t}\``).join(' · ') || '_none_'}\n\n**Welfare (${w.length})** → check-in:\n${w.map(t => `\`${t}\``).join(' · ') || '_none_'}`.slice(0, 1900));
    }
    if (id === 'fops_wl_list') {
      if (!D.config.watchlistRoleId) return interaction.editReply(copy.common.noWatchlistRole);
      await interaction.guild.members.fetch().catch(() => {});
      const role = await interaction.guild.roles.fetch(D.config.watchlistRoleId).catch(() => null);
      const members = role ? [...role.members.values()] : [];
      const pend = watchlist.loadPending();
      return interaction.editReply(`**On the Watchlist (${members.length}):**\n${members.map(m => `• <@${m.id}> \`${m.user.tag}\``).join('\n') || '_none_'}`.slice(0, 1800)
        + (pend.length ? `\n**Pending re-watchlist (${pend.length}):** ${pend.map(x => `<@${x}>`).join(', ')}` : ''));
    }

    await interaction.editReply('Unknown action.');
  } catch (e) {
    await interaction.editReply(`Error: ${e.message}`);
  }
}

module.exports = { wire, ensurePanel, ensureCommandRef, refreshPanel, isPanelInteraction, handlePanel, openPersonalPanel, openReadOnly, tierOf, memberTier, isBotOwner, BOT_OWNER_ID, PAGES, PANEL_FILE, CATEGORY_LABEL, OWNER_ROLE_IDS, OWNER_DISPLAY_ROLE_ID, ADMIN_ROLE_ID, MOD_ROLE_ID };
