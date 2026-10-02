'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/analyzer');
const { parseRepoUrl } = require('../lib/url');

// In-memory stand-in for GitHub: files is { path: text }.
function fakeSource(files, { branch = 'main', meta = {} } = {}) {
  return {
    async getRepo(owner, repo) {
      return { name: repo, private: false, archived: false, fork: false, defaultBranch: branch, description: null, sizeKB: 10, ...meta };
    },
    async getTree() {
      return { files: Object.entries(files).map(([path, t]) => ({ path, size: t.length })), truncated: false };
    },
    async getFile(o, r, ref, path) {
      return path in files ? files[path] : null;
    },
  };
}
const run = (files, opts) => analyze('https://github.com/acme/app', { source: fakeSource(files, opts) });

test('url: parses and rejects', () => {
  assert.equal(parseRepoUrl('github.com/a/b.git').repo, 'b');
  assert.equal(parseRepoUrl('https://github.com/a/b/tree/dev').ref, 'dev');
  assert.equal(parseRepoUrl('https://evil.com/a/b').ok, false);
  assert.equal(parseRepoUrl('https://user:pw@github.com/a/b').ok, false);
  assert.equal(parseRepoUrl('https://github.com/a').ok, false);
  assert.equal(parseRepoUrl(42).ok, false);
});

test('node: express app with start script and env vars', async () => {
  const r = await run({
    'package.json': JSON.stringify({ name: 'x', dependencies: { express: '4' }, scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}',
    'server.js': 'const p = process.env.PORT; const k = process.env.API_KEY;',
    '.env.example': 'DATABASE_URL=\nAPI_KEY=abc\n',
  });
  assert.equal(r.runtime, 'Node.js');
  assert.equal(r.framework.name, 'Express');
  assert.equal(r.commands.install.cmd, 'npm ci');
  assert.equal(r.commands.start.cmd, 'npm start');
  assert.equal(r.status, 'READY');
  const names = r.env.vars.map((v) => v.name);
  assert.ok(names.includes('DATABASE_URL') && names.includes('API_KEY') && names.includes('PORT'));
  assert.equal(r.execution.available, false);
});

test('node: vite app is a static build, not a start command', async () => {
  const r = await run({
    'package.json': JSON.stringify({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }),
    'pnpm-lock.yaml': '',
  });
  assert.equal(r.framework.name, 'Vite + React');
  assert.equal(r.staticOutput, 'dist');
  assert.equal(r.commands.start, null);
  assert.equal(r.status, 'READY');
});

test('python: fastapi', async () => {
  const r = await run({ 'requirements.txt': 'fastapi==0.1\nuvicorn\n', 'main.py': 'import os\nos.environ.get("TOKEN")' });
  assert.equal(r.framework.name, 'FastAPI');
  assert.equal(r.commands.start.cmd, 'uvicorn main:app --host 0.0.0.0');
  assert.equal(r.commands.start.confidence, 'inferred');
  assert.ok(r.env.vars.some((v) => v.name === 'TOKEN'));
});

test('dotnet: csproj at repo root', async () => {
  const r = await run({
    'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    'Program.cs': 'var x = Environment.GetEnvironmentVariable("CONN");',
  });
  assert.equal(r.runtime, '.NET');
  assert.equal(r.framework.name, 'ASP.NET Core');
  assert.equal(r.runtimeVersion.value, 'net8.0');
  assert.equal(r.commands.start.cmd, 'dotnet run');
  assert.equal(r.project.root, '.');
  assert.ok(!r.warnings.some((w) => /subdirectory/.test(w)));
  assert.ok(r.env.vars.some((v) => v.name === 'CONN'));
});

test('dotnet: csproj in a subdirectory uses relative paths', async () => {
  const r = await run({
    'src/Web/Web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    'src/Web/Program.cs': '// hi',
  });
  assert.equal(r.runtime, '.NET');
  assert.equal(r.project.root, 'src/Web');
  assert.equal(r.framework.name, 'ASP.NET Core');
  assert.ok(r.warnings.some((w) => w.includes('src/Web')));
  assert.deepEqual(r.packageFiles, ['src/Web/Web.csproj']);
});

test('manifest at root does not log "no manifest found"', async () => {
  const logs = [];
  await analyze('https://github.com/acme/app', {
    source: fakeSource({ 'go.mod': 'module x\ngo 1.22\n', 'main.go': 'package main' }),
    emit: (e) => e.type === 'log' && logs.push(e.msg),
  });
  assert.ok(!logs.some((m) => /No supported project manifest/.test(m)));
});

test('static site and unknown repos', async () => {
  const s = await run({ 'index.html': '<html></html>' });
  assert.equal(s.projectType, 'Static site');
  assert.equal(s.status, 'READY');
  const u = await run({ 'notes.txt': 'hello' });
  assert.equal(u.status, 'UNKNOWN');
});

test('private repo and bad url are rejected', async () => {
  await assert.rejects(analyze('https://github.com/a/b', { source: fakeSource({ 'a': 'b' }, { meta: { private: true } }) }), { code: 'private_repo' });
  await assert.rejects(analyze('nope', { source: fakeSource({}) }), { code: 'invalid_url' });
});

test('server: health, 404 and invalid url (no network needed)', async () => {
  const { createServer } = require('../server');
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/nope')).status, 404);
    const bad = await fetch(base + '/api/analyze', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/a/b' }) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'invalid_url');
    const notJson = await fetch(base + '/api/analyze', { method: 'POST', body: 'x' });
    assert.equal(notJson.status, 400);
  } finally {
    srv.close();
  }
});
