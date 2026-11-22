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
  `);
  function hydrate(row) {
    return row ? { ...row, plan: JSON.parse(row.plan) } : null;
  }
  function byId(id) {
    return hydrate(db.prepare('SELECT * FROM promotions WHERE id=?').get(id));
  }
  function issue(kind, actor, duration) {
    db.prepare('DELETE FROM access WHERE until <= ?').run(Date.now());
    const code = randomBytes(kind === 'session' ? 32 : 12).toString('hex');
    db.prepare('INSERT INTO access VALUES (?,?,?,?)').run(digest(code), kind, actor, Date.now() + duration);
    return code;
  }
  return {
    codex: require('./codex-store').openCodexStore(db),
    community: openCommunityStore(db),
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
