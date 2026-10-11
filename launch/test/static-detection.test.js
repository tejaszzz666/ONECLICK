'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/analyzer');

function source(files) {
  return {
    async getRepo(owner, repo) {
      return { name: repo, private: false, archived: false, fork: false, defaultBranch: 'master', description: null, sizeKB: 100 };
    },
    async getTree() {
      return { files: Object.entries(files).map(([p, t]) => ({ path: p, size: t.length })), truncated: false };
    },
    async getFile(o, r, ref, p) {
      return p in files ? files[p] : null;
    },
  };
}
const run = (files, opts = {}) => analyze('amycruz97/car-dealership-website', { source: source(files), ...opts });
const preview = (r) => r.runPlan.options.find((o) => o.id === 'preview');
const page = '<html><link rel="stylesheet" href="style.css"><img src="car.jpg"></html>';

test('a root page with different capitalization is a static site (Index.html, INDEX.HTM)', async () => {
  for (const name of ['Index.html', 'INDEX.HTM', 'index.htm']) {
    const r = await run({ [name]: page, 'style.css': '', 'car.jpg': 'x' });
    assert.equal(r.status, 'READY', name);
    assert.equal(r.projectType, 'Static site', name);
    assert.equal(r.runPlan.recommended, 'preview', name);
    assert.ok(preview(r).url.endsWith('/' + name), `${name}: ${preview(r).url}`);
  }
});

test('a site inside a subfolder is found, with the folder in every link', async () => {
  const r = await run({ 'Car Dealership/index.html': page, 'Car Dealership/style.css': '', 'Car Dealership/car.jpg': 'x', 'README.md': '# hi' });
  assert.equal(r.status, 'READY');
  assert.equal(r.project.root, 'Car Dealership');
  assert.equal(preview(r).url, 'https://raw.githack.com/amycruz97/car-dealership-website/master/Car%20Dealership/index.html');
  assert.ok(r.runPlan.options.find((o) => o.id === 'vercel').blockers.some((b) => b.code === 'root-directory' && /Car Dealership/.test(b.message)));
});

test('the shallowest page wins, then conventional names, then others', async () => {
  const a = await run({ 'site/index.html': page, 'index.html': page });
  assert.equal(a.project.root, '.');
  const b = await run({ 'about.html': page, 'home.html': page, 'contact.html': page });
  assert.ok(preview(b).url.endsWith('/home.html'));
  const c = await run({ 'about.html': page, 'contact.html': page });
  assert.equal(c.projectType, 'Static site');
  assert.ok(preview(c).url.endsWith('/about.html'));
});

test('a backend project that merely ships a docs page is not claimed as a static site', async () => {
  for (const files of [{ 'main.go': 'package main', 'docs/index.html': page }, { 'app.py': '', 'site/home.html': page }, { 'lib.c': '', 'about.html': page }]) {
    const r = await run(files);
    assert.equal(r.status, 'UNKNOWN', JSON.stringify(Object.keys(files)));
    assert.equal(preview(r), undefined);
  }
});

test('a conventionally named root index page still counts even next to server files', async () => {
  const r = await run({ 'index.html': page, 'contact.php': '<?php ?>' });
  assert.equal(r.projectType, 'Static site');
});

test('vendored and too-deep pages are ignored', async () => {
  assert.equal((await run({ 'node_modules/x/index.html': page, 'README.md': '' })).status, 'UNKNOWN');
  assert.equal((await run({ 'a/b/c/index.html': page })).status, 'UNKNOWN');
  assert.equal((await run({ '.hidden/index.html': page })).status, 'UNKNOWN');
});

test('an explicit folder also matches pages case-insensitively', async () => {
  const r = await run({ 'Index.HTML': '<html></html>', 'shop/Index.HTM': page, 'shop/style.css': '' }, { dir: 'shop' });
  assert.equal(r.projectType, 'Static site');
  assert.ok(preview(r).url.endsWith('/shop/Index.HTM'));
});

test('an unsupported repository says what it actually contains', async () => {
  const logs = [];
  const r = await run({ 'a.c': '', 'b.c': '', 'README.md': '', 'logo.png': '' }, { emit: (e) => e.type === 'log' && logs.push(e.msg) });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.inventory.total, 4);
  assert.deepEqual(r.inventory.byType[0], { ext: '.c', count: 2 });
  assert.match(r.statusReason, /4 files: 2 \.c, 1 \.md, 1 \.png/);
  assert.ok(logs.some((m) => /This repository contains 4 files/.test(m)));
  assert.ok(r.inventory.topLevel.includes('README.md'));
});

test('inventory is present for every result', async () => {
  const r = await run({ 'package.json': JSON.stringify({ scripts: { start: 'node a.js' } }), 'a.js': '' });
  assert.equal(r.inventory.total, 2);
  assert.equal(r.inventory.byType.length, 2);
});
