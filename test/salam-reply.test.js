'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Client,Message}=require('discord.js');
const {catalog}=require('../src/ladder');
const {createMessageHandler}=require('../src/chat');
const {createDiscordTickets}=require('../src/discord-tickets');
const content='**وعليكم السلام ورحمه الله وبركاته** <:G_23:1574000035115302912> .';
const channelId='200000000000000002', id='200000000000000003', user='200000000000000004';
const ticketChannel='200000000000000099';
function fixture({rejectReply=false,shortcuts}={}){
 const bodies=[],xp=[];const client=new Client({intents:[]});
 const store={community:{settings:()=>({levels:true}),addXp:(...args)=>xp.push(args),
  ticketByChannel:channel=>channel===ticketChannel?{id:5,status:'open',owner:user}:null}};
 const tickets=createDiscordTickets({db:store.community});
 const onMessage=createMessageHandler({store,ticketMessages:tickets.text,shortcuts});
 return {bodies,xp,send:(value,{parentId,...extra}={})=>{
  const fields={client,id,channelId,guildId:catalog.guildId,inGuild:()=>true,author:{id:user},createdTimestamp:1,content:value,...extra,
   delete(){assert.fail('Greeting messages must never be deleted');},
   channel:{parentId,async send(payload){assert.equal(typeof payload.resolveBody,'function','Must be a real Discord Reply');bodies.push(payload.resolveBody().body);if(rejectReply)throw Object.assign(new Error('Unknown Message'),{code:10008});return {id:'200000000000000005'};}}};
  const message=Object.create(Message.prototype,Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value}])));
  return onMessage(message);
 }};
}
test('salutations from regular members get the exact emoji reply referencing the source, without a ping or lost XP',async()=>{
 const f=fixture();const inputs=['السلام عليكم','السلام عليكم والرحمة','السلام عليكم ورحمة الله وبركاته','سلام عليكم يا شباب','السَّلَامُ عَلَيْكُمْ، ورحمة الله','والسلام عليكم','**السـلام عليكم**','السلام عليكم👋'];
 for(const value of inputs)await f.send(value);
 assert.equal(f.bodies.length,inputs.length);assert.equal(f.xp.length,inputs.length);
 for(const b of f.bodies){assert.equal(b.content,content);assert.deepEqual(b.message_reference,{message_id:id,fail_if_not_exists:true});assert.deepEqual(b.allowed_mentions.parse,[]);assert.equal(b.allowed_mentions.replied_user,false);}
});
test('quotes, incidental mentions, replies to salam, bots, webhooks and other guilds do not fire',async()=>{
 const f=fixture();
 for(const value of ['قال السلام عليكم','> السلام عليكم','`السلام عليكم`','وعليكم السلام','السلام عليكمات','+السلام عليكم','سلام','مرحبا'])await f.send(value);
 for(const opts of [{author:{id:user,bot:true}},{webhookId:id},{guildId:id}])await f.send('السلام عليكم',opts);
 assert.deepEqual(f.bodies,[]);
});
test('DMs, tickets and their threads get one fixed reply without XP or echoing private text',async()=>{
 const f=fixture();
 await f.send('السلام عليكم والرحمة',{inGuild:()=>false,guildId:null});
 await f.send('وعليكم السلام',{inGuild:()=>false,guildId:null});
 await f.send('السلام عليكم',{inGuild:()=>false,guildId:null,author:{id:user,bot:true}});
 await f.send('السلام عليكم، بيانات خاصة',{channelId:ticketChannel});
 await f.send('سلام عليكم',{parentId:ticketChannel});
 assert.equal(f.bodies.length,3);
 for(const b of f.bodies){assert.equal(b.content,content);assert.equal(b.message_reference.message_id,id);assert.equal(b.allowed_mentions.replied_user,false);}
 assert.deepEqual(f.xp,[]);
});
test('a failed automated reply does not post a second message or suppress XP',async t=>{
 t.mock.method(console,'warn',()=>{});const f=fixture({rejectReply:true});await f.send('السلام عليكم');assert.equal(f.bodies.length,1);assert.equal(f.xp.length,1);
});
