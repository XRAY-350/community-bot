// index.js — entry point. Boots the discord.js client, resolves the verify + alert channels
// once at ready, and wires the verify trigger (role → close) and the periodic sweep (nudge + stale).
//
// Intents: Guilds (channels/threads) + GuildMembers (PRIVILEGED — required to receive
// guildMemberUpdate so we can see the Verified role being assigned). The GuildMembers intent
// must also be enabled in the Discord Developer Portal for this application.

const { Client, GatewayIntentBits, Partials, PermissionsBitField, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContextMenuCommandBuilder, ApplicationCommandType, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, AuditLogEvent, ChannelType, MessageType, AttachmentBuilder, Options } = require('discord.js');
const { statePath } = require('./statepath');
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
const overridesManager = require('./overridesManager');

function effectiveTierOf(interaction, targetMember = null) {
  // Being cornered suspends ALL active authority — role-based tier (opspanel.tierOf already accounts for
  // this) AND a GRANT_POWER override, which doesn't depend on role/tier at all and would otherwise still
  // apply to a jailed actor. Checked here directly (not just via a null rawTier below) because rawTier is
  // ALSO null for a regular non-staff member who legitimately holds a grant — that case must still work.
  if (state.getCornered(interaction?.user?.id)) return null;
  const actor = interaction?.member || interaction?.user?.id;
  const rawTier = opspanel.tierOf(interaction);
  const granted = overridesManager.getGrantedPower(actor, targetMember, rawTier);
  return granted || rawTier;
}
const watchlist = require('./watchlist');
const wordfilter = require('./wordfilter');
const mediafilter = require('./mediafilter');
const amongus = require('./amongus');
const tribes = require('./tribes');
const pubdash = require('./pubdash');
const suggest = require('./suggest');
const suggestions = require('./suggestions');
const confessions = require('./confessions');
const whistleblow = require('./whistleblow');
const reports = require('./reports');
const modmail = require('./modmail');
const sidebar = require('./sidebar');
const mafia = require('./mafia');
const botdeletes = require('./botdeletes');
const modapps = require('./modapps');
const eventorgapps = require('./eventorgapps');
const hitsquad = require('./hitsquad');
const langmods = require('./langmods');
const promote = require('./promote');
const nestedRoles = require('./nestedRoles');
const ownerlog = require('./ownerlog');
const permguard = require('./permguard');
const raidguard = require('./raidguard');
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
const quests = require('./quests');
const sealed = require('./sealed');
const eventPacing = require('./eventPacing');
const tribegames = require('./tribegames');
const tally = require('./tally');
const birthday = require('./birthday');
const awards = require('./awards');
const proving = require('./proving');
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
const TRIBE_BANNER_DIR = process.env.FUBU_TRIBE_BANNER_DIR || statePath('tribe_banners');
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
  add(config.verifiedRoleId, config.unverifiedRoleId, config.cornerRoleId, config.adultCornerRoleId, config.trialModRoleId, config.mdniRoleId, config.langMiniModRoleId, config.minorAgeRoleId);
  (config.adultAgeRoleIds || []).forEach(add);
  (config.strikeRoleIds || []).forEach(add);
  (config.identifyingRoleIds || []).forEach(add);
  // age/colors are now part of loadSections() too (see roleselect.js), so this one pass covers them.
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
// A member-founded tribe stays MEMBER-ONLY (owner ruling): mods/admins/owners can't join it — they'd get the
// "General" staff rank and overshadow the regular-member co-leaders. Trial mods (and mini-mods/event
// organizers — the 'staff' floor tier) are fine, same as they can cosign/co-lead. This is the one gate that
// keeps a member-led tribe actually member-led. Was a bare `!!memberTier(member)` before 'staff' existed as
// a real (truthy) tierOf() value — that would now wrongly block trial-tier members too.
function staffBlockedFromMemberTribe(member, tribe) { return tribes.isMemberFounded(tribe) && opspanel.meets(opspanel.memberTier(member), 'mod'); }
async function joinTribeSelfServe(guild, tribe, member, reason = 'First tribe — self-join via #roles') {
  if (staffBlockedFromMemberTribe(member, tribe)) return { ok: false, content: `**${tribe.shortName || tribe.name}** is a member-founded tribe — it stays member-only, so mods/admins/owners can’t join it.` };
  tribes.setMembership(tribe.key, member.id, true);   // authorize first so the guard honors the join
  const ok = await member.roles.add(tribe.roleId, reason).then(() => true).catch(() => false);
  if (!ok) { tribes.setMembership(tribe.key, member.id, false); return { ok: false }; }
  await syncStaffRank(guild, member, tribe);
  // Path-mode tribes have no rank at all until a path is chosen (earnedRankIndex returns -1 without one) —
  // no join flow ever assigned one, so a brand-new member just sat unranked until they found Choose Your
  // Path themselves. Default to Collective (owner's call) so they're never rankless, and immediately apply
  // whatever they've already earned (rank 0, day one) instead of waiting for the next activity tick.
  if (tribes.isPathMode(tribe) && !tribes.memberPath(tribe.key, member.id)) tribes.setMemberPath(tribe.key, member.id, 'path2');
  await maybePromoteTribeRank(guild, tribe.key, member).catch(() => {});
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
      tribes.addTides(tribe.key, p.recruiterId, recruitment.RECRUITER_TIDES, 'collective');
      tribes.addTreasury(tribe.key, recruitment.RECRUITER_TREASURY);
      const hall = tribe.hallId && await guild.channels.fetch(tribe.hallId).catch(() => null);
      if (hall) await hall.send({ content: `🎉 <@${p.recruiterId}> recruited <@${p.inviteeId}> into **${tribe.shortName || tribe.name}**, and they stuck around! +${recruitment.RECRUITER_TIDES} ${tribe.pointsName || 'points'} for the recruiter, +${recruitment.RECRUITER_TREASURY} treasury for the tribe.`, allowedMentions: { users: [p.recruiterId] } }).catch(() => {});
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
  if (staffBlockedFromMemberTribe(member, winnerTribe)) return;   // a member-only tribe doesn't capture staff into itself
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
  if (staffBlockedFromMemberTribe(member, tribe)) return { ok: false, content: `**${tribe.shortName || tribe.name}** is a member-founded tribe — it stays member-only, so mods/admins/owners can’t join it.` };
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
  const other = tribes.inAnyTribe(target);
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
// Apply a role-icon change to a tribe's WHOLE role set (base + leader + General + every rank), so the icon
// stays matched across all of them the same way a retheme's colours do (owner: updating the icon must hit the
// leader role too, not only the base role). iconPatch = { unicodeEmoji, icon } (a role can hold one or the
// other, so each path nulls the one it isn't setting). Returns { done, failed }.
async function applyIconToTribeRoles(guild, tribe, iconPatch, reason) {
  const rankRoleObjs = (tribe.ranks || []).map(x => guild.roles.cache.get(x.roleId)).filter(Boolean);
  const roles = [
    guild.roles.cache.get(tribe.roleId),
    tribe.leaderRoleId && guild.roles.cache.get(tribe.leaderRoleId),
    tribe.staffRankRoleId && guild.roles.cache.get(tribe.staffRankRoleId),
    ...rankRoleObjs,
  ].filter(Boolean);
  let done = 0, failed = 0;
  for (const r of roles) {
    const ok = await r.edit(iconPatch, reason).then(() => true).catch(e => { console.error('[tribe icon]', r.id, e.message); return false; });
    if (ok) done++; else failed++;
  }
  return { done, failed };
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
  // NOTE: role positions are set in ONE atomic bulk reorder AFTER all roles exist (see below). Per-role
  // setPosition() races itself across the ~7 roles + silently no-ops, so new tribes' roles all piled up at the
  // bottom instead of slotting into the cluster (owner report 2026-08-06).
  const leaderRole = await guild.roles.create({ name: `${opts.shortName || opts.name} Leader`, colors: roleColors, mentionable: false, reason: `Tribe leader: ${opts.name}` })
    .catch(() => guild.roles.create({ name: `${opts.shortName || opts.name} Leader`, color: opts.color, mentionable: false, reason: `Tribe leader: ${opts.name}` }).catch(() => null));
  if (leaderRole && opts.leaderMember) await opts.leaderMember.roles.add(leaderRole.id, 'Tribe leader').catch(() => {});
  // "General" — any staff (mod/admin) who joins as a regular member sits above the whole rank ladder
  // automatically (owner, 2026-08-03). Sits just below the leader role in the hierarchy.
  const staffRankRole = await guild.roles.create({ name: `${emoji} ${rankLabel(`${opts.shortName || opts.name} ${tribes.DEFAULT_STAFF_RANK_TITLE}`)}`, colors: roleColors, mentionable: false, reason: `Tribe staff rank: ${opts.name}` })
    .catch(() => guild.roles.create({ name: `${emoji} ${rankLabel(`${opts.shortName || opts.name} ${tribes.DEFAULT_STAFF_RANK_TITLE}`)}`, color: opts.color, mentionable: false, reason: `Tribe staff rank: ${opts.name}` }).catch(() => null));
  const deny = [config.cornerRoleId, config.adultCornerRoleId].filter(Boolean).map(id => ({ id, deny: [P.ViewChannel] }));
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
    ...(leaderRole ? [{ id: leaderRole.id, allow: [P.ViewChannel, P.SendMessages, P.ManageMessages, P.MentionEveryone] }] : []),
    ...staffAllow([P.ViewChannel, P.SendMessages, P.ManageMessages]), ...deny] });
  const hall = await guild.channels.create({ name: chName(chNames.hall || 'hall'), type: ChannelType.GuildText, parent: cat.id, topic: chTopics.hall || undefined, permissionOverwrites: [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: role.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AddReactions, P.EmbedLinks, P.AttachFiles, P.UseExternalEmojis, P.UseExternalStickers, P.MentionEveryone] },
    ...(leaderRole ? [{ id: leaderRole.id, allow: [P.ViewChannel, P.SendMessages, P.ManageMessages, P.MentionEveryone] }] : []),
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
    rankRoles.push({ ...r, roleId: rr ? rr.id : null });   // rank roles stay at the bottom (default create position)
  }
  // ONE atomic bulk reorder now that every role exists — slot the base role into the tribe-role cluster and the
  // leader + General roles into the leader-role cluster (positions recomputed fresh, since creating the ~7 new
  // roles shifted everything). Rank roles are left where created (bottom). Replaces the old per-role setPosition
  // calls that raced + silently no-op'd, leaving new tribes' roles piled at the bottom (owner report 2026-08-06).
  try {
    await guild.roles.fetch();
    const others = tribes.all();   // existing tribes only — the new one isn't registered yet
    const posOf = id => guild.roles.cache.get(id)?.position;
    const minPos = arr => { const v = arr.filter(p => p != null); return v.length ? Math.min(...v) : null; };
    const maxPos = arr => { const v = arr.filter(p => p != null); return v.length ? Math.max(...v) : null; };
    const positions = [];
    // base -> bottom of the tribe-role cluster; leader/General -> bottom of THEIR OWN clusters (staffRank has its
    // own cluster, distinct from leader). Each computed separately so nothing lands above the existing tribes.
    const bp = minPos(others.map(t => posOf(t.roleId)));
    const lp = minPos(others.map(t => t.leaderRoleId ? posOf(t.leaderRoleId) : null));
    const sp = minPos(others.map(t => t.staffRankRoleId ? posOf(t.staffRankRoleId) : null));
    if (bp != null) positions.push({ id: role.id, position: bp });
    if (lp != null && leaderRole) positions.push({ id: leaderRole.id, position: lp });
    if (sp != null && staffRankRole) positions.push({ id: staffRankRole.id, position: sp });
    // Only the TOP rank (rank 4 / last in the ladder) is slotted up into its cluster — it sits ABOVE the base
    // member role so top-rank members outrank regulars. Ranks 1-3 stay at the very bottom as low cosmetic tags
    // (owner ruling 2026-08-06: "keep them all at the bottom except rank 4"). Max = top of that rank's cluster.
    const topIdx = rankRoles.length - 1;
    const top = rankRoles[topIdx];
    if (top && top.roleId) {
      const t3 = maxPos(others.map(t => (t.ranks && t.ranks[topIdx]) ? posOf(t.ranks[topIdx].roleId) : null));
      if (t3 != null) positions.push({ id: top.roleId, position: t3 });
    }
    // Raw bulk endpoint (PATCH /guilds/{id}/roles) — reliable; discord.js's roles.setPositions() mis-resolved
    // multi-role moves and put a new tribe's leader ABOVE the whole cluster (owner report 2026-08-06).
    if (positions.length) await guild.client.rest.patch(`/guilds/${guild.id}/roles`, { body: positions });
  } catch (e) { console.error('[tribe role-position]', e.message); }
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
  lore.record({ type: 'founding', title: `${tribe.shortName || tribe.name} was founded`, tribes: [tribe.key] });
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
  // Path-mode tribes have 3 separate 4-rank ladders, not one — concatenating all 12 in a line reads as
  // meaningless noise. Point to the pinned Paths & Attributes reference instead of trying to cram it here.
  const ranks = tribes.isPathMode(tribe)
    ? `pick a path, see the pinned 📖 Paths & Attributes reference below for all three ladders`
    : ((tribe.ranks || []).map(r => r.name).join(' → ') || 'ranks not set up yet');
  const k = tribe.key;
  const ally = tribes.getAlly(tribe.key);
  const onCooldown = tribes.onOutboundCooldown(tribe);   // "can we start a war" = the outbound cooldown
  const content = `## ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}: what you can do\n`
    + (tribe.motto ? `-# *${tribe.motto}*\n` : '')
    + `\n**Earn ${pts}:** chat in the hall, +1 per message, once a minute. Climb the ranks: ${ranks}. Ranks only ever go up.\n`
    + `-# Staff who join as members automatically hold **${tribes.staffRankTitle(tribe)}**, above the whole ladder.\n`
    + `\n${ally ? `**Allied with ${ally.emoji || '🏴'} ${ally.shortName || ally.name}**: mutual defense in wars, treasury can be gifted between you.` : '_No current alliance._'}`
    + (onCooldown ? `\n-# ⚔️ On attack cooldown until <t:${Math.floor(tribes.outboundCooldownEndsAt(tribe) / 1000)}:R> (you can still be attacked / defend).` : '')
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
    new ButtonBuilder().setCustomId(`tribethrone_allygift:${k}`).setEmoji('🎁').setLabel('Gift Treasury to Ally').setStyle(ButtonStyle.Secondary).setDisabled(!ally),
    new ButtonBuilder().setCustomId(`tribethrone_clearthrone:${k}`).setEmoji('🧹').setLabel('Clear Throne').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_disband:${k}`).setEmoji('💥').setLabel('Disband').setStyle(ButtonStyle.Danger));
  // Recognition + depth row (member-facing) — each button gated by its own feature flag. Discord caps a message
  // at 5 rows and a row at 5 buttons; Trophies, Hall of Fame, Quests, Relics, Prestige is exactly 5 when all on.
  const rows = [memberRow, leaderRow1, leaderRow2, leaderRow3];
  const recog = [];
  if (features.enabled('achievements')) recog.push(
    new ButtonBuilder().setCustomId(`tribethrone_trophies:${k}`).setEmoji('🏅').setLabel('Trophies').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tribethrone_halloffame:${k}`).setEmoji('🏛️').setLabel('Hall of Fame').setStyle(ButtonStyle.Secondary));
  if (features.enabled('tribeQuests')) recog.push(new ButtonBuilder().setCustomId(`tribethrone_quests:${k}`).setEmoji('🎯').setLabel('Quests').setStyle(ButtonStyle.Secondary));
  if (features.enabled('relics')) recog.push(new ButtonBuilder().setCustomId(`tribethrone_relics:${k}`).setEmoji('🏺').setLabel('Relics').setStyle(ButtonStyle.Secondary));
  if (features.enabled('prestige')) recog.push(new ButtonBuilder().setCustomId(`tribethrone_prestige:${k}`).setEmoji('⭐').setLabel('Prestige').setStyle(ButtonStyle.Secondary));
  if (recog.length) rows.push(new ActionRowBuilder().addComponents(recog.slice(0, 5)));
  return { content, components: rows, allowedMentions: { parse: [] } };
}
// Permanent reference for path-mode tribes — pinned (so it survives the throne's 24h message expiry) rather
// than relying on the one-off announcement, which a member could easily miss or scroll past. Explains what
// an attribute actually DOES (personal points bonus + the tribe-wide war/event bonus it compiles into) once,
// in one place, instead of scattering that explanation across every place attributes show up.
function tribePathsReference(tribe) {
  const loreData = tribe.lore;
  if (!loreData || !tribes.isPathMode(tribe)) return null;
  const lines = [`# 📖 ${loreData.title}: Paths & Attributes`];
  if (tribe.presentingAttribute) lines.push(`-# ${tribe.shortName || tribe.name}'s presenting attribute (how it relates to other tribes: alliances, war rivalry): **${tribe.presentingAttribute}**`);
  lines.push(
    '',
    '**What an attribute does:** picking a path and ranking up in it grows your OWN personal point bonus on matching activity. ' +
    'Everyone currently on a path also compiles into the TRIBE\'s power in that category — a stronger, more-ranked-up combat path means real bonuses in War; social and collective the same for whichever Arena modes, Sealed Arena, Trial, and Tribe Games fit that category.',
    `-# Haven't picked? You default to **Collective** until you choose otherwise, use ${'`/tribe panel`'} → Choose Your Path to switch.`,
    '',
  );
  tribes.PATH_SLOTS.forEach((pathKey, i) => {
    const ranks = tribe.ranks.filter(r => r.pathKey === pathKey).map(r => r.name).join(' → ');
    const category = tribes.PATH_CATEGORY[pathKey];
    lines.push(`**${loreData.pathNames[i]}**: *${loreData.attributeNames[i]}* (${category})\n${ranks}`);
  });
  return { content: lines.join('\n').slice(0, 3900), allowedMentions: { parse: [] } };
}
// Post/refresh the lore & paths reference in a tribe's throne — EDIT in place, not resend, same pattern as
// refreshThronePanel. BUG FIXED 2026-08-17: postThroneGuide used to unconditionally `throne.send()` a new
// copy of this every time it ran (tribe creation, AND the boot self-heal below whenever the pinned panel
// went briefly unfetchable) — since the message's id was never persisted anywhere, there was no way to find
// the old one to edit or remove it, so every repost left the previous lore message stranded, still pinned,
// just going stale. Now tracked via tribe.loreMessageId, with a pin-content-signature backfill (the ": Paths
// & Attributes" suffix every lore title shares) for tribes whose old stray copies predate this fix.
async function ensureLoreReference(guild, throne, tribe) {
  const refPayload = tribePathsReference(tribe);
  if (!refPayload) return null;
  let msg = tribe.loreMessageId ? await throne.messages.fetch(tribe.loreMessageId).catch(() => null) : null;
  if (!msg) {
    const pins = await throne.messages.fetchPins().catch(() => null);
    msg = pins && pins.items.map(p => p.message).find(m => m.content.includes(': Paths & Attributes'));
  }
  if (msg) {
    if (tribe.loreMessageId !== msg.id) tribes.update(tribe.key, { loreMessageId: msg.id });
    await msg.edit(refPayload).catch(() => {});
    return msg;
  }
  const refMsg = await throne.send(refPayload).catch(() => null);
  if (refMsg) { await refMsg.pin().catch(() => {}); tribes.update(tribe.key, { loreMessageId: refMsg.id }); }
  return refMsg;
}
// Post + pin the panel in a tribe's throne. Best-effort (missing throne, send failure, or a pin failure —
// e.g. the channel already has 50 pins — all fail silently rather than blocking tribe creation on it).
async function postThroneGuide(guild, tribe) {
  if (!tribe.throneId) return null;
  const throne = await guild.channels.fetch(tribe.throneId).catch(() => null);
  if (!throne) return null;
  const msg = await throne.send(tribeThronePanel(tribe)).catch(() => null);
  if (msg) { await msg.pin().catch(() => {}); tribes.update(tribe.key, { panelMessageId: msg.id }); }
  await ensureLoreReference(guild, throne, tribe);
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
  if (tribe.panelMessageId !== msg.id) tribes.update(tribe.key, { panelMessageId: msg.id });   // backfill for tribes created before we persisted it
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
  const desc = `**The server's tribe system:** member factions, each with its own territory, roles, ranks and economy, and a living history. Pledge in, rise up, represent.\n\n`
    + `## What a tribe is\n`
    + `Every tribe has a hoisted role and colour, a private land (throne, hall, voice), a member-made **banner**, a rank ladder, and a leader who runs it (own title, e.g. Warden, Warlord).\n\n`
    + `## How tribes are founded\n`
    + `An admin can found a tribe. A mod can too, backed by **two other mods**; all three lead it, and the tribe must keep **three leaders** to stay standing. Got an idea? Bring it to an admin, or rally two mods.\n\n`
    + `## How to join\n`
    + `Pick a tribe from the Tribes section in #roles. Your **first tribe is a free choice**. After that a leader must release you (staff can Leave below), and a new tribe must accept you (nomination, invite, or Join Request below).\n\n`
    + `## Ranks & Prestige\n`
    + `Being active in the hall moves you up the rank ladder automatically (four named rungs); ranks only go up. Staff members hold **General**, above the ladder. Reach the **top rung** and you can **⭐ Prestige**: reset your climb for a permanent honour title and a mark in tribe history.\n\n`
    + `## Lore & Paths\n`
    + `Every tribe has 3 lore paths. Pick one with \`/tribe panel\` → Choose Your Path: ranking up grows your own bonus and your tribe's real power in that category, in War, Arena, and Tribe Games alike. Full paths are pinned in your throne.\n\n`
    + `## Treasury, Glory & the Weekly Crown\n`
    + `Activity earns **Glory** (live weekly standing). Every Sunday 00:00 UTC the most Glory takes the **👑 Weekly Crown**. Glory resets weekly; **Treasury** is the permanent bank (crowns, \`/tribe offer\`, raids, gifts, quests).\n\n`
    + `## Ages, Relics & the Hall of Fame\n`
    + `Time is measured in **Ages**, 6-week chapters. Crowns stack across an age; the top tribe becomes **🏆 Age Champion**, enters the **Hall of Fame**, and wins a **🏺 Relic** (a war-edge trophy, seizable in war). Crowns reset for a new age; everything else carries over.\n\n`
    + `## Weekly Quests & the Chronicle\n`
    + `Every week tribes share three **🎯 Quests** (arenas, musters, war, the Crown); finishing one banks Treasury + Glory. The bot also writes a weekly **📜 Chronicle** of what happened.\n\n`
    + `## The Shop\n`
    + `Each unlock has a members-or-crowns gate plus a treasury cost: extra channels, re-theme, external sounds, voice boost, faster points, and a **custom icon**. A maxed tribe sinks treasury into repeatable **🏰 Stronghold Tiers** for war defense.\n\n`
    + `## Musters\n`
    + `A leader can call a **muster** (hall roll-call, about once a day). Answer it and the tribe banks treasury + glory.\n\n`
    + `## War & Alliances\n`
    + `A leader can **Declare War**: members vote first, then the target leader Accepts or Declines. Each war is **named**, plays out as a live narrated battle (points-weighted, no guaranteed win), 72h cooldown. Loser is raided ~25% treasury, can lose members for 36h (never the leader); **🏰 Stronghold Tiers** blunt it. **Alliances** (1 per tribe) defend each other and gift treasury.\n\n`
    + `## Challenges: the Arena\n`
    + `The bot runs live cross-tribe games through the day (calmer overnight for **2x Treasury**), each with a **5-minute heads-up**. **15 game types** rotate: trivia, word games, reaction/reflex, themed quizzes. Winner banks **Glory + Treasury**. (Staff: \`/tribe-admin arena\`.)\n\n`
    + `## Tribe Games\n`
    + `Staff-run tribe vs. tribe matches in real external games (Among Us, Murder Mystery 2, Flee the Facility, and more). Your leader (or staff) sets your rep via \`/tribe panel\`; staff reports the real result once it's played out, and rewards follow your path. Watch your Hall for the lobby ping.\n\n`
    + `## Propaganda\n`
    + `Promote your tribe or needle a rival in **#📢┆propaganda**, tag your tribe on the thread. Daily Treasury payout based on reactions, every tribe that posted gets paid.\n\n`
    + `## Every tribe's Throne\n`
    + `Each throne has a pinned panel. Members get Roster / Leaderboard / Shop / Tithe / Leave, plus Trophies, Hall of Fame, Quests, Relics and Prestige. Leaders (or staff) get the full leader toolkit too: Invite, Banish, Set Rank, Muster, War, Alliances, and more.\n\n`
    + `-# Use the buttons below instead of typing commands out.`;
  return new EmbedBuilder().setColor(copy.herald.COLORS.herald).setDescription(desc.slice(0, 4096));
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
// ---- Shared spectacle announcement queue (Fable review: stop weekly-boundary reveals stacking) --------
// Big Herald moments (coronation, Age champion, Chronicle, Prover of the Week, Trial + sealed results) would
// otherwise fire at once on a busy/reset day and become a wall of embeds. This serializes them: one at a
// time, spaced by SPECTACLE_GAP_MS, highest priority first among whatever is pending. Fire-and-forget.
const SPECTACLE_GAP_MS = 5000;
const SPECTACLE_PRIORITY = { coronation: 100, ageChampion: 95, chronicle: 80, proverWeek: 70, trialResult: 60, sealedResult: 55, other: 10 };
const _spectaclePending = [];
let _spectacleChain = Promise.resolve();
// enqueue a reveal. run = async () => { ... does the posting ... }. Returns the chain tail (awaitable if needed).
function enqueueSpectacle(priority, label, run) {
  _spectaclePending.push({ priority: priority || SPECTACLE_PRIORITY.other, label: label || 'spectacle', run });
  _spectacleChain = _spectacleChain.then(async () => {
    if (!_spectaclePending.length) return;
    _spectaclePending.sort((a, b) => b.priority - a.priority);   // highest priority first among what's pending now
    const item = _spectaclePending.shift();
    try { await item.run(); } catch (e) { console.error('[spectacle-queue]', item.label, e.message); }
    await warSleep(SPECTACLE_GAP_MS);   // spacing so reveals don't stack
  });
  return _spectacleChain;
}
async function getChronicleChannel(guild) {
  if (config.tribeChronicleChannelId) { const c = await guild.channels.fetch(config.tribeChronicleChannelId).catch(() => null); if (c) return c; }
  return getSpectacleChannel(guild);
}
// The Chronicle (Phase 7, Permanence): once a week the bot composes a narrative chapter of the week just
// gone, read straight from the Lore Log. Template-composed (no Haiku dependency), history-book voice. Runs on
// the same weekly boundary as the crown but AFTER it, so the just-crowned tribe is in the chapter. A quiet week
// (nothing recorded) writes nothing.
async function processChronicleIfDue(guild) {
  if (!guild || !tribes.dueForChronicle(Date.now())) return;
  tribes.markChronicleDone(Date.now());
  const now = Date.now(), weekAgo = now - 7 * 86400000;
  const events = lore.between(weekAgo, now).filter(e => e.type !== 'chronicle');
  const crowns = events.filter(e => e.type === 'crown');
  const wars = events.filter(e => e.type === 'war');
  const arenas = events.filter(e => e.type === 'arena');
  const musters = events.filter(e => e.type === 'muster');
  const ages = events.filter(e => e.type === 'age_champion' || e.type === 'age_begin' || e.type === 'age_end');
  const foundings = events.filter(e => e.type === 'founding');
  if (!crowns.length && !wars.length && !arenas.length && !musters.length && !ages.length && !foundings.length) return;   // a quiet week: nothing to tell
  const arenaWins = {}; for (const a of arenas) (a.tribes || []).forEach(k => { arenaWins[k] = (arenaWins[k] || 0) + 1; });
  const topArena = Object.entries(arenaWins).sort((x, y) => y[1] - x[1])[0];
  const season = tribes.getSeason();
  const I = copy.herald.ICONS;
  const parts = [`# ${I.chronicle} The Chronicle`, `-# ${copy.herald.open()} A record of the week just past${season && season.name ? `, in ${season.name}` : ''}.`];
  if (ages.length) parts.push(ages.map(e => `${I.age} ${e.title}.`).join('\n'));
  if (foundings.length) parts.push(`${I.founding} **New banners raised.** ${foundings.map(f => f.title).join('; ')}.`);
  if (crowns.length) parts.push(`${I.crown} **The Crown.** ${crowns.map(c => c.title).join('; ')}.`);
  if (wars.length) parts.push(`${I.war} **Wars.** ${wars.map(w => w.title).join('; ')}.`);
  if (arenas.length) parts.push(`🎪 **The Arena.** ${arenas.length} contest${arenas.length === 1 ? ' was' : 's were'} fought${topArena ? `, and ${tribeName(topArena[0])} claimed the most (${topArena[1]})` : ''}.`);
  if (musters.length) parts.push(`${I.muster} **The Muster.** ${musters.length} call${musters.length === 1 ? '' : 's'} to arms went out across the tribes.`);
  parts.push(`-# ${copy.herald.SIGNOFF}`);
  const chronicleBody = parts.join('\n\n').slice(0, 4000);
  enqueueSpectacle(SPECTACLE_PRIORITY.chronicle, 'chronicle', async () => {
    const ch = await getChronicleChannel(guild);
    if (ch) await ch.send({ content: chronicleBody, allowedMentions: { parse: [] } }).catch(() => {});
  });
  lore.record({ type: 'chronicle', title: 'A chapter of the Chronicle was written' });
  console.log('[tribe chronicle] wrote a weekly chapter.');
}

// ---- Weekly tribe quests (Phase 7 depth) ----------------------------------------------------------------
// Progress is READ from the Lore Log for the current week — no separate counters. stat maps to lore event types.
function questStat(tribeKey, stat, weekEvents) {
  if (stat === 'arena_wins') return weekEvents.filter(e => e.type === 'arena' && (e.tribes || []).includes(tribeKey)).length;
  if (stat === 'war_wins') return weekEvents.filter(e => e.type === 'war' && e.winner === tribeKey).length;
  if (stat === 'musters') return weekEvents.filter(e => e.type === 'muster' && (e.tribes || []).includes(tribeKey)).length;
  if (stat === 'crown') return weekEvents.filter(e => e.type === 'crown' && (e.tribes || []).includes(tribeKey)).length;
  return 0;
}
// Called right after any quest-relevant lore event is recorded for a tribe: pays out every newly-complete,
// unclaimed quest once. Idempotent (claimed set), fail-off (registry flag), no fourth currency.
async function checkTribeQuests(guild, tribeKey) {
  if (!features.enabled('tribeQuests') || !tribeKey) return;
  const weekStart = tribes.weekStartMs(Date.now());
  quests.ensureWeek(weekStart);
  const evs = lore.since(weekStart);
  const t = tribes.get(tribeKey);
  if (!t) return;
  for (const q of quests.activeQuests(weekStart)) {
    if (quests.isClaimed(tribeKey, q.id)) continue;
    if (questStat(tribeKey, q.stat, evs) < q.target) continue;
    quests.markClaimed(tribeKey, q.id);
    if (q.reward.treasury) tribes.addTreasury(tribeKey, q.reward.treasury);
    if (q.reward.glory) tribes.addGlory(tribeKey, q.reward.glory);
    lore.record({ type: 'quest', title: `${t.shortName || t.name} completed a quest: ${q.desc}`, tribes: [tribeKey] });
    await broadcastSpectacle(guild, `# 🎯 Quest complete\n${tribeName(tribeKey)} finished **${q.desc}** and banked **+${q.reward.treasury} Treasury**${q.reward.glory ? ` and **+${q.reward.glory} Glory**` : ''}.`, [t.roleId].filter(Boolean));
    await refreshThronePanel(guild, t).catch(() => {});
  }
}
// The 🎯 Quests view: this week's three objectives with this tribe's live progress + reward.
function renderQuestBoard(tribeKey) {
  const weekStart = tribes.weekStartMs(Date.now());
  quests.ensureWeek(weekStart);
  const evs = lore.since(weekStart);
  const t = tribes.get(tribeKey);
  const nextReset = weekStart + 7 * 86400000;
  const lines = quests.activeQuests(weekStart).map(q => {
    const done = quests.isClaimed(tribeKey, q.id);
    const prog = Math.min(questStat(tribeKey, q.stat, evs), q.target);
    const bar = done ? '✅' : `**${prog}/${q.target}**`;
    const reward = `+${q.reward.treasury} Treasury${q.reward.glory ? ` · +${q.reward.glory} Glory` : ''}`;
    return `${done ? '✅' : '🎯'} ${q.desc} — ${bar}\n-# reward: ${reward}${done ? ' · claimed' : ''}`;
  });
  return `# 🎯 ${t ? `${t.emoji || '🏴'} ${t.shortName || t.name}` : 'Tribe'} · Weekly Quests\n-# Shared by every tribe this week. Resets <t:${Math.floor(nextReset / 1000)}:R>.\n\n${lines.join('\n\n')}`;
}
// The 🏺 Relics view: the tribe's permanent trophies + its current (tiny, decaying) war bonus.
function renderRelicsBoard(tribeKey) {
  const t = tribes.get(tribeKey);
  const relics = tribes.relicsOf(tribeKey);
  const season = tribes.getSeason();
  const age = season ? season.number : 0;
  const perk = tribes.relicPerk(tribeKey, age);
  const head = `# 🏺 ${t ? `${t.emoji || '🏴'} ${t.shortName || t.name}` : 'Tribe'} · Relics\n-# Won by claiming an Age. Each is a permanent trophy; together they add a tiny war edge that stacks but fades over the Ages. Current bonus: **+${(perk * 100).toFixed(1)}% war power** (cap +${Math.round(tribes.RELIC_PERK_CAP * 100)}%).`;
  if (!relics.length) return `${head}\n\n_No relics yet. Win an Age to be awarded one, or seize one in war._`;
  const body = relics.slice().reverse().map(r => `🏺 **${r.name}** — won ${r.ageName || `Age ${r.age}`}${r.raidedFrom ? ' · seized in war' : ''}`).join('\n');
  return `${head}\n\n${body}`;
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
// Dedicated ARENA channel so the frequent challenge battles don't clutter tribe-announcements (owner request).
// Auto-creates once, stored in tribes state, slotted next to the hub. Falls back to announcements if creation fails.
async function ensureArenaChannel(guild, config) {
  const info = tribes.getArenaInfo();
  let ch = info && await guild.channels.fetch(info.channelId).catch(() => null);
  if (ch) return ch;
  const hubInfo = tribes.getHubInfo();
  const hub = hubInfo && await guild.channels.fetch(hubInfo.channelId).catch(() => null);
  const P = PermissionsBitField.Flags;
  try {
    ch = await guild.channels.create({
      name: '⚔️┆ᴛʀɪʙᴇ-ᴀʀᴇɴᴀ', type: ChannelType.GuildText, parent: hub?.parentId || undefined,
      topic: 'Live cross-tribe challenge battles. Play here when one starts.',
      // Everyone can talk here (typed challenges need it); the bot re-locks/opens per round as usual.
      permissionOverwrites: [{ id: guild.id, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages] }],
      reason: 'Dedicated tribe arena channel (owner request)',
    });
  } catch (e) { console.error('[arena] channel create:', e.message); return ensureTribeAnnounce(guild, config).catch(() => null); }
  if (hub) await ch.setPosition(Math.max(0, hub.position)).catch(() => {});
  tribes.setArenaInfo(ch.id);
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
  enqueueSpectacle(SPECTACLE_PRIORITY.coronation, 'coronation', () => broadcastCoronation(guild, tribe, result, crownRole, preBoard, season));
  lore.record({ type: 'crown', title: `${tribe.shortName || tribe.name} took a weekly Crown`, detail: `${result.glory} Glory`, tribes: [tribe.key], age: season?.number });
  checkTribeQuests(guild, tribe.key).catch(() => {});
}
// The weekly crown as a STAGED ceremony (Phase 7, owner: "the Sunday crown becomes a staged sequence").
// Herald -> crown transfer -> fallen rivals acknowledged -> closing proclamation. Public, detached.
async function broadcastCoronation(guild, tribe, result, crownRole, preBoard, season) {
  const ch = await getSpectacleChannel(guild);
  if (!ch) return;
  const emoji = tribe.emoji || '🏴', name = tribe.shortName || tribe.name;
  await ch.send({ content: `# ${copy.herald.ICONS.herald} The week is ended.\n${copy.herald.open()} The Glory of the past seven days is tallied, and a Crown must pass.`, allowedMentions: { parse: [] } }).catch(() => {});
  await warSleep(3000);
  await ch.send({ content: `# 👑 The Crown passes to ${emoji} **${name}**!\nThey stood highest with **${result.glory} Glory**. Every soul of ${name} now wears <@&${crownRole?.id}> until the next crowning.`, allowedMentions: { roles: crownRole ? [crownRole.id] : [], users: [] } }).catch(() => {});
  await warSleep(3000);
  const rivals = (preBoard || []).filter(t => t.key !== tribe.key && (t.glory || 0) > 0).slice(0, 4);
  if (rivals.length) { await ch.send({ content: `-# They did not take it uncontested. ${rivals.map(r => `${r.emoji || '🏴'} ${r.shortName || r.name} (${r.glory})`).join(', ')} pressed them hard.`, allowedMentions: { parse: [] } }).catch(() => {}); await warSleep(2500); }
  await ch.send({ content: `-# Long may ${name} reign. This is their **${tribe.seasonCrowns || 1}** crown of ${season?.name || 'the age'}, one step closer to the 🏆 Age Champion.`, allowedMentions: { parse: [] } }).catch(() => {});
}
// Birthdays: a PER-PERSON, ephemeral 🎉 role — created fresh when it becomes their day (in their own saved
// timezone, default UTC) positioned just above THEIR OWN highest role, and deleted outright once their
// local day ends. Deliberately not one shared role pinned high in the hierarchy: that would outrank staff
// roles too and block moderation on whoever holds it that day (a mod-founded-tribe-style hierarchy bug,
// caught before shipping). Positioning relative to each person's own highest role keeps a regular member's
// birthday role below every staff role, same as it already was.
async function grantBirthdayRole(guild, member) {
  const botTop = guild.members.me?.roles?.highest;
  const targetPos = botTop ? Math.max(1, Math.min(botTop.position - 1, member.roles.highest.position + 1)) : member.roles.highest.position + 1;
  const role = await guild.roles.create({
    name: `🎉 Birthday — ${member.user.username}`.slice(0, 100),
    colors: { primaryColor: 0xF47FFF }, hoist: true, mentionable: false,
    reason: `Birthday role for ${member.user.tag}`,
  }).catch(() => null);
  if (!role) return null;
  if (targetPos > 0) await role.setPosition(targetPos).catch(() => {});
  await member.roles.add(role, "Birthday role: it's their day").catch(() => {});
  return role;
}
async function revokeBirthdayRole(guild, userId, roleId) {
  const m = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (m && role) await m.roles.remove(role, "Birthday role: their day has passed").catch(() => {});
  if (role) await role.delete("Birthday role: their day has passed").catch(() => {});
}
// Hourly (finer than daily on purpose — different members' local midnights land at different real-world
// hours). Expires anyone whose local day rolled over, then grants to anyone whose local day now matches
// their saved birthday and doesn't already have an active role.
async function sweepBirthdays(guild) {
  const hourKey = Math.floor(Date.now() / 3600000).toString();
  if (birthday.lastRunHour() === hourKey) return;
  await ensureMembers(guild);
  for (const [userId, a] of Object.entries(birthday.active())) {
    const d = birthday.get(userId);
    if (d && birthday.localDayKey(Date.now(), d.utcOffsetMin) === a.localDay) continue;   // still their day — leave it
    await revokeBirthdayRole(guild, userId, a.roleId);
    birthday.clearActive(userId);
  }
  const activeNow = birthday.active();
  for (const [userId, d] of Object.entries(birthday.allDates())) {
    if (activeNow[userId]) continue;
    const today = birthday.localDayKey(Date.now(), d.utcOffsetMin);
    if (`${d.month}-${d.day}` !== today) continue;
    const m = guild.members.cache.get(userId);
    if (!m) continue;
    const role = await grantBirthdayRole(guild, m);
    if (role) {
      birthday.setActive(userId, role.id, today);
      if (config.birthdayChannelId) {
        const ch = await guild.channels.fetch(config.birthdayChannelId).catch(() => null);
        if (ch) {
          const ping = config.birthdayPingRoleId ? ` <@&${config.birthdayPingRoleId}>` : '';
          await ch.send({ content: `🎉🎂 Happy Birthday, <@${userId}>! Hope it's a great one.${ping}`, allowedMentions: { users: [userId], roles: config.birthdayPingRoleId ? [config.birthdayPingRoleId] : [] } }).catch(e => console.error('[birthday] announce:', e.message));
        }
      }
    }
  }
  birthday.setLastRunHour(hourKey);
}
const BIRTHDAY_MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Shared validate+save for a birthday input, used by both /birthday set and the #roles "Set Birthday"
// button's modal — one place for the validation rules instead of two copies drifting apart.
function saveBirthdayInput(userId, month, day, offsetInput, year) {
  const offsetMin = birthday.parseOffset(offsetInput);
  if (offsetMin == null) return { ok: false, error: `"${offsetInput}" isn't a valid UTC offset. Use something like \`-5\`, \`+5:30\`, or \`UTC-8\`.` };
  const daysInMonth = new Date(Date.UTC(2000, month, 0)).getUTCDate();   // 2000 is a leap year, so Feb 29 is allowed
  if (day > daysInMonth) return { ok: false, error: `That month only has ${daysInMonth} days.` };
  if (year != null && (year < 1900 || year > new Date().getUTCFullYear())) return { ok: false, error: 'That birth year doesn\'t look right.' };
  birthday.set(userId, month, day, offsetMin, year || null);
  return { ok: true, month, day, offsetMin, year: year || null };
}
function birthdaySavedMsg(r) {
  return `🎉 Saved — **${BIRTHDAY_MONTH_NAMES[r.month]} ${r.day}**${r.year ? ` ${r.year}` : ''} (${birthday.formatOffset(r.offsetMin)}). You'll get a Birthday role that day — in your own timezone, above your other roles.`;
}

// Weekly peer-voted member awards. A category's role is created once and reused week to week (the same
// role just changes hands), unlike birthday's per-person ephemeral role — there's no moderation-hierarchy
// concern here since it's one fixed role, positioned normally (bottom of the hierarchy on creation), never
// repositioned above anyone.
// A rotating palette for freshly-created award roles — guild.roles.create() defaults to no color (renders
// black/default) if none is given, which is how 8 categories mirrored from Melanin ended up colorless.
// Picked by hashing the category key, so it's deterministic (same category always gets the same color) and
// doesn't require passing an index around.
const AWARD_ROLE_COLORS = [0xF1C40F, 0x5DADE2, 0x16A085, 0x2ECC71, 0x922B21, 0x9B59B6, 0xE67E22, 0xF4D03F, 0xE91E63, 0x1ABC9C];
function awardRoleColor(categoryKey) {
  let h = 0; for (const c of categoryKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AWARD_ROLE_COLORS[h % AWARD_ROLE_COLORS.length];
}
async function ensureAwardRole(guild, categoryKey) {
  const cat = awards.getCategory(categoryKey);
  if (!cat) return null;
  if (cat.roleId) { const r = guild.roles.cache.get(cat.roleId) || await guild.roles.fetch(cat.roleId).catch(() => null); if (r) return r; }
  const acolor = awardRoleColor(categoryKey);
  const role = await guild.roles.create({ name: cat.name.slice(0, 100), colors: { primaryColor: acolor }, hoist: true, mentionable: false, reason: `Award role: ${cat.name}` })
    .catch(() => guild.roles.create({ name: cat.name.slice(0, 100), color: acolor, hoist: true, mentionable: false, reason: `Award role: ${cat.name}` }).catch(() => null));
  if (role) awards.setCategoryRoleId(categoryKey, role.id);
  return role;
}
async function swapAwardHolder(guild, categoryKey, newUserId) {
  const role = await ensureAwardRole(guild, categoryKey);
  if (!role) return false;
  const prevId = awards.holder(categoryKey);
  if (prevId && prevId !== newUserId) {
    const prev = guild.members.cache.get(prevId) || await guild.members.fetch(prevId).catch(() => null);
    if (prev) await prev.roles.remove(role, 'Award: new winner this week').catch(() => {});
  }
  const winner = guild.members.cache.get(newUserId) || await guild.members.fetch(newUserId).catch(() => null);
  if (!winner) return false;
  if (!winner.roles.cache.has(role.id)) await winner.roles.add(role, 'Award: this week\'s winner').catch(() => {});
  awards.setHolder(categoryKey, newUserId);
  return true;
}
// Wednesday: one reminder per week, only if there's at least one category to vote on.
async function awardsReminderIfDue(guild) {
  if (!awards.dueForReminder(Date.now())) return;
  awards.markReminderDone(Date.now());   // mark first — an overlapping tick shouldn't double-post
  const cats = Object.entries(awards.categories());
  if (!cats.length || !config.awardsAnnounceChannelId) return;
  const ch = await guild.channels.fetch(config.awardsAnnounceChannelId).catch(() => null);
  if (!ch) return;
  const list = cats.map(([, c]) => `**${c.name}**`).join(', ');
  // Reuses the existing Event ping role for the weekly reminder (owner, 2026-08-20: "we can use the
  // event ping for superlatives" — no dedicated role needed). One ping on the Wednesday call-to-vote;
  // Friday's results stay unping'd since that's up to 17 separate category messages, not one.
  const ping = config.eventPingRoleId ? `<@&${config.eventPingRoleId}> ` : '';
  await ch.send({ content: `${ping}🗳️ Weekly awards close **Friday** — vote with \`/awards vote\`! Categories open: ${list}. You can't vote for yourself.`, allowedMentions: { roles: config.eventPingRoleId ? [config.eventPingRoleId] : [] } }).catch(() => {});
}
// Friday: tally each category, swap the role to the winner (ties broken by keeping the current holder if
// they're tied for first, else the first voted-in), announce, clear votes for next week.
async function awardsResultsIfDue(guild) {
  if (!awards.dueForResults(Date.now())) return;
  awards.markResultsDone(Date.now());
  const cats = Object.entries(awards.categories());
  if (!cats.length) return;
  await ensureMembers(guild);
  const ch = config.awardsAnnounceChannelId ? await guild.channels.fetch(config.awardsAnnounceChannelId).catch(() => null) : null;
  for (const [key, cat] of cats) {
    const ranked = awards.tally(key);
    if (!ranked.length) { awards.clearVotes(key); continue; }
    const top = ranked[0].count;
    const tied = ranked.filter(r => r.count === top);
    const prevHolder = awards.holder(key);
    const winnerId = (tied.find(r => r.userId === prevHolder) || tied[0]).userId;
    const ok = await swapAwardHolder(guild, key, winnerId);
    if (ok && ch) await ch.send({ content: `🏆 **${cat.name}** this week: <@${winnerId}> (${top} vote${top === 1 ? '' : 's'})! Voting resets — nominate again with \`/awards vote\`.`, allowedMentions: { users: [winnerId] } }).catch(() => {});
    awards.clearVotes(key);
  }
}
// Persistent vote panel (owner, 2026-08-20: "is there a way we can make this easier instead of using
// a command") — a pinned category dropdown replacing /awards vote. Pick a category → ephemeral member
// picker → cast. Edited in place when the existing pinned message can be found (same pattern every
// other panel in this file already uses), so a bot restart doesn't churn a fresh message/pin every
// time — only actually reposts if the old one is gone.
function buildAwardsVotePanel() {
  const cats = Object.entries(awards.categories());
  if (!cats.length) return null;
  const menu = new StringSelectMenuBuilder().setCustomId('awards_pick_category').setPlaceholder('🗳️ Pick a category to vote in…')
    .addOptions(cats.slice(0, 25).map(([key, c]) => ({ label: c.name.slice(0, 100), value: key })));
  return {
    content: '## 🏆 Weekly Superlatives\nPick a category below, then who you\'re voting for. One vote per category per week — change it anytime before Friday. You can\'t vote for yourself.',
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}
async function ensureAwardsVotePanel(guild) {
  try {
    if (!config.awardsAnnounceChannelId) return;
    const payload = buildAwardsVotePanel();
    if (!payload) return;
    const ch = await guild.channels.fetch(config.awardsAnnounceChannelId).catch(() => null);
    if (!ch) return;
    const ref = awards.panelRef();
    if (ref && ref.channelId === config.awardsAnnounceChannelId) {
      const existing = await ch.messages.fetch(ref.messageId).catch(() => null);
      if (existing) {
        await existing.edit(payload);
        if (!existing.pinned) await existing.pin().catch(() => {});
        return;
      }
    }
    const msg = await ch.send(payload);
    await msg.pin().catch(() => {});
    awards.setPanelRef(ch.id, msg.id);
  } catch (e) { console.error('[awards] panel:', e.message); }
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
  // Mint the Age Champion a Relic (Phase 7): a permanent trophy + a tiny decaying war edge (fail-off gated).
  let mintedRelic = null;
  if (features.enabled('relics') && champion && champTribe) {
    mintedRelic = tribes.mintRelic(champTribe.key, { age: previousNumber, ageName: previousName });
    if (mintedRelic) lore.record({ type: 'relic', title: `${champTribe.shortName || champTribe.name} was awarded ${mintedRelic.name}`, detail: `won ${previousName}`, tribes: [champTribe.key], relic: mintedRelic.name, age: previousNumber });
  }
  const endsAt = Math.floor(season.endsAt / 1000);
  const relicLine = mintedRelic ? `\n🏺 They are awarded a Relic: **${mintedRelic.name}**, kept forever on their throne (a small, fading war edge that stacks with future relics).` : '';
  const msg = champion
    ? `# 🏆 ${previousName} ends: ${champTribe?.emoji || '🏴'} **${champion.name}** are its Champion!\nThey took **${champion.crowns}** weekly crown${champion.crowns === 1 ? '' : 's'} across the age and now wear <@&${champRole?.id}>. Their name is written into the Hall of Fame forever.${relicLine}\n**${season.name}** (Age ${season.number}) begins now, running to <t:${endsAt}:D>. The age's crowns reset, so the race is wide open. Treasury, ranks, and unlocks all carry over.`
    : `# 🏁 ${previousName} ends with no Champion.\nNo tribe claimed a weekly crown across the age. **${season.name}** (Age ${season.number}) begins now, running to <t:${endsAt}:D>. Go make history.`;
  enqueueSpectacle(SPECTACLE_PRIORITY.ageChampion, 'ageChampion', () => broadcastSpectacle(guild, msg, champTribe ? [champTribe.roleId].filter(Boolean) : []));
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
// EVERY current holder of a tribe's leader role, regardless of staff tier (a member-founded tribe's
// co-leaders are regular members) — used by the disband-agreement flow, unlike countModLeaders above which
// only counts staff-tier leaders for the mod-tribe minimum-leaders rule.
function currentTribeLeaders(guild, tribe) {
  const role = tribe.leaderRoleId && guild.roles.cache.get(tribe.leaderRoleId);
  return role ? [...role.members.keys()] : [];
}
// Single source of truth for actually tearing a tribe down (owner, 2026-08-17: "add the disband command").
// Deletes its channels + roles (best-effort per resource), drops the state record, and refreshes the #roles
// tribe picker so it stops showing as a pledge option. Shared by the auto-disband-pending flow, the direct
// owner/bot-owner command, and the leader-agreement flow — one place, not three copies of the same deletes.
async function executeTribeDisband(guild, tribe, byId, extraNote = '') {
  const deleted = [];
  for (const chId of [tribe.throneId, tribe.hallId, tribe.vcId, tribe.text2Id, tribe.vc2Id, tribe.categoryId].filter(Boolean)) {
    const ch = await guild.channels.fetch(chId).catch(() => null);
    if (ch) { await ch.delete(`Tribe disbanded by <@${byId}>`).catch(() => {}); deleted.push(chId); }
  }
  for (const rId of [tribe.roleId, tribe.leaderRoleId, tribe.staffRankRoleId, ...((tribe.ranks || []).map(r => r.roleId))].filter(Boolean)) {
    const role = await guild.roles.fetch(rId).catch(() => null);
    if (role) await role.delete(`Tribe disbanded by <@${byId}>`).catch(() => {});
  }
  tribes.removeTribe(tribe.key);
  if (config.rolesChannelId) await roleselect.refreshTribeBlock(guild, config.rolesChannelId).catch(() => {});
  await ownerlog.log(guild, { emoji: '💥', title: 'Tribe DISBANDED', color: 0xED4245,
    detail: `**${tribe.shortName || tribe.name}** was dissolved by <@${byId}>${extraNote ? ` ${extraNote}` : ''}. ${deleted.length} channel(s) + its roles deleted.` }).catch(() => {});
  return deleted.length;
}
// True once EVERY current leader-role holder has clicked Agree — membership is re-checked live (not just
// the count at request time), so someone stepping down as leader mid-request doesn't leave a phantom
// "still waiting" slot, and a new leader added mid-request is correctly required to agree too.
function disbandFullyAgreed(guild, tribe, req) {
  const leaders = currentTribeLeaders(guild, tribe);
  return leaders.length > 0 && leaders.every(id => req.agreed.includes(id));
}
function disbandAgreeRow(key) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribedisband_agree:${key}`).setEmoji('💥').setLabel('Agree to disband').setStyle(ButtonStyle.Danger));
}
function disbandRequestContent(guild, tribe, req) {
  const leaders = currentTribeLeaders(guild, tribe);
  const agreedHere = leaders.filter(id => req.agreed.includes(id));
  return `## 💥 Disband request: ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name}\n`
    + `Started by <@${req.initiatorId}>. **Every current leader must agree** before this goes through — this deletes the tribe's roles and channels, and cannot be undone.\n`
    + `Agreed (${agreedHere.length}/${leaders.length}): ${agreedHere.length ? agreedHere.map(id => `<@${id}>`).join(', ') : '_none yet_'}\n`
    + `${leaders.filter(id => !req.agreed.includes(id)).length ? `Waiting on: ${leaders.filter(id => !req.agreed.includes(id)).map(id => `<@${id}>`).join(', ')}` : ''}`;
}
// Kicks off (or, for a leader who isn't owner-tier, continues) a tribe disband. Shared by the /tribe-admin
// disband command and the throne panel's Disband button — same confirm/agreement flow either way.
async function beginTribeDisbandFlow(interaction, t) {
  const guild = interaction.guild;
  // Admin+ (which already always includes the real Discord server owner, regardless of roles — see
  // opspanel.memberTier) gets the direct path, same gate as every other /tribe-admin subcommand and the
  // existing auto-disband-pending confirm button. Anyone else falls through to the leader-agreement flow.
  if (canWLAdmin(interaction)) {
    return interaction.reply({
      content: `⚠️ **Disband ${t.emoji || '🏴'} ${t.shortName || t.name}?** This deletes its roles and channels — cannot be undone.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tribedisbandcmd_confirm:${t.key}`).setEmoji('💥').setLabel('Confirm Disband').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`tribedisbandcmd_cancel:${t.key}`).setEmoji('✖️').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!tribes.isLeader(interaction.member, t))
    return interaction.reply({ content: `Only **${t.shortName || t.name}**’s ${tribes.leaderTitle(t)}, an admin, or the server owner can disband it.`, flags: MessageFlags.Ephemeral });
  const existing = tribes.getDisbandRequest(t.key);
  if (existing) {
    if (existing.agreed.includes(interaction.user.id))
      return interaction.reply({ content: `You’ve already agreed. Waiting on the rest of **${t.shortName || t.name}**’s leaders.`, flags: MessageFlags.Ephemeral });
    const updated = tribes.agreeToDisband(t.key, interaction.user.id);
    if (disbandFullyAgreed(guild, t, updated)) {
      await interaction.reply({ content: `💥 All leaders agreed — disbanding **${t.shortName || t.name}** now...`, flags: MessageFlags.Ephemeral });
      const msgRef = updated.channelId && updated.messageId ? await (await guild.channels.fetch(updated.channelId).catch(() => null))?.messages.fetch(updated.messageId).catch(() => null) : null;
      tribes.clearDisbandRequest(t.key);
      await executeTribeDisband(guild, t, interaction.user.id, '(all leaders agreed)');
      if (msgRef) await msgRef.edit({ content: `💥 **${t.shortName || t.name}** has been disbanded — all leaders agreed.`, components: [] }).catch(() => {});
      return;
    }
    await interaction.reply({ content: `✅ Agreement recorded. Still waiting on other leaders of **${t.shortName || t.name}**.`, flags: MessageFlags.Ephemeral });
    if (existing.channelId && existing.messageId) {
      const ch = await guild.channels.fetch(existing.channelId).catch(() => null);
      const msg = ch && await ch.messages.fetch(existing.messageId).catch(() => null);
      if (msg) await msg.edit({ content: disbandRequestContent(guild, t, updated), components: [disbandAgreeRow(t.key)] }).catch(() => {});
    }
    return;
  }
  return interaction.reply({
    content: `⚠️ **Request to disband ${t.emoji || '🏴'} ${t.shortName || t.name}?** All of its current leaders must agree before it happens. This deletes its roles and channels — cannot be undone.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tribedisbandreq_start:${t.key}`).setEmoji('💥').setLabel('Request Disband').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`tribedisbandreq_cancel:${t.key}`).setEmoji('✖️').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
    flags: MessageFlags.Ephemeral,
  });
}
// Keep each tribe's rank ladder ordered (owner, 2026-08-20: ranks climb ascending, the base member role sits
// ABOVE all 4 ranks and below General — corrected from the earlier rank1<rank2<rank3<member<rank4<General,
// which interleaved the base role in among the ranks instead of putting it above all of them). Permutes ONLY
// the tribe's own 6 roles (rank1-4, member, General) among the position-slots they already occupy, into the
// order rank1<rank2<rank3<rank4<member<General — so no other server role ever moves, and it's a no-op when
// already correct. This is the maintenance guard against a leader dragging a rank role to the wrong spot; the
// initial even "sprinkle" spacing was done once out-of-band.
async function enforceRankOrder(guild, tribe) {
  const ranks = (tribe.ranks || []).map(r => guild.roles.cache.get(r.roleId)).filter(Boolean);
  const member = guild.roles.cache.get(tribe.roleId);
  const general = tribe.staffRankRoleId && guild.roles.cache.get(tribe.staffRankRoleId);
  if (!member || ranks.length < 4 || !general) return false;
  const ordered = [ranks[0], ranks[1], ranks[2], ranks[3], member, general];   // ascending (bottom->top)
  const slots = ordered.map(r => r.position).sort((a, b) => a - b);
  if (ordered.every((r, i) => r.position === slots[i])) return false;           // already correct
  await guild.roles.setPositions(ordered.map((r, i) => ({ role: r.id, position: slots[i] }))).catch(e => console.error(`[rank-order] ${tribe.key}:`, e.message));
  return true;
}
// A tribe leader must be a mod or admin (owner, 2026-08-04: "take the leader away if the person is no longer
// a mod or admin"). Strip the leader role from any holder who's lost their staff tier — applies to EVERY
// tribe. The guild/bot owner reads as 'owner' tier, so they're never stripped. Returns who was stripped.
async function stripNonStaffLeaders(guild, tribe) {
  if (tribes.isMemberFounded(tribe)) return [];   // member-founded tribes are LED by regular-member co-leaders, by design
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
// Inverse of stripNonStaffLeaders: a member-founded tribe stays member-only (staffBlockedFromMemberTribe
// blocks staff from JOINING one, but does nothing for someone already inside who gets promoted afterward).
// Mirrors the mod-founded side — promoted to mod+ ⟹ stripped, instantly on the promotion and swept hourly
// as a backstop, leader role first (if held) then the base tribe role, with an alert + throne post so the
// tribe knows to pick a replacement leader instead of a staff member silently overriding it.
async function removePromotedFromMemberTribe(guild, member, tribe) {
  if (!tribes.isMemberFounded(tribe) || !opspanel.meets(opspanel.memberTier(member), 'mod')) return null;
  const wasLeader = tribes.isLeader(member, tribe);
  if (wasLeader && tribe.leaderRoleId) await member.roles.remove(tribe.leaderRoleId, 'Member-founded tribe: promoted to staff, no longer eligible to lead it').catch(() => {});
  const hadRole = !!(tribe.roleId && member.roles.cache.has(tribe.roleId));
  if (hadRole) {
    await member.roles.remove(tribe.roleId, 'Member-founded tribe: promoted to staff, tribe stays member-only').catch(() => {});
    tribes.setMembership(tribe.key, member.id, false);
  }
  if (!hadRole && !wasLeader) return null;   // nothing actually changed (e.g. re-fired on an unrelated role update)
  const name = `${tribe.emoji || '🏴'} **${tribe.shortName || tribe.name}**`;
  await alertModTribe(guild, `👤 <@${member.id}> was promoted to staff and removed from ${name} — member-founded tribes stay member-only.${wasLeader ? ` They were its ${tribes.leaderTitle(tribe)}.` : ''}`, tribe.leaderRoleId);
  const freshTribe = tribes.get(tribe.key);
  const stillLed = freshTribe?.leaderRoleId && (guild.roles.cache.get(freshTribe.leaderRoleId)?.members.size || 0) > 0;
  if (wasLeader && !stillLed) await alertModTribe(guild, `⚠️ ${name} has **no leader left**. An admin (or a remaining co-leader) should appoint one with \`/tribe-admin set-leader\`.`, config.adminRoleId);
  if (tribe.throneId) {
    const throne = await guild.channels.fetch(tribe.throneId).catch(() => null);
    if (throne) await throneSend(throne, {
      content: `## 👤 <@${member.id}> left — promoted to staff\nMember-founded tribes stay member-only, so they've been removed automatically.` + (wasLeader ? ` The tribe needs a new ${tribes.leaderTitle(tribe)}${stillLed ? '' : ' — none left right now'}.` : ''),
      allowedMentions: { users: [member.id] },
    }).catch(() => {});
  }
  await refreshThronePanel(guild, freshTribe).catch(() => {});
  return { wasLeader, stillLed };
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
    // Backstop for the inverse case (member-founded, promoted INTO staff) — guildMemberUpdate handles this
    // instantly on the actual promotion; this catches anything missed (bot downtime, a stale partial member).
    if (tribes.isMemberFounded(tribe) && tribe.roleId) {
      const role = guild.roles.cache.get(tribe.roleId);
      if (role) for (const m of [...role.members.values()]) if (opspanel.meets(opspanel.memberTier(m), 'mod')) await removePromotedFromMemberTribe(guild, m, tribe).catch(() => {});
    }
    const leaderRole = tribe.leaderRoleId && guild.roles.cache.get(tribe.leaderRoleId);
    const holderCount = leaderRole ? leaderRole.members.size : 0;
    if (!tribes.isModFounded(tribe) && !tribes.isMemberFounded(tribe) && typeof tribe.lastLeaderCount === 'number' && holderCount < tribe.lastLeaderCount) {
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
    checkTribeQuests(guild, tribe.key).catch(() => {});
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
  // Storied Rivalry (Phase 8b): a war between two tribes with a CURATED relation (see tribes.setRelation —
  // owner + Claude judge each tribe's lore against tribes already known, not a formula) hits differently —
  // a clash relation is a real grudge match (bigger swing), a synergy relation dampens it (fighting a
  // thematic kin feels less charged). Unrated pairs (the default) are unaffected, same as before curation.
  const warRelation = tribes.getRelation(attacker.key, defender.key);
  const rivalryMult = tribes.RELATION_MULT[warRelation];
  const raidAmount = Math.round(sim.raidAmount * rivalryMult), gloryBonus = Math.round(tribes.WAR_GLORY_BONUS * rivalryMult);
  // Consequences apply IMMEDIATELY (so a restart mid-broadcast never loses them; the live show is theater).
  tribes.addTreasury(sim.winnerKey, raidAmount);
  tribes.addTreasury(sim.loserKey, -raidAmount);
  tribes.addGlory(sim.winnerKey, gloryBonus);
  const now = Date.now();
  tribes.update(attacker.key, { lastOutboundWarAt: now });   // separate cooldowns (owner 2026-08-05): the aggressor cools on ATTACKING
  tribes.update(defender.key, { lastInboundWarAt: now });    // ...the target cools on BEING attacked — independently
  for (const uid of sim.capturedIds) {
    const m = await guild.members.fetch(uid).catch(() => null);
    if (m) await captureMemberInto(guild, winner, m, `Captured in war: ${loser.shortName || loser.name} → ${winner.shortName || winner.name}`).catch(() => {});
  }
  const warName = makeWarName();   // every war is named (Phase 7)
  tribes.resolveWarRecord(war.id, { status: 'resolved', resolvedAt: now, winnerKey: sim.winnerKey, loserKey: sim.loserKey, raidAmount, capturedIds: sim.capturedIds, warName });
  const attackerWon = sim.winnerKey === attacker.key;
  const wScore = attackerWon ? sim.scoreA : sim.scoreD, lScore = attackerWon ? sim.scoreD : sim.scoreA;
  lore.record({ type: 'war', title: `${warName}: ${winner.shortName || winner.name} beat ${loser.shortName || loser.name} ${wScore}-${lScore}`, detail: `decided in ${sim.rounds.length} skirmishes`, tribes: [attacker.key, defender.key], winner: winner.key, warName });
  checkTribeQuests(guild, winner.key).catch(() => {});
  // Relic raid (Phase 7): the winner seizes the loser's newest relic as a war trophy. Committed here, before
  // the narration, same as every other consequence. Gated by the relics flag.
  let stolenRelic = null;
  if (features.enabled('relics')) {
    stolenRelic = tribes.stealRelic(loser.key, winner.key);
    if (stolenRelic) lore.record({ type: 'relic', title: `${winner.shortName || winner.name} seized ${stolenRelic.name} from ${loser.shortName || loser.name}`, detail: `spoils of ${warName}`, tribes: [winner.key, loser.key], relic: stolenRelic.name });
  }
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
  const relicRaidLine = stolenRelic ? `\n🏺 **${winner.shortName || winner.name} seized ${stolenRelic.name}** from ${loser.shortName || loser.name} as a war trophy.` : '';
  // Concise record posted to both thrones.
  const rivalryNote = warRelation === 'clash' ? ` (⚡ a grudge match — their lore clashes, rewards boosted ${Math.round((rivalryMult - 1) * 100)}%)`
    : warRelation === 'synergy' ? ` (their lore is thematically close — a less charged fight, rewards eased ${Math.round((1 - rivalryMult) * 100)}%)` : '';
  const summary = `${note}## ⚔️ War resolved: ${winner.emoji || '🏴'} ${winner.shortName || winner.name} win ${wScore}-${lScore}!\n${attacker.emoji || '🏴'} **${attacker.shortName || attacker.name}** vs ${defender.emoji || '🏴'} **${defender.shortName || defender.name}**\n> +${raidAmount} treasury raided, +${gloryBonus} glory to ${winner.shortName || winner.name}.${rivalryNote}\n> ${captureLine}${wallLine}${relicRaidLine}${honorsLine}`;
  for (const t of [attacker, defender]) {
    if (!t.throneId) continue;
    const throne = await guild.channels.fetch(t.throneId).catch(() => null);
    if (throne) await throneSend(throne, { content: summary, allowedMentions: { parse: [] } });
  }
  await refreshThronePanel(guild, tribes.get(attacker.key)).catch(() => {});
  await refreshThronePanel(guild, tribes.get(defender.key)).catch(() => {});
  // The GRAND part: a live, narrated battle plays out in the public spectacle channel. Detached (it takes
  // ~20s), so it never blocks the caller/interaction — the outcome above is already committed.
  broadcastWarSpectacle(guild, attacker, defender, winner, loser, sim, { note, wScore, lScore, warName, stolenRelic: stolenRelic ? stolenRelic.name : null }).catch(e => console.error('[war spectacle]', e.message));
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
  await ch.send({ content: `# ⚔️ ${meta.warName || 'WAR!'}\n${aEmoji} **${aName}** marches on ${dEmoji} **${dName}**. The horns sound, steel is drawn. First to **${target}** skirmishes takes it.\n-# Strength: ${aName} ${aPct}% vs ${dName} ${100 - aPct}%, by points + walls.`, allowedMentions: { parse: [] } }).catch(() => {});
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
  if (mvpId) { tribes.addTides(winner.key, mvpId, WAR_MVP_TIDES, 'combat'); mvpLine = `\n-# 🎖️ Battle MVP: <@${mvpId}> won ${mvpN} skirmish${mvpN === 1 ? '' : 'es'}. +${WAR_MVP_TIDES} Tides.`; }
  if (scoreMsg) await scoreMsg.edit({ content: `# 🏆 ${wEmoji} ${wName} WIN!   ${meta.wScore}-${meta.lScore}\n${aEmoji} ${aName}  vs  ${dEmoji} ${dName}\n${warMomentumBar(sA, sD, target)}` }).catch(() => {});
  await warSleep(1500);
  const cap = sim.capturedIds.length ? `Captured **${sim.capturedIds.length}**: ${sim.capturedIds.map(id => `<@${id}>`).join(', ')}.` : 'No captures.';
  const wall = sim.defWallTiers ? ` 🏰 ${dName}'s walls held the raid to ${Math.round(sim.raidPct * 100)}%.` : '';
  const relicBeat = meta.stolenRelic ? ` 🏺 Seized **${meta.stolenRelic}** as a war trophy.` : '';
  const roleIds = [attacker.roleId, defender.roleId].filter(Boolean);
  await ch.send({ content: `# 🏆 ${wEmoji} **${wName}** win ${meta.warName || 'the war'} ${meta.wScore}-${meta.lScore}!\n-# ${meta.warName ? `${meta.warName}, decided in ${sim.rounds.length} skirmishes.` : ''}\n> Raided **+${sim.raidAmount}** treasury and banked **+${tribes.WAR_GLORY_BONUS}** glory. ${cap}${wall}${relicBeat}${mvpLine}\n${roleIds.map(r => `<@&${r}>`).join(' ')}`, allowedMentions: { roles: roleIds, users: mvpId ? [mvpId] : [] } }).catch(() => {});
}
async function sweepExpiredWarVotes(guild) {
  for (const war of tribes.expiredWarVotes(Date.now())) await resolveWarVoteRecord(guild, war).catch(e => console.error('[tribe war] resolve:', e.message));
}
// A member-founding petition lapses if it doesn't reach its cosigns in the window — frees the one-at-a-time slot.
async function sweepMemberFounding(guild) {
  const req = tribes.getMemberFounding();
  if (!req || Date.now() - req.createdAt < tribes.MEMBER_FOUND_EXPIRY_MS) return;
  tribes.clearMemberFounding();
  if (req.channelId && req.messageId) {
    const ch = await guild.channels.fetch(req.channelId).catch(() => null);
    const msg = ch && await ch.messages.fetch(req.messageId).catch(() => null);
    if (msg) await msg.edit({ content: `## 🏴 Tribe founding lapsed\n> <@${req.founderId}>’s petition to found **${req.identity.name}** didn’t reach ${tribes.MEMBER_FOUND_COSIGNS} cosigns in time. The slot is open again.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
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
// ---- Propaganda (Phase 8): a shared forum, one native Discord tag per tribe, daily reaction sweep pays ----
// EVERY tribe that posted proportional to their reactions that day (not winner-take-all — matches how
// roleOutcome* Tribe Games already pay every qualifying tribe, not just the top one).
const PROPAGANDA_TIDES_PER_REACTION = 2;   // -> tribe-wide Treasury, tunable
// Forum tags were created by name only (no id stored anywhere) — match each tag to a tribe by fuzzy name
// comparison against shortName/name, stripping the leading emoji first.
function propagandaTagTribeMap(tags) {
  const map = {};
  for (const tag of (tags || [])) {
    const clean = (tag.name || '').replace(/\p{Extended_Pictographic}/gu, '').trim().toLowerCase();
    if (!clean) continue;
    const t = tribes.all().find(tr => { const sn = (tr.shortName || tr.name || '').toLowerCase(); return sn && (sn.includes(clean) || clean.includes(sn)); });
    if (t) map[tag.id] = t.key;
  }
  return map;
}
async function propagandaDailyIfDue(guild) {
  if (!features.enabled('tribePanel')) return;   // dark until /tribe panel itself is flipped on (owner, 2026-08-10)
  if (!tribes.dueForPropagandaDay(Date.now()) || !config.propagandaForumId) return;
  const ch = await guild.channels.fetch(config.propagandaForumId).catch(() => null);
  if (!ch) { tribes.markPropagandaDayDone(Date.now()); return; }
  const tagMap = propagandaTagTribeMap(ch.availableTags);
  const since = Date.now() - 24 * 3600000;
  const active = await ch.threads.fetchActive().catch(() => null);
  const archived = await ch.threads.fetchArchived().catch(() => null);
  const threads = [...(active?.threads.values() || []), ...(archived?.threads.values() || [])].filter(t => t.createdTimestamp >= since);
  const totals = {};
  for (const thread of threads) {
    const tagId = (thread.appliedTags || []).find(id => tagMap[id]); if (!tagId) continue;
    const key = tagMap[tagId];
    const starter = await thread.fetchStarterMessage().catch(() => null);
    const reactions = starter ? [...starter.reactions.cache.values()].reduce((s, r) => s + r.count, 0) : 0;
    if (reactions > 0) totals[key] = (totals[key] || 0) + reactions;
  }
  tribes.markPropagandaDayDone(Date.now());
  const entries = Object.entries(totals);
  if (!entries.length) return;
  const lines = entries.map(([key, count]) => { const treas = count * PROPAGANDA_TIDES_PER_REACTION; tribes.addTreasury(key, treas); return `${tribeName(key)}: **${count}** reaction${count === 1 ? '' : 's'} → +${treas} Treasury`; });
  const ann = await getSpectacleChannel(guild).catch(() => null);
  if (ann) await ann.send({ content: `# 📢 Propaganda payout\n${lines.join('\n')}`, allowedMentions: { parse: [] } }).catch(() => {});
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
const ARENA_DEFAULTS = { race: 5, trivia: 6, scramble: 5, blitz: 30, math: 5, typing: 5, truefalse: 6, reaction: 4, reactionhard: 5, pattern: 6,
  geoquiz: 6, sciquiz: 6, histquiz: 6, animalquiz: 6, reverse: 5 };   // default minutes per type (riddle/emoji removed)
const ARENA_LOBBY_MS = 5 * 60000;   // 5-min "get ready" countdown before an arena actually begins (owner)
const _arenaTimers = { start: null, end: null, round: null, sd: null };
function clearArenaTimers() { for (const k of ['start', 'end', 'round', 'sd']) if (_arenaTimers[k]) { clearTimeout(_arenaTimers[k]); _arenaTimers[k] = null; } }
const ARENA_SD_MS = 40000;   // sudden-death tiebreaker: 40s for a tied tribe to react before it falls back to first place
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
    tribes.addTides(tribeKey, userId, TIDES_PER_ARENA_POINT * points, 'combat');
    const daily = tribes.recordArenaPlay(userId, Date.now());
    if (daily.firstToday) tribes.addTides(tribeKey, userId, ARENA_DAILY_BONUS_TIDES, 'combat');
    if (features.enabled('achievements')) {   // dark until flipped on
      if (daily.firstToday) for (const a of achievements.checkValue(userId, 'streak', daily.streak)) arena.pushNewAch(userId, a.id);
      for (const a of achievements.checkValue(userId, 'tides', tribes.getTides(tribeKey, userId))) arena.pushNewAch(userId, a.id);
    }
  }
  return total;
}
const ARENA_ALL_TYPES = ['race', 'trivia', 'scramble', 'blitz', 'math', 'typing', 'truefalse', 'reaction', 'reactionhard', 'pattern',
  'geoquiz', 'sciquiz', 'histquiz', 'animalquiz', 'reverse'];   // riddle + emoji removed (no infinite source, owner)
// Which of a tribe's 3 path categories (see tribes.js's PATH_CATEGORY) each Arena mode rewards — reflex/speed
// types lean combat, wordplay/cleverness leans social, knowledge/quiz types lean collective. Feeds the
// winning tribe's attribute-power reward bonus (arenaAttrMult below) — a tribe invested in a matching path
// earns more from the modes that fit it, same idea as an individual's personal Tides bonus, just tribe-wide.
const ARENA_TYPE_CATEGORY = {
  race: 'combat', reaction: 'combat', reactionhard: 'combat', blitz: 'combat', typing: 'combat',
  scramble: 'social', pattern: 'social', reverse: 'social', truefalse: 'social',
  trivia: 'collective', math: 'collective', geoquiz: 'collective', sciquiz: 'collective', histquiz: 'collective', animalquiz: 'collective',
};
// Shared reward-bonus lookup — same scale/cap as warPower's combat bonus (tribes.WAR_ATTR_SCALE/CAP), just
// generalized to any of the 3 categories instead of combat-only.
function tribeCategoryMult(tribeKey, category) {
  if (!category) return 1;
  return 1 + Math.min(tribes.tribeAttributePower(tribeKey, category) * tribes.WAR_ATTR_SCALE, tribes.WAR_ATTR_CAP);
}
function arenaAttrMult(tribeKey, arenaType) { return tribeCategoryMult(tribeKey, ARENA_TYPE_CATEGORY[arenaType]); }
// Downtime runs only calm, low-interaction, async-friendly games (no reflex/crowd types like reaction race,
// and no Blitz — owner, 2026-08-16: Blitz measures server-wide message activity, so it only means something
// with a lot of people online, which downtime's quiet hours are specifically NOT).
const DOWNTIME_TYPES = ['scramble', 'reverse'];
// Regular (peak-window-but-not-true-peak) pool: everything except Blitz, which is reserved for true peak.
const REGULAR_TYPES = ARENA_ALL_TYPES.filter(t => t !== 'blitz');
const DOWNTIME_TREASURY_MULT = 2;   // downtime wins bank 2x Treasury but NO Glory: reward night owls, protect the crown
// Which arena mode are we in right now, in the configured timezone? 'peak' (full slate minus Blitz, tribe
// pings), 'downtime' (calm low-ping games, bonus treasury/no glory), or 'dead' (no events — the pre-dawn lull).
function arenaMode() {
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: config.arenaAutoTimezone, hour: '2-digit', hour12: false }));
  if (hour >= config.arenaAutoStartHour && hour < config.arenaAutoEndHour) return 'peak';
  if (hour >= config.arenaDowntimeStartHour && hour < config.arenaDowntimeEndHour) return 'downtime';
  return 'dead';
}
// TRUE PEAK (owner, 2026-08-16): a narrower slice INSIDE the peak window — the busiest realistic overlap
// across regions. Only meaningful when arenaMode() === 'peak'; a separate check rather than a 4th arenaMode
// value since it's a sub-tier of peak, not a distinct top-level window.
function isTruePeakHour() {
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: config.arenaAutoTimezone, hour: '2-digit', hour12: false }));
  return hour >= config.arenaTruePeakStartHour && hour < config.arenaTruePeakEndHour;
}
// Auto-start (owner: "have the bot start them randomly"). Called on a ~15-min tick: pick the mode; if dead do
// nothing; otherwise, if nothing's running, under the daily cap, and the randomly-scheduled next-auto time has
// passed, launch a random type (calm subset in downtime, full slate incl. Blitz only in true peak). recordEnd
// schedules the next one with a tier-aware random gap (1h..2h true peak, 2h..3.5h regular, 3h..5h downtime).
// Manual starts still work anytime (subject to the 1.5h floor).
async function maybeAutoStartArena(guild) {
  if (!config.arenaAutoStart) return;
  const mode = arenaMode();
  if (mode === 'dead') return;
  if (arena.startBlocked()) return;        // already running/lobby, under the 1.5h floor, or daily cap reached
  if (!arena.autoStartDue(Date.now())) return;   // the randomly-scheduled next-auto time hasn't arrived yet
  if (!eventPacing.combinedGapMet(Date.now())) return;   // something else (sealed/trial) ran too recently
  const downtime = mode === 'downtime';
  const truePeak = mode === 'peak' && isTruePeakHour();
  const fullPool = downtime ? DOWNTIME_TYPES : (truePeak ? ARENA_ALL_TYPES : REGULAR_TYPES);
  // A type can't come back around until roughly half the pool has cycled through (not just avoiding an
  // immediate back-to-back repeat) — owner: "shouldn't repeat until half the games have been done."
  const pool = arena.excludeRecent(fullPool, arena.getHistory());
  const type = pool[Math.floor(Math.random() * pool.length)];
  try {
    await startArenaCountdown(guild, type, ARENA_DEFAULTS[type] || 5, client.user.id, downtime, truePeak);
    console.log(`[arena] auto-started ${type}${downtime ? ' (downtime)' : truePeak ? ' (true peak)' : ''}`);
  } catch (e) { console.error('[arena] auto-start:', e.message); }
}

async function arenaChannel(guild) { const a = arena.get(); if (!a) return null; return guild.channels.fetch(a.channelId).catch(() => null); }
function tribeName(key) { const t = tribes.get(key); return t ? `${t.emoji || '🏴'} ${t.shortName || t.name}` : key; }

// A challenge no longer starts the instant the button is clicked. Instead we announce a 5-minute "get ready"
// LOBBY (owner) — a general ping in tribe-announcements + a per-tribe heads-up in each throne — then beginArena
// actually launches the game. The lobby throne pings double as the event pings and are cleaned up at endArena.
async function startArenaCountdown(guild, type, minutes, startedById, downtime = false, truePeak = false) {
  const channel = await ensureArenaChannel(guild, config);
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
  arena.set({ type, minutes, phase: 'lobby', channelId: channel.id, startedBy: startedById, startsAt, downtime, truePeak,
    lobbyMessageId: lobby ? lobby.id : null, thronePings, scores: {}, participants: [] });
  eventPacing.recordEvent(Date.now());
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
  const channel = await guild.channels.fetch(pending.channelId).catch(() => null) || await ensureArenaChannel(guild, config);
  if (!channel) { console.error('[arena] begin: no tribe-announcements channel'); return; }
  if (arena.TYPED_TYPES.includes(type)) await channel.permissionOverwrites.edit(guild.id, { SendMessages: true }, { reason: 'arena typed round: allow answers' }).catch(() => {});
  const endsAt = Date.now() + minutes * 60000;
  // Preserve the lobby-created state (throne pings, lobby message, base scores) into the LIVE state.
  const base = { type, minutes, phase: 'live', channelId: channel.id, startedBy: pending.startedBy,
    startedAt: Date.now(), endsAt, scores: pending.scores || {}, participants: pending.participants || [],
    thronePings, lobbyMessageId: pending.lobbyMessageId || null, downtime: pending.downtime || false, truePeak: pending.truePeak || false };
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
    // We fetch a few EXTRA questions and then freshenQuestions() trims to the target count, dropping ones asked
    // in recent games (cross-game de-dup, owner ask) — the extra headroom is what lets the trim actually remove
    // repeats rather than just reorder. Pattern is generated (effectively infinite), so it needs no de-dup.
    let questions = [], source = 'local';
    if (type === 'truefalse') { const f = await arena.fetchBoolean(arena.TF_QUESTIONS + 6); const qs = (f && f.length) ? f : arena.localBoolean(arena.TF_QUESTIONS); questions = arena.freshenQuestions('tf', qs, arena.TF_QUESTIONS); source = f ? 'online' : 'local'; }
    else if (type === 'pattern') { questions = arena.genPattern(arena.PATTERN_QUESTIONS); source = 'generated'; }
    else { const cat = arena.TRIVIA_CATEGORY[type]; const f = await arena.fetchTrivia(arena.TRIVIA_QUESTIONS + 6, cat); const qs = (f && f.length) ? f : arena.localTrivia(arena.TRIVIA_QUESTIONS, []); questions = arena.freshenQuestions(type, qs, arena.TRIVIA_QUESTIONS); source = f ? 'online' : 'local'; }   // trivia + themed quizzes
    arena.set({ ...base, questions, qNum: 0, source });
    await askNextTrivia(guild);
  } else if (type === 'reaction' || type === 'reactionhard') {
    // Reaction Rush: each round targets one emoji; the messageReactionAdd hook scores the first tribe member
    // to react and posts the next round. postReactionRound handles both the first round and each advance.
    // Hard mode (reactionhard): the bot does NOT pre-add the target, and surrounds it with decoy reactions,
    // so players have to spot the right one among several instead of one-tapping the only reaction present.
    arena.set({ ...base, used: [], round: 0, hard: type === 'reactionhard' });
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
  math: 'Math Sprint', typing: 'Fast Fingers', riddle: 'Riddle Rush', emoji: 'Emoji Decode', truefalse: 'True or False', reaction: 'Reaction Rush', reactionhard: 'Reaction Rush (Hard)', pattern: 'Number Pattern',
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
// Live Tally (owner: spent an hour hand-counting reactions after an event; some participants aren't in a
// tribe at all but still need to be in the running for the event's own winner). An Event Organizer or mod
// reacts with tally.POINT_EMOJI on a participant's OWN message, posted in the event chat channel, to award
// them a point. That's tracked TWO ways: an individual tally for EVERY scorer (tribe or not — this decides
// the event's overall winner) and a tribe tally (tribe members only — feeds that tribe's Treasury via
// /tribe-admin grant, same as before). The live-standings post goes in the events ANNOUNCEMENT channel
// (view-only for regular members), separate from the event CHAT channel where scoring reactions happen.
const EVENT_ANNOUNCE_CH = process.env.FUBU_EVENT_ANNOUNCE_CHANNEL_ID || '1531011015519637534';   // 📅┆events
const EVENT_CHAT_CH = process.env.FUBU_EVENT_CHAT_CHANNEL_ID || '1532091443387043851';           // 🎉┆event-chat
const TIDES_PER_TALLY_POINT = 3;   // personal Tides for each point awarded to a tribe member, same rate as an arena point
function tallyContent(a) {
  const tribeRows = tribes.all().map(t => `> ${t.emoji || '🏴'} ${tribeName(t.key)} — **${(a.counts || {})[t.key] || 0}**`).join('\n');
  const ranked = tally.topMembers(a, 5);
  const memberRows = ranked.length ? ranked.map(([uid, n], i) => `${i + 1}. <@${uid}> — **${n}**`).join('\n') : '_no scores yet_';
  return `# 📊 Live Tally — LIVE\nReact ${tally.POINT_EMOJI} on a participant's own message in <#${a.scoreChannelId}> to add them a point (tribe or not — this decides the event's winner).\n\n**🏴 Tribes (Treasury):**\n${tribeRows}\n\n**🏆 Individual standings:**\n${memberRows}`;
}
async function startTally(guild, startedById) {
  if (tally.isActive()) return { ok: false, error: 'A live tally is already running.' };
  const announceCh = await guild.channels.fetch(EVENT_ANNOUNCE_CH).catch(() => null);
  const scoreCh = await guild.channels.fetch(EVENT_CHAT_CH).catch(() => null);
  if (!announceCh || !scoreCh) return { ok: false, error: "Couldn't find the events announcement or event-chat channel." };
  const a = { announceChannelId: announceCh.id, scoreChannelId: scoreCh.id, counts: {}, memberCounts: {}, startedById, startedAt: Date.now() };
  const msg = await announceCh.send({ content: tallyContent(a) }).catch(() => null);
  if (!msg) return { ok: false, error: "Couldn't post the tally message." };
  a.standingsMessageId = msg.id;
  tally.set(a);
  return { ok: true };
}
async function endTally(guild) {
  const a = tally.get(); if (!a) return { ok: false, error: 'No live tally is running.' };
  const ch = await guild.channels.fetch(a.announceChannelId).catch(() => null);
  let topTribe = 0; for (const v of Object.values(a.counts || {})) if (v > topTribe) topTribe = v;
  const tribeWinners = tribes.all().filter(t => ((a.counts || {})[t.key] || 0) === topTribe && topTribe > 0);
  const tribeRows = tribes.all().map(t => `> ${t.emoji || '🏴'} ${tribeName(t.key)} — **${(a.counts || {})[t.key] || 0}**`).join('\n');
  const tribeWinLine = tribeWinners.length ? `\n🏴 **Top tribe:** ${tribeWinners.map(t => tribeName(t.key)).join(' & ')}.` : '';
  const ranked = tally.topMembers(a, 10);
  const topScore = ranked.length ? ranked[0][1] : 0;
  const memberWinners = ranked.filter(([, n]) => n === topScore && topScore > 0).map(([uid]) => uid);
  const memberRows = ranked.length ? ranked.map(([uid, n], i) => `${i + 1}. <@${uid}> — **${n}**`).join('\n') : '_no scores_';
  const winLine = memberWinners.length ? `\n🏆 **Event winner:** ${memberWinners.map(id => `<@${id}>`).join(' & ')} with **${topScore}** point${topScore === 1 ? '' : 's'}.` : '';
  if (ch) await ch.send({ content: `# 📊 Live Tally — final\n**🏴 Tribes (Treasury):**\n${tribeRows}${tribeWinLine}\n\n**🏆 Individual standings:**\n${memberRows}${winLine}\n-# Award Treasury/Glory manually with \`/tribe-admin grant\` if the tribe tally decides the event too.`, allowedMentions: { parse: [] } }).catch(() => {});
  tally.clear();
  return { ok: true };
}
// Reaction Rush: post the next round — a message asking players to click the target emoji, with the bot
// pre-adding it so it's one tap. Storing the round # lets a late reaction on an old round be ignored.
async function postReactionRound(guild) {
  const a = arena.get(); if (!a || (a.type !== 'reaction' && a.type !== 'reactionhard')) return;
  const ch = await arenaChannel(guild); if (!ch) return;
  const target = arena.nextReaction(a.used || []);
  const round = (a.round || 0) + 1;
  const hard = !!a.hard;
  const label = hard ? '⚡ Reaction Rush (Hard) — round' : '⚡ Reaction Rush — round';
  const prompt = hard
    ? `# ${label} ${round}\nFind and react with ${target} among the reactions below to score for your tribe. Go!\n\n${arenaScoreboard(a)}`
    : `# ${label} ${round}\nFirst tribe member to react with ${target} scores for their tribe. Go!\n\n${arenaScoreboard(a)}`;
  const msg = await ch.send({ content: prompt }).catch(() => null);
  if (!msg) return;
  arena.update({ messageId: msg.id, target, round, used: [...(a.used || []), target].slice(-12), reactionOpen: true });
  if (hard) {
    // Decoys go on first (shuffled with the target's position), so the target isn't reliably "the last one added".
    const decoys = arena.pickDecoys(target, 4 + Math.floor(Math.random() * 3));   // 4-6 decoys
    const order = arena.shuffle([target, ...decoys]);
    for (const e of order) await msg.react(e).catch(() => {});
  } else {
    await msg.react(target).catch(() => {});
  }
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
  let a = arena.get(); if (!a) return;
  if (a.phase === 'suddendeath') return;   // a tiebreaker is already live; its own resolver will finalize (guards the end-timer)
  clearArenaTimers();
  // Blitz is tallied now, from message history over the whole window (owner: count at the end). Per-member
  // counts also drive personal Tides + the MVP, same as the interactive types earn via scoreArena.
  if (a.type === 'blitz') {
    const { scores, memberCounts } = await computeBlitzScores(guild, a.startedAt, a.endsAt).catch(() => ({ scores: {}, memberCounts: {} }));
    const ms = {};
    for (const [uid, info] of Object.entries(memberCounts)) {
      ms[uid] = info.n;
      tribes.addTides(info.key, uid, TIDES_PER_ARENA_POINT * info.n, 'combat');
      const daily = tribes.recordArenaPlay(uid, Date.now());
      if (daily.firstToday) tribes.addTides(info.key, uid, ARENA_DAILY_BONUS_TIDES, 'combat');
    }
    arena.update({ scores, memberScores: ms }); a = arena.get();
  }
  // Tie check: if 2+ tribes share the highest score, run a SUDDEN-DEATH tiebreaker rather than silently
  // handing it to whoever happened to score first (the old winner() behaviour). sdDone guards the loop.
  const scores = a.scores || {};
  let top = 0; for (const v of Object.values(scores)) if (v > top) top = v;
  const tied = Object.keys(scores).filter(k => scores[k] === top);
  if (top > 0 && tied.length > 1 && !a.sdDone) return startSuddenDeath(guild, tied, top);
  return finalizeArena(guild, arena.winner());
}
// Kick off a sudden-death round among the tied tribes: first member of a tied tribe to react wins it all.
// Reaction-based (no answer to validate) so it's simple + fair; falls back to first place if nobody reacts.
async function startSuddenDeath(guild, tied, top) {
  clearArenaTimers();
  const a = arena.get(); if (!a) return;
  const ch = await arenaChannel(guild);
  // The scoring game is over; if a typed round had opened the channel, re-lock it now.
  if (arena.TYPED_TYPES.includes(a.type) && ch) await ch.permissionOverwrites.edit(guild.id, { SendMessages: false }, { reason: 'arena over, sudden death' }).catch(() => {});
  const target = '🔥';
  const roleIds = tied.map(k => tribes.get(k)?.roleId).filter(Boolean);
  let msg = null;
  if (ch) msg = await ch.send({ content: `# ⚡ Sudden death!\nTied at **${top}**: ${tied.map(k => tribeName(k)).join(' vs ')}.\nFirst member of a tied tribe to react ${target} on this message takes it all. Go!\n${roleIds.map(r => `<@&${r}>`).join(' ')}`, allowedMentions: { roles: roleIds } }).catch(() => null);
  if (msg) await msg.react(target).catch(() => {});
  arena.update({ phase: 'suddendeath', sdTied: tied, sdTop: top, sdTarget: target, sdMessageId: msg ? msg.id : null });
  _arenaTimers.sd = setTimeout(() => resolveSuddenDeath(guild, null).catch(e => console.error('[arena] sd timeout:', e.message)), ARENA_SD_MS);
}
// Resolve sudden death: winnerKey from the first valid reaction, or null on timeout (falls back to first place).
async function resolveSuddenDeath(guild, winnerKey) {
  const a = arena.get();
  if (!a || a.phase !== 'suddendeath') return;   // already resolved or gone
  if (_arenaTimers.sd) { clearTimeout(_arenaTimers.sd); _arenaTimers.sd = null; }
  arena.update({ phase: 'resolving', sdDone: true });   // synchronous flip: blocks a second reaction from double-resolving
  const tied = a.sdTied || [];
  const viaReaction = !!(winnerKey && tied.includes(winnerKey));
  const key = viaReaction ? winnerKey : tied[0];   // nobody reacted in time -> the tribe that reached the top first
  const score = (a.scores && a.scores[key]) || a.sdTop || 0;
  return finalizeArena(guild, key ? { key, score } : null, viaReaction ? ' in sudden death' : ' (sudden death — no reaction, tiebreak to first place)');
}
// Award, announce + tear down an arena for a decided winner (or null = nobody scored). Split out of endArena so
// both the normal path and the sudden-death resolver share one finalize. `note` decorates the win headline.
async function finalizeArena(guild, win, note = '') {
  clearArenaTimers();
  const a = arena.get(); if (!a) return;
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
    const attrMult = arenaAttrMult(win.key, a.type);
    const treas = Math.round(arena.WIN_TREASURY * mult * attrMult * (dt ? DOWNTIME_TREASURY_MULT : 1));
    const glory = dt ? 0 : Math.round(arena.WIN_GLORY * mult * attrMult);
    tribes.addTreasury(win.key, treas);
    if (glory) tribes.addGlory(win.key, glory);
    const notes = [];
    if (mult > 1) notes.push(`underdog ×${mult}`);
    if (attrMult > 1) notes.push(`attribute ×${attrMult.toFixed(2)}`);
    if (dt) notes.push(`downtime treasury ×${DOWNTIME_TREASURY_MULT}, no Glory`);
    const bonusNote = notes.length ? ` (${notes.join('; ')})` : '';
    resultText = `# 🏆 ${label}: ${tribeName(win.key)} wins${note}!\nScored **${win.score}**. Banked **+${treas} Treasury**${glory ? ` and **+${glory} Glory**` : ''}${bonusNote}.\n\n${arenaScoreboard(a)}`;
    { const wt = tribes.get(win.key); lore.record({ type: 'arena', title: `${wt?.shortName || wt?.name || win.key} won a ${label}`, tribes: [win.key], score: win.score }); }
    checkTribeQuests(guild, win.key).catch(() => {});
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
    if (mvpTribe) tribes.addTides(mvpTribe.key, mvp.userId, ARENA_MVP_BONUS_TIDES, 'combat');
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
  const gapTier = a.downtime ? 'downtime' : a.truePeak ? 'truepeak' : 'regular';
  arena.recordEnd(Date.now(), gapTier, a.type);   // stamp end + schedule the next auto (tier-aware gap)
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
  // A sudden-death tiebreaker (or its resolution) was cut off by the restart — resolve it deterministically now
  // (fall back to first place) so the arena can't get stuck mid-tiebreak.
  if (a.phase === 'suddendeath' || a.phase === 'resolving') {
    console.log('[arena] resolving interrupted sudden-death on boot');
    arena.update({ sdDone: true });
    return finalizeArena(guild, arena.winner(), a.phase === 'suddendeath' ? ' (sudden death, resolved on restart)' : '').catch(e => console.error('[arena] boot sd:', e.message));
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

// ==== SEALED ARENA (spec: SEALED_ARENA_SPEC.md) =========================================================
// Every tribe runs the SAME live challenge at the same time, blind, in its own throne. LOCKSTEP: one shared
// round timer advances all thrones together; within a round each throne scores its own first correct answer
// against the CLOCK (race-the-clock, so a small sharp tribe can beat a big one). Reveal via the spectacle queue.
const SEALED_QUESTIONS = 6;             // questions per sealed arena
const SEALED_ROUND_MS = 20000;          // time per question (shared across all thrones)
const SEALED_FAST_MS = 2000;            // answer within this (relative to the throne's prompt) = full speed points
const SEALED_CORRECT_PTS = 100;         // flat points for a correct answer
const SEALED_SPEED_MAX = 100;           // max speed bonus, decaying linearly FAST_MS..ROUND_MS
const SEALED_DAILY_CAP = 2;             // was 3 (owner, 2026-08-09: events were firing too often)
const SEALED_MIN_GAP_MS = 4.5 * 3600000;  // at least 4.5h between sealed arenas (was 3h)
const SEALED_LOBBY_MS = 5 * 60000;      // "gather in your throne" countdown before the first round (matches the arena)
const _sealedTimers = { start: null, round: null };
// Bridges /tribe panel's Edit Lore modal 1 -> modal 2 (a modal submit can't directly showModal() a second
// one — Discord requires a button/select interaction in between). Keyed by `${userId}:${tribeKey}`, short-lived.
const _loreStash = new Map();
function clearSealedTimers() { for (const k of ['start', 'round']) if (_sealedTimers[k]) { clearTimeout(_sealedTimers[k]); _sealedTimers[k] = null; } }
// The 13 timing-precise types (button + typed); reaction + blitz excluded (no precise tap-time / not a race).
function sealedGamePool() { return [...arena.BUTTON_TYPES, ...arena.TYPED_TYPES]; }
// Build ONE question set shared by every throne (identical questions), de-duped for freshness.
async function buildSealedQuestions(type) {
  if (arena.BUTTON_TYPES.includes(type)) {
    let qs;
    if (type === 'truefalse') { const f = await arena.fetchBoolean(SEALED_QUESTIONS + 4); qs = arena.freshenQuestions('tf', (f && f.length) ? f : arena.localBoolean(SEALED_QUESTIONS), SEALED_QUESTIONS); }
    else if (type === 'pattern') { qs = arena.genPattern(SEALED_QUESTIONS); }
    else { const cat = arena.TRIVIA_CATEGORY[type]; const f = await arena.fetchTrivia(SEALED_QUESTIONS + 4, cat); qs = arena.freshenQuestions(type, (f && f.length) ? f : arena.localTrivia(SEALED_QUESTIONS, []), SEALED_QUESTIONS); }
    return { kind: 'button', items: (qs || []).slice(0, SEALED_QUESTIONS) };
  }
  const used = [], items = [];
  for (let i = 0; i < SEALED_QUESTIONS; i++) { const nx = arena.nextTyped(type, used); used.push(nx.key); items.push({ display: nx.display, answer: String(nx.answer) }); }
  return { kind: 'typed', items };
}
function sealedRenderButton(type, item, qNum, tribeKey) {
  const label = ARENA_LABEL[type] || 'Challenge';
  const row = new ActionRowBuilder().addComponents(item.options.map((o, i) =>
    new ButtonBuilder().setCustomId(`sealedans:${tribeKey}:${qNum}:${i}`).setLabel(String(o).slice(0, 80) || '?').setStyle(ButtonStyle.Secondary)));
  return { content: `# 🚪 Sealed Arena, ${label}\nRound **${qNum + 1}/${SEALED_QUESTIONS}**. First to answer scores for the tribe; faster = more points.\n\n**${item.q}**`, components: [row], allowedMentions: { parse: [] } };
}
function sealedRenderTyped(type, item, qNum) {
  const label = ARENA_LABEL[type] || 'Challenge';
  let prompt = item.display;
  if (type === 'scramble') prompt = arena.scrambleWord(item.display).toUpperCase();
  const how = type === 'scramble' ? 'Unscramble and type it' : type === 'reverse' ? 'Type it the right way' : type === 'emoji' ? 'Type what it spells' : type === 'math' ? 'Type the answer' : 'Type your answer';
  return { content: `# 🚪 Sealed Arena, ${label}\nRound **${qNum + 1}/${SEALED_QUESTIONS}**. ${how}. First correct scores; faster = more points.\n## \`${prompt}\``, allowedMentions: { parse: [] } };
}
// Coordinated start: the same challenge drops in every throne at once. Returns {ok, gameType} or {ok:false,error}.
async function startSealedArena(guild, { type, startedById } = {}) {
  if (!features.enabled('sealedArena')) return { ok: false, error: 'Sealed Arena is not enabled.' };
  if (sealed.isActive()) return { ok: false, error: 'A Sealed Arena is already running.' };
  if (arena.isActive()) return { ok: false, error: 'Wait for the current Arena to finish first.' };
  const pool = sealedGamePool();
  // Auto-picks (no explicit type) exclude roughly half the pool's worth of most-recently-played games, so
  // a type can't repeat until the "deck" is half cycled — not just avoiding an immediate repeat. An
  // explicit type (manual /sealedarena start) is always honored as requested.
  const autoPool = arena.excludeRecent(pool, sealed.gameHistory());
  const gameType = type && pool.includes(type) ? type : autoPool[Math.floor(Math.random() * autoPool.length)];
  const withThrone = tribes.all().filter(t => t.throneId);
  if (withThrone.length < 2) return { ok: false, error: 'Need at least two tribes with thrones.' };
  const set = await buildSealedQuestions(gameType);
  if (!set.items.length) return { ok: false, error: 'Could not build the question set.' };
  const thrones = {};
  for (const t of withThrone) {
    const ch = await guild.channels.fetch(t.throneId).catch(() => null); if (!ch) continue;
    // NOTE: typed-answer SendMessages perms are opened in beginSealedArena (at first round), NOT now, so the
    // throne stays locked during the lobby countdown.
    thrones[t.key] = { channelId: t.throneId, promptMessageId: null, promptTs: 0, qNum: 0, done: false, score: 0, correct: 0, contributors: {}, answered: false };
  }
  if (Object.keys(thrones).length < 2) return { ok: false, error: 'Could not reach enough thrones.' };
  const startsAt = Date.now() + SEALED_LOBBY_MS;   // LOBBY: rally now, the first round drops after the countdown
  sealed.set({ mode: 'sealed', gameType, kind: set.kind, items: set.items, startedAt: Date.now(), startsAt, phase: 'lobby', thrones, startedById: startedById || null });
  sealed.bumpDaily(Date.now(), gameType);   // count the launch immediately (daily cap + min-gap start from now)
  eventPacing.recordEvent(Date.now());
  await Promise.all(Object.keys(thrones).map(async (k) => {
    const th = thrones[k]; const ch = await guild.channels.fetch(th.channelId).catch(() => null); const t = tribes.get(k);
    if (ch) await ch.send({ content: `# 🚪 Sealed Arena begins <t:${Math.floor(startsAt / 1000)}:R>!\n${t?.roleId ? `<@&${t.roleId}>` : 'Your tribe'}, gather here now — in about **${Math.round(SEALED_LOBBY_MS / 60000)} minutes** it's ${SEALED_QUESTIONS} rounds, blind against every other tribe. Answer fast. Results are revealed to everyone at the end.`, allowedMentions: { roles: t?.roleId ? [t.roleId] : [] } }).catch(() => {});
  }));
  clearSealedTimers();
  _sealedTimers.start = setTimeout(() => beginSealedArena(guild).catch(e => console.error('[sealed] begin:', e.message)), SEALED_LOBBY_MS);
  return { ok: true, gameType };
}
// Lobby countdown elapsed: open typed-answer perms (if needed), go live, drop the first round.
async function beginSealedArena(guild) {
  const a = sealed.get(); if (!a || a.mode !== 'sealed') return;
  if (a.kind === 'typed') {
    for (const th of sealed.thronesArr()) {
      const ch = await guild.channels.fetch(th.channelId).catch(() => null);
      if (!ch) continue;
      await ch.permissionOverwrites.edit(guild.id, { SendMessages: true }, { reason: 'sealed arena: typed answers' }).catch(() => {});
      // The throne's own tribe base role carries its OWN explicit SendMessages deny (separate from
      // @everyone, and more specific — it wins for anyone holding the role), so opening @everyone alone
      // never actually let regular tribe members type. Found 2026-08-08: "people can't type in their
      // thrones for the sealed arena."
      const t = tribes.get(th.tribeKey);
      if (t?.roleId) await ch.permissionOverwrites.edit(t.roleId, { SendMessages: true }, { reason: 'sealed arena: typed answers' }).catch(() => {});
    }
  }
  sealed.update({ phase: 'live' });
  await sealedRound(guild);
}
// Send the current question to every throne at once, capture each throne's own prompt timestamp, arm the shared
// round timer.
async function sealedRound(guild) {
  const a = sealed.get(); if (!a) return;
  clearSealedTimers();
  const first = sealed.thronesArr()[0]; if (!first) return finishSealedArena(guild);
  const qNum = first.qNum;
  if (qNum >= a.items.length) return finishSealedArena(guild);
  const item = a.items[qNum];
  await Promise.all(sealed.thronesArr().map(async (th) => {
    const ch = await guild.channels.fetch(th.channelId).catch(() => null); if (!ch) return;
    const payload = a.kind === 'button' ? sealedRenderButton(a.gameType, item, qNum, th.tribeKey) : sealedRenderTyped(a.gameType, item, qNum);
    const msg = await ch.send(payload).catch(() => null);
    sealed.updateThrone(th.tribeKey, { promptMessageId: msg ? msg.id : null, promptTs: msg ? msg.createdTimestamp : Date.now(), answered: false, perQ: [] });
  }));
  _sealedTimers.round = setTimeout(() => sealedAdvance(guild).catch(e => console.error('[sealed] advance:', e.message)), SEALED_ROUND_MS);
}
async function sealedAdvance(guild) {
  const a = sealed.get(); if (!a) return;
  if (a.kind === 'button') for (const th of sealed.thronesArr()) {
    if (!th.promptMessageId) continue;
    const ch = await guild.channels.fetch(th.channelId).catch(() => null);
    const pm = ch && await ch.messages.fetch(th.promptMessageId).catch(() => null);
    if (pm) await pm.edit({ components: [] }).catch(() => {});
  }
  for (const th of sealed.thronesArr()) sealed.updateThrone(th.tribeKey, { qNum: th.qNum + 1, answered: false });
  const first = sealed.thronesArr()[0];
  if (first && first.qNum >= a.items.length) return finishSealedArena(guild);
  return sealedRound(guild);
}
// Score one answer for a throne. Only the FIRST correct answer per throne per round counts. Race-the-clock.
function sealedTryScore(tribeKey, uid, answerTs, correct) {
  const th = sealed.throne(tribeKey); if (!th || th.answered || !correct) return false;
  sealed.updateThrone(tribeKey, { answered: true });
  const rel = Math.max(0, answerTs - (th.promptTs || answerTs));
  let speed = SEALED_SPEED_MAX;
  if (rel > SEALED_FAST_MS) speed = Math.max(0, Math.round(SEALED_SPEED_MAX * (1 - (rel - SEALED_FAST_MS) / (SEALED_ROUND_MS - SEALED_FAST_MS))));
  sealed.scoreThrone(tribeKey, uid, SEALED_CORRECT_PTS + speed);
  return true;
}
// Sealed Arena / Trial post their prompts directly into each participating tribe's THRONE (see sealed.js's
// per-tribe channelId, which is just tribe.throneId) — the 24h auto-expire on throne messages only helps if
// the throne isn't constantly refilled with fresh ones, which these events do by design. Bulk-delete the
// non-pinned mess a few minutes after the event actually ends instead of waiting a full day, so the throne's
// pinned Panel + Paths reference are the only thing left standing shortly after. bulkDelete silently skips
// anything older than 14 days, which never applies here (always run within minutes of the messages posting).
// Clears every non-pinned message in a channel (paginated — bulkDelete caps at 100/call), leaving the
// pinned Panel + Paths reference untouched. Used both by the timed post-event cleanup below and the
// leader-facing Clear Throne button (tribethrone_clearthrone). Returns how many messages were removed.
async function clearThroneMessages(guild, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.bulkDelete) return 0;
  let cleared = 0;
  for (let i = 0; i < 10; i++) {
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs || !msgs.size) break;
    const toDelete = [...msgs.values()].filter(m => !m.pinned);
    if (toDelete.length) {
      botdeletes.mark(toDelete.map(m => m.id));
      await ch.bulkDelete(toDelete, true).catch(e => console.error(`[throne-cleanup] ${channelId}:`, e.message));
      cleared += toDelete.length;
    }
    if (msgs.size < 100) break;
  }
  return cleared;
}
function scheduleThroneMessageCleanup(guild, channelIds, delayMs = 5 * 60000) {
  const ids = [...new Set(channelIds.filter(Boolean))];
  setTimeout(async () => { for (const chId of ids) await clearThroneMessages(guild, chId); }, delayMs);
}
async function finishSealedArena(guild) {
  clearSealedTimers();
  const a = sealed.get(); if (!a) return;
  const throneChannelIds = sealed.thronesArr().map(th => th.channelId);   // captured before sealed.clear() below
  if (a.kind === 'typed') for (const th of sealed.thronesArr()) {
    const ch = await guild.channels.fetch(th.channelId).catch(() => null); if (!ch) continue;
    await ch.permissionOverwrites.edit(guild.id, { SendMessages: false }, { reason: 'sealed arena over' }).catch(() => {});
    const t = tribes.get(th.tribeKey);
    if (t?.roleId) await ch.permissionOverwrites.edit(t.roleId, { SendMessages: false }, { reason: 'sealed arena over' }).catch(() => {});
  }
  const board = sealed.thronesArr().map(th => ({ key: th.tribeKey, score: th.score || 0, correct: th.correct || 0 })).sort((x, y) => y.score - x.score || y.correct - x.correct);
  const winner = board[0] && board[0].score > 0 ? board[0] : null;
  const label = ARENA_LABEL[a.gameType] || 'Sealed Arena';
  if (winner) {
    const mult = underdogMultiplier(guild, winner.key) * arenaAttrMult(winner.key, a.gameType);
    tribes.addTreasury(winner.key, Math.round(arena.WIN_TREASURY * 2 * mult));
    tribes.addGlory(winner.key, Math.round(arena.WIN_GLORY * 2 * mult));
    { const wt = tribes.get(winner.key); lore.record({ type: 'arena', title: `${wt?.shortName || wt?.name || winner.key} won a Sealed ${label}`, tribes: [winner.key], score: winner.score }); }
    checkTribeQuests(guild, winner.key).catch(() => {});
    await refreshThronePanel(guild, tribes.get(winner.key)).catch(() => {});
  }
  sealed.clear();
  scheduleThroneMessageCleanup(guild, throneChannelIds);
  enqueueSpectacle(SPECTACLE_PRIORITY.sealedResult, 'sealedResult', () => revealSealedArena(guild, board, winner, label));
}
async function revealSealedArena(guild, board, winner, label) {
  const ch = await getSpectacleChannel(guild); if (!ch) return;
  await ch.send({ content: `# 🚪 The Sealed Arena is decided.\n${copy.herald.open()} Behind closed doors, every tribe ran the same **${label}**. The doors open now.`, allowedMentions: { parse: [] } }).catch(() => {});
  await warSleep(2500);
  const medals = ['🥇', '🥈', '🥉'];
  for (let i = board.length - 1; i >= 0; i--) {
    await ch.send({ content: `${medals[i] || `**${i + 1}.**`} ${tribeName(board[i].key)}: **${board[i].score}** pts (${board[i].correct}/${SEALED_QUESTIONS} correct)`, allowedMentions: { parse: [] } }).catch(() => {});
    await warSleep(1800);
  }
  if (winner) { const t = tribes.get(winner.key); await ch.send({ content: `# 🏆 ${tribeName(winner.key)} take the Sealed Arena!\nSharpest behind the closed doors. ${t?.roleId ? `<@&${t.roleId}>` : ''}`, allowedMentions: { roles: t?.roleId ? [t.roleId] : [] } }).catch(() => {}); }
  else await ch.send({ content: `# 🏁 The Sealed Arena ends with no victor. No tribe scored.`, allowedMentions: { parse: [] } }).catch(() => {});
}
// Boot: a Sealed Arena in flight when we restarted is short, so resolve it immediately (resolve-on-restart).
async function reconcileSealed(guild) {
  const a = sealed.get();
  if (!a || a.mode !== 'sealed') return;   // a Trial is handled by reconcileTrial (RESUME, not resolve)
  // Restart DURING the lobby: the rounds never started, so re-arm the countdown (or begin now if it elapsed)
  // rather than resolving an event with no scores.
  if (a.phase === 'lobby') {
    const untilStart = (a.startsAt || 0) - Date.now();
    if (untilStart <= 0) { console.log('[sealed] lobby elapsed during downtime, beginning now'); return beginSealedArena(guild).catch(() => {}); }
    console.log(`[sealed] resuming lobby (${Math.round(untilStart / 1000)}s until start)`);
    clearSealedTimers();
    _sealedTimers.start = setTimeout(() => beginSealedArena(guild).catch(e => console.error('[sealed] begin:', e.message)), untilStart);
    return;
  }
  console.log('[sealed] resolving interrupted Sealed Arena on boot');
  return finishSealedArena(guild).catch(e => console.error('[sealed] boot resolve:', e.message));
}
// Auto-scheduler: hourly, fire during peak hours if enabled, under the daily cap, nothing else live, min-gap met.
// Unified with Arena's own config-driven schedule (owner, 2026-08-16) — this used to be an independent
// hardcoded UTC 15-23 window, a second clock that could drift out of sync with Arena's actual peak hours.
function sealedPeakHour() { return arenaMode() === 'peak'; }
async function sealedAutoTick(guild) {
  if (!features.enabled('sealedArena') || sealed.isActive() || arena.isActive()) return;
  if (sealed.dailyCount(Date.now()) >= SEALED_DAILY_CAP) return;
  if (Date.now() - sealed.lastRunAt() < SEALED_MIN_GAP_MS) return;
  if (!sealedPeakHour()) return;
  if (!eventPacing.combinedGapMet(Date.now())) return;   // something else (arena/trial) ran too recently
  const r = await startSealedArena(guild, {}).catch(e => { console.error('[sealed] auto start:', e.message); return null; });
  if (r && r.ok) console.log(`[sealed] auto-started (${r.gameType})`);
}

// ==== TRIBE GAMES (Phase 8) — staff-recorded tribe-vs-tribe events using external games the bot can't =====
// referee (Among Us, Roblox titles, ...). Entirely panel-initiated (/tribe panel), no auto-scheduling, no
// per-tribe slot options — every tribe's Hall gets the lobby announcement and a tribe only actually competes
// once its leader-or-staff sets a rep via the panel during the lobby window. See tribegames.js for the state
// module + GAME_CATALOG (the per-game result format).
const TRIBEGAME_LOBBY_MS = 5 * 60000;   // same 5-min lobby as Arena/Sealed
const _tribeGameTimers = { start: null };
function clearTribeGameTimers() { if (_tribeGameTimers.start) { clearTimeout(_tribeGameTimers.start); _tribeGameTimers.start = null; } }

async function startTribeGame(guild, { gameId, startedById }) {
  if (tribegames.isActive()) return { ok: false, error: 'A Tribe Game is already running.' };
  const catalog = tribegames.GAME_CATALOG[gameId];
  if (!catalog) return { ok: false, error: 'Unknown game.' };
  const startsAt = Date.now() + TRIBEGAME_LOBBY_MS;
  tribegames.set({ gameId, format: catalog.format, startedAt: Date.now(), startsAt, phase: 'lobby', entrants: {}, startedById });
  const withThrone = tribes.all().filter(t => t.throneId || t.hallId);
  await Promise.all(withThrone.map(async (t) => {
    const chId = t.hallId || t.throneId;
    const ch = await guild.channels.fetch(chId).catch(() => null); if (!ch) return;
    await ch.send({
      content: `# 🎮 Tribe Games: ${catalog.label}!\n${t.roleId ? `<@&${t.roleId}>` : 'Your tribe'}, want in? Your ${tribes.leaderTitle(t)} (or staff) has **${Math.round(TRIBEGAME_LOBBY_MS / 60000)} minutes** to set your rep via \`/tribe panel\` before it locks in.`,
      allowedMentions: { roles: t.roleId ? [t.roleId] : [] },
    }).catch(() => {});
  }));
  tribegames.recordStart(Date.now());
  eventPacing.recordEvent(Date.now());
  clearTribeGameTimers();
  _tribeGameTimers.start = setTimeout(() => beginTribeGame(guild).catch(e => console.error('[tribegames] begin:', e.message)), TRIBEGAME_LOBBY_MS);
  return { ok: true };
}
// Auto-start (owner, 2026-08-17: "they just weren't running automatically" — unlike Arena/Sealed/Trial,
// Tribe Games had no scheduler at all, staff had to remember to launch one from /tribe panel). Only fires
// during peak hours (needs real people around to set a rep and then actually go play), picks a random
// catalog entry, and respects both its own wider auto-gap and the shared cross-system pacing floor.
async function maybeAutoStartTribeGame(guild) {
  if (!config.tribeGamesAutoStart) return;
  if (arenaMode() !== 'peak') return;
  if (tribegames.isActive()) return;
  if (!tribegames.autoStartDue(Date.now())) return;
  if (!eventPacing.combinedGapMet(Date.now())) return;
  const ids = Object.keys(tribegames.GAME_CATALOG);
  const gameId = ids[Math.floor(Math.random() * ids.length)];
  try {
    const r = await startTribeGame(guild, { gameId, startedById: client.user.id });
    if (r.ok) console.log(`[tribegames] auto-started ${gameId}`);
  } catch (e) { console.error('[tribegames] auto-start:', e.message); }
}
async function beginTribeGame(guild) {
  const a = tribegames.get(); if (!a || a.phase !== 'lobby') return;
  const keys = tribegames.entrantTribeKeys();
  if (keys.length < 2) {
    tribegames.clear();
    const ch = await getSpectacleChannel(guild).catch(() => null);
    if (ch) await ch.send({ content: `🎮 Tribe Games (${tribegames.GAME_CATALOG[a.gameId]?.label || a.gameId}) called off — fewer than 2 tribes set a rep in time.`, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }
  tribegames.update({ phase: 'live' });
  const names = keys.map(k => tribeName(k)).join(' vs ');
  const ch = await getSpectacleChannel(guild).catch(() => null);
  if (ch) await ch.send({ content: `# 🎮 Tribe Games: ${tribegames.GAME_CATALOG[a.gameId]?.label} is LIVE!\n${names}. Go play — staff will record the result with \`/tribe panel\` once it's done.`, allowedMentions: { parse: [] } }).catch(() => {});
}
// Boot-resume: same shape as reconcileSealed above.
async function reconcileTribeGames(guild) {
  const a = tribegames.get(); if (!a) return;
  if (a.phase === 'lobby') {
    const untilStart = (a.startsAt || 0) - Date.now();
    clearTribeGameTimers();
    if (untilStart <= 0) { console.log('[tribegames] lobby elapsed during downtime, beginning now'); return beginTribeGame(guild).catch(() => {}); }
    console.log(`[tribegames] resuming lobby (${Math.round(untilStart / 1000)}s until start)`);
    _tribeGameTimers.start = setTimeout(() => beginTribeGame(guild).catch(e => console.error('[tribegames] begin:', e.message)), untilStart);
  }
  // phase === 'live': nothing to resume — staff hasn't reported a result yet, no timer was pending.
}

// The rotating individual reward role for a Tribe Game's winning rep(s) — same create-once/strip-then-grant
// shape as ensureSeasonChampionRole above, but scoped to 1-2 people instead of a whole tribe roster.
async function ensureTribeGameChampionRole(guild) {
  const cached = tribegames.getChampionRoleId();
  if (cached) { const r = guild.roles.cache.get(cached) || await guild.roles.fetch(cached).catch(() => null); if (r) return r; }
  const role = await guild.roles.create({ name: '🎮 Tribe Games Champion', colors: { primaryColor: 0x57F287 }, hoist: false, mentionable: false, reason: 'Tribe Games rotating MVP role' }).catch(() => null);
  if (role) tribegames.setChampionRoleId(role.id);
  return role;
}
async function awardTribeGameRepRole(guild, repIds) {
  const role = await ensureTribeGameChampionRole(guild); if (!role) return;
  for (const m of [...role.members.values()]) await m.roles.remove(role.id, 'Tribe Games rotates').catch(() => {});
  for (const id of (repIds || [])) { const m = await guild.members.fetch(id).catch(() => null); if (m) await m.roles.add(role.id, 'Tribe Games winner').catch(() => {}); }
}

const TRIBEGAME_VERSUS_MULT = 1.5;
const TRIBEGAME_ROLE2_MULT = { rare: 2.0, common: 1.0 };                          // rare = imposter/beast side
const TRIBEGAME_ROLE3_MULT = { murderer: 2.0, decisive: 1.3, survivor: 1.0 };     // decisive = sheriff OR hero
// Pay a tribe for a Tribe Games result and log it to the world chronicle. mult is which reward tier applies
// (see TRIBEGAME_*_MULT above); roleLabel (optional) carries flavor into the lore entry, e.g. "as Hero".
function payTribeGameWin(guild, tribeKey, gameId, mult, roleLabel) {
  const attrMult = tribeCategoryMult(tribeKey, tribegames.GAME_CATALOG[gameId]?.category);
  const treas = Math.round(arena.WIN_TREASURY * mult * attrMult), glory = Math.round(arena.WIN_GLORY * mult * attrMult);
  tribes.addTreasury(tribeKey, treas); tribes.addGlory(tribeKey, glory);
  const t = tribes.get(tribeKey);
  lore.record({ type: 'tribegame', title: `${t?.shortName || t?.name || tribeKey} won a Tribe Game of ${tribegames.GAME_CATALOG[gameId]?.label || gameId}${roleLabel ? ` (${roleLabel})` : ''}`, tribes: [tribeKey], game: gameId });
  return { treas, glory };
}
// Accepts a full role name or any unique prefix (e.g. 'imp' -> 'imposter', 'm' -> 'murderer') so staff can
// type fast without memorizing exact spelling.
function normalizeRoleCode(input, roles) {
  const s = String(input || '').trim().toLowerCase();
  return roles.find(r => r === s) || roles.find(r => r.startsWith(s)) || null;
}
function buildTribeGameResultModal(active) {
  const keys = tribegames.entrantTribeKeys();
  const catalog = tribegames.GAME_CATALOG[active.gameId];
  const outcomeInput = new TextInputBuilder().setCustomId('outcome').setLabel(`Winning side (${catalog.roles.join('/')})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20);
  if (keys.length <= 4) {
    const rows = keys.map(k => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(`role:${k}`).setLabel(`${tribeName(k)} — role (${catalog.roles.join('/')})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)));
    rows.push(new ActionRowBuilder().addComponents(outcomeInput));
    return new ModalBuilder().setCustomId('tp_result_modal_std').setTitle('Report Result').addComponents(...rows);
  }
  // >4 entrant tribes (rare) — one modal still, bulk text instead of one field per tribe (modals cap at 5 fields).
  const bulk = new TextInputBuilder().setCustomId('bulk').setLabel('One "tribekey: role" per line').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
    .setPlaceholder(keys.map(k => `${k}: ${catalog.roles[0]}`).join('\n'));
  return new ModalBuilder().setCustomId('tp_result_modal_bulk').setTitle('Report Result').addComponents(new ActionRowBuilder().addComponents(bulk), new ActionRowBuilder().addComponents(outcomeInput));
}
// Reward-role recipients are the reps of whichever paid tribe(s) hit the HIGHEST multiplier this round (the
// decisive contributors), matching the plan: rare-role/murderer/decisive-role wins are the standout plays.
async function finishTribeGameRoleOutcome(guild, roleByTribe, outcomeCode) {
  const active = tribegames.get(); if (!active) return { ok: false, error: 'No active Tribe Game.' };
  const catalog = tribegames.GAME_CATALOG[active.gameId];
  const payouts = [];
  if (catalog.format === 'roleOutcome2') {
    const [rareRole, commonRole] = catalog.roles;
    for (const [k, role] of Object.entries(roleByTribe)) {
      if (role !== outcomeCode) continue;
      const mult = role === rareRole ? TRIBEGAME_ROLE2_MULT.rare : TRIBEGAME_ROLE2_MULT.common;
      payouts.push({ tribeKey: k, mult, ...payTribeGameWin(guild, k, active.gameId, mult, role) });
    }
  } else if (catalog.format === 'roleOutcome3') {
    if (outcomeCode === 'murderer') {
      for (const [k, role] of Object.entries(roleByTribe)) if (role === 'murderer') payouts.push({ tribeKey: k, mult: TRIBEGAME_ROLE3_MULT.murderer, ...payTribeGameWin(guild, k, active.gameId, TRIBEGAME_ROLE3_MULT.murderer, 'Murderer') });
    } else {
      for (const [k, role] of Object.entries(roleByTribe)) {
        if (role === 'sheriff' || role === 'hero') { const mult = TRIBEGAME_ROLE3_MULT.decisive; payouts.push({ tribeKey: k, mult, ...payTribeGameWin(guild, k, active.gameId, mult, role === 'hero' ? 'Hero' : 'Sheriff') }); }
        else if (role === 'innocent') { const mult = TRIBEGAME_ROLE3_MULT.survivor; payouts.push({ tribeKey: k, mult, ...payTribeGameWin(guild, k, active.gameId, mult, 'Innocent') }); }
      }
    }
  }
  if (payouts.length) {
    const topMult = Math.max(...payouts.map(p => p.mult));
    const repIds = payouts.filter(p => p.mult === topMult).flatMap(p => (active.entrants[p.tribeKey] || {}).repIds || []);
    if (repIds.length) await awardTribeGameRepRole(guild, repIds);
  }
  tribegames.clear();
  return { ok: true, payouts };
}
async function finishTribeGameVersus(guild, winnerKey) {
  const active = tribegames.get(); if (!active) return { ok: false, error: 'No active Tribe Game.' };
  const result = payTribeGameWin(guild, winnerKey, active.gameId, TRIBEGAME_VERSUS_MULT, null);
  const repIds = (active.entrants[winnerKey] || {}).repIds || [];
  if (repIds.length) await awardTribeGameRepRole(guild, repIds);
  tribegames.clear();
  return { ok: true, winnerKey, ...result };
}

// ==== THE TRIALS (spec: THE_TRIALS_SPEC.md) — collaborative sealed mode, evolution of the Muster ========
// Reuses the concurrent per-throne state (sealed.js). Unlike the Sealed Arena's lockstep first-to-buzz race,
// The Trials is COLLABORATIVE: any member answers any question, each throne streams questions INDEPENDENTLY
// (a faster tribe clears more), and the score is total correct x a BREADTH multiplier (distinct contributors)
// x a VC bonus (members gathered in the tribe voice channel). v1 game: The Assembly. (Relay + Mosaic to follow.)
const TRIAL_WINDOW_MS = 12 * 60000;    // the collaborative window
const TRIAL_LOBBY_MS = 5 * 60000;      // "gather in voice" countdown before the Trial actually begins (matches the arena)
const MUSTER_AUTO_CHANCE = 0.2;        // ~1 in 5 auto-Trials fire as a high-reward "grand Muster" (all tribes, bonus rewards)
const MUSTER_REWARD_MULT = 2;          // a Muster doubles the winner's Treasury/Glory payout
const TRIAL_POOL = 40;                 // big shared question list so a fast tribe won't run it dry
const TRIAL_BREADTH_PER = 0.15;        // +15% per distinct contributor beyond the first
const TRIAL_BREADTH_CAP = 2.0;         // breadth multiplier capped at 2.0x
const TRIAL_VC_PER = 0.05;             // +5% per member in the tribe VC during the Trial
const TRIAL_VC_CAP = 0.5;              // VC bonus capped at +50%
const RELAY_ROTATE_PTS = 2;            // Relay: a correct answer from a DIFFERENT member than the last scores double
const MOSAIC_TILE_PTS = 2;             // Mosaic: points per tile solved
const MOSAIC_PHRASE_PTS = 8;           // Mosaic: bonus for assembling the full hidden phrase
const TRIAL_GAMES = ['assembly', 'relay', 'mosaic'];   // scheduled Trial rotates one per day
const TRIAL_GAME_LABEL = { assembly: 'The Assembly', relay: 'The Relay', mosaic: 'The Mosaic' };
// Familiar 4–6 word sayings for The Mosaic — guessable from partial words, so a tribe can submit the full phrase
// before every tile is solved. Each word becomes one scrambled tile.
// NOTE: no single-letter words — arena.scrambleWord() recurses forever on a 1-char word (shuffle can't change it).
// buildMosaic also guards this, but keep the bank clean so tiles aren't trivial giveaways either.
const MOSAIC_PHRASES = ['the early bird catches the worm', 'better late than never', 'actions speak louder than words',
  'practice makes perfect every time', 'slow and steady wins the race', 'two wrongs do not make right',
  'do not count your chickens early', 'every dog has its day', 'great minds think alike',
  'the grass is always greener', 'strike while the iron is hot', 'never look back with regret'];
const _trialTimers = { start: null, end: null };
function clearTrialTimers() { for (const k of ['start', 'end']) if (_trialTimers[k]) { clearTimeout(_trialTimers[k]); _trialTimers[k] = null; } }
async function buildAssembly() {
  const f = await arena.fetchTrivia(TRIAL_POOL, null);
  return arena.freshenQuestions('trial', (f && f.length) ? f : arena.localTrivia(TRIAL_POOL, []), TRIAL_POOL);
}
function assemblyRender(item, qNum, tribeKey, game) {
  const row = new ActionRowBuilder().addComponents(item.options.map((o, i) =>
    new ButtonBuilder().setCustomId(`trialans:${tribeKey}:${qNum}:${i}`).setLabel(String(o).slice(0, 80) || '?').setStyle(ButtonStyle.Secondary)));
  const head = game === 'relay'
    ? `# ⚔️ The Trials, The Relay\nKeep the chain moving — when a **different** tribemate answers next, it scores **double**. Question **#${qNum + 1}**:`
    : `# ⚔️ The Trials, The Assembly\nAnswer **#${qNum + 1}** together, everyone who chips in counts:`;
  return { content: `${head}\n\n**${item.q}**`, components: [row], allowedMentions: { parse: [] } };
}
async function trialPost(guild, tribeKey) {
  const a = sealed.get(); if (!a || a.mode !== 'trial') return;
  const th = sealed.throne(tribeKey); if (!th || th.done) return;
  const item = a.items[th.qNum];
  if (!item) { sealed.updateThrone(tribeKey, { done: true }); return; }   // ran the pool dry (rare)
  const ch = await guild.channels.fetch(th.channelId).catch(() => null); if (!ch) return;
  const msg = await ch.send(assemblyRender(item, th.qNum, tribeKey, a.game)).catch(() => null);
  sealed.updateThrone(tribeKey, { promptMessageId: msg ? msg.id : null, perQ: [] });
}
// ---- The Mosaic: a grid of scrambled-word tiles; each solved tile reveals a word of a hidden phrase; solve
// enough tiles to unlock a full-phrase submit for the big bonus. Members claim tiles in PARALLEL (rewards breadth).
function buildMosaic() {
  const phrase = _pickOne(MOSAIC_PHRASES);
  // Guard: never scramble a ≤1-char word (arena.scrambleWord would recurse forever); show it as-is.
  const tiles = phrase.split(' ').map(w => ({ scrambled: (w.length > 1 ? arena.scrambleWord(w) : w).toUpperCase(), answer: w.toLowerCase() }));
  return { phrase: phrase.toLowerCase(), tiles };
}
function mosaicRender(th, tribeKey) {
  const solvedCount = th.solved.filter(Boolean).length;
  const need = Math.max(1, Math.ceil(th.tiles.length * 0.6));
  const rows = []; let row = new ActionRowBuilder();
  th.tiles.forEach((tile, i) => {
    if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(new ButtonBuilder().setCustomId(`mosaictile:${tribeKey}:${i}`)
      .setLabel(th.solved[i] ? `✅ ${tile.answer.toUpperCase()}`.slice(0, 80) : `Tile ${i + 1}`)
      .setStyle(th.solved[i] ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!!th.solved[i] || !!th.phraseSolved));
  });
  rows.push(row);
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mosaicphrase:${tribeKey}`)
    .setLabel('🧩 Solve the phrase').setStyle(ButtonStyle.Primary).setDisabled(solvedCount < need || !!th.phraseSolved)));
  const skeleton = th.tiles.map((tile, i) => th.solved[i] ? `**${tile.answer.toUpperCase()}**` : '▢'.repeat(tile.answer.length)).join('  ');
  const body = th.phraseSolved ? `🎉 Phrase solved: **${th.phrase}**` : `Phrase so far:\n${skeleton}`;
  return { content: `# ⚔️ The Trials, The Mosaic\nClaim a tile and unscramble its word — each one reveals part of the hidden phrase. Solve **${need}**+ tiles to unlock the full-phrase guess for the big points. Split them up!\n\n${body}\n-# ${solvedCount}/${th.tiles.length} tiles solved`, components: rows.slice(0, 5), allowedMentions: { parse: [] } };
}
async function mosaicPost(guild, tribeKey) {
  const a = sealed.get(); if (!a || a.mode !== 'trial' || a.game !== 'mosaic') return;
  const th = sealed.throne(tribeKey); if (!th || th.done) return;
  const ch = await guild.channels.fetch(th.channelId).catch(() => null); if (!ch) return;
  const msg = await ch.send(mosaicRender(th, tribeKey)).catch(() => null);
  if (msg) sealed.updateThrone(tribeKey, { promptMessageId: msg.id });
}
async function mosaicRefresh(guild, tribeKey) {
  const th = sealed.throne(tribeKey); if (!th || !th.promptMessageId) return;
  const ch = await guild.channels.fetch(th.channelId).catch(() => null); if (!ch) return;
  const msg = await ch.messages.fetch(th.promptMessageId).catch(() => null); if (!msg) return;
  await msg.edit(mosaicRender(th, tribeKey)).catch(() => {});
}
async function startTrial(guild, { startedById, game = 'assembly', muster = false } = {}) {
  if (!features.enabled('theTrials')) return { ok: false, error: 'The Trials aren’t enabled.' };
  if (sealed.isActive()) return { ok: false, error: 'A throne event is already running.' };
  if (arena.isActive()) return { ok: false, error: 'Wait for the current Arena to finish first.' };
  if (!TRIAL_GAMES.includes(game)) game = 'assembly';
  const withThrone = tribes.all().filter(t => t.throneId);   // always all tribes; a Muster is just the bonus variant
  if (!withThrone.length) return { ok: false, error: 'No tribes with thrones.' };
  const thrones = {};
  let items = [];
  if (game === 'mosaic') {
    // each throne gets its OWN mosaic (own phrase + tiles) so tribes can't peek at each other
    for (const t of withThrone) { const m = buildMosaic(); thrones[t.key] = { channelId: t.throneId, promptMessageId: null, done: false, score: 0, correct: 0, contributors: {}, tiles: m.tiles, solved: m.tiles.map(() => false), phrase: m.phrase, phraseSolved: false }; }
  } else {
    items = await buildAssembly();
    if (!items.length) return { ok: false, error: 'Could not build the question set.' };
    for (const t of withThrone) thrones[t.key] = { channelId: t.throneId, promptMessageId: null, qNum: 0, done: false, score: 0, correct: 0, contributors: {}, perQ: [], lastUid: null };
  }
  const startsAt = Date.now() + TRIAL_LOBBY_MS;   // LOBBY: rally now, the game itself begins after the countdown
  sealed.set({ mode: 'trial', muster: !!muster, game, kind: 'button', items, startedAt: Date.now(), startsAt, endsAt: startsAt + TRIAL_WINDOW_MS, phase: 'lobby', thrones, startedById: startedById || null });
  eventPacing.recordEvent(Date.now());
  const label = (muster ? '🪖 A grand Muster — ' : '') + (TRIAL_GAME_LABEL[game] || 'A Trial');
  const verb = game === 'mosaic' ? 'claim tiles' : 'answer';
  await Promise.all(Object.keys(thrones).map(async (k) => {
    const t = tribes.get(k); const ch = await guild.channels.fetch(t.throneId).catch(() => null);
    if (ch) await ch.send({ content: `# ⚔️ ${label} begins <t:${Math.floor(startsAt / 1000)}:R>!\n${t?.roleId ? `<@&${t.roleId}>` : 'Your tribe'}, gather in your **voice channel**${t.vcId ? ` <#${t.vcId}>` : ''} now — it starts in about **${Math.round(TRIAL_LOBBY_MS / 60000)} minutes** and runs **${Math.round(TRIAL_WINDOW_MS / 60000)} minutes**.${muster ? ' **This one is a Muster: double rewards on the line!**' : ''} Everyone who chips in counts, and more of you in voice raises your score.`, allowedMentions: { roles: t?.roleId ? [t.roleId] : [] } }).catch(() => {});
  }));
  clearTrialTimers();
  _trialTimers.start = setTimeout(() => beginTrial(guild).catch(e => console.error('[trial] begin:', e.message)), TRIAL_LOBBY_MS);
  return { ok: true, game, muster: !!muster };
}
// Lobby countdown elapsed: NOW post the actual game surface to every throne and arm the finish timer.
async function beginTrial(guild) {
  const a = sealed.get(); if (!a || a.mode !== 'trial') return;
  sealed.update({ phase: 'live' });
  for (const k of Object.keys(a.thrones || {})) await (a.game === 'mosaic' ? mosaicPost(guild, k) : trialPost(guild, k));
  clearTrialTimers();
  _trialTimers.end = setTimeout(() => finishTrial(guild).catch(e => console.error('[trial] end:', e.message)), Math.max(0, (a.endsAt || Date.now()) - Date.now()));
}
async function trialVcBonus(guild, tribeKey) {
  const t = tribes.get(tribeKey); if (!t || !t.vcId) return 0;
  const vc = await guild.channels.fetch(t.vcId).catch(() => null);
  const n = vc && vc.members ? vc.members.filter(m => !m.user.bot).size : 0;
  return Math.min(TRIAL_VC_CAP, TRIAL_VC_PER * n);
}
async function finishTrial(guild) {
  clearTrialTimers();
  const a = sealed.get(); if (!a || a.mode !== 'trial') return;
  const throneChannelIds = sealed.thronesArr().map(th => th.channelId);   // captured before sealed.clear() below
  for (const th of sealed.thronesArr()) {
    if (!th.promptMessageId) continue;
    const ch = await guild.channels.fetch(th.channelId).catch(() => null);
    const pm = ch && await ch.messages.fetch(th.promptMessageId).catch(() => null);
    if (pm) await pm.edit({ components: [] }).catch(() => {});
  }
  const game = a.game || 'assembly';
  const board = [];
  for (const th of sealed.thronesArr()) {
    const distinct = Object.keys(th.contributors || {}).length;
    const breadth = Math.min(TRIAL_BREADTH_CAP, 1 + TRIAL_BREADTH_PER * Math.max(0, distinct - 1));
    const vc = await trialVcBonus(guild, th.tribeKey);
    // Assembly scores on breadth (correct × distinct-contributor multiplier). Relay & Mosaic bake their mechanic
    // (rotation bonus / tile + phrase points) into the accumulated score already, so use that as the base.
    const base = game === 'assembly' ? (th.correct || 0) * breadth : (th.score || 0);
    board.push({ key: th.tribeKey, correct: th.correct || 0, distinct, breadth, vc, score: Math.round(base * (1 + vc)) });
  }
  board.sort((x, y) => y.score - x.score || y.correct - x.correct);
  const winner = board[0] && board[0].score > 0 ? board[0] : null;
  const isMuster = !!a.muster;
  if (winner) {
    // Trial + Muster are both group/breadth-scored events (rally together, breadth of contributors counts) —
    // always 'collective', unlike Arena/Sealed which vary per game mode.
    const mult = underdogMultiplier(guild, winner.key) * (isMuster ? MUSTER_REWARD_MULT : 1) * tribeCategoryMult(winner.key, 'collective');
    tribes.addTreasury(winner.key, Math.round(arena.WIN_TREASURY * 2 * mult));
    tribes.addGlory(winner.key, Math.round(arena.WIN_GLORY * 2 * mult));
    { const wt = tribes.get(winner.key); lore.record({ type: 'arena', title: `${wt?.shortName || wt?.name || winner.key} won ${isMuster ? 'a grand Muster' : 'a Trial'} (${TRIAL_GAME_LABEL[game] || 'The Assembly'})`, tribes: [winner.key], score: winner.score }); }
    checkTribeQuests(guild, winner.key).catch(() => {});
    await refreshThronePanel(guild, tribes.get(winner.key)).catch(() => {});
  }
  sealed.clear();
  scheduleThroneMessageCleanup(guild, throneChannelIds);
  enqueueSpectacle(SPECTACLE_PRIORITY.trialResult, 'trialResult', () => revealTrial(guild, board, winner, isMuster));
}
async function revealTrial(guild, board, winner, isMuster) {
  const ch = await getSpectacleChannel(guild); if (!ch) return;
  await ch.send({ content: `# ⚔️ ${isMuster ? '🪖 The grand Muster' : 'The Trial'} is done.\n${copy.herald.open()} The tribes rallied and answered as one.${isMuster ? ' **Double rewards were on the line.**' : ''} Here is who pulled together best.`, allowedMentions: { parse: [] } }).catch(() => {});
  await warSleep(2500);
  const medals = ['🥇', '🥈', '🥉'];
  for (let i = board.length - 1; i >= 0; i--) {
    const b = board[i];
    await ch.send({ content: `${medals[i] || `**${i + 1}.**`} ${tribeName(b.key)}: **${b.score}** (${b.correct} correct, ${b.distinct} member${b.distinct === 1 ? '' : 's'} chipped in${b.vc ? `, +${Math.round(b.vc * 100)}% voice` : ''})`, allowedMentions: { parse: [] } }).catch(() => {});
    await warSleep(1800);
  }
  if (winner) { const t = tribes.get(winner.key); await ch.send({ content: `# 🏆 ${tribeName(winner.key)} ${isMuster ? 'wins the grand Muster' : 'pulled together best'}!\n${isMuster ? 'Double Treasury and Glory banked. ' : 'Turnout wins. '}${t?.roleId ? `<@&${t.roleId}>` : ''}`, allowedMentions: { roles: t?.roleId ? [t.roleId] : [] } }).catch(() => {}); }
  else await ch.send({ content: `# 🏁 The Trial ends with no victor. Nobody answered.`, allowedMentions: { parse: [] } }).catch(() => {});
}
// The Trials RESUME on restart (long VC event people gathered for): re-arm the window for whatever's left.
async function reconcileTrial(guild) {
  const a = sealed.get(); if (!a || a.mode !== 'trial') return;
  // Restart DURING the lobby: don't post the game yet — re-arm the countdown (or begin now if it already elapsed).
  if (a.phase === 'lobby') {
    const untilStart = (a.startsAt || 0) - Date.now();
    if (untilStart <= 0) { console.log('[trial] lobby elapsed during downtime, beginning now'); return beginTrial(guild).catch(() => {}); }
    console.log(`[trial] resuming lobby (${Math.round(untilStart / 1000)}s until start)`);
    clearTrialTimers();
    _trialTimers.start = setTimeout(() => beginTrial(guild).catch(e => console.error('[trial] begin:', e.message)), untilStart);
    return;
  }
  const left = (a.endsAt || 0) - Date.now();
  if (left <= 0) { console.log('[trial] window elapsed during downtime, finishing'); return finishTrial(guild).catch(() => {}); }
  console.log(`[trial] resuming ${a.game || 'assembly'} (${Math.round(left / 1000)}s left)`);
  for (const th of sealed.thronesArr()) if (!th.done) await (a.game === 'mosaic' ? mosaicPost(guild, th.tribeKey) : trialPost(guild, th.tribeKey));
  clearTrialTimers();
  _trialTimers.end = setTimeout(() => finishTrial(guild).catch(e => console.error('[trial] end:', e.message)), left);
}
// Scheduled Trial: one a day at peak (own daily marker, separate from the sealed cap).
async function trialAutoTick(guild) {
  if (!features.enabled('theTrials') || sealed.isActive() || arena.isActive()) return;
  if (sealed.trialDoneToday(Date.now())) return;
  if (!sealedPeakHour()) return;
  if (!eventPacing.combinedGapMet(Date.now())) return;   // something else (arena/sealed) ran too recently
  sealed.markTrialDay(Date.now());
  const game = TRIAL_GAMES[Math.floor(Date.now() / 86400000) % TRIAL_GAMES.length];   // rotate one game per day
  const muster = Math.random() < MUSTER_AUTO_CHANCE;   // ~1 in 5 fire as a high-reward grand Muster
  const r = await startTrial(guild, { game, muster }).catch(e => { console.error('[trial] auto start:', e.message); return null; });
  if (r && r.ok) console.log(`[trial] auto-started (${r.muster ? 'MUSTER ' : ''}${TRIAL_GAME_LABEL[r.game] || r.game})`);
}

// ==== PROVING GROUNDS (spec: PROVING_GROUNDS_SPEC.md) — solo async daily gauntlet ======================
// Ephemeral, per-member, PER-MEMBER question draws (no shared answer to leak). One attempt per member per day;
// score feeds a daily leaderboard + a weekly Prover track (culminates + resets at the Crown boundary), and
// banks a little for your tribe. v1 game: the Knowledge Gauntlet (streak survival). Score-Attack + Puzzles TODO.
const PG_TIDES_PER = 3;              // Tides to the player per point of score (in their tribe)
const PG_TREASURY_PER = 5;           // Treasury to the player's tribe per point
const PG_GAUNTLET_MAX = 25;          // safety cap on gauntlet length
const PG_LADDER_MAX = 40;            // Score-Attack rung cap
const PG_PUZZLE_ANAGRAMS = 5;        // Anagram-Chain size (one modal, ≤5 text inputs)
const _pgRuns = new Map();           // uid -> run (in-memory; a restart abandons a run)
function pgBuiltGames() { return ['gauntlet', 'scoreattack', 'puzzle']; }   // all three throne-mode games are built
const _shuffleArr = a => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const _pickOne = a => a[Math.floor(Math.random() * a.length)];
// Short, family-friendly phrases for the Cryptogram (one shared letter-shift; decode word by word). Kept ≤5
// words so the score scale sits near the other games' (comparable daily leaderboard).
const CRYPTO_PHRASES = ['practice makes perfect', 'better late than never', 'actions speak louder', 'honesty is the best', 'knowledge is power', 'time heals all wounds', 'look before you leap', 'the early bird wins', 'slow and steady wins', 'kindness is free', 'never give up hope', 'every day is a gift'];

// per-member fresh random draw = per-member seed, so there is no single daily answer to share.
async function pgBuildGauntlet() {
  const f = await arena.fetchTrivia(PG_GAUNTLET_MAX, null);
  return (f && f.length) ? f : arena.localTrivia(PG_GAUNTLET_MAX, []);
}
// Build 4 numeric button options around a correct answer (for the math rungs of Score-Attack).
function pgMathOptions(ans) {
  const a = Number(ans); const set = new Set([a]);
  let g = 0; while (set.size < 4 && g++ < 40) { const d = a + (1 + Math.floor(Math.random() * 6)) * (Math.random() < 0.5 ? 1 : -1); if (d >= 0) set.add(d); }
  while (set.size < 4) set.add(a + set.size + 1);
  const options = _shuffleArr([...set]).map(String);
  return { options, answer: options.indexOf(String(a)) };
}
// Score-Attack: an ESCALATING ladder — tier 0 quick math + true/false, tier 1 trivia, tier 2 number patterns.
// All button-answered ({q,options,answer}) so it reuses the pg: handler. Score = rungs cleared before a miss.
async function pgBuildLadder() {
  const triv = await arena.fetchTrivia(20, null); const trivia = (triv && triv.length) ? triv : arena.localTrivia(20, []);
  const pat = arena.genPattern(14);
  const rungs = []; let ti = 0, pi = 0;
  for (let n = 0; n < PG_LADDER_MAX; n++) {
    if (n < 8) {
      if (n % 2 === 0) { const m = arena.nextMath([]); const o = pgMathOptions(m.answer); rungs.push({ q: `Rung ${n + 1}: what is \`${m.display}\`?`, options: o.options, answer: o.answer }); }
      else { const b = arena.localBoolean(1)[0]; rungs.push({ q: `Rung ${n + 1} (true or false): ${b.q}`, options: b.options, answer: b.answer }); }
    } else if (n < 26) {
      const t = trivia[ti++ % trivia.length]; rungs.push({ q: `Rung ${n + 1}: ${t.q}`, options: t.options, answer: t.answer });
    } else {
      const p = pat[pi++ % pat.length]; rungs.push({ q: `Rung ${n + 1}: ${p.q}`, options: p.options, answer: p.answer });
    }
  }
  return rungs;
}
// One Puzzles instance, per-member. Kind is fixed per DAY (so the daily leaderboard compares like for like),
// content is per-member. Anagram Chain = ≤5 scrambled words; Cryptogram = a shifted short phrase.
function pgBuildPuzzle() {
  const kind = Math.floor(Date.now() / 86400000) % 2 === 0 ? 'anagram' : 'cryptogram';
  if (kind === 'anagram') {
    const used = []; const items = [];
    for (let i = 0; i < PG_PUZZLE_ANAGRAMS; i++) { const w = arena.nextWord(used); used.push(w); items.push({ scrambled: arena.scrambleWord(w).toUpperCase(), answer: String(w).toLowerCase() }); }
    return { kind, items };
  }
  const phrase = _pickOne(CRYPTO_PHRASES);
  const shift = 1 + Math.floor(Math.random() * 25);
  const enc = phrase.toUpperCase().replace(/[A-Z]/g, c => String.fromCharCode((c.charCodeAt(0) - 65 + shift) % 26 + 65));
  const s = phrase.toUpperCase().match(/[A-Z]/)[0];
  const es = String.fromCharCode((s.charCodeAt(0) - 65 + shift) % 26 + 65);
  return { kind, encoded: enc, answer: phrase.toLowerCase(), hint: `${es} = ${s}` };
}
function pgRender(run) {
  const q = run.questions[run.idx];
  const row = new ActionRowBuilder().addComponents(q.options.map((o, i) =>
    new ButtonBuilder().setCustomId(`pg:${i}`).setLabel(String(o).slice(0, 80) || '?').setStyle(ButtonStyle.Secondary)));
  const head = run.game === 'scoreattack'
    ? `# 🏅 Proving Grounds, Score-Attack\nRungs cleared: **${run.correct}**. It keeps getting harder — one miss ends the climb.`
    : `# 🏅 Proving Grounds, Knowledge Gauntlet\nStreak: **${run.correct}**. One wrong ends your run.`;
  return { content: `${head}\n\n**${q.q}**`, components: [row], flags: MessageFlags.Ephemeral };
}
async function pgStart(interaction) {
  if (!features.enabled('provingGrounds')) return interaction.reply({ content: 'Proving Grounds isn’t enabled yet.', flags: MessageFlags.Ephemeral });
  const uid = interaction.user.id;
  if (proving.playedToday(uid)) return interaction.reply({ content: `You’ve already run today’s challenge. Come back tomorrow. ${provingRankLine(uid)}`, flags: MessageFlags.Ephemeral });
  const mine = tribes.memberTribe(interaction.member);
  if (!proving.startAttempt(uid, mine ? mine.key : null)) return interaction.reply({ content: 'You’ve already attempted today.', flags: MessageFlags.Ephemeral });
  const game = proving.todaysGame(Date.now(), pgBuiltGames());
  if (game === 'puzzle') return pgStartPuzzle(interaction, uid, mine);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const questions = game === 'scoreattack' ? await pgBuildLadder() : await pgBuildGauntlet();
  if (!questions.length) { proving.finishAttempt(uid, mine ? mine.key : null, 0); return interaction.editReply('Couldn’t load today’s challenge, try again in a moment.'); }
  const run = { game, questions, idx: 0, correct: 0, tribeKey: mine ? mine.key : null };
  _pgRuns.set(uid, run);
  return interaction.editReply(pgRender(run));
}
// Puzzles delivery: reply with the prompt + an Answer button (NOT deferred, so the button can open a modal).
async function pgStartPuzzle(interaction, uid, mine) {
  const puzzle = pgBuildPuzzle();
  _pgRuns.set(uid, { game: 'puzzle', puzzle, correct: 0, tribeKey: mine ? mine.key : null });
  const intro = puzzle.kind === 'anagram'
    ? `# 🏅 Proving Grounds, Puzzles — Anagram Chain\nUnscramble all ${puzzle.items.length} words. Tap **Answer** to fill them in.`
    : `# 🏅 Proving Grounds, Puzzles — Cryptogram\nEvery letter is shifted by the same amount. Decode the phrase (hint: **${puzzle.hint}**):\n\`\`\`\n${puzzle.encoded}\n\`\`\`\nTap **Answer** to solve.`;
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pgpz_open').setLabel('✍️ Answer').setStyle(ButtonStyle.Primary));
  return interaction.reply({ content: intro, components: [row], flags: MessageFlags.Ephemeral });
}
async function pgPuzzleOpen(interaction) {
  const run = _pgRuns.get(interaction.user.id);
  if (!run || run.game !== 'puzzle') return interaction.reply({ content: 'That puzzle has ended. Come back tomorrow.', flags: MessageFlags.Ephemeral });
  const p = run.puzzle;
  const modal = new ModalBuilder().setCustomId('pgpz_submit').setTitle('Proving Grounds — Puzzles');
  if (p.kind === 'anagram') {
    p.items.forEach((it, i) => modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(`a${i}`).setLabel(`Unscramble: ${it.scrambled}`.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(false))));
  } else {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('c0').setLabel('Decode the phrase').setStyle(TextInputStyle.Paragraph).setRequired(false)));
  }
  return interaction.showModal(modal);
}
async function pgPuzzleSubmit(interaction) {
  const uid = interaction.user.id;
  const run = _pgRuns.get(uid);
  if (!run || run.game !== 'puzzle') return interaction.reply({ content: 'That puzzle has ended.', flags: MessageFlags.Ephemeral });
  const p = run.puzzle; const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  let score = 0, max = 0, detail = '';
  if (p.kind === 'anagram') {
    max = p.items.length; const lines = [];
    p.items.forEach((it, i) => { let v = ''; try { v = interaction.fields.getTextInputValue(`a${i}`); } catch { } const ok = norm(v) === norm(it.answer); if (ok) score++; lines.push(`${ok ? '✅' : '❌'} ${it.scrambled} → **${it.answer.toUpperCase()}**`); });
    detail = lines.join('\n');
  } else {
    let v = ''; try { v = interaction.fields.getTextInputValue('c0'); } catch { }
    const gw = norm(v).split(' ').filter(Boolean), aw = norm(p.answer).split(' ');
    max = aw.length; for (let i = 0; i < aw.length; i++) if (gw[i] && gw[i] === aw[i]) score++;
    detail = `The phrase was: **${p.answer}**\nYou decoded **${score}/${max}** words.`;
  }
  run.correct = score; _pgRuns.delete(uid);
  proving.finishAttempt(uid, run.tribeKey, score);
  if (run.tribeKey && score > 0) { tribes.addTides(run.tribeKey, uid, score * PG_TIDES_PER); tribes.addTreasury(run.tribeKey, score * PG_TREASURY_PER); }
  const board = proving.dailyBoard(Date.now(), 100); const pos = board.findIndex(x => x.uid === uid);
  const line = `# 🏅 Puzzles complete — **${score}/${max}**\n${detail}${run.tribeKey && score > 0 ? `\n\n+${score * PG_TIDES_PER} points for you, +${score * PG_TREASURY_PER} Treasury for your tribe.` : ''}\n-# Today's rank: ${pos >= 0 ? `#${pos + 1}` : 'unranked'}. ${provingRankLine(uid)}`;
  return interaction.reply({ content: line, flags: MessageFlags.Ephemeral });
}
function provingRankLine(uid) {
  const wk = proving.weeklyBoard(100); const pos = wk.findIndex(x => x.uid === uid);
  const total = wk[pos] ? wk[pos].score : 0;
  return pos >= 0 ? `This week: **${total}** Prover points (rank #${pos + 1}).` : '';
}
async function pgAnswer(interaction) {
  const uid = interaction.user.id;
  const run = _pgRuns.get(uid);
  if (!run || !run.questions) return interaction.reply({ content: 'That run has ended. Start again tomorrow.', flags: MessageFlags.Ephemeral });
  const q = run.questions[run.idx];
  const correct = Number(interaction.customId.split(':')[1]) === q.answer;
  if (correct) {
    run.correct += 1; run.idx += 1;
    if (run.idx >= run.questions.length) return pgFinish(interaction, run, true);   // cleared the whole set
    return interaction.update(pgRender(run));
  }
  return pgFinish(interaction, run, false);
}
async function pgFinish(interaction, run, cleared) {
  const uid = interaction.user.id;
  _pgRuns.delete(uid);
  const score = run.correct;
  proving.finishAttempt(uid, run.tribeKey, score);
  // rewards: personal Tides (if in a tribe) + a little tribe Treasury.
  if (run.tribeKey && score > 0) { tribes.addTides(run.tribeKey, uid, score * PG_TIDES_PER); tribes.addTreasury(run.tribeKey, score * PG_TREASURY_PER); }
  const board = proving.dailyBoard(Date.now(), 100); const pos = board.findIndex(x => x.uid === uid);
  const unit = run.game === 'scoreattack' ? 'rungs' : 'streak';
  const headline = cleared ? (run.game === 'scoreattack' ? 'Topped the ladder!' : 'Flawless run!') : 'Run over.';
  const line = `# 🏅 ${headline}\nYou cleared **${score}** ${unit}.${run.tribeKey && score > 0 ? ` +${score * PG_TIDES_PER} points for you, +${score * PG_TREASURY_PER} Treasury for your tribe.` : ''}\n-# Today's rank: ${pos >= 0 ? `#${pos + 1}` : 'unranked'}. ${provingRankLine(uid)}`;
  return interaction.update({ content: line, components: [] }).catch(() => interaction.reply({ content: line, flags: MessageFlags.Ephemeral }).catch(() => {}));
}
// Weekly Prover reveal: when the week rolls over, reveal the just-ended top provers + top tribe, then reset.
async function proverWeeklyIfDue(guild) {
  if (!features.enabled('provingGrounds') || !proving.weeklyDue(Date.now())) return;
  const prev = proving.rolloverWeek(Date.now());
  if (!prev.provers.length) return;
  // top tribe gets a bonus
  const topTribe = prev.tribes[0];
  // Proving Grounds is a solo obstacle-ladder/reflex challenge — 'combat', same as Arena's reflex-type modes.
  if (topTribe && topTribe.key) {
    const pgMult = 1.5 * tribeCategoryMult(topTribe.key, 'combat');
    tribes.addTreasury(topTribe.key, Math.round(arena.WIN_TREASURY * pgMult));
    tribes.addGlory(topTribe.key, Math.round(arena.WIN_GLORY * pgMult));
  }
  const champ = prev.provers[0];
  if (champ && champ.uid) { const m = await guild.members.fetch(champ.uid).catch(() => null); const t = m && tribes.memberTribe(m); if (t) { achievements && features.enabled('achievements') && achievements.bumpAndCheck(champ.uid, 'prestige'); } }
  lore.record({ type: 'chronicle', title: `Prover of the Week: ${prev.provers[0] ? `<@${prev.provers[0].uid}>` : 'nobody'}` });
  enqueueSpectacle(SPECTACLE_PRIORITY.proverWeek, 'proverWeek', () => revealProverWeek(guild, prev));
}
async function revealProverWeek(guild, prev) {
  const ch = await getSpectacleChannel(guild); if (!ch) return;
  await ch.send({ content: `# 🏅 Prover of the Week\n${copy.herald.open()} The week's solo gauntlets are tallied.`, allowedMentions: { parse: [] } }).catch(() => {});
  await warSleep(2000);
  const medals = ['🥇', '🥈', '🥉'];
  const top = prev.provers.slice(0, 5);
  for (let i = top.length - 1; i >= 0; i--) {
    await ch.send({ content: `${medals[i] || `**${i + 1}.**`} <@${top[i].uid}>: **${top[i].score}** Prover points`, allowedMentions: { parse: [] } }).catch(() => {});
    await warSleep(1500);
  }
  if (prev.tribes[0]) await ch.send({ content: `-# 🏴 Most active tribe: ${tribeName(prev.tribes[0].key)} (their provers earn a bonus).`, allowedMentions: { parse: [] } }).catch(() => {});
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
  { key: 'fastertides', emoji: '⚡', label: 'Faster Points', desc: 'Hall earn-cap drops from 60s to 45s.', memberGate: 20, crownGate: 4, cost: 800 },
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
  const deny = [config.cornerRoleId, config.adultCornerRoleId].filter(Boolean).map(id => ({ id, deny: [P.ViewChannel] }));
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
// Member-founded tribe: ONE modal (the mod path is a multi-step wizard, but a member just needs the essentials).
function tribeMemberFoundModal() {
  return new ModalBuilder().setCustomId('tribemfound_modal').setTitle('Found a member-led tribe').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Full tribe name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('short_name').setLabel('Short name for cards (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Tribe emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Colour hex, e.g. #2A426A').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7)));
}
// Renders the live member-founding petition (content + Cosign / Raise button), shared by the modal + cosign handlers.
function renderMemberFounding(req) {
  const need = Math.max(0, tribes.MEMBER_FOUND_COSIGNS - req.cosigns.length);
  const id = req.identity, ready = need === 0;
  const signed = req.cosigns.length ? req.cosigns.map(u => `<@${u}>`).join(', ') : '_none yet_';
  const header = `## 🏴 A new tribe wants to rise\n> <@${req.founderId}> wants to found **${id.emoji ? id.emoji + ' ' : ''}${id.name}**.\n> It forms once **${tribes.MEMBER_FOUND_COSIGNS} members cosign** it. **Cosigning makes you a co-leader** of the new tribe (you all lead it together), so you can’t already be in one — get released the usual way first. Trial mods count; mods/admins/owners can’t.`;
  const tally = ready
    ? `\n-# ✅ **${tribes.MEMBER_FOUND_COSIGNS}/${tribes.MEMBER_FOUND_COSIGNS} reached!** <@${req.founderId}> can raise the tribe now.\n-# Cosigned by: ${signed}`
    : `\n-# Cosigned by: ${signed} — **${req.cosigns.length}/${tribes.MEMBER_FOUND_COSIGNS}** (${need} more)`;
  const btn = ready
    ? new ButtonBuilder().setCustomId(`tribemfound_create:${req.founderId}`).setLabel('🏴 Raise the tribe').setStyle(ButtonStyle.Success)
    : new ButtonBuilder().setCustomId('tribemfound_cosign').setLabel('✅ Cosign').setStyle(ButtonStyle.Success);
  return { content: header + tally, components: [new ActionRowBuilder().addComponents(btn)], allowedMentions: ready ? { users: [req.founderId] } : { parse: [] } };
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

// Staff notification for a jail thread: pinging the mod role INSIDE the thread itself was tried and
// reverted (2026-08-19) — Discord auto-adds every online member of a pinged role into a private thread,
// so it silently stuffed the whole mod team into every cornered member's "private" thread and they never
// left (staff are exempt from the auto-eject guard). Pinging in the corner-log channel instead — a normal
// text channel, not a thread — gets the real notification without that side effect; the channel link only
// lets someone in if Discord already would (private-thread view requires Manage Threads, which the mod
// role has), so it can't leak the thread to non-staff.
function threadNotifyLine(threadId) {
  return threadId ? `\n🧵 **Private jail thread:** <#${threadId}>${config.modRoleId ? ` — <@&${config.modRoleId}>` : ''}` : '';
}

// Shared joke check-in prompt — every corner entry point that funnels a staff actor through an interaction
// calls this after a fresh corner.corner() succeeds. `joke` is that call's returned `.joke` (undefined for
// a re-corner/update on an already-cornered member, which carries no fresh default to confirm — skip it).
// REQUIRES the interaction's initial response to already be ephemeral, or Discord silently makes this
// followup public (the exact bug fixed on /corner itself — see its deferReply comment).
async function jokeCheckIn(interaction, targetUserId, joke) {
  if (joke === undefined) return;
  const promptText = joke
    ? `😂 Staff-on-staff, so this was treated as a **joke** by default — the release tier lock is waived, anyone can let <@${targetUserId}> out early.`
    : `Cornering <@${targetUserId}> was treated as **real** by default — the normal release tier lock stays in place.`;
  const flipBtn = joke
    ? new ButtonBuilder().setCustomId(`corner_markjoke:${targetUserId}:0`).setEmoji('🔒').setLabel("No, it's real").setStyle(ButtonStyle.Danger)
    : new ButtonBuilder().setCustomId(`corner_markjoke:${targetUserId}:1`).setEmoji('😂').setLabel('It was a joke').setStyle(ButtonStyle.Secondary);
  await interaction.followUp({
    content: promptText,
    components: [new ActionRowBuilder().addComponents(flipBtn)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  }).catch(e => console.error('[corner] joke prompt followUp:', e.message));
}

function cornerSentMessage(userId, whenPhrase, reason, actorId, isThread = false, isAnon = false) {
  const sentByText = isAnon ? '**Sent by:** 🎭 Anonymous Staff' : (actorId ? `**Sent by:** <@${actorId}>` : '');
  return {
    content: `## ⛓️ SENT TO THE CORNER\n<@${userId}>`,
    embeds: [new EmbedBuilder().setColor(CORNER_RED)
      .setDescription(`<@${userId}> has been stripped of their roles and confined here **${whenPhrase}**.`
        + (sentByText ? `\n${sentByText}` : '')
        + (reason ? `\n**Reason:** ${reason}` : '')
        + (isThread ? `\n\nThis is your private jail thread. Staff have been notified.` : `\n\nThis is the only text channel you may speak in (you can also join the corner voice channel). Reflect on what brought you here.`))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:0`).setEmoji('🔓').setLabel('Release now').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:3600000`).setEmoji('⏰').setLabel('+1h').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:86400000`).setEmoji('⏰').setLabel('+1d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`corner_rel:${userId}:indef`).setEmoji('♾️').setLabel('Indefinite').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: [], users: [userId] },
  };
}

// Announce a corner that just happened: the themed message in the corner channel (duration + who + reason +
// release buttons) AND the audit entry in the corner log. Centralises what every corner path needs — /corner,
// the context-menu, and the DASHBOARD (which previously announced/logged nothing) all call this so the
// resultant message consistently shows the duration and who sent them.
async function announceCorner(guild, memberId, durationMs, actorId, reasonText, threadId = null, targetChannelId = null) {
  const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
  const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
  const chId = targetChannelId || config.cornerChannelId;
  const cornerCh = await guild.channels.fetch(chId).catch(() => null);
  const sentMsg = cornerSentMessage(memberId, whenPhrase, reasonText || null, actorId);
  if (cornerCh) await cornerCh.send(sentMsg).catch(() => {});
  if (threadId) {
    const threadCh = await guild.channels.fetch(threadId).catch(() => null);
    if (threadCh) await threadCh.send(cornerSentMessage(memberId, whenPhrase, reasonText || null, actorId, true)).catch(() => {});
  }
  await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER', color: CORNER_RED,
    desc: `<@${memberId}> was cornered ${relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**'}.\n**By:** <@${actorId}>${reasonText ? `\n**Reason:** ${reasonText}` : ''}${threadNotifyLine(threadId)}`,
    pingRoleIds: threadId && config.modRoleId ? [config.modRoleId] : undefined });
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
        const { emoji, title, color, desc, pingRoleIds } = entry;
        // desc's @mentions live in CONTENT (not the embed) so they resolve to clickable @names for everyone —
        // embed mentions only resolve from the viewer's cache and show "@unknown-user" in this restricted log.
        // Content-only: the ## header + emoji carry the signal; a color-only embed would render as an empty box.
        // pingRoleIds is opt-in per call (e.g. a jail-thread notify) — everything else stays a silent @mention,
        // same as before, since this channel logs every corner and shouldn't ping staff on each one.
        await ch.send({ content: `## ${emoji} ${title}\n${desc}`, allowedMentions: pingRoleIds?.length ? { parse: [], roles: pingRoleIds } : { parse: [] } });
      }
    }
    // Mirror to the owner-only log too — covers every corner/uncorner call site in one place. Anonymous
    // cornering (owner, 2026-08-19: identity should show ONLY in the owner log, never the public corner
    // log — it showed in both before this) — ownerDesc, when a caller supplies it, carries the REAL actor
    // for this mirror only; entry.desc (posted to the public corner log above) stays masked.
    if (typeof entry !== 'string') await ownerlog.log(guild, { emoji: entry.emoji, title: entry.title, detail: entry.ownerDesc || entry.desc, color: entry.color });
  } catch (e) { console.error(`[corner-log] ${e.message}`); }
}

// ---- Hit squad (owner, 2026-08-17) ------------------------------------------------------------------
async function ensureHitSquadRole(guild) {
  let id = hitsquad.getRoleId();
  let role = id && (guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null));
  // BypassSlowmode is the real, narrow Discord permission for this (not ManageMessages/ManageChannels —
  // those also grant message-delete/channel-edit, more chaos than intended). Patched onto an EXISTING role
  // too, so a role created before this feature shipped still gets it without manual re-creation.
  if (role) { if (!role.permissions.has(PermissionsBitField.Flags.BypassSlowmode)) await role.setPermissions([PermissionsBitField.Flags.BypassSlowmode], 'Hit squad: slowmode immunity').catch(() => {}); return role; }
  role = await guild.roles.create({ name: '🔪 Hit Squad', color: 0xED4245, hoist: true, mentionable: false, permissions: [PermissionsBitField.Flags.BypassSlowmode], reason: 'Hit squad (owner request)' });
  hitsquad.setRoleId(role.id);
  return role;
}
// The Hit Squad role carries real Discord permission (BypassSlowmode), so anyone holding it OUTSIDE the
// bot's own tracked activation is a standing, un-timed grant — e.g. an admin drags the role onto someone
// via Discord's native role UI instead of /hitsquad activate (owner, 2026-08-17: "what about if they do
// it through the discord ui?"). Strip it on sight; the only legitimate way to hold this role is via
// activate(), which is state-tracked and auto-reverts regardless of what happens to the role itself.
async function enforceHitSquadRole(member) {
  const roleId = hitsquad.getRoleId();
  if (!roleId || member.user?.bot) return null;
  if (!member.roles.cache.has(roleId)) return null;
  if (hitsquad.isSquadMember(member.id)) return null;   // legitimate: added by activate(), still in the active window
  await member.roles.remove(roleId, 'Hit Squad role held outside a tracked activation').catch(e => console.error('[hitsquad] drift strip:', e.message));
  return { id: member.id, tag: member.user.tag };
}
// Backstop sweep (boot + hourly): catches a manual grant made while the bot was down, or any missed event.
async function sweepHitSquadRole(guild) {
  const roleId = hitsquad.getRoleId();
  if (!roleId) return 0;
  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return 0;
  let stripped = 0;
  for (const m of [...role.members.values()]) { const r = await enforceHitSquadRole(m).catch(() => null); if (r) stripped++; }
  return stripped;
}
const _hitsquadTimer = { t: null };
async function deactivateHitSquad(guild) {
  if (_hitsquadTimer.t) { clearTimeout(_hitsquadTimer.t); _hitsquadTimer.t = null; }
  const active = hitsquad.peekActive();   // raw record, even a moment past expiresAt — clear() below wipes it
  const memberIds = active ? active.squadIds : [];
  const reverts = hitsquad.peekReverts();
  hitsquad.clear();
  const role = hitsquad.getRoleId() && await guild.roles.fetch(hitsquad.getRoleId()).catch(() => null);
  if (role) for (const id of memberIds) { const m = await guild.members.fetch(id).catch(() => null); if (m) await m.roles.remove(role, 'Hit squad window ended').catch(() => {}); }
  // Revert whatever settings they changed (owner: "whatever settings they change should also revert at
  // the end of the period") — one entry per (kind, targetId), recorded with its ORIGINAL value the first
  // time it was touched this window.
  for (const r of reverts) {
    try {
      if (r.kind === 'slowmode') { const ch = await guild.channels.fetch(r.targetId).catch(() => null); if (ch) await ch.setRateLimitPerUser(r.value, 'Hit squad window ended — reverting slowmode'); }
      else if (r.kind === 'nickname') { const m = await guild.members.fetch(r.targetId).catch(() => null); if (m) await m.setNickname(r.value, 'Hit squad window ended — reverting nickname'); }
    } catch (e) { console.error(`[hitsquad] revert ${r.kind} ${r.targetId}:`, e.message); }
  }
  if (memberIds.length || reverts.length) {
    await logCorner(guild, { emoji: '🔪', title: 'HIT SQUAD STOOD DOWN', color: 0x99AAB5,
      desc: `${memberIds.map(id => `<@${id}>`).join(', ')} — window ended, deputized power revoked.${reverts.length ? ` Reverted ${reverts.length} change(s).` : ''}` }).catch(() => {});
  }
}
function armHitSquadTimer(guild, expiresAt) {
  if (_hitsquadTimer.t) clearTimeout(_hitsquadTimer.t);
  const delay = Math.max(0, expiresAt - Date.now());
  _hitsquadTimer.t = setTimeout(() => deactivateHitSquad(guild).catch(e => console.error('[hitsquad] deactivate:', e.message)), delay);
}
// Optional public punishment feed for the heavier consequences (Melanin's #punishments-log — strikes come
// from strikes.js, bans from here). Unset on FUBU → no-op. Mirrors logCorner's content-only style so @mentions
// resolve for everyone. Strikes/bans deliberately live here, not corner-log (which stays corners-only).
async function logPunishment(guild, { emoji, title, desc }) {
  if (!config.punishmentLogChannelId) return;
  try {
    const ch = await guild.channels.fetch(config.punishmentLogChannelId).catch(() => null);
    if (ch) await ch.send({ content: `## ${emoji} ${title}\n${desc}`, allowedMentions: { parse: [] } });
  } catch (e) { console.error(`[punishment-log] ${e.message}`); }
}
// Optional dedicated ban announcement channel (Melanin's #banned). One clean line per ban. Unset on FUBU → no-op.
async function logBanned(guild, { userId, byId, reason }) {
  if (!config.bannedChannelId) return;
  try {
    const ch = await guild.channels.fetch(config.bannedChannelId).catch(() => null);
    if (ch) await ch.send({ content: `## 🔨 Banned\n<@${userId}> was banned by <@${byId}>.${reason ? `\n**Reason:** ${reason}` : ''}\n-# <t:${Math.floor(Date.now() / 1000)}:F>`, allowedMentions: { parse: [] } });
  } catch (e) { console.error(`[banned-log] ${e.message}`); }
}
// Small helper: "<t:..:R> (<t:..:f>)" from an epoch-ms release time, for audit embeds.
function relPhrase(releaseAt) {
  const s = Math.floor(releaseAt / 1000);
  return `<t:${s}:R> (<t:${s}:f>)`;
}

// Mod gate shared by the button handlers below (MOD role, Administrator overrides).
function modClicked(interaction) {
  return opspanel.meets(opspanel.tierOf(interaction), 'mod');   // mod/admin/owner incl Admin-perm/bot owner — NOT 'staff' floor (trial/mini-mod/event-org)
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
  // A cornered member who left the server stays cornered in state (rejoining sends them straight back),
  // but they're not visibly "in the corner" right now — owner, 2026-08-17: don't list them here.
  const ids = Object.keys(cornered).filter(id => interaction.guild.members.cache.has(id));
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
// corner channel + the audit log. durationMs null = indefinite (blank in the modal, matching /corner).
// Returns { ok, stripped, error }.
async function cornerFromMessage(guild, actorId, member, target, reason, durationMs = null, ruleN = null, actorTier = null, opts = {}) {
  const r = await corner.corner(guild, member, durationMs, state, actorId, ruleN, actorTier, opts);
  if (!r.ok) return { ok: false, error: r.error };
  const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
  const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
  const fromLog = target.author?.id === client.user.id;
  const authorTag = fromLog ? member.user.tag : target.author.tag;
  const authorAvatar = fromLog ? member.displayAvatarURL() : target.author.displayAvatarURL();
  const shownContent = fromLog ? (target.content || '').replace(/^🗑️[^\n]*\n\n/, '') : (target.content || '');
  const channelLabel = fromLog ? 'a deleted-message log entry' : `#${target.channel?.name || '?'}`;
  try {
    const cornerChId = r.targetChannelId || config.cornerChannelId;
    const cornerCh = await guild.channels.fetch(cornerChId).catch(() => null);
    const sentMsg = cornerSentMessage(member.id, whenPhrase, reason || null, actorId);
    if (cornerCh) {
      await cornerCh.send(sentMsg).catch(() => {});
      if (r.threadId) {
        const threadCh = await guild.channels.fetch(r.threadId).catch(() => null);
        if (threadCh) await threadCh.send(cornerSentMessage(member.id, whenPhrase, reason || null, actorId, true)).catch(() => {});
      }
      const emb = new EmbedBuilder().setColor(CORNER_RED)
        .setAuthor({ name: authorTag, iconURL: authorAvatar })
        .setDescription(shownContent.slice(0, 4000) || '_[no text, see attachment/link]_')
        .addFields({ name: 'Why they’re here', value: `Cornered for this message by <@${actorId}>${reason ? `\n**Reason:** ${reason}` : ''}` })
        .setFooter({ text: `originally in ${channelLabel}` }).setTimestamp(target.createdTimestamp);
      const files = [...(target.attachments?.values() || [])].slice(0, 5).map(a => a.url);
      const targetCh = r.threadId ? (await guild.channels.fetch(r.threadId).catch(() => cornerCh)) : cornerCh;
      await targetCh.send({ embeds: [emb], content: files.length ? files.join('\n') : undefined, allowedMentions: { parse: [] } });
    }
  } catch (e) { console.error(`[corner-msg] forward failed: ${e.message}`); }
  // In-channel notice on the flagged message (no DM) — same pattern the Strike flows use. Shows the duration
  // and who cornered them (actor mention resolves but doesn't ping — only the cornered member is pinged).
  await target.reply({ content: `⛓️ This message got <@${member.id}> sent to the corner ${whenPhrase} by <@${actorId}>${reason ? ` (${reason})` : ''}.`, allowedMentions: { users: [member.id] } }).catch(e => console.error('[corner-msg] reply on original failed:', e.message));
  await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER (via message)', color: CORNER_RED,
    desc: `<@${member.id}> was cornered ${relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**'} for a message.\n**By:** <@${actorId}>${reason ? `\n**Reason:** ${reason}` : ''}\n**Message:** ${target.url}${threadNotifyLine(r.threadId)}`,
    pingRoleIds: r.threadId && config.modRoleId ? [config.modRoleId] : undefined });
  return { ok: true, stripped: r.stripped, joke: r.joke };
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
// Does a member effectively hold a role right now, seeing through a corner's role strip? A cornered
// member's live roles don't have it (jailed, not demoted), so check the pre-corner snapshot instead —
// mirrors opspanel.memberTier's own corner fallback (owner, 2026-08-18: staff level persists through the
// corner unless an actual bot demote command changes it).
function holdsRoleEffective(member, roleId) {
  const rec = state.getCornered(member.id);
  if (rec && Array.isArray(rec.roles)) return rec.roles.includes(roleId);
  return member.roles.cache.has(roleId);
}
// Remove a role from a member who may currently be cornered: strip it live (harmless no-op if they don't
// hold it right now) AND, if cornered, remove it from the stored snapshot too — otherwise release would
// silently hand the "demoted" role right back.
async function removeRoleEffective(member, roleId, reason) {
  const ok = await member.roles.remove(roleId, reason).then(() => true).catch(() => false);
  const rec = state.getCornered(member.id);
  if (rec && Array.isArray(rec.roles) && rec.roles.includes(roleId)) {
    rec.roles = rec.roles.filter(id => id !== roleId);
    state.setCornered(member.id, rec);
    return true;   // the snapshot edit is what actually matters while cornered
  }
  return ok;
}
// Add a role to a member who may currently be cornered: grant it live if not cornered, or add it to the
// stored snapshot (so it's there on release) if they are — adding a real role to a jailed member would
// just get stripped back off by the corner's own permission overwrite.
async function addRoleEffective(member, roleId, reason) {
  const rec = state.getCornered(member.id);
  if (rec && Array.isArray(rec.roles)) {
    if (rec.roles.includes(roleId)) return true;
    rec.roles = [...rec.roles, roleId];
    state.setCornered(member.id, rec);
    return true;
  }
  return member.roles.add(roleId, reason).then(() => true).catch(() => false);
}

// Corner a LIST of members in one action — shared by /corner's `also`, the dashboard multi-pick, and the
// Bulk corner (sweep / dashboard "Corner several" / /corner also). Per-target guards: skip self, bots, and
// ALL STAFF — mods/admins/owners are never bulk-cornered (owner ruling 2026-08-01). A deliberate single
// /corner can still corner an equal/lower staff tier; bulk ops never touch staff, so a raid sweep can't
// scoop up your own team. Dedupes, announces each in the corner channel, writes ONE summary. Returns {done, skipped}.
async function cornerMany(guild, actorId, actorRank, members, durationMs, { ruleN = null, reasonText = null, allowNamedStaff = false, actorTier = null, adult = false, thread = false, anon = false, slowmodeSec = null } = {}) {
  const done = [], skipped = [], threadIds = [], jokes = [], seen = new Set();
  const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
  const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
  for (const member of members) {
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    if (member.id === actorId) { skipped.push(`<@${member.id}> (yourself)`); continue; }
    if (member.user?.bot) { skipped.push(`<@${member.id}> (bot)`); continue; }
    if (member.id === guild.ownerId) { skipped.push(`<@${member.id}> (owner)`); continue; }
    const targetTier = opspanel.memberTier(member);
    if (allowNamedStaff) {
      const targetRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[targetTier] || 0;
      if (targetRank > actorRank) { skipped.push(`<@${member.id}> (${targetTier}, higher tier)`); continue; }
    } else {
      const staffLabel = targetTier || (config.trialModRoleId && member.roles.cache.has(config.trialModRoleId) ? 'trial mod' : null);
      if (staffLabel) { skipped.push(`<@${member.id}> (${staffLabel})`); continue; }   // bulk-corner never touches staff (mod/admin/owner/trial mod)
    }
    const r = await corner.corner(guild, member, durationMs, state, actorId, ruleN, actorTier, { adult, thread, anon, slowmodeSec });
    if (r.ok) {
      done.push(member.id);
      if (r.joke) jokes.push(member.id);
      if (r.threadId) threadIds.push(r.threadId);
      const chId = r.targetChannelId || config.cornerChannelId;
      const cornerCh = await guild.channels.fetch(chId).catch(() => null);
      const sentMsg = cornerSentMessage(member.id, whenPhrase, reasonText, anon ? null : actorId, false, anon);
      if (cornerCh) await cornerCh.send(sentMsg).catch(() => {});
      if (r.threadId) {
        const threadCh = await guild.channels.fetch(r.threadId).catch(() => null);
        if (threadCh) await threadCh.send(cornerSentMessage(member.id, whenPhrase, reasonText, anon ? null : actorId, true, anon)).catch(() => {});
      }
    } else skipped.push(`<@${member.id}> (${r.error})`);
  }
  if (done.length) {
    const bulkWhenPhrase = relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**';
    const threadLines = threadIds.map(threadNotifyLine).join('');
    await logCorner(guild, { emoji: '⛓️', title: `SENT TO THE CORNER (×${done.length})`, color: CORNER_RED,
      desc: `${done.map(id => `<@${id}>`).join(', ')}: cornered ${bulkWhenPhrase}.\n**By:** ${anon ? '🎭 Anonymous Staff' : `<@${actorId}>`}${reasonText ? `\n**Reason:** ${reasonText}` : ''}${threadLines}`,
      ownerDesc: `${done.map(id => `<@${id}>`).join(', ')}: cornered ${bulkWhenPhrase}.\n**By:** <@${actorId}>${anon ? ' _(anon corner)_' : ''}${reasonText ? `\n**Reason:** ${reasonText}` : ''}`,
      pingRoleIds: threadIds.length && config.modRoleId ? [config.modRoleId] : undefined });
  }
  // No per-target ephemeral prompt for bulk — could be dozens of targets — but a joke default (staff-on-
  // staff, allowNamedStaff only) is still surfaced as a plain text note so it isn't silently invisible.
  return { done, skipped, whenPhrase, jokes };
}

// Mirrors cornerMany, for /uncorner's own `also` option (owner, 2026-08-17: "I meant uncornering multiple
// people at once"). durationMs null = release everyone right now; otherwise schedule the same future release
// time for all of them. Each target still goes through corner.attemptSeverityChange individually — bulk
// release doesn't bypass the per-person tiering/override gate, it just runs the same check in a loop.
async function uncornerMany(guild, actorId, actorTier, userIds, durationMs) {
  const done = [], scheduled = [], skipped = [], seen = new Set();
  const releaseAt = durationMs ? Date.now() + durationMs : null;
  for (const userId of userIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const res = corner.attemptSeverityChange(state, userId, actorId, actorTier, releaseAt ?? 'RELEASE');
    if (res.notFound) { skipped.push(`<@${userId}> (not in the corner)`); continue; }
    if (!res.ok) { skipped.push(`<@${userId}> (${res.need ? `needs ${res.need} ${actorTier}s` : 'higher tier, no override'})`); continue; }
    if (releaseAt) {
      corner.armTimer(guild, userId, releaseAt);
      scheduled.push(userId);
    } else {
      const r = await corner.uncorner(guild, userId, state);
      if (r.ok) done.push(userId); else skipped.push(`<@${userId}> (${r.error})`);
    }
  }
  const cornerCh = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
  if (cornerCh) for (const userId of done) await cornerCh.send(cornerReleasedMessage(userId)).catch(() => {});
  if (done.length) await logCorner(guild, { emoji: '🔓', title: `RELEASED (×${done.length})`, color: CORNER_GREEN,
    desc: `${done.map(id => `<@${id}>`).join(', ')}: released, roles restored.\n**By:** <@${actorId}>` });
  if (scheduled.length) await logCorner(guild, { emoji: '⏳', title: `RELEASE SCHEDULED (×${scheduled.length})`, color: CORNER_AMBER,
    desc: `${scheduled.map(id => `<@${id}>`).join(', ')}: release scheduled.\n**Release:** ${relPhrase(releaseAt)}\n**By:** <@${actorId}>` });
  return { done, scheduled, skipped, releaseAt };
}

async function handleCornerButton(interaction) {
  // corner_markjoke:<userId>:<0|1> — the joke check-in prompt after /corner (ephemeral, only the actor who
  // ran the command sees it, so no separate mod gate needed here — modClicked() below would wrongly exclude
  // a trial mod, who's allowed to see and use their own prompt).
  if (interaction.customId.startsWith('corner_markjoke:')) {
    const [, userId, jokeStr] = interaction.customId.split(':');
    const joke = jokeStr === '1';
    const ok = corner.setJoke(state, userId, joke);
    return interaction.update({
      content: ok
        ? (joke ? `😂 Marked as a joke — <@${userId}>'s release tier lock is waived.` : `🔒 Marked as real — the normal release tier lock applies to <@${userId}>.`)
        : `That corner already ended — nothing to change.`,
      components: [],
    }).catch(() => {});
  }
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
    const actorTier = effectiveTierOf(interaction, member);
    if (member.id === guild.ownerId && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, actorTier)) return interaction.editReply('You cannot corner the server owner.');
    const recornerActorRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[actorTier] || 0;
    const recornerTargetTier = opspanel.memberTier(member);
    const recornerTargetRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[recornerTargetTier] || 0;
    if (recornerTargetRank > recornerActorRank && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, actorTier)) return interaction.editReply(`You can’t corner someone of a higher staff tier than you (they’re **${recornerTargetTier}**).`);
    const r = await corner.corner(guild, member, null, state, interaction.user.id, null, actorTier);
    if (!r.ok) return interaction.editReply(`Failed to re-corner: ${r.error}`);
    try {
      const ch = await guild.channels.fetch(config.cornerChannelId).catch(() => null);
      if (ch) await ch.send(cornerSentMessage(userId, 'indefinitely', null, interaction.user.id));
    } catch (e) { console.error(`[recorner] announce failed: ${e.message}`); }
    await logCorner(guild, { emoji: '⛓️', title: 'RE-CORNERED', color: CORNER_RED,
      desc: `<@${userId}> was sent straight back to the corner **indefinitely**.\n**By:** <@${interaction.user.id}>` });
    await interaction.editReply(`⛓️ Re-cornered <@${userId}>, stripped **${r.stripped}** role(s).`);
    return jokeCheckIn(interaction, userId, r.joke);
  }
  // owner, 2026-08-16: these 3 branches were writing state.setCornered() directly, with ZERO tier/override
  // check — a mod could one-click-release someone an owner or admin deliberately cornered, completely
  // bypassing corner.attemptSeverityChange (the exact gate /uncorner already routes both its paths through).
  // Same gate here now, for all 3 severity-changing branches this button drives.
  const actorTier = opspanel.tierOf(interaction);
  const gateReply = (res) => interaction.editReply(res.need
    ? `🔒 That shortens their time below what a higher tier set. Need **${res.need}** ${actorTier}${res.need === 1 ? '' : 's'} to try within 5 minutes (**${res.have}/${res.need}** so far).`
    : `🔒 That shortens their time below what a higher tier set, and your tier has no override path for this.`);
  if (msStr === 'indef') {
    const res = corner.attemptSeverityChange(state, userId, interaction.user.id, actorTier, null);
    if (res.notFound) return interaction.editReply(`<@${userId}> is not in the corner.`);
    if (!res.ok) return gateReply(res);
    corner.clearTimer(userId);                                // cancel the pending precise-release timer
    await logCorner(guild, { emoji: '♾️', title: 'SENTENCE CHANGED', color: CORNER_AMBER,
      desc: `<@${userId}>'s corner is now **indefinite** (no auto-release).\n**By:** <@${interaction.user.id}>` });
    return interaction.editReply(`♾️ <@${userId}> is now cornered **indefinitely**. They stay until manually released.`);
  }
  if (ms === 0) {
    const relCheck = corner.attemptSeverityChange(state, userId, interaction.user.id, actorTier, 'RELEASE');
    if (relCheck.notFound) return interaction.editReply(`<@${userId}> is not in the corner.`);
    if (!relCheck.ok) return gateReply(relCheck);
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
  const res = corner.attemptSeverityChange(state, userId, interaction.user.id, actorTier, releaseAt);
  if (res.notFound) return interaction.editReply(`<@${userId}> is not in the corner.`);
  if (!res.ok) return gateReply(res);
  corner.armTimer(guild, userId, releaseAt);   // reschedule the pending auto-release — the stored releaseAt
  // changing doesn't touch the already-armed setTimeout, which would otherwise still fire at the OLD time
  // (a sentence extended from 2min to 1hr was auto-releasing at the original 2min mark, seen live in corner-log).
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
  // Cache bounds — bots-vm has only ~970MB of RAM shared with melanin-bot, bubble-girl, tailscaled and
  // cloudflared. With discord.js's defaults (200 messages PER CHANNEL, never expired) this process grew to
  // ~300MB / 30% of the box in 11.5 hours, pushed the machine 1GB into swap, and drove iowait to 97% — at
  // which point it could no longer ack a Discord interaction inside the 3s window and users just saw
  // "the application did not respond" on unrelated commands (owner-reported 2026-08-21, on /uncorner and
  // the media filter). It was never a bug in those commands; the process was stuck waiting on disk.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 60,               // per channel, down from 200
    ReactionManager: 20,
    GuildInviteManager: 0,
    PresenceManager: 0,               // no GuildPresences intent anyway
  }),
  // Time-based eviction on top of the per-channel cap, so quiet channels don't hoard stale messages
  // forever. NOTE the tradeoff: #deletion-log only logs a delete when the message was still cached
  // (msg.partial → it can't know the content), so a message deleted more than ~3h after it was posted
  // now goes unlogged. In a busy channel the old 200-message cap already evicted sooner than that.
  // Members/roles are deliberately NOT swept — role.members and ensureMembers() depend on that cache.
  sweepers: {
    messages: { interval: 1800, lifetime: 10800 },   // every 30m, drop messages older than 3h
    threads: { interval: 3600, lifetime: 14400 },    // every 1h, drop threads untouched for 4h
  },
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
    if (m) { botdeletes.mark(m.id); await m.delete().catch(() => {}); }
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
// Boot backfill: throne messages posted while the bot was down (or before expiry tracking existed, e.g. the
// old server) carry NO timer, so they never clear. Scan each tribe's throne and schedule every un-timed
// transient message to delete 24h after IT was posted — overdue ones (>24h) fire on the next tick. Skips the
// pinned control panel and anything already tracked. Idempotent, so it's safe to run on every boot.
async function backfillThroneExpiries(guild) {
  const now = Date.now();
  const tracked = new Set(throneExpire.all().map(e => e.messageId));
  let scheduled = 0;
  for (const t of tribes.all()) {
    if (!t.throneId) continue;
    const ch = await guild.channels.fetch(t.throneId).catch(() => null);
    if (!ch || !ch.messages) continue;
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs) continue;
    for (const m of msgs.values()) {
      if (m.pinned || tracked.has(m.id)) continue;
      if (m.type !== MessageType.Default && m.type !== MessageType.Reply) continue;
      const isPanel = t.panelMessageId ? m.id === t.panelMessageId : !!(m.content && m.content.includes(': what you can do'));
      if (isPanel) continue;
      const deadline = m.createdTimestamp + throneExpire.TTL_MS;
      throneExpire.add(m.channelId, m.id, deadline);
      armThroneExpire(m.channelId, m.id, deadline - now);   // past-due → deletes on the next tick
      scheduled++;
    }
  }
  if (scheduled) console.log(`[throneExpire] boot backfill: scheduled ${scheduled} previously-untimed throne message(s)`);
}

// Auto-restore lost tribe membership: a ranked member (holds a rank role: Initiate/Member/…) who has LOST the
// base tribe role is in a broken state — they don't count as "in a tribe" (join gates, standings, points all
// key off the base role), so they can even be poached into another tribe. Re-add the base role to any such
// member. Leaders/General are intentionally NOT rank-and-file (they hold the leader/staff role, not the base),
// so they're not swept here. Boot + hourly. (Members fully stripped of every role can't be detected from roles;
// those are a manual/banish concern, not an accidental-loss one.)
async function reconcileTribeRoles(guild) {
  // MUST full-fetch: role.members / members.cache only holds active (gateway-seen) members, so an INACTIVE member
  // who lost their base role is invisible without this — the original bug where "people are still missing".
  await guild.members.fetch().catch(e => console.error('[tribe reconcile] member fetch:', e.message));
  const all = tribes.all().filter(t => t.roleId);
  let restored = 0, failed = 0, conflicts = 0;
  for (const m of guild.members.cache.values()) {
    // Anyone carrying a tribe role — rank-and-file OR leader/general — should carry its base membership
    // role too. Leaders are staff AND members (owner policy, 2026-08-07): being staff of a tribe never
    // excludes you from being a member of it, for every tribe, not just member-founded ones.
    const rankOf = all.filter(t => {
      const holdsRank = (t.ranks || []).some(r => r.roleId && m.roles.cache.has(r.roleId));
      const holdsLeaderGen = (t.leaderRoleId && m.roles.cache.has(t.leaderRoleId)) || (t.staffRankRoleId && m.roles.cache.has(t.staffRankRoleId));
      return holdsRank || holdsLeaderGen;
    });
    const missing = rankOf.filter(t => !m.roles.cache.has(t.roleId));
    if (!missing.length) continue;
    if (rankOf.length >= 2) { conflicts++; continue; }   // leftover rank roles from 2 tribes — needs a human call, don't guess a tribe
    try { await m.roles.add(missing[0].roleId, 'Tribe reconcile: restore lost base membership role (held a rank role)'); restored++; }
    catch (e) { failed++; console.error(`[tribe reconcile] restore ${missing[0].key} base for ${m.id} failed: ${e.message}`); }
  }
  if (restored || failed || conflicts) console.log(`[tribe reconcile] restored ${restored} base role(s)${failed ? `, ${failed} FAILED` : ''}${conflicts ? `, ${conflicts} multi-tribe conflict(s) skipped (need manual resolution)` : ''}`);
  return restored;
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
      case 'eventorg': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        const { forum, apps } = await eventorgapps.setup(g, config);
        return interaction.editReply(`✅ Event Organizer applications ready: review forum <#${forum.id}> + applicant threads in <#${apps.id}>. Members apply with \`/apply-event-organizer\`.`);
      }
      case 'adultcorner': {
        if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, ...eph });
        await interaction.deferReply(eph);
        let ch = config.adultCornerChannelId ? await g.channels.fetch(config.adultCornerChannelId).catch(() => null) : null;
        let created = false;
        if (!ch) {
          ch = await g.channels.create({
            name: '🔞┆ᴀᴅᴜʟᴛ-ᴄᴏʀɴᴇʀ',
            type: ChannelType.GuildText,
            reason: 'Setup 18+ Adult Corner channel'
          });
          config.adultCornerChannelId = ch.id;
          created = true;
        }
        await corner.ensureCornerPerms(g);
        return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} Adult Corner <#${ch.id}>.`);
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

// Mods get channel management ONLY where they can already see (owner, 2026-08-21). ManageChannels was
// removed from the MODS role guild-wide because it survives into channels a mod CAN'T see and lets them
// rewrite the overwrites to let themselves in. This grants it back per-channel, scoped so it can never
// reach a channel they aren't already in.
//
// Decided at CATEGORY granularity (owner's preference) but WRITTEN per-channel, because Discord does not
// propagate a category's overwrites to children that have their own — verified live: granting
// ManageChannels on a category left a child with its own overwrites still at ManageChannels=false. So a
// category-only grant would silently fail to give mods anything on most channels.
//
// The invariant is deliberately strict: grant only where EVERY holder of the MODS role can view the
// channel. Anything weaker (e.g. "the MODS role alone can see it", or "some mod can") would hand
// ManageChannels to mods who can't view that channel — which is the exact hole being closed. Runs on a
// schedule so newly-created channels are covered automatically, and it revokes as well as grants, so a
// channel that later becomes hidden loses the grant on the next pass (fail-closed).
const MOD_MANAGE_REASON = 'Mods manage channels only where every mod can already see them (security scoping)';
async function syncModManageChannels(guild) {
  const modRole = guild.roles.cache.get(opspanel.MOD_ROLE_ID) || await guild.roles.fetch(opspanel.MOD_ROLE_ID).catch(() => null);
  if (!modRole) return { granted: 0, revoked: 0, skipped: true };
  await ensureMembers(guild);
  const mods = [...modRole.members.values()].filter(m => !m.user.bot);
  if (!mods.length) return { granted: 0, revoked: 0, skipped: true };   // never blanket-grant off an empty roster
  const chans = [...(await guild.channels.fetch()).values()].filter(Boolean);
  let granted = 0, revoked = 0;
  const touched = [];
  for (const ch of chans) {
    if (!ch.permissionOverwrites) continue;
    const allCanSee = mods.every(m => ch.permissionsFor(m)?.has(PermissionsBitField.Flags.ViewChannel));
    const has = !!ch.permissionOverwrites.cache.get(modRole.id)?.allow.has(PermissionsBitField.Flags.ManageChannels);
    try {
      let changed = false;
      if (allCanSee && !has) { await ch.permissionOverwrites.edit(modRole.id, { ManageChannels: true }, { reason: MOD_MANAGE_REASON }); granted++; changed = true; }
      else if (!allCanSee && has) { await ch.permissionOverwrites.edit(modRole.id, { ManageChannels: null }, { reason: `${MOD_MANAGE_REASON} — revoked, not all mods can see this channel` }); revoked++; changed = true; }
      // Bless IMMEDIATELY, not in a batch at the end: a full pass is 100+ sequential rate-limited edits
      // and takes minutes, so a permguard sweep landing mid-pass would revert every grant not yet
      // blessed (observed on the first live run — only 36 of 109 survived).
      if (changed) { touched.push(ch.id); await permguard.blessChannel(guild, ch.id).catch(() => {}); }
    } catch (e) { console.error(`[mod-manage] ${ch.name}: ${e.message}`); }
  }
  if (granted || revoked) console.log(`[mod-manage] scoped ManageChannels: +${granted} granted, -${revoked} revoked (${mods.length} mods, ${chans.length} channels)`);
  return { granted, revoked };
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
    botdeletes.mark(del.map(m => m.id));
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
const GUIDE_FILE = process.env.FUBU_GUIDE_FILE || statePath('guide.json');
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

  // Static staff command reference — its own pinned messages at the top of #mod-dashboard (kept off the
  // Overview page so the live panel stays lean as the toolkit grows). Created BEFORE the panel below so
  // it lands earlier in the channel history / above the live dashboard, per owner request 2026-08-19.
  opspanel.ensureCommandRef(client).then(() =>
    // Ops dashboard: create/refresh the pinned tier-gated panel in the mod-only dashboard channel
    // (channel id persisted in the panel ref file). Light 5-min refresh keeps counts current.
    opspanel.ensurePanel(client).catch(err => console.error('[fops] init:', err.message))
  ).catch(err => console.error('[fops] cmdref init:', err.message));
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
    // Corner entry-point visibility: always open (null = no default restriction) so /corner + "Send to
    // corner" stay visible whether or not 'memberCorner' is currently on — the handlers gate who may
    // actually corner, and tell a verified member plainly if the feature itself is turned off. Keeping
    // visibility flag-independent means toggling 'memberCorner' takes effect live, no bot restart needed.
    const cornerVis = null;
    const allCmds = [
      ...(features.enabled('amongUs') ? [amongus.commandBuilder()] : []),   // /amongus (staff-start VC game); off unless the flag is on
      ...(features.enabled('mafia') ? [mafia.commandBuilder()] : []),       // /mafia (staff-start VC game, full engine); off unless the flag is on
      new SlashCommandBuilder().setName('corner').setDescription('Send a member to the corner: strips roles, pulls them from voice, jails them (optionally timed)')
        .addUserOption(o => o.setName('user').setDescription('Member to corner').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription(copy.corner.durationOpt).setRequired(false))
        .addStringOption(o => o.setName('rule').setDescription('Which rule did they break? (optional)').setRequired(false)
          .addChoices(...SERVER_RULES.map((r, i) => ({ name: `${i + 1}. ${r}`, value: String(i + 1) }))))
        .addStringOption(o => o.setName('reason').setDescription('Or type a custom reason (optional)').setRequired(false))
        .addBooleanOption(o => o.setName('adult').setDescription('Send to the 18+ Adult Corner for adult chat offenses?').setRequired(false))
        .addBooleanOption(o => o.setName('thread').setDescription('Imprison to a private jail thread?').setRequired(false))
        .addStringOption(o => o.setName('slowmode').setDescription('Slowmode for their jail thread, e.g. 30s/5m (needs thread:true)').setRequired(false))
        .addBooleanOption(o => o.setName('anon').setDescription('Hide your name and announce as Anonymous Staff (bot)').setRequired(false))
        .addStringOption(o => o.setName('also').setDescription('Corner more members too: @mention them or paste IDs, space-separated (same duration/reason)').setRequired(false))
        .addStringOption(o => o.setName('sweep').setDescription('Also corner everyone non-staff who posted in THIS channel in the last N minutes, e.g. 5').setRequired(false))
        .setDefaultMemberPermissions(cornerVis),   // always visible; the handler enforces staff/trial/member restrictions (and tells a member plainly if 'memberCorner' is off)
      new SlashCommandBuilder().setName('uncorner').setDescription('Release a member from the corner (or schedule a release)')
        .addUserOption(o => o.setName('user').setDescription('Member to release').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription(`Optional, e.g. release automatically instead of now`).setRequired(false))
        .addStringOption(o => o.setName('also').setDescription('Release more members too: @mention them or paste IDs, space-separated (same duration)').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods may release too (handler allows them)
      new SlashCommandBuilder().setName('cornered').setDescription('List everyone in the corner, with one-click release buttons')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // trial mods work the corner, so they need the list too
      new SlashCommandBuilder().setName('corner-status').setDescription('Change whether an active corner is treated as a joke or real')
        .addUserOption(o => o.setName('user').setDescription('Member currently in the corner').setRequired(true))
        .addStringOption(o => o.setName('status').setDescription('joke = release tier lock waived · real = normal tier lock applies').setRequired(true)
          .addChoices({ name: 'joke — waive the release tier lock', value: 'joke' }, { name: 'real — normal release tier lock applies', value: 'real' }))
        .addStringOption(o => o.setName('also').setDescription('Change more members too: @mention them or paste IDs, space-separated (same status)').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // mod+ only (handler excludes Trial Mods — owner, 2026-08-19: "they're the only ones who should have this ability anyway")
      new SlashCommandBuilder().setName('wordfilter').setDescription('Auto-delete messages containing a word/phrase for a period going forward')
        .addSubcommand(s => s.setName('add').setDescription('Start auto-deleting messages that contain a word/phrase')
          .addStringOption(o => o.setName('word').setDescription('The word or phrase to auto-delete').setRequired(true))
          .addStringOption(o => o.setName('duration').setDescription('How long, e.g. 30m, 2h, 3d (blank = until you remove it)').setRequired(false)))
        .addSubcommand(s => s.setName('list').setDescription('Show the active word filters'))
        .addSubcommand(s => s.setName('remove').setDescription('Stop an active word filter early')
          .addStringOption(o => o.setName('word').setDescription('The filtered word/phrase to stop').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
      new SlashCommandBuilder().setName('mediafilter').setDescription('Auto-delete specific GIFs/attachments (not a blanket block)')
        .addSubcommand(s => s.setName('list').setDescription('Show the active media filters'))
        .addSubcommand(s => s.setName('add-gif').setDescription('Block one specific GIF link (not every GIF)')
          .addStringOption(o => o.setName('url').setDescription('The GIF link to block').setRequired(true))
          .addStringOption(o => o.setName('duration').setDescription('How long, e.g. 30m, 2h, 3d (blank = until you remove it)').setRequired(false)))
        .addSubcommand(s => s.setName('remove-gif').setDescription('Stop blocking a specific GIF link')
          .addStringOption(o => o.setName('url').setDescription('The GIF link to unblock').setRequired(true)))
        .addSubcommand(s => s.setName('remove-hash').setDescription('Stop blocking a specific attachment (paste the hash from /mediafilter list)')
          .addStringOption(o => o.setName('hash').setDescription('The hash to unblock').setRequired(true)))
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

      new SlashCommandBuilder().setName('report').setDescription('Report a member to staff — opens a private thread so it can get sorted out')
        .addStringOption(o => o.setName('text').setDescription('What happened?').setRequired(true).setMaxLength(1000))
        .addUserOption(o => o.setName('user').setDescription('Who are you reporting? (optional)'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('report-setup').setDescription('Create the anon-reports channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('modmail').setDescription('Send an anonymous message to the mod team')
        .addStringOption(o => o.setName('text').setDescription('Your message').setRequired(true).setMaxLength(1000))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('modmail-setup').setDescription('Create the mod-inbox channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('sidebar').setDescription('Pull a member aside for a private chat (staff)')
        .addUserOption(o => o.setName('user').setDescription('Who do you want to talk to?').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('What about? (optional, they’ll see this)').setRequired(false).setMaxLength(500))
        .addUserOption(o => o.setName('user2').setDescription('Also pull in (optional)').setRequired(false))
        .addUserOption(o => o.setName('user3').setDescription('Also pull in (optional)').setRequired(false))
        .addUserOption(o => o.setName('user4').setDescription('Also pull in (optional)').setRequired(false))
        .addUserOption(o => o.setName('user5').setDescription('Also pull in (optional)').setRequired(false)),
      new SlashCommandBuilder().setName('sidebar-setup').setDescription('Create the sidebars channel (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

      new SlashCommandBuilder().setName('apply-mod').setDescription('Apply to become a moderator').setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('apply-mod-setup').setDescription('Create the private mod-applications forum (owner)').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder().setName('mod-applications').setDescription('Open or close mod applications when the team is full (admin)')
        .addSubcommand(s => s.setName('status').setDescription('Are mod applications open or closed right now?'))
        .addSubcommand(s => s.setName('open').setDescription('Reopen mod applications: accept new /apply-mod again')
          .addStringOption(o => o.setName('track').setDescription('Which position? (default: both)').setRequired(false)
            .addChoices({ name: 'Both', value: 'both' }, { name: 'Moderator', value: 'mod' }, { name: 'Mini-mod', value: 'lang' })))
        .addSubcommand(s => s.setName('close').setDescription('Close mod applications (team full); in-flight applications still finish')
          .addStringOption(o => o.setName('track').setDescription('Which position? (default: both)').setRequired(false)
            .addChoices({ name: 'Both', value: 'both' }, { name: 'Moderator', value: 'mod' }, { name: 'Mini-mod', value: 'lang' }))
          .addStringOption(o => o.setName('message').setDescription('Optional custom note shown to members who try to apply').setRequired(false).setMaxLength(400)))
        .addSubcommand(s => s.setName('restore').setDescription('Bring an archived application back as a fresh vote (e.g. reconsider a mini-mod for full Mod)')
          .addUserOption(o => o.setName('user').setDescription('The applicant whose archived application to restore').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('apply-event-organizer').setDescription('Apply to become an Event Organizer').setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('event-organizer-applications').setDescription('Open or close Event Organizer applications (admin)')
        .addSubcommand(s => s.setName('status').setDescription('Are Event Organizer applications open or closed right now?'))
        .addSubcommand(s => s.setName('open').setDescription('Reopen Event Organizer applications'))
        .addSubcommand(s => s.setName('close').setDescription('Close Event Organizer applications; in-flight applications still finish')
          .addStringOption(o => o.setName('message').setDescription('Optional custom note shown to members who try to apply').setRequired(false).setMaxLength(400)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('hitsquad').setDescription('Hit squad: activate (admin), or squad-member chaos powers during the window')
        .addSubcommand(s => s.setName('activate').setDescription('Admin: name who\'s on the squad for the next 10 minutes')
          .addStringOption(o => o.setName('members').setDescription('@mention or paste IDs, space-separated').setRequired(true)))
        .addSubcommand(s => s.setName('slowmode').setDescription('Squad only: set slowmode in current channel (reverts at window end)')
          .addIntegerOption(o => o.setName('seconds').setDescription('Slowmode in seconds, 0-21600 (0 = off)').setRequired(true).setMinValue(0).setMaxValue(21600)))
        .addSubcommand(s => s.setName('nickname').setDescription('Squad only: change someone\'s nickname (reverts at window end)')
          .addUserOption(o => o.setName('user').setDescription('Who to rename').setRequired(true))
          .addStringOption(o => o.setName('nickname').setDescription('New nickname, max 32 characters').setRequired(true).setMaxLength(32)))
        .setDefaultMemberPermissions(null),   // always visible; the handler gates activate to admin+ and the
        // other two to a currently-active squad member — matches /corner's cornerVis convention
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
      new SlashCommandBuilder().setName('demote-mod').setDescription('Remove the Mod role from a member (owner)')
        .addStringOption(o => o.setName('member').setDescription('The mod to demote').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('reason').setDescription('Optional note, kept internal').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
      new SlashCommandBuilder().setName('demote-admin').setDescription('Remove the Admin role from a member (owner)')
        .addStringOption(o => o.setName('member').setDescription('The admin to demote').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('reason').setDescription('Optional note, kept internal').setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

      // #roles picker management — one-up on the old Carl-bot setup: add/remove a self-assign role in a
      // section with one command, no manual message editing (admin).
      new SlashCommandBuilder().setName('roleselect-role').setDescription('Add or remove a self-assign role in #roles (admin)')
        .addSubcommand(s => s.setName('add').setDescription('Add a role to a #roles section')
          .addStringOption(o => o.setName('section').setDescription('Which section').setRequired(true)
            .addChoices({ name: 'Age', value: 'age' }, { name: 'Color', value: 'colors' }, { name: 'Region', value: 'region' }, { name: 'Language', value: 'language' },
              { name: 'Notifications', value: 'notifications' }, { name: 'Pronouns', value: 'pronouns' }, { name: 'Misc', value: 'misc' }))
          .addRoleOption(o => o.setName('role').setDescription('The role to add').setRequired(true))
          .addStringOption(o => o.setName('label').setDescription('Button text (default: the role name, add your own emoji if you want one)').setRequired(false)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a role from a #roles section')
          .addStringOption(o => o.setName('section').setDescription('Which section').setRequired(true)
            .addChoices({ name: 'Age', value: 'age' }, { name: 'Color', value: 'colors' }, { name: 'Region', value: 'region' }, { name: 'Language', value: 'language' },
              { name: 'Notifications', value: 'notifications' }, { name: 'Pronouns', value: 'pronouns' }, { name: 'Misc', value: 'misc' }))
          .addRoleOption(o => o.setName('role').setDescription('The role to remove').setRequired(true)))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

      new SlashCommandBuilder().setName('birthday').setDescription('Set your birthday — you get a 🎉 Birthday role for the day, every year')
        .addSubcommand(s => s.setName('set').setDescription('Set (or update) your birthday and UTC offset')
          .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
          .addIntegerOption(o => o.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31))
          .addStringOption(o => o.setName('utc_offset').setDescription('Your UTC offset, e.g. -5, +5:30, or UTC-8 — required, so it\'s YOUR day, not the server\'s').setRequired(true))
          .addIntegerOption(o => o.setName('year').setDescription('Birth year (optional)').setRequired(false).setMinValue(1900).setMaxValue(2100))
          .addUserOption(o => o.setName('member').setDescription('Set someone else\'s birthday instead — staff only, also how you correct an already-set one').setRequired(false)))
        .addSubcommand(s => s.setName('view').setDescription('See your saved birthday'))
        .addSubcommand(s => s.setName('clear').setDescription('Remove your saved birthday')),

      new SlashCommandBuilder().setName('awards').setDescription('Weekly peer-voted member awards (e.g. Funniest Member)')
        .addSubcommand(s => s.setName('vote').setDescription('Vote for someone in a category (not yourself, one vote/category/week)')
          .addStringOption(o => o.setName('category').setDescription('Which award').setRequired(true).setAutocomplete(true))
          .addUserOption(o => o.setName('member').setDescription('Who you\'re voting for').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('See this week\'s award categories and current holders'))
        .addSubcommand(s => s.setName('category-add').setDescription('Add an award category (staff)')
          .addStringOption(o => o.setName('key').setDescription('Short id, e.g. funniest').setRequired(true).setMaxLength(30))
          .addStringOption(o => o.setName('name').setDescription('Display name, e.g. 😂 Funniest Member').setRequired(true).setMaxLength(80)))
        .addSubcommand(s => s.setName('category-remove').setDescription('Remove an award category (staff) — deletes its role too')
          .addStringOption(o => o.setName('category').setDescription('Which award').setRequired(true).setAutocomplete(true))),

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
      new SlashCommandBuilder().setName('prove').setDescription('Proving Grounds: run today’s solo gauntlet (once a day)').setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('dashboard').setDescription('Your member hub: status, server info, and every member feature')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('dashboard-setup').setDescription('Post + pin the public member hub panel in this channel (admin)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),   // admin ROLE, not the Administrator perm
      new SlashCommandBuilder().setName('tribe').setDescription('Your tribe: info, roster, standings, and (leaders) set the motto')
        .addSubcommand(s => s.setName('info').setDescription('A tribe’s overview (yours by default)')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe (default: yours)').setRequired(false).setAutocomplete(true)))
        .addSubcommand(s => s.setName('found').setDescription('Rally members to found a brand-new tribe (needs 9 cosigns)'))
        .addSubcommand(s => s.setName('banner').setDescription('Set your tribe’s banner image (leaders; members make the art)')
          .addAttachmentOption(o => o.setName('image').setDescription('A banner image (PNG/JPG). Leave blank to clear it.').setRequired(false)))
        .addSubcommand(s => s.setName('retheme').setDescription('Recolour and/or rename your tribe (needs the Re-theme unlock; leaders only)')
          .addStringOption(o => o.setName('color').setDescription('Primary colour hex, e.g. #2A426A').setRequired(true))
          .addStringOption(o => o.setName('color2').setDescription('Second hex for a gradient (optional)').setRequired(false))
          .addStringOption(o => o.setName('name').setDescription('New full tribe name (optional)').setRequired(false).setMaxLength(80))
          .addStringOption(o => o.setName('short_name').setDescription('New short name for cards (optional)').setRequired(false).setMaxLength(40)))
        .addSubcommand(s => s.setName('icon').setDescription('Set an emoji OR image icon on your tribe role (needs the Tribe Icon unlock; leaders only)')
          .addStringOption(o => o.setName('emoji').setDescription('An emoji for the icon (or "none" to clear)').setRequired(false).setMaxLength(60))
          .addAttachmentOption(o => o.setName('image').setDescription('A square image (PNG/JPG, under 256KB) to use as the icon').setRequired(false)))
        // motto/banish/invite/nominate/offer/muster/announce/note/rank retired 2026-08-10 — all folded into
        // /tribe panel (Invite/Banish/Note/Set Rank/Muster/Announce/Motto/Tithe/Nominate buttons), which
        // reuses the SAME underlying tribethrone_*/submitInvite/submitBanish/createNomination logic these
        // commands called, just reached from one contextual panel instead of nine separate commands.
        .addSubcommand(s => s.setName('panel').setDescription('One panel, right where you are: Tribe Games, your tribe\'s lore/path tools, or staff controls'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),
      new SlashCommandBuilder().setName('tribe-admin').setDescription('Create or register tribes (admin)')
        .addSubcommand(s => s.setName('create').setDescription('Found a brand-new tribe: opens a guided setup (identity, colours, land)')
          .addUserOption(o => o.setName('leader').setDescription('The tribe leader: an admin, or a mod naming themselves').setRequired(true)))
        .addSubcommand(s => s.setName('hub-setup').setDescription('Create (or refresh) the Tribes Hub reference + button channel'))
        .addSubcommand(s => s.setName('ping-all').setDescription('Ping every tribe role at once (handy when tribe names have untypeable characters)')
          .addStringOption(o => o.setName('message').setDescription('Optional text to post above the pings').setRequired(false))
          .addBooleanOption(o => o.setName('leaders_only').setDescription('Ping just the leader roles instead of everyone (default: everyone)').setRequired(false)))
        .addSubcommand(s => s.setName('register').setDescription('Adopt an EXISTING role + channels as a tribe')
          .addStringOption(o => o.setName('key').setDescription('Short key, e.g. valith').setRequired(true))
          .addStringOption(o => o.setName('name').setDescription('Full tribe name').setRequired(true))
          .addRoleOption(o => o.setName('role').setDescription('The tribe member role').setRequired(true))
          .addRoleOption(o => o.setName('leader_role').setDescription('The leader role (optional)').setRequired(false))
          .addChannelOption(o => o.setName('hall').setDescription('Main tribe channel (optional)').setRequired(false))
          .addStringOption(o => o.setName('emoji').setDescription('Tribe emoji (optional)').setRequired(false)))
        .addSubcommand(s => s.setName('set-leader').setDescription('Add or replace a tribe leader (restructure a tribe that lost one)')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true))
          .addUserOption(o => o.setName('member').setDescription('The new leader (also joins the tribe if not already in it)').setRequired(true))
          .addUserOption(o => o.setName('replacing').setDescription('Optional: an existing leader to step down at the same time').setRequired(false)))
        .addSubcommand(s => s.setName('disband').setDescription('Dissolve a tribe: deletes its roles + channels, cannot be undone')
          .addStringOption(o => o.setName('tribe').setDescription('Which tribe').setRequired(true).setAutocomplete(true)))
        // arena/sealed-arena/trial/points/title/staffrank-set retired 2026-08-10 — folded into /tribe panel
        // (the "Launch an event" select for the first three; the Settings modal for the last three, though
        // Settings is scoped to the CALLER'S OWN tribe via canManageTribe, narrower than these commands' old
        // any-tribe-by-autocomplete reach — an owner still has full reach via the owner-tier override in
        // canManageTribe, but a non-owner admin configuring a tribe they aren't a member of has no path
        // anymore. Flagged, not silently dropped.)
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
        .addSubcommand(s => s.setName('enroll').setDescription('Force-add a member to a tribe — no invite, no accept, no gate (owner only)')
          .addUserOption(o => o.setName('member').setDescription('Who to enroll').setRequired(true))
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
      new SlashCommandBuilder().setName('event-award').setDescription('Award tribe points to the winners of your event (fuses any event with the tribe fight)')
        .addUserOption(o => o.setName('first').setDescription('1st place (their tribe gets the most)').setRequired(true))
        .addUserOption(o => o.setName('second').setDescription('2nd place (optional)').setRequired(false))
        .addUserOption(o => o.setName('third').setDescription('3rd place (optional)').setRequired(false))
        .addStringOption(o => o.setName('event').setDescription('Event name for the announcement, e.g. Black Trivia Quiz').setRequired(false).setMaxLength(80))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageEvents),   // organizers hold ManageEvents; handler also allows staff
      new ContextMenuCommandBuilder().setName('Report to watchlist').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Send to corner').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(cornerVis),   // see cornerVis: always visible, handler gates who may actually act
      new ContextMenuCommandBuilder().setName('Strike').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
      new ContextMenuCommandBuilder().setName('Report').setType(ApplicationCommandType.Message).setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands),   // member-facing anon report
      new ContextMenuCommandBuilder().setName('Sidebar').setType(ApplicationCommandType.User)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),   // right-click a member → pull them into a private chat thread
      // Immediate ban (owner, 2026-08-12: "there's no way to ban someone immediately through the bot" — the
      // only existing path was buried inside the verify-panel's deny→kick→ban escalation chain, reachable
      // only for fresh joiners going through verification). Two entry points to the same handler: a slash
      // command for typing a user + reason, and a right-click context menu for the fastest possible path.
      // Gated at the Discord permission level (Ban Members) — same convention as /unban, no extra tier check.
      new SlashCommandBuilder().setName('ban').setDescription('Immediately ban a member')
        .addUserOption(o => o.setName('user').setDescription('Who to ban').setRequired(true))
        .addStringOption(o => o.setName('rule').setDescription('Which rule did they break? (optional)').setRequired(false)
          .addChoices(...SERVER_RULES.map((r, i) => ({ name: `${i + 1}. ${r}`, value: String(i + 1) }))))
        .addStringOption(o => o.setName('reason').setDescription('Or type a custom reason (optional)'))
        .addIntegerOption(o => o.setName('delete_days').setDescription('Delete their messages from the last N days (0-7, default 1)').setMinValue(0).setMaxValue(7))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers),
      new ContextMenuCommandBuilder().setName('Ban').setType(ApplicationCommandType.User)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers),
      new ContextMenuCommandBuilder().setName('Block this GIF').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
      new ContextMenuCommandBuilder().setName('Block this attachment').setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
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
    // Bless any owner-made changes FIRST — same "never revert something you just changed" guarantee
    // register()'s periodic sweep already gets, but this direct boot-time call was skipping it (owner,
    // 2026-08-20: "make sure changes that owner makes is excluded from the permguard sweep" — this repo
    // gets restarted often during active dev sessions, so every restart was a real revert-on-boot window
    // for a not-yet-blessed owner edit, not just a rare cold-boot case).
    await permguard.pollOwnerOverwrites(guild).catch(e => console.error('[permguard] boot owner-poll failed:', e.message));
    const permResult = await permguard.sweepPermissions(guild, { notify: false }).catch(e => { console.error('[permguard] boot sweep failed:', e.message); return null; });
    if (permResult) console.log(`[permguard] boot sweep: ${permResult.fixed} overwrite(s) corrected, ${permResult.newMemberOverwrites.length} new member-overwrite(s) flagged, ${permResult.unmanagedChannels} channel(s) unmanaged (created after snapshot)`);
    permguard.register(client);
    raidguard.register(client);
    if (features.enabled('amongUs')) amongus.register(client);   // VC Among Us mode: voice-state hook + boot RESUME of persisted games
    if (features.enabled('mafia')) mafia.register(client);       // VC Mafia mode: phase sweep + voice-state release hook
    // Monthly contests: arm the auto-close tick (crowns winners on the 1st of the month if a round's open).
    if (features.enabled('contest')) contest.register(client);
    // Sweep every current staff member's own application: mod+ gets archived (owner-only channel, removed
    // from the forum), trial-only gets sealed (removed from their applicant thread). Keeps history either way.
    let archived = 0, sealed = 0;
    for (const m of guild.members.cache.values()) {
      if (opspanel.meets(opspanel.memberTier(m), 'mod')) archived += await modapps.archiveOwnApplication(guild, m.id).catch(() => 0);
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
  // Prefer the already-populated cache (client.guilds.cache is filled by the READY event, which has
  // already fired by this point in boot) over a fresh network fetch — faster, and has no failure mode
  // of its own. Only fall back to fetch() if genuinely not cached yet, and actually LOG if that fails
  // too, instead of the old `.catch(() => null)` silently swallowing it — every `if (dguild) await ...`
  // below (awards reminder/results/vote-panel, MDNI sweep, dashboard tidy, etc.) depended on this and
  // had no way to tell "dguild was null" from "genuinely nothing to do" in the logs (owner, 2026-08-20:
  // caught the awards vote panel silently not posting on boot, traced to this).
  const dguild = client.guilds.cache.get(config.guildId)
    || await client.guilds.fetch(config.guildId).catch(e => { console.error('[boot] dguild fetch failed:', e.message); return null; });
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
  // Same minor-staff leak on the second MDNI channel (own channelId, same shared function).
  if (dguild) await sweepMdniStaffLock(dguild, config.mdniNsfwChannelId).catch(e => console.error(`[mdni-lock] boot sweep (nsfw): ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepMdniStaffLock(g, config.mdniNsfwChannelId)).catch(() => {}), 3600000);
  if (dguild) await sweepMdniStaffLock(dguild, config.mdniVerifiedVcId).catch(e => console.error(`[mdni-lock] boot sweep (vc): ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepMdniStaffLock(g, config.mdniVerifiedVcId)).catch(() => {}), 3600000);
  // Same minor-staff leak on Adult Corner (owner, 2026-08-19: "the point of the adult corner is so people
  // with nsfw offenses can talk about the issue with mods without children seeing/hearing" — a minor mod
  // would otherwise see it via their MOD role's blanket ViewChannel allow, same as MDNI before this fix).
  if (dguild && config.adultCornerChannelId) await sweepMdniStaffLock(dguild, config.adultCornerChannelId).catch(e => console.error(`[mdni-lock] boot sweep (adult corner): ${e.message}`));
  setInterval(() => { if (config.adultCornerChannelId) client.guilds.fetch(config.guildId).then(g => sweepMdniStaffLock(g, config.adultCornerChannelId)).catch(() => {}); }, 3600000);
  if (dguild) await sweepHitSquadRole(dguild).catch(e => console.error(`[hitsquad] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepHitSquadRole(g)).catch(() => {}), 3600000);

  // Weekly tribe crown: boot catch-up + hourly check (idempotent — see tribes.dueForWeeklyCrown).
  if (dguild) await processWeeklyCrownIfDue(dguild).catch(e => console.error(`[tribe crown] boot check: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => processWeeklyCrownIfDue(g)).catch(() => {}), 3600000);
  // Season end: boot catch-up + hourly check (idempotent — ensureSeason opens S1, dueForSeasonEnd gates it).
  if (dguild) await processSeasonEndIfDue(dguild).catch(e => console.error(`[tribe season] boot check: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => processSeasonEndIfDue(g)).catch(() => {}), 3600000);
  // The Chronicle: weekly chapter from the Lore Log. Boot catch-up + hourly; registered AFTER the crown so on
  // any given tick the crown records first and the chapter captures it (both weekly, same boundary, gated inside).
  if (dguild) await processChronicleIfDue(dguild).catch(e => console.error(`[tribe chronicle] boot check: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => processChronicleIfDue(g)).catch(() => {}), 3600000);
  // Recruitment payouts: boot catch-up + hourly (gated inside; the stick period is days, so hourly is ample).
  if (dguild) await sweepRecruitment(dguild).catch(e => console.error(`[recruitment] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepRecruitment(g)).catch(() => {}), 3600000);
  // Muster auto-close: boot catch-up + every 5min (a muster's 2h window makes a tighter cadence worth it).
  if (dguild) await sweepExpiredMusters(dguild).catch(e => console.error(`[tribe muster] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepExpiredMusters(g)).catch(() => {}), 5 * 60 * 1000);
  if (dguild) await sweepExpiredWarVotes(dguild).catch(e => console.error(`[tribe war] boot sweep: ${e.message}`));
  if (dguild) await sweepMemberFounding(dguild).catch(e => console.error(`[member-found] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepExpiredWarVotes(g)).catch(() => {}), 5 * 60 * 1000);
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepMemberFounding(g)).catch(() => {}), 5 * 60 * 1000);
  // Auto-resolve wars stuck ≥24h awaiting the defender's Accept/Decline (boot + hourly).
  if (dguild) await sweepStuckWars(dguild).catch(e => console.error(`[tribe war] stuck sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepStuckWars(g)).catch(() => {}), 3600000);
  // Propaganda (Phase 8): hourly tick, own once-a-day marker inside (dueForPropagandaDay).
  if (dguild) await propagandaDailyIfDue(dguild).catch(e => console.error(`[propaganda] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => propagandaDailyIfDue(g)).catch(() => {}), 3600000);
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
  // Remote word bank for Scramble/Reverse (owner: source from a bank, not hardcode): use the cache immediately,
  // then refresh from the common-word list in the background. Falls back to the curated list if the fetch fails.
  console.log(`[arena] word bank: ${arena.loadCachedWords()} cached; refreshing...`);
  arena.fetchWordBank().then(n => n && console.log(`[arena] remote word bank refreshed: ${n} words`)).catch(() => {});
  // Auto-start random arenas through the active day (owner). Checked every 15 min; the random next-auto time
  // (1h..2h after each event), the 1h floor + daily cap (via arena.startBlocked) keep it from over-firing.
  setInterval(() => client.guilds.fetch(config.guildId).then(g => maybeAutoStartArena(g)).catch(() => {}), 15 * 60000);
  setInterval(() => client.guilds.fetch(config.guildId).then(g => maybeAutoStartTribeGame(g)).catch(() => {}), 15 * 60000);
  // Sealed Arena (dark until enabled): resolve any in-flight one on boot (short, resolve-on-restart), then an
  // hourly auto-tick (peak hours, daily cap + min-gap gate inside).
  if (dguild) await reconcileSealed(dguild).catch(e => console.error(`[sealed] boot reconcile: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sealedAutoTick(g)).catch(() => {}), 3600000);
  // Tribe Games (Phase 8): entirely panel-initiated, so just resume an in-flight lobby countdown on boot.
  if (dguild) await reconcileTribeGames(dguild).catch(e => console.error(`[tribegames] boot reconcile: ${e.message}`));
  // Hit squad: re-arm the auto-revert timer if a window is still live across a restart, or clean up
  // immediately if the window (or the bot's downtime) already ran past it.
  if (dguild) {
    const hs = hitsquad.peekActive();
    if (hs) { if (hs.expiresAt > Date.now()) armHitSquadTimer(dguild, hs.expiresAt); else await deactivateHitSquad(dguild).catch(e => console.error('[hitsquad] boot reconcile:', e.message)); }
  }
  // Self-heal: if a tribe's pinned throne panel got deleted (manually, or a pin-cap eviction), repost it —
  // otherwise that tribe silently loses Invite/Banish/Muster/etc. until someone notices.
  if (dguild) {
    for (const t of tribes.all()) {
      if (!t.throneId) continue;
      const throne = await dguild.channels.fetch(t.throneId).catch(() => null);
      if (!throne) continue;
      const msg = t.panelMessageId ? await throne.messages.fetch(t.panelMessageId).catch(() => null) : null;
      if (!msg) {
        await postThroneGuide(dguild, t).catch(e => console.error(`[tribe] repost throne panel ${t.key}: ${e.message}`));
        console.log(`[tribe] reposted missing throne panel for ${t.key}`);
      } else {
        // Panel exists — refresh its CONTENT too (buttons/text change with code deploys; a repost only
        // triggers if the message is gone entirely, which would otherwise leave every tribe's panel stuck
        // on whatever was live the day it was first posted). Same self-heal for the lore reference,
        // independently of the panel — ensureLoreReference finds/edits its own message by id or pin
        // signature rather than blindly reposting.
        await msg.edit(tribeThronePanel(t)).catch(() => {});
        await ensureLoreReference(dguild, throne, t).catch(() => {});
      }
    }
  }
  // The Trials (dark until enabled): RESUME an in-flight Trial on boot (long VC event), then an hourly tick that
  // fires the daily scheduled Trial at peak (own once-a-day marker).
  if (dguild) await reconcileTrial(dguild).catch(e => console.error(`[trial] boot reconcile: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => trialAutoTick(g)).catch(() => {}), 3600000);
  // Proving Grounds weekly Prover reveal (dark until enabled): boot catch-up + hourly, fires at the week rollover.
  if (dguild) await proverWeeklyIfDue(dguild).catch(e => console.error(`[proving] boot weekly: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => proverWeeklyIfDue(g)).catch(() => {}), 3600000);
  try { rearmThroneExpiries(); } catch (e) { console.error(`[throneExpire] re-arm: ${e.message}`); }
  if (dguild) await backfillThroneExpiries(dguild).catch(e => console.error(`[throneExpire] backfill: ${e.message}`));
  if (dguild) await sweepStaffRanks(dguild).catch(e => console.error(`[tribe staffrank] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepStaffRanks(g)).catch(() => {}), 3600000);
  if (dguild) await sweepBirthdays(dguild).catch(e => console.error(`[birthday] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepBirthdays(g)).catch(() => {}), 3600000);
  if (dguild) await awardsReminderIfDue(dguild).catch(e => console.error(`[awards] boot reminder check: ${e.message}`));
  if (dguild) await awardsResultsIfDue(dguild).catch(e => console.error(`[awards] boot results check: ${e.message}`));
  if (dguild) await ensureAwardsVotePanel(dguild).catch(e => console.error(`[awards] panel boot: ${e.message}`));
  // Re-scope mods' channel management on boot (picks up any channel created while the bot was down),
  // then hourly. Not awaited into the boot critical path — it can touch 100+ channels on a first run.
  if (dguild) syncModManageChannels(dguild).catch(e => console.error(`[mod-manage] boot: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => syncModManageChannels(g)).catch(() => {}), 60 * 60 * 1000);
  setInterval(() => client.guilds.fetch(config.guildId).then(async g => { await awardsReminderIfDue(g); await awardsResultsIfDue(g); }).catch(() => {}), 3600000);
  if (dguild) await reconcileTribeRoles(dguild).catch(e => console.error(`[tribe reconcile] boot sweep: ${e.message}`));
  if (dguild) await backfillDefaultPaths(dguild).catch(e => console.error(`[tribe-paths] boot backfill: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => reconcileTribeRoles(g)).catch(() => {}), 3600000);
  // Mod-tribe 3-leader requirement (boot + hourly): alert → freeze perks at grace midpoint → disband-pending.
  if (dguild) await sweepLeaderRequirement(dguild).catch(e => console.error(`[leader-req] boot sweep: ${e.message}`));
  setInterval(() => client.guilds.fetch(config.guildId).then(g => sweepLeaderRequirement(g)).catch(() => {}), 3600000);

  // Age-role exclusivity + registration-lock backstops (boot + hourly, same cadence as MDNI above).
  if (dguild) {
    await ensureMembers(dguild);
    for (const m of dguild.members.cache.values()) await enforceAgeExclusivity(m).catch(() => {});
    const seeded = await sweepRegistrationLocks(dguild).catch(e => { console.error(`[registration-lock] boot sweep: ${e.message}`); return 0; });
    console.log(`[registration-lock] boot sweep: ${seeded} member(s) grandfathered in`);
    await sweepAdultVerified(dguild).catch(e => console.error(`[adult-verified] boot sweep: ${e.message}`));
    await sweepMdniVerified2(dguild).catch(e => console.error(`[mdni-verified2] boot sweep: ${e.message}`));
  }
  setInterval(async () => {
    const g = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!g) return;
    await ensureMembers(g);
    for (const m of g.members.cache.values()) await enforceAgeExclusivity(m).catch(() => {});
    await sweepAdultVerified(g).catch(e => console.error(`[adult-verified] hourly sweep: ${e.message}`));
    await sweepMdniVerified2(g).catch(e => console.error(`[mdni-verified2] hourly sweep: ${e.message}`));
  }, 3600000);
});

// Real-time conflict resolution: when someone reacts to the current weekly react-to-resolve
// message, fix them immediately (the hourly sweep is the safety net for missed events).
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
    // Live Tally — an Event Organizer/mod reacting with tally.POINT_EMOJI on a participant's OWN message,
    // in the event-chat channel, adds them a point (their tribe too, if they're in one — not the reactor's).
    const tl = tally.get();
    if (tl && reaction.message.channelId === tl.scoreChannelId && reaction.emoji?.name === tally.POINT_EMOJI) {
      const rguild = reaction.message.guild;
      const reactorMember = rguild && rguild.id === config.guildId ? await rguild.members.fetch(user.id).catch(() => null) : null;
      // Not an interaction, so opspanel.tierOf()'s cornered-actor check can't run here — same class of bug
      // fixed there (2026-08-19), same fix: a cornered reactor's memberTier() snapshot still resolves to
      // staff, so it must be checked directly rather than trusted.
      const authorized = reactorMember && !state.getCornered(user.id) && (opspanel.memberTier(reactorMember) || contest.isEventOrganizer(reactorMember));
      if (authorized) {
        const scoredMsg = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
        const authorId = scoredMsg && !scoredMsg.author?.bot ? scoredMsg.author?.id : null;
        const authorMember = authorId && rguild ? await rguild.members.fetch(authorId).catch(() => null) : null;
        if (authorMember) {
          const authorTribe = tribes.memberTribe(authorMember);   // null is fine — non-tribe members still score individually
          const cur = tally.get();   // re-read to reduce a double-score race between near-simultaneous reactions
          if (cur && cur.scoreChannelId === tl.scoreChannelId) {
            tally.addPoint(authorTribe ? authorTribe.key : null, authorId, 1);
            if (authorTribe) tribes.addTides(authorTribe.key, authorId, TIDES_PER_TALLY_POINT, 'combat');
            const fresh = tally.get();
            const ch = rguild && await rguild.channels.fetch(fresh.announceChannelId).catch(() => null);
            const smsg = ch && await ch.messages.fetch(fresh.standingsMessageId).catch(() => null);
            if (smsg) await smsg.edit({ content: tallyContent(fresh) }).catch(() => {});
          }
        }
      }
      return;   // it was a + reaction inside the event-chat channel while a tally's live — don't fall through
    }
    // Arena REACTION RUSH — first tribe member to react with the target emoji scores + advances the round.
    const ax = arena.get();
    if (ax && (ax.type === 'reaction' || ax.type === 'reactionhard') && ax.reactionOpen && reaction.message.id === ax.messageId) {
      if (reaction.emoji?.name === ax.target) {
        const rguild = reaction.message.guild;
        const member = rguild && rguild.id === config.guildId ? await rguild.members.fetch(user.id).catch(() => null) : null;
        const mine = member && tribes.memberTribe(member);
        const cur = arena.get();   // re-read to reduce a double-score race between near-simultaneous reactions
        if (mine && cur && (cur.type === 'reaction' || cur.type === 'reactionhard') && cur.reactionOpen && cur.messageId === ax.messageId) {
          arena.update({ reactionOpen: false });   // first-to-react closes this round
          scoreArena(mine.key, member.id);
          await postReactionRound(rguild).catch(() => {});
        }
      }
      return;   // it was a reaction on the arena message — don't fall through to react-resolve
    }
    // Arena SUDDEN DEATH — first member of a tied tribe to react the target wins the whole event.
    if (ax && ax.phase === 'suddendeath' && ax.sdMessageId && reaction.message.id === ax.sdMessageId && reaction.emoji?.name === ax.sdTarget) {
      const rguild = reaction.message.guild;
      const member = rguild && rguild.id === config.guildId ? await rguild.members.fetch(user.id).catch(() => null) : null;
      const key = member && (ax.sdTied || []).find(k => { const t = tribes.get(k); return t && member.roles.cache.has(t.roleId); });
      if (key) await resolveSuddenDeath(rguild, key).catch(() => {});
      return;
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
// Native welcome/goodbye — replaces Carl-bot + Mimu (owner, 2026-08-19: Mimu's embed-title mention
// "stopped showing tags"). Root cause: Discord only resolves an <@id> mention inside an EMBED from the
// viewer's own client cache — a brand-new member is never in anyone's cache yet, so it rendered as
// @unknown-user. The mention lives in message CONTENT here instead, which always resolves (same fix
// pattern used elsewhere in this file, e.g. logCorner's desc). Combines what were previously two separate
// messages (Mimu's embed + Carl-bot's rules-reminder text) into one post, per owner request. Banner GIFs
// are the exact ones Mimu used, downloaded once and stored locally (statePath) since Discord's CDN
// attachment URLs are signed and expire — hotlinking the original URL would have broken this later.
async function postWelcomeMessage(guild, member) {
  if (!config.welcomeChannelId) return;
  try {
    const ch = await guild.channels.fetch(config.welcomeChannelId).catch(() => null);
    if (!ch) return;
    const banner = statePath('welcome_banner.gif');
    const files = fs.existsSync(banner) ? [new AttachmentBuilder(banner, { name: 'welcome_banner.gif' })] : [];
    const embed = new EmbedBuilder().setColor(13090815)
      .setDescription('Welcome to For Us By Us, a space for black individuals from all over to connect, build '
        + 'community, and safely discuss what matters to us. No hate here, just unity. Read the rules to '
        + 'verify, and we’re glad to have you! 🫶🏾')
      .setImage(files.length ? 'attachment://welcome_banner.gif' : null);
    await ch.send({ content: `Welcome <@${member.id}>! Thank you for joining!`, embeds: [embed], files, allowedMentions: { users: [member.id] } });
  } catch (e) { console.error('[welcome] post failed:', e.message); }
}
async function postGoodbyeMessage(guild, member) {
  if (!config.goodbyeChannelId) return;
  try {
    const ch = await guild.channels.fetch(config.goodbyeChannelId).catch(() => null);
    if (!ch) return;
    const banner = statePath('goodbye_banner.gif');
    const files = fs.existsSync(banner) ? [new AttachmentBuilder(banner, { name: 'goodbye_banner.gif' })] : [];
    const embed = new EmbedBuilder().setColor(13090815)
      .setDescription('Glad we had you here 🫶🏾')
      .setImage(files.length ? 'attachment://goodbye_banner.gif' : null);
    await ch.send({ content: `Goodbye <@${member.id}>!`, embeds: [embed], files, allowedMentions: { users: [member.id] } });
  } catch (e) { console.error('[goodbye] post failed:', e.message); }
}

client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== config.guildId || member.user.bot) return;
    await postWelcomeMessage(member.guild, member);
    // A member who left WHILE cornered keeps their record (nothing clears it on leave — Discord itself
    // wipes their roles, but state.cornered is keyed by userId, not membership). Owner, 2026-08-17: rejoining
    // should drop them straight back in the corner, not through the normal Unverified/join flow — and NOT
    // re-strip roles (there's nothing to strip, they joined with none) or touch the stored `roles` snapshot,
    // so a later /uncorner still restores exactly what they had before they were first cornered.
    const cornerRec = state.getCornered(member.id);
    if (cornerRec && (cornerRec.releaseAt == null || cornerRec.releaseAt > Date.now())) {
      await member.roles.add(corner.cornerRoleFor(cornerRec.isAdult), 'Rejoined while still cornered').catch(e => console.error('[corner] rejoin re-apply:', e.message));
      await logCorner(member.guild, { emoji: '⛓️', title: 'REJOINED WHILE CORNERED', color: CORNER_RED,
        desc: `<@${member.id}> left the server while cornered and just rejoined — sent straight back to the corner.` });
      console.log(`[corner] ${member.id} rejoined while cornered, re-applied corner role`);
      return;
    }
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

client.on('guildMemberRemove', async (member) => {
  try {
    if (member.guild.id !== config.guildId || member.user.bot) return;
    await postGoodbyeMessage(member.guild, member);
  } catch (err) {
    console.error(`[goodbye] guildMemberRemove failed for ${member.id}: ${err.message}`);
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
// channelId param (owner, 2026-08-16): same minor-staff leak applies to ANY 18+ channel where staff get a
// blanket role-allow — generalized so both the original MDNI channel and the new MDNI NSFW channel share
// this one implementation instead of a copy-pasted twin.
async function enforceMdniStaffLock(member, { bless = true, channelId = config.mdniChannelId } = {}) {
  if (!channelId || !config.minorAgeRoleId || member.user?.bot) return null;
  const ch = member.guild.channels.cache.get(channelId) || await member.guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return null;
  const VIEW = PermissionsBitField.Flags.ViewChannel;
  const isMinor = member.roles.cache.has(config.minorAgeRoleId);
  // 'staff' (trial mod / language mini-mod / event organizer) included alongside mod/admin: found live
  // 2026-08-22 that a minor TRIAL mod still saw the Adult Corner via trialModRoleId's role-level allow —
  // that role sits at memberTier() 'staff', which this check omitted, so needsLock was false for her even
  // though she was actively exposed. Any tier holding a role with its own ViewChannel allow on a locked
  // channel needs this same protection; owner-tier stays exempt (owner ruling 2026-08-01).
  const needsLock = isMinor && ['staff', 'mod', 'admin'].includes(opspanel.memberTier(member));
  const ow = ch.permissionOverwrites.cache.get(member.id);
  const botLocked = !!(ow && ow.type === 1 && ow.deny.has(VIEW) && ow.allow.bitfield === 0n);
  let changed = null;
  if (needsLock && !botLocked) {
    await ch.permissionOverwrites.edit(member.id, { ViewChannel: false }, { reason: 'MDNI is 18+ — minor staff excluded (member deny overrides staff role allow)' }).catch(e => console.error('[mdni-lock] add:', e.message));
    console.log(`[mdni-lock] locked minor-staff ${member.user.tag} out of ${ch.name}`);
    changed = { id: member.id, tag: member.user.tag, locked: true };
  } else if (!needsLock && botLocked) {
    await ch.permissionOverwrites.delete(member.id, 'no longer minor-staff — MDNI lock lifted').catch(e => console.error('[mdni-lock] del:', e.message));
    console.log(`[mdni-lock] lifted MDNI lock on ${member.user.tag} for ${ch.name}`);
    changed = { id: member.id, tag: member.user.tag, locked: false };
  }
  if (changed && bless) await permguard.blessChannel(member.guild, channelId).catch(() => {});
  return changed;
}

// Backstop sweep (boot + hourly): lock every current minor-staff, and lift stale locks (member-denies whose
// holder is no longer a minor-staff). Re-snapshots MDNI once at the end so permguard treats the result as golden.
async function sweepMdniStaffLock(guild, channelId = config.mdniChannelId) {
  if (!channelId || !config.minorAgeRoleId) return 0;
  await ensureMembers(guild);
  const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return 0;
  const VIEW = PermissionsBitField.Flags.ViewChannel;
  let n = 0;
  const minorRole = guild.roles.cache.get(config.minorAgeRoleId);
  if (minorRole) for (const m of [...minorRole.members.values()]) { const r = await enforceMdniStaffLock(m, { bless: false, channelId }); if (r?.locked) n++; }
  // lift stale locks
  for (const o of [...ch.permissionOverwrites.cache.values()]) {
    if (o.type !== 1 || !o.deny.has(VIEW) || o.allow.bitfield !== 0n) continue;   // only our pure View-denies
    const m = await guild.members.fetch(o.id).catch(() => null);
    // Same tier list as needsLock in enforceMdniStaffLock above — MUST stay in sync, or this cleanup pass
    // deletes the lock the loop just above it created in the same sweep (hit live 2026-08-22: the tier
    // fix landed here but not here, so every boot/hourly sweep locked minor-staff out then immediately
    // unlocked them again, ~200ms later, in the same run).
    if (!m || !(m.roles.cache.has(config.minorAgeRoleId) && ['staff', 'mod', 'admin'].includes(opspanel.memberTier(m))))
      await ch.permissionOverwrites.delete(o.id, 'MDNI minor-staff lock cleanup').catch(() => {});
  }
  await permguard.blessChannel(guild, channelId).catch(() => {});
  if (n) console.log(`[mdni-lock] boot/hourly sweep (${ch.name}): locked ${n} minor-staff out`);
  return n;
}

// MDNI VERIFIED — RETIRED (owner, 2026-08-18): the combined role existed only because Discord can't
// express "requires BOTH role A and role B" at the permission layer. Once general-nsfw/nsfw-vc gate on
// the plain MDNI role directly, that's exactly as strong as "requires both" anyway, since enforceMdni()
// (above) already continuously strips MDNI from anyone without an adult age role — holding MDNI already
// IMPLIES adult. The derived role added a second role to keep in sync for no remaining benefit.

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
// Holding an age bracket role does NOT require being Verified — an external role-selector (Discord
// onboarding) can hand one out before verification, and that's fine to allow (owner, 2026-08-18: "People
// should be allowed to hold age roles when they join, we just have to make sure they can't access the
// channels because of their unverified status"). What needs fixing is ACCESS: an unverified member
// holding an adult bracket role could still see the age-gated Adults area, since the age role's
// channel-level ALLOW combines with (and beats) a same-tier role DENY on Unverified — Discord can't
// express "age role AND verified" any more than it could "staff AND adult" (see enforceMdniStaffLock).
// A member-level deny (the earlier fix) DOES beat a role allow, but doesn't scale: Discord caps
// overwrites per channel, and an influx of new members would blow through it (owner, 2026-08-18: "Is
// there a limit on personal overrides? An influx of people would blow through that limit" — correct).
// Same fix shape as the just-retired MDNI-Verified role: an auto-managed combined role that can't exist
// without both prerequisites, gating channels directly — one role grant per member, not one overwrite
// per member per channel, so it scales with membership instead of with (members × channels).
async function enforceAdultVerified(member) {
  if (!config.adultVerifiedRoleId || !config.verifiedRoleId || member.user?.bot) return null;
  const isVerified = member.roles.cache.has(config.verifiedRoleId);
  const isAdult = config.adultAgeRoleIds.some(id => member.roles.cache.has(id));
  const qualifies = isVerified && isAdult;
  const has = member.roles.cache.has(config.adultVerifiedRoleId);
  if (qualifies && !has) {
    await member.roles.add(config.adultVerifiedRoleId, 'Verified + adult age role both confirmed').catch(e => console.error('[adult-verified] add:', e.message));
    return { id: member.id, tag: member.user.tag, granted: true };
  }
  if (!qualifies && has) {
    await member.roles.remove(config.adultVerifiedRoleId, 'no longer holds both Verified and an adult age role').catch(e => console.error('[adult-verified] remove:', e.message));
    return { id: member.id, tag: member.user.tag, granted: false };
  }
  return null;
}
// Backstop (boot + hourly): re-check every current adult-bracket holder AND every current Adult-Verified
// holder (covers both directions — newly qualifying, or losing an age role but keeping the grant).
async function sweepAdultVerified(guild) {
  if (!config.adultVerifiedRoleId || !config.verifiedRoleId) return;
  await ensureMembers(guild);
  const seen = new Set(); let granted = 0, revoked = 0;
  const roleIds = [...config.adultAgeRoleIds, config.adultVerifiedRoleId];
  for (const id of roleIds) {
    const role = guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null);
    if (!role) continue;
    for (const m of [...role.members.values()]) {
      if (seen.has(m.id)) continue; seen.add(m.id);
      const r = await enforceAdultVerified(m);
      if (r?.granted) granted++; else if (r && !r.granted) revoked++;
    }
  }
  if (granted || revoked) console.log(`[adult-verified] sweep: granted ${granted}, revoked ${revoked}`);
}
// FUBU only (Melanin has no MDNI concept): the second, stricter combined role — MDNI opt-in ON TOP OF
// Adult Verified. Same shape, one level up. Gates general-nsfw/nsfw-vc.
async function enforceMdniVerified2(member) {
  if (!config.mdniEnforce || !config.mdniVerifiedRoleId || !config.adultVerifiedRoleId || !config.mdniRoleId || member.user?.bot) return null;
  const hasMdni = member.roles.cache.has(config.mdniRoleId);
  const hasAdultVerified = member.roles.cache.has(config.adultVerifiedRoleId);
  const qualifies = hasMdni && hasAdultVerified;
  const has = member.roles.cache.has(config.mdniVerifiedRoleId);
  if (qualifies && !has) {
    await member.roles.add(config.mdniVerifiedRoleId, 'MDNI + Adult Verified both confirmed').catch(e => console.error('[mdni-verified2] add:', e.message));
    return { id: member.id, tag: member.user.tag, granted: true };
  }
  if (!qualifies && has) {
    await member.roles.remove(config.mdniVerifiedRoleId, 'no longer holds both MDNI and Adult Verified').catch(e => console.error('[mdni-verified2] remove:', e.message));
    return { id: member.id, tag: member.user.tag, granted: false };
  }
  return null;
}
async function sweepMdniVerified2(guild) {
  if (!config.mdniEnforce || !config.mdniVerifiedRoleId || !config.adultVerifiedRoleId || !config.mdniRoleId) return;
  await ensureMembers(guild);
  const seen = new Set(); let granted = 0, revoked = 0;
  const mdniRole = guild.roles.cache.get(config.mdniRoleId) || await guild.roles.fetch(config.mdniRoleId).catch(() => null);
  const verifiedRole = guild.roles.cache.get(config.mdniVerifiedRoleId) || await guild.roles.fetch(config.mdniVerifiedRoleId).catch(() => null);
  for (const m of [...(mdniRole?.members.values() || []), ...(verifiedRole?.members.values() || [])]) {
    if (seen.has(m.id)) continue; seen.add(m.id);
    const r = await enforceMdniVerified2(m);
    if (r?.granted) granted++; else if (r && !r.granted) revoked++;
  }
  if (granted || revoked) console.log(`[mdni-verified2] sweep: granted ${granted}, revoked ${revoked}`);
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
  // MDNI is now a free-standing preference, not a one-time registration choice, for anyone who's already a
  // confirmed adult (owner, 2026-08-18: "remove the registration lock for mdni for people who hold an 18+
  // role") — they can toggle it anytime with no revert. A non-adult holding it is impossible anyway
  // (enforceMdni strips it), so this only ever relaxes the check for people it was never protecting against.
  const mdniLocked = !config.adultAgeRoleIds.some(id => member.roles.cache.has(id));
  if (curAge === lock.ageRoleId && (curMdni === lock.mdni || !mdniLocked)) return;   // matches the locked baseline — nothing to do

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
    if (curMdni !== lock.mdni && mdniLocked) {
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
  const has = id => id && member.roles.cache.has(id);
  const add = [], remove = [];
  // mark() only fires on the add branch (the moment WE grant it) — never on an already-held role, so a
  // role that was independently held BEFORE nesting ever touched it is simply never marked, permanently.
  if ((tier === 'owner' || tier === 'admin') && NEST_MOD_ROLE && !has(NEST_MOD_ROLE)) { add.push(NEST_MOD_ROLE); nestedRoles.mark(member.id, NEST_MOD_ROLE); }
  if (tier === 'owner' && NEST_ADMIN_ROLE && !has(NEST_ADMIN_ROLE)) { add.push(NEST_ADMIN_ROLE); nestedRoles.mark(member.id, NEST_ADMIN_ROLE); }
  if (opspanel.meets(tier, 'mod')) {
    const trial = modapps.loadConfig().trialModRoleId;   // mod+ never keep Trial Mod ('staff' floor, e.g. a genuine Trial Mod, must NOT hit this — was a bare `if (tier)` that would've stripped Trial Mod's own role the moment 'staff' became a real tierOf() value)
    if (trial && has(trial)) remove.push(trial);
  }
  // Demotion cleanup: a role WE nested-in shouldn't outlive the tier that justified it — real incident:
  // an owner granted then un-granted Admin within 21s; the auto-nested Mod role sat orphaned for ~20h with
  // no cleanup until a human noticed. Only strips roles WE marked nested (never an independently-held or
  // genuinely-promoted one — see nestedRoles.js / promote.js's clear() call).
  if (NEST_ADMIN_ROLE && tier !== 'owner' && has(NEST_ADMIN_ROLE) && nestedRoles.isNested(member.id, NEST_ADMIN_ROLE)) {
    remove.push(NEST_ADMIN_ROLE); nestedRoles.clear(member.id, NEST_ADMIN_ROLE);
  }
  if (NEST_MOD_ROLE && tier !== 'owner' && tier !== 'admin' && has(NEST_MOD_ROLE) && nestedRoles.isNested(member.id, NEST_MOD_ROLE)) {
    remove.push(NEST_MOD_ROLE); nestedRoles.clear(member.id, NEST_MOD_ROLE);
  }
  if (!add.length && !remove.length) return false;
  if (add.length) await member.roles.add(add, 'tier auto-nest (owner⊇admin⊇mod)').catch(() => {});
  if (remove.length) await member.roles.remove(remove, 'tier auto-nest: drop Trial Mod / no-longer-justified nested role(s)').catch(() => {});
  return true;
}

// Catches a slowmode change made ANY way — /hitsquad slowmode, or a squad member using Discord's native
// channel-settings UI directly if they happen to independently hold ManageChannels via another role
// (owner, 2026-08-17: "i was referring to if they change slowmode through the ui"). /hitsquad slowmode
// already records the original via hitsquad.recordOriginal before it changes it — recordOriginal no-ops on
// a second touch of the same channel this window, so this is a harmless no-op for THAT path and the real
// safety net for a native-UI edit the bot command never saw.
client.on('channelUpdate', (oldChannel, newChannel) => {
  try {
    if (!hitsquad.isActive() || newChannel.guild?.id !== config.guildId) return;
    if ((oldChannel.rateLimitPerUser || 0) !== (newChannel.rateLimitPerUser || 0)) {
      hitsquad.recordOriginal('slowmode', newChannel.id, null, oldChannel.rateLimitPerUser || 0);
    }
  } catch (e) { console.error('[hitsquad] channelUpdate capture:', e.message); }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (newMember.guild.id !== config.guildId) return;
    // MDNI minor-staff lock runs REGARDLESS of cornered status — it's a pure channel-permission member
    // overwrite (ViewChannel: false), never touches roles, so it can't fight corner.js for role ownership
    // the way the guard below exists to prevent. BUG FOUND 2026-08-17 (owner: "how was the mod able to see
    // the mdni channels" — a MINOR mod's Mod role was restored by uncorner(), which fires this exact event
    // while state.getCornered() is still true (cleared only AFTER the restore); the blanket skip below used
    // to swallow this call too, so the lock never got reapplied to a minor who'd just regained staff — up to
    // an hour of real exposure until the next sweep, not caught here because it never ran at all).
    await enforceMdniStaffLock(newMember).catch(e => console.error('[mdni-lock]', e.message));
    await enforceMdniStaffLock(newMember, { channelId: config.mdniNsfwChannelId }).catch(e => console.error('[mdni-lock-nsfw]', e.message));
    await enforceMdniStaffLock(newMember, { channelId: config.mdniVerifiedVcId }).catch(e => console.error('[mdni-lock-vc]', e.message));
    if (config.adultCornerChannelId) await enforceMdniStaffLock(newMember, { channelId: config.adultCornerChannelId }).catch(e => console.error('[mdni-lock-adultcorner]', e.message));
    // BUG FOUND 2026-08-17 (owner: "the corner on me doesn't strip my admin or mod and doesn't give me the
    // corner role"): corner()'s single role.set() call fires THIS exact event, and enforceTierNesting reads
    // opspanel.memberTier(newMember) — which is UNCONDITIONALLY 'owner' for the real Discord server owner
    // (member.id === guild.ownerId), regardless of which roles they actually hold. So the instant corner
    // stripped Admin/Mod/Owner down to just the corner role, tier-nesting saw "tier=owner, missing
    // Mod/Admin" and immediately re-granted both back — same event, ~200ms later, confirmed in the audit
    // log. Any of the ROLE-modifying reconciliation below (tribe-membership, MDNI-role, age-exclusivity)
    // could do the same to whoever's stripped-role state it doesn't recognize. corner.js owns a cornered
    // member's ROLES completely for as long as they're in it — channel-overwrite-only checks (above) are
    // exempt since they can't conflict with that; anything that calls .roles.add/.remove stays behind this.
    if (state.getCornered(newMember.id)) return;
    await enforceTierNesting(newMember).catch(e => console.error('[tier-nest]', e.message));
    // Nobody should be able to browse to their own application. A mod+ can see the WHOLE review forum, so
    // removing thread membership isn't enough — archive their own post to the owner-only channel instead
    // (record kept, just moved out of reach). A trial mod can't see the forum at all; sealing their
    // applicant-thread membership is sufficient there. Idempotent either way.
    if (opspanel.meets(opspanel.memberTier(newMember), 'mod')) await modapps.archiveOwnApplication(newMember.guild, newMember.id).catch(e => console.error('[modapps archive]', e.message));
    else if (newMember.roles.cache.has(config.trialModRoleId)) await modapps.sealOwnApplication(newMember.guild, newMember.id).catch(e => console.error('[modapps seal]', e.message));
    // DEMOTION: was mod+, no longer is → Discord keeps their review-thread memberships, so an ex-mod would
    // still see staff deliberations (this is exactly how two demoted mods lingered, 2026-08-01). Sweep them out.
    if (oldMember && !oldMember.partial && opspanel.meets(opspanel.memberTier(oldMember), 'mod') && !opspanel.meets(opspanel.memberTier(newMember), 'mod')) {
      const n = await modapps.removeDemotedFromReviewThreads(newMember.guild, newMember.id).catch(() => 0);
      if (n) console.log(`[modapps] demoted ${newMember.user.tag} removed from ${n} review thread(s)`);
    }
    // PROMOTION: wasn't mod+, now is → member-founded tribes stay member-only (staffBlockedFromMemberTribe
    // blocks staff from JOINING one; this is the mirror for someone already inside who gets promoted).
    if (oldMember && !oldMember.partial && !opspanel.meets(opspanel.memberTier(oldMember), 'mod') && opspanel.meets(opspanel.memberTier(newMember), 'mod')) {
      const tribe = tribes.myTribe(newMember);
      if (tribe) await removePromotedFromMemberTribe(newMember.guild, newMember, tribe).catch(e => console.error('[tribe-staff-promote]', e.message));
    }
    await enforceMdni(newMember).catch(() => {});   // keep MDNI ⟹ adult on every role change
    // (the 3x enforceMdniStaffLock calls now run unconditionally above, before the cornered-member guard)
    await enforceHitSquadRole(newMember).catch(e => console.error('[hitsquad] drift:', e.message));   // strip a manually-assigned (untracked) Hit Squad role
    await enforceAgeExclusivity(newMember, oldMember).catch(e => console.error('[age-exclusivity]', e.message));
    await enforceAdultVerified(newMember).catch(e => console.error('[adult-verified]', e.message));
    await enforceMdniVerified2(newMember).catch(e => console.error('[mdni-verified2]', e.message));
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
    if (thread.name && thread.name.startsWith('⛓️ Jail ·')) {
      const targetName = thread.name.replace('⛓️ Jail · ', '').trim().toLowerCase();
      for (const [id, tm] of addedMembers) {
        if (id === client.user.id || id === thread.guild.ownerId) continue;
        const member = await thread.guild.members.fetch(id).catch(() => null);
        if (!member) continue;
        const isStaffMember = opspanel.memberTier(member)
          || (config.modRoleId && member.roles.cache.has(config.modRoleId))
          || (config.adminRoleId && member.roles.cache.has(config.adminRoleId))
          || (config.trialModRoleId && member.roles.cache.has(config.trialModRoleId));
        if (isStaffMember) continue;
        const username = member.user?.username?.toLowerCase() || member.displayName?.toLowerCase();
        if (username === targetName || id === targetName) continue;

        console.log(`[corner-jail] Auto-ejected non-staff member ${member.user.tag} (${id}) from jail thread "${thread.name}"`);
        await thread.members.remove(id).catch(e => console.error('[corner-jail] eject error:', e.message));
      }
      return;
    }
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
  // Forum/media channels: a "thread" there IS a post — the whole point of the channel type, not someone
  // derailing a chat channel. Exempt them regardless of category (bug found 2026-08-08: the new language
  // forum sits in the same category as general chat channels and got a real member auto-cornered for
  // making a normal forum post).
  if (parent && (parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia)) return false;
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
const canBan = (i) => opspanel.meets(opspanel.tierOf(i), 'mod');                   // any staff (mod+) — NOT the 'staff' floor (trial/mini-mod/event-org)
const canWLAdmin = (i) => ['admin', 'owner', 'botowner'].includes(opspanel.tierOf(i)); // admin+
const isOwner = (i) => ['owner', 'botowner'].includes(opspanel.tierOf(i));         // owner (role or Admin-perm) or bot owner
// Trial Mod — a restricted training tier BELOW mod. Not staff for canBan purposes, but may do a few
// low-risk, bounded things: VERIFY, view the dashboard read-only, and CORNER (rule+reason, ≤1h).
const isTrialMod = (i) => !!(config.trialModRoleId && i.member?.roles?.cache?.has(config.trialModRoleId));
// Any language Mini-Mod role, across every configured language (owner, 2026-08-19: generalized to
// trial-mod-level cornering, same as Trial Mods and Event Organizer — previously mini-mods could only
// use the scoped "Send to corner" context menu on their own language channel, no /corner access at all).
const isAnyMiniMod = (i) => !!i.member && langmods.languages().some(lang => {
  const rid = langmods.roleForLang(lang);
  return rid && i.member.roles.cache.has(rid);
});
// Cornering authority at "trial mod level" (rule/reason required, ≤1h, one target) — Trial Mods, any
// language Mini-Mod, and Event Organizer all share this same restricted tier for /corner + /uncorner.
const hasTrialCornerTier = (i) => isTrialMod(i) || isAnyMiniMod(i) || !!(i.member?.roles?.cache?.has(eventorgapps.ORGANIZER_ROLE_ID));
// Verified-member cornering (FUBU-only, feature 'memberCorner'): a plain VERIFIED member (not staff, not
// trial, not unverified) may corner one non-staff member with tight limits — no rule/reason, ≤5m, capped
// per day. Kept deliberately separate from staff/trial powers.
// Split from the feature-flag check so callers can tell "you're not the right role" apart from "the role
// is right, but the feature is currently off" and say so explicitly (/corner + Send to corner stay visible
// to verified members regardless of the flag — no command-registration restart needed to turn this off).
const isMemberCornerEligibleRole = (i) => !!config.verifiedRoleId
  && !opspanel.tierOf(i) && !isTrialMod(i)
  && !!i.member?.roles?.cache?.has(config.verifiedRoleId);
const isMemberCorner = (i) => features.enabled('memberCorner') && isMemberCornerEligibleRole(i);
// Per-member daily corner counter, keyed by UTC calendar day (resets 00:00 UTC). Stored in verify_state meta.
function memberCornerCountToday(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const rec = (state.getMeta('memberCornerDaily') || {})[userId];
  return rec && rec.date === day ? (rec.count || 0) : 0;
}
function bumpMemberCornerCount(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const m = state.getMeta('memberCornerDaily') || {};
  const rec = m[userId];
  m[userId] = { date: day, count: (rec && rec.date === day ? rec.count : 0) + 1 };
  state.setMeta('memberCornerDaily', m);
}
// Execute a verified-member corner: no rule/reason (ruleN=null → never feeds corner→strike conversion),
// duration clamped to the max, daily-capped, single target. Assumes the actor's access + the target's
// eligibility (non-staff, not owner/self/bot) were already checked by the caller. Replies to `interaction`.
async function doMemberCorner(interaction, targetMember, durationMs) {
  const cap = config.memberCornerDailyCap;
  if (memberCornerCountToday(interaction.user.id) >= cap)
    return (interaction.deferred || interaction.replied)
      ? interaction.editReply(`You’ve used all ${cap} of today’s corners — they reset at midnight UTC.`)
      : interaction.reply({ content: `You’ve used all ${cap} of today’s corners — they reset at midnight UTC.`, flags: MessageFlags.Ephemeral });
  const dur = Math.min(durationMs || config.memberCornerMaxMs, config.memberCornerMaxMs);
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await corner.corner(interaction.guild, targetMember, dur, state, interaction.user.id, null, null, { viaMemberCorner: true });
  if (!r.ok) return interaction.editReply(`Couldn’t corner: ${r.error}`);
  bumpMemberCornerCount(interaction.user.id);
  const relSec = Math.floor((Date.now() + dur) / 1000);
  try {
    const cc = await interaction.guild.channels.fetch(config.cornerChannelId).catch(() => null);
    if (cc) await cc.send(cornerSentMessage(targetMember.id, `until <t:${relSec}:f>`, null, interaction.user.id));
  } catch (e) { console.error('[member-corner] announce:', e.message); }
  await logCorner(interaction.guild, { emoji: '⛓️', title: 'SENT TO THE CORNER', color: CORNER_RED,
    desc: `<@${targetMember.id}> was cornered until <t:${relSec}:f>.\n**By:** <@${interaction.user.id}> _(member corner)_` }).catch(() => {});
  return interaction.editReply(`🚫 Sent <@${targetMember.id}> to the corner for **${Math.round(dur / 60000)} min**. (${memberCornerCountToday(interaction.user.id)}/${cap} today)`);
}
// Who can use a tribe's leader-tools (owner ruling 2026-08-06): the tribe's LEADER, a staff member who is
// actually IN that tribe (holds its base role), or the OWNER (owner tier overrides across ANY tribe). Regular
// staff can no longer manage tribes they aren't in. Replaces the old `isLeader || any-staff` gate everywhere.
function canManageTribe(interaction, tribe) {
  if (!tribe) return false;
  if (tribes.isLeader(interaction.member, tribe)) return true;
  const tier = opspanel.tierOf(interaction);
  if (tier === 'owner' || tier === 'botowner') return true;                 // owner override — any tribe
  return opspanel.meets(tier, 'mod') && !!interaction.member?.roles?.cache?.has(tribe.roleId);    // in-tribe staff (mod+ — trial-tier joined as a REGULAR tribe member, not via the staff auto-rank flow, so shouldn't get leader-tool authority just by being in one)
}
const canVerify = (i) => canBan(i) || isTrialMod(i);
// General member-facing gates ("you must hold Verified to use this") shouldn't block staff who were
// promoted without ever separately holding the Verified role themselves (e.g. an admin-added mod) — their
// tier already vouches for them. Doesn't apply to the couple of gates that are member-only BY DESIGN
// (member-founded-tribe cosign/found), which already exclude staff on the very next check regardless.
const isVerifiedOrStaff = (i) => !config.verifiedRoleId || !!i.member?.roles?.cache?.has(config.verifiedRoleId) || canVerify(i);

// ==== /tribe panel (Phase 8) — one ephemeral, role-aware command replacing what would've been several ======
// narrow staff/leader/member commands (owner: minimize command SPRAWL, not commands as such — one panel
// reachable from wherever you are beats navigating to a separate dashboard mid-event). Sections appear only
// for who should see them: Tribe Games controls for staff, this-tribe controls for its leader-or-staff,
// lore/path controls for any member of a tribe.
function tribeGameEntrantLines() {
  return tribegames.entrantTribeKeys().map(k => tribeName(k)).join(', ') || '_none yet_';
}
async function buildTribePanelView(interaction, forcedTribeKey = null) {
  const member = interaction.member;
  const tier = opspanel.tierOf(interaction);
  const isStaff = opspanel.meets(tier, 'mod');   // Tribe Games is mod+ only (see the canLaunchClassic comment below) — NOT the 'staff' floor
  const isAdminTier = tier === 'owner' || tier === 'botowner';
  const ownTribe = tribes.leaderTribe(member) || tribes.memberTribe(member);
  const myTribe = forcedTribeKey ? tribes.get(forcedTribeKey) : ownTribe;
  const canManage = myTribe && canManageTribe(interaction, myTribe);
  const active = tribegames.isActive() ? tribegames.get() : null;
  const lines = ['## 🏛️ Tribe Panel'];
  const rows = [];

  // Owner/bot-owner aren't necessarily in any tribe themselves — give them a picker so they can reach
  // any tribe's leader tools (canManageTribe already grants them the override; this is what actually
  // surfaces it in the panel instead of silently doing nothing when ownTribe is null).
  if (isAdminTier) {
    const opts = tribes.all().map(t => ({ label: t.shortName || t.name, value: t.key, default: myTribe && t.key === myTribe.key }));
    if (opts.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('tp_admin_pick').setPlaceholder(myTribe ? `Managing: ${myTribe.shortName || myTribe.name}` : 'Manage a tribe…').addOptions(opts.slice(0, 25))));
    }
  }

  // Arena/Sealed Arena/Trial ("classic" events, pre-dating Tribe Games) get folded into the SAME select as
  // the Tribe Games catalog rather than their own row — Discord caps a message at 5 rows, and their access
  // rule is wider (any tribe leader, not just staff) than Tribe Games' own (mod+ only), so the select's
  // option list is built per-viewer.
  const canLaunchClassic = canWLAdmin(interaction) || !!tribes.leaderTribe(member);
  if (isStaff || canLaunchClassic) {
    if (!active) {
      const opts = isStaff ? Object.entries(tribegames.GAME_CATALOG).map(([id, g]) => ({ label: g.label, value: id })) : [];
      if (canLaunchClassic) opts.push({ label: '🎪 Classic: Arena (random type)', value: 'classic_arena' }, { label: '🚪 Classic: Sealed Arena (random type)', value: 'classic_sealed' }, { label: '⚔️ Classic: Trial (today\'s rotation)', value: 'classic_trial' });
      lines.push(isStaff ? '**🎮 Tribe Games** — nothing running.' : '**🎪 Launch an event**');
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('tp_start_game').setPlaceholder('Start an event…').addOptions(opts.slice(0, 25))));
    } else if (isStaff && active.phase === 'lobby') {
      lines.push(`**🎮 Tribe Games** — ${tribegames.GAME_CATALOG[active.gameId]?.label} lobby open, locks in <t:${Math.floor(active.startsAt / 1000)}:R>. Entrants: ${tribeGameEntrantLines()}.`);
    } else if (isStaff && active.phase === 'live') {
      const catalog = tribegames.GAME_CATALOG[active.gameId];
      lines.push(`**🎮 Tribe Games** — ${catalog?.label} is LIVE (${tribeGameEntrantLines()}). Report the result when it's done.`);
      if (catalog.format === 'versus') {
        const opts = tribegames.entrantTribeKeys().map(k => ({ label: tribeName(k), value: k }));
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('tp_result_versus').setPlaceholder('Who won?').addOptions(opts)));
      } else {
        rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tp_result_open').setLabel('Report Result').setEmoji('📝').setStyle(ButtonStyle.Primary)));
      }
    }
  }

  // Live Tally: for a manually-refereed event where a lot of small point-scoring moments happen over
  // time (owner: spent an hour hand-counting reactions after one) — react-to-score, live, instead.
  if (isStaff || contest.isEventOrganizer(member)) {
    const tl = tally.get();
    if (tl) {
      const topM = tally.topMembers(tl, 3);
      const topLine = topM.length ? topM.map(([uid, n]) => `<@${uid}> (${n})`).join(', ') : 'no scores yet';
      lines.push(`**📊 Live Tally** (react ${tally.POINT_EMOJI} on a participant's message in <#${tl.scoreChannelId}>) — top: ${topLine}`);
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tp_tally_end').setLabel('End Tally').setEmoji('🛑').setStyle(ButtonStyle.Danger)));
    } else {
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tp_tally_start').setLabel('Start Live Tally').setEmoji('📊').setStyle(ButtonStyle.Secondary)));
    }
  }

  if (canManage && myTribe) {
    const k = myTribe.key;
    if (active && active.phase === 'lobby') {
      rows.push(new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`tp_setrep:${k}`).setPlaceholder(`Set ${myTribe.shortName || myTribe.name}'s rep(s)`).setMinValues(1).setMaxValues(2)));
    }
    // Rows A/B reuse the EXACT customIds the Throne panel's own buttons already use (tribethrone_*) — that
    // router only looks at tribeKey + canManageTribe, not which message the click came from, so these work
    // identically here with zero new handler code.
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tribethrone_invite:${k}`).setEmoji('👥').setLabel('Invite').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`tribethrone_banish:${k}`).setEmoji('⛔').setLabel('Banish').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`tribethrone_note:${k}`).setEmoji('📝').setLabel('Note').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tribethrone_rank:${k}`).setEmoji('🎖️').setLabel('Set Rank').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tribethrone_muster:${k}`).setEmoji('🪖').setLabel('Muster').setStyle(ButtonStyle.Primary)));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tribethrone_announce:${k}`).setEmoji('📣').setLabel('Announce').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`tribethrone_motto:${k}`).setEmoji('✍️').setLabel('Motto').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`tp_settings:${k}`).setEmoji('⚙️').setLabel('Settings').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tp_editlore:${k}`).setEmoji('📖').setLabel('Edit Lore').setStyle(ButtonStyle.Secondary)));
  }

  if (myTribe && !canManage) {
    // Any member of the tribe (not already covered by the leader-tool rows above): Tithe (existing
    // tribethrone_tithe flow) + Nominate (new — the one member-facing action with no Throne-panel button yet).
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tribethrone_tithe:${myTribe.key}`).setEmoji('🪙').setLabel('Tithe').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`tp_nominate:${myTribe.key}`).setEmoji('🪶').setLabel('Nominate').setStyle(ButtonStyle.Secondary)));
  }

  if (myTribe) {
    const loreData = tribes.getLore(myTribe.key);
    lines.push(`\n**${myTribe.emoji || '🏴'} ${myTribe.shortName || myTribe.name}**`);
    if (!loreData) {
      lines.push('_No lore set yet for this tribe._' + (canManage ? ' Use **Edit Lore** below to start one.' : ''));
    } else {
      lines.push(`*${loreData.title}*`);
      const path = tribes.memberPath(myTribe.key, member.id);
      if (!path) {
        lines.push("You haven't chosen a path yet.");
      } else {
        const pi = tribes.PATH_SLOTS.indexOf(path);
        const attr = tribes.pathAttribute(myTribe.key, member.id);
        const bonusPct = Math.round(attr * tribes.BONUS_PER_ATTR_POINT * 100);
        const rankIdx = tribes.earnedRankIndex(myTribe, member.id);
        const rank = rankIdx >= 0 ? myTribe.ranks[rankIdx] : null;
        const stats = tribes.pathStats(myTribe.key, member.id);
        lines.push(`**Path:** ${loreData.pathNames[pi]} · **${loreData.attributeNames[pi]}:** ${attr} (+${bonusPct}% on matching activity)`);
        lines.push(`**Rank:** ${rank ? rank.name : 'Unranked'}`);
        lines.push(`-# Lifetime on this path: **${stats.tidesOnPath}** Tides earned, bonus applied **${stats.bonusHits}** time${stats.bonusHits === 1 ? '' : 's'}.`);
      }
      const opts = tribes.PATH_SLOTS.map((slot, i) => ({ label: loreData.pathNames[i] || `Path ${i + 1}`, value: slot, default: slot === path }));
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tp_choosepath:${myTribe.key}`).setPlaceholder(path ? 'Switch path…' : 'Choose your path…').addOptions(opts)));
    }
  } else if (!isStaff) {
    lines.push("\nYou're not in a tribe yet.");
  }

  return { content: lines.join('\n').slice(0, 3900), components: rows.slice(0, 5), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

// ---- Edit Lore: a 2-modal chain (title/paths/attrs, then rank-titles/myth) reached via a panel button ----
function loreModal1(tribeKey) {
  const rows = [
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Lore title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('path0').setLabel('Path 1 name (e.g. Warrior)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('path1').setLabel('Path 2 name (e.g. Dancer)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('path2').setLabel('Path 3 name (e.g. Craftsman)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('attrs').setLabel('Attribute names, comma-separated (3)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(150).setPlaceholder('Might, Guile, Wisdom')),
  ];
  return new ModalBuilder().setCustomId(`tp_lore1:${tribeKey}`).setTitle('Tribe Lore — 1/2').addComponents(...rows);
}
function loreModal2(tribeKey, pathNames) {
  const rows = [
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ranks0').setLabel(`${pathNames[0]} ranks, low→high (4, comma-sep)`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ranks1').setLabel(`${pathNames[1]} ranks, low→high (4, comma-sep)`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ranks2').setLabel(`${pathNames[2]} ranks, low→high (4, comma-sep)`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('myth').setLabel('Founding myth / lore text').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
  ];
  return new ModalBuilder().setCustomId(`tp_lore2:${tribeKey}`).setTitle('Tribe Lore — 2/2').addComponents(...rows);
}
// After setLore() rebuilds tribe.ranks with pathKey tags, any rank missing a Discord role gets one created,
// and every rank role gets (re)named to match — same rename step /tribe ranks already does (index.js ~7958).
async function syncTribeRankRoles(guild, tribeKey) {
  const t = tribes.get(tribeKey); if (!t) return;
  const fresh = tribes.get(tribeKey);
  for (const r of fresh.ranks) {
    if (!r.roleId) {
      const role = await guild.roles.create({ name: `${fresh.emoji || '🏴'} ${toSmallCaps(r.name)}`, hoist: false, mentionable: false, reason: `Tribe Lore path rank: ${tribeKey}/${r.key}` }).catch(() => null);
      if (role) r.roleId = role.id;
      continue;
    }
    const role = guild.roles.cache.get(r.roleId);
    const want = `${fresh.emoji || '🏴'} ${toSmallCaps(r.name)}`;
    if (role && role.name !== want) await role.setName(want, 'tribe lore rank rename').catch(() => {});
  }
  tribes.update(tribeKey, { ranks: fresh.ranks });
}
// A language mini-mod may use Send-to-corner + Report-to-watchlist, but ONLY on messages in THEIR OWN
// language's channels (per-language roles now — French Mini-Mod acts only in French chat/VC, etc.), and
// only when the 'langMiniMod' feature is on. Dormant if no languages are configured.
function miniModCanActOn(interaction, channelId) {
  // Same class of bug as opspanel.tierOf() (fixed 2026-08-19): this predates that fix and is a separate
  // mechanism (channel-scoped, not tier-based), so it needs its own "not currently cornered" check rather
  // than inheriting the fix — a cornered Mini-Mod's role membership doesn't get a snapshot fallback the way
  // memberTier() does, but langmods.canActOn() also doesn't check corner status, so add it here directly.
  return !state.getCornered(interaction.user.id) && features.enabled('langMiniMod') && langmods.canActOn(interaction.member, channelId, interaction.guild);
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
  if (opts.aiVerdict) {
    // Caller already ran the judge (the no-keyword behavioral read) — reuse its verdict instead of paying
    // for a second API call.
    const v = opts.aiVerdict;
    smartNote = `🤖 behavioral read (no keyword): ${v.reason} _(conf ${v.confidence.toFixed(2)}${v.likelyRule ? `, Rule ${v.likelyRule}` : ''})_`;
  } else if (features.enabled('smartWatch') && !features.enabled('smartWatchLab')) {
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
      { name: 'Matched', value: (hits.map(h => `\`${h}\``).join(', ') || (opts.aiOnly ? '_(AI behavioral read, no keyword)_' : '-')).slice(0, 1024) },
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
  // A no-keyword AI catch has nothing on the term list to point at by default — offer a one-click way to
  // recommend the word/phrase that should have matched, straight from the real incident (owner, 2026-08-18:
  // "that way it can recommend words to add").
  if (opts.offerAddTerm) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wl_addterm:${msg.author.id}`).setEmoji('➕').setLabel('Add term').setStyle(ButtonStyle.Secondary)));
  const pingRoleId = opts.pingRoleId || config.modRoleId;
  const ping = (opts.ping !== false && pingRoleId) ? `<@&${pingRoleId}>` : undefined;
  const mentions = { roles: (opts.ping !== false && pingRoleId) ? [pingRoleId] : [] };
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
function cornerReasonModal(memberId, channelId, messageId, ruleN, isTrial = false) {
  const rows = [
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (blank = indefinite; 30s/10m/2h/1d)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('options').setLabel('Options: type "thread", "adult", or "both"').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20).setPlaceholder('blank = standard corner')),
  ];
  if (!isTrial) rows.push(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('also').setLabel('Also corner (paste @IDs, space-separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300).setPlaceholder('blank = no · same duration/reason')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sweep').setLabel('Sweep others active here? (minutes)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder('blank = no · e.g. 5 = last 5 min')));
  return new ModalBuilder().setCustomId(`corner_reason:${memberId}:${channelId}:${messageId}:${ruleN || 'x'}`).setTitle('Send to corner').addComponents(...rows);
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
  if (action === 'wl_corner') {   // routes through the SAME duration-prompt modal as right-click "Send to corner"
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) return interaction.update({ content: `⛓️ <@${userId}> already left. Can’t corner.`, embeds: keep, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    // Same tier hierarchy as /corner and Send-to-corner (own tier or lower, never higher) — this used to be
    // a blanket "no admins/owner ever" block that didn't check the ACTOR's tier, so even the owner couldn't
    // corner an admin from here even though the slash command correctly allows it.
    const actorTier = effectiveTierOf(interaction, member);
    if (member.id === interaction.guild.ownerId && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, actorTier))
      return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
    const wlActorRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[actorTier] || 0;
    const wlTargetRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[opspanel.memberTier(member)] || 0;
    if (wlTargetRank > wlActorRank && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, actorTier))
      return interaction.reply({ content: `You can’t corner someone of a higher staff tier than you (they’re **${opspanel.memberTier(member)}**).`, flags: MessageFlags.Ephemeral });
    // Every corner path goes through one form now (owner ruling): open the same duration/reason/sweep modal the
    // right-click uses, keyed to the flagged message from the alert's jump link (blank duration = indefinite).
    const ref = originalRefFromAlert(keep[0]);
    if (!ref) return interaction.reply({ content: 'Couldn’t locate the flagged message to corner from. Use `/corner @them` or right-click the message.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(cornerReasonModal(userId, ref.channelId, ref.messageId, null, isTrialMod(interaction)));
  }
  if (action === 'wl_addterm') {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can add watchlist terms.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`wl_addterm_modal:${userId}`).setTitle('Recommend a term to add');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('term').setLabel('Word/phrase to add').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('scope').setLabel('strict or loose (default strict)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(6)));
    return interaction.showModal(modal);
  }
  if (action === 'wl_ban') { // legacy direct-ban buttons on older reports
    return interaction.update({ components: [banConfirmRow(userId, 'Confirm ban')] }).catch(() => {});
  }
  if (action === 'wl_banok') {
    try {
      await interaction.guild.members.ban(userId, { reason: `Watchlist ban by ${interaction.user.tag}` });
      await ownerlog.log(interaction.guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `<@${userId}> — by <@${interaction.user.id}>.` });
      await logPunishment(interaction.guild, { emoji: '🔨', title: 'Banned', desc: `<@${userId}> was banned by <@${interaction.user.id}>.` });
      await logBanned(interaction.guild, { userId, byId: interaction.user.id });
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
  // Cornered: corner.js deliberately strips the tribe role (it grants real access, same reasoning as
  // MDNI) and owns their roles until release. Without this check, this guard would see hasRole=false but
  // authorized=true (a corner strip isn't a /tribe banish) and immediately re-add it, undoing the strip on
  // every subsequent guildMemberUpdate — which is exactly what was happening.
  if (corner.memberIsCornered(member)) return;
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
  if (earned > current) await applyTribeRank(guild, tribe, member, earned, 'auto — tenure + points', earned >= 1);
}
// Backfill for existing members of a tribe that's already in path-mode when it converts (or was converted
// before this default-path fix existed) — every rank-and-file member without a chosen path defaults to
// Collective, same as joinTribeSelfServe now does for new joins, then gets whatever rank they've already
// earned applied immediately. Safe to run repeatedly (no-ops once everyone has a path); boot + on-demand
// after Edit Lore converts a tribe to path-mode.
async function backfillDefaultPaths(guild) {
  await ensureMembers(guild);
  let assigned = 0;
  for (const tribe of tribes.all()) {
    if (!tribe.roleId || !tribes.isPathMode(tribe)) continue;
    const role = guild.roles.cache.get(tribe.roleId);
    if (!role) continue;
    for (const member of role.members.values()) {
      if (tribes.isLeader(member, tribe) || ['admin', 'mod'].includes(opspanel.memberTier(member))) continue;
      if (tribes.memberPath(tribe.key, member.id)) continue;
      tribes.setMemberPath(tribe.key, member.id, 'path2');
      await maybePromoteTribeRank(guild, tribe.key, member).catch(() => {});
      assigned++;
    }
  }
  if (assigned) console.log(`[tribe-paths] backfilled ${assigned} existing member(s) onto the default Collective path`);
  return assigned;
}

client.on('messageCreate', async (msg) => {
  try {
    // Raid prevention (owner, 2026-08-12, following the Melanin incident): EVERY webhook message is
    // blocked by default, server-wide, unless that exact webhook id has been explicitly authorized via the
    // ✅ button on raidguard's watchdog alert (raidguard.js). Started as a Melanin-only emergency block
    // during the live incident; generalized here now that authorization is per-webhook-id instead of an
    // all-or-nothing guild toggle, so FUBU's legitimate "History Migration" webhook just needs (and has)
    // its own explicit authorization rather than a guild-wide carve-out.
    // Checked BEFORE the bot-author early-return below — a webhook post has msg.author.bot === true, so it
    // would otherwise be silently skipped by that return.
    // BUG FIX (owner-reported, 2026-08-12): Discord delivers slash-command interaction replies through a
    // webhook whose id is the bot's OWN application id (msg.webhookId === client.user.id), NOT null — so
    // every public (non-ephemeral) command reply was getting caught by this block and deleted on sight.
    // Excluding the bot's own id fixes that without weakening the check against real external webhooks.
    if (msg.guild && msg.webhookId && msg.webhookId !== client.user.id && !raidguard.isAuthorized(msg.guild.id, msg.webhookId)) {
      await msg.delete().catch(() => {});
      // Alert directly from here (owner-reported, 2026-08-13) — a webhook created, used once, and deleted
      // right after (common for "fire and forget" integrations) never shows up in onWebhooksUpdate's diff
      // by the time it re-checks, so that path alone can silently block a message with no alert ever firing.
      raidguard.alertBlockedWebhookMessage(msg.guild, msg).catch(() => {});
      return;
    }
    // raidguard: message-flood auto-quarantine (owner, 2026-08-12 — "hearty raid prevention" after the
    // Melanin incident). Applies server-wide, both bots, real members AND webhooks alike — the same author
    // posting faster than a human can type gets shut down on sight instead of waiting for a mod to notice.
    // Checked before the bot early-return so a webhook flood is covered too; excludes THIS bot's own id so
    // its own rapid-fire posts (Arena rounds, etc.) never self-trigger.
    if (msg.guild && msg.author.id !== client.user.id && raidguard.checkFlood(msg.author.id)) {
      botdeletes.mark(msg.id);   // auto-moderation, not a human deletion — keep it out of #deletion-log
      await msg.delete().catch(() => {});
      await raidguard.quarantine(msg.guild, msg);
    }
    // Auto-delete the "X pinned a message" system notification so pins don't clutter channels (owner 2026-08-05).
    // Checked BEFORE the bot-author early-return below, since a bot-pinned notice is authored by the bot.
    if (msg.guild && msg.type === MessageType.ChannelPinnedMessage) { botdeletes.mark(msg.id); await msg.delete().catch(() => {}); return; }
    // Blanket 24h self-expiry for EVERYTHING posted in a tribe throne (owner: "add the timer to all messages
    // in the throne") — not just the bot's transient throneSend() posts, but human leader announcements and any
    // other post too, to keep the throne clear. Excludes the persistent pinned control panel (its own marker).
    // Runs BEFORE the bot early-return so bot posts are covered; throneExpire.add is an upsert and armThroneExpire
    // is idempotent, so this never double-schedules a message throneSend() already armed.
    if (msg.guild && (msg.type === MessageType.Default || msg.type === MessageType.Reply)) {
      const throneTribe = tribes.all().find(t => t.throneId && t.throneId === msg.channelId);
      if (throneTribe && !msg.pinned) {
        // Skip the persistent control panel. Prefer its stored message ID (robust); fall back to the content
        // marker only when the ID isn't recorded yet — legacy tribes (backfilled on next refresh) and the brief
        // race where this handler fires before postThroneGuide has persisted the freshly-sent panel's ID.
        const isPanel = throneTribe.panelMessageId
          ? msg.id === throneTribe.panelMessageId
          : !!(msg.content && msg.content.includes(': what you can do'));
        if (!isPanel) {
          throneExpire.add(msg.channelId, msg.id, Date.now() + throneExpire.TTL_MS);
          armThroneExpire(msg.channelId, msg.id, throneExpire.TTL_MS);
        }
      }
    }
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
          await msg.react('✅').catch(() => {});
          // Round cap for the finite LOCAL banks (riddle/emoji) so a fast game can't run them dry and wrap
          // (owner). The others are effectively infinite: words = large remote bank; math/typing/pattern generated.
          if (['riddle', 'emoji'].includes(ax.type) && (ax.round || 1) >= 18) {
            await endArena(msg.guild).catch(() => {});
          } else {
            const nx = arena.nextTyped(ax.type, ax.used || []);   // fresh prompt; no in-game repeats (owner)
            arena.update({ answer: nx.answer, display: nx.display, round: (ax.round || 1) + 1, used: [...(ax.used || []), nx.key] });
            const ch = await msg.guild.channels.fetch(ax.channelId).catch(() => null);
            if (ch) await ch.send({ content: typedContent(ax.type, arena.get()), allowedMentions: { parse: [] } }).catch(() => {});
          }
        }
      }
    } catch (e) { console.error('[arena] messageCreate:', e.message); }
    // Sealed Arena TYPED answers: route by throne channel; the first correct answer per throne per round scores
    // (lockstep, so the throne then waits for the shared round timer to advance everyone).
    try {
      const sa = sealed.get();
      if (sa && sa.mode === 'sealed' && sa.kind === 'typed') {
        const th = sealed.throneByChannel(msg.channelId);
        if (th && !th.answered) {
          const item = sa.items[th.qNum];
          const mine = tribes.memberTribe(msg.member);
          if (item && mine && mine.key === th.tribeKey && msg.content.trim().toLowerCase() === String(item.answer).trim().toLowerCase()) {
            if (sealedTryScore(th.tribeKey, msg.author.id, msg.createdTimestamp, true)) await msg.react('✅').catch(() => {});
          }
        }
      }
    } catch (e) { console.error('[sealed] messageCreate:', e.message); }
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
    // Media filter (specific GIF links / specific attachments, by content hash) runs BEFORE the content
    // guard below — most attachment-only or GIF-only messages have no text content at all, so waiting for
    // that guard would let every one of them slip straight past a filter meant to catch exactly that.
    // checkSpecific's GIF-link check is cheap (string match); its attachment-hash check downloads + hashes
    // each attachment, so it only does that work when the hash blocklist actually has entries.
    const earlyMember = msg.member || await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (earlyMember && features.enabled('wordFilter') && !opspanel.memberTier(earlyMember)) {
      const specificHit = await mediafilter.checkSpecific(state, msg).catch(e => { console.error('[mediafilter] checkSpecific:', e.message); return null; });
      if (specificHit) { botdeletes.mark(msg.id); await msg.delete().catch(e => console.error('[mediafilter] delete:', e.message)); return; }
    }
    if (!msg.content) return;
    const member = earlyMember;
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
          tribes.addTides(homeTribe.key, member.id, 1, 'social');
          await maybePromoteTribeRank(msg.guild, homeTribe.key, member);
        }
      }
    } catch (e) { console.error('[tribe-tides]', e.message); }
    // Temporary word filter: staff arm a word/phrase to be auto-deleted for a period. Applies to
    // everyone EXCEPT staff (so mods can still discuss the term). Deleting ends the scan for this message.
    if (features.enabled('wordFilter') && !opspanel.memberTier(member)) {
      const hit = wordfilter.check(state, msg.content);
      if (hit) { botdeletes.mark(msg.id); await msg.delete().catch(e => console.error('[wordfilter] delete:', e.message)); return; }
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
      // A watched member who's ALSO staff must never see their own hit — route to the admin-only
      // channel (MODS excluded) with an admin ping instead of the normal mod-visible one (owner,
      // 2026-08-08: "I don't want them to know when they're caught").
      const staffTarget = !!opspanel.memberTier(member);
      // A watched MOD gets a narrower strict watch than a regular member (owner, 2026-08-19: "Strict for
      // mods on the watchlist should only be the keywords and only outside of the mod category") — staff
      // need to be able to talk freely in mod-only channels, and don't get the fuller AI behavioral read
      // regular watched members do. Skip entirely for a mod's message inside the mod category.
      const skipMod = staffTarget && config.modCategoryId && msg.channel.parentId === config.modCategoryId;
      if (!skipMod) {
        const strict = [...new Set([...watchlist.loadTerms(), ...watchlist.loadLoose()])];
        const hits = strict.length ? watchlist.matchTerms(msg.content, strict) : [];
        const routeOpts = staffTarget
          ? { scope: 'strict', channelId: config.adminAnnounceChannelId, pingRoleId: config.adminRoleId }
          : { scope: 'strict' };
        if (hits.length) {
          await watchlistAlert(msg, hits, routeOpts);
          return;   // strict wins - one report per message
        }
        // FULL BEHAVIORAL COVERAGE, live (was lab-only sandbox — owner, 2026-08-18: "that wasn't supposed
        // to be a lab only feature, it was supposed to go live as well ... it can recommend words to add"):
        // even with no keyword hit, the judge reads EVERY message from a watchlisted REGULAR member — small,
        // deliberately-watched population. A watched MOD is keyword-only (see skipMod comment above), never
        // gets this AI behavioral read.
        if (!staffTarget && features.enabled('smartWatch')) {
          const d = await smartwatch.evaluate('strict', msg, []).catch(e => { console.error('[smartwatch] behavioral:', e.message); return { ran: false }; });
          if (d.ran && d.verdict && d.verdict.surface) {
            await watchlistAlert(msg, [], { ...routeOpts, aiOnly: true, aiVerdict: d.verdict, offerAddTerm: true });
            return;
          }
        }
      }
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
  // Deleted-message log → its own #deletion-log (owner, 2026-08-07: "start recording deleted messages";
  // split out of #watch-log into its own channel 2026-08-16 so watchlist flags and plain deletions don't
  // mix in the same feed). Only for messages the bot actually had cached (msg.partial → we never saw the
  // content, nothing useful to log), real non-bot authors, and not the log channel itself (avoid the log
  // logging itself).
  try {
    if (msg.partial || !msg.guild || !config.deletionLogChannelId || msg.channelId === config.deletionLogChannelId) return;
    if (!msg.author || msg.author.bot) return;
    // The bot deleted this itself (word/media filter, raid flood, throne expiry, contest/dashboard
    // cleanup) — not a human moderation event, so it doesn't belong here. This is an EXPLICIT mark set
    // right before each of those deletes; the audit-log check further down can't be trusted for this
    // because the gateway event usually beats the audit entry being written, and Discord coalesces
    // repeated MESSAGE_DELETE entries for the same member+channel instead of writing a fresh one — both
    // of which read as "no entry found", i.e. a self-delete, which is exactly why filter-deleted
    // messages were showing up here as "deleted by <them> (themselves)" (owner, 2026-08-20).
    if (botdeletes.was(msg.id)) return;
    // Skip THRONE channels — throneExpire.js routinely auto-deletes every throne message after 24h by
    // design (not a moderation event), so logging those was just clutter (owner, 2026-08-08: "skip
    // messages deleted by the bot in the deletion log" re: throne 24h expiry).
    if (tribes.all().some(t => t.throneId === msg.channelId)) return;
    const ch = await client.channels.fetch(config.deletionLogChannelId).catch(() => null);
    if (!ch) return;
    // messageDelete carries no executor — MESSAGE_DELETE audit entries don't carry the message id either,
    // so correlate on author + channel + recency (same best-effort pattern threadDelete's appeal-log uses
    // above). No matching entry within the last few seconds → Discord never logged one, which only happens
    // when the author deleted their own message (self-deletes aren't audited).
    let deleterId = null;
    try {
      const logs = await msg.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 }).catch(() => null);
      const entry = logs && [...logs.entries.values()].find(e =>
        e.targetId === msg.author.id && e.extra?.channel?.id === msg.channelId && (Date.now() - e.createdTimestamp) < 10000);
      if (entry?.executor && entry.executor.id !== msg.author.id) deleterId = entry.executor.id;
    } catch { /* best-effort — falls back to "themselves" below */ }
    // Skip the bot's OWN deletions (owner, 2026-08-17: "don't have messages deleted by the bot because of
    // media filter and such show in the deletion log") — word filter, media filter, and any other
    // auto-moderation delete are already visible via their own /list commands; this log is for deletions a
    // HUMAN did (self-delete, or a mod manually removing something), not the bot enforcing a live filter.
    if (deleterId === client.user.id) return;
    const content = (msg.content || '').trim();
    const embed = new EmbedBuilder().setColor(0x99AAB5)
      .setDescription(`🗑️ **Message deleted** — by <@${msg.author.id}>, in <#${msg.channelId}>, deleted by ${deleterId ? `<@${deleterId}>` : `<@${msg.author.id}> _(themselves)_`}`
        + (content ? `\n\n${content.slice(0, 1500)}` : '\n\n_(no text — attachment/embed only)_'))
      .setFooter({ text: `${msg.author.tag} · ${msg.author.id}` }).setTimestamp(msg.createdAt || new Date());
    // Re-upload attachments into the log message itself rather than just linking the CDN URL — a deleted
    // message's attachment links tend to go dead within minutes, which made the link-only version useless
    // for anything a mod didn't check immediately. Fetch now (right as the delete event fires, the CDN URL
    // is still freshest) and attach the bytes directly; a per-file size cap + fallback link covers anything
    // too big to re-upload or that already 404'd by the time we got to it.
    const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
    const original = [...(msg.attachments?.values() || [])].slice(0, 5);
    const files = [];
    const failedLinks = [];
    for (const a of original) {
      try {
        if (a.size && a.size > ATTACH_MAX_BYTES) { failedLinks.push(`${a.name || 'file'} (too large to re-upload) — ${a.url}`); continue; }
        const res = await fetch(a.url);
        if (!res.ok) { failedLinks.push(`${a.name || 'file'} (couldn't re-fetch, ${res.status}) — ${a.url}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > ATTACH_MAX_BYTES) { failedLinks.push(`${a.name || 'file'} (too large to re-upload) — ${a.url}`); continue; }
        files.push(new AttachmentBuilder(buf, { name: a.name || `attachment-${a.id}` }));
      } catch (e) { failedLinks.push(`${a.name || 'file'} (fetch failed: ${e.message}) — ${a.url}`); }
    }
    if (failedLinks.length) embed.addFields({ name: `📎 Couldn't re-upload (${failedLinks.length})`, value: failedLinks.join('\n').slice(0, 1000) });
    // Reuse the SAME wl_strike/wl_corner/wl_dismiss buttons + handler the watchlist alerts use, so this
    // needs no new handler. Both flows locate the source message via a jump link scraped out of the embed
    // (originalRefFromAlert) — the original message is gone, so point that link at THIS log entry instead
    // (added below, after sending, once we know its own id). cornerFromMessage already treats a bot-authored
    // source message as "not the real author" and falls back to the cornered member's own identity/content.
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wl_strike:${msg.author.id}`).setEmoji('⚠️').setLabel('Strike').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`wl_corner:${msg.author.id}`).setEmoji('⛓️').setLabel('Corner').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`wl_dismiss:${msg.author.id}`).setEmoji('🗑️').setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
    const sent = await ch.send({ embeds: [embed], components: [row], files, allowedMentions: { parse: [] } }).catch(() => null);
    if (sent) {
      embed.addFields({ name: 'Original', value: `[this entry](${sent.url}) — the source message is gone, this log is the record now`, inline: true });
      await sent.edit({ embeds: [embed] }).catch(() => {});
    }
  } catch (e) { console.error('[watchlist] delete-log:', e.message); }
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
  // Among Us VC mode (feature-gated): the /amongus start + the control-panel buttons/select. Routed early
  // so they never fall through to the generic command/button handlers below.
  if (features.enabled('amongUs')) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'amongus') return amongus.handleCommand(interaction).catch(e => console.error('[amongus cmd]', e.message));
    if (amongus.isInteraction(interaction)) return amongus.handleInteraction(interaction).catch(e => console.error('[amongus int]', e.message));
  }
  // Mafia VC mode (feature-gated): same early-routing rationale as Among Us above.
  if (features.enabled('mafia')) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'mafia') return mafia.handleCommand(interaction).catch(e => console.error('[mafia cmd]', e.message));
    if (mafia.isInteraction(interaction)) return mafia.handleInteraction(interaction).catch(e => console.error('[mafia int]', e.message));
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
    if (interaction.commandName === 'awards') {
      try {
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const choices = Object.entries(awards.categories())
          .filter(([key, c]) => !focused || key.includes(focused) || c.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map(([key, c]) => ({ name: c.name.slice(0, 100), value: key }));
        return interaction.respond(choices);
      } catch (e) { console.error('[awards] autocomplete:', e.message); return interaction.respond([]).catch(() => {}); }
    }
    // Role-filtered member pickers: only list members who actually hold the applicable role, so the
    // list in the command matches the dropdowns (class fix). promote-trial/demote-trial → trial mods;
    // promote-mod/demote-mod → mods (excluding admins/owners who hold the mod role via nesting);
    // demote-admin → admins (excluding owners who hold it via nesting).
    if (['promote-trial', 'demote-trial', 'promote-mod', 'demote-mod', 'demote-admin'].includes(interaction.commandName)) {
      try {
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const roleId = interaction.commandName === 'demote-admin' ? config.adminRoleId
          : (interaction.commandName === 'promote-mod' || interaction.commandName === 'demote-mod') ? config.modRoleId : config.trialModRoleId;
        const role = roleId && await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) return interaction.respond([]);
        let members = [...role.members.values()];
        if (interaction.commandName === 'promote-mod' || interaction.commandName === 'demote-mod') members = members.filter(m => opspanel.memberTier(m) === 'mod');   // real mods only, not admins/owners
        if (interaction.commandName === 'demote-admin') members = members.filter(m => opspanel.memberTier(m) === 'admin');   // real admins only, not owners
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
    return interaction.showModal(cornerReasonModal(memberId, channelId, messageId, ruleN, isTrialMod(interaction)));
  }
  // Ban rule picker (right-click Ban) → reason modal. customId: ban_rule_pick:<targetId>
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('ban_rule_pick:')) {
    const [, targetId] = interaction.customId.split(':');
    const ruleN = interaction.values[0] === 'none' ? null : interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`ban_reason_modal:${targetId}:${ruleN || 'x'}`).setTitle('Ban: reason').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Extra reason (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)));
    return interaction.showModal(modal);
  }
  // Weekly Superlatives vote panel — category pick → ephemeral member picker → cast. Replaces typing
  // /awards vote (owner, 2026-08-20). Any member, no staff gate — same as the slash command.
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'awards_pick_category') {
    const key = interaction.values[0];
    const cat = awards.getCategory(key);
    if (!cat) return interaction.reply({ content: 'That award category doesn’t exist anymore.', flags: MessageFlags.Ephemeral });
    const picker = new UserSelectMenuBuilder().setCustomId(`awards_vote_target:${key}`).setPlaceholder(`Who’s ${cat.name}?`).setMaxValues(1);
    return interaction.reply({ content: `🗳️ Voting for **${cat.name}** — pick who:`, components: [new ActionRowBuilder().addComponents(picker)], flags: MessageFlags.Ephemeral });
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('awards_vote_target:')) {
    const key = interaction.customId.split(':')[1];
    const cat = awards.getCategory(key);
    if (!cat) return interaction.update({ content: 'That award category doesn’t exist anymore.', components: [] });
    const target = interaction.values[0];
    if (target === interaction.user.id) return interaction.update({ content: 'You can’t vote for yourself.', components: [] });
    const targetMember = await interaction.guild.members.fetch(target).catch(() => null);
    if (targetMember?.user?.bot) return interaction.update({ content: 'You can’t vote for a bot.', components: [] });
    awards.castVote(key, interaction.user.id, target);
    return interaction.update({ content: `🗳️ Voted <@${target}> for **${cat.name}**. You can change your vote anytime before Friday.`, components: [], allowedMentions: { parse: [] } });
  }
  // Sidebar "➕ Add someone" picker — staff-gated, adds the picked members to this sidebar's thread.
  if (interaction.isUserSelectMenu?.() && interaction.customId === 'sb_addpick') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage a sidebar.', flags: MessageFlags.Ephemeral });
    return sidebar.handleButton(interaction).catch(e => console.error('[sidebar addpick]', e.message));
  }
  // Corner jail thread's ➕ picker — add the picked members straight to the current thread.
  if (interaction.isUserSelectMenu?.() && interaction.customId === 'cornerthread_addpick') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can add someone here.', flags: MessageFlags.Ephemeral });
    const thread = interaction.channel;
    const added = [];
    for (const uid of interaction.values || []) {
      const m = await interaction.guild.members.fetch(uid).catch(() => null);
      if (!m || m.user.bot) continue;
      const ok = await thread.members.add(uid).then(() => true).catch(() => false);
      if (ok) added.push(uid);
    }
    if (!added.length) return interaction.reply({ content: 'Nobody new to add (already here, a bot, or I couldn’t add them).', flags: MessageFlags.Ephemeral });
    await thread.send({ content: `➕ ${added.map(u => `<@${u}>`).join(', ')} pulled in by <@${interaction.user.id}>.`, allowedMentions: { users: added } }).catch(() => {});
    return interaction.reply({ content: `➕ Added ${added.length} ${added.length === 1 ? 'person' : 'people'} to this thread.`, flags: MessageFlags.Ephemeral });
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
    const current = tribes.inAnyTribe(member);
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
    const current = tribes.inAnyTribe(member);
    if (current) return interaction.update({ content: `You’re already pledged to **${current.shortName || current.name}**. You can’t self-join anywhere else.`, components: [] });
    if (tribes.isVeteran(member.id)) return interaction.update({ content: `You’ve pledged before, so you can’t self-join anymore. Ask to be accepted instead.`, components: [] });
    const gate = tribes.getEntranceGate(tribe.key);
    if (gate && choice !== gate.correct) return interaction.update({ content: `❌ Not the answer **${tribe.shortName || tribe.name}** was looking for. Head back to #roles and try again.`, components: [] });
    await interaction.deferUpdate();
    const r = await joinTribeSelfServe(interaction.guild, tribe, member);
    return interaction.editReply({ content: r.ok ? r.content : 'Couldn’t add the tribe role. Tell an admin.', components: [] });
  }
  if (interaction.isButton?.() && interaction.customId === 'roleselect_birthday_open') {
    if (birthday.get(interaction.user.id)) return interaction.reply({ content: 'Your birthday is already set — that\'s a one-time self-set. Ask a mod to change it (`/birthday set` with the `member` option).', flags: MessageFlags.Ephemeral });
    const rows = [
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('month').setLabel('Month (1-12)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('day').setLabel('Day (1-31)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('utc_offset').setLabel('Your UTC offset, e.g. -5 or +5:30').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('year').setLabel('Birth year (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    ];
    return interaction.showModal(new ModalBuilder().setCustomId('roleselect_birthday_modal').setTitle('Set Your Birthday').addComponents(...rows));
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'roleselect_askrole_modal') {
    const what = interaction.fields.getTextInputValue('what').trim().slice(0, 200);
    const rc = rolereq.loadConfig();
    if (!rc.channelId) return interaction.reply({ content: 'Role requests aren\'t set up right now — ask a mod directly.', flags: MessageFlags.Ephemeral });
    const channel = await interaction.guild.channels.fetch(rc.channelId).catch(() => null);
    if (!channel) return interaction.reply({ content: 'Role requests aren\'t set up right now — ask a mod directly.', flags: MessageFlags.Ephemeral });
    // Free-text, not tied to an existing role — no auto-approve buttons (rolereq's approve/deny flow needs
    // a resolved role object), staff read it and create/assign manually via /roleselect-role + /request-role.
    await channel.send({
      content: `🙋 **Role request** from <@${interaction.user.id}>: ${what}`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
    return interaction.reply({ content: `✅ Sent your request for **${what}** to staff.`, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'roleselect_birthday_modal') {
    if (birthday.get(interaction.user.id)) return interaction.reply({ content: 'Your birthday is already set — that\'s a one-time self-set. Ask a mod to change it.', flags: MessageFlags.Ephemeral });
    const monthRaw = interaction.fields.getTextInputValue('month');
    const dayRaw = interaction.fields.getTextInputValue('day');
    const offsetInput = interaction.fields.getTextInputValue('utc_offset');
    const yearRaw = interaction.fields.getTextInputValue('year');
    const month = parseInt(monthRaw, 10);
    const day = parseInt(dayRaw, 10);
    const year = yearRaw ? parseInt(yearRaw, 10) : null;
    if (!Number.isInteger(month) || month < 1 || month > 12) return interaction.reply({ content: `"${monthRaw}" isn't a valid month (1-12).`, flags: MessageFlags.Ephemeral });
    if (!Number.isInteger(day) || day < 1 || day > 31) return interaction.reply({ content: `"${dayRaw}" isn't a valid day (1-31).`, flags: MessageFlags.Ephemeral });
    if (yearRaw && !Number.isInteger(year)) return interaction.reply({ content: `"${yearRaw}" isn't a valid year.`, flags: MessageFlags.Ephemeral });
    const r = saveBirthdayInput(interaction.user.id, month, day, offsetInput, year);
    if (!r.ok) return interaction.reply({ content: r.error, flags: MessageFlags.Ephemeral });
    return interaction.reply({ content: birthdaySavedMsg(r), flags: MessageFlags.Ephemeral });
  }
  if (interaction.isStringSelectMenu?.() && (interaction.customId === 'roleselect_age' || interaction.customId === 'roleselect_color')) {
    const isAge = interaction.customId === 'roleselect_age';
    if (isAge && config.verifiedRoleId && interaction.member.roles.cache.has(config.verifiedRoleId)) {
      return interaction.reply({ content: 'Your age bracket is locked once you’re verified. It’s a one-time registration choice. If it’s wrong, ask a mod/admin and they can correct it for you.', flags: MessageFlags.Ephemeral });
    }
    const group = (isAge ? roleselect.AGE() : roleselect.COLORS()).map(([, id]) => id);
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
  if (interaction.isModalSubmit?.() && interaction.customId === 'eventorgapp_submit') {
    try { return await eventorgapps.submitFromModal(interaction); }
    catch (e) { console.error(`[eventorgapps] modal ${e.message}`); return interaction.reply({ content: 'Could not submit that. Try again.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'modapp_pos_langsel') {
    try { return await modapps.handlePositionSelect(interaction); }
    catch (e) { console.error(`[modapps] langsel ${e.message}`); return interaction.reply({ content: 'Could not open that.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'modapp_accept_grant') {
    // Same gate as accept/deny/undo (index.js ~7909) — picking what to grant is as consequential as accepting.
    const approvers = modapps.loadConfig().approvers || [];
    if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id) && !opspanel.isBotOwner(interaction))
      return interaction.reply({ content: 'Only the **server owner** can accept mod applications.', flags: MessageFlags.Ephemeral });
    try { return await modapps.handleButton(interaction, config); }
    catch (e) { console.error(`[modapps] accept-grant ${e.message}`); return interaction.reply({ content: 'Could not process that.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('modapp_ask:')) {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can do that.', flags: MessageFlags.Ephemeral });
    try { return await modapps.handleAskModal(interaction); }
    catch (e) { console.error(`[modapps] ask ${e.message}`); return interaction.reply({ content: 'Could not send.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'pgpz_submit') {
    return pgPuzzleSubmit(interaction).catch(e => { console.error('[proving] puzzle submit:', e.message); return interaction.reply({ content: 'Something went wrong scoring that.', flags: MessageFlags.Ephemeral }).catch(() => {}); });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('mosaicans:')) {
    const [, tribeKey, iStr] = interaction.customId.split(':');
    const a = sealed.get();
    if (!a || a.mode !== 'trial' || a.game !== 'mosaic') return interaction.reply({ content: 'The Mosaic is over.', flags: MessageFlags.Ephemeral });
    const th = sealed.throne(tribeKey);
    if (!th || th.done || th.phraseSolved) return interaction.reply({ content: 'This Mosaic already wrapped up.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine || mine.key !== tribeKey) return interaction.reply({ content: 'Work your own tribe’s Mosaic.', flags: MessageFlags.Ephemeral });
    const i = Number(iStr);
    if (th.solved[i]) return interaction.reply({ content: 'A tribemate just solved that tile.', flags: MessageFlags.Ephemeral });
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let v = ''; try { v = interaction.fields.getTextInputValue('w'); } catch { }
    if (norm(v) !== norm(th.tiles[i].answer)) return interaction.reply({ content: '❌ Not that word — try again.', flags: MessageFlags.Ephemeral });
    const solved = th.solved.slice(); solved[i] = true;                     // read-modify-write is sync (no await) → no race
    sealed.updateThrone(tribeKey, { solved });
    sealed.scoreThrone(tribeKey, interaction.user.id, MOSAIC_TILE_PTS);     // +tile points, credit the solver (breadth)
    await mosaicRefresh(interaction.guild, tribeKey).catch(() => {});
    return interaction.reply({ content: `✅ Tile solved: **${th.tiles[i].answer.toUpperCase()}** (+${MOSAIC_TILE_PTS}).`, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('mosaicphrasesub:')) {
    const [, tribeKey] = interaction.customId.split(':');
    const a = sealed.get();
    if (!a || a.mode !== 'trial' || a.game !== 'mosaic') return interaction.reply({ content: 'The Mosaic is over.', flags: MessageFlags.Ephemeral });
    const th = sealed.throne(tribeKey);
    if (!th || th.done || th.phraseSolved) return interaction.reply({ content: 'This Mosaic already wrapped up.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine || mine.key !== tribeKey) return interaction.reply({ content: 'Work your own tribe’s Mosaic.', flags: MessageFlags.Ephemeral });
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let v = ''; try { v = interaction.fields.getTextInputValue('p'); } catch { }
    if (norm(v) !== norm(th.phrase)) return interaction.reply({ content: '❌ That’s not the phrase — keep solving tiles for more of the words.', flags: MessageFlags.Ephemeral });
    sealed.updateThrone(tribeKey, { solved: th.tiles.map(() => true), phraseSolved: true, done: true });
    sealed.scoreThrone(tribeKey, interaction.user.id, MOSAIC_PHRASE_PTS);
    await mosaicRefresh(interaction.guild, tribeKey).catch(() => {});
    return interaction.reply({ content: `🎉 Phrase solved: **${th.phrase}** (+${MOSAIC_PHRASE_PTS})! Your Mosaic is complete.`, flags: MessageFlags.Ephemeral });
  }
  // Send-to-corner reason modal (cornerReason feature). customId: corner_reason:<memberId>:<channelId>:<messageId>
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('ban_reason_modal:')) {
    const [, targetId, ruleSeg] = interaction.customId.split(':');
    const ruleN = ruleSeg && ruleSeg !== 'x' ? ruleSeg : null;
    const rawReason = (interaction.fields.getTextInputValue('reason') || '').trim();
    const reason = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${rawReason ? `, ${rawReason}` : ''}` : (rawReason || `Banned by ${interaction.user.tag}`);
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    try { await interaction.guild.bans.create(targetId, { reason, deleteMessageSeconds: 24 * 60 * 60 }); }
    catch (e) { return interaction.reply({ content: `❌ Ban failed: ${e.message}`, flags: MessageFlags.Ephemeral }); }
    await ownerlog.log(interaction.guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `${targetUser ? targetUser.tag : targetId} (\`${targetId}\`) — ${reason} — by <@${interaction.user.id}>.` });
    return interaction.reply({ content: `🔨 Banned **${targetUser ? targetUser.tag : targetId}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('sidebar_reason_modal:')) {
    const targetId = interaction.customId.split(':')[1];
    const reason = (interaction.fields.getTextInputValue('reason') || '').trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) return interaction.editReply('They’re not in the server anymore.');
    const r = await sidebar.pull(interaction.guild, interaction.member, target, reason);
    return interaction.editReply(r.ok ? `✅ Opened **Sidebar #${r.num}** → <#${r.threadId}>.` : `❌ ${r.msg}`);
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('corner_reason:')) {
    try {
      const [, memberId, channelId, messageId, ruleSeg] = interaction.customId.split(':');
      const ruleN = ruleSeg && ruleSeg !== 'x' ? ruleSeg : null;
      const rawReason = (interaction.fields.getTextInputValue('reason') || '').trim();
      const reason = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${rawReason ? `, ${rawReason}` : ''}` : (rawReason || null);
      let durStr = '';
      try { durStr = (interaction.fields.getTextInputValue('duration') || '').trim(); } catch { /* older modal had no duration field */ }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let durationMs = null;   // blank = indefinite, matching /corner (corner and native timeouts don't mix — no timeout field here)
      if (durStr) { const d = corner.parseDuration(durStr); if (!d) return interaction.editReply('Bad duration. Use e.g. `30s`, `10m`, `2h`, `1d` (or leave it blank for indefinite).'); durationMs = d; }
      const guild = interaction.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return interaction.editReply('That member isn’t in the server anymore.');
      // Tier hierarchy check (moved here from the context menu so the rule picker can show instantly): you
      // can't corner someone of a higher staff tier than you.
      const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
      if ((RANK[opspanel.memberTier(member)] || 0) > (RANK[opspanel.tierOf(interaction)] || 0) && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, opspanel.tierOf(interaction)))
        return interaction.editReply(`You can’t corner someone of a higher staff tier than you (they’re **${opspanel.memberTier(member)}**).`);
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      const target = ch && await ch.messages.fetch(messageId).catch(() => null);
      if (!target) return interaction.editReply('Couldn’t find the original message anymore (deleted?) — use `/corner @member` instead.');
      let optsStr = ''; try { optsStr = (interaction.fields.getTextInputValue('options') || '').toLowerCase(); } catch { /* older modal */ }
      const isAdult = optsStr.includes('adult');
      const isThread = optsStr.includes('thread');
      const res = await cornerFromMessage(guild, interaction.user.id, member, target, reason, durationMs, ruleN, opspanel.tierOf(interaction), { adult: isAdult, thread: isThread });
      if (!res.ok) return interaction.editReply(`Failed to corner: ${res.error}`);
      // Extra members to corner alongside the target: `also` (named IDs) + `sweep` (everyone non-staff active in
      // this channel in the last N minutes). Merged into ONE deduped set so nobody is cornered twice.
      let alsoStr = ''; try { alsoStr = (interaction.fields.getTextInputValue('also') || '').trim(); } catch { /* older modal */ }
      let sweepStr = ''; try { sweepStr = (interaction.fields.getTextInputValue('sweep') || '').trim(); } catch { /* older modal */ }
      if (isTrialMod(interaction)) { alsoStr = ''; sweepStr = ''; }   // trial mods are single-target only (fields are also hidden for them)
      const extras = [], seenExtra = new Set([member.id]);
      const unknownAlso = [];
      if (alsoStr) {
        for (const id of [...new Set(alsoStr.match(/\d{15,}/g) || [])]) {
          if (seenExtra.has(id)) continue;
          const mm = await guild.members.fetch(id).catch(() => null);
          if (mm) { extras.push(mm); seenExtra.add(id); } else unknownAlso.push(id);
        }
      }
      const mins = sweepStr ? Number(sweepStr) : 0;
      let sweptCount = 0;
      if (Number.isFinite(mins) && mins > 0) {
        const since = Date.now() - Math.min(mins, 120) * 60000;   // cap the look-back at 2h
        const recent = target.channel && await target.channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (recent) for (const m of recent.values()) {
          if (m.createdTimestamp < since || m.author.bot || seenExtra.has(m.author.id)) continue;
          const mm = await guild.members.fetch(m.author.id).catch(() => null);
          if (mm && !opspanel.memberTier(mm) && !(config.trialModRoleId && mm.roles.cache.has(config.trialModRoleId))) { extras.push(mm); seenExtra.add(m.author.id); sweptCount++; }
        }
      }
      let extraNote = '';
      if (extras.length) {
        const actorRank = { botowner: 4, owner: 3, admin: 2, mod: 1 }[opspanel.tierOf(interaction)] || 0;
        const { done, skipped, whenPhrase, jokes } = await cornerMany(guild, interaction.user.id, actorRank, extras, durationMs, { reasonText: reason, allowNamedStaff: true, actorTier: opspanel.tierOf(interaction) });
        extraNote = `\n➕ Also cornered **${done.length}**${done.length ? ` (${done.map(id => `<@${id}>`).join(', ')})` : ''}${sweptCount ? ` · swept ${Math.min(mins, 120)}m` : ''}${skipped.length ? ` · skipped ${skipped.length}` : ''}`;
        if (jokes.length) extraNote += `\n😂 Treated as joke (staff-on-staff, release tier lock waived): ${jokes.map(id => `<@${id}>`).join(', ')} — \`/corner-status\` to fix`;
        if (done.length) await target.channel.send({
          content: `🧹 <@${interaction.user.id}> also sent ${done.map(id => `<@${id}>`).join(', ')} to the corner ${whenPhrase}.`,
          allowedMentions: { parse: [] } }).catch(e => console.error('[corner-extra] public announce:', e.message));
      }
      if (unknownAlso.length) extraNote += `\n❓ Not found: ${unknownAlso.map(id => `\`${id}\``).join(', ')}`;
      const whenPhrase = durationMs ? `until <t:${Math.floor((Date.now() + durationMs) / 1000)}:f>` : 'indefinitely';
      await interaction.editReply({ content: `🚫 Sent <@${member.id}> to the corner ${whenPhrase}${reason ? ` (${reason})` : ''}. Stripped **${res.stripped}** role(s).${extraNote}`, allowedMentions: { parse: [] } });
      return jokeCheckIn(interaction, member.id, res.joke);
    } catch (e) { console.error(`[corner-reason] ${e.message}`); return (interaction.deferred ? interaction.editReply('Could not corner.') : interaction.reply({ content: 'Could not corner.', flags: MessageFlags.Ephemeral })).catch(() => {}); }
  }
  // Strike reason+weight modal. customId: strike_reason:<memberId>:<channelId>:<messageId>
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('wl_addterm_modal:')) {
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only admins (the ADMINS-★ role) can add watchlist terms.', flags: MessageFlags.Ephemeral });
    const term = (interaction.fields.getTextInputValue('term') || '').trim();
    let scope = (interaction.fields.getTextInputValue('scope') || '').trim().toLowerCase();
    if (scope !== 'loose') scope = 'strict';
    if (!term) return interaction.reply({ content: 'No term given.', flags: MessageFlags.Ephemeral });
    if (scope === 'loose') watchlist.addLoose(term); else watchlist.addTerm(term);
    return interaction.reply({ content: `➕ Added \`${term}\` to the **${scope}** watchlist by <@${interaction.user.id}>.`, flags: MessageFlags.Ephemeral });
  }
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
      // Same tier hierarchy as every corner entry point (/corner, "Send to corner", etc.) — this covers the
      // strike itself now (a mod could strike an admin outright, not just via the attached-corner field),
      // checked BEFORE the strike is recorded so a block never leaves a half-applied strike.
      const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
      const targetTier = opspanel.memberTier(member);
      if ((RANK[targetTier] || 0) > (RANK[opspanel.tierOf(interaction)] || 0))
        return interaction.editReply(`You can’t strike someone of a higher staff tier than you (they’re **${targetTier}**).`);
      const res = await strikes.addStrike(guild, member, state, { weight, ruleIndex: ruleN, reason, byId: interaction.user.id, byTag: interaction.user.tag });
      let cornerNote = '';
      if (cornerMs) {
        // forceReal: a corner attached to a strike is always serious, never defaults to joke (owner,
        // 2026-08-18: "strike corner paths don't need it cause strikes are always serious").
        const cr = await corner.corner(guild, member, cornerMs, state, interaction.user.id, ruleN, opspanel.tierOf(interaction), { forceReal: true });
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
  // ---- Member-founded tribe: the founder's identity modal → posts the cosign petition ----
  if (interaction.isModalSubmit?.() && interaction.customId === 'tribemfound_modal') {
    if (!features.enabled('memberFoundedTribe')) return interaction.reply({ content: 'Founding a tribe as a member isn’t available yet.', flags: MessageFlags.Ephemeral });
    if (opspanel.tierOf(interaction) || isTrialMod(interaction)) return interaction.reply({ content: 'Only a regular member can found a member-led tribe.', flags: MessageFlags.Ephemeral });
    if (tribes.myTribe(interaction.member)) return interaction.reply({ content: 'You’re already in a tribe.', flags: MessageFlags.Ephemeral });
    const name = interaction.fields.getTextInputValue('name').trim().slice(0, 80);
    if (!name) return interaction.reply({ content: 'Give the tribe a name.', flags: MessageFlags.Ephemeral });
    const color = parseTribeHex(interaction.fields.getTextInputValue('color'));
    if (color === null) return interaction.reply(badHexReply('primary'));
    const identity = { name, shortName: interaction.fields.getTextInputValue('short_name').trim().slice(0, 40) || name, emoji: interaction.fields.getTextInputValue('emoji').trim().slice(0, 10) || null, color };
    const req = tribes.startMemberFounding(interaction.user.id, identity);
    if (!req) return interaction.reply({ content: 'A member-founded tribe (or an open petition) already exists — only one at a time.', flags: MessageFlags.Ephemeral });
    const announce = tribes.getAnnounceInfo();
    const ch = (announce?.channelId && await interaction.guild.channels.fetch(announce.channelId).catch(() => null)) || interaction.channel;
    const posted = ch && await ch.send(renderMemberFounding(req)).catch(() => null);
    if (!posted) { tribes.clearMemberFounding(); return interaction.reply({ content: 'Couldn’t post the petition anywhere. Ask staff to check the tribe-announcements channel.', flags: MessageFlags.Ephemeral }); }
    tribes.setMemberFoundingMessage(ch.id, posted.id);
    return interaction.reply({ content: `🏴 Your founding petition is live in <#${ch.id}>. Rally **${tribes.MEMBER_FOUND_COSIGNS}** members (trial mods count) to cosign it.`, flags: MessageFlags.Ephemeral });
  }
  // ---- Member-founded tribe: a member/trial-mod cosigns ----
  if (interaction.isButton?.() && interaction.customId === 'tribemfound_cosign') {
    const req = tribes.getMemberFounding();
    if (!req) return interaction.reply({ content: 'This founding petition is no longer active.', flags: MessageFlags.Ephemeral });
    if (interaction.user.id === req.founderId) return interaction.reply({ content: 'You can’t cosign your own founding petition.', flags: MessageFlags.Ephemeral });
    if (!isVerifiedOrStaff(interaction)) return interaction.reply({ content: 'You need to be verified to cosign.', flags: MessageFlags.Ephemeral });
    if (opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'Mods/admins/owners can’t cosign a member-led tribe — only regular members and trial mods.', flags: MessageFlags.Ephemeral });
    if (tribes.myTribe(interaction.member)) {
      // Cosigning JOINS this tribe, so you must leave your current one first. Rather than just tell them,
      // kick off the SAME leave flow the hub/command use (files a leave request to their throne for the leader).
      const r = await submitLeaveRequest(interaction.guild, interaction.member);
      const lead = r.ok ? 'Cosigning makes you a **co-leader** of this tribe, but you’re still in one — so I’ve started your release: ' : 'Cosigning makes you a **co-leader** of this tribe, but you’re still in one. ';
      return interaction.reply({ content: `${lead}${r.content}${r.ok ? '\nOnce your leader approves it, come back and cosign.' : ''}`, flags: MessageFlags.Ephemeral });
    }
    const updated = tribes.cosignMemberFounding(interaction.user.id);
    if (!updated) return interaction.reply({ content: 'You already cosigned this.', flags: MessageFlags.Ephemeral });
    return interaction.update(renderMemberFounding(updated));
  }
  // ---- Member-founded tribe: the founder raises it once 9 cosigns are reached ----
  if (interaction.isButton?.() && interaction.customId.startsWith('tribemfound_create:')) {
    const founderId = interaction.customId.split(':')[1];
    if (interaction.user.id !== founderId) return interaction.reply({ content: 'Only the founder can raise the tribe.', flags: MessageFlags.Ephemeral });
    const req = tribes.getMemberFounding();
    if (!req || req.founderId !== founderId) return interaction.reply({ content: 'This founding petition is no longer active.', flags: MessageFlags.Ephemeral });
    if (req.cosigns.length < tribes.MEMBER_FOUND_COSIGNS) return interaction.reply({ content: `Not enough cosigns yet (**${req.cosigns.length}/${tribes.MEMBER_FOUND_COSIGNS}**).`, flags: MessageFlags.Ephemeral });
    if (tribes.myTribe(interaction.member)) return interaction.reply({ content: 'You’re in a tribe now — can’t found another.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const id = req.identity;
      const b = await buildTribe(interaction.guild, { name: id.name, shortName: id.shortName, emoji: id.emoji, color: id.color, style: 'smallcaps', leaderMember: interaction.member }, config);
      tribes.update(b.tribe.key, { foundedByMod: false, foundedByMember: true });   // member-led → exempt from the mod-leader requirement (like admin-founded)
      for (const ch of [b.cat, b.throne, b.hall, b.vc]) await permguard.blessChannel(interaction.guild, ch.id).catch(() => {});
      // Cosign = join AS A CO-LEADER (owner ruling): the founder + up-to-9 cosigners co-lead the tribe together,
      // so each gets the leader role and thus every existing leader tool (invite/banish/announce/note/rank/motto/
      // retheme/shop/war/alliances + throne hub) with no separate command. Member-founded tribes are exempt from
      // the "leaders must be staff" sweep. Skip any cosigner who slipped into another tribe since signing.
      const enrolled = [], skipped = [];
      for (const cid of req.cosigns) {
        const cm = await interaction.guild.members.fetch(cid).catch(() => null);
        if (!cm || opspanel.meets(opspanel.memberTier(cm), 'mod')) { skipped.push(cid); continue; }   // gone, or became staff since cosigning — member tribe stays member-only (trial-tier is fine, matches staffBlockedFromMemberTribe)
        const cr = await addCoLeader(interaction.guild, b.tribe, b.leaderRole, cm);
        if (cr?.ok) enrolled.push(cid); else skipped.push(cid);
      }
      tribes.setMemberFoundedTribe(b.tribe.key);   // records the one-at-a-time slot AND clears the pending petition
      if (req.channelId && req.messageId) {
        const pch = await interaction.guild.channels.fetch(req.channelId).catch(() => null);
        const pmsg = pch && await pch.messages.fetch(req.messageId).catch(() => null);
        if (pmsg) await pmsg.edit({ content: `## ${b.tribe.emoji || '🏴'} ${b.tribe.name} has risen!\n> Co-led by <@${founderId}>${enrolled.length ? `, ${enrolled.map(u => `<@${u}>`).join(', ')}` : ''}.\n> Land: <#${b.throne.id}> · <#${b.hall.id}> · <#${b.vc.id}>.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
      }
      return interaction.editReply(`🏴 **${b.tribe.name}** is founded — you and **${enrolled.length}** cosigner${enrolled.length === 1 ? '' : 's'} co-lead it (you all share the leader role + every leader tool).${skipped.length ? ` (${skipped.length} cosigner${skipped.length === 1 ? '' : 's'} couldn’t be added — they’d joined another tribe.)` : ''} Land: <#${b.throne.id}> · <#${b.hall.id}> · <#${b.vc.id}>.`);
    } catch (e) {
      console.error('[tribe member-found]', e.message);
      return interaction.editReply(`❌ Couldn’t raise the tribe: ${e.message}`);
    }
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
    if (!canManageTribe(interaction, tribe))
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
    if (tribe && !canManageTribe(interaction, tribe))
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
    if (!canManageTribe(interaction, tribe))
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
    if (tribe && !canManageTribe(interaction, tribe))
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
    const body = board.map((t, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} ${t.emoji || '🏴'} **${t.shortName || t.name}**${t.strongholdTier ? ` 🏰${t.strongholdTier}` : ''} · ${t.memberCount} member${t.memberCount === 1 ? '' : 's'} · \`${t.glory || 0} glory\` this week · \`${t.treasury || 0}\` treasury · 👑×${t.seasonCrowns || 0} Age`).join('\n');
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
    if (!canManageTribe(interaction, tribe))
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
    if (['admin', 'mod'].includes(opspanel.tierOf(interaction))) {
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
    const isLeaderTool = ['invite', 'banish', 'note', 'rank', 'retheme', 'announce', 'motto', 'muster', 'war', 'alliance', 'allybreak', 'allygift', 'clearthrone'].includes(act);
    if (isLeaderTool && !canManageTribe(interaction, tribe))
      return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
    // Frozen perks (mod-tribe short on leaders): war/alliances/shop are locked until it's back to 3 leaders.
    if (['war', 'alliance', 'allybreak', 'allygift', 'shop'].includes(act) && tribes.isFrozen(tribe))
      return interaction.reply({ content: `🧊 **${tribe.shortName || tribe.name}**’s perks are frozen — it’s short on leaders. An admin can restore them with \`/tribe-admin set-leader\`.`, flags: MessageFlags.Ephemeral });
    if (act === 'clearthrone') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const n = await clearThroneMessages(interaction.guild, tribe.throneId);
      return interaction.editReply(`🧹 Cleared **${n}** message(s) from the throne. The pinned panel + 📖 Paths & Attributes reference stay put.`);
    }
    // Deliberately NOT in isLeaderTool above — its own bespoke gate inside beginTribeDisbandFlow (admin+
    // direct, or a genuine tribe leader via the agreement flow) is narrower than canManageTribe's blanket
    // "any staff who's also a member of this tribe" allowance.
    if (act === 'disband') return beginTribeDisbandFlow(interaction, tribe);
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
      const embed = new EmbedBuilder().setColor(copy.herald.COLORS.prestige).setTitle('🏅 Your Trophies').setDescription(parts.join('\n').slice(0, 4000)).setFooter({ text: title ? `Equipped title: ${title}` : 'No title equipped' });
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
      const embed = new EmbedBuilder().setColor(copy.herald.COLORS.age).setTitle('🏛️ Hall of Fame').setDescription(body).setFooter({ text: season ? `Current age: ${season.name} (Age ${season.number})` : '' });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    if (act === 'quests') {
      if (!features.enabled('tribeQuests')) return interaction.reply({ content: 'Quests aren’t enabled.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: renderQuestBoard(tribe.key), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (act === 'relics') {
      if (!features.enabled('relics')) return interaction.reply({ content: 'Relics aren’t enabled.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: renderRelicsBoard(tribe.key), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (act === 'prestige') {
      if (!features.enabled('prestige')) return interaction.reply({ content: 'Prestige isn’t enabled.', flags: MessageFlags.Ephemeral });
      const uid = interaction.user.id;
      if (!interaction.member.roles.cache.has(tribe.roleId)) return interaction.reply({ content: `You’re not in **${tribe.shortName || tribe.name}**.`, flags: MessageFlags.Ephemeral });
      const ranks = tribe.ranks || [];
      const topIdx = ranks.length - 1;
      const isStaffOrLeader = tribes.isLeader(interaction.member, tribe) || ['admin', 'mod'].includes(opspanel.tierOf(interaction));
      const atTop = ranks.length > 0 && !isStaffOrLeader && tribes.earnedRankIndex(tribe, uid) >= topIdx;
      const lvl = tribes.getPrestige(tribe.key, uid);
      const tides = tribes.getTides(tribe.key, uid);
      const pts = tribe.pointsName || 'points';   // a tribe's own name for its activity points ("points" by default)
      const topName = ranks[topIdx]?.name || 'the top rank';
      const need = ranks[topIdx]?.tides || 0;
      const head = `# ⭐ ${tribe.emoji || '🏴'} ${tribe.shortName || tribe.name} · Prestige\n-# Reach **${topName}**, then Prestige: your ${pts} reset to zero, but you keep a permanent honour title and a mark in your tribe’s history. Climb back to Prestige again.`;
      const status = `\n\nYour prestige: **${lvl}** ${'⭐'.repeat(Math.min(lvl, 10))}\nYour ${pts}: **${tides}**`;
      if (isStaffOrLeader) return interaction.reply({ content: `${head}${status}\n\n-# Prestige is for the rank ladder. As ${tribes.isLeader(interaction.member, tribe) ? 'a leader' : 'staff'} you sit above it.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      if (!atTop) return interaction.reply({ content: `${head}${status}\n\n-# Not yet eligible. Reach **${topName}** (needs ${need} ${pts} plus tenure) to Prestige.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribethrone_prestige_confirm:${tribe.key}`).setEmoji('⭐').setLabel(`Prestige now — resets my ${pts}`.slice(0, 80)).setStyle(ButtonStyle.Danger));
      return interaction.reply({ content: `${head}${status}\n\n**You’re eligible.** Prestiging resets your **${tides}** ${pts} to 0 and raises you to Prestige **${lvl + 1}**.`, components: [row], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (act === 'prestige_confirm') {
      if (!features.enabled('prestige')) return interaction.reply({ content: 'Prestige isn’t enabled.', flags: MessageFlags.Ephemeral });
      const uid = interaction.user.id;
      const ranks = tribe.ranks || [];
      const topIdx = ranks.length - 1;
      const isStaffOrLeader = tribes.isLeader(interaction.member, tribe) || ['admin', 'mod'].includes(opspanel.tierOf(interaction));
      if (!interaction.member.roles.cache.has(tribe.roleId) || isStaffOrLeader || !(ranks.length > 0 && tribes.earnedRankIndex(tribe, uid) >= topIdx))
        return interaction.reply({ content: 'You’re no longer eligible to Prestige.', flags: MessageFlags.Ephemeral });
      const before = tribes.getTides(tribe.key, uid);
      tribes.resetMemberTides(tribe.key, uid);
      const lvl = tribes.addPrestige(tribe.key, uid, Date.now());
      await applyTribeRank(interaction.guild, tribe, interaction.member, 0, 'prestige reset', false).catch(() => {});
      let titleLine = '';
      if (features.enabled('achievements')) {
        const got = achievements.bumpAndCheck(uid, 'prestige');
        if (got.length) { const a = got[got.length - 1]; titleLine = `\n🏅 Unlocked **${a.name}** — new title: *${a.title}*.`; }
      }
      lore.record({ type: 'prestige', title: `${interaction.member.displayName} reached Prestige ${lvl} in ${tribe.shortName || tribe.name}`, tribes: [tribe.key], level: lvl });
      await broadcastSpectacle(interaction.guild, `# ⭐ Prestige\n<@${uid}> of ${tribeName(tribe.key)} ascended to **Prestige ${lvl}**, resetting their climb for honour.`, [tribe.roleId].filter(Boolean));
      return interaction.update({ content: `# ⭐ You are now Prestige ${lvl}!\nYour **${before}** ${tribe.pointsName || 'points'} reset to 0. Climb again when you’re ready.${titleLine}\n-# Equip your title from 🏅 Trophies.`, components: [], allowedMentions: { parse: [] } });
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
      if (['admin', 'mod'].includes(opspanel.tierOf(interaction))) {
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
      if (tribes.onOutboundCooldown(tribe)) return interaction.reply({ content: `On attack cooldown until <t:${Math.floor(tribes.outboundCooldownEndsAt(tribe) / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
      if (tribes.activeOutboundWar(tribe.key)) return interaction.reply({ content: 'You already have a war underway as the aggressor — only one outbound war at a time. (Being attacked doesn’t stop you from attacking.)', flags: MessageFlags.Ephemeral });
      const targets = tribes.all().filter(t => t.key !== tribe.key);
      if (!targets.length) return interaction.reply({ content: 'No other tribes to war.', flags: MessageFlags.Ephemeral });
      const menu = new StringSelectMenuBuilder().setCustomId(`tribethrone_war_pick:${tribeKey}`).setPlaceholder('Declare war on which tribe?')
        .addOptions(targets.slice(0, 25).map(t => ({ label: `${t.emoji || '🏴'} ${t.shortName || t.name}`.slice(0, 100), value: t.key })));
      return interaction.reply({ content: '⚔️ This opens a 6h vote for YOUR members — the target has no say in whether it starts. Pick who to war.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (act === 'alliance') {
      if (tribe.allyKey) return interaction.reply({ content: 'Already allied — break it first if you want a different ally.', flags: MessageFlags.Ephemeral });
      if (tribes.activeAllianceVoteFor(tribe.key)) return interaction.reply({ content: 'Already have an alliance vote in progress.', flags: MessageFlags.Ephemeral });
      const targets = tribes.all().filter(t => t.key !== tribe.key && !t.allyKey);
      if (!targets.length) return interaction.reply({ content: 'No eligible tribes right now (everyone else is already allied).', flags: MessageFlags.Ephemeral });
      const menu = new StringSelectMenuBuilder().setCustomId(`tribethrone_alliance_pick:${tribeKey}`).setPlaceholder('Propose an alliance with which tribe?')
        .addOptions(targets.slice(0, 25).map(t => ({ label: `${t.emoji || '🏴'} ${t.shortName || t.name}`.slice(0, 100), value: t.key })));
      return interaction.reply({ content: '🤝 This opens a 6h vote for YOUR members first, then the other tribe decides. Pick who to propose to.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
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
  // ==== /tribe panel interaction handlers (Phase 8) ============================================
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'tp_admin_pick') {
    await interaction.deferUpdate();
    return interaction.editReply(await buildTribePanelView(interaction, interaction.values[0]));
  }
  if (interaction.isButton?.() && interaction.customId === 'tp_tally_start') {
    if (!(opspanel.tierOf(interaction) || contest.isEventOrganizer(interaction.member))) return interaction.reply({ content: 'Only staff or an Event Organizer can start a live tally.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    const r = await startTally(interaction.guild, interaction.user.id);
    if (!r.ok) return interaction.editReply({ content: `Couldn't start it: ${r.error}`, components: [] });
    return interaction.editReply(await buildTribePanelView(interaction));
  }
  if (interaction.isButton?.() && interaction.customId === 'tp_tally_end') {
    if (!(opspanel.tierOf(interaction) || contest.isEventOrganizer(interaction.member))) return interaction.reply({ content: 'Only staff or an Event Organizer can end the live tally.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    const r = await endTally(interaction.guild);
    if (!r.ok) return interaction.editReply({ content: r.error, components: [] });
    return interaction.editReply(await buildTribePanelView(interaction));
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'tp_start_game') {
    const picked = interaction.values[0];
    const isClassic = picked.startsWith('classic_');
    // Classic events (Arena/Sealed Arena/Trial) keep their own wider access rule (any tribe leader, or
    // admin) — Tribe Games itself stays mod+ only.
    if (!isClassic && !canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can start a Tribe Game.', flags: MessageFlags.Ephemeral });
    if (isClassic && !canWLAdmin(interaction) && !tribes.leaderTribe(interaction.member)) return interaction.reply({ content: 'Only a tribe leader or an admin can launch that.', flags: MessageFlags.Ephemeral });
    if (isClassic) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (picked === 'classic_arena') {
        const blocked = arena.startBlocked(); if (blocked) return interaction.editReply(blocked);
        const type = ARENA_ALL_TYPES[Math.floor(Math.random() * ARENA_ALL_TYPES.length)];
        const minutes = ARENA_DEFAULTS[type] || 5;
        try { await startArenaCountdown(interaction.guild, type, minutes, interaction.user.id); }
        catch (e) { return interaction.editReply(`Couldn't launch it: ${e.message}`); }
        return interaction.editReply(`🎪 Announced **${ARENA_LABEL[type] || type}** — begins in 5 minutes, runs ${minutes} min.`);
      }
      if (picked === 'classic_sealed') {
        if (!features.enabled('sealedArena')) return interaction.editReply('The Sealed Arena isn’t enabled yet.');
        const r = await startSealedArena(interaction.guild, { startedById: interaction.user.id });
        return interaction.editReply(r.ok ? `🚪 Sealed Arena launched (${ARENA_LABEL[r.gameType] || r.gameType}).` : `Couldn't launch it: ${r.error}`);
      }
      if (picked === 'classic_trial') {
        if (!features.enabled('theTrials')) return interaction.editReply('The Trials aren’t enabled yet.');
        const game = TRIAL_GAMES[Math.floor(Date.now() / 86400000) % TRIAL_GAMES.length];
        const r = await startTrial(interaction.guild, { startedById: interaction.user.id, game, muster: false });
        return interaction.editReply(r.ok ? `⚔️ ${TRIAL_GAME_LABEL[r.game] || 'Trial'} launched (all tribes).` : `Couldn't launch it: ${r.error}`);
      }
    }
    await interaction.deferUpdate();
    const r = await startTribeGame(interaction.guild, { gameId: picked, startedById: interaction.user.id });
    if (!r.ok) return interaction.editReply({ content: `Failed: ${r.error}`, components: [] });
    return interaction.editReply(await buildTribePanelView(interaction));
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'tp_result_versus') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can report a result.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    const r = await finishTribeGameVersus(interaction.guild, interaction.values[0]);
    if (!r.ok) return interaction.editReply({ content: `Failed: ${r.error}`, components: [] });
    const winner = tribes.get(r.winnerKey);
    await interaction.editReply({ content: `🏆 **${winner?.shortName || r.winnerKey}** wins! +${r.treas} Treasury, +${r.glory} Glory.`, components: [] });
    return;
  }
  if (interaction.isButton?.() && interaction.customId === 'tp_result_open') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can report a result.', flags: MessageFlags.Ephemeral });
    const active = tribegames.get();
    if (!active || active.phase !== 'live') return interaction.reply({ content: 'No live Tribe Game to report.', flags: MessageFlags.Ephemeral });
    return safeShowModal(interaction, buildTribeGameResultModal(active));
  }
  if (interaction.isModalSubmit?.() && (interaction.customId === 'tp_result_modal_std' || interaction.customId === 'tp_result_modal_bulk')) {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can report a result.', flags: MessageFlags.Ephemeral });
    const active = tribegames.get();
    if (!active || active.phase !== 'live') return interaction.reply({ content: 'No live Tribe Game to report.', flags: MessageFlags.Ephemeral });
    const catalog = tribegames.GAME_CATALOG[active.gameId];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roleByTribe = {}; const bad = [];
    if (interaction.customId === 'tp_result_modal_std') {
      for (const k of tribegames.entrantTribeKeys()) {
        const raw = interaction.fields.getTextInputValue(`role:${k}`);
        const code = normalizeRoleCode(raw, catalog.roles);
        if (!code) bad.push(`${tribeName(k)}: "${raw}"`); else roleByTribe[k] = code;
      }
    } else {
      const bulk = interaction.fields.getTextInputValue('bulk');
      for (const line of bulk.split('\n')) {
        const [kRaw, roleRaw] = line.split(':');
        const k = (kRaw || '').trim().toLowerCase();
        if (!k || !tribegames.entrantTribeKeys().includes(k)) continue;
        const code = normalizeRoleCode(roleRaw, catalog.roles);
        if (!code) bad.push(`${tribeName(k)}: "${(roleRaw || '').trim()}"`); else roleByTribe[k] = code;
      }
      for (const k of tribegames.entrantTribeKeys()) if (!roleByTribe[k] && !bad.some(b => b.startsWith(tribeName(k)))) bad.push(`${tribeName(k)}: (missing)`);
    }
    const outcomeCode = normalizeRoleCode(interaction.fields.getTextInputValue('outcome'), catalog.roles);
    if (!outcomeCode) bad.push(`outcome: "${interaction.fields.getTextInputValue('outcome')}"`);
    if (bad.length) return interaction.editReply(`❌ Couldn't parse: ${bad.join(', ')}. Valid roles: ${catalog.roles.join(', ')}.`);
    const r = await finishTribeGameRoleOutcome(interaction.guild, roleByTribe, outcomeCode);
    if (!r.ok) return interaction.editReply(`Failed: ${r.error}`);
    const lines = r.payouts.map(p => `**${tribes.get(p.tribeKey)?.shortName || p.tribeKey}** (${p.tribeKey in roleByTribe ? roleByTribe[p.tribeKey] : ''}) — +${p.treas} Treasury, +${p.glory} Glory`);
    return interaction.editReply(lines.length ? `🎮 Result recorded:\n${lines.join('\n')}` : '🎮 Result recorded — nobody qualified for a payout this round.');
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tp_setrep:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe || {})} or staff can set your tribe's rep.`, flags: MessageFlags.Ephemeral });
    if (!tribegames.isActive() || tribegames.get().phase !== 'lobby') return interaction.reply({ content: 'No open Tribe Games lobby right now.', flags: MessageFlags.Ephemeral });
    tribegames.setEntrant(tribeKey, interaction.values);
    await interaction.deferUpdate();
    return interaction.editReply(await buildTribePanelView(interaction));
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('tp_choosepath:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !tribes.isMember(interaction.member, tribe)) return interaction.reply({ content: 'You need to be in this tribe to pick a path.', flags: MessageFlags.Ephemeral });
    tribes.setMemberPath(tribeKey, interaction.user.id, interaction.values[0]);
    await interaction.deferUpdate();
    return interaction.editReply(await buildTribePanelView(interaction));
  }
  // Settings: folds /tribe-admin points/title/staffrank-set into one modal, scoped to the caller's OWN
  // tribe (canManageTribe) rather than the old commands' any-tribe-by-autocomplete reach — a deliberate
  // narrowing that matches how the rest of the panel is tribe-scoped; an admin wanting to configure a tribe
  // they aren't in/leading still needs the raw command path (kept, not retired, for that edge case).
  if (interaction.isButton?.() && interaction.customId.startsWith('tp_settings:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe || {})} or staff can change this tribe's settings.`, flags: MessageFlags.Ephemeral });
    const rows = [
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('points').setLabel('Activity points name (e.g. Tides)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20).setValue(tribe.pointsName || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel(`Head's title (e.g. ${tribes.DEFAULT_LEADER_TITLE})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40).setValue(tribe.leaderTitle || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('staffrank').setLabel(`Staff-rank title (e.g. ${tribes.DEFAULT_STAFF_RANK_TITLE})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40).setValue(tribe.staffRankTitle || '')),
    ];
    return safeShowModal(interaction, new ModalBuilder().setCustomId(`tp_settings_modal:${tribeKey}`).setTitle('Tribe Settings').addComponents(...rows));
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tp_settings_modal:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !canManageTribe(interaction, tribe)) return interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
    const points = interaction.fields.getTextInputValue('points').trim();
    const title = interaction.fields.getTextInputValue('title').trim();
    const staffrank = interaction.fields.getTextInputValue('staffrank').trim();
    const patch = {};
    if (points) patch.pointsName = points.slice(0, 20);
    if (title) patch.leaderTitle = title.slice(0, 40);
    if (staffrank) patch.staffRankTitle = staffrank.slice(0, 40);
    if (Object.keys(patch).length) tribes.update(tribeKey, patch);
    if (staffrank && tribe.staffRankRoleId) {
      const role = interaction.guild.roles.cache.get(tribe.staffRankRoleId);
      if (role) await role.setName(`${tribe.emoji || '🏴'} ${toSmallCaps(staffrank.slice(0, 40))}`, 'tribe staff-rank rename').catch(() => {});
    }
    const fresh = tribes.get(tribeKey);
    const changed = [points && `points → **${fresh.pointsName}**`, title && `head's title → **${fresh.leaderTitle}**`, staffrank && `staff rank → **${fresh.staffRankTitle}**`].filter(Boolean);
    return interaction.reply({ content: changed.length ? `⚙️ Updated: ${changed.join(', ')}.` : 'Nothing changed (all fields left blank).', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  // Nominate: any member of the tribe proposes someone to join — approval routes through the throne, same
  // machinery /tribe nominate used (tribes.createNomination + the tribenom_approve/deny buttons already wired).
  if (interaction.isButton?.() && interaction.customId.startsWith('tp_nominate:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !tribes.isMember(interaction.member, tribe)) return interaction.reply({ content: 'You need to be in this tribe to nominate someone.', flags: MessageFlags.Ephemeral });
    const menu = new UserSelectMenuBuilder().setCustomId(`tp_nominate_pick:${tribeKey}`).setPlaceholder('Who to nominate?');
    return interaction.reply({ content: '🪶 Pick who to nominate.', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tp_nominate_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !tribes.isMember(interaction.member, tribe)) return interaction.reply({ content: 'You need to be in this tribe to nominate someone.', flags: MessageFlags.Ephemeral });
    const targetId = interaction.values[0];
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target || target.user.bot) return interaction.update({ content: 'Couldn’t find that member.', components: [] });
    if (targetId === interaction.user.id) return interaction.update({ content: 'You can’t nominate yourself.', components: [] });
    if (target.roles.cache.has(tribe.roleId)) return interaction.update({ content: `<@${targetId}> is already in **${tribe.shortName || tribe.name}**.`, components: [], allowedMentions: { parse: [] } });
    const other = tribes.memberTribe(target);
    if (other) return interaction.update({ content: `<@${targetId}> is already in **${other.shortName || other.name}**.`, components: [], allowedMentions: { parse: [] } });
    const existing = tribes.getNomination(targetId);
    if (existing && ['pending_approval', 'pending_accept'].includes(existing.status)) return interaction.update({ content: `<@${targetId}> already has a pending nomination.`, components: [], allowedMentions: { parse: [] } });
    if (!tribe.throneId) return interaction.update({ content: 'This tribe has no throne channel to route the approval through.', components: [] });
    const throne = await interaction.guild.channels.fetch(tribe.throneId).catch(() => null);
    if (!throne) return interaction.update({ content: 'Couldn’t find the throne channel.', components: [] });
    tribes.createNomination(tribe.key, interaction.user.id, targetId);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tribenom_approve:${targetId}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`tribenom_deny:${targetId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger));
    await throneSend(throne, { content: `## 🪶 Nomination\n-# proposed by <@${interaction.user.id}>\n> <@${interaction.user.id}> nominates <@${targetId}> to join **${tribe.shortName || tribe.name}**.\n-# ${tribes.leaderTitle(tribe)} or staff: approve to send them an invite to accept.`, components: [row], allowedMentions: { users: [targetId] } }).catch(() => {});
    return interaction.update({ content: `🪶 Sent to <#${tribe.throneId}> for approval. If ${tribes.leaderTitle(tribe)} or staff approve, ${target.displayName} will get an invite to accept.`, components: [], allowedMentions: { parse: [] } });
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tp_editlore:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe || {})} or staff can edit this tribe's lore.`, flags: MessageFlags.Ephemeral });
    return safeShowModal(interaction, loreModal1(tribeKey));
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tp_lore1:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !canManageTribe(interaction, tribe)) return interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
    const title = interaction.fields.getTextInputValue('title');
    const pathNames = [interaction.fields.getTextInputValue('path0'), interaction.fields.getTextInputValue('path1'), interaction.fields.getTextInputValue('path2')];
    const attributeNames = interaction.fields.getTextInputValue('attrs').split(',').map(s => s.trim()).slice(0, 3);
    _loreStash.set(`${interaction.user.id}:${tribeKey}`, { title, pathNames, attributeNames, at: Date.now() });
    // Modals can't chain directly — a modal submit can only reply/showModal, and a second showModal from a
    // modal-submit interaction isn't allowed by Discord. Bridge with a button the leader clicks right after.
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tp_lore2_open:${tribeKey}`).setLabel('Continue: ranks + myth').setEmoji('➡️').setStyle(ButtonStyle.Primary));
    return interaction.reply({ content: `Got it — **${title}**, paths: ${pathNames.join(', ')}. One more step for the rank titles and the myth text.`, components: [row], flags: MessageFlags.Ephemeral });
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tp_lore2_open:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const stash = _loreStash.get(`${interaction.user.id}:${tribeKey}`);
    if (!stash) return interaction.reply({ content: 'That session expired — start over with Edit Lore.', flags: MessageFlags.Ephemeral });
    return safeShowModal(interaction, loreModal2(tribeKey, stash.pathNames));
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tp_lore2:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe || !canManageTribe(interaction, tribe)) return interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
    const stash = _loreStash.get(`${interaction.user.id}:${tribeKey}`);
    if (!stash) return interaction.reply({ content: 'That session expired — start over with Edit Lore.', flags: MessageFlags.Ephemeral });
    _loreStash.delete(`${interaction.user.id}:${tribeKey}`);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rankTitles = [0, 1, 2].flatMap(i => interaction.fields.getTextInputValue(`ranks${i}`).split(',').map(s => s.trim()).slice(0, 4));
    const myth = interaction.fields.getTextInputValue('myth');
    tribes.setLore(tribeKey, { title: stash.title, myth, pathNames: stash.pathNames, attributeNames: stash.attributeNames, rankTitles });
    await syncTribeRankRoles(interaction.guild, tribeKey);
    await backfillDefaultPaths(interaction.guild).catch(() => {});   // existing members shouldn't sit rankless until next boot
    const fresh = tribes.get(tribeKey);
    const hallId = fresh.hallId || fresh.throneId;
    if (hallId) {
      const ch = await interaction.guild.channels.fetch(hallId).catch(() => null);
      if (ch) await ch.send({ content: `# 📖 ${fresh.lore.title}\n${myth.slice(0, 1800)}\n\n**Paths:** ${fresh.lore.pathNames.join(' · ')}`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    if (fresh.throneId) {
      const throne = await interaction.guild.channels.fetch(fresh.throneId).catch(() => null);
      if (throne) await ensureLoreReference(interaction.guild, throne, fresh).catch(() => {});
    }
    return interaction.editReply(`📖 Lore set for **${fresh.shortName || fresh.name}**. Paths: ${fresh.lore.pathNames.join(', ')}. Rank roles created/renamed to match.`);
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tribethrone_invite_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!canManageTribe(interaction, tribe)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
    const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
    if (!target) return interaction.update({ content: 'Couldn’t find that member.', components: [] });
    const r = await submitInvite(interaction.guild, tribe, interaction.user.id, target);
    return interaction.update({ content: r.content, components: [], allowedMentions: { parse: [] } });
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tribethrone_banish_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!canManageTribe(interaction, tribe)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
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
    if (!canManageTribe(interaction, tribe)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
    const targetId = interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`tribethrone_note_modal:${tribeKey}:${targetId}`).setTitle('Note').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Note (blank to just view existing)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
    return safeShowModal(interaction, modal);
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('tribethrone_rank_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!canManageTribe(interaction, tribe)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
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
    if (!canManageTribe(interaction, tribe)) return interaction.update({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, components: [] });
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
    if (!canManageTribe(interaction, attacker)) return interaction.update({ content: `Only ${tribes.leaderTitle(attacker)} or staff can do that.`, components: [] });
    if (tribes.onOutboundCooldown(attacker) || tribes.activeOutboundWar(attacker.key)) return interaction.update({ content: 'No longer eligible to declare war right now (attack cooldown or you already have a war underway).', components: [] }).catch(() => {});
    const defender = tribes.get(interaction.values[0]);
    if (!defender) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (tribes.onInboundCooldown(defender) || tribes.activeInboundWar(defender.key)) return interaction.update({ content: `**${defender.shortName || defender.name}** can’t be attacked right now — they were recently at war or are already defending one.`, components: [] }).catch(() => {});
    await interaction.deferUpdate();
    const war = tribes.startWarVote(attacker.key, defender.key, interaction.user.id);
    await postWarVote(interaction.guild, war, attacker, defender);
    return interaction.editReply({ content: `⚔️ War vote started against **${defender.shortName || defender.name}** in <#${attacker.hallId}>.`, components: [] });
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('tribethrone_alliance_pick:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const proposer = tribes.get(tribeKey);
    if (!proposer) return interaction.update({ content: 'That tribe no longer exists.', components: [] }).catch(() => {});
    if (!canManageTribe(interaction, proposer)) return interaction.update({ content: `Only ${tribes.leaderTitle(proposer)} or staff can do that.`, components: [] });
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
    if (!canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
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
    if (!canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
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
    if (!canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
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
    if (!canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
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
    if (!canManageTribe(interaction, tribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can do that.`, flags: MessageFlags.Ephemeral });
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
    if (!canManageTribe(interaction, tribe))
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
    if (!canManageTribe(interaction, tribe))
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
    await executeTribeDisband(interaction.guild, tribe, interaction.user.id, '(mod-tribe leader requirement unmet)');
    return interaction.editReply({ content: `💥 **${tribe.shortName || tribe.name}** has been disbanded by <@${interaction.user.id}>. Its roles and channels are gone.`, components: [] }).catch(() => {});
  }
  // ---- Manual disband: /tribe-admin disband + the throne's Disband button (owner, 2026-08-17) ----------
  if (interaction.isButton?.() && (interaction.customId.startsWith('tribedisbandcmd_confirm:') || interaction.customId.startsWith('tribedisbandcmd_cancel:'))) {
    const [act, tribeKey] = interaction.customId.split(':');
    const t = tribes.get(tribeKey);
    if (!t) return interaction.update({ content: '_(That tribe no longer exists.)_', components: [] }).catch(() => {});
    if (!canWLAdmin(interaction)) return interaction.reply({ content: 'Only an admin (or the server owner) can decide this.', flags: MessageFlags.Ephemeral });
    if (act === 'tribedisbandcmd_cancel') return interaction.update({ content: `Cancelled — **${t.shortName || t.name}** was not disbanded.`, components: [] }).catch(() => {});
    await interaction.deferUpdate();
    await executeTribeDisband(interaction.guild, t, interaction.user.id);
    return interaction.editReply({ content: `💥 **${t.shortName || t.name}** has been disbanded by <@${interaction.user.id}>. Its roles and channels are gone.`, components: [] }).catch(() => {});
  }
  if (interaction.isButton?.() && (interaction.customId.startsWith('tribedisbandreq_start:') || interaction.customId.startsWith('tribedisbandreq_cancel:'))) {
    const [act, tribeKey] = interaction.customId.split(':');
    const t = tribes.get(tribeKey);
    if (!t) return interaction.update({ content: '_(That tribe no longer exists.)_', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, t)) return interaction.reply({ content: `Only **${t.shortName || t.name}**’s ${tribes.leaderTitle(t)} can do this.`, flags: MessageFlags.Ephemeral });
    if (act === 'tribedisbandreq_cancel') return interaction.update({ content: `Cancelled — no disband request was started for **${t.shortName || t.name}**.`, components: [] }).catch(() => {});
    await interaction.deferUpdate();
    const req = tribes.startDisbandRequest(t.key, interaction.user.id);
    if (disbandFullyAgreed(interaction.guild, t, req)) {   // single-leader tribe — the initiator IS every leader
      await interaction.editReply({ content: `💥 You’re **${t.shortName || t.name}**’s only leader — disbanding now...`, components: [] }).catch(() => {});
      tribes.clearDisbandRequest(t.key);
      await executeTribeDisband(interaction.guild, t, interaction.user.id, '(sole leader agreed)');
      return interaction.editReply(`💥 **${t.shortName || t.name}** has been disbanded. Its roles and channels are gone.`);
    }
    const postCh = t.throneId ? await interaction.guild.channels.fetch(t.throneId).catch(() => null) : null;
    const posted = postCh ? await postCh.send({ content: disbandRequestContent(interaction.guild, t, req), components: [disbandAgreeRow(t.key)] }).catch(() => null) : null;
    if (posted) tribes.setDisbandMessage(t.key, posted.channel.id, posted.id);
    return interaction.editReply({ content: `💥 Disband request posted${posted ? ` in <#${posted.channelId}>` : ''}. Waiting on the rest of **${t.shortName || t.name}**’s leaders.`, components: [] }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribedisband_agree:')) {
    const tribeKey = interaction.customId.split(':')[1];
    const t = tribes.get(tribeKey);
    if (!t) return interaction.update({ content: '_(That tribe no longer exists.)_', components: [] }).catch(() => {});
    if (!tribes.isLeader(interaction.member, t)) return interaction.reply({ content: `Only one of **${t.shortName || t.name}**’s leaders can agree to this.`, flags: MessageFlags.Ephemeral });
    const req = tribes.getDisbandRequest(t.key);
    if (!req) return interaction.update({ content: '_(This disband request is no longer active.)_', components: [] }).catch(() => {});
    const updated = tribes.agreeToDisband(t.key, interaction.user.id) || req;   // already-agreed clicker just re-renders
    if (disbandFullyAgreed(interaction.guild, t, updated)) {
      await interaction.update({ content: `💥 All leaders agreed — disbanding **${t.shortName || t.name}** now...`, components: [] }).catch(() => {});
      tribes.clearDisbandRequest(t.key);
      await executeTribeDisband(interaction.guild, t, interaction.user.id, '(all leaders agreed)');
      return interaction.editReply(`💥 **${t.shortName || t.name}** has been disbanded — all leaders agreed.`).catch(() => {});
    }
    return interaction.update({ content: disbandRequestContent(interaction.guild, t, updated), components: [disbandAgreeRow(t.key)] }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('tribeshop_teardown:')) {
    const [, tribeKey, unlockKey] = interaction.customId.split(':');
    const tribe = tribes.get(tribeKey);
    if (!tribe) return interaction.reply({ content: 'That tribe no longer exists.', flags: MessageFlags.Ephemeral });
    if (!canManageTribe(interaction, tribe))
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
    const needed = Math.max(0, config.modFoundingCosignsRequired ?? 2);
    const need = Math.max(0, needed - updated.cosigns.length);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribefound_cosign:${founderId}`).setLabel('✅ Co-sign').setStyle(ButtonStyle.Success));
    await interaction.update({ content: `## 🏴 Tribe founding request\n> <@${founderId}> wants to found a tribe. Co-signed by ${updated.cosigns.map(id => `<@${id}>`).join(', ')}.\n${need > 0 ? `-# Needs **${need} more** mod${need === 1 ? '' : 's'} to co-sign.` : `-# ✅ **${needed + 1} mods reached** (founder + ${needed} co-sign${needed === 1 ? '' : 's'}). <@${founderId}> can now run \`/tribe-admin create\` again to continue.`}`, components: need > 0 ? [row] : [], allowedMentions: { users: [founderId, ...updated.cosigns] } });
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
    if (attacker && !canManageTribe(interaction, attacker)) return interaction.reply({ content: `Only ${attacker ? tribes.leaderTitle(attacker) : 'a leader'} or staff can cancel this vote.`, flags: MessageFlags.Ephemeral });
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
    if (!canManageTribe(interaction, defender)) return interaction.reply({ content: `Only ${tribes.leaderTitle(defender)} or staff can answer this.`, flags: MessageFlags.Ephemeral });
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
    if (proposer && !canManageTribe(interaction, proposer)) return interaction.reply({ content: `Only ${proposer ? tribes.leaderTitle(proposer) : 'a leader'} or staff can cancel this vote.`, flags: MessageFlags.Ephemeral });
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
  if (interaction.isButton?.() && /^pg:\d+$/.test(interaction.customId)) {
    return pgAnswer(interaction).catch(e => { console.error('[proving] answer:', e.message); return interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {}); });
  }
  if (interaction.isButton?.() && interaction.customId === 'pgpz_open') {
    return pgPuzzleOpen(interaction).catch(e => { console.error('[proving] puzzle open:', e.message); return interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {}); });
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('sealedans:')) {
    const [, tribeKey, qNumStr, optStr] = interaction.customId.split(':');
    const a = sealed.get();
    if (!a || a.mode !== 'sealed' || a.kind !== 'button') return interaction.reply({ content: 'That round is over.', flags: MessageFlags.Ephemeral });
    const th = sealed.throne(tribeKey);
    if (!th || th.qNum !== Number(qNumStr)) return interaction.reply({ content: 'That round is over.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine || mine.key !== tribeKey) return interaction.reply({ content: 'You can only answer for your own tribe, in your own throne.', flags: MessageFlags.Ephemeral });
    if ((th.perQ || []).includes(interaction.user.id)) return interaction.reply({ content: 'You already answered this one.', flags: MessageFlags.Ephemeral });
    sealed.updateThrone(tribeKey, { perQ: [...(th.perQ || []), interaction.user.id] });
    const correct = Number(optStr) === a.items[th.qNum].answer;
    if (!correct) return interaction.reply({ content: '❌ Not quite.', flags: MessageFlags.Ephemeral });
    const counted = sealedTryScore(tribeKey, interaction.user.id, interaction.createdTimestamp, true);
    return interaction.reply({ content: counted ? '✅ Correct, and first! Points banked for your tribe.' : '✅ Correct, but your tribe already scored this round.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('trialans:')) {
    const [, tribeKey, qNumStr, optStr] = interaction.customId.split(':');
    const a = sealed.get();
    if (!a || a.mode !== 'trial') return interaction.reply({ content: 'The Trial is over.', flags: MessageFlags.Ephemeral });
    const th = sealed.throne(tribeKey);
    if (!th || th.done || th.qNum !== Number(qNumStr)) return interaction.reply({ content: 'That question already moved on.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine || mine.key !== tribeKey) return interaction.reply({ content: 'Answer in your own tribe’s throne.', flags: MessageFlags.Ephemeral });
    if ((th.perQ || []).includes(interaction.user.id)) return interaction.reply({ content: 'You already tried this one, let a tribemate take it.', flags: MessageFlags.Ephemeral });
    sealed.updateThrone(tribeKey, { perQ: [...(th.perQ || []), interaction.user.id] });
    if (Number(optStr) !== a.items[th.qNum].answer) return interaction.reply({ content: '❌ Not quite, someone else try.', flags: MessageFlags.Ephemeral });
    // Relay: a correct answer from a DIFFERENT member than the last scores double (rotation bonus). It's a bonus,
    // never a gate — the same member can still answer for base points, so a small tribe is never softlocked.
    const rotated = a.game === 'relay' && th.lastUid && th.lastUid !== interaction.user.id;
    const pts = rotated ? RELAY_ROTATE_PTS : 1;
    sealed.scoreThrone(tribeKey, interaction.user.id, pts);         // +1 correct, +pts score, credit the contributor
    sealed.updateThrone(tribeKey, { qNum: th.qNum + 1, lastUid: interaction.user.id });   // this throne advances independently
    await interaction.update({ components: [] }).catch(() => {});
    await trialPost(interaction.guild, tribeKey);
    return interaction.followUp({ content: rotated ? '✅🔗 Correct — rotation bonus, double points!' : '✅ Correct! On to the next.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('mosaictile:')) {
    const [, tribeKey, iStr] = interaction.customId.split(':');
    const a = sealed.get();
    if (!a || a.mode !== 'trial' || a.game !== 'mosaic') return interaction.reply({ content: 'The Mosaic is over.', flags: MessageFlags.Ephemeral });
    const th = sealed.throne(tribeKey);
    if (!th || th.done || th.phraseSolved) return interaction.reply({ content: 'This Mosaic already wrapped up.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine || mine.key !== tribeKey) return interaction.reply({ content: 'Work your own tribe’s Mosaic.', flags: MessageFlags.Ephemeral });
    const i = Number(iStr);
    if (th.solved[i]) return interaction.reply({ content: 'That tile is already solved.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`mosaicans:${tribeKey}:${i}`).setTitle('Unscramble the tile');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('w').setLabel(`Unscramble: ${th.tiles[i].scrambled}`.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(true)));
    return interaction.showModal(modal);
  }
  if (interaction.isButton?.() && interaction.customId.startsWith('mosaicphrase:')) {
    const [, tribeKey] = interaction.customId.split(':');
    const a = sealed.get();
    if (!a || a.mode !== 'trial' || a.game !== 'mosaic') return interaction.reply({ content: 'The Mosaic is over.', flags: MessageFlags.Ephemeral });
    const th = sealed.throne(tribeKey);
    if (!th || th.done || th.phraseSolved) return interaction.reply({ content: 'This Mosaic already wrapped up.', flags: MessageFlags.Ephemeral });
    const mine = tribes.memberTribe(interaction.member);
    if (!mine || mine.key !== tribeKey) return interaction.reply({ content: 'Work your own tribe’s Mosaic.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`mosaicphrasesub:${tribeKey}`).setTitle('Solve the phrase');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p').setLabel('Enter the full hidden phrase').setStyle(TextInputStyle.Paragraph).setRequired(true)));
    return interaction.showModal(modal);
  }
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
    if (!canManageTribe(interaction, target)) return interaction.reply({ content: `Only ${tribes.leaderTitle(target)} or staff can decide this.`, flags: MessageFlags.Ephemeral });
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
    if (target && !canManageTribe(interaction, target)) return interaction.reply({ content: `Only ${tribes.leaderTitle(target)} or staff can decide this.`, flags: MessageFlags.Ephemeral });
    tribes.resolveAllianceVoteRecord(voteId, { status: 'failed', resolvedAt: Date.now() });
    return interaction.update({ content: `❌ Alliance declined by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
  // Public member hub (from /dashboard and the pinned panel). Action buttons DO the thing: open a modal
  // to collect text, then hand it to the module. Info buttons show an ephemeral view. All ephemeral.
  if (interaction.isButton?.() && interaction.customId.startsWith('pub')) {
    const cid = interaction.customId;
    const verifiedGate = () => !isVerifiedOrStaff(interaction);
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
    if (cid === 'pubact_whistleblow') {
      if (verifiedGate()) return interaction.reply({ content: 'You need to be verified first.', flags: MessageFlags.Ephemeral });
      if (!whistleblow.isConfigured()) return interaction.reply({ content: copy.whistleblow.notSetup, flags: MessageFlags.Ephemeral });
      return interaction.reply({ ...pubdash.whistleblowPicker(), flags: MessageFlags.Ephemeral });
    }
    if (cid.startsWith('pubact_wb_to:')) {
      const choice = cid.split(':')[1];
      return interaction.showModal(pubdash.whistleblowModal(choice));
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
      if (interaction.customId === 'pubmodal_report') { const r = await reports.submit(interaction.guild, interaction.member, null, text); return interaction.editReply(r.ok ? `✅ Opened **Report #${r.num}** → <#${r.threadId}>. Staff can see it there; head over to add anything else.` : `❌ ${r.msg}`); }
      if (interaction.customId.startsWith('pubmodal_whistleblow:')) {
        const choice = interaction.customId.split(':')[1];
        const r = await whistleblow.submit(interaction.guild, interaction.member, text, choice);
        return interaction.editReply(r.ok
          ? `✅ Sent **Whistleblow #${r.num}**, delivered privately by DM. You chose: **${whistleblow.CHOICES[r.choice]}**.${r.choice === 'anonymous' ? ' No identity was stored. This can never be traced to you.' : ''}`
          : `❌ ${r.msg}`);
      }
    } catch (e) { console.error('[pubdash modal]', e.message); return interaction.editReply('Could not do that. Try the slash command instead.').catch(() => {}); }
  }
  if (interaction.isButton?.()) {
    const id = interaction.customId || '';
    try {
      if (id.startsWith('vpanel_')) return await handleVerifyButton(interaction);
      if (raidguard.isAuthorizeButton(interaction)) return await raidguard.handleAuthorizeButton(interaction);
      // #roles pickers (roleselect.js) — generic multi-toggle (regions/notifications/pronouns/misc):
      // add if missing, remove if present. Same mechanic the old Carl-bot reactions had, just bot-owned.
      if (id.startsWith('roleselect_toggle:')) {
        const roleId = id.split(':')[1];
        const has = interaction.member.roles.cache.has(roleId);
        try { if (has) await interaction.member.roles.remove(roleId, 'Role picker toggle'); else await interaction.member.roles.add(roleId, 'Role picker toggle'); }
        catch (e) { return interaction.reply({ content: `Couldn’t update that: ${e.message}`, flags: MessageFlags.Ephemeral }); }
        return interaction.reply({ content: `${has ? '➖ Removed' : '➕ Added'} <@&${roleId}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      // Replaces the old "Others (ask)" toggle role — opens a modal so the member says exactly what role
      // they're after, instead of just flipping on a generic "ask me" flag (owner, 2026-08-13).
      if (id === 'roleselect_askrole') {
        const modal = new ModalBuilder().setCustomId('roleselect_askrole_modal').setTitle('Ask for a role').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('what').setLabel('What role are you looking for?').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true)));
        return safeShowModal(interaction, modal);
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
      if (id.startsWith('eventorgapp_')) {
        // Owner, 2026-08-17: staff vote (advisory), admin+ makes the actual call — lower stakes than mod
        // applications (no moderation power granted), so this doesn't need mod-apps' server-owner-only gate.
        if (id === 'eventorgapp_accept' || id === 'eventorgapp_deny' || id === 'eventorgapp_undo') {
          if (!['admin', 'owner', 'botowner'].includes(opspanel.tierOf(interaction)))
            return interaction.reply({ content: `Only admins can ${id === 'eventorgapp_undo' ? 'undo' : 'accept or deny'} Event Organizer applications.`, flags: MessageFlags.Ephemeral });
        }
        if ((id === 'eventorgapp_up' || id === 'eventorgapp_down') && !eventorgapps.canVote(interaction.member))
          return interaction.reply({ content: 'Only staff or a current Event Organizer can vote on these.', flags: MessageFlags.Ephemeral });
        return await eventorgapps.handleButton(interaction, config);
      }
      if (id === 'rep_close' || id === 'rep_reopen') {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can close or reopen a report.', flags: MessageFlags.Ephemeral });
        return await reports.handleButton(interaction);
      }
      if (id === 'sb_close' || id === 'sb_reopen' || id === 'sb_add') {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage a sidebar.', flags: MessageFlags.Ephemeral });
        return await sidebar.handleButton(interaction);
      }
      // Corner jail thread's ➕ — same picker as a sidebar's, but adds straight to THIS thread (a jail
      // thread isn't tracked in sidebar's state, so it can't go through sidebar.addPeople).
      if (id === 'cornerthread_add') {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can add someone here.', flags: MessageFlags.Ephemeral });
        const menu = new UserSelectMenuBuilder().setCustomId('cornerthread_addpick').setPlaceholder('Who else should be in here?').setMinValues(1).setMaxValues(10);
        return interaction.reply({ content: '➕ Pick who to pull into this thread:', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
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
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Block this GIF') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage media filters.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    const link = mediafilter.findGifLink(target.content);
    if (link) {
      const r = mediafilter.addGif(state, link, null, interaction.user.id);
      await logCorner(interaction.guild, { emoji: '🧹', title: r.updated ? 'GIF BLOCK UPDATED' : 'GIF BLOCKED', color: CORNER_AMBER,
        desc: `Auto-deleting \`${r.entry.key}\` (from a message by <@${target.author.id}>).\n**By:** <@${interaction.user.id}>` }).catch(() => {});
      return interaction.reply({ content: `🧹 ${r.updated ? 'Updated' : 'Now blocking'} that GIF link.`, flags: MessageFlags.Ephemeral });
    }
    const gifAtt = [...(target.attachments?.values() || [])].find(mediafilter.isGifAttachment);
    if (!gifAtt) return interaction.reply({ content: "Couldn't find a GIF link or file in that message.", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let res; try { res = await mediafilter.hashUrl(gifAtt.url, gifAtt.name); } catch (e) { return interaction.editReply(`Failed to fetch that file: ${e.message}`); }
    const r = mediafilter.addHash(state, res.hash, null, interaction.user.id, gifAtt.name, res.dhash);
    await logCorner(interaction.guild, { emoji: '🧹', title: r.updated ? 'GIF BLOCK UPDATED' : 'GIF BLOCKED', color: CORNER_AMBER,
      desc: `Auto-deleting the GIF file \`${gifAtt.name}\` (from a message by <@${target.author.id}>) by content hash — a rename won't dodge it.\n**By:** <@${interaction.user.id}>` }).catch(() => {});
    return interaction.editReply(`🧹 ${r.updated ? 'Updated' : 'Now blocking'} that GIF file (matched by content, so a rename won't dodge it).`);
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Block this attachment') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage media filters.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    const atts = [...(target.attachments?.values() || [])];
    if (!atts.length) return interaction.reply({ content: "That message has no attachments.", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const blocked = [];
    for (const att of atts) {
      let res; try { res = await mediafilter.hashUrl(att.url, att.name); } catch (e) { console.error('[mediafilter] hash:', e.message); continue; }
      mediafilter.addHash(state, res.hash, null, interaction.user.id, att.name, res.dhash);
      blocked.push(att.name);
    }
    if (!blocked.length) return interaction.editReply('Failed to fetch any of that message\'s attachments.');
    await logCorner(interaction.guild, { emoji: '🧹', title: `ATTACHMENT${blocked.length > 1 ? 'S' : ''} BLOCKED`, color: CORNER_AMBER,
      desc: `Auto-deleting ${blocked.map(n => `\`${n}\``).join(', ')} (from a message by <@${target.author.id}>) by content hash — a rename won't dodge it.\n**By:** <@${interaction.user.id}>` }).catch(() => {});
    return interaction.editReply(`🧹 Now blocking **${blocked.length}** attachment(s) (matched by content, so a rename won't dodge them): ${blocked.map(n => `\`${n}\``).join(', ')}.`);
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Report') {
    // Member-facing: right-click a message → Apps → Report → anonymous report to staff (works anywhere).
    if (!isVerifiedOrStaff(interaction))
      return interaction.reply({ content: 'You need to be verified to report.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't report a bot's message.", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = `Reported message: "${(target.content || '[no text, see link]').slice(0, 400)}" · ${target.url}`;
    const r = await reports.submit(interaction.guild, interaction.member, target.author, text);
    return interaction.editReply(r.ok ? `✅ Opened **Report #${r.num}** → <#${r.threadId}>. They won’t know it was you; staff can see it there.` : `❌ ${r.msg}`);
  }
  if (interaction.isUserContextMenuCommand?.() && interaction.commandName === 'Sidebar') {
    // Staff-facing: right-click a member → Apps → Sidebar → pull them into a private chat thread. No rule
    // picker (this isn't punishment) — straight to an optional-reason modal.
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can open a sidebar.', flags: MessageFlags.Ephemeral });
    const target = interaction.targetUser;
    if (target.id === interaction.user.id) return interaction.reply({ content: "You can't sidebar yourself.", flags: MessageFlags.Ephemeral });
    if (target.bot) return interaction.reply({ content: "Can't sidebar a bot.", flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`sidebar_reason_modal:${target.id}`).setTitle(`Sidebar: ${target.username}`.slice(0, 45)).addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('What about? (optional, they’ll see this)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
    return interaction.showModal(modal);
  }
  if (interaction.isUserContextMenuCommand?.() && interaction.commandName === 'Ban') {
    // Fastest possible path (owner, 2026-08-12: "there's no way to ban someone immediately through the
    // bot") — right-click a member, type an optional reason, done. Gated at the Discord permission level
    // (Ban Members) via the command's setDefaultMemberPermissions; no extra tier check needed here.
    const target = interaction.targetUser;
    if (target.id === interaction.user.id) return interaction.reply({ content: "You can't ban yourself.", flags: MessageFlags.Ephemeral });
    if (target.id === client.user.id) return interaction.reply({ content: "I'm not banning myself.", flags: MessageFlags.Ephemeral });
    // Rule picker shown BEFORE the reason modal (a modal can't hold a dropdown) — same ruleRow() helper
    // and two-step flow as Send-to-corner / Strike, so this behaves the same way staff already expect.
    return interaction.reply({ content: `Which rule did **${target.tag}** break?`, components: [ruleRow(`ban_rule_pick:${target.id}`)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === 'Send to corner') {
    // Same access + tier rules as /corner, but the trigger is a specific message — and that message
    // gets forwarded into the corner so the member (and mods) see exactly what put them there.
    const isMod = !!opspanel.tierOf(interaction);   // any staff tier (mod/admin/owner incl Admin-perm/bot owner)
    // Verified-member path (FUBU 'memberCorner'): no rule picker, no reason — corner the message's author
    // directly for the member max duration, non-staff only, subject to the daily cap. Runs before the
    // staff/mini-mod gate so a plain member never sees the rule dropdown.
    if (!isMod && !miniModCanActOn(interaction, interaction.targetMessage?.channelId) && isMemberCorner(interaction)) {
      const tmsg = interaction.targetMessage;
      if (!tmsg) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
      if (tmsg.author?.bot || tmsg.author.id === client.user.id) return interaction.reply({ content: 'You can’t corner a bot.', flags: MessageFlags.Ephemeral });
      if (tmsg.author.id === interaction.guild.ownerId) return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
      if (tmsg.author.id === interaction.user.id) return interaction.reply({ content: 'You can’t corner yourself.', flags: MessageFlags.Ephemeral });
      const tm = await interaction.guild.members.fetch(tmsg.author.id).catch(() => null);
      if (!tm) return interaction.reply({ content: 'They’re not in the server anymore.', flags: MessageFlags.Ephemeral });
      if (opspanel.memberTier(tm) || (config.trialModRoleId && tm.roles.cache.has(config.trialModRoleId)))
        return interaction.reply({ content: 'You can’t corner staff.', flags: MessageFlags.Ephemeral });
      return doMemberCorner(interaction, tm, config.memberCornerMaxMs);
    }
    // Same "tell them plainly it's off" as /corner, for a verified member who'd otherwise qualify.
    if (!isMod && !miniModCanActOn(interaction, interaction.targetMessage?.channelId) && isMemberCornerEligibleRole(interaction))
      return interaction.reply({ content: '🚫 Member cornering is currently **turned off**. Only staff can use this right now.', flags: MessageFlags.Ephemeral });
    if (!isMod && !miniModCanActOn(interaction, interaction.targetMessage?.channelId)) return interaction.reply({ content: copy.guards.modRoleOnly, flags: MessageFlags.Ephemeral });
    const target = interaction.targetMessage;
    if (!target) return interaction.reply({ content: copy.guards.cantReadMessage, flags: MessageFlags.Ephemeral });
    if (target.author?.bot) return interaction.reply({ content: "Can't corner a bot.", flags: MessageFlags.Ephemeral });
    if (target.author.id === client.user.id) return interaction.reply({ content: 'I can’t corner myself.', flags: MessageFlags.Ephemeral });
    if (target.author.id === interaction.guild.ownerId) return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
    // An active hit-squad member never sees the rule picker at all — this route ends in the reason modal,
    // and a squad corner must carry neither (owner, 2026-08-20). Applies even to a mod who happens to be
    // on the squad: for the ~10 minutes the window is live they're acting as squad, and letting a rule
    // through here would feed the corner→strike repeat count. They can still corner via `/corner`.
    if (hitsquad.isSquadMember(interaction.user.id))
      return interaction.reply({ content: '🔪 While you’re on the hit squad, corners carry no **rule or reason** (they don’t count toward anyone’s strike record). Use `/corner` — just pick who.', flags: MessageFlags.Ephemeral });
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
  if (name === 'corner-status') {
    // Fixes the bulk-corner flaw (owner, 2026-08-19): joke/real is decided per-target purely by "is this
    // target staff," with no way to correct a mis-classification after the fact — a serious corner on a
    // mod bundled into a batch silently loses its tier-lock protection, or a joke corner sweeping in a
    // regular member leaves them stuck with the full real lock. mod+ only, not Trial Mods (owner: "they're
    // the only ones who should have this ability anyway") — marking "joke" waives a protection Trial Mods
    // don't have the authority to waive themselves via a normal release.
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can change a corner’s joke/real status.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targetUser = interaction.options.getUser('user');
    const wantStatus = interaction.options.getString('status');
    const wantJoke = wantStatus === 'joke';
    const alsoStr = interaction.options.getString('also');
    // Mirrors /corner's own `also` — same regex, same dedup-by-Set pattern (matches mentions and raw
    // pasted IDs alike, since a mention's digits satisfy \d{15,} same as a plain ID).
    const ids = [targetUser.id, ...new Set(alsoStr ? (alsoStr.match(/\d{15,}/g) || []) : [])];
    const changed = [], already = [], notCornered = [], denied = [];
    for (const id of new Set(ids)) {
      const rec = state.getCornered(id);
      if (!rec) { notCornered.push(id); continue; }
      if (!!rec.joke === wantJoke) { already.push(id); continue; }
      // Marking "joke" is equivalent in severity to releasing them solo — it waives the SAME tier-lock
      // protection for everyone else too — so it needs the SAME authority a solo release would (same check
      // canActSolo already gates release/lowering with), not just plain mod access. Tightening to "real"
      // only ever ADDS protection, so any mod+ can do that freely.
      if (wantJoke) {
        const targetMember = await interaction.guild.members.fetch(id).catch(() => null);
        const actorTier = effectiveTierOf(interaction, targetMember);
        if (!corner.canActSolo(rec, interaction.user.id, actorTier)) { denied.push(id); continue; }
      }
      corner.setJoke(state, id, wantJoke);
      changed.push(id);
    }
    if (changed.length) {
      await logCorner(interaction.guild, { emoji: wantJoke ? '😂' : '🔒', title: wantJoke ? `MARKED AS JOKE (×${changed.length})` : `MARKED AS REAL (×${changed.length})`, color: wantJoke ? CORNER_AMBER : CORNER_RED,
        desc: `${changed.map(id => `<@${id}>`).join(', ')}: manually marked **${wantStatus}**.\n**By:** <@${interaction.user.id}>` });
    }
    const lines = [];
    if (changed.length) lines.push(`${wantJoke ? '😂' : '🔒'} Marked **${changed.length}** as **${wantStatus}**: ${changed.map(id => `<@${id}>`).join(', ')}`);
    if (already.length) lines.push(`ℹ️ Already **${wantStatus}**: ${already.map(id => `<@${id}>`).join(', ')}`);
    if (denied.length) lines.push(`🔒 Can't mark as joke (held at a higher tier, same gate as a solo release): ${denied.map(id => `<@${id}>`).join(', ')}`);
    if (notCornered.length) lines.push(`❓ Not currently in the corner: ${notCornered.map(id => `<@${id}>`).join(', ')}`);
    return interaction.editReply({ content: lines.join('\n') || 'Nobody to change.', allowedMentions: { parse: [] } });
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
  if (name === 'mediafilter') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can manage media filters.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const gifs = mediafilter.blockedGifs(state);
      const hashes = mediafilter.blockedHashes(state);
      if (!gifs.length && !hashes.length) return interaction.reply({ content: 'No active media filters.', flags: MessageFlags.Ephemeral });
      const lines = [];
      if (gifs.length) lines.push('**Specific GIF links:**', ...gifs.map(e => `• \`${e.key}\` · ${e.expiresAt ? `expires <t:${Math.floor(e.expiresAt / 1000)}:R>` : 'no expiry'} · deleted **${e.count || 0}** · by <@${e.byId}>`));
      if (hashes.length) lines.push('**Specific attachments:**', ...hashes.map(e => `• ${e.name ? `\`${e.name}\` ` : ''}(\`${e.hash.slice(0, 12)}…\`) · ${e.expiresAt ? `expires <t:${Math.floor(e.expiresAt / 1000)}:R>` : 'no expiry'} · deleted **${e.count || 0}** · by <@${e.byId}>`));
      // A long block list blew past Discord's 2000-char plain-content cap (raw DiscordAPIError, no reply
      // ever sent — this was the actual "list doesn't work" bug). An embed gives 4096 for its description;
      // still truncate defensively so even that can never overflow.
      let body = lines.join('\n');
      let truncated = false;
      if (body.length > 3900) { body = body.slice(0, 3900); truncated = true; }
      const emb = new EmbedBuilder().setColor(0xE7AC4E).setTitle('🧹 Active media filters')
        .setDescription(body + (truncated ? '\n_…truncated, too many entries to show at once._' : ''));
      return interaction.reply({ embeds: [emb], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'add-gif') {
      const url = (interaction.options.getString('url') || '').trim();
      const durStr = (interaction.options.getString('duration') || '').trim();
      let durationMs = null;
      if (durStr) { durationMs = corner.parseDuration(durStr); if (!durationMs) return interaction.reply({ content: 'Bad duration. Use e.g. `30m`, `2h`, `3d` (or leave it blank for no expiry).', flags: MessageFlags.Ephemeral }); }
      const r = mediafilter.addGif(state, url, durationMs, interaction.user.id);
      if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, flags: MessageFlags.Ephemeral });
      const until = r.entry.expiresAt ? `until <t:${Math.floor(r.entry.expiresAt / 1000)}:f>` : 'until removed (no expiry)';
      await logCorner(interaction.guild, { emoji: '🧹', title: r.updated ? 'GIF BLOCK UPDATED' : 'GIF BLOCKED', color: CORNER_AMBER,
        desc: `Auto-deleting \`${r.entry.key}\` ${until}.\n**By:** <@${interaction.user.id}>` }).catch(() => {});
      return interaction.reply({ content: `🧹 ${r.updated ? 'Updated' : 'Now blocking'} that GIF link ${until}.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'remove-gif') {
      const url = (interaction.options.getString('url') || '').trim();
      const r = mediafilter.removeGif(state, url);
      if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `✅ Unblocked that GIF link, it deleted **${r.removed.count || 0}** message(s).`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'remove-hash') {
      const hash = (interaction.options.getString('hash') || '').trim();
      const r = mediafilter.removeHash(state, hash);
      if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `✅ Unblocked that attachment, it deleted **${r.removed.count || 0}** message(s).`, flags: MessageFlags.Ephemeral });
    }
  }
  if (name === 'pending') {
    if (!modClicked(interaction) && !isTrialMod(interaction)) return interaction.reply({ content: 'Only staff can use this.', flags: MessageFlags.Ephemeral });
    try { return await interaction.reply({ ...(await renderPending(0)), flags: MessageFlags.Ephemeral }); }
    catch (e) { console.error(`[pending] ${e.message}`); return; }
  }
  if (name === 'panel') {
    try {
      const panelTier = opspanel.tierOf(interaction);
      // Event organizers who hold NO other staff-floor role get the EVENT dashboard instead of the mod-only
      // ops panel — keyed off the underlying roles directly (not tierOf/meets) since 'staff' now covers
      // trial mod/mini-mod/event-organizer uniformly and tierOf() alone can't tell "only an event organizer"
      // apart from any of the others; isTrialMod/isAnyMiniMod excluded explicitly, matching the exact
      // condition this had before 'staff' existed as a tierOf() value.
      if (features.enabled('contest') && !opspanel.meets(panelTier, 'mod') && !isTrialMod(interaction) && !isAnyMiniMod(interaction)
          && interaction.member?.roles?.cache?.has('1529976148706984110'))
        return await contest.openEventPanel(interaction);
      // 'staff' floor (trial mod / mini-mod / event organizer) gets the read-only view; mod+ get the full
      // interactive panel (openPersonalPanel enforces mod+ itself too — belt and suspenders).
      if (panelTier === 'staff') return await opspanel.openReadOnly(interaction);
      return await opspanel.openPersonalPanel(interaction);
    } catch (e) { console.error(`[fops] /panel ${e.message}`); return interaction.reply({ content: 'Could not open the panel.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'ban') {
    const target = interaction.options.getUser('user');
    if (target.id === interaction.user.id) return interaction.reply({ content: "You can't ban yourself.", flags: MessageFlags.Ephemeral });
    if (target.id === client.user.id) return interaction.reply({ content: "I'm not banning myself.", flags: MessageFlags.Ephemeral });
    const ruleN = interaction.options.getString('rule');
    const customReason = interaction.options.getString('reason');
    const reason = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${customReason ? `, ${customReason}` : ''}` : (customReason || `Banned by ${interaction.user.tag}`);
    const deleteDays = interaction.options.getInteger('delete_days') ?? 1;
    try { await interaction.guild.bans.create(target.id, { reason, deleteMessageSeconds: deleteDays * 24 * 60 * 60 }); }
    catch (e) { return interaction.reply({ content: `❌ Ban failed: ${e.message}`, flags: MessageFlags.Ephemeral }); }
    await ownerlog.log(interaction.guild, { emoji: '🔨', title: 'Banned', color: 0x992D22, detail: `${target.tag} (\`${target.id}\`) — ${reason} — by <@${interaction.user.id}>.` });
    return interaction.reply({ content: `🔨 Banned **${target.tag}**.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
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
    if (!isVerifiedOrStaff(interaction))
      return interaction.reply({ content: 'You need to be **verified** to enter the contest.', flags: MessageFlags.Ephemeral });
    try { return await contest.submit(interaction); }
    catch (e) { console.error('[contest] submit:', e.message); return interaction.reply({ content: 'Something went wrong entering the contest.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
  if (name === 'contest') {
    // Organizers (Event Organizer role holds ManageEvents), staff (mod+), and admins may manage contests.
    const canManage = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageEvents)
      || opspanel.tierOf(interaction)
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
      // Same tier hierarchy as /corner (own tier or lower, never higher) — this was missing entirely, so a
      // mod could strike an admin even though every corner path already blocks the equivalent.
      const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
      const targetTier = opspanel.memberTier(member);
      if ((RANK[targetTier] || 0) > (RANK[opspanel.tierOf(interaction)] || 0))
        return R(`You can’t strike someone of a higher staff tier than you (they’re **${targetTier}**).`);
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
      if (cornerStr) {
        cornerMs = corner.parseDuration(cornerStr); if (!cornerMs) return R('Bad corner duration. Use e.g. `30m`, `2h`, `30s`.');
        // Same tier hierarchy as every other corner entry point (/corner, "Send to corner", etc.) — this
        // one was missing it, letting a mod attach a corner to a strike on a higher-tier target. Checked
        // BEFORE the strike is recorded, so a blocked corner doesn't leave a half-applied strike.
        const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
        const targetTier = opspanel.memberTier(member);
        if ((RANK[targetTier] || 0) > (RANK[opspanel.tierOf(interaction)] || 0) && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, opspanel.tierOf(interaction)))
          return R(`You can’t corner someone of a higher staff tier than you (they’re **${targetTier}**).`);
      }
      const reasonText = ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}${reason ? `, ${reason}` : ''}` : reason;
      const res = await strikes.addStrike(interaction.guild, member, state, { weight, ruleIndex: ruleN, reason: reasonText, timeoutMs, byId: interaction.user.id, byTag: interaction.user.tag });
      let cornerNote = '';
      if (cornerMs) {
        // forceReal: a corner attached to a strike is always serious, never defaults to joke (owner,
        // 2026-08-18: "strike corner paths don't need it cause strikes are always serious").
        const cr = await corner.corner(interaction.guild, member, cornerMs, state, interaction.user.id, ruleN, opspanel.tierOf(interaction), { forceReal: true });
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
    const freshNote = freshwatch.noteFor(member);
    return interaction.reply({ content: `✅ Verified <@${user.id}> (\`${user.tag}\`).${freshNote ? `\n${freshNote}` : ''}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
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
    if (!isVerifiedOrStaff(interaction))
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
    if (!isVerifiedOrStaff(interaction))
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
    if (!isVerifiedOrStaff(interaction))
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
    if (!isVerifiedOrStaff(interaction))
      return interaction.reply({ content: 'You need to be verified before you can apply.', flags: MessageFlags.Ephemeral });
    if (!modapps.isConfigured()) return interaction.reply({ content: 'Mod applications aren’t set up on this server yet. Ask an admin to set it up in **/panel → 🧩 Setup**.', flags: MessageFlags.Ephemeral });
    // If language mini-mods are set up, ask which position first; otherwise go straight to the mod modal.
    // Owner, 2026-08-17: mini-mod and regular mod applications now open/close independently — don't turn
    // someone away here just because ONE track is closed; the position picker (and its per-track re-check
    // in modapps.js) is what actually enforces which track they land in.
    if (features.enabled('langMiniMod') && langmods.isConfigured()) {
      if (!modapps.applicationsOpen('mod') && !modapps.applicationsOpen('lang'))
        return interaction.reply({ content: modapps.closedNotice('mod'), flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: 'What are you applying for?', components: [modapps.positionRow()], flags: MessageFlags.Ephemeral });
    }
    if (!modapps.applicationsOpen('mod')) return interaction.reply({ content: modapps.closedNotice('mod'), flags: MessageFlags.Ephemeral });
    try { return await interaction.showModal(modapps.buildModal()); }
    catch (e) { console.error(`[modapps] showModal ${e.message}`); }
    return;
  }
  if (name === 'mod-applications') {
    if (!['admin', 'owner', 'botowner'].includes(opspanel.tierOf(interaction)))
      return interaction.reply({ content: 'Only admins can open or close mod applications.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const TRACK_LABEL = { mod: 'Moderator', lang: 'Mini-mod', both: 'Both tracks' };
    if (sub === 'status') {
      const modOpen = modapps.applicationsOpen('mod'), langOpen = modapps.applicationsOpen('lang');
      const line = (label, open, track) => `${open ? '✅' : '🚫'} **${label}**: ${open ? 'OPEN' : `CLOSED — ${modapps.closedNotice(track)}`}`;
      return interaction.reply({ flags: MessageFlags.Ephemeral, content:
        `${line('Moderator', modOpen, 'mod')}\n${line('Mini-mod', langOpen, 'lang')}` });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const track = interaction.options.getString('track') || 'both';
    if (sub === 'close') {
      const msg = interaction.options.getString('message');
      await modapps.setApplicationsOpen(interaction.guild, false, msg, track);
      await ownerlog.log(interaction.guild, { emoji: '🚫', title: `Mod applications CLOSED (${TRACK_LABEL[track]})`, color: 0xED4245, detail: `Closed by <@${interaction.user.id}> (team full). New \`/apply-mod\` for ${TRACK_LABEL[track]} is turned away; in-flight applications still finish.${msg ? `\nNote to applicants: ${msg}` : ''}` });
      return interaction.editReply(`🚫 **${TRACK_LABEL[track]}** mod applications are now **CLOSED**. New \`/apply-mod\` attempts for that track are turned away; applications already under review still finish. Reopen anytime with \`/mod-applications open\`.`);
    }
    if (sub === 'open') {
      await modapps.setApplicationsOpen(interaction.guild, true, null, track);
      await ownerlog.log(interaction.guild, { emoji: '✅', title: `Mod applications REOPENED (${TRACK_LABEL[track]})`, color: 0x57F287, detail: `Reopened by <@${interaction.user.id}> — members can \`/apply-mod\` for ${TRACK_LABEL[track]} again.` });
      return interaction.editReply(`✅ **${TRACK_LABEL[track]}** mod applications are now **OPEN**. Members can \`/apply-mod\` again.`);
    }
    if (sub === 'restore') {
      const user = interaction.options.getUser('user');
      const r = await modapps.restoreArchived(interaction.guild, user.id);
      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      await ownerlog.log(interaction.guild, { emoji: '🔄', title: 'Mod application restored from archive', color: 0xF1C40F,
        detail: `<@${user.id}> — restored by <@${interaction.user.id}>. Fresh vote in <#${r.reviewThreadId}>.` });
      return interaction.editReply(`🔄 Restored <@${user.id}>'s application (originally applied as ${r.track === 'lang' ? `${r.lang} Mini-Mod` : 'Moderator'}) as a **fresh** review in <#${r.reviewThreadId}> — votes reset to 0, ready to reconsider.`);
    }
    return;
  }
  if (name === 'apply-event-organizer') {
    if (!isVerifiedOrStaff(interaction))
      return interaction.reply({ content: 'You need to be verified before you can apply.', flags: MessageFlags.Ephemeral });
    if (!eventorgapps.isConfigured()) return interaction.reply({ content: 'Event Organizer applications aren’t set up on this server yet. Ask an admin to open `/panel` → 🧩 Setup → 🎪 Event Organizer apps.', flags: MessageFlags.Ephemeral });
    if (!eventorgapps.applicationsOpen()) return interaction.reply({ content: eventorgapps.closedNotice(), flags: MessageFlags.Ephemeral });
    try { return await interaction.showModal(eventorgapps.buildModal()); }
    catch (e) { console.error(`[eventorgapps] showModal ${e.message}`); }
    return;
  }
  if (name === 'event-organizer-applications') {
    if (!['admin', 'owner', 'botowner'].includes(opspanel.tierOf(interaction)))
      return interaction.reply({ content: 'Only admins can open or close Event Organizer applications.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const open = eventorgapps.applicationsOpen();
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: open
        ? '✅ Event Organizer applications are **OPEN**. Members can `/apply-event-organizer`.'
        : `🚫 Event Organizer applications are **CLOSED**.\nMembers who try to apply see:\n> ${eventorgapps.closedNotice()}` });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'close') {
      const msg = interaction.options.getString('message');
      await eventorgapps.setApplicationsOpen(interaction.guild, false, msg);
      await ownerlog.log(interaction.guild, { emoji: '🚫', title: 'Event Organizer applications CLOSED', color: 0xED4245, detail: `Closed by <@${interaction.user.id}>. New \`/apply-event-organizer\` is turned away; in-flight applications still finish.${msg ? `\nNote to applicants: ${msg}` : ''}` });
      return interaction.editReply('🚫 Event Organizer applications are now **CLOSED**. New attempts are turned away; applications already under review still finish. Reopen anytime with `/event-organizer-applications open`.');
    }
    if (sub === 'open') {
      await eventorgapps.setApplicationsOpen(interaction.guild, true);
      await ownerlog.log(interaction.guild, { emoji: '✅', title: 'Event Organizer applications REOPENED', color: 0x57F287, detail: `Reopened by <@${interaction.user.id}> — members can \`/apply-event-organizer\` again.` });
      return interaction.editReply('✅ Event Organizer applications are now **OPEN**. Members can `/apply-event-organizer` again.');
    }
    return;
  }
  if (name === 'hitsquad') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'slowmode' || sub === 'nickname') {
      if (!hitsquad.isSquadMember(interaction.user.id))
        return interaction.reply({ content: 'Only a currently-active hit squad member can do that.', flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      if (sub === 'slowmode') {
        const seconds = interaction.options.getInteger('seconds');
        const ch = interaction.channel;
        if (!ch || typeof ch.setRateLimitPerUser !== 'function') return interaction.reply({ content: 'This channel doesn’t support slowmode.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        hitsquad.recordOriginal('slowmode', ch.id, null, ch.rateLimitPerUser || 0);
        await ch.setRateLimitPerUser(seconds, `Hit squad chaos by ${interaction.user.tag}`).catch(e => console.error('[hitsquad] slowmode:', e.message));
        return interaction.editReply(`🔪 Slowmode in <#${ch.id}> set to **${seconds}s**. Reverts to **${ch.rateLimitPerUser || 0}s** when the window ends.`);
      }
      // nickname
      const target = interaction.options.getUser('user');
      const nick = interaction.options.getString('nickname');
      if (!hitsquad.isValidTarget(interaction.user.id, target.id))
        return interaction.reply({ content: 'Can’t target a fellow squad member or whoever summoned you.', flags: MessageFlags.Ephemeral });
      if (target.id === guild.ownerId) return interaction.reply({ content: 'Can’t rename the server owner.', flags: MessageFlags.Ephemeral });
      const tm = await guild.members.fetch(target.id).catch(() => null);
      if (!tm) return interaction.reply({ content: 'That member is not in the server.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      hitsquad.recordOriginal('nickname', tm.id, null, tm.nickname);
      await tm.setNickname(nick, `Hit squad chaos by ${interaction.user.tag}`).catch(e => { console.error('[hitsquad] nickname:', e.message); });
      return interaction.editReply(`🔪 <@${tm.id}> renamed to **${nick}**. Reverts to their real nickname when the window ends.`);
    }
    // activate
    if (!['admin', 'owner', 'botowner'].includes(opspanel.tierOf(interaction)))
      return interaction.reply({ content: 'Only admins can activate the hit squad.', flags: MessageFlags.Ephemeral });
    if (hitsquad.isActive()) {
      const a = hitsquad.getActive();
      return interaction.reply({ content: `🔪 The hit squad is already active, <t:${Math.floor(a.expiresAt / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
    }
    if (!hitsquad.canActivate(interaction.user.id)) {
      return interaction.reply({ content: `🔪 You've already used **${hitsquad.DAILY_CAP_PER_PERSON}/${hitsquad.DAILY_CAP_PER_PERSON}** of your activations today. Resets at midnight UTC.`, flags: MessageFlags.Ephemeral });
    }
    const raw = interaction.options.getString('members') || '';
    const ids = [...new Set(raw.match(/\d{15,}/g) || [])];
    if (!ids.length) return interaction.reply({ content: 'Mention or paste at least one member to deputize.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const guild = interaction.guild;
    const squad = [], skipped = [];
    for (const id of ids) {
      if (id === interaction.user.id) { skipped.push(`<@${id}> (you summoned them, can't also be one)`); continue; }
      if (id === guild.ownerId) { skipped.push(`<@${id}> (server owner)`); continue; }
      const m = await guild.members.fetch(id).catch(() => null);
      if (!m) { skipped.push(`\`${id}\` (not in the server)`); continue; }
      if (m.user.bot) { skipped.push(`<@${id}> (bot)`); continue; }
      squad.push(m);
    }
    if (!squad.length) return interaction.editReply(`Nobody eligible to deputize.${skipped.length ? `\nSkipped: ${skipped.join(', ')}` : ''}`);
    const role = await ensureHitSquadRole(guild).catch(e => { console.error('[hitsquad] role:', e.message); return null; });
    if (!role) return interaction.editReply('Could not create/find the Hit Squad role — check my Manage Roles permission.');
    // State FIRST, role second — enforceHitSquadRole strips the role from anyone it doesn't recognize as an
    // active squad member, so granting the role before the state exists would race its own drift-guard and
    // get immediately stripped back off.
    const active = hitsquad.activate(squad.map(m => m.id), interaction.user.id);
    for (const m of squad) await m.roles.add(role, `Hit squad activated by ${interaction.user.tag}`).catch(() => {});
    armHitSquadTimer(guild, active.expiresAt);
    const mins = Math.round(hitsquad.DURATION_MS / 60000);
    const untilTs = Math.floor(active.expiresAt / 1000);
    const briefing = `🔪 **You've been deputized to the Hit Squad by <@${interaction.user.id}>!**\n`
      + `You have **${mins} minutes** (until <t:${untilTs}:t>, <t:${untilTs}:R>) to cause chaos:\n`
      + `• \`/corner\` almost anyone — even staff — except each other, the server owner, and <@${interaction.user.id}> (who summoned you). Every corner you land auto-releases exactly when the window ends, whatever duration you set.\n`
      + `• \`/hitsquad slowmode\` — set slowmode on any channel you can see. Reverts automatically at window end.\n`
      + `• \`/hitsquad nickname\` — rename someone (same exclusions as cornering). Reverts automatically at window end.\n`
      + `• You're immune to slowmode yourself, and nobody can corner **you** until the window closes.\n`
      + `Go cause some chaos. 🔪`;
    let dmFailed = [];
    for (const m of squad) await m.send(briefing).catch(() => { dmFailed.push(m.id); });
    await ownerlog.log(guild, { emoji: '🔪', title: 'HIT SQUAD ACTIVATED', color: 0xED4245,
      detail: `${squad.map(m => `<@${m.id}>`).join(', ')} — ${mins}m window — summoned by <@${interaction.user.id}>.` });
    return interaction.editReply({
      content: `🔪 **HIT SQUAD ACTIVATED** for **${mins} minutes** (until <t:${untilTs}:t>): ${squad.map(m => `<@${m.id}>`).join(', ')}\n`
        + `They can \`/corner\` almost anyone — even staff — except each other, the owner, and <@${interaction.user.id}> (who summoned them). `
        + `Every corner they land auto-releases when the window ends, and they can't be cornered themselves until then.`
        + `${skipped.length ? `\n⚠️ Skipped: ${skipped.join(', ')}` : ''}`
        + `${dmFailed.length ? `\n📪 Couldn't DM: ${dmFailed.map(id => `<@${id}>`).join(', ')} (they'll still have full squad power, just no heads-up).` : ''}`,
      allowedMentions: { users: [...squad.map(m => m.id), interaction.user.id] },
    });
  }
  if (name === 'staff') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can view the census.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await ensureMembers(interaction.guild);
    const trialId = modapps.loadConfig().trialModRoleId;
    const eventOrgId = eventorgapps.ORGANIZER_ROLE_ID;
    const langs = langmods.languages();
    const configuredMiniModIds = new Set(langs.map(l => langmods.roleForLang(l)).filter(Boolean));
    // Mini-Mod isn't only language-scoped (owner, 2026-08-19: "mini mod is not just per language") — the
    // config keys off whatever scope was set up (LGBTQ is one, alongside e.g. French), so `langs` here just
    // means "every configured Mini-Mod entry," not literal languages. Separately: some Mini-Mod ROLES exist
    // in the server with no langmods.json entry yet (not wired to any channel, so not functionally active) —
    // list those too, so it's visible they exist and aren't configured, rather than silently invisible.
    const allRoles = await interaction.guild.roles.fetch();
    const unconfiguredMiniModRoles = [...allRoles.values()].filter(r => r && /mini-?mod/i.test(r.name) && !configuredMiniModIds.has(r.id));
    // Counted by HIGHEST tier so nobody is double-counted (higher tiers absorb the lower). memberTier
    // returns owner→admin→mod (the bot's canonical tier); Trial Mod, Event Organizer, and each Mini-Mod
    // are all "below mod" auxiliary roles — checked independently (not mutually exclusive with each other,
    // since a member can genuinely hold more than one at once) and only for people below mod, same as
    // Trial Mod already worked. These three share the same restricted /corner+/uncorner tier as of this
    // session (owner, 2026-08-19: "generalize all 3 to trial mod level") — the census should list all of
    // them, not just Trial Mod.
    const byTier = { owner: [], admin: [], mod: [], trial: [], eventOrg: [], miniMod: {}, unconfiguredMiniMod: {} };
    for (const lang of langs) byTier.miniMod[lang] = [];
    for (const r of unconfiguredMiniModRoles) byTier.unconfiguredMiniMod[r.id] = [];
    let humans = 0;
    for (const m of members.values()) {
      if (m.user.bot) continue;
      humans++;
      const t = opspanel.memberTier(m);
      if (t === 'owner') byTier.owner.push(m);
      else if (t === 'admin') byTier.admin.push(m);
      else if (t === 'mod') byTier.mod.push(m);
      else {
        if (trialId && m.roles.cache.has(trialId)) byTier.trial.push(m);
        if (eventOrgId && m.roles.cache.has(eventOrgId)) byTier.eventOrg.push(m);
        for (const lang of langs) {
          const rid = langmods.roleForLang(lang);
          if (rid && m.roles.cache.has(rid)) byTier.miniMod[lang].push(m);
        }
        for (const r of unconfiguredMiniModRoles) {
          if (m.roles.cache.has(r.id)) byTier.unconfiguredMiniMod[r.id].push(m);
        }
      }
    }
    const owner = byTier.owner.length, admin = byTier.admin.length, mod = byTier.mod.length, trial = byTier.trial.length;
    const eventOrg = byTier.eventOrg.length;
    // Unconfigured Mini-Mod roles grant no actual authority (not wired to langmods.json), so they're shown
    // separately below but deliberately excluded from this total — holding one shouldn't count as "staff".
    const miniModTotal = langs.reduce((sum, lang) => sum + byTier.miniMod[lang].length, 0);
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
    const out = `## 👥 Staff: \`${owner + admin + mod + trial + eventOrg + miniModTotal}\` total\n-# of ${humans.toLocaleString()} members · counted at their highest tier\n`
      + block(opspanel.OWNER_DISPLAY_ROLE_ID, '👑', 'Owner', byTier.owner)
      + block(opspanel.ADMIN_ROLE_ID, '🛡️', 'Admin', byTier.admin)
      + block(opspanel.MOD_ROLE_ID, '⚒️', 'Mod', byTier.mod)
      + block(trialId, '🌱', 'Trial Mod', byTier.trial)
      + block(eventOrgId, '🎪', 'Event Organizer', byTier.eventOrg)
      + langs.map(lang => block(langmods.roleForLang(lang), '🌐', `${lang} Mini-Mod`, byTier.miniMod[lang])).join('')
      + (unconfiguredMiniModRoles.length
        ? `\n\n-# ⚠️ Mini-Mod role(s) that exist but aren't wired to any channel yet — holding one grants nothing until configured via /mod-applications:`
          + unconfiguredMiniModRoles.map(r => block(r.id, '⚠️', `${r.name} (unconfigured)`, byTier.unconfiguredMiniMod[r.id])).join('')
        : '');
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
    if (!roleId) return interaction.reply({ content: 'No Trial Mod role is configured. Run `/panel` → 🧩 Setup → 📋 Mod apps first.', flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(interaction.options.getString('member')).catch(() => null);
    if (!target) return interaction.reply({ content: 'Couldn’t find that member in the server.', flags: MessageFlags.Ephemeral });
    if (!holdsRoleEffective(target, roleId)) return interaction.reply({ content: `<@${target.id}> isn’t a **Trial Mod**, so there’s nothing to remove.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason');
    const ok = await removeRoleEffective(target, roleId, `Trial Mod demoted by ${interaction.user.tag}${reason ? ` - ${reason}` : ''}`);
    return interaction.editReply(ok
      ? `✅ Removed the **Trial Mod** role from <@${target.id}>.${reason ? ` (noted: ${reason})` : ''}`
      : '❌ Couldn’t remove the role. Make sure the bot’s own role sits above **Trial Mod**.').catch(() => {});
  }
  if (name === 'demote-mod') {
    // Owner/approver only — same tier bar as demote-trial.
    const approvers = modapps.loadConfig().approvers || [];
    if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id) && !opspanel.isBotOwner(interaction))
      return interaction.reply({ content: 'Only the **server owner** can demote a mod.', flags: MessageFlags.Ephemeral });
    if (!config.modRoleId) return interaction.reply({ content: 'No Mod role is configured.', flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(interaction.options.getString('member')).catch(() => null);
    if (!target) return interaction.reply({ content: 'Couldn’t find that member in the server.', flags: MessageFlags.Ephemeral });
    if (!holdsRoleEffective(target, config.modRoleId)) return interaction.reply({ content: `<@${target.id}> isn’t a **Mod**, so there’s nothing to remove.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    // Admins/owners hold Mod via tier nesting (owner⊇admin⊇mod) — stripping it here would just get
    // auto-restored on the next role-change sweep. Point at the right command instead of silently no-op'ing.
    // opspanel.memberTier sees through a corner's role strip, so this still correctly blocks demoting a
    // cornered admin/owner's Mod via this command too.
    const targetTier = opspanel.memberTier(target);
    if (targetTier === 'admin' || targetTier === 'owner')
      return interaction.reply({ content: `<@${target.id}> holds Mod through being an **${targetTier === 'owner' ? 'Owner' : 'Admin'}** — use \`/demote-admin\` (or remove their Owner role directly) instead; removing Mod alone would just be auto-restored by tier nesting.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason');
    // Effective remove: also edits the corner snapshot if they're currently cornered, so a demote actually
    // sticks instead of being a no-op on a role they don't currently hold (owner, 2026-08-18: staff level
    // persists through the corner, but a real bot demote must still be able to change it).
    const ok = await removeRoleEffective(target, config.modRoleId, `Mod demoted by ${interaction.user.tag}${reason ? ` - ${reason}` : ''}`);
    if (!ok) return interaction.editReply('❌ Couldn’t remove the role. Make sure the bot’s own role sits above **Mod**.').catch(() => {});
    // Demoting a Mod steps them down to Trial Mod, not straight to nothing (owner, 2026-08-17: "demote
    // should make trial mod") — best-effort; a missing/unconfigured Trial Mod role just skips this part.
    const trialRoleId = modapps.loadConfig().trialModRoleId;
    let trialOk = false;
    if (trialRoleId && !holdsRoleEffective(target, trialRoleId))
      trialOk = await addRoleEffective(target, trialRoleId, `Stepped down to Trial Mod by ${interaction.user.tag}`);
    return interaction.editReply(
      `✅ Removed the **Mod** role from <@${target.id}>.${reason ? ` (noted: ${reason})` : ''}`
      + (trialRoleId ? (trialOk ? ' Stepped down to **Trial Mod**.' : ' ⚠️ Couldn’t add **Trial Mod** — check the role/hierarchy.') : ' (No Trial Mod role configured, so they weren’t stepped down to it.)')
    ).catch(() => {});
  }
  if (name === 'demote-admin') {
    // Owner/approver only — same tier bar as demote-trial.
    const approvers = modapps.loadConfig().approvers || [];
    if (interaction.user.id !== interaction.guild.ownerId && !approvers.includes(interaction.user.id) && !opspanel.isBotOwner(interaction))
      return interaction.reply({ content: 'Only the **server owner** can demote an admin.', flags: MessageFlags.Ephemeral });
    if (!config.adminRoleId) return interaction.reply({ content: 'No Admin role is configured.', flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(interaction.options.getString('member')).catch(() => null);
    if (!target) return interaction.reply({ content: 'Couldn’t find that member in the server.', flags: MessageFlags.Ephemeral });
    if (target.id === interaction.guild.ownerId) return interaction.reply({ content: 'You can’t demote the server owner.', flags: MessageFlags.Ephemeral });
    if (!holdsRoleEffective(target, config.adminRoleId)) return interaction.reply({ content: `<@${target.id}> isn’t an **Admin**, so there’s nothing to remove.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    // Owners hold Admin via tier nesting (owner⊇admin) — stripping it here would just get auto-restored.
    // opspanel.memberTier sees through a corner's role strip, so this still correctly blocks demoting a
    // cornered owner's Admin via this command too.
    const targetTier = opspanel.memberTier(target);
    if (targetTier === 'owner')
      return interaction.reply({ content: `<@${target.id}> holds Admin through an **Owner** role — remove that role directly in Discord instead; \`/demote-admin\` alone would just be auto-restored by tier nesting.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason');
    // Effective remove: also edits the corner snapshot if they're currently cornered, so a demote actually
    // sticks instead of being a no-op on a role they don't currently hold (owner, 2026-08-18: staff level
    // persists through the corner, but a real bot demote must still be able to change it).
    const ok = await removeRoleEffective(target, config.adminRoleId, `Admin demoted by ${interaction.user.tag}${reason ? ` - ${reason}` : ''}`);
    if (!ok) return interaction.editReply('❌ Couldn’t remove the role. Make sure the bot’s own role sits above **Admin**.').catch(() => {});
    // Demoting an Admin steps them down to Mod, not straight to nothing (owner, 2026-08-17: full step-down
    // ladder, same as /demote-mod → Trial Mod). They likely already hold Mod via tier-nesting (auto-granted
    // while they were Admin) — grant is idempotent either way, but nestedRoles.clear() converts it into a
    // genuine, independent grant so the NEXT tier-nesting sweep (which would otherwise see "tier no longer
    // admin, this Mod grant was only nested, strip it") doesn't immediately undo the step-down.
    let modOk = false;
    if (config.modRoleId) {
      modOk = await addRoleEffective(target, config.modRoleId, `Stepped down to Mod by ${interaction.user.tag}`);
      if (modOk) nestedRoles.clear(target.id, config.modRoleId);
    }
    return interaction.editReply(
      `✅ Removed the **Admin** role from <@${target.id}>.${reason ? ` (noted: ${reason})` : ''}`
      + (config.modRoleId ? (modOk ? ' Stepped down to **Mod**.' : ' ⚠️ Couldn’t add **Mod** — check the role/hierarchy.') : ' (No Mod role configured, so they weren’t stepped down to it.)')
    ).catch(() => {});
  }
  if (name === 'help') {
    return interaction.reply({ embeds: [helpEmbed(interaction.guild)], flags: MessageFlags.Ephemeral });
  }
  if (name === 'prove') {
    return pgStart(interaction).catch(e => { console.error('[proving] start:', e.message); return interaction.reply({ content: 'Couldn’t start the gauntlet.', flags: MessageFlags.Ephemeral }).catch(() => {}); });
  }
  if (name === 'event-award') {
    // Organizer (ManageEvents / Event Organizer role) or staff. Fuses any organizer-run event with the tribe
    // fight: place your top finishers, their tribes bank Glory + Treasury by placement (Ami's request).
    const canManage = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageEvents)
      || opspanel.tierOf(interaction) || interaction.member?.roles?.cache?.has('1529976148706984110');
    if (!canManage) return interaction.reply({ content: 'Only event organizers or staff can award event points.', flags: MessageFlags.Ephemeral });
    const AWARD = [50, 30, 10];   // Glory + Treasury to 1st / 2nd / 3rd place tribes
    const placed = [interaction.options.getMember('first'), interaction.options.getMember('second'), interaction.options.getMember('third')];
    const eventName = (interaction.options.getString('event') || 'the event').slice(0, 80);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const lines = [], announced = [], creditedTribes = new Set();
    for (let i = 0; i < placed.length; i++) {
      const m = placed[i]; if (!m) continue;
      const t = tribes.memberTribe(m);
      if (!t) { lines.push(`${['🥇', '🥈', '🥉'][i]} <@${m.id}>: no tribe, nothing to award.`); continue; }
      const amt = AWARD[i];
      tribes.addGlory(t.key, amt); tribes.addTreasury(t.key, amt);
      creditedTribes.add(t.key);
      lines.push(`${['🥇', '🥈', '🥉'][i]} <@${m.id}> → ${tribeName(t.key)}: **+${amt} Glory, +${amt} Treasury**`);
      announced.push(`${['🥇', '🥈', '🥉'][i]} ${tribeName(t.key)} (via <@${m.id}>): +${amt} Glory`);
    }
    if (!announced.length) return interaction.editReply(`No tribe points awarded, none of those members are in a tribe.\n${lines.join('\n')}`);
    for (const k of creditedTribes) { lore.record({ type: 'arena', title: `${tribes.get(k)?.shortName || k} earned points at ${eventName}`, tribes: [k] }); checkTribeQuests(interaction.guild, k).catch(() => {}); }
    // Public announcement so the tribes see the event fed their standing.
    const spec = await getSpectacleChannel(interaction.guild).catch(() => null);
    if (spec) await spec.send({ content: `# 🎉 ${eventName}: the tribes earn!\n${copy.herald.open()} <@${interaction.user.id}>'s event feeds the tribe fight:\n${announced.join('\n')}`, allowedMentions: { parse: [] } }).catch(() => {});
    return interaction.editReply(`✅ Awarded, and announced${spec ? ` in <#${spec.id}>` : ''}:\n${lines.join('\n')}`);
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
    // ---- Panel: needs to work for staff with no tribe at all (Tribe Games is cross-tribe), so it's handled
    // BEFORE the myTribe(actor) resolution below, same reasoning as found/banish. ----
    if (sub === 'panel') {
      if (!features.enabled('tribePanel')) return interaction.reply({ content: '🌒 Tribe Panel isn’t live yet — coming soon.', flags: MessageFlags.Ephemeral });
      return interaction.reply(await buildTribePanelView(interaction));
    }
    // ---- Member-founded tribe: a regular member rallies 9 cosigns to found one (dark until enabled). Handled
    // BEFORE the tribe-resolution below, because a founder isn't in a tribe yet. ----
    if (sub === 'found') {
      if (!features.enabled('memberFoundedTribe')) return interaction.reply({ content: 'Founding a tribe as a member isn’t available yet.', flags: MessageFlags.Ephemeral });
      if (!isVerifiedOrStaff(interaction)) return interaction.reply({ content: 'You need to be verified first.', flags: MessageFlags.Ephemeral });
      // mod+ explicitly (not the 'staff' floor) so a trial mod still falls through to their own message
      // below instead of getting the generic mods/admins/owners one.
      if (opspanel.meets(opspanel.tierOf(interaction), 'mod')) return interaction.reply({ content: 'This is a **member-led** tribe path — mods/admins/owners found tribes through `/tribe-admin`.', flags: MessageFlags.Ephemeral });
      if (isTrialMod(interaction)) return interaction.reply({ content: 'Trial mods can **cosign** a member-founded tribe, but the founder has to be a regular member.', flags: MessageFlags.Ephemeral });
      if (tribes.myTribe(interaction.member)) return interaction.reply({ content: 'You’re already in a tribe — leave it first before founding a new one.', flags: MessageFlags.Ephemeral });
      if (tribes.getMemberFoundedTribeKey()) return interaction.reply({ content: 'There’s already a member-founded tribe (only one is allowed at a time). It has to disband before another can be founded.', flags: MessageFlags.Ephemeral });
      if (tribes.getMemberFounding()) return interaction.reply({ content: 'A member-founded tribe petition is already open. Only one can run at a time — wait for it to finish or lapse.', flags: MessageFlags.Ephemeral });
      return safeShowModal(interaction, tribeMemberFoundModal());
    }
    // ---- Banish: staff (mod+) can banish from ANY tribe (resolved from the TARGET's tribe), so it's handled
    // BEFORE the myTribe(actor) resolution below. A leader is still scoped to the tribe they lead. ----
    if (sub === 'banish') {
      const target = interaction.options.getMember('user');
      if (!target) return interaction.reply({ content: 'Couldn’t find that member.', flags: MessageFlags.Ephemeral });
      const btier = opspanel.tierOf(interaction);
      const isOwner = btier === 'owner' || btier === 'botowner';
      // Owner can banish from ANY tribe (resolved from the target); a leader / in-tribe staff acts on their OWN tribe.
      const banishTribe = isOwner ? tribes.myTribe(target) : tribes.myTribe(interaction.member);
      if (!banishTribe) return interaction.reply({ content: isOwner ? `<@${target.id}> isn’t in any tribe.` : 'You aren’t in a tribe, so there’s nothing to manage.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      if (!canManageTribe(interaction, banishTribe)) return interaction.reply({ content: `Only ${tribes.leaderTitle(banishTribe)} of **${banishTribe.shortName || banishTribe.name}** (or its in-tribe staff / the owner) can banish from it.`, flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await submitBanish(interaction.guild, banishTribe, target, interaction.user.tag);
      return interaction.editReply(r.content);
    }
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
      if (!canManageTribe(interaction, tribe))
        return interaction.reply({ content: `Only the leader of **${tribe.shortName || tribe.name}** (or staff) can set its motto.`, flags: MessageFlags.Ephemeral });
      const text = interaction.options.getString('text');
      tribes.setMotto(tribe.key, text);
      await interaction.deferReply();
      if (config.rolesChannelId) await roleselect.refreshTribeBlock(interaction.guild, config.rolesChannelId).catch(() => {});   // the picker shows each tribe's motto — keep it in sync
      await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
      return interaction.editReply({ content: `${tribe.emoji || '🌊'} Motto set for **${tribe.shortName || tribe.name}**:\n> *${text.slice(0, 300)}*`, allowedMentions: { parse: [] } });
    }
    if (sub === 'banner') {
      if (!canManageTribe(interaction, tribe))
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
      if (!canManageTribe(interaction, tribe))
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
      if (!canManageTribe(interaction, tribe))
        return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can set the tribe icon.`, flags: MessageFlags.Ephemeral });
      if (!tribes.hasUnlock(tribe, 'icon')) return interaction.reply({ content: `**${tribe.shortName || tribe.name}** hasn’t unlocked the **Tribe Icon** yet. Check the Shop button in #tribes-hub or your throne.`, flags: MessageFlags.Ephemeral });
      const role = interaction.guild.roles.cache.get(tribe.roleId);
      if (!role) return interaction.reply({ content: 'Couldn’t find the tribe role.', flags: MessageFlags.Ephemeral });
      const image = interaction.options.getAttachment('image');
      const raw = (interaction.options.getString('emoji') || '').trim();
      if (!image && !raw) return interaction.reply({ content: 'Give an **emoji**, upload an **image**, or pass `none` to clear.', flags: MessageFlags.Ephemeral });
      // Clear
      if (!image && /^(none|clear|off)$/i.test(raw)) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await applyIconToTribeRoles(interaction.guild, tribe, { unicodeEmoji: null, icon: null }, `Tribe icon cleared by ${interaction.user.tag}`);
        await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
        return interaction.editReply(`🖼️ Cleared **${tribe.shortName || tribe.name}**’s role icons (leader, General, and ranks too).`);
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
        const { done } = await applyIconToTribeRoles(interaction.guild, tribe, { icon: buf, unicodeEmoji: null }, `Tribe icon (image) set by ${interaction.user.tag}`);
        if (!done) return interaction.editReply('Couldn’t set that image as the role icon. It may not be square, or Discord rejected it.');
        await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
        return interaction.editReply(`🖼️ Set **${tribe.shortName || tribe.name}**’s role icon (leader, General, and ranks too) to your uploaded image.`);
      }
      // Emoji path — grab the first emoji glyph.
      const m = raw.match(/\p{Extended_Pictographic}/u);
      if (!m) return interaction.reply({ content: 'Give a single emoji (e.g. 🔥), upload an image, or `none` to clear.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { done } = await applyIconToTribeRoles(interaction.guild, tribe, { unicodeEmoji: m[0], icon: null }, `Tribe icon set by ${interaction.user.tag}`);
      if (!done) return interaction.editReply('Couldn’t set that as the role icon. (Emoji may not be supported.)');
      await refreshThronePanel(interaction.guild, tribes.get(tribe.key)).catch(() => {});
      return interaction.editReply(`🖼️ Set **${tribe.shortName || tribe.name}**’s role icon (leader, General, and ranks too) to ${m[0]}.`);
    }
    if (sub === 'muster') {
      if (!canManageTribe(interaction, tribe))
        return interaction.reply({ content: `Only ${tribes.leaderTitle(tribe)} or staff can call a muster.`, flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await submitMuster(interaction.guild, tribe, interaction.user.id);
      return interaction.editReply(r.content);
    }
    // ---- Warden's tools: leaders of THIS tribe (or staff) ----
    if (wardenSub) {
      if (!canManageTribe(interaction, tribe))
        return interaction.reply({ content: `Only the leader of **${tribe.shortName || tribe.name}** (or staff) can do that.`, flags: MessageFlags.Ephemeral });
      const target = interaction.options.getMember('user');
      if (sub === 'invite') {
        // Owner, 2026-08-03: "invite should get consent" — no longer adds directly. Skips straight to the
        // accept/decline step (no separate approval needed, the leader inviting IS the approval), reusing
        // the same nomination/accept machinery as /tribe nominate. No entrance gate on this path though —
        // the leader already vouches for this person, a quiz on top would be redundant here specifically.
        if (!target) return interaction.reply({ content: 'Couldn’t find that member.', flags: MessageFlags.Ephemeral });
        if (staffBlockedFromMemberTribe(target, tribe)) return interaction.reply({ content: `**${tribe.shortName || tribe.name}** is member-founded — it stays member-only, so you can’t invite staff (mods/admins/owners).`, flags: MessageFlags.Ephemeral });
        const r = await submitInvite(interaction.guild, tribe, interaction.user.id, target);
        return interaction.reply({ content: r.content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      // (banish is handled earlier — staff can banish from any tribe — see the sub==='banish' block above)
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
    // 'create' has its own looser gate (admins, PLUS mods founding their own tribe); 'set-leader' and
    // 'disband' are gated inside their own handlers (a tribe's OWN leader can use them, not just admins —
    // disband via beginTribeDisbandFlow, same as the throne button). Every other subcommand
    // (register/points/title/ranks/grant/challenge-*) stays admin-only, unchanged.
    const modSelfFounding = sub === 'create' && opspanel.tierOf(interaction) === 'mod';
    if (!['set-leader', 'arena', 'disband'].includes(sub) && !canWLAdmin(interaction) && !modSelfFounding) return interaction.reply({ content: 'Only admins can create or register tribes.', flags: MessageFlags.Ephemeral });
    if (sub === 'hub-setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await ensureTribesHub(interaction.guild, config);
      return interaction.editReply(`🏴 Tribes Hub ${r.created ? 'created' : 'refreshed'} in <#${r.channelId}>.`);
    }
    if (sub === 'ping-all') {
      const list = tribes.all();
      if (!list.length) return interaction.reply({ content: 'There are no tribes to ping.', flags: MessageFlags.Ephemeral });
      const leadersOnly = interaction.options.getBoolean('leaders_only') || false;
      const roleIds = list.map(t => leadersOnly ? t.leaderRoleId : t.roleId).filter(Boolean);
      if (!roleIds.length) return interaction.reply({ content: leadersOnly ? 'No tribe leader roles are set.' : 'No tribe roles found.', flags: MessageFlags.Ephemeral });
      const message = interaction.options.getString('message');
      // Mentions ping even though tribe roles are non-mentionable: the bot pings via allowedMentions.roles
      // (it has Administrator). Posted as a public message in THIS channel so members actually get notified.
      const content = (message ? `${message}\n\n` : '') + roleIds.map(id => `<@&${id}>`).join(' ');
      return interaction.reply({ content, allowedMentions: { roles: roleIds } });
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
        // Owner: "if a mod wants to start a tribe it must be in a group of three" — the founder needs
        // config.modFoundingCosignsRequired OTHER mods to co-sign before the wizard unlocks. Admin-founded
        // tribes skip this entirely. FUBU keeps the default of 2; Melanin's env overrides this to 0 (owner,
        // 2026-08-16: its mod team is much smaller, so a mod there can found a tribe solo).
        // BUG FIXED 2026-08-03: this used to clearFoundingRequest() BEFORE showModal(), so if the modal call
        // ever failed (or the founder didn't finish the wizard, e.g. got rejected by the Build-step bug
        // above), the founding request was already gone with nothing to show for it — confirmed live: a
        // founder hit "3 mods reached", the request vanished, and 11 hours later they had to gather 2 FRESH
        // co-signs from scratch since /tribe-admin create just started a brand-new request. Now only cleared
        // in tribewiz_build's actual success path, so re-running this command is always safe to retry.
        const needed = Math.max(0, config.modFoundingCosignsRequired ?? 2);
        if (needed === 0) {
          wizardTouch(interaction.user.id, { leaderId: leaderMember.id });
          return safeShowModal(interaction, tribeIdentityModal());
        }
        const existing = tribes.getFoundingRequest(interaction.user.id);
        if (existing && existing.cosigns.length >= needed) {
          wizardTouch(interaction.user.id, { leaderId: leaderMember.id });
          return safeShowModal(interaction, tribeIdentityModal());
        }
        if (existing) return interaction.reply({ content: `Still waiting on co-signs: **${existing.cosigns.length}/${needed}** mods so far. Check <#${config.modAnnounceChannelId}>.`, flags: MessageFlags.Ephemeral });
        if (!config.modAnnounceChannelId) return interaction.reply({ content: 'No mod-announcements channel configured to route this through.', flags: MessageFlags.Ephemeral });
        const ch = await interaction.guild.channels.fetch(config.modAnnounceChannelId).catch(() => null);
        if (!ch) return interaction.reply({ content: 'Couldn’t find the mod-announcements channel.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        tribes.startFoundingRequest(interaction.user.id);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tribefound_cosign:${interaction.user.id}`).setLabel('✅ Co-sign').setStyle(ButtonStyle.Success));
        const msg = await ch.send({ content: `## 🏴 Tribe founding request\n> <@${interaction.user.id}> wants to found a tribe. Founding a tribe as a mod takes **${needed + 1} mods** total, needs **${needed} more** co-signs from other mods.`, components: [row], allowedMentions: { users: [interaction.user.id] } }).catch(() => null);
        if (msg) tribes.setFoundingMessage(interaction.user.id, ch.id, msg.id);
        return interaction.editReply(`🏴 Posted to <#${ch.id}>. Needs **${needed} more** mods to co-sign before you can continue. Run this command again once they have.`);
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
      lore.record({ type: 'founding', title: `${t.shortName || t.name} was founded`, tribes: [t.key] });
      return interaction.reply({ content: `## ${t.emoji} ${t.name}: registered\n-# adopted by <@${interaction.user.id}>\n> Role <@&${role.id}>${leaderRole ? ` · Leader <@&${leaderRole.id}>` : ''}${hall ? ` · Hall <#${hall.id}>` : ''}\n-# Now shows in #tribes-hub Standings and \`/tribe info ${key}\`.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'sealed-arena') {
      if (!features.enabled('sealedArena')) return interaction.reply({ content: 'The Sealed Arena isn’t enabled yet.', flags: MessageFlags.Ephemeral });
      if (!canWLAdmin(interaction) && !tribes.leaderTribe(interaction.member)) return interaction.reply({ content: 'Only a tribe leader or an admin can launch a Sealed Arena.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await startSealedArena(interaction.guild, { type: interaction.options.getString('type') || undefined, startedById: interaction.user.id });
      return interaction.editReply(r.ok ? `🚪 Sealed Arena launched (${ARENA_LABEL[r.gameType] || r.gameType}). Every tribe is racing it now in their throne; results reveal at the end.` : `Couldn’t launch it: ${r.error}`);
    }
    if (sub === 'trial') {
      // Optional staff override — Trials fire on their own; this just forces one now (e.g. for testing).
      if (!features.enabled('theTrials')) return interaction.reply({ content: 'The Trials aren’t enabled yet.', flags: MessageFlags.Ephemeral });
      if (!canWLAdmin(interaction) && !tribes.leaderTribe(interaction.member)) return interaction.reply({ content: 'Only a tribe leader or an admin can launch a Trial.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const game = interaction.options.getString('game') || TRIAL_GAMES[Math.floor(Date.now() / 86400000) % TRIAL_GAMES.length];
      const muster = !!interaction.options.getBoolean('muster');
      const r = await startTrial(interaction.guild, { startedById: interaction.user.id, game, muster });
      return interaction.editReply(r.ok ? `⚔️ ${r.muster ? 'A grand **Muster** ' : ''}${TRIAL_GAME_LABEL[r.game] || 'Trial'} launched (all tribes).${r.muster ? ' Double rewards on the line.' : ''} Rally in voice and ${r.game === 'mosaic' ? 'claim tiles' : 'answer'} together — results reveal at the end.` : `Couldn’t launch it: ${r.error}`);
    }
    if (sub === 'arena') {
      // Any tribe LEADER or an admin may start one (owner, 2026-08-04).
      if (!canWLAdmin(interaction) && !tribes.leaderTribe(interaction.member)) return interaction.reply({ content: 'Only a tribe leader or an admin can launch a challenge.', flags: MessageFlags.Ephemeral });
      { const blocked = arena.startBlocked(); if (blocked) return interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral }); }
      const type = interaction.options.getString('type');
      const minutes = interaction.options.getInteger('minutes') || ARENA_DEFAULTS[type] || 5;
      const announceCh = await ensureArenaChannel(interaction.guild, config).catch(() => null);
      await interaction.reply({ content: `🎪 Announced **${ARENA_LABEL[type] || type}** in ${announceCh ? `<#${announceCh.id}>` : 'the arena'} — it begins in **5 minutes** so everyone can gather, then runs for **${minutes} min**.`, flags: MessageFlags.Ephemeral });
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
    if (sub === 'disband') {
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      return beginTribeDisbandFlow(interaction, t);
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
    if (sub === 'enroll') {
      if (!isOwner(interaction)) return interaction.reply({ content: 'Only the owner can force-enroll — everyone else goes through invite/nominate/self-join.', flags: MessageFlags.Ephemeral });
      const t = tribes.resolve(interaction.options.getString('tribe'));
      if (!t) return interaction.reply({ content: 'No tribe matches that. Check Standings in #tribes-hub.', flags: MessageFlags.Ephemeral });
      const target = interaction.options.getMember('member');
      if (!target) return interaction.reply({ content: 'That member isn’t in the server.', flags: MessageFlags.Ephemeral });
      if (target.user.bot) return interaction.reply({ content: 'Bots can’t join tribes.', flags: MessageFlags.Ephemeral });
      const other = tribes.inAnyTribe(target);
      if (other) return interaction.reply({ content: `<@${target.id}> is already in **${other.shortName || other.name}**. A member can only be in one tribe — banish them there first.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await joinTribeSelfServe(interaction.guild, t, target, `Owner enrollment by ${interaction.user.tag} — no invite/accept/gate`);
      return interaction.editReply(r.ok ? `✅ Enrolled <@${target.id}> into **${t.shortName || t.name}** directly.` : `Couldn’t add the tribe role: ${r.content || 'check my role position.'}`);
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
  if (name === 'birthday') {
    const sub = interaction.options.getSubcommand();
    const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (sub === 'set') {
      const month = interaction.options.getInteger('month');
      const day = interaction.options.getInteger('day');
      const offsetInput = interaction.options.getString('utc_offset');
      const year = interaction.options.getInteger('year');
      const targetUser = interaction.options.getUser('member');
      let targetId = interaction.user.id;
      if (targetUser) {
        if (!canBan(interaction)) return interaction.reply({ content: 'Only staff can set another member\'s birthday.', flags: MessageFlags.Ephemeral });
        targetId = targetUser.id;
      } else if (birthday.get(interaction.user.id)) {
        return interaction.reply({ content: 'Your birthday is already set — that\'s a one-time self-set. Ask a mod to change it.', flags: MessageFlags.Ephemeral });
      }
      const r = saveBirthdayInput(targetId, month, day, offsetInput, year);
      if (!r.ok) return interaction.reply({ content: r.error, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: (targetUser ? `Set for <@${targetId}>: ` : '') + birthdaySavedMsg(r), flags: MessageFlags.Ephemeral });
    }
    if (sub === 'view') {
      const b = birthday.get(interaction.user.id);
      return interaction.reply({ content: b ? `🎉 **${MONTH_NAMES[b.month]} ${b.day}**${b.year ? ` ${b.year}` : ''} (${birthday.formatOffset(b.utcOffsetMin)})` : "You haven't set a birthday yet — \`/birthday set\`.", flags: MessageFlags.Ephemeral });
    }
    if (sub === 'clear') {
      birthday.clear(interaction.user.id);
      return interaction.reply({ content: '🗑️ Birthday cleared.', flags: MessageFlags.Ephemeral });
    }
  }
  if (name === 'awards') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'vote') {
      const key = interaction.options.getString('category');
      const target = interaction.options.getUser('member');
      const cat = awards.getCategory(key);
      if (!cat) return interaction.reply({ content: 'That award category doesn\'t exist anymore.', flags: MessageFlags.Ephemeral });
      if (target.id === interaction.user.id) return interaction.reply({ content: 'You can\'t vote for yourself.', flags: MessageFlags.Ephemeral });
      if (target.bot) return interaction.reply({ content: 'You can\'t vote for a bot.', flags: MessageFlags.Ephemeral });
      awards.castVote(key, interaction.user.id, target.id);
      return interaction.reply({ content: `🗳️ Voted <@${target.id}> for **${cat.name}**. You can change your vote anytime before Friday.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'list') {
      const cats = Object.entries(awards.categories());
      if (!cats.length) return interaction.reply({ content: 'No award categories yet — staff can add one with `/awards category-add`.', flags: MessageFlags.Ephemeral });
      const lines = cats.map(([key, c]) => {
        const h = awards.holder(key);
        const n = Object.keys(awards.votes(key)).length;
        return `**${c.name}** — holder: ${h ? `<@${h}>` : '_none yet_'} · ${n} vote${n === 1 ? '' : 's'} so far this week`;
      });
      return interaction.reply({ content: `## 🏆 Weekly Awards\n${lines.join('\n')}\nResults every Friday.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'category-add') {
      if (!canBan(interaction)) return interaction.reply({ content: 'Only staff can add award categories.', flags: MessageFlags.Ephemeral });
      const key = interaction.options.getString('key').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const catName = interaction.options.getString('name');
      if (!key) return interaction.reply({ content: 'That key needs at least one letter/number.', flags: MessageFlags.Ephemeral });
      if (awards.getCategory(key)) return interaction.reply({ content: `"${key}" already exists.`, flags: MessageFlags.Ephemeral });
      awards.addCategory(key, catName);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const role = await ensureAwardRole(interaction.guild, key);
      await ensureAwardsVotePanel(interaction.guild).catch(() => {});
      return interaction.editReply(role ? `✅ Added **${catName}** (\`${key}\`) — role ${role}.` : `Added **${catName}**, but couldn't create its role (check my role position).`);
    }
    if (sub === 'category-remove') {
      if (!canBan(interaction)) return interaction.reply({ content: 'Only staff can remove award categories.', flags: MessageFlags.Ephemeral });
      const key = interaction.options.getString('category');
      const cat = awards.getCategory(key);
      if (!cat) return interaction.reply({ content: 'That award category doesn\'t exist.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (cat.roleId) { const role = await interaction.guild.roles.fetch(cat.roleId).catch(() => null); if (role) await role.delete('Award category removed').catch(() => {}); }
      awards.removeCategory(key);
      await ensureAwardsVotePanel(interaction.guild).catch(() => {});
      return interaction.editReply(`🗑️ Removed **${cat.name}**.`);
    }
  }
  if (name === 'request-role-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try { const { channel, created } = await rolereq.setup(interaction.guild, config); return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>. Members use \`/request-role\`.`); }
    catch (e) { console.error(`[rolereq] setup ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'request-role') {
    if (!isVerifiedOrStaff(interaction))
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
    if (!isVerifiedOrStaff(interaction))
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
  if (name === 'report-setup' || name === 'modmail-setup' || name === 'sidebar-setup') {
    if (!isOwner(interaction)) return interaction.reply({ content: copy.guards.ownerSetupOnly, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const mod = name === 'report-setup' ? reports : name === 'modmail-setup' ? modmail : sidebar;
      const { channel, created } = await mod.setup(interaction.guild, config);
      return interaction.editReply(`${created ? '✅ Created' : copy.common.alreadySetup} <#${channel.id}>.`);
    } catch (e) { console.error(`[${name}] ${e.message}`); return interaction.editReply(`Setup failed: ${e.message}`).catch(() => {}); }
  }
  if (name === 'sidebar') {
    if (!canBan(interaction)) return interaction.reply({ content: 'Only staff (mods+) can open a sidebar.', flags: MessageFlags.Ephemeral });
    const users = ['user', 'user2', 'user3', 'user4', 'user5'].map(k => interaction.options.getUser(k)).filter(Boolean);
    if (users.some(u => u.id === interaction.user.id)) return interaction.reply({ content: "You can't sidebar yourself.", flags: MessageFlags.Ephemeral });
    if (users.some(u => u.bot)) return interaction.reply({ content: "Can't sidebar a bot.", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = [];
    for (const u of users) { const m = await interaction.guild.members.fetch(u.id).catch(() => null); if (m) members.push(m); }
    if (!members.length) return interaction.editReply('They’re not in the server anymore.');
    try {
      const r = await sidebar.pull(interaction.guild, interaction.member, members, interaction.options.getString('reason'));
      return interaction.editReply(r.ok ? `✅ Opened **Sidebar #${r.num}** with ${r.count} ${r.count === 1 ? 'person' : 'people'} → <#${r.threadId}>.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[sidebar] ${e.message}`); return interaction.editReply('Could not open that sidebar.').catch(() => {}); }
  }
  if (name === 'report') {
    if (!isVerifiedOrStaff(interaction))
      return interaction.reply({ content: 'You need to be verified before you can use this.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await reports.submit(interaction.guild, interaction.member, interaction.options.getUser('user'), interaction.options.getString('text'));
      return interaction.editReply(r.ok ? `✅ Opened **Report #${r.num}** → <#${r.threadId}>. Staff can see it there; head over to add anything else.` : `❌ ${r.msg}`);
    } catch (e) { console.error(`[reports] ${e.message}`); return interaction.editReply('Could not send that report.').catch(() => {}); }
  }
  if (name === 'modmail') {
    if (!isVerifiedOrStaff(interaction))
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
    const trial = hasTrialCornerTier(interaction);
    const isMod = !!opspanel.tierOf(interaction);   // any staff tier (mod/admin/owner incl Admin-perm/bot owner)
    // Verified members may use /corner (ONLY — not /uncorner) when the memberCorner feature is on. Their tight
    // limits (≤5m, no rule/reason, daily cap) are enforced inside the `name === 'corner'` block below.
    // Separate from the memberCorner feature flag (owner request, 2026-08-15): a verified, non-staff member
    // targeting a personally-approved corner target (see corner.js's PERSONAL_CORNER_OVERRIDES, e.g. the
    // server owner opting themselves in) gets in regardless of whether memberCorner is on — "two separate
    // features." Still under the SAME tight limits as memberCorner (checked again below via mCorner).
    const earlyTargetId = name === 'corner' ? interaction.options.getUser('user')?.id : null;
    const ownerCornerOK = name === 'corner' && !isMod && !trial && isMemberCornerEligibleRole(interaction)
      && !!earlyTargetId && corner.canBypassCornerTier(interaction.member || interaction.user.id, earlyTargetId, opspanel.tierOf(interaction));
    const memberMayCorner = name === 'corner' && (isMemberCorner(interaction) || ownerCornerOK);
    // Hit squad (owner, 2026-08-17): a named, time-boxed squad may /corner almost anyone — even staff —
    // for the activation window, regardless of the memberCorner feature flag. Corner-only: /uncorner is
    // untouched, still staff-only.
    const isHitSquad = name === 'corner' && hitsquad.isSquadMember(interaction.user.id);
    if (!isMod && !trial && !memberMayCorner && !isHitSquad) {
      // A verified member who WOULD qualify if the feature were on gets told plainly it's off, instead of
      // the generic staff-only message (command visibility no longer hides this from them either way).
      if (name === 'corner' && isMemberCornerEligibleRole(interaction))
        return interaction.reply({ content: '🚫 Member cornering is currently **turned off**. Only staff can use this right now.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: 'Only staff (mods+ or trial mods) can use this.', flags: MessageFlags.Ephemeral });
    }

    const guild = interaction.guild;
    const user = interaction.options.getUser('user');
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member is not in the server.', flags: MessageFlags.Ephemeral });
    if (member.id === client.user.id) return interaction.reply({ content: 'I cannot corner myself.', flags: MessageFlags.Ephemeral });

    if (name === 'corner') {
      // Same "separate from the memberCorner flag" path as the early gate above, now re-checked against
      // the actually-resolved target member (not just the raw option id).
      const mCorner = isMemberCorner(interaction) || (!opspanel.tierOf(interaction) && !hasTrialCornerTier(interaction)
        && isMemberCornerEligibleRole(interaction) && corner.canBypassCornerTier(interaction.member || interaction.user.id, member, opspanel.tierOf(interaction)));
      // Belt-and-suspenders re-check of the same gate the caller already applied above (kept in case this
      // block is ever reached another way) — staff/trial-mods always; a verified member only when
      // 'memberCorner' is on. /corner is visible to everyone regardless of the flag, so this can still
      // fire for a non-eligible member.
      if (!opspanel.tierOf(interaction) && !hasTrialCornerTier(interaction) && !mCorner && !hitsquad.isSquadMember(interaction.user.id))
        return interaction.reply({ content: copy.guards.modRoleOnly, flags: MessageFlags.Ephemeral });
      // Self-cornering is blocked for everyone EXCEPT this one member (owner-approved standing exception,
      // 2026-08-03). They pick their own duration like anyone else would; nothing here changes /uncorner,
      // so only staff can still release them early — this exemption is scoped to the corner path only, not
      // the shared corner/uncorner self-target logic above.
      const SELF_CORNER_EXEMPT_ID = '1415112053823242250';
      if (member.id === interaction.user.id && member.id !== SELF_CORNER_EXEMPT_ID) {
        return interaction.reply({ content: 'You can’t corner yourself.', flags: MessageFlags.Ephemeral });
      }
      // Tier hierarchy: you may corner your OWN staff tier or LOWER — never a higher tier. So equal
      // tiers can corner each other (mod↔mod, admin↔admin), staff can corner regular members, but a mod
      // can't corner an admin. Ranks: owner > admin > mod > member. The guild owner is never cornerable
      // (and OWNER⚜️ sits above the bot's role, so the bot couldn't strip it regardless).
      const RANK = { botowner: 4, owner: 3, admin: 2, mod: 1 };
      const actorTier = effectiveTierOf(interaction, member);
      const actorRank = RANK[actorTier] || 0;      // actor's tier (admin if Administrator-perm, or granted override power)
      const targetTier = opspanel.memberTier(member);                 // target's role-only tier
      const targetRank = RANK[targetTier] || 0;
      if (member.id === guild.ownerId && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, actorTier)) {
        return interaction.reply({ content: 'You can’t corner the server owner.', flags: MessageFlags.Ephemeral });
      }
      if (targetRank > actorRank && !corner.canBypassCornerTier(interaction.member || interaction.user.id, member, actorTier) && !hitsquad.canBypass(interaction.user.id, member.id)) {
        return interaction.reply({ content: `You can’t corner someone of a higher staff tier than you (they’re **${targetTier}**).`, flags: MessageFlags.Ephemeral });
      }
      const isHitSquadTarget = hitsquad.canBypass(interaction.user.id, member.id);
      const durStr = interaction.options.getString('duration');
      let durationMs = null;
      if (durStr) {
        durationMs = corner.parseDuration(durStr);
        if (!durationMs) return interaction.reply({ content: copy.corner.badDuration, flags: MessageFlags.Ephemeral });
      }
      // Hit-squad corners: owner, 2026-08-17 — "all corners expire at the end of the window," regardless of
      // whatever duration was typed (or left blank/indefinite). Force the release to the window's fixed end
      // time, not a fresh N-minutes-from-now — a corner applied 2 minutes into a 10-minute window still
      // releases at the 10-minute mark, same as one applied at the last second.
      if (isHitSquadTarget) durationMs = Math.max(0, hitsquad.getActive().expiresAt - Date.now());
      // Reason: a picked rule and/or a custom typed reason. Show both when present.
      const ruleN = interaction.options.getString('rule');
      const customReason = interaction.options.getString('reason');
      const reasonText = [ruleN ? `Rule ${ruleN}: ${SERVER_RULES[Number(ruleN) - 1]}` : null, customReason].filter(Boolean).join(', ') || null;
      // Trial-tier restrictions (Trial Mods, any language Mini-Mod, and Event Organizer all share this same
      // restricted tier): must give a rule OR a reason (same "not both required" convention as /strike
      // elsewhere), and the corner can't exceed 1 hour.
      if (trial) {
        if (!ruleN && !customReason) return interaction.reply({ content: 'At your tier, you must pick a **rule** or give a **reason** to corner someone.', flags: MessageFlags.Ephemeral });
        if (!durationMs) return interaction.reply({ content: 'At your tier, you must set a **duration**, max **1 hour** (e.g. `30m`, `1h`).', flags: MessageFlags.Ephemeral });
        if (durationMs > 3600000) return interaction.reply({ content: 'At your tier, a corner can be **at most 1 hour**.', flags: MessageFlags.Ephemeral });
        if ((interaction.options.getString('also') || '').trim() || (interaction.options.getString('sweep') || '').trim())
          return interaction.reply({ content: 'At your tier, you can only corner **one member at a time** — `also` and `sweep` are mod-only.', flags: MessageFlags.Ephemeral });
      }
      // Hit-squad restrictions: NO rule/reason, for the same reason member corners have none — a squad
      // corner is chaos, not discipline, and tagging one with a rule would pollute that member's
      // corner→strike repeat count for an offence that never happened (owner, 2026-08-20). corner.js
      // strips ruleIndex centrally as the real guarantee; this just says so out loud instead of
      // silently dropping what they typed. Only fires while the activation window is live.
      if (isHitSquad && (ruleN || customReason))
        return interaction.reply({ content: '🔪 Hit-squad corners can’t carry a **rule or reason** — they’re not disciplinary and don’t count toward anyone’s strike record. Just pick who.', flags: MessageFlags.Ephemeral });
      // Verified-member restrictions: NO rule/reason (so it never feeds corner→strike conversion), single
      // target, ≤ the member max (blank → max), and a hard daily cap.
      if (mCorner) {
        if (ruleN || customReason) return interaction.reply({ content: 'As a member you can’t attach a **rule or reason** to a corner — just pick who, and optionally how long (up to 5 min).', flags: MessageFlags.Ephemeral });
        if ((interaction.options.getString('also') || '').trim() || (interaction.options.getString('sweep') || '').trim())
          return interaction.reply({ content: 'As a member you can only corner **one person at a time**.', flags: MessageFlags.Ephemeral });
        if (durationMs && durationMs > config.memberCornerMaxMs)
          return interaction.reply({ content: `As a member, a corner can be **at most ${Math.round(config.memberCornerMaxMs / 60000)} minutes**.`, flags: MessageFlags.Ephemeral });
        if (!durationMs) durationMs = config.memberCornerMaxMs;   // blank → the max
        if (memberCornerCountToday(interaction.user.id) >= config.memberCornerDailyCap)
          return interaction.reply({ content: `You’ve used all **${config.memberCornerDailyCap}** of today’s corners — they reset at midnight UTC.`, flags: MessageFlags.Ephemeral });
      }
      const isAdult = interaction.options.getBoolean('adult') || false;
      const isThread = interaction.options.getBoolean('thread') || false;
      const isAnon = interaction.options.getBoolean('anon') || false;
      // Slowmode on their PRIVATE jail thread specifically (owner, 2026-08-20: "now that we have
      // individual threads we can set the slowmode in the specific thread when cornering") — needs
      // thread:true, since without a dedicated thread there's no per-person channel to rate-limit
      // (the shared #the-corner channel is everyone's, setting slowmode there would throttle the whole
      // room, not just this one person). Discord caps rateLimitPerUser at 6h (21600s).
      const slowmodeStr = interaction.options.getString('slowmode');
      let slowmodeSec = null;
      if (slowmodeStr) {
        if (!isThread) return interaction.reply({ content: '🔒 `slowmode` needs `thread:true` too — it applies to their private jail thread, not the shared corner channel.', flags: MessageFlags.Ephemeral });
        const ms = corner.parseDuration(slowmodeStr);
        if (!ms) return interaction.reply({ content: 'Bad slowmode. Use e.g. `30s`, `5m`, `1h` (max 6h).', flags: MessageFlags.Ephemeral });
        slowmodeSec = Math.min(Math.round(ms / 1000), 21600);
      }
      // joke is NOT a command option (owner ruling, this session: "don't add it to the command") — it's a
      // per-corner default (staff-on-staff → joke, staff-on-member → real) the actor can flip afterward via
      // the ephemeral jokeCheckIn() prompt. Leave undefined here so corner() computes its own default.
      // Multi-corner: `also` (named IDs) and/or `sweep` (everyone non-staff active in THIS channel in the last
      // N minutes) → corner the whole deduped set at once, same duration/reason. Either option triggers it.
      const alsoStr = interaction.options.getString('also');
      const sweepStr = interaction.options.getString('sweep');
      const sweepMins = sweepStr ? Number(sweepStr) : 0;
      const wantSweep = Number.isFinite(sweepMins) && sweepMins > 0;
      if ((alsoStr && alsoStr.trim()) || wantSweep) {
        // Always ephemeral (was public unless run in the corner channel) — each cornered member already
        // gets their own public announcement in the corner channel via cornerMany below, so this summary
        // ack doesn't need to be public too, and staying private is consistent with the single-target path.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const seen = new Set([member.id]), extras = [member], unknown = [];
        if (alsoStr && alsoStr.trim()) {
          for (const id of [...new Set(alsoStr.match(/\d{15,}/g) || [])]) {
            if (seen.has(id)) continue;
            const m = await guild.members.fetch(id).catch(() => null);
            if (m) { extras.push(m); seen.add(id); } else unknown.push(id);
          }
        }
        let sweptCount = 0;
        if (wantSweep && interaction.channel) {
          const since = Date.now() - Math.min(sweepMins, 120) * 60000;   // cap the look-back at 2h
          const recent = await interaction.channel.messages.fetch({ limit: 100 }).catch(() => null);
          if (recent) for (const m of recent.values()) {
            if (m.createdTimestamp < since || m.author.bot || seen.has(m.author.id)) continue;
            const mm = await guild.members.fetch(m.author.id).catch(() => null);
            if (mm && !opspanel.memberTier(mm) && !(config.trialModRoleId && mm.roles.cache.has(config.trialModRoleId))) { extras.push(mm); seen.add(m.author.id); sweptCount++; }
          }
        }
        const { done, skipped, whenPhrase, jokes } = await cornerMany(guild, interaction.user.id, actorRank, extras, durationMs, { ruleN, reasonText, allowNamedStaff: true, actorTier, adult: isAdult, thread: isThread, anon: isAnon, slowmodeSec });
        const lines = [];
        if (done.length) lines.push(`⛓️ Cornered **${done.length}** ${whenPhrase}: ${done.map(id => `<@${id}>`).join(', ')}${reasonText ? ` (${reasonText})` : ''}`);
        if (sweptCount) lines.push(`🧹 Swept the last ${Math.min(sweepMins, 120)}m of this channel.`);
        if (skipped.length) lines.push(`⚠️ Skipped: ${skipped.join(', ')}`);
        if (unknown.length) lines.push(`❓ Not found: ${unknown.map(id => `\`${id}\``).join(', ')}`);
        if (jokes.length) lines.push(`😂 Treated as joke (staff-on-staff, release tier lock waived): ${jokes.map(id => `<@${id}>`).join(', ')} — \`/corner-status\` to fix`);
        return interaction.editReply({ content: lines.join('\n') || 'Nobody to corner.', allowedMentions: { parse: [] } });
      }
      // Hide the mod ack if the command is run IN the corner channel (the themed embed already posts there).
      const inCorner = interaction.channelId === config.cornerChannelId;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await corner.corner(guild, member, durationMs, state, interaction.user.id, ruleN, opspanel.tierOf(interaction), { adult: isAdult, thread: isThread, anon: isAnon, viaMemberCorner: mCorner, slowmodeSec });
      if (!r.ok) {
        if (r.error === 'gated') {
          const actorTier = opspanel.tierOf(interaction);
          return interaction.editReply(r.need
            ? `🔒 That shortens ${user}'s time below what a higher tier set. Need **${r.need}** ${actorTier}${r.need === 1 ? '' : 's'} to try within 5 minutes (**${r.have}/${r.need}** so far).`
            : `🔒 That shortens ${user}'s time below what a higher tier set, and your tier has no override path for this.`);
        }
        return interaction.editReply(`Failed to corner: ${r.error}`);
      }
      if (mCorner) bumpMemberCornerCount(interaction.user.id);   // count it against their daily cap
      await maybeAlertCornerRepeat(guild, member, ruleN, r.repeatCount);
      const relSec = durationMs ? Math.floor((Date.now() + durationMs) / 1000) : null;
      const whenPhrase = relSec ? `until <t:${relSec}:f>` : 'indefinitely';
      // Announce in the corner channel so the cornered member sees it there.
      try {
        const cornerCh = await guild.channels.fetch(r.targetChannelId || config.cornerChannelId).catch(() => null);
        const sentMsg = cornerSentMessage(user.id, whenPhrase, reasonText, isAnon ? null : interaction.user.id, false, isAnon);
        if (cornerCh) await cornerCh.send(sentMsg).catch(() => {});
        if (r.threadId) {
          const threadCh = await guild.channels.fetch(r.threadId).catch(() => null);
          if (threadCh) await threadCh.send(cornerSentMessage(user.id, whenPhrase, reasonText, isAnon ? null : interaction.user.id, true, isAnon)).catch(() => {});
        }
      } catch (e) { console.error(`[corner] channel announce failed: ${e.message}`); }
      const modWhen = relSec ? `until <t:${relSec}:f>` : 'indefinitely (until manually released)';
      const cornerWhenPhrase = relSec ? `until ${relPhrase(relSec * 1000)}` : '**indefinitely**';
      await logCorner(guild, { emoji: '⛓️', title: 'SENT TO THE CORNER', color: CORNER_RED,
        desc: `<@${user.id}> was cornered ${cornerWhenPhrase}.\n**By:** ${isAnon ? '🎭 Anonymous Staff' : `<@${interaction.user.id}>`}${reasonText ? `\n**Reason:** ${reasonText}` : ''}${threadNotifyLine(r.threadId)}`,
        ownerDesc: `<@${user.id}> was cornered ${cornerWhenPhrase}.\n**By:** <@${interaction.user.id}>${isAnon ? ' _(anon corner)_' : ''}${reasonText ? `\n**Reason:** ${reasonText}` : ''}`,
        pingRoleIds: r.threadId && config.modRoleId ? [config.modRoleId] : undefined });
      // Joke check-in (staff corners only — not the member-corner or hit-squad paths, where a joke flag on
      // the uncorner tier lock is meaningless): staff-on-staff defaulted to joke (waiving the release tier
      // lock) and asks if it's actually serious; staff-on-a-regular-member defaulted to real and asks the
      // opposite way (owner, 2026-08-18: "The same ephemeral will pop up on regular corners of a staff on a
      // normal member and ask if this is a joke ... with the staff one it'll be like, is this serious?").
      const ackText = `🚫 Sent ${user} to the corner ${modWhen}${reasonText ? ` (${reasonText})` : ''}. Stripped **${r.stripped}** role(s).`;
      // The public ack (previously the interaction reply itself when not run in the corner channel) is now
      // a plain channel message — "the one that was already there" stays visible in-channel exactly as
      // before, it's just sent a different way so the interaction's own response can stay ephemeral.
      if (!inCorner) await interaction.channel.send({ content: ackText, allowedMentions: { parse: [] } }).catch(() => {});
      await interaction.editReply(ackText);   // message #1 — private copy of the ack, always
      // Message #2 — the joke check-in, its own separate ephemeral followup (genuinely private now that
      // the interaction's initial response is always ephemeral — see the deferReply comment above).
      if ((isMod || trial) && !mCorner && !isHitSquadTarget) await jokeCheckIn(interaction, user.id, r.joke);
      return;
    } else {
      const inCorner = interaction.channelId === config.cornerChannelId;
      const durStr = interaction.options.getString('duration');
      let durationMs = null;
      if (durStr) {
        durationMs = corner.parseDuration(durStr);
        if (!durationMs) return interaction.reply({ content: copy.corner.badDuration, flags: MessageFlags.Ephemeral });
      }
      const actorTier = opspanel.tierOf(interaction);
      // Multi-release: `also` (named IDs) → release the whole deduped set at once, same duration (or right
      // now if none given). Mirrors /corner's `also` option.
      const alsoStr = interaction.options.getString('also');
      if (alsoStr && alsoStr.trim()) {
        await interaction.deferReply({ flags: inCorner ? MessageFlags.Ephemeral : undefined });
        const ids = [user.id, ...new Set(alsoStr.match(/\d{15,}/g) || [])];
        const { done, scheduled, skipped, releaseAt } = await uncornerMany(guild, interaction.user.id, actorTier, ids, durationMs);
        const lines = [];
        if (done.length) lines.push(`✅ Released **${done.length}**: ${done.map(id => `<@${id}>`).join(', ')}`);
        if (scheduled.length) lines.push(`⏳ Release scheduled <t:${Math.floor(releaseAt / 1000)}:R> for **${scheduled.length}**: ${scheduled.map(id => `<@${id}>`).join(', ')}`);
        if (skipped.length) lines.push(`⚠️ Skipped: ${skipped.join(', ')}`);
        return interaction.editReply({ content: lines.join('\n') || 'Nobody to release.', allowedMentions: { parse: [] } });
      }
      await interaction.deferReply({ flags: inCorner ? MessageFlags.Ephemeral : undefined });
      if (durationMs) {
        // Schedule a future release (e.g. give an indefinitely-cornered member a release time). The
        // auto-release loop frees them + posts the "time served" embed when it expires.
        // Tiering (owner, 2026-08-13): shortening an existing time, or defining a release sooner than
        // 15 minutes out from indefinite, counts as "lowering" and needs the same tier/override gate as
        // a full release — otherwise scheduling a near-immediate release would bypass that gate entirely.
        const releaseAt = Date.now() + durationMs;
        const res = corner.attemptSeverityChange(state, user.id, interaction.user.id, actorTier, releaseAt);
        if (res.notFound) return interaction.editReply(`${user} is not in the corner.`);
        if (!res.ok) {
          return interaction.editReply(res.need
            ? `🔒 That shortens their time below what a higher tier set. Need **${res.need}** ${actorTier}${res.need === 1 ? '' : 's'} to try within 5 minutes (**${res.have}/${res.need}** so far).`
            : `🔒 That shortens their time below what a higher tier set, and your tier has no override path for this.`);
        }
        corner.armTimer(guild, user.id, releaseAt);   // same class of bug as handleCornerButton's sentence-change
        // path: writing releaseAt alone doesn't arm/reschedule the setTimeout — an indefinite member given a
        // release time here would otherwise just never actually auto-release.
        await logCorner(guild, { emoji: '⏳', title: 'RELEASE SCHEDULED', color: CORNER_AMBER,
          desc: `<@${user.id}>'s release was scheduled.\n**Release:** ${relPhrase(releaseAt)}\n**By:** <@${interaction.user.id}>` });
        return interaction.editReply(`⏳ Scheduled ${user}'s release <t:${Math.floor(releaseAt / 1000)}:R> (at <t:${Math.floor(releaseAt / 1000)}:f>). The corner will release them automatically.`);
      }
      // Immediate release is unconditionally the strongest possible "lowering" — always gated (subject to
      // the same solo-tier / original-corner-er / multi-person-override rules as scheduling a sooner time).
      const relCheck = corner.attemptSeverityChange(state, user.id, interaction.user.id, actorTier, 'RELEASE');
      if (relCheck.notFound) return interaction.editReply(`${user} is not in the corner.`);
      if (!relCheck.ok) {
        return interaction.editReply(relCheck.need
          ? `🔒 You can't release ${user} solo — they were cornered/held at a higher tier. Need **${relCheck.need}** ${actorTier}${relCheck.need === 1 ? '' : 's'} to try within 5 minutes (**${relCheck.have}/${relCheck.need}** so far).`
          : `🔒 You can't release ${user} solo — they were cornered/held at a higher tier, and your tier has no override path for this.`);
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
