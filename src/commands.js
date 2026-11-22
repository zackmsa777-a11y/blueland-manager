'use strict';

const {Routes} = require('discord.js');
const {catalog,roles,RuleError} = require('./ladder');
const {kinds,requestStates} = require('./community');

const option=(type,name,description,required=true,extra={})=>({type,name,description,required,...extra});
const sub=(name,description,options=[])=>({type:1,name,description,options});
const cmd=(name,description,options=[])=>({type:1,name,description,options});
const person=()=>option(6,'member','العضو في سيرفر BlueLand');
const reason=(required=true)=>option(3,'reason','سبب الإجراء',required,{max_length:350});
const number=(name,description,max=2147483647)=>option(4,name,description,true,{min_value:1,max_value:max});
const id=()=>number('id','رقم السجل');
const commands=[
  cmd('ping','افحص اتصال BlueLand Manager'),cmd('help','دليل أوامر BlueLand'),
  cmd('server','معلومات سيرفر BlueLand'),cmd('roles','عدد الرولات وفئات الترقية'),
  cmd('promote','ترقية عضو درجة واحدة',[person()]),cmd('dashboard','احصل على رمز دخول لوحة الطاقم'),
  cmd('warn','سجّل تحذيرًا على عضو',[person(),reason()]),cmd('unwarn','اسحب تحذيرًا برقمه',[person(),id(),reason()]),
  cmd('warnings','التحذيرات النشطة للعضو',[person()]),
  cmd('timeout','أوقف تفاعل عضو مؤقتًا في السيرفر',[person(),number('minutes','المدة بالدقائق، حتى ٢٨ يومًا',40320),reason()]),
  cmd('untimeout','أزل التايم أوت عن عضو',[person(),reason(false)]),
  cmd('mute','امنع عضوًا من الكتابة في الروم الحالي',[person(),reason()]),
  cmd('unmute','استعد أذونات كتابة العضو في هذا الروم',[person(),reason(false)]),
  cmd('lock','أوقف كتابة @everyone في الروم الحالي',[reason()]),cmd('unlock','استعد إذن كتابة الروم السابق',[reason(false)]),
  cmd('kick','اطرد عضوًا من السيرفر',[person(),reason()]),cmd('ban','احظر عضوًا من السيرفر',[person(),reason()]),
  cmd('unban','ارفع حظر عضو بمعرّفه',[option(3,'user_id','المعرّف الرقمي للعضو',true,{min_length:17,max_length:20}),reason()]),
  cmd('request','طلبات الأعضاء وتقديم الطاقم',[
    sub('submit','قدّم طلبًا للطاقم',[option(3,'kind','نوع الطلب',true,{choices:Object.entries(kinds).map(([value,name])=>({name,value}))}),option(3,'details','سبب الطلب أو نص التقديم',true,{min_length:1,max_length:650})]),
    sub('status','راجع طلباتك وقرارات الطاقم'),sub('cancel','اسحب طلبك المفتوح',[id()]),sub('pending','اعرض قائمة انتظار الطاقم'),
    sub('approve','اقبل الطلب ونفّذ ترقيته إن لزم',[id(),reason(false)]),sub('reject','ارفض الطلب مع توضيح السبب',[id(),reason()])
  ]),
  cmd('ticket','افتح تذكرة دعم خاصة أو أدرها',[
    sub('create','افتح تذكرة خاصة مع الدعم',[option(3,'subject','موضوع التذكرة',true,{min_length:1,max_length:200})]),
    sub('claim','استلم التذكرة الحالية'),sub('unclaim','أعد التذكرة إلى قائمة الانتظار'),
    sub('close','أغلق الكتابة واحتفظ بسجل التذكرة'),sub('reopen','أعد فتح التذكرة الحالية')
  ]),
  cmd('rank','اعرض مستوى النشاط',[option(6,'member','العضو، أو اتركه فارغًا لعرض مستواك',false)]),
  cmd('top','اعرض الأعضاء الأكثر نشاطًا')
];
const chatAliases={
  'تخفيض':'demote','بنق':'ping','مساعدة':'help','اوامر':'help','أوامر':'help','رولات':'roles','سيرفر':'server','مستوى':'rank','توب':'top',
  'تحذير':'warn','سحب-تحذير':'unwarn','تحذيرات':'warnings','تايم':'timeout','فك-تايم':'untimeout',
  'ميوت':'mute','فك-ميوت':'unmute','قفل':'lock','فتح':'unlock','طرد':'kick','حظر':'ban','فك-حظر':'unban'
};
const helpText=[
  '**أوامر BlueLand Empire**',
  'الطاقم · +ترقية @العضو، +تخفيض @العضو، /promote، /dashboard',
  'Codex · للمسؤولين: منشن البوت أو رد على رسالته. +model يعرض الموديل ودرجة التفكير.',
  'الإشراف · /warn، /warnings، /unwarn، /mute، /unmute، /timeout، /untimeout، /lock، /unlock، /kick، /ban، /unban',
  'الطلبات · /request submit للتقديم، /request status لمتابعة القرار',
  'الدعم · /ticket create لفتح تذكرة خاصة ثم claim أو close من داخلها',
  'السيرفر · /roles، /server، /ping، /rank، /top'
].join('\n');
function parseChat(text) {
  if (!text.startsWith('+')) return null;
  const [first,...parts]=text.slice(1).trim().split(/\s+/u);
  const action=chatAliases[first] || (Object.values(chatAliases).includes(first)?first:null);
  if (!action) return null;
  if (action === 'demote' && (parts.length !== 1 || !/^<@!?\d{17,20}>$/.test(parts[0]))) throw new RuleError('اكتب +تخفيض مع منشن عضو واحد.');
  if (['ping','help','server','roles','top'].includes(action)) return {action};
  if (['lock','unlock'].includes(action)) return {action,reason:parts.join(' ')};
  if (action==='rank' && !parts.length) return {action};
  const token=parts.shift() || '';
  const match=/^<@!?(\d{17,20})>$/.exec(token) || (action==='unban' && /^(\d{17,20})$/.exec(token));
  if (!match) throw new RuleError('اذكر عضوًا واحدًا، أو استخدم /'+action+' لعرض الخانات المطلوبة.');
  const input={action,target:match[1]};
  if (action==='timeout') input.minutes=Number(parts.shift());
  if (action==='unwarn') input.caseId=Number(parts.shift());
  input.reason=parts.join(' ');
  return input;
}

function commandRunner({store,community,promotions,readyGuild,pair}) {
  const db=store.community;
  return async function run(input) {
    const {action,actor,delivery,channel}=input;
    if (action==='ping') return 'BlueLand Manager متصل. زمن استجابة ديسكورد '+Math.max(0,Math.round(readyGuild().client.ws.ping))+' ms.';
    if (action==='help') return helpText;
    if (action==='server') { const g=readyGuild(); return g.name+' · '+g.memberCount+' أعضاء · '+g.roles.cache.size+' رول.'; }
    if (action==='roles') return readyGuild().roles.cache.size+' رول في BlueLand، منها '+catalog.categories.reduce((sum,c)=>sum+c.ranks.length,0)+' درجة. الفئات بالترتيب:\n'+catalog.categories.map(c=>c.name).join(' ← ');
    if (action==='dashboard') return pair(actor);
    if (action==='promote' || action==='demote') {
      const entry=await promotions.execute({id:delivery,actor,target:input.target,source:'discord',direction:action});
      return (action==='demote'?'تم تخفيض':'تمت ترقية')+' <@'+input.target+'> إلى **'+roles.get(entry.plan.to).label+'**.';
    }
    if (action==='rank' || action==='top') {
      if (!db.settings().levels) throw new RuleError('نظام المستويات متوقف. يمكن لإدارة السيرفر تفعيله من لوحة الطاقم.');
      if (action==='rank') { const target=input.target || actor; const xp=db.xp(target); return '<@'+target+'> · المستوى '+Math.floor(xp/100)+' · '+xp+' نقطة.'; }
      return db.top().map((r,i)=>(i+1)+'. <@'+r.member+'> · '+r.xp+' نقطة').join('\n') || 'تظهر قائمة النشاط بعد أول مشاركة مؤهلة.';
    }
    if (action==='request') {
      if (input.sub==='cancel') {
        if (!db.cancel(input.id,actor)) throw new RuleError('يمكنك سحب طلب تملكه ما دام بانتظار المراجعة.',409);
        return 'سُحب الطلب #'+input.id+'.';
      }
      if (input.sub==='submit') {
        const row=await community.submit({actor,delivery,kind:input.kind,body:input.details});
        return 'وصل طلب '+kinds[row.kind]+' برقم **'+row.id+'**. تابعه باستخدام /request status.';
      }
      if (input.sub==='status' || input.sub==='pending') {
        const own=input.sub==='status';
        if (!own) await community.reviewer(actor);
        const rows=own?db.requests(actor):db.requests().filter(r=>r.state==='pending');
        return rows.slice(0,12).map(r=>'#'+r.id+' · '+kinds[r.kind]+' · '+requestStates[r.state]+(r.decision?' · '+r.decision.slice(0,90):'')).join('\n') || 'قائمة الطلبات فارغة.';
      }
      const r=await community.review(actor,input.id,input.sub,input.reason);
      return 'الطلب #'+r.id+' · '+requestStates[r.state]+'.';
    }
    if (action==='ticket') {
      if (input.sub==='create') {
        const row=await community.openTicket(actor,delivery,input.subject);
        return 'تذكرتك #'+row.id+' في <#'+row.channel+'>.';
      }
      const ticket=db.ticketByChannel(channel);
      if (!ticket) throw new RuleError('استخدم هذا الإجراء داخل روم التذكرة.');
      const row=await community.ticketAction(actor,ticket.id,input.sub);
      const states={claim:'استلمت التذكرة',unclaim:'أُعيدت التذكرة إلى قائمة الانتظار',close:'أُغلقت التذكرة',reopen:'أُعيد فتح التذكرة'};
      return states[input.sub]+' #'+row.id+'.';
    }
    const result=await community.moderate({...input,reason:input.reason || (action==='warnings'?'عرض التحذيرات':'')});
    if (action==='warnings') return result.map(r=>'#'+r.id+' · '+r.reason.slice(0,90)).slice(0,12).join('\n') || 'ما فيه تحذيرات نشطة لهذا العضو.';
    return 'تم تنفيذ '+action+' · سجل الإشراف #'+result.id+'.';
  };
}
function interactionInput(i) {
  const o=i.options;
  return {action:i.commandName,sub:o.getSubcommand(false),actor:i.user.id,channel:i.channelId,delivery:'slash:'+i.id,created:i.createdTimestamp,
    target:o.getUser('member')?.id || o.getString('user_id'),minutes:o.getInteger('minutes'),id:o.getInteger('id'),caseId:o.getInteger('id'),
    reason:o.getString('reason'),subject:o.getString('subject'),kind:o.getString('kind'),details:o.getString('details')};
}
function shape(item) {
  return {type:item.type,name:item.name,description:item.description,required:item.required || false,
    min_value:item.min_value,max_value:item.max_value,min_length:item.min_length,max_length:item.max_length,
    choices:(item.choices || []).map(c=>({name:c.name,value:c.value})),options:(item.options || []).map(shape)};
}
async function registerCommands(client,guildId,definitions=commands) {
  const endpoint=Routes.applicationGuildCommands(client.user.id,guildId);
  const current=await client.rest.get(endpoint);
  for (const def of definitions) {
    const previous=current.find(c=>c.type===def.type && c.name===def.name);
    if (!previous) await client.rest.post(endpoint,{body:def});
    else if (JSON.stringify(shape(previous))!==JSON.stringify(shape(def))) {
      await client.rest.patch(Routes.applicationGuildCommand(client.user.id,guildId,previous.id),{body:def});
    }
  }
  const live=await client.rest.get(endpoint);
  return definitions.filter(def=>live.some(c=>JSON.stringify(shape(c))===JSON.stringify(shape(def)))).length;
}
module.exports={commands,chatAliases,helpText,parseChat,commandRunner,interactionInput,registerCommands};
