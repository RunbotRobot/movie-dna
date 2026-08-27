import { loadData } from './data.js';
import { resolveSeed, combineSeeds, scoreMovies, explainMatch, buildLearnedSeed, computeTagIdf } from './similarity.js';
import { sampleResults } from './sampling.js';
import { observeFullyVisible } from './history.js';
import { tryLearnTag } from './learn.js';

let taxonomy = null;
let tagLookup = new Map();
let seeds = [];
let activeObservers = [];
let hasResults = false;

// Two separate movie catalogs sharing one taxonomy. Only one is "active" at
// a time — searches, seed resolution, and scoring only ever see the active
// catalog's movies, so results never mix between them (switching catalogs
// clears any existing seeds/results, since a seed resolved against one
// catalog has no meaning in the other).
let catalogs = null; // { main: {label, movies, tagIdf}, artiflix: {...} }
let activeCatalogKey = 'main';
function activeCatalog() {
  return catalogs[activeCatalogKey];
}

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
const disambiguateDialog = document.getElementById('disambiguate-dialog');
const disambiguateTitle = document.getElementById('disambiguate-title');
const disambiguateList = document.getElementById('disambiguate-list');
const catalogMainBtn = document.getElementById('catalog-main-btn');
const catalogArtiflixBtn = document.getElementById('catalog-artiflix-btn');
const catalogNoteEl = document.getElementById('catalog-note');

function temperatureFromSlider() {
  const v = Number(tempSlider.value);
  return 0.05 + (v / 100) * 1.2;
}

function seedTypeLabel(type) {
  if (type === 'movie') return 'movie';
  if (type === 'person') return 'person';
  if (type === 'studio') return 'studio';
  return 'theme';
}

function markSettingsChanged() {
  if (hasResults) {
    resultsStatus.textContent = 'Data points changed — press "Get suggestions" to refresh.';
  }
}

// Shows the disambiguation dialog and resolves once the user picks a
// candidate (or null if they cancel/close it without choosing).
function pickCandidate(query, candidates) {
  return new Promise((resolve) => {
    disambiguateTitle.textContent = `Multiple matches for "${query}"`;
    disambiguateList.innerHTML = '';
    candidates.forEach((candidate, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'disambiguate-option';
      btn.textContent = candidate.label;
      btn.addEventListener('click', () => disambiguateDialog.close(String(i)));
      li.appendChild(btn);
      disambiguateList.appendChild(li);
    });

    disambiguateDialog.addEventListener(
      'close',
      () => {
        document.body.classList.remove('body-scroll-locked');
        const idx = disambiguateDialog.returnValue;
        resolve(idx === '' ? null : candidates[Number(idx)]);
      },
      { once: true }
    );

    disambiguateDialog.returnValue = '';
    disambiguateDialog.showModal();
    document.body.classList.add('body-scroll-locked');
  });
}

// Resolves one query term (never throws): a local match if there is one,
// otherwise the Worker's tag-learning fallback. Returns { resolved },
// { failed: true }, or { skipped: true } if an ambiguous match was
// dismissed without picking one.
async function resolveOneTerm(term) {
  const resolved = resolveSeed(term, activeCatalog().movies, taxonomy);
  if (resolved && resolved.type === 'ambiguous') {
    const chosen = await pickCandidate(term, resolved.candidates);
    return chosen ? { resolved: chosen.build() } : { skipped: true };
  }
  if (resolved && resolved.matched !== false) {
    return { resolved };
  }
  const learned = await tryLearnTag(term);
  if (learned.matched) {
    return { resolved: buildLearnedSeed(term, learned.tagId, learned.tagLabel) };
  }
  return { failed: true };
}

// Splits the input on commas so several data points can be added in one go
// (e.g. "revenge, dark comedy, heist"), resolving each in turn and reporting
// every failure together rather than stopping at the first one.
async function addSeedFromInput() {
  const terms = seedInput.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  seedErrorEl.textContent = '';
  if (terms.length === 0) return;

  addSeedBtn.disabled = true;
  const failures = [];
  try {
    for (const term of terms) {
      addSeedBtn.textContent = terms.length > 1 ? `Checking "${term}"…` : 'Checking…';
      const outcome = await resolveOneTerm(term);
      if (outcome.resolved) {
        seeds.push({ query: term, resolved: outcome.resolved });
      } else if (!outcome.skipped) {
        failures.push(term);
      }
    }
  } finally {
    addSeedBtn.disabled = false;
    addSeedBtn.textContent = 'Add';
  }

  seedInput.value = '';
  renderSeedChips();
  markSettingsChanged();

  if (failures.length > 0) {
    const list = failures.map((f) => `"${f}"`).join(', ');
    seedErrorEl.textContent = `No match found for ${list} — try a different movie, actor/director, or theme. (Our catalog is small for this proof of concept, so lesser-known titles or people may not be included yet.)`;
  }
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
  const explanation = explainMatch(query, movie, tagLookup, activeCatalog().tagIdf);
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
    document.body.classList.add('body-scroll-locked');
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

let pulseTimeout = null;
function pulseSearchButton() {
  searchBtn.classList.remove('primary-btn--pressed');
  void searchBtn.offsetWidth; // restart the CSS animation even if it's still running
  searchBtn.classList.add('primary-btn--pressed');
  const originalLabel = 'Get suggestions';
  searchBtn.textContent = '✓ Updated';
  clearTimeout(pulseTimeout);
  pulseTimeout = setTimeout(() => {
    searchBtn.textContent = originalLabel;
    searchBtn.classList.remove('primary-btn--pressed');
  }, 650);
}

function runSearch() {
  pulseSearchButton();
  activeObservers.forEach((o) => o.disconnect());
  activeObservers = [];
  resultsGrid.innerHTML = '';

  if (seeds.length === 0) {
    resultsStatus.textContent = 'Add a movie, actor, director, or a plot dynamic to see suggestions.';
    hasResults = false;
    return;
  }

  const combined = combineSeeds(seeds.map((s) => s.resolved));
  const scored = scoreMovies(combined, activeCatalog().movies, activeCatalog().tagIdf);
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

function catalogNote(key) {
  if (key === 'artiflix') {
    return 'Classic films sourced from artiflix.com. DNA tagging for this catalog is still in progress, so theme/plot-dynamic matches will be limited until it is — movie and person search work now.';
  }
  return '';
}

function setActiveCatalog(key) {
  activeCatalogKey = key;
  catalogMainBtn.setAttribute('aria-checked', String(key === 'main'));
  catalogArtiflixBtn.setAttribute('aria-checked', String(key === 'artiflix'));
  catalogNoteEl.textContent = catalogNote(key);

  // Seeds/results are catalog-specific — carrying them across would silently
  // mix the two catalogs, which is exactly what switching is meant to avoid.
  seeds = [];
  renderSeedChips();
  resultsGrid.innerHTML = '';
  hasResults = false;
  resultsStatus.textContent = 'Add a movie, actor, director, or a plot dynamic to see suggestions.';
}

async function init() {
  const data = await loadData();
  taxonomy = data.taxonomy;
  tagLookup = new Map(taxonomy.tags.map((t) => [t.id, t.label]));
  catalogs = {
    main: { label: 'My Catalog', movies: data.movies, tagIdf: computeTagIdf(data.movies, taxonomy) },
    artiflix: {
      label: 'Artiflix Classics',
      movies: data.artiflixMovies,
      tagIdf: computeTagIdf(data.artiflixMovies, taxonomy),
    },
  };

  catalogMainBtn.addEventListener('click', () => setActiveCatalog('main'));
  catalogArtiflixBtn.addEventListener('click', () => setActiveCatalog('artiflix'));

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
  // Fires for every way the dialog can close (Esc, the close button's form
  // submit, backdrop click, or a future programmatic .close()) so scroll
  // never stays locked no matter how the user dismisses it.
  explainDialog.addEventListener('close', () => {
    document.body.classList.remove('body-scroll-locked');
  });

  disambiguateDialog.addEventListener('click', (e) => {
    if (e.target === disambiguateDialog) disambiguateDialog.close();
  });

  resultsStatus.textContent = 'Add a movie, actor, director, or a plot dynamic to see suggestions.';
}

init();
