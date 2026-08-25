import { loadData } from './data.js';
import { resolveSeed, combineSeeds, scoreMovies } from './similarity.js';
import { sampleResults } from './sampling.js';
import { observeFullyVisible } from './history.js';

let taxonomy = null;
let movies = null;
let seeds = [];
let activeObservers = [];

const seedInput = document.getElementById('seed-input');
const addSeedBtn = document.getElementById('add-seed-btn');
const seedChipsEl = document.getElementById('seed-chips');
const tempSlider = document.getElementById('temperature-slider');
const resultsGrid = document.getElementById('results-grid');
const resultsStatus = document.getElementById('results-status');

function temperatureFromSlider() {
  const v = Number(tempSlider.value);
  return 0.05 + (v / 100) * 1.2;
}

function seedTypeLabel(type) {
  if (type === 'movie') return 'movie';
  if (type === 'person') return 'person';
  return 'theme';
}

function addSeedFromInput() {
  const value = seedInput.value.trim();
  if (!value) return;
  const resolved = resolveSeed(value, movies, taxonomy);
  if (!resolved) return;
  seeds.push({ query: value, resolved });
  seedInput.value = '';
  renderSeedChips();
  render();
}

function removeSeed(index) {
  seeds.splice(index, 1);
  renderSeedChips();
  render();
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

    li.append(label, type, removeBtn);
    seedChipsEl.appendChild(li);
  });
}

function renderCard(movie) {
  const card = document.createElement('article');
  card.className = 'movie-card';
  card.dataset.movieId = movie.id;

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

  card.append(title, genres, synopsis, cast);
  return card;
}

function render() {
  activeObservers.forEach((o) => o.disconnect());
  activeObservers = [];
  resultsGrid.innerHTML = '';

  if (seeds.length === 0) {
    resultsStatus.textContent = 'Add a movie, actor, director, or a plot dynamic to see suggestions.';
    return;
  }

  const combined = combineSeeds(seeds.map((s) => s.resolved));
  const scored = scoreMovies(combined, movies);
  const temperature = temperatureFromSlider();
  const results = sampleResults(scored, { count: 10, temperature, noveltyQuota: 2 });

  if (results.length === 0) {
    resultsStatus.textContent = 'No matches yet — try a different data point.';
    return;
  }

  resultsStatus.textContent = `Suggestions based on ${seeds.length} data point${seeds.length > 1 ? 's' : ''}:`;
  for (const movie of results) {
    const card = renderCard(movie);
    resultsGrid.appendChild(card);
    activeObservers.push(observeFullyVisible(card, movie.id));
  }
}

async function init() {
  const data = await loadData();
  taxonomy = data.taxonomy;
  movies = data.movies;

  addSeedBtn.addEventListener('click', addSeedFromInput);
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSeedFromInput();
    }
  });
  tempSlider.addEventListener('input', render);

  render();
}

init();
