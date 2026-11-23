'use strict';

const {randomInt} = require('node:crypto');

const games = {
  roulette: {name: 'الروليت', min: 2, max: 160},
  chairs: {name: 'الكراسي', min: 2, max: 12},
  mafia: {name: 'المافيا', min: 5, max: 12},
  rps: {name: 'حجر ورقة مقص', min: 2, max: 2}
};
const moves = {rock: 'حجر', paper: 'ورقة', scissors: 'مقص'};
const beats = {rock: 'scissors', paper: 'rock', scissors: 'paper'};
const pick = (items, random) => items.length ? items[random(items.length)] : null;

function createGame(kind, host, name) {
  return {
    kind, host, phase: 'lobby', round: 0, players: new Map([[host, name]]), alive: [],
    mafia: new Set(), choices: new Map(), points: new Map(), lastChoices: new Map(),
    lastOut: null, winner: null, team: null
  };
}

function start(game, random = randomInt) {
  game.alive = [...game.players.keys()];
  if (game.kind === 'mafia') {
    const pool = [...game.alive];
    const count = Math.floor(pool.length / 4);
    for (let i = 0; i < count; i++) game.mafia.add(pool.splice(random(pool.length), 1)[0]);
  }
  if (game.kind === 'rps') game.points = new Map(game.alive.map(id => [id, 0]));
  game.phase = game.kind === 'mafia' ? 'night' : 'play';
  game.round = 1;
}

function eligiblePlayers(game) {
  return game.phase === 'night' ? game.alive.filter(id => game.mafia.has(id)) : game.alive;
}

function voteTargets(game, id) {
  return game.alive.filter(other => other !== id && (game.phase !== 'night' || !game.mafia.has(other)));
}

function choose(game, id, value) {
  if (game.choices.has(id) || !eligiblePlayers(game).includes(id)) return false;
  if (game.kind === 'mafia' && !voteTargets(game, id).includes(value)) return false;
  if (game.kind === 'rps' && !Object.hasOwn(moves, value)) return false;
  game.choices.set(id, value);
  return true;
}

function ready(game) {
  const needed = game.kind === 'chairs' ? game.alive.length - 1 : eligiblePlayers(game).length;
  return game.choices.size >= needed;
}

function eliminate(game, id) {
  game.lastOut = id;
  if (id) game.alive = game.alive.filter(player => player !== id);
}

function voteWinner(choices) {
  const counts = new Map();
  for (const id of choices.values()) counts.set(id, (counts.get(id) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] === ranked[1]?.[1]) return null;
  return ranked[0][0];
}

function resolveDuel(game) {
  const [a, b] = game.alive;
  const first = game.choices.get(a);
  const second = game.choices.get(b);
  game.lastChoices = new Map(game.choices);
  if (!first && !second) {
    game.phase = 'cancelled';
    return;
  }
  if (first === second) return;
  const id = !second || beats[first] === second ? a : b;
  const score = game.points.get(id) + 1;
  game.points.set(id, score);
  if (score === 2) game.winner = id;
}

function spinRoulette(game, random = randomInt) {
  game.roulettePlayer = pick(game.alive, random);
  game.rouletteStage = 'spin';
}

function stopRoulette(game) {
  if (game.phase !== 'play' || game.rouletteStage !== 'spin') return false;
  game.rouletteStage = 'choose';
  return true;
}

function rouletteTargets(game) {
  return game.alive.filter(id => id !== game.roulettePlayer);
}

function resolveRoulette(game, user, action, target, random = randomInt) {
  if (game.phase !== 'play' || game.rouletteStage !== 'choose' || user !== game.roulettePlayer) return false;
  const targets = rouletteTargets(game);
  const out = action === 'leave' || action === 'idle' ? user : action === 'random' ? pick(targets, random)
    : action === 'kick' && targets.includes(target) ? target : null;
  if (!out) return false;
  eliminate(game, out);
  game.round++;
  game.rouletteStage = null;
  game.roulettePlayer = null;
  if (game.alive.length === 1) {
    game.winner = game.alive[0];
    game.phase = 'done';
  }
  return true;
}

function advance(game, random = randomInt) {
  if (game.kind === 'roulette') return;
  if (game.kind === 'chairs') {
    const waiting = game.alive.filter(id => !game.choices.has(id));
    eliminate(game, pick(waiting, random));
  }
  if (game.kind === 'mafia') {
    eliminate(game, voteWinner(game.choices));
    const mafiaLeft = game.alive.filter(id => game.mafia.has(id)).length;
    if (!mafiaLeft) game.team = 'town';
    else if (mafiaLeft >= game.alive.length - mafiaLeft) game.team = 'mafia';
    game.phase = game.phase === 'night' ? 'day' : 'night';
  }
  if (game.kind === 'rps') resolveDuel(game);
  if (game.alive.length === 1) game.winner = game.alive[0];
  if (game.winner || game.team) game.phase = 'done';
  game.choices.clear();
  game.round++;
}

module.exports = {games, moves, createGame, start, eligiblePlayers, voteTargets, choose, ready, advance,
  spinRoulette, stopRoulette, rouletteTargets, resolveRoulette};
