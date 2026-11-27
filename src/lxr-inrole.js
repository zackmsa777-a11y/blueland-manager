'use strict';

const {randomBytes}=require('node:crypto');
const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,EmbedBuilder,MessageType,OverwriteType,PermissionFlagsBits,Routes}=require('discord.js');
const {catalog}=require('./ladder');
const {inRoleCommand,isInRole}=require('./commands');

const G=catalog.guildId;
const PAGE=20, API_PAGE=1_000, MAX_MEMBERS=200_000, MAX_SCANS=3, MAX_SESSIONS=12, SESSION_MS=5*60_000;
const NO_MENTIONS={parse:[],users:[],roles:[],replied_user:false};
const UNAVAILABLE='تعذّر تأكيد قائمة أعضاء الرول. جرّب مرة ثانية.';
const roomTypes=[ChannelType.GuildText,ChannelType.GuildAnnouncement];
const threadParents=new Map([
  [ChannelType.AnnouncementThread,[ChannelType.GuildAnnouncement]],
  [ChannelType.PublicThread,[ChannelType.GuildText,ChannelType.GuildForum,ChannelType.GuildMedia]],
  [ChannelType.PrivateThread,[ChannelType.GuildText]]
]);
const replyPermissions=PermissionFlagsBits.ViewChannel|PermissionFlagsBits.ReadMessageHistory|PermissionFlagsBits.EmbedLinks;
const snowflake=id=>typeof id==='string' && /^[1-9][0-9]{16,19}$/u.test(id) && BigInt(id)<=0xffffffffffffffffn;
const permissionBits=bits=>typeof bits==='string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(bits) && BigInt(bits)<=0xffffffffffffffffn;
const roleIdOf=text=>{
  const token=/^\+inrole[ \t]+(\S+)$/u.exec(text)?.[1];
  if (!token) return null;
  const id=/^<@&([0-9]+)>$/u.exec(token)?.[1] ?? token;
  return snowflake(id)?id:null;
};
const assigned=roles=>Array.isArray(roles) && roles.every(snowflake) && new Set(roles).size===roles.length;
const validDm=(raw,id,actor)=>raw?.id===id && snowflake(id) && raw.type===ChannelType.DM && raw.guild_id==null &&
  Array.isArray(raw.recipients) && raw.recipients.length===1 && raw.recipients[0]?.id===actor;
const pages=session=>Math.max(1,Math.ceil(session.ids.length/PAGE));
const buttonId=(session,revision,direction)=>`lxr-inrole:${session.key}:${revision}:${direction}`;

function render(session,name,page=0,revision=0) {
  const rows=session.ids.slice(page*PAGE,(page+1)*PAGE).map(id=>`<@${id}> — \`${id}\``);
  const embed=new EmbedBuilder().setTitle(`${name} (${session.ids.length})`)
    .setDescription(rows.join('\n') || 'لا يوجد أعضاء بهذا الرول.').setFooter({text:`${page+1} / ${pages(session)}`});
  const button=(direction,emoji,disabled)=>new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji(emoji)
    .setCustomId(buttonId(session,revision,direction)).setDisabled(disabled);
  return {embeds:[embed.toJSON()],components:[new ActionRowBuilder().addComponents(
    button('l','⬅️',page===0),button('r','➡️',page===pages(session)-1)).toJSON()],allowed_mentions:NO_MENTIONS};
}

function createInRole({rest,readyGuild,botId,assertGenericScope,isTicketRoom}) {
  const sessions=new Map(), active=new Set();
  const lifetime=new AbortController();
  const closed=()=>lifetime.signal.aborted;
  const open=()=>!closed() && readyGuild().id===G;
  const opts=deadline=>{
    const signal=AbortSignal.any([lifetime.signal,deadline,AbortSignal.timeout(5_000)]);
    signal.throwIfAborted();
    return {signal};
  };
  const get=(route,deadline,query)=>rest.get(route,{...opts(deadline),query});
  const post=(route,deadline,body)=>rest.post(route,{...opts(deadline),body});
  const sameReply=(raw,{channel,source})=>raw?.channel_id===channel && (raw.guild_id==null || raw.guild_id===G) &&
    raw.author?.id===botId && raw.type===MessageType.Reply && raw.message_reference?.message_id===source &&
    (raw.message_reference.channel_id==null || raw.message_reference.channel_id===channel) &&
    (raw.message_reference.guild_id==null || raw.message_reference.guild_id===G);
  function forget(actor) {
    clearTimeout(sessions.get(actor)?.timer);
    sessions.delete(actor);
  }
  async function roomScope(channel,deadline) {
    const checked=new Map();
    await assertGenericScope(channel,async id=>{
      if (!snowflake(id) || isTicketRoom(id)) return null;
      const raw=await get(Routes.channel(id),deadline);
      if (raw?.id!==id || raw.guild_id!==G) return null;
      checked.set(id,raw);
      return raw;
    });
    const ids=[...checked.keys()];
    if (ids.some(isTicketRoom)) return null;
    const room=checked.get(channel), thread=threadParents.get(room?.type);
    if (thread) {
      const parent=checked.get(room.parent_id);
      if (!thread.includes(parent?.type) || room.thread_metadata?.archived!==false) return null;
      return {ids,acl:parent.permission_overwrites,send:PermissionFlagsBits.SendMessagesInThreads};
    }
    return roomTypes.includes(room?.type)?{ids,acl:room.permission_overwrites,send:PermissionFlagsBits.SendMessages}:null;
  }
  const readBot=deadline=>get(Routes.guildMember(G,botId),deadline);
  function botCanReply(scope,inventory,bot) {
    if (!Array.isArray(scope?.acl) || bot?.user?.id!==botId || bot.user.bot!==true || !assigned(bot.roles)) return false;
    let bits=0n;
    for (const id of [G,...bot.roles]) {
      const role=inventory.get(id);
      if (!role) return false;
      bits|=BigInt(role.permissions);
    }
    if (bits&PermissionFlagsBits.Administrator) return true;
    // Discord resolves @everyone, combined role overwrites, then the member overwrite.
    const allow=[0n,0n,0n], deny=[0n,0n,0n];
    for (const o of scope.acl) {
      const layer=o?.type===OverwriteType.Role ? (o.id===G?0:bot.roles.includes(o.id)?1:-1) :
        o?.type===OverwriteType.Member && o.id===botId ? 2 : -1;
      if (layer<0) continue;
      if (!permissionBits(o.allow) || !permissionBits(o.deny)) return false;
      allow[layer]|=BigInt(o.allow);
      deny[layer]|=BigInt(o.deny);
    }
    for (let layer=0;layer<allow.length;layer++) bits=(bits&~deny[layer])|allow[layer];
    const required=replyPermissions|scope.send;
    return (bits&required)===required;
  }
  async function authorizedRoom(actor,channel,deadline) {
    const bot=await readBot(deadline);
    const scope=await roomScope(channel,deadline);
    if (!scope) return null;
    // A room lookup can take time. Check the requester afterward, then recheck local ticket records.
    const inventory=await authorized(actor,deadline);
    return inventory && botCanReply(scope,inventory,bot) && !scope.ids.some(isTicketRoom) ? inventory : null;
  }
  async function authorized(actor,deadline) {
    if (!snowflake(actor) || !open()) return null;
    const [guild,member,roles]=await Promise.all([
      get(Routes.guild(G),deadline),get(Routes.guildMember(G,actor),deadline),get(Routes.guildRoles(G),deadline)
    ]);
    if (!open() || deadline.aborted || guild?.id!==G || !snowflake(guild.owner_id) || member?.user?.id!==actor ||
        (member.user.bot!==undefined && member.user.bot!==false) || (member.pending!==undefined && member.pending!==false) ||
        !assigned(member.roles) || !Array.isArray(roles)) return null;
    const inventory=new Map();
    for (const role of roles) {
      if (!snowflake(role?.id) || inventory.has(role.id) || !permissionBits(role.permissions) ||
          typeof role.name!=='string' || !role.name.length || role.name.length>200) return null;
      inventory.set(role.id,role);
    }
    let bits=0n;
    for (const id of [G,...member.roles]) {
      const role=inventory.get(id);
      if (!role) return null;
      bits|=BigInt(role.permissions);
    }
    return actor===guild.owner_id || Boolean(bits&(PermissionFlagsBits.Administrator|PermissionFlagsBits.ManageRoles)) ? inventory : null;
  }
  async function collect(roleId,actor,deadline) {
    const ids=[];
    let after=0n,count=0,seenActor=false;
    while (true) {
      const query=new URLSearchParams({limit:String(API_PAGE),...(after?{after:String(after)}:{})});
      const rows=await get(Routes.guildMembers(G),deadline,query);
      if (!Array.isArray(rows) || rows.length>API_PAGE || count+rows.length>MAX_MEMBERS || deadline.aborted)
        throw Error('Unverifiable member page');
      // Require an explicit terminal page, even when Discord returns a short batch.
      if (!rows.length) {
        if (!seenActor) throw Error('Requester missing from member enumeration');
        return ids;
      }
      for (const row of rows) {
        const id=row?.user?.id;
        if (!snowflake(id) || BigInt(id)<=after || !assigned(row.roles)) throw Error('Unverifiable member row');
        after=BigInt(id);
        if (id===actor) seenActor=true;
        if (roleId===G || row.roles.includes(roleId)) ids.push(id);
      }
      count+=rows.length;
      const inventory=await authorized(actor,deadline);
      if (!inventory) return null;
      if (!inventory.has(roleId)) throw Error('Role no longer exists');
    }
  }
  async function text(message,text) {
    if (!isInRole(text)) return false;
    const actor=message.author.id, channel=message.channelId, source=message.id;
    if (message.guildId!==G || !snowflake(channel) || !snowflake(source) || message.client.user?.id!==botId ||
        active.has(actor) || active.size>=MAX_SCANS || closed()) return true;
    active.add(actor);
    const deadline=AbortSignal.timeout(30_000);
    try {
      const scope=await roomScope(channel,deadline);
      if (!scope) return true;
      const initial=await authorized(actor,deadline);
      if (!initial || !botCanReply(scope,initial,await readBot(deadline))) return true;
      const roleId=roleIdOf(text);
      const knownRole=roleId && initial.has(roleId);
      let ids;
      if (knownRole) {
        try {
          ids=await collect(roleId,actor,deadline);
          if (!ids) return true; // Authorization was lost during enumeration.
        } catch {} // An incomplete list is never rendered.
      }
      const current=await authorizedRoom(actor,channel,deadline);
      if (!current || !open()) return true;
      let body, session;
      if (!knownRole) {
        body={content:roleId?'ما لقيت هذا الرول في السيرفر.':inRoleCommand.usage};
      } else if (!ids || !current.has(roleId)) {
        body={content:UNAVAILABLE};
      } else {
        session={roleId,ids,key:randomBytes(12).toString('base64url'),channel,source,page:0,revision:0};
        body=render(session,current.get(roleId).name);
      }
      // A vanished source or an uncertain POST never becomes a standalone message or a retry.
      const sent=await post(Routes.channelMessages(channel),deadline,{...body,allowed_mentions:NO_MENTIONS,
        message_reference:{message_id:source,channel_id:channel,guild_id:G,fail_if_not_exists:true}});
      if (!session || !open() || !snowflake(sent?.id) || !sameReply(sent,session)) return true;
      forget(actor);
      if (sessions.size>=MAX_SESSIONS) forget(sessions.keys().next().value);
      session.message=sent.id;
      session.expires=Date.now()+SESSION_MS;
      session.timer=setTimeout(()=>forget(actor),SESSION_MS).unref();
      sessions.set(actor,session);
    } catch {} finally { active.delete(actor); }
    return true;
  }
  async function button(i) {
    if (!i.customId?.startsWith('lxr-inrole:')) return false;
    const actor=i.user?.id, session=sessions.get(actor);
    if (!session || closed() || active.has(actor) || active.size>=MAX_SCANS || !i.isButton() || i.guildId!==G ||
        i.applicationId!==botId || i.user.bot ||
        i.channelId!==session.channel || i.message?.channelId!==session.channel ||
        i.message?.id!==session.message || i.message.author?.id!==botId || i.message.guildId!==G ||
        i.message.type!==MessageType.Reply || i.message.reference?.messageId!==session.source ||
        i.component?.disabled!==false) return true;
    const current=()=>sessions.get(actor)===session && session.expires>Date.now() && open();
    const direction=['l','r'].find(d=>i.customId===buttonId(session,session.revision,d));
    if (!direction || session.expires<=Date.now()) return true;
    const next=session.page+(direction==='l'?-1:1);
    if (next<0 || next>=pages(session)) return true;
    active.add(actor); // Claim synchronously, before defer or any permission reads.
    const deadline=AbortSignal.timeout(12_000);
    try {
      if (!current()) return true;
      await i.deferUpdate();
      const inventory=await authorizedRoom(actor,session.channel,deadline);
      if (!inventory?.has(session.roleId)) {
        forget(actor);
        return true;
      }
      if (!current() || deadline.aborted) return true;
      const revision=session.revision+1;
      const edited=await rest.patch(Routes.channelMessage(session.channel,session.message),
        {...opts(deadline),body:render(session,inventory.get(session.roleId).name,next,revision)});
      if (edited?.id!==session.message || !sameReply(edited,session)) {
        forget(actor);
        return true;
      }
      session.page=next;
      session.revision=revision;
    } catch { forget(actor); } // Uncertain writes never get replayed with the same controls.
    finally { active.delete(actor); }
    return true;
  }
  async function help(message,output) {
    const actor=message.author.id, id=message.channelId;
    const extended=`${output}\n${inRoleCommand.help}`;
    if (message.guildId!=null || message.client.user?.id!==botId || !snowflake(id) ||
        !snowflake(actor) || typeof output!=='string' || extended.length>2000 || active.has(actor) || active.size>=MAX_SCANS || closed()) return output;
    active.add(actor);
    try {
      const deadline=AbortSignal.timeout(5_000);
      if (validDm(await get(Routes.channel(id),deadline),id,actor) && await authorized(actor,deadline)) return extended;
    } catch {} finally { active.delete(actor); }
    return output;
  }
  return {text,button,help,close() { lifetime.abort(); for (const actor of sessions.keys()) forget(actor); }};
}

module.exports={createInRole};
