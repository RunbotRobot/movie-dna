function normalize(str) {
  return str.trim().toLowerCase();
}

// Classic Levenshtein edit distance (single-row DP), used for typo tolerance
// on titles, names, and free-text theme words.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// 1.0 = identical, 0.0 = completely different, scaled by the longer string's
// length so the threshold below stays proportionate for short vs. long text.
function similarityRatio(a, b) {
  if (!a.length && !b.length) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const FUZZY_THRESHOLD = 0.72;
const FUZZY_MIN_LENGTH = 4;

function bestFuzzyTitleMatch(q, movies) {
  let best = null;
  for (const movie of movies) {
    const ratio = similarityRatio(q, normalize(movie.title));
    if (ratio >= FUZZY_THRESHOLD && (!best || ratio > best.ratio)) {
      best = { movie, ratio };
    }
  }
  return best;
}

function bestFuzzyPersonName(q, movies) {
  let best = null;
  for (const movie of movies) {
    const names = [...movie.cast, ...movie.director.split(',').map((d) => d.trim())];
    for (const name of names) {
      const norm = normalize(name);
      for (const candidate of [norm, ...norm.split(' ')]) {
        const ratio = similarityRatio(q, candidate);
        if (ratio >= FUZZY_THRESHOLD && (!best || ratio > best.ratio)) {
          best = { name, ratio };
        }
      }
    }
  }
  return best;
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
  return { type: 'person', label, tagVector, genreSet, excludeIds: new Set(), matched: true };
}

function buildTextSeed(query, taxonomy) {
  const words = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const tagVector = {};
  for (const tag of taxonomy.tags) {
    const haystackWords = normalize(
      `${tag.label} ${tag.description} ${tag.id.replace(/_/g, ' ')} ${(tag.synonyms || []).join(' ')}`
    )
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    let matches = 0;
    for (const word of words) {
      const isMatch = haystackWords.some((hw) => {
        if (hw === word) return true;
        if (hw.length >= 4 && word.length >= 4 && (hw.includes(word) || word.includes(hw))) return true;
        if (hw.length >= FUZZY_MIN_LENGTH && word.length >= FUZZY_MIN_LENGTH) {
          return similarityRatio(word, hw) >= FUZZY_THRESHOLD;
        }
        return false;
      });
      if (isMatch) matches += 1;
    }
    if (matches > 0) {
      tagVector[tag.id] = Math.min(1, matches / Math.max(1, words.length));
    }
  }
  return {
    type: 'text',
    label: query,
    tagVector,
    genreSet: new Set(),
    excludeIds: new Set(),
    matched: Object.keys(tagVector).length > 0,
  };
}

export function resolveSeed(query, movies, taxonomy) {
  const q = normalize(query);
  if (!q) return null;

  const exactMovie = movies.find((m) => normalize(m.title) === q);
  const looseMovie = exactMovie || (q.length >= 3 ? movies.find((m) => normalize(m.title).includes(q)) : null);
  const fuzzyTitleMatch = q.length >= FUZZY_MIN_LENGTH ? bestFuzzyTitleMatch(q, movies) : null;
  const movie = looseMovie || fuzzyTitleMatch?.movie;
  if (movie) {
    return {
      type: 'movie',
      label: movie.title,
      tagVector: movie.tags,
      genreSet: new Set(movie.genres),
      excludeIds: new Set([movie.id]),
      matched: true,
    };
  }

  const exactPersonMovies = movies.filter(
    (m) => m.cast.some((c) => normalize(c) === q) || directorNames(m).some((d) => normalize(d) === q)
  );
  let personMovies = exactPersonMovies;
  let canonicalName = null;
  if (personMovies.length === 0 && q.length >= 3) {
    personMovies = movies.filter(
      (m) => m.cast.some((c) => normalize(c).includes(q)) || directorNames(m).some((d) => normalize(d).includes(q))
    );
  }
  if (personMovies.length === 0 && q.length >= FUZZY_MIN_LENGTH) {
    const fuzzyPerson = bestFuzzyPersonName(q, movies);
    if (fuzzyPerson) {
      canonicalName = fuzzyPerson.name;
      const canonNorm = normalize(fuzzyPerson.name);
      personMovies = movies.filter(
        (m) => m.cast.some((c) => normalize(c) === canonNorm) || directorNames(m).some((d) => normalize(d) === canonNorm)
      );
    }
  }
  if (personMovies.length > 0) {
    const first = personMovies[0];
    const matchedCast = canonicalName || first.cast.find((c) => normalize(c).includes(q));
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

// Explains why `movie` scored the way it did against `query`, for the
// per-card "why was this suggested" popup. `tagLookup` maps tag id -> label.
export function explainMatch(query, movie, tagLookup) {
  const sharedTags = [];
  for (const [tag, queryWeight] of Object.entries(query.tagVector)) {
    const movieWeight = movie.tags[tag] || 0;
    const contribution = queryWeight * movieWeight;
    if (contribution >= 0.03) {
      sharedTags.push({ id: tag, label: tagLookup.get(tag) || tag, contribution });
    }
  }
  sharedTags.sort((a, b) => b.contribution - a.contribution);

  const sharedGenres = movie.genres.filter((g) => query.genreSet.has(g));

  return {
    sharedTags: sharedTags.slice(0, 4),
    sharedGenres,
    isWeak: sharedTags.length === 0 && sharedGenres.length === 0,
  };
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
