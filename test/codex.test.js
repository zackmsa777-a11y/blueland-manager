'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/store');
const {catalog,ladder,planPromotion}=require('../src/ladder');
const {createCodexHandler}=require('../src/codex-chat');
const {featureName,inspectActions}=require('../src/codex-actions');
const {parseChat}=require('../src/commands');
const bot=catalog.botId, actor='200000000000000001', channel='200000000000000002';

test('only the registered administrator and actual owner have Codex access',()=>{
  const {hasCodexAccess}=require('../src/promotions');
  const role={id:'123',position:1,permissions:'8'};
  const ctx={actor:{id:'someone',roles:['123'],bot:false},ownerId:'owner',operatorId:actor,roles:new Map([['123',role]])};
  assert.equal(hasCodexAccess(ctx),false);
  ctx.actor.id=actor;assert.equal(hasCodexAccess(ctx),true);
  role.permissions='0';assert.equal(hasCodexAccess(ctx),false);
  ctx.actor.id='owner';assert.equal(hasCodexAccess(ctx),true);
  ctx.actor.bot=true;assert.equal(hasCodexAccess(ctx),false);
});
test('memory persists per actor and is included in authorized requests',async t=>{
  const h=fixture(t);
  await h.handle(h.message('+memory save Use Arabic for moderation.'));
  await h.handle(h.message('<@'+bot+'> hello'));
  assert.equal(h.calls[0].memoryNotes[0].note,'Use Arabic for moderation.');
  assert.deepEqual(h.db.codex.notes('other'),[]);
  assert.equal(h.db.codex.forgetNote('other',h.calls[0].memoryNotes[0].id),0);
  await h.handle(h.message('+memory forget '+h.calls[0].memoryNotes[0].id));
  assert.deepEqual(h.db.codex.notes(actor),[]);
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blueland-memory-'));
  try {
    const filename=path.join(dir,'state.sqlite');
    let store=openStore(filename);store.codex.note(actor,'persistent');store.close();
    store=openStore(filename);assert.equal(store.codex.notes(actor)[0].note,'persistent');store.close();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('workspace progress counts completed commands and distinct edited files before the final reply',async t=>{
  const h=fixture(t), events=[], actions=['workspace_edit','workspace_edit','workspace_command'].map(op=>({op,target:op.endsWith('edit')?'note.md':'tests',value:'',extra:''}));
  const handle=createCodexHandler({store:h.db.codex,isAdmin:async()=>true,
    ask:async q=>q.workspaceResults?{answer:'done',actions:[]}:{answer:'',actions},
    workspace:async a=>a.op==='edit'?{text:'saved',edited:'note.md'}:{ran:true,exit:0,text:'ok'}});
  const msg=h.message('+code work',{reply:async data=>{events.push(data.content);return {edit:async x=>events.push(x.content)};}});
  await handle(msg);
  assert.match(events[0],/Thinking/);
  assert.match(events.at(-2),/Finished · Edited 1 file · Ran 1 command/);assert.equal(events.at(-1),'done');
});
test('compiled Discord commands run in QuickJS and return only data',async()=>{
  const {runFeature}=require('../src/codex-feature');
  const fn='input => ({answer: input.args.toUpperCase(), actions: []})';
  assert.equal(await runFeature(fn,{},true),true);
  assert.deepEqual(await runFeature(fn,{args:'test'}),{answer:'TEST',actions:[]});
  await assert.rejects(runFeature('not valid JS',{},true));
});

test('history reads up to ten earlier messages and ignores proposed actions',async t=>{
  const h=fixture(t), requests=[], fetches=[], replies=[];
  const handle=createCodexHandler({store:h.db.codex,isAdmin:async id=>id===actor,
    ask:async request=>{
      requests.push(request);
      return {answer:'جواب من السجل',actions:[{op:'note_save',target:'',value:'injected instruction',extra:''}]};
    }});
  const overrides={channel:{permissionsFor:()=>({has:()=>true}),messages:{fetch:async options=>{
    fetches.push(options);
    return ['الأحدث','الأقدم'].map(content=>({author:{username:'member'},content,attachments:{size:0}}));
  }}},reply:async data=>{replies.push(data);return {edit:async()=>{}};}};
  const list=h.message('+history',overrides);
  await handle(list);
  assert.equal(requests.length,0);
  assert.match(replies.at(-1).content,/الأقدم[\s\S]*الأحدث/);
  assert.deepEqual(replies.at(-1).allowedMentions.parse,[]);
  const query=h.message('+سجل ما آخر موضوع؟',overrides);
  await handle(query);
  assert.deepEqual(fetches,[list,query].map(message=>({before:message.id,limit:10,cache:false})));
  assert.equal(requests[0].prompt,'ما آخر موضوع؟');
  assert.deepEqual(requests[0].context.recentMessages.map(entry=>entry.content),['الأقدم','الأحدث']);
  assert.deepEqual(requests[0].context.operations,[]);
  assert.deepEqual(h.db.codex.notes(actor),[]);
  assert.equal(replies.at(-1).content,'جواب من السجل');
});

function fixture(t) {
  const db=openStore(':memory:');t.after(()=>db.close());
  const replies=[],calls=[];
  const env={admin:true,result:{answer:'OK',actions:[]}};
  const handle=createCodexHandler({store:db.codex,isAdmin:async id=>env.admin&&id===actor,
    ask:async x=>{calls.push(x);return x.operation==='models'?[{id:'gpt-6.2-astra',efforts:['high']}]:env.result;}});
  let serial=0;
  const message=(content,extras={})=>({id:String(++serial),content,guildId:catalog.guildId,channelId:channel,author:{id:actor},client:{user:{id:bot}},
    guild:{name:'BlueLand',channels:{cache:new Map()},roles:{cache:new Map()},members:{fetch:async()=>({user:{bot:false},permissions:{has:()=>env.admin}})}},
    channel:{sendTyping:async()=>{}},reply:async x=>{replies.push(x);return {id:'reply'+serial};},...extras});
  return {handle,env,replies,calls,message,db};
}

test('Codex only runs for a human guild administrator in BlueLand',async t=>{
  const h=fixture(t);
  for (const extras of [{author:{id:actor,bot:true}},{webhookId:'123'},{guildId:null},{guildId:'outside'},{author:{id:'other'}}])
    await h.handle(h.message('<@'+bot+'> hello',extras));
  h.env.admin=false;await h.handle(h.message('+model gpt-6.2-astra high'));
  assert.equal(h.calls.length,0);assert.equal(h.replies.length,0);
});
test('mentions, unpinged replies, model switching and duplicate delivery',async t=>{
  const h=fixture(t),m=h.message('<@!'+bot+'> hello');
  await h.handle(m);await h.handle(m);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].prompt,'hello');assert.equal(h.calls[0].effort,'high');
  const reference={channelId:channel,messageId:'parent',guildId:catalog.guildId};
  const parent={id:'parent',guildId:catalog.guildId,channelId:channel,author:{id:bot},content:'last answer'};
  await h.handle(h.message('continue',{reference,fetchReference:async()=>parent}));
  assert.equal(h.calls[1].previous,'last answer');
  await h.handle(h.message('not for bot',{reference,fetchReference:async()=>({...parent,author:{id:'someone'}})}));
  assert.equal(h.calls.length,2);
  await h.handle(h.message('+model gpt-6.2-astra high'));assert.equal(h.db.codex.settings().model,'gpt-6.2-astra');
  await h.handle(h.message('+model invalid-model high'));assert.equal(h.db.codex.settings().model,'gpt-6.2-astra');
});
test('an admin can teach and invoke an admin-only command, reserved names stay protected',async t=>{
  const h=fixture(t);
  const action={op:'save_command',target:'تقرير',value:'Summarize the server.',extra:''};
  h.env.result={answer:'',actions:[action]};
  await h.handle(h.message('<@'+bot+'> create a report command'));
  assert.equal(h.db.codex.feature('تقرير'),action.value);
  h.env.result={actions:[],answer:'done'};
  await h.handle(h.message('+تقرير today'));
  assert.equal(h.calls.at(-1).instruction,action.value);
  assert.equal(h.calls.at(-1).prompt,'today');
  h.env.admin=false;await h.handle(h.message('+تقرير'));assert.equal(h.calls.length,2);
  assert.throws(()=>featureName('تخفيض'));assert.throws(()=>inspectActions([{...action,op:'shell'}]));
});
test('confirmation is tied to the initiating actor, channel and preview, and consumed once',t=>{
  const h=fixture(t),s=h.db.codex;s.remember('r',actor,channel,[{op:'delete_channel'}]);
  assert.equal(s.consume('r','other',channel),null);assert.equal(s.consume('r',actor,'elsewhere'),null);
  assert.deepEqual(s.consume('r',actor,channel),[{op:'delete_channel'}]);assert.equal(s.consume('r',actor,channel),null);
});
test('all demotion steps preserve unrelated roles and remove lost category helpers',()=>{
  const unrelated='12345';
  for (const [i,step] of ladder.entries()) {
    const held=[step.group.base,step.id,...step.helpers,unrelated];
    if (!i) {assert.throws(()=>planPromotion(held,'demote'));continue;}
    const p=planPromotion(held,'demote');
    assert.equal(p.to,ladder[i-1].id);
    assert.equal(p.remove.includes(unrelated),false);
    assert.deepEqual(p.helpers,ladder[i-1].helpers);
    for(const helper of step.helpers) assert.equal(p.remove.includes(helper),!p.helpers.includes(helper));
  }
  assert.equal(parseChat('+تخفيض <@'+actor+'>').action,'demote');
  assert.throws(()=>parseChat('+تخفيض <@'+actor+'> everything'));
});
