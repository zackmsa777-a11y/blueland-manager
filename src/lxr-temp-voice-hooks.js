'use strict';
const {ChannelType,EmbedBuilder,MessageFlags}=require('discord.js');
const guildId='1573975432838127708', lobbyId='1575147982381129748';
const categoryId='1574893689082224660', panelId='1575632962240774264';
const prefix='lxr-temp-voice:';
const safeId=value=>typeof value==='string' && /^[1-9]\d{16,19}$/u.test(value);

function createTempVoiceHooks({readyGuild,state,getWriter,
  createLifecycle=options=>require('./lxr-temp-voice-lifecycle').createTempVoiceLifecycle(options),
  createActions=options=>require('./lxr-temp-voice-actions').createTempVoiceActions(options),
  createPanel=options=>require('./lxr-temp-voice-panel').createTempVoicePanel(options),
  report=operation=>console.warn('LXR temp voice:',operation)}) {
  const scope={state,guildId,lobbyId,categoryId,panelId,readyGuild,getWriter};
  const checkedRooms=new Set(), retryRooms=new Map();
  const lifecycle=createLifecycle({...scope,postVoicePanel:async(guild,id)=>{
    const result=await panel.postVoicePanel(guild,id);
    if(safeId(result)) checkedRooms.add(id);
    return result;
  }});
  const actions=createActions({...scope,exclusive:work=>lifecycle.exclusive(work)});
  const panel=createPanel({...scope,actions});
  let ticking, published=false, cursor=0, cycle=0;
  function available() {
    try {
      const guild=readyGuild();
      return guild?.id===guildId && guild.available ? guild : undefined;
    } catch { return undefined; }
  }
  async function safe(operation,work) {
    try { return await work(); } catch { report(operation); }
  }
  async function voiceState(old,next) {
    const guild=available();
    if (!guild || next?.guild!==guild || old?.channelId===next.channelId) return;
    await safe('voice event',()=>lifecycle.voiceState(old,next));
  }
  async function channelDeleted(channel) {
    if (!available() || channel?.guildId!==guildId || channel.type!==ChannelType.GuildVoice || !safeId(channel.id)) return;
    checkedRooms.delete(channel.id);
    retryRooms.delete(channel.id);
    await safe('channel delete',()=>lifecycle.channelDeleted(channel));
  }
  async function handle(i) {
    if (i?.guildId!==guildId || typeof i.customId!=='string' || !i.customId.startsWith(prefix)) return false;
    if (available() && await safe('interaction',()=>panel.handle(i))===true) return true;
    await safe('interaction reply',async()=>{
      const payload={embeds:[new EmbedBuilder().setDescription('ما قدرت أفتح التحكم الآن. ادخل رومك المؤقت وجرّب من جديد.')],
        allowedMentions:{parse:[]}};
      if (i.deferred && !i.replied && i.ephemeral===true) await i.editReply({...payload,content:null,components:[]});
      else if (!i.deferred && !i.replied) await i.reply({...payload,flags:MessageFlags.Ephemeral});
    });
    return true;
  }
  async function upgradeOccupied(guild) {
    const cache=guild.voiceStates?.cache;
    if (!cache?.size || !state.list || !panel.upgradeVoicePanel) return;
    const rooms=state.list();
    const existing=new Set(rooms.map(room=>room.id));
    for(const id of checkedRooms) if(!existing.has(id)) checkedRooms.delete(id);
    for(const id of retryRooms.keys()) if(!existing.has(id)) retryRooms.delete(id);
    if(!rooms.length) return;
    cycle++;
    const occupied=new Set();
    for(const voice of cache.values()) {
      if(voice?.guild===guild && existing.has(voice.channelId) && !voice.member?.user?.bot) occupied.add(voice.channelId);
    }
    // Lifecycle still owns room creation/cleanup and first publication. Only
    // already-served, occupied rooms enter this bounded format upgrade.
    let attempts=0;
    for(let scanned=0;scanned<Math.min(32,rooms.length)&&attempts<2;scanned++) {
      const room=rooms[cursor%rooms.length];
      cursor=(cursor+1)%rooms.length;
      if(!safeId(room.id)||!occupied.has(room.id)||checkedRooms.has(room.id)||(retryRooms.get(room.id)??0)>cycle||
        state.get(room.id)?.panelReady!==true) continue;
      attempts++;
      retryRooms.set(room.id,cycle+3);
      await safe('upgrade voice panel',async()=>{
        await panel.upgradeVoicePanel(guild,room.id);
        checkedRooms.add(room.id);
        retryRooms.delete(room.id);
      });
    }
  }
  function tick() {
    const guild=available();
    if (!guild) return;
    if (ticking) return ticking;
    ticking=Promise.all([published?undefined:safe('publish panel',async()=>{published=safeId(await panel.publish());}),
      safe('reconcile',()=>lifecycle.reconcile()).then(()=>available()===guild && safe('upgrade voice panels',()=>upgradeOccupied(guild)))
    ]).finally(()=>{ticking=undefined;});
    return ticking;
  }
  return {voiceState,channelDeleted,handle,tick};
}
module.exports={createTempVoiceHooks};
