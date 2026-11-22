'use strict';
const {Worker,isMainThread,workerData,parentPort}=require('node:worker_threads');
const {RuleError}=require('./ladder');

// Generated handlers receive JSON and return JSON. No host functions are imported into QuickJS.
async function interpret({source,input,validate}) {
  const {getQuickJS}=require('quickjs-emscripten');
  const engine=await getQuickJS();
  const rt=engine.newRuntime();
  rt.setMemoryLimit(6*1024*1024);
  rt.setMaxStackSize(256*1024);
  const deadline=Date.now()+120;
  rt.setInterruptHandler(()=>Date.now()>deadline);
  const vm=rt.newContext();
  try {
    const expression=validate?'typeof fn === "function"':'JSON.stringify(fn('+JSON.stringify(input)+'))';
    const result=vm.evalCode('"use strict"; const fn=(\n'+source+'\n); '+expression,'command.js',{type:'global'});
    if (result.error) {result.error.dispose();throw Error('Invalid handler');}
    try {
      if (validate) {
        if (!vm.dump(result.value)) throw Error('Expected a function');
        return true;
      }
      if (vm.typeof(result.value)!=='string') throw Error('Expected a result');
      const json=vm.getString(result.value);
      if (json.length>32000) throw Error('Result is too large');
      const value=JSON.parse(json);
      if (!value || typeof value.answer!=='string' || !Array.isArray(value.actions)) throw Error('Invalid return value');
      return value;
    } finally { result.value.dispose(); }
  } finally {vm.dispose();rt.dispose();}
}
function runFeature(source,input={},validate=false) {
  if (typeof source!=='string'||source.length>6000) throw new RuleError('كود الأمر طويل أو غير صالح.');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(__filename,{workerData:{source,input,validate},resourceLimits:{maxOldGenerationSizeMb:48}});
    const fail=()=>reject(new RuleError('تعذّر تشغيل كود الأمر. اطلب من Codex تصحيحه.'));
    const timer=setTimeout(()=>{void worker.terminate();fail();},3000);
    worker.once('message',m=>{clearTimeout(timer);if (m.ok) resolve(m.value);else fail();});
    worker.once('error',()=>{clearTimeout(timer);fail();});
    worker.once('exit',code=>{clearTimeout(timer);if(code) fail();});
  });
}
if (!isMainThread) interpret(workerData).then(value=>parentPort.postMessage({ok:true,value}),()=>parentPort.postMessage({ok:false}));
module.exports={runFeature};
