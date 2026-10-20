import express from 'express';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { db, tx, songId, getSetting, setSetting, seedDefaultCatalog } from './lib/db.js';
import { renderCardsPdf, PER_SHEET } from './lib/print.js';

const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://hit-zeitreise.duckdns.org').replace(/\/$/, '');
const SESSION_DAYS = 90;
const MAX_SONGS_PER_CATALOG = 20000;

seedDefaultCatalog(path.resolve('seed/top5.json'));
if (process.env.SPOTIFY_CLIENT_ID && !getSetting('default_client_id')) setSetting('default_client_id', process.env.SPOTIFY_CLIENT_ID);

const app = express();
app.set('trust proxy', 'loopback, uniquelocal');
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

// ---------- Helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };

function hashPassword(pw) {
  const salt = randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const h = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `hz_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

function createSession(req, res, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_DAYS * 864e5);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

// Session laden
app.use((req, res, next) => {
  const token = parseCookies(req).hz_session;
  if (token) {
    const row = db.prepare(
      'SELECT u.id, u.username, u.is_admin, u.spotify_client_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
    ).get(token, Date.now());
    if (row) { req.user = row; req.sessionToken = token; }
  }
  next();
});

// Einfacher CSRF-Schutz: schreibende API-Aufrufe brauchen JSON bzw. den eigenen Header
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-HZ') !== '1') return res.status(403).json({ error: 'Ungültige Anfrage' });
  next();
});

const auth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Bitte anmelden' }));

// Login-Bremse gegen Durchprobieren von Passwörtern
const attempts = new Map();
function throttle(key) {
  const now = Date.now(), a = attempts.get(key) || { n: 0, t: now };
  if (now - a.t > 15 * 60e3) { a.n = 0; a.t = now; }
  a.n++; attempts.set(key, a);
  if (a.n > 20) fail(429, 'Zu viele Versuche. Bitte in 15 Minuten erneut probieren.');
}

// ---------- Access ----------
function catalogFor(req, id, { write = false } = {}) {
  const c = db.prepare('SELECT * FROM catalogs WHERE id = ?').get(+id);
  if (!c) fail(404, 'Katalog nicht gefunden');
  const isOwner = c.owner_id === req.user.id;
  const canRead = isOwner || c.is_public ||
    db.prepare('SELECT 1 FROM catalog_shares WHERE catalog_id = ? AND user_id = ?').get(c.id, req.user.id);
  if (!canRead) fail(404, 'Katalog nicht gefunden');
  const canWrite = isOwner || (c.owner_id === null && req.user.is_admin);
  if (write && !canWrite) fail(403, 'Nur der Besitzer kann diesen Katalog bearbeiten');
  return { ...c, isOwner, canWrite };
}

function songFor(req, id, opts) {
  const s = db.prepare('SELECT * FROM songs WHERE id = ?').get(String(id));
  if (!s) fail(404, 'Song nicht gefunden');
  const c = catalogFor(req, s.catalog_id, opts);
  return { song: s, catalog: c };
}

const SPOTIFY_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
function cleanSong(s) {
  const year = parseInt(s.year, 10);
  const artist = String(s.artist ?? '').trim().slice(0, 300);
  const title = String(s.title ?? '').trim().slice(0, 300);
  let uri = s.spotify_uri ? String(s.spotify_uri).trim() : null;
  const m = uri && uri.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})/);
  if (m) uri = 'spotify:track:' + m[1];
  if (uri && !SPOTIFY_URI.test(uri)) uri = null;
  if (!artist || !title) fail(400, 'Titel und Interpret dürfen nicht leer sein');
  if (!(year >= 1000 && year <= 2100)) fail(400, `Ungültiges Jahr bei „${title}“`);
  return { year, artist, title, spotify_uri: uri };
}

// ---------- Auth ----------
app.get('/api/config', (req, res) => {
  res.json({ defaultClientId: getSetting('default_client_id') || '', publicUrl: PUBLIC_URL });
});

app.post('/api/register', wrap((req, res) => {
  throttle('reg:' + req.ip);
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_.\-äöüÄÖÜß]{3,32}$/.test(username)) fail(400, 'Benutzername: 3–32 Zeichen (Buchstaben, Zahlen, _ . -)');
  if (password.length < 8) fail(400, 'Passwort muss mindestens 8 Zeichen haben');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'Benutzername ist schon vergeben');
  const isFirst = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), isFirst ? 1 : 0, Date.now());
  createSession(req, res, Number(lastInsertRowid));
  res.json({ ok: true });
}));

app.post('/api/login', wrap((req, res) => {
  const username = String(req.body.username || '').trim();
  throttle('login:' + req.ip);
  throttle('user:' + username.toLowerCase());
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !checkPassword(String(req.body.password || ''), u.pw_hash)) fail(401, 'Benutzername oder Passwort falsch');
  createSession(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const { id, username, is_admin, spotify_client_id } = req.user;
  res.json({ id, username, isAdmin: !!is_admin, spotifyClientId: spotify_client_id || '', defaultClientId: getSetting('default_client_id') || '' });
});

app.put('/api/me', auth, wrap((req, res) => {
  const b = req.body;
  if ('spotifyClientId' in b) {
    const cid = String(b.spotifyClientId || '').trim();
    if (cid && !/^[a-f0-9]{32}$/i.test(cid)) fail(400, 'Die Client ID besteht aus 32 Zeichen (0–9, a–f)');
    db.prepare('UPDATE users SET spotify_client_id = ? WHERE id = ?').run(cid || null, req.user.id);
  }
  if ('defaultClientId' in b) {
    if (!req.user.is_admin) fail(403, 'Nur für Admins');
    const cid = String(b.defaultClientId || '').trim();
    if (cid && !/^[a-f0-9]{32}$/i.test(cid)) fail(400, 'Die Client ID besteht aus 32 Zeichen (0–9, a–f)');
    setSetting('default_client_id', cid);
  }
  if (b.newPassword) {
    const u = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(req.user.id);
    if (!checkPassword(String(b.oldPassword || ''), u.pw_hash)) fail(400, 'Altes Passwort ist falsch');
    if (String(b.newPassword).length < 8) fail(400, 'Passwort muss mindestens 8 Zeichen haben');
    db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(String(b.newPassword)), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
  }
  res.json({ ok: true });
}));

// ---------- Kataloge ----------
app.get('/api/catalogs', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.owner_id, c.is_public, c.system_key, u.username AS owner,
      (SELECT COUNT(*) FROM songs s WHERE s.catalog_id = c.id) AS song_count,
      (SELECT COUNT(DISTINCT pi.song_id) FROM print_items pi JOIN print_batches pb ON pb.id = pi.batch_id
         WHERE pb.catalog_id = c.id AND pb.user_id = :me) AS printed_count,
      (SELECT COUNT(*) FROM catalog_shares cs WHERE cs.catalog_id = c.id) AS share_count
    FROM catalogs c LEFT JOIN users u ON u.id = c.owner_id
    WHERE c.owner_id = :me OR c.is_public = 1
       OR EXISTS (SELECT 1 FROM catalog_shares cs WHERE cs.catalog_id = c.id AND cs.user_id = :me)
    ORDER BY c.system_key IS NULL, c.name COLLATE NOCASE
  `).all({ me: req.user.id });
  res.json(rows.map((c) => ({
    id: c.id, name: c.name, owner: c.owner || 'System', isOwner: c.owner_id === req.user.id,
    canWrite: c.owner_id === req.user.id || (c.owner_id === null && !!req.user.is_admin),
    isPublic: !!c.is_public, isSystem: !!c.system_key,
    songCount: c.song_count, printedCount: c.printed_count, shareCount: c.share_count,
  })));
});

app.post('/api/catalogs', auth, wrap((req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!name) fail(400, 'Bitte einen Namen angeben');
  const { lastInsertRowid } = db.prepare('INSERT INTO catalogs (owner_id, name, created_at) VALUES (?, ?, ?)').run(req.user.id, name, Date.now());
  res.json({ id: Number(lastInsertRowid) });
}));

app.get('/api/catalogs/:id', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id);
  const songs = db.prepare(`
    SELECT s.id, s.year, s.artist, s.title, s.spotify_uri,
      EXISTS (SELECT 1 FROM print_items pi JOIN print_batches pb ON pb.id = pi.batch_id
              WHERE pi.song_id = s.id AND pb.user_id = ?) AS printed
    FROM songs s WHERE s.catalog_id = ? ORDER BY s.year, s.artist COLLATE NOCASE, s.title COLLATE NOCASE
  `).all(req.user.id, c.id);
  const owner = c.owner_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(c.owner_id).username : 'System';
  res.json({
    id: c.id, name: c.name, owner, isOwner: c.isOwner, canWrite: c.canWrite, isPublic: !!c.is_public, isSystem: !!c.system_key,
    songs: songs.map((s) => ({ id: s.id, year: s.year, artist: s.artist, title: s.title, uri: s.spotify_uri, printed: !!s.printed })),
  });
}));

app.put('/api/catalogs/:id', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id, { write: true });
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!name) fail(400, 'Bitte einen Namen angeben');
  db.prepare('UPDATE catalogs SET name = ? WHERE id = ?').run(name, c.id);
  res.json({ ok: true });
}));

app.delete('/api/catalogs/:id', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id, { write: true });
  if (c.system_key) fail(400, 'Der Standard-Katalog kann nicht gelöscht werden');
  db.prepare('DELETE FROM catalogs WHERE id = ?').run(c.id);
  res.json({ ok: true });
}));

// Katalog kopieren (z. B. um den Standard-Katalog anzupassen)
app.post('/api/catalogs/:id/copy', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id);
  const name = String(req.body.name || `${c.name} (Kopie)`).trim().slice(0, 100);
  const id = tx(() => {
    const now = Date.now();
    const { lastInsertRowid } = db.prepare('INSERT INTO catalogs (owner_id, name, created_at) VALUES (?, ?, ?)').run(req.user.id, name, now);
    const ins = db.prepare('INSERT INTO songs (id, catalog_id, year, artist, title, spotify_uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const s of db.prepare('SELECT * FROM songs WHERE catalog_id = ?').all(c.id)) ins.run(songId(), lastInsertRowid, s.year, s.artist, s.title, s.spotify_uri, now);
    return Number(lastInsertRowid);
  });
  res.json({ id });
}));

app.post('/api/catalogs/:id/songs', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id, { write: true });
  const list = Array.isArray(req.body.songs) ? req.body.songs : [req.body];
  const clean = list.map(cleanSong);
  const count = db.prepare('SELECT COUNT(*) AS n FROM songs WHERE catalog_id = ?').get(c.id).n;
  if (count + clean.length > MAX_SONGS_PER_CATALOG) fail(400, `Maximal ${MAX_SONGS_PER_CATALOG} Songs pro Katalog`);
  const ids = tx(() => {
    const now = Date.now();
    const ins = db.prepare('INSERT INTO songs (id, catalog_id, year, artist, title, spotify_uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    return clean.map((s) => { const id = songId(); ins.run(id, c.id, s.year, s.artist, s.title, s.spotify_uri, now); return id; });
  });
  res.json({ ids });
}));

app.put('/api/songs/:id', auth, wrap((req, res) => {
  const { song } = songFor(req, req.params.id, { write: true });
  const s = cleanSong({ ...song, ...req.body });
  db.prepare('UPDATE songs SET year = ?, artist = ?, title = ?, spotify_uri = ? WHERE id = ?').run(s.year, s.artist, s.title, s.spotify_uri, song.id);
  res.json({ ok: true });
}));

app.delete('/api/songs/:id', auth, wrap((req, res) => {
  const { song } = songFor(req, req.params.id, { write: true });
  db.prepare('DELETE FROM songs WHERE id = ?').run(song.id);
  res.json({ ok: true });
}));

// Gefundenen Spotify-Track merken (jeder Leser darf eine Lücke füllen, Besitzer darf überschreiben)
app.put('/api/songs/:id/spotify', auth, wrap((req, res) => {
  const { song, catalog } = songFor(req, req.params.id);
  const uri = String(req.body.uri || '');
  if (!SPOTIFY_URI.test(uri)) fail(400, 'Ungültige Spotify-URI');
  if (song.spotify_uri && !catalog.canWrite) return res.json({ ok: true, kept: song.spotify_uri });
  db.prepare('UPDATE songs SET spotify_uri = ? WHERE id = ?').run(uri, song.id);
  res.json({ ok: true });
}));

// Karte per QR-Code: wer den Code hat, darf den Song abspielen
app.get('/api/card/:id', auth, wrap((req, res) => {
  const s = db.prepare('SELECT s.id, s.year, s.artist, s.title, s.spotify_uri, c.name AS catalog FROM songs s JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = ?').get(String(req.params.id));
  if (!s) fail(404, 'Diese Karte gibt es nicht (mehr)');
  res.json({ id: s.id, year: s.year, artist: s.artist, title: s.title, uri: s.spotify_uri, catalog: s.catalog });
}));

// ---------- Teilen ----------
app.get('/api/catalogs/:id/shares', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id, { write: true });
  res.json(db.prepare('SELECT u.id, u.username FROM catalog_shares cs JOIN users u ON u.id = cs.user_id WHERE cs.catalog_id = ? ORDER BY u.username').all(c.id));
}));

app.post('/api/catalogs/:id/shares', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id, { write: true });
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(String(req.body.username || '').trim());
  if (!u) fail(404, 'Diesen Benutzer gibt es nicht');
  if (u.id === req.user.id) fail(400, 'Das ist dein eigener Account');
  db.prepare('INSERT OR IGNORE INTO catalog_shares (catalog_id, user_id) VALUES (?, ?)').run(c.id, u.id);
  res.json({ ok: true });
}));

app.delete('/api/catalogs/:id/shares/:userId', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id);
  const uid = +req.params.userId;
  // Besitzer entfernt jemanden, oder ein Nutzer entfernt sich selbst
  if (!c.canWrite && uid !== req.user.id) fail(403, 'Nicht erlaubt');
  db.prepare('DELETE FROM catalog_shares WHERE catalog_id = ? AND user_id = ?').run(c.id, uid);
  res.json({ ok: true });
}));

// ---------- Drucken ----------
app.get('/api/catalogs/:id/prints', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id);
  res.json(db.prepare(`
    SELECT pb.id, pb.sheets, pb.color, pb.created_at AS createdAt, COUNT(pi.song_id) AS cards
    FROM print_batches pb LEFT JOIN print_items pi ON pi.batch_id = pb.id
    WHERE pb.catalog_id = ? AND pb.user_id = ? GROUP BY pb.id ORDER BY pb.id DESC
  `).all(c.id, req.user.id));
}));

app.post('/api/catalogs/:id/prints', auth, wrap((req, res) => {
  const c = catalogFor(req, req.params.id);
  const sheets = Math.max(1, Math.min(100, parseInt(req.body.sheets, 10) || 1));
  const onlyNew = req.body.onlyNew !== false;
  const color = req.body.color !== false;
  const pool = db.prepare(`
    SELECT s.id FROM songs s WHERE s.catalog_id = ? ${onlyNew ? `AND NOT EXISTS (
      SELECT 1 FROM print_items pi JOIN print_batches pb ON pb.id = pi.batch_id WHERE pi.song_id = s.id AND pb.user_id = ?)` : ''}
  `).all(...(onlyNew ? [c.id, req.user.id] : [c.id])).map((r) => r.id);
  if (!pool.length) fail(400, onlyNew ? 'Alle Songs dieses Katalogs wurden schon gedruckt' : 'Der Katalog ist leer');
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const pick = pool.slice(0, sheets * PER_SHEET);
  const batchId = tx(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO print_batches (catalog_id, user_id, sheets, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, req.user.id, Math.ceil(pick.length / PER_SHEET), color ? 1 : 0, Date.now());
    const ins = db.prepare('INSERT INTO print_items (batch_id, song_id, position) VALUES (?, ?, ?)');
    pick.forEach((id, i) => ins.run(lastInsertRowid, id, i));
    return Number(lastInsertRowid);
  });
  res.json({ id: batchId, cards: pick.length, remaining: pool.length - pick.length });
}));

app.get('/api/prints/:id.pdf', auth, wrap((req, res) => {
  const b = db.prepare('SELECT pb.*, c.name FROM print_batches pb JOIN catalogs c ON c.id = pb.catalog_id WHERE pb.id = ? AND pb.user_id = ?').get(+req.params.id, req.user.id);
  if (!b) fail(404, 'Druckauftrag nicht gefunden');
  const cards = db.prepare('SELECT s.id, s.year, s.artist, s.title FROM print_items pi JOIN songs s ON s.id = pi.song_id WHERE pi.batch_id = ? ORDER BY pi.position')
    .all(b.id).map((s) => ({ ...s, url: `${PUBLIC_URL}/k/${s.id}` }));
  const file = `hit-zeitreise-${b.name.replace(/[^\wäöüÄÖÜß-]+/g, '-').slice(0, 40)}-${b.id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file)}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  renderCardsPdf(cards, { color: !!b.color, title: `Hit-Zeitreise – ${b.name}` }).pipe(res);
}));

app.delete('/api/prints/:id', auth, wrap((req, res) => {
  db.prepare('DELETE FROM print_batches WHERE id = ? AND user_id = ?').run(+req.params.id, req.user.id);
  res.json({ ok: true });
}));

// ---------- Statische Dateien ----------
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(path.resolve('node_modules/jsqr/dist/jsQR.js'), { maxAge: '7d' }));
app.use(express.static(path.resolve('public'), { index: false, maxAge: '1h' }));
// SPA: Startseite und Karten-Links (/k/<id>) liefern index.html
app.get(['/', '/k/:id'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.resolve('public/index.html'));
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Datei zu groß' });
  console.error(err);
  res.status(500).json({ error: 'Serverfehler' });
});

// Abgelaufene Sessions aufräumen
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 6 * 3600e3).unref();

app.listen(PORT, () => console.log(`Hit-Zeitreise läuft auf Port ${PORT} (${PUBLIC_URL})`));
