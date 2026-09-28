const form = document.getElementById("search-form");
const queryInput = document.getElementById("query");
const statusEl = document.getElementById("status");
const filtersEl = document.getElementById("filters");
const resultsEl = document.getElementById("results");
const submitBtn = form.querySelector("button");

const ENERGY_LABELS = ["calm", "relaxed", "upbeat", "intense"];

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = queryInput.value.trim();
  if (!query) return;

  submitBtn.disabled = true;
  statusEl.textContent = "Asking Jev what you mean…";
  filtersEl.innerHTML = "";
  resultsEl.innerHTML = "";

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error ?? "Something went wrong.";
      return;
    }

    renderFilters(data.interpreted, data.relaxedFilterCount);
    renderResults(data.results);
    statusEl.textContent = data.results.length
      ? `${data.results.length} match${data.results.length === 1 ? "" : "es"}`
      : "No matches, even after relaxing filters.";
  } catch (err) {
    statusEl.textContent = "Request failed — check the server is running and TYPESAFE_API_KEY is set.";
  } finally {
    submitBtn.disabled = false;
  }
});

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function chip(label, value, lowConfidence) {
  const el = document.createElement("span");
  el.className = "chip" + (lowConfidence ? " low-confidence" : "");
  el.innerHTML = `${label}: <strong>${value}</strong>`;
  return el;
}

function renderFilters(interpreted, relaxedFilterCount) {
  const energyLabel = ENERGY_LABELS[Math.round(interpreted.energyScore)] ?? "moderate";

  filtersEl.append(
    chip("genre", interpreted.genre.replace("_", " "), interpreted.genreConfidence < 0.6),
    chip("mood", interpreted.mood.replace("_", " "), interpreted.moodConfidence < 0.6),
    chip("era", interpreted.decade),
    chip("energy", energyLabel)
  );

  if (relaxedFilterCount > 0) {
    const note = document.createElement("span");
    note.className = "chip low-confidence";
    note.textContent = `relaxed ${relaxedFilterCount} filter${relaxedFilterCount === 1 ? "" : "s"} to find matches`;
    filtersEl.append(note);
  }
}

function renderResults(results) {
  for (const song of results) {
    const li = document.createElement("li");
    li.className = "song";
    const art = song.image
      ? `<img class="art" src="${escapeHtml(song.image)}" alt="" width="48" height="48" />`
      : `<div class="art placeholder"></div>`;
    li.innerHTML = `
      ${art}
      <div class="info">
        <strong>${escapeHtml(song.title)}</strong>
        <span>${escapeHtml(song.artist)}${song.year ? ` · ${escapeHtml(song.year)}` : ""}</span>
      </div>
      <span class="fit" title="How well Jev thinks this fits your request">${Math.round(song.fit * 100)}% fit</span>
      <a class="listen" href="${escapeHtml(song.url)}" target="_blank" rel="noopener noreferrer">Listen ↗</a>
    `;
    resultsEl.append(li);
  }
}
