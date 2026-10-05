'use strict';

// Strict GitHub repository URL parsing. The output is only ever used to build
// api.github.com / raw.githubusercontent.com URLs, so owner/repo/ref are
// restricted to characters GitHub itself allows.

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._-]{1,100}$/;

function parseRepoUrl(input) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== 'string') return fail('Enter a GitHub repository URL.');
  let s = input.trim();
  if (!s) return fail('Enter a GitHub repository URL.');
  if (s.length > 300) return fail('That URL is too long.');
  // shorthand: "owner/repo" means github.com/owner/repo (first part has no dot, so real hostnames never match)
  if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(s)) s = 'github.com/' + s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    return fail('That does not look like a valid URL.');
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return fail('Only github.com repositories are supported.');
  }
  if (u.username || u.password) return fail('Remove credentials from the URL.');

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return fail('Use the form https://github.com/owner/repository.');

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner)) return fail('The repository owner name is not valid.');
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') return fail('The repository name is not valid.');

  let ref = null;
  if (parts[2] === 'tree' && parts[3] && REF_RE.test(parts[3]) && parts[3] !== '..') ref = parts[3];

  return { ok: true, owner, repo, ref, canonical: `https://github.com/${owner}/${repo}` };
}

module.exports = { parseRepoUrl };
