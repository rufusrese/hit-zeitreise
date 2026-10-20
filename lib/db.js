import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'hit-zeitreise.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  spotify_client_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS catalogs (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = System-Katalog
  name TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  system_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_shares (
  catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (catalog_id, user_id)
);
-- songs.id ist zufällig und steht im QR-Code der Karten
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  spotify_uri TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS songs_catalog ON songs(catalog_id);
CREATE TABLE IF NOT EXISTS print_batches (
  id INTEGER PRIMARY KEY,
  catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheets INTEGER NOT NULL,
  color INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS print_items (
  batch_id INTEGER NOT NULL REFERENCES print_batches(id) ON DELETE CASCADE,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (batch_id, song_id)
);
CREATE INDEX IF NOT EXISTS print_items_song ON print_items(song_id);
`);

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function songId() {
  const b = randomBytes(12);
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Standard-Katalog (Top-5-Hits) beim ersten Start anlegen
export function seedDefaultCatalog(file) {
  if (db.prepare("SELECT 1 FROM catalogs WHERE system_key = 'top5-de'").get()) return;
  const songs = JSON.parse(readFileSync(file, 'utf8'));
  tx(() => {
    const now = Date.now();
    const { lastInsertRowid: cid } = db.prepare(
      "INSERT INTO catalogs (owner_id, name, is_public, system_key, created_at) VALUES (NULL, ?, 1, 'top5-de', ?)"
    ).run('Deutsche Top-5-Hits 1957–2026', now);
    const ins = db.prepare('INSERT INTO songs (id, catalog_id, year, artist, title, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [year, artist, title] of songs) ins.run(songId(), cid, year, artist, title, now);
  });
  console.log(`Standard-Katalog mit ${songs.length} Songs angelegt`);
}
