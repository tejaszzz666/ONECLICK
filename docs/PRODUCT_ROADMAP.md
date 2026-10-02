# Product roadmap

Build one product at a time. Only Launch has any implementation, and it is a simulation.

## 1. OneClick Launch
- **Purpose**: GitHub repository → running application
- **Input**: repository URL
- **Output**: RUNNING status, URL, logs, diagnostics
- **Status**: simulated preview only
- **MVP**: analyse a public repo (language, framework, package manager, dependencies, env vars, build/start commands) and show a real report; then run it in an isolated sandbox with streamed logs and a URL
- **Advanced**: private repos, required services (databases), env var prompts, failure diagnosis, multi-service apps
- **Environment idea**: repository → machine → running application

## 2. OneClick Reframe
- **Purpose**: UI reference → code → editable/reimagined UI
- **Input**: screenshot or design reference
- **Output**: editable frontend, remixed rather than copied
- **Status**: concept
- **MVP**: one screenshot → structured layer/component breakdown → editable code
- **Advanced**: redesign variants, design-token extraction
- **Environment idea**: reference → UI layers → reconstructed interface

## 3. OneClick DevLens
- **Purpose**: codebase → interactive visual understanding
- **Input**: repository or folder
- **Output**: explorable map of files, functions, APIs, databases, auth, dependencies
- **Status**: concept
- **MVP**: static analysis of one language into a dependency graph
- **Advanced**: cross-language, runtime data, change impact
- **Environment idea**: codebase → dependency galaxy

## 4. OneClick Fix
- **Purpose**: error → explanation → actionable fix
- **Input**: error, stack trace or screenshot
- **Output**: plain explanation and concrete fix steps
- **Status**: concept
- **MVP**: paste a stack trace → explanation and suggested fix
- **Advanced**: repo-aware fixes, screenshot input
- **Environment idea**: broken system → diagnosis → repaired system

## 5. OneClick API
- **Purpose**: structured data → API / database / docs / SDK / mock endpoint
- **Input**: JSON, CSV or schema
- **Output**: inferred schema, working mock endpoint, documentation
- **Status**: concept
- **MVP**: JSON → schema + mock endpoint + docs
- **Advanced**: real database, generated SDKs
- **Environment idea**: raw data → schema → endpoint → documentation

## 6. OneClick Convert
- **Purpose**: useful file/data transformations
- **Input**: a file
- **Output**: the format or shape the user actually needs
- **Status**: concept
- **MVP**: a small set of client-side conversions
- **Advanced**: chained transformations, batch jobs
- **Environment idea**: input → transformation → output
