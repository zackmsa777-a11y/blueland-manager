'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');
const { preview, RuleError } = require('./ladder');
const { openStore } = require('./store');
const { connectDiscord } = require('./discord');
const { exportCsv } = require('./directory');
const root = path.resolve(__dirname, '..');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2', '.svg':'image/svg+xml' };

// Rebrand display copy at the dashboard boundary, not shared Discord definitions or records.
const dashboardCopy = text => text?.replace(/\bBlueLand(?: Empire| Manager)?\b/g, name =>
  name === 'BlueLand Manager' ? 'LXR Manager' : 'LXR');

function validateOrigin(value) {
  if (!value) return '';
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.origin !== value) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash.');
  return parsed.origin;
}
function memberId(value) {
  const match = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/.exec(String(value || '').trim());
  if (!match) throw new RuleError('اكتب معرّف العضو الرقمي أو منشن ديسكورد.');
  return match[1] || match[2];
}
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new RuleError('استخدم طلب JSON.', 415);
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > 4096) throw new RuleError('الطلب أطول من المسموح.', 413);
    parts.push(part);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new RuleError('بيانات الطلب غير صالحة.'); }
}
function createApp({ store, discord, publicOrigin = '' }) {
  const home = validateOrigin(publicOrigin);
  const cookieFlags = '; Path=/; HttpOnly; SameSite=Strict' + (home ? '; Secure' : '');
  const loginTimes = [];
  return http.createServer(async (req, res) => {
    const json = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (home ? host !== new URL(home).host : !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
        throw new RuleError('عنوان اللوحة غير مسموح.', 403);
      }
      const origin = home || 'http://' + host;
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw new RuleError('عنوان غير صالح.', 403);
      const route = url.pathname;
      const session = /(?:^|;\s*)bl_session=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const actor = store.actor(session);
      async function staff() {
        if (!actor) throw new RuleError('سجّل الدخول برمز +لوحة من ديسكورد.', 401);
        return discord.dashboardAccess ? discord.dashboardAccess(actor) : discord.authorize(actor);
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) throw new RuleError('افتح اللوحة من عنوانها الأصلي.', 403);
        const input = await body(req);
        if (route === '/api/session') {
          const now = Date.now();
          while (loginTimes.length && loginTimes[0] <= now - 60_000) loginTimes.shift();
          if (loginTimes.length >= 20) throw new RuleError('محاولات دخول كثيرة. انتظر دقيقة.', 429);
          loginTimes.push(now);
          const token = store.redeem(String(input.code || '').trim());
          try { await (discord.dashboardAccess || discord.authorize)(store.actor(token)); } catch (err) { store.logout(token); throw err; }
          res.setHeader('Set-Cookie', 'bl_session=' + token + cookieFlags + '; Max-Age=28800');
          return json({ ok:true });
        }
        if (route === '/api/logout') {
          if (session) store.logout(session);
          res.setHeader('Set-Cookie', 'bl_session=' + cookieFlags + '; Max-Age=0');
          return json({ ok:true });
        }
        const viewer=await staff();
        if (route === '/api/command-shortcuts') {
          if (!viewer.rights?.config) throw new RuleError('إضافة الاختصارات تحتاج صلاحية إدارة السيرفر.',403);
          await discord.community.manager(actor);
          return json(store.shortcuts.add(input.phrase,input.command,actor),201);
        }
        if (route === '/api/staff/request') return json(await discord.community.review(actor,input.id,input.decision,input.reason));
        if (route === '/api/staff/ticket') return json(await discord.community.ticketAction(actor,input.id,input.action));
        if (route === '/api/staff/settings') return json(await discord.community.saveSettings(actor,input));
        if (route === '/api/member-preview') {
          const result = await discord.service.preview(actor, memberId(input.target));
          return json({ ...result, requestId: randomUUID() });
        }
        if (route === '/api/promote') {
          if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.requestId) ||
            !(input.expectedFrom === null || /^\d{17,20}$/.test(input.expectedFrom))) throw new RuleError('اعرض معاينة الترقية أولًا.');
          return json(await discord.service.execute({ id:'web:' + actor + ':' + input.requestId, actor,
            target:memberId(input.target), source:'dashboard', expectedFrom:input.expectedFrom }));
        }
        throw new RuleError('المسار غير موجود.', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new RuleError('طريقة الطلب غير مدعومة.', 405);
      if (route === '/api/status') {
        let viewer = null;
        if (actor) {
          try { viewer = await staff(); } catch (err) { if ([403,404].includes(err.status)) store.logout(session); }
        }
        const connection = discord.status();
        return json({ connection:{ ...connection, text:dashboardCopy(connection.text) }, viewer, needsLogin:Boolean(home && !viewer) });
      }
      if (route.startsWith('/api/')) {
        const viewer=home ? await staff() : null;
        if (route==='/api/command-guide') {
          const current=viewer || (actor ? await staff() : null);
          const commands = require('./custom-shortcuts').commandGuide(store.shortcuts).map(command => ({
            ...command, desc:dashboardCopy(command.desc),
            options:command.options.map(option => ({ ...option, description:dashboardCopy(option.description) }))
          }));
          return json({commands,canEdit:Boolean(current?.rights?.config)});
        }
        if (route==='/api/commands') {
          const {commands}=require('./commands');
          return json(commands.map(c=>({name:c.name,description:dashboardCopy(c.description),subcommands:c.options.filter(o=>o.type===1).map(o=>o.name)})));
        }
        if (route==='/api/staff') {
          const viewer=await staff();
          const rights=viewer.rights || {};
          const db=store.community;
          let channels=[];
          if (rights.config) {
            const destinations=await discord.destinations();
            const hidden=new Set(db.privateTicketChannels());
            channels=destinations.filter(channel=>!hidden.has(channel.id));
          }
          return json({rights,points:viewer.points,requests:rights.review?db.requests():[],tickets:rights.tickets?db.tickets().filter(row=>require('./ticket-ui').ticketVisible(row,rights)):[],cases:rights.cases?db.cases():[],
            settings:rights.config?db.settings():null,channels});
        }
        if (route === '/api/catalog') return json({...await discord.directory(),ticketThresholds:require('./ticket-points').thresholds});
        if (route === '/api/simulate') return json(preview(url.searchParams.get('from'), url.searchParams.get('variant') === 'girls'));
        if (route === '/api/history') { if (!home) await staff(); await discord.authorize(actor); return json(store.history()); }
        if (route === '/api/export') {
          const csv=exportCsv(await discord.directory());
          res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="BlueLand-roles.csv"', 'Cache-Control':'no-store' });
          return res.end(csv);
        }
        throw new RuleError('المسار غير موجود.', 404);
      }
      const asset = route === '/' ? 'index.html' : route.slice(1);
      if (!/^(?:assets\/)?[\w.-]+$/.test(asset) || !Object.hasOwn(mime, path.extname(asset))) throw new RuleError('الملف غير موجود.', 404);
      let bytes;
      try { bytes = await fs.promises.readFile(path.join(root, 'public', asset)); }
      catch { throw new RuleError('الملف غير موجود.', 404); }
      res.writeHead(200, { 'Content-Type':mime[path.extname(asset)], 'Cache-Control':'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (err) {
      if (res.headersSent) return res.end();
      json({ error:err instanceof RuleError ? dashboardCopy(err.message) : 'تعذّر إتمام الطلب. راجع اتصال البوت وسجل الترقيات.' }, err.status && err instanceof RuleError ? err.status : 502);
    }
  });
}

if (require.main === module) {
  const localEnv = path.join(root, '.env');
  const envFile = process.env.BLUELAND_ENV_FILE ? path.resolve(root, process.env.BLUELAND_ENV_FILE) : localEnv;
  const credentials = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const store = openStore(process.env.DATABASE_PATH || path.join(root, 'data/blueland.sqlite'));
  const discord = connectDiscord(store, {...process.env, ...credentials});
  const app = createApp({ store, discord, publicOrigin:process.env.PUBLIC_ORIGIN });
  const port = Number(process.env.PORT || 4196);
  app.listen(port, '127.0.0.1', () => {
    console.log('BlueLand Manager · http://127.0.0.1:' + port);
    discord.start().catch(() => console.error('Could not start Discord connection.'));
  });
  fs.watchFile(envFile,{interval:1500,persistent:false},async () => {
    try { await discord.loadLocalConfig(parseEnv(await fs.promises.readFile(envFile,'utf8'))); }
    catch { console.error('Could not reload local bot configuration.'); }
  });
  const stop = () => { fs.unwatchFile(envFile); discord.close(); app.close(() => store.close()); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
module.exports = { createApp };
