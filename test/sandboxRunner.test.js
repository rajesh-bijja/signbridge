"use strict";

// The container command line for Sandbox mode.
//
// buildDockerArgs is the whole security boundary of the feature expressed as an
// argv, so it is deliberately a pure function and tested as one — no Docker
// needed. Two properties matter most and are asserted explicitly below:
//
//   1. Every hardening flag is present. Dropping one silently converts "runs
//      arbitrary user code safely" into "runs arbitrary user code".
//   2. No credential VALUE appears anywhere in the argv. Values are passed by
//      NAME (`--env AWS_SECRET_ACCESS_KEY`), so the docker CLI reads them from
//      its own environment and they never reach `ps` output or any log line.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildDockerArgs,
    IMAGE,
    MAX_CODE_BYTES,
    MAX_OUTPUT_BYTES,
    MAX_CONCURRENT_RUNS_PER_USER,
    _mapPath,
    _toHostPath
} = require('../lib/sandbox/sandboxRunner');
const sandboxRuntimes = require('../lib/sandbox/sandboxRuntimes');

const FAKE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const FAKE_TOKEN = 'FQoGZXIvYXdzEExampleSessionTokenValue==';

function spec(overrides) {
    return Object.assign(
        {
            containerName: 'signbridge-sandbox-run-abc123',
            workspace: '/host/runs/abc123',
            image: 'signbridge-sandbox:latest',
            argv: ['python3', '-u', '/workspace/main.py'],
            envNames: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
            limits: {}
        },
        overrides || {}
    );
}

/** Find the value that follows a flag, e.g. pairValue(args, '--memory'). */
function pairValue(args, flag) {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
}

/** All values following repeated occurrences of a flag. */
function pairValues(args, flag) {
    const values = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === flag) {
            values.push(args[i + 1]);
        }
    }
    return values;
}

// ---------------------------------------------------------------------------
// secret hygiene
// ---------------------------------------------------------------------------

test('credential values never appear in the argv — only their names', () => {
    const args = buildDockerArgs(spec());
    const joined = args.join(' ');

    assert.equal(joined.includes(FAKE_SECRET), false);
    assert.equal(joined.includes(FAKE_TOKEN), false);
    // The tell-tale of the mistake this guards against: `--env NAME=value`.
    for (const arg of args) {
        assert.doesNotMatch(arg, /^AWS_[A-Z_]+=/, 'env passed as NAME=value: ' + arg);
    }
    // Each secret is referenced by bare name instead.
    assert.deepEqual(pairValues(args, '--env'), [
        'AWS_REGION',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN'
    ]);
});

test('an empty or absent envNames list produces no --env flags', () => {
    assert.deepEqual(pairValues(buildDockerArgs(spec({ envNames: [] })), '--env'), []);
    assert.deepEqual(pairValues(buildDockerArgs(spec({ envNames: undefined })), '--env'), []);
});

// ---------------------------------------------------------------------------
// isolation / hardening
// ---------------------------------------------------------------------------

test('every hardening flag is present', () => {
    const args = buildDockerArgs(spec());

    // Container is discarded after the run — no state survives it.
    assert.ok(args.includes('--rm'));
    // No added capabilities, and no way to gain more via setuid binaries.
    assert.equal(pairValue(args, '--cap-drop'), 'ALL');
    assert.equal(pairValue(args, '--security-opt'), 'no-new-privileges');
    // Resource caps: a runaway loop must not take the host down.
    assert.ok(pairValue(args, '--memory'));
    assert.ok(pairValue(args, '--cpus'));
    assert.ok(pairValue(args, '--pids-limit'));
});

test('the memory cap is real: swap is pinned to the same limit', () => {
    // With --memory-swap unset, Docker grants swap equal to the memory limit
    // again, so the effective ceiling is double what was configured.
    const args = buildDockerArgs(spec());
    assert.equal(pairValue(args, '--memory-swap'), pairValue(args, '--memory'));
});

test('the workspace is mounted read-only at the container workspace path', () => {
    // User code is executed, never mutated. Anything the script needs to write
    // goes to the tmpfs below.
    const args = buildDockerArgs(spec());
    assert.equal(pairValue(args, '--volume'), '/host/runs/abc123:' + sandboxRuntimes.WORKSPACE_DIR + ':ro');
    assert.equal(pairValue(args, '--workdir'), sandboxRuntimes.WORKSPACE_DIR);
});

test('scratch space is a size-capped tmpfs, not a host directory', () => {
    const tmpfs = pairValue(buildDockerArgs(spec()), '--tmpfs');
    assert.match(tmpfs, /^\/tmp:/);
    assert.match(tmpfs, /\bnosuid\b/);
    assert.match(tmpfs, /\bsize=\d+[a-zA-Z]?/);
    // exec is required: tsx writes and runs transpiled temp files.
    assert.match(tmpfs, /\bexec\b/);
});

test('a check run is network-isolated; a real run is not', () => {
    // Syntax/type checking has no reason to reach the internet. Running does —
    // calling AWS is the entire point.
    assert.deepEqual(pairValues(buildDockerArgs(spec({ network: 'none' })), '--network'), ['none']);
    assert.deepEqual(pairValues(buildDockerArgs(spec()), '--network'), []);
    assert.deepEqual(pairValues(buildDockerArgs(spec({ network: 'bridge' })), '--network'), []);
});

test('stdout and stderr are attached without a TTY so output can stream', () => {
    // A TTY would merge and line-buffer the streams; the IDE colours stderr
    // separately and shows output as it arrives.
    const args = buildDockerArgs(spec());
    assert.deepEqual(pairValues(args, '--attach').sort(), ['stderr', 'stdout']);
    assert.equal(args.includes('--tty'), false);
    assert.equal(args.includes('-t'), false);
    assert.equal(args.includes('--interactive'), false);
});

// ---------------------------------------------------------------------------
// argv shape
// ---------------------------------------------------------------------------

test('the command is `docker run <flags> <image> <argv>` in that order', () => {
    const args = buildDockerArgs(spec());
    assert.equal(args[0], 'run');

    const imageIndex = args.indexOf('signbridge-sandbox:latest');
    assert.ok(imageIndex > 0, 'image must be present');
    // Everything after the image is the in-container command, verbatim.
    assert.deepEqual(args.slice(imageIndex + 1), ['python3', '-u', '/workspace/main.py']);
    // ...and every flag comes before it, or docker would treat it as an argument
    // to the user's program instead.
    assert.equal(args.slice(imageIndex + 1).some(a => a.startsWith('--')), false);
});

test('the container is named so a run can be cancelled by name', () => {
    // Stop is implemented as `docker kill <name>`; without --name there is no
    // handle on the container.
    assert.equal(pairValue(buildDockerArgs(spec()), '--name'), 'signbridge-sandbox-run-abc123');
});

test('every argv element is a string — the argv is exec\'d without a shell', () => {
    // A number here would throw inside child_process.spawn at run time.
    for (const arg of buildDockerArgs(spec({ limits: { pidsLimit: 128, cpus: 2 } }))) {
        assert.equal(typeof arg, 'string', 'non-string argv element: ' + String(arg));
    }
});

test('per-run limit overrides are honoured, with defaults otherwise', () => {
    const custom = buildDockerArgs(
        spec({ limits: { memory: '256m', cpus: '0.5', pidsLimit: '64', tmpfsSize: '32m' } })
    );
    assert.equal(pairValue(custom, '--memory'), '256m');
    assert.equal(pairValue(custom, '--memory-swap'), '256m');
    assert.equal(pairValue(custom, '--cpus'), '0.5');
    assert.equal(pairValue(custom, '--pids-limit'), '64');
    assert.match(pairValue(custom, '--tmpfs'), /size=32m/);

    const defaults = buildDockerArgs(spec({ limits: undefined }));
    assert.ok(pairValue(defaults, '--memory'));
    assert.ok(pairValue(defaults, '--cpus'));
});

test('each real runtime\'s run and check argv survive the round trip unchanged', () => {
    for (const id of sandboxRuntimes.RUNTIME_ORDER) {
        const runtime = sandboxRuntimes.getRuntime(id);
        for (const argv of [runtime.runArgv, runtime.checkArgv]) {
            const args = buildDockerArgs(spec({ argv: argv }));
            assert.deepEqual(args.slice(args.indexOf('signbridge-sandbox:latest') + 1), argv);
        }
    }
});

// ---------------------------------------------------------------------------
// host path translation (sibling containers)
// ---------------------------------------------------------------------------

test('a workspace path is rewritten to its host equivalent for the mount', () => {
    // The daemon resolves -v sources on the host. When SignBridge itself runs in
    // a container, passing its own container path makes Docker mount a NEW empty
    // directory — the run then fails with "no such file" while the code sits
    // right there. This mapping is what makes the Docker deployment work at all.
    const local = '/var/www/.signbridge';
    const host = '/Users/dev/.signbridge';
    assert.equal(
        _mapPath('/var/www/.signbridge/artifacts/userartifacts/u/sandboxruns/abc', local, host),
        '/Users/dev/.signbridge/artifacts/userartifacts/u/sandboxruns/abc'
    );
    assert.equal(_mapPath(local, local, host), host);
});

test('paths outside the base dir are left alone rather than spliced onto it', () => {
    // Rewriting an unrelated path would invent a wrong-but-plausible mount
    // source; better to pass it through and fail loudly.
    const local = '/var/www/.signbridge';
    const host = '/Users/dev/.signbridge';
    assert.equal(_mapPath('/tmp/elsewhere', local, host), '/tmp/elsewhere');
    // A sibling directory that merely shares the prefix must not match.
    assert.equal(_mapPath('/var/www/.signbridge-old/x', local, host), '/var/www/.signbridge-old/x');
});

test('with no host base configured the translation is the identity', () => {
    // The local `npm start` case: paths already ARE host paths, and rewriting
    // them would break the mount that currently works.
    assert.equal(_mapPath('/var/www/.signbridge/x', '/var/www/.signbridge', ''), '/var/www/.signbridge/x');
    assert.equal(_mapPath('/var/www/.signbridge/x', '/var/www/.signbridge', undefined),
        '/var/www/.signbridge/x');
    // Unset in this test environment, so the live helper is a pass-through.
    assert.equal(_toHostPath('/some/where'), '/some/where');
});

// ---------------------------------------------------------------------------
// configured ceilings
// ---------------------------------------------------------------------------

test('the configured ceilings are sane positive numbers', () => {
    assert.ok(MAX_CODE_BYTES > 0);
    assert.ok(MAX_OUTPUT_BYTES > 0);
    assert.ok(MAX_CONCURRENT_RUNS_PER_USER >= 1);
    assert.ok(IMAGE.length > 0);
});
