'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {catalog} = require('../src/ladder');
const {createMessageHandler} = require('../src/chat');

const actor = '1486306919324057682';
const link = 'https://cdn.discordapp.com/attachments/1570801907671244878/1574071721500082248/no-background.png?ex=6b04f8c7&is=6b03a747&hm=ac425ef186a10a54e8eaf3e4c0bfe7542a261def08af3090e45c98cf83972a98&';

function fixture({failSend = false, failVerify = false, failDelete = false} = {}) {
  const calls = [], passedToShortcuts = [];
  const botPost = {id:'200000000000000002'};
  const onMessage = createMessageHandler({store:{}, shortcuts:async (_,text) => {passedToShortcuts.push(text); return false;}});
  const send = (extra = {}) => onMessage({author:{id:actor}, guildId:catalog.guildId, inGuild:()=>true,
    content:'-', async reply(payload){calls.push(['reply',payload]);},
    channel:{
      async send(payload){calls.push(['send',payload]); if(failSend) throw new Error('send'); return botPost;},
      messages:{async fetch(options){calls.push(['verify',options]); if(failVerify) throw new Error('verify'); return botPost;}}
    },
    async delete(){calls.push(['delete-trigger']); if(failDelete) throw new Error('delete');}, ...extra});
  return {calls,passedToShortcuts,send};
}

const postAndVerify = [
  ['send',{content:link,allowedMentions:{parse:[]}}],
  ['verify',{message:'200000000000000002',force:true,cache:false}]
];

test('a standalone dash sends and cleans up only for the two approved accounts', async () => {
  const {calls,passedToShortcuts,send} = fixture();
  await send();
  await send({author:{id:'1235369589408399392'}});
  await send({author:{id:'1486306919324057683'}});
  await send({guildId:'200000000000000001'});
  await send({inGuild:()=>false});
  await send({author:{id:actor,bot:true}});
  await send({webhookId:'200000000000000001'});
  await send({attachments:new Map([['image',{}]])});
  await send({stickers:new Map([['sticker',{}]])});
  for (const content of ['--','- شيء','شيء -','—']) await send({content});
  const expected = [...postAndVerify,['delete-trigger']];
  assert.deepEqual(calls,[...expected,...expected]);
  assert.deepEqual(passedToShortcuts,['-','-','-','--','- شيء','شيء -','—']);
});

test('failed sends or verification keep the trigger; failed deletion never removes the link', async t => {
  t.mock.method(console,'warn',()=>{});
  const sendFailure=fixture({failSend:true});
  await sendFailure.send();
  assert.deepEqual(sendFailure.calls,[postAndVerify[0]]);
  const verifyFailure=fixture({failVerify:true});
  await verifyFailure.send();
  assert.deepEqual(verifyFailure.calls,postAndVerify);
  const deleteFailure=fixture({failDelete:true});
  await deleteFailure.send();
  assert.deepEqual(deleteFailure.calls,[...postAndVerify,['delete-trigger']]);
});
