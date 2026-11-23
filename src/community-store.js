'use strict';

const { RuleError,catalog } = require('./ladder');

const defaults = {
  levels: false,
  welcomeChannel: '',
  ticketCategory: '',
  supportRole: catalog.roles.find(r=>r.name==='Ticket Support.' && !r.managed)?.id || ''
};

function openCommunityStore(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS community_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS staff_requests (id INTEGER PRIMARY KEY, delivery TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, expected TEXT, state TEXT NOT NULL DEFAULT 'pending', reviewer TEXT, decision TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS request_active ON staff_requests(owner,kind) WHERE state IN ('pending','processing')",
    "CREATE TABLE IF NOT EXISTS support_tickets (id INTEGER PRIMARY KEY, delivery TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, subject TEXT NOT NULL, state TEXT NOT NULL, channel TEXT UNIQUE, assignee TEXT, created INTEGER NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ticket_active ON support_tickets(owner) WHERE state IN ('opening','open','closing','reopening')",
    "CREATE TABLE IF NOT EXISTS moderation_cases (id INTEGER PRIMARY KEY, delivery TEXT NOT NULL UNIQUE, action TEXT NOT NULL, actor TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER, ref INTEGER)",
    "CREATE TABLE IF NOT EXISTS channel_locks (channel TEXT PRIMARY KEY, previous TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS server_xp (member TEXT PRIMARY KEY, xp INTEGER NOT NULL, last INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS moderation_target ON moderation_cases(target,id)"
  ].join(';\n'));
  const columns = new Set(db.prepare('PRAGMA table_info(support_tickets)').all().map(column=>column.name));
  if (!columns.has('kind')) db.exec("ALTER TABLE support_tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'");
  if (!columns.has('details')) db.exec("ALTER TABLE support_tickets ADD COLUMN details TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE TABLE IF NOT EXISTS support_ticket_guests (ticket INTEGER NOT NULL, member TEXT NOT NULL, PRIMARY KEY(ticket,member)); CREATE TABLE IF NOT EXISTS support_ticket_panel (id INTEGER PRIMARY KEY CHECK(id=1), message TEXT NOT NULL)');

  const request = id => db.prepare('SELECT * FROM staff_requests WHERE id=?').get(id);
  const ticket = id => db.prepare('SELECT * FROM support_tickets WHERE id=?').get(id);
  const fromEvent = id => db.prepare('SELECT * FROM moderation_cases WHERE delivery=?').get(id);
  function record(delivery, action, actor, target, reason, ref = null) {
    db.prepare('INSERT OR IGNORE INTO moderation_cases(delivery,action,actor,target,reason,created,ref) VALUES(?,?,?,?,?,?,?)')
      .run(delivery,action,actor,target,reason,Date.now(),ref);
    return fromEvent(delivery);
  }
  return {
    settings() {
      const saved = db.prepare('SELECT value FROM community_settings WHERE id=1').get();
      const settings={ ...defaults, ...(saved ? JSON.parse(saved.value) : {}) };
      settings.supportRole=catalog.roleAliases?.[settings.supportRole] || settings.supportRole;
      return settings;
    },
    saveSettings(value) {
      db.prepare('INSERT INTO community_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
    },
    request, ticket, fromEvent, record,
    submit(delivery, owner, kind, body, expected) {
      const replay = db.prepare('SELECT * FROM staff_requests WHERE delivery=?').get(delivery);
      if (replay) return replay;
      const now = Date.now();
      const id = db.prepare("INSERT OR IGNORE INTO staff_requests(delivery,owner,kind,body,expected,created,updated) VALUES(?,?,?,?,?,?,?)")
        .run(delivery,owner,kind,body,expected,now,now);
      if (!id.changes) throw new RuleError('عندك طلب مفتوح من نفس النوع. تابع حالته بأمر /request status.',409);
      return request(id.lastInsertRowid);
    },
    requests(owner) {
      if (owner) return db.prepare('SELECT * FROM staff_requests WHERE owner=? ORDER BY id DESC LIMIT 10').all(owner);
      return db.prepare("SELECT * FROM staff_requests ORDER BY CASE WHEN state IN ('pending','processing') THEN 0 ELSE 1 END, id DESC LIMIT 100").all();
    },
    review(id, state, reviewer, decision) {
      return db.prepare("UPDATE staff_requests SET state=?,reviewer=?,decision=?,updated=? WHERE id=? AND state='pending'").run(state,reviewer,decision,Date.now(),id).changes;
    },
    finishReview(id, state) {
      if (state==='pending') db.prepare("UPDATE staff_requests SET state='pending',reviewer=NULL,decision=NULL,updated=? WHERE id=? AND state='processing'").run(Date.now(),id);
      else db.prepare("UPDATE staff_requests SET state=?,updated=? WHERE id=? AND state='processing'").run(state,Date.now(),id);
    },
    cancel(id,owner) { return db.prepare("UPDATE staff_requests SET state='cancelled',updated=? WHERE id=? AND owner=? AND state='pending'").run(Date.now(),id,owner).changes; },
    processing() { return db.prepare("SELECT * FROM staff_requests WHERE state='processing'").all(); },
    panelMessage() { return db.prepare('SELECT message FROM support_ticket_panel WHERE id=1').get()?.message; },
    savePanelMessage(message) { db.prepare('INSERT INTO support_ticket_panel VALUES(1,?) ON CONFLICT(id) DO UPDATE SET message=excluded.message').run(message); },
    ticketGuests(ticketId) { return db.prepare('SELECT member FROM support_ticket_guests WHERE ticket=?').all(ticketId).map(row=>row.member); },
    rememberTicketGuest(ticketId,member) { db.prepare('INSERT OR IGNORE INTO support_ticket_guests VALUES(?,?)').run(ticketId,member); },
    forgetTicketGuest(ticketId,member) { db.prepare('DELETE FROM support_ticket_guests WHERE ticket=? AND member=?').run(ticketId,member); },
    reserveTicket(delivery,owner,subject,kind='legacy',details='') {
      const replay=db.prepare('SELECT * FROM support_tickets WHERE delivery=?').get(delivery);
      if (replay) return replay;
      const active=db.prepare("SELECT * FROM support_tickets WHERE owner=? AND state!='closed'").get(owner);
      if (active) return active;
      const result=db.prepare("INSERT INTO support_tickets(delivery,owner,subject,state,created,kind,details) VALUES(?,?,?,'opening',?,?,?)").run(delivery,owner,subject,Date.now(),kind,details);
      return ticket(result.lastInsertRowid);
    },
    setChannel(id, channel) {
      db.prepare("UPDATE support_tickets SET channel=?,state='open' WHERE id=? AND state='opening'").run(channel,id);
    },
    releaseOpening(id) { db.prepare("DELETE FROM support_tickets WHERE id=? AND state='opening'").run(id); },
    ticketByChannel(channel) { return db.prepare('SELECT * FROM support_tickets WHERE channel=?').get(channel); },
    ticketRemoved(channel) { db.prepare("UPDATE support_tickets SET state='closed',channel=NULL WHERE channel=?").run(channel); },
    activeTicket(owner) { return db.prepare("SELECT * FROM support_tickets WHERE owner=? AND state!='closed'").get(owner); },
    tickets() { return db.prepare("SELECT * FROM support_tickets ORDER BY CASE WHEN state='closed' THEN 1 ELSE 0 END, id DESC LIMIT 100").all(); },
    transitioningTickets() { return db.prepare("SELECT * FROM support_tickets WHERE state IN ('opening','closing','reopening')").all(); },
    ticketState(id,previous,next) {
      return db.prepare('UPDATE support_tickets SET state=? WHERE id=? AND state=?').run(next,id,previous).changes;
    },
    claim(id,actor,remove) {
      const sql=remove ? "UPDATE support_tickets SET assignee=NULL WHERE id=? AND assignee=? AND state='open'"
        : "UPDATE support_tickets SET assignee=? WHERE id=? AND (assignee IS NULL OR assignee=?) AND state='open'";
      return Boolean(remove ? db.prepare(sql).run(id,actor).changes : db.prepare(sql).run(actor,id,actor).changes);
    },
    cases(target) {
      return target ? db.prepare('SELECT * FROM moderation_cases WHERE target=? ORDER BY id DESC LIMIT 25').all(target)
        : db.prepare('SELECT * FROM moderation_cases ORDER BY id DESC LIMIT 75').all();
    },
    revoke(delivery,actor,target,id,reason) {
      const replay=fromEvent(delivery);
      if (replay) return replay;
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed=db.prepare("UPDATE moderation_cases SET revoked=? WHERE id=? AND target=? AND action='warn' AND revoked IS NULL").run(Date.now(),id,target);
        if (!changed.changes) throw new RuleError('رقم التحذير لا يطابق تحذيرًا نشطًا لهذا العضو.',409);
        const result=record(delivery,'unwarn',actor,target,reason,id);
        db.exec('COMMIT');
        return result;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    lock(channel) { return db.prepare('SELECT previous FROM channel_locks WHERE channel=?').get(channel); },
    rememberLock(channel, previous) { db.prepare('INSERT OR IGNORE INTO channel_locks VALUES(?,?)').run(channel,previous); },
    forgetLock(channel) { db.prepare('DELETE FROM channel_locks WHERE channel=?').run(channel); },
    addXp(member,now) {
      db.prepare('INSERT INTO server_xp VALUES(?,10,?) ON CONFLICT(member) DO UPDATE SET xp=xp+10,last=excluded.last WHERE excluded.last-last>=60000').run(member,now);
    },
    xp(member) { return db.prepare('SELECT xp FROM server_xp WHERE member=?').get(member)?.xp ?? 0; },
    top() { return db.prepare('SELECT member,xp FROM server_xp ORDER BY xp DESC,member LIMIT 10').all(); }
  };
}
module.exports = {openCommunityStore, defaults};
