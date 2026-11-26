'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {catalog} = require('../src/ladder');
const {createMessageHandler} = require('../src/chat');
const {createDashImageLoader} = require('../src/dash-image');
const {MessagePayload,Routes} = require('discord.js');
const {autoReply:{image}} = require('../config/discord-features.json');

const actor = '1486306919324057682';
const memberId='1486306919324057683', roleId='1574012917131776112';
const name='5612A614-3B0F-445B-8856-724E1D88AC04.png', bytes=Buffer.from([137,80,78,71]);

function fixture({failSend = false, failVerify = false, missingAsset = false, failDelete = false} = {}) {
  const calls = [], passedToShortcuts = [];
  const botPost = {id:'200000000000000002',attachments:new Map(missingAsset?[]:[['asset',{name,size:bytes.length}]])};
  const onMessage = createMessageHandler({store:{},loadDashImage:async()=>({attachment:bytes,name}),
    shortcuts:async (_,text) => {passedToShortcuts.push(text); return false;}});
  const send = (extra = {}) => onMessage({author:{id:actor}, guildId:catalog.guildId, inGuild:()=>true,
    content:'-', async reply(payload){calls.push(['reply',payload]);},
    channel:{
      async send(payload){calls.push(['send',payload.files?{...payload,files:payload.files.map(file=>({size:file.attachment.length,name:file.name,matches:file.attachment.equals(bytes)}))}:payload]); if(failSend) throw new Error('send'); return botPost;},
      messages:{async fetch(options){calls.push(['verify',options]); if(failVerify) throw new Error('verify'); return botPost;}}
    },
    async delete(){calls.push(['delete-trigger']); if(failDelete) throw new Error('delete');}, ...extra});
  return {calls,passedToShortcuts,send};
}

const postAndVerify = [
  ['send',{files:[{size:bytes.length,name,matches:true}],allowedMentions:{parse:[]}}],
  ['verify',{message:'200000000000000002',force:true,cache:false}]
];

test('a standalone dash posts the image for the approved accounts and a current holder of the exact role', async () => {
  const {calls,passedToShortcuts,send} = fixture();
  await send();
  await send({author:{id:'1235369589408399392'}});
  let roles=[roleId];
  const guild={members:{async fetch(options){assert.deepEqual(options,{user:memberId,force:true,cache:false});return {roles:{cache:new Set(roles)}};}}};
  await send({author:{id:memberId},guild});
  roles=[];
  await send({author:{id:memberId},guild,member:{roles:{cache:new Set([roleId])}}});
  await send({guildId:'200000000000000001'});
  await send({inGuild:()=>false});
  await send({author:{id:actor,bot:true}});
  await send({webhookId:'200000000000000001'});
  await send({attachments:new Map([['image',{}]])});
  await send({stickers:new Map([['sticker',{}]])});
  for (const content of ['--','- شيء','شيء -','—']) await send({content});
  const expected = [...postAndVerify,['delete-trigger']];
  assert.deepEqual(calls,[...expected,...expected,...expected]);
  assert.deepEqual(passedToShortcuts,['-','-','-','--','- شيء','شيء -','—']);
});

test('failed sends or verification keep the trigger; failed deletion never removes the image', async t => {
  t.mock.method(console,'warn',()=>{});
  const sendFailure=fixture({failSend:true});
  await sendFailure.send();
  assert.deepEqual(sendFailure.calls,[postAndVerify[0]]);
  const verifyFailure=fixture({failVerify:true});
  await verifyFailure.send();
  assert.deepEqual(verifyFailure.calls,postAndVerify);
  const missingImage=fixture({missingAsset:true});
  await missingImage.send();
  assert.deepEqual(missingImage.calls,postAndVerify);
  const deleteFailure=fixture({failDelete:true});
  await deleteFailure.send();
  assert.deepEqual(deleteFailure.calls,[...postAndVerify,['delete-trigger']]);
});

test('the divider loader rejects a foreign URL before fetching and retries a failed load',async()=>{
  const attachment={id:image.attachmentId,filename:name,size:image.size,url:'https://example.org/wrong.png'};
  let reads=0, downloads=0;
  const client={rest:{async get(route){
    reads++;
    assert.equal(route,Routes.channelMessage(image.channelId,image.messageId));
    return {id:image.messageId,author:{id:image.authorId},attachments:[attachment]};
  }}};
  const load=createDashImageLoader(async()=>{downloads++;return new Response(bytes);});
  await assert.rejects(load(client),/URL invalid/u);
  assert.equal(downloads,0);
  attachment.url=`https://cdn.discordapp.com/attachments/${image.channelId}/${image.attachmentId}/${name}`;
  const first=load(client);
  assert.equal(load(client),first);
  await assert.rejects(first,/integrity check failed/u);
  assert.equal(reads,2);
  assert.equal(downloads,1);
});

test('the Discord SDK serializes the divider as an attachment',async()=>{
  const target={client:{options:{}}};
  const payload=await MessagePayload.create(target,{files:[{attachment:bytes,name}],allowedMentions:{parse:[]}}).resolveBody().resolveFiles();
  assert.equal(payload.body.content,undefined);
  assert.equal(payload.files[0].name,name);
  assert.equal(payload.files[0].data.equals(bytes),true);
});
