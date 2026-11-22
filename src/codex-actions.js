'use strict';
const {ChannelType,PermissionFlagsBits:P} = require('discord.js');
const {catalog,RuleError}=require('./ladder');
const {commands,chatAliases}=require('./commands');
const {runFeature}=require('./codex-feature');

const native=new Set(['server','roles','ping','help','rank','top','promote','demote','warn','unwarn','timeout','untimeout','mute','unmute','lock','unlock','kick','ban','unban']);
const operations=[...native,'say','create_text','create_voice','create_category','create_forum','create_stage','create_announcement','move_channel','rename_channel','delete_channel','topic','slowmode','create_role','rename_role','role_color','role_permissions','delete_role','give_role','take_role','nickname','voice_move','voice_disconnect','voice_mute','voice_deafen','react','create_thread','archive_thread','pin','unpin','delete_message','save_command','forget_command'];
operations.push('vps_status','vps_restart','vps_deploy','vps_release','note_save','note_forget','workspace_files','workspace_read','workspace_edit','workspace_command');
const destructive=new Set(['delete_channel','delete_role','delete_message','role_permissions','ban','kick','forget_command','vps_deploy']);
const reserved=new Set(['vps','memory','ذاكرة','code','history','سجل','model','موديل','session','جلسة','new','جديد','usage','استخدام','steer','وجه','لوحة','ترقية','تخفيض','نشر','انشر',...Object.keys(chatAliases),...Object.values(chatAliases),...commands.map(c=>c.name)]);
const managedRanks=new Set(catalog.categories.flatMap(g=>[...g.ranks,g.variant,...g.helpers]));
const id=value=>{if (!/^\d{17,20}$/.test(value)) throw new RuleError('معرّف الهدف غير صالح.'); return value;};
function featureName(value) {
  const name=value.normalize('NFC').toLowerCase().replace(/^\+/,'');
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)||reserved.has(name)) throw new RuleError('اسم الأمر محجوز أو غير صالح.');
  return name;
}
function bounded(value,min,max) {
  if (!/^\d+$/.test(value) || +value<min || +value>max) throw new RuleError('القيمة الرقمية خارج النطاق.');
  return +value;
}
function inspectActions(actions) {
  if (!Array.isArray(actions)||actions.length>12) throw new RuleError('تعذّر قراءة إجراءات Codex.');
  for (const a of actions) {
    if (!a||!operations.includes(a.op)||['target','value','extra'].some(k=>typeof a[k]!=='string'||a[k].length>(a.op==='workspace_edit'?9000:a.op==='save_command'&&k==='extra'?6000:1800))) throw new RuleError('اقترح Codex إجراء غير مدعوم.');
  }
  return actions;
}
async function applyAction(a,{guild,actor,channel,delivery,run,store}) {
  const reason='BlueLand Codex · '+actor+' · '+delivery;
  const target=a.target, val=a.value;
  async function room(roomId) {
    const c=await guild.channels.fetch(id(roomId));
    if (!c || c.guildId!==guild.id) throw new RuleError('الروم غير موجود في BlueLand.');
    return c;
  }
  const actorMember=await guild.members.fetch({user:actor,force:true});
  if (actorMember.user.bot || !actorMember.permissions.has(P.Administrator)) throw new RuleError('هذا الأمر للمسؤولين فقط.',403);
  const owner=actor===guild.ownerId;
  async function role(roleId) {
    const r=await guild.roles.fetch(id(roleId),{force:true});
    if (!r||!r.editable||r.managed||r.id===guild.id||(!owner&&actorMember.roles.highest.comparePositionTo(r)<=0))
      throw new RuleError('الرول خارج حدود صلاحياتك أو صلاحيات البوت.');
    if (managedRanks.has(r.id)) throw new RuleError('هذا رول من سلّم BlueLand. استخدم الترقية أو التخفيض.');
    return r;
  }
  async function member(userId) {
    const m=await guild.members.fetch({user:id(userId),force:true});
    if (!m.manageable||m.user.bot||m.id===actor||m.id===guild.ownerId||(!owner&&actorMember.roles.highest.comparePositionTo(m.roles.highest)<=0))
      throw new RuleError('العضو خارج حدود صلاحياتك أو صلاحيات البوت.');
    return m;
  }
  if (native.has(a.op)) {
    return run({action:a.op,actor,delivery,channel:a.op==='lock'||a.op==='unlock'?(target||channel):channel,
      target:target||undefined,reason:val,minutes:a.op==='timeout'?bounded(a.extra,1,40320):undefined,
      caseId:a.op==='unwarn'?bounded(a.extra,1,2147483647):undefined,created:Date.now()});
  }
  if (a.op==='save_command') {
    const name=featureName(target);
    if (!val.trim()) throw new RuleError('أضف وصفًا لما يفعله الأمر.');
    if (a.extra) await runFeature(a.extra,{},true);
    store.save(name,val,a.extra); return 'حُفظ الأمر +'+name;
  }
  if (a.op==='forget_command') {
    const name=featureName(target);
    if (!store.remove(name)) throw new RuleError('الأمر غير موجود.');
    return 'حُذف الأمر +'+name;
  }
  if (a.op.startsWith('create_') && a.op!=='create_thread') {
    if (!val.trim()||val.length>100) throw new RuleError('اختر اسمًا من ١ إلى ١٠٠ حرف.');
    if (a.op==='create_role') {
      const r=await guild.roles.create({name:val,permissions:[],reason});
      return 'تم إنشاء الرول '+r.name+' ('+r.id+').';
    }
    const types={create_text:ChannelType.GuildText,create_voice:ChannelType.GuildVoice,create_category:ChannelType.GuildCategory,
      create_forum:ChannelType.GuildForum,create_stage:ChannelType.GuildStageVoice,create_announcement:ChannelType.GuildAnnouncement};
    const parent=target?await room(target):null;
    if (parent&&(parent.type!==ChannelType.GuildCategory||a.op==='create_category')) throw new RuleError('الفئة المحددة غير صالحة.');
    const c=await guild.channels.create({name:val,type:types[a.op],parent:parent?.id,reason});
    return 'تم إنشاء <#'+c.id+'>.';
  }
  if (a.op==='give_role'||a.op==='take_role') {
    const m=await member(target), r=await role(val);
    await m.roles[a.op==='give_role'?'add':'remove'](r,reason); return 'تم تحديث رول '+r.name+' للعضو '+m.id+'.';
  }
  if (['rename_role','delete_role','role_color','role_permissions'].includes(a.op)) {
    const r=await role(target);
    if (a.op==='delete_role') await r.delete(reason);
    if (a.op==='rename_role') await r.setName(val,reason);
    if (a.op==='role_color') {
      if (!/^#[0-9a-f]{6}$/i.test(val)) throw new RuleError('اكتب اللون بصيغة #RRGGBB.');
      await r.setColor(val,reason);
    }
    if (a.op==='role_permissions') {
      const names=val.split(/[, ]+/).filter(Boolean);
      if (!names.every(k=>Object.hasOwn(P,k))) throw new RuleError('اسم صلاحية Discord غير معروف.');
      await r.setPermissions(names.map(k=>P[k]),reason);
    }
    return 'تم تنفيذ '+a.op+' على '+target+'.';
  }
  if (a.op==='nickname') { await (await member(target)).setNickname(val||null,reason); return 'تم تحديث لقب العضو.'; }
  if (a.op.startsWith('voice_')) {
    const m=await member(target);
    if (!m.voice.channelId) throw new RuleError('العضو غير متصل بروم صوتي.');
    if (a.op==='voice_disconnect') await m.voice.disconnect(reason);
    if (a.op==='voice_move') await m.voice.setChannel(await room(val),reason);
    if (a.op==='voice_mute'||a.op==='voice_deafen') {
      if (!['on','off'].includes(val)) throw new RuleError('اختر on أو off.');
      await m.voice[a.op==='voice_mute'?'setMute':'setDeaf'](val==='on',reason);
    }
    return 'تم تحديث حالة العضو الصوتية.';
  }
  const c=await room(target||channel);
  if (a.op==='say') { if (!c.isSendable()||!val.trim()) throw new RuleError('تعذّر إرسال الرسالة.'); await c.send({content:val,allowedMentions:{parse:[]}}); }
  else if (a.op==='rename_channel') await c.setName(val,reason);
  else if (a.op==='delete_channel') await c.delete(reason);
  else if (a.op==='topic') await c.setTopic(val,reason);
  else if (a.op==='move_channel') {
    const parent=await room(val);
    if (parent.type!==ChannelType.GuildCategory) throw new RuleError('اختر فئة صحيحة.');
    await c.setParent(parent.id,{lockPermissions:false,reason});
  }
  else if (a.op==='create_thread') await c.threads.create({name:val,type:ChannelType.PublicThread,reason});
  else if (a.op==='archive_thread') { if (!c.isThread()) throw new RuleError('اختر سلسلة رسائل.'); await c.setArchived(true,reason); }
  else if (a.op==='slowmode') await c.setRateLimitPerUser(bounded(val,0,21600),reason);
  else {
    const m=await c.messages.fetch(id(val));
    if (a.op==='react') await m.react(a.extra);
    else if (a.op==='pin') await m.pin(); else if (a.op==='unpin') await m.unpin(); else await m.delete();
  }
  return 'تم تنفيذ '+a.op+' على '+c.id+'.';
}
module.exports={applyAction,inspectActions,operations,destructive,featureName};
