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
test('a paused workspace request resumes from disk on a reply to its stop message',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blueland-resume-'));
  const filename=path.join(dir,'state.sqlite'),h=fixture(t);
  let db=openStore(filename);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const original=h.message('+code Finish the report command');
  let calls=0;
  const first=createCodexHandler({store:db.codex,isAdmin:async()=>true,ask:async()=>{
    calls++;return {actions:[{op:calls===1?'workspace_edit':'workspace_read',target:'src/report.js',value:'',extra:''}],answer:''};
  },workspace:async a=>a.op==='edit'?{edited:a.target,text:'saved'}:{text:'file contents'}});
  await first(original);
  assert.match(h.replies.at(-1).content,/كمل/);
  assert.deepEqual(db.codex.latestTask(actor,channel).progress.files,['src/report.js']);
  db.close();db=openStore(filename);
  const requests=[],ops=[],second='other-operator';
  const next=createCodexHandler({store:db.codex,isAdmin:async id=>[actor,second].includes(id),
    ask:async q=>{requests.push(q);return {actions:[],answer:'finished the task'};},
    workspace:async a=>{ops.push(a.target);return {text:'?? src/report.js',exit:0,ran:true};}});
  const ref={messageId:'pause',channelId:channel};
  const parent={id:ref.messageId,content:'حفظت تقدّم المهمة.',author:{id:bot},guildId:catalog.guildId,channelId:channel,reference:{messageId:original.id}};
  const extras={reference:ref,fetchReference:async()=>parent};
  await next(h.message('كمل',{...extras,author:{id:'unauthorized'}}));
  assert.equal(requests.length,0);
  await next(h.message('كمل',{...extras,author:{id:second}}));
  assert.equal(requests[0].prompt,'Finish the report command');
  assert.deepEqual(requests[0].taskCheckpoint.files,['src/report.js']);
  assert.ok(requests[0].context.operations.every(op=>op.startsWith('workspace_')));
  assert.deepEqual(ops,['git status']);assert.equal(requests[0].workspaceResults[0].text,'?? src/report.js');
  assert.equal(db.codex.latestTask(actor,channel),null);
});

test('bare continuation uses only the requesting operator and channel and never replays Discord actions',async t=>{
  const h=fixture(t),s=h.db.codex;
  s.startTask('original',actor,channel,'Finish coding');
  const requests=[];
  const handle=createCodexHandler({store:s,isAdmin:async()=>true,
    ask:async q=>{requests.push(q);return {answer:'',actions:[{op:'note_save',target:'',value:'unrequested',extra:''}]};},
    workspace:async()=>({ran:true,exit:0,text:'clean'})});
  assert.equal(await handle(h.message('كمل',{channelId:'elsewhere'})),false);
  assert.equal(await handle(h.message('كمل',{author:{id:'someone-else'}})),false);
  const resumed=h.message('كمل');await handle(resumed);
  assert.equal(requests.length,1);assert.equal(requests[0].prompt,'Finish coding');
  assert.equal(s.taskFor(resumed.id,channel).active,1);assert.deepEqual(s.notes(actor),[]);
});

test('a verified stop reply from before checkpoints existed can recover its original request',async t=>{
  const h=fixture(t),s=h.db.codex,requests=[];
  const original=h.message('<@'+bot+'> Finish a draft command');
  s.begin(original.id,actor);s.finish(original.id,'failed');
  const stopped={id:'old-stop',content:'وصلت إلى حد خطوات الطلب. اطلب المتابعة لاستكمال العمل.',
    author:{id:bot},guildId:catalog.guildId,channelId:channel,reference:{messageId:original.id},fetchReference:async()=>original};
  const handle=createCodexHandler({store:s,isAdmin:async id=>id===actor,
    workspace:async()=>({ran:true,exit:0,text:'?? src/example.js'}),
    ask:async q=>{requests.push(q);return {answer:'done',actions:[]};}});
  await handle(h.message('كمل',{reference:{messageId:stopped.id,channelId:channel},fetchReference:async()=>stopped}));
  assert.equal(requests[0].prompt,'Finish a draft command');
  assert.equal(requests[0].workspaceResults[0].text,'?? src/example.js');
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

test('deploy requires an authorized command or a confirmed natural-language request',async t=>{
  const h=fixture(t);
  let starts=0;
  const action={op:'vps_deploy',target:'',value:'',extra:''};
  const handle=createCodexHandler({store:h.db.codex,isAdmin:async id=>id===actor,
    ask:async()=>({answer:'',actions:[action]}),vps:{deploy:async()=>{starts++;},release:async()=>'live release'}});
  await handle(h.message('+vps deploy',{author:{id:'other'}}));assert.equal(starts,0);
  await handle(h.message('+vps main'));assert.equal(starts,1);
  await handle(h.message('+vps release'));assert.equal(h.replies.at(-1).content,'live release');
  const natural=h.message('<@'+bot+'> deploy main');
  await handle(natural);assert.equal(starts,1);
  const parent={id:'reply'+natural.id,author:{id:bot},guildId:catalog.guildId,channelId:channel};
  const confirm=h.message('تأكيد',{reference:{channelId:channel,messageId:parent.id},fetchReference:async()=>parent});
  await handle(confirm);await handle(confirm);assert.equal(starts,2);
});

test('publishing previews app code and confirmation may come from the other authorized account',async t=>{
  const h=fixture(t),requests=[],owner='300000000000000001';
  const handle=createCodexHandler({store:h.db.codex,isAdmin:async id=>[actor,owner].includes(id),
    workspace:async a=>a.op==='release_patch'?{text:'diff --git a/src/chat.js b/src/chat.js',base:'base'}:{synced:true},
    publish:async req=>{requests.push(req);return req.op==='preview'?{preview:'review'}:{revision:'a'.repeat(40)};}});
  await handle(h.message('انشر',{author:{id:'some-other-admin'}}));
  assert.equal(requests.length,0);
  const trigger=h.message('<@'+bot+'> انشر');
  await handle(trigger);await handle(trigger);
  assert.equal(requests.length,1);assert.equal(requests[0].op,'preview');assert.match(requests[0].patch,/src\/chat\.js/);
  const parent={id:'review',content:'مراجعة نشر BlueLand · 123',author:{id:bot},guildId:catalog.guildId,channelId:channel};
  const extras={author:{id:owner},reference:{channelId:channel,messageId:parent.id},fetchReference:async()=>parent};
  await handle(h.message('تأكيد',extras));
  assert.equal(requests[1].actor,owner);assert.equal(requests[1].op,'confirm');assert.equal(requests[1].preview,parent.id);
  assert.equal(requests[1].patch,undefined);
});

test('every mention or reply receives the previous ten messages while action planning excludes chat history',async t=>{
  const h=fixture(t),requests=[],fetches=[];
  const messages=Array.from({length:13},(_,i)=>({id:String(i+1),author:{id:actor,username:'member'},content:'message '+(i+1),attachments:{size:0}}));
  const parent={...messages[11],author:{id:bot,username:'BlueLand',bot:true},reference:{messageId:'11'},channelId:channel,guildId:catalog.guildId};
  messages[11]=parent;
  h.db.codex.begin('11',actor);
  const chan={sendTyping:async()=>{},permissionsFor:()=>({has:()=>true}),messages:{fetch:async options=>{
    fetches.push(options);
    return messages.filter(m=>Number(m.id)<Number(options.before)).reverse().slice(0,options.limit);
  }}};
  const handle=createCodexHandler({store:h.db.codex,isAdmin:async id=>id===actor,ask:async req=>{
    requests.push(req);
    return req.context.recentMessages?{answer:'',actions:[{op:'note_save',target:'',value:'unrequested note',extra:''}]}:{answer:'ok',actions:[]};
  }});
  await handle(h.message('<@'+bot+'> hello',{id:'13',channel:chan}));
  assert.deepEqual(requests[0].context.recentMessages.map(m=>m.id),messages.slice(2,12).map(m=>m.id));
  assert.equal(requests[0].context.recentMessages.at(-1).bot,true);
  assert.equal(requests[0].context.recentMessages.at(-1).replyTo,'11');
  assert.equal(requests[1].context.recentMessages,undefined);
  await handle(h.message('hello again',{id:'14',channel:chan,reference:{channelId:channel,messageId:parent.id},fetchReference:async()=>parent}));
  assert.deepEqual(requests[2].context.recentMessages.map(m=>m.id),messages.slice(3).map(m=>m.id));
  assert.equal(requests[3].context.recentMessages,undefined);
  assert.deepEqual(fetches,['13','14'].map(before=>({before,limit:10,cache:false})));
  assert.deepEqual(h.db.codex.notes(actor),[]);
});

test('colloquial continuation and replying to an unlinked bot clarification resume the caller’s draft with recent chat',async t=>{
  for (const replyToClarification of [false,true]) {
    const h=fixture(t),requests=[];
    const task=h.db.codex.startTask('101',actor,channel,'Finish my draft');
    h.db.codex.recordStep(task,'edit','src/report.js',{edited:'src/report.js'});
    h.db.codex.startTask('102','other-operator',channel,'A different draft');
    const parent={id:'111',author:{id:bot,username:'BlueLand',bot:true},content:'رد على رسالة التوقف الأصلية',attachments:{size:0},
      channelId:channel,guildId:catalog.guildId,reference:{messageId:'110'}};
    const chan={sendTyping:async()=>{},permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>[parent]}};
    const handle=createCodexHandler({store:h.db.codex,isAdmin:async id=>id===actor,ask:async req=>{requests.push(req);return {actions:[],answer:'done'};},
      workspace:async()=>({exit:0,ran:true,text:' M src/report.js'})});
    const msg=replyToClarification?h.message('كمل',{id:'112',channel:chan,reference:{channelId:channel,messageId:parent.id},fetchReference:async()=>parent}):
      h.message('<@'+bot+'> كمل الي كنت بتعمله',{id:'112',channel:chan});
    await handle(msg);
    assert.equal(requests[0].prompt,'Finish my draft');
    assert.deepEqual(requests[0].taskCheckpoint.files,['src/report.js']);
    assert.deepEqual(requests[0].context.recentMessages.map(m=>m.id),['111']);
    assert.equal(h.db.codex.latestTask('other-operator',channel).id,'102');
  }
});

test('automatic history checks both the bot and member before fetching the channel',async t=>{
  for (const denied of [actor,bot]) {
    const h=fixture(t);let fetches=0;
    const chan={sendTyping:async()=>{},permissionsFor:member=>({has:()=>(member.id||member)!==denied}),
      messages:{fetch:async()=>{fetches++;return [];}}};
    await h.handle(h.message('<@'+bot+'> hello',{channel:chan}));
    assert.equal(fetches,0);assert.equal(h.calls[0].context.recentMessages,undefined);
  }
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
test('member usage questions get public help without granting access to Codex or its actions',async t=>{
  const h=fixture(t);
  h.env.admin=false;
  await h.handle(h.message('<@'+bot+'> مش فاهم كيف يشتغل البوت'));
  assert.match(h.replies.at(-1).content,/\/help/);
  const reference={channelId:channel,messageId:'parent',guildId:catalog.guildId};
  const parent={id:'parent',guildId:catalog.guildId,channelId:channel,author:{id:bot},content:'guide'};
  const question=h.message('كيف أفتح تذكرة؟',{reference,fetchReference:async()=>parent});
  await h.handle(question);await h.handle(question);
  assert.match(h.replies.at(-1).content,/\/ticket create/);
  await h.handle(h.message('كيف أقدم؟',{reference,fetchReference:async()=>({...parent,author:{id:'someone-else'}})}));
  await h.handle(h.message('+vps deploy'));await h.handle(h.message('كمل'));
  assert.equal(h.calls.length,0);assert.equal(h.replies.length,2);
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
