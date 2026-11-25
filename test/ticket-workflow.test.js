'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ChannelType,Collection,MessagePayload,PermissionFlagsBits:P,PermissionsBitField}=require('discord.js');
const {catalog}=require('../src/ladder');
const {openStore}=require('../src/store');
const {communityGateway}=require('../src/discord-community');
const {createApp}=require('../src/server');
const {createDiscordTickets}=require('../src/discord-tickets');
const {SUPPORT,PANEL}=require('../src/ticket-ui');
const opener='200000000000000001', owner='200000000000000002', roomId='200000000000000003', guest='200000000000000004';
const bot=catalog.botId, guildId=catalog.guildId;
const bit=value=>new PermissionsBitField(value);
function fixture() {
  let room;
  const posts=[], writes=[];
  const client={user:{id:bot},rest:{async put(route,{body}) {write(route.split('/').at(-1),body);}}};
  const guild={id:guildId,ownerId:owner,client,roles:{async fetch(id){return {id,managed:false};}},channels:{
    async fetch(id){return id?room:new Collection(room?[[room.id,room]]:[]);},
    async create(opts){
      room={id:roomId,guildId,guild,name:opts.name,type:opts.type,topic:opts.topic,permissionOverwrites:{cache:new Collection(),async set(overwrites){
        room.permissionOverwrites.cache.clear(); for(const entry of overwrites) write(entry.id,entry);
      }},messages:{async fetch(opts){return opts.message?posts.find(m=>m.id===opts.message):new Collection(posts.map(m=>[m.id,m]));}},
      async send(p){const post={id:'post-'+posts.length,author:{id:bot},...p,components:p.components.map(row=>({components:row.components.map(b=>({customId:b.custom_id}))}))};posts.push(post);return post;}};
      for(const entry of opts.permissionOverwrites) write(entry.id,entry);
      return room;
    }
  }};
  function write(id,body){writes.push(id);room.permissionOverwrites.cache.set(id,{id,type:body.type,allow:bit(body.allow),deny:bit(body.deny)});}
  const gateway=communityGateway(()=>guild,()=>{});
  return {gateway,posts,writes,getRoom:()=>room};
}

test('technical ticket posts the two intended mentions after confirming private permissions',async()=>{
  const f=fixture();
  const row={id:1,owner:opener,subject:'الوصول',details:'المشكلة',kind:'technical'};
  assert.equal(await f.gateway.ticketRoom(row,{}),roomId);
  const p=f.getRoom().permissionOverwrites.cache;
  assert.deepEqual([...p.keys()],[guildId,opener,bot,SUPPORT]);
  assert.ok(p.get(guildId).deny.has(P.ViewChannel));
  assert.ok(p.get(SUPPORT).allow.has(P.ViewChannel));
  assert.match(f.posts[0].content,new RegExp(`<@${opener}> & <@&${SUPPORT}>`));
  assert.match(f.posts[0].content,/الرجاء انتظار الطاقم وعدم الإزعاج/u);
  assert.equal(f.posts[0].content.match(/حياك الله/gu)?.length,1);
  assert.doesNotMatch(f.posts[0].content,/بدون منشن/u);
  assert.deepEqual(f.posts[0].allowedMentions,{parse:[],users:[opener],roles:[SUPPORT]});
  await f.gateway.ticketRoom(row,{});
  assert.equal(f.posts.length,1);
});

test('complaint has no support role overwrite and never pings the support role',async()=>{
  const f=fixture();
  const row={id:1,owner:opener,kind:'complaint',subject:'شكوى',details:'سر'};
  await f.gateway.ticketRoom(row,{supportRole:SUPPORT});
  assert.deepEqual([...f.getRoom().permissionOverwrites.cache.keys()],[guildId,opener,bot]);
  assert.deepEqual(f.posts[0].allowedMentions,{parse:[],users:[opener,owner],roles:[]});
  assert.match(f.posts[0].content,/حياك الله/u);
});

test('a new complaint permits only its opener, Staff Managers and bot in the channel overwrites',async()=>{
  const f=fixture(), managerRole='1574013527050424410';
  const row={id:1,owner:opener,kind:'staff-complaint',subject:'Secret subject',details:'Secret details'};
  row.channel=await f.gateway.ticketRoom(row,{supportRole:SUPPORT});
  assert.equal(f.getRoom().name,'ticket-1');
  assert.doesNotMatch(f.getRoom().topic,/Secret/u);
  const p=f.getRoom().permissionOverwrites.cache;
  assert.deepEqual([...p.keys()],[guildId,opener,bot,managerRole]);
  assert.ok(p.get(guildId).deny.has(P.ViewChannel));
  assert.ok(p.get(managerRole).allow.has(P.ViewChannel | P.ReadMessageHistory));
  assert.deepEqual(f.posts[0].allowedMentions,{parse:[],users:[opener],roles:[]});
  p.set(SUPPORT,{id:SUPPORT,type:0,allow:bit(P.ViewChannel),deny:bit(0n)});
  await assert.rejects(f.gateway.ticketRoom(row,{}),{status:409});
  assert.equal(f.posts.length,1);
});

test('private complaint channels are not returned as configurable dashboard destinations',async()=>{
  const f=fixture(), row={id:1,owner:opener,kind:'staff-complaint',subject:'شكوى',details:'سر'};
  await f.gateway.ticketRoom(row,{});
  assert.deepEqual(await f.gateway.destinations(),[]);
});

test('dashboard destinations omit a private complaint older than its ticket list even after its topic changes',async t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const db=store.community;
  const complaint=db.reserveTicket('complaint',opener,'Private subject','staff-complaint','Private details');
  db.setChannel(complaint.id,roomId);
  db.ticketState(complaint.id,'open','closed');
  for (let n=0;n<100;n++) db.reserveTicket(`new:${n}`,`filler:${n}`,'Filler');
  assert.equal(db.tickets().some(row=>row.id===complaint.id),false);
  const ordinary={id:guest,name:'general',type:ChannelType.GuildText};
  const privateRoom={id:roomId,name:'private-complaint',type:ChannelType.GuildText,topic:'Edited Discord topic'};
  const gateway=communityGateway(()=>({channels:{fetch:async()=>new Collection([[roomId,privateRoom],[guest,ordinary]])}}));
  const app=createApp({store,discord:{dashboardAccess:async()=>({rights:{config:true,tickets:true,legacyTickets:true}}),destinations:gateway.destinations}});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>app.close(r)));
  const session=store.redeem(store.loginCode(guest));
  const res=await fetch(`http://127.0.0.1:${app.address().port}/api/staff`,{headers:{cookie:`bl_session=${session}`}});
  assert.equal(res.status,200);
  const desk=await res.json();
  assert.deepEqual(desk.channels,[{id:guest,name:'general',category:false}]);
  assert.doesNotMatch(JSON.stringify(desk),/Private subject|Private details|private-complaint/u);
});

test('claim blocks the other support writers, preserves privacy and restores just the affected write permissions',async()=>{
  const f=fixture(),row={id:1,owner:opener,kind:'technical',subject:'موضوع',details:'وصف'};
  row.channel=await f.gateway.ticketRoom(row,{});
  const change={member:guest,restoring:0};
  const db={ticketGuests:()=>[],saveClaimOverwrites:(_,plan)=>{change.overwrites=JSON.stringify(plan);}};
  const perms=f.getRoom().permissionOverwrites.cache;
  await f.gateway.syncClaim(row,change,db);
  assert.ok(perms.get(SUPPORT).allow.has(P.ViewChannel));
  assert.ok(perms.get(SUPPORT).deny.has(P.SendMessages | P.SendMessagesInThreads));
  assert.ok(perms.get(guildId).deny.has(P.ViewChannel | P.SendMessages));
  assert.ok(perms.get(guest).allow.has(P.SendMessages));
  assert.ok(!perms.get(guest).allow.has(P.ViewChannel));
  assert.ok(perms.get(opener).allow.has(P.SendMessages));
  assert.ok(perms.get(bot).allow.has(P.SendMessages));
  await f.gateway.syncClaim(row,change,db);
  change.restoring=1;
  await f.gateway.syncClaim(row,change,db);
  assert.ok(perms.get(SUPPORT).allow.has(P.ViewChannel | P.SendMessages));
  assert.ok(perms.get(guildId).deny.has(P.ViewChannel));
  assert.ok(!perms.get(guildId).deny.has(P.SendMessages));
  assert.ok(!perms.has(guest));
});

test('the claim receipt mentions only the verified assignee and includes a same-ticket release button',async()=>{
  const f=fixture(), row={id:1,owner:opener,kind:'technical',subject:'موضوع',details:'وصف',assignee:guest};
  row.channel=await f.gateway.ticketRoom(row,{});
  const room=f.getRoom(), send=room.send.bind(room);
  let wire;
  room.send=payload=>{
    wire=MessagePayload.create({client:{options:{jsonTransformer:x=>x}}},payload).resolveBody().body;
    return send(payload);
  };
  await f.gateway.announceClaim(row,guest,'200000000000000019');
  const receipt=f.posts[1];
  assert.equal(receipt.content,`تم استلام هذه التذكرة من قبل الإداري <@${guest}>`);
  assert.deepEqual(receipt.allowedMentions,{parse:[],users:[guest],roles:[]});
  assert.equal(receipt.components[0].components[0].customId,'blticket:unclaim:1:200000000000000019');
  assert.equal(wire.enforce_nonce,true);
  assert.equal(wire.nonce,'200000000000000019');
});

test('an expired retry finds the original bot-authored receipt without posting another',async()=>{
  const f=fixture(), row={id:1,owner:opener,kind:'technical',subject:'موضوع',details:'وصف',assignee:guest};
  row.channel=await f.gateway.ticketRoom(row,{});
  const nonce='200000000000000019';
  await f.gateway.announceClaim(row,guest,nonce);
  await f.gateway.announceClaim(row,guest,nonce,Date.now()-10*60_000);
  assert.equal(f.posts.length,2);
});

test('an expired retry cannot repost an unconfirmed receipt after Discord deduplication expires',async()=>{
  const f=fixture(), row={id:1,owner:opener,kind:'technical',subject:'موضوع',details:'وصف',assignee:guest};
  row.channel=await f.gateway.ticketRoom(row,{});
  await assert.rejects(f.gateway.announceClaim(row,guest,'200000000000000019',Date.now()-10*60_000),{status:503});
  assert.equal(f.posts.length,1);
});

test('slash-created tickets welcome the opener once without adding a staff ping',async()=>{
  const f=fixture();
  const ticket={id:1,owner:opener,kind:'legacy',subject:'موضوع'};
  await f.gateway.ticketRoom(ticket,{supportRole:SUPPORT});
  await f.gateway.ticketRoom(ticket,{supportRole:SUPPORT});
  assert.equal(f.posts.length,1);
  assert.match(f.posts[0].content,/حياك الله/u);
  assert.deepEqual(f.posts[0].allowedMentions,{parse:[],users:[opener],roles:[]});
});

test('closing a ticket does not restore access for a guest whose Discord grant was removed',async()=>{
  const f=fixture();
  const row={id:1,owner:opener,kind:'technical',subject:'موضوع',details:'وصف'};
  await f.gateway.ticketRoom(row,{});
  await f.gateway.ticketWriting({...row,channel:roomId},false,[guest]);
  const p=f.getRoom().permissionOverwrites.cache;
  assert.ok(p.get(opener).deny.has(P.SendMessages));
  assert.equal(p.has(guest),false);
});

test('an out-of-channel ticket button cannot create a ticket',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());
  const controller=createDiscordTickets({db:store.community,community:{},readyGuild:()=>{}});
  const replies=[];
  assert.equal(await controller.interaction({guildId,channelId:roomId,customId:'blticket:open:complaint',isButton:()=>true,client:{user:{id:bot}},user:{id:opener},message:{author:{id:bot}},async reply(p){replies.push(p);}}),true);
  assert.notEqual(roomId,PANEL);
  assert.match(replies[0].content,/اللوحة|لوحة التذاكر/u);
});
