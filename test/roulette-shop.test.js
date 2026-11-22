'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {Resvg} = require('@resvg/resvg-js');
const {openRouletteShop, shopPanel} = require('../src/roulette-shop');
const {renderRouletteWinner} = require('../src/game-card');

test('roulette points are idempotent and purchases spend only the buyer’s points', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const shop = openRouletteShop(db);
    assert.deepEqual(shop.profile('first'), {points: 0, equipped: 'classic', owned: ['classic']});
    assert.equal(shop.award('game-1', 'first'), 10);
    assert.equal(shop.award('game-1', 'first'), 0);
    assert.equal(shop.award('game-1', 'other'), 0);
    assert.throws(() => shop.buy('first', 'ice'), /رصيدك/);
    assert.throws(() => shop.equip('other', 'ice'), /حقيبتك/);
    for (let match = 2; match <= 4; match++) shop.award(`game-${match}`, 'first');
    assert.deepEqual(shop.buy('first', 'ice'), {points: 10, equipped: 'ice', owned: ['classic', 'ice']});
    assert.throws(() => shop.buy('first', 'ice'), /بالفعل/);
    assert.equal(shop.equip('first', 'classic').equipped, 'classic');
    assert.equal(openRouletteShop(db).profile('first').points, 10);
    assert.equal(shop.profile('other').points, 0);
    assert.deepEqual(shopPanel('shop', shop.profile('first')).components[0].components[0].options.map(o => o.value), ['galaxy']);
  } finally { db.close(); }
});

test('the winner PNG is a separate card that renders portraits and equipped frames', () => {
  const avatar = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#ff3333"/></svg>').render().asPng();
  const base = {name: 'Ramos', reward: 10, style: 'classic'};
  const plain = renderRouletteWinner(base);
  const portrait = renderRouletteWinner({...base, avatar: `data:image/png;base64,${avatar.toString('base64')}`});
  const icy = renderRouletteWinner({...base, style: 'ice'});
  assert.deepEqual([plain.readUInt32BE(16), plain.readUInt32BE(20)], [820, 500]);
  assert.notDeepEqual(plain, portrait);
  assert.notDeepEqual(plain, icy);
});
