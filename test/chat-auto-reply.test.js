'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {catalog} = require('../src/ladder');
const {createMessageHandler} = require('../src/chat');

const actor = '1486306919324057682';
const link = 'https://cdn.discordapp.com/attachments/1570801907671244878/1574071721500082248/no-background.png?ex=6b04f8c7&is=6b03a747&hm=ac425ef186a10a54e8eaf3e4c0bfe7542a261def08af3090e45c98cf83972a98&';

test('the dash replies with the exact configured URL only for its author in BlueLand', async () => {
  const replies = [];
  const passedToShortcuts = [];
  const onMessage = createMessageHandler({store:{}, shortcuts:async (_,text) => {passedToShortcuts.push(text); return false;}});
  const send = (extra = {}) => onMessage({author:{id:actor}, guildId:catalog.guildId, inGuild:()=>true,
    content:'-', async reply(payload){replies.push(payload);}, ...extra});
  await send();
  await send({author:{id:'1486306919324057683'}});
  await send({guildId:'200000000000000001'});
  await send({inGuild:()=>false});
  await send({author:{id:actor,bot:true}});
  await send({webhookId:'200000000000000001'});
  for (const content of ['--','- شيء','شيء -','—']) await send({content});
  assert.deepEqual(replies,[{content:link,allowedMentions:{parse:[],repliedUser:false}}]);
  assert.deepEqual(passedToShortcuts,['-','--','- شيء','شيء -','—']);
});
