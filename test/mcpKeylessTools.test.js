"use strict";

// The MCP surface must work with no AI provider key configured.
//
// The point is easy to lose sight of because SignBridge has an LLM key at all: it
// buys inference for SignBridge's *own* Chat page, which has no model. An MCP
// client already is a model, so signing an AWS request, browsing S3 or running a
// Sandbox script has nothing to do with that key. Someone who configures
// signbridge-mcp in Codex should get all of it with nothing to set up.
//
// One tool broke that: summarize_chat_session asked SignBridge to spend a *second*
// model paraphrasing a transcript the caller could read itself, and returned 503
// "open Settings → AI features" when there was no key — from inside an IDE, a dead
// end for no benefit. It now falls back to handing the transcript over.
//
// The narrowness is the risk here, so it is what these tests mostly cover: the
// fallback must fire for exactly that failure and for nothing else. A missing
// thread that quietly came back as an empty transcript would be worse than the
// 503 it replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let buildTools;

test.before(async function () {
    const mod = await import('../mcp/tools.mjs');
    buildTools = mod.buildTools;
});

function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function toolNamed(name, callApi) {
    const tool = buildTools({ callApi: callApi, userName: 'signbridgeuser' })
        .find(function (t) { return t.name === name; });
    assert.ok(tool, 'no such tool: ' + name);
    return tool;
}

// The error shape all three callApi implementations produce.
function apiError(statusCode, data) {
    const err = new Error((data && data.message) || 'request failed');
    err.apiMessage = data && data.message;
    err.statusCode = statusCode;
    err.apiData = data || null;
    return err;
}

const THREAD = {
    threadId: 't-1',
    title: 'Presign an S3 GET',
    messages: [
        { role: 'user', content: 'presign a get on my bucket' },
        { role: 'assistant', content: 'Which profile should I use?' }
    ]
};

function payloadOf(result) {
    return JSON.parse(result.content[0].text);
}

test('summarize_chat_session returns the transcript when no provider is configured', async function () {
    const calls = [];
    const callApi = async function (pathName, payload) {
        calls.push(pathName);
        if (pathName === '/chatSummarizeThread') {
            throw apiError(503, {
                message: 'No AI provider is configured. Open Settings → AI features...',
                reason: 'not_configured',
                needsLlmSetup: true
            });
        }
        assert.strictEqual(pathName, '/chatThread');
        assert.strictEqual(payload.threadId, 't-1');
        return THREAD;
    };

    const result = await toolNamed('summarize_chat_session', callApi).handler({ threadId: 't-1' });

    assert.ok(!result.isError, 'a missing provider key must not be an error here');
    assert.deepEqual(calls, ['/chatSummarizeThread', '/chatThread'],
        'it should try the server first, and only then fall back');

    const body = payloadOf(result);
    assert.strictEqual(body.summary, null, 'be explicit that no summary was generated');
    assert.strictEqual(body.summarizedBy, 'caller');
    assert.strictEqual(body.messages.length, 2, 'the transcript is the whole point of the fallback');
    assert.ok(/summarize/i.test(body.instruction), 'the caller needs to be told what to do with it');
    // The caller is a model reporting back to a human. Without this it will relay
    // "SignBridge is not configured" as though something needed fixing.
    assert.match(body.reason, /nothing is wrong|nothing needs configuring/i);
});

test('the fallback fires for the missing-key failure and no other', async function () {
    // 'disabled' is a distinct reason from 'not_configured' and also carries the
    // flag — the user turned AI features off in Settings, which is not a reason to
    // refuse a summary the caller can write.
    for (const reason of ['not_configured', 'disabled', 'missing_key', 'missing_model']) {
        const callApi = async function (pathName) {
            if (pathName === '/chatSummarizeThread') {
                throw apiError(503, { message: reason, reason: reason, needsLlmSetup: true });
            }
            return THREAD;
        };
        const result = await toolNamed('summarize_chat_session', callApi).handler({ threadId: 't-1' });
        assert.ok(!result.isError, reason + ' should fall back, not fail');
    }

    // A thread that does not exist, and a genuine server fault, must still fail.
    for (const row of [[404, { message: 'Thread not found' }], [500, { message: 'boom' }]]) {
        const callApi = async function (pathName) {
            if (pathName === '/chatSummarizeThread') {
                throw apiError(row[0], row[1]);
            }
            assert.fail('must not reach for the transcript on a ' + row[0]);
        };
        const tool = toolNamed('summarize_chat_session', callApi);
        await assert.rejects(
            async function () { await tool.handler({ threadId: 'nope' }); },
            new RegExp(row[1].message),
            'a ' + row[0] + ' must surface as an error, not a plausible-looking empty summary'
        );
    }
});

test('summarize_chat_session does not call the API twice when it works', async function () {
    const calls = [];
    const callApi = async function (pathName) {
        calls.push(pathName);
        return { threadId: 't-1', summary: 'A short summary.' };
    };
    const result = await toolNamed('summarize_chat_session', callApi).handler({ threadId: 't-1' });
    assert.deepEqual(calls, ['/chatSummarizeThread']);
    assert.strictEqual(payloadOf(result).summary, 'A short summary.');
});

test('all three callApi implementations attach the status and the body', function () {
    // The fallback reads needsLlmSetup off err.apiData, so a transport that dropped
    // it would turn the fallback back into a 503 — on that transport only, which is
    // exactly the kind of difference nobody notices.
    const files = ['mcp/server.js', 'mcp/mcpHttp.mjs', 'lib/chat/agent.js'];
    for (const rel of files) {
        const code = stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
        assert.match(code, /wrapped\.statusCode\s*=/, rel + ' should attach statusCode');
        assert.match(code, /wrapped\.apiData\s*=/, rel + ' should attach the response body');
    }
});

test('no tool description tells the caller to configure an API key', function () {
    // The MCP surface needs no provider key. A description that implies otherwise
    // sends a model — and through it the user — to a Settings page for nothing.
    const tools = buildTools({ callApi: async function () { return {}; }, userName: 'signbridgeuser' });
    const offenders = [];
    for (const tool of tools) {
        // The llm-config tools are the exception by definition: their whole subject
        // is SignBridge's own provider setup, so they may name a key.
        if (tool.name.indexOf('llm') !== -1) {
            continue;
        }
        // Phrases that *demand* a key. Saying a key is NOT needed is the point, so
        // this matches the requirement and not the mention of one.
        if (/requires? (?:the llm|an api key|a key)|llm to be enabled|needs an api key|enable ai features/i
            .test(tool.description)) {
            offenders.push(tool.name);
        }
    }
    assert.deepEqual(offenders, [], 'these imply the MCP surface needs an AI key: ' + offenders.join(', '));
});
