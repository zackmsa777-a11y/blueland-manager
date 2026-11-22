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

test('bulk role syntax accepts a role mention or ID without changing plain +ر',()=>{
  assert.deepEqual(parseChat('+ر'),{action:'roles'});
  assert.deepEqual(parseChat('+ر الجميع '+roleId),{action:'bulk-role',roleId});
  assert.deepEqual(parseChat('+ر الجميع <@&'+roleId+'>'),{action:'bulk-role',roleId});
  for (const extra of ['', '<@'+roleId+'>', '@everyone', roleId+' 2', roleId.slice(0,16)]) {
    assert.throws(()=>parseChat('+ر الجميع '+extra),/منشن رول واحد/);
  }
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

test('bulk role refuses non-owners, privileged or protected roles and roles above the bot before writing',async()=>{
  const h = harness([member(user(1))]);
  await assert.rejects(h.run({...request,actor:user(1)}),/لمالك السيرفر فقط/);
  assert.equal(h.reads.length,0);
  await assert.rejects(h.run({...request,roleId:id}),/رولات السلّم/);
  await assert.rejects(h.run({...request,roleId:catalog.categories[0].helpers[0]}),/رولات السلّم/);
  const reserved = createBulkRole({readyGuild:()=>h.guild,reservedRole:role=>role===roleId});
  await assert.rejects(reserved(request),/رولات السلّم/);
  await assert.rejects(h.run({...request,roleId:user(2)}),/غير موجود/);
  const role=h.roles.at(-1);
  role.permissions=String(P.Administrator);
  await assert.rejects(h.run(request),/بدون صلاحيات/);
  role.permissions='0'; role.managed=true;
  await assert.rejects(h.run(request),/بدون صلاحيات/);
  role.managed=false;
  h.channels.push({permission_overwrites:[{id:roleId,allow:String(P.ViewChannel),deny:'0'}]});
  await assert.rejects(h.run(request),/أذونات خاصة/);
  h.channels[0].permission_overwrites[0].allow='0';
  h.channels[0].permission_overwrites[0].deny=String(P.SendMessages);
  await assert.rejects(h.run(request),/أذونات خاصة/);
  h.channels.length=0; role.position=3;
  await assert.rejects(h.run(request),/رولًا أعلى/);
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
