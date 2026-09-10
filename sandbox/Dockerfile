# SignBridge Sandbox execution image
#
# The throwaway container that Sandbox mode runs user code in. One image covers
# all four languages so a user can switch language without waiting for anything
# to install, and so the container needs no network access to a package registry
# at run time (which is also what makes the sandbox usable in an air-gapped
# deployment).
#
# Contents
#   Python 3      boto3, botocore, requests, urllib3
#   Node 20       @aws-sdk/* v3, aws-sdk v2, axios, typescript, tsx, @types/node
#   Java 17       AWS SDK v2 (sts, ec2, s3, dynamodb, lambda, ... see pom.xml)
#
# Build:  ./sandbox/build-sandbox-image.sh
#         (or: docker build -t signbridge-sandbox:latest sandbox/)
#
# This image is never long-running: sandboxRunner.js starts a fresh container
# per run with --rm, a read-only workspace, a tmpfs /tmp, capped memory/CPU/pids,
# all capabilities dropped, and no-new-privileges.

# ---------------------------------------------------------------------------
# Stage 1: resolve the AWS SDK for Java v2 jars
# ---------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-17 AS javadeps

WORKDIR /build
COPY pom.xml /build/pom.xml

# Pin the SDK version if you need reproducible builds; leave it empty and the
# build resolves whatever Maven Central currently marks as the release, falling
# back to the pom's default if that lookup fails (e.g. offline build).
ARG AWS_SDK_VERSION=""

RUN set -eux; \
    version="${AWS_SDK_VERSION}"; \
    if [ -z "$version" ]; then \
        version="$(curl -fsS --max-time 30 \
            https://repo1.maven.org/maven2/software/amazon/awssdk/bom/maven-metadata.xml \
            | sed -n 's:.*<release>\(.*\)</release>.*:\1:p' | head -1 || true)"; \
    fi; \
    if [ -n "$version" ]; then \
        echo "Using AWS SDK for Java v2 ${version}"; \
        mvn -B -q -Daws.sdk.version="${version}" \
            dependency:copy-dependencies \
            -DoutputDirectory=/jars -DincludeScope=runtime; \
    else \
        echo "Could not resolve the current AWS SDK release; using the pom default"; \
        mvn -B -q dependency:copy-dependencies \
            -DoutputDirectory=/jars -DincludeScope=runtime; \
    fi; \
    ls -1 /jars | wc -l

# ---------------------------------------------------------------------------
# Stage 2: the runtime image
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="SignBridge Sandbox" \
      org.opencontainers.image.description="Multi-language execution sandbox for SignBridge Sandbox mode" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LANG=C.UTF-8

# Python and the JDK. ca-certificates is what lets the SDKs verify AWS TLS certs.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-pip \
        openjdk-17-jdk-headless; \
    rm -rf /var/lib/apt/lists/*; \
    ln -sf /usr/bin/python3 /usr/local/bin/python

# Python libraries. --break-system-packages is required on Debian bookworm
# (PEP 668); in a single-purpose throwaway image there is no system Python
# environment worth protecting.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
        boto3 \
        botocore \
        requests \
        urllib3

# Node libraries, reachable from /workspace as bare specifiers.
#
# Node's ESM loader ignores NODE_PATH and resolves a bare specifier by walking
# node_modules directories upward from the importing file. User code lives at
# /workspace/main.mjs, so the packages have to be visible at /node_modules for
# both ESM and CommonJS to find them. npm itself refuses to install into `/`
# ("Tracker idealTree already exists"), so the install happens in a normal
# directory and /node_modules is a symlink to it.
WORKDIR /opt/sandbox-node
RUN set -eux; \
    npm init -y > /dev/null; \
    npm install --no-audit --no-fund --omit=dev \
        @aws-sdk/client-sts \
        @aws-sdk/client-ec2 \
        @aws-sdk/client-s3 \
        @aws-sdk/client-dynamodb \
        @aws-sdk/lib-dynamodb \
        @aws-sdk/client-lambda \
        @aws-sdk/client-sqs \
        @aws-sdk/client-sns \
        @aws-sdk/client-iam \
        @aws-sdk/client-ssm \
        @aws-sdk/client-secrets-manager \
        @aws-sdk/client-cloudwatch \
        @aws-sdk/client-cloudwatch-logs \
        @aws-sdk/client-kms \
        @aws-sdk/client-api-gateway \
        @aws-sdk/client-eventbridge \
        @aws-sdk/client-sfn \
        @aws-sdk/client-bedrock-runtime \
        @aws-sdk/credential-providers \
        @aws-sdk/s3-request-presigner \
        @aws-sdk/signature-v4 \
        aws-sdk \
        axios \
        @types/node; \
    npm cache clean --force; \
    ln -s /opt/sandbox-node/node_modules /node_modules; \
    mkdir -p /probe; \
    printf 'import "@aws-sdk/client-sts";\nconsole.log("esm resolution ok");\n' > /probe/probe.mjs; \
    node /probe/probe.mjs; \
    rm -rf /probe

# TypeScript toolchain: `tsx` runs a .ts file directly (and understands
# top-level await), `tsc` provides the real type check behind the Validate action.
RUN npm install -g --no-audit --no-fund typescript tsx && npm cache clean --force

# AWS SDK for Java v2 on the default CLASSPATH, so `java /workspace/Main.java`
# compiles and runs with no build file. The trailing '.' keeps the user's own
# directory on the path.
COPY --from=javadeps /jars /opt/aws-java/lib
ENV CLASSPATH="/opt/aws-java/lib/*:."

# The JVM tuning flags that keep java inside the container's memory cap and start
# fast are passed on the command line by sandboxRuntimes.js, NOT set here as
# JAVA_TOOL_OPTIONS/JDK_JAVA_OPTIONS: those make the JVM print a "Picked up ..."
# line to stderr on every single run, which would show up in the user's console
# output as if their code had emitted it.

# Quieter, more predictable SDK defaults for interactive use.
ENV AWS_PAGER="" \
    AWS_EC2_METADATA_DISABLED=true \
    NODE_OPTIONS="--no-warnings"

# Run as a non-root user. Every capability is already dropped by the runner, but
# defence in depth costs nothing here. HOME is set to /tmp by the runner because
# /tmp is the only writable mount.
RUN groupadd --gid 2000 sandboxer \
    && useradd --uid 2000 --gid 2000 --no-create-home --shell /usr/sbin/nologin sandboxer
USER sandboxer

# The runner bind-mounts the per-run workspace here, read-only.
WORKDIR /workspace

# Running the image with no command prints what it contains — a quick way to
# verify a build without starting a real run.
CMD ["sh", "-c", "echo 'SignBridge sandbox image'; python3 --version; node --version; tsc --version; java --version | head -1; python3 -c 'import boto3; print(\"boto3\", boto3.__version__)'"]
