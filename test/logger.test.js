"use strict";

/**
 * logger.test.js — the two things about lib/logger.js that fail silently.
 *
 * 1. **Redaction happens whether or not the call site asks.** That is the whole
 *    reason this logger exists: `lib/redact.js` was introduced because signing
 *    traces had been printing live session tokens, and the fix at the time was to
 *    wrap the payload *at the call site* — which 77 of 532 call sites did. A rule
 *    like that is only ever one new log line away from being broken again, and
 *    breaking it produces no failure, no warning and a perfectly working app whose
 *    `docker logs` output is a credential. So the invariant pinned here is that a
 *    secret handed to *any* level, as an object, a string body or a query string,
 *    does not reach the output — with nobody having remembered to redact it.
 *
 * 2. **No `console.*` comes back to `lib/`.** Same class of regression as
 *    test/llmSecretPermissions.test.js and test/mcpLlmTools.test.js: a single
 *    `console.log(profile)` added later works exactly as intended while bypassing
 *    both the redaction and the level gate. Only source inspection catches that,
 *    so the second half of this file is a scanner rather than a behaviour test.
 *
 * Output is captured by swapping `process.stdout.write` / `process.stderr.write`,
 * which is also the assertion that warn/error go to stderr and info/debug do not.
 */

let test = require('node:test');
let assert = require('node:assert/strict');
let fs = require('fs');
let path = require('path');

let logger = require('../lib/logger');

const REPO_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/**
 * Run `fn` with both streams captured. Returns `{ out, err, all }` as strings.
 * The level is restored afterwards so tests cannot leak into one another.
 */
function capture(level, fn) {
    let out = [];
    let err = [];
    let realOut = process.stdout.write;
    let realErr = process.stderr.write;
    let realLevel = logger.getLevel();
    process.stdout.write = function (chunk) { out.push(String(chunk)); return true; };
    process.stderr.write = function (chunk) { err.push(String(chunk)); return true; };
    try {
        logger.setLevel(level);
        fn();
    } finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
        logger.setLevel(realLevel);
    }
    return { out: out.join(''), err: err.join(''), all: out.join('') + err.join('') };
}

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------

test('levels are ordered error < warn < info < debug', () => {
    assert.deepEqual(logger.LEVELS, { error: 0, warn: 1, info: 2, debug: 3 });
    assert.equal(logger.DEFAULT_LEVEL, 'info');
});

test('setLevel: an unknown or empty level falls back to the default', () => {
    let realLevel = logger.getLevel();
    try {
        assert.equal(logger.setLevel('debug'), 'debug');
        assert.equal(logger.setLevel('DEBUG'), 'debug');   // case-insensitive
        assert.equal(logger.setLevel(' warn '), 'warn');   // trimmed
        assert.equal(logger.setLevel('verbose'), logger.DEFAULT_LEVEL);
        assert.equal(logger.setLevel(''), logger.DEFAULT_LEVEL);
        assert.equal(logger.setLevel(null), logger.DEFAULT_LEVEL);
    } finally {
        logger.setLevel(realLevel);
    }
});

test('the default level prints error/warn/info and swallows debug', () => {
    let captured = capture('info', () => {
        let log = logger.create('scopeUnderTest');
        log.error('an error line');
        log.warn('a warn line');
        log.info('an info line');
        log.debug('a debug line');
    });
    assert.match(captured.all, /an error line/);
    assert.match(captured.all, /a warn line/);
    assert.match(captured.all, /an info line/);
    // The signing traces are hundreds of lines per request; they must be opt-in.
    assert.ok(!captured.all.includes('a debug line'), 'debug must be silent at info');
});

test('error is still printed at the quietest level, and nothing else is', () => {
    let captured = capture('error', () => {
        let log = logger.create('scopeUnderTest');
        log.error('kept');
        log.warn('dropped-warn');
        log.info('dropped-info');
        log.debug('dropped-debug');
    });
    assert.match(captured.all, /kept/);
    assert.ok(!captured.all.includes('dropped'), 'only error survives at level=error');
});

test('warn and error go to stderr; info and debug go to stdout', () => {
    let captured = capture('debug', () => {
        let log = logger.create('streams');
        log.error('to-stderr-error');
        log.warn('to-stderr-warn');
        log.info('to-stdout-info');
        log.debug('to-stdout-debug');
    });
    assert.match(captured.err, /to-stderr-error/);
    assert.match(captured.err, /to-stderr-warn/);
    assert.ok(!captured.out.includes('to-stderr'), 'warn/error must not land in stdout');
    assert.match(captured.out, /to-stdout-info/);
    assert.match(captured.out, /to-stdout-debug/);
    assert.ok(!captured.err.includes('to-stdout'), 'info/debug must not land in stderr');
});

test('isDebug lets a call site skip building an expensive trace string', () => {
    let realLevel = logger.getLevel();
    try {
        let log = logger.create('cheap');
        logger.setLevel('info');
        assert.equal(log.isDebug(), false);
        logger.setLevel('debug');
        assert.equal(log.isDebug(), true);
    } finally {
        logger.setLevel(realLevel);
    }
});

// ---------------------------------------------------------------------------
// line shape
// ---------------------------------------------------------------------------

test('a line carries an ISO timestamp, the level and the scope', () => {
    let captured = capture('info', () => {
        logger.create('ssoUtils').info('hello');
    });
    assert.match(captured.out,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}\[ssoUtils\] hello\n$/);
});

test('arguments are joined with a single space, as console.log did', () => {
    // Hundreds of converted call sites read `log.debug('host: ', h)` and relied on
    // console.log's spacing; joining any other way would reformat all of them.
    let captured = capture('debug', () => {
        logger.create('spacing').debug('host: ', 'example.com', ' port: ', 443);
    });
    assert.match(captured.out, /host: {2}example\.com {2}port: {2}443\n$/);
});

test('an Error logs its message at info and its stack at debug', () => {
    let boom = new Error('kaboom');
    let atInfo = capture('info', () => { logger.create('e').error(boom); });
    assert.match(atInfo.err, /kaboom/);
    assert.ok(!atInfo.err.includes('logger.test.js'), 'no stack frames at info');

    let atDebug = capture('debug', () => { logger.create('e').error(boom); });
    assert.match(atDebug.err, /kaboom/);
    assert.match(atDebug.err, /logger\.test\.js/, 'the stack is the useful part at debug');
});

// ---------------------------------------------------------------------------
// redaction — the load-bearing part
// ---------------------------------------------------------------------------

test('a credential object is redacted without the call site asking', () => {
    // Exactly the shape ssoUtils/ec2Utils/irsaUtils hand to a log line.
    let roleCredentials = {
        accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: 'IQoJb3JpZ2luX2VjSUPERSECRETTOKEN',
        expiration: 1757390000000
    };
    let captured = capture('debug', () => {
        let log = logger.create('creds');
        log.error('minting failed for ', { profileName: 'p', roleCredentials: roleCredentials });
        log.warn('warn ', roleCredentials);
        log.info('info ', roleCredentials);
        log.debug('debug ', roleCredentials);
    });
    assert.ok(!captured.all.includes('wJalrXUtnFEMI'), 'secretAccessKey must never be printed');
    assert.ok(!captured.all.includes('SUPERSECRETTOKEN'), 'sessionToken must never be printed');
    // Masked, not hidden: it answers "which credentials was that?" and is not a secret.
    assert.match(captured.all, /ASIA\*\*\*\*MPLE/);
    // The parts that make the line worth having survive.
    assert.match(captured.all, /expiration/);
    assert.match(captured.all, /profileName/);
});

test('a raw response body passed as a string is redacted too', () => {
    // The historical leak: the parsed copy was wrapped in redact.forLog and the
    // raw body logged on the line above it was not.
    let body = '{"accessToken":"aws-sso-oidc-ACCESSTOKENVALUE",' +
        '"refreshToken":"REFRESHTOKENVALUE","tokenType":"Bearer","expiresIn":28800}';
    let captured = capture('debug', () => {
        logger.create('sso').debug('CreateToken response: ', body);
    });
    assert.ok(!captured.out.includes('ACCESSTOKENVALUE'), 'an OIDC access token must not be printed');
    assert.ok(!captured.out.includes('REFRESHTOKENVALUE'), 'an OIDC refresh token must not be printed');
    assert.match(captured.out, /expiresIn/);
});

test("a presigned URL's signature and security token are redacted", () => {
    let url = 'https://s3.amazonaws.com/b/k?X-Amz-Credential=ASIAIOSFODNN7EXAMPLE%2F20260909' +
        '&X-Amz-Signature=deadbeefdeadbeefdeadbeefdeadbeef' +
        '&X-Amz-Security-Token=IQoJTOKENINTHEQUERYSTRING&X-Amz-Expires=3600';
    let captured = capture('debug', () => {
        logger.create('presign').debug('presigned: ' + url);
    });
    assert.ok(!captured.out.includes('deadbeef'), 'the signature IS the credential in a presigned URL');
    assert.ok(!captured.out.includes('TOKENINTHEQUERYSTRING'), 'the session token must not be printed');
    // The rest of the URL stays, so a mismatch is still debuggable.
    assert.match(captured.out, /X-Amz-Expires=3600/);
});

test('a bearer token and an LLM provider key are redacted', () => {
    let captured = capture('debug', () => {
        let log = logger.create('rest');
        log.debug('headers: ', { Authorization: 'Bearer THEBEARERVALUE', 'Content-Type': 'application/json' });
        log.debug('llm: ', { provider: 'openai', apiKey: 'sk-proj-FAKEPROVIDERKEY' });
    });
    assert.ok(!captured.out.includes('THEBEARERVALUE'), 'an Authorization header must not be printed');
    assert.ok(!captured.out.includes('PROVIDERKEY'), 'a provider API key must not be printed');
    assert.match(captured.out, /application\/json/);
});

test('double redaction is harmless, so an explicit call-site wrap still works', () => {
    // Many call sites already wrap in redact.forLog; the logger redacts again.
    // If that were not idempotent, every one of those lines would be mangled.
    let redact = require('../lib/redact');
    let payload = { accessKeyId: 'ASIAIOSFODNN7EXAMPLE', sessionToken: 'TOK', region: 'us-east-1' };
    let once = capture('debug', () => { logger.create('x').debug(payload); });
    let twice = capture('debug', () => { logger.create('x').debug(redact.forLog(payload)); });
    let strip = function (s) { return s.replace(/^\S+ /, ''); };   // drop the timestamp
    assert.equal(strip(twice.out), strip(once.out));
});

test('a secret is redacted even when the level gate is the only thing between it and stdout', () => {
    // Belt and braces: nothing is written at all when the level is off, so a
    // credential passed to a suppressed debug line cannot reach the stream either.
    let captured = capture('error', () => {
        logger.create('gate').debug('secretAccessKey=wJalrXUtnFEMIQUIET');
    });
    assert.equal(captured.all, '');
});

// ---------------------------------------------------------------------------
// no console.* in lib/ — source inspection
// ---------------------------------------------------------------------------

/**
 * Find `console.<method>(` occurrences and say, for each, whether it sits in real
 * code or inside a comment / string literal.
 *
 * A regex over the raw source cannot tell those apart, and both of the exemptions
 * below are of the second kind: sandboxRuntimes.js ships `console.log` inside the
 * JavaScript *starter templates* handed to the user in the Sandbox editor (that is
 * the user's program, not ours — converting them would corrupt every template),
 * and a couple of files quote `console.log` in a comment. So this is a small state
 * machine rather than a grep.
 */
function findConsoleCalls(source) {
    const CODE = 0, LINE_COMMENT = 1, BLOCK_COMMENT = 2, SQUOTE = 3, DQUOTE = 4, TEMPLATE = 5;
    let state = CODE;
    let hits = [];        // { index, inCode }
    let line = 1;
    for (let i = 0; i < source.length; i++) {
        let c = source[i];
        let next = source[i + 1];
        if (c === '\n') {
            line++;
            if (state === LINE_COMMENT) { state = CODE; }
            continue;
        }
        switch (state) {
            case CODE:
                if (c === '/' && next === '/') { state = LINE_COMMENT; i++; continue; }
                if (c === '/' && next === '*') { state = BLOCK_COMMENT; i++; continue; }
                if (c === "'") { state = SQUOTE; continue; }
                if (c === '"') { state = DQUOTE; continue; }
                if (c === '`') { state = TEMPLATE; continue; }
                if (source.startsWith('console.', i) && /^console\.\w+\s*\(/.test(source.slice(i, i + 40))) {
                    hits.push({ line: line, inCode: true });
                    i += 'console.'.length - 1;
                }
                continue;
            case LINE_COMMENT:
            case BLOCK_COMMENT:
                if (state === BLOCK_COMMENT && c === '*' && next === '/') { state = CODE; i++; continue; }
                if (source.startsWith('console.', i)) { hits.push({ line: line, inCode: false }); }
                continue;
            case SQUOTE:
            case DQUOTE:
            case TEMPLATE:
                if (c === '\\') { i++; continue; }
                if ((state === SQUOTE && c === "'") || (state === DQUOTE && c === '"') ||
                    (state === TEMPLATE && c === '`')) {
                    state = CODE;
                    continue;
                }
                if (source.startsWith('console.', i)) { hits.push({ line: line, inCode: false }); }
                continue;
        }
    }
    return hits;
}

function listJsFiles(dir) {
    let found = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
            return;
        }
        let full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found = found.concat(listJsFiles(full));
        } else if (entry.name.endsWith('.js')) {
            found.push(full);
        }
    });
    return found;
}

// The one file that legitimately contains `console.log` in *code-shaped* text:
// lib/sandbox/sandboxRuntimes.js's starter templates. It is exempt by being
// inside template literals, which the scanner already classifies as not-code —
// so it needs no entry here. This list is deliberately empty: add to it only
// with a reason, in a comment, next to the entry.
const CONSOLE_EXEMPT = [];

test('no console.* in lib/ — every log line goes through lib/logger.js', () => {
    let offenders = [];
    listJsFiles(path.join(REPO_ROOT, 'lib')).forEach(function (file) {
        let relative = path.relative(REPO_ROOT, file);
        if (CONSOLE_EXEMPT.indexOf(relative) !== -1) {
            return;
        }
        findConsoleCalls(fs.readFileSync(file, 'utf8')).forEach(function (hit) {
            if (hit.inCode) {
                offenders.push(relative + ':' + hit.line);
            }
        });
    });
    assert.deepEqual(offenders, [],
        'these bypass the redaction and the level gate; use require("./logger").create(scope): ' +
        offenders.join(', '));
});

test("sandboxRuntimes' console.log calls are the user's starter templates, not ours", () => {
    // If someone ever "cleans these up" they will corrupt every Sandbox template,
    // so assert both halves: the occurrences exist, and none of them is our code.
    let source = fs.readFileSync(path.join(REPO_ROOT, 'lib/sandbox/sandboxRuntimes.js'), 'utf8');
    let hits = findConsoleCalls(source);
    assert.ok(hits.length > 0, 'the JS/TS starter templates print their results with console.log');
    assert.deepEqual(hits.filter(function (h) { return h.inCode; }), []);
});

test('server.js keeps exactly one deliberate console.*: the require-failed catch', () => {
    // The bottom-of-file catch handles "requiring lib/ threw", i.e. the case where
    // the logger is precisely the thing that is unavailable. Everything above it
    // must use the logger.
    let source = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
    let inCode = findConsoleCalls(source).filter(function (h) { return h.inCode; });
    assert.equal(inCode.length, 2, 'only the two console.error lines in the final catch');
    let catchLine = source.slice(0, source.lastIndexOf('} catch (err) {')).split('\n').length;
    inCode.forEach(function (hit) {
        assert.ok(hit.line > catchLine,
            'console.* at server.js:' + hit.line + ' is outside the require-failed catch');
    });
    assert.match(source, /require\('\.\/lib\/logger'\)\.create\('server'\)/);
});

test('config.properties.example documents the [logging] level', () => {
    // The knob is only useful if a fresh clone can find it.
    let example = fs.readFileSync(path.join(REPO_ROOT, 'config.properties.example'), 'utf8');
    assert.match(example, /^\[logging\]$/m);
    assert.match(example, /^level=info$/m);
    assert.match(example, /LOG_LEVEL/);
});
