'use strict';

// Original BlueLand roulette artwork supplied in Discord. Resolve a fresh CDN URL;
// signed attachment URLs expire. The renderer has a bundled fallback.
const sourceChannel = '1574014085027209308';
const sourceMessage = '1574140600251580426';
const artworkId = '1574140599450345533';
const hosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');
let bannerPromise;

function bounded(signal, work) {
  if (signal.aborted) return Promise.resolve(null);
  let onAbort;
  const abort = new Promise(resolve => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, {once: true});
  });
  return Promise.race([Promise.resolve().then(work).catch(() => null), abort])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

async function pngFromCdn(raw, pathCheck, {limit, side, signal}) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password || !pathCheck(url.pathname)) return null;
  const response = await fetch(url, {redirect: 'error', signal});
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'image/png' ||
      Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  const png = Buffer.concat(chunks, total);
  if (total < 33 || !png.subarray(0, 8).equals(pngMagic) || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > side || height > side) return null;
  return `data:image/png;base64,${png.toString('base64')}`;
}

function rouletteBanner(client) {
  if (!client?.channels?.fetch) return Promise.resolve(null);
  if (!bannerPromise) {
    const signal = AbortSignal.timeout(2200);
    bannerPromise = bounded(signal, async () => {
      const channel = await client.channels.fetch(sourceChannel);
      const message = await channel?.messages?.fetch({message: sourceMessage, cache: false, force: true});
      const file = message?.attachments.get(artworkId);
      if (!file) return null;
      return pngFromCdn(file.url, path => path === `/attachments/${sourceChannel}/${artworkId}/IMG_3468.png`,
        {limit: 2_000_000, side: 4096, signal});
    }).then(result => {
      if (!result) bannerPromise = null;
      return result;
    });
  }
  return bannerPromise;
}

function rouletteAvatar(url) {
  if (!url) return Promise.resolve(null);
  const signal = AbortSignal.timeout(1600);
  const allowed = /^(?:\/(?:avatars\/\d+|guilds\/\d+\/users\/\d+\/avatars)\/(?:a_)?[a-f0-9]{32}|\/embed\/avatars\/\d+)\.png$/i;
  return bounded(signal, () => pngFromCdn(url, path => allowed.test(path), {limit: 350_000, side: 256, signal}));
}

module.exports = {rouletteBanner, rouletteAvatar};
