// Pure lexical helpers, deliberately duplicated from js/similarity.js on the
// frontend rather than shared — the Worker and the static site are separate
// deploy targets, and these functions are small enough that duplication beats
// a cross-project build step.
//
// Deliberately NOT using edit-distance/fuzzy string matching here, unlike the
// frontend's typo correction: that measures spelling similarity, which is
// the right tool for "is this a misspelling of a known name" but the wrong
// one for "are these two different words related in meaning" — two
// unrelated words can coincidentally share a suffix (e.g. "alarming" and
// "charming" are 0.75 similar by edit distance, but have nothing to do with
// each other). Word relatedness here comes entirely from Datamuse; this
// file only checks whether a word Datamuse already told us is related to
// the query also literally appears (or stems into) a tag's own vocabulary.

export function normalize(str) {
  return str.trim().toLowerCase();
}

function wordsMatch(a, b) {
  if (a === b) return true;
  // Stem-style containment (e.g. "dread" vs "dreadful") — still a literal
  // substring relationship, not a similarity score, so no coincidental
  // cross-word collisions like the alarming/charming case above.
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

// One vocab word-set per taxonomy tag, built ONLY from curated fields (id,
// label, synonyms) — deliberately excluding the free-text `description`,
// which contains generic connective words ("tone", "story", "character")
// that would otherwise match almost anything.
export function buildTagVocab(taxonomy) {
  return taxonomy.tags.map((tag) => ({
    id: tag.id,
    label: tag.label,
    words: normalize(`${tag.label} ${tag.id.replace(/_/g, ' ')} ${(tag.synonyms || []).join(' ')}`)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  }));
}

// Scores every tag against a list of Datamuse-returned related words for one
// relation type (rel_syn / ml / rel_trg), rank-weighted so the strongest
// associations count more than distant ones. Returns a Map<tagId, score>.
export function scoreTagsAgainstRelatedWords(tagVocab, relatedWords) {
  const scores = new Map();
  relatedWords.forEach((entry, rank) => {
    const w = normalize(entry.word);
    if (w.length < 4) return;
    const weight = 1 / (rank + 1);
    for (const tag of tagVocab) {
      if (tag.words.some((vocabWord) => wordsMatch(w, vocabWord))) {
        scores.set(tag.id, (scores.get(tag.id) || 0) + weight);
      }
    }
  });
  return scores;
}
