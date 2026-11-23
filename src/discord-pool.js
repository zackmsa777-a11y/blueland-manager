'use strict';
const {ChannelType,ButtonStyle,MessageFlags}=require('discord.js');
const {createPoolMatchmaker,PoolError}=require('./pool-match');
const trigger=/^\+8ball(?:\s|$)/i;
const input=/^\+8ball\s+<@!?(\d{17,20})>$/i;
const controls=/^blpool:(\d{17,20}):(accept|decline|withdraw|open|launch)$/;
const expected='8 Ball runs inside Discord. Use `+8ball @member` to challenge someone.';
function createDiscordPool({guildId,readyGuild,available=()=>false,now=Date.now,log=()=>{}}){
  const canSend=()=>{try{return available();}catch{return false;}};
  const button=(m,action,label,style)=>({type:2,custom_id:`blpool:${m.id}:${action}`,label,style});
  const mentions={parse:[],repliedUser:false};
  function card(m,notify=false,inVoice=false){
    const [a,b]=m.seats;const matchup=`<@${a}> vs <@${b}>`;
    const stat=(id,s)=>`<@${id}> · Shots: ${s.shots} · Fouls: ${s.fouls} · Pocketed: ${s.potted}`;
    const result=m.phase==='done'&&m.revealResult&&!inVoice;
    const state={pending:`<@${b}>, will you accept?`,accepted:inVoice?'Both players press **Open Table** here.':'Join the same voice channel, then press **Open Table** to find the table in its chat.',playing:'The match is live. Players can press **Open Table** to reconnect.',declined:'Challenge declined.',withdrawn:'Challenge withdrawn.',expired:'This table has expired.',done:inVoice?'Match finished. See the original challenge for the result.':result?`<@${m.seats[m.game.winner]}> won the match.\n\n${m.seats.map((id,i)=>stat(id,m.game.stats[i])).join('\n')}`:'Match finished. The result will appear after both players have left the voice channel.'}[m.phase];
    const buttons=[];
    if(m.phase==='pending')buttons.push(button(m,'accept','Accept',ButtonStyle.Success),button(m,'decline','Decline',ButtonStyle.Danger));
    if(m.phase==='accepted'||m.phase==='playing')buttons.push(button(m,inVoice?'launch':'open','Open Table',ButtonStyle.Primary));
    if(!inVoice&&(m.phase==='pending'||m.phase==='accepted'))buttons.push(button(m,'withdraw','Withdraw',ButtonStyle.Secondary));
    return {content:notify?`<@${b}>`:'',allowedMentions:{...mentions,users:notify?[b]:[]},embeds:[{title:result?'8 Ball · Match Result':'8 Ball Challenge',description:`${matchup}\n\n${state}`,color:0x469f7e}],components:buttons.length?[{type:1,components:buttons}]:[]};
  }
  function update(m){
    if(m.phase==='done'&&!m.revealResult){try{if(m.seats.every(who=>voice(who)!==m.voice))m.revealResult=true;}catch{}}
    if(!m.post||m.edited)return m.edited;
    const posted=m.post;
    const stamp=()=>`${m.phase}:${Boolean(m.revealResult)}`;
    m.edited=(async()=>{
      let out;
      do{out=stamp();await Promise.all([posted.edit(card(m)),m.voicePost?.edit(card(m,false,true))]);}while(out!==stamp());
    })().catch(err=>{log(err.code||err.name);}).finally(()=>{m.edited=null;});
    return m.edited;
  }
  const pool=createPoolMatchmaker({now,changed:update});
  const timer=setInterval(pool.tick,25);timer.unref();
  function voiceChannel(who){const ch=readyGuild().voiceStates.cache.get(who)?.channel;return ch?.type===ChannelType.GuildVoice?ch:null;}
  const voice=who=>voiceChannel(who)?.id??null;
  async function voiceChanged(who,previous){
    for(const m of pool.finished(previous,who))if(!m.revealResult&&m.seats.every(id=>voice(id)!==m.voice))await update(m);
  }
  const plain=(s,privateReply=false)=>({content:s,allowedMentions:mentions,...(privateReply?{flags:MessageFlags.Ephemeral}:{})});
  async function text(message,value){
    if(message.guildId!==guildId||!trigger.test(value))return false;
    const id=input.exec(value)?.[1];
    if(!id){await message.reply(plain(expected));return true;}
    if(!canSend()){await message.reply(plain('8 Ball is not available yet.'));return true;}
    try{
      const member=await message.guild.members.fetch({user:id}).catch(()=>null);
      if(!member||member.user.bot||id===message.author.id)throw new PoolError('Challenge another member, not yourself or a bot.');
      const m=pool.challenge({id:message.id,from:message.author.id,to:id,guild:guildId,text:message.channelId,
        names:[message.member?.displayName||message.author.globalName||message.author.username||'Challenger',member.displayName||member.user.globalName||member.user.username||'Opponent']});
      try{m.post=await message.reply(card(m,true));}catch(err){pool.fail(m.id);throw err;}
    }catch(err){await message.reply(plain(err instanceof PoolError?err.message:'Could not open that challenge.')).catch(()=>{});}
    return true;
  }
  async function handle(i){
    if(!i.isButton()||!i.customId?.startsWith('blpool:'))return false;
    const parts=controls.exec(i.customId), m=parts&&pool.get(parts[1]);
    try{
      const launch=parts?.[2]==='launch';
      if(!m||i.guildId!==guildId||i.channelId!==(launch?m.voice:m.text)||i.message?.id!==(launch?m.voicePost?.id:m.post?.id))throw new PoolError('This challenge is closed.',404);
      if(!canSend())throw new PoolError('8 Ball is not available yet.',503);
      if(launch){
        const wasOpen=m.opened.has(i.user.id);
        pool.open(m.id,i.user.id,voice(i.user.id));
        try{await i.launchActivity();}catch(err){if(!wasOpen)pool.unopen(m,i.user.id);throw err;}
      }else if(parts[2]==='open'){
        const channel=voiceChannel(i.user.id);
        pool.reserve(m.id,i.user.id,channel?.id);
        await i.deferReply({flags:MessageFlags.Ephemeral});
        try{
          if(!m.voicePost&&!m.posting)m.posting=channel.send(card(m,false,true)).then(async p=>{m.voicePost=p;if(m.phase!=='accepted'&&m.phase!=='playing')await p.edit(card(m,false,true));return p;}).finally(()=>{m.posting=null;});
          const p=m.voicePost||await m.posting;
          await i.editReply(plain(`Press **Open Table** in the voice channel chat: ${p.url}`));
        }catch(err){if(!m.voicePost)pool.unreserve(m);log(err.code||err.name);await i.editReply(plain('I could not post in the voice channel chat. Check my permissions there.')).catch(()=>{});}
      }else{
        pool.decision(m.id,i.user.id,parts[2]);await i.deferUpdate();await m.edited;
      }
    }catch(err){if(!i.replied&&!i.deferred)await i.reply(plain(err instanceof PoolError?err.message:'Discord could not open the table. Try again.',true)).catch(()=>{});}
    return true;
  }
  return {text,handle,pool,voice,voiceChanged,close:()=>clearInterval(timer)};
}
module.exports={createDiscordPool};
