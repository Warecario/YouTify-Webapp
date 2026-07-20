/* ============================================================
   YouTify — configuration

   No API keys live in this file. All Spotify/YouTube calls go
   through a Cloudflare Worker proxy that holds the real
   credentials server-side (see worker.js). Point this at your
   deployed Worker's URL — no trailing slash:

     "https://youtify-proxy.yourname.workers.dev"
   ============================================================ */
const PROXY_BASE_URL = "https://youtify-proxy.youtify.workers.dev";

/* ============================================================
   Spotify user login (Authorization Code + PKCE)

   This flow needs no client secret — it's designed to run
   safely in the browser. Fill in the same Client ID your
   Worker uses (from the Spotify Dashboard).

   IMPORTANT: in the Spotify Dashboard, under your app's
   Settings → Redirect URIs, add the exact URL this page
   will be hosted at, e.g.:
     https://warecario.github.io/YouTify-Webapp/
   It must match EXACTLY (trailing slash included or not,
   matching whatever you register).

   Development Mode cap: only accounts you've explicitly
   added under Dashboard → User Management (up to 5) can
   actually log in and see playlists — this is a Spotify
   platform restriction, not something this code controls.
   ============================================================ */
const SPOTIFY_CLIENT_ID = "40fff33a4ef84ee38d6384928a605538";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative user-library-read";

let spotifyAccessToken = null;
let spotifyRefreshToken = null;
let currentPlaylistContext = null; // { id, name } or null when playing from search
let pendingRestoreTrack = null;
let pendingRestorePosition = 0;

/* ---------- Icon set (SVG, no emoji) ---------- */
const ICONS = {
  play: `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="4" y="4" width="2.5" height="16"/><path d="M20 4v16L8 12z"/></svg>`,
  next: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="17.5" y="4" width="2.5" height="16"/><path d="M4 4v16l12-8z"/></svg>`,
  shuffle: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h3.5c2 0 3.2 1 4.2 2.5M3 18h3.5c2 0 3.2-1 4.2-2.5M14 6h3.5c2 0 3.2 1 4.2 2.5M14 18h3.5c2 0 3.2-1 4.2-2.5"/><path d="M18 3l3 3-3 3M18 15l3 3-3 3"/></svg>`,
  repeat: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a3 3 0 0 1 3-3h11M18 4v4M20 17a3 3 0 0 1-3 3H6M6 20v-4"/></svg>`,
  repeatOne: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a3 3 0 0 1 3-3h11M18 4v4M20 17a3 3 0 0 1-3 3H6M6 20v-4"/><text x="10.5" y="16" font-size="8" fill="currentColor" stroke="none" font-family="sans-serif">1</text></svg>`,
  volHigh: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  volMid: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  volMute: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

/* ---------- Cookie helpers ----------
   Cookies persist across visits on the real deployed site. This is
   client-side-only storage — fine for your own accent preference and
   your own Spotify tokens, since nothing here is shared with anyone
   else visiting the page. */

function setCookie(name, value, days){
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}
function getCookie(name){
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function deleteCookie(name){
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`;
}

function saveNowPlayingCookie(track){
  setCookie('youtify_last_track', JSON.stringify({
    name: track.name,
    artists: track.artists,
    images: track.album.images,
    external_url: track.external_url,
  }), 30);
  if (currentPlaylistContext){
    setCookie('youtify_last_playlist', JSON.stringify(currentPlaylistContext), 30);
  } else {
    deleteCookie('youtify_last_playlist');
  }
}

/* ---------- Track Select overrides ----------
   Lets a wrong YouTube match (or a specific remix/lyric video) be
   manually corrected, remembered per-track via a cookie so it sticks
   every time that song plays again. */

function trackKey(title, artist){
  return `${artist}`.toLowerCase().trim() + '::' + `${title}`.toLowerCase().trim();
}

function getVideoOverrides(){
  const raw = getCookie('youtify_video_overrides');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (_) { return {}; }
}

function getVideoOverride(title, artist){
  const map = getVideoOverrides();
  return map[trackKey(title, artist)] || null;
}

function setVideoOverride(title, artist, videoId){
  const map = getVideoOverrides();
  const key = trackKey(title, artist);
  delete map[key]; // re-insert at the end so eviction stays LRU-ish
  map[key] = videoId;

  // Cookies are capped around 4KB — trim oldest entries if we're
  // getting close, rather than letting the write silently fail.
  let keys = Object.keys(map);
  while (JSON.stringify(map).length > 3500 && keys.length > 1){
    delete map[keys.shift()];
    keys = Object.keys(map);
  }
  setCookie('youtify_video_overrides', JSON.stringify(map), 365);
}

const ACCENT_COLORS = [
  { name: "Spotify green", value: "#1DB954" },
  { name: "Electric blue",  value: "#3D8BFF" },
  { name: "Violet",         value: "#B15CFF" },
  { name: "Amber",          value: "#FFB020" },
  { name: "Hot pink",       value: "#FF4D8D" },
  { name: "Teal",           value: "#1FC8B0" },
  { name: "Crimson",        value: "#E8384F" },
  { name: "Lime",           value: "#9BE536" },
  { name: "Cyan",           value: "#31D4E8" },
  { name: "Coral",          value: "#FF6B4A" },
  { name: "Indigo",         value: "#6C5CE7" },
  { name: "Gold",           value: "#E8C547" },
  { name: "Magenta",        value: "#D6409F" },
  { name: "Mint",           value: "#3DDC97" },
  { name: "Slate",          value: "#8B95A5" },
];

let ytPlayer = null;
let progressTimer = null;
let currentDuration = 0;

let currentResults = [];
let currentIndex = -1;
let shuffleOn = false;
let repeatMode = 'off'; // 'off' | 'all' | 'one'
let shuffleOrder = []; // indices into currentResults, used when shuffleOn
let historyStack = []; // indices actually played, most recent last — powers real "back"
let forwardStack = []; // indices to redo forward into after going back
let recentlyPlayed = []; // last few tracks played this session, independent of the current queue
let cachedUserPlaylists = []; // last fetched /me/playlists items, used to render the Home grid

const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const homeViewEl = document.getElementById('homeView');
const queryEl = document.getElementById('query');
const playerBarEl = document.getElementById('player-bar');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');
const volumeSlider = document.getElementById('volumeSlider');
const volumeIcon = document.getElementById('volumeIcon');

// Cached once, at load time — moving miniPlayerRoot into the PiP
// window's own document later does NOT invalidate these references,
// but a fresh document.getElementById('mpX') call after the move would
// return null (it's scoped to the main document, not wherever the node
// currently lives). Always use these cached refs, never re-look-up.
const mpArt = document.getElementById('mpArt');
const mpTitle = document.getElementById('mpTitle');
const mpArtist = document.getElementById('mpArtist');
const mpPlayPause = document.getElementById('mpPlayPause');
const mpPrev = document.getElementById('mpPrev');
const mpNext = document.getElementById('mpNext');
const mpShuffle = document.getElementById('mpShuffle');
const mpRepeat = document.getElementById('mpRepeat');
const mpProgressFill = document.getElementById('mpProgressFill');
const mpProgressTrack = document.getElementById('mpProgressTrack');
const mpVolumeSlider = document.getElementById('mpVolumeSlider');
const mpVolumeIcon = document.getElementById('mpVolumeIcon');

function setStatus(msg){ statusEl.textContent = msg; }

/* ---------- Accent color picker ---------- */

function initSwatches(){
  const wrap = document.getElementById('swatches');
  const savedAccent = getCookie('youtify_accent');
  ACCENT_COLORS.forEach((c, i) => {
    const isActive = savedAccent ? c.value === savedAccent : i === 0;
    const el = document.createElement('div');
    el.className = 'swatch' + (isActive ? ' active' : '');
    el.style.background = c.value;
    el.title = c.name;
    el.addEventListener('click', () => {
      document.documentElement.style.setProperty('--accent', c.value);
      document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      setCookie('youtify_accent', c.value, 365);
    });
    wrap.appendChild(el);
  });
  if (savedAccent){
    document.documentElement.style.setProperty('--accent', savedAccent);
  }
}

/* ---------- Spotify user login (PKCE) ---------- */

function randomString(length){
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

async function sha256Base64Url(plain){
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  let str = '';
  new Uint8Array(hash).forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function startSpotifyLogin(){
  // The PKCE verifier doesn't need to be kept secret from this app —
  // only from anyone intercepting the auth code in transit — so we
  // round-trip it through the "state" param instead of browser storage.
  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: verifier,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleSpotifyRedirect(){
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const verifier = url.searchParams.get('state');
  if (!code || !verifier) return;

  // Clean the URL so refreshing doesn't replay the auth code
  window.history.replaceState({}, document.title, REDIRECT_URI);

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('Spotify login failed — check Client ID / Redirect URI setup.');
    const data = await res.json();
    spotifyAccessToken = data.access_token;
    spotifyRefreshToken = data.refresh_token;
    setCookie('youtify_spotify_refresh', spotifyRefreshToken, 30);
    await afterLogin();
  } catch (err){
    setStatus(err.message);
  }
}

async function refreshSpotifyToken(){
  if (!spotifyRefreshToken) return false;
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: spotifyRefreshToken,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return false;
  const data = await res.json();
  spotifyAccessToken = data.access_token;
  if (data.refresh_token){
    spotifyRefreshToken = data.refresh_token;
    setCookie('youtify_spotify_refresh', spotifyRefreshToken, 30);
  }
  return true;
}

async function spotifyUserFetch(pathOrUrl){
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.spotify.com/v1/${pathOrUrl}`;
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  });
  if (res.status === 401 && await refreshSpotifyToken()){
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${spotifyAccessToken}` },
    });
  }
  return res;
}

async function afterLogin(){
  document.getElementById('loginBtn').style.display = 'none';
  document.getElementById('logoutBtn').style.display = 'block';

  try {
    const meRes = await spotifyUserFetch('me');
    if (meRes.ok){
      const me = await meRes.json();
      const label = document.getElementById('userLabel');
      label.style.display = 'flex';
      const img = me.images?.[0]?.url;
      label.innerHTML = (img ? `<img src="${img}">` : '') + `<span>${me.display_name || me.id}</span>`;
    }
  } catch (_) { /* non-fatal, just skip the greeting */ }

  await loadUserPlaylists();
}

async function loadUserPlaylists(){
  const listEl = document.getElementById('playlists');
  const labelEl = document.getElementById('playlistsLabel');
  try {
    const res = await spotifyUserFetch('me/playlists?limit=50');
    if (!res.ok) throw new Error('Could not load your playlists.');
    const data = await res.json();
    labelEl.style.display = 'block';
    listEl.innerHTML = '';
    cachedUserPlaylists = data.items || [];

    const likedRow = document.createElement('div');
    likedRow.className = 'playlist-row liked-songs-row';
    likedRow.textContent = 'Liked Songs';
    likedRow.addEventListener('click', () => loadLikedSongs(likedRow));
    listEl.appendChild(likedRow);

    data.items.forEach(pl => {
      const row = document.createElement('div');
      row.className = 'playlist-row';
      row.textContent = pl.name;
      row.addEventListener('click', () => loadPlaylistTracks(pl.id, pl.name, row));
      listEl.appendChild(row);
    });

    if (homeViewEl.style.display !== 'none') renderHomeView();
  } catch (err){
    setStatus(err.message);
  }
}

async function loadLikedSongs(rowEl){
  document.querySelectorAll('.playlist-row').forEach(r => r.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');
  showSearchResults();

  setStatus('Loading Liked Songs…');
  resultsEl.innerHTML = '';
  try {
    // Unlike playlist items, GET /me/tracks was unaffected by the Feb
    // 2026 migration — still uses the { track: {...} } shape.
    let nextUrl = 'me/tracks?limit=50';
    let tracks = [];
    let pageCount = 0;
    const MAX_PAGES = 40;

    while (nextUrl && pageCount < MAX_PAGES){
      setStatus(`Loading Liked Songs… (${tracks.length} so far)`);
      const res = await spotifyUserFetch(nextUrl);
      if (!res.ok) throw new Error('Could not load Liked Songs.');
      const data = await res.json();
      const pageTracks = data.items
        .map(entry => entry.track)
        .filter(Boolean)
        .map(t => ({
          name: t.name,
          artists: t.artists.map(a => a.name),
          album: { images: t.album.images },
          external_url: t.external_urls?.spotify,
        }));
      tracks = tracks.concat(pageTracks);
      nextUrl = data.next;
      pageCount++;
    }

    if (!tracks.length){ setStatus('No liked songs found.'); return; }
    setStatus('');
    currentPlaylistContext = { id: 'liked-songs', name: 'Liked Songs', source: 'liked' };
    currentResults = tracks;
    currentIndex = -1;
    historyStack = [];
    forwardStack = [];
    renderResultsHeader('Liked Songs', `${tracks.length} tracks`, null);
    tracks.forEach((t, i) => renderResultRow(t, i));
  } catch (err){
    setStatus(err.message);
  }
}

async function loadPlaylistTracks(playlistId, playlistName, rowEl){
  document.querySelectorAll('.playlist-row').forEach(r => r.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');
  showSearchResults();

  setStatus(`Loading "${playlistName}"…`);
  resultsEl.innerHTML = '';
  try {
    // Feb 2026 migration: /playlists/{id}/tracks was removed in favor
    // of /playlists/{id}/items (and item.track became item.item).
    // Spotify paginates results, so follow "next" until the whole
    // playlist is loaded rather than stopping at the first page.
    let nextUrl = `playlists/${playlistId}/items?limit=50`;
    let tracks = [];
    let pageCount = 0;
    const MAX_PAGES = 40; // safety cap — ~2000 tracks, far past any real playlist

    while (nextUrl && pageCount < MAX_PAGES){
      setStatus(`Loading "${playlistName}"… (${tracks.length} tracks so far)`);
      const res = await spotifyUserFetch(nextUrl);
      if (!res.ok) throw new Error('Could not load that playlist.');
      const data = await res.json();
      const pageTracks = data.items
        .map(entry => entry.item)
        .filter(Boolean)
        .map(t => ({
          name: t.name,
          artists: t.artists.map(a => a.name),
          album: { images: t.album.images },
          external_url: t.external_urls?.spotify,
        }));
      tracks = tracks.concat(pageTracks);
      nextUrl = data.next;
      pageCount++;
    }

    if (!tracks.length){ setStatus('This playlist has no tracks.'); return; }
    setStatus('');
    currentPlaylistContext = { id: playlistId, name: playlistName, source: 'user' };
    currentResults = tracks;
    currentIndex = -1;
    historyStack = [];
    forwardStack = [];
    const playlistMeta = cachedUserPlaylists.find(pl => pl.id === playlistId);
    renderResultsHeader(playlistName, `${tracks.length} tracks`, playlistMeta?.images?.[0]?.url);
    tracks.forEach((t, i) => renderResultRow(t, i));
  } catch (err){
    setStatus(err.message);
  }
}

/* ---------- Spotify + YouTube, via the proxy (no keys client-side) ---------- */

async function searchSpotify(q){
  const url = `${PROXY_BASE_URL}/api/spotify-search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Search failed — is the proxy deployed and reachable?");
  return res.json(); // { tracks: [...] }
}

async function findYouTubeVideoId(title, artist){
  const override = getVideoOverride(title, artist);
  if (override) return override;

  const url = `${PROXY_BASE_URL}/api/youtube-search?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("YouTube lookup failed — is the proxy deployed and reachable?");
  const data = await res.json();
  return data.videoId;
}

async function fetchYouTubeAlternatives(title, artist){
  const url = `${PROXY_BASE_URL}/api/youtube-search-multi?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("YouTube lookup failed — is the proxy deployed and reachable?");
  const data = await res.json();
  return data.results || [];
}

/* ---------- YouTube IFrame Player (hidden, audio-only use) ---------- */

function loadYouTubeAPI(){
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player){ resolve(); return; }
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => resolve();
  });
}

async function ensurePlayer(videoId){
  await loadYouTubeAPI();
  return new Promise((resolve) => {
    if (ytPlayer){
      ytPlayer.loadVideoById(videoId);
      resolve();
      return;
    }
    ytPlayer = new YT.Player('ytPlayer', {
      height: '1', width: '1', videoId: videoId,
      playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, fs: 0, disablekb: 1, cc_load_policy: 1 },
      events: {
        onReady: () => {
          ytPlayer.setVolume(Number(volumeSlider.value));
          resolve();
        },
        onStateChange: onPlayerStateChange
      }
    });
  });
}

function onPlayerStateChange(e){
  const disc = document.getElementById('disc');
  const playPauseBtn = document.getElementById('playPause');
  if (e.data === YT.PlayerState.PLAYING){
    disc.classList.add('playing');
    playPauseBtn.innerHTML = ICONS.pause;
    mpPlayPause.innerHTML = ICONS.pause;
    currentDuration = ytPlayer.getDuration();
    startProgressLoop();
  } else {
    disc.classList.remove('playing');
    playPauseBtn.innerHTML = ICONS.play;
    mpPlayPause.innerHTML = ICONS.play;
    if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED){
      stopProgressLoop();
    }
    if (e.data === YT.PlayerState.ENDED){
      if (repeatMode === 'one'){
        ytPlayer.seekTo(0);
        ytPlayer.playVideo();
      } else {
        goNext();
      }
    }
  }
}

function startProgressLoop(){
  stopProgressLoop();
  progressTimer = setInterval(updateProgress, 400);
}
function stopProgressLoop(){
  if (progressTimer){ clearInterval(progressTimer); progressTimer = null; }
}
function formatTime(sec){
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}
let positionSaveCounter = 0;
function updateProgress(){
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const cur = ytPlayer.getCurrentTime();
  const dur = currentDuration || ytPlayer.getDuration() || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('timeCur').textContent = formatTime(cur);
  document.getElementById('timeDur').textContent = formatTime(dur);
  mpProgressFill.style.width = pct + '%';

  // Save roughly every 2 seconds (updateProgress runs every 400ms)
  // rather than on every tick.
  positionSaveCounter++;
  if (positionSaveCounter % 5 === 0){
    setCookie('youtify_last_position', Math.floor(cur), 30);
  }
}

/* ---------- Search + queue ---------- */

async function runSearch(){
  const q = queryEl.value.trim();
  if (!q){ showHome(); return; }
  showSearchResults();
  clearResultsHeader();
  resultsEl.innerHTML = '';
  setStatus('Searching Spotify…');
  try {
    const { tracks = [] } = (await searchSpotify(q)) || {};
    if (!tracks.length){ setStatus('No matches found.'); return; }
    setStatus('');
    currentPlaylistContext = null;
    currentResults = tracks;
    currentIndex = -1;
    historyStack = [];
    forwardStack = [];
    tracks.forEach((t, i) => renderResultRow(t, i));
  } catch (err){
    setStatus(err.message);
  }
}

/* ---------- Home view ---------- */

const searchWrapEl = document.querySelector('.search-wrap');
const settingsViewEl = document.getElementById('settingsView');
const resultsHeaderEl = document.getElementById('resultsHeader');
const videoViewEl = document.getElementById('videoView');
const videoSlotEl = document.getElementById('videoSlot');
const ytHiddenEl = document.getElementById('yt-hidden');

// IMPORTANT: the iframe must never be moved to a different DOM parent —
// browsers reload an <iframe> whenever it's re-parented, which would
// sever it from the YT.Player instance tracking it (breaking progress,
// button state, and track-change syncing, and resetting it back to
// YouTube's default full chrome). Instead, video mode repositions the
// iframe's permanent container in place, directly on top of the visible
// placeholder slot, using fixed positioning — the iframe itself never
// moves in the DOM tree.
function positionVideoOverlay(){
  const rect = videoSlotEl.getBoundingClientRect();
  ytHiddenEl.style.top = `${rect.top}px`;
  ytHiddenEl.style.left = `${rect.left}px`;
  ytHiddenEl.style.width = `${rect.width}px`;
  ytHiddenEl.style.height = `${rect.height}px`;
}

function hideVideoOverlay(){
  ytHiddenEl.classList.remove('video-active');
  ytHiddenEl.style.top = '0';
  ytHiddenEl.style.left = '0';
  ytHiddenEl.style.width = '1px';
  ytHiddenEl.style.height = '1px';
  window.removeEventListener('resize', positionVideoOverlay);
  const mainScroll = document.querySelector('.main-scroll');
  if (mainScroll) mainScroll.removeEventListener('scroll', positionVideoOverlay);
}

let currentViewName = 'home';

function showHome(){
  currentViewName = 'home';
  queryEl.value = '';
  setStatus('');
  hideVideoOverlay();
  searchWrapEl.style.display = 'flex';
  homeViewEl.style.display = 'block';
  resultsEl.style.display = 'none';
  resultsHeaderEl.style.display = 'none';
  settingsViewEl.style.display = 'none';
  videoViewEl.style.display = 'none';
  renderHomeView();
}

function showSearchResults(){
  currentViewName = 'results';
  hideVideoOverlay();
  searchWrapEl.style.display = 'flex';
  homeViewEl.style.display = 'none';
  resultsEl.style.display = 'block';
  settingsViewEl.style.display = 'none';
  videoViewEl.style.display = 'none';
}

function showSettings(){
  currentViewName = 'settings';
  setStatus('');
  hideVideoOverlay();
  searchWrapEl.style.display = 'none';
  homeViewEl.style.display = 'none';
  resultsEl.style.display = 'none';
  resultsHeaderEl.style.display = 'none';
  settingsViewEl.style.display = 'block';
  videoViewEl.style.display = 'none';
}

// Positions the already-playing YouTube iframe directly over a visible
// placeholder slot — same audio, same playback position, same tracked
// player instance, just no longer visually tucked away. This is simply
// showing the video half of the same official YouTube embed that's
// already providing the audio.
function showVideo(){
  currentViewName = 'video';
  setStatus('');
  searchWrapEl.style.display = 'none';
  homeViewEl.style.display = 'none';
  resultsEl.style.display = 'none';
  resultsHeaderEl.style.display = 'none';
  settingsViewEl.style.display = 'none';
  videoViewEl.style.display = 'block';

  const titleEl = document.getElementById('nowTitle');
  const artistEl = document.getElementById('nowArtist');
  const hasTrack = titleEl.textContent.trim().length > 0;
  const nowPlayingEl = document.getElementById('videoNowPlaying');

  if (!ytPlayer || !hasTrack){
    nowPlayingEl.textContent = '';
    videoSlotEl.innerHTML = '<p class="video-empty-hint">Nothing playing yet — play a song first.</p>';
    return;
  }

  nowPlayingEl.textContent = `${titleEl.textContent} — ${artistEl.textContent}`;
  videoSlotEl.innerHTML = '';
  ytHiddenEl.classList.add('video-active');
  positionVideoOverlay();
  window.addEventListener('resize', positionVideoOverlay);
  const mainScroll = document.querySelector('.main-scroll');
  if (mainScroll) mainScroll.addEventListener('scroll', positionVideoOverlay);
}

// Toggling the button while already in video mode needs to actually
// leave it — otherwise there's no way back to Home/Search/Settings
// from the button itself.
function toggleVideo(){
  if (currentViewName === 'video'){
    showHome();
  } else {
    showVideo();
  }
}

// Shows what playlist (or Liked Songs) you're currently browsing, so
// it's never ambiguous which list you're looking at.
function renderResultsHeader(title, subtitle, artUrl){
  resultsHeaderEl.innerHTML = artUrl
    ? `<img class="results-header-art" src="${artUrl}" alt="">`
    : '';
  const textBlock = document.createElement('div');
  textBlock.innerHTML = `
    <h2 class="results-header-title">${title}</h2>
    <div class="results-header-sub">${subtitle}</div>
  `;
  resultsHeaderEl.appendChild(textBlock);
  resultsHeaderEl.style.display = 'flex';
}

function clearResultsHeader(){
  resultsHeaderEl.style.display = 'none';
  resultsHeaderEl.innerHTML = '';
}

function getGreeting(){
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderHomeView(){
  homeViewEl.innerHTML = '';

  const greeting = document.createElement('h2');
  greeting.className = 'home-greeting';
  greeting.textContent = getGreeting();
  homeViewEl.appendChild(greeting);

  // Quick access row (Spotify-style): Liked Songs shortcut + a few
  // recently played tracks, as small clickable rectangles.
  const quickItems = [];
  if (spotifyAccessToken) quickItems.push({ type: 'liked' });
  recentlyPlayed.slice(0, 5).forEach(t => quickItems.push({ type: 'track', track: t }));

  if (quickItems.length){
    const quickGrid = document.createElement('div');
    quickGrid.className = 'quick-grid';
    quickItems.forEach(item => {
      const card = document.createElement('div');
      card.className = 'quick-card';
      if (item.type === 'liked'){
        card.innerHTML = `<div class="quick-card-title" style="padding-left:12px;">Liked Songs</div>`;
        card.addEventListener('click', () => loadLikedSongs());
      } else {
        const art = item.track.album.images[0]?.url || '';
        card.innerHTML = `<img src="${art}" alt=""><div class="quick-card-title">${item.track.name}</div>`;
        card.addEventListener('click', () => playSingleTrack(item.track));
      }
      quickGrid.appendChild(card);
    });
    homeViewEl.appendChild(quickGrid);
  }

  // Your Playlists — grid view (YouTube-style thumbnail grid, Spotify-style cards)
  if (cachedUserPlaylists.length){
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Your Playlists';
    homeViewEl.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'playlist-grid-view';
    cachedUserPlaylists.forEach(pl => {
      const card = document.createElement('div');
      card.className = 'grid-card';
      const art = pl.images?.[0]?.url || '';
      card.innerHTML = `
        <img class="grid-card-art" src="${art}" alt="">
        <div class="grid-card-title">${pl.name}</div>
        <div class="grid-card-sub">${pl.tracks?.total ?? ''} tracks</div>
      `;
      card.addEventListener('click', () => loadPlaylistTracks(pl.id, pl.name));
      grid.appendChild(card);
    });
    homeViewEl.appendChild(grid);
  }

  // Recently Played — grid view
  if (recentlyPlayed.length){
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Recently Played';
    homeViewEl.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'playlist-grid-view';
    recentlyPlayed.forEach(t => {
      const card = document.createElement('div');
      card.className = 'grid-card';
      const art = t.album.images[0]?.url || '';
      card.innerHTML = `
        <img class="grid-card-art" src="${art}" alt="">
        <div class="grid-card-title">${t.name}</div>
        <div class="grid-card-sub">${t.artists.join(', ')}</div>
      `;
      card.addEventListener('click', () => playSingleTrack(t));
      grid.appendChild(card);
    });
    homeViewEl.appendChild(grid);
  }

  if (!quickItems.length && !cachedUserPlaylists.length && !recentlyPlayed.length){
    const hint = document.createElement('p');
    hint.className = 'home-empty-hint';
    hint.textContent = spotifyAccessToken
      ? 'Nothing here yet — search for a song to get started.'
      : 'Log in with Spotify to see your playlists here, or search for a song to get started.';
    homeViewEl.appendChild(hint);
  }
}

function renderResultRow(track, index){
  const row = document.createElement('div');
  row.className = 'result-row';
  row.dataset.index = index;
  const art = track.album.images[track.album.images.length - 1]?.url || '';
  const artists = track.artists.join(', ');
  row.innerHTML = `
    <img src="${art}" alt="">
    <div class="result-meta">
      <div class="result-title">${track.name}</div>
      <div class="result-artist">${artists}</div>
    </div>
  `;
  row.addEventListener('click', () => playFromRow(index));
  resultsEl.appendChild(row);
}

function highlightActiveRow(){
  document.querySelectorAll('.result-row').forEach(row => {
    row.classList.toggle('active', Number(row.dataset.index) === currentIndex);
  });
}

function updateTransportButtons(){
  if (shuffleOn){
    prevBtn.disabled = historyStack.length === 0;
    nextBtn.disabled = forwardStack.length === 0 && nextShuffleIndex(currentIndex) === -1;
  } else {
    prevBtn.disabled = currentIndex <= 0 && repeatMode !== 'all';
    nextBtn.disabled = currentIndex < 0 || (currentIndex >= currentResults.length - 1 && repeatMode !== 'all');
  }
}

function generateShuffleOrder(){
  const arr = currentResults.map((_, i) => i);
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Only used while shuffle is on — picks the next track in the shuffled order.
function nextShuffleIndex(index){
  if (!shuffleOrder.length || shuffleOrder.length !== currentResults.length){
    shuffleOrder = generateShuffleOrder();
  }
  let pos = shuffleOrder.indexOf(index);
  pos = (pos + 1) % shuffleOrder.length;
  return shuffleOrder[pos];
}

function queueRowHtml(track, isCurrent){
  const art = track.album.images[track.album.images.length - 1]?.url || '';
  return `
    <img src="${art}" alt="">
    <div class="queue-row-meta" style="min-width:0;">
      <div class="queue-row-title">${track.name}</div>
      <div class="queue-row-artist">${track.artists.join(', ')}</div>
    </div>
  `;
}

function renderQueuePanel(){
  const nowEl = document.getElementById('queueNowPlaying');
  const upNextEl = document.getElementById('queueUpNext');
  nowEl.innerHTML = '';
  upNextEl.innerHTML = '';

  if (currentIndex === -1 || !currentResults.length){
    nowEl.innerHTML = '<p class="queue-empty-hint">Nothing playing yet.</p>';
    return;
  }

  const nowRow = document.createElement('div');
  nowRow.className = 'queue-row current';
  nowRow.innerHTML = queueRowHtml(currentResults[currentIndex], true);
  nowEl.appendChild(nowRow);

  // Compute upcoming order — shuffle-aware, capped at 25 for a sane list.
  const upcoming = [];
  if (shuffleOn){
    if (!shuffleOrder.length || shuffleOrder.length !== currentResults.length){
      shuffleOrder = generateShuffleOrder();
    }
    let pos = shuffleOrder.indexOf(currentIndex);
    for (let i = 0; i < currentResults.length - 1 && upcoming.length < 25; i++){
      pos = (pos + 1) % shuffleOrder.length;
      upcoming.push(shuffleOrder[pos]);
    }
  } else {
    for (let i = currentIndex + 1; i < currentResults.length && upcoming.length < 25; i++){
      upcoming.push(i);
    }
    if (repeatMode === 'all'){
      for (let i = 0; i < currentIndex && upcoming.length < 25; i++){
        upcoming.push(i);
      }
    }
  }

  if (!upcoming.length){
    upNextEl.innerHTML = '<p class="queue-empty-hint">End of queue.</p>';
    return;
  }

  upcoming.forEach(idx => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    row.innerHTML = queueRowHtml(currentResults[idx], false);
    row.addEventListener('click', () => playFromRow(idx));
    upNextEl.appendChild(row);
  });
}

async function playAt(index){
  if (index < 0 || index >= currentResults.length) return;
  currentIndex = index;
  highlightActiveRow();
  updateTransportButtons();
  renderQueuePanel();
  const trackSelectPanel = document.getElementById('trackSelectPanel');
  if (trackSelectPanel.classList.contains('open')) showTrackSelect();
  await playTrack(currentResults[index]);
}

// A manual pick (clicking a row). In shuffle mode this also updates the
// back/forward history; in normal mode, position alone is enough.
function playFromRow(index){
  if (shuffleOn){
    if (currentIndex !== -1) historyStack.push(currentIndex);
    forwardStack = [];
  }
  playAt(index);
}

function goNext(){
  if (currentIndex === -1) return;

  if (shuffleOn){
    if (forwardStack.length){
      historyStack.push(currentIndex);
      playAt(forwardStack.pop());
      return;
    }
    const next = nextShuffleIndex(currentIndex);
    if (next === -1) return;
    historyStack.push(currentIndex);
    playAt(next);
    return;
  }

  // Normal mode: always just move one position forward — no history
  // stack needed, works no matter how you got to the current track.
  let next;
  if (currentIndex < currentResults.length - 1) next = currentIndex + 1;
  else next = repeatMode === 'all' ? 0 : -1;
  if (next !== -1) playAt(next);
}

function goPrev(){
  if (currentIndex === -1) return;

  if (shuffleOn){
    if (!historyStack.length) return;
    forwardStack.push(currentIndex);
    playAt(historyStack.pop());
    return;
  }

  // Normal mode: always just move one position back.
  let prev;
  if (currentIndex > 0) prev = currentIndex - 1;
  else prev = repeatMode === 'all' ? currentResults.length - 1 : -1;
  if (prev !== -1) playAt(prev);
}

function toggleShuffle(){
  shuffleOn = !shuffleOn;
  shuffleBtn.classList.toggle('toggled', shuffleOn);
  mpShuffle.classList.toggle('toggled', shuffleOn);
  if (shuffleOn){
    shuffleOrder = generateShuffleOrder();
    // Fresh history for the new shuffle sequence — mixing in whatever
    // you did in linear mode before wouldn't make sense here.
    historyStack = [];
    forwardStack = [];
  }
  updateTransportButtons();
  renderQueuePanel();
}

function toggleRepeat(){
  const modes = ['off', 'all', 'one'];
  repeatMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];
  const icon = repeatMode === 'one' ? ICONS.repeatOne : ICONS.repeat;
  repeatBtn.classList.toggle('toggled', repeatMode !== 'off');
  repeatBtn.innerHTML = icon;
  mpRepeat.classList.toggle('toggled', repeatMode !== 'off');
  mpRepeat.innerHTML = icon;
  updateTransportButtons();
}

function updateNowPlayingUI(track){
  const art = track.album.images[0]?.url || '';
  const artists = track.artists.join(', ');
  document.getElementById('nowArt').src = art;
  document.getElementById('nowTitle').textContent = track.name;
  document.getElementById('nowArtist').textContent = artists;
  document.getElementById('spotifyLink').href = track.external_url || '#';
  mpArt.src = art;
  mpTitle.textContent = track.name;
  mpArtist.textContent = artists;
  if (currentViewName === 'video'){
    document.getElementById('videoNowPlaying').textContent = `${track.name} — ${artists}`;
  }
}

async function playTrack(track, resumeAtSeconds){
  const artists = track.artists.join(', ');
  setStatus('Finding playback source on YouTube…');

  playerBarEl.style.display = 'flex';
  updateNowPlayingUI(track);
  saveNowPlayingCookie(track);
  recordRecentlyPlayed(track);

  // A fresh play (not a resume) starts its saved position over at 0.
  if (!resumeAtSeconds) setCookie('youtify_last_position', '0', 30);

  try {
    const videoId = await findYouTubeVideoId(track.name, artists);
    if (!videoId){ setStatus('No YouTube match found for this track.'); return; }
    setStatus('');
    await ensurePlayer(videoId);
    if (resumeAtSeconds){
      ytPlayer.seekTo(resumeAtSeconds, true);
    }
  } catch (err){
    setStatus(err.message);
  }
}

/* ---------- Track Select ---------- */

function getCurrentTrackObj(){
  if (currentIndex === -1 || !currentResults[currentIndex]) return null;
  return currentResults[currentIndex];
}

async function showTrackSelect(){
  document.getElementById('trackSelectPanel').classList.add('open');
  const listEl = document.getElementById('trackSelectList');
  const track = getCurrentTrackObj();

  if (!track){
    listEl.innerHTML = '<p class="queue-empty-hint">Nothing playing yet.</p>';
    return;
  }

  listEl.innerHTML = '<p class="queue-empty-hint">Searching YouTube…</p>';
  const artists = track.artists.join(', ');

  try {
    const results = await fetchYouTubeAlternatives(track.name, artists);
    if (!results.length){
      listEl.innerHTML = '<p class="queue-empty-hint">No results found.</p>';
      return;
    }
    const currentOverride = getVideoOverride(track.name, artists);
    listEl.innerHTML = '';
    results.forEach(r => {
      const row = document.createElement('div');
      row.className = 'track-select-row' + (r.videoId === currentOverride ? ' current' : '');
      row.innerHTML = `
        <img src="${r.thumbnail}" alt="">
        <div style="min-width:0;">
          <div class="track-select-title">${r.title}</div>
          <div class="track-select-channel">${r.channelTitle}</div>
        </div>
      `;
      row.addEventListener('click', () => selectTrackVideo(track, r.videoId));
      listEl.appendChild(row);
    });
  } catch (err){
    listEl.innerHTML = `<p class="queue-empty-hint">${err.message}</p>`;
  }
}

async function selectTrackVideo(track, videoId){
  const artists = track.artists.join(', ');
  setVideoOverride(track.name, artists, videoId);
  document.getElementById('trackSelectPanel').classList.remove('open');
  setStatus('Switching video…');
  await ensurePlayer(videoId);
  setStatus('');
}

function recordRecentlyPlayed(track){
  recentlyPlayed = recentlyPlayed.filter(t =>
    !(t.name === track.name && t.artists.join(',') === track.artists.join(',')));
  recentlyPlayed.unshift(track);
  if (recentlyPlayed.length > 8) recentlyPlayed.length = 8;
  renderRecentlyPlayed();
  if (homeViewEl.style.display !== 'none') renderHomeView();
}

function renderRecentlyPlayed(){
  const listEl = document.getElementById('recentList');
  const labelEl = document.getElementById('recentLabel');
  if (!recentlyPlayed.length){ labelEl.style.display = 'none'; listEl.innerHTML = ''; return; }
  labelEl.style.display = 'block';
  listEl.innerHTML = '';
  recentlyPlayed.forEach(t => {
    const row = document.createElement('div');
    row.className = 'playlist-row';
    row.textContent = `${t.name} — ${t.artists.join(', ')}`;
    row.title = row.textContent;
    row.addEventListener('click', () => playSingleTrack(t));
    listEl.appendChild(row);
  });
}

function playSingleTrack(track){
  currentPlaylistContext = null;
  currentResults = [track];
  currentIndex = -1;
  historyStack = [];
  forwardStack = [];
  playFromRow(0);
}

/* ---------- Restore on load ---------- */

async function restoreSession(){
  // Silent re-login from a saved refresh token, if we have one and
  // didn't just complete a fresh login via redirect.
  if (!spotifyAccessToken){
    const savedRefresh = getCookie('youtify_spotify_refresh');
    if (savedRefresh){
      spotifyRefreshToken = savedRefresh;
      const ok = await refreshSpotifyToken();
      if (ok) await afterLogin();
    }
  }

  const savedTrackRaw = getCookie('youtify_last_track');
  if (!savedTrackRaw) return;

  let savedTrack;
  try { savedTrack = JSON.parse(savedTrackRaw); } catch (_) { return; }
  const track = {
    name: savedTrack.name,
    artists: savedTrack.artists,
    album: { images: savedTrack.images },
    external_url: savedTrack.external_url,
  };

  const savedPlaylistRaw = getCookie('youtify_last_playlist');
  if (savedPlaylistRaw && spotifyAccessToken){
    try {
      const pl = JSON.parse(savedPlaylistRaw);
      if (pl.source === 'user'){
        await loadPlaylistTracks(pl.id, pl.name);
      } else if (pl.source === 'liked'){
        await loadLikedSongs();
      }
      const idx = currentResults.findIndex(t =>
        t.name === track.name && t.artists.join(',') === track.artists.join(','));
      if (idx !== -1){
        currentIndex = idx;
        highlightActiveRow();
        updateTransportButtons();
      }
    } catch (_) { /* fall through to single-track restore below */ }
  } else {
    currentResults = [track];
    currentIndex = 0;
  }

  // Show the restored track in the player bar without autoplaying —
  // browsers block unsolicited autoplay anyway, and it respects the
  // person's own choice of when to resume listening.
  pendingRestoreTrack = track;
  const savedPosition = parseInt(getCookie('youtify_last_position'), 10);
  pendingRestorePosition = Number.isFinite(savedPosition) ? savedPosition : 0;
  playerBarEl.style.display = 'flex';
  updateNowPlayingUI(track);
  if (pendingRestorePosition > 0){
    document.getElementById('timeCur').textContent = formatTime(pendingRestorePosition);
  }
}

/* ---------- Wiring ---------- */

shuffleBtn.innerHTML = ICONS.shuffle;
repeatBtn.innerHTML = ICONS.repeat;
prevBtn.innerHTML = ICONS.prev;
nextBtn.innerHTML = ICONS.next;
document.getElementById('playPause').innerHTML = ICONS.play;
volumeIcon.innerHTML = ICONS.volHigh;
mpPrev.innerHTML = ICONS.prev;
mpNext.innerHTML = ICONS.next;
mpPlayPause.innerHTML = ICONS.play;
mpShuffle.innerHTML = ICONS.shuffle;
mpRepeat.innerHTML = ICONS.repeat;
mpVolumeIcon.innerHTML = ICONS.volHigh;

const savedVolume = parseInt(getCookie('youtify_volume'), 10);
if (Number.isFinite(savedVolume)){
  volumeSlider.value = savedVolume;
  mpVolumeSlider.value = savedVolume;
  const icon = savedVolume === 0 ? ICONS.volMute : savedVolume < 50 ? ICONS.volMid : ICONS.volHigh;
  volumeIcon.innerHTML = icon;
  mpVolumeIcon.innerHTML = icon;
}

initSwatches();
document.getElementById('loginBtn').addEventListener('click', startSpotifyLogin);
document.getElementById('brandHome').addEventListener('click', showHome);
showHome();
handleSpotifyRedirect().then(restoreSession);

document.getElementById('settingsBtn').addEventListener('click', showSettings);
document.getElementById('videoToggleBtn').addEventListener('click', toggleVideo);

const queuePanelEl = document.getElementById('queuePanel');
document.getElementById('queueToggleBtn').addEventListener('click', () => {
  queuePanelEl.classList.toggle('open');
  if (queuePanelEl.classList.contains('open')) renderQueuePanel();
});
document.getElementById('closeQueue').addEventListener('click', () => {
  queuePanelEl.classList.remove('open');
});

const trackSelectPanelEl = document.getElementById('trackSelectPanel');
document.getElementById('trackSelectToggleBtn').addEventListener('click', () => {
  if (trackSelectPanelEl.classList.contains('open')){
    trackSelectPanelEl.classList.remove('open');
  } else {
    showTrackSelect();
  }
});
document.getElementById('closeTrackSelect').addEventListener('click', () => {
  trackSelectPanelEl.classList.remove('open');
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  spotifyAccessToken = null;
  spotifyRefreshToken = null;
  deleteCookie('youtify_spotify_refresh');
  deleteCookie('youtify_last_playlist');
  document.getElementById('loginBtn').style.display = 'block';
  document.getElementById('logoutBtn').style.display = 'none';
  document.getElementById('userLabel').style.display = 'none';
  document.getElementById('playlistsLabel').style.display = 'none';
  document.getElementById('playlists').innerHTML = '';
  cachedUserPlaylists = [];
});

let pipWindow = null;

const MINI_PLAYER_CSS = `
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden;
    background:#0c0d0f; font-family: Arial, sans-serif; }
  #miniPlayerRoot{ display:flex; align-items:center; gap:8px; padding:3px 8px;
    width:100%; height:100%; position:relative; color:#F2F2F0; }
  #mpArt{ width:26px; height:26px; border-radius:5px; object-fit:cover;
    flex-shrink:0; background:#16181c; }
  .mp-meta{ min-width:0; width:78px; flex-shrink:0; }
  .mp-title{ font-weight:600; font-size:0.66rem; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; color:#F2F2F0; line-height:1.15; }
  .mp-artist{ color:#8A8A93; font-size:0.58rem; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; line-height:1.15; }
  .mp-controls{ display:flex; align-items:center; gap:4px; flex-shrink:0; }
  .mp-controls button{ background:none; border:none; color:#F2F2F0;
    cursor:pointer; padding:1px; opacity:0.85; display:flex;
    align-items:center; justify-content:center; }
  .mp-controls button svg{ display:block; width:13px; height:13px; }
  .mp-controls button:hover{ opacity:1; color:%%ACCENT%%; }
  .mp-controls button.toggled{ color:%%ACCENT%%; opacity:1; }
  #mpPlayPause{ background:#F2F2F0; color:#0c0d0f; width:20px; height:20px;
    border-radius:50%; opacity:1; }
  #mpPlayPause svg{ width:10px; height:10px; }
  .mp-volume{ display:flex; align-items:center; gap:4px; width:52px; flex-shrink:0; }
  .mp-volume input[type="range"]{ -webkit-appearance:none; appearance:none;
    width:100%; height:3px; background:#26282e; border-radius:4px; outline:none; }
  .mp-volume input[type="range"]::-webkit-slider-thumb{ -webkit-appearance:none;
    width:8px; height:8px; border-radius:50%; background:%%ACCENT%%; cursor:pointer; }
  .mp-volume input[type="range"]::-moz-range-thumb{ width:8px; height:8px;
    border-radius:50%; background:%%ACCENT%%; cursor:pointer; border:none; }
  #mpVolumeIcon{ cursor:pointer; color:#8A8A93; display:flex; align-items:center;
    flex-shrink:0; }
  #mpVolumeIcon svg{ display:block; width:12px; height:12px; }
  .mp-progress-track{ position:absolute; left:0; right:0; bottom:0; height:2px;
    background:#26282e; cursor:pointer; }
  .mp-progress-fill{ height:100%; width:0%; background:%%ACCENT%%; }
`;

async function toggleMiniPlayer(){
  // Document Picture-in-Picture is Chrome/Edge only today. Where it's
  // not available, fall back to the old in-page collapsed bar instead
  // of doing nothing.
  if (!('documentPictureInPicture' in window)){
    playerBarEl.classList.toggle('mini');
    return;
  }

  if (pipWindow){
    pipWindow.close();
    return;
  }

  const miniRoot = document.getElementById('miniPlayerRoot');

  pipWindow = await documentPictureInPicture.requestWindow({
    width: 360,
    height: 36,
  });

  // Self-contained styles built specifically for this compact view —
  // deliberately NOT cloned from the main page's stylesheet, since
  // reading cssRules across documents is unreliable (CORS-sensitive,
  // and any one failure left the whole popout unstyled and oversized).
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#1DB954';
  const style = pipWindow.document.createElement('style');
  style.textContent = MINI_PLAYER_CSS.replace(/%%ACCENT%%/g, accent);
  pipWindow.document.head.appendChild(style);

  // Move the real node (not a clone) so every listener on it keeps
  // working untouched, and audio keeps playing from the hidden
  // YouTube player back in the main document the whole time.
  miniRoot.style.display = 'flex';
  pipWindow.document.body.appendChild(miniRoot);

  pipWindow.addEventListener('pagehide', () => {
    miniRoot.style.display = 'none';
    document.body.appendChild(miniRoot);
    pipWindow = null;
  }, { once: true });
}

document.getElementById('miniToggleBtn').addEventListener('click', toggleMiniPlayer);

document.getElementById('clearDataBtn').addEventListener('click', () => {
  ['youtify_accent', 'youtify_spotify_refresh', 'youtify_last_track', 'youtify_last_playlist', 'youtify_last_position', 'youtify_volume']
    .forEach(deleteCookie);
  window.location.reload();
});

document.getElementById('searchBtn').addEventListener('click', runSearch);
queryEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
queryEl.addEventListener('input', () => { if (!queryEl.value.trim()) showHome(); });

function togglePlayPause(){
  if (!ytPlayer){
    if (pendingRestoreTrack){
      const t = pendingRestoreTrack;
      const pos = pendingRestorePosition;
      pendingRestoreTrack = null;
      pendingRestorePosition = 0;
      playTrack(t, pos);
    }
    return;
  }
  const state = ytPlayer.getPlayerState();
  if (state === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
}

document.getElementById('playPause').addEventListener('click', togglePlayPause);
mpPlayPause.addEventListener('click', togglePlayPause);
mpNext.addEventListener('click', goNext);
mpPrev.addEventListener('click', goPrev);
mpProgressTrack.addEventListener('click', (e) => {
  if (!ytPlayer || !currentDuration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  ytPlayer.seekTo(currentDuration * pct, true);
});

nextBtn.addEventListener('click', goNext);
prevBtn.addEventListener('click', goPrev);
shuffleBtn.addEventListener('click', toggleShuffle);
repeatBtn.addEventListener('click', toggleRepeat);
mpShuffle.addEventListener('click', toggleShuffle);
mpRepeat.addEventListener('click', toggleRepeat);

let mutedVolume = null;

function applyVolume(v, sourceEl){
  if (ytPlayer) ytPlayer.setVolume(v);
  const icon = v === 0 ? ICONS.volMute : v < 50 ? ICONS.volMid : ICONS.volHigh;
  volumeIcon.innerHTML = icon;
  mpVolumeIcon.innerHTML = icon;
  if (sourceEl !== volumeSlider) volumeSlider.value = v;
  if (sourceEl !== mpVolumeSlider) mpVolumeSlider.value = v;
  mutedVolume = null;
  setCookie('youtify_volume', v, 365);
}

volumeSlider.addEventListener('input', () => applyVolume(Number(volumeSlider.value), volumeSlider));
mpVolumeSlider.addEventListener('input', () => applyVolume(Number(mpVolumeSlider.value), mpVolumeSlider));

function toggleMute(){
  if (mutedVolume === null){
    mutedVolume = volumeSlider.value;
    applyVolume(0);
  } else {
    applyVolume(Number(mutedVolume));
  }
}
volumeIcon.addEventListener('click', toggleMute);
mpVolumeIcon.addEventListener('click', toggleMute);

// Keyboard shortcuts — ignored while typing in the search box
document.addEventListener('keydown', (e) => {
  if (document.activeElement === queryEl) return;
  if (e.code === 'Space'){
    e.preventDefault();
    document.getElementById('playPause').click();
  } else if (e.code === 'ArrowRight'){
    goNext();
  } else if (e.code === 'ArrowLeft'){
    goPrev();
  }
});

document.getElementById('progressTrack').addEventListener('click', (e) => {
  if (!ytPlayer || !currentDuration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  ytPlayer.seekTo(currentDuration * pct, true);
});