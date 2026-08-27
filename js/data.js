// Two separate movie catalogs sharing one taxonomy: the main hand-tagged
// catalog, and a second one sourced from artiflix.com's public catalog of
// classic/public-domain-style films (see scripts/fetch-artiflix.mjs). They
// never mix within a single search — see js/app.js's catalog switcher.
export async function loadData() {
  const [taxonomyRes, moviesRes, artiflixRes] = await Promise.all([
    fetch('data/taxonomy.json'),
    fetch('data/movies.json'),
    fetch('data/artiflix-movies.json'),
  ]);
  const taxonomy = await taxonomyRes.json();
  const movies = await moviesRes.json();
  const artiflixMovies = await artiflixRes.json();
  return { taxonomy, movies, artiflixMovies };
}
