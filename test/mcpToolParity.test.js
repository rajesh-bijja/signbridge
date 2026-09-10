"use strict";

// MCP is meant to be a full second front end, not a subset of one: anything the
// dashboard can do, an IDE client should be able to ask for. But the two are wired
// independently — a route is added in server.js and a tool in mcp/tools.mjs — so
// the gap between them is invisible. Nothing fails when a feature ships to the UI
// and never reaches MCP; the tool simply is not there, and the model reports that
// SignBridge cannot do the thing.
//
// So this file compares the two tables and requires every route to be *decided*:
// either a tool posts to it, or it is listed below with the reason it is excluded.
// Adding a route without doing one of those fails the test, which is the point —
// the omission has to be deliberate rather than forgotten.
//
// The second half exercises the six tools that were added to close the gap, and
// the callApi options they introduced (a GET, and a raw-body PUT with its
// parameters on the query string). Those are the first non-POST-JSON calls in the
// tool set, so a transport that quietly dropped the options argument would break
// exactly them and nothing else.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const toolsSource = fs.readFileSync(path.join(repoRoot, 'mcp', 'tools.mjs'), 'utf8');

// Routes the dashboard uses that deliberately have no tool, each with the reason.
// Four kinds, and the distinction matters: plumbing has nothing to expose, a
// credential-returning route must not reach a model's context, key management must
// not be writable by an LLM, and a redundant route is already answered by a tool.
const EXCLUDED = {
    '/': 'the SPA itself',
    '/session': 'the browser session for the SPA; MCP carries its user in every payload',
    '/mcp': 'the MCP transport — it cannot be a tool of itself',
    '/s3Object': 'streams raw object bytes, not JSON; preview_s3_object is the readable form',
    '/sandboxCompletions': 'IntelliSense data for the Monaco editor; a model has its own knowledge',
    '/s3CancelSearch': 'cancels an in-flight search by the searchId of a socket the caller does not hold',
    '/cancelSandbox': 'cancels an in-flight run the same way; a tool call is synchronous',

    // Whole return value is a credential. An MCP tool result becomes part of the
    // model's context, so with a hosted client it leaves this machine.
    '/copyBearerToken': 'returns the bearer token itself',
    '/getRoleCredentialsForUser': 'returns an STS triple',
    '/prepareCurlRequest': 'returns a curl command carrying a live Authorization header'
        + ' (and x-amz-security-token for AWS) — it flags itself containsLiveCredential',

    // An MCP client is an LLM. It must not be able to write a provider credential
    // or spend the user's quota minting one. Also pinned by test/mcpLlmTools.test.js.
    '/testLlmConnection': 'sends a provider API key; key handling stays on Settings, where a human is',
    '/deleteLlmKey': 'destroys a stored credential',
    '/updateLlmSettings': 'can write a provider API key',

    // An MCP client is an LLM; asking it to drive SignBridge's own LLM is a loop
    // with no user in it.
    '/chat': 'runs SignBridge\'s own chat agent',
    '/chatNewThread': 'creates a thread for that agent; the chat-session tools read and manage them',

    // Already answered by a tool, so a second one would be a second way to ask.
    '/searchProfilesDetails': 'list_profiles returns the same profiles',
    '/llmProviders': 'list_llm_providers posts to /llmSettings, which includes the registry',
    '/s3BucketRegion': 'list_s3_buckets already reports each bucket\'s region'
};

function mountedRoutes() {
    const found = new Set();
    const re = /router\.(?:get|post|put|delete)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(serverSource)) !== null) {
        found.add(m[1]);
    }
    return found;
}

function toolPaths() {
    const found = new Set();
    let re = /callApi\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(toolsSource)) !== null) {
        found.add(m[1]);
    }
    // invokeEndpointForAuthnMode() picks the invoke route from the auth mechanism,
    // so those four paths are returned rather than passed to callApi literally.
    re = /return '(\/[A-Za-z0-9_]+)'/g;
    while ((m = re.exec(toolsSource)) !== null) {
        found.add(m[1]);
    }
    return found;
}

test('every tool posts to a route that exists', function () {
    const routes = mountedRoutes();
    const ghosts = [...toolPaths()].filter(function (p) { return !routes.has(p); });
    assert.deepStrictEqual(ghosts, [],
        'these tool paths are not mounted in server.js, so the tool fails with a 404 that'
        + ' reads like a server error: ' + ghosts.join(', '));
});

test('every route either has a tool or a stated reason not to', function () {
    const paths = toolPaths();
    const undecided = [...mountedRoutes()].filter(function (route) {
        return !paths.has(route) && !Object.prototype.hasOwnProperty.call(EXCLUDED, route);
    }).sort();

    assert.deepStrictEqual(undecided, [],
        'these routes are reachable from the dashboard but no MCP tool calls them: '
        + undecided.join(', ') + '. Either add a tool in mcp/tools.mjs (the usual answer —'
        + ' MCP is meant to have UI parity) or add the route to EXCLUDED in this test with'
        + ' the reason. An accidental omission is invisible otherwise.');
});

test('the exclusion list has no stale entries', function () {
    const routes = mountedRoutes();
    const paths = toolPaths();
    Object.keys(EXCLUDED).forEach(function (route) {
        assert.ok(routes.has(route),
            route + ' is excluded here but no longer mounted — drop it from EXCLUDED.');
        assert.ok(!paths.has(route),
            route + ' is excluded here but a tool now calls it. If that is intended, remove'
            + ' the exclusion; if it is not, the tool is a leak.');
        assert.ok(EXCLUDED[route] && EXCLUDED[route].length > 10,
            route + ' needs a real reason, not a placeholder.');
    });
});

test('no tool references a route whose response is a credential', function () {
    // Stronger than "there is no tool": the path must not appear in the module at
    // all, so a helper cannot reach it either.
    //
    // Comments are stripped first, because tools.mjs names these three routes in
    // its header in order to explain why they are absent. A test that fails on the
    // documentation of the rule it enforces teaches people to delete the comment.
    const code = toolsSource
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    ['/copyBearerToken', '/getRoleCredentialsForUser', '/prepareCurlRequest'].forEach(function (route) {
        assert.ok(code.indexOf(route) === -1,
            'mcp/tools.mjs must not reference ' + route + ': its response is a live credential,'
            + ' and a tool result is retained in the model\'s conversation history.');
    });
});

// --- The six tools added for parity, and the call shapes they introduced -------

let buildTools;
test.before(async function () {
    const mod = await import('../mcp/tools.mjs');
    buildTools = mod.buildTools;
});

// A recording callApi: captures what the handler asked for and answers with it.
function recorder(response) {
    const calls = [];
    const callApi = async function (pathName, payload, options) {
        calls.push({ path: pathName, payload: payload, options: options });
        return response === undefined ? { ok: true } : response;
    };
    return { calls: calls, callApi: callApi };
}

function toolNamed(name, callApi) {
    const tool = buildTools({ callApi: callApi, userName: 'signbridgeuser' })
        .find(function (t) { return t.name === name; });
    assert.ok(tool, 'no such tool: ' + name);
    return tool;
}

test('the parity tools exist and stamp the resolved user', async function () {
    const cases = [
        ['delete_collection_request', { requestDetailsFileName: 'req_1.json' },
            '/deleteRequestFromCollection', function (c) { return c.payload; }],
        ['import_aws_catalog_service', { service: 'dynamodb' },
            '/importAwsCatalogService', function (c) { return c.payload; }],
        ['get_chat_session', { threadId: 't-1' },
            '/chatThread', function (c) { return c.payload; }],
        ['explain_s3_search', { query: '*.log' },
            '/s3ExplainSearch', function (c) { return c.payload.options; }]
    ];

    for (const row of cases) {
        const rec = recorder();
        await toolNamed(row[0], rec.callApi).handler(row[1]);
        assert.strictEqual(rec.calls.length, 1, row[0] + ' should make one API call');
        assert.strictEqual(rec.calls[0].path, row[2]);
        assert.strictEqual(row[3](rec.calls[0]).userName, 'signbridgeuser',
            row[0] + ' must stamp the resolved user — the server trusts the payload for it');
    }
});

test('list_aws_catalog_services reaches a GET route and can filter it', async function () {
    // The first GET in the tool set. A transport that ignored the options argument
    // would POST to it and get a 404 that looks like a missing feature.
    const services = [
        { service: 'dynamodb', label: 'DynamoDB', apiVersion: '2012-08-10' },
        { service: 'dynamodbstreams', label: 'DynamoDB Streams', apiVersion: '2012-08-10' },
        { service: 's3', label: 'Amazon S3', apiVersion: '2006-03-01' }
    ];
    let rec = recorder({ services: services });
    let out = await toolNamed('list_aws_catalog_services', rec.callApi).handler({});
    assert.strictEqual(rec.calls[0].path, '/awsCatalogServices');
    assert.strictEqual(rec.calls[0].options.method, 'get');
    let body = JSON.parse(out.content[0].text);
    assert.strictEqual(body.serviceCount, 3, 'no search returns the whole index');

    rec = recorder({ services: services });
    out = await toolNamed('list_aws_catalog_services', rec.callApi).handler({ search: 'DYNAMO' });
    body = JSON.parse(out.content[0].text);
    assert.strictEqual(body.serviceCount, 2, 'matching is case-insensitive and substring');
    assert.deepStrictEqual(body.services.map(function (s) { return s.service; }),
        ['dynamodb', 'dynamodbstreams']);

    // A label-only match: the user says "Amazon S3", the index key is "s3".
    rec = recorder({ services: services });
    out = await toolNamed('list_aws_catalog_services', rec.callApi).handler({ search: 'amazon s3' });
    assert.strictEqual(JSON.parse(out.content[0].text).serviceCount, 1);
});

test('upload_s3_object sends the bytes as a raw PUT with parameters on the query', async function () {
    const rec = recorder({ uploaded: true });
    await toolNamed('upload_s3_object', rec.callApi).handler({
        profileName: 'poc', authnMode: 'sso_user', bucket: 'b', key: 'logs/app.log',
        content: 'hello'
    });
    const call = rec.calls[0];
    assert.strictEqual(call.path, '/s3UploadObject');
    assert.strictEqual(call.options.method, 'put');
    // The route is mounted with a raw body parser, so JSON parameters have nowhere
    // to go — they have to be on the query string or the upload silently 400s.
    assert.strictEqual(call.options.query.bucket, 'b');
    assert.strictEqual(call.options.query.key, 'logs/app.log');
    assert.strictEqual(call.options.query.userName, 'signbridgeuser');
    assert.ok(Buffer.isBuffer(call.payload), 'the body must be raw bytes, not JSON');
    assert.strictEqual(call.payload.toString('utf8'), 'hello');
    assert.ok(call.options.contentType, 'a raw body needs a Content-Type');
});

test('upload_s3_object decodes base64 and refuses an ambiguous body', async function () {
    let rec = recorder();
    await toolNamed('upload_s3_object', rec.callApi).handler({
        profileName: 'p', authnMode: 'iam_user', bucket: 'b', key: 'x.png',
        contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    });
    assert.deepStrictEqual([...rec.calls[0].payload], [0x89, 0x50, 0x4e, 0x47]);

    // Both, or neither, is a mistake that must not be guessed at: either choice
    // writes an object the caller did not ask for, over whatever was there.
    for (const bad of [{ content: 'a', contentBase64: 'YQ==' }, {}]) {
        rec = recorder();
        const args = Object.assign(
            { profileName: 'p', authnMode: 'iam_user', bucket: 'b', key: 'k' }, bad);
        const out = await toolNamed('upload_s3_object', rec.callApi).handler(args);
        assert.strictEqual(out.isError, true, JSON.stringify(bad) + ' should be refused');
        assert.strictEqual(rec.calls.length, 0, 'and refused before anything is written');
    }

    // An empty string is a body, though: a zero-byte object is a real object, and
    // it is how an empty folder marker is written.
    rec = recorder();
    await toolNamed('upload_s3_object', rec.callApi).handler({
        profileName: 'p', authnMode: 'iam_user', bucket: 'b', key: 'empty/', content: ''
    });
    assert.strictEqual(rec.calls.length, 1);
    assert.strictEqual(rec.calls[0].payload.length, 0);
});

test('all three callApi implementations accept the options argument', function () {
    // tools.mjs is shared by the stdio server, the in-process HTTP transport and
    // the chat agent, each of which builds its own axios caller. A GET or a raw PUT
    // works or 404s depending on which one is running, so they have to agree.
    ['mcp/server.js', 'mcp/mcpHttp.mjs', 'lib/chat/agent.js'].forEach(function (file) {
        const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        assert.match(source, /function callApi\(pathName, payload, options\)/,
            file + ' must take the options argument');
        assert.match(source, /axios\.get\(/, file + ' must be able to GET');
        assert.match(source, /axios\[method\]\(/, file + ' must dispatch put/post by method');
        assert.match(source, /config\.params = opts\.query/, file + ' must pass query parameters');
    });
});
