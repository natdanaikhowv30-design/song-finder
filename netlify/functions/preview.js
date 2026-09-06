const ITUNES = 'https://itunes.apple.com/search';
const TTL = 1000 * 60 * 60 * 6;
const MAX_CACHE = 500;
const cache = new Map();

let spToken = null; // { value, exp }

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=21600',
    },
  });

const norm = (v) =>
  String(v ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/* ---------- Apple iTunes ---------- */
async function queryItunes(term, country) {
  const qs = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '10', country });
  const res = await fetch(`${ITUNES}?${qs}`, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'SongFinder/2.0' },
  });
  if (!res.ok) throw new Error(`itunes_http_${res.status}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

function pickBest(results, title, artist) {
  const t = norm(title), a = norm(artist);
  const playable = results.filter((r) => r && r.previewUrl);
  if (!playable.length) return null;

  const scored = playable.map((r) => {
    const rt = norm(r.trackName), ra = norm(r.artistName);
    let s = 0;
    if (rt === t) s += 100;
    else if (rt.startsWith(t) || t.startsWith(rt)) s += 60;
    else if (rt.includes(t) || t.includes(rt)) s += 35;
    if (a) {
      if (ra === a) s += 80;
      else if (ra.includes(a) || a.includes(ra)) s += 45;
    }
    return { r, s };
  });
  scored.sort((x, y) => y.s - x.s);
  return scored[0].s >= 35 ? scored[0].r : null;
}

/* ---------- Spotify (optional: Client Credentials Flow) ---------- */
async function spotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (spToken && Date.now() < spToken.exp) return spToken.value;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const d = await res.json();
  spToken = { value: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return spToken.value;
}

async function spotifyLookup(title, artist) {
  try {
    const tok = await spotifyToken();
    if (!tok) return null;
    const qs = new URLSearchParams({
      q: `track:${title} artist:${artist}`, type: 'track', limit: '1', market: 'TH',
    });
    const res = await fetch(`https://api.spotify.com/v1/search?${qs}`, {
      headers: { Authorization: `Bearer ${tok}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const tr = d?.tracks?.items?.[0];
    // NOTE: preview_url ถูก deprecate แล้ว — ใช้ id เพื่อทำ iframe embed แทน
    return tr ? { id: tr.id, url: tr.external_urls?.spotify || null } : null;
  } catch { return null; }
}

/* ---------- YouTube (optional: quota-guarded) ---------- */
async function youtubeLookup(term) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const qs = new URLSearchParams({
      part: 'snippet', q: term, type: 'video', videoEmbeddable: 'true',
      maxResults: '1', key,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${qs}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null; // 403 = quotaExceeded → fallback เป็น deep link
    const d = await res.json();
    return d?.items?.[0]?.id?.videoId || null;
  } catch { return null; }
}

/* ---------- Handler ---------- */
export default async (req) => {
  const { searchParams } = new URL(req.url);
  const title = (searchParams.get('title') || '').trim().slice(0, 120);
  const artist = (searchParams.get('artist') || '').trim().slice(0, 120);
  const term = `${title} ${artist}`.trim();
  if (!term) return json({ found: false, error: 'missing_query' }, 400);

  const key = norm(term);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return json(hit.data);

  const enc = encodeURIComponent(term);
  const links = {
    youtube: `https://www.youtube.com/results?search_query=${enc}`,
    google: `https://www.google.com/search?q=${enc}`,
    spotify: `https://open.spotify.com/search/${enc}`,
    apple: null, spotifyId: null, youtubeId: null,
  };

  try {
    let track = pickBest(await queryItunes(term, 'TH'), title, artist);
    if (!track) track = pickBest(await queryItunes(term, 'US'), title, artist);
    if (!track && artist) track = pickBest(await queryItunes(title, 'TH'), title, artist);

    // เรียกแบบขนานเพื่อลด latency
    const [sp, yt] = await Promise.all([
      spotifyLookup(title, artist),
      youtubeLookup(term),
    ]);
    if (sp) { links.spotifyId = sp.id; if (sp.url) links.spotify = sp.url; }
    if (yt) links.youtubeId = yt;
    if (track?.trackViewUrl) links.apple = track.trackViewUrl;

    const payload = {
      found: Boolean(track),
      previewUrl: track?.previewUrl || null,
      artwork: track?.artworkUrl100 ? String(track.artworkUrl100).replace('100x100', '200x200') : null,
      trackName: track?.trackName || title,
      artistName: track?.artistName || artist,
      album: track?.collectionName || null,
      links,
    };

    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { ts: Date.now(), data: payload });
    return json(payload);
  } catch (err) {
    return json({ found: false, links, error: String(err.message || err) }, 200);
  }
};

export const config = { path: '/api/preview' };
