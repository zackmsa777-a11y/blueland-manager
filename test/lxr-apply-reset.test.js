'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createMessageHandler}=require('../src/chat');
const {createLxrApply}=require('../src/lxr-apply');
const {openStore}=require('../src/store');
const {parseChat,helpText}=require('../src/commands');
const {catalog}=require('../src/ladder');
const OG='1574012921090932836', high='1574012917131776112', low='1574012924916142140';
const actor='200000000000000001',userId='200000000000000002',other='200000000000000003';
const pending={id:'200000000000000004',userId,kind:'girls'}, untouched={id:'200000000000000005',userId:other,kind:'transfer'};
function fixture(t) {
  const store=openStore(':memory:');t.after(()=>store.close());
  store.applications.claim(pending);store.applications.claim(untouched);
  const app=createLxrApply({receipts:store.applications});
  let held=OG, actorId=actor, calls=0, resolveTarget=id=>({id,bot:false});
  const replies=[], publicReplies=[];
  const roles=new Map([[OG,{id:OG,position:193}],[high,{id:high,position:194}],[low,{id:low,position:192}]]);
  let scope=async()=>{};
  const onMessage=createMessageHandler({store,parse:parseChat,resetApplication:app.reset,
    assertGenericChannel:(id,options)=>scope(id,options),
    applicationResetContext:async (id,target)=>{assert.equal(id,actor);calls++;return {actor:{id:actorId,bot:false,roles:[held]},roles,
      target:target?resolveTarget(target):undefined};},
    run:async()=>assert.fail('reset reached generic command runner'),shortcuts:async()=>assert.fail('reset reached shortcut'),
    ticketMessages:async()=>assert.fail('reset reached general ticket handler')});
  return {store,replies,publicReplies,setRole:role=>{held=role;},setActor:id=>{actorId=id;},roles,calls:()=>calls,
    setScope:fn=>{scope=fn;},setTarget:fn=>{resolveTarget=fn;},
    send:(text,{dm=async payload=>{replies.push(payload);},...options}={})=>onMessage({inGuild:()=>true,guildId:catalog.guildId,
      author:{id:actor,bot:false,send:dm},channelId:other,content:text,
      reply:async payload=>{publicReplies.push(payload);},...options})};
}
const command=`+rs apply <@${userId}>`;
test('OG’s or higher resets only the named pending submission without exposing a route or ticket',async t=>{
  const f=fixture(t);
  for (const role of [OG,high]) {
    f.setRole(role);await f.send(command);
    assert.equal(f.store.applications.find(userId),undefined);
    assert.deepEqual({...f.store.applications.find(other)},untouched);
    assert.equal(f.replies.at(-1).content,'تم فك تعليق الطلب. يقدر العضو يقدّم من جديد.');
    assert.deepEqual(f.replies.at(-1).allowedMentions,{parse:[]});
    assert.equal(f.store.applications.claim(pending),true);
  }
  assert.deepEqual(f.publicReplies,[]);
});
test('below-threshold or mismatched current member is denied silently before parsing or mutating a target',async t=>{
  const f=fixture(t);f.setRole(low);
  await f.send(command);await f.send('+rs apply');f.setActor(other);f.setRole(high);await f.send(command);
  assert.deepEqual(f.replies,[]);assert.deepEqual({...f.store.applications.find(userId)},pending);
});
test('invalid target arity, wrong guild, and missing threshold do not reset',async t=>{
  const f=fixture(t);
  for (const text of ['+rs apply',`+rs apply ${userId}`,`${command} <@${other}>`]) await f.send(text);
  assert.equal(f.replies.length,3);assert.ok(f.replies.every(p=>p.content.includes('+rs apply @العضو')));
  await f.send(command,{guildId:other});await f.send(command,{inGuild:()=>false});
  f.roles.delete(OG);f.setRole(high);await f.send(command);
  assert.equal(f.replies.length,3);assert.deepEqual({...f.store.applications.find(userId)},pending);
});
test('reset clears the muted retry lock only once and reserves the exact command syntax',async t=>{
  const f=fixture(t);await f.send(command);await f.send(command);
  assert.equal(f.replies[1].content,'ما فيه طلب معلّق لهذا العضو.');
  assert.deepEqual(parseChat(command),{action:'reset-apply',target:userId});
  assert.equal(parseChat('+rs applies'),null);
  assert.match(helpText,/\+rs apply @العضو/u);
});

test('an unavailable or mismatched guild member never releases a reservation',async t=>{
  const f=fixture(t);
  for (const lookup of [()=>undefined,()=>({id:other,bot:false}),()=>({id:userId,bot:true}),
    ()=>{throw Object.assign(new Error('Unknown Member'),{code:10007});}]) {
    f.setTarget(lookup);await f.send(command);
    assert.deepEqual({...f.store.applications.find(userId)},pending);
  }
  assert.ok(f.replies.every(reply=>!reply.content.includes('تم فك')));
});

test('reset rejects a private origin even when cached scope says it is public',async t=>{
  const f=fixture(t);
  const checks=[];
  f.setScope(async (id,{useCache}={})=>{checks.push({id,useCache});if (!useCache) throw new Error('Protected application thread');});
  await f.send(command);
  assert.deepEqual(checks,[{id:other,useCache:false}]);
  assert.deepEqual(f.replies,[]);
  assert.deepEqual({...f.store.applications.find(userId)},pending);
});

test('sender authority is checked again with the fresh target lookup',async t=>{
  const f=fixture(t);
  f.setTarget(()=>{f.roles.get(OG).position=999;return {id:userId,bot:false};});
  f.setRole(high);await f.send(command);
  assert.deepEqual({...f.store.applications.find(userId)},pending);
  assert.deepEqual(f.replies,[]);
});

test('disabled private messages never disclose reset state or errors in the invocation channel',async t=>{
  const f=fixture(t);
  let attempted=0;
  const dm=async()=>{attempted++;throw new Error('Cannot send messages to this user');};
  await f.send(command,{dm});
  await f.send(command,{dm});
  await f.send('+rs apply',{dm});
  assert.equal(attempted,3);
  assert.deepEqual(f.publicReplies,[]);
  assert.equal(f.store.applications.find(userId),undefined);
});
