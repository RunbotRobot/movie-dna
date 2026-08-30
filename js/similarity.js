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

// Match-strength scoring bands for resolveSeed's candidate list (see below):
// each band is a disjoint numeric range so candidates from every category —
// movie, studio, person, theme, fuzzy — sort into one sensible, most- to
// least-precise order regardless of how differently each one is computed.
// EXACT (1) > FULL-VOCABULARY THEME (0.9) > LOOSE substring title/studio/
// person (0.4–0.7) > PARTIAL theme (0.2–0.4) > FUZZY typo match (~0.22–0.3).
const EXACT_SCORE = 1;
const THEME_FULL_SCORE = 0.9;
const LOOSE_SCORE_BASE = 0.4;
const LOOSE_SCORE_SPAN = 0.3;
const THEME_PARTIAL_BASE = 0.2;
const THEME_PARTIAL_SPAN = 0.2;
const FUZZY_SCORE_SCALE = 0.3;
const MAX_CANDIDATES = 8;

// How much of `target` the (already substring-matched) query `q` covers —
// closer to a full-length match scores higher within the loose tier, e.g.
// "horror" hitting the whole title "Horror" outscores it hitting a small
// fragment of "The Texas Chainsaw Massacre".
function looseScore(q, target) {
  return LOOSE_SCORE_BASE + LOOSE_SCORE_SPAN * Math.min(1, q.length / Math.max(1, target.length));
}

function nameScore(q, label) {
  const norm = normalize(label);
  return norm === q ? EXACT_SCORE : looseScore(q, norm);
}

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

// Fraction of the query's words that are themselves a word somewhere in the
// taxonomy's vocabulary (any tag's label/id/synonyms — not necessarily all
// the same tag): 1 when every word is recognized (a deliberate theme
// phrase, one word or several — "horror", "prison break", "artificial
// intelligence"), partway when only some are, 0 when none are. Used by
// resolveSeed to score how confidently a query names a theme.
function textVocabCoverage(query, taxonomy) {
  const words = tokenizeWords(query);
  if (words.length === 0) return 0;
  const vocab = new Set();
  for (const tag of taxonomy.tags) {
    for (const w of tagHaystackWords(tag)) vocab.add(w);
  }
  return words.filter((w) => vocab.has(w)).length / words.length;
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

// Movie titles alone aren't always unique in a 1000+/760+ title catalog
// (the same title can show up twice, e.g. a duplicate listing or an actual
// remake) — the year disambiguates them for display in a candidate list.
function movieLabel(movie) {
  return movie.year ? `${movie.title} (${movie.year})` : movie.title;
}

// A substring match on a name fragment (e.g. "Sutherland") routinely hits
// more than one real person or company — groups the matching movies by
// which exact name string actually matched, so the caller gets one
// candidate per real-world entity instead of one blended average (or one
// silent winner) across all of them. `getNames(movie)` returns the name
// strings on that movie to check — cast + director names for a person
// search, or just the studio for a studio search.
function groupMoviesByMatchedName(movies, q, getNames) {
  const groups = new Map(); // normalized name -> { label, movies: [] }
  for (const movie of movies) {
    for (const name of getNames(movie)) {
      if (!name) continue;
      const norm = normalize(name);
      const isMatch = norm === q || (q.length >= 3 && norm.includes(q));
      if (!isMatch) continue;
      if (!groups.has(norm)) groups.set(norm, { label: name, movies: [] });
      groups.get(norm).movies.push(movie);
    }
  }
  return groups;
}

// Gathers every plausible reading of `query` — movie(s), studio(s),
// person(s), theme — each scored for how strongly it matches (see the
// scoring bands above), rather than picking one via a fixed precision
// order and discarding the rest. When more than one candidate turns up,
// resolveSeed lets the caller show them all, strongest first, instead of
// silently guessing. Fuzzy (typo-tolerant) matching is handled separately
// by the caller: it's the least trustworthy signal here — an approximate
// match can coincidentally hit a totally unrelated short title or name
// (e.g. "epic" one edit from the actor first name "eric") — so it's only
// even attempted once every one of these real candidates comes up empty.
function findCandidates(query, movies, taxonomy) {
  const q = normalize(query);
  const candidates = [];

  // Movies: every movie whose title exactly equals or loosely contains the
  // query is its own candidate. A title isn't guaranteed unique across a
  // 1000+/760+ title catalog (duplicate listings, real remakes), and a
  // short query can genuinely match several different titles ("Alien"
  // matching "Alien", "Aliens", "Alien 3", ...) — surfacing all of them
  // beats silently picking whichever the catalog happens to list first.
  for (const movie of movies) {
    const title = normalize(movie.title);
    if (title === q) {
      candidates.push({ label: movieLabel(movie), type: 'movie', score: EXACT_SCORE, build: () => movieSeed(movie) });
    } else if (q.length >= 3 && title.includes(q)) {
      candidates.push({ label: movieLabel(movie), type: 'movie', score: looseScore(q, title), build: () => movieSeed(movie) });
    }
  }

  // Studios and people: grouped by the exact name string that matched (see
  // groupMoviesByMatchedName) so two different studios/people that both
  // happen to contain the query as a substring are two different
  // candidates, never one blended average of both.
  for (const { label, movies: groupMovies } of groupMoviesByMatchedName(movies, q, (m) => [m.studio]).values()) {
    candidates.push({ label, type: 'studio', score: nameScore(q, label), build: () => buildStudioSeed(label, groupMovies) });
  }
  for (const { label, movies: groupMovies } of groupMoviesByMatchedName(movies, q, (m) => [
    ...m.cast,
    ...directorNames(m),
  ]).values()) {
    candidates.push({ label, type: 'person', score: nameScore(q, label), build: () => buildPersonSeed(label, groupMovies) });
  }

  // Theme: how much of the query is recognized taxonomy vocabulary (a
  // tag's label, id, or synonym). Full recognition of every word ranks as
  // high as an exact name match ("horror", "prison break", "artificial
  // intelligence" are deliberate theme phrases, not title fragments);
  // partial recognition still counts, just at a lower confidence, well
  // below a real title/studio/person hit.
  const coverage = textVocabCoverage(query, taxonomy);
  if (coverage > 0) {
    const score = coverage === 1 ? THEME_FULL_SCORE : THEME_PARTIAL_BASE + THEME_PARTIAL_SPAN * coverage;
    candidates.push({ label: query, type: 'text', score, build: () => buildTextSeed(query, taxonomy) });
  }

  return candidates;
}

export function resolveSeed(query, movies, taxonomy) {
  const q = normalize(query);
  if (!q) return null;

  let candidates = findCandidates(query, movies, taxonomy);

  // Fuzzy (typo-tolerant) matching only kicks in once every precise option
  // above came up completely empty — see findCandidates for why.
  if (candidates.length === 0 && q.length >= FUZZY_MIN_LENGTH) {
    const fuzzyTitleMatch = bestFuzzyTitleMatch(q, movies);
    if (fuzzyTitleMatch) {
      candidates.push({
        label: movieLabel(fuzzyTitleMatch.movie),
        type: 'movie',
        score: fuzzyTitleMatch.ratio * FUZZY_SCORE_SCALE,
        build: () => movieSeed(fuzzyTitleMatch.movie),
      });
    }

    const fuzzyPerson = bestFuzzyPersonName(q, movies);
    if (fuzzyPerson) {
      const canonNorm = normalize(fuzzyPerson.name);
      const fuzzyPersonMovies = movies.filter(
        (m) => m.cast.some((c) => normalize(c) === canonNorm) || directorNames(m).some((d) => normalize(d) === canonNorm)
      );
      if (fuzzyPersonMovies.length > 0) {
        candidates.push({
          label: fuzzyPerson.name,
          type: 'person',
          score: fuzzyPerson.ratio * FUZZY_SCORE_SCALE,
          build: () => buildPersonSeed(fuzzyPerson.name, fuzzyPersonMovies),
        });
      }
    }
  }

  // Nothing matched at all, in any category — an unmatched text seed lets
  // the caller fall back to the Worker's tag-learning lookup.
  if (candidates.length === 0) return buildTextSeed(query, taxonomy);

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > MAX_CANDIDATES) candidates = candidates.slice(0, MAX_CANDIDATES);

  if (candidates.length === 1) return candidates[0].build();

  return { type: 'ambiguous', label: query, candidates };
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
