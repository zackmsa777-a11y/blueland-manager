'use strict';

const {createHash}=require('node:crypto');
const {ChannelType,DiscordAPIError,EmbedBuilder,MessagePayload,OverwriteType,PermissionFlagsBits:P,
  RESTJSONErrorCodes:E,Routes,escapeMarkdown}=require('discord.js');
const {catalog}=require('./ladder');

const GUILD='1573975432838127708';
const BOT=catalog.botId;
const DESTINATIONS=Object.freeze({
  staff:{parent:'1575528932357439549',reviewer:'1574013532586909736',title:'طلب الانضمام للإدارة'},
  transfer:{parent:'1575529519358419024',reviewer:'1574013532586909736',title:'طلب نقل الرتبة'},
  girls:{parent:'1575529605467476010',reviewer:'1575527044916183101',title:'طلب تقديم إدارة بنات'},
});
const ROOM_NAME='lxr-application';
const TOPIC_PREFIX='LXR application • ';
const CATEGORY_IDS=new Set(Object.values(DESTINATIONS).map(route=>route.parent));
const GIRLS_ACK='<:G_21:1574000061229305886> انتظري يا ملكة، طلبك وصل! مسؤولات البنات بيراجعونه ويعطونك خبر. <:G_25:1574000020783370370>';
const TRANSFER_PROMPT='أرسل صورتين هنا مباشرة في تذكرة نقل الرتبة حتى يراجعها الفريق يدويًا:\n'+
  '1. صورة تظهر رتبتك السابقة واسم مستخدمك في Discord.\n'+
  '2. صورة تظهر اسم السيرفر وعدد أعضائه.';
const PARTICIPANT=P.ViewChannel|P.SendMessages|P.ReadMessageHistory;
const BOT_ALLOW=PARTICIPANT|P.EmbedLinks|P.AttachFiles;
const SNOWFLAKE_MAX=0xffffffffffffffffn;
const snowflake=value=>typeof value==='string' && /^[1-9]\d{16,19}$/u.test(value) && BigInt(value)<=SNOWFLAKE_MAX;
const mask=value=>typeof value==='string' && /^(?:0|[1-9]\d{0,29})$/u.test(value);
const has=(permissions,needed)=>(permissions&needed)===needed;
const marker=id=>TOPIC_PREFIX+id;
const within=()=>({signal:AbortSignal.timeout(8_000)});
class ApplicationError extends Error {}
class RoomInventoryError extends ApplicationError {}
function fail(reason,safeToResubmit=false) {
  const error=new ApplicationError(`LXR application: ${reason}`);
  if (safeToResubmit) error.safeToResubmit=true;
  throw error;
}

function isApplicationDestination(channel) {
  const topic=channel?.topic;
  return CATEGORY_IDS.has(channel?.id) || CATEGORY_IDS.has(channel?.parentId) || CATEGORY_IDS.has(channel?.parent_id) ||
    (typeof topic==='string' && topic.startsWith(TOPIC_PREFIX) && snowflake(topic.slice(TOPIC_PREFIX.length)));
}

function clean(text,limit) {
  if (typeof text!=='string' || !text.trim() || text.length>limit) fail('invalid survey');
  const escaped=escapeMarkdown(text,{maskedLink:true})
    .replace(/<(?=[@#:]|a:)/gu,'<\u200b').replace(/@(?=everyone\b|here\b)/gu,'@\u200b');
  if (escaped.length>limit) fail('invalid survey');
  return escaped;
}

function survey(kind,id,answers) {
  if (!Array.isArray(answers) || !answers.length || answers.length>25) fail('invalid survey');
  const {title}=DESTINATIONS[kind];
  const fields=answers.map(answer=>({name:clean(answer?.name,256),value:clean(answer?.value,1024)}));
  if (fields.reduce((n,f)=>n+f.name.length+f.value.length,title.length+marker(id).length)>6000) fail('invalid survey');
  return new EmbedBuilder().setTitle(title).setColor(0x527cf5).setFields(fields).setFooter({text:marker(id)});
}

const overwrite=(id,type,allow,deny=0n)=>({id,type,allow:String(allow),deny:String(deny)});
function privateAcl(user,kind) {
  const applicantAllow=PARTICIPANT|(kind==='transfer'?P.AttachFiles:0n);
  return [overwrite(GUILD,OverwriteType.Role,0n,P.ViewChannel),overwrite(user,OverwriteType.Member,applicantAllow),
    overwrite(DESTINATIONS[kind].reviewer,OverwriteType.Role,PARTICIPANT),overwrite(BOT,OverwriteType.Member,BOT_ALLOW)];
}

function exactAcl(actual,expected) {
  return Array.isArray(actual) && actual.length===expected.length &&
    expected.every(({id,type,allow,deny})=>actual.filter(overwrite=>overwrite?.id===id &&
      overwrite.type===type && overwrite.allow===allow && overwrite.deny===deny).length===1);
}

async function liveRoute(rest,dest,user,acl) {
  const [parent,roles,bot,applicant]=await Promise.all([
    rest.get(Routes.channel(dest.parent),within()),rest.get(Routes.guildRoles(GUILD),within()),
    rest.get(Routes.guildMember(GUILD,BOT),within()),rest.get(Routes.guildMember(GUILD,user),within()),
  ]);
  if (parent?.id!==dest.parent || parent.guild_id!==GUILD || parent.type!==ChannelType.GuildCategory ||
      !Array.isArray(parent.permission_overwrites) || exactAcl(parent.permission_overwrites,acl)) fail('invalid destination');
  if (!Array.isArray(roles) || roles.some(role=>!snowflake(role?.id)) || new Set(roles.map(role=>role.id)).size!==roles.length)
    fail('invalid guild roles');
  const byId=new Map(roles.map(role=>[role.id,role]));
  const reviewer=byId.get(dest.reviewer);
  if (!reviewer || reviewer.managed!==false || typeof reviewer.mentionable!=='boolean' || !mask(reviewer.permissions))
    fail('invalid reviewer');
  if (bot?.user?.id!==BOT || bot.user.bot!==true || !Array.isArray(bot.roles) ||
      applicant?.user?.id!==user || applicant.user.bot || applicant.pending===true) fail('invalid guild membership');
  const assigned=[GUILD,...bot.roles].map(id=>byId.get(id));
  if (assigned.some(role=>!mask(role?.permissions))) fail('invalid bot roles');
  return {reviewer,roles:bot.roles,base:assigned.reduce((permissions,role)=>permissions|BigInt(role.permissions),0n)};
}

function checkBot({reviewer,roles,base},acl) {
  if (has(base,P.Administrator)) return;
  const apply=(permissions,{allow,deny})=>(permissions&~BigInt(deny))|BigInt(allow);
  const everyone=acl.find(item=>item.id===GUILD);
  let allow=0n,deny=0n;
  for (const item of acl) {
    if (item.type!==OverwriteType.Role || !roles.includes(item.id)) continue;
    allow|=BigInt(item.allow);
    deny|=BigInt(item.deny);
  }
  const perms=apply(apply(apply(base,everyone),{allow,deny}),acl.find(item=>item.id===BOT));
  if (!has(perms,BOT_ALLOW|(reviewer.mentionable?0n:P.MentionEveryone))) fail('bot permissions unavailable');
}

function checkRoom(room,id,dest,topic,acl) {
  if (!snowflake(id) || room?.id!==id || room.guild_id!==GUILD || room.type!==ChannelType.GuildText ||
      room.name!==ROOM_NAME || room.parent_id!==dest.parent || room.topic!==topic || !exactAcl(room.permission_overwrites,acl))
    fail('room privacy not verified');
}

async function locateRoom(rest,topic) {
  const invalid=()=>{throw new RoomInventoryError('LXR application: room inventory unavailable');};
  let rooms;
  try { rooms=await rest.get(Routes.guildChannels(GUILD),within()); }
  catch (error) {
    if (error instanceof SyntaxError) invalid(); // REST could not parse the inventory JSON.
    throw error;
  }
  if (!Array.isArray(rooms)) invalid();
  const seen=new Set();
  let match;
  for (const room of rooms) {
    if (!snowflake(room?.id) || !Number.isSafeInteger(room.type) || !ChannelType[room.type]?.startsWith('Guild') ||
        (room.guild_id!==undefined && room.guild_id!==GUILD) ||
        (room.topic!=null && typeof room.topic!=='string') || seen.has(room.id)) invalid();
    seen.add(room.id);
    if (room.topic!==topic) continue;
    if (match!==undefined) throw new RoomInventoryError('LXR application: ambiguous room marker');
    match=room.id;
  }
  return match;
}

function rejectedChannelCreate(error,firstStatus) {
  if (!(error instanceof DiscordAPIError) || error.status!==firstStatus || typeof error.rawError?.message!=='string')
    return false;
  return (firstStatus===403 && [E.MissingAccess,E.MissingPermissions].includes(error.code)) ||
    (firstStatus===400 && (error.code===E.InvalidFormBodyOrContentType ||
      (error.code===E.MaximumNumberOfGuildChannelsReached && error.rawError.code===error.code)));
}

function mentionContent(user,kind) {
  const note=kind==='transfer'?TRANSFER_PROMPT:kind==='girls'?GIRLS_ACK:'';
  return `<@${user}> <@&${DESTINATIONS[kind].reviewer}>${note?`\n${note}`:''}`;
}

function matchesEnvelope(message,channelId,{id,user,kind}) {
  const dest=DESTINATIONS[kind];
  return snowflake(message?.id) && message.channel_id===channelId && (message.nonce===undefined || message.nonce===id) &&
    (message.guild_id===undefined || message.guild_id===GUILD) && message.author?.id===BOT && message.author.bot!==false &&
    message.webhook_id===undefined && message.type===0 && Array.isArray(message.attachments) && message.attachments.length===0 &&
    message.content===mentionContent(user,kind) && message.mention_everyone===false && Array.isArray(message.mentions) &&
    message.mentions.length===1 && message.mentions[0]?.id===user &&
    Array.isArray(message.mention_roles) && message.mention_roles.length===1 &&
    message.mention_roles[0]===dest.reviewer && Array.isArray(message.embeds) && message.embeds.length===1 &&
    message.embeds[0]?.title===dest.title && message.embeds[0].footer?.text===marker(id);
}

function matchesMessage(message,channelId,expected,body) {
  return matchesEnvelope(message,channelId,expected) &&
    Array.isArray(message.embeds[0].fields) && message.embeds[0].fields.length===body.embeds[0].fields.length &&
    body.embeds[0].fields.every((field,i)=>message.embeds[0].fields[i]?.name===field.name &&
      message.embeds[0].fields[i]?.value===field.value);
}

function matchesStoredReceipt(message,channelId,request) {
  if (!matchesEnvelope(message,channelId,request)) return false;
  const {fields}=message.embeds[0];
  return Array.isArray(fields) && fields.length>=1 && fields.length<=25 && fields.every(field=>
    typeof field?.name==='string' && field.name.trim() && field.name.length<=256 &&
    typeof field.value==='string' && field.value.trim() && field.value.length<=1024);
}

async function verifyMessage(rest,channelId,id,matches) {
  if (!snowflake(id)) fail('message receipt not verified');
  const receipt=await rest.get(Routes.channelMessage(channelId,id),within());
  if (receipt?.id!==id || !matches(receipt)) fail('message receipt not verified');
}

async function recoverMessage(rest,channelId,id,matches) {
  const history=await rest.get(Routes.channelMessages(channelId),{...within(),query:new URLSearchParams({limit:'100'})});
  if (!Array.isArray(history)) fail('message receipt not verified');
  // Evidence posted later by the applicant is not part of the bot's delivery receipt.
  const marked=history.filter(message=>message?.author?.id===BOT && (message.nonce===id ||
    (Array.isArray(message.embeds) && message.embeds.some(embed=>embed?.footer?.text===marker(id)))));
  if (marked.length!==1 || !matches(marked[0])) fail('message receipt not verified');
  await verifyMessage(rest,channelId,marked[0].id,matches);
}

function requestKey(request) {
  const {id,userId:user,kind}=request??{};
  if (!snowflake(id) || !snowflake(user) || id===user || user===BOT || user===GUILD ||
      typeof kind!=='string' || !Object.hasOwn(DESTINATIONS,kind)) fail('invalid request');
  return {id,user,kind};
}

function rethrow(error,safeToResubmit=false) {
  if (error instanceof ApplicationError) {
    if (safeToResubmit) error.safeToResubmit=true;
    throw error;
  }
  // REST errors can include the request body; never pass it through to a caller or log.
  fail('delivery could not be verified',safeToResubmit);
}

function createApplicationTickets({readyGuild,getChannelWriteRest}) {
  const applicants=new Map(),inFlightIds=new Set();
  // Block retries after an unverified write even if the room isn't listed yet. Never evict uncertainty.
  const unconfirmedWrites=new Set();

  function connectedClient() {
    const guild=readyGuild();
    if (guild?.id!==GUILD || guild.client?.user?.id!==BOT) fail('invalid guild connection');
    return guild.client;
  }

  async function verifyRoom(rest,channelId,{id,user,kind},acl) {
    const dest=DESTINATIONS[kind],live=await liveRoute(rest,dest,user,acl);
    const checked=await rest.get(Routes.channel(channelId),within());
    checkRoom(checked,channelId,dest,marker(id),acl);
    checkBot(live,checked.permission_overwrites);
  }

  function prepareMessage(client,{id,user,kind},embed) {
    const content=mentionContent(user,kind);
    return MessagePayload.create({client},{content,embeds:[embed],nonce:id,enforceNonce:true,
      allowedMentions:{parse:[],users:[user],roles:[DESTINATIONS[kind].reviewer],repliedUser:false}}).resolveBody().body;
  }

  async function markerAbsent(id) {
    try {
      return (await locateRoom(connectedClient().rest,marker(id)))===undefined;
    } catch { return false; }
  }

  async function rejectPreflight(error,{id,user},eligible,{owned=false,absenceVerified=false}={}) {
    const clear=()=>!unconfirmedWrites.has(id) && (owned || (!applicants.has(user) && !inFlightIds.has(id)));
    // An unavailable read may be rechecked once; invalid or ambiguous inventory is not evidence of absence.
    rethrow(error,eligible && !(error instanceof RoomInventoryError) && clear() &&
      (absenceVerified || await markerAbsent(id)) && clear());
  }

  async function write(key,embed,recoverOnly,freshReservation) {
    const {id,user,kind}=key;
    const dest=DESTINATIONS[kind],topic=marker(id),acl=privateAcl(user,kind);
    const route=Routes.guildChannels(GUILD);
    const fresh=freshReservation && !recoverOnly;
    let rest,body,channelId,writer,signal,firstStatus,absenceVerified=false;
    // 429 is uncommitted and the SDK may queue it. No 5xx/reset replay is permitted.
    const observe=(request,response)=>{
      if (firstStatus===undefined && response.status!==429 && request.data?.signal===signal && request.path===route && request.method==='POST')
        firstStatus=request.retries===0?response.status:null;
    };
    try {
      const client=connectedClient();
      ({rest}=client);
      body=prepareMessage(client,key,embed);
      checkBot(await liveRoute(rest,dest,user,acl),acl);
      channelId=await locateRoom(rest,topic);
      if (channelId===undefined) {
        if (recoverOnly) fail('room not found');
        absenceVerified=true;
        if (unconfirmedWrites.has(id)) fail('previous write could not be verified');
        if (unconfirmedWrites.size>=1024) fail('delivery temporarily unavailable');
        writer=getChannelWriteRest?.();
        if (writer?.options?.retries!==0 || typeof writer.post!=='function') fail('channel writer unavailable');
        ({signal}=within());
        writer.on?.('response',observe);
      }
    } catch (error) {
      return rejectPreflight(error,key,fresh,{owned:true,absenceVerified});
    }
    const existing=channelId!==undefined;
    let ambiguousCreate=false;
    if (!existing) {
      let created;
      unconfirmedWrites.add(id);
      try {
        created=await writer.post(route,{signal,body:{name:ROOM_NAME,type:ChannelType.GuildText,
          parent_id:dest.parent,topic,permission_overwrites:acl}});
      } catch (error) {
        if (rejectedChannelCreate(error,firstStatus)) {
          unconfirmedWrites.delete(id);
          fail('channel creation rejected',true);
        }
        ambiguousCreate=true;
      } finally {
        writer.off?.('response',observe);
      }
      if (ambiguousCreate) {
        // The POST may have committed. Reconcile once by exact marker; never issue another create.
        channelId=await locateRoom(rest,topic);
        if (channelId===undefined) fail('delivery could not be verified');
      } else {
        channelId=created?.id;
        checkRoom(created,channelId,dest,topic,acl);
        if (await locateRoom(rest,topic)!==channelId) fail('room privacy not verified');
      }
    }

    await verifyRoom(rest,channelId,key,acl);
    if (ambiguousCreate) {
      // Only this fresh invocation knows it never attempted a message. History drift fails closed.
      if (!fresh) fail('delivery could not be verified');
      const history=await rest.get(Routes.channelMessages(channelId),{...within(),query:new URLSearchParams({limit:'1'})});
      if (!Array.isArray(history) || history.length!==0) fail('delivery could not be verified');
    }
    const matches=message=>matchesMessage(message,channelId,key,body);
    if (existing) {
      // An existing room is proof of neither an untouched submission nor a successful write.
      // It is only safe to recover an exact existing receipt, never to issue another ping.
      await recoverMessage(rest,channelId,id,matches);
    } else {
      const posted=await rest.post(Routes.channelMessages(channelId),{...within(),body});
      if (!matches(posted)) fail('message receipt not verified');
      await verifyMessage(rest,channelId,posted.id,matches);
    }
    unconfirmedWrites.delete(id);
    return channelId;
  }


  async function deliverApplication(request) {
    let key,recoverOnly,freshReservation,validating=false;
    try {
      key=requestKey(request);
      const {id,user,kind}=key,{answers}=request;
      recoverOnly='recoverOnly' in Object(request)?request.recoverOnly:false;
      freshReservation='freshReservation' in Object(request)?request.freshReservation:false;
      if (typeof recoverOnly!=='boolean' || typeof freshReservation!=='boolean') fail('invalid request');
      validating=true;
      const embed=survey(kind,id,answers);
      const fingerprint=createHash('sha256').update(JSON.stringify([id,kind,embed.toJSON(),recoverOnly,freshReservation])).digest('hex');
      validating=false;
      const active=applicants.get(user);
      if (active) {
        if (active.fingerprint===fingerprint) return await active.pending;
        fail('applicant already submitting');
      }
      if (inFlightIds.has(id)) fail('request already in flight');
      const pending=Promise.resolve().then(()=>write(key,embed,recoverOnly,freshReservation)).finally(()=>{
        applicants.delete(user);
        inFlightIds.delete(id);
      });
      applicants.set(user,{fingerprint,pending});
      inFlightIds.add(id);
      return await pending;
    } catch (error) {
      // Don't clear an earlier delivery just because this request's input is invalid.
      if (key) return rejectPreflight(error,key,freshReservation && validating && !recoverOnly);
      rethrow(error);
    }
  }

  deliverApplication.recover=async function recover(request) {
    try {
      const key=requestKey(request),{id,user,kind}=key;
      if (applicants.has(user) || inFlightIds.has(id)) fail('request already in flight');
      const {rest}=connectedClient(),acl=privateAcl(user,kind);
      const channelId=await locateRoom(rest,marker(id));
      if (channelId===undefined) fail('room not found');
      await verifyRoom(rest,channelId,key,acl);
      await recoverMessage(rest,channelId,id,message=>matchesStoredReceipt(message,channelId,key));
      unconfirmedWrites.delete(id);
      return channelId;
    } catch (error) {
      rethrow(error);
    }
  };
  return deliverApplication;
}

module.exports={createApplicationTickets,isApplicationDestination};
