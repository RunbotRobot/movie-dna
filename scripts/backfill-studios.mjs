// One-time backfill: adds a `studio` field to every movie in data/movies.json
// by looking each one up on TMDB (title + year search -> details ->
// production_companies). Objective metadata, not subjective tagging, so
// this runs unattended rather than needing a hand-curation pass.
//
// Usage: node scripts/backfill-studios.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MOVIES_PATH = path.join(REPO_ROOT, 'data', 'movies.json');
const KEY_PATH = path.join(__dirname, '.tmdb-key');

const apiKey = fs.readFileSync(KEY_PATH, 'utf8').trim();
const movies = JSON.parse(fs.readFileSync(MOVIES_PATH, 'utf8'));

// A handful of company names TMDB returns that are just distributors/finance
// entities, not the studio a person would actually search for.
const NOISE_COMPANIES = new Set([
  'Miramax',
  'The Weinstein Company',
  'Metro-Goldwyn-Mayer',
  'Amazon MGM Studios',
  'StudioCanal',
]);

async function lookupStudio(title, year) {
  const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const best = searchData.results?.[0];
  if (!best) return null;

  const detailsUrl = `https://api.themoviedb.org/3/movie/${best.id}?api_key=${apiKey}`;
  const detailsRes = await fetch(detailsUrl);
  if (!detailsRes.ok) return null;
  const details = await detailsRes.json();
  const companies = (details.production_companies || []).map((c) => c.name);
  const primary = companies.find((c) => !NOISE_COMPANIES.has(c)) || companies[0];
  return primary || null;
}

async function main() {
  let updated = 0;
  let missed = 0;
  for (let i = 0; i < movies.length; i++) {
    const movie = movies[i];
    try {
      const studio = await lookupStudio(movie.title, movie.year);
      if (studio) {
        movie.studio = studio;
        updated++;
      } else {
        missed++;
        console.error(`no studio found: ${movie.title} (${movie.year})`);
      }
    } catch (err) {
      missed++;
      console.error(`error on ${movie.title} (${movie.year}):`, err.message);
    }
    if ((i + 1) % 50 === 0) console.error(`... ${i + 1}/${movies.length}`);
    // TMDB's free tier is generous but not unlimited — stay well under it.
    await new Promise((r) => setTimeout(r, 60));
  }

  fs.writeFileSync(MOVIES_PATH, JSON.stringify(movies, null, 2) + '\n');
  console.error(`Done. Updated ${updated}, missed ${missed}.`);
}

main();
