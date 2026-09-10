"use strict";

/**
 * llmSecretPermissions.test.js — the filesystem modes protecting the credentials.
 *
 * This file exists because of a real, shipped, entirely silent bug. Three
 * writers ask for mode 0600 and get it: the TLS private key (lib/certUtils.js),
 * the AES-256 key that seals every stored provider API key
 * (lib/llm/secretStore.js) and the settings file holding those sealed keys
 * (lib/llm/llmSettings.js). But docker-entrypoint.sh then ran
 * `chmod -R 775 "${BASE_DIR}"` on EVERY container start, walking over all three
 * and leaving them world-readable. Nothing failed, nothing logged, and the
 * encryption at rest was worth nothing to anyone who could read the home
 * directory — which is precisely the audience it was written for.
 *
 * So the drift this pins is not a behaviour, it is an *absence*: that no future
 * change reintroduces a recursive chmod over the base dir, and that the three
 * writers keep asking for 0600. A permissions regression cannot be caught by a
 * functional test, because the feature keeps working perfectly while it is
 * wrong. Source inspection is the only place to catch it.
 */

let test = require('node:test');
let assert = require('node:assert/strict');
let fs = require('fs');
let os = require('os');
let path = require('path');
let crypto = require('crypto');

let secretStore = require('../lib/llm/secretStore');

const REPO_ROOT = path.join(__dirname, '..');

function readRepoFile(relative) {
    return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

test('isTooPermissive: anything readable beyond the owner is too permissive', () => {
    assert.equal(secretStore.isTooPermissive(0o600), false);
    assert.equal(secretStore.isTooPermissive(0o400), false);
    assert.equal(secretStore.isTooPermissive(0o700), false);

    // The mode actually observed on disk after the entrypoint's recursive chmod.
    assert.equal(secretStore.isTooPermissive(0o775), true);
    // Group read alone is enough: on a Linux host the artifacts tree is owned by
    // the container's app user, so "group" is not a set the owner controls.
    assert.equal(secretStore.isTooPermissive(0o640), true);
    assert.equal(secretStore.isTooPermissive(0o604), true);
    assert.equal(secretStore.isTooPermissive(0o601), true);
});

test('a key file widened by something else is tightened on the next read', () => {
    // The only test here that touches a filesystem. paths.js resolves the base
    // dir from os.homedir(), which follows $HOME on POSIX — the same lever
    // docker-entrypoint.sh pulls — so pointing HOME at a temp dir redirects the
    // whole key path without a mock.
    let home = fs.mkdtempSync(path.join(os.tmpdir(), 'signbridge-perm-'));
    let previousHome = process.env.HOME;
    let reload = function () {
        delete require.cache[require.resolve('../lib/paths')];
        delete require.cache[require.resolve('../lib/llm/secretStore')];
    };

    try {
        process.env.HOME = home;
        reload();
        let fresh = require('../lib/llm/secretStore');
        let keyPath = fresh.getKeyFilePath();
        assert.ok(keyPath.startsWith(home),
            'HOME did not redirect the key path; the rest of this test would assert nothing');

        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(keyPath, crypto.randomBytes(32));
        fs.chmodSync(keyPath, 0o775);
        assert.equal(fs.statSync(keyPath).mode & 0o777, 0o775, 'precondition: starts widened');

        // Tightening happens on the read, so exercise it through the public API
        // rather than reaching for the internal loadOrCreateKey.
        assert.equal(fresh.open(fresh.seal('sk-round-trip')), 'sk-round-trip');
        assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600,
            'reading the wrapping key must re-assert 0600 on it');
    } finally {
        if (previousHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = previousHome;
        }
        reload();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('docker-entrypoint.sh does not recursively chmod the base dir', () => {
    let entrypoint = readRepoFile('docker-entrypoint.sh');
    let offending = entrypoint.split('\n').filter(function (line) {
        let code = line.replace(/#.*$/, '');
        return /\bchmod\b/.test(code) && /(-R|--recursive)/.test(code);
    });
    assert.deepEqual(offending, [],
        'a recursive chmod over the base dir silently widens the TLS key, the LLM ' +
        'wrapping key and the sealed settings file on every container start');
});

test('docker-entrypoint.sh keeps the keys directory and its contents owner-only', () => {
    let entrypoint = readRepoFile('docker-entrypoint.sh');
    assert.match(entrypoint, /chmod\s+700\s+"\$\{BASE_DIR\}\/keys"/,
        'keys/ holds the TLS private key and the LLM wrapping key');
    assert.match(entrypoint, /find\s+"\$\{BASE_DIR\}\/keys"\s+-type f\s+-exec chmod 600/,
        'existing installs carry widened key files until something repairs them');
    // Directories still need to be traversable/writable by the app user, so a
    // dir-scoped chmod is expected to remain.
    assert.match(entrypoint, /find\s+"\$\{BASE_DIR\}"\s+-type d\s+-exec chmod 775/);
});

test('every writer of a secret file asks for mode 0600', () => {
    let writers = [
        { file: 'lib/llm/secretStore.js', what: 'the AES wrapping key' },
        { file: 'lib/llm/llmSettings.js', what: 'the settings file holding sealed keys' },
        { file: 'lib/certUtils.js', what: 'the TLS private key' }
    ];
    writers.forEach(function (writer) {
        let source = readRepoFile(writer.file);
        assert.match(source, /mode:\s*0o600/,
            writer.file + ' must write ' + writer.what + ' with mode 0o600');
    });
});
