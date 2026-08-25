// Datamuse (https://www.datamuse.com/api/) is a free, keyless, public word-
// relations API — no LLM, no per-token cost, generous rate limits. We query
// three distinct relation types so an accepted mapping requires more than
// one kind of evidence to agree (see index.js's ACCEPT gate).
const RELATIONS = {
  syn: 'rel_syn', // strict WordNet synonyms
  means: 'ml', // broader "means like" (spelling + meaning)
  trigger: 'rel_trg', // statistically co-occurring words in real text
};

export async function fetchRelated(word, relationKey) {
  const param = RELATIONS[relationKey];
  const url = `https://api.datamuse.com/words?${param}=${encodeURIComponent(word)}&max=25`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'movie-dna-tag-learner (POC)' } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export const RELATION_KEYS = Object.keys(RELATIONS);
