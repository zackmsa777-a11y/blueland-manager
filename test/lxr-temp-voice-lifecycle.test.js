'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {Client,ChannelFlags,ChannelType:T,Events,GatewayIntentBits:I,OverwriteType:O,PermissionFlagsBits:P,Routes}=require('discord.js');

const id=n=>`207000000000000${String(n).padStart(3,'0')}`;
const guildId='1573975432838127708', lobbyId='1575147982381129748', categoryId='1574893689082224660';
const roomId=id(4), ownerId=id(5), botId=id(6),
  roleId=id(7), foreignId=id(8), guestId=id(9), waitingId=id(10);
const panelId='1575632962240774264', replacementId=id(12);
const overwrite=(id,type,allow=0n,deny=0n)=>({id,type,allow:String(allow),deny:String(deny)});
const common=P.ViewChannel|P.Connect;
const acl=[overwrite(guildId,O.Role,0n,common),overwrite(roleId,O.Role,common)];
const channel=(id,type,extra={})=>({id,guild_id:guildId,type,name:'fixture',parent_id:null,permission_overwrites:[],
  ...(type===T.GuildVoice?{user_limit:0,bitrate:64000,rtc_region:null}:{}),...extra});
const wireUser=id=>({id,bot:id===botId,username:id,discriminator:'0'});
const wireMember=(id,roles=[roleId])=>({user:wireUser(id),roles,joined_at:'2026-01-01T00:00:00Z',flags:0});
const wireVoice=(id,channelId,session=`voice-session-${id}`)=>({guild_id:guildId,user_id:id,channel_id:channelId,session_id:session,member:wireMember(id)});
const apiError=(code,status=404)=>Object.assign(new Error(`Discord fixture ${code}`),{code,status});

function fixture(t,{hydrated=[]}={}) {
  const {createApplicationMutationRest}=require('../src/lxr-apply-tickets');
  const {openTempVoiceStore}=require('../src/lxr-temp-voice-store');
  const {createTempVoiceLifecycle}=require('../src/lxr-temp-voice-lifecycle');
  const {createTempVoiceActions}=require('../src/lxr-temp-voice-actions');
  const dir=mkdtempSync(join(process.env.TMPDIR ?? process.cwd(),'voice-lifecycle-'));
  const file=join(dir,'state.sqlite');
  let db, state;
  function reopen() {
    db?.close();
    db=new DatabaseSync(file);
    state=openTempVoiceStore(db);
  }
  reopen(); t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const client=new Client({intents:[I.Guilds,I.GuildVoiceStates],rest:{makeRequest,retries:0}});
  client.rest.setToken('offline-fixture');
  t.after(()=>client.destroy());
  client.user=wireUser(botId);
  const roles=[{id:guildId,name:'everyone',permissions:String(P.MoveMembers|P.ManageChannels),position:0},
    {id:roleId,name:'eligible',permissions:'0',position:1}];
  const raw=new Map([
    channel(categoryId,T.GuildCategory,{permission_overwrites:acl}),
    channel(lobbyId,T.GuildVoice),
    channel(foreignId,T.GuildVoice,{parent_id:categoryId,name:'existing voice'})
  ].map(row=>[row.id,structuredClone(row)]));
  const memberRows=new Map([ownerId,guestId,botId].map(id=>[id,wireMember(id)]));
  const guild=client.guilds._add({id:guildId,shardId:0,name:'fixture',owner_id:id(11),roles,members:[...memberRows.values()],channels:[...raw.values()],voice_states:hydrated});
  let healthy=true;
  const guildRow={id:guildId,owner_id:guild.ownerId};
  client.isReady=()=>healthy;
  Object.defineProperty(guild,'shard',{get:()=>({status:healthy?0:5})});
  const reads=[],writes=[],timeline=[],voices=new Map(hydrated.map(row=>[row.user_id,row]));
  const hooks={};
  async function read(route) {
    reads.push(route);
    await hooks.beforeGet?.(route);
    const tail=route.split('/').at(-1);
    if(route===Routes.guildChannels(guildId)) return structuredClone([...raw.values()]);
    if(route===Routes.guildRoles(guildId)) return structuredClone(roles);
    if(route===Routes.guild(guildId)) return structuredClone(guildRow);
    if(route===Routes.guildMember(guildId,tail)) {
      if (!memberRows.has(tail)) throw apiError(10007);
      return structuredClone(memberRows.get(tail));
    }
    if(route===Routes.guildVoiceState(guildId,tail)) {
      if(!voices.get(tail)?.channel_id) throw apiError(10065);
      return structuredClone(voices.get(tail));
    }
    if(route===Routes.channel(tail)&&raw.has(tail)) return structuredClone(raw.get(tail));
    throw apiError(10003);
  }
  const mutations={
    async POST(route,body) {
      assert.equal(route,Routes.guildChannels(guildId));
      writes.push(['post',route,body]); timeline.push('post');
      const next=channel(hooks.roomId??roomId,body.type,{permission_overwrites:structuredClone(raw.get(body.parent_id).permission_overwrites),...body});
      if(hooks.post) return hooks.post(next);
      raw.set(next.id,next);
      const {guild_id,...response}=next;
      return structuredClone(response);
    },
    async PATCH(route,body) {
      writes.push(['patch',route,body]);
      const destination=route.split('/').at(-1);
      if(route===Routes.channel(destination)&&raw.has(destination)) {
        timeline.push('name');
        if(hooks.rename) return hooks.rename(body);
        const next={...raw.get(destination),...body};
        raw.set(destination,next);
        return structuredClone(next);
      }
      timeline.push('move');
      assert.equal(route,Routes.guildMember(guildId,ownerId));
      if(hooks.patch) return hooks.patch(body);
      putVoice(ownerId,body.channel_id,voices.get(ownerId)?.session_id);
      return null;
    },
    async DELETE(route) {
      writes.push(['delete',route]); timeline.push('delete');
      raw.delete(route.split('/').at(-1));
    }
  };
  // Exercise Discord.js route and JSON serialization; only the network is simulated.
  async function makeRequest(url,{method,body}) {
    const {origin,pathname}=new URL(url);
    assert.equal(origin,'https://discord.com');
    assert.ok(pathname.startsWith('/api/v10/'));
    const route=pathname.slice('/api/v10'.length);
    try {
      const result=method==='GET'?await read(route):await mutations[method](route,body===undefined?undefined:JSON.parse(body));
      return result==null?new Response(null,{status:204}):Response.json(result);
    } catch(err) {
      if(!Number.isInteger(err.status)) throw err;
      const headers=err.status===429?{'retry-after':err.retryAfter,'x-ratelimit-scope':'shared'}:undefined;
      return Response.json({code:err.code,message:err.message},{status:err.status,statusText:err.message,headers});
    }
  }
  const scope=()=>({state,guildId,lobbyId,categoryId,panelId,readyGuild:()=>guild,
    getWriter:()=>createApplicationMutationRest('offline-fixture',{makeRequest})});
  function make(options={}) {
    return createTempVoiceLifecycle({...scope(),
      postVoicePanel:async (active,id)=>{
        assert.equal(active,guild);assert.equal(id,hooks.roomId??roomId);timeline.push('panel');
        await hooks.panel?.();
      },...options});
  }
  function putVoice(user,channel,session) {
    const data=wireVoice(user,channel,session);
    const before=guild.voiceStates.cache.get(user)?._clone() ?? {id:user,guild,channelId:null};
    voices.set(user,data);
    guild.voiceStates._add(data);
    return [before,guild.voiceStates.cache.get(user)];
  }
  function replayVoice(life,user,channel,session) {
    const data=wireVoice(user,channel,session);
    let handled;
    client.once(Events.VoiceStateUpdate,(old,next)=>{handled=life.voiceState(old,next);});
    voices.set(user,data);
    client.actions.VoiceStateUpdate.handle(data);
    assert.ok(handled,'Discord.js must deliver the gateway event');
    return handled;
  }
  function readPersisted(read) {
    const other=new DatabaseSync(file);
    try {return read(openTempVoiceStore(other),other);} finally {other.close();}
  }
  const actions=life=>createTempVoiceActions({...scope(),exclusive:life.exclusive});
  return {make,actions,replayVoice,reopen,readPersisted,get state(){return state;},guild,guildRow,raw,reads,writes,timeline,putVoice,voices,memberRows,hooks,
    ready:value=>{healthy=value;}};
}

test('normal lobby join renames the durably bound room to the server nickname and verifies it',async t=>{
  const f=fixture(t);
  const life=f.make();
  const member=f.memberRows.get(ownerId);
  member.nick='اسم العضو';
  member.user.global_name='Discord display name';
  member.user.username='account-name';
  f.hooks.post=next=>{
    const pending=f.readPersisted(state=>state.byOwner(ownerId));
    assert.equal(pending.id,null);
    assert.equal(pending.marker,next.name);
    f.raw.set(roomId,next);
    return structuredClone(next);
  };
  let readsAtRename;
  f.hooks.rename=({name})=>{
    const durable=f.readPersisted(state=>state.get(roomId));
    assert.equal(durable.ownerId,ownerId);
    assert.equal(f.raw.get(roomId).name,durable.marker);
    readsAtRename=f.reads.length;
    f.raw.get(roomId).name=name;
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  const made=f.state.get(roomId);
  assert.equal(made.ownerId,ownerId);
  assert.equal(made.privacy,'open');
  assert.deepEqual(made.trusted,[]);
  assert.equal(made.waitingId,null);
  assert.deepEqual(f.writes[0],['post',Routes.guildChannels(guildId),{parent_id:categoryId,type:T.GuildVoice,name:made.marker}]);
  assert.deepEqual(f.writes[1],['patch',Routes.guildMember(guildId,ownerId),{channel_id:roomId}]);
  assert.deepEqual(f.writes[2],['patch',Routes.channel(roomId),{name:'اسم العضو'}]);
  assert.equal(f.reads[readsAtRename],Routes.channel(roomId));
  assert.equal(f.raw.get(roomId).name,'اسم العضو');
});

test('create inherits the category at POST time instead of sending a stale preflight ACL',async t=>{
  const f=fixture(t), life=f.make();
  const fresh=[...acl,overwrite(guestId,O.Member,0n,P.Connect)];
  f.hooks.beforeGet=route=>{
    if(route===Routes.guildVoiceState(guildId,ownerId)&&!f.raw.has(roomId)) f.raw.get(categoryId).permission_overwrites=fresh;
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(Object.hasOwn(f.writes[0][2],'permission_overwrites'),false);
  assert.deepEqual(f.raw.get(roomId).permission_overwrites,fresh);
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('a matching POST reply cannot hide a broader fresh room ACL from handoff',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.post=next=>{
    f.raw.set(roomId,{...next,permission_overwrites:[...next.permission_overwrites,overwrite(guestId,O.Member,common)]});
    return structuredClone(next);
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  await life.reconcile();
  assert.deepEqual(f.timeline,['post']);
  assert.equal(f.voices.get(ownerId).channel_id,lobbyId);
  assert.equal(f.readPersisted(state=>state.get(roomId).moveAt),null);
  assert.deepEqual(f.raw.get(categoryId).permission_overwrites,acl);
});

test('an obfuscated exact response cannot serve as ACL proof even if its visible rows match',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.post=next=>{
    f.raw.set(roomId,{...next,flags:ChannelFlags.ChannelObfuscated});
    return structuredClone(next);
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  await life.reconcile();
  assert.deepEqual(f.timeline,['post']);
  assert.equal(f.voices.get(ownerId).channel_id,lobbyId);
});

test('fresh readbacks accept role and member ACLs with reordered rows and empty canonical rows',async t=>{
  const f=fixture(t), life=f.make();
  const rules=[...acl,overwrite(guestId,O.Member,0n,P.Connect)];
  f.raw.get(categoryId).permission_overwrites=rules;
  f.hooks.post=next=>{
    f.raw.set(roomId,{...next,permission_overwrites:[...rules].reverse()
      .map(row=>({...row,allow:`00${row.allow}`})).concat(overwrite(botId,O.Member))});
    return structuredClone(next);
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  assert.equal(f.readPersisted(state=>state.get(roomId).panelReady),true);
});

test('a REST-only lobby departure during the bound destination read prevents the member PATCH',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.beforeGet=async route=>{
    if(route===Routes.channel(roomId)&&f.state.get(roomId)) {
      await new Promise(resolve=>setImmediate(resolve));
      f.voices.set(ownerId,wireVoice(ownerId,foreignId));
    }
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.timeline,['post']);
  assert.equal(f.voices.get(ownerId).channel_id,foreignId);
  assert.equal(f.guild.voiceStates.cache.get(ownerId).channelId,lobbyId);
  assert.equal(f.readPersisted(state=>state.get(roomId).moveAt),null);
});

test('SDK channel models enforce the category gate after the member loses the qualifying role',async t=>{
  const f=fixture(t);
  // Call the installed SDK's high-level create, intercepted at the same HTTP transport.
  f.hooks.post=next=>{f.raw.set(roomId,next);return structuredClone(next);};
  const sdkRoom=await f.guild.channels.create({name:'SDK fixture',type:T.GuildVoice,parent:categoryId});
  assert.deepEqual(f.writes,[['post',Routes.guildChannels(guildId),{name:'SDK fixture',type:T.GuildVoice,parent_id:categoryId}]]);
  assert.equal(sdkRoom.permissionsLocked,true);
  const joined=f.guild.members.cache.get(ownerId);
  assert.equal(sdkRoom.permissionsFor(joined).has(common),true);
  const withoutRole=f.guild.members._add(wireMember(ownerId,[]));
  assert.equal(sdkRoom.parent.permissionsFor(withoutRole).any(common),false);
  assert.equal(sdkRoom.permissionsFor(withoutRole).any(common),false);
});

test('duplicate lobby deliveries yield one room while the original owner is in it',async t=>{
  const f=fixture(t), life=f.make();
  const event=f.putVoice(ownerId,lobbyId);
  await Promise.all([life.voiceState(...event),life.voiceState(...event)]);
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  f.putVoice(guestId,roomId);
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  assert.ok(f.state.get(roomId));
});

test('ready reconciliation hands off a GUILD_CREATE-hydrated lobby voice without a join event',async t=>{
  // GUILD_CREATE uses the same SDK guild hydration path. Member caching is not required.
  const f=fixture(t,{hydrated:[wireVoice(ownerId,lobbyId),wireVoice(guestId,foreignId)]});
  f.guild.members.cache.delete(ownerId);
  assert.equal(f.guild.voiceStates.cache.get(ownerId).member,null);
  const life=f.make();
  await life.reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  // A queued gateway delivery for the already-reconciled voice cannot issue a second POST.
  await life.voiceState({channelId:null},{guild:f.guild,id:ownerId,channelId:lobbyId,sessionId:`voice-session-${ownerId}`});
  await life.reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  assert.equal(f.readPersisted(state=>state.get(roomId).ownerId),ownerId);
  assert.equal(f.voices.get(guestId).channel_id,foreignId);
  assert.equal(f.reads.includes(Routes.guildMember(guildId,guestId)),false);
});

test('SDK HTTP 429 releases exactly the rejected POST reservation for a later reconciled attempt',async t=>{
  const nextOccupant=id(14);
  const f=fixture(t,{hydrated:[wireVoice(ownerId,lobbyId),wireVoice(nextOccupant,lobbyId)]});
  f.memberRows.set(nextOccupant,wireMember(nextOccupant));
  const otherMarker='other unfinished create';
  assert.ok(f.state.begin(guestId,otherMarker,'another-session',[]));
  let clock=10_000, rejectedMarker;
  const life=f.make({now:()=>clock});
  f.hooks.post=next=>{
    rejectedMarker=next.name;
    const durable=f.readPersisted(state=>state.byOwner(ownerId));
    assert.equal(durable.id,null);
    assert.equal(durable.marker,rejectedMarker);
    throw Object.assign(apiError(0,429),{retryAfter:'120'});
  };
  await life.reconcile();
  assert.deepEqual(f.timeline,['post']);
  assert.equal(f.reads.includes(Routes.guildMember(guildId,nextOccupant)),false);
  assert.equal(f.readPersisted(state=>state.byOwner(ownerId)),null);
  assert.equal(f.readPersisted(state=>state.byOwner(guestId)).marker,otherMarker);
  f.hooks.post=undefined;
  await life.voiceState({channelId:null},f.guild.voiceStates.cache.get(ownerId));
  await life.reconcile();
  clock+=61_000;
  await life.reconcile();
  assert.deepEqual(f.timeline,['post']);
  f.putVoice(nextOccupant,null);
  const readsBeforeRetry=f.reads.length;
  clock+=60_000;
  await life.reconcile();
  assert.deepEqual(f.timeline,['post','post','move','name','panel']);
  assert.notEqual(f.state.get(roomId).marker,rejectedMarker);
  assert.ok(f.reads.slice(readsBeforeRetry).includes(Routes.guildVoiceState(guildId,ownerId)));
});

test('SDK HTTP 429 on the initial member PATCH backs off and retries only the same bound room after restart',async t=>{
  const session='original-session';
  const f=fixture(t,{hydrated:[wireVoice(ownerId,lobbyId,session)]});
  let clock=10_000, marker;
  const life=f.make({now:()=>clock,moveGraceMs:30});
  f.hooks.patch=()=>{
    const durable=f.readPersisted(state=>state.get(roomId));
    assert.equal(durable.moveAt,clock);
    assert.equal(durable.ownerId,ownerId);
    assert.equal(durable.sessionId,session);
    marker=durable.marker;
    throw Object.assign(apiError(0,429),{retryAfter:'120'});
  };
  await life.reconcile();
  assert.deepEqual(f.timeline,['post','move']);
  assert.equal(f.readPersisted(state=>state.get(roomId).moveAt),null);
  f.hooks.patch=({channel_id})=>{f.putVoice(ownerId,channel_id,session);};
  f.reopen();
  const restarted=f.make({now:()=>clock,moveGraceMs:30});
  clock+=119_999;
  f.putVoice(guestId,roomId);
  await restarted.voiceState(...f.putVoice(guestId,null));
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move']);
  assert.equal(f.readPersisted(state=>state.get(roomId).marker),marker);
  clock+=1_001;
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','move','name','panel']);
  assert.deepEqual(f.writes.slice(1,3),Array(2).fill(['patch',Routes.guildMember(guildId,ownerId),{channel_id:roomId}]));
  assert.equal(f.readPersisted(state=>state.get(roomId).opened),true);
});

test('a late SDK HTTP 429 cannot clear an intent with a different attempt marker at the same timestamp',async t=>{
  const f=fixture(t), life=f.make({now:()=>100});
  let successor;
  f.hooks.patch=()=>{
    const original=f.state.get(roomId);
    assert.ok(f.state.rejectMove(original,100));
    successor=f.state.beginMove(f.state.get(roomId),100);
    assert.notEqual(successor.moveAttempt,original.moveAttempt);
    throw Object.assign(apiError(0,429),{retryAfter:'120'});
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.ok(successor);
  assert.equal(f.readPersisted(state=>state.get(roomId).moveAttempt),successor.moveAttempt);
  assert.equal(f.state.get(roomId).moveRetryAt,null);
  await life.reconcile();
  assert.deepEqual(f.timeline,['post','move']);
});

test('a rejected handoff cannot be retried via a replacement room in the same lobby session',async t=>{
  const f=fixture(t);
  let clock=100;
  const life=f.make({now:()=>clock});
  f.hooks.patch=()=>{throw Object.assign(apiError(0,429),{retryAfter:'120'});};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.raw.delete(roomId);
  f.hooks.patch=undefined;
  f.hooks.roomId=replacementId;
  clock+=121_000;
  await life.reconcile();
  assert.equal(f.state.get(roomId),null);
  f.reopen();
  await f.make({now:()=>clock}).reconcile();
  assert.deepEqual(f.timeline,['post','move']);
  assert.equal(f.raw.has(replacementId),false);
});

test('lobby ticks bound preflights and give unattempted users priority over ineligible retries',async t=>{
  const ineligible=[id(20),id(21),id(22),id(23)];
  const f=fixture(t,{hydrated:[wireVoice(botId,lobbyId),wireVoice(guestId,lobbyId,''),
    ...ineligible.map(user=>wireVoice(user,lobbyId)),wireVoice(ownerId,lobbyId)]});
  for(const user of ineligible) f.memberRows.set(user,wireMember(user,[]));
  let clock=100;
  const life=f.make({now:()=>clock});
  const lobbyMemberReads=()=>f.reads.filter(route=>route.includes('/members/')).map(route=>route.split('/').at(-1));
  await life.reconcile();
  assert.deepEqual(lobbyMemberReads(),ineligible.slice(0,3));
  assert.deepEqual(f.timeline,[]);
  clock+=60_000;
  await life.reconcile();
  assert.deepEqual(lobbyMemberReads().slice(3,5),[ineligible[3],ownerId]);
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('hydrated lobby recovery rejects a cache session when the exact voice read disagrees',async t=>{
  const f=fixture(t,{hydrated:[wireVoice(ownerId,lobbyId,'cached-session')]});
  f.voices.set(ownerId,wireVoice(ownerId,lobbyId,'live-session'));
  await f.make().reconcile();
  assert.ok(f.reads.includes(Routes.guildVoiceState(guildId,ownerId)));
  assert.deepEqual(f.writes,[]);
  assert.equal(f.state.byOwner(ownerId),null);
});

test('a timed-out create remains reserved across startup reconciliation without another POST',async t=>{
  const f=fixture(t,{hydrated:[wireVoice(ownerId,lobbyId)]});
  f.hooks.post=()=>{throw new DOMException('request timed out','TimeoutError');};
  await f.make().reconcile();
  const marker=f.state.byOwner(ownerId).marker;
  f.hooks.post=undefined;
  f.reopen();
  const restarted=f.make();
  await restarted.reconcile();
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post']);
  assert.equal(f.state.byOwner(ownerId).marker,marker);
  assert.equal(f.state.byOwner(ownerId).id,null);
});

test('an ambiguous absent create survives restart and excludes a renamed preexisting channel',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.post=()=>{throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  const marker=f.state.byOwner(ownerId).marker;
  f.raw.get(foreignId).name=marker;
  f.reopen();
  const restarted=f.make();
  await restarted.reconcile();
  assert.equal(f.state.byOwner(ownerId).id,null);
  f.raw.get(foreignId).name='existing voice';
  f.raw.set(waitingId,channel(waitingId,T.GuildStageVoice,{name:marker,parent_id:categoryId}));
  await restarted.reconcile();
  await restarted.voiceState(...f.putVoice(ownerId,null));
  await restarted.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.state.byOwner(ownerId).id,null);
  assert.deepEqual(f.timeline,['post']);
  assert.ok(f.raw.has(foreignId));
  assert.ok(f.raw.has(waitingId));
});

test('a committed create with lost response is adopted on restart and an abandoned empty room removed',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.post=next=>{f.raw.set(roomId,next);throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.state.byOwner(ownerId).id,null);
  f.putVoice(ownerId,null);
  f.reopen();
  await f.make().reconcile();
  assert.deepEqual(f.timeline,['post','delete']);
  assert.equal(f.state.byOwner(ownerId),null);
  assert.ok(f.raw.has(foreignId));
});

test('restart hands off an adopted create to the original lobby session without posting again',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.post=next=>{f.raw.set(roomId,next);throw apiError(0,504);};
  f.memberRows.get(ownerId).user.global_name='Global display name';
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.state.byOwner(ownerId).id,null);
  // An early guest does not consume the owner's one reserved handoff.
  f.putVoice(guestId,roomId);
  f.reopen();
  const restarted=f.make();
  await restarted.reconcile();
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  assert.equal(f.voices.get(ownerId).channel_id,roomId);
  assert.equal(f.raw.get(roomId).name,'Global display name');
  assert.equal(f.state.get(roomId).opened,true);
});

test('an unavailable post-create readback leaves the join recoverable without rejecting it',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.beforeGet=route=>{
    if(route===Routes.channel(roomId)&&f.raw.has(roomId)) throw apiError(0,503);
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.state.byOwner(ownerId).id,null);
  f.hooks.beforeGet=undefined;
  f.reopen();
  await f.make().reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('restart after binding but before move uses the reserved lobby session',async t=>{
  const f=fixture(t);
  const [oldVoice,newVoice]=f.putVoice(ownerId,lobbyId);
  const life=f.make();
  // Interrupt handoff at its first member read, after the reservation was bound.
  f.hooks.beforeGet=route=>{
    if(route===Routes.guildMember(guildId,ownerId)&&f.state.get(roomId)) throw apiError(0,503);
  };
  await life.voiceState(oldVoice,newVoice);
  assert.equal(f.state.get(roomId).moveAt,null);
  await life.reconcile();
  assert.deepEqual(f.timeline,['post']);
  f.hooks.beforeGet=undefined;
  f.reopen();
  await f.make().reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  assert.equal(f.raw.get(roomId).name,ownerId);
});

test('restart reads the latest durable capacity-lock phase before moving the owner',async t=>{
  for(const phase of ['locking','locked','opening']) await t.test(phase,async t=>{
    const f=fixture(t), life=f.make();
    f.hooks.beforeGet=route=>{
      if(route===Routes.guildMember(guildId,ownerId)&&f.state.get(roomId)) throw apiError(0,503);
    };
    await life.voiceState(...f.putVoice(ownerId,lobbyId));
    assert.equal(f.state.get(roomId).moveAt,null);
    f.reopen();
    f.hooks.beforeGet=route=>{
      if(route===Routes.channel(roomId)&&!f.state.getCapacityLock(roomId)) {
        const {lockGeneration}=f.state.get(roomId);
        assert.ok(f.state.replaceCapacityLock(roomId,ownerId,null,{phase,priorLimit:0},lockGeneration));
      }
    };
    await f.make().reconcile();
    assert.deepEqual(f.timeline,['post']);
    assert.equal(f.state.get(roomId).moveAt,null);
    assert.equal(f.state.getCapacityLock(roomId).phase,phase);
    assert.equal(f.voices.get(ownerId).channel_id,lobbyId);
  });
});

test('restart checks exact room capacity and never force-moves into a room that became full',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.post=next=>{f.raw.set(roomId,next);throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.putVoice(guestId,roomId);
  f.reopen();
  f.hooks.beforeGet=route=>{
    if(route===Routes.channel(roomId)) f.raw.get(roomId).user_limit=1;
  };
  const restarted=f.make();
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post']);
  assert.equal(f.state.get(roomId).moveAt,null);
  assert.equal(f.voices.get(ownerId).channel_id,lobbyId);
  assert.equal(f.voices.get(guestId).channel_id,roomId);
  f.hooks.beforeGet=undefined;
  f.raw.get(roomId).user_limit=2;
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('leaving an unstarted room for the lobby does not trigger a stale handoff back to it',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.beforeGet=route=>{
    if(route===Routes.guildMember(guildId,ownerId)&&f.state.get(roomId)) throw apiError(0,503);
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.hooks.beforeGet=undefined;
  f.putVoice(ownerId,roomId);
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.timeline,['post','delete','post','move','name','panel']);
});

test('an uncommitted rename does not block the move or panel and is recovered from the exact marker',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.rename=()=>{throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.voices.get(ownerId).channel_id,roomId);
  assert.equal(f.raw.get(roomId).name,f.state.get(roomId).marker);
  assert.ok(f.state.get(roomId).panelReady);
  f.hooks.rename=undefined;
  f.reopen();
  const restarted=f.make();
  await restarted.reconcile();
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel','name']);
  assert.equal(f.raw.get(roomId).name,ownerId);
});

test('restart repairs the name after an unverified move without issuing a second move',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.patch=({channel_id})=>{
    f.putVoice(ownerId,channel_id);
    f.hooks.beforeGet=route=>{
      if(route===Routes.guildVoiceState(guildId,ownerId)) throw apiError(0,503);
    };
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.ok(f.state.get(roomId).moveAt!==null);
  assert.equal(f.raw.get(roomId).name,f.state.get(roomId).marker);
  f.hooks.beforeGet=undefined;
  f.reopen();
  await f.make().reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  assert.equal(f.raw.get(roomId).name,ownerId);
  assert.ok(f.state.get(roomId).panelReady);
});

test('an original owner can return to the lobby immediately after a lost move reply and failed direct readback',async t=>{
  for(const evidence of ['reconciled gateway occupancy','reconciled direct voice with an early guest','gateway entry','gateway departure']) await t.test(evidence,async t=>{
    const f=fixture(t), life=f.make();
    const session=`voice-session-${ownerId}`;
    let entry;
    f.hooks.patch=({channel_id})=>{
      if(evidence==='reconciled direct voice with an early guest') f.voices.set(ownerId,wireVoice(ownerId,channel_id,session));
      else entry=f.putVoice(ownerId,channel_id,session);
      f.hooks.beforeGet=route=>{
        if(route===Routes.guildVoiceState(guildId,ownerId)) throw apiError(0,503);
      };
      throw apiError(0,504);
    };
    await life.voiceState(...f.putVoice(ownerId,lobbyId,session));
    const first=f.readPersisted(state=>state.get(roomId));
    assert.notEqual(first.moveAt,null);
    assert.equal(first.opened,false);
    if(evidence!=='gateway departure') {
      if(evidence==='reconciled direct voice with an early guest') {
        f.putVoice(guestId,roomId);
        f.hooks.beforeGet=undefined;
      }
      if(evidence==='gateway entry') await life.voiceState(...entry);
      else await life.reconcile();
      assert.equal(f.readPersisted(state=>state.get(roomId).opened),true);
      if(evidence==='reconciled direct voice with an early guest') {
        f.putVoice(guestId,null);
        f.putVoice(ownerId,roomId,session);
      }
    }
    f.hooks.patch=undefined;
    f.hooks.beforeGet=undefined;
    await life.voiceState(...f.putVoice(ownerId,lobbyId,session));
    assert.equal(f.timeline.filter(entry=>entry==='move').length,2);
    const second=f.readPersisted(state=>state.get(roomId));
    assert.notEqual(second.marker,first.marker);
    assert.equal(second.sessionId,session);
    assert.equal(second.opened,true);
  });
});

const memberMoves=f=>f.writes.filter(([,route])=>route===Routes.guildMember(guildId,ownerId)).map(([, ,body])=>body.channel_id);

test('expired SDK gateway entry and return retain exact proof during lost move readback',async t=>{
  const f=fixture(t), life=f.make({queueTimeoutMs:15});
  const session='same-session-after-move';
  let reading, release;
  const started=new Promise(resolve=>{reading=resolve;});
  const finishing=new Promise(resolve=>{release=resolve;});
  f.hooks.patch=()=>{
    f.hooks.beforeGet=async route=>{
      if(route!==Routes.guildVoiceState(guildId,ownerId)) return;
      reading();
      await finishing;
      throw apiError(0,503);
    };
    throw apiError(0,504);
  };
  const join=f.replayVoice(life,ownerId,lobbyId,session);
  await started;
  let openedWhileLocked;
  try {
    const enter=f.replayVoice(life,ownerId,roomId,session);
    const back=f.replayVoice(life,ownerId,lobbyId,session);
    const entryResult=Promise.allSettled([enter]);
    await assert.rejects(back,/Temporary voice lock timed out/);
    // A qualifying arrival may need no queued work at all. If queued, it must expire too.
    for(const result of await entryResult) {
      if(result.status==='rejected') assert.match(result.reason.message,/Temporary voice lock timed out/);
    }
    openedWhileLocked=f.readPersisted(state=>state.get(roomId).opened);
  } finally {release();}
  await join;
  assert.equal(openedWhileLocked,true,'the exact move was proven before the readback or either queued callback finished');
  f.hooks.patch=f.hooks.beforeGet=undefined;
  f.hooks.roomId=replacementId;
  await life.reconcile();
  assert.equal(f.raw.has(roomId),false);
  assert.deepEqual(memberMoves(f),[roomId]);
  await life.reconcile();
  assert.deepEqual(memberMoves(f),[roomId,replacementId]);
  assert.equal(f.state.get(replacementId).sessionId,session);
});

async function retireAmbiguousRoom(f,life,session) {
  f.hooks.patch=()=>{throw apiError(0,504);};
  await f.replayVoice(life,ownerId,lobbyId,session);
  await f.replayVoice(life,guestId,roomId);
  const actions=f.actions(life);
  const request={guildId,sourceId:roomId,actorId:guestId,roomId,expectedLocked:false,expectedLockGeneration:'0'};
  assert.equal(await actions.run({...request,kind:'claim',expectedOwnerId:ownerId}),'أصبحت مالك الغرفة.');
  assert.equal(f.state.get(roomId).ownerId,guestId);
  assert.equal(await actions.run({...request,kind:'delete',expectedOwnerId:guestId}),'تم حذف الغرفة المؤقتة.');
  assert.equal(f.state.get(roomId),null);
  assert.equal(f.raw.has(roomId),false);
  f.hooks.patch=undefined;
  f.hooks.roomId=replacementId;
}

test('claim and delete through real actions cannot replay an ambiguous move on the next lobby tick',async t=>{
  const f=fixture(t), life=f.make();
  await retireAmbiguousRoom(f,life,'original-session');
  await life.reconcile();
  assert.deepEqual(memberMoves(f),[roomId]);
  assert.equal(f.raw.has(replacementId),false);
});

test('an ambiguous retired handoff stays fenced after restart until REST confirms the fresh lobby session',async t=>{
  const original='original-session', fresh='fresh-session';
  const f=fixture(t);
  let clock=100;
  await retireAmbiguousRoom(f,f.make({now:()=>clock}),original);
  f.reopen();
  const restarted=f.make({now:()=>clock});
  clock+=86_400_000;
  await restarted.reconcile();
  assert.deepEqual(memberMoves(f),[roomId],'time and restart cannot release the original voice session');
  f.putVoice(ownerId,lobbyId,fresh);
  f.voices.set(ownerId,wireVoice(ownerId,lobbyId,original));
  await restarted.reconcile();
  assert.deepEqual(memberMoves(f),[roomId],'a changed cache session alone cannot release or authorize a move');
  f.putVoice(ownerId,foreignId,original);
  await f.replayVoice(restarted,ownerId,lobbyId,original);
  assert.deepEqual(memberMoves(f),[roomId],'a mismatched fresh observation must leave the old fence intact');
  await f.replayVoice(restarted,ownerId,null,original);
  clock+=60_000; // The failed preflight's in-memory lobby backoff still applies.
  let fencedAtDispatch;
  f.hooks.patch=({channel_id})=>{
    fencedAtDispatch=f.readPersisted(state=>[original,fresh].map(session=>state.hasUnsettledHandoff(ownerId,session)));
    f.putVoice(ownerId,channel_id,fresh);
  };
  await f.replayVoice(restarted,ownerId,lobbyId,fresh);
  assert.deepEqual(memberMoves(f),[roomId,replacementId]);
  assert.deepEqual(fencedAtDispatch,[false,true]);
  assert.equal(f.state.get(replacementId).sessionId,fresh);
  assert.equal(f.state.get(replacementId).opened,true);
});

test('late exact gateway proof releases a retired ambiguous handoff for the same-session return',async t=>{
  const session='original-session';
  const f=fixture(t), life=f.make();
  await retireAmbiguousRoom(f,life,session);
  // Re-create an exact late gateway delivery, not the Discord room or its SQLite row.
  // Wrong user and wrong session must not release the original member's fence.
  await f.replayVoice(life,guestId,foreignId,session);
  await f.replayVoice(life,guestId,roomId,session);
  await f.replayVoice(life,ownerId,roomId,'wrong-session');
  await f.replayVoice(life,ownerId,lobbyId,session);
  assert.deepEqual(memberMoves(f),[roomId]);
  await f.replayVoice(life,ownerId,roomId,session);
  await f.replayVoice(life,ownerId,lobbyId,session);
  assert.deepEqual(memberMoves(f),[roomId,replacementId]);
  assert.equal(f.state.get(replacementId).sessionId,session);
});

test('migration carries a V3 move fence for the original owner of a claimed room into durable retirement',async t=>{
  const f=fixture(t), legacySession='legacy-owner-session';
  f.state.begin(ownerId,'legacy-marker',legacySession,[]);
  f.state.bind(ownerId,'legacy-marker',roomId);
  f.state.update(roomId,{ownerId:guestId});
  // Emulate the on-disk V3 representation, which was part of the managed room row.
  const legacy=f.readPersisted((_state,db)=>{
    db.exec('DROP TABLE IF EXISTS lxr_temp_voice_handoff');
    return db.prepare(`UPDATE lxr_temp_voice SET move_at=42,move_attempt='legacy-attempt' WHERE id=?`).run(roomId);
  });
  assert.equal(legacy.changes,1);
  f.reopen();
  f.state.remove(roomId);
  f.reopen();
  f.hooks.roomId=replacementId;
  await f.replayVoice(f.make(),ownerId,lobbyId,legacySession);
  assert.deepEqual(memberMoves(f),[]);
  assert.equal(f.raw.has(replacementId),false);
});

test('guest occupancy, a replacement session, and a changed owner do not confirm an ambiguous move',async t=>{
  for(const evidence of ['early guest','replacement session','changed owner']) await t.test(evidence,async t=>{
    const f=fixture(t), life=f.make();
    f.hooks.patch=()=>{throw apiError(0,504);};
    await life.voiceState(...f.putVoice(ownerId,lobbyId));
    if(evidence==='early guest') await life.voiceState(...f.putVoice(guestId,roomId));
    if(evidence==='replacement session') await life.voiceState(...f.putVoice(ownerId,roomId,'replacement-session'));
    if(evidence==='changed owner') {
      f.state.update(roomId,{ownerId:guestId});
      await life.voiceState(...f.putVoice(guestId,roomId,`voice-session-${ownerId}`));
    }
    await life.reconcile();
    assert.equal(f.readPersisted(state=>state.get(roomId).opened),false);
    assert.equal(f.timeline.filter(entry=>entry==='move').length,1);
    assert.equal(f.timeline.filter(entry=>entry==='post').length,1);
  });
});

test('an ambiguous committed rename is read back and is never repeated after restart',async t=>{
  const f=fixture(t), life=f.make();
  let readsAtRename;
  f.hooks.rename=({name})=>{
    readsAtRename=f.reads.length;
    f.raw.get(roomId).name=name;
    throw apiError(0,504);
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.reads[readsAtRename],Routes.channel(roomId));
  assert.equal(f.raw.get(roomId).name,ownerId);
  f.memberRows.get(ownerId).nick='updated nickname';
  f.reopen();
  await f.make().reconcile();
  assert.equal(f.raw.get(roomId).name,ownerId);
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('recovery preserves an explicit rename made after inventory but before the channel read',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.rename=()=>{throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  const marker=f.state.get(roomId).marker;
  f.reopen();
  f.hooks.beforeGet=route=>{
    if(route===Routes.channel(roomId)&&f.raw.get(roomId).name===marker) f.raw.get(roomId).name='Custom voice name';
  };
  await f.make().reconcile();
  assert.equal(f.raw.get(roomId).name,'Custom voice name');
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('restart never hands off an adopted room to a different lobby session',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.post=next=>{f.raw.set(roomId,next);throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId,'original-session'));
  f.putVoice(ownerId,lobbyId,'replacement-session');
  f.reopen();
  await f.make().reconcile();
  assert.equal(f.voices.get(ownerId).channel_id,lobbyId);
  assert.deepEqual(f.timeline,['post','delete']);
});

test('an owner leaving with a guest does not delete the room, but the final guest leaving does',async t=>{
  const f=fixture(t), life=f.make();
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.putVoice(guestId,roomId);
  await life.voiceState(...f.putVoice(ownerId,null));
  assert.ok(f.state.get(roomId));
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  await life.voiceState(...f.putVoice(guestId,null));
  assert.equal(f.state.get(roomId),null);
  assert.deepEqual(f.timeline,['post','move','name','panel','delete']);
  assert.ok(f.raw.has(lobbyId));
  assert.ok(f.raw.has(foreignId));
});

test('a restart with unhealthy gateway or a guest arriving during readback never removes that room',async t=>{
  const f=fixture(t), life=f.make();
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.putVoice(ownerId,null);
  f.reopen();
  const restarted=f.make();
  f.ready(false);
  await assert.rejects(restarted.reconcile(),/gateway not ready/);
  assert.ok(f.state.get(roomId));
  f.ready(true);
  f.hooks.beforeGet=route=>{
    if(route===Routes.channel(roomId)) f.putVoice(guestId,roomId);
  };
  await restarted.reconcile();
  assert.ok(f.state.get(roomId));
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('control updates are durable, merge allowed fields, and cannot create or duplicate mappings',async t=>{
  const f=fixture(t);
  await f.make().voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.state.update(foreignId,{privacy:'hidden'}),null);
  assert.throws(()=>f.state.update(roomId,{id:foreignId}),/Invalid temporary voice update/);
  assert.ok(f.state.begin(guestId,'another-provisional','another-session',[]));
  assert.throws(()=>f.state.update(roomId,{ownerId:guestId}));
  assert.ok(f.state.cancel(guestId,'another-provisional'));
  const next=f.state.update(roomId,{ownerId:guestId,waitingId,waitingMarker:'waiting-exact',trusted:[ownerId,ownerId]});
  assert.equal(next.privacy,'open');
  assert.deepEqual(next.trusted,[ownerId]);
  f.reopen();
  assert.equal(f.state.byOwner(ownerId),null);
  assert.equal(f.state.byOwner(guestId).id,roomId);
  assert.equal(f.state.byWaiting(waitingId).waitingMarker,'waiting-exact');
});

test('main cleanup does not disconnect a waiting guest and removes the pair once it is empty',async t=>{
  const f=fixture(t), life=f.make();
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.raw.set(waitingId,channel(waitingId,T.GuildVoice,{name:'waiting-exact',parent_id:categoryId}));
  f.state.update(roomId,{waitingId,waitingMarker:'waiting-exact'});
  f.putVoice(guestId,waitingId);
  await life.voiceState(...f.putVoice(ownerId,null));
  assert.deepEqual(f.writes.filter(([method])=>method==='delete'),[['delete',Routes.channel(roomId)]]);
  assert.equal(f.state.byWaiting(waitingId).id,roomId);
  await life.voiceState(...f.putVoice(guestId,null));
  assert.deepEqual(f.writes.filter(([method])=>method==='delete'),[['delete',Routes.channel(roomId)],['delete',Routes.channel(waitingId)]]);
  assert.equal(f.state.byWaiting(waitingId),null);
  assert.equal(f.state.get(roomId),null);
});

test('a foreign delete event cannot clear waiting state, but verified absence is recovered even if the real event is lost',async t=>{
  const f=fixture(t), life=f.make();
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.raw.set(waitingId,channel(waitingId,T.GuildVoice,{name:'waiting-exact',parent_id:categoryId}));
  f.state.update(roomId,{waitingId,waitingMarker:'waiting-exact'});
  await life.channelDeleted({id:waitingId,guildId:id(11),type:T.GuildVoice});
  await life.channelDeleted({id:waitingId,guildId,type:T.GuildVoice});
  assert.equal(f.state.get(roomId).waitingId,waitingId);
  f.raw.delete(waitingId);
  await life.reconcile();
  assert.equal(f.state.get(roomId).waitingId,null);
  f.raw.delete(roomId);
  await life.channelDeleted({id:roomId,guildId,type:T.GuildVoice});
  assert.equal(f.state.get(roomId),null);
  assert.deepEqual(f.timeline,['post','move','name','panel']);
});

test('shared lock rejects excess, expired, and recursive work without running it',async t=>{
  const f=fixture(t), life=f.make({maxQueued:1,queueTimeoutMs:10});
  let release;
  const order=[];
  const first=life.exclusive(async()=>{
    order.push('first');
    await assert.rejects(life.exclusive(()=>order.push('recursive')),/recursive/i);
    await new Promise(resolve=>{release=resolve;});
    order.push('released');
  });
  await new Promise(resolve=>setImmediate(resolve));
  const expired=assert.rejects(life.exclusive(()=>order.push('expired')),/timed out/i);
  await assert.rejects(life.exclusive(()=>order.push('overflow')),/busy/i);
  await expired;
  try {assert.deepEqual(order,['first']);} finally {release();}
  await first;
  await life.exclusive(()=>order.push('next'));
  assert.deepEqual(order,['first','released','next']);
});

test('stale cached guild ownership cannot bypass refreshed category access',async t=>{
  const f=fixture(t), life=f.make();
  f.guild.ownerId=ownerId;
  f.memberRows.set(ownerId,wireMember(ownerId,[]));
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.writes,[]);
  assert.equal(f.state.byOwner(ownerId),null);
});

test('an ambiguous failed move is not replayed and the empty room is only removed after its grace period',async t=>{
  const f=fixture(t);
  let now=100;
  const life=f.make({now:()=>now,moveGraceMs:30});
  f.hooks.patch=()=>{throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.equal(f.state.get(roomId).moveAt,100);
  f.putVoice(ownerId,foreignId);
  await life.reconcile();
  assert.deepEqual(f.timeline,['post','move']);
  now=131;
  await life.reconcile();
  assert.deepEqual(f.timeline,['post','move','delete']);
  assert.equal(f.state.get(roomId),null);
  assert.ok(f.raw.has(foreignId));
});

test('periodic lobby recovery does not recreate a cleaned room for the same ambiguous move session',async t=>{
  const f=fixture(t,{hydrated:[wireVoice(ownerId,lobbyId)]});
  let now=100;
  const life=f.make({now:()=>now,moveGraceMs:30});
  f.hooks.patch=()=>{throw apiError(0,504);};
  await life.reconcile();
  assert.equal(f.state.get(roomId).moveAt,100);
  now=131;
  await life.reconcile();
  assert.equal(f.raw.has(roomId),false);
  f.reopen();
  const restarted=f.make({now:()=>now,moveGraceMs:30});
  now+=60_000;
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','delete']);
  assert.equal(f.voices.get(ownerId).channel_id,lobbyId);
  f.putVoice(ownerId,foreignId);
  await restarted.reconcile();
  assert.equal(f.state.get(roomId),null);
});

test('panels are retried separately after recovery without another move',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.patch=({channel_id})=>{f.putVoice(ownerId,channel_id);throw apiError(0,504);};
  f.hooks.panel=()=>{throw apiError(0,504);};
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.ok(f.state.get(roomId).opened);
  assert.equal(f.state.get(roomId).panelReady,false);
  f.reopen();
  f.hooks.panel=undefined;
  const restarted=f.make();
  await restarted.reconcile();
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel','panel']);
  assert.equal(f.state.get(roomId).panelReady,true);
});

test('panel delivery rechecks ACLs after the move and retries only once the room matches',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.patch=({channel_id})=>{
    f.putVoice(ownerId,channel_id);
    f.raw.get(categoryId).permission_overwrites=[...acl,overwrite(guestId,O.Member,0n,P.Connect)];
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.timeline,['post','move','name']);
  assert.equal(f.readPersisted(state=>state.get(roomId).panelReady),false);
  f.reopen();
  const restarted=f.make();
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','name']);
  f.raw.get(roomId).permission_overwrites=structuredClone(f.raw.get(categoryId).permission_overwrites);
  await restarted.reconcile();
  await restarted.reconcile();
  assert.deepEqual(f.timeline,['post','move','name','panel']);
  assert.equal(f.readPersisted(state=>state.get(roomId).panelReady),true);
});

test('panel delivery skips a room that became empty during the ACL readback',async t=>{
  const f=fixture(t), life=f.make();
  f.hooks.rename=({name})=>{
    f.raw.get(roomId).name=name;
    let roomReads=0;
    f.hooks.beforeGet=route=>{
      if(route===Routes.channel(roomId)&&++roomReads===2) f.putVoice(ownerId,null);
    };
  };
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  assert.deepEqual(f.timeline,['post','move','name']);
  assert.equal(f.readPersisted(state=>state.get(roomId).panelReady),false);
});

test('renamed waiting room is outside the verified pairing and is left untouched',async t=>{
  const f=fixture(t), life=f.make();
  await life.voiceState(...f.putVoice(ownerId,lobbyId));
  f.raw.set(waitingId,channel(waitingId,T.GuildVoice,{name:'different',parent_id:categoryId}));
  f.state.update(roomId,{waitingId,waitingMarker:'waiting-exact'});
  await life.voiceState(...f.putVoice(ownerId,null));
  await life.reconcile();
  assert.deepEqual(f.writes.filter(([method])=>method==='delete'),[['delete',Routes.channel(roomId)]]);
  assert.ok(f.raw.has(waitingId));
  assert.equal(f.state.byWaiting(waitingId).id,roomId);
});
