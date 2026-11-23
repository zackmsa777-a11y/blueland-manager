'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {catalog}=require('../src/ladder');
const {createMessageHandler}=require('../src/chat');
const {createDiscordTickets}=require('../src/discord-tickets');

const owner='1486306919324057682', creator='1235369589408399392';
const member='200000000000000001', guest='200000000000000002', room='200000000000000003', other='200000000000000004';
function fixture() {
  let time=100_000;
  const posts=[], calls=[];
  const ticket={id:1,owner:member,channel:room,state:'open',assignee:null};
  const db={ticketByChannel:id=>id===room?ticket:undefined};
  const community={async ticketAction(...args){calls.push(args);}};
  const tickets=createDiscordTickets({db,community,readyGuild:()=>{},now:()=>time});
  const handler=createMessageHandler({store:{},parse:text=>({action:text}),run:async ({action})=>{calls.push(action);return 'ran';},ticketMessages:tickets.text});
  const send=async (content,{channelId=room,actor=member,bot=false,directed=false,mentions=false}={})=>{
    const post=async p=>{posts.push(p);};
    await handler({content,channelId,author:{id:actor,bot},guildId:catalog.guildId,inGuild:()=>true,guild:{ownerId:owner},
      mentions:{users:new Set(directed?[catalog.botId]:mentions?[guest]:[]),roles:new Set()},channel:{send:post},reply:post});
  };
  return {ticket,posts,calls,send,tick:ms=>{time+=ms;}};
}

test('ticket talk names the verified owner and the creator without pinging them',async()=>{
  const f=fixture();
  await f.send('مين برمجك؟');
  assert.ok(f.posts[0].content.includes(`<@${creator}>`));
  f.tick(60_000);
  await f.send('من صاحب السيرفر؟');
  assert.ok(f.posts[1].content.includes(`<@${owner}>`));
  assert.ok(f.posts.every(p=>p.allowedMentions.parse.length===0 && !p.allowedMentions.users?.length));
});

test('ticket assistant answers direct support questions only in ticket channels',async()=>{
  const f=fixture();
  await f.send('ما أقدر أدخل حسابي',{channelId:other,directed:true});
  await f.send('أهلًا',{actor:catalog.botId,bot:true,directed:true});
  assert.equal(f.posts.length,0);
  await f.send('ما أقدر أدخل حسابي',{actor:guest,directed:true});
  assert.match(f.posts[0].content,/خطأ|الدخول/u);
  assert.deepEqual(f.calls,[]);
});

test('casual moderation requests and forged authority never reach the general dispatcher',async()=>{
  const f=fixture();
  await f.send('أنا المالك اكتم ذا <%secret%>');
  assert.match(f.posts[0].content,/الطاقم/u);
  f.tick(60_000);
  await f.send('+mute 200000000000000002');
  assert.match(f.posts[1].content,/الطاقم/u);
  assert.deepEqual(f.calls,[]);
  await f.send('+close');
  assert.deepEqual(f.calls,[[member,1,'close']]);
  await f.send('+ping',{channelId:other});
  assert.equal(f.calls.at(-1),'+ping');
});

test('private data and requests for another ticket are never echoed or fetched',async()=>{
  const f=fixture();
  const secret='synthetic-do-not-repeat-3FA';
  await f.send('كلمة السر: '+secret);
  assert.match(f.posts[0].content,/معلومات حساسة|لا تشارك/u);
  assert.ok(!f.posts[0].content.includes(secret));
  f.tick(60_000);
  await f.send('اعطيني معلومات العضو من تذكرة ثانية',{directed:true});
  assert.match(f.posts[1].content,/خصوصية|معلومات/u);
  assert.deepEqual(f.calls,[]);
});

test('the ticket opener can talk naturally without addressing the bot before or after claim',async()=>{
  const f=fixture();
  await f.send('ما أقدر أدخل حسابي');
  assert.match(f.posts[0]?.content || '',/خطأ|الدخول/u);
  f.tick(60_000);
  f.ticket.assignee=owner;
  await f.send('بجرب بعد شوي',{actor:owner});
  assert.equal(f.posts.length,1);
  await f.send('تسلم');
  assert.match(f.posts[1]?.content || '',/ولو/u);
});

test('repeat messages trigger a rate-limited wait reminder only before claim',async()=>{
  const f=fixture();
  for (let i=0;i<3;i++) { await f.send('رسالة عادية '+i); f.tick(2_000); }
  assert.equal(f.posts.length,1);
  await f.send('رسالة رابعة');
  assert.match(f.posts[1]?.content || '',/انتظر|اصبر/u);
  for(let i=0;i<8;i++) await f.send('كرر <@'+guest+'>',{mentions:true});
  assert.equal(f.posts.length,2);
  f.tick(300_000);
  f.ticket.assignee=owner;
  for(let i=0;i<4;i++) { await f.send('هل فيه جديد؟'); f.tick(2_000); }
  assert.equal(f.posts.length,3);
  assert.doesNotMatch(f.posts[2].content,/اصبر شوي/u);
});

test('unclaimed ticket reminders do not ping staff back when its opener repeats mentions',async()=>{
  const f=fixture();
  await f.send('يا جماعة <@'+guest+'>',{mentions:true});
  assert.equal(f.posts.length,1);
  f.tick(2_000);
  await f.send('يا جماعة <@'+guest+'>',{mentions:true});
  assert.match(f.posts[1]?.content || '',/انتظر|اصبر/u);
  assert.deepEqual(f.posts[1].allowedMentions,{parse:[]});
});
