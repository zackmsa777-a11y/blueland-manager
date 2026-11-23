'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ChannelType,Client,MessagePayload}=require('discord.js');
const {openStore}=require('../src/store');
const {catalog}=require('../src/ladder');
const {createDailyTopReport}=require('../src/activity-report');
const channelId='1574014041377083492';
const member='200000000000000001', posted='200000000000000002';
const t=time=>Date.parse(time+'Z');
function setup(ctx) {
  const store=openStore(':memory:');ctx.after(()=>store.close());
  const db=store.community;
  db.saveSettings({...db.settings(),levels:true});
  let time=t('2026-11-23T23:58:59');
  const messages=new Map(), attempts=[];
  const client=new Client({intents:[]});
  let failVerification=false,failReplySend=false;
  const channel={id:channelId,guildId:catalog.guildId,type:ChannelType.GuildText,
    messages:{resolveId:id=>id,async fetch({message,force,cache}){
      assert.equal(force,true); assert.equal(cache,false);
      const found=[...messages.values()].find(m=>m.id===message);
      if(failVerification && found?.reference) throw Error('read failed');
      return found;
    }},
    async send(options){
      const message=MessagePayload.create({...this,client},options).resolveBody();
      await message.resolveFiles();
      const body=message.body;
      attempts.push(body);
      if(failReplySend && body.message_reference) throw Error('reply failed');
      if(!messages.has(options.nonce)) messages.set(options.nonce,{
        id:String(BigInt(posted)+BigInt(messages.size)),author:{id:catalog.botId},content:body.content,embeds:body.embeds,
        reference:body.message_reference && {messageId:body.message_reference.message_id},
      });
      return messages.get(options.nonce);
    }};
  let fetches=0, flush=0;
  const connect=()=>createDailyTopReport({db,now:()=>time,botId:catalog.botId,
    getChannel:async target=>{assert.equal(target,channelId);fetches++;return channel;},beforeSnapshot:()=>{flush++;}});
  return {db,attempts,messages,channel,connect,at:str=>{time=t(str);},get fetches(){return fetches;}, get flush(){return flush;},
    failRead:b=>{failVerification=b;},failReply:b=>{failReplySend=b;}};
}

test('at 23:59 UTC post the exact command and reply to it with the dated daily leaderboard',async ctx=>{
  const f=setup(ctx), tick=f.connect();
  f.db.addXp(member,t('2026-11-22T21:00:00'));
  f.db.addXp(member,t('2026-11-23T18:00:00'));
  f.db.addVoice(member,t('2026-11-23T22:00:00'),t('2026-11-23T22:06:00'));
  assert.equal(await tick(),null);
  assert.equal(f.fetches,0);
  f.at('2026-11-23T23:59:00');
  assert.equal(await tick(),String(BigInt(posted)+1n));
  assert.equal(f.flush,1);
  assert.equal(f.attempts.length,2);
  const [command,body]=f.attempts, [e]=body.embeds;
  assert.equal(command.content,'توب يومي');
  assert.equal(command.message_reference,undefined);
  assert.deepEqual(body.message_reference,{message_id:posted,fail_if_not_exists:true});
  assert.equal(body.allowed_mentions.replied_user,false);
  assert.match(e.description,/Daily.*Nov 23, 2026/s);
  assert.match(e.fields[0].value,/<@200000000000000001> XP: `10` \(count: 1\)/u);
  assert.match(e.fields[1].value,/XP: `6` \(hours: 0.1\)/u);
  assert.equal(e.image.url,'attachment://activity.png');
  assert.equal(body.allowed_mentions.parse.length,0);
});

test('one command and reply per day survive overlapping ticks and scheduler recreation',async ctx=>{
  const f=setup(ctx), tick=f.connect();
  f.at('2026-11-23T23:59:00');
  await Promise.all([tick(),tick()]);
  f.at('2026-11-23T23:59:30');
  await f.connect()();
  f.at('2026-11-24T00:00:05');
  await tick();
  assert.equal(f.attempts.length,2);
  f.at('2026-11-24T23:59:00');
  await tick();
  assert.equal(f.attempts.length,4);
  assert.equal(new Set(f.attempts.map(m=>m.nonce)).size,4);
});

test('retry after an uncertain reply read uses the same enforced nonce without reposting the command',async ctx=>{
  const f=setup(ctx), tick=f.connect();
  f.at('2026-11-23T23:59:00');
  f.failRead(true);
  await assert.rejects(tick(),/read failed/);
  f.failRead(false);
  f.at('2026-11-23T23:59:15');
  assert.equal(await tick(),String(BigInt(posted)+1n));
  const [command,reply,retry]=f.attempts;
  assert.equal(f.attempts.length,3);
  assert.equal(command.enforce_nonce,true);
  assert.equal(retry.nonce,reply.nonce);
  assert.equal(retry.enforce_nonce,true);
  assert.equal(f.messages.size,2);
});

test('the saved command is reused after a reply send fails and the scheduler is recreated',async ctx=>{
  const f=setup(ctx);
  f.at('2026-11-23T23:59:00');
  f.failReply(true);
  await assert.rejects(f.connect()(),/reply failed/);
  assert.equal(f.messages.size,1);
  f.failReply(false);
  await f.connect()();
  assert.equal(f.attempts.filter(m=>m.content==='توب يومي').length,1);
  assert.deepEqual([...f.messages.values()].at(-1).reference,{messageId:posted});
});
test('a disabled leaderboard or mismatched channel never receives an automatic post',async ctx=>{
  const f=setup(ctx), tick=f.connect();
  f.at('2026-11-23T23:59:00');
  f.db.saveSettings({...f.db.settings(),levels:false});
  assert.equal(await tick(),null);
  f.db.saveSettings({...f.db.settings(),levels:true});
  f.channel.guildId='200000000000000003';
  await assert.rejects(tick(),/channel/i);
  assert.equal(f.attempts.length,0);
});
