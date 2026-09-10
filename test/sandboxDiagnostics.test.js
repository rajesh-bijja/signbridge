"use strict";

// Diagnostics parsing for Sandbox mode: raw compiler/interpreter stderr in,
// Monaco markers out.
//
// Every fixture below is REAL output, captured by running the offending code
// inside the signbridge-sandbox image (Python 3.11.2, Node 20.20.2, tsc, javac).
// That matters: these parsers exist purely to cope with each tool's exact
// layout — hand-written approximations would let a genuine format change pass.
// When adding a language, capture its output the same way rather than mocking.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_DIAGNOSTICS,
    parseCheckDiagnostics,
    parseRuntimeDiagnostics,
    _columnFromCaretLine,
    _isUserFile
} = require('../lib/sandbox/sandboxDiagnostics');

// ---------------------------------------------------------------------------
// caret-line column extraction (the shared primitive)
// ---------------------------------------------------------------------------

test('columnFromCaretLine converts a caret run into a 1-based span', () => {
    assert.deepEqual(_columnFromCaretLine('     ^'), { column: 6, endColumn: 7 });
    assert.deepEqual(_columnFromCaretLine('   ^^^^'), { column: 4, endColumn: 8 });
    assert.deepEqual(_columnFromCaretLine('^'), { column: 1, endColumn: 2 });
});

test('columnFromCaretLine returns null when there is no caret', () => {
    assert.equal(_columnFromCaretLine('    print("hello"'), null);
    assert.equal(_columnFromCaretLine(''), null);
    assert.equal(_columnFromCaretLine(null), null);
    assert.equal(_columnFromCaretLine(undefined), null);
});

// ---------------------------------------------------------------------------
// user-file gating
// ---------------------------------------------------------------------------

test('isUserFile only accepts the runtime\'s own workspace file', () => {
    assert.equal(_isUserFile('/workspace/main.py', 'python'), true);
    assert.equal(_isUserFile('/workspace/Main.java', 'java'), true);
    // Library frames: real, but there is no editor buffer to mark up.
    assert.equal(_isUserFile('/usr/lib/python3.11/json/decoder.py', 'python'), false);
    assert.equal(_isUserFile('/workspace/main.py', 'java'), false);
    assert.equal(_isUserFile(null, 'python'), false);
    assert.equal(_isUserFile('/workspace/main.py', 'ruby'), false);
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_COMPILE_UNCLOSED = [
    '  File "/workspace/main.py", line 3',
    '    print("hello"',
    '         ^',
    "SyntaxError: '(' was never closed"
].join('\n');

test('python: py_compile syntax error maps to the caret column with a remedy', () => {
    const markers = parseCheckDiagnostics('python', PY_COMPILE_UNCLOSED);
    assert.equal(markers.length, 1);
    const marker = markers[0];
    assert.equal(marker.line, 3);
    assert.equal(marker.column, 10);
    assert.equal(marker.endColumn, 11);
    assert.equal(marker.severity, 'error');
    assert.equal(marker.code, 'SyntaxError');
    assert.equal(marker.source, 'python');
    assert.match(marker.message, /'\(' was never closed/);
    // The reported line is where the bracket OPENED, which the remedy explains.
    assert.equal(marker.remedy.title, 'Close the open "("');
    assert.match(marker.remedy.detail, /where it was OPENED/);
});

const PY_NAME_ERROR_SUGGESTION = [
    'Traceback (most recent call last):',
    '  File "/workspace/main.py", line 2, in <module>',
    '    print(bot3)',
    '          ^^^^',
    "NameError: name 'bot3' is not defined. Did you mean: 'boto3'?"
].join('\n');

test('python: runtime NameError becomes a one-click quick fix', () => {
    // Python writes "Did you mean: 'boto3'?" WITH a colon; tsc writes it
    // without. A parser that only handled tsc's form downgraded this to a
    // generic hint and lost the fix.
    const markers = parseRuntimeDiagnostics('python', PY_NAME_ERROR_SUGGESTION);
    assert.equal(markers.length, 1);
    const marker = markers[0];
    assert.equal(marker.line, 2);
    assert.equal(marker.column, 11);
    assert.equal(marker.endColumn, 15);
    assert.equal(marker.remedy.replaceWord, 'boto3');
    assert.equal(marker.remedy.title, "Change to 'boto3'");
});

const PY_TRACEBACK_THROUGH_LIBRARY = [
    'Traceback (most recent call last):',
    '  File "/workspace/main.py", line 12, in <module>',
    '    data = json.loads("not json")',
    '  File "/usr/lib/python3.11/json/__init__.py", line 346, in loads',
    '    return _default_decoder.decode(s)',
    '  File "/usr/lib/python3.11/json/decoder.py", line 337, in decode',
    '    obj, end = self.raw_decode(s, idx=_w(s, 0).end())',
    'json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)'
].join('\n');

test('python: a traceback through library frames still points at the user line', () => {
    // The deepest frame is inside the stdlib; only the user's frame has a buffer
    // to underline, so that is the one that must be kept.
    const markers = parseRuntimeDiagnostics('python', PY_TRACEBACK_THROUGH_LIBRARY);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].line, 12);
    assert.match(markers[0].message, /JSONDecodeError: Expecting value/);
});

test('python: clean output produces no markers', () => {
    assert.deepEqual(parseCheckDiagnostics('python', ''), []);
    assert.deepEqual(parseCheckDiagnostics('python', 'Caller identity:\n  arn: ...\n'), []);
});

// ---------------------------------------------------------------------------
// Node / JavaScript
// ---------------------------------------------------------------------------

const NODE_CHECK_SYNTAX = [
    '/workspace/main.mjs:2',
    'console.log("a"',
    '            ^^^',
    '',
    'SyntaxError: missing ) after argument list',
    '    at checkSyntax (node:internal/main/check_syntax:74:5)',
    '',
    'Node.js v20.20.2'
].join('\n');

test('node: --check syntax error maps line, caret span, and remedy', () => {
    const markers = parseCheckDiagnostics('javascript', NODE_CHECK_SYNTAX);
    assert.equal(markers.length, 1);
    const marker = markers[0];
    assert.equal(marker.line, 2);
    assert.equal(marker.column, 13);
    assert.equal(marker.endColumn, 16);
    assert.equal(marker.code, 'SyntaxError');
    assert.equal(marker.source, 'node');
    assert.equal(marker.remedy.title, 'Close the open bracket');
});

test('node: internal frames after the error are not mistaken for user code', () => {
    // "at checkSyntax (node:internal/...:74:5)" has a line:column shape but is
    // not a filesystem path — marking line 74 of the user's file would be wrong.
    const markers = parseCheckDiagnostics('javascript', NODE_CHECK_SYNTAX);
    assert.equal(markers.some(m => m.line === 74), false);
});

const NODE_RUNTIME_STACK = [
    'file:///workspace/main.mjs:2',
    'const value = obj.missing.deep',
    '                          ^',
    '',
    "TypeError: Cannot read properties of undefined (reading 'deep')",
    '    at file:///workspace/main.mjs:2:27',
    '    at ModuleJob.run (node:internal/modules/esm/module_job:325:25)',
    '    at async ModuleLoader.import (node:internal/modules/esm/loader:606:24)',
    '    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)',
    '',
    'Node.js v20.20.2'
].join('\n');

test('node: an ES-module runtime error resolves to the user frame', () => {
    // ESM errors report file:// URLs, and the top location has no
    // parenthesised call site ("    at file:///workspace/main.mjs:2:27").
    // Neither shape used to match, so the single most common failure in the
    // single most used language produced no marker at all.
    const markers = parseRuntimeDiagnostics('javascript', NODE_RUNTIME_STACK);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].line, 2);
    assert.equal(markers[0].column, 27);
    assert.match(markers[0].message, /TypeError: Cannot read properties of undefined/);
});

test('node: internal module frames never become markers', () => {
    // "(node:internal/modules/esm/module_job:325:25)" is not a filesystem path;
    // marking line 325 of a 3-line file would be nonsense.
    const markers = parseRuntimeDiagnostics('javascript', NODE_RUNTIME_STACK);
    assert.equal(markers.some(m => m.line > 3), false);
});

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

const TSC_OUTPUT = [
    "main.mts(2,19): error TS2551: Property 'lenght' does not exist on type 'string[]'. Did you mean 'length'?",
    "main.mts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."
].join('\n');

test('typescript: tsc diagnostics carry code, position, and per-code remedies', () => {
    const markers = parseCheckDiagnostics('typescript', TSC_OUTPUT);
    assert.equal(markers.length, 2);

    assert.equal(markers[0].line, 2);
    assert.equal(markers[0].column, 19);
    assert.equal(markers[0].code, 'TS2551');
    assert.equal(markers[0].source, 'tsc');
    // tsc's own spelling suggestion becomes a real edit.
    assert.equal(markers[0].remedy.replaceWord, 'length');

    assert.equal(markers[1].line, 3);
    assert.equal(markers[1].column, 7);
    assert.equal(markers[1].code, 'TS2322');
    assert.equal(markers[1].remedy.title, 'Match the expected type');
});

test('typescript: an object-literal typo (TS2561) still yields a one-click fix', () => {
    // Captured verbatim. This one used to fall through every rule and produce no
    // remedy: the message says "does not exist IN type" (not "on type"), and the
    // suggestion is phrased "Did you mean to write 'x'?".
    const markers = parseCheckDiagnostics(
        'typescript',
        "main.mts(3,5): error TS2561: Object literal may only specify known properties, " +
            "but 'Buckte' does not exist in type '{ Bucket: string; }'. Did you mean to write 'Bucket'?"
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].remedy.replaceWord, 'Bucket');
});

const TSC_WRAPPED_MESSAGE = [
    "main.mts(4,3): error TS2345: Argument of type '{ Buckets: string; }' is not",
    "  assignable to parameter of type 'ListBucketsCommandInput'.",
    "  Did you mean 'Bucket'?"
].join('\n');

test('typescript: a wrapped multi-line message is joined so the hint survives', () => {
    // tsc soft-wraps long messages onto indented continuation lines. Dropping
    // them would throw away the "Did you mean" at the end.
    const markers = parseCheckDiagnostics('typescript', TSC_WRAPPED_MESSAGE);
    assert.equal(markers.length, 1);
    assert.match(markers[0].message, /assignable to parameter of type 'ListBucketsCommandInput'/);
    assert.match(markers[0].message, /Did you mean 'Bucket'\?/);
    assert.equal(markers[0].remedy.replaceWord, 'Bucket');
});

test('typescript: an unused local is recognised from tsc\'s actual wording', () => {
    // Captured verbatim: tsc says "is declared but its value is never read",
    // and reports it as an error, not a warning.
    const markers = parseCheckDiagnostics(
        'typescript',
        "main.mts(1,7): error TS6133: 'unused' is declared but its value is never read."
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].severity, 'error');
    assert.equal(markers[0].remedy.title, 'Remove the unused declaration');
});

test('typescript: warnings keep warning severity', () => {
    const markers = parseCheckDiagnostics(
        'typescript',
        'main.mts(9,7): warning TS1234: Something mildly concerning.'
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].severity, 'warning');
});

test('typescript: diagnostics in node_modules are dropped', () => {
    const markers = parseCheckDiagnostics(
        'typescript',
        "node_modules/@aws-sdk/client-ec2/dist-types/index.d.ts(3,1): error TS2307: Cannot find module 'x'."
    );
    assert.deepEqual(markers, []);
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVAC_OUTPUT = [
    '/workspace/Main.java:3: error: incompatible types: String cannot be converted to int',
    '        int x = "nope";',
    '                ^',
    '/workspace/Main.java:4: error: cannot find symbol',
    '        undefinedCall();',
    '        ^',
    '  symbol:   method undefinedCall()',
    '  location: class Main',
    '2 errors'
].join('\n');

test('java: javac errors resolve the caret column past the echoed source line', () => {
    // javac's layout is: error line, echoed source line, caret line, then
    // optional symbol:/location: detail. An earlier version stopped scanning at
    // the echoed source line and reported column 1 for everything, which
    // underlined the whole statement instead of the offending token.
    const markers = parseCheckDiagnostics('java', JAVAC_OUTPUT);
    assert.equal(markers.length, 2);

    assert.equal(markers[0].line, 3);
    assert.equal(markers[0].column, 17);
    assert.equal(markers[0].source, 'javac');
    assert.equal(markers[0].remedy.title, 'Match the expected type');

    assert.equal(markers[1].line, 4);
    assert.equal(markers[1].column, 9);
});

test('java: symbol/location detail is folded into the message', () => {
    const markers = parseCheckDiagnostics('java', JAVAC_OUTPUT);
    assert.match(markers[1].message, /cannot find symbol/);
    assert.match(markers[1].message, /symbol:\s+method undefinedCall\(\)/);
    assert.match(markers[1].message, /location: class Main/);
});

test('java: the trailing "N errors" summary is not parsed as a diagnostic', () => {
    const markers = parseCheckDiagnostics('java', JAVAC_OUTPUT);
    assert.equal(markers.some(m => /^\d+ errors?$/.test(m.message)), false);
});

const JAVAC_WRONG_CLASS_NAME = [
    '/workspace/Main.java:1: error: class Widget is public, should be declared in a file named Widget.java',
    'public class Widget {',
    '       ^',
    '1 error'
].join('\n');

test('java: the single-file launcher class-name rule offers a rename fix', () => {
    const markers = parseCheckDiagnostics('java', JAVAC_WRONG_CLASS_NAME);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].remedy.replaceWord, 'Main');
    assert.match(markers[0].remedy.title, /Rename the class to Main/);
});

const JAVA_RUNTIME_EXCEPTION = [
    'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null',
    '\tat Main.main(Main.java:7)'
].join('\n');

test('java: a runtime exception resolves to its user-file frame', () => {
    const markers = parseRuntimeDiagnostics('java', JAVA_RUNTIME_EXCEPTION);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].line, 7);
    assert.equal(markers[0].code, 'java.lang.NullPointerException');
    assert.equal(markers[0].source, 'java');
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('an unknown runtime yields no markers instead of throwing', () => {
    assert.deepEqual(parseCheckDiagnostics('ruby', 'anything'), []);
    assert.deepEqual(parseCheckDiagnostics(null, 'anything'), []);
});

test('falsy output yields no markers', () => {
    for (const id of ['python', 'javascript', 'typescript', 'java']) {
        assert.deepEqual(parseCheckDiagnostics(id, ''), []);
        assert.deepEqual(parseCheckDiagnostics(id, null), []);
        assert.deepEqual(parseCheckDiagnostics(id, undefined), []);
    }
});

test('identical diagnostics are de-duplicated', () => {
    const repeated = [TSC_OUTPUT, TSC_OUTPUT, TSC_OUTPUT].join('\n');
    assert.equal(parseCheckDiagnostics('typescript', repeated).length, 2);
});

test('a cascade of diagnostics is capped at MAX_DIAGNOSTICS', () => {
    // One missing brace can produce hundreds of errors; an unbounded list would
    // bloat the response and make the gutter useless.
    const lines = [];
    for (let i = 1; i <= MAX_DIAGNOSTICS + 40; i += 1) {
        lines.push('main.mts(' + i + ",1): error TS2304: Cannot find name 'x" + i + "'.");
    }
    const markers = parseCheckDiagnostics('typescript', lines.join('\n'));
    assert.equal(markers.length, MAX_DIAGNOSTICS);
});

test('every marker is a well-formed Monaco range (1-based, end after start)', () => {
    const all = [
        parseCheckDiagnostics('python', PY_COMPILE_UNCLOSED),
        parseRuntimeDiagnostics('python', PY_NAME_ERROR_SUGGESTION),
        parseCheckDiagnostics('javascript', NODE_CHECK_SYNTAX),
        parseCheckDiagnostics('typescript', TSC_OUTPUT),
        parseCheckDiagnostics('java', JAVAC_OUTPUT)
    ].flat();
    assert.ok(all.length > 0);
    for (const marker of all) {
        assert.ok(marker.line >= 1, 'line must be 1-based');
        assert.ok(marker.column >= 1, 'column must be 1-based');
        assert.ok(marker.endLine >= marker.line);
        assert.ok(marker.endColumn > marker.column);
        assert.ok(['error', 'warning'].includes(marker.severity));
        assert.ok(marker.message.length > 0);
        // Present-but-null is part of the shape; the UI checks for it.
        assert.ok(Object.prototype.hasOwnProperty.call(marker, 'remedy'));
    }
});
