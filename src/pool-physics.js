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
module.exports=Pool;
