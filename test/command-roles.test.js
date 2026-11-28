'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {openStore}=require('../src/store');
const {createApp}=require('../src/server');
const {catalog,RuleError}=require('../src/ladder');
const {commandRoleChecker,commandKey}=require('../src/command-roles');
const {commandRunner,parseChat,interactionInput}=require('../src/commands');
const {parseShortcut}=require('../src/custom-shortcuts');
const {createMessageHandler}=require('../src/chat');
const {createDiscordGames}=require('../src/discord-games');
const {createCommunity}=require('../src/community');

const lux='1486306919324057682',rust='1235369589408399392',admin='200000000000000001',role='200000000000000002';
const open=t=>{const store=openStore(':memory:');t.after(()=>store.close());return store;};

test('a saved subcommand survives restart and gates the shared ticket entry point without gating its siblings',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lxr-command-role-')),file=join(dir,'store.sqlite');
  let store=openStore(file);
  try {
    store.commandRoles.save(lux,'/ticket claim',role,null);
    store.close();store=openStore(file);
    const check=commandRoleChecker(store.commandRoles,async actor=>({user:{id:actor},roles:[]}));
    const community=createCommunity(store,{}, {},check);
    await assert.rejects(community.ticketAction(admin,1,'claim'),{status:403});
    await assert.rejects(community.ticketAction(admin,1,'unclaim'),{status:404});
    assert.throws(()=>store.commandRoles.save(admin,'/ticket claim',null,role),{status:403});
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('only the two editor sessions can set an existing guild role, detect conflicts and restore the default',async t=>{
  const store=open(t);
  const discord={dashboardAccess:async id=>({id,rights:{config:true}}),commandRoleOptions:async()=>[{id:role,name:'Support'}]};
  const server=createApp({store,discord});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const cookie=id=>'bl_session='+store.redeem(store.loginCode(id));
  const sessions=new Map([lux,rust,admin].map(id=>[id,cookie(id)]));
  const guide=async id=>(await fetch(base+'/api/command-guide',{headers:{cookie:sessions.get(id)}})).json();
  function post(id,body,origin=base) {
    return fetch(base+'/api/command-roles',{method:'POST',headers:{origin,'content-type':'application/json',cookie:sessions.get(id)||''},body:JSON.stringify(body)});
  }
  const assign={command:'/ping',roleId:role,previousRoleId:null};
  assert.equal((await post(null,assign)).status,401);
  assert.equal((await post(admin,{...assign,actor:lux})).status,403);
  assert.equal((await post(lux,assign,'https://example.invalid')).status,403);
  assert.equal((await post(lux,{...assign,command:'anything'})).status,400);
  assert.equal((await post(lux,{...assign,roleId:catalog.guildId})).status,400);
  assert.equal((await post(lux,{...assign,roleId:admin})).status,400);
  assert.equal((await post(lux,assign)).status,200);
  const view=await guide(admin);
  assert.equal(view.canEdit,true);assert.equal(view.canEditRoles,false);
  assert.deepEqual(view.roleOptions,[]);
  assert.equal(view.commands.find(c=>c.name==='/ping').roleName,'Support');
  const editor=await guide(rust);
  assert.equal(editor.canEditRoles,true);assert.equal(editor.roleOptions[0].id,role);
  assert.equal((await post(rust,{...assign,roleId:null})).status,409);
  assert.equal((await post(rust,{...assign,roleId:null,previousRoleId:role})).status,200);
  assert.equal(store.commandRoles.required('/ping'),null);
});

test('slash names, Arabic text and custom shortcuts share gates; an allowed role still needs the original permission',async t=>{
  const store=open(t);let roles=[],checks=0,moderationCalls=0;
  const check=commandRoleChecker(store.commandRoles,async actor=>{checks++;return {user:{id:actor,bot:false},roles};});
  const run=commandRunner({store,community:{moderate:async()=>{moderationCalls++;throw new RuleError('original permission',403);}},checkCommandRole:check});
  store.commandRoles.save(rust,'/ban',role,null);
  store.shortcuts.add('منع','/ban',lux);
  const options={getSubcommand:()=>null,getUser:()=>({id:lux}),getString:()=>null,getInteger:()=>null};
  const paths=[interactionInput({options,commandName:'بان',user:{id:admin}}),parseChat('+حظر <@'+lux+'>'),parseShortcut(store.shortcuts.match('منع <@'+lux+'>'))];
  for(const input of paths) await assert.rejects(run({...input,actor:admin}),/الرول المحدد/u);
  assert.equal(moderationCalls,0);
  roles=[role];await assert.rejects(run({...paths[0],actor:admin}),/original permission/);
  assert.equal(moderationCalls,1);
  roles=[];await assert.rejects(run({...paths[1],actor:admin}),/الرول المحدد/u);
  assert.equal(checks,5);
  assert.notEqual(commandKey({action:'bulk-role',audience:'bots'}),commandKey({action:'bulk-role',audience:'members'}));
  assert.equal(commandKey({action:'demote'}),'+تخفيض');
});

test('direct promotion, pairing, and game launch routes enforce the same persisted rule',async t=>{
  const store=open(t),calls=[];
  const check=commandRoleChecker(store.commandRoles,async actor=>({user:{id:actor},roles:[]}));
  for(const key of ['/promote','/dashboard','/game bag']) store.commandRoles.save(lux,key,role,null);
  const handler=createMessageHandler({store,authorize:async()=>calls.push('auth'),service:{execute:async()=>calls.push('promote')},checkCommandRole:check});
  const replies=[],msg={guildId:catalog.guildId,channelId:'200000000000000003',inGuild:()=>true,author:{id:admin},reply:async p=>replies.push(p.content)};
  await handler({...msg,content:'+ترقية <@'+rust+'>'});await handler({...msg,content:'+لوحة'});
  assert.equal(replies.length,2);assert.ok(replies.every(s=>s.includes('الرول المحدد')));assert.deepEqual(calls,[]);
  const game=createDiscordGames({profile:()=>calls.push('profile')},check);
  await assert.rejects(game.openShortcut(msg,'bag'),{status:403});
  let reply;
  await game.handle({user:{id:admin},commandName:'ألعاب',options:{getSubcommand:()=>'حقيبة'},isChatInputCommand:()=>true,
    isButton:()=>false,isStringSelectMenu:()=>false,reply:async p=>{reply=p;}});
  assert.match(reply.content,/الرول المحدد/u);assert.deepEqual(calls,[]);
  await check(admin,{action:'game',sub:'shop'});
  await assert.rejects(commandRoleChecker(store.commandRoles,async()=>{throw Error('offline');})(lux,{action:'dashboard'}),{status:403});
});
