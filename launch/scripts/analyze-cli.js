#!/usr/bin/env node
'use strict';

// Usage: node scripts/analyze-cli.js <github-url> [--json]
const { analyze, AnalysisError } = require('../lib/analyzer');
const { createGithubSource } = require('../lib/github');

const args = process.argv.slice(2);
const json = args.includes('--json');
const url = args.find((a) => !a.startsWith('--'));
if (!url) {
  console.error('Usage: node scripts/analyze-cli.js <github-url> [--json]');
  process.exit(2);
}

const icons = { cmd: '>', ok: '+', warn: '!', err: 'x', info: '-' };
const emit = (ev) => {
  if (!json && ev.type === 'log') console.error(`${icons[ev.level] || ' '} ${ev.msg}`);
};

analyze(url, { source: createGithubSource({ token: process.env.GITHUB_TOKEN }), emit })
  .then((r) => {
    if (json) return console.log(JSON.stringify(r, null, 2));
    const c = (x) => (x ? `${x.cmd}  (${x.source}, ${x.confidence})` : '-');
    console.log(`\n${r.repo.owner}/${r.repo.name} @ ${r.repo.branch}`);
    console.log(`Status:    ${r.status} - ${r.statusReason}`);
    console.log(`Stack:     ${[r.language, r.framework && r.framework.name].filter(Boolean).join(' / ') || '-'}`);
    console.log(`Type:      ${r.projectType || '-'}`);
    console.log(`Install:   ${c(r.commands.install)}`);
    console.log(`Build:     ${c(r.commands.build)}`);
    console.log(`Start:     ${c(r.commands.start)}`);
    console.log(`Env vars:  ${r.env.vars.map((v) => v.name).join(', ') || '-'}`);
    for (const w of r.warnings) console.log(`Warning:   ${w}`);
  })
  .catch((e) => {
    if (!(e instanceof AnalysisError)) console.error(e);
    console.error(e.message);
    process.exit(1);
  });
