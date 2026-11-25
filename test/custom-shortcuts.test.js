'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {PermissionFlagsBits:P}=require('discord.js');
const {openStore}=require('../src/store');
const {parseShortcut,commandGuide}=require('../src/custom-shortcuts');
const {createShortcutHandler}=require('../src/shortcut-dispatch');
const {createMessageHandler}=require('../src/chat');
const {createCommunity}=require('../src/community');
const {createApp}=require('../src/server');
const {catalog,roles}=require('../src/ladder');
const {createDiscordGames}=require('../src/discord-games');

const actor='123456789012345678', other='123456789012345679', owner='123456789012345680', channel='123456789012345681', mod='123456789012345682';
const target=`<@${other}>`;

test('registered guide includes staff points and SQLite shortcuts are global, unique and persistent',()=>{
  const folder=mkdtempSync(join(tmpdir(),'blueland-alias-test-'));
  try{
    const file=join(folder,'alias.db');let store=openStore(file);
    assert.equal(commandGuide(store.shortcuts).length,41);
    assert.ok(commandGuide(store.shortcuts).some(c=>c.name==='/points'));
    assert.equal(commandGuide(store.shortcuts).find(c=>c.name==='/promote').example,'+ترقية @العضو 2');
    assert.equal(commandGuide(store.shortcuts).find(c=>c.name==='+تخفيض').example,'+تخفيض @العضو 3');
    assert.deepEqual(store.shortcuts.add('مرسيدس','/ban',actor),{phrase:'مرسيدس',command:'/ban'});
    store.shortcuts.add('Mercedes Red','/kick',actor);
    store.shortcuts.add('Mercedes','/ban',actor);
    assert.throws(()=>store.shortcuts.add('مرسيدس','/kick',actor),{status:409});
    assert.throws(()=>store.shortcuts.add('بان','/kick',actor),{status:409});
    assert.throws(()=>store.shortcuts.add('مرسيدس','/release',actor));
    store.close();store=openStore(file);
    assert.equal(store.shortcuts.match('مرسيدس').spec.action,'ban');
    assert.equal(store.shortcuts.match('MERceDES  red '+target+' test').spec.action,'kick');
    assert.equal(store.shortcuts.match('مرسيدس عربية حلوة'),null);
    assert.equal(store.shortcuts.match('مرسيدسات'),null);
    assert.equal(store.shortcuts.match('+بان '+target+' test'),null);
    assert.deepEqual(parseShortcut(store.shortcuts.match('تف '+target+' سبب اختباري')),{action:'ban',sub:null,target:other,reason:'سبب اختباري'});
    assert.deepEqual(parseShortcut(store.shortcuts.match('تف '+target)),{action:'ban',sub:null,target:other});
    assert.deepEqual(parseShortcut(store.shortcuts.match('برا '+target)),{action:'kick',sub:null,target:other});
    assert.equal(commandGuide(store.shortcuts).find(c=>c.name==='/ban').options.find(o=>o.name==='reason').required,false);
    assert.throws(()=>parseShortcut(store.shortcuts.match('تف')),{message:'الاستخدام: `تف @العضو [السبب]`'});
    store.shortcuts.add('ارفع عضو','/promote',actor);store.shortcuts.add('اخفض عضو','+تخفيض',actor);
    assert.equal(parseShortcut(store.shortcuts.match('ارفع عضو '+target+' 2')).count,2);
    assert.equal(parseShortcut(store.shortcuts.match('اخفض عضو '+target+' 3')).count,3);
    store.shortcuts.add('طلب جديد','/request submit',actor);
    assert.deepEqual(parseShortcut(store.shortcuts.match('طلب جديد "general" تفاصيل الطلب')),{action:'request',sub:'submit',kind:'general',details:'تفاصيل الطلب'});
    assert.equal(store.shortcuts.match('طلب جديد ممكن لو سمحت'),null);
    store.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});

test('alias moderation checks real BlueLand actor permissions before usage and delegates final checks',async t=>{
  const store=openStore(':memory:'); t.after(()=>store.close());
  let privileged=false, actions=[], replies=[], xp=0;
  const guildRoles=new Map(roles);
  guildRoles.set(mod,{id:mod,permissions:String(P.BanMembers|P.KickMembers),position:2});
  const community=createCommunity(store,{context:async id=>({actor:{id,bot:false,roles:privileged?[mod]:[]},ownerId:owner,roles:guildRoles})},{});
  const run=async input=>{actions.push(input);return 'نتيجة اختبار فقط';};
  const handle=createShortcutHandler({shortcuts:store.shortcuts,community,run});
  const onMessage=createMessageHandler({store:{community:{settings:()=>({levels:true}),addXp(){xp++}}},shortcuts:handle});
  const send=content=>onMessage({content,author:{id:actor},inGuild:()=>true,guildId:catalog.guildId,channelId:channel,id:'123',createdTimestamp:10,
    reply:async response=>replies.push(response)});
  await send('تف');await send('تف '+target+' تجربة');await send('برا '+target+' تجربة');
  assert.deepEqual(replies,[]);assert.deepEqual(actions,[]);
  privileged=true;
  await send('تف');assert.equal(replies[0].content,'الاستخدام: `تف @العضو [السبب]`');assert.deepEqual(replies[0].allowedMentions,{parse:[],repliedUser:false});
  await send('تف '+target+' تجربة');assert.deepEqual(actions,[{action:'ban',sub:null,target:other,reason:'تجربة',actor,channel,delivery:'discord:123',created:10}]);
  await send('تف مش أمر');assert.equal(actions.length,1);assert.equal(replies.length,2);assert.equal(xp,1);
});

test('one-letter unlock shortcuts require channel management permission',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());
  assert.deepEqual(store.shortcuts.add('ف','/unlock',actor),{phrase:'ف',command:'/unlock'});
  assert.throws(()=>store.shortcuts.add('ف','/unlock',actor),{status:409});
  for(const phrase of [' ','+ف','/ف','1']) assert.throws(()=>store.shortcuts.add(phrase,'/unlock',actor));

  let privileged=false;
  const actions=[], guildRoles=new Map(roles);
  guildRoles.set(mod,{id:mod,permissions:String(P.ManageChannels),position:2});
  const community=createCommunity(store,{context:async id=>({actor:{id,bot:false,roles:privileged?[mod]:[]},ownerId:owner,roles:guildRoles})},{});
  const handle=createShortcutHandler({shortcuts:store.shortcuts,community,run:async input=>{actions.push(input.action);return 'اختبار فقط';}});
  const message={author:{id:actor},channelId:channel,id:'123',createdTimestamp:10,reply:async()=>{}};
  assert.equal(await handle(message,'ف'),true);
  assert.deepEqual(actions,[]);
  privileged=true;
  assert.equal(await handle(message,'ف كلام عادي'),false);
  assert.equal(await handle(message,'ف'),true);
  assert.deepEqual(actions,['unlock']);
});

test('private shortcut results use DM, and game shortcuts reuse real game renderer',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());
  store.shortcuts.add('اريني الحقيبة','/game bag',actor);
  store.shortcuts.add('رول جماعية','/game roulette',actor);
  const games=createDiscordGames(store.roulette);const handle=createShortcutHandler({shortcuts:store.shortcuts,games});
  const privateSent=[], sent=[];
  const msg={channelId:channel,author:{id:actor,username:'Tester',async send(p){privateSent.push(p)}},async reply(p){sent.push(p);return {id:'game-test'}}};
  t.after(()=>games.removeRoom(channel));
  assert.equal(await handle(msg,'اريني الحقيبة'),true);assert.equal(sent.length,0);assert.match(privateSent[0].content,/حقيبة الروليت/);
  assert.equal(await handle(msg,'رول جماعية'),true);assert.equal(sent[0].files[0].name,'roulette.png');
});

test('dot shortcuts open every guild game and keep the roulette bag and shop private',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());
  const games=createDiscordGames(store.roulette);
  const shortcuts=createShortcutHandler({shortcuts:store.shortcuts,games});
  const onMessage=createMessageHandler({store,shortcuts});
  const publicMessages=[], dms=[], channels=[];
  t.after(()=>channels.forEach(id=>games.removeRoom(id)));
  const send=(content,fromGuild=true,guildId=catalog.guildId)=>{
    const channelId=String(BigInt(channel)+BigInt(channels.length));
    channels.push(channelId);
    return onMessage({content,channelId,guildId,inGuild:()=>fromGuild,createdTimestamp:Date.now(),
      author:{id:actor,username:'Tester',async send(p){dms.push(p)}},async reply(p){publicMessages.push(p);return {id:channelId}}});
  };
  for(const [alias,kind] of [['.روليت','roulette'],['.كراسي','chairs'],['.مافيا','mafia'],['.حجر','rps']]) {
    await send(alias);
    assert.equal(publicMessages.at(-1).files[0].name,kind+'.png');
    assert.ok(commandGuide(store.shortcuts).find(c=>c.name==='/game '+kind).chat.includes(alias));
  }
  for(const phrase of ['.حجر-ورقة-مقص','.حجر ورقة مقص']) assert.equal(store.shortcuts.match(phrase).spec.sub,'rps');
  await send('.حقيبة');await send('.متجر');
  assert.deepEqual(dms.map(p=>p.content.split('\n')[0]),['**🎒 حقيبة الروليت**','**🛒 متجر الروليت**']);
  await send('.روليت الآن');await send('.غير-معروف');await send('.روليت',false);await send('.روليت',true,'elsewhere');
  assert.equal(publicMessages.length,4);assert.equal(dms.length,2);
});

test('HTTP shortcut creation requires authenticated config rights and same-origin input',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());
  let granted=true, gateCalls=0;
  const discord={dashboardAccess:async id=>({id,rights:{config:granted&&id===actor}}),community:{async manager(id){assert.equal(id,actor);gateCalls++;}}};
  // Production uses HTTPS at the proxy; use the HTTP listener locally.
  const app=createApp({store,discord});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>new Promise(r=>app.close(r)));
  const base='http://127.0.0.1:'+app.address().port;
  const cookie='bl_session='+store.redeem(store.loginCode(actor));
  const post=(headers,phrase='مرسيدس')=>fetch(base+'/api/command-shortcuts',{method:'POST',headers:{origin:base,'content-type':'application/json',...headers},body:JSON.stringify({phrase,command:'/ban'})});
  assert.equal((await post({})).status,401);
  assert.equal((await post({cookie,origin:'https://example.invalid'})).status,403);
  granted=false;assert.equal((await post({cookie})).status,403);assert.equal(gateCalls,0);
  granted=true;const save=await post({cookie});assert.equal(save.status,201);assert.deepEqual(await save.json(),{phrase:'مرسيدس',command:'/ban'});
  assert.equal((await post({cookie})).status,409);
  const res=await fetch(base+'/api/command-guide',{headers:{cookie}});const body=await res.json();
  assert.equal(body.canEdit,true);assert.deepEqual(body.commands.find(c=>c.name==='/ban').custom.sort(),['تف','مرسيدس'].sort());
});
