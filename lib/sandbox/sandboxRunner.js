"use strict";

/**
 * sandboxRunner.js
 *
 * Executes user code inside a throwaway Docker container and streams the output
 * back live. This is the only module in the sandbox that touches the filesystem
 * or spawns processes; everything it decides (argv, limits, diagnostics) comes
 * from the pure modules beside it.
 *
 * How a run works
 *   1. The user's code is written to a fresh per-run workspace directory under
 *      their artifacts dir.
 *   2. `docker run` mounts that directory READ-ONLY at /workspace, with a
 *      tmpfs /tmp for scratch, and executes the runtime's argv.
 *   3. stdout/stderr are streamed to the caller chunk by chunk (the UI relays
 *      them over Socket.IO, so output appears as it is produced).
 *   4. On exit — or timeout, or cancel — the container is removed (`--rm`) and
 *      the workspace directory is deleted.
 *
 * Isolation & safety
 *   - Fresh container per run, `--rm`, no reuse between runs or users.
 *   - Read-only workspace mount; writable scratch is a size-capped tmpfs.
 *   - Memory / CPU / process-count caps, all capabilities dropped, and
 *     no-new-privileges, so user code cannot escalate inside the container.
 *   - `check` runs get `--network none`: a syntax check never needs the network.
 *   - A hard wall-clock timeout kills runaway code.
 *   - Per-user concurrency cap, so a page full of clicks cannot fork-bomb the
 *     Docker daemon.
 *
 * Credential handling
 *   Secrets are passed to the container by NAME only (`docker run -e VAR`, with
 *   no `=value`), taking the value from the environment of the spawned docker
 *   process. Nothing secret is ever written to disk or visible in the host
 *   process table. See sandboxCredentials.js for the full rules.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const propertiesReader = require('properties-reader');
const { randomUUID: uuidv4 } = require('crypto');

const paths = require('../paths');
const sandboxRuntimes = require('./sandboxRuntimes');
let log = require('../logger').create('sandbox/sandboxRunner');

const props = propertiesReader(path.resolve(__dirname, '../../config.properties'));

function prop(key, fallback) {
    let value = props.get(key);
    return value === null || value === undefined || value === '' ? fallback : value;
}

// ---------------------------------------------------------------------------
// Configuration ([sandbox] section of config.properties, env-overridable)
// ---------------------------------------------------------------------------

const IMAGE = process.env.SANDBOX_IMAGE || prop('sandbox.image', 'signbridge-sandbox:latest');
const DOCKER_BIN = process.env.SANDBOX_DOCKER_BIN || prop('sandbox.dockerBin', 'docker');
const RUNS_DIR_NAME = prop('sandbox.runsDirName', 'sandboxruns');
// Host path that is bind-mounted into this process as paths.getBaseDir(). Only
// set when SignBridge runs in a container; see toHostPath().
const HOST_BASE_DIR = process.env.SANDBOX_HOST_BASE_DIR || prop('sandbox.hostBaseDir', '');

const DEFAULT_TIMEOUT_MS = parseInt(prop('sandbox.timeoutSeconds', 60), 10) * 1000;
const CHECK_TIMEOUT_MS = parseInt(prop('sandbox.checkTimeoutSeconds', 30), 10) * 1000;
const MEMORY_LIMIT = prop('sandbox.memoryLimit', '768m');
const CPU_LIMIT = String(prop('sandbox.cpuLimit', '1.0'));
const PIDS_LIMIT = String(prop('sandbox.pidsLimit', 256));
const TMPFS_SIZE = prop('sandbox.tmpfsSize', '128m');
const MAX_OUTPUT_BYTES = parseInt(prop('sandbox.maxOutputBytes', 1048576), 10);
const MAX_CONCURRENT_RUNS_PER_USER = parseInt(prop('sandbox.maxConcurrentRunsPerUser', 3), 10);
const MAX_CODE_BYTES = parseInt(prop('sandbox.maxCodeBytes', 262144), 10);

// ---------------------------------------------------------------------------
// Active-run registry (for cancel + concurrency accounting)
// ---------------------------------------------------------------------------

// runId -> { userName, containerName, child, timer, cancelled, timedOut }
const activeRuns = Object.create(null);

function activeRunCountForUser(userName) {
    let count = 0;
    for (let runId of Object.keys(activeRuns)) {
        if (activeRuns[runId].userName === userName) {
            count += 1;
        }
    }
    return count;
}

// ---------------------------------------------------------------------------
// Docker / image preflight
// ---------------------------------------------------------------------------

// Cached preflight result, so we don't shell out on every keystroke-triggered
// validate. Cleared periodically so a newly built image is picked up without a
// server restart.
let preflightCache = null;
const PREFLIGHT_TTL_MS = 30 * 1000;

function runDockerProbe(args, cb) {
    let child;
    try {
        child = spawn(DOCKER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return cb(e);
    }
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', function (d) { stdout += d.toString(); });
    child.stderr.on('data', function (d) { stderr += d.toString(); });
    child.on('error', function (err) { cb(err); });
    child.on('close', function (code) {
        cb(null, { code: code, stdout: stdout, stderr: stderr });
    });
}

/**
 * Check that the Docker daemon is reachable and the sandbox image exists.
 * cb(null, { ok, dockerAvailable, imageAvailable, image, message })
 *
 * Never returns an error for "not set up" — that is a normal, reportable state
 * with an actionable message, not an exception.
 */
function preflight(cb) {
    if (preflightCache && (Date.now() - preflightCache.at) < PREFLIGHT_TTL_MS) {
        return cb(null, preflightCache.value);
    }

    runDockerProbe(['version', '--format', '{{.Server.Version}}'], function (dockerErr, dockerResult) {
        if (dockerErr || !dockerResult || dockerResult.code !== 0) {
            let reason = dockerErr && dockerErr.code === 'ENOENT'
                ? 'The "' + DOCKER_BIN + '" command was not found on the server.'
                : 'The Docker daemon did not respond.';
            let value = {
                ok: false,
                dockerAvailable: false,
                imageAvailable: false,
                image: IMAGE,
                message: 'Sandbox mode needs Docker. ' + reason +
                    ' If SignBridge itself runs in a container, mount the Docker socket ' +
                    '(-v /var/run/docker.sock:/var/run/docker.sock) so it can start sibling ' +
                    'sandbox containers.'
            };
            preflightCache = { at: Date.now(), value: value };
            return cb(null, value);
        }

        runDockerProbe(['image', 'inspect', IMAGE], function (imageErr, imageResult) {
            let imageAvailable = !imageErr && imageResult && imageResult.code === 0;
            let value = {
                ok: imageAvailable,
                dockerAvailable: true,
                imageAvailable: imageAvailable,
                image: IMAGE,
                dockerVersion: (dockerResult.stdout || '').trim(),
                message: imageAvailable
                    ? null
                    : 'The sandbox image "' + IMAGE + '" is not built yet. Build it once with: ' +
                      './sandbox/build-sandbox-image.sh   (or: docker build -t ' + IMAGE + ' sandbox/)'
            };
            preflightCache = { at: Date.now(), value: value };
            cb(null, value);
        });
    });
}

// Invalidate the cached preflight (used after a build, or on an image-missing
// run failure, so the next probe re-checks immediately).
function invalidatePreflight() {
    preflightCache = null;
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

function runsBaseDir(userName) {
    return path.join(paths.getUserDir(String(userName).toLowerCase()), RUNS_DIR_NAME);
}

/**
 * Translate a path in THIS process's filesystem to the equivalent path on the
 * Docker host.
 *
 * `docker run -v <source>:...` is resolved by the daemon, which lives on the
 * host — so <source> must be a host path. When SignBridge itself runs in a
 * container (the primary deployment) the workspace it just wrote is at a
 * container path, and passing that through would make the daemon silently mount
 * a brand-new empty directory: the run would fail with "no such file" even
 * though the code is right there.
 *
 * SANDBOX_HOST_BASE_DIR names the host directory that is bind-mounted here as
 * paths.getBaseDir(); docker-compose sets it from the host's ~/.signbridge.
 * Unset (the local `npm start` case) this is the identity function, because
 * paths already are host paths.
 */
function mapPath(localPath, base, hostBase) {
    if (!hostBase || !localPath) {
        return localPath;
    }
    if (localPath === base) {
        return hostBase;
    }
    // Only rewrite paths that really are under the base dir. Anything else is
    // left alone rather than being spliced onto the host base, which would
    // fabricate a plausible-looking but wrong mount source.
    if (localPath.indexOf(base + path.sep) !== 0) {
        return localPath;
    }
    return path.join(hostBase, localPath.slice(base.length + 1));
}

function toHostPath(localPath) {
    return mapPath(localPath, paths.getBaseDir(), HOST_BASE_DIR);
}

/**
 * Create the per-run workspace and write the user's code into it.
 * Returns the absolute host path of the workspace directory.
 */
function createWorkspace(userName, runtime, code, runId) {
    let workspace = path.join(runsBaseDir(userName), runId);
    fs.mkdirSync(workspace, { recursive: true });
    let codeFile = path.join(workspace, runtime.fileName);
    fs.writeFileSync(codeFile, code, { encoding: 'utf-8', mode: 0o644 });
    return workspace;
}

function removeWorkspace(workspace) {
    if (!workspace) {
        return;
    }
    try {
        fs.rmSync(workspace, { recursive: true, force: true });
    } catch (e) {
        log.warn('sandboxRunner: failed to remove workspace ', workspace, ': ', e.message);
    }
}

/**
 * Best-effort sweep of workspaces left behind by a crash/restart. Called on
 * startup: anything older than an hour cannot belong to a live run.
 */
function cleanupStaleWorkspaces(userName, maxAgeMs) {
    maxAgeMs = maxAgeMs || 60 * 60 * 1000;
    let base = runsBaseDir(userName);
    if (!fs.existsSync(base)) {
        return 0;
    }
    let removed = 0;
    let cutoff = Date.now() - maxAgeMs;
    for (let entry of fs.readdirSync(base)) {
        let full = path.join(base, entry);
        try {
            let stats = fs.statSync(full);
            if (stats.isDirectory() && stats.mtimeMs < cutoff && !activeRuns[entry]) {
                removeWorkspace(full);
                removed += 1;
            }
        } catch (e) {
            // Ignore individual failures — this is opportunistic housekeeping.
        }
    }
    return removed;
}

// ---------------------------------------------------------------------------
// docker run argv construction
// ---------------------------------------------------------------------------

/**
 * Build the full `docker run` argv for a sandbox execution.
 *
 * Pure given its inputs (no fs/spawn), so test/sandboxRunner.test.js can assert
 * the hardening flags and — critically — that no secret VALUE ever appears in
 * the argv: credentials are referenced by name only.
 *
 * @param {object} spec { containerName, workspace, image, argv, envNames,
 *                        network, limits }
 */
function buildDockerArgs(spec) {
    let limits = spec.limits || {};
    let args = [
        'run',
        '--rm',
        '--name', spec.containerName,
        // Read-only workspace: user code is executed, never mutated. Scratch
        // space is the tmpfs below.
        '--volume', spec.workspace + ':' + sandboxRuntimes.WORKSPACE_DIR + ':ro',
        '--workdir', sandboxRuntimes.WORKSPACE_DIR,
        // exec is needed because some toolchains (tsx) write and run temp files.
        '--tmpfs', '/tmp:rw,exec,nosuid,size=' + (limits.tmpfsSize || TMPFS_SIZE),
        // Every part is String()-coerced: this argv is exec'd directly (no
        // shell), and spawn throws on a non-string element. A numeric override
        // would otherwise fail the run with an opaque TypeError.
        '--memory', String(limits.memory || MEMORY_LIMIT),
        // Equal memory and memory-swap disables swap, so the memory cap is real.
        '--memory-swap', String(limits.memory || MEMORY_LIMIT),
        '--cpus', String(limits.cpus || CPU_LIMIT),
        '--pids-limit', String(limits.pidsLimit || PIDS_LIMIT),
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        // No interactive TTY: we want raw, unbuffered pipes for streaming.
        '--attach', 'stdout',
        '--attach', 'stderr'
    ];

    if (spec.network === 'none') {
        args.push('--network', 'none');
    }

    // Reference environment variables by NAME only. The docker CLI takes the
    // value from its own environment, so secrets never enter the argv (and so
    // never appear in `ps` output or any log of this command).
    for (let name of spec.envNames || []) {
        args.push('--env', name);
    }

    args.push(spec.image);
    for (let part of spec.argv) {
        args.push(part);
    }
    return args;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute code in the sandbox.
 *
 * @param {object} options
 *   userName   {string}  required — owns the workspace + concurrency budget
 *   runtimeId  {string}  required — key into sandboxRuntimes
 *   code       {string}  required — the user's source
 *   mode       {string}  'run' (default) or 'check'
 *   env        {object}  environment for the container (from sandboxCredentials)
 *   timeoutMs  {number}  optional override
 *   onOutput   {function} ({ stream:'stdout'|'stderr', chunk, runId }) per chunk
 *   onStart    {function} ({ runId, containerName }) once the container starts
 * @param {function} cb cb(err, result)
 *   result: { runId, exitCode, output, stdout, stderr, durationMs, timedOut,
 *             cancelled, truncated }
 */
function execute(options, cb) {
    let called = false;
    function done(err, result) {
        if (called) {
            return;
        }
        called = true;
        cb(err, result);
    }

    let userName = options && options.userName;
    let runtime = sandboxRuntimes.getRuntime(options && options.runtimeId);
    let mode = (options && options.mode) === 'check' ? 'check' : 'run';
    let code = options && options.code;

    if (!userName) {
        return done(new Error('sandbox: userName is required'));
    }
    if (!runtime) {
        return done(new Error('sandbox: unsupported language "' + (options && options.runtimeId) +
            '". Supported: ' + sandboxRuntimes.listRuntimeIds().join(', ')));
    }
    if (typeof code !== 'string' || code.trim().length === 0) {
        return done(new Error('sandbox: there is no code to execute'));
    }
    if (Buffer.byteLength(code, 'utf-8') > MAX_CODE_BYTES) {
        return done(new Error('sandbox: the file is too large (limit ' +
            Math.floor(MAX_CODE_BYTES / 1024) + ' KB)'));
    }
    if (activeRunCountForUser(userName) >= MAX_CONCURRENT_RUNS_PER_USER) {
        return done(new Error('sandbox: you already have ' + MAX_CONCURRENT_RUNS_PER_USER +
            ' runs in flight. Wait for one to finish, or press Stop.'));
    }

    preflight(function (preflightErr, status) {
        if (preflightErr) {
            return done(preflightErr);
        }
        if (!status.ok) {
            let error = new Error(status.message);
            error.sandboxNotReady = true;
            error.preflight = status;
            return done(error);
        }

        let runId = uuidv4().replace(/-/g, '');
        let containerName = 'signbridge-sandbox-' + runId.slice(0, 16);
        let workspace;
        try {
            workspace = createWorkspace(userName, runtime, code, runId);
        } catch (e) {
            return done(new Error('sandbox: could not prepare the workspace: ' + e.message));
        }

        let containerEnv = Object.assign({}, options.env || {});
        // Keep bytecode/scratch off the read-only workspace mount.
        containerEnv.PYTHONPYCACHEPREFIX = '/tmp/pycache';
        containerEnv.PYTHONDONTWRITEBYTECODE = mode === 'check' ? '' : '1';
        containerEnv.TMPDIR = '/tmp';
        containerEnv.HOME = '/tmp';

        let dockerArgs = buildDockerArgs({
            containerName: containerName,
            // The mount source is resolved by the daemon, so it must be a host
            // path; `workspace` itself stays local for writing and cleanup.
            workspace: toHostPath(workspace),
            image: status.image,
            argv: mode === 'check' ? runtime.checkArgv : runtime.runArgv,
            envNames: Object.keys(containerEnv),
            // A syntax/type check never needs the network; a run usually does.
            network: mode === 'check' ? 'none' : 'default',
            limits: options.limits
        });

        // The docker CLI inherits the secret VALUES from this spawn env and
        // forwards them by name. This is the only place they exist outside
        // sandboxCredentials' return value.
        let spawnEnv = Object.assign({}, process.env, containerEnv);

        let startedAt = Date.now();
        let child;
        try {
            child = spawn(DOCKER_BIN, dockerArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: spawnEnv
            });
        } catch (e) {
            removeWorkspace(workspace);
            return done(new Error('sandbox: failed to start the container: ' + e.message));
        }

        let record = {
            userName: userName,
            containerName: containerName,
            child: child,
            cancelled: false,
            timedOut: false,
            timer: null
        };
        activeRuns[runId] = record;

        if (typeof options.onStart === 'function') {
            try {
                options.onStart({ runId: runId, containerName: containerName, mode: mode });
            } catch (e) {
                // A listener failure must not abort the run.
            }
        }

        let stdout = '';
        let stderr = '';
        let totalBytes = 0;
        let truncated = false;

        function capture(streamName, buffer) {
            let chunk = buffer.toString();
            totalBytes += Buffer.byteLength(chunk, 'utf-8');
            if (totalBytes > MAX_OUTPUT_BYTES) {
                if (!truncated) {
                    truncated = true;
                    let notice = '\n[output truncated at ' +
                        Math.floor(MAX_OUTPUT_BYTES / 1024) + ' KB]\n';
                    stderr += notice;
                    emit('stderr', notice);
                    // Stop the run: unbounded output is almost always a runaway loop.
                    kill(runId, 'truncated');
                }
                return;
            }
            if (streamName === 'stdout') {
                stdout += chunk;
            } else {
                stderr += chunk;
            }
            emit(streamName, chunk);
        }

        function emit(streamName, chunk) {
            if (typeof options.onOutput !== 'function') {
                return;
            }
            try {
                options.onOutput({ runId: runId, stream: streamName, chunk: chunk });
            } catch (e) {
                // Never let a streaming listener break execution.
            }
        }

        child.stdout.on('data', function (d) { capture('stdout', d); });
        child.stderr.on('data', function (d) { capture('stderr', d); });

        let timeoutMs = options.timeoutMs ||
            (mode === 'check' ? CHECK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
        record.timer = setTimeout(function () {
            record.timedOut = true;
            kill(runId, 'timeout');
        }, timeoutMs);

        child.on('error', function (err) {
            clearTimeout(record.timer);
            delete activeRuns[runId];
            removeWorkspace(workspace);
            if (err.code === 'ENOENT') {
                invalidatePreflight();
                return done(new Error('sandbox: the "' + DOCKER_BIN +
                    '" command was not found on the server.'));
            }
            done(new Error('sandbox: container failed to start: ' + err.message));
        });

        child.on('close', function (exitCode) {
            clearTimeout(record.timer);
            let wasCancelled = record.cancelled;
            let wasTimedOut = record.timedOut;
            delete activeRuns[runId];
            removeWorkspace(workspace);

            // "Unable to find image" can only happen if the image was removed
            // between preflight and run; re-probe so the next call reports it.
            if (/Unable to find image|No such image/i.test(stderr)) {
                invalidatePreflight();
            }

            let output = stdout + (stderr ? (stdout && !stdout.endsWith('\n') ? '\n' : '') + stderr : '');
            done(null, {
                runId: runId,
                mode: mode,
                runtimeId: runtime.id,
                exitCode: typeof exitCode === 'number' ? exitCode : null,
                stdout: stdout,
                stderr: stderr,
                output: output,
                durationMs: Date.now() - startedAt,
                timedOut: wasTimedOut,
                cancelled: wasCancelled,
                truncated: truncated,
                timeoutMs: timeoutMs
            });
        });
    });
}

/**
 * Stop a run. `docker kill` on the container is what actually stops the work —
 * killing the local CLI process alone would leave the container running.
 *
 * @returns {boolean} true if a matching active run was found.
 */
function kill(runId, reason) {
    let record = activeRuns[runId];
    if (!record) {
        return false;
    }
    if (reason === 'cancel') {
        record.cancelled = true;
    }
    try {
        // Fire-and-forget: the run's own 'close' handler does the reporting.
        let killer = spawn(DOCKER_BIN, ['kill', record.containerName], {
            stdio: 'ignore'
        });
        killer.on('error', function () {
            // Container may already be gone; the close handler still fires.
        });
    } catch (e) {
        log.warn('sandboxRunner: docker kill failed for ', record.containerName, ': ', e.message);
    }
    // Belt and braces: if the CLI process somehow survives the container, make
    // sure it does not hang the request.
    setTimeout(function () {
        if (activeRuns[runId] && record.child && !record.child.killed) {
            try {
                record.child.kill('SIGKILL');
            } catch (e) {
                // ignore
            }
        }
    }, 3000);
    return true;
}

function cancel(runId, userName) {
    let record = activeRuns[runId];
    if (!record) {
        return false;
    }
    // A user may only cancel their own run.
    if (userName && record.userName !== userName) {
        return false;
    }
    return kill(runId, 'cancel');
}

function listActiveRuns(userName) {
    return Object.keys(activeRuns)
        .filter(function (runId) { return !userName || activeRuns[runId].userName === userName; })
        .map(function (runId) {
            return { runId: runId, containerName: activeRuns[runId].containerName };
        });
}

module.exports = {
    IMAGE: IMAGE,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    CHECK_TIMEOUT_MS: CHECK_TIMEOUT_MS,
    MAX_CODE_BYTES: MAX_CODE_BYTES,
    MAX_OUTPUT_BYTES: MAX_OUTPUT_BYTES,
    MAX_CONCURRENT_RUNS_PER_USER: MAX_CONCURRENT_RUNS_PER_USER,
    preflight: preflight,
    invalidatePreflight: invalidatePreflight,
    execute: execute,
    cancel: cancel,
    listActiveRuns: listActiveRuns,
    cleanupStaleWorkspaces: cleanupStaleWorkspaces,
    // Exported for tests.
    buildDockerArgs: buildDockerArgs,
    _runsBaseDir: runsBaseDir,
    _toHostPath: toHostPath,
    _mapPath: mapPath
};
