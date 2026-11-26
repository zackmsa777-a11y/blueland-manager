'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {Client,Collection,ChannelType,ComponentType,InteractionType,Message,MessageFlags,ModalSubmitInteraction}=require('discord.js');
const {createLxrApply}=require('../src/lxr-apply');
const {openStore}=require('../src/store');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const guildId='1573975432838127708', room='1575125050170806373', bot='1573988210185347223';
const panelId='200000000000000001', userId='200000000000000002', alt='200000000000000003';
const privateId='200000000000000004', request='200000000000000005', ticket='200000000000000006';
const fields=['identity','experience','reason','availability','branding'];
const body={identity:'Alex، 20، الأردن',experience:'لا يوجد',reason:'التطوع',availability:'ساعتين',branding:'نعم',server:'اسم السيرفر',previous_rank:'الرتبة السابقة'};
const bannerName='lxr-apply.png';
function setup({deliver,receiptStore,verifyExistingBanner,history,existing}={}) {
  let panel, time=0;
  const calls=[], sends=[];
  const client={user:{id:bot}};
  const roomRef={id:room,guildId,type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),
    messages:{async fetch(input){if(input.message)return (existing?.id===input.message?existing:panel);return history?.(input)??new Collection(panel?[[panel.id,panel]]:[]);}},
    async send(p){
      sends.push(p);
      const att={id:'200000000000000008',name:bannerName,size:2146209};
      const url=`https://cdn.discordapp.com/attachments/${room}/${att.id}/${att.name}`;
      panel={id:panelId,author:client.user,channelId:room,content:'',components:p.components.map(x=>x.toJSON()),embeds:p.embeds.map(x=>x.toJSON()),attachments:new Collection([[att.id,{...att,url}]])};
      panel.embeds[0].image.url=url;
      return panel;
    }};
  const guild={id:guildId,client,members:{me:{id:bot}},channels:{fetch:async id=>id===room?roomRef:null}};
  const app=createLxrApply({readyGuild:()=>guild,loadBanner:async()=>Buffer.alloc(2146209),now:()=>time,
    receipts:receiptStore??{find:()=>undefined,claim:()=>true,clear:()=>{}},
    verifyExistingBanner:verifyExistingBanner??(async()=>{}),openTicket:deliver??(async record=>{calls.push(record);return ticket;})});
  const make=(mode,customId,{kind='staff',actor=userId,from=panel,values=body,otherRoom=room}={})=>{
    const events=[];
    return {id:request,user:{id:actor,bot:false},guildId,channelId:otherRoom,client,message:from,customId,values:[kind],
      isButton:()=>mode==='button',isStringSelectMenu:()=>mode==='select',isModalSubmit:()=>mode==='modal',
      fields:{getTextInputValue:id=>values[id]},
      showModal:async m=>{events.push(['modal',m.toJSON()]);},reply:async p=>{events.push(['reply',p]);},
      deferReply:async p=>{events.push(['defer',p]);},editReply:async p=>{events.push(['edit',p]);},events};
  };
  return {app,make,calls,sends,setTime:t=>{time=t;},get panel(){return panel;}};
}
const firstId='lxr-apply:select';
function privateEmbed(event) {
  assert.equal(event[1].flags,MessageFlags.Ephemeral);
  assert.ok(event[1].embeds[0].toJSON().description);
  assert.deepEqual(event[1].allowedMentions,{parse:[]});
}

test('approved public panel round-trips once, then both non-transfer modals deliver private application records',async()=>{
  const f=setup();
  assert.equal(await f.app.publish(),panelId);
  assert.equal(await f.app.publish(),panelId);
  assert.equal(f.sends.length,1);
  assert.deepEqual(f.panel.components[0].components[0].options.map(o=>o.value),['staff','girls','transfer']);
  for(const kind of ['staff','girls']) {
    const selected=f.make('select',firstId,{kind});
    assert.equal(await f.app.handle(selected),true);
    const modal=selected.events[0][1];
    assert.deepEqual(modal.components.map(x=>x.component.custom_id),fields);
    assert.ok(modal.components.every(x=>x.component.required));
    const submit=f.make('modal',modal.custom_id);
    assert.equal(await f.app.handle(submit),true);
    assert.equal(submit.events[0][1].flags,MessageFlags.Ephemeral);
    assert.match(submit.events[1][1].embeds[0].toJSON().description,new RegExp(ticket));
    assert.equal(f.calls.at(-1).kind,kind);
    assert.equal(f.calls.at(-1).userId,userId);
    assert.equal(Object.hasOwn(f.calls.at(-1),'images'),false);
  }
});

test('transfer collects required text only and directs the applicant to attach pictures in the private ticket',async t=>{
  const f=setup();await f.app.publish();
  const selected=f.make('select',firstId,{kind:'transfer'});
  await f.app.handle(selected);
  const submit=f.make('modal',selected.events[0][1].custom_id);
  await f.app.handle(submit);
  privateEmbed(submit.events[0]);
  assert.doesNotMatch(submit.events[0][1].embeds[0].toJSON().description,/إثباتات|صورتين/u);
  assert.equal(f.calls.length,0);
  const components=submit.events[0][1].components.map(x=>x.toJSON());
  const continuation=components[0].components[0].custom_id;
  const ephemeral={id:privateId,author:{id:bot},flags:{has:flag=>flag===MessageFlags.Ephemeral},components};
  const wrong=f.make('button',continuation,{from:ephemeral,actor:alt});
  await f.app.handle(wrong);
  privateEmbed(wrong.events[0]);
  const valid=f.make('button',continuation,{from:ephemeral});
  await f.app.handle(valid);
  const details=valid.events[0][1];
  assert.deepEqual(details.components.map(x=>[x.component.custom_id,x.component.type,x.component.required]),[
    ['server',ComponentType.TextInput,true],['previous_rank',ComponentType.TextInput,true]]);
  for(const inputs of [{from:{...ephemeral,id:panelId}}, {from:ephemeral,actor:alt},
    {from:ephemeral,values:{...body,server:''}},{from:ephemeral,values:{...body,previous_rank:''}}]) {
    const failed=f.make('modal',details.custom_id,inputs);
    await f.app.handle(failed);privateEmbed(failed.events[0]);assert.equal(f.calls.length,0);
  }
  const client=new Client({intents:[]});
  t.after(()=>client.destroy());
  client.user=client.users._add({id:bot,username:'LXR Manager',bot:true});
  const submitDetails=new ModalSubmitInteraction(client,{id:request,type:InteractionType.ModalSubmit,application_id:bot,
    token:'synthetic',channel:{id:room,type:ChannelType.GuildText},guild_id:guildId,user:{id:userId,username:'applicant'},
    version:1,app_permissions:'0',entitlements:[],authorizing_integration_owners:{},
    message:{id:privateId,channel_id:room,guild_id:guildId,author:{id:bot,username:'LXR Manager',bot:true},flags:MessageFlags.Ephemeral,components},
    data:{custom_id:details.custom_id,components:[
      {type:ComponentType.Label,id:1,component:{type:ComponentType.TextInput,id:6,custom_id:'server',value:body.server}},
      {type:ComponentType.Label,id:4,component:{type:ComponentType.TextInput,id:9,custom_id:'previous_rank',value:body.previous_rank}}]}});
  submitDetails.deferReply=async p=>assert.equal(p.flags,MessageFlags.Ephemeral);
  submitDetails.editReply=async p=>{
    const text=p.embeds[0].toJSON().description;
    assert.ok(text.includes(ticket));assert.match(text,/أرسل الصورتين داخل التكت/u);
    assert.deepEqual(p.allowedMentions,{parse:[]});
  };
  await f.app.handle(submitDetails);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].id,request);
  assert.equal(f.calls[0].kind,'transfer');
  assert.equal(Object.hasOwn(f.calls[0],'images'),false);
  assert.deepEqual(f.calls[0].answers.map(a=>a.value),Object.values(body));
  await f.app.handle(f.make('modal',details.custom_id,{from:ephemeral}));
  assert.equal(f.calls.length,1);
});

test('foreign or stale panels, blank answers and expired submissions cannot open a ticket',async()=>{
  const f=setup();await f.app.publish();
  const fake=f.make('select',firstId,{from:{...f.panel,id:privateId}});
  await f.app.handle(fake);
  assert.equal(fake.events.some(e=>e[0]==='modal'),false);
  const selected=f.make('select',firstId);await f.app.handle(selected);
  const id=selected.events[0][1].custom_id;
  const blank=f.make('modal',id,{values:{...body,experience:'  '}});
  await f.app.handle(blank);privateEmbed(blank.events[0]);
  f.setTime(60*60_000);
  const expired=f.make('modal',id);
  await f.app.handle(expired);privateEmbed(expired.events[0]);
  assert.equal(f.calls.length,0);
});

test('general support destinations and settings exclude the three closed application audiences',async()=>{
  const {communityGateway}=require('../src/discord-community');
  const categories=['1575528932357439549','1575529519358419024','1575529605467476010'];
  const guild={id:guildId,members:{me:{id:bot}}};
  const record=(id,type=ChannelType.GuildText,parentId=null,topic=null)=>({id,type,parentId,topic,guildId,guild,name:`Room ${id}`,permissionsFor:()=>({has:()=>true})});
  const moved=record('200000000000000019',ChannelType.GuildText,null,'LXR application • 200000000000000099');
  const routes=categories.flatMap((id,index)=>[record(id,ChannelType.GuildCategory),record(`20000000000000001${index}`,ChannelType.GuildText,id)]);
  const general=record(room), standard=record('200000000000000020',ChannelType.GuildCategory);
  const channels=new Collection([...routes,moved,general,standard].map(c=>[c.id,c]));
  guild.channels={async fetch(id){return id?channels.get(id):channels;}};
  const support=communityGateway(()=>guild,()=>{});
  assert.deepEqual((await support.destinations()).map(c=>c.id).sort(),[room,standard.id].sort());
  for (const id of categories) await assert.rejects(support.validateSettings({ticketCategory:id}),/التقديم/u);
  await assert.rejects(support.validateSettings({welcomeChannel:moved.id}),/التقديم/u);
  await support.validateSettings({ticketCategory:standard.id,welcomeChannel:general.id});
});

test('uncertain submission recovers the original private receipt instead of a second application',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lxr-apply-receipt-')),file=join(dir,'receipt.sqlite');
  let store=openStore(file);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const delivered=[], recovered=[];
  async function deliver(record){delivered.push(record);throw new Error('response lost');}
  deliver.recover=async record=>{recovered.push(record);return ticket;};
  const f=setup({deliver,receiptStore:store.applications});await f.app.publish();
  const first=f.make('select',firstId);await f.app.handle(first);
  await f.app.handle(f.make('modal',first.events[0][1].custom_id));
  assert.equal(delivered.length,1);
  assert.equal(delivered[0].freshReservation,true);
  store.close();store=openStore(file);
  assert.deepEqual({...store.applications.find(userId)},{id:request,userId,kind:'staff'});
  const restarted=setup({deliver,receiptStore:store.applications});await restarted.app.publish();
  const select=restarted.make('select',firstId,{kind:'girls'});
  await restarted.app.handle(select);
  assert.equal(select.events[0][1].flags,MessageFlags.Ephemeral);
  assert.match(select.events[1][1].embeds[0].toJSON().description,new RegExp(ticket));
  assert.deepEqual(recovered.map(x=>({...x})),[{id:request,userId,kind:'staff'}]);
  assert.equal(delivered.length,1);
  assert.equal(store.applications.find(userId),undefined);
});

test('only a definitive no-write failure releases the application for a fresh submission',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());
  let attempts=0;
  const deliver=async()=>{
    if (++attempts===1) throw Object.assign(new Error('bad attachment'),{safeToResubmit:true});
    return ticket;
  };
  const f=setup({deliver,receiptStore:store.applications});await f.app.publish();
  for(let attempt=0;attempt<2;attempt++) {
    const select=f.make('select',firstId);await f.app.handle(select);
    assert.equal(select.events[0][0],'modal');
    const submitted=f.make('modal',select.events[0][1].custom_id);
    await f.app.handle(submitted);
    assert.equal(store.applications.find(userId),undefined);
    assert.match(submitted.events[1][1].embeds[0].toJSON().description,attempt===0?/ما انرسل/u:new RegExp(ticket));
  }
  assert.equal(attempts,2);
});

for (const [scenario,description] of [
  ['transient','reopens after a transient pre-write inventory error'],
  ['unavailable','keeps an unresolved reservation'],
  ['capacity','reopens after a definitive first-wire channel-limit rejection'],
]) test(`real form ${description}`,async t=>{
  const {REST,Routes,PermissionFlagsBits}=require('discord.js');
  const {createApplicationTickets}=require('../src/lxr-apply-tickets');
  const store=openStore(':memory:');t.after(()=>store.close());
  const client=new Client({intents:[]});client.user={id:bot};t.after(()=>client.destroy());
  const category='1575528932357439549', reviewer='1574013532586909736', botRole='200000000000000029';
  const role=(id,permissions=0n)=>({id,permissions:String(permissions),managed:false,mentionable:false});
  let inventories=0,writes=0,creates=0;
  client.rest.get=async route=>{
    if (route===Routes.guildChannels(guildId)) {
      inventories++;
      if (scenario==='unavailable' || (scenario==='transient' && inventories===1)) throw new Error('inventory temporarily unavailable');
      return [];
    }
    if (route===Routes.channel(category)) return {id:category,guild_id:guildId,type:ChannelType.GuildCategory,permission_overwrites:[]};
    if (route===Routes.guildRoles(guildId)) return [role(guildId),role(reviewer),role(botRole,PermissionFlagsBits.Administrator)];
    if (route===Routes.guildMember(guildId,bot)) return {user:{id:bot,bot:true},roles:[botRole]};
    if (route===Routes.guildMember(guildId,userId)) return {user:{id:userId,bot:false},roles:[]};
    throw new Error('unexpected Discord read');
  };
  const denyWrite=async()=>{writes++;throw new Error('unexpected Discord write');};
  client.rest.post=denyWrite;
  const writer=new REST({retries:0,makeRequest:async(url,{method})=>{
    creates++;
    assert.equal(method,'POST');
    assert.ok(url.endsWith(Routes.guildChannels(guildId)));
    return Response.json({code:30013,message:'Maximum number of guild channels reached'},{status:400});
  }}).setToken('synthetic');
  writer.clearHashSweeper();writer.clearHandlerSweeper();
  const deliver=createApplicationTickets({readyGuild:()=>({id:guildId,client}),
    getChannelWriteRest:()=>writer});
  const f=setup({deliver,receiptStore:store.applications});await f.app.publish();
  const select=f.make('select',firstId);await f.app.handle(select);
  const submit=f.make('modal',select.events[0][1].custom_id);await f.app.handle(submit);
  assert.ok(inventories>=1);
  const next=f.make('select',firstId,{kind:'girls'});await f.app.handle(next);
  assert.equal(writes,0);
  assert.equal(creates,scenario==='capacity'?1:0);
  if (scenario==='unavailable') {
    assert.equal(store.applications.find(userId)?.id,request);
    assert.equal(next.events[0][0],'defer');
    assert.match(next.events[1][1].embeds[0].toJSON().description,/ما قدرنا نؤكد/u);
  } else {
    assert.equal(store.applications.find(userId),undefined);
    assert.equal(next.events[0][0],'modal');
    assert.match(submit.events[1][1].embeds[0].toJSON().description,/جرّب مرة ثانية/u);
  }
});

test('Discord startup provisions a dedicated no-retry writer without changing the normal REST policy',async t=>{
  const {REST}=require('discord.js');
  const {connectDiscord}=require('../src/discord');
  const store=openStore(':memory:');t.after(()=>store.close());
  const set=REST.prototype.setToken;
  const retries=[];
  t.mock.method(REST.prototype,'setToken',function(token){retries.push(this.options.retries);return set.call(this,token);});
  t.mock.method(REST.prototype,'get',async()=>({id:bot,flags:0}));
  const login=t.mock.method(Client.prototype,'login',async()=>{});
  const discord=connectDiscord(store,{DISCORD_BOT_TOKEN:'synthetic'});
  try {await discord.start();assert.equal(login.mock.callCount(),1);assert.deepEqual(retries,[3,0]);}
  finally {discord.close();}
});

test('Discord embed-only banner readback activates the original application selector without a new post',async t=>{
  const initial=setup();await initial.app.publish();
  const original=initial.panel, banner=original.attachments.first().url+'?ex=synthetic';
  const client=new Client({intents:[]});t.after(()=>client.destroy());
  const message=image=>new Message(client,{id:panelId,channel_id:room,guild_id:guildId,content:'',flags:0,
    author:{id:bot,username:'LXR Manager',bot:true},embeds:[{image:{url:image}},original.embeds[1]],components:original.components,attachments:[]});
  const lookups=[];
  const existing=message(banner);
  const f=setup({existing,verifyExistingBanner:async url=>lookups.push(url),history:()=>new Collection([[panelId,existing]])});
  assert.equal(await f.app.publish(),panelId);
  assert.deepEqual(lookups,[banner]);
  assert.equal(f.sends.length,0);
  const selected=f.make('select',firstId,{from:existing});await f.app.handle(selected);
  assert.equal(selected.events[0][0],'modal');
  assert.deepEqual(selected.events[0][1].components.map(x=>x.component.custom_id),fields);
});

test('embed-only banners reject foreign origins, mismatched URLs and failed byte verification',async()=>{
  const initial=setup();await initial.app.publish();
  const original=initial.panel, url=original.attachments.first().url;
  const existingWith=image=>({...original,attachments:new Collection(),embeds:[{image:{url:image}},original.embeds[1]]});
  const setupFor=(existing,verifyExistingBanner)=>setup({existing,verifyExistingBanner,history:()=>new Collection([[panelId,existing]])});
  const wrong=[url.replace('cdn.discordapp.com','example.org'),url.replace('cdn.discordapp.com','media.discordapp.net'),
    url.replace(room,privateId),url.replace(original.attachments.first().id,'bogus'),url.replace(bannerName,'other.png'),url+'/extra'];
  for (const image of wrong) {
    const f=setupFor(existingWith(image),async()=>assert.fail('Unexpected banner download'));
    await assert.rejects(f.app.publish(),/Unverified application panel/);
    assert.equal(f.sends.length,0);
  }
  let checked=0;
  const corrupt=setupFor(existingWith(url),async()=>{checked++;throw new Error('banner hash mismatch');});
  await assert.rejects(corrupt.app.publish(),/banner hash mismatch/);
  assert.equal(checked,1);
  assert.equal(corrupt.sends.length,0);
});

test('existing panels must be unique, exact, and have verified banner bytes',async t=>{
  const f=setup();await f.app.publish();
  const original=f.panel;
  const makeExisting=(m,verifyExistingBanner)=>setup({existing:m,verifyExistingBanner,history:()=>new Collection([[m.id,m]])});
  const client=new Client({intents:[]});t.after(()=>client.destroy());
  const native=new Message(client,{id:original.id,channel_id:room,guild_id:guildId,content:'',flags:0,
    author:{id:bot,username:'LXR Manager',bot:true},embeds:original.embeds,components:original.components,
    attachments:original.attachments.map(a=>({id:a.id,filename:a.name,size:a.size,url:a.url,proxy_url:a.url}))});
  assert.equal(await makeExisting(native).app.publish(),original.id);
  await assert.rejects(makeExisting({...original,content:'extra public text'}).app.publish(),/panel/u);
  const altered=structuredClone(original.components);
  altered[0].components[0].options[0].emoji.name='🔴';
  await assert.rejects(makeExisting({...original,components:altered}).app.publish(),/panel/u);
  await assert.rejects(makeExisting(original,async()=>{throw new Error('banner hash mismatch');}).app.publish(),/banner/u);
  const duplicate={...original,id:privateId};
  const page=new Collection([[original.id,original],...Array.from({length:99},(_,i)=>[String(200000000000000100n+BigInt(i)),{}])]);
  const multi=setup({existing:original,history:({before})=>before?new Collection([[duplicate.id,duplicate]]):page});
  await assert.rejects(multi.app.publish(),/Multiple/u);
  assert.equal(multi.sends.length,0);
});
