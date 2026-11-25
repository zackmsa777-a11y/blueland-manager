'use strict';

const {ladder,roles} = require('./ladder');

const thresholds = Object.freeze({'new-staff':15, mod:25, owners:35, admins:65});

function staffGrade(ids) {
  const held = new Set(ids);
  return ladder.findLast(step => held.has(step.id) ||
    (step.id === step.group.base && held.has(step.group.variant)));
}

function progress(db,member,grade,ownerId) {
  const balance = db.ticketBalance(member);
  const threshold = member !== ownerId && thresholds[grade?.group.id] || null;
  return {...balance, group:grade?.group.name || null, grade:roles.get(grade?.id)?.label || null,
    next:threshold ? roles.get(ladder[grade.index+1].id).label : null, threshold,
    remaining:threshold ? Math.max(0,threshold-balance.available) : null};
}

function openTicketPoints(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_points (
      ticket INTEGER PRIMARY KEY, member TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS ticket_points_member ON ticket_points(member);
    CREATE TABLE IF NOT EXISTS ticket_advancements (
      id INTEGER PRIMARY KEY, member TEXT NOT NULL, grade TEXT NOT NULL, cost INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_ticket_advancement ON ticket_advancements(member) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS ticket_advancement_balance ON ticket_advancements(member,state);
    CREATE TABLE IF NOT EXISTS ticket_claim_changes (
      ticket INTEGER PRIMARY KEY, member TEXT NOT NULL, grade TEXT, restoring INTEGER NOT NULL DEFAULT 0,
      synced INTEGER NOT NULL DEFAULT 0, overwrites TEXT
    );
    INSERT OR IGNORE INTO ticket_points(ticket,member,amount)
      SELECT id,assignee,0 FROM support_tickets WHERE assignee IS NOT NULL;
    INSERT OR IGNORE INTO ticket_claim_changes(ticket,member,synced)
      SELECT id,assignee,0 FROM support_tickets WHERE assignee IS NOT NULL AND channel IS NOT NULL;
  `);
  const claimColumns=new Set(db.prepare('PRAGMA table_info(ticket_claim_changes)').all().map(column=>column.name));
  if (!claimColumns.has('notice_nonce')) db.exec('ALTER TABLE ticket_claim_changes ADD COLUMN notice_nonce TEXT');
  if (!claimColumns.has('notice_attempted')) db.exec('ALTER TABLE ticket_claim_changes ADD COLUMN notice_attempted INTEGER');
  function ticketBalance(member) {
    const {total,spent} = db.prepare(`
      SELECT (SELECT COALESCE(SUM(amount),0) FROM ticket_points WHERE member=?) AS total,
             (SELECT COALESCE(SUM(cost),0) FROM ticket_advancements WHERE member=? AND state='done') AS spent
    `).get(member,member);
    return {total,available:total-spent};
  }
  function queueAdvancement(member,grade) {
    const cost = thresholds[grade?.group.id];
    if (cost && ticketBalance(member).available >= cost) {
      db.prepare('INSERT OR IGNORE INTO ticket_advancements(member,grade,cost) VALUES(?,?,?)').run(member,grade.id,cost);
    }
  }
  function finishClaim(change) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const grade = ladder.find(step=>step.id===change.grade);
      if (change.restoring) {
        db.prepare('UPDATE support_tickets SET assignee=NULL WHERE id=?').run(change.ticket);
        db.prepare('DELETE FROM ticket_claim_changes WHERE ticket=?').run(change.ticket);
      } else {
        db.prepare('UPDATE support_tickets SET assignee=? WHERE id=?').run(change.member,change.ticket);
        const amount=thresholds[grade?.group.id] ? 1 : 0;
        const first=db.prepare('INSERT OR IGNORE INTO ticket_points VALUES(?,?,?)').run(change.ticket,change.member,amount);
        if (first.changes && amount) queueAdvancement(change.member,grade);
        db.prepare('UPDATE ticket_claim_changes SET synced=1 WHERE ticket=?').run(change.ticket);
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  return {ticketBalance,queueAdvancement,finishClaim,
    claimChange:id=>db.prepare('SELECT * FROM ticket_claim_changes WHERE ticket=?').get(id),
    startClaim:(id,member,grade,nonce=null)=>db.prepare('INSERT INTO ticket_claim_changes(ticket,member,grade,notice_nonce) VALUES(?,?,?,?)').run(id,member,grade,nonce),
    startClaimNotice:(id,nonce)=>db.prepare('UPDATE ticket_claim_changes SET notice_attempted=? WHERE ticket=? AND notice_nonce=? AND notice_attempted IS NULL').run(Date.now(),id,nonce),
    finishClaimNotice:(id,nonce)=>db.prepare('UPDATE ticket_claim_changes SET notice_nonce=NULL,notice_attempted=NULL WHERE ticket=? AND notice_nonce=?').run(id,nonce),
    undoClaim:id=>db.prepare('UPDATE ticket_claim_changes SET synced=0,restoring=1,notice_nonce=NULL,notice_attempted=NULL WHERE ticket=?').run(id),
    resyncClaim:id=>db.prepare('UPDATE ticket_claim_changes SET synced=0 WHERE ticket=?').run(id),
    saveClaimOverwrites:(id,plan)=>db.prepare('UPDATE ticket_claim_changes SET overwrites=? WHERE ticket=?').run(JSON.stringify(plan),id),
    pendingClaims:()=>db.prepare("SELECT s.* FROM support_tickets s JOIN ticket_claim_changes c ON c.ticket=s.id WHERE c.synced=0 AND s.state='open' AND s.channel IS NOT NULL").all(),
    pendingAdvancements:()=>db.prepare("SELECT * FROM ticket_advancements WHERE state='pending' ORDER BY id").all(),
    advancementFor:member=>db.prepare("SELECT * FROM ticket_advancements WHERE member=? AND state='pending'").get(member),
    endAdvancement:(id,state)=>db.prepare("UPDATE ticket_advancements SET state=? WHERE id=? AND state='pending'").run(state,id)
  };
}
module.exports = {thresholds,staffGrade,progress,openTicketPoints};
