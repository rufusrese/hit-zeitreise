'use strict';

// ---------- Storage ----------
const K = { cfg: 'hz_cfg', tok: 'hz_tok', game: 'hz_game', tracks: 'hz_tracks', pkce: 'hz_pkce' };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const SCOPES = 'user-read-playback-state user-modify-playback-state streaming user-read-email user-read-private';
const REDIRECT_URI = location.origin + location.pathname;
const MIN_YEAR = 1957, MAX_YEAR = 2026;

const cfg = Object.assign(
  { clientId: '', deviceId: '', maxPerYear: 3, from: MIN_YEAR, to: MAX_YEAR, start: '0' },
  load(K.cfg, {})
);
let tok = load(K.tok, null);
let game = load(K.game, null) || newGameState();
const trackCache = load(K.tracks, {});

let ui = { busy: false, paused: !!(game.current && !game.revealed), devices: [] };
let sdkDeviceId = null, sdkPlayer = null;

function newGameState() { return { played: [], yearCounts: {}, current: null, revealed: false, round: 0 }; }
const saveGame = () => save(K.game, game);
const saveCfg = () => save(K.cfg, cfg);

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';

function showMsg(html, type = '') {
  const m = $('msg');
  m.className = 'msg ' + type;
  m.innerHTML = html;
  m.hidden = !html;
}

// ---------- Spotify auth (PKCE) ----------
function randStr(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, (x) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[x % 62]).join('');
}
async function challenge(verifier) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login() {
  if (!cfg.clientId) { openSettings(); return; }
  if (!window.isSecureContext || !crypto.subtle) {
    showMsg('Spotify-Login braucht HTTPS (oder http://127.0.0.1). Bitte die App über eine https-Adresse öffnen.', 'error');
    return;
  }
  const verifier = randStr(64), state = randStr(16);
  save(K.pkce, { verifier, state });
  const p = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: await challenge(verifier), scope: SCOPES, state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + p;
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || 'Token-Fehler ' + r.status);
  tok = {
    access: j.access_token,
    refresh: j.refresh_token || (tok && tok.refresh),
    exp: Date.now() + (j.expires_in - 60) * 1000,
  };
  save(K.tok, tok);
}

async function handleCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI);
  if (p.get('error')) { showMsg('Spotify-Login abgebrochen: ' + esc(p.get('error')), 'error'); return; }
  const pk = load(K.pkce, null);
  localStorage.removeItem(K.pkce);
  if (!pk || pk.state !== p.get('state')) { showMsg('Login-Status passt nicht, bitte erneut verbinden.', 'error'); return; }
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: REDIRECT_URI, code_verifier: pk.verifier });
  } catch (e) { showMsg('Login fehlgeschlagen: ' + esc(e.message), 'error'); }
}

async function accessToken() {
  if (!tok) throw new Error('Nicht mit Spotify verbunden');
  if (Date.now() > tok.exp) {
    try { await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh }); }
    catch (e) { logout(); throw new Error('Spotify-Sitzung abgelaufen – bitte neu verbinden.'); }
  }
  return tok.access;
}

function logout() {
  tok = null; localStorage.removeItem(K.tok);
  if (sdkPlayer) { sdkPlayer.disconnect(); sdkPlayer = null; sdkDeviceId = null; }
  if ($('settings').open) renderAuthStatus();
  render();
}

class ApiError extends Error { constructor(status, msg, reason) { super(msg); this.status = status; this.reason = reason; } }

async function api(method, path, body, retry = true) {
  const r = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await accessToken()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) { tok.exp = 0; return api(method, path, body, false); }
  if (r.status === 429 && retry) {
    const wait = Math.min(+(r.headers.get('Retry-After') || 2), 10);
    await new Promise((res) => setTimeout(res, wait * 1000));
    return api(method, path, body, false);
  }
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) {
    const e = (j && j.error) || {};
    throw new ApiError(r.status, e.message || ('HTTP ' + r.status), e.reason);
  }
  return j;
}

// ---------- Web Playback SDK (works in desktop browsers, not on phones) ----------
function initSdk() {
  if (sdkPlayer || !tok || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;
  window.onSpotifyWebPlaybackSDKReady = () => {
    sdkPlayer = new Spotify.Player({
      name: 'Hit-Zeitreise (Browser)',
      getOAuthToken: (cb) => accessToken().then(cb).catch(() => {}),
      volume: 0.8,
    });
    sdkPlayer.addListener('ready', ({ device_id }) => { sdkDeviceId = device_id; });
    sdkPlayer.addListener('not_ready', () => { sdkDeviceId = null; });
    sdkPlayer.connect();
  };
  const s = document.createElement('script');
  s.src = 'https://sdk.scdn.co/spotify-player.js';
  document.head.appendChild(s);
}

// ---------- Devices & playback ----------
async function fetchDevices() {
  const j = await api('GET', '/me/player/devices');
  ui.devices = (j && j.devices) || [];
  return ui.devices;
}

async function pickDevice() {
  const ds = await fetchDevices();
  return (
    ds.find((d) => d.id === cfg.deviceId) ||
    ds.find((d) => d.is_active) ||
    ds.find((d) => d.type === 'Smartphone') ||
    ds.find((d) => d.id === sdkDeviceId) ||
    ds[0] || null
  );
}

class NoDevice extends Error {}

async function playUri(uri) {
  if (sdkPlayer && sdkPlayer.activateElement) { try { await sdkPlayer.activateElement(); } catch {} }
  const dev = await pickDevice();
  if (!dev) throw new NoDevice();
  let pos = 0;
  if (cfg.start === '30') pos = 30000;
  else if (cfg.start === 'rand') pos = 20000 + Math.floor(Math.random() * 60000);
  await api('PUT', '/me/player/play?device_id=' + encodeURIComponent(dev.id), { uris: [uri], position_ms: pos });
  ui.deviceName = dev.name;
  ui.paused = false;
}

async function pause() {
  await api('PUT', '/me/player/pause');
  ui.paused = true;
}
async function resume() {
  await api('PUT', '/me/player/play');
  ui.paused = false;
}

// ---------- Track matching ----------
function norm(s, keepParens) {
  let t = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  if (!keepParens) t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  t = t.replace(/\s+-\s+.*$/, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  return t || (keepParens ? '' : norm(s, true));
}
const ARTIST_SPLIT = /\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|und|and|mit|presents|pres\.)\s+|\s*,\s*|\s+\/\s+|\s+\+\s+/i;
function artistParts(a) { return a.split(ARTIST_SPLIT).map((x) => norm(x)).filter(Boolean); }

const BAD = /\b(live|remix|karaoke|instrumental|cover|tribute|re-?recorded|acoustic|rehearsal|demo|sped up|slowed|made famous|in the style)\b/i;

function scoreTrack(t, song) {
  const [year, artist, title] = song;
  const titles = title.split(' / ').map((x) => norm(x)).filter(Boolean);
  const nr = norm(t.name);
  const titleOk = titles.some((nt) => nt === nr || (nt.length > 3 && nr.length > 3 && (nr.startsWith(nt) || nt.startsWith(nr))));
  if (!titleOk) return -1;
  const parts = artistParts(artist), full = norm(artist);
  const ras = t.artists.map((a) => norm(a.name));
  const artistOk = ras.some((ra) => ra && (parts.includes(ra) || full.includes(ra) || ra.includes(parts[0])));
  if (!artistOk) return -1;
  let s = 100;
  if (titles.some((nt) => nt === nr)) s += 10;
  if (BAD.test(t.name + ' ' + t.album.name) && !BAD.test(title)) s -= 40;
  if (t.album.album_type === 'compilation') s -= 8;
  const ay = parseInt(t.album.release_date, 10);
  if (ay) {
    if (ay < year - 1) s -= 25;
    else s -= Math.min(Math.abs(ay - year), 40) * 0.6;
  }
  return s;
}

async function searchTracks(q) {
  const j = await api('GET', '/search?type=track&limit=10&market=from_token&q=' + encodeURIComponent(q));
  return (j && j.tracks && j.tracks.items) || [];
}

async function resolveTrack(song) {
  const key = song[1] + '|' + song[2];
  if (key in trackCache) return trackCache[key];
  const title = song[2].split(' / ')[0].replace(/\([^)]*\)/g, ' ').replace(/["']/g, ' ').replace(/\s+/g, ' ').trim() || song[2];
  const primary = song[1].split(ARTIST_SPLIT)[0].replace(/["']/g, ' ').trim();
  const queries = [`track:${title} artist:${primary}`, `${title} ${primary}`];
  let best = null, bestScore = 0;
  for (const q of queries) {
    for (const t of await searchTracks(q)) {
      const sc = scoreTrack(t, song);
      if (sc > bestScore) { best = t; bestScore = sc; }
    }
    if (bestScore >= 90) break;
  }
  const res = best ? {
    uri: best.uri,
    name: best.name,
    artists: best.artists.map((a) => a.name).join(', '),
    img: (best.album.images.slice(-2)[0] || {}).url || '',
  } : null;
  trackCache[key] = res;
  save(K.tracks, trackCache);
  return res;
}

// ---------- Game logic ----------
function inRange(y) { return y >= cfg.from && y <= cfg.to; }

function candidates() {
  const played = new Set(game.played);
  const out = [];
  for (let i = 0; i < SONGS.length; i++) {
    const s = SONGS[i];
    if (played.has(i) || !inRange(s[0])) continue;
    if ((game.yearCounts[s[0]] || 0) >= cfg.maxPerYear) continue;
    if (trackCache[s[1] + '|' + s[2]] === null) continue;
    out.push(i);
  }
  return out;
}

async function nextSong() {
  if (ui.busy) return;
  if (!tok) { login(); return; }
  ui.busy = true; showMsg(''); render();
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const c = candidates();
      if (!c.length) { game.current = null; showMsg('Keine Songs mehr übrig – alle Jahre sind voll. Starte ein neues Spiel in den Einstellungen.'); break; }
      const i = c[Math.floor(Math.random() * c.length)];
      const tr = await resolveTrack(SONGS[i]);
      if (!tr) continue; // not on Spotify -> try another
      game.played.push(i);
      game.current = { i, ...tr };
      game.revealed = false;
      game.round++;
      saveGame();
      await playCurrent();
      break;
    }
  } catch (e) { handleError(e); }
  ui.busy = false;
  render();
}

async function playCurrent() {
  try {
    await playUri(game.current.uri);
    showMsg('');
  } catch (e) { handleError(e); }
}

function handleError(e) {
  console.error(e);
  if (e instanceof NoDevice || (e instanceof ApiError && e.status === 404)) {
    showMsg(`<b>Kein aktives Spotify-Gerät gefunden.</b><br>Öffne die Spotify-App (einmal kurz irgendwas abspielen &amp; pausieren), komm zurück und tippe auf „Nochmal“.
      <div class="btn-row"><a class="btn small-btn green" href="spotify:" style="text-decoration:none">Spotify öffnen</a>
      <button class="btn small-btn ghost" onclick="retryPlay()">Nochmal</button></div>`, 'error');
  } else if (e instanceof ApiError && e.status === 403) {
    showMsg('Spotify verweigert die Wiedergabe (' + esc(e.message) + '). Für die Steuerung ist Spotify Premium nötig.', 'error');
  } else if (e instanceof ApiError && e.reason === 'QUOTA_EXCEEDED') {
    showMsg('Spotify-API-Limit erreicht. Bitte ein paar Minuten warten.', 'error');
  } else {
    showMsg('Fehler: ' + esc(e.message || e), 'error');
  }
}

async function retryPlay() {
  if (!game.current) return nextSong();
  ui.busy = true; render();
  await playCurrent();
  ui.busy = false; render();
}

function reveal() {
  if (!game.current || game.revealed) return;
  const y = SONGS[game.current.i][0];
  game.yearCounts[y] = (game.yearCounts[y] || 0) + 1;
  game.revealed = true;
  saveGame();
  ui.justRevealed = true;
  render();
  ui.justRevealed = false;
}

async function skip() {
  // Song gilt als gespielt (kommt nicht wieder), das Jahr wird aber nicht gezählt.
  await nextSong();
}

async function togglePause() {
  try { ui.paused ? await resume() : await pause(); } catch (e) { handleError(e); }
  render();
}

async function restart() {
  if (game.current) { ui.busy = true; render(); await playCurrent(); ui.busy = false; render(); }
}

function newGame() {
  if (!confirm('Neues Spiel starten? Gespielte Songs und Jahreszähler werden zurückgesetzt.')) return;
  game = newGameState(); saveGame(); showMsg('');
  api('PUT', '/me/player/pause').catch(() => {});
  $('settings').close();
  render();
}

// ---------- Rendering ----------
function render() {
  const st = $('stage');
  const full = Object.entries(game.yearCounts).filter(([y, n]) => n >= cfg.maxPerYear && inRange(+y)).length;
  $('stats').textContent = game.round ? `Runde ${game.round} · ${full} Jahre voll` : '';

  if (!cfg.clientId || !tok) {
    st.innerHTML = `<div class="setup">
      <div class="title-lg">Mit Spotify verbinden</div>
      ${cfg.clientId ? '' : `<ol>
        <li>Auf <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> eine App erstellen (API: „Web API“ + „Web Playback SDK“).</li>
        <li>Als Redirect URI eintragen:<br><code>${esc(REDIRECT_URI)}</code></li>
        <li>Die Client ID in den Einstellungen (⚙) einfügen.</li>
      </ol>`}
      <p class="muted">Spotify Premium wird benötigt.</p>
      <button class="btn wide green" onclick="${cfg.clientId ? 'login()' : 'openSettings()'}">${cfg.clientId ? 'Mit Spotify verbinden' : 'Client ID eintragen'}</button>
    </div>`;
  } else if (!game.current) {
    st.innerHTML = `
      <button class="big-play" onclick="nextSong()" ${ui.busy ? 'disabled' : ''} aria-label="Zufälligen Song spielen">${ICON_PLAY}</button>
      <div class="title-lg">${ui.busy ? 'Suche Song…' : 'Zufälligen Song spielen'}</div>
      <div class="muted">${SONGS.length.toLocaleString('de')} Top-5-Hits · ${cfg.from}–${cfg.to}</div>`;
  } else if (!game.revealed) {
    st.innerHTML = `
      <div class="eq ${ui.paused || ui.busy ? 'paused' : ''}"><span></span><span></span><span></span><span></span><span></span></div>
      <div class="title-lg">${ui.busy ? 'Lädt…' : ui.paused ? 'Pausiert' : 'Song läuft…'}</div>
      <div class="muted small">${ui.deviceName ? 'auf ' + esc(ui.deviceName) : ''}</div>
      <button class="btn wide" onclick="reveal()">Auflösen</button>
      <div class="btn-row">
        <button class="btn ghost" onclick="togglePause()">${ui.paused ? '▶ Weiter' : '❚❚ Pause'}</button>
        <button class="btn ghost" onclick="restart()">↺ Von vorn</button>
      </div>
      <button class="link" onclick="skip()">Song überspringen (zählt nicht)</button>`;
  } else {
    const [year, artist, title] = SONGS[game.current.i];
    const c = game.current;
    st.innerHTML = `
      <div class="card ${c.img ? 'cover' : ''} ${ui.justRevealed ? 'anim' : ''}">
        <img src="${esc(c.img)}" alt="">
        <div class="artist">${esc(artist)}</div>
        <div class="year">${year}</div>
        <div class="song">${esc(title)}</div>
        <div class="meta">Spotify: ${esc(c.name)} – ${esc(c.artists)}</div>
      </div>
      <button class="btn wide" onclick="nextSong()" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Suche Song…' : 'Nächster Song ▶'}</button>
      <div class="btn-row">
        <button class="btn ghost" onclick="togglePause()">${ui.paused ? '▶ Weiter' : '❚❚ Pause'}</button>
      </div>`;
  }
  renderYears();
}

function renderYears() {
  const g = $('yearGrid');
  let html = '', used = 0, totalCards = 0;
  for (let y = MIN_YEAR; y <= MAX_YEAR; y++) {
    const n = game.yearCounts[y] || 0;
    used += n;
    if (inRange(y)) totalCards += cfg.maxPerYear;
    const cls = !inRange(y) ? 'off' : n >= cfg.maxPerYear ? 'full' : n ? 'c' + Math.min(n, 2) : '';
    html += `<div class="${cls}">${y}<b>${n}/${cfg.maxPerYear}</b></div>`;
  }
  g.innerHTML = html;
  $('yearsSummary').textContent = `(${used} von ${totalCards} vergeben)`;
}

// ---------- Settings ----------
function openSettings() {
  $('cfgClientId').value = cfg.clientId;
  $('cfgMaxPerYear').value = cfg.maxPerYear;
  $('cfgFrom').value = cfg.from;
  $('cfgTo').value = cfg.to;
  $('cfgStart').value = cfg.start;
  $('redirectUri').textContent = REDIRECT_URI;
  renderAuthStatus();
  renderPoolInfo();
  $('settings').showModal();
  if (tok) refreshDeviceList();
}

function renderAuthStatus() {
  $('authStatus').textContent = tok ? '✓ verbunden' : 'nicht verbunden';
  $('btnLogin').hidden = !!tok;
  $('btnLogout').hidden = !tok;
}

function renderPoolInfo() {
  const n = SONGS.filter((s) => inRange(s[0])).length;
  $('poolInfo').textContent = `${n.toLocaleString('de')} Songs im gewählten Zeitraum.`;
}

async function refreshDeviceList() {
  const sel = $('cfgDevice');
  try {
    const ds = await fetchDevices();
    sel.innerHTML = '<option value="">automatisch</option>' +
      ds.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${esc(d.type)})${d.is_active ? ' · aktiv' : ''}</option>`).join('');
    if (cfg.deviceId && !ds.some((d) => d.id === cfg.deviceId)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(cfg.deviceId)}">gespeichertes Gerät (gerade offline)</option>`);
    }
    sel.value = cfg.deviceId;
  } catch (e) { console.error(e); }
}

function clampYear(v, d) { v = parseInt(v, 10); return isNaN(v) ? d : Math.max(MIN_YEAR, Math.min(MAX_YEAR, v)); }

function bindSettings() {
  $('btnSettings').onclick = openSettings;
  $('cfgClientId').onchange = (e) => { cfg.clientId = e.target.value.trim(); saveCfg(); render(); };
  $('cfgMaxPerYear').onchange = (e) => { cfg.maxPerYear = Math.max(1, parseInt(e.target.value, 10) || 3); e.target.value = cfg.maxPerYear; saveCfg(); render(); };
  $('cfgFrom').onchange = (e) => { cfg.from = clampYear(e.target.value, MIN_YEAR); if (cfg.from > cfg.to) cfg.to = cfg.from; saveCfg(); openSettingsRefresh(); };
  $('cfgTo').onchange = (e) => { cfg.to = clampYear(e.target.value, MAX_YEAR); if (cfg.to < cfg.from) cfg.from = cfg.to; saveCfg(); openSettingsRefresh(); };
  $('cfgStart').onchange = (e) => { cfg.start = e.target.value; saveCfg(); };
  $('cfgDevice').onchange = (e) => { cfg.deviceId = e.target.value; saveCfg(); };
  $('btnDevices').onclick = refreshDeviceList;
  $('btnLogin').onclick = () => { cfg.clientId = $('cfgClientId').value.trim(); saveCfg(); login(); };
  $('btnLogout').onclick = () => { logout(); renderAuthStatus(); };
  $('btnNewGame').onclick = newGame;
  $('btnCopyRedirect').onclick = () => navigator.clipboard && navigator.clipboard.writeText(REDIRECT_URI);
  $('settings').addEventListener('close', render);
}
function openSettingsRefresh() { $('cfgFrom').value = cfg.from; $('cfgTo').value = cfg.to; renderPoolInfo(); render(); }

// ---------- Boot ----------
(async function boot() {
  bindSettings();
  render();
  await handleCallback();
  render();
  initSdk();
})();
