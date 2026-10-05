'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/analyzer');

function fakeSource(files, { branch = 'main' } = {}) {
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
const run = (files, url = 'https://github.com/acme/app') => analyze(url, { source: fakeSource(files) });
const pkg = (o) => JSON.stringify(o);
const opt = (r, id) => r.runPlan.options.find((x) => x.id === id);

test('run plan: vite + react recommends the browser runner and offers a Vercel deploy', async () => {
  const r = await run({
    'package.json': pkg({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }),
    'package-lock.json': '{}',
  });
  assert.equal(r.runPlan.recommended, 'stackblitz');
  assert.equal(opt(r, 'stackblitz').fit, 'good');
  assert.equal(opt(r, 'stackblitz').url, 'https://stackblitz.com/github/acme/app');
  assert.equal(opt(r, 'vercel').fit, 'good');
  assert.ok(opt(r, 'vercel').url.includes(encodeURIComponent('https://github.com/acme/app')));
  assert.equal(r.execution.available, false);
});

test('run plan: a library is never recommended as runnable', async () => {
  const r = await run({ 'package.json': pkg({ name: 'lib', main: 'index.js', dependencies: {} }), 'index.js': '', 'package-lock.json': '{}' });
  assert.equal(r.projectType, 'Library or package');
  assert.equal(r.runPlan.recommended, null);
  assert.equal(opt(r, 'stackblitz'), undefined);
  assert.equal(opt(r, 'codespaces').fit, 'maybe');
  assert.ok(opt(r, 'codespaces').notes[0].includes('library'));
});

test('run plan: native modules and database drivers downgrade the browser option', async () => {
  const r = await run({
    'package.json': pkg({ dependencies: { express: '4', sharp: '1', pg: '8' }, scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}',
    'server.js': '',
  });
  const sb = opt(r, 'stackblitz');
  assert.equal(sb.fit, 'maybe');
  assert.ok(sb.notes.some((n) => /native modules \(sharp\)/.test(n)));
  assert.ok(sb.notes.some((n) => /PostgreSQL/.test(n)));
  assert.equal(r.runPlan.recommended, 'codespaces');
});

test('run plan: secrets without example values are called out', async () => {
  const r = await run({
    'package.json': pkg({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}',
    'server.js': 'const k = process.env.STRIPE_SECRET;',
  });
  assert.equal(opt(r, 'stackblitz').fit, 'maybe');
  assert.ok(opt(r, 'stackblitz').notes.some((n) => /STRIPE_SECRET/.test(n)));
});

test('run plan: python gets a cloud machine only, with the detected commands', async () => {
  const r = await run({ 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': '' });
  assert.equal(opt(r, 'stackblitz'), undefined);
  assert.equal(r.runPlan.recommended, 'codespaces');
  const t = opt(r, 'codespaces').terminal;
  assert.equal(t.cwd, '.');
  assert.ok(t.steps.some((s) => s.label === 'start' && s.cmd.startsWith('uvicorn')));
});

test('run plan: nested project builds a subfolder StackBlitz URL', async () => {
  const r = await run({
    'web/package.json': pkg({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }),
    'web/package-lock.json': '{}',
  });
  assert.equal(opt(r, 'stackblitz').url, 'https://stackblitz.com/github/acme/app/tree/main/web');
  assert.equal(opt(r, 'vercel').fit, 'maybe');
});

test('run plan: static site, unknown repo, electron, and github.dev honesty', async () => {
  const s = await run({ 'index.html': '<html></html>' });
  assert.ok(opt(s, 'vercel'));
  assert.equal(opt(s, 'stackblitz'), undefined);
  assert.equal(s.runPlan.recommended, 'preview'); // a plain static page opens directly (see static-demo.test.js)

  const u = await run({ 'notes.txt': 'hello' });
  assert.equal(opt(u, 'codespaces').fit, 'maybe');

  const e = await run({ 'package.json': pkg({ dependencies: { electron: '30' }, scripts: { start: 'electron .' } }), 'package-lock.json': '{}' });
  assert.equal(opt(e, 'stackblitz'), undefined);

  for (const r of [s, u, e]) {
    const gd = opt(r, 'github-dev');
    assert.equal(gd.runs, false);
    assert.equal(gd.fit, 'editor-only');
    assert.notEqual(r.runPlan.recommended, 'github-dev');
  }
});

test('library: honest status, no start command, no best option', async () => {
  const r = await run({ 'package.json': pkg({ name: 'lib', main: 'index.js', scripts: { test: 'mocha' } }), 'index.js': '', 'package-lock.json': '{}' });
  assert.equal(r.status, 'LIBRARY');
  assert.equal(r.commands.start, null);
  assert.equal(r.runPlan.recommended, null);
  assert.equal(r.entryPoint.path, 'index.js');
});

test('static site: a library with a root demo page is previewable; a nested index.html alone is not claimed', async () => {
  // by design (particles.js case): a package that also ships index.html at its root counts as a static demo
  const withManifest = await run({ 'index.html': '<html></html>', 'package.json': pkg({ name: 'x', scripts: { test: 'x' } }) });
  assert.equal(withManifest.projectType, 'Static site');
  assert.equal(withManifest.project.root, '.');
  const nested = await run({ 'docs/index.html': '<html></html>', 'README.md': 'hi' });
  assert.notEqual(nested.projectType, 'Static site');
});
