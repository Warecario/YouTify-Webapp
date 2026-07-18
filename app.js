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
const SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative";

let spotifyAccessToken = null;
let spotifyRefreshToken = null;
let currentPlaylistContext = null; // { id, name } or null when playing from search
let pendingRestoreTrack = null;

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

const ACCENT_COLORS = [
  { name: "Spotify green", value: "#1DB954" },
  { name: "Electric blue",  value: "#3D8BFF" },
  { name: "Violet",         value: "#B15CFF" },
  { name: "Amber",          value: "#FFB020" },
  { name: "Hot pink",       value: "#FF4D8D" },
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

const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const queryEl = document.getElementById('query');
const playerBarEl = document.getElementById('player-bar');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');
const volumeSlider = document.getElementById('volumeSlider');
const volumeIcon = document.getElementById('volumeIcon');

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

async function spotifyUserFetch(path){
  let res = await fetch(`https://api.spotify.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  });
  if (res.status === 401 && await refreshSpotifyToken()){
    res = await fetch(`https://api.spotify.com/v1/${path}`, {
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
    data.items.forEach(pl => {
      const row = document.createElement('div');
      row.className = 'playlist-row';
      row.textContent = pl.name;
      row.addEventListener('click', () => loadPlaylistTracks(pl.id, pl.name, row));
      listEl.appendChild(row);
    });
  } catch (err){
    setStatus(err.message);
  }
}

async function loadPlaylistTracks(playlistId, playlistName, rowEl){
  document.querySelectorAll('.playlist-row').forEach(r => r.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');

  setStatus(`Loading "${playlistName}"…`);
  resultsEl.innerHTML = '';
  try {
    const res = await spotifyUserFetch(`playlists/${playlistId}/tracks?limit=100`);
    if (!res.ok) throw new Error('Could not load that playlist.');
    const data = await res.json();
    const tracks = data.items
      .map(item => item.track)
      .filter(Boolean)
      .map(t => ({
        name: t.name,
        artists: t.artists.map(a => a.name),
        album: { images: t.album.images },
        external_url: t.external_urls?.spotify,
      }));
    if (!tracks.length){ setStatus('This playlist has no tracks.'); return; }
    setStatus('');
    currentPlaylistContext = { id: playlistId, name: playlistName, source: 'user' };
    currentResults = tracks;
    currentIndex = -1;
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
  return res.json(); // { tracks: [...], playlists: [...] }
}

async function fetchPublicPlaylistTracks(playlistId){
  const url = `${PROXY_BASE_URL}/api/spotify-playlist-tracks?id=${encodeURIComponent(playlistId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Playlist lookup failed — is the proxy deployed and reachable?");
  const data = await res.json();
  return data.tracks;
}

async function findYouTubeVideoId(title, artist){
  const url = `${PROXY_BASE_URL}/api/youtube-search?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("YouTube lookup failed — is the proxy deployed and reachable?");
  const data = await res.json();
  return data.videoId;
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
      playerVars: { autoplay: 1, controls: 0 },
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
    currentDuration = ytPlayer.getDuration();
    startProgressLoop();
  } else {
    disc.classList.remove('playing');
    playPauseBtn.innerHTML = ICONS.play;
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
function updateProgress(){
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const cur = ytPlayer.getCurrentTime();
  const dur = currentDuration || ytPlayer.getDuration() || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('timeCur').textContent = formatTime(cur);
  document.getElementById('timeDur').textContent = formatTime(dur);
}

/* ---------- Search + queue ---------- */

async function runSearch(){
  const q = queryEl.value.trim();
  if (!q) return;
  resultsEl.innerHTML = '';
  setStatus('Searching Spotify…');
  try {
    const { tracks = [], playlists = [] } = (await searchSpotify(q)) || {};
    if (!tracks.length && !playlists.length){ setStatus('No matches found.'); return; }
    setStatus('');
    currentPlaylistContext = null;
    currentResults = tracks;
    currentIndex = -1;
    historyStack = [];
    forwardStack = [];

    if (tracks.length){
      const tracksLabel = document.createElement('div');
      tracksLabel.className = 'section-label';
      tracksLabel.textContent = 'Songs';
      resultsEl.appendChild(tracksLabel);
      tracks.forEach((t, i) => renderResultRow(t, i));
    }

    if (playlists.length){
      const plLabel = document.createElement('div');
      plLabel.className = 'section-label';
      plLabel.textContent = 'Public Playlists';
      resultsEl.appendChild(plLabel);
      playlists.forEach(p => renderPlaylistResultRow(p));
    }
  } catch (err){
    setStatus(err.message);
  }
}

function renderPlaylistResultRow(playlist){
  const row = document.createElement('div');
  row.className = 'playlist-result-row';
  const art = playlist.images?.[0]?.url || '';
  const sub = playlist.trackCount != null
    ? `By ${playlist.owner} · ${playlist.trackCount} tracks`
    : `By ${playlist.owner}`;
  row.innerHTML = `
    <img src="${art}" alt="">
    <div class="playlist-result-meta">
      <div class="playlist-result-title">${playlist.name}</div>
      <div class="playlist-result-sub">${sub}</div>
    </div>
  `;
  row.addEventListener('click', () => loadPublicPlaylistTracks(playlist.id, playlist.name, row));
  resultsEl.appendChild(row);
}

async function loadPublicPlaylistTracks(playlistId, playlistName, rowEl){
  document.querySelectorAll('.playlist-result-row, .playlist-row').forEach(r => r.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');

  setStatus(`Loading "${playlistName}"…`);
  resultsEl.innerHTML = '';
  try {
    const tracks = await fetchPublicPlaylistTracks(playlistId);
    if (!tracks.length){ setStatus('This playlist has no tracks.'); return; }
    setStatus('');
    currentPlaylistContext = { id: playlistId, name: playlistName, source: 'public' };
    currentResults = tracks;
    currentIndex = -1;
    historyStack = [];
    forwardStack = [];
    tracks.forEach((t, i) => renderResultRow(t, i));
  } catch (err){
    setStatus(err.message);
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
  prevBtn.disabled = historyStack.length === 0;
  nextBtn.disabled = forwardStack.length === 0 && nextIndexFrom(currentIndex) === -1;
}

function generateShuffleOrder(){
  const arr = currentResults.map((_, i) => i);
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextIndexFrom(index){
  if (shuffleOn){
    if (!shuffleOrder.length) shuffleOrder = generateShuffleOrder();
    let pos = shuffleOrder.indexOf(index);
    pos = (pos + 1) % shuffleOrder.length;
    return shuffleOrder[pos];
  }
  if (index < currentResults.length - 1) return index + 1;
  return repeatMode === 'all' ? 0 : -1;
}

async function playAt(index){
  if (index < 0 || index >= currentResults.length) return;
  currentIndex = index;
  highlightActiveRow();
  updateTransportButtons();
  await playTrack(currentResults[index]);
}

// A manual pick (clicking a row, or a playlist) — always the start of a
// new forward path, so any old "redo forward" history is discarded.
function playFromRow(index){
  if (currentIndex !== -1) historyStack.push(currentIndex);
  forwardStack = [];
  playAt(index);
}

function goNext(){
  if (currentIndex === -1) return;
  if (forwardStack.length){
    historyStack.push(currentIndex);
    playAt(forwardStack.pop());
    return;
  }
  const next = nextIndexFrom(currentIndex);
  if (next === -1) return;
  historyStack.push(currentIndex);
  playAt(next);
}

function goPrev(){
  if (!historyStack.length) return;
  forwardStack.push(currentIndex);
  playAt(historyStack.pop());
}

function toggleShuffle(){
  shuffleOn = !shuffleOn;
  shuffleBtn.classList.toggle('toggled', shuffleOn);
  if (shuffleOn) shuffleOrder = generateShuffleOrder();
  updateTransportButtons();
}

function toggleRepeat(){
  const modes = ['off', 'all', 'one'];
  repeatMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];
  repeatBtn.classList.toggle('toggled', repeatMode !== 'off');
  repeatBtn.innerHTML = repeatMode === 'one' ? ICONS.repeatOne : ICONS.repeat;
  updateTransportButtons();
}

async function playTrack(track){
  const artists = track.artists.join(', ');
  setStatus('Finding playback source on YouTube…');

  playerBarEl.style.display = 'flex';
  document.getElementById('nowArt').src = track.album.images[0]?.url || '';
  document.getElementById('nowTitle').textContent = track.name;
  document.getElementById('nowArtist').textContent = artists;
  document.getElementById('spotifyLink').href = track.external_url;
  saveNowPlayingCookie(track);
  recordRecentlyPlayed(track);

  try {
    const videoId = await findYouTubeVideoId(track.name, artists);
    if (!videoId){ setStatus('No YouTube match found for this track.'); return; }
    setStatus('');
    await ensurePlayer(videoId);
  } catch (err){
    setStatus(err.message);
  }
}

function recordRecentlyPlayed(track){
  recentlyPlayed = recentlyPlayed.filter(t =>
    !(t.name === track.name && t.artists.join(',') === track.artists.join(',')));
  recentlyPlayed.unshift(track);
  if (recentlyPlayed.length > 8) recentlyPlayed.length = 8;
  renderRecentlyPlayed();
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
  if (savedPlaylistRaw && (spotifyAccessToken || JSON.parse(savedPlaylistRaw).source === 'public')){
    try {
      const pl = JSON.parse(savedPlaylistRaw);
      if (pl.source === 'user' && spotifyAccessToken){
        await loadPlaylistTracks(pl.id, pl.name);
      } else if (pl.source === 'public'){
        await loadPublicPlaylistTracks(pl.id, pl.name);
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
  playerBarEl.style.display = 'flex';
  document.getElementById('nowArt').src = track.album.images[0]?.url || '';
  document.getElementById('nowTitle').textContent = track.name;
  document.getElementById('nowArtist').textContent = track.artists.join(', ');
  document.getElementById('spotifyLink').href = track.external_url || '#';
}

/* ---------- Wiring ---------- */

shuffleBtn.innerHTML = ICONS.shuffle;
repeatBtn.innerHTML = ICONS.repeat;
prevBtn.innerHTML = ICONS.prev;
nextBtn.innerHTML = ICONS.next;
document.getElementById('playPause').innerHTML = ICONS.play;
volumeIcon.innerHTML = ICONS.volHigh;

initSwatches();
document.getElementById('loginBtn').addEventListener('click', startSpotifyLogin);
handleSpotifyRedirect().then(restoreSession);

const settingsModal = document.getElementById('settingsModal');
document.getElementById('settingsBtn').addEventListener('click', () => settingsModal.classList.add('open'));
document.getElementById('closeSettings').addEventListener('click', () => settingsModal.classList.remove('open'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

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
  settingsModal.classList.remove('open');
});

document.getElementById('clearDataBtn').addEventListener('click', () => {
  ['youtify_accent', 'youtify_spotify_refresh', 'youtify_last_track', 'youtify_last_playlist']
    .forEach(deleteCookie);
  window.location.reload();
});

document.getElementById('searchBtn').addEventListener('click', runSearch);
queryEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

document.getElementById('playPause').addEventListener('click', () => {
  if (!ytPlayer){
    if (pendingRestoreTrack){
      const t = pendingRestoreTrack;
      pendingRestoreTrack = null;
      playTrack(t);
    }
    return;
  }
  const state = ytPlayer.getPlayerState();
  if (state === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
});

nextBtn.addEventListener('click', goNext);
prevBtn.addEventListener('click', goPrev);
shuffleBtn.addEventListener('click', toggleShuffle);
repeatBtn.addEventListener('click', toggleRepeat);

let mutedVolume = null;
volumeSlider.addEventListener('input', () => {
  const v = Number(volumeSlider.value);
  if (ytPlayer) ytPlayer.setVolume(v);
  volumeIcon.innerHTML = v === 0 ? ICONS.volMute : v < 50 ? ICONS.volMid : ICONS.volHigh;
  mutedVolume = null;
});
volumeIcon.addEventListener('click', () => {
  if (mutedVolume === null){
    mutedVolume = volumeSlider.value;
    volumeSlider.value = 0;
  } else {
    volumeSlider.value = mutedVolume;
    mutedVolume = null;
  }
  volumeSlider.dispatchEvent(new Event('input'));
});

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