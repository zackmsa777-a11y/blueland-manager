'use strict';
const {RuleError}=require('./ladder');

function openCodexStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_settings (id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL, effort TEXT NOT NULL);
    INSERT OR IGNORE INTO codex_settings VALUES(1,'gpt-6.2-sol','high');
    CREATE TABLE IF NOT EXISTS codex_commands (name TEXT PRIMARY KEY, instruction TEXT NOT NULL, source TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS codex_notes (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, note TEXT NOT NULL, UNIQUE(actor,note));
    CREATE TABLE IF NOT EXISTS codex_deliveries (id TEXT PRIMARY KEY, actor TEXT NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS codex_confirmations (message TEXT PRIMARY KEY, actor TEXT NOT NULL, channel TEXT NOT NULL, expires INTEGER NOT NULL, actions TEXT NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(codex_commands)').all().some(c=>c.name==='source'))
    db.exec("ALTER TABLE codex_commands ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  return {
    notes: actor=>db.prepare('SELECT id,note FROM codex_notes WHERE actor=? ORDER BY id').all(actor),
    note(actor,note) {
      note=String(note).trim();
      if (!note||note.length>600) throw new RuleError('اختر ملاحظة بين ١ و٦٠٠ حرف.');
      const old=db.prepare('SELECT id FROM codex_notes WHERE actor=? AND note=?').get(actor,note);
      if (old) return old.id;
      if (this.notes(actor).length>=32) throw new RuleError('الذاكرة ممتلئة. احذف ملاحظة قديمة.');
      return Number(db.prepare('INSERT INTO codex_notes(actor,note) VALUES(?,?)').run(actor,note).lastInsertRowid);
    },
    forgetNote: (actor,id)=>db.prepare('DELETE FROM codex_notes WHERE actor=? AND id=?').run(actor,id).changes,
    settings: () => db.prepare('SELECT model,effort FROM codex_settings WHERE id=1').get(),
    configure: (model, effort) => db.prepare('UPDATE codex_settings SET model=?,effort=? WHERE id=1').run(model,effort),
    feature: name => db.prepare('SELECT instruction FROM codex_commands WHERE name=?').get(name)?.instruction,
    source: name => db.prepare('SELECT source FROM codex_commands WHERE name=?').get(name)?.source,
    features: () => db.prepare('SELECT name FROM codex_commands ORDER BY name').all().map(row=>row.name),
    save: (name, instruction, source='') => db.prepare('INSERT INTO codex_commands(name,instruction,source) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET instruction=excluded.instruction,source=excluded.source').run(name,instruction,source),
    remove: name => db.prepare('DELETE FROM codex_commands WHERE name=?').run(name).changes,
    begin(id,actor) {
      db.prepare('DELETE FROM codex_confirmations WHERE expires<=?').run(Date.now());
      return db.prepare("INSERT OR IGNORE INTO codex_deliveries VALUES(?,?,?,'started')").run(id,actor,Date.now()).changes===1;
    },
    finish: (id,status) => db.prepare('UPDATE codex_deliveries SET status=? WHERE id=?').run(status,id),
    remember(message,actor,channel,actions) {
      db.prepare('INSERT INTO codex_confirmations VALUES(?,?,?,?,?)').run(message,actor,channel,Date.now()+300000,JSON.stringify(actions));
    },
    consume(message,actor,channel) {
      const row=db.prepare('DELETE FROM codex_confirmations WHERE message=? AND actor=? AND channel=? AND expires>? RETURNING actions').get(message,actor,channel,Date.now());
      return row ? JSON.parse(row.actions) : null;
    }
  };
}
module.exports={openCodexStore};
