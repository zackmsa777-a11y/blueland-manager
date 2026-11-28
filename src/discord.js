'use strict';

const { catalog, RuleError, compareRoles } = require('./ladder');
const {commandRoleChecker}=require('./command-roles');
const { createMessageHandler } = require('./chat');
const { liveDirectory } = require('./directory');
const { makeService } = require('./promotions');
const { createCommunity } = require('./community');
const { communityGateway } = require('./discord-community');
const { commandRunner, parseChat, registerCommands, interactionInput, commands } = require('./commands');
const {createVoiceActivity}=require('./activity-top');
const {createDailyTopReport}=require('./activity-report');
const { createDiscordGames } = require('./discord-games');
const { createShortcutHandler } = require('./shortcut-dispatch');
const { createLxrStart } = require('./lxr-start');
const { createLxrApply } = require('./lxr-apply');
const { createApplicationTickets,createApplicationManager,createApplicationMutationRest } = require('./lxr-apply-tickets');
const {createInRole}=require('./lxr-inrole');

function connectDiscord(store, env) {
  let client, api, timer, applicationChannelRest, applicationMutationRest, inRole, recovering = false, cachedDirectory, refresh, validUntil = 0, attemptedToken;
  let connection = { code: 'offline', text: 'بانتظار ربط البوت' };
  const allowed = new Set((env.PROMOTER_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const botId = env.DISCORD_APPLICATION_ID || catalog.botId;
  function readyGuild() {
    const guild = client?.guilds.cache.get(catalog.guildId);
    if (!client?.isReady() || !guild?.available || client.user.id !== botId) {
      throw new RuleError('البوت غير متصل بسيرفر BlueLand. راجع إعدادات الربط.', 503);
    }
    return guild;
  }
  function person(member) {
    return { id: member.user.id, name: member.nick || member.user.global_name || member.user.username,
      bot: Boolean(member.user.bot), roles: member.roles };
  }
  async function context(actorId, targetId = actorId) {
    const guild = readyGuild();
    const member = id => client.rest.get(api.Routes.guildMember(guild.id, id));
    try {
      const ids = [...new Set([actorId, targetId, client.user.id])];
      const [all, members] = await Promise.all([
        client.rest.get(api.Routes.guildRoles(guild.id)),
        Promise.all(ids.map(member))
      ]);
      const found = new Map(members.map(m => [m.user.id, person(m)]));
      return { roles: new Map(all.map(r => [r.id, r])), actor: found.get(actorId), target: found.get(targetId),
        bot: found.get(client.user.id), ownerId: guild.ownerId, operatorId: env.DEMOTION_OPERATOR_ID || env.CODEX_OPERATOR_ID };
    } catch (err) {
      if (err.code === 10007 || err.code === 10013) throw new RuleError('العضو غير موجود في سيرفر BlueLand.', 404);
      if (err.code === 50001 || err.code === 50013) throw new RuleError('تعذّرت قراءة العضو أو الرولات بصلاحيات البوت الحالية.', 403);
      throw err;
    }
  }
  async function change(entry, role, add) {
    const guild = readyGuild();
    const route = api.Routes.guildMemberRole(guild.id, entry.target, role);
    const reason = 'BlueLand promotion · ' + entry.actor + ' · ' + entry.id;
    if (add) await client.rest.put(route, { reason });
    else await client.rest.delete(route, { reason });
  }
  const service = makeService(store, { context, change }, allowed);
  const gateway=communityGateway(readyGuild,context);
  const checkCommandRole=commandRoleChecker(store.commandRoles,actor=>client.rest.get(api.Routes.guildMember(readyGuild().id,actor)));
  async function commandRoleOptions() {
    const guild=readyGuild();
    const roles=await client.rest.get(api.Routes.guildRoles(guild.id));
    return roles.filter(r=>r.id!==guild.id && !r.tags?.bot_id).sort(compareRoles).map(({id,name})=>({id,name}));
  }
  const community=createCommunity(store,gateway,service,checkCommandRole);
  const games=createDiscordGames(store.roulette,checkCommandRole);
  async function authorize(id) {
    const ctx = await context(id);
    service.checkOperator(ctx);
    return { id, name: ctx.actor.name };
  }
  async function recover() {
    if (recovering || !client?.isReady()) return;
    recovering = true;
    try { await service.recover(); await community.recover(); } finally { recovering = false; }
  }
  async function pair(actor) {
    await community.dashboard(actor);
    const code=store.loginCode(actor);
    return 'رمز دخول لوحة BlueLand، صالح لخمس دقائق:\n'+code+(env.PUBLIC_ORIGIN?'\n'+env.PUBLIC_ORIGIN:'');
  }
  const bulkRole = require('./bulk-role').createBulkRole({readyGuild,
    reservedRole: id => allowed.has(id) || store.community.settings().supportRole === id});
  const run=commandRunner({store,community,promotions:service,readyGuild,pair,bulkRole,checkCommandRole});
  const shortcuts=createShortcutHandler({shortcuts:store.shortcuts,context,readyGuild,service,community,run,games,
    lookupTicket:channel=>store.community.ticketByChannel(channel)});
  const tickets=require('./discord-tickets').createDiscordTickets({db:store.community,community,readyGuild});
  const lxrStart=createLxrStart({readyGuild});
  const applicationManager=createApplicationManager({readyGuild,state:store.applicationRooms,getChannelWriteRest:()=>applicationMutationRest,checkCommandRole});
  const lxrApply=createLxrApply({readyGuild,receipts:store.applications,
    openTicket:createApplicationTickets({readyGuild,getChannelWriteRest:()=>applicationChannelRest,managementState:store.applicationRooms})});
  let lxrApplyReady=false;
  const syncLxrApply=()=>{
    if (!lxrApplyReady && client?.isReady()) void lxrApply.publish().then(()=>{lxrApplyReady=true;})
      .catch(err=>console.warn('LXR application panel:',err.code || err.name));
  };
  let lxrStartReady=false;
  const syncLxrStart=()=>{
    if (!lxrStartReady && client?.isReady()) void lxrStart.publish().then(()=>{lxrStartReady=true;})
      .catch(err=>console.warn('LXR start panel:',err.code || err.message));
  };

  const voice=createVoiceActivity(store.community);
  let voiceTimer;
  let dailyTopTimer;
  const trackVoice=work=>{try {work();} catch(err) {voice.reset();console.warn('BlueLand voice activity:',err.code || err.name);}};
  const dailyTop=createDailyTopReport({db:store.community,botId,
    getChannel:id=>readyGuild().channels.fetch(id,{force:true,cache:false}),
    beforeSnapshot:()=>voice.checkpoint(readyGuild())});
  const tickDailyTop=()=>{
    if (client?.isReady()) void dailyTop().catch(err=>console.warn('BlueLand daily top:',err.code || err.message));
  };
  const syncTickets=()=>tickets.syncPanel().catch(err=>console.warn('BlueLand ticket panel:',err.code || err.message));
  let syncing=false;
  async function sync() {
    if (syncing || connection.slashReady===commands.length) return;
    syncing=true;
    try { connection.slashReady=await registerCommands(client,readyGuild().id); }
    catch { connection.slashReady=0; }
    finally { syncing=false; }
  }
  async function start() {
    const token=env.DISCORD_BOT_TOKEN?.trim();
    if (!token || token===attemptedToken || connection.code==='connecting' || client?.isReady()) return;
    attemptedToken=token;
    connection = { code: 'connecting', text: 'جارٍ الاتصال بديسكورد' };
    try {
      api = require('discord.js');
      const rest=new api.REST({version:'10'}).setToken(token);
      const app=await rest.get(api.Routes.oauth2CurrentApplication());
      if (app.id!==botId) throw new RuleError('التوكن يخص تطبيق ديسكورد مختلفًا.');
      // Channel creation has no nonce. Do not automatically replay a possibly committed POST.
      applicationChannelRest=new api.REST({version:'10',retries:0}).setToken(token);
      applicationChannelRest.clearHashSweeper();
      applicationChannelRest.clearHandlerSweeper();
      applicationMutationRest=createApplicationMutationRest(token);
      const flags=BigInt(app.flags || 0);
      const intents=[api.GatewayIntentBits.Guilds,api.GatewayIntentBits.GuildMessages,api.GatewayIntentBits.DirectMessages,api.GatewayIntentBits.GuildVoiceStates];
      const contentEnabled=Boolean(flags & ((1n<<18n)|(1n<<19n)));
      const membersEnabled=Boolean(flags & ((1n<<14n)|(1n<<15n)));
      if (contentEnabled) intents.push(api.GatewayIntentBits.MessageContent);
      if (membersEnabled) intents.push(api.GatewayIntentBits.GuildMembers);
      client = new api.Client({ intents, partials:[api.Partials.Channel], allowedMentions: { parse: [], repliedUser: false } });
      const connected=client;
      const readyRosterGuild=()=>{
        if (client!==connected) throw Error('Stale roster gateway');
        return readyGuild();
      };
      // Isolate roster replies from other features' queues and never automatically retry a write.
      const roster=createInRole({rest:createApplicationMutationRest(token),readyGuild:readyRosterGuild,botId,
        assertGenericScope:gateway.assertGenericScope,
        isTicketRoom:id=>Boolean(store.community.ticketByChannel(id) || store.applicationRooms.read(id))});
      inRole=roster;
      const onMessage=createMessageHandler({authorize:community.dashboard,service,store,publicOrigin:env.PUBLIC_ORIGIN,run,parse:parseChat,shortcuts,checkCommandRole,
        ticketMessages:tickets.text,assertGenericChannel:gateway.assertGenericChannel,inRole:roster,
        applicationResetContext:context,resetApplication:lxrApply.reset,applicationTicketMessages:applicationManager.text});
      const readyTempGuild=()=>{
        if (client!==connected) throw Error('Stale voice gateway');
        return readyGuild();
      };
      const tempVoice=require('./lxr-temp-voice-hooks').createTempVoiceHooks({state:store.tempVoice,readyGuild:readyTempGuild,
        // Fresh writer for one mutation sequence, not shared with other Discord services.
        getWriter:()=>{readyTempGuild();return createApplicationMutationRest(token);}});
      for (const event of [api.Events.GuildRoleCreate, api.Events.GuildRoleUpdate, api.Events.GuildRoleDelete]) {
        client.on(event, () => { validUntil = 0; });
      }
      client.on(api.Events.MessageCreate, onMessage);
      client.on(api.Events.VoiceStateUpdate,(old,state)=>{
        if (client!==connected || !connected.isReady()) return;
        trackVoice(()=>voice.update(state));
        void tempVoice.voiceState(old,state);
      });
      client.on(api.Events.GuildUnavailable,guild=>{if(guild.id===catalog.guildId) voice.reset();});
      client.on(api.Events.ChannelDelete,c=>{
        if (c.guildId!==catalog.guildId) return;
        void tempVoice.channelDeleted(c);
        games.removeRoom(c.id);
        store.community.ticketRemoved(c.id);
      });
      client.on(api.Events.ThreadDelete,t=>games.removeRoom(t.id));
      client.on(api.Events.MessageDelete,m=>games.removeMessage(m.channelId,m.id));
      client.on(api.Events.MessageBulkDelete,messages=>{
        for (const m of messages.values()) games.removeMessage(m.channelId,m.id);
      });
      client.on(api.Events.InteractionCreate, async i=>{
        if (!i.guildId && i.isStringSelectMenu() && ['blgshop:buy','blgshop:equip'].includes(i.customId) && i.message?.author?.id===client.user.id) {
          await games.handle(i);
          return;
        }
        if (i.customId?.startsWith('lxr-inrole:') && await roster.button(i)) return;
        if (i.guildId!==catalog.guildId || (i.isChatInputCommand() && i.commandGuildId!==catalog.guildId)) return;
        if (await tempVoice.handle(i)) return;
        if (await lxrApply.handle(i)) return;
        if (await applicationManager.interaction(i)) return;
        try { await gateway.assertGenericChannel(i.channelId,{useCache:true}); }
        catch {
          const payload={content:'الأوامر العامة غير متاحة في روم التقديم هذا.',allowedMentions:{parse:[]}};
          if (i.deferred) await i.editReply(payload).catch(()=>{});
          else if (i.isChatInputCommand()) await i.reply({...payload,flags:api.MessageFlags.Ephemeral}).catch(()=>{});
          return;
        }
        if (await lxrStart.handle(i) || await tickets.interaction(i) || await games.handle(i)) return;
        if (!i.isChatInputCommand() || !commands.some(c=>c.name===i.commandName)) return;
        try {
          if (!i.deferred) await i.deferReply({flags:api.MessageFlags.Ephemeral});
          const output=await run({...interactionInput(i),originChannel:i.channelId});
          await i.editReply({...(typeof output==='string'?{content:output}:output),allowedMentions:{parse:[]}});
        } catch(err) {
          const msg=err instanceof RuleError?err.message:'تعذّر إتمام الأمر. راجع صلاحيات البوت وحالة الاتصال.';
          if (i.deferred || i.replied) await i.editReply({content:msg,allowedMentions:{parse:[]}}).catch(()=>{});
        }
      });
      client.on(api.Events.GuildMemberAdd,async m=>{
        if (m.guild.id!==catalog.guildId || m.user.bot) return;
        const id=store.community.settings().welcomeChannel;
        if (!id) return;
        try {
          await gateway.assertGenericChannel(id);
          const room=await m.guild.channels.fetch(id);
          if (room?.isTextBased()) await room.send({content:'أهلًا <@'+m.id+'> في BlueLand Empire!',allowedMentions:{parse:[]}});
        } catch {}
      });
      client.on(api.Events.ClientReady, () => {
        if (client.user.id !== botId) {
          connection = { code: 'error', text: 'التوكن يخص تطبيق ديسكورد مختلفًا' };
          client.destroy();
          return;
        }
        connection = { code: 'online', text: 'البوت متصل', slashReady:0, slashTotal:commands.length, contentEnabled, membersEnabled };
        recover().catch(() => {});
        sync().catch(()=>{});
        void syncTickets();
        syncLxrStart();
        syncLxrApply();
        void tempVoice.tick();
        clearInterval(timer);
        timer = setInterval(() => { recover().catch(() => {}); sync().catch(()=>{}); void syncTickets(); syncLxrStart(); syncLxrApply(); void tempVoice.tick(); }, 60_000);
        timer.unref();
        const checkpoint=()=>{
          const guild=client.isReady()?client.guilds.cache.get(catalog.guildId):null;
          if (guild?.available) trackVoice(()=>voice.checkpoint(guild)); else voice.reset();
        };
        clearInterval(voiceTimer);
        checkpoint();
        voiceTimer=setInterval(checkpoint,30_000);
        voiceTimer.unref();
        clearInterval(dailyTopTimer);
        dailyTopTimer=setInterval(tickDailyTop,5_000);
        dailyTopTimer.unref();
        tickDailyTop();
      });
      client.on(api.Events.Error, () => {});
      client.on(api.Events.ShardDisconnect, event => {
        voice.reset();
        if (event.code === 4014) connection = { code: 'error', text: 'فعّل Message Content Intent في إعدادات التطبيق' };
      });
      await client.login(token);
    } catch (err) {
      clearInterval(timer);
      clearInterval(voiceTimer);
      clearInterval(dailyTopTimer);
      voice.reset();
      inRole?.close();
      client?.destroy();
      applicationChannelRest=undefined;
      let message = 'تعذّر اتصال البوت. راجع التوكن والاتصال بديسكورد.';
      if (err instanceof RuleError) message=err.message;
      if (err.code === 'MODULE_NOT_FOUND') message = 'ثبّت مكتبات البوت بتشغيل npm ci داخل المشروع.';
      if (String(err.message).includes('disallowed intents')) message = 'فعّل Message Content Intent في إعدادات تطبيق ديسكورد.';
      connection = { code: 'error', text: message };
    }
  }
  function status() {
    if (connection.code === 'online') {
      try { readyGuild(); } catch { return { code: 'unavailable', text: 'اتصال البوت بسيرفر BlueLand غير متاح' }; }
      return {...connection,latencyMs:client.ws.ping>=0?Math.round(client.ws.ping):null};
    }
    return connection;
  }
  async function directory() {
    if (status().code !== 'online') return { ...(cachedDirectory || catalog), source:'snapshot' };
    if (cachedDirectory && Date.now() < validUntil) return cachedDirectory;
    if (!refresh) {
      refresh = client.rest.get(api.Routes.guildRoles(catalog.guildId))
        .then(raw => {
          cachedDirectory=liveDirectory(raw,new Date().toISOString(),readyGuild().members.me?.roles.highest.id);
          validUntil=Date.now()+60_000;
          return cachedDirectory;
        })
        .catch(() => ({ ...(cachedDirectory || catalog), source:'snapshot', warning:'تعذّر تحديث الدليل من ديسكورد. المعروض آخر قائمة محفوظة.' }))
        .finally(() => { refresh=null; });
    }
    return refresh;
  }
  async function loadLocalConfig(config) {
    if (Object.hasOwn(config,'PROMOTER_ROLE_IDS')) {
      allowed.clear();
      for (const id of config.PROMOTER_ROLE_IDS.split(',').map(s=>s.trim()).filter(Boolean)) allowed.add(id);
    }
    if (config.DISCORD_BOT_TOKEN?.trim() && config.DISCORD_BOT_TOKEN.trim()!==attemptedToken) {
      clearInterval(timer);
      inRole?.close();
      await client?.destroy();
      client=undefined;
      applicationChannelRest=undefined;
      connection={code:'offline',text:'بانتظار ربط البوت'};
      env.DISCORD_BOT_TOKEN=config.DISCORD_BOT_TOKEN;
      return start();
    }
  }
  return { start, loadLocalConfig, status, authorize, dashboardAccess:community.dashboard, service, community, destinations:gateway.destinations, directory,checkCommandRole,commandRoleOptions,
    close() { clearInterval(timer); inRole?.close(); applicationChannelRest=undefined; client?.destroy(); } };
}

module.exports = { connectDiscord };
