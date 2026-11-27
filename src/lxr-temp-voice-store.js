'use strict';

const {randomUUID}=require('node:crypto');
const isId=value=>typeof value==='string' && /^[1-9][0-9]{16,19}$/.test(value);
const isMarker=value=>typeof value==='string' && value.length>0 && value.length<=100;
const privacyModes=new Set(['open','locked','hidden']);
const editable=new Set(['ownerId','waitingId','waitingMarker','privacy','trusted','blocked','invited']);
const listIds=values=>Array.isArray(values) && values.every(isId);
const capacityPhases=new Set(['locking','locked','opening']);

function openTempVoiceStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lxr_temp_voice (
    owner_id TEXT NOT NULL PRIMARY KEY,
    id TEXT UNIQUE,
    marker TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    excluded_ids TEXT NOT NULL,
    waiting_id TEXT UNIQUE,
    waiting_marker TEXT UNIQUE,
    privacy TEXT NOT NULL DEFAULT 'open' CHECK(privacy IN ('open','locked','hidden')),
    trusted TEXT NOT NULL DEFAULT '[]',
    blocked TEXT NOT NULL DEFAULT '[]',
    invited TEXT NOT NULL DEFAULT '[]',
    move_at INTEGER,
    handoff_owner_id TEXT,
    move_attempt TEXT,
    move_retry_at INTEGER,
    opened INTEGER NOT NULL DEFAULT 0 CHECK(opened IN (0,1)),
    panel_ready INTEGER NOT NULL DEFAULT 0 CHECK(panel_ready IN (0,1)),
    lock_generation TEXT NOT NULL DEFAULT '0',
    CHECK(id IS NULL OR waiting_id IS NULL OR id <> waiting_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS lxr_temp_voice_panel_reservation (
    channel_id TEXT NOT NULL PRIMARY KEY,
    room_id TEXT REFERENCES lxr_temp_voice(id) ON DELETE CASCADE,
    CHECK(room_id IS NULL OR room_id = channel_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS lxr_temp_voice_capacity_lock (
    room_id TEXT NOT NULL PRIMARY KEY REFERENCES lxr_temp_voice(id) ON DELETE CASCADE,
    prior_limit INTEGER NOT NULL CHECK(prior_limit BETWEEN 0 AND 99),
    phase TEXT NOT NULL CHECK(phase IN ('locking','locked','opening')),
    revision TEXT NOT NULL
  ) STRICT`);
  function write(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result=work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const hasColumn=name=>db.prepare('PRAGMA table_info(lxr_temp_voice)').all().some(col=>col.name===name);
  for(const [name,type] of [['lock_generation',"TEXT NOT NULL DEFAULT '0'"],
    ['handoff_owner_id','TEXT'],['move_attempt','TEXT'],['move_retry_at','INTEGER']]) {
    if(!hasColumn(name)) write(()=>{
      if(hasColumn(name)) return;
      db.exec(`ALTER TABLE lxr_temp_voice ADD COLUMN ${name} ${type}`);
      // Only pending reservations are provably still held by the original owner.
      if(name==='handoff_owner_id') db.exec('UPDATE lxr_temp_voice SET handoff_owner_id=owner_id WHERE id IS NULL');
    });
  }
  // The room's move_* columns are used only by this one-time migration.
  // Journal identity is the original voice session, not the current room owner.
  // No foreign key to the room: any retirement path may remove the room row.
  const hasHandoffs=db.prepare(`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lxr_temp_voice_handoff'`);
  if(!hasHandoffs.get()) write(()=>{
    if(hasHandoffs.get()) return;
    db.exec(`CREATE TABLE lxr_temp_voice_handoff (
      owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      marker TEXT NOT NULL,
      move_at INTEGER,
      move_attempt TEXT,
      retry_at INTEGER,
      PRIMARY KEY(owner_id,session_id),
      CHECK((move_at IS NOT NULL AND move_attempt IS NOT NULL AND retry_at IS NULL) OR
        (move_at IS NULL AND move_attempt IS NULL AND retry_at IS NOT NULL))
    ) STRICT;
    INSERT INTO lxr_temp_voice_handoff (owner_id,session_id,room_id,marker,move_at,move_attempt,retry_at)
      SELECT handoff_owner_id,session_id,id,marker,move_at,
        CASE WHEN move_at IS NOT NULL THEN coalesce(move_attempt,lower(hex(randomblob(16)))) END,
        CASE WHEN move_at IS NULL THEN move_retry_at END
      FROM lxr_temp_voice WHERE id IS NOT NULL AND handoff_owner_id IS NOT NULL AND opened=0
        AND (move_at IS NOT NULL OR move_retry_at IS NOT NULL)`);
  });
  const reservePanel=db.prepare(`INSERT OR IGNORE INTO lxr_temp_voice_panel_reservation(channel_id,room_id)
    SELECT ?,? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM lxr_temp_voice WHERE id=?)`);
  const releasePanel=db.prepare('DELETE FROM lxr_temp_voice_panel_reservation WHERE channel_id=? AND room_id IS ?');
  const rooms=`SELECT r.*,h.move_at AS attempt_at,h.move_attempt AS attempt_token,h.retry_at AS attempt_retry_at
    FROM lxr_temp_voice r LEFT JOIN lxr_temp_voice_handoff h
      ON h.owner_id=r.handoff_owner_id AND h.session_id=r.session_id AND h.room_id=r.id AND h.marker=r.marker`;
  const getRow=db.prepare(`${rooms} WHERE r.id=?`);
  const ownerRow=db.prepare(`${rooms} WHERE r.owner_id=?`);
  const waitingRow=db.prepare(`${rooms} WHERE r.waiting_id=?`);
  const activeRows=db.prepare(`${rooms} WHERE r.id IS NOT NULL ORDER BY r.id`);
  const pendingRows=db.prepare(`${rooms} WHERE r.id IS NULL ORDER BY r.owner_id`);
  const unsettledHandoff='SELECT 1 FROM lxr_temp_voice_handoff WHERE owner_id=? AND session_id=?';
  const hasUnsettledHandoff=db.prepare(unsettledHandoff);
  const pendingHandoff=db.prepare(`SELECT room_id,marker,move_at,move_attempt FROM lxr_temp_voice_handoff
    WHERE owner_id=? AND session_id=? AND move_at IS NOT NULL`);
  const reserve=db.prepare(`INSERT OR IGNORE INTO lxr_temp_voice(owner_id,marker,session_id,excluded_ids,handoff_owner_id)
    SELECT ?,?,?,?,? WHERE NOT EXISTS (${unsettledHandoff})`);
  const attach=db.prepare(`UPDATE lxr_temp_voice AS mine SET id=?, excluded_ids='[]'
    WHERE owner_id=? AND marker=? AND id IS NULL
    AND NOT EXISTS (SELECT 1 FROM lxr_temp_voice AS other WHERE other.waiting_id=?)`);
  const edit=db.prepare(`UPDATE lxr_temp_voice AS mine
    SET owner_id=?,waiting_id=?,waiting_marker=?,privacy=?,trusted=?,blocked=?,invited=?
    WHERE id=? AND NOT EXISTS (SELECT 1 FROM lxr_temp_voice AS other WHERE other.id=?)`);
  // Beginning or retrying is possible only in the original, still-owned room.
  const beginMove=db.prepare(`INSERT INTO lxr_temp_voice_handoff(owner_id,session_id,room_id,marker,move_at,move_attempt)
    SELECT owner_id,session_id,id,marker,?,? FROM lxr_temp_voice
      WHERE id=? AND owner_id=? AND handoff_owner_id=owner_id AND session_id=? AND marker=? AND opened=0
    ON CONFLICT(owner_id,session_id) DO UPDATE SET move_at=excluded.move_at,move_attempt=excluded.move_attempt,retry_at=NULL
      WHERE room_id=excluded.room_id AND marker=excluded.marker AND retry_at<=excluded.move_at`);
  const dropOldHandoffs=db.prepare('DELETE FROM lxr_temp_voice_handoff WHERE owner_id=? AND session_id<>?');
  const exactAttempt='owner_id=? AND session_id=? AND room_id=? AND marker=? AND move_at=? AND move_attempt=?';
  const rejectMove=db.prepare(`UPDATE lxr_temp_voice_handoff SET move_at=NULL,move_attempt=NULL,retry_at=? WHERE ${exactAttempt}`);
  const consumeProof=db.prepare(`DELETE FROM lxr_temp_voice_handoff WHERE ${exactAttempt}`);
  const markOpened=db.prepare(`UPDATE lxr_temp_voice SET opened=1 WHERE handoff_owner_id=? AND session_id=? AND id=? AND marker=?`);
  const moveIntent=({handoffOwnerId,sessionId,id,marker,moveAt,moveAttempt})=>[handoffOwnerId,sessionId,id,marker,moveAt,moveAttempt];
  const finishPanel=db.prepare('UPDATE lxr_temp_voice SET panel_ready=1 WHERE id=?');
  const drop=db.prepare('DELETE FROM lxr_temp_voice WHERE id=?');
  const dropPending=db.prepare('DELETE FROM lxr_temp_voice WHERE owner_id=? AND marker=? AND id IS NULL');
  const getCapacity=db.prepare(`SELECT prior_limit AS priorLimit,phase,revision
    FROM lxr_temp_voice_capacity_lock WHERE room_id=?`);
  const insertCapacity=db.prepare(`INSERT OR IGNORE INTO lxr_temp_voice_capacity_lock(room_id,prior_limit,phase,revision)
    SELECT id,?,?,? FROM lxr_temp_voice WHERE id=? AND owner_id=? AND lock_generation=?`);
  const updateCapacity=db.prepare(`UPDATE lxr_temp_voice_capacity_lock SET prior_limit=?,phase=?,revision=?
    WHERE room_id=? AND revision=? AND EXISTS(SELECT 1 FROM lxr_temp_voice WHERE id=? AND owner_id=? AND lock_generation=?)`);
  const dropCapacity=db.prepare(`DELETE FROM lxr_temp_voice_capacity_lock WHERE room_id=? AND revision=?
    AND EXISTS(SELECT 1 FROM lxr_temp_voice WHERE id=? AND owner_id=? AND lock_generation=?)`);
  const bumpGeneration=db.prepare('UPDATE lxr_temp_voice SET lock_generation=? WHERE id=?');
  function hydrate(row) {
    return row ? {id:row.id,ownerId:row.owner_id,waitingId:row.waiting_id,waitingMarker:row.waiting_marker,
      privacy:row.privacy,trusted:JSON.parse(row.trusted),blocked:JSON.parse(row.blocked),invited:JSON.parse(row.invited),
      marker:row.marker,sessionId:row.session_id,excludedIds:JSON.parse(row.excluded_ids),
      moveAt:row.attempt_at,handoffOwnerId:row.handoff_owner_id,moveAttempt:row.attempt_token,moveRetryAt:row.attempt_retry_at,
      opened:!!row.opened,panelReady:!!row.panel_ready,lockGeneration:row.lock_generation} : null;
  }
  const get=id=>isId(id)?hydrate(getRow.get(id)):null;
  return {
    get,
    reservePanelPublication(channelId,voice=false) {
      if(!isId(channelId)||typeof voice!=='boolean') throw new TypeError('Invalid temporary voice panel channel');
      const roomId=voice?channelId:null;
      return reservePanel.run(channelId,roomId,roomId,roomId).changes===1;
    },
    releasePanelPublication(channelId,voice=false) {
      if(!isId(channelId)||typeof voice!=='boolean') throw new TypeError('Invalid temporary voice panel channel');
      return releasePanel.run(channelId,voice?channelId:null).changes===1;
    },
    byOwner:ownerId=>isId(ownerId)?hydrate(ownerRow.get(ownerId)):null,
    byWaiting:waitingId=>isId(waitingId)?hydrate(waitingRow.get(waitingId)):null,
    getCapacityLock(roomId) { return isId(roomId)?getCapacity.get(roomId)??null:null; },
    replaceCapacityLock(roomId,ownerId,revision,next,expectedLockGeneration) {
      if (!isId(roomId)||!isId(ownerId)||typeof expectedLockGeneration!=='string'||!expectedLockGeneration||
        (revision!==null&&typeof revision!=='string')||
        (next===null ? revision===null : !capacityPhases.has(next?.phase)||!Number.isInteger(next.priorLimit)||
          next.priorLimit<0||next.priorLimit>99)) throw new TypeError('Invalid temporary voice capacity lock');
      return write(()=>{
        const lockGeneration=randomUUID();
        const condition=[roomId,ownerId,expectedLockGeneration];
        const result=next===null ? dropCapacity.run(roomId,revision,...condition) : revision===null ?
          insertCapacity.run(next.priorLimit,next.phase,lockGeneration,...condition) :
          updateCapacity.run(next.priorLimit,next.phase,lockGeneration,roomId,revision,...condition);
        if (result.changes!==1) return null;
        // The room retains the generation when the open state removes the journal.
        if (bumpGeneration.run(lockGeneration,roomId).changes!==1) throw new Error('Capacity lock room disappeared');
        return {lockGeneration,revision:next===null ? null : lockGeneration};
      });
    },
    list:()=>activeRows.all().map(hydrate),
    pending:()=>pendingRows.all().map(hydrate),
    hasUnsettledHandoff: (ownerId,sessionId)=>!!hasUnsettledHandoff.get(ownerId,sessionId),
    pendingMove(ownerId,sessionId) {
      const row=pendingHandoff.get(ownerId,sessionId);
      return row ? {id:row.room_id,handoffOwnerId:ownerId,sessionId,
        marker:row.marker,moveAt:row.move_at,moveAttempt:row.move_attempt} : null;
    },
    begin(ownerId,marker,sessionId,excludedIds) {
      if(!isId(ownerId)||!isMarker(marker)||typeof sessionId!=='string'||!sessionId||sessionId.length>256||
        !listIds(excludedIds)) throw new TypeError('Invalid voice reservation');
      return reserve.run(ownerId,marker,sessionId,JSON.stringify(excludedIds),ownerId,ownerId,sessionId).changes===1;
    },
    bind(ownerId,marker,roomId) {
      if(!isId(ownerId)||!isMarker(marker)||!isId(roomId)) throw new TypeError('Invalid voice mapping');
      return attach.run(roomId,ownerId,marker,roomId).changes===1?get(roomId):null;
    },
    cancel(ownerId,marker) {
      return isId(ownerId)&&isMarker(marker)&&dropPending.run(ownerId,marker).changes===1;
    },
    update(roomId,patch) {
      const current=get(roomId);
      if(!current) return null;
      if(!patch||Object.getPrototypeOf(patch)!==Object.prototype||Object.keys(patch).some(key=>!editable.has(key))) {
        throw new TypeError('Invalid temporary voice update');
      }
      const next={...current,...patch};
      if(!isId(next.ownerId)||(next.waitingId!==null&&!isId(next.waitingId))||
        (next.waitingMarker!==null&&!isMarker(next.waitingMarker))||!privacyModes.has(next.privacy)||
        ![next.trusted,next.blocked,next.invited].every(listIds)) throw new TypeError('Invalid temporary voice fields');
      const encode=values=>JSON.stringify([...new Set(values)]);
      // Control actions and lifecycle share one guild lock. The SQL uniqueness constraints are a second guard.
      const result=edit.run(next.ownerId,next.waitingId,next.waitingMarker,next.privacy,encode(next.trusted),
        encode(next.blocked),encode(next.invited),roomId,next.waitingId);
      if(result.changes!==1) throw new Error('Waiting channel already registered as a main room');
      return get(roomId);
    },
    beginMove(record,at) {
      return write(()=>{
        const {id,ownerId,sessionId,marker}=record;
        const moveAttempt=randomUUID();
        if(beginMove.run(at,moveAttempt,id,ownerId,sessionId,marker).changes!==1) return null;
        // The caller has just matched this lobby session in REST and the ready
        // gateway cache. Retain at most its fence; never expire by age or absence.
        dropOldHandoffs.run(ownerId,sessionId);
        return {...record,moveAt:at,moveAttempt,moveRetryAt:null};
      });
    },
    rejectMove: (record,retryAt)=>rejectMove.run(retryAt,...moveIntent(record)).changes===1,
    finishMove(record) {
      return write(()=>{
        const intent=moveIntent(record);
        if(consumeProof.run(...intent).changes!==1) return false;
        // If present, open only the exact room incarnation; neither a claim nor
        // deletion invalidates proof of the original owner's observed move.
        markOpened.run(...intent.slice(0,4));
        return true;
      });
    },
    finishPanel: roomId=>finishPanel.run(roomId),
    remove: roomId=>isId(roomId)&&drop.run(roomId).changes===1
  };
}

module.exports={openTempVoiceStore};
