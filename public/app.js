'use strict';

const $ = selector => document.querySelector(selector);
const nf = new Intl.NumberFormat('ar-SA');
const number = value => nf.format(value);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bdi = value => `<bdi dir="auto">${escapeHtml(value)}</bdi>`;
const icon = name => `<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#${name}"></use></svg>`;
const dialog = $('#dialog');
const content = $('#content');
const state = { catalog:null, roles:new Map(), grades:[], group:'new-staff', filter:'', query:'', kind:'all',
  page:0, view:'ladder', status:null, simulationIndex:0, simMode:'demo', simRole:null, variant:false, real:null };
const types = { rank:'درجة ترقية', permission:'صلاحية مرتبطة', variant:'رول فئة بديل', symbol:'رمز فئة',
  other:'رول مستقل', bot:'رول بوت', integration:'رول تكامل', divider:'فاصل', everyone:'رول افتراضي' };
const groupIcons = {'new-staff':'flag',mod:'shield',owners:'gem',admins:'shield-check',ship:'anchor',ownership:'crown'};
let toastTimer;

function toast(message) {
  clearTimeout(toastTimer);
  const live = dialog.open ? $('#dialog-notice') : $('#toast');
  if (!live) return;
  live.textContent = message;
  toastTimer = setTimeout(() => { live.textContent = ''; }, 3200);
}
async function api(route, input) {
  const options = input === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input) };
  const response = await fetch(route, { ...options, cache:'no-store', credentials:'same-origin' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذّر إتمام الطلب.');
  return data;
}
function bindIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.outerHTML = icon(el.dataset.icon);
}
function swatch(role) {
  const color = /^#[0-9a-f]{6}$/i.test(role?.color) ? role.color : '#899bad';
  return `<svg aria-hidden="true" class="swatch" viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="${color}"></circle></svg>`;
}
const nameOf = id => state.roles.get(state.catalog?.roleAliases?.[id] || id)?.label || 'خارج السلّم';
const groupOf = id => state.catalog.categories.find(g => g.id === id);
function permissions(group) {
  const groups = state.catalog.categories;
  return groups.slice(0,groups.indexOf(group)+1).flatMap(item => item.helpers);
}
function chips(ids, inherited = false) {
  return ids.map(id => `<span class="chip${inherited ? ' inherited' : ''}">${bdi(nameOf(id))}</span>`).join('');
}
function changeDialog(title, html) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html + '<p id="dialog-notice" role="status" class="note"></p>';
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function failInline(el, err) {
  el.innerHTML = `<p class="inline-error" role="alert">${escapeHtml(err.message || err)}</p>`;
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast('تم النسخ.'); }
  catch { changeDialog('نسخ النص', `<label class="field">حدّد النص لنسخه<input id="copy-fallback" dir="auto" readonly value="${escapeHtml(value)}"></label>`); $('#copy-fallback').select(); }
}
function section(title, side) {
  return `<div class="section-head"><h2>${escapeHtml(title)}</h2><span class="counter">${side}</span></div>`;
}
function openConnection() {
  const connection = state.status?.connection;
  changeDialog('اتصال BlueLand Manager', `<p>${escapeHtml(connection?.text || 'حالة الاتصال غير متاحة')}</p>
    ${connection?.code === 'online' ? '<p>أوامر السلاش المسجّلة في BlueLand: '+number(connection.slashReady || 0)+' من '+number(connection.slashTotal || 0)+'.</p><p>استخدم <bdi>/dashboard</bdi> لطلب رمز دخول خاص.'+(connection.contentEnabled===false?' أوامر + تحتاج تفعيل Message Content Intent.':'')+'</p>' :
    `<ol class="steps"><li>ضع توكن تطبيق <bdi>BlueLand Manager</bdi> في <code>DISCORD_BOT_TOKEN</code> داخل ملف <code>.env</code> بالمشروع.</li>
    <li>فعّل <bdi>Message Content Intent</bdi> في إعدادات التطبيق، وتأكد أن رول البوت يعلو درجات الترقية ولديه <bdi>Manage Roles</bdi>.</li>
    <li>احفظ الملف. تلتقط اللوحة التوكن تلقائيًا أثناء التشغيل. لبدء المشروع من جديد شغّل <code>npm start</code>.</li></ol>`}`);
}
async function refreshStatus() {
  const status = await api('/api/status');
  state.status = status;
  $('#connection-label').textContent = status.connection.code === 'offline' ? 'البوت غير متصل' : status.connection.text;
  $('#connection').dataset.state = status.connection.code;
  $('#connection').dataset.short = status.connection.code==='online' ? 'متصل' : status.connection.code==='connecting' ? 'يتصل' : 'غير متصل';
  $('#account-button').innerHTML = status.viewer ? icon('user-round') + bdi(status.viewer.name) : icon('log-in') + '<span>دخول الإدارة</span>';
  return status;
}
function login() {
  if (state.status?.viewer) {
    changeDialog('حساب الإدارة', `<p>مسجّل الدخول باسم ${bdi(state.status.viewer.name)}.</p><div class="dialog-actions"><button id="logout" class="button quiet">تسجيل الخروج</button></div>`);
    $('#logout').onclick = async () => {
      try { await api('/api/logout',{}); dialog.close(); await boot(); }
      catch (err) { toast(err.message); }
    };
    return;
  }
  const online = state.status?.connection.code === 'online';
  changeDialog('دخول الإدارة', `<p>اكتب <bdi dir="ltr">+لوحة</bdi> في سيرفر BlueLand. يرسل لك البوت في الخاص رمزًا صالحًا لخمس دقائق.</p>
    ${online ? `<form id="login-form"><label class="field">رمز الدخول<input name="code" dir="ltr" autocomplete="one-time-code" required maxlength="24"></label>
    <button class="button primary">دخول اللوحة</button></form>` :
    `<p class="note">البوت غير متصل حاليًا. فعّل الربط لطلب رمز الدخول.</p><div class="dialog-actions"><button id="setup" class="button quiet">إعداد اتصال البوت</button></div>`}`);
  if (!online) { $('#setup').onclick = openConnection; return; }
  $('#login-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button');
    submit.disabled = true;
    try { await api('/api/session',{code:form.elements.code.value.trim()}); deskTab=''; dialog.close(); await boot(); }
    catch (err) { $('#dialog-notice').textContent = err.message; }
    finally { submit.disabled = false; }
  };
}
function renderLadder() {
  const groups = state.catalog.categories;
  content.innerHTML = section('سلّم الترقيات', number(groups.length) + ' فئات / ' + number(state.grades.length) + ' درجة') +
    (state.catalog.warning ? '<p class="inline-error">'+escapeHtml(state.catalog.warning)+'</p>' : '') +
    (!state.catalog.warning && state.catalog.aboveBot?.length ? '<p class="hierarchy-note">'+icon('shield')+'<span>رول البوت أدنى من '+bdi(nameOf(state.catalog.aboveBot[0]))+'. لتفعيل أعلى '+number(state.catalog.aboveBot.length)+' درجات، ارفعه فوق '+bdi(nameOf(state.catalog.aboveBot.at(-1)))+'.</span></p>' : '') +
    `<div class="board"><aside class="rail" aria-label="فئات الطاقم"><h3>فئات الطاقم</h3><div class="category-list">
    ${groups.map(g => `<button class="category" data-group="${g.id}" aria-pressed="${g.id===state.group}">${icon(groupIcons[g.id])}<bdi class="latin">${escapeHtml(g.name)}</bdi><span class="count">${number(g.ranks.length)}</span></button>`).join('')}
    </div></aside><section class="grade-pane" aria-label="درجات الفئة" id="grade-pane"></section></div>`;
  renderGradePane();
}
function chooseGroup(key) {
  state.group = key;
  state.filter = '';
  for (const el of document.querySelectorAll('[data-group]')) el.setAttribute('aria-pressed', String(el.dataset.group===key));
  renderGradePane();
}
function renderGradePane() {
  const g = groupOf(state.group);
  const older = permissions(g).filter(id => !g.helpers.includes(id));
  $('#grade-pane').innerHTML = `<div class="pane-head"><div class="group-name">${swatch(state.roles.get(g.base))}<h3 dir="ltr">${escapeHtml(g.name)}</h3></div>
    <label class="search">${icon('search')}<span class="sr-only">بحث في الفئة</span><input id="grade-search" type="search" placeholder="بحث في الفئة" value="${escapeHtml(state.filter)}"></label></div>
    <div class="permission-band">${icon('key-round')}<span class="chip-label">صلاحيات الفئة</span>${chips(g.helpers)}${chips(older,true)}${older.length ? '<span>تشمل الصلاحيات الموروثة</span>' : ''}</div>
    <div class="table-wrap" tabindex="0" role="region" aria-label="درجات ${escapeHtml(g.name)}"><table class="grade-table"><caption class="sr-only">درجات ${escapeHtml(g.name)} من الأدنى إلى الأعلى</caption>
    <thead><tr><th scope="col">الدرجة</th><th scope="col">الرول</th><th scope="col">الترقية التالية</th><th scope="col"><span class="sr-only">التفاصيل</span></th></tr></thead><tbody id="grade-rows"></tbody></table></div>`;
  renderGradeRows();
  $('#grade-search').oninput = e => { state.filter = e.target.value; renderGradeRows(); };
}
function roleButton(role, fullName = false) {
  return `<button class="role-button" data-role="${role.id}">${swatch(role)}${bdi(fullName ? role.name : role.label)}</button>`;
}
function matches(role, term) {
  const query = term.trim().toLowerCase();
  return !query || role.name.toLowerCase().includes(query) || role.id.includes(query) || role.section.toLowerCase().includes(query);
}
function renderGradeRows() {
  const g = groupOf(state.group);
  const rows = g.ranks.map((id,idx) => {
    const r = state.roles.get(id);
    if (!matches(r,state.filter)) return '';
    const next = state.roles.get(state.grades[state.grades.indexOf(id)+1]);
    return `<tr><td class="index">${number(idx+1)}</td><th scope="row">${roleButton(r)}</th><td>
    <span class="next-name">${next ? bdi(next.label) : 'نهاية السلّم'}</span>${next && next.category!==g.id ? '<span class="transition-label">فئة جديدة</span>' : ''}</td>
    <td class="detail-cell"><button class="icon-button" data-role="${id}" aria-label="تفاصيل ${escapeHtml(r.label)}">${icon('chevron-left')}</button></td></tr>`;
  }).join('');
  $('#grade-rows').innerHTML = rows || '<tr><td colspan="4" class="empty">ما فيه رول يطابق البحث في هذه الفئة.</td></tr>';
}
function roleDetail(id) {
  const r = state.roles.get(id);
  const g = groupOf(r.category);
  const index = state.grades.indexOf(id);
  const next = state.roles.get(state.grades[index+1]);
  const linked = g && r.kind === 'permission' ? state.roles.get(g.base) : null;
  changeDialog(r.label, `<dl class="facts"><div><dt>الاسم في ديسكورد</dt><dd>${swatch(r)}${bdi(r.name)}</dd></div>
    <div><dt>معرّف الرول</dt><dd>${bdi(r.id)}<button class="icon-button" data-copy="${r.id}" aria-label="نسخ المعرّف">${icon('copy')}</button></dd></div>
    <div><dt>الفئة</dt><dd>${bdi(r.section)}</dd></div><div><dt>النوع</dt><dd>${types[r.kind]}</dd></div>
    ${linked ? `<div><dt>يبدأ من</dt><dd>${bdi(linked.label)} ويستمر مع الفئات الأعلى.</dd></div>` : ''}
    ${index>=0 ? `<div><dt>الترقية التالية</dt><dd>${next ? bdi(next.label) : 'آخر درجة في السلّم'}</dd></div>
    <div><dt>الصلاحيات</dt><dd>${chips(permissions(g))}</dd></div>` : ''}</dl>
    ${index>=0 ? '<div class="dialog-actions"><button class="button primary" id="try-grade">معاينة ترقية هذه الدرجة</button></div>' : ''}`);
  if ($('#try-grade')) $('#try-grade').onclick = () => openSimulator(id);
}
function renderDirectory() {
  const time = new Intl.DateTimeFormat('ar-SA',{ dateStyle:'short', timeStyle:'short', timeZone:'Asia/Riyadh', calendar:'gregory' }).format(new Date(state.catalog.capturedAt));
  content.innerHTML = section('جميع الرولات', number(state.catalog.roles.length) + ' رول') +
    (state.catalog.warning ? '<p class="inline-error">'+escapeHtml(state.catalog.warning)+'</p>' : '') +
    `<div class="panel"><div class="tools"><label class="search">${icon('search')}<span class="sr-only">ابحث باسم الرول أو معرّفه</span>
    <input type="search" id="directory-search" value="${escapeHtml(state.query)}" placeholder="ابحث باسم الرول أو معرّفه"></label>
    <select id="kind" aria-label="نوع الرول"><option value="all">كل الأنواع</option>${Object.entries(types).map(([k,v]) => `<option value="${k}" ${state.kind===k?'selected':''}>${v}</option>`).join('')}</select>
    <a class="button quiet download" href="/api/export" download>${icon('download')}تنزيل القائمة</a></div>
    <div class="table-wrap" role="region" aria-label="قائمة رولات السيرفر" tabindex="0"><table class="directory-table"><caption class="sr-only">الرولات بترتيب ديسكورد من الأعلى</caption>
    <thead><tr><th scope="col">الترتيب</th><th scope="col">الرول</th><th scope="col">الفئة</th><th scope="col">النوع</th></tr></thead><tbody id="directory-rows"></tbody></table></div><div class="pagination" id="pages"></div></div>
    <p class="directory-source">آخر قراءة من ديسكورد ${bdi(time)} بتوقيت الرياض.
    ${state.status.connection.code==='online' ? '<button class="button quiet" id="sync-roles">تحديث الرولات</button>' : ''}</p>`;
  $('#directory-search').oninput = e => { state.query=e.target.value; state.page=0; renderDirectoryRows(); };
  $('#kind').onchange = e => { state.kind=e.target.value; state.page=0; renderDirectoryRows(); };
  renderDirectoryRows();
  if ($('#sync-roles')) $('#sync-roles').onclick=async e=>{
    const button=e.currentTarget;
    button.disabled=true;
    try { await loadCatalog(); if(state.view==='directory') renderDirectory(); }
    catch(err) { toast(err.message); }
    finally { button.disabled=false; }
  };
}
function renderDirectoryRows() {
  const list = state.catalog.roles.filter(r => (state.kind==='all' || r.kind===state.kind) && matches(r,state.query));
  const size = 25, pages = Math.max(1, Math.ceil(list.length/size));
  state.page = Math.max(0,Math.min(state.page,pages-1));
  $('#directory-rows').innerHTML = list.slice(state.page*size,(state.page+1)*size).map(r =>
    `<tr><td>${number(r.order)}</td><th scope="row">${roleButton(r,true)}</th><td>${bdi(r.section)}</td><td>${types[r.kind]}</td></tr>`).join('') ||
    '<tr><td colspan="4" class="empty">ما فيه رولات تطابق البحث.</td></tr>';
  $('#pages').innerHTML = `<span>${number(list.length)} نتيجة، الصفحة ${number(state.page+1)} من ${number(pages)}</span>
    <button class="page-button" id="prev" ${state.page===0?'disabled':''}>السابق</button><button class="page-button" id="next" ${state.page+1===pages?'disabled':''}>التالي</button>`;
  $('#prev').onclick = () => { state.page--; renderDirectoryRows(); $('#next')?.focus(); };
  $('#next').onclick = () => { state.page++; renderDirectoryRows(); ($('#next').disabled ? $('#prev') : $('#next')).focus(); };
}
async function renderHistory() {
  content.innerHTML = section('العمليات الأخيرة','آخر ١٠٠ عملية') + '<div class="panel" id="history-panel"></div>';
  const panel = $('#history-panel');
  if (!state.status.viewer) {
    panel.innerHTML = `<div class="empty"><h3>سجل الطاقم</h3><p>سجّل الدخول بحساب مسؤول لعرض العضو والمنفّذ والرتب التي تغيّرت في كل عملية.</p><button id="history-login" class="button quiet">${icon('log-in')}دخول الإدارة</button></div>`;
    $('#history-login').onclick = login;
    return;
  }
  panel.innerHTML = '<p class="loading">جارٍ تحميل السجل…</p>';
  try {
    const records = await api('/api/history');
    if (!panel.isConnected) return;
    if (!records.length) { panel.innerHTML='<div class="empty"><h3>ما فيه ترقيات مسجّلة حتى الآن</h3><p>تظهر هنا أول ترقية ينفّذها البوت من الشات أو اللوحة.</p></div>'; return; }
    const time = new Intl.DateTimeFormat('ar-SA',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Riyadh',calendar:'gregory'});
    panel.innerHTML=`<div class="table-wrap" tabindex="0" role="region" aria-label="سجل العمليات"><table class="audit-table"><caption class="sr-only">سجل الترقيات بتوقيت الرياض</caption>
      <thead><tr>${['العضو','من / إلى','المسؤول','الوقت (الرياض)','الحالة'].map(label=>'<th scope="col">'+label+'</th>').join('')}</tr></thead><tbody>
      ${records.map(r=>`<tr><th scope="row">${bdi(r.targetName)}</th><td>${bdi(nameOf(r.plan.from))} ← ${bdi(nameOf(r.plan.to))}</td><td>${bdi(r.actorName)}</td>
      <td>${escapeHtml(time.format(r.finished || r.created))}</td><td><span class="audit-state ${r.state==='done'?'':'pending'}">${r.state==='done'?'مكتملة':'قيد الاستكمال'}</span>${r.detail ? '<p class="note">'+escapeHtml(r.detail)+'</p>' : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
  } catch (err) { failInline(panel,err); }
}
function resultFlow(plan) {
  return `<div class="flow"><div><small>الدرجة الحالية</small>${bdi(nameOf(plan.from))}</div>${icon('arrow-left')}<div class="to"><small>الدرجة التالية</small>${bdi(nameOf(plan.to))}</div></div>`;
}
function simResult(plan) {
  const addedHelpers = plan.helpers.filter(id=>plan.add.includes(id));
  const retained = plan.helpers.filter(id=>!plan.add.includes(id));
  return resultFlow(plan)+`<dl class="facts"><div><dt>رول الفئة</dt><dd>${bdi(nameOf(plan.anchor))}</dd></div>
    <div><dt>صلاحيات تُضاف</dt><dd>${addedHelpers.length ? chips(addedHelpers) : 'لا توجد صلاحية جديدة في هذه الدرجة'}</dd></div>
    ${retained.length ? `<div><dt>صلاحيات يحتفظ بها</dt><dd>${chips(retained,true)}</dd></div>` : ''}
    ${plan.remove.length ? `<div><dt>رولات تُستبدل</dt><dd>${plan.remove.map(id=>bdi(nameOf(id))).join('، ')}</dd></div>` : ''}</dl>`;
}
function openSimulator(id) {
  if (!state.catalog) { login(); return; }
  state.simMode='demo';
  state.simRole=id===undefined ? groupOf(state.group).ranks.at(-1) : id;
  state.variant=false; state.real=null;
  renderSimulator();
}
function renderSimulator() {
  state.simulationIndex++;
  const live = state.simMode==='real';
  changeDialog('معاينة ترقية', `<div class="segmented"><button id="demo-mode" aria-pressed="${!live}">تجربة على السلّم</button><button id="real-mode" aria-pressed="${live}">عضو من السيرفر</button></div><div id="sim-controls"></div><div id="sim-result"></div>`);
  $('#sim-result').setAttribute('aria-live','polite');
  $('#sim-result').setAttribute('aria-atomic','true');
  $('#demo-mode').onclick=()=>{ state.simMode='demo'; renderSimulator(); $('#demo-mode').focus(); };
  $('#real-mode').onclick=()=>{ state.simMode='real'; state.real=null; renderSimulator(); $('#real-mode').focus(); };
  if (live) { renderLiveControls(); return; }
  const r=state.roles.get(state.simRole);
  const g=r ? groupOf(r.category) : null;
  $('#sim-controls').innerHTML=`<p class="helper-text">جرّب الانتقال بين الدرجات. المعاينة لا تغيّر رولات أي عضو.</p>
    <div class="fields"><label class="field">الفئة الحالية<select id="sim-group"><option value="">خارج السلّم</option>${state.catalog.categories.map(item=>`<option value="${item.id}" ${g===item?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
    <label class="field">الدرجة الحالية<select id="sim-grade" ${g?'':'disabled'}>${g ? g.ranks.map(rank=>`<option value="${rank}" ${rank===state.simRole?'selected':''}>${escapeHtml(nameOf(rank))}</option>`).join('') : '<option>بدون رتبة</option>'}</select></label></div>
    ${g ? `<label class="variant"><input id="sim-variant" type="checkbox" ${state.variant?'checked':''}>العضو يحمل رول الفئة البديل <bdi dir="ltr">(Girls)</bdi></label>` : ''}`;
  $('#sim-group').onchange=e=>{ state.simRole=groupOf(e.target.value)?.base || null; state.variant=!!state.simRole && state.variant; renderSimulator(); $('#sim-group').focus(); };
  $('#sim-grade').onchange=e=>{ state.simRole=e.target.value; updateSimulation(); };
  if ($('#sim-variant')) $('#sim-variant').onchange=e=>{ state.variant=e.target.checked; updateSimulation(); };
  updateSimulation();
}
async function updateSimulation() {
  const current = ++state.simulationIndex;
  const el = $('#sim-result');
  el.setAttribute('aria-busy','true');
  try {
    const query = new URLSearchParams({from:state.simRole || '',variant:state.variant?'girls':'standard'});
    const plan = await api('/api/simulate?'+query);
    if (current===state.simulationIndex && el.isConnected) el.innerHTML=simResult(plan);
  } catch (err) { if (current===state.simulationIndex && el.isConnected) failInline(el,err); }
  finally { el.removeAttribute('aria-busy'); }
}
function renderLiveControls() {
  const controls=$('#sim-controls'), result=$('#sim-result');
  if (!state.status.viewer) {
    controls.innerHTML='<p>ترقية عضو فعلي تتطلب دخول مسؤول مخوّل من السيرفر.</p><div class="dialog-actions"><button id="live-login" class="button quiet">دخول الإدارة</button></div>';
    $('#live-login').onclick=login;
    return;
  }
  controls.innerHTML=`<form id="member-form"><label class="field">معرّف العضو أو المنشن<input id="target-id" dir="ltr" autocomplete="off" required maxlength="24" placeholder="@member / ID"></label><button class="button quiet">عرض الترقية</button></form>`;
  $('#target-id').oninput=()=>{ state.real=null; state.simulationIndex++; result.replaceChildren(); };
  $('#member-form').onsubmit=async event=>{
    event.preventDefault();
    const current=++state.simulationIndex;
    const target=$('#target-id').value.trim();
    const submit=event.currentTarget.querySelector('button');
    submit.disabled=true;
    try {
      const data=await api('/api/member-preview',{target});
      if (current!==state.simulationIndex || !result.isConnected) return;
      state.real=data;
      result.innerHTML=`<p>العضو ${bdi(data.member)}</p>${simResult(data.plan)}<div class="dialog-actions"><button id="commit" class="button primary">تأكيد ترقية العضو</button></div>`;
      $('#commit').onclick=async e=>{
        e.currentTarget.disabled=true;
        try {
          const entry=await api('/api/promote',{requestId:data.requestId,target:data.target,expectedFrom:data.plan.from});
          result.innerHTML=`<p role="status">تمت ترقية ${bdi(entry.targetName)} إلى ${bdi(nameOf(entry.plan.to))}.</p>`;
        } catch (err) { failInline(result,err); }
      };
    } catch (err) { if (current===state.simulationIndex) failInline(result,err); }
    finally { submit.disabled=false; }
  };
}
function renderView() {
  const hash=location.hash.slice(1);
  state.view=['ladder','directory','history','staff'].includes(hash) ? hash : 'ladder';
  const headings = {
    ladder:['إدارة الترقيات','درجات الطاقم وصلاحيات كل فئة في سيرفر BlueLand Empire.'],
    directory:['رولات السيرفر','ابحث بالاسم أو المعرّف لعرض فئة الرول ومكانه في ترتيب ديسكورد.'],
    history:['سجل الترقيات','تابع ترقية كل عضو، ومن نفّذها، والدرجة التي انتقل إليها.'],
    staff:['مكتب الطاقم','طلبات الأعضاء وتذاكر الدعم وسجل الإشراف في BlueLand.']
  };
  const [title,intro]=headings[state.view];
  document.title=title+' | BlueLand Empire';
  $('#heading').textContent=title;
  $('#intro').textContent=intro;
  $('.mast-actions').hidden=state.view!=='ladder';
  $('.masthead').classList.toggle('compact',state.view!=='ladder');
  for (const el of document.querySelectorAll('[data-view]')) {
    if (el.dataset.view===state.view) el.setAttribute('aria-current','page');
    else el.removeAttribute('aria-current');
  }
  if (!state.catalog) return;
  if (state.view==='ladder') renderLadder();
  if (state.view==='directory') renderDirectory();
  if (state.view==='history') renderHistory();
  if (state.view==='staff') renderStaff();
}
async function loadCatalog() {
  state.catalog=await api('/api/catalog');
  const entries=[...(state.catalog.missingPolicyRoles || []),...state.catalog.roles];
  state.roles=new Map(entries.map(r=>[r.id,r]));
  state.grades=state.catalog.categories.flatMap(g=>g.ranks);
}
async function boot() {
  try {
    const status=await refreshStatus();
    if (status.needsLogin) {
      state.catalog=null; state.roles.clear(); state.grades=[];
      content.innerHTML='<div class="empty"><h2>دخول طاقم BlueLand</h2><p>أدخل رمز +لوحة لعرض دليل الرولات والترقيات.</p><button class="button primary" id="gated-login">دخول الإدارة</button></div>';
      $('#gated-login').onclick=login;
      return;
    }
    await loadCatalog();
    renderView();
  } catch (err) { failInline(content,err); }
  finally { content.setAttribute('aria-busy','false'); }
}
document.addEventListener('click',event=>{
  const el=event.target.closest('button');
  if (!el) return;
  if (el.dataset.group) chooseGroup(el.dataset.group);
  if (el.dataset.role) roleDetail(el.dataset.role);
  if (el.dataset.copy) copy(el.dataset.copy);
});
$('#open-simulator').onclick=()=>openSimulator();
$('#copy-command').onclick=()=>copy('+ترقية @العضو');
$('#account-button').onclick=login;
$('#connection').onclick=openConnection;
$('#close-dialog').onclick=()=>dialog.close();
dialog.addEventListener('close',()=>{ state.simulationIndex++; });
window.addEventListener('hashchange',renderView);
window.addEventListener('focus',()=>{ if(state.status) refreshStatus().then(s=>{ if(s.needsLogin && state.catalog) boot(); }).catch(()=>{}); });
setInterval(()=>{
  if (!document.hidden && state.status && !state.status.viewer && state.status.connection.code!=='online') refreshStatus().catch(()=>{});
},15000);
bindIcons();
boot();
