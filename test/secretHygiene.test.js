"use strict";

/**
 * secretHygiene.test.js — the guardrails for publishing this repo.
 *
 * This file used to check two files: it scanned `config.properties.example` for
 * three secret shapes and `README.md` for internal references. That is a spot
 * check, and the thing being guaranteed is repo-wide — "no config, secret or API
 * key is in the repo" is a statement about *every* file that would be committed,
 * including the one someone adds next week. So the scans below run over
 * `git ls-files --cached --others --exclude-standard`, which is precisely the set
 * `git commit -a` would record: tracked files plus untracked-and-not-ignored
 * ones. A new file is covered the moment it exists, with nobody adding it here.
 *
 * Three kinds of assertion, in order:
 *
 *   1. **Nothing secret-bearing is committable** — .gitignore and .dockerignore
 *      exclude the paths that hold real credentials, and no `.env` or
 *      `config.properties` is tracked. .dockerignore matters as much as
 *      .gitignore: the Dockerfile is published too, and a build context carrying
 *      `keys/` or a real `config.properties` bakes them into an image layer.
 *
 *   2. **No credential-shaped string is committable** — every file is scanned for
 *      AWS key ids, provider key prefixes, PEM private-key blocks, JWTs and
 *      assigned secret literals. Matches are allowed only when they are
 *      *recognisably* fake (see PLACEHOLDER_MARKERS) or explicitly listed. That
 *      rule is uniform across lib/, frontend/ and test/ — a real key pasted into
 *      a test fixture is exactly as published as one in shipped code.
 *
 *   3. **Runtime state cannot land in the repo** — the app's writable state lives
 *      under ~/.signbridge and nowhere else, so the assertions are that
 *      lib/paths.js is the only module that builds that base directory, that
 *      every other os.homedir() use is a documented ~/.aws reader, and that no
 *      write call anywhere is rooted at __dirname / process.cwd(). Those are
 *      source-inspection tests because the failure is silent: a module that
 *      writes a settings file next to itself works perfectly and quietly makes
 *      the repo dirty with user data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function lines(rel) {
    return read(rel).split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// the file set: what `git commit -a` would actually record
// ---------------------------------------------------------------------------

/**
 * Tracked + untracked-but-not-ignored paths. Returns null when this is not a git
 * checkout (an extracted tarball, or an npx-installed copy), in which case the
 * scans skip rather than fail — they are contributor guardrails, and there is no
 * commit to guard in that situation.
 */
function committableFiles() {
    let out;
    try {
        out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
            { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
        return null;
    }
    return out.split('\n')
        .filter(function (f) { return f && fs.existsSync(path.join(repoRoot, f)); })
        .filter(function (f) { return fs.statSync(path.join(repoRoot, f)).isFile(); });
}

// Rasterised brand assets and fonts: bytes, not text. Everything else is scanned,
// lock files included — a lock file is a normal place for a registry credential
// to end up in a URL.
const BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|eot|zip|jar|class|so|dylib)$/i;

function scannableFiles() {
    const files = committableFiles();
    if (!files) {
        return null;
    }
    return files.filter(function (f) { return !BINARY.test(f); });
}

function eachScannableLine(callback) {
    const files = scannableFiles();
    if (!files) {
        return false;
    }
    files.forEach(function (rel) {
        const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        content.split('\n').forEach(function (line, index) {
            callback(rel, index + 1, line, content);
        });
    });
    return true;
}

// ---------------------------------------------------------------------------
// 1. nothing secret-bearing is committable
// ---------------------------------------------------------------------------

test('.gitignore excludes every secret-bearing path', () => {
    const entries = lines('.gitignore');
    const mustIgnore = [
        '.env',              // no .env is used, but a stray one must never land
        '.env.*',            // ...nor a variant of it
        'config.properties', // the local runtime config
        '.aws/',             // mounted AWS credentials
        'keys/',             // TLS private key + the LLM wrapping key
        '*.pem',
        '*.key',
        '*.crt',
        '*.p12',
        '*.pfx',
        'data/',             // legacy per-user artifacts location
        '.signbridge/',      // ...and the current one, if a copy is ever made here
        'logs/'
    ];
    mustIgnore.forEach(function (entry) {
        assert.ok(entries.includes(entry),
            '.gitignore must contain an exact line for "' + entry + '"');
    });
});

test('.dockerignore keeps secrets and local state out of the build context', () => {
    // The published Dockerfile builds from this directory. A context that carries
    // keys/ or a real config.properties bakes them into an image layer, which is
    // a leak that no .gitignore prevents and that `docker history` exposes.
    const entries = lines('.dockerignore');
    ['keys', 'data', '.env', '.env.*', '.aws', 'config.properties', '*.pem', '*.key']
        .forEach(function (entry) {
            assert.ok(entries.includes(entry),
                '.dockerignore must contain an exact line for "' + entry + '"');
        });
});

// SignBridge has no .env-based configuration: operator knobs live in
// config.properties and provider keys are entered in Settings and sealed under
// ~/.signbridge. A tracked .env.example would undo that by telling every reader
// to create the one file we do not want holding a secret, so the template is
// gone and this asserts it stays gone.
test('no .env template is tracked, and .gitignore does not re-include one', () => {
    assert.ok(
        !fs.existsSync(path.join(repoRoot, '.env.example')),
        '.env.example must not exist: config lives in config.properties, keys in Settings'
    );
    assert.ok(
        !read('.gitignore').includes('!.env'),
        '.gitignore must not re-include any .env file'
    );
});

test('only the .example templates are committable, never a real config', () => {
    const files = committableFiles();
    if (!files) {
        return;   // not a git checkout; nothing to commit
    }
    const forbidden = files.filter(function (f) {
        const base = path.basename(f);
        if (base === 'config.properties' || base.startsWith('.env')) {
            return true;
        }
        return /\.(pem|key|crt|p12|pfx)$/i.test(base);
    });
    assert.deepEqual(forbidden, [],
        'these hold real configuration or key material and must be gitignored: ' +
        forbidden.join(', '));
    // The template that replaces them has to still be there, or a fresh clone has
    // nothing to copy.
    assert.ok(files.includes('config.properties.example'));
});

test('config.properties.example ships no slot for a secret', () => {
    // Not just "no secret in it" — no *key-shaped setting* at all, because a
    // commented-out `apiKey=` is an instruction to put a live key in a file that
    // people edit by hand and occasionally paste into an issue.
    const example = read('config.properties.example');
    lines('config.properties.example').forEach(function (line, i) {
        if (line.trim().startsWith('#')) {
            return;   // prose may (and does) explain that keys live elsewhere
        }
        assert.ok(!/^\s*(apiKey|api_key|LLM_API_KEY|password|secret|token)\s*=/i.test(line),
            'config.properties.example:' + (i + 1) + ' declares a secret setting: ' + line.trim());
    });
    // ...and there is no [llm] section at all any more. Every part of the LLM
    // configuration — the on/off switch, the provider, the credential, the model
    // and the agent's behavioural knobs — is chosen in Settings and stored per
    // user, so a template that still offered any of them would be read as *the*
    // configuration path and then silently ignored. Worse for the switch
    // specifically: while `enabled` lived here it was the value that actually
    // decided, and the toggle in the UI was decorative.
    assert.ok(!/^\s*\[llm\]/m.test(example),
        'config.properties.example must not reintroduce an [llm] section — AI features are ' +
        'configured in Settings, and a setting split between a file and a form is a setting ' +
        'where the form lies');
    ['provider', 'model', 'baseUrl', 'enabled', 'reasoningEffort', 'maxToolIterations'].forEach(function (key) {
        assert.ok(!new RegExp('^\\s*' + key + '\\s*=', 'm').test(example),
            'config.properties.example must not reintroduce llm.' + key +
            ' — it is chosen in Settings and stored per user');
    });
});

// ---------------------------------------------------------------------------
// 2. no credential-shaped string is committable
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
    { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { name: 'AWS secret access key', re: /aws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+]{40})/gi },
    { name: 'provider API key', re: /\bsk-(?:ant-|or-v1-|proj-|admin-)?[A-Za-z0-9_-]{16,}/g },
    { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { name: 'GitHub token', re: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/g },
    { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
    // A header line on its own is a form placeholder or a doc example; a header
    // followed by base64 is key material.
    { name: 'PEM private key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----\s*\n[A-Za-z0-9+/=]{40}/g },
    { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { name: 'bearer literal', re: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g },
    {
        name: 'assigned secret literal',
        re: /(?:secret|password|passphrase|api[_-]?key|apiKey|accessToken|refreshToken|sessionToken)["']?\s*[=:]\s*["']([A-Za-z0-9/+_=.-]{16,})["']/gi
    }
];

/**
 * A match is accepted when it says of itself that it is not real. Every fake
 * credential in this repo — AWS's own published example values, the fixtures the
 * signing and redaction tests are built on, the placeholders in the profile forms
 * — carries one of these. Requiring the marker rather than allowlisting values
 * means the rule holds for fixtures that do not exist yet, and the failure tells
 * the author what to do: name it EXAMPLE/FAKE/... or add it below with a reason.
 */
const PLACEHOLDER_MARKERS = [
    'example', 'exampl', 'fake', 'dummy', 'placeholder', 'sample', 'test',
    'notreal', 'never', 'leaked', 'redacted', 'secret', 'token', 'your-', 'xxxx'
];

/**
 * Values that are unmistakably synthetic but carry no marker, each one a fixture
 * whose exact text an assertion depends on. Add an entry only with a reason; the
 * cheaper fix is almost always to rename the fixture so the marker rule covers it.
 */
const KNOWN_TEST_FIXTURES = [
    // test/llmConfig.test.js — provider keys in the settings-precedence fixtures.
    'sk-openai-1234567890',
    'sk-ant-0987654321',
    'sk-someone-elses',
    // test/llmConfig.test.js — maskKey asserts on this value's prefix and last four.
    'sk-proj-abcdefghijklmnopqrstuvwxyz7890',
    // test/llmProviders.test.js — looksLikeKey's positive case.
    'sk-proj-abcdef1234567890',
    // test/redact.test.js — a base64 blob standing in for an OIDC client secret
    // ("key-example" encoded), which is the point of the fixture.
    'eyJraWQiOiJrZXktZXhhbXBsZSIsImVuYyI6IkExMjhH'
];

function looksSynthetic(value) {
    const lower = value.toLowerCase();
    if (KNOWN_TEST_FIXTURES.indexOf(value) !== -1) {
        return true;
    }
    return PLACEHOLDER_MARKERS.some(function (marker) { return lower.indexOf(marker) !== -1; });
}

test('no real-looking credential is committable, in any file', () => {
    const offenders = [];
    const scanned = eachScannableLine(function (rel, lineNo, line) {
        if (rel === 'test/secretHygiene.test.js') {
            return;   // this file necessarily contains the patterns and the fixtures
        }
        SECRET_PATTERNS.forEach(function (pattern) {
            const re = new RegExp(pattern.re.source, pattern.re.flags);
            let match;
            while ((match = re.exec(line)) !== null) {
                const value = match[1] || match[0];
                if (!looksSynthetic(value)) {
                    offenders.push(rel + ':' + lineNo + ' — ' + pattern.name + ' — ' + value);
                }
                if (match.index === re.lastIndex) {
                    re.lastIndex++;   // zero-length safety
                }
            }
        });
    });
    if (!scanned) {
        return;   // not a git checkout
    }
    assert.deepEqual(offenders, [],
        'credential-shaped strings that do not look synthetic. If one is a fixture, ' +
        'give it a placeholder marker (EXAMPLE/FAKE/TEST/...) or add it to ' +
        'KNOWN_TEST_FIXTURES with a reason:\n  ' + offenders.join('\n  '));
});

// A PEM *header* on its own is legitimate (a textarea placeholder, a doc example),
// so the pattern above deliberately requires a base64 body. Assert that the loose
// form is still only in those two harmless shapes, so a real key file pasted into
// a fixture cannot hide behind the narrower pattern.
test('a PEM header appears only as a placeholder, never with key material', () => {
    const offenders = [];
    const scanned = eachScannableLine(function (rel, lineNo, line, content) {
        if (rel === 'test/secretHygiene.test.js' || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
            return;
        }
        // The body would be the next line: base64 at length, or nothing.
        const rest = content.split('\n').slice(lineNo).join('\n');
        if (/^\s*[A-Za-z0-9+/=]{40}/.test(rest)) {
            offenders.push(rel + ':' + lineNo);
        }
    });
    if (!scanned) {
        return;
    }
    assert.deepEqual(offenders, [], 'these look like real private keys: ' + offenders.join(', '));
});

// ---------------------------------------------------------------------------
// internal references — the OSS copy is a lift-and-shift of an internal app
// ---------------------------------------------------------------------------

// Company names, the old product name, and internal hostnames. Scanned over every
// committable file rather than two of them, because the internal identifiers that
// survived the lift are in code comments and fixtures, not in the README.
const INTERNAL_REFERENCE = /boomtrain|zetaglobal|zglbl|zeta-aiml|presigncopilot|presign_copilot/i;

// 12-digit AWS account ids are the internal identifier most likely to be pasted
// into a comment or a fixture, and the two we know about are not the risk — the
// next one is. So instead of naming them, every 12-digit number must be one of
// AWS's documentation placeholders.
const PLACEHOLDER_ACCOUNT_IDS = [
    '123456789012', '111122223333', '222233334444', '333344445555',
    '444455556666', '555566667777', '666677778888', '777788889999',
    '888899990000', '999988887777'
];

test('no internal reference is committable', () => {
    const offenders = [];
    const scanned = eachScannableLine(function (rel, lineNo, line) {
        if (rel === 'test/secretHygiene.test.js') {
            return;   // holds the forbidden words by definition
        }
        const match = INTERNAL_REFERENCE.exec(line);
        if (match) {
            offenders.push(rel + ':' + lineNo + ' — ' + match[0]);
        }
    });
    if (!scanned) {
        return;
    }
    assert.deepEqual(offenders, [], 'internal references: ' + offenders.join(', '));
});

test('every AWS account id is a documentation placeholder', () => {
    const offenders = [];
    const scanned = eachScannableLine(function (rel, lineNo, line) {
        if (rel === 'test/secretHygiene.test.js' || /-lock\.json$/.test(rel)) {
            return;
        }
        const re = /(?<![\d.])\d{12}(?![\d.])/g;
        let match;
        while ((match = re.exec(line)) !== null) {
            if (PLACEHOLDER_ACCOUNT_IDS.indexOf(match[0]) === -1) {
                offenders.push(rel + ':' + lineNo + ' — ' + match[0]);
            }
        }
    });
    if (!scanned) {
        return;
    }
    assert.deepEqual(offenders, [],
        'a 12-digit number that is not an AWS documentation placeholder — if it is a ' +
        'real account id it must not be published; if it is a timestamp or a byte ' +
        'count, that is a false positive worth rewriting: ' + offenders.join(', '));
});

test('an SSO start URL names a placeholder org, not a real one', () => {
    const offenders = [];
    const scanned = eachScannableLine(function (rel, lineNo, line) {
        if (rel === 'test/secretHygiene.test.js') {
            return;
        }
        const re = /\b([a-z0-9][a-z0-9-]*)\.awsapps\.com/gi;
        let match;
        while ((match = re.exec(line)) !== null) {
            const host = match[1].toLowerCase();
            const allowed = ['example', 'x', 'my-sso', 'my-org', 'your-org', 'd-example'];
            if (allowed.indexOf(host) === -1) {
                offenders.push(rel + ':' + lineNo + ' — ' + match[0]);
            }
        }
    });
    if (!scanned) {
        return;
    }
    assert.deepEqual(offenders, [],
        'an IAM Identity Center start URL contains the org name: ' + offenders.join(', '));
});

// ---------------------------------------------------------------------------
// 3. runtime state cannot land in the repo
// ---------------------------------------------------------------------------

function listSourceFiles(dir) {
    let found = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
            return;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found = found.concat(listSourceFiles(full));
        } else if (/\.(js|mjs|cjs|jsx)$/.test(entry.name)) {
            found.push(full);
        }
    });
    return found;
}

function backendSources() {
    return listSourceFiles(path.join(repoRoot, 'lib'))
        .concat(listSourceFiles(path.join(repoRoot, 'mcp')))
        .concat([path.join(repoRoot, 'server.js')]);
}

test('lib/paths.js is the only module that builds the runtime base directory', () => {
    // Every artifact path must come from lib/paths.js. A second module deriving
    // ~/.signbridge itself is how the two drift apart, and a module deriving some
    // *other* base is how user data ends up somewhere nobody backs up.
    const offenders = [];
    backendSources().forEach(function (file) {
        const rel = path.relative(repoRoot, file);
        if (rel === 'lib/paths.js') {
            return;
        }
        fs.readFileSync(file, 'utf8').split('\n').forEach(function (line, i) {
            if (line.indexOf('.signbridge') !== -1 && line.indexOf('os.homedir') !== -1) {
                offenders.push(rel + ':' + (i + 1));
            }
        });
    });
    assert.deepEqual(offenders, [],
        'use require("./paths") instead of deriving the base dir: ' + offenders.join(', '));

    const paths = read('lib/paths.js');
    assert.match(paths, /os\.homedir\(\)/, 'the base dir is under the user home');
    assert.match(paths, /'\.signbridge'/, 'and its name is fixed, not configurable');
});

// os.homedir() outside lib/paths.js means one thing only: locating the user's
// ~/.aws so profiles can be imported and written back. Those four call sites are
// listed rather than pattern-matched, so a fifth use has to be justified here.
const HOMEDIR_READERS = {
    'lib/paths.js': 'the ~/.signbridge base dir itself',
    'lib/awsConfigWriter.js': 'writes profiles back to ~/.aws/config',
    'lib/loadProfilesDaemon.js': 'imports ~/.aws profiles on startup',
    'lib/awsCliUtils.js': 'passes ~/.aws through to the AWS CLI'
};

test('os.homedir() is used only by paths.js and the ~/.aws readers', () => {
    const offenders = [];
    backendSources().forEach(function (file) {
        const rel = path.relative(repoRoot, file);
        if (HOMEDIR_READERS[rel]) {
            return;
        }
        // Code lines only: cursorAgent.js has a comment saying *not* to use
        // os.homedir(), and failing on that would teach people to stop explaining
        // the rule in the file where it matters.
        const code = fs.readFileSync(file, 'utf8').split('\n').filter(function (line) {
            const trimmed = line.trim();
            return trimmed && trimmed[0] !== '/' && trimmed[0] !== '*';
        }).join('\n');
        if (/os\.homedir|require\(['"]os['"]\)\.homedir/.test(code)) {
            offenders.push(rel);
        }
    });
    assert.deepEqual(offenders, [],
        'resolve paths through lib/paths.js, or document the use in HOMEDIR_READERS: ' +
        offenders.join(', '));
});

test('nothing writes to a path rooted in the repo', () => {
    // __dirname is legitimate for *reads* — config.properties, mcp/tools.mjs,
    // frontend/dist — and there are a dozen of those. A write is the problem, and
    // it is silent: the app works and the repo quietly fills with user data. So
    // this looks for a write call within two lines of a repo-rooted expression.
    const WRITE = /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|chmod|chmodSync)\s*\(/;
    const ROOTED = /__dirname|process\.cwd\(\)|applicationRoot/;
    const offenders = [];
    backendSources().forEach(function (file) {
        const rel = path.relative(repoRoot, file);
        const sourceLines = fs.readFileSync(file, 'utf8').split('\n');
        sourceLines.forEach(function (line, i) {
            if (!WRITE.test(line)) {
                return;
            }
            const context = sourceLines.slice(Math.max(0, i - 2), i + 2).join('\n');
            if (ROOTED.test(context)) {
                offenders.push(rel + ':' + (i + 1));
            }
        });
    });
    assert.deepEqual(offenders, [],
        'a write rooted at the repo directory — runtime state belongs under ' +
        '~/.signbridge via lib/paths.js: ' + offenders.join(', '));
});

test('the frontend never persists a provider key or credential locally', () => {
    // Browser storage is outside everything above: it is not in the repo and not
    // under ~/.signbridge, and a key put there survives a logout the app does not
    // have. The client is only ever shown a mask (llmSettings.toPublic), so there
    // is nothing to store — this asserts nobody starts.
    const offenders = [];
    listSourceFiles(path.join(repoRoot, 'frontend/src')).forEach(function (file) {
        const rel = path.relative(repoRoot, file);
        fs.readFileSync(file, 'utf8').split('\n').forEach(function (line, i) {
            if (!/(localStorage|sessionStorage)\.setItem/.test(line)) {
                return;
            }
            if (/apiKey|api_key|secret|password|token|credential/i.test(line)) {
                offenders.push(rel + ':' + (i + 1));
            }
        });
    });
    assert.deepEqual(offenders, [],
        'do not put a credential in browser storage: ' + offenders.join(', '));
});
