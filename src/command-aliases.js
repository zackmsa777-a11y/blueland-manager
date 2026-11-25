'use strict';

// Arabic slash commands are additional names for the existing handlers, not new permission paths.
const arabicNames = Object.freeze({
  ping: 'بنق', help: 'أوامر', server: 'سيرفر', roles: 'ر', promote: 'ترقية', dashboard: 'لوحة',
  warn: 'تحذير', unwarn: 'سحب-تحذير', warnings: 'تحذيرات', timeout: 'تايم', untimeout: 'فك-تايم',
  mute: 'ميوت', unmute: 'فك-ميوت', lock: 'قفل', unlock: 'فتح', kick: 'طرد', ban: 'بان', unban: 'فك-بان',
  request: 'طلب', ticket: 'تذكرة', rank: 'مستوى', points:'نقاطي', top: 'توب', game: 'ألعاب'
});
const arabicSubs = Object.freeze({
  request: Object.freeze({submit: 'تقديم', status: 'حالة', cancel: 'سحب', pending: 'معلقة', approve: 'قبول', reject: 'رفض'}),
  ticket: Object.freeze({create: 'فتح', claim: 'استلام', unclaim: 'ترك', close: 'إغلاق', reopen: 'إعادة-فتح'}),
  game: Object.freeze({roulette: 'روليت', chairs: 'كراسي', mafia: 'مافيا', rps: 'حجر-ورقة-مقص', bag: 'حقيبة', shop: 'متجر'})
});
const invert = values => new Map(Object.entries(values).map(([canonical, arabic]) => [arabic, canonical]));
const byName = invert(arabicNames);
const bySub = new Map(Object.entries(arabicSubs).map(([name, values]) => [name, invert(values)]));

function withArabicAliases(commands) {
  return [...commands, ...commands.map(command => {
    const name = arabicNames[command.name];
    if (!name) throw new Error(`Arabic alias missing for ${command.name}`);
    const names = arabicSubs[command.name];
    return {...command, name, options: command.options.map(option => {
      if (option.type !== 1) return option;
      if (!names?.[option.name]) throw new Error(`Arabic alias missing for ${command.name} ${option.name}`);
      return {...option, name: names[option.name]};
    })};
  })];
}

const commandName = name => byName.get(name) ?? name;
const subcommandName = (name, sub) => bySub.get(commandName(name))?.get(sub) ?? sub;

module.exports = {withArabicAliases, commandName, subcommandName};
