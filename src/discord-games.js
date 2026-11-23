'use strict';

const {randomInt, randomUUID} = require('node:crypto');
const {MessageFlags} = require('discord.js');
const {RuleError} = require('./ladder');
const {commandName, subcommandName} = require('./command-aliases');
const {games, moves, createGame, start, eligiblePlayers, choose, ready, advance,
  spinRoulette, stopRoulette, resolveRoulette} = require('./game-rules');
const {gamePanel, privateRole, voteMenu} = require('./game-view');
const {CHOICE_MS, roulettePage, rouletteChoice} = require('./roulette-round');
const {rouletteBanner, rouletteAvatar, rouletteBackdrop} = require('./roulette-media');
const {rouletteEmojis} = require('./roulette-emoji');
const {shopPanel} = require('./roulette-shop');

const privateReply = {flags: MessageFlags.Ephemeral, allowedMentions: {parse: []}};
const durations = {lobby: 180_000, chairs: 9_000, mafia: 35_000, rps: 25_000};
const playerName = i => i.member?.displayName || i.member?.nick || i.user.globalName || i.user.username;
const playerAvatar = i => {
  const options = {extension: 'png', size: 128, forceStatic: true};
  return i.member?.displayAvatarURL?.(options) || i.user.displayAvatarURL?.(options);
};

function createDiscordGames(economy) {
  const rooms = new Map();
  const active = game => rooms.get(game.room) === game;

  function release(game) {
    clearTimeout(game.timer);
    if (active(game)) rooms.delete(game.room);
  }

  function removeRoom(room) {
    const game = rooms.get(room);
    if (game) release(game);
  }

  function removeMessage(room, id) {
    const game = rooms.get(room);
    if (game?.message?.id === id) release(game);
  }

  function publish(game) {
    const version = ++game.version;
    game.edits = game.edits.then(async () => {
      if (version !== game.version) return;
      if (game.kind !== 'roulette') {
        await game.message.edit({...gamePanel(game), attachments: []});
        return;
      }
      const terminal = game.phase === 'done' || game.phase === 'cancelled';
      if (!active(game) && !terminal) return;
      const previous = game.message;
      if (game.phase === 'play' || game.phase === 'done') {
        const next = await previous.channel.send(gamePanel(game));
        game.message = next;
        void previous.edit({components: []}).catch(() => {});
      } else {
        await previous.edit(gamePanel(game, {includeLobbyImage: false}));
      }
    }).catch(err => {
      if (game.kind === 'roulette') {
        if (active(game)) cancel(game, 'تعذّر تحديث الروليت. افتح لعبة جديدة.');
      } else if ([10003, 10008, 50001, 50013].includes(err.code)) release(game);
    });
    return game.edits;
  }

  function cancel(game, reason) {
    game.phase = 'cancelled';
    game.endReason = reason;
    release(game);
    publish(game);
  }

  function rouletteTimer(game, delay, run) {
    clearTimeout(game.timer);
    const turn = game.round;
    game.timer = setTimeout(() => {
      if (active(game) && turn === game.round) run();
    }, delay);
    game.timer.unref();
  }

  function startSpin(game) {
    clearTimeout(game.timer);
    spinRoulette(game);
    const turn = game.round;
    const picked = game.roulettePlayer;
    game.rouletteAvatar = null;
    void rouletteAvatar(game.avatars.get(picked)).then(avatar => {
      if (active(game) && game.round === turn && game.roulettePlayer === picked) game.rouletteAvatar = avatar;
    });
    publish(game).then(() => {
      if (!active(game) || game.round !== turn || game.rouletteStage !== 'spin') return;
      rouletteTimer(game, 2_000, () => revealSpin(game));
    });
  }

  function revealSpin(game) {
    if (!stopRoulette(game)) return;
    const turn = game.round;
    const player = game.roulettePlayer;
    game.roulettePage = 0;
    game.rouletteDeadline = null;
    publish(game).then(() => {
      if (!active(game) || game.round !== turn || game.rouletteStage !== 'choose') return;
      game.rouletteDeadline = Date.now() + CHOICE_MS;
      rouletteTimer(game, CHOICE_MS, () => finishSpin(game, player, 'idle'));
    });
  }

  function finishSpin(game, user, action, target) {
    const picked = game.roulettePlayer;
    if (!resolveRoulette(game, user, action, target)) return false;
    game.rouletteDecision = {actor: user, action};
    clearTimeout(game.timer);
    if (game.phase === 'done') {
      release(game);
      try {
        game.winnerStyle = economy?.profile(game.winner).equipped;
        game.winnerReward = economy?.award(game.id, game.winner) || 0;
      } catch (err) {
        console.error('Unable to save roulette reward:', err.message);
      }
      const showWinner = avatar => {
        game.winnerAvatar = avatar;
        publish(game);
      };
      if (game.winner === picked && game.rouletteAvatar) showWinner(game.rouletteAvatar);
      else void rouletteAvatar(game.avatars.get(game.winner)).then(showWinner);
    } else startSpin(game);
    return true;
  }

  function round(game) {
    if (!active(game)) return;
    if (game.kind === 'mafia') {
      game.idleRounds = game.choices.size === 0 ? game.idleRounds + 1 : 0;
      if (game.idleRounds >= 4) {
        cancel(game, 'انتهى الوقت من غير مشاركة كافية.');
        return;
      }
    }
    advance(game);
    if (game.phase === 'cancelled') {
      cancel(game, 'انتهى الوقت من غير مشاركة كافية.');
      return;
    }
    if (game.phase === 'done') release(game);
    else schedule(game);
    publish(game);
  }

  function schedule(game) {
    clearTimeout(game.timer);
    const lobby = game.phase === 'lobby';
    const music = !lobby && game.kind === 'chairs';
    const delay = lobby ? durations.lobby : music ? randomInt(3_000, 7_001) : durations[game.kind];
    game.music = music;
    game.timer = setTimeout(() => {
      if (!active(game)) return;
      if (lobby) cancel(game, 'انتهت مهلة التسجيل.');
      else if (music) {
        game.music = false;
        game.timer = setTimeout(() => round(game), durations.chairs);
        game.timer.unref();
        publish(game);
      } else round(game);
    }, delay);
    game.timer.unref();
  }

  async function open(i, kind) {
    if (!Object.hasOwn(games, kind)) throw new RuleError('اختر لعبة من أمر /game.');
    if (rooms.has(i.channelId)) throw new RuleError('في لعبة مفتوحة في الروم. انضم لها أو انتظر نهايتها.');
    const game = Object.assign(createGame(kind, i.user.id, playerName(i)), {
      id: randomUUID(), room: i.channelId, idleRounds: 0, version: 0, edits: Promise.resolve(),
      avatars: new Map([[i.user.id, playerAvatar(i)]])
    });
    rooms.set(game.room, game);
    try {
      await i.deferReply();
      if (kind === 'roulette') {
        const [banner, emojis, backdrop] = await Promise.all([rouletteBanner(i.client), rouletteEmojis(i.guild), rouletteBackdrop(i.client)]);
        game.rouletteBanner = banner;
        game.rouletteEmojis = emojis;
        game.rouletteBackdrop = backdrop;
      }
      game.message = await i.editReply(gamePanel(game));
      if (active(game)) schedule(game);
    } catch (err) {
      release(game);
      throw err;
    }
  }

  async function component(i) {
    const game = rooms.get(i.channelId);
    const [, id, roundId, action] = i.customId.split(':');
    const user = i.user.id;
    const fail = content => i.reply({...privateReply, content});
    const select = action === 'target';
    if (!game?.message || game.id !== id || String(game.round) !== roundId ||
        (select ? !i.isStringSelectMenu() : !i.isButton() || game.message.id !== i.message.id)) {
      return fail('هذي اللوحة أو الجولة انتهت. استخدم اللوحة الحالية.');
    }
    const lobby = game.phase === 'lobby';
    if (action === 'cancel') {
      if (user !== game.host) return fail('مضيف اللعبة هو اللي يقدر يلغيها.');
      const ack = i.deferUpdate();
      cancel(game, 'المضيف ألغى اللعبة.');
      return ack;
    }
    if (lobby) {
      const {min, max} = games[game.kind];
      if (action === 'join') {
        if (game.players.has(user)) return fail('أنت مسجل في اللعبة.');
        if (game.players.size >= max) return fail('اكتمل عدد اللاعبين.');
        game.players.set(user, playerName(i));
        game.avatars.set(user, playerAvatar(i));
      } else if (action === 'leave') {
        if (user === game.host) return fail('استخدم زر إلغاء لو حاب تقفل تسجيل اللعبة.');
        if (!game.players.delete(user)) return fail('أنت مو مسجل في اللعبة.');
        game.avatars.delete(user);
      } else if (action === 'start') {
        if (user !== game.host) return fail('مضيف اللعبة هو اللي يبدأها.');
        if (game.players.size < min) return fail(`اللعبة تحتاج ${min} لاعبين على الأقل.`);
        const ack = i.deferUpdate();
        start(game);
        if (game.kind === 'roulette') startSpin(game);
        else {
          schedule(game);
          publish(game);
        }
        return ack;
      } else return fail('اللعبة ما بدأت لسه.');
      const ack = i.deferUpdate();
      publish(game);
      return ack;
    }
    if (game.kind === 'roulette') {
      if (game.rouletteStage !== 'choose' || user !== game.roulettePlayer) return fail('الاختيار للاعب اللي وقفت عليه العجلة بس.');
      if (game.rouletteDeadline === null) return fail('انتظر ظهور لوحة الاختيار.');
      if (Date.now() >= game.rouletteDeadline) {
        finishSpin(game, user, 'idle');
        return fail('انتهت مهلة الاختيار.');
      }
      const {page, count, targets} = roulettePage(game);
      const detail = i.customId.split(':')[4];
      if (action === 'roulette-prev' || action === 'roulette-next') {
        const next = page + (action === 'roulette-next' ? 1 : -1);
        if (detail !== String(page) || next < 0 || next >= count) return fail('هذه الصفحة تغيّرت أو ما فيه صفحة ثانية بهذا الاتجاه.');
        const ack = i.deferUpdate();
        game.roulettePage = next;
        const version = game.version;
        game.edits = game.edits.then(async () => {
          if (active(game) && version === game.version) {
            await game.message.edit({...rouletteChoice(game), allowedMentions: {parse: []}});
          }
        }).catch(() => {
          if (active(game) && version === game.version) game.roulettePage = page;
        });
        return ack;
      }
      const choice = {'roulette-target': 'kick', 'roulette-leave': 'leave', 'roulette-random': 'random'}[action];
      if (!choice || (choice === 'kick' && !targets.includes(detail)) || !finishSpin(game, user, choice, detail)) {
        return fail('الاختيار غير متاح في هذي الصفحة أو الجولة.');
      }
      return i.deferUpdate();
    }
    if (game.kind === 'mafia' && action === 'role') {
      if (!game.players.has(user)) return fail('بطاقات الأدوار للاعبين المسجلين.');
      return i.reply({...privateReply, ...privateRole(game, user)});
    }
    if (game.kind === 'mafia' && (action === 'vote' || action === 'target')) {
      if (!eligiblePlayers(game).includes(user)) return fail('التصويت غير متاح لك في هذي المرحلة.');
      if (game.choices.has(user)) return fail('صوتك مسجل لهذي المرحلة.');
      if (action === 'vote') return i.reply({...privateReply, ...voteMenu(game, user)});
      if (!choose(game, user, i.values[0])) return fail('الاختيار غير متاح في هذي الجولة.');
      const ack = i.update({content: 'تم تسجيل صوتك.', components: []});
      if (ready(game)) round(game);
      return ack;
    }
    const seat = game.kind === 'chairs' && action === 'sit';
    const duel = game.kind === 'rps' && Object.hasOwn(moves, action);
    if (!seat && !duel) return fail('الزر غير متاح في هذي الجولة.');
    if (seat && game.music) return fail('انتظر توقف الموسيقى حتى تحجز كرسي.');
    if (!choose(game, user, action)) return fail('هذا الاختيار غير متاح لك أو سبق وسجلته في هذي الجولة.');
    const ack = i.deferUpdate();
    if (ready(game)) round(game);
    else if (seat) publish(game);
    return ack;
  }

  async function economyAction(i, action) {
    if (!economy) throw new RuleError('متجر الروليت غير متاح حاليًا.');
    const user = i.user.id;
    if (action === 'buy' || action === 'equip') {
      const key = i.values?.[0];
      const profile = action === 'buy' ? economy.buy(user,key) : economy.equip(user,key);
      const text = action === 'buy' ? 'تم الشراء وتفعيل الإطار.' : 'تم تفعيل الإطار.';
      return i.update({...shopPanel(action === 'buy' ? 'shop' : 'bag', profile, text), allowedMentions: {parse: []}});
    }
    return i.reply({...privateReply, ...shopPanel(action, economy.profile(user))});
  }

  async function handle(i) {
    const opening = i.isChatInputCommand() && commandName(i.commandName) === 'game';
    const kind = opening ? subcommandName('game', i.options.getSubcommand(false)) : null;
    const key = opening ? `blgshop:${kind}` : i.customId;
    const opensShop = (opening || i.isButton()) && ['blgshop:bag', 'blgshop:shop'].includes(key);
    const changesShop = i.isStringSelectMenu() && ['blgshop:buy', 'blgshop:equip'].includes(key);
    const shop = opensShop || changesShop;
    const control = (i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('blg:');
    if (!opening && !control && !shop) return false;
    try {
      if (shop) await economyAction(i, key.slice('blgshop:'.length));
      else await (opening ? open(i, kind) : component(i));
    } catch (err) {
      const content = err instanceof RuleError ? err.message : 'تعذّر إتمام خطوة اللعبة. حاول مرة ثانية.';
      if (opening && (i.deferred || i.replied)) await i.editReply({content}).catch(() => {});
      else if (i.deferred || i.replied) await i.followUp({...privateReply, content}).catch(() => {});
      else await i.reply({...privateReply, content}).catch(() => {});
    }
    return true;
  }

  async function openShortcut(message,kind) {
    if (kind==='shop'||kind==='bag') {
      if (!economy) throw new RuleError('متجر الروليت غير متاح حاليًا.');
      try {await message.author.send({...shopPanel(kind,economy.profile(message.author.id)),allowedMentions:{parse:[]}});}
      catch {throw new RuleError('افتح الخاص أو استخدم /game '+kind+' عشان تشوفه بشكل خاص.');}
      return;
    }
    return open({
      channelId:message.channelId,user:message.author,member:message.member,client:message.client,guild:message.guild,
      deferReply:async()=>{},editReply:payload=>message.reply({...payload,allowedMentions:{...payload.allowedMentions,repliedUser:false}})
    },kind);
  }

  return {handle, openShortcut, removeMessage, removeRoom};
}

module.exports = {createDiscordGames};
