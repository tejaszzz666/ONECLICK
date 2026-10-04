# ONECLICK sandbox image. Runs untrusted GitHub repositories.
# Build:  npm run sandbox:build   (from D:\ONECLICK\launch)
#
# Contains: git, Node.js 22 (+corepack for pnpm/yarn), Python 3 (+venv/pip), a C toolchain
# for native modules. It contains NO ONECLICK code, NO secrets and NO credentials.
# Supported stacks in this image: Node.js, Python (pip), static sites.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

COPY run.sh listen.py /opt/sandbox/
# Strip CRLF in case git on Windows converted line endings, then make the scripts executable.
RUN sed -i 's/\r$//' /opt/sandbox/run.sh /opt/sandbox/listen.py \
 && chmod 755 /opt/sandbox/run.sh /opt/sandbox/listen.py \
 && mkdir -p /workspace /home/node \
 && chown 1000:1000 /workspace /home/node

# The base image already ships an unprivileged "node" user (uid 1000). Always run as it.
USER 1000:1000
WORKDIR /workspace
ENV HOME=/home/node \
    GIT_TERMINAL_PROMPT=0 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    PYTHONUNBUFFERED=1

# The only port the host ever publishes. listen.py bridges it to whatever port the app uses.
EXPOSE 8080
ENTRYPOINT ["/opt/sandbox/run.sh"]
