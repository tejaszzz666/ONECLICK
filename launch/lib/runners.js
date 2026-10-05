'use strict';

// Run planner. Pure function: turns an analysis into an honest list of ways to run
// the project on someone else's free infrastructure. ONECLICK never runs the code.
//
// Every option says what it really is:
//   kind 'browser'  runs inside the visitor's browser tab (StackBlitz WebContainers, Node.js only)
//   kind 'cloud'    a free cloud dev machine on the visitor's own account (GitHub Codespaces)
//   kind 'deploy'   deploys a copy to the visitor's own free hosting account (Vercel)
//   kind 'editor'   editing only, nothing runs (github.dev)
//   kind 'preview'  opens a plain HTML page committed to the repo (raw.githack.com)
//
// Each option carries:
//   fit         'good' | 'maybe' | 'editor-only'. Internal ranking only; the site does not show it as a score.
//   notes       legacy free-text notes (kept for API compatibility)
//   about       one line: what this option is and what it costs
//   blockers    concrete, repo-specific facts found in the repo's files, each
//               { severity: 'blocks' | 'limits' | 'needs', code, message }
//                 blocks = this host cannot do this as described
//                 limits = may not behave fully
//                 needs  = something the visitor has to supply
//   ifItFails   known ways this host fails, each { cause, fix }. These are known limits of the host,
//               NOT observed failures: Launch cannot see what happens after the visitor leaves the site.

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
const PY_SERVICES = {
  psycopg2: 'PostgreSQL', 'psycopg2-binary': 'PostgreSQL', psycopg: 'PostgreSQL', asyncpg: 'PostgreSQL',
  pymysql: 'MySQL', mysqlclient: 'MySQL', 'mysql-connector-python': 'MySQL',
  pymongo: 'MongoDB', motor: 'MongoDB', redis: 'Redis',
};
const HEAVY_ML = ['torch', 'tensorflow', 'transformers', 'jax'];

const SECRET_RE = /(DATABASE|DB_|MONGO|REDIS|POSTGRES|MYSQL|SECRET|API_KEY|TOKEN|PASSWORD|PRIVATE_KEY)/i;
const seg = (s) => String(s).split('/').map(encodeURIComponent).join('/');

// A declared Node version that only allows old releases (no lower-bound-only range, newest allowed major < 16).
function oldNodeRange(rv) {
  if (!rv || rv.value == null) return null;
  const s = String(rv.value);
  if (/>/.test(s) && !/</.test(s)) return null; // a lower bound only: any newer Node satisfies it
  const majors = [...s.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && n < 100);
  if (!majors.length) return null;
  return Math.max(...majors) < 16 ? s : null;
}

function planRun({ previewPath, previewIssues = [], owner, name, canonical, ref, explicitRef, root, primary, docker, staticSite, envVars, hasDevcontainer }) {
  const o = encodeURIComponent(owner);
  const n = encodeURIComponent(name);
  const sub = root && root !== '.' ? root : '';
  const isNode = !!primary && primary.runtime === 'Node.js';
  const isPython = !!primary && primary.runtime === 'Python';
  // a library or package has no app to launch; never recommend a runner for it
  const isLib = !!primary && primary.projectType === 'Library or package' && !primary.start && !primary.staticOutput;
  const known = !!primary || docker.dockerfile || staticSite;
  const all = isNode ? [...primary.runtimeDeps, ...primary.devDeps] : [];
  const fwName = primary && primary.framework ? primary.framework.name : '';
  const pm = primary && primary.packageManager ? primary.packageManager.name : null;

  const native = all.filter((d) => NATIVE.has(d));
  const serviceMap = isNode ? SERVICES : isPython ? PY_SERVICES : {};
  const services = [...new Set((primary ? primary.runtimeDeps : []).map((d) => serviceMap[d]).filter(Boolean))];
  const heavy = isPython ? HEAVY_ML.filter((d) => primary.runtimeDeps.includes(d)) : [];
  const secrets = (envVars || []).filter((v) => !v.hasExampleValue && SECRET_RE.test(v.name)).map((v) => v.name);
  const secretList = secrets.slice(0, 4).join(', ') + (secrets.length > 4 ? ` and ${secrets.length - 4} more` : '');

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
    const blockers = previewIssues.map((i) => ({ severity: i.severity, code: i.code, message: i.message }));
    options.push({
      id: 'preview',
      label: 'Open the page now',
      provider: 'raw.githack.com',
      kind: 'preview',
      runs: true,
      // a page that needs a build or breaks on absolute paths is better served by a real deploy
      fit: blockers.length ? 'maybe' : 'good',
      url: `https://raw.githack.com/${o}/${n}/${segs}`,
      about: 'Opens the repository\'s own HTML page directly. Free, no account, nothing is built.',
      notes: ['Opens the repository\'s own HTML page directly. Free, no account. Pages that need a build step or a server will not work here.'],
      blockers,
      ifItFails: [
        { cause: 'The page appears without styling or scripts', fix: 'The page points at files in a way a plain file host cannot serve (absolute paths or http links). Deploy a copy to your own Vercel instead.' },
        { cause: 'The page is blank', fix: 'It may be a source page that needs a bundler before a browser can run it. Use the Vercel deploy or the cloud dev machine, which can run the build.' },
        { cause: 'The link says the file was not found', fix: 'The file may have been moved or renamed on this branch. raw.githack.com is a third-party service and can also be slow or unavailable; try again later.' },
      ],
    });
  }

  // 1. in-browser (StackBlitz WebContainers): Node.js only
  if (isNode && !isLib && !(previewPath && !primary.start && !primary.build)) {
    const notes = [];
    const blockers = [];
    let fit = 'good';
    const demote = (msg) => {
      fit = 'maybe';
      notes.push(msg);
    };
    if (fwName !== 'Electron') { // desktop apps get no browser option
      if (native.length) {
        demote(`Uses native modules (${native.slice(0, 3).join(', ')}) that cannot run in a browser.`);
        blockers.push({ severity: 'blocks', code: 'native-modules', message: `This project depends on native modules (${native.slice(0, 3).join(', ')}). They need a compiler, which Node running inside a browser tab does not have, so installing them will usually fail here.` });
      }
      if (services.length) {
        demote(`Needs ${services.join(' / ')}, which is not available in a browser.`);
        blockers.push({ severity: 'blocks', code: 'needs-service', message: `This project needs ${services.join(' / ')} (found in its dependencies). A browser tab cannot run a database or cache server.` });
      }
      if (pm === 'bun') {
        demote('Uses Bun; the browser runner supports npm, pnpm and yarn only.');
        blockers.push({ severity: 'blocks', code: 'bun', message: 'This project uses Bun. The browser runner supports npm, pnpm and yarn only.' });
      }
      if (fwName === 'Next.js') {
        notes.push('Next.js runs in the browser runner with some limitations.');
        blockers.push({ severity: 'limits', code: 'nextjs', message: 'Next.js runs in the browser runner with some limitations; server features may not all work.' });
      }
      if (secrets.length) {
        demote(`Needs environment variables you must supply (${secrets.slice(0, 3).join(', ')}).`);
        blockers.push({ severity: 'needs', code: 'env-vars', message: `Needs values you must supply: ${secretList}. The repository does not include working values for them.` });
      }
      if (!primary.start && !primary.staticOutput && !primary.build) {
        demote('No run command was detected; you may need to start it by hand.');
        blockers.push({ severity: 'limits', code: 'no-run-command', message: 'No start or build script was found in package.json, so there is no command to run automatically.' });
      }
      const oldNode = oldNodeRange(primary.runtimeVersion);
      if (oldNode) {
        blockers.push({ severity: 'limits', code: 'old-node', message: `This project declares Node ${oldNode} (${primary.runtimeVersion.source}). StackBlitz may not honor that version, so an old-only project can fail to install or start.` });
      }
      const failures = [
        { cause: 'The editor does not load, or says it needs different browser settings', fix: 'StackBlitz runs Node.js inside your browser tab. It works best in a Chromium-based browser (Chrome, Edge, Brave) with third-party cookies and site data allowed for stackblitz.com. Other browsers may not work at all.' },
        { cause: 'Install fails in the terminal', fix: 'Read the first red error line. If it names a compiler or a native module, that is a limit of Node in a browser, not a mistake in the repository. Use the cloud dev machine instead.' },
      ];
      if (secrets.length) failures.push({ cause: 'The app starts, then complains about a missing setting', fix: `Create a .env file in the project with values for: ${secretList}.` });
      failures.push({ cause: 'It still does not run', fix: 'Use the cloud dev machine option. It runs the project on a normal Linux machine, without the limits of a browser tab.' });
      options.push({
        id: 'stackblitz',
        label: 'Run in your browser',
        provider: 'StackBlitz',
        kind: 'browser',
        runs: true,
        fit,
        url: `https://stackblitz.com/github/${o}/${n}${sub ? `/tree/${seg(ref)}/${seg(sub)}` : ''}`,
        about: 'Runs in your browser tab on StackBlitz. Free for public repositories, no install.',
        notes: [...notes, 'Free for opening public repositories. Runs only in your browser tab.'],
        blockers,
        ifItFails: failures,
      });
    }
  }

  // 2. GitHub Codespaces: a real Linux machine for any stack
  {
    const notes = ['Needs a GitHub account. Personal accounts include 120 core-hours (60 hours on a 2-core machine) free per month.'];
    const blockers = [];
    let fit = known && !isLib ? 'good' : 'maybe';
    if (isLib) {
      notes.unshift('This looks like a library or package, not an application. There is nothing to launch; a dev machine only lets you work with it.');
      blockers.push({ severity: 'limits', code: 'library', message: 'This looks like a library or package, not an application. There is nothing to launch; a dev machine only lets you work with the code.' });
    } else if (!known) {
      notes.unshift('No supported project type was detected, so you would have to work out how to run it yourself.');
      blockers.push({ severity: 'limits', code: 'unknown-stack', message: 'No supported project type was detected, so Launch has no commands to offer. You would have to work out how to run it yourself.' });
    }
    if (hasDevcontainer) notes.unshift('The repository ships a dev container, so the environment may be pre-configured.');
    if (explicitRef) {
      notes.push(`Opens the default branch, not "${explicitRef}".`);
      blockers.push({ severity: 'limits', code: 'default-branch', message: `This link opens the default branch, not "${explicitRef}". Switch branch inside the machine if you need that one.` });
    }
    if (secrets.length) {
      notes.push(`Needs environment variables you must supply (${secrets.slice(0, 3).join(', ')}).`);
      blockers.push({ severity: 'needs', code: 'env-vars', message: `Needs values you must supply: ${secretList}. The repository does not include working values for them.` });
    }
    if (services.length) {
      notes.push(`Needs ${services.join(' / ')}; you would have to start one yourself or use docker compose if provided.`);
      blockers.push({
        severity: 'needs',
        code: 'needs-service',
        message: docker.compose
          ? `Needs ${services.join(' / ')}. The repository includes a Docker Compose file, so try "docker compose up" in the terminal.`
          : `Needs ${services.join(' / ')}, and no Docker Compose file was found. You would have to start one yourself or connect a hosted one.`,
      });
    }
    if (heavy.length) blockers.push({ severity: 'limits', code: 'heavy-ml', message: `Uses large machine-learning packages (${heavy.join(', ')}). They may not fit the free machine's memory or disk, and free Codespaces has no GPU.` });
    const failures = [
      { cause: 'It asks you to sign in, or says you are out of hours', fix: 'Codespaces needs a GitHub account and uses your own free monthly hours. Check your usage in your GitHub billing settings.' },
      { cause: 'The machine opens but nothing is running', fix: steps.length ? 'Codespaces opens a machine with the code in it; it does not start the app by itself. Run the commands shown above in its terminal, in order.' : 'Codespaces opens a machine with the code in it; it does not start the app by itself. Launch did not find commands for this project, so check the README for how to run it.' },
      { cause: 'The app is running but you cannot see it', fix: 'Open the Ports tab in the terminal panel and open the forwarded port in your browser.' },
    ];
    if (services.length || secrets.length) failures.push({ cause: 'The app starts, then crashes on a connection or missing setting', fix: 'It needs the services or values listed above. Provide them (for example in a .env file) and start it again.' });
    options.push({
      id: 'codespaces',
      label: 'Open a cloud dev machine',
      provider: 'GitHub Codespaces',
      kind: 'cloud',
      runs: true,
      fit,
      url: `https://codespaces.new/${o}/${n}`,
      about: 'A real Linux machine in your browser, on your own free GitHub quota. It opens the code; you run the commands below.',
      notes,
      blockers,
      ifItFails: failures,
      terminal: steps.length ? { cwd: sub || '.', steps } : null,
    });
  }

  // 3. deploy a static site to the visitor's own free Vercel account
  if ((primary && primary.staticOutput) || staticSite) {
    const blockers = [];
    if (sub) blockers.push({ severity: 'needs', code: 'root-directory', message: `The project is in "${sub}". Set that as the root directory when Vercel asks.` });
    const out = primary && primary.staticOutput && primary.staticOutput !== '.' ? primary.staticOutput : null;
    const failures = [
      { cause: 'The build fails on Vercel', fix: 'Open the build log on Vercel; the first error line is the real cause. Launch has only read this project, never built it, so a build error is possible.' },
      { cause: 'It deploys but shows a 404 or a blank page', fix: out ? `Check that the output directory in the Vercel project settings is "${out}".` : 'Check that the output directory in the Vercel project settings matches where the build puts its files.' },
    ];
    options.push({
      id: 'vercel',
      label: 'Deploy a copy to your Vercel',
      provider: 'Vercel',
      kind: 'deploy',
      runs: true,
      fit: sub ? 'maybe' : 'good',
      url: `https://vercel.com/new/clone?repository-url=${encodeURIComponent(canonical)}`,
      about: 'Copies the repository into your GitHub account and deploys it to your own Vercel account. Free Hobby plan is for non-commercial use.',
      notes: [
        'Creates a copy of the repository in your GitHub account and deploys it to your own Vercel account.',
        ...(sub ? [`The project is in "${sub}"; set that as the root directory when Vercel asks.`] : []),
      ],
      blockers,
      ifItFails: failures,
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
    about: 'Editor only. Nothing runs here.',
    notes: ['Editor only. Nothing runs here.'],
    blockers: [],
    ifItFails: [],
  });

  const list = options;
  const rank = ['preview', 'stackblitz', 'vercel', 'codespaces'];
  const byRank = list.filter((x) => x.runs).sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id));
  const best = isLib ? null : byRank.find((x) => x.fit === 'good') || byRank[0] || null;
  return { recommended: best ? best.id : null, options: list };
}

module.exports = { planRun, oldNodeRange };
