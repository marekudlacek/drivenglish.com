-- DrivEnglish: uživatelé (trial/placení), kategorie, slovíčka
CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  first_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_until  TEXT,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  user_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_email, name)
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_email);

CREATE TABLE IF NOT EXISTS words (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  en           TEXT NOT NULL,
  cs           TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_words_category ON words(category_id);
