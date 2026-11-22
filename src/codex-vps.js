'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {RuleError}=require('./ladder');
const invoke=promisify(execFile);
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
module.exports={status,restartUnit,restart};
