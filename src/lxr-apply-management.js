'use strict';

const {randomUUID}=require('node:crypto');
const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,DiscordAPIError,MessageFlags,RateLimitError,Routes}=require('discord.js');
const {commandName,subcommandName}=require('./command-aliases');
const {RuleError}=require('./ladder');
const prefix='lxr-app-room:delete:';
const responses={close:'🔒 أُغلقت التذكرة بدون حذفها.',reopen:'أُعيد فتح التذكرة.',rename:'تم تغيير اسم التذكرة.',
  claim:'تم استلام التذكرة.',unclaim:'أُلغي استلام التذكرة.',add:'تمت إضافة العضو للتذكرة.',remove:'تمت إزالة وصول العضو للتذكرة.'};
const slashActions=new Set(['claim','unclaim','close','reopen']);
const noMentions={parse:[],repliedUser:false};
const deny=(message='تعذّر التحقق من التذكرة أو من صلاحيتك لإدارتها.')=>{throw new RuleError(message);};
const describe=err=>err instanceof RuleError?err.message:'تعذّر تأكيد الإجراء أو صلاحيات البوت في هذه التذكرة.';
const unknownChannel=error=>error instanceof DiscordAPIError && error.status===404 && error.code===10003;
const rejected=error=>error instanceof RateLimitError || (error instanceof DiscordAPIError && ((error.status===403 && [50001,50013].includes(error.code)) ||
  (error.status===400 && error.code===50035) || unknownChannel(error)));

function createApplicationManager({readyGuild,state,getChannelWriteRest,now=Date.now},verification) {
  const {GUILD,BOT,DESTINATIONS,TOPIC_PREFIX,snowflake,within,initialRoom,matchesRoom,managedAcl,
    isApplicationDestination,exactAcl,matchesStoredReceipt,verifyMessage,locateRoom}=verification;
  const byParent=new Map(Object.entries(DESTINATIONS).map(([kind,{parent}])=>[parent,kind]));
  const inFlight=new Set(),confirmations=new Map();
  async function readRoom(rest,id) {
    const room=await rest.get(Routes.channel(id),within());
    if (room?.id!==id || room.guild_id!==GUILD) deny();
    return room;
  }
  async function categoryAcl(rest,kind) {
    const id=DESTINATIONS[kind].parent,c=await readRoom(rest,id);
    if (c.type!==ChannelType.GuildCategory || !Array.isArray(c.permission_overwrites)) deny();
    return c.permission_overwrites;
  }
  function connection() {
    const guild=readyGuild();
    if (guild?.id!==GUILD || guild.client?.user?.id!==BOT) deny();
    return guild.client.rest;
  }
  function roomKey(room,id) {
    const request=typeof room?.topic==='string' && room.topic.startsWith(TOPIC_PREFIX) && room.topic.slice(TOPIC_PREFIX.length);
    const kind=byParent.get(room?.parent_id);
    return room?.id===id && room.guild_id===GUILD && room.type===ChannelType.GuildText && snowflake(request) && kind?{id:request,kind}:null;
  }
  function member(rest,id) {return rest.get(Routes.guildMember(GUILD,id),within());}
  const human=(member,id)=>member?.user?.id===id && !member.user.bot && member.pending!==true && Array.isArray(member.roles);
  async function authorize(rest,actor,kind,ownerOnly) {
    const [g,m]=await Promise.all([rest.get(Routes.guild(GUILD),within()),member(rest,actor)]);
    if (g?.id!==GUILD || !snowflake(g.owner_id) || !human(m,actor)) deny();
    if (actor!==g.owner_id && (ownerOnly || !m.roles.includes(DESTINATIONS[kind].reviewer))) deny('هذا الإجراء لفريق التقديم المخوّل في هذه التذكرة.');
    return g.owner_id;
  }
  async function load(rest,room,channel,identity) {
    let saved=state.read(channel);
    if (!saved) {
      // The original, exact bot receipt anchors older rooms too, including requests manually unblocked later.
      const {id,kind}=identity;
      if (await locateRoom(rest,room.topic)!==channel) deny();
      const history=await rest.get(Routes.channelMessages(channel),{...within(),query:new URLSearchParams({after:channel,limit:'100'})});
      if (!Array.isArray(history)) deny();
      const matches=m=>{
        const user=m?.mentions?.[0]?.id;
        return snowflake(user) && user!==BOT && user!==GUILD && user!==id && matchesStoredReceipt(m,channel,{id,kind,user});
      };
      const receipts=history.filter(matches);
      if (receipts.length!==1) deny();
      const key={id,kind,user:receipts[0].mentions[0].id};
      await verifyMessage(rest,channel,receipts[0].id,m=>matches(m) && m.mentions[0].id===key.user);
      const current=initialRoom();
      if (!matchesRoom(room,channel,key,current) || !state.create(channel,key,current)) deny();
      saved=state.read(channel);
    }
    if (saved.key.id!==identity.id || saved.key.kind!==identity.kind) deny();
    const parent=await categoryAcl(rest,identity.kind);
    if (exactAcl(room.permission_overwrites,parent)) deny();
    if (saved.pending) {
      // Read-only reconciliation on a fresh command: never resubmit an uncertain write.
      if (!matchesRoom(room,channel,saved.key,saved.pending) || !state.finish(channel,saved.current,saved.pending,saved.pending))
        deny('فيه تعديل سابق ما تأكّد بعد. ما نقدر نعدّل التذكرة الآن.');
      saved=state.read(channel);
    }
    if (!matchesRoom(room,channel,saved.key,saved.current)) deny();
    return saved;
  }
  function writer() {
    const rest=getChannelWriteRest?.();
    if (rest?.options?.retries!==0 || typeof rest.options.rejectOnRateLimit!=='function') deny();
    return rest;
  }
  const reason='LXR application ticket management';
  async function update(rest,channel,key,current,next,body,reauthorize) {
    const mutator=body && writer();
    // A queued authority read must not age the room/category snapshots used to permit a write.
    await reauthorize();
    const fresh=await readRoom(rest,channel);
    const parent=await categoryAcl(rest,key.kind);
    if (!matchesRoom(fresh,channel,key,current) || exactAcl(fresh.permission_overwrites,parent) || exactAcl(managedAcl(key,next),parent)) deny();
    if (!body) {
      if (!state.finish(channel,current,null,next) || state.read(channel)?.current.assignee!==next.assignee) deny();
      return;
    }
    if (!state.start(channel,current,next)) deny();
    let error;
    try {await mutator.patch(Routes.channel(channel),{...within(),reason,body});}
    catch (err) {error=err;}
    if (rejected(error)) {
      state.finish(channel,current,next,current);
      if (error instanceof RateLimitError) deny('ديسكورد حدّ الطلبات مؤقتًا. جرّب الأمر من جديد بعد شوي.');
      deny();
    }
    const [actual,currentParent]=await Promise.all([readRoom(rest,channel),categoryAcl(rest,key.kind)]);
    if (matchesRoom(actual,channel,key,next) && !exactAcl(actual.permission_overwrites,currentParent) && state.finish(channel,current,next,next)) return;
    deny('ما قدرنا نؤكد تعديل التذكرة.');
  }
  async function execute(rest,channel,actor,action,args,send) {
    if (!snowflake(actor) || inFlight.has(channel)) deny();
    inFlight.add(channel);
    try {
      const room=await readRoom(rest,channel),identity=roomKey(room,channel);
      if (!identity) deny();
      const reauthorize=()=>authorize(rest,actor,identity.kind,['add','remove'].includes(action));
      const owner=await reauthorize();
      const {key,current}=await load(rest,room,channel,identity);
      const next={...current};
      if (action==='delete' || action==='delete-confirm') {
        if (action==='delete') {
          if (args) deny('الاستخدام: `+delete` ثم زر التأكيد.');
          for (const [id,pending] of confirmations) if (pending.expires<=now() || pending.channel===channel) confirmations.delete(id);
          if (confirmations.size>=512) deny();
          const id=prefix+randomUUID(),expires=now()+60_000;
          const button=new ButtonBuilder().setCustomId(id).setLabel('تأكيد الحذف').setStyle(ButtonStyle.Danger);
          const posted=await send('**الحذف نهائي ويشمل الرسائل والصور.** زر التأكيد يعمل لك وحدك لمدة دقيقة.',[new ActionRowBuilder().addComponents(button)]);
          if (snowflake(posted?.id)) confirmations.set(id,{channel,actor,expires,message:posted.id,request:key.id});
          return;
        }
        await reauthorize();
        const fresh=await readRoom(rest,channel);
        const parent=await categoryAcl(rest,key.kind);
        if (args.request!==key.id || args.expires<=now() || !matchesRoom(fresh,channel,key,current) || exactAcl(fresh.permission_overwrites,parent)) deny();
        const mutator=writer();
        try {await mutator.delete(Routes.channel(channel),{...within(),reason});}
        catch(error) {if (error instanceof RateLimitError) deny('ديسكورد حدّ الطلبات مؤقتًا. اكتب `+delete` من جديد بعد شوي.');}
        try {await readRoom(rest,channel);} catch (error) {
          if (!unknownChannel(error)) throw error;
          state.remove(channel);
          return 'حُذفت التذكرة.';
        }
        deny('ما قدرنا نؤكد حذف التذكرة.');
      }
      if (action==='close' || action==='reopen') {
        if (args) deny('الاستخدام: `+close` بدون إضافات.');
        if (current.closed===(action==='close')) return action==='close'?'التذكرة مغلقة بالفعل.':'التذكرة مفتوحة بالفعل.';
        next.closed=action==='close';
      } else if (action==='rename') {
        const name=args.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu,'-');
        if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{1,89}$/u.test(name)) deny('الاستخدام: `+rename الاسم-الجديد`.');
        if (current.name===name) return 'هذا هو اسم التذكرة حاليًا.';
        next.name=name;
      } else if (action==='claim' || action==='unclaim') {
        if (current.closed) deny('الاستلام للتذاكر المفتوحة فقط.');
        if (action==='claim' && current.assignee) deny('التذكرة مستلمة بالفعل.');
        if (action==='unclaim' && (!current.assignee || (current.assignee!==actor && actor!==owner))) deny('إلغاء الاستلام للمستلم أو مالك السيرفر.');
        next.assignee=action==='claim'?actor:null;
      } else {
        const target=/^(?:<@!?([1-9]\d{16,19})>|([1-9]\d{16,19}))$/u.exec(args);
        const id=target?.[1]??target?.[2];
        if (!snowflake(id)) deny(`الاستخدام: \`+${action} @العضو\`.`);
        if (action==='add') {
          if ([GUILD,BOT,key.user,owner,...current.guests].includes(id) || current.guests.length>=20) deny('ما يمكن إضافة هذا العضو للتذكرة.');
          const m=await member(rest,id);
          if (!human(m,id) || m.roles.includes(DESTINATIONS[key.kind].reviewer)) deny('ما يمكن إضافة هذا العضو للتذكرة.');
          next.guests=[...current.guests,id];
        } else {
          if (!current.guests.includes(id)) deny('تقدر تزيل ضيف أُضيف يدويًا فقط.');
          next.guests=current.guests.filter(guest=>guest!==id);
        }
      }
      const body=action==='rename'?{name:next.name}:['claim','unclaim'].includes(action)?null:
        {permission_overwrites:managedAcl(key,next)};
      await update(rest,channel,key,current,next,body,async()=>{
        const freshOwner=await reauthorize();
        if (action==='unclaim' && current.assignee!==actor && actor!==freshOwner) deny();
      });
      return responses[action];
    } finally {inFlight.delete(channel);}
  }
  async function text(message,content) {
    const command=/^\+(close|delete|rename|add|remove)(?:\s+([\s\S]+))?$/u.exec(content);
    if (!command || message.guildId!==GUILD || message.author?.bot || message.webhookId || !snowflake(message.channelId)) return false;
    const channel=message.channelId;
    let rest,room;
    try {rest=connection();room=await readRoom(rest,channel);} catch {return true;}
    if (!roomKey(room,channel)) return isApplicationDestination(room);
    if (message.channel?.id!==channel) return true;
    const send=(content,components=[])=>message.channel.send({content,components,allowedMentions:noMentions});
    try {
      const reply=await execute(rest,channel,message.author.id,command[1],(command[2]??'').trim(),send);
      if (reply) await send(reply);
    } catch (error) {await send(describe(error)).catch(()=>{});}
    return true;
  }
  async function interaction(i) {
    if (i.guildId!==GUILD || i.user?.bot || !snowflake(i.channelId) || !snowflake(i.user?.id)) return false;
    const button=i.isButton() && i.customId?.startsWith(prefix);
    const slash=i.isChatInputCommand() && i.commandGuildId===GUILD && commandName(i.commandName)==='ticket' && subcommandName(i.commandName,i.options.getSubcommand(false));
    if (!button && !slashActions.has(slash)) return false;
    const actor=i.user.id,channel=i.channelId;
    const say=content=>i.editReply({content,allowedMentions:noMentions}).catch(()=>{});
    try {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      if (button) {
        const pending=confirmations.get(i.customId);
        if (!pending || pending.actor!==actor || pending.channel!==channel || pending.expires<=now() ||
            i.message?.author?.id!==BOT || i.message.id!==pending.message) deny('انتهت مهلة التأكيد أو الزر ليس لك.');
        confirmations.delete(i.customId);
        await say(await execute(connection(),channel,actor,'delete-confirm',pending));
      } else {
        const rest=connection(),room=await readRoom(rest,channel);
        if (!roomKey(room,channel)) {
          if (!isApplicationDestination(room)) return false;
          deny();
        }
        await say(await execute(rest,channel,actor,slash,''));
      }
    } catch (error) {if (i.deferred) await say(describe(error));}
    return true;
  }
  return {text,interaction};
}
module.exports={createApplicationManager};
