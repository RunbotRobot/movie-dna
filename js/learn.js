// Update this once the Cloudflare Worker is deployed (see worker/README.md).
// Left unset/placeholder, the tag-learning fallback silently no-ops and the
// app behaves exactly as it did before this feature existed.
export const WORKER_URL = 'https://movie-dna-tag-learner.YOUR-SUBDOMAIN.workers.dev/learn';

function isConfigured() {
  return typeof WORKER_URL === 'string' && WORKER_URL.length > 0 && !WORKER_URL.includes('YOUR-SUBDOMAIN');
}

// Asks the Worker whether `query` maps to an existing taxonomy tag via the
// free, non-LLM Datamuse-based accept gate. Always resolves (never throws) —
// any failure (unconfigured, offline, Worker error, timeout) resolves to
// { matched: false } so the caller can fall back to the normal "no match"
// message without special-casing network errors.
export async function tryLearnTag(query) {
  if (!isConfigured()) return { matched: false };
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { matched: false };
    const data = await res.json();
    return data && data.matched ? data : { matched: false };
  } catch {
    return { matched: false };
  }
}
