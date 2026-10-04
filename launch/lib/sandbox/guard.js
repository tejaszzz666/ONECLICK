'use strict';

// Request guard for /api/sandbox/*. Order matters: enabled -> Host -> Origin -> token.
//  - Host allow-list defeats DNS-rebinding (a hostile page resolving its own name to 127.0.0.1).
//  - Origin allow-list stops other websites from driving the API through a visitor's browser.
//  - Bearer token (constant-time compare) authenticates everything else.

const crypto = require('crypto');
const { SandboxError } = require('./errors');

const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function hostName(h) {
  h = String(h || '').toLowerCase().trim();
  if (h.startsWith('[')) {
    const i = h.indexOf(']');
    return i > 0 ? h.slice(0, i + 1) : '';
  }
  return h.replace(/:\d+$/, '');
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createGuard(config) {
  const hosts = new Set([...DEFAULT_HOSTS, ...(config.allowedHosts || [])]);
  const origins = new Set(config.allowedOrigins || []);

  return {
    checkEnabled() {
      if (!config.enabled) {
        throw new SandboxError('sandbox_disabled', 'The sandbox is disabled. Set SANDBOX_ENABLED=1 and SANDBOX_TOKEN (16+ characters) to enable it.');
      }
    },
    checkHost(req) {
      if (!hosts.has(hostName(req.headers.host))) throw new SandboxError('forbidden_host', 'Host not allowed.');
    },
    checkOrigin(req) {
      const o = req.headers.origin;
      if (o !== undefined && !origins.has(o)) throw new SandboxError('forbidden_origin', 'Origin not allowed.');
    },
    checkToken(req) {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
      const ok = crypto.timingSafeEqual(sha(m ? m[1] : ''), sha(config.token));
      if (!m || !ok) throw new SandboxError('unauthorized', 'Missing or invalid token.');
    },
    corsHeaders(req) {
      const o = req.headers.origin;
      if (o === undefined || !origins.has(o)) return {};
      return { 'Access-Control-Allow-Origin': o, Vary: 'Origin' };
    },
  };
}

module.exports = { createGuard };
