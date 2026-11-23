'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/store');
const {catalog}=require('../src/ladder');
const {commands,parseChat,commandRunner,interactionInput,registerCommands}=require('../src/commands');
const {createMessageHandler}=require('../src/chat');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const id=n=>String(200000000000000000n+BigInt(n));
const t=s=>Date.parse(s+'Z');
const now=t('2026-11-23T18:00:00');
function setup(testContext){
  const store=openStore(':memory:');testContext.after(()=>store.close());
  store.community.saveSettings({...store.community.settings(),levels:true});
  return {store,db:store.community,run:commandRunner({store,now:()=>now})};
}

test('Arabic bare and +top commands recognize only complete leaderboard variants',()=>{
  assert.deepEqual(parseChat('توب'),{action:'top',period:'all',mode:'both'});
  assert.deepEqual(parseChat('توب يومي'),{action:'top',period:'day',mode:'both'});
  assert.deepEqual(parseChat('توب اسبوعي'),{action:'top',period:'week',mode:'both'});
  assert.deepEqual(parseChat('توب شهري'),{action:'top',period:'month',mode:'both'});
  assert.deepEqual(parseChat('توب كتابي يومي'),{action:'top',period:'day',mode:'text'});
  assert.deepEqual(parseChat('توب فويس'),{action:'top',period:'all',mode:'voice'});
  assert.deepEqual(parseChat('+توب أسبوعي فويس'),{action:'top',period:'week',mode:'voice'});
  assert.deepEqual(parseChat('+top month voice'),{action:'top',period:'month',mode:'voice'});
  assert.equal(parseChat('توب اليوم احسن من امبارح'),null);
  assert.equal(parseChat('توب فويس كتابي'),null);
});

test('the real chat handler replies once with an English Embed and keeps normal chat XP',async ctx=>{
  const {store,db,run}=setup(ctx);
  const replies=[];
  const handler=createMessageHandler({store,run,parse:parseChat});
  const send=(content,guildId=catalog.guildId,agent=false)=>handler({content,guildId,inGuild:()=>true,createdTimestamp:now,channelId:id(21),id:id(22),author:{id:id(1),bot:agent},reply:async p=>replies.push(p)});
  await send('كيف حالكم؟');
  await send('توب كتابي يومي');
  await send('توب',id(99));
  await send('توب',catalog.guildId,true);
  assert.equal(db.xp(id(1)),10);
  assert.equal(replies.length,1);
  assert.deepEqual(replies[0].allowedMentions,{parse:[],repliedUser:false});
  const embed=replies[0].embeds[0];
  assert.equal(embed.title,'Guild Score Leaderboards');
  assert.match(embed.description,/Daily.*Resets/s);
  assert.deepEqual(embed.fields.map(f=>f.name),['💬 TOP 10 TEXT']);
  assert.match(embed.fields[0].value,/(count: 1)/);
  assert.doesNotMatch(JSON.stringify(embed),/\p{Script=Arabic}/u);
  assert.ok(!replies[0].files);
});

test('top shows only five entries per category with a renderable activity PNG',async ctx=>{
  const {db,run}=setup(ctx);
  for(let i=1;i<=12;i++) {
    db.addXp(id(i),now-1000*i);
    db.addVoice(id(i),now-60_000*i,now);
  }
  const full=await run({action:'top',period:'all'});
  const embed=full.embeds[0];
  assert.deepEqual(embed.fields.map(f=>f.name),['💬 TOP 5 TEXT','🎙️ TOP 5 VOICE']);
  for(const section of embed.fields) assert.equal(section.value.split('\n').filter(l=>l.startsWith('#')).length,5);
  assert.match(embed.fields[1].value,/(hours: 0.2)/);
  assert.equal(embed.image.url,'attachment://activity.png');
  assert.equal(full.files[0].name,'activity.png');
  assert.equal(full.files[0].attachment.subarray(1,4).toString(),'PNG');
  const voice=await run({action:'top',mode:'voice'});
  assert.deepEqual(voice.embeds[0].fields.map(f=>f.name),['🎙️ TOP 10 VOICE']);
  assert.equal(voice.embeds[0].fields[0].value.split('\n').length,10);
  assert.ok(!voice.files);
});

test('daily count differs from XP cooldown, and weekly/monthly boundaries are calendar UTC',ctx=>{
  const {db}=setup(ctx);
  const member=id(1);
  db.addXp(member,t('2026-10-31T23:59:00'));
  db.addXp(member,t('2026-11-22T23:59:59'));
  db.addXp(member,t('2026-11-23T00:00:00'));
  db.addXp(member,t('2026-11-23T00:01:00'));
  db.addVoice(member,t('2026-11-22T23:59:30'),t('2026-11-23T00:00:30'));
  const range=period=>db.activityTop({period,mode:'both',now});
  assert.equal(db.xp(member),30);
  assert.deepEqual(range('day').text,[{member,xp:10,count:2}]);
  assert.deepEqual(range('week').text,range('day').text);
  assert.deepEqual(range('month').text,[{member,xp:20,count:3}]);
  assert.deepEqual(range('all').text,[{member,xp:30,count:4}]);
  assert.equal(range('week').voice[0].ms,30_000);
  assert.equal(range('month').voice[0].ms,60_000);
  assert.deepEqual(range('day').chart.map(row=>row.count),[0,0,0,0,0,1,2]);
});

test('slash top supports optional period and mode without changing the default',async ctx=>{
  const {run}=setup(ctx);
  const stored=[];
  const client={user:{id:id(20)},rest:{get:async()=>stored,post:async(_,request)=>stored.push(request.body)}};
  const defs=commands.filter(c=>['top','توب'].includes(c.name));
  assert.equal(await registerCommands(client,catalog.guildId,defs),2);
  assert.deepEqual(stored[0].options.map(o=>[o.name,o.required]),[['period',false],['mode',false]]);
  const opts={getSubcommand:()=>null,getUser:()=>null,getInteger:()=>null,getString:key=>({mode:'voice',period:'month'})[key]??null};
  const output=await run(interactionInput({commandName:'توب',options:opts,user:{id:id(1)}}));
  assert.match(output.embeds[0].description,/Monthly/);
  assert.deepEqual(output.embeds[0].fields.map(f=>f.name),['🎙️ TOP 10 VOICE']);
});

test('voice observations accrue known time only, exclude bots and AFK, and stop at disconnect',ctx=>{
  const {db}=setup(ctx);
  const {createVoiceActivity}=require('../src/activity-top');
  let clock=now-60_000;
  const tracker=createVoiceActivity(db,()=>clock);
  const guild={id:catalog.guildId,afkChannelId:id(5),voiceStates:{cache:new Map()}};
  const state=(n,channel,bot=false)=>({id:id(n),guild,channelId:channel,member:{user:{bot}}});
  const listener=state(1,id(4));
  const other={...state(4,id(4)),guild:{id:id(99)}};
  guild.voiceStates.cache.set(id(1),listener);
  guild.voiceStates.cache.set(id(2),state(2,id(4),true));
  guild.voiceStates.cache.set(id(3),state(3,id(5)));
  tracker.checkpoint(guild);
  tracker.update(other);
  clock+=30_000;tracker.checkpoint(guild);
  clock+=15_000;tracker.update(state(1,null));guild.voiceStates.cache.delete(id(1));
  tracker.reset();
  clock+=15_000;tracker.checkpoint(guild);
  assert.deepEqual(db.activityTop({period:'day',mode:'voice',now}).voice,[{member:id(1),ms:45_000}]);
});

test('an existing database keeps lifetime XP and persists only newly measured message and voice counts',ctx=>{
  const dir=mkdtempSync(join(tmpdir(),'bl-activity-'));
  ctx.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=join(dir,'test.sqlite');
  const sqlite=new DatabaseSync(filename);
  sqlite.exec('CREATE TABLE server_xp(member TEXT PRIMARY KEY,xp INTEGER NOT NULL,last INTEGER NOT NULL)');
  sqlite.prepare('INSERT INTO server_xp VALUES(?,?,?)').run(id(1),430,now-120_000);
  sqlite.close();
  const initial=openStore(filename);
  try {
    assert.deepEqual(initial.community.activityTop({period:'all',now}).text,[{member:id(1),xp:430,count:0}]);
    assert.deepEqual(initial.community.activityTop({period:'day',now}).text,[]);
    initial.community.addXp(id(1),now-60_000);
    initial.community.addXp(id(1),now-30_000,false);
    initial.community.addVoice(id(1),now-120_000,now);
  } finally { initial.close(); }
  const reopened=openStore(filename);
  try {
    assert.deepEqual(reopened.community.activityTop({period:'day',now}).text,[{member:id(1),xp:10,count:2}]);
    assert.equal(reopened.community.xp(id(1)),440);
    assert.equal(reopened.community.activityTop({period:'all',now}).voice[0].ms,120_000);
  } finally { reopened.close(); }
});
