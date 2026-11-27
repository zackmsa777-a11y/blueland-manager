'use strict';

const { randomBytes } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, LabelBuilder, MessageFlags, ModalBuilder,
  Routes, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder } = require('discord.js');

const DENIED = 'ما قدرت أفتح التحكم. تأكد أنك داخل غرفتك المؤقتة وجرّب من جديد.';
const EXPIRED = 'انتهت صلاحية هذا التحكم. افتح لوحة الغرفة من جديد.';
const FAILED = 'تعذّر تأكيد تنفيذ هذا الإجراء.';
const TARGET_ACTIONS = new Set(['invite', 'disconnect', 'transfer']);
const LOCK_NOTICE = 'القفل يمنع انضمام الأعضاء العاديين طالما فيه أحد بالروم. ما يخفي الروم أو شاته، وصلاحية نقل الأعضاء تتجاوز حد الدخول.';
const UNLOCK_FIRST = 'افتح الدخول أول عشان تعدّل الحد أو تشارك رابط الروم.';
const MODAL_TYPES = {
  name: { title: 'تغيير إسم الغرفة', label: 'الاسم الجديد', max: 100 },
  limit: { title: 'حد عدد الاعضاء', label: 'الحد (٠ للإلغاء، أو من ١ إلى ٩٩)', max: 2 },
};
const PICK = { name: 'أدخل الاسم الجديد.', limit: 'أدخل الحد الأقصى للأعضاء.',
  privacy: 'اختر إعداد الدخول.', region: 'اختر منطقة الصوت.' };
const FRAME_TYPE = { button: ComponentType.Button, select: ComponentType.StringSelect, user: ComponentType.UserSelect };
const row = component => new ActionRowBuilder().addComponents(component);
const privateControl = (message, id, type) => message.components?.some(r => r.type === ComponentType.ActionRow &&
  r.components?.some(c => c.type === type && c.customId === id && !c.disabled));
const fits = (current, actorId, kind) => kind === 'claim'
  ? current.canClaim === true && current.ownerId !== actorId : current.ownerId === actorId;
const postedBy = (message, botId, channelId) => message?.channelId === channelId &&
  message.author?.id === botId && message.author.bot === true;
const ephemeral = message => message?.flags?.has(MessageFlags.Ephemeral) === true;

async function regionOptions(rest) {
  const rows = await rest.get(Routes.voiceRegions());
  if (!Array.isArray(rows)) throw new Error('Voice region catalog unavailable');
  const choices = new Map([['auto', 'تلقائي']]);
  for (const item of rows) {
    if (choices.size >= 25) break;
    if (typeof item?.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(item.id) || choices.has(item.id) ||
        item.deprecated !== false || item.custom !== false || typeof item.name !== 'string' || !item.name.trim()) continue;
    choices.set(item.id, item.name.slice(0, 100));
  }
  return [...choices].map(([value, label]) => [label, value]);
}

function modal(id, kind) {
  const { title, label, max } = MODAL_TYPES[kind];
  const input = new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short)
    .setMinLength(1).setMaxLength(max).setRequired(true);
  return new ModalBuilder().setCustomId(id).setTitle(title).addLabelComponents(
    new LabelBuilder().setLabel(label).setTextInputComponent(input),
  );
}

function createTempVoiceUi({ guildId, panelId, lobbyId, getGuild, actions, verifySource, publicIds, disabled, prefix, mentions, snowflake,
  now = () => performance.now(), frameTtlMs = 120_000 }) {
  const frames = new Map();
  const ttl = Math.max(1, Math.min(180_000, Number.isFinite(frameTtlMs) ? frameTtlMs : 120_000));
  const framePrefix = `${prefix}f:`;
  const ack = i => i.deferReply({ flags: MessageFlags.Ephemeral });
  const finish = (i, content, components = []) => i.editReply({ content, components, allowedMentions: mentions });
  const deny = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: mentions });

  function purge() {
    const time = now();
    for (const [id, frame] of frames) if (frame.expires <= time) frames.delete(id);
  }

  function issue(group, binding, spec) {
    purge();
    if (frames.size >= 512) throw new Error('Temporary voice prompts busy');
    const id = framePrefix + randomBytes(16).toString('hex');
    group.ids.push(id);
    frames.set(id, { ...binding, ...spec, group });
    return id;
  }

  function take(i, actorId) {
    const current = frames.get(i.customId);
    if (!current) return null;
    if (current.expires <= now()) {
      for (const id of current.group.ids) frames.delete(id);
      return null;
    }
    if (i.channelId !== current.sourceId || actorId !== current.actorId || i.message.id !== current.group.messageId) return null;
    const matches = current.mode === 'modal'
      ? i.isModalSubmit() && privateControl(i.message, current.parentId, ComponentType.Button)
      : i.componentType === FRAME_TYPE[current.mode] && privateControl(i.message, i.customId, i.componentType);
    if (!matches) return null;
    for (const id of current.group.ids) frames.delete(id);
    return current;
  }

  async function inspect(actorId, sourceId) {
    const found = await actions.inspect({ guildId, actorId, sourceId });
    if (!snowflake(found?.roomId) || [panelId, lobbyId].includes(found.roomId) || !snowflake(found.ownerId) ||
        (sourceId !== panelId && found.roomId !== sourceId) || typeof found.locked !== 'boolean' ||
        typeof found.lockGeneration !== 'string' || !found.lockGeneration.length || found.lockGeneration.length > 64) {
      throw new Error('Invalid temporary voice binding');
    }
    return found;
  }

  async function prompt(i, guild, action, binding) {
    const group = { ids: [], messageId: null };
    const add = spec => issue(group, binding, spec);
    const click = (kind, label, extra = {}, style = ButtonStyle.Secondary) => row(new ButtonBuilder()
      .setCustomId(add({ mode: 'button', kind, ...extra })).setStyle(style).setLabel(label));
    const user = (kind, label) => row(new UserSelectMenuBuilder()
      .setCustomId(add({ mode: 'user', kind })).setPlaceholder(label).setMinValues(1).setMaxValues(1));
    const select = (kind, options) => row(new StringSelectMenuBuilder()
      .setCustomId(add({ mode: 'select', kind, values: new Set(options.map(([, value]) => value)) }))
      .setMinValues(1).setMaxValues(1).setPlaceholder(PICK[kind]).addOptions(options.map(([label, value]) => ({ label, value }))));
    try {
      let text = PICK[action], components;
      if (binding.locked && (action === 'limit' || action === 'invite')) return await finish(i, UNLOCK_FIRST);
      if (action === 'name' || action === 'limit') components = [click(action, 'فتح النموذج', { launch: true })];
      else if (action === 'privacy') {
        text = LOCK_NOTICE;
        components = [select(action, binding.locked ? [['فتح الدخول', 'open']] : [['قفل الدخول', 'locked']])];
      } else if (action === 'region') components = [select(action, await regionOptions(guild.client.rest))];
      else if (TARGET_ACTIONS.has(action)) {
        text = 'اختر العضو. ما ينفّذ الإجراء إلا إذا كان مؤهلاً له.';
        components = [user(action, 'اختر عضواً')];
      } else if (action === 'claim') {
        text = 'تبي تستلم ملكية الغرفة إذا كان المالك غائباً؟';
        components = [click(action, 'تأكيد أخذ الملكية', {}, ButtonStyle.Primary)];
      } else if (action === 'delete') {
        text = 'حذف الغرفة يقطع الاتصال بمن فيها. هل تريد حذفها؟';
        components = [click(action, 'تأكيد حذف الغرفة', {}, ButtonStyle.Danger)];
      }
      if (!components) return;
      const reply = await finish(i, text, components);
      if (!snowflake(reply?.id) || !postedBy(reply, guild.client.user.id, binding.sourceId) || !ephemeral(reply)) {
        throw new Error('Temporary voice private prompt not verified');
      }
      group.messageId = reply.id;
    } catch (error) {
      for (const id of group.ids) frames.delete(id);
      throw error;
    }
  }

  async function useFrame(i, guild, f) {
    if (f.launch) {
      const group = { ids: [], messageId: f.group.messageId };
      const id = issue(group, f, { mode: 'modal', parentId: i.customId, launch: false });
      try { await i.showModal(modal(id, f.kind)); } catch { frames.delete(id); }
      return;
    }
    await ack(i);
    try {
      const details = {};
      if (f.mode === 'modal') {
        const raw = i.fields.getTextInputValue('value');
        if (f.kind === 'name' && typeof raw === 'string' && raw.length <= 100 && raw.trim() && !/[\p{Cc}\p{Cf}]/u.test(raw)) {
          details.value = raw.trim();
        } else if (f.kind === 'limit' && typeof raw === 'string') {
          const normalized = raw.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15));
          if (!/^\d{1,2}$/.test(normalized)) return finish(i, 'اكتب عدداً من 0 إلى 99.');
          details.value = Number(normalized);
        } else return finish(i, 'اكتب اسماً صالحاً للغرفة.');
      }
      if (f.mode === 'select' || f.mode === 'user') {
        if (!Array.isArray(i.values) || i.values.length !== 1) return finish(i, 'اختر خياراً واحداً.');
        const value = i.values[0];
        if (f.mode === 'user') {
          if (!snowflake(value) || value === f.actorId || value === f.ownerId) return finish(i, 'اختر عضواً آخر.');
          details.targetId = value;
        } else {
          if (!f.values.has(value)) return finish(i, 'هذا الخيار غير متاح.');
          details.value = value;
        }
      }
      await verifySource(guild, f.sourceId, f.publicMessageId);
      const found = await inspect(f.actorId, f.sourceId);
      if (found.roomId !== f.roomId || found.ownerId !== f.ownerId || !fits(found, f.actorId, f.kind) ||
          found.locked !== f.locked || found.lockGeneration !== f.lockGeneration || f.expires <= now()) return finish(i, EXPIRED);
      if (found.locked && (f.kind === 'limit' || f.kind === 'invite')) return finish(i, UNLOCK_FIRST);
      const outcome = await actions.run({ guildId, actorId: f.actorId, sourceId: f.sourceId, roomId: f.roomId,
        expectedOwnerId: f.ownerId, expectedLocked: f.locked, expectedLockGeneration: f.lockGeneration, kind: f.kind, ...details });
      await finish(i, typeof outcome === 'string' && outcome.length > 0 && outcome.length <= 500 ? outcome : FAILED);
    } catch {
      await finish(i, FAILED).catch(() => {});
    }
  }

  return async function handle(i) {
    if (typeof i?.customId !== 'string' || i.guildId !== guildId || !snowflake(i.user?.id) || i.user.bot ||
        !snowflake(i.channelId) || i.channelId === lobbyId) return false;
    const isPublic = publicIds.has(i.customId);
    if (!isPublic && !(i.customId.startsWith(framePrefix) && /^[0-9a-f]{32}$/.test(i.customId.slice(framePrefix.length)))) return false;
    const guild = await getGuild().catch(() => null);
    const botId = guild?.client.user.id;
    if (!botId || guild.client !== i.client || i.applicationId !== botId || !snowflake(i.message?.id) ||
        !postedBy(i.message, botId, i.channelId)) return false;

    if (!isPublic) {
      if (!ephemeral(i.message)) return false;
      const f = take(i, i.user.id);
      if (!f) await deny(i, EXPIRED).catch(() => {});
      else await useFrame(i, guild, f).catch(() => {});
      return true;
    }

    const action = i.customId.slice(prefix.length);
    if (!i.isButton() || i.message.webhookId || ephemeral(i.message) || !i.message.flags?.has(MessageFlags.IsComponentsV2)) return false;
    if (disabled.has(action)) return true;
    if (!privateControl(i.message, i.customId, ComponentType.Button)) return false;
    // A known different ID can be rejected without spending the acknowledgement window on REST.
    if (verifySource.known(i.channelId, i.message.id) === false) return false;
    try {
      await ack(i);
      await verifySource(guild, i.channelId, i.message.id);
      const found = await inspect(i.user.id, i.channelId);
      if (!fits(found, i.user.id, action)) await finish(i, DENIED);
      else await prompt(i, guild, action, { actorId: i.user.id, sourceId: i.channelId, publicMessageId: i.message.id,
        roomId: found.roomId, ownerId: found.ownerId, locked: found.locked, lockGeneration: found.lockGeneration, expires: now() + ttl });
    } catch {
      if (i.deferred && i.ephemeral) await finish(i, DENIED).catch(() => {});
    }
    return true;
  };
}

module.exports = { createTempVoiceUi };
