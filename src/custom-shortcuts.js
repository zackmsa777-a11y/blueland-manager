'use strict';

const {RuleError, parseRankChangeArgs} = require('./ladder');
const {commands, chatAliases, parseChat, inRoleCommand} = require('./commands');
const {commandName, subcommandName} = require('./command-aliases');
const {parseTop}=require('./activity-top');
const clean = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu,' ');
const keyOf = value => clean(value).toLowerCase();
const mention = /^<@!?(\d{17,20})>$/u;
const groupOf = action => ['warn','unwarn','warnings','timeout','untimeout','mute','unmute','lock','unlock','kick','ban','unban'].includes(action) ? 'mod'
  : ['promote','demote','roles','dashboard','bulk-role'].includes(action) ? 'roles'
  : ['request','ticket'].includes(action) ? 'requests' : action==='game' ? 'games' : 'general';
const names={member:'@العضو',user_id:'معرّف_العضو',id:'رقم_السجل',minutes:'الدقائق',reason:'السبب',kind:'نوع_الطلب',details:'التفاصيل',subject:'الموضوع',count:'عدد_الدرجات',role:'@الرول'};
const catalog=new Map();
const dotGameCommands=new Map();
function register(row) {
  catalog.set(row.name,row);
  if(row.action==='game') for(const alias of row.chat) dotGameCommands.set(alias,row);
}
for (const def of commands.filter(d=>commandName(d.name)===d.name)) {
  const a=commands.find(d=>d.name!==def.name && commandName(d.name)===def.name);
  const subs=def.options.filter(o=>o.type===1);
  const build=(name,sub,definition,alias) => {
    const action=def.name;
    const knownChat=sub?[]:Object.entries(chatAliases).filter(([,kind])=>kind===action).map(([phrase])=>'+'+phrase);
    const chat=knownChat.length?[...knownChat,'+'+action]:[];
    if(action==='game') chat.push('.'+alias.split(' ').at(-1));
    if(action==='game'&&sub==='rps') chat.push('.حجر','.حجر ورقة مقص');
    if(action==='promote')chat.push('+ترقية');
    if(action==='top')chat.push('توب','توب يومي','توب أسبوعي','توب شهري','توب كتابي','توب فويس','توب كتابي يومي','توب فويس شهري');
    if(action==='dashboard')chat.push('+لوحة');
    const access=groupOf(action)==='mod'||['promote','dashboard'].includes(action)||action==='request'&&['approve','reject','pending'].includes(sub)?'حسب صلاحية الطاقم':
      action==='ticket'&&sub==='close'?'صاحب التذكرة أو الدعم':action==='ticket'&&sub!=='create'?'الدعم':'أعضاء السيرفر';
    register({name,alias,action,sub,cat:groupOf(action),access,desc:definition.description,options:definition.options,chat,
      ...(action==='promote'?{example:'+ترقية @العضو 2',related:'+تخفيض @العضو 3',note:'السلاش يرفع درجة واحدة؛ لاختيار عدد، اكتب الأمر في الشات والعدد بعد المنشن.'}:{})});
  };
  if (!subs.length) build('/'+def.name,null,def,'/'+a.name);
  else for (const sub of subs) build(`/${def.name} ${sub.name}`,sub.name,sub,`/${a.name} ${a.options.find(o=>subcommandName(a.name,o.name)===sub.name).name}`);
}
register({name:'+تخفيض',action:'demote',cat:'roles',access:'المالك أو الإداري المخوّل',desc:'خفض عضو في سلّم الطاقم.',chat:['+تخفيض','+demote'],example:'+تخفيض @العضو 3',note:'العدد بعد المنشن، والافتراضي درجة واحدة.',options:[{type:6,name:'member',required:true,description:'منشن عضو واحد'},{type:4,name:'count',required:false,description:'عدد الدرجات؛ الافتراضي 1'}]});
for(const group of ['الجميع','البوتات'])register({name:'+ر '+group,action:'bulk-role',audience:group==='البوتات'?'bots':'members',cat:'roles',access:'مالك السيرفر فقط',desc:'يوزع رول على '+group+' بحسب الأهلية.',chat:['+ر '+group],example:`+ر ${group} @الرول`,note:'لو البوت طلب تأكيد للتوزيع، استخدم الأمر الأصلي اللي يبعته في نفس الروم.',options:[{name:'role',required:true,description:'منشن الرول أو معرّفه'}]});
const reserved=new Set([...catalog.values()].flatMap(c=>[c.name,c.alias,...c.chat].filter(Boolean).map(n=>keyOf(n.replace(/^[+/]/,'')))));
reserved.add(inRoleCommand.name); // Reserve the name without making the staff-only command an alias target or a public listing.
const defaults=[{phrase:'تف',command:'/ban'},{phrase:'برا',command:'/kick'}];
function openShortcuts(db) {
  db.exec('CREATE TABLE IF NOT EXISTS command_shortcuts (key TEXT PRIMARY KEY, phrase TEXT NOT NULL, command TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL)');
  const insert=db.prepare('INSERT OR IGNORE INTO command_shortcuts(key,phrase,command,actor,created) VALUES(?,?,?,?,?)');
  for (const row of defaults) insert.run(keyOf(row.phrase),row.phrase,row.command,'default',0);
  const rows=db.prepare('SELECT key, phrase, command FROM command_shortcuts ORDER BY length(key) DESC, key');
  const count=db.prepare('SELECT count(*) AS n FROM command_shortcuts');
  function list(){return rows.all().filter(row=>catalog.has(row.command)).map(({phrase,command})=>({phrase,command}));}
  function add(phrase,command,actor){
    if (typeof phrase!=='string'||typeof command!=='string'||!catalog.has(command)) throw new RuleError('اختَر أمرًا موجودًا في الدليل.');
    phrase=clean(phrase);
    if (phrase.length>40||!/^\p{L}[\p{L}\p{M}\p{N}]*(?:[ _-][\p{L}\p{M}\p{N}]+)*$/u.test(phrase)) throw new RuleError('اكتب حرفًا أو كلمة أو عبارة (حتى 40 حرفًا) بدون + أو / أو منشن.');
    const key=keyOf(phrase);
    if (reserved.has(key) || parseTop(key)) throw new RuleError('الاسم مستخدم في أمر حالي.',409);
    if (count.get().n>=200) throw new RuleError('وصلت للحد الأقصى للاختصارات.',409);
    if (!insert.run(key,phrase,command,actor,Date.now()).changes) throw new RuleError('الاختصار ده مستخدم بالفعل.',409);
    return {phrase,command};
  }
  function match(text){
    if (!text || /^[+/]/u.test(text)) return null;
    if (text.startsWith('.')) {
      const spec=dotGameCommands.get(text);
      if (spec) return {phrase:text,spec,args:''};
      const timed=/^(\.روليت)\s+([+\-\d][\s\S]*)$/u.exec(text);
      return timed ? {phrase:timed[1],spec:dotGameCommands.get(timed[1]),args:timed[2]} : null;
    }
    // Do not normalize free-form arguments (e.g. a reason) entered by the user.
    const words=[...text.matchAll(/\S+/gu)];
    const prefixes=new Map();
    for (let i=0;i<words.length;i++) {
      const end=words[i].index+words[i][0].length;
      const key=keyOf(text.slice(0,end));
      if(key.length>40)break;
      prefixes.set(key,end);
    }
    for (const item of rows.all()) {
      const spec=catalog.get(item.command), end=prefixes.get(item.key);
      if(end===undefined||!spec)continue;
      const args=text.slice(end).trim();
      // Bare shortcuts never consume ordinary prose. Arguments must start in an unmistakable format.
      const first=spec.options[0];
      if(args && (!first || !(first.type===6?/^<@!?\d{17,20}>(?:\s|$)/u.test(args)
        :first.type===4 || first.name==='user_id'?/^\d/u.test(args)
        :first.name==='role'?/^(?:<@&\d{17,20}>|\d{17,20})(?:\s|$)/u.test(args):args.startsWith('"'))))return null;
      return {phrase:item.phrase,spec,args};
    }
    return null;
  }
  return {list,add,match};
}

function usage({phrase,spec}) {
  let suffix=spec.options.map((opt,index)=>{
    const label=names[opt.name]||opt.name;
    const token=opt.type===3&&opt.name!=='user_id'&&(index===0||index<spec.options.length-1)?`"${label}"`:label;
    return opt.required?token:`[${token}]`;
  }).join(' ');
  if(spec.action==='promote')suffix+=' [عدد_الدرجات]';
  return 'الاستخدام: `'+phrase+(suffix?' '+suffix:'')+'`';
}
function parseShortcut(hit) {
  const {spec,args}=hit;
  const fail=()=>{throw new RuleError(usage(hit));};
  if(hit.phrase==='.روليت'&&spec.action==='game'&&args) {
    const {parseLobbyDuration}=require('./roulette-lobby');
    return {action:'game',sub:'roulette',lobbyMs:parseLobbyDuration(args)};
  }
  if(spec.action==='promote'||spec.action==='demote'){
    try{return {action:spec.action,...parseRankChangeArgs(args?args.split(/\s+/u):[],hit.phrase)};}catch(err){if(err instanceof RuleError)return fail();throw err;}
  }
  if(spec.action==='bulk-role'){
    try{return parseChat('+ر '+(spec.audience==='bots'?'البوتات':'الجميع')+' '+args);}catch(err){if(err instanceof RuleError)return fail();throw err;}
  }
  let rest=args;
  const input={action:spec.action,sub:spec.sub};
  for(const [idx,o] of spec.options.entries()) {
    if(!rest){if(o.required)fail();break;}
    const final=idx===spec.options.length-1;
    const quoted=o.type===3&&o.name!=='user_id'&&(idx===0||!final||rest.startsWith('"'));
    const m=quoted?/^"([^"\r\n]+)"(?=\s|$)/u.exec(rest):o.type===3&&final&&o.name!=='user_id'?[rest,rest]:/^(\S+)/u.exec(rest);
    if(!m)fail();
    const value=m[1].trim(); rest=rest.slice(m[0].length).trim();
    if(o.type===6){const id=mention.exec(value)?.[1];if(!id)fail();input.target=id;}
    else if(o.type===4){const n=Number(value);if(!/^\d+$/u.test(value)||!Number.isSafeInteger(n)||n<(o.min_value??1)||n>(o.max_value??Number.MAX_SAFE_INTEGER))fail();input[o.name]=n;if(o.name==='id')input.caseId=n;}
    else if(o.name==='user_id'){if(!/^\d{17,20}$/u.test(value))fail();input.target=value;}
    else {if(value.length<(o.min_length??1)||value.length>(o.max_length??650)||o.choices&&!o.choices.some(c=>c.value===value))fail();input[o.name]=value;}
  }
  if(rest)fail();
  return input;
}
function commandGuide(shortcuts){
  const custom=shortcuts.list();
  return [...catalog.values()].map(({name,alias,cat,access,desc,chat,note,example,related,options})=>({name,alias,cat,access,desc,chat,note,example,related,
    options:options.map(o=>({name:o.name,label:names[o.name]||o.name,description:o.description,required:!!o.required,min:o.min_value,max:o.max_value,minLength:o.min_length,maxLength:o.max_length,choices:o.choices})),
    custom:custom.filter(a=>a.command===name).map(a=>a.phrase)}));
}
module.exports={openShortcuts,parseShortcut,commandGuide,usage};
