"use strict";

// The "what do I do about it" half of Sandbox diagnostics.
//
// A remedy is only worth showing if it is right: a wrong quick fix silently
// rewrites the user's code, and a vague one trains people to ignore the
// lightbulb. So these tests are as much about what must NOT be suggested as
// about what must.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    suggestRemedy,
    suggestOutputRemedies,
    _extractDidYouMean,
    _extractQuoted
} = require('../lib/sandbox/sandboxRemedies');

function marker(message, extra) {
    return Object.assign({ message: message, code: null, source: null }, extra || {});
}

// ---------------------------------------------------------------------------
// "Did you mean" extraction — the only hint we turn into a real edit
// ---------------------------------------------------------------------------

test('extractDidYouMean handles all three toolchain phrasings', () => {
    assert.equal(_extractDidYouMean("NameError: name 'bot3' is not defined. Did you mean: 'boto3'?"), 'boto3');
    assert.equal(_extractDidYouMean("Property 'lenght' does not exist. Did you mean 'length'?"), 'length');
    assert.equal(_extractDidYouMean("'Buckte' does not exist. Did you mean to write 'Bucket'?"), 'Bucket');
    assert.equal(_extractDidYouMean("Did you mean to use 'await'?"), 'await');
});

test('extractDidYouMean ignores compiler-FLAG hints', () => {
    // tsc: "Did you mean to set the 'moduleResolution' option to 'nodenext'?"
    // This is advice about tsconfig, not about the identifier under the cursor.
    // A looser pattern captured the bare word "to" here and offered to rewrite
    // the user's code as "to" — a quick fix that actively breaks the file.
    assert.equal(
        _extractDidYouMean(
            "Cannot find module 'x'. Did you mean to set the 'moduleResolution' option to 'nodenext'?"
        ),
        null
    );
    assert.equal(_extractDidYouMean('Did you mean to enable the esModuleInterop flag?'), null);
});

test('extractDidYouMean returns null when there is no suggestion', () => {
    assert.equal(_extractDidYouMean('cannot find symbol'), null);
    assert.equal(_extractDidYouMean(''), null);
    assert.equal(_extractDidYouMean(null), null);
});

test('extractQuoted pulls the first quoted token in any quote style', () => {
    assert.equal(_extractQuoted("No module named 'pandas'"), 'pandas');
    assert.equal(_extractQuoted('Cannot find module "left-pad"'), 'left-pad');
    assert.equal(_extractQuoted('nothing quoted here'), null);
    assert.equal(_extractQuoted(null), null);
});

// ---------------------------------------------------------------------------
// Per-marker remedies
// ---------------------------------------------------------------------------

test('a spelling suggestion wins over the error category it arrived in', () => {
    // TS2561 reads as a type error, but the actionable fact is the typo.
    const result = suggestRemedy(
        marker(
            "Object literal may only specify known properties, but 'Buckte' does not exist " +
                "in type '{ Bucket: string; }'. Did you mean to write 'Bucket'?",
            { code: 'TS2561', source: 'tsc' }
        ),
        'typescript'
    );
    assert.equal(result.replaceWord, 'Bucket');
    assert.equal(result.title, "Change to 'Bucket'");
});

test('a missing module names the package and lists what IS installed', () => {
    // The sandbox has no package manager at run time, so "npm install it" is not
    // a usable remedy — knowing what the image already ships is.
    const result = suggestRemedy(marker("ModuleNotFoundError: No module named 'pandas'"), 'python');
    assert.match(result.title, /pandas/);
    assert.match(result.detail, /boto3/);
    assert.match(result.detail, /sandbox\/Dockerfile/);
    assert.equal(result.replaceWord, undefined, 'must not offer to rewrite an import as a guess');
});

test('a missing module is recognised from the tsc code alone', () => {
    // tsc reports the code in a separate field, not inside the message text.
    const result = suggestRemedy(
        marker("Cannot find module 'left-pad' or its corresponding type declarations.", {
            code: 'TS2307',
            source: 'tsc'
        }),
        'typescript'
    );
    assert.match(result.title, /left-pad/);
    assert.match(result.detail, /@aws-sdk/);
});

test('an unresolved symbol with no suggestion gets language-appropriate advice', () => {
    const java = suggestRemedy(marker('cannot find symbol', { source: 'javac' }), 'java');
    assert.match(java.title, /Declare it, import it, or fix the spelling/);
    assert.match(java.detail, /software\.amazon\.awssdk/);
    assert.equal(java.replaceWord, undefined);

    const python = suggestRemedy(marker("NameError: name 'client' is not defined"), 'python');
    assert.match(python.detail, /not defined in scope/);
    assert.doesNotMatch(python.detail, /awssdk/);
});

test('an unclosed delimiter explains that the line reported is the OPENING one', () => {
    // The single most confusing Python error: the caret is above where you typed.
    const result = suggestRemedy(marker("SyntaxError: '(' was never closed"), 'python');
    assert.equal(result.title, 'Close the open "("');
    assert.match(result.detail, /OPENED/);

    assert.equal(
        suggestRemedy(marker('SyntaxError: missing ) after argument list'), 'javascript').title,
        'Close the open bracket'
    );
});

test('indentation errors distinguish mixed tabs from a wrong indent level', () => {
    assert.match(
        suggestRemedy(marker('TabError: inconsistent use of tabs and spaces in indentation'), 'python').detail,
        /mixes tabs and spaces/
    );
    assert.match(
        suggestRemedy(marker('IndentationError: expected an indented block'), 'python').detail,
        /consistent indent level/
    );
});

test('java single-file launcher constraints get concrete fixes', () => {
    const rename = suggestRemedy(
        marker('class Widget is public, should be declared in a file named Widget.java', { source: 'javac' }),
        'java'
    );
    assert.equal(rename.replaceWord, 'Main');

    const entryPoint = suggestRemedy(marker("error: can't find main(String[]) method in class: Widget"), 'java');
    assert.match(entryPoint.title, /public static void main/);
});

test('a type mismatch distinguishes a bad argument from a bad assignment', () => {
    assert.match(
        suggestRemedy(marker("Type 'string' is not assignable to type 'number'.", { code: 'TS2322' }), 'typescript')
            .detail,
        /Convert the value, or change the declared type/
    );
    assert.match(
        suggestRemedy(marker('Argument of type X is not assignable', { code: 'TS2345' }), 'typescript').detail,
        /argument order and shape/
    );
});

test('a top-level await complaint states that .mjs DOES allow it', () => {
    const result = suggestRemedy(marker('await is only valid in async functions', { code: 'TS1308' }), 'javascript');
    assert.match(result.detail, /main\.mjs/);
    assert.match(result.detail, /top-level await IS allowed/);
});

test('an unused declaration is recognised from tsc\'s wording and from its code', () => {
    assert.equal(
        suggestRemedy(marker("'x' is declared but its value is never read.", { code: 'TS6133' }), 'typescript').title,
        'Remove the unused declaration'
    );
    assert.equal(
        suggestRemedy(marker('some future wording', { code: 'TS6133' }), 'typescript').title,
        'Remove the unused declaration'
    );
});

test('an unrecognised message yields no remedy rather than a vague one', () => {
    assert.equal(suggestRemedy(marker('RuntimeError: something went sideways'), 'python'), null);
    assert.equal(suggestRemedy(marker(''), 'python'), null);
    assert.equal(suggestRemedy(null, 'python'), null);
    assert.equal(suggestRemedy({}, 'python'), null);
});

test('an unknown runtime does not throw while building a remedy', () => {
    // Diagnostics must never be able to fail a run.
    const result = suggestRemedy(marker("No module named 'pandas'"), 'ruby');
    assert.ok(result);
    assert.match(result.title, /pandas/);
});

// ---------------------------------------------------------------------------
// Whole-output remedies (environment problems, not code problems)
// ---------------------------------------------------------------------------

test('an expired SSO session is named and the exact fix command given', () => {
    // The dominant real-world sandbox failure. It is not a code bug, so it must
    // not be reported as one.
    const found = suggestOutputRemedies(
        'python',
        'botocore.exceptions.ClientError: An error occurred (ExpiredToken) when calling ' +
            'the GetCallerIdentity operation: The security token included in the request is expired'
    );
    assert.equal(found.length >= 1, true);
    assert.match(found[0].title, /expired/i);
    assert.match(found[0].detail, /aws sso login --profile/);
});

test('AccessDenied is explicitly called out as NOT a code error', () => {
    const found = suggestOutputRemedies(
        'python',
        'ClientError: An error occurred (AccessDenied) when calling the ListBuckets operation'
    );
    assert.equal(found.length, 1);
    assert.match(found[0].title, /lacks permission/);
    assert.match(found[0].detail, /not a code error/);
});

test('missing credentials point at the profile picker, not at the code', () => {
    const found = suggestOutputRemedies('python', 'botocore.exceptions.NoCredentialsError: Unable to locate credentials');
    assert.equal(found.length >= 1, true);
    assert.match(found[0].detail, /AWS IAM User or AWS SSO/);
});

test('throttling suggests backing off rather than retrying harder', () => {
    const found = suggestOutputRemedies('javascript', 'ThrottlingException: Rate exceeded');
    assert.equal(found.length, 1);
    assert.match(found[0].detail, /sleep|retry\/pagination/);
});

test('a missing region is diagnosed even though the sandbox always exports one', () => {
    const found = suggestOutputRemedies('python', 'NoRegionError: You must specify a region.');
    assert.equal(found.length, 1);
    assert.match(found[0].detail, /AWS_REGION/);
});

test('several independent problems in one run all surface, in rule order', () => {
    const found = suggestOutputRemedies(
        'python',
        'ExpiredToken while calling STS\nAccessDenied while calling S3\nThrottling while calling EC2'
    );
    assert.equal(found.length, 3);
    const titles = found.map(f => f.title).join(' | ');
    assert.match(titles, /expired/i);
    assert.match(titles, /permission/);
    assert.match(titles, /throttled/);
});

test('successful output produces no remedies', () => {
    assert.deepEqual(suggestOutputRemedies('python', 'Caller identity:\n  arn: arn:aws:sts::1:assumed-role/x\n'), []);
    assert.deepEqual(suggestOutputRemedies('python', ''), []);
    assert.deepEqual(suggestOutputRemedies('python', null), []);
});

test('output remedies carry no replaceWord — there is no source span to edit', () => {
    const found = suggestOutputRemedies('python', 'ExpiredToken');
    for (const entry of found) {
        assert.deepEqual(Object.keys(entry).sort(), ['detail', 'title']);
    }
});
