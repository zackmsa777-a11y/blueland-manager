'use strict';

const {catalog,RuleError}=require('./ladder');
const {requestCodex}=require('./codex-worker-client');
const {applyAction,inspectActions,operations,destructive}=require('./codex-actions');
const {commands,chatAliases}=require('./commands');
const {runFeature}=require('./codex-feature');
const vps=require('./codex-vps');
const {activity}=require('./codex-progress');

const normalCommands=new Set(['ترقية','تخفيض','لوحة',...Object.keys(chatAliases),...Object.values(chatAliases),...commands.map(c=>c.name)]);
const allowedMentions={parse:[],repliedUser:false};

function createCodexHandler({store,isAdmin,ask=requestCodex,workspace=a=>requestCodex(a,'/run/blueland-workspace.sock'),run}) {
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
    const vpsCommand=name==='vps';
    const direct=modelCommand||vpsCommand||name==='memory'||name==='code';
    const recipe=name?store.feature(name):null;
    if (!direct&&!recipe&&!mentioned&&replyRef&&message.mentions?.repliedUser&&message.mentions.repliedUser.id!==me) return false;
    if (!mentioned&&!replyRef&&!direct&&!recipe) return false;
    const reply=content=>message.reply({content,allowedMentions});
    let acquired=false, recorded=false, progress;
    try {
      if (!await isAdmin(actor)) return true;
      let previous;
      if (replyRef && (!message.mentions?.repliedUser || message.mentions.repliedUser.id===me)) {
        const parent=await message.fetchReference().catch(()=>null);
        if (parent?.author.id===me && !parent.webhookId && parent.guildId===catalog.guildId && parent.channelId===channel) previous=parent;
      }
      if (!mentioned&&!previous&&!direct&&!recipe) return false;
      if (!store.begin(message.id,actor)) return true;
      recorded=true;
      if (busy.has(actor)||busy.size>=4) throw new RuleError('هناك طلب Codex قيد التنفيذ. حاول بعد انتهائه.');
      busy.add(actor); acquired=true;
      const input=text.replace(mention,'').trim();
      if (name==='memory') {
        const raw=(typed[2]||'list').trim();
        if (raw==='list') {
          const rows=store.notes(actor);
          if (rows.length) {
            let part='';
            for (const row of rows) {
              const line='#'+row.id+' '+row.note+'\n';
              if ((part+line).length>1800) {await message.author.send({content:part,allowedMentions});part='';}
              part+=line;
            }
            if (part) await message.author.send({content:part,allowedMentions});
          }
          await reply(rows.length?'أرسلت ملاحظاتك في الخاص.':'ما عندك ملاحظات محفوظة.');
        } else if (raw.startsWith('save ')) await reply('حُفظت ملاحظتك #'+store.note(actor,raw.slice(5))+'.');
        else if (/^forget \d+$/.test(raw)) await reply(store.forgetNote(actor,Number(raw.slice(7)))?'حُذفت الملاحظة.':'لم أجد الملاحظة.');
        else throw new RuleError('+memory save TEXT | +memory list | +memory forget ID');
        store.finish(message.id,'done');return true;
      }
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
      let finalText='';
      if (vpsCommand) {
        const parts=(typed[2]||'status').trim().split(/\s+/);
        if (parts[0]==='status'&&parts.length===1) actions=[{op:'vps_status',target:'',value:'',extra:''}];
        else if (parts[0]==='restart'&&parts.length===2) actions=[{op:'vps_restart',target:parts[1],value:'',extra:''}];
        else throw new RuleError('+vps status | +vps restart bot | +vps restart dashboard');
        progress=activity(reply,store.settings());
        await progress.show('Checking services…');
      } else if (previous && /^(?:confirm|تأكيد|تأكيد التنفيذ)$/iu.test(input)) {
        actions=store.consume(previous.id,actor,channel);
        if (!actions) throw new RuleError('لم أجد تأكيدًا صالحًا لك على هذه الرسالة.');
      } else {
        if (!input&&!recipe) { await reply('اكتب طلبك مع المنشن أو بالرد على هذه الرسالة.');store.finish(message.id,'done');return true; }
        await message.channel.sendTyping().catch(()=>{});
        const g=message.guild;
        const request={operation:'respond',...store.settings(),prompt:recipe||name==='code'?(typed[2]||''):input,
          memoryNotes:store.notes(actor),
          command:name||null,instruction:recipe||null,previous:previous?.content?.slice(0,1500)||null,
          context:{guild:g.name,memberCount:g.memberCount,roleCount:g.roles.cache.size,channelCount:g.channels.cache.size,actor,channel,commands:store.features(),operations,
            rooms:[...g.channels.cache.values()].filter(c=>!c.isThread()).slice(0,500).map(c=>[c.id,c.name]),
            roles:[...g.roles.cache.values()].slice(0,250).map(r=>[r.id,r.name])}};
        const source=recipe?store.source(name):null;
        progress=activity(reply,store.settings());
        if (source) await progress.show('Running +'+name+'…'); else await progress.start();
        let result=source?await runFeature(source,{args:request.prompt,...request.context}):await ask(request);
        const observations=[];
        for (let round=0;inspectActions(result.actions).some(a=>a.op.startsWith('workspace_'));round++) {
          if (round>=8||observations.length+result.actions.length>24) throw new RuleError('وصلت إلى حد خطوات الطلب. اطلب المتابعة لاستكمال العمل.');
          if (!result.actions.every(a=>a.op.startsWith('workspace_'))) throw new RuleError('قسّم تعديل المشروع وإجراءات ديسكورد إلى طلبين.');
          for (const a of result.actions) {
            if (!await isAdmin(actor)) throw new RuleError('تغيّرت صلاحية الوصول.');
            const op=a.op.slice('workspace_'.length);
            await progress.show(op+' '+a.target.slice(0,100)+'…');
            const outcome=await workspace({op,target:a.target,value:a.value,extra:a.extra});
            if (outcome.edited) progress.file(outcome.edited);
            if (outcome.ran) progress.command();
            observations.push({op,target:a.target,...outcome,text:String(outcome.text).slice(-4800)});
          }
          if (!await isAdmin(actor)) throw new RuleError('تغيّرت صلاحية الوصول.');
          await progress.show('Thinking…');
          result=await ask({...request,workspaceResults:observations.slice(-10)});
        }
        if (!await isAdmin(actor)) {store.finish(message.id,'permission-revoked');await progress.show('Access changed');return true;}
        actions=inspectActions(result.actions);
        finalText=String(result.answer||'').trim();
        if (!actions.length) {
          const answer=String(result.answer||'وضّح الطلب.').trim();
          await progress.finish();
          for (let i=0;i<Math.min(answer.length,7800);i+=1900) await reply(answer.slice(i,i+1900));
          store.finish(message.id,'done');return true;
        }
        if (actions.some(a=>destructive.has(a.op))) {
          const detail=actions.map(a=>[a.op,a.target,a.value,a.extra].filter(Boolean).join(' · ')).join('\n');
          if (detail.length>1750) throw new RuleError('قسّم الطلب حتى تظهر كل الإجراءات قبل التأكيد.');
          await progress.show('Awaiting confirmation');
          const sent=await reply(detail+'\n\nردّ على هذه الرسالة بـ تأكيد خلال خمس دقائق لتنفيذ القائمة.');
          store.remember(sent.id,actor,channel,actions);
          store.finish(message.id,'awaiting-confirmation');return true;
        }
      }
      const completed=[];
      if (actions.some(a=>a.op==='vps_restart')&&actions.length!==1) throw new RuleError('اطلب إعادة تشغيل خدمة واحدة في رسالة منفصلة.');
      for (const [index,a] of inspectActions(actions).entries()) {
        try {
          if (!await isAdmin(actor)) {store.finish(message.id,'permission-revoked');await progress?.show('Access changed');return true;}
          if (a.op==='note_save') {completed.push('حُفظت ملاحظة #'+store.note(actor,a.value)+'.');continue;}
          if (a.op==='note_forget') {completed.push(store.forgetNote(actor,Number(a.target))?'حُذفت الملاحظة.':'لم أجد الملاحظة.');continue;}
          await progress?.show('Running '+a.op+'…');
          if (a.op==='vps_status') {completed.push(await vps.status(()=>progress?.command()));continue;}
          if (a.op==='vps_restart') {
            const unit=vps.restartUnit(a.target);
            await progress?.show('Requesting service restart');
            await reply('طلب إعادة تشغيل '+unit);
            store.finish(message.id,'restart-requested');
            await vps.restart(a.target);
            return true;
          }
          const result=await applyAction(a,{guild:message.guild,actor,channel,delivery:'codex:'+message.id+':'+index,run,store});
          if (!['save_command','forget_command'].includes(a.op)) progress?.action();
          completed.push(String(result).slice(0,450));
        } catch (err) {
          completed.push('تعذّر تنفيذ '+a.op+' · '+(err instanceof RuleError?err.message:'راجع الهدف وصلاحيات البوت.'));
          store.finish(message.id,'stopped-at-'+index);
          await progress?.show('Stopped');
          await reply(completed.join('\n').slice(-1950));return true;
        }
      }
      store.finish(message.id,'done');
      await progress?.finish();
      if (finalText&&actions.every(a=>a.op==='note_save'||a.op==='note_forget')) completed.unshift(finalText);
      await reply(completed.join('\n').slice(0,1950));return true;
    } catch (error) {
      if (recorded) store.finish(message.id,'failed');
      await progress?.show('Stopped');
      // A permission lookup failure must not cause a response to an unverified author.
      if (recorded) await reply(error instanceof RuleError?error.message:'تعذّر إكمال طلب Codex.').catch(()=>{});
      return true;
    } finally { if (acquired) busy.delete(actor); }
  };
}
module.exports={createCodexHandler};
