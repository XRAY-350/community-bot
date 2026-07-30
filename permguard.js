// permguard.js — periodic reconciliation of channel ROLE permission overwrites against a golden
// manifest snapshot. Built 2026-07-30 after a plain mod could post in #mod-announcements: the channel's
// own overwrite for MODS-✰ only ALLOWed View+ReadHistory with no explicit DENY, so it silently stopped
// inheriting the category's "deny everything by default" rule (Discord replaces, not merges, a
// category's overwrite once a channel has its own) and the mod's base-role Send Messages leaked
// through. That's a structural risk for ANY channel with a partial role overwrite, not just this one —
// this sweep catches drift of that shape automatically, on a schedule, instead of waiting for a report.
const { Routes } = require('discord.js');
const fs = require('fs');
const ownerlog = require('./ownerlog');

const MANIFEST_FILE = process.env.FUBU_PERM_MANIFEST_FILE || '/home/ubuntu/.fubu_perm_manifest.json';

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return null; }
}

// The manifest is the "should be" snapshot, taken once (2026-07-30, right after the full permission
// audit + the mod-announcements fix) and re-taken whenever the owner deliberately changes a channel's
// permission structure — see resnapshot() below. It is NOT auto-regenerated from live state on every
// sweep; that would just make every future drift "correct by definition" and defeat the point.
async function resnapshot(guild) {
  const channels = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const roles = await guild.roles.fetch();
  const manifest = {};
  for (const ch of channels) {
    manifest[ch.id] = {
      name: ch.name, type: ch.type, parentId: ch.parentId || null,
      overwrites: [...ch.permissionOverwrites.cache.values()].map(o => ({
        id: o.id, type: o.type, name: o.type === 0 ? (roles.get(o.id)?.name || o.id) : `member:${o.id}`,
        allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString(),
      })),
    };
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  return { channels: channels.length, overwrites: Object.values(manifest).reduce((n, c) => n + c.overwrites.length, 0) };
}

// Compare + fix ROLE overwrites (type 0) only. Member-specific overwrites (bot integrations, one-off
// grants) are far more likely to be a deliberate, still-valid special case added after the snapshot —
// auto-reverting those could undo something the owner meant to keep. Those are only ever REPORTED
// (a brand-new one appearing), never auto-corrected.
async function sweepPermissions(guild, { notify = true } = {}) {
  const manifest = loadManifest();
  if (!manifest) return { fixed: 0, corrections: [], newMemberOverwrites: [], unmanagedChannels: 0 };
  const channels = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const corrections = [];
  const newMemberOverwrites = [];
  let unmanagedChannels = 0;

  for (const ch of channels) {
    const golden = manifest[ch.id];
    if (!golden) { unmanagedChannels++; continue; } // channel created after the snapshot — not managed

    const liveRole = new Map();
    const liveMember = new Map();
    for (const o of ch.permissionOverwrites.cache.values()) {
      (o.type === 0 ? liveRole : liveMember).set(o.id, o);
    }
    const goldenRole = new Map(golden.overwrites.filter(o => o.type === 0).map(o => [o.id, o]));
    const goldenMember = new Map(golden.overwrites.filter(o => o.type === 1).map(o => [o.id, o]));

    // Every role the manifest knows about for this channel — golden's value must match exactly.
    const allRoleIds = new Set([...liveRole.keys(), ...goldenRole.keys()]);
    for (const roleId of allRoleIds) {
      const live = liveRole.get(roleId);
      const desired = goldenRole.get(roleId);
      const liveAllow = live ? live.allow.bitfield.toString() : '0';
      const liveDeny = live ? live.deny.bitfield.toString() : '0';
      const desiredAllow = desired ? desired.allow : '0';
      const desiredDeny = desired ? desired.deny : '0';
      if (liveAllow === desiredAllow && liveDeny === desiredDeny) continue;

      const roleName = desired?.name || live?.name || roleId;
      try {
        if (desired) {
          await guild.client.rest.put(Routes.channelPermission(ch.id, roleId), { body: { id: roleId, type: 0, allow: desiredAllow, deny: desiredDeny } });
        } else {
          await guild.client.rest.delete(Routes.channelPermission(ch.id, roleId));
        }
        corrections.push({ channel: ch.name, channelId: ch.id, role: roleName, before: { allow: liveAllow, deny: liveDeny }, after: { allow: desiredAllow, deny: desiredDeny } });
      } catch (err) {
        console.error(`[permguard] fix ${ch.name}/${roleName}: ${err.message}`);
      }
    }

    // Member overwrites: only flag brand-new ones the manifest never saw. Never auto-remove.
    for (const [memberId, live] of liveMember) {
      if (!goldenMember.has(memberId)) {
        newMemberOverwrites.push({ channel: ch.name, channelId: ch.id, memberId });
      }
    }
  }

  if (corrections.length) {
    console.log(`[permguard] corrected ${corrections.length} drifted overwrite(s)`);
    if (notify) {
      const lines = corrections.slice(0, 10).map(c => `• **#${c.channel}** — ${c.role}: restored to allow=${c.after.allow}/deny=${c.after.deny}`).join('\n');
      await ownerlog.log(guild, {
        emoji: '🛡️', title: `Permission drift auto-corrected (${corrections.length})`, color: 0xE67E22,
        detail: lines + (corrections.length > 10 ? `\n…and ${corrections.length - 10} more.` : ''),
      });
    }
  }
  if (newMemberOverwrites.length && notify) {
    const lines = newMemberOverwrites.slice(0, 10).map(m => `• **#${m.channel}** — new member-specific override for <@${m.memberId}> (not auto-reviewed, check it's intentional)`).join('\n');
    await ownerlog.log(guild, { emoji: '🔍', title: `New per-member channel override(s) detected (${newMemberOverwrites.length})`, color: 0x99AAB5, detail: lines });
  }
  return { fixed: corrections.length, corrections, newMemberOverwrites, unmanagedChannels };
}

function register(client, { intervalMin = 20 } = {}) {
  const run = async () => {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    try { await sweepPermissions(guild); } catch (err) { console.error('[permguard] sweep failed:', err.message); }
  };
  setTimeout(run, 45 * 1000); // after boot self-heal + ownerlog channel are set up
  setInterval(run, intervalMin * 60 * 1000);
  console.log(`[permguard] permission-drift sweep every ${intervalMin}min`);
}

module.exports = { sweepPermissions, resnapshot, loadManifest, register };
