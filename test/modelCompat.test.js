"use strict";

// Model/endpoint mismatches: the two provider errors a user cannot act on.
//
// Both of these were reported from real use, and both arrived in the chat panel as
// the provider's raw sentence:
//
//   400 Function tools with reasoning_effort are not supported for gpt-5.6-luna in
//       /v1/chat/completions. To use function tools, use /v1/responses or set
//       reasoning_effort to 'none'.
//   404 This is not a chat model and thus not supported in the v1/chat/completions
//       endpoint. Did you mean to use v1/completions?
//
// The first is recoverable and the error text says how; the second never is. Which
// of the two it was decides whether SignBridge retries silently or tells the user
// to pick another model, so the classifier is the whole feature — and it has to be
// wrong in neither direction: mistaking a rate limit for a model problem sends the
// user to change something that was fine.
//
// Pure functions over an error object, so there is no provider, key or network
// here. The strings below are the providers' own text.

const test = require('node:test');
const assert = require('node:assert');

const modelCompat = require('../lib/chat/modelCompat');
const modelCatalog = require('../lib/llm/modelCatalog');

const REASONING_400 = "400 Function tools with reasoning_effort are not supported for " +
    "gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set " +
    "reasoning_effort to 'none'.";
const NOT_CHAT_404 = '404 This is not a chat model and thus not supported in the ' +
    'v1/chat/completions endpoint. Did you mean to use v1/completions?';

test('the reasoning/tools conflict is classified recoverable', function () {
    let verdict = modelCompat.classifyCompletionError(new Error(REASONING_400), 'gpt-5.6-luna');
    assert.strictEqual(verdict.kind, modelCompat.REASONING_TOOLS_CONFLICT);
    assert.strictEqual(verdict.recoverable, true);
});

test('a non-chat model is classified unrecoverable and names the model', function () {
    let verdict = modelCompat.classifyCompletionError(new Error(NOT_CHAT_404), 'davinci-002');
    assert.strictEqual(verdict.kind, modelCompat.NOT_A_CHAT_MODEL);
    assert.strictEqual(verdict.recoverable, false);
    // The message has to identify the model: the user picked it, and "pick another"
    // is not actionable without knowing which one is the problem.
    assert.match(verdict.message, /davinci-002/);
    assert.match(verdict.message, /picker|Settings/i);
});

test('reasoning is checked before the endpoint text it also contains', function () {
    // The 400 mentions /v1/responses, which on its own means responses-only. If the
    // order of the checks flipped, the recoverable case would be reported as fatal
    // and the retry would never happen.
    let verdict = modelCompat.classifyCompletionError(new Error(REASONING_400), 'gpt-5.6-luna');
    assert.strictEqual(verdict.kind, modelCompat.REASONING_TOOLS_CONFLICT);
});

test('an unrelated failure classifies as null so the caller rethrows it', function () {
    assert.strictEqual(
        modelCompat.classifyCompletionError(new Error('429 Rate limit reached'), 'gpt-4.1'),
        null
    );
    assert.strictEqual(
        modelCompat.classifyCompletionError(new Error('socket hang up'), 'gpt-4.1'),
        null
    );
    assert.strictEqual(modelCompat.classifyCompletionError(null, 'gpt-4.1'), null);
});

test('the provider body is read wherever the SDK put it', function () {
    // The OpenAI SDK exposes the parsed body on `error`; axios-shaped clients put it
    // on `response.data`. A classifier that only read `message` would see nothing.
    let sdkStyle = new Error('Request failed');
    sdkStyle.error = { message: REASONING_400 };
    assert.strictEqual(
        modelCompat.classifyCompletionError(sdkStyle, 'm').kind,
        modelCompat.REASONING_TOOLS_CONFLICT
    );

    let axiosStyle = new Error('Request failed with status code 404');
    axiosStyle.response = { data: { error: { message: NOT_CHAT_404 } } };
    assert.strictEqual(
        modelCompat.classifyCompletionError(axiosStyle, 'm').kind,
        modelCompat.NOT_A_CHAT_MODEL
    );
});

test('the retry sends reasoning_effort none and drops temperature', function () {
    // Sending 'none' explicitly is the fix, not omitting the parameter: the 400
    // fires even when SignBridge sends no reasoning_effort at all, because the model
    // applies its own default.
    let params = { model: 'm', messages: [], temperature: 0, tools: [] };
    let retry = modelCompat.withReasoningDisabled(params);
    assert.strictEqual(retry.reasoning_effort, 'none');
    assert.ok(!('temperature' in retry), 'temperature must not survive into the retry');
    // And the original is untouched — a one-shot retry is not a permanent change.
    assert.strictEqual(params.temperature, 0);
    assert.ok(!('reasoning_effort' in params));
});

test('the exhausted message stops promising a retry', function () {
    let message = modelCompat.exhaustedMessage(
        modelCompat.REASONING_TOOLS_CONFLICT, 'gpt-5.6-luna');
    assert.match(message, /gpt-5\.6-luna/);
    assert.doesNotMatch(message, /retry/i);
});

// --- the picker side: these ids should not be offered in the first place --------

test('legacy completions and responses-only ids are filtered out of the model list', function () {
    const excluded = [
        'gpt-3.5-turbo-instruct',
        'gpt-3.5-turbo-instruct-0914',
        'davinci-002',
        'babbage-002',
        'text-davinci-003',
        'codex-mini-latest',
        'computer-use-preview',
        'o3-deep-research',
        'openai/gpt-3.5-turbo-instruct'
    ];
    for (let id of excluded) {
        assert.strictEqual(modelCatalog.isChatModel(id), false, id + ' should not be offered');
    }
});

test('instruct-tuned chat models survive the filter', function () {
    // The tempting pattern here is a bare '-instruct', which would delete most of
    // OpenRouter's open-weight catalogue. That is a much worse failure than one
    // stale entry, so the legacy ids are matched by prefix instead.
    const kept = [
        'mistralai/mistral-7b-instruct',
        'meta-llama/llama-3.1-70b-instruct',
        'gpt-4.1',
        'gpt-5',
        'o3-mini'
    ];
    for (let id of kept) {
        assert.strictEqual(modelCatalog.isChatModel(id), true, id + ' should be offered');
    }
});

test('capability metadata cannot readmit a wrong-endpoint model', function () {
    // These models do output text, so a provider reporting modalities would wave
    // them through — the endpoint check has to run first.
    assert.strictEqual(
        modelCatalog.isChatModel('davinci-002', { architecture: { output_modalities: ['text'] } }),
        false
    );
    assert.strictEqual(
        modelCatalog.isChatModel('codex-mini-latest', { supportedGenerationMethods: ['generateContent'] }),
        false
    );
});
