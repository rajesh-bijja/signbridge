"use strict";

// Claude on Bedrock, signed with a SignBridge profile.
//
// WHY THIS MODULE EXISTS AT ALL
//
// The Bedrock provider used to be an ordinary `kind:'openai'` row pointed at
// `bedrock-runtime.<region>.amazonaws.com/openai/v1`, on the belief that Bedrock's
// OpenAI-compatible surface served Claude with a Bedrock API key as a bearer token.
// Measured against the real service, two parts of that were wrong:
//
//   GET  /openai/v1/models                  -> 404 <UnknownOperationException/>
//   POST /openai/v1/chat/completions        -> 404 "The model doesn't exist or
//        {model: us.anthropic.claude-…}           doesn't support this API."
//
// The 404 on /models is a *routing* error, so it is absent for every credential
// kind, and the compat endpoint only accepts the OpenAI-authored models Bedrock
// hosts (`openai.gpt-oss-*`). Claude is reachable only through Bedrock's native
// **Converse** API. So the OpenAI shape cannot be kept, and this module is the
// adapter: OpenAI-shaped requests in, Converse out, Converse events back, OpenAI
// streaming chunks out.
//
// WHY AN ADAPTER RATHER THAN A chatBackend
//
// `lib/llm/providers.js` has an escape hatch for a provider that is not an
// OpenAI-shaped endpoint (`chatBackend`, which is how Cursor is answered). Bedrock
// deliberately does NOT use it. Cursor needs it because it owns its own tool loop
// and there is nowhere to hand tool results back; Bedrock's Converse API is a
// plain request/response with first-class tool use, so it maps cleanly onto what
// `lib/chat/agent.js` already does. Presenting it as a client with the one method
// the agent calls — `chat.completions.create()` — means the agent, the tool loop,
// the streaming emitter and the thread store all work unchanged. A chatBackend
// would have meant a second copy of that loop.
//
// WHY THE CREDENTIALS ARE A CALLBACK
//
// The whole point of this provider is that the credentials come from a SignBridge
// profile — including SSO, EC2 instance roles and IRSA, whose credentials are
// short-lived and are re-minted on demand. So the client resolves them per request
// through an injected resolver rather than closing over a credential at
// construction time: a chat session open for an hour must not start failing when
// the role's session token rolls over.

const https = require('https');

const awsSigner = require('../awsSigner');
const awsSigningName = require('../awsSigningName');

// Bedrock's own name for itself in a credential scope. `bedrock-runtime` is the
// endpoint prefix, not the signing name — signing the prefix is a 401 that reads
// like a bad key. Asked rather than hardcoded so there is one source of truth.
const SIGNING_SERVICE = awsSigningName.signingNameFor('bedrock-runtime');

// The region a caller gets when it names none. Bedrock model availability is
// regional and ids are region-scoped, so this is a starting point rather than a
// safe default — hence the region being a visible setting.
const DEFAULT_REGION = 'us-east-1';

const RUNTIME_HOST_PREFIX = 'bedrock-runtime';
const CONTROL_HOST_PREFIX = 'bedrock';

// Converse's own ceiling when the caller names none. The agent always passes one,
// so this only covers a direct call.
const DEFAULT_MAX_TOKENS = 4096;

function runtimeHost(region) {
    return RUNTIME_HOST_PREFIX + '.' + region + '.amazonaws.com';
}

function controlHost(region) {
    return CONTROL_HOST_PREFIX + '.' + region + '.amazonaws.com';
}

// ---------------------------------------------------------------------------
// Request translation: OpenAI messages -> Converse
// ---------------------------------------------------------------------------

// Converse splits what OpenAI keeps in one list: system prompts are a top-level
// field, and tool results are content blocks on a *user* message rather than a
// role of their own. It also requires strictly alternating user/assistant turns,
// which is why consecutive same-role messages are merged instead of passed
// through — the agent emits one `role:'tool'` message per tool call, and a turn
// that called three tools would otherwise be three consecutive user messages and
// a 400 that names validation rather than the shape.
function toConverseMessages(messages) {
    let system = [];
    let converse = [];

    function pushBlocks(role, blocks) {
        if (!blocks.length) {
            return;
        }
        let last = converse[converse.length - 1];
        if (last && last.role === role) {
            last.content = last.content.concat(blocks);
            return;
        }
        converse.push({ role: role, content: blocks });
    }

    for (let message of messages || []) {
        let role = message && message.role;
        if (role === 'system') {
            if (message.content) {
                system.push({ text: String(message.content) });
            }
            continue;
        }
        if (role === 'user') {
            // An empty text block is rejected outright, so a blank user message is
            // dropped rather than sent.
            if (message.content) {
                pushBlocks('user', [{ text: String(message.content) }]);
            }
            continue;
        }
        if (role === 'assistant') {
            let blocks = [];
            if (message.content) {
                blocks.push({ text: String(message.content) });
            }
            for (let call of message.tool_calls || []) {
                blocks.push({
                    toolUse: {
                        toolUseId: call.id,
                        name: call.function && call.function.name,
                        // Converse takes parsed input; OpenAI carries a JSON string.
                        // A malformed string is sent as an empty object rather than
                        // throwing: the model produced it, and a 400 here would end
                        // the turn with a stack trace instead of a recoverable retry.
                        input: parseJsonOr(call.function && call.function.arguments, {})
                    }
                });
            }
            pushBlocks('assistant', blocks);
            continue;
        }
        if (role === 'tool') {
            pushBlocks('user', [{
                toolResult: {
                    toolUseId: message.tool_call_id,
                    content: [{ text: String(message.content == null ? '' : message.content) }]
                }
            }]);
            continue;
        }
    }

    // Converse requires the first message to be a user turn. A transcript that
    // opens on an assistant message (a replayed thread whose first user message
    // was trimmed) is otherwise a 400.
    while (converse.length && converse[0].role !== 'user') {
        converse.shift();
    }

    return { system: system, messages: converse };
}

function parseJsonOr(text, fallback) {
    if (text == null || text === '') {
        return fallback;
    }
    if (typeof text === 'object') {
        return text;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        return fallback;
    }
}

// OpenAI tool definitions -> Converse toolConfig.
function toToolConfig(tools) {
    if (!tools || !tools.length) {
        return null;
    }
    let specs = [];
    for (let tool of tools) {
        let fn = tool && (tool.function || tool);
        if (!fn || !fn.name) {
            continue;
        }
        specs.push({
            toolSpec: {
                name: fn.name,
                description: fn.description || fn.name,
                // Converse nests the JSON Schema under `json`; OpenAI has it bare.
                inputSchema: { json: fn.parameters || { type: 'object', properties: {} } }
            }
        });
    }
    if (!specs.length) {
        return null;
    }
    return { tools: specs, toolChoice: { auto: {} } };
}

// The full Converse request for an OpenAI-shaped params object. Pure, so the
// translation is tested without a network or a credential.
function toConverseRequest(params) {
    let model = String((params && params.model) || '');
    let mapped = toConverseMessages(params && params.messages);
    let body = {
        messages: mapped.messages,
        inferenceConfig: {
            maxTokens: firstNumber([
                params && params.max_completion_tokens,
                params && params.max_tokens
            ], DEFAULT_MAX_TOKENS)
        }
    };
    if (mapped.system.length) {
        body.system = mapped.system;
    }
    // `temperature` is only sent when the caller set one. Bedrock rejects a null,
    // and several Claude variants reject temperature together with reasoning.
    if (params && params.temperature != null) {
        body.inferenceConfig.temperature = params.temperature;
    }
    let toolConfig = toToolConfig(params && params.tools);
    if (toolConfig) {
        body.toolConfig = toolConfig;
    }
    return { modelId: model, body: body };
}

function firstNumber(candidates, fallback) {
    for (let value of candidates) {
        if (typeof value === 'number' && isFinite(value) && value > 0) {
            return value;
        }
    }
    return fallback;
}

// The request path for a model. Built from the RAW model id — SigV4 canonicalises
// the path by URI-encoding whatever is on the wire, so the signer and the wire
// must agree on the raw form. Model ids contain a colon
// (`…claude-sonnet-4-5-20250929-v1:0`); pre-encoding it here while signing the
// raw path (or the reverse) produces a 403 signature mismatch that looks like a
// credential fault and reproduces only on the models whose id has a colon.
function conversePath(modelId, streaming) {
    return '/model/' + modelId + (streaming ? '/converse-stream' : '/converse');
}

// ---------------------------------------------------------------------------
// Response translation: Converse -> OpenAI
// ---------------------------------------------------------------------------

const STOP_REASONS = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    max_tokens: 'length',
    content_filtered: 'content_filter',
    guardrail_intervened: 'content_filter'
};

function toFinishReason(stopReason) {
    return STOP_REASONS[String(stopReason || '')] || 'stop';
}

// A non-streaming Converse response as an OpenAI completion. `reasoningContent`
// blocks are dropped: the OpenAI shape has nowhere to carry them, and Claude on
// Bedrock returns them unasked. They are not replayed to the model either, which
// is correct while extended thinking is off.
function fromConverseResponse(json, model) {
    let blocks = (json && json.output && json.output.message && json.output.message.content) || [];
    let text = '';
    let toolCalls = [];
    for (let block of blocks) {
        if (block.text) {
            text += block.text;
        } else if (block.toolUse) {
            toolCalls.push({
                id: block.toolUse.toolUseId,
                type: 'function',
                function: {
                    name: block.toolUse.name,
                    arguments: JSON.stringify(block.toolUse.input == null ? {} : block.toolUse.input)
                }
            });
        }
    }
    let message = { role: 'assistant', content: text || null };
    if (toolCalls.length) {
        message.tool_calls = toolCalls;
    }
    let usage = (json && json.usage) || {};
    return {
        id: 'bedrock-converse',
        object: 'chat.completion',
        model: model,
        choices: [{
            index: 0,
            message: message,
            finish_reason: toFinishReason(json && json.stopReason)
        }],
        usage: {
            prompt_tokens: usage.inputTokens || 0,
            completion_tokens: usage.outputTokens || 0,
            total_tokens: usage.totalTokens || 0
        }
    };
}

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

// Bedrock streams `application/vnd.amazon.eventstream`, a binary framing:
//
//   4 bytes  total length            (big endian)
//   4 bytes  headers length          (big endian)
//   4 bytes  prelude CRC32
//   N bytes  headers
//   M bytes  payload                 (total - headers - 16)
//   4 bytes  message CRC32
//
// A header is: 1 byte name length, the name, 1 byte value type, then the value
// (type 7 — the only one Bedrock uses here — is a 2-byte length then bytes).
//
// The CRCs are deliberately not verified. `zlib.crc32` only exists from Node
// 20.15, this ships on Node 20, and a hand-rolled CRC table to check a payload
// that is then JSON-parsed anyway would be cost without benefit: corruption
// surfaces as a parse failure either way.
//
// Pure and incremental: takes whatever bytes have arrived, returns the frames that
// are complete plus the remainder to prepend to the next read. A frame straddling
// two TCP reads is the normal case, not an edge one.
function decodeEventStream(buffer) {
    let events = [];
    let offset = 0;

    while (buffer.length - offset >= 12) {
        let totalLength = buffer.readUInt32BE(offset);
        // A nonsensical length means the stream is not eventstream framing (or is
        // corrupt); stopping leaves the bytes in `rest` rather than looping.
        if (totalLength < 16 || totalLength > 16 * 1024 * 1024) {
            break;
        }
        if (buffer.length - offset < totalLength) {
            break;
        }
        let headersLength = buffer.readUInt32BE(offset + 4);
        let headersStart = offset + 12;
        let payloadStart = headersStart + headersLength;
        let payloadEnd = offset + totalLength - 4;
        if (payloadEnd < payloadStart) {
            break;
        }

        let headers = decodeHeaders(buffer.slice(headersStart, payloadStart));
        let payloadText = buffer.slice(payloadStart, payloadEnd).toString('utf8');
        events.push({
            type: headers[':event-type'] || headers[':exception-type'] || '',
            messageType: headers[':message-type'] || '',
            exceptionType: headers[':exception-type'] || '',
            payload: parseJsonOr(payloadText, {})
        });
        offset += totalLength;
    }

    return { events: events, rest: buffer.slice(offset) };
}

function decodeHeaders(buffer) {
    let headers = {};
    let offset = 0;
    while (offset < buffer.length) {
        let nameLength = buffer.readUInt8(offset);
        offset += 1;
        if (offset + nameLength > buffer.length) {
            break;
        }
        let name = buffer.slice(offset, offset + nameLength).toString('utf8');
        offset += nameLength;
        if (offset >= buffer.length) {
            break;
        }
        let valueType = buffer.readUInt8(offset);
        offset += 1;
        if (valueType === 7) {
            if (offset + 2 > buffer.length) {
                break;
            }
            let valueLength = buffer.readUInt16BE(offset);
            offset += 2;
            headers[name] = buffer.slice(offset, offset + valueLength).toString('utf8');
            offset += valueLength;
        } else {
            // Bedrock's event headers are all strings. Anything else is skipped by
            // its fixed width so the walk stays in sync instead of aborting.
            let widths = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 6: -1, 8: 8, 9: 16 };
            let width = widths[valueType];
            if (width == null || width < 0) {
                break;
            }
            offset += width;
        }
    }
    return headers;
}

// One Converse stream event -> zero or more OpenAI streaming chunks.
//
// `state` carries the mapping from Converse's contentBlockIndex to OpenAI's
// tool_calls index, because they count differently: Converse indexes *all* content
// blocks (a text block is index 0, the first tool use may be index 1), while
// OpenAI's tool_calls array is indexed from 0 among tool calls only. Passing the
// Converse index straight through leaves a hole at index 0 that the agent
// accumulates into a tool call with no name.
function converseEventToChunks(event, state, model) {
    let chunks = [];
    let base = { id: 'bedrock-converse', object: 'chat.completion.chunk', model: model };

    function chunk(delta, finishReason) {
        return Object.assign({}, base, {
            choices: [{ index: 0, delta: delta, finish_reason: finishReason || null }]
        });
    }

    let payload = event.payload || {};

    if (event.exceptionType || event.messageType === 'exception') {
        let err = new Error(payload.message || payload.Message ||
            ('Bedrock returned ' + (event.exceptionType || 'an exception') + '.'));
        err.bedrockExceptionType = event.exceptionType;
        throw err;
    }

    switch (event.type) {
        case 'contentBlockStart': {
            let toolUse = payload.start && payload.start.toolUse;
            if (toolUse) {
                let openAiIndex = state.nextToolIndex++;
                state.toolIndexByBlock[String(payload.contentBlockIndex)] = openAiIndex;
                chunks.push(chunk({
                    tool_calls: [{
                        index: openAiIndex,
                        id: toolUse.toolUseId,
                        type: 'function',
                        function: { name: toolUse.name, arguments: '' }
                    }]
                }));
            }
            break;
        }
        case 'contentBlockDelta': {
            let delta = payload.delta || {};
            if (delta.text) {
                chunks.push(chunk({ content: delta.text }));
            } else if (delta.toolUse && delta.toolUse.input != null) {
                // Arrives as partial JSON text, exactly as OpenAI streams arguments.
                let openAiIndex = state.toolIndexByBlock[String(payload.contentBlockIndex)];
                if (openAiIndex == null) {
                    openAiIndex = state.nextToolIndex++;
                    state.toolIndexByBlock[String(payload.contentBlockIndex)] = openAiIndex;
                }
                chunks.push(chunk({
                    tool_calls: [{
                        index: openAiIndex,
                        function: { arguments: String(delta.toolUse.input) }
                    }]
                }));
            }
            // `reasoningContent` deltas land here too and are deliberately ignored.
            break;
        }
        case 'messageStop': {
            chunks.push(chunk({}, toFinishReason(payload.stopReason)));
            break;
        }
        default:
            // messageStart, contentBlockStop, metadata: nothing the agent needs.
            // An unrecognised event is silence rather than a throw, so a new event
            // type in a future Bedrock release degrades instead of ending the turn.
            break;
    }

    return chunks;
}

function newStreamState() {
    return { nextToolIndex: 0, toolIndexByBlock: {} };
}

// ---------------------------------------------------------------------------
// The HTTP client
// ---------------------------------------------------------------------------

// Auth for one request: either SigV4 with a profile's credentials, or a Bedrock
// API key as a bearer token (the credential the AWS SDKs read from
// AWS_BEARER_TOKEN_BEDROCK). Both reach Converse; only the first can use a
// SignBridge profile.
function buildAuthorizedOptions(auth, region, method, rawPath, bodyText) {
    let host = runtimeHost(region);
    let headers = {
        'content-type': 'application/json',
        'accept': 'application/json'
    };

    if (auth && auth.kind === 'bearer') {
        headers['authorization'] = 'Bearer ' + auth.apiKey;
        return { host: host, path: rawPath, method: method, headers: headers };
    }

    let signed = awsSigner.signRequest({
        method: method,
        host: host,
        path: rawPath,
        body: bodyText,
        service: SIGNING_SERVICE,
        region: region,
        headers: headers,
        credentials: auth.credentials
    });
    // The wire path is the RAW path, matching what was signed. See conversePath().
    return { host: host, path: rawPath, method: method, headers: signed.headers };
}

function requestOnce(options, bodyText, collect) {
    return new Promise(function (resolve, reject) {
        let req = https.request(options, function (res) {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                let errorBody = '';
                res.on('data', function (c) { errorBody += c; });
                res.on('end', function () {
                    reject(bedrockError(res.statusCode, errorBody));
                });
                return;
            }
            if (collect) {
                let body = '';
                res.on('data', function (c) { body += c; });
                res.on('end', function () { resolve(body); });
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
        if (bodyText) {
            req.write(bodyText);
        }
        req.end();
    });
}

// Bedrock's errors are the ones a user will actually hit, so they are turned into
// one actionable sentence rather than a status code. The three that matter:
// AccessDeniedException (the role cannot invoke this model), a model id that is
// end-of-life or not on this API, and a throttle.
function bedrockError(statusCode, body) {
    let parsed = parseJsonOr(body, {});
    let raw = parsed.message || parsed.Message ||
        (parsed.error && parsed.error.message) || String(body || '').slice(0, 400);
    let type = parsed.__type || (parsed.error && parsed.error.type) || '';
    let message = raw || ('Bedrock returned HTTP ' + statusCode + '.');

    if (statusCode === 403 || /AccessDenied/i.test(type) || /not authorized/i.test(raw)) {
        message = raw + ' — the profile\'s role needs bedrock:InvokeModel (and ' +
            'bedrock:InvokeModelWithResponseStream) on this model.';
    } else if (statusCode === 404) {
        message = raw + ' — pick a different model. Bedrock model ids are ' +
            'region-specific and versioned, and the cross-region ones are prefixed ' +
            '(us./eu./global.).';
    }

    let err = new Error(message);
    err.status = statusCode;
    err.statusCode = statusCode;
    err.bedrockType = type;
    return err;
}

/**
 * A minimal OpenAI-shaped client backed by Bedrock's Converse API.
 *
 * Only the one method `lib/chat/agent.js` calls is implemented —
 * `chat.completions.create(params)` — because that is the whole contract the agent
 * depends on. `stream:true` returns an async iterable of OpenAI-shaped chunks;
 * anything else returns a completion object.
 *
 * @param {object} config
 * @param {string} config.region              e.g. 'us-east-1'
 * @param {function} [config.resolveCredentials]  () => Promise<{accessKeyId,
 *                                            secretAccessKey, sessionToken?}>.
 *                                            Called per request so short-lived
 *                                            profile credentials refresh mid-chat.
 * @param {string} [config.apiKey]            Bedrock API key, used instead of SigV4.
 */
function createBedrockClient(config) {
    let region = (config && config.region) || DEFAULT_REGION;
    let resolveCredentials = config && config.resolveCredentials;
    let apiKey = config && config.apiKey;

    async function resolveAuth() {
        if (apiKey) {
            return { kind: 'bearer', apiKey: apiKey };
        }
        if (!resolveCredentials) {
            throw new Error('Bedrock needs either an AWS profile or a Bedrock API key.');
        }
        let credentials = await resolveCredentials();
        if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
            throw new Error('Could not resolve AWS credentials for Bedrock.');
        }
        return { kind: 'sigv4', credentials: credentials };
    }

    async function createCompletion(params) {
        let request = toConverseRequest(params);
        if (!request.modelId) {
            throw new Error('No Bedrock model id was supplied.');
        }
        let streaming = !!(params && params.stream);
        let rawPath = conversePath(request.modelId, streaming);
        let bodyText = JSON.stringify(request.body);
        let auth = await resolveAuth();
        let options = buildAuthorizedOptions(auth, region, 'POST', rawPath, bodyText);

        if (!streaming) {
            let body = await requestOnce(options, bodyText, true);
            return fromConverseResponse(parseJsonOr(body, {}), request.modelId);
        }

        let res = await requestOnce(options, bodyText, false);
        return streamChunks(res, request.modelId);
    }

    // An async generator, so the agent's `for await (let chunk of stream)` works
    // against Bedrock exactly as it does against OpenAI.
    async function* streamChunks(res, model) {
        let state = newStreamState();
        let buffer = Buffer.alloc(0);
        for await (let piece of res) {
            buffer = Buffer.concat([buffer, piece]);
            let decoded = decodeEventStream(buffer);
            buffer = decoded.rest;
            for (let event of decoded.events) {
                for (let chunk of converseEventToChunks(event, state, model)) {
                    yield chunk;
                }
            }
        }
    }

    return {
        // The shape the agent reaches through: client.chat.completions.create(...)
        chat: { completions: { create: createCompletion } },
        // Exposed for the settings page's "test connection" and model list, which
        // need the same credentials and region without going through the agent.
        listModels: function () { return listBedrockModels(region, resolveAuth); },
        region: region
    };
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

// The model list comes from the Bedrock CONTROL plane, because the runtime host
// has no /models route at all (see the header). Two calls, and both matter:
//
//   GET /inference-profiles  — the cross-region ids (us./eu./global. prefixed).
//                              These are what most current Claude models require;
//                              invoking the bare foundation-model id returns 404
//                              for anything that is inference-profile-only.
//   GET /foundation-models   — everything the account can see, which is how a
//                              region-local model still appears.
//
// EITHER MAY BE DENIED WHILE INVOKE STILL WORKS, and that is not a corner case —
// it is what the profile this was built against does. An EKS service-account role
// scoped to inference has bedrock:InvokeModel and no bedrock:List*, so demanding a
// listing before letting the user pick a model would lock out exactly the
// credential this provider exists to support. A denied listing therefore returns
// the curated fallback with a note, never an error.
function listBedrockModels(region, resolveAuth) {
    return resolveAuth().then(function (auth) {
        return Promise.all([
            controlPlaneGet(auth, region, '/inference-profiles').catch(function (e) { return e; }),
            controlPlaneGet(auth, region, '/foundation-models').catch(function (e) { return e; })
        ]).then(function (results) {
            let profilesResult = results[0];
            let modelsResult = results[1];
            let models = [];
            let denied = [];
            // The errors themselves, not just the permission names. A caller has to
            // tell one failure from the other: 403 means "these credentials are
            // real but not allowed to list", which must not block a provider whose
            // role can still invoke, whereas 401 means the credentials were not
            // accepted at all — a bad or expired key, which must not be reported as
            // a working connection.
            let errors = [];

            if (profilesResult instanceof Error) {
                denied.push('bedrock:ListInferenceProfiles');
                errors.push(describeListError('bedrock:ListInferenceProfiles', profilesResult));
            } else {
                for (let summary of profilesResult.inferenceProfileSummaries || []) {
                    if (summary.status && summary.status !== 'ACTIVE') {
                        continue;
                    }
                    models.push({
                        id: summary.inferenceProfileId,
                        label: summary.inferenceProfileName || summary.inferenceProfileId,
                        kind: 'inference-profile'
                    });
                }
            }

            if (modelsResult instanceof Error) {
                denied.push('bedrock:ListFoundationModels');
                errors.push(describeListError('bedrock:ListFoundationModels', modelsResult));
            } else {
                for (let summary of modelsResult.modelSummaries || []) {
                    if (!canServeChat(summary)) {
                        continue;
                    }
                    models.push({
                        id: summary.modelId,
                        label: summary.modelName || summary.modelId,
                        kind: 'foundation-model'
                    });
                }
            }

            return {
                models: dedupeById(models),
                denied: denied,
                errors: errors,
                usedFallback: false
            };
        });
    }).then(function (result) {
        if (result.models.length) {
            return result;
        }
        // Nothing listable — either both calls were denied, or the account really
        // has no matching model. Offer the curated ids so the provider is usable.
        return {
            models: fallbackModels(region),
            denied: result.denied,
            errors: result.errors,
            usedFallback: true
        };
    });
}

function describeListError(permission, err) {
    return {
        permission: permission,
        statusCode: (err && (err.statusCode || err.status)) || 0,
        message: (err && err.message) || 'Unknown error'
    };
}

// A foundation model that can answer a chat turn: text in, text out, available
// on demand or through an inference profile. Bedrock also lists embedding and
// image models, and offering `amazon.titan-embed-text-v2:0` as a chat model is
// simply broken.
function canServeChat(summary) {
    let inputs = summary.inputModalities || [];
    let outputs = summary.outputModalities || [];
    if (inputs.length && inputs.indexOf('TEXT') === -1) {
        return false;
    }
    if (outputs.length && outputs.indexOf('TEXT') === -1) {
        return false;
    }
    if (summary.modelLifecycle && summary.modelLifecycle.status === 'LEGACY') {
        return false;
    }
    let types = summary.inferenceTypesSupported || [];
    if (types.length && types.indexOf('ON_DEMAND') === -1 &&
        types.indexOf('INFERENCE_PROFILE') === -1) {
        // PROVISIONED-only: invoking it without a provisioned throughput ARN fails.
        return false;
    }
    return true;
}

function dedupeById(models) {
    let seen = {};
    let out = [];
    for (let model of models) {
        if (!model.id || seen[model.id]) {
            continue;
        }
        seen[model.id] = true;
        out.push(model);
    }
    return out;
}

// Used only when the credentials cannot list models — a real state for a
// least-privilege role, not a corner case (see listBedrockModels above).
//
// EVERY ID HERE WAS VERIFIED BY INVOKING IT, because a fallback list whose ids 404
// is worse than no list: the user cannot tell a wrong id from a missing model
// grant. Probed from us-east-1 with the inference-only IRSA role this provider was
// built for, and three of the answers do not follow the pattern of the ids that
// came before them:
//
//   us.anthropic.claude-opus-4-6-v1     -> works; "…-v1:0" is 400 "model identifier is invalid"
//   us.anthropic.claude-sonnet-4-6      -> works; carries no version suffix at all
//   us.anthropic.claude-haiku-4-6[-v1]  -> 400 invalid; there is no 4.6 Haiku, 4.5 is current
//
// So the ids are stored as *suffixes* and the cross-region prefix is derived from
// the region, for two measured reasons: a bare `anthropic.claude-sonnet-4-6`
// answers 400 "Invocation … with on-demand throughput isn't supported" (these
// models are inference-profile-only), and a `us.` id is just as invalid from
// eu-central-1 as a made-up one — a hardcoded `us.` list is four dead entries for
// every user outside the US.
//
// Deliberately short. A stale long list is worse than a few current ids plus the
// ability to type one in, which is what the custom-model-id field exists for.
const FALLBACK_MODELS = [
    { suffix: 'anthropic.claude-opus-4-6-v1', label: 'Claude Opus 4.6' },
    { suffix: 'anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { suffix: 'anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5' },
    // One generation back, because an account granted 4.5 and not yet 4.6 would
    // otherwise see a list in which every entry is denied.
    { suffix: 'anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5' }
];

// The geography prefixes are AWS's own (`us.`, `eu.`, `apac.`, `us-gov.`), with
// `global.` as the catch-all — that is also the prefix AWS points at when a region
// belongs to no geography-specific profile. Only the `us.` and `global.` forms were
// verified here; the rest follow the documented scheme, and the custom-model-id
// field is the escape hatch for a region that disagrees.
function crossRegionPrefix(region) {
    let normalized = String(region || DEFAULT_REGION).toLowerCase();
    // us-gov- before us-: GovCloud regions start with both.
    if (normalized.indexOf('us-gov-') === 0) {
        return 'us-gov.';
    }
    if (normalized.indexOf('us-') === 0) {
        return 'us.';
    }
    if (normalized.indexOf('eu-') === 0) {
        return 'eu.';
    }
    if (normalized.indexOf('ap-') === 0) {
        return 'apac.';
    }
    return 'global.';
}

function fallbackModelIds(region) {
    let prefix = crossRegionPrefix(region);
    return FALLBACK_MODELS.map(function (entry) {
        return prefix + entry.suffix;
    });
}

function fallbackModels(region) {
    let prefix = crossRegionPrefix(region);
    return FALLBACK_MODELS.map(function (entry) {
        return { id: prefix + entry.suffix, label: entry.label, kind: 'inference-profile' };
    });
}

function controlPlaneGet(auth, region, rawPath) {
    let host = controlHost(region);
    let headers = { 'accept': 'application/json' };
    let options;
    if (auth.kind === 'bearer') {
        headers['authorization'] = 'Bearer ' + auth.apiKey;
        options = { host: host, path: rawPath, method: 'GET', headers: headers };
    } else {
        let signed = awsSigner.signRequest({
            method: 'GET',
            host: host,
            path: rawPath,
            body: '',
            service: SIGNING_SERVICE,
            region: region,
            headers: headers,
            credentials: auth.credentials
        });
        options = { host: host, path: rawPath, method: 'GET', headers: signed.headers };
    }
    return requestOnce(options, '', true).then(function (body) {
        return parseJsonOr(body, {});
    });
}

module.exports = {
    createBedrockClient: createBedrockClient,
    // Exported for tests: every translation step is pure, so the adapter is tested
    // without Bedrock, credentials or a network.
    toConverseMessages: toConverseMessages,
    toToolConfig: toToolConfig,
    toConverseRequest: toConverseRequest,
    conversePath: conversePath,
    fromConverseResponse: fromConverseResponse,
    decodeEventStream: decodeEventStream,
    converseEventToChunks: converseEventToChunks,
    newStreamState: newStreamState,
    canServeChat: canServeChat,
    toFinishReason: toFinishReason,
    bedrockError: bedrockError,
    listBedrockModels: listBedrockModels,
    runtimeHost: runtimeHost,
    controlHost: controlHost,
    SIGNING_SERVICE: SIGNING_SERVICE,
    DEFAULT_REGION: DEFAULT_REGION,
    FALLBACK_MODELS: FALLBACK_MODELS,
    crossRegionPrefix: crossRegionPrefix,
    fallbackModelIds: fallbackModelIds,
    fallbackModels: fallbackModels
};
