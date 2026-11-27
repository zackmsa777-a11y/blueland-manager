'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ButtonInteraction, ButtonStyle, Client, ComponentType, InteractionResponseType, InteractionType,
  MessageFlags, Routes } = require('discord.js');
const { createTempVoiceUi } = require('../src/lxr-temp-voice-panel-ui');

const [GUILD, PANEL, ROOM, LOBBY, BOT, OWNER, GUEST, PUBLIC, PRIVATE] =
  Array.from({ length: 9 }, (_, i) => String(1575000000000000000n + BigInt(i)));
const PREFIX = 'lxr-temp-voice:';
const DELETE = PREFIX + 'delete';
const user = (id, bot = false) => ({ id, username: 'offline', bot });

function controls({ ownerId = OWNER, clock = () => 0, verify = async () => {} } = {}) {
  const client = new Client({ intents: [] });
  client.user = user(BOT, true);
  const guild = { id: GUILD, client };
  const message = (body) => ({ guild_id: GUILD, channel_id: PANEL, type: 0, content: '', embeds: [], components: [],
    attachments: [], author: user(BOT, true), ...body });
  const actions = [], sourceChecks = [], requests = [], replies = [];
  const verifySource = async (...args) => { sourceChecks.push(args); await verify(...args); };
  verifySource.known = (channelId, messageId) => channelId === PANEL && messageId === PUBLIC;
  const handle = createTempVoiceUi({ guildId: GUILD, panelId: PANEL, lobbyId: LOBBY, getGuild: async () => guild,
    verifySource, publicIds: new Set([DELETE]), disabled: new Set(), prefix: PREFIX,
    mentions: { parse: [], repliedUser: false }, snowflake: value => typeof value === 'string' && /^\d{17,20}$/.test(value),
    now: clock, frameTtlMs: 100, actions: {
      inspect: async () => ({ roomId: ROOM, ownerId, locked: false, lockGeneration: '0' }),
      run: async request => { actions.push(request); return 'تم حذف الغرفة المؤقتة.'; },
    } });
  const rows = [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button,
    custom_id: DELETE, style: ButtonStyle.Danger, label: 'حذف' }] }];
  const legacy = message({ id: PUBLIC, flags: MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.MediaGallery, items: [] }, ...rows] });
  const embed = message({ id: PUBLIC, flags: 0, components: rows, embeds: [{ type: 'rich',
    image: { url: `https://cdn.discordapp.com/attachments/${PANEL}/${PUBLIC}/tempvoice-guide-1.png` } }] });
  const callback = Routes.interactionCallback(PUBLIC, 'offline');
  const original = Routes.webhookMessage(BOT, 'offline', '@original');
  let deferredFlags;
  client.rest.post = async (route, { body }) => {
    requests.push({ route, body });
    if (body.type === InteractionResponseType.DeferredChannelMessageWithSource) deferredFlags = body.data.flags;
  };
  client.rest.patch = async (route, { body }) => {
    requests.push({ route, body });
    const reply = message({ id: PRIVATE, flags: deferredFlags, ...JSON.parse(JSON.stringify(body)) });
    replies.push(reply);
    return reply;
  };
  const click = (from = legacy, customId = DELETE, actor = OWNER) => handle(new ButtonInteraction(client, {
    id: PUBLIC, token: 'offline', application_id: BOT, guild_id: GUILD, channel: { id: PANEL },
    type: InteractionType.MessageComponent, entitlements: [], authorizing_integration_owners: { 0: GUILD },
    user: user(actor), message: from, data: { custom_id: customId, component_type: ComponentType.Button },
  }));
  return { click, legacy, embed, actions, sourceChecks, guild, requests, replies, callback, original };
}

function assertEmbed(body, description) {
  assert.deepEqual(body.embeds, [{ description }]);
  assert.ok(!body.content, 'no plain-text message copy');
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
}

function assertDeferredEmbed(h, description) {
  const [defer, edit] = h.requests.slice(-2);
  assert.equal(defer.route, h.callback);
  assert.deepEqual(defer.body, { type: InteractionResponseType.DeferredChannelMessageWithSource,
    data: { flags: MessageFlags.Ephemeral } });
  assert.equal(edit.route, h.original);
  assert.equal(edit.body.flags, undefined, 'edit retains the original ephemeral flag without Components V2');
  assertEmbed(edit.body, description);
  return edit.body.components;
}

test('legacy source opens a private delete embed with the same native confirmation', async () => {
  const h = controls();
  assert.equal(await h.click(), true);
  const rows = assertDeferredEmbed(h, 'حذف الغرفة يقطع الاتصال بمن فيها. هل تريد حذفها؟');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, ComponentType.ActionRow);
  const [button] = rows[0].components;
  assert.equal(rows[0].components.length, 1);
  assert.equal(button.type, ComponentType.Button);
  assert.equal(button.style, ButtonStyle.Danger);
  assert.equal(button.label, 'تأكيد حذف الغرفة');
  assert.deepEqual(h.actions, []);
  assert.equal(await h.click(h.replies[0], button.custom_id), true);
  assert.deepEqual(assertDeferredEmbed(h, 'تم حذف الغرفة المؤقتة.'), []);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].kind, 'delete');
});

test('expired confirmation gets an initial ephemeral embed without controls', async () => {
  let time = 0;
  const h = controls({ clock: () => time });
  await h.click();
  const [prompt] = h.replies;
  time = 100;
  assert.equal(await h.click(prompt, prompt.components[0].components[0].custom_id), true);
  const { route, body: { type, data } } = h.requests.at(-1);
  assert.equal(route, h.callback);
  assert.equal(type, InteractionResponseType.ChannelMessageWithSource);
  assert.equal(data.flags, MessageFlags.Ephemeral);
  assertEmbed(data, 'انتهت صلاحية هذا التحكم. افتح لوحة الغرفة من جديد.');
  assert.ok(!data.components?.length);
  assert.deepEqual(h.actions, []);
});

test('a guest gets a deferred ephemeral denial without owner controls', async () => {
  const h = controls();
  assert.equal(await h.click(h.legacy, DELETE, GUEST), true);
  assert.deepEqual(assertDeferredEmbed(h, 'ما قدرت أفتح التحكم. تأكد أنك داخل غرفتك المؤقتة وجرّب من جديد.'), []);
  assert.deepEqual(h.actions, []);
});

test('an Embed source reaches canonical verification before opening controls', async () => {
  const h = controls();
  assert.equal(await h.click(h.embed), true);
  assert.deepEqual(h.sourceChecks, [[h.guild, PANEL, PUBLIC]]);
  assert.equal(assertDeferredEmbed(h, 'حذف الغرفة يقطع الاتصال بمن فيها. هل تريد حذفها؟').length, 1);
});

test('an Embed source that fails canonical verification receives only a private denial', async () => {
  const h = controls({ verify: async () => { throw new Error('Unexpected panel payload'); } });
  assert.equal(await h.click(h.embed), true);
  assert.deepEqual(h.sourceChecks, [[h.guild, PANEL, PUBLIC]]);
  assert.deepEqual(assertDeferredEmbed(h, 'ما قدرت أفتح التحكم. تأكد أنك داخل غرفتك المؤقتة وجرّب من جديد.'), []);
  assert.deepEqual(h.actions, []);
});

test('an Embed from a webhook, an ephemeral reply, or a different author is not a public source', async () => {
  const h = controls();
  for (const patch of [{ webhook_id: BOT }, { flags: MessageFlags.Ephemeral }, { author: user(GUEST, true) },
    { embeds: [] }, { id: PRIVATE }, { components: [] }]) {
    assert.equal(await h.click({ ...h.embed, ...patch }), false);
  }
  assert.deepEqual(h.sourceChecks, []);
  assert.deepEqual(h.requests, []);
});
