'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/analyzer');

const src = (files) => ({
  async getRepo(o, r) { return { name: r, private: false, archived: false, fork: false, defaultBranch: 'master', description: null, sizeKB: 158 }; },
  async getTree() { return { files: Object.keys(files).map((p) => ({ path: p, size: 1 })), truncated: false }; },
  async getFile(o, r, ref, p) { return p in files ? files[p] : null; },
});
const lib = { name: 'particles.js', main: 'particles.js' };

test('a library with a root index.html demo becomes a previewable static page', async () => {
  const r = await analyze('https://github.com/vincentgarreau/particles.js', { source: src({ 'package.json': JSON.stringify(lib), 'particles.js': '', 'index.html': '<html></html>' }) });
  assert.equal(r.status, 'READY');
  assert.equal(r.projectType, 'Static site');
  assert.equal(r.runPlan.recommended, 'preview');
  const p = r.runPlan.options.find((o) => o.id === 'preview');
  assert.equal(p.url, 'https://raw.githack.com/vincentgarreau/particles.js/master/index.html');
  assert.ok(!r.runPlan.options.some((o) => o.id === 'stackblitz'));
  assert.match(r.statusReason, /browser demo page/);
});

test('a demo in demo/ is found, with the right path', async () => {
  const r = await analyze('https://github.com/a/lib', { source: src({ 'package.json': JSON.stringify(lib), 'demo/index.html': '', 'demo/app.js': '' }) });
  assert.equal(r.status, 'READY');
  assert.equal(r.runPlan.options.find((o) => o.id === 'preview').url, 'https://raw.githack.com/a/lib/master/demo/index.html');
});

test('a plain static site gets the preview option first', async () => {
  const r = await analyze('https://github.com/a/site', { source: src({ 'index.html': '', 'style.css': '' }) });
  assert.equal(r.runPlan.recommended, 'preview');
  assert.equal(r.runPlan.options.find((o) => o.id === 'preview').url, 'https://raw.githack.com/a/site/master/index.html');
});

test('a true library without any demo page is still a library', async () => {
  const r = await analyze('https://github.com/a/lib', { source: src({ 'package.json': JSON.stringify(lib), 'index.js': '' }) });
  assert.equal(r.status, 'LIBRARY');
  assert.ok(!r.runPlan.options.some((o) => o.id === 'preview'));
});

test('an app with a start script does not get the raw preview', async () => {
  const r = await analyze('https://github.com/a/app', { source: src({ 'package.json': JSON.stringify({ dependencies: { express: '4' }, scripts: { start: 'node i.js' } }), 'i.js': '', 'index.html': '' }) });
  assert.ok(!r.runPlan.options.some((o) => o.id === 'preview'));
});
