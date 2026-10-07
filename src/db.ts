import Database from 'better-sqlite3';

// Initialise the SQLite database, apply WAL mode, and create all tables.
// Calling this multiple times is safe (CREATE TABLE IF NOT EXISTS).
export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS requisition (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id      TEXT    UNIQUE NOT NULL,
      email_path      TEXT    NOT NULL,
      sender_name     TEXT,
      sender_email    TEXT,
      subject         TEXT,
      received_at     TEXT,
      status          TEXT    NOT NULL DEFAULT 'processing',
      extraction_json TEXT,
      resolution_json TEXT,
      draft_reply     TEXT,
      created_at      TEXT    DEFAULT (datetime('now')),
      updated_at      TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS llm_call (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id  INTEGER NOT NULL REFERENCES requisition(id),
      prompt_version  TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      input_sha256    TEXT    NOT NULL,
      output_text     TEXT,
      parse_error     TEXT,
      latency_ms      INTEGER,
      tokens_in       INTEGER,
      tokens_out      INTEGER,
      cost_chf        REAL,
      attempt         INTEGER DEFAULT 1,
      success         INTEGER DEFAULT 0,
      created_at      TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS review_item (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id  INTEGER NOT NULL REFERENCES requisition(id),
      code            TEXT    NOT NULL,
      queue           TEXT    NOT NULL,
      detail          TEXT,
      created_at      TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS po (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id    INTEGER NOT NULL REFERENCES requisition(id),
      po_number         TEXT    NOT NULL,
      supplier_id       TEXT,
      currency          TEXT,
      total_chf         REAL,
      idempotency_key   TEXT    NOT NULL,
      api_response_json TEXT,
      created_at        TEXT    DEFAULT (datetime('now'))
    );
  `);

  return db;
}
