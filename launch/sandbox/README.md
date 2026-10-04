# ONECLICK sandbox

Runs an untrusted public GitHub repository inside a locked-down Docker container and exposes the
running app on a `127.0.0.1` port. **Off by default.** Repository code never runs in the Launch API
process.

## Setup

```
cd D:\ONECLICK\launch
npm run sandbox:build            # builds oneclick-sandbox:latest
npm run sandbox:run -- https://github.com/owner/repo      # try it from the terminal
```

To enable the HTTP API:

```
set SANDBOX_ENABLED=1
set SANDBOX_TOKEN=<16+ random characters>
set SANDBOX_ALLOWED_ORIGINS=http://localhost:5173     # only if a browser UI calls it
npm start
```

Other settings (all optional): `SANDBOX_IMAGE`, `SANDBOX_DOCKER`, `SANDBOX_NETWORK`, `SANDBOX_MEMORY` (2g),
`SANDBOX_CPUS` (1), `SANDBOX_PIDS` (512), `SANDBOX_MAX_RUNS` (2), `SANDBOX_TTL_SEC` (900),
`SANDBOX_READY_TIMEOUT_SEC` (300), `SANDBOX_ALLOWED_HOSTS`, `SANDBOX_RATE_LIMIT_PER_MIN` (5).

## API (all need `Authorization: Bearer <token>`)

| Call | Purpose |
| --- | --- |
| `GET /api/sandbox/status` | Docker/image availability and limits |
| `POST /api/sandbox/runs` `{"url", "env"?}` | Analyze, then start a run (202 + snapshot) |
| `GET /api/sandbox/runs/:id?since=N` | Status plus log lines from index N (poll this) |
| `DELETE /api/sandbox/runs/:id` | Stop the run |

A run is `ready` and gets a `previewUrl` only once the host itself gets an HTTP response from the app.

## What is supported

Node.js (npm, pnpm, yarn), Python with pip, and static sites. Bun, poetry/uv/pipenv, Go, Rust, Java,
Ruby, PHP, .NET, Electron, Dockerfile-only projects and libraries are refused with a reason.

## Isolation

Per run: unprivileged user, all capabilities dropped, `no-new-privileges`, read-only root filesystem,
tmpfs workspace, memory/CPU/PID limits, no swap, no volumes, one published port bound to `127.0.0.1`,
hard time limit, secrets passed via a temporary env file (not argv). The API checks the Host header
(DNS rebinding), the Origin header, and a constant-time token compare.

## Known limits (read before exposing this)

- **Outbound network is open** so `git clone` and package installs work. A malicious repo can reach the
  internet and, depending on your network, other machines on your LAN. For anything beyond personal use,
  run it on a separate machine/VM or point `SANDBOX_NETWORK` at a network with egress filtering.
- Containers share the host kernel. This is hardening, not a VM boundary.
- Log markers are advisory; readiness and exit status are decided by the host.
- The preview URL is `127.0.0.1` on the machine running the API, so it only works locally.
  Public hosting needs a reverse proxy with its own auth.
- Not yet verified against a real Docker daemon (see status notes).
