'use strict';

const { parseRepoUrl } = require('./url');
const { DETECTORS } = require('./detectors');
const { planRun } = require('./runners');

class AnalysisError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const SKIP_SEG = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'test', 'tests', '__tests__', 'fixtures', 'fixture', 'examples', 'example', 'docs', 'doc', 'third_party', 'testdata', '.github', 'e2e', 'samples', 'sample', 'benchmarks']);
const MANIFEST_NAMES = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json']);
const PREFETCH = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'Dockerfile', 'Procfile', '.nvmrc', '.node-version', 'runtime.txt', '.python-version'];
const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.local.example', 'example.env', 'sample.env', '.env.development.example'];
const COMPOSE = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const SRC_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|java|rs|php|cs)$/;
const NOISE_ENV = new Set(['NODE_ENV', 'PATH', 'HOME', 'PWD', 'USER', 'SHELL', 'TERM', 'CI', 'TMPDIR', 'LANG', 'HOSTNAME', 'DEBUG']);
const ENV_PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /\benv::var\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /\bENV(?:\.fetch\()?\[?\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\b(?:getenv|env)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
];

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

function findBase(paths) {
  let best = null;
  const dirs = new Set();
  for (const p of paths) {
    const segs = p.split('/');
    const name = segs.pop();
    if (!MANIFEST_NAMES.has(name) && !/\.csproj$/.test(name)) continue;
    if (segs.length > 2 || segs.some((s) => SKIP_SEG.has(s))) continue;
    dirs.add(segs.join('/'));
    if (!best || segs.length < best.depth || (segs.length === best.depth && p.length < best.len)) best = { depth: segs.length, dir: segs.join('/'), len: p.length };
  }
  return { dir: best ? best.dir : null, others: [...dirs].filter((d) => d !== (best && best.dir)).slice(0, 5) };
}

function parseEnvExample(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out.push({ name: m[1], hasValue: m[2].trim().replace(/^["']|["']$/g, '') !== '' });
  }
  return out;
}

function scoreSource(p) {
  const base = p.split('/').pop().toLowerCase();
  let s = 0;
  if (/(config|env|settings|constants|server|app|main|index|secrets)/.test(base)) s += 5;
  s -= (p.split('/').length - 1) * 1.5;
  if (/\.(test|spec)\./.test(base) || /(^|\/)(test|tests|__tests__|spec|mocks?|stories)(\/|$)/.test(p)) s -= 100;
  return s;
}

async function analyze(input, { emit = () => {}, source, signal } = {}) {
  const log = (level, msg) => emit({ type: 'log', level, msg });
  const stage = (status) => emit({ type: 'stage', id: 'analyzing', status });
  const fail = (code, message, extra) => {
    stage('failed');
    log('err', message);
    return new AnalysisError(code, message, extra);
  };
  const warnings = [];
  const warn = (m) => {
    warnings.push(m);
    log('warn', m);
  };

  stage('active');

  // 1. validate
  log('cmd', 'Validating repository URL');
  const parsed = parseRepoUrl(input);
  if (!parsed.ok) throw fail('invalid_url', parsed.error);
  const { owner, repo } = parsed;
  log('ok', `Repository URL is valid: ${owner}/${repo}`);

  const wrap = async (fn, context) => {
    try {
      return await fn();
    } catch (e) {
      if (e && e.code && e.name === 'SourceError') throw fail(e.code, context && e.code === 'not_found' ? context : e.message, { resetAt: e.resetAt });
      throw e;
    }
  };

  // 2. repository metadata
  log('cmd', 'Fetching repository metadata');
  const meta = await wrap(() => source.getRepo(owner, repo));
  if (meta.private) throw fail('private_repo', 'Private repositories are not supported yet.');
  const ref = parsed.ref || meta.defaultBranch;
  log('ok', `Public repository, branch "${ref}", ${meta.sizeKB >= 1024 ? (meta.sizeKB / 1024).toFixed(1) + ' MB' : meta.sizeKB + ' KB'}`);
  if (meta.archived) warn('This repository is archived (read-only upstream).');
  if (meta.sizeKB > 500000) warn('Very large repository. Launch may be slow or refuse to build it.');

  // 3. file tree
  log('cmd', 'Reading file tree');
  const tree = await wrap(() => source.getTree(owner, repo, ref), `Branch "${ref}" was not found.`);
  const files = tree.files;
  const sizes = new Map(files.map((f) => [f.path, f.size]));
  const paths = new Set(sizes.keys());
  log('ok', `${files.length} files indexed`);
  if (tree.truncated) warn('The repository tree is too large and was truncated by GitHub. Detection may be incomplete.');
  if (!files.length) throw fail('empty', 'This repository has no files.');

  // 4. locate project root
  log('cmd', 'Locating project manifests');
  const { dir, others } = findBase(paths);
  let base = dir;
  let staticSite = false;
  if (base === null) {
    base = '';
    if (paths.has('index.html')) staticSite = true;
  }
  const at = (n) => (base ? `${base}/${n}` : n);
  const rel = (p) => (base ? p.slice(base.length + 1) : p);
  if (dir !== null) {
    if (dir !== '') {
      warn(`No manifest at the repository root. Analyzing subdirectory "${dir}".`);
    }
    if (others.length) warn(`Other project directories also contain manifests: ${others.map((o) => o || '.').join(', ')}. Only "${dir || '.'}" was analyzed.`);
  } else {
    log('info', 'No supported project manifest found');
  }

  // 5. fetch the small set of files detection needs
  const wanted = [];
  for (const n of [...PREFETCH, ...ENV_EXAMPLES]) if (paths.has(at(n))) wanted.push(n);
  const csproj = [...paths].find((p) => (base ? p.startsWith(base + '/') : true) && /^[^/]+\.csproj$/.test(rel(p)));
  if (csproj) wanted.push(rel(csproj));
  const contents = new Map();
  await pool(wanted, 5, async (n) => {
    const text = await source.getFile(owner, repo, ref, at(n));
    if (text !== null) contents.set(n, text);
    else log('info', `${n} could not be read (missing or too large)`);
  });
  for (const n of wanted.filter((w) => PREFETCH.includes(w) && MANIFEST_NAMES.has(w))) if (contents.has(n)) log('ok', `${n} found`);

  const ctx = {
    has: (n) => paths.has(at(n)),
    pathHas: (n) => paths.has(at(n)),
    read: (n) => (contents.has(n) ? contents.get(n) : null),
    list: (prefix) => [...paths].filter((p) => (base ? p.startsWith(base + '/') : true)).map(rel).filter((p) => p.startsWith(prefix)),
  };

  // 6. detect
  log('cmd', 'Detecting stack');
  const found = DETECTORS.map((d) => d(ctx)).filter(Boolean);
  const score = (r) => (r.start ? 2 : 0) + (r.framework ? 1 : 0) + (r.build ? 1 : 0);
  found.sort((a, b) => score(b) - score(a));
  const primary = found[0] || null;

  const dockerText = ctx.read('Dockerfile');
  const expose = dockerText ? [...dockerText.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1].split(/\s+/)).map((s) => s.replace(/\/(tcp|udp)$/i, '')).filter((s) => /^\d+$/.test(s)) : [];
  const docker = { dockerfile: paths.has(at('Dockerfile')), compose: COMPOSE.some((c) => paths.has(at(c))), expose: [...new Set(expose)] };

  if (primary) {
    log('ok', `${primary.runtime} project detected`);
    if (primary.framework) log('ok', `${primary.framework.name} detected (${primary.framework.source})`);
    if (primary.packageManager) log('ok', `${primary.packageManager.name} detected (${primary.packageManager.source})`);
    if (found.length > 1) log('info', `Also found: ${found.slice(1).map((f) => f.runtime).join(', ')}`);
    for (const w of primary.warnings) warn(w);
  } else if (docker.dockerfile) {
    log('ok', 'Dockerfile found');
  } else if (staticSite) {
    log('ok', 'index.html found (static site)');
  } else {
    warn('Could not detect a supported stack. Supported: Node.js, Python, Java, Go, Rust, Ruby, PHP, .NET.');
  }
  if (docker.dockerfile) log('ok', `Dockerfile found${docker.expose.length ? ` (exposes ${docker.expose.join(', ')})` : ''}`);

  // 7. environment variables
  log('cmd', 'Scanning for environment variables');
  const envMap = new Map();
  const addEnv = (name, source_, extra = {}) => {
    if (NOISE_ENV.has(name)) return;
    const e = envMap.get(name) || { name, sources: [], inExample: false, hasExampleValue: false };
    if (!e.sources.includes(source_)) e.sources.push(source_);
    Object.assign(e, extra);
    envMap.set(name, e);
  };
  for (const n of ENV_EXAMPLES) {
    if (!contents.has(n)) continue;
    for (const v of parseEnvExample(contents.get(n))) addEnv(v.name, n, { inExample: true, hasExampleValue: v.hasValue });
  }
  const candidates = files
    .map((f) => f.path)
    .filter((p) => (base ? p.startsWith(base + '/') : true) && SRC_RE.test(p) && !p.split('/').some((s) => SKIP_SEG.has(s) && s !== 'build') && (sizes.get(p) || 0) <= 100000)
    .sort((a, b) => scoreSource(b) - scoreSource(a))
    .filter((p) => scoreSource(p) > -50);
  const toScan = candidates.slice(0, 15);
  await pool(toScan, 5, async (p) => {
    const text = await source.getFile(owner, repo, ref, p, 100000);
    if (!text) return;
    for (const re of ENV_PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) addEnv(m[1], p);
    }
  });
  const envVars = [...envMap.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
  log('ok', `${envVars.length} environment variable${envVars.length === 1 ? '' : 's'} referenced (scanned ${toScan.length} of ${candidates.length} source files)`);

  // 8. assemble
  const noExecution = 'Sandboxed execution is not implemented yet. Nothing was installed, built or run.';
  let status;
  let statusReason;
  if (!primary && !docker.dockerfile && !staticSite) {
    status = 'UNKNOWN';
    statusReason = 'No supported project type was detected.';
  } else if (primary && primary.projectType === 'Library or package' && !primary.start && !primary.staticOutput) {
    status = 'LIBRARY';
    statusReason = 'This is a library or package, not an application. There is no application entry point to launch.';
  } else if (primary && (primary.start || primary.staticOutput)) {
    status = 'READY';
    statusReason = 'Stack and a run command were found. This is an analysis result; the project has not been built or run.';
  } else if (docker.dockerfile || staticSite) {
    status = 'READY';
    statusReason = staticSite ? 'Static site: index.html found. This is an analysis result only.' : 'A Dockerfile was found. This is an analysis result; the image has not been built.';
  } else {
    status = 'PARTIAL';
    statusReason = 'Stack detected, but no start command could be determined.';
  }
  log(status === 'UNKNOWN' ? 'warn' : 'ok', `Analysis complete: ${status}`);
  stage('done');

  const runPlan = planRun({
    owner,
    name: meta.name || repo,
    canonical: parsed.canonical,
    ref,
    explicitRef: parsed.ref || null,
    root: base || '.',
    primary,
    docker,
    staticSite,
    envVars,
    hasDevcontainer: paths.has('.devcontainer/devcontainer.json') || paths.has('.devcontainer.json'),
  });
  const best = runPlan.options.find((x) => x.id === runPlan.recommended);
  if (best) log('ok', `Best free way to run it: ${best.label} (${best.provider}${best.fit === 'maybe' ? ', with caveats' : ''})`);

  const cmdOut = (c) => (c ? { cmd: c.cmd, source: c.source, confidence: c.confidence } : null);
  return {
    repo: { owner, name: meta.name || repo, url: parsed.canonical, branch: ref, description: meta.description, sizeKB: meta.sizeKB, archived: meta.archived, fork: meta.fork, treeTruncated: tree.truncated },
    project: { name: (primary && primary.name) || meta.name || repo, root: base || '.' },
    language: primary ? primary.language : docker.dockerfile ? 'Docker' : staticSite ? 'HTML' : null,
    runtime: primary ? primary.runtime : null,
    framework: primary ? primary.framework : null,
    projectType: primary ? primary.projectType : staticSite ? 'Static site' : docker.dockerfile ? 'Containerized application' : null,
    packageManager: primary ? primary.packageManager : null,
    packageFiles: primary ? primary.packageFiles.map((f) => at(f)) : [],
    alsoDetected: found.slice(1).map((f) => f.runtime),
    dependencies: primary ? { runtimeCount: primary.runtimeDeps.length, devCount: primary.devDeps.length, sample: primary.runtimeDeps.slice(0, 20) } : null,
    commands: { install: primary ? cmdOut(primary.install) : null, build: primary ? cmdOut(primary.build) : null, start: primary ? cmdOut(primary.start) : null },
    staticOutput: primary ? primary.staticOutput : staticSite ? '.' : null,
    entryPoint: primary && primary.entry ? { ...primary.entry, path: at(primary.entry.path) } : null,
    runtimeVersion: primary ? primary.runtimeVersion : null,
    docker,
    env: { count: envVars.length, vars: envVars, scannedFiles: toScan.length, totalSourceFiles: candidates.length },
    warnings,
    status,
    statusReason,
    execution: { available: false, reason: noExecution },
    runPlan,
    analyzedAt: new Date().toISOString(),
  };
}

module.exports = { analyze, AnalysisError };
