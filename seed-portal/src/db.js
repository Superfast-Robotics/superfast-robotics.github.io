import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'portal.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      last_seen_at INTEGER, blocked INTEGER NOT NULL DEFAULT 0,
      access_expires_at INTEGER, download_allowed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS codes (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS codes_email ON codes(email, created_at DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, visitor_id TEXT REFERENCES visitors(id) ON DELETE CASCADE,
      role TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, version TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, page_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
      published_at INTEGER, status TEXT NOT NULL DEFAULT 'draft',
      download_allowed INTEGER NOT NULL DEFAULT 0, files_json TEXT NOT NULL DEFAULT '[]',
      pdf_file TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_published_deck ON decks(status) WHERE status = 'published';
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
      deck_id TEXT NOT NULL REFERENCES decks(id), started_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL, last_page INTEGER NOT NULL DEFAULT 1,
      seconds REAL NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT -1,
      last_event_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visits_visitor ON visits(visitor_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS visits_started ON visits(started_at);
    CREATE TABLE IF NOT EXISTS page_views (
      visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
      page INTEGER NOT NULL, seconds REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (visit_id, page)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT, created_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  return db;
}

export function prune(db, now, retentionDays) {
  const cutoff = now - retentionDays * 86400000;
  db.transaction(() => {
    db.prepare('DELETE FROM codes WHERE expires_at < ? OR used_at < ?').run(now, now - 86400000);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM rate_limits WHERE resets_at < ?').run(now);
    db.prepare('DELETE FROM visits WHERE last_at < ?').run(cutoff);
    // Preserve explicit access restrictions; retention must never unblock an address.
    db.prepare('DELETE FROM visitors WHERE blocked=0 AND access_expires_at IS NULL AND COALESCE(last_seen_at,created_at) < ?').run(cutoff);
    db.prepare('DELETE FROM audit WHERE created_at < ?').run(cutoff);
  })();
}
