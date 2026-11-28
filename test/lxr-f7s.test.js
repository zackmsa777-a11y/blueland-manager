'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {Client,REST}=require('discord.js');
const {connectDiscord}=require('../src/discord');
const {openStore}=require('../src/store');

const G='1573975432838127708', B='1573988210185347223', FLOOR='1574012924916142140';
const STAFF=['1574013523833651220','1574013516375916605','1574013527050424410','1574013513549086731'];
const A='209000000000000001', T='209000000000000002', C='209000000000000003', D='209000000000000004';
const P='209000000000000005', THREAD='209000000000000006', UNKNOWN='209000000000000007';
const SMALLER='105000000000000001', HIGHER='8990000000000000001', ADMIN='209000000000000009';
const FOREIGN='209000000000000010', SAMPLE_HASH='0123456789abcdef0123456789abcdef';
const DAY=86_400_000, NOW=Date.parse('2026-11-27T12:30:00Z');
const BOT_PERMS=1024n|2048n|32768n|65536n|(1n<<38n);
const channel=(id,extra={})=>({id,guild_id:G,type:0,name:'synthetic',parent_id:null,permission_overwrites:[],...extra});
const user=(id,bot=false)=>({id,username:'example',discriminator:'0',bot,avatar:null});
const member=(id,roles=[],bot=false)=>({user:user(id,bot),roles,nick:'عضو تجريبي • Demo & <tag> 42',joined_at:'2025-06-21T14:22:13.647000+00:00',deaf:false,mute:false,pending:false});
const role=(id,position,permissions='0')=>({id,position,permissions,name:'Role',managed:false,hoist:false,mentionable:false,color:0});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const missing=(code=10003)=>json({code,message:'Synthetic not found'},404);
const readMember=id=>`/guilds/${G}/members/${id}`;
const ref=(source,room=C)=>({message_id:source,channel_id:room,guild_id:G,fail_if_not_exists:true});
const none={parse:[],users:[],roles:[],replied_user:false};
const rawMessage=(id,author,content,room,guild,webhook)=>({id,type:0,author,content,channel_id:room,
  ...(guild?{guild_id:guild,member:member(author.id,[FLOOR])}:{}),...(webhook?{webhook_id:webhook}:{}),
  timestamp:new Date(NOW).toISOString(),edited_timestamp:null,flags:0,attachments:[],embeds:[],components:[],mentions:[],mention_roles:[],pinned:false,tts:false});

async function fixture(t) {
  t.mock.method(Date,'now',()=>NOW);
  const store=openStore(':memory:');
  const f={store,actor:member(A,[FLOOR]),target:member(T),log:[],posts:[],hooks:new Map(),
    roles:[role(G,0,String(BOT_PERMS)),role(FLOOR,10),...STAFF.map(id=>role(id,1)),role(SMALLER,10),role(HIGHER,10),role(ADMIN,9,'8')],
    rooms:new Map([[C,channel(C)],[D,{id:D,type:1,recipients:[user(A)]}]]),botMember:member(B,[],true)};
  const makeRequest=async (url,options)=>{
    const {pathname}=new URL(url), path=pathname.replace(/^\/api\/v10/u,'');
    if (f.beforeWire && options.method==='POST') {
      await f.beforeWire();
      options.signal.throwIfAborted();
    }
    const multipart=options.body instanceof FormData ? options.body : null;
    const body=multipart ? JSON.parse(multipart.get('payload_json')) : options.body ? JSON.parse(options.body) : undefined;
    const request={method:options.method,path,body,multipart};
    f.log.push(request);
    const result=await f.hooks.get(`${request.method} ${path}`)?.(request);
    if (result!==undefined) return result;
    if (request.method==='GET') {
      if (path==='/oauth2/applications/@me') return json({id:B,flags:((1<<15)|(1<<19))});
      if (path===`/guilds/${G}/roles`) return json(f.roles);
      if (path===`/guilds/${G}`) return json({id:G,owner_id:A});
      if (path===readMember(A)) return f.actor?json(f.actor):missing(10007);
      if (path===readMember(B)) return json(f.botMember);
      if (path===readMember(T)) return f.target?json(f.target):missing(10007);
      const room=f.rooms.get(path.split('/').at(-1));
      if (room) return json(room);
    }
    if (request.method==='POST' && /^\/channels\/\d+\/messages$/u.test(path)) {
      const room=path.split('/')[2];
      f.posts.push(request);
      return json({...rawMessage('209000000000000011',user(B,true),body.content??'',room,room===D?null:G),
        type:body.message_reference?19:0,message_reference:body.message_reference,nonce:body.nonce});
    }
    return missing();
  };
  const setToken=REST.prototype.setToken;
  t.mock.method(REST.prototype,'setToken',function(token){this.options.makeRequest=makeRequest;this.options.globalRequestsPerSecond=10000;return setToken.call(this,token);});
  t.mock.method(Client.prototype,'login',async function(token){f.client=this;this.rest.setToken(token);});
  const bot=connectDiscord(store,{DISCORD_BOT_TOKEN:'synthetic-only'});
  f.close=()=>bot.close();
  t.after(()=>{bot.close();store.close();});
  await bot.start();
  const client=f.client;
  client.user=client.users._add(user(B,true));
  client.isReady=()=>true;
  const guild=client.guilds._add({id:G,shardId:0,name:'Synthetic',owner_id:A,roles:f.roles,members:[member(A,[FLOOR])],channels:[channel(C)],voice_states:[]});
  guild.available=true;
  client.guilds._add({id:FOREIGN,name:'Other synthetic guild',owner_id:A,roles:[],members:[],channels:[channel(UNKNOWN,{guild_id:FOREIGN})],voice_states:[]});
  client.channels._add(f.rooms.get(D));
  f.room=raw=>{
    f.rooms.set(raw.id,raw);
    client.channels.cache.delete(raw.id);
    guild.channels.cache.delete(raw.id);
    client.channels._add(raw,guild);
  };
  const [handler]=client.listeners('messageCreate');
  client.off('messageCreate',handler);
  const pending=new Map();
  client.on('messageCreate',value=>pending.set(value.id,handler(value)));
  let serial=250010000000000000n;
  f.message=async (content=`+f7s <@${T}>`,opts={})=>{
    const id=opts.id??String(++serial), room=opts.room??C;
    client.actions.MessageCreate.handle(rawMessage(id,opts.author??user(A),content,room,
      opts.guild===null ? null : opts.guild??G,opts.webhook));
    assert.ok(pending.has(id),'installed SDK emitted MessageCreate');
    try {await pending.get(id);} finally {pending.delete(id);}
    return id;
  };
  f.writes=()=>f.log.filter(x=>x.method!=='GET');
  f.packet=(type,data)=>client.emit('raw',{op:0,t:type,d:data});
  f.targetReads=()=>f.log.filter(x=>x.path===readMember(T)).length;
  return f;
}

test('SDK sends a PNG as the one anchored Discord Reply, with enforced source nonce and no activity write',async t=>{
  const f=await fixture(t);
  const db=f.store.community;
  db.saveSettings({...db.settings(),levels:true});
  const messages=[8,17,24,12,53,31,25,0,26,19,25,48,17,37];
  const minutes=[22,18,null,40,52,48,35,16,12,null,20,47,32,28];
  for (const [i,count] of messages.entries()) {
    const date=NOW-(13-i)*DAY;
    for (let n=0;n<count;n++) db.addXp(T,date+n,Boolean(n%2));
    if (minutes[i]!==null) db.addVoice(T,date,date+minutes[i]*60_000);
  }
  const before=db.activityTop({now:NOW});
  const source=await f.message();
  assert.equal(f.posts.length,1);
  assert.deepEqual(f.writes().map(x=>x.path),[`/channels/${C}/messages`]);
  const {multipart,body}=f.posts[0];
  assert.deepEqual(body.message_reference,ref(source));
  assert.equal(body.nonce,source);
  assert.equal(body.enforce_nonce,true);
  assert.deepEqual(body.allowed_mentions,none);
  assert.equal(body.content,undefined);
  assert.deepEqual(body.attachments,[{id:0,filename:'member-activity.png',description:'نشاط العضو المسجّل في السيرفر · UTC'}]);
  const part=multipart.get('files[0]');
  assert.equal(part.name,'member-activity.png');
  assert.equal(part.type,'image/png');
  const png=Buffer.from(await part.arrayBuffer());
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1120);
  assert.equal(png.readUInt32BE(20),820);
  const {renderF7s}=require('../src/lxr-f7s-card');
  assert.deepEqual(png,renderF7s({name:f.target.nick,created:'2016-07-30',joined:'2025-06-21'},db.memberActivity(T,NOW),null));
  if (process.env.LXR_F7S_TEST_PNG) writeFileSync(process.env.LXR_F7S_TEST_PNG,png);
  assert.equal(db.xp(A),0);
  assert.deepEqual(db.activityTop({now:NOW}),before);
});

test('only eligible guild text help advertises the command, and shortcuts cannot claim its namespace',async t=>{
  const f=await fixture(t);
  const {helpText,commands,parseChat}=require('../src/commands');
  const {commandGuide}=require('../src/custom-shortcuts');
  await f.message('+help');
  assert.match(f.posts[0].body.content,/\+f7s @العضو/u);
  assert.match(f.posts[0].body.content,/رد في نفس الروم/u);
  assert.ok(f.posts[0].body.content.length<=2000);
  f.actor=member(A,[ADMIN]);
  await f.message('+مساعدة');
  assert.equal(f.posts[1].body.content,helpText);
  f.actor=member(A,[STAFF[0]]);
  const ticket=f.store.community.reserveTicket('synthetic-help',A,'private','staff-complaint','');
  f.store.community.setChannel(ticket.id,C);
  await f.message('+help');
  assert.ok(f.posts.slice(2).every(post=>!post.body.content?.includes('+f7s')));
  assert.equal(parseChat(`+f7s <@${T}>`),null);
  assert.ok(!commands.some(c=>c.name==='f7s'));
  assert.ok(!commandGuide(f.store.shortcuts).some(c=>c.name.includes('f7s')));
  assert.throws(()=>f.store.shortcuts.add('F7S','/ban',A),{status:409});
  assert.throws(()=>f.store.shortcuts.add('Ｆ７Ｓ   report','/ban',A),{status:409});
  assert.throws(()=>f.store.shortcuts.add('example','+f7s',A));
  assert.equal(f.store.shortcuts.match(`.f7s <@${T}>`),null);
});

test('SQLite 14-day snapshot preserves recorded zero and rank ties, without backfill or XP ranking',()=>{
  const {DatabaseSync}=require('node:sqlite');
  const {createActivityStore}=require('../src/activity-top');
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec('CREATE TABLE server_xp (member TEXT PRIMARY KEY,xp INTEGER,last INTEGER)');
    const db=createActivityStore(sql), today=Math.floor(NOW/DAY);
    const row=sql.prepare('INSERT INTO activity_daily(day,member,messages,text_xp,voice_ms) VALUES(?,?,?,?,?)');
    row.run(today,T,0,0,901);
    row.run(today-2,T,2,0,0);
    row.run(today-6,T,4,0,30_000);
    row.run(today-13,T,3,10,500);
    row.run(today-14,T,900,500,90_000);
    row.run(today+1,T,900,500,90_000);
    row.run(today-5,'msg-front',10,0,28_000);
    row.run(today-5,'tie',9,0,31_401);
    row.run(today-5,'voice-front',0,0,31_500);
    row.run(today-5,'voice-second',0,0,31_499);
    row.run(today-5,'zero-voice',0,0,0);
    sql.exec('PRAGMA query_only=ON');
    const data=db.memberActivity(T,NOW);
    assert.equal(data.days.length,14);
    assert.deepEqual(data.days.map(d=>d.day),Array.from({length:14},(_,i)=>today-13+i));
    assert.deepEqual(data.days.at(-1),{day:today,messages:0,voiceMs:901});
    assert.deepEqual(data.days.at(-2),{day:today-1,messages:null,voiceMs:null});
    assert.deepEqual(data.days.at(-3),{day:today-2,messages:2,voiceMs:null});
    assert.deepEqual(data.windows,[{length:1,messages:0,voiceMs:901},{length:7,messages:6,voiceMs:30_901},
      {length:14,messages:9,voiceMs:31_401}]);
    assert.deepEqual([data.messageRank,data.voiceRank],[2,3]);
    assert.deepEqual([db.memberActivity('tie',NOW).messageRank,db.memberActivity('tie',NOW).voiceRank],[2,3]);
    assert.deepEqual([db.memberActivity('zero-voice',NOW).messageRank,db.memberActivity('zero-voice',NOW).voiceRank],[null,null]);
    const empty=db.memberActivity(UNKNOWN,NOW);
    assert.ok(empty.days.every(d=>d.messages===null && d.voiceMs===null));
    assert.ok(empty.windows.every(d=>d.messages===null && d.voiceMs===null));
    assert.deepEqual([empty.messageRank,empty.voiceRank],[null,null]);
    const next=db.memberActivity(T,(today+1)*DAY);
    assert.deepEqual(next.days[0],{day:today-12,messages:null,voiceMs:null});
    assert.deepEqual(next.windows.map(d=>d.messages),[900,902,906]);
  } finally {sql.close();}
});

test('the UTC clock is sampled after authorization immediately before the activity read',async t=>{
  const f=await fixture(t);
  let time=Math.floor(NOW/DAY)*DAY-1, checks=0;
  t.mock.method(Date,'now',()=>time);
  f.hooks.set(`GET ${readMember(A)}`,()=>{if (++checks===2) time+=1;});
  const read=t.mock.method(f.store.community,'memberActivity');
  await f.message();
  assert.equal(read.mock.callCount(),1);
  assert.equal(read.mock.calls[0].arguments[1],Math.floor(NOW/DAY)*DAY);
});

test('each exact staff ID works below the floor; live hierarchy uses position then smaller snowflake',async t=>{
  const f=await fixture(t);
  for (const id of [...STAFF,FLOOR,SMALLER]) {
    f.actor=member(A,[id]);
    await f.message();
  }
  assert.equal(f.posts.length,6);
  const before=f.targetReads();
  for (const roles of [[],[ADMIN],[HIGHER],[UNKNOWN]]) {
    f.actor=member(A,roles);
    await f.message();
    await f.message('+f7s extra invalid text');
  }
  assert.equal(f.targetReads(),before,'owner/admin and stale cache did not authorize target reads');
  assert.equal(f.posts.length,6);
  f.roles.find(r=>r.id===HIGHER).position+=1;
  f.actor=member(A,[HIGHER]);
  await f.message();
  assert.equal(f.posts.length,7);
  f.roles=f.roles.filter(r=>r.id!==FLOOR);
  await f.message();
  assert.equal(f.posts.length,7);
  f.actor=member(A,[STAFF[2]]);
  await f.message();
  assert.equal(f.posts.length,8,'the staff ID branch is independent of the floor role');
});

test('parser accepts one literal member ID or mention and never performs member or activity reads for malformed or role IDs',async t=>{
  const f=await fixture(t);
  const {parseF7s}=require('../src/lxr-f7s');
  const read=t.mock.method(f.store.community,'memberActivity');
  const invalid=['+f7s',`+f7s <@&${FLOOR}>`,`+f7s <#${C}>`,`+f7s ${T} ${A}`,`+f7s <@${T}> hi`,
    `+f7s \n${T}`,`+f7s 0${T}`,'+f7s 18446744073709551616','+f7s １２３４５６７８９０１２３４５６７８','+f7s 123'];
  for (const text of invalid) {
    assert.equal(parseF7s(text),null);
    const source=await f.message(text);
    assert.match(f.posts.at(-1).body.content,/الاستخدام/u);
    assert.deepEqual(f.posts.at(-1).body.message_reference,ref(source));
  }
  for (const text of [`+f7s ${FLOOR}`,`+f7s <@${FLOOR}>`]) {
    await f.message(text);
    assert.match(f.posts.at(-1).body.content,/ما لقيت عضوًا/u);
  }
  assert.ok(!f.log.some(e=>e.path===readMember(FLOOR)));
  assert.equal(f.targetReads(),0);
  assert.equal(read.mock.callCount(),0);
  for (const text of [`+f7s ${T}`,`+f7s <@!${T}>`,`+f7s\t<@${T}>`]) {
    assert.equal(parseF7s(text),T);
    await f.message(text);
    assert.ok(f.posts.at(-1).multipart);
  }
  assert.equal(read.mock.callCount(),3);
});

test('command does not enter dispatch in DMs, foreign guilds, or from bots or webhooks',async t=>{
  const f=await fixture(t);
  const calls=f.log.length;
  for (const opts of [{room:D,guild:null},{room:UNKNOWN,guild:FOREIGN},{author:user(B,true)},{webhook:UNKNOWN}]) await f.message(undefined,opts);
  assert.equal(f.log.length,calls);
  await f.message(`+F7S ${T}`);
  await f.message(`+ f7s ${T}`);
  await f.message(`.f7s ${T}`);
  await f.message(`+f7sX ${T}`);
  assert.equal(f.targetReads(),0);
  assert.deepEqual(f.writes(),[]);
});

test('target verification rejects a missing member, a bot, mismatched member or guild, and a non-Discord join timestamp',async t=>{
  const f=await fixture(t), valid=f.target;
  const read=t.mock.method(f.store.community,'memberActivity');
  for (const target of [null,member(T,[],true),member(UNKNOWN),{...valid,pending:true},{...valid,joined_at:null},
    {...valid,joined_at:'2025'},{...valid,joined_at:'2025-02-30T00:00:00Z'},{...valid,guild_id:FOREIGN}]) {
    f.target=target;
    await f.message();
    assert.match(f.posts.at(-1).body.content,/ما لقيت عضوًا/u);
    assert.equal(f.posts.at(-1).multipart,null);
  }
  assert.equal(read.mock.callCount(),0);
  assert.equal(f.targetReads(),8);
});

test('private application ancestry, registered application/support rooms, unknown ancestry and wrong guild fail closed before SQL',async t=>{
  const f=await fixture(t);
  const read=t.mock.method(f.store.community,'memberActivity');
  f.room(channel(P,{type:4,name:'تقديم اداره'}));
  f.room(channel(C,{parent_id:P}));
  await f.message();
  assert.equal(f.targetReads(),0,'application category');
  f.rooms.set(P,channel(P,{type:4,name:undefined}));
  await f.message();
  f.rooms.delete(P);
  await f.message();
  assert.equal(f.targetReads(),0,'unknown category');
  f.rooms.set(C,channel(C,{guild_id:FOREIGN}));
  await f.message();
  f.rooms.set(C,channel(C,{parent_id:undefined}));
  await f.message();
  f.rooms.set(C,channel(C,{type:2}));
  await f.message();
  f.rooms.set(C,channel(C));
  assert.ok(f.store.applicationRooms.create(C,{synthetic:true},{}));
  await f.message();
  assert.equal(f.targetReads(),0,'registered application room');
  f.room(channel(P));
  f.room(channel(THREAD,{type:11,parent_id:P,thread_metadata:{archived:false,locked:false}}));
  const ticket=f.store.community.reserveTicket('synthetic-thread',A,'private','support','');
  f.store.community.setChannel(ticket.id,P);
  await f.message(undefined,{room:THREAD});
  assert.equal(f.targetReads(),0,'registered support thread parent');
  await f.message('+f7s',{room:P});
  assert.equal(f.targetReads(),0);
  assert.equal(read.mock.callCount(),0);
  assert.deepEqual(f.writes(),[]);
});

test('the bot needs View, History, Attach Files and the proper Send bit; live timeout denies even an ordinary text room',async t=>{
  const f=await fixture(t);
  for (const deny of ['1024','65536','32768','2048']) {
    f.rooms.set(C,channel(C,{permission_overwrites:[{id:B,type:1,deny,allow:'0'}]}));
    await f.message();
    await f.message('+f7s');
  }
  f.rooms.set(C,channel(C));
  f.botMember={...f.botMember,communication_disabled_until:new Date(NOW+DAY).toISOString()};
  await f.message();
  assert.equal(f.targetReads(),0);
  assert.deepEqual(f.writes(),[]);
  delete f.botMember.communication_disabled_until;
  f.room(channel(P,{permission_overwrites:[{id:B,type:1,deny:'2048',allow:'0'}]}));
  f.room(channel(THREAD,{type:11,parent_id:P,thread_metadata:{archived:false,locked:false}}));
  const source=await f.message(undefined,{room:THREAD});
  assert.deepEqual(f.writes().map(w=>w.body.message_reference),[ref(source,THREAD)]);
  f.rooms.set(P,channel(P,{permission_overwrites:[{id:B,type:1,deny:String(1n<<38n),allow:'0'}]}));
  await f.message(undefined,{room:THREAD});
  assert.equal(f.writes().length,1);
});

test('a private ordinary thread requires bot membership absent Manage Threads or Administrator',async t=>{
  const f=await fixture(t);
  f.room(channel(P));
  f.room(channel(THREAD,{type:12,parent_id:P,thread_metadata:{archived:false,locked:false}}));
  const route=`GET /channels/${THREAD}/thread-members/${B}`;
  f.hooks.set(route,()=>missing());
  await f.message(undefined,{room:THREAD});
  f.hooks.set(route,()=>json({id:THREAD,user_id:UNKNOWN}));
  await f.message(undefined,{room:THREAD});
  assert.equal(f.targetReads(),0);
  f.hooks.set(route,()=>json({id:THREAD,user_id:B}));
  const source=await f.message(undefined,{room:THREAD});
  assert.deepEqual(f.writes().map(w=>w.body.message_reference),[ref(source,THREAD)]);
});

test('revocation during the target lookup stops before SQLite or the avatar network',async t=>{
  const f=await fixture(t);
  f.target.avatar=SAMPLE_HASH;
  const read=t.mock.method(f.store.community,'memberActivity');
  const avatar=t.mock.method(globalThis,'fetch',async()=>{throw Error('Synthetic transport should not run');});
  f.hooks.set(`GET ${readMember(T)}`,()=>{f.actor=member(A);});
  await f.message();
  assert.equal(f.targetReads(),1);
  assert.equal(read.mock.callCount(),0);
  assert.equal(avatar.mock.callCount(),0);
  assert.deepEqual(f.writes(),[]);
});

const pngResponse=(bytes,headers={})=>new Response(bytes,{headers:{'content-type':'image/png',...headers}});
const syntheticAvatar=()=>new (require('@resvg/resvg-js').Resvg)('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#6b3ecc"/></svg>').render().asPng();

test('after avatar I/O, fresh actor, ancestry, bot attachment permission and local tickets each veto the Reply',async t=>{
  const f=await fixture(t), goodActor=f.actor, goodRoom=f.rooms.get(C), bytes=syntheticAvatar();
  f.target.avatar=SAMPLE_HASH;
  f.room(channel(P,{type:4,name:'تقديم اداره'}));
  const read=t.mock.method(f.store.community,'memberActivity');
  let change=()=>{};
  const avatar=t.mock.method(globalThis,'fetch',async()=>{await Promise.resolve();change();return pngResponse(bytes);});
  for (const revoke of [()=>{f.actor=member(A,[ADMIN]);},()=>{f.rooms.set(C,channel(C,{parent_id:P}));},
    ()=>{f.rooms.set(C,channel(C,{permission_overwrites:[{id:B,type:1,deny:'32768',allow:'0'}]}));}]) {
    change=revoke;
    await f.message();
    f.actor=goodActor;
    f.rooms.set(C,goodRoom);
    assert.deepEqual(f.writes(),[]);
  }
  const ticket=f.store.community.reserveTicket('synthetic-final-registration',A,'private','support','');
  let checks=0;
  f.hooks.set(`GET ${readMember(A)}`,()=>{if (++checks===3) f.store.community.setChannel(ticket.id,C);});
  change=()=>{};
  await f.message();
  assert.equal(checks,3);
  assert.deepEqual(f.writes(),[]);
  assert.equal(read.mock.callCount(),4);
  assert.equal(avatar.mock.callCount(),4);
  f.hooks.delete(`GET ${readMember(A)}`);
  f.store.community.ticketRemoved(C);
  await f.message();
  assert.equal(f.posts.length,1,'unchanged-authority control reaches the same room');
  assert.deepEqual(avatar.mock.calls[0].arguments.slice(0,1),[`https://cdn.discordapp.com/guilds/${G}/users/${T}/avatars/${SAMPLE_HASH}.png?size=128`]);
  const upload=f.posts[0].multipart.get('files[0]');
  const bytesOnWire=Buffer.from(await upload.arrayBuffer());
  const {renderF7s}=require('../src/lxr-f7s-card');
  const profile={name:f.target.nick,created:'2016-07-30',joined:'2025-06-21'};
  const data=f.store.community.memberActivity(T,NOW);
  assert.deepEqual(bytesOnWire,renderF7s(profile,data,bytes));
  assert.notDeepEqual(bytesOnWire,renderF7s(profile,data,null));
});

test('avatar fetch is HTTPS exact-CDN, redirect rejecting, bounded by declared/stream size and PNG dimensions',async t=>{
  const {loadF7sAvatar}=require('../src/lxr-f7s-card');
  const bytes=syntheticAvatar(), signal=AbortSignal.timeout(1000);
  const oversized=Buffer.from(bytes);
  oversized.writeUInt32BE(257,16);
  let response=pngResponse(bytes);
  const spy=t.mock.method(globalThis,'fetch',async()=>response);
  assert.equal(await loadF7sAvatar({id:T,userAvatar:`https://example.invalid/${SAMPLE_HASH}`},signal),null);
  assert.equal(await loadF7sAvatar({id:`${T}/x`,userAvatar:SAMPLE_HASH},signal),null);
  assert.equal(spy.mock.callCount(),0);
  assert.deepEqual(await loadF7sAvatar({id:T,userAvatar:`a_${SAMPLE_HASH}`},signal),bytes);
  assert.deepEqual(spy.mock.calls[0].arguments,[`https://cdn.discordapp.com/avatars/${T}/a_${SAMPLE_HASH}.png?size=128`,{redirect:'error',signal}]);
  for (const result of [new Response(null,{status:302,headers:{location:'https://example.invalid'}}),
    pngResponse(bytes,{'content-type':'image/svg+xml'}),pngResponse(bytes,{'content-length':'131073'}),
    pngResponse(Buffer.alloc(131073)),pngResponse(oversized),pngResponse(bytes.subarray(0,32))]) {
    response=result;
    assert.equal(await loadF7sAvatar({id:T,userAvatar:SAMPLE_HASH},signal),null);
  }
});

test('a verified member with no observations gets a PNG with neutral fallback when the CDN returns unusable bytes',async t=>{
  const f=await fixture(t);
  const bytes=syntheticAvatar().subarray(0,33); // A real PNG header, without image data.
  const {renderF7s}=require('../src/lxr-f7s-card');
  const read=t.mock.method(globalThis,'fetch',async()=>pngResponse(bytes));
  f.target.avatar=SAMPLE_HASH;
  f.target.nick='\u202B\x01';
  f.target.user.username='';
  await f.message();
  assert.equal(read.mock.callCount(),1);
  const png=Buffer.from(await f.posts[0].multipart.get('files[0]').arrayBuffer());
  const data=f.store.community.memberActivity(T,NOW);
  assert.ok(data.days.every(row=>row.messages===null && row.voiceMs===null));
  assert.deepEqual(png,renderF7s({name:'',created:'2016-07-30',joined:'2025-06-21'},data,null));
  if (process.env.LXR_F7S_TEST_EMPTY_PNG) writeFileSync(process.env.LXR_F7S_TEST_EMPTY_PNG,png);
});

test('Discord deleted-source and ambiguous gateway failures never become retries, a standalone post, or a DM',async t=>{
  const f=await fixture(t);
  const path=`/channels/${C}/messages`;
  f.hooks.set(`POST ${path}`,()=>missing(10008));
  const gone=await f.message();
  f.client.channels.cache.get(C).messages.cache.delete(gone);
  await f.message(undefined,{id:gone});
  f.hooks.set(`POST ${path}`,()=>json({message:'Synthetic uncertain failure'},503));
  const uncertain=await f.message();
  assert.deepEqual(f.writes().map(w=>[w.path,w.body.message_reference,w.body.nonce,w.body.enforce_nonce]),
    [[path,ref(gone),gone,true],[path,ref(uncertain),uncertain,true]]);
  assert.deepEqual(f.posts,[]);
});

test('preexisting colliding shortcut rows cannot list or dispatch; no migration removes them',()=>{
  const {DatabaseSync}=require('node:sqlite');
  const {openShortcuts}=require('../src/custom-shortcuts');
  const db=new DatabaseSync(':memory:');
  try {
    const shortcuts=openShortcuts(db);
    const insert=db.prepare('INSERT INTO command_shortcuts VALUES (?,?,?,?,?)');
    insert.run('f7s','F7S','/ban',A,0);
    insert.run('f7s report','F7S Report','/ban',A,0);
    assert.equal(shortcuts.match(`f7s <@${T}>`),null);
    assert.equal(shortcuts.match(`f7s report <@${T}>`),null);
    assert.ok(!shortcuts.list().some(a=>/^f7s\b/iu.test(a.phrase)));
    assert.equal(db.prepare("SELECT count(*) AS n FROM command_shortcuts WHERE key LIKE 'f7s%'").get().n,2);
  } finally {db.close();}
});

async function duringFinalRequester(f,change,opts) {
  let reads=0;
  const route=`GET ${readMember(A)}`;
  f.hooks.set(route,()=>{if (++reads===3) change();});
  try {
    const source=await f.message(undefined,opts);
    assert.equal(reads,3,'the update ran after final room, role and bot reads');
    return source;
  } finally {f.hooks.delete(route);}
}
const wrote=(f,source)=>f.writes().some(w=>w.body?.nonce===source);

test('an observed move into a protected category during the final requester read vetoes the Reply',async t=>{
  const f=await fixture(t);
  f.room(channel(P,{type:4,name:'تقديم اداره'}));
  assert.ok(wrote(f,await f.message()),'stable control sends the card');
  const source=await duringFinalRequester(f,()=>{
    const updated=channel(C,{parent_id:P});
    f.rooms.set(C,updated);
    f.client.actions.ChannelUpdate.handle(updated);
  });
  assert.equal(f.client.channels.cache.get(C).parentId,P);
  assert.equal(wrote(f,source),false);
});

test('an observed requester role reorder during the final requester read vetoes the Reply',async t=>{
  const f=await fixture(t);
  f.actor=member(A,[SMALLER]);
  assert.ok(wrote(f,await f.message()),'the equal-position smaller snowflake initially qualifies');
  const source=await duringFinalRequester(f,()=>{
    const updated={...f.roles.find(r=>r.id===SMALLER),position:9};
    f.roles=f.roles.map(r=>r.id===SMALLER?updated:r);
    f.client.actions.GuildRoleUpdate.handle({guild_id:G,role:updated});
  });
  assert.equal(f.client.guilds.cache.get(G).roles.cache.get(SMALLER).rawPosition,9);
  assert.equal(wrote(f,source),false);
});

test('raw role inventory changes veto the Reply even if no SDK role event is emitted',async t=>{
  const f=await fixture(t);
  for (const [type,data] of [
    ['GUILD_ROLE_CREATE',{role:role(UNKNOWN,12)}],
    ['GUILD_ROLE_UPDATE',{role:role(UNKNOWN,9)}],
    ['GUILD_ROLE_DELETE',{role_id:UNKNOWN}]
  ]) {
    const source=await duringFinalRequester(f,()=>f.packet(type,{guild_id:G,...data}));
    assert.equal(wrote(f,source),false,type);
  }
  assert.ok(wrote(f,await f.message()),'a fresh, unaffected guard can still send');
});

test('a raw guild-wide role refresh vetoes stale authorization before any SDK cache mutation',async t=>{
  const f=await fixture(t);
  f.actor=member(A,[SMALLER]);
  for (const [label,roles] of [
    ['position',f.roles.map(r=>r.id===SMALLER?{...r,position:9}:r)],
    ['permissions',f.roles.map(r=>r.id===G?{...r,permissions:'0'}:r)],
    ['membership',f.roles.filter(r=>r.id!==SMALLER)]
  ]) {
    const source=await duringFinalRequester(f,()=>f.packet('GUILD_UPDATE',{id:G,roles}));
    assert.equal(f.client.guilds.cache.get(G).roles.cache.get(SMALLER).rawPosition,10);
    assert.equal(wrote(f,source),false,label);
  }
});

test('a native guild-wide role refresh vetoes stale authorization without a raw or per-role event',async t=>{
  const f=await fixture(t);
  f.actor=member(A,[SMALLER]);
  const changed=f.roles.map(r=>r.id===SMALLER?{...r,position:9}:r);
  let perRole=0;
  f.client.on('roleUpdate',()=>perRole++);
  const source=await duringFinalRequester(f,()=>f.client.actions.GuildUpdate.handle({id:G,roles:changed}));
  assert.equal(f.client.guilds.cache.get(G).roles.cache.get(SMALLER).rawPosition,9);
  assert.equal(perRole,0);
  assert.equal(wrote(f,source),false);
});

test('unchanged relevant roles and foreign guild refreshes preserve the anchored PNG Reply',async t=>{
  const f=await fixture(t);
  // Metadata and array order are not part of the role gate or bot permission check.
  const same=f.roles.map(r=>({...r,name:'Renamed',color:123})).reverse();
  const source=await duringFinalRequester(f,()=>{
    f.packet('GUILD_UPDATE',{id:G,name:'Guild renamed',roles:same});
    f.client.actions.GuildUpdate.handle({id:G,roles:same});
    const foreign=[role(FOREIGN,0),role(UNKNOWN,1)];
    f.packet('GUILD_UPDATE',{id:FOREIGN,roles:foreign});
    f.client.actions.GuildUpdate.handle({id:FOREIGN,roles:foreign});
  });
  assert.deepEqual(f.writes().map(w=>[w.path,w.body.message_reference,w.body.allowed_mentions]),
    [[`/channels/${C}/messages`,ref(source),none]]);
  assert.equal(f.posts[0].multipart.get('files[0]').type,'image/png');
});

test('missing or malformed target-guild role observations veto the Reply',async t=>{
  const f=await fixture(t);
  for (const data of [
    {},{roles:null},{roles:{}},{roles:f.roles.slice(1)},
    {roles:[...f.roles,f.roles[0]]},{roles:[...f.roles,{id:UNKNOWN,position:2}]},
    {roles:[...f.roles,role(UNKNOWN,-1)]}
  ]) {
    const source=await duringFinalRequester(f,()=>f.packet('GUILD_UPDATE',{id:G,...data}));
    assert.equal(wrote(f,source),false,JSON.stringify(data));
  }
  const source=await duringFinalRequester(f,()=>f.client.emit('guildUpdate',f.client.guilds.cache.get(G),null));
  assert.equal(wrote(f,source),false);
});

test('an early guild-wide role observation cannot be discarded when the eventual REST inventory disagrees',async t=>{
  const f=await fixture(t);
  f.actor=member(A,[SMALLER]);
  const changed=f.roles.map(r=>r.id===SMALLER?{...r,position:9}:r);
  const emit=roles=>f.packet('GUILD_UPDATE',{id:G,roles});
  const run=async roles=>{
    let reads=0;
    f.hooks.set(`GET /channels/${C}`,()=>{if (++reads===3) emit(roles);});
    try {
      const source=await f.message();
      assert.equal(reads,3,'the event ran during the final room GET, before its roles GET');
      return source;
    } finally {f.hooks.delete(`GET /channels/${C}`);}
  };
  assert.ok(wrote(f,await run(f.roles)),'an agreeing observation during the earlier read is not a veto');
  f.client.actions.GuildUpdate.handle({id:G,roles:changed});
  assert.equal(wrote(f,await run(changed)),false,'an observation matching the cache must still veto conflicting REST');
  const source=await duringFinalRequester(f,()=>emit(changed));
  assert.equal(wrote(f,source),false,'the same conflict vetoes after the roles GET too');
});

test('a guild-wide refresh without a usable cached baseline fails closed without making cache an authority',async t=>{
  const f=await fixture(t);
  const guild=f.client.guilds.cache.get(G);
  guild.roles.cache.clear();
  assert.ok(wrote(f,await f.message()),'without a refresh, fresh REST can still authorize');
  const source=await duringFinalRequester(f,()=>f.client.actions.GuildUpdate.handle({id:G,roles:f.roles}));
  assert.equal(wrote(f,source),false,'a refresh cannot repair a missing baseline during a pass');
  f.actor=member(A,[HIGHER]);
  f.client.actions.GuildUpdate.handle({id:G,roles:f.roles.map(r=>r.id===HIGHER?{...r,position:11}:r)});
  assert.equal(wrote(f,await f.message()),false,'a favorable cache cannot grant against fresh REST');
});

test('an observed ancestor update while the child GET is in flight vetoes a stale thread Reply',async t=>{
  const f=await fixture(t);
  const parent=channel(P), thread=channel(THREAD,{type:11,parent_id:P,thread_metadata:{archived:false,locked:false}});
  f.room(parent);
  f.room(thread);
  let reads=0;
  f.hooks.set(`GET /channels/${THREAD}`,()=>{
    if (++reads===3) {
      const updated={...parent,permission_overwrites:[{id:B,type:1,deny:'32768',allow:'0'}]};
      f.packet('CHANNEL_UPDATE',updated);
      // REST intentionally presents the pre-event parent to this authorization pass.
    }
  });
  const source=await f.message(undefined,{room:THREAD});
  assert.equal(reads,3);
  assert.equal(wrote(f,source),false);
});

test('raw thread scope and bot membership changes veto the Reply',async t=>{
  const f=await fixture(t);
  const thread=channel(THREAD,{type:12,parent_id:C,thread_metadata:{archived:false,locked:false}});
  f.room(thread);
  f.hooks.set(`GET /channels/${THREAD}/thread-members/${B}`,()=>json({id:THREAD,user_id:B}));
  for (const [type,data] of [
    ['THREAD_UPDATE',{...thread,thread_metadata:{archived:true,locked:false}}],
    ['THREAD_DELETE',{id:THREAD,parent_id:C,type:12}],
    ['THREAD_MEMBER_UPDATE',{id:THREAD,user_id:B,flags:0,join_timestamp:new Date(NOW).toISOString()}],
    ['THREAD_MEMBERS_UPDATE',{id:THREAD,member_count:0,removed_member_ids:[B]}],
    ['THREAD_LIST_SYNC',{channel_ids:[C],threads:[],members:[]}]
  ]) {
    const source=await duringFinalRequester(f,()=>f.packet(type,{guild_id:G,...data}),{room:THREAD});
    assert.equal(wrote(f,source),false,type);
  }
  assert.ok(wrote(f,await f.message(undefined,{room:THREAD})), 'unchanged thread control still sends');
});

test('observed requester, bot membership and connection changes veto a Reply',async t=>{
  const f=await fixture(t);
  for (const change of [
    ()=>f.packet('GUILD_MEMBER_UPDATE',{guild_id:G,...member(A,[])}),
    ()=>f.packet('GUILD_MEMBER_REMOVE',{guild_id:G,user:user(A)}),
    ()=>f.packet('GUILD_MEMBER_ADD',{guild_id:G,...member(A,[])}),
    ()=>f.packet('GUILD_MEMBER_UPDATE',{guild_id:G,...member(B,[],true),communication_disabled_until:new Date(NOW+DAY).toISOString()}),
    ()=>f.packet('GUILD_DELETE',{id:G,unavailable:true}),
    ()=>f.client.emit('shardReconnecting',0),
    ()=>f.client.emit('shardDisconnect',{code:4014},0),
    ()=>f.client.emit('shardResume',0,0)
  ]) {
    const source=await duringFinalRequester(f,change);
    assert.equal(wrote(f,source),false);
  }
});

test('observed foreign guild, other shard, unrelated room and unrelated member events do not veto the valid Reply',async t=>{
  const f=await fixture(t);
  const source=await duringFinalRequester(f,()=>{
    f.packet('GUILD_ROLE_UPDATE',{guild_id:FOREIGN,role:role(FLOOR,1)});
    f.packet('GUILD_MEMBER_REMOVE',{guild_id:FOREIGN,user:user(A)});
    f.packet('CHANNEL_UPDATE',channel(C,{guild_id:FOREIGN,parent_id:P}));
    f.packet('GUILD_DELETE',{id:FOREIGN,unavailable:true});
    f.packet('CHANNEL_UPDATE',channel(UNKNOWN,{parent_id:P}));
    f.packet('GUILD_MEMBER_REMOVE',{guild_id:G,user:user(UNKNOWN)});
    f.client.emit('shardReconnecting',1);
  });
  assert.deepEqual(f.writes().map(w=>[w.path,w.body.message_reference,w.body.allowed_mentions]),
    [[`/channels/${C}/messages`,ref(source),none]]);
  assert.equal(f.posts[0].multipart.get('files[0]').type,'image/png');
});

test('an observed invalidation during the SDK microtask handoff suppresses the wire POST',async t=>{
  const f=await fixture(t);
  const resolveRequest=REST.prototype.resolveRequest;
  let handoffs=0;
  const serialize=t.mock.method(REST.prototype,'resolveRequest',function(request){
    const resolved=resolveRequest.call(this,request);
    if (request.fullRoute===`/channels/${C}/messages` && request.method==='POST') {
      queueMicrotask(()=>{
        handoffs++;
        f.packet('CHANNEL_UPDATE',channel(C,{permission_overwrites:[{id:B,type:1,deny:'32768',allow:'0'}]}));
      });
    }
    return resolved;
  });
  const source=await f.message();
  assert.equal(handoffs,1,'SDK serialization began and the event ran before transport');
  assert.equal(wrote(f,source),false);
  serialize.mock.restore();
  assert.ok(wrote(f,await f.message()),'unchanged control reaches transport');
});

test('activity guard listeners install once and are removed idempotently on close',async t=>{
  const f=await fixture(t);
  const client=f.client;
  assert.equal(client.listenerCount('raw'),1);
  assert.equal(client.listenerCount('channelUpdate'),1);
  assert.equal(client.listenerCount('guildUpdate'),1);
  await f.message();
  await f.message();
  assert.equal(client.listenerCount('raw'),1);
  assert.equal(client.listenerCount('channelUpdate'),1);
  assert.equal(client.listenerCount('guildUpdate'),1);
  f.close();
  f.close();
  assert.equal(client.listenerCount('raw'),0);
  assert.equal(client.listenerCount('channelUpdate'),0);
  assert.equal(client.listenerCount('guildUpdate'),0);
});

test('an invalidation while the request adapter prepares the body aborts before forwarding the Reply',async t=>{
  const f=await fixture(t);
  let entered=0;
  f.beforeWire=async()=>{
    entered++;
    await Promise.resolve();
    f.packet('GUILD_MEMBER_REMOVE',{guild_id:G,user:user(A)});
  };
  const source=await f.message();
  assert.equal(entered,1,'the one dedicated adapter was reached');
  assert.equal(wrote(f,source),false);
  f.beforeWire=undefined;
  assert.ok(wrote(f,await f.message()),'unchanged control reaches transport');
});
