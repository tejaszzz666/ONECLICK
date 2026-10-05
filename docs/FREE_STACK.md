# Free-tier plan for the whole ecosystem

**Rule:** the server does only cheap, read-only work. Anything heavy or untrusted runs in the visitor's
browser or on the visitor's own free accounts. This keeps hosting at $0 and keeps us out of the business
of executing strangers' code.

Hosting: site on Vercel (free), API on Render (free, 512 MB, sleeps when idle). Render cannot run Docker
containers from inside a service, so the Docker sandbox (`launch/sandbox/`) is a **local / self-hosted
mode only**, not part of the free deployment.

| Product | Where it runs (free) | Needs | Status |
|---|---|---|---|
| **Launch** | Analysis: Render API + GitHub API. Running: links that open StackBlitz (Node.js, in the visitor's browser), GitHub Codespaces (visitor's own quota, any stack) or a Vercel deploy (visitor's account), each in a new tab. | `GITHUB_TOKEN` on Render | Analysis + runner links built. Inline embedding was tried and dropped (see below). Python, native modules and databases are Codespaces-only. |
| **Convert** | 100% in the page: FileReader, canvas, CompressionStream, small JS libs. | nothing | Not built. **Best next build**: zero server, zero cost. |
| **API** | Inference and docs in the page (JSON/CSV to schema, OpenAPI file, docs). A *hosted* mock endpoint needs storage; free options are an in-memory, expiring mock on the Render API, or a downloadable mock server. | optional Render route | Not built. |
| **DevLens** | Render API reads the repo tree through the GitHub API and parses imports (JS/TS, Python first); the existing Three.js scene draws the graph. Cap files and bytes per request. | `GITHUB_TOKEN` | Not built. Reuses Launch's GitHub client. |
| **Fix** | Rule-based stack-trace parser in the page covers common errors. A real explanation engine needs an LLM, which is not free server-side; option: the visitor supplies their own API key, kept only in their browser. | optional BYO key | Not built. |
| **Reframe** | Needs a vision model. Same BYO-key option; a client-side canvas pass could extract colors and layout as a cheaper first step. | optional BYO key | Not built. Last. |

## Honest limits
- StackBlitz needs a Chromium browser for the best experience and cannot run native Node modules or
  Python. Free-tier terms of third parties can change; check them before depending on them commercially.
- Codespaces needs the visitor to have a GitHub account.
- Inline StackBlitz embedding does not work reliably: StackBlitz's own tracker has open reports of the
  "embedded without proper isolation headers" error even on correctly isolated pages. Do not retry it
  without checking those issues first (stackblitz/webcontainer-core #2045, stackblitz/sdk #37).
