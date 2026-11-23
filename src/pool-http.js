'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {PoolError}=require('./pool-match');
const prefix='/activity/pool';
const assets=new Map([['/','pool.html'],['/pool-client.js','pool-client.js'],['/pool-sdk.js','pool-sdk.js'],['/pool.css','pool.css']]);
const files={ 'pool.html':'text/html; charset=utf-8','pool-client.js':'text/javascript; charset=utf-8','pool-sdk.js':'text/javascript; charset=utf-8','pool.css':'text/css; charset=utf-8' };
const framePolicy="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors https://discord.com https://*.discord.com; form-action 'none'";
function poolHttp({access,pool,origin,publicDirectory}){
 return async (req,res,route,{json,body})=>{
   if(route!==prefix&&!route.startsWith(prefix+'/'))return false;
   try{
    const sub=route.slice(prefix.length);
    if(!sub&&['GET','HEAD'].includes(req.method)){res.writeHead(308,{Location:`${prefix}/`});res.end();return true;}
    if(assets.has(sub)&&['GET','HEAD'].includes(req.method)){
      const name=assets.get(sub),bytes=await fs.readFile(path.join(publicDirectory,name));
      res.setHeader('Content-Security-Policy',framePolicy);res.writeHead(200,{'Content-Type':files[name],'Cache-Control':'no-cache'});
      res.end(req.method==='HEAD'?undefined:bytes);return true;
    }
    if(req.method==='POST'&&req.headers.origin!==origin)throw new PoolError('Open the game in Discord.',403);
    if(req.method==='POST'&&sub==='/auth'){json(await access.exchange((await body(req)).code));return true;}
    if(req.method==='POST'&&sub==='/join'){const input=await body(req);json(await access.join(input.pass,input.instance));return true;}
    if((req.method==='GET'&&sub==='/state')||(req.method==='POST'&&sub==='/turn')){
      const session=access.session(/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1]);
      json(req.method==='GET'?pool.snapshot(session.match,session.actor):pool.act(session.match,session.actor,session.instance,await body(req)));
      return true;
    }
    throw new PoolError('Not found.',404);
   }catch(err){
    if(!res.headersSent)json({error:err instanceof PoolError?err.message:(err.code==='ENOENT'?'8 Ball is not available yet.':'Could not complete this game request.')},err instanceof PoolError?err.status:err.code==='ENOENT'?404:err.status||502);
    return true;
   }
 };
}
module.exports={poolHttp};
