'use strict';
const Pool=(()=>{
const W=960,H=480,R=11,STOP=9;
const pockets=[[1,1],[W/2,-5],[W-1,1],[1,H-1],[W/2,H+5],[W-1,H-1]];
const group=n=>n>8?2:n>0&&n<8?1:0;
const ball=(n,x,y)=>({n,x,y,vx:0,vy:0,out:false});
const rack=()=>{const order=[1,9,2,10,8,3,11,4,12,5,6,13,7,14,15];const balls=[ball(0,234,H/2)];let i=0;for(let row=0;row<5;row++)for(let j=0;j<=row;j++)balls.push(ball(order[i++],672+row*(Math.sqrt(3)*R+.34),H/2+(j-row/2)*(2*R+.32)));return balls;};
class Game{
 constructor(){this.balls=rack();this.groups=[0,0];this.stats=Array.from({length:2},()=>({potted:0,best:0,shots:0,fouls:0,run:0}));this.turn=0;this.breaking=true;this.shot=null;this.inHand=false;this.call=-1;this.winner=null;this.note='Break from the head spot.';}
 get cue(){return this.balls[0];}
 remaining(g){return this.balls.filter(b=>!b.out&&group(b.n)===g).length;}
 get onEight(){const g=this.groups[this.turn];return !!g&&this.remaining(g)===0;}
 place(x,y){if(!this.inHand||!Number.isFinite(x)||!Number.isFinite(y)||x<2*R||x>W-2*R||y<2*R||y>H-2*R||pockets.some(p=>Math.hypot(x-p[0],y-p[1])<36)||this.balls.some(b=>b.n&&!b.out&&Math.hypot(b.x-x,b.y-y)<2*R+.5))return false;Object.assign(this.cue,{x,y,out:false,vx:0,vy:0});this.inHand=false;this.note='Cue ball placed.';return true;}
 shoot(angle,power){if(this.shot||this.inHand||this.winner!==null||!Number.isFinite(angle)||!Number.isFinite(power)||power<0.12||power>1||(this.onEight&&this.call<0))return false;
 this.stats[this.turn].shots++;this.shot={first:null,rail:false,pots:[],onEight:this.onEight,call:this.call};const speed=110+power*power*1480;this.cue.vx=Math.cos(angle)*speed;this.cue.vy=Math.sin(angle)*speed;return true;}
 step(dt){if(!this.shot)return;const s=this.shot;const active=this.balls.filter(b=>!b.out);
  for(const b of active){b.x+=b.vx*dt;b.y+=b.vy*dt;const p=pockets.findIndex(([x,y],i)=>Math.hypot(b.x-x,b.y-y)<(i%3===1?24:28));if(p>=0){b.out=true;b.vx=b.vy=0;s.pots.push([b.n,p]);continue;}
   const side=(axis,vel,bound)=>{if(b[axis]<R||b[axis]>bound-R){b[axis]=Math.max(R,Math.min(bound-R,b[axis]));b[vel]*=-.76;if(s.first!==null)s.rail=true;}};
   side('x','vx',W);side('y','vy',H);
  }
  for(let pass=0;pass<2;pass++)for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
   const a=active[i],b=active[j];if(a.out||b.out)continue;const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);if(d>=2*R||d<1e-7)continue;
   const nx=dx/d,ny=dy/d,k=(2*R-d)/2; a.x-=nx*k;a.y-=ny*k;b.x+=nx*k;b.y+=ny*k;
   const closing=(a.vx-b.vx)*nx+(a.vy-b.vy)*ny;if(closing<=0)continue;
   if(s.first===null&&(a.n===0||b.n===0))s.first=a.n||b.n;
   const impulse=closing*.965;a.vx-=impulse*nx;a.vy-=impulse*ny;b.vx+=impulse*nx;b.vy+=impulse*ny;
  }
  const damp=Math.pow(.39,dt);let moving=false;
  for(const b of active){if(b.out)continue;b.vx*=damp;b.vy*=damp;if(Math.hypot(b.vx,b.vy)<STOP)b.vx=b.vy=0;else moving=true;}
  if(!moving)this.finish();
 }
 finish(){const s=this.shot,who=this.turn,opp=1-who,st=this.stats[who],g=this.groups[who];this.shot=null;this.call=-1;
  const scratch=s.pots.some(([n])=>n===0), objective=s.pots.filter(([n])=>n>0), black=objective.find(([n])=>n===8);
  const wrong=s.first===null||(!this.breaking&&(g?(s.onEight?s.first!==8:group(s.first)!==g):s.first===8));
  const foul=scratch||wrong||(!s.rail&&!objective.length);st.potted+=objective.filter(([n])=>n!==8).length;
  if(foul)st.fouls++;
  if(black&&!this.breaking){const won=s.onEight&&!foul&&black[1]===s.call;this.winner=won?who:opp;this.note=won?'The 8 dropped in the called pocket.':'The 8 was pocketed illegally.';return;}
  if(black&&this.breaking){const eight=this.balls.find(b=>b.n===8);for(let x=672;x<W-30;x+=24)if(!this.balls.some(b=>!b.out&&Math.hypot(b.x-x,b.y-H/2)<2*R+.5)){Object.assign(eight,{x,y:H/2,out:false});break;}}
  if(!this.breaking&&!g&&!foul){const assigned=group(objective[0]?.[0]);if(assigned){this.groups[who]=assigned;this.groups[opp]=3-assigned;}}
  const made=objective.filter(([n])=>!!group(n)&&(!this.groups[who]||group(n)===this.groups[who])).length;
  if(!foul&&made){st.run+=made;st.best=Math.max(st.best,st.run);this.note='Nice pot. Stay at the table.';}else{st.run=0;this.turn=opp;this.note=foul?(scratch?'Scratch. Place the cue ball.':'Foul. Place the cue ball.'):'Turn passed.';}
  if(foul){this.inHand=true;this.cue.out=true;}this.breaking=false;
 }
}
return {W,H,R,pockets,Game};})();
const APP_ID='1573988210185347223';
const net={session:null,phase:'connecting',you:null,rev:0,frame:0,busy:false,frames:null};
function onlineTurn(){return net.phase==='playing'&&net.you===game?.turn&&!net.busy;}
const endpoint=name=>new URL('./'+name,location.href);
async function poolRequest(name,data){
 const headers={};if(data)headers['Content-Type']='application/json';if(net.session)headers.Authorization='Bearer '+net.session;
 const response=await fetch(endpoint(name),{method:data?'POST':'GET',body:data?JSON.stringify(data):undefined,headers,credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(7000)});
 const state=await response.json();if(!response.ok){const err=Error(state.error||'Unable to reach the table.');err.status=response.status;throw err;}return state;
}
function applyRemote(state){
 const was=net.phase, previous=net.rev;
 if(previous>state.rev||(previous===state.rev&&net.frame>state.frame))return;
 net.phase=state.phase;net.rev=state.rev;net.frame=state.frame;net.you=state.you;
 if(Array.isArray(state.names)){state.names.forEach((name,i)=>{
  players[i]=name;document.querySelector('#seat'+i+' strong').textContent=name;document.querySelector('#seat'+i+' .avatar').textContent=Array.from(name)[0]||'?';$('end-name'+i).textContent=name;
 });}
 if(!game||screen==='connecting')begin();
 const rolling=!!state.shot;
 if(rolling&&game.balls.length===state.balls.length){
  const src=game.balls.map(b=>({x:b.x,y:b.y}));net.frames={src,to:state.balls,until:performance.now()+66};
  game.balls=state.balls.map((b,i)=>({...b,...src[i]}));
 }else{net.frames=null;game.balls=state.balls;}
 for(const key of ['turn','groups','stats','shot','breaking','inHand','note'])game[key]=state[key];
 game.winner=state.winner===null?null:state.players.indexOf(state.winner);
 if(was==='playing'&&state.phase!=='playing'&&state.winner===null){$('connect-status').textContent='The table expired. Start a new challenge.';show('connecting');return;}
 if(state.phase==='done'&&game.winner!==null){summary();return;}
 if(screen==='table'&&(previous!==state.rev||was!==state.phase||!rolling))sync();dirty=true;
}
function drawRemote(t){
 const frame=net.frames;if(!frame)return;
 const mix=Math.min(1,Math.max(0,1-(frame.until-t)/66));
 for(let i=0;i<game.balls.length;i++){const b=game.balls[i],p=frame.src[i],q=frame.to[i];b.x=p.x+(q.x-p.x)*mix;b.y=p.y+(q.y-p.y)*mix;}
 if(mix===1)net.frames=null;dirty=true;
}
async function submitTurn(input){
 if(!onlineTurn())return;
 net.busy=true;sync();
 try{applyRemote(await poolRequest('turn',{rev:net.rev,...input}));$('network-note').textContent='';}
 catch(err){$('network-note').textContent=err.message;}
 finally{net.busy=false;if(screen==='table')sync();}
}
async function poll(){
 const loop=()=>{if(['done','expired','withdrawn','declined','error'].includes(net.phase))return;setTimeout(poll,game?.shot?55:net.phase==='playing'?215:750);};
 if(net.busy)return loop();
 try{applyRemote(await poolRequest('state'));$('network-note').textContent='';}
 catch(err){if(err.status===401||err.status===403){net.phase='error';$('connect-status').textContent=err.message;show('connecting');}else $('network-note').textContent='Reconnecting…';}
 loop();
}
async function connectActivity(){
 show('connecting');
 try{
  if(!new URLSearchParams(location.search).get('frame_id'))throw Error('Open this game from the Open Table button in Discord.');
  const sdk=new PoolDiscordSDK.DiscordSDK(APP_ID);let readyTimeout;
  await Promise.race([sdk.ready(),new Promise((_,fail)=>{readyTimeout=setTimeout(()=>fail(Error('Discord did not start the Activity.')),9000);})]).finally(()=>clearTimeout(readyTimeout));
  const {code}=await sdk.commands.authorize({client_id:APP_ID,response_type:'code',prompt:'none',scope:['identify']});
  const {access_token,pass}=await poolRequest('auth',{code});
  const current=await sdk.commands.authenticate({access_token});if(!current?.user)throw Error('Discord did not authorize this account.');
  let seat;
  for(let attempt=0;attempt<4;attempt++){
   try{seat=await poolRequest('join',{pass,instance:sdk.instanceId});break;}
   catch(err){if(attempt===3||err.status!==403||!err.message.includes('not in this Activity'))throw err;await new Promise(r=>setTimeout(r,450));}
  }
  net.session=seat.session;applyRemote(seat.state);void poll();
 }catch(err){net.phase='error';$('connect-status').textContent=err.message||'Could not open the table.';}
}

'use strict';
const {W,H,R,pockets,Game}=Pool,$=id=>document.getElementById(id);
const players=['Rowan','Nova'], labels=['Top left','Top center','Top right','Bottom left','Bottom center','Bottom right'];
const colors=['#e8e4d5','#f0be3d','#3b6cc0','#c8433d','#7758a6','#e3843d','#40935a','#8d3939','#23282b'];
const canvas=$('felt'), g=canvas.getContext('2d'), base=$('table-surface');
const frame=52, cw=W+2*frame,ch=H+2*frame;
let game, phase='pending', screen='challenge', angle=0, power=.78, sample=false, pointer=null, strike=null, dirty=true, last=0, accum=0;
function show(id){if(id!=='table'){cueLayer.hidden=true;stopFineAim();clearCharge();}screen=id;for(const name of ['challenge','table','result','discord-result','connecting'])$(name).hidden=name!==id;dirty=true;}
function action(next){const actor=Number($('actor').value);if(phase!=='pending')return;if(next==='withdrawn'?actor!==0:actor!==1)return;phase=next;syncInvite();}
function syncInvite(){const actor=Number($('actor').value),pending=phase==='pending';$('invite-status').textContent={pending:'Waiting for Nova to respond.',accepted:'Challenge accepted. The table is ready.',declined:'Nova declined the challenge.',withdrawn:'Rowan withdrew the challenge.'}[phase];
 for(const id of ['accept','decline','withdraw'])$(id).hidden=!pending;
 $('accept').disabled=$('decline').disabled=actor!==1;$('withdraw').disabled=actor!==0;$('open').hidden=phase!=='accepted';$('invite-again').hidden=pending||phase==='accepted';}
function lobby(){phase='pending';$('actor').value='1';syncInvite();show('challenge');}
function begin(){clearCharge();sample=false;game=new Game();angle=0;grip=0;power=.78;pointer=null;strike=null;accum=0;setPower(78);show('table');resize();sync();}
function summary(){const winner=players[game.winner];$('winner').textContent=winner+' wins';$('reason').textContent=sample?'Sample result · '+game.note:game.note;
 $('stats').replaceChildren();for(const [key,label] of [['potted','Balls potted'],['best','Best run'],['shots','Shots taken'],['fouls','Fouls']]){const tr=document.createElement('tr'),th=document.createElement('th');th.scope='row';th.textContent=label;tr.append(th);for(const s of game.stats){const td=document.createElement('td');td.textContent=s[key];tr.append(td);}$('stats').append(tr);}show('result');}
function sync(){if(!game)return;const settled=!game.shot&&!strike;fillHud();syncFineAim();syncPower();
 for(let i=0;i<2;i++){const group=game.groups[i];$('seat'+i).classList.toggle('active',i===game.turn);$('group'+i).textContent=group?(group===1?'Solids':'Stripes')+' · '+game.remaining(group)+' left':'Open table';}
 $('turn').textContent=net.phase==='accepted'?'Waiting for opponent':strike?'Taking the shot':game.shot?'Balls rolling':players[game.turn]+' to play';$('shot-count').textContent=game.breaking?'Opening break':'Shot '+(1+game.stats[0].shots+game.stats[1].shots);
 $('call').hidden=!onlineTurn()||!settled||!game.onEight;[...$('call').children].forEach((b,i)=>b.setAttribute('aria-pressed',String(game.call===i)));
 $('shoot').textContent=game.breaking?'Break':'Shoot';$('shoot').disabled=!onlineTurn()||!settled||game.inHand||(game.onEight&&game.call<0);$('tips').textContent=net.phase==='accepted'?'Your opponent needs to press Open Table.':net.you!==game.turn?'Watch your opponent take their turn.':game.inHand?'Ball in hand. Tap an empty spot to place the cue ball.':game.onEight&&settled?'Choose a pocket for the 8, then aim and shoot.':game.note+' Aim, then drag and release Power to shoot.';
}
const cueLayer=$('cue-layer'), cueSvg=cueLayer.querySelector('svg'), cueObject=$('cue-object');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const strokeMs=()=>reduced.matches?55:155;
function cueFit(ux,uy,x,y,w,h){
 const pad=10, edge=(p,v,n)=>v>1e-7?(p-pad)/v:v< -1e-7?(n-pad-p)/-v:Infinity;
 return Math.max(0,Math.min(edge(x,ux,w),edge(y,uy,h)));
}
function showCue(t){
 if(!onlineTurn()||game.inHand||game.cue.out||game.shot||game.winner!==null){cueLayer.hidden=true;return;}
 const r=canvas.getBoundingClientRect(), worldScale=r.width/cw, viewW=document.documentElement.clientWidth, viewH=window.innerHeight;
 const x=r.left+(frame+game.cue.x)*worldScale,y=r.top+(frame+game.cue.y)*worldScale;
 if(!worldScale||x<10||y<10||x>viewW-10||y>viewH-10){cueLayer.hidden=true;return;}
 const u=Math.cos(angle),v=Math.sin(angle),room=cueFit(u,v,x,y,viewW,viewH),t0=strike?Math.max(0,Math.min(1,(t-strike.start)/strike.ms)):0;
 const initial=18+power*22, gap=strike?(t0<.34?initial+8*t0/.34:(R+.15)+(initial+8-R-.15)*(1-(t0-.34)/.66)**1.7):initial;
 const dist=Math.min(gap*worldScale,Math.max((R+.15)*worldScale,room*.42));
 const scale=Math.max(.001,Math.min(worldScale,(room-dist-2)/240));
 cueLayer.hidden=false;
 cueSvg.setAttribute('viewBox',`0 0 ${viewW} ${viewH}`);
 cueObject.setAttribute('transform',`translate(${x-u*dist} ${y-v*dist}) rotate(${angle*180/Math.PI}) scale(${scale})`);
}
function chip(ball){const item=document.createElement('span'),number=document.createElement('b');item.className='ball-chip'+(ball.n>8?' stripe':'')+(ball.out?' out':'');item.style.setProperty('--ball',colors[ball.n>8?ball.n-8:ball.n]);number.textContent=ball.n;item.append(number);return item;}
function fillHud(){
 for(const i of [0,1]){const group=game.groups[i];const candidates=game.balls.filter(b=>group===1?b.n>=1&&b.n<=7:group===2?b.n>=9:!b.out&&b.n>=1&&b.n<=7).sort((a,b)=>a.n-b.n);
  $('balls'+i).replaceChildren(...candidates.map(chip));}
 const out=game.balls.filter(b=>b.n&&b.out).map(b=>chip({...b,out:false}));$('potted').replaceChildren(...out);
}
function setPower(value){power=value/100;$('power').value=value;$('power').style.setProperty('--fill',`${(value-12)*100/88}%`);$('power-value').value=value+'%';dirty=true;}

const fineWheel=$('fine-wheel');
const rad=Math.PI/180;
let drag=null,grip=0;
function normalizedAim(){return (angle/rad%360+360)%360;}
function refreshAim(){const value=Math.round(normalizedAim()*100)/100%360;fineWheel.setAttribute('aria-valuenow',String(value));fineWheel.setAttribute('aria-valuetext',`${value} degrees`);fineWheel.style.setProperty('--grip',`${grip%8}px`);}
function stopFineAim(){if(drag&&fineWheel.hasPointerCapture(drag.id))fineWheel.releasePointerCapture(drag.id);drag=null;delete fineWheel.dataset.dragging;}
function aimReady(){return onlineTurn()&&screen==='table'&&game&&!strike&&!game.shot&&!game.inHand&&game.winner===null;}
function syncFineAim(){const ready=!!aimReady();fineWheel.setAttribute('aria-disabled',String(!ready));if(!ready)stopFineAim();refreshAim();}
function nudge(degrees){angle=(angle+degrees*rad)%(2*Math.PI);grip+=degrees*4;refreshAim();dirty=true;}
fineWheel.addEventListener('pointerdown',e=>{
 if(!aimReady()||drag||charge||e.button!==0||!e.isPrimary)return;
 e.preventDefault();fineWheel.focus({preventScroll:true});fineWheel.setPointerCapture(e.pointerId);drag={id:e.pointerId,y:e.clientY};fineWheel.dataset.dragging='';
});
fineWheel.addEventListener('pointermove',e=>{
 if(drag?.id!==e.pointerId||!aimReady())return;
 const dy=e.clientY-drag.y;drag.y=e.clientY;nudge(dy*(e.shiftKey?.035:.12));
});
for(const type of ['pointerup','pointercancel','lostpointercapture'])fineWheel.addEventListener(type,e=>{if(drag?.id===e.pointerId)stopFineAim();});
fineWheel.addEventListener('keydown',e=>{
 const sign=({ArrowDown:1,ArrowRight:1,ArrowUp:-1,ArrowLeft:-1})[e.key];if(!sign)return;e.preventDefault();if(aimReady()&&!charge)nudge(sign*(e.shiftKey?.05:.25));
});

const UHD_W=7680,UHD_H=4320;
let ultraTable=false,savingFrame=false;
const qualityNote=$('quality-note');
function save8k(){
 if(savingFrame||screen!=='table')return;
 savingFrame=true;$('save-8k').disabled=true;qualityNote.textContent='Rendering the 8K table…';
 // Allow the status message to paint before allocating the export bitmap.
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  const out=document.createElement('canvas');
  try{
   out.width=UHD_W;out.height=UHD_H;const c=out.getContext('2d');if(!c)throw Error('Canvas unavailable');
   const k=UHD_W/cw,artHeight=Math.round(ch*k),y=Math.floor((UHD_H-artHeight)/2);
   c.fillStyle='#0b1417';c.fillRect(0,0,UHD_W,UHD_H);
   if(base.width===UHD_W)c.drawImage(base,0,y);
   else{const plate=document.createElement('canvas');paintBase(plate,UHD_W);c.drawImage(plate,0,y);plate.width=1;plate.height=1;}
   c.save();c.setTransform(k,0,0,k,frame*k,y+frame*k);for(const b of game.balls)if(!b.out)ballFace(b,c);c.restore();
   out.toBlob(blob=>{
    try{if(!blob)throw Error('Export unavailable');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='BlueLand-8-Ball-8K.'+(blob.type==='image/jpeg'?'jpg':'png');document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);qualityNote.textContent='Saved 7680 × 4320';}
    catch{qualityNote.textContent='Could not save the 8K image on this device.';}
    finally{out.width=1;out.height=1;savingFrame=false;$('save-8k').disabled=false;}
   },'image/jpeg',.95);
  }catch{out.width=1;out.height=1;savingFrame=false;$('save-8k').disabled=false;qualityNote.textContent='Could not render 8K on this device.';}
 }));
}
$('save-8k').onclick=save8k;
$('ultra-table').onclick=()=>{
 const next=!ultraTable;
 try{ultraTable=next;resize();$('ultra-table').setAttribute('aria-pressed',String(next));qualityNote.textContent=next?'8K table surface on · balls stay adaptive':'Adaptive table surface';}
 catch{ultraTable=false;resize();$('ultra-table').setAttribute('aria-pressed','false');qualityNote.textContent='Using adaptive resolution on this device.';}
};

const powerSlider=$('power');
let charge=null;
function canCharge(){return !!(aimReady()&&(!game.onEight||game.call>=0));}
function verticalPower(){return getComputedStyle(powerSlider).writingMode.startsWith('vertical');}
function powerCoordinate(e,vertical){return vertical?e.clientY:e.clientX;}
function showCharge(active){
 if(active){powerSlider.dataset.charging='';$('power-caption').textContent='Release to shoot';}
 else{delete powerSlider.dataset.charging;$('power-caption').textContent='Drag & release';}
}
function clearCharge(restore=true){
 if(!charge)return null;
 const prev=charge;charge=null;showCharge(false);
 if(powerSlider.hasPointerCapture(prev.id))powerSlider.releasePointerCapture(prev.id);
 if(restore)setPower(prev.power);
 return prev;
}
function syncPower(){
 const ready=canCharge();
 if(!ready)clearCharge();
 powerSlider.disabled=!ready;
}
function updateCharge(e){
 const val=powerCoordinate(e,charge.vertical);
 if(!charge.moved&&Math.abs(val-charge.from)<4)return;
 charge.moved=true;showCharge(true);
 const rect=powerSlider.getBoundingClientRect();
 const progress=charge.vertical?(rect.bottom-val)/rect.height:(val-rect.left)/rect.width;
 setPower(Math.round(12+Math.max(0,Math.min(1,progress))*88));
}
powerSlider.addEventListener('pointerdown',e=>{
 if(!canCharge()||charge||drag||!e.isPrimary||e.button!==0)return;
 e.preventDefault();powerSlider.focus({preventScroll:true});powerSlider.setPointerCapture(e.pointerId);
 const vertical=verticalPower();charge={id:e.pointerId,vertical,from:powerCoordinate(e,vertical),angle,power:Number(powerSlider.value),moved:false};
});
powerSlider.addEventListener('pointermove',e=>{
 if(charge?.id===e.pointerId&&canCharge())updateCharge(e);
});
powerSlider.addEventListener('pointerup',e=>{
 if(charge?.id!==e.pointerId)return;
 const shoot=canCharge()&&charge.moved;
 if(shoot)updateCharge(e);
 const held=clearCharge(!shoot);
 if(shoot){angle=held.angle;fire();}
});
for(const type of ['pointercancel','lostpointercapture'])powerSlider.addEventListener(type,e=>{if(charge?.id===e.pointerId)clearCharge();});
powerSlider.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&charge){e.preventDefault();clearCharge();return;}
 if((e.key==='Enter'||e.key===' ')&&!e.repeat&&canCharge()&&!charge){e.preventDefault();fire();}
});
window.addEventListener('blur',()=>clearCharge());

function round(c,x,y,w,h,r){c.beginPath();c.roundRect(x,y,w,h,r);}
function circle(c,x,y,r){c.beginPath();c.arc(x,y,r,0,2*Math.PI);}
function fillCircle(c,x,y,r,color){c.fillStyle=color;circle(c,x,y,r);c.fill();}
function paintBase(target=base,width){
 const k=width/cw;target.width=width;target.height=Math.round(ch*k);const c=target.getContext('2d');if(!c)throw Error('Table surface unavailable');c.setTransform(k,0,0,k,0,0);
 const stops=(grad,colors)=>{colors.forEach(([i,col])=>grad.addColorStop(i,col));return grad;};
 function bar(x,y,w,h,curve,fill,stroke,sw=1){round(c,x,y,w,h,curve);c.fillStyle=fill;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=sw;c.stroke();}}
 const apron=stops(c.createLinearGradient(0,0,0,ch),[[0,'#4c382b'],[.12,'#34261e'],[.62,'#231b17'],[1,'#171215']]);
 bar(1.6,1.6,cw-3.2,ch-3.2,26,apron,'#161618',2);
 const wood=stops(c.createLinearGradient(0,0,0,ch),[[0,'#4d3728'],[.035,'#664b37'],[.15,'#49372b'],[.68,'#392c24'],[1,'#2d221c']]);
 bar(5,5,cw-10,ch-11,22,wood,'#9c744c70',1.25);c.save();c.clip();
 for(let j=8;j<ch;j+=2.7){c.beginPath();c.moveTo(5,j);c.bezierCurveTo(cw*.37,j-1,cw*.67,j+2,cw-3,j+.4);c.strokeStyle=j%4<1?'#ffe2b215':'#160e111c';c.lineWidth=.7;c.stroke();}c.restore();
 bar(30,30,cw-60,ch-60,21,'#101815','#ad885838',1.2);
 c.save();round(c,35,35,cw-70,ch-70,18);c.clip();
 const felt=stops(c.createRadialGradient(cw*.48,ch*.43,40,cw*.5,ch*.48,cw*.55),[[0,'#2d6c5c'],[.48,'#205548'],[.83,'#153a31'],[1,'#112b26']]);c.fillStyle=felt;c.fillRect(32,32,cw-64,ch-64);
 // Fine felt grain is rasterized at the requested output resolution, not enlarged from the play layer.
 const grain=document.createElement('canvas');grain.width=192;grain.height=192;const gc=grain.getContext('2d');const pixels=gc.createImageData(grain.width,grain.height);
 let seed=1327;for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const bright=(seed>>>24)>=128, tone=bright?206:18;pixels.data[i]=tone;pixels.data[i+1]=bright?230:38;pixels.data[i+2]=bright?213:32;pixels.data[i+3]=(seed>>>18)&15;}
 gc.putImageData(pixels,0,0);const texture=c.createPattern(grain,'repeat');texture.setTransform(new DOMMatrix().scale(1/Math.max(2,k)));c.fillStyle=texture;c.fillRect(35,35,cw-70,ch-70);
 const surround=stops(c.createLinearGradient(0,frame,0,ch-frame),[[0,'#001a155b'],[.065,'#001a1500'],[.91,'#001a1500'],[1,'#001a1570']]);c.fillStyle=surround;c.fillRect(35,35,cw-70,ch-70);c.restore();
 c.translate(frame,frame);
 function rail(points,shade,light){c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=shade;c.fill();c.lineWidth=1;c.strokeStyle=light;c.stroke();}
 for(const flip of [false,true]){c.save();if(flip){c.translate(W,H);c.rotate(Math.PI);}
  const h=stops(c.createLinearGradient(0,-21,0,1),[[0,'#21483c'],[.13,'#407d66'],[.62,'#3b7864'],[.85,'#27614e'],[1,'#173e33']]);
  const v=stops(c.createLinearGradient(-21,0,1,0),[[0,'#1e463b'],[.18,'#46836e'],[.7,'#34705d'],[1,'#1a473a']]);
  rail([[24,-21],[456,-21],[451,0],[42,0]],h,'#6d9e824a');rail([[504,-21],[936,-21],[918,0],[509,0]],h,'#6d9e824a');rail([[-21,23],[0,42],[0,H-42],[-21,H-23]],v,'#6d9e824a');c.restore();}
 c.strokeStyle='#afd7be2e';c.lineWidth=.8;c.beginPath();c.moveTo(234,0);c.lineTo(234,H);c.stroke();
 for(const x of [234,672])fillCircle(c,x,H/2,2.2,'#afcbb99c');
 pockets.forEach(([x,y],i)=>{const rad=i%3===1?28:31;c.save();c.shadowColor='#000b';c.shadowBlur=8;c.shadowOffsetY=3;fillCircle(c,x,y,rad+2,'#32291f');c.restore();
  const hole=stops(c.createRadialGradient(x-7,y-10,4,x,y,rad),[[0,'#131716'],[.6,'#0a0d0f'],[.89,'#111419'],[1,'#302720']]);fillCircle(c,x,y,rad,hole);circle(c,x,y,rad);c.strokeStyle='#7b61454d';c.lineWidth=1.15;c.stroke();});
 c.fillStyle='#e0d3ae';for(const x of [115,234,354,606,726,845])for(const y of [-36,H+36]){c.save();c.translate(x,y);c.rotate(Math.PI/4);c.fillRect(-2.5,-2.5,5,5);c.restore();}
 for(const x of [-36,W+36])for(const y of [119,240,361]){c.save();c.translate(x,y);c.rotate(Math.PI/4);c.fillRect(-2.5,-2.5,5,5);c.restore();}
}
function ballFace(b,g){
 const color=colors[b.n>8?b.n-8:b.n];const {x,y}=b;
 g.save();g.shadowColor='#071713b0';g.shadowBlur=5;g.shadowOffsetY=3;fillCircle(g,x,y,R,b.n>8?'#dcded2':color);g.restore();
 if(b.n>8){g.save();circle(g,x,y,R);g.clip();g.fillStyle=color;g.fillRect(x-R,y-6,R*2,12);g.restore();}
 const shade=g.createRadialGradient(x-4,y-5,1,x+1,y+1,R+2);shade.addColorStop(0,'#ffffffbe');shade.addColorStop(.41,'#ffffff20');shade.addColorStop(.68,'#020a140e');shade.addColorStop(1,'#02090bcc');fillCircle(g,x,y,R,shade);
 if(b.n){fillCircle(g,x+1.5,y+1,4.8,'#edeadd');g.fillStyle='#182028';g.textAlign='center';g.textBaseline='middle';g.font='bold 7px Lato, sans-serif';g.fillText(String(b.n),x+1.5,y+1.5);}
}
function aimLength(u,v){const {x,y}=game.cue;let d=Math.min(Math.hypot(W,H),Math.abs(u)>1e-7?(u>0?W-R-x:R-x)/u:Infinity,Math.abs(v)>1e-7?(v>0?H-R-y:R-y)/v:Infinity);
 for(const b of game.balls){if(!b.n||b.out)continue;const dx=b.x-x,dy=b.y-y,t=dx*u+dy*v,q=(2*R)**2-(dx*dx+dy*dy-t*t);if(t>0&&q>=0)d=Math.min(d,t-Math.sqrt(q));}return Math.max(0,d);}
function draw(t){const ratio=canvas.width/cw;g.setTransform(ratio,0,0,ratio,0,0);g.clearRect(0,0,cw,ch);g.translate(frame,frame);
 if(game.call>=0){const [x,y]=pockets[game.call];circle(g,x,y,32);g.strokeStyle='#ffdb8a';g.lineWidth=3;g.stroke();}
 if(onlineTurn()&&!game.inHand&&!game.cue.out&&!game.shot&&!strike){const u=Math.cos(angle),v=Math.sin(angle),{x,y}=game.cue,d=aimLength(u,v);
  if(d>R+4){g.setLineDash([3.2,6.6]);g.strokeStyle='#deeee0a3';g.lineWidth=1.4;g.beginPath();g.moveTo(x+u*(R+3),y+v*(R+3));g.lineTo(x+u*d,y+v*d);g.stroke();g.setLineDash([]);circle(g,x+u*d,y+v*d,R);g.strokeStyle='#deeee087';g.stroke();}}
 for(const b of game.balls)if(!b.out)ballFace(b,g);
 if(onlineTurn()&&game.inHand&&pointer){circle(g,pointer.x,pointer.y,R);g.strokeStyle='#f2e8d8';g.lineWidth=1.7;g.stroke();}showCue(t);}
function resize(){
 if(screen!=='table')return;
 const displayed=canvas.getBoundingClientRect().width;
 if(!displayed)return;
 const dpr=Math.max(1,devicePixelRatio||1),pixels=Math.min(4096,Math.max(1,Math.ceil(displayed*dpr)));
 if(canvas.width!==pixels){canvas.width=pixels;canvas.height=Math.round(pixels*ch/cw);}
 const staticWidth=ultraTable?UHD_W:Math.min(UHD_W,Math.max(1,Math.ceil(displayed*dpr)));
 if(base.width!==staticWidth||base.height!==Math.round(staticWidth*ch/cw))paintBase(base,staticWidth);
 dirty=true;
}
function animate(t){
 if(screen==='table'&&game){
  if(strike&&t>=strike.start+strike.ms){const finished=strike;strike=null;void submitTurn({type:'shot',angle:Math.atan2(Math.sin(finished.angle),Math.cos(finished.angle)),power:finished.power,call:game.call});dirty=true;}
  drawRemote(t);if(dirty||game.shot||strike){draw(t);dirty=false;}
 }
 requestAnimationFrame(animate);
}
function pos(e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*cw/r.width-frame,y:(e.clientY-r.top)*ch/r.height-frame};}
function aim(e){if(!onlineTurn()||game?.shot||strike||drag||charge)return;pointer=pos(e);if(!game.inHand){angle=Math.atan2(pointer.y-game.cue.y,pointer.x-game.cue.x);refreshAim();}dirty=true;}
function fire(){
 if(!canCharge()||charge)return;
 strike={angle,power,start:performance.now(),ms:strokeMs()};sync();dirty=true;
}
$('actor').onchange=syncInvite;$('accept').onclick=()=>action('accepted');$('decline').onclick=()=>action('declined');$('withdraw').onclick=()=>action('withdrawn');$('invite-again').onclick=lobby;$('open').onclick=begin;$('restart').onclick=begin;$('shoot').onclick=fire;$('rematch').onclick=begin;$('lobby').onclick=lobby;
$('example').onclick=()=>{game=new Game();sample=true;game.winner=0;game.note='The 8 dropped in the called pocket.';Object.assign(game.stats[0],{potted:7,best:4,shots:10,fouls:0});Object.assign(game.stats[1],{potted:3,best:2,shots:6,fouls:1});summary();};
$('leave').onclick=()=>{$('discord-winner').textContent='@'+players[game.winner]+' won the match.';show('discord-result');};
$('power').oninput=e=>setPower(Number(e.target.value));
for(let i=0;i<pockets.length;i++){const b=document.createElement('button');b.textContent=labels[i];b.setAttribute('aria-pressed','false');b.onclick=()=>{game.call=i;sync();dirty=true;};$('call').append(b);}
canvas.addEventListener('pointermove',aim);canvas.addEventListener('pointerdown',e=>{aim(e);if(onlineTurn()&&game.inHand&&pointer)void submitTurn({type:'place',x:pointer.x,y:pointer.y});canvas.focus();});
canvas.addEventListener('keydown',e=>{if(!onlineTurn()||game?.shot||strike||charge)return;if(e.key===' '){e.preventDefault();fire();}else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();angle+=(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?.008:.041);refreshAim();dirty=true;}});
window.addEventListener('resize',resize);window.addEventListener('scroll',()=>{dirty=true;},{passive:true});void connectActivity();requestAnimationFrame(animate);
