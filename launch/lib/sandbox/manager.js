'use strict';

// Run manager: starts one locked-down docker container per run, tracks its state and logs,
// detects readiness by probing the published port from the host (never by trusting log lines),
// and stops everything on timeout or shutdown.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { SandboxError } = require('./errors');
const { buildJob, sanitizeEnv } = require('./plan');
const { containerName, envFileText, buildRunArgs, parseMarker, parseHostPort, cleanLine } = require('./docker');

const MAX_LOG_LINES = 2000;
const KEEP_FINISHED_MS = 30 * 60 * 1000;
const STEP = { setup: 'setup', clone: 'clone', install: 'install', build: 'build', start: 'start' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

function defaultExec(bin) {
  return (args, { timeoutMs = 10000 } = {}) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
}

function defaultProbe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000, headers: { Host: 'localhost', Connection: 'close' } }, (res) => {
      res.resume();
      resolve(true); // any HTTP response means the app answered through the bridge
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function defaultWriteEnvFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneclick-sbx-'));
  const file = path.join(dir, 'env');
  fs.writeFileSync(file, text, { mode: 0o600 });
  let removed = false;
  return {
    path: file,
    remove() {
      if (removed) return;
      removed = true;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 8192) {
        onLine(buf);
        buf = '';
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

function createManager(cfg, deps = {}) {
  const exec = deps.exec || defaultExec(cfg.docker);
  const spawnRun = deps.spawnRun || ((args) => spawn(cfg.docker, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  const probe = deps.probe || defaultProbe;
  const writeEnvFile = deps.writeEnvFile || defaultWriteEnvFile;
  const analyzeFn = deps.analyze;
  const probeMs = deps.probeMs || 1000;
  const portPollMs = deps.portPollMs || 500;

  const runs = new Map();
  let pending = 0;
  let dockerCache = null;

  const active = () => [...runs.values()].filter((r) => !r.closed).length;

  async function dockerState() {
    const now = Date.now();
    if (dockerCache && now - dockerCache.at < (dockerCache.dockerOk && dockerCache.imageOk ? 15000 : 3000)) return dockerCache;
    const v = await exec(['version', '--format', '{{.Server.Version}}']);
    const dockerOk = v.code === 0;
    let imageOk = false;
    if (dockerOk) imageOk = (await exec(['image', 'inspect', '--format', '{{.Id}}', cfg.image])).code === 0;
    dockerCache = { at: now, dockerOk, imageOk, version: dockerOk ? v.stdout.trim() : null };
    return dockerCache;
  }

  async function checkDocker() {
    const s = await dockerState();
    if (!s.dockerOk) throw new SandboxError('docker_unavailable', 'Docker is not running or not installed. Start Docker and try again.');
    if (!s.imageOk) throw new SandboxError('image_missing', `The sandbox image "${cfg.image}" is not built. Run: npm run sandbox:build`);
  }

  function addLog(run, line) {
    if (!line) return;
    run.logs.push(line);
    if (run.logs.length > MAX_LOG_LINES) {
      const drop = run.logs.length - MAX_LOG_LINES;
      run.logs.splice(0, drop);
      run.logStart += drop;
    }
  }

  function snapshot(run, since = 0) {
    const s = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    const from = Math.max(s, run.logStart);
    return {
      id: run.id,
      status: run.status,
      phase: run.phase,
      ready: run.ready,
      previewUrl: run.ready && run.hostPort ? `http://127.0.0.1:${run.hostPort}/` : null,
      repo: run.repo,
      runtime: run.runtime,
      createdAt: run.createdAt,
      expiresAt: run.expiresAt,
      finishedAt: run.finishedAt,
      exitCode: run.exitCode,
      error: run.error,
      logs: { from, next: run.logStart + run.logs.length, lines: run.logs.slice(from - run.logStart) },
    };
  }

  function failureMessage(run, code) {
    const f = run.failure;
    if (f) {
      const step = STEP[f.phase] || f.phase;
      if (f.reason === 'timeout') return `The ${step} step timed out.`;
      const m = /^exit:(\d+)$/.exec(f.reason);
      if (f.phase === 'start' && run.ready) return `The app crashed${m ? ` (exit code ${m[1]})` : ''}.`;
      if (m) return `The ${step} step failed (exit code ${m[1]}). See the log for details.`;
      return `The ${step} step failed (${f.reason.replace(/_/g, ' ')}).`;
    }
    if (code === 137) return `The container was killed, most likely for exceeding the memory limit (${cfg.memory}).`;
    if (code === 125 || code === 126 || code === 127) return `Docker could not start the container.${run.lastStderr ? ' ' + run.lastStderr : ''}`;
    return `The container exited with code ${code}.`;
  }

  function finalize(run, code) {
    if (run.closed) return;
    run.closed = true;
    run.finishedAt = Date.now();
    run.exitCode = code;
    for (const t of Object.values(run.timers)) clearTimeout(t);
    run.envFile && run.envFile.remove();
    if (run.stopReason === 'timeout') {
      run.status = 'timeout';
      run.error = { code: 'timeout', message: `The run reached its ${cfg.ttlSec}s limit and was stopped.` };
    } else if (run.stopReason === 'not_ready') {
      run.status = 'failed';
      run.error = { code: 'not_ready', message: `The app did not start listening within ${cfg.readySec}s.` };
    } else if (run.stopReason === 'user') {
      run.status = 'stopped';
    } else if (code === 0 && run.ready) {
      run.status = 'exited';
    } else if (code === 0) {
      run.status = 'failed';
      run.error = { code: 'exited_early', message: 'The app exited before it started listening.' };
    } else {
      run.status = 'failed';
      run.error = { code: 'failed', message: failureMessage(run, code) };
    }
    addLog(run, `[oneclick] run ended: ${run.status}`);
    exec(['rm', '-f', run.name]).catch(() => {}); // belt and braces; --rm normally did it already
    run.resolveDone();
  }

  function onLine(run, line) {
    const m = parseMarker(line, run.token);
    if (m) {
      if (m.type === 'phase') {
        run.phase = m.phase;
        if (!run.ready) run.status = 'running';
      } else if (m.type === 'fail') run.failure = { phase: m.phase, reason: m.reason };
      return;
    }
    addLog(run, cleanLine(line));
  }

  function requestStop(run, reason) {
    if (run.closed) return;
    if (!run.stopReason) run.stopReason = reason;
    exec(['stop', '-t', '5', run.name], { timeoutMs: 20000 }).catch(() => {});
    run.timers.force = setTimeout(async () => {
      if (run.closed) return;
      await exec(['rm', '-f', run.name], { timeoutMs: 20000 }).catch(() => {});
      try {
        run.child.kill();
      } catch {
        /* already gone */
      }
    }, 10000);
    run.timers.force.unref();
  }

  async function findPort(run) {
    for (let i = 0; i < 120 && !run.closed; i++) {
      const r = await exec(['port', run.name, '8080/tcp']);
      const p = r.code === 0 ? parseHostPort(r.stdout) : null;
      if (p) {
        run.hostPort = p;
        break;
      }
      await sleep(portPollMs);
    }
    if (run.hostPort && !run.closed) {
      run.envFile && run.envFile.remove(); // docker has read it by now
      while (!run.closed && !run.ready) {
        if (await probe(run.hostPort)) {
          if (!run.closed) {
            run.ready = true;
            run.status = 'ready';
            addLog(run, '[oneclick] the app is answering requests');
          }
          break;
        }
        await sleep(probeMs);
      }
    }
  }

  function launch(job, analysis) {
    const id = crypto.randomBytes(9).toString('base64url');
    const now = Date.now();
    let resolveDone;
    const run = {
      id,
      name: containerName(id),
      token: crypto.randomBytes(16).toString('hex'),
      status: 'starting',
      phase: null,
      ready: false,
      hostPort: null,
      repo: { owner: analysis.repo.owner, name: analysis.repo.name, url: analysis.repo.url, branch: analysis.repo.branch },
      runtime: job.runtime,
      createdAt: now,
      expiresAt: now + cfg.ttlSec * 1000,
      finishedAt: null,
      exitCode: null,
      error: null,
      logs: [],
      logStart: 0,
      closed: false,
      stopReason: null,
      failure: null,
      lastStderr: '',
      child: null,
      envFile: null,
      timers: {},
      done: new Promise((r) => (resolveDone = r)),
      resolveDone: () => resolveDone(),
    };
    runs.set(id, run);
    addLog(run, `[oneclick] starting ${run.repo.owner}/${run.repo.name} (${job.runtime}) in an isolated container`);

    run.envFile = writeEnvFile(envFileText(job, cfg));
    let child;
    try {
      child = spawnRun(buildRunArgs({ config: cfg, name: run.name, envFilePath: run.envFile.path }));
    } catch (e) {
      run.lastStderr = String(e.message || e);
      finalize(run, 125);
      return snapshot(run);
    }
    run.child = child;

    const out = lineSplitter((l) => onLine(run, l));
    const err = lineSplitter((l) => {
      run.lastStderr = cleanLine(l) || run.lastStderr;
      onLine(run, l);
    });
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.stdin.on('error', () => {});
    child.stdin.end(run.token + '\n');
    child.on('error', (e) => {
      run.lastStderr = String(e.message || e);
      finalize(run, 125);
    });
    child.on('close', (code) => {
      out.flush();
      err.flush();
      finalize(run, code === null ? 1 : code);
    });

    run.timers.ttl = setTimeout(() => requestStop(run, 'timeout'), cfg.ttlSec * 1000);
    run.timers.ready = setTimeout(() => {
      if (!run.ready) requestStop(run, 'not_ready');
    }, cfg.readySec * 1000);
    run.timers.ttl.unref();
    run.timers.ready.unref();

    findPort(run).catch(() => {});
    return snapshot(run);
  }

  async function start({ url, env } = {}) {
    if (typeof url !== 'string' || !url.trim()) throw new SandboxError('bad_request', 'A repository URL is required.');
    if (typeof analyzeFn !== 'function') throw new SandboxError('bad_request', 'No analyzer configured.');
    const userEnv = sanitizeEnv(env);
    if (active() + pending >= cfg.maxRuns) throw new SandboxError('busy', `The sandbox is busy (${cfg.maxRuns} runs at a time). Stop a run or try again shortly.`);
    pending++;
    try {
      await checkDocker();
      const analysis = await analyzeFn(url);
      const job = buildJob(analysis, userEnv, { maxRepoKB: cfg.maxRepoKB });
      return launch(job, analysis);
    } finally {
      pending--;
    }
  }

  function getRun(id) {
    const run = runs.get(id);
    if (!run) throw new SandboxError('not_found', 'Run not found.');
    return run;
  }

  async function stop(id) {
    const run = getRun(id);
    requestStop(run, 'user');
    await Promise.race([run.done, sleep(12000)]);
    return snapshot(run);
  }

  async function shutdown() {
    clearInterval(cleaner);
    const open = [...runs.values()].filter((r) => !r.closed);
    for (const r of open) requestStop(r, 'user');
    await Promise.race([Promise.all(open.map((r) => r.done)), sleep(15000)]);
  }

  const cleaner = setInterval(() => {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    for (const [id, r] of runs) if (r.closed && r.finishedAt < cutoff) runs.delete(id);
  }, 60000);
  cleaner.unref();

  async function info() {
    const s = await dockerState();
    return {
      docker: { available: s.dockerOk, version: s.version },
      image: { name: cfg.image, present: s.imageOk },
      limits: { memory: cfg.memory, cpus: cfg.cpus, pids: cfg.pids, ttlSec: cfg.ttlSec, maxRuns: cfg.maxRuns },
      activeRuns: active(),
    };
  }

  return {
    start,
    stop,
    shutdown,
    info,
    get: (id, since) => snapshot(getRun(id), since),
    list: () => [...runs.values()].map((r) => snapshot(r, Number.MAX_SAFE_INTEGER)),
  };
}

module.exports = { createManager };
