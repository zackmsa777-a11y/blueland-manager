'use strict';

const { catalog, roles, RuleError, parsePromotion } = require('./ladder');

function isSalamGreeting(text) {
  const plain=text.normalize('NFKC').replace(/[\p{M}\u0640\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu,'')
    .replace(/[آأإٱ]/g,'ا').replace(/^[*_~]+\s*/u,'').trimStart();
  return /^(?:و\s*)?(?:ال)?سلا+م\s+عليكم(?=$|[\s\p{P}\p{S}])/u.test(plain);
}

const {autoReply,roleAutoReply,salamReply}=require('../config/discord-features.json');
const {createDashImageLoader}=require('./dash-image');

function createMessageHandler({ authorize, service, store, publicOrigin, run, parse, shortcuts, ticketMessages,
  loadDashImage=createDashImageLoader() }) {
  return async function onMessage(message) {
    if (message.author.bot || message.webhookId) return;
    const inGuild=message.inGuild();
    if (inGuild && message.guildId!==catalog.guildId) return;
    const text = message.content?.trim() || '';
    const reply = output => message.reply({...(typeof output==='string'?{content:output}:output),allowedMentions:{parse:[],repliedUser:false}});
    const greeting=salamReply && isSalamGreeting(text);
    const replySalam=()=>reply({content:salamReply,failIfNotExists:true})
      .catch(err=>console.warn('BlueLand salam reply could not send:',err.code || err.name));
    try {
      if (!inGuild) {
        if (greeting) return await replySalam();
        if (run && ['+بنق','+ping','+مساعدة','+help'].includes(text)) await reply(await run({action:parse(text).action,actor:message.author.id}));
        return;
      }
      // A fixed greeting in a ticket or its thread does not reach the assistant or earn XP.
      if (greeting && [message.channelId,message.channel?.parentId].some(id=>id && store.community?.ticketByChannel?.(id)))
        return await replySalam();
      if (run && parse && /^\+\s*(?:نقاطي|نقاط|points)(?:\s|$)/u.test(text)) {
        const answer=await run({...parse(text),actor:message.author.id});
        try { await message.author.send({content:answer,allowedMentions:{parse:[]}}); }
        catch { throw new RuleError('استخدم /نقاطي لعرض رصيدك برد خاص، أو افتح الرسائل الخاصة.'); }
        await reply('أرسلت لك نقاط التذاكر في الخاص.');
        return;
      }
      if (ticketMessages && await ticketMessages(message,text)) return;
      if (run && parse && /^\+?(?:توب|top)(?:\s|$)/iu.test(text)) {
        const top=parse(text);
        if (top?.action==='top') {
          await reply(await run({...top,actor:message.author.id,channel:message.channelId,delivery:'discord:'+message.id,created:message.createdTimestamp}));
          return;
        }
      }
      if (roleAutoReply?.trigger === text) {
        const member = await message.guild.members.fetch({user:message.author.id, force:true, cache:false}).catch(()=>null);
        if (member?.roles.cache.has(roleAutoReply.roleId)) {
          await message.channel.send({content:roleAutoReply.content, allowedMentions:{parse:[]}})
            .catch(err=>console.warn('BlueLand role auto-reply could not send:',err.code || err.name));
        }
        return;
      }
      if (autoReply?.trigger === text && !message.attachments?.size && !message.stickers?.size) {
        const trusted=autoReply.authors.includes(message.author.id);
        const member=trusted?null:await message.guild?.members.fetch({user:message.author.id,force:true,cache:false}).catch(()=>null);
        if (trusted || member?.roles.cache.has(autoReply.roleId)) {
          try {
            const file=await loadDashImage(message.client);
            const posted=await message.channel.send({files:[file],allowedMentions:{parse:[]}});
            const confirmed=await message.channel.messages.fetch({message:posted.id,force:true,cache:false});
            if (confirmed?.id===posted.id && [...(confirmed.attachments?.values() || [])].some(a=>a.name===file.name && a.size===file.attachment.length)) {
              await message.delete();
            }
          } catch (err) {
            console.warn('BlueLand auto-reply could not finish:',err.code || err.name);
          }
          return;
        }
      }
      if (!text.startsWith('+')) {
        if (shortcuts && await shortcuts(message,text)) return;
        if ((text || message.attachments?.size || message.stickers?.size) && store.community?.settings().levels)
          store.community.addXp(message.author.id,message.createdTimestamp,Boolean(text));
        if (greeting) await replySalam();
        return;
      }
      if (text === '+لوحة') {
        await authorize(message.author.id);
        const code = store.loginCode(message.author.id);
        try {
          const destination = publicOrigin ? '\n' + publicOrigin : '';
          await message.author.send('رمز دخول لوحة BlueLand صالح لخمس دقائق ويُستخدم مرة واحدة.\n' + code + destination);
        } catch {
          throw new RuleError('افتح الرسائل الخاصة من أعضاء السيرفر ثم اكتب +لوحة مرة أخرى.');
        }
        await reply('أرسلت لك رمز دخول اللوحة في الخاص.');
        return;
      }
      const promotion = parsePromotion(text);
      if (!promotion) {
        if (run) {
          const command=parse(text);
          if (command) {
            const answer=await run({...command,actor:message.author.id,channel:message.channelId,delivery:'discord:'+message.id,created:message.createdTimestamp});
            if (command.action==='warnings') {
              try { await message.author.send({content:answer,allowedMentions:{parse:[]}}); }
              catch { throw new RuleError('استخدم /warnings لعرض السجل برد خاص أو افتح الرسائل الخاصة.'); }
              await reply('أرسلت سجل التحذيرات في الخاص.');
            } else await reply(answer);
          }
        }
        return;
      }
      const { target, count } = promotion;
      const result = await service.execute({ id:'discord:' + message.id, actor:message.author.id, target, count, source:'discord' });
      const old = roles.get(result.plan.from)?.label || 'خارج السلّم';
      const next = roles.get(result.plan.to).label;
      const total = result.plan.count > 1 ? ' (عدد الدرجات: **' + result.plan.count + '**)' : '';
      await reply('تمت ترقية <@' + target + '> من **' + old + '** إلى **' + next + '**' + total + '.');
    } catch (err) {
      const text = err instanceof RuleError ? err.message : 'تعذّر تأكيد العملية الآن. راجع سجلها في لوحة الطاقم قبل إعادة الأمر.';
      await reply(text).catch(() => {});
    }
  };
}
module.exports = { createMessageHandler };
