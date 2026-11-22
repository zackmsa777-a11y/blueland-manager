'use strict';

function openCodexStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_settings (id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL, effort TEXT NOT NULL);
    INSERT OR IGNORE INTO codex_settings VALUES(1,'gpt-6.2-sol','high');
    CREATE TABLE IF NOT EXISTS codex_commands (name TEXT PRIMARY KEY, instruction TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS codex_deliveries (id TEXT PRIMARY KEY, actor TEXT NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS codex_confirmations (message TEXT PRIMARY KEY, actor TEXT NOT NULL, channel TEXT NOT NULL, expires INTEGER NOT NULL, actions TEXT NOT NULL);
  `);
  return {
    settings: () => db.prepare('SELECT model,effort FROM codex_settings WHERE id=1').get(),
    configure: (model, effort) => db.prepare('UPDATE codex_settings SET model=?,effort=? WHERE id=1').run(model,effort),
    feature: name => db.prepare('SELECT instruction FROM codex_commands WHERE name=?').get(name)?.instruction,
    features: () => db.prepare('SELECT name FROM codex_commands ORDER BY name').all().map(row=>row.name),
    save: (name, instruction) => db.prepare('INSERT INTO codex_commands VALUES(?,?) ON CONFLICT(name) DO UPDATE SET instruction=excluded.instruction').run(name,instruction),
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
