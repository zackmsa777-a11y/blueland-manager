'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ChannelType,MessageFlags}=require('discord.js');
const G='1573975432838127708', L='1575147982381129748', C='1574893689082224660', P='1575632962240774264';
function setup(replacements={}) {
  const {createTempVoiceHooks}=require('../src/lxr-temp-voice-hooks');
  const messages=[];
  let active=true;
  const here={id:G,available:true}, other={id:P,available:true};
  const hooks=createTempVoiceHooks({readyGuild:()=>{if(!active) throw Error('offline');return here;},
    state:{},getWriter:()=>({}),report:()=>messages.push(['error']),
    createLifecycle:opts=>{
      assert.deepEqual([opts.guildId,opts.lobbyId,opts.categoryId],[G,L,C]);
      return {voiceState:(old,v)=>messages.push(['voice',old.channelId,v.channelId]),
        channelDeleted:c=>messages.push(['deleted',c.id]),reconcile:()=>messages.push(['reconcile']),exclusive:f=>f(),...replacements.lifecycle};
    },
    createActions:opts=>{
      assert.equal(opts.panelId,P);assert.equal(opts.exclusive(()=>true),true);
      return {fixture:true};
    },
    createPanel:opts=>{
      assert.equal(opts.actions.fixture,true);
      return {publish:()=>{messages.push(['publish']);return P;},postVoicePanel:()=>{},
        handle:i=>messages.push(['interaction',i.customId]),...replacements.panel};
    }});
  return {hooks,messages,here,other,active:v=>active=v};
}

test('temp voice hooks route only changes in the exact ready guild, separately from voice XP',async()=>{
  const {hooks,messages,here,other,active}=setup();
  await hooks.voiceState({channelId:null},{guild:other,channelId:L});
  await hooks.voiceState({channelId:L},{guild:here,channelId:L});
  await hooks.voiceState({channelId:null},{guild:here,channelId:L});
  await hooks.voiceState({channelId:L},{guild:here,channelId:null});
  active(false);
  await hooks.voiceState({channelId:null},{guild:here,channelId:L});
  assert.deepEqual(messages,[['voice',null,L],['voice',L,null]]);
});

test('channel-delete reconciliation sees only authenticated guild voice channels',async()=>{
  const {hooks,messages}=setup();
  await hooks.channelDeleted({guildId:G,type:ChannelType.GuildText,id:P});
  await hooks.channelDeleted({guildId:P,type:ChannelType.GuildVoice,id:L});
  await hooks.channelDeleted({guildId:G,type:ChannelType.GuildVoice,id:'200000000000000041'});
  assert.deepEqual(messages,[['deleted','200000000000000041']]);
});

test('owned control interactions never fall through, and failures are private and sanitized',async()=>{
  const replies=[];
  const {hooks}=setup({panel:{handle(){throw Error('private example');}}});
  const i={guildId:G,customId:'lxr-temp-voice:name',reply:async payload=>replies.push(payload)};
  assert.equal(await hooks.handle({...i,customId:'other:name'}),false);
  assert.equal(await hooks.handle({...i,guildId:P}),false);
  assert.equal(await hooks.handle(i),true);
  assert.equal(replies.length,1);
  assert.equal(replies[0].flags,MessageFlags.Ephemeral);
  assert.deepEqual(replies[0].allowedMentions,{parse:[]});
  assert.doesNotMatch(replies[0].content,/private example/u);
});

test('one public publish is independent of periodic voice reconciliation',async()=>{
  const {hooks,messages}=setup();
  await hooks.tick();
  await hooks.tick();
  assert.deepEqual(messages,[['publish'],['reconcile'],['reconcile']]);
});
