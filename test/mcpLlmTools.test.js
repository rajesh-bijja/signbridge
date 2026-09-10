"use strict";

// MCP parity for LLM configuration — and, more importantly, the boundary.
//
// The three tools here are read + model selection only. Supplying a key, minting
// one on the user's provider account, and deleting one all have working endpoints
// that these tools deliberately do not expose: an MCP client *is* an LLM, and no
// tool should let it write a credential or spend the user's provider quota
// creating another. That omission is invisible — nothing breaks if someone later
// adds `set_llm_key` for symmetry — so it is asserted here.
//
// The rest is the same drift risk as the other MCP suites: a renamed route turns
// into a 404 that only shows up in an IDE transcript, and a tool that forgets to
// stamp the user reads the wrong artifacts directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const SAMPLE_INPUT = {
    providerId: 'openai',
    model: 'gpt-5.4-2026-03-05'
};

async function collectLlmTools() {
    const tools = await import('../mcp/tools.mjs');
    const calls = [];
    const built = tools.buildTools({
        userName: 'signbridgeuser',
        callApi: async (apiPath, payload) => {
            calls.push({ apiPath, payload });
            return {};
        }
    });
    const llmTools = built.filter(tool => /_llm_/.test(tool.name));
    return { built, llmTools, calls };
}

test('the LLM tools are exactly the three read/select ones', async () => {
    const { built, llmTools } = await collectLlmTools();
    const names = llmTools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['list_llm_models', 'list_llm_providers', 'set_llm_model']);
    // No duplicates introduced into the wider set while adding them.
    const all = built.map(tool => tool.name);
    assert.equal(new Set(all).size, all.length, 'duplicate MCP tool name');
});

test('every endpoint an LLM tool posts to is mounted in server.js', async () => {
    const { llmTools, calls } = await collectLlmTools();
    for (const tool of llmTools) {
        await tool.handler(SAMPLE_INPUT);
    }
    assert.equal(calls.length, llmTools.length, 'an LLM tool did not call the API');
    for (const call of calls) {
        assert.ok(
            SERVER_SOURCE.includes("router.post('" + call.apiPath + "'"),
            'tool posts to an unmounted route: ' + call.apiPath
        );
    }
});

test('every LLM tool stamps the resolved user onto its payload', async () => {
    const { llmTools, calls } = await collectLlmTools();
    for (const tool of llmTools) {
        await tool.handler(SAMPLE_INPUT);
    }
    for (const call of calls) {
        const options = call.payload.options || call.payload;
        assert.equal(options.userName, 'signbridgeuser', 'missing userName in ' + call.apiPath);
    }
});

test('no LLM tool accepts, creates or deletes a key', async () => {
    const { built, llmTools } = await collectLlmTools();

    // Nothing key-shaped in any input schema. An MCP client that could pass a key
    // would put one in a transcript, and one that could ask for a key to be
    // created would be spending the user's provider account.
    for (const tool of llmTools) {
        for (const field of Object.keys(tool.schema)) {
            assert.doesNotMatch(field, /key|secret|token|password/i,
                tool.name + ' accepts a credential-ish field: ' + field);
        }
    }

    // And no tool at all — LLM-named or not — reaches the key-management routes.
    // Those endpoints exist for the Settings page, where a human is.
    const OFF_LIMITS = [
        '/testLlmConnection',   // takes a raw apiKey
        '/deleteLlmKey',
        '/updateLlmSettings'    // can write baseUrl/enabled — configuration, not use
    ];
    const source = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'tools.mjs'), 'utf8');
    for (const route of OFF_LIMITS) {
        assert.ok(!source.includes("'" + route + "'"),
            'mcp/tools.mjs exposes the key-management route ' + route);
    }

    // The routes are genuinely mounted, so the assertion above is about restraint
    // rather than about them not existing yet.
    for (const route of OFF_LIMITS) {
        assert.ok(SERVER_SOURCE.includes("router.post('" + route + "'"),
            route + ' is no longer mounted — update this test');
    }
    // The key-brokering routes are gone from the server entirely, not merely
    // absent from the tool set: SignBridge used to create a provider key for the
    // user (an OpenRouter OAuth flow, an OpenAI admin-key mint) and no longer
    // does. Both directions are worth pinning — a reintroduced broker route is
    // the kind of thing a well-meaning change adds back "for convenience".
    const GONE = ['/llmOauthStart', '/llmOauthComplete', '/llmOauthStatus',
        '/llmMintProjects', '/llmMintKey'];
    for (const route of GONE) {
        assert.ok(!SERVER_SOURCE.includes("'" + route + "'"),
            route + ' is mounted again — SignBridge should not broker provider keys');
        assert.ok(!source.includes("'" + route + "'"),
            'mcp/tools.mjs references the removed broker route ' + route);
    }

    assert.ok(built.length > llmTools.length);
});

test('list_llm_providers promises no key material in its output', async () => {
    const { llmTools } = await collectLlmTools();
    const list = llmTools.find(tool => tool.name === 'list_llm_providers');
    // The description is the contract the calling model reads. It has to say the
    // response is safe to quote, or a cautious model will refuse to use it and a
    // careless one will assume the opposite.
    assert.match(list.description, /no API keys|masked/i);
    assert.deepEqual(Object.keys(list.schema), [], 'listing providers needs no input');
});

test('set_llm_model says that the selection persists app-wide', async () => {
    const { llmTools, calls } = await collectLlmTools();
    const set = llmTools.find(tool => tool.name === 'set_llm_model');
    // This is the one write these tools do, and its blast radius is larger than it
    // looks: it changes which model the dashboard, Chat and every future turn use.
    assert.match(set.description, /persist|Settings|everywhere|app-wide/i);

    await set.handler({ model: 'claude-opus-4-1', providerId: 'anthropic' });
    const call = calls[calls.length - 1];
    assert.equal(call.apiPath, '/selectLlmModel');
    assert.equal(call.payload.model, 'claude-opus-4-1');
    assert.equal(call.payload.providerId, 'anthropic');

    // providerId is optional — omitting it means "the provider already active",
    // which is what makes a plain "switch to opus" work.
    assert.equal(set.schema.providerId.safeParse(undefined).success, true);
    assert.equal(set.schema.model.safeParse(undefined).success, false,
        'a model selection with no model is a silent no-op');
});
