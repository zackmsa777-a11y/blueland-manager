'use strict';

const {ChannelType,PermissionFlagsBits:P,Routes,OverwriteType} = require('discord.js');
const {catalog,RuleError} = require('./ladder');

const writing = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
const ticketRead = P.ViewChannel | P.ReadMessageHistory;
const ticketWrite = P.SendMessages | P.AttachFiles | P.EmbedLinks;
const roomTypes = [ChannelType.GuildText,ChannelType.GuildAnnouncement];
const helperIds=new Set(catalog.roles.filter(r=>r.kind==='permission').map(r=>r.id));
function discordFailure(err) {
  if (err instanceof RuleError) throw err;
  if ([50013,50001].includes(err.code)) throw new RuleError('ديسكورد رفض الإجراء. راجع صلاحيات البوت وترتيب روله في هذه القناة.',403);
  if ([10003,10007,10011,10013,10026].includes(err.code)) throw new RuleError('لم يعد العنصر موجودًا في هذا السيرفر.',404);
  throw err;
}

function communityGateway(readyGuild,context) {
  async function getChannel(id) {
    const guild=readyGuild();
    try {
      const result=await guild.channels.fetch(id,{force:true});
      if (!result || result.guildId!==guild.id) throw new RuleError('القناة غير موجودة في BlueLand.',404);
      return result;
    } catch(err) { discordFailure(err); }
  }
  async function validateSettings(settings) {
    if (settings.ticketCategory && (await getChannel(settings.ticketCategory)).type!==ChannelType.GuildCategory) throw new RuleError('اختر فئة لقنوات التذاكر.');
    if (settings.welcomeChannel) {
      const c=await getChannel(settings.welcomeChannel);
      if (!roomTypes.includes(c.type) || !c.permissionsFor(c.guild.members.me)?.has([P.ViewChannel,P.SendMessages])) throw new RuleError('اختر قناة نصية يستطيع البوت الإرسال فيها.');
    }
    if (settings.supportRole) {
      const g=readyGuild(), r=await g.roles.fetch(settings.supportRole).catch(()=>null);
      if (!r || r.id===g.id || r.managed) throw new RuleError('اختر رول دعم موجودًا، مخصصًا للأعضاء.');
    }
  }
  async function memberAction({ctx,action,target,expiry,reason}) {
    const guild=readyGuild();
    const opt={reason:'BlueLand / '+ctx.actor.id+' / '+reason};
    try {
      if (action==='ban') return await guild.members.ban(target,{...opt,deleteMessageSeconds:0});
      if (action==='unban') return await guild.members.unban(target,opt.reason);
      if (action==='kick') return await guild.members.kick(target,opt.reason);
      if (action==='timeout' && expiry<=Date.now()) throw new RuleError('انتهت مدة التايم أوت قبل التنفيذ.');
      return await guild.client.rest.patch(Routes.guildMember(guild.id,target),{...opt,body:{
        communication_disabled_until:action==='timeout'?new Date(expiry).toISOString():null
      }});
    } catch(err) { discordFailure(err); }
  }
  async function roomPermission({ctx,action,channel,target,db,reason}) {
    try {
      const c=await getChannel(channel);
      if (!roomTypes.includes(c.type)) throw new RuleError('هذا الأمر يعمل في روم كتابي عادي أو روم إعلانات.');
      const byMember=action==='mute' || action==='unmute';
      const principal=byMember?target:c.guildId;
      const member=await c.guild.members.fetch(ctx.actor.id);
      const actorPerms=c.permissionsFor(member);
      const helperLabel=byMember?'Mute/unmute':'lock/unlock';
      const delegated=ctx.actor.roles.some(id=>helperIds.has(id) && catalog.roles.find(r=>r.id===id)?.label===helperLabel);
      if (!actorPerms?.has(P.ViewChannel) || (!delegated && !actorPerms.has(byMember?P.ManageRoles:P.ManageChannels))) throw new RuleError('صلاحياتك في هذا الروم لا تسمح بالإجراء.',403);
      if (!c.permissionsFor(c.guild.members.me)?.has([P.ViewChannel,P.ManageRoles])) throw new RuleError('يحتاج البوت صلاحية إدارة الأذونات في الروم.',403);
      const key=channel+':'+principal;
      const overwrite=c.permissionOverwrites.cache.get(principal);
      let a=overwrite?.allow.bitfield || 0n, d=overwrite?.deny.bitfield || 0n;
      const put=action==='lock' || action==='mute';
      const old=db.lock(key);
      if (put && !old) {
        if ((d & writing)===writing) throw new RuleError('منع الكتابة مطبّق مسبقًا على هذا الهدف.',409);
        db.rememberLock(key,JSON.stringify({allow:String(a & writing),deny:String(d & writing),existed:Boolean(overwrite)}));
      }
      if (put) { a &= ~writing; d |= writing; }
      else {
        if (!old) throw new RuleError('لا يوجد منع كتابة سجّله BlueLand على هذا الهدف.',409);
        const prior=JSON.parse(old.previous);
        const restored=(a & writing)===BigInt(prior.allow) && (d & writing)===BigInt(prior.deny);
        if (!restored && (d & writing)!==writing) throw new RuleError('تغيّرت أذونات الكتابة خارج البوت. راجع أذونات الروم.',409);
        a=(a & ~writing) | BigInt(prior.allow);
        d=(d & ~writing) | BigInt(prior.deny);
        if (!prior.existed && a===0n && d===0n) {
          if (overwrite) await c.guild.client.rest.delete(Routes.channelPermission(channel,principal),{reason});
          db.forgetLock(key);
          return;
        }
      }
      await c.guild.client.rest.put(Routes.channelPermission(channel,principal),{reason,body:{type:byMember?OverwriteType.Member:OverwriteType.Role,allow:String(a),deny:String(d)}});
      if (!put) db.forgetLock(key);
    } catch(err) { discordFailure(err); }
  }
  async function ticketRoom(row,settings) {
    try {
      const guild=readyGuild();
      const marker='BlueLand ticket '+row.id+' • '+row.owner;
      const channels=await guild.channels.fetch();
      const existing=channels.find(c=>c?.topic?.split('\n')[0]===marker && c.type===ChannelType.GuildText);
      if (existing) {
        if (!existing.permissionOverwrites.cache.get(guild.id)?.deny.has(P.ViewChannel) ||
            !existing.permissionOverwrites.cache.get(row.owner)?.allow.has(P.ViewChannel)) throw new RuleError('خصوصية قناة التذكرة تغيّرت. راجع القناة قبل استكمالها.',409);
        return existing.id;
      }
      await validateSettings({...settings,welcomeChannel:''});
      const overwrites=[
        {id:guild.id,type:OverwriteType.Role,deny:[P.ViewChannel]},
        {id:row.owner,type:OverwriteType.Member,allow:ticketRead | ticketWrite},
        {id:guild.client.user.id,type:OverwriteType.Member,allow:ticketRead | ticketWrite | P.ManageChannels | P.ManageRoles}
      ];
      if (settings.supportRole) overwrites.push({id:settings.supportRole,type:OverwriteType.Role,allow:ticketRead | ticketWrite});
      const room=await guild.channels.create({name:'ticket-'+row.id,type:ChannelType.GuildText,parent:settings.ticketCategory || undefined,
        topic:marker+'\n'+row.subject,permissionOverwrites:overwrites,reason:'BlueLand support ticket '+row.id});
      return room.id;
    } catch(err) { discordFailure(err); }
  }
  async function ticketWriting(row,write) {
    try {
      const c=await getChannel(row.channel);
      if (c.type!==ChannelType.GuildText || !c.topic?.startsWith('BlueLand ticket '+row.id+' • '+row.owner+'\n')) throw new RuleError('هوية قناة التذكرة لا تطابق السجل.',409);
      const overwrite=c.permissionOverwrites.cache.get(row.owner);
      const mask=ticketWrite | writing;
      const grant=((overwrite?.allow.bitfield || 0n) & ~mask) | ticketRead | (write?ticketWrite:0n);
      const deny=((overwrite?.deny.bitfield || 0n) & ~(mask | ticketRead)) | (write?0n:mask);
      await c.guild.client.rest.put(Routes.channelPermission(row.channel,row.owner),{reason:'BlueLand ticket '+row.id,body:{type:OverwriteType.Member,allow:String(grant),deny:String(deny)}});
    } catch(err) { discordFailure(err); }
  }
  async function destinations() {
    const list=await readyGuild().channels.fetch();
    return [...list.values()].filter(c=>c && (roomTypes.includes(c.type) || c.type===ChannelType.GuildCategory))
      .map(c=>({id:c.id,name:c.name,category:c.type===ChannelType.GuildCategory})).sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  }
  async function ticketPresent(id) {
    try { await getChannel(id); return true; } catch(err) { if (err instanceof RuleError && err.status===404) return false; throw err; }
  }
  return {context,memberAction,roomPermission,ticketRoom,ticketWriting,ticketPresent,validateSettings,destinations};
}
module.exports={communityGateway};
