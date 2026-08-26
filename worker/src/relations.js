// Word-relations data source for the tag-learning accept gate.
//
// This used to call the live Datamuse API, but that's a dead end: Datamuse
// sits behind Amazon CloudFront, and CloudFront returns a flat 403 to every
// request that originates from a Cloudflare Worker's network (confirmed via
// `wrangler tail` — identical queries succeed from a plain curl or a local
// Node script, and fail 100% of the time from inside the deployed Worker).
// This isn't a code bug on our end; it's Datamuse's edge blocking Cloudflare's
// egress ranges outright, so no header or retry gets past it.
//
// Instead we ship our own word-relations index, built offline from the
// public-domain Moby Thesaurus (see scripts/build-word-relations.mjs) and
// committed to the repo as data/word-relations.json. The Worker fetches it
// from raw.githubusercontent.com (the same GitHub infrastructure the
// taxonomy commit already talks to successfully) and caches it — first in
// KV, then in this module's memory for the lifetime of the isolate — so a
// given isolate parses the ~3MB file at most once.
const RAW_URL = 'https://raw.githubusercontent.com/RunbotRobot/movie-dna/main/data/word-relations.json';
const KV_KEY = 'word-relations-index-v1';
const KV_TTL = 60 * 60 * 24 * 30; // 30 days — this data only changes when we rebuild it by hand

let memoryCache = null;

export async function loadRelations(env) {
  if (memoryCache) return memoryCache;

  const cached = await env.LEARNED_TAGS.get(KV_KEY, 'json');
  if (cached) {
    memoryCache = cached;
    return memoryCache;
  }

  const res = await fetch(RAW_URL);
  if (!res.ok) throw new Error(`word-relations fetch failed: ${res.status}`);
  const data = await res.json();
  memoryCache = data;
  // Best-effort: don't block the response on writing the cache back.
  env.LEARNED_TAGS.put(KV_KEY, JSON.stringify(data), { expirationTtl: KV_TTL }).catch(() => {});
  return memoryCache;
}

// Every distinct synonym cluster a word belongs to — as headword ("h") or as
// a listed synonym under some other headword ("m"). Each cluster is treated
// as one independent piece of evidence by the accept gate in index.js.
export function clustersForWord(relations, word) {
  const entry = relations.index[word];
  if (!entry) return [];
  const idxs = new Set([...(entry.h || []), ...(entry.m || [])]);
  return [...idxs].map((idx) => ({ idx, tokens: relations.clusters[idx] }));
}
