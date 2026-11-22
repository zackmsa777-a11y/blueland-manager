'use strict';

const catalog = require('../config/catalog.json');
const roles = new Map(catalog.roles.map(role => [role.id, role]));
const ladder = [];
const steps = new Map();
const variants = new Map();
const allRankIds = new Set();
const allHelpers = new Set();

class RuleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

for (const group of catalog.categories) {
  for (const id of group.helpers) allHelpers.add(id);
  for (const id of group.ranks) {
    if (!roles.has(id) || steps.has(id)) throw new Error('Invalid promotion ladder in catalog.json');
    const step = { id, group, index: ladder.length, helpers: [...allHelpers] };
    ladder.push(step);
    steps.set(id, step);
    allRankIds.add(id);
  }
  variants.set(group.variant, group);
  allRankIds.add(group.variant);
}

// Negative means a is higher. At the same raw position the smaller snowflake wins.
function compareRoles(a, b) {
  if (a.id === b.id) return 0;
  if (a.position !== b.position) return b.position - a.position;
  return BigInt(a.id) < BigInt(b.id) ? -1 : 1;
}

function validatePromotionCount(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > ladder.length) {
    throw new RuleError('عدد درجات الترقية لازم يكون عددًا صحيحًا من 1 إلى ' + ladder.length + '.');
  }
  return count;
}

function planPromotion(roleIds, direction = 'promote', count = 1) {
  validatePromotionCount(count);
  const held = new Set(roleIds);
  const currentRanks = ladder.filter(step => held.has(step.id) || (step.id === step.group.base && held.has(step.group.variant)));
  const previous = currentRanks.at(-1);
  const details = currentRanks.filter(step => step.id !== step.group.base);
  if (details.length > 1 || (details.length && previous !== details[0])) {
    throw new RuleError('العضو يحمل درجات متعارضة. راجع رتبته الحالية في ديسكورد قبل الترقية.');
  }
  const down = direction === 'demote';
  if (down && count !== 1) throw new RuleError('أمر التخفيض يسمح بدرجة واحدة فقط.');
  if (down && (!previous || previous.index === 0)) throw new RuleError('لا توجد درجة أدنى لهذا العضو في السلّم.');
  const currentIndex = previous?.index ?? -1;
  const next = ladder[currentIndex + (down ? -1 : count)];
  if (!next) {
    const remaining = ladder.length - 1 - currentIndex;
    if (remaining === 0) throw new RuleError('وصل العضو إلى آخر درجة في سلّم الترقيات.');
    throw new RuleError('العدد يتجاوز آخر درجة في السلّم. عدد الدرجات المتاحة لهذا العضو: ' + remaining + '.');
  }
  const variant = previous && held.has(previous.group.variant);
  const anchor = variant ? next.group.variant : next.group.base;
  const assigned = new Set([anchor, ...next.helpers]);
  if (next.id !== next.group.base) assigned.add(next.id);
  const add = [...assigned].filter(id => !held.has(id));
  // Apply only the destination roles and cumulative helpers; never grant intermediate grades.
  const remove = [...held].filter(id => !assigned.has(id) && (allRankIds.has(id) || (down && previous.helpers.includes(id))));
  return { from: previous?.id ?? null, to: next.id, group: next.group.id, anchor, add, remove, helpers: next.helpers, ...(down ? { direction } : {}), ...(count > 1 ? { count } : {}) };
}

function parsePromotion(content) {
  const text = content.trim();
  if (!/^\+ترقية(?:\s|$)/u.test(text)) return null;
  const match = /^\+ترقية\s+<@!?(\d{17,20})>(?:\s+(\d+))?$/u.exec(text);
  if (!match) throw new RuleError('اكتب الأمر مع منشن عضو واحد وعدد اختياري، مثل +ترقية @العضو 2.');
  return { target: match[1], count: validatePromotionCount(Number(match[2] ?? '1')) };
}

function preview(id, variant = false) {
  if (id && !steps.has(id)) throw new RuleError('اختر درجة من سلّم الترقيات.');
  const selected = steps.get(id);
  const held = selected ? new Set([variant ? selected.group.variant : selected.group.base, ...selected.helpers]) : new Set();
  if (selected && selected.id !== selected.group.base) held.add(id);
  return planPromotion(held);
}

module.exports = { catalog, roles, ladder, steps, allHelpers, RuleError, compareRoles, planPromotion, parsePromotion, preview };
