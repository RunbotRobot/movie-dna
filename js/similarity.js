function normalize(str) {
  return str.trim().toLowerCase();
}

export function cosineSim(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const key of keys) {
    const va = a[key] || 0;
    const vb = b[key] || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function directorNames(movie) {
  return movie.director.split(',').map((d) => d.trim());
}

function buildPersonSeed(label, personMovies) {
  const tagVector = {};
  for (const movie of personMovies) {
    for (const [tag, weight] of Object.entries(movie.tags)) {
      tagVector[tag] = (tagVector[tag] || 0) + weight;
    }
  }
  for (const tag in tagVector) {
    tagVector[tag] /= personMovies.length;
  }
  const genreSet = new Set();
  for (const movie of personMovies) {
    for (const genre of movie.genres) genreSet.add(genre);
  }
  return { type: 'person', label, tagVector, genreSet, excludeIds: new Set() };
}

function buildTextSeed(query, taxonomy) {
  const words = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const tagVector = {};
  for (const tag of taxonomy.tags) {
    const haystack = normalize(`${tag.label} ${tag.description} ${tag.id.replace(/_/g, ' ')}`);
    let matches = 0;
    for (const word of words) {
      if (haystack.includes(word)) matches += 1;
    }
    if (matches > 0) {
      tagVector[tag.id] = Math.min(1, matches / Math.max(1, words.length));
    }
  }
  return { type: 'text', label: query, tagVector, genreSet: new Set(), excludeIds: new Set() };
}

export function resolveSeed(query, movies, taxonomy) {
  const q = normalize(query);
  if (!q) return null;

  const exactMovie = movies.find((m) => normalize(m.title) === q);
  const looseMovie = exactMovie || (q.length >= 3 ? movies.find((m) => normalize(m.title).includes(q)) : null);
  if (looseMovie) {
    return {
      type: 'movie',
      label: looseMovie.title,
      tagVector: looseMovie.tags,
      genreSet: new Set(looseMovie.genres),
      excludeIds: new Set([looseMovie.id]),
    };
  }

  const exactPersonMovies = movies.filter(
    (m) => m.cast.some((c) => normalize(c) === q) || directorNames(m).some((d) => normalize(d) === q)
  );
  let personMovies = exactPersonMovies;
  if (personMovies.length === 0 && q.length >= 3) {
    personMovies = movies.filter(
      (m) => m.cast.some((c) => normalize(c).includes(q)) || directorNames(m).some((d) => normalize(d).includes(q))
    );
  }
  if (personMovies.length > 0) {
    const first = personMovies[0];
    const matchedCast = first.cast.find((c) => normalize(c).includes(q));
    const matchedDirector = directorNames(first).find((d) => normalize(d).includes(q));
    const label = matchedCast || matchedDirector || query;
    return buildPersonSeed(label, personMovies);
  }

  return buildTextSeed(query, taxonomy);
}

export function combineSeeds(seedObjs) {
  const valid = seedObjs.filter(Boolean);
  if (valid.length === 0) return null;

  const tagVector = {};
  for (const seed of valid) {
    for (const [tag, weight] of Object.entries(seed.tagVector)) {
      tagVector[tag] = (tagVector[tag] || 0) + weight;
    }
  }
  for (const tag in tagVector) {
    tagVector[tag] /= valid.length;
  }

  const genreSet = new Set();
  const excludeIds = new Set();
  for (const seed of valid) {
    for (const genre of seed.genreSet) genreSet.add(genre);
    for (const id of seed.excludeIds) excludeIds.add(id);
  }

  return { tagVector, genreSet, excludeIds };
}

export function scoreMovies(query, movies) {
  if (!query) return [];
  return movies
    .filter((m) => !query.excludeIds.has(m.id))
    .map((movie) => {
      const tagSim = cosineSim(query.tagVector, movie.tags);
      const genreSim = query.genreSet.size ? jaccard(query.genreSet, new Set(movie.genres)) : 0;
      const score = query.genreSet.size ? 0.8 * tagSim + 0.2 * genreSim : tagSim;
      return { movie, score };
    })
    .sort((a, b) => b.score - a.score);
}
