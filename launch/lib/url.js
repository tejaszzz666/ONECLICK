'use strict';

// Strict GitHub repository URL parsing. The output is only ever used to build
// api.github.com / raw.githubusercontent.com URLs, so owner/repo/ref/dir are
// restricted to characters GitHub itself allows.
//
// Accepted inputs:
//   owner/repo                       shorthand
//   owner/repo@branch                shorthand with a branch (the branch may contain "/")
//   https://github.com/owner/repo
//   https://github.com/owner/repo/tree/branch
//   https://github.com/owner/repo/tree/branch/sub/folder   (selects a folder inside the repo)

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._-]{1,100}$/;
// branch names after "@": slashes allowed (feature/x), but no "..", no "//", no leading/trailing slash
const AT_REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const DIR_SEG_RE = /^[A-Za-z0-9._@+-]{1,100}$/;

function validAtRef(s) {
  return AT_REF_RE.test(s) && !s.includes('..') && !s.includes('//') && !s.startsWith('/') && !s.endsWith('/') && !s.endsWith('.lock');
}

// Folder inside the repository. '.' (or '') means the repository root. Returns { ok, dir } with dir '' for the root.
function parseDir(input) {
  if (typeof input !== 'string') return { ok: false, error: 'The folder path is not valid.' };
  let s = input.trim().replace(/^\/+|\/+$/g, '');
  if (s === '' || s === '.') return { ok: true, dir: '' };
  if (s.length > 200) return { ok: false, error: 'The folder path is too long.' };
  const segs = s.split('/');
  if (segs.length > 6 || segs.some((g) => g === '.' || g === '..' || !DIR_SEG_RE.test(g))) return { ok: false, error: 'The folder path is not valid.' };
  return { ok: true, dir: segs.join('/') };
}

function parseRepoUrl(input) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== 'string') return fail('Enter a GitHub repository URL.');
  let s = input.trim();
  if (!s) return fail('Enter a GitHub repository URL.');
  if (s.length > 300) return fail('That URL is too long.');

  // shorthand with a branch: "owner/repo@branch" (owner has no dot, so real hostnames never match)
  let atRef = null;
  const withRef = s.match(/^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)@(.+)$/);
  if (withRef) {
    if (!validAtRef(withRef[2])) return fail('The branch name is not valid.');
    atRef = withRef[2];
    s = withRef[1];
  }
  // shorthand: "owner/repo" means github.com/owner/repo
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

  let ref = atRef;
  let dir = null;
  if (parts[2] === 'tree' && parts[3] && REF_RE.test(parts[3]) && parts[3] !== '..') {
    if (!ref) ref = parts[3];
    // /tree/<branch>/<folder...>: a branch name containing "/" cannot be told apart from a folder here,
    // so only single-segment branches are read from this form; use owner/repo@branch for the others.
    if (parts.length > 4 && !atRef) {
      const d = parseDir(parts.slice(4).join('/'));
      if (!d.ok) return fail(d.error);
      dir = d.dir;
    }
  }

  return { ok: true, owner, repo, ref, dir, canonical: `https://github.com/${owner}/${repo}` };
}

module.exports = { parseRepoUrl, parseDir };
