'use strict';

const {ChannelType, GatewayIntentBits, PermissionFlagsBits:P, RateLimitError, RESTJSONErrorCodes, Routes, Status} = require('discord.js');
const {aclPolicy} = require('./lxr-temp-voice-acl');

const ID = /^\d{17,20}$/u;
const isId = value => typeof value === 'string' && ID.test(value);
const text = {
  guild:'لا يمكن استخدام هذا التحكم خارج الخادم المحدد.', source:'استخدم لوحة غرفتك أو لوحة التحكم المخصصة.',
  actor:'تعذر التحقق من العضو.', room:'يجب أن تكون داخل الغرفة الصوتية المؤقتة الخاصة بك.',
  owner:'تغيّر المالك، أو أن هذا التحكم خاص به.',
  unsafe:'تعذر التحقق من حالة الغرفة بأمان.', uncertain:'تعذر التأكد من تنفيذ الإجراء. تحقق من الحالة أولًا.',
  action:'هذا الإجراء غير متاح.', name:'الاسم غير صالح. الحد الأقصى 100 حرف.',
  limit:'الحد يجب أن يكون عددًا صحيحًا من 0 إلى 99.', region:'المنطقة الصوتية غير متاحة.',
  target:'العضو غير مؤهل لهذا الإجراء أو ليس في المكان المطلوب.', owned:'العضو يملك غرفة مؤقتة بالفعل.',
  acl:'لا يمكن تطبيق الإجراء دون تجاوز صلاحيات الفئة. تحقق من الصلاحيات.',
  privacy:'إعداد الخصوصية غير صالح.',
  lockStale:'تغيّرت حالة القفل منذ فتح التحكم. افتح التحكم مجددًا.',
  lockConflict:'تغيّر حد الأعضاء خارج التحكم ويتعارض مع سجل القفل. راجع مشرف الخادم.',
  limitLocked:'لا يمكن تغيير حد الأعضاء والغرفة مقفلة. افتحها أولًا.',
  waiting:'تعذر التحقق من غرفة الانتظار أو تغيّرت منذ فتح التحكم.',
  lockRejected:'رفض ديسكورد تغيير حد الأعضاء؛ لم تتغير حالة القفل.',
  inviteLocked:'لا يمكن مشاركة رابط الغرفة وهي مقفلة.',
};
class RoomError extends Error {}
function fail(key) { throw new RoomError(text[key]); }
const safe = error => error instanceof RoomError ? error : new RoomError(text.unsafe);
const absent = (error, code) => error?.status === 404 && error.code === code;
const privacyModes = new Set(['open','locked','hidden']);
const isWaitingMarker = value => typeof value === 'string' && /^غرفة انتظار · [a-f0-9]{32}$/u.test(value);
const supported = new Set(['name','limit','region','claim','transfer','disconnect','privacy','delete','invite']);
const lockLimit = 1;
const isLimit = n => Number.isInteger(n) && n >= 0 && n <= 99;
const sameCategory = (actual,baseline) => actual.size === baseline.size && [...actual].every(([id,row]) => {
  const parent = baseline.get(id);
  return parent?.type === row.type && parent.allow === row.allow && parent.deny === row.deny;
});

function createTempVoiceActions({state, guildId, lobbyId, categoryId, panelId, readyGuild, getWriter, exclusive}) {
  if (![guildId, lobbyId, categoryId, panelId].every(isId) || new Set([guildId, lobbyId, categoryId, panelId]).size !== 4) {
    throw new TypeError('Invalid temporary voice scope');
  }
  const fixed = new Set([guildId, lobbyId, categoryId, panelId]);
  const managedId = id => isId(id) && !fixed.has(id);
  function getGuild() {
    let guild;
    try { guild = readyGuild(); } catch { fail('guild'); }
    if (guild?.id !== guildId || guild.available !== true || !guild.client?.isReady() || guild.shard?.status !== Status.Ready ||
        !guild.client.options.intents.has(GatewayIntentBits.GuildVoiceStates) || !guild.voiceStates?.cache) fail('guild');
    return guild;
  }
  const read = (guild, route) => guild.client.rest.get(route);
  async function channel(guild, id, type, parent, allowMissing = false) {
    let row;
    try { row = await read(guild, Routes.channel(id)); } catch (error) {
      if (absent(error, RESTJSONErrorCodes.UnknownChannel)) {
        if (allowMissing) return null;
        fail('room');
      }
      throw error;
    }
    if (row?.id !== id || row.guild_id !== guildId || row.type !== type || (parent !== undefined && row.parent_id !== parent)) fail('room');
    return row;
  }
  const mainChannel = (guild, id, allowMissing) => channel(guild,id,ChannelType.GuildVoice,categoryId,allowMissing);
  const parentChannel = guild => channel(guild,categoryId,ChannelType.GuildCategory);
  async function member(guild, id) {
    if (!isId(id)) fail('actor');
    let row;
    try { row = await read(guild, Routes.guildMember(guildId,id)); } catch (error) {
      if (absent(error, RESTJSONErrorCodes.UnknownMember)) fail('actor');
      throw error;
    }
    if (row?.user?.id !== id || !Array.isArray(row.roles) || !row.roles.every(isId)) fail('actor');
    return row;
  }
  const human = row => row.user.bot !== true && row.user.system !== true && row.pending !== true;
  const active = row => human(row) && (!row.communication_disabled_until || Date.parse(row.communication_disabled_until) <= Date.now());
  async function voice(guild, id) {
    let row;
    try { row = await read(guild, Routes.guildVoiceState(guildId,id)); } catch (error) {
      if (absent(error, RESTJSONErrorCodes.UnknownVoiceState)) return null;
      throw error;
    }
    if (row?.user_id !== id || (row.guild_id !== undefined && row.guild_id !== guildId) ||
        (row.channel_id !== null && !isId(row.channel_id)) || typeof row.session_id !== 'string' || !row.session_id) fail('unsafe');
    return row.channel_id === null ? null : row;
  }
  function present(guild, id, snapshot, roomId, error = 'room') {
    const cached = guild.voiceStates.cache.get(id);
    if (snapshot?.channel_id !== roomId || cached?.channelId !== roomId || cached.sessionId !== snapshot.session_id) fail(error);
  }
  function validRecord(record, id) {
    return record?.id === id && isId(record.ownerId) && privacyModes.has(record.privacy) &&
      typeof record.lockGeneration === 'string' && record.lockGeneration.length > 0 &&
      ['trusted','blocked','invited'].every(key => Array.isArray(record[key]) && record[key].every(isId)) &&
      (record.waitingId === null || (managedId(record.waitingId) && record.waitingId !== id && isWaitingMarker(record.waitingMarker))) &&
      (record.waitingMarker === null || isWaitingMarker(record.waitingMarker));
  }
  function sameRecord(room) {
    const current = state.get(room.id);
    if (!validRecord(current,room.id) || current.ownerId !== room.ownerId) fail('owner');
    if (current.lockGeneration !== room.lockGeneration) fail('lockStale');
    for (const key of ['privacy','waitingId','waitingMarker','trusted','invited','blocked']) {
      if (JSON.stringify(current[key]) !== JSON.stringify(room[key])) fail('unsafe');
    }
  }
  async function context(request, commit) {
    if (request?.guildId !== guildId) fail('guild');
    if (!isId(request.actorId)) fail('actor');
    if (!isId(request.sourceId)) fail('source');
    const guild = getGuild();
    const current = await voice(guild,request.actorId);
    const roomId = commit ? request.roomId : current?.channel_id;
    if (!managedId(roomId)) fail('room');
    present(guild,request.actorId,current,roomId);
    if (request.sourceId !== panelId && request.sourceId !== roomId) fail('source');
    const room = state.get(roomId);
    if (!validRecord(room,roomId) || state.byWaiting(roomId)) fail('room');
    if (commit && (request.expectedOwnerId !== room.ownerId || (request.kind !== 'claim' && request.actorId !== room.ownerId))) fail('owner');
    const [actor] = await Promise.all([
      member(guild,request.actorId),
      ...(request.sourceId === panelId ? [channel(guild,panelId,ChannelType.GuildText)] : []),
    ]);
    if (!human(actor)) fail('actor');
    const latest = await voice(guild,request.actorId);
    if (latest?.session_id !== current.session_id) fail('room');
    present(guild,request.actorId,latest,roomId);
    sameRecord(room);
    return {guild,room,actor,current:latest};
  }
  function actorStill(ctx) {
    if (getGuild() !== ctx.guild) fail('guild');
    present(ctx.guild,ctx.actor.user.id,ctx.current,ctx.room.id);
    sameRecord(ctx.room);
  }
  async function refreshPresence(ctx,selected) {
    const [current,targetVoice] = await Promise.all([
      voice(ctx.guild,ctx.actor.user.id), selected && voice(ctx.guild,selected.id),
    ]);
    if (current?.session_id !== ctx.current.session_id) fail('room');
    present(ctx.guild,ctx.actor.user.id,current,ctx.room.id);
    actorStill(ctx);
    if (selected) {
      if (targetVoice?.session_id !== selected.current?.session_id) fail('target');
      present(ctx.guild,selected.id,targetVoice,selected.requiredRoom,'target');
    }
  }
  async function writeThenRead(write, verify) {
    try { await write(); } catch { /* A timed out request may have committed; never replay it. */ }
    try { if (await verify()) return; } catch { /* Do not expose Discord transport details. */ }
    fail('uncertain');
  }
  async function canClaim(ctx) {
    const actorId = ctx.actor.user.id;
    if (ctx.room.ownerId === actorId || ctx.room.blocked.includes(actorId) || state.byOwner(actorId)) return false;
    const [ownerVoice] = await Promise.all([voice(ctx.guild,ctx.room.ownerId),refreshPresence(ctx)]);
    return ownerVoice?.channel_id !== ctx.room.id &&
      ctx.guild.voiceStates.cache.get(ctx.room.ownerId)?.channelId !== ctx.room.id && !state.byOwner(actorId);
  }
  async function target(ctx,id,requiredRoom) {
    if (!isId(id) || [ctx.actor.user.id,ctx.room.ownerId].includes(id)) fail('target');
    const row = await member(ctx.guild,id);
    if (!human(row)) fail('target');
    const current = requiredRoom ? await voice(ctx.guild,id) : null;
    if (requiredRoom) present(ctx.guild,id,current,requiredRoom,'target');
    actorStill(ctx);
    return {id,row,current,requiredRoom};
  }
  function update(ctx, patch) {
    sameRecord(ctx.room);
    const result = state.update(ctx.room.id,patch);
    if (!validRecord(result,ctx.room.id) || Object.keys(patch).some(key => JSON.stringify(result[key]) !== JSON.stringify(patch[key]))) fail('unsafe');
    return result;
  }
  async function security(ctx) {
    if (ctx.room.privacy !== 'open' || ['trusted','blocked','invited'].some(key => ctx.room[key].length)) fail('acl');
    const botId = ctx.guild.client.user?.id;
    if (!isId(botId)) fail('acl');
    const [guildRow,roleRows,category,main,botMember,actor] = await Promise.all([
      read(ctx.guild,Routes.guild(guildId)), read(ctx.guild,Routes.guildRoles(guildId)),
      parentChannel(ctx.guild), mainChannel(ctx.guild,ctx.room.id),
      member(ctx.guild,botId), member(ctx.guild,ctx.actor.user.id),
    ]);
    if (guildRow?.id !== guildId || !isId(guildRow.owner_id) || botMember.user.bot !== true || !active(actor)) fail('acl');
    try {
      const acl = aclPolicy({guildId,ownerId:guildRow.owner_id,roleRows,categoryRows:category.permission_overwrites,botId});
      const actual = acl.parse(main.permission_overwrites);
      if (!sameCategory(actual,acl.baseline) || !acl.eligible(actor)) fail('acl');
      return {acl,actual,botMember,limit:main.user_limit};
    } catch { fail('acl'); }
  }
  function capacity(ctx,limit) {
    sameRecord(ctx.room);
    if (!isLimit(limit)) fail('lockConflict');
    const journal = state.getCapacityLock(ctx.room.id);
    if (!journal) return {locked:false,journal,limit};
    if (journal.phase === 'locked') {
      if (limit !== lockLimit) fail('lockConflict');
      return {locked:true,journal,limit};
    }
    const locking = journal.phase === 'locking';
    const from = locking ? journal.priorLimit : lockLimit;
    const to = locking ? lockLimit : journal.priorLimit;
    if (limit === to) return {locked:locking,journal,limit};
    if (limit === from) fail('uncertain');
    fail('lockConflict');
  }
  function replaceCapacity(ctx,journal,next) {
    sameRecord(ctx.room);
    const changed = state.replaceCapacityLock(ctx.room.id,ctx.room.ownerId,journal?.revision ?? null,next,ctx.room.lockGeneration);
    if (!changed) fail('lockStale');
    ctx.room = {...ctx.room,lockGeneration:changed.lockGeneration};
    return changed;
  }
  function settleCapacity(ctx,{locked,journal}) {
    if (journal && journal.phase !== 'locked') {
      replaceCapacity(ctx,journal,locked ? {phase:'locked',priorLimit:journal.priorLimit} : null);
    }
  }
  async function exactScope(ctx,{acl}) {
    const [category,main] = await Promise.all([parentChannel(ctx.guild),mainChannel(ctx.guild,ctx.room.id)]);
    try {
      if (!sameCategory(acl.parse(category.permission_overwrites),acl.baseline) ||
          !sameCategory(acl.parse(main.permission_overwrites),acl.baseline)) fail('acl');
    } catch { fail('acl'); }
    return main;
  }
  async function preflight(ctx,secured,snapshot,selected) {
    await refreshPresence(ctx,selected);
    const latest = await exactScope(ctx,secured);
    // Discord has no conditional channel edit. This limits, but cannot remove,
    // the race with an out-of-band edit after the last read.
    if (latest.user_limit !== snapshot.limit) fail('lockConflict');
    actorStill(ctx);
    if (selected) present(ctx.guild,selected.id,selected.current,selected.requiredRoom,'target');
    if (state.getCapacityLock(ctx.room.id)?.revision !== snapshot.journal?.revision) fail('lockStale');
  }
  async function changePrivacy(ctx,writer,secured,snapshot,lock) {
    await preflight(ctx,secured,snapshot);
    if (snapshot.locked === lock) return lock ? 'الغرفة مقفلة بالفعل.' : 'الغرفة مفتوحة بالفعل.';
    const {acl,actual,botMember} = secured;
    if (!acl.has(actual,botMember,P.ManageChannels | P.ViewChannel)) fail('acl');
    const priorLimit = lock ? snapshot.limit : snapshot.journal.priorLimit;
    const desired = lock ? lockLimit : priorLimit;
    // The journal is durable before the PATCH. A read showing the old value after
    // an ambiguous request is not proof it won't apply later; never replay it.
    const intent = replaceCapacity(ctx,snapshot.journal,{phase:lock ? 'locking' : 'opening',priorLimit});
    let rejected;
    if (snapshot.limit !== desired) {
      try { await writer.patch(Routes.channel(ctx.room.id),{body:{user_limit:desired}}); } catch (error) { rejected = error; }
    }
    // The no-retry Discord.js writer refuses a throttled request instead of
    // replaying it. Only the SDK error class is proof of this refusal.
    if (rejected instanceof RateLimitError) {
      replaceCapacity(ctx,intent,lock ? null : {phase:'locked',priorLimit});
      fail('lockRejected');
    }
    let readback;
    try { readback = await exactScope(ctx,secured); } catch { fail('uncertain'); }
    if (state.getCapacityLock(ctx.room.id)?.revision !== intent.revision) fail('uncertain');
    if (readback.user_limit === snapshot.limit && snapshot.limit !== desired &&
        [400,401,403,404].includes(rejected?.status) && Number.isInteger(rejected.code)) {
      replaceCapacity(ctx,intent,lock ? null : {phase:'locked',priorLimit});
      fail('lockRejected');
    }
    const result = capacity(ctx,readback.user_limit);
    if (result.locked !== lock) fail('uncertain');
    settleCapacity(ctx,result);
    return lock ? 'تم قفل الغرفة. يمكن لمن لديه صلاحية نقل الأعضاء تجاوز الحد.' :
      `تم فتح الغرفة واستعادة حد الأعضاء السابق (${priorLimit}).`;
  }
  async function inspect(request) {
    try {
      return await exclusive(async () => {
        const ctx = await context(request,false);
        const secured = await security(ctx);
        const snapshot = capacity(ctx,secured.limit);
        const canTake = await canClaim(ctx);
        await preflight(ctx,secured,snapshot);
        settleCapacity(ctx,snapshot);
        return {roomId:ctx.room.id,ownerId:ctx.room.ownerId,locked:snapshot.locked,lockGeneration:ctx.room.lockGeneration,canClaim:canTake};
      });
    } catch (error) { throw safe(error); }
  }
  async function changeVoiceSetting(ctx,writer,secured,snapshot,body,verify) {
    const {acl,actual,botMember} = secured;
    if (!acl.has(actual,botMember,P.ManageChannels | P.ViewChannel)) fail('acl');
    await preflight(ctx,secured,snapshot);
    await writeThenRead(() => writer.patch(Routes.channel(ctx.room.id),{body}),async () => verify(await exactScope(ctx,secured)));
  }
  async function run(request) {
    try {
      const {kind,value,targetId} = request ?? {};
      if (!supported.has(kind)) fail('action');
      if (kind === 'privacy' && value !== 'open' && value !== 'locked') fail('privacy');
      return await exclusive(async () => {
        const ctx = await context(request,true);
        const secured = await security(ctx);
        let snapshot = capacity(ctx,secured.limit);
        if (request.expectedLocked !== snapshot.locked) fail('lockStale');
        if (snapshot.journal && snapshot.journal.phase !== 'locked') {
          await preflight(ctx,secured,snapshot);
          settleCapacity(ctx,snapshot);
          snapshot = capacity(ctx,secured.limit);
        }
        if (request.expectedLockGeneration !== ctx.room.lockGeneration) fail('lockStale');
        const {acl,actual,botMember} = secured;
        switch (kind) {
          case 'name': {
            if (typeof value !== 'string' || value.length > 100 || !value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) fail('name');
            const name = value.trim();
            await changeVoiceSetting(ctx,await getWriter(),secured,snapshot,{name},fresh => fresh.name === name);
            return 'تم تغيير الاسم.';
          }
          case 'limit': {
            if (snapshot.locked) fail('limitLocked');
            const n = typeof value === 'string' && /^\d{1,2}$/u.test(value) ? Number(value) : value;
            if (!isLimit(n)) fail('limit');
            await changeVoiceSetting(ctx,await getWriter(),secured,snapshot,{user_limit:n},fresh => fresh.user_limit === n);
            return 'تم تغيير الحد الأقصى للأعضاء.';
          }
          case 'region': {
            const region = [null,'auto','automatic'].includes(value) ? null : value;
            if (region !== null) {
              if (typeof region !== 'string' || !/^[a-z0-9-]{1,32}$/u.test(region)) fail('region');
              const regions = await read(ctx.guild,Routes.voiceRegions());
              if (!Array.isArray(regions) || !regions.some(r => r.id === region && r.deprecated === false && r.custom === false)) fail('region');
            }
            // Recheck permission as well as presence after reading the region catalog.
            const fresh = region === null ? secured : await security(ctx);
            if (fresh.limit !== snapshot.limit) fail('lockConflict');
            await changeVoiceSetting(ctx,await getWriter(),fresh,snapshot,{rtc_region:region},row => row.rtc_region === region);
            return 'تم تغيير المنطقة الصوتية.';
          }
          case 'claim': {
            if (!await canClaim(ctx)) fail('owner');
            await preflight(ctx,secured,snapshot);
            if (ctx.guild.voiceStates.cache.get(ctx.room.ownerId)?.channelId === ctx.room.id) fail('owner');
            if (state.byOwner(ctx.actor.user.id)) fail('owned');
            update(ctx,{ownerId:ctx.actor.user.id});
            return 'أصبحت مالك الغرفة.';
          }
          case 'transfer': {
            const selected = await target(ctx,targetId,ctx.room.id);
            if (!active(selected.row) || !acl.eligible(selected.row)) fail('target');
            await preflight(ctx,secured,snapshot,selected);
            if (state.byOwner(selected.id)) fail('owned');
            update(ctx,{ownerId:selected.id});
            return 'تم نقل ملكية الغرفة.';
          }
          case 'disconnect': {
            const selected = await target(ctx,targetId,ctx.room.id);
            if (!acl.has(actual,botMember,P.MoveMembers | P.ViewChannel)) fail('acl');
            const writer = await getWriter();
            await preflight(ctx,secured,snapshot,selected);
            // Recheck exact REST and gateway voice state after the last channel reads.
            // A disconnect PATCH cannot itself require that the member is still here.
            await refreshPresence(ctx,selected);
            await writeThenRead(() => writer.patch(Routes.guildMember(guildId,selected.id),{body:{channel_id:null}}),
              async () => await voice(ctx.guild,selected.id) === null);
            return 'تم فصل العضو من الغرفة.';
          }
          case 'privacy': return await changePrivacy(ctx,await getWriter(),secured,snapshot,value === 'locked');
          case 'delete': {
            if (ctx.room.waitingId !== null || ctx.room.waitingMarker !== null) fail('waiting');
            if (!acl.has(actual,botMember,P.ManageChannels | P.ViewChannel)) fail('acl');
            const writer = await getWriter();
            await preflight(ctx,secured,snapshot);
            await writeThenRead(() => writer.delete(Routes.channel(ctx.room.id)),
              async () => await mainChannel(ctx.guild,ctx.room.id,true) === null);
            sameRecord(ctx.room);
            state.remove(ctx.room.id);
            if (state.get(ctx.room.id)) fail('unsafe');
            return 'تم حذف الغرفة المؤقتة.';
          }
          case 'invite': {
            if (snapshot.locked) fail('inviteLocked');
            const selected = await target(ctx,targetId);
            await preflight(ctx,secured,snapshot);
            if (!active(selected.row) || !acl.eligible(selected.row)) fail('target');
            return `العضو يستطيع دخول الغرفة حسب صلاحيات الفئة. شارك الرابط معه على الخاص فقط: https://discord.com/channels/${guildId}/${ctx.room.id}`;
          }
          default: fail('action');
        }
      });
    } catch (error) { return safe(error).message; }
  }
  return {inspect,run};
}

module.exports = {createTempVoiceActions};
