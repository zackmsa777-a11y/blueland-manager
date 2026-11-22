'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {parseEnv}=require('node:util');
const {setTimeout:wait}=require('node:timers/promises');
const {REST,Routes}=require('discord.js');
const {DatabaseSync}=require('node:sqlite');
const {compareRoles}=require('../src/ladder');
const {exportCsv}=require('../src/directory');
const root=path.resolve(__dirname,'..');
const file=path.join(root,'config/catalog.json');

function planRebind(saved,raw,now=new Date().toISOString()) {
  const live=new Map(raw.map(r=>[r.id,r]));
  const byName=new Map();
  const oldCounts=new Map();
  const link=new Map();
  const matched=new Map();
  const issues=[];
  const keyRoles=new Set(saved.categories.flatMap(c=>[...c.ranks,...c.helpers,c.variant]));
  for (const r of saved.roles) oldCounts.set(r.name,(oldCounts.get(r.name)||0)+1);
  for (const r of raw) {
    if (!byName.has(r.name)) byName.set(r.name,[]);
    byName.get(r.name).push(r);
  }
  for (const old of saved.roles) {
    let role=live.get(old.id);
    if (!role) {
      const candidates=byName.get(old.name) || [];
      if (oldCounts.get(old.name)===1 && candidates.length===1 && !old.managed && !candidates[0].managed) role=candidates[0];
    }
    if (role && matched.has(role.id)) { issues.push(old.label+' — ظهر المعرّف لاسمين'); continue; }
    if (keyRoles.has(old.id)) {
      if (!role) { issues.push(old.label+' — مفقود أو اسمه مكرر'); continue; }
      const color=role.color?'#'+Number(role.color).toString(16).padStart(6,'0'):null;
      if (role.managed || role.permissions!==old.permissions || (role.id!==old.id && old.color!==color)) {
        issues.push(old.label+' — تغيرت خصائص الرول'); continue;
      }
    }
    if (role) { link.set(old.id,role.id); matched.set(role.id,old); }
  }
  const keyOrder=saved.roles.filter(r=>keyRoles.has(r.id)).sort(compareRoles).map(r=>link.get(r.id));
  if (keyOrder.every(Boolean)) {
    const sorted=keyOrder.map(id=>live.get(id)).sort(compareRoles).map(r=>r.id);
    if (sorted.some((id,i)=>id!==keyOrder[i])) issues.push('تغيّر ترتيب درجات الطاقم أو رولات الصلاحيات فيما بينها.');
  }
  const ordered=[...raw].sort(compareRoles);
  const bot=raw.find(r=>r.tags?.bot_id===saved.botId);
  const blocked=saved.categories.flatMap(c=>c.ranks).filter(id=>link.has(id) && (!bot || compareRoles(bot,live.get(link.get(id)))>=0))
    .map(id=>saved.roles.find(r=>r.id===id).label);
  if (issues.length) return {issues,blocked};
  const categories=saved.categories.map(c=>({...c,base:link.get(c.base),ranks:c.ranks.map(id=>link.get(id)),helpers:c.helpers.map(id=>link.get(id)),variant:link.get(c.variant)}));
  const aliases={};
  for (const [from,previous] of Object.entries(saved.roleAliases || {})) if (link.has(previous)) aliases[from]=link.get(previous);
  for (const [from,to] of link) if (from!==to) aliases[from]=to;
  const roles=ordered.map((r,i)=>{
    const old=matched.get(r.id);
    const divider=/ــــ|━━━━/u.test(r.name);
    const kind=old?.kind || (r.managed ? (r.tags?.bot_id?'bot':'integration') : divider?'divider':'other');
    const group=categories.find(c=>compareRoles(live.get(c.ranks.at(-1)),r)<=0 && compareRoles(r,live.get(c.base))<=0);
    return {id:r.id,name:r.name,label:kind==='rank'?r.name.replace(/^[-❛❝\s]+|[-:\s]+$/gu,'').trim():r.name,
      color:r.color?'#'+Number(r.color).toString(16).padStart(6,'0'):null,position:r.position,order:i+1,managed:r.managed,
      permissions:String(r.permissions),category:old?.category || null,section:old?.section || (divider?'فواصل':group?.name || 'رولات إضافية'),kind};
  });
  return {issues,blocked,policyCount:keyRoles.size,rebound:[...keyRoles].filter(id=>link.get(id)!==id).length,catalog:{...saved,capturedAt:now,categories,roles,roleAliases:aliases}};
}
function stableSignature(raw) {
  return JSON.stringify([...raw].sort(compareRoles).map(r=>[r.id,r.name,r.position,r.permissions,r.color,r.managed]));
}
function atomicWrite(destination,text) {
  const pending=destination+'.'+process.pid+'.tmp';
  fs.writeFileSync(pending,text,{flag:'wx'});
  try { fs.renameSync(pending,destination); } finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}
async function main() {
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  const privateFile=process.env.BLUELAND_ENV_FILE;
  const secret=privateFile?parseEnv(fs.readFileSync(path.resolve(root,privateFile),'utf8')).DISCORD_BOT_TOKEN:process.env.DISCORD_BOT_TOKEN;
  if (!secret) throw Error('أضف توكن البوت إلى إعداداته المحلية.');
  const rest=new REST({version:'10'}).setToken(secret.trim());
  const me=await rest.get(Routes.user());
  if (me.id!==saved.botId) throw Error('الحساب ليس بوت BlueLand Manager.');
  const get=()=>rest.get(Routes.guildRoles(saved.guildId));
  const raw=await get();
  const apply=process.argv.includes('--apply');
  if (apply) {
    await wait(6500);
    if (stableSignature(raw)!==stableSignature(await get())) throw Error('الرولات ما زالت تتغيّر في ديسكورد. أعد الفحص بعد اكتمال الترتيب.');
  }
  const result=planRebind(saved,raw);
  console.log(JSON.stringify({guild:saved.guildId,live:raw.length,policy:result.policyCount,rebound:result.rebound,issues:result.issues,aboveBot:result.blocked},null,2));
  if (result.issues.length) {process.exitCode=2;return;}
  if (!apply) return;
  const dbFile=process.env.DATABASE_PATH || path.join(root,'data/blueland.sqlite');
  if (result.rebound && fs.existsSync(dbFile)) {
    const db=new DatabaseSync(dbFile,{readOnly:true});
    try {
      if (db.prepare("SELECT 1 FROM promotions WHERE state='pending' LIMIT 1").get()) throw Error('توجد ترقية قديمة قيد التنفيذ. راجع السجل قبل تبديل المعرّفات.');
    } finally {db.close();}
  }
  atomicWrite(file,JSON.stringify(result.catalog,null,2)+'\n');
  atomicWrite(path.join(root,'config/BlueLand-roles.csv'),exportCsv(result.catalog));
  console.log('حُفظت المعرّفات محليًا. أعد تشغيل BlueLand Manager لتحميلها.');
}
if (require.main===module) main().catch(err=>{console.error(err.code || err.message);process.exitCode=1;});
module.exports={planRebind,stableSignature};
