"use strict";

// Claude on Bedrock, over the native Converse API.
//
// Bedrock's OpenAI-compatible surface (`/openai/v1/...`) does not serve Claude —
// measured, not assumed: `GET /openai/v1/models` answers 404
// `<UnknownOperationException/>`, and a Claude model id posted to
// `/openai/v1/chat/completions` answers 404 "The model doesn't exist or doesn't
// support this API." That surface is for the `openai.gpt-oss-*` models. So Claude
// is reached through `POST /model/{id}/converse[-stream]`, and `bedrockConverse.js`
// is the adapter between the OpenAI shape the agent speaks and Converse.
//
// Every translation step is a pure exported function, which is the point: the
// adapter is tested with no credential, no network and no Bedrock account. The
// cases below are the ones that were wrong at some stage of getting a real turn to
// work, because each fails in a way that does not name itself:
//
//   * consecutive same-role messages -> a 400 about validation, not about shape
//   * the tool_calls index -> a tool call with no name, at the agent, later
//   * the colon in a model id -> a 403 that reads as a credential fault
//   * a denied ListFoundationModels -> "connection failed" for credentials that
//     invoke perfectly well

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const bedrock = require('../lib/llm/bedrockConverse');

// ---------------------------------------------------------------------------
// Endpoints and signing
// ---------------------------------------------------------------------------

test('the endpoints are region-scoped, and the two planes are different hosts', () => {
    // Listing models is the control plane (`bedrock`), invoking is the data plane
    // (`bedrock-runtime`). Posting Converse at the control host answers 404, which
    // reads as "model not found".
    assert.strictEqual(bedrock.runtimeHost('us-east-1'), 'bedrock-runtime.us-east-1.amazonaws.com');
    assert.strictEqual(bedrock.controlHost('eu-central-1'), 'bedrock.eu-central-1.amazonaws.com');
});

test('both planes sign as bedrock, never as the hostname prefix', () => {
    // `bedrock-runtime.<region>.amazonaws.com` must be signed as `bedrock` or AWS
    // answers 401 "Credential should be scoped to correct service: 'bedrock'" for
    // every profile type, since the credentials were never the problem.
    assert.strictEqual(bedrock.SIGNING_SERVICE, 'bedrock');
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm', 'bedrockConverse.js'),
        'utf8');
    assert.ok(/awsSigningName/.test(source),
        'the signing name must come from lib/awsSigningName.js, not a local literal');
});

test('the request path keeps the model id raw, colon included', () => {
    // SigV4 canonicalises by encoding whatever is on the wire, so signer and wire
    // must agree on the raw form. Pre-encoding the colon here while signing the raw
    // path gives a signature mismatch that only reproduces on models whose id has
    // one — i.e. every current Claude model.
    const id = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    assert.strictEqual(bedrock.conversePath(id, false), '/model/' + id + '/converse');
    assert.strictEqual(bedrock.conversePath(id, true), '/model/' + id + '/converse-stream');
    assert.ok(bedrock.conversePath(id, true).indexOf('%3A') === -1,
        'the path must not be pre-encoded');
});

// ---------------------------------------------------------------------------
// OpenAI messages -> Converse
// ---------------------------------------------------------------------------

test('system prompts are lifted out of the message list', () => {
    const mapped = bedrock.toConverseMessages([
        { role: 'system', content: 'You are SignBridge.' },
        { role: 'user', content: 'hello' }
    ]);
    assert.deepStrictEqual(mapped.system, [{ text: 'You are SignBridge.' }]);
    assert.deepStrictEqual(mapped.messages, [{ role: 'user', content: [{ text: 'hello' }] }]);
});

test('a tool result becomes a user content block, and several merge into one turn', () => {
    // The agent emits one role:'tool' message per call. Converse has no tool role
    // and requires alternating user/assistant turns, so a turn that called three
    // tools would otherwise be three consecutive user messages and a 400.
    const mapped = bedrock.toConverseMessages([
        { role: 'user', content: 'list my profiles' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'c1', function: { name: 'list_profiles', arguments: '{}' } },
                { id: 'c2', function: { name: 'get_settings', arguments: '{"a":1}' } }
            ]
        },
        { role: 'tool', tool_call_id: 'c1', content: '["p1"]' },
        { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}' }
    ]);

    assert.strictEqual(mapped.messages.length, 3);
    assert.deepStrictEqual(mapped.messages.map(m => m.role), ['user', 'assistant', 'user']);

    // Both tool uses ride on the one assistant message, with parsed input.
    const uses = mapped.messages[1].content.filter(b => b.toolUse);
    assert.strictEqual(uses.length, 2);
    assert.deepStrictEqual(uses[1].toolUse.input, { a: 1 });

    // Both results ride on the one following user message.
    const results = mapped.messages[2].content.filter(b => b.toolResult);
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(results.map(r => r.toolResult.toolUseId), ['c1', 'c2']);
});

test('malformed tool arguments become an empty object rather than a throw', () => {
    // The model produced the string. Throwing here ends the turn with a stack trace
    // instead of a recoverable retry.
    const mapped = bedrock.toConverseMessages([
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{"a":' } }] }
    ]);
    assert.deepStrictEqual(mapped.messages[1].content[0].toolUse.input, {});
});

test('a blank user message is dropped, because an empty text block is rejected', () => {
    const mapped = bedrock.toConverseMessages([
        { role: 'user', content: '' },
        { role: 'user', content: 'real' }
    ]);
    assert.deepStrictEqual(mapped.messages, [{ role: 'user', content: [{ text: 'real' }] }]);
});

test('a transcript that opens on an assistant turn is trimmed to start on a user turn', () => {
    // A replayed thread whose first user message was trimmed is otherwise a 400.
    const mapped = bedrock.toConverseMessages([
        { role: 'assistant', content: 'stale' },
        { role: 'user', content: 'now' }
    ]);
    assert.deepStrictEqual(mapped.messages, [{ role: 'user', content: [{ text: 'now' }] }]);
});

test('tools are translated with the schema nested under json', () => {
    const config = bedrock.toToolConfig([{
        type: 'function',
        function: {
            name: 'list_profiles',
            description: 'List profiles',
            parameters: { type: 'object', properties: { q: { type: 'string' } } }
        }
    }]);
    assert.deepStrictEqual(config.tools[0].toolSpec.inputSchema.json,
        { type: 'object', properties: { q: { type: 'string' } } });
    assert.deepStrictEqual(config.toolChoice, { auto: {} });
});

test('no tools means no toolConfig at all, not an empty one', () => {
    // Converse rejects `toolConfig: {tools: []}`.
    assert.strictEqual(bedrock.toToolConfig([]), null);
    assert.strictEqual(bedrock.toToolConfig(null), null);
    // A tool with no name is skipped rather than sent nameless.
    assert.strictEqual(bedrock.toToolConfig([{ function: { description: 'x' } }]), null);
    assert.ok(!('toolConfig' in bedrock.toConverseRequest({ model: 'm', messages: [] }).body));
});

test('temperature is only sent when the caller set one', () => {
    // Bedrock rejects a null, and several Claude variants reject temperature
    // together with reasoning — so absent must mean absent.
    let body = bedrock.toConverseRequest({ model: 'm', messages: [], temperature: null }).body;
    assert.ok(!('temperature' in body.inferenceConfig));
    body = bedrock.toConverseRequest({ model: 'm', messages: [], temperature: 0 }).body;
    assert.strictEqual(body.inferenceConfig.temperature, 0,
        'zero is a temperature, not an absence');
});

test('max tokens comes from either OpenAI spelling, and always has a value', () => {
    // Converse requires maxTokens; OpenAI made max_tokens optional and then renamed
    // it, so both spellings arrive from different call sites.
    assert.strictEqual(
        bedrock.toConverseRequest({ model: 'm', messages: [], max_tokens: 111 })
            .body.inferenceConfig.maxTokens, 111);
    assert.strictEqual(
        bedrock.toConverseRequest({ model: 'm', messages: [], max_completion_tokens: 222 })
            .body.inferenceConfig.maxTokens, 222);
    assert.ok(bedrock.toConverseRequest({ model: 'm', messages: [] })
        .body.inferenceConfig.maxTokens > 0);
});

// ---------------------------------------------------------------------------
// Converse -> OpenAI
// ---------------------------------------------------------------------------

test('a Converse reply with tool use becomes an OpenAI completion the agent can read', () => {
    const completion = bedrock.fromConverseResponse({
        output: {
            message: {
                role: 'assistant',
                content: [
                    { text: 'Let me look.' },
                    { toolUse: { toolUseId: 'c1', name: 'list_profiles', input: { q: 'x' } } }
                ]
            }
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }
    }, 'model-x');

    const message = completion.choices[0].message;
    assert.strictEqual(message.content, 'Let me look.');
    assert.strictEqual(completion.choices[0].finish_reason, 'tool_calls');
    // OpenAI carries arguments as a JSON *string*; Converse gives a parsed object.
    assert.strictEqual(message.tool_calls[0].function.arguments, '{"q":"x"}');
    assert.strictEqual(message.tool_calls[0].type, 'function');
    assert.strictEqual(completion.usage.prompt_tokens, 10);
});

test('reasoningContent blocks are dropped rather than surfacing as text', () => {
    // Claude on Bedrock returns them unasked and the OpenAI shape has nowhere to
    // put them; concatenating them into content leaks thinking into the answer.
    const completion = bedrock.fromConverseResponse({
        output: {
            message: {
                content: [
                    { reasoningContent: { reasoningText: { text: 'hmm' } } },
                    { text: 'answer' }
                ]
            }
        },
        stopReason: 'end_turn'
    }, 'm');
    assert.strictEqual(completion.choices[0].message.content, 'answer');
});

test('a text-free reply carries null content, which is what a tool-only turn is', () => {
    const completion = bedrock.fromConverseResponse({
        output: { message: { content: [{ toolUse: { toolUseId: 'c1', name: 't' } }] } },
        stopReason: 'tool_use'
    }, 'm');
    assert.strictEqual(completion.choices[0].message.content, null);
    assert.strictEqual(completion.choices[0].message.tool_calls[0].function.arguments, '{}');
});

test('stop reasons map to the OpenAI vocabulary, and an unknown one is a stop', () => {
    assert.strictEqual(bedrock.toFinishReason('end_turn'), 'stop');
    assert.strictEqual(bedrock.toFinishReason('tool_use'), 'tool_calls');
    assert.strictEqual(bedrock.toFinishReason('max_tokens'), 'length');
    assert.strictEqual(bedrock.toFinishReason('guardrail_intervened'), 'content_filter');
    // A new stop reason must not end the turn with `undefined` as a finish reason.
    assert.strictEqual(bedrock.toFinishReason('something_new'), 'stop');
    assert.strictEqual(bedrock.toFinishReason(undefined), 'stop');
});

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

// Bedrock streams application/vnd.amazon.eventstream. Building frames here rather
// than checking in a captured binary keeps the framing readable: if the decoder is
// wrong, the test says which field.
function frame(headers, payload) {
    const headerBuf = Buffer.concat(Object.keys(headers).map(function (name) {
        const value = Buffer.from(String(headers[name]), 'utf8');
        const head = Buffer.alloc(1 + name.length + 1 + 2);
        head.writeUInt8(name.length, 0);
        head.write(name, 1, 'utf8');
        head.writeUInt8(7, 1 + name.length);            // value type 7: string
        head.writeUInt16BE(value.length, 1 + name.length + 1);
        return Buffer.concat([head, value]);
    }));
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const total = 12 + headerBuf.length + body.length + 4;
    const prelude = Buffer.alloc(12);
    prelude.writeUInt32BE(total, 0);
    prelude.writeUInt32BE(headerBuf.length, 4);
    prelude.writeUInt32BE(0, 8);                        // prelude CRC: not verified
    return Buffer.concat([prelude, headerBuf, body, Buffer.alloc(4)]);
}

function eventFrame(type, payload) {
    return frame({ ':event-type': type, ':message-type': 'event' }, payload);
}

test('the event stream decoder reads a frame and reports the remainder', () => {
    const buffer = Buffer.concat([
        eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'hi' } }),
        eventFrame('messageStop', { stopReason: 'end_turn' })
    ]);
    const decoded = bedrock.decodeEventStream(buffer);
    assert.strictEqual(decoded.events.length, 2);
    assert.strictEqual(decoded.events[0].type, 'contentBlockDelta');
    assert.strictEqual(decoded.events[0].payload.delta.text, 'hi');
    assert.strictEqual(decoded.events[1].type, 'messageStop');
    assert.strictEqual(decoded.rest.length, 0);
});

test('a frame split across two reads is held, not mis-parsed', () => {
    // The normal case, not an edge one: a frame straddling two TCP reads. Parsing
    // the head of one would emit a truncated JSON payload as an empty event.
    const whole = eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'hello' } });
    const first = bedrock.decodeEventStream(whole.slice(0, 20));
    assert.strictEqual(first.events.length, 0);
    assert.strictEqual(first.rest.length, 20, 'the partial frame must be kept intact');

    const second = bedrock.decodeEventStream(Buffer.concat([first.rest, whole.slice(20)]));
    assert.strictEqual(second.events.length, 1);
    assert.strictEqual(second.events[0].payload.delta.text, 'hello');
});

test('a buffer that is not eventstream framing stops rather than looping', () => {
    const junk = Buffer.from('<html>not eventstream at all, really not</html>', 'utf8');
    const decoded = bedrock.decodeEventStream(junk);
    assert.strictEqual(decoded.events.length, 0);
    assert.ok(decoded.rest.length > 0, 'the bytes stay in rest; the walk must not spin');
});

test('an exception frame is surfaced as a throw, not swallowed as silence', () => {
    const decoded = bedrock.decodeEventStream(frame(
        { ':exception-type': 'throttlingException', ':message-type': 'exception' },
        { message: 'Too many requests' }
    ));
    assert.strictEqual(decoded.events.length, 1);
    assert.throws(
        () => bedrock.converseEventToChunks(decoded.events[0], bedrock.newStreamState(), 'm'),
        /Too many requests/);
});

test('the tool_calls index is renumbered from the content-block index', () => {
    // Converse indexes *all* content blocks, so with leading text the first tool use
    // is block 1. Passing that straight through leaves a hole at OpenAI index 0 that
    // the agent accumulates into a tool call with no name.
    const state = bedrock.newStreamState();
    const model = 'm';

    let chunks = bedrock.converseEventToChunks(
        { type: 'contentBlockDelta', payload: { contentBlockIndex: 0, delta: { text: 'Looking…' } } },
        state, model);
    assert.strictEqual(chunks[0].choices[0].delta.content, 'Looking…');

    chunks = bedrock.converseEventToChunks({
        type: 'contentBlockStart',
        payload: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'c1', name: 'list_profiles' } } }
    }, state, model);
    assert.strictEqual(chunks[0].choices[0].delta.tool_calls[0].index, 0,
        'the first tool call is OpenAI index 0 even though it is content block 1');
    assert.strictEqual(chunks[0].choices[0].delta.tool_calls[0].function.name, 'list_profiles');

    // Argument deltas must land on the same OpenAI index as the start event.
    chunks = bedrock.converseEventToChunks({
        type: 'contentBlockDelta',
        payload: { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":' } } }
    }, state, model);
    assert.strictEqual(chunks[0].choices[0].delta.tool_calls[0].index, 0);
    assert.strictEqual(chunks[0].choices[0].delta.tool_calls[0].function.arguments, '{"q":');

    // A second tool use is index 1, not the block index 2.
    chunks = bedrock.converseEventToChunks({
        type: 'contentBlockStart',
        payload: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'c2', name: 'get_settings' } } }
    }, state, model);
    assert.strictEqual(chunks[0].choices[0].delta.tool_calls[0].index, 1);

    chunks = bedrock.converseEventToChunks(
        { type: 'messageStop', payload: { stopReason: 'tool_use' } }, state, model);
    assert.strictEqual(chunks[0].choices[0].finish_reason, 'tool_calls');
});

test('an unrecognised stream event is silence, not a failed turn', () => {
    const state = bedrock.newStreamState();
    for (const type of ['messageStart', 'contentBlockStop', 'metadata', 'somethingNew2027']) {
        assert.deepStrictEqual(bedrock.converseEventToChunks({ type: type, payload: {} }, state, 'm'),
            [], type + ' must produce no chunks and no throw');
    }
});

// ---------------------------------------------------------------------------
// Errors and the model list
// ---------------------------------------------------------------------------

test('a 403 names the two permissions the role is missing', () => {
    // "AccessDeniedException" on its own sends the user to look at their profile.
    // The permission names send them to the role policy, which is where the fix is.
    const err = bedrock.bedrockError(403, JSON.stringify({
        message: 'User is not authorized to perform: bedrock:InvokeModel'
    }));
    assert.strictEqual(err.statusCode, 403);
    assert.match(err.message, /bedrock:InvokeModel/);
    assert.match(err.message, /bedrock:InvokeModelWithResponseStream/);
});

test('a 404 says the model id is the thing to change', () => {
    // The commonest real cause is a bare foundation-model id for a model that is
    // inference-profile-only, i.e. a missing us./eu./global. prefix.
    const err = bedrock.bedrockError(404, JSON.stringify({
        message: "The provided model identifier is invalid."
    }));
    assert.match(err.message, /region-specific/);
    assert.match(err.message, /us\.\/eu\.\/global\./);
});

test('an unparseable error body still yields a message and a status', () => {
    const err = bedrock.bedrockError(500, '<html>gateway</html>');
    assert.strictEqual(err.statusCode, 500);
    assert.ok(err.message.length > 0);
});

test('canServeChat keeps text models and drops the ones that cannot answer', () => {
    assert.ok(bedrock.canServeChat({
        inputModalities: ['TEXT', 'IMAGE'],
        outputModalities: ['TEXT'],
        inferenceTypesSupported: ['INFERENCE_PROFILE']
    }));
    // Embeddings: offering amazon.titan-embed-text-v2:0 as a chat model is broken.
    assert.ok(!bedrock.canServeChat({
        inputModalities: ['TEXT'], outputModalities: ['EMBEDDING']
    }));
    // Image output.
    assert.ok(!bedrock.canServeChat({ inputModalities: ['TEXT'], outputModalities: ['IMAGE'] }));
    // Provisioned-only: invoking it without a throughput ARN fails.
    assert.ok(!bedrock.canServeChat({ inferenceTypesSupported: ['PROVISIONED'] }));
    assert.ok(!bedrock.canServeChat({ modelLifecycle: { status: 'LEGACY' } }));
    // Nothing declared: keep it. An empty picker is worse than an imperfect one.
    assert.ok(bedrock.canServeChat({}));
});

test('the fallback model list is inference-profile ids, because Claude needs them', () => {
    // Used when the credentials can invoke but not list. A bare foundation-model id
    // 404s for anything profile-only, so a fallback of bare ids would be a list of
    // models that all fail.
    assert.ok(bedrock.FALLBACK_MODELS.length > 0);
    for (const id of bedrock.fallbackModelIds('us-east-1')) {
        assert.match(id, /^(us|eu|apac|us-gov|global)\./,
            id + ' must be a cross-region inference profile');
        assert.match(id, /anthropic\.claude/, id + ' must be a Claude model');
    }
    // The stored entries are suffixes, so the region can supply the prefix. A row
    // that carried its own prefix would be a hardcoded us. list again.
    for (const entry of bedrock.FALLBACK_MODELS) {
        assert.match(entry.suffix, /^anthropic\./,
            entry.suffix + ' must be stored without a cross-region prefix');
        assert.ok(entry.label, entry.suffix + ' needs a human label');
    }
});

test('fallback model ids never carry a spelling that Bedrock rejects', () => {
    // Every id in the list was verified by invoking it. These three spellings look
    // right and are answered with `400 The provided model identifier is invalid`,
    // which is exactly the failure a hand-written list produces — so they are
    // asserted against rather than merely avoided.
    let ids = bedrock.fallbackModelIds('us-east-1');
    for (const id of ids) {
        assert.ok(!/claude-opus-4-6-v1:0/.test(id), id + ': opus 4.6 has no :0 suffix');
        assert.ok(!/claude-sonnet-4-6-v1/.test(id), id + ': sonnet 4.6 carries no version suffix');
        assert.ok(!/claude-haiku-4-6/.test(id), id + ': there is no 4.6 Haiku');
    }
});

test('the cross-region prefix follows the region, and GovCloud is checked first', () => {
    assert.equal(bedrock.crossRegionPrefix('us-east-1'), 'us.');
    assert.equal(bedrock.crossRegionPrefix('us-west-2'), 'us.');
    // us-gov- starts with us- too, so order of the checks decides this one. Getting
    // it wrong yields us.* ids that are invalid in GovCloud.
    assert.equal(bedrock.crossRegionPrefix('us-gov-west-1'), 'us-gov.');
    assert.equal(bedrock.crossRegionPrefix('eu-central-1'), 'eu.');
    assert.equal(bedrock.crossRegionPrefix('ap-southeast-2'), 'apac.');
    // No geography-specific profile family for these, so global. is the honest
    // answer rather than guessing at us.
    assert.equal(bedrock.crossRegionPrefix('ca-central-1'), 'global.');
    assert.equal(bedrock.crossRegionPrefix('sa-east-1'), 'global.');
    // An absent region falls back to DEFAULT_REGION, not to global. — a blank region
    // means "wherever the request goes", and that is us-east-1 everywhere else here.
    assert.equal(bedrock.crossRegionPrefix(''), 'us.');
    assert.equal(bedrock.crossRegionPrefix(undefined), 'us.');
});

test('fallbackModels carries a label and marks the ids as inference profiles', () => {
    let models = bedrock.fallbackModels('eu-west-1');
    assert.equal(models.length, bedrock.FALLBACK_MODELS.length);
    for (const model of models) {
        assert.match(model.id, /^eu\./, model.id + ' must be prefixed for the asked region');
        assert.ok(model.label);
        assert.equal(model.kind, 'inference-profile');
    }
});
