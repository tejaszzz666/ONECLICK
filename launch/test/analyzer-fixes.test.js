'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/analyzer');

const src = (files) => ({
  async getRepo(o, r) {
    return { name: r, private: false, archived: false, fork: false, defaultBranch: 'master', description: null, sizeKB: 10 };
  },
  async getTree() {
    return { files: Object.keys(files).map((p) => ({ path: p, size: 1 })), truncated: false };
  },
  async getFile(o, r, ref, p) {
    return p in files ? files[p] : null;
  },
});

test('a library without a lockfile does not get a lockfile warning', async () => {
  const r = await analyze('https://github.com/a/lib', { source: src({ 'package.json': JSON.stringify({ name: 'x', main: 'index.js' }), 'index.js': '' }) });
  assert.equal(r.status, 'LIBRARY');
  assert.ok(!r.warnings.some((w) => /lockfile/.test(w)));
});

test('an app without a lockfile still gets the warning, and no stale execution text', async () => {
  const r = await analyze('https://github.com/a/app', { source: src({ 'package.json': JSON.stringify({ dependencies: { express: '4' }, scripts: { start: 'node i.js' } }), 'i.js': '' }) });
  assert.equal(r.status, 'READY');
  assert.ok(r.warnings.some((w) => /lockfile/.test(w)));
  assert.doesNotMatch(r.execution.reason, /not implemented/);
});
