'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { analyze } = require('../lib/analyzer');
const { parseRepoUrl, parseDir } = require('../lib/url');
const { buildHealth } = require('../lib/health');

function source(files, meta = {}) {
  return {
    async getRepo(owner, repo) {
      return { name: repo, private: false, archived: false, fork: false, defaultBranch: 'main', description: null, sizeKB: 10, ...meta };
    },
    async getTree() {
      return { files: Object.entries(files).map(([p, t]) => ({ path: p, size: t.length })), truncated: false };
    },
    async getFile(o, r, ref, p) {
      return p in files ? files[p] : null;
    },
  };
}
const run = (files, opts = {}, meta) => analyze('acme/mono', { source: source(files, meta), ...opts });
const pkg = (o) => JSON.stringify(o);
const vite = pkg({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } });
const api = pkg({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } });

/* ---------------------------- owner/repo@branch ---------------------------- */

test('owner/repo@branch: simple, slashed and dotted branch names', () => {
  assert.deepEqual(pick(parseRepoUrl('acme/app@develop')), { owner: 'acme', repo: 'app', ref: 'develop', dir: null });
  assert.equal(parseRepoUrl('acme/app@feature/login').ref, 'feature/login');
  assert.equal(parseRepoUrl('acme/app@v1.2.3').ref, 'v1.2.3');
  assert.equal(parseRepoUrl('acme/app').ref, null);
});
function pick(r) {
  return { owner: r.owner, repo: r.repo, ref: r.ref, dir: r.dir };
}

test('owner/repo@branch: unsafe branch names and hosts are rejected', () => {
  for (const s of ['acme/app@../x', 'acme/app@a//b', 'acme/app@/x', 'acme/app@x/', 'acme/app@a b', 'acme/app@a;b', 'acme/app@', 'acme/app@x.lock']) {
    assert.equal(parseRepoUrl(s).ok, false, s);
  }
  assert.equal(parseRepoUrl('evil.com/app@main').ok, false);
  assert.equal(parseRepoUrl('https://gitlab.com/a/b@main').ok, false);
});

test('tree URLs: a folder after the branch selects a folder; a plain branch URL does not', () => {
  const a = parseRepoUrl('https://github.com/acme/mono/tree/main/apps/web');
  assert.equal(a.ref, 'main');
  assert.equal(a.dir, 'apps/web');
  const b = parseRepoUrl('https://github.com/acme/mono/tree/main');
  assert.equal(b.dir, null);
  // the URL parser resolves dot segments before we see them, so traversal collapses to a plain, safe folder name
  const dots = parseRepoUrl('https://github.com/acme/mono/tree/main/apps/../x');
  assert.equal(dots.dir, 'x');
  assert.ok(!String(dots.dir).includes('..'));
  assert.equal(parseRepoUrl('https://github.com/acme/mono/tree/main/a%00b').ok, false);
});

test('parseDir: root, trimming, and rejected paths', () => {
  assert.deepEqual(parseDir('.'), { ok: true, dir: '' });
  assert.deepEqual(parseDir(''), { ok: true, dir: '' });
  assert.deepEqual(parseDir('/apps/web/'), { ok: true, dir: 'apps/web' });
  for (const s of ['../x', 'a/../b', 'a/./b', 'a b', 'a;b', 'a\\b', 'a/b/c/d/e/f/g', 'x'.repeat(201)]) assert.equal(parseDir(s).ok, false, s);
  assert.equal(parseDir(5).ok, false);
});

test('the branch from owner/repo@branch reaches the analysis', async () => {
  let asked = null;
  const s = source({ 'package.json': api, 'server.js': '' });
  const orig = s.getTree;
  s.getTree = async (o, r, ref) => {
    asked = ref;
    return orig();
  };
  const r = await analyze('acme/app@feature/login', { source: s });
  assert.equal(asked, 'feature/login');
  assert.equal(r.repo.branch, 'feature/login');
});

/* ----------------------------- monorepo picker ----------------------------- */

const mono = { 'package.json': pkg({ name: 'root', private: true, workspaces: ['apps/*'] }), 'apps/web/package.json': vite, 'apps/web/package-lock.json': '{}', 'apps/api/package.json': api, 'apps/api/server.js': '', 'apps/api/package-lock.json': '{}' };

test('monorepo: every project folder is listed and the default one is marked', async () => {
  const r = await run(mono);
  assert.deepEqual(r.projects.map((p) => p.dir), ['.', 'apps/api', 'apps/web']);
  assert.deepEqual(r.projects.filter((p) => p.selected).map((p) => p.dir), ['.']);
  assert.equal(r.projects[1].manifest, 'package.json');
});

test('monorepo: choosing a folder analyzes that project and builds folder-aware links', async () => {
  const r = await run(mono, { dir: 'apps/web' });
  assert.equal(r.project.root, 'apps/web');
  assert.equal(r.framework.name, 'Vite + React');
  assert.deepEqual(r.projects.filter((p) => p.selected).map((p) => p.dir), ['apps/web']);
  assert.equal(r.runPlan.options.find((o) => o.id === 'stackblitz').url, 'https://stackblitz.com/github/acme/mono/tree/main/apps/web');
  assert.ok(!r.warnings.some((w) => /No manifest at the repository root/.test(w)));
  const back = await run(mono, { dir: '.' });
  assert.equal(back.project.root, '.');
});

test('monorepo: a folder from a pasted /tree/ URL is honoured, and an explicit dir overrides it', async () => {
  const a = await analyze('https://github.com/acme/mono/tree/main/apps/api', { source: source(mono) });
  assert.equal(a.project.root, 'apps/api');
  const b = await analyze('https://github.com/acme/mono/tree/main/apps/api', { source: source(mono), dir: 'apps/web' });
  assert.equal(b.project.root, 'apps/web');
});

test('monorepo: a missing or invalid folder is a clear error, not a silent fallback', async () => {
  await assert.rejects(run(mono, { dir: 'apps/nope' }), (e) => e.code === 'dir_not_found' && /apps\/nope/.test(e.message));
  await assert.rejects(run(mono, { dir: '../etc' }), (e) => e.code === 'invalid_dir');
});

test('a folder with only an index.html is analyzed as a static page', async () => {
  const r = await run({ 'package.json': api, 'server.js': '', 'site/index.html': '<html></html>' }, { dir: 'site' });
  assert.equal(r.projectType, 'Static site');
  assert.equal(r.project.root, 'site');
  assert.ok(r.runPlan.options.some((o) => o.id === 'preview'));
});

test('single-project repositories still report their one project', async () => {
  const r = await run({ 'package.json': api, 'server.js': '' });
  assert.equal(r.projects.length, 1);
  assert.equal(r.projects[0].selected, true);
});

/* ------------------------------- repo health ------------------------------- */

const NOW = new Date('2026-10-05T00:00:00Z');

test('health: last push age and staleness', () => {
  const recent = buildHealth({ pushedAt: '2026-09-25T00:00:00Z', license: 'MIT' }, new Set(), NOW);
  assert.equal(recent.lastPush.ageDays, 10);
  assert.deepEqual(recent.items[0], { level: 'ok', text: 'Last pushed 10 days ago.' });
  const old = buildHealth({ pushedAt: '2023-01-01T00:00:00Z', license: 'MIT' }, new Set(), NOW);
  assert.equal(old.items[0].level, 'warn');
  assert.match(old.items[0].text, /3 years ago.*may need updating/);
  const mid = buildHealth({ pushedAt: '2025-06-01T00:00:00Z', license: 'MIT' }, new Set(), NOW);
  assert.equal(mid.items[0].level, 'info');
  assert.equal(buildHealth({ pushedAt: 'garbage' }, new Set(), NOW).lastPush, null);
  assert.equal(buildHealth({}, new Set(), NOW).lastPush, null);
});

test('health: license known, license file only, or none', () => {
  assert.deepEqual(buildHealth({ license: 'MIT' }, new Set(), NOW).items, [{ level: 'ok', text: 'License: MIT.' }]);
  const file = buildHealth({}, new Set(['LICENSE.md']), NOW);
  assert.equal(file.items[0].level, 'info');
  assert.equal(file.license.fileFound, true);
  assert.equal(buildHealth({}, new Set(['docs/LICENSE']), NOW).items[0].level, 'warn'); // only the root counts
  assert.match(buildHealth({}, new Set(), NOW).items[0].text, /No license found/);
});

test('health: forks are mentioned, and the analysis result carries health and license', async () => {
  assert.ok(buildHealth({ fork: true, license: 'MIT' }, new Set(), NOW).items.some((i) => /fork/.test(i.text)));
  const r = await run({ 'package.json': api, 'server.js': '' }, {}, { pushedAt: '2020-01-01T00:00:00Z', license: 'Apache-2.0' });
  assert.equal(r.repo.license, 'Apache-2.0');
  assert.equal(r.repo.pushedAt, '2020-01-01T00:00:00Z');
  assert.ok(r.health.items.some((i) => i.level === 'warn' && /Last pushed/.test(i.text)));
  assert.ok(r.health.items.some((i) => /Apache-2.0/.test(i.text)));
});

/* ---------------------- .env builder (the page's own code) ---------------------- */

function loadEnvBuilder() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'launch.html'), 'utf8');
  const m = html.match(/\/\*envfile:start\*\/([\s\S]*?)\/\*envfile:end\*\//);
  assert.ok(m, 'envfile markers present in launch.html');
  return new Function(`${m[1]}; return { envQuote, buildEnvFile };`)();
}

test('.env builder: plain, empty, spaced, quoted and multi-line values', () => {
  const { buildEnvFile } = loadEnvBuilder();
  const vars = [{ name: 'PORT' }, { name: 'EMPTY' }, { name: 'GREETING' }, { name: 'QUOTE' }, { name: 'BOTH' }, { name: 'ML' }, { name: 'URL' }];
  const out = buildEnvFile(vars, { PORT: '3000', EMPTY: '', GREETING: 'hello world', QUOTE: 'say "hi"', BOTH: `it's "x"`, ML: 'a\nb\r\nc', URL: 'postgres://u:p@h:5432/db?x=1' });
  assert.deepEqual(out.split('\n'), ['PORT=3000', 'EMPTY=', "GREETING='hello world'", `QUOTE='say "hi"'`, `BOTH="it's \\"x\\""`, "ML='a b c'", 'URL=\'postgres://u:p@h:5432/db?x=1\'', '']);
  assert.equal(buildEnvFile([], {}), '');
  assert.equal(buildEnvFile([{ name: 'A' }], null), 'A=\n');
});

test('.env builder: a value can never inject another variable', () => {
  const { buildEnvFile } = loadEnvBuilder();
  const out = buildEnvFile([{ name: 'A' }], { A: 'x\nEVIL=1' });
  assert.equal(out.trim().split('\n').length, 1);
});

/* --------------------- HTTP server with a stubbed GitHub --------------------- */

test('server: dir is passed through for POST and SSE, and bad input maps to 4xx', async () => {
  const realFetch = globalThis.fetch;
  const tree = Object.keys(mono).map((p) => ({ path: p, type: 'blob', size: mono[p].length }));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u === 'https://api.github.com/repos/acme/mono') return json({ name: 'mono', private: false, archived: false, fork: false, default_branch: 'main', size: 5, pushed_at: '2026-09-01T00:00:00Z', license: { spdx_id: 'MIT', name: 'MIT License' } });
    if (u.startsWith('https://api.github.com/repos/acme/mono/git/trees/')) return json({ tree, truncated: false });
    if (u.startsWith('https://raw.githubusercontent.com/acme/mono/main/')) {
      const p = decodeURIComponent(u.replace('https://raw.githubusercontent.com/acme/mono/main/', ''));
      return p in mono ? new Response(mono[p], { status: 200 }) : new Response('', { status: 404 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  const { createServer } = require('../server');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = async (body) => {
      const res = await fetch(base + '/api/analyze', { method: 'POST', body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const a = await post({ url: 'acme/mono', dir: 'apps/web' });
    assert.equal(a.status, 200);
    assert.equal(a.json.project.root, 'apps/web');
    assert.equal(a.json.repo.license, 'MIT');
    assert.equal((await post({ url: 'acme/mono' })).json.project.root, '.');
    const missing = await post({ url: 'acme/mono', dir: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'dir_not_found');
    assert.equal((await post({ url: 'acme/mono', dir: '../x' })).status, 400);

    const sse = await (await fetch(`${base}/api/analyze/stream?url=${encodeURIComponent('acme/mono')}&dir=${encodeURIComponent('apps/api')}`)).text();
    const result = sse.split('\n\n').find((b) => b.startsWith('event: result'));
    assert.ok(result, 'result event received');
    assert.equal(JSON.parse(result.split('data: ')[1]).project.root, 'apps/api');
    const bad = await (await fetch(`${base}/api/analyze/stream?url=acme/mono&dir=nope`)).text();
    assert.match(bad, /event: error[\s\S]*dir_not_found/);
  } finally {
    await new Promise((r) => server.close(r));
    globalThis.fetch = realFetch;
  }
});
