// Rebuilds data/word-relations.json — the offline word-relations index the
// Cloudflare Worker's tag-learning gate scores queries against.
//
// Why this exists: the original design called the live Datamuse API from the
// Worker, but Datamuse sits behind Amazon CloudFront, and CloudFront 403s
// every request from Cloudflare Workers' network outright (confirmed via
// `wrangler tail` — identical queries succeed from curl or a local Node
// script, and fail 100% of the time from inside the deployed Worker). No
// header or retry gets around an edge-level block like that, so instead we
// ship our own index built offline from two public-domain/permissively
// licensed sources and fetched by the Worker from GitHub raw at runtime:
//   - Moby Thesaurus (public domain) — the synonym clusters themselves.
//   - The "google-10000-english" frequency list — used only to filter out
//     Moby's more obscure/archaic headwords, keeping the index small.
//
// Run with: node scripts/build-word-relations.mjs
// Takes a few seconds; only needs re-running if you want to widen/narrow
// coverage (see MAX_CLUSTER_TOKENS / MAX_MEMBER_FANOUT / COMMON_WORD_CUTOFF
// below) — the taxonomy itself doesn't need to change for this to matter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'word-relations.json');

const MOBY_URL = 'https://raw.githubusercontent.com/words/moby/master/words.txt';
const FREQ_URL = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt';

const COMMON_WORD_CUTOFF = 32000; // how far down the frequency list counts as "common enough to index"
const MAX_CLUSTER_TOKENS = 14; // headword + up to 13 synonyms kept per line
const MAX_MEMBER_FANOUT = 5; // cap how many clusters a "member" (non-headword) word links into

const isPlainWord = (w) => /^[a-z]+(-[a-z]+)?$/.test(w) && w.length >= 3 && w.length <= 20;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
  return res.text();
}

async function main() {
  console.log('Fetching Moby Thesaurus...');
  const mobyRaw = await fetchText(MOBY_URL);
  console.log('Fetching frequency list...');
  const freqRaw = await fetchText(FREQ_URL);

  const commonWords = new Set(
    freqRaw.split('\n').slice(0, COMMON_WORD_CUTOFF).map((l) => l.split(' ')[0]).filter(Boolean)
  );

  const lines = mobyRaw.split('\n').filter(Boolean);
  const clusters = [];
  const headIdx = new Map(); // word -> [clusterIdx,...]
  const memberIdx = new Map(); // word -> [clusterIdx,...]

  let skippedUncommonHead = 0;
  for (const line of lines) {
    const tokens = line.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length < 2) continue;
    const head = tokens[0];
    if (!isPlainWord(head)) continue;
    if (!commonWords.has(head)) {
      skippedUncommonHead++;
      continue;
    }
    const rest = tokens.slice(1).filter(isPlainWord).slice(0, MAX_CLUSTER_TOKENS - 1);
    if (rest.length === 0) continue;

    const clusterIdx = clusters.length;
    clusters.push([head, ...rest]);

    if (!headIdx.has(head)) headIdx.set(head, []);
    headIdx.get(head).push(clusterIdx);

    for (const w of rest) {
      if (!memberIdx.has(w)) memberIdx.set(w, []);
      const arr = memberIdx.get(w);
      if (arr.length < MAX_MEMBER_FANOUT) arr.push(clusterIdx);
    }
  }

  const allWords = new Set([...headIdx.keys(), ...memberIdx.keys()]);
  const index = {};
  for (const w of allWords) {
    const entry = {};
    if (headIdx.has(w)) entry.h = headIdx.get(w);
    if (memberIdx.has(w)) entry.m = memberIdx.get(w);
    index[w] = entry;
  }

  const payload = { clusters, index };
  const out = JSON.stringify(payload);
  fs.writeFileSync(OUT_PATH, out);

  console.log('skipped (uncommon headword):', skippedUncommonHead);
  console.log('clusters:', clusters.length);
  console.log('words indexed:', allWords.size);
  console.log('output:', OUT_PATH, '=', (out.length / 1024 / 1024).toFixed(2), 'MB');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
