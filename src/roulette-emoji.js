'use strict';

const aliases = {
  join: ['join', 'enter', 'add', 'plus', 'arrow_right', 'right_arrow', 'check', 'yes'],
  leave: ['leave', 'exit', 'door', 'logout', 'arrow_left', 'left_arrow', 'back', 'minus'],
  start: ['start', 'play', 'play_button', 'go', 'arrow_right', 'right_arrow'],
  cancel: ['cancel', 'close', 'cross', 'cross_mark', 'no', 'xmark', 'stop', 'x', 'wrong', 'redx'],
  kick: ['kick', 'remove', 'target', 'star'],
  random: ['random', 'dice', 'game_die', 'shuffle'],
  bag: ['bag', 'backpack', 'inventory', 'gift'],
  shop: ['shop', 'store', 'cart', 'shopping_cart', 'coins', 'coin']
};

function mapRouletteEmojis(emojis) {
  const byName = new Map();
  for (const emoji of emojis?.values() || []) {
    if (!emoji.name || !/^\d{17,20}$/.test(emoji.id) || emoji.available === false || emoji.managed || emoji.roles?.cache?.size) continue;
    byName.set(emoji.name.toLowerCase(), {id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated)});
  }
  const fallback = ['roulette', 'roulette_wheel', 'blueland', 'blue_land', 'blueland_logo', 'bl_logo']
    .map(name => byName.get(name)).find(Boolean);
  return Object.fromEntries(Object.entries(aliases).map(([action, names]) => [action,
    byName.get(`roulette_${action}`) || byName.get(`rl_${action}`) || names.map(name => byName.get(name)).find(Boolean) || fallback]));
}

async function rouletteEmojis(guild) {
  const manager = guild?.emojis;
  if (!manager?.fetch) return mapRouletteEmojis(manager?.cache);
  const signal = AbortSignal.timeout(1800);
  let onAbort;
  const timeout = new Promise(resolve => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, {once: true});
  });
  try {
    const emojis = await Promise.race([Promise.resolve().then(() => manager.fetch()).catch(() => null), timeout]);
    return mapRouletteEmojis(emojis || manager.cache);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {rouletteEmojis};
