'use strict';

const path=require('node:path');
const {Resvg}=require('@resvg/resvg-js');
const {catalog}=require('./ladder');

const DAY=86_400_000, MINUTE=60_000;
const W=1120,H=820;
const WHITE='#edf4ff', MUTED='#b4c2d7', DIM='#9ab0ca', CYAN='#6bdfff', PURPLE='#c2a4ff', BORDER='#263750', PANEL='#121e30';
const MAX_AVATAR=128*1024, MAX_DIMENSION=256;
const PNG=Buffer.from('89504e470d0a1a0a','hex');
const hash=value=>typeof value==='string' && /^(?:a_)?[a-f0-9]{32}$/u.test(value);
const validPng=image=>Buffer.isBuffer(image) && image.length>=33 && image.length<=MAX_AVATAR &&
  image.subarray(0,8).equals(PNG) && image.readUInt32BE(8)===13 && image.toString('ascii',12,16)==='IHDR' &&
  [image.readUInt32BE(16),image.readUInt32BE(20)].every(n=>n>0 && n<=MAX_DIMENSION);
const fmt=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const dayFormat=new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'2-digit',timeZone:'UTC'});
const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const font={loadSystemFonts:false,fontFiles:[path.join(__dirname,'game-assets','IBMPlexSansArabic-Bold.ttf')],
  defaultFontFamily:'IBM Plex Sans Arabic'};

async function loadF7sAvatar(profile,signal) {
  const {id,guildAvatar,userAvatar}=profile;
  if (typeof id!=='string' || !/^[1-9][0-9]{16,19}$/u.test(id) || BigInt(id)>0xffffffffffffffffn) return null;
  // IDs and hashes come from the exact guild-member GET, not from message text or arbitrary URLs.
  const key=hash(guildAvatar)?`guilds/${catalog.guildId}/users/${id}/avatars/${guildAvatar}`:
    hash(userAvatar)?`avatars/${id}/${userAvatar}`:null;
  if (!key) return null;
  let reader, complete=false;
  try {
    const response=await fetch(`https://cdn.discordapp.com/${key}.png?size=128`,{redirect:'error',signal});
    reader=response.body?.getReader();
    const len=response.headers.get('content-length');
    if (!response.ok || response.headers.get('content-type')?.split(';',1)[0]!=='image/png' ||
        (len!==null && (!/^[0-9]+$/u.test(len) || Number(len)>MAX_AVATAR)) || !reader) return null;
    const chunks=[];
    let length=0;
    while (true) {
      const {done,value}=await reader.read();
      if (done) {complete=true;break;}
      length+=value.byteLength;
      if (length>MAX_AVATAR) return null;
      if (value.byteLength) chunks.push(value);
    }
    const image=Buffer.concat(chunks,length);
    return validPng(image)?image:null;
  } catch { return null; }
  finally { if (reader && !complete) void reader.cancel().catch(()=>{}); }
}

const esc=text=>String(text).replace(/[&<>"']/gu,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[s]));
const svg=body=>`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">${body}</svg>`;
const text=(x,y,s,size,fill=WHITE,anchor='start')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const rtl=(x,y,s,size,fill=WHITE)=>text(x,y,`\u202B${s}\u202C`,size,fill,'end');
const line=(x1,y1,x2,y2,stroke=BORDER)=>`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${stroke}"/>`;
const rect=(x,y,w,h,r,fill=PANEL,stroke=BORDER)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const dot=(x,y,r,fill)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const number=n=>n===null?'—':fmt.format(n);
function duration(ms) {
  if (ms===null) return '—';
  const seconds=Math.floor(ms/1000), h=Math.floor(seconds/3600), m=Math.floor(seconds%3600/60), s=seconds%60;
  return `≈ ${h?`${fmt.format(h)}h ${m}m`:m?`${m}m${s?` ${s}s`:''}`:s?`${s}s`:'<1s'}`;
}
function memberHeading(value) {
  const clean=(value??'').slice(0,256).replace(/[\p{Cc}\p{Cs}\p{Bidi_Control}\uFFFE\uFFFF]/gu,' ').replace(/\s+/gu,' ').trim();
  const segments=[...graphemes.segment(clean)].map(g=>g.segment);
  const count=Math.min(segments.length,36), name=segments.slice(0,count).join('');
  const bbox=fragment=>new Resvg(svg(fragment),{font}).innerBBox();
  const width=name?bbox(text(0,110,name,34))?.width:0;
  if (width) {
    const size=Math.max(24,Math.min(34,Math.floor(438*34/width)));
    const rightToLeft=/^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(name);
    for (let n=count;n>0;n--) {
      const display=segments.slice(0,n).join('')+(n<segments.length?'…':'');
      const fragment=rightToLeft?rtl(977,110,display,size):text(977,110,display,size,WHITE,'end');
      if ((bbox(fragment)?.x??0)>=531) return fragment;
    }
  }
  return rtl(977,110,'عضو السيرفر',34);
}
function renderF7s(profile,activity,avatar) {
  let body=`<defs><linearGradient id="head" x2="0" y2="1"><stop stop-color="#141f34"/><stop offset="1" stop-color="#0b111c"/></linearGradient><clipPath id="avatar">${rect(1000,78,88,68,18,'white','none')}</clipPath></defs>`+
    rect(0,0,W,H,0,'#0b111c','none')+rect(0,0,W,167,0,'url(#head)','none')+line(32,166,1088,166);
  body+=text(32,44,'LXR EMPIRE  /  MEMBER INSIGHTS',19,CYAN)+rect(873,17,215,39,20,'#202d3f')+
    rtl(1069,43,'نشاط مسجّل · سجل جزئي',17,MUTED);
  body+=rect(1000,78,88,68,18,'#223e5d','#5680a6')+dot(1044,98,10,CYAN)+rect(1023,113,42,21,10,CYAN,'none');
  if (validPng(avatar)) body+=`<image x="1000" y="78" width="88" height="68" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)" xlink:href="data:image/png;base64,${avatar.toString('base64')}"/>`;
  body+=memberHeading(profile.name)+rtl(977,142,'بطاقة فحص العضو',19,MUTED);
  for (const [x,label,value] of [[32,'تاريخ إنشاء الحساب',profile.created],[279,'تاريخ دخول السيرفر',profile.joined]])
    body+=rect(x,78,226,68,13)+rtl(x+210,102,label,17,MUTED)+text(x+16,132,value,23);
  const rank=n=>n===null?'—':`#${fmt.format(n)}`;
  const windows=['اليوم','آخر 7 أيام','آخر 14 يوم'];
  for (const [x,label,color,labels,values] of [
    [32,'الترتيب خلال 14 يوم',WHITE,['الرسائل','الفويس'],[rank(activity.messageRank),rank(activity.voiceRank)]],
    [392,'نشاط الفويس',PURPLE,windows,activity.windows.map(d=>duration(d.voiceMs))],
    [752,'الرسائل',CYAN,windows,activity.windows.map(d=>number(d.messages))]
  ]) {
    body+=rect(x,187,336,224,20)+rect(x+20,210,6,24,3,color,'none')+rtl(x+315,230,label,25);
    for (const [i,value] of values.entries()) {
      const y=286+i*51;
      body+=line(x+20,y-38,x+316,y-38)+rtl(x+315,y-2,labels[i],19,MUTED)+text(x+21,y,value,value.length>12?18:27,color);
    }
    if (x===32) body+=rtl(x+315,382,'المقارنة حسب السجل فقط',17,MUTED);
  }
  body+=rect(32,434,1056,322,20)+rtl(1064,478,'النشاط اليومي لآخر 14 يوم',28);
  const x=i=>95+i*800/13;
  for (const [top,label,units,color,series] of [
    [510,'الرسائل','عدد الرسائل',CYAN,activity.days.map(d=>d.messages)],
    [620,'الفويس','بالدقائق',PURPLE,activity.days.map(d=>d.voiceMs===null?null:d.voiceMs/MINUTE)]
  ]) {
    const max=Math.max(2,...series), unit=10**Math.floor(Math.log10(max/2));
    const ceiling=Math.ceil(max/(2*unit))*2*unit, y=n=>top+72-72*n/ceiling;
    for (const value of [0,ceiling/2,ceiling]) body+=line(x(0),y(value),x(13),y(value))+text(79,y(value)+5,fmt.format(value),14,DIM,'end');
    body+=rtl(1062,top+31,label,21,color)+rtl(1062,top+56,units,17,MUTED);
    for (const [i,n] of series.entries()) {
      if (n===null) continue;
      if (i>0 && series[i-1]!==null) body+=`<path d="M${x(i-1)} ${y(series[i-1])}L${x(i)} ${y(n)}" stroke="${color}" stroke-width="2.5"/>`;
      body+=dot(x(i),y(n),3.5,color);
    }
  }
  for (const [i,day] of activity.days.entries()) body+=text(x(i),732,dayFormat.format(day.day*DAY),13,MUTED,'middle');
  body+=text(32,794,'UTC  /  +f7s',18,CYAN)+rtl(1088,783,'الفترات جزئية وقد ينقصها نشاط · الفويس تقديري',17,MUTED)+
    rtl(1088,806,'الفراغ أو الشرطة: لا بيانات مسجّلة أو لا ترتيب للرصيد الصفري',16,MUTED);
  return new Resvg(svg(body),{font}).render().asPng();
}

module.exports={loadF7sAvatar,renderF7s};
