'use strict';

const {randomBytes}=require('node:crypto');
const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,EmbedBuilder,PermissionFlagsBits,Routes}=require('discord.js');
const {catalog}=require('./ladder');
const {inRoleCommand,isInRole}=require('./commands');

const G=catalog.guildId;
const PAGE=20, API_PAGE=1_000, MAX_MEMBERS=200_000, MAX_SCANS=3, MAX_SESSIONS=12, SESSION_MS=5*60_000;
const NO_MENTIONS={parse:[],users:[],roles:[],replied_user:false};
const UNAVAILABLE='تعذّر تأكيد قائمة أعضاء الرول. جرّب مرة ثانية.';
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

function createInRole({rest,readyGuild,botId}) {
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
  function forget(actor) {
    clearTimeout(sessions.get(actor)?.timer);
    sessions.delete(actor);
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
    const actor=message.author.id;
    if (message.guildId!==G || message.client.user?.id!==botId || active.has(actor) || active.size>=MAX_SCANS || closed()) return true;
    active.add(actor);
    const deadline=AbortSignal.timeout(30_000);
    try {
      if (!await authorized(actor,deadline)) return true;
      const roleId=roleIdOf(text);
      const dm=await post(Routes.userChannels(),deadline,{recipient_id:actor});
      if (!validDm(dm,dm?.id,actor)) return true;
      let startedSend=false;
      const send=body=>{
        startedSend=true;
        return post(Routes.channelMessages(dm.id),deadline,body);
      };
      try {
        const initial=await authorized(actor,deadline);
        if (!initial) return true;
        if (!roleId || !initial.has(roleId)) {
          await send({content:roleId?'ما لقيت هذا الرول في السيرفر.':inRoleCommand.usage,allowed_mentions:NO_MENTIONS});
          return true;
        }
        const ids=await collect(roleId,actor,deadline);
        if (!ids) return true;
        const current=await authorized(actor,deadline);
        if (!current) return true;
        if (!current.has(roleId)) throw Error('Role no longer exists');
        const session={roleId,ids,key:randomBytes(12).toString('base64url'),channel:dm.id,page:0,revision:0};
        const sent=await send(render(session,current.get(roleId).name));
        if (!open() || !snowflake(sent?.id) || sent.channel_id!==dm.id || sent.author?.id!==botId) return true;
        forget(actor);
        if (sessions.size>=MAX_SESSIONS) forget(sessions.keys().next().value);
        session.message=sent.id;
        session.expires=Date.now()+SESSION_MS;
        session.timer=setTimeout(()=>forget(actor),SESSION_MS).unref();
        sessions.set(actor,session);
      } catch {
        // Do not retry a send whose outcome is unknown or use the invoking channel as fallback.
        if (!startedSend && await authorized(actor,deadline)) await send({content:UNAVAILABLE,allowed_mentions:NO_MENTIONS});
      }
    } catch {} finally { active.delete(actor); }
    return true;
  }
  async function button(i) {
    if (!i.customId?.startsWith('lxr-inrole:')) return false;
    const actor=i.user?.id, session=sessions.get(actor);
    if (!session || closed() || active.has(actor) || active.size>=MAX_SCANS || !i.isButton() || i.guildId!=null ||
        i.applicationId!==botId || i.user.bot || i.channel?.type!==ChannelType.DM ||
        i.channelId!==session.channel || i.message?.channelId!==session.channel ||
        i.message?.id!==session.message || i.message?.author?.id!==botId || i.message.guildId!=null ||
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
      const dm=await get(Routes.channel(session.channel),deadline);
      if (!validDm(dm,session.channel,actor)) { forget(actor); return true; }
      const inventory=await authorized(actor,deadline);
      if (!inventory?.has(session.roleId)) { forget(actor); return true; }
      if (!current() || deadline.aborted) return true;
      const revision=session.revision+1;
      const edited=await rest.patch(Routes.channelMessage(session.channel,session.message),
        {...opts(deadline),body:render(session,inventory.get(session.roleId).name,next,revision)});
      if (edited?.id!==session.message || edited.channel_id!==session.channel || edited.author?.id!==botId) {
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
