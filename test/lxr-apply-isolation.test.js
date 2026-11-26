'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Client,ChannelType,OverwriteType,PermissionFlagsBits:P,Routes}=require('discord.js');
const {catalog,roles}=require('../src/ladder');
const {openStore}=require('../src/store');
const {createCommunity}=require('../src/community');
const {communityGateway}=require('../src/discord-community');
const {createMessageHandler}=require('../src/chat');
const {commandRunner,parseChat,interactionInput}=require('../src/commands');
const ui=require('../src/ticket-ui');

const guildId=catalog.guildId, bot=catalog.botId;
const id=n=>`207000000000000${String(n).padStart(3,'0')}`;
const owner=id(1), moderator=id(2), member=id(3), room=id(4), lobby=id(5), thread=id(6), moved=id(7), named=id(8), namedRoom=id(9);
const fixed='1575528932357439549';
const marker=`LXR application • ${id(10)}`;
const lockRole=catalog.roles.find(r=>r.label==='lock/unlock').id;
const botRole='1573988437088932015';
const canary='private-application-reason-canary';
const grant=(id,type,allow=0n,deny=0n)=>({id,type,allow:String(allow),deny:String(deny)});
const privateAcl=[grant(guildId,OverwriteType.Role,0n,P.ViewChannel),
  grant(moderator,OverwriteType.Member,P.ViewChannel|P.SendMessages|P.ReadMessageHistory),
  grant(bot,OverwriteType.Member,P.ViewChannel|P.SendMessages|P.ReadMessageHistory|P.ManageRoles)];
const channel=(id,extra={})=>({id,guild_id:guildId,type:ChannelType.GuildText,name:'synthetic',parent_id:null,topic:null,
  permission_overwrites:[],...extra});
const user=id=>({id,username:`user-${id}`,discriminator:'0',bot:id===bot});
const guildMember=(id,roles=[])=>({user:user(id),roles,joined_at:'2026-01-01T00:00:00Z',flags:0});

function fixture(t) {
  const store=openStore(':memory:'); t.after(()=>store.close());
  store.community.saveSettings({...store.community.settings(),levels:true});
  const client=new Client({intents:[]}); t.after(()=>client.destroy());
  client.user={id:bot};
  const raw=new Map([
    channel(fixed,{type:ChannelType.GuildCategory}),channel(room,{parent_id:fixed,permission_overwrites:privateAcl}),
    channel(lobby,{permission_overwrites:[grant(bot,OverwriteType.Member,P.ManageRoles)]}),channel(moved,{topic:marker,permission_overwrites:privateAcl}),
    channel(thread,{type:ChannelType.PrivateThread,parent_id:moved,owner_id:moderator,
      thread_metadata:{archived:false,auto_archive_duration:60,archive_timestamp:'2026-01-01T00:00:00Z',locked:false}}),
    channel(named,{type:ChannelType.GuildCategory,name:'تقديم إدارة بنات'}),channel(namedRoom,{parent_id:named,permission_overwrites:privateAcl})
  ].map(c=>[c.id,c]));
  const members=[guildMember(moderator,[lockRole]),guildMember(member),guildMember(bot,[botRole]),guildMember(owner)];
  const wireRoles=[{id:guildId,name:'@everyone',permissions:String(P.ViewChannel|P.SendMessages),position:0},
    ...[lockRole,botRole].map(id=>({id,name:id,permissions:'0',position:1}))];
  const guild=client.guilds._add({id:guildId,name:'isolated',owner_id:owner,roles:wireRoles,members,
    channels:[...raw.values()].filter(c=>![moved,thread,named].includes(c.id))});
  const writes=[], reads=[];
  client.rest.get=async route=>{
    reads.push(route);
    if (route===Routes.guildChannels(guildId)) return [...raw.values()].filter(c=>c.id!==thread);
    const c=[...raw.values()].find(c=>route===Routes.channel(c.id));
    if (!c) throw Object.assign(new Error('Unknown Channel'),{code:10003});
    return structuredClone(c);
  };
  for(const method of ['put','post','patch','delete']) client.rest[method]=async (...args)=>{writes.push([method,...args]);};
  const person=id=>({id,bot:id===bot,roles:members.find(m=>m.user.id===id)?.roles??[]});
  const gateway=communityGateway(()=>guild,async (actor,target=actor)=>({actor:person(actor),target:person(target),bot:person(bot),ownerId:owner,roles}));
  const community=createCommunity(store,gateway);
  const run=commandRunner({store,community,readyGuild:()=>guild});
  const replies=[], shortcuts=[], tickets=[];
  const onMessage=createMessageHandler({store,run,parse:parseChat,assertGenericChannel:gateway.assertGenericChannel,
    shortcuts:async (_,text)=>{shortcuts.push(text);return text==='.روليت';},
    ticketMessages:async (_,text)=>{tickets.push(text);return false;}});
  function message(channelId,content,createdTimestamp=Date.UTC(2026,0,1),sender=moderator,attachments=new Map()) {
    return onMessage({id:id(11),guildId,channelId,inGuild:()=>true,author:user(sender),content,createdTimestamp,
      attachments,get channel(){return guild.channels.cache.get(channelId);},guild,client,reply:async payload=>replies.push(payload)});
  }
  return {guild,raw,store,reads,writes,gateway,community,run,message,replies,shortcuts,tickets};
}

test('the real message handler does not route application text to responders or activity',async t=>{
  const f=fixture(t), time=Date.UTC(2026,0,1);
  await f.message(room,canary,time);
  await f.message(room,'.روليت',time+60_000);
  await f.message(room,'السلام عليكم',time+120_000);
  assert.deepEqual({shortcuts:f.shortcuts,tickets:f.tickets,replies:f.replies,xp:f.store.community.xp(moderator)},
    {shortcuts:[],tickets:[],replies:[],xp:0});
  assert.deepEqual(f.store.community.activityTop({mode:'text',now:time}).text,[]);
  await f.message(lobby,'outside the application',time+180_000);
  assert.deepEqual(f.shortcuts,['outside the application']);
  assert.equal(f.store.community.xp(moderator),10);
});

test('a manually attached transfer screenshot never enters generic message paths',async t=>{
  const f=fixture(t), transfer='1575529519358419024', time=Date.UTC(2026,0,1);
  f.raw.get(room).parent_id=transfer;
  f.raw.get(room).topic=marker;
  const attachments=new Map([[id(13),{id:id(13),name:'synthetic-private-proof.png',contentType:'image/png',
    get url(){assert.fail('generic handling accessed a private screenshot URL');}}]]);
  await f.message(room,'+lock '+canary,time,moderator,attachments);
  assert.deepEqual({shortcuts:f.shortcuts,tickets:f.tickets,replies:f.replies,writes:f.writes,cases:f.store.community.cases(),
    xp:f.store.community.xp(moderator)},{shortcuts:[],tickets:[],replies:[],writes:[],cases:[],xp:0});
});

test('delegated lock cannot mutate an application ACL or record its ID and reason as a general case',async t=>{
  const f=fixture(t), c=f.guild.channels.cache.get(room);
  const effective=c.permissionsFor(f.guild.members.cache.get(moderator));
  assert.equal(effective.has(P.ViewChannel),true);
  assert.equal(effective.has(P.ManageChannels),false);
  assert.equal(c.permissionsFor(f.guild.members.cache.get(member)).has(P.ViewChannel),false);
  assert.equal(c.permissionsFor(f.guild.members.me).has([P.ViewChannel,P.ManageRoles]),true);
  const request={...parseChat(`+lock ${canary}`),actor:moderator,channel:room,originChannel:lobby,delivery:'discord:'+id(11)};
  let rejection;
  try { await f.run(request); } catch(err) { rejection=err; }
  assert.deepEqual(f.store.community.cases(),[]);
  assert.equal(f.store.community.lock(`${room}:${guildId}`),undefined);
  assert.deepEqual(f.writes,[]);
  assert.equal(rejection?.status,403);
  assert.doesNotMatch(rejection.message,new RegExp(`${canary}|${room}`));
  await f.message(room,`+lock ${canary}`);
  assert.deepEqual(f.replies,[]);
  await f.run({...request,channel:lobby,delivery:'discord:'+id(12),reason:'normal room'});
  assert.equal(f.store.community.cases()[0].target,lobby);
  assert.equal(f.writes.length,1);
});

test('slash moderation cannot persist reasons from the thread of a moved application room',async t=>{
  const f=fixture(t);
  const input=interactionInput({commandName:'warn',channelId:thread,user:{id:owner},id:id(13),createdTimestamp:Date.now(),
    options:{getSubcommand:()=>null,getUser:()=>({id:member}),getString:name=>name==='reason'?canary:null,getInteger:()=>null}});
  let rejection;
  try { await f.run(input); } catch(err) { rejection=err; }
  assert.deepEqual(f.store.community.cases(),[]);
  assert.equal(rejection?.status,403);
  await assert.rejects(f.run({...input,action:'lock',channel:lobby,originChannel:thread}),{status:403});
  assert.deepEqual(f.writes,[]);
});

test('application messages under named, moved or unresolved ancestry stay out of generic paths',async t=>{
  const f=fixture(t);
  await f.message(namedRoom,canary);
  assert.deepEqual(f.reads.splice(0),[Routes.channel(named)]);
  await f.message(thread,canary);
  assert.deepEqual(f.reads.splice(0),[Routes.channel(thread),Routes.channel(moved)]);
  f.raw.delete(moved);
  await f.message(thread,canary);
  assert.deepEqual(f.reads.splice(0),[Routes.channel(thread),Routes.channel(moved)]);
  await f.message(room,`+مقبول <@${member}>`);
  assert.deepEqual(f.reads,[]);
  assert.deepEqual([f.shortcuts,f.tickets,f.replies,f.writes],[[],[],[],[]]);
  assert.equal(f.store.community.xp(moderator),0);
});

test('named and moved application rooms cannot be selected or saved as support destinations',async t=>{
  const f=fixture(t), initial=f.store.community.settings();
  const offered=(await f.gateway.destinations()).map(c=>c.id);
  assert.deepEqual(offered,[lobby]);
  for (const [key,picked] of [['ticketCategory',named],['welcomeChannel',namedRoom],['welcomeChannel',moved]]) {
    await assert.rejects(f.community.saveSettings(owner,{...initial,[key]:picked}),/التقديم/u);
    assert.deepEqual(f.store.community.settings(),initial);
  }
  await f.community.saveSettings(owner,{...initial,welcomeChannel:lobby,supportRole:''});
  assert.equal(f.store.community.settings().welcomeChannel,lobby);
});

test('stale support tickets cannot repurpose a channel now in an application category',async t=>{
  const f=fixture(t);
  const row={id:42,kind:'legacy',owner:moderator,assignee:moderator,channel:namedRoom};
  f.raw.get(namedRoom).topic=ui.marker(row)+'\n'+canary;
  await assert.rejects(f.gateway.ticketRoom(row,f.store.community.settings()),{status:403});
  let attempted=false;
  await assert.rejects(f.gateway.announceClaim(row,moderator,id(14),null,()=>{attempted=true;}),{status:403});
  assert.equal(attempted,false);
  assert.ok(f.reads.every(route=>[Routes.guildChannels(guildId),Routes.channel(namedRoom),Routes.channel(named)].includes(route)));
  assert.deepEqual(f.writes,[]);
});

test('fresh moderation readback does not use an older Discord.js channel from cache',async t=>{
  const f=fixture(t);
  assert.equal(f.guild.channels.cache.get(lobby).topic,null);
  f.raw.get(lobby).topic=marker;
  await assert.rejects(f.run({action:'lock',actor:moderator,channel:lobby,delivery:'slash:'+id(15),reason:canary}),{status:403});
  assert.deepEqual(f.store.community.cases(),[]);
  assert.deepEqual(f.writes,[]);
});

test('generic ticket commands do not publish a stale application-scoped channel link',async t=>{
  const f=fixture(t);
  const db=f.store.community;
  const record=db.reserveTicket('previous-support-delivery',moderator,'old support room');
  db.setChannel(record.id,namedRoom);
  await assert.rejects(f.run({action:'ticket',sub:'create',actor:moderator,channel:lobby,
    delivery:'slash:'+id(16),subject:'new support question'}),{status:403});
  await assert.rejects(f.community.ticketAction(moderator,record.id,'close'),{status:403});
  assert.equal(db.ticket(record.id).state,'open');
  assert.deepEqual(f.writes,[]);
});
