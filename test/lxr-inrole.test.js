'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Client,REST}=require('discord.js');
const {connectDiscord}=require('../src/discord');
const {openStore}=require('../src/store');

const G='1573975432838127708', B='1573988210185347223', O='200000000000000001', A='200000000000000002';
const M='200000000000000003', R='200000000000000004', C='200000000000000005', D='200000000000000006';
const OTHER='200000000000000007', POST='200000000000000008';
const MANAGE=(1n<<28n).toString(), ADMIN='8';
const user=(id,bot=false)=>({id,username:'fixture',discriminator:'0',bot});
const role=(id,name,permissions='0',managed=false)=>({id,name,permissions,managed,color:0,position:1,hoist:false,mentionable:false});
const member=(id,roles=[],bot=false)=>({user:user(id,bot),roles,joined_at:'2025-01-01T00:00:00.000Z',deaf:false,mute:false,pending:false});
const ids=n=>Array.from({length:n},(_,i)=>String(200000000000000100n+BigInt(i)));
const none={parse:[],users:[],roles:[],replied_user:false};
const line=id=>`<@${id}> — \`${id}\``;
const speaker=(id,channel)=>({id:channel,type:1,recipients:[user(id)]});
const origin={id:C,guild_id:G,type:0,name:'public',parent_id:null,permission_overwrites:[]};
const inbound=({id,author,content,channel,guild,webhook})=>({id,type:0,content,channel_id:channel,author,
  ...(guild?{guild_id:guild,member:member(author.id,[M])}:{}),...(webhook?{webhook_id:webhook}:{}),
  timestamp:'2026-11-27T00:00:00Z',edited_timestamp:null,flags:0,attachments:[],embeds:[],components:[],mentions:[],mention_roles:[],pinned:false,tts:false});

async function fixture(t,n=23) {
  const store=openStore(':memory:');
  const f={store,idList:ids(n),inventory:[role(G,'@everyone'),role(M,'Manager',MANAGE),role(R,'Actual Discord role','0',true)],
    guild:{id:G,owner_id:O},actor:member(A,[M]),dm:speaker(A,D),calls:[],posts:[],overrides:new Map(),accept:new Map(),others:new Map()};
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
  const row=(body,id=POST,channel=D)=>({...inbound({id,author:user(B,true),content:body.content??'',channel}),
    embeds:body.embeds??[],components:body.components??[]});
  f.roster=[member(A,[M]),...f.idList.map(id=>member(id,[R]))];
  f.makeRequest=async (url,opts)=>{
    const {pathname,searchParams}=new URL(url), path=pathname.replace(/^\/api\/v10/u,'');
    const body=opts.body?JSON.parse(opts.body):undefined;
    const req={path,method:opts.method,query:Object.fromEntries(searchParams),body};
    f.calls.push(req);
    const custom=f.overrides.get(opts.method+' '+path);
    if (custom) {
      const response=await custom(req);
      if (response!==undefined) return response instanceof Response?response:json(response);
    }
    if (path==='/oauth2/applications/@me' && opts.method==='GET') return json({id:B,flags:((1<<15)|(1<<19))});
    if (path===`/guilds/${G}` && opts.method==='GET') return json(f.guild);
    if (path===`/guilds/${G}/roles` && opts.method==='GET') return json(f.inventory);
    if (path===`/guilds/${G}/members/${A}` && opts.method==='GET') return f.actor?json(f.actor):json({code:10007,message:'Unknown Member'},404);
    if (path.startsWith(`/guilds/${G}/members/`) && opts.method==='GET' && f.others.has(path.split('/').at(-1)))
      return json(f.others.get(path.split('/').at(-1)).member);
    if (path===`/guilds/${G}/members` && opts.method==='GET') {
      const limit=Number(req.query.limit);
      assert.ok(Number.isInteger(limit) && limit>=1 && limit<=1000);
      return json(f.roster.filter(m=>BigInt(m.user.id)>BigInt(req.query.after??'0')).slice(0,limit));
    }
    if (path===`/channels/${C}` && opts.method==='GET') return json(origin);
    const dmFor=id=>id===D?f.dm:[...f.others.values()].find(x=>x.dm.id===id)?.dm;
    const dmId=path.split('/')[2];
    if (path===`/channels/${dmId}` && opts.method==='GET' && dmFor(dmId)) return json(dmFor(dmId));
    if (path==='/users/@me/channels' && opts.method==='POST') {
      assert.deepEqual(Object.keys(body),['recipient_id']);
      return json(body.recipient_id===A?f.dm:f.others.get(body.recipient_id).dm);
    }
    if (path===`/channels/${dmId}/messages` && opts.method==='POST' && dmFor(dmId)) {
      const msg=row(body,String(BigInt(POST)+BigInt(f.posts.length)),dmId);
      f.posts.push(req);f.sent=msg;return json(msg);
    }
    if (path===`/channels/${D}/messages/${f.sent?.id}` && opts.method==='PATCH') {
      f.sent=row(body,f.sent.id);return json(f.sent);
    }
    if (/^\/interactions\/\d+\/[^/]+\/callback$/u.test(path) && opts.method==='POST') {
      f.accept.set(path.split('/')[2],body);return new Response(null,{status:204});
    }
    return json({code:10003,message:'Synthetic route not found'},404);
  };
  const setToken=REST.prototype.setToken;
  t.mock.method(REST.prototype,'setToken',function(token){
    this.options.makeRequest=f.makeRequest;
    // Many independent synthetic commands fit in one wall-clock second. Server 429s can still be injected individually.
    this.options.globalRequestsPerSecond=10000;
    return setToken.call(this,token);
  });
  t.mock.method(Client.prototype,'login',async function(token){f.client=this;this.rest.setToken(token);});
  const bot=connectDiscord(store,{DISCORD_BOT_TOKEN:'synthetic-only'});
  t.after(()=>{bot.close();store.close();});
  await bot.start();
  const client=f.client;
  assert.ok(client,'application started with the installed SDK');
  client.user=client.users._add(user(B,true));
  client.isReady=()=>true;
  const guild=client.guilds._add({id:G,name:'Fixture LXR',owner_id:A,roles:[role(G,'@everyone'),role(M,'Stale manager',ADMIN)],
    members:[member(A,[M])],channels:[origin],voice_states:[],member_count:9999});
  guild.available=true;
  client.channels._add(f.dm);
  const pending=new Map();
  for (const event of ['messageCreate','interactionCreate']) {
    const [listener]=client.listeners(event);
    assert.equal(typeof listener,'function');
    client.off(event,listener);
    client.on(event,value=>pending.set(value.id,listener(value)));
  }
  let serial=250000000000000000n;
  f.message=async (content=`+inrole ${R}`,options={})=>{
    const id=String(++serial), channel=options.channel??C;
    client.actions.MessageCreate.handle(inbound({id,content,channel,guild:options.guild===null?undefined:options.guild??G,
      author:options.author??user(A),webhook:options.webhook}));
    assert.ok(pending.has(id),'SDK emitted MessageCreate');
    try {await pending.get(id);} finally {pending.delete(id);}
  };
  f.click=async (customId,options={})=>{
    const id=String(++serial), chan=options.channel??{id:D,type:1};
    const message=options.message??f.sent;
    // Immutable Message identity fields otherwise come from the previous cached event instead of this wire fixture.
    client.channels.cache.get(chan.id)?.messages?.cache.delete(message.id);
    client.actions.InteractionCreate.handle({id,token:'synthetic-component',application_id:options.application??B,type:3,
      data:{component_type:options.component??2,custom_id:customId,...(options.component===3?{values:['missing-item']}: {})},
      channel:chan,message,user:options.user??user(A),version:1,locale:'en-US',app_permissions:'0',entitlements:[],
      authorizing_integration_owners:{'0':options.guild??'0'},
      ...(options.guild?{guild_id:options.guild}: {})});
    assert.ok(pending.has(id),'SDK emitted InteractionCreate');
    try {await pending.get(id);} finally {pending.delete(id);}
    return f.accept.get(id);
  };
  f.patches=()=>f.calls.filter(x=>x.method==='PATCH');
  f.noPublic=()=>assert.equal(f.calls.filter(x=>['POST','PATCH'].includes(x.method) && x.path.startsWith('/channels/') &&
    ![D,...[...f.others.values()].map(x=>x.dm.id)].includes(x.path.split('/')[2])).length,0);
  f.response=json;
  f.members=()=>f.calls.filter(x=>x.method==='GET' && x.path===`/guilds/${G}/members`);
  f.addActor=(actor,channel)=>{
    f.others.set(actor,{member:member(actor,[M]),dm:speaker(actor,channel)});
    f.roster.push(member(actor,[M]));
    f.roster.sort((a,b)=>BigInt(a.user.id)<BigInt(b.user.id)?-1:1);
  };
  return f;
}

function expectPage(message,roleName,total,page,rows) {
  const {embeds:[embed],components:[controls]}=message;
  assert.equal(embed.title,`${roleName} (${total})`);
  assert.equal(embed.footer.text,`${page} / ${Math.max(1,Math.ceil(total/20))}`);
  assert.deepEqual(embed.description.split('\n'),rows.length?rows.map(line):['لا يوجد أعضاء بهذا الرول.']);
  assert.equal(controls.type,1);
  assert.deepEqual(controls.components.map(b=>[b.type,b.style,b.emoji.name,b.disabled]),
    [[2,1,'⬅️',page===1],[2,1,'➡️',page===Math.max(1,Math.ceil(total/20))]]);
  assert.equal(new Set(controls.components.map(b=>b.custom_id)).size,2);
}
const control=(f,direction=1)=>f.sent.components[0].components[direction].custom_id;

test('a native guild MessageCreate delivers the exact role total and first 20 rows only to the verified DM',async t=>{
  const f=await fixture(t);
  await f.message(`+inrole <@&${R}>`);
  assert.equal(f.posts.length,1,'authorized invocation must send one verified DM roster');
  assert.deepEqual(f.posts[0].body.allowed_mentions,none);
  expectPage(f.sent,'Actual Discord role',23,1,f.idList.slice(0,20));
  f.noPublic();
});

test('native buttons edit the exact DM message to page two and back without reviving an old button',async t=>{
  const f=await fixture(t);
  await f.message();
  const original=f.sent, next=control(f);
  assert.deepEqual(await f.click(next),{type:6});
  assert.equal(f.posts.length,1);
  assert.equal(f.patches().length,1);
  assert.equal(f.patches()[0].path,`/channels/${D}/messages/${POST}`);
  assert.deepEqual(f.patches()[0].body.allowed_mentions,none);
  expectPage(f.sent,'Actual Discord role',23,2,f.idList.slice(20));
  assert.deepEqual(await f.click(control(f,0)),{type:6});
  expectPage(f.sent,'Actual Discord role',23,1,f.idList.slice(0,20));
  assert.equal(await f.click(next,{message:original}),undefined);
  assert.equal(f.patches().length,2);
  f.noPublic();
});

test('the existing DM text help lists the usage only after fresh authorization and verified DM scope',async t=>{
  const f=await fixture(t);
  const {helpText,commands,parseChat}=require('../src/commands');
  await f.message('+help',{channel:D,guild:null});
  assert.match(f.posts[0].body.content,/\+inrole/u);
  assert.ok(f.posts[0].body.content.startsWith(helpText));
  assert.ok(f.posts[0].body.content.length<=2000);
  f.actor=member(A);
  await f.message('+help',{channel:D,guild:null});
  assert.equal(f.posts[1].body.content,helpText);
  assert.ok(!commands.some(c=>c.name==='inrole'));
  assert.equal(parseChat(`+inrole ${R}`),null);
  assert.throws(()=>f.store.shortcuts.add('INROLE','/ban',A),{status:409});
  assert.ok(!require('../src/custom-shortcuts').commandGuide(f.store.shortcuts).some(c=>c.name==='+inrole'));
  f.noPublic();
});

test('an empty managed role is an exact zero with disabled endpoints',async t=>{
  const f=await fixture(t,0);
  await f.message();
  expectPage(f.sent,'Actual Discord role',0,1,[]);
  assert.equal(await f.click(control(f)),undefined);
  assert.equal(f.patches().length,0);
  f.noPublic();
});

test('@everyone includes every API member, even absent an explicit assignment',async t=>{
  const f=await fixture(t,3);
  f.roster[1].user.bot=true;
  await f.message(`+inrole ${G}`);
  expectPage(f.sent,'@everyone',4,1,[A,...f.idList]);
  f.noPublic();
});

test('owner and Administrator authorize without an explicit Manage Roles bit',async t=>{
  const f=await fixture(t);
  f.actor=member(A);
  f.guild.owner_id=A;
  await f.message();
  assert.equal(f.posts.length,1);
  f.guild.owner_id=O;
  f.actor=member(A,[M]);
  f.inventory[1].permissions=ADMIN;
  await f.message();
  assert.equal(f.posts.length,2);
  f.noPublic();
});

test('stale gateway ownership and role permissions never authorize a nonmember or unprivileged actor',async t=>{
  const f=await fixture(t);
  for (const bad of [null,member(OTHER,[M]),member(A),member(A,[OTHER]),{...member(A,[M]),pending:true},member(A,[M],true)]) {
    f.actor=bad;
    await f.message();
    await f.message('+inrole');
  }
  f.actor=member(A,[M]);
  f.inventory[1].permissions='0';
  await f.message();
  f.inventory[1].permissions=MANAGE;
  f.guild.id=OTHER;
  await f.message();
  assert.equal(f.posts.length,0);
  assert.equal(f.members().length,0);
  assert.ok(!f.calls.some(x=>x.path==='/users/@me/channels'));
  f.noPublic();
});

test('bare and invalid syntax gets private usage only, without looking up a roster',async t=>{
  const f=await fixture(t);
  const inputs=['+inrole',`+inrole <@${R}>`,`+inrole 0${R}`,'+inrole 18446744073709551616',
    `+inrole ${R} ${M}`,`+inrole\n${R}`,'+inrole １２３４５６７８９０１２３４５６７８','+inrole 1'];
  for (const input of inputs) await f.message(input);
  assert.equal(f.posts.length,inputs.length);
  for (const {body} of f.posts) {
    assert.match(body.content,/^الاستخدام:/u);
    assert.deepEqual(body.allowed_mentions,none);
    assert.equal(body.embeds,undefined);
  }
  await f.message(`+inrole ${OTHER}`);
  assert.match(f.posts.at(-1).body.content,/ما لقيت/u);
  assert.equal(f.members().length,0);
  f.noPublic();
});

test('nonmatching text and roulette DM select keep their existing interaction and XP paths',async t=>{
  const f=await fixture(t);
  const foreign='200000000000000055';
  f.client.guilds._add({id:foreign,name:'other',owner_id:A,roles:[],members:[],channels:[{...origin,id:OTHER,guild_id:foreign}],voice_states:[]});
  await f.message('+inroleX');
  await f.message(`+INROLE ${R}`);
  await f.message(`+ inrole ${R}`);
  await f.message(`+inrole ${R}`,{channel:OTHER,guild:foreign});
  await f.message(`+inrole ${R}`,{channel:D,guild:null});
  await f.message(`+inrole ${R}`,{author:user(B,true)});
  await f.message(`+inrole ${R}`,{webhook:OTHER});
  assert.equal(f.calls.filter(x=>x.path===`/guilds/${G}`).length,0);
  f.store.community.saveSettings({...f.store.community.settings(),levels:true});
  assert.equal(f.store.community.xp(A),0);
  await f.message('normal guild chat mentioning +inrole');
  assert.ok(f.store.community.xp(A)>0);

  assert.equal(f.posts.length,0);
  const gameMessage={...inbound({id:POST,author:user(B,true),content:'',channel:D})};
  const roulette=await f.click('blgshop:equip',{component:3,message:gameMessage});
  assert.equal(roulette?.type,4); // Existing economy handler privately rejects the synthetic unknown item.
  assert.match(roulette.data.content,/إطار/u);
  f.noPublic();
});

test('private ticket and newly moved application channel do not run the roster command',async t=>{
  const f=await fixture(t);
  const ticket=f.store.community.reserveTicket('isolated',A,'private','staff-complaint','');
  f.store.community.setChannel(ticket.id,C);
  await f.message();
  assert.equal(f.calls.filter(x=>x.path===`/guilds/${G}`).length,0);
  f.store.community.ticketRemoved(C);
  const category='200000000000000056';
  f.overrides.set(`GET /channels/${C}`,()=>({...origin,parent_id:category}));
  f.overrides.set(`GET /channels/${category}`,()=>({...origin,id:category,type:4,name:'تقديم اداره'}));
  await f.message();
  assert.equal(f.calls.filter(x=>x.path===`/guilds/${G}`).length,0);
  assert.equal(f.posts.length,0);
  f.noPublic();
});

test('multi-page REST enumeration uses exact BigInt cursors and ignores the stale cache count',async t=>{
  const f=await fixture(t,1004);
  f.roster[0].roles=[M,R];
  f.roster[1000].roles=[];
  await f.message();
  const want=[A,...f.idList.filter((_,i)=>i!==999)];
  expectPage(f.sent,'Actual Discord role',1004,1,want.slice(0,20));
  assert.deepEqual(f.members().map(x=>x.query),[{limit:'1000'},
    {limit:'1000',after:f.idList[998]},{limit:'1000',after:f.idList.at(-1)}]);
  assert.equal(f.client.guilds.cache.get(G).memberCount,9999);
  f.noPublic();
});

test('fresh permissions after a roster GET prevent delivery and stop additional API pages',async t=>{
  const f=await fixture(t,1004);
  f.overrides.set(`GET /guilds/${G}/members`,()=>{f.inventory[1].permissions='0';});
  await f.message();
  assert.equal(f.members().length,1);
  assert.equal(f.posts.length,0);
  f.noPublic();
});

test('revocation after the terminal API page still blocks the initial DM',async t=>{
  const f=await fixture(t);
  f.overrides.set(`GET /guilds/${G}/members`,({query})=>{if(query.after) f.actor=member(A);});
  await f.message();
  assert.equal(f.members().length,2);
  assert.equal(f.posts.length,0);
  f.noPublic();
});

test('duplicate, damaged, out-of-order, missing and inaccessible roster responses fail privately without a total',async t=>{
  const f=await fixture(t);
  const list=`GET /guilds/${G}/members`, rows=f.roster;
  for (const result of [[rows[0],rows[0]],[rows[1],rows[0]],[...rows.slice(1)],
    [rows[0],{...rows[1],user:null}],[rows[0],{...rows[1],roles:null}],
    [rows[0],{...rows[1],roles:[R,R]}],{members:rows},f.response({code:50001,message:'Missing Access'},403)]) {
    f.overrides.set(list,({query})=>query.after?[]:result);
    await f.message();
  }
  f.overrides.set(list,({query})=>query.after?[rows.at(-1)]:rows);
  await f.message(); // Duplicate across a page boundary.
  assert.equal(f.posts.length,9);
  for (const {body} of f.posts) {
    assert.match(body.content,/تعذّر تأكيد/u);
    assert.equal(body.embeds,undefined);
    assert.equal(body.components,undefined);
    assert.ok(!body.content.includes(R));
  }
  f.noPublic();
});

test('closed DMs and malformed DM verification never fall back to a public message',async t=>{
  const f=await fixture(t);
  for (const dm of [{...f.dm,type:3},{...f.dm,guild_id:G},speaker(OTHER,D),{...f.dm,recipients:[user(A),user(OTHER)]}]) {
    f.overrides.set('POST /users/@me/channels',()=>dm);
    await f.message();
  }
  assert.equal(f.members().length,0);
  f.overrides.delete('POST /users/@me/channels');
  f.overrides.set(`POST /channels/${D}/messages`,()=>f.response({code:50007,message:'Cannot send messages to this user'},403));
  await f.message();
  assert.equal(f.calls.filter(x=>x.method==='POST' && x.path===`/channels/${D}/messages`).length,1);
  assert.equal(f.posts.length,0);
  f.noPublic();
});

test('foreign, disabled, forged and malformed clicks cannot disclose a page',async t=>{
  const f=await fixture(t);
  await f.message();
  const next=control(f), old=f.sent;
  const group={id:OTHER,type:3,recipients:[user(A),user(O)]};
  const cases=[[next,{user:user(OTHER)}],[next,{channel:group}],[next,{guild:G,channel:origin}],
    [next,{channel:speaker(A,OTHER)}],[next,{message:{...old,channel_id:OTHER}}],[next,{message:{...old,id:OTHER}}],
    [next,{message:{...old,author:user(OTHER,true)}}],[next,{message:{...old,guild_id:G}}],
    [next,{message:{...old,components:[]}}],[next,{application:OTHER}],[next,{component:3}],[control(f,0),{}],
    [next+'x',{}],['lxr-inrole:bogus',{}]];
  for (const [index,[id,opts]] of cases.entries()) assert.equal(await f.click(id,opts),undefined,`forgery ${index}`);
  assert.equal(f.patches().length,0);
  assert.equal(f.accept.size,0);
  assert.deepEqual(await f.click(next,{message:old}),{type:6});
  assert.equal(f.patches().length,1);
  f.noPublic();
});

test('button authority and verified DM are checked fresh before any page is written',async t=>{
  const f=await fixture(t);
  await f.message();
  let lookup=false;
  f.overrides.set(`GET /channels/${D}`,()=>{lookup=true;f.actor=member(A);});
  assert.deepEqual(await f.click(control(f)),{type:6});
  assert.ok(lookup);
  assert.equal(f.patches().length,0);
  f.actor=member(A,[M]);
  f.overrides.delete(`GET /channels/${D}`);
  assert.equal(await f.click(control(f)),undefined); // Invalidated on revocation.
  await f.message();
  f.dm=speaker(OTHER,D);
  assert.deepEqual(await f.click(control(f)),{type:6});
  assert.equal(f.patches().length,0);
  f.noPublic();
});

const gate=()=>{let resolve;const wait=new Promise(r=>{resolve=r;});return {wait,resolve};};

test('concurrent valid clicks claim once and an in-flight page edit cannot race replacement',async t=>{
  const f=await fixture(t,43);
  await f.message();
  const message=f.sent, next=control(f), entered=gate(), release=gate();
  f.overrides.set(`GET /channels/${D}`,async()=>{entered.resolve();await release.wait;});
  const first=f.click(next,{message});
  await entered.wait;
  try {
    assert.equal(await f.click(next,{message}),undefined);
    await f.message();
    assert.equal(f.posts.length,1);
  } finally {release.resolve();}
  assert.deepEqual(await first,{type:6});
  assert.equal(f.patches().length,1);
  expectPage(f.sent,'Actual Discord role',43,2,f.idList.slice(20,40));
  f.noPublic();
});

test('replacement, expiry and capacity remove old button authority',async t=>{
  const f=await fixture(t);
  await f.message();
  const first=f.sent, firstButton=control(f);
  await f.message();
  assert.notEqual(control(f).split(':')[1],firstButton.split(':')[1]);
  assert.equal(await f.click(firstButton,{message:first}),undefined);
  const second=f.sent, secondButton=control(f);
  for (let i=0n;i<12n;i++) {
    const actor=String(210000000000000000n+i), channel=String(220000000000000000n+i);
    f.addActor(actor,channel);
    await f.message(undefined,{author:user(actor)});
  }
  assert.equal(f.posts.length,14);
  assert.equal(await f.click(secondButton,{message:second}),undefined); // Oldest session evicted.
  await f.message();
  const before=Date.now();
  t.mock.method(Date,'now',()=>before+5*60_000+1_000);
  assert.equal(await f.click(control(f)),undefined);
  assert.equal(f.patches().length,0);
  f.noPublic();
});

test('known application-room receipts keep a moved, renamed ticket private',async t=>{
  const f=await fixture(t);
  assert.ok(f.store.applicationRooms.create(C,{fixture:true},{}));
  await f.message();
  assert.equal(f.calls.filter(x=>x.path===`/guilds/${G}`).length,0);
  assert.equal(f.posts.length,0);
  f.noPublic();
});

test('ambiguous transport writes do not retry or reactivate old pagination',async t=>{
  const f=await fixture(t);
  const send=`POST /channels/${D}/messages`;
  f.overrides.set(send,()=>f.response({message:'Synthetic failure'},503));
  await f.message();
  assert.equal(f.calls.filter(x=>x.method==='POST' && x.path===`/channels/${D}/messages`).length,1);
  f.overrides.delete(send);
  await f.message();
  const edit=`PATCH /channels/${D}/messages/${f.sent.id}`;
  f.overrides.set(edit,()=>f.response({message:'Synthetic failure'},503));
  const next=control(f);
  assert.deepEqual(await f.click(next),{type:6});
  assert.equal(await f.click(next),undefined);
  assert.equal(f.patches().length,1);
  f.noPublic();
});
