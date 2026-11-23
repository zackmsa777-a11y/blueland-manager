'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Client,MessagePayload,ChannelType}=require('discord.js');
const {createDiscordPool}=require('../src/discord-pool');
const {catalog}=require('../src/ladder');
const player='200000000000000001', other='200000000000000002', guest='200000000000000003', msg='200000000000000005', panel='200000000000000006', voice='200000000000000007', text='200000000000000008';
function fixture(ctx){
 const client=new Client({intents:[]}), payloads=[], clicks=[], inVoice=new Map();
 const room={id:voice,type:ChannelType.GuildVoice,async send(out){payloads.push(MessagePayload.create({client},out).resolveBody().body);return {id:'voice-post',url:'https://discord.com/channels/test/voice/post',edit:async()=>{}};}};
 const saved={id:panel,edit:async out=>{payloads.push(MessagePayload.create({client},out).resolveBody().body);}};
 const v=id=>inVoice.get(id)??null;
 const guild={voiceStates:{cache:{get:id=>v(id)}},members:{async fetch({user}){return {user:{id:user,bot:false}};}},channels:{async fetch(){return {messages:{async fetch(){return saved;}}};}}};
 const adapter=createDiscordPool({guildId:catalog.guildId,readyGuild:()=>guild,available:()=>true});ctx.after(()=>adapter.close());
 const message={id:msg,author:{id:player},channelId:text,guildId:catalog.guildId,guild,async reply(out){payloads.push(MessagePayload.create({client},out).resolveBody().body);return saved;}};
 const click=(action,user)=>({customId:`blpool:${msg}:${action}`,isButton:()=>true,guildId:catalog.guildId,channelId:action==='launch'?voice:text,message:{id:action==='launch'?'voice-post':panel},user:{id:user},
  async reply(out){clicks.push(out.content);},async deferReply(){this.deferred=true;},async editReply(out){clicks.push(out.content);},async deferUpdate(){this.deferred=true;},async launchActivity(){clicks.push('launch:'+user);}});
 return {adapter,message,click,clicks,payloads,inVoice,room};
}
test('real Discord payload opens a challenge from chat and only seats can open from the same normal voice channel',async ctx=>{
 const f=fixture(ctx);
 assert.equal(await f.adapter.text(f.message,'+8ball <@'+other+'>'),true);
 assert.equal(f.payloads[0].embeds[0].title,'8 Ball Challenge');assert.deepEqual(f.payloads[0].components[0].components.map(b=>b.label),['Accept','Decline','Withdraw']);
 assert.deepEqual(f.payloads[0].allowed_mentions.users,[other]);
 await f.adapter.handle(f.click('accept',guest));assert.match(f.clicks.at(-1),/invited/);
 await f.adapter.handle(f.click('accept',other));assert.ok(f.payloads.at(-1).components[0].components.some(b=>b.label==='Open Table'));
 await f.adapter.handle(f.click('open',player));assert.match(f.clicks.at(-1),/voice channel/);
 f.inVoice.set(player,{channel:{id:voice,type:ChannelType.GuildStageVoice}});await f.adapter.handle(f.click('open',player));assert.match(f.clicks.at(-1),/voice channel/);
 f.inVoice.set(player,{channel:f.room});await f.adapter.handle(f.click('open',player));assert.match(f.clicks.at(-1),/discord.com\/channels/);assert.equal(f.payloads.at(-1).components[0].components[0].label,'Open Table');
 await f.adapter.handle(f.click('launch',player));assert.equal(f.clicks.at(-1),'launch:'+player);
 f.inVoice.set(other,{channel:{id:'another',type:ChannelType.GuildVoice}});await f.adapter.handle(f.click('open',other));assert.match(f.clicks.at(-1),/same voice/);
 f.inVoice.set(other,{channel:f.room});await f.adapter.handle(f.click('open',other));assert.match(f.clicks.at(-1),/discord.com\/channels/);await f.adapter.handle(f.click('launch',other));assert.equal(f.clicks.at(-1),'launch:'+other);
 assert.equal(f.payloads.filter(p=>p.components[0]?.components[0]?.custom_id.endsWith(':launch')).length,1);
 const m=f.adapter.pool.join(player,voice,'activity');f.adapter.pool.join(other,voice,'activity');
 await m.edited;
 const game=m.game;game.groups=[1,2];game.breaking=false;for(const ball of game.balls)ball.out=ball.n!==0&&ball.n!==8;
 Object.assign(game.cue,{x:480,y:125});Object.assign(game.balls.find(ball=>ball.n===8),{x:480,y:55});
 f.adapter.pool.act(m,player,'activity',{type:'shot',angle:-Math.PI/2,power:.25,call:1,rev:0});
 m.sim-=1000;for(let x=0;x<10&&m.phase==='playing';x++)f.adapter.pool.tick();
 assert.equal(m.phase,'done');await m.edited;assert.match(f.payloads.at(-1).embeds[0].description,/left the voice channel/);
 f.inVoice.delete(player);await f.adapter.voiceChanged(player,voice);assert.notEqual(f.payloads.at(-1).embeds[0].title,'8 Ball · Match Result');
 f.inVoice.delete(other);await f.adapter.voiceChanged(other,voice);await f.adapter.voiceChanged(other,voice);
 assert.equal(f.payloads.filter(p=>p.embeds[0].title==='8 Ball · Match Result').length,1);
 assert.match(f.payloads.at(-1).embeds[0].description,new RegExp(`<@${player}> won`));
});
