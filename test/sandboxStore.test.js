"use strict";

// Saved-script storage for Sandbox mode. Only the pure guards are tested here;
// the CRUD itself is file-backed and lives under the user's artifacts directory.
//
// isValidScriptId is the important one: a script id arrives from the client and
// is used to build a filename, so it is a path-traversal surface. It is an
// allow-list (32 lowercase hex chars) rather than a deny-list, and these tests
// pin that — a deny-list would have to anticipate every encoding of "..".

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_NAME_LENGTH, MAX_SCRIPTS_PER_USER, isValidScriptId, _sanitizeName } =
    require('../lib/sandbox/sandboxStore');

test('a well-formed script id is accepted', () => {
    assert.equal(isValidScriptId('0123456789abcdef0123456789abcdef'), true);
    assert.equal(isValidScriptId('a'.repeat(32)), true);
});

test('path traversal in a script id is rejected', () => {
    // Each of these, if it reached path.join, would escape the scripts dir.
    const attacks = [
        '../../../etc/passwd',
        '..',
        '.',
        '/etc/passwd',
        'abc/../../etc/passwd',
        '0123456789abcdef0123456789abcde/',
        '..%2f..%2fetc%2fpasswd',
        '....//....//etc/passwd',
        '../secret',
        'a'.repeat(32) + '/../../x'
    ];
    for (const attack of attacks) {
        assert.equal(isValidScriptId(attack), false, 'accepted a traversal id: ' + attack);
    }
});

test('anything that is not exactly 32 lowercase hex chars is rejected', () => {
    assert.equal(isValidScriptId('a'.repeat(31)), false, 'too short');
    assert.equal(isValidScriptId('a'.repeat(33)), false, 'too long');
    assert.equal(isValidScriptId('A'.repeat(32)), false, 'uppercase hex');
    assert.equal(isValidScriptId('g'.repeat(32)), false, 'non-hex letter');
    assert.equal(isValidScriptId('0123456789abcdef-123456789abcdef'), false, 'hyphenated uuid form');
    assert.equal(isValidScriptId('0123456789abcdef0123456789abcde\n'), false, 'trailing newline');
    assert.equal(isValidScriptId(' 0123456789abcdef0123456789abcdef'), false, 'leading space');
});

test('non-string script ids are rejected without throwing', () => {
    for (const value of [null, undefined, 0, 42, {}, [], true, () => {}]) {
        assert.equal(isValidScriptId(value), false);
    }
});

test('a script name is stripped of characters that would break the list UI', () => {
    // Newlines and tabs in a name would smear the sidebar across lines.
    assert.equal(_sanitizeName('  Describe regions  ', 'python'), 'Describe regions');
    assert.equal(_sanitizeName('line one\nline two', 'python'), 'line one line two');
    assert.equal(_sanitizeName('tab\there', 'python'), 'tab here');
});

test('an empty name falls back to a per-language placeholder', () => {
    assert.equal(_sanitizeName('', 'python'), 'Untitled Python');
    assert.equal(_sanitizeName('   ', 'java'), 'Untitled Java');
    assert.equal(_sanitizeName(null, 'typescript'), 'Untitled TypeScript');
    assert.equal(_sanitizeName(undefined, 'javascript'), 'Untitled JavaScript');
    // Unknown runtime: still a usable name, not "Untitled undefined".
    assert.equal(_sanitizeName('', 'ruby'), 'Untitled script');
});

test('a script name is truncated rather than rejected', () => {
    // Saving is a low-friction action; erroring on a long name would lose work.
    const long = 'x'.repeat(MAX_NAME_LENGTH + 50);
    assert.equal(_sanitizeName(long, 'python').length, MAX_NAME_LENGTH);
});

test('the storage ceilings are sane', () => {
    assert.ok(MAX_NAME_LENGTH > 0);
    assert.ok(MAX_SCRIPTS_PER_USER > 0);
});
