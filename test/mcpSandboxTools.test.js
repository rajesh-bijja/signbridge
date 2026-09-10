"use strict";

// MCP parity for Sandbox mode.
//
// The repo convention is that MCP exposes what the dashboard exposes, and the
// two drift silently: nothing fails at build time if a Sandbox endpoint gains a
// language or loses a route — the tool just stops working for whoever is driving
// SignBridge from an IDE.
//
// Two invariants are cheap to assert and cover the realistic drift:
//   1. The runtimeId enum in the tool schemas matches the runtime registry.
//      mcp/tools.mjs is ESM and cannot require() the CommonJS registry, so that
//      list is duplicated as a literal — exactly the kind of copy that rots.
//   2. Every path a sandbox tool posts to is actually mounted in server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimes = require('../lib/sandbox/sandboxRuntimes');

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/** Record every path the tool handlers post to, without making a request. */
async function collectSandboxTools() {
    const tools = await import('../mcp/tools.mjs');
    const calls = [];
    const built = tools.buildTools({
        userName: 'signbridgeuser',
        callApi: async (apiPath, payload) => {
            calls.push({ apiPath, payload });
            return {};
        }
    });
    return { built, calls, module: tools };
}

test('the sandbox tools cover the dashboard\'s sandbox actions', async () => {
    const { built } = await collectSandboxTools();
    const names = built.map(tool => tool.name);
    for (const expected of [
        'list_sandbox_runtimes',
        'get_sandbox_template',
        'run_sandbox',
        'check_sandbox',
        'list_sandbox_scripts',
        'get_sandbox_script',
        'save_sandbox_script',
        'delete_sandbox_script'
    ]) {
        assert.ok(names.includes(expected), 'missing MCP tool: ' + expected);
    }
    // Tool names are the protocol's addressing scheme; a duplicate silently
    // shadows one of the two.
    assert.equal(new Set(names).size, names.length, 'duplicate MCP tool name');
});

test('the runtimeId enum in the tool schemas matches the runtime registry', async () => {
    const { built } = await collectSandboxTools();
    const registryIds = runtimes.listRuntimeIds();
    let checked = 0;
    for (const tool of built) {
        const field = tool.schema && tool.schema.runtimeId;
        if (!field) continue;
        // Reach through .default()/.optional() wrappers to the enum itself.
        let inner = field;
        while (inner && !inner._def.values && inner._def.innerType) {
            inner = inner._def.innerType;
        }
        assert.deepEqual(inner._def.values, registryIds,
            tool.name + ' offers languages the registry does not: ' + inner._def.values.join(','));
        checked += 1;
    }
    assert.ok(checked >= 4, 'expected several sandbox tools to take a runtimeId, saw ' + checked);
});

test('every endpoint a sandbox tool posts to is mounted in server.js', async () => {
    const { built, calls } = await collectSandboxTools();
    const sandboxTools = built.filter(tool => tool.name.includes('sandbox'));

    for (const tool of sandboxTools) {
        // Minimal valid-shaped input; the fake callApi records the path and the
        // handler never reaches a network.
        await tool.handler({ runtimeId: 'python', code: 'print(1)', scriptId: 'a'.repeat(32) });
    }

    assert.equal(calls.length, sandboxTools.length, 'a sandbox tool did not call the API');
    for (const call of calls) {
        assert.match(call.apiPath, /^\/[A-Za-z]/, 'suspicious API path: ' + call.apiPath);
        assert.ok(
            SERVER_SOURCE.includes("router.post('" + call.apiPath + "'"),
            'tool posts to an unmounted route: ' + call.apiPath
        );
    }
});

test('every sandbox tool stamps the resolved user onto its payload', async () => {
    // There is no login: the backend resolves a single local user, and every
    // MCP payload has to carry it or the call lands on the wrong artifacts dir.
    const { built, calls } = await collectSandboxTools();
    for (const tool of built.filter(t => t.name.includes('sandbox'))) {
        await tool.handler({ runtimeId: 'python', code: 'print(1)', scriptId: 'a'.repeat(32) });
    }
    for (const call of calls) {
        const options = call.payload.options || call.payload;
        assert.equal(options.userName, 'signbridgeuser', 'missing userName in ' + call.apiPath);
    }
});

test('run_sandbox never sends credentials — only the profile to look them up by', async () => {
    // Credentials are resolved server-side from the named profile. A tool that
    // accepted a key would put secrets in the MCP transcript and in any client
    // log that records tool arguments.
    const { built } = await collectSandboxTools();
    const run = built.find(tool => tool.name === 'run_sandbox');
    const fields = Object.keys(run.schema);
    for (const field of fields) {
        assert.doesNotMatch(field, /secret|token|password|accessKey/i,
            'run_sandbox accepts a credential field: ' + field);
    }
    assert.ok(fields.includes('profileName'));
});
