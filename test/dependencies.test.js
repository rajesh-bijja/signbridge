"use strict";

// The backend is CommonJS, so a runtime dependency that ships as ESM only cannot
// be require()d — and this is the rare bug that reproduces *only* in the shipped
// container. `require(esm)` was added in Node 22.12 / 20.19, so on a current local
// Node the app starts, the whole suite passes, and `npm audit` is clean; in the
// image's Node 20 the very first require() throws ERR_REQUIRE_ESM and the server
// never listens. That is exactly what a `uuid` bump to v13 did: the fix was to
// drop it for crypto.randomUUID(), and this file is here so the next one is caught
// before a rebuild rather than after.
//
// Static on purpose. Calling require() here would pass on any Node new enough to
// paper over the problem, which is every developer machine and none of the images.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function depManifest(name) {
    const file = path.join(repoRoot, 'node_modules', name, 'package.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// Does this package offer anything a CommonJS require() can load? Either it is not
// an ES module at all, or its "exports" map declares a require condition (the
// dual-package shape), or it still has a plain "main" that is not .mjs.
function hasCommonJsEntry(manifest) {
    if (manifest.type !== 'module') {
        return true;
    }
    const exp = manifest.exports;
    if (exp && typeof exp === 'object') {
        const json = JSON.stringify(exp);
        if (json.indexOf('"require"') !== -1 || json.indexOf('.cjs') !== -1) {
            return true;
        }
    }
    return typeof manifest.main === 'string' && !manifest.main.endsWith('.mjs');
}

test('every runtime dependency can be loaded from CommonJS', function () {
    const names = Object.keys(pkg.dependencies || {});
    assert.ok(names.length > 0, 'package.json should declare runtime dependencies');

    const esmOnly = [];
    names.forEach(function (name) {
        const manifest = depManifest(name);
        if (!manifest) {
            return; // not installed here; npm ci in the image is the gate for that
        }
        if (!hasCommonJsEntry(manifest)) {
            esmOnly.push(name + '@' + manifest.version);
        }
    });

    assert.deepStrictEqual(esmOnly, [],
        'these runtime dependencies are ESM-only, and lib/ is CommonJS. They will throw'
        + ' ERR_REQUIRE_ESM on the container\'s Node even though a newer local Node loads'
        + ' them fine. Either replace the package (often a Node built-in now does the job)'
        + ' or pin the last version that shipped a CommonJS entry point.');
});

test('the backend does not depend on uuid', function () {
    // Not a style rule: crypto.randomUUID() is a Node built-in (14.17+) that does
    // the one thing this app used uuid for, so the dependency was pure risk — and
    // it is the package that caused the ESM breakage above.
    assert.ok(!(pkg.dependencies || {}).uuid,
        'use crypto.randomUUID() rather than reinstating the uuid package');

    const files = [];
    (function walk(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') { walk(full); }
            } else if (entry.name.endsWith('.js')) {
                files.push(full);
            }
        });
    }(path.join(repoRoot, 'lib')));

    files.forEach(function (file) {
        const source = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(source, /require\(['"]uuid['"]\)/,
            path.relative(repoRoot, file) + ' requires uuid; use crypto.randomUUID()');
    });
});

test('the lockfiles are in sync with their manifests', function () {
    // The Dockerfile installs with `npm ci`, which refuses to run at all when a
    // manifest and its lockfile disagree ("can only install packages when your
    // package.json and package-lock.json are in sync"). Nothing local notices:
    // `npm install`, `npm test` and `npm audit` all work off node_modules, which
    // is already correct. The failure appears only in a clean build — i.e. for the
    // first person to clone the repository and run `docker compose up --build`.
    //
    // This happened: a dependency overhaul (Express 5, hyparquet, openai in, the
    // AWS SDK out) updated package.json and left the lockfile behind, and `npm ci`
    // failed with EUSAGE on eight packages.
    //
    // The check is npm's own bookkeeping rather than semver arithmetic: the lock's
    // root entry mirrors the manifest's dependency ranges verbatim, so comparing
    // those two catches the disagreement npm would report, with no extra package
    // to depend on.
    [['package.json', 'package-lock.json'], ['mcp/package.json', 'mcp/package-lock.json']]
        .forEach(function (pair) {
            const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, pair[0]), 'utf8'));
            const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, pair[1]), 'utf8'));
            const rootEntry = (lock.packages || {})[''] || {};

            assert.deepStrictEqual(rootEntry.dependencies || {}, manifest.dependencies || {},
                pair[1] + ' does not match ' + pair[0] + '. `npm ci` will refuse to install'
                + ' and the Docker build fails before it starts. Run `npm install'
                + ' --package-lock-only` in ' + path.dirname(pair[0]) + ' and commit the lock.');

            Object.keys(manifest.dependencies || {}).forEach(function (name) {
                assert.ok(lock.packages['node_modules/' + name],
                    name + ' is declared in ' + pair[0] + ' but has no resolved entry in '
                    + pair[1]);
            });
        });
});

test('the Docker base image tracks an LTS line rather than an aged patch', function () {
    // node:20.4.0 (July 2023) is what shipped while the npm dependencies were being
    // audited for vulnerabilities — i.e. the runtime carried every Node CVE fixed
    // since, which no `npm audit` would ever mention.
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    const bases = dockerfile.match(/^FROM\s+(\S+)/gm) || [];
    assert.ok(bases.length >= 2, 'the multi-stage build should still have both stages');
    bases.forEach(function (line) {
        const image = line.replace(/^FROM\s+/, '');
        assert.doesNotMatch(image, /^node:\d+\.\d+\.\d+/,
            'pinning a Node patch (' + image + ') means rebuilds keep an old runtime.'
            + ' Track the LTS line (node:20-bullseye) instead.');
    });
});
