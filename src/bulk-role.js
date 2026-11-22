'use strict';

const { randomBytes } = require('node:crypto');
const { Routes, PermissionFlagsBits: P } = require('discord.js');
const { catalog, compareRoles, RuleError } = require('./ladder');

const ladderRoles = new Set(catalog.categories.flatMap(group => [...group.ranks, group.variant, ...group.helpers]));
const pageSize = 1000;
const confirmationLifetime = 120_000;

function createBulkRole({ readyGuild, reservedRole = () => false, now = Date.now }) {
  let active = false;
  let pending = null;
  return async function grant({ actor, roleId, delivery, channel, confirmation }) {
    const guild = readyGuild();
    function checkOwner() {
      if (actor !== guild.ownerId) throw new RuleError('توزيع رول على الجميع متاح لمالك السيرفر فقط.', 403);
    }
    checkOwner();
    if (active) throw new RuleError('يوجد توزيع رول قيد التنفيذ. انتظر النتيجة قبل إعادة الأمر.', 409);
    active = true;
    try {
      const { id, client: { rest, user } } = guild;
      const memberRoute = member => Routes.guildMember(id, member);
      async function checkRole() {
        checkOwner();
        if (roleId === id) throw new RuleError('رول @everyone موجود تلقائيًا عند الجميع ولا يمكن توزيعه.', 403);
        const [roles, bot, channels] = await Promise.all([
          rest.get(Routes.guildRoles(id)),
          rest.get(memberRoute(user.id)),
          rest.get(Routes.guildChannels(id))
        ]);
        const role = roles.find(row => row.id === roleId);
        if (!role) throw new RuleError('الرول غير موجود في هذا السيرفر.', 404);
        if (role.managed) throw new RuleError('هذا الرول مُدار من ديسكورد أو من تكامل، ولا يمكن منحه يدويًا.', 403);
        const held = roles.filter(row => row.id === id || bot.roles.includes(row.id)).sort(compareRoles);
        const permissions = held.reduce((bits, row) => bits | BigInt(row.permissions), 0n);
        if (!(permissions & (P.Administrator | P.ManageRoles)) || !held[0] || compareRoles(held[0], role) >= 0) {
          throw new RuleError('البوت يحتاج Manage Roles ورولًا أعلى من الرول المطلوب.', 403);
        }
        checkOwner();
        const overrides = channels.flatMap(room => (room.permission_overwrites ?? [])
          .filter(row => row.id === roleId && (BigInt(row.allow) !== 0n || BigInt(row.deny) !== 0n))
          .map(row => [room.id, row.allow, row.deny])).sort((a,b) => a[0].localeCompare(b[0]));
        const guildPermissions = BigInt(role.permissions);
        const policyRole = ladderRoles.has(roleId) || reservedRole(roleId);
        return {
          fingerprint: JSON.stringify([role.name, role.position, String(guildPermissions), overrides, policyRole]),
          impact: {administrator: Boolean(guildPermissions & P.Administrator), guildPermissions: guildPermissions !== 0n,
            rooms: new Set(overrides.map(([room]) => room)).size, policyRole}
        };
      }
      const { fingerprint, impact } = await checkRole();
      if (confirmation !== undefined) {
        if (!pending || pending.expires <= now() || pending.token !== confirmation || pending.actor !== actor ||
            pending.guildId !== id || pending.channel !== channel || pending.roleId !== roleId) {
          throw new RuleError('تأكيد غير صالح أو منتهي. اكتب أمر التوزيع بدون تأكيد للحصول على رمز جديد في نفس الروم.', 400);
        }
        const saved = pending;
        pending = null;
        if (saved.fingerprint !== fingerprint) {
          throw new RuleError('تغيّرت إعدادات الرول بعد المعاينة. اطلب معاينة جديدة. لم يتم توزيع الرول.', 409);
        }
      } else if (impact.guildPermissions || impact.rooms || impact.policyRole) {
        const token = randomBytes(6).toString('hex');
        pending = { token, actor, guildId:id, channel, roleId, fingerprint, expires:now() + confirmationLifetime };
        return { token, impact };
      }
      const queue = [];
      const result = { added:0, already:0, skipped:0, failed:0, unverified:0, remaining:0 };
      let after = '0';
      for (;;) {
        const query = new URLSearchParams({ limit:String(pageSize), after });
        let page;
        try { page = await rest.get(Routes.guildMembers(id), { query }); }
        catch (err) {
          if (err.status === 403 || err.code === 50001 || err.code === 50013) {
            throw new RuleError('تعذّر جلب الأعضاء. تأكد من تفعيل Server Members Intent للبوت.', 403);
          }
          throw err;
        }
        let cursor = after;
        for (const member of page) {
          const memberId = member.user.id;
          if (BigInt(memberId) <= BigInt(after)) continue;
          if (BigInt(memberId) > BigInt(cursor)) cursor = memberId;
          if (member.user.bot || member.pending) result.skipped++;
          else if (member.roles.includes(roleId)) result.already++;
          else queue.push(memberId);
        }
        if (page.length < pageSize) break;
        if (cursor === after) throw new RuleError('تعذّر إكمال قائمة الأعضاء. لم يُضف الرول لأي عضو.', 502);
        after = cursor;
      }
      const reason = 'BlueLand bulk role · ' + actor + ' · ' + delivery;
      for (const [index, memberId] of queue.entries()) {
        if (index % 50 === 0) {
          try {
            if ((await checkRole()).fingerprint !== fingerprint) {
              throw new RuleError('تغيّرت إعدادات الرول قبل التنفيذ. لم يتم توزيع الرول.', 409);
            }
          } catch (err) {
            if (index === 0) throw err;
            result.remaining = queue.length - index;
            break;
          }
        }
        try { checkOwner(); }
        catch {
          if (index === 0) throw new RuleError('تغيّر مالك السيرفر قبل التنفيذ.', 403);
          result.remaining = queue.length - index;
          break;
        }
        try { await rest.put(Routes.guildMemberRole(id, memberId, roleId), { reason }); }
        catch { result.failed++; continue; }
        try {
          const member = await rest.get(memberRoute(memberId));
          if (member.roles.includes(roleId)) result.added++;
          else result.unverified++;
        } catch { result.unverified++; }
      }
      return result;
    } finally { active = false; }
  };
}

module.exports = { createBulkRole };
