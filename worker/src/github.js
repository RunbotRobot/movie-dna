function toBase64Utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function fromBase64Utf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

function apiHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'movie-dna-tag-learner (POC)',
  };
}

// Reads the taxonomy straight from the GitHub Contents API (not the raw.
// githubusercontent.com CDN) so we always see the latest committed version
// and get the blob `sha` needed to commit an update back.
export async function getTaxonomyFile(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.TAXONOMY_PATH}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: apiHeaders(env) });
  if (!res.ok) {
    throw new Error(`Failed to fetch taxonomy.json: ${res.status}`);
  }
  const data = await res.json();
  const text = fromBase64Utf8(data.content);
  return { taxonomy: JSON.parse(text), sha: data.sha };
}

export async function commitTaxonomy(env, taxonomy, sha, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.TAXONOMY_PATH}`;
  const content = toBase64Utf8(`${JSON.stringify(taxonomy, null, 2)}\n`);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...apiHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content,
      sha,
      branch: env.GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to commit taxonomy.json: ${res.status} ${body}`);
  }
  return res.json();
}
