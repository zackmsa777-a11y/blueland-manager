'use strict';

const { createHash } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType, MediaGalleryBuilder,
  MediaGalleryItemBuilder, MessageFlags, MessagePayload, RateLimitError, Routes } = require('discord.js');
const { createTempVoiceUi } = require('./lxr-temp-voice-panel-ui');

const PREFIX = 'lxr-temp-voice:';
const SOURCE_CHANNEL = '1574640612500578495';
const SOURCE_MESSAGE = '1575635524591419506';
const SOURCE_ATTACHMENT = '1575635523916144722';
const PUBLISHER = '1486306919324057682';
const GUIDE_NAME = 'tempvoice-guide-1.png';
const GUIDE_SIZE = 59175;
const GUIDE_SHA256 = 'c9093d66153179dc82fcfecd9836846c016cb1789085772aec0ea9a70cf543a5';
const CATEGORY = '1574893689082224660';
const LOBBY = '1575147982381129748';
const NO_MENTIONS = { parse: [], repliedUser: false };
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
const button = ([kind, label, emoji, style = ButtonStyle.Secondary]) => new ButtonBuilder()
  .setCustomId(PREFIX + kind).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(DISABLED.has(kind));
const layout = () => [new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${GUIDE_NAME}`)),
  ...BUTTONS.map(row => new ActionRowBuilder().addComponents(row.map(button)))];
const publicIds = new Set(BUTTONS.flat().map(([kind]) => PREFIX + kind));

function cdnUrl(value, channelId, attachmentId) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/');
    if (url.origin === 'https://cdn.discordapp.com' && !url.username && !url.password && !url.hash &&
        parts.length === 5 && parts[1] === 'attachments' && parts[2] === channelId && snowflake(parts[3]) &&
        (attachmentId === undefined || parts[3] === attachmentId) && parts[4] === GUIDE_NAME) return url;
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

const guideUrl = (item, channelId) => item?.filename === GUIDE_NAME && item.size === GUIDE_SIZE && snowflake(item.id)
  ? cdnUrl(item.url, channelId, item.id) : null;

async function fetchPinnedGuide(rest, fetchImage, sha256) {
  const source = await rest.get(Routes.channelMessage(SOURCE_CHANNEL, SOURCE_MESSAGE));
  const matches = source?.attachments?.filter(a => a.id === SOURCE_ATTACHMENT);
  const url = matches?.length === 1 && guideUrl(matches[0], SOURCE_CHANNEL);
  if (source?.id !== SOURCE_MESSAGE || source.channel_id !== SOURCE_CHANNEL || source.author?.id !== PUBLISHER ||
      source.author.bot || source.webhook_id || !url) throw new Error('Pinned temporary voice guide was not verified');
  return download(url, fetchImage, sha256);
}

function marked(message, botId) {
  return message?.author?.id === botId && message.components?.some(row =>
    row.type === ComponentType.ActionRow && row.components?.some(c => publicIds.has(c.custom_id)));
}

function exactPanel(message, channelId, botId) {
  if (!snowflake(message?.id) || message.channel_id !== channelId || message.author?.id !== botId ||
      message.author.bot !== true || message.webhook_id || message.content || message.embeds?.length ||
      message.flags !== MessageFlags.IsComponentsV2 || !Array.isArray(message.attachments) || message.attachments.length > 1 ||
      message.components?.length !== BUTTONS.length + 1) return null;
  const [gallery, ...rows] = message.components;
  const item = message.attachments[0];
  const art = gallery.items?.[0]?.media?.url;
  const url = item ? guideUrl(item, channelId) : cdnUrl(art, channelId);
  if (!url || gallery.type !== ComponentType.MediaGallery || gallery.items?.length !== 1 ||
      (item && art !== `attachment://${GUIDE_NAME}` && !cdnUrl(art, channelId, item.id))) return null;
  const match = BUTTONS.every((row, r) => rows[r]?.type === ComponentType.ActionRow && rows[r].components?.length === row.length &&
    row.every(([kind, label, emoji, style = ButtonStyle.Secondary], c) => {
      const actual = rows[r].components[c];
      return actual?.type === ComponentType.Button && actual.custom_id === PREFIX + kind && actual.label === label &&
        actual.emoji?.name === emoji && !actual.emoji.id && actual.style === style && Boolean(actual.disabled) === DISABLED.has(kind) &&
        !actual.url && !actual.sku_id;
    }));
  return match ? url : null;
}

function createTempVoicePanel({ guildId, panelId, readyGuild, getWriter, actions, state, fetchImage = fetch, guideSha256 = GUIDE_SHA256,
  categoryId = CATEGORY, lobbyId = LOBBY, now, frameTtlMs }) {
  const verified = new Map();
  const pending = new Map();
  const uncertain = new Set();

  async function verifyMessage(guild, channelId, messageId) {
    const checked = await guild.client.rest.get(Routes.channelMessage(channelId, messageId));
    const url = checked?.id === messageId && exactPanel(checked, channelId, guild.client.user.id);
    if (!url) throw new Error('Temporary voice panel message failed verification');
    const previouslyVerified = verified.get(channelId);
    if (previouslyVerified?.messageId !== messageId || previouslyVerified.attachmentPath !== url.pathname) {
      await download(url, fetchImage, guideSha256);
    }
    verified.delete(channelId);
    if (verified.size >= 512) verified.delete(verified.keys().next().value);
    verified.set(channelId, { messageId, attachmentPath: url.pathname });
    uncertain.delete(channelId);
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

  async function recover(guild, channelId) {
    const rest = guild.client.rest;
    let before, candidate;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const messages = await rest.get(Routes.channelMessages(channelId), { query });
      if (!Array.isArray(messages) || messages.length > 100 || messages.some(m =>
        !snowflake(m?.id) || m.channel_id !== channelId || (before && BigInt(m.id) >= BigInt(before)))) {
        throw new Error('Temporary voice panel history could not be verified');
      }
      for (const message of messages) {
        if (!marked(message, guild.client.user.id)) continue;
        if (candidate || !exactPanel(message, channelId, guild.client.user.id)) {
          throw new Error('Temporary voice panel history conflicts with expected panel');
        }
        candidate = message.id;
      }
      if (messages.length < 100) return candidate ? verifyMessage(guild, channelId, candidate) : null;
      before = messages.reduce((minimum, m) => BigInt(m.id) < BigInt(minimum) ? m.id : minimum, messages[0].id);
    }
    throw new Error('Temporary voice panel history scan limit reached');
  }

  async function send(guild, channelId, voice) {
    await assertChannel(guild, channelId, voice);
    const known = verified.get(channelId);
    if (known) return verifyMessage(guild, channelId, known.messageId);
    const existing = await recover(guild, channelId);
    if (existing) return existing;
    if (uncertain.has(channelId) || uncertain.size >= 128) throw new Error('Temporary voice panel publication not confirmed');
    const image = await fetchPinnedGuide(guild.client.rest, fetchImage, guideSha256);
    const payload = MessagePayload.create({ client: guild.client }, {
      flags: MessageFlags.IsComponentsV2, components: layout(), files: [{ attachment: image, name: GUIDE_NAME }],
      nonce: channelId, enforceNonce: true, allowedMentions: NO_MENTIONS,
    }).resolveBody();
    await payload.resolveFiles();
    const writer = await getWriter();
    await assertChannel(guild, channelId, voice);
    if (voice && state && state.get(channelId)?.id !== channelId) throw new Error('Temporary voice panel destination is not managed');
    if (state?.reservePanelPublication && state.reservePanelPublication(channelId, voice) !== true) {
      throw new Error('Temporary voice panel publication not confirmed');
    }
    if (uncertain.size >= 128) throw new Error('Temporary voice panel publication not confirmed');
    if (!state?.reservePanelPublication) uncertain.add(channelId);
    let posted;
    try {
      posted = await writer.post(Routes.channelMessages(channelId), { body: payload.body, files: payload.files });
    } catch (error) {
      // Only a definitive rejection from the exact POST can release its durable reservation.
      // A readback failure, including its own 429, is not a refusal of the write.
      if (error instanceof RateLimitError && error.method === 'POST' && error.majorParameter === channelId) {
        if (state?.reservePanelPublication) state.releasePanelPublication?.(channelId, voice);
        else uncertain.delete(channelId);
        throw new Error('Temporary voice panel publication not confirmed');
      }
    }
    if (snowflake(posted?.id)) {
      try { return await verifyMessage(guild, channelId, posted.id); } catch { /* reconcile without replaying */ }
    }
    const recovered = await recover(guild, channelId).catch(() => null);
    if (recovered) return recovered;
    throw new Error('Temporary voice panel publication not confirmed');
  }

  function sendOnce(guild, channelId, voice) {
    if (pending.has(channelId)) return pending.get(channelId);
    const task = send(guild, channelId, voice).finally(() => pending.delete(channelId));
    pending.set(channelId, task);
    return task;
  }

  async function verifySource(guild, channelId, messageId) {
    await assertChannel(guild, channelId, channelId !== panelId);
    const known = verified.get(channelId);
    const confirmed = known?.messageId === messageId ? await verifyMessage(guild, channelId, messageId) :
      known ? null : await recover(guild, channelId);
    if (confirmed !== messageId) throw new Error('Invalid temporary voice panel source');
  }
  verifySource.known = (channelId, messageId) => !verified.has(channelId) || verified.get(channelId).messageId === messageId;
  const handle = createTempVoiceUi({ guildId, panelId, lobbyId, getGuild, actions, verifySource, publicIds,
    disabled: DISABLED, prefix: PREFIX, mentions: NO_MENTIONS, snowflake, now, frameTtlMs });

  return {
    async publish() { return sendOnce(await getGuild(), panelId, false); },
    async postVoicePanel(suppliedGuild, roomId) {
      const guild = await getGuild();
      if (suppliedGuild?.id !== guild.id || suppliedGuild.client !== guild.client || roomId === panelId || roomId === lobbyId) {
        throw new Error('Invalid temporary voice panel destination');
      }
      if (state && state.get(roomId)?.id !== roomId) throw new Error('Temporary voice panel destination is not managed');
      return sendOnce(guild, roomId, true);
    },
    handle,
  };
}

module.exports = { createTempVoicePanel };
