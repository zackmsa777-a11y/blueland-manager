'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPoolMatchmaker}=require('../src/pool-match');
const alice='200000000000000001', bob='200000000000000002', eve='200000000000000003', voice='200000000000000004';
const make=()=>{let now=500_000;const events=[];const pool=createPoolMatchmaker({now:()=>now,changed:m=>events.push([m.phase,m.game?.winner])});return {pool,events,advance:t=>{now+=t;pool.tick();}};};
function accepted(pool){const m=pool.challenge({id:'invite-a',from:alice,to:bob,guild:'g',text:'ch'});pool.decision(m.id,bob,'accept');return m;}
function play(pool){const m=accepted(pool);for(const who of [alice,bob])pool.open(m.id,who,voice);pool.join(alice,voice,'instance-1');pool.join(bob,voice,'instance-1');return m;}

test('only the invited opponent can accept, and both players must open from the same voice room and join one Activity',()=>{
 const {pool}=make();const m=pool.challenge({id:'invite-a',from:alice,to:bob,guild:'g',text:'ch'});
 assert.throws(()=>pool.decision(m.id,eve,'accept'),/invited/i);assert.throws(()=>pool.decision(m.id,alice,'accept'),/invited/i);
 pool.decision(m.id,bob,'accept');assert.throws(()=>pool.open(m.id,alice,null),/voice/i);pool.open(m.id,alice,voice);
 assert.throws(()=>pool.open(m.id,bob,'other'),/same voice/i);assert.throws(()=>pool.join(eve,voice,'i1'),/seat/i);
 pool.join(alice,voice,'i1');assert.equal(m.phase,'accepted');pool.open(m.id,bob,voice);
 assert.throws(()=>pool.join(bob,voice,'i2'),/same Activity/i);pool.join(bob,voice,'i1');assert.equal(m.phase,'playing');assert.equal(m.game.turn,0);
});
test('only the current seat can shoot, one revision is committed, and physical frames are shared',()=>{
 const {pool,advance}=make();const m=play(pool);
 assert.throws(()=>pool.act(m,bob,'i1',{type:'shot',angle:0,power:1,rev:0}),/session/i);
 assert.throws(()=>pool.act(m,bob,'instance-1',{type:'shot',angle:0,power:1,rev:0}),/turn/i);
 assert.throws(()=>pool.act(m,alice,'instance-1',{type:'shot',angle:0,power:2,rev:0}),/shot/i);
 pool.act(m,alice,'instance-1',{type:'shot',angle:0,power:1,rev:0});
 assert.throws(()=>pool.act(m,alice,'instance-1',{type:'shot',angle:0,power:1,rev:0}),/table changed/i);
 const still=pool.snapshot(m,alice).balls[0].x;
 for(let i=0;i<300&&m.game.shot;i++){advance(25);if(i===2){assert.notEqual(pool.snapshot(m,alice).balls[0].x,still);assert.deepEqual(pool.snapshot(m,alice).balls,pool.snapshot(m,bob).balls);}}
 assert.equal(m.game.stats[0].shots,1);assert.equal(m.game.shot,null);assert.ok(m.rev>=2);
});
test('pending challenges expire; a legal black finishes once and reports the correct member',()=>{
 const {pool,events,advance}=make();const late=pool.challenge({id:'late',from:alice,to:eve,guild:'g',text:'ch'});
 advance(300_001);assert.equal(late.phase,'expired');assert.throws(()=>pool.decision(late.id,eve,'accept'),/closed/i);
 const m=play(pool);const g=m.game;g.groups=[1,2];g.breaking=false;for(const b of g.balls)b.out=b.n!==0&&b.n!==8;
 Object.assign(g.cue,{x:480,y:125});Object.assign(g.balls.find(b=>b.n===8),{x:480,y:55});
 pool.act(m,alice,'instance-1',{type:'shot',angle:-Math.PI/2,power:.25,call:1,rev:0});
 for(let i=0;i<100&&m.phase==='playing';i++)advance(25);
 assert.equal(pool.snapshot(m,alice).winner,alice);advance(500);assert.equal(events.filter(([p])=>p==='done').length,1);
});
