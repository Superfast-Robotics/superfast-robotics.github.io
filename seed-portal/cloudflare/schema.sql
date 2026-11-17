-- Apply once with Wrangler D1 execute. Safe to apply again.
-- Keep the private R2 bucket separate from the static ASSETS binding.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
  access_expires_at INTEGER,
  download_allowed INTEGER NOT NULL DEFAULT 0 CHECK (download_allowed IN (0,1))
);
CREATE TABLE IF NOT EXISTS codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  claim_token TEXT
);
CREATE INDEX IF NOT EXISTS codes_email ON codes(email,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS codes_claim ON codes(claim_token) WHERE claim_token IS NOT NULL;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  visitor_id TEXT REFERENCES visitors(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('visitor','admin')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_visitor ON sessions(visitor_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  resets_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('html','pdf')),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  download_allowed INTEGER NOT NULL DEFAULT 0 CHECK (download_allowed IN (0,1)),
  files_json TEXT NOT NULL DEFAULT '[]',
  pdf_file TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_published_deck ON decks(status) WHERE status='published';
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id),
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  last_page INTEGER NOT NULL DEFAULT 1,
  seconds REAL NOT NULL DEFAULT 0,
  last_sequence INTEGER NOT NULL DEFAULT -1,
  last_event_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_visitor ON visits(visitor_id,started_at DESC);
CREATE INDEX IF NOT EXISTS visits_started ON visits(started_at);
CREATE INDEX IF NOT EXISTS visits_deck ON visits(deck_id);
CREATE TABLE IF NOT EXISTS page_views (
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (visit_id,page)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created ON audit(created_at);

-- A single conditional UPDATE of visits is the event's commit point.
-- The trigger updates aggregates only when the sequence advances, including
-- during concurrent requests; no separate read/modify/write race is possible.
CREATE TRIGGER IF NOT EXISTS account_view_event
AFTER UPDATE OF last_sequence ON visits
WHEN NEW.last_sequence > OLD.last_sequence
BEGIN
  INSERT INTO page_views(visit_id,page,seconds)
    VALUES(NEW.id,NEW.last_page,MAX(0,NEW.seconds-OLD.seconds))
    ON CONFLICT(visit_id,page) DO UPDATE SET seconds=seconds+excluded.seconds;
  UPDATE visitors SET last_seen_at=MAX(COALESCE(last_seen_at,0),NEW.last_at)
    WHERE id=NEW.visitor_id;
END;
