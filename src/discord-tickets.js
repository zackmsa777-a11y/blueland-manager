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
      const id=db.panelMessage();
      if (id && belongs(await get(id))) return id;
      const recent=await channel.messages.fetch({limit:50,cache:false});
      const existing=recent.find(belongs);
      if (existing) { db.savePanelMessage(existing.id); return existing.id; }
      const posted=await channel.send(ui.panel());
      if (!belongs(await get(posted.id))) throw new RuleError('تعذّر التحقق من نشر لوحة التذاكر.',503);
      db.savePanelMessage(posted.id);
      return posted.id;
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
    if (i.guildId!==catalog.guildId || !(i.isButton() || i.isModalSubmit()) || !i.customId?.startsWith('blticket:')) return false;
    const [,action,param,requestedBy,until]=i.customId.split(':');
    const say=content=>i.reply({...privateReply,content});
    const panelType=action==='choose' || action==='open' || action==='form';
    try {
      if (i.user.bot || (i.isButton() && i.message?.author?.id!==i.client.user.id) || (panelType && i.channelId!==ui.PANEL)) {
        throw new RuleError('استخدم لوحة التذاكر المعتمدة في السيرفر.',403);
      }
      if (action==='choose' && i.isButton()) {
        if (i.message.id!==db.panelMessage()) throw new RuleError('استخدم لوحة التذاكر الأحدث.',403);
        await i.reply({...privateReply,content:'اختر نوع التذكرة:',components:ui.choices()});
      } else if (action==='open' && i.isButton() && Object.hasOwn(ui.kinds,param)) {
        const input=(id,label,max,style)=>new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(true));
        const modal=new ModalBuilder().setCustomId('blticket:form:'+param).setTitle(ui.kinds[param])
          .addComponents(input('subject','الموضوع',120,TextInputStyle.Short),input('details','التفاصيل',750,TextInputStyle.Paragraph));
        await i.showModal(modal);
      } else if (action==='form' && i.isModalSubmit() && Object.hasOwn(ui.kinds,param)) {
        await i.deferReply(privateReply);
        const ticket=await community.openTicket(i.user.id,'ticket-form:'+i.id,i.fields.getTextInputValue('subject'),param,i.fields.getTextInputValue('details'));
        if (!ticket.channel) throw new RuleError('التذكرة ما زالت قيد التجهيز.',409);
        await i.editReply({content:ticket.kind===param?`تذكرتك: <#${ticket.channel}>`:`عندك تذكرة مفتوحة بالفعل: <#${ticket.channel}>. ما فتحنا تذكرة جديدة.`,allowedMentions:noMentions});
      } else if (i.isButton() && ['claim','close','delete'].includes(action)) {
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
          await community.ticketAction(i.user.id,ticket.id,action);
          await i.editReply({content:action==='close'?'🔒 أُغلقت التذكرة بدون حذفها.':'تم استلام التذكرة.',allowedMentions:noMentions});
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
