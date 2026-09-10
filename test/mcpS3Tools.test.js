"use strict";

// MCP parity for S3 World.
//
// Same drift risk as the sandbox tools: nothing fails at build time if an S3
// route is renamed or a tool starts posting somewhere that isn't mounted — the
// tool just returns 404 to whoever is driving SignBridge from an IDE. So assert
// the two things that actually rot:
//   1. Every path an S3 tool posts to is mounted in server.js.
//   2. Every S3 tool stamps the resolved user (there is no login; the backend
//      needs the name to find the right artifacts dir).
//
// Plus one property worth pinning: no S3 tool accepts a credential. The profile
// is named and the server resolves it, so keys never enter an MCP transcript.
//
// Two of these tools are not plain POST-with-JSON, and that is the interesting
// part: explain_s3_search touches no bucket at all (so it needs no profile), and
// upload_s3_object sends the object's bytes as a raw PUT body with its parameters
// on the query string — the route is mounted with a raw body parser, so JSON
// parameters would have nowhere to go.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Minimal valid-shaped input covering every S3 tool's required fields at once.
const SAMPLE_INPUT = {
    profileName: 'demo',
    authnMode: 'iam_user',
    bucket: 'demo-bucket',
    key: 'logs/app.log.gz',
    query: 'report',
    folderName: 'new-folder',
    items: [{ key: 'logs/app.log.gz' }],
    // upload_s3_object refuses a call with no body and a call with two, so the
    // shared input has to name exactly one.
    content: 'sample bytes'
};

// Where a tool's parameters end up: in the JSON body, or on the query string for
// the one raw-body route.
function paramsOf(call) {
    if (call.options && call.options.query) {
        return call.options.query;
    }
    return call.payload.options || call.payload;
}

async function collectS3Tools() {
    const tools = await import('../mcp/tools.mjs');
    const calls = [];
    const built = tools.buildTools({
        userName: 'signbridgeuser',
        callApi: async (apiPath, payload, options) => {
            calls.push({ apiPath, payload, options });
            return {};
        }
    });
    const s3Tools = built.filter(tool => /_s3_|^list_s3|s3_object|s3_buckets/.test(tool.name));
    return { built, s3Tools, calls };
}

test('the S3 tools cover the S3 World page\'s actions', async () => {
    const { built, s3Tools } = await collectS3Tools();
    const names = built.map(tool => tool.name);
    for (const expected of [
        'list_s3_buckets',
        'list_s3_objects',
        'search_s3_objects',
        'head_s3_object',
        'preview_s3_object',
        'presign_s3_object',
        'create_s3_folder',
        'delete_s3_objects',
        'copy_s3_objects',
        'explain_s3_search',
        'upload_s3_object'
    ]) {
        assert.ok(names.includes(expected), 'missing MCP tool: ' + expected);
    }
    assert.equal(new Set(names).size, names.length, 'duplicate MCP tool name');
    assert.equal(s3Tools.length, 11, 'the S3 tool filter picked up ' + s3Tools.length + ' tools');
});

test('every endpoint an S3 tool posts to is mounted in server.js', async () => {
    const { s3Tools, calls } = await collectS3Tools();

    for (const tool of s3Tools) {
        await tool.handler(SAMPLE_INPUT);
    }

    assert.equal(calls.length, s3Tools.length, 'an S3 tool did not call the API');
    for (const call of calls) {
        assert.match(call.apiPath, /^\/s3[A-Za-z]/, 'suspicious API path: ' + call.apiPath);
        // The upload is a PUT (raw body); everything else is a POST. Accept either,
        // but the route has to be mounted with the method the tool actually uses —
        // a POST to a PUT-only route 404s and reads as a missing feature.
        const method = (call.options && call.options.method) || 'post';
        assert.ok(
            SERVER_SOURCE.includes("router." + method + "('" + call.apiPath + "'"),
            'tool calls an unmounted route: ' + method.toUpperCase() + ' ' + call.apiPath
        );
    }
});

test('every S3 tool stamps the resolved user onto its payload', async () => {
    const { s3Tools, calls } = await collectS3Tools();
    for (const tool of s3Tools) {
        await tool.handler(SAMPLE_INPUT);
    }
    for (const call of calls) {
        assert.equal(paramsOf(call).userName, 'signbridgeuser', 'missing userName in ' + call.apiPath);
    }
});

test('no S3 tool accepts a credential — only the profile to look one up by', async () => {
    const { s3Tools } = await collectS3Tools();
    for (const tool of s3Tools) {
        for (const field of Object.keys(tool.schema)) {
            assert.doesNotMatch(field, /secret|password|accessKey/i,
                tool.name + ' accepts a credential field: ' + field);
        }
        // explain_s3_search is the one exception, and it is a real one: it parses a
        // query string and returns how it would be interpreted, without reaching
        // S3 at all. Requiring a profile there would ask for a credential the call
        // has no use for.
        if (tool.name === 'explain_s3_search') {
            assert.ok(!Object.keys(tool.schema).includes('profileName'),
                'explain_s3_search makes no S3 call, so it should not ask for a profile');
            continue;
        }
        assert.ok(Object.keys(tool.schema).includes('profileName'),
            tool.name + ' does not name a profile');
    }
});

test('the search tool offers exactly the scopes the search language implements', async () => {
    // The enum is a literal copy: tools.mjs is ESM and cannot require() the
    // CommonJS search module. So assert the copy still matches the original —
    // an unknown scope would silently widen back to 'both' server-side, and the
    // caller would never learn its narrowing was ignored.
    const s3Search = require('../lib/s3/s3Search');
    const { s3Tools, calls } = await collectS3Tools();
    const search = s3Tools.find(tool => tool.name === 'search_s3_objects');

    const scopes = Object.keys(s3Search.SCOPES).map(name => s3Search.SCOPES[name]);
    for (const scope of scopes) {
        assert.equal(search.schema.scope.safeParse(scope).success, true, scope + ' is not accepted');
    }
    assert.equal(search.schema.scope.safeParse('nonsense').success, false);
    // Optional, so a caller that does not care keeps the widest search.
    assert.equal(search.schema.scope.safeParse(undefined).success, true);

    // And it actually reaches the API rather than being accepted and dropped.
    await search.handler(Object.assign({}, SAMPLE_INPUT, { scope: 'folder' }));
    assert.equal(calls[calls.length - 1].payload.options.scope, 'folder');
});

test('the destructive S3 tools say so in their descriptions', async () => {
    // These tools are called by an LLM with no undo. The warning is the only
    // thing standing between "tidy up that prefix" and a recursive delete.
    const { s3Tools } = await collectS3Tools();
    const destroy = s3Tools.find(tool => tool.name === 'delete_s3_objects');
    assert.match(destroy.description, /cannot be undone/i);
    assert.match(destroy.description, /recursiv/i);
});
