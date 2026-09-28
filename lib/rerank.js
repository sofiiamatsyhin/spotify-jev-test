import { score } from "@typesafe-ai/sdk";

// Judges each candidate directly against the listener's own words, rather
// than against a fixed mood/energy bucket — one batched request, one graded
// Score question per candidate, all evaluated in parallel over shared state.
//
// We only pass title/artist/year: Spotify's `genres` field on Artist objects
// and its `audio-features` endpoint are both restricted/emptied for many
// newly created apps, so there's no reliable tag or audio data to hand over.
// Instead the question leans on Jev's own trained knowledge of real artists
// and tracks to judge genre/mood/energy — the same way a knowledgeable
// person would recognize "Nine Inch Nails" as aggressive industrial rock
// without needing a genre tag spelled out.
//
// Uses Score rather than a yes/no Noul: a strict "does this strongly match"
// yes/no question made Jev hedge low whenever any part felt unconfirmed. An
// ordered rubric lets a plausible match land in the middle instead of
// defaulting low, while still separating clear mismatches from clear hits.
export async function rerankByFit(client, { query, candidates }) {
  if (candidates.length === 0) return [];

  const state = {
    request: query,
    candidates: candidates.map((c, i) => ({
      index: i,
      title: c.title,
      artist: c.artist,
      year: c.year,
    })),
  };

  const questions = {};
  candidates.forEach((_, i) => {
    questions[`fit_${i}`] = score(
      `Using what you know about the artist and track in \`candidates[${i}]\` — its actual genre, ` +
        `typical mood, and energy level — how well does it fit what the listener is asking for in \`request\`?`,
      [
        "Conflicts — genre, era, or typical mood/energy clearly contradicts the request",
        "Loosely related — same general area, but not a strong match on genre or mood/energy",
        "Good fit — genre and mood/energy both align well with the request",
        "Excellent fit — a near-ideal match for genre, era, and mood/energy",
      ]
    );
  });

  const { answers } = await client.systemOne({ state, questions });

  return candidates
    .map((c, i) => ({ ...c, fit: answers[`fit_${i}`].score / 3 }))
    .sort((a, b) => b.fit - a.fit);
}
