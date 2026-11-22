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

function cardFile(card, description) {
  return {attachment: renderGameCard(card), name: `${card.game}.png`, description};
}

function gamePanel(game) {
  const title = games[game.kind].name;
  const {subtitle, footer} = cardDetails(game);
  const items = playerCards(game);
  const highlightWheel = game.kind === 'roulette' && (game.phase === 'done' || (game.phase === 'play' && game.lastOut));
  const selected = highlightWheel ? items.length - 1 : -1;
  return {
    files: [cardFile({game: game.kind, title, subtitle, footer, items, selected}, `${title} · ${subtitle} · ${footer}`)],
    components: controls(game),
    allowedMentions: {parse: []}
  };
}

function privateRole(game, id) {
  const mafia = game.mafia.has(id);
  const title = mafia ? 'أنت من المافيا' : 'أنت من أهل المدينة';
  const footer = mafia ? 'صوّت بالليل لإخراج لاعب من المدينة.' : 'صوّت بالنهار لكشف المافيا.';
  return {files: [cardFile({game: 'mafia', title, footer, role: mafia ? 'mafia' : 'citizen'}, `${title} · ${footer}`)]};
}

function voteMenu(game, id) {
  const options = voteTargets(game, id).map(value => ({label: Array.from(getName(game, value)).slice(0, 90).join(''), value}));
  return {components: [row([{type: 3, custom_id: customId(game, 'target'), placeholder: 'اختر لاعبًا', options}])]};
}

module.exports = {customId, gamePanel, privateRole, voteMenu};
