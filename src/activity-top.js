'use strict';

const path=require('node:path');
const {EmbedBuilder}=require('discord.js');
const {Resvg}=require('@resvg/resvg-js');
const {catalog}=require('./ladder');
const DAY=86_400_000, MINUTE=60_000, MAX_VOICE_GAP=90_000;
const periods=Object.freeze({all:'All time',day:'Daily',week:'Weekly',month:'Monthly'});
const modes=Object.freeze({both:'Text and Voice',text:'Text only',voice:'Voice only'});
const aliases=new Map([
  ['يومي','day'],['أسبوعي','week'],['اسبوعي','week'],['شهري','month'],['عام','all'],
  ['كتابي','text'],['فويس','voice'],['صوتي','voice'],
  ['all','all'],['day','day'],['week','week'],['month','month'],['text','text'],['voice','voice']
]);

function parseTop(text) {
  const [command,...args]=text.trim().toLowerCase().replace(/^\+\s+/u,'+').split(/\s+/u);
  if (!['توب','+توب','+top'].includes(command) || args.length>2) return null;
  let period,mode;
  for (const arg of args) {
    const value=aliases.get(arg);
    if (Object.hasOwn(periods,value) && !period) period=value;
    else if (Object.hasOwn(modes,value) && !mode) mode=value;
    else return null;
  }
  return {action:'top',period:period??'all',mode:mode??'both'};
}
const dayOf=ms=>Math.floor(ms/DAY);
function periodBounds(now,period) {
  const today=dayOf(now), utc=new Date(today*DAY);
  if (period==='day') return [today,today+1];
  if (period==='week') {
    const monday=today-((utc.getUTCDay()+6)%7);
    return [monday,monday+7];
  }
  if (period==='month') {
    const year=utc.getUTCFullYear(), month=utc.getUTCMonth();
    return [dayOf(Date.UTC(year,month,1)),dayOf(Date.UTC(year,month+1,1))];
  }
  return [0,null];
}
function createActivityStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS activity_daily (
    member TEXT NOT NULL, day INTEGER NOT NULL, messages INTEGER NOT NULL DEFAULT 0,
    text_xp INTEGER NOT NULL DEFAULT 0, voice_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,member)
  )`);
  const upsert=db.prepare(`INSERT INTO activity_daily(day,member,messages,text_xp,voice_ms) VALUES(?,?,?,?,?)
    ON CONFLICT(day,member) DO UPDATE SET messages=messages+excluded.messages,text_xp=text_xp+excluded.text_xp,voice_ms=voice_ms+excluded.voice_ms`);
  const award=db.prepare(`INSERT INTO server_xp VALUES(?,10,?) ON CONFLICT(member) DO UPDATE SET xp=xp+10,last=excluded.last WHERE excluded.last-last>=${MINUTE}`);
  const allText=db.prepare(`WITH totals AS (SELECT member,SUM(messages) AS count FROM activity_daily WHERE day<=? AND messages>0 GROUP BY member),
    people AS (SELECT member FROM totals UNION SELECT member FROM server_xp)
    SELECT people.member,COALESCE(s.xp,0) AS xp,COALESCE(t.count,0) AS count FROM people
      LEFT JOIN server_xp s USING(member) LEFT JOIN totals t USING(member) ORDER BY xp DESC,count DESC,people.member LIMIT ?`);
  const windowText=db.prepare(`SELECT member,SUM(text_xp) AS xp,SUM(messages) AS count FROM activity_daily
    WHERE day BETWEEN ? AND ? AND messages>0 GROUP BY member ORDER BY xp DESC,count DESC,member LIMIT ?`);
  const voiceRows=db.prepare(`SELECT member,SUM(voice_ms) AS ms FROM activity_daily
    WHERE day BETWEEN ? AND ? AND voice_ms>0 GROUP BY member ORDER BY ms DESC,member LIMIT ?`);
  const graph=db.prepare('SELECT day,SUM(messages) AS count FROM activity_daily WHERE day BETWEEN ? AND ? GROUP BY day');
  const memberWindow=db.prepare(`WITH totals AS (
    SELECT member,SUM(messages) AS messages,SUM(voice_ms) AS voice FROM activity_daily
    WHERE day BETWEEN ? AND ? GROUP BY member
  ), ranks AS (
    SELECT CASE WHEN MAX(target.messages)>0 THEN 1+COUNT(CASE WHEN other.messages>target.messages THEN 1 END) END AS messageRank,
           CASE WHEN MAX(target.voice)>0 THEN 1+COUNT(CASE WHEN other.voice>target.voice THEN 1 END) END AS voiceRank
    FROM totals AS target CROSS JOIN totals AS other WHERE target.member=?
  )
  SELECT daily.day,daily.messages,daily.voice_ms,ranks.messageRank,ranks.voiceRank
    FROM ranks LEFT JOIN activity_daily AS daily ON daily.member=? AND daily.day BETWEEN ? AND ? ORDER BY daily.day`);
  function transaction(work) {
    db.exec('BEGIN');
    try {work();db.exec('COMMIT');} catch(err) {db.exec('ROLLBACK');throw err;}
  }
  function addXp(member,now,eligible=true) {
    if (!Number.isSafeInteger(now)||now<0) return;
    transaction(()=>{
      const xp=eligible && award.run(member,now).changes ? 10 : 0;
      upsert.run(dayOf(now),member,1,xp,0);
    });
  }
  function addVoice(member,from,to) {
    if (!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from) return;
    transaction(()=>{
      for(let start=from;start<to;) {
        const day=dayOf(start),end=Math.min(to,(day+1)*DAY);
        upsert.run(day,member,0,0,end-start);
        start=end;
      }
    });
  }
  function activityTop({period='all',mode='both',now=Date.now()}={}) {
    const [start,reset]=periodBounds(now,period), today=dayOf(now), size=mode==='both'?5:10;
    const history=mode==='both'?new Map(graph.all(today-6,today).map(r=>[r.day,r.count])):null;
    const text=mode==='voice'?[]:period==='all'?allText.all(today,size):windowText.all(start,today,size);
    return {reset,
      text:text.map(r=>({...r})),
      voice:mode==='text'?[]:voiceRows.all(start,today,size).map(r=>({...r})),
      chart:history?Array.from({length:7},(_,i)=>({day:today-6+i,count:history.get(today-6+i)??0})):[]};
  }
  function memberActivity(member,now) {
    const today=dayOf(now), start=today-13;
    const rows=memberWindow.all(start,today,member,member,start,today);
    const byDay=new Map(rows.map(row=>[row.day,row]));
    const days=Array.from({length:14},(_,i)=>{
      const day=start+i, row=byDay.get(day);
      // A row records a message count, but voice_ms defaults to zero even when no voice was observed.
      return {day,messages:row?.messages??null,voiceMs:row?.voice_ms>0?row.voice_ms:null};
    });
    const sum=(days,key)=>days.some(d=>d[key]!==null)?days.reduce((total,d)=>total+(d[key]??0),0):null;
    const windows=[1,7,14].map(length=>{
      const slice=days.slice(-length);
      return {length,messages:sum(slice,'messages'),voiceMs:sum(slice,'voiceMs')};
    });
    const [{messageRank,voiceRank}]=rows;
    return {days,windows,messageRank,voiceRank};
  }
  return {addXp,addVoice,activityTop,memberActivity};
}
function createVoiceActivity(db,now=Date.now) {
  const observed=new Map();
  const eligible=state=>state.channelId && state.channelId!==state.guild.afkChannelId && state.member?.user?.bot===false;
  function reconcile(id,present,time) {
    const last=observed.get(id);
    if (last!==undefined && time>last && time-last<=MAX_VOICE_GAP) db.addVoice(id,last,time);
    if (present) observed.set(id,time);
    else observed.delete(id);
  }
  function reset(){observed.clear();}
  function update(state) {
    if (state.guild.id!==catalog.guildId) return;
    if (!db.settings().levels) return reset();
    reconcile(state.id,eligible(state),now());
  }
  function checkpoint(guild) {
    if (guild.id!==catalog.guildId) return;
    if (!db.settings().levels) return reset();
    const time=now(), present=new Set();
    for (const state of guild.voiceStates.cache.values()) {
      if (!eligible(state)) continue;
      present.add(state.id);
      reconcile(state.id,true,time);
    }
    // A missing state with no leave event has no reliable end time; don't credit the gap.
    for (const id of observed.keys()) if (!present.has(id)) observed.delete(id);
  }
  return {checkpoint,update,reset};
}
const date=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
const number=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const fontFile=path.join(__dirname,'game-assets','IBMPlexSansArabic-Bold.ttf');
let chartCache;
function chartPng(days) {
  const key=JSON.stringify(days);
  if (chartCache?.key===key) return chartCache.image;
  const max=Math.max(4,...days.map(d=>d.count));
  const unit=10**Math.floor(Math.log10(max/4));
  const step=Math.ceil(max/(4*unit))*unit, top=step*4;
  const x=i=>76+104*i, y=n=>246-156*n/top;
  const points=days.map((item,i)=>`${x(i)},${y(item.count)}`).join(' ');
  const grid=Array.from({length:5},(_,i)=>`<path d="M76 ${y(i*step)}H700" stroke="#292833"/><text x="66" y="${y(i*step)+4}" text-anchor="end">${number.format(i*step)}</text>`).join('');
  const labels=days.map((item,i)=>`<text x="${x(i)}" y="270" text-anchor="middle">${date.format(item.day*DAY)}</text>`).join('');
  const dots=days.map((item,i)=>`<circle cx="${x(i)}" cy="${y(item.count)}" r="4" fill="#e6c780" stroke="#fff8e4"/>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="740" height="294"><rect width="740" height="294" rx="12" fill="#111116"/><g fill="#b8b5be" font-family="IBM Plex Sans Arabic" font-size="13"><text x="370" y="38" text-anchor="middle" font-size="22" fill="#e6c780">Messages Activity · Last 7 Days</text>${grid}<polygon points="76,246 ${points} 700,246" fill="#302a21"/><polyline points="${points}" fill="none" stroke="#e6c780" stroke-width="3" stroke-linejoin="round"/>${dots}${labels}</g></svg>`;
  const image=new Resvg(svg,{font:{loadSystemFonts:false,fontFiles:[fontFile],defaultFontFamily:'IBM Plex Sans Arabic'}}).render().asPng();
  chartCache={key,image};
  return image;
}
function topReply(db,{period,mode,now}) {
  period=Object.hasOwn(periods,period)?period:'all';
  mode=Object.hasOwn(modes,mode)?mode:'both';
  const data=db.activityTop({period,mode,now}), count=mode==='both'?5:10;
  const makeRow=(r,i,points,metric)=>`#${i+1} | <@${r.member}> XP: \`${number.format(points)}\` ${metric}`;
  const embed=new EmbedBuilder().setColor(0xe4c57e).setTitle('Guild Score Leaderboards')
    .setDescription(periods[period]+(data.reset===null?'':' · Resets <t:'+data.reset*86_400+':R>'))
    .setTimestamp(now);
  if(mode!=='voice') embed.addFields({name:`💬 TOP ${count} TEXT`,value:data.text.map((r,i)=>makeRow(r,i,r.xp,`(count: ${number.format(r.count)})`)).join('\n')||'No data available.'});
  if(mode!=='text') embed.addFields({name:`🎙️ TOP ${count} VOICE`,value:data.voice.map((r,i)=>makeRow(r,i,Math.floor(r.ms/MINUTE),`(hours: ${number.format(r.ms/(MINUTE*60))})`)).join('\n')||'No data available.'});
  if(period==='all') embed.setFooter({text:'Message counts and voice time are recorded since tracking began.'});
  if(mode!=='both') return {embeds:[embed.toJSON()]};
  embed.setImage('attachment://activity.png');
  return {embeds:[embed.toJSON()],files:[{attachment:chartPng(data.chart),name:'activity.png'}]};
}

module.exports={periods,modes,parseTop,createActivityStore,createVoiceActivity,topReply};
