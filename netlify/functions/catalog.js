
/**
 * catalog.js — Dynamic Catalog Builder
 * Pipeline: RSS Discovery → Batch Lookup Hydration → Dedup → Playability Filter
 */
const RSS = 'https://rss.applemarketingtools.com/api/v2';
const LOOKUP = 'https://itunes.apple.com/lookup';
const TTL = 1000 * 60 * 60 * 6;      // 6 ชั่วโมง
const BATCH = 190;                    // เว้น margin จากเพดาน 200 ids/query
const UA = { 'User-Agent': 'SongFinder/3.0' };

const cache = new Map();              // key -> { ts, data }

// ในส่วนของ headers ของฟังก์ชัน catalog.js
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // เพิ่ม s-maxage ให้ CDN เก็บไว้นานขึ้น และ stale-while-revalidate สำหรับการเรียกซ้ำ
      'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
    },
  });
const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/* ---------- Stage 1: Discovery ---------- */
async function fetchChart(cc, limit) {
  const url = `${RSS}/${cc}/music/most-played/${limit}/songs.json`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`rss_${cc}_http_${res.status}`);
  const d = await res.json();
  const rows = Array.isArray(d?.feed?.results) ? d.feed.results : [];
  return rows.map((r, i) => ({
    id: String(r.id),
    rank: i + 1,
    chart: cc.toUpperCase(),
    // ค่าสำรองกรณี lookup ไม่คืนผล
    fbTitle: String(r.name ?? ''),
    fbArtist: String(r.artistName ?? ''),
    fbGenre: r.genres?.find((g) => g?.name && g.name !== 'Music')?.name || 'Pop',
    fbArt: String(r.artworkUrl100 ?? '').replace('100x100', '300x300'),
  }));
}

/* ---------- Stage 2: Hydration (batched) ---------- */
async function hydrate(ids, cc) {
  const out = new Map();
  for (const group of chunk(ids, BATCH)) {
    const qs = new URLSearchParams({
      id: group.join(','), entity: 'song', country: cc, limit: String(group.length),
    });
    const res = await fetch(`${LOOKUP}?${qs}`, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) continue;                       // ข้าม batch ที่ล้มเหลว ไม่ทำให้ทั้งชุดพัง
    const d = await res.json().catch(() => null);
    for (const t of d?.results || []) {
      if (t?.kind === 'song' && t.previewUrl) out.set(String(t.trackId), t);
    }
  }
  return out;
}

/* ---------- Stage 3: Normalization ---------- */
function toSong(seed, track) {
  const art = String(track?.artworkUrl100 || seed.fbArt || '').replace('100x100', '300x300');
  const rd = track?.releaseDate || null;
  return {
    id: seed.id,
    title: String(track?.trackName || seed.fbTitle),
    artist: String(track?.artistName || seed.fbArtist),
    genre: String(track?.primaryGenreName || seed.fbGenre),
    year: rd ? new Date(rd).getFullYear() : null,
    previewUrl: track.previewUrl,               // การันตีว่ามีค่าเสมอ (ผ่าน filter แล้ว)
    artwork: art || null,
    album: track?.collectionName || null,
    storeUrl: track?.trackViewUrl || null,
    chart: seed.chart,
    rank: seed.rank,
  };
}

/* ---------- Handler ---------- */
export default async (req) => {
  const { searchParams } = new URL(req.url);

  const countries = (searchParams.get('cc') || 'th,us')
    .toLowerCase().split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z]{2}$/.test(s))
    .slice(0, 4);
  const limit = Math.min(200, Math.max(10, Number(searchParams.get('limit')) || 100));

  if (!countries.length) return json({ ok: false, error: 'invalid_country' }, 400);

  const key = `${countries.join('-')}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return json({ ...hit.data, cached: true });

  try {
    const songs = [];
    const seen = new Set();

    for (const cc of countries) {
      let seeds;
      try { seeds = await fetchChart(cc, limit); }
      catch { continue; }                        // ประเทศใดล้มเหลว ข้ามไปประเทศถัดไป

      const fresh = seeds.filter((s) => !seen.has(s.id));
      if (!fresh.length) continue;

      const tracks = await hydrate(fresh.map((s) => s.id), cc);
      for (const s of fresh) {
        const t = tracks.get(s.id);
        if (!t) continue;                        // Playability Filter — ไม่มี preview = ตัดทิ้ง
        seen.add(s.id);
        songs.push(toSong(s, t));
      }
    }

    if (!songs.length) throw new Error('empty_catalog');

    const data = {
      ok: true,
      source: 'apple-rss-v2',
      countries: countries.map((c) => c.toUpperCase()),
      updated: new Date().toISOString(),
      count: songs.length,
      songs,
    };
    cache.set(key, { ts: Date.now(), data });
    return json(data);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err), songs: [] }, 200);
  }
};

export const config = { path: '/api/catalog' };
