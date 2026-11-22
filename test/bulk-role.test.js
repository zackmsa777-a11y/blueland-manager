'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Routes, PermissionFlagsBits: P } = require('discord.js');
const { catalog } = require('../src/ladder');
const { createBulkRole } = require('../src/bulk-role');
const { parseChat, commandRunner } = require('../src/commands');
const { createMessageHandler } = require('../src/chat');

const id = catalog.guildId;
const owner = '200000000000000001';
const roleId = '200000000000000002';
const botId = '200000000000000003';
const botRole = '200000000000000004';
const user = n => String(300000000000000000n + BigInt(n));
const member = (id, options = {}) => ({ user:{id,bot:options.bot ?? false}, roles:options.roles ?? [], pending:options.pending ?? false });

function harness(rows) {
  const roles = [
    {id,position:0,permissions:'0',managed:false},
    {id:botRole,position:2,permissions:String(P.ManageRoles),managed:true},
    {id:roleId,position:1,permissions:'0',managed:false}
  ];
  const channels = [], reads = [], writes = [];
  const people = new Map(rows.map(row=>[row.user.id,row]));
  const guild = {id,ownerId:owner,client:{user:{id:botId},rest:{
    async get(route, options) {
      reads.push([route,options]);
      if (route===Routes.guildRoles(id)) return roles;
      if (route===Routes.guildChannels(id)) return channels;
      if (route===Routes.guildMember(id,botId)) return member(botId,{bot:true,roles:[botRole]});
      if (route===Routes.guildMembers(id)) {
        return rows.filter(row=>BigInt(row.user.id)>BigInt(options.query.get('after'))).slice(0,Number(options.query.get('limit')));
      }
      const row=people.get(route.split('/').at(-1));
      assert.ok(row,route);
      return row;
    },
    async put(route, options) {
      writes.push([route,options]);
      const memberId=route.split('/').at(-3);
      assert.equal(route,Routes.guildMemberRole(id,memberId,roleId));
      people.get(memberId).roles.push(roleId);
    }
  }}};
  const run = createBulkRole({readyGuild:()=>guild});
  return { guild, roles, channels, reads, writes, run };
}

const request = {actor:owner,roleId,delivery:'discord:bulk-test'};

test('bulk role syntax accepts a role mention or ID for either audience without changing plain +ر',()=>{
  assert.deepEqual(parseChat('+ر'),{action:'roles'});
  for (const [group,audience] of [['الجميع','members'],['البوتات','bots']]) {
    assert.deepEqual(parseChat('+ر '+group+' '+roleId),{action:'bulk-role',roleId,audience});
    assert.deepEqual(parseChat('+ر '+group+' <@&'+roleId+'>'),{action:'bulk-role',roleId,audience});
    for (const extra of ['', '<@'+roleId+'>', '@everyone', roleId+' 2', roleId.slice(0,16)]) {
      assert.throws(()=>parseChat('+ر '+group+' '+extra),/منشن رول واحد/);
    }
  }
});

test('the bot command targets only other bots and its confirmation cannot authorize human distribution',async()=>{
  const caller=member(botId,{bot:true,roles:[botRole]});
  const human=member(user(1));
  const bot=member(user(2),{bot:true});
  const already=member(user(3),{bot:true,roles:[roleId]});
  const pending=member(user(4),{bot:true,pending:true});
  const h=harness([caller,human,bot,already,pending]);
  h.roles.at(-1).permissions=String(P.ViewChannel);
  const store={community:{}};
  const run=commandRunner({store,bulkRole:h.run});
  const handle=createMessageHandler({store,run,parse:parseChat});
  const replies=[];
  const message={author:{id:owner,bot:false},id:'200000000000000007',guildId:id,channelId:user(10),inGuild:()=>true,
    content:'+ر البوتات '+roleId,reply:async data=>replies.push(data.content)};
  await handle(message);
  assert.equal(h.writes.length,0);
  assert.match(replies[0],/الطرف الثالث/);
  const command=replies[0].match(/`(\+ر البوتات [^`]+)`/)[1];
  assert.equal(parseChat(command).audience,'bots');
  const confirm={...message,id:'200000000000000008',content:command};
  await handle({...confirm,content:command.replace('+ر البوتات ','+ر الجميع ')});
  assert.match(replies.at(-1),/تأكيد غير صالح/);
  assert.equal(h.writes.length,0);
  await handle(confirm);
  assert.deepEqual(h.writes.map(([route])=>route),[Routes.guildMemberRole(id,bot.user.id,roleId)]);
  assert.deepEqual(human.roles,[]);
  assert.deepEqual(caller.roles,[botRole]);
  assert.deepEqual(pending.roles,[]);
  assert.match(replies.at(-1),/تمت الإضافة وتحققت منها: \*\*1\*\*/);
  assert.match(replies.at(-1),/عندهم الرول مسبقًا: \*\*1\*\*/);
  assert.match(replies.at(-1),/الانضمام\): \*\*3\*\*/);
});

test('the Discord handler delegates the bulk role, reads all pages, verifies writes and skips existing/bot/pending members',async()=>{
  const rows = [member(user(1)),member(user(2),{roles:[roleId]}),member(user(3),{pending:true}),
    ...Array.from({length:997},(_,i)=>member(user(i+4),{bot:true})),member(user(1001))];
  const h = harness(rows);
  const store = {community:{}};
  const run = commandRunner({store,bulkRole:h.run});
  const onMessage = createMessageHandler({store,run,parse:parseChat});
  const replies=[];
  await onMessage({author:{id:owner,bot:false},id:'200000000000000005',guildId:id,inGuild:()=>true,
    content:'+ر الجميع <@&'+roleId+'>',reply:async data=>replies.push(data)});
  assert.deepEqual(h.reads.filter(([route])=>route===Routes.guildMembers(id)).map(([,opt])=>opt.query.get('after')),['0',user(1000)]);
  assert.deepEqual(h.writes.map(([route])=>route),[Routes.guildMemberRole(id,user(1),roleId),Routes.guildMemberRole(id,user(1001),roleId)]);
  assert.ok(h.writes.every(([,opt])=>opt.reason.includes(owner) && opt.reason.includes('discord:200000000000000005')));
  for (const target of [user(1),user(1001)]) assert.ok(h.reads.some(([route])=>route===Routes.guildMember(id,target)));
  assert.equal(replies.length,1);
  assert.match(replies[0].content,/تمت الإضافة وتحققت منها: \*\*2\*\*/);
  assert.match(replies[0].content,/عندهم الرول مسبقًا: \*\*1\*\*/);
  assert.match(replies[0].content,/الانضمام\): \*\*998\*\*/);
  assert.deepEqual(replies[0].allowedMentions,{parse:[],repliedUser:false});
});

test('bulk role keeps Discord role restrictions and refuses non-owners before writing',async()=>{
  const h = harness([member(user(1))]);
  await assert.rejects(h.run({...request,actor:user(1)}),/لمالك السيرفر فقط/);
  assert.equal(h.reads.length,0);
  await assert.rejects(h.run({...request,roleId:id}),/@everyone/);
  await assert.rejects(h.run({...request,roleId:user(2)}),/غير موجود/);
  const role=h.roles.at(-1);
  role.managed=true;
  await assert.rejects(h.run(request),/لا يمكن منحه يدويًا/);
  role.managed=false; role.position=3;
  await assert.rejects(h.run(request),/رولًا أعلى/);
  role.position=1; h.roles[1].permissions='0';
  await assert.rejects(h.run(request),/Manage Roles/);
  assert.equal(h.writes.length,0);
});

test('the owner can preview and confirm an administrative role using the returned chat command',async()=>{
  const h=harness([member(user(1))]);
  h.roles.at(-1).permissions=String(P.Administrator);
  h.roles[1].permissions=String(P.ManageRoles | P.Administrator);
  const store={community:{}};
  const run=commandRunner({store,bulkRole:h.run});
  const onMessage=createMessageHandler({store,run,parse:parseChat});
  const replies=[];
  const message={author:{id:owner,bot:false},id:'200000000000000005',guildId:id,channelId:user(10),inGuild:()=>true,
    content:'+ر الجميع <@&'+roleId+'>',reply:async data=>replies.push(data.content)};
  await onMessage(message);
  assert.equal(h.writes.length,0);
  assert.match(replies[0],/Administrator/);
  const command=replies[0].match(/`(\+ر الجميع [^`]+)`/)[1];
  assert.equal(parseChat(command).roleId,roleId);
  assert.match(parseChat(command).confirmation,/^[a-f0-9]{12}$/);
  const confirm={...message,id:'200000000000000006',content:command};
  await onMessage({...confirm,channelId:user(11)});
  assert.match(replies.at(-1),/تأكيد غير صالح/);
  assert.equal(h.writes.length,0);
  await onMessage(confirm);
  assert.match(replies.at(-1),/تمت الإضافة وتحققت منها: \*\*1\*\*/);
  assert.equal(h.writes[0][0],Routes.guildMemberRole(id,user(1),roleId));
  await onMessage(confirm);
  assert.match(replies.at(-1),/تأكيد غير صالح/);
  assert.equal(h.writes.length,1);
});

test('channel permission changes or expired confirmation require a new preview',async()=>{
  const h=harness([member(user(1))]);
  let time=1000;
  const run=createBulkRole({readyGuild:()=>h.guild,now:()=>time});
  const room={id:user(10),permission_overwrites:[{id:roleId,allow:String(P.ViewChannel),deny:'0'}]};
  h.channels.push(room);
  const first=await run(request);
  assert.deepEqual(first.impact,{administrator:false,guildPermissions:false,rooms:1,policyRole:false});
  room.permission_overwrites[0].allow='0';
  room.permission_overwrites[0].deny=String(P.SendMessages);
  await assert.rejects(run({...request,confirmation:first.token}),/تغيّرت إعدادات الرول/);
  const second=await run(request);
  time+=120_000;
  await assert.rejects(run({...request,confirmation:second.token}),/تأكيد غير صالح/);
  assert.equal(h.writes.length,0);
  const third=await run(request);
  assert.equal((await run({...request,confirmation:third.token})).added,1);
});

test('ranks and delegation roles without native permission bits still ask for confirmation',async()=>{
  const h=harness([member(user(1))]);
  const ladderRole=catalog.categories[0].helpers[0];
  h.roles.push({id:ladderRole,position:1,permissions:'0',managed:false});
  const run=createBulkRole({readyGuild:()=>h.guild,reservedRole:role=>role===roleId});
  for (const id of [roleId,ladderRole]) {
    const preview=await run({...request,roleId:id});
    assert.equal(preview.impact.policyRole,true);
    assert.match(preview.token,/^[a-f0-9]{12}$/);
  }
  assert.equal(h.writes.length,0);
});

test('bulk role counts rejected writes and unverified writes separately and does not redo assigned members',async()=>{
  const h = harness([member(user(1)),member(user(2)),member(user(3))]);
  const put=h.guild.client.rest.put;
  h.guild.client.rest.put=async (route,options)=>{
    if (route===Routes.guildMemberRole(id,user(2),roleId)) throw new Error('member left');
    if (route===Routes.guildMemberRole(id,user(3),roleId)) return;
    return put(route,options);
  };
  assert.deepEqual(await h.run(request),{added:1,already:0,skipped:0,failed:1,unverified:1,remaining:0});
  assert.deepEqual(await h.run(request),{added:0,already:1,skipped:0,failed:1,unverified:1,remaining:0});
  assert.equal(h.writes.length,1);
});
