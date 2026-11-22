'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Resvg} = require('@resvg/resvg-js');
const {rouletteBanner, rouletteAvatar} = require('../src/roulette-media');
const {renderRouletteLobby, renderRouletteResult} = require('../src/game-card');

const channelId = '1574014085027209308';
const messageId = '1574140600251580426';
const assetId = '1574140599450345533';
const artwork = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><rect width="60" height="20" fill="#ff0033"/></svg>').render().asPng();

test('roulette lobby fetches the third attachment by message and attachment ID and uses its PNG bytes', async t => {
  const attachment = `https://cdn.discordapp.com/attachments/${channelId}/${assetId}/IMG_3468.png?ex=refreshed`;
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
  assert.equal(banner, `data:image/png;base64,${artwork.toString('base64')}`);
  assert.equal(await rouletteBanner(client), banner);
  assert.deepEqual(attempts, [attachment]);
  assert.notDeepEqual(renderRouletteLobby(banner), renderRouletteLobby(null));
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
