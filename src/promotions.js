'use strict';

const { catalog, roles, compareRoles, planPromotion, RuleError } = require('./ladder');
const { ladderIssue } = require('./directory');
const ADMIN = 1n << 3n;
const MANAGE_ROLES = 1n << 28n;
const rankedIds = new Set(catalog.categories.flatMap(c => [...c.ranks, c.variant]));

function memberAccess(ctx, member) {
  const assigned = [ctx.roles.get(catalog.guildId), ...member.roles.map(id => ctx.roles.get(id))].filter(Boolean);
  const highest = assigned.sort(compareRoles)[0];
  const bits = assigned.reduce((mask, role) => mask | BigInt(role.permissions), 0n);
  return { highest, bits, admin: (bits & ADMIN) !== 0n, manages: (bits & MANAGE_ROLES) !== 0n };
}

function checkOperator(ctx, allowed) {
  const access = memberAccess(ctx, ctx.actor);
  if (ctx.actor.bot || !(ctx.actor.id === ctx.ownerId || access.admin || access.manages || ctx.actor.roles.some(id => allowed.has(id)))) {
    throw new RuleError('أمر الترقية متاح فقط للمسؤولين المخوّلين في BlueLand.', 403);
  }
  return access;
}

function checkPlan(ctx, plan, allowed) {
  const operator = checkOperator(ctx, allowed);
  if (plan.direction === 'demote' && ctx.actor.id !== ctx.ownerId && !operator.admin) {
    throw new RuleError('التخفيض يحتاج صلاحية Administrator.',403);
  }
  if (ctx.actor.id === ctx.target.id || ctx.target.id === ctx.ownerId || ctx.target.bot) {
    throw new RuleError('اختر عضوًا آخر من السيرفر. الترقية لا تشمل مالك السيرفر أو البوتات.', 403);
  }
  const bot = memberAccess(ctx, ctx.bot);
  const target = memberAccess(ctx, ctx.target);
  const owner = ctx.actor.id === ctx.ownerId;
  if (!bot.manages && !bot.admin) throw new RuleError('فعّل صلاحية Manage Roles للبوت.', 403);
  if (compareRoles(bot.highest, target.highest) >= 0 || (!owner && compareRoles(operator.highest, target.highest) >= 0)) {
    throw new RuleError('أعلى رول للعضو يجب أن يكون تحت رول البوت وتحت رول المسؤول المنفّذ.', 403);
  }
  const required = new Set([plan.anchor, plan.to, ...plan.helpers, ...plan.remove]);
  if (plan.from) required.add(plan.from);
  for (const id of required) {
    const live = ctx.roles.get(id);
    if (!live || live.managed) throw new RuleError('رول من إعدادات الترقية حُذف أو أصبح مُدارًا. راجع دليل الرتب.', 409);
    if (compareRoles(bot.highest, live) >= 0 || (!owner && compareRoles(operator.highest, live) >= 0)) {
      throw new RuleError('رول ' + live.name + ' أعلى من حدود صلاحية البوت أو المسؤول.', 403);
    }
    if (!ctx.target.roles.includes(id) && !plan.remove.includes(id)) {
      const permissions = BigInt(live.permissions);
      if ((permissions & ADMIN) || (permissions & ~BigInt(roles.get(id).permissions))) {
        throw new RuleError('تغيّرت صلاحيات رول ' + live.name + '. راجع إعداداته قبل منحه.', 409);
      }
      if ((!owner && !operator.admin && (permissions & ~operator.bits)) || (!bot.admin && (permissions & ~bot.bits))) {
        throw new RuleError('هذه الدرجة تمنح صلاحيات تتجاوز صلاحيات المنفّذ أو البوت.', 403);
      }
    }
  }
  // A snapshot may remain useful for browsing after Discord roles move, but not for granting them.
  const issue = ladderIssue(ctx.roles);
  if (issue) throw new RuleError(issue,409);
  const groups = catalog.categories.slice(0,catalog.categories.findIndex(g=>g.id===plan.group)+1);
  for (const [index,group] of groups.entries()) {
    const base = ctx.roles.get(group.base);
    const lowerCategoryTop = index ? ctx.roles.get(groups[index-1].ranks.at(-1)) : null;
    for (const id of group.helpers) {
      const helper = ctx.roles.get(id);
      if (compareRoles(base,helper)>=0 || (lowerCategoryTop && compareRoles(helper,lowerCategoryTop)>=0)) {
        throw new RuleError('تغيّر موضع رول الصلاحية '+helper.name+' عن فئته. راجع ترتيب ديسكورد.',409);
      }
    }
  }
}

function makeService(store, gateway, allowed = new Set()) {
  const active = new Map();
  async function preview(actor, target) {
    const ctx = await gateway.context(actor, target);
    checkOperator(ctx, allowed);
    if (store.pending(target)) throw new RuleError('لهذا العضو ترقية قيد الاستكمال. راجع سجل الترقيات.', 409);
    const plan = planPromotion(ctx.target.roles);
    checkPlan(ctx, plan, allowed);
    return { member: ctx.target.name, target, plan };
  }

  async function apply(entry, ctx) {
    const { plan } = entry;
    // A restarted process may see an intermediate state. Never reinterpret it as a new step.
    const expected = new Set([...plan.before, plan.to, plan.anchor]);
    if (ctx.target.roles.some(id => rankedIds.has(id) && !expected.has(id))) {
      throw new RuleError('تغيّرت درجة العضو خارج هذه العملية. راجع رتب العضو قبل الاستكمال.', 409);
    }
    checkPlan(ctx, plan, allowed);
    const held = new Set(ctx.target.roles);
    // Single-role PUT/DELETE preserves unrelated concurrent changes. Both operations are idempotent.
    const group = catalog.categories.find(c => c.id === plan.group);
    const grade = plan.to === group.base ? plan.anchor : plan.to;
    for (const id of new Set([plan.anchor, grade, ...plan.helpers])) {
      if (!held.has(id)) await gateway.change(entry, id, true);
    }
    for (const id of plan.remove) {
      if (held.has(id)) await gateway.change(entry, id, false);
    }
    return store.finish(entry.id);
  }

  async function perform(request) {
    let entry = store.byId(request.id);
    if (entry && (entry.actor !== request.actor || entry.target !== request.target ||
        (request.direction && request.direction !== (entry.plan.direction || 'promote')))) {
      throw new RuleError('معرّف العملية مستخدم لطلب آخر.', 409);
    }
    if (entry?.state === 'done') return entry;
    const ctx = await gateway.context(request.actor, request.target);
    checkOperator(ctx, allowed);
    if (!entry) {
      if (store.pending(request.target)) throw new RuleError('توجد ترقية سابقة قيد الاستكمال لهذا العضو.', 409);
      const plan = planPromotion(ctx.target.roles, request.direction);
      if (Object.hasOwn(request, 'expectedFrom') && plan.from !== request.expectedFrom) {
        throw new RuleError('تغيّرت درجة العضو بعد المعاينة. اعرض الترقية من جديد.', 409);
      }
      checkPlan(ctx, plan, allowed);
      plan.before = ctx.target.roles.filter(id => rankedIds.has(id));
      entry = store.begin(request.id, ctx.actor, ctx.target, request.source, plan);
    }
    try { return await apply(entry, ctx); }
    catch (err) {
      store.note(entry.id, err instanceof RuleError ? err.message : 'تعذّر إكمال تعديل الرولات في ديسكورد.');
      throw err;
    }
  }

  function execute(request) {
    const running = active.get(request.target);
    if (running) {
      if (running.id === request.id && running.actor === request.actor) return running.promise;
      return Promise.reject(new RuleError('يجري تنفيذ ترقية لهذا العضو. انتظر اكتمالها.', 409));
    }
    const promise = perform(request).finally(() => active.delete(request.target));
    active.set(request.target, { id: request.id, actor: request.actor, promise });
    return promise;
  }
  async function recover() {
    for (const entry of store.unfinished()) {
      try { await execute(entry); }
      catch (err) { store.note(entry.id, err instanceof RuleError ? err.message : 'بانتظار استجابة ديسكورد.'); }
    }
  }
  return { preview, execute, recover, checkOperator: ctx => checkOperator(ctx, allowed) };
}
module.exports = { makeService, checkOperator, memberAccess };
