'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {MessageFlags} = require('discord.js');
const {commands} = require('../src/commands');
const {createDiscordGames} = require('../src/discord-games');
const {games} = require('../src/game-rules');

function assertPng(file, kind) {
  const data = file.attachment;
  assert.equal(file.name, kind + '.png');
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(data.subarray(12, 16).toString(), 'IHDR');
  assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [820, kind === 'rps' ? 500 : 720]);
  assert.equal(data.subarray(-8, -4).toString(), 'IEND');
}

const host = '100000000000000001';
const guest = '100000000000000002';
const spectator = '100000000000000099';
const flushEdits = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const timers = new Map();
  t.mock.method(global, 'setTimeout', callback => {
    const timer = {unref() { return this; }};
    timers.set(timer, callback);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));

  const gateway = createDiscordGames();
  const pings = [];
  let panel;
  const message = {id: 'game-message', async edit(payload) { panel = payload; },
    channel: {async send(payload) { pings.push(payload); }}};

  async function send(user, options) {
    let reply;
    const i = {
      user: {id: user, username: `Player ${user.slice(-2)}`, displayAvatarURL: () => avatar(user)},
      channelId: 'games-room',
      message,
      ...options,
      isChatInputCommand: () => Boolean(options.commandName),
      isStringSelectMenu: () => Boolean(options.values),
      isButton: () => Boolean(options.customId && !options.values),
      async deferReply() { this.deferred = true; },
      async editReply(payload) {
        assert.equal(payload.embeds[0].image.url, 'attachment://' + payload.files[0].name);
        panel = payload;
        return message;
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
    const control = panel.components.flatMap(row => row.components).find(item => item.custom_id.endsWith(`:${action}`));
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
    button, send, tick, timers, pings,
    get panel() { return panel; },
    get description() { return panel.files[0].description; }
  };
}

test('all four game choices are registered for Discord', () => {
  const command = commands.find(item => (item.toJSON?.() || item).name === 'game');
  assert.ok(command);
  assert.deepEqual((command.toJSON?.() || command).options.map(option => option.name).sort(), ['chairs', 'mafia', 'roulette', 'rps']);
});

const avatar = id => `https://cdn.discordapp.com/avatars/${id}/test.png`;

function assertSpin(file) {
  assert.equal(file.name, 'roulette-spin.gif');
  const data = file.attachment;
  assert.equal(data.toString('ascii', 0, 6), 'GIF89a');
  let index = 13 + 3 * (2 ** ((data[10] & 7) + 1));
  let frames = 0;
  while (data[index] === 0x21) {
    assert.deepEqual([...data.subarray(index, index + 4)], [0x21, 0xf9, 4, 4]);
    index += 8;
    assert.equal(data[index], 0x2c);
    assert.equal(data.readUInt16LE(index + 5), 224);
    assert.equal(data.readUInt16LE(index + 7), 224);
    index += 11;
    while (data[index]) index += 1 + data[index];
    index++;
    frames++;
  }
  assert.equal(frames, 18);
  assert.equal(index, data.length - 1);
  assert.equal(data[index], 0x3b);
}

test('roulette spins, pings only the selected player, validates removal and crowns the winner', async t => {
  const f = fixture(t);
  await f.open('roulette');
  assertPng(f.panel.files[0], 'roulette');
  assert.equal(f.panel.content, undefined);
  const oldJoin = f.button('join').custom_id;
  await f.click(guest, 'join');
  await f.click(host, 'start');
  assertSpin(f.panel.files[0]);
  assert.equal(f.pings.length, 0);
  const stale = await f.send(spectator, {customId: oldJoin});
  assert.equal(stale.flags, MessageFlags.Ephemeral);
  assert.match(stale.content, /انتهت/);
  await f.tick();
  assertPng(f.panel.files[0], 'roulette');
  const player = f.panel.content.match(/<@(\d+)>/)[1];
  const other = player === host ? guest : host;
  assert.equal(f.pings.length, 1);
  assert.deepEqual(f.pings[0].allowedMentions, {parse: [], users: [player]});
  assert.match(f.pings[0].content, new RegExp(`<@${player}>`));
  const denied = await f.click(other, 'roulette-random');
  assert.equal(denied.flags, MessageFlags.Ephemeral);
  const menu = await f.click(player, 'roulette-kick');
  assert.equal(menu.flags, MessageFlags.Ephemeral);
  const select = menu.components[0].components[0];
  assert.deepEqual(select.options.map(option => option.value), [other]);
  const invalid = await f.send(player, {customId: select.custom_id, values: [player]});
  assert.equal(invalid.flags, MessageFlags.Ephemeral);
  await f.send(player, {customId: select.custom_id, values: [other]});
  assertPng(f.panel.files[0], 'roulette');
  assert.match(f.description, /الفائز/);
  const [winner] = f.panel.embeds;
  assert.equal(winner.title, '👑 الفائز بالروليت');
  assert.equal(winner.description, `<@${player}>`);
  assert.equal(winner.thumbnail.url, avatar(player));
  assert.equal(winner.url, `https://discord.com/users/${player}`);
  assert.deepEqual(f.panel.components, []);
  assert.equal(f.timers.size, 0);
});

test('a roulette withdrawal starts a new spin and an expired choice removes a random opponent', async t => {
  const f = fixture(t);
  await f.open('roulette');
  await f.click(guest, 'join');
  await f.click(spectator, 'join');
  await f.click(host, 'start');
  await f.tick();
  const first = f.panel.content.match(/<@(\d+)>/)[1];
  await f.click(first, 'roulette-leave');
  assert.equal(f.panel.files[0].name, 'roulette-spin.gif');
  await f.tick();
  const second = f.panel.content.match(/<@(\d+)>/)[1];
  assert.notEqual(second, first);
  await f.tick();
  assert.equal(f.panel.embeds[0].description, `<@${second}>`);
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
  assert.equal(f.panel.embeds[0].description, `<@${player}>`);
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
