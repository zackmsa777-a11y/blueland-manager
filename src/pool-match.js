'use strict';
const {Game}=require('./pool-physics');
const WAIT=300_000, IDLE=30*60_000, STEP=1000/120;
const running=m=>m.phase==='pending'||m.phase==='accepted'||m.phase==='playing';
class PoolError extends Error { constructor(message,status=409){super(message);this.status=status;} }
function createPoolMatchmaker({now=Date.now,changed=()=>{}}={}) {
  const matches=new Map(), rooms=new Map();
  const signal=m=>changed(m);
  const close=(m,phase,t=now())=>{
    m.phase=phase;m.ends=t+(phase==='done'?IDLE:WAIT);
    if (rooms.get(m.voice)===m) rooms.delete(m.voice);
    signal(m);
  };
  function lookup(id){const m=matches.get(id);if(!m||!running(m))throw new PoolError('This challenge is closed.',404);if(now()>=m.ends){close(m,'expired');throw new PoolError('This challenge is closed.',404);}return m;}
  function challenge({id,from,to,guild,text,names}) {
    if(!id||!guild||!text||!from||!to||from===to)throw new PoolError('Choose another member.',400);
    if(matches.has(id))throw new PoolError('This challenge already exists.');
    if(matches.size>=256||[...matches.values()].some(m=>running(m)&&(m.seats.includes(from)||m.seats.includes(to))))throw new PoolError('One of the players already has a challenge or game.');
    const m={id,guild,text,seats:[from,to],names:(names||['Challenger','Opponent']).map(n=>String(n).slice(0,48)),ends:now()+WAIT,phase:'pending',opened:new Set(),joined:new Set(),rev:0,frame:0,game:new Game()};
    matches.set(id,m);return m;
  }
  function decision(id,who,action){const m=lookup(id);
    if(action==='withdraw'){
      if(who!==m.seats[0])throw new PoolError('Only the challenger can withdraw.',403);
      if(m.phase==='playing')throw new PoolError('This match has already started.');
      close(m,'withdrawn');return m;
    }
    if(who!==m.seats[1])throw new PoolError('Only the invited player can answer.',403);
    if(m.phase!=='pending')throw new PoolError('This challenge has already been answered.');
    if(action==='decline'){close(m,'declined');return m;}
    if(action!=='accept')throw new PoolError('Unknown action.',400);
    m.phase='accepted';m.ends=now()+WAIT;signal(m);return m;
  }
  function reserve(id,who,voice){const m=lookup(id);
    if(m.phase==='pending'||!m.seats.includes(who))throw new PoolError('Only the two accepted players can open the table.',403);
    if(!voice)throw new PoolError('Join a voice channel first.',400);
    if(m.voice&&m.voice!==voice)throw new PoolError('Join the same voice channel as your opponent.',400);
    if(rooms.has(voice)&&rooms.get(voice)!==m)throw new PoolError('That voice channel already has a table.');
    m.voice=voice;rooms.set(voice,m);return m;
  }
  function open(id,who,voice){const m=reserve(id,who,voice);m.opened.add(who);return m;}
  function unreserve(m){if(!m.voicePost&&!m.posting&&!m.opened.size&&m.phase==='accepted'&&rooms.get(m.voice)===m){rooms.delete(m.voice);m.voice=undefined;}}
  function unopen(m,who){if(m.joined.has(who))return;m.opened.delete(who);unreserve(m);}
  function join(who,voice,instance){
    const m=rooms.get(voice);
    if(!m||!instance||!m.seats.includes(who)||!m.opened.has(who))throw new PoolError('No seat for your account here. Press Open Table on your challenge.',403);
    lookup(m.id);
    if(m.instance&&instance!==m.instance)throw new PoolError('Join the same Activity as your opponent.',409);
    m.instance=instance;m.joined.add(who);
    if(m.joined.size===2&&m.phase==='accepted'){m.phase='playing';m.ends=now()+IDLE;signal(m);}
    return m;
  }
  function act(m,who,instance,data){
    if(!m||m.instance!==instance||!m.joined.has(who))throw new PoolError('This session cannot act at the table.',403);
    if(m.phase!=='playing'||now()>=m.ends)throw new PoolError('This match is not active.');
    const g=m.game;
    if(data?.rev!==m.rev)throw new PoolError('The table changed. Try again.');
    if(who!==m.seats[g.turn])throw new PoolError('It is not your turn.',403);
    if(g.shot)throw new PoolError('Wait for the balls to stop.');
    if(data.type==='place'){
      if(!g.place(data.x,data.y))throw new PoolError('Choose a free spot for the cue ball.',400);
    }else if(data.type==='shot'){
      const {angle,power,call}=data;
      if(!Number.isFinite(angle)||Math.abs(angle)>Math.PI*4||!Number.isFinite(power)||power<.12||power>1||(g.onEight&&(!Number.isInteger(call)||call<0||call>5)))throw new PoolError('Invalid shot.',400);
      const previous=g.call;g.call=g.onEight?call:-1;
      if(!g.shoot(angle,power)){g.call=previous;throw new PoolError('This shot is not available.',400);}
      m.sim=now();
    } else throw new PoolError('Unknown action.',400);
    m.ends=now()+IDLE;m.rev++;
    return snapshot(m,who);
  }
  function snapshot(m,who){const g=m.game;return {...structuredClone(g),rev:m.rev,frame:m.frame,phase:m.phase,you:m.seats.indexOf(who),players:[...m.seats],names:[...m.names],winner:g.winner===null?null:m.seats[g.winner]};}
  function tick(){const t=now();
    for(const m of matches.values()){
      if(t>=m.ends){if(running(m))close(m,'expired',t);else {if(m.phase==='done'&&!m.revealResult){m.revealResult=true;signal(m);}matches.delete(m.id);}continue;}
      if(m.phase!=='playing'||!m.game.shot)continue;
      const steps=Math.min(30,Math.max(0,Math.floor((t-m.sim)/STEP)));
      for(let i=0;i<steps&&m.game.shot;i++)m.game.step(1/120);
      m.frame+=steps;
      m.sim+=steps*STEP;
      if(!m.game.shot){m.rev++;if(m.game.winner!==null)close(m,'done',t);}
    }
  }
  return {challenge,decision,reserve,unreserve,open,unopen,join,act,snapshot,tick,
    finished:(voice,who)=>[...matches.values()].filter(m=>m.phase==='done'&&m.voice===voice&&m.seats.includes(who)),
    get:id=>matches.get(id),fail:id=>{const m=matches.get(id);if(m&&running(m))close(m,'expired');}};
}
module.exports={createPoolMatchmaker,PoolError};
