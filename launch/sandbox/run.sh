#!/bin/bash
# ONECLICK sandbox entrypoint. Runs inside the container as uid 1000.
#
# stdin, line 1 : per-run marker token. It is read into a shell variable and is never put in the
#                 environment, so repository code cannot read it from its env.
# environment   : SANDBOX_* values written by the host from a validated job (see lib/sandbox/plan.js).
#
# Status lines look like "@@ONECLICK@@<token> PHASE clone" / "FAIL <phase> <reason>" / "EXIT <code>".
# They are advisory only. The host also uses the container exit code and probes the port itself,
# so a repository that prints fake markers can at worst confuse its own log view.
set -u

IFS= read -r TOKEN || TOKEN=
if ! [[ "$TOKEN" =~ ^[0-9a-f]{32}$ ]]; then
  echo "sandbox: missing or malformed run token" >&2
  exit 64
fi

mark() { printf '@@ONECLICK@@%s %s\n' "$TOKEN" "$*"; }
fail() { mark "FAIL $1 $2"; exit "${3:-1}"; }

REPO="${SANDBOX_REPO:-}"
REF="${SANDBOX_REF:-}"
ROOT="${SANDBOX_ROOT:-.}"
RUNTIME="${SANDBOX_RUNTIME:-}"
INSTALL="${SANDBOX_INSTALL:-}"
BUILD="${SANDBOX_BUILD:-}"
START="${SANDBOX_START:-}"
STATIC_DIR="${SANDBOX_STATIC_DIR:-}"
CLONE_T="${SANDBOX_CLONE_TIMEOUT:-120}"
INSTALL_T="${SANDBOX_INSTALL_TIMEOUT:-600}"
BUILD_T="${SANDBOX_BUILD_TIMEOUT:-600}"
# Repository code must not see the job description.
unset ${!SANDBOX_@}

for t in CLONE_T INSTALL_T BUILD_T; do
  [[ "${!t}" =~ ^[0-9]{1,4}$ ]] || printf -v "$t" '%s' 600
done

# ---- re-validate everything the host sent (defence in depth) ----
[[ "$REPO" =~ ^https://github\.com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]] || fail setup invalid_repo 64
[[ "$REPO" != */. && "$REPO" != */.. ]] || fail setup invalid_repo 64
[[ -z "$REF" || "$REF" =~ ^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$ ]] || fail setup invalid_ref 64
is_rel_dir() { [[ "$1" == "." ]] || { [[ "$1" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] && [[ "$1" != -* && "$1" != *..* ]]; }; }
is_rel_dir "$ROOT" || fail setup invalid_root 64
[[ -z "$STATIC_DIR" ]] || is_rel_dir "$STATIC_DIR" || fail setup invalid_static_dir 64
case "$RUNTIME" in node | python | static) ;; *) fail setup invalid_runtime 64 ;; esac

# ---- clone ----
mark "PHASE clone"
export GIT_ALLOW_PROTOCOL=https GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
clone_args=(clone --depth 1 --single-branch --no-tags --no-recurse-submodules)
if [[ -n "$REF" ]]; then clone_args+=(--branch "$REF"); fi
timeout -k 5 "$CLONE_T" git -c credential.helper= -c core.hooksPath=/dev/null "${clone_args[@]}" -- "$REPO.git" /workspace/repo </dev/null
rc=$?
if [ "$rc" -eq 124 ]; then fail clone timeout 124; fi
if [ "$rc" -ne 0 ]; then fail clone "exit:$rc" "$rc"; fi

WORK=/workspace/repo
if [[ "$ROOT" != "." ]]; then WORK="$WORK/$ROOT"; fi
cd "$WORK" 2>/dev/null || fail setup missing_root 66
real="$(pwd -P)"
[[ "$real" == /workspace/repo || "$real" == /workspace/repo/* ]] || fail setup bad_root 66

# ---- environment for the app ----
if [[ "$RUNTIME" == python ]]; then
  python3 -m venv /workspace/venv </dev/null || fail setup venv 70
  export VIRTUAL_ENV=/workspace/venv
  export PATH="/workspace/venv/bin:$PATH"
fi
export BROWSER=none STREAMLIT_SERVER_HEADLESS=true STREAMLIT_BROWSER_GATHER_USAGE_STATS=false
: "${PORT:=3000}"
export PORT

run_phase() { # <phase> <seconds> <command>
  mark "PHASE $1"
  timeout -k 10 "$2" bash -c "$3" </dev/null
  local r=$?
  if [ "$r" -eq 124 ]; then fail "$1" timeout 124; fi
  if [ "$r" -ne 0 ]; then fail "$1" "exit:$r" "$r"; fi
}

if [[ -n "$INSTALL" ]]; then run_phase install "$INSTALL_T" "$INSTALL"; fi
if [[ -n "$BUILD" ]]; then run_phase build "$BUILD_T" "$BUILD"; fi

# ---- start ----
if [[ -n "$STATIC_DIR" && ! -d "$WORK/$STATIC_DIR" ]]; then fail build missing_output 66; fi
if [[ -z "$STATIC_DIR" && -z "$START" ]]; then fail start no_command 66; fi

mark "PHASE start"
python3 /opt/sandbox/listen.py &
BRIDGE=$!
APP=
trap 'kill -TERM "$APP" 2>/dev/null; kill -TERM "$BRIDGE" 2>/dev/null; exit 143' TERM INT

if [[ -n "$STATIC_DIR" ]]; then
  python3 -m http.server 8000 --bind 127.0.0.1 --directory "$WORK/$STATIC_DIR" </dev/null &
else
  bash -c "$START" </dev/null &
fi
APP=$!
wait "$APP"
rc=$?
kill -TERM "$BRIDGE" 2>/dev/null
mark "EXIT $rc"
if [ "$rc" -ne 0 ]; then mark "FAIL start exit:$rc"; fi
exit "$rc"
