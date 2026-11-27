'use strict';

const {createHash}=require('node:crypto');
const {crc32,inflateSync}=require('node:zlib');
const {RateLimitError,Routes}=require('discord.js');

const ACTIONS='name limit privacy waiting trust untrust invite disconnect region block unblock claim transfer delete chat'.split(' ');
const MAX_PNG=256*1024;
const MAX_DIMENSION=128;
const MAX_APPLICATION_EMOJIS=2000;
const PNG_MAGIC=Buffer.from('89504e470d0a1a0a','hex');
const snowflake=value=>typeof value==='string'&&/^[1-9][0-9]{16,19}$/.test(value);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function paeth(left,up,corner) {
  const guess=left+up-corner;
  const a=Math.abs(guess-left),b=Math.abs(guess-up),c=Math.abs(guess-corner);
  return a<=b&&a<=c?left:b<=c?up:corner;
}

// The approved crops are static, 8-bit RGBA PNGs. Validate those exact constraints
// before any write; decode only the bounded alpha scanlines to check transparency.
function transparentPng(bytes) {
  if(bytes.length<45||bytes.length>MAX_PNG||!bytes.subarray(0,8).equals(PNG_MAGIC)) return false;
  let width,height,ended=false;
  const images=[];
  for(let offset=8;offset+12<=bytes.length;) {
    const size=bytes.readUInt32BE(offset),end=offset+12+size;
    if(end>bytes.length||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4)) return false;
    const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
    if(offset===8) {
      if(type!=='IHDR'||size!==13||!data.subarray(8).equals(Buffer.from([8,6,0,0,0]))) return false;
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);
      if(!width||!height||width>MAX_DIMENSION||height>MAX_DIMENSION) return false;
    } else if(type==='IDAT') {
      images.push(data);
    } else if(type==='IEND') {
      if(size!==0||end!==bytes.length) return false;
      ended=true;
      break;
    } else if(!/^[a-z][a-zA-Z]{3}$/.test(type)||['acTL','fcTL','fdAT'].includes(type)) {
      return false;
    }
    offset=end;
  }
  if(!ended||!images.length) return false;
  const stride=width*4+1,total=stride*height;
  let raw;
  try { raw=inflateSync(Buffer.concat(images),{maxOutputLength:total}); } catch { return false; }
  if(raw.length!==total) return false;
  const above=new Uint8Array(width);
  let transparent=false,visible=false;
  for(let row=0;row<raw.length;row+=stride) {
    const filter=raw[row];
    if(filter>4) return false;
    let left=0,corner=0;
    for(let x=0;x<width;x++) {
      const up=above[x];
      const bias=filter===0?0:filter===1?left:filter===2?up:filter===3?(left+up)>>1:paeth(left,up,corner);
      const alpha=(raw[row+x*4+4]+bias)&255;
      transparent ||= alpha<255;
      visible ||= alpha>0;
      above[x]=left=alpha;
      corner=up;
    }
  }
  return transparent&&visible;
}

function approvedAssets(art) {
  if(!art||Object.getPrototypeOf(art)!==Object.prototype||Object.keys(art).length!==ACTIONS.length) {
    throw new TypeError('Invalid temporary voice emoji asset set');
  }
  return ACTIONS.map(action=>{
    const asset=Object.hasOwn(art,action)?art[action]:null;
    const {name,png,sha256:digest}=asset??{};
    if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||name!==`embedvc_${action}_${digest.slice(0,8)}`||
      typeof png!=='string'||png.length>Math.ceil(MAX_PNG/3)*4) {
      throw new TypeError(`Invalid temporary voice emoji asset: ${action}`);
    }
    const bytes=Buffer.from(png,'base64');
    if(bytes.toString('base64')!==png||sha256(bytes)!==digest||!transparentPng(bytes)) {
      throw new TypeError(`Invalid temporary voice emoji PNG: ${action}`);
    }
    return {action,name,digest,size:bytes.length,image:`data:image/png;base64,${png}`};
  });
}

function application(client) {
  const id=client?.user?.id;
  if(!snowflake(id)||client.user.bot!==true||client.application?.id!==id||typeof client.rest?.get!=='function') {
    throw new Error('Invalid temporary voice emoji application');
  }
  return id;
}

function scoped(row,appId) {
  return row&&row.guild_id==null&&row.guildId==null&&
    (row.application_id==null||row.application_id===appId)&&(row.applicationId==null||row.applicationId===appId);
}

function staticEmoji(row,appId) {
  return scoped(row,appId)&&snowflake(row.id)&&row.animated===false&&row.available!==false&&
    row.managed!==true&&(row.roles===undefined||(Array.isArray(row.roles)&&row.roles.length===0));
}

const createdByApp=(row,appId)=>row?.user?.id===appId&&row.user.bot===true;

async function verifyArtwork(asset,id,fetchImage) {
  // Construct the original, untransformed URL from the authenticated inventory
  // ID, not from any URL in Discord data. Never follow CDN redirects.
  const url=`https://cdn.discordapp.com/emojis/${id}.png`;
  try {
    const response=await fetchImage(url,{redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(response?.status!==200||response.redirected||(response.url&&response.url!==url)||!response.body) return false;
    const hash=createHash('sha256');
    let remaining=asset.size;
    for await(const chunk of response.body) {
      if(!(chunk instanceof Uint8Array)||chunk.length>remaining) return false;
      remaining-=chunk.length;
      hash.update(chunk);
    }
    return remaining===0&&hash.digest('hex')===asset.digest;
  } catch { return false; }
}

function exactThrottle(error,route) {
  if(!(error instanceof RateLimitError)||error.method!=='POST') return false;
  try {
    const url=new URL(error.url);
    return url.origin==='https://discord.com'&&url.pathname===`/api/v10${route}`&&
      !url.username&&!url.password&&!url.hash&&!url.search;
  } catch { return false; }
}

function createTempVoiceEmojiProvider({state,getWriter,art=require('./lxr-temp-voice-emoji-art').art,fetchImage=fetch}) {
  const assets=approvedAssets(art);
  if(typeof getWriter!=='function'||typeof fetchImage!=='function'||
    ['getEmojiPublication','reserveEmojiPublication','recordEmojiUpload','bindEmojiArtwork','releaseEmojiPublication']
      .some(op=>typeof state?.[op]!=='function')) {
    throw new TypeError('Invalid temporary voice emoji provider dependencies');
  }
  const expected=new Set(assets.map(asset=>asset.name));
  const pending=new Map();

  async function resolve(client,appId,provision) {
    const route=Routes.applicationEmojis(appId);
    const rest=client.rest;
    function assertScope() {
      if(application(client)!==appId||client.rest!==rest) throw new Error('Temporary voice emoji application changed');
    }
    async function inventory() {
      assertScope();
      const list=await rest.get(route,{auth:true});
      assertScope();
      if(!scoped(list,appId)||!Array.isArray(list.items)||list.items.length>MAX_APPLICATION_EMOJIS) {
        throw new Error('Invalid temporary voice application emoji inventory');
      }
      const found=new Map(),ids=new Set();
      for(const row of list.items) {
        if(!scoped(row,appId)||!snowflake(row.id)||typeof row.name!=='string'||ids.has(row.id)) {
          throw new Error('Invalid temporary voice application emoji inventory');
        }
        ids.add(row.id);
        if(!expected.has(row.name)) continue;
        if(found.has(row.name)||!staticEmoji(row,appId)) throw new Error('Conflicting temporary voice application emoji');
        found.set(row.name,row);
      }
      return {found,ids};
    }
    async function reconcile({found}) {
      const missing=[],verify=[];
      for(const asset of assets) {
        const row=found.get(asset.name),id=row?.id;
        const recorded=state.getEmojiPublication(appId,asset.name,asset.digest);
        if(recorded&&(recorded.sha256!==asset.digest||(recorded.id&&recorded.id!==id)||
          (recorded.proof==='upload'&&!createdByApp(row,appId)))) {
          throw new Error('Temporary voice emoji identity changed');
        }
        if(!id) {
          if(recorded) throw new Error('Temporary voice emoji publication not confirmed');
          missing.push(asset);
        } else if(!recorded?.proof) {
          verify.push([asset,id]);
        }
      }
      // An authenticated name isn't artwork evidence. For lost receipts or
      // pre-existing IDs, only an exact CDN PNG digest can bind.
      for(const [asset,id] of verify) {
        if(!provision||!await verifyArtwork(asset,id,fetchImage)) throw new Error('Temporary voice emoji artwork not verified');
        assertScope();
        if(!state.bindEmojiArtwork(appId,asset.name,asset.digest,id)) throw new Error('Temporary voice emoji identity changed');
      }
      return missing;
    }

    let snapshot=await inventory(),missing=await reconcile(snapshot),writer;
    if(!provision&&missing.length) throw new Error('Temporary voice emoji publication not confirmed');
    while(missing.length) {
      const asset=missing[0];
      writer??=await getWriter();
      if(typeof writer?.post!=='function') throw new Error('Temporary voice emoji writer unavailable');
      assertScope();
      const {name,digest,image}=asset;
      const attempt=state.reserveEmojiPublication(appId,name,digest);
      if(attempt) {
        let posted,acknowledged=false;
        try {
          posted=await writer.post(route,{auth:true,body:{name,image}});
          acknowledged=true;
        } catch(error) {
          // This writer does not retry. Only a known refusal of this exact POST
          // may clear the exact attempt; a failed GET never authorizes a replay.
          if(exactThrottle(error,route)) {
            state.releaseEmojiPublication(appId,name,digest,attempt);
            throw new Error('Temporary voice emoji publication was rate limited');
          }
        }
        assertScope();
        if(acknowledged) {
          // Pin the exact upload receipt before GET. A later authenticated list
          // must agree, but unrelated CDN re-encoding is not an identity change.
          if(!staticEmoji(posted,appId)||posted.name!==name||!createdByApp(posted,appId)||snapshot.ids.has(posted.id)||
            !state.recordEmojiUpload(appId,name,digest,posted.id,attempt)) {
            throw new Error('Invalid temporary voice emoji publication receipt');
          }
        }
      }
      // Lost responses and competing reservations only reconcile; never retry.
      snapshot=await inventory();
      if(!snapshot.found.has(name)) throw new Error('Temporary voice emoji publication not confirmed');
      missing=await reconcile(snapshot);
    }
    return Object.fromEntries(assets.map(({action,name})=>[action,{id:snapshot.found.get(name).id,name}]));
  }

  const provision=async guild=>{
    const client=guild?.client,appId=application(client);
    const rest=client.rest;
    let active;
    while((active=pending.get(appId))) {
      if(active.client===client&&active.rest===rest) return active.task;
      // Serialize alternate clients of the same application without accepting
      // another client's inventory as proof of this caller's authenticated scope.
      await active.task.catch(()=>{});
      if(application(client)!==appId||client.rest!==rest) throw new Error('Temporary voice emoji application changed');
    }
    const task=resolve(client,appId,true).finally(()=>pending.delete(appId));
    pending.set(appId,{client,rest,task});
    return task;
  };
  provision.resolve=async guild=>resolve(guild?.client,application(guild?.client),false);
  return provision;
}

module.exports={createTempVoiceEmojiProvider};
