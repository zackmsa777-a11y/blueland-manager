'use strict';

const {isDeepStrictEqual}=require('node:util');
const {ChannelType,Events,GatewayDispatchEvents:Dispatch,MessageType,OverwriteType,PermissionFlagsBits:P,Routes}=require('discord.js');
const {catalog,compareRoles}=require('./ladder');
const {f7sCommand,isF7s}=require('./commands');
const {loadF7sAvatar,renderF7s}=require('./lxr-f7s-card');

const G=catalog.guildId, B='1573988210185347223';
const FLOOR='1574012924916142140';
const STAFF=new Set(['1574013523833651220','1574013516375916605','1574013527050424410','1574013513549086731']);
const NO_MENTIONS={parse:[],users:[],roles:[],replied_user:false};
const REPLY_BITS=P.ViewChannel|P.ReadMessageHistory|P.AttachFiles;
const FILE='member-activity.png';
const NOT_MEMBER='**ما لقيت عضوًا بهذا المعرّف في السيرفر.**';
const MAX_U64=0xffffffffffffffffn;
const snowflake=id=>typeof id==='string' && /^[1-9][0-9]{16,19}$/u.test(id) && BigInt(id)<=MAX_U64;
const bits=value=>typeof value==='string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value)<=MAX_U64;
const sameGuild=member=>member?.guild_id===undefined || member.guild_id===G;
const human=(member,id)=>member?.user?.id===id && sameGuild(member) && (member.user.bot===undefined || member.user.bot===false) &&
  (member.pending===undefined || member.pending===false);
const assigned=(ids,roles)=>Array.isArray(ids) && ids.every(id=>id!==G && roles.has(id)) && new Set(ids).size===ids.length;
const threads=new Map([
  [ChannelType.AnnouncementThread,[ChannelType.GuildAnnouncement]],
  [ChannelType.PublicThread,[ChannelType.GuildText,ChannelType.GuildForum,ChannelType.GuildMedia]],
  [ChannelType.PrivateThread,[ChannelType.GuildText]]
]);
function parseF7s(text) {
  const match=/^\+f7s[ \t]+(?:<@!?([0-9]+)>|([0-9]+))$/u.exec(text);
  const id=match?.[1]??match?.[2];
  return snowflake(id)?id:null;
}
function roleInventory(raw) {
  if (!Array.isArray(raw)) return null;
  const roles=new Map();
  for (const role of raw) {
    if (!snowflake(role?.id) || roles.has(role.id) || !Number.isSafeInteger(role.position) || role.position<0 || !bits(role.permissions)) return null;
    roles.set(role.id,role);
  }
  return roles.has(G)?roles:null;
}
function roleState(roles) {
  // Compare only the fields used for hierarchy, membership and bot permissions.
  return roles && JSON.stringify([...roles.keys()].sort().map(id=>{
    const {position,permissions}=roles.get(id);
    return [id,position,permissions];
  }));
}
function cachedRoleState(guild) {
  const cache=guild?.roles?.cache;
  if (!(cache instanceof Map)) return null;
  return roleState(roleInventory(Array.from(cache.values(),role=>({
    id:role?.id,position:role?.rawPosition,
    permissions:typeof role?.permissions?.bitfield==='bigint'?String(role.permissions.bitfield):null
  }))));
}
function authorized(member,actor,roles) {
  if (!roles || !human(member,actor) || !assigned(member.roles,roles)) return false;
  const floor=roles.get(FLOOR);
  return member.roles.some(id=>STAFF.has(id) || (floor && compareRoles(roles.get(id),floor)<=0));
}
function botPermissions(bot,scope,roles) {
  if (!roles || bot?.user?.id!==B || !sameGuild(bot) || bot.user.bot!==true || !assigned(bot.roles,roles) || !Array.isArray(scope.acl)) return 0n;
  let permission=[G,...bot.roles].reduce((value,id)=>value|BigInt(roles.get(id).permissions),0n);
  if (permission&P.Administrator) return permission;
  const allow=[0n,0n,0n], deny=[0n,0n,0n];
  for (const o of scope.acl) {
    if (!snowflake(o?.id) || !bits(o.allow) || !bits(o.deny) || ![OverwriteType.Role,OverwriteType.Member].includes(o.type)) return 0n;
    const layer=o.type===OverwriteType.Role ? (o.id===G?0:bot.roles.includes(o.id)?1:-1) : o.id===B?2:-1;
    if (layer<0) continue;
    allow[layer]|=BigInt(o.allow);
    deny[layer]|=BigInt(o.deny);
  }
  for (let i=0;i<3;i++) permission=(permission&~deny[i])|allow[i];
  return permission;
}
function discordTimestamp(value) {
  const date=typeof value==='string' && /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!date) return NaN;
  const [,year,month,day]=date;
  if (new Date(Date.UTC(+year,+month-1,+day)).toISOString().slice(0,10)!==date[0].slice(0,10)) return NaN;
  return Date.parse(value);
}
function identity(target,id,now) {
  if (!human(target,id)) return null;
  const created=Number(BigInt(id)>>22n)+1420070400000;
  const joined=discordTimestamp(target.joined_at);
  if (!Number.isFinite(joined) || joined<created || joined>now) return null;
  const date=value=>new Date(value).toISOString().slice(0,10);
  const name=[target.nick,target.user.global_name,target.user.username].find(value=>typeof value==='string' && value.trim());
  return {id,name,created:date(created),joined:date(joined),guildAvatar:target.avatar,userAvatar:target.user.avatar};
}

function createF7s({client,rest,createWriter,readyGuild,botId,assertGenericScope,isTicketRoom,db}) {
  const lifetime=new AbortController();
  const active=new Set(), attempted=new Map();
  const guards=new Set(), listeners=[];
  const invalidate=(matches=()=>true)=>{
    for (const guard of guards) if (matches(guard)) guard.cancel.abort();
  };
  function roomChanged(id) {
    for (const guard of guards) {
      if (guard.rooms.has(id)) guard.cancel.abort();
      else if (guard.discovering && !guard.cancel.signal.aborted) {
        // The changed room may turn out to be an ancestor of a GET still in flight.
        guard.discovering.add(id);
        if (guard.discovering.size>64) guard.cancel.abort();
      }
    }
  }
  const memberChanged=id=>invalidate(guard=>id===B || id===guard.actor);
  const shardChanged=id=>invalidate(guard=>guard.shard===id || guard.shard==null);
  function guildRolesObserved(state) {
    for (const guard of guards) {
      if (!state || state!==guard.cachedRoles || (guard.restRoles!==undefined && state!==guard.restRoles)) guard.cancel.abort();
      else guard.observedRoles=state;
    }
  }
  function raw({t,d}) {
    if ([Dispatch.GuildCreate,Dispatch.GuildDelete].includes(t)) {
      if (d?.id===G) invalidate();
      return;
    }
    if (t===Dispatch.GuildUpdate) {
      if (d?.id===G && guards.size) guildRolesObserved(roleState(roleInventory(d.roles)));
      return;
    }
    if (d?.guild_id!==G) return;
    switch (t) {
      case Dispatch.GuildRoleCreate: case Dispatch.GuildRoleUpdate: case Dispatch.GuildRoleDelete:
        invalidate(); break;
      case Dispatch.GuildMemberAdd: case Dispatch.GuildMemberUpdate: case Dispatch.GuildMemberRemove:
        memberChanged(d.user?.id); break;
      case Dispatch.ChannelCreate: case Dispatch.ChannelUpdate: case Dispatch.ChannelDelete:
      case Dispatch.ThreadCreate: case Dispatch.ThreadUpdate: case Dispatch.ThreadDelete: case Dispatch.ThreadMembersUpdate:
        roomChanged(d.id); break;
      case Dispatch.ThreadMemberUpdate:
        if (d.user_id==null || d.user_id===B) roomChanged(d.id);
        break;
      case Dispatch.ThreadListSync:
        if (Array.isArray(d.channel_ids)) for (const id of d.channel_ids) roomChanged(id);
        else invalidate();
        break;
    }
  }
  function listen(event,listener) {
    client.on(event,listener);
    listeners.push([event,listener]);
  }
  // Raw dispatches can precede (or never produce) SDK cache events. SDK actions can
  // also emit scoped changes locally; both paths are idempotent for a pending guard.
  listen(Events.Raw,raw);
  const roomEvent=(...args)=>{const room=args.at(-1);if (room?.guildId===G) roomChanged(room.id);};
  for (const event of [Events.ChannelCreate,Events.ChannelUpdate,Events.ChannelDelete,Events.ThreadUpdate,Events.ThreadDelete]) listen(event,roomEvent);
  listen(Events.ThreadCreate,room=>roomEvent(room));
  const roleEvent=(...args)=>{if (args.at(-1)?.guild?.id===G) invalidate();};
  for (const event of [Events.GuildRoleCreate,Events.GuildRoleUpdate,Events.GuildRoleDelete]) listen(event,roleEvent);
  listen(Events.GuildUpdate,(before,after)=>{
    if (guards.size && (before?.id===G || after?.id===G)) {
      // The SDK's shallow oldGuild clone shares the cache manager with newGuild.
      guildRolesObserved(before?.id===G && after?.id===G ? cachedRoleState(after) : null);
    }
  });
  const memberEvent=(...args)=>{const member=args.at(-1);if (member?.guild?.id===G) memberChanged(member.id);};
  for (const event of [Events.GuildMemberAdd,Events.GuildMemberUpdate,Events.GuildMemberRemove]) listen(event,memberEvent);
  for (const event of [Events.GuildAvailable,Events.GuildDelete,Events.GuildUnavailable]) listen(event,guild=>{if (guild.id===G) invalidate();});
  listen(Events.ShardDisconnect,(_,id)=>shardChanged(id));
  listen(Events.ShardReconnecting,shardChanged);
  listen(Events.ShardResume,shardChanged);

  const openGuild=()=>{
    if (botId!==B || lifetime.signal.aborted) return null;
    const guild=readyGuild();
    return guild.id===G?guild:null;
  };
  const opts=(deadline,...signals)=>{
    const signal=AbortSignal.any([lifetime.signal,deadline,AbortSignal.timeout(5_000),...signals]);
    signal.throwIfAborted();
    return {signal};
  };
  const get=(path,deadline)=>rest.get(path,opts(deadline));
  function roomState(id) {
    // Some SDK actions patch a cached room without emitting a client event. Cache
    // drift can veto this pass; only the fresh REST response can authorize it.
    const room=client.channels.cache.get(id);
    return room && [room.guildId,room.type,room.name,room.topic,room.parentId,room.archived,room.locked,
      room.permissionOverwrites?.cache.map(o=>[o.id,o.type,o.allow.bitfield,o.deny.bitfield])];
  }
  async function roomScope(channel,deadline,guard) {
    const checked=new Map();
    await assertGenericScope(channel,async id=>{
      if (!snowflake(id) || isTicketRoom(id) || checked.has(id)) return null;
      if (!guard.rooms.has(id)) guard.rooms.set(id,roomState(id));
      if (guard.discovering.has(id)) guard.cancel.abort();
      guard.cancel.signal.throwIfAborted();
      const room=await get(Routes.channel(id),deadline);
      if (room?.id!==id || room.guild_id!==G) return null;
      if (room.type===ChannelType.GuildCategory ? typeof room.name!=='string' :
        !(room.parent_id===null || snowflake(room.parent_id))) return null;
      checked.set(id,room);
      return room;
    });
    const room=checked.get(channel), types=threads.get(room?.type);
    if (!types && ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(room?.type)) return null;
    const base=types?checked.get(room.parent_id):room;
    if (types && (!types.includes(base?.type) || room.thread_metadata?.archived!==false)) return null;
    if (base.parent_id!==null && checked.get(base.parent_id)?.type!==ChannelType.GuildCategory) return null;
    return {acl:base.permission_overwrites,private:room.type===ChannelType.PrivateThread,
      send:types?P.SendMessagesInThreads:P.SendMessages};
  }
  async function checkRoom(actor,channel,deadline,use=roles=>roles) {
    const guild=openGuild();
    if (!guild) return null;
    const guard={actor,shard:guild.shardId,rooms:new Map([[channel,roomState(channel)]]),discovering:new Set(),
      cachedRoles:cachedRoleState(guild),restRoles:undefined,observedRoles:undefined,cancel:new AbortController()};
    const signal=guard.cancel.signal;
    const current=()=>!signal.aborted && !deadline.aborted && openGuild()===guild && [...guard.rooms]
      .every(([id,prior])=>!isTicketRoom(id) && isDeepStrictEqual(roomState(id),prior));
    guards.add(guard);
    try {
      const scope=await roomScope(channel,deadline,guard);
      guard.discovering=null;
      if (!scope || !current()) return null;
      const [rawRoles,bot]=await Promise.all([get(Routes.guildRoles(G),deadline),get(Routes.guildMember(G,B),deadline)]);
      const roles=roleInventory(rawRoles);
      guard.restRoles=roleState(roles);
      // An early event that agreed with the cache must still agree with REST.
      // Neither the observed inventory nor the cache can supply authorization.
      if (guard.observedRoles!==undefined && guard.observedRoles!==guard.restRoles) {
        guard.cancel.abort();
        return null;
      }
      const permission=botPermissions(bot,scope,roles);
      if (!(permission&P.Administrator)) {
        const required=REPLY_BITS|scope.send;
        if ((permission&required)!==required) return null;
        if (bot.communication_disabled_until!=null && !(discordTimestamp(bot.communication_disabled_until)<=Date.now())) return null;
        if (scope.private && !(permission&P.ManageThreads)) {
          const membership=await get(Routes.threadMembers(channel,B),deadline);
          if (membership?.id!==channel || membership.user_id!==B) return null;
        }
      }
      if (!current()) return null;
      // Keep the fresh requester read last; it cannot refresh earlier observations.
      const requester=await get(Routes.guildMember(G,actor),deadline);
      if (!authorized(requester,actor,roles) || !current()) return null;
      return await use(roles,current,signal);
    } finally { guards.delete(guard); }
  }
  async function text(message,text) {
    if (!isF7s(text)) return;
    const actor=message.author?.id, channel=message.channelId, source=message.id;
    if (message.guildId!==G || message.client.user?.id!==B || message.author?.bot || message.webhookId ||
        ![MessageType.Default,MessageType.Reply].includes(message.type) || ![actor,channel,source].every(snowflake) ||
        active.has(actor) || active.size>=3) return;
    active.add(actor);
    const deadline=AbortSignal.timeout(25_000);
    try {
      const time=Date.now();
      for (const [id,ts] of attempted) if (time-ts>=300_000) attempted.delete(id);
      if (attempted.has(source)) return;
      const first=await checkRoom(actor,channel,deadline);
      if (!first) return;
      const targetId=parseF7s(text);
      let body={content:f7sCommand.usage}, files;
      if (targetId) {
        body={content:NOT_MEMBER};
        if (!first.has(targetId)) {
          let target;
          try { target=await get(Routes.guildMember(G,targetId),deadline); }
          catch (err) { if (![10007,10013].includes(err.code)) return; }
          const profile=identity(target,targetId,Date.now());
          if (profile) {
            if (!await checkRoom(actor,channel,deadline)) return;
            const activity=db.memberActivity(targetId,Date.now());
            const avatar=await loadF7sAvatar(profile,opts(deadline).signal);
            const image=renderF7s(profile,activity,avatar);
            files=[{data:image,name:FILE,contentType:'image/png'}];
            body={attachments:[{id:0,filename:FILE,description:'نشاط العضو المسجّل في السيرفر · UTC'}]};
          }
        }
      }
      await checkRoom(actor,channel,deadline,async (_,current,signal)=>{
        if (attempted.has(source)) return;
        if (attempted.size>=256) attempted.delete(attempted.keys().next().value);
        attempted.set(source,Date.now());
        // A dedicated one-shot writer cannot queue behind another Reply. The SDK still
        // yields before makeRequest; recheck there and keep cancellation on the adapter.
        const writer=createWriter(), makeRequest=writer.options.makeRequest;
        writer.options.makeRequest=function(url,options) {
          options.signal.throwIfAborted();
          if (!current()) throw Error('Activity Reply authorization is no longer current');
          return makeRequest.call(this,url,options);
        };
        // Discord cannot condition a Reply on this authorization snapshot. An update
        // after dispatch can race the server commit; an abort/error is not proof of
        // non-delivery. Never retry or fall back, or claim delivery was confirmed.
        await writer.post(Routes.channelMessages(channel),{...opts(deadline,signal),files,
          body:{...body,allowed_mentions:NO_MENTIONS,nonce:source,enforce_nonce:true,
            message_reference:{message_id:source,channel_id:channel,guild_id:G,fail_if_not_exists:true}}});
      });
    } catch {} finally { active.delete(actor); }
  }
  async function help(message,output) {
    const actor=message.author?.id, channel=message.channelId;
    const extended=`${output}\n${f7sCommand.help}`;
    if (message.guildId!==G || message.client.user?.id!==B || !snowflake(actor) || !snowflake(channel) ||
        typeof output!=='string' || extended.length>2000 || active.has(actor) || active.size>=3) return output;
    active.add(actor);
    try { if (await checkRoom(actor,channel,AbortSignal.timeout(5_000))) return extended; }
    catch {} finally { active.delete(actor); }
    return output;
  }
  return {text,help,close(){
    lifetime.abort();
    for (const [event,listener] of listeners.splice(0)) client.off(event,listener);
  }};
}

module.exports={createF7s,parseF7s};
