'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { ButtonInteraction, ChannelType, Client, ComponentType, DiscordAPIError, GatewayIntentBits, InteractionResponseType, InteractionType,
  MessageFlags, ModalSubmitInteraction, OverwriteType, PermissionFlagsBits: Perm, RateLimitError, REST, Routes, Status,
  StringSelectMenuInteraction, UserSelectMenuInteraction } = require('discord.js');

const GUILD = '1573975432838127708';
const SOURCE = '1574640612500578495';
const GUIDE_POST = '1575844663921872966';
const GUIDE_ID = '1575844663250919444';
const LEGACY_POST = '1575842951056195664';
const LEGACY_NAME = 'tempvoice-guide-1.png';
const ACTIONS = [
  [['name', 'تغيير إسم', '✏️'], ['limit', 'حد عدد الاعضاء', '👥'], ['privacy', 'قفل وفتح الدخول', '🔒'],
    ['waiting', 'غرفة الانتظار', '🕒'], ['trust', 'الثقة', '➕']],
  [['untrust', 'عدم الثقة', '➖'], ['invite', 'دعوة', '📞'], ['disconnect', 'طرد', '📵'],
    ['region', 'تغيير منطقة', '🌐'], ['block', 'حظر', '🚫']],
  [['unblock', 'رفع الحظر', '🔓'], ['claim', 'اخذ الملكية', '👑'], ['transfer', 'نقل ملكية', '📝'],
    ['delete', 'حذف', '🗑️'], ['chat', 'دردشة', '💬']],
];
const DISABLED = new Set(['waiting', 'trust', 'untrust', 'block', 'unblock', 'chat']);
const EMOJIS = Object.fromEntries(ACTIONS.flat().map(([kind], i) => [kind, {
  id: String(1579500000000000000n + BigInt(i)), name: `tv_${kind}`,
}]));
const OWNER = '1486306919324057682';
const BOT = '1575000000000000001';
const PANEL = '1575632962240774264';
const CATEGORY = '1574893689082224660';
const LOBBY = '1575147982381129748';
const ROOM = '1577000000000000001';
const NEXT_ROOM = '1577000000000000002';
const OTHER_ID = '1577000000000000003';
const NAME = 'tempvoice-guide.png';
const GUIDE = process.env.LXR_TEMP_VOICE_TEST_GUIDE ? readFileSync(process.env.LXR_TEMP_VOICE_TEST_GUIDE) : Buffer.alloc(59175, 0x93);
const digest = data => createHash('sha256').update(data).digest('hex');
const { openTempVoiceStore } = require('../src/lxr-temp-voice-store');
const { createApplicationMutationRest } = require('../src/lxr-apply-tickets');
function panelStore(t, ...rooms) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const state = openTempVoiceStore(db);
  for (const [index, id] of rooms.entries()) {
    assert.ok(state.begin(index ? OTHER_ID : OWNER, `panel-test-${id}`, `session-${id}`, []));
    assert.equal(state.bind(index ? OTHER_ID : OWNER, `panel-test-${id}`, id).id, id);
  }
  return state;
}
const attachment = (channel, id, name = NAME) => ({ id, filename: name, size: GUIDE.length, content_type: 'image/png',
  url: `https://cdn.discordapp.com/attachments/${channel}/${id}/${name}?ex=123&is=456&hm=abc` });

function legacyMessage(channel = PANEL, id = LEGACY_POST) {
  const art = attachment(channel, '1575842950724830000', LEGACY_NAME);
  return { id, channel_id: channel, author: { id: BOT, bot: true }, flags: MessageFlags.IsComponentsV2,
    content: '', embeds: [], attachments: [], components: [
      { type: ComponentType.MediaGallery, items: [{ media: { url: art.url } }] },
      ...ACTIONS.map(row => ({ type: ComponentType.ActionRow, components: row.map(([kind, label, name]) => ({
        type: ComponentType.Button, custom_id: `lxr-temp-voice:${kind}`, style: kind === 'delete' ? 4 : 2,
        label, emoji: { name }, disabled: DISABLED.has(kind),
      })) })),
    ] };
}

function harness({ sourcePatch, channelPatch, modifyPost, fetchImage, ...options } = {}) {
  const { createTempVoicePanel } = require('../src/lxr-temp-voice-panel');
  const client = new Client({ intents: [] });
  client.user = { id: BOT };
  const posts = [];
  const reads = [];
  const downloads = [], deletions = [], trace = [];
  const messages = new Map([PANEL, ROOM, NEXT_ROOM].map(id => [id, []]));
  const source = { id: GUIDE_POST, channel_id: SOURCE, author: { id: OWNER }, attachments: [attachment(SOURCE, GUIDE_ID)], ...sourcePatch };
  const guild = { id: GUILD, client };
  client.rest.get = async (route, opts) => {
    reads.push({ route, opts });
    trace.push(`GET ${route}`);
    if (route === Routes.channelMessage(SOURCE, GUIDE_POST)) return source;
    const [, id, step, messageId] = route.match(/^\/channels\/(\d+)(?:\/(messages)(?:\/(\d+))?)?$/) ?? [];
    if (id && !step) return { id, guild_id: GUILD, parent_id: CATEGORY,
      type: id === PANEL ? ChannelType.GuildText : ChannelType.GuildVoice, ...channelPatch };
    if (!messages.has(id)) throw Error(`unexpected read ${route}`);
    if (messageId) {
      const found = messages.get(id).find(m => m.id === messageId);
      if (!found) throw new DiscordAPIError({ message: 'Unknown Message', code: 10008 }, 10008, 404, 'GET',
        `https://discord.com/api/v10${route}`, {});
      return found;
    }
    return messages.get(id).filter(m => !opts.query.get('before') || m.id < opts.query.get('before')).slice(0, Number(opts.query.get('limit')));
  };
  const writer = { post: async (route, data) => {
    const id = [...messages.keys()].find(id => route === Routes.channelMessages(id));
    assert.ok(id, 'writes only hit the intended message route');
    posts.push({ route, data });
    trace.push(`POST ${route}`);
    const messageId = (1578000000000000000n + BigInt(posts.length)).toString();
    const storedAttachment = attachment(id, (1579000000000000000n + BigInt(posts.length)).toString(), data.files[0].name);
    const message = { ...JSON.parse(JSON.stringify(data.body)), id: messageId, channel_id: id,
      author: { id: BOT, bot: true }, attachments: [storedAttachment] };
    if (message.embeds) message.embeds[0].image.url = storedAttachment.url;
    else message.components[0].items[0].media.url = storedAttachment.url;
    messages.get(id).unshift(message);
    return modifyPost ? modifyPost(message) : { id: messageId };
  }, delete: async route => {
    trace.push(`DELETE ${route}`);
    deletions.push(route);
    for (const [channel, list] of messages) {
      const index = list.findIndex(({ id }) => Routes.channelMessage(channel, id) === route);
      if (index !== -1) list.splice(index, 1);
    }
  } };
  const dependencies = { guildId: GUILD, panelId: PANEL, readyGuild: () => guild, getWriter: () => writer, getEmojis: async () => EMOJIS,
    actions: {}, ...(process.env.LXR_TEMP_VOICE_TEST_GUIDE ? {} : { guideSha256: digest(GUIDE) }),
    fetchImage: async (url, opts) => {
      downloads.push({ url, opts });
      trace.push(`FETCH ${new URL(url).pathname}`);
      return fetchImage ? fetchImage(url, opts) : new Response(GUIDE);
    }, ...options };
  return { panel: createTempVoicePanel(dependencies), create: overrides => createTempVoicePanel({...dependencies, ...overrides}),
    client, guild, posts, reads, messages, source, downloads, deletions, trace, writer };
}

test('serializes one native Embed with the unchanged guide above three exact icon-only rows', async () => {
  const { panel, posts, reads, downloads } = harness();
  assert.equal(await panel.publish(), '1578000000000000001');
  assert.equal(posts.length, 1);
  const [{ route, data: { body, files } }] = posts;
  assert.equal(route, Routes.channelMessages(PANEL));
  assert.equal(body.flags ?? 0, 0);
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(body.content, undefined);
  assert.equal(body.embeds.length, 1);
  assert.equal(body.embeds[0].title, 'واجهة التحكم بالرومات الصوتية');
  assert.match(body.embeds[0].description, /[\p{Script=Arabic}]/u);
  assert.match(body.embeds[0].footer.text, /[\p{Script=Arabic}]/u);
  assert.equal(body.embeds[0].image.url, `attachment://${NAME}`);
  assert.notEqual(body.nonce, PANEL, 'migration uses a nonce distinct from the old V2 post');
  assert.ok(body.nonce.length <= 25);
  assert.equal(body.enforce_nonce, true);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, NAME);
  assert.equal(digest(files[0].data), digest(GUIDE));
  assert.deepEqual(body.components.map(row => {
    assert.equal(row.type, ComponentType.ActionRow);
    return row.components.map(b => {
      assert.equal(b.type, ComponentType.Button);
      assert.equal(b.label, undefined);
      assert.equal(b.url, undefined);
      return { id: b.custom_id, emoji: b.emoji, style: b.style, disabled: b.disabled };
    });
  }), ACTIONS.map(row => row.map(([kind]) => ({ id: `lxr-temp-voice:${kind}`, emoji: EMOJIS[kind],
    style: kind === 'delete' ? 4 : 2, disabled: DISABLED.has(kind) }))));
  assert.deepEqual(downloads.map(d => d.opts.redirect), ['error', 'error']);
  assert.equal(new URL(downloads[0].url).pathname, `/attachments/${SOURCE}/${GUIDE_ID}/${NAME}`);
  assert.ok(reads.some(({ route }) => route === Routes.channelMessage(PANEL, '1578000000000000001')));
});

test('replaces the authenticated startup V2 panel only after verifying exact new Embed bytes', async t => {
  const h = harness({ state: panelStore(t) });
  h.messages.get(PANEL).push(legacyMessage());
  const id = await h.panel.publish();
  const modernRoute = Routes.channelMessage(PANEL, id);
  const legacyRoute = Routes.channelMessage(PANEL, LEGACY_POST);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.deletions, [legacyRoute]);
  assert.ok(h.trace.indexOf(`GET ${modernRoute}`) < h.trace.indexOf(`DELETE ${legacyRoute}`));
  assert.ok(h.trace.indexOf(`FETCH /attachments/${PANEL}/1579000000000000001/${NAME}`) < h.trace.indexOf(`DELETE ${legacyRoute}`));
  assert.equal(h.trace.at(-1), `GET ${legacyRoute}`);
  assert.equal(await h.create().publish(), id);
  assert.deepEqual(h.messages.get(PANEL).map(message => message.id), [id]);
});

test('deduplicates concurrent publishes and recovers the exact panel on a fresh instance', async () => {
  const { panel, create, posts } = harness();
  const ids = await Promise.all([panel.publish(), panel.publish(), panel.publish()]);
  assert.deepEqual(ids, Array(3).fill('1578000000000000001'));
  assert.equal(await create().publish(), ids[0]);
  assert.equal(posts.length, 1);
});

test('the default renderer uses the verified IDs from the real emoji provider', async t => {
  const { art } = require('../src/lxr-temp-voice-emoji-art');
  const state = panelStore(t);
  const entries = Object.entries(art).map(([kind, { name, png }]) => [{ id: EMOJIS[kind].id, name, animated: false }, png]);
  const pngs = new Map(entries.map(([{ id }, png]) => [`https://cdn.discordapp.com/emojis/${id}.png`, Buffer.from(png, 'base64')]));
  let emojiDownloads = 0;
  const h = harness({ getEmojis: undefined, state, fetchImage: url => {
    if (!pngs.has(url)) return new Response(GUIDE);
    emojiDownloads++;
    return new Response(pngs.get(url));
  } });
  h.client.user.bot = true;
  h.client.application = { id: BOT };
  const route = Routes.applicationEmojis(BOT);
  const read = createApplicationMutationRest('fixture-only', { makeRequest: async (url, { method, headers }) => {
    assert.equal(method, 'GET');
    assert.equal(new URL(url).pathname, '/api/v10' + route);
    assert.equal(new Headers(headers).get('authorization'), 'Bot fixture-only');
    return Response.json({ items: entries.map(([row]) => row) });
  } });
  const get = h.client.rest.get;
  h.client.rest.get = (path, opts) => path === route ? read.get(path, opts) : get(path, opts);
  assert.equal(await h.create().publish(), await h.panel.publish());
  assert.equal(emojiDownloads, 15);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].data.body.components.flatMap(row => row.components.map(button => button.emoji)),
    ACTIONS.flat().map(([kind]) => ({ id: EMOJIS[kind].id, name: art[kind].name })));
});

test('posts to each verified voice channel route only once and never to the lobby or foreign guild', async () => {
  const { panel, guild, posts } = harness();
  await assert.rejects(panel.postVoicePanel({ ...guild, id: OWNER }, ROOM));
  await assert.rejects(panel.postVoicePanel(guild, LOBBY));
  await assert.rejects(panel.postVoicePanel(guild, PANEL));
  const [first, duplicate, next] = await Promise.all([
    panel.postVoicePanel(guild, ROOM), panel.postVoicePanel(guild, ROOM), panel.postVoicePanel(guild, NEXT_ROOM),
  ]);
  assert.equal(first, duplicate);
  assert.notEqual(first, next);
  assert.deepEqual(posts.map(p => p.route).sort(), [ROOM, NEXT_ROOM].map(Routes.channelMessages));
});

test('upgrades only a verified existing legacy voice-chat panel, not an empty served room', async t => {
  const state = panelStore(t, ROOM, NEXT_ROOM);
  const h = harness({ state });
  h.messages.get(ROOM).push(legacyMessage(ROOM));
  assert.equal(await h.panel.upgradeVoicePanel(h.guild, NEXT_ROOM), null);
  assert.equal(h.posts.length, 0);
  const id = await h.panel.upgradeVoicePanel(h.guild, ROOM);
  assert.ok(id);
  assert.deepEqual(h.posts.map(post => post.route), [Routes.channelMessages(ROOM)]);
  assert.deepEqual(h.deletions, [Routes.channelMessage(ROOM, LEGACY_POST)]);
  assert.equal(state.getPanelRetirement(ROOM, true).settled, 1);
  assert.equal(state.remove(ROOM), true);
  assert.equal(state.getPanelRetirement(ROOM, true), null, 'retirement journal cascades with the managed room');
});

test('rejects cross-category voice and non-text static routes before reading the guide or writing', async () => {
  const outside = harness({ channelPatch: { parent_id: SOURCE } });
  await assert.rejects(outside.panel.postVoicePanel(outside.guild, ROOM));
  const wrongType = harness({ channelPatch: { type: ChannelType.GuildVoice } });
  await assert.rejects(wrongType.panel.publish());
  for (const h of [outside, wrongType]) {
    assert.equal(h.posts.length, 0);
    assert.equal(h.downloads.length, 0);
  }
});

test('recovers a committed panel when the write response is lost', async t => {
  const { panel, posts, messages, deletions } = harness({ state: panelStore(t), modifyPost: () => { throw Error('timed out'); } });
  messages.get(PANEL).push(legacyMessage());
  assert.equal(await panel.publish(), '1578000000000000001');
  assert.equal(posts.length, 1);
  assert.deepEqual(deletions, [Routes.channelMessage(PANEL, LEGACY_POST)]);
});

test('does not repeat an ambiguous publication with no message visible yet', async () => {
  const { panel, posts, messages } = harness({ modifyPost: () => {
    messages.get(PANEL).length = 0;
    throw Error('timed out');
  } });
  await assert.rejects(panel.publish(), /not confirmed/);
  await assert.rejects(panel.publish(), /not confirmed/);
  assert.equal(posts.length, 1);
});

test('consults the durable publication reservation before repeating an ambiguous static post after restart', async () => {
  const reservations = new Set();
  const state = { reservePanelPublication(id) {
    if (reservations.has(id)) return false;
    reservations.add(id);
    return true;
  } };
  const { panel, create, posts, messages } = harness({ state, modifyPost: () => {
    messages.get(PANEL).length = 0;
    throw Error('timed out');
  } });
  await assert.rejects(panel.publish(), /not confirmed/);
  await assert.rejects(create().publish(), /not confirmed/);
  assert.deepEqual([...reservations], [PANEL]);
  assert.equal(posts.length, 1);
});

test('a fresh SQLite store wrapper cannot repeat an ambiguous control-room or managed voice-chat post', async t => {
  const { openTempVoiceStore } = require('../src/lxr-temp-voice-store');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const id of [PANEL, ROOM]) {
    const state = openTempVoiceStore(db);
    if (id === ROOM) {
      assert.equal(state.begin(OWNER, 'test-marker', 'test-session', []), true);
      assert.equal(state.bind(OWNER, 'test-marker', ROOM).id, ROOM);
    }
    assert.equal(state.reservePanelPublication(id, id === ROOM, 'v1'), true);
    const h = harness({ state, modifyPost: () => {
      h.messages.get(id).shift();
      throw Error('timed out');
    } });
    h.messages.get(id).push(legacyMessage(id));
    const publish = panel => id === PANEL ? panel.publish() : panel.postVoicePanel(h.guild, ROOM);
    await assert.rejects(publish(h.panel), /not confirmed/);
    assert.equal(h.posts.length, 1);
    await assert.rejects(publish(h.create({ state: openTempVoiceStore(db) })), /not confirmed/);
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.messages.get(id).map(message => message.id), [LEGACY_POST]);
    assert.deepEqual(h.deletions, []);
  }
});

test('definitive SDK HTTP 429 releases only the intended panel reservation for a later verified attempt', async t => {
  const { createApplicationMutationRest } = require('../src/lxr-apply-tickets');
  const { openTempVoiceStore } = require('../src/lxr-temp-voice-store');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const state = openTempVoiceStore(db);
  assert.ok(state.begin(OWNER, 'test-marker', 'test-session', []));
  assert.equal(state.bind(OWNER, 'test-marker', ROOM).id, ROOM);
  for (const id of [PANEL, ROOM]) {
    assert.equal(state.reservePanelPublication(id, id === ROOM, 'v1'), true);
    let wire = 0;
    const rejected = createApplicationMutationRest('offline-panel-test', { makeRequest: async (url, options) => {
      assert.equal(options.method,'POST');
      assert.equal(new URL(url).pathname,'/api/v10'+Routes.channelMessages(id));
      const payload = JSON.parse(options.body.get('payload_json'));
      const upload = options.body.get('files[0]');
      assert.equal(payload.embeds[0].image.url, `attachment://${NAME}`);
      assert.equal(payload.flags ?? 0, 0);
      assert.equal(payload.components.length, 3);
      assert.equal(upload.name, NAME);
      assert.equal(digest(Buffer.from(await upload.arrayBuffer())), digest(GUIDE));
      wire++;
      return Response.json({message:'Slow down',retry_after:0.01,global:false},{status:429,
        headers:{'retry-after':'0.01','x-ratelimit-scope':'shared'}});
    } });
    const h = harness({ state, getWriter:()=>rejected });
    h.messages.get(id).push(legacyMessage(id));
    const publish = panel => id === PANEL ? panel.publish() : panel.postVoicePanel(h.guild,ROOM);
    await assert.rejects(publish(h.panel), /not confirmed/);
    assert.equal(wire,1,'a definitive rate rejection must not retry inline');
    assert.equal(h.posts.length,0);
    assert.deepEqual(h.deletions,[]);
    const fresh = h.create({state:openTempVoiceStore(db),getWriter:()=>h.writer});
    assert.ok(await publish(fresh));
    assert.equal(h.posts.length,1);
    assert.deepEqual(h.deletions,[Routes.channelMessage(id, LEGACY_POST)]);
    assert.equal(state.reservePanelPublication(id, id === ROOM, 'v1'), false);
  }
});

test('a rate limit during verification of a committed POST does not release its reservation', async t => {
  const { openTempVoiceStore } = require('../src/lxr-temp-voice-store');
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  const state=openTempVoiceStore(db);
  let throttled=false;
  const h=harness({state,modifyPost:message=>{throttled=true;return {id:message.id};}});
  const get=h.client.rest.get;
  h.client.rest.get=async(route,opts)=>{
    if(throttled && (route===Routes.channelMessages(PANEL)||route.startsWith(`${Routes.channelMessages(PANEL)}/`))) {
      throw new RateLimitError({method:'GET',majorParameter:PANEL,retryAfter:10,timeToReset:10});
    }
    return get(route,opts);
  };
  await assert.rejects(h.panel.publish(),/not confirmed/);
  assert.equal(state.reservePanelPublication(PANEL,false,'embed'),false);
  throttled=false;
  assert.equal(await h.create({state:openTempVoiceStore(db)}).publish(),h.messages.get(PANEL)[0].id);
  assert.equal(h.posts.length,1);
});

test('verifies original Embed guide bytes when Discord only returns a resolved CDN or proxy image', async () => {
  for (const mode of ['cdn', 'proxy', 'attachment URI and proxy']) {
    const h = harness({ modifyPost: message => {
      delete message.attachments;
      if (mode !== 'cdn') message.embeds[0].image = {
        proxy_url: message.embeds[0].image.url.replace('cdn.discordapp.com', 'media.discordapp.net') + '&width=350',
        ...(mode === 'attachment URI and proxy' ? { url: `attachment://${NAME}` } : {}),
      };
      return { id: message.id };
    } });
    const id = await h.panel.publish();
    assert.equal(await h.create().publish(), id);
    assert.equal(h.posts.length, 1);
    assert.equal(h.downloads.length, 3);
    assert.equal(new URL(h.downloads.at(-1).url).hostname, 'cdn.discordapp.com');
    assert.equal(new URL(h.downloads.at(-1).url).searchParams.get('width'), null);
  }
});

test('does not publish to a non-managed voice channel in the correct category', async () => {
  const { panel, guild, posts } = harness({ state: { get: id => id === ROOM ? { id } : null } });
  await assert.rejects(panel.postVoicePanel(guild, NEXT_ROOM), /not managed/);
  await panel.postVoicePanel(guild, ROOM);
  assert.deepEqual(posts.map(p => p.route), [Routes.channelMessages(ROOM)]);
});

test('does not recover a mismatched bot panel or post a replacement when old state is ambiguous', async () => {
  const { panel, create, posts, messages } = harness();
  await panel.publish();
  messages.get(PANEL)[0].components[0].components[0].label = 'wrong';
  await assert.rejects(create().publish());
  assert.equal(posts.length, 1);
});

test('does not remove the old published ID when its legacy buttons do not authenticate', async () => {
  const h = harness();
  const legacy = legacyMessage();
  legacy.components[1].components[0].label = 'wrong';
  h.messages.get(PANEL).push(legacy);
  await assert.rejects(h.panel.publish(), /history conflicts/);
  assert.deepEqual(h.deletions, []);
  assert.equal(h.posts.length, 0);
});

test('does not replace an otherwise matching public V2 panel with an unexpected ID', async () => {
  const h = harness();
  h.messages.get(PANEL).push(legacyMessage(PANEL, OTHER_ID));
  await assert.rejects(h.panel.publish(), /history conflicts/);
  assert.deepEqual(h.deletions, []);
  assert.equal(h.posts.length, 0);
});

test('keeps the old controls if the replacement disappears before retiring the previous message', async t => {
  const state = panelStore(t);
  const h = harness({ state });
  h.messages.get(PANEL).push(legacyMessage());
  const get = h.client.rest.get;
  h.client.rest.get = (route, opts) => {
    if (h.messages.get(PANEL).length === 2 && route === Routes.channelMessage(PANEL, LEGACY_POST)) {
      h.messages.get(PANEL).shift();
    }
    return get(route, opts);
  };
  await assert.rejects(h.panel.publish());
  assert.deepEqual(h.deletions, []);
  assert.deepEqual(h.messages.get(PANEL).map(message => message.id), [LEGACY_POST]);
  assert.equal(state.getPanelRetirement(PANEL, false), null, 'never journal a retirement before verifying the new panel');
});

test('does not delete a valid legacy panel when new readback fails exact Embed verification', async () => {
  for (const tamper of [
    message => { message.embeds[0].description += '!'; },
    message => { message.embeds[0].footer.text += '!'; },
    message => { message.embeds[0].image.url = message.embeds[0].image.url.replace(PANEL, ROOM); },
    message => { message.components[0].components[0].emoji.id = EMOJIS.limit.id; },
    message => { message.components[0].components[0].disabled = true; },
    message => { message.flags = MessageFlags.IsComponentsV2; },
  ]) {
    const h = harness({ modifyPost: message => { tamper(message); return { id: message.id }; } });
    h.messages.get(PANEL).push(legacyMessage());
    await assert.rejects(h.panel.publish(), /not confirmed/);
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.deletions, []);
    assert.equal(h.messages.get(PANEL).at(-1).id, LEGACY_POST);
  }
});

test('does not delete a valid legacy panel when the replacement attachment digest is wrong', async () => {
  const h = harness({ fetchImage: url => new Response(url.includes(`${PANEL}/1579000000000000001/`)
    ? Buffer.alloc(GUIDE.length, (GUIDE[0] + 1) % 256) : GUIDE) });
  h.messages.get(PANEL).push(legacyMessage());
  await assert.rejects(h.panel.publish(), /not confirmed/);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.deletions, []);
});

test('never downloads a guide from a different publisher, wrong CDN, wrong path, or ambiguous attachment', async () => {
  const pinned = attachment(SOURCE, GUIDE_ID);
  for (const sourcePatch of [
    { author: { id: BOT } }, { channel_id: PANEL }, { id: OTHER_ID },
    { attachments: [pinned, pinned] },
    { attachments: [{ ...pinned, url: pinned.url.replace('cdn.discordapp.com', 'fake.invalid') }] },
    { attachments: [{ ...pinned, url: pinned.url.replace(SOURCE, PANEL) }] },
    { attachments: [{ ...pinned, url: pinned.url.replace('cdn.discordapp.com', 'x@y@cdn.discordapp.com') }] },
  ]) {
    const { panel, posts, downloads } = harness({ sourcePatch });
    await assert.rejects(panel.publish(), /Pinned temporary voice guide was not verified/);
    assert.equal(posts.length, 0);
    assert.equal(downloads.length, 0);
  }
});

test('rejects redirected, short, oversized and wrong-digest guide downloads without a post', async () => {
  for (const fetchImage of [
    async () => ({ ok: true, redirected: true, body: new Response(GUIDE).body }),
    async () => new Response(GUIDE.subarray(1)),
    async () => new Response(Buffer.concat([GUIDE, Buffer.of(0)])),
    async () => new Response(Buffer.from(GUIDE, b => b ^ 0xff).fill(0)),
  ]) {
    const { panel, posts } = harness({ fetchImage });
    await assert.rejects(panel.publish(), /guide/);
    assert.equal(posts.length, 0);
  }
});

const P = 'lxr-temp-voice:';
const MEMBER = '1575000000000000412';
const TARGET = '1575000000000000413';

const interactionClasses = {
  [ComponentType.Button]: ButtonInteraction,
  [ComponentType.StringSelect]: StringSelectMenuInteraction,
  [ComponentType.UserSelect]: UserSelectMenuInteraction,
};

async function controls({ current = { roomId: ROOM, ownerId: MEMBER, canClaim: false, locked: false, lockGeneration:'0' }, origin = PANEL, setupMessage, ...options } = {}) {
  const inspected = [], executed = [];
  const h = harness({ actions: {
    inspect: async request => { inspected.push(request); return { ...current }; },
    run: async request => { executed.push(request); return 'تم التحديث.'; },
  }, ...options });
  const { client, guild, panel, messages } = h;
  const messageId = await (setupMessage ? setupMessage(h) : origin === PANEL ? panel.publish() : panel.postVoicePanel(guild, origin));
  const message = messages.get(origin).find(m => m.id === messageId);
  const callbacks = [], replies = [];
  const previousGet = client.rest.get;
  client.rest.get = async (route, opts) => route === Routes.voiceRegions() ? [
    { id: 'rotterdam', name: 'Rotterdam', deprecated: false, custom: false },
    { id: 'deprecated-region', name: 'Old', deprecated: true, custom: false },
    { id: 'private-test', name: 'Private', deprecated: false, custom: true },
  ] : previousGet(route, opts);
  client.rest.post = async (route, options) => {
    callbacks.push({ route, ...options.body });
    return undefined;
  };
  let sequence = 0n;
  const rawMessage = (channelId, data) => ({ id: (1578900000000000000n + ++sequence).toString(),
    channel_id: channelId, guild_id: GUILD, type: 0, author: { id: BOT, username: 'bot', bot: true },
    flags: 0, components: [], attachments: [], embeds: [], content: '', ...JSON.parse(JSON.stringify(data)) });
  client.rest.patch = async (route, options) => {
    const reply = rawMessage(origin, { ...options.body, flags: MessageFlags.Ephemeral });
    replies.push(reply);
    return reply;
  };
  function event(id, { from = message, type = ComponentType.Button, values, value, actor = MEMBER, sourceId = origin,
    guildId = GUILD, applicationId = BOT, actorBot = false } = {}) {
    const base = { id: (1578100000000000000n + ++sequence).toString(), token: 'offline', application_id: applicationId,
      guild_id: guildId, channel: { id: sourceId }, entitlements: [], authorizing_integration_owners: { 0: GUILD },
      user: { id: actor, username: 'offline', bot: actorBot },
      message: rawMessage(sourceId, { ...from, embeds: from.embeds ?? [], content: from.content ?? '' }) };
    if (value !== undefined) return new ModalSubmitInteraction(client, { ...base, type: InteractionType.ModalSubmit,
      data: { custom_id: id, components: [{ type: ComponentType.ActionRow, components: [
        { type: ComponentType.TextInput, custom_id: 'value', value },
      ] }] } });
    return new interactionClasses[type](client, { ...base, type: InteractionType.MessageComponent,
      data: { custom_id: id, component_type: type, values } });
  }
  const click = (kind, opts) => panel.handle(event(P + kind, opts));
  const response = () => {
    const reply = replies.at(-1);
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    assert.ok(!reply.content);
    assert.equal(reply.embeds.length, 1);
    assert.equal(typeof reply.embeds[0].description, 'string');
    return { ...reply, description: reply.embeds[0].description };
  };
  const control = (from, row = 0, pos = 0) => from.components[row].components[pos];
  const choose = (from, item, opts) => panel.handle(event(item.custom_id, { from, type: item.type, ...opts }));
  return { ...h, current, origin, message, callbacks, replies, inspected, executed, event, click, response, control, choose };
}

test('legacy controls still open private prompts when startup cannot verify the custom emojis', async () => {
  const h = await controls({ getEmojis: async () => ({}), setupMessage: async h => {
    h.messages.get(PANEL).push(legacyMessage());
    await assert.rejects(h.panel.publish(), /emojis not verified/);
    assert.equal(h.posts.length, 0);
    assert.deepEqual(h.deletions, []);
    return LEGACY_POST;
  } });
  assert.equal(await h.click('name'), true);
  assert.equal(h.control(h.response()).type, ComponentType.Button);
  assert.equal(h.inspected.length, 1);
});

test('clicking an unverified embed never provisions emojis and the old V2 still works with no registry', async t => {
  const state = panelStore(t);
  const calls = [];
  const h = await controls({ state, getEmojis: undefined, setupMessage: async h => {
    h.client.user.bot = true;
    h.client.application = { id: BOT };
    const route = Routes.applicationEmojis(BOT);
    const transport = createApplicationMutationRest('fixture-only', { makeRequest: async (url, { method }) => {
      assert.equal(new URL(url).pathname, '/api/v10' + route);
      calls.push(method);
      return method === 'GET' ? Response.json({ items: [] }) : Response.json({ message: 'unavailable' }, { status: 503 });
    } });
    const get = h.client.rest.get;
    h.client.rest.get = (path, opts) => path === route ? transport.get(path, opts) : get(path, opts);
    h.writer.post = transport.post.bind(transport);
    h.messages.get(PANEL).push(legacyMessage(), { id: OTHER_ID, channel_id: PANEL, author: { id: BOT, bot: true },
      embeds: [{ title: 'واجهة التحكم بالرومات الصوتية' }],
      components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button,
        custom_id: P + 'name', style: 2, label: 'Unexpected' }] }] });
    return OTHER_ID;
  } });
  assert.equal(await h.click('name'), true);
  assert.deepEqual(calls, ['GET']);
  assert.deepEqual(h.inspected, []);
  assert.equal(await h.click('name', { from: h.messages.get(PANEL)[0] }), true);
  assert.equal(h.control(h.response()).type, ComponentType.Button);
  assert.equal(h.inspected.length, 1);
  assert.deepEqual(calls, ['GET']);
});

test('both verified messages serve clicks on a fresh instance when deleting the prior panel failed', async t => {
  const h = await controls({ state: panelStore(t), setupMessage: async h => {
    h.messages.get(PANEL).push(legacyMessage());
    h.writer.delete = async () => { throw Error('could not delete'); };
    await assert.rejects(h.panel.publish(), /deletion not confirmed/);
    return h.messages.get(PANEL)[0].id;
  } });
  const fresh = h.create();
  assert.equal(await fresh.handle(h.event(P + 'name')), true);
  assert.equal(h.control(h.response()).type, ComponentType.Button);
  assert.equal(await fresh.handle(h.event(P + 'name', { from: h.messages.get(PANEL).at(-1) })), true);
  assert.equal(h.control(h.response()).type, ComponentType.Button);
  assert.equal(h.inspected.length, 2);
  assert.equal(h.posts.length, 1);
});

test('timed-out retirement plus 503 readback never repeats the exact DELETE or POST after restarting', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lxr-panel-retirement-'));
  let db, deletes = 0, unavailable = false, exactReads = 0;
  const reopen = () => {
    db?.close();
    db = new DatabaseSync(join(dir, 'panel.sqlite'));
    return openTempVoiceStore(db);
  };
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });
  const route = Routes.channelMessage(PANEL, LEGACY_POST);
  const h = await controls({ state: reopen(), setupMessage: async h => {
    h.messages.get(PANEL).push(legacyMessage());
    const read = new REST({ retries: 0, makeRequest: async (url, { method }) => {
      assert.equal(method, 'GET');
      assert.equal(new URL(url).pathname, '/api/v10' + route);
      exactReads++;
      if (unavailable) return Response.json({ message: 'read unavailable' }, { status: 503 });
      const old = h.messages.get(PANEL).find(m => m.id === LEGACY_POST);
      return old ? Response.json(old) : Response.json({ message: 'Unknown Message', code: 10008 }, { status: 404 });
    } }).setToken('fixture-only');
    read.clearHashSweeper(); read.clearHandlerSweeper();
    const get = h.client.rest.get;
    h.client.rest.get = (path, opts) => path === route ? read.get(path, opts) : get(path, opts);
    const writer = createApplicationMutationRest('fixture-only', { makeRequest: async (url, { method }) => {
      assert.equal(method, 'DELETE');
      assert.equal(new URL(url).pathname, '/api/v10' + route);
      deletes++;
      unavailable = true;
      throw new DOMException('timeout before response', 'TimeoutError');
    } });
    h.writer.delete = writer.delete.bind(writer);
    await assert.rejects(h.panel.publish(), /deletion not confirmed/);
    assert.equal(exactReads, 3, 'both prior reads succeeded, only the DELETE readback was unavailable');
    assert.equal(deletes, 1);
    unavailable = false;
    return h.messages.get(PANEL)[0].id;
  } });

  const fresh = h.create({ state: reopen() });
  await assert.rejects(fresh.publish(), /deletion not confirmed/);
  assert.equal(deletes, 1, 'an exact positive readback of the surviving old message must not reauthorize DELETE');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.messages.get(PANEL).map(m => m.id), [h.message.id, LEGACY_POST]);
  for (const from of h.messages.get(PANEL)) {
    assert.equal(await fresh.handle(h.event(P + 'name', { from })), true);
    assert.equal(h.control(h.response()).type, ComponentType.Button);
  }
  assert.equal(h.inspected.length, 2);

  h.messages.get(PANEL).pop(); // The original request later commits.
  unavailable = true;
  await assert.rejects(h.create({ state: reopen() }).publish(), /deletion not confirmed/);
  unavailable = false;
  assert.equal(await h.create({ state: reopen() }).publish(), h.message.id);
  assert.equal(deletes, 1);
  assert.equal(h.posts.length, 1);
});

test('only an exact SDK DELETE refusal permits retirement after persistent backoff', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 1_000, attempted = 0;
  const h = harness({ state: openTempVoiceStore(db), now: () => now });
  h.messages.get(PANEL).push(legacyMessage());
  const route = Routes.channelMessage(PANEL, LEGACY_POST);
  const remove = h.writer.delete;
  const writer = createApplicationMutationRest('fixture-only', { offset: 0, makeRequest: async (url, { method }) => {
    assert.equal(method, 'DELETE');
    assert.equal(new URL(url).pathname, '/api/v10' + route);
    if (++attempted === 1) return Response.json({ message: 'Slow down', retry_after: 2 },
      { status: 429, headers: { 'retry-after': '2', 'x-ratelimit-scope': 'shared' } });
    await remove(route);
    return new Response(null, { status: 204 });
  } });
  h.writer.delete = writer.delete.bind(writer);
  await assert.rejects(h.panel.publish(), /deletion not confirmed/);
  now = 2_999;
  await assert.rejects(h.create({ state: openTempVoiceStore(db) }).publish(), /deletion not confirmed/);
  assert.equal(attempted, 1);
  now = 3_001;
  assert.equal(await h.create({ state: openTempVoiceStore(db) }).publish(), '1578000000000000001');
  assert.equal(attempted, 2);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.deletions, [route]);
});

test('validates the exact bot-authored source before opening any private owner prompt', async () => {
  const h = await controls();
  assert.equal(await h.click('unknown'), false);
  assert.equal(await h.click('name', { guildId: OTHER_ID }), false);
  assert.equal(await h.click('name', { applicationId: OTHER_ID }), false);
  assert.equal(await h.click('name', { actorBot: true }), false);
  assert.equal(await h.click('name', { from: { ...h.message, author: { id: OWNER } } }), false);
  assert.equal(await h.click('name', { from: { ...h.message, id: OTHER_ID } }), false);
  assert.equal(await h.click('name', { sourceId: NEXT_ROOM }), false);
  assert.equal(await h.click('chat'), true);
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.inspected.length, 0);
  assert.equal(await h.click('name'), true);
  assert.deepEqual(h.inspected, [{ guildId: GUILD, actorId: MEMBER, sourceId: PANEL }]);
  assert.equal(h.callbacks[0].type, InteractionResponseType.DeferredChannelMessageWithSource);
  assert.equal(h.callbacks[0].data.flags, MessageFlags.Ephemeral);
  assert.deepEqual(h.response().allowed_mentions, { parse: [], replied_user: false });
  assert.equal(h.control(h.response()).type, ComponentType.Button);
});

test('opens a native rename modal from its private prompt; commits once after fresh authorization', async () => {
  const h = await controls({ origin: ROOM });
  await h.click('name');
  const prompt = h.response();
  const start = h.control(prompt);
  await h.choose(prompt, start);
  const modal = h.callbacks.at(-1);
  assert.equal(modal.type, InteractionResponseType.Modal);
  const field = modal.data.components[0].component ?? modal.data.components[0].components[0];
  assert.equal(field.type, ComponentType.TextInput);
  assert.equal(field.max_length, 100);
  const submit = opts => h.panel.handle(h.event(modal.data.custom_id, { from: prompt, value: 'صوت خاص', ...opts }));
  await submit({ actor: TARGET });
  assert.equal(h.executed.length, 0);
  await Promise.all([submit(), submit()]);
  assert.deepEqual(h.executed, [{ guildId: GUILD, actorId: MEMBER, sourceId: ROOM,
    roomId: ROOM, expectedOwnerId: MEMBER, expectedLocked: false, expectedLockGeneration:'0', kind: 'name', value: 'صوت خاص' }]);
  assert.equal(h.inspected.length, 2);
  assert.ok(h.replies.every(r => r.flags === MessageFlags.Ephemeral));
});

test('demands separate delete confirmation and rejects owner, room, or source-message changes before commit', async () => {
  for (const change of ['owner', 'room', 'panel', 'lock', 'none']) {
    const h = await controls();
    await h.click('delete');
    const confirm = h.response();
    assert.equal(h.executed.length, 0);
    if (change === 'owner') h.current.ownerId = TARGET;
    if (change === 'room') h.current.roomId = NEXT_ROOM;
    if (change === 'panel') h.messages.get(PANEL).length = 0;
    if (change === 'lock') h.current.locked = true;
    await h.choose(confirm, h.control(confirm));
    await h.choose(confirm, h.control(confirm));
    assert.equal(h.executed.length, change === 'none' ? 1 : 0);
    if (change === 'none') assert.equal(h.executed[0].kind, 'delete');
  }
});

test('does not expose owner controls to guests, but claim revalidates current eligibility', async () => {
  const current = { roomId: ROOM, ownerId: TARGET, canClaim: true, locked: false, lockGeneration:'0' };
  const h = await controls({ current });
  await h.click('privacy');
  assert.equal(h.response().components.length, 0);
  const request = () => h.click('claim');
  await request();
  const before = h.response();
  current.canClaim = false;
  await h.choose(before, h.control(before));
  assert.equal(h.executed.length, 0);
  current.canClaim = true;
  await request();
  await h.choose(h.response(), h.control(h.response()));
  assert.equal(h.executed[0].kind, 'claim');
  assert.equal(h.executed[0].expectedOwnerId, TARGET);
});

test('expires frames and cannot reuse them across channels, members, component types, or altered private sources', async () => {
  let clock = 1;
  const h = await controls({ now: () => clock, frameTtlMs: 100 });
  await h.click('delete');
  const prompt = h.response();
  const confirm = h.control(prompt);
  await h.choose(prompt, confirm, { actor: TARGET });
  await h.choose(prompt, confirm, { sourceId: ROOM });
  await h.choose(prompt, confirm, { type: ComponentType.StringSelect, values: ['false'] });
  await h.choose({ ...prompt, flags: 0 }, confirm);
  assert.equal(h.executed.length, 0);
  clock += 100;
  await h.choose(prompt, confirm);
  assert.equal(h.executed.length, 0);
});

test('offers only entry lock or reopen, validates the lock snapshot, and never offers hidden rooms', async () => {
  for (const origin of [PANEL, ROOM]) {
    const h = await controls({ origin });
    const openPrompt = async options => {
      await h.click('privacy');
      const prompt = h.response();
      const select = h.control(prompt);
      assert.equal(select.type, ComponentType.StringSelect);
      assert.deepEqual(select.options.map(o => o.value), options);
      return [prompt, select];
    };
    let [prompt, select] = await openPrompt(['locked']);
    await h.choose(prompt, select, { values: ['hidden'] });
    assert.equal(h.executed.length, 0);
    [prompt, select] = await openPrompt(['locked']);
    await h.choose(prompt, select, { values: ['locked'] });
    assert.deepEqual(h.executed.at(-1), { guildId: GUILD, actorId: MEMBER, sourceId: origin,
      roomId: ROOM, expectedOwnerId: MEMBER, kind: 'privacy', value: 'locked', expectedLocked: false, expectedLockGeneration:'0' });
    [prompt, select] = await openPrompt(['locked']);
    h.current.locked = true;
    await h.choose(prompt, select, { values: ['locked'] });
    assert.equal(h.executed.length, 1);
    [prompt, select] = await openPrompt(['open']);
    await h.choose(prompt, select, { values: ['open'] });
    assert.equal(h.executed.at(-1).expectedLocked, true);
    assert.equal(h.executed.at(-1).value, 'open');
    for (const kind of ['limit', 'invite']) {
      await h.click(kind);
      assert.equal(h.response().components.length, 0);
    }
  }
});

test('a previously open lock prompt cannot re-lock a room after an intervening lock and reopen', async () => {
  const h=await controls();
  await h.click('privacy');
  const earlier=h.response();
  h.current.locked=true;
  h.current.lockGeneration='1';
  h.current.locked=false;
  h.current.lockGeneration='2';
  await h.choose(earlier,h.control(earlier),{values:['locked']});
  assert.deepEqual(h.executed,[]);
  assert.match(h.response().description,/انتهت صلاحية/u);
});

test('disabled controls cannot start a prompt even if a caller submits their component IDs', async () => {
  const h = await controls();
  for (const kind of ['waiting', 'trust', 'untrust', 'block', 'unblock', 'chat']) await h.click(kind);
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.inspected.length, 0);
  assert.equal(h.executed.length, 0);
});

test('native panel clicks reach the real lock handler and restore the cap without touching access in SQLite-backed rooms', async t => {
  const { createTempVoiceActions } = require('../src/lxr-temp-voice-actions');
  const { openTempVoiceStore } = require('../src/lxr-temp-voice-store');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const state = openTempVoiceStore(db);
  const voices = new Map([MEMBER, TARGET].map(id => [id, {channelId:ROOM,sessionId:`session-${id}`} ]));
  assert.ok(state.begin(MEMBER, 'recovery marker', voices.get(MEMBER).sessionId, []));
  assert.equal(state.bind(MEMBER, 'recovery marker', ROOM).id, ROOM);
  let actions;
  const h = await controls({ origin: ROOM, state, actions: {
    inspect: request => actions.inspect(request), run: request => actions.run(request),
  } });
  h.guild.available = true;
  h.guild.shard = {status:Status.Ready};
  h.guild.voiceStates = {cache:voices};
  h.client.isReady = () => true;
  h.client.options.intents = h.client.options.intents.add(GatewayIntentBits.GuildVoiceStates);
  const permitted = '1575000000000000801', botRole='1575000000000000802';
  const roleRows = [{id:GUILD,permissions:'0'},{id:permitted,permissions:'0'},{id:botRole,permissions:String(Perm.Administrator)}];
  const acl = [
    {id:GUILD,type:OverwriteType.Role,allow:'0',deny:String(Perm.ViewChannel|Perm.Connect)},
    {id:permitted,type:OverwriteType.Role,allow:String(Perm.ViewChannel|Perm.Connect|Perm.SendMessages),deny:'0'},
  ];
  const room = {id:ROOM,guild_id:GUILD,parent_id:CATEGORY,type:ChannelType.GuildVoice,name:'Test',user_limit:8,
    permission_overwrites:structuredClone(acl)};
  const category = {id:CATEGORY,guild_id:GUILD,type:ChannelType.GuildCategory,permission_overwrites:structuredClone(acl)};
  const previousRead = h.client.rest.get;
  h.client.rest.get = async (route, opts) => {
    if (route === Routes.guild(GUILD)) return {id:GUILD,owner_id:OWNER};
    if (route === Routes.guildRoles(GUILD)) return structuredClone(roleRows);
    if (route === Routes.channel(CATEGORY)) return structuredClone(category);
    if (route === Routes.channel(ROOM)) return structuredClone(room);
    for (const id of [BOT, MEMBER, TARGET]) {
      if (route === Routes.guildMember(GUILD,id)) return {user:{id,bot:id===BOT},roles:id===BOT?[botRole]:[permitted]};
      if (route === Routes.guildVoiceState(GUILD,id) && voices.has(id)) {
        const {channelId,sessionId}=voices.get(id);
        return {guild_id:GUILD,user_id:id,channel_id:channelId,session_id:sessionId};
      }
    }
    return previousRead(route,opts);
  };
  const writes=[];
  let exclusive=false;
  actions=createTempVoiceActions({state,guildId:GUILD,categoryId:CATEGORY,lobbyId:LOBBY,panelId:PANEL,
    readyGuild:()=>h.guild,exclusive:async work=>{exclusive=true;try {return await work();} finally {exclusive=false;}},
    getWriter:()=>({patch:async(route,{body})=>{
      assert.equal(exclusive,true);
      assert.equal(route,Routes.channel(ROOM));
      assert.deepEqual(Object.keys(body),['user_limit']);
      writes.push(structuredClone(body));
      Object.assign(room,body);
      return structuredClone(room);
    }})});
  const choosePrivacy = async (value, actor = MEMBER) => {
    await h.click('privacy',{actor});
    const prompt=h.response();
    if (actor !== MEMBER) { assert.equal(prompt.components.length,0); return; }
    assert.equal(prompt.components.length,1,'the actual backend exposes a known lock state to the panel');
    const picker=h.control(prompt);
    assert.deepEqual(picker.options.map(o=>o.value),[value]);
    await h.choose(prompt,picker,{values:[value]});
  };
  await choosePrivacy('locked', TARGET);
  assert.deepEqual(writes,[]);
  await choosePrivacy('locked');
  assert.equal(room.user_limit,1);
  assert.equal(voices.size,2);
  await choosePrivacy('open');
  assert.deepEqual(writes,[{user_limit:1},{user_limit:8}]);
  assert.deepEqual(room.permission_overwrites,acl);
  assert.deepEqual(category.permission_overwrites,acl);
  assert.ok(h.replies.every(reply=>reply.flags===MessageFlags.Ephemeral));
});

test('uses native value and member pickers with strict limits and live supported regions', async () => {
  const h = await controls();
  for (const [kind, value, accepted] of [['region', 'deprecated-region', false], ['region', 'rotterdam', true], ['region', 'auto', true]]) {
    const before = h.executed.length;
    await h.click(kind);
    const picker = h.response();
    const select = h.control(picker);
    assert.equal(select.type, ComponentType.StringSelect);
    if (kind === 'region') assert.deepEqual(select.options.map(o => o.value), ['auto', 'rotterdam']);
    await h.choose(picker, select, { values: [value] });
    assert.equal(h.executed.length, before + Number(accepted));
  }
  for (const kind of ['invite', 'disconnect', 'transfer']) {
    await h.click(kind);
    const picker = h.response();
    const select = h.control(picker);
    assert.equal(select.type, ComponentType.UserSelect);
    await h.choose(picker, select, { values: [TARGET] });
    assert.equal(h.executed.at(-1).targetId, TARGET);
    assert.equal(h.executed.at(-1).kind, kind);
  }

  for (const [value, accepted] of [['99', true], ['0', true], ['100', false], ['1e1', false]]) {
    const before = h.executed.length;
    await h.click('limit');
    const prompt = h.response();
    await h.choose(prompt, h.control(prompt));
    await h.panel.handle(h.event(h.callbacks.at(-1).data.custom_id, { from: prompt, value }));
    assert.equal(h.executed.length, before + Number(accepted));
    if (accepted) assert.equal(h.executed.at(-1).value, Number(value));
  }
});
