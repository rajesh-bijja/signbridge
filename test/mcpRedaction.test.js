"use strict";

// An MCP tool result is not a UI response. It becomes part of the model's
// context, so with a hosted client it leaves this machine and is retained in a
// third party's conversation history. `list_profiles` used to return each profile
// verbatim — including the cached STS triple in `irsaRoleCredentials` /
// `roleCredentials` / `ec2RoleCredentials`, i.e. a live secret access key and
// session token. Nothing failed while that was true, which is the whole reason
// this file exists.
//
// Two halves: the scrubber's behaviour (a pure function, so real assertions), and
// source inspection that it stays wired into the one place tool results are
// serialised. A handler that bypasses ok() would leak again with nothing to show.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const toolsSource = fs.readFileSync(
    path.join(__dirname, '..', 'mcp', 'tools.mjs'), 'utf8');

// Prose is not code. This module documents its own constraints at length, so an
// assertion about what the code does must not read the sentences describing it.
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

// mcp/tools.mjs is ESM; a dynamic import works from CommonJS. Its deps (zod,
// zod-to-json-schema) resolve from mcp/node_modules, which the app already needs
// for the MCP HTTP endpoint — so if this import fails, `cd mcp && npm install`.
let scrubForModel;
test.before(async function () {
    const mod = await import('../mcp/tools.mjs');
    scrubForModel = mod.scrubForModel;
    assert.strictEqual(typeof scrubForModel, 'function',
        'mcp/tools.mjs must keep exporting scrubForModel so it can be tested');
});

// The real *shape*: what lib/irsaUtils.js caches on a profile after a successful
// AssumeRoleWithWebIdentity, as list_profiles returned it. The values are
// synthetic and say so — test/secretHygiene.test.js scans this repo for
// credential-shaped strings and will fail on a fixture copied from a live run,
// which is right: a captured session token is a secret even after it expires.
function irsaProfile() {
    return {
        profileName: 'My_New_IRSA_Profile',
        irsaEnabled: true,
        irsaRoleArn: 'arn:aws:iam::123456789012:role/irsa-api-service',
        irsaRoleCredentials: {
            accessKeyId: 'ASIAEXAMPLE123456789',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKEN',
            expiration: 1788981865000,
            source: 'irsa',
            subjectFromWebIdentityToken: 'system:serviceaccount:assistants:api-service'
        }
    };
}

test('a cached STS triple never reaches the model', function () {
    const out = scrubForModel(irsaProfile());
    const creds = out.irsaRoleCredentials;

    assert.match(creds.secretAccessKey, /^\[redacted/);
    assert.match(creds.sessionToken, /^\[redacted/);
    // The whole serialised result must not contain the secret anywhere.
    const text = JSON.stringify(out);
    assert.doesNotMatch(text, /wJalrXUtnFEMI/);
    assert.doesNotMatch(text, /EXAMPLESESSIONTOKEN/);
    assert.doesNotMatch(text, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, 'no raw access key id either');
});

test('what survives is what makes a profile debuggable', function () {
    // Redaction that also removes the diagnostics turns "which credentials was
    // that, and are they expired?" into an unanswerable question over MCP — so
    // the key id is masked rather than dropped, and the metadata stays.
    const creds = scrubForModel(irsaProfile()).irsaRoleCredentials;
    assert.strictEqual(creds.accessKeyId, 'ASIA****6789');
    assert.strictEqual(creds.expiration, 1788981865000);
    assert.strictEqual(creds.source, 'irsa');
    assert.strictEqual(creds.subjectFromWebIdentityToken,
        'system:serviceaccount:assistants:api-service');
    assert.strictEqual(scrubForModel(irsaProfile()).irsaRoleArn,
        'arn:aws:iam::123456789012:role/irsa-api-service');
});

test('every stored credential field on a profile is covered, not just the STS ones', function () {
    const profile = {
        profileName: 'everything',
        awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        ec2SshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn...',
        ec2SshPrivateKeyPassphrase: 'hunter2',
        ec2SshPassword: 'hunter2',
        basicAuthPassword: 'hunter2',
        bearerStaticToken: 'eyJhbGciOiJIUzI1NiJ9.x.y',
        region: 'us-east-1'
    };
    const out = scrubForModel(profile);

    ['awsSecretAccessKey', 'ec2SshPrivateKey', 'ec2SshPrivateKeyPassphrase',
        'ec2SshPassword', 'basicAuthPassword', 'bearerStaticToken'].forEach(function (field) {
        assert.match(out[field], /^\[redacted/, field + ' must be redacted');
    });
    assert.strictEqual(out.awsAccessKeyId, 'AKIA****MPLE', 'the key id identifies, it is not a secret');
    assert.strictEqual(out.region, 'us-east-1', 'non-secret fields pass through');
    assert.doesNotMatch(JSON.stringify(out), /wJalrXUtnFEMI|hunter2|BEGIN OPENSSH/);
});

test('an OAuth2 token-fetch field holding a client secret is masked', function () {
    // bearerTokenFields keys are the OAuth spec's and user-chosen, so this is the
    // one place a substring rule is right.
    const out = scrubForModel({
        profileName: 'oauth',
        bearerTokenFields: [
            { key: 'grant_type', value: 'client_credentials' },
            { key: 'client_id', value: 'sb-app' },
            { key: 'client_secret', value: 'M4nyS3cr3tsH3re' },
            { key: 'password', value: 'hunter2' }
        ]
    });
    const byKey = {};
    out.bearerTokenFields.forEach(function (r) { byKey[r.key] = r.value; });
    assert.strictEqual(byKey.grant_type, 'client_credentials', 'the grant type is not a secret');
    assert.strictEqual(byKey.client_id, 'sb-app', 'the client id is not a secret');
    assert.match(byKey.client_secret, /^\[redacted/);
    assert.match(byKey.password, /^\[redacted/);
});

test('a credential in a stored request header is masked', function () {
    // get_history_details / get_favorite_details return the stored request, and a
    // user may have typed an Authorization header by hand. Re-invoking does not
    // need it: invoke_api names a profile and the server supplies the auth.
    const out = scrubForModel({
        request: {
            endpoint: 'https://api.example.com/v1/things',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.leaked',
                'X-Api-Key': 'sk-EXAMPLE-not-a-real-key',
                'x-amz-security-token': 'IQoJb3JpZ2lu',
                'X-Request-Id': 'abc-123'
            }
        }
    });
    const h = out.request.headers;
    assert.strictEqual(h['Content-Type'], 'application/json');
    assert.strictEqual(h['X-Request-Id'], 'abc-123', 'ordinary headers are left alone');
    assert.match(h.Authorization, /^\[redacted/);
    assert.match(h['X-Api-Key'], /^\[redacted/, 'header matching is case-insensitive');
    assert.match(h['x-amz-security-token'], /^\[redacted/);
});

test('the user\'s own content is not touched', function () {
    // The line is ownership: SignBridge redacts the secrets IT stores, never the
    // data the user asked the model to fetch. Blanking a `password` key inside an
    // S3 object the user opened would make the tool lie about the object.
    const out = scrubForModel({
        preview: {
            kind: 'json',
            text: '{"db_password":"in-the-file"}',
            rows: [{ user: 'a', password: 'in-the-file' }]
        },
        response: {
            responseStatusCode: 200,
            responseData: { access_token: 'the-api-under-test-returned-this' }
        }
    });
    assert.match(out.preview.text, /in-the-file/);
    assert.strictEqual(out.preview.rows[0].password, 'in-the-file');
    assert.strictEqual(out.response.responseData.access_token,
        'the-api-under-test-returned-this',
        'an invoked API\'s own response body is the answer to the question');
});

test('scrubbing walks arrays and nesting, and leaves non-objects alone', function () {
    const out = scrubForModel([irsaProfile(), { profileName: 'p2', awsSecretAccessKey: 'x' }]);
    assert.match(out[0].irsaRoleCredentials.secretAccessKey, /^\[redacted/);
    assert.match(out[1].awsSecretAccessKey, /^\[redacted/);

    assert.strictEqual(scrubForModel(null), null);
    assert.strictEqual(scrubForModel(undefined), undefined);
    assert.strictEqual(scrubForModel('a string'), 'a string');
    assert.strictEqual(scrubForModel(42), 42);
    // An absent or empty value stays as it is: "" and null are meaningful answers
    // to "is a key configured?", and replacing them would invent a credential.
    const empty = scrubForModel({ awsSecretAccessKey: null, bearerStaticToken: '' });
    assert.strictEqual(empty.awsSecretAccessKey, null);
    assert.strictEqual(empty.bearerStaticToken, '');
});

// --- Source inspection: it has to stay wired ----------------------------------

test('every tool result goes through the scrubber', function () {
    // ok() is the single serialisation point for every tool. If a handler grew
    // its own `return { content: [...] }`, it would bypass this.
    assert.match(toolsSource, /function ok\(data\) \{\s*\n\s*return \{ content: \[\{ type: 'text', text: JSON\.stringify\(scrubForModel\(data\)/,
        'ok() must scrub before stringifying');

    const wrappers = toolsSource.match(/content:\s*\[\{\s*type:\s*'text'/g) || [];
    assert.strictEqual(wrappers.length, 2,
        'only ok() and fail() may build an MCP content envelope; a handler that builds'
        + ' its own would skip the scrubber. Found ' + wrappers.length + ' — route it'
        + ' through ok() instead.');
});

test('the chat agent inherits the scrub rather than needing its own', function () {
    // buildOpenAiTools unwraps ok()'s already-scrubbed text. That is load-bearing:
    // the in-process chat agent sends tool results to a provider too, so a version
    // that called tool handlers directly would leak on that path only.
    const start = toolsSource.indexOf('export function buildOpenAiTools');
    assert.notStrictEqual(start, -1);
    const body = toolsSource.slice(start, start + 1200);
    assert.match(body, /JSON\.parse\(result\.content\[0\]\.text\)/,
        'buildOpenAiTools must unwrap ok()\'s text (already scrubbed), not call the'
        + ' handler\'s underlying API response directly.');
});

test('the scrubber stays self-contained so mcp/ can still be published alone', function () {
    // mcp/ is publishable on its own for the npx stdio path (mcp/package.json
    // files: server.js, tools.mjs), so it cannot import ../lib/redact.js — the
    // same reason AWS_AUTHN_MODES and SANDBOX_RUNTIMES are literal copies here.
    //
    // Comments are stripped first: the module explains in prose that it *cannot*
    // require() the CommonJS registries, and matching that sentence would fail the
    // test for saying the right thing.
    const code = stripComments(toolsSource);
    assert.doesNotMatch(code, /\brequire\s*\(/,
        'mcp/tools.mjs is ESM and published standalone — it must not require() anything.');
    assert.doesNotMatch(code, /from\s+['"]\.\.\/(?!\.)/,
        'mcp/tools.mjs must not reach outside mcp/ — it is published as a standalone'
        + ' package for `npx`, where ../lib does not exist.');
});

test('no tool schema accepts a credential', function () {
    // The other direction: a model must never be asked for a secret either. It
    // names a profile; the server holds the credentials.
    const forbidden = ['awsSecretAccessKey', 'secretAccessKey', 'sessionToken', 'apiKey'];
    const schemaOnly = toolsSource.slice(0, toolsSource.indexOf('export function buildTools'));
    forbidden.forEach(function (field) {
        // PROFILE_FIELDS legitimately declares awsSecretAccessKey (create_profile
        // has to be able to save one), so only the STS/inference ones are barred.
        if (field === 'awsSecretAccessKey') { return; }
        assert.doesNotMatch(schemaOnly, new RegExp('\\b' + field + ':\\s*z\\.'),
            'no tool may accept ' + field + ' as an argument');
    });
});
