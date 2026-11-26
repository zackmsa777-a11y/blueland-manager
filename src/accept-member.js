'use strict';
const {DiscordAPIError,RESTJSONErrorCodes:E,Routes,PermissionFlagsBits:P}=require('discord.js');
const {catalog,roles,ladder,compareRoles,RuleError}=require('./ladder');
const {roleAutoReply}=require('../config/discord-features.json');
const {loadReviewedBaseline,reviewedBaseline,verifyOverwrites}=require('./accept-member-overwrites');
const {mutateMember}=require('./promotions');

const POWER='1574012924916142140';
const GRANTS=['1574013472013033622','1575153809603428393','1574013576694210731','1574013479466303499','1574013476358328441'];
const OTHER_RANKS=new Set(ladder.flatMap(({id,group})=>[id,group.variant]).filter(id=>id!==GRANTS[0]));
const FRESH_MS=4_000;
const NONCE_WINDOW_MS=60_000;
const noPings={parse:[],repliedUser:false};
const welcome=id=>`<:G_21:1574000061229305886> **تمت إضافة رتبك يا <@${id}>. نورتنا بالإدارة!** <:G_23:1574000035115302912>\n<:G_25:1574000020783370370> مرّ على <#1575179775671140442> عشان تتابع أخبار الطاقم.`;
const snowflake=id=>typeof id==='string' && /^\d{17,20}$/u.test(id);
const isMember=(member,id)=>member?.user?.id===id && Array.isArray(member.roles);
const byRole=all=>new Map(all.map(role=>[role.id,role]));
function highest(byId,member) {
  const assigned=[catalog.guildId,...member.roles].map(id=>byId.get(id));
  if (assigned.some(role=>!role || !Number.isSafeInteger(role.position))) return null;
  return assigned.sort(compareRoles)[0];
}
function actorRank(byId,sender,actor) {
  if (!isMember(sender,actor) || sender.user.bot || !sender.roles.includes(roleAutoReply.roleId)) return null;
  const power=byId.get(POWER), top=highest(byId,sender);
  return power && Number.isSafeInteger(power.position) && top && compareRoles(top,power)<=0 ? top : null;
}

function welcomeRejection(err,status) {
  if (!(err instanceof DiscordAPIError) || err.status!==status || typeof err.rawError?.message!=='string') return null;
  const referenceErrors=err.rawError.errors?.message_reference?._errors;
  if ((status===404 && err.code===E.UnknownMessage) ||
      (status===400 && err.code===E.InvalidFormBodyOrContentType && Array.isArray(referenceErrors) &&
       referenceErrors.some(item=>item?.code==='MESSAGE_REFERENCE_UNKNOWN_MESSAGE'))) return 'dead';
  // A permissions rejection can be retried, but does not prove the original message is gone.
  if (status===403 && [E.MissingAccess,E.MissingPermissions].includes(err.code)) return 'retry';
  return null;
}

async function deliverWelcome(outbox,entry,rest,target,{signal,assertFresh}) {
  const {channel,reference,attempted}=entry;
  const content=welcome(target);
  const matches=m=>snowflake(m?.id) && m.author?.id===catalog.botId && m.channel_id===channel && m.content===content &&
    m.message_reference?.message_id===reference && m.message_reference?.channel_id===channel &&
    m.mentions?.length===1 && m.mentions[0].id===target;
  const route=Routes.channelMessages(channel);
  let posted=entry.posted;
  if (!posted) {
    const now=Date.now(), elapsed=now-attempted;
    if (attempted!==null && (elapsed<0 || elapsed>=NONCE_WINDOW_MS-FRESH_MS)) {
      // Outside Discord's short nonce window, recover a verified receipt or stop rather than duplicate the welcome.
      const recent=await rest.get(route,{query:new URLSearchParams({after:reference,limit:'100'}),signal:AbortSignal.timeout(FRESH_MS)});
      posted=recent.find(matches)?.id;
      if (!posted) throw new RuleError('تم التأكد من الرتب، لكن لم نجد تأكيد رسالة الترحيب. راجع الرسائل قبل نشر ترحيب آخر.');
    } else {
      outbox.markAttempt(target,reference,now);
      let firstStatus;
      // Only a known rejection on the first wire attempt can release the attempt stamp.
      // A later response may follow an SDK retry after the first request already posted.
      const observe=(request,response)=>{
        if (firstStatus===undefined && request.data?.signal===signal && request.path===route && request.method==='POST')
          firstStatus=request.retries===0?response.status:null;
      };
      if (attempted===null) rest.on('response',observe);
      try {
        assertFresh();
        const result=await rest.post(route,{signal,body:{
          content,allowed_mentions:{parse:[],users:[target],replied_user:false},
          nonce:reference,enforce_nonce:true,
          message_reference:{message_id:reference,channel_id:channel,guild_id:catalog.guildId,fail_if_not_exists:true}
        }});
        if (matches(result)) posted=result.id;
      } catch (err) {
        const rejection=welcomeRejection(err,firstStatus);
        if (rejection) outbox.rejectAttempt(target,reference,now,rejection==='dead');
        throw err;
      } finally {
        if (attempted===null) rest.off('response',observe);
      }
    }
    if (!posted) throw new Error('Welcome receipt could not be located');
    outbox.markPosted(target,reference,posted);
  }
  if (!snowflake(posted)) throw new Error('Invalid welcome receipt');
  const checked=await rest.get(Routes.channelMessage(channel,posted),{signal:AbortSignal.timeout(FRESH_MS)});
  if (checked?.id!==posted || !matches(checked)) throw new Error('Welcome readback failed');
  outbox.complete(target,reference);
}

function createAcceptMember({store,overwrites=loadReviewedBaseline()}) {
  const baseline=reviewedBaseline(GRANTS,overwrites);

  return async function accept(message,text) {
    const [command,...parts]=text.split(/\s+/u);
    if (command!==roleAutoReply.trigger || !parts.length) return false;
    const target=parts.length===1 && /^<@!?(\d{17,20})>$/u.exec(parts[0])?.[1];
    if (!target) return false;
    const guild=message.guild, client=message.client;
    if (message.guildId!==catalog.guildId || guild?.id!==catalog.guildId || client?.user?.id!==catalog.botId) return true;
    const actor=message.author.id, rest=client.rest;
    const member=(id,signal)=>rest.get(Routes.guildMember(guild.id,id),{signal});
    const liveRoles=signal=>rest.get(Routes.guildRoles(guild.id),{signal});
    const reply=content=>message.reply({content,allowedMentions:{...noPings,users:[]}}).catch(()=>{});
    async function snapshot() {
      // Same deadline for the snapshot and the ensuing PUT, including the REST queue.
      // Discord has no API for an atomic authorization + role change.
      const start=performance.now(), signal=AbortSignal.timeout(FRESH_MS);
      const assertFresh=()=>{
        if (signal.aborted || performance.now()-start>=FRESH_MS) throw new Error('Acceptance snapshot expired');
      };
      const [sender,person,bot,all,liveGuild,channels]=await Promise.all([
        member(actor,signal),member(target,signal),member(catalog.botId,signal),liveRoles(signal),
        rest.get(Routes.guild(guild.id),{signal}),rest.get(Routes.guildChannels(guild.id),{signal})
      ]);
      const byId=byRole(all), senderTop=actorRank(byId,sender,actor);
      if (!senderTop) throw new RuleError('تغيّرت صلاحية تنفيذ القبول.');
      if (liveGuild?.id!==guild.id || !snowflake(liveGuild.owner_id)) throw new Error('Missing live guild owner');
      if (target===liveGuild.owner_id) throw new RuleError('ما تقدر تقبل مالك السيرفر.');
      if (!isMember(person,target) || person.user.bot || person.pending || !isMember(bot,catalog.botId) || bot.user.bot!==true) throw new RuleError('اختَر عضو بشري فعّال في السيرفر.');
      const targetTop=highest(byId,person), botTop=highest(byId,bot);
      if (!targetTop || !botTop || compareRoles(senderTop,targetTop)>=0 || compareRoles(botTop,targetTop)>=0) throw new RuleError('رتبة العضو لازم تكون أقل من رتبتك ورتبة البوت.');
      const permissions=[guild.id,...bot.roles].reduce((bits,id)=>bits|BigInt(byId.get(id).permissions),0n);
      if (!(permissions&(P.Administrator|P.ManageRoles))) throw new RuleError('البوت ما عنده صلاحية إدارة الرتب.');
      if (person.roles.some(id=>OTHER_RANKS.has(id))) throw new RuleError('العضو معه درجة ثانية في سلّم الإدارة. استخدم أمر السلّم بدل القبول.');
      for (const id of GRANTS) {
        const role=byId.get(id), approved=roles.get(id);
        if (!role || !approved || !Number.isSafeInteger(role.position) || role.managed!==false || compareRoles(botTop,role)>=0 || compareRoles(senderTop,role)>=0 ||
            (BigInt(role.permissions) & (P.Administrator | ~BigInt(approved.permissions)))!==0n) throw new RuleError('إحدى رتب القبول تغيّرت أو ما يقدر البوت يمنحها.');
      }
      verifyOverwrites(store.community,channels,GRANTS,baseline,{byId,person});
      if (store.pending(target) || store.community.advancementFor?.(target))
        throw new RuleError('لهذا العضو ترقية قيد الاستكمال. راجع سجل الترقيات.',409);
      assertFresh();
      return {held:new Set(person.roles),signal,assertFresh};
    }
    let authorized=false;
    try {
      const signal=AbortSignal.timeout(FRESH_MS);
      const [sender,all]=await Promise.all([member(actor,signal),liveRoles(signal)]);
      if (!actorRank(byRole(all),sender,actor)) return true;
      authorized=true;
      if (target===actor || target===guild.ownerId || target===catalog.botId) throw new RuleError('ما تقدر تقبل نفسك أو مالك السيرفر أو بوت.');
      await mutateMember(store,target,async()=>{
        let state=await snapshot();
        const allHeld=GRANTS.every(id=>state.held.has(id)), outbox=store.acceptance;
        let entry=outbox.byTarget(target);
        if (!entry) {
          if (allHeld) {await reply('رتب القبول موجودة عند هذا العضو بالفعل.');return;}
          if (!snowflake(message.channelId) || !snowflake(message.id)) throw new Error('Invalid acceptance reply destination');
          entry=outbox.begin(target,message.channelId,message.id);
        }
        if (!snowflake(entry?.channel) || !snowflake(entry.reference) || entry.target!==target) throw new Error('Invalid acceptance outbox');
        if (!allHeld && entry.confirmed) throw new RuleError('تغيّرت رتب العضو بعد محاولة الترحيب. راجع الرتب الحالية قبل المتابعة.');
        if (entry.dead_reference) {
          if (!snowflake(message.channelId) || !snowflake(message.id)) throw new Error('Invalid acceptance reply destination');
          if (BigInt(message.id)<=BigInt(entry.reference)) return;
          state.assertFresh();
          entry=outbox.rebind(target,entry.reference,message.channelId,message.id);
          if (!entry) throw new Error('Acceptance outbox changed');
        }
        const mustHold=new Set(GRANTS.filter(id=>state.held.has(id)));
        for (const id of GRANTS) {
          if (state.held.has(id)) continue;
          state.assertFresh();
          await rest.put(Routes.guildMemberRole(guild.id,target,id),{reason:`LXR +مقبول · المسؤول ${actor}`,signal:state.signal});
          mustHold.add(id);
          state=await snapshot();
          if ([...mustHold].some(grant=>!state.held.has(grant))) throw new Error('Role grant verification failed');
        }
        if (!GRANTS.every(id=>state.held.has(id))) throw new Error('Role grant verification failed');
        state.assertFresh();
        try { await deliverWelcome(outbox,entry,rest,target,state); }
        catch (err) {
          if (err instanceof RuleError) throw err;
          throw new RuleError('تم التأكد من الرتب، لكن تعذّر تأكيد رسالة الترحيب. أعد أمر القبول للمحاولة دون إعادة منح الرتب.');
        }
      });
    } catch(err) {
      if (authorized) await reply(err instanceof RuleError?err.message:'تعذّر إكمال إضافة الرتب أو التأكد منها. راجع الرتب الحالية قبل إعادة المحاولة.');
    }
    return true;
  };
}

module.exports={createAcceptMember};
