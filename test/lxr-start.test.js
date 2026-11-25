'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ChannelType,Collection,MessageFlags,MessagePayload,PermissionsBitField,Routes}=require('discord.js');
const {catalog}=require('../src/ladder');
const {createLxrStart}=require('../src/lxr-start');

const ROOM='1574894916872572958', ROLE='1574013661671067758', PIC_ROLE='1574013659665932318';
const SOURCE_CHANNEL='1574640612500578495', SOURCE_MESSAGE='1575133335510978721';
const SOURCE_URL='https://cdn.discordapp.com/attachments/1574640612500578495/1575133334529376276/IMG_3553.jpg?test=1';
const POST='200000000000000006', USER='200000000000000007';
const image=Buffer.alloc(78089);
const fetchResponse=(body=image)=>new Response(body,{headers:{'content-length':String(body.length)}});

function fixture({wrongChannel=false, badUrl=false, existing=null, history=true, verifyFails=false}={}) {
  const calls=[], posts=new Collection();
  if (existing) posts.set(existing.id,existing);
  const role={id:ROLE,managed:false,editable:true,permissions:new PermissionsBitField(211793497918465n)};
  const picRole={id:PIC_ROLE,managed:false,editable:true,permissions:new PermissionsBitField(211793430809601n)};
  const member={id:USER,user:{bot:false},roles:{cache:new Collection(),async add(id) {calls.push(['grant',id]);this.cache.set(id,role);}}};
  const rawRoles=[];
  const overwrites=[];
  const client={user:{id:catalog.botId},options:{},rest:{async put(route){
    const id=[ROLE,PIC_ROLE].find(id=>route===Routes.guildMemberRole(catalog.guildId,USER,id));
    assert.ok(id,'only the clicker and a self-assignable role may be targeted');
    calls.push(['grant',id]);
    rawRoles.push(id);
  },async get(route){
    if (route===Routes.guildMember(catalog.guildId,USER)) return {user:{id:USER,bot:false},roles:[...rawRoles]};
    if (route===Routes.guildChannels(catalog.guildId)) return [{permission_overwrites:overwrites}];
    assert.equal(route,Routes.channelMessage(SOURCE_CHANNEL,SOURCE_MESSAGE));
    calls.push(['source']);
    return {id:SOURCE_MESSAGE,attachments:[{id:'1575133334529376276',filename:'IMG_3553.jpg',size:78089,url:badUrl?'https://example.org/fake':SOURCE_URL}]};
  }}};
  const channel={id:ROOM,guildId:catalog.guildId,type:wrongChannel?ChannelType.GuildAnnouncement:ChannelType.GuildText,client,
    permissionsFor:()=>({has:()=>history}),
    messages:{async fetch(o) {
      if (o.message) {
        calls.push(['verify',o.message]);
        if (verifyFails) throw new Error('temporary verification failure');
        return posts.get(o.message);
      }
      return posts;
    }},async send(data) {
      calls.push(['post']);
      const payload=MessagePayload.create(this,data).resolveBody();
      const message={id:POST,author:client.user,embeds:payload.body.embeds,components:payload.body.components,attachments:new Collection([['1',{name:'lxr-start.jpg',size:data.files[0].attachment.length}]])};
      assert.equal(payload.body.content,undefined);
      assert.equal(payload.body.embeds[0].image.url,'attachment://lxr-start.jpg');
      posts.set(POST,message);
      return message;
    }};
  const guild={id:catalog.guildId,client,channels:{async fetch(id) {assert.equal(id,ROOM);return channel;}},
    members:{async fetch(options){assert.equal(options.user,USER);return member;}},roles:{async fetch(id){return id===ROLE?role:id===PIC_ROLE?picRole:null;}}};
  const fetchImage=async url=>{
    assert.equal(url,SOURCE_URL);
    calls.push(['download']);
    // Supply wrong image bytes for the independent digest failure scenario.
    return fetchResponse();
  };
  return {calls,posts,channel,guild,role,picRole,member,client,fetchImage,rawRoles,overwrites,
    make(options){return createLxrStart({readyGuild:()=>guild,fetchImage,...options});}};
}

test('publishes the five-section panel once, then rediscovers it without downloading', async()=>{
  const f=fixture();
  const bytes=Buffer.alloc(78089);
  const panel=f.make({loadBanner:async()=>{f.calls.push(['image']);return bytes;}});
  assert.deepEqual(await Promise.all([panel.publish(),panel.publish()]),[POST,POST]);
  assert.equal(await f.make().publish(),POST);
  assert.deepEqual(f.calls,[['image'],['post'],['verify',POST]]);
  const message=f.posts.get(POST);
  assert.equal(message.embeds[1].footer.text,'LXR Empire');
  assert.deepEqual(message.components[0].components[0].options.map(o=>o.label),['القوانين','الفروع','Nickname & Pic Roles','الخريطة','رتب LXR العامة']);
});

test('will not publish in a different channel type or download from a different host',async()=>{
  const f=fixture({wrongChannel:true});
  await assert.rejects(f.make().publish());
  assert.deepEqual(f.calls,[]);
  const g=fixture({badUrl:true});
  await assert.rejects(g.make().publish());
  assert.deepEqual(g.calls,[['source']]);
});

test('rejects banner bytes that do not match the approved attachment before posting',async()=>{
  const f=fixture();
  await assert.rejects(f.make().publish(),/integrity check failed/u);
  assert.deepEqual(f.calls,[['source'],['download']]);
});

function interaction(f,{value,button,channel=ROOM,author=f.client.user.id,ephemeral=Boolean(button)}={}) {
  const customId=button ? 'lxr-start:'+button : 'lxr-start:sections';
  const seen=[];
  const record=data=>{
    if (!data.embeds) {seen.push({flags:data.flags});return;}
    const payload=MessagePayload.create({client:f.client},data).resolveBody();
    assert.equal(payload.body.content,undefined);
    seen.push(payload.body);
  };
  return {seen,customId,values:[value],guildId:catalog.guildId,channelId:channel,user:{id:USER},client:f.client,
    message:{id:POST,author:{id:author},flags:{has:flag=>flag===MessageFlags.Ephemeral && ephemeral},
      components:[{components:[{customId}]}]},isStringSelectMenu:()=>!button,isButton:()=>Boolean(button),
    async reply(data){record(data);this.replied=true;},async deferReply(data){record(data);this.deferred=true;},async editReply(data){record(data);}};
}

test('all five section choices privately reply with an Embed',async()=>{
  const f=fixture(), panel=f.make();
  for (const value of ['rules','branches','roles','map','public-roles']) {
    const pick=interaction(f,{value});
    assert.equal(await panel.handle(pick),true);
    assert.equal(pick.seen[0].flags,MessageFlags.Ephemeral);
    assert.equal(pick.seen[0].embeds.length,1);
    const [{description}]=pick.seen[0].embeds;
    if (value==='rules') {
      assert.match(description,/^# قوانين خادم LXR :\n  `#` \| الاحترام/u);
      assert.equal([...description.matchAll(/^-# /gmu)].length,25);
      assert.match(description,/بحق اي مخالف \*\*$/u);
    }
    if (value==='branches') assert.equal(description,'لا توجد لدينا اي فروع أخرى');
    if (value==='roles') assert.deepEqual(pick.seen[0].components[0].components.map(x=>[x.label,Boolean(x.disabled)]),[['Nickname',false],['Pic',false]]);
  }
  assert.deepEqual(f.calls,[]);
});

test('Nickname grants only the exact role to the clicker, reads it back and avoids a second grant',async()=>{
  const f=fixture(), panel=f.make();
  for (const expected of ['تم إعطاؤك رتبة nick.','رتبة nick موجودة عندك بالفعل.']) {
    const press=interaction(f,{button:'nick'});
    assert.equal(await panel.handle(press),true);
    assert.equal(press.seen[0].flags,MessageFlags.Ephemeral);
    assert.equal(press.seen[1].embeds[0].description,expected);
  }
  assert.deepEqual(f.calls,[['grant',ROLE]]);
});

test('forged, out-of-channel and elevated-role interactions never assign a role',async()=>{
  const f=fixture(), panel=f.make();
  for (const overrides of [{author:USER},{channel:'200000000000000008'},{ephemeral:false}]) {
    const press=interaction(f,{button:'nick',...overrides});
    assert.equal(await panel.handle(press),false);
    assert.deepEqual(press.seen,[]);
  }
  f.role.permissions=new PermissionsBitField(PermissionsBitField.Flags.Administrator);
  const nick=interaction(f,{button:'nick'});
  assert.equal(await panel.handle(nick),true);
  assert.match(nick.seen[1].embeds[0].description,/تعذّر/u);
  assert.deepEqual(f.calls,[]);
});

test('missing message-history permission blocks publication',async()=>{
  const f=fixture({history:false});
  await assert.rejects(f.make({loadBanner:async()=>image}).publish(),/permissions/u);
  assert.deepEqual(f.calls,[]);
});

test('a transient read-back failure never causes a second send',async()=>{
  const f=fixture({verifyFails:true});
  const panel=f.make({loadBanner:async()=>image});
  await assert.rejects(panel.publish(),/verification/u);
  f.posts.clear();
  await assert.rejects(panel.publish(),/verification/u);
  assert.deepEqual(f.calls,[['post'],['verify',POST],['verify',POST]]);
});

test('a stale panel with a disabled select, missing options or the wrong artwork cannot pass verification',async()=>{
  for (const change of [message=>message.components[0].components[0].options.pop(),
    message=>{message.components[0].components[0].disabled=true;},
    message=>{message.embeds[0].image.url='https://example.com/other.jpg';}]) {
    const f=fixture();
    await f.make({loadBanner:async()=>image}).publish();
    change(f.posts.get(POST));
    await assert.rejects(f.make().publish(),/verification/u);
    assert.deepEqual(f.calls,[['post'],['verify',POST]]);
  }
});

test('nickname role membership can be read with the role absent from the SDK cache',async()=>{
  const f=fixture();
  f.rawRoles.push(ROLE);
  const press=interaction(f,{button:'nick'});
  await f.make().handle(press);
  assert.equal(press.seen[1].embeds[0].description,'رتبة nick موجودة عندك بالفعل.');
  assert.deepEqual(f.calls,[]);
});

test('Nickname refuses overwrite allows, including an otherwise ordinary SendMessages permission',async()=>{
  for (const flag of [PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages]) {
    const f=fixture();
    f.overwrites.push({id:ROLE,type:0,allow:String(flag)});
    const press=interaction(f,{button:'nick'});
    await f.make().handle(press);
    assert.match(press.seen[1].embeds[0].description,/تعذّر/u);
    assert.deepEqual(f.calls,[]);
  }
});

test('the private map includes the 11 requested channel links in order',async()=>{
  const f=fixture(), pick=interaction(f,{value:'map'});
  await f.make().handle(pick);
  const [reply]=pick.seen;
  assert.equal(reply.flags,MessageFlags.Ephemeral);
  assert.deepEqual([...reply.embeds[0].description.matchAll(/<#(\d+)>/gu)].map(x=>x[1]),[
    '1575145872239362128','1575146300545175562','1575125050170806373','1575140485884936274','1575140911338496010',
    '1575141111805116466','1574894916872572958','1574909644336271361','1574909791204147350','1575122634327335124','1575123151329689600']);
  assert.match(reply.embeds[0].description,/<:G_21:1574000061229305886>/u);
  assert.deepEqual(f.calls,[]);
});

test('public roles shows the six requested roles and ticket link without a ping or grant',async()=>{
  const f=fixture(), pick=interaction(f,{value:'public-roles'});
  await f.make().handle(pick);
  const [reply]=pick.seen;
  assert.equal(reply.flags,MessageFlags.Ephemeral);
  assert.deepEqual([...reply.embeds[0].description.matchAll(/<@&(\d+)>/gu)].map(x=>x[1]),[
    '1574074692455628973','1574013619631431790','1574013615726661724','1574013629777448980','1574013633539608698','1574013636781805588']);
  assert.match(reply.embeds[0].description,/<#1575141111805116466>/u);
  assert.match(reply.embeds[0].description,/<:R_46:1573999906215960667>/u);
  assert.match(reply.embeds[0].description,/<:R_44:1573999951321636864>/u);
  assert.deepEqual(reply.allowed_mentions.parse,[]);
  assert.deepEqual(f.calls,[]);
});

test('Pic grants only the exact photo role to the clicker; repeat clicks do not write again',async()=>{
  const f=fixture(), panel=f.make();
  for (const expected of ['تم إعطاؤك رتبة pic.','رتبة pic موجودة عندك بالفعل.']) {
    const press=interaction(f,{button:'pic'});
    assert.equal(await panel.handle(press),true);
    assert.equal(press.seen[0].flags,MessageFlags.Ephemeral);
    assert.equal(press.seen[1].embeds[0].description,expected);
  }
  assert.deepEqual(f.calls,[['grant',PIC_ROLE]]);
});

test('Pic rejects role escalation, an unsafe channel overwrite, or a non-private control',async()=>{
  for (const unsafe of [f=>{f.picRole.permissions=new PermissionsBitField(PermissionsBitField.Flags.ManageRoles);},
    f=>{f.overwrites.push({id:PIC_ROLE,type:0,allow:String(PermissionsBitField.Flags.AttachFiles)});}]) {
    const f=fixture();
    unsafe(f);
    const press=interaction(f,{button:'pic'});
    await f.make().handle(press);
    assert.match(press.seen[1].embeds[0].description,/تعذّر إعطاء رتبة pic/u);
    assert.deepEqual(f.calls,[]);
  }
  const f=fixture(), press=interaction(f,{button:'pic',ephemeral:false});
  assert.equal(await f.make().handle(press),false);
  assert.deepEqual(f.calls,[]);
});
