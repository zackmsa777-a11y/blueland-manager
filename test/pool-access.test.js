'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPoolAccess}=require('../src/pool-access');
const {createPoolMatchmaker}=require('../src/pool-match');
const a='200000000000000001',b='200000000000000002',other='200000000000000003',app='200000000000000004',guild='200000000000000005',room='200000000000000006',instance='i-123-gc-456';
const make=()=>{
 const pool=createPoolMatchmaker(), m=pool.challenge({id:'id',from:a,to:b,guild,text:'ch'});pool.decision(m.id,b,'accept');pool.open(m.id,a,room);pool.open(m.id,b,room);
 const inVoice=new Map([[a,room],[b,room],[other,room]]);
 let parties=[a,b,other],actualRoom=room;
 const access=createPoolAccess({app,guild,pool,voice:id=>inVoice.get(id),enabled:()=>true,
  identity:async code=>({id:code,token:'synthetic-'+code}),instanceInfo:async id=>({application_id:app,instance_id:id,location:{guild_id:guild,channel_id:actualRoom},users:parties})});
 const exchange=id=>access.exchange(id);
 return {pool,access,exchange,inVoice,m,parties:p=>{parties=p;},room:id=>{actualRoom=id;}};
};
test('the host voice and Discord instance are checked, identity is from OAuth, and a guest has no seat',async()=>{
 const f=make();let h=await f.exchange(a);assert.ok(h.pass);assert.throws(()=>f.access.session('bogus'),/expired/);
 f.parties([b]);await assert.rejects(()=>f.access.join(h.pass,instance),/not in/i);f.parties([a,b,other]);
 f.room('wrong');await assert.rejects(()=>f.access.join(h.pass,instance),/same voice/i);f.room(room);
 const out=await f.access.join(h.pass,instance);await assert.rejects(()=>f.access.join(h.pass,instance),/expired/);assert.equal(f.access.session(out.session).actor,a);assert.equal(out.state.phase,'accepted');
 const guest=await f.exchange(other);await assert.rejects(()=>f.access.join(guest.pass,instance),/seat/i);
 const hb=await f.exchange(b);const seat=await f.access.join(hb.pass,instance);assert.equal(seat.state.phase,'playing');
 f.inVoice.delete(a);assert.throws(()=>f.access.session(out.session),/voice/i);
});
