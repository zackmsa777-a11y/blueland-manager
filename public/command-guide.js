'use strict';

const $=s=>document.querySelector(s);
const categories={all:'الكل',mod:'الإشراف',roles:'الرولات والطاقم',requests:'الطلبات والتذاكر',games:'الألعاب',general:'العامة'};
const make=(tag,text,cls)=>Object.assign(document.createElement(tag),{textContent:text??'',className:cls??''});
const key=value=>String(value??'').normalize('NFKC').replace(/[أإآ]/g,'ا').replace(/\p{M}/gu,'').toLowerCase();
const chip=value=>{const node=make('bdi',value,'cmd');node.dir=/^[+/]/.test(value)?'ltr':'auto';if(/^[+/]\p{Script=Arabic}/u.test(value)) {const word=make('bdi',value.slice(1));word.dir='rtl';node.replaceChildren(value[0],word);}return node;};
const addIcon=(target,name)=>{
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),ref=document.createElementNS(ns,'use');
  svg.setAttribute('class','guide-icon');svg.setAttribute('aria-hidden','true');ref.setAttribute('href','/assets/icons.svg#'+name);svg.append(ref);target.prepend(svg);
};
let rows=[], selected='/promote', category='all', canEdit=false;
const message=$('#guide-status');
async function api(path,body){
  const resp=await fetch(path,{cache:'no-store',credentials:'same-origin',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const data=await resp.json();
  if (!resp.ok)throw Object.assign(new Error(data.error||'تعذّر إتمام الطلب.'),{status:resp.status});
  return data;
}
function button(label,classes,onClick) {
  const el=make('button',label,classes);el.type='button';el.addEventListener('click',onClick);return el;
}
function section(title) {const box=make('section',null,'guide-section');box.append(make('h3',title));return box;}
function copyButton(value,status) {
  const b=button('','code-button',async()=>{
    try {await navigator.clipboard.writeText(value);status.textContent='تم نسخ الاختصار.';}
    catch{status.textContent='انسخ النص يدويًا: '+value;}
  });b.setAttribute('aria-label','نسخ '+value);b.append(chip(value));return b;
}
function showDetail(c){
  const panel=$('#guide-detail');panel.replaceChildren();panel.hidden=!c;if(!c)return;
  const box=make('div',null,'detail-main');
  const top=make('div',null,'detail-top');top.append(make('p','تفاصيل الأمر','guide-eyebrow'),chip(c.name));
  box.append(top,make('h2',c.desc),make('p',c.access,'guide-muted'));
  const status=make('p',null,'guide-message');status.setAttribute('role','status');
  if(c.note||c.example) {
    const guide=section('طريقة الاستخدام');if(c.note)guide.append(make('p',c.note,'guide-muted'));
    const examples=make('div',null,'short-list');if(c.example)examples.append(copyButton(c.example,status));if(c.related)examples.append(copyButton(c.related,status));
    if(examples.childElementCount)guide.append(examples);box.append(guide);
  }
  const aliases=section('الاختصارات');const pills=make('div',null,'short-list');
  for(const value of new Set([c.alias,...c.chat].filter(Boolean)))pills.append(copyButton(value,status));
  aliases.append(pills);
  const manager=make('div',null,'alias-editor');const bar=make('div',null,'editor-bar');bar.append(make('strong','اختصارات مخصّصة'));
  const list=make('ul',null,'alias-list');
  function refreshList(){list.replaceChildren(...c.custom.map(a=>{const li=make('li');li.append(copyButton(a,status),make('span','بدون بادئة','guide-muted'));return li;}));if(!list.children.length)list.append(make('li','لسه مفيش اختصارات مخصّصة.','guide-muted'));}
  manager.append(bar,list);
  if(canEdit){
    const form=make('form',null,'alias-form');form.hidden=true;
    const input=make('input');input.name='phrase';input.required=true;input.maxLength=40;input.dir='auto';input.autocomplete='off';input.placeholder='مثال: مرسيدس';input.setAttribute('aria-label','الكلمة أو العبارة الجديدة');
    const save=make('button','حفظ','action-primary');save.type='submit';form.append(input,save);
    const add=button('إضافة اختصار','new-alias',()=>{form.hidden=false;input.focus()});bar.append(add);
    manager.insertBefore(make('p','اكتب كلمة أو عبارة واضغط Enter. الاختصار لا يمنح صلاحيات جديدة.','guide-muted'),list);
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(save.disabled)return;save.disabled=true;status.textContent='جارٍ الحفظ…';
      try{
        const saved=await api('/api/command-shortcuts',{phrase:input.value,command:c.name});
        if(saved.command!==c.name||!saved.phrase)throw new Error('الرد على الحفظ غير صالح.');
        c.custom.push(saved.phrase);refreshList();input.value='';form.hidden=true;status.textContent='اتحفظ «'+saved.phrase+'».';add.focus();
      }catch(err){status.textContent=err.message;input.focus();}
      finally{save.disabled=false;}
    });
    manager.append(form);
  }
  refreshList();aliases.append(manager,status);box.append(aliases);
  const args=section('الخانات');
  for(const o of c.options){
    const row=make('div',null,'guide-argument');row.append(chip(o.name),make('span',o.required?'مطلوب':'اختياري','guide-muted'),make('p',o.description,'guide-muted'));
    if(o.choices?.length)row.append(make('p','القيم: '+o.choices.map(k=>`${k.name} (${k.value})`).join('، '),'guide-muted'));
    if(o.min!==undefined||o.max!==undefined)row.append(make('p',`القيمة: ${o.min??'—'} إلى ${o.max??'—'}`,'guide-muted'));
    else if(o.minLength!==undefined||o.maxLength!==undefined)row.append(make('p',`الطول: ${o.minLength??1} إلى ${o.maxLength??'—'} حرف`,'guide-muted'));
    args.append(row);
  }
  if(!c.options.length)args.append(make('p','الأمر ده ما بيحتاجش خانات.','guide-muted'));
  box.append(args);panel.append(box);
}
function draw(){
  const q=key($('#guide-search').value.trim());
  const matches=rows.filter(c=>(category==='all'||c.cat===category)&&(!q||[c.name,c.alias,c.desc,c.example,c.related,...c.chat,...c.custom].some(v=>key(v).includes(q))));
  if(q){
    const score=c=>[c.name,c.alias,...c.chat,...c.custom].some(v=>key(v)===q)?1:0;
    matches.sort((a,b)=>score(b)-score(a));
    if(matches.length&&score(matches[0])&&!matches.some(c=>c.name===selected&&score(c)))selected=matches[0].name;
  }
  if(!matches.some(c=>c.name===selected))selected=matches[0]?.name;
  $('#guide-count').textContent=`${matches.length} أمر`;
  const results=$('#guide-list');results.replaceChildren();
  if(!matches.length)results.append(make('p','مفيش أوامر مطابقة للبحث.','guide-empty'));
  for(const c of matches){
    const b=button('','cmd-row',()=>{selected=c.name;draw();[...results.children].find(el=>el.dataset.name===selected)?.focus({preventScroll:true})});
    b.dataset.name=c.name;b.setAttribute('aria-pressed',String(c.name===selected));
    const body=make('span',null,'row-body');body.append(chip(c.name),make('span',c.desc,'guide-muted'));b.append(body);results.append(b);
  }
  for(const b of $('#guide-categories').children)b.setAttribute('aria-pressed',String(b.dataset.category===category));
  showDetail(matches.find(c=>c.name===selected));
}
(async()=>{
  for(const el of document.querySelectorAll('[data-icon]'))addIcon(el,el.dataset.icon);
  const filters=$('#guide-categories');
  for(const [id,name] of Object.entries(categories)){
    const b=button(name,'chip',()=>{category=id;draw()});b.dataset.category=id;filters.append(b);
  }
  $('#guide-search').addEventListener('input',()=>{if($('#guide-search').value.trim())category='all';draw()});
  document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();$('#guide-search').focus()}});
  try{const data=await api('/api/command-guide');rows=data.commands;canEdit=data.canEdit;draw()}
  catch(err){message.textContent=err.message;if(err.status===401){message.append(' ');const link=make('a','دخول الإدارة');link.href='/';message.append(link)}}
})();
