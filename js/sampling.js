import { getTimesSeen } from './history.js';

function softmaxWeights(scores, temperature) {
  const t = Math.max(0.01, temperature);
  const maxScore = Math.max(...scores, 0);
  const exps = scores.map((s) => Math.exp((s - maxScore) / t));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

function weightedSampleWithoutReplacement(items, weights, n) {
  const pool = items.map((item, i) => ({ item, weight: weights[i] || 0 }));
  const picked = [];
  for (let k = 0; k < n && pool.length > 0; k++) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let idx;
    if (totalWeight <= 0) {
      idx = Math.floor(Math.random() * pool.length);
    } else {
      let r = Math.random() * totalWeight;
      idx = 0;
      for (; idx < pool.length; idx++) {
        r -= pool[idx].weight;
        if (r <= 0) break;
      }
      idx = Math.min(idx, pool.length - 1);
    }
    picked.push(pool[idx].item);
    pool.splice(idx, 1);
  }
  return picked;
}

// Turns ranked similarity scores into a result set that's relevant but not
// identical run-to-run: seen movies are decayed (never zeroed), a slice of
// slots is reserved for movies with zero impressions, and the rest are
// weighted-sampled with a temperature knob (low = close to top-N, high = wide).
export function sampleResults(scored, { count = 10, temperature = 0.5, noveltyQuota = 2 } = {}) {
  const candidatePoolSize = Math.min(scored.length, 60);
  const pool = scored.slice(0, candidatePoolSize).map(({ movie, score }) => {
    const seen = getTimesSeen(movie.id);
    const decayed = score * Math.pow(0.6, seen);
    return { movie, score: decayed, seen };
  });

  const results = [];
  const usedIds = new Set();

  const noveltyCandidates = pool.filter((p) => p.seen === 0);
  const noveltySlots = Math.min(noveltyQuota, count - 1, noveltyCandidates.length);
  if (noveltySlots > 0) {
    const weights = softmaxWeights(
      noveltyCandidates.map((p) => p.score),
      temperature
    );
    for (const p of weightedSampleWithoutReplacement(noveltyCandidates, weights, noveltySlots)) {
      results.push({ movie: p.movie, reason: 'novelty' });
      usedIds.add(p.movie.id);
    }
  }

  const remainingPool = pool.filter((p) => !usedIds.has(p.movie.id));
  const remainingCount = count - results.length;
  if (remainingCount > 0 && remainingPool.length > 0) {
    const weights = softmaxWeights(
      remainingPool.map((p) => p.score),
      temperature
    );
    for (const p of weightedSampleWithoutReplacement(remainingPool, weights, remainingCount)) {
      results.push({ movie: p.movie, reason: 'match' });
      usedIds.add(p.movie.id);
    }
  }

  return results;
}
