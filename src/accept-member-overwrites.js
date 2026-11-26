'use strict';
const {ChannelType,OverwriteType,PermissionFlagsBits:P}=require('discord.js');
const {catalog,RuleError}=require('./ladder');
const {marker,SUPPORT,MANAGERS,departmentRole}=require('./ticket-ui');
const read=P.ViewChannel|P.ReadMessageHistory;
const supportAccess=read|P.SendMessages|P.AttachFiles|P.EmbedLinks;
// discord-community.syncClaim removes and denies these bits for non-claimants.
const claimWriting=P.SendMessages|P.SendMessagesInThreads|P.CreatePublicThreads|P.CreatePrivateThreads;
const snowflake=id=>typeof id==='string' && /^\d{17,20}$/u.test(id);
const bitString=value=>typeof value==='string' && /^\d{1,20}$/u.test(value);
const plain=value=>value && Object.getPrototypeOf(value)===Object.prototype;
const unsafe=()=>new RuleError('أذونات القنوات خارج حدود القبول المعتمدة. راجعها قبل منح الرتب.',409);

function reviewedBaseline(grants,config) {
  if (!plain(config)) return null;
  const result=new Map();
  for (const [id,row] of Object.entries(config)) {
    if (!snowflake(id) || !plain(row)) return null;
    const masks=new Map();
    for (const [grant,mask] of Object.entries(row)) {
      // A decimal shorthand means no approved deny floor for that overwrite.
      const pair=bitString(mask)?{allow:mask,deny:'0'}:mask;
      if (!grants.includes(grant) || !plain(pair) || !bitString(pair.allow) || !bitString(pair.deny) ||
          Object.keys(pair).some(key=>key!=='allow' && key!=='deny')) return null;
      const approved={allow:BigInt(pair.allow),deny:BigInt(pair.deny)};
      if (approved.allow & approved.deny) return null;
      masks.set(grant,approved);
    }
    result.set(id,masks);
  }
  return result;
}

function loadReviewedBaseline() {
  // This manifest is reviewed configuration, never sampled or filled from Discord at runtime.
  try { return require('../config/accept-member-overwrites.json'); }
  catch { return null; }
}

function liveOverwrites(channel) {
  if (!Array.isArray(channel.permission_overwrites)) throw unsafe();
  const found=new Map();
  for (const {id,type,allow,deny} of channel.permission_overwrites) {
    if (!snowflake(id) || found.has(id) || ![OverwriteType.Role,OverwriteType.Member].includes(type) ||
        !bitString(allow) || !bitString(deny)) throw unsafe();
    const entry={type,allow:BigInt(allow),deny:BigInt(deny)};
    if (entry.allow & entry.deny) throw unsafe();
    found.set(id,entry);
  }
  return found;
}

function ticketSupportLimit(db,channel,row,overwrites) {
  const {guildId,botId}=catalog;
  const dynamic=row.kind==='technical' || row.kind==='rewards';
  const legacy=row.kind==='legacy';
  const complaint=row.kind==='staff-complaint' || row.kind==='complaint';
  if (!(dynamic || complaint || legacy) || row.channel!==channel.id || !snowflake(row.owner) ||
      channel.type!==ChannelType.GuildText || channel.topic?.split('\n')[0]!==marker(row)) throw unsafe();
  const everyone=overwrites.get(guildId);
  if (everyone?.type!==OverwriteType.Role || !(everyone.deny & P.ViewChannel)) throw unsafe();
  function canRead(id,type) {
    const ow=overwrites.get(id);
    return ow?.type===type && (ow.allow & read)===read && !(ow.deny & read);
  }
  if (!canRead(row.owner,OverwriteType.Member) || !canRead(botId,OverwriteType.Member)) throw unsafe();
  if (row.kind==='staff-complaint' && !canRead(MANAGERS,OverwriteType.Role)) throw unsafe();
  const audience=new Map([[row.owner,OverwriteType.Member],[botId,OverwriteType.Member]]);
  const role=dynamic?SUPPORT:row.kind==='staff-complaint'?MANAGERS:legacy?departmentRole(row.kind,db.settings()):'';
  if (role) audience.set(role,OverwriteType.Role);
  if (!complaint) for (const guest of db.ticketGuests(row.id)) audience.set(guest,OverwriteType.Member);
  for (const [id,ow] of overwrites) if ((ow.allow & P.ViewChannel) && audience.get(id)!==ow.type) throw unsafe();
  // /ticket create uses the configured role. A different configured role must never
  // turn into a new acceptance exception, even on a closed ticket.
  if (!(dynamic || (legacy && row.details==='' && role===SUPPORT))) return 0n;
  const claim=db.claimChange(row.id);
  if (!['open','closed'].includes(row.state)) throw unsafe();
  if (row.assignee===null && !claim) return supportAccess;
  // Old closed claims are backfilled without a sync flag and aren't recovered by the open-ticket worker.
  // Accept only the exact backfilled shape, with the live closed-member and claim locks still intact.
  const locked=ow=>ow && (ow.deny & claimWriting)===claimWriting && !(ow.allow & claimWriting);
  const migrated=legacy && row.state==='closed' && claim?.synced===0 && claim.grade===null &&
    claim.overwrites===null && claim.notice_nonce===null && claim.notice_attempted===null &&
    locked(everyone) && locked(overwrites.get(row.owner));
  if (!snowflake(row.assignee) || claim?.member!==row.assignee || claim.restoring!==0 ||
      !(claim.synced===1 || migrated)) throw unsafe();
  const support=overwrites.get(SUPPORT);
  if (support && !locked(support)) throw unsafe();
  return supportAccess & ~claimWriting;
}

function usableClaimWrites(overwrites,byId,target,ids) {
  const everyone=overwrites.get(catalog.guildId), member=overwrites.get(target);
  let bits=BigInt(byId.get(catalog.guildId).permissions), deny=0n, allow=0n;
  for (const id of ids) {
    bits|=BigInt(byId.get(id).permissions);
    const role=overwrites.get(id);
    if (role?.type===OverwriteType.Role) {deny|=role.deny;allow|=role.allow;}
  }
  if (bits & P.Administrator) return claimWriting;
  // Discord applies @everyone, then aggregate role denies/allows, then the member override.
  for (const ow of [everyone,{deny,allow},member?.type===OverwriteType.Member?member:null])
    if (ow) bits=(bits & ~ow.deny) | ow.allow;
  return bits & P.ViewChannel ? bits & claimWriting : 0n;
}

function verifyOverwrites(db,channels,grants,baseline,{byId,person}) {
  if (!baseline || typeof db?.ticketByChannel!=='function' || !Array.isArray(channels)) throw unsafe();
  const seen=new Set();
  for (const channel of channels) {
    if (!snowflake(channel?.id) || seen.has(channel.id) || (channel.guild_id!==undefined && channel.guild_id!==catalog.guildId)) throw unsafe();
    seen.add(channel.id);
    const overwrites=liveOverwrites(channel);
    const row=db.ticketByChannel(channel.id);
    if (!row && channel.topic?.startsWith('BlueLand ticket')) throw unsafe();
    const ticketLimit=row?ticketSupportLimit(db,channel,row,overwrites):null;
    for (const id of grants) {
      const ow=overwrites.get(id);
      if (ow && ow.type!==OverwriteType.Role) throw unsafe();
      const approved=baseline.get(channel.id)?.get(id);
      const allowed=row?(id===SUPPORT?ticketLimit:0n):(approved?.allow ?? 0n);
      if (((ow?.allow ?? 0n) & ~allowed) || ((approved?.deny ?? 0n) & ~(ow?.deny ?? 0n))) throw unsafe();
    }
    if (ticketLimit===(supportAccess & ~claimWriting) && ![row.owner,row.assignee].includes(person.user.id)) {
      const held=new Set(person.roles);
      const before=usableClaimWrites(overwrites,byId,person.user.id,held);
      // Check every intermediate role set in the same order as the individual Discord PUTs.
      for (const id of grants) {
        held.add(id);
        if (usableClaimWrites(overwrites,byId,person.user.id,held) & ~before) throw unsafe();
      }
    }
  }
  // Missing reviewed channels make the live inventory suspect; remove deleted entries only after review.
  if ([...baseline.keys()].some(id=>!seen.has(id))) throw unsafe();
}

module.exports={loadReviewedBaseline,reviewedBaseline,verifyOverwrites};
