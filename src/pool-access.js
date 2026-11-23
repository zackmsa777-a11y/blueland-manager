'use strict';
const {randomBytes}=require('node:crypto');
const {PoolError}=require('./pool-match');
const token=()=>randomBytes(32).toString('hex');
const snow=/^\d{17,20}$/;
const base='https://discord.com/api/v10';
function discordPoolIdentity({app,secret,fetcher=fetch}){
  return async code=>{
    const key=secret();if(!key)throw new PoolError('8 Ball is not available yet.',503);
    const request={signal:AbortSignal.timeout(7000),redirect:'error'};
    const response=await fetcher(`${base}/oauth2/token`,{...request,method:'POST',body:new URLSearchParams({client_id:app,client_secret:key,grant_type:'authorization_code',code})});
    if(!response.ok)throw new PoolError('Discord authorization failed.',401);
    const {access_token:accessToken}=await response.json();
    if(typeof accessToken!=='string')throw new PoolError('Discord authorization failed.',401);
    const identity=await fetcher(`${base}/users/@me`,{...request,headers:{Authorization:`Bearer ${accessToken}`}});
    if(!identity.ok)throw new PoolError('Could not verify Discord identity.',401);
    const user=await identity.json();
    return {id:user.id,token:accessToken};
  };
}
function createPoolAccess({app,guild,pool,voice,enabled,identity,instanceInfo,now=Date.now}){
 const pending=new Map(),sessions=new Map(),seatTokens=new Map();
 let exchanges=0;
 const shouldEnable=()=>{if(!enabled())throw new PoolError('8 Ball is not available yet.',503);};
 function remove(s,id){sessions.delete(id);const seat=`${s.match.id}:${s.actor}`;if(seatTokens.get(seat)===id)seatTokens.delete(seat);}
 function sweep(){const t=now();for(const [id,p] of pending)if(t>=p.expires)pending.delete(id);for(const [id,s] of sessions)if(t>=s.expires||!pool.get(s.match.id))remove(s,id);}
 async function exchange(code){
   shouldEnable();sweep();
   if(typeof code!=='string'||!/^[-\w.]{10,256}$/.test(code))throw new PoolError('Invalid authorization code.',400);
   if(exchanges>=12||pending.size>=100)throw new PoolError('Try again shortly.',429);
   exchanges++;
   try{
    const account=await identity(code);if(!snow.test(account.id))throw new PoolError('Could not verify Discord identity.',401);
    const pass=token();pending.set(pass,{actor:account.id,expires:now()+45_000});return {access_token:account.token,pass};
   }finally{exchanges--;}
 }
 async function join(pass,instance){
   shouldEnable();sweep();const entry=pending.get(pass);
   if(!entry||entry.joining)throw new PoolError('Authorization expired. Open the table again.',401);
   if(typeof instance!=='string'||!/^[-\w]{1,160}$/.test(instance))throw new PoolError('Invalid Activity instance.',400);
   entry.joining=true;
   try{
    const actual=await instanceInfo(instance).catch(()=>null);
    if(!actual||actual.application_id!==app||actual.instance_id!==instance||!actual.users?.includes(entry.actor))throw new PoolError('Your account is not in this Activity yet. Try Open Table again.',403);
    const channel=voice(entry.actor);
    if(!channel||actual.location?.guild_id!==guild||actual.location?.channel_id!==channel)throw new PoolError('Open the table from the same voice channel.',403);
    const match=pool.join(entry.actor,channel,instance);
    pending.delete(pass);
    const seat=`${match.id}:${entry.actor}`, old=seatTokens.get(seat), id=token();
    if(old&&sessions.has(old))remove(sessions.get(old),old);
    sessions.set(id,{actor:entry.actor,match,instance,expires:now()+600_000});seatTokens.set(seat,id);
    return {session:id,state:pool.snapshot(match,entry.actor)};
   }finally{entry.joining=false;}
 }
 function session(id){
   shouldEnable();const s=/^[a-f0-9]{64}$/.test(id||'')?sessions.get(id):null;
   if(!s||s.expires<=now()||!pool.get(s.match.id)){if(s)remove(s,id);throw new PoolError('Game session expired. Open the table again.',401);}
   if(voice(s.actor)!==s.match.voice)throw new PoolError('Return to the match voice channel.',403);
   s.expires=now()+600_000;return s;
 }
 return {exchange,join,session,sweep};
}
module.exports={createPoolAccess,discordPoolIdentity};
