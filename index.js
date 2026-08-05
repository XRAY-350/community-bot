// index.js — entry point. Boots the discord.js client, resolves the verify + alert channels
// once at ready, and wires the verify trigger (role → close) and the periodic sweep (nudge + stale).
//
// Intents: Guilds (channels/threads) + GuildMembers (PRIVILEGED — required to receive
// guildMemberUpdate so we can see the Verified role being assigned). The GuildMembers intent
// must also be enabled in the Discord Developer Portal for this application.

const { Client, GatewayIntentBits, Partials, PermissionsBitField, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContextMenuCommandBuilder, ApplicationCommandType, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, AuditLogEvent, ChannelType } = require('discord.js');
const { MessageFlags } = require('discord.js');
const config = require('./config');
const State = require('./state');
const verify = require('./verify');
const sweep = require('./sweep');
const reactresolve = require('./reactresolve');
const corner = require('./corner');
const { buildVerifyPanel, handleVerifyButton, isVerifyButton } = require('./verifypanel');
const { activeThreads } = require('./threads');
const { ensureMembers } = require('./memberCache');
const opspanel = require('./opspanel');
const watchlist = require('./watchlist');
const wordfilter = require('./wordfilter');
const tribes = require('./tribes');
const pubdash = require('./pubdash');
const suggest = require('./suggest');
const suggestions = require('./suggestions');
const confessions = require('./confessions');
const whistleblow = require('./whistleblow');
const reports = require('./reports');
const modmail = require('./modmail');
const modapps = require('./modapps');
const langmods = require('./langmods');
const promote = require('./promote');
const ownerlog = require('./ownerlog');
const permguard = require('./permguard');
const perms = require('./perms');
const rolereq = require('./rolereq');
const appeals = require('./appeals');
const strikeAppeals = require('./strikeAppeals');
const features = require('./features');
const contest = require('./contest');
const arena = require('./arena');
const achievements = require('./achievements');
const recruitment = require('./recruitment');
const lore = require('./lore');
const throneExpire = require('./throneExpire');
const smartwatch = require('./smartwatch');
const freshwatch = require('./freshwatch');
const copy = require('./copy');   // single source of truth for public-facing text (see copy.js / COPY-REGISTRY.md)
const rules = require('./rules');
const strikes = require('./strikes');
const roleselect = require('./roleselect');
const fs = require('fs');

// ── Themed corner announcements (serious, jail-themed embeds posted in the corner channel) ──
const CORNER_RED = 0x992D22;    // sent to the corner
const CORNER_GREEN = 0x2ECC71;  // released
const CORNER_AMBER = 0xE67E22;  // sentence changed / release scheduled (a modification, not entry/exit)
// The server's 11 rules (rules.js is the single source of truth — text + per-rule weight live there
// now) — TITLES is a drop-in replacement for the old hardcoded array, used by the /corner + /strike
// add "why" pickers.
const SERVER_RULES = rules.TITLES;
// Small-caps unicode (the server's channel/role aesthetic). Used by /tribe-admin create's style option.
const SMALL_CAPS = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
const toSmallCaps = s => String(s).split('').map(ch => SMALL_CAPS[ch.toLowerCase()] || ch).join('');
// Tribe banner art (Phase 7, owner: members make the art, the bot displays it). Stored on DISK and re-attached
// via attachment:// at render time, so it survives Discord's CDN URL expiry (a stored URL would break in ~24h).
const TRIBE_BANNER_DIR = process.env.FUBU_TRIBE_BANNER_DIR || '/home/ubuntu/.fubu_tribe_banners';
try { fs.mkdirSync(TRIBE_BANNER_DIR, { recursive: true }); } catch { /* exists */ }
const tribeBannerPath = key => `${TRIBE_BANNER_DIR}/${key}.png`;
const tribeHasBanner = key => { try { return fs.existsSync(tribeBannerPath(key)); } catch { return false; } };
// Attach a tribe's banner (if any) to a reply payload: sets the first embed's image to the attached file.
function withBanner(key, payload) {
  if (!tribeHasBanner(key) || !payload.embeds || !payload.embeds[0]) return payload;
  payload.embeds[0].setImage('attachment://banner.png');
  return { ...payload, files: [...(payload.files || []), { attachment: tribeBannerPath(key), name: 'banner.png' }] };
}
// Every role id the bot considers "structural" (staff, colors, regions, pronouns, ages, Arcane levels, the
// contest winner role, every existing tribe's roles, the crown role) — used to rule these OUT when deciding
// whether a role is a member's own personal vanity role. Best-effort, not exhaustive by construction; a role
// this misses just means the founder falls through to getting a normal new tribe role, never the reverse.
function systemicRoleIds(guild) {
  const s = new Set([guild.id]);
  const add = (...ids) => ids.forEach(id => { if (id) s.add(id); });
  add(opspanel.ADMIN_ROLE_ID, opspanel.MOD_ROLE_ID, opspanel.OWNER_DISPLAY_ROLE_ID, ...(opspanel.OWNER_ROLE_IDS || []));
  add(config.verifiedRoleId, config.unverifiedRoleId, config.cornerRoleId, config.trialModRoleId, config.mdniRoleId, config.langMiniModRoleId, config.minorAgeRoleId);
  (config.adultAgeRoleIds || []).forEach(add);
  (config.strikeRoleIds || []).forEach(add);
  (config.identifyingRoleIds || []).forEach(add);
  roleselect.COLORS.forEach(([, id]) => add(id));
  roleselect.AGE.forEach(([, id]) => add(id));
  Object.values(roleselect.loadSections() || {}).forEach(list => (list || []).forEach(([, id]) => add(id)));
  add('1529120692845674687', '1529121181767176313', '1529121191384842330', '1529121471946035330'); // Arcane Novice/Inter/Elite/NOLIFE
  const contestCfg = contest.loadCfg ? contest.loadCfg() : null;
  if (contestCfg) add(contestCfg.winnerRoleId);
  for (const t of tribes.all()) { add(t.roleId, t.leaderRoleId); (t.ranks || []).forEach(r => add(r.roleId)); }
  add(tribes.load().crownRoleId);
  return s;
}
// A founder's "personal role" — owner: "for the people that already have personal roles if they create a
// tribe just rename their role" instead of making a brand-new one. Only counts if EXACTLY ONE of their roles
// is a clear match: solely theirs (nobody else holds it), not a bot/booster role, and not anything structural
// (see systemicRoleIds). 0 or 2+ candidates is ambiguous — falls back to a fresh role, same as before.
async function findFounderPersonalRole(guild, member) {
  // role.members.size only reflects the CACHED member list — a cold cache could undercount a role's real
  // holders and wrongly call something "personal" that other people also have. Force a full fetch first;
  // this only runs at tribe-founding time (rare), so the cost is worth the correctness guarantee.
  await ensureMembers(guild);
  const excluded = systemicRoleIds(guild);
  const candidates = [...member.roles.cache.values()].filter(r =>
    !excluded.has(r.id) && !r.managed && !r.tags?.premiumSubscriberRole && r.members.size === 1);
  return candidates.length === 1 ? candidates[0] : null;
}
// The actual first-tribe self-join (via #roles), shared by the direct path (no gate) and the entrance-gate
// answer button (gate passed). Caller has already run eligibility checks (not already in a tribe, not a
// veteran) — this just does the membership state + role grant + hall welcome post.
// Keeps a member's "General" role (see tribes.staffRankTitle) correct: granted the instant a staff member
// (mod/admin tier) holds a tribe's base role and isn't its leader, revoked the instant either stops being
// true (demoted from staff, banished, or promoted to leader). Called at join-time for instant effect, and
// swept hourly (staffRankSweep below) to catch later promotions/demotions of EXISTING tribe members.
async function syncStaffRank(guild, member, tribe) {
  tribe = tribe || tribes.myTribe(member);
  if (!tribe || !tribe.staffRankRoleId) return;
  const has = member.roles.cache.has(tribe.staffRankRoleId);
  if (tribes.isLeader(member, tribe)) { if (has) await member.roles.remove(tribe.staffRankRoleId, 'Tribe: leader outranks General').catch(() => {}); return; }
  const isTribeMember = member.roles.cache.has(tribe.roleId);
  const isStaff = ['admin', 'mod'].includes(opspanel.memberTier(member));
  if (isTribeMember && isStaff && !has) await member.roles.add(tribe.staffRankRoleId, `Tribe: staff auto-rank (${tribes.staffRankTitle(tribe)})`).catch(() => {});
  else if (has && !(isTribeMember && isStaff)) await member.roles.remove(tribe.staffRankRoleId, 'Tribe: no longer eligible for the staff rank').catch(() => {});
}
async function joinTribeSelfServe(guild, tribe, member, reason = 'First tribe — self-join via #roles') {
  tribes.setMembership(tribe.key, member.id, true);   // authorize first so the guard honors the join
  const ok = await member.roles.add(tribe.roleId, reason).then(() => true).catch(() => false);
  if (!ok) { tribes.setMembership(tribe.key, member.id, false); return { ok: false }; }
  await syncStaffRank(guild, member, tribe);
  if (tribe.hallId) { const hall = await guild.channels.fetch(tribe.hallId).catch(() => null); if (hall) hall.send({ content: `## ${tribe.emoji || '🌊'} A new pledge to ${tribe.shortName || tribe.name}\n> <@${member.id}> has sworn their allegiance.`, allowedMentions: { users: [member.id] } }).catch(() => {}); }
  return { ok: true, content: `${tribe.emoji || '🌊'} You’ve pledged to **${tribe.shortName || tribe.name}**. Welcome. This is your allegiance now; its ${tribes.leaderTitle(tribe)} must release you before you could ever join another.` };
}
// Recruitment rewards (Phase 6, gated by the `recruitment` flag): credit the recruiter when their invitee
// joins, and pay a one-time treasury bonus when the tribe crosses a growth milestone. Announced in the hall.
async function applyRecruitment(guild, tribe, invitee, recruiterId) {
  // Recruiter reward is DEFERRED: the invitee must stick for STICK_DAYS (sweepRecruitment pays it) so
  // instantly-leaving alts can't farm it. Record the pending recruit here.
  if (recruiterId && recruiterId !== invitee.id) recruitment.addPending(recruiterId, invitee.id, tribe.key, Date.now());
  // Growth milestone fires now (the tribe crossed the member count on this join).
  const count = guild.roles.cache.get(tribe.roleId)?.members.size || 0;
  const gm = recruitment.checkGrowth(tribe.key, count);
  if (gm) {
    tribes.addTreasury(tribe.key, gm.treasury);
    const hall = tribe.hallId && await guild.channels.fetch(tribe.hallId).catch(() => null);
    if (hall) await hall.send({ content: `📈 **${tribe.shortName || tribe.name}** just hit **${gm.members} members**! The tribe banks +${gm.treasury} treasury.`, allowedMentions: { parse: [] } }).catch(() => {});
  }
}
// Pay out recruiter rewards for invitees who've now stuck for STICK_DAYS and are STILL in the tribe (Phase 6).
async function sweepRecruitment(guild) {
  if (!features.enabled('recruitment')) return;
  const due = recruitment.duePending(Date.now());
  if (!due.length) return;
  await ensureMembers(guild).catch(() => {});
  for (const p of due) {
    const tribe = tribes.get(p.tribeKey);
    const stillIn = tribe && !!guild.roles.cache.get(tribe.roleId)?.members.has(p.inviteeId);
    if (tribe && stillIn && recruitment.creditRecruit(p.recruiterId, p.inviteeId)) {
      tribes.addTides(tribe.key, p.recruiterId, recruitment.RECRUITER_TIDES);
      tribes.addTreasury(tribe.key, recruitment.RECRUITER_TREASURY);
      const hall = tribe.hallId && await guild.channels.fetch(tribe.hallId).catch(() => null);
      if (hall) await hall.send({ content: `🎉 <@${p.recruiterId}> recruited <@${p.inviteeId}> into **${tribe.shortName || tribe.name}**, and they stuck around! +${recruitment.RECRUITER_TIDES} Tides for the recruiter, +${recruitment.RECRUITER_TREASURY} treasury for the tribe.`, allowedMentions: { users: [p.recruiterId] } }).catch(() => {});
    }
    recruitment.resolvePending(p.inviteeId);
  }
}
// A mod who co-signed another mod's founding request isn't just approving it, they're founding it TOGETHER
// (owner, 2026-08-03: "they are meant to lead it together") — all 3 mods end up as equal co-leaders holding
// the SAME leaderRoleId (a Discord role can hold multiple members; tribeBlock()'s picker line and /tribe info
// already render every current holder, not just one). Skips (with a reason) a cosigner who's already pledged
// to a different tribe, since the one-tribe loyalty rule outranks a co-founding grant.
async function addCoLeader(guild, tribe, leaderRole, member) {
  const existing = tribes.myTribe(member);
  if (existing && existing.key !== tribe.key) return { ok: false, reason: `already in ${existing.shortName || existing.name}` };
  tribes.setMembership(tribe.key, member.id, true);
  const roleOk = await member.roles.add(tribe.roleId, 'Co-founder — co-signed the tribe founding request').then(() => true).catch(() => false);
  const leadOk = leaderRole && await member.roles.add(leaderRole.id, 'Co-founder — co-signed the tribe founding request').then(() => true).catch(() => false);
  if (!roleOk || !leadOk) { tribes.setMembership(tribe.key, member.id, false); return { ok: false, reason: 'role grant failed' }; }
  await syncStaffRank(guild, member, tribe);
  return { ok: true };
}
// The ONE way a member actually leaves a tribe — shared by /tribe banish and an approved /tribe leave-request,
// so both exit paths clean up the SAME state. BUG FIXED 2026-08-03: banish only ever removed the base tribe
// role, leaving a departed member's "General" staff-rank role AND their current rank-ladder role (Initiate/
// Member/Veteran/Elder) still attached — cosmetic (no permissions), but wrong, and would've stuck around
// forever since nothing else ever cleans those up post-departure.
async function releaseTribeMember(guild, tribe, member, reason) {
  tribes.setMembership(tribe.key, member.id, false);   // de-authorize BEFORE removing so the guard honors it
  const ok = await member.roles.remove(tribe.roleId, reason).then(() => true).catch(() => false);
  if (!ok) return { ok: false };
  const strip = [tribe.staffRankRoleId, ...(tribe.ranks || []).map(r => r.roleId)].filter(id => id && member.roles.cache.has(id));
  if (strip.length) await member.roles.remove(strip, reason).catch(() => {});
  return { ok: true };
}
// A war capture is NOT a voluntary join — no veteran/entrance-gate/consent checks apply, the member is just
// moved. Enters the new tribe at rank 0 (fresh start, same as any new join) and gets a capture lock so they
// can't immediately leave-request (or staff-instant-leave) their way back out, undermining the whole point
// of the stakes. See tribes.js's CAPTURE_LOCK_MS for the lock duration.
async function captureMemberInto(guild, winnerTribe, member, reason) {
  const oldTribe = tribes.myTribe(member);
  if (oldTribe) await releaseTribeMember(guild, oldTribe, member, reason).catch(() => {});
  tribes.setMembership(winnerTribe.key, member.id, true);
  await member.roles.add(winnerTribe.roleId, reason).catch(() => {});
  await syncStaffRank(guild, member, winnerTribe);
  tribes.setCaptureLock(member.id, Date.now() + tribes.CAPTURE_LOCK_MS);
}
// Shared by /tribe leave-request AND the Tribes Hub's leave-request button — one implementation so the two
// surfaces can't drift apart (see the retheme/banish drift bugs earlier this session for why that matters).
async function submitLeaveRequest(guild, member) {
  const mine = tribes.myTribe(member);
  if (!mine) return { ok: false, content: 'You’re not in a tribe.' };
  if (tribes.isLeader(member, mine)) return { ok: false, content: 'You’re this tribe’s leader — there’s no one to release you but staff (`/tribe-admin`, or ask an admin).' };
  if (tribes.isCaptureLocked(member.id)) return { ok: false, content: `You were captured in a recent war — can’t request to leave until <t:${Math.floor(tribes.captureLockUntil(member.id) / 1000)}:R>.` };
  if (tribes.getLeaveRequest(member.id)) return { ok: false, content: `Already waiting on a response in <#${mine.throneId}>.` };
  tribes.startLeaveRequest(mine.key, member.id);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribeleave_approve:${member.id}`).setLabel('✅ Release them').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tribeleave_deny:${member.id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger));
  if (mine.throneId) {
    const throne = await guild.channels.fetch(mine.throneId).catch(() => null);
    if (throne) await throneSend(throne, { content: `## 🚪 Leave request\n<@${member.id}> is asking to leave **${mine.shortName || mine.name}**.${mine.leaderRoleId ? ` <@&${mine.leaderRoleId}>` : ''}`, components: [row], allowedMentions: { users: [member.id], roles: mine.leaderRoleId ? [mine.leaderRoleId] : [] } }).catch(() => {});
  }
  return { ok: true, content: `🚪 Sent to ${tribes.leaderTitle(mine)}${mine.throneId ? ` in <#${mine.throneId}>` : ''}. You'll stay in **${mine.shortName || mine.name}** until it's approved.` };
}
// Shared by /tribe join-request AND the Tribes Hub's join-request select menu — self-petition, reuses the
// nomination machinery (nominator === target, see §27 in TRIBE_PHASE5_SPEC.md for why).
async function submitJoinRequest(guild, member, tribe) {
  if (member.roles.cache.has(tribe.roleId)) return { ok: false, content: `You’re already in **${tribe.shortName || tribe.name}**.` };
  if (tribes.myTribe(member)) return { ok: false, content: 'You’re already in a different tribe. Its leader has to release you first.' };
  if (!tribes.isVeteran(member.id)) return { ok: false, content: 'You haven’t pledged before, so your first tribe is a free pick, no approval needed: use the picker in #roles instead.' };
  const existing = tribes.getNomination(member.id);
  if (existing && ['pending_approval', 'pending_accept'].includes(existing.status)) return { ok: false, content: 'You already have a pending request.' };
  if (!tribe.throneId) return { ok: false, content: 'This tribe has no throne channel to route the request through.' };
  const throne = await guild.channels.fetch(tribe.throneId).catch(() => null);
  if (!throne) return { ok: false, content: 'Couldn’t find the throne channel.' };
  tribes.createNomination(tribe.key, member.id, member.id);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribenom_approve:${member.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tribenom_deny:${member.id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger));
  await throneSend(throne, { content: `## 🪶 Join request\n> <@${member.id}> is asking to join **${tribe.shortName || tribe.name}**.\n-# ${tribes.leaderTitle(tribe)} or staff: approve to let them in.`, components: [row], allowedMentions: { users: [member.id] } }).catch(() => {});
  return { ok: true, content: `🪶 Sent to <#${tribe.throneId}> for approval.` };
}
// ---- Shared leader-tool actions — used by BOTH the typed /tribe subcommands and the per-tribe Throne Hub
// buttons (owner, 2026-08-03: "add another hub in each throne"), one implementation each so the two surfaces
// can't drift apart (the exact class of bug this session kept finding: retheme/banish role-cleanup gaps). ----
async function submitInvite(guild, tribe, inviterId, target) {
  if (target.user.bot) return { ok: false, content: 'Bots can’t join tribes.' };
  if (target.roles.cache.has(tribe.roleId)) return { ok: false, content: `<@${target.id}> is already in **${tribe.shortName || tribe.name}**.` };
  const other = tribes.memberTribe(target);
  if (other && other.key !== tribe.key) return { ok: false, content: `<@${target.id}> is already in **${other.shortName || other.name}**. A member can only be in one tribe. Banish them there first.` };
  const existing = tribes.getNomination(target.id);
  if (existing && ['pending_approval', 'pending_accept'].includes(existing.status)) return { ok: false, content: `<@${target.id}> already has a pending nomination or invite.` };
  tribes.createDirectInvite(tribe.key, inviterId, target.id);
  const posted = await postAcceptPrompt(guild, tribe, target.id);
  if (!posted) { tribes.clearNomination(target.id); return { ok: false, content: 'Couldn’t reach #bot-commands to send the invite.' }; }
  return { ok: true, content: `🪶 Sent <@${target.id}> an invite to **${tribe.shortName || tribe.name}**. They’ll join once they accept.` };
}
async function submitBanish(guild, tribe, target, byTag) {
  if (!target.roles.cache.has(tribe.roleId)) return { ok: false, content: `<@${target.id}> isn’t in **${tribe.shortName || tribe.name}**.` };
  if (tribe.leaderRoleId && target.roles.cache.has(tribe.leaderRoleId)) return { ok: false, content: 'You can’t banish the tribe’s leader.' };
  const r = await releaseTribeMember(guild, tribe, target, `Tribe banish by ${byTag}`);
  return r.ok ? { ok: true, content: `✅ Released <@${target.id}> from **${tribe.shortName || tribe.name}**. They can be accepted into a new tribe now.` } : { ok: false, content: 'Couldn’t remove the role. Check my role position.' };
}
async function submitMuster(guild, tribe, callerId) {
  if (tribes.getMuster(tribe.key)) return { ok: false, content: 'A muster is already running for this tribe.' };
  if (tribe.lastMusterAt && Date.now() - tribe.lastMusterAt < MUSTER_COOLDOWN_MS) {
    const nextAt = Math.floor((tribe.lastMusterAt + MUSTER_COOLDOWN_MS) / 1000);
    return { ok: false, content: `This tribe already mustered recently. Next one can go out <t:${nextAt}:R>.` };
  }
  if (!tribe.hallId) return { ok: false, content: 'This tribe has no hall to muster in.' };
  const hall = await guild.channels.fetch(tribe.hallId).catch(() => null);
  if (!hall) return { ok: false, content: 'Couldn’t find the hall channel.' };
  tribes.startMuster(tribe.key, callerId, MUSTER_DURATION_MS);
  const endsAt = Math.floor((Date.now() + MUSTER_DURATION_MS) / 1000);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribemuster_join:${tribe.key}`).setLabel('🪖 I’m here!').setStyle(ButtonStyle.Success));
  const msg = await hall.send({ content: `## 🪖 Muster called!\n<@&${tribe.roleId}>\n> Called by <@${callerId}>. Click below to be counted, ends <t:${endsAt}:R>. Every member who answers earns the tribe treasury and glory.`, components: [row], allowedMentions: { roles: [tribe.roleId], users: [callerId] } }).catch(() => null);
  if (!msg) return { ok: false, content: 'Couldn’t post to the hall.' };
  tribes.setMusterMessage(tribe.key, hall.id, msg.id);
  return { ok: true, content: `🪖 Muster called in <#${hall.id}>. Ends <t:${endsAt}:R>.` };
}
async function applyRetheme(guild, tribe, { color, color2, name, shortName }) {
  const role = guild.roles.cache.get(tribe.roleId);
  if (!role) return { ok: false, content: 'Couldn’t find the tribe role.' };
  const colors = color2 ? { primaryColor: color, secondaryColor: color2 } : { primaryColor: color };
  // Recolour the tribe role, leader role, General, AND every rank role, so a retheme keeps the whole set
  // matched (owner, 2026-08-04: "all ranks themed to match" the tribe).
  const rankRoleObjs = (tribe.ranks || []).map(x => guild.roles.cache.get(x.roleId)).filter(Boolean);
  for (const r of [role, tribe.leaderRoleId && guild.roles.cache.get(tribe.leaderRoleId), tribe.staffRankRoleId && guild.roles.cache.get(tribe.staffRankRoleId), ...rankRoleObjs]) {
    if (!r) continue;
    try { await r.edit({ colors, ...(name && r.id === role.id ? { name } : {}) }); }
    catch { await r.edit({ color, ...(name && r.id === role.id ? { name } : {}) }); }
  }
  const patch = { color, color2 };
  if (name) patch.name = name;
  if (shortName) patch.shortName = shortName;
  tribes.update(tribe.key, patch);
  const fresh = tribes.get(tribe.key);
  if ((name || shortName) && tribe.leaderRoleId) {
    const leaderRole = guild.roles.cache.get(tribe.leaderRoleId);
    if (leaderRole) await leaderRole.setName(`${fresh.shortName || fresh.name} Leader`, 'Tribe retheme: rename to match').catch(() => {});
  }
  if ((name || shortName) && tribe.staffRankRoleId) {
    const staffRankRole = guild.roles.cache.get(tribe.staffRankRoleId);
    if (staffRankRole) await staffRankRole.setName(`${fresh.shortName || fresh.name} ${tribes.DEFAULT_STAFF_RANK_TITLE}`, 'Tribe retheme: rename to match').catch(() => {});
  }
  if ((name || shortName) && config.rolesChannelId) await roleselect.refreshTribeBlock(guild, config.rolesChannelId).catch(() => {});
  await refreshThronePanel(guild, fresh).catch(() => {});
  return { ok: true, content: `🎨 **${fresh.shortName || fresh.name}** has been ${name || shortName ? 'renamed and ' : ''}recoloured.` };
}
// Posts the "do you want to join?" Accept/Decline card — shared by a leader's direct /tribe invite (owner,
// 2026-08-03: "invite should get consent" — skips straight to this, no separate approval needed since the
// leader inviting IS the approval) and an approved member nomination.
// Owner, 2026-08-03: these were getting missed in a busy #bot-commands — DM the target first (quieter, more
// likely to be seen), falling back to the #bot-commands post ONLY if the DM fails (DMs closed from the bot is
// common and fails silently, so this can't be DM-only or some invites would just vanish with no visible sign).
async function postAcceptPrompt(guild, tribe, targetId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribenom_accept:${targetId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tribenom_decline:${targetId}`).setLabel('❌ Decline').setStyle(ButtonStyle.Danger));
  const content = `## 🪶 Tribe invitation\n<@${targetId}>, **${tribe.shortName || tribe.name}** wants you. Join?`;
  const member = await guild.members.fetch(targetId).catch(() => null);
  const dmOk = member && await member.send({ content, components: [row] }).then(() => true).catch(() => false);
  if (dmOk) return true;
  const ch = await guild.channels.fetch(BOT_COMMANDS_CH).catch(() => null);
  if (!ch) return false;
  await ch.send({ content, components: [row], allowedMentions: { users: [targetId] } }).catch(() => {});
  return true;
}
// Build a whole tribe: gradient/solid role + leader role + private "land" category (throne/hall/voice),
// register it in the framework, and return the pieces. Mirrors how the Cobalt Vigil was built by hand.
// The ROLE name stays plain (typeable/mentionable); CHANNELS honor the style option (small-caps default).
async function buildTribe(guild, opts, config) {
  const P = PermissionsBitField.Flags;
  const emoji = opts.emoji || '🏴';
  const small = opts.style !== 'plain';
  const chName = base => `${emoji}┆${small ? toSmallCaps(base) : base}`;
  const rankLabel = base => (small ? toSmallCaps(base) : base);   // rank/staff-rank role names in the server's small-caps font

  // Slot a new tribe directly under the most-recently-founded one, so as more tribes get created they stay
  // visually grouped instead of landing wherever Discord defaults a fresh role/category (the bottom of the
  // list): leader roles cluster near the owner's own roles, tribe roles cluster under Cobalt Vigil, tribe
  // land categories cluster under the prior tribe's. Computed from the EXISTING registered tribes before
  // this one is registered, so each new tribe just appends one slot below the current bottom of its cluster.
  const existingTribes = tribes.all();
  let slotRolePos = null, slotLeaderPos = null, slotCatPos = null;
  if (existingTribes.length) {
    await guild.roles.fetch();
    const roleP = existingTribes.map(t => guild.roles.cache.get(t.roleId)?.position).filter(p => p != null);
    const leadP = existingTribes.map(t => t.leaderRoleId && guild.roles.cache.get(t.leaderRoleId)?.position).filter(p => p != null);
    if (roleP.length) slotRolePos = Math.min(...roleP) - 1;
    if (leadP.length) slotLeaderPos = Math.min(...leadP) - 1;
    const cats = (await Promise.all(existingTribes.map(t => t.categoryId ? guild.channels.fetch(t.categoryId).catch(() => null) : null))).filter(Boolean);
    // Channel/category position is the OPPOSITE convention from role position: higher number = further DOWN
    // the list, so "under the last tribe" means one past the highest existing tribe category position.
    if (cats.length) slotCatPos = Math.max(...cats.map(c => c.rawPosition)) + 1;
  }

  const roleBase = { name: opts.name, hoist: true, mentionable: false, reason: `Tribe: ${opts.name}` };
  const roleColors = opts.color2 ? { primaryColor: opts.color, secondaryColor: opts.color2 } : { primaryColor: opts.color };
  // If the founder holds exactly one clearly personal role, repurpose IT into the tribe role instead of
  // creating a second, redundant one (mirrors how Cobalt Vigil itself was founded — the owner's own personal
  // role was renamed into the tribe role by hand, before this was automated).
  const personalRole = opts.leaderMember ? await findFounderPersonalRole(guild, opts.leaderMember) : null;
  let role;
  if (personalRole) {
    try { role = await personalRole.edit({ ...roleBase, colors: roleColors }); }
    catch { role = await personalRole.edit({ ...roleBase, color: opts.color }); }
  } else {
    try { role = await guild.roles.create({ ...roleBase, colors: roleColors }); }
    catch { role = await guild.roles.create({ ...roleBase, color: opts.color }); }
  }
  if (slotRolePos != null) await role.setPosition(slotRolePos).catch(() => {});
  const leaderRole = await guild.roles.create({ name: `${opts.shortName || opts.name} Leader`, colors: roleColors, mentionable: false, reason: `Tribe leader: ${opts.name}` })
    .catch(() => guild.roles.create({ name: `${opts.shortName || opts.name} Leader`, color: opts.color, mentionable: false, reason: `Tribe leader: ${opts.name}` }).catch(() => null));
  if (leaderRole && slotLeaderPos != null) await leaderRole.setPosition(slotLeaderPos).catch(() => {});
  if (leaderRole && opts.leaderMember) await opts.leaderMember.roles.add(leaderRole.id, 'Tribe leader').catch(() => {});
  // "General" — any staff (mod/admin) who joins as a regular member sits above the whole rank ladder
  // automatically (owner, 2026-08-03). Sits just below the leader role in the hierarchy.
  const staffRankRole = await guild.roles.create({ name: `${emoji} ${rankLabel(`${opts.shortName || opts.name} ${tribes.DEFAULT_STAFF_RANK_TITLE}`)}`, colors: roleColors, mentionable: false, reason: `Tribe staff rank: ${opts.name}` })
    .catch(() => guild.roles.create({ name: `${emoji} ${rankLabel(`${opts.shortName || opts.name} ${tribes.DEFAULT_STAFF_RANK_TITLE}`)}`, color: opts.color, mentionable: false, reason: `Tribe staff rank: ${opts.name}` }).catch(() => null));
  if (staffRankRole && slotLeaderPos != null) await staffRankRole.setPosition(slotLeaderPos).catch(() => {});
  const corner = config.cornerRoleId;
  const deny = corner ? [{ id: corner, deny: [P.ViewChannel] }] : [];
  const leaderAllow = leaderRole ? [{ id: leaderRole.id, allow: [P.ViewChannel] }] : [];
  // Admins (ADMINS-★) and mods (MODS-✰) can see + moderate every tribe's land, not just ones they belong
  // to — oversight, not membership. Trial mods deliberately excluded (owner: "trial mods can stay restricted").
  const staffIds = [opspanel.ADMIN_ROLE_ID, opspanel.MOD_ROLE_ID].filter(Boolean);
  const staffAllow = perms => staffIds.map(id => ({ id, allow: perms }));
  const cat = await guild.channels.create({ name: `${emoji} ${small ? toSmallCaps(opts.shortName || opts.name) : (opts.shortName || opts.name)}`, type: ChannelType.GuildCategory, reason: 'Tribe land',
    permissionOverwrites: [{ id: guild.id, deny: [P.ViewChannel] }, { id: role.id, allow: [P.ViewChannel] }, ...leaderAllow, ...staffAllow([P.ViewChannel]), ...deny] });
  if (slotCatPos != null) await cat.setPosition(slotCatPos).catch(() => {});
  // A tribe can name + set the PURPOSE of its own starter channels at build time (owner: "the land is
  // personalizable in name and purpose"). Falls back to the framework default base name ("throne"/"hall"/
  // "voice") and no topic if the founder skips this step in the guided builder.
  const chNames = opts.channelNames || {};
  const chTopics = opts.channelTopics || {};
  const throne = await guild.channels.create({ name: chName(chNames.throne || 'throne'), type: ChannelType.GuildText, parent: cat.id, topic: chTopics.throne || undefined, permissionOverwrites: [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: role.id, allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions], deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads] },
    ...(leaderRole ? [{ id: leaderRole.id, allow: [P.ViewChannel, P.SendMessages, P.ManageMessages] }] : []),
    ...staffAllow([P.ViewChannel, P.SendMessages, P.ManageMessages]), ...deny] });
  const hall = await guild.channels.create({ name: chName(chNames.hall || 'hall'), type: ChannelType.GuildText, parent: cat.id, topic: chTopics.hall || undefined, permissionOverwrites: [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: role.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AddReactions, P.EmbedLinks, P.AttachFiles, P.UseExternalEmojis, P.UseExternalStickers, P.MentionEveryone] },
    ...(leaderRole ? [{ id: leaderRole.id, allow: [P.ViewChannel, P.SendMessages, P.ManageMessages] }] : []),
    ...staffAllow([P.ViewChannel, P.SendMessages, P.ManageMessages]), ...deny] });
  const vc = await guild.channels.create({ name: chName(chNames.voice || 'voice'), type: ChannelType.GuildVoice, parent: cat.id, permissionOverwrites: [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: role.id, allow: [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD, P.MentionEveryone] },
    ...(leaderRole ? [{ id: leaderRole.id, allow: [P.ViewChannel, P.Connect, P.Speak, P.MuteMembers, P.MoveMembers] }] : []),
    ...staffAllow([P.ViewChannel, P.Connect, P.Speak, P.MuteMembers, P.MoveMembers]), ...deny] });
  // Rank roles (the Initiate -> ... ladder from tribes.RANK_LADDER). Colorless, non-hoisted tags kept at the
  // very bottom of the hierarchy (informational only, no display prominence) — matches how Cobalt Vigil's and
  // Valith's rank roles already look. NOTE: this was previously MISSING entirely — buildTribe() registered a
  // tribe with no `ranks` array, so /tribe rank + auto-promotion silently did nothing for any tribe built
  // through this path (found via Kayena's Cute Crabs, the first tribe actually built end to end this way).
  const rankColors = opts.color2 ? { primaryColor: opts.color, secondaryColor: opts.color2 } : { primaryColor: opts.color };
  const rankRoles = [];
  for (const r of tribes.RANK_LADDER) {
    // Rank roles carry the tribe's colour + emoji (owner, 2026-08-04: "all ranks themed to match" the tribe).
    const rr = await guild.roles.create({ name: `${emoji} ${rankLabel(r.name)}`, colors: rankColors, hoist: false, mentionable: false, reason: `Tribe rank: ${opts.name}` })
      .catch(() => guild.roles.create({ name: `${emoji} ${rankLabel(r.name)}`, color: opts.color, hoist: false, mentionable: false, reason: `Tribe rank: ${opts.name}` }).catch(() => null));
    if (rr) await rr.setPosition(1).catch(() => {});
    rankRoles.push({ ...r, roleId: rr ? rr.id : null });
  }
  const key = (opts.key || opts.shortName || opts.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `tribe-${role.id}`;
  const tribe = tribes.register({ key, name: opts.name, shortName: opts.shortName || opts.name, emoji, color: opts.color, color2: opts.color2 || null,
    pointsName: (opts.pointsName || 'points').slice(0, 20),
    leaderTitle: (opts.leaderTitle || tribes.DEFAULT_LEADER_TITLE).slice(0, 40), ranks: rankRoles,
    roleId: role.id, leaderRoleId: leaderRole ? leaderRole.id : null, staffRankRoleId: staffRankRole ? staffRankRole.id : null,
    categoryId: cat.id, throneId: throne.id, hallId: hall.id, vcId: vc.id, createdAt: Date.now(),
    treasury: STARTING_TREASURY });   // starting bonus so a new tribe can buy its first unlock right away (owner)
  // BUG FIXED 2026-08-03: the leader only ever got leaderRole above, never the tribe's own base role or a
  // `members` entry — found while backfilling co-leaders for a mod-founded tribe. The leader could still see
  // their own land (leaderRole carries its own channel overwrites), but never counted as a tribe member: no
  // Tides earned in the hall, excluded from `/tribe roster` and the member count, not blocked from pledging
  // elsewhere. Confirmed live on both tribes built through this path (Kayena's Cute Crabs, Trib).
  if (opts.leaderMember) {
    tribes.setMembership(tribe.key, opts.leaderMember.id, true);
    await opts.leaderMember.roles.add(role.id, 'Tribe leader — base membership').catch(() => {});
  }
  await postThroneGuide(guild, tribe);
  // Keep #roles' tribe picker in sync — its options are baked in at message-send time, so a newly founded
  // tribe never shows up as a pledge choice on its own without re-rendering that message.
  if (config.rolesChannelId) await roleselect.refreshTribeBlock(guild, config.rolesChannelId).catch(() => {});
  return { tribe, role, leaderRole, cat, throne, hall, vc };
}
// The pinned Throne Hub every tribe's throne gets — a button panel, not just text (owner, 2026-08-03: "add
// another hub in each throne"). Member row is scoped to THIS tribe (no ambiguity, unlike the central hub).
// Leader rows cover every leader-only tool via a picker/modal, gated inside each handler same as the typed
// commands (isLeader || staff). Tribe key is baked into every customId, resolved fresh at click-time so the
// panel never goes stale even if roles/state change.
function tribeThronePanel(tribe) {
  const pts = tribe.pointsName || 'points';
  const title = tribes.leaderTitle(tribe);
  const ranks = (tribe.ranks || []).map(r => r.name).join(' → ') || 'ranks not set up yet';
  const k = tribe.key;
  const ally = tribes.getAlly(tribe.key);
  const onCooldown = tribes.onWarCooldown(tribe);
  const content = `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: what you can do\n`
    + (tribe.motto ? `-# *${tribe.motto}*\n` : '')
    + `\n**Earn ${pts}:** chat in the hall, +1 per message, once a minute. Climb the ranks: ${ranks}. Ranks only ever go up.\n`
    + `-# Staff who join as members automatically hold **${tribes.staffRankTitle(tribe)}**, above the whole ladder.\n`
    + `\n${ally ? `**Allied with ${ally.emoji || '🏴'} ${ally.shortName || ally.name}** — mutual defense in wars, treasury can be gifted between you.` : '_No current alliance._'}`
    + (onCooldown ? `\n-# ⚔️ On war cooldown until <t:${Math.floor(tribes.warCooldownEndsAt(tribe) / 1000)}:R>.` : '')
    + `\n-# Row 1: everyone. Rows 2-4: ${title} or staff only.`
    + (tribe.entranceGate ? `\n-# ⚔️ This tribe gates new applicants: "${tribe.entranceGate.prompt}" (also asked of nominated/invited members before they join).` : '');
  const memberRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribethrone_roster:${k}`).setEmoji('📋').setLabel('Roster').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_leaderboard:${k}`).setEmoji('🏆').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_shop:${k}`).setEmoji('🛒').setLabel('Shop').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_tithe:${k}`).setEmoji('🪙').setLabel('Tithe').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_leave:${k}`).setEmoji('🚪').setLabel('Leave').setStyle(ButtonStyle.Danger));
  const leaderRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribethrone_invite:${k}`).setEmoji('👥').setLabel('Invite').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tribethrone_banish:${k}`).setEmoji('⛔').setLabel('Banish').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tribethrone_note:${k}`).setEmoji('📝').setLabel('Note').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_rank:${k}`).setEmoji('🎖️').setLabel('Set Rank').setStyle(ButtonStyle.Secondary));
  const leaderRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribethrone_retheme:${k}`).setEmoji('🎨').setLabel('Retheme').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tribethrone_announce:${k}`).setEmoji('📣').setLabel('Announce').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tribethrone_motto:${k}`).setEmoji('✍️').setLabel('Motto').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tribethrone_muster:${k}`).setEmoji('🪖').setLabel('Muster').setStyle(ButtonStyle.Primary));
  const leaderRow3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribethrone_war:${k}`).setEmoji('⚔️').setLabel('Declare War').setStyle(ButtonStyle.Danger).setDisabled(onCooldown),
    ally
      ? new ButtonBuilder().setCustomId(`tribethrone_allybreak:${k}`).setEmoji('💔').setLabel('Break Alliance').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId(`tribethrone_alliance:${k}`).setEmoji('🤝').setLabel('Propose Alliance').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tribethrone_allygift:${k}`).setEmoji('🎁').setLabel('Gift Treasury to Ally').setStyle(ButtonStyle.Secondary).setDisabled(!ally));
  // Recognition row (member-facing) — only shown when the achievements feature is enabled.
  const rows = [memberRow, leaderRow1, leaderRow2, leaderRow3];
  if (features.enabled('achievements')) rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribethrone_trophies:${k}`).setEmoji('🏅').setLabel('Trophies').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_halloffame:${k}`).setEmoji('🏛️').setLabel('Hall of Fame').setStyle(ButtonStyle.Secondary)));
  return { content, components: rows, allowedMentions: { parse: [] } };
}
// Post + pin the panel in a tribe's throne. Best-effort (missing throne, send failure, or a pin failure —
// e.g. the channel already has 50 pins — all fail silently rather than blocking tribe creation on it).
async function postThroneGuide(guild, tribe) {
  if (!tribe.throneId) return null;
  const throne = await guild.channels.fetch(tribe.throneId).catch(() => null);
  if (!throne) return null;
  const msg = await throne.send(tribeThronePanel(tribe)).catch(() => null);
  if (msg) await msg.pin().catch(() => {});
  return msg;
}
// Re-render the already-posted/pinned Throne Hub — call after anything that changes what it shows (motto,
// retheme's rename/recolour, entrance gate). Same "find by content, edit in place" pattern as refreshTribeBlock.
async function refreshThronePanel(guild, tribe) {
  if (!tribe.throneId) return false;
  const throne = await guild.channels.fetch(tribe.throneId).catch(() => null);
  if (!throne) return false;
  const pins = await throne.messages.fetchPins().catch(() => null);
  const msg = pins && pins.items.map(p => p.message).find(m => m.content.includes(': what you can do'));
  if (!msg) return false;
  await msg.edit(tribeThronePanel(tribe)).catch(() => {});
  return true;
}
// ---- Tribes Hub (owner, 2026-08-03: "consolidate commands into dashboards and panels because it's getting
// really long") — everything from the original launch announcement, evergreen, plus buttons for the
// no-argument member actions instead of typing them out (Discord's own palette gets awkward with this many
// subcommands under one base command). Leader-only actions that need picking a target (banish/invite/note/
// retheme) stay as typed commands, already reference-listed in each tribe's own pinned throne guide instead.
// Split content/embed on purpose: real @/# mentions must live in message CONTENT to resolve for viewers
// who don't have the channel cached (embeds don't reliably resolve them) — see the "mentions in content not
// embeds" pattern used everywhere else in this bot. The embed description just holds reference text, no
// mentions, so it can carry the FULL detailed writeup (up to 4096 chars) without hitting the 2000-char
// content limit the plain-text version kept bumping into once War & Alliances was added.
function tribeHubContent(guild, config) {
  return `# 🏴 Tribes\nPledge your first tribe in <#${config.rolesChannelId}>. Everything else — standings, your own tribe, joining/leaving, war — is below.`;
}
function tribeHubEmbed() {
  const desc = `**The server's tribe system:** member factions, each with its own private territory, roles, ranks, and economy. Pledge your allegiance, rise through the ranks, represent your people.\n\n`
    + `## What a tribe is\n`
    + `Every tribe has its own hoisted role and colour, a private land (throne, hall, voice), an internal rank ladder, and a leader who runs it (each tribe names its own title, Warden, Warlord, whatever fits).\n\n`
    + `## How tribes are founded\n`
    + `An admin can found a tribe. A mod can found one too, but only backed by **two other mods**, all three lead it together, and a mod-founded tribe must keep **three leaders** to stay standing. Got an idea? Bring it to an admin, or rally two mods.\n\n`
    + `## How to join\n`
    + `Pick a tribe from the Tribes section in #roles. Your **first tribe is a free choice**. After that you can't leave or switch on your own: a tribe's leader must release you (staff can Leave below instantly), and any new tribe has to accept you, by nomination, invite, or your own Join Request below.\n\n`
    + `## Rising through the ranks\n`
    + `Being active in your tribe's hall moves you up its rank ladder automatically (each tribe names its own four rungs), ranks only ever go up, never down. Staff who join as regular members automatically hold **General**, above the whole ladder.\n\n`
    + `## Treasury, Glory, and the Weekly Crown\n`
    + `Activity earns your tribe **Glory** (this week's live standing). Every Sunday at 00:00 UTC, whoever has the most Glory takes the **👑 Weekly Crown**. Glory resets weekly, **Treasury** doesn't, it's the tribe's permanent bank (crown wins, members giving up their own points with \`/tribe offer\`, war raids, ally gifts).\n\n`
    + `## Ages\n`
    + `Time in the tribes is measured in **Ages**, each a named **6-week** chapter (like "The Age of Embers"). Weekly crowns stack up across an age; when it ends, the tribe with the most is named **🏆 Age Champion**, written into the permanent **Hall of Fame**, and wears the reigning-champion role. Then the age's crowns reset and a new age begins, your Treasury, ranks, and unlocks all carry over, so the story continues without erasing anything. See the current age with the **Standings** button and past champions with **Hall of Fame**.\n\n`
    + `## The Shop\n`
    + `Each unlock has a members-OR-crowns-won gate (either path counts) plus a treasury cost: 2nd text channel, re-theme, external sounds, 2nd voice channel, voice quality boost, faster Tides earning, and a **custom tribe icon**. A maxed-out tribe can keep sinking treasury into repeatable Stronghold Tiers for **war defense** (each tier adds defensive power and blunts an enemy raid).\n\n`
    + `## Musters\n`
    + `A leader can call a **muster**, a roll-call in the hall (about once a day). Answer it and the tribe banks treasury + glory for every member who shows up.\n\n`
    + `## War & Alliances\n`
    + `A leader can **Declare War**: your OWN members vote first (24h, needs real turnout and a majority). If it passes, the target tribe's leader can **Accept** and fight, or **Decline** — which triggers a coin flip that decides whether the war happens anyway (ignore the prompt for 24h and the coin flip auto-resolves). A war resolves by a strength simulation weighted by your tribe's Tides (not a guaranteed win, not rank-based), with a 72h cooldown after. The loser gets raided for ~25% treasury and can lose a few regular members for 36h (never the leader, never wiped out) — but a defender's **🏰 Stronghold Tiers** raise its defensive odds and, if it still loses, shrink both the raid and the captures. **Alliances** (capped at 1 per tribe) need your members' vote too, then the other tribe's leader accepts — allies defend each other in wars and can gift treasury to each other.\n\n`
    + `## Challenges — the Arena\n`
    + `The bot runs live cross-tribe games on its own through the day, each announced in the tribe-announcements channel with a **5-minute heads-up** so you can gather. **11 game types** rotate: Reaction Race, Trivia Sprint, Word Scramble, Activity Blitz, Math Sprint, Fast Fingers, Riddle Rush, Emoji Decode, True or False, Reaction Rush, and Number Pattern. When one starts, play in tribe-announcements; the winning tribe banks **Glory + Treasury**. (Staff can also launch one on demand with \`/tribe-admin arena\`.)\n\n`
    + `## Every tribe's Throne\n`
    + `Each tribe's throne channel has its own pinned control panel. Members get Roster / Leaderboard / Shop / Tithe / Leave. Leaders (or staff) get the full toolkit: Invite, Banish, Note, Set Rank, Retheme, Icon, Announce, Motto, Muster, Declare War, and Alliances, click a button instead of typing.\n\n`
    + `-# Use the buttons below instead of typing commands out.`;
  return new EmbedBuilder().setColor(0x2A426A).setDescription(desc.slice(0, 4096));
}
function tribeHubButtons() {
  return [
    // Cross-tribe views — owner, 2026-08-03: "just make a button... that lists the roster or leaderboard
    // for ALL tribes so there's no need for that argument" (replaced /tribe roster's/leaderboard's optional
    // tribe param entirely — this covers "any tribe," your OWN tribe's throne panel covers "just mine").
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tribehub_standings').setEmoji('👑').setLabel('Standings').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('tribehub_allrosters').setEmoji('📋').setLabel('All Rosters').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tribehub_allleaderboards').setEmoji('🏆').setLabel('All Leaderboards').setStyle(ButtonStyle.Secondary)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tribehub_shop').setEmoji('🛒').setLabel('My Shop').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tribehub_join').setEmoji('🪶').setLabel('Join Request').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('tribehub_leave').setEmoji('🚪').setLabel('Leave').setStyle(ButtonStyle.Danger)),
  ];
}
// Idempotent create-or-refresh: makes the channel once, edits the SAME message on every later call (a hub
// content change shouldn't spam a new post — unlike #roles, there's no "(edited)" concern raised for this one).
async function ensureTribesHub(guild, config) {
  let info = tribes.getHubInfo();
  let ch = info && await guild.channels.fetch(info.channelId).catch(() => null);
  if (!ch) {
    ch = await guild.channels.create({
      name: '🏴┆ᴛʀɪʙᴇs-ʜᴜʙ', type: ChannelType.GuildText, topic: 'Tribes reference + one-click actions.',
      permissionOverwrites: [{ id: guild.id, deny: [PermissionsBitField.Flags.SendMessages], allow: [PermissionsBitField.Flags.ViewChannel] }],
      reason: 'Tribes Hub (owner request)',
    });
  }
  const msg = info && info.messageId && await ch.messages.fetch(info.messageId).catch(() => null);
  const payload = { content: tribeHubContent(guild, config), embeds: [tribeHubEmbed()], components: tribeHubButtons(), allowedMentions: { parse: [] } };
  if (msg) { await msg.edit(payload); tribes.setHubInfo(ch.id, msg.id); return { ok: true, channelId: ch.id, messageId: msg.id, created: false }; }
  const sent = await ch.send(payload);
  tribes.setHubInfo(ch.id, sent.id);
  return { ok: true, channelId: ch.id, messageId: sent.id, created: true };
}
// Tribe-announcements channel (owner, 2026-08-04) — sits just ABOVE the hub, everyone can read but not post
// (staff can, for general announcements); the bot posts challenge results here (pinging every tribe). Idempotent.
// Phase 6 spectacle: broadcast a big moment (war result, crowning, season champion) to a public channel so
// lurkers and newcomers see the drama, not just the tribes involved. Falls back to tribe-announcements.
async function getSpectacleChannel(guild) {
  if (config.tribeSpectacleChannelId) { const c = await guild.channels.fetch(config.tribeSpectacleChannelId).catch(() => null); if (c) return c; }
  return ensureTribeAnnounce(guild, config).catch(() => null);
}
async function broadcastSpectacle(guild, content, roleIds = []) {
  const ch = await getSpectacleChannel(guild);
  if (ch) await ch.send({ content, allowedMentions: { roles: roleIds } }).catch(() => {});
}
// Phase 6 catch-up: tribes in the bottom half of the live standings earn a bonus multiplier on event payouts
// so last place can climb back instead of quitting. Neutral (1x) when there are too few tribes to matter.
const UNDERDOG_MULT = 1.5;
function underdogMultiplier(guild, tribeKey) {
  const board = tribes.standings(guild);   // live rank: glory, then treasury, then members
  if (board.length < 3) return 1;
  const idx = board.findIndex(t => t.key === tribeKey);
  if (idx < 0) return 1;
  return idx >= Math.ceil(board.length / 2) ? UNDERDOG_MULT : 1;   // bottom half are underdogs
}
async function ensureTribeAnnounce(guild, config) {
  const info = tribes.getAnnounceInfo();
  let ch = info && await guild.channels.fetch(info.channelId).catch(() => null);
  if (ch) return ch;
  const hubInfo = tribes.getHubInfo();
  const hub = hubInfo && await guild.channels.fetch(hubInfo.channelId).catch(() => null);
  const P = PermissionsBitField.Flags;
  ch = await guild.channels.create({
    name: '📣┆ᴛʀɪʙᴇ-ᴀɴɴᴏᴜɴᴄᴇᴍᴇɴᴛs', type: ChannelType.GuildText, parent: hub?.parentId || undefined,
    topic: 'Tribe-wide announcements + challenge results.',
    permissionOverwrites: [
      { id: guild.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
      ...(config.adminRoleId ? [{ id: config.adminRoleId, allow: [P.SendMessages] }] : []),
      ...(config.modRoleId ? [{ id: config.modRoleId, allow: [P.SendMessages] }] : []),
    ],
    reason: 'Tribe announcements (owner request)',
  });
  if (hub) await ch.setPosition(Math.max(0, hub.position)).catch(() => {});   // slot it just above the hub
  tribes.setAnnounceInfo(ch.id);
  return ch;
}
// ---- Weekly crown cycle (see TRIBE_PHASE5_SPEC.md section 6) ----
// A single server-wide role, granted to every CURRENT member of the highest-Glory tribe each week, stripped
// from whoever held it before. Bragging rights only (owner: "the reward should just be a role/bragging
// rights") — no channel/territory control. Lazily created once and cached in tribe state (self-healing if the
// role is ever deleted by hand — just recreates it).
async function ensureCrownRole(guild) {
  const s = tribes.load();
  if (s.crownRoleId) { const r = guild.roles.cache.get(s.crownRoleId) || await guild.roles.fetch(s.crownRoleId).catch(() => null); if (r) return r; }
  const role = await guild.roles.create({ name: '👑 Tribe Champions', colors: { primaryColor: 0xF1C40F }, hoist: true, mentionable: false, reason: 'Weekly tribe crown' }).catch(() => null);
  if (role) { s.crownRoleId = role.id; tribes.save(s); }
  return role;
}
// Boot catch-up + hourly check (same pattern as the MDNI/dashboard sweeps above) — idempotent via
// tribes.dueForWeeklyCrown, so checking more often than the weekly boundary is harmless.
async function processWeeklyCrownIfDue(guild) {
  if (!guild || !tribes.dueForWeeklyCrown(Date.now())) return;
  tribes.markWeeklyCrownDone(Date.now());   // mark BEFORE doing the work so an overlapping tick can't double-fire
  await ensureMembers(guild);
  const preBoard = tribes.standings(guild);   // capture Glory BEFORE the reset, for the coronation's "fallen rivals"
  const result = tribes.resetWeeklyGlory(guild);
  const crownRole = await ensureCrownRole(guild);
  if (crownRole) for (const m of [...crownRole.members.values()]) await m.roles.remove(crownRole.id, 'Weekly crown reset').catch(() => {});
  if (!result) { console.log('[tribe crown] weekly reset ran; no tribe earned Glory this week, no crown awarded.'); return; }
  const tribe = tribes.get(result.key);
  if (!tribe) return;
  const tribeRole = guild.roles.cache.get(tribe.roleId);
  if (crownRole && tribeRole) for (const m of [...tribeRole.members.values()]) await m.roles.add(crownRole.id, `Weekly crown: ${tribe.key}`).catch(() => {});
  if (features.enabled('achievements') && tribeRole) for (const m of tribeRole.members.values()) achievements.bumpAndCheck(m.id, 'crown');
  if (tribe.throneId) {
    const throne = await guild.channels.fetch(tribe.throneId).catch(() => null);
    if (throne) await throneSend(throne, { content: `## 👑 ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name} takes the Crown!\n> Highest **${result.glory} Glory** this week. +500 treasury banked, now **${tribes.getTreasury(tribe.key)}**. Crowns won: **${tribe.crownsWon || 1}**.\n-# Every current member of the tribe now carries <@&${crownRole?.id}> until next week's crowning.`, allowedMentions: { parse: [] } }).catch(() => {});
  }
  // Spectacle: a staged CORONATION plays out in the public channel (detached, ~10s), reusing the war-show engine.
  const season = tribes.getSeason();
  broadcastCoronation(guild, tribe, result, crownRole, preBoard, season).catch(e => console.error('[coronation]', e.message));
  lore.record({ type: 'crown', title: `${tribe.shortName || tribe.name} took a weekly Crown`, detail: `${result.glory} Glory`, tribes: [tribe.key], age: season?.number });
}
// The weekly crown as a STAGED ceremony (Phase 7, owner: "the Sunday crown becomes a staged sequence").
// Herald -> crown transfer -> fallen rivals acknowledged -> closing proclamation. Public, detached.
async function broadcastCoronation(guild, tribe, result, crownRole, preBoard, season) {
  const ch = await getSpectacleChannel(guild);
  if (!ch) return;
  const emoji = tribe.emoji || '🏴', name = tribe.shortName || tribe.name;
  await ch.send({ content: `# 📯 The week is ended.\nHear ye, hear ye. The Glory of the past seven days is tallied, and a Crown must pass.`, allowedMentions: { parse: [] } }).catch(() => {});
  await warSleep(3000);
  await ch.send({ content: `# 👑 The Crown passes to ${emoji} **${name}**!\nThey stood highest with **${result.glory} Glory**. Every soul of ${name} now wears <@&${crownRole?.id}> until the next crowning.`, allowedMentions: { roles: crownRole ? [crownRole.id] : [], users: [] } }).catch(() => {});
  await warSleep(3000);
  const rivals = (preBoard || []).filter(t => t.key !== tribe.key && (t.glory || 0) > 0).slice(0, 4);
  if (rivals.length) { await ch.send({ content: `-# They did not take it uncontested. ${rivals.map(r => `${r.emoji || '🏴'} ${r.shortName || r.name} (${r.glory})`).join(', ')} pressed them hard.`, allowedMentions: { parse: [] } }).catch(() => {}); await warSleep(2500); }
  await ch.send({ content: `-# Long may ${name} reign. This is their **${tribe.seasonCrowns || 1}** crown of ${season?.name || 'the age'}, one step closer to the 🏆 Age Champion.`, allowedMentions: { parse: [] } }).catch(() => {});
}
// The rotating "reigning Season Champion" role, granted to the champion tribe's members for the next season.
async function ensureSeasonChampionRole(guild) {
  const s = tribes.load();
  if (s.seasonChampRoleId) { const r = guild.roles.cache.get(s.seasonChampRoleId) || await guild.roles.fetch(s.seasonChampRoleId).catch(() => null); if (r) return r; }
  const role = await guild.roles.create({ name: '🏆 Age Champion', colors: { primaryColor: 0xE67E22 }, hoist: true, mentionable: false, reason: 'Tribe Age Champion' }).catch(() => null);
  if (role) { s.seasonChampRoleId = role.id; tribes.save(s); }
  return role;
}
// Boot catch-up + hourly check (like the weekly crown). ensureSeason lazily opens Season 1; when the season
// window passes, endSeasonAndRotate crowns the champion (most weekly crowns this season), records the hall of
// fame, soft-resets season crowns, and opens the next season. Champion gets the rotating role; announced
// publicly in tribe-announcements + the champion's throne (Phase 4 will widen the broadcast).
async function processSeasonEndIfDue(guild) {
  if (!guild) return;
  tribes.ensureSeason(Date.now());
  if (!tribes.dueForSeasonEnd(Date.now())) return;
  await ensureMembers(guild);
  const { previousNumber, previousName, champion, season } = tribes.endSeasonAndRotate(guild, Date.now());
  const champTribe = champion ? tribes.get(champion.key) : null;
  const champRole = await ensureSeasonChampionRole(guild);
  if (champRole) for (const m of [...champRole.members.values()]) await m.roles.remove(champRole.id, 'Age ended, champion rotates').catch(() => {});
  if (champRole && champTribe) { const tr = guild.roles.cache.get(champTribe.roleId); if (tr) for (const m of [...tr.members.values()]) await m.roles.add(champRole.id, `${previousName} champion: ${champTribe.key}`).catch(() => {}); }
  if (features.enabled('achievements') && champTribe) { const tr = guild.roles.cache.get(champTribe.roleId); if (tr) for (const m of tr.members.values()) achievements.bumpAndCheck(m.id, 'season'); }
  const endsAt = Math.floor(season.endsAt / 1000);
  const msg = champion
    ? `# 🏆 ${previousName} ends: ${champTribe?.emoji || '🏴'} **${champion.name}** are its Champion!\nThey took **${champion.crowns}** weekly crown${champion.crowns === 1 ? '' : 's'} across the age and now wear <@&${champRole?.id}>. Their name is written into the Hall of Fame forever.\n**${season.name}** (Age ${season.number}) begins now, running to <t:${endsAt}:D>. The age's crowns reset, so the race is wide open. Treasury, ranks, and unlocks all carry over.`
    : `# 🏁 ${previousName} ends with no Champion.\nNo tribe claimed a weekly crown across the age. **${season.name}** (Age ${season.number}) begins now, running to <t:${endsAt}:D>. Go make history.`;
  await broadcastSpectacle(guild, msg, champTribe ? [champTribe.roleId].filter(Boolean) : []);
  if (champTribe && champTribe.throneId) { const throne = await guild.channels.fetch(champTribe.throneId).catch(() => null); if (throne) await throneSend(throne, { content: msg, allowedMentions: { parse: [] } }).catch(() => {}); }
  lore.record({ type: champion ? 'age_champion' : 'age_end', title: champion ? `${champion.name} won ${previousName}` : `${previousName} ended with no champion`, detail: champion ? `${champion.crowns} crown${champion.crowns === 1 ? '' : 's'} across the age` : '', tribes: champTribe ? [champTribe.key] : [], age: previousNumber, ageName: previousName });
  lore.record({ type: 'age_begin', title: `${season.name} begins`, detail: `Age ${season.number} opens`, age: season.number, ageName: season.name });
  console.log(`[tribe age] ${previousName} (Age ${previousNumber}) ended (champion=${champion ? champion.key : 'none'}); ${season.name} started.`);
}
// Catches "General" (staff auto-rank) drift that join-time syncing alone would miss: a member promoted to
// mod/admin AFTER already being in a tribe, or demoted/banished afterward. Iterates every tribe's current
// role-holders — needs the full member cache, so fetches it once up front rather than per-tribe.
async function sweepStaffRanks(guild) {
  await ensureMembers(guild);
  for (const tribe of tribes.all()) {
    if (!tribe.staffRankRoleId) continue;
    const role = guild.roles.cache.get(tribe.roleId);
    if (!role) continue;
    for (const member of role.members.values()) await syncStaffRank(guild, member, tribe).catch(() => {});
    // also sweep current staffRank holders in case they left the tribe/lost staff without losing THIS role
    const staffRankRole = guild.roles.cache.get(tribe.staffRankRoleId);
    if (staffRankRole) for (const member of staffRankRole.members.values()) await syncStaffRank(guild, member, tribe).catch(() => {});
  }
}
// Count a tribe's current STAFF leaders — holders of the leader role who still hold a staff tier (mod+).
// A leader who lost their mod role (or left the server, dropping the role entirely) stops counting, which
// is exactly the shortfall the requirement below guards against.
function countModLeaders(guild, tribe) {
  const role = tribe.leaderRoleId && guild.roles.cache.get(tribe.leaderRoleId);
  if (!role) return { count: 0, leaders: [] };
  const leaders = [...role.members.values()].filter(m => ['mod', 'admin', 'owner'].includes(opspanel.memberTier(m)));
  return { count: leaders.length, leaders };
}
// Keep each tribe's rank ladder ordered (owner, 2026-08-04: ranks climb ascending, rank4 + General above the
// member role). Permutes ONLY the tribe's own 6 roles (rank1-4, member, General) among the position-slots
// they already occupy, into the order rank1<rank2<rank3<member<rank4<General — so no other server role ever
// moves, and it's a no-op when already correct. This is the maintenance guard against a leader dragging a
// rank role to the wrong side of the member role; the initial even "sprinkle" spacing was done once out-of-band.
async function enforceRankOrder(guild, tribe) {
  const ranks = (tribe.ranks || []).map(r => guild.roles.cache.get(r.roleId)).filter(Boolean);
  const member = guild.roles.cache.get(tribe.roleId);
  const general = tribe.staffRankRoleId && guild.roles.cache.get(tribe.staffRankRoleId);
  if (!member || ranks.length < 4 || !general) return false;
  const ordered = [ranks[0], ranks[1], ranks[2], member, ranks[3], general];   // ascending (bottom->top)
  const slots = ordered.map(r => r.position).sort((a, b) => a - b);
  if (ordered.every((r, i) => r.position === slots[i])) return false;           // already correct
  await guild.roles.setPositions(ordered.map((r, i) => ({ role: r.id, position: slots[i] }))).catch(e => console.error(`[rank-order] ${tribe.key}:`, e.message));
  return true;
}
// A tribe leader must be a mod or admin (owner, 2026-08-04: "take the leader away if the person is no longer
// a mod or admin"). Strip the leader role from any holder who's lost their staff tier — applies to EVERY
// tribe. The guild/bot owner reads as 'owner' tier, so they're never stripped. Returns who was stripped.
async function stripNonStaffLeaders(guild, tribe) {
  const role = tribe.leaderRoleId && guild.roles.cache.get(tribe.leaderRoleId);
  if (!role) return [];
  const stripped = [];
  for (const m of [...role.members.values()]) {
    if (['mod', 'admin', 'owner'].includes(opspanel.memberTier(m))) continue;
    const ok = await m.roles.remove(role.id, 'Tribe leader must be a mod or admin — no longer staff').then(() => true).catch(() => false);
    if (ok) { stripped.push(m); await syncStaffRank(guild, m, tribe).catch(() => {}); }
  }
  return stripped;
}
async function alertModTribe(guild, content, pingRoleId) {
  if (!config.modAnnounceChannelId) return;
  const ch = await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return;
  await ch.send({ content, allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] } }).catch(e => console.error('[leader-req] alert:', e.message));
}
// Enforce the mod-tribe 3-leader requirement (owner: "not a suggestion"). Escalation ladder, driven boot +
// hourly: ok → grace (alert) → frozen (perks blocked) → disband_pending (staff-confirmed dissolution). Any
// return to full strength clears it instantly. Only touches tribes flagged foundedByMod.
async function sweepLeaderRequirement(guild) {
  await ensureMembers(guild);
  const now = Date.now();
  for (const tribe of tribes.all()) {
    // Free-retheme on leader loss (owner: "when a tribe loses a leader they get a free retheme"). For NON-mod
    // tribes, the trigger is a drop in leader-role holders (a leader left). Mod-founded tribes are handled by
    // the grace-entry branch below instead — which also catches a leader who keeps the role but loses mod, so
    // holder-count alone would miss it (and using both would double-grant). First observation just seeds the
    // count (no grant), so an existing tribe isn't handed one on boot.
    // Keep the rank ladder ordered (rank1<rank2<rank3<member<rank4<General) — no-op unless a leader scrambled it.
    if (await enforceRankOrder(guild, tribe)) console.log(`[rank-order] re-sorted ${tribe.key}`);
    // A leader who's no longer a mod/admin loses the leader role first (the shortfall/free-retheme logic below
    // then sees the corrected roster). Applies to every tribe.
    const demoted = await stripNonStaffLeaders(guild, tribe);
    if (demoted.length) await alertModTribe(guild, `👑 Removed the leader role from ${demoted.map(m => `<@${m.id}>`).join(', ')} in ${tribe.emoji || '🏴'} **${tribe.shortName || tribe.name}** — a tribe leader must be a mod or admin.`, tribe.leaderRoleId);
    const leaderRole = tribe.leaderRoleId && guild.roles.cache.get(tribe.leaderRoleId);
    const holderCount = leaderRole ? leaderRole.members.size : 0;
    if (!tribes.isModFounded(tribe) && typeof tribe.lastLeaderCount === 'number' && holderCount < tribe.lastLeaderCount) {
      tribes.grantFreeRetheme(tribe.key);
      await alertModTribe(guild, `🎨 ${tribe.emoji || '🏴'} **${tribe.shortName || tribe.name}** lost a leader — it's been granted a **free retheme** (usable on \`/tribe retheme\` even without the Shop unlock).`, tribe.leaderRoleId);
    }
    if (holderCount !== tribe.lastLeaderCount) tribes.update(tribe.key, { lastLeaderCount: holderCount });
    if (!tribes.isModFounded(tribe)) continue;
    const { count } = countModLeaders(guild, tribe);
    const short = tribes.MIN_MOD_LEADERS - count;
    const enf = tribe.leaderEnforce || null;
    const name = `${tribe.emoji || '🏴'} **${tribe.shortName || tribe.name}**`;
    // Recovered (back to full strength) — clear any enforcement and announce it.
    if (short <= 0) {
      if (enf) {
        tribes.clearLeaderEnforce(tribe.key);
        await alertModTribe(guild, `✅ ${name} is back to **${tribes.MIN_MOD_LEADERS} leaders** — leadership requirement satisfied, any freeze on its perks is lifted.`, tribe.leaderRoleId);
        await refreshThronePanel(guild, tribes.get(tribe.key)).catch(() => {});
      }
      continue;
    }
    // Short-handed. One grace window: alert now, FREEZE perks at the halfway mark, disband-pending at the end.
    if (!enf) {
      const graceUntil = now + tribes.LEADER_GRACE_MS;
      const freezeAt = now + Math.floor(tribes.LEADER_GRACE_MS / 2);
      tribes.setLeaderEnforce(tribe.key, { stage: 'grace', since: now, freezeAt, graceUntil });
      tribes.grantFreeRetheme(tribe.key);   // lost a leader → free retheme (owner), even without the Shop unlock
      await alertModTribe(guild, `⚠️ ${name} is **${short} leader(s) short** (has ${count}/${tribes.MIN_MOD_LEADERS}). A mod-founded tribe must keep ${tribes.MIN_MOD_LEADERS} leaders. Add one with \`/tribe-admin set-leader\`: its perks (war, alliances, shop) **freeze** <t:${Math.floor(freezeAt / 1000)}:R> if unfixed, and it's disband-pending <t:${Math.floor(graceUntil / 1000)}:R>. It's also been granted a **free retheme**. <@&${config.adminRoleId || ''}>`, config.adminRoleId);
    } else if (enf.stage === 'grace' && now >= (enf.freezeAt || 0)) {
      tribes.setLeaderEnforce(tribe.key, { ...enf, stage: 'frozen', frozenAt: now });
      await alertModTribe(guild, `🧊 ${name} is still **${short} leader(s) short** — its perks (war, alliances, shop) are now **frozen**. Fix it with \`/tribe-admin set-leader\` before <t:${Math.floor((enf.graceUntil || now) / 1000)}:R>, or it will be queued for **disband**. <@&${config.adminRoleId || ''}>`, config.adminRoleId);
      await refreshThronePanel(guild, tribes.get(tribe.key)).catch(() => {});
    } else if (enf.stage === 'frozen' && now >= (enf.graceUntil || 0)) {
      tribes.setLeaderEnforce(tribe.key, { ...enf, stage: 'disband_pending', pendingAt: now });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tribedisband_confirm:${tribe.key}`).setEmoji('💥').setLabel('Disband now').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`tribedisband_extend:${tribe.key}`).setEmoji('⏳').setLabel('Give 7 more days').setStyle(ButtonStyle.Secondary));
      await sendModTribeButtons(guild, `💥 ${name} has gone **${tribes.MIN_MOD_LEADERS} leaders short for the full grace + freeze window** and is now **pending disband**. Per the mod-tribe rule it should be dissolved — an admin must confirm (this deletes its roles + channels and cannot be undone), or grant an extension. <@&${config.adminRoleId || ''}>`, [row], config.adminRoleId);
    }
    // stage 'disband_pending' with the confirm still outstanding → nothing to do; wait on the human click.
  }
}
async function sendModTribeButtons(guild, content, components, pingRoleId) {
  if (!config.modAnnounceChannelId) return;
  const ch = await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return;
  await ch.send({ content, components, allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] } }).catch(e => console.error('[leader-req] disband prompt:', e.message));
}
// Closes any muster whose window has passed: pays out, edits the original call-to-arms message (disabling the
// button) if it can still be found, and posts the final tally. Best-effort throughout — a missing channel or
// deleted message never blocks the payout itself, which already happened in tribes.closeMuster.
async function sweepExpiredMusters(guild) {
  const now = Date.now();
  for (const tribe of tribes.all()) {
    const m = tribe.muster;
    if (!m || m.expiresAt > now) continue;
    const result = tribes.closeMuster(tribe.key);
    if (!result) continue;
    lore.record({ type: 'muster', title: `${tribe.shortName || tribe.name} mustered ${result.count} strong`, tribes: [tribe.key], count: result.count });
    // Underdog catch-up bonus (Phase 6): bottom-half tribes earn extra on musters too, not just arenas.
    let reward = result.reward, bonusNote = '';
    const mult = underdogMultiplier(guild, tribe.key);
    if (mult > 1 && result.reward > 0) {
      const extra = Math.round(result.reward * (mult - 1));
      tribes.addTreasury(tribe.key, extra);
      tribes.addGlory(tribe.key, extra);
      reward += extra;
      bonusNote = ` (underdog ×${mult})`;
    }
    const chId = result.channelId || tribe.hallId;
    const ch = chId ? await guild.channels.fetch(chId).catch(() => null) : null;
    const summary = `🪖 Muster ended: **${result.count}** answered the call. **${tribe.shortName || tribe.name}** banks **+${reward}** treasury and **+${reward}** glory${bonusNote}.`;
    if (ch && result.messageId) {
      const orig = await ch.messages.fetch(result.messageId).catch(() => null);
      if (orig) await orig.edit({ components: [] }).catch(() => {});
    }
    if (ch) await ch.send({ content: summary, allowedMentions: { parse: [] } }).catch(() => {});
  }
}
// ---- War & Alliances (Phase 6, 2026-08-03, owner: "add war and alliances at the request of the other
// leaders"). Declaring is a real decision: the proposing tribe's OWN members vote (24h window, ≥30% turnout,
// simple majority) — the target gets no say in whether a war starts. See tribes.js for the state layer,
// power formula (Tides-based, not rank-based — can't be gamed by mass-promoting people), and simulateWar().
// Drop any vote cast by someone who has since LEFT the tribe/server (owner, 2026-08-04: "members aren't
// counted if they've left the server") — a stale vote from a gone member shouldn't sway turnout or the
// majority. Returns a fresh votes object with only current role-holders. Applied everywhere war/alliance
// votes are tallied, so a live count is always what's shown and what decides.
function liveVotes(guild, tribeRoleId, votes) {
  const role = guild.roles.cache.get(tribeRoleId);
  if (!role) return {};
  const out = {};
  for (const [uid, v] of Object.entries(votes || {})) if (role.members.has(uid)) out[uid] = v;
  return out;
}
function voteTallyLine(votes, memberCount, verb) {
  const yes = Object.values(votes).filter(v => v === 'yes').length;
  const no = Object.values(votes).filter(v => v === 'no').length;
  const turnout = Object.keys(votes).length;
  const turnoutPct = memberCount ? Math.round((turnout / memberCount) * 100) : 0;
  return `👍 ${yes} · 👎 ${no} — ${turnout}/${memberCount} voted (${turnoutPct}%, need ${Math.round(tribes.WAR_VOTE_TURNOUT * 100)}%+ turnout and a majority to ${verb})`;
}
// A vote is DECIDED early once the remaining un-voted members can't change the outcome (owner, 2026-08-04:
// "end once the required votes are received" — so it doesn't linger and get buried by chat). Locked-pass:
// turnout requirement already met AND yes leads by more than the votes still outstanding. Locked-fail: no
// leads by enough that yes can never overtake it. Either way the final pass/fail is settled, so resolve now.
function voteLocked(votes, memberCount) {
  const turnout = Object.keys(votes).length;
  if (memberCount > 0 && turnout >= memberCount) return true;            // everyone voted
  const yes = Object.values(votes).filter(v => v === 'yes').length;
  const no = Object.values(votes).filter(v => v === 'no').length;
  const remaining = memberCount - turnout;
  const need = Math.ceil(memberCount * tribes.WAR_VOTE_TURNOUT);
  const lockedPass = turnout >= need && yes > no + remaining;
  const lockedFail = no >= yes + remaining;
  return lockedPass || lockedFail;
}
async function postWarVote(guild, war, attacker, defender) {
  // Post in the THRONE, not the hall (owner, 2026-08-04: hall chat buries the vote; the throne is low-traffic).
  const home = attacker.throneId || attacker.hallId;
  if (!home) return null;
  const throne = await guild.channels.fetch(home).catch(() => null);
  if (!throne) return null;
  const memberCount = guild.roles.cache.get(attacker.roleId)?.members.size ?? 0;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribewar_vote:${war.id}:yes`).setEmoji('⚔️').setLabel('For war').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tribewar_vote:${war.id}:no`).setEmoji('🕊️').setLabel('Against').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribewar_cancel:${war.id}`).setEmoji('🛑').setLabel('Cancel (leader)').setStyle(ButtonStyle.Secondary));
  const endsAt = Math.floor(war.voteEndsAt / 1000);
  const msg = await throneSend(throne, { content: `## ⚔️ War vote\n<@&${attacker.roleId}>\nProposed by <@${war.proposerId}>: declare war on **${defender.emoji || '🏴'} ${defender.shortName || defender.name}**?\nVoting ends <t:${endsAt}:R> (or as soon as the result is locked).\n${voteTallyLine(war.votes, memberCount, 'declare war')}`, components: [row], allowedMentions: { roles: [attacker.roleId] } }).catch(() => null);
  if (msg) tribes.resolveWarRecord(war.id, { channelId: throne.id, messageId: msg.id });
  return msg;
}
// The attacker's internal vote passed. War no longer starts automatically (owner, 2026-08-04: "we should at
// least get permission from the leader"): the DEFENDER's leader gets Accept (fight it out) or Decline (leave
// it to a coin flip). This just posts that consent prompt; executeWar() below does the actual battle.
async function resolveWarVoteRecord(guild, war) {
  const attacker = tribes.get(war.attackerKey), defender = tribes.get(war.defenderKey);
  if (!attacker || !defender) { tribes.resolveWarRecord(war.id, { status: 'failed', resolvedAt: Date.now() }); return; }
  const memberCount = guild.roles.cache.get(attacker.roleId)?.members.size ?? 0;
  const votes = liveVotes(guild, attacker.roleId, war.votes);   // ignore votes from members who've left
  const turnout = Object.keys(votes).length;
  const yes = Object.values(votes).filter(v => v === 'yes').length, no = Object.values(votes).filter(v => v === 'no').length;
  const passed = memberCount > 0 && (turnout / memberCount) >= tribes.WAR_VOTE_TURNOUT && yes > no;
  const editOriginal = async (content, components = []) => {
    if (!war.channelId || !war.messageId) return;
    const ch = await guild.channels.fetch(war.channelId).catch(() => null);
    const msg = ch && await ch.messages.fetch(war.messageId).catch(() => null);
    if (msg) { await msg.edit({ content, components }).catch(() => {}); throneTouch(war.channelId, war.messageId); }
  };
  if (!passed) {
    tribes.resolveWarRecord(war.id, { status: 'failed', resolvedAt: Date.now() });
    await editOriginal(`## ⚔️ War vote failed\n**${attacker.shortName || attacker.name}** did not vote to war **${defender.shortName || defender.name}** (${voteTallyLine(votes, memberCount, 'declare war')}). Nothing happens.`);
    return;
  }
  // Passed — hand it to the defender's leader for consent.
  tribes.resolveWarRecord(war.id, { status: 'awaiting_target', awaitingSince: Date.now() });
  await editOriginal(`## ⚔️ War vote passed\n**${attacker.shortName || attacker.name}**'s members voted for war on **${defender.shortName || defender.name}** (${voteTallyLine(votes, memberCount, 'declare war')}). Waiting on their leader to accept, or leave it to fate.`);
  const dthrone = defender.throneId && await guild.channels.fetch(defender.throneId).catch(() => null);
  if (!dthrone) return executeWar(guild, war);   // no throne to ask through → proceed straight to battle
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribewar_accept:${war.id}`).setEmoji('⚔️').setLabel('Accept the war').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tribewar_declchance:${war.id}`).setEmoji('🎲').setLabel('Decline → coin flip').setStyle(ButtonStyle.Secondary));
  await throneSend(dthrone, { content: `## ⚔️ War declared on ${defender.emoji || '🏴'} **${defender.shortName || defender.name}**\n**${attacker.emoji || '🏴'} ${attacker.shortName || attacker.name}**'s members voted to war you. ${tribes.leaderTitle(defender)} or staff: **Accept** and fight it out, or **Decline** and a coin flip decides whether it happens anyway.`, components: [row], allowedMentions: { roles: defender.leaderRoleId ? [defender.leaderRoleId] : [] } }).catch(() => {});
}
// The actual battle: simulation + every consequence (treasury raid, glory, captured members, cooldowns on both
// sides). Called after the defender accepts, or after a declined-war coin flip lands on "war". `note` prefixes
// the summary (e.g. who accepted / that fate decided). No cooldown on a war that never happened.
async function executeWar(guild, war, note = '') {
  const attacker = tribes.get(war.attackerKey), defender = tribes.get(war.defenderKey);
  if (!attacker || !defender) { tribes.resolveWarRecord(war.id, { status: 'failed', resolvedAt: Date.now() }); return; }
  await ensureMembers(guild).catch(() => {});
  const sim = tribes.simulateWarMatch(guild, attacker, defender);
  const winner = tribes.get(sim.winnerKey), loser = tribes.get(sim.loserKey);
  // Consequences apply IMMEDIATELY (so a restart mid-broadcast never loses them; the live show is theater).
  tribes.addTreasury(sim.winnerKey, sim.raidAmount);
  tribes.addTreasury(sim.loserKey, -sim.raidAmount);
  tribes.addGlory(sim.winnerKey, tribes.WAR_GLORY_BONUS);
  const now = Date.now();
  tribes.update(attacker.key, { lastWarAt: now });
  tribes.update(defender.key, { lastWarAt: now });
  for (const uid of sim.capturedIds) {
    const m = await guild.members.fetch(uid).catch(() => null);
    if (m) await captureMemberInto(guild, winner, m, `Captured in war: ${loser.shortName || loser.name} → ${winner.shortName || winner.name}`).catch(() => {});
  }
  const warName = makeWarName();   // every war is named (Phase 7)
  tribes.resolveWarRecord(war.id, { status: 'resolved', resolvedAt: now, winnerKey: sim.winnerKey, loserKey: sim.loserKey, raidAmount: sim.raidAmount, capturedIds: sim.capturedIds, warName });
  const attackerWon = sim.winnerKey === attacker.key;
  const wScore = attackerWon ? sim.scoreA : sim.scoreD, lScore = attackerWon ? sim.scoreD : sim.scoreA;
  lore.record({ type: 'war', title: `${warName}: ${winner.shortName || winner.name} beat ${loser.shortName || loser.name} ${wScore}-${lScore}`, detail: `decided in ${sim.rounds.length} skirmishes`, tribes: [attacker.key, defender.key], winner: winner.key, warName });
  // War-win achievements for the victors (gated).
  let honorsLine = '';
  if (features.enabled('achievements')) {
    const wRole = guild.roles.cache.get(winner.roleId);
    const honored = [];
    if (wRole) for (const m of wRole.members.values()) for (const a of achievements.bumpAndCheck(m.id, 'warwin')) honored.push(m.id);
    if (honored.length) honorsLine = `\n-# 🏅 New war honors for ${[...new Set(honored)].slice(0, 10).map(id => `<@${id}>`).join(' ')}.`;
  }
  const captureLine = sim.capturedIds.length ? `**${sim.capturedIds.length}** member${sim.capturedIds.length === 1 ? '' : 's'} captured: ${sim.capturedIds.map(id => `<@${id}>`).join(', ')}.` : 'No members captured (loser too small).';
  const wallLine = sim.defWallTiers ? `\n-# 🏰 ${defender.shortName || defender.name}'s Tier-${sim.defWallTiers} stronghold softened the blow: raid held to ${Math.round(sim.raidPct * 100)}%${Math.floor(sim.defWallTiers / 2) ? `, ${Math.floor(sim.defWallTiers / 2)} fewer captured` : ''}.` : '';
  // Concise record posted to both thrones.
  const summary = `${note}## ⚔️ War resolved: ${winner.emoji || '🏴'} ${winner.shortName || winner.name} win ${wScore}-${lScore}!\n${attacker.emoji || '🏴'} **${attacker.shortName || attacker.name}** vs ${defender.emoji || '🏴'} **${defender.shortName || defender.name}**\n> +${sim.raidAmount} treasury raided, +${tribes.WAR_GLORY_BONUS} glory to ${winner.shortName || winner.name}.\n> ${captureLine}${wallLine}${honorsLine}`;
  for (const t of [attacker, defender]) {
    if (!t.throneId) continue;
    const throne = await guild.channels.fetch(t.throneId).catch(() => null);
    if (throne) await throneSend(throne, { content: summary, allowedMentions: { parse: [] } });
  }
  await refreshThronePanel(guild, tribes.get(attacker.key)).catch(() => {});
  await refreshThronePanel(guild, tribes.get(defender.key)).catch(() => {});
  // The GRAND part: a live, narrated battle plays out in the public spectacle channel. Detached (it takes
  // ~20s), so it never blocks the caller/interaction — the outcome above is already committed.
  broadcastWarSpectacle(guild, attacker, defender, winner, loser, sim, { note, wScore, lScore, warName }).catch(e => console.error('[war spectacle]', e.message));
}
// The live, narrated battle broadcast (owner: "grand, like a Madden quicksim"). Hybrid: one live-updating
// scoreboard message + key-moment feed drops (first blood, lead changes, match point, the final blow). The
// outcome is already committed in executeWar; this is pure theater, so a restart mid-show is harmless.
const WAR_EVENTS = ['leads a charge', 'springs an ambush', 'breaches the gate', 'rallies the ranks', 'outflanks the enemy', 'storms the walls', 'holds the line under fire', 'turns the tide', 'crushes the vanguard', 'raids the flank', 'seizes the high ground', 'routs a column'];
// Every war gets a NAME (Phase 7), template-generated so the Chronicle + Hall of Fame read like history.
const WAR_NAME_NOUNS = ['Broken Gate', 'Red Dawn', 'Long Knives', 'Bitter Frost', 'Falling Crown', 'Iron Tide', 'Black Sails', 'Burning Fields', 'Shattered Wall', 'Last Bridge', 'Crimson Hour', 'Sundered Oath', 'Hollow Throne', 'Rising Ash', 'Silent Siege', 'Thousand Spears', 'Ninth Wave', 'Drowned Coast', 'Bleeding Standard', 'Cold Reckoning'];
function makeWarName() { return `The War of the ${WAR_NAME_NOUNS[Math.floor(Math.random() * WAR_NAME_NOUNS.length)]}`; }
const WAR_MVP_TIDES = 20;
const warSleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
function warMomentumBar(sA, sD, target) {
  const total = target * 2 - 1, mid = Math.floor(total / 2);
  const pos = Math.max(0, Math.min(total - 1, mid + (sA - sD)));
  return '▱'.repeat(pos) + '🔥' + '▱'.repeat(total - 1 - pos);
}
async function broadcastWarSpectacle(guild, attacker, defender, winner, loser, sim, meta) {
  const ch = await getSpectacleChannel(guild);
  if (!ch) return;
  const aEmoji = attacker.emoji || '🏴', dEmoji = defender.emoji || '🏴';
  const aName = attacker.shortName || attacker.name, dName = defender.shortName || defender.name;
  const target = tribes.WAR_WIN_ROUNDS;
  const nameOf = id => guild.members.cache.get(id)?.displayName || 'a warrior';
  const aPct = Math.round(sim.attackerWinChance * 100);
  const board = (r, sA, sD, play) => `# ⚔️ ${aEmoji} ${aName}  vs  ${dEmoji} ${dName}\n### Round ${r}\n## ${aEmoji} ${sA}   ${sD} ${dEmoji}\n${warMomentumBar(sA, sD, target)}\n> ${play}`;
  await ch.send({ content: `# ⚔️ ${meta.warName || 'WAR!'}\n${aEmoji} **${aName}** marches on ${dEmoji} **${dName}**. The horns sound, steel is drawn. First to **${target}** skirmishes takes it.\n-# Strength: ${aName} ${aPct}% vs ${dName} ${100 - aPct}%, by Tides + walls.`, allowedMentions: { parse: [] } }).catch(() => {});
  await warSleep(2500);
  const scoreMsg = await ch.send({ content: board(0, 0, 0, 'The battle begins…') }).catch(() => null);
  let sA = 0, sD = 0, mp = false; const tally = {};
  for (let i = 0; i < sim.rounds.length; i++) {
    await warSleep(3000);
    const rr = sim.rounds[i];
    if (rr.side === 'attacker') sA++; else sD++;
    const sEmoji = rr.side === 'attacker' ? aEmoji : dEmoji, side = rr.side === 'attacker' ? attacker : defender;
    if (rr.starId) tally[rr.starId] = (tally[rr.starId] || 0) + 1;
    const play = `${sEmoji} **${nameOf(rr.starId)}** ${WAR_EVENTS[Math.floor(Math.random() * WAR_EVENTS.length)]}!`;
    if (scoreMsg) await scoreMsg.edit({ content: board(i + 1, sA, sD, play) }).catch(() => {});
    if (i === 0) await ch.send({ content: `🩸 **First blood!** ${play}`, allowedMentions: { parse: [] } }).catch(() => {});
    else if (rr.leadChange) await ch.send({ content: `🔄 **Lead change!** ${side.emoji || '🏴'} ${side.shortName || side.name} pulls ahead ${Math.max(sA, sD)}-${Math.min(sA, sD)}.`, allowedMentions: { parse: [] } }).catch(() => {});
    else if (!mp && Math.max(sA, sD) === target - 1 && sA !== sD) { mp = true; const lead = sA > sD ? attacker : defender; await ch.send({ content: `⚡ **Match point** for ${lead.emoji || '🏴'} **${lead.shortName || lead.name}**! One more skirmish to win it all.`, allowedMentions: { parse: [] } }).catch(() => {}); }
  }
  const wEmoji = winner.emoji || '🏴', wName = winner.shortName || winner.name;
  let mvpId = null, mvpN = 0; const wRole = guild.roles.cache.get(winner.roleId);
  for (const [id, n] of Object.entries(tally)) if (wRole?.members.has(id) && n > mvpN) { mvpN = n; mvpId = id; }
  let mvpLine = '';
  if (mvpId) { tribes.addTides(winner.key, mvpId, WAR_MVP_TIDES); mvpLine = `\n-# 🎖️ Battle MVP: <@${mvpId}> won ${mvpN} skirmish${mvpN === 1 ? '' : 'es'}. +${WAR_MVP_TIDES} Tides.`; }
  if (scoreMsg) await scoreMsg.edit({ content: `# 🏆 ${wEmoji} ${wName} WIN!   ${meta.wScore}-${meta.lScore}\n${aEmoji} ${aName}  vs  ${dEmoji} ${dName}\n${warMomentumBar(sA, sD, target)}` }).catch(() => {});
  await warSleep(1500);
  const cap = sim.capturedIds.length ? `Captured **${sim.capturedIds.length}**: ${sim.capturedIds.map(id => `<@${id}>`).join(', ')}.` : 'No captures.';
  const wall = sim.defWallTiers ? ` 🏰 ${dName}'s walls held the raid to ${Math.round(sim.raidPct * 100)}%.` : '';
  const roleIds = [attacker.roleId, defender.roleId].filter(Boolean);
  await ch.send({ content: `# 🏆 ${wEmoji} **${wName}** win ${meta.warName || 'the war'} ${meta.wScore}-${meta.lScore}!\n-# ${meta.warName ? `${meta.warName}, decided in ${sim.rounds.length} skirmishes.` : ''}\n> Raided **+${sim.raidAmount}** treasury and banked **+${tribes.WAR_GLORY_BONUS}** glory. ${cap}${wall}${mvpLine}\n${roleIds.map(r => `<@&${r}>`).join(' ')}`, allowedMentions: { roles: roleIds, users: mvpId ? [mvpId] : [] } }).catch(() => {});
}
async function sweepExpiredWarVotes(guild) {
  for (const war of tribes.expiredWarVotes(Date.now())) await resolveWarVoteRecord(guild, war).catch(e => console.error('[tribe war] resolve:', e.message));
}
// Coin flip that decides a DECLINED (or timed-out) war — 50/50 war vs peace. Shared by the defender's
// Decline button and the 24h stuck-war sweep, so a leader who just ignores the prompt can't veto forever.
async function resolveWarByChance(guild, war, declineNote) {
  const attacker = tribes.get(war.attackerKey), defender = tribes.get(war.defenderKey);
  if (!attacker || !defender) { tribes.resolveWarRecord(war.id, { status: 'failed', resolvedAt: Date.now() }); return { warHappened: false }; }
  const warHappens = Math.random() < 0.5;
  if (warHappens) { await executeWar(guild, war, `-# ${declineNote} Fate chose war.\n`).catch(() => {}); return { warHappened: true }; }
  tribes.resolveWarRecord(war.id, { status: 'failed', resolvedAt: Date.now() });
  const athrone = attacker.throneId && await guild.channels.fetch(attacker.throneId).catch(() => null);
  if (athrone) await throneSend(athrone, { content: `🕊️ Fate spared **${defender.shortName || defender.name}** — the declared war on them fizzled on a coin flip. No battle, no spoils.`, allowedMentions: { parse: [] } }).catch(() => {});
  return { warHappened: false };
}
// A defender who never answers the Accept/Decline prompt shouldn't veto by inaction (owner, 2026-08-04:
// "24 hours"). After 24h in awaiting_target, auto-resolve it via the same coin flip. Boot + hourly.
const WAR_CONSENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
async function sweepStuckWars(guild) {
  const now = Date.now();
  for (const war of Object.values(tribes.load().wars || {})) {
    if (war.status !== 'awaiting_target') continue;
    if (now - (war.awaitingSince || war.resolvedAt || 0) < WAR_CONSENT_TIMEOUT_MS) continue;
    console.log(`[tribe war] consent timed out for ${war.id} (${war.attackerKey}->${war.defenderKey}) — coin flip`);
    await resolveWarByChance(guild, war, `${tribes.get(war.defenderKey)?.shortName || 'The defender'} never answered in 24h;`).catch(e => console.error('[tribe war] stuck resolve:', e.message));
  }
}
async function postAllianceVote(guild, vote, proposer, target) {
  // Post in the THRONE, not the hall (owner, 2026-08-04) — low-traffic, so the vote isn't buried by chat.
  const home = proposer.throneId || proposer.hallId;
  if (!home) return null;
  const throne = await guild.channels.fetch(home).catch(() => null);
  if (!throne) return null;
  const memberCount = guild.roles.cache.get(proposer.roleId)?.members.size ?? 0;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribealliance_vote:${vote.id}:yes`).setEmoji('🤝').setLabel('For alliance').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tribealliance_vote:${vote.id}:no`).setEmoji('❌').setLabel('Against').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribealliance_cancel:${vote.id}`).setEmoji('🛑').setLabel('Cancel (leader)').setStyle(ButtonStyle.Secondary));
  const endsAt = Math.floor(vote.voteEndsAt / 1000);
  const msg = await throneSend(throne, { content: `## 🤝 Alliance vote\n<@&${proposer.roleId}>\nProposed by <@${vote.proposerId}>: propose an alliance with **${target.emoji || '🏴'} ${target.shortName || target.name}**?\nVoting ends <t:${endsAt}:R> (or as soon as the result is locked).\n${voteTallyLine(vote.votes, memberCount, 'propose')}`, components: [row], allowedMentions: { roles: [proposer.roleId] } }).catch(() => null);
  if (msg) tribes.resolveAllianceVoteRecord(vote.id, { channelId: throne.id, messageId: msg.id });
  return msg;
}
async function resolveAllianceVoteRecord(guild, vote) {
  const proposer = tribes.get(vote.proposerKey), target = tribes.get(vote.targetKey);
  if (!proposer || !target) { tribes.resolveAllianceVoteRecord(vote.id, { status: 'failed', resolvedAt: Date.now() }); return; }
  const memberCount = guild.roles.cache.get(proposer.roleId)?.members.size ?? 0;
  const votes = liveVotes(guild, proposer.roleId, vote.votes);   // ignore votes from members who've left
  const turnout = Object.keys(votes).length;
  const yes = Object.values(votes).filter(v => v === 'yes').length, no = Object.values(votes).filter(v => v === 'no').length;
  const passed = memberCount > 0 && (turnout / memberCount) >= tribes.WAR_VOTE_TURNOUT && yes > no;
  const editOriginal = async (content, components = []) => {
    if (!vote.channelId || !vote.messageId) return;
    const ch = await guild.channels.fetch(vote.channelId).catch(() => null);
    const msg = ch && await ch.messages.fetch(vote.messageId).catch(() => null);
    if (msg) { await msg.edit({ content, components }).catch(() => {}); throneTouch(vote.channelId, vote.messageId); }
  };
  if (!passed) {
    tribes.resolveAllianceVoteRecord(vote.id, { status: 'failed', resolvedAt: Date.now() });
    await editOriginal(`## 🤝 Alliance vote failed\n**${proposer.shortName || proposer.name}** did not vote to propose an alliance with **${target.shortName || target.name}** (${voteTallyLine(votes, memberCount, 'propose')}).`);
    return;
  }
  // Internal vote passed — now it's the TARGET tribe's call, mirrors every other cross-tribe consent flow
  // (nominate/invite/join-request) rather than a second full membership vote on their end.
  tribes.resolveAllianceVoteRecord(vote.id, { status: 'awaiting_target' });
  await editOriginal(`## 🤝 Alliance vote passed\n**${proposer.shortName || proposer.name}**'s members voted to propose an alliance with **${target.shortName || target.name}** (${voteTallyLine(votes, memberCount, 'propose')}). Waiting on their response.`);
  if (!target.throneId) return;
  const throne = await guild.channels.fetch(target.throneId).catch(() => null);
  if (!throne) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tribealliance_approve:${vote.id}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tribealliance_deny:${vote.id}`).setLabel('❌ Decline').setStyle(ButtonStyle.Danger));
  await throneSend(throne, { content: `## 🤝 Alliance proposal\n**${proposer.emoji || '🏴'} ${proposer.shortName || proposer.name}**'s members voted to propose an alliance. ${tribes.leaderTitle(target)} or staff: accept?`, components: [row] }).catch(() => {});
}
async function sweepExpiredAllianceVotes(guild) {
  for (const vote of tribes.expiredAllianceVotes(Date.now())) await resolveAllianceVoteRecord(guild, vote).catch(e => console.error('[tribe alliance] resolve:', e.message));
}

// ── Interactive tribe challenges — "the Arena" (owner, 2026-08-04: "add interactive challenges") ──────
// One active challenge at a time. Admin launches one into a public channel; the bot runs + scores it and the
// winning tribe banks Glory + Treasury. In-memory timers (_arenaTimers) drive round advancement / the end;
// on boot, an active challenge is resolved immediately (a restart ends it early) — see reconcileArena.
const ARENA_DEFAULTS = { race: 5, trivia: 6, scramble: 5, blitz: 30, math: 5, typing: 5, riddle: 6, emoji: 5, truefalse: 6, reaction: 4, pattern: 6,
  geoquiz: 6, sciquiz: 6, histquiz: 6, animalquiz: 6, reverse: 5 };   // default minutes per type
const ARENA_LOBBY_MS = 5 * 60000;   // 5-min "get ready" countdown before an arena actually begins (owner)
const _arenaTimers = { start: null, end: null, round: null };
function clearArenaTimers() { for (const k of ['start', 'end', 'round']) if (_arenaTimers[k]) { clearTimeout(_arenaTimers[k]); _arenaTimers[k] = null; } }
// Personal-reward tuning for the arena (Phase 6 daily hook).
const TIDES_PER_ARENA_POINT = 3;      // personal Tides for each point you score in an arena
const ARENA_DAILY_BONUS_TIDES = 10;   // your first arena score of the UTC day
const ARENA_MVP_BONUS_TIDES = 15;     // the event's top scorer
// Award an arena point AND the personal progression that makes the arena a daily hook: the tribe score, a
// per-member score (for MVP), personal Tides, and a once-per-UTC-day bonus that ticks a play streak. Returns
// the tribe's new total (the reaction race reads it). userId may be null (defensive: unknown scorer).
function scoreArena(tribeKey, userId, points = 1) {
  const total = arena.addScore(tribeKey, points);
  if (userId) {
    arena.addMemberScore(userId, points);
    tribes.addTides(tribeKey, userId, TIDES_PER_ARENA_POINT * points);
    const daily = tribes.recordArenaPlay(userId, Date.now());
    if (daily.firstToday) tribes.addTides(tribeKey, userId, ARENA_DAILY_BONUS_TIDES);
    if (features.enabled('achievements')) {   // dark until flipped on
      if (daily.firstToday) for (const a of achievements.checkValue(userId, 'streak', daily.streak)) arena.pushNewAch(userId, a.id);
      for (const a of achievements.checkValue(userId, 'tides', tribes.getTides(tribeKey, userId))) arena.pushNewAch(userId, a.id);
    }
  }
  return total;
}
const ARENA_ALL_TYPES = ['race', 'trivia', 'scramble', 'blitz', 'math', 'typing', 'riddle', 'emoji', 'truefalse', 'reaction', 'pattern',
  'geoquiz', 'sciquiz', 'histquiz', 'animalquiz', 'reverse'];
// Downtime runs only calm, low-interaction, async-friendly games (no reflex/crowd types like reaction race).
const DOWNTIME_TYPES = ['blitz', 'riddle', 'scramble', 'emoji', 'reverse'];
const DOWNTIME_TREASURY_MULT = 2;   // downtime wins bank 2x Treasury but NO Glory: reward night owls, protect the crown
// Which arena mode are we in right now, in the configured timezone? 'peak' (full slate, all types, tribe pings),
// 'downtime' (calm low-ping games, bonus treasury/no glory), or 'dead' (no events — the pre-dawn lull).
function arenaMode() {
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: config.arenaAutoTimezone, hour: '2-digit', hour12: false }));
  if (hour >= config.arenaAutoStartHour && hour < config.arenaAutoEndHour) return 'peak';
  if (hour >= config.arenaDowntimeStartHour && hour < config.arenaDowntimeEndHour) return 'downtime';
  return 'dead';
}
// Auto-start (owner: "have the bot start them randomly"). Called on a ~15-min tick: pick the mode; if dead do
// nothing; otherwise, if nothing's running, under the daily cap, and the randomly-scheduled next-auto time has
// passed, launch a random type (calm subset in downtime). recordEnd schedules the next one with a mode-aware
// random gap (1h..2h peak, 2h..3.5h downtime). Manual starts still work anytime (subject to the 1h floor).
async function maybeAutoStartArena(guild) {
  if (!config.arenaAutoStart) return;
  const mode = arenaMode();
  if (mode === 'dead') return;
  if (arena.startBlocked()) return;        // already running/lobby, under the 1h floor, or daily cap reached
  if (!arena.autoStartDue(Date.now())) return;   // the randomly-scheduled next-auto time hasn't arrived yet
  const downtime = mode === 'downtime';
  const pool = downtime ? DOWNTIME_TYPES : ARENA_ALL_TYPES;
  const type = pool[Math.floor(Math.random() * pool.length)];
  try { await startArenaCountdown(guild, type, ARENA_DEFAULTS[type] || 5, client.user.id, downtime); console.log(`[arena] auto-started ${type}${downtime ? ' (downtime)' : ''}`); }
  catch (e) { console.error('[arena] auto-start:', e.message); }
}

async function arenaChannel(guild) { const a = arena.get(); if (!a) return null; return guild.channels.fetch(a.channelId).catch(() => null); }
function tribeName(key) { const t = tribes.get(key); return t ? `${t.emoji || '🏴'} ${t.shortName || t.name}` : key; }

// A challenge no longer starts the instant the button is clicked. Instead we announce a 5-minute "get ready"
// LOBBY (owner) — a general ping in tribe-announcements + a per-tribe heads-up in each throne — then beginArena
// actually launches the game. The lobby throne pings double as the event pings and are cleaned up at endArena.
async function startArenaCountdown(guild, type, minutes, startedById, downtime = false) {
  const channel = await ensureTribeAnnounce(guild, config);
  if (!channel) throw new Error('no tribe-announcements channel');
  const startsAt = Date.now() + ARENA_LOBBY_MS;
  const label = ARENA_LABEL[type] || type;
  const roleIds = tribes.all().map(t => t.roleId).filter(Boolean);
  // General heads-up in tribe-announcements, pinging every tribe so the whole server can gather in time.
  const lobby = await channel.send({
    content: `# 🎪 ${label} — starting soon!\nGet ready: a **${label}** arena begins <t:${Math.floor(startsAt / 1000)}:R> (in about ${Math.round(ARENA_LOBBY_MS / 60000)} minutes). Round up your tribe and be here in <#${channel.id}> when it starts.\n${roleIds.map(r => `<@&${r}>`).join(' ')}`,
    allowedMentions: { roles: roleIds },
  }).catch(() => null);
  // Per-tribe heads-up in each throne (stored; endArena deletes them). These double as the event pings.
  const thronePings = {};
  for (const t of tribes.all()) {
    if (!t.throneId || !t.roleId) continue;
    const throne = await guild.channels.fetch(t.throneId).catch(() => null);
    if (!throne) continue;
    const p = await throne.send({ content: `🎪 <@&${t.roleId}> — a **${label}** arena begins <t:${Math.floor(startsAt / 1000)}:R>! Get ready and gather in <#${channel.id}>.`, allowedMentions: { roles: [t.roleId] } }).catch(() => null);
    if (p) thronePings[t.key] = { channelId: t.throneId, messageId: p.id };
  }
  arena.set({ type, minutes, phase: 'lobby', channelId: channel.id, startedBy: startedById, startsAt, downtime,
    lobbyMessageId: lobby ? lobby.id : null, thronePings, scores: {}, participants: [] });
  _arenaTimers.start = setTimeout(() => beginArena(guild).catch(e => console.error('[arena] begin:', e.message)), ARENA_LOBBY_MS);
  return arena.get();
}

// Actually launch the game once the 5-min lobby elapses (or on boot if it lapsed while the bot was down).
// Reads the pending lobby state, posts the game in tribe-announcements, and flips the heads-up pings to LIVE.
async function beginArena(guild) {
  const pending = arena.get();
  if (!pending || pending.phase !== 'lobby') return;   // nothing waiting, or already live
  const { type } = pending;
  const minutes = pending.minutes || ARENA_DEFAULTS[type] || 5;
  const label = ARENA_LABEL[type] || type;
  const thronePings = pending.thronePings || {};
  const channel = await guild.channels.fetch(pending.channelId).catch(() => null) || await ensureTribeAnnounce(guild, config);
  if (!channel) { console.error('[arena] begin: no tribe-announcements channel'); return; }
  if (arena.TYPED_TYPES.includes(type)) await channel.permissionOverwrites.edit(guild.id, { SendMessages: true }, { reason: 'arena typed round: allow answers' }).catch(() => {});
  const endsAt = Date.now() + minutes * 60000;
  // Preserve the lobby-created state (throne pings, lobby message, base scores) into the LIVE state.
  const base = { type, minutes, phase: 'live', channelId: channel.id, startedBy: pending.startedBy,
    startedAt: Date.now(), endsAt, scores: pending.scores || {}, participants: pending.participants || [],
    thronePings, lobbyMessageId: pending.lobbyMessageId || null, downtime: pending.downtime || false };
  if (type === 'race') {
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('arena_claim').setEmoji('🏁').setLabel('Claim for your tribe!').setStyle(ButtonStyle.Success));
    const msg = await channel.send({ content: `# 🏁 Reaction Race!\nFirst tribe to **${arena.RACE_TARGET}** claims wins **+${arena.WIN_GLORY} Glory / +${arena.WIN_TREASURY} Treasury**. One claim per member. Ends <t:${Math.floor(endsAt / 1000)}:R> if nobody hits the target.\n\n${arenaScoreboard({ ...base })}`, components: [row] });
    arena.set({ ...base, messageId: msg.id });
  } else if (type === 'blitz') {
    const msg = await channel.send({ content: `# ⚡ Activity Blitz!\nFor the next **${minutes} minutes**, every message you send **anywhere in the server** scores a point for your tribe. The most active tribe wins **+${arena.WIN_GLORY} Glory / +${arena.WIN_TREASURY} Treasury**. Ends <t:${Math.floor(endsAt / 1000)}:R>. Go!` });
    arena.set({ ...base, messageId: msg.id });
  } else if (arena.TYPED_TYPES.includes(type)) {
    // Typed types (scramble/math/typing/riddle/emoji): post a prompt; the messageCreate hook scores the first
    // correct typed answer and advances to a fresh prompt, repeating until the end timer fires.
    const nx = arena.nextTyped(type, []);
    const st = { ...base, answer: nx.answer, display: nx.display, used: [nx.key], round: 1 };
    const msg = await channel.send({ content: typedContent(type, st) });
    arena.set({ ...st, messageId: msg.id });
  } else if (arena.BUTTON_TYPES.includes(type)) {
    // Button types (trivia/truefalse/pattern) share the questions[] + askNextTrivia + arena_ans flow. Online
    // types pre-fetch the whole batch at launch (owner: "virtually infinite") with a local fallback; generated
    // types (pattern) build the batch locally — either way it's a questions array of {q, options, answer}.
    let questions = [], source = 'local';
    if (type === 'truefalse') { const f = await arena.fetchBoolean(arena.TF_QUESTIONS); questions = (f && f.length) ? f : arena.localBoolean(arena.TF_QUESTIONS); source = f ? 'online' : 'local'; }
    else if (type === 'pattern') { questions = arena.genPattern(arena.PATTERN_QUESTIONS); source = 'generated'; }
    else { const cat = arena.TRIVIA_CATEGORY[type]; const f = await arena.fetchTrivia(arena.TRIVIA_QUESTIONS, cat); questions = (f && f.length) ? f : arena.localTrivia(arena.TRIVIA_QUESTIONS, []); source = f ? 'online' : 'local'; }   // trivia + themed quizzes
    arena.set({ ...base, questions, qNum: 0, source });
    await askNextTrivia(guild);
  } else if (type === 'reaction') {
    // Reaction Rush: each round targets one emoji; the messageReactionAdd hook scores the first tribe member
    // to react and posts the next round. postReactionRound handles both the first round and each advance.
    arena.set({ ...base, used: [], round: 0 });
    await postReactionRound(guild);
  }
  // Flip the per-tribe heads-up pings to "LIVE now — play!".
  for (const [k, p] of Object.entries(thronePings)) {
    const t = tribes.resolve(k);
    const tch = await guild.channels.fetch(p.channelId).catch(() => null);
    const pm = tch && await tch.messages.fetch(p.messageId).catch(() => null);
    if (pm) await pm.edit({ content: `🎪 ${t && t.roleId ? `<@&${t.roleId}> ` : ''}— the **${label}** arena is **LIVE now** in <#${channel.id}>! Play and score for your tribe. Ends <t:${Math.floor(endsAt / 1000)}:R>.`, allowedMentions: { roles: t && t.roleId ? [t.roleId] : [] } }).catch(() => {});
  }
  // Flip the general lobby announcement to "LIVE now".
  if (base.lobbyMessageId) {
    const lm = await channel.messages.fetch(base.lobbyMessageId).catch(() => null);
    if (lm) await lm.edit({ content: `# 🎪 ${label} — LIVE now!\nThe arena has begun in <#${channel.id}>. Play and score for your tribe — ends <t:${Math.floor(endsAt / 1000)}:R>.`, allowedMentions: { parse: [] } }).catch(() => {});
  }
  _arenaTimers.end = setTimeout(() => endArena(guild).catch(e => console.error('[arena] end:', e.message)), minutes * 60000);
  return arena.get();
}
const ARENA_LABEL = { race: 'Reaction Race', trivia: 'Trivia Sprint', scramble: 'Word Scramble', blitz: 'Activity Blitz',
  math: 'Math Sprint', typing: 'Fast Fingers', riddle: 'Riddle Rush', emoji: 'Emoji Decode', truefalse: 'True or False', reaction: 'Reaction Rush', pattern: 'Number Pattern',
  geoquiz: 'Geography Quiz', sciquiz: 'Science Quiz', histquiz: 'History Quiz', animalquiz: 'Animal Quiz', reverse: 'Reverse Word' };
function arenaScoreboard(a) {
  const rows = Object.entries(a.scores || {}).sort((x, y) => y[1] - x[1]);
  return rows.length ? rows.map(([k, v]) => `> ${tribeName(k)} — **${v}**`).join('\n') : '> _No points yet._';
}
// Render the current prompt for any TYPED type (scramble/math/typing/riddle/emoji). `a.display` is the prompt
// payload (word for scramble, expression for math, phrase for typing, question for riddle, emojis for emoji).
function typedContent(type, a) {
  const sb = arenaScoreboard(a);
  const r = a.round || 1;
  if (type === 'math') return `# ➗ Math Sprint — round ${r}\nFirst tribe member to **type the answer** in this channel scores:\n## \`${a.display}\`\n\n${sb}`;
  if (type === 'typing') return `# ⌨️ Fast Fingers — round ${r}\nFirst to **type this exactly** (spelling counts) scores for their tribe:\n## \`${a.display}\`\n\n${sb}`;
  if (type === 'riddle') return `# 🧩 Riddle Rush — round ${r}\nFirst correct **typed** answer scores for their tribe:\n> ${a.display}\n\n${sb}`;
  if (type === 'emoji') return `# 🧠 Emoji Decode — round ${r}\nWhat do these emojis spell? **Type** your answer:\n## ${a.display}\n\n${sb}`;
  if (type === 'reverse') return `# 🔁 Reverse Word — round ${r}\nThis word is backwards. **Type it the right way** to score:\n## \`${a.display}\`\n\n${sb}`;
  return `# 🔤 Word Scramble — round ${r}\nUnscramble and **type the word** in this channel:\n## \`${arena.scrambleWord(a.display).toUpperCase()}\`\nFirst tribe member to get it scores for their tribe.\n\n${sb}`;
}
// Reaction Rush: post the next round — a message asking players to click the target emoji, with the bot
// pre-adding it so it's one tap. Storing the round # lets a late reaction on an old round be ignored.
async function postReactionRound(guild) {
  const a = arena.get(); if (!a || a.type !== 'reaction') return;
  const ch = await arenaChannel(guild); if (!ch) return;
  const target = arena.nextReaction(a.used || []);
  const round = (a.round || 0) + 1;
  const msg = await ch.send({ content: `# ⚡ Reaction Rush — round ${round}\nFirst tribe member to react with ${target} scores for their tribe. Go!\n\n${arenaScoreboard(a)}` }).catch(() => null);
  if (!msg) return;
  arena.update({ messageId: msg.id, target, round, used: [...(a.used || []), target].slice(-12), reactionOpen: true });
  await msg.react(target).catch(() => {});
}
// Tally an Activity Blitz from message history over [startMs, endMs] (owner: count at the end, not live).
// A message anywhere by a tribe member scores for their tribe, with the same 8s per-member cooldown. Because
// it reads history, it's zero per-message overhead AND immune to restarts mid-blitz. Returns {tribeKey: n}.
async function computeBlitzScores(guild, startMs, endMs) {
  await ensureMembers(guild).catch(() => {});
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return { scores: {}, memberCounts: {} };
  const hits = [];
  for (const ch of channels.values()) {
    if (!ch || ![0, 5].includes(ch.type)) continue;   // text + announcement channels
    let before, done = false;
    for (let b = 0; b < 5 && !done; b++) {             // up to 500 msgs back per channel
      const msgs = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!msgs || !msgs.size) break;
      for (const m of msgs.values()) {
        const ts = m.createdTimestamp;
        if (ts < startMs) { done = true; continue; }
        if (ts > endMs || m.author.bot) continue;
        const mem = m.member || guild.members.cache.get(m.author.id);
        const mine = mem && tribes.memberTribe(mem);
        if (mine) hits.push({ ts, key: mine.key, uid: m.author.id });
      }
      before = msgs.last().id;
      if (msgs.size < 100) break;
    }
  }
  hits.sort((a, b) => a.ts - b.ts);
  const last = new Map(), scores = {}, memberCounts = {};
  for (const h of hits) {
    const k = `${h.key}:${h.uid}`;
    if (last.get(k) > h.ts - 8000) continue;
    last.set(k, h.ts);
    scores[h.key] = (scores[h.key] || 0) + 1;
    if (!memberCounts[h.uid]) memberCounts[h.uid] = { key: h.key, n: 0 };
    memberCounts[h.uid].n += 1;
  }
  return { scores, memberCounts };
}
async function askNextTrivia(guild) {
  const a = arena.get(); if (!a || !arena.BUTTON_TYPES.includes(a.type)) return;
  // Lock the previous question so a late click (or the 25s timeout advancing) can't score a stale question.
  if (a.messageId) { const pch = await arenaChannel(guild); const pm = pch && await pch.messages.fetch(a.messageId).catch(() => null); if (pm) await pm.edit({ components: [] }).catch(() => {}); }
  const questions = a.questions || [];
  if (a.qNum >= questions.length) return endArena(guild);
  const q = questions[a.qNum];
  const row = new ActionRowBuilder().addComponents(q.options.map((o, i) =>
    new ButtonBuilder().setCustomId(`arena_ans:${i}`).setLabel(String(o).slice(0, 80) || '?').setStyle(ButtonStyle.Secondary)));
  const ch = await arenaChannel(guild); if (!ch) return;
  const qLabel = ARENA_LABEL[a.type] || 'Trivia';
  const msg = await ch.send({ content: `# ❓ ${qLabel} — Q${a.qNum + 1}/${questions.length}\n**${q.q}**\nFirst correct answer scores for your tribe.\n\n${arenaScoreboard(a)}`, components: [row] });
  arena.update({ answer: q.answer, qNum: a.qNum + 1, messageId: msg.id, answeredThisQ: [] });
  if (_arenaTimers.round) clearTimeout(_arenaTimers.round);
  _arenaTimers.round = setTimeout(() => askNextTrivia(guild).catch(() => {}), 25000);   // 25s per question, then advance
}
async function endArena(guild) {
  clearArenaTimers();
  let a = arena.get(); if (!a) return;
  // Blitz is tallied now, from message history over the whole window (owner: count at the end). Per-member
  // counts also drive personal Tides + the MVP, same as the interactive types earn via scoreArena.
  if (a.type === 'blitz') {
    const { scores, memberCounts } = await computeBlitzScores(guild, a.startedAt, a.endsAt).catch(() => ({ scores: {}, memberCounts: {} }));
    const ms = {};
    for (const [uid, info] of Object.entries(memberCounts)) {
      ms[uid] = info.n;
      tribes.addTides(info.key, uid, TIDES_PER_ARENA_POINT * info.n);
      const daily = tribes.recordArenaPlay(uid, Date.now());
      if (daily.firstToday) tribes.addTides(info.key, uid, ARENA_DAILY_BONUS_TIDES);
    }
    arena.update({ scores, memberScores: ms }); a = arena.get();
  }
  const win = arena.winner();
  const ch = await arenaChannel(guild);
  const label = ARENA_LABEL[a.type] || 'challenge';
  // Remove the per-throne start pings now that the event is over.
  for (const p of Object.values(a.thronePings || {})) {
    const tch = await guild.channels.fetch(p.channelId).catch(() => null);
    const pm = tch && await tch.messages.fetch(p.messageId).catch(() => null);
    if (pm) await pm.delete().catch(() => {});
  }
  // Remove the general "starting soon / LIVE now" lobby announcement too (the result post replaces it).
  if (a.lobbyMessageId && ch) { const lm = await ch.messages.fetch(a.lobbyMessageId).catch(() => null); if (lm) await lm.delete().catch(() => {}); }
  // Re-lock the announcements channel if a scramble had opened it for typing.
  if (arena.TYPED_TYPES.includes(a.type) && ch) await ch.permissionOverwrites.edit(guild.id, { SendMessages: false }, { reason: 'arena typed round over: re-lock' }).catch(() => {});
  const dt = !!a.downtime;   // downtime economy: bonus Treasury, but NO Glory (protects the peak-hours crown race)
  let resultText;
  if (win) {
    const mult = underdogMultiplier(guild, win.key);
    const treas = Math.round(arena.WIN_TREASURY * mult * (dt ? DOWNTIME_TREASURY_MULT : 1));
    const glory = dt ? 0 : Math.round(arena.WIN_GLORY * mult);
    tribes.addTreasury(win.key, treas);
    if (glory) tribes.addGlory(win.key, glory);
    const notes = [];
    if (mult > 1) notes.push(`underdog ×${mult}`);
    if (dt) notes.push(`downtime treasury ×${DOWNTIME_TREASURY_MULT}, no Glory`);
    const bonusNote = notes.length ? ` (${notes.join('; ')})` : '';
    resultText = `# 🏆 ${label}: ${tribeName(win.key)} wins!\nScored **${win.score}**. Banked **+${treas} Treasury**${glory ? ` and **+${glory} Glory**` : ''}${bonusNote}.\n\n${arenaScoreboard(a)}`;
    { const wt = tribes.get(win.key); lore.record({ type: 'arena', title: `${wt?.shortName || wt?.name || win.key} won a ${label}`, tribes: [win.key], score: win.score }); }
    await refreshThronePanel(guild, tribes.get(win.key)).catch(() => {});
  } else {
    resultText = `# 🏁 ${label} over\nNo tribe scored, no reward this time.`;
  }
  // MVP: the event's top individual scorer gets a bonus + a shout (personal recognition drives retention).
  let mvpLine = '', mvpId = null;
  const mvp = arena.topMemberScorer();
  if (mvp && mvp.score > 0) {
    mvpId = mvp.userId;
    const mvpMember = await guild.members.fetch(mvp.userId).catch(() => null);
    const mvpTribe = mvpMember && tribes.memberTribe(mvpMember);
    if (mvpTribe) tribes.addTides(mvpTribe.key, mvp.userId, ARENA_MVP_BONUS_TIDES);
    if (features.enabled('achievements')) for (const a of achievements.bumpAndCheck(mvp.userId, 'mvp')) arena.pushNewAch(mvp.userId, a.id);
    const streak = tribes.getArenaStreak(mvp.userId);
    mvpLine = `\n-# 🥇 MVP: <@${mvp.userId}> with **${mvp.score}** point${mvp.score === 1 ? '' : 's'} (+${ARENA_MVP_BONUS_TIDES} Tides)${streak > 1 ? `, on a ${streak}-day streak 🔥` : ''}. Every scorer banked Tides toward their rank.`;
  }
  // Achievement unlocks earned this event (gated by the `achievements` flag; empty when off).
  let achLine = '', achUsers = [];
  if (features.enabled('achievements')) {
    const na = arena.getNewAch();
    if (na.length) {
      achLine = '\n-# 🏅 Unlocked: ' + na.map(x => { const a = achievements.byId(x.id); return `<@${x.u}> ${a ? `${a.emoji} ${a.name}` : x.id}`; }).join(' · ');
      achUsers = [...new Set(na.map(x => x.u))];
    }
  }
  // Result in the tribe-announcements channel (where it ran), pinging every tribe (and the MVP).
  if (ch) {
    const roleIds = tribes.all().map(t => t.roleId).filter(Boolean);
    const users = [...new Set([...(mvpId ? [mvpId] : []), ...achUsers])];
    const mentions = { roles: roleIds }; if (users.length) mentions.users = users;
    await ch.send({ content: `${resultText}${mvpLine}${achLine}\n${roleIds.map(r => `<@&${r}>`).join(' ')}`, allowedMentions: mentions }).catch(() => {});
  }
  arena.recordEnd(Date.now(), dt);   // stamp end + schedule the next auto (longer gap if downtime)
  arena.clear();
}
// Called on boot: an active challenge from before a restart is ended immediately (a restart ends it early)
// so it can't get stuck, and any dangling timer is cleared.
async function reconcileArena(guild) {
  const a = arena.get();
  if (!a) return;
  // Lobby (pre-start countdown) in progress: begin now if the 5-min window already elapsed while we were down,
  // otherwise re-arm the start timer for whatever's left (owner: a restart mustn't drop a scheduled arena).
  if (a.phase === 'lobby') {
    if (Date.now() >= (a.startsAt || 0)) { console.log('[arena] lobby countdown elapsed during downtime — starting now'); return beginArena(guild).catch(e => console.error('[arena] boot begin:', e.message)); }
    const wait = a.startsAt - Date.now();
    console.log(`[arena] resuming lobby countdown (${Math.round(wait / 1000)}s left)`);
    _arenaTimers.start = setTimeout(() => beginArena(guild).catch(e => console.error('[arena] begin:', e.message)), wait);
    return;
  }
  // If the window already passed while the bot was down, resolve it. Otherwise CONTINUE the live challenge
  // (owner: a restart must not kill a real event) — re-arm the end timer and re-announce that it's still on.
  if (Date.now() >= a.endsAt) {
    console.log('[arena] challenge window already passed on boot — resolving');
    return endArena(guild).catch(e => console.error('[arena] boot resolve:', e.message));
  }
  console.log('[arena] resuming live challenge after restart');
  const remaining = a.endsAt - Date.now();
  const channel = await guild.channels.fetch(a.channelId).catch(() => null);
  if (channel) {
    const roleIds = tribes.all().map(t => t.roleId).filter(Boolean);
    const line = a.type === 'blitz'
      ? `# ⚡ Activity Blitz — still on!\nEvery message you send **anywhere in the server** scores for your tribe. Ends <t:${Math.floor(a.endsAt / 1000)}:R>.`
      : `▶️ The **${ARENA_LABEL[a.type] || a.type}** is still running — ends <t:${Math.floor(a.endsAt / 1000)}:R>.`;
    await channel.send({ content: `${line}\n${roleIds.map(r => `<@&${r}>`).join(' ')}`, allowedMentions: { roles: roleIds } }).catch(() => {});
  }
  _arenaTimers.end = setTimeout(() => endArena(guild).catch(e => console.error('[arena] end:', e.message)), remaining);
  if (arena.BUTTON_TYPES.includes(a.type)) _arenaTimers.round = setTimeout(() => askNextTrivia(guild).catch(() => {}), 25000);   // don't stall the current question
}
// ---- The land shop: /tribe expand (see TRIBE_PHASE5_SPEC.md sections 3, 3a, 5) ----
// Each unlock's gate is EITHER path (members OR crowns won) — a small elite tribe can climb by dominating,
// a big one by recruiting. Costs/gates match the locked spec table exactly.
// Gates DROPPED 2026-08-03 (owner) — the original 50-120 members / 5-25 crowns were calibrated for a much
// bigger, more mature server than this one actually is: real tribes today top out at 22 members and the
// crown (one winner a week, server-wide, brand new) hadn't been won even once — nobody could EVER have
// unlocked anything at the old gates. Rescaled so the ladder is a real, climbable goal instead of static.
// Rebalanced 2026-08-04 (owner: "reevaluate the prices") — old prices (400-3000) were months of saving
// against ~100-300 treasury/week of realistic earning, so nothing got bought. New ladder: basics in ~1 week,
// mid-tier in 2-4, premium in ~a month. Tribe Icon moved to the MIDDLE (owner) — a mid-tier reward, not the
// endgame. Order here IS the shop display order; gates lowered to be reachable by real tribe sizes.
const TRIBE_UNLOCKS = [
  { key: 'retheme', emoji: '🎨', label: 'Re-theme', desc: 'Recolour your tribe’s role gradient anytime with `/tribe retheme`.', memberGate: 5, crownGate: 1, cost: 150 },
  { key: 'text2', emoji: '📝', label: '2nd text channel', desc: 'A second text channel added to your land.', memberGate: 8, crownGate: 1, cost: 250 },
  { key: 'extsounds', emoji: '🔊', label: 'External Sounds', desc: 'Soundboard + external sounds in your tribe voice channel.', memberGate: 10, crownGate: 2, cost: 350 },
  { key: 'icon', emoji: '🖼️', label: 'Tribe Icon', desc: 'Set an emoji or image icon on your tribe role with `/tribe icon`.', memberGate: 12, crownGate: 2, cost: 450 },
  { key: 'vcboost', emoji: '🎙️', label: 'Voice quality boost', desc: 'Higher bitrate + full video quality on your tribe voice channel.', memberGate: 14, crownGate: 3, cost: 500 },
  { key: 'voice2', emoji: '🔈', label: '2nd voice channel', desc: 'A second voice channel added to your land.', memberGate: 16, crownGate: 3, cost: 600 },
  { key: 'fastertides', emoji: '⚡', label: 'Faster Tides', desc: 'Hall earn-cap drops from 60s to 45s.', memberGate: 20, crownGate: 4, cost: 800 },
];
const TRIBE_CHANNEL_CAP = 6;
const STARTING_TREASURY = 250;   // new tribes start with this so they can grab a first shop unlock (owner, 2026-08-04)
const MUSTER_DURATION_MS = 2 * 3600000;   // window to answer a muster
const MUSTER_COOLDOWN_MS = 20 * 3600000;  // ~once a day, so it can't be spammed for glory/treasury
function unlockGateMet(tribe, guild, u) {
  const memberCount = guild.roles.cache.get(tribe.roleId)?.members.size ?? 0;
  return memberCount >= u.memberGate || (tribe.crownsWon || 0) >= u.crownGate;
}
function strongholdCost(tribe) { return 750 * ((tribe.strongholdTier || 0) + 1); }
function tribeChannelCount(tribe) { return [tribe.throneId, tribe.hallId, tribe.vcId, tribe.text2Id, tribe.vc2Id].filter(Boolean).length; }
// Actually DOES the unlock (channel creation, permission grant, etc). Throws on failure so the caller can
// refund the treasury spend — nothing here should ever leave a tribe charged for something it didn't get.
async function applyTribeUnlock(guild, tribe, u) {
  const P = PermissionsBitField.Flags;
  const staffAllow = perms => [opspanel.ADMIN_ROLE_ID, opspanel.MOD_ROLE_ID].filter(Boolean).map(id => ({ id, allow: perms }));
  const deny = config.cornerRoleId ? [{ id: config.cornerRoleId, deny: [P.ViewChannel] }] : [];
  if (u.key === 'text2') {
    const ch = await guild.channels.create({ name: `${tribe.emoji || '🏴'}┆${toSmallCaps('hall-ii')}`, type: ChannelType.GuildText, parent: tribe.categoryId, permissionOverwrites: [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: tribe.roleId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AddReactions, P.EmbedLinks, P.AttachFiles, P.UseExternalEmojis, P.UseExternalStickers] },
      ...(tribe.leaderRoleId ? [{ id: tribe.leaderRoleId, allow: [P.ViewChannel, P.SendMessages, P.ManageMessages] }] : []),
      ...staffAllow([P.ViewChannel, P.SendMessages, P.ManageMessages]), ...deny] });
    await permguard.blessChannel(guild, ch.id).catch(() => {});
    tribes.update(tribe.key, { text2Id: ch.id });
  } else if (u.key === 'voice2') {
    const ch = await guild.channels.create({ name: `${tribe.emoji || '🏴'}┆${toSmallCaps('voice-ii')}`, type: ChannelType.GuildVoice, parent: tribe.categoryId, permissionOverwrites: [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: tribe.roleId, allow: [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD] },
      ...(tribe.leaderRoleId ? [{ id: tribe.leaderRoleId, allow: [P.ViewChannel, P.Connect, P.Speak, P.MuteMembers, P.MoveMembers] }] : []),
      ...staffAllow([P.ViewChannel, P.Connect, P.Speak, P.MuteMembers, P.MoveMembers]), ...deny] });
    await permguard.blessChannel(guild, ch.id).catch(() => {});
    tribes.update(tribe.key, { vc2Id: ch.id });
  } else if (u.key === 'extsounds') {
    const vc = tribe.vcId && await guild.channels.fetch(tribe.vcId).catch(() => null);
    if (!vc) throw new Error('tribe has no voice channel to grant this on');
    await vc.permissionOverwrites.edit(tribe.roleId, { UseSoundboard: true, UseExternalSounds: true });
  } else if (u.key === 'vcboost') {
    const vc = tribe.vcId && await guild.channels.fetch(tribe.vcId).catch(() => null);
    if (!vc) throw new Error('tribe has no voice channel to boost');
    await vc.setBitrate(96000);
    await vc.setVideoQualityMode(2);
  } else if (u.key === 'fastertides') {
    tribes.update(tribe.key, { tideCooldownMs: 45000 });
  }
  // 'retheme' and 'icon' have no purchase-time effect — they just flip on the /tribe retheme and
  // /tribe icon commands respectively.
}
// Tears down a BOUGHT channel (text2/voice2 only, per spec — no refund). Other unlocks aren't reversible.
async function teardownTribeUnlock(guild, tribe, unlockKey) {
  const idField = unlockKey === 'text2' ? 'text2Id' : unlockKey === 'voice2' ? 'vc2Id' : null;
  if (!idField || !tribe[idField]) return;
  const ch = await guild.channels.fetch(tribe[idField]).catch(() => null);
  if (ch) await ch.delete('Tribe shop: teardown, no refund').catch(() => {});
  tribes.update(tribe.key, { [idField]: null });
  tribes.removeUnlock(tribe.key, unlockKey);
}
function tribeShopView(tribe, guild) {
  const memberCount = guild.roles.cache.get(tribe.roleId)?.members.size ?? 0;
  const lines = TRIBE_UNLOCKS.map(u => {
    if (tribes.hasUnlock(tribe, u.key)) return `✅ ${u.emoji} **${u.label}** — owned`;
    if (!unlockGateMet(tribe, guild, u)) return `🔒 ${u.emoji} **${u.label}** — needs **${u.memberGate}** members or **${u.crownGate}** crowns (you have ${memberCount} members, ${tribe.crownsWon || 0} crowns)`;
    return `🔓 ${u.emoji} **${u.label}** — **${u.cost}** treasury. ${u.desc}`;
  });
  const strongCost = strongholdCost(tribe);
  const strongLine = `🏰 **Stronghold Tier ${tribe.strongholdTier || 0} → ${(tribe.strongholdTier || 0) + 1}** — **${strongCost}** treasury. War **defense**: **+${((tribe.strongholdTier || 0) + 1) * 10}%** defensive power when attacked, and if you defend and still lose, a smaller treasury raid + fewer members captured. Repeatable, never runs out.`;
  const buyable = TRIBE_UNLOCKS.filter(u => !tribes.hasUnlock(tribe, u.key) && unlockGateMet(tribe, guild, u));
  const atCap = tribeChannelCount(tribe) >= TRIBE_CHANNEL_CAP;
  const buyBtns = buyable.map(u => new ButtonBuilder().setCustomId(`tribeshop_buy:${tribe.key}:${u.key}`).setLabel(`${u.label} (${u.cost})`).setStyle(ButtonStyle.Success)
    .setDisabled((tribe.treasury || 0) < u.cost || (['text2', 'voice2'].includes(u.key) && atCap)));
  const rows = [];
  for (let i = 0; i < buyBtns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buyBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribeshop_stronghold:${tribe.key}`).setLabel(`Stronghold Tier ${(tribe.strongholdTier || 0) + 1} (${strongCost})`).setStyle(ButtonStyle.Primary).setDisabled((tribe.treasury || 0) < strongCost)));
  const ownedChannelUnlocks = ['text2', 'voice2'].filter(k => tribes.hasUnlock(tribe, k));
  if (ownedChannelUnlocks.length) rows.push(new ActionRowBuilder().addComponents(ownedChannelUnlocks.map(k => new ButtonBuilder().setCustomId(`tribeshop_teardown:${tribe.key}:${k}`).setLabel(`🗑️ Remove ${TRIBE_UNLOCKS.find(u => u.key === k).label}`).setStyle(ButtonStyle.Danger))));
  return {
    content: `## 🏪 ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: The Shop\n-# Treasury: **${tribe.treasury || 0}** · Land: ${tribeChannelCount(tribe)}/${TRIBE_CHANNEL_CAP} channels${atCap ? ' (at cap)' : ''}\n\n${lines.join('\n')}\n\n${strongLine}`,
    components: rows.slice(0, 5),
    allowedMentions: { parse: [] },
  };
}
// ---- Guided (non-inline) tribe builder wizard ----
// /tribe-admin create takes ONLY the leader inline (an 8+ option command is unusable); everything else is
// collected across a short modal + button flow. State lives in-memory, keyed by the founding admin's user id
// (their status card is ephemeral, so only they can ever see or click it — no separate ownership check needed),
// and expires after 20 minutes of inactivity so an abandoned build doesn't linger forever.
const _tribeWizards = new Map();   // adminId -> { leaderId, name, shortName, emoji, pointsName, leaderTitle, color, color2, style, channelNames, channelTopics, expires }
const parseTribeHex = h => { const m = String(h || '').trim().replace(/^#/, ''); return /^[0-9a-fA-F]{6}$/.test(m) ? parseInt(m, 16) : null; };
// Shared bad-hex error for every colour-entry point (wizard modal + /tribe retheme) — links straight to a
// free, no-signup visual picker instead of just re-explaining hex, for founders who don't know what hex is.
function badHexReply(which) {
  const link = new ButtonBuilder().setLabel('🖍️ Pick a colour visually').setStyle(ButtonStyle.Link).setURL('https://htmlcolorcodes.com/color-picker/');
  return { content: `Bad ${which} colour. Needs a 6-digit hex like \`#2A426A\` — pick one visually below and copy its hex code.`, components: [new ActionRowBuilder().addComponents(link)], flags: MessageFlags.Ephemeral };
}
function wizardGet(adminId) {
  const w = _tribeWizards.get(adminId);
  if (w && w.expires < Date.now()) { _tribeWizards.delete(adminId); return null; }
  return w || null;
}
function wizardTouch(adminId, patch) {
  const w = wizardGet(adminId) || {};
  Object.assign(w, patch, { expires: Date.now() + 20 * 60000 });
  _tribeWizards.set(adminId, w);
  return w;
}
// Wraps showModal() so a bad modal (e.g. a TextInput label over Discord's 45-char cap — confirmed live,
// 2026-08-03: a mod's founding request silently failed with "the application did not respond" because
// tribeIdentityModal()'s leader_title label was 47 chars) logs AND tells the user something useful, instead
// of silently leaving them with an unresponsive interaction and zero diagnostic trail.
async function safeShowModal(interaction, modal) {
  try { return await interaction.showModal(modal); }
  catch (e) {
    console.error('[tribe wizard] showModal failed:', e.message);
    return interaction.reply({ content: 'Something went wrong opening that form. Tell an admin — this is a bug, not something you did.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}
function tribeIdentityModal() {
  return new ModalBuilder().setCustomId('tribewiz_identity').setTitle('Found a tribe: identity').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Full tribe name, e.g. "The Tribe of X"').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('short_name').setLabel('Short name for cards (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Tribe emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('points_name').setLabel('Activity points name, e.g. Tides (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('leader_title').setLabel('Head title, e.g. Warden (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40)));
}
function tribeColorsModal(w) {
  const colorInput = new TextInputBuilder().setCustomId('color').setLabel('Primary colour hex, e.g. #2A426A').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7);
  if (w?.color != null) colorInput.setValue('#' + w.color.toString(16).padStart(6, '0'));
  const color2Input = new TextInputBuilder().setCustomId('color2').setLabel('Second hex for a gradient (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7);
  if (w?.color2 != null) color2Input.setValue('#' + w.color2.toString(16).padStart(6, '0'));
  return new ModalBuilder().setCustomId('tribewiz_colors').setTitle('Found a tribe: colours')
    .addComponents(new ActionRowBuilder().addComponents(colorInput), new ActionRowBuilder().addComponents(color2Input));
}
function tribeLandModal(w) {
  const f = (id, label, val, max) => { const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(max); if (val) t.setValue(val); return new ActionRowBuilder().addComponents(t); };
  return new ModalBuilder().setCustomId('tribewiz_land').setTitle('Found a tribe: the land (optional)').addComponents(
    f('throne_name', 'Throne channel name (default: throne)', w?.channelNames?.throne, 30),
    f('throne_purpose', 'Throne purpose (shown as the channel topic)', w?.channelTopics?.throne, 200),
    f('hall_name', 'Hall channel name (default: hall)', w?.channelNames?.hall, 30),
    f('hall_purpose', 'Hall purpose (shown as the channel topic)', w?.channelTopics?.hall, 200),
    f('voice_name', 'Voice channel name (default: voice)', w?.channelNames?.voice, 30));
}
// The ephemeral status card the whole wizard revolves around: shows what's captured so far, buttons to fill
// in each piece, and a Build button that only lights up once the two REQUIRED pieces (name + colour) are set.
function wizardStatusMessage(adminId) {
  const w = wizardGet(adminId);
  if (!w) return { content: 'This tribe build expired or was never started. Run `/tribe-admin create` again.', components: [] };
  const lines = [
    `**Leader:** <@${w.leaderId}>`,
    `**Name:** ${w.name || '_not set, use Identity_'}${w.shortName ? ` (${w.shortName})` : ''}`,
    `**Emoji:** ${w.emoji || '🏴 (default)'}`,
    `**Points name:** ${w.pointsName || 'points (default)'}`,
    `**Leader title:** ${w.leaderTitle || 'Chief (default)'}`,
    `**Colour:** ${w.color != null ? '#' + w.color.toString(16).padStart(6, '0') : '_not set, required_'}${w.color2 != null ? ` to #${w.color2.toString(16).padStart(6, '0')}` : ''}`,
    `**Style:** ${w.style === 'plain' ? 'plain' : 'small-caps (server style, default)'}`,
    `**Land:** ${w.channelNames || w.channelTopics ? [...Object.entries(w.channelNames || {}), ...Object.entries(w.channelTopics || {}).map(([k, v]) => [`${k} topic`, v])].map(([k, v]) => `${k}: ${v}`).join(', ') : '_default names, no topics_'}`,
  ];
  const identityBtn = new ButtonBuilder().setCustomId('tribewiz_identity_btn').setLabel('✏️ Identity').setStyle(ButtonStyle.Secondary);
  const colorsBtn = new ButtonBuilder().setCustomId('tribewiz_colors_btn').setLabel('🎨 Colours').setStyle(w.color != null ? ButtonStyle.Secondary : ButtonStyle.Primary);
  // Discord has no native colour picker (modals only take text/select input, see 2026-08-03 discussion) and
  // founders who don't know hex have typed literal garbage into the field before. No point building our own
  // page for this, htmlcolorcodes.com already has a free, no-signup visual picker that outputs a hex code to
  // copy straight into the Colours modal.
  const colorHelpBtn = new ButtonBuilder().setLabel('🖍️ Pick a colour visually').setStyle(ButtonStyle.Link).setURL('https://htmlcolorcodes.com/color-picker/');
  const landBtn = new ButtonBuilder().setCustomId('tribewiz_land_btn').setLabel('🏠 Land: names & purpose').setStyle(ButtonStyle.Secondary);
  const styleSelect = new StringSelectMenuBuilder().setCustomId('tribewiz_style').setPlaceholder('Channel text style').addOptions(
    { label: 'Small-caps (server style)', value: 'small', default: w.style !== 'plain' },
    { label: 'Plain', value: 'plain', default: w.style === 'plain' });
  const buildBtn = new ButtonBuilder().setCustomId('tribewiz_build').setLabel('✅ Build').setStyle(ButtonStyle.Success).setDisabled(!w.name || w.color == null);
  const cancelBtn = new ButtonBuilder().setCustomId('tribewiz_cancel').setLabel('❌ Cancel').setStyle(ButtonStyle.Danger);
  return {
    content: `## 🏴 Founding a tribe\n${lines.join('\n')}\n-# Fill in Identity + Colours, land is optional, then Build.`,
    components: [
      new ActionRowBuilder().addComponents(identityBtn, colorsBtn, landBtn, colorHelpBtn),
      new ActionRowBuilder().addComponents(styleSelect),
      new ActionRowBuilder().addComponents(buildBtn, cancelBtn),
    ],
    allowedMentions: { parse: [] },
  };
}
// Staff infraction/weight guide — the "how do I punish X" reference trial mods keep asking for. Built
// live from rules.js (text + decided weight + handling summary) so it never drifts from the real config.
function buildWeightsEmbed() {
  const rows = rules.infractionLines();
  const cap = strikes.BAN_THRESHOLD;
  const lines = rows.map(r => {
    const wtag = r.weighable ? (r.weight ? `\`${r.weight}u\`` : '`TBD`') : '`ban/na`';
    return `**${r.n}. ${r.title}** ${wtag}\n   ↳ ${r.enforce}`;
  });
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚖️ FUBU: Infractions & Strike Weights (staff)')
    .setDescription(
      '**How to apply punishments:**\n' +
      '• **Corner**: cool-off for *minor / first-time* stuff. No strike, just a timed removal.\n' +
      '• **Strike**: *real or repeated* behavior. Each carries a **weight of 1-3 units**.\n' +
      `• Units add up: **${cap} total → a ban is offered.** Some rules skip the ladder and are an **instant permanent ban**.\n` +
      '• **Repeat the same offense → escalate** (Corner → longer Corner → Strike → bigger Strike).\n\n' +
      '`Nu` = strike weight in units · `ban/na` = instant-ban or not an infraction\n\n' +
      lines.join('\n'))
    .setFooter({ text: 'Weights are set by mod weight-polls · pull this anytime with /weights' });
}
// Sent to the corner. whenPhrase = `until <t:…:f>` or `indefinitely`. reason optional.
// Humanize a duration in ms → "2d 3h" / "45m" / "30s" (compact, up to two units).
function humanDur(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
  if (h) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  if (m) return `${m}m`;
  return `${s}s`;
}
// "Time served" suffix for release messages — only when the timeServed feature is on.
function servedSuffix(servedMs) {
  return (features.enabled('timeServed') && servedMs) ? ` · in for **${humanDur(servedMs)}**` : '';
}

function cornerSentMessage(userId, whenPhrase, reason, actorId) {
  return {
    // Hybrid: big rendered header in message CONTENT (headers don't render inside embeds), with the
    // colored embed below so the meaningful red/green signal is kept. The mention is in CONTENT (not
    // just the embed) because embeds can never ping — this is a real notification, it should reach them.
    content: `## ⛓️ SENT TO THE CORNER\n<@${userId}>`,
    embeds: [new EmbedBuilder().setColor(CORNER_RED)
      .setDescription(`<@${userId}> has been stripped of their roles and confined here **${whenPhrase}**.`
        + (actorId ? `\n**Sent by:** <@${actorId}>` : '')
        + (reason ? `\n**Reason:** ${reason}` : '')
        + `\n\nThis is the only text channel you may speak in (you can also join the corner voice channel). Reflect on what brought you here.`)],
    // Mod controls: release now, add time (+1h / +1d), or set indefinite (no auto-release) — one click.
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:0`).setEmoji('🔓').setLabel('Release now').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:3600000`).setEmoji('⏰').setLabel('+1h').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:86400000`).setEmoji('⏰').setLabel('+1d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:indef`).setEmoji('♾️').setLabel('Indefinite').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { users: [userId] },
  };
}

// Announce a corner that just happened: the themed message in the corner channel (duration + who + reason +
// release buttons) AND the audit entry in the corner log. Centralises what every corner path needs — /corner,
// the context-menu, and the DASHBOARD (which previously announced/logged nothing) all call this so the
// resultant message consistently shows the duration and who sent them.
async function announceCorner(guild, memberId, durationMs, actorId, reasonText) {
  const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
  const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
  const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
  if (cornerCh) await cornerCh.send(cornerSentMessage(memberId, whenPhrase, reasonText || null, actorId)).catch(() => {});
  await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER', color: CORNER_RED,
    desc: `<@${memberId}> was cornered ${relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**'}.\n**By:** <@${actorId}>${reasonText ? `\n**Reason:** ${reasonText}` : ''}` });
}

// Post a FULLY STYLIZED audit entry to the public corner-log channel for every corner event
// (entry / exit / sentence change). Each entry mirrors the channel style — a `## HEADER` in content
// plus a colored embed — but folds in the audit facts the user-facing message omits (who acted,
// target, release time). No mod buttons: the log is a read-only record, not an action surface.
// allowedMentions parse:[] renders the @names without pinging anyone on every line.
async function logCorner(guild, entry) {
  try {
    const ch = await guild.channels.fetch(config.cornerLogChannelId).catch(() => null);
    if (ch) {
      // Back-compat: a bare string still posts as a plain line.
      if (typeof entry === 'string') await ch.send({ content: entry, allowedMentions: { parse: [] } });
      else {
        const { emoji, title, color, desc } = entry;
        // desc's @mentions live in CONTENT (not the embed) so they resolve to clickable @names for everyone —
        // embed mentions only resolve from the viewer's cache and show "@unknown-user" in this restricted log.
        // Content-only: the ## header + emoji carry the signal; a color-only embed would render as an empty box.
        await ch.send({ content: `## ${emoji} ${title}\n${desc}`, allowedMentions: { parse: [] } });
      }
    }
    // Mirror to the owner-only log too — covers every corner/uncorner call site in one place.
    if (typeof entry !== 'string') await ownerlog.log(guild, { emoji: entry.emoji, title: entry.title, detail: entry.desc, color: entry.color });
  } catch (e) { console.error(`[corner-log] ${e.message}`); }
}
// Small helper: "<t:..:R> (<t:..:f>)" from an epoch-ms release time, for audit embeds.
function relPhrase(releaseAt) {
  const s = Math.floor(releaseAt / 1000);
  return `<t:${s}:R> (<t:${s}:f>)`;
}

// Mod gate shared by the button handlers below (MOD role, Administrator overrides).
function modClicked(interaction) {
  return !!opspanel.tierOf(interaction);   // any staff tier (mod/admin/owner incl Admin-perm/bot owner)
}

// /pending — paginated, read-only list of open verify threads (verifying happens in-thread, not here).
async function renderPending(page) {
  const verifyCh = getVerifyChannel();
  let threads = verifyCh ? await activeThreads(verifyCh) : [];
  threads = threads.filter(t => t.parentId === config.verifyChannelId)
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));   // oldest first
  const PER = 10;
  const pages = Math.max(1, Math.ceil(threads.length / PER));
  page = Math.min(Math.max(0, page || 0), pages - 1);
  const slice = threads.slice(page * PER, page * PER + PER);
  const lines = slice.map((t, i) =>
    `${page * PER + i + 1}. ${t} · <@${t.ownerId}> · opened <t:${Math.floor((t.createdTimestamp || Date.now()) / 1000)}:R>`);
  const content = `## 🧵 Pending Verify Threads (${threads.length})\n${lines.join('\n') || '_none open_'}\n-# Page ${page + 1}/${pages}`;
  const components = pages > 1 ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pending_page:${page - 1}`).setEmoji('◀️').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`pending_page:${page + 1}`).setEmoji('▶️').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  )] : [];
  return { content, components };
}

// Daily-digest mod-control buttons: run the sweep on demand, or pull up the corner list.
async function handleDigestButton(interaction) {
  if (!modClicked(interaction)) return interaction.reply({ content: copy.guards.modRoleOnly, flags: MessageFlags.Ephemeral });
  if (interaction.customId === 'digest_cornered') return handleCorneredList(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });   // digest_sweep
  try {
    await sweep.runOnce(client, state, { getVerifyChannel, getAlertChannel, getWarnChannel, getConflictChannel });
    return interaction.editReply('🧹 Sweep complete: threads, warnings and conflicts refreshed.');
  } catch (e) {
    return interaction.editReply(`Sweep failed: ${e.message}`);
  }
}

// /cornered — mod tool: list everyone in the corner, each with a one-click Release button.
async function handleCorneredList(interaction) {
  if (!modClicked(interaction)) return interaction.reply({ content: copy.guards.modRoleOnly, flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const cornered = state.listCornered();
  const ids = Object.keys(cornered);
  if (!ids.length) return interaction.editReply('✅ No one is in the corner.');
  const shown = ids.slice(0, 20);                    // Discord caps at 5 buttons/row × 5 rows
  const lines = [];
  const rows = [];
  let row = new ActionRowBuilder();
  for (const id of shown) {
    const rec = cornered[id] || {};
    const rel = rec.releaseAt ? `<t:${Math.floor(rec.releaseAt / 1000)}:R>` : 'indefinite';
    const inFor = rec.at ? `in since <t:${Math.floor(rec.at / 1000)}:R> · ` : '';
    const m = await interaction.guild.members.fetch(id).catch(() => null);
    const tag = m?.user?.tag || id;
    lines.push(`• <@${id}> (\`${tag}\`) · ${inFor}release ${rel}`);
    row.addComponents(new ButtonBuilder().setCustomId(`corner_rel:${id}:0`).setEmoji('🔓')
      .setLabel(`Release ${tag}`.slice(0, 80)).setStyle(ButtonStyle.Success));
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  }
  if (row.components.length) rows.push(row);
  const extra = ids.length > shown.length ? `\n…and ${ids.length - shown.length} more.` : '';
  return interaction.editReply({ content: `## 🚫 In the Corner (${ids.length})\n${lines.join('\n')}${extra}`, components: rows });
}

// Corner announcement buttons: 🔓 Release now / ⏰ +1h / ⏰ +1d (add time, or from now if indefinite).
// Shared "send this member to the corner for THIS message" — used by the immediate right-click path
// and (when the cornerReason feature is on) the reason-modal path. Optional reason is surfaced in the
// corner channel + the audit log. Defaults to a TIMED corner (config.cornerDefaultDurationMs) — Corner
// is meant to be casual/temporary, not indefinite by default. Returns { ok, stripped, error }.
async function cornerFromMessage(guild, actorId, member, target, reason, durationMs = config.cornerDefaultDurationMs, ruleN = null) {
  const r = await corner.corner(guild, member, durationMs, state, actorId, ruleN);
  if (!r.ok) return { ok: false, error: r.error };
  const relSec = Math.floor((Date.now() + durationMs) / 1000);
  const whenPhrase = `until <t:${relSec}:f>`;
  try {
    const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
    if (cornerCh) {
      await cornerCh.send(cornerSentMessage(member.id, whenPhrase, reason || null, actorId));
      const emb = new EmbedBuilder().setColor(CORNER_RED)
        .setAuthor({ name: target.author.tag, iconURL: target.author.displayAvatarURL() })
        .setDescription(target.content?.slice(0, 4000) || '_[no text, see attachment/link]_')
        .addFields({ name: 'Why they’re here', value: `Cornered for this message by <@${actorId}>${reason ? `\n**Reason:** ${reason}` : ''}` })
        .setFooter({ text: `originally in #${target.channel?.name || '?'}` }).setTimestamp(target.createdTimestamp);
      const files = [...(target.attachments?.values() || [])].slice(0, 5).map(a => a.url);
      await cornerCh.send({ embeds: [emb], content: files.length ? files.join('\n') : undefined, allowedMentions: { parse: [] } });
    }
  } catch (e) { console.error(`[corner-msg] forward failed: ${e.message}`); }
  // In-channel notice on the flagged message (no DM) — same pattern the Strike flows use. Shows the duration
  // and who cornered them (actor mention resolves but doesn't ping — only the cornered member is pinged).
  await target.reply({ content: `⛓️ This message got <@${member.id}> sent to the corner ${whenPhrase} by <@${actorId}>${reason ? ` (${reason})` : ''}.`, allowedMentions: { users: [member.id] } }).catch(e => console.error('[corner-msg] reply on original failed:', e.message));
  await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER (via message)', color: CORNER_RED,
    desc: `<@${member.id}> was cornered until ${relPhrase(relSec * 1000)} for a message.\n**By:** <@${actorId}>${reason ? `\n**Reason:** ${reason}` : ''}\n**Message:** ${target.url}` });
  return { ok: true, stripped: r.stripped };
}

// Release a member whose timed corner has come due + announce "time served". Called by the per-corner
// setTimeout (precise) AND the backstop poller. Guarded on current cornered-state so the two can't
// double-release or double-announce the same member.
async function releaseCornerAndAnnounce(guild, uid) {
  if (!state.getCornered(uid)) return;   // already released by the other path
  const r = await corner.uncorner(guild, uid, state, 'Corner duration expired');
  if (!r.ok) { console.error(`[corner] timed release failed for ${uid}: ${r.error}`); return; }
  try {
    const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
    if (cornerCh) await cornerCh.send(cornerTimeServedMessage(uid)).catch(e => console.error(`[corner] time-served announce: ${e.message}`));
  } catch { /* announce best-effort */ }
  await logCorner(guild, { emoji: '⛓️‍💥', title: 'TIME SERVED', color: CORNER_GREEN,
    desc: `<@${uid}>'s sentence ended: auto-released, roles restored.\n**By:** the Corner (automatic)${servedSuffix(r.servedMs)}${missedRolesNote(r.missed)}` });
}
// A note for the corner-log when some stored roles couldn't be auto-restored (deleted, above the bot's
// role, or bot-managed), so a mod can fix it by hand instead of the member silently missing roles.
function missedRolesNote(missed) {
  if (!missed || !missed.length) return '';
  return `\n⚠️ **${missed.length} role(s) couldn't be auto-restored** (deleted, above my role, or managed): ${missed.map(id => `<@&${id}>`).join(', ')}. Add them back manually if still needed.`;
}

// Corner a LIST of members in one action — shared by /corner's `also`, the dashboard multi-pick, and the
// Bulk corner (sweep / dashboard "Corner several" / /corner also). Per-target guards: skip self, bots, and
// ALL STAFF — mods/admins/owners are never bulk-cornered (owner ruling 2026-08-01). A deliberate single
// /corner can still corner an equal/lower staff tier; bulk ops never touch staff, so a raid sweep can't
// scoop up your own team. Dedupes, announces each in the corner channel, writes ONE summary. Returns {done, skipped}.
async function cornerMany(guild, actorId, actorRank, members, durationMs, { ruleN = null, reasonText = null } = {}) {
  const done = [], skipped = [], seen = new Set();
  const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
  const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
  const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
  for (const member of members) {
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    if (member.id === actorId) { skipped.push(`<@${member.id}> (yourself)`); continue; }
    if (member.user?.bot) { skipped.push(`<@${member.id}> (bot)`); continue; }
    if (member.id === guild.ownerId) { skipped.push(`<@${member.id}> (owner)`); continue; }
    const targetTier = opspanel.memberTier(member);
    const staffLabel = targetTier || (config.trialModRoleId && member.roles.cache.has(config.trialModRoleId) ? 'trial mod' : null);
    if (staffLabel) { skipped.push(`<@${member.id}> (${staffLabel})`); continue; }   // bulk-corner never touches staff (mod/admin/owner/trial mod)
    const r = await corner.corner(guild, member, durationMs, state, actorId, ruleN);
    if (r.ok) { done.push(member.id); if (cornerCh) await cornerCh.send(cornerSentMessage(member.id, whenPhrase, reasonText, actorId)).catch(() => {}); }
    else skipped.push(`<@${member.id}> (${r.error})`);
  }
  if (done.length) await logCorner(guild, { emoji: '⛓️', title: `SENT TO THE CORNER (×${done.length})`, color: CORNER_RED,
    desc: `${done.map(id => `<@${id}>`).join(', ')}: cornered ${relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**'}.\n**By:** <@${actorId}>${reasonText ? `\n**Reason:** ${reasonText}` : ''}` });
  return { done, skipped, whenPhrase };
}

async function handleCornerButton(interaction) {
  const [, userId, msStr] = interaction.customId.split(':');   // corner_rel:<userId>:<ms>  or  corner_recorner:<userId>
  const ms = Number(msStr || 0);
  if (!modClicked(interaction)) return interaction.reply({ content: copy.guards.modRoleOnly, flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });   // ack is private; the corner-log channel is the public record
  const guild = interaction.guild;
  // Re-corner (from a release announcement): send them straight back, indefinitely.
  if (interaction.customId.startsWith('corner_recorner:')) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return interaction.editReply(copy.common.noMemberInServer);
    // Same tier hierarchy as /corner (own tier or lower, never higher) — see wl_corner's comment above for
    // why this can't be a blanket "no admins ever" block.
    if (member.id === guild.ownerId) return interaction.editReply('You cannot corner the server owner.');
    const recornerActorRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[opspanel.tierOf(interaction)] || 0;
    const recornerTargetTier = opspanel.memberTier(member);
    const recornerTargetRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[recornerTargetTier] || 0;
    if (recornerTargetRank > recornerActorRank) return interaction.editReply(`You can’t corner someone of a higher staff tier than you (they’re **${recornerTargetTier}**).`);
    const r = await corner.corner(guild, member, null, state, interaction.user.id);
    if (!r.ok) return interaction.editReply(`Failed to re-corner: ${r.error}`);
    try {
      const ch = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
      if (ch) await ch.send(cornerSentMessage(userId, 'indefinitely', null, interaction.user.id));
    } catch (e) { console.error(`[recorner] announce failed: ${e.message}`); }
    await logCorner(guild, { emoji: '⛓️', title: 'RE-CORNERED', color: CORNER_RED,
      desc: `<@${userId}> was sent straight back to the corner **indefinitely**.\n**By:** <@${interaction.user.id}>` });
    return interaction.editReply(`⛓️ Re-cornered <@${userId}>, stripped **${r.stripped}** role(s).`);
  }
  if (msStr === 'indef') {
    const rec = state.getCornered(userId);
    if (!rec) return interaction.editReply(`<@${userId}> is not in the corner.`);
    state.setCornered(userId, { ...rec, releaseAt: null });   // null = never auto-released
    corner.clearTimer(userId);                                // cancel the pending precise-release timer
    await logCorner(guild, { emoji: '♾️', title: 'SENTENCE CHANGED', color: CORNER_AMBER,
      desc: `<@${userId}>'s corner is now **indefinite** (no auto-release).\n**By:** <@${interaction.user.id}>` });
    return interaction.editReply(`♾️ <@${userId}> is now cornered **indefinitely**. They stay until manually released.`);
  }
  if (ms === 0) {
    const r = await corner.uncorner(guild, userId, state);
    if (!r.ok) return interaction.editReply(`Failed to release: ${r.error}`);
    const served = servedSuffix(r.servedMs);
    try {
      const ch = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
      if (ch) await ch.send(cornerReleasedMessage(userId));
    } catch (e) { console.error(`[corner-btn] announce failed: ${e.message}`); }
    await logCorner(guild, { emoji: '🔓', title: 'RELEASED', color: CORNER_GREEN,
      desc: `<@${userId}> was released: roles restored.\n**By:** <@${interaction.user.id}>${served}${missedRolesNote(r.missed)}` });
    return interaction.editReply(`✅ Released <@${userId}>, restored **${r.restored}** role(s)${r.missed && r.missed.length ? ` · ⚠️ ${r.missed.length} couldn't be restored (see log)` : ''}${served}.`);
  }
  const rec = state.getCornered(userId);
  if (!rec) return interaction.editReply(`<@${userId}> is not in the corner.`);
  const baseline = (rec.releaseAt && rec.releaseAt > Date.now()) ? rec.releaseAt : Date.now();
  const releaseAt = baseline + ms;
  state.setCornered(userId, { ...rec, releaseAt });
  await logCorner(guild, { emoji: '⏰', title: 'SENTENCE CHANGED', color: CORNER_AMBER,
    desc: `<@${userId}>'s release time was changed.\n**New release:** ${relPhrase(releaseAt)}\n**By:** <@${interaction.user.id}>` });
  return interaction.editReply(`⏳ <@${userId}> will now be released <t:${Math.floor(releaseAt / 1000)}:R> (<t:${Math.floor(releaseAt / 1000)}:f>).`);
}

// Conflict-flag buttons: strip exactly one of the two conflicting roles (mod chooses which stays).
async function handleConflictButton(interaction) {
  const [, userId, which] = interaction.customId.split(':');  // conflict_rm:<userId>:<unver|ver>
  if (!modClicked(interaction)) return interaction.reply({ content: 'Only the mod role can resolve conflicts.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!member) return interaction.editReply(copy.common.noMemberInServer);
  const roleId = which === 'unver' ? config.unverifiedRoleId : config.verifiedRoleId;
  const roleName = which === 'unver' ? 'Unverified' : 'Verified';
  const kept = which === 'unver' ? 'Verified' : 'Unverified';
  try {
    await member.roles.remove(roleId, `Conflict resolved by ${interaction.user.tag}`);
  } catch (e) {
    return interaction.editReply(`Failed to remove ${roleName}: ${e.message}`);
  }
  await interaction.editReply(`✅ Removed **${roleName}** from ${member.user.tag} (now **${kept}**).`);
  await interaction.message.edit({
    content: `## ✅ Conflict Resolved\n<@${userId}>: **${roleName}** removed by <@${interaction.user.id}> (kept **${kept}**).`,
    components: [],
    allowedMentions: { parse: [] }, // mod-only conflict channel - the flagged member can't see it, never actually ping them here
  }).catch(() => {});
}
// Released manually via /uncorner (no duration).
// Re-corner button for the release announcements — one click puts them straight back if they act up.
function recornerRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`corner_recorner:${userId}`).setEmoji('⛓️').setLabel('Re-corner').setStyle(ButtonStyle.Danger),
  );
}
function cornerReleasedMessage(userId) {
  return {
    content: '## 🔓 RELEASED FROM THE CORNER',
    embeds: [new EmbedBuilder().setColor(CORNER_GREEN)
      .setDescription(`<@${userId}> has been released. Your roles have been restored. Do not end up back here.`)],
    components: [recornerRow(userId)],
    allowedMentions: { users: [userId] },
  };
}
// Released automatically when a timed corner expires ("time served").
function cornerTimeServedMessage(userId) {
  return {
    content: '## ⛓️‍💥 TIME SERVED',
    embeds: [new EmbedBuilder().setColor(CORNER_GREEN)
      .setDescription(`<@${userId}>'s sentence has ended. The Corner releases you: roles restored, `
        + `access returned. Consider this your warning.`)],
    components: [recornerRow(userId)],
    allowedMentions: { users: [userId] },
  };
}

const state = new State(config.stateFile);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates],   // watchlist keyword monitor + voice states (corner disconnects them from VC)
  // GuildMember partial lets guildMemberUpdate fire even when the old member wasn't cached.
  // Message/Reaction partials let messageReactionAdd fire for the (old, uncached) weekly message.
  partials: [Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User],
});

// --- Throne message auto-expiry (owner: each transient throne message gets its own 24h timer) -----------
// Use throneSend() instead of throne.send() for TRANSIENT throne posts (requests, vote prompts, notices):
// it sends, then schedules the message to self-delete 24h later. The persistent throne panel and the arena
// start-pings deliberately keep raw throne.send() so they're never expired here. Deadlines persist to disk,
// and armThroneExpire re-arms them after a restart, so nothing is orphaned.
const _throneTimers = new Map();
async function deleteThroneExpired(channelId, messageId) {
  _throneTimers.delete(messageId);
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    const m = ch && await ch.messages.fetch(messageId).catch(() => null);
    if (m) await m.delete().catch(() => {});
  } finally { throneExpire.remove(messageId); }
}
function armThroneExpire(channelId, messageId, ms) {
  if (_throneTimers.has(messageId)) return;
  const t = setTimeout(() => deleteThroneExpired(channelId, messageId), Math.max(0, ms));
  if (t.unref) t.unref();   // don't keep the process alive just for a cleanup timer
  _throneTimers.set(messageId, t);
}
async function throneSend(channel, payload) {
  const msg = await channel.send(payload).catch(() => null);
  if (msg) { const at = Date.now() + throneExpire.TTL_MS; throneExpire.add(channel.id, msg.id, at); armThroneExpire(channel.id, msg.id, throneExpire.TTL_MS); }
  return msg;
}
// Reset a throne message's 24h timer — call after EDITING a throne message (vote tally / result) so it
// expires 24h after the last edit, not 24h after it was first posted (owner: a war vote can run up to 24h;
// it should clean up 24h after the result is determined).
function throneTouch(channelId, messageId) {
  if (!channelId || !messageId) return;
  throneExpire.add(channelId, messageId, Date.now() + throneExpire.TTL_MS);   // upsert -> push deadline
  const existing = _throneTimers.get(messageId);
  if (existing) { clearTimeout(existing); _throneTimers.delete(messageId); }
  armThroneExpire(channelId, messageId, throneExpire.TTL_MS);
}
// Re-arm persisted throne expiries after a restart (past-due ones fire immediately via ms<=0).
function rearmThroneExpiries() {
  const now = Date.now();
  const q = throneExpire.all();
  for (const e of q) armThroneExpire(e.channelId, e.messageId, e.deleteAt - now);
  if (q.length) console.log(`[throneExpire] re-armed ${q.length} pending throne message expiry(ies)`);
}

// --- Panel-driven setup (owner: consolidate the 10 *-setup commands into /panel → 🧩 Setup) --------------
// Wired as opspanel D.runSetup. Each kind mirrors the OLD *-setup slash handler: same guard, same
// module.setup() call, ephemeral reply — just triggered by a panel button instead of a slash command.
// `channelId` is only used by the 'dashboard' kind (the member hub is posted into a chosen channel).
async function runPanelSetup(interaction, kind, channelId) {
  const g = interaction.guild;
  const eph = { flags: MessageFlags.Ephemeral };
  try {
    switch (kind) {
      case 'suggest': {
        if (!isOwner(interaction)) return interaction.reply({ content: 'Only owners can set up the forum.', ...eph });
        await interaction.deferReply(eph);
        const { forum, created } = await suggestions.setup(g, config);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} the suggestions forum <#${forum.id}>. Members post via **/dashboard → 💡 Suggest**.`);
      }
      case 'confess': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { channel, logChannel, created } = await confessions.setup(g, config);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} confessions <#${channel.id}>${logChannel ? ` + staff log <#${logChannel.id}>` : ''}. Members post via **/dashboard → 💭 Confess**.`);
      }
      case 'modmail': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { channel, created } = await modmail.setup(g, config);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. Members message staff via **/dashboard → ✉️ Message staff**.`);
      }
      case 'report': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { channel, created } = await reports.setup(g, config);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. Members report via **/dashboard → 🚩 Report** or right-click → Apps → Report.`);
      }
      case 'applymod': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { forum, apps } = await modapps.setup(g, config);
        return interaction.editReply(`✅ Mod applications ready: review forum <#${forum.id}> + applicant threads in <#${apps.id}>. Members apply with \`/apply-mod\`.`);
      }
      case 'requestrole': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { channel, created } = await rolereq.setup(g, config);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. Members use \`/request-role\`.`);
      }
      case 'appeal': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { channel, created } = await appeals.setup(g, config);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. Friends appeal a ban with \`/appeal ban <username>\`.`);
      }
      case 'appealstrike': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { channel, created } = await strikeAppeals.setup(g);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. A struck member appeals with \`/appeal strike <strike>\`.`);
      }
      case 'whistleblow': {
        if (!opspanel.isBotOwner(interaction)) return interaction.reply({ content: 'Only the **bot owner** can set up whistleblows (you become the “you” who can unseal).', ...eph });
        await interaction.deferReply(eph);
        const cfg = await whistleblow.setup(g, interaction.user.id);
        return interaction.editReply(`✅ Whistleblows now DM **you** (<@${cfg.you}>) and/or the **owner** (<@${cfg.her}>) per the sender’s choice. Members use \`/whistleblow\`.`);
      }
      case 'dashboard': {
        if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins can post the hub panel.', ...eph });
        await interaction.deferReply(eph);
        const ch = channelId ? await g.channels.fetch(channelId).catch(() => null) : null;
        if (!ch) return interaction.editReply('Could not find that channel.');
        const sent = await ch.send(pubdash.hubPanel(g.id)).catch(() => null);
        if (!sent) return interaction.editReply(`Could not post in <#${ch.id}>. Check my permissions there.`);
        await sent.pin().catch(() => {});
        return interaction.editReply(`✅ Posted and pinned the member hub in <#${ch.id}>.`);
      }
      default:
        return interaction.reply({ content: `Unknown setup action: ${kind}`, ...eph });
    }
  } catch (e) {
    console.error(`[panel-setup:${kind}] ${e.message}`);
    const m = `Setup failed: ${e.message}`;
    return (interaction.deferred || interaction.replied) ? interaction.editReply(m).catch(() => {}) : interaction.reply({ content: m, ...eph }).catch(() => {});
  }
}

let verifyChannel = null;
let alertChannel = null;
let warnChannel = null;
let conflictChannel = null;
const getVerifyChannel = () => verifyChannel;
const getAlertChannel = () => alertChannel;
const getWarnChannel = () => warnChannel;
const getConflictChannel = () => conflictChannel;

// Inject the bot's own logic into the tier-gated ops dashboard so it reuses corner/sweep/state/etc.
opspanel.wire({ client, config, state, corner, sweep, activeThreads, freshwatch, cornerMany, announceCorner,
  promoteStart: (guild, member, byId, kind) => promote.start(guild, member, byId, config, kind),
  runSetup: runPanelSetup,   // /panel → 🧩 Setup buttons dispatch here (replaces the 10 *-setup commands)
  getVerifyChannel, getAlertChannel, getWarnChannel, getConflictChannel,
  logAction: ownerlog.log,
  strike: {
    BAN_THRESHOLD: strikes.BAN_THRESHOLD,
    total: member => strikes.totalUnits(state, member.id),
    up: async (guild, member, byTag) => {
      const res = await strikes.addStrike(guild, member, state, { weight: 1, reason: 'Quick 1-unit strike via dashboard picker', byTag });
      await ownerlog.log(guild, { emoji: '⚠️', title: 'Strike given', color: 0xED4245, detail: `<@${member.id}> — 1 unit (quick dashboard strike) — by ${byTag}. Now ${strikes.formatUnits(res.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return res;
    },
    down: async (guild, member, byTag) => {
      const active = strikes.activeEntries(state, member.id);
      if (!active.length) return { ok: false };
      const r = await strikes.removeStrike(guild, member, state, active[active.length - 1].id, byTag);
      if (r.ok) await ownerlog.log(guild, { emoji: '➖', title: 'Strike removed', color: 0x57F287, detail: `Most recent strike from <@${member.id}> — by ${byTag}. Now ${strikes.formatUnits(r.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return r;
    },
    clear: async (guild, member, byTag) => {
      const r = await strikes.clearStrikes(guild, member, state, byTag);
      if (r.cleared) await ownerlog.log(guild, { emoji: '🧹', title: 'Strikes cleared', color: 0x57F287, detail: `All strikes (${r.cleared}) on <@${member.id}> — by ${byTag}.` });
      return r;
    },
    entries: member => strikes.activeEntries(state, member.id),
    label: entry => strikes.entryLabel(entry),
    removeById: async (guild, member, strikeId, byTag) => {
      const r = await strikes.removeStrike(guild, member, state, strikeId, byTag);
      if (r.ok) await ownerlog.log(guild, { emoji: '➖', title: 'Strike removed', color: 0x57F287, detail: `\`${strikeId}\` from <@${member.id}> — by ${byTag}. Now ${strikes.formatUnits(r.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return r;
    },
    setWeight: async (guild, member, strikeId, newWeight, byTag) => {
      const r = await strikes.setStrikeWeight(guild, member, state, strikeId, newWeight, byTag);
      if (r.ok) await ownerlog.log(guild, { emoji: r.removed ? '➖' : '⚖️', title: r.removed ? 'Strike removed' : 'Strike weight changed', color: 0x57F287,
        detail: `\`${strikeId}\` on <@${member.id}> — ${r.removed ? 'removed' : `${strikes.formatUnits(r.oldWeight)} → ${strikes.formatUnits(r.newWeight)} units`} — by ${byTag}. Now ${strikes.formatUnits(r.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return r;
    },
    activeMembers: () => strikes.activeMembers(state),
    format: strikes.formatUnits,
    // Reuses the SAME rule-picker → reason+weight-modal → addStrike flow already wired for the
    // watch-log/right-click Strike buttons (strike_rule_pick:/strike_reason: handlers below) — the
    // dashboard just needs to kick it off with channelId/messageId=0 (no specific flagged message).
    ruleRow: uid => ruleRow(`strike_rule_pick:${uid}:0:0`),
  } });

async function resolveChannels() {
  const guild = await client.guilds.fetch(config.guildId);
  verifyChannel = await guild.channels.fetch(config.verifyChannelId);
  if (!verifyChannel || !verifyChannel.threads) {
    throw new Error(`VERIFY_CHANNEL_ID ${config.verifyChannelId} is not a thread-capable text channel`);
  }
  alertChannel = config.alertChannelId === config.verifyChannelId
    ? verifyChannel
    : await guild.channels.fetch(config.alertChannelId);
  warnChannel = config.warnChannelId === config.verifyChannelId
    ? verifyChannel
    : await guild.channels.fetch(config.warnChannelId);
  conflictChannel = config.modConflictChannelId
    ? await guild.channels.fetch(config.modConflictChannelId).catch(() => null)
    : null;
}

// Report whether the bot actually holds every permission its actions require. Kick is a
// guild-level permission; the thread/message ones are checked in the specific channels. Logs a
// clear OK/MISSING table at boot so "ready for prod" is verified, not assumed.
async function checkPermissions() {
  const F = PermissionsBitField.Flags;
  const me = await verifyChannel.guild.members.fetch(client.user.id);
  const rows = [];
  const add = (name, has) => rows.push(`${has ? 'OK     ' : 'MISSING'}  ${name}`);

  add('Kick Members (server)', me.permissions.has(F.KickMembers));
  const vp = verifyChannel.permissionsFor(me);
  add('View Channel (verify)', vp.has(F.ViewChannel));
  add('Manage Threads (verify)', vp.has(F.ManageThreads));
  add('Send Messages in Threads (verify)', vp.has(F.SendMessagesInThreads));
  add('Read Message History (verify)', vp.has(F.ReadMessageHistory));
  add('Send Messages (warn channel)', warnChannel.permissionsFor(me).has(F.SendMessages));
  add('Send Messages (alert channel)', alertChannel.permissionsFor(me).has(F.SendMessages));
  if (conflictChannel) add('Send Messages (conflict channel)', conflictChannel.permissionsFor(me).has(F.SendMessages));

  console.log('[perms] capability check:\n  ' + rows.join('\n  '));
  const missing = rows.filter(r => r.startsWith('MISSING')).length;
  if (missing) console.warn(`[perms] ${missing} permission(s) MISSING — those actions will fail until granted`);
  else console.log('[perms] all required permissions present ✓');
  return missing;
}

// Self-heal: if the bot can't post in the verify channel but DOES have Manage Roles, grant itself
// Send Messages + Send Messages in Threads there via a channel permission overwrite. This is why
// the owner granted Manage Roles. Runs each boot but only acts when something is actually missing.
async function healPermissions() {
  const F = PermissionsBitField.Flags;
  const me = await verifyChannel.guild.members.fetch(client.user.id);
  const hasManageRoles = me.permissions.has(F.ManageRoles);

  // (channel, {threads}) → add a self-overwrite granting posting perms if the bot lacks them.
  const ensurePosting = async (channel, threads) => {
    if (!channel) return;
    const p = channel.permissionsFor(me);
    const need = !p.has(F.SendMessages) || (threads && !p.has(F.SendMessagesInThreads));
    if (!need) return;
    if (!hasManageRoles) {
      console.warn(`[perms] can't self-heal posting in #${channel.name} (no Manage Roles) — grant it or the perms manually`);
      return;
    }
    try {
      const grant = { ViewChannel: true, SendMessages: true };
      if (threads) grant.SendMessagesInThreads = true;
      await channel.permissionOverwrites.edit(client.user.id, grant,
        { reason: 'fubu-verify-bot self-heal: grant own posting perms' });
      console.log(`[perms] self-heal applied — granted the bot posting perms in #${channel.name}`);
    } catch (err) {
      console.error(`[perms] self-heal failed for #${channel.name}: ${err.message}`);
    }
  };

  await ensurePosting(verifyChannel, true);
  if (conflictChannel && conflictChannel.id !== verifyChannel.id) await ensurePosting(conflictChannel, false);
}

// Keep the mod-dashboard channel tidy (weekly): delete non-pinned messages; the pinned panel stays.
// Discord's bulkDelete only removes messages < 14 days old; older ones are left (rare for weekly).
async function cleanDashboard(guild) {
  if (!config.dashboardChannelId) return 0;
  const ch = await guild.channels.fetch(config.dashboardChannelId).catch(() => null);
  if (!ch) return 0;
  let panelId = null; // never delete the dashboard panel, pinned or not
  try { panelId = JSON.parse(require('fs').readFileSync(opspanel.PANEL_FILE, 'utf8')).messageId; } catch { /* no ref */ }
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs || !msgs.size) break;
    const del = [...msgs.values()].filter(m => !m.pinned && m.id !== panelId);
    if (!del.length) break;
    const done = await ch.bulkDelete(del, true).catch(e => { console.error('[dashclean]', e.message); return null; });
    const n = done ? done.size : 0;
    total += n;
    if (n < del.length) break; // remaining are >14d - stop
  }
  return total;
}
// Weekly gate: clean when it's been ≥7 days since the last clean (checked hourly + on boot).
async function dashCleanTick(guild) {
  const WEEK = 7 * 24 * 3600 * 1000;
  if (Date.now() - (state.getMeta('lastDashCleanTs') || 0) < WEEK) return;
  state.setMeta('lastDashCleanTs', Date.now());
  const n = await cleanDashboard(guild);
  if (n) console.log(`[dashclean] removed ${n} message(s) from mod-dashboard`);
}

// --- Member-facing bot guide: one embed, shown by /help AND kept as a single continuously-edited
// message in the server-guide channel (re-rendered on every startup so it never goes stale).
const GUIDE_FILE = process.env.FUBU_GUIDE_FILE || '/home/ubuntu/.fubu_guide.json';
const SERVER_GUIDE_CH = process.env.FUBU_SERVER_GUIDE_CHANNEL_ID || '1533511860459016314';   // #bot-guide (moved from #server-guide 2026-08-02)
function helpEmbed(guild) {
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle('🤖 What you can use the bot for')
    .setDescription('Most of these are **anonymous**. Use any of them in any channel:')
    .addFields(...features.memberHelp())
    .setFooter({ text: 'Be kind, keep it real. 💛' });
  const icon = guild.iconURL({ size: 128 });
  if (icon) e.setThumbnail(icon);
  return e;
}
async function ensureGuide(guild) {
  const ch = await guild.channels.fetch(SERVER_GUIDE_CH).catch(() => null);
  if (!ch) return;
  let ref = {}; try { ref = JSON.parse(fs.readFileSync(GUIDE_FILE, 'utf8')); } catch {}
  const embed = helpEmbed(guild);
  if (ref.messageId) {
    const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
    if (msg) { await msg.edit({ content: '', embeds: [embed] }).catch(() => {}); return; }
  }
  const msg = await ch.send({ embeds: [embed] });
  fs.writeFileSync(GUIDE_FILE, JSON.stringify({ channelId: ch.id, messageId: msg.id }));
}

client.once('ready', async () => {
  console.log(`fubu-verify-bot online as ${client.user.tag}`);
  console.log(`Guilds: ${client.guilds.cache.map(g => `${g.name} (${g.id})`).join(', ') || '(none)'}`);
  try {
    await resolveChannels();
    // type 0 = text, 15 = forum. We built for text-with-threads; warn if it's a forum.
    const typeName = verifyChannel.type === 0 ? 'text' : verifyChannel.type === 15 ? 'FORUM' : `type ${verifyChannel.type}`;
    console.log(`Verify channel: #${verifyChannel.name} (${verifyChannel.id}) [${typeName}]`);
    console.log(`Alert channel:  #${alertChannel.name} (${alertChannel.id})`);
    console.log(`Warn channel:   #${warnChannel.name} (${warnChannel.id})  [thread-less warnings]`);
    console.log(`Conflict channel: ${conflictChannel ? `#${conflictChannel.name} (${conflictChannel.id})` : '(none set)'}  [dual-role flags]`);
    if (verifyChannel.type === 15) {
      console.warn('[boot] NOTE: verify channel is a FORUM. Nudges post to the forum root, which may fail; tell the maintainer if nudges error.');
    }
  } catch (err) {
    console.error(`[boot] FATAL resolving channels: ${err.message}`);
    process.exit(1);
  }
  try {
    const missing = await checkPermissions();
    if (missing) { await healPermissions(); await checkPermissions(); } // fix + confirm
  } catch (err) { console.error(`[perms] check failed: ${err.message}`); }
  if (config.dryRun) {
    console.log('DRY_RUN=true — actions will be LOGGED, not performed. Set DRY_RUN=false to go live.');
  }
  verify.register(client, state, getVerifyChannel);
  sweep.register(client, state, { getVerifyChannel, getAlertChannel, getWarnChannel, getConflictChannel });

  // Ops dashboard: create/refresh the pinned tier-gated panel in the mod-only dashboard channel
  // (channel id persisted in the panel ref file). Light 5-min refresh keeps counts current.
  opspanel.ensurePanel(client).catch(err => console.error('[fops] init:', err.message));
  // Static staff command reference — its own pinned message at the top of #mod-dashboard (kept off the
  // Overview page so the live panel stays lean as the toolkit grows).
  opspanel.ensureCommandRef(client).catch(err => console.error('[fops] cmdref init:', err.message));
  // Every 60s: refresh the shared panel's live counts AND run the idle auto-return (so an abandoned
  // page snaps back to Overview within ~90–150s). The private /panel isn't affected.
  setInterval(() => opspanel.refreshPanel(client).catch(() => {}), 60 * 1000);

  // Fresh-account flag + influx detection: seed the self-calibration from current membership, then refresh
  // hourly so "newest N%" tracks the server's real growth (real-time joins are handled in guildMemberAdd).
  (async () => {
    const g = await client.guilds.fetch(config.guildId).catch(() => null);
    if (g) { await freshwatch.recompute(g); setInterval(() => freshwatch.recompute(g), 60 * 60 * 1000); }
  })();

  // Register the /corner and /uncorner slash commands to this guild (instant, no global wait).
  try {
    features.ensureSeeded(); // must run before allCmds is built - feature-gated options below read it
    const allCmds = [
      new SlashCommandBuilder().setName('corner').setDescription('Send a member to the corner: strips roles, pulls them from voice, jails them (optionally timed)')
        .addUserOption(o => o.setName('user').setDescription('Member to corner').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription(copy.corner.durationOpt).setRequired(false))
        .addStringOption(o => o.setName('rule').setDescription('Which rule did they break? (optional)').setRequired(false)
          .addChoices(...SERVER_RULES.map((r, i) => ({ name: `${i + 1}. ${r}`, value: String(i + 1) }))))
        .addStringOption(o => o.setName('reason').setDescription('Or type a custom reason (optional)').setRequired(false))
        .addStringOption(o => o.setName('also').setDescription('Corner more members too: @mention them or paste IDs, space-separated (same duration/reason)').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods lack ManageRoles but HAVE ModerateMembers; handler enforces trial restrictions
      new SlashCommandBuilder().setName('uncorner').setDescription('Release a member from the corner (or schedule a release)')
        .addUserOption(o => o.setName('user').setDescription('Member to release').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription(`Optional, e.g. release automatically instead of now`).setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods may release too (handler allows them)
      new SlashCommandBuilder().setName('cornered').setDescription('List everyone in the corner, with one-click release buttons')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods work the corner, so they need the list too
      new SlashCommandBuilder().setName('wordfilter').setDescription('Auto-delete messages containing a word/phrase for a period going forward')
        .addSubcommand(s => s.setName('add').setDescription('Start auto-deleting messages that contain a word/phrase')
          .addStringOption(o => o.setName('word').setDescription('The word or phrase to auto-delete').setRequired(true))
          .addStringOption(o => o.setName('duration').setDescription('How long, e.g. 30m, 2h, 3d (blank = until you remove it)').setRequired(false)))
        .addSubcommand(s => s.setName('list').setDescription('Show the active word filters'))
        .addSubcommand(s => s.setName('remove').setDescription('Stop an active word filter early')
          .addStringOption(o => o.setName('word').setDescription('The filtered word/phrase to stop').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
      new SlashCommandBuilder().setName('weights').setDescription('The staff infraction/weight guide: which rule = Corner / Strike (weight) / ban')
        .addBooleanOption(o => o.setName('pin').setDescription('Post it publicly here + pin it (admin only), for a channel trial mods can see').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods+ can pull the guide anywhere
      new SlashCommandBuilder().setName('levelcheck').setDescription('Check Arcane level roles are landing: flag (or fix) members missing earned level roles')
        .addBooleanOption(o => o.setName('fix').setDescription('Actually grant the missing level roles (admin only)').setRequired(false))
        .addIntegerOption(o => o.setName('scan').setDescription('Arcane log messages to scan (default 1500, max 3000)').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('stats').setDescription('A member’s moderation record: corners & strikes over a period')
        .addUserOption(o => o.setName('user').setDescription('Whose record to pull').setRequired(true))
        .addStringOption(o => o.setName('period').setDescription('How far back to count (default: 30 days)').setRequired(false)
          .addChoices({ name: 'Last 7 days', value: '7' }, { name: 'Last 30 days', value: '30' }, { name: 'Last 90 days', value: '90' }, { name: 'All time', value: 'all' }))
        .addStringOption(o => o.setName('visibility').setDescription('Show to just you (default) or everyone').setRequired(false)
          .addChoices({ name: 'Private (only you)', value: 'private' }, { name: 'Public (everyone)', value: 'public' }))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods+ can pull a record
      new SlashCommandBuilder().setName('pending').setDescription('Browse open verify threads (paginated)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods verify, so they need /pending too
      // No Discord-level perm gate: trial mods (who lack Manage Roles) need to reach it too. The handler
      // gates — mod+ get the full panel, trial mods get the read-only view, everyone else is refused.
      new SlashCommandBuilder().setName('panel').setDescription('Open your private FUBU control panel (only you see it)').setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID (optionally re-watchlist on rejoin)')
        .addStringOption(o => o.setName('user_id').setDescription("The banned user's ID, start typing a name to search").setRequired(true).setAutocomplete(true))
        .addBooleanOption(o => o.setName('watchlist').setDescription('Give them the Watchlist role when they rejoin'))
        .addStringOption(o => o.setName('reason').setDescription('Audit-log reason'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers),
      new SlashCommandBuilder().setName('watchlist').setDescription('Manage the Watchlist role on members')
        .addSubcommand(s => s.setName('add').setDescription('Put a member on the Watchlist').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Take a member off the Watchlist').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List everyone on the Watchlist'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('watchlist-terms').setDescription('Manage flagged terms: strict / loose / welfare')
        .addSubcommand(s => s.setName('add').setDescription('Flag a word or phrase')
          .addStringOption(o => o.setName('term').setDescription('Word or phrase').setRequired(true))
          .addStringOption(o => o.setName('scope').setDescription('Which list (default strict)').addChoices({ name: 'strict: watchlist ban alerts', value: 'strict' }, { name: 'loose: day-to-day watch-log', value: 'loose' }, { name: 'welfare: support check-ins', value: 'welfare' })))
        .addSubcommand(s => s.setName('remove').setDescription('Unflag a word or phrase')
          .addStringOption(o => o.setName('term').setDescription('Word or phrase').setRequired(true))
          .addStringOption(o => o.setName('scope').setDescription('Which list (default strict)').addChoices({ name: 'strict', value: 'strict' }, { name: 'loose', value: 'loose' }, { name: 'welfare', value: 'welfare' })))
        .addSubcommand(s => s.setName('list').setDescription('List flagged terms')
          .addStringOption(o => o.setName('scope').setDescription('Which list (default all)').addChoices({ name: 'strict', value: 'strict' }, { name: 'loose', value: 'loose' }, { name: 'welfare', value: 'welfare' })))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('watchlist-suggest').setDescription('Scan recent messages and recommend new watchlist terms')
        .addIntegerOption(o => o.setName('hours').setDescription('How far back to scan (default 6, max 24)').setMinValue(1).setMaxValue(24))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('grade').setDescription('Grade a smart-watch card by its ID: trains the judge (owner only)')
        .addStringOption(o => o.setName('id').setDescription('The grade id shown on the card').setRequired(true))
        .addStringOption(o => o.setName('verdict').setDescription('Your call').setRequired(true).addChoices(
          { name: '🔨 Strike-worthy', value: 'strike' }, { name: '⛓️ Corner-only', value: 'corner' },
          { name: '👁️ Surface, no action', value: 'glance' }, { name: '⬜ Fine (hide)', value: 'fine' },
          { name: '🫂 Genuine distress (welfare)', value: 'genuine' }, { name: '⬜ Hyperbole (welfare hide)', value: 'hyperbole' }))
        .addStringOption(o => o.setName('note').setDescription('Optional: the correct read (teaches the judge its reasoning)').setRequired(false).setMaxLength(300))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('perms').setDescription('Permission inspector & audit (bot owner only)')
        .addSubcommand(s => s.setName('tier').setDescription('What a whole tier can see')
          .addStringOption(o => o.setName('tier').setDescription('Which tier').setRequired(true).addChoices(
            { name: 'Regular member', value: 'member' }, { name: 'Trial mod', value: 'trial' }, { name: 'Mod', value: 'mod' }, { name: 'Admin', value: 'admin' }, { name: 'Owner', value: 'owner' })))
        .addSubcommand(s => s.setName('channel').setDescription('Who can see/use one channel')
          .addChannelOption(o => o.setName('channel').setDescription('Channel to inspect').setRequired(true)))
        .addSubcommand(s => s.setName('audit').setDescription('Full permission audit: leaks, dangerous perms, exposure'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

      new SlashCommandBuilder().setName('suggest').setDescription('Post a suggestion to the suggestions forum')
        .addStringOption(o => o.setName('text').setDescription('Your suggestion').setRequired(true).setMaxLength(500))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('suggest-setup').setDescription('Create/repair the bot-gated suggestions forum (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

      new SlashCommandBuilder().setName('confess').setDescription('Send an anonymous confession')
        .addStringOption(o => o.setName('text').setDescription('Your confession (your name is hidden from other members)').setRequired(true).setMaxLength(1000))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('confess-setup').setDescription('Create/repair the confessions + staff log channels (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),


      new SlashCommandBuilder().setName('whistleblow').setDescription('Privately DM a problem about the server/staff to the top, no channel, admins can’t snoop')
        .addStringOption(o => o.setName('to').setDescription('Who it goes to / who may unmask you').setRequired(true)
          .addChoices({ name: 'Head admin only', value: 'you' }, { name: 'Server owner only', value: 'her' },
            { name: 'Both', value: 'both' }, { name: 'Anonymous: both see it, no one can unmask', value: 'anonymous' }))
        .addStringOption(o => o.setName('text').setDescription('What’s the problem?').setRequired(true).setMaxLength(1500))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('whistleblow-setup').setDescription('Set who receives whistleblows (bot owner only)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

      new SlashCommandBuilder().setName('report').setDescription('Anonymously report a member to staff')
        .addStringOption(o => o.setName('text').setDescription('What happened?').setRequired(true).setMaxLength(1000))
        .addUserOption(o => o.setName('user').setDescription('Who are you reporting? (optional)'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('report-setup').setDescription('Create the anon-reports channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('modmail').setDescription('Send an anonymous message to the mod team')
        .addStringOption(o => o.setName('text').setDescription('Your message').setRequired(true).setMaxLength(1000))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('modmail-setup').setDescription('Create the mod-inbox channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

      new SlashCommandBuilder().setName('apply-mod').setDescription('Apply to become a moderator').setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('apply-mod-setup').setDescription('Create the private mod-applications forum (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('mod-applications').setDescription('Open or close mod applications when the team is full (admin)')
        .addSubcommand(s => s.setName('status').setDescription('Are mod applications open or closed right now?'))
        .addSubcommand(s => s.setName('open').setDescription('Reopen mod applications: accept new /apply-mod again'))
        .addSubcommand(s => s.setName('close').setDescription('Close mod applications (team full); in-flight applications still finish')
          .addStringOption(o => o.setName('message').setDescription('Optional custom note shown to members who try to apply').setRequired(false).setMaxLength(400)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('staff').setDescription('Staff roster: each tier’s count + members (@ · username · user id)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('promote-trial').setDescription('Open a promotion vote for a trial mod (posts in mod-announcements)')
        .addStringOption(o => o.setName('member').setDescription('The trial mod to consider for full Mod').setRequired(true).setAutocomplete(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('promote-mod').setDescription('Open a promotion vote for a mod → admin (posts in admin-discussion)')
        .addStringOption(o => o.setName('member').setDescription('The mod to consider for Admin').setRequired(true).setAutocomplete(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('demote-trial').setDescription('Remove the Trial Mod role from a member (owner)')
        .addStringOption(o => o.setName('member').setDescription('The trial mod to demote').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('reason').setDescription('Optional note, kept internal').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

      // #roles picker management — one-up on the old Carl-bot setup: add/remove a self-assign role in a
      // section with one command, no manual message editing (admin).
      new SlashCommandBuilder().setName('roleselect-role').setDescription('Add or remove a self-assign role in #roles (admin)')
        .addSubcommand(s => s.setName('add').setDescription('Add a role to a #roles section')
          .addStringOption(o => o.setName('section').setDescription('Which section').setRequired(true)
            .addChoices({ name: 'Region', value: 'region' }, { name: 'Language', value: 'language' },
              { name: 'Notifications', value: 'notifications' }, { name: 'Pronouns', value: 'pronouns' }, { name: 'Misc', value: 'misc' }))
          .addRoleOption(o => o.setName('role').setDescription('The role to add').setRequired(true))
          .addStringOption(o => o.setName('label').setDescription('Button text (default: the role name, add your own emoji if you want one)').setRequired(false)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a role from a #roles section')
          .addStringOption(o => o.setName('section').setDescription('Which section').setRequired(true)
            .addChoices({ name: 'Region', value: 'region' }, { name: 'Language', value: 'language' },
              { name: 'Notifications', value: 'notifications' }, { name: 'Pronouns', value: 'pronouns' }, { name: 'Misc', value: 'misc' }))
          .addRoleOption(o => o.setName('role').setDescription('The role to remove').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

      new SlashCommandBuilder().setName('request-role').setDescription('Request a casual role, staff approves it')
        .addRoleOption(o => o.setName('role').setDescription('The role you want (or already have, if removing)').setRequired(true))
        .addBooleanOption(o => o.setName('remove').setDescription('Request to give this role UP instead of getting it (default: no)').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('request-role-setup').setDescription('Create the role-requests channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

      // Appeals — unified /appeal ban|strike. Each subcommand is gated by its OWN feature flag
      // ('appeals' for ban, 'strikeAppeals' for strike — see the gate check near the interaction
      // handler, and the comment in features.js on why one command needs two flags).
      new SlashCommandBuilder().setName('appeal').setDescription('Appeal a ban (for a friend) or one of your own strikes')
        .addSubcommand(s => s.setName('ban').setDescription('Appeal a ban on a friend’s behalf, opens a private thread')
          .addStringOption(o => o.setName('username').setDescription('The banned person’s @username').setRequired(true))
          .addStringOption(o => o.setName('note').setDescription('Optional: a line to open the appeal with').setRequired(false)))
        .addSubcommand(s => s.setName('strike').setDescription('Appeal one of your own strikes, alone. Opens a private thread')
          .addStringOption(o => o.setName('strike_id').setDescription('Which strike, pick from your own active strikes').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('note').setDescription('Optional: a line to open the appeal with').setRequired(false)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('appeal-setup').setDescription('Create the ban-appeals channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('appeal-reset').setDescription('Clear a decided ban-appeal so the person can be appealed again (admin)')
        .addStringOption(o => o.setName('user').setDescription('The banned person’s @username or user ID').setRequired(true).setAutocomplete(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),   // admin ROLE, not the Administrator perm
      new SlashCommandBuilder().setName('appeal-strike-setup').setDescription('Create the strike-appeals channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

      new SlashCommandBuilder().setName('help').setDescription('What can this bot do? The member features').setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('dashboard').setDescription('Your member hub: status, server info, and every member feature')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('dashboard-setup').setDescription('Post + pin the public member hub panel in this channel (admin)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),   // admin ROLE, not the Administrator perm
      new SlashCommandBuilder().setName('tribe').setDescription('Your tribe: info, roster, standings, and (leaders) set the motto')
        .addSubcommand(s => s.setName('info').setDescription('A tribe’s overview (yours by default)')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe (default: yours)').setRequired(false).setAutocomplete(true)))
        .addSubcommand(s => s.setName('motto').setDescription('Set your tribe’s motto (leaders only)')
          .addStringOption(o => o.setName('text').setDescription('The motto').setRequired(true)))
        .addSubcommand(s => s.setName('banner').setDescription('Set your tribe’s banner image (leaders; members make the art)')
          .addAttachmentOption(o => o.setName('image').setDescription('A banner image (PNG/JPG). Leave blank to clear it.').setRequired(false)))
        .addSubcommand(s => s.setName('invite').setDescription('Add a member to your tribe (leaders only)')
          .addUserOption(o => o.setName('user').setDescription('Who to bring into the tribe').setRequired(true)))
        .addSubcommand(s => s.setName('nominate').setDescription('Propose a member to join YOUR tribe (any member can; head/staff approve, they accept)')
          .addUserOption(o => o.setName('user').setDescription('Who to nominate').setRequired(true)))
        .addSubcommand(s => s.setName('offer').setDescription('Convert your OWN activity points into your tribe’s treasury (1:1, never demotes you)')
          .addIntegerOption(o => o.setName('amount').setDescription('How many to offer').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s.setName('muster').setDescription('Call a roll-call: members who answer earn the tribe treasury + glory (leaders only)'))
        .addSubcommand(s => s.setName('retheme').setDescription('Recolour and/or rename your tribe (needs the Re-theme unlock; leaders only)')
          .addStringOption(o => o.setName('color').setDescription('Primary colour hex, e.g. #2A426A').setRequired(true))
          .addStringOption(o => o.setName('color2').setDescription('Second hex for a gradient (optional)').setRequired(false))
          .addStringOption(o => o.setName('name').setDescription('New full tribe name (optional)').setRequired(false).setMaxLength(80))
          .addStringOption(o => o.setName('short_name').setDescription('New short name for cards (optional)').setRequired(false).setMaxLength(40)))
        .addSubcommand(s => s.setName('icon').setDescription('Set an emoji OR image icon on your tribe role (needs the Tribe Icon unlock; leaders only)')
          .addStringOption(o => o.setName('emoji').setDescription('An emoji for the icon (or "none" to clear)').setRequired(false).setMaxLength(60))
          .addAttachmentOption(o => o.setName('image').setDescription('A square image (PNG/JPG, under 256KB) to use as the icon').setRequired(false)))
        .addSubcommand(s => s.setName('banish').setDescription('Remove a member from your tribe (leaders only)')
          .addUserOption(o => o.setName('user').setDescription('Who to remove from the tribe').setRequired(true)))
        .addSubcommand(s => s.setName('announce').setDescription('Post to your throne and rally the tribe (leaders only)')
          .addStringOption(o => o.setName('message').setDescription('The announcement').setRequired(true)))
        .addSubcommand(s => s.setName('note').setDescription('Jot or read a private note on a member (leaders only)')
          .addUserOption(o => o.setName('user').setDescription('Which member').setRequired(true))
          .addStringOption(o => o.setName('text').setDescription('The note, leave blank to read existing notes').setRequired(false)))
        .addSubcommand(s => s.setName('rank').setDescription('Set a member’s rank by hand (leaders only)')
          .addUserOption(o => o.setName('user').setDescription('Member to rank').setRequired(true))
          .addStringOption(o => o.setName('rank').setDescription('Which rank').setRequired(true).setAutocomplete(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('tribe-admin').setDescription('Create or register tribes (admin)')
        .addSubcommand(s => s.setName('create').setDescription('Found a brand-new tribe: opens a guided setup (identity, colours, land)')
          .addUserOption(o => o.setName('leader').setDescription('The tribe leader: an admin, or a mod naming themselves').setRequired(true)))
        .addSubcommand(s => s.setName('hub-setup').setDescription('Create (or refresh) the Tribes Hub reference + button channel'))
        .addSubcommand(s => s.setName('register').setDescription('Adopt an EXISTING role + channels as a tribe')
          .addStringOption(o => o.setName('key').setDescription('Short key, e.g. valith').setRequired(true))
          .addStringOption(o => o.setName('name').setDescription('Full tribe name').setRequired(true))
          .addRoleOption(o => o.setName('role').setDescription('The tribe member role').setRequired(true))
          .addRoleOption(o => o.setName('leader_role').setDescription('The leader role (optional)').setRequired(false))
          .addChannelOption(o => o.setName('hall').setDescription('Main tribe channel (optional)').setRequired(false))
          .addStringOption(o => o.setName('emoji').setDescription('Tribe emoji (optional)').setRequired(false)))
        .addSubcommand(s => s.setName('arena').setDescription('Launch an interactive cross-tribe challenge in this channel (winner banks Glory + Treasury)')
          .addStringOption(o => o.setName('type').setDescription('Which challenge').setRequired(true)
            .addChoices({ name: '🏁 Reaction Race', value: 'race' }, { name: '❓ Trivia Sprint', value: 'trivia' }, { name: '🔤 Word Scramble', value: 'scramble' }, { name: '⚡ Activity Blitz', value: 'blitz' },
              { name: '➗ Math Sprint', value: 'math' }, { name: '⌨️ Fast Fingers', value: 'typing' }, { name: '🧩 Riddle Rush', value: 'riddle' }, { name: '🧠 Emoji Decode', value: 'emoji' }, { name: '✅ True or False', value: 'truefalse' }, { name: '🎯 Reaction Rush', value: 'reaction' }, { name: '🔢 Number Pattern', value: 'pattern' },
              { name: '🌍 Geography Quiz', value: 'geoquiz' }, { name: '🔬 Science Quiz', value: 'sciquiz' }, { name: '📜 History Quiz', value: 'histquiz' }, { name: '🦁 Animal Quiz', value: 'animalquiz' }, { name: '🔁 Reverse Word', value: 'reverse' }))
          .addIntegerOption(o => o.setName('minutes').setDescription('How long (default varies by type)').setRequired(false).setMinValue(1).setMaxValue(120)))
        .addSubcommand(s => s.setName('set-leader').setDescription('Add or replace a tribe leader (restructure a tribe that lost one)')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addUserOption(o => o.setName('member').setDescription('The new leader (also joins the tribe if not already in it)').setRequired(true))
          .addUserOption(o => o.setName('replacing').setDescription('Optional: an existing leader to step down at the same time').setRequired(false)))
        .addSubcommand(s => s.setName('points').setDescription('Set what a tribe calls its activity points, e.g. Tides')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('name').setDescription('The name for its points, e.g. Tides').setRequired(true).setMaxLength(20)))
        .addSubcommand(s => s.setName('title').setDescription('Set what a tribe calls its head, e.g. Warden')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('name').setDescription('The head title, e.g. Warden').setRequired(true).setMaxLength(40)))
        .addSubcommand(s => s.setName('staffrank-set').setDescription('Set what a tribe calls staff who join as members, e.g. General (default: General)')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('name').setDescription('The staff-rank title, e.g. General').setRequired(true).setMaxLength(40)))
        .addSubcommand(s => s.setName('ranks').setDescription('Rename a tribe’s four rank rungs, lowest to highest')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('rank1').setDescription('Lowest rank name').setRequired(true).setMaxLength(40))
          .addStringOption(o => o.setName('rank2').setDescription('Second rank name').setRequired(true).setMaxLength(40))
          .addStringOption(o => o.setName('rank3').setDescription('Third rank name').setRequired(true).setMaxLength(40))
          .addStringOption(o => o.setName('rank4').setDescription('Highest rank name').setRequired(true).setMaxLength(40)))
        .addSubcommand(s => s.setName('grant').setDescription('Manually award treasury or glory (stopgap until contests auto-wire)')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('meter').setDescription('Which meter').setRequired(true)
            .addChoices({ name: 'Treasury (permanent bank)', value: 'treasury' }, { name: 'Glory (this week, decides the crown)', value: 'glory' }))
          .addIntegerOption(o => o.setName('amount').setDescription('How much (negative to correct a mistake)').setRequired(true)))
        .addSubcommand(s => s.setName('gate-set').setDescription('Set an entrance question new members must answer correctly to self-join')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('prompt').setDescription('The question/prompt shown to applicants').setRequired(true).setMaxLength(200))
          .addStringOption(o => o.setName('option_a').setDescription('First choice').setRequired(true).setMaxLength(80))
          .addStringOption(o => o.setName('option_b').setDescription('Second choice').setRequired(true).setMaxLength(80))
          .addStringOption(o => o.setName('correct').setDescription('Which is correct').setRequired(true)
            .addChoices({ name: 'Option A', value: 'a' }, { name: 'Option B', value: 'b' })))
        .addSubcommand(s => s.setName('gate-clear').setDescription('Remove a tribe’s entrance question (self-join goes back to instant)')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),   // visible to the ADMINS-★ role; handler gates on canWLAdmin

      new SlashCommandBuilder().setName('strike').setDescription('Manage a member’s strikes: weighted units, bans at 10')
        .addSubcommand(s => s.setName('view').setDescription('See a member’s current units + strike history')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(s => s.setName('add').setDescription('Give a strike')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
          .addStringOption(o => o.setName('rule').setDescription('Which rule (pick a rule, a reason, or both)').setRequired(false)
            .addChoices(...SERVER_RULES.map((r, i) => ({ name: `${i + 1}. ${r}`, value: String(i + 1) }))))
          .addStringOption(o => o.setName('reason').setDescription('Why: posted publicly, no DMs (pick a rule, a reason, or both)').setRequired(false))
          .addIntegerOption(o => o.setName('weight').setDescription('Severity, omit to use the picked rule’s decided weight').setRequired(false)
            .addChoices({ name: '1: minor', value: 1 }, { name: '2: moderate', value: 2 }, { name: '3: severe', value: 3 }))
          .addStringOption(o => o.setName('timeout').setDescription('Attach a native Discord timeout, e.g. 30m/2h/3d, adds bonus units (linear by length, capped at +2)').setRequired(false))
          .addStringOption(o => o.setName('corner').setDescription('Also send them to the Corner for this long, e.g. 30m/2h/30s, strips roles, restored on release').setRequired(false)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove ONE specific strike, start typing to search their strikes')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
          .addStringOption(o => o.setName('strike_id').setDescription('Which strike, pick from the list').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('clear').setDescription('Remove ALL of a member’s active strikes')
          .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('verify').setDescription('Verify a member, no need to open the panel')
        .addUserOption(o => o.setName('user').setDescription('Member to verify').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new SlashCommandBuilder().setName('features').setDescription('View or toggle bot features (Owner only)')
        .addSubcommand(s => s.setName('list').setDescription('Show every feature and whether it’s on'))
        .addSubcommand(s => s.setName('toggle').setDescription('Turn a feature on or off')
          .addStringOption(o => o.setName('feature').setDescription('Which feature').setRequired(true).setAutocomplete(true))   // autocomplete, not choices: Discord caps choices at 25 and the registry outgrew it
          .addBooleanOption(o => o.setName('on').setDescription('On or off').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('permguard').setDescription('Permission-drift guard (Owner only)')
        .addSubcommand(s => s.setName('status').setDescription('Run a sweep now and show what it found (no changes made silently. This DOES fix drift)'))
        .addSubcommand(s => s.setName('resnapshot').setDescription('Review changes since the baseline, then keep/undo each before saving')
          .addBooleanOption(o => o.setName('force').setDescription('Skip the review and blindly adopt current permissions (old behaviour)').setRequired(false)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      // Monthly contests — management (organizers have the ManageEvents guild perm, so this shows to
      // them + admins + owner natively). The member-facing /contest-submit is separate + ungated.
      new SlashCommandBuilder().setName('contest').setDescription('Run the monthly community contests (organizers/staff)')
        .addSubcommand(s => s.setName('setup').setDescription('Create the contest channels + winner role and post the rules'))
        .addSubcommand(s => s.setName('start').setDescription('Open a new monthly round with a theme')
          .addStringOption(o => o.setName('theme').setDescription('This month\'s theme, e.g. "summer vacations"').setRequired(true).setMaxLength(120))
          .addStringOption(o => o.setName('contests').setDescription('Which contests (default: all three)')
            .addChoices({ name: 'All three', value: 'all' }, { name: 'Drawing only', value: 'drawing' },
              { name: 'Photography only', value: 'photography' }, { name: 'Writing only', value: 'writing' },
              { name: 'Drawing + Photography', value: 'drawing,photography' })))
        .addSubcommand(s => s.setName('status').setDescription('Show the current theme, entry counts and 🩷 leaders'))
        .addSubcommand(s => s.setName('end').setDescription('Close the round now: tally 🩷, crown winners, assign the role'))
        .addSubcommand(s => s.setName('reveal').setDescription('See the real submitter of every entry, incl. anonymous (private, for awarding)'))
        .addSubcommand(s => s.setName('panel').setDescription('Open the event organizer dashboard (buttons)'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageEvents),
      new SlashCommandBuilder().setName('contest-submit').setDescription('Enter this month\'s contest anonymously (your name stays hidden)')
        .addStringOption(o => o.setName('contest').setDescription('Which contest').setRequired(true)
          .addChoices({ name: '🎨 Drawing', value: 'drawing' }, { name: '📸 Photography', value: 'photography' }, { name: '✍️ Writing', value: 'writing' }))
        .addAttachmentOption(o => o.setName('image').setDescription('Your entry image (Drawing/Photography, required there)').setRequired(false))
        .addStringOption(o => o.setName('text').setDescription('Your written entry (Writing)').setRequired(false).setMaxLength(2000))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new ContextMenuCommandBuilder().setName('Report to watchlist').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Send to corner').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Strike').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Report').setType(ApplicationCommandType.Message).setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),   // member-facing anon report
    ];
    // Only register commands whose feature is enabled (fail-off). Disabled features' commands
    // simply don't appear in the server. (Seeded above, before allCmds was built.)
    const enabledNames = features.enabledCommandNames();
    const cmds = allCmds.filter(b => enabledNames.has(b.name)).map(c => c.toJSON());
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(cmds);
    console.log(`[features] registered ${cmds.length}/${allCmds.length} commands (disabled features hidden): ${[...enabledNames].sort().join(', ')}`);
    await ensureGuide(guild).catch(e => console.error('[guide]', e.message));
  } catch (err) {
    console.error(`[corner] command registration failed: ${err.message}`);
  }

  // Self-heal the corner role's channel permissions on boot (in case someone changed them).
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const fixed = await corner.ensureCornerPerms(guild);
    console.log(`[corner] perm self-heal on boot: ${fixed} overwrite(s) corrected`);
  } catch (err) {
    console.error(`[corner] perm self-heal failed: ${err.message}`);
  }

  // Upgrade any mod-app votes cast before weighted voting shipped (plain IDs -> {id, weight}), so an
  // owner/admin's earlier vote gets its proper weight without them needing to re-click. Idempotent.
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const upgraded = await modapps.upgradeLegacyVotes(guild);
    console.log(`[modapps] vote-weight self-heal on boot: ${upgraded} open application(s) upgraded`);
    // Backfill the ↩️ Undo button onto applications resolved before it existed. Idempotent.
    const undoAdded = await modapps.backfillUndoButtons(guild);
    console.log(`[modapps] undo-button backfill on boot: ${undoAdded} resolved application(s) updated`);
    // Sweep every review thread for anyone below mod+ (catches manual adds made while the bot was
    // offline, or from before this enforcement existed). Idempotent.
    const nonStaffRemoved = await modapps.sweepReviewThreadMembers(guild);
    console.log(`[modapps] review-thread membership sweep on boot: ${nonStaffRemoved} non-staff member(s) removed`);
  } catch (err) {
    console.error(`[modapps] vote-weight self-heal failed: ${err.message}`);
  }

  // Seed weighted-strike ledger entries for members still holding a Strike I/II/III role from before
  // this model shipped, so nobody's standing gets erased or reset by the switch. Idempotent.
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const seeded = await strikes.migrateLegacyStrikes(guild, state);
    console.log(`[strikes] legacy migration: ${seeded} member(s) seeded`);
    // Re-sync everyone onto the per-unit strike roles (Strike 1..9). Idempotent.
    const resynced = await strikes.resyncTierRoles(guild, state);
    console.log(`[strikes] per-unit role resync: ${resynced} member(s) updated`);
    // Tier auto-nest sweep: owner⊇admin⊇mod, strip Trial Mod from mod+. Idempotent.
    await ensureMembers(guild);
    let nested = 0;
    for (const m of guild.members.cache.values()) if (await enforceTierNesting(m)) nested++;
    console.log(`[tier-nest] boot sweep: ${nested} staff member(s) nested`);
    // Refresh the public "open appeals" boards pinned in the base channels.
    if (features.enabled('appeals')) await appeals.ensureBoard(guild).catch(e => console.error('[appeals board]', e.message));
    if (features.enabled('strikeAppeals')) await strikeAppeals.ensureBoard(guild).catch(e => console.error('[strikeAppeals board]', e.message));
    console.log('[appeals] open-appeals boards refreshed');
    // Owner-only log: bot actions (hooked at each action site) + a mirrored, curated server audit log.
    await ownerlog.ensureChannel(guild).catch(e => console.error('[ownerlog] channel init:', e.message));
    ownerlog.register(client);
    // Permission-drift guard: reconcile every channel's ROLE overwrites against the golden manifest
    // snapshot (see permguard.js) — catches the "channel overwrite silently stopped inheriting the
    // category's deny-by-default" class of bug (found 2026-07-30, #mod-announcements) automatically.
    const permResult = await permguard.sweepPermissions(guild, { notify: false }).catch(e => { console.error('[permguard] boot sweep failed:', e.message); return null; });
    if (permResult) console.log(`[permguard] boot sweep: ${permResult.fixed} overwrite(s) corrected, ${permResult.newMemberOverwrites.length} new member-overwrite(s) flagged, ${permResult.unmanagedChannels} channel(s) unmanaged (created after snapshot)`);
    permguard.register(client);
    // Monthly contests: arm the auto-close tick (crowns winners on the 1st of the month if a round's open).
    if (features.enabled('contest')) contest.register(client);
    // Sweep every current staff member's own application: mod+ gets archived (owner-only channel, removed
    // from the forum), trial-only gets sealed (removed from their applicant thread). Keeps history either way.
    let archived = 0, sealed = 0;
    for (const m of guild.members.cache.values()) {
      if (opspanel.memberTier(m)) archived += await modapps.archiveOwnApplication(guild, m.id).catch(() => 0);
      else if (m.roles.cache.has(config.trialModRoleId)) sealed += await modapps.sealOwnApplication(guild, m.id).catch(() => 0);
    }
    console.log(`[modapps] own-application sweep: ${archived} archived (mod+), ${sealed} sealed (trial)`);
  } catch (err) {
    console.error(`[strikes] legacy migration failed: ${err.message}`);
  }

  // Backfill sweep: auto-corner + delete any threads opened in general/chat channels BEFORE the
  // auto-corner-on-thread rule shipped. Idempotent — a no-op on every boot after the first.
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const swept = await sweepExistingAutoCornerThreads(guild);
    console.log(`[auto-corner-thread] backfill sweep: ${swept} pre-existing thread(s) handled`);
  } catch (err) {
    console.error(`[auto-corner-thread] backfill sweep failed: ${err.message}`);
  }

  // Auto-release expired corners every minute (survives restarts via state), announcing each in the
  // corner channel ("time served") — otherwise a timed release is silent.
  // Precise release: each timed corner arms its own setTimeout (corner.js) that calls this handler at
  // exactly its time. Guarded so a timer + the backstop poller can't double-release/announce the same member.
  corner.setReleaseHandler(releaseCornerAndAnnounce);
  client.guilds.fetch(config.guildId).then(g => { const n = corner.rearmAll(g, state); if (n) console.log(`[corner] re-armed ${n} release timer(s) on boot`); }).catch(() => {});
  // Backstop poller (per-corner timers are the primary mechanism now): catches corners orphaned by a
  // restart before re-arm, or any set >24.8d out. Idempotent via releaseCornerAndAnnounce's guard.
  setInterval(async () => {
    try {
      const guild = await client.guilds.fetch(config.guildId);
      const now = Date.now();
      for (const [uid, rec] of Object.entries(state.listCornered())) {
        if (rec.releaseAt && rec.releaseAt <= now) await releaseCornerAndAnnounce(guild, uid);
      }
    } catch (err) { console.error(`[corner] release backstop: ${err.message}`); }
  }, 60 * 1000);

  // Weekly mod-dashboard tidy (catch-up on boot if due, then hourly gate check).
  const dguild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (dguild) await dashCleanTick(dguild).catch(() => {});
  setInterval(() => client.guilds.fetch(config.guildId).then(g => dashCleanTick(g)).catch(() => {}), 3600000);

  // MDNI (18+) enforcement backstop: strip MDNI from any non-adult holder on boot, then hourly.
  // Real-time enforcement is guildMemberUpdate; this catches pre-existing holders + missed events.
  if (dguild) await sweepMdni(dguild).catch(e => console.error(`[mdni] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepMdni(g)).catch(() => {}), 3600000);
  // MDNI minor-STAFF lock: a minor with a staff role sees MDNI via the role allow (role-deny can't stop it) —
  // maintain member-level denies for them. Boot + hourly, same cadence.
  if (dguild) await sweepMdniStaffLock(dguild).catch(e => console.error(`[mdni-lock] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepMdniStaffLock(g)).catch(() => {}), 3600000);

  // Weekly tribe crown: boot catch-up + hourly check (idempotent — see tribes.dueForWeeklyCrown).
  if (dguild) await processWeeklyCrownIfDue(dguild).catch(e => console.error(`[tribe crown] boot check: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => processWeeklyCrownIfDue(g)).catch(() => {}), 3600000);
  // Season end: boot catch-up + hourly check (idempotent — ensureSeason opens S1, dueForSeasonEnd gates it).
  if (dguild) await processSeasonEndIfDue(dguild).catch(e => console.error(`[tribe season] boot check: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => processSeasonEndIfDue(g)).catch(() => {}), 3600000);
  // Recruitment payouts: boot catch-up + hourly (gated inside; the stick period is days, so hourly is ample).
  if (dguild) await sweepRecruitment(dguild).catch(e => console.error(`[recruitment] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepRecruitment(g)).catch(() => {}), 3600000);
  // Muster auto-close: boot catch-up + every 5min (a muster's 2h window makes a tighter cadence worth it).
  if (dguild) await sweepExpiredMusters(dguild).catch(e => console.error(`[tribe muster] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepExpiredMusters(g)).catch(() => {}), 5 * 60 * 1000);
  if (dguild) await sweepExpiredWarVotes(dguild).catch(e => console.error(`[tribe war] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepExpiredWarVotes(g)).catch(() => {}), 5 * 60 * 1000);
  // Auto-resolve wars stuck ≥24h awaiting the defender's Accept/Decline (boot + hourly).
  if (dguild) await sweepStuckWars(dguild).catch(e => console.error(`[tribe war] stuck sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepStuckWars(g)).catch(() => {}), 3600000);
  if (dguild) await sweepExpiredAllianceVotes(dguild).catch(e => console.error(`[tribe alliance] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepExpiredAllianceVotes(g)).catch(() => {}), 5 * 60 * 1000);
  // #roles self-heal: drop any toggle button whose role was deleted outside the bot's control (boot + hourly).
  const roleselectSweep = async g => { const removed = await roleselect.sweepDeadRoles(g, config.rolesChannelId); const n = Object.values(removed).flat().length; if (n) console.log(`[roleselect] sweep: removed ${n} dead role(s) — ${JSON.stringify(removed)}`); };
  if (dguild) await roleselectSweep(dguild).catch(e => console.error(`[roleselect] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(roleselectSweep).catch(() => {}), 3600000);
  // Tribe "General" (staff auto-rank) drift: boot catch-up + hourly (catches later promotions/demotions).
  // Refresh the Tribes Hub pinned message on boot so its content stays in sync with the code (idempotent —
  // edits the same tracked message; no-op if the channel/message is gone until someone re-runs hub-setup).
  if (dguild && tribes.getHubInfo()) await ensureTribesHub(dguild, config).catch(e => console.error(`[tribe hub] boot refresh: ${e.message}`));
  // Ensure the tribe-announcements channel exists (created once, above the hub).
  if (dguild && tribes.getHubInfo()) await ensureTribeAnnounce(dguild, config).catch(e => console.error(`[tribe announce] boot ensure: ${e.message}`));
  // Refresh every tribe's throne panel on boot too, so button/layout changes go live on deploy.
  if (dguild) for (const t of tribes.all()) await refreshThronePanel(dguild, t).catch(e => console.error(`[tribe throne] boot refresh ${t.key}: ${e.message}`));
  // An arena challenge left active by a pre-restart crash is resolved early (see reconcileArena).
  if (dguild) await reconcileArena(dguild).catch(e => console.error(`[arena] boot reconcile: ${e.message}`));
  // Auto-start random arenas through the active day (owner). Checked every 15 min; the random next-auto time
  // (1h..2h after each event), the 1h floor + daily cap (via arena.startBlocked) keep it from over-firing.
  setInterval(() => client.guilds.fetch(config.guildId).then(g => maybeAutoStartArena(g)).catch(() => {}), 15 * 60000);
  try { rearmThroneExpiries(); } catch (e) { console.error(`[throneExpire] re-arm: ${e.message}`); }
  if (dguild) await sweepStaffRanks(dguild).catch(e => console.error(`[tribe staffrank] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepStaffRanks(g)).catch(() => {}), 3600000);
  // Mod-tribe 3-leader requirement (boot + hourly): alert → freeze perks at grace midpoint → disband-pending.
  if (dguild) await sweepLeaderRequirement(dguild).catch(e => console.error(`[leader-req] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepLeaderRequirement(g)).catch(() => {}), 3600000);

  // Age-role exclusivity + registration-lock backstops (boot + hourly, same cadence as MDNI above).
  if (dguild) {
    await ensureMembers(dguild);
    for (const m of dguild.members.cache.values()) await enforceAgeExclusivity(m).catch(() => {});
    const seeded = await sweepRegistrationLocks(dguild).catch(e => { console.error(`[registration-lock] boot sweep: ${e.message}`); return 0; });
    console.log(`[registration-lock] boot sweep: ${seeded} member(s) grandfathered in`);
  }
  setInterval(async () => {
    const g = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!g) return;
    await ensureMembers(g);
    for (const m of g.members.cache.values()) await enforceAgeExclusivity(m).catch(() => {});
  }, 3600000);
});

// Real-time conflict resolution: when someone reacts to the current weekly react-to-resolve
// message, fix them immediately (the hourly sweep is the safety net for missed events).
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
    // Arena REACTION RUSH — first tribe member to react with the target emoji scores + advances the round.
    const ax = arena.get();
    if (ax && ax.type === 'reaction' && ax.reactionOpen && reaction.message.id === ax.messageId) {
      if (reaction.emoji?.name === ax.target) {
        const rguild = reaction.message.guild;
        const member = rguild && rguild.id === config.guildId ? await rguild.members.fetch(user.id).catch(() => null) : null;
        const mine = member && tribes.memberTribe(member);
        const cur = arena.get();   // re-read to reduce a double-score race between near-simultaneous reactions
        if (mine && cur && cur.type === 'reaction' && cur.reactionOpen && cur.messageId === ax.messageId) {
          arena.update({ reactionOpen: false });   // first-to-react closes this round
          scoreArena(mine.key, member.id);
          await postReactionRound(rguild).catch(() => {});
        }
      }
      return;   // it was a reaction on the arena message — don't fall through to react-resolve
    }
    const msgId = state.getMeta('reactMsgId');
    if (!msgId || reaction.message.id !== msgId) return;
    const guild = reaction.message.guild;
    if (!guild || guild.id !== config.guildId) return;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) await reactresolve.resolveMember(member);
  } catch (err) {
    console.error(`[react] reaction handler error: ${err.message}`);
  }
});

// New members get the Unverified role on join. This used to be handled by the onboarding
// "Unverified" question (the only place it was assigned); moved here so that question can be
// dropped from onboarding while the gate stays intact. Skips bots and anyone already verified.
client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== config.guildId || member.user.bot) return;
    freshwatch.onMemberJoin(member.guild, member);   // real-time join tracking (fresh-flag + influx detection)
    if (!config.unverifiedRoleId) return;
    if (member.roles.cache.has(config.verifiedRoleId)) return;   // already verified
    if (member.roles.cache.has(config.unverifiedRoleId)) return; // already tagged
    await member.roles.add(config.unverifiedRoleId, 'Auto-assign Unverified on join');
    console.log(`[verify] assigned Unverified to new member ${member.user.username} (${member.id})`);
  } catch (err) {
    console.error(`[verify] guildMemberAdd failed for ${member.id}: ${err.message}`);
  }
});

// Track the Unverified role clock in real time: when a member GAINS the role (mod un-verifies as
// punishment, or autorole), stamp now so their reap clock starts then — not their join date. When
// they LOSE it (verified/resolved), drop their reap bookkeeping. Only acts on a confirmed
// transition (non-partial old member); pre-existing members are reconstructed by the sweep.
// MDNI (18+) must be backed by an ADULT age role. Onboarding lets a 16-17 member self-select MDNI with
// no age check, so we strip it from anyone who isn't a confirmed adult (minors, or adults who later
// switch their age to 16-17). Flags the MINOR case to mods — a minor reaching for 18+ is worth a look.
async function enforceMdni(member, { notify = true } = {}) {
  if (!config.mdniEnforce || !config.mdniRoleId || member.user?.bot) return null;
  if (!member.roles.cache.has(config.mdniRoleId)) return null;
  if (config.adultAgeRoleIds.some(id => member.roles.cache.has(id))) return null; // confirmed adult → keep
  await member.roles.remove(config.mdniRoleId, 'MDNI requires an adult age role').catch(e => console.error('[mdni] remove:', e.message));
  const isMinor = !!(config.minorAgeRoleId && member.roles.cache.has(config.minorAgeRoleId));
  console.log(`[mdni] stripped MDNI from ${member.user.tag}${isMinor ? ' (MINOR 16-17)' : ' (no adult age role)'}`);
  if (notify && isMinor && config.modAnnounceChannelId) {   // real-time single-member notice (sweep summarizes instead)
    const ch = await member.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
    if (ch) ch.send({ content: `## ⚠️ MDNI removed from a minor\n<@${member.id}> (\`${member.user.tag}\`) has the **16-17** age role but selected **MDNI**, auto-removed. Heads up in case it needs a closer look.`, allowedMentions: { parse: [] } }).catch(() => {});
  }
  return { id: member.id, tag: member.user.tag, minor: isMinor };
}
// Backstop: sweep every current MDNI holder (catches existing minors + any missed role-change event).
// Posts ONE summary of any minors stripped (vs. real-time enforcement's per-member notice) to avoid flooding.
async function sweepMdni(guild) {
  if (!config.mdniEnforce || !config.mdniRoleId) return;
  await ensureMembers(guild);   // role.members only reflects the cache
  const role = guild.roles.cache.get(config.mdniRoleId) || await guild.roles.fetch(config.mdniRoleId).catch(() => null);
  if (!role) return;
  const stripped = [];
  for (const m of [...role.members.values()]) {
    const r = await enforceMdni(m, { notify: false });
    if (r) stripped.push(r);
  }
  if (!stripped.length) return;
  const minors = stripped.filter(s => s.minor);
  console.log(`[mdni] sweep stripped ${stripped.length} non-adult MDNI holder(s) (${minors.length} minor)`);
  if (minors.length && config.modAnnounceChannelId) {
    const ch = await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
    if (ch) await ch.send({
      content: `## ⚠️ MDNI removed from ${minors.length} minor${minors.length > 1 ? 's' : ''}\nThese members have the **16-17** age role but held **MDNI** (18+), auto-removed by the age-gate:\n${minors.map(m => `• <@${m.id}> (\`${m.tag}\`)`).join('\n')}`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

// MDNI is 18+ — and a minor must be excluded EVEN IF they're staff. Discord can't express "staff AND adult":
// at the role tier every allow is OR'd on top of every deny, so a MODS/ADMINS **allow** overrides a 16-17
// role **deny** — a minor mod would still see the channel. Only a MEMBER-level overwrite beats a role allow.
// So for any minor who'd otherwise see MDNI (i.e. staff — regular minors are already blocked by @everyone),
// maintain a member-level ViewChannel deny; drop it once they're no longer a minor-staff. Scoped to the few
// minor-staff, never the ~800 regular minors. blessChannel keeps permguard from flagging the member-denies.
async function enforceMdniStaffLock(member, { bless = true } = {}) {
  if (!config.mdniChannelId || !config.minorAgeRoleId || member.user?.bot) return null;
  const ch = member.guild.channels.cache.get(config.mdniChannelId) || await member.guild.channels.fetch(config.mdniChannelId).catch(() => null);
  if (!ch) return null;
  const VIEW = PermissionsBitField.Flags.ViewChannel;
  const isMinor = member.roles.cache.has(config.minorAgeRoleId);
  const needsLock = isMinor && ['mod', 'admin'].includes(opspanel.memberTier(member));   // minor mods/admins only — owner-tier exempt (owner ruling 2026-08-01)
  const ow = ch.permissionOverwrites.cache.get(member.id);
  const botLocked = !!(ow && ow.type === 1 && ow.deny.has(VIEW) && ow.allow.bitfield === 0n);
  let changed = null;
  if (needsLock && !botLocked) {
    await ch.permissionOverwrites.edit(member.id, { ViewChannel: false }, { reason: 'MDNI is 18+ — minor staff excluded (member deny overrides staff role allow)' }).catch(e => console.error('[mdni-lock] add:', e.message));
    console.log(`[mdni-lock] locked minor-staff ${member.user.tag} out of MDNI`);
    changed = { id: member.id, tag: member.user.tag, locked: true };
  } else if (!needsLock && botLocked) {
    await ch.permissionOverwrites.delete(member.id, 'no longer minor-staff — MDNI lock lifted').catch(e => console.error('[mdni-lock] del:', e.message));
    console.log(`[mdni-lock] lifted MDNI lock on ${member.user.tag}`);
    changed = { id: member.id, tag: member.user.tag, locked: false };
  }
  if (changed && bless) await permguard.blessChannel(member.guild, config.mdniChannelId).catch(() => {});
  return changed;
}

// Backstop sweep (boot + hourly): lock every current minor-staff, and lift stale locks (member-denies whose
// holder is no longer a minor-staff). Re-snapshots MDNI once at the end so permguard treats the result as golden.
async function sweepMdniStaffLock(guild) {
  if (!config.mdniChannelId || !config.minorAgeRoleId) return 0;
  await ensureMembers(guild);
  const ch = guild.channels.cache.get(config.mdniChannelId) || await guild.channels.fetch(config.mdniChannelId).catch(() => null);
  if (!ch) return 0;
  const VIEW = PermissionsBitField.Flags.ViewChannel;
  let n = 0;
  const minorRole = guild.roles.cache.get(config.minorAgeRoleId);
  if (minorRole) for (const m of [...minorRole.members.values()]) { const r = await enforceMdniStaffLock(m, { bless: false }); if (r?.locked) n++; }
  // lift stale locks
  for (const o of [...ch.permissionOverwrites.cache.values()]) {
    if (o.type !== 1 || !o.deny.has(VIEW) || o.allow.bitfield !== 0n) continue;   // only our pure View-denies
    const m = await guild.members.fetch(o.id).catch(() => null);
    if (!m || !(m.roles.cache.has(config.minorAgeRoleId) && ['mod', 'admin'].includes(opspanel.memberTier(m))))
      await ch.permissionOverwrites.delete(o.id, 'MDNI minor-staff lock cleanup').catch(() => {});
  }
  await permguard.blessChannel(guild, config.mdniChannelId).catch(() => {});
  if (n) console.log(`[mdni-lock] boot/hourly sweep: locked ${n} minor-staff out of MDNI`);
  return n;
}

// Only one age bracket at a time. Nothing previously enforced this — a member could hold multiple age
// roles simultaneously (whatever assigned them, e.g. the old external selector, had no exclusivity check).
// Real-time (guildMemberUpdate, oldMember diff picks the newly-added one to keep) + boot sweep (no diff
// available, so it just keeps the first held in canonical order and flags the case as ambiguous for staff).
function ageRoleIds() { return [config.minorAgeRoleId, ...config.adultAgeRoleIds].filter(Boolean); }
function currentAgeRole(member) { return ageRoleIds().find(id => member.roles.cache.has(id)) || null; }
async function enforceAgeExclusivity(member, oldMember) {
  const ids = ageRoleIds();
  const held = ids.filter(id => member.roles.cache.has(id));
  if (held.length <= 1) return null;
  const newlyAdded = oldMember && !oldMember.partial ? held.filter(id => !oldMember.roles.cache.has(id)) : [];
  const ambiguous = newlyAdded.length !== 1;
  const keep = ambiguous ? held[0] : newlyAdded[0];
  const strip = held.filter(id => id !== keep);
  await member.roles.remove(strip, 'Only one age bracket allowed at a time').catch(e => console.error('[age-exclusivity] remove:', e.message));
  console.log(`[age-exclusivity] ${member.user.tag} held ${held.length} age roles — kept ${keep}, stripped ${strip.join(',')}${ambiguous ? ' (ambiguous, picked first)' : ''}`);
  return { keep, strip, ambiguous };
}

// Age bracket + MDNI are a ONE-TIME choice made "during registration" (Rule 3) — not something to keep
// re-picking. The moment a member is first observed as Verified, their current age role + MDNI status is
// snapshotted as their permanent choice; any change after that gets reverted and flagged to staff. This is
// the backstop against the external role-selector (Discord onboarding or similar) that this bot doesn't
// control — even if that path is still reachable, anything it does post-verification gets undone here.
function snapshotRegistrationLock(member) {
  return { ageRoleId: currentAgeRole(member), mdni: !!(config.mdniRoleId && member.roles.cache.has(config.mdniRoleId)) };
}
// Who actually made the most recent role change on this member (via the audit log)? Lets us tell a member
// re-picking their OWN registration (which the lock reverts) from a mod/admin correcting it (an override we
// must ALLOW) or the bot's own revert echo (ignore). Null if the log is unavailable/lagging.
async function whoChangedRoles(member) {
  try {
    const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 6 });
    const now = Date.now();
    const e = logs.entries.find(x => x.target?.id === member.id && (now - x.createdTimestamp) < 15000);
    return e?.executor || null;
  } catch { return null; }
}
const _rlBusy = new Set();   // re-entrancy guard: our own revert fires more guildMemberUpdate events
async function enforceRegistrationLock(member, notify = true) {
  if (!config.verifiedRoleId || !member.roles.cache.has(config.verifiedRoleId)) return;
  if (_rlBusy.has(member.id)) return;                       // mid-revert on this member — ignore the echo
  const locks = state.getMeta('registrationLock') || {};
  if (!locks[member.id]) { locks[member.id] = snapshotRegistrationLock(member); state.setMeta('registrationLock', locks); return; }
  const lock = locks[member.id];
  const curAge = currentAgeRole(member);
  const curMdni = !!(config.mdniRoleId && member.roles.cache.has(config.mdniRoleId));
  if (curAge === lock.ageRoleId && curMdni === lock.mdni) return;   // matches the locked baseline — nothing to do

  // WHO changed it decides everything. Only a member re-picking their OWN registration is blocked. A mod/
  // admin (or the bot) changing it is a deliberate OVERRIDE → accept it as the new locked baseline so staff
  // CAN fix a bracket. Our own revert echoes (actor = the bot) are ignored.
  const actor = await whoChangedRoles(member);
  if (actor && actor.id === member.client.user.id) return;  // bot's own change — ignore
  if (actor && actor.id !== member.id) {
    locks[member.id] = snapshotRegistrationLock(member); state.setMeta('registrationLock', locks);
    console.log(`[registration-lock] override by ${actor.tag || actor.id} for ${member.user.tag} — new baseline locked`);
    return;
  }

  // Self-change (or actor unknown → fail safe toward protection): revert to the locked baseline.
  const roleName = id => id ? (member.guild.roles.cache.get(id)?.name || id) : null;
  const changes = [];
  _rlBusy.add(member.id);
  try {
    if (curAge !== lock.ageRoleId) {
      if (curAge) await member.roles.remove(curAge, 'Registration lock: age bracket can’t change after verification').catch(() => {});
      if (lock.ageRoleId) await member.roles.add(lock.ageRoleId, 'Registration lock: restoring original age bracket').catch(() => {});
      changes.push(curAge
        ? `**Age:** they tried to switch to **${roleName(curAge)}** → restored **${roleName(lock.ageRoleId) || 'their original bracket'}**`
        : `**Age:** they tried to clear their age bracket → restored **${roleName(lock.ageRoleId) || 'their original bracket'}**`);
    }
    if (curMdni !== lock.mdni) {
      if (curMdni) await member.roles.remove(config.mdniRoleId, 'Registration lock: MDNI can’t change after verification').catch(() => {});
      else await member.roles.add(config.mdniRoleId, 'Registration lock: restoring original MDNI choice').catch(() => {});
      changes.push(`**MDNI:** they tried to turn it **${curMdni ? 'ON' : 'OFF'}** → restored`);
    }
  } finally { setTimeout(() => _rlBusy.delete(member.id), 4000); }   // hold past the gateway echo of our own edits
  if (!changes.length) return;
  console.log(`[registration-lock] reverted self-change for ${member.user.tag}: ${changes.join('; ')}`);

  // Rate-limit the mod-announce post per member — a member spam-toggling shouldn't flood the channel (the
  // revert still happens every time; only the heads-up is throttled).
  if (!notify || !config.modAnnounceChannelId) return;
  const notified = state.getMeta('registrationLockNotified') || {};
  if (Date.now() - (notified[member.id] || 0) < 10 * 60 * 1000) return;
  notified[member.id] = Date.now(); state.setMeta('registrationLockNotified', notified);
  const ch = await member.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (ch) await ch.send({
    content: `## 🔒 Registration lock\n<@${member.id}> (\`${member.user.tag}\`) tried to change their own **age/MDNI** after verifying, auto-reverted (it’s a one-time choice set at verification).\n${changes.map(c => `• ${c}`).join('\n')}\n_A mod/admin **can** override this by changing it for them. Only self-changes are blocked._`,
    allowedMentions: { parse: [] } }).catch(() => {});
}
// Boot self-heal: grandfather in every currently-Verified member with no lock snapshot yet (their
// CURRENT state becomes their locked baseline — doesn't retroactively punish existing members).
async function sweepRegistrationLocks(guild) {
  if (!config.verifiedRoleId) return 0;
  await ensureMembers(guild);
  const role = guild.roles.cache.get(config.verifiedRoleId) || await guild.roles.fetch(config.verifiedRoleId).catch(() => null);
  if (!role) return 0;
  const locks = state.getMeta('registrationLock') || {};
  let seeded = 0;
  for (const m of role.members.values()) { if (!locks[m.id]) { locks[m.id] = snapshotRegistrationLock(m); seeded++; } }
  if (seeded) state.setMeta('registrationLock', locks);
  return seeded;
}

// ── Tier auto-nesting ───────────────────────────────────────────────────────────────────────────────
// Owner ⊇ Admin ⊇ Mod: higher tiers hold the lower ROLES, so @Mod reaches everyone above AND every
// admin/owner inherits the MODS-✰ role's perks (embed/attach/voice) by being a mod. Trial Mod is
// DELIBERATELY EXCLUDED — becoming a real mod/admin/owner STRIPS Trial Mod, so @Trial Mod only ever
// pings genuine trial mods (owner ruling 2026-07-30). Idempotent → safe on every role change + on boot.
const NEST_MOD_ROLE = config.modRoleId || '1528316361665675316';
const NEST_ADMIN_ROLE = process.env.FUBU_ADMIN_ROLE_ID || '1516179051105226833';
async function enforceTierNesting(member) {
  if (!member || member.user?.bot) return false;
  const tier = opspanel.memberTier(member);           // owner / admin / mod / null (highest tier)
  if (!tier) return false;                             // not staff - nothing to nest
  const has = id => id && member.roles.cache.has(id);
  const add = [], remove = [];
  if ((tier === 'owner' || tier === 'admin') && NEST_MOD_ROLE && !has(NEST_MOD_ROLE)) add.push(NEST_MOD_ROLE);
  if (tier === 'owner' && NEST_ADMIN_ROLE && !has(NEST_ADMIN_ROLE)) add.push(NEST_ADMIN_ROLE);
  const trial = modapps.loadConfig().trialModRoleId;   // mod+ never keep Trial Mod
  if (trial && has(trial)) remove.push(trial);
  if (!add.length && !remove.length) return false;
  if (add.length) await member.roles.add(add, 'tier auto-nest (owner⊇admin⊇mod)').catch(() => {});
  if (remove.length) await member.roles.remove(remove, 'tier auto-nest: mod+ drops Trial Mod').catch(() => {});
  return true;
}

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (newMember.guild.id !== config.guildId) return;
    await enforceTierNesting(newMember).catch(e => console.error('[tier-nest]', e.message));
    // Nobody should be able to browse to their own application. A mod+ can see the WHOLE review forum, so
    // removing thread membership isn't enough — archive their own post to the owner-only channel instead
    // (record kept, just moved out of reach). A trial mod can't see the forum at all; sealing their
    // applicant-thread membership is sufficient there. Idempotent either way.
    if (opspanel.memberTier(newMember)) await modapps.archiveOwnApplication(newMember.guild, newMember.id).catch(e => console.error('[modapps archive]', e.message));
    else if (newMember.roles.cache.has(config.trialModRoleId)) await modapps.sealOwnApplication(newMember.guild, newMember.id).catch(e => console.error('[modapps seal]', e.message));
    // DEMOTION: was mod+, no longer is → Discord keeps their review-thread memberships, so an ex-mod would
    // still see staff deliberations (this is exactly how two demoted mods lingered, 2026-08-01). Sweep them out.
    if (oldMember && !oldMember.partial && opspanel.memberTier(oldMember) && !opspanel.memberTier(newMember)) {
      const n = await modapps.removeDemotedFromReviewThreads(newMember.guild, newMember.id).catch(() => 0);
      if (n) console.log(`[modapps] demoted ${newMember.user.tag} removed from ${n} review thread(s)`);
    }
    await enforceMdni(newMember).catch(() => {});   // keep MDNI ⟹ adult on every role change
    await enforceMdniStaffLock(newMember).catch(e => console.error('[mdni-lock]', e.message));   // block minor STAFF from the 18+ channel
    await enforceAgeExclusivity(newMember, oldMember).catch(e => console.error('[age-exclusivity]', e.message));
    await enforceRegistrationLock(newMember).catch(e => console.error('[registration-lock]', e.message));
    await enforceTribeMembership(newMember).catch(e => console.error('[tribe-guard]', e.message));   // revert manual tribe-role tampering
    if (!config.unverifiedRoleId || !oldMember || oldMember.partial) return;
    const hadU = oldMember.roles.cache.has(config.unverifiedRoleId);
    const hasU = newMember.roles.cache.has(config.unverifiedRoleId);
    if (hasU && !hadU) {
      state.setMember(newMember.id, { unverifiedSince: Date.now(), warnedAt: undefined });
    } else if (!hasU && hadU) {
      state.forgetMember(newMember.id);
    }
  } catch (err) {
    console.error(`[unverified-track] ${err.message}`);
  }
});

// Mod-application review threads are mod+ only — but Discord lets any mod+ member (via Manage Threads)
// manually add someone to a SPECIFIC thread, and that add works even if the added person's own CHANNEL
// permission denies them entirely (thread membership bypasses the parent's view-deny). A channel/category
// lockout alone can't stop that. React the moment anyone below mod+ is added: remove them + notify.
client.on('threadMembersUpdate', async (addedMembers, removedMembers, thread) => {
  try {
    if (!addedMembers.size) return;
    const cfg = modapps.loadConfig();
    let removed = [], kind = '';
    if (cfg.forumId && thread.parentId === cfg.forumId) { removed = await modapps.enforceReviewThreadMembers(thread.guild, thread); kind = 'review thread (mod+ only)'; }
    else if (cfg.appsChannelId && thread.parentId === cfg.appsChannelId) { removed = await modapps.enforceApplicantThreadMembers(thread.guild, thread); kind = 'application thread (applicant + staff only)'; }
    else return;
    if (!removed.length) return;
    console.log(`[modapps] auto-removed non-staff member(s) from thread ${thread.id}: ${removed.map(m => m.user.tag).join(', ')}`);
    const ch = config.modAnnounceChannelId ? await thread.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null) : null;
    if (ch) await ch.send({ content: `🔒 Auto-removed ${removed.map(m => `<@${m.id}>`).join(', ')} from a mod-application ${kind}.`, allowedMentions: { parse: [] } }).catch(() => {});
  } catch (e) { console.error('[modapps] threadMembersUpdate enforcement:', e.message); }
});

// A mod deleted a denied ban-appeal thread once (2026-08-01), erasing the record. Mods can no longer delete
// threads in the appeal channels (ManageThreads denied there), but log ANY appeal-thread deletion to owner-log
// regardless of who did it — a permanent, visible trail. (The transcript itself is snapshotted into the appeal
// record at decision time, so even a deletion can't lose the contents.)
client.on('threadDelete', async (thread) => {
  try {
    const appealChans = [appeals.loadConfig().channelId, strikeAppeals.loadConfig().channelId].filter(Boolean);
    if (!thread.parentId || !appealChans.includes(thread.parentId)) return;
    let who = '**unknown**';   // threadDelete carries no executor — find it in the audit log
    const logs = await thread.guild.fetchAuditLogs({ type: AuditLogEvent.ThreadDelete, limit: 5 }).catch(() => null);
    const entry = logs && [...logs.entries.values()].find(e => e.targetId === thread.id || e.target?.name === thread.name);
    if (entry?.executor) who = `<@${entry.executor.id}>`;
    await ownerlog.log(thread.guild, { emoji: '🗑️', title: 'Appeal thread DELETED', color: 0xED4245,
      detail: `**${thread.name}** (in <#${thread.parentId}>) was deleted by ${who}. Decided appeals are meant to stay archived, not deleted — the saved transcript is in the appeal record if you need it.` });
  } catch (e) { console.error('[appeal-thread-delete]', e.message); }
});

// Verify panel: post Verify / Deny&kick buttons in every thread opened in the verify-here channel.
client.on('threadCreate', async (thread, newlyCreated) => {
  try {
    if (!newlyCreated) return;                                   // ignore re-syncs on restart
    if (thread.parentId !== config.verifyChannelId) return;
    if (!thread.ownerId) return;                                 // need an applicant to target
    await thread.join().catch(() => {});                         // ensure the bot can post (private threads)
    const m = await thread.guild.members.fetch(thread.ownerId).catch(() => null);
    // Ping the mod role AND trial mods (verifying is their task) so both are notified even if the
    // applicant never tags anyone.
    const panel = buildVerifyPanel(thread.ownerId, m?.user?.tag || null);
    const pingRoles = [config.modRoleId, config.trialModRoleId].filter(Boolean);
    const rolePing = pingRoles.map(r => `<@&${r}>`).join(' ');
    const modPing = pingRoles.length ? `${rolePing}. A member is waiting to be verified.\n` : '';
    await thread.send({
      ...panel,
      content: `${modPing}${panel.content}`,
      allowedMentions: { users: [thread.ownerId], roles: pingRoles },
    });
    console.log(`[verify-panel] posted in thread ${thread.id} (owner ${thread.ownerId}, mods + trial mods pinged)`);
  } catch (err) {
    console.error(`[verify-panel] threadCreate failed: ${err.message}`);
  }
});

// Auto-corner (Rule 9, Right Channel Right Conversation): opening a thread in a general/chat category is
// a quick, automatic Corner + the thread gets deleted (nothing left to salvage once the owner's cornered).
// Staff are exempt — this is member-facing enforcement, not a staff restriction. Feeds the same
// repeat-alert tracking as a manual /corner with rule 9, so a repeat offender still surfaces to staff.
// Shared by the live threadCreate listener AND the boot-time backfill sweep (for threads opened before
// this rule existed). Returns true if the thread was acted on (cornered + deleted), false if skipped.
async function autoCornerThread(guild, thread) {
  const parent = thread.parent || await guild.channels.fetch(thread.parentId).catch(() => null);
  if (!parent || !config.autoCornerThreadCategoryIds.includes(parent.parentId)) return false;
  if (config.autoCornerThreadExcludedChannelIds.includes(thread.parentId)) return false;
  if (!thread.ownerId) return false;
  const member = await guild.members.fetch(thread.ownerId).catch(() => null);
  if (!member) { await thread.delete('Auto-corner: owner no longer in the server').catch(() => {}); return true; }
  if (opspanel.memberTier(member)) return false; // staff exempt
  const r = await corner.corner(guild, member, config.autoCornerThreadDurationMs, state, client.user.id, '9');
  await thread.delete('Auto-corner: thread opened in a general/chat channel').catch(e => console.error('[auto-corner-thread] thread delete:', e.message));
  if (!r.ok) { console.error(`[auto-corner-thread] corner failed for ${member.id}: ${r.error}`); return false; }
  const relSec = Math.floor((Date.now() + config.autoCornerThreadDurationMs) / 1000);
  const reasonText = `Rule 9: ${SERVER_RULES[8]} · opened a thread in <#${thread.parentId}>`;
  try {
    const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
    if (cornerCh) await cornerCh.send(cornerSentMessage(member.id, `until <t:${relSec}:f>`, reasonText));
  } catch (e) { console.error('[auto-corner-thread] announce failed:', e.message); }
  await logCorner(guild, { emoji: '⛓️', title: 'AUTO-CORNERED (thread in chat channel)', color: CORNER_RED,
    desc: `<@${member.id}> was auto-cornered for 15m for opening a thread in <#${thread.parentId}> (now deleted).` });
  await maybeAlertCornerRepeat(guild, member, '9', r.repeatCount);
  console.log(`[auto-corner-thread] cornered ${member.id} for a thread in ${thread.parentId}, thread deleted`);
  return true;
}
client.on('threadCreate', async (thread, newlyCreated) => {
  try {
    if (!newlyCreated) return;
    await autoCornerThread(thread.guild, thread);
  } catch (err) {
    console.error(`[auto-corner-thread] failed: ${err.message}`);
  }
});
// One-time boot self-heal: sweep every covered channel for threads that predate this rule (opened before
// the feature shipped) and apply the same treatment retroactively. Idempotent — after the first sweep,
// the live threadCreate listener above catches everything instantly, so later boots find nothing to do.
async function sweepExistingAutoCornerThreads(guild) {
  let swept = 0;
  const channels = await guild.channels.fetch();
  for (const ch of channels.values()) {
    if (!ch || ch.type !== 0) continue; // text channels only
    if (config.autoCornerThreadExcludedChannelIds.includes(ch.id)) continue;
    if (!config.autoCornerThreadCategoryIds.includes(ch.parentId)) continue;
    // Existing threads may already be auto-archived (Discord's own inactivity timeout) by the time this
    // sweep runs — check both active AND archived, or a merely-quiet pre-existing thread gets missed.
    const active = await ch.threads.fetchActive().catch(() => null);
    const archived = await ch.threads.fetchArchived().catch(() => null);
    const threads = [...(active?.threads.values() || []), ...(archived?.threads.values() || [])];
    for (const thread of threads) {
      try { if (await autoCornerThread(guild, thread)) swept++; }
      catch (e) { console.error(`[auto-corner-thread] backfill sweep on ${thread.id}:`, e.message); }
    }
  }
  return swept;
}

// ── Watchlist: keyword monitor + ban/dismiss buttons ────────────────────────────────────────────────
// Tier gates via the ops-panel's ROLE-based tiers (NOT the Administrator permission, per owner):
//   canBan   = any staff tier (mod / admin / owner) — any mod can ban on a violation.
//   canWLAdmin = ADMINS-★ role or owner ONLY — unban + editing the watchlist/terms.
// Authority via tierOf (bot owner supreme by user id; Administrator PERMISSION = owner tier; ADMINS-★ = admin).
const canBan = (i) => !!opspanel.tierOf(i);                                        // any staff (mod+)
const canWLAdmin = (i) => ['admin', 'owner', 'botowner'].includes(opspanel.tierOf(i)); // admin+
const isOwner = (i) => ['owner', 'botowner'].includes(opspanel.tierOf(i));         // owner (role or Admin-perm) or bot owner
// Trial Mod — a restricted training tier BELOW mod. Not staff for canBan purposes, but may do a few
// low-risk, bounded things: VERIFY, view the dashboard read-only, and CORNER (rule+reason, ≤1h).
const isTrialMod = (i) => !!(config.trialModRoleId && i.member?.roles?.cache?.has(config.trialModRoleId));
const canVerify = (i) => canBan(i) || isTrialMod(i);
// A language mini-mod may use Send-to-corner + Report-to-watchlist, but ONLY on messages in THEIR OWN
// language's channels (per-language roles now — French Mini-Mod acts only in French chat/VC, etc.), and
// only when the 'langMiniMod' feature is on. Dormant if no languages are configured.
function miniModCanActOn(interaction, channelId) {
  return features.enabled('langMiniMod') && langmods.canActOn(interaction.member, channelId);
}
// Member-facing anon-pipe commands are confined to the bot-commands channel (keeps them out of chat).
const BOT_COMMANDS_CH = process.env.FUBU_BOT_COMMANDS_CHANNEL_ID || '1528704767466016870';
function inBotCommands(interaction) {
  if (interaction.channelId === BOT_COMMANDS_CH) return true;
  interaction.reply({ content: `Please use this in <#${BOT_COMMANDS_CH}> 🤖`, flags: MessageFlags.Ephemeral }).catch(() => {});
  return false;
}

// Alert a mod channel when a member trips a flagged term. Self-contained: it copies the message text AND
// mirrors the attachments into the report, so the record survives even if the author deletes the original.
// opts lets the looser general monitor reuse it with a different channel/title/colour and no ban buttons.
async function watchlistAlert(msg, hits, opts = {}) {
  const chId = opts.channelId || config.modAnnounceChannelId;
  const ch = chId && await msg.guild.channels.fetch(chId).catch(() => null);
  if (!ch) return;
  // Smart-watch contextual judge (feature-gated, fail-open). Reads the flagged message in context and
  // either suppresses an obvious false positive (LIVE mode only) or annotates the alert with its verdict.
  // In shadow mode it only annotates + logs; a null/errored verdict falls through to today's behavior.
  // When the LAB is active the AI moves OUT of the public log entirely — the watch-log reverts to plain
  // keyword flags and every AI verdict is posted (gradable) in the private admin lab channel instead.
  let smartNote = null;
  if (features.enabled('smartWatch') && !features.enabled('smartWatchLab')) {
    try {
      const d = await smartwatch.evaluate(opts.scope || 'strict', msg, hits);
      if (d.ran && d.suppress) return;                 // live mode, high-confidence benign → don't post
      if (d.ran && d.note) smartNote = d.note;
    } catch (e) { console.error('[smartwatch] alert hook:', e.message); }
  }
  const atts = [...msg.attachments.values()];
  const embed = new EmbedBuilder().setColor(opts.color ?? 0xED4245).setTitle(opts.title || '🚨 Watchlist match')
    .setDescription(`<@${msg.author.id}> (\`${msg.author.tag}\`) ${opts.verb || 'matched a strict watchlist term'} in <#${msg.channel.id}>.`)
    .addFields(
      { name: 'Matched', value: (hits.map(h => `\`${h}\``).join(', ') || '-').slice(0, 1024) },
      { name: 'What they said (saved copy)', value: (msg.content || (atts.length ? '_(no text, see mirrored attachment)_' : '-')).slice(0, 1024) },
      { name: 'Original', value: `[jump to it](${msg.url}) · this report keeps a copy even if they delete it`, inline: true })
    .setFooter({ text: `user ${msg.author.id}` }).setTimestamp(new Date());
  if (atts.length) embed.addFields({ name: 'Attachments', value: `${atts.length} mirrored below (deletion-proof)`, inline: true });
  if (smartNote) embed.addFields({ name: 'AI context read', value: smartNote.slice(0, 1024) });
  const freshNote = freshwatch.noteFor(msg.member);   // human heads-up only — NOT fed to the AI judge
  if (freshNote) embed.addFields({ name: '🌱 Account age', value: freshNote.slice(0, 1024) });
  // Re-upload the attachments to the report (fetched immediately, so a later delete can't remove them).
  const files = atts.slice(0, 10).map(a => ({ attachment: a.url, name: a.name || 'attachment' }));
  // opts.buttons: 'full' (Ban+Dismiss, default) · 'dismiss' (welfare — no ban) · 'none'.
  let components = [];
  if (opts.buttons === 'dismiss') components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_dismiss:${msg.author.id}`).setEmoji('🗑️').setLabel('Dismiss').setStyle(ButtonStyle.Secondary))];
  else if (opts.buttons !== 'none') components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_strike:${msg.author.id}`).setEmoji('⚠️').setLabel('Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wl_corner:${msg.author.id}`).setEmoji('⛓️').setLabel('Corner').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wl_dismiss:${msg.author.id}`).setEmoji('🗑️').setLabel('Dismiss').setStyle(ButtonStyle.Secondary))];
  const ping = (opts.ping !== false && config.modRoleId) ? `<@&${config.modRoleId}>` : undefined;
  const mentions = { roles: (opts.ping !== false && config.modRoleId) ? [config.modRoleId] : [] };
  // Send with mirrored files; if a re-upload fails (expired/large), fall back to text-only so the report still lands.
  await ch.send({ content: ping, embeds: [embed], components, files, allowedMentions: mentions })
    .catch(async e => {
      console.error('[watchlist] alert (with files):', e.message);
      await ch.send({ content: ping, embeds: [embed], components, allowedMentions: mentions }).catch(e2 => console.error('[watchlist] alert:', e2.message));
    });
}

// SMART-WATCH LAB (feature 'smartWatchLab'): run the AI judge on an EXPANDED term set and post its verdict
// to the private admin-only lab channel, tagged 👁️ would-surface / 🙈 would-hide, with grading buttons
// (🔨 strike / ⛓️ corner / ⬜ fine). Grading both scores the AI and feeds a calibration example back into
// the judge prompt. Expanded terms live ONLY here; a real production hit also shows up here with the AI's
// take, so admins can watch it decide across the full feed. Best-effort, never throws into messageCreate.
async function labEvaluateAndPost(msg, member) {
  const ch = await msg.guild.channels.fetch(config.smartWatchLabChannelId).catch(() => null);
  if (!ch) return;
  const onWatch = watchlist.isWatched(member.id);
  // WELFARE takes priority (mirrors production): a non-watchlisted member's distress signal gets a welfare
  // card with distress-appropriate grading (🫂 genuine / ⬜ hyperbole) and no multi-action — punishment
  // verdicts don't apply to someone's wellbeing.
  if (!onWatch) {
    const wBase = watchlist.loadWelfare();
    const wAll = [...new Set([...wBase, ...watchlist.loadLabWelfare()])];
    const wHits = wAll.length ? watchlist.matchTerms(msg.content, wAll) : [];
    if (wHits.length) return await postWelfareLabCard(msg, ch, wHits, wBase);
  }
  const scope = onWatch ? 'strict' : 'loose';
  // base = the terms production would use for this member; expanded = the lab-only extras. Superset = both.
  const base = onWatch ? [...new Set([...watchlist.loadTerms(), ...watchlist.loadLoose()])] : watchlist.loadLoose();
  const expanded = onWatch ? [...watchlist.loadLabStrict(), ...watchlist.loadLabLoose()] : watchlist.loadLabLoose();
  const all = [...new Set([...base, ...expanded])];
  const hits = all.length ? watchlist.matchTerms(msg.content, all) : [];
  // LOOSE stays keyword-gated (cost/noise across the whole server). STRICT is FULL behavioral coverage —
  // the judge reads EVERY message from a watchlisted member (a small, deliberately-watched population),
  // keyword or not, matching the strict rubric's "is this person being disruptive/resuming?" intent.
  if (!onWatch && !hits.length) return;
  const d = await smartwatch.evaluateLab(scope, msg, hits);
  if (!d.ran || !d.verdict) return;                    // judge unavailable/errored → nothing to grade (shadow log has it)
  const v = d.verdict;
  const wouldSurface = !d.wouldSuppress;               // wouldSuppress already applies threshold + NEVER_SUPPRESS
  // Don't flood the lab with a watchlisted member's benign chatter: for a no-keyword strict read, only post
  // when the judge would SURFACE it (every read is still shadow-logged by evaluateLab above regardless).
  if (onWatch && !hits.length && !wouldSurface) return;
  const baseSet = new Set(base.map(t => t.toLowerCase()));
  const matchedDisplay = (hits.map(h => baseSet.has(h.toLowerCase()) ? `\`${h}\`` : `\`${h}\`⁺`).join(', ') || '_(behavioral read, no keyword)_').slice(0, 1024); // ⁺ = expansion-only (lab)
  const conf = v.confidence.toFixed(2);
  const rule = v.likelyRule ? `, Rule ${v.likelyRule}` : '';
  const verdictText = `${v.surface ? 'looks real' : 'likely false positive'}, ${v.reason} _(conf ${conf}, ${v.category}${rule})_`;
  const emb = new EmbedBuilder()
    .setColor(wouldSurface ? 0xE7AC4E : 0x2ECC71)
    .setTitle(`🧪 Lab: ${scope} candidate`)
    .setDescription(`<@${msg.author.id}> (\`${msg.author.tag}\`) in <#${msg.channel.id}> · [jump](${msg.url})`)
    .addFields(
      { name: 'Matched', value: matchedDisplay },
      { name: 'Message (saved copy)', value: (msg.content || '_(no text, attachment/embed)_').slice(0, 1024) },
      { name: `AI verdict: ${wouldSurface ? '👁️ WOULD SURFACE' : '🙈 WOULD HIDE'}`, value: verdictText.slice(0, 1024) })
    .setFooter({ text: `#${msg.channel?.name || '?'} · flagged ${msg.author.id}` })
    .setTimestamp(new Date());
  const freshNote = freshwatch.noteFor(msg.member);   // human heads-up only — NOT part of the AI verdict
  if (freshNote) emb.addFields({ name: '🌱 Account age', value: freshNote.slice(0, 1024) });
  const aiS = wouldSurface ? '1' : '0';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sw_label:strike:${aiS}`).setEmoji('🔨').setLabel('Strike-worthy').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`sw_label:corner:${aiS}`).setEmoji('⛓️').setLabel('Corner-only').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sw_label:glance:${aiS}`).setEmoji('👁️').setLabel('Surface, no action').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sw_label:fine:${aiS}`).setEmoji('⬜').setLabel('Fine (hide)').setStyle(ButtonStyle.Success));
  const noteRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sw_note:rule:${aiS}`).setEmoji('✏️').setLabel('Correct its read').setStyle(ButtonStyle.Secondary));
  const gradeId = smartwatch.genGradeId();
  emb.setFooter({ text: `#${msg.channel?.name || '?'} · flagged ${msg.author.id} · grade id ${gradeId}` });
  const sent = await ch.send({ embeds: [emb], components: [row, noteRow], allowedMentions: { parse: [] } }).catch(e => console.error('[smartwatch-lab] send:', e.message));
  smartwatch.registerCard(gradeId, { content: (msg.content || '').slice(0, 1024), aiWouldSurface: wouldSurface, task: 'rule', channel: msg.channel?.name, author: msg.author?.id, cardMsgId: sent?.id, cardChannelId: ch.id });
  // Multi-action prototype: the judge may also propose strikes/corners on OTHER messages in the read
  // context. Post each as its own gradable card (same 🔨/⛓️/⬜ buttons) so admins can score whether the
  // richer read is trustworthy. aiSurface=1 — proposing an action means the AI would surface/act.
  for (const a of (d.actions || []).slice(0, 4)) {
    const emoji = a.action === 'strike' ? '🔨' : '⛓️';
    const aRule = a.rule ? `, Rule ${a.rule}` : '';
    const aEmb = new EmbedBuilder().setColor(0x9B59B6)
      .setTitle(`🔎 Lab: AI proposes ${emoji} ${a.action.toUpperCase()} (from the thread)`)
      .setDescription(`On \`${a.who}\`'s message in <#${msg.channel.id}>. Spotted while reading context around the flag above.`)
      .addFields(
        { name: 'Matched', value: '_(context proposal, not a keyword hit)_' },
        { name: 'Message (saved copy)', value: (a.quote || '_(no text)_').slice(0, 1024) },
        { name: `AI proposes: ${a.action.toUpperCase()}${aRule}`, value: (a.reason || '-').slice(0, 1024) })
      .setTimestamp(new Date());
    const aGradeId = smartwatch.genGradeId();
    aEmb.setFooter({ text: `#${msg.channel?.name || '?'} · proposal · grade id ${aGradeId}` });
    const aRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sw_label:strike:1').setEmoji('🔨').setLabel('Strike-worthy').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sw_label:corner:1').setEmoji('⛓️').setLabel('Corner-only').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sw_label:glance:1').setEmoji('👁️').setLabel('Surface, no action').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sw_label:fine:1').setEmoji('⬜').setLabel('Fine (overreach)').setStyle(ButtonStyle.Success));
    // Second row: ✏️ correct-its-read, plus a 🔗 Jump to the exact (different) message the proposal is about.
    const aRow2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sw_note:rule:1').setEmoji('✏️').setLabel('Correct its read').setStyle(ButtonStyle.Secondary));
    if (a.url) aRow2.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(a.url).setEmoji('🔗').setLabel('Jump'));
    const aSent = await ch.send({ embeds: [aEmb], components: [aRow, aRow2], allowedMentions: { parse: [] } }).catch(e => console.error('[smartwatch-lab] action send:', e.message));
    smartwatch.registerCard(aGradeId, { content: (a.quote || '').slice(0, 1024), aiWouldSurface: true, task: 'rule', channel: msg.channel?.name, author: null, cardMsgId: aSent?.id, cardChannelId: ch.id });
  }
}

// Welfare lab card: distress is a different axis from rule-breaking, so it uses the welfare scope/rubric
// and 🫂 genuine / ⬜ hyperbole grading (surface = "someone should check in"), never strike/corner and no
// multi-action. Its labels train ONLY the welfare judgments (separate exemplar pool in smartwatch.js).
async function postWelfareLabCard(msg, ch, hits, base) {
  const d = await smartwatch.evaluate('welfare', msg, hits);
  if (!d.ran || !d.verdict) return;
  const v = d.verdict;
  const wouldSurface = !d.wouldSuppress;                 // surface = worth a check-in
  const baseSet = new Set(base.map(t => t.toLowerCase()));
  const matchedDisplay = (hits.map(h => baseSet.has(h.toLowerCase()) ? `\`${h}\`` : `\`${h}\`⁺`).join(', ') || '-').slice(0, 1024);
  const sev = (v.severity && v.severity !== 'none') ? ` · urgency ${v.severity}` : '';
  const verdictText = `${wouldSurface ? 'genuine distress, worth a check-in' : 'likely hyperbole / venting'}, ${v.reason} _(conf ${v.confidence.toFixed(2)}${sev})_`;
  const emb = new EmbedBuilder()
    .setColor(wouldSurface ? 0x5DADE2 : 0x2ECC71)
    .setTitle('🫂 Lab: welfare candidate')
    .setDescription(`<@${msg.author.id}> (\`${msg.author.tag}\`) in <#${msg.channel.id}> · [jump](${msg.url})`)
    .addFields(
      { name: 'Matched', value: matchedDisplay },
      { name: 'Message (saved copy)', value: (msg.content || '_(no text, attachment/embed)_').slice(0, 1024) },
      { name: `AI verdict: ${wouldSurface ? '🫂 WOULD SURFACE (check in)' : '🙈 WOULD HIDE (hyperbole)'}`, value: verdictText.slice(0, 1024) })
    .setFooter({ text: `#${msg.channel?.name || '?'} · welfare · flagged ${msg.author.id}` })
    .setTimestamp(new Date());
  const freshNote = freshwatch.noteFor(msg.member);
  if (freshNote) emb.addFields({ name: '🌱 Account age', value: freshNote.slice(0, 1024) });
  const aiS = wouldSurface ? '1' : '0';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sw_label:genuine:${aiS}`).setEmoji('🫂').setLabel('Genuine distress').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sw_label:hyperbole:${aiS}`).setEmoji('⬜').setLabel('Hyperbole (hide)').setStyle(ButtonStyle.Success));
  const noteRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sw_note:welfare:${aiS}`).setEmoji('✏️').setLabel('Correct its read').setStyle(ButtonStyle.Secondary));
  const gradeId = smartwatch.genGradeId();
  emb.setFooter({ text: `#${msg.channel?.name || '?'} · welfare · flagged ${msg.author.id} · grade id ${gradeId}` });
  const sent = await ch.send({ embeds: [emb], components: [row, noteRow], allowedMentions: { parse: [] } }).catch(e => console.error('[smartwatch-lab] welfare send:', e.message));
  smartwatch.registerCard(gradeId, { content: (msg.content || '').slice(0, 1024), aiWouldSurface: wouldSurface, task: 'welfare', channel: msg.channel?.name, author: msg.author?.id, cardMsgId: sent?.id, cardChannelId: ch.id });
}

// Reason+weight modal for a message-based strike. Carries the flagged message ref so the submit
// handler can strike + reply on that message with the reason (public, in-channel, no DM). Weight is a
// typed field (1/2/3) rather than a dropdown — Discord modals can't hold select menus. ruleN (optional,
// picked via the strike_rule_pick select BEFORE this modal shows) is carried in the customId so the
// submit handler can build the same "Rule N: <title> — <reason>" text /strike add uses. prefillNote
// (optional) seeds the reason field's default text (e.g. context from a repeat-Corner conversion).
function strikeReasonModal(memberId, channelId, messageId, ruleN, prefillNote) {
  const ruleSeg = ruleN || 'x';
  const ruleObj = ruleN ? rules.byIndex(Number(ruleN)) : null;
  const ruleTitle = ruleObj?.title || null;
  // If the picked rule already has a decided weight, pre-fill it and stop requiring the field — the
  // mod can just submit as-is. Otherwise fall back to the old "type it, default 1" behavior.
  const ruleWeight = ruleObj ? rules.weightOf(ruleObj.key) : null;
  const m = new ModalBuilder().setCustomId(`strike_reason:${memberId}:${channelId || 0}:${messageId || 0}:${ruleSeg}`)
    .setTitle(ruleTitle ? `Strike · Rule ${ruleN}: ${ruleTitle}`.slice(0, 45) : 'Strike: reason + weight');
  // Required only when no rule was picked (rule OR reason, not both) — the strike_rule_pick select
  // beforehand already covers the "gave a rule" half of that requirement.
  // Discord caps a TextInput label at 45 chars — anything longer makes showModal throw "Invalid string
  // length", which (thrown from a select handler) leaves the interaction unacked → "didn't respond in
  // time". Keep labels short AND slice(0,45) as a hard backstop so no label can ever overflow again.
  const reasonInput = new TextInputBuilder().setCustomId('reason')
    .setLabel((ruleN ? 'Reason (optional, rule already picked)' : 'Reason: posted publicly, no DMs').slice(0, 45))
    .setStyle(TextInputStyle.Short).setRequired(!ruleN).setMaxLength(300);
  if (prefillNote) reasonInput.setValue(prefillNote.slice(0, 300));
  const weightInput = new TextInputBuilder().setCustomId('weight')
    .setLabel((ruleWeight ? `Weight: Rule ${ruleN} default (edit if needed)` : 'Weight: 1 minor / 2 moderate / 3 severe').slice(0, 45))
    .setStyle(TextInputStyle.Short).setRequired(!ruleWeight).setValue(String(ruleWeight || 1)).setMaxLength(1);
  // Optional: ALSO send them to the corner for a duration — same spirit as /strike's timeout field, but
  // the corner (strip roles + jail) instead of a native mute. Blank = strike only.
  const cornerInput = new TextInputBuilder().setCustomId('corner')
    .setLabel('Also corner them? (30s/30m/2h, blank = no)')
    .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10);
  m.addComponents(new ActionRowBuilder().addComponents(reasonInput), new ActionRowBuilder().addComponents(weightInput), new ActionRowBuilder().addComponents(cornerInput));
  return m;
}
// Alert staff when a member has been repeatedly cornered for the SAME rule (config.cornerRepeatAlertThreshold,
// default 3) — never auto-strikes; the button opens the normal strike modal pre-filled so a human decides.
async function maybeAlertCornerRepeat(guild, member, ruleN, repeatCount) {
  if (!ruleN || repeatCount < config.cornerRepeatAlertThreshold) return;
  const ch = config.modAnnounceChannelId && await guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return;
  const ruleTitle = SERVER_RULES[Number(ruleN) - 1] || `rule ${ruleN}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`corner_convert:${member.id}:${ruleN}`).setEmoji('⚠️').setLabel('Convert to Strike').setStyle(ButtonStyle.Danger));
  await ch.send({
    content: `🔁 <@${member.id}> has been sent to the Corner **${repeatCount} times** for the same rule: **${ruleN}. ${ruleTitle}**. Consider converting to a Strike.`,
    components: [row], allowedMentions: { parse: [] },
  }).catch(e => console.error('[corner] repeat alert:', e.message));
}
// Rule-picker select shown BEFORE the strike reason+weight modal (a modal can't hold a dropdown).
// customId: strike_rule_pick:<memberId>:<channelId>:<messageId>
function ruleRow(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Which rule? (optional)').addOptions(
      ...SERVER_RULES.map((r, i) => ({ label: `${i + 1}. ${r}`.slice(0, 100), value: String(i + 1) })),
      { label: 'Other / no specific rule', value: 'none' }));
}
// The "Send to corner" reason/duration/sweep modal. The rule (picked via the corner_rule_pick select
// BEFORE this modal shows — a modal can't hold the rule dropdown) is carried in the customId so the
// submit handler can fold it into the reason. ruleN is a 1-based rule number or null.
function cornerReasonModal(memberId, channelId, messageId, ruleN) {
  return new ModalBuilder().setCustomId(`corner_reason:${memberId}:${channelId}:${messageId}:${ruleN || 'x'}`).setTitle('Send to corner').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (blank = 15m; 30s, 10m, 2h, 1d)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('timeout').setLabel('Native timeout too? (blank = no; 30m, 2h)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sweep').setLabel('Sweep others active here? (minutes)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder('blank = no · e.g. 5 = last 5 min')));
}
function banConfirmRow(userId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_banok:${userId}`).setEmoji('🔨').setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wl_dismiss:${userId}`).setEmoji('✖️').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
}

// wl_strike:<id> → escalate one strike (→ ban confirm at max) · wl_banok:<id> → ban ·
// wl_dismiss:<id> → clear. Mod-gated; edits the alert in place.
// Pull the flagged message's {channelId, messageId} out of a watch-log alert embed's jump link.
function originalRefFromAlert(embed) {
  const hay = ((embed?.fields || []).map(f => f.value).join('\n')) + '\n' + (embed?.description || '');
  const m = hay.match(/channels\/\d+\/(\d+)\/(\d+)/);   // /channels/<guild>/<channel>/<message>
  return m ? { channelId: m[1], messageId: m[2] } : null;
}

async function handleWatchlistButton(interaction) {
  if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnly, flags: MessageFlags.Ephemeral });
  const [action, userId] = interaction.customId.split(':');
  const keep = interaction.message.embeds;
  if (action === 'wl_dismiss')
    return interaction.update({ content: `🗑️ Dismissed by <@${interaction.user.id}>.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  if (action === 'wl_add') {   // "Add to watchlist" from a report - ADMINS-★ only
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can add to the watchlist.', flags: MessageFlags.Ephemeral });
    const m = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!m) return interaction.reply({ content: "That member isn't in the server.", flags: MessageFlags.Ephemeral });
    watchlist.addWatch(userId);
    return interaction.update({ content: `👁️ <@${userId}> added to the Watchlist by <@${interaction.user.id}>.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (action === 'wl_strike') {
    const keep = interaction.message.embeds;
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) // already left - the only escalation left is a ban so they can't rejoin
      return interaction.update({ content: `⚠️ <@${userId}> already left. Ban so they can’t rejoin?`, embeds: keep, components: [banConfirmRow(userId, 'Confirm ban')], allowedMentions: { parse: [] } }).catch(() => {});
    // Rule → reason+weight modal (two steps — a modal can't hold the rule dropdown).
    const ref = originalRefFromAlert(keep[0]);
    return interaction.reply({ content: copy.common.whichRule, components: [ruleRow(`strike_rule_pick:${userId}:${ref?.channelId || 0}:${ref?.messageId || 0}`)], flags: MessageFlags.Ephemeral });
  }
  if (action === 'wl_corner') {   // lighter than Strike: a casual, timed cool-off straight from the flag
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) return interaction.update({ content: `⛓️ <@${userId}> already left. Can’t corner.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    // Same tier hierarchy as /corner and Send-to-corner (own tier or lower, never higher) — this used to be
    // a blanket "no admins/owner ever" block that didn't check the ACTOR's tier, so even the owner couldn't
    // corner an admin from here even though the slash command correctly allows it.
    if (member.id === interaction.guild.ownerId)
      return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
    const wlActorRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[opspanel.tierOf(interaction)] || 0;
    const wlTargetRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[opspanel.memberTier(member)] || 0;
    if (wlTargetRank > wlActorRank)
      return interaction.reply({ content: `You can’t corner someone of a higher staff tier than you (they’re **${opspanel.memberTier(member)}**).`, flags: MessageFlags.Ephemeral });
    const durationMs = config.cornerDefaultDurationMs;
    const r = await corner.corner(interaction.guild, member, durationMs, state, interaction.user.id);
    if (!r.ok) return interaction.reply({ content: `Failed to corner: ${r.error}`, flags: MessageFlags.Ephemeral });
    const relSec = Math.floor((Date.now() + durationMs) / 1000);
    try {
      const cornerCh = await interaction.guild.channels.fetch(config.cornerChannelId).catch(() => null);
      if (cornerCh) await cornerCh.send(cornerSentMessage(userId, `until <t:${relSec}:f>`, null));
    } catch (e) { console.error('[wl_corner] announce:', e.message); }
    await logCorner(interaction.guild, { emoji: '⛓️', title: 'SENT TO THE CORNER (from watch-log)', color: CORNER_RED,
      desc: `<@${userId}> was cornered until ${relPhrase(relSec * 1000)} from a watch-log flag.\n**By:** <@${interaction.user.id}>` });
    return interaction.update({ content: `⛓️ Cornered <@${userId}> until <t:${relSec}:f>, stripped **${r.stripped}** role(s). By <@${interaction.user.id}>.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (action === 'wl_ban') { // legacy direct-ban buttons on older reports
    return interaction.update({ components: [banConfirmRow(userId, 'Confirm ban')] }).catch(() => {});
  }
  if (action === 'wl_banok') {
    try {
      await interaction.guild.members.ban(userId, { reason: `Watchlist ban by ${interaction.user.tag}` });
      await ownerlog.log(interaction.guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `<@${userId}> — by <@${interaction.user.id}>.` });
      return interaction.update({ content: `🔨 Banned <@${userId}> by <@${interaction.user.id}>.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    } catch (e) {
      return interaction.update({ content: `❌ Ban failed: ${e.message}`, components: [] }).catch(() => {});
    }
  }
}

// Manual report: a mod right-clicks a message → "Report to watchlist" → deletion-proof report in
// mod-announcements with Add-to-watchlist (admin) / Ban (mod) / Dismiss buttons.
async function manualWatchReport(message, reporter) {
  const ch = config.modAnnounceChannelId && await message.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
  if (!ch) return false;
  const atts = [...message.attachments.values()];
  const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('🚩 Reported message')
    .setDescription(`<@${reporter.id}> reported <@${message.author.id}> (\`${message.author.tag}\`) in <#${message.channel.id}>.`)
    .addFields(
      { name: 'What they said (saved copy)', value: (message.content || (atts.length ? '_(no text, see mirrored attachment)_' : '-')).slice(0, 1024) },
      { name: 'Original', value: `[jump to it](${message.url}) · saved here even if they delete it`, inline: true })
    .setFooter({ text: `user ${message.author.id}` }).setTimestamp(new Date());
  if (atts.length) embed.addFields({ name: 'Attachments', value: `${atts.length} mirrored below`, inline: true });
  const files = atts.slice(0, 10).map(a => ({ attachment: a.url, name: a.name || 'attachment' }));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_add:${message.author.id}`).setEmoji('👁️').setLabel('Add to watchlist').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wl_strike:${message.author.id}`).setEmoji('⚠️').setLabel('Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wl_dismiss:${message.author.id}`).setEmoji('🗑️').setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
  const ping = config.modRoleId ? `<@&${config.modRoleId}>` : undefined;
  const mentions = { roles: config.modRoleId ? [config.modRoleId] : [] };
  await ch.send({ content: ping, embeds: [embed], components: [row], files, allowedMentions: mentions })
    .catch(async e => { console.error('[report] with files:', e.message); await ch.send({ content: ping, embeds: [embed], components: [row], allowedMentions: mentions }).catch(e2 => console.error('[report]', e2.message)); });
  return true;
}

// Monitor: a member ON the Watchlist role who trips a flagged term → alert mods. Dormant until terms exist.
// Tribe Tides: per-member cooldown (in-memory; resets on restart, which is fine — it only rate-limits farming).
const _tideCooldown = new Map();   // `${tribeKey}:${userId}` -> last-earned ms
// Set a member's tribe rank to a specific rung (exclusive — removes the other rank roles). announce only for
// real promotions (rank ≥ 1), never for the baseline Initiate. Never throws into the caller.
async function applyTribeRank(guild, tribe, member, rankIndex, reason, announce = true) {
  const ranks = tribe.ranks || []; if (!ranks[rankIndex]) return;
  const keepId = ranks[rankIndex].roleId;
  const removeIds = ranks.filter((r, i) => i !== rankIndex && r.roleId && member.roles.cache.has(r.roleId)).map(r => r.roleId);
  try {
    if (removeIds.length) await member.roles.remove(removeIds, `tribe rank change — ${reason}`);
    if (keepId && !member.roles.cache.has(keepId)) await member.roles.add(keepId, `tribe rank: ${ranks[rankIndex].name} — ${reason}`);
    if (announce && rankIndex >= 1 && tribe.hallId) {
      const hall = await guild.channels.fetch(tribe.hallId).catch(() => null);
      if (hall) await hall.send({ content: `## ${tribe.emoji || '🌊'} Rank up\n> <@${member.id}> rose to **${ranks[rankIndex].name}**.`, allowedMentions: { users: [member.id] } }).catch(() => {});
    }
  } catch (e) { console.error('[tribe-rank] apply:', e.message); }
}
// Membership guard: the ONLY legitimate ways in/out of a tribe are the #roles picker (first join),
// /request-role approval, /tribe invite, and /tribe banish — each updates authoritative membership
// (tribes.setMembership). Any MANUAL role add or strip disagrees with it and is reverted here. One
// corrective action per fire; after it, authorized === hasRole so subsequent fires no-op (no loop).
async function enforceTribeMembership(member) {
  if (member.user.bot) return;
  for (const t of tribes.all()) {
    const authorized = tribes.isAuthorized(t.key, member.id);
    const hasRole = member.roles.cache.has(t.roleId);
    if (authorized === hasRole) continue;
    if (authorized && !hasRole) await member.roles.add(t.roleId, 'Tribe guard: manual strip reverted — release is via /tribe banish').catch(() => {});
    else await member.roles.remove(t.roleId, 'Tribe guard: manual add reverted — join via #roles / request / invite').catch(() => {});
  }
}
// Auto-promote (never demote) a member to the highest rank their tenure + Tides have earned.
async function maybePromoteTribeRank(guild, tribeKey, member) {
  const tribe = tribes.get(tribeKey); if (!tribe || !(tribe.ranks || []).length) return;
  if (tribes.isLeader(member, tribe)) return;   // the Warden (head) is above the rank ladder, never ranked
  if (['admin', 'mod'].includes(opspanel.memberTier(member))) return;   // staff sit in the General slot instead, also above the ladder
  const earned = tribes.earnedRankIndex(tribe, member.id);
  const current = tribes.currentRankIndex(member, tribe);
  if (earned > current) await applyTribeRank(guild, tribe, member, earned, 'auto — tenure + Tides', earned >= 1);
}

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot || !msg.guild) return;
    // Arena TYPED types (scramble/math/typing/riddle/emoji) watch messages live for the typed answer. Blitz is
    // NOT counted here (owner: "count at the end") — tallied from message history in endArena. Button types
    // (trivia/truefalse) and reaction score via their own handlers, not here.
    try {
      const ax = arena.get();
      if (ax && arena.TYPED_TYPES.includes(ax.type) && msg.channelId === ax.channelId && ax.answer &&
          msg.content.trim().toLowerCase() === String(ax.answer).trim().toLowerCase()) {
        const mine = tribes.memberTribe(msg.member);
        if (mine) {
          scoreArena(mine.key, msg.author.id);
          const nx = arena.nextTyped(ax.type, ax.used || []);   // fresh prompt; no in-game repeats (owner)
          arena.update({ answer: nx.answer, display: nx.display, round: (ax.round || 1) + 1, used: [...(ax.used || []), nx.key] });
          await msg.react('✅').catch(() => {});
          const ch = await msg.guild.channels.fetch(ax.channelId).catch(() => null);
          if (ch) await ch.send({ content: typedContent(ax.type, arena.get()), allowedMentions: { parse: [] } }).catch(() => {});
        }
      }
    } catch (e) { console.error('[arena] messageCreate:', e.message); }
    // Monthly contest channels: record entries (auto-🩷), enforce one-per-person, delete chatter/dupes.
    // If it removed the message there's nothing left to scan, so stop here.
    if (contest.isContestChannel(msg.channelId)) { const r = await contest.onMessage(msg); if (r.deleted) return; }
    // Mod-application applicant reply → mirror onto the staff review post + ping (private app threads have
    // no staff members, so replies would otherwise notify nobody). Runs before the content guard so an
    // attachment-only reply still relays; returns early so we don't watchlist-scan the private app thread.
    if (msg.channel?.isThread?.()) {
      try { if (await modapps.relayApplicantReply(msg, config)) return; }
      catch (e) { console.error('[modapps] relay:', e.message); }
    }
    if (!msg.content) return;
    const member = msg.member || await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (!member) return;
    // Tribe Tides: +1 for a message in a tribe's hall (or a bought 2nd text channel), capped once per
    // tideCooldownMs (60s default, 45s with the Faster Tides shop unlock) per member. Records their join-time
    // (for tenure) and auto-promotes their rank if tenure + Tides now clear the next threshold.
    try {
      const homeTribe = tribes.all().find(t => (t.hallId === msg.channelId || t.text2Id === msg.channelId) && member.roles.cache.has(t.roleId));
      if (homeTribe) {
        const ck = `${homeTribe.key}:${member.id}`; const now = Date.now();
        if (!(_tideCooldown.get(ck) > now - (homeTribe.tideCooldownMs || 60000))) {
          _tideCooldown.set(ck, now);
          tribes.recordJoin(homeTribe.key, member.id);
          tribes.addTides(homeTribe.key, member.id, 1);
          await maybePromoteTribeRank(msg.guild, homeTribe.key, member);
        }
      }
    } catch (e) { console.error('[tribe-tides]', e.message); }
    // Temporary word filter: staff arm a word/phrase to be auto-deleted for a period. Applies to
    // everyone EXCEPT staff (so mods can still discuss the term). Deleting ends the scan for this message.
    if (features.enabled('wordFilter') && !opspanel.memberTier(member)) {
      const hit = wordfilter.check(state, msg.content);
      if (hit) { await msg.delete().catch(e => console.error('[wordfilter] delete:', e.message)); return; }
    }
    // LAB pass (independent, private admin channel) — runs BEFORE the production routing so the watchlist
    // strict early-return below doesn't skip it. Staff excluded, same population as loose. Own try/catch so
    // an AI hiccup never blocks the real keyword flags that follow.
    if (features.enabled('smartWatchLab') && config.smartWatchLabChannelId && !opspanel.memberTier(member)) {
      try { await labEvaluateAndPost(msg, member); } catch (e) { console.error('[smartwatch-lab]', e.message); }
    }
    // STRICT: a watchlisted member trips a strict term → mod-announcements alert (ban buttons + ping).
    // Strict ENCOMPASSES loose — a watchlisted member is matched against strict + loose combined, so you
    // only ever add strict-ONLY extras to the strict list (every loose term is auto-included here).
    if (watchlist.isWatched(member.id)) {
      const strict = [...new Set([...watchlist.loadTerms(), ...watchlist.loadLoose()])];
      const hits = strict.length ? watchlist.matchTerms(msg.content, strict) : [];
      if (hits.length) { await watchlistAlert(msg, hits, { scope: 'strict' }); return; }   // strict wins - one report per message
    }
    // Everyone EXCEPT staff → the day-to-day #watch-log (no ping). WELFARE (support) takes priority over LOOSE.
    if (config.watchLogChannelId && !opspanel.memberTier(member)) {
      const welfare = watchlist.loadWelfare();
      const wHits = welfare.length ? watchlist.matchTerms(msg.content, welfare) : [];
      if (wHits.length) {
        await watchlistAlert(msg, wHits, { scope: 'welfare', channelId: config.watchLogChannelId, title: '🫂 Welfare check',
          color: 0x5DADE2, verb: 'may need support, flagged on the welfare watch', ping: false, buttons: 'dismiss' });
        return;
      }
      const loose = watchlist.loadLoose();
      const lHits = loose.length ? watchlist.matchTerms(msg.content, loose) : [];
      if (lHits.length) await watchlistAlert(msg, lHits, { scope: 'loose', channelId: config.watchLogChannelId,
        title: '🔎 Watch-log flag', color: 0xE7AC4E, verb: 'said something on the day-to-day watch list', ping: false });
    }
  } catch (e) { console.error('[watchlist] messageCreate:', e.message); }
});

// If a contest entry message is deleted (by its author or a mod), free that member to enter again.
client.on('messageDelete', async (msg) => {
  try { if (msg.channelId && contest.isContestChannel(msg.channelId)) await contest.onMessageDelete(msg); }
  catch (e) { console.error('[contest] messageDelete:', e.message); }
  // If a promotion-vote message is deleted by hand, auto-cancel its record so the orphan can't block a
  // re-open (the poll is unreachable once its message is gone — nothing left to vote on or resolve).
  try {
    const rec = promote.cancelByMessageId(msg.id);
    if (rec) console.log(`[promote] auto-cancelled orphaned vote for ${rec.candidateId} (message ${msg.id} deleted)`);
  } catch (e) { console.error('[promote] messageDelete:', e.message); }
});

// Button routing (verify panel · corner controls · conflict resolve) + /corner /uncorner below.
client.on('interactionCreate', async (interaction) => {
  // TEMP diag (hang investigation 2026-08-04): log every non-autocomplete interaction at entry so we can
  // prove whether "Send to corner" / /corner interactions even ARRIVE at the handler. Remove once resolved.
  if (!interaction.isAutocomplete?.()) {
    const kind = interaction.isChatInputCommand?.() ? `slash:${interaction.commandName}`
      : interaction.isMessageContextMenuCommand?.() ? `ctxmsg:${interaction.commandName}`
      : interaction.isUserContextMenuCommand?.() ? `ctxuser:${interaction.commandName}`
      : interaction.isButton?.() ? `btn:${interaction.customId}`
      : interaction.isStringSelectMenu?.() ? `select:${interaction.customId}`
      : interaction.isModalSubmit?.() ? `modal:${interaction.customId}`
      : `other:${interaction.type}`;
    console.error(`[idiag] IN ${kind} by ${interaction.user?.id} in #${interaction.channelId}`);
  }
  // /unban's user_id: autocomplete search over the actual ban list (see the names, don't paste a raw ID blind).
  if (interaction.isAutocomplete?.()) {
    if (interaction.commandName === 'unban') {
      try {
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const bans = await interaction.guild.bans.fetch().catch(() => null);
        const list = bans ? [...bans.values()] : [];
        const matches = list.filter(b => b.user.tag.toLowerCase().includes(focused) || b.user.id.includes(focused)).slice(0, 25);
        return interaction.respond(matches.map(b => ({ name: `${b.user.tag} (${b.user.id})`.slice(0, 100), value: b.user.id })));
      } catch (e) { console.error('[unban] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    if (interaction.commandName === 'strike' && interaction.options.getSubcommand() === 'remove') {
      try {
        const user = interaction.options.getUser('user');
        if (!user) return interaction.respond([]);
        const focused = interaction.options.getFocused() || '';
        return interaction.respond(strikes.autocompleteChoices(state, user.id, { query: focused }));
      } catch (e) { console.error('[strike-remove] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    if (interaction.commandName === 'appeal-reset') {
      try {
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const choices = appeals.listDecided()
          .filter(a => !focused || a.bannedTag.toLowerCase().includes(focused) || a.bannedId.includes(focused))
          .slice(0, 25)
          .map(a => ({ name: `${a.bannedTag} (${a.status})`.slice(0, 100), value: a.bannedId }));
        return interaction.respond(choices);
      } catch (e) { console.error('[appeal-reset] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    if (interaction.commandName === 'appeal' && interaction.options.getSubcommand() === 'strike') {
      try {
        const focused = interaction.options.getFocused() || '';
        // Scoped to the CALLER's own strikes only — self-service, and excludes the strike that
        // crossed the ban threshold (not appealable this way — see strikeAppeals.js's submit()).
        return interaction.respond(strikes.autocompleteChoices(state, interaction.user.id, { query: focused, excludeCrossedBan: true }));
      } catch (e) { console.error('[appeal-strike] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    if (interaction.commandName === 'tribe' || interaction.commandName === 'tribe-admin') {
      try {
        const foc = interaction.options.getFocused(true);
        const focused = String(foc.value || '').toLowerCase();
        if (foc.name === 'rank') {   // /tribe rank — offer THIS tribe's rank rungs (value = index)
          const tribe = tribes.myTribe(interaction.member) || tribes.leaderTribe(interaction.member);
          const ranks = (tribe && tribe.ranks) || [];
          return interaction.respond(ranks
            .map((r, i) => ({ name: `${i + 1}. ${r.name}`.slice(0, 100), value: String(i) }))
            .filter(c => !focused || c.name.toLowerCase().includes(focused)).slice(0, 25));
        }
        const choices = tribes.all()
          .filter(t => !focused || (t.name || '').toLowerCase().includes(focused) || t.key.includes(focused))
          .slice(0, 25)
          .map(t => ({ name: `${t.emoji || ''} ${t.shortName || t.name}`.trim().slice(0, 100), value: t.key }));
        return interaction.respond(choices);
      } catch (e) { console.error('[tribe] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    if (interaction.commandName === 'features') {
      try {
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const choices = features.REGISTRY
          .filter(r => !focused || r.key.toLowerCase().includes(focused))
          .slice(0, 25)
          .map(r => ({ name: `${r.key}${features.enabled(r.key) ? ' (on)' : ' (off)'}`.slice(0, 100), value: r.key }));
        return interaction.respond(choices);
      } catch (e) { console.error('[features] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    // Role-filtered member pickers: only list members who actually hold the applicable role, so the
    // list in the command matches the dropdowns (class fix). promote-trial/demote-trial → trial mods;
    // promote-mod → mods (excluding admins/owners who hold the mod role via nesting).
    if (interaction.commandName === 'promote-trial' || interaction.commandName === 'demote-trial' || interaction.commandName === 'promote-mod') {
      try {
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const roleId = interaction.commandName === 'promote-mod' ? config.modRoleId : config.trialModRoleId;
        const role = roleId && await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) return interaction.respond([]);
        let members = [...role.members.values()];
        if (interaction.commandName === 'promote-mod') members = members.filter(m => opspanel.memberTier(m) === 'mod');   // real mods only, not admins/owners
        const matches = members
          .filter(m => !focused || m.user.username.toLowerCase().includes(focused) || m.displayName.toLowerCase().includes(focused) || m.id.includes(focused))
          .slice(0, 25)
          .map(m => ({ name: `${m.displayName} (@${m.user.username})`.slice(0, 100), value: m.id }));
        return interaction.respond(matches);
      } catch (e) { console.error(`[${interaction.commandName}] autocomplete:`, e.message); return interaction.respond([]).catch(() => {}); }
    }
    return interaction.respond([]).catch(() => {});
  }
  // Tier-gated ops dashboard (buttons / select / modal, all customId 'fops_*'). Handles its own tier
  // checks; must run before the isChatInputCommand guard which would drop selects + modal submits.
  if (opspanel.isPanelInteraction(interaction)) {
    try { await opspanel.handlePanel(interaction); }
    catch (e) {
      console.error(`[fops] ${e.message}`);
      const msg = { content: copy.guards.somethingWrong, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
    return;
  }
  // Event organizer dashboard (buttons/modal, customId 'evp_*') — its own namespace, gated to organizers.
  if (contest.isEventPanelInteraction(interaction)) {
    try { await contest.handleEventPanel(interaction); }
    catch (e) {
      console.error(`[contest] evp: ${e.message}`);
      const msg = { content: copy.guards.somethingWrong, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
    return;
  }
  // Permguard reconcile popup (buttons, customId 'pg_*') — owner-only, gated inside the handler.
  if (permguard.isReconcileInteraction(interaction)) {
    try { await permguard.handleReconcile(interaction); }
    catch (e) {
      console.error(`[permguard] reconcile: ${e.message}`);
      const msg = { content: copy.guards.somethingWrong, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
    return;
  }
  // Smart-watch LAB grading (admin-only). customId: sw_label:<strike|corner|fine|genuine|hyperbole>:<aiSurface 0/1>.
  // Records the admin's ground-truth verdict as a calibration example (fed back into the judge prompt, scoped
  // by task) AND scores the AI's own would-surface call, then locks the post with a task-specific accuracy line.
  if (interaction.isButton?.() && interaction.customId.startsWith('sw_label:')) {
    const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
      || (config.adminRoleId && interaction.member?.roles?.cache?.has(config.adminRoleId));
    if (!isAdmin) return interaction.reply({ content: 'Only admins can grade lab flags.', flags: MessageFlags.Ephemeral });
    const [, verdict, aiS] = interaction.customId.split(':');
    const meta = smartwatch.VERDICT_META[verdict];
    if (!meta) return interaction.reply({ content: 'Unknown label.', flags: MessageFlags.Ephemeral });
    const aiWouldSurface = aiS === '1';
    const emb = interaction.message.embeds?.[0];
    const fieldVal = n => emb?.fields?.find(f => f.name === n || f.name.startsWith(n))?.value || '';
    const content = fieldVal('Message (saved copy)');
    const matched = fieldVal('Matched');
    const footer = emb?.footer?.text || '';
    const authorId = (footer.match(/flagged (\d+)/) || [])[1] || null;
    const channelName = (footer.match(/#(\S+)/) || [])[1] || null;
    smartwatch.addExample({ ts: Date.now(), verdict, task: meta.task, content, matchedTerms: matched, channel: channelName,
      aiWouldSurface, author: authorId, by: interaction.user.id, byTag: interaction.user.tag });
    const correct = aiWouldSurface === meta.surface;
    const stats = smartwatch.labStats(meta.task);          // accuracy scoped to this task (rule vs welfare)
    const acc = stats.total ? Math.round(100 * stats.right / stats.total) : 0;
    const e2 = EmbedBuilder.from(emb).setColor(correct ? 0x3BA55D : 0xED4245).addFields({
      name: 'Labeled ✅', value: `**${meta.label.split(' (')[0]}** by <@${interaction.user.id}>, AI was ${correct ? '✅ right' : '❌ wrong'}\n` +
        `Judge accuracy so far (${meta.task}): **${acc}%** (${stats.right}/${stats.total}) · this example now guides the ${meta.task} judge.` });
    // Drop the grade/note buttons but KEEP any Link (jump) button (across both rows) so the card stays navigable.
    const links = (interaction.message.components?.flatMap(r => r.components) || []).filter(b => b.style === ButtonStyle.Link);
    const comps = links.length ? [new ActionRowBuilder().addComponents(...links.map(b => ButtonBuilder.from(b)))] : [];
    return interaction.update({ embeds: [e2], components: comps }).catch(() => {});
  }
  // ✏️ Correct-its-read: record the correct verdict + REASONING (a richer calibration example than a plain
  // grade — the note is fed back into the judge prompt). customId sw_note:<task>:<aiSurface 0/1>.
  if (interaction.isButton?.() && interaction.customId.startsWith('sw_note:')) {
    const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
      || (config.adminRoleId && interaction.member?.roles?.cache?.has(config.adminRoleId));
    if (!isAdmin) return interaction.reply({ content: 'Only admins can correct the judge.', flags: MessageFlags.Ephemeral });
    const [, task, aiS] = interaction.customId.split(':');
    const hint = task === 'welfare' ? 'genuine / hyperbole' : 'fine / surface / corner / strike';
    const modal = new ModalBuilder().setCustomId(`sw_notemodal:${task}:${aiS}:${interaction.message.id}`).setTitle('Correct the judge’s read');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('verdict').setLabel('Correct verdict').setPlaceholder(hint).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note').setLabel('The correct read (teaches the judge)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300)));
    return interaction.showModal(modal);
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('sw_notemodal:')) {
    const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
      || (config.adminRoleId && interaction.member?.roles?.cache?.has(config.adminRoleId));
    if (!isAdmin) return interaction.reply({ content: 'Only admins can correct the judge.', flags: MessageFlags.Ephemeral });
    const [, task, aiS, cardMsgId] = interaction.customId.split(':');
    let verdict = (interaction.fields.getTextInputValue('verdict') || '').trim().toLowerCase();
    if (verdict === 'surface') verdict = 'glance';   // accept the button's wording ("Surface, no action")
    const note = (interaction.fields.getTextInputValue('note') || '').trim();
    const meta = smartwatch.VERDICT_META[verdict];
    if (!meta || meta.task !== task) return interaction.reply({ content: `Verdict must be one of: ${task === 'welfare' ? 'genuine / hyperbole' : 'fine / surface / corner / strike'}.`, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Read the flagged message content off the card (survives even if the original message was deleted).
    let content = '', authorId = null, channelName = null, card = null;
    try {
      const labCh = await interaction.guild.channels.fetch(config.smartWatchLabChannelId).catch(() => null);
      card = labCh && await labCh.messages.fetch(cardMsgId).catch(() => null);
      const emb = card?.embeds?.[0];
      content = emb?.fields?.find(f => f.name.startsWith('Message'))?.value || '';
      const footer = emb?.footer?.text || '';
      authorId = (footer.match(/flagged (\d+)/) || [])[1] || null;
      channelName = (footer.match(/#(\S+)/) || [])[1] || null;
    } catch { /* best-effort */ }
    const aiWouldSurface = aiS === '1';
    smartwatch.addExample({ ts: Date.now(), verdict, task: meta.task, content, note, channel: channelName, aiWouldSurface, author: authorId, by: interaction.user.id, byTag: interaction.user.tag });
    const correct = aiWouldSurface === meta.surface;
    const stats = smartwatch.labStats(meta.task);
    const acc = stats.total ? Math.round(100 * stats.right / stats.total) : 0;
    try {
      if (card?.embeds?.[0]) {
        const e2 = EmbedBuilder.from(card.embeds[0]).setColor(correct ? 0x3BA55D : 0xED4245).addFields({
          name: '✏️ Corrected', value: `**${meta.label.split(' (')[0]}** by <@${interaction.user.id}>, AI was ${correct ? '✅ right' : '❌ wrong'}\ncorrect read: _${note}_\nnow guiding the ${meta.task} judge · accuracy **${acc}%** (${stats.right}/${stats.total})`.slice(0, 1024) });
        const links = (card.components?.flatMap(r => r.components) || []).filter(b => b.style === ButtonStyle.Link);
        await card.edit({ embeds: [e2], components: links.length ? [new ActionRowBuilder().addComponents(...links.map(b => ButtonBuilder.from(b)))] : [] }).catch(() => {});
      }
    } catch { /* annotate best-effort */ }
    return interaction.editReply(`✏️ Correction saved. The judge will now weigh: _"${note}"_ on cases like this. (${meta.task} accuracy ${acc}%.)`);
  }
  // Rule picker shown before the strike reason+weight modal (watch-log Strike button + right-click Strike) —
  // a modal can't hold a dropdown, so this is a select-then-modal step, same shape as the dashboard's
  // Corner/Ban pickers. customId: strike_rule_pick:<memberId>:<channelId>:<messageId>
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('strike_rule_pick:')) {
    if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnlyStrike, flags: MessageFlags.Ephemeral });
    const [, memberId, channelId, messageId] = interaction.customId.split(':');
    const ruleN = interaction.values[0] === 'none' ? null : interaction.values[0];
    return interaction.showModal(strikeReasonModal(memberId, channelId, messageId, ruleN));
  }
  // Send-to-corner rule picker → duration/reason/sweep modal. customId: corner_rule_pick:<memberId>:<channelId>:<messageId>
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('corner_rule_pick:')) {
    const [, memberId, channelId, messageId] = interaction.customId.split(':');
    if (!opspanel.tierOf(interaction) && !miniModCanActOn(interaction, channelId)) return interaction.reply({ content: copy.guards.modRoleOnly, flags: MessageFlags.Ephemeral });
    const ruleN = interaction.values[0] === 'none' ? null : interaction.values[0];
    return interaction.showModal(cornerReasonModal(memberId, channelId, messageId, ruleN));
  }
  // #roles pickers (roleselect.js) — any member, no staff gate.
  // Age/Color: single-select dropdown — swap to the chosen role, stripping any other held role in the
  // same group. Age additionally refuses outright once Verified (registration lock; index.js's
  // enforceRegistrationLock is the backstop either way, but this avoids the confusing "applied then
  // silently reverted" experience).
  // #roles Tribes picker — loyalty model: first tribe is a free self-join; after that you can't self-join
  // (must be accepted) and can't switch/leave (a Warden must banish you first).
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'roleselect_tribe') {
    const tribe = tribes.get(interaction.values[0]);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    const member = interaction.member;
    const current = tribes.memberTribe(member);
    if (current) return interaction.reply({ content: `You’re already pledged to **${current.shortName || current.name}**. You can’t leave or switch on your own. Its **${tribes.leaderTitle(current)} must release you** first (\`/tribe banish\`).`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (tribes.isVeteran(member.id)) return interaction.reply({ content: `You’ve pledged to a tribe before, so you can’t just self-join. **${tribe.shortName || tribe.name}** has to **accept** you. Use \`/request-role\` to petition, or ask its ${tribes.leaderTitle(tribe)} to invite you.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    const gate = tribes.getEntranceGate(tribe.key);
    if (gate) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`roleselect_tribegate:${tribe.key}:a`).setLabel(gate.optionA).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`roleselect_tribegate:${tribe.key}:b`).setLabel(gate.optionB).setStyle(ButtonStyle.Primary));
      return interaction.reply({ content: `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: prove yourself\n> ${gate.prompt}`, components: [row], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await joinTribeSelfServe(interaction.guild, tribe, member);
    return interaction.editReply(r.ok ? r.content : 'Couldn’t add the tribe role. Tell an admin.');
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('roleselect_tribegate:')) {
    const [, tribeKey, choice] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    const member = interaction.member;
    const current = tribes.memberTribe(member);
    if (current) return interaction.update({ content: `You’re already pledged to **${current.shortName || current.name}**. You can’t self-join anywhere else.`, components: [] });
    if (tribes.isVeteran(member.id)) return interaction.update({ content: `You’ve pledged before, so you can’t self-join anymore. Ask to be accepted instead.`, components: [] });
    const gate = tribes.getEntranceGate(tribe.key);
    if (gate && choice !== gate.correct) return interaction.update({ content: `❌ Not the answer **${tribe.shortName || tribe.name}** was looking for. Head back to #roles and try again.`, components: [] });
    await interaction.deferUpdate();
    const r = await joinTribeSelfServe(interaction.guild, tribe, member);
    return interaction.editReply({ content: r.ok ? r.content : 'Couldn’t add the tribe role. Tell an admin.', components: [] });
  }
  if (interaction.isStringSelectMenu?.() && (interaction.customId === 'roleselect_age' || interaction.customId === 'roleselect_color')) {
    const isAge = interaction.customId === 'roleselect_age';
    if (isAge && config.verifiedRoleId && interaction.member.roles.cache.has(config.verifiedRoleId)) {
      return interaction.reply({ content: 'Your age bracket is locked once you’re verified. It’s a one-time registration choice. If it’s wrong, ask a mod/admin and they can correct it for you.', flags: MessageFlags.Ephemeral });
    }
    const group = (isAge ? roleselect.AGE : roleselect.COLORS).map(([, id]) => id);
    const chosen = interaction.values[0];
    const clearing = chosen === 'none'; // color-only - age has no clear option, always a real bracket
    const toRemove = group.filter(id => id !== chosen && interaction.member.roles.cache.has(id));
    try {
      if (toRemove.length) await interaction.member.roles.remove(toRemove, 'Role picker: single-select swap');
      if (!clearing && !interaction.member.roles.cache.has(chosen)) await interaction.member.roles.add(chosen, 'Role picker: single-select pick');
    } catch (e) { return interaction.reply({ content: `Couldn’t update that: ${e.message}`, flags: MessageFlags.Ephemeral }); }
    return interaction.reply({ content: clearing ? '✅ Color cleared.' : `✅ Set to <@&${chosen}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // Watchlist-suggest approve menu — an ADMINS-★ picks terms to add from the recommender's multi-select.
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'wlsug_add') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can add terms.', flags: MessageFlags.Ephemeral });
    const done = suggest.applySelection(interaction.values);
    return interaction.reply({ flags: MessageFlags.Ephemeral,
      content: done.length ? `➕ Added:\n${done.map(d => `• \`${d}\``).join('\n')}` : 'Nothing added.' });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('modapp_submit')) {   // 'modapp_submit' or 'modapp_submit:lang:<Language>'
    try { return await modapps.submitFromModal(interaction, config); }
    catch (e) { console.error(`[modapps] modal ${e.message}`); return interaction.reply({ content: 'Could not submit that. Try again.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'modapp_pos_langsel') {
    try { return await modapps.handlePositionSelect(interaction); }
    catch (e) { console.error(`[modapps] langsel ${e.message}`); return interaction.reply({ content: 'Could not open that.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('modapp_ask:')) {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can do that.', flags: MessageFlags.Ephemeral });
    try { return await modapps.handleAskModal(interaction); }
    catch (e) { console.error(`[modapps] ask ${e.message}`); return interaction.reply({ content: 'Could not send.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  // Send-to-corner reason modal (cornerReason feature). customId: corner_reason:<memberId>:<channelId>:<messageId>
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('corner_reason:')) {
    try {
      const [, memberId, channelId, messageId, ruleSeg] = interaction.customId.split(':');
      const ruleN = ruleSeg && ruleSeg !== 'x' ? ruleSeg : null;
      const rawReason = (interaction.fields.getTextInputValue('reason') || '').trim();
      const reason = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${rawReason ? `, ${rawReason}` : ''}` : (rawReason || null);
      let durStr = '';
      try { durStr = (interaction.fields.getTextInputValue('duration') || '').trim(); } catch { /* older modal had no duration field */ }
      let timeoutStr = '';
      try { timeoutStr = (interaction.fields.getTextInputValue('timeout') || '').trim(); } catch { /* older modal had no timeout field */ }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let durationMs = config.cornerDefaultDurationMs;
      if (durStr) { const d = corner.parseDuration(durStr); if (!d) return interaction.editReply('Bad duration. Use e.g. `30s`, `10m`, `2h`, `1d` (or leave it blank for 15m).'); durationMs = d; }
      let timeoutMs = null;
      if (timeoutStr) { timeoutMs = corner.parseDuration(timeoutStr); if (!timeoutMs) return interaction.editReply('Bad timeout duration. Use e.g. `30m`, `2h`, `1d` (or leave it blank for none).'); }
      const guild = interaction.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return interaction.editReply('That member isn’t in the server anymore.');
      // Tier hierarchy check (moved here from the context menu so the rule picker can show instantly): you
      // can't corner someone of a higher staff tier than you.
      const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
      if ((RANK[opspanel.memberTier(member)] || 0) > (RANK[opspanel.tierOf(interaction)] || 0))
        return interaction.editReply(`You can’t corner someone of a higher staff tier than you (they’re **${opspanel.memberTier(member)}**).`);
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      const target = ch && await ch.messages.fetch(messageId).catch(() => null);
      if (!target) return interaction.editReply('That message is gone. Can’t corner from it.');
      const res = await cornerFromMessage(guild, interaction.user.id, member, target, reason, durationMs, ruleN);
      if (!res.ok) return interaction.editReply(`Failed to corner: ${res.error}`);
      let timeoutNote = '';
      if (timeoutMs) {
        const ok = await member.timeout(timeoutMs, reason || 'Sent to corner').then(() => true).catch(e => { console.error('[corner-reason] timeout:', e.message); return false; });
        timeoutNote = ok ? ` · ⏱️ also timed out ${Math.floor(timeoutMs / 60000)}m` : ' · ⚠️ timeout failed';
      }
      // Sweep: also corner everyone else (non-staff, non-bot) who posted in this channel in the last N minutes.
      let sweepStr = ''; try { sweepStr = (interaction.fields.getTextInputValue('sweep') || '').trim(); } catch { /* older modal */ }
      let sweepNote = '';
      const mins = sweepStr ? Number(sweepStr) : 0;
      if (Number.isFinite(mins) && mins > 0) {
        const since = Date.now() - Math.min(mins, 120) * 60000;   // cap the look-back at 2h
        const recent = target.channel && await target.channel.messages.fetch({ limit: 100 }).catch(() => null);
        const authorIds = new Set();
        if (recent) for (const m of recent.values()) { if (m.createdTimestamp >= since && !m.author.bot && m.author.id !== member.id) authorIds.add(m.author.id); }
        const sweepMembers = [];
        for (const id of authorIds) { const mm = await guild.members.fetch(id).catch(() => null); if (mm && !opspanel.memberTier(mm) && !(config.trialModRoleId && mm.roles.cache.has(config.trialModRoleId))) sweepMembers.push(mm); }
        const actorRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[opspanel.tierOf(interaction)] || 0;
        const { done, skipped, whenPhrase } = await cornerMany(guild, interaction.user.id, actorRank, sweepMembers, durationMs, { reasonText: reason });
        sweepNote = `\n🧹 Sweep (${Math.min(mins, 120)}m): +${done.length} more${done.length ? ` (${done.map(id => `<@${id}>`).join(', ')})` : ''}${skipped.length ? ` · skipped ${skipped.length}` : ''}`;
        // Public-facing result: announce the sweep in the channel so everyone sees it, not just the mod's ack.
        if (done.length) await target.channel.send({
          content: `🧹 **Corner sweep**: <@${interaction.user.id}> cooled this channel down and also sent ${done.map(id => `<@${id}>`).join(', ')} to the corner ${whenPhrase}.`,
          allowedMentions: { parse: [] } }).catch(e => console.error('[corner-sweep] public announce:', e.message));
      }
      const relSec = Math.floor((Date.now() + durationMs) / 1000);
      return interaction.editReply({ content: `🚫 Sent <@${member.id}> to the corner until <t:${relSec}:f>${reason ? ` (${reason})` : ''}. Stripped **${res.stripped}** role(s).${timeoutNote}${sweepNote}`, allowedMentions: { parse: [] } });
    } catch (e) { console.error(`[corner-reason] ${e.message}`); return (interaction.deferred ? interaction.editReply('Could not corner.') : interaction.reply({ content: 'Could not corner.', flags: MessageFlags.Ephemeral })).catch(() => {}); }
  }
  // Strike reason+weight modal. customId: strike_reason:<memberId>:<channelId>:<messageId>
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('strike_reason:')) {
    if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnlyStrike, flags: MessageFlags.Ephemeral });
    try {
      const [, memberId, channelId, messageId, ruleSeg] = interaction.customId.split(':');
      const ruleN = ruleSeg && ruleSeg !== 'x' ? ruleSeg : null;
      const rawReason = (interaction.fields.getTextInputValue('reason') || '').trim();
      if (!ruleN && !rawReason) return interaction.reply({ content: 'Give a reason: pick a rule beforehand, type a reason, or both.', flags: MessageFlags.Ephemeral });
      const reason = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${rawReason ? `, ${rawReason}` : ''}` : rawReason;
      const weightRaw = (interaction.fields.getTextInputValue('weight') || '').trim();
      // Blank field (allowed when the rule's weight was pre-filled and the field made optional) → use
      // the rule's own decided weight. Anything typed always wins, even if it differs from the rule's
      // default — that's a deliberate override, not an error.
      const ruleObj = ruleN ? rules.byIndex(Number(ruleN)) : null;
      const ruleWeight = ruleObj ? rules.weightOf(ruleObj.key) : null;
      const weight = weightRaw ? Number(weightRaw) : ruleWeight;
      if (![1, 2, 3].includes(weight)) return interaction.reply({ content: 'Weight must be 1, 2, or 3.', flags: MessageFlags.Ephemeral });
      let cornerMs = null, cornerStr = '';
      try { cornerStr = (interaction.fields.getTextInputValue('corner') || '').trim(); } catch { /* older modal had no corner field */ }
      if (cornerStr) { cornerMs = corner.parseDuration(cornerStr); if (!cornerMs) return interaction.reply({ content: 'Bad corner duration. Use e.g. `30m`, `2h`, `30s` (or leave it blank).', flags: MessageFlags.Ephemeral }); }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return interaction.editReply(copy.common.notInServer);
      if (member.id === guild.ownerId) return interaction.editReply('You can’t strike the server owner.');
      const res = await strikes.addStrike(guild, member, state, { weight, ruleIndex: ruleN, reason, byId: interaction.user.id, byTag: interaction.user.tag });
      let cornerNote = '';
      if (cornerMs) {
        const cr = await corner.corner(guild, member, cornerMs, state, interaction.user.id, ruleN);
        if (cr.ok) {
          const relSec = Math.floor((Date.now() + cornerMs) / 1000);
          cornerNote = ` · ⛓️ also cornered until <t:${relSec}:R>`;
          try { const cch = await guild.channels.fetch(config.cornerChannelId).catch(() => null); if (cch) await cch.send(cornerSentMessage(member.id, `until <t:${relSec}:f>`, reason)); } catch { /* announce best-effort */ }
          await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER (with strike)', color: CORNER_RED, desc: `<@${member.id}> was cornered until ${relPhrase(relSec * 1000)} alongside a strike.\n**By:** <@${interaction.user.id}>` });
        } else cornerNote = ` · ⚠️ corner failed: ${cr.error}`;
      }
      // In-channel notice on the flagged message (no DM) — public, carries the reason.
      if (channelId !== '0' && messageId !== '0') {
        const ch = await guild.channels.fetch(channelId).catch(() => null);
        const orig = ch && await ch.messages.fetch(messageId).catch(() => null);
        // Strikes are a real notification the member should get, not a reference-only mention — ping them.
        if (orig) await orig.reply({ content: `⚠️ <@${member.id}>, a strike was given for this message: ${reason} (${weight} unit${weight > 1 ? 's' : ''}). Strike ID: \`${res.id}\`. Appealable with \`/appeal strike\`.`, allowedMentions: { users: [member.id] } }).catch(() => {});
      }
      const banNote = res.crossedBan ? banConfirmRow(member.id, 'Confirm ban') : null;
      await ownerlog.log(guild, { emoji: '⚠️', title: 'Strike given', color: 0xED4245,
        detail: `<@${member.id}> — ${strikes.formatUnits(weight)} unit(s), ${reason} — by <@${interaction.user.id}>. Now ${strikes.formatUnits(res.totalUnits)}/${strikes.BAN_THRESHOLD}.` });
      return interaction.editReply({ content: `⚠️ Gave <@${member.id}> a **${weight}-unit** strike, now **${strikes.formatUnits(res.totalUnits)}/${strikes.BAN_THRESHOLD} units** (${res.tier})${res.crossedBan ? ', 🔨 **crossed the ban threshold**' : ''}${cornerNote}.`,
        components: banNote ? [banNote] : [] });
    } catch (e) { console.error(`[strike-reason] ${e.message}`); return (interaction.deferred ? interaction.editReply('Could not strike.') : interaction.reply({ content: 'Could not strike.', flags: MessageFlags.Ephemeral })).catch(() => {}); }
  }
  // Corner "Appeal a strike" button: cornered members can't run /appeal (the corner removes slash access),
  // but a button is not gated by that. Click opens an ephemeral picker of their appealable strikes.
  if (interaction.isButton?.() && interaction.customId === 'strikeappeal_start') {
    if (!features.enabled('strikeAppeals')) return interaction.reply({ content: 'Strike appeals are not available right now.', flags: MessageFlags.Ephemeral });
    const choices = strikes.autocompleteChoices(state, interaction.user.id, { excludeCrossedBan: true });
    if (!choices.length) return interaction.reply({ content: 'You have no active strikes that can be appealed.', flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder().setCustomId('strikeappeal_pick').setPlaceholder('Which strike do you want to appeal?')
      .addOptions(choices.slice(0, 25).map(c => ({ label: c.name.slice(0, 100), value: c.value })));
    return interaction.reply({ content: '⚖️ Pick the strike you want to appeal. I will open a private thread with staff, and you can reach it even while cornered.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'strikeappeal_pick') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await strikeAppeals.submit(interaction.guild, interaction.member, state, interaction.values[0], null);
    return interaction.editReply(r.ok ? `⚖️ Opened your strike appeal in <#${r.threadId}>. Head there to explain it to staff.` : `❌ ${r.msg}`);
  }
  // ---- Guided tribe builder: /tribe-admin create's modal + button flow (see wizardStatusMessage above) ----
  const wizExpired = () => ({ content: 'This tribe build expired. Run `/tribe-admin create` again.', flags: MessageFlags.Ephemeral });
  if (interaction.isModalSubmit?.() && interaction.customId === 'tribewiz_identity') {
    if (!wizardGet(interaction.user.id)) return interaction.reply(wizExpired());
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name) return interaction.reply({ content: 'Give the tribe a name.', flags: MessageFlags.Ephemeral });
    wizardTouch(interaction.user.id, {
      name: name.slice(0, 80),
      shortName: interaction.fields.getTextInputValue('short_name').trim().slice(0, 40) || null,
      emoji: interaction.fields.getTextInputValue('emoji').trim().slice(0, 10) || null,
      pointsName: interaction.fields.getTextInputValue('points_name').trim().slice(0, 20) || null,
      leaderTitle: interaction.fields.getTextInputValue('leader_title').trim().slice(0, 40) || null,
    });
    const msg = wizardStatusMessage(interaction.user.id);
    return interaction.message ? interaction.update(msg) : interaction.reply({ ...msg, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'tribewiz_colors') {
    if (!wizardGet(interaction.user.id)) return interaction.reply(wizExpired());
    const color = parseTribeHex(interaction.fields.getTextInputValue('color'));
    if (color === null) return interaction.reply(badHexReply('primary'));
    const c2raw = interaction.fields.getTextInputValue('color2');
    const color2 = c2raw ? parseTribeHex(c2raw) : null;
    if (c2raw && color2 === null) return interaction.reply(badHexReply('second'));
    wizardTouch(interaction.user.id, { color, color2 });
    const msg = wizardStatusMessage(interaction.user.id);
    return interaction.message ? interaction.update(msg) : interaction.reply({ ...msg, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'tribewiz_land') {
    if (!wizardGet(interaction.user.id)) return interaction.reply(wizExpired());
    const g = id => interaction.fields.getTextInputValue(id).trim();
    const channelNames = {}, channelTopics = {};
    if (g('throne_name')) channelNames.throne = g('throne_name').slice(0, 30);
    if (g('hall_name')) channelNames.hall = g('hall_name').slice(0, 30);
    if (g('voice_name')) channelNames.voice = g('voice_name').slice(0, 30);
    if (g('throne_purpose')) channelTopics.throne = g('throne_purpose').slice(0, 200);
    if (g('hall_purpose')) channelTopics.hall = g('hall_purpose').slice(0, 200);
    wizardTouch(interaction.user.id, { channelNames: Object.keys(channelNames).length ? channelNames : null, channelTopics: Object.keys(channelTopics).length ? channelTopics : null });
    const msg = wizardStatusMessage(interaction.user.id);
    return interaction.message ? interaction.update(msg) : interaction.reply({ ...msg, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isButton?.() && interaction.customId === 'tribewiz_identity_btn') {
    const w = wizardGet(interaction.user.id);
    if (!w) return interaction.reply(wizExpired());
    const modal = tribeIdentityModal();
    if (w.name) modal.components[0].components[0].setValue(w.name);
    if (w.shortName) modal.components[1].components[0].setValue(w.shortName);
    if (w.emoji) modal.components[2].components[0].setValue(w.emoji);
    if (w.pointsName) modal.components[3].components[0].setValue(w.pointsName);
    if (w.leaderTitle) modal.components[4].components[0].setValue(w.leaderTitle);
    return safeShowModal(interaction, modal);
  }
  if (interaction.isButton?.() && interaction.customId === 'tribewiz_colors_btn') {
    const w = wizardGet(interaction.user.id);
    if (!w) return interaction.reply(wizExpired());
    return safeShowModal(interaction, tribeColorsModal(w));
  }
  if (interaction.isButton?.() && interaction.customId === 'tribewiz_land_btn') {
    const w = wizardGet(interaction.user.id);
    if (!w) return interaction.reply(wizExpired());
    return safeShowModal(interaction, tribeLandModal(w));
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'tribewiz_style') {
    if (!wizardGet(interaction.user.id)) return interaction.reply(wizExpired());
    wizardTouch(interaction.user.id, { style: interaction.values[0] });
    return interaction.update(wizardStatusMessage(interaction.user.id));
  }
  if (interaction.isButton?.() && interaction.customId === 'tribewiz_cancel') {
    _tribeWizards.delete(interaction.user.id);
    return interaction.update({ content: 'Tribe build cancelled.', components: [] });
  }
  if (interaction.isButton?.() && interaction.customId === 'tribewiz_build') {
    const w = wizardGet(interaction.user.id);
    if (!w || !w.name || w.color == null) return interaction.reply({ content: 'Fill in at least Identity (name) and Colours before building.', flags: MessageFlags.Ephemeral });
    const leaderMember = await interaction.guild.members.fetch(w.leaderId).catch(() => null);
    // BUG FIXED 2026-08-03: this only ever accepted admin/owner, so a mod who legitimately gathered 3
    // co-signs would still get rejected at the final step with a confusing "no longer holds the admin role"
    // error, having never actually been able to complete founding a tribe. Must mirror the EXACT same
    // eligibility rule as the initial /tribe-admin create check (admin/owner unrestricted, OR mod tier
    // founding for themselves specifically).
    const leaderTier = leaderMember && opspanel.memberTier(leaderMember);
    const leaderIsEligible = leaderMember && (['admin', 'owner'].includes(leaderTier) || (leaderTier === 'mod' && leaderMember.id === interaction.user.id));
    if (!leaderIsEligible) return interaction.reply({ content: 'The chosen leader is no longer eligible (must still hold the admin role, or for a mod founding their own tribe, still be that same mod).', flags: MessageFlags.Ephemeral });
    await interaction.update({ content: '🏗️ Building the tribe...', components: [] });
    try {
      // Grab the co-signers BEFORE clearing the founding request (nothing left to read after that).
      const foundingReq = tribes.getFoundingRequest(interaction.user.id);
      const cosignerIds = (foundingReq?.cosigns || []).filter(id => id !== leaderMember.id);
      const b = await buildTribe(interaction.guild, {
        name: w.name, shortName: w.shortName, emoji: w.emoji, color: w.color, color2: w.color2, style: w.style, leaderMember,
        pointsName: w.pointsName, leaderTitle: w.leaderTitle, channelNames: w.channelNames, channelTopics: w.channelTopics,
      }, config);
      for (const ch of [b.cat, b.throne, b.hall, b.vc]) await permguard.blessChannel(interaction.guild, ch.id).catch(() => {});
      // Mark whether this is a mod-founded tribe (the 3-mod-leader requirement applies to it) vs an
      // admin/owner-founded one (a single admin can lead solo, exempt). Drives sweepLeaderRequirement.
      tribes.update(b.tribe.key, { foundedByMod: leaderTier === 'mod' });
      _tribeWizards.delete(interaction.user.id);
      tribes.clearFoundingRequest(interaction.user.id);   // only clear on ACTUAL success — see the create handler's fix for why
      // A mod-founded tribe isn't led solo, the founder + the 2 mods who co-signed lead it TOGETHER (owner,
      // 2026-08-03: "they are meant to lead it together") — all become co-leaders of the same leaderRoleId.
      const coLeaderIds = [], coLeaderFails = [];
      for (const id of cosignerIds) {
        const coMember = await interaction.guild.members.fetch(id).catch(() => null);
        const r = coMember && await addCoLeader(interaction.guild, b.tribe, b.leaderRole, coMember);
        if (r?.ok) coLeaderIds.push(id); else coLeaderFails.push(`<@${id}>${r?.reason ? ` (${r.reason})` : ''}`);
      }
      const leaderList = [leaderMember.id, ...coLeaderIds].map(id => `<@${id}>`).join(', ');
      const failNote = coLeaderFails.length ? `\n-# Couldn’t co-lead: ${coLeaderFails.join(', ')}` : '';
      return interaction.editReply({ content: `## ${b.tribe.emoji} ${b.tribe.name}: founded\n-# built by <@${interaction.user.id}>\n> Role <@&${b.role.id}> · Leader <@&${b.leaderRole?.id}> → ${leaderList}\n> Land: <#${b.throne.id}> · <#${b.hall.id}> · <#${b.vc.id}>\n-# Members can \`/request-role\` the role · channels blessed in permguard.${failNote}`, allowedMentions: { parse: [] } });
    } catch (e) {
      console.error('[tribe-admin create]', e.message);
      return interaction.editReply(`❌ Build failed: ${e.message}`);
    }
  }
  // ---- Tribe nominations: propose (throne, head/staff approve) -> accept (#bot-commands, nominee only) ----
  if (interaction.isButton?.() && interaction.customId.startsWith('tribenom_approve:')) {
    const targetId = interaction.customId.split(':')[1];
    const nom = tribes.getNomination(targetId);
    if (!nom || nom.status !== 'pending_approval') return interaction.reply({ content: 'This nomination is no longer pending.', flags: MessageFlags.Ephemeral });
    const tribe = tribes.get(nom.tribeKey);
    if (!tribe) { tribes.clearNomination(targetId); return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral }); }
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can approve this.`, flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    // Delete the throne prompt on resolution instead of editing it in place (owner, 2026-08-04: nominations +
    // leave requests shouldn't linger in the throne — they clutter it). The clicker gets an ephemeral confirm.
    if (!target || target.roles.cache.has(tribe.roleId) || tribes.memberTribe(target)) {
      tribes.clearNomination(targetId);
      await interaction.deferUpdate(); await interaction.message.delete().catch(() => {});
      return interaction.followUp({ content: 'That nomination is no longer valid — the member left or already joined a tribe.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    tribes.updateNomination(targetId, { status: 'pending_accept', approvedBy: interaction.user.id });
    await interaction.deferUpdate(); await interaction.message.delete().catch(() => {});
    await postAcceptPrompt(interaction.guild, tribe, targetId);
    return interaction.followUp({ content: `✅ Approved — sent <@${targetId}> an invite to accept.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribenom_deny:')) {
    const targetId = interaction.customId.split(':')[1];
    const nom = tribes.getNomination(targetId);
    if (!nom || nom.status !== 'pending_approval') return interaction.reply({ content: 'This nomination is no longer pending.', flags: MessageFlags.Ephemeral });
    const tribe = tribes.get(nom.tribeKey);
    if (tribe && !tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can deny this.`, flags: MessageFlags.Ephemeral });
    tribes.clearNomination(targetId);
    await interaction.deferUpdate(); await interaction.message.delete().catch(() => {});
    return interaction.followUp({ content: `❌ Denied the nomination for <@${targetId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribenom_accept:')) {
    const targetId = interaction.customId.split(':')[1];
    if (interaction.user.id !== targetId) return interaction.reply({ content: 'This invitation isn’t yours.', flags: MessageFlags.Ephemeral });
    const nom = tribes.getNomination(targetId);
    if (!nom || nom.status !== 'pending_accept') return interaction.update({ content: 'This invitation is no longer active.', components: [] }).catch(() => {});
    const tribe = tribes.get(nom.tribeKey);
    if (!tribe) { tribes.clearNomination(targetId); return interaction.update({ content: 'That tribe no longer exists.', components: [] }); }
    // These buttons can now arrive via DM (postAcceptPrompt DMs first, see 2026-08-03) — a DM interaction has
    // no interaction.guild/interaction.member, so resolve both explicitly instead of assuming guild context.
    const guild = interaction.guild || await client.guilds.fetch(config.guildId).catch(() => null);
    const member = interaction.member || (guild && await guild.members.fetch(targetId).catch(() => null));
    if (!guild || !member) return interaction.update({ content: 'Couldn’t look you up on the server. Try again from a server channel.', components: [] }).catch(() => {});
    if (tribes.memberTribe(member)) { tribes.clearNomination(targetId); return interaction.update({ content: 'You’re already in a tribe.', components: [] }); }
    // Owner, 2026-08-03: nomination/invite acceptance also goes through the tribe's entrance gate (unlike
    // /tribe invite's own consent step, which stays gate-free — the leader already vouches for that person).
    const gate = tribes.getEntranceGate(tribe.key);
    if (gate) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tribenomgate:${targetId}:a`).setLabel(gate.optionA).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`tribenomgate:${targetId}:b`).setLabel(gate.optionB).setStyle(ButtonStyle.Primary));
      return interaction.update({ content: `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: prove yourself\n> ${gate.prompt}`, components: [row] });
    }
    await interaction.deferUpdate();
    const r = await joinTribeSelfServe(guild, tribe, member, `Tribe invitation accepted, approved by ${nom.approvedBy}`);
    if (r.ok && features.enabled('recruitment')) await applyRecruitment(guild, tribe, member, nom.nominatorId).catch(() => {});
    tribes.clearNomination(targetId);
    return interaction.editReply({ content: r.ok ? `✅ Welcome to **${tribe.shortName || tribe.name}**, <@${targetId}>!` : 'Couldn’t add the tribe role. Tell an admin.', components: [], allowedMentions: { users: [targetId] } });
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribenomgate:')) {
    const [, targetId, choice] = interaction.customId.split(':');
    if (interaction.user.id !== targetId) return interaction.reply({ content: 'This invitation isn’t yours.', flags: MessageFlags.Ephemeral });
    const nom = tribes.getNomination(targetId);
    if (!nom || nom.status !== 'pending_accept') return interaction.update({ content: 'This invitation is no longer active.', components: [] }).catch(() => {});
    const tribe = tribes.get(nom.tribeKey);
    if (!tribe) { tribes.clearNomination(targetId); return interaction.update({ content: 'That tribe no longer exists.', components: [] }); }
    const gate = tribes.getEntranceGate(tribe.key);
    if (gate && choice !== gate.correct) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tribenomgate:${targetId}:a`).setLabel(gate.optionA).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`tribenomgate:${targetId}:b`).setLabel(gate.optionB).setStyle(ButtonStyle.Primary));
      return interaction.update({ content: `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: prove yourself\n❌ Not quite. Try again:\n> ${gate.prompt}`, components: [row] });
    }
    // Same DM-arrival caveat as tribenom_accept above.
    const guild = interaction.guild || await client.guilds.fetch(config.guildId).catch(() => null);
    const member = interaction.member || (guild && await guild.members.fetch(targetId).catch(() => null));
    if (!guild || !member) return interaction.update({ content: 'Couldn’t look you up on the server. Try again from a server channel.', components: [] }).catch(() => {});
    await interaction.deferUpdate();
    const r = await joinTribeSelfServe(guild, tribe, member, `Tribe invitation accepted, approved by ${nom.approvedBy}`);
    if (r.ok && features.enabled('recruitment')) await applyRecruitment(guild, tribe, member, nom.nominatorId).catch(() => {});
    tribes.clearNomination(targetId);
    return interaction.editReply({ content: r.ok ? `✅ Welcome to **${tribe.shortName || tribe.name}**, <@${targetId}>!` : 'Couldn’t add the tribe role. Tell an admin.', components: [], allowedMentions: { users: [targetId] } });
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribenom_decline:')) {
    const targetId = interaction.customId.split(':')[1];
    if (interaction.user.id !== targetId) return interaction.reply({ content: 'This invitation isn’t yours.', flags: MessageFlags.Ephemeral });
    tribes.clearNomination(targetId);
    return interaction.update({ content: 'Declined.', components: [] });
  }
  // ---- /tribe leave-request: leader (or staff) Approve/Deny, posted to the throne ----
  if (interaction.isButton?.() && interaction.customId.startsWith('tribeleave_approve:')) {
    const memberId = interaction.customId.split(':')[1];
    const req = tribes.getLeaveRequest(memberId);
    if (!req || req.status !== 'pending') return interaction.update({ content: 'This request is no longer active.', components: [] }).catch(() => {});
    const tribe = tribes.get(req.tribeKey);
    if (!tribe) { tribes.clearLeaveRequest(memberId); return interaction.update({ content: 'That tribe no longer exists.', components: [] }); }
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can decide this.`, flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(memberId).catch(() => null);
    tribes.clearLeaveRequest(memberId);
    // Delete the throne prompt on resolution (owner: don't let leave requests clutter the throne).
    await interaction.deferUpdate(); await interaction.message.delete().catch(() => {});
    if (!target || !target.roles.cache.has(tribe.roleId)) return interaction.followUp({ content: 'They’re already out of the tribe.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const r = await releaseTribeMember(interaction.guild, tribe, target, `Leave request approved by ${interaction.user.tag}`);
    return interaction.followUp({ content: r.ok ? `✅ Released <@${memberId}> from **${tribe.shortName || tribe.name}**. They can join a new tribe now.` : 'Couldn’t remove the role. Check my role position.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribeleave_deny:')) {
    const memberId = interaction.customId.split(':')[1];
    const req = tribes.getLeaveRequest(memberId);
    if (!req || req.status !== 'pending') return interaction.update({ content: 'This request is no longer active.', components: [] }).catch(() => {});
    const tribe = tribes.get(req.tribeKey);
    if (tribe && !tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribe ? tribes.leaderTitle(tribe) : 'the leader'} or staff can decide this.`, flags: MessageFlags.Ephemeral });
    tribes.clearLeaveRequest(memberId);
    await interaction.deferUpdate(); await interaction.message.delete().catch(() => {});
    return interaction.followUp({ content: `❌ Denied <@${memberId}>'s request to leave **${tribe ? (tribe.shortName || tribe.name) : 'the tribe'}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  }
  // ---- Tribes Hub buttons — same underlying logic as the typed commands, just one click instead ----
  if (interaction.isButton?.() && interaction.customId === 'tribehub_standings') {
    const board = tribes.standings(interaction.guild);
    if (!board.length) return interaction.reply({ content: 'No tribes are set up yet.', flags: MessageFlags.Ephemeral });
    const season = tribes.ensureSeason(Date.now());
    const sBoard = tribes.seasonStandings(interaction.guild);
    const champLeader = sBoard[0] && sBoard[0].seasonCrowns > 0 ? sBoard[0] : null;
    const body = board.map((t, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} ${t.emoji || '🏴'} **${t.shortName || t.name}**${t.strongholdTier ? ` 🏰${t.strongholdTier}` : ''} · ${t.memberCount} member${t.memberCount === 1 ? '' : 's'} · \`${t.glory || 0} glory\` this week · \`${t.treasury || 0}\` treasury · 👑×${t.seasonCrowns || 0} season`).join('\n');
    const embed = new EmbedBuilder().setColor(0x2A426A).setDescription(body).setFooter({ text: 'Glory decides Sunday’s Crown (resets weekly). Age crowns (👑×) decide the Age Champion.' });
    const seasonLine = `## 🏆 ${season.name || `Age ${season.number}`}\n-# Age ${season.number} · ends <t:${Math.floor(season.endsAt / 1000)}:R> · ${champLeader ? `leading: ${champLeader.emoji || '🏴'} ${champLeader.shortName || champLeader.name} (👑×${champLeader.seasonCrowns})` : 'no crowns claimed yet'}`;
    return interaction.reply({ content: `${seasonLine}\n## ⚔️ Tribe Standings\n-# ${board.length} tribe${board.length === 1 ? '' : 's'} vying for the crown`, embeds: [embed], flags: MessageFlags.Ephemeral });
  }
  // Cross-tribe views — one embed per tribe, so there's no "which tribe" argument to fill in. Your OWN
  // tribe's throne panel has the single-tribe Roster/Leaderboard buttons for the full top-15 depth.
  if (interaction.isButton?.() && interaction.customId === 'tribehub_allrosters') {
    const list = tribes.all();
    if (!list.length) return interaction.reply({ content: 'No tribes are set up yet.', flags: MessageFlags.Ephemeral });
    const embeds = list.slice(0, 10).map(t => {
      const members = tribes.roster(interaction.guild, t);
      const body = (members.length ? members.map(m => `> ${m.displayName}`).join('\n') : '> _No members yet._').slice(0, 4000);
      return new EmbedBuilder().setColor(t.color || 0x2A426A).setTitle(`${t.emoji || '🏴'} ${t.shortName || t.name}`).setDescription(body).setFooter({ text: `${members.length} member${members.length === 1 ? '' : 's'}` });
    });
    return interaction.reply({ content: '## 📋 Every tribe’s roster', embeds, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isButton?.() && interaction.customId === 'tribehub_allleaderboards') {
    const list = tribes.all();
    if (!list.length) return interaction.reply({ content: 'No tribes are set up yet.', flags: MessageFlags.Ephemeral });
    const embeds = list.slice(0, 10).map(t => {
      const pts = t.pointsName || 'points';
      const top = tribes.topTides(t.key, 5);
      const body = top.length ? top.map((e, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} <@${e.userId}> · \`${e.points} ${pts}\``).join('\n') : `_No ${pts} earned yet._`;
      return new EmbedBuilder().setColor(t.color || 0x2A426A).setTitle(`${t.emoji || '🏴'} ${t.shortName || t.name}`).setDescription(body).setFooter({ text: `top 5 by ${pts}` });
    });
    return interaction.reply({ content: '## 🏆 Every tribe’s leaderboard', embeds, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // Hub: Start a Challenge — any tribe leader or admin picks a type; the Arena runs right in the hub channel.
  // (The old hub "Start a Challenge" button + its picker were removed — arenas auto-start now, with
  //  /tribe-admin arena for manual staff starts. Handlers deleted as dead code.)
  if (interaction.isButton?.() && interaction.customId === 'tribehub_shop') {
    const tribe = tribes.myTribe(interaction.member);
    if (!tribe) return interaction.reply({ content: 'You’re not in a tribe yet. Head to #roles to pledge one.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can open the shop.`, flags: MessageFlags.Ephemeral });
    if (tribes.isFrozen(tribe)) return interaction.reply({ content: `🧊 **${tribe.shortName || tribe.name}**’s shop is frozen — it’s short on leaders. An admin can restore it with \`/tribe-admin set-leader\`.`, flags: MessageFlags.Ephemeral });
    return interaction.reply({ ...tribeShopView(tribe, interaction.guild), flags: MessageFlags.Ephemeral });
  }
  if (interaction.isButton?.() && interaction.customId === 'tribehub_leave') {
    const tribe = tribes.myTribe(interaction.member);
    if (!tribe) return interaction.reply({ content: 'You’re not in a tribe.', flags: MessageFlags.Ephemeral });
    if (tribes.isLeader(interaction.member, tribe)) return interaction.reply({ content: 'You’re this tribe’s leader — there’s no one to release you but staff (`/tribe-admin`, or ask an admin).', flags: MessageFlags.Ephemeral });
    // Staff (General) get an instant release, same exemption as /tribe leave; everyone else goes through
    // the normal leave-request approval — one button does the right thing for whoever clicks it. Capture
    // lock overrides even the staff exemption — otherwise a captured staff member could just bounce out
    // instantly and the war's whole point (a real, sticky consequence) would mean nothing.
    if (tribes.isCaptureLocked(interaction.member.id)) return interaction.reply({ content: `You were captured in a recent war — can’t leave until <t:${Math.floor(tribes.captureLockUntil(interaction.member.id) / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
    if (['admin', 'mod'].includes(opspanel.memberTier(interaction.member))) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await releaseTribeMember(interaction.guild, tribe, interaction.member, `Staff instant-leave by ${interaction.user.tag}`);
      return interaction.editReply(r.ok ? `🚪 Left **${tribe.shortName || tribe.name}**. You can be accepted into a new tribe whenever you like.` : 'Couldn’t remove the role. Check my role position.');
    }
    const r = await submitLeaveRequest(interaction.guild, interaction.member);
    return interaction.reply({ content: r.content, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isButton?.() && interaction.customId === 'tribehub_join') {
    const list = tribes.all();
    if (!list.length) return interaction.reply({ content: 'No tribes are set up yet.', flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder().setCustomId('tribehub_join_pick').setPlaceholder('Which tribe do you want to join?')
      .addOptions(list.slice(0, 25).map(t => ({ label: `${t.emoji || '🏴'} ${t.shortName || t.name}`.slice(0, 100), value: t.key, description: (t.motto || 'A tribe of the server').slice(0, 100) })));
    return interaction.reply({ content: '🪶 Pick the tribe to send a join request to.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'tribehub_join_pick') {
    const tribe = tribes.get(interaction.values[0]);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    const r = await submitJoinRequest(interaction.guild, interaction.member, tribe);
    return interaction.update({ content: r.content, components: [], allowedMentions: { parse: [] } });
  }
  // ---- Throne Hub — the per-tribe button panel (owner, 2026-08-03: "add another hub in each throne").
  // Every action reuses the SAME shared helper as its typed-command twin (submitInvite/submitBanish/
  // submitMuster/applyRetheme/releaseTribeMember/submitLeaveRequest), so the two surfaces can't drift apart.
  if (interaction.isButton?.() && interaction.customId.startsWith('tribethrone_')) {
    const [action, tribeKey] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    const act = action.slice('tribethrone_'.length);
    const isLeaderTool = ['invite', 'banish', 'note', 'rank', 'retheme', 'announce', 'motto', 'muster', 'war', 'alliance', 'allybreak', 'allygift'].includes(act);
    if (isLeaderTool && !tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
    // Frozen perks (mod-tribe short on leaders): war/alliances/shop are locked until it's back to 3 leaders.
    if (['war', 'alliance', 'allybreak', 'allygift', 'shop'].includes(act) && tribes.isFrozen(tribe))
      return interaction.reply({ content: `🧊 **${tribe.shortName || tribe.name}**’s perks are frozen — it’s short on leaders. An admin can restore them with \`/tribe-admin set-leader\`.`, flags: MessageFlags.Ephemeral });
    if (act === 'roster') {
      const members = tribes.roster(interaction.guild, tribe);
      const showTitle = features.enabled('achievements');
      const body = (members.length ? members.map(m => { const t = showTitle ? achievements.titleOf(m.id) : ''; return `> ${m.displayName}${t ? ` *${t}*` : ''}`; }).join('\n') : '> _No members yet._').slice(0, 4000);
      return interaction.reply({ content: `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: Roster\n-# ${members.length} member${members.length === 1 ? '' : 's'}`, embeds: [new EmbedBuilder().setColor(tribe.color || 0x2A426A).setDescription(body)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'leaderboard') {
      const pts = tribe.pointsName || 'points';
      const top = tribes.topTides(tribe.key, 15);
      if (!top.length) return interaction.reply({ content: `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: ${pts}\n> No ${pts} earned yet. Chat in the hall to start climbing.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      const body = top.map((t, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} <@${t.userId}> · \`${t.points} ${pts}\``).join('\n');
      return interaction.reply({ content: `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: ${pts} Leaderboard`, embeds: [new EmbedBuilder().setColor(tribe.color || 0x2A426A).setDescription(body)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (act === 'trophies') {
      if (!features.enabled('achievements')) return interaction.reply({ content: 'Achievements aren’t enabled.', flags: MessageFlags.Ephemeral });
      const uid = interaction.user.id;
      const list = achievements.earnedList(uid);
      const earned = list.filter(a => a.earned), locked = list.filter(a => !a.earned);
      const title = achievements.titleOf(uid);
      const parts = [earned.length ? '**Earned**\n' + earned.map(a => `${a.emoji} **${a.name}**: ${a.desc}${a.title ? ` (title: *${a.title}*)` : ''}`).join('\n') : '_Nothing yet. Play the arena, win wars, take crowns._'];
      if (locked.length) parts.push('\n**Locked**\n' + locked.map(a => `🔒 ${a.emoji} ${a.name}: ${a.desc}`).join('\n'));
      const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('🏅 Your Trophies').setDescription(parts.join('\n').slice(0, 4000)).setFooter({ text: title ? `Equipped title: ${title}` : 'No title equipped' });
      const equipable = achievements.titles(uid);
      const components = equipable.length ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('tribethrone_equiptitle').setPlaceholder('Equip a title…').addOptions([{ label: 'No title', value: 'none' }, ...equipable.slice(0, 24).map(a => ({ label: a.title, value: a.id }))]))] : [];
      return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
    }
    if (act === 'halloffame') {
      const hist = tribes.seasonHistory().filter(h => h.championKey);
      const season = tribes.ensureSeason(Date.now());
      const body = hist.length
        ? hist.map(h => `**${h.name || `Age ${h.number}`}** — 🏆 ${h.championName} (${h.crowns} crown${h.crowns === 1 ? '' : 's'})`).join('\n')
        : `_No age has crowned a Champion yet. **${season.name}** is being written now._`;
      const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('🏛️ Hall of Fame').setDescription(body).setFooter({ text: season ? `Current age: ${season.name} (Age ${season.number})` : '' });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    if (act === 'tithe') {
      // Tithe = convert your OWN activity points into this tribe's treasury (same as /tribe offer). Members only.
      if (!interaction.member.roles.cache.has(tribe.roleId)) return interaction.reply({ content: `You’re not in **${tribe.shortName || tribe.name}**.`, flags: MessageFlags.Ephemeral });
      const pts = tribe.pointsName || 'points';
      const mine = tribes.getTides(tribe.key, interaction.user.id);
      if (mine < 1) return interaction.reply({ content: `You have no ${pts} to tithe yet — earn some by chatting in the hall.`, flags: MessageFlags.Ephemeral });
      const input = new TextInputBuilder().setCustomId('amount').setLabel(`How many ${pts} to tithe? (you have ${mine})`.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(9);
      const modal = new ModalBuilder().setCustomId(`tribethrone_tithe_modal:${tribeKey}`).setTitle('Tithe to the treasury').addComponents(new ActionRowBuilder().addComponents(input));
      return safeShowModal(interaction, modal);
    }
    if (act === 'shop') return interaction.reply({ ...tribeShopView(tribe, interaction.guild), flags: MessageFlags.Ephemeral });
    if (act === 'leave') {
      if (tribes.isLeader(interaction.member, tribe)) return interaction.reply({ content: 'You’re this tribe’s leader — there’s no one to release you but staff (`/tribe-admin`, or ask an admin).', flags: MessageFlags.Ephemeral });
      if (tribes.isCaptureLocked(interaction.member.id)) return interaction.reply({ content: `You were captured in a recent war — can’t leave until <t:${Math.floor(tribes.captureLockUntil(interaction.member.id) / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
      if (['admin', 'mod'].includes(opspanel.memberTier(interaction.member))) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await releaseTribeMember(interaction.guild, tribe, interaction.member, `Staff instant-leave by ${interaction.user.tag}`);
        return interaction.editReply(r.ok ? `🚪 Left **${tribe.shortName || tribe.name}**. You can be accepted into a new tribe whenever you like.` : 'Couldn’t remove the role. Check my role position.');
      }
      const r = await submitLeaveRequest(interaction.guild, interaction.member);
      return interaction.reply({ content: r.content, flags: MessageFlags.Ephemeral });
    }
    if (act === 'invite') {
      const menu = new UserSelectMenuBuilder().setCustomId(`tribethrone_invite_pick:${tribeKey}`).setPlaceholder('Who to invite?');
      return interaction.reply({ content: '👥 Pick who to invite.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'banish') {
      const menu = new UserSelectMenuBuilder().setCustomId(`tribethrone_banish_pick:${tribeKey}`).setPlaceholder('Who to remove?');
      return interaction.reply({ content: '⛔ Pick who to remove.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'note') {
      const menu = new UserSelectMenuBuilder().setCustomId(`tribethrone_note_pick:${tribeKey}`).setPlaceholder('Whose notes?');
      return interaction.reply({ content: '📝 Pick a member.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'rank') {
      const menu = new UserSelectMenuBuilder().setCustomId(`tribethrone_rank_pick:${tribeKey}`).setPlaceholder('Who to rank?');
      return interaction.reply({ content: '🎖️ Pick a member.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'muster') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await submitMuster(interaction.guild, tribe, interaction.user.id);
      return interaction.editReply(r.content);
    }
    if (act === 'retheme') {
      if (!tribes.hasUnlock(tribe, 'retheme') && !tribes.hasFreeRetheme(tribe)) return interaction.reply({ content: `**${tribe.shortName || tribe.name}** hasn’t unlocked Re-theme yet. Check the Shop button.`, flags: MessageFlags.Ephemeral });
      const colorInput = new TextInputBuilder().setCustomId('color').setLabel('Primary colour hex, e.g. #2A426A').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7);
      if (tribe.color != null) colorInput.setValue('#' + tribe.color.toString(16).padStart(6, '0'));
      const color2Input = new TextInputBuilder().setCustomId('color2').setLabel('Second hex for a gradient (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7);
      if (tribe.color2 != null) color2Input.setValue('#' + tribe.color2.toString(16).padStart(6, '0'));
      const nameInput = new TextInputBuilder().setCustomId('name').setLabel('New full name (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80);
      const shortInput = new TextInputBuilder().setCustomId('short_name').setLabel('New short name (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40);
      const modal = new ModalBuilder().setCustomId(`tribethrone_retheme_modal:${tribeKey}`).setTitle('Retheme').addComponents(
        new ActionRowBuilder().addComponents(colorInput), new ActionRowBuilder().addComponents(color2Input),
        new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(shortInput));
      return safeShowModal(interaction, modal);
    }
    if (act === 'announce') {
      const msgInput = new TextInputBuilder().setCustomId('message').setLabel('The announcement').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500);
      const modal = new ModalBuilder().setCustomId(`tribethrone_announce_modal:${tribeKey}`).setTitle('Announce').addComponents(new ActionRowBuilder().addComponents(msgInput));
      return safeShowModal(interaction, modal);
    }
    if (act === 'motto') {
      const mottoInput = new TextInputBuilder().setCustomId('text').setLabel('The motto').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300);
      if (tribe.motto) mottoInput.setValue(tribe.motto);
      const modal = new ModalBuilder().setCustomId(`tribethrone_motto_modal:${tribeKey}`).setTitle('Set motto').addComponents(new ActionRowBuilder().addComponents(mottoInput));
      return safeShowModal(interaction, modal);
    }
    if (act === 'war') {
      if (tribes.onWarCooldown(tribe)) return interaction.reply({ content: `On war cooldown until <t:${Math.floor(tribes.warCooldownEndsAt(tribe) / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
      if (tribes.anyActiveWarInvolving(tribe.key)) return interaction.reply({ content: 'This tribe is already in an active war vote.', flags: MessageFlags.Ephemeral });
      const targets = tribes.all().filter(t => t.key !== tribe.key);
      if (!targets.length) return interaction.reply({ content: 'No other tribes to war.', flags: MessageFlags.Ephemeral });
      const menu = new StringSelectMenuBuilder().setCustomId(`tribethrone_war_pick:${tribeKey}`).setPlaceholder('Declare war on which tribe?')
        .addOptions(targets.slice(0, 25).map(t => ({ label: `${t.emoji || '🏴'} ${t.shortName || t.name}`.slice(0, 100), value: t.key })));
      return interaction.reply({ content: '⚔️ This opens a 24h vote for YOUR members — the target has no say in whether it starts. Pick who to war.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'alliance') {
      if (tribe.allyKey) return interaction.reply({ content: 'Already allied — break it first if you want a different ally.', flags: MessageFlags.Ephemeral });
      if (tribes.activeAllianceVoteFor(tribe.key)) return interaction.reply({ content: 'Already have an alliance vote in progress.', flags: MessageFlags.Ephemeral });
      const targets = tribes.all().filter(t => t.key !== tribe.key && !t.allyKey);
      if (!targets.length) return interaction.reply({ content: 'No eligible tribes right now (everyone else is already allied).', flags: MessageFlags.Ephemeral });
      const menu = new StringSelectMenuBuilder().setCustomId(`tribethrone_alliance_pick:${tribeKey}`).setPlaceholder('Propose an alliance with which tribe?')
        .addOptions(targets.slice(0, 25).map(t => ({ label: `${t.emoji || '🏴'} ${t.shortName || t.name}`.slice(0, 100), value: t.key })));
      return interaction.reply({ content: '🤝 This opens a 24h vote for YOUR members first, then the other tribe decides. Pick who to propose to.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'allybreak') {
      const ally = tribes.getAlly(tribe.key);
      if (!ally) return interaction.reply({ content: 'Not currently allied with anyone.', flags: MessageFlags.Ephemeral });
      tribes.breakAlliance(tribe.key, ally.key);
      await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
      await refreshThronePanel(interaction.guild, tribes.get(ally.key)).catch(() => {});
      if (ally.throneId) { const t = await interaction.guild.channels.fetch(ally.throneId).catch(() => null); if (t) await t.send({ content: `## 💔 Alliance broken\n**${tribe.shortName || tribe.name}** has broken the alliance with **${ally.shortName || ally.name}**.` }).catch(() => {}); }
      return interaction.reply({ content: `💔 Alliance with **${ally.shortName || ally.name}** broken.`, flags: MessageFlags.Ephemeral });
    }
    if (act === 'allygift') {
      const ally = tribes.getAlly(tribe.key);
      if (!ally) return interaction.reply({ content: 'No current ally to gift treasury to.', flags: MessageFlags.Ephemeral });
      const amountInput = new TextInputBuilder().setCustomId('amount').setLabel(`How much treasury to send ${ally.shortName || ally.name}?`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
      const modal = new ModalBuilder().setCustomId(`tribethrone_allygift_modal:${tribeKey}`).setTitle('Gift treasury to ally').addComponents(new ActionRowBuilder().addComponents(amountInput));
      return safeShowModal(interaction, modal);
    }
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tribethrone_invite_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
    const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
    if (!target) return interaction.update({ content: 'Couldn’t find that member.', components: [] });
    const r = await submitInvite(interaction.guild, tribe, interaction.user.id, target);
    return interaction.update({ content: r.content, components: [], allowedMentions: { parse: [] } });
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tribethrone_banish_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
    const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
    if (!target) return interaction.update({ content: 'Couldn’t find that member.', components: [] });
    await interaction.deferUpdate();
    const r = await submitBanish(interaction.guild, tribe, target, interaction.user.tag);
    return interaction.editReply({ content: r.content, components: [] });
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tribethrone_note_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
    const targetId = interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`tribethrone_note_modal:${tribeKey}:${targetId}`).setTitle('Note').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Note (blank to just view existing)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
    return safeShowModal(interaction, modal);
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tribethrone_rank_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
    const targetId = interaction.values[0];
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target || !tribes.isMember(target, tribe)) return interaction.update({ content: `That member isn’t in **${tribe.shortName || tribe.name}**. Invite them first.`, components: [] });
    const ranks = tribe.ranks || [];
    if (!ranks.length) return interaction.update({ content: 'This tribe has no rank ladder set up.', components: [] });
    const menu = new StringSelectMenuBuilder().setCustomId(`tribethrone_rank_pick2:${tribeKey}:${targetId}`).setPlaceholder('Which rank?')
      .addOptions(ranks.map((r, i) => ({ label: `${i + 1}. ${r.name}`, value: String(i) })));
    return interaction.update({ content: `🎖️ Set <@${targetId}>'s rank:`, components: [new ActionRowBuilder().addComponents(menu)], allowedMentions: { parse: [] } });
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('tribethrone_rank_pick2:')) {
    const [, tribeKey, targetId] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) return interaction.update({ content: 'Couldn’t find that member.', components: [] });
    const idx = parseInt(interaction.values[0], 10);
    if (!(idx >= 0 && tribe.ranks && tribe.ranks[idx])) return interaction.update({ content: 'Invalid rank.', components: [] });
    await interaction.deferUpdate();
    await applyTribeRank(interaction.guild, tribe, target, idx, `manual — set by <@${interaction.user.id}>`, false);
    return interaction.editReply({ content: `${tribe.emoji || '🌊'} Set <@${targetId}> to **${tribe.ranks[idx].name}** in ${tribe.shortName || tribe.name}.`, components: [], allowedMentions: { parse: [] } });
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'tribethrone_equiptitle') {
    const v = interaction.values[0];
    achievements.equip(interaction.user.id, v === 'none' ? null : v);
    const t = achievements.titleOf(interaction.user.id);
    return interaction.update({ content: t ? `✅ Equipped title: **${t}**.` : '✅ Title cleared.', embeds: [], components: [] });
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('tribethrone_war_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const attacker = tribes.get(tribeKey);
    if (!attacker) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, attacker) && !opspanel.tierOf(interaction)) return interaction.update({ content: `Only ${tribes.leaderTitle(attacker)} or staff can do that.`, components: [] });
    if (tribes.onWarCooldown(attacker) || tribes.anyActiveWarInvolving(attacker.key)) return interaction.update({ content: 'No longer eligible to declare war right now.', components: [] }).catch(() => {});
    const defender = tribes.get(interaction.values[0]);
    if (!defender) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (tribes.onWarCooldown(defender) || tribes.anyActiveWarInvolving(defender.key)) return interaction.update({ content: `**${defender.shortName || defender.name}** is on cooldown or already in a war vote.`, components: [] }).catch(() => {});
    await interaction.deferUpdate();
    const war = tribes.startWarVote(attacker.key, defender.key, interaction.user.id);
    await postWarVote(interaction.guild, war, attacker, defender);
    return interaction.editReply({ content: `⚔️ War vote started against **${defender.shortName || defender.name}** in <#${attacker.hallId}>.`, components: [] });
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('tribethrone_alliance_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const proposer = tribes.get(tribeKey);
    if (!proposer) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, proposer) && !opspanel.tierOf(interaction)) return interaction.update({ content: `Only ${tribes.leaderTitle(proposer)} or staff can do that.`, components: [] });
    if (proposer.allyKey || tribes.activeAllianceVoteFor(proposer.key)) return interaction.update({ content: 'No longer eligible to propose an alliance right now.', components: [] }).catch(() => {});
    const target = tribes.get(interaction.values[0]);
    if (!target || target.allyKey) return interaction.update({ content: 'That tribe is no longer available (already allied or gone).', components: [] }).catch(() => {});
    await interaction.deferUpdate();
    const vote = tribes.startAllianceVote(proposer.key, target.key, interaction.user.id);
    await postAllianceVote(interaction.guild, vote, proposer, target);
    return interaction.editReply({ content: `🤝 Alliance vote started with **${target.shortName || target.name}** in <#${proposer.hallId}>.`, components: [] });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tribethrone_retheme_modal:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
    const color = parseTribeHex(interaction.fields.getTextInputValue('color'));
    if (color === null) return interaction.reply(badHexReply('primary'));
    const c2raw = interaction.fields.getTextInputValue('color2');
    const color2 = c2raw ? parseTribeHex(c2raw) : null;
    if (c2raw && color2 === null) return interaction.reply(badHexReply('second'));
    const name = interaction.fields.getTextInputValue('name').trim() || null;
    const shortName = interaction.fields.getTextInputValue('short_name').trim() || null;
    const r = await applyRetheme(interaction.guild, tribe, { color, color2, name, shortName });
    // If they don't own the paid unlock, this used a free (leader-loss) retheme token — burn one.
    let freeNote = '';
    if (r.ok !== false && !tribes.hasUnlock(tribe, 'retheme') && tribes.consumeFreeRetheme(tribe.key)) {
      const left = (tribes.get(tribe.key).freeRethemes || 0);
      freeNote = `\n-# Used a **free retheme** (leader-loss grant).${left ? ` ${left} left.` : ''}`;
    }
    return interaction.reply({ content: r.content + freeNote, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tribethrone_tithe_modal:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!interaction.member.roles.cache.has(tribe.roleId)) return interaction.reply({ content: `You’re not in **${tribe.shortName || tribe.name}**.`, flags: MessageFlags.Ephemeral });
    const pts = tribe.pointsName || 'points';
    const amount = parseInt((interaction.fields.getTextInputValue('amount') || '').replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(amount) || amount < 1) return interaction.reply({ content: 'Give a whole number of 1 or more.', flags: MessageFlags.Ephemeral });
    const mine = tribes.getTides(tribe.key, interaction.user.id);
    if (mine < amount) return interaction.reply({ content: `You only have **${mine} ${pts}**.`, flags: MessageFlags.Ephemeral });
    // Convert 1:1, own points -> tribe treasury. Ranks never demote, so this only slows your NEXT promotion.
    tribes.addTides(tribe.key, interaction.user.id, -amount);
    tribes.addTreasury(tribe.key, amount);
    await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
    return interaction.reply({ content: `🪙 You tithed **${amount} ${pts}** to **${tribe.shortName || tribe.name}**. Treasury is now **${tribes.getTreasury(tribe.key)}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tribethrone_announce_modal:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
    if (!tribe.throneId) return interaction.reply({ content: 'This tribe has no throne channel.', flags: MessageFlags.Ephemeral });
    const throne = await interaction.guild.channels.fetch(tribe.throneId).catch(() => null);
    if (!throne) return interaction.reply({ content: 'Couldn’t find the throne channel.', flags: MessageFlags.Ephemeral });
    const msg = interaction.fields.getTextInputValue('message').slice(0, 1500).replace(/\n/g, '\n> ');
    await throneSend(throne, { content: `## ${tribe.emoji || '🏰'} ${tribe.shortName || tribe.name}: Proclamation\n-# by <@${interaction.user.id}> · <@&${tribe.roleId}>\n> ${msg}`, allowedMentions: { roles: [tribe.roleId], users: [interaction.user.id] } }).catch(() => {});
    return interaction.reply({ content: `📣 Posted to <#${tribe.throneId}> and rallied the tribe.`, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tribethrone_motto_modal:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
    const text = interaction.fields.getTextInputValue('text');
    tribes.setMotto(tribe.key, text);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (config.rolesChannelId) await roleselect.refreshTribeBlock(interaction.guild, config.rolesChannelId).catch(() => {});
    await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
    return interaction.editReply({ content: `${tribe.emoji || '🌊'} Motto set for **${tribe.shortName || tribe.name}**:\n> *${text.slice(0, 300)}*`, allowedMentions: { parse: [] } });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tribethrone_note_modal:')) {
    const [, tribeKey, targetId] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
    const text = interaction.fields.getTextInputValue('text').trim();
    if (text) { tribes.addNote(tribe.key, targetId, text, interaction.user.id); return interaction.reply({ content: `📝 Noted on <@${targetId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); }
    const notes = tribes.getNotes(tribe.key, targetId);
    if (!notes.length) return interaction.reply({ content: `No notes on <@${targetId}> yet.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    const body = notes.map(n => `> ${n.text}\n-# by <@${n.by}> · <t:${Math.floor(n.at / 1000)}:R>`).join('\n');
    return interaction.reply({ content: `## 📝 Notes on <@${targetId}>\n${body}`.slice(0, 1900), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tribethrone_allygift_modal:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
    const ally = tribes.getAlly(tribe.key);
    if (!ally) return interaction.reply({ content: 'No current ally to gift treasury to.', flags: MessageFlags.Ephemeral });
    const amount = parseInt(interaction.fields.getTextInputValue('amount'), 10);
    if (!Number.isFinite(amount) || amount <= 0) return interaction.reply({ content: 'Enter a positive whole number.', flags: MessageFlags.Ephemeral });
    if (!tribes.spendTreasury(tribe.key, amount)) return interaction.reply({ content: `**${tribe.shortName || tribe.name}** only has **${tribes.getTreasury(tribe.key)}** treasury.`, flags: MessageFlags.Ephemeral });
    tribes.addTreasury(ally.key, amount);
    if (ally.throneId) { const t = await interaction.guild.channels.fetch(ally.throneId).catch(() => null); if (t) await t.send({ content: `## 🎁 Ally gift\n**${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}** sent **${amount}** treasury. Now **${tribes.getTreasury(ally.key)}**.`, allowedMentions: { parse: [] } }).catch(() => {}); }
    return interaction.reply({ content: `🎁 Sent **${amount}** treasury to **${ally.shortName || ally.name}**. **${tribe.shortName || tribe.name}** now has **${tribes.getTreasury(tribe.key)}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // ---- The land shop: /tribe expand's Buy/Teardown buttons ----
  if (interaction.isButton?.() && interaction.customId.startsWith('tribeshop_buy:')) {
    const [, tribeKey, unlockKey] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can buy for the tribe.`, flags: MessageFlags.Ephemeral });
    if (tribes.isFrozen(tribe)) return interaction.reply({ content: `🧊 **${tribe.shortName || tribe.name}**’s shop is frozen — it’s short on leaders.`, flags: MessageFlags.Ephemeral });
    const u = TRIBE_UNLOCKS.find(x => x.key === unlockKey);
    if (!u) return interaction.reply({ content: 'Unknown unlock.', flags: MessageFlags.Ephemeral });
    if (tribes.hasUnlock(tribe, u.key)) return interaction.update(tribeShopView(tribes.get(tribeKey), interaction.guild));
    if (!unlockGateMet(tribe, interaction.guild, u)) return interaction.reply({ content: 'That milestone isn’t met yet.', flags: MessageFlags.Ephemeral });
    if (['text2', 'voice2'].includes(u.key) && tribeChannelCount(tribe) >= TRIBE_CHANNEL_CAP) return interaction.reply({ content: `This tribe is already at the ${TRIBE_CHANNEL_CAP}-channel cap.`, flags: MessageFlags.Ephemeral });
    if (!tribes.spendTreasury(tribe.key, u.cost)) return interaction.reply({ content: `Not enough treasury (need **${u.cost}**, have **${tribes.getTreasury(tribe.key)}**).`, flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    try {
      await applyTribeUnlock(interaction.guild, tribe, u);
      tribes.addUnlock(tribe.key, u.key);
    } catch (e) {
      tribes.addTreasury(tribe.key, u.cost);   // refund — a tribe should never be charged for something it didn't get
      console.error('[tribe shop]', e.message);
      return interaction.editReply({ content: `❌ Couldn’t apply that unlock, refunded. (${e.message})`, components: [] });
    }
    return interaction.editReply(tribeShopView(tribes.get(tribe.key), interaction.guild));
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribeshop_stronghold:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can buy for the tribe.`, flags: MessageFlags.Ephemeral });
    if (tribes.isFrozen(tribe)) return interaction.reply({ content: `🧊 **${tribe.shortName || tribe.name}**’s shop is frozen — it’s short on leaders.`, flags: MessageFlags.Ephemeral });
    const cost = strongholdCost(tribe);
    if (!tribes.spendTreasury(tribe.key, cost)) return interaction.reply({ content: `Not enough treasury (need **${cost}**, have **${tribes.getTreasury(tribe.key)}**).`, flags: MessageFlags.Ephemeral });
    tribes.addStrongholdTier(tribe.key);
    return interaction.update(tribeShopView(tribes.get(tribe.key), interaction.guild));
  }
  // Disband-pending prompt (mod-tribe leader requirement, final stage). Admin-only. Confirm = dissolve the
  // tribe (delete its roles + channels — irreversible); Extend = grant another grace window.
  if (interaction.isButton?.() && (interaction.customId.startsWith('tribedisband_confirm:') || interaction.customId.startsWith('tribedisband_extend:'))) {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins can decide a tribe disband.', flags: MessageFlags.Ephemeral });
    const [act, tribeKey] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: '_(That tribe no longer exists.)_', components: [] }).catch(() => {});
    if (act === 'tribedisband_extend') {
      const graceUntil = Date.now() + tribes.LEADER_GRACE_MS;
      tribes.setLeaderEnforce(tribe.key, { stage: 'grace', since: Date.now(), freezeAt: Date.now() + Math.floor(tribes.LEADER_GRACE_MS / 2), graceUntil });
      await ownerlog.log(interaction.guild, { emoji: '⏳', title: 'Tribe disband extended', color: 0xF1C40F, detail: `**${tribe.shortName || tribe.name}** got another grace window from <@${interaction.user.id}>.` }).catch(() => {});
      return interaction.update({ content: `⏳ **${tribe.shortName || tribe.name}** granted another grace window (until <t:${Math.floor(graceUntil / 1000)}:R>) by <@${interaction.user.id}>. Add a leader with \`/tribe-admin set-leader\`.`, components: [] }).catch(() => {});
    }
    // Confirm disband — delete channels + roles, then drop the record. Best-effort per resource.
    await interaction.deferUpdate();
    const deleted = [];
    for (const chId of [tribe.throneId, tribe.hallId, tribe.vcId, tribe.text2Id, tribe.vc2Id, tribe.categoryId].filter(Boolean)) {
      const ch = await interaction.guild.channels.fetch(chId).catch(() => null);
      if (ch) { await ch.delete(`Tribe disbanded by ${interaction.user.tag}`).catch(() => {}); deleted.push(chId); }
    }
    for (const rId of [tribe.roleId, tribe.leaderRoleId, tribe.staffRankRoleId, ...((tribe.ranks || []).map(r => r.roleId))].filter(Boolean)) {
      const role = await interaction.guild.roles.fetch(rId).catch(() => null);
      if (role) await role.delete(`Tribe disbanded by ${interaction.user.tag}`).catch(() => {});
    }
    tribes.removeTribe(tribe.key);
    if (config.rolesChannelId) await roleselect.refreshTribeBlock(interaction.guild, config.rolesChannelId).catch(() => {});
    await ownerlog.log(interaction.guild, { emoji: '💥', title: 'Tribe DISBANDED', color: 0xED4245, detail: `**${tribe.shortName || tribe.name}** was dissolved by <@${interaction.user.id}> (mod-tribe leader requirement unmet). ${deleted.length} channel(s) + its roles deleted.` }).catch(() => {});
    return interaction.editReply({ content: `💥 **${tribe.shortName || tribe.name}** has been disbanded by <@${interaction.user.id}>. Its roles and channels are gone.`, components: [] }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribeshop_teardown:')) {
    const [, tribeKey, unlockKey] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can tear down tribe channels.`, flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    await teardownTribeUnlock(interaction.guild, tribe, unlockKey);
    return interaction.editReply(tribeShopView(tribes.get(tribe.key), interaction.guild));
  }
  // ---- Mod tribe-founding: needs 2 other mods to co-sign (see /tribe-admin create's mod path) ----
  if (interaction.isButton?.() && interaction.customId.startsWith('tribefound_cosign:')) {
    const founderId = interaction.customId.split(':')[1];
    if (interaction.user.id === founderId) return interaction.reply({ content: 'You can’t co-sign your own founding request.', flags: MessageFlags.Ephemeral });
    if (opspanel.tierOf(interaction) !== 'mod') return interaction.reply({ content: 'Only mods can co-sign this (this is a mod peer-approval, not an admin one).', flags: MessageFlags.Ephemeral });
    const req = tribes.getFoundingRequest(founderId);
    if (!req) return interaction.update({ content: 'This founding request is no longer active.', components: [] }).catch(() => {});
    const updated = tribes.cosignFounding(founderId, interaction.user.id);
    if (!updated) return interaction.reply({ content: 'You already co-signed this.', flags: MessageFlags.Ephemeral });
    const need = Math.max(0, 2 - updated.cosigns.length);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribefound_cosign:${founderId}`).setLabel('✅ Co-sign').setStyle(ButtonStyle.Success));
    await interaction.update({ content: `## 🏴 Tribe founding request\n> <@${founderId}> wants to found a tribe. Co-signed by ${updated.cosigns.map(id => `<@${id}>`).join(', ')}.\n${need > 0 ? `-# Needs **${need} more** mod${need === 1 ? '' : 's'} to co-sign.` : `-# ✅ **3 mods reached** (founder + 2 co-signs). <@${founderId}> can now run \`/tribe-admin create\` again to continue.`}`, components: need > 0 ? [row] : [], allowedMentions: { users: [founderId, ...updated.cosigns] } });
  }
  // ---- Rituals: muster roll-call join button ----
  if (interaction.isButton?.() && interaction.customId.startsWith('tribemuster_join:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!interaction.member.roles.cache.has(tribe.roleId)) return interaction.reply({ content: `You’re not in **${tribe.shortName || tribe.name}**, this muster isn’t yours to answer.`, flags: MessageFlags.Ephemeral });
    const muster = tribes.getMuster(tribeKey);
    if (!muster) return interaction.reply({ content: 'This muster already ended.', flags: MessageFlags.Ephemeral });
    const joined = tribes.joinMuster(tribeKey, interaction.user.id);
    const count = tribes.getMuster(tribeKey)?.participants.length ?? muster.participants.length;
    return interaction.reply({ content: joined ? `🪖 You're counted! **${count}** have answered so far.` : `You're already counted (**${count}** so far).`, flags: MessageFlags.Ephemeral });
  }
  // ---- War & Alliance votes — any CURRENT member of the proposing tribe can vote, live tally on every click ----
  if (interaction.isButton?.() && interaction.customId.startsWith('tribewar_vote:')) {
    const [, warId, choice] = interaction.customId.split(':');
    const war = tribes.getWar(warId);
    if (!war || war.status !== 'voting') return interaction.reply({ content: 'This vote is no longer active.', flags: MessageFlags.Ephemeral });
    const attacker = tribes.get(war.attackerKey);
    if (!attacker || !interaction.member.roles.cache.has(attacker.roleId)) return interaction.reply({ content: 'Only current members of the proposing tribe can vote on this.', flags: MessageFlags.Ephemeral });
    const updated = tribes.voteOnWar(warId, interaction.user.id, choice);
    const memberCount = interaction.guild.roles.cache.get(attacker.roleId)?.members.size ?? 0;
    const defender = tribes.get(war.defenderKey);
    const votes = liveVotes(interaction.guild, attacker.roleId, updated.votes);
    await interaction.update({ content: `## ⚔️ War vote\n<@&${attacker.roleId}>\nProposed by <@${war.proposerId}>: declare war on **${defender?.emoji || '🏴'} ${defender?.shortName || defender?.name || 'that tribe'}**?\nVoting ends <t:${Math.floor(war.voteEndsAt / 1000)}:R>.\n${voteTallyLine(votes, memberCount, 'declare war')}`, allowedMentions: { roles: [attacker.roleId] } }).catch(() => {});
    // End early the moment the result is locked (owner: "end once the required votes are received") — don't
    // wait out the 24h window once the remaining voters can't change the outcome.
    if (voteLocked(votes, memberCount)) await resolveWarVoteRecord(interaction.guild, tribes.getWar(warId)).catch(() => {});
    return;
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribewar_cancel:')) {
    const warId = interaction.customId.split(':')[1];
    const war = tribes.getWar(warId);
    if (!war || war.status !== 'voting') return interaction.reply({ content: 'This vote is no longer active.', flags: MessageFlags.Ephemeral });
    const attacker = tribes.get(war.attackerKey);
    if (attacker && !tribes.isLeader(interaction.member, attacker) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${attacker ? tribes.leaderTitle(attacker) : 'a leader'} or staff can cancel this vote.`, flags: MessageFlags.Ephemeral });
    tribes.resolveWarRecord(warId, { status: 'failed', resolvedAt: Date.now() });
    return interaction.update({ content: `## ⚔️ War vote cancelled\nCalled off by <@${interaction.user.id}>. No war, no cooldown.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  // Defender consent (owner, 2026-08-04): the target leader accepts the war, or declines into a coin flip so
  // they can't just veto forever. Only the DEFENDER's leader (or staff) may click.
  if (interaction.isButton?.() && (interaction.customId.startsWith('tribewar_accept:') || interaction.customId.startsWith('tribewar_declchance:'))) {
    const [act, warId] = interaction.customId.split(':');
    const war = tribes.getWar(warId);
    if (!war || war.status !== 'awaiting_target') return interaction.reply({ content: 'This war is no longer awaiting a response.', flags: MessageFlags.Ephemeral });
    const defender = tribes.get(war.defenderKey), attacker = tribes.get(war.attackerKey);
    if (!defender || !attacker) return interaction.update({ content: 'One of the tribes no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, defender) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(defender)} or staff can answer this.`, flags: MessageFlags.Ephemeral });
    await interaction.update({ components: [] }).catch(() => {});
    if (act === 'tribewar_accept') {
      await interaction.followUp({ content: `⚔️ <@${interaction.user.id}> **accepted** the war on behalf of **${defender.shortName || defender.name}**. To battle!`, allowedMentions: { parse: [] } }).catch(() => {});
      return executeWar(interaction.guild, war, `-# ${defender.shortName || defender.name} accepted the challenge.\n`);
    }
    // Decline → coin flip decides whether the war happens anyway (shared with the 24h stuck-war sweep).
    await interaction.followUp({ content: `🎲 <@${interaction.user.id}> **declined** — leaving it to fate. Flipping the coin…`, allowedMentions: { parse: [] } }).catch(() => {});
    await resolveWarByChance(interaction.guild, war, `${defender.shortName || defender.name} declined;`).catch(() => {});
    return;
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribealliance_vote:')) {
    const [, voteId, choice] = interaction.customId.split(':');
    const vote = tribes.getAllianceVote(voteId);
    if (!vote || vote.status !== 'voting') return interaction.reply({ content: 'This vote is no longer active.', flags: MessageFlags.Ephemeral });
    const proposer = tribes.get(vote.proposerKey);
    if (!proposer || !interaction.member.roles.cache.has(proposer.roleId)) return interaction.reply({ content: 'Only current members of the proposing tribe can vote on this.', flags: MessageFlags.Ephemeral });
    const updated = tribes.voteOnAlliance(voteId, interaction.user.id, choice);
    const memberCount = interaction.guild.roles.cache.get(proposer.roleId)?.members.size ?? 0;
    const target = tribes.get(vote.targetKey);
    const votes = liveVotes(interaction.guild, proposer.roleId, updated.votes);
    await interaction.update({ content: `## 🤝 Alliance vote\n<@&${proposer.roleId}>\nProposed by <@${vote.proposerId}>: propose an alliance with **${target?.emoji || '🏴'} ${target?.shortName || target?.name || 'that tribe'}**?\nVoting ends <t:${Math.floor(vote.voteEndsAt / 1000)}:R>.\n${voteTallyLine(votes, memberCount, 'propose')}`, allowedMentions: { roles: [proposer.roleId] } }).catch(() => {});
    // End early the moment the result is locked (owner: "end once the required votes are received").
    if (voteLocked(votes, memberCount)) await resolveAllianceVoteRecord(interaction.guild, tribes.getAllianceVote(voteId)).catch(() => {});
    return;
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribealliance_cancel:')) {
    const voteId = interaction.customId.split(':')[1];
    const vote = tribes.getAllianceVote(voteId);
    if (!vote || vote.status !== 'voting') return interaction.reply({ content: 'This vote is no longer active.', flags: MessageFlags.Ephemeral });
    const proposer = tribes.get(vote.proposerKey);
    if (proposer && !tribes.isLeader(interaction.member, proposer) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${proposer ? tribes.leaderTitle(proposer) : 'a leader'} or staff can cancel this vote.`, flags: MessageFlags.Ephemeral });
    tribes.resolveAllianceVoteRecord(voteId, { status: 'failed', resolvedAt: Date.now() });
    return interaction.update({ content: `## 🤝 Alliance vote cancelled\nCalled off by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  // Arena: race claim button.
  if (interaction.isButton?.() && interaction.customId === 'arena_claim') {
    const a = arena.get();
    if (!a || a.type !== 'race') return interaction.reply({ content: 'No race is running.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine) return interaction.reply({ content: 'You’re not in a tribe — join one in #roles to play.', flags: MessageFlags.Ephemeral });
    if (!arena.markOnce('participants', interaction.user.id)) return interaction.reply({ content: 'You already claimed. One per member!', flags: MessageFlags.Ephemeral });
    const total = scoreArena(mine.key, interaction.user.id);
    const fresh = arena.get();
    await interaction.update({ content: `# 🏁 Reaction Race!\nFirst tribe to **${arena.RACE_TARGET}** claims wins **+${arena.WIN_GLORY} Glory / +${arena.WIN_TREASURY} Treasury**. One claim per member. Ends <t:${Math.floor(a.endsAt / 1000)}:R> if nobody hits the target.\n\n${arenaScoreboard(fresh)}`, components: interaction.message.components }).catch(() => {});
    if (total >= arena.RACE_TARGET) await endArena(interaction.guild).catch(() => {});
    return;
  }
  // Arena: trivia answer button. The current-question message id guards against stale clicks on an
  // already-advanced question — and since interaction handlers run to completion single-threaded, the first
  // correct click scores + advances (changing messageId) before any concurrent click's handler runs.
  if (interaction.isButton?.() && interaction.customId.startsWith('arena_ans:')) {
    const a = arena.get();
    if (!a || !arena.BUTTON_TYPES.includes(a.type)) return interaction.reply({ content: 'No trivia is running.', flags: MessageFlags.Ephemeral });
    if (interaction.message.id !== a.messageId) return interaction.reply({ content: 'That question is already over.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine) return interaction.reply({ content: 'You’re not in a tribe — join one in #roles to play.', flags: MessageFlags.Ephemeral });
    if ((a.answeredThisQ || []).includes(interaction.user.id)) return interaction.reply({ content: 'You already answered this one.', flags: MessageFlags.Ephemeral });
    arena.update({ answeredThisQ: [...(a.answeredThisQ || []), interaction.user.id] });
    if (Number(interaction.customId.split(':')[1]) !== a.answer) return interaction.reply({ content: '❌ Not quite.', flags: MessageFlags.Ephemeral });
    scoreArena(mine.key, interaction.user.id);
    await interaction.update({ components: [] }).catch(() => {});   // ack + lock this question
    await interaction.followUp({ content: `✅ Correct! Point for ${tribeName(mine.key)}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    return askNextTrivia(interaction.guild).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribealliance_approve:')) {
    const voteId = interaction.customId.split(':')[1];
    const vote = tribes.getAllianceVote(voteId);
    if (!vote || vote.status !== 'awaiting_target') return interaction.reply({ content: 'This proposal is no longer active.', flags: MessageFlags.Ephemeral });
    const target = tribes.get(vote.targetKey), proposer = tribes.get(vote.proposerKey);
    if (!target || !proposer) return interaction.update({ content: 'One of the tribes no longer exists.', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, target) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(target)} or staff can decide this.`, flags: MessageFlags.Ephemeral });
    if (proposer.allyKey || target.allyKey) {
      tribes.resolveAllianceVoteRecord(voteId, { status: 'failed', resolvedAt: Date.now() });
      return interaction.update({ content: `❌ Can't ally — one of the two tribes already has an ally (capped at 1).`, components: [] }).catch(() => {});
    }
    tribes.setAlly(proposer.key, target.key);
    tribes.resolveAllianceVoteRecord(voteId, { status: 'resolved', resolvedAt: Date.now() });
    await refreshThronePanel(interaction.guild, tribes.get(proposer.key)).catch(() => {});
    await refreshThronePanel(interaction.guild, tribes.get(target.key)).catch(() => {});
    return interaction.update({ content: `## 🤝 Alliance formed!\n**${proposer.emoji || '🏴'} ${proposer.shortName || proposer.name}** and **${target.emoji || '🏴'} ${target.shortName || target.name}** are now allied: mutual defense in wars, and treasury can be gifted to each other.\n-# Accepted by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribealliance_deny:')) {
    const voteId = interaction.customId.split(':')[1];
    const vote = tribes.getAllianceVote(voteId);
    if (!vote || vote.status !== 'awaiting_target') return interaction.reply({ content: 'This proposal is no longer active.', flags: MessageFlags.Ephemeral });
    const target = tribes.get(vote.targetKey);
    if (target && !tribes.isLeader(interaction.member, target) && !opspanel.tierOf(interaction)) return interaction.reply({ content: `Only ${tribes.leaderTitle(target)} or staff can decide this.`, flags: MessageFlags.Ephemeral });
    tribes.resolveAllianceVoteRecord(voteId, { status: 'failed', resolvedAt: Date.now() });
    return interaction.update({ content: `❌ Alliance declined by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  // Public member hub (from /dashboard and the pinned panel). Action buttons DO the thing: open a modal
  // to collect text, then hand it to the module. Info buttons show an ephemeral view. All ephemeral.
  if (interaction.isButton?.() && interaction.customId.startsWith('pub')) {
    const cid = interaction.customId;
    const verifiedGate = () => config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId);
    if (cid === 'pubdash_status') return interaction.reply({ ...pubdash.statusView(interaction.member, state), flags: MessageFlags.Ephemeral });
    if (cid === 'pubdash_info') return interaction.reply({ ...pubdash.infoView(), flags: MessageFlags.Ephemeral });
    if (cid === 'pubact_tribe') return interaction.reply({ ...pubdash.tribeView(interaction.member), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (cid === 'pubact_appeal') {   // reuse the strike-appeal flow: show the picker of appealable strikes
      if (!features.enabled('strikeAppeals')) return interaction.reply({ content: 'Strike appeals are not available right now.', flags: MessageFlags.Ephemeral });
      const choices = strikes.autocompleteChoices(state, interaction.user.id, { excludeCrossedBan: true });
      if (!choices.length) return interaction.reply({ content: 'You have no active strikes that can be appealed.', flags: MessageFlags.Ephemeral });
      const menu = new StringSelectMenuBuilder().setCustomId('strikeappeal_pick').setPlaceholder('Which strike do you want to appeal?')
        .addOptions(choices.slice(0, 25).map(c => ({ label: c.name.slice(0, 100), value: c.value })));
      return interaction.reply({ content: '⚖️ Pick the strike you want to appeal. I will open a private thread with staff.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    // the text-modal actions
    const modals = { pubact_confess: pubdash.confessModal, pubact_suggest: pubdash.suggestModal, pubact_modmail: pubdash.modmailModal, pubact_report: pubdash.reportModal };
    if (modals[cid]) {
      if (verifiedGate()) return interaction.reply({ content: 'You need to be verified first.', flags: MessageFlags.Ephemeral });
      return interaction.showModal(modals[cid]());
    }
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('pubmodal_')) {
    const text = interaction.fields.getTextInputValue('text');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (interaction.customId === 'pubmodal_confess') { const r = await confessions.submit(interaction.guild, interaction.member, text); return interaction.editReply(r.ok ? `✅ Posted **Confession #${r.num}** anonymously.` : `❌ ${r.msg}`); }
      if (interaction.customId === 'pubmodal_suggest') { const r = await suggestions.submit(interaction.guild, interaction.member, text); return interaction.editReply(r.ok ? `✅ Posted **Suggestion #${r.num}** in <#${r.threadId}>.` : `❌ ${r.msg}`); }
      if (interaction.customId === 'pubmodal_modmail') { const r = await modmail.submit(interaction.guild, interaction.member, text); return interaction.editReply(r.ok ? `✅ Sent **Modmail #${r.num}** to the mod team.` : `❌ ${r.msg}`); }
      if (interaction.customId === 'pubmodal_report') { const r = await reports.submit(interaction.guild, interaction.member, null, text); return interaction.editReply(r.ok ? `✅ Sent **Report #${r.num}** to staff anonymously.` : `❌ ${r.msg}`); }
    } catch (e) { console.error('[pubdash modal]', e.message); return interaction.editReply('Could not do that. Try the slash command instead.').catch(() => {}); }
  }
  if (interaction.isButton?.()) {
    const id = interaction.customId || '';
    try {
      if (id.startsWith('vpanel_')) return await handleVerifyButton(interaction);
      // #roles pickers (roleselect.js) — generic multi-toggle (regions/notifications/pronouns/misc):
      // add if missing, remove if present. Same mechanic the old Carl-bot reactions had, just bot-owned.
      if (id.startsWith('roleselect_toggle:')) {
        const roleId = id.split(':')[1];
        const has = interaction.member.roles.cache.has(roleId);
        try { if (has) await interaction.member.roles.remove(roleId, 'Role picker toggle'); else await interaction.member.roles.add(roleId, 'Role picker toggle'); }
        catch (e) { return interaction.reply({ content: `Couldn’t update that: ${e.message}`, flags: MessageFlags.Ephemeral }); }
        return interaction.reply({ content: `${has ? '➖ Removed' : '➕ Added'} <@&${roleId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      // MDNI toggle — gated to holding an adult age bracket, and locked once Verified (backed by
      // enforceRegistrationLock either way; this just avoids the confusing apply-then-revert experience).
      if (id.startsWith('roleselect_mdni:')) {
        const roleId = id.split(':')[1];
        const has = interaction.member.roles.cache.has(roleId);
        if (config.verifiedRoleId && interaction.member.roles.cache.has(config.verifiedRoleId)) {
          return interaction.reply({ content: 'MDNI is locked once you’re verified. It’s a one-time registration choice. If it’s wrong, ask a mod/admin and they can change it for you.', flags: MessageFlags.Ephemeral });
        }
        if (!has && !config.adultAgeRoleIds.some(aid => interaction.member.roles.cache.has(aid))) {
          return interaction.reply({ content: 'Pick an adult age bracket (18+) first. MDNI requires it.', flags: MessageFlags.Ephemeral });
        }
        try { if (has) await interaction.member.roles.remove(roleId, 'Role picker toggle'); else await interaction.member.roles.add(roleId, 'Role picker toggle'); }
        catch (e) { return interaction.reply({ content: `Couldn’t update that: ${e.message}`, flags: MessageFlags.Ephemeral }); }
        return interaction.reply({ content: `${has ? '➖ Removed' : '➕ Added'} MDNI.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      if (id.startsWith('corner_convert:')) {
        if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnlyStrike, flags: MessageFlags.Ephemeral });
        const [, memberId, ruleN] = id.split(':');
        return interaction.showModal(strikeReasonModal(memberId, 0, 0, ruleN, '(repeat Corner escalation)'));
      }
      if (id.startsWith('corner_')) return await handleCornerButton(interaction);
      if (id.startsWith('conflict_')) return await handleConflictButton(interaction);
      if (id.startsWith('digest_')) return await handleDigestButton(interaction);
      if (id.startsWith('wl_')) return await handleWatchlistButton(interaction);
      if (id.startsWith('sug_')) {
        if ((id === 'sug_ok' || id === 'sug_no') && !canBan(interaction))
          return interaction.reply({ content: 'Only staff (mods+) can approve or deny suggestions.', flags: MessageFlags.Ephemeral });
        return await suggestions.handleButton(interaction, config);
      }
      if (id.startsWith('conf_')) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can do that.', flags: MessageFlags.Ephemeral });
        return await confessions.handleButton(interaction);
      }
      if (id.startsWith('rolereq_')) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can approve/deny role requests.', flags: MessageFlags.Ephemeral });
        // If APPROVING a tribe-role request, update authoritative membership FIRST so the guard honors it.
        if (id.startsWith('rolereq_ok:')) {
          const [, reqUid, reqRoleId, reqAct] = interaction.customId.split(':');
          const reqTribe = tribes.getByRole(reqRoleId);
          if (reqTribe) tribes.setMembership(reqTribe.key, reqUid, reqAct !== 'remove');
        }
        return await rolereq.handleButton(interaction);
      }
      if (id.startsWith('appeal_')) {
        // Tightened 2026-08-03 (owner, after the mass-unban incident): a ban appeal's APPROVE unbans someone,
        // same real-world action as /unban — that's owner-only now, not admin+. Voting (advisory, doesn't
        // decide anything) is open to ALL staff (mod+, owner: "mods can still vote... I just don't want them
        // deciding") — broadened from an earlier admin+-only pass that accidentally locked mods out of voting.
        if (id === 'appeal_vote_up' || id === 'appeal_vote_down') {
          if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can vote on a ban appeal.', flags: MessageFlags.Ephemeral });
        } else if (!isOwner(interaction)) {
          return interaction.reply({ content: 'Only the **owner** (or bot owner) can approve or deny a ban appeal.', flags: MessageFlags.Ephemeral });
        }
        return await appeals.handleButton(interaction);
      }
      if (id.startsWith('strikeappeal_')) {
        // Tightened 2026-08-03 (owner, after the mass-unban incident): deciding a strike appeal now needs
        // admin+ (was mod+). Voting (advisory) stays open to mod+, the tier that used to be able to decide.
        if (id === 'strikeappeal_vote_up' || id === 'strikeappeal_vote_down') {
          if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can vote on strike appeals.', flags: MessageFlags.Ephemeral });
        } else if (!canWLAdmin(interaction)) {
          return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can approve or deny strike appeals.', flags: MessageFlags.Ephemeral });
        }
        return await strikeAppeals.handleButton(interaction, state);
      }
      if (id.startsWith('promote_')) {
        if (id === 'promote_confirm' || id === 'promote_reject') {
          const approvers = modapps.loadConfig().approvers || [];
          if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id) && !opspanel.isBotOwner(interaction))
            return interaction.reply({ content: 'Only the **server owner** can confirm or reject a promotion.', flags: MessageFlags.Ephemeral });
        } else if (!canBan(interaction)) {
          return interaction.reply({ content: 'Only staff (mods+) can vote on promotions.', flags: MessageFlags.Ephemeral });
        }
        return await promote.handleButton(interaction, config);
      }
      if (id.startsWith('wb_')) return await whistleblow.handleButton(interaction);   // unseal self-gates to the entrusted holder
      if (id.startsWith('modapp_')) {
        if (id === 'modapp_accept' || id === 'modapp_deny' || id === 'modapp_undo') {
          // The ACTUAL server owner (guild.ownerId, dynamic) — plus any temporary approvers in config
          // (used while the real owner is inactive; clear the list once they're back). Undoing a decision
          // is as consequential as making one, so it takes the same tier.
          const approvers = modapps.loadConfig().approvers || [];
          if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id) && !opspanel.isBotOwner(interaction))
            return interaction.reply({ content: `Only the **server owner** can ${id === 'modapp_undo' ? 'undo' : 'accept or deny'} mod applications.`, flags: MessageFlags.Ephemeral });
        }
        if ((id === 'modapp_up' || id === 'modapp_down' || id === 'modapp_askanon') && !canBan(interaction))
          return interaction.reply({ content: 'Only staff (mods+) can do that.', flags: MessageFlags.Ephemeral });
        return await modapps.handleButton(interaction, config);
      }
      if (id === 'rep_reveal') {
        if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can reveal a reporter.', flags: MessageFlags.Ephemeral });
        return await reports.handleButton(interaction);
      }
      if (id === 'mm_reveal') {
        if (!isOwner(interaction)) return interaction.reply({ content: 'Only owners can reveal a modmail sender.', flags: MessageFlags.Ephemeral });
        return await modmail.handleButton(interaction);
      }
      if (id.startsWith('pending_page:')) return await interaction.update(await renderPending(Number(id.split(':')[1] || 0)));
    } catch (err) {
      console.error(`[button] ${id}: ${err.message}`);
      const m = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
      (interaction.deferred || interaction.replied) ? interaction.editReply(m).catch(() => {}) : interaction.reply(m).catch(() => {});
    }
    return;
  }
  // Feature gate — belt-and-suspenders on top of not registering disabled commands: if a command
  // whose feature is turned off is somehow invoked, decline it.
  if (interaction.isChatInputCommand?.() || interaction.isMessageContextMenuCommand?.()) {
    // /appeal has two subcommands owned by two independently-toggleable features — the generic
    // one-command-to-one-feature lookup can't tell them apart, so check the subcommand directly.
    const fk = interaction.commandName === 'appeal'
      ? (interaction.options.getSubcommand() === 'strike' ? 'strikeAppeals' : 'appeals')
      : features.featureForCommand(interaction.commandName);
    if (fk && !features.enabled(fk))
      return interaction.reply({ content: 'That feature is currently turned off.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Report to watchlist') {
    if (!canBan(interaction) && !miniModCanActOn(interaction, interaction.targetMessage?.channelId)) return interaction.reply({ content: 'Only staff (mods+) can report.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't report a bot's message.", flags: MessageFlags.Ephemeral });
    const ok = await manualWatchReport(target, interaction.user).catch(() => false);
    return interaction.reply({ content: ok ? `🚩 Reported <@${target.author.id}> to the mods. An admin can add them to the watchlist from there.` : 'Failed to post the report.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Report') {
    // Member-facing: right-click a message → Apps → Report → anonymous report to staff (works anywhere).
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified to report.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't report a bot's message.", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = `Reported message: "${(target.content || '[no text, see link]').slice(0, 400)}" · ${target.url}`;
    const r = await reports.submit(interaction.guild, interaction.member, target.author, text);
    return interaction.editReply(r.ok ? `✅ Reported that message to staff anonymously (Report #${r.num}). They won’t know it was you.` : `❌ ${r.msg}`);
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Send to corner') {
    // Same access + tier rules as /corner, but the trigger is a specific message — and that message
    // gets forwarded into the corner so the member (and mods) see exactly what put them there.
    const isMod = !!opspanel.tierOf(interaction);   // any staff tier (mod/admin/owner incl Admin-perm/bot owner)
    if (!isMod && !miniModCanActOn(interaction, interaction.targetMessage?.channelId)) return interaction.reply({ content: copy.guards.modRoleOnly, flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't corner a bot.", flags: MessageFlags.Ephemeral });
    if (target.author.id === client.user.id) return interaction.reply({ content: 'I can’t corner myself.', flags: MessageFlags.Ephemeral });
    if (target.author.id === interaction.guild.ownerId) return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
    // Show the rule picker IMMEDIATELY — no member fetch here (that await was blowing the 3s ack window under
    // load, so nothing appeared). The tier-hierarchy check runs at modal submit, where the member is fetched.
    try {
      await interaction.reply({ content: copy.common.whichRule, components: [ruleRow(`corner_rule_pick:${target.author.id}:${target.channelId}:${target.id}`)], flags: MessageFlags.Ephemeral });
      console.error('[idiag] corner ctx reply OK');
    } catch (e) { console.error(`[idiag] corner ctx reply FAIL: ${e.message}`); }
    return;
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Strike') {
    if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnlyStrike, flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't strike a bot.", flags: MessageFlags.Ephemeral });
    // Show the rule picker immediately — no member fetch (the member is fetched at the strike modal submit).
    return interaction.reply({ content: copy.common.whichRule, components: [ruleRow(`strike_rule_pick:${target.author.id}:${target.channelId}:${target.id}`)], flags: MessageFlags.Ephemeral });
  }
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  if (name === 'cornered') {
    try { return await handleCorneredList(interaction); }
    catch (e) { console.error(`[cornered] ${e.message}`); return; }
  }
  if (name === 'appeal-reset') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins can reset a ban appeal.', flags: MessageFlags.Ephemeral });
    const r = await appeals.reset(interaction.options.getString('user'));
    if (!r.ok) return interaction.reply({ content: `❌ ${r.msg}`, flags: MessageFlags.Ephemeral });
    await ownerlog.log(interaction.guild, { emoji: '♻️', title: 'Ban appeal reset', color: 0x5865F2,
      detail: `**${r.bannedTag}**’s previously **${r.status}** appeal was cleared by <@${interaction.user.id}> — they can be appealed again. (Archived, not deleted.)` }).catch(() => {});
    return interaction.reply({ content: `♻️ Cleared **${r.bannedTag}**’s previously **${r.status}** appeal. A friend can open a fresh \`/appeal ban\` for them now. (Archived, history kept.)`, flags: MessageFlags.Ephemeral });
  }
  if (name === 'weights') {
    try {
      const pin = interaction.options.getBoolean('pin') || false;
      if (pin && !canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins can post + pin the guide. Run `/weights` on its own to view it privately.', flags: MessageFlags.Ephemeral });
      const embed = buildWeightsEmbed();
      if (pin) {
        const sent = await interaction.channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
        if (!sent) return interaction.reply({ content: 'Couldn’t post here. Check my permissions in this channel.', flags: MessageFlags.Ephemeral });
        await sent.pin().catch(e => console.error('[weights] pin:', e.message));
        return interaction.reply({ content: `📌 Posted + pinned the infraction guide here. Trial mods with access to this channel can now see it (and anyone can pull it with \`/weights\`).`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (e) { console.error(`[weights] ${e.message}`); return interaction.reply({ content: 'Could not build the guide.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'levelcheck') {
    const wantFix = interaction.options.getBoolean('fix') || false;
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ModerateMembers)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });
    if (wantFix && !canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins can run the fix (grant roles). Run without `fix` to just see the report.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const scan = Math.min(Math.max(interaction.options.getInteger('scan') || 1500, 100), 3000);
    // [roleId, minLevel] — cumulative: at level N you should hold every role whose threshold ≤ N.
    const THRESH = [['1529120692845674687', 5], ['1529121181767176313', 10], ['1529121191384842330', 25], ['1529121471946035330', 50]];
    const RNAME = { '1529120692845674687': 'Novice', '1529121181767176313': 'Inter', '1529121191384842330': 'Elite', '1529121471946035330': 'NOLIFE' };
    const ARCANE = '437808476106784770', BOTCMD = '1528704767466016870';
    const ch = await interaction.guild.channels.fetch(BOTCMD).catch(() => null);
    if (!ch) return interaction.editReply('Couldn’t find the #bot-commands channel to read Arcane’s log.');
    const level = new Map(); let before, fetched = 0;
    while (fetched < scan) {
      const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || !batch.size) break;
      for (const m of batch.values()) {
        if (m.author.id !== ARCANE) continue;
        const lm = (m.content || '').match(/reached level \*\*(\d+)\*\*/); const um = (m.content || '').match(/<@!?(\d+)>/);
        if (lm && um) { const uid = um[1], lvl = +lm[1]; if (!level.has(uid) || level.get(uid) < lvl) level.set(uid, lvl); }
      }
      fetched += batch.size; before = batch.last().id; if (batch.size < 100) break;
    }
    await ensureMembers(interaction.guild);
    const missing = []; let fixed = 0, fixErr = 0;
    for (const [uid, lvl] of level) {
      const m = interaction.guild.members.cache.get(uid); if (!m || m.user.bot) continue;
      if (state.getCornered(uid)) continue;   // cornered = roles legitimately stripped + stored
      const miss = THRESH.filter(([rid, min]) => lvl >= min && !m.roles.cache.has(rid)).map(([rid]) => rid);
      if (!miss.length) continue;
      missing.push({ name: m.displayName, id: uid, lvl, miss });
      if (wantFix) { const ok = await m.roles.add(miss, `levelcheck resync — earned by level ${lvl}`).then(() => true).catch(() => false); ok ? fixed++ : fixErr++; }
    }
    missing.sort((a, b) => b.lvl - a.lvl);
    if (!missing.length) return interaction.editReply(`## ✅ Level roles all landed\n-# scanned ${fetched} log msgs · ${level.size} members seen\n> Every active member has every level role they've earned.`);
    const lines = missing.slice(0, 35).map(f => `> ${wantFix ? '✅' : '⚠️'} **${f.name}** (<@${f.id}>) · L${f.lvl} · ${wantFix ? 'granted' : 'missing'}: ${f.miss.map(r => RNAME[r]).join(', ')}`);
    const header = wantFix ? `## 🔧 Level-role resync: granted to ${fixed} member(s)${fixErr ? ` · ${fixErr} failed` : ''}` : `## ⚠️ ${missing.length} member(s) missing earned level roles`;
    return interaction.editReply({ content: `${header}\n-# scanned ${fetched} log msgs · ${level.size} members${wantFix ? '' : ' · run `/levelcheck fix:true` to grant them'}\n${lines.join('\n')}${missing.length > 35 ? `\n-# +${missing.length - 35} more` : ''}`.slice(0, 1950), allowedMentions: { parse: [] } });
  }
  if (name === 'stats') {
    try {
      const user = interaction.options.getUser('user');
      const periodOpt = interaction.options.getString('period') || '30';
      const ephemeral = (interaction.options.getString('visibility') || 'private') !== 'public';
      const now = Date.now();
      const cutoff = periodOpt === 'all' ? 0 : now - Number(periodOpt) * 86400000;
      const periodLabel = periodOpt === 'all' ? 'all time' : `the last ${periodOpt} days`;
      // Corner history (logCornerHistory: cornerLog[id] = [{ruleIndex, at}]) + strike ledger.
      const cornerAll = (state.getMeta('cornerLog') || {})[user.id] || [];
      const cornerInPeriod = cornerAll.filter(e => e.at >= cutoff);
      const strikeAll = (state.getMeta('strikes') || {})[user.id] || [];
      const strikeInPeriod = strikeAll.filter(e => e.at >= cutoff);
      const activeStrikes = strikeAll.filter(e => e.active);
      const activeUnits = strikes.totalUnits(state, user.id);
      const tier = strikes.tierName(activeUnits);
      const corneredRec = state.getCornered(user.id);
      // Time sentenced (sum of set corner durations; indefinite corners have no fixed sentence) and time
      // served (actual time in the corner, recorded on release; the ongoing corner is counted live).
      let sentencedMs = 0, servedMs = 0, indefinite = 0, matchedActive = false;
      for (const e of cornerInPeriod) {
        if (e.durationMs) sentencedMs += e.durationMs; else indefinite++;
        const isActive = corneredRec && corneredRec.at && Math.abs((e.at || 0) - corneredRec.at) < 5000;   // tolerate legacy ms drift between the record and history entry
        if (isActive) { servedMs += (now - corneredRec.at); matchedActive = true; }   // ongoing corner: live elapsed
        else if (e.servedMs != null) servedMs += e.servedMs;                            // released corners: exact time recorded on release
        else if (e.durationMs) servedMs += e.durationMs;                                // older corner that predates served-tracking: use its sentence as the best proxy
      }
      // Currently cornered but no history entry matched (legacy record): still count the ongoing time.
      if (corneredRec && corneredRec.at && !matchedActive && corneredRec.at >= cutoff) servedMs += (now - corneredRec.at);
      // Most-cited rule across both strikes and corners in the window.
      const ruleCounts = {};
      for (const e of [...strikeInPeriod, ...cornerInPeriod]) if (e.ruleIndex) ruleCounts[e.ruleIndex] = (ruleCounts[e.ruleIndex] || 0) + 1;
      const topRule = Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])[0];
      const topRuleStr = topRule ? `Rule ${topRule[0]}${rules.byIndex(Number(topRule[0]))?.title ? `: ${rules.byIndex(Number(topRule[0])).title}` : ''}, cited **${topRule[1]}×**` : 'none';
      const fmtCorner = e => `⛓️ <t:${Math.floor(e.at / 1000)}:R>${e.ruleIndex ? ` · Rule ${e.ruleIndex}` : ''}`;
      const fmtStrike = e => `${e.active ? '⚠️' : '✔️'} <t:${Math.floor(e.at / 1000)}:R> · ${strikes.formatUnits(e.weight)}u${e.ruleIndex ? ` · Rule ${e.ruleIndex}` : (e.reason ? ` · ${e.reason.slice(0, 40)}` : '')}`;
      const recentCorners = cornerInPeriod.slice(-5).reverse().map(fmtCorner).join('\n') || '_none_';
      const recentStrikes = strikeInPeriod.slice(-5).reverse().map(fmtStrike).join('\n') || '_none_';
      const embed = new EmbedBuilder()
        .setColor(activeUnits > 0 || corneredRec ? CORNER_RED : 0x57F287)
        .setAuthor({ name: `${user.tag}: moderation record`, iconURL: user.displayAvatarURL() })
        .setDescription(`Record for <@${user.id}> over **${periodLabel}**.${corneredRec ? `\n\n🚫 **Currently in the corner**${corneredRec.releaseAt ? `, releases ${relPhrase(corneredRec.releaseAt)}` : ' (indefinite)'}.` : ''}`)
        .addFields(
          { name: '⛓️ Corners', value: `**${cornerInPeriod.length}** in ${periodLabel}\n**${cornerAll.length}** all-time`, inline: true },
          { name: '⚠️ Strikes', value: `**${strikeInPeriod.length}** received in ${periodLabel}\n**${strikeAll.length}** all-time\n**${activeStrikes.length} active**, ${strikes.formatUnits(activeUnits)} units (${tier})`, inline: true },
          { name: '⏱️ Corner time', value: `Sentenced: **${sentencedMs ? humanDur(sentencedMs) : 'none'}**${indefinite ? ` _(+${indefinite} open-ended)_` : ''}\nServed (all corners): **${servedMs ? humanDur(servedMs) : 'none'}**${corneredRec ? ' _(incl. ongoing)_' : ''}`, inline: true },
          { name: '🎯 Most-cited rule', value: topRuleStr, inline: false },
          { name: 'Recent corners', value: recentCorners.slice(0, 1024), inline: true },
          { name: 'Recent strikes', value: recentStrikes.slice(0, 1024), inline: true },
        )
        .setFooter({ text: `Pulled by ${interaction.user.tag}` }).setTimestamp();
      return interaction.reply({ content: `Record for <@${user.id}>`, embeds: [embed], flags: ephemeral ? MessageFlags.Ephemeral : undefined, allowedMentions: { parse: [] } });
    } catch (e) { console.error(`[stats] ${e.message}`); return interaction.reply({ content: 'Could not pull that record.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'wordfilter') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage word filters.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') {
      const word = (interaction.options.getString('word') || '').trim();
      const durStr = (interaction.options.getString('duration') || '').trim();
      let durationMs = null;
      if (durStr) { durationMs = corner.parseDuration(durStr); if (!durationMs) return interaction.reply({ content: 'Bad duration. Use e.g. `30m`, `2h`, `3d` (or leave it blank for no expiry).', flags: MessageFlags.Ephemeral }); }
      const r = wordfilter.add(state, word, durationMs, interaction.user.id);
      if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, flags: MessageFlags.Ephemeral });
      const until = r.filter.expiresAt ? `until <t:${Math.floor(r.filter.expiresAt / 1000)}:f> (<t:${Math.floor(r.filter.expiresAt / 1000)}:R>)` : 'until removed (no expiry)';
      await logCorner(interaction.guild, { emoji: '🧹', title: r.updated ? 'WORD FILTER UPDATED' : 'WORD FILTER ADDED', color: CORNER_AMBER,
        desc: `Auto-deleting messages containing \`${word}\` ${until}.\n**By:** <@${interaction.user.id}>` }).catch(() => {});
      return interaction.reply({ content: `🧹 ${r.updated ? 'Updated' : 'Now auto-deleting'} messages containing \`${word}\` ${until}. (Staff are exempt.)`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'list') {
      const list = wordfilter.active(state);
      if (!list.length) return interaction.reply({ content: 'No active word filters.', flags: MessageFlags.Ephemeral });
      const lines = list.map(f => `• \`${f.word}\` · ${f.expiresAt ? `expires <t:${Math.floor(f.expiresAt / 1000)}:R>` : 'no expiry'} · deleted **${f.count || 0}** · by <@${f.byId}>`);
      return interaction.reply({ content: `🧹 **Active word filters:**\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'remove') {
      const word = (interaction.options.getString('word') || '').trim();
      const r = wordfilter.remove(state, word);
      if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, flags: MessageFlags.Ephemeral });
      await logCorner(interaction.guild, { emoji: '🧹', title: 'WORD FILTER REMOVED', color: CORNER_GREEN,
        desc: `Stopped auto-deleting \`${r.removed.word}\` (deleted **${r.removed.count || 0}** message(s) while active).\n**By:** <@${interaction.user.id}>` }).catch(() => {});
      return interaction.reply({ content: `✅ Stopped the filter for \`${r.removed.word}\`, it deleted **${r.removed.count || 0}** message(s).`, flags: MessageFlags.Ephemeral });
    }
  }
  if (name === 'pending') {
    if (!modClicked(interaction) && !isTrialMod(interaction)) return interaction.reply({ content: 'Only staff can use this.', flags: MessageFlags.Ephemeral });
    try { return await interaction.reply({ ...(await renderPending(0)), flags: MessageFlags.Ephemeral }); }
    catch (e) { console.error(`[pending] ${e.message}`); return; }
  }
  if (name === 'panel') {
    try {
      // Event organizers who aren't staff get the EVENT dashboard instead of the mod-only ops panel.
      if (features.enabled('contest') && !opspanel.memberTier(interaction.member) && !isTrialMod(interaction)
          && interaction.member?.roles?.cache?.has('1529976148706984110'))
        return await contest.openEventPanel(interaction);
      // Trial mods (not mod+) get the read-only view; mod+ get the full interactive panel.
      if (!opspanel.memberTier(interaction.member) && isTrialMod(interaction)) return await opspanel.openReadOnly(interaction);
      return await opspanel.openPersonalPanel(interaction);
    } catch (e) { console.error(`[fops] /panel ${e.message}`); return interaction.reply({ content: 'Could not open the panel.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'unban') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can unban.', flags: MessageFlags.Ephemeral });
    const id = (interaction.options.getString('user_id') || '').replace(/\D/g, '');
    if (!id) return interaction.reply({ content: 'Give a valid user ID.', flags: MessageFlags.Ephemeral });
    const keepWatch = interaction.options.getBoolean('watchlist') || false;
    const reason = interaction.options.getString('reason') || `Unban by ${interaction.user.tag}`;
    try { await interaction.guild.bans.remove(id, reason); }
    catch (e) { return interaction.reply({ content: `❌ Unban failed: ${e.message} (are they actually banned?)`, flags: MessageFlags.Ephemeral }); }
    if (keepWatch) watchlist.addWatch(id);
    await ownerlog.log(interaction.guild, { emoji: '🔓', title: 'Unbanned', color: 0x57F287, detail: `\`${id}\` — ${reason} — by <@${interaction.user.id}>.${keepWatch ? ' Kept on the Watchlist.' : ''}` });
    return interaction.reply({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      content: `✅ Unbanned <@${id}>.` + (keepWatch ? ' They’re still on the **Watchlist**.' : '') });
  }
  if (name === 'contest-submit') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be **verified** to enter the contest.', flags: MessageFlags.Ephemeral });
    try { return await contest.submit(interaction); }
    catch (e) { console.error('[contest] submit:', e.message); return interaction.reply({ content: 'Something went wrong entering the contest.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'contest') {
    // Organizers (Event Organizer role holds ManageEvents), staff (mod+), and admins may manage contests.
    const canManage = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageEvents)
      || opspanel.memberTier(interaction.member)
      || interaction.member?.roles?.cache?.has('1529976148706984110');
    if (!canManage) return interaction.reply({ content: 'Only organizers or staff can manage contests.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'setup') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await contest.setup(interaction.guild);
        const chLines = r.channels.map(m => `• <#${m.ch.id}>${m.created ? ' _(created)_' : ''}`).join('\n');
        return interaction.editReply(`✅ Contest system ready.\n${chLines}\nWinner role: <@&${r.role.id}>\n\nNext: open a round with \`/contest start theme:<theme>\`. Optionally run \`/permguard resnapshot\` to bring these channels under the permission drift-guard.`);
      }
      if (sub === 'start') {
        const theme = interaction.options.getString('theme');
        const which = interaction.options.getString('contests') || 'all';
        const keys = which === 'all' ? null : which.split(',');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await contest.start(interaction.guild, theme, keys);
        return interaction.editReply(`✅ Opened the **${r.theme}** round for: ${r.active.map(k => contest.CONTESTS.find(c => c.key === k)?.label).join(', ')}. Announcements are posted + pinned.`);
      }
      if (sub === 'panel') {
        return contest.openEventPanel(interaction);
      }
      if (sub === 'status') {
        const embed = await contest.status(interaction.guild);
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      if (sub === 'end') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await contest.endRound(interaction.guild);
        if (!r.ok) return interaction.editReply(`⚠️ ${r.msg}`);
        const lines = Object.entries(r.results).map(([k, v]) => {
          const c = contest.CONTESTS.find(x => x.key === k);
          if (!v) return `• ${c.label}: no winner (no votes)`;
          return `• ${c.label}: ${v.winners.map(w => w.anonymous ? 'anon' : `<@${w.memberId}>`).join(' & ')} · ${v.votes} 🩷`;
        }).join('\n');
        return interaction.editReply(`🏁 Round closed, winners crowned + role assigned. Results also posted to <#1529981479331827722>.\n${lines}`);
      }
      if (sub === 'reveal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const data = await contest.revealEntries(interaction.guild);
        if (!data.round) return interaction.editReply('No active contest round to reveal.');
        const blocks = [`## 🕵️ Contest entries: real submitters\n-# ${data.round.theme} · private · public anonymity untouched`];
        for (const c of data.contests) {
          if (!c.entries.length) { blocks.push(`### ${c.emoji} ${c.label}\n> _no entries_`); continue; }
          const lines = [];
          for (const e of c.entries) {
            const m = await interaction.guild.members.fetch(e.memberId).catch(() => null);
            const nm = m ? m.displayName : (await client.users.fetch(e.memberId).catch(() => null))?.username || e.memberId;
            lines.push(`> ${e.anonymous ? '🕶️' : '👤'} **${nm}** (<@${e.memberId}>) · ${e.votes} 🩷${e.anonymous ? ' · _anon_' : ''} · [entry](https://discord.com/channels/${interaction.guild.id}/${c.channelId}/${e.messageId})`);
          }
          blocks.push(`### ${c.emoji} ${c.label} (${c.entries.length})\n${lines.join('\n')}`);
        }
        return interaction.editReply({ content: blocks.join('\n').slice(0, 1950), allowedMentions: { parse: [] } });
      }
    } catch (e) {
      console.error('[contest]', e.message);
      const m = { content: `⚠️ ${e.message}`, flags: MessageFlags.Ephemeral };
      return (interaction.deferred || interaction.replied) ? interaction.editReply(m).catch(() => {}) : interaction.reply(m).catch(() => {});
    }
    return;
  }
  if (name === 'strike') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage strikes.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: copy.common.notInServer, flags: MessageFlags.Ephemeral });
    const cap = strikes.BAN_THRESHOLD;
    const R = txt => interaction.reply({ content: txt, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (sub === 'view') {
      const total = strikes.totalUnits(state, user.id);
      const active = strikes.activeEntries(state, user.id);
      const lines = active.map(e => `\`${e.id}\` · **${strikes.formatUnits(e.weight)}** unit${e.weight === 1 ? '' : 's'} · ${e.ruleIndex ? `Rule ${e.ruleIndex}: ${SERVER_RULES[Number(e.ruleIndex) - 1]} · ` : ''}${e.reason || '_(no reason)_'}${e.timeoutMs ? ' ⏱️' : ''} · <t:${Math.floor(e.at / 1000)}:d>`);
      return R(`⚠️ <@${user.id}> is at **${strikes.formatUnits(total)}/${cap} units** (${strikes.tierName(total)}).${lines.length ? `\n${lines.join('\n')}` : ' No active strikes.'}`);
    }
    if (sub === 'add') {
      if (member.id === interaction.guild.ownerId) return R('You can’t strike the server owner.');
      const reason = (interaction.options.getString('reason') || '').trim();
      const ruleN = interaction.options.getString('rule');
      if (!ruleN && !reason) return R('Give a reason: pick **which rule** they broke, type a **custom reason**, or both.');
      // weight omitted → use the picked rule's already-decided weight. Manually given always wins, even
      // over a rule with a different default (a deliberate override, not an error).
      const ruleObj = ruleN ? rules.byIndex(Number(ruleN)) : null;
      const ruleWeight = ruleObj ? rules.weightOf(ruleObj.key) : null;
      let weight = interaction.options.getInteger('weight');
      let weightAutoFilled = false;
      if (weight == null) {
        if (ruleWeight == null) return R(ruleN ? `Rule ${ruleN} doesn’t have a decided weight yet. Specify one (1-3) manually.` : 'Specify a **weight** (1-3), or pick a rule that already has one decided.');
        weight = ruleWeight; weightAutoFilled = true;
      }
      const timeoutStr = interaction.options.getString('timeout');
      let timeoutMs = null;
      if (timeoutStr) {
        timeoutMs = corner.parseDuration(timeoutStr);
        if (!timeoutMs) return R('Bad timeout duration. Use e.g. `30s`, `30m`, `2h`, `3d`.');
      }
      const cornerStr = interaction.options.getString('corner');
      let cornerMs = null;
      if (cornerStr) { cornerMs = corner.parseDuration(cornerStr); if (!cornerMs) return R('Bad corner duration. Use e.g. `30m`, `2h`, `30s`.'); }
      const reasonText = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${reason ? `, ${reason}` : ''}` : reason;
      const res = await strikes.addStrike(interaction.guild, member, state, { weight, ruleIndex: ruleN, reason: reasonText, timeoutMs, byId: interaction.user.id, byTag: interaction.user.tag });
      let cornerNote = '';
      if (cornerMs) {
        const cr = await corner.corner(interaction.guild, member, cornerMs, state, interaction.user.id, ruleN);
        if (cr.ok) {
          const relSec = Math.floor((Date.now() + cornerMs) / 1000);
          cornerNote = ` · ⛓️ also cornered until <t:${relSec}:R>`;
          try { const cch = await interaction.guild.channels.fetch(config.cornerChannelId).catch(() => null); if (cch) await cch.send(cornerSentMessage(user.id, `until <t:${relSec}:f>`, reasonText)); } catch { /* announce best-effort */ }
          await logCorner(interaction.guild, { emoji: '⛓️', title: 'SENT TO THE CORNER (with strike)', color: CORNER_RED, desc: `<@${user.id}> was cornered until ${relPhrase(relSec * 1000)} alongside a strike.\n**By:** <@${interaction.user.id}>` });
        } else cornerNote = ` · ⚠️ corner failed: ${cr.error}`;
      }
      // res.weight is the EFFECTIVE weight (base + the timeout's linear-capped bonus) — always show
      // that, never the raw input, so the mod sees what was actually recorded.
      const bonus = strikes.timeoutBonusUnits(timeoutMs);
      // Public, no DMs: post in the channel the command was run in, in addition to the mod's ephemeral ack.
      // Strike ID included so the member can look up + appeal it without asking staff what it is.
      // Public, no DMs, but a real notification — ping the struck member (unlike reference-only mentions).
      await interaction.channel.send({ content: `⚠️ <@${user.id}> was given a strike, ${reasonText}${timeoutMs ? ' (+ timeout)' : ''}. Strike ID: \`${res.id}\`. Appealable with \`/appeal strike\`.`, allowedMentions: { users: [user.id] } }).catch(() => {});
      const banNote = res.crossedBan ? banConfirmRow(user.id, 'Confirm ban') : null;
      await ownerlog.log(interaction.guild, { emoji: '⚠️', title: 'Strike given', color: 0xED4245,
        detail: `<@${user.id}> — ${strikes.formatUnits(res.weight)} unit(s), ${reasonText}${timeoutMs ? ' + timeout' : ''} — by <@${interaction.user.id}>. Now ${strikes.formatUnits(res.totalUnits)}/${cap}.` });
      return interaction.reply({ content: `⚠️ Gave <@${user.id}> a **${strikes.formatUnits(res.weight)}-unit** strike${weightAutoFilled ? ` (${weight}, Rule ${ruleN}’s decided weight)` : ''}${timeoutMs ? ` (${weight} base + ${strikes.formatUnits(bonus)} for the timeout)` : ''}, now **${strikes.formatUnits(res.totalUnits)}/${cap} units** (${res.tier})${res.crossedBan ? ', 🔨 **crossed the ban threshold**' : ''}${cornerNote}.`,
        components: banNote ? [banNote] : [], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'remove') {
      const strikeId = interaction.options.getString('strike_id');
      const r = await strikes.removeStrike(interaction.guild, member, state, strikeId, interaction.user.tag);
      if (!r.ok) return R(`No active strike \`${strikeId}\` found on <@${user.id}>. Check \`/strike view\` for the right ID.`);
      await ownerlog.log(interaction.guild, { emoji: '➖', title: 'Strike removed', color: 0x57F287,
        detail: `\`${strikeId}\` from <@${user.id}> — by <@${interaction.user.id}>. Now ${strikes.formatUnits(r.totalUnits)}/${cap}.` });
      return R(`✅ Removed strike \`${strikeId}\` from <@${user.id}>, now **${strikes.formatUnits(r.totalUnits)}/${cap} units** (${r.tier}).`);
    }
    if (sub === 'clear') {
      const r = await strikes.clearStrikes(interaction.guild, member, state, interaction.user.tag);
      if (r.cleared) await ownerlog.log(interaction.guild, { emoji: '🧹', title: 'Strikes cleared', color: 0x57F287, detail: `All strikes (${r.cleared}) on <@${user.id}> — by <@${interaction.user.id}>.` });
      return R(r.cleared ? `🧹 Cleared all strikes on <@${user.id}> (removed ${r.cleared}).` : `<@${user.id}> had no strikes.`);
    }
    return;
  }
  if (name === 'verify') {
    if (!canVerify(interaction)) return interaction.reply({ content: 'Only staff (mods+ or trial mods) can verify members.', flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: copy.common.notInServer, flags: MessageFlags.Ephemeral });
    if (config.verifiedRoleId && member.roles.cache.has(config.verifiedRoleId))
      return interaction.reply({ content: `<@${user.id}> is already verified.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    await member.roles.add(config.verifiedRoleId, `Verified via /verify by ${interaction.user.tag}`).catch(() => {});
    if (config.unverifiedRoleId) await member.roles.remove(config.unverifiedRoleId, 'Verified via /verify').catch(() => {});
    return interaction.reply({ content: `✅ Verified <@${user.id}> (\`${user.tag}\`).`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (name === 'features') {
    const ftier = opspanel.tierOf(interaction);
    if (ftier !== 'owner' && ftier !== 'botowner') return interaction.reply({ content: '🔒 Feature toggles are **Owner** only.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const flags = features.load();
      const lines = features.REGISTRY.map(r => `${flags[r.key] === true ? '🟢' : '⚫'} \`${r.key}\` · ${r.audience}${r.built ? '' : ' (planned)'}`).join('\n');
      return interaction.reply({ content: `**Features:**\n${lines}`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'toggle') {
      const key = interaction.options.getString('feature');
      const on = interaction.options.getBoolean('on');
      if (!features.get(key)) return interaction.reply({ content: `Unknown feature \`${key}\`.`, flags: MessageFlags.Ephemeral });
      features.setEnabled(key, on);
      const restart = features.needsRestart(key);
      await ownerlog.log(interaction.guild, { emoji: on ? '🟢' : '⚫', title: `Feature ${on ? 'enabled' : 'disabled'}`, color: on ? 0x57F287 : 0x99AAB5, detail: `\`${key}\` — by <@${interaction.user.id}>.` });
      return interaction.reply({ content: `${on ? '🟢' : '⚫'} \`${key}\` → **${on ? 'ON' : 'OFF'}**.`
        + (restart ? ' ⚠️ Restart the bot for this to fully take effect (it adds/removes commands or options).' : ' Takes effect immediately, no restart needed.'),
        flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (name === 'permguard') {
    const ptier = opspanel.tierOf(interaction);
    if (ptier !== 'owner' && ptier !== 'botowner') return interaction.reply({ content: '🔒 Permission-guard controls are **Owner** only.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'status') {
      const r = await permguard.sweepPermissions(interaction.guild, { notify: true });
      const lines = [`🛡️ Sweep complete.`, `Corrected: **${r.fixed}** overwrite(s).`, `New per-member overrides flagged: **${r.newMemberOverwrites.length}**.`, `Unmanaged channels (created after last snapshot): **${r.unmanagedChannels}**.`];
      if (r.fixed) lines.push('', ...r.corrections.slice(0, 15).map(c => `• #${c.channel} · ${c.role}`));
      return interaction.editReply(lines.join('\n'));
    }
    if (sub === 'resnapshot') {
      if (interaction.options.getBoolean('force')) {
        const r = await permguard.resnapshot(interaction.guild);
        await ownerlog.log(interaction.guild, { emoji: '📸', title: 'Permission baseline re-snapshotted (forced)', color: 0x5865F2, detail: `${r.channels} channels, ${r.overwrites} overwrite entries — by <@${interaction.user.id}>. Whatever's live right now is the new "correct" state (no review).` });
        return interaction.editReply(`📸 New baseline saved: **${r.channels}** channels, **${r.overwrites}** overwrite entries. This is now what permguard will enforce.`);
      }
      // Default: interactive review — show every change since the baseline, keep/undo each, then commit.
      return permguard.openReconcile(interaction);
    }
    return;
  }
  if (name === 'watchlist') {
    if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnly, flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const ids = watchlist.loadWatched();
      return interaction.reply({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        content: `**On the Watchlist (${ids.length}):**\n${ids.map(id => `• <@${id}>`).join('\n') || '_none_'}` });
    }
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can edit the watchlist.', flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member isn\'t in the server.', flags: MessageFlags.Ephemeral });
    if (sub === 'add') { watchlist.addWatch(user.id); return interaction.reply({ content: `👁 <@${user.id}> added to the Watchlist.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); }
    if (sub === 'remove') { watchlist.removeWatch(user.id); return interaction.reply({ content: `✅ <@${user.id}> removed from the Watchlist.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); }
    return;
  }
  if (name === 'perms') {
    // OWNER-ONLY permission inspector/auditor. Ephemeral; computed against real tier role-sets.
    if (!opspanel.isBotOwner(interaction)) return interaction.reply({ content: 'Only the bot owner can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const guild = interaction.guild;
      await guild.channels.fetch().catch(() => {});
      await guild.roles.fetch().catch(() => {});
      const sub = interaction.options.getSubcommand();
      let text;
      if (sub === 'tier') text = perms.tierReport(guild, interaction.options.getString('tier'));
      else if (sub === 'channel') text = perms.channelReport(guild, interaction.options.getChannel('channel'));
      else text = perms.grandAudit(guild);
      const parts = perms.chunk(text);
      await interaction.editReply({ content: parts[0], allowedMentions: { parse: [] } });
      for (let i = 1; i < parts.length; i++) await interaction.followUp({ content: parts[i], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (e) { console.error('[perms]', e.message); await interaction.editReply(`Error: ${e.message}`).catch(() => {}); }
    return;
  }
  if (name === 'grade') {
    // OWNER-ONLY. Grade a smart-watch card by its short ID (works when there are no buttons — e.g. live).
    if (!opspanel.isBotOwner(interaction)) return interaction.reply({ content: 'Only the bot owner can grade cards.', flags: MessageFlags.Ephemeral });
    const gid = (interaction.options.getString('id') || '').trim().toUpperCase();
    const verdict = interaction.options.getString('verdict');
    const note = (interaction.options.getString('note') || '').trim() || null;
    const meta = smartwatch.VERDICT_META[verdict];
    if (!meta) return interaction.reply({ content: 'Unknown verdict.', flags: MessageFlags.Ephemeral });
    const card = smartwatch.lookupCard(gid);
    if (!card) return interaction.reply({ content: `No card with id \`${gid}\`. Check the grade id on the card (only the last ~400 are kept).`, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const aiWouldSurface = !!card.aiWouldSurface;
    smartwatch.addExample({ ts: Date.now(), verdict, task: meta.task, content: card.content, note, channel: card.channel, aiWouldSurface, author: card.author, by: interaction.user.id, byTag: interaction.user.tag });
    const correct = aiWouldSurface === meta.surface;
    const stats = smartwatch.labStats(meta.task);
    const acc = stats.total ? Math.round(100 * stats.right / stats.total) : 0;
    // Best-effort: annotate + lock the card message so it shows it was graded.
    try {
      if (card.cardMsgId && card.cardChannelId) {
        const cch = await interaction.guild.channels.fetch(card.cardChannelId).catch(() => null);
        const cm = cch && await cch.messages.fetch(card.cardMsgId).catch(() => null);
        if (cm?.embeds?.[0]) {
          const e2 = EmbedBuilder.from(cm.embeds[0]).setColor(correct ? 0x3BA55D : 0xED4245).addFields({
            name: `✅ Graded via /grade (\`${gid}\`)`, value: `**${meta.label.split(' (')[0]}** by <@${interaction.user.id}>, AI was ${correct ? '✅ right' : '❌ wrong'}${note ? `\ncorrect read: _${note}_` : ''}\n${meta.task} accuracy **${acc}%** (${stats.right}/${stats.total})`.slice(0, 1024) });
          const links = (cm.components?.flatMap(r => r.components) || []).filter(b => b.style === ButtonStyle.Link);
          await cm.edit({ embeds: [e2], components: links.length ? [new ActionRowBuilder().addComponents(...links.map(b => ButtonBuilder.from(b)))] : [] }).catch(() => {});
        }
      }
    } catch { /* annotate best-effort */ }
    return interaction.editReply(`✅ Graded \`${gid}\` as **${meta.label.split(' (')[0]}**, AI was ${correct ? 'right ✅' : 'wrong ❌'}. ${meta.task} accuracy now **${acc}%**${note ? ' · note saved to guide the judge' : ''}.`);
  }
  if (name === 'watchlist-suggest') {
    if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnly, flags: MessageFlags.Ephemeral });
    const hours = interaction.options.getInteger('hours') || 6;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await suggest.scan(interaction.guild, config, hours);
      return await interaction.editReply(suggest.render(result));
    } catch (e) {
      console.error(`[suggest] ${e.message}`);
      return interaction.editReply({ content: `Scan failed: ${e.message}` }).catch(() => {});
    }
  }
  if (name === 'suggest-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: 'Only owners can set up the forum.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { forum, created } = await suggestions.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} the suggestions forum <#${forum.id}>. Members post with \`/suggest\`.`);
    } catch (e) { console.error(`[suggestions] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'suggest') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can post suggestions.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await suggestions.submit(interaction.guild, interaction.member, interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Posted **Suggestion #${r.num}** → <#${r.threadId}>. Others can vote; staff will approve or deny.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[suggestions] submit ${e.message}`); return interaction.editReply('Could not post that suggestion.').catch(() => {}); }
  }
  if (name === 'confess-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { channel, logChannel, created } = await confessions.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} confessions <#${channel.id}>${logChannel ? ` + staff log <#${logChannel.id}>` : ''}. Members post with \`/confess\`.`);
    } catch (e) { console.error(`[confessions] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'confess') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can confess.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await confessions.submit(interaction.guild, interaction.member, interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Posted **Confession #${r.num}** anonymously. Your name is hidden from other members.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[confessions] submit ${e.message}`); return interaction.editReply('Could not post that confession.').catch(() => {}); }
  }
  if (name === 'whistleblow-setup') {
    if (!opspanel.isBotOwner(interaction)) return interaction.reply({ content: 'Only the **bot owner** can set up whistleblows. You become the “you” who can unseal. (This is bot-owner-only.)', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const cfg = await whistleblow.setup(interaction.guild, interaction.user.id);
      return interaction.editReply(`✅ Whistleblows now DM **you** (<@${cfg.you}>) and/or the **owner** (<@${cfg.her}>) per the sender’s choice, delivered privately, never in a channel, so no one with Administrator can snoop. Members report with \`/whistleblow\`.`);
    } catch (e) { console.error(`[whistleblow] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'whistleblow') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await whistleblow.submit(interaction.guild, interaction.member, interaction.options.getString('text'), interaction.options.getString('to'));
      return interaction.editReply(r.ok
        ? `✅ Sent **Whistleblow #${r.num}**, delivered privately by DM. You chose: **${whistleblow.CHOICES[r.choice]}**.${r.choice === 'anonymous' ? ' No identity was stored. This can never be traced to you.' : ''}`
        : `❌ ${r.msg}`);
    } catch (e) { console.error(`[whistleblow] submit ${e.message}`); return interaction.editReply('Could not send that.').catch(() => {}); }
  }
  if (name === 'apply-mod-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { forum, apps } = await modapps.setup(interaction.guild, config);
      return interaction.editReply(`✅ Mod applications ready: staff review forum <#${forum.id}> (anon 👍/👎, admins decide) + applicant threads in <#${apps.id}>. Members apply with \`/apply-mod\`.`);
    } catch (e) { console.error(`[modapps] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'apply-mod') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can apply.', flags: MessageFlags.Ephemeral });
    if (!modapps.isConfigured()) return interaction.reply({ content: 'Mod applications aren’t set up on this server yet. Ask an admin to set it up in **/panel → 🧩 Setup**.', flags: MessageFlags.Ephemeral });
    if (!modapps.applicationsOpen()) return interaction.reply({ content: modapps.closedNotice(), flags: MessageFlags.Ephemeral });
    // If language mini-mods are set up, ask which position first; otherwise go straight to the mod modal.
    if (features.enabled('langMiniMod') && langmods.isConfigured()) {
      return interaction.reply({ content: 'What are you applying for?', components: [modapps.positionRow()], flags: MessageFlags.Ephemeral });
    }
    try { return await interaction.showModal(modapps.buildModal()); }
    catch (e) { console.error(`[modapps] showModal ${e.message}`); }
    return;
  }
  if (name === 'mod-applications') {
    if (!['admin', 'owner', 'botowner'].includes(opspanel.tierOf(interaction)))
      return interaction.reply({ content: 'Only admins can open or close mod applications.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const open = modapps.applicationsOpen();
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: open
        ? '✅ Mod applications are **OPEN**. Members can `/apply-mod`.'
        : `🚫 Mod applications are **CLOSED**.\nMembers who try to apply see:\n> ${modapps.closedNotice()}` });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'close') {
      const msg = interaction.options.getString('message');
      await modapps.setApplicationsOpen(interaction.guild, false, msg);
      await ownerlog.log(interaction.guild, { emoji: '🚫', title: 'Mod applications CLOSED', color: 0xED4245, detail: `Closed by <@${interaction.user.id}> (team full). New \`/apply-mod\` is turned away; in-flight applications still finish.${msg ? `\nNote to applicants: ${msg}` : ''}` });
      return interaction.editReply(`🚫 Mod applications are now **CLOSED**. New \`/apply-mod\` attempts are turned away; applications already under review still finish. Reopen anytime with \`/mod-applications open\`.`);
    }
    if (sub === 'open') {
      await modapps.setApplicationsOpen(interaction.guild, true);
      await ownerlog.log(interaction.guild, { emoji: '✅', title: 'Mod applications REOPENED', color: 0x57F287, detail: `Reopened by <@${interaction.user.id}> — members can \`/apply-mod\` again.` });
      return interaction.editReply('✅ Mod applications are now **OPEN**. Members can `/apply-mod` again.');
    }
    return;
  }
  if (name === 'staff') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can view the census.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await ensureMembers(interaction.guild);
    const trialId = modapps.loadConfig().trialModRoleId;
    // Counted by HIGHEST tier so nobody is double-counted (higher tiers absorb the lower). memberTier
    // returns owner→admin→mod (the bot's canonical tier); Trial Mod is only counted for people below mod.
    const byTier = { owner: [], admin: [], mod: [], trial: [] };
    let humans = 0;
    for (const m of members.values()) {
      if (m.user.bot) continue;
      humans++;
      const t = opspanel.memberTier(m);
      if (t === 'owner') byTier.owner.push(m);
      else if (t === 'admin') byTier.admin.push(m);
      else if (t === 'mod') byTier.mod.push(m);
      else if (trialId && m.roles.cache.has(trialId)) byTier.trial.push(m);
    }
    const owner = byTier.owner.length, admin = byTier.admin.length, mod = byTier.mod.length, trial = byTier.trial.length;
    // MEMBER NAMES are plain text (display name), NOT @mentions: Discord's mobile client resolves a member
    // mention only from its OWN cache, so uncached members render "@unknown-user" (owner: "only shows who I'm
    // friends with") — content vs embed doesn't change that. displayName always renders correctly. TIER HEADERS
    // use role mentions (<@&id>) — roles ARE always cached, so those resolve + carry the role's real colour.
    // Owner-tier membership keys off 4 personal roles + guild owner, but the VISIBLE role is OWNER⚜️
    // (OWNER_DISPLAY_ROLE_ID) — use it for the header so it resolves + colours like the rest. parse:[] = role
    // names resolve/colour but nobody is pinged. Fancy markdown: ## header, -# subtext, code-styled handle + id.
    const line = (m) => `**${m.displayName}** · \`${m.user.username}\` · \`${m.id}\``;
    const block = (roleId, emoji, label, arr) => {
      const head = roleId ? `<@&${roleId}>: \`${arr.length}\`` : `${emoji} **${label}**: \`${arr.length}\``;
      return `\n${head}\n${arr.length ? arr.map(line).join('\n') : '-# _(none)_'}`;
    };
    const out = `## 👥 Staff: \`${owner + admin + mod + trial}\` total\n-# of ${humans.toLocaleString()} members · counted at their highest tier\n`
      + block(opspanel.OWNER_DISPLAY_ROLE_ID, '👑', 'Owner', byTier.owner)
      + block(opspanel.ADMIN_ROLE_ID, '🛡️', 'Admin', byTier.admin)
      + block(opspanel.MOD_ROLE_ID, '⚒️', 'Mod', byTier.mod)
      + block(trialId, '🌱', 'Trial Mod', byTier.trial);
    // Split by line into ≤1900-char messages (Discord's 2000 content cap).
    const chunks = []; let cur = '';
    for (const ln of out.split('\n')) { if (cur.length + ln.length + 1 > 1900) { chunks.push(cur); cur = ''; } cur += (cur ? '\n' : '') + ln; }
    if (cur) chunks.push(cur);
    await interaction.editReply({ content: chunks[0] || '👥 No staff.', allowedMentions: { parse: [] } }).catch(() => {});
    for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }
  if (name === 'promote-trial' || name === 'promote-mod') {
    // promote-trial: any mod may open the vote. promote-mod (→ admin): admin+ only.
    if (name === 'promote-mod' ? !canWLAdmin(interaction) : !canBan(interaction))
      return interaction.reply({ content: name === 'promote-mod' ? 'Only admins can open a mod→admin promotion vote.' : 'Only staff (mods+) can open a promotion vote.', flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(interaction.options.getString('member')).catch(() => null);
    if (!target) return interaction.reply({ content: 'Couldn’t find that member in the server.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const kind = name === 'promote-mod' ? 'mod' : 'trial';
    const r = await promote.start(interaction.guild, target, interaction.user.id, config, kind);
    return interaction.editReply(r.ok ? `✅ Promotion vote opened in <#${r.channelId}>. Staff vote 👍/👎, an owner confirms.` : `❌ ${r.msg}`).catch(() => {});
  }
  if (name === 'demote-trial') {
    // Owner/approver only — the inverse of accepting an application, so it takes the same tier.
    const approvers = modapps.loadConfig().approvers || [];
    if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id) && !opspanel.isBotOwner(interaction))
      return interaction.reply({ content: 'Only the **server owner** can demote a trial mod.', flags: MessageFlags.Ephemeral });
    const roleId = modapps.loadConfig().trialModRoleId;
    if (!roleId) return interaction.reply({ content: 'No Trial Mod role is configured. Run `/apply-mod-setup` first.', flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(interaction.options.getString('member')).catch(() => null);
    if (!target) return interaction.reply({ content: 'Couldn’t find that member in the server.', flags: MessageFlags.Ephemeral });
    if (!target.roles.cache.has(roleId)) return interaction.reply({ content: `<@${target.id}> isn’t a **Trial Mod**, so there’s nothing to remove.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason');
    const ok = await target.roles.remove(roleId, `Trial Mod demoted by ${interaction.user.tag}${reason ? ` - ${reason}` : ''}`).then(() => true).catch(() => false);
    return interaction.editReply(ok
      ? `✅ Removed the **Trial Mod** role from <@${target.id}>.${reason ? ` (noted: ${reason})` : ''}`
      : '❌ Couldn’t remove the role. Make sure the bot’s own role sits above **Trial Mod**.').catch(() => {});
  }
  if (name === 'help') {
    return interaction.reply({ embeds: [helpEmbed(interaction.guild)], flags: MessageFlags.Ephemeral });
  }
  if (name === 'dashboard') {
    return interaction.reply({ ...pubdash.hubPanel(interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
  if (name === 'dashboard-setup') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins can post the hub panel.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sent = await interaction.channel.send(pubdash.hubPanel(interaction.guild.id)).catch(() => null);
    if (!sent) return interaction.editReply('Could not post here. Check my permissions in this channel.');
    await sent.pin().catch(() => {});
    return interaction.editReply('Posted and pinned the member hub in this channel.');
  }
  if (name === 'tribe') {
    const sub = interaction.options.getSubcommand();
    const argTribe = interaction.options.getString('tribe');
    // Warden tools always act on the tribe you LEAD/belong to; info/roster accept an explicit tribe arg.
    const wardenSub = ['invite', 'banish', 'announce', 'note', 'rank'].includes(sub);
    const tribe = (!wardenSub && argTribe) ? tribes.resolve(argTribe) : tribes.myTribe(interaction.member);
    if (!tribe) return interaction.reply({ content: (!wardenSub && argTribe) ? `No tribe matches “${argTribe}”. Check Standings in #tribes-hub.` : (wardenSub ? 'You don’t lead a tribe, so there’s nothing to manage.' : 'You’re not in a tribe yet. #tribes-hub shows them; `/request-role` the tribe role to join one.'), flags: MessageFlags.Ephemeral });
    if (sub === 'info') {
      const memberCount = interaction.guild.roles.cache.get(tribe.roleId)?.members.size ?? 0;
      const land = [tribe.throneId && `<#${tribe.throneId}>`, tribe.hallId && `<#${tribe.hallId}>`, tribe.vcId && `<#${tribe.vcId}>`, tribe.text2Id && `<#${tribe.text2Id}>`, tribe.vc2Id && `<#${tribe.vc2Id}>`].filter(Boolean).join(' · ') || '_none yet_';
      const leader = tribe.leaderRoleId ? `<@&${tribe.leaderRoleId}>` : '_no leader set_';
      const content = `## ${tribe.emoji || '🏴'} ${tribe.name}${tribe.strongholdTier ? ` · 🏰 Tier ${tribe.strongholdTier} Stronghold` : ''}\n-# 🏴 Tribe · led by ${leader}`
        + (tribe.motto ? `\n> *${tribe.motto}*` : '');
      const embed = new EmbedBuilder().setColor(tribe.color || 0x2A426A).addFields(
        { name: '🌊 Members', value: String(memberCount), inline: true },
        { name: '👑 Glory (this week)', value: String(tribe.glory || 0), inline: true },
        { name: '🪙 Treasury', value: String(tribe.treasury || 0), inline: true },
        { name: '⚓ Land', value: land, inline: false },
      );
      const footerBits = [tribe.crownsWon ? `👑 ${tribe.crownsWon} crown${tribe.crownsWon === 1 ? '' : 's'} won lifetime` : null, !tribe.motto ? 'A leader can set the motto with /tribe motto.' : null].filter(Boolean);
      if (footerBits.length) embed.setFooter({ text: footerBits.join(' · ') });
      return interaction.reply(withBanner(tribe.key, { content, embeds: [embed], allowedMentions: { parse: [] } }));
    }
    if (sub === 'motto') {
      if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
        return interaction.reply({ content: `Only the leader of **${tribe.shortName || tribe.name}** (or staff) can set its motto.`, flags: MessageFlags.Ephemeral });
      const text = interaction.options.getString('text');
      tribes.setMotto(tribe.key, text);
      await interaction.deferReply();
      if (config.rolesChannelId) await roleselect.refreshTribeBlock(interaction.guild, config.rolesChannelId).catch(() => {});   // the picker shows each tribe's motto — keep it in sync
      await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
      return interaction.editReply({ content: `${tribe.emoji || '🌊'} Motto set for **${tribe.shortName || tribe.name}**:\n> *${text.slice(0, 300)}*`, allowedMentions: { parse: [] } });
    }
    if (sub === 'banner') {
      if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
        return interaction.reply({ content: `Only the leader of **${tribe.shortName || tribe.name}** (or staff) can set its banner.`, flags: MessageFlags.Ephemeral });
      const image = interaction.options.getAttachment('image');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!image) {
        try { if (tribeHasBanner(tribe.key)) fs.unlinkSync(tribeBannerPath(tribe.key)); } catch { /* already gone */ }
        tribes.update(tribe.key, { hasBanner: false });
        return interaction.editReply('🖼️ Banner cleared.');
      }
      if (!/^image\//.test(image.contentType || '')) return interaction.editReply('That’s not an image. Attach a PNG or JPG.');
      if ((image.size || 0) > 8 * 1024 * 1024) return interaction.editReply('That image is over 8MB. Please use a smaller one.');
      try {
        const res = await fetch(image.url, { signal: AbortSignal.timeout(10000) });
        fs.writeFileSync(tribeBannerPath(tribe.key), Buffer.from(await res.arrayBuffer()));
        tribes.update(tribe.key, { hasBanner: true });
        return interaction.editReply(`🖼️ Banner set for **${tribe.shortName || tribe.name}**. It shows on \`/tribe info\`.`);
      } catch (e) { console.error('[tribe banner]', e.message); return interaction.editReply('Couldn’t save that image. Try again.'); }
    }
    if (sub === 'nominate') {   // ANY member can propose; goes to the throne for approval, then the nominee accepts
      const target = interaction.options.getMember('user');
      if (!target) return interaction.reply({ content: 'Couldn’t find that member.', flags: MessageFlags.Ephemeral });
      if (target.id === interaction.user.id) return interaction.reply({ content: 'You can’t nominate yourself.', flags: MessageFlags.Ephemeral });
      if (target.user.bot) return interaction.reply({ content: 'Bots can’t join tribes.', flags: MessageFlags.Ephemeral });
      if (target.roles.cache.has(tribe.roleId)) return interaction.reply({ content: `<@${target.id}> is already in **${tribe.shortName || tribe.name}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      const other = tribes.memberTribe(target);
      if (other) return interaction.reply({ content: `<@${target.id}> is already in **${other.shortName || other.name}**. A member can only be in one tribe.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      const existing = tribes.getNomination(target.id);
      if (existing && ['pending_approval', 'pending_accept'].includes(existing.status)) return interaction.reply({ content: `<@${target.id}> already has a pending nomination.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      if (!tribe.throneId) return interaction.reply({ content: 'This tribe has no throne channel to route the approval through.', flags: MessageFlags.Ephemeral });
      const throne = await interaction.guild.channels.fetch(tribe.throneId).catch(() => null);
      if (!throne) return interaction.reply({ content: 'Couldn’t find the throne channel.', flags: MessageFlags.Ephemeral });
      tribes.createNomination(tribe.key, interaction.user.id, target.id);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tribenom_approve:${target.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`tribenom_deny:${target.id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger));
      await throneSend(throne, { content: `## 🪶 Nomination\n-# proposed by <@${interaction.user.id}>\n> <@${interaction.user.id}> nominates <@${target.id}> to join **${tribe.shortName || tribe.name}**.\n-# ${tribes.leaderTitle(tribe)} or staff: approve to send them an invite to accept.`, components: [row], allowedMentions: { users: [target.id] } }).catch(() => {});
      return interaction.reply({ content: `🪶 Sent to <#${tribe.throneId}> for approval. If ${tribes.leaderTitle(tribe)} or staff approve, ${target.displayName} will get an invite to accept.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    // A self-service petition — reuses the EXACT nomination machinery (nominatorId === targetId), so leader/
    // staff approval + the DM-first accept prompt (with entrance gate if set) all come for free. A first-timer
    // with no prior tribe should just use the free #roles pledge instead (no approval needed there at all).
    if (sub === 'offer') {   // voluntary tithe: your OWN points -> tribe treasury, 1:1. Ranks never demote, so
      const pts = tribe.pointsName || 'points';                                                   // this only slows your NEXT promotion, it can't cost you your current rank.
      const amount = interaction.options.getInteger('amount');
      const mine = tribes.getTides(tribe.key, interaction.user.id);
      if (mine < amount) return interaction.reply({ content: `You only have **${mine} ${pts}**.`, flags: MessageFlags.Ephemeral });
      tribes.addTides(tribe.key, interaction.user.id, -amount);
      tribes.addTreasury(tribe.key, amount);
      return interaction.reply({ content: `🪙 Offered **${amount} ${pts}** to **${tribe.shortName || tribe.name}**'s treasury, now **${tribes.getTreasury(tribe.key)}**. Your rank doesn't drop, this only slows your climb to the next one.`, allowedMentions: { parse: [] } });
    }
    if (sub === 'retheme') {
      if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
        return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can retheme the tribe.`, flags: MessageFlags.Ephemeral });
      if (!tribes.hasUnlock(tribe, 'retheme') && !tribes.hasFreeRetheme(tribe)) return interaction.reply({ content: `**${tribe.shortName || tribe.name}** hasn’t unlocked Re-theme yet. Check the Shop button in #tribes-hub or your throne.`, flags: MessageFlags.Ephemeral });
      const color = parseTribeHex(interaction.options.getString('color'));
      if (color === null) return interaction.reply(badHexReply('primary'));
      const c2raw = interaction.options.getString('color2');
      const color2 = c2raw ? parseTribeHex(c2raw) : null;
      if (c2raw && color2 === null) return interaction.reply(badHexReply('second'));
      const r = await applyRetheme(interaction.guild, tribe, { color, color2, name: interaction.options.getString('name'), shortName: interaction.options.getString('short_name') });
      let freeNote = '';
      if (r.ok !== false && !tribes.hasUnlock(tribe, 'retheme') && tribes.consumeFreeRetheme(tribe.key)) {
        const left = (tribes.get(tribe.key).freeRethemes || 0);
        freeNote = `\n-# Used a **free retheme** (leader-loss grant).${left ? ` ${left} left.` : ''}`;
      }
      return interaction.reply(r.content + freeNote);
    }
    if (sub === 'icon') {
      if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
        return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can set the tribe icon.`, flags: MessageFlags.Ephemeral });
      if (!tribes.hasUnlock(tribe, 'icon')) return interaction.reply({ content: `**${tribe.shortName || tribe.name}** hasn’t unlocked the **Tribe Icon** yet. Check the Shop button in #tribes-hub or your throne.`, flags: MessageFlags.Ephemeral });
      const role = interaction.guild.roles.cache.get(tribe.roleId);
      if (!role) return interaction.reply({ content: 'Couldn’t find the tribe role.', flags: MessageFlags.Ephemeral });
      const image = interaction.options.getAttachment('image');
      const raw = (interaction.options.getString('emoji') || '').trim();
      if (!image && !raw) return interaction.reply({ content: 'Give an **emoji**, upload an **image**, or pass `none` to clear.', flags: MessageFlags.Ephemeral });
      // Clear
      if (!image && /^(none|clear|off)$/i.test(raw)) {
        await role.edit({ unicodeEmoji: null, icon: null }, `Tribe icon cleared by ${interaction.user.tag}`).catch(() => {});
        return interaction.reply({ content: `🖼️ Cleared **${tribe.shortName || tribe.name}**’s role icon.`, flags: MessageFlags.Ephemeral });
      }
      // Image upload wins if both are given. Validate type + size (Discord: image, ≤256KB), download to a
      // buffer, set as the role icon (image role icons need boost tier 2+; this server is tier 3).
      if (image) {
        if (!/^image\/(png|jpe?g|webp)$/i.test(image.contentType || '')) return interaction.reply({ content: 'The image must be a PNG, JPG, or WebP.', flags: MessageFlags.Ephemeral });
        if ((image.size || 0) > 256 * 1024) return interaction.reply({ content: `That image is ${Math.round((image.size || 0) / 1024)}KB — role icons must be under **256KB**.`, flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let buf;
        try { const res = await fetch(image.url); buf = Buffer.from(await res.arrayBuffer()); }
        catch (e) { return interaction.editReply('Couldn’t download that image. Try again.'); }
        const ok = await role.edit({ icon: buf, unicodeEmoji: null }, `Tribe icon (image) set by ${interaction.user.tag}`).then(() => true).catch(e => { console.error('[tribe icon]', e.message); return false; });
        if (!ok) return interaction.editReply('Couldn’t set that image as the role icon. It may not be square, or Discord rejected it.');
        await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
        return interaction.editReply(`🖼️ Set **${tribe.shortName || tribe.name}**’s role icon to your uploaded image.`);
      }
      // Emoji path — grab the first emoji glyph.
      const m = raw.match(/\p{Extended_Pictographic}/u);
      if (!m) return interaction.reply({ content: 'Give a single emoji (e.g. 🔥), upload an image, or `none` to clear.', flags: MessageFlags.Ephemeral });
      const ok = await role.edit({ unicodeEmoji: m[0], icon: null }, `Tribe icon set by ${interaction.user.tag}`).then(() => true).catch(() => false);
      if (!ok) return interaction.reply({ content: 'Couldn’t set that as the role icon. (Emoji may not be supported.)', flags: MessageFlags.Ephemeral });
      await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
      return interaction.reply({ content: `🖼️ Set **${tribe.shortName || tribe.name}**’s role icon to ${m[0]}.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'muster') {
      if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
        return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can call a muster.`, flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await submitMuster(interaction.guild, tribe, interaction.user.id);
      return interaction.editReply(r.content);
    }
    // ---- Warden's tools: leaders of THIS tribe (or staff) ----
    if (wardenSub) {
      if (!tribes.isLeader(interaction.member, tribe) && !opspanel.tierOf(interaction))
        return interaction.reply({ content: `Only the leader of **${tribe.shortName || tribe.name}** (or staff) can do that.`, flags: MessageFlags.Ephemeral });
      const target = interaction.options.getMember('user');
      if (sub === 'invite') {
        // Owner, 2026-08-03: "invite should get consent" — no longer adds directly. Skips straight to the
        // accept/decline step (no separate approval needed, the leader inviting IS the approval), reusing
        // the same nomination/accept machinery as /tribe nominate. No entrance gate on this path though —
        // the leader already vouches for this person, a quiz on top would be redundant here specifically.
        if (!target) return interaction.reply({ content: 'Couldn’t find that member.', flags: MessageFlags.Ephemeral });
        const r = await submitInvite(interaction.guild, tribe, interaction.user.id, target);
        return interaction.reply({ content: r.content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      if (sub === 'banish') {
        if (!target) return interaction.reply({ content: 'Couldn’t find that member.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await submitBanish(interaction.guild, tribe, target, interaction.user.tag);
        return interaction.editReply(r.content);
      }
      if (sub === 'announce') {
        if (!tribe.throneId) return interaction.reply({ content: 'This tribe has no throne channel to announce in.', flags: MessageFlags.Ephemeral });
        const throne = await interaction.guild.channels.fetch(tribe.throneId).catch(() => null);
        if (!throne) return interaction.reply({ content: 'Couldn’t find the throne channel.', flags: MessageFlags.Ephemeral });
        const msg = interaction.options.getString('message').slice(0, 1500).replace(/\n/g, '\n> ');
        await throneSend(throne, { content: `## ${tribe.emoji || '🏰'} ${tribe.shortName || tribe.name}: Proclamation\n-# by <@${interaction.user.id}> · <@&${tribe.roleId}>\n> ${msg}`, allowedMentions: { roles: [tribe.roleId], users: [interaction.user.id] } }).catch(e => console.error('[tribe announce]', e.message));
        return interaction.reply({ content: `📣 Posted to <#${tribe.throneId}> and rallied the tribe.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'note') {
        if (!target) return interaction.reply({ content: 'Couldn’t find that member.', flags: MessageFlags.Ephemeral });
        const text = interaction.options.getString('text');
        if (text) { tribes.addNote(tribe.key, target.id, text, interaction.user.id); return interaction.reply({ content: `📝 Noted on <@${target.id}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); }
        const notes = tribes.getNotes(tribe.key, target.id);
        if (!notes.length) return interaction.reply({ content: `No notes on <@${target.id}> yet. Add one with \`/tribe note user:@… text:…\`.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        const body = notes.map(n => `> ${n.text}\n-# by <@${n.by}> · <t:${Math.floor(n.at / 1000)}:R>`).join('\n');
        return interaction.reply({ content: `## 📝 Notes on ${target.displayName}\n${body}`.slice(0, 1900), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      if (sub === 'rank') {
        if (!target) return interaction.reply({ content: 'Couldn’t find that member.', flags: MessageFlags.Ephemeral });
        if (!tribes.isMember(target, tribe)) return interaction.reply({ content: `<@${target.id}> isn’t in **${tribe.shortName || tribe.name}**. Invite them first with \`/tribe invite\`.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        const idx = parseInt(interaction.options.getString('rank'), 10);
        if (!(idx >= 0 && tribe.ranks && tribe.ranks[idx])) return interaction.reply({ content: 'Pick a rank from the list.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await applyTribeRank(interaction.guild, tribe, target, idx, `manual — set by <@${interaction.user.id}>`, false);
        return interaction.editReply({ content: `${tribe.emoji || '🌊'} Set <@${target.id}> to **${tribe.ranks[idx].name}** in ${tribe.shortName || tribe.name}.`, allowedMentions: { parse: [] } });
      }
    }
  }
  if (name === 'tribe-admin') {
    const sub = interaction.options.getSubcommand();
    // 'create' has its own looser gate (admins, PLUS mods founding their own tribe); 'set-leader' is
    // gated inside its own handler (a tribe's OWN leader can use it, not just admins). Every other
    // subcommand (register/points/title/ranks/grant/challenge-*) stays admin-only, unchanged.
    const modSelfFounding = sub === 'create' && opspanel.tierOf(interaction) === 'mod';
    if (!['set-leader', 'arena'].includes(sub) && !canWLAdmin(interaction) && !modSelfFounding) return interaction.reply({ content: 'Only admins can create or register tribes.', flags: MessageFlags.Ephemeral });
    if (sub === 'hub-setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await ensureTribesHub(interaction.guild, config);
      return interaction.editReply(`🏴 Tribes Hub ${r.created ? 'created' : 'refreshed'} in <#${r.channelId}>.`);
    }
    if (sub === 'create') {
      const leaderMember = interaction.options.getMember('leader');
      const leaderTier = leaderMember && opspanel.memberTier(leaderMember);
      const isModSelfFound = leaderMember && leaderTier === 'mod' && leaderMember.id === interaction.user.id;
      // A tribe head must be an admin (owner ruling), OR a mod founding their OWN tribe (owner: "allow mods
      // to create their own tribe") — a mod can't hand tribe leadership to a DIFFERENT mod this way.
      const leaderIsEligible = leaderMember && (['admin', 'owner'].includes(leaderTier) || isModSelfFound);
      if (!leaderIsEligible) return interaction.reply({ content: 'A tribe head has to hold the **admin role**, or be a **mod founding their own tribe** (you must name yourself as leader).', flags: MessageFlags.Ephemeral });
      if (isModSelfFound) {
        // Owner: "if a mod wants to start a tribe it must be in a group of three" — the founder needs 2 OTHER
        // mods to co-sign before the wizard unlocks. Admin-founded tribes skip this entirely.
        // BUG FIXED 2026-08-03: this used to clearFoundingRequest() BEFORE showModal(), so if the modal call
        // ever failed (or the founder didn't finish the wizard, e.g. got rejected by the Build-step bug
        // above), the founding request was already gone with nothing to show for it — confirmed live: a
        // founder hit "3 mods reached", the request vanished, and 11 hours later they had to gather 2 FRESH
        // co-signs from scratch since /tribe-admin create just started a brand-new request. Now only cleared
        // in tribewiz_build's actual success path, so re-running this command is always safe to retry.
        const existing = tribes.getFoundingRequest(interaction.user.id);
        if (existing && existing.cosigns.length >= 2) {
          wizardTouch(interaction.user.id, { leaderId: leaderMember.id });
          return safeShowModal(interaction, tribeIdentityModal());
        }
        if (existing) return interaction.reply({ content: `Still waiting on co-signs: **${existing.cosigns.length}/2** mods so far. Check <#${config.modAnnounceChannelId}>.`, flags: MessageFlags.Ephemeral });
        if (!config.modAnnounceChannelId) return interaction.reply({ content: 'No mod-announcements channel configured to route this through.', flags: MessageFlags.Ephemeral });
        const ch = await interaction.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
        if (!ch) return interaction.reply({ content: 'Couldn’t find the mod-announcements channel.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        tribes.startFoundingRequest(interaction.user.id);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribefound_cosign:${interaction.user.id}`).setLabel('✅ Co-sign').setStyle(ButtonStyle.Success));
        const msg = await ch.send({ content: `## 🏴 Tribe founding request\n> <@${interaction.user.id}> wants to found a tribe. Founding a tribe as a mod takes **3 mods** total, needs **2 more** co-signs from other mods.`, components: [row], allowedMentions: { users: [interaction.user.id] } }).catch(() => null);
        if (msg) tribes.setFoundingMessage(interaction.user.id, ch.id, msg.id);
        return interaction.editReply(`🏴 Posted to <#${ch.id}>. Needs **2 more** mods to co-sign before you can continue. Run this command again once they have.`);
      }
      wizardTouch(interaction.user.id, { leaderId: leaderMember.id });
      return safeShowModal(interaction, tribeIdentityModal());
    }
    if (sub === 'register') {
      const key = interaction.options.getString('key').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!key) return interaction.reply({ content: 'Give a valid key (letters/numbers), e.g. `valith`.', flags: MessageFlags.Ephemeral });
      const role = interaction.options.getRole('role');
      const leaderRole = interaction.options.getRole('leader_role');
      const hall = interaction.options.getChannel('hall');
      const t = tribes.register({ key, name: interaction.options.getString('name'), shortName: interaction.options.getString('name'),
        emoji: interaction.options.getString('emoji') || '🏴', color: role.color || 0x2A426A,
        roleId: role.id, leaderRoleId: leaderRole ? leaderRole.id : null, hallId: hall ? hall.id : null });
      return interaction.reply({ content: `## ${t.emoji} ${t.name}: registered\n-# adopted by <@${interaction.user.id}>\n> Role <@&${role.id}>${leaderRole ? ` · Leader <@&${leaderRole.id}>` : ''}${hall ? ` · Hall <#${hall.id}>` : ''}\n-# Now shows in #tribes-hub Standings and \`/tribe info ${key}\`.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'arena') {
      // Any tribe LEADER or an admin may start one (owner, 2026-08-04).
      if (!canWLAdmin(interaction) && !tribes.leaderTribe(interaction.member)) return interaction.reply({ content: 'Only a tribe leader or an admin can launch a challenge.', flags: MessageFlags.Ephemeral });
      { const blocked = arena.startBlocked(); if (blocked) return interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral }); }
      const type = interaction.options.getString('type');
      const minutes = interaction.options.getInteger('minutes') || ARENA_DEFAULTS[type] || 5;
      const announceCh = await ensureTribeAnnounce(interaction.guild, config).catch(() => null);
      await interaction.reply({ content: `🎪 Announced **${ARENA_LABEL[type] || type}** in ${announceCh ? `<#${announceCh.id}>` : 'tribe-announcements'} — it begins in **5 minutes** so everyone can gather, then runs for **${minutes} min**.`, flags: MessageFlags.Ephemeral });
      try { await startArenaCountdown(interaction.guild, type, minutes, interaction.user.id); }
      catch (e) { console.error('[arena] start:', e.message); return interaction.followUp({ content: `Couldn’t launch it: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {}); }
      return;
    }
    if (sub === 'set-leader') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      // A tribe's OWN leader can restructure it; admins can do it for any tribe (owner, 2026-08-04).
      if (!canWLAdmin(interaction) && !tribes.isLeader(interaction.member, t))
        return interaction.reply({ content: `Only **${t.shortName || t.name}**’s ${tribes.leaderTitle(t)} or an admin can set its leaders.`, flags: MessageFlags.Ephemeral });
      if (!t.leaderRoleId) return interaction.reply({ content: `**${t.shortName || t.name}** has no leader role configured, can’t set a leader.`, flags: MessageFlags.Ephemeral });
      const newLeader = interaction.options.getMember('member');
      if (!newLeader) return interaction.reply({ content: 'That member isn’t in the server.', flags: MessageFlags.Ephemeral });
      const replacing = interaction.options.getMember('replacing');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // The new leader must belong to THIS tribe — a leader who isn't a member is the exact broken state this
      // fixes. Add the base tribe role (+ authorize membership) if they aren't already in it, then the leader role.
      if (!newLeader.roles.cache.has(t.roleId)) {
        tribes.setMembership(t.key, newLeader.id, true);
        const ok = await newLeader.roles.add(t.roleId, `Set as ${tribes.leaderTitle(t)} by ${interaction.user.tag}`).then(() => true).catch(() => false);
        if (!ok) { tribes.setMembership(t.key, newLeader.id, false); return interaction.editReply('Couldn’t add them to the tribe (check my role position).'); }
      }
      const addOk = await newLeader.roles.add(t.leaderRoleId, `Set as ${tribes.leaderTitle(t)} by ${interaction.user.tag}`).then(() => true).catch(() => false);
      if (!addOk) return interaction.editReply('Couldn’t grant the leader role (check my role position).');
      await syncStaffRank(interaction.guild, newLeader, t).catch(() => {});   // leader outranks the General staff-rank
      let stepDownNote = '';
      if (replacing && replacing.roles.cache.has(t.leaderRoleId)) {
        const remOk = await replacing.roles.remove(t.leaderRoleId, `Stepped down as ${tribes.leaderTitle(t)} by ${interaction.user.tag}`).then(() => true).catch(() => false);
        stepDownNote = remOk ? ` <@${replacing.id}> stepped down.` : ` (couldn’t remove <@${replacing.id}>’s leader role.)`;
        await syncStaffRank(interaction.guild, replacing, t).catch(() => {});
      }
      // Re-run the requirement sweep immediately so a now-complete tribe clears its shortfall/freeze right away
      // instead of waiting for the hourly tick (owner: "auto-end if you get all of the required members").
      await sweepLeaderRequirement(interaction.guild).catch(() => {});
      const { count } = countModLeaders(interaction.guild, tribes.get(t.key));
      const reqNote = tribes.isModFounded(t) ? ` Now **${count}/${tribes.MIN_MOD_LEADERS}** leaders.` : '';
      await ownerlog.log(interaction.guild, { emoji: '👑', title: 'Tribe leader set', color: 0x5865F2,
        detail: `<@${newLeader.id}> made a ${tribes.leaderTitle(t)} of **${t.shortName || t.name}** by <@${interaction.user.id}>.${stepDownNote}${reqNote}` }).catch(() => {});
      if (t.throneId) { const throne = await interaction.guild.channels.fetch(t.throneId).catch(() => null); if (throne) await throneSend(throne, { content: `## ${t.emoji || '🏴'} New ${tribes.leaderTitle(t)}\n<@${newLeader.id}> now leads **${t.shortName || t.name}**.${stepDownNote}`, allowedMentions: { users: [newLeader.id] } }).catch(() => {}); }
      await refreshThronePanel(interaction.guild, tribes.get(t.key)).catch(() => {});
      return interaction.editReply(`👑 <@${newLeader.id}> is now a ${tribes.leaderTitle(t)} of **${t.shortName || t.name}**.${stepDownNote}${reqNote}`);
    }
    if (sub === 'points') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      const nm = interaction.options.getString('name').slice(0, 20);
      tribes.update(t.key, { pointsName: nm });
      return interaction.reply({ content: `${t.emoji || '🏴'} **${t.shortName || t.name}** now calls its activity points **${nm}**. Shows on \`/tribe leaderboard\`.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'title') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      const nm = interaction.options.getString('name').slice(0, 40);
      tribes.update(t.key, { leaderTitle: nm });
      return interaction.reply({ content: `${t.emoji || '🏴'} **${t.shortName || t.name}** now calls its head **${nm}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'staffrank-set') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      const nm = interaction.options.getString('name').slice(0, 40);
      tribes.update(t.key, { staffRankTitle: nm });
      // A custom title drops the tribe-name prefix (that prefix only exists to disambiguate the DEFAULT
      // "General" across tribes; a chosen name stands on its own) and renders in the server's small-caps font.
      if (t.staffRankRoleId) { const role = interaction.guild.roles.cache.get(t.staffRankRoleId); if (role) await role.setName(`${t.emoji || '🏴'} ${toSmallCaps(nm)}`, 'tribe staff-rank rename').catch(() => {}); }
      return interaction.reply({ content: `${t.emoji || '🏴'} **${t.shortName || t.name}** now calls its staff rank **${nm}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'ranks') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t || !(t.ranks || []).length) return interaction.reply({ content: 'That tribe has no ranks set up.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      tribes.setRankNames(t.key, [1, 2, 3, 4].map(n => interaction.options.getString('rank' + n)));
      const fresh = tribes.get(t.key);
      for (const r of fresh.ranks) {   // rename the actual Discord rank roles to match
        if (!r.roleId) continue;
        const role = interaction.guild.roles.cache.get(r.roleId);
        const want = `${fresh.emoji || '🏴'} ${toSmallCaps(r.name)}`;   // render in the server's small-caps font
        if (role && role.name !== want) await role.setName(want, 'tribe rank rename').catch(() => {});
      }
      return interaction.editReply(`✅ Renamed **${fresh.shortName || fresh.name}** ranks: ${fresh.ranks.map(r => r.name).join(' → ')}.`);
    }
    if (sub === 'grant') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      const meter = interaction.options.getString('meter');
      const amount = interaction.options.getInteger('amount');
      const newVal = meter === 'treasury' ? tribes.addTreasury(t.key, amount) : tribes.addGlory(t.key, amount);
      return interaction.reply({ content: `${t.emoji || '🏴'} **${t.shortName || t.name}** ${meter} ${amount >= 0 ? '+' : ''}${amount} → now **${newVal}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'gate-set') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      const prompt = interaction.options.getString('prompt').slice(0, 200);
      const optionA = interaction.options.getString('option_a').slice(0, 80);
      const optionB = interaction.options.getString('option_b').slice(0, 80);
      const correct = interaction.options.getString('correct');
      tribes.setEntranceGate(t.key, { prompt, optionA, optionB, correct });
      return interaction.reply({ content: `${t.emoji || '🏴'} **${t.shortName || t.name}** now gates self-joins:\n> ${prompt}\n> **${optionA}** vs **${optionB}** — correct: **${correct === 'a' ? optionA : optionB}**`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'gate-clear') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      tribes.clearEntranceGate(t.key);
      return interaction.reply({ content: `${t.emoji || '🏴'} **${t.shortName || t.name}** no longer gates self-joins.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }
  if (name === 'roleselect-role') {
    if (!isOwner(interaction)) return interaction.reply({ content: 'Only owners can manage #roles.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const section = interaction.options.getString('section');
    const role = interaction.options.getRole('role');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = sub === 'add'
        ? roleselect.addRoleToSection(section, interaction.options.getString('label') || role.name, role.id)
        : roleselect.removeRoleFromSection(section, role.id);
      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      await roleselect.rebuildFromIndex(interaction.guild, config.rolesChannelId, roleselect.SECTION_BLOCK_INDEX[section]);
      return interaction.editReply(`✅ ${sub === 'add' ? 'Added' : 'Removed'} <@&${role.id}> ${sub === 'add' ? 'to' : 'from'} **${roleselect.SECTION_TITLE[section]}**. #roles updated.`);
    } catch (e) { console.error(`[roleselect-role] ${e.message}`); return interaction.editReply(`Failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'request-role-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try { const { channel, created } = await rolereq.setup(interaction.guild, config); return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. Members use \`/request-role\`.`); }
    catch (e) { console.error(`[rolereq] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'request-role') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can request a role.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const removing = interaction.options.getBoolean('remove') || false;
      const r = await rolereq.submit(interaction.guild, interaction.member, interaction.options.getRole('role'), config, removing);
      return interaction.editReply(r.ok ? `✅ Requested ${removing ? 'to give up' : ''} **${r.role}**. Staff will review it.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[rolereq] ${e.message}`); return interaction.editReply('Could not send that request.').catch(() => {}); }
  }
  if (name === 'appeal-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { channel, created } = await appeals.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. Friends of a banned member appeal with \`/appeal ban <username>\`. It opens a private thread; staff Approve (unbans) or Deny.`);
    } catch (e) { console.error(`[appeals] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'appeal-strike-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { channel, created } = await strikeAppeals.setup(interaction.guild);
      return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. A struck member appeals their own strike with \`/appeal strike <strike>\`. It opens a private thread; staff Approve (removes it) or Deny.`);
    } catch (e) { console.error(`[strikeAppeals] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'appeal') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can open an appeal.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'ban') {
      try {
        const r = await appeals.submit(interaction.guild, interaction.member, interaction.options.getString('username'), interaction.options.getString('note'));
        return interaction.editReply(r.ok
          ? (r.joined ? `🤝 Added you to the open appeal for **${r.name}** → <#${r.threadId}>.` : `✅ Opened an appeal for **${r.name}** → <#${r.threadId}>. Make the case there; up to 5 friends can join. Staff will decide.`)
          : `❌ ${r.msg}`);
      } catch (e) { console.error(`[appeals] ${e.message}`); return interaction.editReply('Could not open that appeal.').catch(() => {}); }
    }
    try {
      const r = await strikeAppeals.submit(interaction.guild, interaction.member, state, interaction.options.getString('strike_id'), interaction.options.getString('note'));
      return interaction.editReply(r.ok ? `✅ Opened your strike appeal → <#${r.threadId}>. Explain your side there. Staff will decide.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[strikeAppeals] ${e.message}`); return interaction.editReply('Could not open that appeal.').catch(() => {}); }
  }
  if (name === 'report-setup' || name === 'modmail-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const mod = name === 'report-setup' ? reports : modmail;
      const { channel, created } = await mod.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>.`);
    } catch (e) { console.error(`[${name}] ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'report') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await reports.submit(interaction.guild, interaction.member, interaction.options.getUser('user'), interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Sent **Report #${r.num}** to staff anonymously.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[reports] ${e.message}`); return interaction.editReply('Could not send that report.').catch(() => {}); }
  }
  if (name === 'modmail') {
    if (config.verifiedRoleId && !interaction.member?.roles?.cache?.has(config.verifiedRoleId))
      return interaction.reply({ content: 'You need to be verified before you can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await modmail.submit(interaction.guild, interaction.member, interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Sent **Modmail #${r.num}** to the mod team anonymously.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[modmail] ${e.message}`); return interaction.editReply('Could not send that.').catch(() => {}); }
  }
  if (name === 'watchlist-terms') {
    if (!canBan(interaction)) return interaction.reply({ content: copy.guards.staffOnly, flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const scope = interaction.options.getString('scope');
    if (sub === 'list') {
      const s = watchlist.loadTerms(), l = watchlist.loadLoose(), w = watchlist.loadWelfare();
      const parts = [];
      if (!scope || scope === 'strict') parts.push(`**Strict (${s.length} + all ${l.length} loose)** → watchlisted members, ban alerts:\n${s.map(t => `\`${t}\``).join(' · ') || '_(only the loose terms)_'}`);
      if (!scope || scope === 'loose') parts.push(`**Loose (${l.length})** → #watch-log:\n${l.map(t => `\`${t}\``).join(' · ') || '_none_'}`);
      if (!scope || scope === 'welfare') parts.push(`**Welfare (${w.length})** → #watch-log check-in:\n${w.map(t => `\`${t}\``).join(' · ') || '_none_'}`);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: parts.join('\n\n').slice(0, 1900) });
    }
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can edit the terms.', flags: MessageFlags.Ephemeral });
    const term = interaction.options.getString('term');
    const which = scope || 'strict';
    const adder = { strict: watchlist.addTerm, loose: watchlist.addLoose, welfare: watchlist.addWelfare }[which];
    const remover = { strict: watchlist.removeTerm, loose: watchlist.removeLoose, welfare: watchlist.removeWelfare }[which];
    if (sub === 'add') { const t = adder(term); return interaction.reply({ content: `➕ Added ${which} term \`${term}\`. ${t.length} ${which} term(s) now.`, flags: MessageFlags.Ephemeral }); }
    if (sub === 'remove') { const t = remover(term); return interaction.reply({ content: `➖ Removed ${which} term \`${term}\`. ${t.length} left.`, flags: MessageFlags.Ephemeral }); }
    return;
  }
  if (name !== 'corner' && name !== 'uncorner') return;
  try {
    // Access is tied to the MOD ROLE (not a permission). Admins can always use it as an override. Trial
    // mods may ALSO corner — but only regular members (the tier check below stops them cornering staff)
    // and under restrictions (rule + reason required, ≤1h), enforced in the corner block.
    const trial = isTrialMod(interaction);
    const isMod = !!opspanel.tierOf(interaction);   // any staff tier (mod/admin/owner incl Admin-perm/bot owner)
    if (!isMod && !trial) return interaction.reply({ content: 'Only staff (mods+ or trial mods) can use this.', flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const user = interaction.options.getUser('user');
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member is not in the server.', flags: MessageFlags.Ephemeral });
    if (member.id === client.user.id) return interaction.reply({ content: 'I cannot corner myself.', flags: MessageFlags.Ephemeral });

    if (name === 'corner') {
      // Self-cornering is blocked for everyone EXCEPT this one member (owner-approved standing exception,
      // 2026-08-03: "white korean baddie" / beautyinelijah). She picks her own duration like anyone else
      // would; nothing here changes /uncorner, so only staff can still release her early — this exemption is
      // scoped to the corner path only, not the shared corner/uncorner self-target logic above.
      const SELF_CORNER_EXEMPT_ID = '1415112053823242250';
      if (member.id === interaction.user.id && member.id !== SELF_CORNER_EXEMPT_ID) {
        return interaction.reply({ content: 'You can’t corner yourself.', flags: MessageFlags.Ephemeral });
      }
      // Tier hierarchy: you may corner your OWN staff tier or LOWER — never a higher tier. So equal
      // tiers can corner each other (mod↔mod, admin↔admin), staff can corner regular members, but a mod
      // can't corner an admin. Ranks: owner > admin > mod > member. The guild owner is never cornerable
      // (and OWNER⚜️ sits above the bot's role, so the bot couldn't strip it regardless).
      const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
      const actorRank = RANK[opspanel.tierOf(interaction)] || 0;      // actor's tier (admin if Administrator-perm)
      const targetTier = opspanel.memberTier(member);                 // target's role-only tier
      const targetRank = RANK[targetTier] || 0;
      if (member.id === guild.ownerId) {
        return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
      }
      if (targetRank > actorRank) {
        return interaction.reply({ content: `You can’t corner someone of a higher staff tier than you (they’re **${targetTier}**).`, flags: MessageFlags.Ephemeral });
      }
      const durStr = interaction.options.getString('duration');
      let durationMs = null;
      if (durStr) {
        durationMs = corner.parseDuration(durStr);
        if (!durationMs) return interaction.reply({ content: copy.corner.badDuration, flags: MessageFlags.Ephemeral });
      }
      // Reason: a picked rule and/or a custom typed reason. Show both when present.
      const ruleN = interaction.options.getString('rule');
      const customReason = interaction.options.getString('reason');
      const reasonText = [ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}` : null, customReason].filter(Boolean).join(', ') || null;
      // Trial-mod restrictions: must give a rule OR a reason (same "not both required" convention as
      // /strike elsewhere), and the corner can't exceed 1 hour.
      if (trial) {
        if (!ruleN && !customReason) return interaction.reply({ content: 'As a **trial mod**, you must pick a **rule** or give a **reason** to corner someone.', flags: MessageFlags.Ephemeral });
        if (!durationMs) return interaction.reply({ content: 'As a **trial mod**, you must set a **duration**, max **1 hour** (e.g. `30m`, `1h`).', flags: MessageFlags.Ephemeral });
        if (durationMs > 3600000) return interaction.reply({ content: 'As a **trial mod**, a corner can be **at most 1 hour**.', flags: MessageFlags.Ephemeral });
      }
      // Multi-corner: `also` lists extra members (mentions or IDs) → corner the whole set at once.
      const alsoStr = interaction.options.getString('also');
      if (alsoStr && alsoStr.trim()) {
        await interaction.deferReply({ flags: interaction.channelId === config.cornerChannelId ? MessageFlags.Ephemeral : undefined });
        const ids = [...new Set(alsoStr.match(/\d{15,}/g) || [])].filter(id => id !== member.id);
        const extras = [];
        for (const id of ids) { const m = await guild.members.fetch(id).catch(() => null); if (m) extras.push(m); }
        const unknown = ids.filter(id => !extras.some(m => m.id === id));
        const { done, skipped, whenPhrase } = await cornerMany(guild, interaction.user.id, actorRank, [member, ...extras], durationMs, { ruleN, reasonText });
        const lines = [];
        if (done.length) lines.push(`⛓️ Cornered **${done.length}** ${whenPhrase}: ${done.map(id => `<@${id}>`).join(', ')}${reasonText ? ` (${reasonText})` : ''}`);
        if (skipped.length) lines.push(`⚠️ Skipped: ${skipped.join(', ')}`);
        if (unknown.length) lines.push(`❓ Not found: ${unknown.map(id => `\`${id}\``).join(', ')}`);
        return interaction.editReply({ content: lines.join('\n') || 'Nobody to corner.', allowedMentions: { parse: [] } });
      }
      // Hide the mod ack if the command is run IN the corner channel (the themed embed already posts there).
      const inCorner = interaction.channelId === config.cornerChannelId;
      await interaction.deferReply({ flags: inCorner ? MessageFlags.Ephemeral : undefined });
      const r = await corner.corner(guild, member, durationMs, state, interaction.user.id, ruleN);
      if (!r.ok) return interaction.editReply(`Failed to corner: ${r.error}`);
      await maybeAlertCornerRepeat(guild, member, ruleN, r.repeatCount);
      const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
      const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
      // Announce in the corner channel so the cornered member sees it there.
      try {
        const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
        if (cornerCh) await cornerCh.send(cornerSentMessage(user.id, whenPhrase, reasonText, interaction.user.id));
      } catch (e) { console.error(`[corner] channel announce failed: ${e.message}`); }
      const modWhen = relSec ? `until <t:${relSec}:f>` : 'indefinitely (until manually released)';
      await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER', color: CORNER_RED,
        desc: `<@${user.id}> was cornered ${relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**'}.\n**By:** <@${interaction.user.id}>${reasonText ? `\n**Reason:** ${reasonText}` : ''}` });
      return interaction.editReply(`🚫 Sent ${user} to the corner ${modWhen}${reasonText ? ` (${reasonText})` : ''}. Stripped **${r.stripped}** role(s).`);
    } else {
      const inCorner = interaction.channelId === config.cornerChannelId;
      const durStr = interaction.options.getString('duration');
      let durationMs = null;
      if (durStr) {
        durationMs = corner.parseDuration(durStr);
        if (!durationMs) return interaction.reply({ content: copy.corner.badDuration, flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: inCorner ? MessageFlags.Ephemeral : undefined });
      if (durationMs) {
        // Schedule a future release (e.g. give an indefinitely-cornered member a release time). The
        // auto-release loop frees them + posts the "time served" embed when it expires.
        const rec = state.getCornered(user.id);
        if (!rec) return interaction.editReply(`${user} is not in the corner.`);
        const releaseAt = Date.now() + durationMs;
        state.setCornered(user.id, { ...rec, releaseAt });
        await logCorner(guild, { emoji: '⏳', title: 'RELEASE SCHEDULED', color: CORNER_AMBER,
          desc: `<@${user.id}>'s release was scheduled.\n**Release:** ${relPhrase(releaseAt)}\n**By:** <@${interaction.user.id}>` });
        return interaction.editReply(`⏳ Scheduled ${user}'s release <t:${Math.floor(releaseAt / 1000)}:R> (at <t:${Math.floor(releaseAt / 1000)}:f>). The corner will release them automatically.`);
      }
      const r = await corner.uncorner(guild, user.id, state);
      if (!r.ok) return interaction.editReply(`Failed to release: ${r.error}`);
      const served = servedSuffix(r.servedMs);
      try {
        const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
        if (cornerCh) await cornerCh.send(cornerReleasedMessage(user.id));
      } catch (e) { console.error(`[corner] channel announce failed: ${e.message}`); }
      await logCorner(guild, { emoji: '🔓', title: 'RELEASED', color: CORNER_GREEN,
        desc: `<@${user.id}> was released: roles restored.\n**By:** <@${interaction.user.id}>${served}${missedRolesNote(r.missed)}` });
      return interaction.editReply(`✅ Released ${user} from the corner. Restored **${r.restored}** role(s)${r.missed && r.missed.length ? ` · ⚠️ ${r.missed.length} couldn't be restored (see log)` : ''}${served}.`);
    }
  } catch (err) {
    console.error(`[corner] command error: ${err.message}`);
    const msg = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

// TEMP diagnostic (2026-08-04): log when the event loop is blocked > 300ms — this is what would make an
// interaction hang on "Sending command…". A timer scheduled for +1000ms that fires much later means something
// ran synchronously and starved the loop; the lag size + timestamp lets us correlate it to a cause.
let _elpTick = Date.now();
setInterval(() => { const now = Date.now(); const lag = now - _elpTick - 1000; if (lag > 300) console.error(`[eventloop] blocked ${lag}ms`); _elpTick = now; }, 1000);
client.on('error', err => console.error(`[client] ${err.message}\n${err.stack || ''}`));
client.on('shardError', err => console.error(`[shard] ${err.message}\n${err.stack || ''}`));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

client.login(config.token);
