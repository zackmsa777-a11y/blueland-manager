'use strict';

const { DatabaseSync } = require('node:sqlite');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { RuleError } = require('./ladder');
const { openCommunityStore } = require('./community-store');
const digest = value => createHash('sha256').update(value).digest('hex');

function openStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS promotions (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL, actorName TEXT NOT NULL,
      targetName TEXT NOT NULL, source TEXT NOT NULL, plan TEXT NOT NULL, state TEXT NOT NULL,
      created INTEGER NOT NULL, finished INTEGER, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_per_member ON promotions(target) WHERE state='pending';
    CREATE TABLE IF NOT EXISTS access (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lxr_application_delivery (
      user_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('staff','girls','transfer'))
    );
    CREATE TABLE IF NOT EXISTS accept_member_outbox (
      target TEXT PRIMARY KEY, channel TEXT NOT NULL, reference TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0, attempted INTEGER, posted TEXT,
      dead_reference INTEGER NOT NULL DEFAULT 0
    );
  `);
  if (!db.prepare('PRAGMA table_info(accept_member_outbox)').all().some(column=>column.name==='dead_reference')) {
    // Older builds cleared timestamps for unclassified 4xx responses. Treat those as receipt-only.
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE accept_member_outbox ADD COLUMN dead_reference INTEGER NOT NULL DEFAULT 0;
      UPDATE accept_member_outbox SET attempted=0 WHERE confirmed=1 AND attempted IS NULL AND posted IS NULL;
      COMMIT;`);
  }
  function hydrate(row) {
    return row ? { ...row, plan: JSON.parse(row.plan) } : null;
  }
  function byId(id) {
    return hydrate(db.prepare('SELECT * FROM promotions WHERE id=?').get(id));
  }
  const acceptanceByTarget=target=>db.prepare('SELECT * FROM accept_member_outbox WHERE target=?').get(target);
  function issue(kind, actor, duration) {
    db.prepare('DELETE FROM access WHERE until <= ?').run(Date.now());
    const code = randomBytes(kind === 'session' ? 32 : 12).toString('hex');
    db.prepare('INSERT INTO access VALUES (?,?,?,?)').run(digest(code), kind, actor, Date.now() + duration);
    return code;
  }
  return {
    applications:{
      find(userId) {
        return db.prepare('SELECT request_id AS id,user_id AS userId,kind FROM lxr_application_delivery WHERE user_id=?').get(userId);
      },
      claim({id,userId,kind}) {
        return db.prepare('INSERT OR IGNORE INTO lxr_application_delivery(user_id,request_id,kind) VALUES(?,?,?)').run(userId,id,kind).changes===1;
      },
      clear({id,userId,kind}) {
        return db.prepare('DELETE FROM lxr_application_delivery WHERE user_id=? AND request_id=? AND kind=?').run(userId,id,kind).changes===1;
      }
    },
    acceptance:{
      byTarget:acceptanceByTarget,
      begin(target,channel,reference) {
        db.prepare('INSERT OR IGNORE INTO accept_member_outbox (target,channel,reference) VALUES (?,?,?)').run(target,channel,reference);
        return acceptanceByTarget(target);
      },
      markAttempt(target,reference,attempted) {
        db.prepare('UPDATE accept_member_outbox SET confirmed=1, attempted=COALESCE(attempted,?) WHERE target=? AND reference=? AND dead_reference=0')
          .run(attempted,target,reference);
      },
      rejectAttempt(target,reference,attempted,dead) {
        db.prepare(`UPDATE accept_member_outbox SET attempted=NULL, dead_reference=?
          WHERE target=? AND reference=? AND attempted=? AND posted IS NULL AND dead_reference=0`)
          .run(Number(dead),target,reference,attempted);
      },
      rebind(target,previous,channel,reference) {
        return db.prepare(`UPDATE accept_member_outbox SET channel=?, reference=?, dead_reference=0
          WHERE target=? AND reference=? AND confirmed=1 AND attempted IS NULL AND posted IS NULL AND dead_reference=1
          RETURNING *`).get(channel,reference,target,previous);
      },
      markPosted(target,reference,posted) {
        db.prepare('UPDATE accept_member_outbox SET posted=? WHERE target=? AND reference=?').run(posted,target,reference);
      },
      complete(target,reference) {
        db.prepare('DELETE FROM accept_member_outbox WHERE target=? AND reference=?').run(target,reference);
      }
    },
    community: openCommunityStore(db),
    shortcuts: require('./custom-shortcuts').openShortcuts(db),
    roulette: require('./roulette-shop').openRouletteShop(db),
    byId,
    pending(target) {
      return hydrate(db.prepare("SELECT * FROM promotions WHERE target=? AND state='pending'").get(target));
    },
    unfinished() {
      return db.prepare("SELECT * FROM promotions WHERE state='pending' ORDER BY created").all().map(hydrate);
    },
    begin(id, actor, target, source, plan) {
      try {
        db.prepare("INSERT INTO promotions (id,actor,target,actorName,targetName,source,plan,state,created) VALUES (?,?,?,?,?,?,?,'pending',?)")
          .run(id, actor.id, target.id, actor.name, target.name, source, JSON.stringify(plan), Date.now());
      } catch (err) {
        if (this.pending(target.id) || byId(id)) throw new RuleError('توجد عملية ترقية لهذا العضو. حدّث السجل.', 409);
        throw err;
      }
      return byId(id);
    },
    finish(id) {
      db.prepare("UPDATE promotions SET state='done', finished=?, detail='' WHERE id=? AND state='pending'").run(Date.now(), id);
      return byId(id);
    },
    note(id, detail) {
      db.prepare("UPDATE promotions SET detail=? WHERE id=? AND state='pending'").run(detail, id);
    },
    history() {
      return db.prepare('SELECT * FROM promotions ORDER BY created DESC LIMIT 100').all().map(hydrate);
    },
    loginCode(actor) {
      db.prepare("DELETE FROM access WHERE actor=? AND kind='code'").run(actor);
      return issue('code', actor, 5 * 60_000);
    },
    redeem(code) {
      const row = db.prepare("DELETE FROM access WHERE hash=? AND kind='code' AND until>? RETURNING actor")
        .get(digest(code), Date.now());
      if (!row) throw new RuleError('رمز الدخول غير صالح أو انتهت مدته. اطلب رمزًا جديدًا بأمر +لوحة.', 401);
      return issue('session', row.actor, 8 * 3_600_000);
    },
    actor(session) {
      if (!session) return null;
      return db.prepare("SELECT actor FROM access WHERE hash=? AND kind='session' AND until>?").get(digest(session), Date.now())?.actor ?? null;
    },
    logout(session) { db.prepare('DELETE FROM access WHERE hash=?').run(digest(session)); },
    close() { db.close(); }
  };
}

module.exports = { openStore };
