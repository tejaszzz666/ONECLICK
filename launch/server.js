'use strict';

// ONECLICK Launch API. Zero dependencies. Analyzes public GitHub repositories;
// it never clones, installs, builds or runs repository code.
//
//   GET  /api/health
//   POST /api/analyze          body: {"url": "..."}  -> JSON report
//   GET  /api/analyze/stream?url=...                 -> Server-Sent Events
//
// Env: PORT (8787), HOST (127.0.0.1), GITHUB_TOKEN (optional, raises rate limit),
//      CORS_ORIGIN (default "*"), RATE_LIMIT_PER_MIN (default 20)

const http = require('http');
const { analyze, AnalysisError } = require('./lib/analyzer');
const { createGithubSource } = require('./lib/github');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
const MAX_BODY = 4096;
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
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  return list.length > LIMIT;
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
  if (e instanceof AnalysisError) return { status: STATUS_BY_CODE[e.code] || 500, body: { error: { code: e.code, message: e.message, resetAt: e.resetAt || null } } };
  console.error(e);
  return { status: 500, body: { error: { code: 'internal', message: 'Unexpected server error.' } } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
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

async function handle(req, res) {
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

  const url = new URL(req.url, 'http://localhost');
  const remote = req.socket.remoteAddress || 'unknown';
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = fwd || remote;

  if (url.pathname === '/' && req.method === 'GET') {
    return send(res, 200, { service: 'oneclick-launch', endpoints: ['/api/health', 'POST /api/analyze', '/api/analyze/stream?url='] });
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'oneclick-launch', execution: false });
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

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: 'Unexpected server error.' } });
      else res.end();
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => console.log(`Launch API listening on http://${HOST}:${PORT}`));
}

module.exports = { createServer };
