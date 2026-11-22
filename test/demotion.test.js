'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ladder,planPromotion}=require('../src/ladder');
const {parseChat}=require('../src/commands');
const actor='200000000000000001';

test('only the registered administrator and actual owner can demote members',()=>{
  const {canDemote}=require('../src/promotions');
  const role={id:'123',position:1,permissions:'8'};
  const ctx={actor:{id:'someone',roles:['123'],bot:false},ownerId:'owner',operatorId:actor,roles:new Map([['123',role]])};
  assert.equal(canDemote(ctx),false);
  ctx.actor.id=actor;assert.equal(canDemote(ctx),true);
  role.permissions='0';assert.equal(canDemote(ctx),false);
  ctx.actor.id='owner';assert.equal(canDemote(ctx),true);
  ctx.actor.bot=true;assert.equal(canDemote(ctx),false);
});

test('all demotion steps preserve unrelated roles and remove lost category helpers',()=>{
  const unrelated='12345';
  for (const [i,step] of ladder.entries()) {
    const held=[step.group.base,step.id,...step.helpers,unrelated];
    if (!i) {assert.throws(()=>planPromotion(held,'demote'));continue;}
    const p=planPromotion(held,'demote');
    assert.equal(p.to,ladder[i-1].id);
    assert.equal(p.remove.includes(unrelated),false);
    assert.deepEqual(p.helpers,ladder[i-1].helpers);
    for(const helper of step.helpers) assert.equal(p.remove.includes(helper),!p.helpers.includes(helper));
  }
});

test('demotion accepts one member and an optional positive whole number',()=>{
  const target='1216830648480960552';
  const mention='<@'+target+'>';
  assert.deepEqual(parseChat('+تخفيض '+mention),{action:'demote',target,count:1});
  assert.deepEqual(parseChat('+تخفيض '+mention+' 2'),{action:'demote',target,count:2});
  assert.deepEqual(parseChat('+demote <@!'+target+'> 3'),{action:'demote',target,count:3});
  for (const suffix of ['0','-2','1.5','2e1','2 3','everything','<@'+actor+'>',String(ladder.length+1)]) {
    assert.throws(()=>parseChat('+تخفيض '+mention+' '+suffix));
  }
  assert.throws(()=>parseChat('+تخفيض @everyone 2'),/منشن عضو واحد/);
  assert.throws(()=>parseChat('+تخفيض <@&'+target+'> 2'),/منشن عضو واحد/);
});

test('numbered demotions land directly on all valid lower grades and preserve variant and unrelated roles',()=>{
  const unrelated='12345';
  for (const [i,step] of ladder.entries()) {
    const held = new Set([step.group.variant,...step.helpers,unrelated]);
    if (step.id !== step.group.base) held.add(step.id);
    for (let count=2;count<=i;count++) {
      const destination = ladder[i-count];
      const plan = planPromotion(held,'demote',count);
      assert.equal(plan.to,destination.id);
      assert.equal(plan.direction,'demote');
      assert.equal(plan.count,count);
      const actual = new Set([...held,...plan.add].filter(id=>!plan.remove.includes(id)));
      const expected = new Set([destination.group.variant,...destination.helpers,unrelated]);
      if (destination.id!==destination.group.base) expected.add(destination.id);
      assert.deepEqual(actual,expected);
    }
  }
});

test('demotion cannot drop a member below the first grade or demote an unranked member',()=>{
  assert.throws(()=>planPromotion([],'demote',2),/لا توجد درجة أدنى/);
  assert.throws(()=>planPromotion([ladder[0].id],'demote',2),/لا توجد درجة أدنى/);
  assert.throws(()=>planPromotion([ladder[1].id],'demote',2),/الدرجات المتاحة لهذا العضو: 1/);
});
