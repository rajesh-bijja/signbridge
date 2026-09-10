"use strict";

// The Sandbox language registry. These tests pin the container-side contract
// that the rest of the sandbox depends on: every runtime must name a file inside
// /workspace, RUN and CHECK that exact file, and declare a diagnostics parser
// that sandboxDiagnostics actually implements. A drift here doesn't fail loudly
// at build time — it fails as "your code ran but nothing happened", so it is
// worth asserting.

const test = require('node:test');
const assert = require('node:assert/strict');

const runtimes = require('../lib/sandbox/sandboxRuntimes');
const diagnostics = require('../lib/sandbox/sandboxDiagnostics');

const KNOWN_PARSERS = ['python', 'node', 'typescript', 'java'];

test('workspacePath always lands inside the container workspace', () => {
    assert.equal(runtimes.workspacePath('main.py'), '/workspace/main.py');
    assert.equal(runtimes.WORKSPACE_DIR, '/workspace');
});

test('every runtime in RUNTIME_ORDER resolves, and lookup is case-insensitive', () => {
    for (const id of runtimes.RUNTIME_ORDER) {
        assert.ok(runtimes.getRuntime(id), 'missing runtime: ' + id);
        assert.ok(runtimes.isSupportedRuntime(id.toUpperCase()));
    }
    assert.deepEqual(runtimes.listRuntimeIds(), ['python', 'javascript', 'typescript', 'java']);
});

test('unknown / empty runtime ids resolve to null rather than throwing', () => {
    assert.equal(runtimes.getRuntime('ruby'), null);
    assert.equal(runtimes.getRuntime(''), null);
    assert.equal(runtimes.getRuntime(null), null);
    assert.equal(runtimes.getRuntime(undefined), null);
    assert.equal(runtimes.isSupportedRuntime('ruby'), false);
});

test('listRuntimeIds returns a copy — callers cannot mutate the registry order', () => {
    const first = runtimes.listRuntimeIds();
    first.push('ruby');
    assert.deepEqual(runtimes.listRuntimeIds(), ['python', 'javascript', 'typescript', 'java']);
});

test('run and check argv both target the runtime\'s own workspace file', () => {
    for (const id of runtimes.RUNTIME_ORDER) {
        const runtime = runtimes.getRuntime(id);
        const expected = runtimes.workspacePath(runtime.fileName);
        assert.ok(
            runtime.runArgv.includes(expected),
            id + ' runArgv does not reference ' + expected
        );
        assert.ok(
            runtime.checkArgv.includes(expected),
            id + ' checkArgv does not reference ' + expected
        );
        // argv is exec'd directly (no shell), so every part must be a string.
        for (const part of runtime.runArgv.concat(runtime.checkArgv)) {
            assert.equal(typeof part, 'string', id + ' argv contains a non-string part');
        }
    }
});

test('every runtime declares a diagnostics parser that exists', () => {
    for (const id of runtimes.RUNTIME_ORDER) {
        const runtime = runtimes.getRuntime(id);
        assert.ok(
            KNOWN_PARSERS.includes(runtime.diagnosticsParser),
            id + ' names an unknown parser: ' + runtime.diagnosticsParser
        );
        // And the parser is reachable through the public entry point: an unknown
        // parser name would silently return [] and kill all squiggles.
        assert.ok(Array.isArray(diagnostics.parseCheckDiagnostics(id, 'noise')));
    }
});

test('checkKind is one of the three the UI knows how to label', () => {
    const labelled = ['syntax', 'types', 'compile'];
    for (const id of runtimes.RUNTIME_ORDER) {
        assert.ok(labelled.includes(runtimes.getRuntime(id).checkKind));
    }
});

test('java is pinned to the single-file launcher\'s class-name requirement', () => {
    const java = runtimes.getRuntime('java');
    assert.equal(runtimes.JAVA_CLASS_NAME, 'Main');
    assert.equal(java.fileName, 'Main.java');
    assert.equal(java.requiredClassName, 'Main');
    // Both templates must declare that exact public class, or the launcher fails
    // before the user's code ever runs.
    for (const template of java.templates) {
        assert.match(template.code, /public class Main\b/);
    }
});

test('javascript runs as an ES module so top-level await works', () => {
    // The templates promise top-level await; .mjs is what makes that true.
    assert.equal(runtimes.getRuntime('javascript').fileName, 'main.mjs');
});

test('describeRuntimes exposes the picker data and leaks no execution details', () => {
    const described = runtimes.describeRuntimes();
    assert.equal(described.length, runtimes.RUNTIME_ORDER.length);
    described.forEach((entry, index) => {
        assert.equal(entry.id, runtimes.RUNTIME_ORDER[index]);
        assert.ok(entry.label && entry.monacoLanguage && entry.fileName);
        assert.ok(Array.isArray(entry.libraries) && entry.libraries.length > 0);
        assert.ok(entry.templates.length > 0);
        for (const template of entry.templates) {
            // Template BODIES are fetched on demand; the list must stay small.
            assert.deepEqual(Object.keys(template).sort(), ['id', 'label']);
        }
        // argv is server-side only — a client has no business knowing it.
        assert.equal(entry.runArgv, undefined);
        assert.equal(entry.checkArgv, undefined);
    });
});

test('describeRuntimes returns copies of the library lists', () => {
    runtimes.describeRuntimes()[0].libraries.push('malware');
    assert.equal(runtimes.describeRuntimes()[0].libraries.includes('malware'), false);
});

test('getTemplate returns runnable starter code for every runtime/template pair', () => {
    for (const id of runtimes.RUNTIME_ORDER) {
        const runtime = runtimes.getRuntime(id);
        for (const template of runtime.templates) {
            const result = runtimes.getTemplate(id, template.id);
            assert.equal(result.runtimeId, id);
            assert.equal(result.templateId, template.id);
            assert.equal(result.fileName, runtime.fileName);
            assert.ok(result.code.length > 0);
        }
    }
});

test('getTemplate falls back to the first template for an unknown id', () => {
    // A stale client must not be able to blank out the editor.
    const fallback = runtimes.getTemplate('python', 'no-such-template');
    assert.equal(fallback.templateId, 'aws');
    assert.equal(runtimes.getTemplate('python', null).templateId, 'aws');
    assert.equal(runtimes.getTemplate('python', undefined).templateId, 'aws');
});

test('getTemplate returns null for an unknown runtime', () => {
    assert.equal(runtimes.getTemplate('ruby', 'aws'), null);
});

test('no template hardcodes a credential', () => {
    // The templates teach "credentials are already in the environment". If one
    // ever demonstrated a literal key, users would copy that pattern.
    for (const id of runtimes.RUNTIME_ORDER) {
        for (const template of runtimes.getRuntime(id).templates) {
            assert.doesNotMatch(template.code, /AKIA[0-9A-Z]{12,}/);
            assert.doesNotMatch(template.code, /aws_secret_access_key\s*=\s*['"]\S/i);
        }
    }
});
