// opspanel.js — pinned, TIER-GATED ops dashboard for the FUBU bot, in the mod-only dashboard channel.
// One pinned message, edited in place, nav via a select menu. TIERS (owner ⊇ admin ⊇ mod) gate actions:
// the pinned panel shows everything, but each action re-checks the clicker's tier and refuses if they
// don't meet it. Deps (state/corner/sweep/config/…) are injected by index.js via wire() so the panel
// reuses the bot's own logic. Members are targeted by @username / display name / ID (resolved live).
const fs = require('fs');
const { statePath } = require('./statepath');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } = require('discord.js');
const { MessageFlags } = require('discord.js');
const copy = require('./copy');   // single source of truth for public-facing text (see copy.js)
const { ensureMembers } = require('./memberCache');
const overridesManager = require('./overridesManager');

const PANEL_FILE = process.env.FUBU_OPS_PANEL_FILE || statePath('ops_panel.json');
// Separate pinned message: a static staff command reference (the "what every command does" list that used
// to bloat the Overview page). Kept as its own pinned message at the top of #mod-dashboard so the live
// panel stays lean. Its own ref file so it never collides with the interactive panel's ref.
const GUIDE_REF_FILE = process.env.FUBU_OPS_GUIDE_FILE || statePath('ops_guide.json');

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
const BOT_OWNER_ID = process.env.FUBU_BOT_OWNER_ID || '865843812907089940';   // primary owner (DM target + attribution identity)
// Owner ALT accounts: full bot-owner authority, but their moderation actions are ATTRIBUTED TO THE PRIMARY
// owner in logs/announcements (owner's alt, 2026-08-25) — so an action taken from the alt reads as the owner.
// Corners are exempt (they already have a per-action "anon" option).
const BOT_OWNER_ALT_IDS = (process.env.FUBU_BOT_OWNER_ALT_IDS || '787143702656712715').split(',').map(s => s.trim()).filter(Boolean);
const BOT_OWNER_IDS = new Set([BOT_OWNER_ID, ...BOT_OWNER_ALT_IDS]);
// Show an action's actor as the PRIMARY owner when it was taken from an owner alt. Use at attribution points
// (`<@${attributeActor(actorId)}>`) so the alt is never surfaced by name.
function attributeActor(id) { return BOT_OWNER_ALT_IDS.includes(id) ? BOT_OWNER_ID : id; }
// Corner attribution is different from every other action: the owner wants corners from an alt to read as
// ANONYMOUS (not as the owner). Returns '🎭 Anonymous Staff' when the anon toggle is on OR the actor is an
// owner alt; otherwise the actor's mention. '' when there's no actor.
function cornerActor(actorId, isAnon) {
  if (isAnon || BOT_OWNER_ALT_IDS.includes(actorId)) return '🎭 Anonymous Staff';
  return actorId ? `<@${actorId}>` : '';
}
// 'staff' (owner, 2026-08-20: "generalized to the staff tier everywhere") is the floor rank below Mod —
// Trial Mod, any language Mini-Mod, and Event Organizer all resolve to it (see memberTier below). It is
// NOT the same thing as "any real tier" used to mean — every bare truthy tierOf()/memberTier() check
// that meant "mod or above" had to be swept to meets(tier, 'mod') instead, or 'staff' would silently
// qualify. See the memberTier comment for exactly which roles land here.
const RANK = { staff: 1, mod: 2, admin: 3, owner: 4, botowner: 5 };
const meets = (tier, needed) => (RANK[tier] || 0) >= (RANK[needed] || 99);
// True for the bot owner (primary OR any owner alt). Accepts an interaction (.user.id) or a member (.id).
function isBotOwner(x) { const id = x && (x.user ? x.user.id : x.id); return !!id && BOT_OWNER_IDS.has(id); }

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
  // A cornered member's live roles are STRIPPED (the jail mechanism, not a demotion) — so checking live
  // roles alone would see a jailed mod as a regular member. Fall back to the pre-corner role snapshot
  // corner.js stored, so a mod/admin keeps being recognized as staff the whole time they're cornered,
  // exactly as if they still held the role — until an actual bot demote command changes it (owner,
  // 2026-08-18: "A mod should always be considered whatever their level is even in the corner unless
  // demoted through the bot"). demote-mod/demote-admin edit this same stored snapshot for a cornered
  // target, since target.roles.remove() is a no-op on a role they don't currently hold.
  let effRoles = roles;
  try {
    const rec = D && D.state && D.state.getCornered(member.id);
    if (rec && Array.isArray(rec.roles)) { const set = new Set(rec.roles); effRoles = { has: id => set.has(id) }; }
  } catch { /* fall through to live roles */ }
  if (effRoles.has(ADMIN_ROLE_ID)) return 'admin';
  if (effRoles.has(MOD_ROLE_ID)) return 'mod';
  if (isStaffFloorRoles(effRoles)) return 'staff';
  return null;
}
// 'staff' floor (owner, 2026-08-20): Trial Mod, any language Mini-Mod, or Event Organizer — the exact
// same set index.js's isTrialMod/isAnyMiniMod/hasTrialCornerTier check, generalized into the real tier
// ladder instead of a parallel one-off boolean. Takes the already-cornered-aware effRoles (a plain
// `.has(id)` object, live roles.cache or the pre-corner snapshot — see memberTier above), not a member,
// so it works identically whether the member is currently jailed or not.
// eventorgapps.js requires opspanel.js — lazy-require here (same pattern as modapps.js elsewhere in this
// file) so this doesn't become a load-time circular require.
function isStaffFloorRoles(effRoles) {
  if (D && D.config && D.config.trialModRoleId && effRoles.has(D.config.trialModRoleId)) return true;
  if (langmods.languages().some(lang => { const rid = langmods.roleForLang(lang); return rid && effRoles.has(rid); })) return true;
  const eventorgapps = require('./eventorgapps');
  if (effRoles.has(eventorgapps.ORGANIZER_ROLE_ID)) return true;
  // Media Team / Greeter / Support Helper (owner, 2026-08-22) — staff-floor positions with NO cornering
  // (see index.js — deliberately excluded from hasTrialCornerTier). Each empty until its role id is set
  // (Media Team live; greeter/support dark). Media Team is the merged Advertiser + Content Creator role.
  if (D && D.config) for (const k of ['mediaRoleId', 'greeterRoleId', 'supportRoleId'])
    if (D.config[k] && effRoles.has(D.config[k])) return true;
  return false;
}
// ACTOR authority tier — who can USE things. Ladder: mod (MODS-✰) < admin (ADMINS-★ role) < owner < server
// owner < bot owner. The bot owner is supreme BY USER ID (role-independent → keeps access even role-stripped,
// and deliberately NOT gated by the cornered-check below — a bot-owner corner is either a mistake or an
// attack, and locking the one identity with no other recovery path out of the bot's own tools entirely would
// be worse than the alternative).
// OWNER tier requires BOTH the OWNER role AND the Administrator permission (safeguard; see memberTier).
// Note "admin" = the ADMINS-★ role, NOT the Administrator permission.
//
// Found 2026-08-19: this used to just be memberTier(interaction.member) — but memberTier() ALSO falls back to
// a cornered member's pre-corner role snapshot (see memberTier's comment) so a jailed mod's STANDING still
// resolves correctly when someone ELSE checks it (demoting them, displaying their tier). tierOf(interaction)
// is different — it's ALWAYS about the person who triggered THIS interaction, i.e. "what can they actively DO
// right now" — and every staff-gated command/button in the bot (canBan, canWLAdmin, isOwner, modClicked, the
// dashboard's meets() gate, and ~40 direct call sites) ultimately asks this question through here. Without this
// check, a cornered mod/admin's own tier check still passed, letting them e.g. /uncorner themselves or others
// while jailed. The snapshot fallback is correct for memberTier() as a TARGET lookup; it must never grant the
// cornered person THEMSELVES active authority, so gate it here instead of touching memberTier() itself.
function tierOf(interaction) {
  if (isBotOwner(interaction)) return 'botowner';
  try {
    if (D && D.state && D.state.getCornered(interaction.user.id)) return null;
  } catch { /* fall through to the normal tier check */ }
  return memberTier(interaction.member);   // owner requires OWNER role AND Admin perm (in memberTier); no perm-alone shortcut
}

// page tiers: min tier to USE the actions on the page (everyone mod+ can VIEW every page).
// Order: status → day-to-day mod (mod tier) → anon tools (mod) → admin pages → owner-only Danger last.
const PAGES = [
  { emoji: '📊', name: 'Overview', tier: 'mod', blurb: 'status at a glance' },
  { emoji: '🛡️', name: 'Moderation', tier: 'mod', blurb: 'corner · verify · release a member' },
  { emoji: '⛓️', name: 'Corner', tier: 'mod', blurb: "who's timed-out + release them" },
  { emoji: '⚠️', name: 'Strikes', tier: 'mod', blurb: 'everyone with active strikes, click to remove one' },
  { emoji: '⚖️', name: 'Conflicts', tier: 'mod', blurb: 'fix members who have both roles' },
  { emoji: '🔒', name: 'Anon Tools', tier: 'mod', blurb: 'confessions · reports · modmail · whistleblow · suggestions' },
  { emoji: '👁️', name: 'Watchlist', tier: 'admin', blurb: 'unban · watchlist · flagged terms (needs Admin)' },
  { emoji: '🔨', name: 'Actions', tier: 'admin', blurb: 'run the bot now · ban (needs Admin)' },
  { emoji: '🏅', name: 'Promotions', tier: 'admin', blurb: 'open promotion votes: trial→mod / mod→admin (multi-select)' },
  { emoji: '⚙️', name: 'Settings', tier: 'admin', blurb: 'turn helpers on/off (needs Admin)' },
  { emoji: '🧩', name: 'Setup', tier: 'admin', blurb: 'create channels + (re)post member panels (needs Admin)' },
  { emoji: '⚠️', name: 'Danger', tier: 'owner', blurb: 'removal policy (needs Owner)' },
  { emoji: '🛡️', name: 'Overrides', tier: 'owner', blurb: 'personal corner overrides & special powers (needs Owner)' },
];
const pageIdx = (name) => PAGES.findIndex(p => p.name === name);   // reorder-safe page lookup
const watchlist = require('./watchlist');
const features = require('./features');
const langmods = require('./langmods');

// Instant-ban reason categories — used to write the ban's audit-log reason AND (in appeals.js) to
// recognize which bans the "more limited" ban-appeal path must refuse outright.
const CATEGORY_LABEL = { false_verification: 'False verification / not eligible', verification_bypass: 'Verification bypass / misrepresenting identity', ban_evasion: 'Ban evasion (alt account)', grooming: 'Confirmed grooming of a minor', other: 'Other' };
// Per-category emoji for the ban-reason select — keyed by the same values as CATEGORY_LABEL so the dropdown
// derives its labels from that single const (change a label there → the select updates too).
const CATEGORY_EMOJI = { false_verification: '🚫', verification_bypass: '🎭', ban_evasion: '👤', grooming: '⚠️', other: '❓' };

let D = null;
function wire(deps) { D = deps; }
const _cornerMultiStash = new Map();   // modId -> {ids, at}: carries a multi-corner selection to its duration modal
setInterval(() => { const cut = Date.now() - 15 * 60 * 1000; for (const [k, v] of _cornerMultiStash) if ((v.at || 0) < cut) _cornerMultiStash.delete(k); }, 10 * 60 * 1000).unref();   // audit N13: abandoned selections used to leak forever
function loadRef() { try { return JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8')); } catch { return {}; } }
function saveRef(r) { try { fs.writeFileSync(PANEL_FILE, JSON.stringify(r)); } catch (e) { console.error('[fops] save:', e.message); } }

// Persist a config override (survives restart via config.js merge) AND apply it live.
function persistOverride(patch) {
  const f = (D.config && D.config.overrideFile) || statePath('config_overrides.json');
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
// Always a mention — one consistent style for every row (owner, 2026-08-23: "there are two different
// formats"). The old version rendered cached members as **BoldName** but uncached/departed ones as a
// <@id> mention, so member lists showed a mix. A mention resolves to the member's current name for
// everyone and never pings from inside an embed (embeds don't fire mentions), which is where these lists
// live. The `…1234` tag beside it (memberTag) still ties each row to its Manage button.
function memberLabel(id) { return `<@${id}>`; }
const memberTag = id => `\`…${String(id).slice(-4)}\``;   // matches the per-member button's last-4 label

// --- render helpers ---------------------------------------------------------------------------------
function navRow(page) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fops_nav')
      .setPlaceholder(`${PAGES[page].emoji} ${PAGES[page].name} · jump to a page…`)
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
// Same idea as toggleBtn but for a features.js registry flag instead of a D.config key (owner-gated —
// see the fops_ftoggle: handler).
function featureToggleBtn(key, label) {
  const on = features.enabled(key);
  return new ButtonBuilder().setCustomId(`fops_ftoggle:${key}`).setLabel(`${label}: ${on ? 'ON' : 'OFF'}`)
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
      .setPlaceholder(`${PAGES[page].emoji} ${PAGES[page].name} · jump to a page…`).addOptions(opts));
}
// Render a page for the personal panel: same content as the shared pages, but with the tier-filtered
// nav swapped in (it's always the last component) and marked ephemeral.
async function buildPersonal(page, tier) {
  const payload = await buildPage(page);
  payload.components = [...payload.components];
  payload.components[payload.components.length - 1] = navRowPersonal(page, tier);
  payload.ephemeral = true;
  // On the Overview (landing) page, append a "what you can do" summary for this tier — the mod/admin/owner
  // equivalent of the staff-floor capability embeds.
  if (page === pageIdx('Overview')) payload.embeds = [...(payload.embeds || []), tierCapabilityEmbed(tier)];
  return payload;
}
async function openPersonalPanel(interaction) {
  const tier = tierOf(interaction);
  // Defense in depth, not the primary gate: the /panel command routes 'staff' tier to openStaffFloorPanel()
  // before this ever runs (index.js), but this function is itself a security boundary (the full
  // interactive panel), so it must not trust the caller — require mod+ explicitly, not just "any tier",
  // now that 'staff' is a real (lower) tier value and would otherwise pass a bare truthy check.
  if (!meets(tier, 'mod')) return interaction.reply({ content: 'This panel is for the mod team.', flags: MessageFlags.Ephemeral });
  return interaction.reply(await buildPersonal(0, tier));
}
// Personalized staff-floor panel (owner, 2026-08-22: "their own personalized panels"). Replaces the old
// single openReadOnly that hardcoded "🔰 Trial Mod" + listed /verify for EVERY staff-floor role — a
// mislabel, since Mini-Mods and Event Organizers never had verify. Now shows a section only for each role
// the member ACTUALLY holds, so the panel is accurate for combos too. `roles` = which staff-floor roles
// this member holds: { trial, miniMod, advertiser, miniModEntries: [{lang, channelIds}] }. (Lone Event
// Organizers are routed to the interactive contest panel in index.js and never reach here.)
async function openStaffFloorPanel(interaction, roles) {
  const embeds = [];
  // Verification overview only matters to Trial Mods (the only staff-floor role that verifies).
  if (roles.trial) { const p = await buildOverview(); embeds.push(p.embeds[0]); }

  if (roles.trial) {
    embeds.push(new EmbedBuilder().setColor(0x1abc9c).setTitle('🌱 Trial Mod: what you can do').setDescription(
      '`/verify @member`: verify a waiting member (or hit the ✅ **Verify** button in their thread)\n' +
      '`/pending`: flip through everyone waiting to be verified\n' +
      '`/corner @member`: time a member out (or right-click a message → Apps → Send to corner). **You must pick a rule OR give a reason, max 1 hour, one person at a time**\n' +
      '`/uncorner @member`: release someone from the corner\n' +
      '`/sidebar @member`: pull someone aside for a private chat (or right-click → Apps → Sidebar). Not punishment, just a quiet conversation\n\n' +
      '**Straight from your role:** **Manage Messages** (delete or pin any message). Delete rule-breaking messages freely. Timeouts go only through `/corner` (you don’t have Discord’s raw timeout), which carries a rule, the 1-hour cap, single target, and a log.\n\n' +
      '_You’ll get pinged when someone needs verifying. Ban, strike, watchlist, and media blocking stay mod-only; those unlock when you’re promoted._')
      .setFooter({ text: 'Trial Mod: restricted training tier.' }));
  }
  if (roles.miniMod) {
    // Scope is the whole CATEGORY (owner, 2026-08-22) — describe by category, resolving names where we can,
    // and fall back to the scope label / configured channels if the category can't be resolved.
    const langmods = require('./langmods');
    const catIds = new Set();
    for (const e of (roles.miniModEntries || [])) for (const c of langmods.scopeCategories(e)) catIds.add(c);
    const catNames = [...catIds].map(id => { const c = interaction.guild?.channels?.cache?.get(id); return c ? `**${c.name}**` : `<#${id}>`; });
    const chans = (roles.miniModEntries || []).flatMap(e => (e.channelIds || [])).filter(Boolean);
    // Category-scoped (a dedicated category set) vs. channel-scoped (specific channels only) — describe
    // accurately, since not every scope has its own category (e.g. LGBTQ lives in the shared Community cat).
    const where = catNames.length
      ? `${catNames.join(', ')} — **every channel in ${catNames.length > 1 ? 'those categories' : 'that category'}**`
      : (chans.length ? chans.map(id => `<#${id}>`).join(', ') : '_your assigned channel(s)_');
    const scopeWord = catNames.length ? 'category' : 'channels';
    embeds.push(new EmbedBuilder().setColor(0x9b59b6).setTitle('🌐 Mini-Mod: what you can do').setDescription(
      `You moderate: ${where}\n\n` +
      `**Send to corner** (right-click a message → Apps): time out a member, but **only for messages in your ${scopeWord}**, rule/reason required, max 1 hour.\n` +
      `**Report to watchlist** (right-click a message → Apps): flag a message to staff, again only in your ${scopeWord}.\n\n` +
      '_No `/verify`, no server-wide `/corner`, no ban/strike/watchlist. Your tools are scoped to the space you look after._')
      .setFooter({ text: 'Mini-Mod: scoped moderation.' }));
  }
  if (roles.eventOrg) {
    // Only reached for an Event Organizer who ALSO holds another staff-floor role (a lone Event Organizer
    // gets the interactive contest panel instead, in index.js). Describe their event tools as text.
    embeds.push(new EmbedBuilder().setColor(0xf39c12).setTitle('🎪 Event Organizer: what you can do').setDescription(
      '`/contest`: start / end / manage the monthly contest rounds; reveal entrants.\n' +
      '**Live tally**: react with the tally emoji on an entry to count it.\n' +
      '**Vote** on new Event Organizer applications (👍/👎, advisory).\n' +
      '`/corner` **in event channels only**: during an event you can time someone out, but scoped to the events category, not server-wide.\n\n' +
      '_No `/verify`, no ban/strike/watchlist._')
      .setFooter({ text: 'Event Organizer: events + scoped moderation.' }));
  }
  const linkBtns = [];
  const chanLink = id => `https://discord.com/channels/${interaction.guild.id}/${id}`;
  if (roles.media) {
    const sp = require('./staffpositions');
    const coordId = sp.media.coordChannelId(); const showcaseId = sp.mediaShowcaseId();
    embeds.push(new EmbedBuilder().setColor(0xe67e22).setTitle('🎬 Media Team: what you can do').setDescription(
      '**`/create submit`**: submit a clip, image, or meme (with a caption). Once staff approve it, it posts to ' + (showcaseId ? `<#${showcaseId}>` : '**#showcase**') + ' for everyone.\n' +
      '**`/advertise submit`**: submit a promo clip. Once approved, it’s staged for posting to the server’s socials (TikTok).\n' +
      (coordId ? `**Coordinate** in <#${coordId}>: share WIPs, drafts, and get feedback.\n` : '') +
      '\n_You make + promote content. No moderation powers (no corner, verify, or bans), by design._')
      .setFooter({ text: 'Media Team: make + promote, not moderate.' }));
    if (coordId && interaction.guild) linkBtns.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Media chat').setEmoji('🎬').setURL(chanLink(coordId)));
  }
  if (roles.greeter) {
    const coordId = require('./staffpositions').greeter.coordChannelId();
    embeds.push(new EmbedBuilder().setColor(0x1abc9c).setTitle('👋 Greeter: what you can do').setDescription(
      'Help welcome and onboard new members — say hi, point them to the rules/roles, and answer first questions.\n' +
      (coordId ? `**Coordinate** in <#${coordId}>.\n` : '') +
      '\n_No moderation powers; you’re a friendly face, by design._')
      .setFooter({ text: 'Greeter: welcome + onboard.' }));
    if (coordId && interaction.guild) linkBtns.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Greeter chat').setEmoji('👋').setURL(chanLink(coordId)));
  }
  if (roles.support) {
    const coordId = require('./staffpositions').support.coordChannelId();
    embeds.push(new EmbedBuilder().setColor(0x3498db).setTitle('🛟 Support Helper: what you can do').setDescription(
      'Answer members’ questions in the help space and help them find their way around.\n' +
      (coordId ? `**Coordinate** in <#${coordId}>.\n` : '') +
      '\n_No moderation powers; you help, you don’t enforce, by design._')
      .setFooter({ text: 'Support Helper: help, not enforce.' }));
    if (coordId && interaction.guild) linkBtns.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Support chat').setEmoji('🛟').setURL(chanLink(coordId)));
  }
  const components = linkBtns.length ? [new ActionRowBuilder().addComponents(...linkBtns.slice(0, 5))] : [];
  if (!embeds.length) embeds.push(new EmbedBuilder().setColor(0x99AAB5).setDescription('_No staff-floor tools are configured for your role right now._'));
  return interaction.reply({ content: '## Your staff panel', embeds: embeds.slice(0, 10), components, flags: MessageFlags.Ephemeral });
}

// --- pages ------------------------------------------------------------------------------------------
async function buildOverview() {
  const [pending, cornered] = [await pendingCount(), corneredMap()];
  const c = D.config;
  // Same "left the server" filter as buildCorner — a cornered member who left isn't visibly in the corner.
  const overviewGuild = D.client.guilds.cache.get(D.config.guildId) || D.client.guilds.cache.first();
  const corneredCount = Object.keys(cornered).filter(id => overviewGuild?.members.cache.has(id)).length;
  const embed = new EmbedBuilder().setColor(0x5865f2).setDescription(
    '**Status right now.** Use the **dropdown below** to act. 📖 A full **command reference** is pinned at the top of this channel.\n\n' +
    `**🧵 Waiting to be verified:** ${pending} (opened a thread, need a mod to check them).\n` +
    `**⛓️ In the corner:** ${corneredCount} (timed-out: roles removed, locked to the corner).\n` +
    `**🧹 Auto-removal:** ${c.dryRun ? '🟡 **TEST MODE**, *not* removing anyone' : '🟢 **ON**, removing for real'} · warns after **${c.warnDays}d**, removes after **${c.kickDays}d**.\n` +
    `**🔔 Helpers:** mod-nudges ${c.featureNudge ? 'on' : 'off'} · double-role flag ${c.conflictPing ? 'on' : 'off'} · weekly self-fix ${c.reactResolveEnabled ? 'on' : 'off'} · daily recap ${c.digestEnabled ? `${c.digestHour}:00` : 'off'}.`)
    .setFooter({ text: 'Anything marked 🔒 needs a higher role (Admin or Owner). Full command list is the pinned reference above.' }).setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_refresh').setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary));
  return { content: '## 🛡️ FUBU Ops · Overview', embeds: [embed], components: [row, navRow(pageIdx('Overview'))] };
}

// A concise "what you can do" summary shown on the mod/admin/owner panel's Overview — mirrors the
// staff-floor "what you can do" embeds so every tier sees its capabilities AND the native Discord perms its
// role actually carries. Bot tools + native perms verified against the command gates + the live role perms.
function tierCapabilityEmbed(tier) {
  if (tier === 'mod') {
    return new EmbedBuilder().setColor(0x3498db).setTitle('✰ Mod: what you can do').setDescription(
      'Everything a Trial Mod can, plus:\n' +
      '`/ban`: ban a member (the bot bans for you; your role has no native ban)\n' +
      '`/strike`: weighted-unit strikes, auto-ban at 10 units\n' +
      '**Watchlist**: Report to watchlist, and the `/watchlist-suggest` scan\n' +
      '**Block this GIF / attachment**: media filters\n' +
      '`/corner-status`: fix a mis-flagged corner\n' +
      '**Full corners**: longer than 1 hour, and more than one person at once\n' +
      'Open a **Trial Mod → Mod** promotion vote\n\n' +
      '**Straight from your role:** Kick, native Timeout (Moderate Members), Manage Messages, Manage Nicknames, Manage Threads, voice moderation (mute / deafen / move), View Audit Log. No native Ban, Manage Roles, or Manage Channels.')
      .setFooter({ text: 'Mod: full day-to-day enforcement.' });
  }
  if (tier === 'admin') {
    return new EmbedBuilder().setColor(0xe67e22).setTitle('⭐ Admin: what you can do').setDescription(
      'Everything a Mod can, plus:\n' +
      '`/unban`: unban a member\n' +
      '**Curate the watchlist**: add or remove entries and terms (`/watchlist-terms`)\n' +
      '`/appeal-reset`: reset a ban appeal\n' +
      '`/tribe-admin`: create, register, or disband tribes, and post the tribe hub\n' +
      '`/promote-mod` (**Mod → Admin** vote), and demote mods or admins\n' +
      '`/role-category`: file roles into their categories\n' +
      '`/partner`: manage server partnerships (add/remove partner cards, reveal the channel)\n' +
      'Pin the strike-weights guide, run the role-fix audits, launch tribe games / arenas / trials\n\n' +
      '**Straight from your role, on top of a Mod:** Ban, Manage Roles, Manage Channels, Manage Webhooks, Manage Events, Manage Emojis.')
      .setFooter({ text: 'Admin: structure on top of enforcement.' });
  }
  // owner / botowner
  return new EmbedBuilder().setColor(0xf1c40f).setTitle('👑 Owner: what you can do').setDescription(
    'Everything an Admin can, plus the **Danger** and **Overrides** pages: removal policy, and personal corner overrides / special powers. Full native Discord permissions.')
    .setFooter({ text: 'Owner: everything.' });
}

// --- Anon Tools page: the anonymous reporting/feedback system at a glance (read-only reference + counts).
function _stateCount(file, key) { try { return JSON.parse(fs.readFileSync(file, 'utf8'))[key] || 0; } catch { return 0; } }
function buildAnonTools() {
  // Module STATE_FILE consts, not re-derived names (audit N13): re-deriving bypassed the modules'
  // FUBU_*_FILE env overrides, silently showing 0 for every counter if one was ever set.
  const conf = _stateCount(require('./confessions').STATE_FILE, 'counter');
  const rep = _stateCount(require('./reports').STATE_FILE, 'counter');
  const mm = _stateCount(require('./modmail').STATE_FILE, 'counter');
  const wb = _stateCount(require('./whistleblow').STATE_FILE, 'counter');
  const sug = _stateCount(require('./suggestions').STATE_FILE, 'counter');
  let sugOpen = 0;
  try { const s = JSON.parse(fs.readFileSync(require('./suggestions').STATE_FILE, 'utf8')); sugOpen = Object.values(s.posts || {}).filter(p => p.status === 'open').length; } catch {}
  const embed = new EmbedBuilder().setColor(0x9b59b6).setDescription(
    'The anonymous **reporting + feedback** system. Confess/Report/Modmail/Suggest are **buttons on `/dashboard`**; `/whistleblow` is still its own slash command. The mod-side actions (reveal / delete / unseal / approve) live **on the posts themselves**, not here.')
    .addFields(
      { name: '📈 Totals so far', value: `🤫 Confessions **${conf}** · 🚩 Reports **${rep}** · 📨 Modmail **${mm}** · 🕊️ Whistleblows **${wb}** · 💡 Suggestions **${sug}** (**${sugOpen}** open)` },
      { name: '🤫 Confess (dashboard button)', value: 'Anonymous in **#confessions**; real author + **🗑 Delete** in **#confession-log**. Every mod sees the author.' },
      { name: '🚩 Report (dashboard button · right-click → Apps → Report)', value: 'Lands in **#anon-reports**. Reporter hidden; **admins** hit **🔍 Reveal reporter** (with cause · logged).' },
      { name: '📨 Modmail (dashboard button)', value: 'Lands in **#mod-inbox**. Only **owners** can **🔍 Reveal sender**.' },
      { name: '🕊️ /whistleblow', value: 'DMed to who the sender picked (head-admin / owner / both / anonymous). Sealed → **🔓 Unseal** by the entrusted person only (logged). "No one" = never unmaskable.' },
      { name: '💡 Suggest (dashboard button)', value: 'Forum post with ⬆/⬇ votes; staff **✅ Approve** / **❌ Deny** → auto-archives. Not anonymous.' },
      { name: '🔑 Who can reveal', value: 'confessions = all mods · reports = admins · modmail = owners · whistleblow = only who the sender chose. Reveal only with cause.' },
      { name: '⏱️ Limits / member', value: 'confess 3m · 20/day · suggest 10m · 3 open · report+modmail 30m · 6/day · whistleblow 60m · 4/day' })
    .setFooter({ text: 'Members reach these via /dashboard (Confess/Report/Modmail/Suggest) or /whistleblow.' }).setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_refresh').setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary));
  return { content: '## 🔒 FUBU Ops · Anon Tools', embeds: [embed], components: [row, navRow(pageIdx('Anon Tools'))] };
}

function buildModeration() {
  const embed = new EmbedBuilder().setColor(0x4ec5c1).setDescription(
    '**Easiest way:** pick a member from the **dropdown** below, then choose Corner / Verify / Uncorner / Ban. ' +
    'No typing needed.\n_(Prefer typing? The buttons under it still take a username or ID.)_\n\n' +
    '⛓️ **Corner**: times them out: removes their roles and locks them to the corner channel until you release them.\n' +
    '✅ **Verify**: gives the **Verified** role and removes **Unverified**.\n' +
    '🔓 **Uncorner**: lets them out early and gives their roles back.\n' +
    '⛓️ **Corner several…**: pick up to 10 members and corner them all for the same duration.')
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
  // A cornered member who left the server stays cornered in state (so a rejoin sends them straight back),
  // but they're not "in the corner" anywhere visible right now — owner, 2026-08-17: don't list them here.
  const guild = D.client.guilds.cache.get(D.config.guildId) || D.client.guilds.cache.first();
  const ids = Object.keys(cornered).filter(id => guild?.members.cache.has(id));
  const lines = [];
  const rows = [];
  let row = new ActionRowBuilder();
  for (const id of ids.slice(0, 20)) {
    const rec = cornered[id] || {};
    const rel = rec.releaseAt ? `<t:${Math.floor(rec.releaseAt / 1000)}:R>` : 'indefinite';
    lines.push(`• ${memberLabel(id)} ${memberTag(id)} · release ${rel}${rec.joke ? ' · 😂 joke' : ''}`);
    row.addComponents(new ButtonBuilder().setCustomId(`corner_rel:${id}:0`).setEmoji('🔓').setLabel(`Release …${id.slice(-4)}`).setStyle(ButtonStyle.Success));
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  }
  if (row.components.length) rows.push(row);
  while (rows.length > 4) rows.pop();
  const embed = new EmbedBuilder().setColor(ids.length ? 0x992d22 : 0x2ecc71)
    .setDescription(ids.length
      ? 'Members currently **timed-out** in the corner. Click a **Release** button to let someone out now and give their roles back.\n\n' + lines.join('\n') + (ids.length > 20 ? `\n…and ${ids.length - 20} more` : '')
      : '✅ Nobody is in the corner right now.')
    .setFooter({ text: 'Any mod can release someone. To PUT someone in, use ⛓️ Corner on the Moderation page. 😂 = flagged as joke (tier lock waived); flip with /corner-status.' });
  rows.push(navRow(pageIdx('Corner')));
  return { content: `## ⛓️ FUBU Ops · Corner (${ids.length})`, embeds: [embed], components: rows };
}

// Paged so every striked member is reachable, not just the top 20 (owner, 2026-08-23: "how do I access
// [the hidden strikes]"). 15 per page = 3 Manage-button rows + a paging row + the nav row = Discord's
// 5-action-row cap. Page index rides in the fops_strikepage:<n> button id (no persisted sub-page state —
// navigating away and back resets to page 0, which is fine).
const STRIKES_PER_PAGE = 15;
async function buildStrikes(page = 0) {
  const members = D.strike ? D.strike.activeMembers() : [];
  const cap = D.strike ? D.strike.BAN_THRESHOLD : 10;
  const totalPages = Math.max(1, Math.ceil(members.length / STRIKES_PER_PAGE));
  page = Math.max(0, Math.min(totalPages - 1, page));
  const start = page * STRIKES_PER_PAGE;
  const pageMembers = members.slice(start, start + STRIKES_PER_PAGE);
  const lines = [];
  const rows = [];
  let row = new ActionRowBuilder();
  pageMembers.forEach((m, i) => {
    lines.push(`\`${String(start + i + 1).padStart(2)}\` ${memberLabel(m.memberId)} ${memberTag(m.memberId)} · **${D.strike ? D.strike.format(m.units) : m.units}/${cap} units** (${m.count} strike${m.count > 1 ? 's' : ''})`);
    row.addComponents(new ButtonBuilder().setCustomId(`fops_pick_strikeremove:${m.memberId}`).setEmoji('🎯').setLabel(`Manage …${m.memberId.slice(-4)}`).setStyle(ButtonStyle.Danger));
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  });
  if (row.components.length) rows.push(row);
  const embed = new EmbedBuilder().setColor(members.length ? 0x992d22 : 0x2ecc71)
    .setDescription(members.length
      ? `Members with **active strikes** (most units first). Click **Manage** to pick which one of theirs to remove.\n\n${lines.join('\n')}`
      : '✅ Nobody has an active strike right now.')
    .setFooter({ text: `${totalPages > 1 ? `Page ${page + 1}/${totalPages} · ` : ''}To GIVE a strike, use ⚠️ Strike on the Moderation page or /strike add. Or manage anyone directly with /strike view·remove·clear @member.` });
  // Prev/Next paging row — only when there's more than one page. Its own row, so the Manage buttons above
  // stay one-tap per member.
  if (totalPages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fops_strikepage:${page - 1}`).setEmoji('◀').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId('fops_strikepage_noop').setLabel(`Page ${page + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`fops_strikepage:${page + 1}`).setEmoji('▶').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)));
  }
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
  // Moderator and Mini-mod applications open/close independently (owner, 2026-08-17) — this quick button
  // only ever toggles the Moderator track; use /mod-applications open|close track:<...> for the mini-mod
  // track, or to flip both at once.
  const appsOpen = modapps.applicationsOpen('mod');
  const embed = new EmbedBuilder().setColor(0xff453a).setDescription(
    '**⭐ Needs Admin.** (Mods can read this page, but the buttons will show 🔒.)\n\n' +
    '🧹 **Run housekeeping now**: the bot normally tidies up once an hour; this makes it run **right now**: warn or remove overdue unverified members, delete dead verification threads, and flag anyone with both roles. ⚠️ It can **actually remove people**, unless Test Mode is on (see the ⚠️ Danger page).\n' +
    '🔨 **Ban a member**: permanently removes them and blocks them from rejoining. Can\'t be undone here.\n' +
    `📋 **Mod applications (Moderator track)**: currently **${appsOpen ? '🟢 OPEN' : '🔴 CLOSED'}**. Close intake when the team is full (applications already under review still finish); reopen anytime. Mini-mod applications open/close separately — use \`/mod-applications\` for that track.\n` +
    `👥 **Approvers** (⭐ **Needs Owner**, not just Admin): accepting/denying/undoing a mod application is normally owner-only — this lets the owner temporarily hand that same power to specific people (e.g. while away). ${modapps.getApprovers().length} set right now.`)
    .setFooter({ text: copy.guards.needsAdmin });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_sweep').setEmoji('🧹').setLabel('Run housekeeping now').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_modapps_toggle').setEmoji(appsOpen ? '🚫' : '✅').setLabel(appsOpen ? 'Close Moderator applications' : 'Reopen Moderator applications').setStyle(appsOpen ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('fops_ban').setEmoji('🔨').setLabel('Ban a member').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('fops_modapps_approvers').setEmoji('👥').setLabel('Manage approvers').setStyle(ButtonStyle.Secondary));
  return { content: '## 🔨 FUBU Ops · Actions', embeds: [embed], components: [row, navRow(pageIdx('Actions'))] };
}

function buildSettings() {
  const embed = new EmbedBuilder().setColor(0xe7ac4e).setDescription(
    '**⭐ Needs Admin.** Turn the bot\'s helper features on or off. Changes apply **immediately** and stay after a restart. ' +
    'Each button shows its current state; click to flip it. (The actual *removal policy* lives on the ⚠️ Danger page.)\n\n' +
    '🔔 **Nudge**: ping mods when a verification thread has been waiting too long.\n' +
    '⚖️ **Conflict-ping**: automatically flag members who somehow have both roles.\n' +
    '✅ **React-resolve**: post a weekly message those members can react to, to fix themselves.\n' +
    '🗒️ **Digest**: a once-a-day recap of everything the bot did.\n' +
    '🧵 **Orphan-reap**: delete verification threads whose owner already left the server.\n' +
    '👤 **Member cornering** (👑 Owner only): let a plain VERIFIED member corner one other non-staff member (≤5m, 3/day cap). Takes effect **immediately** — `/corner` stays visible to members either way; when it\'s off, they\'re told plainly instead of the command just disappearing.')
    .setFooter({ text: copy.guards.needsAdmin });
  const row1 = new ActionRowBuilder().addComponents(
    toggleBtn('featureNudge', 'Nudge'), toggleBtn('conflictPing', 'Conflict-ping'),
    toggleBtn('reactResolveEnabled', 'React-resolve'), toggleBtn('digestEnabled', 'Digest'), toggleBtn('reapOrphans', 'Orphan-reap'));
  const row2 = new ActionRowBuilder().addComponents(
    featureToggleBtn('memberCorner', 'Member cornering'),
    new ButtonBuilder().setCustomId('fops_refresh').setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary));
  return { content: '## ⚙️ FUBU Ops · Settings', embeds: [embed], components: [row1, row2, navRow(pageIdx('Settings'))] };
}

// Setup page — one-tap create/repair for the bot's channels + member panels. Replaces the old *-setup
// slash commands (owner: consolidate the long command list into /panel). Each button is safe to re-press.
function buildSetup() {
  const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(
    '**⭐ Needs Admin.** One-tap **create-or-repair** for the bot\'s channels + member panels. Each button is safe to press again: it makes the channel/panel if it\'s missing, or tells you it already exists. This replaces the old `*-setup` slash commands.\n\n' +
    '💡 **Suggestions** forum · 💭 **Confessions** + staff log · ✉️ **Mod inbox** · 🚩 **Anon reports** · 📋 **Mod applications**\n' +
    '🎭 **Role requests** · ⚖️ **Ban appeals** · 🎫 **Strike appeals** · 🕊️ **Whistleblow** recipients (bot-owner) · 🤖 **Member hub** (you pick the channel) · 🎪 **Event Organizer applications**')
    .setFooter({ text: copy.guards.needsAdmin });
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_setup:suggest').setEmoji('💡').setLabel('Suggestions').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:confess').setEmoji('💭').setLabel('Confessions').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:modmail').setEmoji('✉️').setLabel('Mod inbox').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:report').setEmoji('🚩').setLabel('Anon reports').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:applymod').setEmoji('📋').setLabel('Mod apps').setStyle(ButtonStyle.Secondary));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_setup:requestrole').setEmoji('🎭').setLabel('Role requests').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:appeal').setEmoji('⚖️').setLabel('Ban appeals').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:appealstrike').setEmoji('🎫').setLabel('Strike appeals').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:whistleblow').setEmoji('🕊️').setLabel('Whistleblow').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:dashboard').setEmoji('🤖').setLabel('Member hub').setStyle(ButtonStyle.Secondary));
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_setup:eventorg').setEmoji('🎪').setLabel('Event Organizer apps').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fops_setup:adultcorner').setEmoji('🔞').setLabel('Adult Corner').setStyle(ButtonStyle.Secondary));
  // Staff-position setup buttons — Media Team (live) always shows; Greeter/Support appear once their
  // feature is turned on (they ship dark).
  const posBtns = [new ButtonBuilder().setCustomId('fops_setup:media').setEmoji('🎬').setLabel('Media Team apps').setStyle(ButtonStyle.Secondary)];
  if (features.enabled('greeterApps')) posBtns.push(new ButtonBuilder().setCustomId('fops_setup:greeter').setEmoji('👋').setLabel('Greeter apps').setStyle(ButtonStyle.Secondary));
  if (features.enabled('supportApps')) posBtns.push(new ButtonBuilder().setCustomId('fops_setup:support').setEmoji('🛟').setLabel('Support apps').setStyle(ButtonStyle.Secondary));
  const row4 = new ActionRowBuilder().addComponents(...posBtns);
  return { content: '## 🧩 FUBU Ops · Setup', embeds: [embed], components: [row1, row2, row3, row4, navRow(pageIdx('Setup'))] };
}

function buildDanger() {
  const c = D.config;
  const dryOn = !!c.dryRun;
  const embed = new EmbedBuilder().setColor(dryOn ? 0xff9f0a : 0xff453a).setDescription(
    '**👑 Owner only.** This controls **whether and when the bot removes people**, the highest-stakes settings on the bot. Admins and mods can see it but can\'t change it.\n\n' +
    `**Right now:** ${dryOn ? '🟡 **TEST MODE**: the bot only *pretends* to remove members. Safe.' : '🟢 **LIVE**: the bot **actually removes** unverified members.'}\n\n` +
    '🟡/🟢 **Test Mode**: the master safety switch. Keep it ON while testing; turning it OFF makes real removals begin.\n' +
    '🧹 **Reaping**: the whole warn-then-remove system, on or off.\n' +
    '👢 **Stale-kick**: ON: overdue members get removed. OFF: their thread is cleaned up but they stay in the server.\n' +
    '⏱️ **Timings**: how many days before a warning, before removal, and how often the bot checks.\n\n' +
    `**Current timings:** warns after **${c.warnDays}d** · removes after **${c.kickDays}d** · checks every **${c.sweepIntervalMin}m**.`)
    .setFooter({ text: 'Owner only. This is the removal policy.' });
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
  const watched = watchlist.loadWatched();
  const fw = D.freshwatch ? D.freshwatch.status() : { mode: c.smartWatchFreshMode || 'off', hours: c.smartWatchFreshHours || 0, percentile: c.smartWatchFreshPercentile || 1, influxActive: false };
  const freshLine = fw.mode === 'auto'
    ? `**auto**: tags the newest **~${fw.percentile}%** of members as ⚠ brand-new (self-calibrates to growth${fw.influxActive ? '; 📈 **influx active → tightened**' : ''}). A mod heads-up only; the AI never sees account age.`
    : fw.mode === 'manual'
      ? `**manual**: tags accounts that joined **< ${fw.hours}h ago**. A mod heads-up only; the AI never sees account age.`
      : '**off**: no new-account note.';
  const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(
    '**⭐ Needs Admin.** Two monitors:\n' +
    '• **Strict watchlist**: a flagged member posts a **strict term** → alert in **mod-announcements** with **Strike / Corner / Dismiss** buttons (+ mod ping).\n' +
    "• **Loose watch-log**: *anyone except staff* posts a **loose term** → quiet report in **#watch-log** (buttons, no ping).\n" +
    "• **Welfare**: a distress term (e.g. `i want to die`, `sh`) → soft **check-in** report in #watch-log (no ban button).\n" +
    "All reports keep a **saved copy + mirrored attachments**, so deleting the message can't hide it.\n\n" +
    '👁️ **Watchlist** add/remove (an internal flag, not a Discord role) · 🔓 **Unban** (opt. keep watching) · 🏷️ **Terms** for each list.\n' +
    `🌱 **New-account flag:** ${freshLine}\n` +
    `🤖 **Monitor mode:** ${copy.watchlist.monitorStatus(features.enabled('smartWatchLab'), !!D.config.smartWatchLive && features.enabled('smartWatch'))}\n\n` +
    `**Now:** ${strict.length} strict · ${loose.length} loose · ${welfare.length} welfare term(s) · ${watched.length} watched.`)
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

// Promotions page: open promotion VOTES for one OR MANY candidates at once, via role-filtered multi-selects
// (each dropdown lists ONLY the eligible role — trial mods for trial→mod, actual mods for mod→admin). This is
// the dashboard entry to the same promote.start vote flow as /promote-trial and /promote-mod.
async function buildPromotions() {
  const guild = D.client.guilds.cache.get(D.config.guildId) || D.client.guilds.cache.first();
  await ensureMembers(guild);
  const trialRole = D.config.trialModRoleId && guild.roles.cache.get(D.config.trialModRoleId);
  const modRole = D.config.modRoleId && guild.roles.cache.get(D.config.modRoleId);
  const trials = trialRole ? [...trialRole.members.values()] : [];
  const mods = modRole ? [...modRole.members.values()].filter(m => memberTier(m) === 'mod') : [];   // actual mods, not admins (who also hold the mod role via nesting)
  const opt = m => ({ label: m.displayName.replace(/[*_`~|<>@]/g, '').slice(0, 100) || m.id, value: m.id, description: m.user.username.slice(0, 100) });
  const rows = [];
  if (trials.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fops_promote:trial').setPlaceholder(`⬆️ Promote Trial Mod(s) → Mod (${trials.length})`)
      .setMinValues(1).setMaxValues(Math.min(trials.length, 25)).addOptions(trials.slice(0, 25).map(opt))));
  if (mods.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fops_promote:mod').setPlaceholder(`⬆️ Promote Mod(s) → Admin (${mods.length})`)
      .setMinValues(1).setMaxValues(Math.min(mods.length, 25)).addOptions(mods.slice(0, 25).map(opt))));
  const embed = new EmbedBuilder().setColor(0xE1A200)
    .setDescription('Open a promotion **vote** for one or more people at once. Each list shows **only the eligible role**.\n\n'
      + `• **Trial Mod → Mod**: ${trials.length} trial mod(s). Vote posts in **mod-announcements**.\n`
      + `• **Mod → Admin**: ${mods.length} mod(s). Vote posts in **admin-discussion** (Admin only).\n\n`
      + (trials.length || mods.length ? '_Select the people, and a promotion vote opens for each. No one is promoted until the vote is confirmed._' : '_No eligible candidates right now._'))
    .setFooter({ text: 'Promotions = votes, not instant. Trial→Mod: any mod. Mod→Admin: Admin+.' });
  rows.push(navRow(pageIdx('Promotions')));
  return { content: '## 🏅 FUBU Ops · Promotions', embeds: [embed], components: rows };
}

// Plain-language type labels — matches how cornering rules actually get talked about, not the internal
// enum names (owner, 2026-08-19: "the terminology doesn't really match how we already describe things").
const OV_TYPE_LABEL = { EXCLUSIVE_CORNERER: '🔒 Protected (legacy allow-list)', PROTECT_FROM: '🔒 Protected', ALLOW_SELF_CORNER: '🙋 Self-corner allowed', BYPASS_TIER: '🔓 Rank bypass', GROUP_REQUIRED: '👥 Group required' };
function overrideTypeLabel(o) {
  return o.type === 'GRANT_POWER' ? `⚡ Cornering authority (${o.powerTier || 'owner'}-level)` : (OV_TYPE_LABEL[o.type] || o.type);
}
const TIER_ACTOR_LABEL = { staff: '🔰 Staff+ (Trial Mod/Mini-Mod/Event Organizer)', mod: '✰ Mod+ staff', admin: '⭐ Admin+ staff', owner: '👑 Owner+', botowner: '🤖 Bot Owner' };
function fmtEntity(type, id) {
  if (type === 'hitsquad') return '🚔 Hit Squad';
  if (type === 'membercorner') return '👤 Regular Members';
  if (id === '*') return 'Everyone';
  if (type === 'tier') return TIER_ACTOR_LABEL[id] || `${id}+ staff`;
  return type === 'role' ? `<@&${id}>` : `<@${id}>`;
}
function overrideActorFmt(o) {
  if (o.type === 'ALLOW_SELF_CORNER') {
    return o.actorId !== '*' ? fmtEntity(o.actorType, o.actorId) : 'Everyone';
  }
  if (o.type === 'PROTECT_FROM') {
    const names = overridesManager.normalizeDenied(o).map(d => fmtEntity(d.type, d.id));
    return names.length ? names.join(', ') : '_nobody yet — add something to block_';
  }
  // Every other type can list multiple actors now — see overridesManager.normalizeActors. An actor entry
  // can be a person, a role, a staff-tier floor ("admin+"), or the literal wildcard (ANY member, no floor
  // at all — flagged distinctly from a tier entry since it's much broader) — fmtEntity renders the rest.
  const names = overridesManager.normalizeActors(o).map(a => a.type !== 'tier' && a.id === '*' ? 'Everyone (⚠️ no tier floor)' : fmtEntity(a.type, a.id));
  if (o.type === 'EXCLUSIVE_CORNERER' && o.hitSquadExempt) names.push('🚔 Hit Squad (while active)');
  return names.length ? names.join(', ') : '_nobody yet — add an actor_';
}
function overrideTargetFmt(o) {
  return fmtEntity(o.targetType, o.targetId);
}
// Full plain-English sentence per type, not a generic "Actor: X -> Target: Y" — that field-dump format
// was the other half of the terminology complaint.
function overrideSummaryLine(o) {
  const noteSuffix = o.note ? ` _(${o.note})_` : '';
  const offPrefix = overridesManager.isEnabled(o) ? '' : '🔴 **OFF** — ';
  let line;
  if (o.type === 'EXCLUSIVE_CORNERER') line = `**${overrideTypeLabel(o)}** — only ${overrideActorFmt(o)} can corner ${overrideTargetFmt(o)}${noteSuffix}`;
  else if (o.type === 'PROTECT_FROM') line = `**${overrideTypeLabel(o)}** — ${overrideActorFmt(o)} can't corner ${overrideTargetFmt(o)} (everyone/everything else unaffected)${noteSuffix}`;
  else if (o.type === 'GRANT_POWER') line = `**${overrideTypeLabel(o)}** — ${overrideActorFmt(o)} can corner up to **${o.powerTier || 'owner'}**-tier, over ${overrideTargetFmt(o)}${noteSuffix}`;
  else if (o.type === 'ALLOW_SELF_CORNER') line = `**${overrideTypeLabel(o)}** — ${overrideTargetFmt(o)} may corner themselves${noteSuffix}`;
  else if (o.type === 'BYPASS_TIER') line = `**${overrideTypeLabel(o)}** — ${overrideActorFmt(o)} may corner above their rank, against ${overrideTargetFmt(o)}${noteSuffix}`;
  else if (o.type === 'GROUP_REQUIRED') line = `**${overrideTypeLabel(o)}** — cornering ${overrideTargetFmt(o)} needs **${o.requiredCount || 3} ${overrideActorFmt(o)}**, each within **${Math.round((o.windowMs || overridesManager.DEFAULT_GROUP_WINDOW_MS) / 60000)}m**${(o.pendingVotes || []).length ? ` _(${o.pendingVotes.length}/${o.requiredCount || 3} voted right now)_` : ''}${noteSuffix}`;
  else line = `**${overrideTypeLabel(o)}** · Actor: ${overrideActorFmt(o)} → Target: ${overrideTargetFmt(o)}${noteSuffix}`;
  return offPrefix + line;
}
function overrideShortLabel(o) {
  const shortId = id => id === '*' ? '*' : id.slice(-4);
  if (o.type === 'ALLOW_SELF_CORNER') return `${o.type} (${shortId(o.actorId)} → ${shortId(o.targetId)})`;
  if (o.type === 'PROTECT_FROM') {
    const denied = overridesManager.normalizeDenied(o);
    return `${o.type} (${denied.length ? denied.map(d => d.id ? shortId(d.id) : d.type).join(',') : 'none'} → ${shortId(o.targetId)})`;
  }
  const actors = overridesManager.normalizeActors(o);
  return `${o.type} (${actors.length ? actors.map(a => shortId(a.id)).join(',') : 'none'} → ${shortId(o.targetId)})`;
}

function buildOverrides() {
  const list = overridesManager.getOverrides();
  const shown = list.slice(0, 25);
  const lines = shown.map((o, idx) => `\`${idx + 1}.\` ${overrideSummaryLine(o)}`);
  const overflowNote = list.length > 25 ? `\n\n_+${list.length - 25} more rule(s) not shown — delete some below to see the rest._` : '';

  const embed = new EmbedBuilder().setColor(0x5865F2)
    .setTitle('🛡️ Personal Corner Overrides')
    .setDescription('**👑 Owner only.** Manage personal corner rules live with point-and-click pickers.\n\n'
      + (lines.length ? lines.join('\n') : '_No personal overrides active._') + overflowNote)
    .setFooter({ text: 'Owner only. Point-and-click personal corner rules.' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fops_ov_addstart').setEmoji('➕').setLabel('Add Rule (Pick Member / Role)').setStyle(ButtonStyle.Success),
  );

  const rows = [row1];
  if (shown.length) {
    const opts = shown.map((o, idx) => ({
      label: `${idx + 1}. ${overrideShortLabel(o)}`.slice(0, 100),
      value: o.id,
      description: (o.note || overrideShortLabel(o)).slice(0, 100)
    }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('fops_ov_managepicker').setPlaceholder('⚙️ Select a rule to view / edit / delete…').addOptions(opts)
    ));
  }
  rows.push(navRow(pageIdx('Overrides')));
  return { content: '## 🛡️ FUBU Ops · Personal Overrides', embeds: [embed], components: rows };
}

// Detail view for one rule: full field dump, audit trail (who/when created + last edited, when known),
// and the manage actions (edit note, add/remove actor, delete w/ confirm).
function buildOverrideDetail(ruleId) {
  const o = overridesManager.getOverride(ruleId);
  if (!o) return { content: 'That rule no longer exists — it may have already been deleted.', embeds: [], components: [navRow(pageIdx('Overrides'))] };
  const isExclusive = o.type === 'EXCLUSIVE_CORNERER';
  const isProtectFrom = o.type === 'PROTECT_FROM';
  const multiActor = o.type !== 'ALLOW_SELF_CORNER' && !isProtectFrom;   // PROTECT_FROM gets its own Add/Remove-Block buttons below instead
  const fields = [
    { name: 'Type', value: overrideTypeLabel(o), inline: true },
    { name: isExclusive ? 'Allowed to corner them' : isProtectFrom ? 'Blocked from cornering them' : 'Actor', value: overrideActorFmt(o), inline: true },
    { name: 'Target', value: overrideTargetFmt(o), inline: true },
  ];
  if (o.powerTier) fields.push({ name: 'Power Tier', value: o.powerTier, inline: true });
  if (o.type === 'GROUP_REQUIRED') {
    fields.push({ name: 'Required', value: `${o.requiredCount || 3} within ${Math.round((o.windowMs || overridesManager.DEFAULT_GROUP_WINDOW_MS) / 60000)}m`, inline: true });
    const votes = (o.pendingVotes || []).filter(v => Date.now() - v.at < (o.windowMs || overridesManager.DEFAULT_GROUP_WINDOW_MS));
    fields.push({ name: 'Right now', value: votes.length ? `${votes.length} voted: ${votes.map(v => `<@${v.id}>`).join(', ')}` : '_no attempts pending_', inline: true });
  }
  fields.push({ name: 'Status', value: overridesManager.isEnabled(o) ? '🟢 ON — active' : '🔴 OFF — kept, not enforced', inline: true });
  fields.push({ name: 'Note', value: o.note || '_none_', inline: false });
  const created = o.createdBy ? `<@${o.createdBy}>${o.createdAt ? ` · <t:${Math.floor(o.createdAt / 1000)}:R>` : ''}` : '_unknown (predates audit trail)_';
  fields.push({ name: 'Created by', value: created, inline: false });
  if (o.updatedAt) fields.push({ name: 'Last edited', value: `<t:${Math.floor(o.updatedAt / 1000)}:R>`, inline: false });

  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`🛡️ Override \`${o.id}\``).addFields(fields);
  const btns = [
    new ButtonBuilder().setCustomId(`fops_ov_editnote:${o.id}`).setEmoji('✏️').setLabel('Edit Note').setStyle(ButtonStyle.Secondary),
  ];
  if (multiActor) {
    btns.push(new ButtonBuilder().setCustomId(`fops_ov_addactor:${o.id}`).setEmoji('➕').setLabel('Add Actor').setStyle(ButtonStyle.Secondary));
    if (overridesManager.normalizeActors(o).length) {
      btns.push(new ButtonBuilder().setCustomId(`fops_ov_rmactor:${o.id}`).setEmoji('➖').setLabel('Remove Actor').setStyle(ButtonStyle.Secondary));
    }
  }
  if (isProtectFrom) {
    btns.push(new ButtonBuilder().setCustomId(`fops_ov_addblock:${o.id}`).setEmoji('➕').setLabel('Add Block').setStyle(ButtonStyle.Secondary));
    if (overridesManager.normalizeDenied(o).length) {
      btns.push(new ButtonBuilder().setCustomId(`fops_ov_rmblock:${o.id}`).setEmoji('➖').setLabel('Remove Block').setStyle(ButtonStyle.Secondary));
    }
  }
  // Soft on/off (owner, 2026-08-23: "I'd like to be able to add it back situationally") — flips the rule
  // without losing its actors/target/note, so re-enabling later needs one click instead of rebuilding it.
  const enabled = overridesManager.isEnabled(o);
  btns.push(new ButtonBuilder().setCustomId(`fops_ov_enabletoggle:${o.id}`).setEmoji(enabled ? '⏸️' : '▶️')
    .setLabel(enabled ? 'Turn OFF (keep rule)' : 'Turn ON').setStyle(enabled ? ButtonStyle.Secondary : ButtonStyle.Success));
  btns.push(new ButtonBuilder().setCustomId(`fops_ov_delconfirm:${o.id}`).setEmoji('🗑️').setLabel('Delete').setStyle(ButtonStyle.Danger));
  const rows = [new ActionRowBuilder().addComponents(btns.slice(0, 5))];
  if (btns.length > 5) rows.push(new ActionRowBuilder().addComponents(btns.slice(5)));
  if (isExclusive) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fops_ov_hitsquadtoggle:${o.id}`).setEmoji('🚔')
        .setLabel(o.hitSquadExempt ? 'Hit Squad Exempt: ON (click to turn off)' : 'Hit Squad Exempt: OFF (click to turn on)')
        .setStyle(o.hitSquadExempt ? ButtonStyle.Success : ButtonStyle.Secondary)
    ));
  }
  const backBtn = new ButtonBuilder().setCustomId('fops_ov_back').setEmoji('↩️').setLabel('Back to Overrides').setStyle(ButtonStyle.Secondary);
  rows.push(new ActionRowBuilder().addComponents(backBtn));
  return { content: '', embeds: [embed], components: rows };
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
  if (name === 'Promotions') return await buildPromotions();
  if (name === 'Settings') return buildSettings();
  if (name === 'Setup') return buildSetup();
  if (name === 'Danger') return buildDanger();
  if (name === 'Overrides') return buildOverrides();
  return await buildOverview();
}

// --- lifecycle --------------------------------------------------------------------------------------
// Static staff command reference. Owner wanted each command's MESSAGE (quick one-liner) and EMBED (full
// argument detail) paired together as one unit, interleaved per command — not one giant index message
// followed by one giant detail embed. Discord renders a message's text content above its attached embed
// within the same message bubble, so "message then embed, grouped by command" = one Discord message per
// command with both content + embeds set, sent in order, category headers folded into the first command's
// content in that category. commandRefEntries() returns that flat ordered list.
function commandRefEntries() {
  const entry = (cat, name, oneLiner, lines) => {
    const content = (cat ? `**${cat}**\n` : '') + oneLiner;
    const embed = lines ? new EmbedBuilder().setColor(0x2b2d31).setTitle(name).setDescription(lines.map(l => `• ${l}`).join('\n')) : null;
    return { content, embed };
  };
  return [
    entry(null, null, '## 📖 FUBU Ops · Staff Command Reference\nEach command below: what it does, then its full argument detail. The live dashboard is pinned further down.', null),

    entry('🛡️ Moderation', '/corner',
      `\`/corner @member [${copy.corner.unitsDot}]\` — time-out: strips roles + jails them (blank = until released)`, [
        'user (required) — member to corner',
        'duration (optional) — e.g. 30m/2h/3d; blank = until released',
        'rule (optional) — pick a server rule they broke',
        'reason (optional) — custom reason instead of a rule',
        'adult (optional) — send to the 18+ Adult Corner',
        'thread (optional) — jail to a private thread',
        'slowmode (optional) — e.g. 30s/5m on their jail thread; needs thread:true',
        'anon (optional) — hide your name, announce as Anonymous Staff',
        'also (optional) — corner more members too: @mentions or IDs, space-separated (same duration/reason)',
        'sweep (optional) — also corner non-staff who posted here in the last N minutes',
      ]),
    entry(null, '/uncorner', '`/uncorner @member [time]` — release now, or schedule a release later (who’s cornered: ⛓️ Corner page)', [
      'user (required) — member to release',
      'duration (optional) — schedule the release later instead of now',
      'also (optional) — release more members too, same shape as /corner\'s also',
    ]),
    entry(null, '/corner-status', '`/corner-status @member <joke|real> [also]` — fix a mis-flagged corner (mods+, not Trial Mods)', [
      'user (required) — member currently cornered',
      'status (required) — joke (waives the release tier lock) or real (normal tier lock applies)',
      'also (optional) — change more members too, same shape as /corner\'s also',
    ]),
    entry(null, '/strike', '`/strike view·add·remove·clear @member` — raise/lower strikes (weighted; ban offered at 10 units)', [
      'view: user (required) — units + history',
      'add: user (required) · rule (optional) · reason (optional) — pick a rule, a reason, or both',
      'add: weight (optional) — 1 minor / 2 moderate / 3 severe, omit to use the rule\'s default',
      'add: timeout (optional) — native Discord timeout e.g. 30m/2h, adds bonus units (capped +2)',
      'add: corner (optional) — also corner them for this long, e.g. 30m',
      'remove: user (required) · strike_id (required, autocomplete)',
      'clear: user (required) — wipes ALL their active strikes',
    ]),
    entry(null, '/stats', '`/stats @member` — corner/strike record over a period', [
      'user (required)',
      'period (optional) — 7d / 30d / 90d / all, default 30d',
      'visibility (optional) — private (default, only you) or public',
    ]),

    entry('👁️ Watchlist & safety', '/watchlist', '`/watchlist add·remove·list @member` — put/lift the Watchlist role', [
      'add / remove: user (required)',
      'list: no arguments',
    ]),
    entry(null, '/watchlist-terms', '`/watchlist-terms add·remove·list` — edit flagged words · strict / loose / welfare', [
      'add: term (required) · scope (optional, default strict)',
      'remove: term (required) · scope (optional, default strict)',
      'list: scope (optional, default all)',
      'scopes — strict: watchlist ban alerts · loose: day-to-day watch-log · welfare: support check-ins',
    ]),
    entry(null, '/watchlist-suggest', '`/watchlist-suggest [hours]` — scan recent chat, recommend new terms', [
      'hours (optional) — how far back to scan, default 6, max 24',
    ]),
    entry(null, '/unban', '`/unban <user-id> [watchlist]` — unban by ID; can re-flag on rejoin · right-click → “Report to watchlist” files a deletion-proof report', [
      'user_id (required) — banned user\'s ID; autocomplete searches by name too',
      'watchlist (optional) — re-flag them on rejoin',
      'reason (optional) — audit-log reason',
    ]),

    entry('🔒 Anonymous tools & Send-to-corner', null,
      'Confess / Report / Modmail / Suggest — buttons on `/dashboard`, not their own commands. Right-click → **“Send to corner”** jails the author + copies the message in; **“Strike”** strikes the author. _Reveal rules, limits, counts: 🔒 Anon Tools page._', null),
    entry(null, '/whistleblow', '`/whistleblow` — DM a problem straight to the top, sealed from snooping', [
      'to (required) — head admin only / server owner only / both / anonymous (no one can unmask)',
      'text (required) — the problem, up to 1500 chars',
    ]),

    entry('🧰 Other', '/verify', '`/verify @member` — verify a member, no need to open the panel', [
      'user (required) — member to verify',
    ]),
    entry(null, null, '`/pending` · `/panel` · `/dashboard` — browse the verify queue · open your private panel · the member hub. No arguments.', null),

    entry('👥 Staff & mod-team', null, '`/staff` — tier counts + rosters. No arguments.', null),
    entry(null, '/promote-trial · /promote-mod', '`/promote-trial` · `/promote-mod` @member — open a promotion vote', [
      'member (required, autocomplete) — opens a mod-vote thread',
    ]),
    entry(null, '/demote-trial · /demote-mod', '`/demote-trial` · `/demote-mod` @member — remove a role (owner)', [
      'member (required, autocomplete)',
      'reason (optional) — internal note, not shown to the member',
    ]),

    entry('👥 Who can do what', null,
      '🟢 Mods: corner, strike, watchlist, verify, anon/review tools\n🔵 Admins: + ban/unban, run-now, helper settings\n🟣 Owner: + removal policy, mod-app decisions, feature toggles', null),
  ];
}

async function ensureCommandRef(client, channelId) {
  try {
    let ref = {}; try { ref = JSON.parse(fs.readFileSync(GUIDE_REF_FILE, 'utf8')); } catch {}
    const chId = channelId || ref.channelId || loadRef().channelId;
    if (!chId) return console.error('[fops] no dashboard channel for command reference');
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) return console.error('[fops] command-ref channel not found');
    const sameChannel = ref.channelId === chId;

    const entries = commandRefEntries();
    const ids = sameChannel && Array.isArray(ref.messageIds) ? ref.messageIds.slice() : [];
    for (let i = 0; i < entries.length; i++) {
      const { content, embed } = entries[i];
      const payload = { content, embeds: embed ? [embed] : [] };
      const existingId = ids[i];
      const existing = existingId ? await ch.messages.fetch(existingId).catch(() => null) : null;
      if (existing) { await existing.edit(payload); if (!existing.pinned) await existing.pin().catch(() => {}); ids[i] = existing.id; }
      else {
        const msg = await ch.send(payload);
        await msg.pin().catch(() => {});
        ids[i] = msg.id;
      }
    }
    // Cleanup: any leftover message from a shorter/older layout (fewer entries, or the old
    // messageId/detailMessageId/detailMessageIds single-or-pair layouts).
    const stale = new Set();
    for (const id of ids.slice(entries.length)) stale.add(id);
    if (sameChannel) {
      if (ref.messageId && !ids.includes(ref.messageId)) stale.add(ref.messageId);
      if (ref.detailMessageId && !ids.includes(ref.detailMessageId)) stale.add(ref.detailMessageId);
      if (Array.isArray(ref.detailMessageIds)) for (const id of ref.detailMessageIds) if (!ids.includes(id)) stale.add(id);
    }
    for (const id of stale) { const m = await ch.messages.fetch(id).catch(() => null); if (m) await m.delete().catch(() => {}); }
    ids.length = entries.length;

    console.log(`[fops] command reference: ${entries.length} entries synced in ${chId}`);
    fs.writeFileSync(GUIDE_REF_FILE, JSON.stringify({ channelId: chId, messageIds: ids }));
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
  return (i.isButton?.() || i.isStringSelectMenu?.() || i.isUserSelectMenu?.() || i.isChannelSelectMenu?.() || i.isModalSubmit?.()) && i.customId?.startsWith('fops_');
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
const LABEL = { staff: '🔰 Staff', mod: '✰ Mod', admin: '⭐ Admin', owner: '👑 Owner' };
// Shared override-wizard steps — every rule type but self-corner now follows the same shape: pick the
// target scope (or skip straight to a specific target for Protect Someone), then multi-select the
// actor(s) last, so the final step can add several people in one interaction instead of one rule apiece.
function targetScopeRow(customId, title, question) {
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Select Target Scope…').addOptions([
      { label: '🌐 Everyone', value: 'all', description: 'Applies to everyone in the server' },
      { label: '👤 Specific Member', value: 'user', description: 'Pick one specific member' },
      { label: '🎭 Specific Role', value: 'role', description: 'Pick one specific role' },
    ])
  );
  return { content: `### ${title}\n${question}`, components: [row] };
}
// tierCustomId is optional — pass it to also offer "any staff at or above tier X" as a third way to pick
// actors, alongside named members/roles (owner, 2026-08-19: "there are more tiers in between" all-members
// and a single named actor — this is the general form of what used to be BYPASS_TIER's minActorTier field).
function actorPickRow(userCustomId, roleCustomId, subject, verb = 'the actor(s) for this rule', tierCustomId = null) {
  const userRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(userCustomId).setPlaceholder(`👤 Select ${verb} (pick several)…`).setMinValues(1).setMaxValues(10)
  );
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(roleCustomId).setPlaceholder('🎭 OR select a role (anyone with it qualifies)…')
  );
  const rows = [userRow, roleRow];
  if (tierCustomId) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(tierCustomId).setPlaceholder('🎚️ OR any staff at/above a tier…').addOptions([
        { label: '🔰 Staff+ (Trial Mod/Mini-Mod/Event Org)', value: 'staff' },
        { label: '✰ Mod+ staff', value: 'mod' },
        { label: '⭐ Admin+ staff', value: 'admin' },
        { label: '👑 Owner+', value: 'owner' },
      ])
    ));
  }
  return { content: `### ${subject}\nWho's ${verb}? Pick one or more **members**, a **role**, or a **staff tier** — you can add more later without recreating this rule.`, components: rows };
}

// "Protect Someone" picker (owner, 2026-08-20) — a deny-list, the inverse of actorPickRow's allow-list:
// pick sources to BLOCK, not sources to allow. Same member/role/tier select shape, plus 🚔 Hit Squad and
// 👤 Regular Members (member-corner) folded into the tier dropdown as their own selectable entries (they
// aren't a rank, so they don't belong in the tier ladder itself, just this one picker's options list).
// Step 2 of the "Require a Group to Corner" wizard: which tier's members get to cast a vote. Deliberately
// tier-only (not named users/roles like actorPickRow) — a group requirement is inherently "N of a rank",
// not "N of these specific people".
function groupTierRow(targetType, targetId) {
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`fops_ov_grouptier:${targetType}:${targetId}`).setPlaceholder('🎚️ Which tier can vote?').addOptions([
      { label: '🔰 Staff+ (Trial Mod/Mini-Mod/Event Org)', value: 'staff' },
      { label: '✰ Mod+ staff', value: 'mod' },
      { label: '⭐ Admin+ staff', value: 'admin' },
      { label: '👑 Owner+', value: 'owner' },
    ])
  );
  return { content: '### 👥 Require a Group to Corner: Step 2 of 3\nWhich **tier** must supply the group? (e.g. pick Admin+ for "3 admins")', components: [row] };
}
function denyFromPickRow(baseCustomId, subject) {
  const userRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(`${baseCustomId}:user`).setPlaceholder('👤 Block specific member(s)…').setMinValues(1).setMaxValues(10)
  );
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(`${baseCustomId}:role`).setPlaceholder('🎭 OR block a role (anyone with it)…')
  );
  const sourceRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`${baseCustomId}:source`).setPlaceholder('🚫 OR block a source…').addOptions([
      { label: '🚔 Hit Squad', value: 'hitsquad', description: 'Blocks hit squad specifically, while active' },
      { label: '👤 Regular Members', value: 'membercorner', description: 'Blocks the member-corner feature' },
      { label: '🔰 Staff+ (Trial Mod/Mini-Mod/Event Org)', value: 'tier:staff' },
      { label: '✰ Mod+ staff', value: 'tier:mod' },
      { label: '⭐ Admin+ staff', value: 'tier:admin' },
      { label: '👑 Owner+', value: 'tier:owner' },
    ])
  );
  return { content: `### ${subject}\nWho/what should be **blocked** from cornering them? Pick one or more **members**, a **role**, or a **source** — everyone/everything else can still corner them normally. Add more later without recreating this rule.`, components: [userRow, roleRow, sourceRow] };
}

async function handlePanel(interaction) {
  const id = interaction.customId;
  const tier = tierOf(interaction);
  const roleTier = isBotOwner(interaction) ? 'botowner' : memberTier(interaction.member);   // role-only (ADMINS-★, not the Admin perm) — but the bot owner passes by user id even role-stripped
  // mod+ required to touch ANY button on the shared/personal panel (view-only nav for 'staff' tier is via
  // the read-only /panel route instead, not this dispatcher) — was `if (!tier)` before 'staff' existed as
  // a real tierOf() value; a bare truthy check here would now let Trial Mod/Mini-Mod/Event Organizer reach
  // every action handler below, including Corner/Ban buttons. Preserves exactly what already happened to
  // trial mods pre-'staff' (tierOf was null for them too, so this always blocked them).
  if (!meets(tier, 'mod')) return interaction.reply({ content: 'This dashboard is for the mod team.', flags: MessageFlags.Ephemeral });
  // Gate helper for pre-defer (reply) responses.
  const denyReply = needed => interaction.reply({ content: `🔒 That's **${LABEL[needed]}+** only. You're ${LABEL[tier]}.`, flags: MessageFlags.Ephemeral });

  if (id === 'fops_nav') {
    const page = Math.max(0, Math.min(PAGES.length - 1, Number(interaction.values?.[0] || 0)));
    saveRef({ ...loadRef(), page, navAt: Date.now() });   // navAt drives the idle auto-return-to-Overview
    return interaction.update(await buildPage(page));   // everyone may VIEW any page; actions gate below
  }
  if (id === 'fops_strikepage_noop') return interaction.deferUpdate();   // the disabled "Page X/Y" label
  if (id.startsWith('fops_strikepage:')) {   // ◀/▶ within the Strikes page (sub-page, not a dashboard page)
    const payload = await buildStrikes(Math.max(0, Number(id.split(':')[1]) || 0));
    // On the private /panel (ephemeral), keep its per-tier nav row instead of the shared one buildStrikes
    // appends — otherwise paging would swap a personal panel onto the shared page-set + nav.
    if (interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) {
      payload.components = [...payload.components];
      payload.components[payload.components.length - 1] = navRowPersonal(pageIdx('Strikes'), tierOf(interaction));
    }
    return interaction.update(payload);
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
    return interaction.reply({ content: `🎯 Selected <@${uid}> (\`${member.user.tag}\`), currently **${unitsDisplay}/${cap} units**. Pick an action. _(Corner here is indefinite; for a timed corner use the Corner button (asks duration) or \`/corner\`. "Give a strike…" picks a rule/reason/weight/timeout, same as \`/strike add\`; "Strike +1" is a quick no-reason 1-unit shortcut.)_`, components: [actions, strikes], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
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
    return interaction.reply({ content: `Manage a strike on <@${uid}>. Pick which one:`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // Picked a specific strike → offer Remove OR re-weight it (partial leniency / correction). Each button
  // carries the target weight (0 = remove); the strike's CURRENT weight button is disabled so it's obvious.
  if (id.startsWith('fops_strike_manage:') && interaction.isStringSelectMenu?.()) {
    const uid = id.split(':')[1];
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.update({ content: copy.common.noMemberInServer, components: [] });
    const strikeId = interaction.values[0];
    const entry = (D.strike.entries(member) || []).find(e => e.id === strikeId);
    if (!entry) return interaction.update({ content: 'That strike is gone. It may already have been changed.', components: [] });
    const cur = entry.weight;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fops_strike_setw:${uid}:${strikeId}:0`).setEmoji('🗑️').setLabel('Remove').setStyle(ButtonStyle.Danger),
      ...[1, 2, 3].map(w => new ButtonBuilder().setCustomId(`fops_strike_setw:${uid}:${strikeId}:${w}`).setLabel(`${w} unit${w > 1 ? 's' : ''}`).setStyle(ButtonStyle.Secondary).setDisabled(cur === w)));
    return interaction.update({ content: `Strike \`${strikeId}\` on <@${uid}>, currently **${D.strike.format(cur)} unit${cur === 1 ? '' : 's'}**.\nRemove it, or set a new weight:`, components: [row] });
  }
  if (id.startsWith('fops_strike_setw:') && interaction.isButton?.()) {
    const [, uid, strikeId, wStr] = id.split(':');
    const w = Number(wStr);
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.update({ content: copy.common.noMemberInServer, components: [] });
    const r = w <= 0
      ? await D.strike.removeById(interaction.guild, member, strikeId, interaction.user.tag)
      : await D.strike.setWeight(interaction.guild, member, strikeId, w, interaction.user.tag);
    if (!r.ok) return interaction.update({ content: 'Couldn’t find that strike anymore. It may already have been changed.', components: [] });
    const what = w <= 0 ? `Removed strike \`${strikeId}\`` : `Set strike \`${strikeId}\` to **${w} unit${w > 1 ? 's' : ''}**`;
    return interaction.update({ content: `✅ ${what} on <@${uid}>, now **${D.strike.format(r.totalUnits)}/${D.strike.BAN_THRESHOLD} units** (${r.tier}).`, components: [] });
  }
  // Setup page — create/repair a channel or (re)post a member panel. Delegates to D.runSetup (index.js),
  // which runs the same module.setup() the old *-setup commands did. 'dashboard' first asks for a channel.
  if (id.startsWith('fops_setup:')) {
    if (!meets(tier, 'admin')) return denyReply('admin');
    const kind = id.slice('fops_setup:'.length);
    if (kind === 'dashboard') {
      const menu = new ChannelSelectMenuBuilder().setCustomId('fops_setupdash').addChannelTypes(ChannelType.GuildText)
        .setPlaceholder('Pick the channel for the member hub…').setMaxValues(1);
      return interaction.reply({ content: '🤖 Where should I post + pin the member hub?', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (!D.runSetup) return interaction.reply({ content: 'Setup isn’t wired up.', flags: MessageFlags.Ephemeral });
    return D.runSetup(interaction, kind);
  }
  if (id === 'fops_setupdash' && interaction.isChannelSelectMenu?.()) {
    if (!meets(tier, 'admin')) return denyReply('admin');
    if (!D.runSetup) return interaction.reply({ content: 'Setup isn’t wired up.', flags: MessageFlags.Ephemeral });
    return D.runSetup(interaction, 'dashboard', interaction.values[0]);
  }
  // Promotions page: open a promotion VOTE for each selected candidate (multi). fops_promote:<trial|mod>.
  if (id.startsWith('fops_promote:') && interaction.isStringSelectMenu?.()) {
    const kind = id.split(':')[1];   // 'trial' (→Mod) or 'mod' (→Admin)
    if (kind === 'mod' && !meets(tier, 'admin')) return denyReply('admin');   // mod→admin votes are Admin+
    if (!D.promoteStart) return interaction.reply({ content: 'Promotions aren’t wired up.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const results = [];
    for (const uid of interaction.values) {
      const member = await interaction.guild.members.fetch(uid).catch(() => null);
      if (!member) { results.push(`❌ <@${uid}>: no longer in the server`); continue; }
      const r = await D.promoteStart(interaction.guild, member, interaction.user.id, kind);
      results.push(r.ok ? `✅ <@${uid}>: vote opened` : `⚠️ <@${uid}>: ${r.msg}`);
    }
    const label = kind === 'mod' ? 'Mod → Admin' : 'Trial Mod → Mod';
    return interaction.editReply({ content: `🏅 **${label}**: opened ${results.length} promotion vote(s):\n${results.join('\n')}`, allowedMentions: { parse: [] } });
  }
  // Single-purpose pickers (fops_pick_*) — a member was just chosen via UserSelect for one specific
  // action opened by the buttons below. corner/ban still need one more field, so they show a short
  // follow-up modal (customId carries the uid); everything else executes straight away.
  if (id === 'fops_pick_corner') {
    const uid = interaction.values[0];
    return interaction.showModal(followupModal(`fops_cornermodal2:${uid}`, 'Corner member',
      [
        { id: 'dur', label: `Duration (${copy.corner.units}, blank = indefinite)` },
        { id: 'options', label: 'Options: type "thread", "adult", or "both"', placeholder: 'blank = standard corner' }
      ]));
  }
  if (id === 'fops_pick_cornermulti') {
    _cornerMultiStash.set(interaction.user.id, { ids: interaction.values, at: Date.now() });
    return interaction.showModal(followupModal('fops_cornermulti_dur', `Corner ${interaction.values.length} member(s)`,
      [
        { id: 'dur', label: `Duration (${copy.corner.units}, blank = indefinite)` },
        { id: 'options', label: 'Options: type "thread", "adult", or "both"', placeholder: 'blank = standard corner' }
      ]));
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
    return interaction.showModal(followupModal(`fops_banmodal2:${uid}:${category}`, `Ban: ${CATEGORY_LABEL[category]}`, [{ id: 'reason', label: 'Additional detail (optional)' }]));
  }
  if (id === 'fops_pick_verify') {
    const uid = interaction.values[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.editReply(copy.common.noMemberInServer);
    // Same cornered guard as fops_do_verify (audit A14) — see the comment there.
    if (D.state.getCornered(uid)) return interaction.editReply('⛓️ They’re cornered — release them first, then verify.');
    await member.roles.add(D.config.verifiedRoleId, `Verified via dashboard picker by ${interaction.user.tag}`).catch(() => {});
    if (D.config.unverifiedRoleId) await member.roles.remove(D.config.unverifiedRoleId, 'Verified via dashboard').catch(() => {});
    return interaction.editReply(`✅ Verified <@${uid}> (\`${member.user.tag}\`).`);
  }
  if (id === 'fops_pick_uncorner') {
    const uid = interaction.values[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Same release gate as /uncorner and the Mod-View uncorner (audit U8 follow-up: this picker called
    // uncorner() DIRECTLY with no tier/override/hard-lock check at all — a full bypass of every release
    // protection, from the panel of all places).
    const gate = D.corner.attemptSeverityChange(D.state, uid, interaction.user.id, tier, 'RELEASE', interaction.guild.ownerId);
    if (gate.notFound) return interaction.editReply(`<@${uid}> is not in the corner.`);
    if (!gate.ok) {
      if (gate.hardLocked === 'serverowner') return interaction.editReply(`🔒 Only the **server owner** can release <@${uid}> — hard lock, no override.`);
      if (gate.hardLocked === 'owner') return interaction.editReply(`🔒 Only an **Owner** (or higher) can release <@${uid}> — hard lock, no override.`);
      return interaction.editReply(gate.need
        ? `🔒 You can't release <@${uid}> solo — held at a higher tier. Need **${gate.need}** ${tier}${gate.need === 1 ? '' : 's'} to try within 5 minutes (**${gate.have}/${gate.need}** so far).`
        : `🔒 You can't release <@${uid}> solo — held at a higher tier, and your tier has no override path for this.`);
    }
    const r = await D.corner.uncorner(interaction.guild, uid, D.state);
    if (r.ok && D.announceRelease) await D.announceRelease(interaction.guild, uid, r, interaction.user.id).catch(() => {});
    return interaction.editReply(r.ok ? `🔓 Released <@${uid}>, restored ${r.restored} role(s).` : `Failed: ${r.error}`);
  }
  if (id === 'fops_pick_wladd' || id === 'fops_pick_wlremove') {
    if (!meets(roleTier, 'admin')) return denyReply('admin');
    const uid = interaction.values[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.editReply(copy.common.noMemberInServer);
    if (id === 'fops_pick_wladd') { watchlist.addWatch(uid); return interaction.editReply(`👁️ <@${uid}> (\`${member.user.tag}\`) added to the Watchlist.`); }
    watchlist.removeWatch(uid);
    return interaction.editReply(`✅ <@${uid}> (\`${member.user.tag}\`) removed from the Watchlist.`);
  }
  if (id === 'fops_pick_unban') {
    if (!meets(roleTier, 'admin')) return denyReply('admin');
    const uid = interaction.values[0];
    return interaction.showModal(followupModal(`fops_unbanmodal2:${uid}`, 'Unban: confirm',
      [{ id: 'watchlist', label: 'Watchlist on rejoin? (yes/no)', placeholder: 'no' }]));
  }
  if (id.startsWith('fops_do_')) {
    const [key, uid] = id.split(':');
    const act = key.slice('fops_do_'.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member) return interaction.editReply(copy.common.noMemberInServer);
    // Same tier hierarchy as /corner and /strike (own tier or lower, never higher) — the dashboard's quick
    // corner/strike buttons had no check at all, unlike every non-dashboard entry point. Only guards the
    // ESCALATING actions (corner, strikeup) below; uncorner/verify/strikedown are releases/undos, not
    // punitive, so they're left alone (ban already has its own admin+ gate a few lines down).
    const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
    const targetTier = memberTier(member);
    const outranked = (RANK[targetTier] || 0) > (RANK[tier] || 0);
    if (act === 'corner') {
      if (outranked) return interaction.editReply(`🔒 You can’t corner someone of a higher staff tier than you (they’re **${targetTier}**).`);
      const r = await D.corner.corner(interaction.guild, member, null, D.state, interaction.user.id, null, tier);
      if (!r.ok && r.error === 'gated') {
        return interaction.editReply(r.need
          ? `🔒 That shortens their time below what a higher tier set. Need **${r.need}** ${tier}${r.need === 1 ? '' : 's'} to try within 5 minutes (**${r.have}/${r.need}** so far).`
          : `🔒 That shortens their time below what a higher tier set, and your tier has no override path for this.`);
      }
      if (r.ok && D.announceCorner) await D.announceCorner(interaction.guild, uid, null, interaction.user.id, null);
      // Same post-corner behaviors as the slash/right-click paths (audit A14): repeat-corner escalation
      // alert + the joke/release-lock check-in prompt. Dashboard corners previously skipped both, so
      // panel corners could never trigger the "cornered 3x -> convert to strike" flow.
      if (r.ok && D.afterCorner) await D.afterCorner(interaction, member, r).catch(() => {});
      return interaction.editReply(r.ok ? `⛓️ Cornered <@${uid}> indefinitely, stripped ${r.stripped} role(s). Release from the ⛓️ Corner page when ready.` : `Failed: ${r.error}`);
    }
    if (act === 'verify') {
      // Cornered member (audit A14): verifying them mid-sentence would hand back the Verified role corner
      // stripped (desyncing the release snapshot) and remove the Unverified role corner deliberately kept.
      if (D.state.getCornered(uid)) return interaction.editReply('⛓️ They’re cornered — release them first, then verify.');
      await member.roles.add(D.config.verifiedRoleId, `Verified via dashboard picker by ${interaction.user.tag}`).catch(() => {});
      if (D.config.unverifiedRoleId) await member.roles.remove(D.config.unverifiedRoleId, 'Verified via dashboard').catch(() => {});
      return interaction.editReply(`✅ Verified <@${uid}> (\`${member.user.tag}\`).`);
    }
    if (act === 'uncorner') {
      // Tiering (owner, 2026-08-13): same release gate as /uncorner — a dashboard click shouldn't be an
      // easier way around the tier/override rules than the slash command. guildOwnerId is REQUIRED (audit
      // U8): without it, canActSolo's serverowner check is always false and the one lock whose purpose is
      // "only the server owner can lift this" was unliftable from the dashboard, even BY the server owner.
      const gate = D.corner.attemptSeverityChange(D.state, uid, interaction.user.id, tier, 'RELEASE', interaction.guild.ownerId);
      if (gate.notFound) return interaction.editReply(`<@${uid}> is not in the corner.`);
      if (!gate.ok) {
        if (gate.hardLocked === 'serverowner') return interaction.editReply(`🔒 Only the **server owner** can release <@${uid}> — hard lock, no override.`);
        if (gate.hardLocked === 'owner') return interaction.editReply(`🔒 Only an **Owner** (or higher) can release <@${uid}> — hard lock, no override.`);
        return interaction.editReply(gate.need
          ? `🔒 You can't release <@${uid}> solo — they were cornered/held at a higher tier. Need **${gate.need}** ${tier}${gate.need === 1 ? '' : 's'} to try within 5 minutes (**${gate.have}/${gate.need}** so far).`
          : `🔒 You can't release <@${uid}> solo — they were cornered/held at a higher tier, and your tier has no override path for this.`);
      }
      const r = await D.corner.uncorner(interaction.guild, uid, D.state);
      if (r.ok && D.announceRelease) await D.announceRelease(interaction.guild, uid, r, interaction.user.id).catch(() => {});
      return interaction.editReply(r.ok ? `🔓 Released <@${uid}>, restored ${r.restored} role(s).` : `Failed: ${r.error}`);
    }
    if (act === 'ban') {
      if (!meets(tier, 'admin')) return interaction.editReply('🔒 Banning is **admin+** only.');
      if (member.permissions.has(PermissionsBitField.Flags.Administrator) || member.id === interaction.guild.ownerId)
        return interaction.editReply(copy.guards.refuseBanStaff);
      try {
        await member.ban({ reason: `Banned via dashboard by ${interaction.user.tag}` });
        if (D.logBan) await D.logBan(interaction.guild, uid, member.user.tag, 'via dashboard', interaction.user.id).catch(() => {});
        else if (D.logAction) await D.logAction(interaction.guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `<@${uid}> (${member.user.tag}) — via dashboard — by <@${interaction.user.id}>.` });
        return interaction.editReply(`🔨 Banned <@${uid}> (\`${member.user.tag}\`).`);
      } catch (e) { return interaction.editReply(`❌ Ban failed: ${e.message}`); }
    }
    if (act.startsWith('strike')) {
      if (!D.strike) return interaction.editReply('Strikes aren’t set up.');
      const cap = D.strike.BAN_THRESHOLD;
      if (act === 'strikeup') {
        if (outranked) return interaction.editReply(`🔒 You can’t strike someone of a higher staff tier than you (they’re **${targetTier}**).`);
        const r = await D.strike.up(interaction.guild, member, interaction.user.tag, interaction.user.id);
        return interaction.editReply(`⚠️ Gave <@${uid}> a 1-unit strike, now **${D.strike.format(r.totalUnits)}/${cap} units**.${r.crossedBan ? ' 🔨 **Crossed the ban threshold.** Use the Ban button if staff confirms.' : ''}`);
      }
      if (act === 'strikedown') {
        const r = await D.strike.down(interaction.guild, member, interaction.user.tag, interaction.user.id);
        if (!r.ok) return interaction.editReply(`<@${uid}> has no active strikes to undo.`);
        return interaction.editReply(`➖ Undid <@${uid}>’s most recent strike, now **${D.strike.format(r.totalUnits)}/${cap} units**${r.totalUnits === 0 ? ', clean again 💗' : ''}.`);
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

  if (id.startsWith('fops_ov_editnote:')) {
    if (!isBotOwner(interaction) && !meets(tier, 'owner')) return denyReply('owner');
    const ruleId = id.split(':')[1];
    const o = overridesManager.getOverride(ruleId);
    if (!o) return interaction.reply({ content: 'That rule no longer exists.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`fops_ov_notemodal:${ruleId}`).setTitle('Edit Rule Note');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('note').setLabel('Note / Description').setStyle(TextInputStyle.Short).setRequired(false).setValue((o.note || '').slice(0, 4000))));
    return interaction.showModal(modal);
  }

  if (id.startsWith('fops_ov_grouptier:')) {
    if (!isBotOwner(interaction) && !meets(tier, 'owner')) return denyReply('owner');
    const [, targetType, targetId] = id.split(':');
    const reqTier = interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`fops_ov_groupmodal:${targetType}:${targetId}:${reqTier}`).setTitle('Require a Group to Corner');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('count').setLabel('How many, e.g. 3').setStyle(TextInputStyle.Short).setRequired(true).setValue('3')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('window').setLabel('Within how many minutes, e.g. 5').setStyle(TextInputStyle.Short).setRequired(true).setValue('5')));
    return interaction.showModal(modal);
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
      await interaction.editReply(`⚙️ **${key}** → ${next ? 'ON' : 'OFF'}${key === 'dryRun' && !next ? '. ⚠️ Reaping is now **LIVE** (members will be kicked).' : ''}`);
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ftoggle:')) {
      const key = id.slice('fops_ftoggle:'.length);
      // Same policy tier as the /features toggle command: these are owner calls, not day-to-day admin ones.
      if (!meets(tier, 'owner')) return deny('owner');
      const next = !features.enabled(key);
      features.setEnabled(key, next);
      const FRIENDLY = { memberCorner: 'Member cornering' };   // extend as more feature toggles land on the panel
      const label = FRIENDLY[key] || key;
      try { require('./ownerlog').log(interaction.guild, { emoji: next ? '🟢' : '⚫', title: `Feature ${next ? 'enabled' : 'disabled'}`, color: next ? 0x57F287 : 0x99AAB5, detail: `**${label}** (\`${key}\`) — via dashboard by <@${interaction.user.id}>.` }); } catch { /* ownerlog best-effort */ }
      await interaction.editReply(`${next ? '🟢' : '⚫'} **${label}** → ${next ? 'ON' : 'OFF'}. Takes effect immediately, no restart needed.`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_modapps_toggle') {
      if (!meets(tier, 'admin')) return deny('admin');
      const modapps = require('./modapps');
      // Moderator-track only — see buildActions' comment. The Mini-mod track has its own state,
      // flip it via /mod-applications open|close track:lang.
      const nowOpen = !modapps.applicationsOpen('mod');   // flip current state
      await modapps.setApplicationsOpen(interaction.guild, nowOpen, null, 'mod');
      try { require('./ownerlog').log(interaction.guild, { emoji: nowOpen ? '✅' : '🚫', title: nowOpen ? 'Mod applications REOPENED (Moderator)' : 'Mod applications CLOSED (Moderator)', color: nowOpen ? 0x57F287 : 0xED4245, detail: `${nowOpen ? 'Reopened' : 'Closed'} via dashboard by <@${interaction.user.id}>.${nowOpen ? '' : ' In-flight applications still finish.'}` }); } catch { /* ownerlog best-effort */ }
      await interaction.editReply(nowOpen ? '✅ **Moderator** applications are now **OPEN**. Members can `/apply-mod`.' : '🚫 **Moderator** applications are now **CLOSED** (team full). Applications already under review still finish.');
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_modapps_approvers') {
      // Owner-only even though the page itself is admin-tier (same "one stricter button on a looser
      // page" shape as promote_confirm/reject in index.js) — accepting/denying a mod app is already
      // gated to owner + this list, so letting an admin add themselves here would defeat that gate.
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const modapps = require('./modapps');
      const list = modapps.getApprovers();
      const rows = [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('fops_modapps_approvers_add').setPlaceholder('➕ Add approver(s)…').setMinValues(1).setMaxValues(10))];
      if (list.length) {
        const opts = list.slice(0, 25).map(id2 => ({ label: interaction.guild.members.cache.get(id2)?.user.tag || id2, value: id2 }));
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('fops_modapps_approvers_remove').setPlaceholder('➖ Remove an approver…').addOptions(opts)));
      }
      return interaction.editReply({
        content: `### 👥 Mod application approvers\nCan accept/deny/undo mod applications, same as the server owner: **you** (always), plus:\n${list.length ? list.map(id2 => `• <@${id2}>`).join('\n') : '_none set_'}`,
        components: rows, allowedMentions: { parse: [] },
      });
    }
    if (id === 'fops_modapps_approvers_add' && interaction.isUserSelectMenu?.()) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const modapps = require('./modapps');
      const added = interaction.values;
      let approvers; for (const uid of added) approvers = modapps.addApprover(uid);
      try { require('./ownerlog').log(interaction.guild, { emoji: '👥', title: 'Mod app approver(s) added', color: 0x57F287, detail: `${added.map(id2 => `<@${id2}>`).join(', ')} — via dashboard by <@${interaction.user.id}>.` }); } catch { /* best-effort */ }
      await interaction.editReply({ content: `✅ Added ${added.map(id2 => `<@${id2}>`).join(', ')}. Current approvers:\n${approvers.map(id2 => `• <@${id2}>`).join('\n')}`, components: [], allowedMentions: { parse: [] } });
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_modapps_approvers_remove' && interaction.isStringSelectMenu?.()) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const modapps = require('./modapps');
      const removedId = interaction.values[0];
      const approvers = modapps.removeApprover(removedId);
      try { require('./ownerlog').log(interaction.guild, { emoji: '👥', title: 'Mod app approver removed', color: 0xED4245, detail: `<@${removedId}> — via dashboard by <@${interaction.user.id}>.` }); } catch { /* best-effort */ }
      await interaction.editReply({ content: `➖ Removed <@${removedId}>. Current approvers:\n${approvers.length ? approvers.map(id2 => `• <@${id2}>`).join('\n') : '_none set_'}`, components: [], allowedMentions: { parse: [] } });
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
      await interaction.editReply(`⏱️ Timings updated: warn ${warn}d → kick ${kick}d · sweep ${sweep}m.`);
      return refreshPanel(interaction.client);
    }

    if (id.startsWith('fops_cornermodal2:')) {
      const uid = id.split(':')[1];
      const member = await interaction.guild.members.fetch(uid).catch(() => null);
      if (!member) return interaction.editReply(copy.common.noMemberInServer);
      const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
      const targetTier = memberTier(member);
      if ((RANK[targetTier] || 0) > (RANK[tier] || 0))
        return interaction.editReply(`🔒 You can’t corner someone of a higher staff tier than you (they’re **${targetTier}**).`);
      const dur = interaction.fields.getTextInputValue('dur').trim();
      const ms = dur ? D.corner.parseDuration(dur) : null;
      if (dur && !ms) return interaction.editReply(copy.corner.badDuration);
      let optsStr = ''; try { optsStr = (interaction.fields.getTextInputValue('options') || '').toLowerCase(); } catch {}
      const isAdult = optsStr.includes('adult');
      const isThread = optsStr.includes('thread');
      const r = await D.corner.corner(interaction.guild, member, ms, D.state, interaction.user.id, null, tier, { adult: isAdult, thread: isThread });
      if (!r.ok) {
        if (r.error === 'gated') {
          return interaction.editReply(r.need
            ? `🔒 That shortens their time below what a higher tier set. Need **${r.need}** ${tier}${r.need === 1 ? '' : 's'} to try within 5 minutes (**${r.have}/${r.need}** so far).`
            : `🔒 That shortens their time below what a higher tier set, and your tier has no override path for this.`);
        }
        return interaction.editReply(`Failed: ${r.error}`);
      }
      if (D.announceCorner) await D.announceCorner(interaction.guild, member.id, ms, interaction.user.id, null, r.threadId, r.targetChannelId);
      await interaction.editReply(`⛓️ Cornered <@${member.id}> (\`${member.user.tag}\`)${dur ? ` for ${dur}` : ' indefinitely'}, stripped ${r.stripped} role(s).`);
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_cornermulti_dur') {
      const stash = _cornerMultiStash.get(interaction.user.id);
      _cornerMultiStash.delete(interaction.user.id);
      if (!stash || !stash.ids?.length) return interaction.editReply('That selection expired. Pick the members again.');
      const dur = (interaction.fields.getTextInputValue('dur') || '').trim();
      const ms = dur ? D.corner.parseDuration(dur) : null;
      if (dur && !ms) return interaction.editReply('Bad duration. Use `30m`, `2h`, `3d`, `30s`.');
      const members = [];
      for (const uid of stash.ids) { const m = await interaction.guild.members.fetch(uid).catch(() => null); if (m) members.push(m); }
      const actorRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[tierOf(interaction)] || 0;
      let optsStr = ''; try { optsStr = (interaction.fields.getTextInputValue('options') || '').toLowerCase(); } catch {}
      const isAdult = optsStr.includes('adult');
      const isThread = optsStr.includes('thread');
      const { done, skipped } = await D.cornerMany(interaction.guild, interaction.user.id, actorRank, members, ms, { adult: isAdult, thread: isThread });
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
      const reason = `${CATEGORY_LABEL[category] || 'Other'}${detail ? `: ${detail}` : ''} (via dashboard by ${interaction.user.tag})`;
      await member.ban({ reason });
      // This was the ONE ban path with zero logging (audit A14) — the category-modal ban, the one with the
      // most moderator context attached, left no trace in any log. Same trio the wl_banok path writes.
      if (D.logBan) await D.logBan(interaction.guild, member.id, member.user.tag, reason, interaction.user.id).catch(() => {});
      return interaction.editReply(`🔨 Banned <@${member.id}> (\`${member.user.tag}\`): **${CATEGORY_LABEL[category] || 'Other'}**.`);
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
      if (!unv) return interaction.editReply('No unverified role configured, nothing to check.');
      const members = await ensureMembers(interaction.guild);
      const dual = [...members.filter(m => m.roles.cache.has(ver) && m.roles.cache.has(unv)).values()];
      if (!dual.length) return interaction.editReply('✅ No role conflicts.');
      const rows = [];
      for (const m of dual.slice(0, 4)) {
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`conflict_rm:${m.id}:unver`).setLabel(`${m.user.tag}: keep Verified`.slice(0, 80)).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`conflict_rm:${m.id}:ver`).setLabel('keep Unverified').setStyle(ButtonStyle.Secondary)));
      }
      const extra = dual.length > 4 ? `\n…and ${dual.length - 4} more. A sweep flags the rest to the conflict channel.` : '';
      return interaction.editReply({ content: `⚖️ **${dual.length}** role conflict(s):\n${dual.slice(0, 10).map(m => `• <@${m.id}> (\`${m.user.tag}\`)`).join('\n')}${extra}`, components: rows });
    }

    // ── Watchlist actions (edits gate on roleTier = ADMINS-★; list buttons = any staff, view-only) ──
    if (id.startsWith('fops_unbanmodal2:')) {
      if (!meets(roleTier, 'admin')) return deny('admin');
      const uid = id.split(':')[1];
      const keep = /^(y|yes|true|1|on)/i.test((interaction.fields.getTextInputValue('watchlist') || '').trim());
      try { await interaction.guild.bans.remove(uid, `Unban via dashboard by ${interaction.user.tag}`); }
      catch (e) { return interaction.editReply(`❌ Unban failed: ${e.message} (are they actually banned?)`); }
      if (keep) watchlist.addWatch(uid);
      return interaction.editReply(`✅ Unbanned <@${uid}>.${keep ? ' They’re still on the Watchlist.' : ''}`);
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
    if (id === 'fops_ov_addstart') {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return denyReply('owner');
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('fops_ov_picktype').setPlaceholder('Select Rule Type…').addOptions([
          { label: '⚡ Give Cornering Authority', value: 'GRANT_POWER', description: 'Give someone the power to corner like an Owner, Admin, or Mod' },
          // Keep descriptions under Discord's 100-char cap — at 101 this silently broke the whole
          // "Add Rule" picker with an opaque "Received one or more errors" (owner-reported 2026-08-20).
          { label: '🚫 Block Specific Sources', value: 'PROTECT_FROM', description: 'Deny-list: block hit squad, a staff tier, or people/roles — everyone else still can' },
          { label: '🔐 Only These Can Corner Them', value: 'EXCLUSIVE_CORNERER', description: 'Allow-list: ONLY the people/role/tier you pick can corner them — everyone else denied' },
          { label: '🙋 Allow Self-Corner', value: 'ALLOW_SELF_CORNER', description: 'Let a member or role corner themselves' },
          { label: '🔓 Allow Rank Bypass', value: 'BYPASS_TIER', description: 'Let someone corner above their normal staff rank' },
          { label: '👥 Require a Group to Corner', value: 'GROUP_REQUIRED', description: 'N staff of a tier must each try within a window before it goes through' },
        ])
      );
      return interaction.editReply({ content: '### ➕ Add Personal Override Rule\nChoose the type of rule you want to create:', components: [row] });
    }
    if (id === 'fops_ov_picktype') {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleType = interaction.values[0];
      if (ruleType === 'GRANT_POWER') {
        const pRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('fops_ov_grantlevel').setPlaceholder('Select Power Level to Grant…').addOptions([
            { label: '👑 Owner-Level Power', value: 'owner', description: 'Can corner anyone, including Admins & Owners' },
            { label: '★ Admin-Level Power', value: 'admin', description: 'Can corner up to Admins' },
            { label: '✰ Mod-Level Power', value: 'mod', description: 'Can corner up to Mods' },
          ])
        );
        return interaction.editReply({ content: '### ⚡ Grant Corner Power: Step 1 of 3\nSelect the **Power Level** you want to grant:', components: [pRow] });
      }
      if (ruleType === 'BYPASS_TIER') {
        // Target first, actor(s) last — same order as Protect Someone, so who this rule affects is
        // decided before who it applies to, and the final step can multi-select actors in one go.
        return interaction.editReply(targetScopeRow('fops_ov_bypasstscope', '🔓 Allow Rank Bypass: Step 1 of 2', 'Who does this apply against?'));
      }
      if (ruleType === 'GROUP_REQUIRED') {
        return interaction.editReply(targetScopeRow('fops_ov_grouptscope', '👥 Require a Group to Corner: Step 1 of 3', 'Who does this apply against?'));
      }
      const userRow = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`fops_ov_userpick:${ruleType}`).setPlaceholder('👤 Select a Member for this rule…')
      );
      const roleRow = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId(`fops_ov_rolepick:${ruleType}`).setPlaceholder('🎭 OR Select a Role for this rule…')
      );
      return interaction.editReply({ content: `### ➕ Add Override Rule: \`${ruleType}\`\nPick either a **Member** OR a **Role** below:`, components: [userRow, roleRow] });
    }
    if (id === 'fops_ov_grantlevel') {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const powerLevel = interaction.values[0];
      return interaction.editReply(targetScopeRow(`fops_ov_granttscope:${powerLevel}`, `⚡ Grant ${powerLevel.toUpperCase()}-Level Power: Step 2 of 3`, 'Who does this power apply over?'));
    }
    if (id.startsWith('fops_ov_granttscope:') || id.startsWith('fops_ov_bypasstscope')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const isGrant = id.startsWith('fops_ov_granttscope:');
      const powerLevel = isGrant ? id.split(':')[1] : null;
      const scope = interaction.values[0];
      const targetPickPrefix = isGrant ? `fops_ov_granttargetpick:${powerLevel}` : 'fops_ov_bypasstargetpick';
      const actorPickPrefix = isGrant ? `fops_ov_grantactors:${powerLevel}` : 'fops_ov_bypassactors';
      const actorRolePrefix = isGrant ? `fops_ov_grantactorrole:${powerLevel}` : 'fops_ov_bypassactorrole';
      const actorTierPrefix = isGrant ? `fops_ov_grantactortier:${powerLevel}` : 'fops_ov_bypassactortier';
      if (scope === 'all') return interaction.editReply(actorPickRow(`${actorPickPrefix}:*:*`, `${actorRolePrefix}:*:*`, isGrant ? `Grant ${powerLevel.toUpperCase()}-Level Power` : 'Allow Rank Bypass', undefined, `${actorTierPrefix}:*:*`));
      const userRow = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`${targetPickPrefix}:user`).setPlaceholder('👤 Select Target Member…'));
      const roleRow = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`${targetPickPrefix}:role`).setPlaceholder('🎭 OR Select Target Role…'));
      return interaction.editReply({ content: `### Select the target ${scope === 'user' ? 'member' : 'role'}:`, components: scope === 'user' ? [userRow] : [roleRow] });
    }
    if (id.startsWith('fops_ov_grouptscope')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const scope = interaction.values[0];
      if (scope === 'all') return interaction.editReply(groupTierRow('*', '*'));
      const userRow = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('fops_ov_grouptargetpick:user').setPlaceholder('👤 Select Target Member…'));
      const roleRow = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('fops_ov_grouptargetpick:role').setPlaceholder('🎭 OR Select Target Role…'));
      return interaction.editReply({ content: `### Select the target ${scope === 'user' ? 'member' : 'role'}:`, components: scope === 'user' ? [userRow] : [roleRow] });
    }
    if (id.startsWith('fops_ov_grouptargetpick:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const targetType = id.split(':')[1];
      return interaction.editReply(groupTierRow(targetType, interaction.values[0]));
    }
    if (id.startsWith('fops_ov_groupmodal:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const [, targetType, targetId, reqTier] = id.split(':');
      const count = Math.max(1, parseInt(interaction.fields.getTextInputValue('count'), 10) || 3);
      const windowMin = Math.max(1, parseInt(interaction.fields.getTextInputValue('window'), 10) || 5);
      const entry = overridesManager.addOverride({
        actors: [{ type: 'tier', id: reqTier }], targetType, targetId, type: 'GROUP_REQUIRED',
        requiredCount: count, windowMs: windowMin * 60000, note: '', createdBy: interaction.user.id,
      });
      await interaction.editReply({ content: `✅ Added: cornering ${overrideTargetFmt(entry)} now needs **${count} ${TIER_ACTOR_LABEL[reqTier] || reqTier}** to each try within **${windowMin}m**.`, components: [] });
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_granttargetpick:') || id.startsWith('fops_ov_bypasstargetpick:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const isGrant = id.startsWith('fops_ov_granttargetpick:');
      const parts = id.split(':');
      const powerLevel = isGrant ? parts[1] : null;
      const targetType = parts[parts.length - 1];
      const targetId = interaction.values[0];
      const actorPickPrefix = isGrant ? `fops_ov_grantactors:${powerLevel}:${targetType}:${targetId}` : `fops_ov_bypassactors:${targetType}:${targetId}`;
      const actorRolePrefix = isGrant ? `fops_ov_grantactorrole:${powerLevel}:${targetType}:${targetId}` : `fops_ov_bypassactorrole:${targetType}:${targetId}`;
      const actorTierPrefix = isGrant ? `fops_ov_grantactortier:${powerLevel}:${targetType}:${targetId}` : `fops_ov_bypassactortier:${targetType}:${targetId}`;
      return interaction.editReply(actorPickRow(actorPickPrefix, actorRolePrefix, isGrant ? `Grant ${powerLevel.toUpperCase()}-Level Power` : 'Allow Rank Bypass', undefined, actorTierPrefix));
    }
    if (id.startsWith('fops_ov_grantactors:') || id.startsWith('fops_ov_grantactorrole:') || id.startsWith('fops_ov_bypassactors:') || id.startsWith('fops_ov_bypassactorrole:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const isGrant = id.startsWith('fops_ov_grantactor');
      const isRole = id.startsWith('fops_ov_grantactorrole:') || id.startsWith('fops_ov_bypassactorrole:');
      const parts = id.split(':');
      const powerLevel = isGrant ? parts[1] : null;
      const targetType = isGrant ? parts[2] : parts[1];
      const targetId = isGrant ? parts[3] : parts[2];
      const actors = isRole ? [{ type: 'role', id: interaction.values[0] }] : interaction.values.map(uid => ({ type: 'user', id: uid }));
      const type = isGrant ? 'GRANT_POWER' : 'BYPASS_TIER';
      const entry = overridesManager.addOverride({ actors, targetType, targetId, type, powerTier: isGrant ? powerLevel : null, note: '', createdBy: interaction.user.id });
      const verb = isGrant ? `granted **${powerLevel.toUpperCase()}**-level cornering power` : 'given a rank bypass';
      await interaction.editReply({ content: `✅ ${overrideActorFmt(entry)} ${verb}, over ${overrideTargetFmt(entry)}.`, components: [] });
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_grantactortier:') || id.startsWith('fops_ov_bypassactortier:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const isGrant = id.startsWith('fops_ov_grantactortier:');
      const parts = id.split(':');
      const powerLevel = isGrant ? parts[1] : null;
      const targetType = isGrant ? parts[2] : parts[1];
      const targetId = isGrant ? parts[3] : parts[2];
      const actors = [{ type: 'tier', id: interaction.values[0] }];
      const type = isGrant ? 'GRANT_POWER' : 'BYPASS_TIER';
      const entry = overridesManager.addOverride({ actors, targetType, targetId, type, powerTier: isGrant ? powerLevel : null, note: '', createdBy: interaction.user.id });
      const verb = isGrant ? `granted **${powerLevel.toUpperCase()}**-level cornering power` : 'given a rank bypass';
      await interaction.editReply({ content: `✅ ${overrideActorFmt(entry)} ${verb}, over ${overrideTargetFmt(entry)}.`, components: [] });
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_userpick:') || id.startsWith('fops_ov_rolepick:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const isUser = id.startsWith('fops_ov_userpick:');
      const ruleType = id.split(':')[1];
      const pickedId = interaction.values[0];

      if (ruleType === 'PROTECT_FROM') {
        // Who's protected is picked; who/what they're protected FROM is a separate step (deny-list, not
        // an allow-list — see denyFromPickRow).
        const targetType = isUser ? 'user' : 'role';
        return interaction.editReply(denyFromPickRow(`fops_ov_denyfrom:${targetType}:${pickedId}`,
          `Protect ${isUser ? `<@${pickedId}>` : `<@&${pickedId}>`}`));
      }
      if (ruleType === 'EXCLUSIVE_CORNERER') {
        // Allow-list model, restored as its own explicit option (owner, 2026-08-20: "i don't want anything
        // to be a one off only able to be made through you" — every rule shape that exists must stay
        // creatable through the panel, not just left running as data I hand-wrote once).
        const targetType = isUser ? 'user' : 'role';
        return interaction.editReply(actorPickRow(`fops_ov_exclusiveactors:${targetType}:${pickedId}`, `fops_ov_exclusiverole:${targetType}:${pickedId}`,
          `Protect ${isUser ? `<@${pickedId}>` : `<@&${pickedId}>`}`, 'who is allowed to corner them', `fops_ov_exclusiveactortier:${targetType}:${pickedId}`));
      }
      // ALLOW_SELF_CORNER: target IS the actor, one rule per pick — no multi-actor step needed.
      const entry = overridesManager.addOverride({
        actorType: isUser ? 'user' : 'role',
        actorId: pickedId,
        targetType: isUser ? 'user' : 'role',
        targetId: pickedId,
        type: 'ALLOW_SELF_CORNER',
        note: 'Self-corner allowed',
        createdBy: interaction.user.id
      });
      await interaction.editReply({ content: `✅ Added personal override rule \`${entry.id}\` for ${isUser ? `<@${pickedId}>` : `<@&${pickedId}>`} (${ruleType}).`, components: [] });
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_denyfrom:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const [, targetType, targetId, pickKind] = id.split(':');
      const denied = pickKind === 'source'
        ? interaction.values.map(v => v.startsWith('tier:') ? { type: 'tier', id: v.slice(5) } : { type: v })
        : pickKind === 'role' ? [{ type: 'role', id: interaction.values[0] }]
        : interaction.values.map(uid => ({ type: 'user', id: uid }));
      const entry = overridesManager.addOverride({ denied, targetType, targetId, type: 'PROTECT_FROM', note: '', createdBy: interaction.user.id });
      await interaction.editReply({ content: `✅ Protected ${targetType === 'role' ? `<@&${targetId}>` : `<@${targetId}>`} — blocked from ${overrideActorFmt(entry)}.`, components: [] });
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_exclusiveactors:') || id.startsWith('fops_ov_exclusiverole:') || id.startsWith('fops_ov_exclusiveactortier:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const isRole = id.startsWith('fops_ov_exclusiverole:');
      const isTier = id.startsWith('fops_ov_exclusiveactortier:');
      const [, targetType, targetId] = id.split(':');
      const actors = isTier ? [{ type: 'tier', id: interaction.values[0] }]
        : isRole ? [{ type: 'role', id: interaction.values[0] }]
        : interaction.values.map(uid => ({ type: 'user', id: uid }));
      const entry = overridesManager.addOverride({ actors, targetType, targetId, type: 'EXCLUSIVE_CORNERER', note: '', createdBy: interaction.user.id });
      await interaction.editReply({ content: `✅ Protected ${targetType === 'role' ? `<@&${targetId}>` : `<@${targetId}>`} — only ${overrideActorFmt(entry)} can corner them now.`, components: [] });
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_addactor:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      return interaction.editReply(actorPickRow(`fops_ov_addactoruser:${ruleId}`, `fops_ov_addactorrole:${ruleId}`,
        '➕ Add Actor(s)', 'the new actor(s)', `fops_ov_addactortier:${ruleId}`));
    }
    if (id.startsWith('fops_ov_addactoruser:') || id.startsWith('fops_ov_addactorrole:') || id.startsWith('fops_ov_addactortier:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const isUser2 = id.startsWith('fops_ov_addactoruser:');
      const isTier2 = id.startsWith('fops_ov_addactortier:');
      const ruleId = id.split(':')[1];
      if (isTier2) overridesManager.addRuleActor(ruleId, 'tier', interaction.values[0]);
      else for (const val of interaction.values) overridesManager.addRuleActor(ruleId, isUser2 ? 'user' : 'role', val);
      await interaction.editReply(buildOverrideDetail(ruleId));
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_rmactor:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const o = overridesManager.getOverride(ruleId);
      if (!o) return interaction.editReply('That rule no longer exists.');
      const actors = overridesManager.normalizeActors(o);
      const opts = actors.slice(0, 25).map(a => ({
        label: (a.type === 'role' ? `Role: ${a.id}` : a.type === 'tier' ? `Tier: ${a.id}+` : `Member: ${a.id}`).slice(0, 100),
        value: `${a.type}:${a.id}`
      }));
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`fops_ov_rmactorpick:${ruleId}`).setPlaceholder('Select an actor to remove…').addOptions(opts)
      );
      return interaction.editReply({ content: '### ➖ Remove Actor\nWho should lose permission to corner this target?', components: [row] });
    }
    if (id.startsWith('fops_ov_rmactorpick:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const [aType, aId] = interaction.values[0].split(':');
      overridesManager.removeRuleActor(ruleId, aType, aId);
      await interaction.editReply(buildOverrideDetail(ruleId));
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_addblock:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      return interaction.editReply(denyFromPickRow(`fops_ov_addblockpick:${ruleId}`, '➕ Add Block'));
    }
    if (id.startsWith('fops_ov_addblockpick:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const [, ruleId, pickKind] = id.split(':');
      if (pickKind === 'source') for (const v of interaction.values) overridesManager.addDeniedEntry(ruleId, v.startsWith('tier:') ? 'tier' : v, v.startsWith('tier:') ? v.slice(5) : undefined);
      else if (pickKind === 'role') overridesManager.addDeniedEntry(ruleId, 'role', interaction.values[0]);
      else for (const uid of interaction.values) overridesManager.addDeniedEntry(ruleId, 'user', uid);
      await interaction.editReply(buildOverrideDetail(ruleId));
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_rmblock:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const o = overridesManager.getOverride(ruleId);
      if (!o) return interaction.editReply('That rule no longer exists.');
      const denied = overridesManager.normalizeDenied(o);
      const opts = denied.slice(0, 25).map(d => ({
        label: fmtEntity(d.type, d.id).replace(/[<>@&]/g, '').slice(0, 100),
        value: `${d.type}:${d.id || ''}`
      }));
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`fops_ov_rmblockpick:${ruleId}`).setPlaceholder('Select a block to remove…').addOptions(opts)
      );
      return interaction.editReply({ content: '### ➖ Remove Block\nWhich block should no longer apply?', components: [row] });
    }
    if (id.startsWith('fops_ov_rmblockpick:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const [dType, dId] = interaction.values[0].split(':');
      overridesManager.removeDeniedEntry(ruleId, dType, dId || undefined);
      await interaction.editReply(buildOverrideDetail(ruleId));
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_hitsquadtoggle:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const o = overridesManager.getOverride(ruleId);
      if (!o) return interaction.editReply('That rule no longer exists.');
      overridesManager.setExclusiveHitSquadExempt(ruleId, !o.hitSquadExempt);
      await interaction.editReply(buildOverrideDetail(ruleId));
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_enabletoggle:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const o = overridesManager.getOverride(ruleId);
      if (!o) return interaction.editReply('That rule no longer exists.');
      overridesManager.setEnabled(ruleId, !overridesManager.isEnabled(o));
      await interaction.editReply(buildOverrideDetail(ruleId));
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_ov_back') {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      return interaction.editReply(buildOverrides());
    }
    if (id === 'fops_ov_managepicker' || id.startsWith('fops_ov_detail:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id === 'fops_ov_managepicker' ? interaction.values[0] : id.split(':')[1];
      return interaction.editReply(buildOverrideDetail(ruleId));
    }
    if (id.startsWith('fops_ov_notemodal:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const note = interaction.fields.getTextInputValue('note') || '';
      const entry = overridesManager.updateOverride(ruleId, { note });
      if (!entry) return interaction.editReply('That rule no longer exists.');
      await interaction.editReply(buildOverrideDetail(ruleId));
      return refreshPanel(interaction.client);
    }
    if (id.startsWith('fops_ov_delconfirm:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const o = overridesManager.getOverride(ruleId);
      if (!o) return interaction.editReply('That rule no longer exists.');
      return interaction.editReply({
        content: `### ⚠️ Delete this rule?\n${overrideSummaryLine(o)}\nThis is permanent — there's no undo.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`fops_ov_delgo:${ruleId}`).setEmoji('🗑️').setLabel('Yes, delete it').setStyle(ButtonStyle.Danger)
        )]
      });
    }
    if (id.startsWith('fops_ov_delgo:')) {
      if (!isBotOwner(interaction) && !meets(tier, 'owner')) return deny('owner');
      const ruleId = id.split(':')[1];
      const ok = overridesManager.removeOverride(ruleId);
      await interaction.editReply(ok ? `🗑️ Deleted rule \`${ruleId}\`.` : 'Rule not found — already gone.');
      return refreshPanel(interaction.client);
    }
    if (id === 'fops_wl_termlist') {
      const s = watchlist.loadTerms(), l = watchlist.loadLoose(), w = watchlist.loadWelfare();
      return interaction.editReply(`**Strict (${s.length})** → ban:\n${s.map(t => `\`${t}\``).join(' · ') || '_none_'}\n\n**Loose (${l.length})** → #watch-log:\n${l.map(t => `\`${t}\``).join(' · ') || '_none_'}\n\n**Welfare (${w.length})** → check-in:\n${w.map(t => `\`${t}\``).join(' · ') || '_none_'}`.slice(0, 1900));
    }
    if (id === 'fops_wl_list') {
      const ids = watchlist.loadWatched();
      return interaction.editReply(`**On the Watchlist (${ids.length}):**\n${ids.map(uid => `• <@${uid}>`).join('\n') || '_none_'}`.slice(0, 1800));
    }

    await interaction.editReply('Unknown action.');
  } catch (e) {
    await interaction.editReply(`Error: ${e.message}`);
  }
}

module.exports = { wire, ensurePanel, ensureCommandRef, refreshPanel, isPanelInteraction, handlePanel, openPersonalPanel, openStaffFloorPanel, tierOf, memberTier, isBotOwner, BOT_OWNER_ID, BOT_OWNER_IDS, attributeActor, cornerActor, PAGES, PANEL_FILE, CATEGORY_LABEL, OWNER_ROLE_IDS, OWNER_DISPLAY_ROLE_ID, ADMIN_ROLE_ID, MOD_ROLE_ID, meets, TIER_RANK: RANK };
