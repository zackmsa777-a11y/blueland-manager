'use strict';

const { createHash } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType, DiscordAPIError, EmbedBuilder,
  MessageFlags, MessagePayload, RateLimitError, Routes } = require('discord.js');
const { createTempVoiceUi } = require('./lxr-temp-voice-panel-ui');

const PREFIX = 'lxr-temp-voice:';
const SOURCE_CHANNEL = '1574640612500578495';
const SOURCE_MESSAGE = '1575844663921872966';
const SOURCE_ATTACHMENT = '1575844663250919444';
const PUBLISHER = '1486306919324057682';
const GUIDE_NAME = 'tempvoice-guide.png';
const LEGACY_GUIDE_NAME = 'tempvoice-guide-1.png';
const LEGACY_PUBLIC_MESSAGE = '1575842951056195664';
const GUIDE_SIZE = 59175;
const GUIDE_SHA256 = 'c9093d66153179dc82fcfecd9836846c016cb1789085772aec0ea9a70cf543a5';
const CATEGORY = '1574893689082224660';
const LOBBY = '1575147982381129748';
const NO_MENTIONS = { parse: [], repliedUser: false };
const TITLE = 'واجهة التحكم بالرومات الصوتية';
const DESCRIPTION = 'استخدم الأزرار أدناه لإدارة رومك الصوتي المؤقت. يوضّح الدليل وظيفة كل زر حسب ترتيب ظهوره.';
const FOOTER = 'ادخل رومك الصوتي المؤقت أولاً، ثم اضغط الزر المناسب.';
const DISABLED = new Set(['waiting', 'trust', 'untrust', 'block', 'unblock', 'chat']);
const BUTTONS = [
  [['name', 'تغيير إسم', '✏️'], ['limit', 'حد عدد الاعضاء', '👥'], ['privacy', 'قفل وفتح الدخول', '🔒'],
    ['waiting', 'غرفة الانتظار', '🕒'], ['trust', 'الثقة', '➕']],
  [['untrust', 'عدم الثقة', '➖'], ['invite', 'دعوة', '📞'], ['disconnect', 'طرد', '📵'],
    ['region', 'تغيير منطقة', '🌐'], ['block', 'حظر', '🚫']],
  [['unblock', 'رفع الحظر', '🔓'], ['claim', 'اخذ الملكية', '👑'], ['transfer', 'نقل ملكية', '📝'],
    ['delete', 'حذف', '🗑️', ButtonStyle.Danger], ['chat', 'دردشة', '💬']],
];
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const layout = emojis => BUTTONS.map(row => new ActionRowBuilder().addComponents(row.map(
  ([kind, , , style = ButtonStyle.Secondary]) => new ButtonBuilder().setCustomId(PREFIX + kind)
    .setEmoji(emojis[kind]).setStyle(style).setDisabled(DISABLED.has(kind)))));
const publicIds = new Set(BUTTONS.flat().map(([kind]) => PREFIX + kind));

function cdnUrl(value, channelId, name, attachmentId, allowProxy = false) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/');
    if ((url.origin === 'https://cdn.discordapp.com' || (allowProxy && url.origin === 'https://media.discordapp.net')) &&
        !url.username && !url.password && !url.hash &&
        parts.length === 5 && parts[1] === 'attachments' && parts[2] === channelId && snowflake(parts[3]) &&
        (attachmentId === undefined || parts[3] === attachmentId) && parts[4] === name) {
      // Hash the original file, never a proxy resize/transcode.
      const canonical = new URL(url.pathname, 'https://cdn.discordapp.com');
      for (const key of ['ex', 'is', 'hm']) {
        const values = url.searchParams.getAll(key);
        if (values.length > 1) return null;
        if (values.length) canonical.searchParams.set(key, values[0]);
      }
      return canonical;
    }
  } catch { /* invalid URL */ }
  return null;
}

async function download(url, fetchImage, sha256) {
  let response;
  try {
    response = await fetchImage(url.href, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    // Transport errors may include the signed attachment URL.
    throw new Error('Temporary voice guide download failed');
  }
  if (!response?.ok || response.redirected || !response.body) throw new Error('Temporary voice guide download failed');
  const bytes = Buffer.alloc(GUIDE_SIZE);
  let offset = 0;
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array) || chunk.length > GUIDE_SIZE - offset) throw new Error('Invalid size');
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  } catch {
    throw new Error('Temporary voice guide stream failed');
  }
  if (offset !== GUIDE_SIZE || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('Temporary voice guide integrity check failed');
  }
  return bytes;
}

const guideUrl = (item, channelId, name) => item?.filename === name && item.size === GUIDE_SIZE && snowflake(item.id)
  ? cdnUrl(item.url, channelId, name, item.id) : null;

async function fetchPinnedGuide(rest, fetchImage, sha256) {
  const source = await rest.get(Routes.channelMessage(SOURCE_CHANNEL, SOURCE_MESSAGE));
  const matches = source?.attachments?.filter(a => a?.id === SOURCE_ATTACHMENT);
  const url = matches?.length === 1 && guideUrl(matches[0], SOURCE_CHANNEL, GUIDE_NAME);
  if (source?.id !== SOURCE_MESSAGE || source.channel_id !== SOURCE_CHANNEL || source.author?.id !== PUBLISHER ||
      source.author.bot || source.webhook_id || !url) throw new Error('Pinned temporary voice guide was not verified');
  return download(url, fetchImage, sha256);
}

function marked(message, botId) {
  return message?.author?.id === botId && message.components?.some(row =>
    row.type === ComponentType.ActionRow && row.components?.some(c => publicIds.has(c.custom_id)));
}

const authored = (message, channelId, botId) => snowflake(message?.id) && message.channel_id === channelId &&
  message.author?.id === botId && message.author.bot === true && !message.webhook_id && !message.content;

function exactLegacy(message, channelId, botId) {
  if (!authored(message, channelId, botId) || message.embeds?.length || message.flags !== MessageFlags.IsComponentsV2 ||
      !Array.isArray(message.attachments) || message.attachments.length > 1 || message.components?.length !== BUTTONS.length + 1) return null;
  const [gallery, ...rows] = message.components;
  const item = message.attachments[0];
  const art = gallery?.items?.[0]?.media?.url;
  const url = item ? guideUrl(item, channelId, LEGACY_GUIDE_NAME) : cdnUrl(art, channelId, LEGACY_GUIDE_NAME);
  if (!url || gallery.type !== ComponentType.MediaGallery || gallery.items?.length !== 1 || (item &&
      art !== `attachment://${LEGACY_GUIDE_NAME}` && !cdnUrl(art, channelId, LEGACY_GUIDE_NAME, item.id))) return null;
  const match = BUTTONS.every((row, r) => rows[r]?.type === ComponentType.ActionRow && rows[r].components?.length === row.length &&
    row.every(([kind, label, emoji, style = ButtonStyle.Secondary], c) => {
      const actual = rows[r].components[c];
      return actual?.type === ComponentType.Button && actual.custom_id === PREFIX + kind && actual.label === label &&
        actual.emoji?.name === emoji && !actual.emoji.id && actual.style === style && Boolean(actual.disabled) === DISABLED.has(kind) &&
        !actual.url && !actual.sku_id;
    }));
  return match ? url : null;
}

const onlyKeys = (object, keys) => Object.keys(object).every(key => keys.includes(key));

function exactEmbed(message, channelId, botId, emojis) {
  if (!authored(message, channelId, botId) || (message.flags !== undefined && message.flags !== 0) ||
      !Array.isArray(message.embeds) || message.embeds.length !== 1 || message.components?.length !== BUTTONS.length ||
      (message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length > 1))) return null;
  const [embed] = message.embeds;
  if (embed?.title !== TITLE || embed.description !== DESCRIPTION || embed.footer?.text !== FOOTER ||
      (embed.type !== undefined && embed.type !== 'rich') || !onlyKeys(embed, ['type', 'title', 'description', 'footer', 'image']) ||
      !onlyKeys(embed.footer, ['text']) || !embed.image) return null;
  const item = message.attachments?.[0];
  const linked = item && guideUrl(item, channelId, GUIDE_NAME);
  if (item && !linked) return null;
  const proxy = embed.image.proxy_url;
  const proxyImage = proxy === undefined ? null : cdnUrl(proxy, channelId, GUIDE_NAME, item?.id, true);
  const art = embed.image.url;
  const image = art === `attachment://${GUIDE_NAME}` ? linked || proxyImage : cdnUrl(art, channelId, GUIDE_NAME, item?.id, true);
  if ((art !== undefined && !image) || (proxy !== undefined && (!proxyImage || (image && proxyImage.pathname !== image.pathname)))) return null;
  const url = linked || image || proxyImage;
  if (!url) return null;
  return BUTTONS.every((row, r) => {
    const actual = message.components[r];
    return actual?.type === ComponentType.ActionRow && actual.components?.length === row.length &&
      row.every(([kind, , , style = ButtonStyle.Secondary], c) => {
        const button = actual.components[c];
        return button?.type === ComponentType.Button && button.custom_id === PREFIX + kind && button.label === undefined &&
          button.emoji?.id === emojis[kind].id && button.emoji?.name === emojis[kind].name && !button.emoji?.animated &&
          button.style === style && Boolean(button.disabled) === DISABLED.has(kind) && !button.url && !button.sku_id;
      });
  }) ? url : null;
}

function exactRestRoute(error, method, route) {
  if (error.method !== method) return false;
  try {
    const url = new URL(error.url);
    return url.origin === 'https://discord.com' && !url.username && !url.password && !url.hash && !url.search &&
      /^\/api\/v\d+\//u.test(url.pathname) && url.pathname.replace(/^\/api\/v\d+/u, '') === route;
  } catch { return false; }
}

function exactThrottle(error, method, channelId, route) {
  return error instanceof RateLimitError && error.majorParameter === channelId && exactRestRoute(error, method, route);
}

function createTempVoicePanel({ guildId, panelId, readyGuild, getWriter, actions, state, fetchImage = fetch, guideSha256 = GUIDE_SHA256,
  categoryId = CATEGORY, lobbyId = LOBBY, now, frameTtlMs, getEmojis }) {
  const retirementNow = now ?? Date.now;
  const verified = new Map();
  const pending = new Map();
  const uncertain = new Set();
  let provider = getEmojis;

  async function emojiMap(guild, provision = false) {
    provider ??= require('./lxr-temp-voice-emoji').createTempVoiceEmojiProvider({ state, getWriter, fetchImage });
    const result = await (!provision && provider.resolve ? provider.resolve(guild) : provider(guild));
    const emojis = Object.create(null), ids = new Set(), names = new Set();
    for (const [kind] of BUTTONS.flat()) {
      const emoji = result?.[kind];
      if (!snowflake(emoji?.id) || typeof emoji.name !== 'string' || !/^\w{2,32}$/.test(emoji.name) ||
          ids.has(emoji.id) || names.has(emoji.name) || emoji.animated) throw new Error('Temporary voice panel emojis not verified');
      ids.add(emoji.id);
      names.add(emoji.name);
      emojis[kind] = { id: emoji.id, name: emoji.name };
    }
    return emojis;
  }

  async function checkLayout(guild, channelId, message, emojis) {
    const botId = guild.client.user.id;
    const legacy = exactLegacy(message, channelId, botId);
    if (legacy) return { format: 'v1', url: legacy };
    if (!authored(message, channelId, botId) || message.embeds?.[0]?.title !== TITLE) return null;
    const embed = exactEmbed(message, channelId, botId, emojis ?? await emojiMap(guild));
    return embed ? { format: 'embed', url: embed } : null;
  }

  async function verifyMessage(guild, channelId, messageId, expected, emojis) {
    const checked = await guild.client.rest.get(Routes.channelMessage(channelId, messageId));
    const layout = checked?.id === messageId && await checkLayout(guild, channelId, checked, emojis);
    const url = layout?.url;
    if (expected && layout?.format !== expected) throw new Error('Temporary voice panel message failed verification');
    if (!url) throw new Error('Temporary voice panel message failed verification');
    const previouslyVerified = verified.get(channelId)?.[layout.format];
    if (previouslyVerified?.messageId !== messageId || previouslyVerified.attachmentPath !== url.pathname) {
      await download(url, fetchImage, guideSha256);
    }
    const known = verified.get(channelId) ?? {};
    verified.delete(channelId);
    if (verified.size >= 512) verified.delete(verified.keys().next().value);
    known[layout.format] = { messageId, attachmentPath: url.pathname };
    verified.set(channelId, known);
    if (layout.format === 'embed') uncertain.delete(channelId);
    return messageId;
  }

  async function getGuild() {
    const guild = await readyGuild();
    if (guild?.id !== guildId || !snowflake(guild.client?.user?.id)) throw new Error('Invalid temporary voice guild');
    return guild;
  }

  async function assertChannel(guild, channelId, voice) {
    const validId = snowflake(channelId) && (voice ? channelId !== panelId && channelId !== lobbyId : channelId === panelId);
    if (!validId) throw new Error('Invalid temporary voice panel route');
    const channel = await guild.client.rest.get(Routes.channel(channelId));
    if (channel?.id !== channelId || channel.guild_id !== guild.id ||
        channel.type !== (voice ? ChannelType.GuildVoice : ChannelType.GuildText) ||
        (voice && channel.parent_id !== categoryId)) throw new Error('Invalid temporary voice panel channel');
  }

  async function recover(guild, channelId, emojis) {
    const rest = guild.client.rest;
    const candidates = {};
    let before;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const messages = await rest.get(Routes.channelMessages(channelId), { query });
      if (!Array.isArray(messages) || messages.length > 100 || messages.some(m =>
        !snowflake(m?.id) || m.channel_id !== channelId || (before && BigInt(m.id) >= BigInt(before)))) {
        throw new Error('Temporary voice panel history could not be verified');
      }
      for (const message of messages) {
        const pinnedLegacy = channelId === panelId && message.id === LEGACY_PUBLIC_MESSAGE;
        if (!pinnedLegacy && !marked(message, guild.client.user.id)) continue;
        const layout = await checkLayout(guild, channelId, message, emojis);
        if (!layout || candidates[layout.format] || (channelId === panelId && pinnedLegacy !== (layout.format === 'v1'))) {
          throw new Error('Temporary voice panel history conflicts with expected panel');
        }
        candidates[layout.format] = message.id;
      }
      if (messages.length < 100) {
        for (const format of ['v1', 'embed']) {
          if (candidates[format]) await verifyMessage(guild, channelId, candidates[format], format, emojis);
        }
        return candidates;
      }
      before = messages.reduce((minimum, m) => BigInt(m.id) < BigInt(minimum) ? m.id : minimum, messages[0].id);
    }
    throw new Error('Temporary voice panel history scan limit reached');
  }

  function assertManaged(channelId, voice) {
    if (voice && state && state.get(channelId)?.id !== channelId) throw new Error('Temporary voice panel destination is not managed');
  }

  async function finishMigration(guild, channelId, voice, legacyId, embedId, suppliedWriter, emojis) {
    const record = state?.getPanelRetirement?.(channelId, voice);
    if (!legacyId && !record) return embedId;
    const unconfirmed = () => new Error('Previous temporary voice panel deletion not confirmed');
    const oldId = record?.legacyId ?? legacyId;
    if (record && (record.embedId !== embedId || (legacyId && legacyId !== oldId))) throw unconfirmed();
    if (record?.settled) {
      if (legacyId) throw unconfirmed();
      return embedId;
    }
    const route = Routes.channelMessage(channelId, oldId);
    const key = [channelId, voice, oldId, embedId];
    if (legacyId && !record?.attempt && (record?.retryAt ?? 0) <= retirementNow()) {
      if (!state?.beginPanelRetirement) throw unconfirmed();
      const writer = suppliedWriter ?? await getWriter();
      if (typeof writer?.delete !== 'function') throw unconfirmed();
      await assertChannel(guild, channelId, voice);
      assertManaged(channelId, voice);
      await verifyMessage(guild, channelId, oldId, 'v1');
      await verifyMessage(guild, channelId, embedId, 'embed', emojis);
      assertManaged(channelId, voice);
      // Reserve only after verifying both messages. An ambiguous attempt never
      // permits another DELETE, even if a later GET still sees the old message.
      const attempt = state.beginPanelRetirement(...key, retirementNow());
      if (attempt) {
        try { await writer.delete(route, { auth: true }); } catch (error) {
          if (exactThrottle(error, 'DELETE', channelId, route)) {
            const delay = Math.max(1_000, ...[error.retryAfter, error.timeToReset, error.sublimitTimeout].filter(Number.isFinite));
            const retryAt = retirementNow() + Math.ceil(delay);
            if (Number.isSafeInteger(retryAt)) state.deferPanelRetirement(...key, attempt, retryAt);
          }
        }
      }
    }
    // History omission and a write acknowledgement are not proof of absence.
    try { await guild.client.rest.get(route, { auth: true }); } catch (error) {
      if (!(error instanceof DiscordAPIError) || error.status !== 404 || error.code !== 10008 ||
          !exactRestRoute(error, 'GET', route) || !state?.settlePanelRetirement(...key)) throw unconfirmed();
      const known = verified.get(channelId);
      if (known?.v1?.messageId === oldId) delete known.v1;
      return embedId;
    }
    throw unconfirmed();
  }

  async function send(guild, channelId, voice, onlyLegacy) {
    await assertChannel(guild, channelId, voice);
    assertManaged(channelId, voice);
    const existing = await recover(guild, channelId);
    if (existing.embed) return finishMigration(guild, channelId, voice, existing.v1, existing.embed);
    if (state?.getPanelRetirement?.(channelId, voice)) throw new Error('Temporary voice replacement not verified');
    if (onlyLegacy && !existing.v1) return null;
    if (uncertain.has(channelId) || uncertain.size >= 128) throw new Error('Temporary voice panel publication not confirmed');
    const image = await fetchPinnedGuide(guild.client.rest, fetchImage, guideSha256);
    const emojis = await emojiMap(guild, true);
    const embed = new EmbedBuilder().setTitle(TITLE).setDescription(DESCRIPTION)
      .setImage(`attachment://${GUIDE_NAME}`).setFooter({ text: FOOTER });
    const payload = MessagePayload.create({ client: guild.client }, {
      embeds: [embed], components: layout(emojis), files: [{ attachment: image, name: GUIDE_NAME }],
      nonce: `e:${channelId}`, enforceNonce: true, allowedMentions: NO_MENTIONS,
    }).resolveBody();
    await payload.resolveFiles();
    const writer = await getWriter();
    if (typeof writer?.post !== 'function') throw new Error('Temporary voice panel writer unavailable');
    await assertChannel(guild, channelId, voice);
    assertManaged(channelId, voice);
    if (state?.reservePanelPublication && state.reservePanelPublication(channelId, voice, 'embed') !== true) {
      throw new Error('Temporary voice panel publication not confirmed');
    }
    if (uncertain.size >= 128) throw new Error('Temporary voice panel publication not confirmed');
    if (!state?.reservePanelPublication) uncertain.add(channelId);
    const route = Routes.channelMessages(channelId);
    let posted, confirmed;
    try {
      posted = await writer.post(route, { body: payload.body, files: payload.files });
    } catch (error) {
      // Only a definitive rejection from the exact POST can release its durable reservation.
      // A readback failure, including its own 429, is not a refusal of the write.
      if (exactThrottle(error, 'POST', channelId, route)) {
        if (state?.reservePanelPublication) state.releasePanelPublication?.(channelId, voice, 'embed');
        else uncertain.delete(channelId);
        throw new Error('Temporary voice panel publication not confirmed');
      }
    }
    if (snowflake(posted?.id)) {
      try { confirmed = await verifyMessage(guild, channelId, posted.id, 'embed', emojis); } catch { /* reconcile without replaying */ }
    }
    if (confirmed) return finishMigration(guild, channelId, voice, existing.v1, confirmed, writer, emojis);
    const recovered = await recover(guild, channelId, emojis).catch(() => null);
    if (recovered?.embed) return finishMigration(guild, channelId, voice, recovered.v1, recovered.embed, writer, emojis);
    throw new Error('Temporary voice panel publication not confirmed');
  }

  function sendOnce(guild, channelId, voice, onlyLegacy = false) {
    if (pending.has(channelId)) return pending.get(channelId);
    const task = send(guild, channelId, voice, onlyLegacy).then(id => {
      const known = verified.get(channelId);
      if (id && known?.embed?.messageId === id) known.complete = true;
      return id;
    }).finally(() => pending.delete(channelId));
    pending.set(channelId, task);
    return task;
  }

  async function verifySource(guild, channelId, messageId) {
    const voice = channelId !== panelId;
    await assertChannel(guild, channelId, voice);
    assertManaged(channelId, voice);
    await verifyMessage(guild, channelId, messageId);
  }
  verifySource.known = (channelId, messageId) => {
    const known = verified.get(channelId);
    // A click alone may verify one of two active messages after a restart.
    return pending.has(channelId) || !known?.complete || known.embed.messageId === messageId || known.v1?.messageId === messageId;
  };
  const handle = createTempVoiceUi({ guildId, panelId, lobbyId, getGuild, actions, verifySource, publicIds,
    disabled: DISABLED, prefix: PREFIX, mentions: NO_MENTIONS, snowflake, now, frameTtlMs });

  async function voicePanel(suppliedGuild, roomId, onlyLegacy) {
    const guild = await getGuild();
    if (suppliedGuild?.id !== guild.id || suppliedGuild.client !== guild.client || roomId === panelId || roomId === lobbyId) {
      throw new Error('Invalid temporary voice panel destination');
    }
    assertManaged(roomId, true);
    return sendOnce(guild, roomId, true, onlyLegacy);
  }

  return {
    async publish() { return sendOnce(await getGuild(), panelId, false); },
    postVoicePanel: (guild, roomId) => voicePanel(guild, roomId, false),
    upgradeVoicePanel: (guild, roomId) => voicePanel(guild, roomId, true),
    handle,
  };
}

module.exports = { createTempVoicePanel };
