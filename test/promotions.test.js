'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { catalog, roles, ladder, preview, planPromotion, parsePromotion, compareRoles } = require('../src/ladder');
const { makeService } = require('../src/promotions');
const { openStore } = require('../src/store');
const { createApp } = require('../src/server');
const { createMessageHandler } = require('../src/chat');
const { liveDirectory, exportCsv } = require('../src/directory');

const [staff, mod, owners, admins, ship, ownership] = catalog.categories;
const currentId = id => catalog.roleAliases?.[id] || id;
const magistr = currentId('1573998733841137754');
const targetId = '200000000000000001';
const actorId = '200000000000000002';
const botRole = '1573988437088932015';
const unrelated = currentId('1573998906478559294');
const managerRole = currentId('1573998308433731694');

function harness(t, store, initial = [staff.base, magistr, ...staff.helpers, unrelated]) {
  if (!store) { store = openStore(':memory:'); t.after(() => store.close()); }
  const targetRoles = new Set(initial);
  const liveRoles = new Map([...roles].map(([id,role]) => [id,{...role}]));
  const actor = { id:actorId, name:'مسؤول اختباري', bot:false, roles:[managerRole] };
  const bot = { id:catalog.botId, name:'BlueLand Manager', bot:true, roles:[botRole] };
  const calls = [];
  const gateway = {
    async context() {
      return { actor, bot, target:{ id:targetId, name:'عضو اختباري', bot:false, roles:[...targetRoles] },
        ownerId:'200000000000000003', roles:liveRoles };
    },
    async change(entry, id, add) {
      calls.push([id,add]);
      if (add) targetRoles.add(id); else targetRoles.delete(id);
    }
  };
  const service = makeService(store,gateway);
  const request = { id:'discord:sample', actor:actorId, target:targetId, source:'discord' };
  return { store, service, request, gateway, liveRoles, calls, actor, bot, targetRoles };
}

test('the published inventory matches the six server ranges and Discord tie ordering',() => {
  assert.ok(catalog.roles.length >= 97);
  assert.equal(roles.size,catalog.roles.length);
  assert.deepEqual(catalog.categories.map(c=>c.ranks.length),[14,15,15,16,15,11]);
  assert.equal(ladder.length,86);
  assert.deepEqual(catalog.roles,[...catalog.roles].sort(compareRoles));
  assert.equal(staff.base,currentId('1573998768456470611'));
  assert.equal(staff.ranks.at(-1),magistr);
  assert.equal(roles.get(mod.helpers[0]).name,'timeout/untimeout');
});

test('the native chat prefix accepts one Discord mention and an optional whole number',() => {
  const mention = '<@'+targetId+'>';
  assert.deepEqual(parsePromotion('+ترقية '+mention),{target:targetId,count:1});
  assert.deepEqual(parsePromotion(' +ترقية   <@!'+targetId+'> '),{target:targetId,count:1});
  assert.deepEqual(parsePromotion('+ترقية <@1216830648480960552> 2'),{target:'1216830648480960552',count:2});
  assert.equal(parsePromotion('ترقية '+mention),null);
  for (const text of ['+ترقية','+ترقية @everyone','+ترقية '+mention+' <@'+actorId+'>','+ترقية <@&'+actorId+'>']) {
    assert.throws(()=>parsePromotion(text),/منشن عضو واحد/);
  }
  for (const count of ['0','-1','1.5','2e1','Infinity','2 3',String(ladder.length+1),'99999999999999999999']) {
    assert.throws(()=>parsePromotion('+ترقية '+mention+' '+count));
  }
});

test('numbered chat promotion crosses categories in one audited operation without granting intermediate ranks',async t=>{
  const h = harness(t,null,[staff.variant,magistr,...staff.helpers,unrelated]);
  const handle = createMessageHandler({service:h.service,store:h.store});
  const replies = [];
  const message = {id:'1574000000000000012',guildId:catalog.guildId,inGuild:()=>true,webhookId:null,
    content:'+ترقية <@'+targetId+'> 2',author:{id:actorId,bot:false},reply:async data=>replies.push(data)};
  const expected = mod.ranks[1];
  await handle(message);
  const writes = h.calls.length;
  await handle(message);
  assert.equal(h.calls.length,writes);
  assert.equal(h.store.history().length,1);
  const row = h.store.byId('discord:'+message.id);
  assert.equal(row.state,'done');
  assert.equal(row.plan.from,magistr);
  assert.equal(row.plan.to,expected);
  assert.equal(row.plan.count,2);
  assert.deepEqual(new Set(h.targetRoles),new Set([mod.variant,expected,...staff.helpers,...mod.helpers,unrelated]));
  assert.ok(!h.calls.some(([id,add])=>add && id===mod.base));
  assert.equal(replies.length,2);
  assert.ok(replies.every(reply=>reply.content.includes(roles.get(expected).label) && reply.content.includes('عدد الدرجات: **2**')));
  await assert.rejects(h.service.execute({...h.request,id:row.id,count:3}),/مستخدم لطلب آخر/);
});

test('numbered discord demotion keeps authorization and delivers one audited role change',async t=>{
  const {commandRunner,parseChat} = require('../src/commands');
  const h = harness(t,null,[mod.variant,mod.ranks[1],...staff.helpers,...mod.helpers,unrelated]);
  const run = commandRunner({store:h.store,promotions:h.service});
  const handle = createMessageHandler({service:h.service,store:h.store,run,parse:parseChat});
  const replies = [];
  const message = {id:'1574000000000000013',guildId:catalog.guildId,inGuild:()=>true,webhookId:null,
    content:'+تخفيض <@'+targetId+'> 2',author:{id:actorId,bot:false},reply:async data=>replies.push(data)};
  await handle(message);
  assert.match(replies[0].content,/Administrator/);
  assert.equal(h.calls.length,0);
  assert.equal(h.store.history().length,0);
  const getContext = h.gateway.context;
  h.gateway.context = async (...args)=>({...await getContext(...args), ownerId:actorId});
  await handle(message);
  const writes = h.calls.length;
  await handle(message);
  assert.equal(h.calls.length,writes);
  assert.equal(h.store.history().length,1);
  const row = h.store.byId('discord:'+message.id);
  assert.equal(row.state,'done');
  assert.equal(row.plan.direction,'demote');
  assert.equal(row.plan.count,2);
  assert.equal(row.plan.from,mod.ranks[1]);
  assert.equal(row.plan.to,magistr);
  assert.deepEqual(h.targetRoles,new Set([staff.variant,magistr,...staff.helpers,unrelated]));
  assert.ok(!h.calls.some(([id,add])=>add && (id===mod.base || id===mod.variant)));
  assert.match(replies[1].content,/تم تخفيض.*Magistr.*عدد الدرجات: \*\*2\*\*/);
});

test('multi-step promotion rejects overshooting the ceiling and a forbidden destination before any write',async t=>{
  const nearTop = harness(t,null,[ownership.base,ownership.ranks.at(-2),...ladder.at(-1).helpers]);
  await assert.rejects(nearTop.service.execute({...nearTop.request,count:2}),/الدرجات المتاحة لهذا العضو: 1/);
  assert.equal(nearTop.calls.length,0);
  assert.equal(nearTop.store.history().length,0);
  const blocked = harness(t);
  blocked.liveRoles.get(mod.ranks[1]).managed = true;
  await assert.rejects(blocked.service.execute({...blocked.request,count:2}),/مُدارًا/);
  assert.equal(blocked.calls.length,0);
  assert.equal(blocked.store.history().length,0);
});

test('recovery of a numbered promotion resumes its saved destination and count',async t=>{
  const h = harness(t);
  const change = h.gateway.change;
  h.gateway.change = async (...args)=>{
    if (h.calls.length===2) throw new Error('simulated disconnect');
    return change(...args);
  };
  const request = {...h.request,count:2};
  await assert.rejects(h.service.execute(request),/simulated disconnect/);
  assert.equal(h.store.pending(targetId).plan.count,2);
  h.gateway.change = change;
  const resumed = makeService(h.store,h.gateway);
  await resumed.recover();
  const entry = await resumed.execute(request);
  assert.equal(entry.state,'done');
  assert.equal(entry.plan.to,mod.ranks[1]);
  assert.equal(h.store.history().length,1);
  assert.deepEqual(new Set(h.targetRoles),new Set([mod.base,mod.ranks[1],...staff.helpers,...mod.helpers,unrelated]));
});

test('Discord message delivery, replay and private dashboard pairing use the real message handler',async t=>{
  const h=harness(t);
  const replies=[], dms=[];
  const handle=createMessageHandler({authorize:async id=>assert.equal(id,actorId),service:h.service,store:h.store});
  const message={ id:'1574000000000000011', guildId:catalog.guildId, inGuild:()=>true, webhookId:null,
    content:'+ترقية <@'+targetId+'>', author:{id:actorId,bot:false,send:async text=>dms.push(text)},
    reply:async data=>replies.push(data) };
  await handle({...message,guildId:'123'});
  await handle({...message,author:{...message.author,bot:true}});
  assert.equal(replies.length,0);
  await handle(message);
  await handle(message);
  assert.equal(h.store.history().length,1);
  assert.match(replies[0].content,/Magistr.*BlueLand Mod/);
  assert.deepEqual(replies[0].allowedMentions,{parse:[],repliedUser:false});
  await handle({...message,content:'+ترقية'});
  assert.match(replies.at(-1).content,/منشن عضو واحد/);
  await handle({...message,content:'+لوحة'});
  assert.equal(dms.length,1);
  const code=dms[0].match(/[a-f0-9]{24}/)[0];
  assert.ok(!replies.at(-1).content.includes(code));
  assert.equal(h.store.actor(h.store.redeem(code)),actorId);
});

test('the directory reflects live additions and renames without adding unapproved promotion grades',()=>{
  const raw=catalog.roles.map(r=>({...r,color:parseInt((r.color || '#000000').slice(1),16)}));
  const custom='1574004999999999999';
  raw.push({id:custom,name:'=SUM(1)',position:2,color:123,managed:false,permissions:'0'});
  raw.find(r=>r.id===magistr).name='❛ Magistr II :';
  const directory=liveDirectory(raw,'2026-11-22T10:00:00Z');
  assert.equal(directory.roles.length,catalog.roles.length+1);
  assert.equal(directory.roles.find(r=>r.id===magistr).label,'Magistr II');
  assert.equal(directory.roles.find(r=>r.id===custom).kind,'other');
  assert.ok(!directory.categories.some(c=>c.ranks.includes(custom)));
  assert.match(exportCsv(directory),/"'=SUM\(1\)"/);
  assert.equal(directory.warning,'');
  const removed=liveDirectory(raw.filter(r=>r.id!==magistr));
  assert.match(removed.warning,/تغيّر سلّم/);
  assert.equal(removed.missingPolicyRoles[0].id,magistr);
});

test('all 86 steps preserve unrelated roles, inherit all five permissions and stop at the ceiling',() => {
  const held = new Set([unrelated]);
  for (const step of ladder) {
    const plan = planPromotion(held);
    assert.equal(plan.to,step.id);
    for (const id of plan.add) { assert.equal(roles.get(id).managed,false); held.add(id); }
    for (const id of plan.remove) held.delete(id);
    for (const helper of step.helpers) assert.ok(held.has(helper));
    assert.ok(held.has(unrelated));
    assert.ok(held.has(step.group.base));
    assert.ok(held.has(step.id));
  }
  assert.equal(ladder.at(-1).helpers.length,5);
  assert.ok(!held.has('1573998349705810010')); // Full Perm is not a promotion.
  assert.throws(()=>planPromotion(held),/آخر درجة/);
});

test('Magistr to Mod grants timeout while mute and warn stay held',() => {
  const p = preview(magistr);
  assert.equal(p.to,mod.base);
  assert.deepEqual(p.helpers,[...staff.helpers,...mod.helpers]);
  assert.deepEqual(p.add,[mod.base,...mod.helpers]);
  assert.deepEqual(new Set(p.remove),new Set([staff.base,magistr]));
  assert.deepEqual(preview(owners.ranks.at(-1)).add,[admins.base,...admins.helpers]);
  assert.deepEqual(preview(admins.ranks.at(-1)).add,[ship.base,...ship.helpers]);
  assert.deepEqual(preview(ship.ranks.at(-1)).add,[ownership.base]);
  assert.throws(()=>planPromotion([staff.ranks[1],magistr]),/متعارضة/);
});

test('an existing Girls variant follows the equivalent category on a boundary',async t => {
  const h = harness(t, null, [magistr,staff.variant,...staff.helpers,unrelated]);
  const result = await h.service.execute(h.request);
  assert.equal(result.plan.to,mod.base);
  assert.equal(result.plan.anchor,mod.variant);
  assert.ok(h.targetRoles.has(mod.variant));
  assert.ok(!h.targetRoles.has(mod.base));
  assert.ok(!h.targetRoles.has(staff.variant));
  assert.ok(h.targetRoles.has(mod.helpers[0]));
  const next = await h.service.execute({...h.request,id:'discord:second'});
  assert.equal(next.plan.to,mod.ranks[1]);
  assert.ok(h.targetRoles.has(mod.variant));
});

test('duplicate delivery is idempotent and stale dashboard previews cannot advance twice',async t => {
  const h = harness(t);
  const first = await h.service.execute({...h.request,expectedFrom:magistr});
  const count = h.calls.length;
  const second = await h.service.execute(h.request);
  assert.equal(first.id,second.id);
  assert.equal(count,h.calls.length);
  await assert.rejects(h.service.execute({...h.request,id:'web:stale',expectedFrom:magistr}),/تغيّرت درجة/);
  assert.equal(h.store.history().length,1);
  assert.ok(h.targetRoles.has(unrelated));
});

test('overlapping requests cannot promote two degrees', async t => {
  const h = harness(t);
  let release;
  const gate = new Promise(resolve=>{ release=resolve; });
  const load = h.gateway.context;
  h.gateway.context = async (...args)=>{ await gate; return load(...args); };
  const request = h.service.execute(h.request);
  const duplicate = h.service.execute(h.request);
  await assert.rejects(h.service.execute({...h.request,id:'discord:other'}),/يجري تنفيذ/);
  release();
  await Promise.all([request,duplicate]);
  assert.equal(h.store.history().length,1);
});

test('a partial Discord failure survives restart and restores only the planned role delta',async t => {
  const folder=mkdtempSync(path.join(tmpdir(),'blueland-test-'));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const filename=path.join(folder,'state.sqlite');
  const db=openStore(filename);
  const h=harness(t,db);
  const original=h.gateway.change;
  h.gateway.change=async(...args)=>{
    if (h.calls.length===1) throw new Error('simulated disconnect');
    return original(...args);
  };
  await assert.rejects(h.service.execute(h.request),/simulated disconnect/);
  assert.equal(db.pending(targetId).plan.to,mod.base);
  assert.equal(db.history()[0].state,'pending');
  db.close();
  const reopened=openStore(filename);
  try {
    const extra='1573998909464903873';
    h.targetRoles.add(extra); // A separate Discord moderator changes an unrelated role mid-request.
    h.gateway.change=original;
    const resumed=makeService(reopened,h.gateway);
    await resumed.recover();
    const result=await resumed.execute(h.request);
    assert.equal(result.state,'done');
    assert.equal(result.plan.from,magistr);
    assert.ok(h.targetRoles.has(extra));
    assert.ok(h.targetRoles.has(mod.helpers[0]));
    assert.ok(!h.targetRoles.has(magistr));
    assert.ok(!h.targetRoles.has(mod.ranks[1]));
    assert.equal(reopened.history().length,1);
  } finally { reopened.close(); }
});

test('actor, bot hierarchy, changed privilege bits, managed roles and missing steps are checked before any write',async t => {
  const h=harness(t);
  h.actor.roles=[];
  await assert.rejects(h.service.execute(h.request),/المخوّلين/);
  h.actor.roles=[managerRole];
  h.targetRoles.add(botRole);
  await assert.rejects(h.service.execute(h.request),/أعلى رول/);
  h.targetRoles.delete(botRole);
  h.liveRoles.get(mod.helpers[0]).permissions='8';
  await assert.rejects(h.service.execute(h.request),/صلاحيات رول/);
  h.liveRoles.get(mod.helpers[0]).permissions='0';
  h.liveRoles.get(mod.base).managed=true;
  await assert.rejects(h.service.execute(h.request),/حُذف/);
  h.liveRoles.get(mod.base).managed=false;
  h.liveRoles.delete(staff.ranks[1]);
  await assert.rejects(h.service.execute(h.request),/تغيّر سلّم/);
  assert.equal(h.calls.length,0);
  assert.equal(h.store.history().length,0);
});

test('session code, dashboard preview, commit, history and logout use the normal HTTP entry points',async t => {
  const h=harness(t);
  const discord={ status:()=>({code:'online',text:'متصل'}), service:h.service,
    authorize:async id=>{ assert.equal(id,actorId); return {id,name:'مشرف'}; } };
  const app=createApp({store:h.store,discord});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const origin='http://127.0.0.1:'+app.address().port;
  const post=(route,input,cookie,from=origin)=>fetch(origin+route,{method:'POST',headers:{
    'content-type':'application/json',origin:from,...(cookie?{cookie}:{})},body:JSON.stringify(input)});
  assert.equal((await fetch(origin+'/api/history')).status,401);
  assert.equal((await post('/api/promote',{})).status,401);
  assert.equal((await post('/api/session',{},null,'https://elsewhere.example')).status,403);
  const code=h.store.loginCode(actorId);
  const signed=await post('/api/session',{code});
  assert.equal(signed.status,200);
  const cookie=signed.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/session',{code})).status,401);
  const pre=await post('/api/member-preview',{target:'<@'+targetId+'>'},cookie);
  assert.equal(pre.status,200);
  const plan=await pre.json();
  assert.equal(plan.plan.to, mod.base);
  const body={target:targetId,expectedFrom:plan.plan.from,requestId:plan.requestId};
  assert.equal((await post('/api/promote',body,cookie)).status,200);
  assert.equal((await post('/api/promote',body,cookie)).status,200);
  const log=await (await fetch(origin+'/api/history',{headers:{cookie}})).json();
  assert.equal(log.length,1);
  assert.equal(log[0].source,'dashboard');
  assert.equal((await post('/api/logout',{},cookie)).status,200);
  assert.equal((await fetch(origin+'/api/history',{headers:{cookie}})).status,401);
});
