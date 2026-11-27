'use strict';

const {OverwriteType, PermissionFlagsBits:P, PermissionOverwrites, PermissionsBitField} = require('discord.js');
const isId = id => typeof id === 'string' && /^\d{17,20}$/u.test(id);
const isBits = value => typeof value === 'string' && /^\d{1,40}$/u.test(value);
const access = P.ViewChannel | P.Connect;
const empty = (id,type) => ({id,type,allow:0n,deny:0n});
const apply = (bits,over) => over ? ((bits & ~over.deny) | over.allow) : bits;
const bad = () => { throw new TypeError('Invalid temporary voice ACL snapshot'); };

function parseRoles(rows,guildId) {
  if (!Array.isArray(rows)) bad();
  const roles = new Map();
  for (const row of rows) {
    if (!isId(row?.id) || !isBits(row.permissions) || roles.has(row.id)) bad();
    roles.set(row.id,PermissionsBitField.resolve(row.permissions));
  }
  if (!roles.has(guildId)) bad();
  return roles;
}

function parseOverwrites(rows,guildId,roles) {
  if (!Array.isArray(rows) || rows.length > 100) bad();
  const map = new Map();
  for (const row of rows) {
    if (!isId(row?.id) || map.has(row.id) || !isBits(row.allow) || !isBits(row.deny) ||
        ![OverwriteType.Role,OverwriteType.Member].includes(row.type) ||
        ((row.type === OverwriteType.Role) !== roles.has(row.id)) || (row.id === guildId && row.type !== OverwriteType.Role)) bad();
    const allow = PermissionsBitField.resolve(row.allow), deny = PermissionsBitField.resolve(row.deny);
    if (allow & deny) bad();
    map.set(row.id,{id:row.id,type:row.type,allow,deny});
  }
  return map;
}

function serializeOverwrites(map) {
  if (map.size > 100) bad();
  return [...map.values()].filter(row => row.allow || row.deny).sort((a,b) => a.id.localeCompare(b.id))
    .map(row => PermissionOverwrites.resolve(row));
}
const sameOverwrites = (a,b) => JSON.stringify(serializeOverwrites(a)) === JSON.stringify(serializeOverwrites(b));

function aclPolicy({guildId,ownerId,roleRows,categoryRows,botId}) {
  if (!isId(ownerId) || !isId(botId)) bad();
  const roles = parseRoles(roleRows,guildId);
  const parse = rows => parseOverwrites(rows,guildId,roles);
  const baseline = parse(categoryRows);
  const everyone = baseline.get(guildId);
  const roleEntries = [...baseline.values()].filter(row => row.type === OverwriteType.Role && row.id !== guildId);
  const allRoleDenies = roleEntries.reduce((all,row) => all | (row.deny & ~row.allow),0n);
  const publicFloor = apply(roles.get(guildId),everyone) & ~allRoleDenies;

  function permissions(rows,member) {
    const id = member.user.id;
    if (!isId(id) || !Array.isArray(member.roles)) bad();
    const assigned = new Set(member.roles);
    let bits = roles.get(guildId);
    for (const roleId of assigned) {
      if (!roles.has(roleId) || roleId === guildId) bad();
      bits |= roles.get(roleId);
    }
    if (id === ownerId || (bits & P.Administrator)) return PermissionsBitField.All;
    let allow = 0n, deny = 0n;
    for (const roleId of assigned) {
      const row = rows.get(roleId);
      if (row) { allow |= row.allow; deny |= row.deny; }
    }
    return apply((apply(bits,rows.get(guildId)) & ~deny) | allow,rows.get(id));
  }
  const has = (rows,member,flags) => (permissions(rows,member) & flags) === flags;
  const eligible = member => has(baseline,member,access);
  const stableAccess = id => (apply(publicFloor,baseline.get(id)) & access) === access;
  function render(record) {
    const next = new Map([...baseline].map(([id,row]) => [id,{...row}]));
    if (record.privacy !== 'open') {
      // Voice chat and voice visibility share ViewChannel; Connect-only would still expose private chat.
      for (const row of next.values()) row.allow &= ~access;
      const publicRow = next.get(guildId) ?? empty(guildId,OverwriteType.Role);
      publicRow.deny |= access;
      next.set(guildId,publicRow);
      for (const id of new Set([record.ownerId,botId,...record.trusted,...record.invited])) {
        // User overwrites run after all role overwrites. Never mint this exception if role
        // reassignment (including losing all roles) could make it wider than the category.
        if (!stableAccess(id)) continue;
        const row = next.get(id) ?? empty(id,OverwriteType.Member);
        if (row.type !== OverwriteType.Member || (row.deny & access)) bad();
        row.allow |= access;
        next.set(id,row);
      }
    }
    for (const id of record.blocked) {
      if (id === record.ownerId || id === botId) bad();
      const row = next.get(id) ?? empty(id,OverwriteType.Member);
      if (row.type !== OverwriteType.Member) bad();
      row.allow &= ~access;
      row.deny |= access;
      next.set(id,row);
    }
    return next;
  }
  return {parse,baseline,render,has,eligible,stableAccess};
}

module.exports = {access,aclPolicy,sameOverwrites,serializeOverwrites};
