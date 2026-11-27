'use strict';

const {AsyncLocalStorage}=require('node:async_hooks');
const {randomBytes}=require('node:crypto');
const {ChannelFlags,ChannelType,GatewayIntentBits,OverwriteType,PermissionFlagsBits,RateLimitError,RESTJSONErrorCodes,Routes,Status}=require('discord.js');

const isId=value=>typeof value==='string' && /^[1-9][0-9]{16,19}$/.test(value);
const isBits=value=>typeof value==='string'&&/^[0-9]{1,40}$/.test(value);
const validSession=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const viewConnect=PermissionFlagsBits.ViewChannel|PermissionFlagsBits.Connect;
const errorIs=(err,code)=>err?.status===404&&err.code===code;
const lobbyBatch=3, lobbyRetryMs=60_000;

function overwrites(channel) {
  const {flags,permission_overwrites:rows}=channel;
  if((flags!==undefined&&(!Number.isSafeInteger(flags)||flags<0||(flags&ChannelFlags.ChannelObfuscated)))||
    !Array.isArray(rows)||rows.some(row=>!isId(row?.id)||![OverwriteType.Role,OverwriteType.Member].includes(row.type)||
    !isBits(row.allow)||!isBits(row.deny))||new Set(rows.map(row=>row.id)).size!==rows.length) {
    throw new Error('Cannot verify voice channel access overwrites');
  }
  return rows.map(({id,type,allow,deny})=>({id,type,allow:BigInt(allow).toString(),deny:BigInt(deny).toString()}))
    .filter(row=>row.allow!=='0'||row.deny!=='0').sort((a,b)=>a.id.localeCompare(b.id));
}
const sameOverwrites=(a,b)=>a.length===b.length&&a.every(({id,type,allow,deny},i)=>
  b[i].id===id&&b[i].type===type&&b[i].allow===allow&&b[i].deny===deny);

function mayJoin(roles,member,acl,guildId,ownerId) {
  if(member.user.id===ownerId) return true;
  const assigned=new Set([guildId,...member.roles]);
  let perms=0n;
  for(const id of assigned) {
    if(!roles.has(id)) return false;
    perms|=roles.get(id);
  }
  if(perms&PermissionFlagsBits.Administrator) return true;
  const everyone=acl.find(row=>row.type===OverwriteType.Role&&row.id===guildId);
  if(everyone) perms=(perms&~BigInt(everyone.deny))|BigInt(everyone.allow);
  let deny=0n,allow=0n;
  for(const row of acl) {
    if(row.type!==OverwriteType.Role||row.id===guildId||!assigned.has(row.id)) continue;
    deny|=BigInt(row.deny);allow|=BigInt(row.allow);
  }
  perms=(perms&~deny)|allow;
  const personal=acl.find(row=>row.type===OverwriteType.Member&&row.id===member.user.id);
  if(personal) perms=(perms&~BigInt(personal.deny))|BigInt(personal.allow);
  return (perms&viewConnect)===viewConnect;
}

function createTempVoiceLifecycle({state,guildId,lobbyId,categoryId,panelId,readyGuild,getWriter,postVoicePanel,
  now=Date.now,moveGraceMs=30_000,maxQueued=32,queueTimeoutMs=10_000}) {
  const scopeIds=[guildId,lobbyId,categoryId,...(panelId===undefined?[]:[panelId])];
  if(!scopeIds.every(isId)||new Set(scopeIds).size!==scopeIds.length) {
    throw new TypeError('Invalid temporary voice scope');
  }
  if(!Number.isSafeInteger(maxQueued)||maxQueued<0||!Number.isSafeInteger(queueTimeoutMs)||queueTimeoutMs<1) {
    throw new TypeError('Invalid temporary voice lock limits');
  }
  let active=false, createRetryAt=-Infinity;
  const queue=[], lockContext=new AsyncLocalStorage();
  const lobbyAttempts=new Map();
  function dispatch() {
    if(active||!queue.length) return;
    const job=queue.shift();
    clearTimeout(job.timer);
    active=true;
    const token={held:true};
    void lockContext.run(token,async()=>{
      try {healthy();job.resolve(await job.work());} catch(err) {job.reject(err);}
      finally {
        token.held=false;
        active=false;
        dispatch();
      }
    });
  }
  function exclusive(work) {
    if(lockContext.getStore()?.held) return Promise.reject(new Error('Recursive temporary voice operation'));
    if(active&&queue.length>=maxQueued) return Promise.reject(new Error('Temporary voice lock busy'));
    return new Promise((resolve,reject)=>{
      const job={work,resolve,reject};
      job.timer=setTimeout(()=>{
        const index=queue.indexOf(job);
        if(index<0) return;
        queue.splice(index,1);
        reject(new Error('Temporary voice lock timed out'));
      },queueTimeoutMs);
      queue.push(job);
      dispatch();
    });
  }
  function healthy(expected) {
    const guild=readyGuild();
    const cache=guild?.voiceStates?.cache;
    if(guild?.id!==guildId||!guild.available||!guild.client?.isReady()||guild.shard?.status!==Status.Ready||
      !guild.client.options.intents.has(GatewayIntentBits.GuildVoiceStates)||!cache||Number.isFinite(cache.maxSize)||
      (expected&&guild!==expected)) throw new Error('Temporary voice gateway not ready');
    return guild;
  }
  const managedId=id=>isId(id)&&!scopeIds.includes(id);
  const roomScope=(channel,id)=>managedId(id)&&channel?.id===id&&
    channel.guild_id===guildId&&channel.type===ChannelType.GuildVoice&&channel.parent_id===categoryId;
  const categoryScope=channel=>channel?.id===categoryId&&channel.guild_id===guildId&&channel.type===ChannelType.GuildCategory;
  const occupied=(guild,id)=>healthy(guild).voiceStates.cache.some(voice=>voice.channelId===id);
  async function readChannel(guild,id) {
    try {return await guild.client.rest.get(Routes.channel(id));}
    catch(err) {if(errorIs(err,RESTJSONErrorCodes.UnknownChannel)) return null;throw err;}
  }
  async function readInventory(guild) {
    const rows=await guild.client.rest.get(Routes.guildChannels(guildId));
    if(!Array.isArray(rows)||rows.some(row=>!isId(row?.id)||(row.guild_id!==undefined&&row.guild_id!==guildId))||
      new Set(rows.map(row=>row.id)).size!==rows.length) throw new Error('Cannot verify temporary voice guild inventory');
    return rows;
  }
  async function source(guild) {
    const [lobby,category]=await Promise.all([readChannel(guild,lobbyId),readChannel(guild,categoryId)]);
    if(lobby?.id!==lobbyId||lobby.guild_id!==guildId||lobby.type!==ChannelType.GuildVoice||
      !categoryScope(category)) return null;
    return {lobby,category};
  }
  async function eligibility(guild,id) {
    const rest=guild.client.rest;
    const [member,roles,identity]=await Promise.all([rest.get(Routes.guildMember(guildId,id)),rest.get(Routes.guildRoles(guildId)),
      rest.get(Routes.guild(guildId))]);
    if(identity?.id!==guildId||!isId(identity.owner_id)||member?.user?.id!==id||
      member.user.bot===true||member.user.system===true||member.pending===true||
      !Array.isArray(member.roles)||!member.roles.every(isId)||
      !Array.isArray(roles)||roles.some(row=>!isId(row?.id)||!isBits(row.permissions))||new Set(roles.map(row=>row.id)).size!==roles.length) return null;
    const byRole=new Map(roles.map(row=>[row.id,BigInt(row.permissions)]));
    return {member,allowed:acl=>mayJoin(byRole,member,acl,guildId,identity.owner_id)};
  }
  async function directVoice(guild,id) {
    let row;
    try {row=await guild.client.rest.get(Routes.guildVoiceState(guildId,id));}
    catch(err) {
      if(errorIs(err,RESTJSONErrorCodes.UnknownVoiceState)||errorIs(err,RESTJSONErrorCodes.UnknownMember)) return null;
      throw err;
    }
    if(row?.user_id!==id||(row.guild_id!==undefined&&row.guild_id!==guildId)||(row.channel_id!==null&&!isId(row.channel_id))||
      !validSession(row.session_id)) throw new Error('Cannot verify temporary voice member state');
    return row.channel_id===null?null:row;
  }
  function stillInLobby(guild,id,session) {
    healthy(guild);
    const current=guild.voiceStates.cache.get(id);
    return current?.guild===guild&&current.id===id&&current.channelId===lobbyId&&current.sessionId===session;
  }
  const pendingMove=record=>!record.opened&&record.moveAt!==null&&record.moveAttempt!==null&&
    isId(record.handoffOwnerId)&&validSession(record.sessionId);
  function gatewayOwnerVoice(guild,voice,record,id=record.id) {
    const owner=record.handoffOwnerId;
    if(voice?.guild!==guild||voice.id!==owner||voice.channelId!==id||voice.sessionId!==record.sessionId) return false;
    const member=voice.member;
    return !member||(member.user?.id===owner&&member.user.bot!==true&&member.user.system!==true&&member.pending!==true);
  }
  function observeGatewayMove(oldVoice,newVoice) {
    const {guild,id,channelId,sessionId}=newVoice;
    const prior=oldVoice?.channelId;
    // The live SDK mutates the cached voice object in place. Use transition
    // proof only here, while the ready gateway cache reflects this exact event.
    if(guild.voiceStates?.cache?.get(id)!==newVoice) return;
    const departing=managedId(prior)&&validSession(oldVoice.sessionId);
    const arriving=prior===lobbyId&&managedId(channelId)&&validSession(sessionId);
    if(!departing&&!arriving) return;
    const attempt=state.pendingMove(id,departing?oldVoice.sessionId:sessionId);
    if(!attempt) return;
    const exact=departing ? attempt.id===prior&&gatewayOwnerVoice(guild,oldVoice,attempt) :
      attempt.id===channelId&&gatewayOwnerVoice(guild,newVoice,attempt)&&gatewayOwnerVoice(guild,oldVoice,attempt,lobbyId);
    if(!exact) return;
    healthy(guild);
    // Synchronous exact CAS, independent of the room row and the expiring
    // guild queue. All Discord writes and cleanup still run under the lock.
    state.finishMove(attempt);
  }
  async function panel(guild,id,confirmedOwner) {
    if(state.get(id)?.panelReady!==false) return;
    try {
      const cached=occupied(guild,id);
      const confirmed=!cached&&confirmedOwner&&(await directVoice(guild,confirmedOwner))?.channel_id===id;
      if(!cached&&!confirmed) return;
      const [category,room]=await Promise.all([readChannel(guild,categoryId),readChannel(guild,id)]);
      if(!categoryScope(category)||!roomScope(room,id)||!sameOverwrites(overwrites(category),overwrites(room))||
        state.get(id)?.panelReady!==false||(!occupied(guild,id)&&!confirmed)) return;
      await postVoicePanel(guild,id);
      state.finishPanel(id);
    } catch {
      // Panel delivery has a separate exact-message recovery path; never roll back the room.
    }
  }
  async function nameRoom(guild,record,member) {
    const {id,ownerId,marker}=record;
    try {
      member??=await guild.client.rest.get(Routes.guildMember(guildId,ownerId));
      if(member?.user?.id!==ownerId||member.user.bot===true||member.user.system===true) return false;
      const name=[member.nick,member.user.global_name,member.user.username]
        .map(value=>typeof value==='string'?value.trim():'').find(value=>value&&value.length<=100);
      if(!name||name===marker) return false;
      // The exact marker is the only name lifecycle owns; never overwrite a custom name.
      const exact=await readChannel(guild,id);
      if(!roomScope(exact,id)||exact.name!==marker) return false;
      const current=state.get(id);
      if(current?.ownerId!==ownerId||current.marker!==marker||state.byWaiting(id)) return false;
      healthy(guild);
      const writer=getWriter();
      try {await writer.patch(Routes.channel(id),{body:{name}});}
      catch {/* Discord may have committed the rename before the error. */}
      const renamed=await readChannel(guild,id);
      return roomScope(renamed,id)&&renamed.name===name;
    } catch {
      // A naming failure must not reject the join or prevent panel delivery.
      return false;
    }
  }
  async function handoff(guild,record,session) {
    // Return whether to retain the bound room for this handoff. Unavailable proof is
    // not proof that the join was abandoned; reconciliation can check again.
    if(record.ownerId!==record.handoffOwnerId) return false;
    if(record.moveRetryAt!==null&&now()<record.moveRetryAt) return true;
    let access,limit;
    try {
      access=await eligibility(guild,record.ownerId);
      if(!access) return false;
      const [found,dest]=await Promise.all([source(guild),readChannel(guild,record.id)]);
      if(!found||!roomScope(dest,record.id)||!stillInLobby(guild,record.ownerId,session)) return false;
      const baseline=overwrites(found.category);
      // A permitted owner alone is not proof that the room enforces the category ceiling.
      if(!sameOverwrites(baseline,overwrites(dest))) return true;
      if(!access.allowed(baseline)) return false;
      limit=dest.user_limit;
      if(!Number.isInteger(limit)||limit<0||limit>99) return true;
      // Discord has no conditional member move. Check the source after the final
      // destination read; the check-to-write race at Discord cannot be eliminated.
      const voice=await directVoice(guild,record.ownerId);
      if(voice?.channel_id!==lobbyId||voice.session_id!==session) return false;
    } catch(err) {return !errorIs(err,RESTJSONErrorCodes.UnknownMember);}
    const writer=getWriter();
    const latest=state.get(record.id);
    // A moderator move can bypass a full voice room. Do not replay a handoff over
    // an active or ambiguous capacity lock, even if the latest raw limit has room.
    if(latest?.ownerId!==record.ownerId||latest.sessionId!==session||latest.marker!==record.marker||latest.privacy!=='open'||
      state.getCapacityLock(record.id)!==null) return true;
    if(!stillInLobby(guild,record.ownerId,session)) return false;
    if(limit>0&&guild.voiceStates.cache.filter(voice=>voice.channelId===record.id).size>=limit) return true;
    const attempt=state.beginMove(latest,now());
    if(!attempt) return true;
    try {await writer.patch(Routes.guildMember(guildId,record.ownerId),{body:{channel_id:record.id}});}
    catch(err) {
      // This catch covers only the exact member PATCH, using the no-retry writer.
      if(err instanceof RateLimitError) {
        const delay=Math.ceil(err.retryAfter);
        state.rejectMove(attempt,now()+(Number.isSafeInteger(delay)&&delay>0?delay:lobbyRetryMs));
        return true;
      }
      // Otherwise Discord may have committed the move before the error.
    }
    const moved=await directVoice(guild,record.ownerId).catch(()=>null);
    const exact=moved?.channel_id===record.id&&moved.session_id===session;
    if(exact) {
      healthy(guild);
      state.finishMove(attempt);
    } else if(!gatewayOwnerVoice(guild,guild.voiceStates.cache.get(record.ownerId),attempt)) return true;
    // Another gateway event may already have consumed the attempt. Name and
    // publish only when it is settled and the owner is still observed here.
    const current=state.get(record.id);
    if(!current?.opened||current.marker!==record.marker||current.ownerId!==record.ownerId) return true;
    await nameRoom(guild,record,access.member);
    await panel(guild,record.id,record.ownerId);
    return true;
  }
  async function joinLobby(guild,id,session) {
    const time=now();
    const prior=lobbyAttempts.get(id);
    if(time<createRetryAt||(prior?.session===session&&prior.retryAt>time)||!stillInLobby(guild,id,session)||state.byOwner(id)||
      state.hasUnsettledHandoff(id,session)) return;
    lobbyAttempts.set(id,{session,retryAt:time+lobbyRetryMs});
    const access=await eligibility(guild,id);
    if(!access) return;
    const marker='غرفة مؤقتة · '+randomBytes(16).toString('hex');
    const inventory=await readInventory(guild);
    if(inventory.some(channel=>channel.name===marker)) return;
    const found=await source(guild);
    if(!found) return;
    const acl=overwrites(found.category);
    if(!access.allowed(acl)) return;
    const fresh=await directVoice(guild,id);
    if(fresh?.channel_id!==lobbyId||fresh.session_id!==session||!stillInLobby(guild,id,session)) return;
    const writer=getWriter();
    if(!state.begin(id,marker,session,inventory.map(channel=>channel.id))) return;
    lobbyAttempts.delete(id); // The durable reservation now deduplicates attempts.
    let created;
    try {
      // Let Discord sync to the category at create time, not to our earlier access snapshot.
      created=await writer.post(Routes.guildChannels(guildId),{body:{name:marker,type:ChannelType.GuildVoice,parent_id:categoryId}});
    } catch(err) {
      // Only a structured rejection that proves Discord did not create the room releases ownership.
      // This writer never retries; Discord.js reports a 429 as RateLimitError, without status/code.
      if(err instanceof RateLimitError) {
        createRetryAt=now()+Math.max(lobbyRetryMs,Number.isFinite(err.retryAfter)?err.retryAfter:0);
        if(state.cancel(id,marker)) lobbyAttempts.set(id,{session,retryAt:createRetryAt});
      } else if((err?.status===403&&[50001,50013].includes(err.code))||
        (err?.status===400&&[30013,50035].includes(err.code))) {
        if(state.cancel(id,marker)) lobbyAttempts.set(id,{session,retryAt:now()+lobbyRetryMs});
      }
      return;
    }
    if(!managedId(created?.id)||(created.guild_id!==undefined&&created.guild_id!==guildId)||
      created.type!==ChannelType.GuildVoice||created.parent_id!==categoryId||created.name!==marker||
      inventory.some(channel=>channel.id===created.id)) return;
    let exact;
    try {exact=await readChannel(guild,created.id);}
    catch {return; /* Keep the reservation for exact-marker reconciliation. */}
    if(!roomScope(exact,created.id)||exact.name!==marker) return;
    healthy(guild);
    const record=state.bind(id,marker,created.id);
    if(record) await handoff(guild,record,session);
  }
  async function recoverCreate(guild,record,inventory) {
    const matches=inventory.filter(row=>row.name===record.marker);
    if(matches.length!==1) return;
    const [match]=matches;
    if(!managedId(match.id)||record.excludedIds.includes(match.id)||state.get(match.id)||state.byWaiting(match.id)) return;
    const fresh=await readChannel(guild,match.id);
    if(!roomScope(fresh,match.id)||fresh.name!==record.marker) return;
    healthy(guild);
    state.bind(record.ownerId,record.marker,match.id);
  }
  async function directlyOccupied(guild,roomId,ids) {
    const states=await Promise.all([...new Set(ids.filter(isId))].map(id=>directVoice(guild,id)));
    return states.find(voice=>voice?.channel_id===roomId)?.user_id;
  }
  async function deleteEmpty(guild,id) {
    // Discord has no conditional delete or room-roster REST endpoint. Check the complete
    // live gateway roster again synchronously just before the exact channel write.
    const writer=getWriter();
    if(occupied(guild,id)) return false;
    try {await writer.delete(Routes.channel(id));} catch {/* A timed-out DELETE may have committed. */}
    return (await readChannel(guild,id))===null;
  }
  async function cleanPair(guild,record,departed) {
    healthy(guild);
    const {id,waitingId,waitingMarker,ownerId}=record;
    if(waitingId!==null) {
      if(!managedId(waitingId)||waitingId===id||state.get(waitingId)||state.byWaiting(waitingId)?.id!==id) return;
      if(occupied(guild,waitingId)||await directlyOccupied(guild,waitingId,[ownerId,departed])) return;
      const category=await readChannel(guild,categoryId);
      const waiting=await readChannel(guild,waitingId);
      if(waiting!==null&&(!categoryScope(category)||!roomScope(waiting,waitingId)||!waitingMarker||
        waiting.name!==waitingMarker||!await deleteEmpty(guild,waitingId))) return;
      healthy(guild);
      state.update(id,{waitingId:null,waitingMarker:null});
    } else if(waitingMarker!==null) {
      // Without the controls' verified exact waiting ID, keep the marker; never guess by name.
      return;
    }
    state.remove(id);
  }
  async function forgetMissingWaiting(guild,record) {
    const {id,waitingId}=record;
    if(!managedId(waitingId)||state.byWaiting(waitingId)?.id!==id||await readChannel(guild,waitingId)!==null) return record;
    healthy(guild);
    return state.update(id,{waitingId:null,waitingMarker:null});
  }
  async function sweepRoom(guild,record,{departed,checkMissing=false,repairName=false}={}) {
    const {id,ownerId,opened,panelReady,handoffOwnerId}=record;
    if(!managedId(id)||state.byWaiting(id)) return;
    if(checkMissing) {
      if(await readChannel(guild,id)===null) await cleanPair(guild,record,departed);
      return;
    }
    // A crash or lost POST response can leave a bound room before the first move.
    // Only reconciliation resumes the original session, never a departure event.
    if(departed!==undefined&&!opened&&record.moveRetryAt!==null&&ownerId===record.handoffOwnerId&&
      stillInLobby(guild,ownerId,record.sessionId)) return;
    if(departed===undefined&&!opened&&record.moveAt===null&&stillInLobby(guild,ownerId,record.sessionId)&&
      await handoff(guild,record,record.sessionId)) return;
    const cached=occupied(guild,id);
    const pending=pendingMove(record);
    let present;
    if(pending) {
      if(gatewayOwnerVoice(guild,guild.voiceStates.cache.get(handoffOwnerId),record)) state.finishMove(record);
      else {
        // A guest is occupancy, not proof of handoff. Check the original owner
        // directly even with guests cached; a read failure cannot justify deletion.
        const voice=await directVoice(guild,handoffOwnerId).catch(err=>{if(!cached) throw err;});
        if(voice?.channel_id===id) {
          present=handoffOwnerId;
          healthy(guild);
          if(voice.session_id===record.sessionId) state.finishMove(record);
        }
      }
    }
    if(!cached&&!present) present=await directlyOccupied(guild,id,
      pending?[ownerId,departed].filter(user=>user!==handoffOwnerId):[ownerId,departed]);
    if(cached||present) {
      if(repairName) await nameRoom(guild,record);
      if(!panelReady) await panel(guild,id,present);
      return;
    }

    // An ambiguous first PATCH isn't replayed. Let its gateway/API updates settle before cleanup.
    const current=state.get(id);
    if(current&&pendingMove(current)&&now()-current.moveAt<moveGraceMs) return;
    const category=await readChannel(guild,categoryId);
    const exact=await readChannel(guild,id);
    if(exact!==null&&(!categoryScope(category)||!roomScope(exact,id)||!await deleteEmpty(guild,id))) return;
    await cleanPair(guild,record,departed);
  }
  function voiceState(oldState,newState) {
    const {guild,id,channelId,sessionId}=newState??{};
    const prior=oldState?.channelId;
    if(guild?.id!==guildId||!isId(id)||prior===channelId) return Promise.resolve();
    observeGatewayMove(oldState,newState);
    const joined=channelId===lobbyId&&validSession(sessionId)&&newState.member?.user?.bot!==true;
    const leaving=managedId(prior)?state.get(prior):null;
    if(!joined&&!leaving&&(!managedId(prior)||!state.byWaiting(prior))) return Promise.resolve();
    return exclusive(async()=>{
      healthy(guild);
      const left=state.get(prior);
      const pair=state.byWaiting(prior);
      if(left) await sweepRoom(guild,left,{departed:id});
      else if(pair) await sweepRoom(guild,pair,{departed:id,checkMissing:true});
      if(joined) await joinLobby(guild,id,sessionId);
    });
  }
  async function reconcileLobby(guild,trackedOwners) {
    const cache=healthy(guild).voiceStates.cache;
    for(const [id,prior] of lobbyAttempts) {
      const voice=cache.get(id);
      if(voice?.channelId!==lobbyId||voice.sessionId!==prior.session) lobbyAttempts.delete(id);
    }
    const time=now();
    if(time<createRetryAt) return;
    const candidates=[];
    // Voice states, unlike channel.members, include lobby occupants whose member isn't cached.
    for(const [id,voice] of cache) {
      if(voice.channelId!==lobbyId||voice.guild!==guild||voice.id!==id||!isId(id)||!validSession(voice.sessionId)||
        trackedOwners.has(id)) continue;
      const user=voice.member?.user;
      if(user?.bot===true||user?.system===true) continue;
      const retryAt=lobbyAttempts.get(id)?.retryAt ?? -Infinity;
      if(retryAt>time||state.hasUnsettledHandoff(id,voice.sessionId)) continue;
      // Keep only the next batch; never-attempted and longest-waiting go first.
      const before=candidates.findIndex(candidate=>retryAt<candidate.retryAt);
      const index=before<0?candidates.length:before;
      if(index>=lobbyBatch) continue;
      candidates.splice(index,0,{id,session:voice.sessionId,retryAt});
      if(candidates.length>lobbyBatch) candidates.pop();
    }
    const errors=[];
    for(const {id,session} of candidates) {
      if(now()<createRetryAt) break;
      healthy(guild);
      try {await joinLobby(guild,id,session);} catch(err) {errors.push(err);}
    }
    if(errors.length) throw new AggregateError(errors,'Temporary voice lobby reconciliation failed');
  }
  function reconcile() {
    return exclusive(async()=>{
      const guild=healthy();
      const pending=state.pending();
      const initial=state.list();
      if(pending.length||initial.length) {
        const inventory=await readInventory(guild);
        healthy(guild);
        for(const record of pending) await recoverCreate(guild,record,inventory);
        const byId=new Map(inventory.map(row=>[row.id,row]));
        for(let record of state.list()) {
          if(record.waitingId&&!byId.has(record.waitingId)) record=await forgetMissingWaiting(guild,record);
          if(record) await sweepRoom(guild,record,{checkMissing:!byId.has(record.id),
            repairName:byId.get(record.id)?.name===record.marker});
        }
      }
      // Never make a fresh reservation in the same tick that recovered or swept the owner's old one.
      await reconcileLobby(guild,new Set([...pending,...initial].map(record=>record.ownerId)));
    });
  }
  function channelDeleted(channel) {
    const id=channel?.id;
    if(channel?.guildId!==guildId||channel.type!==ChannelType.GuildVoice||!managedId(id)||
      (!state.get(id)&&!state.byWaiting(id))) return Promise.resolve();
    return exclusive(async()=>{
      const guild=healthy();
      if(await readChannel(guild,id)!==null) return; // Ignore stale or out-of-scope notifications.
      healthy(guild);
      const main=state.get(id);
      if(main) await cleanPair(guild,main);
      else {
        const pair=state.byWaiting(id);
        if(pair) {
          const next=state.update(pair.id,{waitingId:null,waitingMarker:null});
          if(next) await sweepRoom(guild,next,{checkMissing:true});
        }
      }
    });
  }
  return {voiceState,channelDeleted,reconcile,exclusive};
}

module.exports={createTempVoiceLifecycle};
