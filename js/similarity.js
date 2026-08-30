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
// Individual name tokens (first name alone, last name alone) get a higher
// length floor than full titles/names: short common words routinely sit one
// edit away from a short first name by pure coincidence (e.g. "epic" vs
// "eric" — one substitution, ratio 0.75, well past FUZZY_THRESHOLD), which
// hijacked free-text theme searches into a random actor match. Full names
// ("eric bana") are long enough that this collision risk is much smaller.
const FUZZY_PERSON_TOKEN_MIN_LENGTH = 5;

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
      const candidates = [norm, ...norm.split(' ').filter((token) => token.length >= FUZZY_PERSON_TOKEN_MIN_LENGTH)];
      for (const candidate of candidates) {
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

// Corpus-level inverse-document-frequency per tag: without this, cosine
// similarity treats every shared tag as equally significant regardless of
// how common it is across the catalog. A tag two movies share that almost
// every movie also has (e.g. a broadly-applicable tone) is much weaker
// evidence of similarity than a tag they share that's rare across the whole
// catalog — a niche structural or thematic device few other movies use at
// all. This makes rare, specific tags count more than common, general ones
// when scoring, instead of leaving that entirely to chance (a rare tag
// otherwise contributes no differently than a common one — nothing before
// this made specificity actually count for more).
export function computeTagIdf(movies, taxonomy) {
  const total = movies.length;
  const idf = {};
  for (const tag of taxonomy.tags) {
    const df = movies.reduce((count, m) => count + (m.tags[tag.id] > 0 ? 1 : 0), 0);
    idf[tag.id] = df > 0 ? Math.log(total / df) : 0;
  }
  return idf;
}

function weightVector(vector, tagIdf) {
  if (!tagIdf) return vector;
  const weighted = {};
  for (const [tag, weight] of Object.entries(vector)) {
    weighted[tag] = weight * (tagIdf[tag] ?? 1);
  }
  return weighted;
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

// Shared by person and studio seeds: a centroid tag vector averaged across
// a group of movies, same idea as an actor/director's filmography average.
function buildCentroidSeed(type, label, groupMovies) {
  const tagVector = {};
  for (const movie of groupMovies) {
    for (const [tag, weight] of Object.entries(movie.tags)) {
      tagVector[tag] = (tagVector[tag] || 0) + weight;
    }
  }
  for (const tag in tagVector) {
    tagVector[tag] /= groupMovies.length;
  }
  const genreSet = new Set();
  for (const movie of groupMovies) {
    for (const genre of movie.genres) genreSet.add(genre);
  }
  return { type, label, tagVector, genreSet, excludeIds: new Set(), matched: true };
}

function buildPersonSeed(label, personMovies) {
  return buildCentroidSeed('person', label, personMovies);
}

function buildStudioSeed(label, studioMovies) {
  return buildCentroidSeed('studio', label, studioMovies);
}

function tokenizeWords(str) {
  return normalize(str)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

function tagHaystackWords(tag) {
  return new Set(tokenizeWords(`${tag.label} ${tag.id.replace(/_/g, ' ')} ${(tag.synonyms || []).join(' ')}`));
}

// Every word the query tokenizes into is itself a word somewhere in the
// taxonomy's vocabulary (any tag's label/id/synonyms — not necessarily all
// the same tag). Used to recognize a deliberate multi-word theme phrase
// (e.g. "prison break", "artificial intelligence") as confidently as a
// single matching word, regardless of how many words it's made of — see
// resolveSeed below for why that distinction matters.
function queryFullyInVocabulary(query, taxonomy) {
  const words = tokenizeWords(query);
  if (words.length === 0) return false;
  const vocab = new Set();
  for (const tag of taxonomy.tags) {
    for (const w of tagHaystackWords(tag)) vocab.add(w);
  }
  return words.every((w) => vocab.has(w));
}

// Deliberately exact-word matching only, not substring containment and not
// edit-distance fuzzy matching — both cause real false positives here.
// Substring containment let "mysterious" match into an unrelated tag via a
// coincidental fragment; fuzzy matching is worse, since two completely
// unrelated short words routinely sit one edit apart by pure chance (e.g.
// "food" vs "good" — one substitution, ratio 0.75 — silently matched every
// "___ food" search to Whimsical charm via its "feel-good" synonym). Also
// deliberately excludes tag.description from the vocabulary, same reason
// the Worker's matching does: generic prose words there ("tone", "story")
// would otherwise match almost anything.
function buildTextSeed(query, taxonomy) {
  const words = tokenizeWords(query);
  const tagVector = {};
  for (const tag of taxonomy.tags) {
    const haystackWords = tagHaystackWords(tag);
    let matches = 0;
    for (const word of words) {
      if (haystackWords.has(word)) matches += 1;
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

function movieSeed(movie) {
  return {
    type: 'movie',
    label: movie.title,
    tagVector: movie.tags,
    genreSet: new Set(movie.genres),
    excludeIds: new Set([movie.id]),
    matched: true,
  };
}

// A substring match on a name fragment (e.g. "Sutherland") routinely hits
// more than one real person — groups the candidate movies by which exact
// cast/director name actually matched, so the caller can ask which one was
// meant instead of silently picking whichever happened to be first.
function groupMoviesByMatchedPerson(personMovies, q) {
  const groups = new Map(); // normalized name -> { label, movies: [] }
  for (const movie of personMovies) {
    const names = [...movie.cast, ...directorNames(movie)];
    for (const name of names) {
      if (!normalize(name).includes(q)) continue;
      const key = normalize(name);
      if (!groups.has(key)) groups.set(key, { label: name, movies: [] });
      groups.get(key).movies.push(movie);
    }
  }
  return groups;
}

// Resolution goes from most to least precise, and only reaches for an
// approximate (fuzzy) guess once every exact/substring option — including a
// real free-text tag match — has come up empty. Fuzzy matching is the
// least precise signal here: an approximate match can coincidentally hit a
// totally unrelated short title or name (e.g. "epic" one edit away from the
// actor first name "eric"), so a real match of any other kind always wins.
export function resolveSeed(query, movies, taxonomy) {
  const q = normalize(query);
  if (!q) return null;

  const exactMovie = movies.find((m) => normalize(m.title) === q);
  if (exactMovie) return movieSeed(exactMovie);

  // A query where every word is itself a word in the taxonomy's own
  // vocabulary (a tag's label, id, or synonym) — whether that's one word
  // ("horror", a synonym of Tense dread) or several ("prison break",
  // "artificial intelligence") — names a theme on purpose. Checking that
  // here, before the loose (substring) title/studio/person matches below,
  // stops a coincidental hit — some unrelated movie whose title just
  // happens to contain those words, e.g. "Horror Hotel: The Phone" or
  // "Groundhog Day" itself — from silently hijacking the search into one
  // random movie instead of the theme it actually means. A query with any
  // word outside that vocabulary (e.g. "The Dark Knight" — "knight" isn't
  // a taxonomy word) is left alone so real movie-title searches still work.
  const earlyTextSeed = queryFullyInVocabulary(query, taxonomy) ? buildTextSeed(query, taxonomy) : null;
  if (earlyTextSeed && earlyTextSeed.matched) return earlyTextSeed;

  const looseMovie = q.length >= 3 ? movies.find((m) => normalize(m.title).includes(q)) : null;
  if (looseMovie) return movieSeed(looseMovie);

  const exactStudioMovies = movies.filter((m) => m.studio && normalize(m.studio) === q);
  const looseStudioMovies =
    exactStudioMovies.length > 0
      ? exactStudioMovies
      : q.length >= 3
        ? movies.filter((m) => m.studio && normalize(m.studio).includes(q))
        : [];
  if (looseStudioMovies.length > 0) {
    const label = looseStudioMovies[0].studio;
    return buildStudioSeed(label, looseStudioMovies);
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
    const groups = groupMoviesByMatchedPerson(personMovies, q);
    if (groups.size > 1) {
      return {
        type: 'ambiguous',
        label: query,
        candidates: [...groups.values()].map(({ label, movies: gm }) => ({
          label,
          type: 'person',
          build: () => buildPersonSeed(label, gm),
        })),
      };
    }
    const [{ label, movies: gm }] = groups.values();
    return buildPersonSeed(label, gm);
  }

  const textSeed = earlyTextSeed || buildTextSeed(query, taxonomy);
  if (textSeed.matched) return textSeed;

  const fuzzyTitleMatch = q.length >= FUZZY_MIN_LENGTH ? bestFuzzyTitleMatch(q, movies) : null;
  if (fuzzyTitleMatch) return movieSeed(fuzzyTitleMatch.movie);

  if (q.length >= FUZZY_MIN_LENGTH) {
    const fuzzyPerson = bestFuzzyPersonName(q, movies);
    if (fuzzyPerson) {
      const canonNorm = normalize(fuzzyPerson.name);
      const fuzzyPersonMovies = movies.filter(
        (m) => m.cast.some((c) => normalize(c) === canonNorm) || directorNames(m).some((d) => normalize(d) === canonNorm)
      );
      if (fuzzyPersonMovies.length > 0) return buildPersonSeed(fuzzyPerson.name, fuzzyPersonMovies);
    }
  }

  return textSeed;
}

// Builds a seed from a mapping the Worker's tag-learning fallback found
// (see js/learn.js) — same shape as a regular text seed, just pre-resolved
// to one tag instead of being derived from taxonomy word-matching.
export function buildLearnedSeed(query, tagId, tagLabel) {
  return {
    type: 'text',
    label: query,
    tagVector: { [tagId]: 1 },
    genreSet: new Set(),
    excludeIds: new Set(),
    matched: true,
    learnedTagLabel: tagLabel,
  };
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
// `tagIdf`, when given, ranks shared tags the same way scoreMovies scores
// them — a rare shared tag surfaces ahead of a common one — instead of the
// explanation silently using different weighting than the ranking it's
// explaining.
export function explainMatch(query, movie, tagLookup, tagIdf) {
  const sharedTags = [];
  for (const [tag, queryWeight] of Object.entries(query.tagVector)) {
    const movieWeight = movie.tags[tag] || 0;
    const contribution = queryWeight * movieWeight;
    if (contribution >= 0.03) {
      // Qualifying threshold stays on the plain (unweighted) contribution —
      // it's tuned as an "is this a real, non-trivial shared trait" check.
      // Rank order among qualifying tags uses the idf-weighted contribution,
      // so rarer/more distinctive shared traits surface first.
      const rank = contribution * (tagIdf?.[tag] ?? 1) ** 2;
      sharedTags.push({ id: tag, label: tagLookup.get(tag) || tag, contribution: rank });
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

export function scoreMovies(query, movies, tagIdf) {
  if (!query) return [];
  const weightedQuery = weightVector(query.tagVector, tagIdf);
  return movies
    .filter((m) => !query.excludeIds.has(m.id))
    .map((movie) => {
      const tagSim = cosineSim(weightedQuery, weightVector(movie.tags, tagIdf));
      const genreSim = query.genreSet.size ? jaccard(query.genreSet, new Set(movie.genres)) : 0;
      const score = query.genreSet.size ? 0.8 * tagSim + 0.2 * genreSim : tagSim;
      return { movie, score };
    })
    .sort((a, b) => b.score - a.score);
}
