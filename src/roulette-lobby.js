'use strict';

const {RuleError} = require('./ladder');
const DEFAULT_LOBBY_MS = 60_000;

function parseLobbyDuration(text) {
  const value = /^(\d{1,4})([ms])$/iu.exec(text);
  const ms = value ? Number(value[1]) * (value[2].toLowerCase() === 'm' ? 60_000 : 1000) : 0;
  if (ms < 10_000 || ms > 30 * 60_000) throw new RuleError('اكتب `.روليت` لدقيقة، أو مدة من 10 ثوانٍ إلى 30 دقيقة، مثل `.روليت 30s` أو `.روليت 10m`.');
  return ms;
}

function lobbyCountdown(deadline, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

function lobbyRefreshDelay(remaining) {
  if (remaining > 60_000) return Math.min(10_000, remaining - 60_000);
  if (remaining > 10_000) return Math.min(5000, remaining - 10_000);
  return Math.max(1, Math.min(1000, remaining));
}

module.exports = {DEFAULT_LOBBY_MS, parseLobbyDuration, lobbyCountdown, lobbyRefreshDelay};
