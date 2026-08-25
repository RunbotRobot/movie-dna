import { loadData } from './data.js';
import { resolveSeed, combineSeeds, scoreMovies, explainMatch, buildLearnedSeed } from './similarity.js';
import { sampleResults } from './sampling.js';
import { observeFullyVisible } from './history.js';
import { tryLearnTag } from './learn.js';

let taxonomy = null;
let movies = null;
let tagLookup = new Map();
let seeds = [];
let activeObservers = [];
let hasResults = false;

const seedInput = document.getElementById('seed-input');
const addSeedBtn = document.getElementById('add-seed-btn');
const seedErrorEl = document.getElementById('seed-error');
const seedChipsEl = document.getElementById('seed-chips');
const tempSlider = document.getElementById('temperature-slider');
const searchBtn = document.getElementById('search-btn');
const resultsGrid = document.getElementById('results-grid');
const resultsStatus = document.getElementById('results-status');
const explainDialog = document.getElementById('explain-dialog');
const explainTitle = document.getElementById('explain-title');
const explainBody = document.getElementById('explain-body');

function temperatureFromSlider() {
  const v = Number(tempSlider.value);
  return 0.05 + (v / 100) * 1.2;
}

function seedTypeLabel(type) {
  if (type === 'movie') return 'movie';
  if (type === 'person') return 'person';
  return 'theme';
}

function markSettingsChanged() {
  if (hasResults) {
    resultsStatus.textContent = 'Data points changed — press "Get suggestions" to refresh.';
  }
}

function addResolvedSeed(value, resolved) {
  seeds.push({ query: value, resolved });
  seedInput.value = '';
  seedErrorEl.textContent = '';
  renderSeedChips();
  markSettingsChanged();
}

async function addSeedFromInput() {
  const value = seedInput.value.trim();
  seedErrorEl.textContent = '';
  if (!value) return;

  const resolved = resolveSeed(value, movies, taxonomy);
  if (resolved && resolved.matched !== false) {
    addResolvedSeed(value, resolved);
    return;
  }

  // No local match — ask the Worker's free, non-LLM tag-learning fallback
  // before giving up (see js/learn.js). No-ops instantly if unconfigured.
  addSeedBtn.disabled = true;
  addSeedBtn.textContent = 'Checking…';
  try {
    const learned = await tryLearnTag(value);
    if (learned.matched) {
      addResolvedSeed(value, buildLearnedSeed(value, learned.tagId, learned.tagLabel));
      return;
    }
  } finally {
    addSeedBtn.disabled = false;
    addSeedBtn.textContent = 'Add';
  }

  seedErrorEl.textContent = `No match found for "${value}" — try a different movie, actor/director, or theme. (Our catalog is small for this proof of concept, so lesser-known titles or people may not be included yet.)`;
}

function removeSeed(index) {
  seeds.splice(index, 1);
  renderSeedChips();
  markSettingsChanged();
}

function renderSeedChips() {
  seedChipsEl.innerHTML = '';
  seeds.forEach((seed, i) => {
    const li = document.createElement('li');
    li.className = 'seed-chip';

    const label = document.createElement('span');
    label.className = 'seed-chip-label';
    label.textContent = seed.resolved.label;

    const type = document.createElement('span');
    type.className = `seed-chip-type seed-chip-type--${seed.resolved.type}`;
    type.textContent = seedTypeLabel(seed.resolved.type);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'seed-chip-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', `Remove ${seed.resolved.label}`);
    removeBtn.addEventListener('click', () => removeSeed(i));

    li.append(label, type);
    if (seed.resolved.learnedTagLabel) {
      const learned = document.createElement('span');
      learned.className = 'seed-chip-learned';
      learned.textContent = `✨ learned: ${seed.resolved.learnedTagLabel}`;
      li.appendChild(learned);
    }
    li.appendChild(removeBtn);
    seedChipsEl.appendChild(li);
  });
}

function openExplainDialog(movie, reason, query) {
  const explanation = explainMatch(query, movie, tagLookup);
  explainTitle.textContent = `${movie.title} (${movie.year})`;
  explainBody.innerHTML = '';

  if (explanation.isWeak) {
    const p = document.createElement('p');
    p.textContent =
      reason === 'novelty'
        ? "This one doesn't closely match your current data points — it's included on purpose, to introduce you to something outside your usual pattern."
        : 'No strong thematic overlap was found with your current data points — this made the list mostly by chance in this sampling round. Try pressing "Get suggestions" again for a different set.';
    explainBody.appendChild(p);
    return;
  }

  if (reason === 'novelty') {
    const note = document.createElement('p');
    note.className = 'explain-novelty-note';
    note.textContent = 'Included partly as a novelty pick — but it does share real DNA with your data points:';
    explainBody.appendChild(note);
  } else {
    const note = document.createElement('p');
    note.textContent = 'Suggested because it shares this DNA with your data points:';
    explainBody.appendChild(note);
  }

  if (explanation.sharedTags.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'explain-tag-list';
    for (const tag of explanation.sharedTags) {
      const li = document.createElement('li');
      li.textContent = tag.label;
      ul.appendChild(li);
    }
    explainBody.appendChild(ul);
  }

  if (explanation.sharedGenres.length > 0) {
    const p = document.createElement('p');
    p.className = 'explain-genres';
    p.textContent = `Shared genres: ${explanation.sharedGenres.join(', ')}`;
    explainBody.appendChild(p);
  }
}

function renderCard(movie, reason, query) {
  const card = document.createElement('article');
  card.className = 'movie-card';
  card.dataset.movieId = movie.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Why was ${movie.title} suggested?`);

  if (reason === 'novelty') {
    const badge = document.createElement('span');
    badge.className = 'novelty-badge';
    badge.textContent = '✨ New pick';
    card.appendChild(badge);
  }

  const title = document.createElement('h3');
  title.className = 'movie-title';
  title.textContent = movie.title;
  const year = document.createElement('span');
  year.className = 'movie-year';
  year.textContent = ` (${movie.year})`;
  title.appendChild(year);

  const genres = document.createElement('p');
  genres.className = 'movie-genres';
  genres.textContent = movie.genres.join(' · ');

  const synopsis = document.createElement('p');
  synopsis.className = 'movie-synopsis';
  synopsis.textContent = movie.synopsis;

  const cast = document.createElement('p');
  cast.className = 'movie-cast';
  cast.textContent = movie.cast.join(', ');

  const whyHint = document.createElement('p');
  whyHint.className = 'movie-why-hint';
  whyHint.textContent = 'Why this? →';

  card.append(title, genres, synopsis, cast, whyHint);

  const open = () => {
    openExplainDialog(movie, reason, query);
    explainDialog.showModal();
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  return card;
}

function runSearch() {
  activeObservers.forEach((o) => o.disconnect());
  activeObservers = [];
  resultsGrid.innerHTML = '';

  if (seeds.length === 0) {
    resultsStatus.textContent = 'Add a movie, actor, director, or a plot dynamic to see suggestions.';
    hasResults = false;
    return;
  }

  const combined = combineSeeds(seeds.map((s) => s.resolved));
  const scored = scoreMovies(combined, movies);
  const temperature = temperatureFromSlider();
  const results = sampleResults(scored, { count: 10, temperature, noveltyQuota: 2 });

  if (results.length === 0) {
    resultsStatus.textContent = 'No matches yet — try a different data point.';
    hasResults = false;
    return;
  }

  resultsStatus.textContent = `Suggestions based on ${seeds.length} data point${seeds.length > 1 ? 's' : ''}. Tap a card to see why.`;
  hasResults = true;
  for (const { movie, reason } of results) {
    const card = renderCard(movie, reason, combined);
    resultsGrid.appendChild(card);
    activeObservers.push(observeFullyVisible(card, movie.id));
  }
}

async function init() {
  const data = await loadData();
  taxonomy = data.taxonomy;
  movies = data.movies;
  tagLookup = new Map(taxonomy.tags.map((t) => [t.id, t.label]));

  addSeedBtn.addEventListener('click', addSeedFromInput);
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSeedFromInput();
    }
  });
  tempSlider.addEventListener('input', markSettingsChanged);
  searchBtn.addEventListener('click', runSearch);

  explainDialog.addEventListener('click', (e) => {
    if (e.target === explainDialog) explainDialog.close();
  });

  resultsStatus.textContent = 'Add a movie, actor, director, or a plot dynamic to see suggestions.';
}

init();
