'use strict';

const {RuleError,catalog}=require('./ladder');

// Lux and Rust, identified by their Discord accounts in the server.
const editors=new Set(['1486306919324057682','1235369589408399392']);
const canEditCommandRoles=actor=>editors.has(actor);

function commandKey({action,sub,audience}) {
  if (action==='demote') return '+تخفيض';
  if (action==='bulk-role') return audience==='bots'?'+ر البوتات':'+ر الجميع';
  return '/'+action+(sub?' '+sub:'');
}

function openCommandRoles(db) {
  db.exec('CREATE TABLE IF NOT EXISTS command_roles (command TEXT PRIMARY KEY, role TEXT NOT NULL)');
  const read=db.prepare('SELECT role FROM command_roles WHERE command=?');
  const required=command=>read.get(command)?.role ?? null;
  return {
    required,
    list:()=>new Map(db.prepare('SELECT command,role FROM command_roles').all().map(row=>[row.command,row.role])),
    save(actor,command,role,previous) {
      if (!canEditCommandRoles(actor)) throw new RuleError('تعديل رول الأمر متاح لـLux وRust فقط.',403);
      if (!require('./custom-shortcuts').isGuideCommand(command)) throw new RuleError('اختر أمرًا من الدليل.');
      const valid=id=>id===null || (typeof id==='string' && /^\d{17,20}$/u.test(id) && id!==catalog.guildId);
      if (!valid(role) || !valid(previous)) throw new RuleError('اختر رولًا صالحًا من السيرفر.');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (required(command)!==previous) throw new RuleError('تغيّر رول الأمر. حدّث الصفحة قبل الحفظ.',409);
        if (role===null) db.prepare('DELETE FROM command_roles WHERE command=?').run(command);
        else db.prepare('INSERT INTO command_roles VALUES(?,?) ON CONFLICT(command) DO UPDATE SET role=excluded.role').run(command,role);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return {command,roleId:role};
    }
  };
}

function commandRoleChecker(rules,getMember) {
  return async function checkCommandRole(actor,input) {
    const key=commandKey(input);
    if (!rules.required(key)) return;
    let member;
    try { member=await getMember(actor); }
    catch { throw new RuleError('تعذّر التحقق من رولك في السيرفر.',403); }
    const role=rules.required(key);
    if (role && (!member?.user || member.user.id!==actor || member.user.bot || !Array.isArray(member.roles) || !member.roles.includes(role)))
      throw new RuleError('استخدام هذا الأمر يحتاج الرول المحدد له في دليل الأوامر.',403);
  };
}
module.exports={canEditCommandRoles,commandKey,openCommandRoles,commandRoleChecker};
