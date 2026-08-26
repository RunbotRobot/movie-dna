import { normalize, buildTagVocab, scoreTagsAgainstRelatedWords } from './lexical.js';
import { loadRelations, clustersForWord } from './relations.js';
import { getTaxonomyFile, commitTaxonomy } from './github.js';

// --- Auto-apply accept gate -------------------------------------------------
// No human reviews these before they go live, so acceptance requires several
// independent signals to agree rather than trusting a single lookup:
//   1. At least two DISTINCT tag-vocabulary words (not just cluster count —
//      Moby Thesaurus is unsensed, so several of its synonym clusters often
//      restate the exact same one matching word: e.g. "evil" only ever
//      overlapped investigation_driven's vocab via the single word "crime",
//      repeated across three separate but redundant "wrongdoing" clusters,
//      which looked like triple-confirmed evidence but was really one
//      coincidental collision. Requiring distinct *words*, not clusters,
//      caught and rejected that case — and every other false positive found
//      during testing — while still passing genuine matches like "eerie"
//      (creepy + spooky) and "macabre" (spooky + creepy + terrifying).
//   2. The winning tag's score must clear an absolute floor, not just be
//      "the best of a weak field."
//   3. The winning tag must beat the runner-up by a healthy margin, so
//      genuinely ambiguous words don't get force-fit onto one tag.
// A word our word-relations index has never heard of (gibberish, typos,
// genuinely absent from the source thesaurus) simply returns no clusters and
// is rejected for free, before any tag-scoring happens at all.
const MIN_DISTINCT_WORDS = 2;
const MIN_ABS_SCORE = 0.3;
const MARGIN_RATIO = 1.4;

const RATE_LIMIT_PER_HOUR = 30; // per IP
const DAILY_COMMIT_CAP = 50; // global, across all users

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin');
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function checkRateLimit(env, ip) {
  const bucket = Math.floor(Date.now() / 3600000); // current hour
  const key = `ratelimit:${ip}:${bucket}`;
  const current = Number((await env.LEARNED_TAGS.get(key)) || '0');
  if (current >= RATE_LIMIT_PER_HOUR) return false;
  await env.LEARNED_TAGS.put(key, String(current + 1), { expirationTtl: 3700 });
  return true;
}

async function checkDailyCommitCap(env) {
  const bucket = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `commits:${bucket}`;
  const current = Number((await env.LEARNED_TAGS.get(key)) || '0');
  if (current >= DAILY_COMMIT_CAP) return false;
  await env.LEARNED_TAGS.put(key, String(current + 1), { expirationTtl: 90000 });
  return true;
}

// Decide which tag (if any) `query` should map to, using rank-weighted
// evidence pooled across every significant word in the query and every
// synonym cluster (see relations.js) any of those words belongs to.
async function classifyQuery(query, taxonomy, env) {
  const tagVocab = buildTagVocab(taxonomy);
  const words = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return { matched: false };

  let relations;
  try {
    relations = await loadRelations(env);
  } catch {
    return { matched: false, reason: 'relations_unavailable' };
  }

  const combinedScores = new Map(); // tagId -> total score
  const wordHits = new Map(); // tagId -> Set of the tag's own vocab words that matched
  let anyClusterData = false;

  for (const word of words) {
    const clusters = clustersForWord(relations, word);
    for (const { tokens } of clusters) {
      anyClusterData = true;
      const relatedWords = tokens.filter((t) => t !== word).map((t) => ({ word: t }));
      const perClusterScores = scoreTagsAgainstRelatedWords(tagVocab, relatedWords);
      for (const [tagId, { score, words: matchedWords }] of perClusterScores) {
        combinedScores.set(tagId, (combinedScores.get(tagId) || 0) + score);
        if (!wordHits.has(tagId)) wordHits.set(tagId, new Set());
        for (const w of matchedWords) wordHits.get(tagId).add(w);
      }
    }
  }

  if (!anyClusterData) {
    return { matched: false, reason: 'unrecognized_word' };
  }
  if (combinedScores.size === 0) {
    return { matched: false, reason: 'no_tag_overlap' };
  }

  const ranked = [...combinedScores.entries()].sort((a, b) => b[1] - a[1]);
  const [winnerId, winnerScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] || 0;
  const winnerDistinctWords = wordHits.get(winnerId).size;

  const passesWordGate = winnerDistinctWords >= MIN_DISTINCT_WORDS;
  const passesAbsoluteFloor = winnerScore >= MIN_ABS_SCORE;
  const passesMargin = runnerUpScore === 0 || winnerScore / runnerUpScore >= MARGIN_RATIO;

  if (!passesWordGate || !passesAbsoluteFloor || !passesMargin) {
    return {
      matched: false,
      reason: 'gate_failed',
      evidence: { winnerId, winnerScore, runnerUpScore, winnerDistinctWords },
    };
  }

  const winnerTag = taxonomy.tags.find((t) => t.id === winnerId);
  return {
    matched: true,
    tagId: winnerId,
    tagLabel: winnerTag.label,
    evidence: { winnerScore, runnerUpScore, matchedWords: [...wordHits.get(winnerId)] },
  };
}

async function handleLearn(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ matched: false, error: 'bad_request' }, 400, corsHeaders(request, env));
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query || query.length > 60) {
    return json({ matched: false, error: 'bad_request' }, 400, corsHeaders(request, env));
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const withinLimit = await checkRateLimit(env, ip);
  if (!withinLimit) {
    return json({ matched: false, error: 'rate_limited' }, 429, corsHeaders(request, env));
  }

  const cacheKey = `learned:${normalize(query)}`;
  const cached = await env.LEARNED_TAGS.get(cacheKey, 'json');
  if (cached) {
    return json(cached, 200, corsHeaders(request, env));
  }

  let taxonomy;
  let sha;
  try {
    ({ taxonomy, sha } = await getTaxonomyFile(env));
  } catch (err) {
    return json({ matched: false, error: 'taxonomy_unavailable' }, 502, corsHeaders(request, env));
  }

  const result = await classifyQuery(query, taxonomy, env);

  if (!result.matched) {
    await env.LEARNED_TAGS.put(cacheKey, JSON.stringify({ matched: false }), { expirationTtl: 60 * 60 * 24 * 7 });
    return json({ matched: false }, 200, corsHeaders(request, env));
  }

  // Passed the accept gate — try to persist for everyone. If the daily
  // commit cap is hit, the requesting user still benefits this session
  // (the client applies the mapping in memory); it just isn't written back
  // until the cap resets, protecting the repo from a runaway commit storm.
  const canCommit = await checkDailyCommitCap(env);
  if (canCommit) {
    const tag = taxonomy.tags.find((t) => t.id === result.tagId);
    const synNormalized = normalize(query);
    const alreadyPresent = (tag.synonyms || []).some((s) => normalize(s) === synNormalized);
    if (!alreadyPresent) {
      tag.synonyms = [...(tag.synonyms || []), query];
      try {
        await commitTaxonomy(env, taxonomy, sha, `Auto-learn synonym: "${query}" -> ${result.tagId}`);
      } catch {
        // Commit failed (e.g. concurrent write elsewhere) — the client still
        // gets the mapping for this session; it'll be re-attempted next time
        // someone searches the same term, since we only cache accepted
        // results after a successful commit (see below).
        return json(
          { matched: true, tagId: result.tagId, tagLabel: result.tagLabel },
          200,
          corsHeaders(request, env)
        );
      }
    }
  }

  const response = { matched: true, tagId: result.tagId, tagLabel: result.tagLabel };
  await env.LEARNED_TAGS.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 * 60 * 24 * 7 });
  return json(response, 200, corsHeaders(request, env));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/learn') {
      return handleLearn(request, env);
    }
    return json({ error: 'not_found' }, 404, corsHeaders(request, env));
  },
};
