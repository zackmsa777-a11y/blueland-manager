'use strict';

const { catalog, roles, ladder, compareRoles } = require('./ladder');
const kinds = { rank:'درجة ترقية', permission:'صلاحية مرتبطة', variant:'رول فئة بديل', symbol:'رمز فئة',
  other:'رول مستقل', bot:'رول بوت', divider:'فاصل', integration:'رول تكامل', everyone:'رول افتراضي' };

function ladderIssue(live) {
  let previous;
  for (const step of ladder) {
    const role = live.get(step.id);
    if (!role || role.managed || (previous && compareRoles(role,previous) >= 0)) {
      return 'تغيّر سلّم الرتب في ديسكورد. طابق الترتيب مع الإعدادات قبل الترقية.';
    }
    previous = role;
  }
  const ids=new Set(catalog.categories.flatMap(g=>[...g.ranks,g.variant,...g.helpers]));
  const expected=catalog.roles.filter(r=>ids.has(r.id));
  for (const [index,saved] of expected.entries()) {
    const current=live.get(saved.id);
    if (!current || current.managed || (BigInt(current.permissions) & ~BigInt(saved.permissions)) ||
       (index && compareRoles(live.get(expected[index-1].id),current)>=0)) {
      return 'تغيّر سلّم الرتب أو إحدى صلاحياته. طابق المعرّفات وترتيب الفئات قبل الترقية.';
    }
  }
  return '';
}

function liveDirectory(raw, capturedAt = new Date().toISOString(), highestId) {
  const ordered = [...raw].sort(compareRoles);
  const live = new Map(ordered.map(r=>[r.id,r]));
  const groups = catalog.categories.map(group => ({
    name:group.name, top:live.get(group.ranks.at(-1)), base:live.get(group.base)
  }));
  const result = ordered.map((r,index) => {
    const saved = roles.get(r.id);
    const range = groups.find(g=>g.top && g.base && compareRoles(g.top,r)<=0 && compareRoles(r,g.base)<=0);
    const kind = saved?.kind || (r.managed ? (r.tags?.bot_id ? 'bot':'integration') : 'other');
    const label = kind === 'rank' ? r.name.replace(/^[-❛❝\s]+|[-:\s]+$/gu,'').trim() : r.name;
    return { id:r.id, name:r.name, label, color:r.color ? '#'+Number(r.color).toString(16).padStart(6,'0') : null,
      position:r.position, order:index+1, managed:r.managed, permissions:String(r.permissions),
      category:saved?.category || null, section:saved?.section || range?.name || 'رولات إضافية', kind };
  });
  const policyIds = new Set(catalog.categories.flatMap(g=>[...g.ranks,g.variant,...g.helpers]));
  const highest=live.get(highestId) || ordered.find(r=>r.tags?.bot_id===catalog.botId);
  const aboveBot=highest ? ladder.filter(step=>live.has(step.id) && compareRoles(highest,live.get(step.id))>=0).map(step=>step.id) : [];
  return { ...catalog, roles:result, source:'discord', capturedAt, warning:ladderIssue(live),
    aboveBot,
    missingPolicyRoles:catalog.roles.filter(r=>policyIds.has(r.id) && !live.has(r.id)) };
}

function exportCsv(directory) {
  const ids = new Map([...directory.roles,...(directory.missingPolicyRoles || [])].map(r=>[r.id,r]));
  const headers = ['ترتيب ديسكورد من الأعلى','اسم الرول','Discord ID','الفئة','النوع','درجة داخل الفئة','رولات الصلاحيات التراكمية عند الترقية'];
  const rows = directory.roles.map(r=>{
    const group = directory.categories.find(c=>c.id===r.category);
    let grants = [];
    if (group && (r.kind==='rank' || r.kind==='variant')) {
      grants = directory.categories.slice(0,directory.categories.indexOf(group)+1).flatMap(c=>c.helpers);
    }
    return [r.order,r.name,"'"+r.id,r.section,kinds[r.kind],r.kind==='rank' ? group.ranks.indexOf(r.id)+1 : '',
      grants.map(id=>ids.get(id)?.name || id).join(', ')];
  });
  function cell(x) {
    const s=String(x);
    const safe=/^[=+\-@\t\r]/.test(s) ? "'"+s : s;
    return '"'+safe.replaceAll('"','""')+'"';
  }
  return '\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}

module.exports = { ladderIssue, liveDirectory, exportCsv };
