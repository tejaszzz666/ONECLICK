'use strict';

// Read-only access to public GitHub repositories. Nothing is cloned or
// executed: we only read the file tree (GitHub API) and a handful of small
// text files (raw.githubusercontent.com).

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

class SourceError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// Child abort signal that follows `parent` and also fires after `ms`.
function timed(parent, ms) {
  const c = new AbortController();
  const onAbort = () => c.abort();
  if (parent) {
    if (parent.aborted) c.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const t = setTimeout(() => c.abort(), ms);
  return {
    signal: c.signal,
    done() {
      clearTimeout(t);
      if (parent) parent.removeEventListener('abort', onAbort);
    },
  };
}

async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (len && len > max) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}

function createGithubSource({ token, signal } = {}) {
  const headers = {
    'User-Agent': 'oneclick-launch',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function api(path) {
    const t = timed(signal, 10000);
    try {
      let res;
      try {
        res = await fetch(API + path, { headers, signal: t.signal });
      } catch {
        if (signal && signal.aborted) throw new SourceError('aborted', 'Request cancelled.');
        throw new SourceError('network', 'Could not reach GitHub.');
      }
      if (res.status === 404) throw new SourceError('not_found', 'Repository not found. It may be private, renamed or misspelled.');
      if (res.status === 409) throw new SourceError('empty', 'This repository is empty.');
      if (res.status === 403 || res.status === 429) {
        if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
          const reset = Number(res.headers.get('x-ratelimit-reset'));
          throw new SourceError('rate_limited', 'GitHub API rate limit reached. Try again later.', {
            resetAt: reset ? new Date(reset * 1000).toISOString() : null,
          });
        }
        throw new SourceError('forbidden', 'GitHub refused access to this repository.');
      }
      if (!res.ok) throw new SourceError('github_error', `GitHub returned HTTP ${res.status}.`);
      try {
        return await res.json();
      } catch {
        throw new SourceError('github_error', 'GitHub returned an unreadable response.');
      }
    } finally {
      t.done();
    }
  }

  return {
    async getRepo(owner, repo) {
      const r = await api(`/repos/${owner}/${repo}`);
      return {
        fullName: r.full_name,
        name: r.name,
        private: !!r.private,
        archived: !!r.archived,
        fork: !!r.fork,
        defaultBranch: r.default_branch,
        description: r.description || null,
        sizeKB: r.size || 0,
      };
    },

    async getTree(owner, repo, ref) {
      const r = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      const files = (r.tree || []).filter((n) => n.type === 'blob').map((n) => ({ path: n.path, size: n.size || 0 }));
      return { files, truncated: !!r.truncated };
    },

    // Returns file text, or null when the file is missing or larger than maxBytes.
    async getFile(owner, repo, ref, path, maxBytes = 200000) {
      const t = timed(signal, 10000);
      try {
        const url = `${RAW}/${owner}/${repo}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`;
        let res;
        try {
          res = await fetch(url, { headers: { 'User-Agent': 'oneclick-launch' }, signal: t.signal });
        } catch {
          return null;
        }
        if (!res.ok) return null;
        return await readCapped(res, maxBytes);
      } catch {
        return null;
      } finally {
        t.done();
      }
    },
  };
}

module.exports = { createGithubSource, SourceError };
