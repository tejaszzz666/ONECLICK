'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { analyze } = require('../lib/analyzer');
const { buildJob, sanitizeEnv } = require('../lib/sandbox/plan');
const { buildRunArgs, envFileText, parseMarker, parseHostPort, cleanLine } = require('../lib/sandbox/docker');
const { loadConfig } = require('../lib/sandbox/config');
const { createManager } = require('../lib/sandbox/manager');
const { createServer } = require('../server');

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
const analyzeFiles = (files, opts) => analyze('https://github.com/acme/app', { source: fakeSource(files, opts) });
const pkg = (o) => JSON.stringify(o);
const expressApp = { 'package.json': pkg({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }), 'package-lock.json': '{}', 'server.js': '' };

/* ------------------------------ plan ------------------------------ */

test('plan: node app with a start script', async () => {
  const job = buildJob(await analyzeFiles(expressApp), {});
  assert.equal(job.runtime, 'node');
  assert.equal(job.install, 'npm ci');
  assert.equal(job.start, 'npm start');
  assert.equal(job.repoUrl, 'https://github.com/acme/app');
  assert.equal(job.ref, 'main');
  assert.equal(job.staticDir, null);
});

test('plan: vite app is built and served statically', async () => {
  const job = buildJob(await analyzeFiles({ 'package.json': pkg({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }), 'pnpm-lock.yaml': '' }), {});
  assert.equal(job.runtime, 'node');
  assert.equal(job.build, 'pnpm build');
  assert.equal(job.start, null);
  assert.equal(job.staticDir, 'dist');
});

test('plan: python with pip, and static sites', async () => {
  const py = buildJob(await analyzeFiles({ 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': '' }), {});
  assert.equal(py.runtime, 'python');
  assert.equal(py.install, 'pip install -r requirements.txt');
  assert.equal(py.start, 'uvicorn main:app --host 0.0.0.0');
  const st = buildJob(await analyzeFiles({ 'index.html': '<html></html>' }), {});
  assert.equal(st.runtime, 'static');
  assert.equal(st.staticDir, '.');
});

test('plan: unsupported stacks are refused with a reason', async () => {
  const cases = [
    [{ 'package.json': pkg({ name: 'l', main: 'index.js' }), 'index.js': '', 'package-lock.json': '{}' }, /library/i],
    [{ 'package.json': pkg({ dependencies: { express: '4' }, scripts: { start: 'node s.js' } }), 'bun.lockb': '' }, /Bun/],
    [{ 'package.json': pkg({ dependencies: { electron: '30' }, scripts: { start: 'electron .' } }), 'package-lock.json': '{}' }, /Electron/],
    [{ 'go.mod': 'module x\ngo 1.22\n', 'main.go': 'package main' }, /Go projects/],
    [{ 'pyproject.toml': '[tool.poetry]\nname="x"\n', 'main.py': '' }, /poetry/],
    [{ Dockerfile: 'FROM scratch' }, /Dockerfile/],
    [{ 'notes.txt': 'hi' }, /No supported project/],
  ];
  for (const [files, re] of cases) {
    const a = await analyzeFiles(files);
    assert.throws(() => buildJob(a, {}), (e) => e.code === 'unsupported' && re.test(e.message), JSON.stringify(Object.keys(files)));
  }
});

test('plan: hostile refs, paths, commands and sizes are rejected', async () => {
  const a = await analyzeFiles(expressApp);
  const bad = (patch) => buildJob({ ...a, ...patch, repo: { ...a.repo, ...(patch.repo || {}) }, project: { ...a.project, ...(patch.project || {}) } }, {});
  assert.throws(() => bad({ repo: { branch: '--upload-pack=x' } }), { code: 'unsupported' });
  assert.throws(() => bad({ repo: { branch: 'a b' } }), { code: 'unsupported' });
  assert.throws(() => bad({ project: { root: '../etc' } }), { code: 'unsupported' });
  assert.throws(() => bad({ project: { root: 'a b' } }), { code: 'unsupported' });
  assert.throws(() => bad({ repo: { sizeKB: 999999999 } }), { code: 'unsupported' });
  assert.throws(() => bad({ commands: { ...a.commands, start: { cmd: 'npm start\nrm -rf /', source: 'x', confidence: 'declared' } } }), { code: 'unsupported' });
  assert.throws(() => bad({ repo: { url: 'https://evil.com/a/b' } }), { code: 'bad_request' });
});

test('plan: environment variables are validated', () => {
  assert.deepEqual(sanitizeEnv({ API_KEY: 'abc', PORT: '4000' }), { API_KEY: 'abc', PORT: '4000' });
  assert.deepEqual(sanitizeEnv(undefined), {});
  for (const bad of [{ PATH: 'x' }, { ld_preload: 'x' }, { SANDBOX_START: 'x' }, { NODE_OPTIONS: '--require x' }, { GIT_SSH_COMMAND: 'x' }, { 'A B': '1' }, { '1A': '1' }, { A: 'x\ny' }, { A: 5 }, { A: 'x'.repeat(1001) }, { PORT: '8080' }, [], 'x']) {
    assert.throws(() => sanitizeEnv(bad), { code: 'bad_request' }, JSON.stringify(bad));
  }
  assert.throws(() => sanitizeEnv(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, '1']))), { code: 'bad_request' });
});

/* ------------------------------ docker helpers ------------------------------ */

test('docker args: locked down, secrets never in argv', async () => {
  const cfg = loadConfig({});
  const job = buildJob(await analyzeFiles(expressApp), { STRIPE_SECRET: 'sk_live_topsecret' });
  const args = buildRunArgs({ config: cfg, name: 'oneclick-sbx-x', envFilePath: '/tmp/env' });
  const has = (...seq) => args.some((_, i) => seq.every((s, j) => args[i + j] === s));
  assert.ok(has('--cap-drop', 'ALL'));
  assert.ok(has('--security-opt', 'no-new-privileges'));
  assert.ok(args.includes('--read-only'));
  assert.ok(has('-p', '127.0.0.1::8080'));
  assert.ok(has('--memory', '2g', '--memory-swap', '2g'));
  assert.ok(has('--user', '1000:1000'));
  assert.ok(!args.includes('--privileged') && !args.includes('-v') && !args.includes('--volume'));
  assert.equal(args[args.length - 1], 'oneclick-sandbox:latest');
  assert.ok(!args.join(' ').includes('sk_live_topsecret'));
  assert.ok(!args.join(' ').includes('github.com'));
  const envText = envFileText(job, cfg);
  assert.ok(envText.includes('STRIPE_SECRET=sk_live_topsecret\n'));
  assert.ok(envText.includes('SANDBOX_START=npm start\n'));
  assert.ok(buildRunArgs({ config: { ...cfg, network: 'locked' }, name: 'n', envFilePath: 'e' }).includes('locked'));
});

test('markers: only the right token is believed; junk is hidden', () => {
  const t = 'a'.repeat(32);
  assert.deepEqual(parseMarker(`@@ONECLICK@@${t} PHASE install`, t), { type: 'phase', phase: 'install' });
  assert.deepEqual(parseMarker(`@@ONECLICK@@${t} FAIL build exit:2`, t), { type: 'fail', phase: 'build', reason: 'exit:2' });
  assert.deepEqual(parseMarker(`@@ONECLICK@@${t} EXIT 0`, t), { type: 'exit', code: 0 });
  assert.equal(parseMarker(`@@ONECLICK@@${'b'.repeat(32)} PHASE install`, t), null);
  assert.equal(parseMarker('@@ONECLICK@@ PHASE install', t), null);
  assert.equal(parseMarker('hello', t), null);
  assert.deepEqual(parseMarker(`@@ONECLICK@@${t} PHASE bogus`, t), { type: 'unknown' });
});

test('docker helpers: port parsing and log cleaning', () => {
  assert.equal(parseHostPort('127.0.0.1:49153\n'), 49153);
  assert.equal(parseHostPort('[::]:50000\n127.0.0.1:49153\n'), 49153);
  assert.equal(parseHostPort('0.0.0.0:99999'), null);
  assert.equal(parseHostPort('Error: no such container'), null);
  assert.equal(cleanLine('\u001b[31mred\u001b[0m\u0007 ok'), 'red ok');
  assert.equal(cleanLine('x'.repeat(900)).length, 500);
});

/* ------------------------------ manager (fake docker) ------------------------------ */

function fakeDocker() {
  const f = { children: [], calls: [], port: '127.0.0.1:49153\n', probeResult: true };
  f.exec = async (args) => {
    f.calls.push(args);
    if (args[0] === 'version') return { code: f.dockerDown ? 1 : 0, stdout: '27.0.0\n', stderr: '' };
    if (args[0] === 'image') return { code: f.noImage ? 1 : 0, stdout: 'sha256:x', stderr: '' };
    if (args[0] === 'port') return { code: 0, stdout: f.port, stderr: '' };
    if (args[0] === 'stop') {
      const c = f.children[f.children.length - 1];
      if (c) setImmediate(() => c.exit(143));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  f.spawnRun = (args) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.stdinData = '';
    c.stdin = new PassThrough();
    c.stdin.on('data', (d) => (c.stdinData += d));
    c.args = args;
    c.exit = (code) => setImmediate(() => c.emit('close', code));
    c.kill = () => c.exit(143);
    f.children.push(c);
    return c;
  };
  f.probe = async () => f.probeResult;
  return f;
}

const quick = { ...loadConfig({}), ttlSec: 30, readySec: 30 };
const mk = (f, cfg = quick) => createManager(cfg, { exec: f.exec, spawnRun: f.spawnRun, probe: f.probe, analyze: (u) => analyzeFiles(expressApp), probeMs: 5, portPollMs: 5 });
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting');
};

test('manager: happy path reaches ready, then stops cleanly', async () => {
  const f = fakeDocker();
  const m = mk(f);
  const snap = await m.start({ url: 'https://github.com/acme/app', env: { API_KEY: 'k' } });
  assert.equal(snap.status, 'starting');
  assert.equal(snap.previewUrl, null);
  const child = f.children[0];
  const token = child.stdinData.trim();
  assert.match(token, /^[0-9a-f]{32}$/);
  child.stdout.write(`@@ONECLICK@@${token} PHASE install\nnpm ci output\n@@ONECLICK@@${token} PHASE start\n`);
  const ready = await until(() => (m.get(snap.id).ready ? m.get(snap.id) : null));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.previewUrl, 'http://127.0.0.1:49153/');
  assert.equal(ready.phase, 'start');
  assert.ok(ready.logs.lines.includes('npm ci output'));
  assert.ok(!ready.logs.lines.some((l) => l.includes('@@ONECLICK@@')));
  const end = await m.stop(snap.id);
  assert.equal(end.status, 'stopped');
  assert.ok(f.calls.some((c) => c[0] === 'stop'));
  await m.shutdown();
});

test('manager: spoofed markers cannot fake readiness or hide failure', async () => {
  const f = fakeDocker();
  f.probeResult = false; // nothing is really listening
  const m = mk(f);
  const snap = await m.start({ url: 'https://github.com/acme/app' });
  const child = f.children[0];
  child.stdout.write(`@@ONECLICK@@${'0'.repeat(32)} PHASE start\n@@ONECLICK@@${'0'.repeat(32)} EXIT 0\nready on 3000\n`);
  await until(() => m.get(snap.id).logs.lines.includes('ready on 3000'));
  const s = m.get(snap.id);
  assert.equal(s.ready, false);
  assert.notEqual(s.status, 'ready');
  assert.equal(s.phase, null);
  assert.ok(s.logs.lines.some((l) => l.includes('@@ONECLICK@@'))); // shown as plain, untrusted output
  child.exit(1);
  const done = await until(() => (m.get(snap.id).status === 'failed' ? m.get(snap.id) : null));
  assert.equal(done.exitCode, 1);
  await m.shutdown();
});

test('manager: failure marker becomes a readable error', async () => {
  const f = fakeDocker();
  const m = mk(f);
  const snap = await m.start({ url: 'https://github.com/acme/app' });
  const child = f.children[0];
  const token = child.stdinData.trim();
  child.stdout.write(`@@ONECLICK@@${token} PHASE install\n@@ONECLICK@@${token} FAIL install exit:1\n`);
  child.exit(1);
  const s = await until(() => (m.get(snap.id).status === 'failed' ? m.get(snap.id) : null));
  assert.match(s.error.message, /install step failed \(exit code 1\)/);
  const t = await m.start({ url: 'https://github.com/acme/app' });
  const c2 = f.children[1];
  c2.stdout.write(`@@ONECLICK@@${c2.stdinData.trim()} FAIL build timeout\n`);
  c2.exit(124);
  const s2 = await until(() => (m.get(t.id).status === 'failed' ? m.get(t.id) : null));
  assert.match(s2.error.message, /build step timed out/);
  await m.shutdown();
});

test('manager: exit before listening, and out-of-memory, are explained', async () => {
  const f = fakeDocker();
  f.probeResult = false;
  const m = mk(f);
  const a = await m.start({ url: 'https://github.com/acme/app' });
  f.children[0].exit(0);
  assert.equal((await until(() => (m.get(a.id).status === 'failed' ? m.get(a.id) : null))).error.code, 'exited_early');
  const b = await m.start({ url: 'https://github.com/acme/app' });
  f.children[1].exit(137);
  assert.match((await until(() => (m.get(b.id).status === 'failed' ? m.get(b.id) : null))).error.message, /memory limit/);
  await m.shutdown();
});

test('manager: limits, docker availability, and validation', async () => {
  const f = fakeDocker();
  const m = mk(f, { ...quick, maxRuns: 1 });
  const first = await m.start({ url: 'https://github.com/acme/app' });
  await assert.rejects(m.start({ url: 'https://github.com/acme/app' }), { code: 'busy' });
  await m.stop(first.id);
  await assert.rejects(m.start({ url: '' }), { code: 'bad_request' });
  await assert.rejects(m.start({ url: 'https://github.com/acme/app', env: { PATH: 'x' } }), { code: 'bad_request' });
  assert.throws(() => m.get('nope-nope'), { code: 'not_found' });

  const down = fakeDocker();
  down.dockerDown = true;
  await assert.rejects(mk(down).start({ url: 'https://github.com/acme/app' }), { code: 'docker_unavailable' });
  const noimg = fakeDocker();
  noimg.noImage = true;
  await assert.rejects(mk(noimg).start({ url: 'https://github.com/acme/app' }), { code: 'image_missing' });
  await m.shutdown();
});

test('manager: runs are stopped when their time limit passes', async () => {
  const f = fakeDocker();
  const m = mk(f, { ...quick, ttlSec: 0.05 });
  const snap = await m.start({ url: 'https://github.com/acme/app' });
  const s = await until(() => (m.get(snap.id).status === 'timeout' ? m.get(snap.id) : null));
  assert.equal(s.error.code, 'timeout');
  await m.shutdown();
});

/* ------------------------------ server guard ------------------------------ */

function call(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(opts, fn) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn(srv.address().port);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

test('server: sandbox is off by default', async () => {
  await withServer({ sandboxConfig: loadConfig({}) }, async (port) => {
    const r = await call(port, { path: '/api/sandbox/status', headers: { Host: `localhost:${port}` } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'sandbox_disabled');
    const h = await call(port, { path: '/api/health' });
    assert.equal(h.json.execution, false);
  });
  // enabled flag without a long enough token stays off
  assert.equal(loadConfig({ SANDBOX_ENABLED: '1', SANDBOX_TOKEN: 'short' }).enabled, false);
});

test('server: host, origin and token checks guard the sandbox API', async () => {
  const token = 't'.repeat(24);
  const cfg = loadConfig({ SANDBOX_ENABLED: '1', SANDBOX_TOKEN: token, SANDBOX_ALLOWED_ORIGINS: 'http://localhost:5173' });
  const started = [];
  const fakeManager = {
    info: async () => ({ docker: { available: true } }),
    start: async (x) => (started.push(x), { id: 'run123456', status: 'starting' }),
    get: (id, since) => ({ id, since }),
    stop: async (id) => ({ id, status: 'stopped' }),
    shutdown: async () => {},
  };
  await withServer({ sandboxConfig: cfg, sandboxManager: fakeManager }, async (port) => {
    const good = { Host: `localhost:${port}`, Authorization: `Bearer ${token}` };
    assert.equal((await call(port, { path: '/api/sandbox/status', headers: good })).status, 200);
    assert.equal((await call(port, { path: '/api/sandbox/status', headers: { Host: `localhost:${port}` } })).status, 401);
    assert.equal((await call(port, { path: '/api/sandbox/status', headers: { ...good, Authorization: 'Bearer wrong' } })).status, 401);
    // DNS rebinding: attacker's hostname pointing at 127.0.0.1
    const rebinding = await call(port, { path: '/api/sandbox/status', headers: { ...good, Host: `evil.example:${port}` } });
    assert.equal(rebinding.status, 403);
    assert.equal(rebinding.json.error.code, 'forbidden_host');
    // another website in a browser
    const evil = await call(port, { path: '/api/sandbox/status', headers: { ...good, Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers['access-control-allow-origin'], undefined);
    const allowed = await call(port, { path: '/api/sandbox/status', headers: { ...good, Origin: 'http://localhost:5173' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
    const pre = await call(port, { method: 'OPTIONS', path: '/api/sandbox/runs', headers: { Host: `localhost:${port}`, Origin: 'http://localhost:5173' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers['access-control-allow-headers'], /Authorization/);

    const post = await call(port, { method: 'POST', path: '/api/sandbox/runs', headers: good, body: JSON.stringify({ url: 'https://github.com/a/b', env: { K: 'v' } }) });
    assert.equal(post.status, 202);
    assert.deepEqual(started[0], { url: 'https://github.com/a/b', env: { K: 'v' } });
    assert.equal((await call(port, { method: 'POST', path: '/api/sandbox/runs', headers: good, body: '[1]' })).status, 400);
    assert.equal((await call(port, { method: 'POST', path: '/api/sandbox/runs', headers: good, body: 'nope' })).status, 400);
    assert.equal((await call(port, { path: '/api/sandbox/runs/run123456?since=5', headers: good })).json.since, 5);
    assert.equal((await call(port, { method: 'DELETE', path: '/api/sandbox/runs/run123456', headers: good })).json.status, 'stopped');
    assert.equal((await call(port, { path: '/api/sandbox/runs/..%2F..', headers: good })).status, 404);
    // the public analyze API keeps its permissive CORS and is unaffected
    assert.equal((await call(port, { path: '/api/health' })).headers['access-control-allow-origin'], '*');
  });
});
