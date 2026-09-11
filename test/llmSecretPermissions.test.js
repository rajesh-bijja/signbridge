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

// Every module that writes a file holding a credential, a token, or a recorded
// request/response. `publicWrites` names the arguments of the writes in that file
// that are deliberately world-readable — a TLS *certificate*, ~/.aws/config (no
// secrets, and the AWS CLI writes it 0644 too), the botocore model cache.
const SECRET_WRITERS = [
    { file: 'lib/llm/secretStore.js', what: 'the AES wrapping key' },
    { file: 'lib/llm/llmSettings.js', what: 'the settings file holding sealed keys' },
    { file: 'lib/certUtils.js', what: 'the TLS private key', publicWrites: ['certPath'] },
    { file: 'lib/profileUtils.js', what: 'profiles, settings and OAuth client creds' },
    { file: 'lib/coreUtils.js', what: 'history, favorites, collections and settings artifacts' },
    { file: 'lib/chat/threadStore.js', what: 'chat transcripts, including tool results' },
    { file: 'lib/awsCliUtils.js', what: 'the cached SSO access token and the CLI script' },
    { file: 'lib/sandbox/sandboxStore.js', what: 'saved Sandbox scripts' },
    { file: 'lib/awsConfigWriter.js', what: '~/.aws/credentials', publicWrites: ['configFile'] }
];

function stripComments(source) {
    // Same shape as the other source-inspecting tests here. The [^:] guard keeps
    // `https://` from being read as a line comment.
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// The names of any `const NAME = { … mode: 0oNNN … }` in the file, so a write
// that passes its options as a shared constant counts as carrying a mode. Reading
// them out of the source (rather than hardcoding the names here) means renaming
// the constant does not silently switch this check off.
function optionsConstantsWithMode(source) {
    let names = [];
    let re = /const\s+([A-Za-z0-9_$]+)\s*=\s*\{[^}]*\bmode:\s*0o[0-7]{3}[^}]*\}/g;
    let match;
    while ((match = re.exec(source)) !== null) {
        names.push(match[1]);
    }
    return names;
}

test('every writer of a secret file asks for mode 0600', () => {
    SECRET_WRITERS.forEach(function (writer) {
        let source = readRepoFile(writer.file);
        assert.match(source, /mode:\s*0o600/,
            writer.file + ' must write ' + writer.what + ' with mode 0o600');
    });
});

test('no write in those modules lands at the default mode', () => {
    // The assertion above is satisfied by a single `mode: 0o600` anywhere in the
    // file, which is most of a file's writes proving nothing about the rest — a
    // later `jsonfile.writeFile(f, obj, { spaces: 2 }, cb)` would pass it while
    // creating a world-readable file. jsonfile's default is 0644 and fs's is 0666
    // & ~umask, so a write with no mode is the bug, and it is invisible: the
    // feature works perfectly and only the mode on disk is wrong.
    let offenders = [];

    SECRET_WRITERS.forEach(function (writer) {
        let source = stripComments(readRepoFile(writer.file));
        let allowedConstants = optionsConstantsWithMode(source);
        let publicWrites = writer.publicWrites || [];

        source.split('\n').forEach(function (line, index) {
            if (!/\b(?:fs|jsonfile)\.writeFile(?:Sync)?\(/.test(line)) {
                return;
            }
            let carriesMode = /\bmode:\s*0o[0-7]{3}/.test(line) ||
                allowedConstants.some(function (name) {
                    return new RegExp('\\b' + name + '\\b').test(line);
                });
            let isPublic = publicWrites.some(function (arg) {
                return new RegExp('\\(\\s*' + arg + '\\b').test(line);
            });
            if (!carriesMode && !isPublic) {
                offenders.push(writer.file + ':' + (index + 1) + ' ' + line.trim());
            }
        });
    });

    assert.deepEqual(offenders, [],
        'these writes create files under ~/.signbridge (or ~/.aws) at the default ' +
        'mode: pass { mode: 0o600 }, or add the target to publicWrites if it really ' +
        'is world-readable');
});

test('docker-entrypoint.sh repairs the artifact stores, not just profiles', () => {
    // A mode is honoured only when a file is created, so every install that
    // predates a writer's mode keeps its old one forever. This pass is the only
    // thing that fixes those, and it has to cover every store — repairing
    // profiles/ alone leaves history, favorites and settings wide open.
    let entrypoint = readRepoFile('docker-entrypoint.sh');
    let stores = ['profiles', 'history', 'favorites', 'collections', 'settings',
        'public_client_creds', 'chat', 'llm'];
    let repairLoop = entrypoint.match(/for store in ([^;]+);/);
    assert.ok(repairLoop, 'expected a loop repairing the artifact stores to 600');
    let listed = repairLoop[1].split(/\s+/);
    stores.forEach(function (store) {
        assert.ok(listed.includes(store),
            store + '/ holds credential-bearing artifacts and must be in the repair pass');
    });
    // sandboxruns/ workspaces are mounted into the sandbox container, whose
    // process runs as a different uid and must be able to read the code file.
    assert.ok(!listed.includes('sandboxruns'),
        'sandboxruns/ must stay readable by the sandbox container');
});
