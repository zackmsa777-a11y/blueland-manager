'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Collection,PermissionFlagsBits:P,PermissionsBitField}=require('discord.js');
const {catalog}=require('../src/ladder');
const {openStore}=require('../src/store');
const {communityGateway}=require('../src/discord-community');
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
      room={id:roomId,guildId,guild,type:opts.type,topic:opts.topic,permissionOverwrites:{cache:new Collection(),async set(overwrites){
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
