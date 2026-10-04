'use strict';

// Sandbox configuration, read from environment variables.
//   SANDBOX_ENABLED=1        turn the sandbox API on (also needs SANDBOX_TOKEN)
//   SANDBOX_TOKEN            bearer token, at least 16 characters
//   SANDBOX_IMAGE            default oneclick-sandbox:latest
//   SANDBOX_DOCKER           docker binary, default "docker"
//   SANDBOX_NETWORK          optional docker network name (e.g. one with egress filtering)
//   SANDBOX_MEMORY (2g)  SANDBOX_CPUS (1)  SANDBOX_PIDS (512)  SANDBOX_MAX_RUNS (2)
//   SANDBOX_TTL_SEC (900)    SANDBOX_READY_TIMEOUT_SEC (300)
//   SANDBOX_ALLOWED_HOSTS    comma list of extra Host header values (no port)
//   SANDBOX_ALLOWED_ORIGINS  comma list of browser origins allowed to call the API

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const int = (name, def, min, max) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
  };
  const token = env.SANDBOX_TOKEN || '';
  const requested = env.SANDBOX_ENABLED === '1';
  const cpus = Number(env.SANDBOX_CPUS);
  return {
    requested,
    enabled: requested && token.length >= 16,
    token,
    docker: env.SANDBOX_DOCKER || 'docker',
    image: env.SANDBOX_IMAGE || 'oneclick-sandbox:latest',
    network: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(env.SANDBOX_NETWORK || '') ? env.SANDBOX_NETWORK : '',
    memory: /^\d{2,5}[mg]$/i.test(env.SANDBOX_MEMORY || '') ? env.SANDBOX_MEMORY.toLowerCase() : '2g',
    cpus: Number.isFinite(cpus) && cpus >= 0.25 && cpus <= 8 ? String(cpus) : '1',
    pids: int('SANDBOX_PIDS', 512, 64, 4096),
    maxRuns: int('SANDBOX_MAX_RUNS', 2, 1, 10),
    ttlSec: int('SANDBOX_TTL_SEC', 900, 60, 7200),
    readySec: int('SANDBOX_READY_TIMEOUT_SEC', 300, 30, 1800),
    cloneSec: 120,
    installSec: 600,
    buildSec: 600,
    maxRepoKB: 204800,
    allowedHosts: list(env.SANDBOX_ALLOWED_HOSTS),
    allowedOrigins: String(env.SANDBOX_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

module.exports = { loadConfig };
