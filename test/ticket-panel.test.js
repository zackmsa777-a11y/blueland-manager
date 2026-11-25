'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {ChannelType,Collection,MessageFlags,ActionRowBuilder,ButtonBuilder,StringSelectMenuBuilder,ComponentType}=require('discord.js');
const {openStore}=require('../src/store');
const {createCommunity}=require('../src/community');
const {createMessageHandler}=require('../src/chat');
const {catalog,ladder,roles,RuleError}=require('../src/ladder');
const {createDiscordTickets}=require('../src/discord-tickets');
const {PANEL,SUPPORT,ticketVisible}=require('../src/ticket-ui');

const owner='200000000000000001', opener='200000000000000002', helper='200000000000000003', guest='200000000000000004';
const room='200000000000000005', panelMessage='200000000000000006', admin='200000000000000007';
const manager='200000000000000009', helper2='200000000000000010', MANAGERS='1574013527050424410';
const bot=catalog.botId;
const person=(id,rs=[])=>({id,name:id,roles:rs,bot:false});
function setup(t,path=':memory:',helperGrade) {
  const store=openStore(path);
  t.after(()=>store.close());
  const db=store.community;
  const calls=[], posts=new Collection();
  let panelPayload;
  function panelPost(payload) {
    panelPayload=payload;
    const components=payload.components.map(row=>new ActionRowBuilder().addComponents(row.components.map(control=>
      control.type===ComponentType.StringSelect?new StringSelectMenuBuilder(control):new ButtonBuilder(control))).toJSON());
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
    async context(id) {return {actor:person(id,[helper,helper2].includes(id)?[SUPPORT,...(helperGrade?[helperGrade]:[])]:id===manager?[MANAGERS]:id===admin?[catalog.roles.find(r=>(BigInt(r.permissions || 0)&8n)!==0n).id]:[]),ownerId:owner,roles};},
    async ticketRoom(ticket) {calls.push(['open',ticket.kind,ticket.subject,ticket.details]);return room;},
    async ticketWriting(ticket,enable,guests) {calls.push(['write',ticket.channel,enable,guests]);},
    async syncClaim(ticket) {calls.push(['claim',ticket.channel]);},
    async announceClaim(ticket,actor,id) {
      assert.equal(db.ticket(ticket.id).assignee,actor);
      calls.push(['notice',ticket.channel,actor,id]);
    },
    async editTicketRoom(ticket,action,target) {calls.push([action,ticket.channel,target]);}
  };
  const community=createCommunity(store,gateway,{checkOperator(){throw new RuleError('not an operator',403);}});
  const readyGuild=()=>guild;
  const tickets=createDiscordTickets({db,community,readyGuild});
  function interaction(customId,{actor=opener,channel=PANEL,id=panelMessage,interactionId='200000000000000008',modal=false,selection,author=bot}={}) {
    const out=[];
    return {out,customId,guildId:catalog.guildId,channelId:channel,id:interactionId,user:person(actor),client:guild.client,
      message:{id,author:{id:author}},isButton:()=>!modal && !selection,isModalSubmit:()=>modal,
      isStringSelectMenu:()=>Boolean(selection),values:selection?[selection]:[],
      fields:{getTextInputValue:key=>({subject:'الدخول',details:'المشكلة في الدخول'})[key]},
      async reply(payload){this.replied=true;out.push(payload);},async showModal(builder){out.push(builder.toJSON());},
      async deferReply(payload){this.deferred=true;out.push(payload);},async editReply(payload){out.push(payload);}};
  }
  const sent=[];
  const onMessage=createMessageHandler({store,ticketMessages:tickets.text});
  const incoming=(content,actor=helper,channelId=room)=>onMessage({content,channelId,author:person(actor),guildId:catalog.guildId,inGuild:()=>true,channel:{async send(payload){sent.push(payload);}}});
  return {db,calls,tickets,sent,community,gateway,incoming,posts,readyGuild,interaction,panel:()=>panelPayload};
}

test('the verified Discord panel is published once, including after a new controller starts',async t=>{
  const f=setup(t);
  assert.deepEqual(await Promise.all([f.tickets.syncPanel(),f.tickets.syncPanel()]),[panelMessage,panelMessage]);
  assert.equal(await createDiscordTickets({db:f.db,community:f.community,readyGuild:f.readyGuild}).syncPanel(),panelMessage);
  assert.deepEqual(f.calls,[['panel']]);
  assert.equal(f.panel().components[0].components[0].placeholder,'فتح التذكرة');
  assert.equal(f.posts.get(panelMessage).content,'');
  assert.equal(f.posts.get(panelMessage).embeds[0].title,'🎫 مركز تذاكر BlueLand');
});

test('an existing plain-text ticket panel becomes an Embed in the same message',async t=>{
  const f=setup(t);
  await f.tickets.syncPanel();
  const old=f.posts.get(panelMessage);
  old.embeds=[];
  old.content='لوحة التذاكر القديمة';
  old.components=[{components:[{type:ComponentType.Button,custom_id:'blticket:choose'}]}];
  assert.equal(await f.tickets.syncPanel(),panelMessage);
  assert.equal(await f.tickets.syncPanel(),panelMessage);
  assert.deepEqual(f.calls,[['panel'],['edit-panel',panelMessage]]);
  assert.equal(f.posts.size,1);
  assert.equal(f.posts.get(panelMessage).content,'');
  assert.equal(f.posts.get(panelMessage).embeds[0].title,'🎫 مركز تذاكر BlueLand');
  assert.equal(f.posts.get(panelMessage).components[0].components[0].type,ComponentType.StringSelect);
});

test('the live panel shape opens one private modal for each of the three ticket choices',async t=>{
  const f=setup(t);
  await f.tickets.syncPanel();
  const menu=f.posts.get(panelMessage).components[0].components[0];
  assert.deepEqual(menu.options.map(o=>o.label),['الدعم الفني','الشكوى على إداري','استلام الجوائز']);
  for (const selection of ['technical','staff-complaint','rewards']) {
    const open=f.interaction(menu.custom_id,{selection});
    assert.equal(await f.tickets.interaction(open),true);
    assert.equal(open.out[0].custom_id,'blticket:form:'+selection);
    assert.deepEqual(open.out[0].components.map(r=>r.components[0].custom_id),['subject','details']);
  }
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

test('new complaints are restricted to managers in both ticket actions and the dashboard filter',async t=>{
  const f=setup(t);
  const row=await f.community.openTicket(opener,'new','عنوان','staff-complaint','تفاصيل خاصة');
  const old={...row,kind:'complaint'};
  for (const actor of [helper,admin]) {
    await assert.rejects(f.community.ticketAction(actor,row.id,'claim'),{status:403});
    assert.equal(ticketVisible(row,(await f.community.dashboard(actor)).rights),false);
  }
  const rights=(await f.community.dashboard(manager)).rights;
  assert.equal(ticketVisible(row,rights),true);
  assert.equal(ticketVisible(old,rights),false);
  await assert.rejects(f.community.manageTicket(manager,row.id,'add',guest),{status:403});
  assert.equal((await f.community.ticketAction(manager,row.id,'claim')).assignee,manager);
  assert.equal(f.db.ticketBalance(manager).total,0);
});

test('rewards forms use the typed rewards queue and can be handled by Ticket Support',async t=>{
  const f=setup(t);
  await f.tickets.syncPanel();
  const submit=f.interaction('blticket:form:rewards',{modal:true});
  await f.tickets.interaction(submit);
  const row=f.db.ticketByChannel(room);
  assert.equal(row.kind,'rewards');
  assert.equal(ticketVisible(row,(await f.community.dashboard(helper)).rights),true);
  await assert.rejects(f.community.ticketAction(guest,row.id,'claim'),{status:403});
  assert.equal((await f.community.ticketAction(helper,row.id,'claim')).assignee,helper);
});

test('new staff complaints persist the rollback-safe complaint kind without conflating old complaints',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'bl-ticket-'));
  const path=join(directory,'ticket.sqlite');
  const f=setup(t,path);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  f.db.reserveTicket('old',guest,'موضوع قديم','complaint','خاص');
  await f.tickets.syncPanel();
  const submit=f.interaction('blticket:form:staff-complaint',{modal:true});
  await f.tickets.interaction(submit);
  assert.match(submit.out.at(-1).content,/^تذكرتك:/u);
  const row=f.db.ticketByChannel(room);
  assert.equal(row.kind,'staff-complaint');
  const raw=new DatabaseSync(path,{readOnly:true});
  try {
    assert.deepEqual(raw.prepare('SELECT kind FROM support_tickets ORDER BY id').all().map(r=>r.kind),['complaint','complaint']);
    assert.deepEqual(raw.prepare('SELECT staff_complaint FROM support_tickets ORDER BY id').all().map(r=>r.staff_complaint),[0,1]);
  } finally { raw.close(); }
  assert.deepEqual(f.db.tickets().map(r=>r.kind),['staff-complaint','complaint']);
});

test('rewards keep the support-only technical storage kind for an older dashboard',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'bl-rewards-'));
  const path=join(directory,'ticket.sqlite');
  const f=setup(t,path);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await f.community.openTicket(opener,'rewards-one','جائزة','rewards','تفاصيل خاصة');
  const raw=new DatabaseSync(path,{readOnly:true});
  try { assert.equal(raw.prepare('SELECT kind FROM support_tickets WHERE channel=?').get(room).kind,'technical'); }
  finally { raw.close(); }
  assert.equal(f.db.ticketByChannel(room).kind,'rewards');
});

test('the claim button announces one verified assignment and the assignee can release it for another agent',async t=>{
  const f=setup(t), row=await f.community.openTicket(opener,'one','موضوع','technical','وصف');
  const click=(action,actor)=>f.tickets.interaction(f.interaction(`blticket:${action}:${row.id}`,{channel:room,actor}));
  await click('claim',helper);
  assert.equal(f.db.ticket(row.id).assignee,helper);
  await click('claim',helper);
  assert.deepEqual(f.calls.filter(c=>c[0]==='notice'),[['notice',room,helper,'200000000000000008']]);
  await click('unclaim',helper2);
  assert.equal(f.db.ticket(row.id).assignee,helper);
  await click('unclaim',helper);
  assert.equal(f.db.ticket(row.id).assignee,null);
  await click('claim',helper2);
  assert.equal(f.db.ticket(row.id).assignee,helper2);
  assert.deepEqual(f.calls.filter(c=>c[0]==='notice').map(c=>c[2]),[helper,helper2]);
});

test('a claim announcement failure survives restart and retries with the original nonce and only one point',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'bl-claim-'));
  const path=join(directory,'ticket.sqlite');
  const grade=ladder.find(step=>step.group.id==='new-staff').id;
  const f=setup(t,path,grade);
  const row=await f.community.openTicket(opener,'one','موضوع','technical','وصف');
  f.gateway.announceClaim=async(_row,_actor,_nonce,_attempted,beforeSend)=>{
    beforeSend?.();
    throw new Error('transient Discord send failure');
  };
  const click=async (h,action,interactionId)=>{
    const i=h.interaction(`blticket:${action}:${row.id}`,{channel:room,actor:helper,interactionId});
    await h.tickets.interaction(i);
    return i.out.at(-1).content;
  };
  const nonce='200000000000000008', retry='200000000000000018';
  assert.match(await click(f,'claim',nonce),/تعذّر/u);
  assert.equal(f.db.ticket(row.id).assignee,helper);
  assert.equal(f.db.ticketBalance(helper).total,1);
  const restarted=setup(t,path,grade);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  assert.equal(await click(restarted,'claim',retry),'تم استلام التذكرة.');
  assert.equal(await click(restarted,'claim',retry),'تم استلام التذكرة.');
  assert.deepEqual(restarted.calls.filter(c=>c[0]==='notice'),[['notice',room,helper,nonce]]);
  assert.equal(restarted.db.ticketBalance(helper).total,1);
  await click(restarted,'unclaim',retry);
  await click(restarted,'claim',retry);
  assert.deepEqual(restarted.calls.filter(c=>c[0]==='notice').map(c=>c[3]),[nonce,retry]);
  assert.equal(restarted.db.ticketBalance(helper).total,1);
});

test('preflight failures leave the persisted claim notice eligible for a first send',async t=>{
  const f=setup(t), row=await f.community.openTicket(opener,'preflight','موضوع','technical','وصف');
  f.gateway.announceClaim=async()=>{throw new Error('channel fetch failed before send');};
  const click=()=>f.tickets.interaction(f.interaction(`blticket:claim:${row.id}`,{channel:room,actor:helper}));
  await click();
  assert.equal(f.db.claimChange(row.id).notice_attempted,null);
  let sent=false;
  f.gateway.announceClaim=async(_row,_actor,_nonce,firstAttempt,beforeSend)=>{
    assert.equal(firstAttempt,null);
    beforeSend();
    assert.ok(f.db.claimChange(row.id).notice_attempted);
    sent=true;
  };
  await click();
  assert.equal(sent,true);
  assert.equal(f.db.claimChange(row.id).notice_nonce,null);
});

test('an old or foreign message cannot submit a private ticket form',async t=>{
  const f=setup(t);
  await f.tickets.syncPanel();
  for (const source of [{id:'200000000000000099'},{author:opener}]) {
    const submit=f.interaction('blticket:form:staff-complaint',{modal:true,...source});
    await f.tickets.interaction(submit);
    assert.equal(submit.out[0].flags,MessageFlags.Ephemeral);
    assert.match(submit.out[0].content,/اللوحة|لوحة التذاكر/u);
  }
  assert.deepEqual(f.calls,[['panel']]);
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
