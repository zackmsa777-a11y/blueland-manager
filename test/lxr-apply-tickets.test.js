'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {ChannelType,Client,DiscordAPIError,OverwriteType,PermissionFlagsBits:P,REST,Routes}=require('discord.js');
const {catalog}=require('../src/ladder');
const {createApplicationTickets,isApplicationDestination}=require('../src/lxr-apply-tickets');

const GUILD='1573975432838127708';
const APPLICANT='1575550000000000001';
const BOT=catalog.botId;
const BOT_ROLE='1575550000000000002';
const REQUEST='1575550000000000003';
const ROOM='1575550000000000004';
const MESSAGE='1575550000000000005';
const FOREIGN='1575550000000000006';
const ROUTES={
  staff:['1575528932357439549','1574013532586909736'],
  transfer:['1575529519358419024','1574013532586909736'],
  girls:['1575529605467476010','1575527044916183101'],
};
const BASE=P.ViewChannel|P.SendMessages|P.ReadMessageHistory;
const BOT_ALLOW=BASE|P.AttachFiles|P.EmbedLinks;
const BOT_PERMISSIONS=BOT_ALLOW|P.ManageChannels|P.ManageRoles|P.MentionEveryone;
const marker=`LXR application • ${REQUEST}`;
const ack='<:G_21:1574000061229305886> انتظري يا ملكة، طلبك وصل! مسؤولات البنات بيراجعونه ويعطونك خبر. <:G_25:1574000020783370370>';
const overwrite=(id,type,allow,deny=0n)=>({id,type,allow:String(allow),deny:String(deny)});
const role=(id,permissions=0n)=>({id,permissions:String(permissions),mentionable:false,managed:false});
const request=(kind='staff',overrides={})=>({id:REQUEST,userId:APPLICANT,kind,
  answers:[{name:'Question',value:'**text** @everyone @here <@1575550000000000006> <@&1575550000000000006> <#1575550000000000006>'}],...overrides});

function fixture({kind='staff',change={},createTransport=[],wireMessages=false,writerRetries=0,missingWriter=false}={}) {
  const [parent,reviewer]=ROUTES[kind];
  const category={id:parent,guild_id:GUILD,type:ChannelType.GuildCategory,
    permission_overwrites:[overwrite(FOREIGN,OverwriteType.Role,BASE)]};
  const roles=[role(GUILD),role(BOT_ROLE,BOT_PERMISSIONS),role(reviewer),role(FOREIGN)];
  const channels=[];
  const messages=[];
  const events=[];
  const member=(id,bot,roles=[])=>({user:{id,bot},roles,pending:false});
  const client=new Client({intents:[]});
  client.user={id:BOT};
  const wireCreates=[];
  const wireSends=[];
  const pending=[...createTransport];
  const answer=(label,payload,defaultValue)=>change[label]?change[label](payload,defaultValue):defaultValue;
  const recordMessage=wire=>{
    const result={id:MESSAGE,channel_id:ROOM,author:{id:BOT,bot:true},type:0,content:wire.content,embeds:wire.embeds,
      mentions:wire.allowed_mentions.users.map(id=>({id})),mention_roles:wire.allowed_mentions.roles,mention_everyone:false,
      attachments:[]};
    messages.unshift(result);
    return answer('posted',wire,result);
  };
  const makeRequest=async(url,{method,body})=>{
    assert.equal(method,'POST');
    if (wireMessages && url.endsWith(Routes.channelMessages(ROOM))) {
      const wire=JSON.parse(body);
      wireSends.push(wire);
      return Response.json(recordMessage(wire),{status:200});
    }
    assert.ok(url.endsWith(Routes.guildChannels(GUILD)));
    const wire=JSON.parse(body),result={...wire,id:channels.length?FOREIGN:ROOM,guild_id:GUILD};
    wireCreates.push(wire);
    const next=pending.shift();
    const outcome=typeof next==='function'?next(result,channels,messages):next;
    if (outcome instanceof Error) throw outcome;
    if (outcome) return Response.json(outcome[1],{status:outcome[0],headers:outcome[2]});
    channels.push(result);
    return Response.json(result,{status:201});
  };
  const rest=options=>{
    const sdk=new REST({makeRequest,offset:0,...options}).setToken('test-only');
    sdk.clearHashSweeper();sdk.clearHandlerSweeper();
    return sdk;
  };
  // Keep ordinary REST's real retry policy in transport regression tests.
  const sdk=pending.length || wireMessages?rest({retries:writerRetries}):null;
  if (sdk) client.rest=rest();
  const ordinaryCreate=client.rest.post.bind(client.rest);
  client.rest.get=async(path)=>{
    events.push(['GET',path]);
    const destination=Object.values(ROUTES).find(([id])=>path===Routes.channel(id))?.[0];
    if (destination) return answer('category',path,destination===parent?category:{...category,id:destination});
    if (path===Routes.guildRoles(GUILD)) return answer('roles',path,roles);
    if (path===Routes.guildMember(GUILD,BOT)) return answer('bot',path,member(BOT,true,[BOT_ROLE]));
    if (path===Routes.guildMember(GUILD,APPLICANT)) return answer('applicant',path,member(APPLICANT,false));
    if (path===Routes.guildMember(GUILD,FOREIGN)) return member(FOREIGN,false);
    if (path===Routes.guildChannels(GUILD)) return answer('list',path,channels);
    if (path===Routes.channel(ROOM)) return answer('channel',path,channels.find(room=>room.id===ROOM));
    if (path===Routes.channelMessages(ROOM)) return answer('history',path,messages);
    if (path===Routes.channelMessage(ROOM,MESSAGE)) return answer('message',path,messages.find(message=>message.id===MESSAGE));
    assert.fail('Unexpected GET '+path);
  };
  const create=async(path,{body,signal},post)=>{
    assert.equal(path,Routes.guildChannels(GUILD));
    const wire=JSON.parse(JSON.stringify(body));
    events.push(['POST',path,wire]);
    if (post) return post(path,{body,signal});
    const result={...wire,id:ROOM,guild_id:GUILD};
    channels.push(result);
    return answer('created',wire,result);
  };
  const writer=sdk??{options:{retries:writerRetries},post:create};
  let ordinaryCreates=0;
  client.rest.post=async(path,{body,files,signal})=>{
    if (path===Routes.guildChannels(GUILD)) {
      ordinaryCreates++;
      if (sdk) return create(path,{body,signal},ordinaryCreate);
      return create(path,{body,signal});
    }
    const wire=JSON.parse(JSON.stringify(body));
    events.push(['POST',path,wire,files]);
    if (path===Routes.channelMessages(ROOM))
      return wireMessages?ordinaryCreate(path,{body,files,signal}):recordMessage(wire);
    assert.fail('Unexpected POST '+path);
  };
  const readyGuild=()=>answer('ready',undefined,{id:GUILD,client});
  const deliver=createApplicationTickets({readyGuild,getChannelWriteRest:()=>missingWriter?undefined:writer});
  return {category,channels,messages,roles,events,deliver,readyGuild,wireCreates,wireSends,ordinaryCreates:()=>ordinaryCreates,
    wireListeners:()=>sdk?.listenerCount('response')};
}
const posts=f=>f.events.filter(([method])=>method==='POST');
const sends=f=>posts(f).filter(([,path])=>path===Routes.channelMessages(ROOM));

for (const kind of ['staff','girls']) test(`${kind} uses only its private audience and serializes an embed`,async()=>{
  const f=fixture({kind});
  const [parent,reviewer]=ROUTES[kind];
  assert.equal(await f.deliver(request(kind)),ROOM);
  const create=posts(f)[0];
  assert.equal(create[1],Routes.guildChannels(GUILD));
  assert.deepEqual(create[2],{name:'lxr-application',type:ChannelType.GuildText,parent_id:parent,topic:marker,
    permission_overwrites:[overwrite(GUILD,OverwriteType.Role,0n,P.ViewChannel),
      overwrite(APPLICANT,OverwriteType.Member,BASE),overwrite(reviewer,OverwriteType.Role,BASE),
      overwrite(BOT,OverwriteType.Member,BOT_ALLOW)]});
  const send=sends(f)[0];
  assert.ok(f.events.some(([method,path],i)=>method==='GET'&&path===Routes.channel(ROOM)&&i<f.events.indexOf(send)));
  const [, ,wire]=send;
  assert.equal(wire.nonce,REQUEST);
  assert.equal(wire.enforce_nonce,true);
  assert.equal(wire.attachments,undefined);
  assert.equal(send[3],undefined);
  assert.deepEqual(wire.allowed_mentions,{parse:[],users:[APPLICANT],roles:[reviewer],replied_user:false});
  assert.equal(wire.content,`<@${APPLICANT}> <@&${reviewer}>${kind==='girls'?`\n${ack}`:''}`);
  assert.equal(wire.embeds.length,1);
  if (kind==='girls') assert.equal(wire.embeds[0].title,'طلب تقديم إدارة بنات');
  assert.equal(wire.embeds[0].fields[0].name,'Question');
  const value=wire.embeds[0].fields[0].value;
  assert.match(value,/\\\*\\\*text/);
  assert.doesNotMatch(value,/@everyone|@here|<@|<#/);
  assert.deepEqual(f.events.at(-1),['GET',Routes.channelMessage(ROOM,MESSAGE)]);
});

test('dashboard filtering follows destination IDs or the entire exact marker',()=>{
  for (const [parent] of Object.values(ROUTES)) {
    assert.equal(isApplicationDestination({id:parent}),true);
    assert.equal(isApplicationDestination({parentId:parent}),true);
    assert.equal(isApplicationDestination({parent_id:parent}),true);
  }
  assert.equal(isApplicationDestination({parentId:FOREIGN,topic:marker}),true);
  for (const topic of [`${marker}\n`,`${marker} details`,`Prefix ${marker}`,`LXR application • 99999999999999999999`])
    assert.equal(isApplicationDestination({topic}),false);
  assert.equal(isApplicationDestination({name:'lxr-application'}),false);
  assert.equal(isApplicationDestination(null),false);
});

const replace=(d,patch)=>({...d,...patch});
const modifyAcl=(room,fn)=>replace(room,{permission_overwrites:fn(room.permission_overwrites)});
for (const [target,mutate] of [
  ['parent ID',room=>replace(room,{parent_id:FOREIGN})],
  ['guild ID',room=>replace(room,{guild_id:FOREIGN})],
  ['channel ID',room=>replace(room,{id:FOREIGN})],
  ['channel type',room=>replace(room,{type:ChannelType.GuildAnnouncement})],
  ['room name',room=>replace(room,{name:'unexpected-room'})],
  ['topic marker',room=>replace(room,{topic:`${marker} `})],
  ['missing overwrites',room=>replace(room,{permission_overwrites:null})],
  ['missing everyone denial',room=>modifyAcl(room,acl=>acl.slice(1))],
  ['foreign allow',room=>modifyAcl(room,acl=>[...acl,overwrite(FOREIGN,OverwriteType.Role,BASE)])],
  ['audience type',room=>modifyAcl(room,acl=>acl.map(o=>o.id===APPLICANT?replace(o,{type:OverwriteType.Role}):o))],
  ['audience mask',room=>modifyAcl(room,acl=>acl.map(o=>o.id===APPLICANT?replace(o,{allow:String(BASE|P.ManageChannels)}):o))],
  ['bot mask',room=>modifyAcl(room,acl=>acl.map(o=>o.id===BOT?replace(o,{allow:String(BASE)}):o))],
]) test(`no survey is posted when fresh ${target} differs`,async()=>{
  const f=fixture({change:{channel:(_,room)=>mutate(room)}});
  await assert.rejects(f.deliver(request()),/room privacy not verified/);
  assert.equal(sends(f).length,0);
});

test('wrong category type refuses creation',async()=>{
  const f=fixture({change:{category:(_,room)=>replace(room,{type:ChannelType.GuildText})}});
  await assert.rejects(f.deliver(request()),/invalid destination/);
  assert.equal(posts(f).length,0);
});

test('missing reviewer role refuses creation',async()=>{
  const f=fixture({change:{roles:(_,roles)=>roles.filter(x=>x.id!==ROUTES.staff[1])}});
  await assert.rejects(f.deliver(request()),/invalid reviewer/);
  assert.equal(posts(f).length,0);
});

test('bot must keep effective MentionEveryone at send time for the nonmentionable reviewer',async()=>{
  let loads=0;
  const f=fixture({change:{roles:(_,roles)=>++loads===1?roles:roles.map(x=>x.id!==BOT_ROLE?x:role(BOT_ROLE,BOT_PERMISSIONS&~P.MentionEveryone))}});
  await assert.rejects(f.deliver(request()),/bot permissions unavailable/);
  assert.equal(posts(f).length,1);
  assert.equal(sends(f).length,0);
});

test('only the exact existing marker may recover a verified receipt after restart',async()=>{
  const f=fixture();
  f.channels.push({id:FOREIGN,type:ChannelType.GuildText,topic:`${marker} extra`});
  assert.equal(await f.deliver(request()),ROOM);
  const afterRestart=createApplicationTickets({readyGuild:f.readyGuild});
  assert.equal(await afterRestart(request()),ROOM);
  assert.equal(posts(f).length,2);
});

const recovery=(kind='staff',extra={})=>({id:REQUEST,userId:APPLICANT,kind,...extra});

const transferPrompt='أرسل صورتين هنا مباشرة في تذكرة نقل الرتبة حتى يراجعها الفريق يدويًا:\n'+
  '1. صورة تظهر رتبتك السابقة واسم مستخدمك في Discord.\n'+
  '2. صورة تظهر اسم السيرفر وعدد أعضائه.';
const transferAnswers=[{name:'اسم السيرفر السابق',value:'Private guild canary'},
  {name:'رتبتك السابقة',value:'Private rank canary'}];
const textTransfer=()=>({...recovery('transfer'),answers:transferAnswers,freshReservation:true});

test('text-only transfer opens the exact private ticket with instructions for two manual screenshots',async()=>{
  const f=fixture({kind:'transfer',wireMessages:true});
  const [parent,reviewer]=ROUTES.transfer;
  assert.equal(await f.deliver(textTransfer()),ROOM);
  assert.deepEqual(f.wireCreates,[{name:'lxr-application',type:ChannelType.GuildText,parent_id:parent,topic:marker,
    permission_overwrites:[overwrite(GUILD,OverwriteType.Role,0n,P.ViewChannel),
      overwrite(APPLICANT,OverwriteType.Member,BASE|P.AttachFiles),overwrite(reviewer,OverwriteType.Role,BASE),
      overwrite(BOT,OverwriteType.Member,BOT_ALLOW)]}]);
  assert.equal(f.ordinaryCreates(),0);
  assert.deepEqual(posts(f).map(([,path])=>path),[Routes.channelMessages(ROOM)]);
  assert.doesNotMatch(JSON.stringify(f.wireCreates),/Private (?:guild|rank) canary|attachments|screenshot/);
  assert.ok(f.events.some(([method,path],i)=>method==='GET'&&path===Routes.channel(ROOM)&&i<f.events.indexOf(sends(f)[0])));
  assert.equal(f.wireSends.length,1);
  const [wire]=f.wireSends;
  assert.equal(wire.content,`<@${APPLICANT}> <@&${reviewer}>\n${transferPrompt}`);
  assert.deepEqual(wire.allowed_mentions,{parse:[],users:[APPLICANT],roles:[reviewer],replied_user:false});
  assert.equal(wire.nonce,REQUEST);
  assert.equal(wire.enforce_nonce,true);
  assert.equal(wire.embeds[0].title,'طلب نقل الرتبة');
  assert.deepEqual(wire.embeds[0].fields,transferAnswers);
  assert.equal(wire.attachments,undefined);
  assert.deepEqual(f.events.at(-1),['GET',Routes.channelMessage(ROOM,MESSAGE)]);
});

test('transfer refuses to post the survey if room readback lacks the applicant attachment permission',async()=>{
  const f=fixture({kind:'transfer',wireMessages:true,change:{channel:(_,room)=>modifyAcl(room,acl=>
    acl.map(item=>item.id===APPLICANT?{...item,allow:String(BASE)}:item))}});
  await assert.rejects(f.deliver(textTransfer()),error=>unsafeRejection(error) && /room privacy/.test(error.message));
  assert.equal(f.wireCreates.length,1);
  assert.equal(f.wireSends.length,0);
});

test('transfer recovery reads the original bot announcement after a member posts a screenshot',async()=>{
  let readable=false;
  const f=fixture({kind:'transfer',wireMessages:true,change:{message:(_,m)=>readable?m:undefined}});
  await assert.rejects(f.deliver(textTransfer()),error=>unsafeRejection(error) && /receipt/.test(error.message));
  f.messages.unshift({id:FOREIGN,channel_id:ROOM,author:{id:APPLICANT,bot:false},type:0,content:'',embeds:[],
    attachments:[{id:'1575550000000000010',filename:'manual.png',size:70,content_type:'image/png'}]});
  readable=true;
  const afterRestart=createApplicationTickets({readyGuild:f.readyGuild});
  const start=f.events.length;
  assert.equal(await afterRestart.recover(recovery('transfer')),ROOM);
  assert.deepEqual(f.events.at(-1),['GET',Routes.channelMessage(ROOM,MESSAGE)]);
  assert.ok(f.events.slice(start).every(([method])=>method==='GET'));
  assert.equal(f.wireSends.length,1);
});

for (const [label,mutate] of [
  ['an applicant impersonation',m=>({...m,author:{id:APPLICANT,bot:false}})],
  ['a webhook',m=>({...m,webhook_id:FOREIGN})],
  ['a changed screenshot instruction',m=>({...m,content:m.content.split('\n')[0]})],
  ['an attachment on the bot announcement',m=>({...m,attachments:[{id:FOREIGN,filename:'unexpected.png'}]})],
]) test(`transfer recovery rejects ${label} on receipt readback without reposting`,async()=>{
  let changed=false;
  const f=fixture({kind:'transfer',wireMessages:true,change:{message:(_,m)=>changed?mutate(m):m}});
  assert.equal(await f.deliver(textTransfer()),ROOM);
  changed=true;
  const start=f.events.length;
  await assert.rejects(f.deliver.recover(recovery('transfer')),error=>unsafeRejection(error) && /receipt/.test(error.message));
  assert.ok(f.events.slice(start).every(([method])=>method==='GET'));
  assert.equal(f.wireSends.length,1);
});

test('recoverOnly never creates a room and does not poison a subsequent fresh submit',async()=>{
  const f=fixture();
  await assert.rejects(f.deliver(request('staff',{recoverOnly:true})),/room not found/);
  assert.equal(posts(f).length,0);
  assert.equal(await f.deliver(request()),ROOM);
  assert.equal(await f.deliver(request('staff',{recoverOnly:true})),ROOM);
  assert.equal(sends(f).length,1);
});

test('recovery accepts only explicitly boolean recoverOnly',async()=>{
  const f=fixture();
  for (const recoverOnly of ['true',1,null,undefined])
    await assert.rejects(f.deliver(request('staff',{recoverOnly})),/invalid request/);
  assert.equal(f.events.length,0);
});

test('inherited recoverOnly true cannot fall through to a write',async()=>{
  const f=fixture();
  const readOnly=Object.assign(Object.create({recoverOnly:true}),request());
  await assert.rejects(f.deliver(readOnly),/room not found/);
  assert.equal(posts(f).length,0);
});

test('recover verifies the existing bot receipt without original survey data',async()=>{
  const f=fixture({kind:'girls'});
  assert.equal(await f.deliver(request('girls')),ROOM);
  const afterRestart=createApplicationTickets({readyGuild:f.readyGuild});
  const start=f.events.length;
  assert.equal(await afterRestart.recover(recovery('girls')),ROOM);
  assert.deepEqual(f.events.at(-1),['GET',Routes.channelMessage(ROOM,MESSAGE)]);
  assert.ok(f.events.slice(start).every(([method])=>method==='GET'));
});

test('recover only reads and never treats a missing room or receipt as safe to resubmit',async()=>{
  const f=fixture();
  await assert.rejects(f.deliver.recover(recovery()),error=>unsafeRejection(error) && /room not found/.test(error.message));
  assert.equal(posts(f).length,0);
  assert.equal(await f.deliver(request()),ROOM);
  f.messages.length=0;
  await assert.rejects(f.deliver.recover(recovery()),error=>unsafeRejection(error) && /receipt/.test(error.message));
  assert.equal(sends(f).length,1);
});

test('recover rejects a mismatched kind or actor for an existing receipt',async()=>{
  const f=fixture();
  assert.equal(await f.deliver(request()),ROOM);
  for (const key of [recovery('transfer'),recovery('staff',{userId:FOREIGN})])
    await assert.rejects(f.deliver.recover(key),error=>unsafeRejection(error) && /room privacy/.test(error.message));
  assert.equal(posts(f).length,2);
});

for (const [label,modify] of [
  ['author',m=>replace(m,{author:{id:FOREIGN}})],
  ['content',m=>replace(m,{content:m.content+' extra'})],
  ['embed title',m=>replace(m,{embeds:m.embeds.map(e=>replace(e,{title:'foreign title'}))})],
  ['embed marker',m=>replace(m,{embeds:m.embeds.map(e=>replace(e,{footer:{text:'invalid marker'}}))})],
  ['reviewer mention',m=>replace(m,{mention_roles:[FOREIGN]})],
  ['channel',m=>replace(m,{channel_id:FOREIGN})],
]) test(`recover rejects ${label} drift on exact receipt GET without a repost`,async()=>{
  let change=false;
  const f=fixture({change:{message:(_,m)=>change?modify(m):m}});
  assert.equal(await f.deliver(request()),ROOM);
  change=true;
  await assert.rejects(f.deliver.recover(recovery()),/message receipt not verified/);
  assert.equal(sends(f).length,1);
});

test('a duplicate exact marker refuses even a verified receipt',async()=>{
  const f=fixture();
  assert.equal(await f.deliver(request()),ROOM);
  f.channels.push({...f.channels[0],id:FOREIGN});
  await assert.rejects(f.deliver(request()),/ambiguous room marker/);
  assert.equal(posts(f).length,2);
});

test('an exact marker with unexpected ACL never authorizes a repost',async()=>{
  const f=fixture();
  assert.equal(await f.deliver(request()),ROOM);
  f.channels[0].permission_overwrites.pop();
  await assert.rejects(f.deliver(request()),/room privacy not verified/);
  assert.equal(posts(f).length,2);
});

test('an unknown message write recovers the receipt without another role ping',async()=>{
  const f=fixture({change:{posted:()=>{throw Error('private body from transport');}}});
  await assert.rejects(f.deliver(request()),err=>err.message==='LXR application: delivery could not be verified');
  assert.equal(await f.deliver(request()),ROOM);
  assert.equal(sends(f).length,1);
});

test('a marked but empty room never authorizes a role ping after an unknown write',async()=>{
  const f=fixture({change:{posted:()=>{throw Error('unknown');}}});
  await assert.rejects(f.deliver(request()));
  f.messages.length=0;
  await assert.rejects(f.deliver(request()),/message receipt not verified/);
  assert.equal(sends(f).length,1);
});

test('missing marker after an unknown channel write does not create again in-process',async()=>{
  const f=fixture({change:{created:()=>{throw Error('unknown');}}});
  await assert.rejects(f.deliver(request()));
  f.channels.length=0;
  await assert.rejects(f.deliver(request()),/previous write could not be verified/);
  assert.equal(posts(f).length,1);
});

const forbidden=[403,{code:50013,message:'Private Discord rejection'}];
const safeRejection=error=>error.safeToResubmit===true && !/Private Discord rejection/.test(error.message);
const unsafeRejection=error=>error.safeToResubmit!==true && !/Private Discord rejection/.test(error.message);
const fresh=()=>request('staff',{freshReservation:true});

test('first category read failure releases only a fresh no-write reservation',async()=>{
  let failRead=true;
  const f=fixture({change:{category:(_,category)=>{
    if (failRead) throw Object.assign(new Error('Private Discord rejection'),{requestBody:{token:'test-only'}});
    return category;
  }}});
  await assert.rejects(f.deliver(request()),unsafeRejection);
  await assert.rejects(f.deliver(fresh()),error=>safeRejection(error) && error.cause===undefined && error.requestBody===undefined);
  assert.equal(posts(f).length,0);
  failRead=false;
  assert.equal(await f.deliver(fresh()),ROOM);
});

test('first category read failure does not release a reservation for a previously marked room',async()=>{
  let failRead=false;
  const f=fixture({change:{category:(_,category)=>{
    if (failRead) throw new Error('Private Discord rejection');
    return category;
  }}});
  assert.equal(await f.deliver(fresh()),ROOM);
  failRead=true;
  await assert.rejects(f.deliver(fresh()),unsafeRejection);
  assert.equal(posts(f).length,2);
});

test('first inventory GET rejection releases a fresh reservation only after a valid absent-marker read',async()=>{
  let reads=0;
  const f=fixture({change:{list:(_,rooms)=>{
    if (++reads===1) throw new Error('Private Discord rejection');
    return rooms;
  }}});
  await assert.rejects(f.deliver(fresh()),safeRejection);
  assert.equal(reads,2);
  assert.equal(posts(f).length,0);
  assert.equal(await f.deliver(fresh()),ROOM);
  assert.equal(sends(f).length,1);
});

test('a readiness failure cannot release a fresh reservation without a verified guild and inventory',async()=>{
  let unavailable=true;
  const f=fixture({change:{ready:(_,guild)=>{
    if (unavailable) throw new Error('Private Discord rejection');
    return guild;
  }}});
  await assert.rejects(f.deliver(fresh()),unsafeRejection);
  assert.deepEqual(f.events,[]);
  unavailable=false;
  assert.equal(await f.deliver(fresh()),ROOM);
});

test('a readiness failure can release a fresh reservation after readiness and absence are confirmed',async()=>{
  let readinessChecks=0;
  const f=fixture({change:{ready:(_,guild)=>{
    if (++readinessChecks===1) throw new Error('Private Discord rejection');
    return guild;
  }}});
  await assert.rejects(f.deliver(fresh()),safeRejection);
  assert.equal(readinessChecks,2);
  assert.deepEqual(f.events,[['GET',Routes.guildChannels(GUILD)]]);
});

for (const [label,inventory] of [
  ['unreadable',()=>{throw new Error('Private Discord rejection');}],
  ['malformed envelope',()=>({channels:[]})],
  ['malformed row',()=>[null]],
  ['malformed topic',()=>[{id:ROOM,type:ChannelType.GuildText,topic:7}]],
  ['duplicate ID',()=>[{id:ROOM,type:ChannelType.GuildText},{id:ROOM,type:ChannelType.GuildText}]],
  ['existing marker',()=>[{id:ROOM,type:ChannelType.GuildText,topic:marker}]],
  ['duplicate marker',()=>[ROOM,FOREIGN].map(id=>({id,type:ChannelType.GuildText,topic:marker}))],
]) test(`first inventory GET rejection cannot release a reservation with ${label}`,async()=>{
  let reads=0;
  const f=fixture({change:{list:()=>{
    if (++reads===1) throw new Error('Private Discord rejection');
    return inventory();
  }}});
  await assert.rejects(f.deliver(fresh()),unsafeRejection);
  assert.equal(reads,2);
  assert.equal(posts(f).length,0);
});

for (const [label,inventory] of [
  ['malformed inventory JSON',()=>new Response('not JSON').json()],
  ['malformed inventory row',()=>[null]],
  ['non-guild channel in inventory',()=>[{id:ROOM,type:ChannelType.DM}]],
  ['duplicate inventory ID',()=>[{id:ROOM,type:ChannelType.GuildText},{id:ROOM,type:ChannelType.GuildText}]],
  ['duplicate exact marker',()=>[ROOM,FOREIGN].map(id=>({id,type:ChannelType.GuildText,topic:marker}))],
]) test(`${label} fails closed without a write or another inventory check`,async()=>{
  let reads=0;
  const f=fixture({change:{list:(_,rooms)=>++reads===1?inventory():rooms}});
  await assert.rejects(f.deliver(fresh()),unsafeRejection);
  assert.equal(reads,1);
  assert.equal(posts(f).length,0);
});

const newGuildChannel=overrides=>({id:FOREIGN,type:20,guild_id:GUILD,...overrides});
for (const kind of ['staff','transfer','girls']) test(`an unrelated Discord channel of unrecognized type does not block ${kind} delivery or recovery`,async()=>{
  const f=fixture({kind});
  f.channels.push(newGuildChannel());
  assert.equal(await f.deliver(request(kind,{freshReservation:true})),ROOM);
  assert.equal(posts(f).length,2);
  const start=f.events.length;
  assert.equal(await f.deliver.recover(recovery(kind)),ROOM);
  assert.ok(f.events.slice(start).every(([method])=>method==='GET'));
  assert.equal(sends(f).length,1);
});

for (const [label,rows] of [
  ['matching topic',[newGuildChannel({topic:marker})]],
  ['missing guild',[newGuildChannel({guild_id:undefined})]],
  ['wrong guild',[newGuildChannel({guild_id:ROOM})]],
  ['malformed topic',[newGuildChannel({topic:20})]],
  ['duplicate ID',[newGuildChannel(),{id:FOREIGN,type:ChannelType.GuildText}]],
  ['negative type',[newGuildChannel({type:-1})]],
]) test(`unrecognized channel with ${label} does not authorize a write or release the reservation`,async()=>{
  const f=fixture();f.channels.push(...rows);
  await assert.rejects(f.deliver(fresh()),error=>unsafeRejection(error) && /room inventory unavailable/.test(error.message));
  assert.equal(posts(f).length,0);
});

for (const options of [{missingWriter:true},{writerRetries:1}]) test(`create rejects ${options.missingWriter?'missing':'retrying'} dedicated REST without fallback`,async()=>{
  const f=fixture(options);
  await assert.rejects(f.deliver(fresh()),safeRejection);
  assert.equal(f.ordinaryCreates(),0);
  assert.equal(posts(f).length,0);
});

test('first-wire Discord permission rejection frees the same application ID for retry',async()=>{
  const f=fixture({createTransport:[forbidden,[403,{code:50001,message:'Missing Access'}],
    [400,{code:50035,message:'Invalid Form Body'}]]});
  for (let attempts=1;attempts<=3;attempts++) {
    await assert.rejects(f.deliver(request()),safeRejection);
    assert.equal(f.wireCreates.length,attempts);
    assert.equal(f.wireListeners(),0);
    assert.equal(f.channels.length,0);
    assert.equal(sends(f).length,0);
  }
  assert.equal(await f.deliver(request()),ROOM);
  assert.equal(f.wireCreates.length,4);
  assert.equal(sends(f).length,1);
});

test('real SDK queues a known uncommitted 429, then recognizes a definitive rejection',async()=>{
  const f=fixture({createTransport:[[429,{retry_after:0},{'Retry-After':'0'}],forbidden]});
  await assert.rejects(f.deliver(fresh()),safeRejection);
  assert.equal(f.wireCreates.length,2);
  assert.equal(f.channels.length,0);
  assert.equal(sends(f).length,0);
});

const guildCapacity=[400,{code:30013,message:'Maximum Guild Channels'}];
test('first non-429 wire HTTP 400 with Discord code 30013 releases the request for retry',async()=>{
  const f=fixture({createTransport:[[429,{retry_after:0},{'Retry-After':'0'}],guildCapacity]});
  await assert.rejects(f.deliver(fresh()),error=>safeRejection(error) && !/Maximum Guild Channels/.test(error.message));
  assert.equal(f.wireCreates.length,2);
  assert.equal(f.wireListeners(),0);
  assert.equal(f.channels.length,0);
  assert.equal(sends(f).length,0);
  assert.equal(await f.deliver(fresh()),ROOM);
  assert.equal(f.wireCreates.length,3);
  assert.equal(sends(f).length,1);
});

for (const [label,outcome] of [
  ['wrong HTTP status',[403,guildCapacity[1]]],
  ['string code',[400,{code:'30013',message:guildCapacity[1].message}]],
  ['missing message',[400,{code:30013}]],
  ['non-Discord body',[400,{error:30013,message:guildCapacity[1].message}]],
  ['5xx response',[503,guildCapacity[1]]],
]) test(`guild capacity response with ${label} retains write uncertainty`,async()=>{
  const f=fixture({createTransport:[outcome,guildCapacity]});
  await assert.rejects(f.deliver(fresh()),unsafeRejection);
  await assert.rejects(f.deliver(fresh()),error=>unsafeRejection(error) && /previous write/.test(error.message));
  assert.equal(f.wireCreates.length,1);
  assert.equal(f.wireListeners(),0);
  assert.equal(sends(f).length,0);
});

test('another request’s wire HTTP 400 cannot authenticate a capacity error without its own response',async()=>{
  const synthetic=new DiscordAPIError(guildCapacity[1],30013,400,'POST',Routes.guildChannels(GUILD),{});
  const f=fixture({createTransport:[guildCapacity,synthetic]});
  const other=request('staff',{userId:FOREIGN,id:'1575550000000000030',freshReservation:true});
  await Promise.all([assert.rejects(f.deliver(fresh()),safeRejection),assert.rejects(f.deliver(other),unsafeRejection)]);
  await assert.rejects(f.deliver(other),error=>unsafeRejection(error) && /previous write/.test(error.message));
  assert.equal(f.wireCreates.length,2);
  assert.equal(f.wireListeners(),0);
  assert.equal(sends(f).length,0);
});

for (const [tag,error] of [
  ['5xx',[503,{message:'Unavailable'}]],
  ['network reset',Object.assign(new Error('reset'),{code:'ECONNRESET'})],
]) {
  test(`real SDK ${tag} after commit creates exactly one room and verifies before its first send`,async()=>{
    const f=fixture({createTransport:[(room,rooms)=>{rooms.push(room);return error;}]});
    const outcome=await f.deliver(fresh()).catch(err=>err);
    assert.equal(f.wireCreates.length,1);
    assert.equal(f.ordinaryCreates(),0);
    assert.equal(f.channels.length,1);
    assert.equal(f.channels[0].topic,marker);
    assert.equal(f.wireListeners(),0);
    assert.equal(outcome,ROOM);
    assert.equal(sends(f).length,1);
    const inventory=f.events.filter(([method,path])=>method==='GET'&&path===Routes.guildChannels(GUILD));
    assert.equal(inventory.length,2);
    assert.ok(f.events.some(([method,path],i)=>method==='GET'&&path===Routes.channel(ROOM)&&i<f.events.indexOf(sends(f)[0])));
  });

  test(`real SDK ${tag} without visible commit preserves uncertainty without another create`,async()=>{
    let preflightFails=false;
    const f=fixture({createTransport:[error,forbidden],change:{category:(_,category)=>{
      if (preflightFails) throw new Error('Private Discord rejection');
      return category;
    }}});
    await assert.rejects(f.deliver(fresh()),unsafeRejection);
    assert.equal(f.wireCreates.length,1);
    assert.equal(f.wireListeners(),0);
    preflightFails=true;
    await assert.rejects(f.deliver(fresh()),unsafeRejection);
    preflightFails=false;
    await assert.rejects(f.deliver(fresh()),err=>unsafeRejection(err) && /previous write/.test(err.message));
    assert.equal(f.wireCreates.length,1);
    assert.equal(sends(f).length,0);
  });
}

test('a nonfresh ambiguous create cannot send even into an exact empty room',async()=>{
  const f=fixture({createTransport:[(room,rooms)=>{rooms.push(room);return [503,{message:'Unavailable'}];}]});
  await assert.rejects(f.deliver(request()),unsafeRejection);
  assert.equal(f.wireCreates.length,1);
  await assert.rejects(f.deliver(fresh()),error=>unsafeRejection(error) && /receipt/.test(error.message));
  assert.equal(f.wireCreates.length,1);
  assert.equal(sends(f).length,0);
});

for (const [label,alter] of [
  ['ACL drift',room=>room.permission_overwrites.pop()],
  ['unexpected message history',(_,messages)=>messages.push({id:MESSAGE,content:'test message'})],
]) test(`ambiguous create with ${label} keeps the reservation and sends nothing`,async()=>{
  const f=fixture({createTransport:[(room,rooms,messages)=>{
    rooms.push(room);
    alter(room,messages);
    return [503,{message:'Unavailable'}];
  }]});
  await assert.rejects(f.deliver(fresh()),unsafeRejection);
  assert.equal(f.wireCreates.length,1);
  await assert.rejects(f.deliver(fresh()),unsafeRejection);
  assert.equal(f.wireCreates.length,1);
  assert.equal(sends(f).length,0);
});

test('channel-create timeout remains uncertain for the same application ID',async()=>{
  const f=fixture({createTransport:[Object.assign(new Error('timeout'),{name:'AbortError'}),
    Object.assign(new Error('timeout'),{name:'AbortError'})]});
  await assert.rejects(f.deliver(request()),unsafeRejection);
  const attempts=f.wireCreates.length;
  assert.ok(attempts>0);
  await assert.rejects(f.deliver(request()),error=>unsafeRejection(error) && /previous write/.test(error.message));
  assert.equal(f.wireCreates.length,attempts);
  assert.equal(sends(f).length,0);
});

test('wrong receipt mentions fail exact readback',async()=>{
  const f=fixture({change:{message:(_,m)=>replace(m,{mention_roles:[FOREIGN]})}});
  await assert.rejects(f.deliver(request()),/message receipt not verified/);
  assert.equal(sends(f).length,1);
});

test('an applicant can have only one creation in flight; exact duplicates share it',async()=>{
  let unblock;
  const roomReady=new Promise(resolve=>{unblock=resolve;});
  const f=fixture({change:{category:(_,category)=>roomReady.then(()=>category)}});
  const first=f.deliver(request());
  const duplicate=f.deliver(request());
  const different=assert.rejects(f.deliver(request('girls',{id:FOREIGN})),/applicant already submitting/);
  const readOnly=assert.rejects(f.deliver(request('staff',{recoverOnly:true})),error=>unsafeRejection(error) && /already submitting/.test(error.message));
  const freshConflict=assert.rejects(f.deliver(fresh()),error=>unsafeRejection(error) && /already submitting/.test(error.message));
  const invalidSurvey=assert.rejects(f.deliver(request('staff',{answers:[],freshReservation:true})),
    error=>unsafeRejection(error) && /invalid survey/.test(error.message));
  const modified=assert.rejects(f.deliver(request('staff',{answers:[{name:'Question',value:'changed underlying survey'}]})),
    /applicant already submitting/);
  const otherUser=assert.rejects(f.deliver(request('staff',{userId:FOREIGN})),/request already in flight/);
  assert.equal(posts(f).length,0);
  unblock();
  const [a,b]=await Promise.all([first,duplicate,different,modified,otherUser,readOnly,freshConflict,invalidSurvey]);
  assert.deepEqual([a,b],[ROOM,ROOM]);
  assert.equal(posts(f).length,2);
});

test('two exact markers after a create never authorize a survey post',async()=>{
  let f;
  f=fixture({change:{created:(_,room)=>{f.channels.push({...room,id:FOREIGN});return room;}}});
  await assert.rejects(f.deliver(request()),/ambiguous room marker/);
  assert.equal(sends(f).length,0);
});

test('a malformed mention array cannot pass as a delivery receipt',async()=>{
  const f=fixture({change:{message:(_,m)=>replace(m,{mentions:{0:{id:APPLICANT},length:1}})}});
  await assert.rejects(f.deliver(request()),/message receipt not verified/);
});
