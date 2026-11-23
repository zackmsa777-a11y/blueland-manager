'use strict';

const PANEL = '1574014072947736596';
const SUPPORT = '1574013576694210731';
const kinds = Object.freeze({technical:'الدعم الفني',complaint:'شكوى على إداري'});
const button = (action,label,style=2) => ({type:2,style,label,custom_id:'blticket:'+action});
const row = (...components) => ({type:1,components});
const panel = () => ({content:'**🎫 مركز تذاكر BlueLand**\nاضغط **للدعم الفني** واختر نوع التذكرة. تُفتح التذكرة في روم خاص.',
  components:[row(button('choose','للدعم الفني',1))],allowedMentions:{parse:[]}});
const isPanel = message => message?.components?.some(r=>r.components?.some(c=>(c.customId ?? c.custom_id)==='blticket:choose'));
const choices = () => [row(button('open:technical',kinds.technical,1),button('open:complaint',kinds.complaint,4))];
const controls = id => [row(button('claim:'+id,'استلام التذكرة',1),button('close:'+id,'إغلاق التذكرة',4))];
const confirmation = (id,actor,until) => [row(button(`delete:${id}:${actor}:${until}`,'تأكيد الحذف النهائي',4))];
const marker = ({id,owner}) => `BlueLand ticket ${id} • ${owner}`;

module.exports = {PANEL,SUPPORT,kinds,panel,isPanel,choices,controls,confirmation,marker};
