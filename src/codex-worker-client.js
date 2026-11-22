'use strict';
const net = require('node:net');
const {RuleError} = require('./ladder');

function exchange(input,path) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(path);
    socket.setEncoding('utf8');
    let output='';
    const timeout=setTimeout(()=>socket.destroy(new Error('timeout')),190000);
    socket.once('close',()=>clearTimeout(timeout));
    socket.once('connect',()=>socket.write(JSON.stringify(input)+'\n'));
    socket.on('data',data=>{
      output+=data;
      if (Buffer.byteLength(output)>(input.op==='release_patch'?550000:65000)) socket.destroy(new Error('too large'));
    });
    socket.once('error',()=>reject(new RuleError('انقطع الاتصال بخدمة Codex.',502)));
    socket.once('end',()=>{
      try {
        const result=JSON.parse(output);
        if (!result.ok) {
          if (result.reason==='temporary') throw new RuleError('تعذّر الحصول على رد من Codex بعد انقطاع مؤقت.',502);
          if (result.reason==='quota') throw new RuleError('أبلغ Codex أن حد استخدام الحساب وصل لنهايته.',429);
          if (result.reason==='auth') throw new RuleError('انتهى تسجيل دخول حساب Codex على السيرفر.',401);
          throw Error();
        }
        resolve(result.value);
      } catch (error) { reject(error instanceof RuleError?error:new RuleError('تعذّر إكمال طلب Codex. راجع حالة الخدمة.',503)); }
    });
  });
}
async function requestCodex(input,path=process.env.CODEX_SOCKET || '/run/blueland-codex.sock') {
  try {return await exchange(input,path);}
  catch (error) {
    // A model call only proposes actions. A workspace or publish call may already have applied them.
    if (input.operation!=='respond' || error.status!==502) throw error;
    return exchange(input,path);
  }
}
module.exports={requestCodex};
