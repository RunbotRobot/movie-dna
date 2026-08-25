# movie-dna tag learner

A Cloudflare Worker that backs the "learn a new synonym mapping" fallback:
when a search on the site matches nothing locally, the frontend calls this
Worker instead of just failing. It uses [Datamuse](https://www.datamuse.com/api/)
(free, keyless, non-LLM word-relations API) to check whether the term is
related to an existing taxonomy tag, and if a multi-signal accept gate is
satisfied (see `src/index.js`), commits the new synonym straight into
`data/taxonomy.json` on `main` — so every future user, not just the one who
typed it, benefits from that search immediately.

No LLM, no API key, no billing. The only cost is Cloudflare's (generous)
free tier and a GitHub token with write access to this one repo.

## Why this needs deploying manually

This Worker was built and tested (see below) from an automated coding
session that doesn't hold your Cloudflare or GitHub write credentials — so
the deploy step and the GitHub token need to come from you. Everything else
(the KV namespace, the code, the config) is already done.

## One-time setup

1. **Create a GitHub token** the Worker can use to commit `taxonomy.json`:
   GitHub → Settings → Developer settings → Fine-grained personal access
   tokens → Generate new token, scoped to **only** the `movie-dna`
   repository, with **Contents: Read and write** permission and nothing else.

2. **Log in to Cloudflare** (opens a browser once):
   ```
   cd worker
   npx wrangler login
   ```

3. **Set the GitHub token as a Worker secret** (never goes in a file, never
   gets committed):
   ```
   npx wrangler secret put GITHUB_TOKEN
   ```
   Paste the token from step 1 when prompted.

4. **Deploy**:
   ```
   npx wrangler deploy
   ```
   This prints the Worker's URL, e.g.
   `https://movie-dna-tag-learner.<your-subdomain>.workers.dev`.

5. **Wire the URL into the frontend**: update `WORKER_URL` in
   `js/learn.js` to that URL (with `/learn` appended) and push. Until this
   is set, the site works exactly as it does today — the fallback silently
   no-ops.

The KV namespace (`movie-dna-learned-tags`) and `wrangler.jsonc` are already
configured with its real ID — no setup needed there.

## What's already been tested

The classification/accept-gate logic (`src/lexical.js`, `src/datamuse.js`,
and the gate in `src/index.js`) was tested locally against ~30 real queries,
including the three cases that originally motivated this feature ("funny",
"scary", and gibberish like "fdsa"). An earlier version of the matching
logic had a real bug — it used edit-distance fuzzy matching to compare
*different* English words for relatedness, which is the wrong tool for that
job (it once mapped "terrifying" to **"Whimsical charm"** because
"alarming" and "charming" happen to be spelled similarly). That's fixed:
relatedness now comes only from Datamuse, and tag-vocabulary matching is
exact-or-stem-substring, not fuzzy. Re-tested clean with no false positives
across the same query set afterward.

What has **not** been tested end-to-end yet: the actual GitHub commit step,
since this sandbox's network proxy blocks direct calls to `api.github.com`
(Datamuse and `raw.githubusercontent.com` both work fine — only the GitHub
API itself is gated here). The commit code is a standard, small use of the
GitHub Contents API (read file + sha, then PUT with the updated content),
but it's worth doing one supervised test after deploying — search a term
you're confident should map somewhere (e.g. "hilarious") and check that a
commit actually lands on `main` with the expected synonym — before trusting
it fully hands-off.

## Tunable safety knobs (in `src/index.js`)

- `MIN_RELATION_TYPES` (2) — how many of Datamuse's 3 relation types must
  independently agree before a mapping is accepted.
- `MIN_ABS_SCORE` (1.1) / `MARGIN_RATIO` (1.4) — absolute and relative
  confidence floors for the winning tag.
- `RATE_LIMIT_PER_HOUR` (30, per IP) and `DAILY_COMMIT_CAP` (50, global) —
  abuse/cost protection. A capped-out day still resolves the mapping for
  that user's current session; it just isn't persisted until the cap resets.
