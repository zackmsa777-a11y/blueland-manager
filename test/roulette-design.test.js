'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Resvg} = require('@resvg/resvg-js');
const {rouletteBanner, rouletteAvatar} = require('../src/roulette-media');
const {rouletteEmojis} = require('../src/roulette-emoji');
const {renderRouletteResult} = require('../src/game-card');
const {gamePanel} = require('../src/game-view');
const {createGame} = require('../src/game-rules');

const channelId = '1574014085027209308';
const messageId = '1574147765036916938';
const assetId = '1574147764504494150';
const artwork = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><rect width="60" height="20" fill="#ff0033"/></svg>').render().asPng();

test('roulette lobby attaches the supplied Discord PNG unchanged', async t => {
  const attachment = `https://cdn.discordapp.com/attachments/${channelId}/${assetId}/no-background-1.png?ex=refreshed`;
  const attempts = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    attempts.push(url.href);
    assert.equal(options.redirect, 'error');
    return new Response(artwork, {headers: {'content-type': 'image/png'}});
  });
  const client = {channels: {async fetch(id) {
    assert.equal(id, channelId);
    return {messages: {async fetch(opts) {
      assert.deepEqual(opts, {message: messageId, cache: false, force: true});
      return {attachments: new Map([['example', {url: 'https://example.test/ignored.png'}], [assetId, {url: attachment}]])};
    }}};
  }}};
  const banner = await rouletteBanner(client);
  assert.deepEqual(banner, artwork);
  assert.equal(await rouletteBanner(client), banner);
  assert.deepEqual(attempts, [attachment]);
  const view = gamePanel({...createGame('roulette', 'host', 'Host'), rouletteBanner: banner});
  assert.equal(view.files[0].attachment, banner);
  assert.equal(view.embeds, undefined);
});

test('roulette emojis fall back to labels without injecting Unicode or unavailable emoji', async () => {
  const cache = new Map([['1', {id: '100000000000000091', name: 'roulette_join', available: false}]]);
  const emojis = await rouletteEmojis({emojis: {cache, async fetch() { throw new Error('offline'); }}});
  const view = gamePanel({...createGame('roulette', 'host', 'Host'), rouletteEmojis: emojis}, {includeLobbyImage: false});
  assert.ok(view.components.every(row => row.components.every(button => button.label && !button.emoji)));
});

test('the stopped wheel renders player names and can use a Discord avatar in the hub', () => {
  const plain = renderRouletteResult(['راموس', 'Player Two'], 0);
  const withNames = renderRouletteResult(['Different', 'Player Two'], 0);
  const withAvatar = renderRouletteResult(['راموس', 'Player Two'], 0, `data:image/png;base64,${artwork.toString('base64')}`);
  assert.notDeepEqual(plain, withNames);
  assert.notDeepEqual(plain, withAvatar);
});

test('roulette avatar loading does not request a non-Discord URL', async t => {
  const request = t.mock.method(global, 'fetch', async () => { throw new Error('unexpected request'); });
  assert.equal(await rouletteAvatar('https://example.test/embed/avatars/0.png'), null);
  assert.equal(request.mock.callCount(), 0);
});
