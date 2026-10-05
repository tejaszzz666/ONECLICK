'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRepoUrl } = require('../lib/url');

test('owner/repo shorthand resolves to GitHub', () => {
  const r = parseRepoUrl('heroku/node-js-getting-started');
  assert.equal(r.ok, true);
  assert.equal(r.owner, 'heroku');
  assert.equal(r.repo, 'node-js-getting-started');
});

test('full URLs, www and .git suffixes still work', () => {
  for (const s of ['https://github.com/a/b', 'github.com/a/b', 'https://www.github.com/a/b.git', 'https://github.com/a/b/tree/main']) {
    const r = parseRepoUrl(s);
    assert.equal(r.ok, true, s);
    assert.equal(r.repo, 'b', s);
  }
});

test('shorthand cannot be used to reach other hosts or odd inputs', () => {
  for (const s of ['evil.com/a', 'localhost/a', '../etc/passwd', 'a/b/c/d', 'https://gitlab.com/a/b', 'https://evil.com/github.com/a/b', 'a/b;rm']) {
    const r = parseRepoUrl(s);
    assert.equal(r.ok && r.owner === 'evil.com', false, s);
    if (r.ok) assert.ok(/^[A-Za-z0-9-]+$/.test(r.owner), s);
  }
  assert.equal(parseRepoUrl('https://gitlab.com/a/b').ok, false);
  assert.equal(parseRepoUrl('evil.com/a').ok, false);
});
