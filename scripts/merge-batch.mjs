// Merges hand-tagged overrides into the TMDB candidate pool and appends
// validated entries to data/movies.json. Factual fields (title, year,
// director, cast) come straight from TMDB; only tags/genres/synopsis are
// hand-authored per movie. Appends as raw text (one movie per line, matching
// the file's existing style) rather than re-stringifying the whole array,
// so existing entries are never reformatted.
//
// Usage: node scripts/merge-batch.mjs <candidates-pool.json> <batch-overrides.json>

import { readFileSync, writeFileSync } from 'fs';

const [poolPath, overridesPath] = process.argv.slice(2);
const pool = JSON.parse(readFileSync(poolPath, 'utf8'));
const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
const moviesPath = new URL('../data/movies.json', import.meta.url);
const rawMovies = readFileSync(moviesPath, 'utf8');
const movies = JSON.parse(rawMovies);
const taxonomy = JSON.parse(readFileSync(new URL('../data/taxonomy.json', import.meta.url), 'utf8'));
const tagIds = new Set(taxonomy.tags.map((t) => t.id));
const existingIds = new Set(movies.map((m) => m.id));

function slugify(title, year) {
  const base = title
    .toLowerCase()
    .replace(/[':,!?.]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let id = `${base}-${year}`;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${year}-${n}`;
    n++;
  }
  return id;
}

function formatMovie(m) {
  const fields = [
    `"id": ${JSON.stringify(m.id)}`,
    `"title": ${JSON.stringify(m.title)}`,
    `"year": ${m.year}`,
    `"genres": ${JSON.stringify(m.genres)}`,
    `"director": ${JSON.stringify(m.director)}`,
    `"cast": ${JSON.stringify(m.cast)}`,
    `"synopsis": ${JSON.stringify(m.synopsis)}`,
    `"tags": { ${Object.entries(m.tags)
      .map(([k, v]) => `"${k}": ${v}`)
      .join(', ')} }`,
  ];
  return `  { ${fields.join(', ')} }`;
}

const added = [];
const errors = [];

for (const ov of overrides) {
  const cand = pool[ov.index];
  if (!cand) {
    errors.push(`index ${ov.index}: not found in pool`);
    continue;
  }
  const badTags = Object.keys(ov.tags).filter((t) => !tagIds.has(t));
  if (badTags.length) {
    errors.push(`${cand.title}: unknown tags ${badTags.join(', ')}`);
    continue;
  }
  const id = slugify(cand.title, cand.year);
  existingIds.add(id);
  added.push({
    id,
    title: cand.title,
    year: cand.year,
    genres: ov.genres,
    director: cand.director,
    cast: ov.cast || cand.cast.slice(0, 3),
    synopsis: ov.synopsis,
    tags: ov.tags,
  });
}

if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}

const trimmed = rawMovies.replace(/\s*\]\s*$/, '');
const newLines = added.map(formatMovie).join(',\n');
const updated = `${trimmed},\n${newLines}\n]\n`;
writeFileSync(moviesPath, updated);
console.log(`Added ${added.length} movies. Catalog now has ${movies.length + added.length}.`);
