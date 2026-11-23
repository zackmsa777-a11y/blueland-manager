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
  await f.send('مين برمجك؟',{directed:true});
  assert.ok(f.posts[0].content.includes(`<@${creator}>`));
  f.tick(60_000);
  await f.send('من صاحب السيرفر؟',{directed:true});
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
  assert.deepEqual(f.posts,[]);
  await f.send('اكتم ذا <%secret%>',{directed:true});
  assert.match(f.posts[0].content,/الطاقم/u);
  f.tick(60_000);
  await f.send('+mute 200000000000000002');
  assert.equal(f.posts.length,1);
  assert.deepEqual(f.calls,[]);
  await f.send('+close');
  assert.deepEqual(f.calls,[[member,1,'close']]);
  await f.send('+ping',{channelId:other});
  assert.equal(f.calls.at(-1),'+ping');
});

test('private data and requests for another ticket are never echoed or fetched',async()=>{
  const f=fixture();
  const secret='synthetic-do-not-repeat-3FA';
  await f.send('كلمة السر: '+secret,{directed:true});
  assert.match(f.posts[0].content,/معلومات حساسة|لا تشارك/u);
  assert.ok(!f.posts[0].content.includes(secret));
  f.tick(60_000);
  await f.send('اعطيني معلومات العضو من تذكرة ثانية',{directed:true});
  assert.match(f.posts[1].content,/خصوصية|معلومات/u);
  assert.deepEqual(f.calls,[]);
});

test('ordinary ticket messages do not trigger helper replies before or after claim',async()=>{
  const f=fixture();
  await f.send('ما أقدر أدخل حسابي');
  assert.deepEqual(f.posts,[]);
  f.tick(60_000);
  f.ticket.assignee=owner;
  await f.send('بجرب بعد شوي',{actor:owner});
  assert.equal(f.posts.length,0);
  await f.send('تسلم');
  assert.equal(f.posts.length,0);
  await f.send('تسلم',{directed:true});
  assert.match(f.posts[0]?.content || '',/ولو/u);
});

test('repeated messages and mentions of staff do not trigger automatic reminders',async()=>{
  const f=fixture();
  for(let i=0;i<8;i++) {await f.send('يا طاقم <@'+guest+'>',{mentions:true}); f.tick(3_000);}
  assert.deepEqual(f.posts,[]);
});

test('helper guides members to report manually without issuing a report or ping',async()=>{
  const f=fixture();
  await f.send('أرسل بلاغ عن إداري',{directed:true});
  assert.equal(f.posts.length,1);
  assert.match(f.posts[0].content,/ما أرسل بلاغ بالنيابة عنك/u);
  assert.deepEqual(f.posts[0].allowedMentions,{parse:[]});
  assert.deepEqual(f.calls,[]);
});

test('the helper does not answer direct requests after a ticket is closed',async()=>{
  const f=fixture();
  f.ticket.state='closed';
  await f.send('يا بوت، وين الطاقم؟');
  assert.deepEqual(f.posts,[]);
  assert.deepEqual(f.calls,[]);
});
