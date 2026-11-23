'use strict';

const {RuleError} = require('./ladder');
const {canDemote} = require('./promotions');
const {parseShortcut} = require('./custom-shortcuts');

function createShortcutHandler({shortcuts, context, readyGuild, service, community, lookupTicket, run, games}) {
  async function preflight(spec,actor,channel) {
    if(spec.cat==='mod') return community.checkModeration(actor,spec.action);
    if(spec.action==='promote'||spec.action==='demote') {
      const ctx=await context(actor); service.checkOperator(ctx);
      if(spec.action==='demote'&&!canDemote(ctx))throw new RuleError('غير مخوّل.',403);
    } else if(spec.action==='bulk-role') {
      if(readyGuild().ownerId!==actor)throw new RuleError('غير مخوّل.',403);
    } else if(spec.action==='dashboard') await community.dashboard(actor);
    else if(spec.action==='request'&&['pending','approve','reject'].includes(spec.sub)) await community.reviewer(actor);
    else if(spec.action==='ticket'&&spec.sub!=='create') {
      if(spec.sub!=='close'||lookupTicket(channel)?.owner!==actor) await community.support(actor);
    }
  }
  return async function handle(message,text) {
    const hit=shortcuts.match(text);
    if(!hit)return false;
    const {spec}=hit;
    const actor=message.author.id, channel=message.channelId;
    const allowedMentions={parse:[],repliedUser:false};
    const reply=content=>message.reply({content,allowedMentions});
    // The actor check never uses arguments. Unauthorized authors get no usage or error reply.
    try {await preflight(spec,actor,channel);} catch {return true;}
    try {
      const input=parseShortcut(hit);
      if(spec.action==='game'){await games.openShortcut(message,spec.sub);return true;}
      const output=await run({...input,actor,channel,delivery:'discord:'+message.id,created:message.createdTimestamp});
      if(['dashboard','warnings','request','ticket','rank','top'].includes(spec.action)) {
        try {await message.author.send({content:output,allowedMentions});}
        catch {await reply('افتح الخاص أو استخدم أمر السلاش الأصلي للحصول على رد خاص.');return true;}
        await reply('بعتلك النتيجة في الخاص.');
      } else await reply(output);
    } catch(err) {
      if(err instanceof RuleError&&err.status===403)return true;
      await reply(err instanceof RuleError?err.message:'تعذّر إتمام الأمر. راجع السجل قبل ما تجرّب تاني.').catch(()=>{});
    }
    return true;
  };
}
module.exports={createShortcutHandler};
