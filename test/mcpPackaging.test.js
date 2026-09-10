"use strict";

// mcp/ is published as `signbridge-mcp` so a client can run it with
// `npx -y signbridge-mcp` and never clone this repository. That distribution has
// a property nothing else here has: it runs from a directory containing only the
// files package.json's `files` list ships, resolving only the dependencies
// package.json declares — with node_modules of this repo nowhere in sight.
//
// Every failure mode below therefore works perfectly in the repo and breaks only
// once installed, which is the worst place to find out:
//
//   * an import of a package that is not a declared dependency resolves here,
//     because npm flattened it in as some other package's transitive dep. That
//     was real: tools.mjs imports zod-to-json-schema, which only the MCP SDK
//     depended on. The day the SDK drops it, every `npx signbridge-mcp` dies at
//     module load with ERR_MODULE_NOT_FOUND.
//   * an import of ../lib works here and cannot possibly work there.
//   * a file the entry point needs is not in `files`, so it is simply absent.
//   * anything written to stdout corrupts the JSON-RPC stream, and the client
//     reports the server as broken with nothing pointing at the print statement.
//
// Static analysis on purpose: importing the module would prove only that this
// checkout resolves, which is exactly the thing that is never in doubt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const builtins = new Set(require('module').builtinModules);

const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');
const pkg = JSON.parse(fs.readFileSync(path.join(mcpDir, 'package.json'), 'utf8'));

function read(file) {
    return fs.readFileSync(path.join(mcpDir, file), 'utf8');
}

// Bare module specifiers (not './x', not a Node built-in) from static imports.
// Scoped names keep both segments; a deep path like 'pkg/sub/mod.js' resolves to
// the package 'pkg'. Built-ins are matched with and without the node: prefix —
// `import https from 'https'` needs no dependency and never will.
function importedPackages(source) {
    const found = new Set();
    const re = /^\s*import\s(?:[\s\S]*?\sfrom\s)?['"]([^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(source)) !== null) {
        const spec = m[1];
        if (spec.startsWith('.') || builtins.has(spec.replace(/^node:/, ''))) {
            continue;
        }
        const parts = spec.split('/');
        found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
    return found;
}

function relativeImports(source) {
    const found = new Set();
    const re = /^\s*import\s(?:[\s\S]*?\sfrom\s)?['"](\.[^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(source)) !== null) {
        found.add(m[1]);
    }
    return found;
}

// The files the published package actually executes.
const SHIPPED_CODE = ['server.js', 'tools.mjs'];

test('the package is publishable and launchable by npx', function () {
    assert.strictEqual(pkg.name, 'signbridge-mcp');
    assert.notStrictEqual(pkg.private, true,
        'a private package cannot be published, so `npx signbridge-mcp` would never exist');
    assert.strictEqual(pkg.type, 'module', 'server.js and tools.mjs are ESM');
    assert.ok(pkg.bin && pkg.bin['signbridge-mcp'],
        'npx needs a bin entry; without one the client reports that it could not'
        + ' determine an executable to run');
    assert.match(pkg.bin['signbridge-mcp'], /server\.js$/);
    assert.ok(pkg.engines && pkg.engines.node, 'declare the Node floor');
    assert.ok(pkg.license, 'npm shows the license on the package page');

    // npm makes the bin executable itself, but only Node knows what to do with
    // the file if the shebang is there.
    assert.match(read('server.js'), /^#!\/usr\/bin\/env node\n/,
        'the bin entry needs a shebang');
});

test('everything the entry point needs is in the files list', function () {
    const files = pkg.files || [];
    SHIPPED_CODE.concat('README.md').forEach(function (file) {
        assert.ok(files.includes(file), file + ' is not in package.json "files", so it'
            + ' will be missing from the installed package');
        assert.ok(fs.existsSync(path.join(mcpDir, file)),
            file + ' is promised by "files" but does not exist — npm publish would'
            + ' ship a package whose own README is a 404');
    });

    // Relative imports must land on a shipped file. mcpHttp.mjs is deliberately
    // NOT shipped (it is mounted inside the Express server, not spawned), so a
    // stdio-side import of it would be a missing module in the published copy.
    SHIPPED_CODE.forEach(function (file) {
        relativeImports(read(file)).forEach(function (spec) {
            const target = spec.replace(/^\.\//, '');
            assert.ok(files.includes(target),
                file + ' imports ' + spec + ', which is not shipped in "files"');
        });
    });
});

test('every package the shipped code imports is a declared dependency', function () {
    const declared = new Set(Object.keys(pkg.dependencies || {}));
    const missing = [];
    SHIPPED_CODE.forEach(function (file) {
        importedPackages(read(file)).forEach(function (name) {
            if (!declared.has(name)) {
                missing.push(file + ' -> ' + name);
            }
        });
    });
    assert.deepStrictEqual(missing, [],
        'these imports are not declared in mcp/package.json: ' + missing.join(', ')
        + '. They resolve in this checkout because npm hoisted them in as another'
        + ' package\'s transitive dependency, and they will resolve in an installed'
        + ' copy right up until that package drops them — at which point every'
        + ' `npx signbridge-mcp` fails at module load.');
});

test('the shipped code reaches nothing outside mcp/', function () {
    SHIPPED_CODE.forEach(function (file) {
        relativeImports(read(file)).forEach(function (spec) {
            assert.ok(!spec.startsWith('..'),
                file + ' imports ' + spec + ': the published package is the mcp/'
                + ' directory alone, so anything above it does not exist there.');
        });
    });
});

test('the same imports are declared where the backend loads them too', function () {
    // The HTTP transport lives inside the Express server, so the root manifest
    // has to declare tools.mjs's dependencies as well. Same hoisting trap, other
    // manifest — and this one fails in the container rather than at a user's.
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys(rootPkg.dependencies || {}));
    importedPackages(read('tools.mjs')).forEach(function (name) {
        assert.ok(declared.has(name),
            'mcp/tools.mjs imports ' + name + ' and server.js loads that module through'
            + ' mcpHttp.mjs, so the root package.json must declare it as well');
    });
});

test('nothing in the shipped code writes to stdout except the CLI flags', function () {
    // stdout is the JSON-RPC channel. --help and --version are the exception:
    // they are what a human runs in a terminal, they print and exit, and no
    // protocol session exists yet.
    SHIPPED_CODE.forEach(function (file) {
        const source = read(file);
        assert.doesNotMatch(source, /console\.log\(/,
            file + ' writes to stdout with console.log, which corrupts the MCP stream.'
            + ' Use process.stderr — clients surface it in their logs.');
        assert.doesNotMatch(source, /console\.info\(/, file + ': console.info is stdout too');
    });

    const server = read('server.js');
    const writes = server.match(/process\.stdout\.write\(/g) || [];
    assert.strictEqual(writes.length, 2,
        'server.js should write to stdout exactly twice — the --help text and the'
        + ' --version string. Anything else belongs on stderr.');
    // Both must be in the argv-handling block, before the transport is connected.
    const connectAt = server.indexOf('server.connect(');
    assert.ok(connectAt > 0);
    let idx = server.indexOf('process.stdout.write(');
    while (idx !== -1) {
        assert.ok(idx < connectAt,
            'a stdout write appears after the transport is connected, which puts it in'
            + ' the middle of the JSON-RPC stream');
        idx = server.indexOf('process.stdout.write(', idx + 1);
    }
});

test('an unreachable SignBridge is reported as such, and does not kill the server', function () {
    const server = read('server.js');
    assert.match(server, /ECONNREFUSED/,
        'the first error every new user meets is a refused connection, and axios reports'
        + ' it as "connect ECONNREFUSED 127.0.0.1:2443" — which a model relays as though'
        + ' the tool itself were broken. Name the cause instead.');
    assert.match(server, /describeTransportError/);

    // The startup probe must not exit. A client that sees its MCP server exit marks
    // it failed until the user notices, and clients routinely start before the app.
    const probeAt = server.indexOf('/session');
    assert.ok(probeAt > 0, 'the startup reachability probe should still be there');
    assert.doesNotMatch(server.slice(probeAt), /process\.exit/,
        'the reachability probe must not exit — SignBridge is often started after the'
        + ' client has already spawned this process');
});

test('the documented npx spec is one npm can actually resolve', function () {
    // `github:owner/repo#main:mcp` parses as a git spec with no committish and no
    // subdirectory: npm installs the repository root, which has no signbridge-mcp
    // bin, and the client reports that it could not determine an executable. The
    // subdirectory separator is `::path:`.
    ['README.md', path.join('mcp', 'README.md')].forEach(function (rel) {
        const doc = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        const specs = doc.match(/github:[^"'\s]+signbridge#[^"'\s]+/g) || [];
        specs.forEach(function (spec) {
            assert.match(spec, /#[^:]+::path:mcp$/,
                rel + ' documents ' + spec + ', which npm resolves to the repository'
                + ' root rather than the mcp/ subdirectory. Use #<branch>::path:mcp.');
        });
    });
});

test('no doc tells the user to disable TLS verification', function () {
    // The stdio server builds its own https.Agent for SignBridge's self-signed
    // cert, so the variable was never needed — and as a process-wide opt-out it
    // would also cover whatever else the client's Node process talks to.
    ['README.md', path.join('mcp', 'README.md')].forEach(function (rel) {
        const doc = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        const lines = doc.split('\n');
        lines.forEach(function (line, i) {
            if (line.indexOf('NODE_TLS_REJECT_UNAUTHORIZED') === -1) {
                return;
            }
            // Prose wraps, so judge the sentence around the mention rather than the
            // one line it happens to land on.
            const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
            assert.match(context, /\b(not|never|unnecessary|avoid)\b/i,
                rel + ':' + (i + 1) + ' mentions NODE_TLS_REJECT_UNAUTHORIZED outside of'
                + ' an instruction not to use it: ' + line.trim());
        });
    });
});
