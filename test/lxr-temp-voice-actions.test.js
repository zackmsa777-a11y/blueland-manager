'use strict';

const assert = require('node:assert/strict');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {test} = require('node:test');
const {Client, ChannelType, GatewayIntentBits, OverwriteType, PermissionFlagsBits: P, PermissionOverwrites, RateLimitError, Routes, Status} = require('discord.js');
const {createApplicationMutationRest} = require('../src/lxr-apply-tickets');
const {openTempVoiceStore} = require('../src/lxr-temp-voice-store');
const load = () => require('../src/lxr-temp-voice-actions.js');
const sid = n => `207000000000000${String(n).padStart(3, '0')}`;
const guildId = sid(1), categoryId = sid(2), lobbyId = sid(3), panelId = sid(4), roomId = sid(5);
const owner = sid(6), guest = sid(7), other = sid(8), bot = sid(9), guildOwner = sid(10), otherRoom = sid(11);
const allowed = sid(12), denied = sid(13), admin = sid(14), base = P.ViewChannel | P.Connect | P.SendMessages;
const acl = (id, type, allow = 0n, deny = 0n) => PermissionOverwrites.resolve({id, type, allow, deny});
const roleAcl = (id, allow, deny) => acl(id, OverwriteType.Role, allow, deny);
const memberAcl = (id, allow, deny) => acl(id, OverwriteType.Member, allow, deny);
const channel = (id, type, extra = {}) => ({id, type, guild_id:guildId, name:'synthetic', parent_id:null,
  permission_overwrites:[], ...(type === ChannelType.GuildVoice ? {rtc_region:null, user_limit:0, bitrate:64000} : {}), ...extra});
const member = (id, roles = []) => ({user:{id, username:`u${id}`, bot:id===bot}, roles, joined_at:'2026-01-01T00:00:00Z'});
const role = (id, permissions = 0n) => ({id, name:id, permissions:String(permissions), position:id===guildId ? 0 : 1});
const missing = code => Object.assign(new Error('raw transport error must not leak'), {code, status:404});
const deny = async (result,pattern) => assert.match(await result,pattern);

function fixture(t, permissionOverwrites = [], everyone = base, dbPath = ':memory:') {
  const client = new Client({intents:[GatewayIntentBits.GuildVoiceStates]}); t.after(() => client.destroy()); client.user = {id:bot};
  const wire = {
    conns:new Map(), reads:[], writes:[], writerRequests:0, beforeRead:null, beforeWrite:null, afterWrite:null, writeResponse:null,
    channels:new Map([
      channel(categoryId, ChannelType.GuildCategory, {permission_overwrites:permissionOverwrites}),
      channel(panelId, ChannelType.GuildText), channel(lobbyId, ChannelType.GuildVoice, {parent_id:categoryId}),
      channel(roomId, ChannelType.GuildVoice, {parent_id:categoryId, permission_overwrites:permissionOverwrites}),
      channel(otherRoom, ChannelType.GuildVoice, {parent_id:categoryId}),
    ].map(c => [c.id, structuredClone(c)])),
    members:new Map([member(owner), member(guest), member(other), member(bot,[admin]), member(guildOwner)].map(m => [m.user.id,m])),
    roles:[role(guildId,everyone), role(allowed), role(denied), role(admin,P.Administrator)], guildOwner, healthy:true,
  };
  const guild = client.guilds._add({id:guildId, name:'synthetic', owner_id:guildOwner, roles:wire.roles,
    members:[...wire.members.values()], channels:[...wire.channels.values()]});
  client.isReady=()=>wire.healthy;
  Object.defineProperty(guild,'shard',{get:()=>({status:wire.healthy ? Status.Ready : Status.Disconnected})});
  const connect = (id, channelId) => {
    if (!channelId) {wire.conns.delete(id); guild.voiceStates.cache.delete(id); return;}
    const data = {guild_id:guildId, user_id:id, channel_id:channelId, session_id:`voice-${id}`};
    wire.conns.set(id,data); guild.voiceStates._add(data);
  };
  connect(owner,roomId);
  let db = new DatabaseSync(dbPath), state = openTempVoiceStore(db);
  t.after(() => {
    db.close();
    if (dbPath !== ':memory:') rmSync(join(dbPath,'..'),{recursive:true,force:true});
  });
  const register = (id,user) => {
    const marker = `test-room-${id}`;
    assert.ok(state.begin(user,marker,`voice-${user}`,[]));
    assert.ok(state.bind(user,marker,id));
  };
  register(roomId,owner);
  const read = async route => {
    wire.reads.push(route); await wire.beforeRead?.(route);
    if (route===Routes.guild(guildId)) return {id:guildId,owner_id:wire.guildOwner};
    if (route===Routes.guildRoles(guildId)) return structuredClone(wire.roles);
    if (route===Routes.guildChannels(guildId)) return structuredClone([...wire.channels.values()]);
    if (route===Routes.voiceRegions()) return [{id:'brazil',custom:false,deprecated:false},{id:'legacy',custom:false,deprecated:true}];
    for (const [method,rows,code] of [[Routes.channel,wire.channels,10003],
      [id=>Routes.guildMember(guildId,id),wire.members,10007], [id=>Routes.guildVoiceState(guildId,id),wire.conns,10065]]) {
      const id = route.split('/').at(-1);
      if (route === method(id)) { if (!rows.has(id)) throw missing(code); return structuredClone(rows.get(id)); }
    }
    assert.fail(`unexpected read ${route}`);
  };
  client.rest.get = read;
  const writer = {get:read};
  let inLock = false, queue = Promise.resolve();
  for (const method of ['patch','post','delete','put']) writer[method] = async (route, options = {}) => {
    assert.ok(inLock, 'Discord write escaped exclusive'); wire.writes.push({method,route,body:structuredClone(options.body)});
    await wire.beforeWrite?.(method,route,options.body);
    if (wire.writeResponse) return wire.writeResponse(method,route,options);
    const id = route.split('/').at(-1);
    let result;
    if (route === Routes.guildChannels(guildId) && method === 'post') {
      const created = sid(40+wire.writes.length);
      result = channel(created,options.body.type,options.body); wire.channels.set(created,result);
    } else if (route === Routes.channel(id) && method === 'patch') {
      Object.assign(wire.channels.get(id), options.body); result = wire.channels.get(id);
    } else if (route === Routes.channel(id) && method === 'delete') {
      wire.channels.delete(id);
      for (const [user,s] of wire.conns) if (s.channel_id===id) connect(user,null);
    } else if (route === Routes.guildMember(guildId, id) && method === 'patch') {
      connect(id, options.body.channel_id); result = wire.members.get(id);
    } else assert.fail(`unexpected write ${method} ${route}`);
    await wire.afterWrite?.(method,route,options.body);
    return structuredClone(result);
  };
  const createActions = () => load().createTempVoiceActions({guildId, categoryId, lobbyId, panelId, state,
    readyGuild:() => guild, getWriter:() => {wire.writerRequests++; return writer;}, exclusive:work => {
      const next = queue.then(async () => {
        assert.ok(!inLock,'nested exclusive'); inLock = true;
        try {return await work();} finally {inLock = false;}
      });
      queue = next.catch(() => {});
      return next;
    }});
  let actions = createActions();
  const inspect = (extra = {}) => actions.inspect({guildId, actorId:owner, sourceId:panelId,...extra});
  const run = (kind, extra = {}) => actions.run({guildId, actorId:owner, sourceId:panelId,roomId,expectedOwnerId:owner,expectedLocked:false,
    expectedLockGeneration:state.get(roomId)?.lockGeneration,kind,...extra});
  const restart = () => {
    db.close(); db = new DatabaseSync(dbPath); state = openTempVoiceStore(db); actions = createActions();
  };
  const effective = (id, user) => {
    // Fresh synthetic wire rows go through real discord.js guild/channel permission resolution.
    const fresh = client.guilds._add({id:guildId,name:'synthetic',owner_id:wire.guildOwner,roles:wire.roles,
      members:[...wire.members.values()],channels:[...wire.channels.values()]}, false);
    return fresh.channels.cache.get(id).permissionsFor(fresh.members.cache.get(user));
  };
  return {wire,guild,get state() {return state;},connect,inspect,run,effective,register,restart};
}

test('inspect only binds a verified human to the exact occupied managed room', async t => {
  const f = fixture(t);
  assert.equal((await f.inspect()).roomId,roomId);
  assert.equal((await f.inspect({sourceId:roomId})).ownerId,owner);
  await assert.rejects(f.inspect({sourceId:otherRoom}),/لوحة/u);
  await assert.rejects(f.inspect({guildId:sid(99)}),/الخادم/u);
  f.connect(bot,roomId);
  await assert.rejects(f.inspect({actorId:bot}),/العضو/u);
  f.connect(owner,lobbyId);
  await assert.rejects(f.inspect(),/الغرفة|غرفة/u);
  assert.equal(f.wire.writes.length,0);
});

test('rename rechecks prompt owner, current voice, category and source before writing', async t => {
  const f = fixture(t);
  await f.inspect();
  await deny(f.run('name',{value:'محاولة',expectedOwnerId:guest}),/المالك/u);
  await deny(f.run('name',{value:'محاولة',sourceId:otherRoom}),/لوحة/u);
  await deny(f.run('name',{value:'x\n@everyone'}),/الاسم/u);
  f.wire.channels.get(roomId).parent_id=sid(99);
  await deny(f.run('name',{value:'محاولة'}),/الغرفة/u);
  f.wire.channels.get(roomId).parent_id=categoryId;
  f.connect(owner,otherRoom);
  await deny(f.run('name',{value:'محاولة'}),/الغرفة|غرفة/u);
  assert.equal(f.wire.writes.length,0);
  f.connect(owner,roomId);
  assert.match(await f.run('name',{value:'غرفة مؤقتة'}),/تغيير الاسم/u);
  assert.deepEqual(f.wire.writes,[{method:'patch',route:Routes.channel(roomId),body:{name:'غرفة مؤقتة'}}]);
});

test('voice limit accepts 0–99 and does not clamp invalid input', async t => {
  const f=fixture(t);
  for (const value of [100,-1,'1e1','',null]) await deny(f.run('limit',{value}),/الحد/u);
  assert.equal(f.wire.writes.length,0);
  await f.run('limit',{value:'99'});
  await f.run('limit',{value:0});
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:99},{user_limit:0}]);
});

test('voice region uses the current Discord catalog and supports automatic', async t => {
  const f=fixture(t);
  for (const value of ['legacy','not-a-region',undefined]) await deny(f.run('region',{value}),/المنطقة/u);
  await f.run('region',{value:'brazil'});
  await f.run('region',{value:'auto'});
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{rtc_region:'brazil'},{rtc_region:null}]);
});

test('uncertain edits read back exact scoped channel without replay or detail leakage', async t => {
  const f=fixture(t);
  f.wire.afterWrite=()=>{throw new Error('confidential raw error');};
  assert.match(await f.run('name',{value:'ثبت التعديل'}),/تم تغيير الاسم/u);
  f.wire.beforeWrite=()=>{throw new Error('confidential raw error');};
  await deny(f.run('name',{value:'لا تعديل'}),/تعذر التأكد/u);
  assert.equal(f.wire.writes.length,2);
  assert.equal(f.wire.channels.get(roomId).name,'ثبت التعديل');
});

test('claim requires a present claimant with no room and the owner actually absent', async t => {
  const f=fixture(t);
  const request={actorId:guest};
  f.connect(guest,roomId);
  assert.equal((await f.inspect(request)).canClaim,false);
  await deny(f.run('claim',request),/المالك/u);
  f.connect(owner,otherRoom);
  f.register(otherRoom,guest);
  assert.equal((await f.inspect(request)).canClaim,false);
  await deny(f.run('claim',request),/المالك/u);
  f.state.remove(otherRoom);
  assert.equal((await f.inspect(request)).canClaim,true);
  await f.run('claim',request);
  assert.equal(f.state.get(roomId).ownerId,guest);
  await deny(f.run('claim',{actorId:guest}),/المالك/u);
  assert.equal(f.wire.writes.length,0);
});

test('transfer targets a present human without an owned room', async t => {
  const f=fixture(t);
  f.connect(guest,otherRoom);
  await deny(f.run('transfer',{targetId:guest}),/العضو/u);
  f.connect(guest,roomId);
  f.register(otherRoom,guest);
  await deny(f.run('transfer',{targetId:guest}),/غرفة/u);
  f.state.remove(otherRoom);
  await f.run('transfer',{targetId:guest});
  assert.equal(f.state.get(roomId).ownerId,guest);
  await deny(f.run('name',{value:'stale owner'}),/المالك/u);
  assert.equal(f.wire.writes.length,0);
});

test('disconnect moves only the selected member still in this exact managed room', async t => {
  const f=fixture(t);
  f.connect(guest,otherRoom);
  await deny(f.run('disconnect',{targetId:guest}),/العضو/u);
  assert.deepEqual(f.wire.writes,[]);
  f.connect(guest,roomId);
  await f.run('disconnect',{targetId:guest});
  assert.deepEqual(f.wire.writes,[{method:'patch',route:Routes.guildMember(guildId,guest),body:{channel_id:null}}]);
  assert.equal(f.wire.conns.has(guest),false);
  assert.equal(f.wire.conns.get(owner).channel_id,roomId);
});

test('disconnect cannot pull a target from another room while its gateway update is delayed', async t => {
  const f=fixture(t);
  f.connect(guest,roomId);
  let reads=0;
  f.wire.beforeRead=route=>{
    if(route===Routes.channel(roomId)&&++reads===2) f.wire.conns.get(guest).channel_id=otherRoom;
  };
  await deny(f.run('disconnect',{targetId:guest}),/العضو/u);
  assert.deepEqual(f.wire.writes,[]);
  assert.equal(f.wire.conns.get(guest)?.channel_id,otherRoom);
  assert.equal(f.guild.voiceStates.cache.get(guest).channelId,roomId);
});

test('native lock preserves room visibility, existing occupants, and exact category permissions', async t => {
  const f=fixture(t,[roleAcl(allowed,P.ViewChannel|P.Connect,P.SendMessages),
    memberAcl(guest,P.ViewChannel|P.Connect,P.Speak), memberAcl(other,0n,P.ViewChannel|P.Connect)]);
  f.wire.members.get(guest).roles=[allowed];
  f.connect(guest,roomId);
  f.wire.channels.get(roomId).user_limit=17;
  const category=structuredClone(f.wire.channels.get(categoryId));
  assert.equal((await f.inspect()).locked,false);
  assert.match(await f.run('privacy',{value:'locked'}),/تم قفل/u);
  assert.equal((await f.inspect()).locked,true);
  assert.equal(f.wire.conns.get(guest).channel_id,roomId);
  assert.equal(f.wire.conns.get(owner).channel_id,roomId);
  assert.equal(f.effective(roomId,guest).has(P.ViewChannel),true);
  assert.equal(f.effective(roomId,other).has(P.ViewChannel),false);
  assert.deepEqual(f.wire.channels.get(roomId).permission_overwrites,category.permission_overwrites);
  assert.deepEqual(f.wire.channels.get(categoryId),category);
  assert.match(await f.run('privacy',{value:'open',expectedLocked:true}),/تم فتح/u);
  assert.equal((await f.inspect()).locked,false);
  assert.deepEqual(f.wire.writes,[1,17].map(user_limit=>({method:'patch',route:Routes.channel(roomId),body:{user_limit}})));
});

const dbFile = () => join(mkdtempSync(join(tmpdir(),'lxr-capacity-')),'voice.sqlite');

for (const prior of [0,1,99]) test(`lock state and prior capacity ${prior} survive DB restart`, async t => {
  const f=fixture(t,[],base,dbFile());
  f.wire.channels.get(roomId).user_limit=prior;
  assert.equal((await f.inspect()).locked,false);
  assert.match(await f.run('privacy',{value:'locked'}),/تم قفل/u);
  f.restart();
  assert.equal((await f.inspect()).locked,true);
  assert.match(await f.run('privacy',{value:'open',expectedLocked:true}),/تم فتح/u);
  f.restart();
  assert.equal((await f.inspect()).locked,false);
  assert.equal(f.wire.channels.get(roomId).user_limit,prior);
  assert.deepEqual(f.wire.writes.map(w=>w.body.user_limit),prior === 1 ? [] : [1,prior]);
});

test('lock requires the recorded owner and a matching current REST and gateway voice session', async t => {
  const f=fixture(t);
  f.connect(guest,roomId);
  await deny(f.run('privacy',{actorId:guest,value:'locked'}),/المالك/u);
  f.wire.conns.get(owner).session_id='different-rest-session';
  await deny(f.run('privacy',{value:'locked'}),/الغرفة/u);
  f.connect(owner,otherRoom);
  await deny(f.run('privacy',{value:'locked'}),/الغرفة/u);
  assert.deepEqual(f.wire.writes,[]);
});

test('competing privacy prompts use the expected lock flag; stale setting prompts do not mutate', async t => {
  const f=fixture(t);
  const {locked:expectedLocked}=await f.inspect();
  const replies=await Promise.all([
    f.run('privacy',{value:'locked',expectedLocked}),
    f.run('privacy',{value:'locked',expectedLocked}),
  ]);
  assert.match(replies[0],/تم قفل/u);
  assert.match(replies[1],/تغيّرت حالة القفل/u);
  await deny(f.run('privacy',{value:'open',expectedLocked:undefined}),/تغيّرت حالة القفل/u);
  await deny(f.run('region',{value:'auto',expectedLocked}),/تغيّرت حالة القفل/u);
  await deny(f.run('limit',{value:7,expectedLocked:true}),/الغرفة مقفلة/u);
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:1}]);
});

test('received open prompt is stale after a complete lock and reopen across restart', async t => {
  const f=fixture(t,[],base,dbFile());
  f.wire.channels.get(roomId).user_limit=15;
  const received=await f.inspect();
  assert.match(await f.run('privacy',{value:'locked',expectedLocked:received.locked,expectedLockGeneration:received.lockGeneration}),/تم قفل/u);
  const locked=await f.inspect();
  f.restart();
  assert.equal((await f.inspect()).lockGeneration,locked.lockGeneration);
  assert.match(await f.run('privacy',{value:'open',expectedLocked:locked.locked,expectedLockGeneration:locked.lockGeneration}),/تم فتح/u);
  f.restart();
  const reopened=await f.inspect();
  assert.equal(reopened.locked,received.locked);
  const request={value:'locked',expectedLocked:received.locked,expectedLockGeneration:received.lockGeneration};
  await deny(f.run('privacy',request),/تغيّرت حالة القفل/u);
  await deny(f.run('limit',{...request,value:7}),/تغيّرت حالة القفل/u);
  await deny(f.run('delete',request),/تغيّرت حالة القفل/u);
  assert.equal(received.lockGeneration,'0');
  assert.equal(typeof locked.lockGeneration,'string');
  assert.equal(typeof reopened.lockGeneration,'string');
  assert.equal(new Set([received.lockGeneration,locked.lockGeneration,reopened.lockGeneration]).size,3);
  assert.equal(f.state.getCapacityLock(roomId),null);
  assert.equal(f.wire.channels.get(roomId).user_limit,15);
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:1},{user_limit:15}]);
  assert.match(await f.run('privacy',{...request,expectedLockGeneration:reopened.lockGeneration}),/تم قفل/u);
});

test('privacy rejects a missing generation before acquiring a writer', async t => {
  const f=fixture(t);
  await deny(f.run('privacy',{value:'locked',expectedLockGeneration:undefined}),/تغيّرت حالة القفل/u);
  assert.equal(f.wire.writerRequests,0);
  assert.equal(f.state.getCapacityLock(roomId),null);
});

test('SQLite releases only the exact persisted static or voice panel reservation', t => {
  const f=fixture(t,[],base,dbFile());
  assert.equal(f.state.reservePanelPublication(panelId,false),true);
  assert.equal(f.state.reservePanelPublication(roomId,true),true);
  f.restart();
  assert.equal(f.state.releasePanelPublication(panelId,true),false);
  assert.equal(f.state.releasePanelPublication(roomId,false),false);
  assert.equal(f.state.releasePanelPublication(otherRoom,false),false);
  assert.equal(f.state.reservePanelPublication(panelId,false),false);
  assert.equal(f.state.reservePanelPublication(roomId,true),false);
  assert.equal(f.state.releasePanelPublication(panelId,false),true);
  assert.equal(f.state.releasePanelPublication(panelId,false),false);
  assert.equal(f.state.reservePanelPublication(roomId,true),false);
  assert.equal(f.state.releasePanelPublication(roomId,true),true);
  assert.equal(f.state.releasePanelPublication(roomId,true),false);
  assert.equal(f.state.reservePanelPublication(panelId,false),true);
  assert.equal(f.state.reservePanelPublication(roomId,true),true);
});

test('SQLite migrates a pre-generation locked room without losing the saved capacity', async t => {
  const path=dbFile();
  const f=fixture(t,[],base,path);
  f.wire.channels.get(roomId).user_limit=19;
  assert.match(await f.run('privacy',{value:'locked'}),/تم قفل/u);
  const journal=f.state.getCapacityLock(roomId);
  const legacy=new DatabaseSync(path);
  try {
    if (legacy.prepare('PRAGMA table_info(lxr_temp_voice)').all().some(row=>row.name==='lock_generation')) {
      legacy.exec('ALTER TABLE lxr_temp_voice DROP COLUMN lock_generation');
    }
  } finally {legacy.close();}
  f.restart();
  assert.deepEqual(f.state.getCapacityLock(roomId),journal);
  const migrated=await f.inspect();
  assert.equal(migrated.lockGeneration,'0');
  assert.equal(migrated.locked,true);
  assert.match(await f.run('privacy',{value:'open',expectedLocked:true,expectedLockGeneration:migrated.lockGeneration}),/تم فتح/u);
  assert.equal(f.wire.channels.get(roomId).user_limit,19);
});

test('moderator capacity drift conflicts with the confirmed lock even when it equals the saved prior cap', async t => {
  const f=fixture(t);
  f.wire.channels.get(roomId).user_limit=6;
  assert.match(await f.run('privacy',{value:'locked'}),/تم قفل/u);
  for (const changed of [18,6,0]) {
    f.wire.channels.get(roomId).user_limit=changed;
    await assert.rejects(f.inspect(),/خارج التحكم/u);
    await deny(f.run('privacy',{value:'open',expectedLocked:true}),/خارج التحكم/u);
    await deny(f.run('limit',{value:14,expectedLocked:true}),/خارج التحكم/u);
  }
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:1}]);
});

test('moderator cap change before the final lock preflight is not overwritten', async t => {
  const f=fixture(t);
  let voiceReads=0;
  f.wire.beforeRead=route=>{
    if (route===Routes.guildVoiceState(guildId,owner) && ++voiceReads===3) f.wire.channels.get(roomId).user_limit=31;
  };
  await deny(f.run('privacy',{value:'locked'}),/خارج التحكم/u);
  assert.equal(f.wire.channels.get(roomId).user_limit,31);
  assert.deepEqual(f.wire.writes,[]);
});

test('an unresolved PATCH persists the intent but never retries a readback of the old cap', async t => {
  const path=dbFile();
  const f=fixture(t,[],base,path);
  const initialGeneration=f.state.get(roomId).lockGeneration;
  let committedBeforePatch, generationBeforePatch;
  f.wire.channels.get(roomId).user_limit=8;
  f.wire.beforeWrite=()=>{
    const observer=new DatabaseSync(path);
    try {
      const persisted=openTempVoiceStore(observer);
      committedBeforePatch=persisted.getCapacityLock(roomId);
      generationBeforePatch=persisted.get(roomId).lockGeneration;
    } finally {observer.close();}
    throw Object.assign(new Error('ambiguous request interrupted'),{name:'RateLimitError',status:429,code:0});
  };
  await deny(f.run('privacy',{value:'locked'}),/تعذر التأكد/u);
  assert.equal(committedBeforePatch?.phase,'locking');
  assert.equal(committedBeforePatch?.priorLimit,8);
  assert.equal(typeof generationBeforePatch,'string');
  assert.notEqual(generationBeforePatch,initialGeneration);
  f.restart();
  assert.equal(f.state.get(roomId).lockGeneration,generationBeforePatch);
  await assert.rejects(f.inspect(),/تعذر التأكد/u);
  await deny(f.run('privacy',{value:'locked'}),/تعذر التأكد/u);
  assert.equal(f.wire.writes.length,1);
});

test('capacity compare-and-swap leaves the journal and generation unchanged for a stale owner or open generation', async t => {
  const f=fixture(t);
  const initial=f.state.get(roomId).lockGeneration;
  const next={phase:'locking',priorLimit:0};
  assert.ok(f.state.replaceCapacityLock(roomId,owner,null,next,initial));
  const intent=f.state.getCapacityLock(roomId);
  const generation=f.state.get(roomId).lockGeneration;
  assert.ok(f.state.update(roomId,{ownerId:guest}));
  assert.ok(!f.state.replaceCapacityLock(roomId,owner,intent.revision,null,generation));
  assert.deepEqual(f.state.getCapacityLock(roomId),intent);
  assert.equal(f.state.get(roomId).lockGeneration,generation);
  assert.ok(f.state.replaceCapacityLock(roomId,guest,intent.revision,null,generation));
  const reopened=f.state.get(roomId).lockGeneration;
  assert.ok(!f.state.replaceCapacityLock(roomId,guest,null,next,initial));
  assert.equal(f.state.getCapacityLock(roomId),null);
  assert.equal(f.state.get(roomId).lockGeneration,reopened);
});

test('applied lock or unlock with missing readback is recovered across restart without replay', async t => {
  const f=fixture(t,[],base,dbFile());
  f.wire.channels.get(roomId).user_limit=8;
  f.wire.afterWrite=()=>{
    f.wire.beforeRead=route=>{if (route===Routes.channel(roomId)) throw new Error('GET unavailable');};
    throw new Error('PATCH response lost');
  };
  for (const [value,expectedLocked,phase] of [['locked',false,'locking'],['open',true,'opening']]) {
    await deny(f.run('privacy',{value,expectedLocked}),/تعذر التأكد/u);
    assert.equal(f.state.getCapacityLock(roomId)?.phase,phase);
    f.restart();
    f.wire.beforeRead=null;
    assert.equal((await f.inspect()).locked,!expectedLocked);
    await deny(f.run('privacy',{value,expectedLocked}),/تغيّرت حالة القفل/u);
  }
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:1},{user_limit:8}]);
});

test('a definitive Discord rejection plus source readback releases only that intent', async t => {
  const f=fixture(t);
  f.wire.beforeWrite=()=>{throw Object.assign(new Error('Discord error details'),{status:403,code:50013});};
  await deny(f.run('privacy',{value:'locked'}),/رفض/u);
  assert.equal(f.state.getCapacityLock(roomId),null);
  assert.equal((await f.inspect()).locked,false);
  f.wire.beforeWrite=null;
  assert.match(await f.run('privacy',{value:'locked'}),/تم قفل/u);
  f.wire.beforeWrite=()=>{throw Object.assign(new Error('Discord error details'),{status:403,code:50013});};
  await deny(f.run('privacy',{value:'open',expectedLocked:true}),/رفض/u);
  assert.equal(f.state.getCapacityLock(roomId)?.phase,'locked');
  assert.equal((await f.inspect()).locked,true);
});

test('real Discord SDK 429 refuses a capacity PATCH without trapping lock or reopen', async t => {
  const f=fixture(t,[],base,dbFile());
  f.wire.channels.get(roomId).user_limit=8;
  const requests=[];
  let refuse=true;
  const rest=createApplicationMutationRest('offline-fixture',{offset:0,makeRequest:async (url,{method,body})=>{
    requests.push({route:new URL(url).pathname,method,body:JSON.parse(body)});
    if (refuse) {
      // The typed, no-retry SDK rejection is definitive even if a subsequent GET is unavailable.
      f.wire.beforeRead=route=>{if (route===Routes.channel(roomId)) throw new Error('GET unavailable');};
      return new Response(JSON.stringify({message:'rate limit',retry_after:0.01}),{
        status:429,headers:{'content-type':'application/json','retry-after':'0.01','x-ratelimit-scope':'shared'},
      });
    }
    Object.assign(f.wire.channels.get(roomId),JSON.parse(body));
    return Response.json(f.wire.channels.get(roomId));
  }});
  f.wire.writeResponse=async (method,route,options)=>{
    try { return await rest[method](route,options); } catch (error) {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.status,undefined);
      assert.equal(error.code,undefined);
      throw error;
    }
  };
  for (const [value,expectedLocked,prior] of [['locked',false,8],['open',true,1]]) {
    refuse=true;
    const {lockGeneration:expectedLockGeneration}=await f.inspect();
    const request={value,expectedLocked,expectedLockGeneration};
    await deny(f.run('privacy',request),/رفض/u);
    assert.equal(f.wire.channels.get(roomId).user_limit,prior);
    f.restart();
    f.wire.beforeRead=null;
    const after=await f.inspect();
    assert.equal(after.locked,expectedLocked);
    assert.notEqual(after.lockGeneration,expectedLockGeneration);
    assert.equal(f.state.getCapacityLock(roomId)?.phase ?? null,expectedLocked ? 'locked' : null);
    await deny(f.run('privacy',request),/تغيّرت حالة القفل/u);
    refuse=false;
    assert.match(await f.run('privacy',{...request,expectedLockGeneration:after.lockGeneration}),/تم قفل|تم فتح/u);
  }
  assert.deepEqual(requests,[1,1,8,8].map(user_limit=>({
    route:`/api/v10${Routes.channel(roomId)}`,method:'PATCH',body:{user_limit},
  })));
});

test('unsupported controls fail closed without fetching the writer or persisting grants', async t => {
  const f=fixture(t);
  f.connect(guest,roomId);
  const record=f.state.get(roomId);
  for (const kind of ['waitingToggle','waitingAdmit','trust','untrust','block','unblock']) {
    await deny(f.run(kind,{targetId:guest}),/غير متاح/u);
  }
  await deny(f.run('privacy',{value:'hidden'}),/الخصوصية/u);
  assert.equal(f.wire.writerRequests,0);
  assert.deepEqual(f.wire.writes,[]);
  assert.deepEqual(f.state.get(roomId),record);
});

test('permission drift blocks lock, invitation, and transfer without replacing foreign rules', async t => {
  const f=fixture(t);
  f.wire.channels.get(roomId).permission_overwrites=[memberAcl(other,P.ManageChannels)];
  await deny(f.run('privacy',{value:'locked'}),/الصلاحيات/u);
  f.connect(guest,roomId);
  await deny(f.run('transfer',{targetId:guest}),/الصلاحيات/u);
  f.wire.channels.get(roomId).permission_overwrites=[];
  f.wire.channels.get(categoryId).permission_overwrites=[roleAcl(guildId,0n,P.Connect)];
  await deny(f.run('invite',{targetId:guest}),/الصلاحيات/u);
  assert.deepEqual(f.wire.writes,[]);
});

test('deletion targets only the exact managed main room and drops its capacity journal', async t => {
  const f=fixture(t);
  assert.match(await f.run('privacy',{value:'locked'}),/تم قفل/u);
  f.wire.channels.get(roomId).parent_id=otherRoom;
  await deny(f.run('delete',{expectedLocked:true}),/الغرفة/u);
  f.wire.channels.get(roomId).parent_id=categoryId;
  assert.match(await f.run('delete',{expectedLocked:true}),/تم حذف/u);
  assert.equal(f.state.get(roomId),null);
  assert.equal(f.state.getCapacityLock(roomId),null);
  assert.deepEqual(f.wire.writes.slice(1).map(w=>[w.method,w.route]),[['delete',Routes.channel(roomId)]]);
  for (const keep of [otherRoom,panelId,lobbyId,categoryId]) assert.ok(f.wire.channels.has(keep));
});

test('legacy waiting metadata never causes a user action to touch a paired channel', async t => {
  const f=fixture(t);
  f.state.update(roomId,{waitingId:otherRoom,waitingMarker:`غرفة انتظار · ${'1'.repeat(32)}`});
  await deny(f.run('delete'),/الانتظار/u);
  assert.deepEqual(f.wire.writes,[]);
  assert.equal(f.state.byWaiting(otherRoom).id,roomId);
});

test('basic mutations reject fresh category ineligibility and an unavailable gateway', async t => {
  const f=fixture(t,[roleAcl(denied,0n,P.Connect)]);
  await f.inspect();
  f.wire.members.get(owner).roles=[denied];
  await deny(f.run('name',{value:'غير مسموح'}),/الصلاحيات/u);
  f.wire.members.get(owner).roles=[];
  f.wire.healthy=false;
  await deny(f.run('limit',{value:12}),/الخادم/u);
  assert.deepEqual(f.wire.writes,[]);
});

test('ownership transfers do not modify category permissions and the lock follows the room', async t => {
  const f=fixture(t);
  f.connect(guest,roomId);
  f.wire.channels.get(roomId).user_limit=5;
  assert.match(await f.run('privacy',{value:'locked'}),/تم قفل/u);
  assert.match(await f.run('transfer',{targetId:guest,expectedLocked:true}),/تم نقل ملكية/u);
  assert.equal(f.state.get(roomId).ownerId,guest);
  assert.equal((await f.inspect({actorId:guest})).locked,true);
  assert.match(await f.run('privacy',{actorId:guest,expectedOwnerId:guest,expectedLocked:true,value:'open'}),/تم فتح/u);
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:1},{user_limit:5}]);
});

test('run returns safe Arabic denials so the private panel can explain failures', async t => {
  const f=fixture(t);
  assert.match(await f.run('not-an-action'),/^هذا الإجراء غير متاح\.$/u);
  assert.equal(f.wire.writes.length,0);
});

test('invite returns only an eligible member’s private link and never creates a grant', async t => {
  const f=fixture(t,[roleAcl(guildId,0n,P.ViewChannel),roleAcl(allowed,P.ViewChannel),memberAcl(other,0n,P.Connect)]);
  f.wire.members.get(owner).roles=[allowed];
  f.wire.members.get(guest).roles=[allowed];
  f.wire.members.get(other).roles=[allowed];
  assert.match(await f.run('invite',{targetId:guest}),new RegExp(`الخاص.*https://discord.com/channels/${guildId}/${roomId}`));
  await deny(f.run('invite',{targetId:other}),/العضو/u);
  f.wire.members.get(guest).roles=[];
  await deny(f.run('invite',{targetId:guest}),/العضو/u);
  assert.equal(f.effective(roomId,guest).has(P.ViewChannel),false);
  assert.deepEqual(f.state.get(roomId).invited,[]);
  assert.deepEqual(f.wire.writes,[]);
  f.wire.members.get(guest).roles=[allowed];
  await f.run('privacy',{value:'locked'});
  const reply=await f.run('invite',{targetId:guest,expectedLocked:true});
  assert.match(reply,/مقفلة/u);
  assert.doesNotMatch(reply,/https:/u);
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:1}]);
});

test('invite does not disclose links after a synced category restriction changes during target lookup', async t => {
  const f=fixture(t);
  f.wire.beforeRead=route=>{
    if (route===Routes.guildMember(guildId,guest)) {
      for (const id of [categoryId,roomId]) f.wire.channels.get(id).permission_overwrites=[memberAcl(guest,0n,P.ViewChannel)];
    }
  };
  const result=await f.run('invite',{targetId:guest});
  assert.match(result,/الصلاحيات/u);
  assert.doesNotMatch(result,/https:/u);
  assert.equal(f.wire.writerRequests,0);
});

test('lock results are withheld if readback loses category sync despite applying the cap', async t => {
  const f=fixture(t);
  f.wire.afterWrite=()=>{f.wire.channels.get(roomId).permission_overwrites=[memberAcl(guest,P.ViewChannel)];};
  await deny(f.run('privacy',{value:'locked'}),/تعذر التأكد/u);
  assert.equal(f.state.getCapacityLock(roomId)?.phase,'locking');
  await assert.rejects(f.inspect(),/الصلاحيات/u);
  f.wire.channels.get(roomId).permission_overwrites=[];
  assert.equal((await f.inspect()).locked,true);
  assert.deepEqual(f.wire.writes.map(w=>w.body),[{user_limit:1}]);
});
