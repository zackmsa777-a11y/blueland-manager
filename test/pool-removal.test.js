'use strict';
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {request}=require('node:http');
const test=require('node:test');
const {createApp}=require('../src/server');
const {connectDiscord}=require('../src/discord');
const {openStore}=require('../src/store');

const bot='bot.najdhorizonco.shop', games='games.najdhorizonco.shop';
function app(t) {
  const store=openStore(':memory:');
  const dashboard=`https://${bot}`;
  const discord=connectDiscord(store,{PUBLIC_ORIGIN:dashboard,BLUELAND_POOL_ENABLED:'1',DISCORD_CLIENT_SECRET:'synthetic'});
  const server=createApp({store,discord,publicOrigin:dashboard});
  t.after(async()=>{if(server.listening) await new Promise(done=>server.close(done));discord.close();store.close();});
  return {discord,server};
}

test('8 Ball is not wired to Discord even with old activation settings',t=>{
  const {discord}=app(t);
  assert.equal(Object.hasOwn(discord,'poolActivity'),false);
});

test('retired game hostname and pool URLs never serve the game or redirect to the dashboard',async t=>{
  const {server}=app(t);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const get=(host,path)=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,headers:{host}},res=>{
      res.setEncoding('utf8'); let body=''; res.on('data',x=>{body+=x;});
      res.on('end',()=>resolve({status:res.statusCode,body,location:res.headers.location})); res.on('error',reject);
    });
    req.on('error',reject);req.end();
  });
  for(const route of ['/','/state','/pool-client.js','/pool-sdk.js','/pool.css']) {
    const out=await get(games,route);
    assert.equal(out.status,403,route);
    assert.equal(out.location,undefined);
  }
  for(const route of ['/activity/pool/','/pool.html','/pool-client.js','/pool-sdk.js','/pool.css']) {
    assert.equal((await get(bot,route)).status,404,route);
  }
  const dashboard=await get(bot,'/');
  assert.equal(dashboard.status,200);
  assert.match(dashboard.body,/<title>الترقيات/u);
});
