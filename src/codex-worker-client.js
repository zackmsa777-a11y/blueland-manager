'use strict';
const net = require('node:net');
const {RuleError} = require('./ladder');

function requestCodex(input,path=process.env.CODEX_SOCKET || '/run/blueland-codex.sock') {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(path);
    socket.setEncoding('utf8');
    let output='';
    const timeout=setTimeout(()=>socket.destroy(new Error('timeout')),190000);
    socket.once('close',()=>clearTimeout(timeout));
    socket.once('connect',()=>socket.write(JSON.stringify(input)+'\n'));
    socket.on('data',data=>{
      output+=data;
      if (Buffer.byteLength(output)>65000) socket.destroy(new Error('too large'));
    });
    socket.once('error',()=>reject(new RuleError('تعذّر الاتصال بخدمة Codex. جرّب بعد قليل.',503)));
    socket.once('end',()=>{
      try {
        const result=JSON.parse(output);
        if (!result.ok) throw Error();
        resolve(result.value);
      } catch { reject(new RuleError('تعذّر إكمال طلب Codex. راجع تسجيل الدخول أو حد الاستخدام.',503)); }
    });
  });
}
module.exports={requestCodex};
