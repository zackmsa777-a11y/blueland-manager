'use strict';

const {ChannelType}=require('discord.js');
const {catalog}=require('./ladder');
const {topReply}=require('./activity-top');
const CHANNEL='1575140485884936274';
const COMMAND='توب يومي';
const ALLOWED_MENTIONS={parse:[],repliedUser:false};
const DAY=86_400_000, MINUTE=60_000;
const date=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',year:'numeric',month:'short',day:'numeric'});
const dayAt=ms=>Math.floor(ms/DAY);
const isDue=ms=>ms>=((dayAt(ms)+1)*DAY)-MINUTE;

function openDailyTopReceipts(db) {
  db.exec('CREATE TABLE IF NOT EXISTS daily_top_reports (day INTEGER PRIMARY KEY, command TEXT NOT NULL, reply TEXT)');
  const find=db.prepare('SELECT command,reply FROM daily_top_reports WHERE day=?');
  const saveCommand=db.prepare('INSERT OR IGNORE INTO daily_top_reports(day,command) VALUES(?,?)');
  const saveReply=db.prepare('UPDATE daily_top_reports SET reply=? WHERE day=? AND command=? AND reply IS NULL');
  return {
    dailyTopReceipt:day=>find.get(day),
    markDailyTopCommand:(day,id)=>saveCommand.run(day,id),
    markDailyTopReply:(day,parent,id)=>saveReply.run(id,day,parent),
  };
}

function createDailyTopReport({db,getChannel,botId,now=Date.now,beforeSnapshot=()=>{}}) {
  let pending=false;
  return async function tick() {
    const started=now(), day=dayAt(started);
    if (pending || !isDue(started) || !db.settings().levels || db.dailyTopReceipt(day)?.reply) return null;
    pending=true;
    try {
      const channel=await getChannel(CHANNEL);
      if (channel?.id!==CHANNEL || channel.guildId!==catalog.guildId || channel.type!==ChannelType.GuildText)
        throw new Error('Daily top channel is unavailable');
      const captured=now();
      const receipt=db.dailyTopReceipt(day);
      if (dayAt(captured)!==day || !isDue(captured) || !db.settings().levels || receipt?.reply) return null;
      beforeSnapshot();
      const payload=topReply(db,{period:'day',mode:'both',now:captured});
      const description=`Daily snapshot · ${date.format(captured)} (UTC)`;
      payload.embeds[0].description=description;
      const fetchMessage=id=>channel.messages.fetch({message:id,force:true,cache:false});
      let commandId=receipt?.command;
      if (!commandId) {
        const posted=await channel.send({content:COMMAND,allowedMentions:ALLOWED_MENTIONS,nonce:`bl-top-cmd-${day}`,enforceNonce:true});
        const read=await fetchMessage(posted.id);
        if (read?.id!==posted.id || read.author?.id!==botId || read.content!==COMMAND)
          throw new Error('Could not verify the daily top command');
        db.markDailyTopCommand(day,read.id);
        commandId=db.dailyTopReceipt(day).command;
      }
      // Reply explicitly; the interactive message handler ignores bot authors.
      const posted=await channel.send({...payload,allowedMentions:ALLOWED_MENTIONS,nonce:`bl-top-reply-${day}`,enforceNonce:true,
        reply:{messageReference:commandId,failIfNotExists:true}});
      const read=await fetchMessage(posted.id);
      if (read?.id!==posted.id || read.author?.id!==botId || read.reference?.messageId!==commandId || read.embeds?.[0]?.description!==description)
        throw new Error('Could not verify the daily top snapshot');
      db.markDailyTopReply(day,commandId,read.id);
      return read.id;
    } finally {pending=false;}
  };
}

module.exports={openDailyTopReceipts,createDailyTopReport};
