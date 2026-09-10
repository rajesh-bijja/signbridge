# SignBridge — React + Express + Socket.IO
#
# The base tag tracks the Node 20 LTS line rather than pinning a patch release.
# It was pinned to 20.4.0 (July 2023), which quietly meant the container shipped
# every Node CVE fixed since — auditing npm dependencies while the runtime itself
# is two years stale is auditing the wrong half. Tracking the line means a rebuild
# picks up the current patch; pin one here only alongside a way to notice it aged.
#
# bookworm, not bullseye: Debian 11's security suite has passed end of support, so
# `apt-get update` now fails outright on an expired Release file — a build that
# cannot be rebuilt is also a build that cannot be patched. The sandbox image is
# already on bookworm.
FROM node:20-bookworm AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm

ARG TARGETPLATFORM
ARG BUILDPLATFORM

# NODE_TLS_REJECT_UNAUTHORIZED is deliberately NOT set here. It used to be 0, to
# let the app call its own self-signed HTTPS endpoint — but it is process-global,
# so it also switched off certificate verification for every *outbound* call: STS,
# IAM, S3, EKS, and whichever LLM provider is answering. On a network where someone
# can answer for those hostnames, that turns a signing tool into a credential
# donation, and nothing anywhere reports it. It is also unnecessary: each loopback
# self-call builds its own https.Agent with rejectUnauthorized:false (mcp/server.js,
# mcp/mcpHttp.mjs, lib/chat/agent.js), which is scoped to exactly those requests.
# lib/chat/cursorAgent.js makes the same argument in prose and deletes this variable
# from the CLI's environment, using NODE_EXTRA_CA_CERTS to *add* a trust anchor.
ENV TERM=xterm \
    APP_USR=www-data \
    APP_GRP=www-data \
    APP_HOME=/var/www \
    HOME=/var/www \
    AWS_PAGER="" \
    CONFIG_PROFILES_DIR=/config/profiles \
    APP_DIR=/usr/src/app

RUN mkdir -p $CONFIG_PROFILES_DIR $APP_DIR \
    && mkdir -p $APP_HOME/.aws/sso/cache $APP_HOME/.npm $APP_HOME/.cache \
    && chown -R $APP_USR:$APP_GRP $APP_HOME/.npm $APP_HOME/.cache \
    && chmod -R 755 $APP_HOME/.npm $APP_HOME/.cache

# vim and groff are for reading AWS CLI output interactively (`docker exec`); gosu
# drops privileges in the entrypoint; the rest is what fetches the CLI below.
# Python is not installed: nothing in this image uses it (Sandbox mode's Python
# lives in the separate sandbox image), and the pip it used to upgrade was dead
# weight carrying its own advisories.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends vim groff unzip curl ca-certificates gosu \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Docker CLI (client only — no daemon). Sandbox mode runs user code in a
# throwaway sibling container, which means this process needs to talk to the
# HOST's Docker daemon over the socket that compose bind-mounts in. Installing
# the full docker.io package would drag in a daemon we never start, so take just
# the static client binary.
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then DOCKER_ARCH=aarch64; else DOCKER_ARCH=x86_64; fi && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-27.3.1.tgz" -o docker.tgz && \
    tar -xzf docker.tgz --strip-components=1 -C /usr/local/bin docker/docker && \
    rm -f docker.tgz && \
    docker --version

RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
      curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o awscliv2.zip; \
    else \
      curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o awscliv2.zip; \
    fi && \
    unzip awscliv2.zip && \
    ./aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update && \
    rm -rf awscliv2.zip ./aws

# Cursor agent CLI. The Cursor AI provider has no chat-completions endpoint, so
# SignBridge answers those turns by spawning this CLI and handing it SignBridge's
# own MCP tools — which means the binary has to exist in THIS image, not on the
# user's laptop. The installer drops a versioned binary under
# $HOME/.local/share/cursor-agent and symlinks it into $HOME/.local/bin; the extra
# symlink into /usr/local/bin is so a bare `agent` resolves whatever PATH the app
# user ends up with.
#
# Best-effort on purpose: a network hiccup or an unsupported architecture must not
# fail the build for the eleven providers that do not need it. If it is missing,
# Settings -> AI features -> Test connection says so and no other feature notices.
ARG INSTALL_CURSOR_CLI=1
RUN if [ "$INSTALL_CURSOR_CLI" = "1" ]; then \
      (curl https://cursor.com/install -fsS | bash) || echo "WARNING: Cursor CLI install failed; the Cursor AI provider will report itself unavailable."; \
      if [ -x "$APP_HOME/.local/bin/agent" ]; then \
        ln -sf "$(readlink -f $APP_HOME/.local/bin/agent)" /usr/local/bin/agent && agent --version; \
      fi; \
    fi

COPY package.json package-lock.json ./
WORKDIR $APP_DIR
RUN npm ci --omit=dev

COPY . .
COPY --from=frontend-build /frontend/dist ./frontend/dist

# The MCP server's own dependencies. It is a separate package (mcp/package.json)
# because it is also publishable as a standalone stdio server, so the root install
# above does not cover it. Without these the Cursor backend would start an agent
# with zero tools — a failure with no visible cause.
RUN cd mcp && npm ci --omit=dev

RUN chmod +x docker-entrypoint.sh \
    && chown -R $APP_USR:$APP_GRP $APP_DIR $APP_HOME $CONFIG_PROFILES_DIR \
    && chmod -R 755 $APP_DIR $CONFIG_PROFILES_DIR

# 2443 is the app (HTTPS); 2444 serves only the MCP endpoint, without TLS, for MCP
# clients that reject a self-signed certificate. See [server] mcpHttpPort.
EXPOSE 2443 2444
ENTRYPOINT ["/usr/src/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
