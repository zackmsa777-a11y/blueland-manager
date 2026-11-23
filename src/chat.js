'use strict';

const { catalog, roles, RuleError, parsePromotion } = require('./ladder');

function createMessageHandler({ authorize, service, store, publicOrigin, run, parse, shortcuts }) {
  return async function onMessage(message) {
    if (message.author.bot || message.webhookId) return;
    const inGuild=message.inGuild();
    if (inGuild && message.guildId!==catalog.guildId) return;
    const text = message.content?.trim() || '';
    const reply = content => message.reply({content, allowedMentions:{parse:[], repliedUser:false}});
    try {
      if (!inGuild) {
        if (run && ['+بنق','+ping','+مساعدة','+help'].includes(text)) await reply(await run({action:parse(text).action,actor:message.author.id}));
        return;
      }
      if (!text.startsWith('+')) {
        if (shortcuts && await shortcuts(message,text)) return;
        if (text && store.community?.settings().levels) store.community.addXp(message.author.id,message.createdTimestamp);
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
