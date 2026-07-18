/**
 * YouTify proxy — Cloudflare Worker
 *
 * Holds the Spotify + YouTube credentials server-side and exposes two
 * safe, key-free endpoints for the static frontend to call:
 *
 *   GET /api/spotify-search?q=...
 *   GET /api/spotify-playlist-tracks?id=...
 *   GET /api/youtube-search?title=...&artist=...
 *
 * Secrets are read from Worker environment variables (never hardcoded
 * here, and never shipped to the browser). Set them with:
 *
 *   wrangler secret put SPOTIFY_CLIENT_ID
 *   wrangler secret put SPOTIFY_CLIENT_SECRET
 *   wrangler secret put YOUTUBE_API_KEY
 *
 * ALLOWED_ORIGIN restricts which site is allowed to call this Worker
 * (set it to your GitHub Pages URL, e.g. https://warecario.github.io).
 * This isn't a perfect lock — anyone can still see your Worker's own
 * requests going out — but it stops your keys themselves from ever
 * being visible in a browser's dev tools or page source.
 */

const ALLOWED_ORIGIN = "https://warecario.github.io";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Simple in-memory token cache (per Worker instance — not persistent,
// but avoids re-authing on every single request within a warm instance).
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSpotifyToken(env) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Spotify auth failed (${res.status}): ${bodyText}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function handleSpotifySearch(url, env) {
  const q = url.searchParams.get("q");
  if (!q) return json({ error: "Missing q param" }, 400);

  const token = await getSpotifyToken(env);
  const res = await fetch(
    // Spotify's Feb 2026 changelog capped GET /search's limit at 10
    // (previously 50) — using anything higher now gets rejected.
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track,playlist&limit=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const bodyText = await res.text();
    return json({ error: "Spotify search failed", status: res.status, detail: bodyText }, 502);
  }

  const data = await res.json();

  // Only forward the fields the frontend actually needs — keeps the
  // response small and avoids leaking anything extra from Spotify.
  const tracks = data.tracks.items.map((t) => ({
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: {
      images: t.album.images,
    },
    external_url: t.external_urls.spotify,
  }));

  // Public playlists — filter out nulls (Spotify sometimes returns null
  // entries for playlists that have gone private since being indexed).
  const playlists = (data.playlists?.items || [])
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      owner: p.owner?.display_name || "Unknown",
      images: p.images,
      external_url: p.external_urls?.spotify,
      trackCount: p.tracks?.total ?? null,
    }));

  return json({ tracks, playlists });
}

async function handlePlaylistTracks(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id param" }, 400);

  const token = await getSpotifyToken(env);
  const res = await fetch(
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}/tracks?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const bodyText = await res.text();
    return json({ error: "Playlist lookup failed", status: res.status, detail: bodyText }, 502);
  }

  const data = await res.json();
  const tracks = (data.items || [])
    .map((item) => item.track)
    .filter(Boolean)
    .map((t) => ({
      name: t.name,
      artists: t.artists.map((a) => a.name),
      album: { images: t.album.images },
      external_url: t.external_urls?.spotify,
    }));

  return json({ tracks });
}

async function handleYouTubeSearch(url, env) {
  const title = url.searchParams.get("title");
  const artist = url.searchParams.get("artist");
  if (!title || !artist) return json({ error: "Missing title/artist" }, 400);

  const q = encodeURIComponent(`${artist} - ${title} audio`);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&type=video&q=${q}&key=${env.YOUTUBE_API_KEY}`
  );
  if (!res.ok) {
    const bodyText = await res.text();
    return json({ error: "YouTube search failed", status: res.status, detail: bodyText }, 502);
  }

  const data = await res.json();
  const videoId = data.items?.[0]?.id?.videoId ?? null;
  return json({ videoId });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/spotify-search") {
        return await handleSpotifySearch(url, env);
      }
      if (url.pathname === "/api/spotify-playlist-tracks") {
        return await handlePlaylistTracks(url, env);
      }
      if (url.pathname === "/api/youtube-search") {
        return await handleYouTubeSearch(url, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};