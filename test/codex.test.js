'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/store');
const {catalog,ladder,planPromotion}=require('../src/ladder');
const {createCodexHandler}=require('../src/codex-chat');
const {featureName,inspectActions}=require('../src/codex-actions');
const {parseChat}=require('../src/commands');
const bot=catalog.botId, actor='200000000000000001', channel='200000000000000002';

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
