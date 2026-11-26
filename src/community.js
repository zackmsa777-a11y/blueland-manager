'use strict';

const {PermissionFlagsBits: P} = require('discord.js');
const {catalog,roles,compareRoles,planPromotion,RuleError} = require('./ladder');
const {memberAccess} = require('./promotions');
const {staffGrade,progress} = require('./ticket-points');
const ticketUi=require('./ticket-ui');

const helper = Object.fromEntries(catalog.roles.filter(r=>r.kind==='permission').map(r=>[r.label,r.id]));
const rules = {
  warn:[P.ModerateMembers,helper['#warn/unwarn']], unwarn:[P.ModerateMembers,helper['#warn/unwarn']],
  warnings:[P.ModerateMembers,helper['#warn/unwarn']], mute:[P.ManageRoles,helper['Mute/unmute']],
  unmute:[P.ManageRoles,helper['Mute/unmute']], timeout:[P.ModerateMembers,helper['timeout/untimeout']],
  untimeout:[P.ModerateMembers,helper['timeout/untimeout']], lock:[P.ManageChannels,helper['lock/unlock']],
  unlock:[P.ManageChannels,helper['lock/unlock']], kick:[P.KickMembers], ban:[P.BanMembers], unban:[P.BanMembers]
};
const kinds = {promotion:'ترقية',application:'تقديم الطاقم',general:'طلب عام'};
const requestStates = {pending:'بانتظار المراجعة',processing:'جارٍ تطبيق القرار',approved:'مقبول',rejected:'مرفوض',cancelled:'ألغاه صاحب الطلب'};
function value(text,max=400) {
  const cleaned=String(text ?? '').trim();
  if (!cleaned || cleaned.length>max) throw new RuleError('أدخل نصًا من حرف واحد إلى '+max+' حرفًا.');
  return cleaned;
}
function snowflake(id) {
  if (!/^\d{17,20}$/.test(id || '')) throw new RuleError('معرّف ديسكورد غير صالح.');
  return id;
}
function rowId(id) {
  const n=Number(id);
  if (!Number.isSafeInteger(n) || n<1) throw new RuleError('اكتب رقم السجل الصحيح.');
  return n;
}
function permits(ctx, user, bit) {
  return user.id===ctx.ownerId || (memberAccess(ctx,user).bits & (P.Administrator | bit))!==0n;
}
function verifyActor(ctx,bit,role) {
  if (ctx.actor.bot || !(permits(ctx,ctx.actor,bit) || (role && ctx.actor.roles.includes(role)))) {
    throw new RuleError('تحتاج صلاحية هذا الإجراء أو الرول المرتبط به في BlueLand.',403);
  }
}
function verifyTarget(ctx) {
  const {actor,target,bot}=ctx;
  if (actor.id===target.id || target.id===ctx.ownerId || target.bot || permits(ctx,target,0n)) {
    throw new RuleError('اختر عضوًا آخر تحت رتبتك؛ مالك السيرفر والإداريون والبوتات محميون.',403);
  }
  const highest=memberAccess(ctx,target).highest;
  if (compareRoles(memberAccess(ctx,bot).highest,highest)>=0 ||
      (actor.id!==ctx.ownerId && compareRoles(memberAccess(ctx,actor).highest,highest)>=0)) {
    throw new RuleError('رول العضو أعلى من نطاق صلاحيات المسؤول أو البوت.',403);
  }
}

function createCommunity(store, gateway, promotions) {
  const db=store.community;
  const running=new Map();
  async function exclusive(key,work) {
    if (running.has(key)) throw new RuleError('يجري تنفيذ إجراء على هذا السجل. حاول مجددًا بعد لحظة.',409);
    running.set(key,true);
    try { return await work(); } finally { running.delete(key); }
  }
  async function moderator(actor,action,target) {
    if (!Object.hasOwn(rules,action)) throw new RuleError('أمر الإشراف غير معروف.');
    const channelAction=action==='lock' || action==='unlock';
    const ctx=await gateway.context(actor,channelAction || action==='unban' ? actor : snowflake(target));
    verifyActor(ctx,...rules[action]);
    if (!channelAction && !['unban','warnings'].includes(action)) verifyTarget(ctx);
    return ctx;
  }
  async function moderate({delivery,actor,action,target,channel,originChannel,reason,minutes,caseId,created=Date.now()}) {
    snowflake(actor);
    const roomAction=['lock','unlock','mute','unmute'].includes(action);
    if (roomAction) snowflake(channel);
    if (action==='lock' || action==='unlock') target=channel;
    snowflake(target);
    return exclusive('mod:'+target,async()=>{
      const ctx=await moderator(actor,action,target);
      // A room argument must not override the location where the command was invoked.
      for (const id of new Set([originChannel,channel])) {
        if (id!==null && id!==undefined) await gateway.assertGenericChannel?.(id);
      }
      const why=value(String(reason ?? '').trim() || 'بأمر المسؤول',350);
      if (action==='warnings') return db.cases(target).filter(row=>row.action==='warn' && !row.revoked);
      const replay=db.fromEvent(delivery);
      if (replay) return replay;
      if (action==='unwarn') return db.revoke(delivery,actor,target,rowId(caseId),why);
      if (action==='timeout' && (!Number.isInteger(minutes) || minutes<1 || minutes>40320)) throw new RuleError('مدة التايم أوت من دقيقة إلى ٢٨ يومًا.');
      if (roomAction) {
        await gateway.roomPermission({ctx,action,channel,target,db,reason:why});
      } else if (action!=='warn') {
        await gateway.memberAction({ctx,action,target,expiry:action==='timeout'?created+minutes*60000:null,reason:why});
      }
      return db.record(delivery,action,actor,target,why);
    });
  }
  async function checkModeration(actor,action) {
    if(!Object.hasOwn(rules,action))throw new RuleError('أمر الإشراف غير معروف.',403);
    verifyActor(await gateway.context(snowflake(actor)),...rules[action]);
  }
  async function manager(actor) { const ctx=await gateway.context(actor); verifyActor(ctx,P.ManageGuild); return ctx; }
  async function support(actor) {
    const ctx=await gateway.context(actor);
    verifyActor(ctx,P.ManageChannels,db.settings().supportRole);
    return ctx;
  }
  async function reviewer(actor) { const ctx=await gateway.context(actor); promotions.checkOperator(ctx); return ctx; }
  async function dashboard(actor) {
    const ctx=await gateway.context(actor);
    let review=true;
    try { promotions.checkOperator(ctx); } catch(err) { if (!(err instanceof RuleError)) throw err; review=false; }
    const config=permits(ctx,ctx.actor,P.ManageGuild);
    const legacyClaim=actor===ctx.ownerId || ctx.actor.roles.includes(db.settings().supportRole);
    const legacyTickets=permits(ctx,ctx.actor,P.ManageChannels) || legacyClaim;
    const complaintTickets=actor===ctx.ownerId;
    const staffComplaints=complaintTickets || ctx.actor.roles.includes(ticketUi.MANAGERS);
    const technicalTickets=complaintTickets || ctx.actor.roles.includes(ticketUi.SUPPORT);
    const tickets=legacyTickets || technicalTickets || staffComplaints;
    const cases=config || permits(ctx,ctx.actor,P.ModerateMembers) || ctx.actor.roles.includes(helper['#warn/unwarn']);
    const grade=staffGrade(ctx.actor.roles);
    if (ctx.actor.bot || !(grade || review || tickets || cases || config)) throw new RuleError('دخول الطاقم يحتاج إلى رول مخوّل في BlueLand.',403);
    return {id:actor,name:ctx.actor.name,points:progress(db,actor,grade,ctx.ownerId),
      rights:{review,config,tickets,cases,legacyTickets,legacyClaim,complaintTickets,staffComplaints,technicalTickets,ticketAdmin:permits(ctx,ctx.actor,0n)}};
  }
  async function submit({actor,kind,body,delivery}) {
    if (!Object.hasOwn(kinds,kind)) throw new RuleError('اختر نوع طلب صالحًا.');
    const ctx=await gateway.context(actor);
    if (ctx.actor.bot) throw new RuleError('تقديم الطلبات مخصص لأعضاء السيرفر.',403);
    const text=value(body,650);
    let expected=null;
    if (kind!=='general') {
      const plan=planPromotion(ctx.actor.roles);
      if (kind==='application' && plan.from) throw new RuleError('أنت ضمن الطاقم بالفعل. استخدم طلب ترقية.');
      expected=plan.from;
    }
    return db.submit(delivery,actor,kind,text,expected);
  }
  async function applyRequest(row) {
    try {
      if (row.kind!=='general') await promotions.execute({id:'request:'+row.id,actor:row.reviewer,target:row.owner,source:'request',expectedFrom:catalog.roleAliases?.[row.expected] || row.expected});
      db.finishReview(row.id,'approved');
    } catch(err) {
      if (!store.byId('request:'+row.id) && err instanceof RuleError && [400,403,404,409].includes(err.status)) db.finishReview(row.id,'pending');
      throw err;
    }
    return db.request(row.id);
  }
  async function review(actor,id,decision,note) {
    await reviewer(actor);
    if (!['approve','reject'].includes(decision)) throw new RuleError('قرار المراجعة غير صالح.');
    id=rowId(id);
    return exclusive('request:'+id,async()=>{
      const row=db.request(id);
      if (!row) throw new RuleError('الطلب غير موجود.',404);
      if (actor===row.owner) throw new RuleError('يجب أن يراجع طلبك مسؤول آخر.',403);
      if (row.state!=='pending') throw new RuleError('هذا الطلب سبقت مراجعته. حدّث القائمة.',409);
      const comment=String(note || '').trim();
      if (comment.length>350 || (decision==='reject' && !comment)) throw new RuleError('اكتب سبب المراجعة، بحد أقصى ٣٥٠ حرفًا.');
      if (!db.review(id,decision==='reject'?'rejected':'processing',actor,comment)) throw new RuleError('سبق لمسؤول آخر مراجعة الطلب.',409);
      return decision==='reject' ? db.request(id) : applyRequest(db.request(id));
    });
  }
  async function finishTicket(row) {
    if (row.state==='opening') {
      try {
        const channel=await gateway.ticketRoom(row,db.settings());
        db.setChannel(row.id,channel);
      } catch(err) {
        if (err instanceof RuleError && [400,403,404].includes(err.status)) db.releaseOpening(row.id);
        throw err;
      }
    } else if (row.state==='closing' || row.state==='reopening') {
      const closing=row.state==='closing';
      try { await gateway.ticketWriting(row,!closing,db.ticketGuests(row.id)); }
      catch(err) {
        if (err instanceof RuleError && err.status===404) db.ticketRemoved(row.channel);
        else if (err instanceof RuleError && err.status===403) db.ticketState(row.id,row.state,closing?'open':'closed');
        throw err;
      }
      if (!closing && row.assignee) {
        db.resyncClaim(row.id);
        await finishClaim(row);
      }
      db.ticketState(row.id,row.state,closing?'closed':'open');
    }
    return db.ticket(row.id);
  }
  async function openTicket(actor,delivery,subject,kind='legacy',details='') {
    if (kind!=='legacy' && !Object.hasOwn(require('./ticket-ui').kinds,kind)) throw new RuleError('اختر نوع التذكرة من اللوحة.');
    const ctx=await gateway.context(actor);
    if (ctx.actor.bot) throw new RuleError('فتح التذاكر مخصص للأعضاء.',403);
    return exclusive('ticket:'+actor,async()=>{
      const text=value(subject,kind==='legacy'?200:120);
      const body=kind==='legacy'?'':value(details,750);
      const previous=db.activeTicket(actor);
      if (previous?.channel && gateway.ticketPresent && !await gateway.ticketPresent(previous.channel)) db.ticketRemoved(previous.channel);
      const reservation=db.reserveTicket(delivery,actor,text,kind,body);
      if (reservation.channel) await gateway.assertGenericChannel?.(reservation.channel);
      return finishTicket(reservation);
    });
  }
  async function ticketStaff(actor,row) {
    if (row.kind==='legacy') return support(actor);
    const ctx=await gateway.context(actor);
    const role=Object.hasOwn(ticketUi.kinds,row.kind) && ticketUi.departmentRole(row.kind);
    if (ctx.actor.bot || (actor!==ctx.ownerId && (!role || !ctx.actor.roles.includes(role)))) {
      throw new RuleError('هذا الإجراء للطاقم المخوّل على هذه التذكرة فقط.',403);
    }
    return ctx;
  }
  async function finishClaim(row) {
    const change=db.claimChange(row.id);
    if (!change || change.synced) return;
    try { await gateway.syncClaim(row,change,db); }
    catch (err) {
      if (err instanceof RuleError && err.status===404 && !await gateway.ticketPresent(row.channel)) db.ticketRemoved(row.channel);
      throw err;
    }
    db.finishClaim(change);
  }
  const awarding=new Set();
  async function advance(member) {
    const award=db.advancementFor(member);
    if (!award || awarding.has(member)) return;
    awarding.add(member);
    const id='ticket-points:'+award.id;
    try {
      if (!store.byId(id)) {
        const ctx=await gateway.context(member);
        const live=staffGrade(ctx.actor.roles);
        if (ctx.actor.bot || member===ctx.ownerId || live?.id!==award.grade) {
          db.endAdvancement(award.id,'superseded');
          if (!ctx.actor.bot && member!==ctx.ownerId) db.queueAdvancement(member,live);
          return;
        }
      }
      await promotions.execute({id,actor:catalog.botId,target:member,expectedFrom:award.grade,source:'ticket-points'});
      db.endAdvancement(award.id,'done');
      if (db.ticketBalance(member).available>=15) {
        const ctx=await gateway.context(member);
        if (!ctx.actor.bot && member!==ctx.ownerId) db.queueAdvancement(member,staffGrade(ctx.actor.roles));
      }
    } catch (err) {
      // The persisted award is retried by recover without charging the balance twice.
      console.warn('Ticket promotion',award.id,err instanceof RuleError?err.message:err.code || err.name);
    } finally { awarding.delete(member); }
  }
  async function ticketAction(actor,id,action,{noticeId}={}) {
    const row=db.ticket(rowId(id));
    if (!row) throw new RuleError('التذكرة غير موجودة.',404);
    const ctx=action==='close' && actor===row.owner ? null : await ticketStaff(actor,row);
    return exclusive('ticket:'+row.owner,async()=>{
      const channel=db.ticket(row.id)?.channel;
      if (channel) await gateway.assertGenericChannel?.(channel);
      const pending=db.claimChange(row.id);
      if (action==='unclaim' && pending && !pending.synced && pending.member===actor) {
        if (!pending.restoring) db.undoClaim(row.id);
        await finishClaim(row);
        return db.ticket(row.id);
      }
      await finishClaim(row);
      const current=db.ticket(row.id);
      if (!current.channel) throw new RuleError('روم هذه التذكرة غير متاح. افتح تذكرة جديدة.',409);
      if (['claim','unclaim'].includes(action)) {
        if (current.state!=='open') throw new RuleError('الاستلام للتذاكر المفتوحة فقط.',409);
        if (action==='claim') {
          const supportRole=ticketUi.departmentRole(current.kind,db.settings());
          if (actor===current.owner || (actor!==ctx.ownerId && !ctx.actor.roles.includes(supportRole)))
            throw new RuleError('الاستلام للطاقم المخوّل على هذا القسم، ولا يمكنك استلام تذكرتك.',403);
          if (current.assignee && current.assignee!==actor) throw new RuleError('سبق لعضو آخر من الدعم استلام هذه التذكرة.',409);
          if (!current.assignee) {
            const grade=actor===ctx.ownerId || (current.kind==='staff-complaint' && !ctx.actor.roles.includes(ticketUi.SUPPORT))
              ?null:staffGrade(ctx.actor.roles);
            db.startClaim(current.id,actor,grade?.id || null,noticeId);
          }
        } else {
          if (current.assignee!==actor) throw new RuleError('إعادة التذكرة متاحة للمستلم فقط.',403);
          db.undoClaim(current.id);
        }
        await finishClaim(current);
        if (action==='claim') {
          const assigned=db.ticket(row.id);
          let noticeFailed=false;
          const claim=db.claimChange(assigned.id);
          if (noticeId && assigned.assignee===actor && claim?.member===actor && claim.notice_nonce) {
            try {
              await gateway.announceClaim(assigned,actor,claim.notice_nonce,claim.notice_attempted,
                ()=>db.startClaimNotice(assigned.id,claim.notice_nonce));
              db.finishClaimNotice(assigned.id,claim.notice_nonce);
            }
            catch { noticeFailed=true; }
          }
          await advance(actor);
          return noticeFailed?{...assigned,noticeFailed}:assigned;
        }
      } else {
        if (!['close','reopen'].includes(action)) throw new RuleError('إجراء التذكرة غير صالح.');
        if (ctx && current.assignee && current.assignee!==actor && !permits(ctx,ctx.actor,0n))
          throw new RuleError('إدارة التذكرة بعد استلامها للمستلم أو Administrator.',403);
        const close=action==='close';
        if (!close && db.activeTicket(row.owner)) throw new RuleError('للعضو تذكرة أخرى مفتوحة.',409);
        if (!db.ticketState(row.id,close?'open':'closed',close?'closing':'reopening')) throw new RuleError('حالة التذكرة تغيّرت. حدّث القائمة.',409);
        return finishTicket(db.ticket(row.id));
      }
      return db.ticket(row.id);
    });
  }
  async function manageTicket(actor,id,action,target) {
    const row=db.ticket(rowId(id));
    if (!row) throw new RuleError('التذكرة غير موجودة.',404);
    return exclusive('ticket:'+row.owner,async()=>{
      const ticket=db.ticket(row.id);
      const ctx=await ticketStaff(actor,ticket);
      if (db.claimChange(ticket.id)?.synced===0) throw new RuleError('يجري تحديث أذونات التذكرة. حاول بعد لحظة.',409);
      if (ticket.assignee && ticket.assignee!==actor && !permits(ctx,ctx.actor,0n))
        throw new RuleError('إدارة التذكرة بعد استلامها للمستلم أو Administrator.',403);
      if (!ticket.channel || !['open','closed'].includes(ticket.state)) throw new RuleError('التذكرة غير متاحة الآن.',409);
      await gateway.assertGenericChannel?.(ticket.channel);
      if (action==='check-delete') return;
      if (action==='rename' || action==='delete') {
        await gateway.editTicketRoom(ticket,action,target);
        if (action==='delete') db.ticketRemoved(ticket.channel);
        return;
      }
      if (!['add','remove'].includes(action)) throw new RuleError('إجراء تذكرة غير صالح.');
      if (ticket.kind==='staff-complaint' && action==='add') throw new RuleError('لا يمكن إضافة ضيوف إلى تذكرة شكوى على إداري.',403);
      snowflake(target);
      const guest=db.ticketGuests(ticket.id).includes(target);
      if (action==='add' && ticket.state!=='open') throw new RuleError('لا يمكن إضافة عضو إلى تذكرة مغلقة.',409);
      if (action==='add' && guest) throw new RuleError('هذا العضو مضاف للتذكرة بالفعل.',409);
      if (action==='remove' && !guest) throw new RuleError('هذا العضو لم تتم إضافته بأمر +add.',409);
      await gateway.editTicketRoom(ticket,action,target,guest);
      if (action==='add') db.rememberTicketGuest(ticket.id,target);
      else db.forgetTicketGuest(ticket.id,target);
    });
  }
  async function saveSettings(actor,input) {
    await manager(actor);
    if (typeof input.levels!=='boolean') throw new RuleError('اختر حالة نظام المستويات.');
    const settings={levels:input.levels};
    for (const key of ['welcomeChannel','ticketCategory','supportRole']) settings[key]=input[key] ? snowflake(input[key]) : '';
    await gateway.validateSettings(settings);
    db.saveSettings(settings);
    return settings;
  }
  async function recover() {
    for (const row of db.processing()) {
      try { await exclusive('request:'+row.id,()=>applyRequest(row)); } catch {}
    }
    for (const row of db.transitioningTickets()) {
      try { await exclusive('ticket:'+row.owner,async()=>{
        const latest=db.ticket(row.id);
        if (latest && ['opening','closing','reopening'].includes(latest.state)) await finishTicket(latest);
      }); } catch {}
    }
    for (const row of db.pendingClaims()) {
      try { await exclusive('ticket:'+row.owner,()=>finishClaim(row)); }
      catch (err) { console.warn('Ticket claim',row.id,err.code || err.message); }
    }
    for (const award of db.pendingAdvancements()) await advance(award.member);
  }
  return {moderate,checkModeration,submit,review,openTicket,ticketAction,manageTicket,support,reviewer,dashboard,saveSettings,recover,manager};
}
module.exports={createCommunity, verifyTarget, kinds, requestStates, snowflake, rowId};
