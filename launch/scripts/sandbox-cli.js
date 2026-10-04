#!/usr/bin/env node
'use strict';

// Usage: node scripts/sandbox-cli.js <github-url> [--env NAME=value ...]
// Runs a public GitHub repository inside the locked-down Docker sandbox and prints its log.
// Needs Docker and the image from `npm run sandbox:build`. Ctrl-C stops the container.
const { analyze, AnalysisError } = require('../lib/analyzer');
const { createGithubSource } = require('../lib/github');
const { loadConfig } = require('../lib/sandbox/config');
const { createManager } = require('../lib/sandbox/manager');
const { SandboxError } = require('../lib/sandbox/errors');

const args = process.argv.slice(2);
const env = {};
let url = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env') {
    const kv = args[++i] || '';
    const eq = kv.indexOf('=');
    if (eq < 1) {
      console.error('--env needs NAME=value');
      process.exit(2);
    }
    env[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (!args[i].startsWith('--')) url = args[i];
}
if (!url) {
  console.error('Usage: node scripts/sandbox-cli.js <github-url> [--env NAME=value ...]');
  process.exit(2);
}

const manager = createManager(loadConfig(process.env), {
  analyze: (u) => analyze(u, { source: createGithubSource({ token: process.env.GITHUB_TOKEN }) }),
});

(async () => {
  let snap = await manager.start({ url, env });
  const id = snap.id;
  let next = 0;
  let announced = false;
  let stopping = false;
  const onSignal = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error('\nStopping...');
    await manager.stop(id);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (;;) {
    snap = manager.get(id, next);
    for (const l of snap.logs.lines) console.log(l);
    next = snap.logs.next;
    if (snap.ready && !announced) {
      announced = true;
      console.error(`\nReady: ${snap.previewUrl}   (Ctrl-C to stop; auto-stops at ${new Date(snap.expiresAt).toLocaleTimeString()})\n`);
    }
    if (['failed', 'stopped', 'exited', 'timeout'].includes(snap.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (snap.error) console.error(`\n${snap.error.message}`);
  await manager.shutdown();
  process.exit(snap.status === 'failed' || snap.status === 'timeout' ? 1 : 0);
})().catch((e) => {
  if (e instanceof SandboxError || e instanceof AnalysisError) console.error(e.message);
  else console.error(e);
  process.exit(1);
});
