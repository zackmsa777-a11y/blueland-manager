'use strict';

const { Routes, PermissionFlagsBits: P } = require('discord.js');
const { catalog, compareRoles, RuleError } = require('./ladder');

const protectedRoles = new Set(catalog.categories.flatMap(group => [...group.ranks, group.variant, ...group.helpers]));
const pageSize = 1000;

function createBulkRole({ readyGuild, reservedRole = () => false }) {
  let active = false;
  return async function grant({ actor, roleId, delivery }) {
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
        if (roleId === id || protectedRoles.has(roleId) || reservedRole(roleId)) {
          throw new RuleError('ما تقدر توزّع @everyone أو رولات السلّم والإدارة والدعم على الجميع.', 403);
        }
        const [roles, bot, channels] = await Promise.all([
          rest.get(Routes.guildRoles(id)),
          rest.get(memberRoute(user.id)),
          rest.get(Routes.guildChannels(id))
        ]);
        const role = roles.find(row => row.id === roleId);
        if (!role) throw new RuleError('الرول غير موجود في هذا السيرفر.', 404);
        if (role.managed || BigInt(role.permissions) !== 0n ||
            channels.some(channel => channel.permission_overwrites?.some(overwrite =>
              overwrite.id === roleId && (BigInt(overwrite.allow) !== 0n || BigInt(overwrite.deny) !== 0n)))) {
          throw new RuleError('التوزيع الجماعي يقبل الرولات العادية فقط، بدون صلاحيات أو أذونات خاصة في الرومات.', 403);
        }
        const held = roles.filter(row => row.id === id || bot.roles.includes(row.id)).sort(compareRoles);
        const permissions = held.reduce((bits, row) => bits | BigInt(row.permissions), 0n);
        if (!(permissions & (P.Administrator | P.ManageRoles)) || !held[0] || compareRoles(held[0], role) >= 0) {
          throw new RuleError('البوت يحتاج Manage Roles ورولًا أعلى من الرول المطلوب.', 403);
        }
        checkOwner();
      }
      await checkRole();
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
          try { await checkRole(); }
          catch (err) {
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
