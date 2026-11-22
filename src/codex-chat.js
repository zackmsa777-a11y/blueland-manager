'use strict';

const {catalog,RuleError}=require('./ladder');
const {requestCodex}=require('./codex-worker-client');
const {applyAction,inspectActions,operations,destructive}=require('./codex-actions');
const {commands,chatAliases}=require('./commands');

const normalCommands=new Set(['ترقية','تخفيض','لوحة',...Object.keys(chatAliases),...Object.values(chatAliases),...commands.map(c=>c.name)]);
const allowedMentions={parse:[],repliedUser:false};

function createCodexHandler({store,isAdmin,ask=requestCodex,run}) {
  const busy=new Set();
  return async function handle(message) {
    if (message.guildId!==catalog.guildId || message.author.bot || message.webhookId || message.system) return false;
    const text=message.content.trim(), actor=message.author.id, channel=message.channelId;
    const me=message.client.user.id;
    const mention=new RegExp('<@!?'+me+'>','g');
    const mentioned=text.includes('<@'+me+'>')||text.includes('<@!'+me+'>');
    const ref=message.reference;
    const replyRef=ref?.messageId && ref.channelId===channel && (!ref.guildId||ref.guildId===catalog.guildId) && (!ref.type||ref.type===0);
    const typed=text.match(/^\+([^\s]+)(?:\s+([\s\S]*))?$/u);
    const name=typed?.[1].normalize('NFC').toLowerCase();
    if (normalCommands.has(name)) return false;
    const modelCommand=name==='model'||name==='موديل';
    const recipe=name?store.feature(name):null;
    if (!modelCommand&&!recipe&&!mentioned&&replyRef&&message.mentions?.repliedUser&&message.mentions.repliedUser.id!==me) return false;
    if (!mentioned&&!replyRef&&!modelCommand&&!recipe) return false;
    const reply=content=>message.reply({content,allowedMentions});
    let acquired=false, recorded=false;
    try {
      if (!await isAdmin(actor)) return true;
      let previous;
      if (replyRef && (!message.mentions?.repliedUser || message.mentions.repliedUser.id===me)) {
        const parent=await message.fetchReference().catch(()=>null);
        if (parent?.author.id===me && !parent.webhookId && parent.guildId===catalog.guildId && parent.channelId===channel) previous=parent;
      }
      if (!mentioned&&!previous&&!modelCommand&&!recipe) return false;
      if (!store.begin(message.id,actor)) return true;
      recorded=true;
      if (busy.has(actor)||busy.size>=4) throw new RuleError('هناك طلب Codex قيد التنفيذ. حاول بعد انتهائه.');
      busy.add(actor); acquired=true;
      const input=text.replace(mention,'').trim();
      if (modelCommand) {
        const parts=(typed[2]||'').trim().split(/\s+/).filter(Boolean);
        const current=store.settings();
        if (!parts.length) {
          await reply('Codex: '+current.model+' · '+current.effort+'\n+model list\n+model gpt-6.2-sol high');
        } else {
          const models=await ask({operation:'models'});
          if (parts[0]==='list') await reply(models.map(m=>m.id+' · '+m.efforts.join(', ')).join('\n').slice(0,1950));
          else {
            const [model,effort=current.effort]=parts;
            if (parts.length>2 || !models.some(m=>m.id===model&&m.efforts.includes(effort))) throw new RuleError('هذا الموديل أو مستوى التفكير غير متاح. اعرض +model list.');
            if (!await isAdmin(actor)) throw new RuleError('تغيّرت صلاحياتك.');
            store.configure(model,effort);
            await reply('Codex: '+model+' · '+effort);
          }
        }
        store.finish(message.id,'done'); return true;
      }
      let actions;
      if (previous && /^(?:confirm|تأكيد|تأكيد التنفيذ)$/iu.test(input)) {
        actions=store.consume(previous.id,actor,channel);
        if (!actions) throw new RuleError('لم أجد تأكيدًا صالحًا لك على هذه الرسالة.');
      } else {
        if (!input&&!recipe) { await reply('اكتب طلبك مع المنشن أو بالرد على هذه الرسالة.');store.finish(message.id,'done');return true; }
        await message.channel.sendTyping().catch(()=>{});
        const g=message.guild;
        const result=await ask({operation:'respond',...store.settings(),prompt:recipe?(typed[2]||''):input,
          command:name||null,instruction:recipe||null,previous:previous?.content?.slice(0,1500)||null,
          context:{guild:g.name,actor,channel,commands:store.features(),operations,
            rooms:[...g.channels.cache.values()].filter(c=>!c.isThread()).slice(0,500).map(c=>[c.id,c.name]),
            roles:[...g.roles.cache.values()].slice(0,250).map(r=>[r.id,r.name])}});
        if (!await isAdmin(actor)) {store.finish(message.id,'permission-revoked');return true;}
        actions=inspectActions(result.actions);
        if (!actions.length) {
          const answer=String(result.answer||'وضّح الطلب.').trim();
          for (let i=0;i<Math.min(answer.length,7800);i+=1900) await reply(answer.slice(i,i+1900));
          store.finish(message.id,'done');return true;
        }
        if (actions.some(a=>destructive.has(a.op))) {
          const detail=actions.map(a=>[a.op,a.target,a.value,a.extra].filter(Boolean).join(' · ')).join('\n');
          if (detail.length>1750) throw new RuleError('قسّم الطلب حتى تظهر كل الإجراءات قبل التأكيد.');
          const sent=await reply(detail+'\n\nردّ على هذه الرسالة بـ تأكيد خلال خمس دقائق لتنفيذ القائمة.');
          store.remember(sent.id,actor,channel,actions);
          store.finish(message.id,'awaiting-confirmation');return true;
        }
      }
      const completed=[];
      for (const [index,a] of inspectActions(actions).entries()) {
        try {
          if (!await isAdmin(actor)) {store.finish(message.id,'permission-revoked');return true;}
          const result=await applyAction(a,{guild:message.guild,actor,channel,delivery:'codex:'+message.id+':'+index,run,store});
          completed.push(String(result).slice(0,450));
        } catch (err) {
          completed.push('تعذّر تنفيذ '+a.op+' · '+(err instanceof RuleError?err.message:'راجع الهدف وصلاحيات البوت.'));
          store.finish(message.id,'stopped-at-'+index);
          await reply(completed.join('\n').slice(-1950));return true;
        }
      }
      store.finish(message.id,'done');
      await reply(completed.join('\n').slice(0,1950));return true;
    } catch (error) {
      if (recorded) store.finish(message.id,'failed');
      // A permission lookup failure must not cause a response to an unverified author.
      if (recorded) await reply(error instanceof RuleError?error.message:'تعذّر إكمال طلب Codex.').catch(()=>{});
      return true;
    } finally { if (acquired) busy.delete(actor); }
  };
}
module.exports={createCodexHandler};
