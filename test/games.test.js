'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {MessageFlags} = require('discord.js');
const {commands} = require('../src/commands');
const {createDiscordGames} = require('../src/discord-games');
const {games} = require('../src/game-rules');

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
  let panel;
  const message = {id: 'game-message', async edit(payload) { panel = payload; }};

  async function send(user, options) {
    let reply;
    const i = {
      user: {id: user, username: `Player ${user.slice(-2)}`},
      channelId: 'games-room',
      message,
      ...options,
      isChatInputCommand: () => Boolean(options.commandName),
      isStringSelectMenu: () => Boolean(options.values),
      isButton: () => Boolean(options.customId && !options.values),
      async deferReply() { this.deferred = true; },
      async editReply(payload) { panel = payload; return message; },
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
    button, send, tick, timers,
    get panel() { return panel; },
    get svg() { return panel.files[0].attachment.toString('utf8'); }
  };
}

test('all four game choices are registered for Discord', () => {
  const command = commands.find(item => (item.toJSON?.() || item).name === 'game');
  assert.ok(command);
  assert.deepEqual((command.toJSON?.() || command).options.map(option => option.name).sort(), ['chairs', 'mafia', 'roulette', 'rps']);
});

test('roulette uses SVG panels, rejects old controls and finishes on one winner', async t => {
  const f = fixture(t);
  await f.open('roulette');
  assert.equal(f.panel.files[0].name, 'roulette.svg');
  assert.match(f.svg, /^<svg xmlns=/);
  assert.equal(f.panel.content, undefined);
  const oldJoin = f.button('join').custom_id;
  await f.click(guest, 'join');
  await f.click(host, 'start');
  const stale = await f.send(spectator, {customId: oldJoin});
  assert.equal(stale.flags, MessageFlags.Ephemeral);
  assert.match(stale.content, /انتهت/);
  await f.tick();
  assert.match(f.svg, /الفائز/);
  assert.deepEqual(f.panel.components, []);
  assert.equal(f.timers.size, 0);
});

test('chairs unlocks seats after music and resolves once every available seat is taken', async t => {
  const f = fixture(t);
  await f.open('chairs');
  for (let n = 2; n <= games.chairs.min; n++) await f.click(String(BigInt(host) + BigInt(n - 1)), 'join');
  await f.click(host, 'start');
  assert.equal(f.panel.files[0].name, 'chairs.svg');
  assert.equal(f.button('sit').disabled, true);
  await f.tick();
  assert.equal(f.button('sit').disabled, false);
  for (let n = 1; n < games.chairs.min; n++) await f.click(String(BigInt(host) + BigInt(n - 1)), 'sit');
  if (games.chairs.min === 2) assert.match(f.svg, /الفائز/);
  else assert.equal(f.button('sit').disabled, true);
});

test('mafia sends role SVGs and vote menus only in private replies', async t => {
  const f = fixture(t);
  await f.open('mafia');
  const players = [host];
  for (let n = 1; n < games.mafia.min; n++) {
    const player = String(BigInt(host) + BigInt(n));
    players.push(player);
    await f.click(player, 'join');
  }
  await f.click(host, 'start');
  assert.equal(f.panel.files[0].name, 'mafia.svg');
  assert.doesNotMatch(f.svg, /أنت من/);
  const denied = await f.click(spectator, 'role');
  assert.equal(denied.flags, MessageFlags.Ephemeral);
  assert.equal(denied.files, undefined);
  let mafiaPlayer;
  for (const player of players) {
    const role = await f.click(player, 'role');
    assert.equal(role.flags, MessageFlags.Ephemeral);
    const svg = role.files[0].attachment.toString('utf8');
    assert.match(svg, /أنت من (المافيا|أهل المدينة)/);
    if (svg.includes('أنت من المافيا')) mafiaPlayer = player;
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
  assert.equal(f.panel.files[0].name, 'rps.svg');
  await f.tick();
  assert.match(f.svg, /انتهى الوقت/);
  assert.deepEqual(f.panel.components, []);
  assert.equal(f.timers.size, 0);
  await f.open('rps');
  assert.ok(f.button('join'));
});
