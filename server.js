import express from "express";
import { TypeSafeClient, choice, score } from "@typesafe-ai/sdk";
import { searchCandidates, primaryArtist, GENRES, MOODS, DECADES } from "./lib/spotify.js";
import { rerankByFit } from "./lib/rerank.js";

// Constructed lazily so a missing/invalid TYPESAFE_API_KEY surfaces as a normal
// API error to the browser instead of crashing the process at boot.
let client;
function getClient() {
  if (!client) client = new TypeSafeClient();
  return client;
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

const GENRE_DESCRIPTIONS = {
  pop: "Mainstream, hook-driven, broadly accessible",
  indie: "Independent, lo-fi or alternative rock/pop sensibility",
  metal: "Heavy guitars, aggressive, distorted",
  "r&b": "Soulful, rhythmic, groove-based vocals",
  techno: "Repetitive, machine-driven dance beats, industrial or minimal (Detroit/Berlin techno tradition)",
  house: "Four-on-the-floor dance beats, soulful or deep house grooves",
  trance: "Uplifting, melodic, build-and-drop electronic dance music",
  ambient: "Atmospheric, textural, minimal-beat or beatless electronic soundscapes",
  dubstep: "Bass-heavy, syncopated electronic music with wobble basslines",
  electronic: "Synth or beat driven electronic music that isn't specifically techno, house, trance, ambient, or dubstep",
  country: "Storytelling, guitar/twang, rural or Americana themes",
  jazz: "Improvisational, swing or lounge instrumentation",
  classical: "Orchestral or piano-driven, no vocals implied",
  "hip-hop": "Rap vocals, beat-driven",
  rock: "Guitar-driven band sound, verse-chorus structure",
};

const MOOD_DESCRIPTIONS = {
  happy: "Upbeat, joyful, feel-good",
  sad: "Melancholic, heartbroken, mournful",
  chill: "Relaxed, laid-back, low-key",
  energetic: "Pumped up, driving, high spirits",
  romantic: "Love, intimacy, longing",
  angry: "Aggressive, frustrated, confrontational",
  nostalgic: "Wistful, reminiscent of the past",
  dreamy: "Hazy, floaty, atmospheric",
};

async function interpretQuery(query) {
  const genreCriteria = {
    no_preference: "No specific genre mentioned or open to anything",
    ...Object.fromEntries(GENRES.map((g) => [g, GENRE_DESCRIPTIONS[g] ?? g])),
  };
  const moodCriteria = {
    no_preference: "No specific mood implied",
    ...Object.fromEntries(MOODS.map((m) => [m, MOOD_DESCRIPTIONS[m] ?? m])),
  };
  const decadeCriteria = {
    any: "No specific era or time period implied",
    ...Object.fromEntries(DECADES.map((d) => [d, `Released in the ${d}`])),
  };

  const { answers } = await getClient().systemOne({
    state: { request: query },
    questions: {
      genre: choice("What music genre best fits this request?", genreCriteria),
      mood: choice("What mood or emotional tone is this request looking for?", moodCriteria),
      decade: choice("What decade or era does this request want, if any?", decadeCriteria),
      energy: score("How high-energy should the song be?", [
        "Calm, mellow, low-energy",
        "Relaxed, easygoing",
        "Upbeat, energetic",
        "Intense, high-energy, aggressive",
      ]),
    },
  });

  return {
    genre: answers.genre.choice,
    genreConfidence: answers.genre.confidence,
    mood: answers.mood.choice,
    moodConfidence: answers.mood.confidence,
    decade: answers.decade.choice,
    energyScore: answers.energy.score, // 0..3
  };
}

app.post("/api/search", async (req, res) => {
  const query = (req.body?.query ?? "").trim();
  console.log(`\n=== search: "${query}" ===`);
  if (!query) {
    res.status(400).json({ error: "Missing query" });
    return;
  }

  let interpreted;
  try {
    interpreted = await interpretQuery(query);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "TypeSafe request failed", detail: String(err.message ?? err) });
    return;
  }

  let candidates, relaxedFilterCount;
  try {
    ({ candidates, relaxedFilterCount } = await searchCandidates(query, interpreted, 50));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Spotify request failed", detail: String(err.message ?? err) });
    return;
  }

  try {
    const ranked = await rerankByFit(getClient(), { query, candidates });
    const results = capPerArtist(ranked, 1, 50);
    console.log(`${candidates.length} candidates -> ${results.length} results:`, results.map((r) => `${r.artist} - ${r.title}`));
    res.json({ interpreted, relaxedFilterCount, results });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "TypeSafe rerank failed", detail: String(err.message ?? err) });
  }
});

// Spotify search + fit-ranking alone can let one prolific artist dominate the
// list; walk the fit-sorted results and skip anything past `maxPerArtist`.
function capPerArtist(sorted, maxPerArtist, limit) {
  const counts = new Map();
  const picked = [];
  for (const item of sorted) {
    const key = primaryArtist(item.artist);
    const count = counts.get(key) ?? 0;
    if (count >= maxPerArtist) continue;
    counts.set(key, count + 1);
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Song finder running at http://localhost:${port}`));
