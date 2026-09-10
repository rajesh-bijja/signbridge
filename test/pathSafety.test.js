"use strict";

// lib/pathSafety.js — the rule that a request-supplied id or name may become one
// path segment and nothing else.
//
// The function tests are a truth table: pure input, pure output, no fixtures. The
// last two tests are source inspection, because the failure they guard against is
// invisible. A store that stops validating its id keeps working perfectly for
// every legitimate caller — the regression only shows up as
// `{ "historyId": "../../llm/settings" }` reading a file it should not, which no
// existing test exercises and no log line complains about.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pathSafety = require('../lib/pathSafety');

const repoRoot = path.resolve(__dirname, '..');

test('isSafeSegment accepts the names users and imports actually produce', function () {
    // Profile names come straight out of ~/.aws/config, so they are arbitrary
    // user-facing text. An allowlist of characters tight enough to feel safe would
    // reject profiles that already exist on the user's machine.
    const acceptable = [
        'default',
        'my-profile',
        'my_profile',
        'my.profile',
        'My Profile 2',
        'dev+admin',
        'user@example.com',
        'AdministratorAccess-123456789012',
        '9f8c1b7e4a2d4c6e8b0a1f3d5e7c9b1a',
        'a',
        'x'.repeat(255)
    ];
    acceptable.forEach(function (value) {
        assert.strictEqual(pathSafety.isSafeSegment(value), true, 'should accept: ' + value);
        assert.strictEqual(pathSafety.assertSafeSegment(value, 'name'), null);
    });
});

test('isSafeSegment rejects anything that is more than one path component', function () {
    const rejected = [
        ['..', 'the parent directory itself'],
        ['.', 'the current directory'],
        ['../etc/passwd', 'a relative escape'],
        ['../../llm/settings', 'the shape that reaches the sealed LLM settings'],
        ['/etc/passwd', 'an absolute path'],
        ['a/b', 'a nested path'],
        ['a\\b', 'a Windows separator, which POSIX basename() does not strip'],
        ['..\\..\\secret', 'a Windows escape'],
        ['ok\0/../../etc', 'a NUL, which truncates the path at the syscall'],
        ['', 'the empty string'],
        ['x'.repeat(256), 'longer than any filesystem accepts as one component']
    ];
    rejected.forEach(function (row) {
        assert.strictEqual(pathSafety.isSafeSegment(row[0]), false, 'should reject ' + row[1]);
        let err = pathSafety.assertSafeSegment(row[0], 'historyId');
        assert.ok(err instanceof Error, 'should produce an Error for ' + row[1]);
        assert.strictEqual(err.statusCode, 400);
        assert.match(err.message, /historyId/, 'the error should name the field');
    });
});

test('isSafeSegment rejects non-strings rather than coercing them', function () {
    // `undefined` reaching here means a caller forgot to send the field. Coercing
    // it would produce the literal directory "undefined".
    [undefined, null, 0, 1, {}, [], ['a'], true, function () {}].forEach(function (value) {
        assert.strictEqual(pathSafety.isSafeSegment(value), false,
            'should reject: ' + Object.prototype.toString.call(value));
    });
});

test('isWithin is not fooled by a sibling sharing the base name as a prefix', function () {
    assert.strictEqual(pathSafety.isWithin('/a/b', '/a/b'), true, 'the base itself is within it');
    assert.strictEqual(pathSafety.isWithin('/a/b', '/a/b/c'), true);
    assert.strictEqual(pathSafety.isWithin('/a/b', '/a/b/c/d'), true);
    // A plain startsWith() on the string would pass this one, which is the bug
    // this function exists to not have.
    assert.strictEqual(pathSafety.isWithin('/a/b', '/a/bc'), false);
    assert.strictEqual(pathSafety.isWithin('/a/b', '/a/bcd/e'), false);
    assert.strictEqual(pathSafety.isWithin('/a/b', '/a'), false);
    assert.strictEqual(pathSafety.isWithin('/a/b', '/a/b/../c'), false);
});

test('resolveWithin joins validated segments and refuses to leave the base', function () {
    assert.strictEqual(pathSafety.resolveWithin('/base', 'profiles', 'default'),
        path.resolve('/base/profiles/default'));
    assert.throws(function () {
        pathSafety.resolveWithin('/base', '..', 'etc');
    }, /single path component/);
    assert.throws(function () {
        pathSafety.resolveWithin('/base', 'a/../../b');
    }, /single path component/);
    try {
        pathSafety.resolveWithin('/base', '../x');
        assert.fail('should have thrown');
    } catch (e) {
        assert.strictEqual(e.statusCode, 400, 'the thrown error should be answerable as a 400');
    }
});

// --- Source inspection: the stores must keep calling it ------------------------

// Every function below turns a request-supplied value into a file path. The
// mapping is function name -> the value it must have validated first.
const GUARDED_FUNCTIONS = {
    'lib/coreUtils.js': [
        // profileName becomes a DIRECTORY name, and the mkdir under it is
        // recursive — so an unchecked name creates directories anywhere the
        // process can write, not merely reads the wrong file.
        'getOrCreateProfilesDir',
        'deleteHistoryFileById',
        'deleteFavoriteFileById',
        'addToFavoritesAndUpdateMetadata',
        'getHistoryDetailsById',
        'getFavoriteDetailsById',
        'getPublicClientCreds'
    ]
};

test('every store function that builds a path from a request value validates it', function () {
    Object.keys(GUARDED_FUNCTIONS).forEach(function (file) {
        const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        GUARDED_FUNCTIONS[file].forEach(function (fnName) {
            const start = source.indexOf('function ' + fnName + '(');
            assert.notStrictEqual(start, -1, fnName + ' should still exist in ' + file);
            // The check must be in the first few lines: after the path has been
            // assembled is too late, and after an fs call is no check at all.
            const head = source.slice(start, start + 900);
            assert.match(head, /pathSafety\.assertSafeSegment/,
                fnName + ' in ' + file + ' builds a filesystem path from a caller-supplied value,'
                + ' so it must start with pathSafety.assertSafeSegment(...). Without it,'
                + ' a value like "../../llm/settings" reads or deletes outside the store.');
        });
    });
});

test('threadStore validates in threadFile, so no write path can skip it', function () {
    const source = fs.readFileSync(path.join(repoRoot, 'lib/chat/threadStore.js'), 'utf8');
    const start = source.indexOf('function threadFile(');
    assert.notStrictEqual(start, -1);
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.match(body, /isSafeThreadId/,
        'threadFile() is the single point where a threadId becomes a path, and five write'
        + ' paths (create/append/setMeta/rename/delete) go through it. Gating the readers'
        + ' only would leave the writes open, which is how it was before.');

    const threadStore = require('../lib/chat/threadStore');
    assert.strictEqual(threadStore.getThread('signbridgeuser', '../../settings/settings'), null,
        'an unsafe threadId must not resolve to a file');
    assert.strictEqual(threadStore.isSafeThreadId('../x'), false);
    assert.strictEqual(threadStore.isSafeThreadId('9f8c1b7e-4a2d-4c6e-8b0a-1f3d5e7c9b1a'), true);
});

test('sandboxStore keeps its own stricter generated-id rule', function () {
    // Script ids are generated, never typed, so this one can be an exact shape —
    // and being stricter than pathSafety is the point, not a duplication of it.
    const store = require('../lib/sandbox/sandboxStore');
    assert.strictEqual(store.isValidScriptId('9f8c1b7e4a2d4c6e8b0a1f3d5e7c9b1a'), true);
    assert.strictEqual(store.isValidScriptId('../../../etc/passwd'), false);
    assert.strictEqual(store.isValidScriptId('not-a-hex-id'), false);
});
