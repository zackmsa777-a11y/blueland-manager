'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Client,REST,Events,GatewayIntentBits,Routes}=require('discord.js');
const {openStore}=require('../src/store');
const G='1573975432838127708', B='1573988210185347223', U='200000000000000001', L='1575147982381129748';

test('the installed app routes Discord voice lifecycle and temp voice components without replacing existing listeners',async t=>{
  const factory=require('../src/lxr-temp-voice-hooks');
  const observed=[];
  t.mock.method(factory,'createTempVoiceHooks',opts=>{
    assert.equal(typeof opts.state.get,'function');
    assert.equal(typeof opts.readyGuild,'function');
    assert.equal(typeof opts.getWriter,'function');
    return {voiceState:(old,next)=>observed.push(['voice',old.channelId,next.channelId]),
      channelDeleted:c=>observed.push(['deleted',c.id]),
      handle:i=>{if(i.customId!=='lxr-temp-voice:name') return false;observed.push(['interaction',i.customId]);return true;},
      tick:()=>observed.push(['tick'])};
  });
  const {connectDiscord}=require('../src/discord');
  const store=openStore(':memory:');
  let client;
  t.mock.method(REST.prototype,'get',async route=>{
    if(route===Routes.oauth2CurrentApplication()) return {id:B,flags:'0'};
    throw Error('Unrelated read suppressed in offline fixture');
  });
  t.mock.method(REST.prototype,'put',async()=>[]);
  t.mock.method(REST.prototype,'post',async()=>assert.fail('No live moderation or panel writes'));
  t.mock.method(Client.prototype,'login',async function(){client=this;});
  t.mock.method(console,'warn',()=>{});
  const bot=connectDiscord(store,{DISCORD_BOT_TOKEN:'synthetic'});
  try {
    await bot.start();
    assert.equal(factory.createTempVoiceHooks.mock.callCount(),1);
    assert.ok(client.options.intents.has(GatewayIntentBits.GuildVoiceStates));
    client.user={id:B};client.isReady=()=>true;
    const guild=client.guilds._add({id:G,name:'fixture',owner_id:U,roles:[],members:[],channels:[],voice_states:[]});
    guild.available=true;
    client.emit(Events.ClientReady,client);
    client.emit(Events.VoiceStateUpdate,{channelId:null,guild,id:U},{channelId:L,guild,id:U});
    await client.listeners(Events.InteractionCreate)[0]({guildId:G,customId:'lxr-temp-voice:name',isChatInputCommand:()=>false});
    client.emit(Events.ChannelDelete,{guildId:G,id:'200000000000000045'});
    await new Promise(setImmediate);
    assert.deepEqual(observed,[['tick'],['voice',null,L],['interaction','lxr-temp-voice:name'],['deleted','200000000000000045']]);
  } finally {bot.close();store.close();}
});
