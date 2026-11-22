'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {commandName, subcommandName} = require('../src/command-aliases');
const {commands, commandRunner, helpText, interactionInput, parseChat} = require('../src/commands');
const {createDiscordGames} = require('../src/discord-games');
const target = '200000000000000002';
const actor = '200000000000000001';

function interaction(name, sub, fields = {}) {
  return {id: '1234', commandName: name, user: {id: actor}, options: {
    getSubcommand: () => sub, getString: key => fields[key] ?? null, getInteger: key => fields[key] ?? null,
    getUser: key => fields[key] ?? null
  }};
}

test('every English slash command and subcommand has a distinct Arabic alternate with the same options', () => {
  const english = commands.filter(command => commandName(command.name) === command.name);
  const arabic = commands.filter(command => commandName(command.name) !== command.name);
  assert.equal(new Set(commands.map(command => command.name)).size, commands.length);
  assert.equal(arabic.length, english.length);
  for (const original of english) {
    const alias = arabic.find(command => commandName(command.name) === original.name);
    assert.ok(alias, original.name);
    assert.match(alias.name, /^[-_\p{L}\p{N}]{1,32}$/u);
    for (const option of alias.options.filter(option => option.type === 1)) assert.match(option.name, /^[-_\p{L}\p{N}]{1,32}$/u);
    const restored = alias.options.map(option => option.type === 1
      ? {...option, name: subcommandName(alias.name, option.name)} : option);
    assert.deepEqual({...alias, name: original.name, options: restored}, original);
  }
  assert.ok(helpText.length <= 2000);
});

test('Arabic aliases resolve to the same moderation checks and canonical request inputs', async () => {
  assert.deepEqual(parseChat('+ر'), {action: 'roles'});
  for (const alias of ['بان','بأن','حظر']) assert.deepEqual(parseChat(`+${alias} <@${target}> السبب`),
    {action: 'ban', target, reason: 'السبب'});
  assert.throws(() => parseChat(`+بان <@${target.slice(0, 16)}>`));
  assert.equal(parseChat('+constructor'), null);
  assert.equal(parseChat(`+تخفيض <@${target}>`).action, 'demote');
  assert.deepEqual(interactionInput(interaction('طلب','قبول',{id: 5})), interactionInput(interaction('request','approve',{id: 5})));
  const aliased = interactionInput(interaction('بان', null, {member: {id: target}, reason: 'السبب'}));
  assert.deepEqual(aliased, interactionInput(interaction('ban', null, {member: {id: target}, reason: 'السبب'})));
  const forbidden = new Error('not authorized');
  const dispatch = commandRunner({store: {community: {}}, community: {moderate(input) {
    assert.equal(input.action, 'ban');
    assert.equal(input.actor, actor);
    assert.equal(input.target, target);
    throw forbidden;
  }}});
  await assert.rejects(dispatch(aliased), error => error === forbidden);
});

test('Arabic game shortcuts route into the real game handler and keep the bag private', async () => {
  const games = createDiscordGames({profile(id) {
    assert.equal(id, actor);
    return {points: 15, equipped: 'classic', owned: ['classic']};
  }});
  let reply;
  const i = {...interaction('ألعاب','حقيبة'), isChatInputCommand: () => true, isButton: () => false,
    isStringSelectMenu: () => false, async reply(payload) { reply = payload; }};
  assert.equal(await games.handle(i), true);
  assert.match(reply.content, /\*\*15\*\*/);
  assert.equal(reply.flags, 64);
});
