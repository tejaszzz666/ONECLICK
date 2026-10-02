'use strict';

// Stack detectors. Each takes a context { has(name), read(name), pathHas(relPath), list(prefix) }
// and returns a partial result or null. Values are only reported when a file
// actually says so ("declared") or a clearly labelled guess ("inferred").
// Anything that cannot be determined stays null.

const declared = (cmd, source) => ({ cmd, source, confidence: 'declared' });
const inferred = (cmd, source) => ({ cmd, source, confidence: 'inferred' });

function blank(runtime) {
  return {
    runtime,
    language: runtime,
    framework: null,
    projectType: null,
    packageManager: null,
    packageFiles: [],
    runtimeDeps: [],
    devDeps: [],
    install: null,
    build: null,
    start: null,
    entry: null,
    runtimeVersion: null,
    staticOutput: null,
    name: null,
    warnings: [],
  };
}

const firstExisting = (ctx, names) => names.find((n) => ctx.pathHas(n)) || null;

/* ------------------------------ Node.js ------------------------------ */

const NODE_FRAMEWORKS = [
  ['next', 'Next.js', 'fullstack'],
  ['nuxt', 'Nuxt', 'fullstack'],
  ['@sveltejs/kit', 'SvelteKit', 'fullstack'],
  ['@remix-run/react', 'Remix', 'fullstack'],
  ['@remix-run/node', 'Remix', 'fullstack'],
  ['astro', 'Astro', 'frontend'],
  ['gatsby', 'Gatsby', 'frontend'],
  ['@nestjs/core', 'NestJS', 'server'],
  ['@angular/core', 'Angular', 'frontend'],
  ['react-scripts', 'Create React App', 'frontend'],
  ['vite', 'Vite', 'frontend'],
  ['express', 'Express', 'server'],
  ['fastify', 'Fastify', 'server'],
  ['koa', 'Koa', 'server'],
  ['@hapi/hapi', 'hapi', 'server'],
  ['electron', 'Electron', 'desktop'],
  ['vue', 'Vue', 'frontend'],
  ['react', 'React', 'frontend'],
];
const NODE_OUTPUT = { Astro: 'dist', Gatsby: 'public', Angular: 'dist', 'Create React App': 'build', Vite: 'dist' };
const KIND_LABEL = {
  fullstack: 'Full-stack web app',
  server: 'Backend service / API',
  frontend: 'Frontend web app (static build)',
  desktop: 'Desktop app',
};

function detectNode(ctx) {
  if (!ctx.has('package.json')) return null;
  const r = blank('Node.js');
  r.packageFiles.push('package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(ctx.read('package.json'));
  } catch {
    /* handled below */
  }
  if (!pkg || typeof pkg !== 'object') {
    r.warnings.push('package.json could not be parsed as JSON.');
    return r;
  }

  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
  const dev = pkg.devDependencies && typeof pkg.devDependencies === 'object' ? Object.keys(pkg.devDependencies) : [];
  const all = new Set([...deps, ...dev]);
  r.runtimeDeps = deps;
  r.devDeps = dev;
  r.name = typeof pkg.name === 'string' ? pkg.name : null;
  if (all.has('typescript') || ctx.has('tsconfig.json')) r.language = 'TypeScript';
  else r.language = 'JavaScript';

  // framework
  let kind = null;
  const hit = NODE_FRAMEWORKS.find(([dep]) => all.has(dep));
  if (hit) {
    r.framework = { name: hit[1], source: `${hit[0]} in package.json`, confidence: 'declared' };
    kind = hit[2];
    if (hit[1] === 'Vite') {
      if (all.has('react')) r.framework.name = 'Vite + React';
      else if (all.has('vue')) r.framework.name = 'Vite + Vue';
      else if (all.has('svelte')) r.framework.name = 'Vite + Svelte';
    }
  }

  // package manager
  const lock = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ].find(([f]) => ctx.has(f));
  let pm;
  if (lock) {
    pm = { name: lock[1], source: lock[0], confidence: 'declared' };
    r.packageFiles.push(lock[0]);
  } else if (typeof pkg.packageManager === 'string' && /^(npm|pnpm|yarn|bun)@/.test(pkg.packageManager)) {
    pm = { name: pkg.packageManager.split('@')[0], source: 'packageManager field', confidence: 'declared' };
  } else {
    pm = { name: 'npm', source: 'no lockfile found; assumed', confidence: 'inferred' };
    r.warnings.push('No lockfile found. Dependency versions will not be reproducible.');
  }
  r.packageManager = pm;

  const run = (script) => {
    if (pm.name === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`;
    if (pm.name === 'bun') return `bun run ${script}`;
    return `${pm.name} ${script}`;
  };
  const installCmd = {
    npm: lock && lock[0] === 'package-lock.json' ? 'npm ci' : 'npm install',
    pnpm: lock ? 'pnpm install --frozen-lockfile' : 'pnpm install',
    yarn: 'yarn install',
    bun: 'bun install',
  }[pm.name];
  r.install = { cmd: installCmd, source: pm.source, confidence: pm.confidence };

  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  if (scripts.build) r.build = declared(run('build'), 'scripts.build');

  if (scripts.start) {
    r.start = declared(run('start'), 'scripts.start');
  } else if (kind === 'frontend' && scripts.build) {
    r.staticOutput = NODE_OUTPUT[r.framework.name.split(' ')[0]] || NODE_OUTPUT[r.framework.name] || null;
  } else if (scripts.dev) {
    r.start = inferred(run('dev'), 'scripts.dev');
    r.warnings.push('No start script. Falling back to the dev script, which is not production-grade.');
  } else if (typeof pkg.main === 'string' && ctx.pathHas(pkg.main.replace(/^\.\//, ''))) {
    r.start = inferred(`node ${pkg.main.replace(/^\.\//, '')}`, 'package.json main');
  }

  // entry point
  if (typeof pkg.main === 'string' && ctx.pathHas(pkg.main.replace(/^\.\//, ''))) {
    r.entry = { path: pkg.main.replace(/^\.\//, ''), source: 'package.json main', confidence: 'declared' };
  } else {
    const guess = firstExisting(ctx, ['server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js', 'src/app.js', 'server.ts', 'index.ts', 'app.ts', 'src/index.ts', 'src/main.ts', 'src/server.ts']);
    if (guess) r.entry = { path: guess, source: 'common filename', confidence: 'inferred' };
  }

  // project type
  if (kind) r.projectType = KIND_LABEL[kind];
  else if (pkg.bin) r.projectType = 'Command-line tool';
  else if (!scripts.start && !scripts.dev && !scripts.build) r.projectType = 'Library or package';
  else r.projectType = 'Node.js application';

  if (pkg.workspaces) r.warnings.push('Workspaces detected (monorepo). Only the root package was analyzed.');

  const nv = (ctx.read('.nvmrc') || ctx.read('.node-version') || '').trim();
  if (pkg.engines && typeof pkg.engines.node === 'string') r.runtimeVersion = { value: pkg.engines.node, source: 'engines.node' };
  else if (nv) r.runtimeVersion = { value: nv, source: ctx.has('.nvmrc') ? '.nvmrc' : '.node-version' };

  return r;
}

/* ------------------------------- Python ------------------------------ */

const normPy = (s) => s.toLowerCase().replace(/[_.]+/g, '-');

function parseRequirements(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.split('#')[0].trim();
    if (!line || line.startsWith('-') || /^(git\+|https?:)/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) out.push(normPy(m[1]));
  }
  return out;
}

function parsePyproject(text) {
  const deps = new Set();
  const name = (text.match(/^\s*name\s*=\s*["']([^"']+)["']/m) || [])[1] || null;
  const requiresPython = (text.match(/requires-python\s*=\s*["']([^"']+)["']/) || [])[1] || null;
  const poetry = /\[tool\.poetry\]/.test(text);
  const multi = text.match(/^\s*dependencies\s*=\s*\[\s*\n([\s\S]*?)\n\s*\]/m);
  const single = text.match(/^\s*dependencies\s*=\s*\[([^\n]*)\]\s*$/m);
  const arr = multi ? multi[1] : single ? single[1] : '';
  for (const s of arr.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) deps.add(normPy(s[1]));
  const pd = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (pd) {
    for (const l of pd[1].split('\n')) {
      const m = l.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (m && m[1].toLowerCase() !== 'python') deps.add(normPy(m[1]));
    }
  }
  return { deps: [...deps], name, requiresPython, poetry };
}

function parsePipfile(text) {
  const m = text.match(/\[packages\]([\s\S]*?)(?=\n\[|$)/);
  const out = [];
  if (m) {
    for (const l of m[1].split('\n')) {
      const k = l.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (k) out.push(normPy(k[1]));
    }
  }
  return out;
}

const PY_FRAMEWORKS = [
  ['django', 'Django'],
  ['fastapi', 'FastAPI'],
  ['flask', 'Flask'],
  ['streamlit', 'Streamlit'],
  ['gradio', 'Gradio'],
  ['sanic', 'Sanic'],
  ['aiohttp', 'aiohttp'],
  ['tornado', 'Tornado'],
  ['starlette', 'Starlette'],
  ['dash', 'Dash'],
  ['bottle', 'Bottle'],
];

function detectPython(ctx) {
  const hasReq = ctx.has('requirements.txt');
  const hasPyproject = ctx.has('pyproject.toml');
  const hasPipfile = ctx.has('Pipfile');
  const hasSetup = ctx.has('setup.py') || ctx.has('setup.cfg');
  if (!hasReq && !hasPyproject && !hasPipfile && !hasSetup) return null;

  const r = blank('Python');
  let deps = [];
  let py = null;
  if (hasReq) {
    r.packageFiles.push('requirements.txt');
    deps = deps.concat(parseRequirements(ctx.read('requirements.txt') || ''));
  }
  if (hasPyproject) {
    r.packageFiles.push('pyproject.toml');
    py = parsePyproject(ctx.read('pyproject.toml') || '');
    deps = deps.concat(py.deps);
    r.name = py.name;
  }
  if (hasPipfile) {
    r.packageFiles.push('Pipfile');
    deps = deps.concat(parsePipfile(ctx.read('Pipfile') || ''));
  }
  if (hasSetup) r.packageFiles.push(ctx.has('setup.py') ? 'setup.py' : 'setup.cfg');
  deps = [...new Set(deps)];
  r.runtimeDeps = deps;
  const dset = new Set(deps);

  const fw = PY_FRAMEWORKS.find(([d]) => dset.has(d));
  if (fw) r.framework = { name: fw[1], source: `${fw[0]} in dependencies`, confidence: 'declared' };

  // package manager
  if (ctx.has('poetry.lock') || (py && py.poetry)) r.packageManager = { name: 'poetry', source: ctx.has('poetry.lock') ? 'poetry.lock' : '[tool.poetry] in pyproject.toml', confidence: 'declared' };
  else if (ctx.has('uv.lock')) r.packageManager = { name: 'uv', source: 'uv.lock', confidence: 'declared' };
  else if (hasPipfile) r.packageManager = { name: 'pipenv', source: 'Pipfile', confidence: 'declared' };
  else if (hasReq) r.packageManager = { name: 'pip', source: 'requirements.txt', confidence: 'declared' };
  else r.packageManager = { name: 'pip', source: 'pyproject.toml / setup.py; assumed', confidence: 'inferred' };
  const pm = r.packageManager;
  r.install = {
    poetry: inferred('poetry install', pm.source),
    uv: inferred('uv sync', pm.source),
    pipenv: inferred('pipenv install', pm.source),
    pip: hasReq ? declared('pip install -r requirements.txt', 'requirements.txt') : inferred('pip install .', pm.source),
  }[pm.name];
  if (pm.name !== 'pip') r.install.confidence = 'declared';

  // entry point
  const byFw = {
    Django: ['manage.py'],
    Streamlit: ['streamlit_app.py', 'app.py', 'main.py', 'Home.py'],
    FastAPI: ['main.py', 'app/main.py', 'src/main.py', 'app.py', 'api.py'],
    Flask: ['app.py', 'wsgi.py', 'main.py', 'application.py', 'run.py', 'src/app.py', 'app/__init__.py'],
  };
  const generic = ['main.py', 'app.py', 'server.py', 'run.py', 'src/main.py', 'manage.py'];
  const entry = firstExisting(ctx, (fw && byFw[fw[1]]) || generic) || firstExisting(ctx, generic);
  if (entry) r.entry = { path: entry, source: 'common filename', confidence: 'inferred' };

  const fname = r.framework && r.framework.name;
  if (fname === 'Django') {
    r.projectType = 'Web application';
    if (entry === 'manage.py') {
      r.start = inferred('python manage.py runserver 0.0.0.0:8000', 'manage.py');
      r.warnings.push('Django dev server is used as the start command; a production setup would use gunicorn/uvicorn.');
    }
  } else if (fname === 'FastAPI' || fname === 'Starlette') {
    r.projectType = 'Backend service / API';
    if (entry) {
      const mod = entry.replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
      r.start = inferred(`uvicorn ${mod}:app --host 0.0.0.0`, `assumes the ASGI object in ${entry} is named "app"`);
    }
  } else if (fname === 'Flask') {
    r.projectType = 'Web application';
    if (entry && !entry.endsWith('__init__.py')) r.start = inferred(`python ${entry}`, entry);
  } else if (fname === 'Streamlit') {
    r.projectType = 'Data app (Streamlit)';
    r.start = inferred(`streamlit run ${entry || 'app.py'}`, entry || 'default filename');
  } else if (fname === 'Gradio') {
    r.projectType = 'Data app (Gradio)';
    if (entry) r.start = inferred(`python ${entry}`, entry);
  } else if (fname) {
    r.projectType = 'Web application';
    if (entry) r.start = inferred(`python ${entry}`, entry);
  } else {
    r.projectType = hasSetup && !entry ? 'Library or package' : 'Python application or script';
    if (entry) r.start = inferred(`python ${entry}`, entry);
  }

  const proc = (ctx.read('Procfile') || '').match(/^web:\s*(.+)$/m);
  if (proc) r.start = declared(proc[1].trim(), 'Procfile');

  const heavy = ['torch', 'tensorflow', 'transformers', 'jax'].filter((d) => dset.has(d));
  if (heavy.length) r.warnings.push(`Large ML dependencies (${heavy.join(', ')}): expect heavy memory, disk and possibly GPU needs.`);

  const pv = (ctx.read('.python-version') || '').trim() || (ctx.read('runtime.txt') || '').trim();
  if (py && py.requiresPython) r.runtimeVersion = { value: py.requiresPython, source: 'requires-python' };
  else if (pv) r.runtimeVersion = { value: pv, source: ctx.has('.python-version') ? '.python-version' : 'runtime.txt' };
  return r;
}

/* -------------------------------- Java -------------------------------- */

function detectJava(ctx) {
  const pom = ctx.has('pom.xml');
  const gradle = ctx.has('build.gradle') || ctx.has('build.gradle.kts');
  if (!pom && !gradle) return null;
  const r = blank('Java');
  if (pom) {
    const t = ctx.read('pom.xml') || '';
    r.packageFiles.push('pom.xml');
    const mvn = ctx.has('mvnw') ? './mvnw' : 'mvn';
    r.packageManager = { name: 'Maven', source: 'pom.xml', confidence: 'declared' };
    r.install = inferred(`${mvn} dependency:resolve`, 'pom.xml');
    r.build = inferred(`${mvn} package`, 'pom.xml');
    r.name = (t.replace(/<parent>[\s\S]*?<\/parent>/, '').match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1] || null;
    if (/spring-boot/.test(t)) {
      r.framework = { name: 'Spring Boot', source: 'spring-boot in pom.xml', confidence: 'declared' };
      r.start = inferred(`${mvn} spring-boot:run`, 'spring-boot plugin');
      r.projectType = 'Backend service / API';
    } else if (/quarkus/.test(t)) {
      r.framework = { name: 'Quarkus', source: 'quarkus in pom.xml', confidence: 'declared' };
      r.start = inferred(`${mvn} quarkus:dev`, 'quarkus plugin');
      r.projectType = 'Backend service / API';
    }
    const jv = (t.match(/<java\.version>([^<]+)</) || t.match(/<maven\.compiler\.(?:source|release)>([^<]+)</) || [])[1];
    if (jv) r.runtimeVersion = { value: jv, source: 'pom.xml' };
  } else {
    const file = ctx.has('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle';
    const t = ctx.read(file) || '';
    const g = ctx.has('gradlew') ? './gradlew' : 'gradle';
    r.packageFiles.push(file);
    r.packageManager = { name: 'Gradle', source: file, confidence: 'declared' };
    r.build = inferred(`${g} build`, file);
    r.install = inferred(`${g} dependencies`, file);
    if (/org\.springframework\.boot/.test(t)) {
      r.framework = { name: 'Spring Boot', source: `spring boot plugin in ${file}`, confidence: 'declared' };
      r.start = inferred(`${g} bootRun`, 'spring boot plugin');
      r.projectType = 'Backend service / API';
    }
  }
  r.projectType = r.projectType || 'Java application or library';
  return r;
}

/* --------------------------------- Go --------------------------------- */

function detectGo(ctx) {
  if (!ctx.has('go.mod')) return null;
  const t = ctx.read('go.mod') || '';
  const r = blank('Go');
  r.packageFiles.push('go.mod');
  r.name = (t.match(/^module\s+(\S+)/m) || [])[1] || null;
  r.packageManager = { name: 'Go modules', source: 'go.mod', confidence: 'declared' };
  r.install = declared('go mod download', 'go.mod');
  r.build = inferred('go build ./...', 'go.mod');
  const gv = (t.match(/^go\s+(\S+)/m) || [])[1];
  if (gv) r.runtimeVersion = { value: gv, source: 'go.mod' };
  const fws = [['gin-gonic/gin', 'Gin'], ['labstack/echo', 'Echo'], ['gofiber/fiber', 'Fiber'], ['go-chi/chi', 'chi'], ['gorilla/mux', 'gorilla/mux']];
  const f = fws.find(([m]) => t.includes(m));
  if (f) r.framework = { name: f[1], source: 'go.mod requirement', confidence: 'declared' };
  if (ctx.pathHas('main.go')) {
    r.entry = { path: 'main.go', source: 'common filename', confidence: 'inferred' };
    r.start = inferred('go run .', 'main.go at project root');
    r.projectType = 'Go application';
  } else {
    const cmd = ctx.list('cmd/').find((p) => /^cmd\/[^/]+\/main\.go$/.test(p));
    if (cmd) {
      r.entry = { path: cmd, source: 'cmd/ layout', confidence: 'inferred' };
      r.start = inferred(`go run ./${cmd.replace(/\/main\.go$/, '')}`, 'cmd/ layout');
      r.projectType = 'Go application';
    } else r.projectType = 'Go library or module';
  }
  return r;
}

/* -------------------------------- Rust -------------------------------- */

function detectRust(ctx) {
  if (!ctx.has('Cargo.toml')) return null;
  const t = ctx.read('Cargo.toml') || '';
  const r = blank('Rust');
  r.packageFiles.push('Cargo.toml');
  r.name = (t.match(/\[package\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/m) || [])[1] || null;
  r.packageManager = { name: 'Cargo', source: 'Cargo.toml', confidence: 'declared' };
  r.install = inferred('cargo fetch', 'Cargo.toml');
  r.build = inferred('cargo build --release', 'Cargo.toml');
  const fws = [['actix-web', 'Actix Web'], ['axum', 'Axum'], ['rocket', 'Rocket'], ['warp', 'Warp']];
  const f = fws.find(([d]) => new RegExp(`^\\s*${d}\\s*=`, 'm').test(t));
  if (f) r.framework = { name: f[1], source: 'Cargo.toml dependency', confidence: 'declared' };
  if (ctx.pathHas('src/main.rs')) {
    r.entry = { path: 'src/main.rs', source: 'cargo convention', confidence: 'inferred' };
    r.start = inferred('cargo run --release', 'src/main.rs');
    r.projectType = f ? 'Backend service / API' : 'Rust application';
  } else r.projectType = 'Rust library';
  if (/^\[workspace\]/m.test(t)) r.warnings.push('Cargo workspace detected. Only the root manifest was analyzed.');
  return r;
}

/* --------------------------- Ruby / PHP / .NET -------------------------- */

function detectRuby(ctx) {
  if (!ctx.has('Gemfile')) return null;
  const t = ctx.read('Gemfile') || '';
  const r = blank('Ruby');
  r.packageFiles.push('Gemfile');
  r.packageManager = { name: 'Bundler', source: 'Gemfile', confidence: 'declared' };
  r.install = declared('bundle install', 'Gemfile');
  const rv = (t.match(/^\s*ruby\s+["']([^"']+)["']/m) || [])[1];
  if (rv) r.runtimeVersion = { value: rv, source: 'Gemfile' };
  if (/gem\s+["']rails["']/.test(t)) {
    r.framework = { name: 'Rails', source: 'rails in Gemfile', confidence: 'declared' };
    r.projectType = 'Web application';
    if (ctx.pathHas('bin/rails')) r.start = inferred('bin/rails server -b 0.0.0.0', 'bin/rails');
  } else if (/gem\s+["']sinatra["']/.test(t)) {
    r.framework = { name: 'Sinatra', source: 'sinatra in Gemfile', confidence: 'declared' };
    r.projectType = 'Web application';
    if (ctx.pathHas('config.ru')) r.start = inferred('bundle exec rackup', 'config.ru');
  } else r.projectType = 'Ruby application or gem';
  return r;
}

function detectPhp(ctx) {
  if (!ctx.has('composer.json')) return null;
  let c = null;
  try {
    c = JSON.parse(ctx.read('composer.json'));
  } catch {
    /* ignore */
  }
  const r = blank('PHP');
  r.packageFiles.push('composer.json');
  r.packageManager = { name: 'Composer', source: 'composer.json', confidence: 'declared' };
  r.install = declared('composer install', 'composer.json');
  if (!c) {
    r.warnings.push('composer.json could not be parsed as JSON.');
    return r;
  }
  r.name = c.name || null;
  const req = Object.keys(c.require || {});
  r.runtimeDeps = req;
  if (req.includes('laravel/framework')) {
    r.framework = { name: 'Laravel', source: 'laravel/framework in composer.json', confidence: 'declared' };
    r.projectType = 'Web application';
    if (ctx.pathHas('artisan')) r.start = inferred('php artisan serve --host=0.0.0.0', 'artisan');
  } else if (req.some((d) => d.startsWith('symfony/framework-bundle'))) {
    r.framework = { name: 'Symfony', source: 'symfony/framework-bundle', confidence: 'declared' };
    r.projectType = 'Web application';
  } else r.projectType = 'PHP application or library';
  if (c.require && c.require.php) r.runtimeVersion = { value: c.require.php, source: 'composer.json require.php' };
  return r;
}

function detectDotnet(ctx) {
  const proj = ctx.list('').find((p) => /^[^/]+\.csproj$/.test(p));
  if (!proj) return null;
  const t = ctx.read(proj) || '';
  const r = blank('.NET');
  r.packageFiles.push(proj);
  r.packageManager = { name: 'NuGet', source: proj, confidence: 'declared' };
  r.install = inferred('dotnet restore', proj);
  r.build = inferred('dotnet build -c Release', proj);
  const tf = (t.match(/<TargetFramework>([^<]+)</) || [])[1];
  if (tf) r.runtimeVersion = { value: tf, source: proj };
  if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(t)) {
    r.framework = { name: 'ASP.NET Core', source: 'Microsoft.NET.Sdk.Web', confidence: 'declared' };
    r.projectType = 'Web application';
    r.start = inferred('dotnet run', proj);
  } else r.projectType = '.NET application or library';
  return r;
}

const DETECTORS = [detectNode, detectPython, detectJava, detectGo, detectRust, detectRuby, detectPhp, detectDotnet];

module.exports = { DETECTORS, parseRequirements, parsePyproject };
