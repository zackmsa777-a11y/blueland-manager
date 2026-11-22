'use strict';

const {RuleError} = require('./ladder');
const WIN_POINTS = 10;
const items = Object.freeze({
  classic: Object.freeze({label: 'الإطار الذهبي', cost: 0, color: '#ffd975', dark: '#152744'}),
  ice: Object.freeze({label: 'إطار الجليد', cost: 30, color: '#93eaff', dark: '#083b5d'}),
  galaxy: Object.freeze({label: 'إطار المجرة', cost: 50, color: '#d6a9ff', dark: '#291747'})
});

function openRouletteShop(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS roulette_wallet (member TEXT PRIMARY KEY, points INTEGER NOT NULL CHECK(points >= 0), equipped TEXT NOT NULL DEFAULT 'classic');
    CREATE TABLE IF NOT EXISTS roulette_wins (match_id TEXT NOT NULL PRIMARY KEY, member TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roulette_items (member TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(member, item));`);
  const wallet = db.prepare('SELECT points,equipped FROM roulette_wallet WHERE member=?');
  const inventory = db.prepare('SELECT item FROM roulette_items WHERE member=? ORDER BY item');
  const owns = db.prepare('SELECT 1 FROM roulette_items WHERE member=? AND item=?');
  const addWin = db.prepare('INSERT OR IGNORE INTO roulette_wins(match_id,member) VALUES(?,?)');
  const credit = db.prepare('INSERT INTO roulette_wallet(member,points) VALUES(?,?) ON CONFLICT(member) DO UPDATE SET points=points+excluded.points');
  const debit = db.prepare('UPDATE roulette_wallet SET points=points-?,equipped=? WHERE member=? AND points>=?');
  const grant = db.prepare('INSERT INTO roulette_items(member,item) VALUES(?,?)');
  const setStyle = db.prepare("INSERT INTO roulette_wallet(member,points,equipped) VALUES(?,0,?) ON CONFLICT(member) DO UPDATE SET equipped=excluded.equipped");
  function tx(run) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  function profile(member) {
    const current = wallet.get(member);
    return {points: current?.points ?? 0, equipped: current?.equipped ?? 'classic',
      owned: ['classic', ...inventory.all(member).map(row => row.item).filter(key => Object.hasOwn(items, key))]};
  }
  function award(match, member) {
    return tx(() => {
      if (!addWin.run(match,member).changes) return 0;
      credit.run(member,WIN_POINTS);
      return WIN_POINTS;
    });
  }
  function buy(member, key) {
    const item = Object.hasOwn(items,key) && items[key];
    if (!item || !item.cost) throw new RuleError('هذا العنصر مو متاح للشراء.');
    return tx(() => {
      if (owns.get(member,key)) throw new RuleError('هذا الإطار موجود في حقيبتك بالفعل.');
      if (!debit.run(item.cost,key,member,item.cost).changes) throw new RuleError('رصيدك ما يكفي لشراء هذا الإطار.');
      grant.run(member,key);
      return profile(member);
    });
  }
  function equip(member, key) {
    if (!Object.hasOwn(items,key) || (key !== 'classic' && !owns.get(member,key))) throw new RuleError('هذا الإطار مو موجود في حقيبتك.');
    setStyle.run(member,key);
    return profile(member);
  }
  return {profile, award, buy, equip};
}

function shopPanel(mode, profile, notice) {
  const shop = mode === 'shop';
  const choices = shop ? Object.keys(items).filter(key => items[key].cost && !profile.owned.includes(key)) : profile.owned;
  const description = shop ? Object.entries(items).filter(([,item]) => item.cost).map(([key,item]) =>
    `• ${item.label} — ${profile.owned.includes(key) ? 'تم شراؤه' : `${item.cost} نقطة`}`).join('\n')
    : profile.owned.map(key => `• ${items[key].label}${key === profile.equipped ? ' · مفعّل' : ''}`).join('\n');
  const content = [notice, shop ? '**🛒 متجر الروليت**' : '**🎒 حقيبة الروليت**', `رصيدك: **${profile.points}** نقطة`, description,
    shop ? 'الإطارات تغيّر شكل بطاقة الفوز فقط. ما فيها فلوس حقيقية أو أفضلية باللعب.' : `كل فوز بالروليت يعطيك ${WIN_POINTS} نقاط.`].filter(Boolean).join('\n');
  return {content, components: choices.length ? [{type: 1, components: [{type: 3,
    custom_id: shop ? 'blgshop:buy' : 'blgshop:equip', placeholder: shop ? 'اختر إطارًا لشرائه' : 'اختر إطارًا لتفعيله',
    options: choices.map(key => ({label: items[key].label, value: key,
      description: shop ? `${items[key].cost} نقطة` : key === profile.equipped ? 'مفعّل' : 'في حقيبتك'}))}]}] : []};
}

module.exports = {items, WIN_POINTS, openRouletteShop, shopPanel};
