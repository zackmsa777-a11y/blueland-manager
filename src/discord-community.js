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
      const ui=require('./ticket-ui');
      const {escapeMarkdown}=require('discord.js');
      const guild=readyGuild();
      const marker=ui.marker(row);
      const typed=Object.hasOwn(ui.kinds,row.kind);
      const supportRole=row.kind==='complaint'?'':row.kind==='technical'?ui.SUPPORT:settings.supportRole;
      const channels=await guild.channels.fetch();
      let room=channels.find(c=>c?.topic?.split('\n')[0]===marker && c.type===ChannelType.GuildText);

      if (!room) {
        await validateSettings({...settings,supportRole,welcomeChannel:''});
        const overwrites=[
          {id:guild.id,type:OverwriteType.Role,deny:[P.ViewChannel]},
          {id:row.owner,type:OverwriteType.Member,allow:ticketRead | ticketWrite},
          {id:guild.client.user.id,type:OverwriteType.Member,allow:ticketRead | ticketWrite | P.ManageChannels | P.ManageRoles}
        ];
        if (supportRole) overwrites.push({id:supportRole,type:OverwriteType.Role,allow:ticketRead | ticketWrite});
        room=await guild.channels.create({name:'ticket-'+row.id,type:ChannelType.GuildText,parent:settings.ticketCategory || undefined,
          topic:marker+'\n'+(typed?ui.kinds[row.kind]:row.subject),permissionOverwrites:overwrites,reason:'BlueLand support ticket '+row.id});
      }
      room=await getChannel(room.id);
      const overwrites=room.permissionOverwrites.cache;
      const privacy=room.topic?.split('\n')[0]===marker && overwrites.get(guild.id)?.deny.has(P.ViewChannel) && overwrites.get(row.owner)?.allow.has(P.ViewChannel);
      const foreign=typed && [...overwrites.values()].some(o=>o.id!==guild.id && o.id!==row.owner && o.id!==guild.client.user.id && o.id!==supportRole && o.allow.has(P.ViewChannel));
      if (!privacy || foreign || (typed && supportRole && !overwrites.get(supportRole)?.allow.has(P.ViewChannel))) {
        throw new RuleError('خصوصية قناة التذكرة تغيّرت. راجع القناة قبل استكمالها.',409);
      }
      try {
        const posts=await room.messages.fetch({limit:25,cache:false});
        const greeting=`حياك الله <@${row.owner}>.`;
        const advice='الرجاء انتظار الطاقم وعدم الإزعاج. لا تشارك كلمات سر أو رموز تحقق.';
        const legacyWelcome=`${greeting}\n**🎫 تذكرة دعم · #${row.id}**\n${advice}`;
        const already=posts.some(m=>m.author.id===guild.client.user.id && (typed
          ? m.components.some(r=>r.components.some(b=>b.customId==='blticket:claim:'+row.id))
          : m.content===legacyWelcome));
        if (!already) {
          const team=supportRole?`<@&${supportRole}>`:`<@${guild.ownerId}>`;
          const intro=await room.send(typed ? {
            content:`<@${row.owner}> & ${team}\n**🎫 ${ui.kinds[row.kind]} · #${row.id}**\nحياك الله! ${advice}\n\n**الموضوع:** ${escapeMarkdown(row.subject)}\n**التفاصيل:** ${escapeMarkdown(row.details)}`,
            allowedMentions:{parse:[],users:[...new Set([row.owner,...(supportRole?[]:[guild.ownerId])])],roles:supportRole?[supportRole]:[]},components:ui.controls(row.id)
          } : {content:legacyWelcome,allowedMentions:{parse:[],users:[row.owner],roles:[]},components:ui.controls(row.id)});
          await room.messages.fetch({message:intro.id,force:true,cache:false});
        }
      } catch(err) {
        throw new RuleError('بانتظار تجهيز رسالة التذكرة. جرّب بعد لحظة.',503);
      }
      return room.id;
    } catch(err) { discordFailure(err); }
  }
  async function verifiedTicket(row) {
    const c=await getChannel(row.channel);
    if (c.type!==ChannelType.GuildText || c.topic?.split('\n')[0]!==require('./ticket-ui').marker(row)) {
      throw new RuleError('هوية قناة التذكرة لا تطابق السجل.',409);
    }
    return c;
  }
  async function syncClaim(row,change,db) {
    if (row.kind==='complaint') return;
    try {
      const room=await verifiedTicket(row);
      const existing=room.permissionOverwrites.cache;
      let plan=change.overwrites && JSON.parse(change.overwrites);
      if (change.restoring && !plan) return;
      if (!plan) {
        const guests=new Set(db.ticketGuests(row.id));
        const principals=new Map([...existing.values()].map(o=>[o.id,o.type]));
        principals.set(change.member,OverwriteType.Member);
        principals.set(room.guild.id,OverwriteType.Role);
        plan=[];
        for (const [id,type] of principals) {
          if (id===row.owner || id===room.guild.client.user.id) continue;
          if (guests.has(id) && id!==change.member) {
            const guest=await room.guild.members.fetch({user:id,force:true}).catch(err=>{
              if (err.code!==10007) throw err;
            });
            const support=row.kind==='technical'?require('./ticket-ui').SUPPORT:db.settings().supportRole;
            if (!guest?.roles.cache.has(support)) continue;
          }
          const old=existing.get(id);
          const allow=(old?.allow.bitfield || 0n) & writing, deny=(old?.deny.bitfield || 0n) & writing;
          const claimant=id===change.member;
          const nextAllow=claimant?allow | P.SendMessages:0n;
          const nextDeny=claimant?deny & ~P.SendMessages:writing;
          if (allow!==nextAllow || deny!==nextDeny) {
            plan.push({id,type,allow:String(allow),deny:String(deny),nextAllow:String(nextAllow),nextDeny:String(nextDeny)});
          }
        }
        db.saveClaimOverwrites(row.id,plan);
      }
      const result=new Map([...existing.values()].map(o=>[o.id,{id:o.id,type:o.type,allow:o.allow.bitfield,deny:o.deny.bitfield}]));
      let changed=false;
      for (const patch of plan) {
        const old=result.get(patch.id);
        const beforeAllow=BigInt(patch.allow),beforeDeny=BigInt(patch.deny);
        const afterAllow=BigInt(patch.nextAllow),afterDeny=BigInt(patch.nextDeny);
        const currentAllow=old?.allow || 0n,currentDeny=old?.deny || 0n;
        // On release, preserve individual bits changed by a moderator since the claim.
        const mask=change.restoring ? writing & ~((currentAllow ^ afterAllow) | (currentDeny ^ afterDeny)) : writing;
        const allow=(currentAllow & ~mask) | ((change.restoring?beforeAllow:afterAllow) & mask);
        const deny=(currentDeny & ~mask) | ((change.restoring?beforeDeny:afterDeny) & mask);
        if (allow===currentAllow && deny===currentDeny) continue;
        changed=true;
        if (!allow && !deny) result.delete(patch.id);
        else result.set(patch.id,{id:patch.id,type:patch.type,allow,deny});
      }
      if (changed) await room.permissionOverwrites.set([...result.values()],'BlueLand ticket '+row.id+' / '+(change.restoring?'unclaim':'claim'));
      const live=await verifiedTicket(row);
      for (const patch of plan) {
        const actual=live.permissionOverwrites.cache.get(patch.id),desired=result.get(patch.id);
        if ((((actual?.allow.bitfield || 0n) ^ (desired?.allow || 0n)) & writing) ||
            (((actual?.deny.bitfield || 0n) ^ (desired?.deny || 0n)) & writing)) {
          throw new RuleError('بانتظار تأكيد أذونات الاستلام من ديسكورد.',503);
        }
      }
    } catch(err) { discordFailure(err); }
  }
  async function ticketWriting(row,write,guests=[]) {
    try {
      const c=await verifiedTicket(row);
      const mask=ticketWrite | writing;
      // A manual Discord revocation must survive close/reopen; do not regrant visibility from an old guest record.
      const visibleGuests=guests.filter(id=>c.permissionOverwrites.cache.get(id)?.allow.has(P.ViewChannel));
      const changes=[row.owner,...visibleGuests].map(id=>{
        const old=c.permissionOverwrites.cache.get(id);
        return {id,type:OverwriteType.Member,allow:((old?.allow.bitfield || 0n) & ~mask) | ticketRead | (write?ticketWrite:0n),
          deny:((old?.deny.bitfield || 0n) & ~(mask | ticketRead)) | (write?0n:mask)};
      });
      if (changes.length===1) {
        const [{id,type,allow,deny}]=changes;
        await c.guild.client.rest.put(Routes.channelPermission(row.channel,id),{reason:'BlueLand ticket '+row.id,body:{type,allow:String(allow),deny:String(deny)}});
      } else {
        const edited=new Set(changes.map(o=>o.id));
        const preserved=[...c.permissionOverwrites.cache.values()].filter(o=>!edited.has(o.id))
          .map(o=>({id:o.id,type:o.type,allow:o.allow.bitfield,deny:o.deny.bitfield}));
        await c.permissionOverwrites.set([...preserved,...changes],'BlueLand ticket '+row.id);
      }
      if (row.kind==='technical' || row.kind==='complaint' || guests.length) {
        const live=await verifiedTicket(row);
        for (const change of changes) {
          const check=live.permissionOverwrites.cache.get(change.id);
          if (check?.allow.bitfield!==change.allow || check?.deny.bitfield!==change.deny) throw new RuleError('تعذّر التحقق من أذونات التذكرة.',503);
        }
      }
    } catch(err) { discordFailure(err); }
  }
  async function editTicketRoom(row,action,target,alreadyGuest=false) {
    try {
      const room=await verifiedTicket(row);
      const reason='BlueLand ticket '+row.id+' / '+action;
      if (action==='rename') {
        await room.setName(target,reason);
        if ((await verifiedTicket(row)).name!==target) throw new RuleError('تعذّر التحقق من اسم التذكرة.',503);
      } else if (action==='delete') {
        await room.delete(reason);
        if (await ticketPresent(row.channel)) throw new RuleError('تعذّر التحقق من حذف التذكرة.',503);
      } else if (action==='add' || action==='remove') {
        if (target===row.owner || target===room.guild.client.user.id) throw new RuleError('لا يمكن تغيير وصول صاحب التذكرة أو البوت.');
        const old=room.permissionOverwrites.cache.get(target);
        if (action==='add') {
          if (old && !alreadyGuest) throw new RuleError('للعضو إذن مخصص هنا؛ لم تتغير أذوناته.',409);
          const member=await room.guild.members.fetch({user:target,force:true,cache:false});
          if (member.user.bot || room.permissionsFor(member)?.has(P.ViewChannel) && !alreadyGuest) throw new RuleError('هذا الحساب بوت أو لديه وصول مسبق للتذكرة.',409);
          await room.permissionOverwrites.create(member,{ViewChannel:true,ReadMessageHistory:true,SendMessages:true,AttachFiles:true,EmbedLinks:true},{reason});
          const check=(await verifiedTicket(row)).permissionOverwrites.cache.get(target);
          if (!check?.allow.has(ticketRead | ticketWrite)) throw new RuleError('تعذّر التحقق من إضافة العضو.',503);
        } else if (old) {
          const mask=ticketRead | ticketWrite | writing;
          const allow=old.allow.bitfield & ~mask, deny=old.deny.bitfield & ~mask;
          if (allow || deny) await room.guild.client.rest.put(Routes.channelPermission(row.channel,target),{reason,body:{type:OverwriteType.Member,allow:String(allow),deny:String(deny)}});
          else await room.permissionOverwrites.delete(target,reason);
          const check=(await verifiedTicket(row)).permissionOverwrites.cache.get(target);
          if (check && ((check.allow.bitfield | check.deny.bitfield) & mask)) throw new RuleError('تعذّر التحقق من إزالة وصول العضو.',503);
        }
      }
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
  return {context,memberAction,roomPermission,ticketRoom,ticketWriting,ticketPresent,syncClaim,editTicketRoom,validateSettings,destinations};
}
module.exports={communityGateway};
