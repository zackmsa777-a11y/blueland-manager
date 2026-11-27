'use strict';
const {ChannelType,MessageFlags}=require('discord.js');
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
  const lifecycle=createLifecycle({...scope,postVoicePanel:(...args)=>panel.postVoicePanel(...args)});
  const actions=createActions({...scope,exclusive:work=>lifecycle.exclusive(work)});
  const panel=createPanel({...scope,actions});
  let ticking, published=false;
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
    await safe('channel delete',()=>lifecycle.channelDeleted(channel));
  }
  async function handle(i) {
    if (i?.guildId!==guildId || typeof i.customId!=='string' || !i.customId.startsWith(prefix)) return false;
    if (available() && await safe('interaction',()=>panel.handle(i))===true) return true;
    await safe('interaction reply',async()=>{
      const payload={content:'ما قدرت أفتح التحكم الآن. ادخل رومك المؤقت وجرّب من جديد.',allowedMentions:{parse:[]}};
      if (i.deferred && !i.replied) await i.editReply(payload);
      else if (!i.deferred && !i.replied) await i.reply({...payload,flags:MessageFlags.Ephemeral});
    });
    return true;
  }
  function tick() {
    if (!available()) return;
    if (ticking) return ticking;
    ticking=Promise.all([published?undefined:safe('publish panel',async()=>{published=safeId(await panel.publish());}),
      safe('reconcile',()=>lifecycle.reconcile())]).finally(()=>{ticking=undefined;});
    return ticking;
  }
  return {voiceState,channelDeleted,handle,tick};
}
module.exports={createTempVoiceHooks};
