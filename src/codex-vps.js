'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {RuleError}=require('./ladder');
const invoke=promisify(execFile);
const fs=require('node:fs/promises');
const units={bot:'blueland.service',dashboard:'blueland-cloudflared.service',codex:'blueland-codex.socket'};

async function status(onCommand=()=>{}) {
  const readings=await Promise.all(Object.entries(units).map(async ([name,unit])=>{
    const {stdout}=await invoke('/usr/bin/systemctl',['show','--property=ActiveState','--value',unit],{timeout:5000});
    onCommand();
    return name+' · '+stdout.trim();
  }));
  return readings.join('\n');
}
function restartUnit(target) {
  if (!['bot','dashboard'].includes(target)) throw new RuleError('اختر bot أو dashboard لإعادة التشغيل.');
  return units[target];
}
async function restart(target) {
  await invoke('/usr/bin/systemctl',['--no-ask-password','--no-block','restart',restartUnit(target)],{timeout:5000});
}
async function deploy() {
  await invoke('/usr/bin/systemctl',['--no-ask-password','--no-block','start','blueland-release.service'],{timeout:5000});
}
async function release() {
  const state=JSON.parse(await fs.readFile('/var/lib/blueland-releases/status.json','utf8'));
  const phases={checking:'يفحص GitHub',testing:'يشغّل الاختبارات',activating:'يربط الإصدار ويتحقق من اتصال Discord',
    live:'الإصدار شغّال',current:'آخر إصدار شغّال بالفعل',failed:'تعذّر النشر',rolled_back:'عاد إلى الإصدار السابق',rollback_failed:'تحتاج الخدمة إلى تدخل مسؤول VPS'};
  return [phases[state.phase]||'الحالة غير معروفة','الإصدار الشغّال: '+(state.active||'—'),
    'الإصدار المطلوب: '+(state.target||'—'),state.updated].filter(Boolean).join('\n');
}
module.exports={status,restartUnit,restart,deploy,release};
