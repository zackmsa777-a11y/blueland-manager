'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const {crc32,deflateSync}=require('node:zlib');
const {REST,RateLimitError,Routes}=require('discord.js');
const {createApplicationMutationRest}=require('../src/lxr-apply-tickets');
const {openTempVoiceStore}=require('../src/lxr-temp-voice-store');

const APP='120000000000000001';
const OTHER_APP='120000000000000002';
const PANEL='120000000000000003';
const ROOM='120000000000000004';
const OWNER='120000000000000005';
const ACTIONS='name limit privacy waiting trust untrust invite disconnect region block unblock claim transfer delete chat'.split(' ');
const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');
const emojiId=index=>String(120000000000000100n+BigInt(index));

function png(seed,alpha=0) {
  function chunk(name,body) {
    const length=Buffer.alloc(4),crc=Buffer.alloc(4);
    const data=Buffer.concat([Buffer.from(name),body]);
    length.writeUInt32BE(body.length);
    crc.writeUInt32BE(crc32(data));
    return Buffer.concat([length,data,crc]);
  }
  const header=Buffer.from([0,0,0,2,0,0,0,1,8,6,0,0,0]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.from([0,seed,10,20,255,0,0,0,alpha]))),chunk('IEND',Buffer.alloc(0))]);
}

function fixtureArt() {
  return Object.fromEntries(ACTIONS.map((key,index)=>{
    const bytes=png(index),sha=sha256(bytes);
    return [key,{name:`embedvc_${key}_${sha.slice(0,8)}`,png:bytes.toString('base64'),sha256:sha}];
  }));
}

const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,
  headers:{'content-type':'application/json',...headers}});

function discord(art,{missing=['name'],onPost,onGet,fetchEmoji}={}) {
  const bot={id:APP,bot:true};
  const items=Object.entries(art).flatMap(([key,{name}],index)=>missing.includes(key)?[]:[{id:emojiId(index),name,animated:false,user:bot}]);
  items.push({id:emojiId(50),name:'unrelated',animated:false});
  const calls=[];
  const route=Routes.applicationEmojis(APP);
  const makeRequest=async(url,{method,body,headers})=>{
    assert.equal(new URL(url).pathname,`/api/v10${route}`);
    assert.equal(new Headers(headers).get('authorization'),'Bot fixture-only');
    calls.push(method);
    if(method==='GET') return onGet?.({items,calls}) ?? json({items});
    assert.equal(method,'POST');
    const request=JSON.parse(body);
    assert.deepEqual(Object.keys(request).sort(),['image','name']);
    const index=Object.values(art).findIndex(asset=>asset.name===request.name);
    assert.notEqual(index,-1);
    assert.equal(request.image,`data:image/png;base64,${Object.values(art)[index].png}`);
    const row={id:emojiId(index),name:request.name,animated:false,user:bot};
    if(onPost) return onPost({items,row,calls});
    items.push(row);
    return json(row,201);
  };
  const read=new REST({makeRequest,offset:0,retries:0,rejectOnRateLimit:()=>true}).setToken('fixture-only');
  read.clearHashSweeper();read.clearHandlerSweeper();
  const writer=createApplicationMutationRest('fixture-only',{makeRequest,offset:0});
  const guild={id:PANEL,client:{user:bot,application:{id:APP},rest:read}};
  let writers=0;
  const getWriter=()=>{writers++;return writer;};
  const cdn=[];
  const fetchImage=(url,options)=>{
    const index=Object.values(art).findIndex((_,i)=>url===`https://cdn.discordapp.com/emojis/${emojiId(i)}.png`);
    assert.notEqual(index,-1,'only exact, original Discord CDN emoji paths may be read');
    assert.equal(options.redirect,'error');
    cdn.push(index);
    return fetchEmoji?.(index) ?? new Response(Buffer.from(Object.values(art)[index].png,'base64'));
  };
  return {guild,items,calls,cdn,getWriter,fetchImage,writerCount:()=>writers};
}

function provider(state,api,art) {
  const {createTempVoiceEmojiProvider}=require('../src/lxr-temp-voice-emoji');
  return createTempVoiceEmojiProvider({state,getWriter:api.getWriter,art,fetchImage:api.fetchImage});
}

function database(t) {
  const dir=mkdtempSync(join(tmpdir(),'lxr-emoji-'));
  const path=join(dir,'state.sqlite');
  let db;
  t.after(()=>{db?.close();rmSync(dir,{recursive:true,force:true});});
  return ()=>{
    db?.close();
    db=new DatabaseSync(path);
    return {db,state:openTempVoiceStore(db)};
  };
}

test('preexisting legacy panel reservations are independent of embed reservations across restart',t=>{
  const reopen=database(t);
  let {db,state}=reopen();
  assert.equal(state.begin(OWNER,'room-marker','session',[]),true);
  assert.equal(state.bind(OWNER,'room-marker',ROOM).id,ROOM);
  assert.equal(state.reservePanelPublication(PANEL),true);
  assert.equal(state.reservePanelPublication(ROOM,true),true);
  db.exec('DROP TABLE IF EXISTS lxr_temp_voice_panel_embed_reservation'); // emulate the previous live schema

  ({db,state}=reopen());
  assert.equal(state.reservePanelPublication(PANEL,false,'v1'),false);
  assert.equal(state.reservePanelPublication(ROOM,true,'v1'),false);
  assert.equal(state.reservePanelPublication(PANEL,false,'embed'),true);
  assert.equal(state.reservePanelPublication(ROOM,true,'embed'),true);
  assert.equal(state.reservePanelPublication(OTHER_APP,true,'embed'),false);

  ({db,state}=reopen());
  assert.equal(state.releasePanelPublication(PANEL,true,'embed'),false);
  assert.equal(state.releasePanelPublication(ROOM,false,'embed'),false);
  assert.equal(state.reservePanelPublication(PANEL,false,'embed'),false);
  assert.equal(state.reservePanelPublication(ROOM,true,'embed'),false);
  assert.equal(state.releasePanelPublication(PANEL,false,'embed'),true);
  assert.equal(state.reservePanelPublication(PANEL),false);
  assert.throws(()=>state.reservePanelPublication(PANEL,false,'wrong'),TypeError);
  assert.throws(()=>state.releasePanelPublication(PANEL,false,'wrong'),TypeError);
  assert.equal(state.remove(ROOM),true);
  for(const table of ['lxr_temp_voice_panel_reservation','lxr_temp_voice_panel_embed_reservation']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE channel_id=?`).get(ROOM).n,0);
  }
});

test('mismatched artwork under an exact name in genuine authenticated inventory is never bound or used',async t=>{
  const art=fixtureArt(),api=discord(art,{missing:[]}),reopen=database(t);
  const wrong=png(149),requests=[];
  const {createTempVoiceEmojiProvider}=require('../src/lxr-temp-voice-emoji');
  for(let attempt=0;attempt<2;attempt++) {
    const {state}=reopen();
    const get=createTempVoiceEmojiProvider({state,getWriter:api.getWriter,art,fetchImage:(url,options)=>{
      requests.push(url);
      assert.equal(options.redirect,'error');
      assert.equal(url,`https://cdn.discordapp.com/emojis/${emojiId(0)}.png`);
      return new Response(wrong);
    }});
    await assert.rejects(get(api.guild),/artwork not verified/);
    assert.equal(state.getEmojiPublication(APP,art.name.name,art.name.sha256),null);
  }
  assert.deepEqual(requests,Array(2).fill(`https://cdn.discordapp.com/emojis/${emojiId(0)}.png`));
  assert.deepEqual(api.calls,['GET','GET']);
  assert.equal(api.writerCount(),0);
});

test('an R1 name-only row remains an identity fence, not proof of artwork',async t=>{
  const art=fixtureArt(),reopen=database(t);
  const {db}=reopen();
  db.exec(`DROP TABLE lxr_temp_voice_emoji_publication;
    CREATE TABLE lxr_temp_voice_emoji_publication (
      application_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, attempt TEXT, emoji_id TEXT,
      PRIMARY KEY (application_id,name), CHECK(attempt IS NOT NULL OR emoji_id IS NOT NULL)
    ) STRICT`);
  db.prepare('INSERT INTO lxr_temp_voice_emoji_publication VALUES (?,?,?,NULL,?)')
    .run(APP,art.name.name,art.name.sha256,emojiId(0));
  const api=discord(art,{missing:[],fetchEmoji:index=>index===0?new Response(png(149)):undefined});
  const {state}=reopen();
  await assert.rejects(provider(state,api,art)(api.guild),/artwork not verified/);
  const record=state.getEmojiPublication(APP,art.name.name,art.name.sha256);
  assert.equal(record.id,emojiId(0));
  assert.equal(record.proof,null);
  assert.deepEqual(api.calls,['GET']);
});

test('creates only the missing application emoji, reads the exact list back and shares concurrent requests',async t=>{
  const reopen=database(t);
  const art=fixtureArt(),api=discord(art);
  const get=provider(reopen().state,api,art);
  const [icons,concurrent]=await Promise.all([get(api.guild),get(api.guild)]);
  assert.deepEqual(icons,Object.fromEntries(ACTIONS.map((key,index)=>[key,{id:emojiId(index),name:art[key].name}])));
  assert.deepEqual(concurrent,icons);
  assert.deepEqual(api.calls,['GET','POST','GET']);
  assert.equal(api.items.find(row=>row.name==='unrelated').id,emojiId(50));
  assert.deepEqual(await provider(reopen().state,api,art)(api.guild),icons);
  assert.deepEqual(api.calls,['GET','POST','GET','GET']);
  assert.equal(api.writerCount(),1);
});

test('concurrent clients for the same exact application cannot issue overlapping requests',async t=>{
  const art=fixtureArt();
  let postEntered,allowPost;
  const entered=new Promise(resolve=>{postEntered=resolve;});
  const allowed=new Promise(resolve=>{allowPost=resolve;});
  const api=discord(art,{async onPost({items,row}) {
    postEntered();
    await allowed;
    items.push(row);
    return json(row,201);
  }});
  const alternate=discord(art,{missing:[]});
  const get=provider(database(t)().state,api,art);
  const first=get(api.guild);
  await entered;
  const second=get(alternate.guild);
  const awaited=Promise.all([first,second]);
  await new Promise(resolve=>setImmediate(resolve));
  const requestsDuringPost=[...alternate.calls];
  allowPost();
  const [a,b]=await awaited;
  assert.deepEqual(requestsDuringPost,[]);
  assert.deepEqual(a,b);
  assert.deepEqual(api.calls,['GET','POST','GET']);
  assert.deepEqual(alternate.calls,['GET']);
});

test('the default assets provision exactly 15 approved PNGs through the real SDK transport',async t=>{
  const {art}=require('../src/lxr-temp-voice-emoji-art');
  const api=discord(art,{missing:ACTIONS});
  const get=provider(database(t)().state,api);
  const icons=await get(api.guild);
  assert.deepEqual(Object.keys(icons),ACTIONS);
  assert.deepEqual(api.calls,['GET',...ACTIONS.flatMap(()=>['POST','GET'])]);
  assert.equal(api.writerCount(),1);
  assert.deepEqual(Object.values(icons).map(x=>x.name),Object.values(art).map(x=>x.name));
  for(const {png,sha256:digest} of Object.values(art)) {
    const bytes=Buffer.from(png,'base64');
    assert.equal(sha256(bytes),digest);
    assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[128,128]);
  }
});

test('an exact application POST SDK 429 frees only its refused attempt for a later request',async t=>{
  const art=fixtureArt(),reopen=database(t);
  let refused=true,state=reopen().state;
  assert.ok(state.reserveEmojiPublication(OTHER_APP,art.name.name,art.name.sha256));
  const api=discord(art,{onPost({items,row}) {
    assert.equal(state.getEmojiPublication(APP,row.name,art.name.sha256).id,null);
    if(refused) return json({message:'rate limited',retry_after:0.01},429,{'retry-after':'0.01'});
    items.push(row);
    return json(row,201);
  }});
  await assert.rejects(provider(state,api,art)(api.guild),/rate limited/);
  assert.deepEqual(api.calls,['GET','POST']);
  state=reopen().state;
  assert.equal(state.getEmojiPublication(APP,art.name.name,art.name.sha256),null);
  assert.equal(state.getEmojiPublication(OTHER_APP,art.name.name,art.name.sha256).id,null);
  refused=false;
  assert.equal((await provider(state,api,art)(api.guild)).name.id,emojiId(0));
  assert.deepEqual(api.calls,['GET','POST','GET','POST','GET']);
});

test('a committed POST with its response lost recovers only from independently matching artwork',async t=>{
  const art=fixtureArt(),reopen=database(t);
  const api=discord(art,{onPost({items,row}) {
    items.push(row);
    throw new Error('synthetic lost response');
  }});
  assert.equal((await provider(reopen().state,api,art)(api.guild)).name.id,emojiId(0));
  assert.equal((await provider(reopen().state,api,art)(api.guild)).name.id,emojiId(0));
  assert.deepEqual(api.calls,['GET','POST','GET','GET']);
  assert.equal(api.cdn.filter(index=>index===0).length,1,'independent proof is required once, not after binding');
  assert.equal(reopen().state.getEmojiPublication(APP,art.name.name,art.name.sha256).proof,'cdn');
});

test('a lost upload cannot bind transformed bytes or replay the POST after restart',async t=>{
  const art=fixtureArt(),reopen=database(t);
  const api=discord(art,{onPost({items,row}) {
    items.push(row);
    throw new Error('no upload receipt');
  },fetchEmoji:index=>index===0?new Response(png(200)):undefined});
  for(let attempt=0;attempt<2;attempt++) {
    const {state}=reopen();
    await assert.rejects(provider(state,api,art)(api.guild),/artwork not verified/);
    assert.equal(state.getEmojiPublication(APP,art.name.name,art.name.sha256).id,null);
  }
  assert.deepEqual(api.calls,['GET','POST','GET','GET']);
  assert.equal(api.writerCount(),1);
});

test('a successful POST without the exact creating app bot is not an upload receipt',async t=>{
  const art=fixtureArt(),reopen=database(t);
  const api=discord(art,{onPost({items,row}) {
    items.push(row);
    return json({...row,user:{id:OTHER_APP,bot:true}},201);
  }});
  const {state}=reopen();
  await assert.rejects(provider(state,api,art)(api.guild),/invalid temporary voice emoji publication receipt/i);
  assert.equal(state.getEmojiPublication(APP,art.name.name,art.name.sha256).id,null);
  assert.equal(api.cdn.includes(0),false);
});

test('an exact-looking POST receipt cannot reuse an ID previously listed under an unrelated name',async t=>{
  const art=fixtureArt(),{state}=database(t)();
  const api=discord(art,{onPost({items,row}) {
    const reused=items.find(emoji=>emoji.name==='unrelated');
    Object.assign(reused,{...row,id:reused.id});
    return json(reused,201);
  }});
  await assert.rejects(provider(state,api,art)(api.guild),/invalid temporary voice emoji publication receipt/i);
  assert.equal(state.getEmojiPublication(APP,art.name.name,art.name.sha256).id,null);
  assert.deepEqual(api.calls,['GET','POST']);
});

test('an unconfirmed POST remains fenced across restart until independently matching bytes appear',async t=>{
  const art=fixtureArt(),reopen=database(t);
  const api=discord(art,{missing:['name','limit'],onPost:()=>json({message:'write uncertain'},503)});
  await assert.rejects(provider(reopen().state,api,art)(api.guild),/not confirmed/);
  await assert.rejects(provider(reopen().state,api,art)(api.guild),/not confirmed/);
  assert.deepEqual(api.calls,['GET','POST','GET','GET']);
  assert.equal(api.writerCount(),1);
  api.items.push({id:emojiId(0),name:art.name.name,animated:false});
  await assert.rejects(provider(reopen().state,api,art)(api.guild),/not confirmed/);
  assert.deepEqual(api.calls,['GET','POST','GET','GET','GET','POST','GET']);
});

test('a readback 429 retains the exact POST receipt; inventory must agree but optimized CDN bytes do not invalidate it',async t=>{
  const art=fixtureArt(),reopen=database(t);
  let throttle=true;
  const api=discord(art,{onGet({calls}) {
    if(throttle&&calls.length>1) return json({message:'rate limited',retry_after:0.01},429,{'retry-after':'0.01'});
  },fetchEmoji:index=>index===0?new Response(png(200)):undefined});
  await assert.rejects(provider(reopen().state,api,art)(api.guild),RateLimitError);
  assert.equal(reopen().state.getEmojiPublication(APP,art.name.name,art.name.sha256).proof,'upload');
  throttle=false;
  const row=api.items.find(row=>row.name===art.name.name);
  row.id=emojiId(55);
  const get=provider(reopen().state,api,art);
  await assert.rejects(get(api.guild),/identity changed/);
  row.id=emojiId(0);
  assert.equal((await get(api.guild)).name.id,emojiId(0));
  assert.equal(api.cdn.includes(0),false,'a known upload receipt must never rely on the CDN encoding');
  assert.deepEqual(api.calls,['GET','POST','GET','GET','GET']);
});

test('a 429 for a different route cannot release a reserved application emoji',async t=>{
  const art=fixtureArt(),reopen=database(t);
  const api=discord(art,{onPost() {
    throw new RateLimitError({method:'POST',url:`https://discord.com/api/v10${Routes.applicationEmojis(OTHER_APP)}`});
  }});
  await assert.rejects(provider(reopen().state,api,art)(api.guild),/not confirmed/);
  await assert.rejects(provider(reopen().state,api,art)(api.guild),/not confirmed/);
  assert.deepEqual(api.calls,['GET','POST','GET','GET']);
});

test('wrong application or guild scope and duplicate exact rows fail before any POST',async t=>{
  const art=fixtureArt(),state=database(t)().state;
  for(const [label,modify] of Object.entries({
    'conflicting SDK application':api=>{api.guild.client.application.id=OTHER_APP;},
    'explicit guild-scoped emoji':api=>{api.items[0].guild_id=PANEL;},
    'explicit wrong application row':api=>{api.items[0].application_id=OTHER_APP;},
    'role restriction':api=>{api.items[0].roles=[OWNER];},
    'duplicate exact name':api=>{api.items.push({...api.items[0],id:emojiId(51)});},
    'duplicate ID':api=>{api.items.push({name:'unrelated_alias',id:api.items[0].id,animated:false});},
  })) await t.test(label,async()=>{
    const api=discord(art);
    modify(api);
    await assert.rejects(provider(state,api,art)(api.guild),/application emoji|emoji application/);
    assert.equal(api.calls.includes('POST'),false);
    assert.equal(api.writerCount(),0);
  });
  const api=discord(art,{onGet:({items})=>json({items,application_id:OTHER_APP})});
  await assert.rejects(provider(state,api,art)(api.guild),/inventory/);
  assert.deepEqual(api.calls,['GET']);
});

test('malformed or unapproved asset bytes and names fail before any Discord request',async t=>{
  const state=database(t)().state;
  function replace(art,bytes) {
    const digest=sha256(bytes);
    art.name={name:`embedvc_name_${digest.slice(0,8)}`,png:bytes.toString('base64'),sha256:digest};
  }
  for(const [label,modify] of Object.entries({
    'missing action':art=>{delete art.chat;},
    'extra action':art=>{art.unknown={...art.name};},
    'unexpected name':art=>{art.name.name='unrelated';},
    'wrong digest':art=>{art.name.png=art.limit.png;},
    'noncanonical base64':art=>{art.name.png+='\n';},
    'non-PNG bytes':art=>replace(art,Buffer.from('not a PNG')),
    'truncated PNG':art=>replace(art,png(1).subarray(0,-1)),
    'opaque PNG':art=>replace(art,png(1,255)),
  })) await t.test(label,()=>{
    const art=fixtureArt(),api=discord(art);
    modify(art);
    assert.throws(()=>provider(state,api,art),/Invalid temporary voice emoji/);
    assert.deepEqual(api.calls,[]);
  });
});
