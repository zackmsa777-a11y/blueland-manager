'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/store');
const {catalog,roles}=require('../src/ladder');
const {createCommunity}=require('../src/community');
const {makeService}=require('../src/promotions');
const {SUPPORT}=require('../src/ticket-ui');
const {parseChat,commandRunner}=require('../src/commands');

const member='200000000000000001',other='200000000000000002',owner='200000000000000003';
function fixture(t,group) {
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const held=new Set([group.base,SUPPORT]);
  const bot={id:catalog.botId,name:'BlueLand',roles:['1573988437088932015'],bot:true};
  const person=id=>id===bot.id?bot:{id,name:id,roles:id===member?[...held]:id===other?[SUPPORT]:[],bot:false};
  const gateway={context:async(a,b=a)=>({actor:person(a),target:person(b),bot,roles,ownerId:owner}),
    change:async(_,role,add)=>add?held.add(role):held.delete(role),async syncClaim() {},
    ticketRoom:async row=>String(300000000000000000n+BigInt(row.id))};
  const service=makeService(store,gateway);
  const community=createCommunity(store,gateway,service);
  let sequence=0;
  async function ticket() {
    const author=String(400000000000000000n+BigInt(++sequence));
    return community.openTicket(author,'delivery:'+author,'اختبار','technical','تفاصيل');
  }
  return {ticket,held,gateway,service,store,community,db:store.community};
}
for (const [i,cost] of [15,25,35,65,null,null].entries()) {
  const group=catalog.categories[i];
  test('ticket progress and one-step promotion for '+group.name,async t=>{
    const f=fixture(t,group);
    for(let n=1;n<=(cost ?? 2);n++) {
      const row=await f.ticket();
      await f.community.ticketAction(member,row.id,'claim');
      if (cost && n<cost) assert.equal(f.store.history().length,0);
    }
    const {points}=await f.community.dashboard(member);
    assert.equal(points.total,cost ?? 0);
    assert.equal(points.available,0);
    assert.equal(points.threshold,cost);
    if (cost) {
      assert.ok(f.held.has(group.ranks[1]));
      assert.equal(f.store.history().length,1);
      assert.equal(f.store.history()[0].actor,catalog.botId);
      assert.equal(f.store.history()[0].state,'done');
      assert.equal(points.remaining,cost);
    } else assert.equal(f.store.history().length,0);
  });
}

test('claims recover after a failed permission write and do not pay twice on retries or reassignment',async t=>{
  const f=fixture(t,catalog.categories[0]);
  const row=await f.ticket();
  f.gateway.syncClaim=async()=>{throw new Error('offline');};
  await assert.rejects(f.community.ticketAction(member,row.id,'claim'),/offline/);
  assert.equal(f.db.ticket(row.id).assignee,null);
  assert.equal(f.db.ticketBalance(member).total,0);
  f.gateway.syncClaim=async()=>{};
  const restarted=createCommunity(f.store,f.gateway,f.service);
  await restarted.recover();
  assert.equal(f.db.ticket(row.id).assignee,member);
  await restarted.ticketAction(member,row.id,'claim');
  await assert.rejects(restarted.ticketAction(other,row.id,'claim'),{status:409});
  await restarted.ticketAction(member,row.id,'unclaim');
  await restarted.ticketAction(other,row.id,'claim');
  assert.equal(f.db.ticketBalance(member).total,1);
  assert.equal(f.db.ticketBalance(other).total,0);
});

test('a category boundary keeps cumulative helpers and switches to the new threshold',async t=>{
  const [staff,mod]=catalog.categories;
  const f=fixture(t,staff);
  f.held.add(staff.ranks.at(-1));
  for (let n=0;n<16;n++) await f.community.ticketAction(member,(await f.ticket()).id,'claim');
  const {points}=await f.community.dashboard(member);
  assert.equal(points.group,'Mod');
  assert.equal(points.remaining,24);
  assert.equal(points.total,16);
  assert.equal(points.available,1);
  assert.ok([...staff.helpers,...mod.helpers].every(id=>f.held.has(id)));
});

test('role API failures keep the earned points and recovering the pending step charges once',async t=>{
  const f=fixture(t,catalog.categories[0]);
  const change=f.gateway.change;
  f.gateway.change=async()=>{throw new Error('role API unavailable');};
  for (let i=0;i<15;i++) await f.community.ticketAction(member,(await f.ticket()).id,'claim');
  assert.equal(f.db.ticketBalance(member).available,15);
  assert.equal(f.store.history()[0].state,'pending');
  f.gateway.change=change;
  await f.service.recover();
  await f.community.recover();
  await f.community.recover();
  assert.equal(f.store.history().length,1);
  assert.deepEqual(f.db.ticketBalance(member),{total:15,available:0});
});

test('the points command is personal, staff-only, and independent of activity XP',async t=>{
  const f=fixture(t,catalog.categories[1]);
  const run=commandRunner({store:f.store,community:f.community});
  assert.deepEqual(parseChat('+نقاطي'),{action:'points'});
  assert.throws(()=>parseChat('+نقاطي <@'+other+'>'));
  assert.match(await run({actor:member,action:'points'}),/25/);
  await assert.rejects(run({actor:'200000000000000004',action:'points'}),{status:403});
});
