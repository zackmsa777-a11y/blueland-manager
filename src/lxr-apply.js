'use strict';
const {createHash,randomBytes}=require('node:crypto');
const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,ComponentType,EmbedBuilder,LabelBuilder,
  MessageFlags,ModalBuilder,PermissionFlagsBits:P,Routes,StringSelectMenuBuilder,TextInputBuilder,TextInputStyle}=require('discord.js');
const {catalog}=require('./ladder');
const ROOM='1575125050170806373';
const SOURCE={channel:'1574640612500578495',message:'1575527588712157346',author:'1486306919324057682',attachment:'1575527586576994398',
  name:'25D42B3A-7947-4230-9CD8-5D7755F36A96.png',size:2146209,digest:'4b241a28b1be1d5d8e104df006785ecae57afd16ce58134e7b72fe1b2c7a399a'};
const BANNER='lxr-apply.png', PREFIX='lxr-apply:', SELECT=PREFIX+'select', BRAND='LXR Empire';
const TITLE='إدارة LXR ترحّب بكم';
const INTRO='حياك الله في LXR! اختر مسار التقديم وعَبّي الاستبيان. إجاباتك ما تظهر في روم التقديم.\n\nشعار `LXR` يكون باسم العرض العام، مو نِك نيم السيرفر، ودعوة السيرفر تكون في البايو.';
const NO_PINGS={parse:[]};
const PANEL_PERMS=[P.ViewChannel,P.ReadMessageHistory,P.SendMessages,P.EmbedLinks,P.AttachFiles];
const SESSION_MS=15*60_000, MAX_SESSIONS=1024;
const options=[
  {value:'staff',label:'تقديم إدارة',description:'للراغبين بالانضمام إلى إدارة LXR',emoji:'🔵'},
  {value:'girls',label:'تقديم إدارة بنات',description:'مسار خاص بمراجعة مسؤولات البنات',emoji:'🟣'},
  {value:'transfer',label:'نقل رتب',description:'نقل خبرتك ورتبتك من سيرفر آخر إلى LXR',emoji:'💠'},
];
const prompts=[
  ['identity','عرّف عن نفسك','الاسم أو الاسم اللي تحب نناديك فيه، العمر، البلد والصف الدراسي (إن وجد).'],
  ['experience','وش خبرتك بالإدارة؟','هل كنت أو ما زلت إداري بسيرفر ثاني؟ إذا ما عندك خبرة، اكتب «لا يوجد».'],
  ['reason','ليش اخترت LXR؟','اكتب سبب اختيارك للسيرفر.'],
  ['availability','كم تتفاعل باليوم؟','كم ساعة تقريبًا؟ وهل في شي ممكن يقلل وجودك لاحقًا؟'],
  ['branding','بتحط شعار LXR والرابط؟','شعار LXR في اسم العرض العام والدعوة في البايو.'],
];
const transferPrompts=[['server','اسم السيرفر السابق','اكتب اسم السيرفر كما يظهر في ديسكورد.'],
  ['previous_rank','الرتبة السابقة','اكتب اسم الرتبة اللي تطلب نقلها.']];
const embed=()=>new EmbedBuilder().setColor(0x1876d7);
const ephem=(description,components)=>({embeds:[embed().setDescription(description)],allowedMentions:NO_PINGS,
  ...(components?{components}:{}),flags:MessageFlags.Ephemeral});
const edit=(description)=>({embeds:[embed().setDescription(description)],allowedMentions:NO_PINGS});
const snowflake=id=>typeof id==='string'&&/^\d{17,20}$/u.test(id);
const hasControl=(m,id)=>m?.components?.some(row=>row.components?.some(c=>(c.customId??c.custom_id)===id));
const rawId=c=>c.customId??c.custom_id;
const textInput=(id,label,description)=>new LabelBuilder().setLabel(label).setDescription(description).setTextInputComponent(
  new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500));

const kindTitle=kind=>options.find(option=>option.value===kind)?.label;
const form=(id,title,labels)=>new ModalBuilder({custom_id:id,title,components:labels.map(c=>c.toJSON())});
function baseForm(session,token) {
  return form(PREFIX+'form:'+token,kindTitle(session.kind)+' | LXR',prompts.map(f=>textInput(...f)));
}
function transferForm(token) {
  return form(PREFIX+'details:'+token,'بيانات نقل الرتبة',transferPrompts.map(f=>textInput(...f)));
}
function readAnswers(i,fields) {
  return fields.map(([key,name])=>{
    const value=i.fields.getTextInputValue(key)?.trim();
    if (!value || value.length>500) throw new Error('invalid application answer');
    return {name,value};
  });
}
function originalPath(value,origins) {
  try {
    const url=new URL(value);
    if (origins.includes(url.origin) && !url.username && !url.password) return url.pathname;
  } catch {}
}
async function downloadApplicationBanner(client,fetchImage=fetch) {
  const source=await client.rest.get(Routes.channelMessage(SOURCE.channel,SOURCE.message),{signal:AbortSignal.timeout(8000)});
  const a=source?.id===SOURCE.message && source.channel_id===SOURCE.channel && source.author?.id===SOURCE.author &&
    source.attachments?.find(x=>x.id===SOURCE.attachment);
  if (!a || a.filename!==SOURCE.name || a.size!==SOURCE.size ||
      originalPath(a.url,['https://cdn.discordapp.com'])!==`/attachments/${SOURCE.channel}/${SOURCE.attachment}/${SOURCE.name}`)
    throw new Error('LXR application banner unavailable');
  return checkedBannerBytes(a.url,fetchImage);
}
async function checkedBannerBytes(url,fetchImage=fetch) {
  const r=await fetchImage(url,{redirect:'error',signal:AbortSignal.timeout(10_000)});
  if (!r.ok || !r.body) throw new Error('LXR application banner download failed');
  const bytes=Buffer.alloc(SOURCE.size);
  let count=0;
  for await(const part of r.body) {
    if (part.length>bytes.length-count) throw new Error('LXR application banner too large');
    bytes.set(part,count);
    count+=part.length;
  }
  if (count!==SOURCE.size || createHash('sha256').update(bytes).digest('hex')!==SOURCE.digest) throw new Error('LXR application banner hash mismatch');
  return bytes;
}
function panelPayload(bytes) {
  const menu=new StringSelectMenuBuilder().setCustomId(SELECT).setPlaceholder('اختر مسار التقديم…').setMinValues(1).setMaxValues(1).addOptions(options);
  return {embeds:[embed().setImage('attachment://'+BANNER),embed().setTitle(TITLE).setDescription(INTRO).setFooter({text:BRAND})],
    components:[new ActionRowBuilder().addComponents(menu)],files:[{name:BANNER,attachment:bytes}],
    nonce:SOURCE.message,enforceNonce:true,allowedMentions:NO_PINGS};
}
const isPanel=(m)=>m?.author?.id===catalog.botId && m.channelId===ROOM && hasControl(m,SELECT);
function verifyPanel(m) {
  if (!isPanel(m) || !snowflake(m.id) || m.content!=='' || m.embeds?.length!==2 || m.embeds[1]?.title!==TITLE ||
      m.embeds[1]?.description!==INTRO || m.embeds[1]?.footer?.text!==BRAND || m.components.length!==1 || m.components[0].components.length!==1 ||
      m.attachments?.size!==1) return false;
  const [art,copy]=m.embeds;
  for (const e of [art,copy]) if (e.url || e.author || e.thumbnail || e.video || e.fields?.length) return false;
  if (art.title || art.description || art.footer || copy.image) return false;
  const [menu]=m.components[0].components;
  if (menu.type!==ComponentType.StringSelect || rawId(menu)!==SELECT || menu.disabled || menu.placeholder!=='اختر مسار التقديم…' ||
      (menu.minValues??menu.min_values)!==1 || (menu.maxValues??menu.max_values)!==1 || menu.options?.length!==options.length ||
      !options.every((o,index)=>{
        const actual=menu.options[index];
        return ['value','label','description'].every(k=>actual?.[k]===o[k]) && actual.emoji?.name===o.emoji &&
          !actual.emoji?.id && !actual.emoji?.animated && !actual.default;
      })) return false;
  const a=m.attachments.first();
  const expected=`/attachments/${ROOM}/${a?.id}/${BANNER}`, origins=['https://cdn.discordapp.com','https://media.discordapp.net'];
  return a?.name===BANNER && a.size===SOURCE.size && snowflake(a.id) && originalPath(a.url,origins)===expected &&
    originalPath(m.embeds[0]?.image?.url,origins)===expected;
}
function createLxrApply({readyGuild,openTicket,receipts,loadBanner=downloadApplicationBanner,verifyExistingBanner=checkedBannerBytes,now=Date.now}) {
  let posting,knownId,verifiedId;
  const sessions=new Map(), recovering=new Set();
  function reap() {
    const time=now();
    for (const [token,s] of sessions) if (s.expires<=time && s.stage!=='busy') sessions.delete(token);
  }
  async function publishPanel() {
    verifiedId=undefined;
    const guild=readyGuild();
    if (guild.id!==catalog.guildId || guild.client.user.id!==catalog.botId) throw new Error('Invalid application guild');
    const channel=await guild.channels.fetch(ROOM,{force:true,cache:false});
    if (channel?.id!==ROOM || channel.guildId!==guild.id || channel.type!==ChannelType.GuildText ||
        !channel.permissionsFor(guild.members.me??catalog.botId)?.has(PANEL_PERMS)) throw new Error('Invalid application channel or permissions');
    const read=async id=>{
      const m=await channel.messages.fetch({message:id,force:true,cache:false});
      if (m?.id!==id || !verifyPanel(m)) throw new Error('Unverified application panel');
      const url=m.attachments.first().url;
      if (originalPath(url,['https://cdn.discordapp.com'])!==`/attachments/${ROOM}/${m.attachments.first().id}/${BANNER}`)
        throw new Error('Unverified application banner URL');
      await verifyExistingBanner(url);
      return verifiedId=id;
    };
    let before, found;
    for(let page=0;page<10;page++) {
      const messages=await channel.messages.fetch({limit:100,before,cache:false});
      const hits=messages.filter(isPanel);
      if(hits.size>1 || (found && hits.size)) throw new Error('Multiple application panels');
      if(hits.size===1) found=hits.first().id;
      if(messages.size<100) {
        if (found) {knownId=found;return read(found);}
        if (knownId) throw new Error('Unverified application panel history');
        const image=await loadBanner(guild.client);
        const posted=await channel.send(panelPayload(image));
        if (!snowflake(posted?.id)) throw new Error('Missing application panel receipt');
        knownId=posted.id;
        return read(knownId);
      }
      const next=messages.lastKey();
      if (!snowflake(next) || next===before) throw new Error('Unverified application panel history');
      before=next;
    }
    throw new Error('Unverified application panel history');
  }
  function publish() {
    if (!posting) posting=publishPanel().finally(()=>{posting=undefined;});
    return posting;
  }
  async function privateReply(i,text,components) {await i.reply(ephem(text,components)).catch(()=>{});}
  async function notify(i,record,channel) {
    if (!snowflake(channel)) throw new Error('Unverified application receipt');
    const text=record.kind==='girls'?'<:G_21:1574000061229305886> انتظري يا ملكة، طلبك وصل! <:G_25:1574000020783370370>':'طلبك وصل!';
    const next=record.kind==='transfer'?'\nأرسل الصورتين داخل التكت عشان يراجعها مسؤولو التقديم.':'';
    await i.editReply(edit(`${text} تكتك الخاص: <#${channel}>${next}`));
    receipts.clear(record);
  }
  async function recover(i,record) {
    if (recovering.has(record.userId)) {await privateReply(i,'يجري التحقق من طلبك السابق.');return;}
    recovering.add(record.userId);
    try {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      await notify(i,record,await openTicket.recover(record));
    } catch {
      await i.editReply(edit('ما قدرنا نؤكد فتح تكت طلبك السابق. راجع فريق التقديم بدون إرسال إجاباتك مرة ثانية.')).catch(()=>{});
    } finally {recovering.delete(record.userId);}
  }
  async function complete(i,token,s,answers) {
    s.stage='busy';
    const record={id:i.id,userId:s.actor,kind:s.kind};
    let claimed=false,delivered=false;
    try {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      if (!snowflake(i.id) || !(claimed=receipts.claim(record))) throw new Error('Another application is pending');
      const channel=await openTicket({...record,answers,freshReservation:true});
      delivered=true;
      await notify(i,record,channel);
    } catch (err) {
      let safe=claimed && !delivered && err?.safeToResubmit===true;
      if (safe) try {receipts.clear(record);} catch {safe=false;}
      const message=safe?'الطلب ما انرسل. جرّب مرة ثانية بعد شوي.':
        'تعذّر تأكيد فتح التكت. افتح قائمة التقديم مرة ثانية للتحقق من طلبك السابق، بدون إعادة إرسال الإجابات.';
      await i.editReply(edit(message)).catch(()=>{});
    } finally {sessions.delete(token);}
  }
  async function handle(i) {
    const id=i.customId;
    if (typeof id!=='string'||!id.startsWith(PREFIX)) return false;
    if (i.guildId!==catalog.guildId || i.channelId!==ROOM || i.client?.user?.id!==catalog.botId ||
        i.user?.bot || !snowflake(i.user?.id) || !verifiedId) return true;
    reap();
    const actor=i.user.id, sender=i.message?.author?.id;
    const invalid=()=>privateReply(i,'هذا النموذج غير متاح أو انتهت صلاحيته. افتح طلبًا جديدًا من اللوحة.');
    if (id===SELECT && i.isStringSelectMenu()) {
      const kind=i.values?.length===1&&i.values[0];
      if (sender!==catalog.botId || i.message?.id!==verifiedId || !hasControl(i.message,SELECT) || !kindTitle(kind)) {await invalid();return true;}
      const previous=[...sessions].find(([,s])=>s.actor===actor);
      if (previous?.[1].stage==='busy') {await privateReply(i,'طلبك السابق قيد الإرسال. انتظر شوي.');return true;}
      let pending;
      try {pending=receipts.find(actor);}
      catch {await privateReply(i,'التقديم غير متاح حاليًا، جرّب بعد شوي.');return true;}
      if (pending) {await recover(i,pending);return true;}
      if (previous) sessions.delete(previous[0]);
      if (sessions.size>=MAX_SESSIONS) {await privateReply(i,'ضغط على التقديم، جرّب بعد شوي.');return true;}
      const token=randomBytes(16).toString('hex'), s={actor,kind,panel:verifiedId,expires:now()+SESSION_MS,stage:'form'};
      sessions.set(token,s);
      try {await i.showModal(baseForm(s,token));}
      catch {sessions.delete(token);await invalid();}
      return true;
    }
    const match=/^lxr-apply:(form|continue|details):([0-9a-f]{32})$/u.exec(id);
    const token=match?.[2], s=sessions.get(token);
    if (!s || s.actor!==actor || s.panel!==verifiedId || sender!==catalog.botId) {await invalid();return true;}
    const phase=match[1];
    const ephemeral=()=>i.message?.flags?.has?.(MessageFlags.Ephemeral)===true;
    if (phase==='continue' && i.isButton() && s.stage==='continue' && ephemeral() && snowflake(i.message.id) && hasControl(i.message,id)) {
      s.detailsMessage=i.message.id;
      s.stage='details';
      try {await i.showModal(transferForm(token));}
      catch {s.stage='continue';await invalid();}
      return true;
    }
    if (!i.isModalSubmit()) {await invalid();return true;}
    if (phase==='form' && s.stage==='form' && i.message?.id===verifiedId) {
      let answers;
      try {answers=readAnswers(i,prompts);} catch {await privateReply(i,'لازم تعبي كل الأسئلة. ارجع افتح الاستبيان وحاول مرة ثانية.');return true;}
      if (s.kind==='transfer') {
        s.answers=answers;
        s.stage='continue';
        const button=new ButtonBuilder().setCustomId(PREFIX+'continue:'+token).setLabel('استكمال بيانات النقل').setStyle(ButtonStyle.Primary);
        await privateReply(i,'باقي اسم السيرفر والرتبة السابقة. كمّل البيانات عشان ينفتح تكت النقل.',[new ActionRowBuilder().addComponents(button)]);
      } else await complete(i,token,s,answers);
      return true;
    }
    if (phase==='details' && s.stage==='details' && s.kind==='transfer' && i.message?.id===s.detailsMessage && ephemeral()) {
      let answers;
      try {answers=[...s.answers,...readAnswers(i,transferPrompts)];}
      catch {await privateReply(i,'لازم تعبي اسم السيرفر والرتبة السابقة.');return true;}
      await complete(i,token,s,answers);
      return true;
    }
    await invalid();
    return true;
  }
  return {publish,handle};
}
module.exports={createLxrApply,downloadApplicationBanner};
