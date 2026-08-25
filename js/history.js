const STORAGE_KEY = 'moviedna_impressions_v1';

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable (private mode, quota) — impressions just won't persist.
  }
}

export function getTimesSeen(movieId) {
  const store = loadStore();
  return store[movieId]?.count || 0;
}

export function recordImpression(movieId) {
  const store = loadStore();
  const entry = store[movieId] || { count: 0, lastSeen: null };
  entry.count += 1;
  entry.lastSeen = Date.now();
  store[movieId] = entry;
  saveStore(store);
}

// Only counts an impression once the card is 100% within the viewport —
// a partially visible row (e.g. the second row cut in half) never registers.
export function observeFullyVisible(el, movieId, onSeen) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.999) {
          recordImpression(movieId);
          onSeen?.(movieId);
          observer.unobserve(el);
        }
      }
    },
    { threshold: 1.0 }
  );
  observer.observe(el);
  return observer;
}
