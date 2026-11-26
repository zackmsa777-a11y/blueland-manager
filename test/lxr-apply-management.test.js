'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Client,ChannelType,DiscordAPIError,MessagePayload,PermissionFlagsBits:P,Routes}=require('discord.js');
const {catalog}=require('../src/ladder');
const {openStore}=require('../src/store');
const {createMessageHandler}=require('../src/chat');
const {createApplicationTickets,createApplicationManager,createApplicationMutationRest}=require('../src/lxr-apply-tickets');
const guild=catalog.guildId, bot=catalog.botId;
const id=n=>`207000000000000${String(n).padStart(3,'0')}`;
const [owner,reviewer,otherReviewer,applicant,guest,room,request,receiptId,ordinary]=Array.from({length:9},(_,i)=>id(i+1));
const routes={staff:['1575528932357439549','1574013532586909736','طلب الانضمام للإدارة'],transfer:['1575529519358419024','1574013532586909736','طلب نقل الرتبة'],girls:['1575529605467476010','1575527044916183101','طلب تقديم إدارة بنات']};
const participant=P.ViewChannel|P.SendMessages|P.ReadMessageHistory;
const write=P.SendMessages|P.SendMessagesInThreads|P.CreatePublicThreads|P.CreatePrivateThreads;
const overwrite=(id,type,allow,deny=0n)=>({id,type,allow:String(allow),deny:String(deny)});
const missing=route=>new DiscordAPIError({message:'Unknown Channel',code:10003},10003,404,'GET',route,{});

function fixture(t,kind='staff') {
  const [parent,role,title]=routes[kind];
  const store=openStore(':memory:'); t.after(()=>store.close());
  const client=new Client({intents:[]}); t.after(()=>client.destroy());
  client.user={id:bot};
  const topic='LXR application • '+request;
  const raw={id:room,guild_id:guild,type:ChannelType.GuildText,parent_id:parent,name:'lxr-application',topic,permission_overwrites:[
    overwrite(guild,0,0n,P.ViewChannel),overwrite(applicant,1,participant|(kind==='transfer'?P.AttachFiles:0n)),
    overwrite(role,0,participant),overwrite(bot,1,participant|P.EmbedLinks|P.AttachFiles)]};
  const roles=[{id:guild,permissions:'0',managed:false},{id:role,permissions:'0',managed:false,mentionable:true},{id:id(10),permissions:String(P.Administrator)}];
  const members=new Map([[owner,[]],[reviewer,[role]],[otherReviewer,[kind==='girls'?routes.staff[1]:routes.girls[1]]],[bot,[id(10)]],[applicant,[]],[guest,[]]]);
  const record={id:request,userId:applicant,kind};
  store.applications.claim(record);
  const transfer='أرسل صورتين هنا مباشرة في تذكرة نقل الرتبة حتى يراجعها الفريق يدويًا:\n1. صورة تظهر رتبتك السابقة واسم مستخدمك في Discord.\n2. صورة تظهر اسم السيرفر وعدد أعضائه.';
  const girls='<:G_21:1574000061229305886> انتظري يا ملكة، طلبك وصل! مسؤولات البنات بيراجعونه ويعطونك خبر. <:G_25:1574000020783370370>';
  const receipt={id:receiptId,channel_id:room,type:0,author:{id:bot,bot:true},attachments:[],mention_everyone:false,mentions:[{id:applicant}],mention_roles:[role],
    content:`<@${applicant}> <@&${role}>`+(kind==='transfer'?'\n'+transfer:kind==='girls'?'\n'+girls:''),embeds:[{title,footer:{text:topic},fields:[{name:'question',value:'private canary'}]}]};
  let alive=true, now=1_000, patchHook, category=[], transport, memberProbe;
  const writes=[], replies=[];
  const rest=client.rest;
  rest.get=async route=>{
    if (route===Routes.channel(room)) {if(!alive) throw missing(route);return structuredClone(raw);}
    if (route===Routes.channel(ordinary)) return {id:ordinary,guild_id:guild,type:0,topic:null,parent_id:null};
    if (route===Routes.channel(parent)) return {id:parent,guild_id:guild,type:4,permission_overwrites:category};
    if (route===Routes.guildChannels(guild)) return alive?[structuredClone(raw)]:[];
    if (route===Routes.guild(guild)) return {id:guild,owner_id:owner};
    if (route===Routes.guildRoles(guild)) return roles;
    if (route===Routes.channelMessages(room)) return [structuredClone(receipt)];
    if (route===Routes.channelMessage(room,receiptId)) return structuredClone(receipt);
    for(const [userId,roles] of members) if (route===Routes.guildMember(guild,userId)) {
      await memberProbe?.(userId);
      return {user:{id:userId,bot:userId===bot},roles};
    }
    assert.fail('unexpected GET '+route);
  };
  const writer={options:{retries:0,rejectOnRateLimit:()=>true},patch:async (route,{body})=>{
    assert.equal(route,Routes.channel(room));writes.push(['patch',structuredClone(body)]);
    if (patchHook) return patchHook(body,raw);
    Object.assign(raw,structuredClone(body));
  },delete:async route=>{assert.equal(route,Routes.channel(room));writes.push(['delete']);alive=false;}};
  const readyGuild=()=>({id:guild,client});
  const manager=createApplicationManager?.({readyGuild,state:store.applicationRooms,getChannelWriteRest:()=>transport??writer,now:()=>now});
  const delivery=createApplicationTickets({readyGuild,managementState:store.applicationRooms});
  const calls=[];
  const handle=createMessageHandler({store,applicationTicketMessages:manager?.text,assertGenericChannel:async ch=>{
    if(ch===room) throw Error('isolated');
  },ticketMessages:async (_,text)=>{calls.push(text);return false;}});
  const send=async payload=>{
    const body=MessagePayload.create({client},payload).resolveBody().body;
    replies.push(body);
    return {id:id(11)};
  };
  const text=(content,actor=reviewer,channelId=room)=>handle({id:id(12),author:{id:actor,bot:false},guildId:guild,channelId,
    inGuild:()=>true,content,channel:{id:channelId,send}});
  const interaction=async ({commandName='ticket',sub='claim',actor=reviewer,channelId=room,customId,author=bot}={})=>{
    const i={guildId:guild,channelId,commandGuildId:guild,commandName,customId,options:{getSubcommand:()=>sub},user:{id:actor},
      message:{id:id(11),author:{id:author}},isChatInputCommand:()=>!customId,isButton:()=>Boolean(customId),
      async deferReply(payload){this.deferred=true;assert.equal(payload.flags,64);},editReply:send};
    return manager?.interaction(i);
  };
  return {store,raw,record,receipt,writes,replies,delivery,text,interaction,calls,members,writer,isAlive:()=>alive,advance:ms=>{now+=ms;},
    patch:fn=>{patchHook=fn;},category:acl=>{category=acl;},transport:rest=>{transport=rest;},probeMember:fn=>{memberProbe=fn;}};
}

test('the app chat path closes a verified existing transfer room without deleting messages, evidence permissions or the submission lock',async t=>{
  const f=fixture(t,'transfer');
  await f.text('+close');
  assert.equal(f.writes.length,1,'the application handler must reach a channel write');
  const applicantEntry=f.raw.permission_overwrites.find(item=>item.id===applicant);
  assert.equal(BigInt(applicantEntry.deny)&write,write);
  assert.equal(BigInt(applicantEntry.allow)&(P.ViewChannel|P.ReadMessageHistory|P.AttachFiles),P.ViewChannel|P.ReadMessageHistory|P.AttachFiles);
  assert.deepEqual({...f.store.applications.find(applicant)},f.record);
  assert.equal(await f.delivery.recover(f.record),room);
  assert.match(f.replies[0].content,/أُغلقت/);
});

test('reviewers can rename a girls room and reopen it through the Arabic alias',async t=>{
  const f=fixture(t,'girls');
  await f.text('+rename مراجعة التقديم');
  assert.equal(f.raw.name,'مراجعة-التقديم');
  await f.text('+close');
  await f.interaction({commandName:'تذكرة',sub:'إعادة-فتح'});
  assert.equal(f.raw.permission_overwrites.find(item=>item.id===applicant).deny,'0');
  assert.equal(f.raw.topic,'LXR application • '+request);
  assert.equal(await f.delivery.recover(f.record),room);
});

test('claim and unclaim are exclusive, use isolated state, and never write to Discord or award support points',async t=>{
  const f=fixture(t);
  assert.equal(await f.interaction(),true);
  assert.equal(f.store.applicationRooms.read(room).current.assignee,reviewer);
  await f.interaction({actor:owner});
  assert.match(f.replies.at(-1).content,/مستلمة بالفعل/);
  await f.interaction({actor:owner,sub:'unclaim'});
  assert.equal(f.store.applicationRooms.read(room).current.assignee,null);
  assert.equal(f.store.community.ticketByChannel(room),undefined);
  assert.deepEqual(f.writes,[]);
});

test('other review teams and applicants cannot change a private application',async t=>{
  const f=fixture(t,'girls');
  await f.text('+close',otherReviewer);
  await f.text('+delete',applicant);
  await f.text('+add '+guest,reviewer);
  assert.equal(f.store.applicationRooms.read(room),undefined);
  assert.deepEqual(f.writes,[]);
  assert.ok(f.replies.every(({content,components})=>!content.includes('private canary')&&!components.length));
});

test('only the owner can add and remove a guest; close also blocks guest writing',async t=>{
  const f=fixture(t,'transfer');
  const access=id=>f.raw.permission_overwrites.find(item=>item.id===id);
  await f.text('+add <@'+guest+'>',owner);
  assert.deepEqual(access(guest),overwrite(guest,1,participant));
  await f.text('+close');
  assert.deepEqual(access(guest),overwrite(guest,1,participant&~write,write));
  await f.text('+remove '+applicant,owner);
  assert.ok(access(applicant));
  await f.text('+remove '+guest,reviewer);
  assert.ok(access(guest));
  await f.text('+remove '+guest,owner);
  await f.interaction({sub:'reopen'});
  assert.equal(access(guest),undefined);
  assert.equal(access(guild).deny,String(P.ViewChannel));
  assert.equal(await f.delivery.recover(f.record),room);
});

const customId=f=>f.replies.findLast(reply=>reply.components?.length).components[0].components[0].custom_id;

test('delete stays pending until the same actor, message, and channel confirm; it does not reset the application',async t=>{
  const f=fixture(t);
  await f.text('+delete');
  assert.equal(f.isAlive(),true);
  const pending=customId(f);
  await f.interaction({customId:pending,actor:owner});
  await f.interaction({customId:pending,channelId:ordinary});
  await f.interaction({customId:pending,author:guest});
  assert.deepEqual(f.writes,[]);
  await f.interaction({customId:pending});
  assert.deepEqual(f.writes,[['delete']]);
  assert.equal(f.isAlive(),false);
  assert.deepEqual({...f.store.applications.find(applicant)},f.record);
  await f.interaction({customId:pending});
  assert.deepEqual(f.writes,[['delete']]);
});

test('expired delete buttons and a removed reviewer role cannot initiate a delete',async t=>{
  const f=fixture(t);
  await f.text('+delete');
  f.advance(60_000);
  await f.interaction({customId:customId(f)});
  await f.text('+delete');
  f.members.set(reviewer,[]);
  await f.interaction({customId:customId(f)});
  assert.deepEqual(f.writes,[]);
});

test('a stale or altered bot receipt and unknown ACL changes fail closed',async t=>{
  const f=fixture(t);
  const author=f.receipt.author;
  f.receipt.author={id:guest,bot:false};
  await f.text('+rename blocked');
  assert.equal(f.store.applicationRooms.read(room),undefined);
  f.receipt.author=author;
  await f.text('+rename verified');
  f.raw.permission_overwrites.push(overwrite(guest,1,participant));
  await f.text('+close');
  await assert.rejects(f.delivery.recover(f.record),/room privacy not verified/);
  assert.deepEqual(f.writes,[['patch',{name:'verified'}]]);
});

test('an ambiguous committed write is read back, while an unknown non-committed write is not blindly replayed',async t=>{
  const f=fixture(t);
  f.patch((body,raw)=>{Object.assign(raw,body);throw Error('network reset');});
  await f.text('+rename confirmed');
  assert.equal(f.raw.name,'confirmed');
  assert.equal(f.store.applicationRooms.read(room).pending,null);
  f.patch(()=>{throw Error('network reset');});
  await f.text('+close');
  assert.equal(f.store.applicationRooms.read(room).pending.closed,true);
  await f.text('+close');
  assert.equal(f.writes.length,2);
  assert.equal(await f.delivery.recover(f.record),room);
});

test('ordinary support text and slash commands fall through; a moved application stays isolated',async t=>{
  const f=fixture(t);
  await f.text('+close',reviewer,ordinary);
  assert.deepEqual(f.calls,['+close']);
  assert.equal(await f.interaction({channelId:ordinary,sub:'close'}),false);
  f.raw.parent_id=null;
  await f.text('+close');
  assert.deepEqual(f.calls,['+close']);
  assert.equal(await f.interaction({sub:'close'}),true);
  assert.deepEqual(f.writes,[]);
});

test('a rename denied by a wire 429 is not queued and a fresh close is allowed',async t=>{
  const f=fixture(t), sent=[];
  const makeRequest=async (url,options)=>{
    sent.push(options.method);
    if(sent.length===1) return new Response(JSON.stringify({message:'rate limit',retry_after:0.01}),
      {status:429,headers:{'content-type':'application/json','retry-after':'0.01','x-ratelimit-scope':'shared'}});
    Object.assign(f.raw,JSON.parse(options.body));
    return new Response(JSON.stringify(f.raw),{headers:{'content-type':'application/json'}});
  };
  const rest=createApplicationMutationRest('test-only',{makeRequest,offset:0});
  t.after(()=>{rest.clearHashSweeper();rest.clearHandlerSweeper();});
  f.transport(rest);
  await f.text('+rename rejected');
  assert.equal(sent.length,1,'the SDK must not replay 429 writes');
  assert.equal(f.raw.name,'lxr-application');
  assert.equal(f.store.applicationRooms.read(room).pending,null);
  await f.text('+close');
  assert.equal(sent.length,2);
  assert.equal(f.store.applicationRooms.read(room).current.closed,true);
});

test('close cannot synchronize a private room with the category permission overwrites',async t=>{
  const f=fixture(t);
  f.category(f.raw.permission_overwrites.map(item=>item.id===applicant?overwrite(applicant,1,participant&~write,write):item));
  await f.text('+close');
  assert.deepEqual(f.writes,[]);
  assert.match(f.replies[0].content,/تعذّر التحقق/);
});

test('delete is not replayed after a wire 429 and the old confirmation cannot be used again',async t=>{
  const f=fixture(t), sent=[];
  const rest=createApplicationMutationRest('test-only',{offset:0,makeRequest:async (url,options)=>{
    sent.push(options.method);
    f.members.set(reviewer,[]);
    return new Response(JSON.stringify({message:'rate limit',retry_after:0.01}),
      {status:429,headers:{'content-type':'application/json','retry-after':'0.01','x-ratelimit-scope':'shared'}});
  }});
  f.transport(rest);
  await f.text('+delete');
  const pending=customId(f);
  await f.interaction({customId:pending});
  await f.interaction({customId:pending});
  assert.deepEqual(sent,['DELETE']);
  assert.equal(f.isAlive(),true);
});

test('a later exact read reconciles an uncertain write before accepting a different mutation',async t=>{
  const f=fixture(t);
  f.patch(()=>{throw Error('connection lost');});
  await f.text('+rename late');
  assert.ok(f.store.applicationRooms.read(room).pending);
  f.raw.name='late';
  f.patch(null);
  await f.text('+close');
  const saved=f.store.applicationRooms.read(room);
  assert.equal(saved.current.name,'late');
  assert.equal(saved.current.closed,true);
  assert.equal(saved.pending,null);
  assert.deepEqual(f.writes.map(([,body])=>Object.keys(body)),[['name'],['permission_overwrites']]);
});

test('a category ACL change during the final authority check prevents the close write',async t=>{
  const f=fixture(t);
  let checks=0;
  f.probeMember(user=>{
    if (user===reviewer && ++checks===2)
      f.category(f.raw.permission_overwrites.map(item=>item.id===applicant?overwrite(applicant,1,participant&~write,write):item));
  });
  await f.text('+close');
  assert.equal(checks,2);
  assert.deepEqual(f.writes,[]);
  assert.equal(f.store.applicationRooms.read(room).pending,null);
});
