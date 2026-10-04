'use strict';

// Turns an analysis result into a sandbox job. Everything that ends up in the container
// is validated here; the container re-validates it (sandbox/run.sh).
// The client only ever supplies a repository URL and optional env vars. The analysis is
// always recomputed on the server, never accepted from the client.

const { SandboxError } = require('./errors');
const { parseRepoUrl } = require('../url');

const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const SEG_RE = /^(?!\.{1,2}$)(?!-)[A-Za-z0-9._-]{1,100}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_RE = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|IFS|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|PS[0-9]|PROMPT_COMMAND|TERM|HOSTNAME|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|PYTHON.*|PIP_.*|COREPACK_.*|VIRTUAL_ENV|SSL_CERT_.*|LD_.*|DYLD_.*|GIT_.*|SANDBOX_.*|DOCKER_.*|NPM_CONFIG_.*|BROWSER)$/i;
const MAX_ENV_VARS = 20;
const MAX_ENV_VALUE = 1000;

const unsupported = (m) => new SandboxError('unsupported', m);

function sanitizeEnv(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new SandboxError('bad_request', 'env must be an object of NAME: value strings.');
  const entries = Object.entries(input);
  if (entries.length > MAX_ENV_VARS) throw new SandboxError('bad_request', `At most ${MAX_ENV_VARS} environment variables are allowed.`);
  const out = {};
  for (const [name, value] of entries) {
    if (!NAME_RE.test(name)) throw new SandboxError('bad_request', `Invalid environment variable name: ${name.slice(0, 40)}`);
    if (RESERVED_RE.test(name)) throw new SandboxError('bad_request', `${name} is reserved and cannot be set.`);
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE || /[\u0000\r\n]/.test(value)) {
      throw new SandboxError('bad_request', `The value of ${name} must be a single-line string of at most ${MAX_ENV_VALUE} characters.`);
    }
    if (name === 'PORT' && value.trim() === '8080') throw new SandboxError('bad_request', 'PORT cannot be 8080; that port is used by the sandbox bridge.');
    out[name] = value;
  }
  return out;
}

function safeDir(p) {
  if (p === undefined || p === null || p === '' || p === '.') return '.';
  const segs = String(p).split('/');
  if (segs.length > 6 || !segs.every((s) => SEG_RE.test(s))) throw unsupported('This project path contains characters the sandbox does not accept.');
  return segs.join('/');
}

function safeCmd(label, cmd) {
  if (typeof cmd !== 'string' || !/^[\x20-\x7e]{1,300}$/.test(cmd)) {
    throw unsupported(`The detected ${label} command contains characters the sandbox does not accept.`);
  }
  return cmd;
}

function buildJob(a, userEnv, { maxRepoKB = 204800 } = {}) {
  const env = sanitizeEnv(userEnv);
  if (!a || !a.repo || !a.project) throw new SandboxError('bad_request', 'Invalid analysis result.');
  const parsed = parseRepoUrl(a.repo.url);
  if (!parsed.ok) throw new SandboxError('bad_request', parsed.error);
  const ref = a.repo.branch;
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw unsupported('This branch name is not supported by the sandbox.');
  if (a.repo.sizeKB > maxRepoKB) throw unsupported(`This repository is too large for the sandbox (limit ${Math.round(maxRepoKB / 1024)} MB).`);
  if (a.status === 'UNKNOWN' || a.status === 'LIBRARY') throw unsupported(a.statusReason);

  const base = { repoUrl: parsed.canonical, ref, root: safeDir(a.project.root), env, install: null, build: null, start: null, staticDir: null };
  const cmd = (c, label) => (c && c.cmd ? safeCmd(label, c.cmd) : null);
  const cmds = a.commands || {};

  if (a.runtime === 'Node.js') {
    if (a.framework && a.framework.name === 'Electron') throw unsupported('Electron desktop apps cannot run in a headless sandbox.');
    const pm = a.packageManager && a.packageManager.name;
    if (pm === 'bun') throw unsupported('Bun is not installed in the sandbox image (npm, pnpm and yarn are).');
    const job = { ...base, runtime: 'node', install: cmd(cmds.install, 'install'), build: cmd(cmds.build, 'build') };
    if (cmds.start) job.start = cmd(cmds.start, 'start');
    else if (a.staticOutput && job.build) job.staticDir = safeDir(a.staticOutput);
    else throw unsupported('No start command or static build output was detected.');
    return job;
  }

  if (a.runtime === 'Python') {
    const pm = a.packageManager && a.packageManager.name;
    if (pm !== 'pip') throw unsupported(`${pm || 'This package manager'} is not installed in the sandbox image (pip is).`);
    if (!cmds.start) throw unsupported('No start command was detected for this Python project.');
    return { ...base, runtime: 'python', install: cmd(cmds.install, 'install'), start: cmd(cmds.start, 'start') };
  }

  if (!a.runtime && a.projectType === 'Static site') {
    return { ...base, runtime: 'static', staticDir: safeDir(a.staticOutput || '.') };
  }

  if (!a.runtime) throw unsupported('Projects that only ship a Dockerfile are not supported; the sandbox does not run nested containers.');
  throw unsupported(`${a.runtime} projects are not supported by this sandbox image yet (supported: Node.js, Python with pip, static sites).`);
}

module.exports = { buildJob, sanitizeEnv, safeDir };
