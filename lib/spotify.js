// Spotify search terms for each genre in our schema. Spotify's genre filter
// matches its own internal taxonomy loosely, so plain genre names work for
// these broad categories.
export const GENRE_QUERY_TERMS = {
  pop: "pop",
  indie: "indie",
  metal: "metal",
  "r&b": "r-b",
  techno: "techno",
  house: "house",
  trance: "trance",
  ambient: "ambient",
  dubstep: "dubstep",
  electronic: "electronic",
  country: "country",
  jazz: "jazz",
  classical: "classical",
  "hip-hop": "hip-hop",
  rock: "rock",
};

export const GENRES = Object.keys(GENRE_QUERY_TERMS);
export const MOODS = ["happy", "sad", "chill", "energetic", "romantic", "angry", "nostalgic", "dreamy"];
export const DECADES = ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET");
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function yearRangeFor(decade) {
  if (decade === "any") return null;
  const start = parseInt(decade, 10);
  return `${start}-${start + 9}`;
}

// Spotify's de facto convention puts version info after " - " (remix,
// remaster, radio edit, single version, ...); the part before it is the
// underlying song.
function baseTitle(title) {
  return title.split(" - ")[0].trim().toLowerCase();
}

// Ignores featured/remixer credits appended after the first artist, so
// "Artist X, Some Remixer" groups with plain "Artist X".
export function primaryArtist(artistCredit) {
  return artistCredit.split(",")[0].trim().toLowerCase();
}

// An explicit `limit` param on /v1/search 400s with "Invalid limit" for some
// apps (observed default page size: 5), so we don't send one — instead we
// paginate via the `next` link until we have enough candidates.
async function runSearch(token, filters, want) {
  const q = filters.length ? filters.join(" ") : "music";
  let url = `https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: "track" })}`;
  // Spotify's search pagination isn't perfectly stable — the same track can
  // reappear across `next` pages — so we dedupe by track id as we go.
  const seen = new Map();
  let hops = 0;
  const maxHops = Math.ceil(want / 4) + 3; // headroom for small per-page defaults
  while (url && seen.size < want && hops < maxHops) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Spotify search failed: ${res.status} for q="${q}" — ${body}`);
    }
    const data = await res.json();
    for (const item of data.tracks?.items ?? []) {
      if (item?.id && !seen.has(item.id)) seen.set(item.id, item);
    }
    url = data.tracks?.next ?? null;
    hops++;
  }
  return [...seen.values()];
}

// Runs a search, progressively dropping filters from the end (year before
// genre) if nothing comes back at all.
async function fetchPool(token, filters, want) {
  let order = [...filters];
  let tracks = await runSearch(token, order, want);
  let relaxedCount = 0;
  while (tracks.length === 0 && order.length > 0) {
    order = order.slice(0, -1);
    relaxedCount++;
    tracks = await runSearch(token, order, want);
  }
  return { tracks, relaxedCount };
}

// Electronic-music catalogs are full of the same underlying track released
// as many official remixes — different title suffix ("- XYZ Remix"),
// different remixer tacked onto the artist credits — which would otherwise
// read as distinct songs/artists. Group by the part of the title before
// Spotify's de facto " - <version>" separator and by the primary (first)
// artist only, keeping whichever version is most popular.
function dedupeSongs(tracks) {
  const byBaseSong = new Map();
  for (const track of tracks) {
    const key = `${primaryArtist(track.artists[0]?.name ?? "")}|${baseTitle(track.name)}`;
    const existing = byBaseSong.get(key);
    if (!existing || track.popularity > existing.popularity) byBaseSong.set(key, track);
  }
  return [...byBaseSong.values()];
}

// Fetches candidates from two pools and merges them: a pure genre/era pool
// (unbiased by wording, but with no text for Spotify's relevance ranking to
// work with — can surface obscure catalog matches) and a keyword-boosted
// pool that adds the listener's own words as free text (can surface
// genuinely relevant, well-known matches when a word like "detroit" is
// genre-relevant — but taken alone, a distinctive word in the query can
// hijack results entirely, e.g. every result becoming a song with that word
// literally in the title regardless of genre/mood fit). Merging means one
// signal can't dominate the other; Jev's rerank step (lib/rerank.js) judges
// real fit either way, using its own knowledge of the actual artists/tracks
// — Spotify has no mood filter, and both its audio-features endpoint and the
// `genres` field on Artist objects are restricted/emptied for many newly
// created apps, so we don't rely on either.
export async function searchCandidates(query, { genre, decade }, desiredCount = 15) {
  const token = await getToken();

  const genreYearFilters = [];
  if (genre !== "no_preference") genreYearFilters.push(`genre:${GENRE_QUERY_TERMS[genre] ?? genre}`);
  const yearRange = yearRangeFor(decade);
  if (yearRange) genreYearFilters.push(`year:${yearRange}`);

  const half = Math.ceil(desiredCount / 2);
  const trimmedQuery = query.trim();
  const [genreOnly, withKeywords] = await Promise.all([
    fetchPool(token, genreYearFilters, half),
    trimmedQuery
      ? fetchPool(token, [trimmedQuery, ...genreYearFilters], half)
      : Promise.resolve({ tracks: [], relaxedCount: 0 }),
  ]);

  const tracks = dedupeSongs([...genreOnly.tracks, ...withKeywords.tracks]).slice(0, desiredCount);
  const relaxedFilterCount = Math.min(genreOnly.relaxedCount, withKeywords.relaxedCount);

  const candidates = tracks.map((track) => ({
    title: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    year: (track.album.release_date || "").slice(0, 4),
    popularity: track.popularity,
    image: track.album.images?.[2]?.url ?? track.album.images?.[0]?.url ?? null,
    url: track.external_urls.spotify,
  }));

  return { candidates, relaxedFilterCount };
}
