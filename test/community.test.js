'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {PermissionFlagsBits:P}=require('discord.js');
const {catalog,roles,RuleError}=require('../src/ladder');
const {openStore}=require('../src/store');
const {makeService}=require('../src/promotions');
const {createCommunity}=require('../src/community');
const {commands,commandRunner,registerCommands,parseChat}=require('../src/commands');
const {createMessageHandler}=require('../src/chat');
const {createApp}=require('../src/server');
const {planRebind}=require('../scripts/rebind-roles');
const {communityGateway}=require('../src/discord-community');
const {ladderIssue}=require('../src/directory');

const owner='200000000000000001', member='200000000000000002', helper='200000000000000003', outsider='200000000000000004', channel='200000000000000005';
const [staff,mod]=catalog.categories;
function fixture(t) {
  const store=openStore(':memory:'); t.after(()=>store.close());
  const members=new Map([[owner,[]],[member,[]],[helper,[staff.base, ...staff.helpers]],[outsider,[]]]);
  const botRole=catalog.roles.find(r=>r.name==='BlueLand Manager' && r.managed);
  const person=id=>({id,name:'اسم '+id.slice(-2),bot:false,roles:members.get(id) || []});
  const calls=[];
  const g={
    async context(a,b=a) {return {actor:person(a),target:person(b),bot:{id:catalog.botId,bot:true,roles:[botRole.id]},ownerId:owner,roles};},
    async change(e,id,add) {const set=new Set(members.get(e.target));if(add)set.add(id);else set.delete(id);members.set(e.target,[...set]);},
    async roomPermission(x) {calls.push(x.action);},async memberAction(x) {calls.push([x.action,x.target,x.expiry]);},
    async ticketRoom() {calls.push('create');return channel;},async ticketWriting(row,write) {calls.push(write?'writable':'readonly');},
    async validateSettings() {},async destinations() {return [];}
  };
  const service=makeService(store,g);
  const community=createCommunity(store,g,service);
  const run=commandRunner({store,community,promotions:service,readyGuild:()=>({client:{ws:{ping:17}},roles:{cache:{size:catalog.roles.length}}}),pair:async()=> 'private'});
  return {store,g,service,community,run,members,calls};
}
test('matched recreated roles require unique names, original grants and all relative hierarchy positions',()=>{
  const saved=catalog;
  const raw=saved.roles.map(r=>({...r,color:r.color?parseInt(r.color.slice(1),16):0,tags:r.name==='BlueLand Manager'?{bot_id:saved.botId}:{}}));
  const x=raw.find(r=>r.id===staff.base);
  x.id='290000000000000001';
  const good=planRebind(saved,raw);
  assert.deepEqual(good.issues,[]);assert.equal(good.rebound,1);
  assert.equal(good.catalog.categories[0].base,x.id);
  assert.equal(good.catalog.roleAliases[staff.base],x.id);
  assert.ok(planRebind(saved,[...raw,{...x,id:'290000000000000002'}]).issues.length);
  assert.ok(planRebind(saved,raw.filter(r=>r.id!==mod.helpers[0])).issues.length);
  assert.ok(planRebind(saved,raw.map(r=>r===x?{...x,permissions:'8'}:r)).issues.length);
  assert.ok(planRebind(saved,raw.map(r=>r===x?{...x,position:999}:r)).issues.length);
});
test('a delegated New Staff warning does not allow timeouts, self moderation or a repeated case',async t=>{
  const h=fixture(t), request={delivery:'evt1',actor:helper,target:member,action:'warn',reason:'مخالفة'};
  assert.equal((await h.community.moderate(request)).id,(await h.community.moderate(request)).id);
  assert.equal(h.store.community.cases(member).length,1);
  await assert.rejects(h.community.moderate({...request,delivery:'b',target:helper}),{status:403});
  await assert.rejects(h.community.moderate({...request,delivery:'c',action:'timeout',minutes:5}),{status:403});
  const modRole=mod.helpers[0];h.members.get(helper).push(modRole);
  await h.community.moderate({...request,delivery:'d',action:'timeout',minutes:5,created:Date.now()});
  assert.equal(h.calls[0][0],'timeout');
  await assert.rejects(h.community.moderate({...request,delivery:'e',action:'unwarn',caseId:999}),{status:409});
  await h.community.moderate({...request,delivery:'f',action:'unwarn',caseId:1});
  const warnings=await h.community.moderate({...request,action:'warnings'});assert.deepEqual(warnings,[]);
  assert.equal(h.store.community.cases(member).length,3);
});

test('optional reasons default in audit and Discord calls without relaxing moderation permissions',async t=>{
  const h=fixture(t);
  const applied=[];
  h.g.memberAction=async entry=>applied.push(entry);
  const input={actor:owner,target:member};
  const banned=await h.community.moderate({...input,action:'ban',delivery:'no-ban-reason'});
  const kicked=await h.community.moderate({...input,action:'kick',delivery:'blank-kick-reason',reason:'  '});
  const muted=await h.community.moderate({...input,action:'mute',channel,delivery:'provided-reason',reason:'  إزعاج  '});
  assert.deepEqual([banned.reason,kicked.reason,muted.reason],['بأمر المسؤول','بأمر المسؤول','إزعاج']);
  assert.deepEqual(applied.map(entry=>entry.reason),['بأمر المسؤول','بأمر المسؤول']);
  await assert.rejects(h.community.moderate({actor:outsider,target:member,action:'ban',delivery:'denied'}),{status:403});
  await assert.rejects(h.community.moderate({...input,action:'timeout',delivery:'no-duration'}),/مدة التايم أوت/);
  await assert.rejects(h.community.moderate({...input,action:'kick',delivery:'long-reason',reason:'x'.repeat(351)}),/350/);
  for(const name of ['warn','unwarn','timeout','untimeout','mute','unmute','lock','unlock','kick','ban','unban','بان','طرد']) {
    assert.equal(commands.find(def=>def.name===name).options.find(opt=>opt.name==='reason').required,false,name);
  }
  assert.equal(commands.find(def=>def.name==='request').options.find(opt=>opt.name==='reject').options.find(opt=>opt.name==='reason').required,true);
});

test('removing any helper or raising its native permission bits blocks a partial restored ladder',()=>{
  const live=new Map(roles);assert.equal(ladderIssue(live),'');
  live.delete(mod.helpers[0]);assert.ok(ladderIssue(live));
  live.set(mod.helpers[0],{...roles.get(mod.helpers[0]),permissions:String(P.Administrator)});
  assert.ok(ladderIssue(live));
});
test('channel mute and unmute restore only the previous write permissions',async t=>{
  const h=fixture(t);let allow=P.AddReactions | P.SendMessages, deny=P.EmbedLinks;
  const writes=[]; const rest={async put(route,{body}) {allow=BigInt(body.allow);deny=BigInt(body.deny);writes.push(body);}};
  const role=()=>({has:()=>true});
  const ch={type:0,guildId:catalog.guildId,permissionsFor:role,
    permissionOverwrites:{cache:{get:()=>({allow:{bitfield:allow},deny:{bitfield:deny}})}}};
  const guild={id:catalog.guildId,channels:{fetch:async()=>ch},members:{fetch:async()=>({}),me:{}},client:{rest}};ch.guild=guild;
  const gateway=communityGateway(()=>guild,h.g.context);
  const ctx=await h.g.context(helper,member);
  const args={ctx,channel,target:member,db:h.store.community,reason:'اختبار'};
  await gateway.roomPermission({...args,action:'mute'});
  assert.equal(allow & P.SendMessages,0n);assert.ok(deny & P.SendMessages);
  allow|=P.MentionEveryone;
  await gateway.roomPermission({...args,action:'unmute'});
  assert.equal(allow,P.AddReactions|P.SendMessages|P.MentionEveryone);assert.equal(deny,P.EmbedLinks);assert.equal(writes.length,2);
});
test('application review and promotion share the promotion engine and reject stale or self approval',async t=>{
  const h=fixture(t); const req={actor:member,kind:'application',body:'طلب تطوع',delivery:'request:1'};
  const r=await h.community.submit(req);
  await assert.rejects(h.community.submit({...req,delivery:'request:2'}),{status:409});
  await assert.rejects(h.community.review(member,r.id,'approve',''),{status:403});
  const approved=await h.community.review(owner,r.id,'approve','تم'); assert.equal(approved.state,'approved');
  assert.ok(h.members.get(member).includes(staff.base));assert.ok(staff.helpers.every(id=>h.members.get(member).includes(id)));
  await assert.rejects(h.community.review(owner,r.id,'approve',''),{status:409});
  const next=await h.community.submit({...req,kind:'promotion',delivery:'request:3'});
  await h.service.execute({id:'intervening',actor:owner,target:member,source:'discord'});
  await assert.rejects(h.community.review(owner,next.id,'approve',''),{status:409});
  const pending=h.store.community.request(next.id);assert.equal(pending.state,'pending');assert.equal(pending.reviewer,null);
  assert.equal(h.store.community.cancel(next.id,outsider),0);assert.equal(h.store.community.cancel(next.id,member),1);
  assert.equal(h.store.history().length,2);
});
test('private tickets only let staff claim, honor one open ticket and preserve the closed record',async t=>{
  const h=fixture(t);
  const row=await h.community.openTicket(member,'t1','موضوع');
  assert.equal((await h.community.openTicket(member,'t2','تذكرتي')).id,row.id);assert.deepEqual(h.calls,['create']);
  await assert.rejects(h.community.ticketAction(outsider,row.id,'claim'),{status:403});
  h.members.get(helper).push(h.store.community.settings().supportRole);
  assert.equal((await h.community.ticketAction(helper,row.id,'claim')).assignee,helper);
  await assert.rejects(h.community.ticketAction(outsider,row.id,'close'),{status:403});
  assert.equal((await h.community.ticketAction(member,row.id,'close')).state,'closed');
  await assert.rejects(h.community.ticketAction(member,row.id,'reopen'),{status:403});
  assert.equal((await h.community.ticketAction(helper,row.id,'reopen')).state,'open');
  assert.deepEqual(h.calls,['create','readonly','writable']);
});
test('ticket creation sends private member, bot and support overwrites in the channel creation request',async t=>{
  const h=fixture(t);const created=[];const s=h.store.community.settings();
  const guild={id:catalog.guildId,client:{user:{id:catalog.botId}},roles:{fetch:async()=>({id:s.supportRole,managed:false})},
    channels:{fetch:async()=>({find:()=>null}),create:async opts=>{created.push(opts);return {id:channel};}}};
  const gateway=communityGateway(()=>guild,h.g.context);
  assert.equal(await gateway.ticketRoom({id:5,owner:member,subject:'خاص'},s),channel);
  const rules=created[0].permissionOverwrites;
  assert.ok(rules.find(r=>r.id===catalog.guildId).deny.includes(P.ViewChannel));
  assert.ok([member,catalog.botId,s.supportRole].every(id=>rules.find(r=>r.id===id).allow & P.ViewChannel));
});
test('XP cooldown survives repeat delivery, and only a server manager changes shared settings',async t=>{
  const h=fixture(t),db=h.store.community;
  await assert.rejects(h.community.saveSettings(helper,{...db.settings(),levels:true}),{status:403});
  await h.community.saveSettings(owner,{...db.settings(),levels:true});
  const handle=createMessageHandler({store:h.store,run:h.run,parse:parseChat,service:h.service,authorize:h.community.dashboard});
  const msg={inGuild:()=>true,guildId:catalog.guildId,author:{id:member,bot:false},content:'رسالة',reply:async()=>{}};
  for (const n of [100000,100000,159999,160000]) await handle({...msg,createdTimestamp:n});
  assert.equal(db.xp(member),20);assert.equal(db.top()[0].member,member);
  const replies=[];await handle({...msg,inGuild:()=>false,guildId:null,content:'+ping',reply:async data=>replies.push(data.content)});
  await handle({...msg,inGuild:()=>false,guildId:null,content:'+warn <@'+member+'> سبب',reply:async data=>replies.push(data.content)});
  assert.equal(replies.length,1);assert.match(replies[0],/17 ms/);
});
test('command registration preserves unrelated commands and does not write unchanged definitions',async()=>{
  const collection=[{id:'1',type:1,name:'existing',description:'exists'}];
  let edits=0,posts=0;
  const client={user:{id:catalog.botId},rest:{get:async()=>collection,post:async(_,{body})=>{collection.push({...body,id:String(collection.length+1)});posts++;},patch:async()=>{edits++;}}};
  assert.equal(await registerCommands(client,catalog.guildId),commands.length);
  assert.equal(await registerCommands(client,catalog.guildId),commands.length);
  assert.equal(posts,commands.length);assert.equal(edits,0);assert.equal(collection[0].name,'existing');
});
test('the actual dashboard rejects unauthorized request decisions and serves authorized settings and queues',async t=>{
  const h=fixture(t);
  const discord={community:h.community,dashboardAccess:h.community.dashboard,authorize:h.community.reviewer,directory:async()=>catalog,destinations:async()=>[],status:()=>({code:'online'}),service:h.service};
  const app=createApp({store:h.store,discord});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
  const origin='http://127.0.0.1:'+app.address().port;
  const send=(route,input,cookie)=>fetch(origin+route,{method:'POST',headers:{origin,'content-type':'application/json',cookie:cookie||''},body:JSON.stringify(input)});
  assert.equal((await fetch(origin+'/api/staff')).status,401);
  const login=await send('/api/session',{code:h.store.loginCode(owner)});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const r=await h.community.submit({actor:member,kind:'general',body:'اقتراح',delivery:'web-req'});
  const desk=await (await fetch(origin+'/api/staff',{headers:{cookie}})).json();
  assert.equal(desk.requests[0].id,r.id);assert.equal(desk.rights.config,true);
  assert.equal((await send('/api/staff/request',{id:r.id,decision:'reject',reason:'غير مكتمل'},cookie)).status,200);
  const low=await send('/api/session',{code:h.store.loginCode(helper)});const lowCookie=low.headers.get('set-cookie').split(';')[0];
  assert.equal((await send('/api/staff/settings',{...h.store.community.settings(),levels:true},lowCookie)).status,403);
  assert.equal((await fetch(origin+'/api/history',{headers:{cookie:lowCookie}})).status,403);
});
