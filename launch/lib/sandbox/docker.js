'use strict';

// Pure helpers for talking to docker: argument building, marker parsing, port parsing.

const PHASES = new Set(['setup', 'clone', 'install', 'build', 'start']);

const containerName = (id) => `oneclick-sbx-${id}`;

// Job data goes in an env file (never argv, never the host's own environment), so secrets stay
// out of process listings and cannot collide with variables docker itself reads.
function envFileText(job, cfg) {
  const lines = [
    ['SANDBOX_REPO', job.repoUrl],
    ['SANDBOX_REF', job.ref],
    ['SANDBOX_ROOT', job.root],
    ['SANDBOX_RUNTIME', job.runtime],
    ['SANDBOX_INSTALL', job.install || ''],
    ['SANDBOX_BUILD', job.build || ''],
    ['SANDBOX_START', job.start || ''],
    ['SANDBOX_STATIC_DIR', job.staticDir || ''],
    ['SANDBOX_CLONE_TIMEOUT', String(cfg.cloneSec)],
    ['SANDBOX_INSTALL_TIMEOUT', String(cfg.installSec)],
    ['SANDBOX_BUILD_TIMEOUT', String(cfg.buildSec)],
    ...Object.entries(job.env || {}),
  ];
  return lines.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

function buildRunArgs({ config, name, envFilePath }) {
  const args = [
    'run', '--rm', '-i', '--init',
    '--name', name,
    '--label', 'oneclick.sandbox=1',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--pids-limit', String(config.pids),
    '--memory', config.memory,
    '--memory-swap', config.memory,
    '--cpus', config.cpus,
    '--ulimit', 'nofile=4096:4096',
    '--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000',
    '--tmpfs', '/home/node:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m',
    '-p', '127.0.0.1::8080',
    '--env-file', envFilePath,
  ];
  if (config.network) args.push('--network', config.network);
  args.push(config.image);
  return args;
}

function parseMarker(line, token) {
  const prefix = `@@ONECLICK@@${token} `;
  if (typeof line !== 'string' || !line.startsWith(prefix)) return null;
  const parts = line.slice(prefix.length).trim().split(/\s+/);
  if (parts[0] === 'PHASE' && PHASES.has(parts[1])) return { type: 'phase', phase: parts[1] };
  if (parts[0] === 'FAIL' && PHASES.has(parts[1]) && /^[a-z_:0-9]{1,40}$/.test(parts[2] || '')) return { type: 'fail', phase: parts[1], reason: parts[2] };
  if (parts[0] === 'EXIT' && /^\d{1,3}$/.test(parts[1] || '')) return { type: 'exit', code: Number(parts[1]) };
  return { type: 'unknown' }; // carries a valid token but is meaningless: hide it, don't log it
}

// `docker port <name> 8080/tcp` prints lines like "127.0.0.1:49153".
function parseHostPort(out) {
  let fallback = null;
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/);
    if (!m) continue;
    const port = Number(m[2]);
    if (port < 1 || port > 65535) continue;
    if (m[1] === '127.0.0.1') return port;
    fallback = fallback || port;
  }
  return fallback;
}

function cleanLine(line) {
  return String(line)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, 500);
}

module.exports = { PHASES, containerName, envFileText, buildRunArgs, parseMarker, parseHostPort, cleanLine };
