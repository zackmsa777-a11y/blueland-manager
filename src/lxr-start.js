'use strict';

const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,ComponentType,EmbedBuilder,MessageFlags,
  PermissionFlagsBits,Routes,StringSelectMenuBuilder}=require('discord.js');
const {catalog}=require('./ladder');

const ROOM='1574894916872572958';
const SELECT='lxr-start:sections';
const NICK='lxr-start:nick';
const PIC='lxr-start:pic';
const NICK_ROLE='1574013661671067758';
// Refuse any new server-level permissions on this self-assignable role.
const NICK_PERMISSION_CEILING=211793497918465n;
const PANEL_PERMISSIONS=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AttachFiles];
const SOURCE_CHANNEL='1574640612500578495';
const SOURCE_MESSAGE='1575133335510978721';
const SOURCE_ATTACHMENT='1575133334529376276';
const SOURCE_NAME='IMG_3553.jpg';
const BANNER='lxr-start.jpg';
const SIZE=78089;
const DIGEST='3a661e6f4225b622c1ad8e9bc7d3c108ddf96e706b646137e84548c9ebb4b625';
const COLOR=0x527cf5;
const BRAND='LXR Empire';
const NO_PINGS={parse:[]};
const rules=readFileSync(join(__dirname,'lxr-start-rules.txt'),'utf8');
const sections=[
  {label:'القوانين',value:'rules',description:'اقرأ قوانين خادم LXR.'},
  {label:'الفروع',value:'branches',description:'تعرّف على فروع LXR.'},
  {label:'Nickname & Pic Roles',value:'roles',description:'رتب النك والبيك.'},
  {label:'الخريطة',value:'map',description:'خريطة رومات السيرفر.'},
  {label:'رتب LXR العامة',value:'public-roles',description:'الرتب العامة في LXR.'}
];
const embed=()=>new EmbedBuilder().setColor(COLOR);

async function downloadBanner(client,fetchImage) {
  const source=await client.rest.get(Routes.channelMessage(SOURCE_CHANNEL,SOURCE_MESSAGE));
  const attachment=source?.id===SOURCE_MESSAGE && source.attachments?.find(a=>a.id===SOURCE_ATTACHMENT);
  if (!attachment || attachment.filename!==SOURCE_NAME || attachment.size!==SIZE) throw new Error('LXR banner attachment unavailable');
  const url=new URL(attachment.url);
  if (url.origin!=='https://cdn.discordapp.com' || url.username || url.password ||
      url.pathname!==`/attachments/${SOURCE_CHANNEL}/${SOURCE_ATTACHMENT}/${SOURCE_NAME}`) throw new Error('LXR banner URL invalid');
  const result=await fetchImage(url.href,{redirect:'error',signal:AbortSignal.timeout(10_000)});
  if (!result.ok || !result.body) throw new Error('LXR banner download failed');
  const out=Buffer.alloc(SIZE);
  let at=0;
  for await (const chunk of result.body) {
    if (chunk.length>SIZE-at) throw new Error('LXR banner size invalid');
    out.set(chunk,at);
    at+=chunk.length;
  }
  if (at!==SIZE || createHash('sha256').update(out).digest('hex')!==DIGEST) throw new Error('LXR banner integrity check failed');
  return out;
}

const hasControl=(m,key)=>m?.components?.some(row=>row.components.some(c=>(c.customId ?? c.custom_id)===key));
const isPanel=(m,id)=>m?.author?.id===id && hasControl(m,SELECT);
function discordAttachmentPath(value) {
  try {
    const url=new URL(value);
    if (['https://cdn.discordapp.com','https://media.discordapp.net'].includes(url.origin) && !url.username && !url.password) return url.pathname;
  } catch {}
}
function validPanel(m,id) {
  if (!isPanel(m,id) || m.embeds?.length!==2 || m.embeds[1].footer?.text!==BRAND || m.components.length!==1 ||
      m.components[0].components.length!==1 || m.attachments?.size!==1) return false;
  const [select]=m.components[0].components;
  if (select.type!==ComponentType.StringSelect || select.disabled || select.options?.length!==sections.length ||
      !sections.every((s,index)=>['value','label','description'].every(k=>select.options[index]?.[k]===s[k]))) return false;
  const attachment=m.attachments.first();
  if (attachment.name!==BANNER || attachment.size!==SIZE) return false;
  const art=m.embeds[0].image?.url;
  if (art===`attachment://${BANNER}`) return true;
  const expected=`/attachments/${ROOM}/${attachment.id}/${BANNER}`;
  return discordAttachmentPath(art)===expected && discordAttachmentPath(attachment.url)===expected;
}
function panelPayload(image) {
  const select=new StringSelectMenuBuilder().setCustomId(SELECT).setPlaceholder('اختَر بين الأقسام الأساسية').addOptions(sections);
  return {embeds:[embed().setImage('attachment://'+BANNER),
    embed().setDescription('**هنا البداية: أهم معلومات سيرفر LXR.**\nاختَر القسم اللي بدّك ياه من القائمة بالأسفل.').setFooter({text:BRAND})],
    components:[new ActionRowBuilder().addComponents(select)],files:[{attachment:image,name:BANNER}],
    allowedMentions:NO_PINGS,nonce:SOURCE_MESSAGE,enforceNonce:true};
}

const replyEmbed=(description,title)=>{
  const card=embed().setDescription(description);
  if (title) card.setTitle(title);
  return {embeds:[card],allowedMentions:NO_PINGS};
};
function sectionReply(section) {
  switch (section) {
    case 'rules': return replyEmbed(rules);
    case 'branches': return replyEmbed('لا توجد لدينا اي فروع أخرى','الفروع');
    case 'map': return replyEmbed('الخريطة غير متاحة حالياً.','الخريطة');
    case 'public-roles': return replyEmbed('الرتب العامة غير متاحة حالياً.','رتب LXR العامة');
    case 'roles': return {...replyEmbed('اضغط Nickname لتحصل على رتبة النك.\nزر Pic غير مفعّل حالياً.','Nickname & Pic Roles'),
      components:[new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(NICK).setLabel('Nickname').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(PIC).setLabel('Pic').setStyle(ButtonStyle.Secondary).setDisabled(true))]};
    default: return replyEmbed('هذا القسم غير متاح حالياً.');
  }
}

function createLxrStart({readyGuild,fetchImage=fetch,loadBanner=client=>downloadBanner(client,fetchImage)}) {
  let running,postedId;
  async function publishPanel() {
    const guild=readyGuild();
    if (guild.id!==catalog.guildId) throw new Error('Invalid LXR guild');
    const channel=await guild.channels.fetch(ROOM,{force:true,cache:false});
    if (channel?.id!==ROOM || channel.guildId!==guild.id || channel.type!==ChannelType.GuildText) throw new Error('Invalid LXR entrance channel');
    const botId=guild.client.user.id;
    if (!channel.permissionsFor(guild.members.me ?? botId)?.has(PANEL_PERMISSIONS)) throw new Error('LXR panel permissions unavailable');
    const verifyPosted=async()=>{
      const checked=await channel.messages.fetch({message:postedId,force:true,cache:false});
      if (!validPanel(checked,botId)) throw new Error('Posted LXR panel failed verification');
      return postedId;
    };
    if (postedId) return verifyPosted();
    let before;
    for (let page=0;page<10;page++) {
      const messages=await channel.messages.fetch({limit:100,before,cache:false});
      const existing=messages.find(m=>isPanel(m,botId));
      if (existing) {
        if (!validPanel(existing,botId)) throw new Error('Existing LXR panel failed verification');
        return existing.id;
      }
      if (messages.size<100) {
        const image=await loadBanner(guild.client);
        const posted=await channel.send(panelPayload(image));
        postedId=posted.id;
        return verifyPosted();
      }
      before=messages.lastKey();
    }
    throw new Error('Could not verify LXR panel history');
  }
  function publish() {
    if (!running) running=publishPanel().finally(()=>{running=undefined;});
    return running;
  }
  async function handle(i) {
    if (i.guildId!==catalog.guildId || i.channelId!==ROOM || i.message?.author?.id!==i.client.user.id || i.user.bot) return false;
    const id=i.customId;
    if (i.isStringSelectMenu() && id===SELECT && hasControl(i.message,SELECT)) {
      await i.reply({...sectionReply(i.values[0]),flags:MessageFlags.Ephemeral}).catch(()=>{});
      return true;
    }
    if (!i.isButton() || (id!==NICK && id!==PIC) || !hasControl(i.message,id) || !i.message.flags?.has(MessageFlags.Ephemeral)) return false;
    if (id===PIC) {
      await i.reply({...replyEmbed('زر Pic غير مفعّل حالياً.'),flags:MessageFlags.Ephemeral}).catch(()=>{});
      return true;
    }
    try {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const guild=readyGuild();
      const rest=guild.client.rest;
      const memberRoute=Routes.guildMember(guild.id,i.user.id);
      const isMember=m=>m?.user?.id===i.user.id && !m.user.bot && Array.isArray(m.roles);
      const [role,member]=await Promise.all([guild.roles.fetch(NICK_ROLE,{force:true,cache:false}),rest.get(memberRoute)]);
      if (role?.id!==NICK_ROLE || !role.editable || role.managed || (role.permissions.bitfield & ~NICK_PERMISSION_CEILING)!==0n ||
          !isMember(member)) throw new Error('Invalid LXR nickname role or member');
      const already=member.roles.includes(NICK_ROLE);
      if (!already) {
        const rooms=await rest.get(Routes.guildChannels(guild.id));
        // Even a basic channel Allow can supersede a different role's Deny.
        if (rooms.some(room=>room.permission_overwrites?.some(overwrite=>overwrite.id===NICK_ROLE &&
            BigInt(overwrite.allow)!==0n))) throw new Error('LXR nickname role has unsafe channel permissions');
        await rest.put(Routes.guildMemberRole(guild.id,i.user.id,NICK_ROLE),{reason:'LXR Empire · Nickname self-role'});
        const checked=await rest.get(memberRoute);
        if (!isMember(checked) || !checked.roles.includes(NICK_ROLE)) throw new Error('LXR nickname role not verified');
      }
      await i.editReply(replyEmbed(already?'رتبة nick موجودة عندك بالفعل.':'تم إعطاؤك رتبة nick.'));
    } catch {
      if (i.deferred || i.replied) await i.editReply(replyEmbed('تعذّر إعطاء رتبة nick حالياً.')).catch(()=>{});
    }
    return true;
  }
  return {publish,handle};
}

module.exports={createLxrStart};
