'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ChannelType,Collection,MessageFlags,ActionRowBuilder,ButtonBuilder}=require('discord.js');
const {openStore}=require('../src/store');
const {createCommunity}=require('../src/community');
const {createMessageHandler}=require('../src/chat');
const {catalog,roles,RuleError}=require('../src/ladder');
const {createDiscordTickets}=require('../src/discord-tickets');
const {PANEL,SUPPORT}=require('../src/ticket-ui');

const owner='200000000000000001', opener='200000000000000002', helper='200000000000000003', guest='200000000000000004';
const room='200000000000000005', panelMessage='200000000000000006', admin='200000000000000007';
const bot=catalog.botId;
const person=(id,rs=[])=>({id,name:id,roles:rs,bot:false});
function setup(t) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const db=store.community;
  const calls=[], posts=new Collection();
  let panelPayload;
  function panelPost(payload) {
    panelPayload=payload;
    const components=payload.components.map(row=>new ActionRowBuilder().addComponents(row.components.map(button=>new ButtonBuilder(button))).toJSON());
    const post={id:panelMessage,author:{id:bot},content:payload.content || '',embeds:payload.embeds || [],components,
      async edit(edited) {calls.push(['edit-panel',panelMessage]);return panelPost(edited);}};
    posts.set(post.id,post);
    return post;
  }
  const panelChannel={id:PANEL,guildId:catalog.guildId,type:ChannelType.GuildText,
    messages:{async fetch(options) { if (!options.message) return posts; const post=posts.get(options.message); if (!post) throw Object.assign(new Error('unknown message'),{code:10008});return post; }},
    async send(payload) {
      calls.push(['panel']);return panelPost(payload);
    }};
  const guild={client:{user:{id:bot}},channels:{async fetch(id) {assert.equal(id,PANEL);return panelChannel;}}};
  const gateway={
    async context(id) {return {actor:person(id,id===helper?[SUPPORT]:id===admin?[catalog.roles.find(r=>(BigInt(r.permissions || 0)&8n)!==0n).id]:[]),ownerId:owner,roles};},
    async ticketRoom(ticket) {calls.push(['open',ticket.kind,ticket.subject,ticket.details]);return room;},
    async ticketWriting(ticket,enable,guests) {calls.push(['write',ticket.channel,enable,guests]);},
    async syncClaim(ticket) {calls.push(['claim',ticket.channel]);},
    async editTicketRoom(ticket,action,target) {calls.push([action,ticket.channel,target]);}
  };
  const community=createCommunity(store,gateway,{checkOperator(){throw new RuleError('not an operator',403);}});
  const readyGuild=()=>guild;
  const tickets=createDiscordTickets({db,community,readyGuild});
  function interaction(customId,{actor=opener,channel=PANEL,id=panelMessage,modal=false,author=bot}={}) {
    const out=[];
    return {out,customId,guildId:catalog.guildId,channelId:channel,id:'200000000000000008',user:person(actor),client:guild.client,
      message:{id,author:{id:author}},isButton:()=>!modal,isModalSubmit:()=>modal,
      fields:{getTextInputValue:key=>({subject:'الدخول',details:'المشكلة في الدخول'})[key]},
      async reply(payload){this.replied=true;out.push(payload);},async showModal(builder){out.push(builder.toJSON());},
      async deferReply(payload){this.deferred=true;out.push(payload);},async editReply(payload){out.push(payload);}};
  }
  const sent=[];
  const onMessage=createMessageHandler({store,ticketMessages:tickets.text});
  const incoming=(content,actor=helper,channelId=room)=>onMessage({content,channelId,author:person(actor),guildId:catalog.guildId,inGuild:()=>true,channel:{async send(payload){sent.push(payload);}}});
  return {db,calls,tickets,sent,community,incoming,posts,readyGuild,interaction,panel:()=>panelPayload};
}

test('the verified Discord panel is published once, including after a new controller starts',async t=>{
  const f=setup(t);
  assert.deepEqual(await Promise.all([f.tickets.syncPanel(),f.tickets.syncPanel()]),[panelMessage,panelMessage]);
  assert.equal(await createDiscordTickets({db:f.db,community:f.community,readyGuild:f.readyGuild}).syncPanel(),panelMessage);
  assert.deepEqual(f.calls,[['panel']]);
  assert.equal(f.panel().components[0].components[0].label,'للدعم الفني');
  assert.equal(f.posts.get(panelMessage).content,'');
  assert.equal(f.posts.get(panelMessage).embeds[0].title,'🎫 مركز تذاكر BlueLand');
});

test('an existing plain-text ticket panel becomes an Embed in the same message',async t=>{
  const f=setup(t);
  await f.tickets.syncPanel();
  const old=f.posts.get(panelMessage);
  old.embeds=[];
  old.content='لوحة التذاكر القديمة';
  assert.equal(await f.tickets.syncPanel(),panelMessage);
  assert.equal(await f.tickets.syncPanel(),panelMessage);
  assert.deepEqual(f.calls,[['panel'],['edit-panel',panelMessage]]);
  assert.equal(f.posts.size,1);
  assert.equal(f.posts.get(panelMessage).content,'');
  assert.equal(f.posts.get(panelMessage).embeds[0].title,'🎫 مركز تذاكر BlueLand');
  const press=f.interaction('blticket:choose');
  await f.tickets.interaction(press);
  assert.deepEqual(press.out[0].components[0].components.map(x=>x.label),['الدعم الفني','شكوى على إداري']);
});

test('the real button handler opens exactly two private options and serializes a valid Discord form',async t=>{
  const f=setup(t);
  await f.tickets.syncPanel();
  const choose=f.interaction('blticket:choose');
  assert.equal(await f.tickets.interaction(choose),true);
  assert.equal(choose.out[0].flags,MessageFlags.Ephemeral);
  assert.deepEqual(choose.out[0].components[0].components.map(x=>x.label),['الدعم الفني','شكوى على إداري']);
  const open=f.interaction('blticket:open:technical');
  await f.tickets.interaction(open);
  assert.equal(open.out[0].custom_id,'blticket:form:technical');
  assert.deepEqual(open.out[0].components.map(r=>r.components[0].custom_id),['subject','details']);
  const submit=f.interaction('blticket:form:technical',{modal:true});
  await f.tickets.interaction(submit);
  assert.ok(submit.out.at(-1).content.includes(room));
  assert.deepEqual(f.calls.at(-1),['open','technical','الدخول','المشكلة في الدخول']);
  assert.equal(f.db.ticketByChannel(room).kind,'technical');
});

test('ticket department permissions distinguish the support role from server administrators',async t=>{
  const f=setup(t);
  const complaint=await f.community.openTicket(opener,'one','موضوع','complaint','سر');
  await assert.rejects(f.community.ticketAction(helper,complaint.id,'claim'),{status:403});
  await assert.rejects(f.community.manageTicket(admin,complaint.id,'rename','new'),{status:403});
  assert.equal((await f.community.ticketAction(owner,complaint.id,'claim')).assignee,owner);
  assert.equal((await f.community.dashboard(helper)).rights.complaintTickets,false);
  assert.equal((await f.community.dashboard(owner)).rights.complaintTickets,true);
});

test('text commands do not affect ordinary channels or members lacking ticket access rights',async t=>{
  const f=setup(t);
  await f.community.openTicket(opener,'one','موضوع','technical','وصف');
  await f.incoming('+rename not-a-ticket',helper,PANEL);
  assert.equal(f.sent.length,0);
  await f.incoming('+rename not-allowed',opener);
  assert.match(f.sent.at(-1).content,/المخوّل/u);
  assert.equal(f.calls.length,1);
  await f.incoming('+rename طلب جديد');
  assert.deepEqual(f.calls.at(-1),['rename',room,'طلب-جديد']);
});

test('add/remove track only guests granted by the ticket command and close keeps the room',async t=>{
  const f=setup(t);
  const ticket=await f.community.openTicket(opener,'one','موضوع','technical','وصف');
  await f.incoming('+remove '+opener);
  assert.match(f.sent.at(-1).content,/لم تتم إضافته/u);
  await f.incoming('+add <@'+guest+'>');
  assert.deepEqual(f.db.ticketGuests(ticket.id),[guest]);
  await f.incoming('+add '+guest);
  assert.match(f.sent.at(-1).content,/مضاف للتذكرة بالفعل/u);
  await f.incoming('+close',opener);
  assert.deepEqual(f.calls.at(-1),['write',room,false,[guest]]);
  assert.equal(f.db.ticket(ticket.id).state,'closed');
  assert.equal(f.db.ticket(ticket.id).channel,room);
  await f.incoming('+remove '+guest);
  assert.deepEqual(f.db.ticketGuests(ticket.id),[]);
  assert.deepEqual(f.calls.at(-1),['remove',room,guest]);
});

test('delete requires the original authorized actor to use a fresh confirmation in the ticket room',async t=>{
  const f=setup(t);
  const ticket=await f.community.openTicket(opener,'one','موضوع','technical','وصف');
  await f.incoming('+delete');
  const button=f.sent[0].components[0].components[0];
  for (const i of [f.interaction(button.custom_id,{channel:room,actor:opener}),
      f.interaction(button.custom_id,{channel:PANEL,actor:helper}),
      f.interaction(`blticket:delete:${ticket.id}:${helper}:${Date.now()-1}`,{channel:room,actor:helper})]) {
    await f.tickets.interaction(i);
    assert.match(i.out.at(-1).content,/الزر ليس لك|يعمل داخل تذكرة/u);
  }
  assert.equal(f.db.ticket(ticket.id).channel,room);
  await f.tickets.interaction(f.interaction(button.custom_id,{channel:room,actor:helper}));
  assert.deepEqual(f.calls.at(-1),['delete',room,undefined]);
  assert.equal(f.db.ticket(ticket.id).channel,null);
});
