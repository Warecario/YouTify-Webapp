/**
 * YouTify proxy — Cloudflare Worker
 *
 * Holds the Spotify + YouTube credentials server-side and exposes two
 * safe, key-free endpoints for the static frontend to call:
 *
 *   GET /api/spotify-search?q=...
 *   GET /api/youtube-search?title=...&artist=...
 *   GET /api/youtube-search-multi?title=...&artist=...
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
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const bodyText = await res.text();
    return json({ error: "Spotify search failed", status: res.status, detail: bodyText }, 502);
  }

  const data = await res.json();

  // Only forward the fields the frontend actually needs — keeps the
  // response small and avoids leaking anything extra from Spotify.
  // `uri` is included so a track can later be added to a playlist.
  const tracks = data.tracks.items.map((t) => ({
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: {
      images: t.album.images,
    },
    external_url: t.external_urls.spotify,
  }));

  return json({ tracks });
}

// Normalizes a track into a stable cache key — same approach the
// client uses for its own personal override cookie.
function ytCacheKey(title, artist) {
  return `ytmatch:${artist}`.toLowerCase().trim() + "::" + `${title}`.toLowerCase().trim();
}

async function handleYouTubeSearch(url, env) {
  const title = url.searchParams.get("title");
  const artist = url.searchParams.get("artist");
  if (!title || !artist) return json({ error: "Missing title/artist" }, 400);

  const cacheKey = ytCacheKey(title, artist);

  // Shared cache: if ANY user has already searched this exact song,
  // reuse that match instead of spending YouTube API quota again.
  if (env.YOUTIFY_KV) {
    const cached = await env.YOUTIFY_KV.get(cacheKey);
    if (cached) return json({ videoId: cached, cached: true });
  }

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

  if (videoId && env.YOUTIFY_KV) {
    // No expiration — these mappings are stable. If a video ever gets
    // taken down, the found-nothing/broken-playback path already
    // surfaces that, and Track Select lets it be corrected per-user.
    await env.YOUTIFY_KV.put(cacheKey, videoId);
  }

  return json({ videoId });
}

// Powers "Track Select" — returns several candidate videos instead of
// just the top pick, so a wrong match (or a specific remix/lyric video)
// can be manually chosen.
async function handleYouTubeSearchMulti(url, env) {
  const title = url.searchParams.get("title");
  const artist = url.searchParams.get("artist");
  if (!title || !artist) return json({ error: "Missing title/artist" }, 400);

  const q = encodeURIComponent(`${artist} - ${title}`);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=8&type=video&q=${q}&key=${env.YOUTUBE_API_KEY}`
  );
  if (!res.ok) {
    const bodyText = await res.text();
    return json({ error: "YouTube search failed", status: res.status, detail: bodyText }, 502);
  }

  const data = await res.json();
  const results = (data.items || []).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.default?.url || item.snippet.thumbnails?.medium?.url || "",
  }));
  return json({ results });
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
      if (url.pathname === "/api/youtube-search") {
        return await handleYouTubeSearch(url, env);
      }
      if (url.pathname === "/api/youtube-search-multi") {
        return await handleYouTubeSearchMulti(url, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
