'use strict';

const CREATOR='1235369589408399392';
const WINDOW=25_000, WAIT_COOLDOWN=180_000, USER_COOLDOWN=10_000, ROOM_COOLDOWN=2_000;
const privacy='خصوصية الأعضاء والتذاكر محفوظة. لا تشارك كلمة السر أو رمز التحقق أو بيانات الدفع هون؛ احكي المشكلة بدونها. 🔒';
const refused='مين إنت عشان أعمل كل هاد؟ 😄 أنا هون أساعد بالتذكرة؛ الكتم والإجراءات الإدارية ما ينفّذها إلا الطاقم المخوّل.';
const waiting='شايف رسائلك. اصبر شوي ليرد الطاقم، وما في داعي تكرر المنشن؛ رسالة وحدة بتكفي 🙏';
const privileged=/(?:^|[^\p{L}\p{N}])(?:اكتم|كتم|ميوت|اسكت|اطرد|احظر|بند|بان|رقي|ارفع رتبه|اعطه رول|اعطيه رول|احذف|عدل الرول|نفذ الامر|mute|unmute|ban|kick|timeout|promote)(?=$|[^\p{L}\p{N}])/u;
const personal=/(?:كلمه (?:السر|مرور|المرور)|باسورد|رمز (?:التحقق|دخول|الدخول)|كود (?:التحقق|دخول|الدخول)|توكن|رقم (?:البطاقه|الهويه|الجوال|تليفون|التليفون)|بيانات (?:الدفع|البطاقه|خاصه)|معلومات (?:العضو|الاعضاء|خاصه|شخصيه)|تذكره (?:ثانيه|غيري)|سجل تذكره|\b(?:password|otp|2fa|token|api[ _-]?key|credit card)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d[ -]?){13,19}\b)/u;
const programmed=/^(?:(?:مين|من)(?: (?:اللي|الي|يلي|الذي))? (?:برمجك|صنعك|سواك|عملك|طورك|مبرمجك)|who (?:made|created|programmed) you)[؟?!. ]*$/u;
const owns=/^(?:(?:مين|من)(?: هو)? (?:صاحب|مالك|اونر|اوعنر|اونر هذا) (?:السيرفر|الخادم)|who (?:owns (?:this|the) server|is the server owner))[؟?!. ]*$/u;

function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{M}\p{Cf}ـ]/gu,'').replace(/[أإآٱ]/gu,'ا')
    .replace(/ى/gu,'ي').replace(/ة/gu,'ه').replace(/\s+/gu,' ').trim();
}

// This assistant has only a room reply function. No tools, model calls, raw-text history or moderation dispatch.
function createTicketAssistant({botId,now=Date.now}) {
  const rooms=new Map();
  const mention=new RegExp('<@!?'+botId+'>','gu');
  const addressed=/^(?:يا بوت|يا بلو ?لاند|يا هيرمس|hey bot)(?:[\s،,:]+|$)/u;
  return async function talk(message,ticket,content) {
    if (!content || message.author.bot || message.webhookId) return;
    const actor=message.author.id;
    const time=now();
    const body=normalize(content);
    const question=body.replace(mention,'').trim().replace(addressed,'').trim();
    const direct=message.mentions?.users?.has(botId) || message.mentions?.repliedUser?.id===botId || question!==body;
    const pingedOthers=message.mentions?.everyone || Boolean(message.mentions?.roles?.size) || /<@(?:!?|&)\d{17,20}>|@(?:everyone|here)\b/u.test(content);
    const state=rooms.get(ticket.channel) ?? {burst:[], people:new Map(), lastSent:-Infinity, lastWait:-Infinity};
    rooms.delete(ticket.channel);
    rooms.set(ticket.channel,state);
    if (rooms.size>512) rooms.delete(rooms.keys().next().value);

    let response, reminder=false;
    const noDiscordMentions=body.replace(/<(?:@!?|@&|#)\d{17,20}>/gu,'');
    if (body.startsWith('+')) response=refused;
    else if (personal.test(noDiscordMentions)) response=privacy;
    else if (privileged.test(question) || (direct && /^(?:سوي|اعمل|نفذ|طبق)(?: |$)/u.test(question))) response=refused;
    else if (programmed.test(question)) response=`اللي برمجني هو <@${CREATOR}>.`;
    else if (owns.test(question)) {
      const owner=message.guild?.ownerId;
      if (/^\d{17,20}$/u.test(owner || '')) response=`مالك السيرفر هو <@${owner}>.`;
    } else {
      if (ticket.state==='open' && !ticket.assignee && actor===ticket.owner) {
        state.burst=state.burst.filter(event=>time-event.time<=WINDOW);
        state.burst.push({time, ping:pingedOthers || direct});
        if (state.burst.length>4) state.burst.shift();
        reminder=(state.burst.length>=4 || state.burst.filter(x=>x.ping).length>=2) && time-state.lastWait>=WAIT_COOLDOWN;
      }
      if (reminder) response=waiting;
      else if (direct || (ticket.state==='open' && actor===ticket.owner)) {
        if (/^(?:هلا|اهلا|سلام|مرحبا|هاي|السلام عليكم)[!؟?. ]*$/u.test(question) || !question) response='هلا فيك! أنا مساعد التذكرة. احكيلي شو صار وبنرتّبها سوا 🙂';
        else if (/(?:حسابي|تسجيل الدخول|ما اقدر ادخل|ما بقدر ادخل|ما يدخلني|login)/u.test(question)) response='شو بيظهر لك لما تحاول تسجّل الدخول؟ اكتب نص الخطأ بدون بريدك أو كلمة السر أو رمز التحقق.';
        else if (/(?:وين الطاقم|متي يرد|متي الرد|كم انتظر|احد يرد|حد يرد|هنا احد)/u.test(question)) response=ticket.state==='closed'?'التذكرة مقفلة. إذا احتجت مساعدة جديدة افتح تذكرة من اللوحة.':ticket.assignee?'الطاقم استلم تذكرتك. خلّي أي تحديث هون عشان يضل كل شي بمكان واحد.':'لسّه الطاقم ما استلم التذكرة. خلّيك هون، ومنشن واحد بكفي 🙏';
        else if (/(?:شكرا|تسلم|يعطيك العافيه|تمام وصلت|thank)/u.test(question)) response='ولو! إذا في شي ثاني بخصوص التذكرة احكيلي 🙂';
        else if (/(?:كيف (?:اقفل|اغلق)|بدي اقفل|اغلاق التذكره)/u.test(question)) response='إذا خلصت مشكلتك اضغط «إغلاق التذكرة» أو اكتب `+close`. الإغلاق ما يحذف الروم.';
        else response='معك. احكيلي شو المشكلة وشو جرّبت لحد هسا، بدون معلومات حساسة. إذا احتاجت إجراء إداري فالطاقم بيتولّاه.';
      }
    }
    if (!response || time-state.lastSent<ROOM_COOLDOWN || (!reminder && time-(state.people.get(actor) ?? -Infinity)<USER_COOLDOWN)) return;
    state.lastSent=time;
    if (reminder) { state.lastWait=time; state.burst=[]; }
    state.people.delete(actor);
    state.people.set(actor,time);
    if (state.people.size>64) state.people.delete(state.people.keys().next().value);
    await message.channel.send({content:response,allowedMentions:{parse:[]}}).catch(()=>{});
  };
}

module.exports={createTicketAssistant};
