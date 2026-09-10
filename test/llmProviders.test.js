"use strict";

// The LLM provider registry and its two mirrors.
//
// The registry is the feature's extension point: adding a provider is meant to be
// one row. That only holds if the things derived from a row stay derived, so this
// file pins the parts that would otherwise rot silently:
//
//   1. `frontend/src/llmProviders.js` duplicates the ids and display order (it is
//      ESM and cannot require() this CommonJS module). A missing id means a
//      provider the server supports but the picker sorts to the end with a raw id
//      for a label.
//   2. Every row must say how a key is obtained and how to authenticate with it —
//      the two things every call site reads. A row missing `acquisition` renders a
//      card with no primary action.
//   3. `looksLikeKey` must never be able to reject a key. Providers change their
//      prefixes without notice, and a client-side format check that hard-fails is
//      how a valid key gets refused by the app that is supposed to use it.
//   4. A row that declares a `chatBackend` is answered by a named module instead
//      of an OpenAI-shaped POST, and the name has to match the dispatch table in
//      lib/chat/chatService.js. Getting that wrong fails only at the first chat
//      turn, and only for that one provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const providers = require('../lib/llm/providers');

const FRONTEND_MIRROR = path.join(__dirname, '..', 'frontend', 'src', 'llmProviders.js');

async function loadMirror() {
    return import(pathToFileURL(FRONTEND_MIRROR).href);
}

test('registry: every row declares an acquisition path and an auth style', () => {
    let acquisitions = Object.values(providers.ACQUISITION);
    for (let provider of providers.listProviders()) {
        assert.ok(provider.id, 'a provider row has no id');
        assert.ok(provider.label, provider.id + ' has no label');
        assert.ok(
            acquisitions.includes(provider.acquisition),
            provider.id + ' has an unknown acquisition: ' + provider.acquisition
        );
        assert.ok(provider.auth, provider.id + ' declares no auth style');
        // An OpenAI-shaped row is reached over a URL, so it needs either a shared
        // endpoint or an explicit requirement that the user supplies one — with
        // neither it cannot be called at all. A row with its own `kind` (bedrock,
        // whose endpoint is derived from the region) or its own `chatBackend`
        // (cursor, which is a local process) answers that question itself.
        if (provider.kind === 'openai' && !provider.chatBackend) {
            assert.ok(
                provider.baseUrl || provider.baseUrlRequired,
                provider.id + ' has neither a baseUrl nor baseUrlRequired'
            );
        }
    }
});

test('registry: a keyless provider is the only kind with no key placeholder', () => {
    for (let provider of providers.listProviders()) {
        if (provider.keyless) {
            assert.equal(provider.acquisition, providers.ACQUISITION.NONE,
                provider.id + ' is keyless but claims a key-acquisition path');
        } else {
            assert.ok(provider.keyPlaceholder,
                provider.id + ' needs a key but shows no placeholder for it');
        }
    }
});

test('registry: there are exactly two ways to get a key, and CONSOLE rows link somewhere', () => {
    // Two values, deliberately. SignBridge used to broker provider credentials —
    // an OpenRouter OAuth/PKCE flow, and an OpenAI flow where the user pasted an
    // organisation admin key so we could mint an inference key from it — and both
    // were removed. They put us between the user and their provider account, one
    // of them holding a credential that creates more credentials, to save a
    // copy-paste. They also made this one settings screen behave differently
    // depending on which tile you clicked. If a third value appears here, that
    // decision is being undone.
    assert.deepEqual(
        Object.keys(providers.ACQUISITION).sort(),
        ['CONSOLE', 'NONE'],
        'a new acquisition path was added — SignBridge should not broker provider keys'
    );

    for (let provider of providers.listProviders()) {
        // The console link is the whole content of option 2 on the card: "you
        // have no key — create one here, then come back and paste it".
        if (provider.acquisition === providers.ACQUISITION.CONSOLE) {
            assert.ok(provider.consoleUrl, provider.id + ' claims CONSOLE but links nowhere');
        }
        // Nothing left in a row should describe a flow where we create the key.
        assert.equal(provider.oauth, undefined, provider.id + ' still carries an oauth config');
        assert.equal(provider.mint, undefined, provider.id + ' still carries a mint config');
    }
});

test('registry: a non-inference provider says why it cannot be used for chat', () => {
    // Currently vacuous — every row can answer a chat turn (Cursor was the last
    // exception and now does so through a chatBackend). Kept as the guard for the
    // next row that cannot: a provider excluded from the picker with no note is a
    // tile that silently does nothing.
    let inferenceIds = providers.listInferenceProviders().map(p => p.id);
    for (let provider of providers.listProviders()) {
        if (provider.inference === false) {
            assert.ok(provider.inferenceNote,
                provider.id + ' cannot do inference but does not explain that to the user');
            assert.ok(!inferenceIds.includes(provider.id),
                provider.id + ' is listed as an inference provider despite inference:false');
        }
    }
});

test('registry: a chatBackend row is offered for chat, and names its backend', () => {
    // Cursor is the reason `chatBackend` exists. It sells an agent rather than
    // model access — api.cursor.com has no /chat/completions — so it is answered by
    // lib/chat/cursorAgent.js driving the local Cursor CLI over SignBridge's own
    // MCP tools. Three things have to hold together, and each has failed once:
    //
    //   * inference must NOT be false, or the provider disappears from the picker
    //     and resolveActive rejects it with provider_not_inference.
    //   * chatBackend must be exactly the key chatService's CHAT_BACKENDS maps, or
    //     a turn dies with "this build does not have that backend".
    //   * the row must NOT carry a baseUrl-shaped promise of chat completions
    //     without saying so — hence backendNote, which is the only place the UI
    //     learns that this provider needs a CLI installed on the server.
    let cursor = providers.getProvider('cursor');
    assert.ok(cursor, 'the cursor row is gone');
    assert.notEqual(cursor.inference, false, 'cursor must be offered as a chat target');
    assert.equal(providers.getChatBackend(cursor), 'cursor-agent');
    assert.ok(cursor.backendNote && cursor.backendNote.length > 40,
        'a chatBackend row must explain how it answers — it is not a normal endpoint');
    assert.ok(providers.listInferenceProviders().map(p => p.id).includes('cursor'));

    // Every other row goes through the OpenAI client, and getChatBackend must say
    // so with a falsy value so `if (getChatBackend(p))` is a safe dispatch.
    for (let provider of providers.listProviders()) {
        if (provider.id !== 'cursor') {
            assert.equal(providers.getChatBackend(provider), null,
                provider.id + ' unexpectedly declares a chatBackend');
        }
    }
    assert.equal(providers.getChatBackend(null), null);
});

test('registry: a provider whose model list is public declares a separate auth probe', () => {
    // OpenRouter is the case that motivated this: GET /models answers without a
    // key, so testing the connection against it reports a revoked key as working.
    for (let provider of providers.listProviders()) {
        if (provider.modelsPublic) {
            assert.ok(provider.authCheckPath || provider.testPath,
                provider.id + ' has a public model list but no authenticated probe path');
        }
    }
});

test('bedrock is answered by the Converse adapter, not by an OpenAI-shaped base URL', () => {
    // Bedrock *does* publish an OpenAI-compatible surface at /openai/v1, and this
    // row used to point at it. Measured, it does not serve Claude: GET
    // /openai/v1/models answers 404 <UnknownOperationException/>, and a Claude id
    // posted to /openai/v1/chat/completions answers 404 "The model doesn't exist or
    // doesn't support this API." That surface is for the openai.gpt-oss-* models.
    // So the row is `kind:'bedrock'` and lib/llm/bedrockConverse.js reaches
    // /model/{id}/converse instead. Pointing it back at a baseUrl would restore a
    // configuration that verifies and then 404s on every Claude model.
    let bedrock = providers.getProvider('bedrock');
    assert.equal(bedrock.kind, 'bedrock');
    assert.equal(bedrock.baseUrl, undefined,
        'the endpoint is derived from the region by the adapter, not configured');
    assert.equal(providers.needsBaseUrl(bedrock), false);
    assert.ok(bedrock.inference !== false, 'bedrock must be offered as a chat target');
    // No prefix check: Bedrock documents no stable API-key prefix, so a
    // keyPrefixes entry here could only produce a spurious warning on a good key.
    assert.equal(bedrock.keyPrefixes, undefined);
    assert.equal(bedrock.acquisition, providers.ACQUISITION.CONSOLE);
    // The API-key path is still a bearer token — the credential the AWS SDKs read
    // from AWS_BEARER_TOKEN_BEDROCK.
    assert.equal(bedrock.auth, 'bearer');
    assert.deepEqual(providers.buildAuthHeaders(bedrock, 'bedrock-key'), {
        Authorization: 'Bearer bedrock-key'
    });
});

test('bedrock is the only row offering a choice of credential source, and prefers a profile', () => {
    // The point of the AWS-profile source: SignBridge already mints credentials for
    // IAM users, SSO roles, EC2 instance roles and EKS IRSA service accounts, and
    // Converse accepts all of them. So Claude in the user's own account needs no new
    // credential to create, rotate or store — which is why it is the default.
    let bedrock = providers.getProvider('bedrock');
    assert.deepEqual(providers.listCredentialSources(bedrock),
        [providers.CREDENTIAL_SOURCE.AWS_PROFILE, providers.CREDENTIAL_SOURCE.API_KEY]);
    assert.equal(bedrock.defaultCredentialSource, providers.CREDENTIAL_SOURCE.AWS_PROFILE);

    for (let provider of providers.listProviders()) {
        if (provider.id === 'bedrock') {
            continue;
        }
        assert.ok(providers.listCredentialSources(provider).length <= 1,
            provider.id + ' offers a credential choice; only bedrock should. If a second ' +
            'AWS-signed provider is added, extend the Settings UI rather than assuming one row.');
    }
});

test('a profile-signed provider needs no API key, and an unoffered source is ignored', () => {
    let bedrock = providers.getProvider('bedrock');

    // Default (no stored config): the profile path, so no key is required. This is
    // what stops resolveActive reporting missing_key for a working configuration.
    assert.equal(providers.resolveCredentialSource(bedrock, {}),
        providers.CREDENTIAL_SOURCE.AWS_PROFILE);
    assert.equal(providers.usesAwsProfile(bedrock, {}), true);
    assert.equal(providers.needsApiKey(bedrock, {}), false);

    // Explicitly chosen key path: a key is required again.
    let keyConfig = { credentialSource: providers.CREDENTIAL_SOURCE.API_KEY };
    assert.equal(providers.usesAwsProfile(bedrock, keyConfig), false);
    assert.equal(providers.needsApiKey(bedrock, keyConfig), true);

    // A stored source the row no longer offers must not survive: otherwise removing
    // a source from the registry leaves users stuck on it with no way to change it.
    assert.equal(providers.resolveCredentialSource(bedrock, { credentialSource: 'nonsense' }),
        providers.CREDENTIAL_SOURCE.AWS_PROFILE);
    let openai = providers.getProvider('openai');
    assert.equal(providers.resolveCredentialSource(openai,
        { credentialSource: providers.CREDENTIAL_SOURCE.AWS_PROFILE }),
        providers.CREDENTIAL_SOURCE.API_KEY,
        'openai cannot be signed with an AWS profile, whatever is stored');
    assert.equal(providers.needsApiKey(openai, {}), true);

    // Keyless stays keyless.
    assert.equal(providers.needsApiKey(providers.getProvider('ollama'), {}), false);
});

test('a region is always resolved for the AWS-signed row, config first', () => {
    // Bedrock model availability and model ids are both region-scoped, so an empty
    // region is a 404 that reads as "model not available".
    let bedrock = providers.getProvider('bedrock');
    assert.equal(providers.resolveAwsRegion(bedrock, { awsRegion: 'eu-central-1' }), 'eu-central-1');
    assert.equal(providers.resolveAwsRegion(bedrock, {}), bedrock.awsRegionDefault);
    assert.ok(providers.resolveAwsRegion(bedrock, { awsRegion: '  ' }),
        'blank must fall through to the default, not resolve to blank');
});

test('needsBaseUrl separates "has a default endpoint" from "must be told one"', () => {
    // Bedrock derives its endpoint from the region, so it declares neither — and a
    // check of "no base URL means unconfigured" would fail it forever. Azure has no
    // shared endpoint at all and must still be required to supply one.
    assert.equal(providers.needsBaseUrl(providers.getProvider('openai')), true);
    assert.equal(providers.needsBaseUrl(providers.getProvider('azure-openai')), true);
    assert.equal(providers.needsBaseUrl(providers.getProvider('bedrock')), false);
});

test('buildAuthHeaders: each auth style produces the header that provider wants', () => {
    let openai = providers.getProvider('openai');
    assert.deepEqual(providers.buildAuthHeaders(openai, 'sk-test'), {
        Authorization: 'Bearer sk-test'
    });

    let anthropic = providers.getProvider('anthropic');
    let anthropicHeaders = providers.buildAuthHeaders(anthropic, 'sk-ant-test');
    assert.equal(anthropicHeaders['x-api-key'], 'sk-ant-test');
    // The version header rides along from extraHeaders rather than being special-cased.
    assert.equal(anthropicHeaders['anthropic-version'], '2023-06-01');

    let azure = providers.getProvider('azure-openai');
    assert.deepEqual(providers.buildAuthHeaders(azure, 'abc'), { 'api-key': 'abc' });

    // Keyless: no Authorization header at all, not an empty one — an empty bearer
    // is a 401 at some proxies rather than the anonymous request intended.
    let ollama = providers.getProvider('ollama');
    assert.deepEqual(providers.buildAuthHeaders(ollama, ''), {});
});

test('looksLikeKey: recognises a prefix, and is silent when there is nothing to check', () => {
    let openai = providers.getProvider('openai');
    assert.equal(providers.looksLikeKey(openai, 'sk-proj-abcdef1234567890'), true);
    assert.equal(providers.looksLikeKey(openai, 'totally-new-prefix-999'), false);
    // Absent key, unknown provider, or a provider with no declared prefixes: true,
    // because "cannot tell" must not read as "wrong".
    assert.equal(providers.looksLikeKey(openai, ''), true);
    assert.equal(providers.looksLikeKey(null, 'sk-whatever'), true);
    assert.equal(providers.looksLikeKey(providers.getProvider('ollama'), 'anything'), true);
});

test('looksLikeKey is advisory: no failure reason is derived from the key shape', () => {
    // The rule this protects: a prefix mismatch may only ever *annotate* a
    // successful probe (providerClient attaches a warning after the call
    // succeeds). If it ever became a precondition, a working key issued under a
    // prefix we have not heard of would be refused by the app whose whole job is
    // to use it — and providers do change prefixes without notice.
    let source = fs.readFileSync(
        path.join(__dirname, '..', 'lib', 'llm', 'providerClient.js'), 'utf8'
    );
    let call = source.indexOf('looksLikeKey');
    assert.ok(call > -1, 'providerClient no longer consults looksLikeKey');
    // It is used inside the success handler, which begins with `ok: true`.
    let precedingSuccess = source.lastIndexOf('ok: true', call);
    let precedingFailure = source.lastIndexOf('ok: false', call);
    assert.ok(
        precedingSuccess > precedingFailure,
        'looksLikeKey appears on a failure path — it must only annotate a successful probe'
    );
});

test('resolveBaseUrl: config overrides the default, and blank config does not', () => {
    let openai = providers.getProvider('openai');
    assert.equal(providers.resolveBaseUrl(openai, {}), openai.baseUrl);
    assert.equal(providers.resolveBaseUrl(openai, { baseUrl: '' }), openai.baseUrl);
    assert.equal(
        providers.resolveBaseUrl(openai, { baseUrl: 'https://proxy.internal/v1' }),
        'https://proxy.internal/v1'
    );
    // A required-base-URL provider has no default to fall back to.
    let azure = providers.getProvider('azure-openai');
    assert.equal(providers.resolveBaseUrl(azure, {}) || '', '');
});

test('frontend mirror lists exactly the backend ids, in the same order', async () => {
    let mirror = await loadMirror();
    let backendIds = providers.listProviders().map(p => p.id);
    assert.deepEqual(
        mirror.LLM_PROVIDER_ORDER,
        backendIds,
        'frontend/src/llmProviders.js is out of sync with lib/llm/providers.js'
    );
    for (let id of backendIds) {
        assert.ok(mirror.LLM_PROVIDER_LABELS[id], 'the mirror has no label for ' + id);
    }
});

test('frontend mirror knows every acquisition value the backend can send', async () => {
    let mirror = await loadMirror();
    for (let value of Object.values(providers.ACQUISITION)) {
        assert.ok(
            mirror.ACQUISITION_SUMMARY[value],
            'the mirror has no summary line for acquisition "' + value + '"'
        );
    }
});

test('the registry source holds no real API keys', () => {
    // Placeholders are fine ("sk-..."); a full-length secret is not. This is the
    // same hygiene rule the rest of the suite applies to committed source.
    let source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm', 'providers.js'), 'utf8');
    assert.ok(!/sk-[A-Za-z0-9_-]{24,}/.test(source), 'providers.js appears to contain a real key');
});
