'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {catalog} = require('../src/ladder');
const {openStore} = require('../src/store');
const {createMessageHandler} = require('../src/chat');
const {createShortcutHandler} = require('../src/shortcut-dispatch');
const {createDiscordGames} = require('../src/discord-games');
const {parseLobbyDuration} = require('../src/roulette-lobby');

const room = '200000000000000001';
const host = '200000000000000002';
const guest = '200000000000000003';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const store = openStore(':memory:');
  const games = createDiscordGames(store.roulette);
  t.after(() => {games.removeRoom(room); store.close();});
  let now = 5000;
  const timers = new Set();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setTimeout', (run, delay) => {
    const token = {run, at: now + delay, unref() {return this;}};
    timers.add(token);
    return token;
  });
  t.mock.method(global, 'clearTimeout', token => timers.delete(token));
  const replies = [], edits = [], rounds = [];
  const channel = {async send(payload) {
    const message = makePanel(`round-${rounds.length + 1}`);
    message.payload=payload;
    rounds.push(message);
    return message;
  }};
  function makePanel(id) {
    return {id, channel, async edit(payload) {this.payload = {...this.payload, ...payload}; edits.push(payload); return this;}};
  }
  const panel = makePanel('game');
  const shortcuts = createShortcutHandler({shortcuts:store.shortcuts,games});
  const onMessage = createMessageHandler({store,shortcuts});
  const send = content => onMessage({content,author:{id:host,username:'Host'},inGuild:()=>true,guildId:catalog.guildId,channelId:room,
    async reply(payload) {replies.push(payload); panel.payload=payload; return panel;}});
  async function tick(ms, runTimers = true) {
    now += ms;
    if (runTimers) for (const timer of [...timers]) if (timer.at <= now) {timers.delete(timer); timer.run();}
    await flush();
  }
  async function join() {
    let reply;
    const customId=panel.payload.components[0].components[0].custom_id;
    await games.handle({customId,channelId:room,message:panel,user:{id:guest,username:'Guest'},isButton:()=>true,
      isChatInputCommand:()=>false,isStringSelectMenu:()=>false,async deferUpdate(){},async reply(payload){reply=payload;}});
    await flush();
    return reply?.content;
  }
  return {panel,replies,edits,rounds,send,tick,join,timers};
}

test('default roulette registration counts down for one minute and starts once even if a click beats the timer',async t=>{
  const f=fixture(t);
  await f.send('.روليت');
  assert.match(f.panel.payload.content,/01:00/);
  await f.tick(5000);
  assert.match(f.panel.payload.content,/00:55/);
  await f.join();
  assert.match(f.panel.payload.content,/\(2 \/ 160\)/);
  assert.match(f.panel.payload.content,/00:55/);
  await f.tick(54_000);
  assert.match(f.panel.payload.content,/00:01/);
  await f.tick(1000,false);
  assert.match(await f.join(),/انتهت مهلة التسجيل/);
  assert.match(f.panel.payload.content,/انتهى التسجيل وبدأت الروليت/);
  assert.deepEqual(f.panel.payload.components,[]);
  assert.equal(f.rounds.length,1);
  assert.match(f.rounds[0].payload.content,/الجولة 1 · 2 في اللعب/);
  assert.equal(f.rounds[0].payload.files[0].name,'roulette-spin.gif');
  await f.tick(1);
  assert.equal(f.rounds.length,1);
});

test('a ten-minute chat duration refreshes the same attached lobby and starts at its original deadline',async t=>{
  const f=fixture(t);
  await f.send('.روليت 10m');
  const image=f.panel.payload.files[0];
  assert.match(f.panel.payload.content,/10:00/);
  await f.tick(10_000);
  assert.match(f.panel.payload.content,/09:50/);
  await f.join();
  assert.equal(f.panel.payload.files[0],image);
  assert.ok(f.edits.every(edit=>!edit.files && !edit.attachments));
  assert.equal(f.replies.length,1);
  await f.tick(590_000);
  assert.equal(f.rounds.length,1);
  assert.match(f.panel.payload.content,/انتهى التسجيل وبدأت الروليت/);
  assert.doesNotMatch(f.panel.payload.content,/00:00|09:50/);
  await f.tick(2000);
  assert.equal(f.rounds.length,2);
  assert.equal(f.rounds[1].payload.files[0].name,'roulette.png');
});

test('roulette only closes at the deadline if it does not have two players',async t=>{
  const f=fixture(t);
  await f.send('.روليت');
  await f.tick(60_000);
  assert.match(f.panel.payload.content,/تحتاج لاعبين على الأقل/);
  assert.deepEqual(f.panel.payload.components,[]);
  assert.equal(f.rounds.length,0);
  assert.equal(f.timers.size,0);
});

test('invalid lobby duration is rejected and other games do not consume a time argument',async t=>{
  const f=fixture(t);
  for (const value of ['0m','31m','-5m','5s','10h','10m كلام']) {
    await f.send(`.روليت ${value}`);
    assert.match(f.replies.at(-1).content,/10 ثوانٍ إلى 30 دقيقة/);
  }
  await f.send('.مافيا 10m');
  assert.equal(f.replies.length,6);
  assert.equal(f.timers.size,0);
  assert.equal(parseLobbyDuration('30s'),30_000);
  assert.equal(parseLobbyDuration('10m'),600_000);
});
