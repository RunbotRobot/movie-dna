// Batch-runs the exact same tag-learning accept gate the Cloudflare Worker
// uses (see worker/src/index.js's classifyQuery) over every word in
// data/word-relations.json, instead of waiting for it to happen one search
// at a time in production. Two output buckets:
//   - PASS: words that clear the gate today — these are exactly what the
//     Worker would eventually auto-commit anyway as real users type them,
//     just surfaced here up front. Run with --apply to write them straight
//     into data/taxonomy.json (same trust level as the live auto-commit).
//   - NEAR MISS: words with real but insufficient evidence (e.g. only one
//     distinct matching vocabulary word) — the gate is deliberately
//     conservative, so this bucket is where genuinely-good words like
//     "funny"/"hilarious" showed up before being hand-added. Worth a human
//     skim; never auto-applied.
//
// Usage:
//   node scripts/scan-vocabulary.mjs                 # report only
//   node scripts/scan-vocabulary.mjs --apply          # also write PASS words
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, buildTagVocab, scoreTagsAgainstRelatedWords } from '../worker/src/lexical.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAXONOMY_PATH = path.join(REPO_ROOT, 'data', 'taxonomy.json');
const RELATIONS_PATH = path.join(REPO_ROOT, 'data', 'word-relations.json');

// Keep these in sync with worker/src/index.js — duplicated deliberately
// (see lexical.js's header comment for why the Worker/site/scripts don't
// share a build step), not accidentally drifted.
const MIN_DISTINCT_WORDS = 2;
const MIN_ABS_SCORE = 0.3;
const MARGIN_RATIO = 1.4;

function clustersForWord(relations, word) {
  const entry = relations.index[word];
  if (!entry) return [];
  const idxs = new Set([...(entry.h || []), ...(entry.m || [])]);
  return [...idxs].map((idx) => relations.clusters[idx]);
}

function classifyQuery(word, tagVocab, relations) {
  const combinedScores = new Map();
  const wordHits = new Map();
  let anyClusterData = false;

  for (const tokens of clustersForWord(relations, word)) {
    anyClusterData = true;
    const relatedWords = tokens.filter((t) => t !== word).map((t) => ({ word: t }));
    const perClusterScores = scoreTagsAgainstRelatedWords(tagVocab, relatedWords);
    for (const [tagId, { score, words: matchedWords }] of perClusterScores) {
      combinedScores.set(tagId, (combinedScores.get(tagId) || 0) + score);
      if (!wordHits.has(tagId)) wordHits.set(tagId, new Set());
      for (const w of matchedWords) wordHits.get(tagId).add(w);
    }
  }

  if (!anyClusterData || combinedScores.size === 0) return { matched: false };

  const ranked = [...combinedScores.entries()].sort((a, b) => b[1] - a[1]);
  const [winnerId, winnerScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] || 0;
  const winnerDistinctWords = wordHits.get(winnerId).size;

  const passesWordGate = winnerDistinctWords >= MIN_DISTINCT_WORDS;
  const passesAbsoluteFloor = winnerScore >= MIN_ABS_SCORE;
  const passesMargin = runnerUpScore === 0 || winnerScore / runnerUpScore >= MARGIN_RATIO;

  return {
    matched: passesWordGate && passesAbsoluteFloor && passesMargin,
    winnerId,
    winnerScore,
    runnerUpScore,
    winnerDistinctWords,
    matchedWords: [...wordHits.get(winnerId)],
  };
}

function main() {
  const apply = process.argv.includes('--apply');
  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  const relations = JSON.parse(fs.readFileSync(RELATIONS_PATH, 'utf8'));
  const tagVocab = buildTagVocab(taxonomy);

  // Words already covered somewhere (any tag's own synonyms/label/id) don't
  // need scanning — the frontend already resolves them locally.
  const alreadyCovered = new Set();
  for (const tag of taxonomy.tags) {
    alreadyCovered.add(normalize(tag.label));
    for (const syn of tag.synonyms || []) alreadyCovered.add(normalize(syn));
  }

  const passes = new Map(); // tagId -> [word,...]
  const nearMisses = []; // { word, winnerId, winnerScore, runnerUpScore, winnerDistinctWords, matchedWords }

  const candidates = Object.keys(relations.index).filter((w) => !alreadyCovered.has(w));
  for (const word of candidates) {
    const result = classifyQuery(word, tagVocab, relations);
    if (!result || result.winnerId === undefined) continue;
    if (result.matched) {
      if (!passes.has(result.winnerId)) passes.set(result.winnerId, []);
      passes.get(result.winnerId).push(word);
    } else if (result.winnerDistinctWords >= 1 && result.winnerScore >= MIN_ABS_SCORE) {
      nearMisses.push({ word, ...result });
    }
  }

  console.log(`Scanned ${candidates.length} candidate words (${alreadyCovered.size} already covered, skipped).\n`);

  console.log(`=== PASS (gate-clearing — same trust level as live auto-commit) ===`);
  for (const [tagId, words] of [...passes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${tagId}: ${words.sort().join(', ')}`);
  }

  console.log(`\n=== NEAR MISS (real but insufficient evidence — human judgment call) ===`);
  nearMisses.sort((a, b) => b.winnerScore - a.winnerScore);
  for (const nm of nearMisses.slice(0, 100)) {
    console.log(
      `${nm.word} -> ${nm.winnerId} (score=${nm.winnerScore.toFixed(2)}, runnerUp=${nm.runnerUpScore.toFixed(2)}, distinctWords=${nm.winnerDistinctWords}, via=${nm.matchedWords.join('/')})`
    );
  }
  if (nearMisses.length > 100) console.log(`... and ${nearMisses.length - 100} more (raise the slice to see them)`);

  if (apply) {
    let added = 0;
    for (const [tagId, words] of passes) {
      const tag = taxonomy.tags.find((t) => t.id === tagId);
      if (!tag) continue;
      const existing = new Set((tag.synonyms || []).map(normalize));
      for (const word of words) {
        if (existing.has(word)) continue;
        tag.synonyms = [...(tag.synonyms || []), word];
        existing.add(word);
        added++;
      }
    }
    fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2) + '\n');
    console.log(`\nApplied ${added} new synonyms to ${TAXONOMY_PATH}.`);
  } else {
    console.log(`\n(dry run — pass --apply to write the PASS words into taxonomy.json)`);
  }
}

main();
