'use strict';

const {games, moves, voteTargets} = require('./game-rules');
const {renderGameCard} = require('./game-card');

const instructions = {
  roulette: 'تدور العجلة وتُخرج لاعبًا عشوائيًا في كل جولة.',
  chairs: 'احجز كرسيك بسرعة. يخرج لاعب من اللي ما حجزوا.',
  mafia: 'اعرف دورك بسرية وصوّت لإخراج لاعب.',
  rps: 'اختيارك سري إلى نهاية الجولة. أول لاعب يصل إلى نقطتين يفوز.'
};
const getName = (game, id) => game.players.get(id);
const customId = (game, action) => `blg:${game.id}:${game.round}:${action}`;
const row = components => ({type: 1, components});
const button = (game, action, label, style = 2) => ({type: 2, style, label, custom_id: customId(game, action)});

function playerCards(game) {
  const card = id => ({label: getName(game, id)});
  if (game.phase === 'lobby') return [...game.players.keys()].map(card);
  if (game.kind === 'rps') {
    return game.alive.map(id => ({...card(id), move: game.lastChoices.get(id), score: game.points.get(id)}));
  }
  if (game.kind === 'mafia') {
    return [...game.players.keys()].map(id => ({...card(id), status: game.alive.includes(id) ? '' : 'out'}));
  }
  if (game.kind === 'chairs' && game.phase === 'play') {
    const occupied = [...game.choices.keys()];
    return game.alive.slice(1).map((_, index) => ({label: getName(game, occupied[index]), status: occupied[index] ? 'occupied' : ''}));
  }
  const showElimination = game.kind === 'roulette' && game.lastOut && game.phase === 'play';
  const ids = showElimination ? [...game.alive, game.lastOut] : game.alive;
  return ids.map(card);
}

function cardDetails(game) {
  if (game.phase === 'lobby') {
    const {min, max} = games[game.kind];
    return {subtitle: `التسجيل مفتوح · ${game.players.size} / ${max}`, footer: `الحد الأدنى ${min} · المضيف ${getName(game, game.host)}`};
  }
  if (game.phase === 'cancelled') return {subtitle: 'أُغلقت اللعبة', footer: game.endReason};
  if (game.phase === 'done') {
    const winner = game.team ? (game.team === 'town' ? 'أهل المدينة' : 'المافيا') : getName(game, game.winner);
    return {subtitle: 'انتهت اللعبة', footer: `الفائز · ${winner}`};
  }
  const phase = {day: 'النهار', night: 'الليل', play: 'الجولة'}[game.phase];
  const lastOut = game.lastOut ? `خرج ${getName(game, game.lastOut)} · ` : '';
  const footer = game.music ? 'الموسيقى شغالة · استعد للحجز'
    : game.phase === 'day' ? 'الجميع يصوّت'
    : game.phase === 'night' ? 'افتح بطاقة دورك · المافيا تصوّت بسرية' : instructions[game.kind];
  return {subtitle: `${phase} ${game.round} · ${game.alive.length} في اللعب`, footer: `${lastOut}${footer}`};
}

function controls(game) {
  if (game.phase === 'done' || game.phase === 'cancelled') return [];
  const cancel = button(game, 'cancel', 'إلغاء', 4);
  if (game.phase === 'lobby') {
    return [row([button(game, 'join', 'انضم', 3), button(game, 'leave', 'انسحب'), button(game, 'start', 'ابدأ', 1), cancel])];
  }
  if (game.kind === 'chairs') {
    const label = game.music ? 'الموسيقى شغالة' : 'احجز كرسيًا';
    return [row([{...button(game, 'sit', label, 1), disabled: game.music}, cancel])];
  }
  if (game.kind === 'mafia') return [row([button(game, 'role', 'دوري'), button(game, 'vote', 'صوّت', 1), cancel])];
  if (game.kind === 'rps') {
    return [row([...Object.entries(moves).map(([key, label]) => button(game, key, label, 1)), cancel])];
  }
  return [row([cancel])];
}

function cardMessage(card, description) {
  const name = `${card.game}.png`;
  return {
    files: [{attachment: renderGameCard(card), name, description}],
    embeds: [{image: {url: `attachment://${name}`}}]
  };
}

const {rouletteTargets} = require('./game-rules');
const {renderRouletteSpin, renderRouletteLobby, renderRouletteResult} = require('./game-card');

function rouletteLobby(game) {
  const count = `(${game.players.size} / ${games.roulette.max})`;
  const display = (action, label, emoji, style = 2) => ({...button(game, action, label, style), emoji: {name: emoji}});
  return {
    content: `**${count}**`, allowedMentions: {parse: []},
    files: [{attachment: renderRouletteLobby(game.rouletteBanner), name: 'roulette.png', description: `روليت BlueLand · التسجيل مفتوح ${count}`}],
    embeds: [{image: {url: 'attachment://roulette.png'}}],
    components: [row([display('join', 'دخول', '➕'), display('leave', 'خروج', '🚪'),
      display('start', 'ابدأ', '▶️', 1), display('cancel', 'إلغاء', '✖️')])]
  };
}

function roulettePanel(game) {
  const title = games.roulette.name;
  const items = game.alive.map(id => ({label: getName(game, id)}));
  const selected = game.alive.indexOf(game.roulettePlayer);
  const cancel = button(game, 'cancel', 'إلغاء', 4);
  const allowedMentions = {parse: []};
  const turn = `الجولة ${game.round} · ${items.length} في اللعب`;
  if (game.phase === 'done') {
    const banner = cardMessage({game: 'roulette', title, items, selected: 0,
      subtitle: 'انتهت اللعبة', footer: `الفائز · ${getName(game, game.winner)}`}, `الفائز · ${getName(game, game.winner)}`);
    const avatar = game.avatars?.get(game.winner);
    Object.assign(banner.embeds[0], {title: '👑 الفائز بالروليت',
      description: `<@${game.winner}>`, url: `https://discord.com/users/${game.winner}`,
      color: 0xe5b460, ...(avatar ? {thumbnail: {url: avatar}} : {})});
    return {...banner, content: null, components: [], allowedMentions};
  }
  if (game.rouletteStage === 'spin') {
    const footer = game.lastOut ? `خرج ${getName(game, game.lastOut)}` : 'العجلة تدور لاختيار لاعب';
    return {
      content: null, allowedMentions, components: [row([cancel])],
      files: [{attachment: renderRouletteSpin(items.map(item => item.label), selected), name: 'roulette-spin.gif', description: `${turn} · ${footer}`}],
      embeds: [{title: `${title} · ${turn}`, description: footer, image: {url: 'attachment://roulette-spin.gif'}}]
    };
  }
  const footer = 'اختر لاعبًا يخرج، أو انسحب، أو اختر عشوائيًا';
  const spinResult = {
    files: [{attachment: renderRouletteResult(items.map(item => item.label), selected, game.rouletteAvatar),
      name: 'roulette.png', description: `${title} · ${turn} · ${footer}`}],
    embeds: [{image: {url: 'attachment://roulette.png'}}]
  };
  const action = (id, label, style, emoji) => ({...button(game, id, label, style), emoji: {name: emoji}});
  return {...spinResult, content: `<@${game.roulettePlayer}> وقفت العجلة عليك! اختار خلال 20 ثانية.`, allowedMentions,
    components: [row([action('roulette-kick', 'إخراج لاعب', 1, '⭐'), action('roulette-leave', 'انسحاب', 4, '🚪'),
      action('roulette-random', 'اختيار عشوائي', 2, '🎲'), cancel])]};
}

function rouletteMenu(game) {
  const options = rouletteTargets(game).map(value => ({label: Array.from(getName(game, value)).slice(0, 90).join(''), value}));
  return {content: 'مين تحب يخرج من اللعبة؟', components: [row([{type: 3,
    custom_id: customId(game, 'roulette-target'), placeholder: 'اختر لاعبًا', options}])]};
}

function gamePanel(game) {
  if (game.kind === 'roulette' && game.phase === 'lobby') return rouletteLobby(game);
  if (game.kind === 'roulette' && (game.phase === 'play' || game.phase === 'done')) return roulettePanel(game);
  const title = games[game.kind].name;
  const {subtitle, footer} = cardDetails(game);
  const items = playerCards(game);
  return {
    ...cardMessage({game: game.kind, title, subtitle, footer, items}, `${title} · ${subtitle} · ${footer}`),
    ...(game.kind === 'roulette' && game.phase === 'cancelled' ? {content: null} : {}),
    components: controls(game),
    allowedMentions: {parse: []}
  };
}

function privateRole(game, id) {
  const mafia = game.mafia.has(id);
  const title = mafia ? 'أنت من المافيا' : 'أنت من أهل المدينة';
  const footer = mafia ? 'صوّت بالليل لإخراج لاعب من المدينة.' : 'صوّت بالنهار لكشف المافيا.';
  return cardMessage({game: 'mafia', title, footer, role: mafia ? 'mafia' : 'citizen'}, `${title} · ${footer}`);
}

function voteMenu(game, id) {
  const options = voteTargets(game, id).map(value => ({label: Array.from(getName(game, value)).slice(0, 90).join(''), value}));
  return {components: [row([{type: 3, custom_id: customId(game, 'target'), placeholder: 'اختر لاعبًا', options}])]};
}

module.exports = {customId, gamePanel, privateRole, voteMenu, rouletteMenu};
