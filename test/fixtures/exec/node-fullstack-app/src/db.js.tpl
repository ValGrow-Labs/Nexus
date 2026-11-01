'use strict';
// The one database: a SQLite file inside the safe space (./data/app.db), created and migrated when the app starts.
const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('node-sqlite3-wasm');
const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'app.db'));
db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)');
module.exports = {
  all: () => db.all('SELECT id, text, created_at FROM notes ORDER BY id'),
  add: (text) => { db.run('INSERT INTO notes (text, created_at) VALUES (?, ?)', [text, new Date().toISOString()]); },
  ping: () => db.get('SELECT 1 AS ok').ok === 1
};
