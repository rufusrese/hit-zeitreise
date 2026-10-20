import * as S from './spotify.js?v=5';

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const fmt = (n) => Number(n).toLocaleString('de');
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';
const EQ = (paused) => `<div class="eq ${paused ? 'paused' : ''}"><span></span><span></span><span></span><span></span><span></span></div>`;

const settings = Object.assign({ deviceId: '', start: '0', maxPerYear: 3, from: '', to: '', catalogId: null, perPage: 12 }, load('hz_settings', {}));
const PRINT_LAYOUTS = [
  [6, '6 pro Seite – groß (8,5 cm)'],
  [12, '12 pro Seite – Standard (6,5 cm)'],
  [20, '20 pro Seite – klein (4,8 cm)'],
  [30, '30 pro Seite – sehr klein (3,8 cm)'],
];
const saveSettings = () => save('hz_settings', settings);

const st = {
  me: null, catalogs: null, catalog: null, route: { name: 'play' },
  busy: false, msg: { html: '', type: '' }, retryOnReturn: false, cleanup: null,
  game: null, card: null, catFilter: '', catLimit: 150, searchResults: null, csv: null, authMode: 'login',
};

function toast(text, type = '') {
  const t = $('toast');
  t.textContent = text; t.className = 'toast ' + type; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function setMsg(html, type = '') {
  st.msg = { html, type };
  const m = $('msg');
  if (m) { m.className = 'msg ' + type; m.innerHTML = html; m.hidden = !html; }
}
const msgBox = () => `<div class="msg ${st.msg.type}" id="msg" ${st.msg.html ? '' : 'hidden'}>${st.msg.html}</div>`;

function openDialog(html) { $('dlgBody').innerHTML = html; if (!$('dlg').open) $('dlg').showModal(); }
function closeDialog() { if ($('dlg').open) $('dlg').close(); }

// ---------- Server-API ----------
class ServerError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function srv(method, path, body) {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'X-HZ': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/me') { st.me = null; route(); }
  if (!r.ok) throw new ServerError(r.status, j.error || 'Fehler ' + r.status);
  return j;
}

// ---------- Routing ----------
function parseRoute() {
  const m = location.pathname.match(/^\/k\/([A-Za-z0-9]+)/);
  if (m) return { name: 'card', id: m[1] };
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'scan') return { name: 'scan' };
  if (a === 'kataloge') return { name: 'catalogs' };
  if (a === 'katalog' && b) return { name: 'catalog', id: +b };
  if (a === 'drucken' && b) return { name: 'print', id: +b };
  if (a === 'einstellungen') return { name: 'settings' };
  return { name: 'play' };
}

function go(hash) {
  const target = '/' + hash;
  if (location.pathname + location.hash !== target) history.pushState(null, '', target);
  route();
}

const TAB = { play: 'play', card: 'scan', scan: 'scan', catalogs: 'catalogs', catalog: 'catalogs', print: 'catalogs', settings: 'settings' };

async function route() {
  if (st.cleanup) { const c = st.cleanup; st.cleanup = null; c(); }
  const r = parseRoute();
  const changed = r.name !== st.route.name || r.id !== st.route.id;
  st.route = r;
  if (changed) setMsg('');
  $('tabbar').hidden = !st.me;
  document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === TAB[r.name]));
  $('stats').textContent = '';
  if (!st.me) return renderLogin();
  try {
    if (r.name === 'play') await viewPlay();
    else if (r.name === 'scan') viewScan();
    else if (r.name === 'card') await viewCard(r.id);
    else if (r.name === 'catalogs') await viewCatalogs();
    else if (r.name === 'catalog') await viewCatalog(r.id);
    else if (r.name === 'print') await viewPrint(r.id);
    else if (r.name === 'settings') viewSettings();
  } catch (e) {
    if (e.status === 401) return; // Login-Maske wird schon angezeigt
    console.error(e);
    $('view').innerHTML = `<section class="panel"><p>${esc(e.message)}</p><a class="btn ghost" href="/#/">Zur Startseite</a></section>`;
  }
  if (changed) window.scrollTo(0, 0);
}

// ---------- Event-Delegation ----------
const A = {}; // data-act="…"
const F = {}; // data-form="…"
const C = {}; // data-change="…"
document.addEventListener('click', (e) => {
  // Interne Links ohne Neuladen (sonst geht u. a. die Audio-Freigabe verloren)
  const a = e.target.closest('a[href^="/#"]');
  if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); go(a.getAttribute('href').slice(1)); return; }
  const el = e.target.closest('[data-act]');
  if (el && A[el.dataset.act]) { e.preventDefault(); A[el.dataset.act](el, e); }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (f && F[f.dataset.form]) { e.preventDefault(); F[f.dataset.form](f, new FormData(f)); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && C[el.dataset.change]) C[el.dataset.change](el, e);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'catFilter') { st.catFilter = e.target.value; st.catLimit = 150; renderSongList(); }
});
A.closeDialog = () => closeDialog();

// ---------- Login / Registrierung ----------
function renderLogin() {
  const card = st.route.name === 'card';
  $('view').innerHTML = `
    <section class="panel narrow">
      <h1 class="hero">Hit-Zeitreise</h1>
      <p class="muted center">${card ? 'Melde dich an, um diese Karte abzuspielen.' : 'Song hören, Jahr raten – mit deinem Spotify.'}</p>
      <div class="seg">
        <button data-act="authMode" data-mode="login" class="${st.authMode === 'login' ? 'on' : ''}">Anmelden</button>
        <button data-act="authMode" data-mode="register" class="${st.authMode === 'register' ? 'on' : ''}">Registrieren</button>
      </div>
      <form data-form="auth" class="stack">
        <label>Benutzername <input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="32"></label>
        <label>Passwort <input name="password" type="password" required minlength="${st.authMode === 'register' ? 8 : 1}"
          autocomplete="${st.authMode === 'register' ? 'new-password' : 'current-password'}"></label>
        ${st.authMode === 'register' ? '<label>Passwort wiederholen <input name="password2" type="password" required autocomplete="new-password"></label>' : ''}
        <div class="err" id="authErr"></div>
        <button class="btn wide">${st.authMode === 'register' ? 'Account erstellen' : 'Anmelden'}</button>
      </form>
    </section>`;
}
A.authMode = (el) => { st.authMode = el.dataset.mode; renderLogin(); };
F.auth = async (f, fd) => {
  const err = $('authErr');
  if (st.authMode === 'register' && fd.get('password') !== fd.get('password2')) { err.textContent = 'Die Passwörter stimmen nicht überein'; return; }
  try {
    await srv('POST', st.authMode === 'register' ? '/register' : '/login', { username: fd.get('username'), password: fd.get('password') });
    await afterLogin();
  } catch (e) { err.textContent = e.message; }
};

async function afterLogin() {
  st.me = await srv('GET', '/me');
  S.initSpotify({ clientId: st.me.spotifyClientId || st.me.defaultClientId, userId: st.me.id, settings });
  st.catalogs = null; st.catalog = null; st.game = null;
  await route();
  S.initSdk();
}

A.logout = async () => {
  await srv('POST', '/logout').catch(() => {});
  S.stopPlayback();
  st.me = null; st.catalogs = null; st.catalog = null;
  go('#/');
};

// ---------- Daten ----------
async function loadCatalogs(force) {
  if (!st.catalogs || force) st.catalogs = await srv('GET', '/catalogs');
  return st.catalogs;
}
async function loadCatalog(id, force) {
  if (!force && st.catalog && st.catalog.id === id) return st.catalog;
  st.catalog = await srv('GET', '/catalogs/' + id);
  return st.catalog;
}
const notFoundKey = () => 'hz_nf_' + st.me.id;

// Spotify-Track zu einem Song finden (und auf dem Server merken)
async function uriFor(song) {
  if (song.uri) return song.uri;
  const uri = await S.resolveSong(song);
  if (uri) {
    song.uri = uri;
    srv('PUT', `/songs/${song.id}/spotify`, { uri }).catch(() => {});
  } else {
    const nf = load(notFoundKey(), []); nf.push(song.id); save(notFoundKey(), nf.slice(-5000));
  }
  return uri;
}

function handlePlayError(e) {
  console.error(e);
  st.retryOnReturn = e instanceof S.NoDevice || S.isWakeable(e);
  const retry = `<div class="btn-row"><a class="btn small-btn green" href="spotify:">Spotify öffnen</a>
    <button class="btn small-btn ghost" data-act="retryPlay">Nochmal</button></div>`;
  if (e instanceof S.NoDevice || (e instanceof S.ApiError && e.status === 404)) {
    setMsg(`<b>Kein Spotify-Gerät gefunden.</b><br>Öffne die Spotify-App kurz, komm zurück und tippe auf „Nochmal“.${retry}`, 'error');
  } else if (e instanceof S.ApiError && e.status === 403 && /premium/i.test(e.message + ' ' + (e.reason || ''))) {
    setMsg('Spotify verweigert die Wiedergabe (' + esc(e.message) + '). Dafür ist Spotify Premium nötig.', 'error');
  } else if (e instanceof S.ApiError && e.status === 403) {
    setMsg(`<b>Spotify reagiert gerade nicht</b> (${esc(e.message)}).<br>Öffne Spotify kurz, komm zurück und tippe auf „Nochmal“.${retry}`, 'error');
  } else if (e instanceof S.ApiError && e.reason === 'QUOTA_EXCEEDED') {
    setMsg('Spotify-API-Limit erreicht. Bitte ein paar Minuten warten.', 'error');
  } else {
    setMsg('Fehler: ' + esc(e.message || e), 'error');
  }
}
A.retryPlay = () => {
  S.unlockAudio();
  st.retryOnReturn = false;
  if (st.route.name === 'card') return A.cardPlay();
  if (st.game && st.game.current) return A.restart();
  return A.nextSong();
};

function spotifyGate() {
  if (S.isConnected()) return '';
  const cid = st.me.spotifyClientId || st.me.defaultClientId;
  if (!cid) {
    return `<section class="panel center">
      <div class="title-lg">Spotify noch nicht eingerichtet</div>
      <p class="muted">${st.me.isAdmin ? 'Trage unter „Mehr“ die Client ID deiner Spotify-App ein.' : 'Der Admin hat noch keine Spotify-App hinterlegt. Du kannst unter „Mehr“ deine eigene Client ID eintragen.'}</p>
      <a class="btn" href="/#/einstellungen">Zu den Einstellungen</a></section>`;
  }
  return `<section class="panel center">
    <div class="title-lg">Mit Spotify verbinden</div>
    <p class="muted">Zum Abspielen wird dein Spotify-Account (Premium) benötigt.</p>
    <button class="btn wide green" data-act="spotifyConnect">Mit Spotify verbinden</button></section>`;
}
A.spotifyConnect = async () => {
  try { await S.connect(location.pathname + location.hash); } catch (e) { toast(e.message, 'error'); }
};

// ---------- Spielen ----------
function gameKey(cid) { return `hz_game_${st.me.id}_${cid}`; }
function newGame() { return { played: [], yearCounts: {}, current: null, revealed: false, round: 0 }; }
function loadGame(cid) {
  if (!st.game || st.game.cid !== cid) st.game = Object.assign(newGame(), load(gameKey(cid), {}), { cid });
  return st.game;
}
const saveGame = () => save(gameKey(st.game.cid), st.game);

function yearBounds(c) {
  let min = Infinity, max = -Infinity;
  for (const s of c.songs) { if (s.year < min) min = s.year; if (s.year > max) max = s.year; }
  const from = settings.from ? Math.max(+settings.from, min) : min;
  const to = settings.to ? Math.min(+settings.to, max) : max;
  return { min, max, from, to };
}

async function viewPlay() {
  const cats = await loadCatalogs();
  if (!cats.length) { $('view').innerHTML = '<section class="panel">Keine Kataloge vorhanden.</section>'; return; }
  if (!cats.some((c) => c.id === settings.catalogId)) { settings.catalogId = cats[0].id; saveSettings(); }
  const c = await loadCatalog(settings.catalogId);
  loadGame(c.id);
  renderPlay();
}

function renderPlay() {
  const c = st.catalog, g = st.game;
  const b = yearBounds(c);
  const full = Object.entries(g.yearCounts).filter(([y, n]) => n >= settings.maxPerYear && +y >= b.from && +y <= b.to).length;
  $('stats').textContent = g.round ? `Runde ${g.round} · ${full} Jahre voll` : '';
  const options = st.catalogs.map((x) => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)} (${fmt(x.songCount)})</option>`).join('');
  const gate = spotifyGate();
  $('view').innerHTML = `
    <div class="toolbar">
      <select data-change="pickCatalog" aria-label="Katalog">${options}</select>
      <button class="btn small-btn ghost" data-act="newGame">Neues Spiel</button>
    </div>
    ${gate || `<section class="stage" id="stage">${stageHtml()}</section>`}
    ${msgBox()}
    <details class="years">
      <summary>Jahreskarten <span id="yearsSummary"></span></summary>
      <div class="year-grid" id="yearGrid"></div>
      <p class="hint">Zahl = wie oft das Jahr in diesem Spiel schon aufgelöst wurde. Volle Jahre kommen nicht mehr dran (max. ${settings.maxPerYear}, änderbar unter „Mehr“).</p>
    </details>`;
  renderYears();
}

function stageHtml() {
  const g = st.game, c = st.catalog;
  if (!g.current) {
    const b = yearBounds(c);
    return `
      <button class="big-play" data-act="nextSong" ${st.busy ? 'disabled' : ''} aria-label="Zufälligen Song spielen">${ICON_PLAY}</button>
      <div class="title-lg">${st.busy ? 'Suche Song…' : 'Zufälligen Song spielen'}</div>
      <div class="muted">${fmt(c.songs.length)} Songs · ${b.from}–${b.to}</div>`;
  }
  if (!g.revealed) {
    return `
      ${EQ(S.sp.paused || st.busy)}
      <div class="title-lg">${st.busy ? 'Lädt…' : S.sp.paused ? 'Pausiert' : 'Song läuft…'}</div>
      <div class="muted small">${S.sp.deviceName ? 'auf ' + esc(S.sp.deviceName) : ''}</div>
      <button class="btn wide" data-act="reveal">Auflösen</button>
      <div class="btn-row">
        <button class="btn ghost" data-act="togglePause">${S.sp.paused ? '▶ Weiter' : '❚❚ Pause'}</button>
        <button class="btn ghost" data-act="restart">↺ Von vorn</button>
      </div>
      <button class="link" data-act="nextSong">Song überspringen (zählt nicht)</button>`;
  }
  const s = c.songs.find((x) => x.id === g.current.id) || g.current;
  return `
    ${solutionCard(s, g.current.img, st.justRevealed)}
    <button class="btn wide" data-act="nextSong" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Suche Song…' : 'Nächster Song ▶'}</button>
    <div class="btn-row"><button class="btn ghost" data-act="togglePause">${S.sp.paused ? '▶ Weiter' : '❚❚ Pause'}</button></div>`;
}

function solutionCard(s, img, anim) {
  return `<div class="card ${img ? 'cover' : ''} ${anim ? 'anim' : ''}">
    ${img ? `<img src="${esc(img)}" alt="">` : ''}
    <div class="artist">${esc(s.artist)}</div>
    <div class="year">${s.year}</div>
    <div class="song">${esc(s.title)}</div>
  </div>`;
}

function renderStage() {
  const el = $('stage');
  if (el && st.route.name === 'play') { el.innerHTML = stageHtml(); renderYears(); }
  else if (st.route.name === 'card') renderCard();
}

function renderYears() {
  const g = $('yearGrid');
  if (!g || !st.catalog) return;
  const b = yearBounds(st.catalog);
  let html = '', used = 0, total = 0;
  for (let y = b.min; y <= b.max; y++) {
    const n = st.game.yearCounts[y] || 0, on = y >= b.from && y <= b.to;
    used += n; if (on) total += settings.maxPerYear;
    const cls = !on ? 'off' : n >= settings.maxPerYear ? 'full' : n ? 'c' + Math.min(n, 2) : '';
    html += `<div class="${cls}">${y}<b>${n}/${settings.maxPerYear}</b></div>`;
  }
  g.innerHTML = html;
  $('yearsSummary').textContent = `(${used} von ${total} vergeben)`;
  const full = Object.entries(st.game.yearCounts).filter(([y, n]) => n >= settings.maxPerYear && +y >= b.from && +y <= b.to).length;
  $('stats').textContent = st.game.round ? `Runde ${st.game.round} · ${full} Jahre voll` : '';
}

C.pickCatalog = async (el) => {
  settings.catalogId = +el.value; saveSettings();
  st.msg = { html: '', type: '' };
  await viewPlay();
};

A.newGame = () => {
  if (!confirm('Neues Spiel starten? Gespielte Songs und Jahreszähler werden zurückgesetzt.')) return;
  st.game = Object.assign(newGame(), { cid: st.catalog.id }); saveGame();
  S.stopPlayback(); setMsg('');
  renderPlay();
};

function candidates() {
  const c = st.catalog, g = st.game, b = yearBounds(c);
  const played = new Set(g.played), nf = new Set(load(notFoundKey(), []));
  return c.songs.filter((s) => !played.has(s.id) && !nf.has(s.id) && s.year >= b.from && s.year <= b.to &&
    (g.yearCounts[s.year] || 0) < settings.maxPerYear);
}

A.nextSong = async () => {
  S.unlockAudio();
  if (st.busy) return;
  st.busy = true; setMsg(''); renderStage();
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const cand = candidates();
      if (!cand.length) { st.game.current = null; setMsg('Keine Songs mehr übrig – alle Jahre sind voll. Starte ein neues Spiel.'); break; }
      const s = cand[Math.floor(Math.random() * cand.length)];
      const uri = await uriFor(s);
      if (!uri) continue;
      const g = st.game;
      g.played.push(s.id);
      g.current = { id: s.id, uri };
      g.revealed = false; g.round++;
      saveGame();
      await playCurrent();
      S.trackInfo(uri).then((t) => { if (g.current && g.current.id === s.id) { g.current.img = t.img; saveGame(); } }).catch(() => {});
      break;
    }
  } catch (e) { handlePlayError(e); }
  st.busy = false;
  renderStage();
};

async function playCurrent() {
  try { await S.playUri(st.game.current.uri); setMsg(''); } catch (e) { handlePlayError(e); }
}

A.reveal = () => {
  const g = st.game;
  if (!g.current || g.revealed) return;
  const s = st.catalog.songs.find((x) => x.id === g.current.id);
  if (s) g.yearCounts[s.year] = (g.yearCounts[s.year] || 0) + 1;
  g.revealed = true; saveGame();
  st.justRevealed = true; renderStage(); st.justRevealed = false;
};

A.togglePause = async () => {
  S.unlockAudio();
  const uri = st.route.name === 'card' ? st.card && st.card.song.uri : st.game && st.game.current && st.game.current.uri;
  try { await S.setPlaying(S.sp.paused, uri); } catch (e) { handlePlayError(e); }
  renderStage();
};

A.restart = async () => {
  S.unlockAudio();
  if (!st.game || !st.game.current) return;
  st.busy = true; renderStage();
  await playCurrent();
  st.busy = false; renderStage();
};

// ---------- QR-Scanner ----------
function viewScan() {
  S.unlockAudio();
  $('view').innerHTML = `
    <section class="scan">
      <div class="video-wrap"><video id="scanVideo" playsinline muted></video><div class="frame"></div></div>
      <p class="muted center" id="scanHint">Halte den QR-Code einer Karte in den Rahmen.</p>
      ${S.isConnected() ? '' : spotifyGate()}
    </section>`;
  startScanner();
}

async function startScanner() {
  const video = $('scanVideo');
  let stream, stopped = false, timer;
  st.cleanup = () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    $('scanHint').innerHTML = 'Kein Kamerazugriff. Erlaube die Kamera für diese Seite oder scanne den Code mit der Kamera-App deines Handys.';
    return;
  }
  if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
  video.srcObject = stream;
  await video.play().catch(() => {});

  let detect;
  if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats().catch(() => [])).includes('qr_code')) {
    const det = new window.BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => { const r = await det.detect(video); return r[0] && r[0].rawValue; };
  } else {
    await loadScript('/vendor/jsQR.js');
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      const w = 480, h = Math.round(w * (video.videoHeight / video.videoWidth || 0.75));
      if (!video.videoWidth) return null;
      canvas.width = w; canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const r = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      return r && r.data;
    };
  }
  let lastBad = '';
  const tick = async () => {
    if (stopped) return;
    try {
      const text = await detect();
      if (text) {
        const m = text.match(/\/k\/([A-Za-z0-9]{6,})/);
        if (m) { st.cleanup(); st.cleanup = null; st.fromScan = true; history.pushState(null, '', '/k/' + m[1]); route(); return; }
        if (text !== lastBad) { lastBad = text; toast('Das ist kein Hit-Zeitreise-Code'); }
      }
    } catch (e) { console.warn(e); }
    timer = setTimeout(tick, 200);
  };
  tick();
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ---------- Karte (aus QR-Code) ----------
async function viewCard(id) {
  if (!st.card || st.card.song.id !== id) {
    st.card = { song: await srv('GET', '/card/' + id), phase: 'ready', img: '' };
  }
  renderCard();
  if (st.fromScan && st.card.phase === 'ready' && S.isConnected()) { st.fromScan = false; A.cardPlay(); }
  st.fromScan = false;
}

function renderCard() {
  const c = st.card, gate = spotifyGate();
  let body;
  if (gate) body = gate;
  else if (c.phase === 'ready') {
    body = `<button class="big-play" data-act="cardPlay" ${st.busy ? 'disabled' : ''} aria-label="Song abspielen">${ICON_PLAY}</button>
      <div class="title-lg">${st.busy ? 'Lädt…' : 'Karte erkannt – Song abspielen'}</div>`;
  } else if (c.phase === 'playing') {
    body = `${EQ(S.sp.paused || st.busy)}
      <div class="title-lg">${st.busy ? 'Lädt…' : S.sp.paused ? 'Pausiert' : 'Song läuft…'}</div>
      <div class="muted small">${S.sp.deviceName ? 'auf ' + esc(S.sp.deviceName) : ''}</div>
      <button class="btn wide" data-act="cardReveal">Auflösen</button>
      <div class="btn-row">
        <button class="btn ghost" data-act="togglePause">${S.sp.paused ? '▶ Weiter' : '❚❚ Pause'}</button>
        <button class="btn ghost" data-act="cardPlay">↺ Von vorn</button>
      </div>`;
  } else {
    body = `${solutionCard(c.song, c.img, st.justRevealed)}
      <div class="btn-row"><button class="btn ghost" data-act="togglePause">${S.sp.paused ? '▶ Weiter' : '❚❚ Pause'}</button></div>`;
  }
  $('view').innerHTML = `
    <section class="stage" id="stage">${body}</section>
    ${msgBox()}
    <a class="btn wide ghost scan-next" href="/#/scan">Nächste Karte scannen</a>`;
}

A.cardPlay = async () => {
  S.unlockAudio();
  if (st.busy) return;
  const c = st.card;
  st.busy = true; setMsg(''); renderCard();
  try {
    const uri = c.song.uri || await uriFor(c.song);
    if (!uri) throw new Error('Dieser Song wurde auf Spotify nicht gefunden.');
    await S.playUri(uri);
    if (c.phase === 'ready') c.phase = 'playing';
    S.trackInfo(uri).then((t) => { c.img = t.img; }).catch(() => {});
  } catch (e) { handlePlayError(e); }
  st.busy = false; renderCard();
};
A.cardReveal = () => { st.card.phase = 'revealed'; st.justRevealed = true; renderCard(); st.justRevealed = false; };

// ---------- Kataloge ----------
async function viewCatalogs() {
  const cats = await loadCatalogs(true);
  const item = (c) => `
    <a class="list-item" href="/#/katalog/${c.id}">
      <div class="li-main">
        <div class="li-title">${esc(c.name)}</div>
        <div class="li-sub">${fmt(c.songCount)} Songs · ${c.isSystem ? 'Standard' : c.isOwner ? (c.shareCount ? `geteilt mit ${c.shareCount}` : 'privat') : 'von ' + esc(c.owner)}
          ${c.printedCount ? ` · ${fmt(c.printedCount)} gedruckt` : ''}</div>
      </div>
      <span class="chev">›</span>
    </a>`;
  const own = cats.filter((c) => c.isOwner), other = cats.filter((c) => !c.isOwner);
  $('view').innerHTML = `
    <section class="section-head"><h2>Kataloge</h2>
      <div class="btn-row left">
        <button class="btn small-btn" data-act="newCatalog">+ Neuer Katalog</button>
        <button class="btn small-btn ghost" data-act="importNew">CSV importieren</button>
      </div>
    </section>
    <div class="list">${other.map(item).join('')}</div>
    <h3 class="sub-head">Meine Kataloge</h3>
    <div class="list">${own.map(item).join('') || '<p class="muted pad">Noch keine eigenen Kataloge. Lege einen an oder importiere eine CSV-Datei.</p>'}</div>`;
}

A.newCatalog = async () => {
  const name = prompt('Name des neuen Katalogs:');
  if (!name || !name.trim()) return;
  try { const { id } = await srv('POST', '/catalogs', { name: name.trim() }); st.catalogs = null; go('#/katalog/' + id); }
  catch (e) { toast(e.message, 'error'); }
};

async function viewCatalog(id) {
  const c = await loadCatalog(id, true);
  const withUri = c.songs.filter((s) => s.uri).length, printed = c.songs.filter((s) => s.printed).length;
  $('view').innerHTML = `
    <a class="back" href="/#/kataloge">‹ Kataloge</a>
    <section class="section-head">
      <h2>${esc(c.name)}</h2>
      <div class="muted small">${fmt(c.songs.length)} Songs · ${c.isSystem ? 'Standard-Katalog' : 'von ' + esc(c.owner)} · ${fmt(withUri)} mit Spotify verknüpft · ${fmt(printed)} von dir gedruckt</div>
      <div class="btn-row left">
        <button class="btn small-btn" data-act="playCatalog">▶ Spielen</button>
        <a class="btn small-btn ghost" href="/#/drucken/${c.id}">Karten drucken</a>
        <button class="btn small-btn ghost" data-act="exportCsv">CSV-Export</button>
        <button class="btn small-btn ghost" data-act="copyCatalog">Kopieren</button>
        ${c.isOwner ? `<button class="btn small-btn ghost" data-act="shareCatalog">Teilen</button>
          <button class="btn small-btn ghost" data-act="renameCatalog">Umbenennen</button>
          <button class="btn small-btn ghost danger" data-act="deleteCatalog">Löschen</button>` : ''}
        ${!c.isOwner && !c.isPublic ? '<button class="btn small-btn ghost danger" data-act="leaveCatalog">Aus meiner Liste entfernen</button>' : ''}
      </div>
    </section>
    ${c.canWrite ? `
    <section class="panel">
      <h3>Songs hinzufügen</h3>
      <form data-form="spSearch" class="row">
        <input name="q" placeholder="Auf Spotify suchen (Titel, Interpret)" autocomplete="off" required>
        <button class="btn small-btn">Suchen</button>
      </form>
      <div id="searchResults"></div>
      <div class="btn-row left">
        <button class="btn small-btn ghost" data-act="addManual">Manuell eintragen</button>
        <button class="btn small-btn ghost" data-act="importInto">CSV importieren</button>
      </div>
    </section>` : ''}
    <section class="panel">
      <input id="catFilter" placeholder="Songs filtern (Titel, Interpret, Jahr)" value="${esc(st.catFilter)}" autocomplete="off">
      <div id="songList"></div>
    </section>`;
  renderSearchResults();
  renderSongList();
}

function renderSongList() {
  const el = $('songList'), c = st.catalog;
  if (!el || !c) return;
  const q = st.catFilter.trim().toLowerCase();
  const list = q ? c.songs.filter((s) => (s.title + ' ' + s.artist + ' ' + s.year).toLowerCase().includes(q)) : c.songs;
  const rows = list.slice(0, st.catLimit).map((s) => `
    <div class="song-row">
      <span class="sy">${s.year}</span>
      <span class="st"><b>${esc(s.title)}</b><br><span class="muted">${esc(s.artist)}</span></span>
      <span class="flags">${s.uri ? '<span title="mit Spotify verknüpft" class="ok">♫</span>' : ''}${s.printed ? '<span title="schon gedruckt">🖨</span>' : ''}</span>
      ${c.canWrite ? `<button class="icon-btn" data-act="editSong" data-id="${s.id}" aria-label="Bearbeiten">✎</button>` : ''}
    </div>`).join('');
  el.innerHTML = `<div class="muted small pad">${fmt(list.length)} Songs${q ? ' gefunden' : ''}</div>${rows}
    ${list.length > st.catLimit ? '<button class="btn ghost wide" data-act="moreSongs">Mehr anzeigen</button>' : ''}`;
}
A.moreSongs = () => { st.catLimit += 300; renderSongList(); };

A.playCatalog = () => { settings.catalogId = st.catalog.id; saveSettings(); go('#/'); };

A.renameCatalog = async () => {
  const name = prompt('Neuer Name:', st.catalog.name);
  if (!name || !name.trim()) return;
  try { await srv('PUT', '/catalogs/' + st.catalog.id, { name: name.trim() }); st.catalogs = null; viewCatalog(st.catalog.id); }
  catch (e) { toast(e.message, 'error'); }
};
A.deleteCatalog = async () => {
  if (!confirm(`Katalog „${st.catalog.name}“ mit allen Songs löschen? Gedruckte Karten funktionieren danach nicht mehr.`)) return;
  try { await srv('DELETE', '/catalogs/' + st.catalog.id); st.catalogs = null; st.catalog = null; go('#/kataloge'); }
  catch (e) { toast(e.message, 'error'); }
};
A.leaveCatalog = async () => {
  if (!confirm('Diesen geteilten Katalog aus deiner Liste entfernen?')) return;
  try { await srv('DELETE', `/catalogs/${st.catalog.id}/shares/${st.me.id}`); st.catalogs = null; go('#/kataloge'); }
  catch (e) { toast(e.message, 'error'); }
};
A.copyCatalog = async () => {
  const name = prompt('Name der Kopie:', st.catalog.name + ' (Kopie)');
  if (!name) return;
  try { const { id } = await srv('POST', `/catalogs/${st.catalog.id}/copy`, { name }); st.catalogs = null; toast('Kopie angelegt'); go('#/katalog/' + id); }
  catch (e) { toast(e.message, 'error'); }
};

A.exportCsv = () => {
  const q = (v) => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = ['Titel;Interpret;Erscheinungsjahr;Spotify'];
  for (const s of st.catalog.songs) lines.push([s.title, s.artist, s.year, s.uri || ''].map(q).join(';'));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = st.catalog.name.replace(/[^\wäöüÄÖÜß -]+/g, '_') + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// Teilen
A.shareCatalog = async () => {
  const shares = await srv('GET', `/catalogs/${st.catalog.id}/shares`);
  openDialog(`
    <form data-form="addShare" class="stack dialog-form">
      <h2>Katalog teilen</h2>
      <p class="muted small">Geteilte Nutzer können den Katalog spielen, drucken und kopieren, aber nicht bearbeiten.</p>
      ${shares.length ? shares.map((u) => `<div class="row between"><span>${esc(u.username)}</span>
        <button type="button" class="btn small-btn ghost danger" data-act="removeShare" data-id="${u.id}">Entfernen</button></div>`).join('') : '<p class="muted">Noch mit niemandem geteilt.</p>'}
      <label>Benutzername <input name="username" required autocapitalize="none" spellcheck="false"></label>
      <div class="err" id="shareErr"></div>
      <div class="row end"><button type="button" class="btn ghost" data-act="closeDialog">Schließen</button><button class="btn">Teilen</button></div>
    </form>`);
};
F.addShare = async (f, fd) => {
  try { await srv('POST', `/catalogs/${st.catalog.id}/shares`, { username: fd.get('username') }); A.shareCatalog(); }
  catch (e) { $('shareErr').textContent = e.message; }
};
A.removeShare = async (el) => {
  await srv('DELETE', `/catalogs/${st.catalog.id}/shares/${el.dataset.id}`).catch((e) => toast(e.message, 'error'));
  A.shareCatalog();
};

// Song bearbeiten / hinzufügen
function songDialog(s = {}, note = '') {
  openDialog(`
    <form data-form="saveSong" class="stack dialog-form" data-id="${esc(s.id || '')}">
      <h2>${s.id ? 'Song bearbeiten' : 'Song hinzufügen'}</h2>
      ${note ? `<p class="hint">${note}</p>` : ''}
      <label>Titel <input name="title" required value="${esc(s.title || '')}"></label>
      <label>Interpret <input name="artist" required value="${esc(s.artist || '')}"></label>
      <label>Erscheinungsjahr <input name="year" type="number" min="1000" max="2100" required value="${esc(s.year || '')}"></label>
      <label>Spotify-Link (optional) <input name="uri" value="${esc(s.uri || '')}" placeholder="https://open.spotify.com/track/…"></label>
      <div class="err" id="songErr"></div>
      <div class="row end">
        ${s.id ? '<button type="button" class="btn ghost danger" data-act="deleteSong" data-id="' + esc(s.id) + '">Löschen</button><span class="grow"></span>' : ''}
        <button type="button" class="btn ghost" data-act="closeDialog">Abbrechen</button>
        <button class="btn">Speichern</button>
      </div>
    </form>`);
}
A.addManual = () => songDialog();
A.editSong = (el) => songDialog(st.catalog.songs.find((s) => s.id === el.dataset.id));
F.saveSong = async (f, fd) => {
  const body = { title: fd.get('title'), artist: fd.get('artist'), year: fd.get('year'), spotify_uri: fd.get('uri') || null };
  try {
    if (f.dataset.id) await srv('PUT', '/songs/' + f.dataset.id, body);
    else await srv('POST', `/catalogs/${st.catalog.id}/songs`, body);
    closeDialog(); toast('Gespeichert'); st.catalogs = null;
    await viewCatalog(st.catalog.id);
  } catch (e) { $('songErr').textContent = e.message; }
};
A.deleteSong = async (el) => {
  if (!confirm('Song löschen? Eine gedruckte Karte dazu funktioniert dann nicht mehr.')) return;
  try { await srv('DELETE', '/songs/' + el.dataset.id); closeDialog(); st.catalogs = null; await viewCatalog(st.catalog.id); }
  catch (e) { toast(e.message, 'error'); }
};

// Spotify-Suche
F.spSearch = async (f, fd) => {
  if (!S.isConnected()) { toast('Zum Suchen erst unter „Spielen“ mit Spotify verbinden', 'error'); return; }
  st.searchResults = 'loading'; renderSearchResults();
  try { st.searchResults = await S.searchTracks(fd.get('q'), 10); }
  catch (e) { st.searchResults = null; toast(e.message, 'error'); }
  renderSearchResults();
};
function renderSearchResults() {
  const el = $('searchResults');
  if (!el) return;
  const r = st.searchResults;
  if (!r) { el.innerHTML = ''; return; }
  if (r === 'loading') { el.innerHTML = '<p class="muted pad">Suche…</p>'; return; }
  if (!r.length) { el.innerHTML = '<p class="muted pad">Nichts gefunden.</p>'; return; }
  el.innerHTML = r.map((t, i) => `
    <div class="song-row">
      <img class="thumb" src="${esc((t.album.images.slice(-1)[0] || {}).url || '')}" alt="">
      <span class="st"><b>${esc(t.name)}</b><br><span class="muted">${esc(t.artists.map((a) => a.name).join(', '))} · ${esc((t.album.release_date || '').slice(0, 4))}</span></span>
      <button class="btn small-btn" data-act="addFromSearch" data-i="${i}">+</button>
    </div>`).join('');
}
A.addFromSearch = (el) => {
  const t = st.searchResults[+el.dataset.i];
  songDialog({ title: t.name.replace(/\s+-\s+(\d{4} )?(Remaster(ed)?|Mono|Stereo|Single Version|Radio Edit).*$/i, ''),
    artist: t.artists.map((a) => a.name).join(', '), year: parseInt(t.album.release_date, 10) || '', uri: t.external_urls.spotify },
  'Bitte das Jahr prüfen: Spotify zeigt bei Remasters und Best-of-Alben oft ein späteres Jahr an.');
};

// CSV-Import
const HEAD = {
  title: /^(titel|title|song|songtitel|track|trackname|name)$/,
  artist: /^(interpret|artist|artists|künstler|kuenstler|band|sänger|saenger|interpreten)$/,
  year: /^(jahr|year|erscheinungsjahr|releaseyear|veröffentlichung|veroeffentlichung|erscheinungsdatum|releasedate|datum|date)$/,
  uri: /^(spotify|spotifyuri|spotifyurl|spotifylink|uri|url|link)$/,
};
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const data = rows.filter((r) => r.some((c) => c.trim()));
  if (!data.length) return { songs: [], errors: ['Die Datei ist leer'] };
  const key = (h) => h.toLowerCase().replace(/[\s_\-.]/g, '');
  const head = data[0].map(key);
  const idx = {};
  for (const [k, re] of Object.entries(HEAD)) { const i = head.findIndex((h) => re.test(h)); if (i >= 0) idx[k] = i; }
  const hasHeader = 'title' in idx || 'artist' in idx || 'year' in idx;
  if (!hasHeader) Object.assign(idx, { title: 0, artist: 1, year: 2, uri: 3 });
  const songs = [], errors = [];
  data.slice(hasHeader ? 1 : 0).forEach((r, n) => {
    const line = n + (hasHeader ? 2 : 1);
    const title = (r[idx.title] || '').trim(), artist = (r[idx.artist] || '').trim();
    const ym = String(r[idx.year] || '').match(/\b(1\d{3}|20\d{2}|2100)\b/);
    if (!title || !artist || !ym) { errors.push(`Zeile ${line}: ${!title ? 'Titel' : !artist ? 'Interpret' : 'Jahr'} fehlt`); return; }
    songs.push({ title, artist, year: +ym[1], spotify_uri: idx.uri !== undefined ? (r[idx.uri] || '').trim() || null : null });
  });
  return { songs, errors };
}

function csvDialog(target) {
  st.csv = { target, parsed: null, name: '' };
  openDialog(`
    <div class="stack dialog-form">
      <h2>CSV importieren</h2>
      <p class="muted small">Spalten: <b>Titel</b>, <b>Interpret</b>, <b>Erscheinungsjahr</b> (optional <b>Spotify</b>-Link). Trennzeichen ; oder , –
        Excel: „Speichern unter → CSV (Trennzeichen-getrennt)“. Ohne Kopfzeile wird diese Reihenfolge angenommen.</p>
      ${target === 'new' ? '<label>Name des Katalogs <input id="csvName" placeholder="wird aus dem Dateinamen übernommen"></label>' : ''}
      <input type="file" accept=".csv,.txt,text/csv" data-change="csvFile">
      <div id="csvPreview"></div>
      <div class="row end"><button class="btn ghost" data-act="closeDialog">Abbrechen</button>
        <button class="btn" data-act="csvImport" id="csvGo" disabled>Importieren</button></div>
    </div>`);
}
A.importNew = () => csvDialog('new');
A.importInto = () => csvDialog('into');

C.csvFile = async (el) => {
  const file = el.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('windows-1252').decode(buf); }
  const parsed = parseCsv(text);
  st.csv.parsed = parsed;
  const nameEl = $('csvName');
  if (nameEl && !nameEl.value) nameEl.value = file.name.replace(/\.[^.]+$/, '');
  $('csvPreview').innerHTML = `
    <p><b>${fmt(parsed.songs.length)} Songs erkannt</b>${parsed.errors.length ? `, ${parsed.errors.length} Zeilen übersprungen` : ''}</p>
    ${parsed.songs.slice(0, 5).map((s) => `<div class="small">${s.year} · ${esc(s.title)} – ${esc(s.artist)}</div>`).join('')}
    ${parsed.songs.length > 5 ? '<div class="small muted">…</div>' : ''}
    ${parsed.errors.length ? `<details class="small"><summary>Übersprungene Zeilen</summary>${parsed.errors.slice(0, 50).map(esc).join('<br>')}</details>` : ''}`;
  $('csvGo').disabled = !parsed.songs.length;
};

A.csvImport = async (el) => {
  const p = st.csv && st.csv.parsed;
  if (!p || !p.songs.length) return;
  el.disabled = true; el.textContent = 'Importiere…';
  try {
    let id = st.csv.target === 'into' ? st.catalog.id : null;
    if (!id) ({ id } = await srv('POST', '/catalogs', { name: ($('csvName').value || 'Importierter Katalog').trim() }));
    for (let i = 0; i < p.songs.length; i += 1000) await srv('POST', `/catalogs/${id}/songs`, { songs: p.songs.slice(i, i + 1000) });
    closeDialog(); toast(`${fmt(p.songs.length)} Songs importiert`); st.catalogs = null;
    go('#/katalog/' + id);
  } catch (e) { toast(e.message, 'error'); el.disabled = false; el.textContent = 'Importieren'; }
};

// ---------- Drucken ----------
async function viewPrint(id) {
  const c = await loadCatalog(id, true);
  const batches = await srv('GET', `/catalogs/${id}/prints`);
  const printed = c.songs.filter((s) => s.printed).length, left = c.songs.length - printed;
  const per = settings.perPage;
  const sheets = Math.min(5, Math.max(1, Math.ceil(left / per)));
  $('view').innerHTML = `
    <a class="back" href="/#/katalog/${c.id}">‹ ${esc(c.name)}</a>
    <section class="section-head"><h2>Karten drucken</h2>
      <div class="muted small">${fmt(c.songs.length)} Songs · ${fmt(printed)} schon gedruckt · ${fmt(left)} noch nicht gedruckt</div></section>
    <section class="panel">
      <form data-form="print" class="stack">
        <label>Karten pro Seite
          <select name="perPage" data-change="sheetCount">
            ${PRINT_LAYOUTS.map(([n, label]) => `<option value="${n}" ${n === per ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>
        <label>Anzahl Blätter (doppelseitig bedruckt)
          <input name="sheets" type="number" min="1" max="100" value="${sheets}" data-change="sheetCount"></label>
        <div class="muted small" id="sheetInfo">${sheetInfo(sheets, per)}</div>
        <label class="check"><input type="checkbox" name="onlyNew" checked> Nur Songs, die ich noch nicht gedruckt habe</label>
        <label class="check"><input type="checkbox" name="color" checked> Farbige Lösungsseite</label>
        <button class="btn wide">PDF erstellen</button>
      </form>
      <p class="hint">Die Songs werden zufällig ausgewählt und als gedruckt gemerkt. Drucken: <b>beidseitig, an der langen Kante spiegeln</b>,
        Skalierung <b>100 % / Tatsächliche Größe</b>. Danach an den gestrichelten Linien schneiden.</p>
    </section>
    <section class="panel">
      <h3>Bisherige Druckaufträge</h3>
      ${batches.length ? batches.map((b) => `
        <div class="row between song-row">
          <span>${new Date(b.createdAt).toLocaleDateString('de')} · ${b.cards} Karten · ${b.perPage}/Seite${b.color ? '' : ' · s/w'}</span>
          <span class="row">
            <a class="btn small-btn ghost" href="/api/prints/${b.id}.pdf" target="_blank" rel="noopener">PDF</a>
            <button class="btn small-btn ghost danger" data-act="deleteBatch" data-id="${b.id}" title="Songs wieder als ungedruckt markieren">✕</button>
          </span>
        </div>`).join('') : '<p class="muted">Noch nichts gedruckt.</p>'}
      ${batches.length ? '<p class="hint">✕ entfernt den Auftrag; die Songs gelten dann wieder als ungedruckt.</p>' : ''}
    </section>`;
}
function sheetInfo(sheets, per) { return `= ${fmt(sheets * per)} Karten, ${sheets * 2} PDF-Seiten`; }
C.sheetCount = (el) => {
  const f = el.form, per = +f.perPage.value, n = Math.max(1, +f.sheets.value || 1);
  settings.perPage = per; saveSettings();
  $('sheetInfo').textContent = sheetInfo(n, per);
};
F.print = async (f, fd) => {
  const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Erstelle PDF…';
  try {
    const r = await srv('POST', `/catalogs/${st.catalog.id}/prints`, { sheets: +fd.get('sheets'), perPage: +fd.get('perPage'), onlyNew: !!fd.get('onlyNew'), color: !!fd.get('color') });
    const a = document.createElement('a');
    a.href = `/api/prints/${r.id}.pdf?download=1`; a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
    toast(`${r.cards} Karten erstellt${r.remaining ? ` – ${fmt(r.remaining)} Songs noch ungedruckt` : ''}`);
    st.catalogs = null;
    await viewPrint(st.catalog.id);
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'PDF erstellen'; }
};
A.deleteBatch = async (el) => {
  if (!confirm('Druckauftrag entfernen? Die Songs gelten dann wieder als ungedruckt (gedruckte Karten funktionieren weiter).')) return;
  await srv('DELETE', '/prints/' + el.dataset.id).catch((e) => toast(e.message, 'error'));
  await viewPrint(st.catalog.id);
};

// ---------- Einstellungen ----------
function viewSettings() {
  const me = st.me;
  $('view').innerHTML = `
    <section class="section-head"><h2>Einstellungen</h2></section>
    <section class="panel stack">
      <h3>Account</h3>
      <div class="row between"><span>Angemeldet als <b>${esc(me.username)}</b>${me.isAdmin ? ' (Admin)' : ''}</span>
        <button class="btn small-btn ghost" data-act="logout">Abmelden</button></div>
      <details><summary>Passwort ändern</summary>
        <form data-form="changePw" class="stack">
          <label>Altes Passwort <input name="old" type="password" required autocomplete="current-password"></label>
          <label>Neues Passwort <input name="new" type="password" required minlength="8" autocomplete="new-password"></label>
          <button class="btn small-btn">Ändern</button>
        </form>
      </details>
    </section>
    <section class="panel stack">
      <h3>Spotify</h3>
      <div class="row between"><span>${S.isConnected() ? '✓ verbunden' : 'nicht verbunden'}</span>
        ${S.isConnected() ? '<button class="btn small-btn ghost" data-act="spotifyDisconnect">Trennen</button>'
          : (me.spotifyClientId || me.defaultClientId) ? '<button class="btn small-btn green" data-act="spotifyConnect">Verbinden</button>' : ''}</div>
      <label>Wiedergabegerät
        <span class="row"><select data-change="device" id="deviceSel"><option value="">automatisch (dieses Gerät bevorzugt)</option></select>
        <button class="btn small-btn ghost" data-act="loadDevices">↻</button></span></label>
      <details ${me.spotifyClientId || !me.defaultClientId ? 'open' : ''}><summary>Eigene Spotify-App verwenden</summary>
        <p class="small muted">Eine Spotify-App im Entwicklungsmodus erlaubt nur 5 Nutzer, die im Spotify-Dashboard freigeschaltet sein müssen.
          Alternativ kannst du auf <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com</a> eine eigene App anlegen
          (Redirect URI: <code>${esc(S.REDIRECT_URI)}</code>, APIs: Web API + Web Playback SDK) und ihre Client ID hier eintragen.</p>
        <form data-form="clientId" class="row">
          <input name="cid" value="${esc(me.spotifyClientId)}" placeholder="${me.defaultClientId ? 'leer = Standard-App' : 'Client ID'}" spellcheck="false" autocomplete="off">
          <button class="btn small-btn">Speichern</button>
        </form>
      </details>
    </section>
    <section class="panel stack">
      <h3>Spiel</h3>
      <label>Max. Songs pro Jahr <input type="number" min="1" max="50" value="${settings.maxPerYear}" data-change="maxPerYear"></label>
      <div class="row two">
        <label>Von Jahr <input type="number" min="1000" max="2100" value="${esc(settings.from)}" placeholder="alle" data-change="yearFrom"></label>
        <label>Bis Jahr <input type="number" min="1000" max="2100" value="${esc(settings.to)}" placeholder="alle" data-change="yearTo"></label>
      </div>
      <label>Wiedergabe starten
        <select data-change="start">
          <option value="0" ${settings.start === '0' ? 'selected' : ''}>am Anfang</option>
          <option value="30" ${settings.start === '30' ? 'selected' : ''}>nach 30 Sekunden</option>
          <option value="rand" ${settings.start === 'rand' ? 'selected' : ''}>an zufälliger Stelle (0:20–1:20)</option>
        </select></label>
    </section>
    ${me.isAdmin ? `
    <section class="panel stack">
      <h3>Admin</h3>
      <p class="small muted">Standard-Spotify-App für alle Nutzer ohne eigene Client ID. Jeder Spotify-Account muss im Dashboard dieser App unter
        „User Management“ eingetragen sein (max. 5). Redirect URI: <code>${esc(S.REDIRECT_URI)}</code></p>
      <form data-form="defaultClientId" class="row">
        <input name="cid" value="${esc(me.defaultClientId)}" placeholder="Standard Client ID" spellcheck="false" autocomplete="off">
        <button class="btn small-btn">Speichern</button>
      </form>
    </section>` : ''}`;
  if (S.isConnected()) A.loadDevices();
}

A.spotifyDisconnect = () => { S.disconnect(); viewSettings(); };
A.loadDevices = async () => {
  const sel = $('deviceSel');
  if (!sel || !S.isConnected()) return;
  try {
    const ds = await S.fetchDevices();
    sel.innerHTML = '<option value="">automatisch (dieses Gerät bevorzugt)</option>' +
      ds.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${esc(d.type)})${d.is_active ? ' · aktiv' : ''}</option>`).join('');
    if (settings.deviceId && !ds.some((d) => d.id === settings.deviceId)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(settings.deviceId)}">gespeichertes Gerät (offline)</option>`);
    sel.value = settings.deviceId;
  } catch (e) { console.warn(e); }
};
C.device = (el) => { settings.deviceId = el.value; saveSettings(); };
C.maxPerYear = (el) => { settings.maxPerYear = Math.max(1, +el.value || 3); el.value = settings.maxPerYear; saveSettings(); };
C.yearFrom = (el) => { settings.from = el.value ? String(+el.value) : ''; saveSettings(); };
C.yearTo = (el) => { settings.to = el.value ? String(+el.value) : ''; saveSettings(); };
C.start = (el) => { settings.start = el.value; saveSettings(); };

F.changePw = async (f, fd) => {
  try { await srv('PUT', '/me', { oldPassword: fd.get('old'), newPassword: fd.get('new') }); toast('Passwort geändert'); f.reset(); }
  catch (e) { toast(e.message, 'error'); }
};
async function saveClientId(field, value) {
  await srv('PUT', '/me', { [field]: value.trim() });
  st.me = await srv('GET', '/me');
  S.disconnect();
  S.initSpotify({ clientId: st.me.spotifyClientId || st.me.defaultClientId, userId: st.me.id, settings });
  toast('Gespeichert – bitte neu mit Spotify verbinden');
  viewSettings();
}
F.clientId = (f, fd) => saveClientId('spotifyClientId', fd.get('cid')).catch((e) => toast(e.message, 'error'));
F.defaultClientId = (f, fd) => saveClientId('defaultClientId', fd.get('cid')).catch((e) => toast(e.message, 'error'));

// ---------- Start ----------
window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st.retryOnReturn && !st.busy) setTimeout(A.retryPlay, 600);
});

(async function boot() {
  try { st.me = await srv('GET', '/me'); } catch { st.me = null; }
  if (st.me) {
    S.initSpotify({ clientId: st.me.spotifyClientId || st.me.defaultClientId, userId: st.me.id, settings });
    const cb = await S.handleCallback();
    if (cb) {
      if (cb.returnTo && cb.returnTo !== '/') history.replaceState(null, '', cb.returnTo);
      if (cb.error) toast(cb.error, 'error'); else toast('Mit Spotify verbunden');
    }
    S.initSdk();
  }
  route();
})();
