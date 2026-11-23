'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {rouletteWheelSvg, rouletteLobbySvg, rouletteWinnerSvg} = require('../src/roulette-art');
const {items} = require('../src/roulette-shop');
const banner = 'data:image/jpeg;base64,example';
const avatar = 'data:image/png;base64,player';
const wheel = (turn = 0, player) => rouletteWheelSvg(['Rust', 'Lux'], 0, turn, undefined, player);
const winner = player => rouletteWinnerSvg({name:'Rust', avatar:player, reward:10, style:items.classic});
const hasLogo = art => {
  assert.doesNotMatch(art, />BL<\/text>/);
  assert.match(art, /xlink:href="data:image\/png;base64,iVBORw0KGgo[^\"]+"/);
};
test('uses the actual BlueLand image in the lobby wheel', () => hasLogo(rouletteLobbySvg(banner)));
test('uses the actual BlueLand image while the wheel spins', () => hasLogo(wheel(1)));
test('uses the actual BlueLand image in the stopped wheel with no avatar', () => hasLogo(wheel()));
test('uses the actual BlueLand image in the winner card with no avatar', () => hasLogo(winner()));
test('retains player portraits on the stopped wheel and winner card', () => {
  assert.ok(wheel(0, avatar).includes(`xlink:href="${avatar}"`));
  assert.ok(winner(avatar).includes(`xlink:href="${avatar}"`));
});
