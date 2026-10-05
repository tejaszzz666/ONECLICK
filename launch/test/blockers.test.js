'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/analyzer');
const { checkPreviewHtml } = require('../lib/preview');
const { oldNodeRange } = require('../lib/runners');

function source(files, { branch = 'main' } = {}) {
  return {
    async getRepo(owner, repo) {
      return { name: repo, private: false, archived: false, fork: false, defaultBranch: branch, description: null, sizeKB: 10 };
    },
    async getTree() {
      return { files: Object.entries(files).map(([path, t]) => ({ path, size: t.length })), truncated: false };
    },
    async getFile(o, r, ref, path) {
      return path in files ? files[path] : null;
    },
  };
}
const run = (files, url = 'https://github.com/acme/app') => analyze(url, { source: source(files) });
const pkg = (o) => JSON.stringify(o);
const opt = (r, id) => r.runPlan.options.find((x) => x.id === id);
const codes = (o) => o.blockers.map((b) => b.code);

test('every option carries blockers, ifItFails and an about line', async () => {
  const r = await run({ 'package.json': pkg({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }), 'package-lock.json': '{}' });
  for (const o of r.runPlan.options) {
    assert.ok(Array.isArray(o.blockers), `${o.id} blockers`);
    assert.ok(Array.isArray(o.ifItFails), `${o.id} ifItFails`);
    assert.equal(typeof o.about, 'string');
  }
  assert.deepEqual(opt(r, 'stackblitz').blockers, []);
  assert.ok(opt(r, 'stackblitz').ifItFails.length >= 2);
  assert.equal(opt(r, 'github-dev').ifItFails.length, 0);
});

test('browser runner: native modules and databases are named as concrete blockers', async () => {
  const r = await run({
    'package.json': pkg({ dependencies: { express: '4', sharp: '1', pg: '8' }, scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}',
    'server.js': '',
  });
  const sb = opt(r, 'stackblitz');
  assert.ok(codes(sb).includes('native-modules'));
  assert.ok(codes(sb).includes('needs-service'));
  assert.ok(sb.blockers.find((b) => b.code === 'native-modules').message.includes('sharp'));
  assert.equal(sb.blockers.find((b) => b.code === 'native-modules').severity, 'blocks');
  assert.ok(sb.blockers.find((b) => b.code === 'needs-service').message.includes('PostgreSQL'));
  // Codespaces is still offered, and says what it needs instead of pretending it will just work
  const cs = opt(r, 'codespaces');
  assert.ok(codes(cs).includes('needs-service'));
  assert.match(cs.blockers.find((b) => b.code === 'needs-service').message, /no Docker Compose file/);
});

test('codespaces: a compose file changes the advice for a needed service', async () => {
  const r = await run({
    'package.json': pkg({ dependencies: { express: '4', pg: '8' }, scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}',
    'server.js': '',
    'docker-compose.yml': 'services: {}',
  });
  assert.match(opt(r, 'codespaces').blockers.find((b) => b.code === 'needs-service').message, /docker compose up/);
});

test('python database drivers and heavy ML packages are reported for Codespaces', async () => {
  const r = await run({ 'requirements.txt': 'fastapi\npsycopg2-binary\ntorch\n', 'main.py': '' });
  const cs = opt(r, 'codespaces');
  assert.ok(codes(cs).includes('needs-service'));
  assert.ok(codes(cs).includes('heavy-ml'));
  assert.ok(cs.blockers.find((b) => b.code === 'needs-service').message.includes('PostgreSQL'));
});

test('missing env values are listed as something the visitor must supply', async () => {
  const r = await run({
    'package.json': pkg({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}',
    'server.js': 'const k = process.env.STRIPE_SECRET;',
  });
  const b = opt(r, 'stackblitz').blockers.find((x) => x.code === 'env-vars');
  assert.equal(b.severity, 'needs');
  assert.ok(b.message.includes('STRIPE_SECRET'));
  assert.ok(opt(r, 'stackblitz').ifItFails.some((f) => /STRIPE_SECRET/.test(f.fix)));
});

test('codespaces honestly says it opens a machine and does not start the app', async () => {
  const r = await run({ 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': '' });
  const cs = opt(r, 'codespaces');
  assert.ok(cs.ifItFails.some((f) => /does not start the app/.test(f.fix) && /commands shown above/.test(f.fix)));
  const noCmd = await run({ 'notes.txt': 'hello' });
  assert.ok(opt(noCmd, 'codespaces').ifItFails.some((f) => /did not find commands/.test(f.fix)));
  assert.ok(codes(opt(noCmd, 'codespaces')).includes('unknown-stack'));
});

test('old Node versions are flagged only when nothing newer is allowed', () => {
  assert.equal(oldNodeRange({ value: '12.x', source: 'engines.node' }), '12.x');
  assert.equal(oldNodeRange({ value: '>=12', source: 'engines.node' }), null);
  assert.equal(oldNodeRange({ value: '^14 || ^16', source: 'engines.node' }), null);
  assert.equal(oldNodeRange({ value: '>=10 <15', source: 'engines.node' }), '>=10 <15');
  assert.equal(oldNodeRange({ value: '20', source: '.nvmrc' }), null);
  assert.equal(oldNodeRange(null), null);
});

test('browser runner: an old-only Node version is a limit, not a block', async () => {
  const r = await run({
    'package.json': pkg({ engines: { node: '12.x' }, dependencies: { express: '4' }, scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}',
    'server.js': '',
  });
  const b = opt(r, 'stackblitz').blockers.find((x) => x.code === 'old-node');
  assert.equal(b.severity, 'limits');
  assert.ok(b.message.includes('12.x'));
});

test('static page check: source files that need a build are a blocker and demote the preview', async () => {
  const html = '<html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>';
  const r = await run({ 'index.html': html, 'src/main.jsx': '' });
  const p = opt(r, 'preview');
  assert.ok(p.blockers.some((b) => b.code === 'needs-build' && b.severity === 'blocks'));
  assert.equal(p.fit, 'maybe');
  assert.equal(r.runPlan.recommended, 'vercel');
});

test('static page check: absolute paths and http assets are reported; a clean page has none', () => {
  const issues = checkPreviewHtml('<link rel="stylesheet" href="/css/a.css"><script src="http://x.test/a.js"></script><img src="logo.png">');
  assert.deepEqual(issues.map((i) => i.code).sort(), ['absolute-paths', 'insecure-assets']);
  assert.ok(issues.find((i) => i.code === 'absolute-paths').message.includes('/css/a.css'));
  assert.deepEqual(checkPreviewHtml('<link rel="stylesheet" href="css/a.css"><script src="https://cdn.test/a.js"></script><link rel="icon" href="/favicon.ico"><a href="/about">x</a>'), []);
  assert.deepEqual(checkPreviewHtml(''), []);
  assert.deepEqual(checkPreviewHtml(null), []);
});

test('a clean demo page keeps the preview recommended and shows no blockers', async () => {
  const r = await run({ 'index.html': '<html><link rel="stylesheet" href="style.css"><script src="app.js"></script></html>', 'style.css': '', 'app.js': '' });
  assert.equal(r.runPlan.recommended, 'preview');
  assert.deepEqual(opt(r, 'preview').blockers, []);
});

test('vercel: a nested project asks for the root directory', async () => {
  const r = await run({
    'web/package.json': pkg({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }),
    'web/package-lock.json': '{}',
  });
  const b = opt(r, 'vercel').blockers.find((x) => x.code === 'root-directory');
  assert.equal(b.severity, 'needs');
  assert.ok(b.message.includes('web'));
  assert.ok(opt(r, 'vercel').ifItFails.some((f) => /"dist"/.test(f.fix)));
});
