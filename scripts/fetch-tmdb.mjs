// One-off data-pull tool: fetches popular movies from TMDB (real title, year,
// genres, director, top cast, overview) and dedupes against the existing
// hand-tagged catalog. Output is a raw candidate list — tag weights are
// assigned by hand afterward, not by this script (see conversation: we
// deliberately chose hand-tagging over rules-based auto-tagging for quality).
//
// Usage: node scripts/fetch-tmdb.mjs <startPage> <endPage> > scripts/candidates-N.json
// Reads the API key from scripts/.tmdb-key (gitignored, never committed).

import { readFileSync } from 'fs';

const KEY = readFileSync(new URL('./.tmdb-key', import.meta.url), 'utf8').trim();
const [startPage, endPage] = process.argv.slice(2).map(Number);

const existing = JSON.parse(readFileSync(new URL('../data/movies.json', import.meta.url), 'utf8'));
const existingKeys = new Set(existing.map((m) => `${m.title.toLowerCase()}|${m.year}`));

async function tmdbFetch(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const candidates = [];

for (let page = startPage; page <= endPage; page++) {
  const discover = await tmdbFetch('/discover/movie', {
    sort_by: 'popularity.desc',
    page,
    'vote_count.gte': 300,
    'release_date.lte': new Date().toISOString().slice(0, 10),
    include_adult: 'false',
  });

  const today = new Date().toISOString().slice(0, 10);
  for (const item of discover.results) {
    if (!item.release_date || item.release_date > today) continue; // skip unreleased/future titles
    const year = Number(item.release_date.slice(0, 4));
    const key = `${item.title.toLowerCase()}|${year}`;
    if (existingKeys.has(key)) continue;

    await sleep(60);
    const details = await tmdbFetch(`/movie/${item.id}`, { append_to_response: 'credits' });
    const director = details.credits.crew.find((c) => c.job === 'Director');
    const cast = details.credits.cast.slice(0, 4).map((c) => c.name);
    if (!director || cast.length === 0 || !details.overview) continue;

    candidates.push({
      title: details.title,
      year,
      genres: details.genres.map((g) => g.name),
      director: director.name,
      cast,
      overview: details.overview,
      popularity: details.popularity,
      vote_count: details.vote_count,
    });
    existingKeys.add(key); // avoid dupes across pages within this run too
  }
  await sleep(60);
  process.stderr.write(`page ${page} done, ${candidates.length} candidates so far\n`);
}

process.stdout.write(JSON.stringify(candidates, null, 2));
