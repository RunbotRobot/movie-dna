export async function loadData() {
  const [taxonomyRes, moviesRes] = await Promise.all([
    fetch('data/taxonomy.json'),
    fetch('data/movies.json'),
  ]);
  const taxonomy = await taxonomyRes.json();
  const movies = await moviesRes.json();
  return { taxonomy, movies };
}
