'use strict';
function activity(reply, settings) {
  let post=null, commands=0, actions=0;
  const files=new Set();
  async function show(phase) {
    const text=[phase,files.size?'Edited '+files.size+' file'+(files.size===1?'':'s'):'',commands?'Ran '+commands+' command'+(commands===1?'':'s'):'',actions?'Discord actions: '+actions:''].filter(Boolean).join(' · ');
    try {
      if (!post) post=await reply(text);
      else if (post.edit) await post.edit({content:text,allowedMentions:{parse:[],repliedUser:false}});
    } catch {}
  }
  return {show,start:()=>show('Thinking… '+settings.model+' / '+settings.effort),
    file:name=>files.add(name),command:()=>{commands++;},action:()=>{actions++;},finish:()=>show('Finished')};
}
module.exports={activity};
