'use strict';

const {createHash}=require('node:crypto');
const {Routes}=require('discord.js');
const {autoReply:{image}}=require('../config/discord-features.json');

function createDashImageLoader(fetchImage=fetch) {
  let cached;
  return function load(client) {
    if (!cached) cached=(async()=>{
      const {channelId,messageId,authorId,attachmentId,name,size,sha256}=image;
      const message=await client.rest.get(Routes.channelMessage(channelId,messageId));
      const asset=message?.id===messageId && message.author?.id===authorId && message.attachments?.find(a=>a.id===attachmentId);
      if (!asset || asset.filename!==name || asset.size!==size) throw new Error('LXR divider attachment unavailable');
      const url=new URL(asset.url);
      if (url.origin!=='https://cdn.discordapp.com' || url.username || url.password ||
          url.pathname!==`/attachments/${channelId}/${attachmentId}/${name}`) throw new Error('LXR divider URL invalid');
      const response=await fetchImage(url.href,{redirect:'error',signal:AbortSignal.timeout(10_000)});
      if (!response.ok || !response.body) throw new Error('LXR divider download failed');
      const attachment=Buffer.alloc(size);
      let offset=0;
      for await (const chunk of response.body) {
        if (chunk.length>size-offset) throw new Error('LXR divider size invalid');
        attachment.set(chunk,offset);
        offset+=chunk.length;
      }
      if (offset!==size || createHash('sha256').update(attachment).digest('hex')!==sha256) throw new Error('LXR divider integrity check failed');
      return {attachment,name};
    })().catch(err=>{cached=undefined;throw err;});
    return cached;
  };
}

module.exports={createDashImageLoader};
