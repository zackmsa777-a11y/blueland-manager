'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const test = require('node:test');
const { createApp } = require('../src/server');
const { openStore } = require('../src/store');
const { RuleError } = require('../src/ladder');

const mark = '/assets/lxr.svg';
const staleBrand = /BlueLand(?: Empire| Manager)?|\/assets\/blueland\.png/i;

async function fixture(t, discord = {}) {
  const store = openStore(':memory:');
  const app = createServer();
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const host = `127.0.0.1:${app.address().port}`;
  const origin = `https://${host}`;
  app.on('request', createApp({ store, publicOrigin:origin, discord }).listeners('request')[0]);
  t.after(async () => {
    await new Promise((resolve, reject) => app.close(err => err ? reject(err) : resolve()));
    store.close();
  });
  return { store, origin, request:(path, options) => fetch(`http://${host}${path}`, options) };
}

async function served(request, path, type) {
  const res = await request(path);
  assert.equal(res.status, 200, path);
  assert.equal(res.headers.get('content-type'), type, path);
  return res.text();
}

test('dashboard templates serve the LXR title, accessible brand and same-origin artwork', async t => {
  const { request } = await fixture(t);
  for (const [path, title] of [['/', 'الترقيات'], ['/commands.html', 'دليل الأوامر']]) {
    const html = await served(request, path, 'text/html; charset=utf-8');
    assert.doesNotMatch(html, staleBrand, path);
    assert.ok(html.includes(`<title>${title} | LXR Empire</title>`), path);
    assert.ok(html.includes(`<link rel="icon" type="image/svg+xml" href="${mark}">`), path);
    assert.match(html, /<strong(?: dir="ltr")?>LXR Empire<\/strong>/, path);
    assert.ok(html.includes(`<img src="${mark}" width="44" height="44" alt="">`), path);
    if (path === '/') {
      assert.match(html, /aria-label="LXR Empire، سلّم الترقيات"/);
      assert.ok(html.includes(`<div class="mast-art" aria-hidden="true"><img src="${mark}" alt=""></div>`));
    }
  }
  const css = await served(request, '/styles.css', 'text/css; charset=utf-8');
  assert.doesNotMatch(css, staleBrand);
  assert.match(css, /\.mast-art img\s*\{/);
});

test('the LXR icon serves the approved JPEG bytes in an inert square SVG', async t => {
  const { request } = await fixture(t);
  const svg = await served(request, mark, 'image/svg+xml');
  assert.ok(Buffer.byteLength(svg) <= 256000, 'UTF-8 asset fits the text editor limit');
  // Full-document grammar: no alternate URLs, markup, event handlers or styles.
  const wrapper = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n  <image width="1024" height="1024" href="data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})"\/>\n<\/svg>\n(?![\s\S])/;
  const match = wrapper.exec(svg);
  assert.ok(match, 'expected one full-size embedded image/jpeg and no other SVG content');
  const jpeg = Buffer.from(match[1], 'base64');
  assert.equal(jpeg.toString('base64'), match[1], 'canonical unbroken base64');
  assert.equal(jpeg.length, 100432);
  assert.equal(jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.equal(createHash('sha256').update(jpeg).digest('hex'), '7d9c57e4d1ea37deca68d2d76d4202001ce9439917426d4179d4fccd571a057e');
});

test('dashboard scripts use LXR for the dynamic title, sign-in, staff and status', async t => {
  const { request } = await fixture(t);
  const [app, staff] = await Promise.all(['/app.js', '/staff.js'].map(path =>
    served(request, path, 'text/javascript; charset=utf-8')));
  assert.doesNotMatch(app, staleBrand);
  assert.match(app, /document\.title=title\+' \| LXR Empire'/);
  for (const text of ['دخول طاقم LXR', 'في سيرفر LXR', 'اتصال LXR Manager']) assert.ok(app.includes(text), text);
  assert.doesNotMatch(staff, staleBrand);
  for (const text of ['أوامر LXR', 'حُفظت إعدادات LXR.']) assert.ok(staff.includes(text), text);
});

test('protected dashboard describes commands with LXR without renaming shortcuts or Discord commands', async t => {
  const actor = '100000000000000001';
  const { store, request, origin } = await fixture(t, {
    status: () => ({ code:'online', text:'البوت متصل' }),
    dashboardAccess: async id => {
      if (id !== actor) throw new RuleError('دخول الطاقم يحتاج إلى رول مخوّل في BlueLand.', 403);
      return { id, name:'Test reader', rights:{config:false} };
    }
  });
  const get = (path, headers) => request(path, { headers });
  const post = (path, input, headers) => request(path, {
    method:'POST', headers:{ origin, 'content-type':'application/json', ...headers }, body:JSON.stringify(input)
  });
  assert.equal((await get('/api/command-guide')).status, 401);
  assert.equal((await get('/api/catalog')).status, 401);
  assert.equal((await post('/api/session', {code:'incorrect'}, {origin:'https://elsewhere.test'})).status, 403);
  assert.equal((await post('/api/session', {code:'incorrect'})).status, 401);
  const denied = await post('/api/session', {code:store.loginCode('100000000000000002')});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'دخول الطاقم يحتاج إلى رول مخوّل في LXR.');
  assert.equal(denied.headers.get('set-cookie'), null);
  const code = store.loginCode(actor);
  const login = await post('/api/session', {code});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^bl_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800$/);
  const headers = { cookie:cookie.split(';', 1)[0] };
  assert.equal((await post('/api/session', {code})).status, 401);
  assert.equal((await post('/api/command-shortcuts', {phrase:'example', command:'/ping'}, headers)).status, 403);
  store.shortcuts.add('BlueLand', '/ping', actor);
  const list = await (await get('/api/commands', headers)).json();
  assert.ok(list.some(c => c.name === 'ping' && c.description === 'افحص اتصال LXR Manager'));
  assert.ok(list.every(c => !staleBrand.test(c.description)));
  const { commands, canEdit } = await (await get('/api/command-guide', headers)).json();
  assert.equal(canEdit, false);
  const ping = commands.find(c => c.name === '/ping');
  assert.equal(ping.desc, 'افحص اتصال LXR Manager');
  assert.deepEqual(ping.custom, ['BlueLand']);
  assert.equal(commands.find(c => c.name === '/promote').options[0].description, 'العضو في سيرفر LXR');
  assert.ok(commands.every(c => !staleBrand.test(c.desc) && c.options.every(o => !staleBrand.test(o.description))));
  assert.equal(require('../src/commands').commands.find(c => c.name === 'ping').description, 'افحص اتصال BlueLand Manager');
  assert.equal((await post('/api/logout', {}, headers)).status, 200);
  assert.equal((await get('/api/command-guide', headers)).status, 401);
});

test('dashboard status rebrands the connection message without changing its state', async t => {
  const status = { code:'unavailable', text:'اتصال البوت بسيرفر BlueLand غير متاح' };
  const { request } = await fixture(t, {status:() => status});
  const res = await request('/api/status');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    connection:{code:'unavailable', text:'اتصال البوت بسيرفر LXR غير متاح'},
    viewer:null, needsLogin:true
  });
  assert.equal(status.text, 'اتصال البوت بسيرفر BlueLand غير متاح');
});
