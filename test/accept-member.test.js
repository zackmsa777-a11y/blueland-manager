'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {REST,Routes,ChannelType,GuildChannel,Collection,PermissionFlagsBits:P}=require('discord.js');
const {catalog,roles,planPromotion}=require('../src/ladder');
const {createMessageHandler}=require('../src/chat');
const {openStore}=require('../src/store');
const {makeService}=require('../src/promotions');
const {marker,MANAGERS}=require('../src/ticket-ui');
const {guildId,botId}=catalog;
const actor='200000000000000001', target='200000000000000002', owner='200000000000000003';
const apply='1574013532586909736', power='1574012924916142140', above='1574012921090932836';
const grants=['1574013472013033622','1575153809603428393','1574013576694210731','1574013479466303499','1574013476358328441'];
const botRole='1573988437088932015', existing='1574013656163819580';
const expected=`<:G_21:1574000061229305886> **تمت إضافة رتبك يا <@${target}>. نورتنا بالإدارة!** <:G_23:1574000035115302912>\n<:G_25:1574000020783370370> مرّ على <#1575179775671140442> عشان تتابع أخبار الطاقم.`;
const origin='300000000000000011', command='300000000000000012';
const retryChannel='300000000000000031', retryCommand='300000000000000032';
const deadReference=[400,{code:50035,message:'Invalid Form Body',errors:{message_reference:{_errors:[
  {code:'MESSAGE_REFERENCE_UNKNOWN_MESSAGE',message:'Unknown message'}]}}}];
const unknownMessage=[404,{code:10008,message:'Unknown Message'}];
function fixture({actorRoles=[apply,power],targetRoles=[existing],botRoles=[botRole],targetBot=false,roleChange,failAt,skipWrite=false,ticketMessages,afterWrite,
  channels=[],acceptOverwrites={},useReviewedFile=false,store,failWelcome,failReadback=false,welcomeResponses=[],loseReceiptFor}={}) {
  if (!store) {
    const pending=new Map();
    store={pending:()=>null,community:{ticketByChannel:()=>null},acceptance:{
      byTarget:target=>pending.get(target),
      begin:(target,channel,reference)=>{const row={target,channel,reference,confirmed:0,attempted:null,posted:null};pending.set(target,row);return row;},
      markAttempt:(target,ref,stamp)=>{const row=pending.get(target);row.confirmed=1;row.attempted??=stamp;},
      markPosted:(target,ref,posted)=>{pending.get(target).posted=posted;},
      complete:target=>pending.delete(target)
    }};
  }
  const members=new Map([[actor,{user:{id:actor},roles:actorRoles}],[target,{user:{id:target,bot:targetBot},roles:[...targetRoles]}],[botId,{user:{id:botId,bot:true},roles:botRoles}]]);
  const current=[...roles.values()].map(r=>({...r}));
  roleChange?.(current);
  const writes=[], replies=[], sends=[], attempts=[], posted=[], transport=[];
  const responses=failWelcome==='definite'?[[403,{code:50013,message:'Missing Permissions'}]]:[...welcomeResponses];
  const sdk=responses.length && new REST({makeRequest:async(url,options)=>{
    transport.push({url,body:JSON.parse(options.body)});
    assert.ok(responses.length,'unexpected transport retry');
    const [status,data]=responses.shift();
    return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  }}).setToken('test-only');
  if (sdk) {sdk.clearHashSweeper();sdk.clearHandlerSweeper();}
  const client={user:{id:botId},rest:{
    on:(...args)=>sdk?.on?.(...args),off:(...args)=>sdk?.off?.(...args),
    async get(path,{query}={}){
      if (path===Routes.guild(guildId)) return {id:guildId,owner_id:owner};
      if (path===Routes.guildRoles(guildId)) return current.map(role=>({...role}));
      if (path===Routes.guildChannels(guildId)) return structuredClone(channels);
      if (query) return posted.filter(m=>path===Routes.channelMessages(m.channel_id));
      const receipt=posted.find(m=>path===Routes.channelMessage(m.channel_id,m.id));
      if (receipt) {
        if (failReadback) {failReadback=false;throw new Error('receipt read failed');}
        return receipt;
      }
      const m=members.get(path.split('/').at(-1)); return m&&{...m,roles:[...m.roles]};
    },
    async post(path,{body,signal}) {
      attempts.push(body);
      assert.equal(path,Routes.channelMessages(body.message_reference.channel_id));
      if (attempts.length===1 && failWelcome==='before') throw new Error('welcome failed');
      if (responses.length) return sdk.post(path,{body,signal});
      const old=posted.find(m=>m.nonce===body.nonce && body.enforce_nonce);
      if (old) return old;
      const m={id:'300000000000000013',channel_id:body.message_reference.channel_id,author:{id:botId},content:body.content,
        nonce:body.nonce,message_reference:body.message_reference,mentions:[{id:target}]};
      posted.push(m);
      replies.push({payload:{content:body.content,allowedMentions:{parse:body.allowed_mentions.parse,repliedUser:body.allowed_mentions.replied_user,users:body.allowed_mentions.users}},held:[...members.get(target).roles]});
      if ((attempts.length===1 && failWelcome==='after') || body.nonce===loseReceiptFor) throw new Error('welcome accepted but response lost');
      return m;
    },
    async put(path,{reason}){
      const roleId=grants.find(id=>path===Routes.guildMemberRole(guildId,target,id));
      if (!roleId) throw new Error('unexpected target or role');
      writes.push(roleId);
      assert.match(reason,new RegExp(actor));
      if (roleId===failAt) throw new Error('Discord write failed');
      if (!skipWrite) members.get(target).roles.push(roleId);
      await afterWrite?.({members,roles:current,writes});
    }
  }};
  let handle;
  const reopen=nextStore=>{handle=createMessageHandler({store:nextStore,ticketMessages,acceptOverwrites:useReviewedFile?undefined:acceptOverwrites});};
  reopen(store);
  const send=(content=`+مقبول <@${target}>`,overrides={})=>handle({content,id:command,channelId:origin,author:{id:actor},client,guildId,inGuild:()=>true,
    guild:{id:guildId,ownerId:owner,members:{fetch:async()=>({roles:{cache:new Set(actorRoles)}})}},
    channel:{async send(p){sends.push(p);}},async reply(p){if (p.content===expected && failWelcome) throw new Error('welcome failed');replies.push({payload:p,held:[...members.get(target).roles]});},...overrides});
  return {writes,replies,sends,members,send,reopen,attempts,posted,transport};
}

test('acceptance replies to the command after confirming exactly the five missing roles',async()=>{
  const f=fixture({actorRoles:[apply,above],targetRoles:[existing,grants[1]]});
  await f.send();
  assert.deepEqual(f.writes,grants.filter(id=>id!==grants[1]));
  assert.deepEqual(f.replies,[{payload:{content:expected,allowedMentions:{parse:[],repliedUser:false,users:[target]}},held:[existing,grants[1],...f.writes]}]);
  assert.deepEqual(f.sends,[]);
  await f.send();
  assert.equal(f.writes.length,4);
  assert.match(f.replies.at(-1).payload.content,/موجودة/u);
});

test('neither supervisor rank nor Apply Managers alone can grant roles',async()=>{
  for (const actorRoles of [[apply],[power],[above],[apply,existing]]) {
    const f=fixture({actorRoles});await f.send();
    assert.deepEqual(f.writes,[]);assert.deepEqual(f.replies,[]);
  }
});

test('invalid targets, unsafe role changes and failed grants never get the welcome',async()=>{
  for (const opts of [{targetBot:true},{targetRoles:[power]},{botRoles:[existing]},
    {targetRoles:['1574013468758253588']},
    {roleChange:list=>{list.find(r=>r.id===grants[1]).permissions='8';}},
    {failAt:grants[1]},{skipWrite:true}]) {
    const f=fixture(opts);await f.send();
    assert.equal(f.replies.length,1);
    assert.notEqual(f.replies[0].payload.content,expected);
    if (!opts.failAt && !opts.skipWrite) assert.deepEqual(f.writes,[]);
  }
});

test('bare acceptance keeps the old response; foreign guild and malformed commands make no writes',async()=>{
  const f=fixture();
  await f.send('+مقبول');
  assert.equal(f.sends.length,1);
  assert.match(f.sends[0].content,/يرجى وضع الشعار/u);
  await f.send(`+مقبول <@${target}>`,{guildId:owner});
  await f.send(`+مقبول <@${target}> <@${owner}>`);
  await f.send(`+مقبول ${target}`);
  assert.deepEqual(f.writes,[]);
});

test('only exact targeted acceptance runs before ticket text; bare and near matches still reach ticket handling',async()=>{
  const ticketText=[];
  const f=fixture({ticketMessages:async (_,text)=>{ticketText.push(text);return true;}});
  const near=['+مقبول',`+مقبول <@${target}> extra`,`+مقبول ${target}`,`+مقبول <@&${target}>`,`+مقبولون <@${target}>`];
  for (const text of near) await f.send(text);
  await f.send();
  assert.deepEqual(ticketText,near);
  assert.deepEqual(f.writes,grants);
});

test('each subsequent role PUT rechecks live actor, target, bot, and grant roles',async t=>{
  for (const [name,change] of [
    ['Apply Managers removed',({members})=>{members.get(actor).roles=[power];}],
    ['actor rank removed',({members})=>{members.get(actor).roles=[apply];}],
    ['power threshold moved',({roles})=>{roles.find(r=>r.id===power).position=roles.find(r=>r.id===above).position+1;}],
    ['target hierarchy changed',({members})=>{members.get(target).roles.push(power);}],
    ['bot hierarchy changed',({members})=>{members.get(botId).roles=[existing];}],
    ['a grant gains permissions',({roles})=>{roles.find(r=>r.id===grants[1]).permissions='8';}],
  ]) await t.test(name,async()=>{
    const actorRoles=name==='power threshold moved'?[apply,above]:[apply,power];
    const f=fixture({actorRoles,afterWrite:state=>{if (state.writes.length===1) change(state);}});
    await f.send();
    assert.deepEqual(f.writes,[grants[0]]);
    assert.ok(f.replies.every(r=>r.payload.content!==expected));
  });
});

test('final role readback rejects a foreign ladder grade added with the last PUT',async()=>{
  const f=fixture({afterWrite:({members,writes})=>{
    if (writes.length===grants.length) members.get(target).roles.push('1574013468758253588');
  }});
  await f.send();
  assert.deepEqual(f.writes,grants);
  assert.ok(f.replies.every(r=>r.payload.content!==expected));
});

const channelId='300000000000000001', categoryId='300000000000000002', guest='300000000000000003';
const overwrite=(id,allow,deny=0n,type=0)=>({id,type,allow:String(allow),deny:String(deny)});
const channel=(id,overwrites=[],fields={})=>({id,type:ChannelType.GuildText,permission_overwrites:overwrites,...fields});
const read=P.ViewChannel|P.ReadMessageHistory, ticketBits=read|P.SendMessages|P.AttachFiles|P.EmbedLinks;
const claimWrite=P.SendMessages|P.SendMessagesInThreads|P.CreatePublicThreads|P.CreatePrivateThreads;
const support=grants[2];

function ticketFixture(kind,{claimed=false,state='open',file=':memory:'}={}) {
  const store=openStore(file), opener='300000000000000021';
  const db=store.community, {id}=db.reserveTicket('ticket:'+kind,opener,'test',kind==='legacy'?undefined:kind);
  db.setChannel(id,channelId);
  if (claimed) {
    db.startClaim(id,actor,null);
    db.finishClaim(db.claimChange(id));
  }
  if (state!=='open') {
    db.ticketState(id,'open','closing');
    if (state!=='closing') db.ticketState(id,'closing','closed');
    if (state==='reopening') db.ticketState(id,'closed','reopening');
  }
  const closed=state==='closed' || state==='reopening';
  const ow=[overwrite(guildId,0n,P.ViewChannel|(claimed?claimWrite:0n)),
    overwrite(opener,closed?read:ticketBits,closed?((ticketBits & ~read) | claimWrite):0n,1),
    overwrite(botId,ticketBits,0n,1)];
  if (claimed) ow.push(overwrite(actor,P.SendMessages,0n,1));
  const room=(supportOverwrite,...others)=>channel(channelId,[...ow,supportOverwrite,...others],{topic:marker(db.ticket(id))+'\nsubject'});
  return {store,db,id,room};
}

test('acceptance blocks a recipient whose second role would unlock writing in a claimed ticket',async t=>{
  const {store,room}=ticketFixture('technical',{claimed:true});
  t.after(()=>store.close());
  const live=room(overwrite(support,ticketBits & ~claimWrite,claimWrite),overwrite(existing,P.SendMessages));
  const guildChannel={guild:{id:guildId,ownerId:owner},overwritesFor:GuildChannel.prototype.overwritesFor,
    permissionOverwrites:{cache:new Collection(live.permission_overwrites.map(ow=>[ow.id,{...ow,allow:BigInt(ow.allow),deny:BigInt(ow.deny)}]))}};
  function canWrite(held) {
    const cache=new Collection([guildId,...held].map(id=>[id,{permissions:BigInt(roles.get(id).permissions)}]));
    return GuildChannel.prototype.memberPermissions.call(guildChannel,{id:target,roles:{cache}},true).has([P.ViewChannel,P.SendMessages]);
  }
  assert.equal(canWrite([existing]),false);
  assert.equal(canWrite([existing,...grants]),true);
  const f=fixture({store,channels:[live]});
  await f.send();
  assert.deepEqual(f.writes,[]);
  assert.equal(f.posted.length,0);
});

test('a closed legacy claim backfilled by the actual migration accepts only the verified live lock',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accept-legacy-claim-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const file=join(dir,'old.sqlite');
  const {store:historical,id,room}=ticketFixture('legacy',{claimed:true,state:'closed',file});
  const live=room(overwrite(support,ticketBits & ~claimWrite,claimWrite));
  historical.close();
  const raw=new DatabaseSync(file);
  raw.exec('DROP TABLE ticket_claim_changes');
  raw.close();
  const store=openStore(file);
  t.after(()=>store.close());
  assert.equal(store.community.claimChange(id).synced,0);
  assert.deepEqual(store.community.pendingClaims(),[]);
  for (const principal of [guildId,support]) {
    const rooms=structuredClone(live);
    const ow=rooms.permission_overwrites.find(entry=>entry.id===principal);
    ow.deny=String(BigInt(ow.deny) & ~P.SendMessages);
    const bad=fixture({store,channels:[rooms]});
    await bad.send();
    assert.deepEqual(bad.writes,[]);
  }
  const f=fixture({store,channels:[live]});
  await f.send();
  assert.deepEqual(f.writes,grants);
  assert.equal(f.posted.length,1);
});

test('claimed technical and rewards tickets require the live support claim write lock',async t=>{
  for (const kind of ['technical','rewards']) await t.test(kind,async t=>{
    const {store,db,id,room}=ticketFixture(kind,{claimed:true});
    t.after(()=>store.close());
    const synced=overwrite(support,ticketBits & ~claimWrite,claimWrite);
    const good=fixture({store,channels:[room(synced)]});
    await good.send();
    assert.deepEqual(good.writes,grants);
    for (const bit of [P.SendMessages,P.SendMessagesInThreads,P.CreatePublicThreads,P.CreatePrivateThreads]) {
      const bad=fixture({store,channels:[room(overwrite(support,(ticketBits & ~claimWrite)|bit,claimWrite & ~bit))]});
      await bad.send();
      assert.deepEqual(bad.writes,[],`unexpected write grant for ${bit}`);
    }
    const lostDeny=fixture({store,channels:[room(overwrite(support,ticketBits & ~claimWrite,claimWrite & ~P.SendMessages))]});
    await lostDeny.send();
    assert.deepEqual(lostDeny.writes,[]);
    db.undoClaim(id);
    const restoring=fixture({store,channels:[room(synced)]});
    await restoring.send();
    assert.deepEqual(restoring.writes,[]);
  });
});

test('claim and room transitions cannot take the unassigned support ceiling',async t=>{
  for (const phase of ['assigning','closing','reopening']) await t.test(phase,async t=>{
    const {store,db,id,room}=ticketFixture('technical',{state:phase==='assigning'?'open':phase});
    t.after(()=>store.close());
    if (phase==='assigning') db.startClaim(id,actor,null);
    const f=fixture({store,channels:[room(overwrite(support,ticketBits))]});
    await f.send();
    assert.deepEqual(f.writes,[]);
  });
});

test('normal legacy tickets admit only the configured Ticket Support ACL',async t=>{
  for (const [name,claimed,state] of [['unassigned',false,'open'],['claimed',true,'open'],
    ['closed unassigned',false,'closed'],['closed claimed',true,'closed']]) await t.test(name,async t=>{
    const {store,db,room}=ticketFixture('legacy',{claimed,state});
    t.after(()=>store.close());
    assert.equal(db.settings().supportRole,support);
    const ceiling=claimed?ticketBits & ~claimWrite:ticketBits;
    const good=overwrite(support,ceiling,claimed?claimWrite:0n);
    const f=fixture({store,channels:[room(good)]});
    await f.send();
    assert.deepEqual(f.writes,grants);
    for (const live of [room(overwrite(support,ceiling|P.ManageChannels,claimed?claimWrite:0n)),
      room(overwrite(support,ceiling,claimed?claimWrite:0n,1)),room(good,overwrite(guest,read,0n,1)),
      {...room(good),topic:'edited'},...(claimed?[room(overwrite(support,ticketBits))]:[])]) {
      const drift=fixture({store,channels:[live]});
      await drift.send();
      assert.deepEqual(drift.writes,[]);
    }
    db.saveSettings({...db.settings(),supportRole:grants[0]});
    for (const ow of [good,overwrite(grants[0],ceiling)]) {
      const drift=fixture({store,channels:[room(ow)]});
      await drift.send();
      assert.deepEqual(drift.writes,[]);
    }
  });
});

test('closed complaints never enter the legacy support exception',async t=>{
  for (const kind of ['complaint','staff-complaint']) await t.test(kind,async t=>{
    const {store,room}=ticketFixture(kind,{state:'closed'});
    t.after(()=>store.close());
    const managers=kind==='staff-complaint'?[overwrite(MANAGERS,ticketBits)]:[];
    const live=room(overwrite(support,ticketBits),...managers);
    const f=fixture({store,channels:[live]});
    await f.send();
    assert.deepEqual(f.writes,[]);
    live.permission_overwrites=live.permission_overwrites.filter(o=>o.id!==support);
    const good=fixture({store,channels:[live]});
    await good.send();
    assert.deepEqual(good.writes,grants);
  });
});

test('the shipped baseline keeps staff-news access and rejects an incomplete channel inventory',async()=>{
  const baseline=require('../config/accept-member-overwrites.json');
  const channels=Object.entries(baseline).map(([id,row])=>channel(id,Object.entries(row).map(([role,mask])=>
    typeof mask==='string'?overwrite(role,mask):overwrite(role,mask.allow,mask.deny))));
  assert.ok(channels.some(c=>c.id==='1575179775671140442' && c.permission_overwrites.some(o=>o.id===grants[0] && BigInt(o.allow)===(P.ViewChannel|P.Connect))));
  const good=fixture({channels,useReviewedFile:true});
  await good.send();
  assert.deepEqual(good.writes,grants);
  const incomplete=fixture({channels:channels.filter(c=>c.id!=='1575179775671140442'),useReviewedFile:true});
  await incomplete.send();
  assert.deepEqual(incomplete.writes,[]);
});

test('non-ticket overwrite grants are allowed only within a reviewed per-channel, per-role mask',async t=>{
  const reviewed={[categoryId]:{[grants[0]]:String(read)},[channelId]:{[grants[0]]:String(read)}};
  const category=channel(categoryId,[overwrite(grants[0],read)],{type:ChannelType.GuildCategory});
  const child=channel(channelId,[overwrite(grants[0],P.ViewChannel)],{parent_id:categoryId});
  const good=fixture({channels:[category,child],acceptOverwrites:reviewed});
  await good.send();
  assert.deepEqual(good.writes,grants);
  for (const [name,channels,acceptOverwrites] of [
    ['no reviewed configuration',[],null],
    ['new bits on approved channel',[category,channel(channelId,[overwrite(grants[0],read|P.ManageMessages)])],reviewed],
    ['a synced-looking unknown child',[category,child,channel(guest,child.permission_overwrites,{parent_id:categoryId})],reviewed],
    ['different grant role on approved channel',[channel(channelId,[overwrite(grants[1],read)])],reviewed],
  ]) await t.test(name,async()=>{
    const f=fixture({channels,acceptOverwrites});
    await f.send();
    assert.deepEqual(f.writes,[]);
  });
});

test('a reviewed deny is not stripped while checking the grant overwrite ceiling',async()=>{
  const reviewed={[channelId]:{[grants[0]]:{allow:String(read),deny:String(P.SendMessages)}}};
  const good=fixture({channels:[channel(channelId,[overwrite(grants[0],read,P.SendMessages)])],acceptOverwrites:reviewed});
  await good.send();
  assert.deepEqual(good.writes,grants);
  for (const overwrites of [[overwrite(grants[0],read)],[]]) {
    const f=fixture({channels:[channel(channelId,overwrites)],acceptOverwrites:reviewed});
    await f.send();
    assert.deepEqual(f.writes,[]);
  }
});

test('ticket overwrites grant Ticket Support only in verified non-complaint rooms',async t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  for (const [index,kind] of ['technical','rewards','staff-complaint','complaint','legacy'].entries()) {
    await t.test(kind,async()=>{
      const room='30000000000000001'+index, opener='30000000000000002'+index;
      const row=store.community.reserveTicket('ticket:'+index,opener,'test',kind);
      store.community.setChannel(row.id,room);
      const ow=[overwrite(guildId,0n,P.ViewChannel),overwrite(opener,ticketBits,0n,1),overwrite(botId,ticketBits,0n,1)];
      if (kind==='staff-complaint') ow.push(overwrite(MANAGERS,ticketBits));
      const support=overwrite(grants[2],ticketBits);
      const ticket=(overwrites,fields={})=>channel(room,overwrites,{topic:marker(row)+'\nignored',...fields});
      const allowed=['technical','rewards','legacy'].includes(kind);
      const f=fixture({store,channels:[ticket([...ow,support])]});
      await f.send();
      assert.deepEqual(f.writes,allowed?grants:[]);
      if (!allowed) {
        const privateRoom=fixture({store,channels:[ticket(ow)]});
        await privateRoom.send();
        assert.deepEqual(privateRoom.writes,grants);
      }
      if (!allowed) return;
      for (const live of [ticket([...ow,overwrite(grants[2],ticketBits|P.ManageChannels)]),
        ticket([...ow,support,overwrite(grants[0],read)]),ticket([...ow,support],{topic:'edited'}),
        ticket([...ow,support],{type:ChannelType.GuildAnnouncement}),ticket([...ow.slice(1),support]),
        ticket([...ow,support,overwrite(guest,read,0n,1)])]) {
        const unsafe=fixture({store,channels:[live]});
        await unsafe.send();
        assert.deepEqual(unsafe.writes,[]);
      }
    });
  }
  const fake=fixture({store,channels:[channel(channelId,[overwrite(grants[2],ticketBits)],{topic:marker({id:8001,owner})})]});
  await fake.send();
  assert.deepEqual(fake.writes,[]);
});

test('an overwrite broadened after the first PUT blocks every remaining PUT',async()=>{
  const channels=[channel(channelId)];
  const f=fixture({channels,afterWrite:()=>channels[0].permission_overwrites.push(overwrite(grants[2],P.ViewChannel))});
  await f.send();
  assert.deepEqual(f.writes,[grants[0]]);
  assert.ok(f.replies.every(r=>r.payload.content!==expected));
});

test('a persisted, unfinished promotion blocks acceptance without a role PUT',async t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  store.begin('web:pending',{id:actor,name:'Actor'},{id:target,name:'Target'},'web',{...planPromotion([]),before:[]});
  const f=fixture({store});
  await f.send();
  assert.deepEqual(f.writes,[]);
  assert.match(f.replies[0].payload.content,/ترقية/u);
});

test('actual promotion, ticket reward and recovery execution share the acceptance member lock',async t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const {promise:entered,resolve:enter}=Promise.withResolvers();
  const {promise:blocked,resolve:release}=Promise.withResolvers();
  const f=fixture({store,afterWrite:async ({writes})=>{if(writes.length===1) {enter();await blocked;}}});
  let contexts=0;
  const bot={id:botId,bot:true,roles:[botRole]};
  const service=makeService(store,{
    async context(operator) {
      contexts++;
      return {ownerId:actor,roles,bot,actor:operator===botId?bot:{id:actor,name:'Actor',roles:[apply,power]},target:{id:target,name:'Target',roles:[...f.members.get(target).roles]}};
    },
    async change(_,id,add) {
      const held=f.members.get(target).roles;
      f.members.get(target).roles=add?[...held,id]:held.filter(heldId=>heldId!==id);
    }
  });
  const request={id:'web:blocked',actor,target,source:'web'};
  const accepting=f.send();
  await Promise.race([entered,accepting]);
  try {
    await assert.rejects(service.execute(request),/يجري/u);
    await assert.rejects(service.execute({id:'ticket-points:1',actor:botId,target,source:'ticket-points'}),/يجري/u);
    // Seed a pending row while the lock is held to exercise the recovery entry point itself.
    store.begin('web:recovery',{id:actor,name:'Actor'},{id:target,name:'Target'},'web',{...planPromotion([grants[0]]),before:[grants[0]]});
    await service.recover();
    assert.equal(store.byId('web:recovery').state,'pending');
    assert.equal(contexts,0);
  } finally {release();await accepting;}
  assert.deepEqual(f.writes,[grants[0]]);
  assert.ok(f.replies.every(r=>r.payload.content!==expected));
  await service.recover();
  assert.equal(store.byId('web:recovery').state,'done');
});

test('a failed or uncertain welcome can retry after SQLite and handler restart without duplicate grants or replies',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accept-outbox-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  for (const [name,failWelcome,failReadback] of [['send rejected','before',false],['response lost','after',false],['readback failed',null,true]]) await t.test(name,async()=>{
    const file=join(dir,name+'.sqlite');
    let store=openStore(file);
    try {
      const f=fixture({store,failWelcome,failReadback,afterWrite:()=>assert.equal(store.acceptance.byTarget(target)?.reference,command)});
      await f.send();
      assert.deepEqual(f.writes,grants);
      store.close();
      store=openStore(file);
      f.reopen(store);
      await f.send(undefined,{id:retryCommand,channelId:retryChannel});
      assert.deepEqual(f.writes,grants);
      assert.equal(f.posted.length,1);
      assert.ok(f.attempts.every(body=>body.nonce===command && body.enforce_nonce===true && body.message_reference.message_id===command &&
        body.message_reference.channel_id===origin));
      assert.equal(f.replies.filter(x=>x.payload.content===expected).length,1);
      assert.equal(store.acceptance.byTarget(target),undefined);
    } finally {store.close();}
  });
});

test('after the nonce window the welcome outbox requires a receipt and cannot repost ambiguously',async t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  store.acceptance.begin(target,origin,command);
  store.acceptance.markAttempt(target,command,0);
  const f=fixture({store,targetRoles:grants});
  await f.send();
  assert.deepEqual(f.attempts,[]);
  assert.ok(store.acceptance.byTarget(target));
  const forged={id:'300000000000000013',channel_id:origin,author:{id:actor},content:expected,mentions:[{id:target}],
    message_reference:{message_id:command,channel_id:origin}};
  f.posted.push(forged);
  await f.send();
  assert.ok(store.acceptance.byTarget(target));
  f.posted[0]={...forged,author:{id:botId}};
  await f.send();
  assert.equal(store.acceptance.byTarget(target),undefined);
  assert.deepEqual(f.attempts,[]);
  assert.deepEqual(f.writes,[]);
});

test('a definitive first-attempt Discord rejection remains retryable beyond the nonce window',async t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const f=fixture({store,failWelcome:'definite'});
  await f.send();
  assert.deepEqual(f.writes,grants);
  assert.equal(f.posted.length,0);
  assert.equal(store.acceptance.byTarget(target).attempted,null);
  await f.send();
  assert.deepEqual(f.writes,grants);
  assert.equal(f.posted.length,1);
  assert.equal(store.acceptance.byTarget(target),undefined);
});

test('a definitive missing reply reference is rebound only on a new authorized command after restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accept-dead-reference-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  for (const [name,response] of [['reference field',deadReference],['unknown message',unknownMessage]]) await t.test(name,async()=>{
    const file=join(dir,name+'.sqlite');
    let store=openStore(file);
    try {
      const f=fixture({store,welcomeResponses:[response]});
      await f.send();
      assert.equal(f.transport.length,1);
      assert.equal(f.posted.length,0);
      assert.deepEqual(f.writes,grants);
      store.close();
      store=openStore(file);
      f.reopen(store);
      await f.send(); // replay of the same dead command must not dispatch again
      f.members.get(actor).roles=[power];
      await f.send(undefined,{id:retryCommand,channelId:retryChannel});
      assert.equal(f.attempts.length,1);
      assert.equal(store.acceptance.byTarget(target).reference,command);
      f.members.get(actor).roles=[apply,power];
      f.members.get(target).roles=[existing,...grants.slice(1)];
      await f.send(undefined,{id:retryCommand,channelId:retryChannel});
      assert.equal(f.attempts.length,1); // a removed grant must not be put back
      f.members.get(target).roles.push(grants[0]);
      await f.send(undefined,{id:retryCommand,channelId:retryChannel});
      assert.deepEqual(f.writes,grants);
      assert.deepEqual(f.attempts.map(b=>[b.nonce,b.enforce_nonce,b.message_reference]),[
        [command,true,{message_id:command,channel_id:origin,guild_id:guildId,fail_if_not_exists:true}],
        [retryCommand,true,{message_id:retryCommand,channel_id:retryChannel,guild_id:guildId,fail_if_not_exists:true}]
      ]);
      assert.equal(f.posted.length,1);
      assert.equal(f.posted[0].channel_id,retryChannel);
      assert.equal(store.acceptance.byTarget(target),undefined);
    } finally {store.close();}
  });
});

test('an uncertain rebound welcome retries only its new nonce',async t=>{
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const f=fixture({store,welcomeResponses:[deadReference],loseReceiptFor:retryCommand});
  await f.send();
  await f.send(undefined,{id:retryCommand,channelId:retryChannel});
  assert.equal(f.posted.length,1);
  assert.equal(store.acceptance.byTarget(target).reference,retryCommand);
  assert.ok(Number.isSafeInteger(store.acceptance.byTarget(target).attempted));
  await f.send(undefined,{id:'300000000000000034',channelId:origin});
  assert.deepEqual(f.writes,grants);
  assert.equal(f.posted.length,1);
  assert.deepEqual(f.attempts.map(b=>[b.nonce,b.message_reference.channel_id]),
    [[command,origin],[retryCommand,retryChannel],[retryCommand,retryChannel]]);
  assert.equal(store.acceptance.byTarget(target),undefined);
});

test('an unknown or ambiguous prior welcome cannot become rebindable after a missing reference response',async t=>{
  for (const [name,responses] of [
    ['unrecognized Discord error',[[400,{code:999999,message:'Unknown response'}],deadReference]],
    ['unverified success',[[200,{}],deadReference]],
    ['unrelated reference error',[[400,{code:50035,message:'Invalid Form Body',errors:{message_reference:{_errors:[
      {code:'MESSAGE_REFERENCE_INVALID_TYPE',message:'Invalid message type'}]}}}],deadReference]],
    ['unknown channel',[[404,{code:10003,message:'Unknown Channel'}],deadReference]],
    ['SDK retry after server error',[[500,{message:'Internal Server Error'}],deadReference,deadReference]],
  ]) await t.test(name,async t=>{
    const store=openStore(':memory:');
    t.after(()=>store.close());
    const f=fixture({store,welcomeResponses:responses});
    await f.send();
    const stamp=store.acceptance.byTarget(target).attempted;
    assert.ok(Number.isSafeInteger(stamp));
    await f.send(undefined,{id:retryCommand,channelId:retryChannel});
    assert.equal(store.acceptance.byTarget(target).attempted,stamp);
    await f.send(undefined,{id:'300000000000000034',channelId:retryChannel});
    assert.deepEqual(f.writes,grants);
    for (const body of f.attempts) {
      assert.equal(body.nonce,command);
      assert.equal(body.message_reference.channel_id,origin);
      assert.equal(body.message_reference.message_id,command);
    }
    assert.equal(f.transport.length,responses.length);
    assert.equal(f.posted.length,1);
  });
});

test('a pre-fix outbox row with cleared but unknown attempt history is receipt-only',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'accept-old-outbox-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const file=join(dir,'old.sqlite'), old=new DatabaseSync(file);
  try {
    old.exec(`CREATE TABLE accept_member_outbox (target TEXT PRIMARY KEY, channel TEXT NOT NULL, reference TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0, attempted INTEGER, posted TEXT)`);
    old.prepare('INSERT INTO accept_member_outbox VALUES (?,?,?,1,NULL,NULL)').run(target,origin,command);
  } finally {old.close();}
  const store=openStore(file);
  t.after(()=>store.close());
  const f=fixture({store,targetRoles:grants,welcomeResponses:[deadReference]});
  await f.send(undefined,{id:retryCommand,channelId:retryChannel});
  assert.deepEqual(f.attempts,[]);
  assert.deepEqual(f.writes,[]);
  assert.equal(store.acceptance.byTarget(target).reference,command);
});
