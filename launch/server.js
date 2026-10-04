'use strict';

// ONECLICK Launch API. Zero dependencies.
//
//   GET  /api/health
//   POST /api/analyze          body: {"url": "..."}  -> JSON report (never runs repository code)
//   GET  /api/analyze/stream?url=...                 -> Server-Sent Events
//
// Optional sandbox (off by default; needs Docker, see sandbox/README.md). Repository code only
// ever runs inside a locked-down container, never in this process.
//   GET    /api/sandbox/status
//   POST   /api/sandbox/runs          body: {"url": "...", "env": {"NAME": "value"}}
//   GET    /api/sandbox/runs/:id?since=N
//   DELETE /api/sandbox/runs/:id
//
// Env: PORT (8787), HOST (127.0.0.1), GITHUB_TOKEN (optional, raises rate limit),
//      CORS_ORIGIN (default "*"), RATE_LIMIT_PER_MIN (default 20),
//      SANDBOX_* (see lib/sandbox/config.js)

const http = require('http');
const { analyze, AnalysisError } = require('./lib/analyzer');
const { createGithubSource } = require('./lib/github');
const { SandboxError, SANDBOX_STATUS } = require('./lib/sandbox/errors');
const { loadConfig } = require('./lib/sandbox/config');
const { createGuard } = require('./lib/sandbox/guard');
const { createManager } = require('./lib/sandbox/manager');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
const SANDBOX_LIMIT = Number(process.env.SANDBOX_RATE_LIMIT_PER_MIN) || 5;
const MAX_BODY = 4096;
const MAX_SANDBOX_BODY = 32768;
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set behind Render/other proxies so rate limits see the real client IP

const STATUS_BY_CODE = {
  invalid_url: 400,
  not_found: 404,
  private_repo: 403,
  forbidden: 403,
  empty: 422,
  rate_limited: 429,
  network: 502,
  github_error: 502,
  aborted: 499,
};

const hits = new Map();
function limited(ip, limit = LIMIT) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  return list.length > limit;
}

function send(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(data);
}

function errorBody(e) {
  if (e instanceof SandboxError) return { status: SANDBOX_STATUS[e.code] || 500, body: { error: { code: e.code, message: e.message } } };
  if (e instanceof AnalysisError) return { status: STATUS_BY_CODE[e.code] || 500, body: { error: { code: e.code, message: e.message, resetAt: e.resetAt || null } } };
  console.error(e);
  return { status: 500, body: { error: { code: 'internal', message: 'Unexpected server error.' } } };
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('too large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientSignal(req, res) {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac.signal;
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || 'unknown';
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || remote;
}

async function handleSandbox(req, res, url, ctx) {
  const { guard } = ctx;
  const cors = guard.corsHeaders(req);
  const reply = (status, body, extra) => send(res, status, body, { ...cors, 'X-Content-Type-Options': 'nosniff', ...extra });
  try {
    guard.checkEnabled();
    guard.checkHost(req);
    guard.checkOrigin(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    guard.checkToken(req);
    const manager = ctx.getManager();

    if (url.pathname === '/api/sandbox/status' && req.method === 'GET') {
      return reply(200, { enabled: true, ...(await manager.info()) });
    }

    const m = url.pathname.match(/^\/api\/sandbox\/runs(?:\/([A-Za-z0-9_-]{6,32}))?$/);
    if (m && !m[1] && req.method === 'POST') {
      if (limited('sbx:' + clientIp(req), SANDBOX_LIMIT)) {
        return reply(429, { error: { code: 'rate_limited', message: 'Too many sandbox runs. Try again in a minute.' } }, { 'Retry-After': '60' });
      }
      let body;
      try {
        body = JSON.parse((await readBody(req, MAX_SANDBOX_BODY)) || '{}');
      } catch (e) {
        return reply(e.code === 'too_large' ? 413 : 400, { error: { code: 'bad_request', message: e.code === 'too_large' ? 'Request body too large.' : 'Body must be JSON: {"url": "...", "env": {...}}.' } });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SandboxError('bad_request', 'Body must be a JSON object.');
      return reply(202, await manager.start({ url: body.url, env: body.env }));
    }
    if (m && m[1] && req.method === 'GET') {
      return reply(200, manager.get(m[1], Number(url.searchParams.get('since')) || 0));
    }
    if (m && m[1] && req.method === 'DELETE') {
      return reply(200, await manager.stop(m[1]));
    }
    return reply(404, { error: { code: 'not_found', message: 'Not found.' } });
  } catch (e) {
    const { status, body } = errorBody(e);
    return reply(status, body);
  }
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/sandbox/') || url.pathname === '/api/sandbox') {
    return handleSandbox(req, res, url, ctx); // has its own, strict CORS handling
  }

  const cors = {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
  };
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const ip = clientIp(req);

  if (url.pathname === '/' && req.method === 'GET') {
    return send(res, 200, { service: 'oneclick-launch', endpoints: ['/api/health', 'POST /api/analyze', '/api/analyze/stream?url=', ...(ctx.sandboxConfig.enabled ? ['/api/sandbox/status', 'POST /api/sandbox/runs'] : [])] });
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'oneclick-launch', execution: ctx.sandboxConfig.enabled, sandbox: ctx.sandboxConfig.enabled });
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    if (limited(ip)) return send(res, 429, { error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } }, { 'Retry-After': '60' });
    let input;
    try {
      const raw = await readBody(req);
      input = JSON.parse(raw || '{}').url;
    } catch (e) {
      return send(res, e.code === 'too_large' ? 413 : 400, { error: { code: 'bad_request', message: e.code === 'too_large' ? 'Request body too large.' : 'Body must be JSON: {"url": "..."}.' } });
    }
    const signal = clientSignal(req, res);
    try {
      const source = createGithubSource({ token: process.env.GITHUB_TOKEN, signal });
      const result = await analyze(input, { source, signal });
      return send(res, 200, result);
    } catch (e) {
      const { status, body } = errorBody(e);
      return send(res, status, body);
    }
  }

  if (url.pathname === '/api/analyze/stream' && req.method === 'GET') {
    if (limited(ip)) return send(res, 429, { error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } }, { 'Retry-After': '60' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const signal = clientSignal(req, res);
    try {
      const source = createGithubSource({ token: process.env.GITHUB_TOKEN, signal });
      const result = await analyze(url.searchParams.get('url'), { source, signal, emit: (ev) => write(ev.type, ev) });
      write('result', result);
    } catch (e) {
      write('error', errorBody(e).body.error);
    }
    return res.end();
  }

  return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
}

function createServer(opts = {}) {
  const sandboxConfig = opts.sandboxConfig || loadConfig(process.env);
  const guard = createGuard(sandboxConfig);
  let manager = opts.sandboxManager || null;
  const getManager = () =>
    manager ||
    (manager = createManager(sandboxConfig, {
      analyze: (u) => analyze(u, { source: createGithubSource({ token: process.env.GITHUB_TOKEN }) }),
    }));
  const ctx = { sandboxConfig, guard, getManager };

  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: 'Unexpected server error.' } });
      else res.end();
    });
  });
  server.shutdownSandbox = () => (manager ? manager.shutdown() : Promise.resolve());
  return server;
}

if (require.main === module) {
  const server = createServer();
  const cfg = loadConfig(process.env);
  server.listen(PORT, HOST, () => {
    console.log(`Launch API listening on http://${HOST}:${PORT}`);
    if (cfg.enabled) console.log(`Sandbox enabled (image ${cfg.image}, max ${cfg.maxRuns} runs, ${cfg.ttlSec}s each)`);
    else if (cfg.requested) console.warn('SANDBOX_ENABLED=1 ignored: SANDBOX_TOKEN must be set to at least 16 characters.');
  });
  const stopAll = () => {
    server.shutdownSandbox().finally(() => process.exit(0));
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);
}

module.exports = { createServer };
