// Builds data/artiflix-movies.json: a second, separate movie catalog sourced
// from artiflix.com's own public sitemap (robots.txt explicitly allows
// crawling and publishes it — this never touches artiflix's actual
// authenticated Gizmott API). The sitemap only gives us titles (as URL
// slugs), so real metadata — genres, cast, director, synopsis, year — comes
// from TMDB, the same source the main catalog uses.
//
// `tags` is intentionally left empty here: DNA tagging is a separate,
// hand-done pass against the (still-being-expanded) taxonomy, same as the
// main catalog.
//
// Usage: node scripts/fetch-artiflix.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'artiflix-movies.json');
const KEY_PATH = path.join(__dirname, '.tmdb-key');
const SITEMAP_URL = 'https://artiflix.com/sitemap.xml';

const apiKey = fs.readFileSync(KEY_PATH, 'utf8').trim();

function slugToTitle(slug) {
  return slug
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

async function fetchSlugs() {
  const res = await fetch(SITEMAP_URL);
  const xml = await res.text();
  const slugs = [...xml.matchAll(/show-details\/([^<]+)</g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

async function lookupMovie(title) {
  const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const best = searchData.results?.[0];
  if (!best) return null;

  const detailsUrl = `https://api.themoviedb.org/3/movie/${best.id}?api_key=${apiKey}&append_to_response=credits`;
  const detailsRes = await fetch(detailsUrl);
  if (!detailsRes.ok) return null;
  const d = await detailsRes.json();
  if (!d.release_date) return null;

  const director = (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name);
  const cast = (d.credits?.cast || []).slice(0, 5).map((c) => c.name);
  const studio = d.production_companies?.[0]?.name || null;

  return {
    title: d.title,
    year: Number(d.release_date.slice(0, 4)),
    genres: (d.genres || []).map((g) => g.name.toLowerCase()),
    director: director.join(', ') || 'Unknown',
    cast,
    synopsis: d.overview || '',
    studio,
  };
}

async function main() {
  const slugs = await fetchSlugs();
  console.error(`Found ${slugs.length} titles in sitemap.`);

  const out = [];
  let missed = 0;
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const title = slugToTitle(slug);
    try {
      const movie = await lookupMovie(title);
      if (movie && movie.cast.length > 0) {
        out.push({
          id: `artiflix-${slug}`,
          title: movie.title,
          year: movie.year,
          genres: movie.genres,
          director: movie.director,
          cast: movie.cast,
          synopsis: movie.synopsis,
          studio: movie.studio,
          tags: {},
        });
      } else {
        missed++;
        console.error(`no confident TMDB match: "${title}" (slug: ${slug})`);
      }
    } catch (err) {
      missed++;
      console.error(`error on "${title}":`, err.message);
    }
    if ((i + 1) % 50 === 0) console.error(`... ${i + 1}/${slugs.length}`);
    await new Promise((r) => setTimeout(r, 60));
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.error(`Done. Matched ${out.length}, missed ${missed}. Wrote ${OUT_PATH}.`);
}

main();
