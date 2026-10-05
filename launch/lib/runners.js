'use strict';

// Run planner. Pure function: turns an analysis into an honest list of ways to run
// the project on someone else's free infrastructure. ONECLICK never runs the code.
//
// Every option says what it really is:
//   kind 'browser'  runs inside the visitor's browser tab (StackBlitz WebContainers, Node.js only)
//   kind 'cloud'    a free cloud dev machine on the visitor's own account (GitHub Codespaces)
//   kind 'deploy'   deploys a copy to the visitor's own free hosting account (Vercel)
//   kind 'editor'   editing only, nothing runs (github.dev)
// fit: 'good' | 'maybe' | 'editor-only'. 'maybe' always comes with notes explaining why.

// npm packages that need a native build or system binary; WebContainers cannot run them.
const NATIVE = new Set([
  'sharp', 'bcrypt', 'sqlite3', 'better-sqlite3', 'node-sass', 'canvas', 'puppeteer', 'playwright',
  'bufferutil', 'utf-8-validate', 'grpc', 're2', 'node-pty', 'serialport', 'leveldown', 'argon2', 'fibers', 'cpu-features',
]);

// Packages that only make sense with a running external service.
const SERVICES = {
  pg: 'PostgreSQL', mysql: 'MySQL', mysql2: 'MySQL', mongodb: 'MongoDB', mongoose: 'MongoDB',
  redis: 'Redis', ioredis: 'Redis', '@prisma/client': 'a database (Prisma)', typeorm: 'a database (TypeORM)', sequelize: 'a database (Sequelize)',
};

const SECRET_RE = /(DATABASE|DB_|MONGO|REDIS|POSTGRES|MYSQL|SECRET|API_KEY|TOKEN|PASSWORD|PRIVATE_KEY)/i;
const seg = (s) => String(s).split('/').map(encodeURIComponent).join('/');

function planRun({ previewPath, owner, name, canonical, ref, explicitRef, root, primary, docker, staticSite, envVars, hasDevcontainer }) {
  const o = encodeURIComponent(owner);
  const n = encodeURIComponent(name);
  const sub = root && root !== '.' ? root : '';
  const isNode = !!primary && primary.runtime === 'Node.js';
  // a library or package has no app to launch; never recommend a runner for it
  const isLib = !!primary && primary.projectType === 'Library or package' && !primary.start && !primary.staticOutput;
  const known = !!primary || docker.dockerfile || staticSite;
  const deps = isNode ? primary.runtimeDeps : [];
  const all = isNode ? [...primary.runtimeDeps, ...primary.devDeps] : [];
  const fwName = primary && primary.framework ? primary.framework.name : '';
  const pm = primary && primary.packageManager ? primary.packageManager.name : null;

  const native = all.filter((d) => NATIVE.has(d));
  const services = [...new Set(deps.filter((d) => SERVICES[d]).map((d) => SERVICES[d]))];
  const secrets = (envVars || []).filter((v) => !v.hasExampleValue && SECRET_RE.test(v.name)).map((v) => v.name);

  // the commands someone would type in a terminal, exactly as the analysis found them (never invented here)
  const steps = [];
  if (primary) {
    for (const k of ['install', 'build', 'start']) if (primary[k]) steps.push({ label: k, cmd: primary[k].cmd, confidence: primary[k].confidence });
  }
  const options = [];

  // 0. plain static pages committed to the repo: open the page itself through a service that serves
  //    GitHub files with the right content types (no build, no account, no in-browser server)
  if (previewPath) {
    const segs = [ref, ...(sub ? sub.split('/') : []), ...previewPath.split('/')].map(seg).join('/');
    options.push({
      id: 'preview',
      label: 'Open the page now',
      provider: 'raw.githack.com',
      kind: 'preview',
      runs: true,
      fit: 'good',
      url: `https://raw.githack.com/${o}/${n}/${segs}`,
      notes: ['Opens the repository\'s own HTML page directly. Free, no account. Pages that need a build step or a server will not work here.'],
    });
  }

  // 1. in-browser (StackBlitz WebContainers): Node.js only
  if (isNode && !isLib && !(previewPath && !primary.start && !primary.build)) {
    const notes = [];
    let fit = 'good';
    const demote = (msg) => {
      fit = 'maybe';
      notes.push(msg);
    };
    if (fwName !== 'Electron') { // desktop apps get no browser option
      if (native.length) demote(`Uses native modules (${native.slice(0, 3).join(', ')}) that cannot run in a browser.`);
      if (services.length) demote(`Needs ${services.join(' / ')}, which is not available in a browser.`);
      if (pm === 'bun') demote('Uses Bun; the browser runner supports npm, pnpm and yarn only.');
      if (fwName === 'Next.js') notes.push('Next.js runs in the browser runner with some limitations.');
      if (secrets.length) demote(`Needs environment variables you must supply (${secrets.slice(0, 3).join(', ')}).`);
      if (!primary.start && !primary.staticOutput && !primary.build) demote('No run command was detected; you may need to start it by hand.');
      options.push({
        id: 'stackblitz',
        label: 'Run in your browser',
        provider: 'StackBlitz',
        kind: 'browser',
        runs: true,
        fit,
        url: `https://stackblitz.com/github/${o}/${n}${sub ? `/tree/${seg(ref)}/${seg(sub)}` : ''}`,
        notes: [...notes, 'Free for opening public repositories. Runs only in your browser tab.'],
      });
    }
  }

  // 2. GitHub Codespaces: a real Linux machine for any stack
  {
    const notes = ['Needs a GitHub account. Personal accounts include 120 core-hours (60 hours on a 2-core machine) free per month.'];
    let fit = known && !isLib ? 'good' : 'maybe';
    if (isLib) notes.unshift('This looks like a library or package, not an application. There is nothing to launch; a dev machine only lets you work with it.');
    else if (!known) notes.unshift('No supported project type was detected, so you would have to work out how to run it yourself.');
    if (hasDevcontainer) notes.unshift('The repository ships a dev container, so the environment may be pre-configured.');
    if (explicitRef) notes.push(`Opens the default branch, not "${explicitRef}".`);
    if (secrets.length) notes.push(`Needs environment variables you must supply (${secrets.slice(0, 3).join(', ')}).`);
    if (services.length) notes.push(`Needs ${services.join(' / ')}; you would have to start one yourself or use docker compose if provided.`);
    options.push({
      id: 'codespaces',
      label: 'Open a cloud dev machine',
      provider: 'GitHub Codespaces',
      kind: 'cloud',
      runs: true,
      fit,
      url: `https://codespaces.new/${o}/${n}`,
      notes,
      terminal: steps.length ? { cwd: sub || '.', steps } : null,
    });
  }

  // 3. deploy a static site to the visitor's own free Vercel account
  if ((primary && primary.staticOutput) || staticSite) {
    options.push({
      id: 'vercel',
      label: 'Deploy a copy to your Vercel',
      provider: 'Vercel',
      kind: 'deploy',
      runs: true,
      fit: sub ? 'maybe' : 'good',
      url: `https://vercel.com/new/clone?repository-url=${encodeURIComponent(canonical)}`,
      notes: [
        'Creates a copy of the repository in your GitHub account and deploys it to your own Vercel account.',
        ...(sub ? [`The project is in "${sub}"; set that as the root directory when Vercel asks.`] : []),
      ],
    });
  }

  // 4. github.dev: editor only, never labelled as a running preview
  options.push({
    id: 'github-dev',
    label: 'Read and edit the code',
    provider: 'github.dev',
    kind: 'editor',
    runs: false,
    fit: 'editor-only',
    url: `https://github.dev/${o}/${n}`,
    notes: ['Editor only. Nothing runs here.'],
  });

  const list = options;
  const rank = ['preview', 'stackblitz', 'vercel', 'codespaces'];
  const byRank = list.filter((x) => x.runs).sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id));
  const best = isLib ? null : byRank.find((x) => x.fit === 'good') || byRank[0] || null;
  return { recommended: best ? best.id : null, options: list };
}

module.exports = { planRun };
