'use strict';

const deskLabels={requests:'الطلبات',tickets:'التذاكر',cases:'سجل الإشراف',settings:'الإعدادات',commands:'دليل الأوامر'};
const deskStates={pending:'قيد المراجعة',processing:'جارٍ تنفيذ القرار',approved:'مقبول',rejected:'مرفوض',cancelled:'مسحوب',opening:'جارٍ الفتح',open:'مفتوحة',closing:'جارٍ الإغلاق',closed:'مغلقة',reopening:'جارٍ إعادة الفتح'};
const deskKinds={promotion:'طلب ترقية',application:'تقديم الطاقم',general:'طلب عام'};
let deskTab='';
let deskLoad=0;

async function renderStaff() {
  const load=++deskLoad;
  content.innerHTML='<p class="loading" role="status">جارٍ تحميل مكتب الطاقم…</p>';
  try {
    const [commands,desk]=await Promise.all([api('/api/commands'),state.status.viewer?api('/api/staff'):null]);
    if (load!==deskLoad || state.view!=='staff') return;
    const rights=desk?.rights || {};
    const tabs=[];
    if (rights.review) tabs.push('requests');
    if (rights.tickets) tabs.push('tickets');
    if (rights.cases) tabs.push('cases');
    if (rights.config) tabs.push('settings');
    tabs.push('commands');
    if (!tabs.includes(deskTab)) deskTab=tabs[0];
    const counters={requests:desk?.requests.filter(r=>r.state==='pending').length,tickets:desk?.tickets.filter(r=>r.state==='open').length};
    content.innerHTML=(!desk?'<div class="desk-signin"><p>سجّل دخولك لمراجعة طلبات الأعضاء وتذاكرهم.</p><button id="desk-login" class="button quiet">دخول الإدارة</button></div>':'')+
      '<div class="desk-panel"><nav class="desk-tabs" aria-label="أقسام مكتب الطاقم">'+tabs.map(k=>'<button type="button" data-desk="'+k+'" aria-pressed="'+(k===deskTab)+'">'+deskLabels[k]+(counters[k]?' <span class="count">'+number(counters[k])+'</span>':'')+'</button>').join('')+
      '</nav><div class="desk-body" id="desk-body"></div></div>';
    if ($('#desk-login')) $('#desk-login').onclick=login;
    function select(tab) {
      deskTab=tab;
      for (const b of content.querySelectorAll('[data-desk]')) b.setAttribute('aria-pressed',String(b.dataset.desk===tab));
      const panel=$('#desk-body');
      if (tab==='commands') return deskCommands(panel,commands);
      if (tab==='settings') return deskSettings(panel,desk);
      deskRecords(panel,tab,desk[tab]);
    }
    for (const b of content.querySelectorAll('[data-desk]')) b.onclick=()=>select(b.dataset.desk);
    select(deskTab);
  } catch(err) { if (load===deskLoad && state.view==='staff') failInline(content,err); }
}
function deskCommands(panel,commands) {
  panel.innerHTML='<div class="desk-head"><h2>أوامر BlueLand</h2><label class="search" for="command-search">'+icon('search')+
    '<span class="sr-only">ابحث عن أمر</span><input id="command-search" type="search" placeholder="ابحث عن أمر" autocomplete="off"></label></div><div id="command-list" class="command-list"></div>';
  const input=$('#command-search'), list=$('#command-list');
  function fill() {
    const query=input.value.trim().toLowerCase().replace(/^\//,'');
    const rows=commands.filter(c=>(c.name+' '+c.description+' '+c.subcommands.join(' ')).toLowerCase().includes(query));
    list.innerHTML=rows.map(c=>'<div class="command-row"><bdi dir="ltr">/'+escapeHtml(c.name)+'</bdi><div>'+escapeHtml(c.description)+
      (c.subcommands.length?'<p class="note" dir="ltr">'+c.subcommands.map(escapeHtml).join(' · ')+'</p>':'')+'</div></div>').join('') ||
      '<p class="empty" role="status">ما فيه أوامر تطابق البحث.</p>';
  }
  input.oninput=fill; fill();
}
function deskRecords(panel,tab,items) {
  const empty={requests:'تظهر هنا طلبات الترقية والتقديم التي يرسلها الأعضاء من /request submit.',tickets:'تظهر التذاكر الخاصة بعد فتحها من /ticket create.',cases:'تظهر هنا التحذيرات وإجراءات الإشراف التي ينفّذها الطاقم.'};
  panel.innerHTML='<div class="desk-head"><h2>'+deskLabels[tab]+'</h2><button id="refresh-desk" class="button quiet" type="button">تحديث</button></div>'+
    (items.length?'<div id="desk-records"></div>':'<div class="empty"><p>'+empty[tab]+'</p></div>');
  $('#refresh-desk').onclick=renderStaff;
  if (!items.length) return;
  const list=$('#desk-records');
  const date=new Intl.DateTimeFormat('ar-SA',{calendar:'gregory',dateStyle:'short',timeStyle:'short',timeZone:'Asia/Riyadh'});
  for (const row of items) {
    const piece=document.createElement('article'); piece.className='desk-record';
    const title=tab==='requests'?deskKinds[row.kind]:tab==='tickets'?row.subject:row.action;
    const status=tab==='cases'?(row.revoked?'مسحوب':'مسجّل'):deskStates[row.state];
    const details=tab==='requests'?row.body:tab==='tickets'?(row.assignee?'المستلم '+row.assignee:'بانتظار الاستلام'):row.reason;
    piece.innerHTML='<div><h3>'+bdi(title)+' <small>#'+number(row.id)+'</small></h3><p>'+escapeHtml(details)+'</p><small>'+
      bdi(row.owner || row.target)+' · '+escapeHtml(date.format(row.created))+'</small></div><div class="desk-actions"><span>'+escapeHtml(status)+'</span></div>';
    list.append(piece);
    const actions=piece.querySelector('.desk-actions');
    function button(label,fn) { const b=document.createElement('button');b.type='button';b.className='button quiet';b.textContent=label;b.onclick=fn;actions.append(b); }
    if (tab==='requests' && row.state==='pending') button('مراجعة',()=>reviewRequest(row));
    if (tab==='tickets' && row.channel) {
      const a=document.createElement('a');a.className='button quiet';a.textContent='فتح الروم';a.href='https://discord.com/channels/'+state.catalog.guildId+'/'+row.channel;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);
      if (row.state==='open' && !row.assignee) button('استلام',()=>ticketDecision(row,'claim','استلام التذكرة'));
      if (row.state==='open' && row.assignee===state.status.viewer.id) button('ترك الاستلام',()=>ticketDecision(row,'unclaim','إعادة التذكرة للطاقم'));
      if (['open','closed'].includes(row.state)) button(row.state==='open'?'إغلاق':'إعادة فتح',()=>row.state==='open'?ticketDecision(row,'close','إغلاق التذكرة'):ticketDecision(row,'reopen','إعادة فتح التذكرة'));
    }
  }
}
function reviewRequest(row) {
  changeDialog('مراجعة الطلب #'+number(row.id),'<p>'+bdi(deskKinds[row.kind])+' · '+bdi(row.owner)+'</p><p class="request-text">'+escapeHtml(row.body)+'</p>'+
    (row.kind==='general'?'':'<p class="note">القبول ينفّذ ترقية واحدة بعد التحقق من رتبة العضو وصلاحياتك.</p>')+
    '<form id="review-form" novalidate><label class="field" for="review-note">سبب القرار (مطلوب للرفض)</label><textarea id="review-note" maxlength="350" rows="3"></textarea>'+
    '<div class="dialog-actions"><button class="button primary" name="decision" value="approve" type="submit">قبول الطلب</button><button class="button quiet" name="decision" value="reject" type="submit">رفض الطلب</button></div></form>');
  $('#review-form').onsubmit=async e=>{
    e.preventDefault();
    const button=e.submitter;
    if (!button) return;
    const reason=$('#review-note');
    reason.setCustomValidity('');
    if (button.value==='reject' && !reason.value.trim()) {reason.setCustomValidity('اكتب سبب رفض الطلب.');reason.reportValidity();reason.oninput=()=>reason.setCustomValidity('');return;}
    if (!e.currentTarget.reportValidity()) return;
    await deskSave(e.currentTarget,()=>api('/api/staff/request',{id:row.id,decision:button.value,reason:reason.value}));
  };
}
function ticketDecision(row,action,title) {
  changeDialog(title,'<p>'+bdi(row.subject)+' · #'+number(row.id)+'</p><div class="dialog-actions"><button class="button primary" id="ticket-confirm" type="button">'+escapeHtml(title)+'</button></div>');
  $('#ticket-confirm').onclick=()=>deskSave($('#dialog-body'),()=>api('/api/staff/ticket',{id:row.id,action}));
}
async function deskSave(container,send) {
  const buttons=[...container.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try { await send();dialog.close();await renderStaff();toast('تم حفظ التغيير.'); }
  catch(err) {const el=$('#dialog-notice');if (el) el.textContent=err.message;}
  finally {buttons.forEach(b=>b.disabled=false);}
}
function deskSettings(panel,desk) {
  const s=desk.settings;
  function field(id,label,items,current,empty) {
    const available=items.some(x=>x.id===current);
    const options=items.map(x=>'<option value="'+escapeHtml(x.id)+'"'+(x.id===current?' selected':'')+'>'+escapeHtml(x.name)+'</option>').join('');
    const missing=current && !available?'<option selected value="'+escapeHtml(current)+'">عنصر مفقود · '+escapeHtml(current)+'</option>':'';
    return '<div class="field"><label for="'+id+'">'+label+'</label><select id="'+id+'" name="'+id+'"><option value="">'+empty+'</option>'+missing+options+'</select></div>';
  }
  const roles=state.catalog.roles.filter(r=>!r.managed && r.kind!=='everyone' && r.kind!=='divider');
  panel.innerHTML='<div class="desk-head"><h2>إعدادات السيرفر</h2></div><form id="desk-settings"><fieldset><legend>قنوات الدعم والترحيب</legend>'+
    field('ticketCategory','فئة التذاكر',desk.channels.filter(c=>c.category),s.ticketCategory,'خارج الفئات')+
    field('supportRole','رول فريق التذاكر',roles,s.supportRole,'العضو وإدارة السيرفر فقط')+
    field('welcomeChannel','قناة الترحيب',desk.channels.filter(c=>!c.category),s.welcomeChannel,'الترحيب متوقف')+'</fieldset>'+
    '<fieldset><legend>نشاط الأعضاء</legend><label class="variant" for="count-xp"><input type="checkbox" id="count-xp"'+(s.levels?' checked':'')+'> احتساب نقاط الرسائل</label><p class="note">١٠ نقاط كل دقيقة نشطة. كل ١٠٠ نقطة ترفع مستوى واحدًا.</p></fieldset>'+
    '<button class="button primary" type="submit">حفظ الإعدادات</button><p role="status" id="settings-status" class="note"></p></form>';
  $('#desk-settings').onsubmit=async e=>{
    e.preventDefault(); const form=e.currentTarget,submit=form.querySelector('button');
    submit.disabled=true;
    try { desk.settings=await api('/api/staff/settings',{ticketCategory:form.elements.ticketCategory.value,supportRole:form.elements.supportRole.value,
      welcomeChannel:form.elements.welcomeChannel.value,levels:$('#count-xp').checked});$('#settings-status').textContent='حُفظت إعدادات BlueLand.'; }
    catch(err) {$('#settings-status').textContent=err.message;}
    finally {submit.disabled=false;}
  };
}
