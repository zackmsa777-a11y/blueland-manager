'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {catalog} = require('../src/ladder');
const {createMessageHandler} = require('../src/chat');

const id = '1486306919324057682';
const roleId = '1574013532586909736';
const content = [
  '**يرجى وضع الشعار او التاق والرابط ليتم قبولك بشكل رسمي.',
  '- الشعار : ',
  '`Name` ᴸˣᴿ',
  '`Name`‏ᴸˣ',
  'LXR `Name`',
  '- التاق : ',
  'لسا مافي',
  '',
  '- الرابط :',
  'لسا مافي اختصار استخدم رابط خاص',
  '',
  'بعد اخذ الرولات يرجى النظر في: https://discord.com/channels/1573975432838127708/1574014273951371284',
  'اي استفسرات اخرى تقدر تسأل المسؤول __الي قبل تقديمك__',
  '**'
].join('\n');

test('+مقبول posts the exact text only for the member with the required live role',async()=>{
  const posted=[], fetches=[];
  let currentRoles=[roleId], offline=false;
  const handler=createMessageHandler({store:{},run:async()=>assert.fail('unexpected command dispatch'),parse:()=>null});
  const invoke=(overrides={})=>handler({
    content:'+مقبول',author:{id},inGuild:()=>true,guildId:catalog.guildId,
    member:{roles:{cache:new Set([roleId])}}, // Simulate a stale cache after a role is removed.
    guild:{members:{async fetch(options){fetches.push(options); if(offline) throw new Error('offline'); return {roles:{cache:new Set(currentRoles)}};}}},
    channel:{async send(payload){posted.push(payload);}},
    async reply(){assert.fail('must not send a reply');},async delete(){assert.fail('must not delete the trigger');},
    ...overrides
  });
  await invoke();
  currentRoles=['1574013532586909737']; await invoke();
  offline=true; await invoke();
  await invoke({inGuild:()=>false});
  await invoke({guildId:'200000000000000001'});
  await invoke({webhookId:'200000000000000002'});
  await invoke({author:{id,bot:true}});
  await invoke({content:'+مقبول عضو'});
  assert.deepEqual(fetches,Array.from({length:3},()=>({user:id,force:true,cache:false})));
  assert.deepEqual(posted,[{content,allowedMentions:{parse:[]}}]);
});
