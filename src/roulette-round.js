'use strict';

const {rouletteTargets} = require('./game-rules');
const PAGE_SIZE = 12;
const CHOICE_MS = 50_000;

function roulettePage(game) {
  const targets = rouletteTargets(game);
  const count = Math.max(1, Math.ceil(targets.length / PAGE_SIZE));
  const page = Math.min(Math.max(game.roulettePage ?? 0, 0), count - 1);
  return {page, count, targets: targets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)};
}

function rouletteChoice(game) {
  const {page, count, targets} = roulettePage(game);
  const button = (action, label, style = 2) => ({type: 2, style, label, custom_id: `blg:${game.id}:${game.round}:${action}`});
  const row = components => ({type: 1, components});
  const components = [];
  for (let i = 0; i < targets.length; i += 3) {
    components.push(row(targets.slice(i, i + 3).map((id, j) => {
      const name = String(game.players.get(id) || '').toWellFormed().replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
      const label = `${page * PAGE_SIZE + i + j + 1}. ${name || 'لاعب'}`;
      return button(`roulette-target:${id}`, label.length > 36 ? label.slice(0, 34).toWellFormed() + '…' : label, 1);
    })));
  }
  const nav = count > 1 ? [
    {...button(`roulette-prev:${page}`, 'الصفحة السابقة'), disabled: page === 0},
    {...button(`roulette-next:${page}`, 'الصفحة التالية'), disabled: page === count - 1}
  ] : [];
  components.push(row([...nav, button('roulette-leave', 'انسحاب', 4),
    button('roulette-random', 'اختيار عشوائي'), button('cancel', 'إلغاء اللعبة', 4)]));
  const pageLabel = count > 1 ? `\n**الصفحة ${page + 1} / ${count}**` : '';
  return {content: `**الروليت · الجولة ${game.round} · ${game.alive.length} في اللعب**\n<@${game.roulettePlayer}> وقفت العجلة عليك! اضغط اسم اللاعب اللي تختار تطرده خلال ${CHOICE_MS / 1000} ثانية.${pageLabel}`, components};
}

function rouletteNotice(game) {
  const out = game.lastOut;
  const decision = game.rouletteDecision;
  if (!out || !decision) return {text: '', allowedMentions: {parse: []}};
  const {actor, action} = decision;
  const leaving = actor === out;
  const text = action === 'idle' ? `تم طرد <@${out}> من اللعبة بسبب عدم التفاعل.`
    : leaving ? `<@${out}> انسحب من اللعبة.`
    : `لقد اختار <@${actor}> أن يطرد <@${out}> من اللعبة.`;
  return {text: text + '\n', allowedMentions: {parse: [], users: leaving ? [out] : [actor, out]}};
}

module.exports = {CHOICE_MS, roulettePage, rouletteChoice, rouletteNotice};
