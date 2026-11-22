'use strict';

const {randomInt, randomUUID} = require('node:crypto');
const {MessageFlags} = require('discord.js');
const {RuleError} = require('./ladder');
const {games, moves, createGame, start, eligiblePlayers, choose, ready, advance} = require('./game-rules');
const {gamePanel, privateRole, voteMenu} = require('./game-view');

const privateReply = {flags: MessageFlags.Ephemeral, allowedMentions: {parse: []}};
const durations = {lobby: 180_000, roulette: 5_000, chairs: 9_000, mafia: 35_000, rps: 25_000};
const playerName = i => i.member?.displayName || i.member?.nick || i.user.globalName || i.user.username;

function createDiscordGames() {
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
    const panel = {...gamePanel(game), attachments: []};
    const version = ++game.version;
    game.edits = game.edits.then(async () => {
      if (version !== game.version) return;
      await game.message.edit(panel);
    }).catch(err => {
      if ([10003, 10008, 50001, 50013].includes(err.code)) release(game);
    });
  }

  function cancel(game, reason) {
    game.phase = 'cancelled';
    game.endReason = reason;
    release(game);
    publish(game);
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

  async function open(i) {
    const kind = i.options.getSubcommand();
    if (!Object.hasOwn(games, kind)) throw new RuleError('اختر لعبة من أمر /game.');
    if (rooms.has(i.channelId)) throw new RuleError('في لعبة مفتوحة في الروم. انضم لها أو انتظر نهايتها.');
    const game = Object.assign(createGame(kind, i.user.id, playerName(i)), {
      id: randomUUID(), room: i.channelId, idleRounds: 0, version: 0, edits: Promise.resolve()
    });
    rooms.set(game.room, game);
    try {
      await i.deferReply();
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
    if (!game?.message || game.id !== id || String(game.round) !== roundId ||
        (action === 'target' ? !i.isStringSelectMenu() : !i.isButton() || game.message.id !== i.message.id)) {
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
      } else if (action === 'leave') {
        if (user === game.host) return fail('استخدم زر إلغاء لو حاب تقفل تسجيل اللعبة.');
        if (!game.players.delete(user)) return fail('أنت مو مسجل في اللعبة.');
      } else if (action === 'start') {
        if (user !== game.host) return fail('مضيف اللعبة هو اللي يبدأها.');
        if (game.players.size < min) return fail(`اللعبة تحتاج ${min} لاعبين على الأقل.`);
        start(game);
        schedule(game);
      } else return fail('اللعبة ما بدأت لسه.');
      const ack = i.deferUpdate();
      publish(game);
      return ack;
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

  async function handle(i) {
    const opening = i.isChatInputCommand() && i.commandName === 'game';
    const control = (i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('blg:');
    if (!opening && !control) return false;
    try {
      await (opening ? open(i) : component(i));
    } catch (err) {
      const content = err instanceof RuleError ? err.message : 'تعذّر إتمام خطوة اللعبة. حاول مرة ثانية.';
      if (opening && (i.deferred || i.replied)) await i.editReply({content}).catch(() => {});
      else if (i.deferred || i.replied) await i.followUp({...privateReply, content}).catch(() => {});
      else await i.reply({...privateReply, content}).catch(() => {});
    }
    return true;
  }

  return {handle, removeMessage, removeRoom};
}

module.exports = {createDiscordGames};
