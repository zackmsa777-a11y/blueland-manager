'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {MessageFlags} = require('discord.js');
const {commands} = require('../src/commands');
const {createDiscordGames} = require('../src/discord-games');
const {games} = require('../src/game-rules');

function assertPng(file, kind, size = [820, kind === 'rps' ? 500 : 720]) {
  const data = file.attachment;
  assert.equal(file.name, kind + '.png');
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(data.subarray(12, 16).toString(), 'IHDR');
  assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], size);
  assert.equal(data.subarray(-8, -4).toString(), 'IEND');
}

const host = '100000000000000001';
const guest = '100000000000000002';
const spectator = '100000000000000099';
const flushEdits = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, economy) {
  const timers = new Map();
  t.mock.method(global, 'setTimeout', callback => {
    const timer = {unref() { return this; }};
    timers.set(timer, callback);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));

  const gateway = createDiscordGames(economy);
  const posts = [];
  let message;
  const channel = {async send(payload) { return post(payload); }};
  function post(payload) {
    const next = {id: `game-message-${posts.length + 1}`, channel, payload, writes: [], async edit(edit) {
      this.writes.push(edit);
      this.payload = {...this.payload, ...edit};
      return this;
    }};
    posts.push(next);
    message = next;
    return next;
  }
  const guildEmojis = [
    {id: '100000000000000010', name: 'roulette_join', animated: true, available: true},
    {id: '100000000000000011', name: 'roulette', available: true},
    {id: '100000000000000012', name: 'roulette_cancel', available: false}
  ];
  const guild = {emojis: {async fetch() { return new Map(guildEmojis.map(emoji => [emoji.id, emoji])); }}};

  async function send(user, options) {
    let reply;
    const i = {
      user: {id: user, username: `Player ${user.slice(-2)}`, displayAvatarURL: () => avatar(user)},
      channelId: 'games-room', guild, message,
      ...options,
      isChatInputCommand: () => Boolean(options.commandName),
      isStringSelectMenu: () => Boolean(options.values),
      isButton: () => Boolean(options.customId && !options.values),
      async deferReply() { this.deferred = true; },
      async editReply(payload) {
        if (payload.embeds) assert.equal(payload.embeds[0].image.url, 'attachment://' + payload.files[0].name);
        return post(payload);
      },
      async deferUpdate() {},
      async reply(payload) { reply = payload; },
      async update(payload) { reply = payload; }
    };
    assert.equal(await gateway.handle(i), true);
    await flushEdits();
    return reply;
  }

  function button(action) {
    const control = message.payload.components.flatMap(row => row.components).find(item => item.custom_id.endsWith(`:${action}`));
    assert.ok(control, `Expected a ${action} button`);
    return control;
  }

  async function tick() {
    assert.equal(timers.size, 1);
    const [[timer, callback]] = timers;
    timers.delete(timer);
    callback();
    await flushEdits();
  }

  return {
    open: kind => send(host, {commandName: 'game', options: {getSubcommand: () => kind}}),
    click: (user, action) => send(user, {customId: button(action).custom_id}),
    button, send, tick, timers, posts,
    get panel() { return message.payload; },
    get description() { return message.payload.files[0].description; }
  };
}

test('the four games and roulette economy commands are registered for Discord', () => {
  const command = commands.find(item => (item.toJSON?.() || item).name === 'game');
  assert.ok(command);
  assert.deepEqual((command.toJSON?.() || command).options.map(option => option.name).sort(), ['bag', 'chairs', 'mafia', 'roulette', 'rps', 'shop']);
});

const avatar = id => `https://cdn.discordapp.com/avatars/${id}/test.png`;

function assertSpin(file) {
  assert.equal(file.name, 'roulette-spin.gif');
  const data = file.attachment;
  assert.equal(data.toString('ascii', 0, 6), 'GIF89a');
  let index = 13 + 3 * (2 ** ((data[10] & 7) + 1));
  let frames = 0;
  let firstFrameData;
  while (data[index] === 0x21) {
    assert.deepEqual([...data.subarray(index, index + 4)], [0x21, 0xf9, 4, 9]);
    index += 8;
    assert.equal(data[index], 0x2c);
    assert.equal(data.readUInt16LE(index + 5), 344);
    assert.equal(data.readUInt16LE(index + 7), 344);
    index += 11;
    const imageStart = index;
    while (data[index]) index += 1 + data[index];
    const imageData = data.subarray(imageStart, index);
    if (frames === 0) firstFrameData = imageData;
    if (frames === 17) assert.notDeepEqual(imageData, firstFrameData);
    index++;
    frames++;
  }
  assert.equal(frames, 18);
  assert.equal(index, data.length - 1);
  assert.equal(data[index], 0x3b);
}

test('roulette posts the wheel phases separately, pings only the selected player and crowns the winner', async t => {
  const f = fixture(t);
  await f.open('roulette');
  const [lobby] = f.posts;
  const banner = f.panel.files[0];
  assertPng(banner, 'roulette', [840, 290]);
  assert.equal(f.panel.content.split('\n')[0], `**(1 / ${games.roulette.max})**`);
  assert.deepEqual(f.button('join').emoji, {id: '100000000000000010', name: 'roulette_join', animated: true});
  assert.equal(f.button('cancel').emoji.id, '100000000000000011');
  assert.ok(f.panel.components.flatMap(row => row.components).every(button => button.emoji.id));
  const oldJoin = f.button('join').custom_id;
  await f.click(guest, 'join');
  assert.equal(f.posts.length, 1);
  assert.equal(f.panel.files[0], banner);
  assert.equal(f.panel.content.split('\n')[0], `**(2 / ${games.roulette.max})**`);
  await f.click(host, 'start');
  assert.equal(f.posts.length, 2);
  const spin = f.posts[1];
  const spinCancel = f.button('cancel').custom_id;
  assertSpin(f.panel.files[0]);
  assert.deepEqual(f.panel.allowedMentions, {parse: []});
  assert.deepEqual(lobby.writes.at(-1), {components: []});
  const stale = await f.send(spectator, {customId: oldJoin, message: lobby});
  assert.equal(stale.flags, MessageFlags.Ephemeral);
  assert.match(stale.content, /انتهت/);
  await f.tick();
  assert.equal(f.posts.length, 3);
  assertPng(f.panel.files[0], 'roulette', [440, 440]);
  const player = f.panel.content.match(/<@(\d+)>/)[1];
  const other = player === host ? guest : host;
  assert.deepEqual(f.panel.allowedMentions, {parse: [], users: [player]});
  assert.deepEqual(spin.writes, [{components: []}]);
  assert.match((await f.send(host, {customId: spinCancel, message: spin})).content, /انتهت/);
  const denied = await f.click(other, 'roulette-random');
  assert.equal(denied.flags, MessageFlags.Ephemeral);
  const target = f.button(`roulette-target:${other}`);
  assert.equal(target.type, 2);
  assert.equal(target.style, 1);
  const invalid = await f.send(player, {customId: target.custom_id.replace(other, player)});
  assert.equal(invalid.flags, MessageFlags.Ephemeral);
  await f.click(player, `roulette-target:${other}`);
  assert.equal(f.posts.length, 4);
  assert.equal(new Set(f.posts.map(post => post.id)).size, 4);
  assert.ok(f.posts.every(post => post.payload.embeds === undefined));
  assert.deepEqual(f.posts[2].writes, [{components: []}]);
  assertPng(f.panel.files[0], 'roulette', [820, 500]);
  assert.match(f.description, /الفائز/);
  assert.equal(f.panel.content, `لقد اختار <@${player}> أن يطرد <@${other}> من اللعبة.\n**الفائز بالروليت** · <@${player}>`);
  assert.deepEqual(f.panel.allowedMentions, {parse: [], users: [player, other]});
  assert.deepEqual(f.panel.components[0].components.map(component => component.custom_id), ['blgshop:bag', 'blgshop:shop']);
  assert.equal(f.timers.size, 0);
});

test('a roulette withdrawal posts a new spin and an expired choice eliminates the inactive player', async t => {
  const f = fixture(t);
  await f.open('roulette');
  await f.click(guest, 'join');
  await f.click(spectator, 'join');
  await f.click(host, 'start');
  await f.tick();
  const first = f.panel.content.match(/<@(\d+)>/)[1];
  await f.click(first, 'roulette-leave');
  assert.equal(f.posts.length, 4);
  assertSpin(f.panel.files[0]);
  assert.equal(f.posts[1].payload.files[0].name, 'roulette-spin.gif');
  assert.match(f.panel.content, /الجولة 2/);
  await f.tick();
  const second = f.panel.content.match(/<@(\d+)>/)[1];
  assert.notEqual(second, first);
  assert.match(f.panel.content, /50 ثانية/);
  const winner = [host, guest, spectator].find(id => id !== first && id !== second);
  await f.tick();
  assert.equal(f.panel.content, `تم طرد <@${second}> من اللعبة بسبب عدم التفاعل.\n**الفائز بالروليت** · <@${winner}>`);
  assert.deepEqual(f.panel.allowedMentions, {parse: [], users: [second]});
  assert.equal(f.posts.length, 6);
  assert.equal(f.timers.size, 0);
});

test('roulette caps at 160, paginates 159 opponents, and keeps one 50-second deadline', async t => {
  const f = fixture(t);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  await f.open('roulette');
  for (let n = 1; n < 160; n++) await f.click(String(BigInt(host) + BigInt(n)), 'join');
  assert.equal(f.panel.content.split('\n')[0], '**(160 / 160)**');
  const outsider = '200000000000000001';
  assert.match((await f.click(outsider, 'join')).content, /اكتمل/);
  await f.click(host, 'start');
  await f.tick();
  const player = f.panel.content.match(/<@(\d+)>/)[1];
  const [timer] = f.timers.keys();
  const attachment = f.panel.files[0];
  const targets = () => f.panel.components.flatMap(r => r.components).filter(b => b.custom_id.includes(':roulette-target:'));
  assert.equal(targets().length, 12);
  assert.equal(f.button('roulette-prev:0').disabled, true);
  const staleTarget = targets()[0].custom_id;
  assert.equal((await f.click(outsider, 'roulette-next:0')).flags, MessageFlags.Ephemeral);
  now += 49_000;
  for (let p = 0; p < 13; p++) await f.click(player, `roulette-next:${p}`);
  assert.equal(f.posts.length, 3);
  assert.equal(f.panel.files[0], attachment);
  assert.equal(targets().length, 3);
  assert.match(f.panel.content, /الصفحة 14 \/ 14/);
  assert.equal(f.button('roulette-next:13').disabled, true);
  assert.match((await f.send(player, {customId: staleTarget})).content, /غير متاح/);
  await f.click(player, 'roulette-prev:13');
  assert.match(f.panel.content, /الصفحة 13 \/ 14/);
  assert.equal([...f.timers.keys()][0], timer);
  now += 1000;
  assert.match((await f.send(player, {customId: targets()[0].custom_id})).content, /انتهت مهلة/);
  assert.match(f.panel.content, new RegExp(`تم طرد <@${player}> من اللعبة بسبب عدم التفاعل`));
  assert.match(f.panel.content, /159 في اللعب/);
});

test('roulette cancel removes controls without replacing the image or posting another wheel', async t => {
  const f = fixture(t);
  await f.open('roulette');
  const file = f.panel.files[0];
  await f.click(host, 'cancel');
  assert.equal(f.posts.length, 1);
  assert.match(f.panel.content, /المضيف ألغى اللعبة/);
  assert.deepEqual(f.panel.components, []);
  assert.equal(f.panel.embeds, undefined);
  assert.equal(f.panel.files[0], file);
  assert.equal(f.timers.size, 0);
});

test('roulette random button removes an opponent, not the selected player', async t => {
  const f = fixture(t);
  await f.open('roulette');
  await f.click(guest, 'join');
  await f.click(host, 'start');
  await f.tick();
  const player = f.panel.content.match(/<@(\d+)>/)[1];
  await f.click(player, 'roulette-random');
  assert.match(f.panel.content, new RegExp(`^لقد اختار <@${player}> أن يطرد`));
  assert.ok(f.panel.content.endsWith(`**الفائز بالروليت** · <@${player}>`));
});

test('roulette awards points to the winner, who can open a private bag and buy a frame', async t => {
  const store = require('../src/store').openStore(':memory:');
  t.after(() => store.close());
  const f = fixture(t, store.roulette);
  await f.open('roulette');
  await f.click(guest, 'join');
  await f.click(host, 'start');
  await f.tick();
  const player = f.panel.content.match(/<@(\d+)>/)[1];
  const other = player === host ? guest : host;
  await f.click(player, 'roulette-random');
  assert.equal(store.roulette.profile(player).points, 10);
  assert.equal(store.roulette.profile(other).points, 0);
  assert.match(f.description, /\+10/);
  assert.match(f.panel.content, /\+10/);
  const bag = await f.send(player, {commandName: 'game', options: {getSubcommand: () => 'bag'}});
  assert.equal(bag.flags, MessageFlags.Ephemeral);
  assert.match(bag.content, /\*\*10\*\*/);
  store.roulette.award('another-game-1', player);
  store.roulette.award('another-game-2', player);
  const shop = await f.send(player, {customId: 'blgshop:shop'});
  assert.equal(shop.flags, MessageFlags.Ephemeral);
  const menu = shop.components[0].components[0];
  await f.send(player, {customId: menu.custom_id, values: ['ice']});
  assert.deepEqual(store.roulette.profile(player), {points: 0, equipped: 'ice', owned: ['classic', 'ice']});
});

test('chairs unlocks seats after music and resolves once every available seat is taken', async t => {
  const f = fixture(t);
  await f.open('chairs');
  for (let n = 2; n <= games.chairs.min; n++) await f.click(String(BigInt(host) + BigInt(n - 1)), 'join');
  await f.click(host, 'start');
  assertPng(f.panel.files[0], 'chairs');
  assert.equal(f.button('sit').disabled, true);
  await f.tick();
  assert.equal(f.button('sit').disabled, false);
  for (let n = 1; n < games.chairs.min; n++) await f.click(String(BigInt(host) + BigInt(n - 1)), 'sit');
  if (games.chairs.min === 2) assert.match(f.description, /الفائز/);
  else assert.equal(f.button('sit').disabled, true);
});

test('mafia sends role PNGs and vote menus only in private replies', async t => {
  const f = fixture(t);
  await f.open('mafia');
  const players = [host];
  for (let n = 1; n < games.mafia.min; n++) {
    const player = String(BigInt(host) + BigInt(n));
    players.push(player);
    await f.click(player, 'join');
  }
  await f.click(host, 'start');
  assertPng(f.panel.files[0], 'mafia');
  assert.doesNotMatch(f.description, /أنت من/);
  const denied = await f.click(spectator, 'role');
  assert.equal(denied.flags, MessageFlags.Ephemeral);
  assert.equal(denied.files, undefined);
  let mafiaPlayer;
  for (const player of players) {
    const role = await f.click(player, 'role');
    assert.equal(role.flags, MessageFlags.Ephemeral);
    assertPng(role.files[0], 'mafia');
    assert.equal(role.embeds[0].image.url, 'attachment://mafia.png');
    const {description} = role.files[0];
    assert.match(description, /أنت من (المافيا|أهل المدينة)/);
    if (description.includes('أنت من المافيا')) mafiaPlayer = player;
  }
  assert.ok(mafiaPlayer);
  const vote = await f.click(mafiaPlayer, 'vote');
  assert.equal(vote.flags, MessageFlags.Ephemeral);
  assert.equal(vote.components[0].components[0].type, 3);
});

test('an idle rock-paper-scissors match ends without scheduling another round', async t => {
  const f = fixture(t);
  await f.open('rps');
  await f.click(guest, 'join');
  await f.click(host, 'start');
  assertPng(f.panel.files[0], 'rps');
  await f.tick();
  assert.match(f.description, /انتهى الوقت/);
  assert.deepEqual(f.panel.components, []);
  assert.equal(f.timers.size, 0);
  await f.open('rps');
  assert.ok(f.button('join'));
});
