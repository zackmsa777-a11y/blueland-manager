'use strict';

const {ComponentType,EmbedBuilder}=require('discord.js');

const PANEL = '1575141111805116466';
const SUPPORT = '1574013576694210731';
const MANAGERS = '1574013527050424410';
const SELECT = 'blticket:choose';
// The old complaint kind remains owner-only; do not expand access retroactively.
const kinds = Object.freeze({technical:'الدعم الفني',complaint:'شكوى على إداري','staff-complaint':'الشكوى على إداري',rewards:'استلام الجوائز'});
const sections = ['technical','staff-complaint','rewards'];
const departmentRole = (kind,settings={}) => kind==='staff-complaint'?MANAGERS:kind==='complaint'?'':
  kind==='legacy'?settings.supportRole || '':SUPPORT;
const ticketVisible = ({kind},rights) => kind==='staff-complaint'?rights.staffComplaints:
  kind==='complaint'?rights.complaintTickets:kind==='technical' || kind==='rewards'?rights.technicalTickets:
    kind==='legacy' && rights.legacyTickets;
const button = (action,label,style=2) => ({type:2,style,label,custom_id:'blticket:'+action});
const row = (...components) => ({type:1,components});
const panel = () => ({content:'',embeds:[new EmbedBuilder().setColor(0x3478f6).setTitle('🎫 مركز تذاكر BlueLand')
  .setDescription('اختر نوع التذكرة من قائمة **فتح التذكرة**. تُفتح التذكرة في روم خاص.').toJSON()],
  components:[row({type:ComponentType.StringSelect,custom_id:SELECT,placeholder:'فتح التذكرة',
    options:sections.map(value=>({value,label:kinds[value]}))})],allowedMentions:{parse:[]}});
const isPanel = message => message?.components?.some(r=>r.components?.some(c=>(c.customId ?? c.custom_id)===SELECT));
const controls = id => [row(button('claim:'+id,'استلام التذكرة',1),button('close:'+id,'إغلاق التذكرة',4))];
const release = (id,nonce) => [row(button(`unclaim:${id}${nonce?':'+nonce:''}`,'سحب الاستلام'))];
const confirmation = (id,actor,until) => [row(button(`delete:${id}:${actor}:${until}`,'تأكيد الحذف النهائي',4))];
const marker = ({id,owner}) => `BlueLand ticket ${id} • ${owner}`;

module.exports = {PANEL,SUPPORT,MANAGERS,SELECT,kinds,sections,departmentRole,ticketVisible,panel,isPanel,controls,release,confirmation,marker};
