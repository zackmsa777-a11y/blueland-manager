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
  assert.equal(parseChat('+تخفيض <@'+actor+'>').action,'demote');
  assert.throws(()=>parseChat('+تخفيض <@'+actor+'> everything'));
});
