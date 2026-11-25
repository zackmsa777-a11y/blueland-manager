'use strict';

const {ActionRowBuilder, ChannelType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle} = require('discord.js');
const {catalog,RuleError} = require('./ladder');
const ui = require('./ticket-ui');
const noMentions = {parse:[]};
const privateReply = {flags:MessageFlags.Ephemeral,allowedMentions:noMentions};
const snowflake = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/u;
const {createTicketAssistant}=require('./ticket-assistant');

function createDiscordTickets({db,community,readyGuild,now}) {
  const talk=createTicketAssistant({botId:catalog.botId,now});
  let syncing = null;
  function syncPanel() {
    if (syncing) return syncing;
    syncing=(async()=>{
      const guild=readyGuild();
      const channel=await guild.channels.fetch(ui.PANEL,{force:true,cache:false});
      if (channel?.id!==ui.PANEL || channel.guildId!==catalog.guildId || channel.type!==ChannelType.GuildText) throw new RuleError('قناة لوحة التذاكر غير متاحة.',404);
      const belongs=m=>m?.author?.id===guild.client.user.id && ui.isPanel(m);
      const get=message=>channel.messages.fetch({message,force:true,cache:false}).catch(err=>{if(err.code===10008)return null;throw err;});
      const payload=ui.panel();
      const [expected]=payload.embeds;
      const [select]=payload.components[0].components;
      const matches=m=>{
        if (!belongs(m) || m.content!=='' || m.embeds?.length!==1 || m.components.length!==1 || m.components[0].components.length!==1) return false;
        const [live]=m.components[0].components;
        return m.embeds[0].title===expected.title && m.embeds[0].description===expected.description && m.embeds[0].color===expected.color &&
          live.type===select.type && !live.disabled && (live.minValues ?? live.min_values ?? 1)===1 &&
          (live.maxValues ?? live.max_values ?? 1)===1 && live.placeholder===select.placeholder && live.options?.length===select.options.length &&
          select.options.every(({value,label},index)=>live.options[index].value===value && live.options[index].label===label);
      };
      const id=db.panelMessage();
      const saved=id?await get(id):null;
      const existing=belongs(saved)?saved:(await channel.messages.fetch({limit:50,cache:false})).find(belongs);
      if (existing && matches(existing)) {
        if (existing.id!==id) db.savePanelMessage(existing.id);
        return existing.id;
      }
      const posted=existing?await existing.edit(payload):await channel.send(payload);
      const target=existing?.id ?? posted.id;
      if (!matches(await get(target))) throw new RuleError('تعذّر التحقق من لوحة التذاكر.',503);
      db.savePanelMessage(target);
      return target;
    })().finally(()=>{syncing=null;});
    return syncing;
  }
  function ticketFor(channel,id) {
    const ticket=db.ticketByChannel(channel);
    if (!ticket || (id && String(ticket.id)!==id)) throw new RuleError('هذا الإجراء يعمل داخل تذكرة BlueLand فقط.',404);
    return ticket;
  }
  const describe=err=>err instanceof RuleError?err.message:'تعذّر تنفيذ إجراء التذكرة. راجع الصلاحيات وحالة الاتصال.';
  async function text(message,content) {
    if (message.guildId!==catalog.guildId || message.author.bot || message.webhookId) return false;
    const ticket=db.ticketByChannel(message.channelId);
    if (!ticket) return false;
    const m=/^\+(rename|close|delete|add|remove)(?:\s+([\s\S]+))?$/u.exec(content);
    if (!m) {
      await talk(message,ticket,content);
      // Ticket conversation does not fall through to global text commands or shortcuts.
      return true;
    }
    const send=payload=>message.channel.send({allowedMentions:noMentions,...payload});
    const [,action,args='']=m;
    const actor=message.author.id;
    try {
      if (action==='close') {
        if (args) throw new RuleError('الاستخدام: `+close`');
        await community.ticketAction(actor,ticket.id,'close');
        await send({content:'🔒 أُغلقت التذكرة بدون حذفها.'});
      } else if (action==='delete') {
        if (args) throw new RuleError('الاستخدام: `+delete` ثم زر التأكيد.');
        await community.manageTicket(actor,ticket.id,'check-delete');
        await send({content:'**الحذف نهائي.** اضغط للتأكيد خلال دقيقة؛ الزر يعمل فقط للشخص اللي طلب الحذف.',components:ui.confirmation(ticket.id,actor,Date.now()+60_000)});
      } else if (action==='rename') {
        const name=args.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu,'-');
        if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]{1,89}$/u.test(name)) throw new RuleError('الاستخدام: `+rename اسم-التذكرة` بحروف أو أرقام وشرطات.');
        await community.manageTicket(actor,ticket.id,action,name);
        await send({content:'تم تغيير اسم التذكرة.'});
      } else {
        const target=snowflake.exec(args.trim());
        if (!target) throw new RuleError('الاستخدام: `+'+action+' @العضو` أو اكتب المعرّف الرقمي للعضو.');
        await community.manageTicket(actor,ticket.id,action,target[1]||target[2]);
        await send({content:action==='add'?'تمت إضافة العضو للتذكرة.':'تمت إزالة وصول العضو للتذكرة.'});
      }
    } catch(err) {
      await send({content:describe(err)}).catch(()=>{});
    }
    return true;
  }
  async function interaction(i) {
    if (i.guildId!==catalog.guildId || !i.customId?.startsWith('blticket:')) return false;
    const select=i.isStringSelectMenu?.();
    if (!(i.isButton() || i.isModalSubmit() || select)) return false;
    const [,action,param,requestedBy,until]=i.customId.split(':');
    const say=content=>i.reply({...privateReply,content});
    const panelType=action==='choose' || action==='open' || action==='form';
    try {
      if (i.user.bot || i.message?.author?.id!==i.client.user.id || (panelType && i.channelId!==ui.PANEL)) {
        throw new RuleError('استخدم لوحة التذاكر المعتمدة في السيرفر.',403);
      }
      if (i.customId===ui.SELECT && select) {
        const kind=i.values?.[0];
        if (i.message.id!==db.panelMessage() || i.values?.length!==1 || !ui.sections.includes(kind)) throw new RuleError('استخدم لوحة التذاكر الأحدث.',403);
        const input=(id,label,max,style)=>new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(true));
        const modal=new ModalBuilder().setCustomId('blticket:form:'+kind).setTitle(ui.kinds[kind])
          .addComponents(input('subject','الموضوع',120,TextInputStyle.Short),input('details','التفاصيل',750,TextInputStyle.Paragraph));
        await i.showModal(modal);
      } else if (action==='form' && i.isModalSubmit() && ui.sections.includes(param)) {
        if (i.message.id!==db.panelMessage()) throw new RuleError('استخدم لوحة التذاكر الأحدث.',403);
        await i.deferReply(privateReply);
        const ticket=await community.openTicket(i.user.id,'ticket-form:'+i.id,i.fields.getTextInputValue('subject'),param,i.fields.getTextInputValue('details'));
        if (!ticket.channel) throw new RuleError('التذكرة ما زالت قيد التجهيز.',409);
        await i.editReply({content:ticket.kind===param?`تذكرتك: <#${ticket.channel}>`:`عندك تذكرة مفتوحة بالفعل: <#${ticket.channel}>. ما فتحنا تذكرة جديدة.`,allowedMentions:noMentions});
      } else if (i.isButton() && ['claim','unclaim','close','delete'].includes(action)) {
        const ticket=ticketFor(i.channelId,param);
        if (action==='delete' && (requestedBy!==i.user.id || !/^\d{13}$/u.test(until) || Date.now()>Number(until))) {
          throw new RuleError('انتهت مهلة الحذف أو الزر ليس لك. استخدم `+delete` من جديد.',403);
        }
        await i.deferReply(privateReply);
        if (action==='delete') {
          await community.manageTicket(i.user.id,ticket.id,'delete');
          // The originating channel no longer exists. Discord may reject edits to its interaction response.
          await i.editReply({content:'حُذفت التذكرة.',allowedMentions:noMentions}).catch(()=>{});
        } else {
          const updated=await community.ticketAction(i.user.id,ticket.id,action,{noticeId:action==='claim'?i.id:undefined});
          const content=action==='close'?'🔒 أُغلقت التذكرة بدون حذفها.':action==='unclaim'?'تم سحب الاستلام. التذكرة متاحة للطاقم المخوّل.':
            updated.noticeFailed?'تم استلام التذكرة، لكن تعذّر تأكيد إرسال إشعار الاستلام.':'تم استلام التذكرة.';
          await i.editReply({content,allowedMentions:noMentions,...(action==='claim'?{components:ui.release(ticket.id)}:{})});
        }
      } else throw new RuleError('إجراء التذكرة غير صالح.');
    } catch(err) {
      if(i.deferred || i.replied) await i.editReply({content:describe(err),allowedMentions:noMentions}).catch(()=>{});
      else await say(describe(err)).catch(()=>{});
    }
    return true;
  }
  return {syncPanel,text,interaction};
}

module.exports={createDiscordTickets};
