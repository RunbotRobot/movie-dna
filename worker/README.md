# movie-dna tag learner

A Cloudflare Worker that backs the "learn a new synonym mapping" fallback:
when a search on the site matches nothing locally, the frontend calls this
Worker instead of just failing. It checks whether the term is related to an
existing taxonomy tag using a bundled, offline word-relations index (see
below), and if a multi-signal accept gate is satisfied (see `src/index.js`),
commits the new synonym straight into `data/taxonomy.json` on `main` — so
every future user, not just the one who typed it, benefits from that search
immediately.

No LLM, no API key, no billing. The only cost is Cloudflare's (generous)
free tier and a GitHub token with write access to this one repo.

**Status: deployed and live** at
`https://movie-dna-tag-learner.runbotrobot.workers.dev`, wired into
`js/learn.js`.

## Why Datamuse isn't used

The original design called the live [Datamuse](https://www.datamuse.com/api/)
API for word relations. That doesn't work: Datamuse sits behind Amazon
CloudFront, and CloudFront returns a flat 403 to every request that
originates from a Cloudflare Worker's network, regardless of headers —
confirmed live via `wrangler tail` (identical queries succeed from curl or a
local Node script, and fail 100% of the time from inside the deployed
Worker). This isn't fixable from our side; it's Datamuse's edge blocking
Cloudflare's egress ranges outright.

Instead, `src/relations.js` fetches a self-hosted word-relations index —
`data/word-relations.json`, built offline from the public-domain Moby
Thesaurus by `scripts/build-word-relations.mjs` — from GitHub raw (the same
infrastructure the taxonomy commit already talks to successfully) and
caches it in KV plus in-memory per isolate. Rebuild it with:
```
node scripts/build-word-relations.mjs
```
then commit the regenerated `data/word-relations.json`.

## One-time setup (already done)

1. GitHub fine-grained PAT, scoped to this repo only, Contents: Read and
   write, stored as the `GITHUB_TOKEN` Worker secret (`wrangler secret put`).
2. `npx wrangler deploy` from `worker/`.
3. `WORKER_URL` in `js/learn.js` points at the deployed Worker.

The KV namespace and `wrangler.jsonc` are already configured with their
real IDs.

## What's been tested

Both the classification logic and the GitHub commit step have been
exercised end-to-end against the live deployment (not just locally) —
confirmed real commits landing on `main` for genuine matches (e.g. "eerie",
"macabre", "gruesome" → `tense_dread`) and confirmed rejections for
words that don't belong (e.g. "evil", "fast").

Two real bugs were found and fixed along the way, both worth knowing about
if you touch the matching logic:

1. **Edit-distance fuzzy matching is the wrong tool for word relatedness**
   (still true from the original Datamuse design) — it once mapped
   "terrifying" to "Whimsical charm" because "alarming" and "charming"
   happen to be spelled similarly. Fixed: tag-vocabulary matching is exact
   only, not fuzzy, not stem-substring.
2. **Cluster count overstates confidence against an unsensed thesaurus.**
   Moby doesn't disambiguate word senses, so a query word's synonym rings
   often contain several near-duplicate clusters that all restate the exact
   same one overlapping word — e.g. "evil" only ever touched
   `investigation_driven`'s vocab via the single word "crime", repeated
   across three separate "wrongdoing" clusters. That looked like
   triple-confirmed evidence under a cluster-count gate but was really one
   coincidental collision. Fixed: the gate now requires >=2 *distinct*
   matching vocabulary words, not >=2 contributing clusters. Verified
   clean across ~250 test queries with zero remaining false positives.

## Tunable safety knobs (in `src/index.js`)

- `MIN_DISTINCT_WORDS` (2) — how many of the tag's own vocabulary words
  must be independently hit (not just how many synonym clusters happened
  to contribute) before a mapping is accepted.
- `MIN_ABS_SCORE` (0.3) / `MARGIN_RATIO` (1.4) — absolute and relative
  confidence floors for the winning tag.
- `RATE_LIMIT_PER_HOUR` (30, per IP) and `DAILY_COMMIT_CAP` (50, global) —
  abuse/cost protection. A capped-out day still resolves the mapping for
  that user's current session; it just isn't persisted until the cap resets.

If you want to widen or narrow vocabulary coverage, the levers are in
`scripts/build-word-relations.mjs`: `COMMON_WORD_CUTOFF` (how far down the
frequency list still counts as "common enough to index"), and
`MAX_CLUSTER_TOKENS` / `MAX_MEMBER_FANOUT` (how much of each Moby entry gets
kept).
