// Spotify: Login (PKCE), Wiedergabe (Web API + Web Playback SDK) und Song-Suche
const SCOPES = 'user-read-playback-state user-modify-playback-state streaming user-read-email user-read-private';
export const REDIRECT_URI = location.origin + '/';
const PKCE_KEY = 'hz_pkce';

const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export const sp = {
  clientId: '', tokKey: '', tok: null,
  sdkPlayer: null, sdkDeviceId: null, sdkFailed: false,
  deviceId: '', deviceName: '', paused: false,
  settings: { deviceId: '', start: '0' },
};

export class ApiError extends Error { constructor(status, msg, reason) { super(msg); this.status = status; this.reason = reason; } }
export class NoDevice extends Error {}

export function initSpotify({ clientId, userId, settings }) {
  sp.clientId = clientId || '';
  sp.tokKey = 'hz_sp_tok_' + userId;
  sp.settings = settings;
  const t = load(sp.tokKey, null);
  sp.tok = t && t.clientId === sp.clientId ? t : null;
}

export const isConnected = () => !!sp.tok;

// ---------- Login ----------
function randStr(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, (x) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[x % 62]).join('');
}
async function challenge(verifier) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function connect(returnTo) {
  if (!sp.clientId) throw new Error('Keine Spotify Client ID eingerichtet');
  if (!window.isSecureContext || !crypto.subtle) throw new Error('Spotify-Login braucht HTTPS');
  const verifier = randStr(64), state = randStr(16);
  save(PKCE_KEY, { verifier, state, returnTo: returnTo || '/', clientId: sp.clientId });
  const p = new URLSearchParams({
    client_id: sp.clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: await challenge(verifier), scope: SCOPES, state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + p;
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: sp.clientId, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || 'Token-Fehler ' + r.status);
  sp.tok = {
    access: j.access_token,
    refresh: j.refresh_token || (sp.tok && sp.tok.refresh),
    exp: Date.now() + (j.expires_in - 60) * 1000,
    clientId: sp.clientId,
  };
  save(sp.tokKey, sp.tok);
}

/** Verarbeitet ?code=… nach dem Spotify-Login. Gibt {returnTo, error} zurück oder null. */
export async function handleCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return null;
  history.replaceState(null, '', '/');
  const pk = load(PKCE_KEY, null);
  localStorage.removeItem(PKCE_KEY);
  const returnTo = (pk && pk.returnTo) || '/';
  if (p.get('error')) return { returnTo, error: 'Spotify-Login abgebrochen: ' + p.get('error') };
  if (!pk || pk.state !== p.get('state')) return { returnTo, error: 'Login-Status passt nicht, bitte erneut verbinden.' };
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: REDIRECT_URI, code_verifier: pk.verifier });
    return { returnTo };
  } catch (e) { return { returnTo, error: 'Login fehlgeschlagen: ' + e.message }; }
}

async function accessToken() {
  if (!sp.tok) throw new Error('Nicht mit Spotify verbunden');
  if (Date.now() > sp.tok.exp) {
    try { await tokenRequest({ grant_type: 'refresh_token', refresh_token: sp.tok.refresh }); }
    catch { disconnect(); throw new Error('Spotify-Sitzung abgelaufen – bitte neu verbinden.'); }
  }
  return sp.tok.access;
}

export function disconnect() {
  sp.tok = null;
  try { localStorage.removeItem(sp.tokKey); } catch {}
  if (sp.sdkPlayer) { sp.sdkPlayer.disconnect(); sp.sdkPlayer = null; sp.sdkDeviceId = null; }
}

export async function api(method, path, body, retry = true) {
  const r = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await accessToken()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) { sp.tok.exp = 0; return api(method, path, body, false); }
  if (r.status === 429 && retry) {
    await sleep(Math.min(+(r.headers.get('Retry-After') || 2), 10) * 1000);
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

// ---------- Web Playback SDK (spielt direkt im Browser) ----------
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Das SDK startet in Chrome auf Android offenbar nur, wenn sich der Browser als Desktop ausgibt
// (so wie bei "Desktopwebsite"). Daher nur für das SDK eine Desktop-Kennung vortäuschen.
function spoofDesktopUA() {
  const desktopUA = navigator.userAgent
    .replace(/\(Linux; Android[^)]*\)/, '(X11; Linux x86_64)')
    .replace(/\(i(Phone|Pad|Pod)[^)]*\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
    .replace(/ Mobile( Safari)?/, '$1');
  const def = (obj, key, val) => { try { Object.defineProperty(obj, key, { get: () => val, configurable: true }); } catch {} };
  def(navigator, 'userAgent', desktopUA);
  def(navigator, 'appVersion', desktopUA.replace(/^Mozilla\//, ''));
  def(navigator, 'platform', 'Linux x86_64');
  def(navigator, 'maxTouchPoints', 0);
  if (navigator.userAgentData) {
    const uad = navigator.userAgentData;
    def(navigator, 'userAgentData', {
      brands: uad.brands, mobile: false, platform: 'Linux',
      getHighEntropyValues: (h) => uad.getHighEntropyValues(h).then((v) => ({ ...v, mobile: false, platform: 'Linux' })),
      toJSON: () => ({ brands: uad.brands, mobile: false, platform: 'Linux' }),
    });
  }
}

export function initSdk() {
  if (sp.sdkPlayer || !sp.tok || window.onSpotifyWebPlaybackSDKReady) return;
  if (IS_MOBILE) spoofDesktopUA();
  window.onSpotifyWebPlaybackSDKReady = () => {
    sp.sdkPlayer = new window.Spotify.Player({
      name: 'Hit-Zeitreise (dieses Gerät)',
      getOAuthToken: (cb) => accessToken().then(cb).catch(() => {}),
      volume: 0.9,
    });
    const fail = (e) => { console.warn('SDK', e); sp.sdkFailed = true; };
    sp.sdkPlayer.addListener('ready', ({ device_id }) => { sp.sdkDeviceId = device_id; sp.sdkFailed = false; });
    sp.sdkPlayer.addListener('not_ready', () => { sp.sdkDeviceId = null; });
    sp.sdkPlayer.addListener('initialization_error', fail);
    sp.sdkPlayer.addListener('account_error', fail);
    sp.sdkPlayer.connect().then((ok) => { if (!ok) sp.sdkFailed = true; });
  };
  const s = document.createElement('script');
  s.src = 'https://sdk.scdn.co/spotify-player.js';
  s.onerror = () => { sp.sdkFailed = true; };
  document.head.appendChild(s);
}

// Muss direkt im Tipp-Handler (vor dem ersten await) laufen, sonst blockiert der Browser den Ton.
export function unlockAudio() {
  if (sp.sdkPlayer && sp.sdkPlayer.activateElement) sp.sdkPlayer.activateElement().catch(() => {});
}

async function waitForSdk(ms) {
  const end = Date.now() + ms;
  while (!sp.sdkDeviceId && !sp.sdkFailed && Date.now() < end) await sleep(200);
}

// ---------- Geräte & Wiedergabe ----------
export async function fetchDevices() {
  const j = await api('GET', '/me/player/devices');
  return (j && j.devices) || [];
}

async function pickDevice() {
  const want = sp.settings.deviceId;
  if (!want) await waitForSdk(5000);
  const ds = await fetchDevices();
  const sdk = sp.sdkDeviceId && { id: sp.sdkDeviceId, name: 'diesem Gerät (Browser)' };
  return (
    ds.find((d) => d.id === want) ||
    (want && want === sp.sdkDeviceId && sdk) ||
    sdk ||
    ds.find((d) => d.is_active) ||
    ds.find((d) => d.type === 'Smartphone') ||
    ds[0] || null
  );
}

// 403 "Restriction violated", 404 und 502 bekommt man v. a. von der Android-App, wenn sie im
// Hintergrund nicht aktiv ist. Wiedergabe dann erst auf das Gerät übertragen und erneut versuchen.
export const isWakeable = (e) => e instanceof ApiError && [403, 404, 502].includes(e.status);

export async function playUri(uri) {
  const dev = await pickDevice();
  if (!dev) throw new NoDevice();
  let pos = 0;
  if (sp.settings.start === '30') pos = 30000;
  else if (sp.settings.start === 'rand') pos = 20000 + Math.floor(Math.random() * 60000);
  const play = () => api('PUT', '/me/player/play?device_id=' + encodeURIComponent(dev.id), { uris: [uri], position_ms: pos });
  try {
    await play();
  } catch (e) {
    if (!isWakeable(e)) throw e;
    await api('PUT', '/me/player', { device_ids: [dev.id], play: false }).catch(() => {});
    await sleep(800);
    try { await play(); }
    catch (e2) {
      if (!isWakeable(e2)) throw e2;
      await sleep(1500);
      await play();
    }
  }
  sp.deviceId = dev.id;
  sp.deviceName = dev.name;
  sp.paused = false;
}

async function playerIsPlaying() {
  const st = await api('GET', '/me/player').catch(() => null);
  return st ? !!st.is_playing : null;
}

// Pause/Weiter: Ist der Player schon im gewünschten Zustand, meldet Spotify 403 – dann nur den Status übernehmen.
export async function setPlaying(wanted, currentUri) {
  const q = sp.deviceId ? '?device_id=' + encodeURIComponent(sp.deviceId) : '';
  try {
    await api('PUT', '/me/player/' + (wanted ? 'play' : 'pause') + q);
  } catch (e) {
    if (!isWakeable(e)) throw e;
    await sleep(500);
    const now = await playerIsPlaying();
    if (now !== wanted) {
      if (wanted && currentUri) { await playUri(currentUri); return; }
      if (now !== null) throw e;
    }
  }
  sp.paused = !wanted;
}

export function stopPlayback() {
  if (sp.tok) api('PUT', '/me/player/pause').catch(() => {});
}

// ---------- Suche & Zuordnung ----------
function norm(s, keepParens) {
  let t = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  if (!keepParens) t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  t = t.replace(/\s+-\s+.*$/, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  return t || (keepParens ? '' : norm(s, true));
}
const ARTIST_SPLIT = /\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|und|and|mit|presents|pres\.)\s+|\s*,\s*|\s+\/\s+|\s+\+\s+/i;
const artistParts = (a) => a.split(ARTIST_SPLIT).map((x) => norm(x)).filter(Boolean);
const BAD = /\b(live|remix|karaoke|instrumental|cover|tribute|re-?recorded|acoustic|rehearsal|demo|sped up|slowed|made famous|in the style)\b/i;

function scoreTrack(t, song) {
  const titles = song.title.split(' / ').map((x) => norm(x)).filter(Boolean);
  const nr = norm(t.name);
  const titleOk = titles.some((nt) => nt === nr || (nt.length > 3 && nr.length > 3 && (nr.startsWith(nt) || nt.startsWith(nr))));
  if (!titleOk) return -1;
  const parts = artistParts(song.artist), full = norm(song.artist);
  const artistOk = t.artists.map((a) => norm(a.name)).some((ra) => ra && (parts.includes(ra) || full.includes(ra) || ra.includes(parts[0])));
  if (!artistOk) return -1;
  let s = 100;
  if (titles.some((nt) => nt === nr)) s += 10;
  if (BAD.test(t.name + ' ' + t.album.name) && !BAD.test(song.title)) s -= 40;
  if (t.album.album_type === 'compilation') s -= 8;
  const ay = parseInt(t.album.release_date, 10);
  if (ay) s -= ay < song.year - 1 ? 25 : Math.min(Math.abs(ay - song.year), 40) * 0.6;
  return s;
}

export async function searchTracks(q, limit = 10) {
  const j = await api('GET', `/search?type=track&limit=${limit}&market=from_token&q=` + encodeURIComponent(q));
  return (j && j.tracks && j.tracks.items) || [];
}

/** Sucht den passenden Spotify-Track zu {year, artist, title}. Gibt die URI zurück oder null. */
export async function resolveSong(song) {
  const title = song.title.split(' / ')[0].replace(/\([^)]*\)/g, ' ').replace(/["']/g, ' ').replace(/\s+/g, ' ').trim() || song.title;
  const primary = song.artist.split(ARTIST_SPLIT)[0].replace(/["']/g, ' ').trim();
  let best = null, bestScore = 0;
  for (const q of [`track:${title} artist:${primary}`, `${title} ${primary}`]) {
    for (const t of await searchTracks(q)) {
      const sc = scoreTrack(t, song);
      if (sc > bestScore) { best = t; bestScore = sc; }
    }
    if (bestScore >= 90) break;
  }
  return best ? best.uri : null;
}

export async function trackInfo(uri) {
  const id = String(uri).split(':').pop();
  const t = await api('GET', '/tracks/' + id + '?market=from_token');
  return { name: t.name, artists: t.artists.map((a) => a.name).join(', '), img: (t.album.images.slice(-2)[0] || {}).url || '' };
}
