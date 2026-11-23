'use strict';
const assert=require('node:assert/strict');
const {once}=require('node:events');
const http=require('node:http');
const test=require('node:test');
const {createApp}=require('../src/server');
const appId='1573988210185347223';
const botHost='bot.najdhorizonco.shop';
const gameHost='games.najdhorizonco.shop';
const activityOrigin=`https://${appId}.discordsays.com`;

async function fixture(t,enabled=true) {
  const codes=[];
  const poolActivity=enabled?{appId,access:{async exchange(code){codes.push(code);return {pass:'synthetic-session-pass'};}}}:undefined;
  const server=createApp({store:{actor:()=>null},discord:{poolActivity},publicOrigin:`https://${botHost}`});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(path,{host=gameHost,method='GET',headers={},data}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,headers:{...headers,Host:host}},res=>{
      res.setEncoding('utf8'); let text=''; res.on('data',chunk=>{text+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text})); res.on('error',reject);
    });
    req.on('error',reject); req.end(data===undefined?undefined:JSON.stringify(data));
  });
  return {request,codes};
}

test('the games hostname serves the embedded 8 Ball entry and its same-origin scripts from the root',async t=>{
  const {request}=await fixture(t);
  const home=await request('/?frame_id=synthetic');
  assert.equal(home.status,200);
  assert.match(home.text,/data-blueland-activity="8ball"/);
  assert.match(home.headers['content-security-policy'],/frame-ancestors https:\/\/discord\.com/);
  const script=await request('/pool-sdk.js');
  assert.equal(script.status,200);
  assert.match(script.text,/PoolDiscordSDK/);
  assert.equal((await request('/pool.css',{method:'HEAD'})).status,200);
});

test('the games hostname keeps game authentication bound to the Discord activity origin',async t=>{
  const {request,codes}=await fixture(t);
  const auth=origin=>request('/auth',{method:'POST',headers:{'content-type':'application/json',origin},data:{code:'synthetic'}});
  assert.equal((await auth(`https://${gameHost}`)).status,403);
  assert.deepEqual(codes,[]);
  const verified=await auth(activityOrigin);
  assert.equal(verified.status,200);
  assert.deepEqual(codes,['synthetic']);
  assert.deepEqual(JSON.parse(verified.text),{pass:'synthetic-session-pass'});
  assert.equal(verified.headers['set-cookie'],undefined);
});

test('dashboard routes stay on the dashboard hostname and games fails closed when disabled',async t=>{
  const {request}=await fixture(t);
  assert.equal((await request('/api/status')).status,404);
  assert.equal((await request('/index.html')).status,404);
  assert.equal((await request('//bot.najdhorizonco.shop/')).status,403);
  const dashboard=await request('/',{host:botHost});
  assert.equal(dashboard.status,200);
  assert.doesNotMatch(dashboard.text,/data-blueland-activity="8ball"/);
  assert.match(dashboard.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal((await request('/',{host:'other.test',headers:{'x-forwarded-host':gameHost}})).status,403);
  const disabled=await fixture(t,false);
  assert.equal((await disabled.request('/')).status,503);
});
