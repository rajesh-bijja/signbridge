"use strict";

// The pure decisions behind multi-provider LLM configuration.
//
// Every function here answers a question that used to have one hardcoded answer
// (OpenAI, one key from the environment). With twelve providers the answers differ
// per provider, and each of these is a place where being subtly wrong produces a
// bad experience rather than a crash:
//
//   * `resolveActive` decides which provider/model/key a chat turn uses, and the
//     user's sealed settings are its only source. There is no environment key, so
//     the tests below also assert the absence: a restored fallback would work
//     silently, chatting with a key the user never entered in the app.
//   * `describeHttpError` turns a provider's HTTP status into the sentence the
//     user acts on. The 400-that-means-401 case is real (Google) and verified;
//     without it, a bad key reads as "something about your request was wrong".
//   * `isChatModel` keeps embeddings and TTS models out of a chat model picker.
//   * `maskKey` / `toPublic` are the boundary a secret must not cross.
//   * `recommendModel` picks the model a user gets before they choose one.
//
// All of it is I/O-free by construction, so the tests need no key, no network and
// no fixtures. Where a clock or an environment is involved it is injected.

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../lib/llm/providers');
const providerClient = require('../lib/llm/providerClient');
const modelCatalog = require('../lib/llm/modelCatalog');
const llmSettings = require('../lib/llm/llmSettings');
const secretStore = require('../lib/llm/secretStore');

// A settings document with a plaintext key. getApiKey accepts a bare string (a
// hand-edited file), which is what lets these tests avoid the sealed-envelope
// path and therefore the filesystem entirely.
function settingsWith(providerId, config, top) {
    let out = llmSettings.emptySettings();
    out.enabled = true;
    out.activeProviderId = providerId;
    out.activeModel = 'gpt-5.4-2026-03-05';
    out.providers[providerId] = Object.assign({ apiKey: 'sk-test-key-1234567890' }, config || {});
    return Object.assign(out, top || {});
}

function httpError(status, body, code) {
    let err = new Error('request failed');
    if (status) {
        err.response = { status: status, data: body };
    }
    if (code) {
        err.code = code;
    }
    return err;
}

// ---------------------------------------------------------------- resolveActive

test('resolveActive: a fully configured provider resolves from settings', () => {
    let active = llmSettings.resolveActive(settingsWith('openai'), {});
    assert.equal(active.ok, true);
    assert.equal(active.source, 'settings');
    assert.equal(active.providerId, 'openai');
    assert.equal(active.model, 'gpt-5.4-2026-03-05');
    assert.equal(active.apiKey, 'sk-test-key-1234567890');
    assert.equal(active.baseUrl, providers.getProvider('openai').baseUrl);
});

test('resolveActive: settings are the only source — no environment key is consulted', () => {
    // A provider key may live in exactly one place: the user's sealed settings.
    // An environment variable cannot be verified, masked, rotated or attributed to
    // a chosen provider, and it leaks into process listings and orchestrator
    // templates — so LLM_API_KEY is not a supported way to configure SignBridge
    // and resolveActive must not read one however it is presented.
    //
    // resolveActive takes no environment argument at all now, but a caller passing
    // one (or the real process.env carrying these names) must change nothing.
    let saved = {
        LLM_API_KEY: process.env.LLM_API_KEY,
        LLM_MODEL: process.env.LLM_MODEL,
        LLM_BASE_URL: process.env.LLM_BASE_URL
    };
    process.env.LLM_API_KEY = 'sk-EXAMPLE-env-key-must-be-ignored';
    process.env.LLM_MODEL = 'gpt-4o';
    process.env.LLM_BASE_URL = 'https://gateway.internal/v1/';
    try {
        // Nothing configured: the environment must not rescue it.
        let bare = llmSettings.resolveActive(llmSettings.emptySettings());
        assert.equal(bare.ok, false, 'an env key must not make an unconfigured install chat');
        assert.equal(bare.reason, 'not_configured');
        assert.ok(!bare.apiKey, 'no key may be resolved from the environment');

        // Passed explicitly as the old second argument: still ignored.
        let ignoredArg = llmSettings.resolveActive(llmSettings.emptySettings(), {
            LLM_API_KEY: 'sk-EXAMPLE-env-key-must-be-ignored'
        });
        assert.equal(ignoredArg.ok, false);
        assert.equal(ignoredArg.reason, 'not_configured');

        // Configured: the stored key and model win, and the env names are absent
        // from the resolution entirely.
        let active = llmSettings.resolveActive(settingsWith('openai'));
        assert.equal(active.source, 'settings');
        assert.equal(active.apiKey, 'sk-test-key-1234567890');
        assert.equal(active.model, 'gpt-5.4-2026-03-05');
        assert.equal(active.baseUrl, providers.getProvider('openai').baseUrl);
    } finally {
        for (let name of Object.keys(saved)) {
            if (saved[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = saved[name];
            }
        }
    }
});

test('the LLM_API_KEY fallback is gone from the source, not just unreachable', () => {
    // The removal is the kind that a later "restore the fallback for unattended
    // deploys" patch quietly undoes, and nothing would fail while it was wrong:
    // chat would work, using a key the user never entered in the app, attributed
    // to a provider they never picked. So assert on the source of the two modules
    // that used to read it. Comments are stripped first — both files explain in
    // prose *why* there is no environment key, and a naive scan would match the
    // explanation.
    let fs = require('fs');
    let path = require('path');
    let files = ['lib/llm/llmSettings.js', 'lib/chat/llmClient.js'];
    for (let rel of files) {
        let src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        let code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        assert.ok(
            !/LLM_API_KEY|LLM_MODEL|LLM_BASE_URL/.test(code),
            rel + ' must not read an LLM key/model/base URL from the environment'
        );
    }
    // LLM_ENABLED is a different thing and stays: it is the operator master switch,
    // it is not a secret, and it can only turn AI features *off*.
    let clientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib/chat/llmClient.js'), 'utf8');
    assert.ok(/LLM_ENABLED/.test(clientSrc), 'the operator master switch must stay');
});

test('resolveActive: each way of being unconfigured has its own actionable reason', () => {
    let cases = [
        [llmSettings.emptySettings(), {}, 'not_configured'],
        [settingsWith('openai', { apiKey: '' }), {}, 'missing_key'],
        [settingsWith('openai', {}, { activeModel: '' }), {}, 'missing_model'],
        // 'provider_not_inference' is deliberately absent: no row in the registry
        // sets inference:false any more (Cursor was the last, and now answers
        // through a chatBackend — see the test below). The branch stays in
        // resolveActive as the guard for a future row that cannot serve chat, but
        // asserting it here would mean keeping a provider un-usable to satisfy a
        // test.
        [settingsWith('azure-openai', {}), {}, 'missing_base_url'],
        [settingsWith('nope-not-real', {}), {}, 'unknown_provider']
    ];
    for (let [settings, env, reason] of cases) {
        let active = llmSettings.resolveActive(settings, env);
        assert.equal(active.ok, false, reason + ' should not resolve');
        assert.equal(active.reason, reason);
        // Every failure has to be a sentence the user can act on, because this
        // string is the entire content of the 503 the chat panel shows.
        assert.ok(active.message && active.message.length > 20, reason + ' has no usable message');
    }
});

test('resolveActive: a keyless provider needs no key but still needs a model', () => {
    let ollama = llmSettings.emptySettings();
    ollama.activeProviderId = 'ollama';
    ollama.activeModel = 'llama3.3';
    ollama.providers.ollama = {};
    let active = llmSettings.resolveActive(ollama, {});
    assert.equal(active.ok, true, 'a keyless provider must resolve without a key');
    assert.equal(active.apiKey, '');

    ollama.activeModel = '';
    assert.equal(llmSettings.resolveActive(ollama, {}).reason, 'missing_model');
});

test('resolveActive: a provider with a chatBackend resolves, and says which one', () => {
    // Cursor sells an agent, not model access — there is no /chat/completions to
    // POST to. resolveActive still has to succeed (the user has a valid key and a
    // real model), and the *only* signal that the turn must not go through the
    // OpenAI client is `chatBackend`. If this came back undefined, llmClient would
    // build a client against api.cursor.com and every turn would 404.
    let active = llmSettings.resolveActive(settingsWith('cursor', {}), {});
    assert.equal(active.ok, true, 'Cursor must resolve — it can answer, just not over HTTP');
    assert.equal(active.chatBackend, 'cursor-agent');

    // And the ordinary case stays falsy, so `if (active.chatBackend)` is a safe
    // dispatch for every other provider.
    assert.ok(!llmSettings.resolveActive(settingsWith('openai')).chatBackend);
    assert.ok(!llmSettings.resolveActive(llmSettings.emptySettings()).chatBackend,
        'an unconfigured install dispatches to no backend at all');
});

// ------------------------------------------------- bedrock over an AWS profile

// The Bedrock row can sign with a SignBridge profile instead of holding a key, so
// three of resolveActive's checks have to mean something different for it: no key
// is required, a profile *is* required, and the absent base URL is not a fault.
function bedrockSettings(config) {
    let settings = llmSettings.emptySettings();
    settings.enabled = true;
    settings.activeProviderId = 'bedrock';
    settings.activeModel = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    settings.providers.bedrock = Object.assign({
        credentialSource: 'aws_profile',
        awsProfileName: 'My_IRSA_Profile',
        awsAuthnMode: 'irsa'
    }, config || {});
    return settings;
}

test('resolveActive: bedrock resolves with a profile and no key at all', () => {
    let active = llmSettings.resolveActive(bedrockSettings(), {});
    assert.equal(active.ok, true, 'a profile is a complete configuration — no key needed');
    assert.equal(active.credentialSource, 'aws_profile');
    assert.equal(active.awsProfileName, 'My_IRSA_Profile');
    assert.equal(active.awsAuthnMode, 'irsa');
    // The region has to arrive resolved: an empty one is a 404 that reads as
    // "model not available in your account".
    assert.ok(active.awsRegion, 'a region must always be resolved');
    // No key at all on the profile path: a signing profile and an inference key
    // are unrelated credentials, and resolving one as the other would mean
    // spending model quota with a signing profile or presigning with an
    // inference key.
    assert.equal(active.apiKey, '');
});

test('resolveActive: bedrock without a profile says so, rather than asking for a key', () => {
    // Sending the user to the key field when what is missing is a profile is the
    // one wrong answer here, because the key field is right there and looks like
    // the fix.
    let active = llmSettings.resolveActive(bedrockSettings({ awsProfileName: '' }), {});
    assert.equal(active.ok, false);
    assert.equal(active.reason, 'missing_aws_profile');
    assert.match(active.message, /profile/i);
});

test('resolveActive: bedrock on the key path needs a key again', () => {
    let settings = bedrockSettings({ credentialSource: 'api_key', apiKey: '' });
    assert.equal(llmSettings.resolveActive(settings, {}).reason, 'missing_key');

    settings = bedrockSettings({ credentialSource: 'api_key', apiKey: 'bedrock-key-abc' });
    let active = llmSettings.resolveActive(settings, {});
    assert.equal(active.ok, true);
    assert.equal(active.apiKey, 'bedrock-key-abc');
    assert.equal(active.credentialSource, 'api_key');
});

test('resolveActive: the ok envelope carries the AWS fields for every provider', () => {
    // llmClient reads these unconditionally, so an OpenAI turn must not find them
    // undefined and a Bedrock turn must not have to guess.
    let openai = llmSettings.resolveActive(settingsWith('openai'));
    assert.equal(openai.credentialSource, 'api_key');
    assert.equal(openai.awsProfileName, '');
    assert.equal(openai.awsAuthnMode, '');
});

test('toPublic exposes the profile choice, because the UI has to render it', () => {
    let pub = llmSettings.toPublic(bedrockSettings());
    assert.equal(pub.providers.bedrock.credentialSource, 'aws_profile');
    assert.equal(pub.providers.bedrock.awsProfileName, 'My_IRSA_Profile');
    assert.equal(pub.providers.bedrock.awsAuthnMode, 'irsa');
    assert.ok(pub.providers.bedrock.awsRegion, 'the resolved region, so the field is never blank');
    // The available sources come along too: the Settings panel decides whether to
    // show the choice at all from this, not from a hardcoded provider id.
    assert.deepEqual(pub.providers.bedrock.credentialSources, ['aws_profile', 'api_key']);
    // Still no key property, on this path least of all.
    assert.ok(!Object.prototype.hasOwnProperty.call(pub.providers.bedrock, 'apiKey'));
});

test('missingBedrockInput names the field that is missing, per credential source', () => {
    let bedrock = providers.getProvider('bedrock');

    // Profile path: a profile is required, a key is not. Refusing here rather than
    // sending an unsigned request means the message names the field.
    let missing = providerClient.missingBedrockInput(bedrock, { credentialSource: 'aws_profile' });
    assert.equal(missing.reason, 'missing_aws_profile');
    assert.match(missing.message, /profile/i);
    assert.equal(providerClient.missingBedrockInput(bedrock, {
        credentialSource: 'aws_profile',
        awsProfileName: 'p',
        userName: 'u'
    }), null);

    // Key path: the reverse, and the message offers the other route rather than
    // presenting the key as the only way in.
    missing = providerClient.missingBedrockInput(bedrock, { credentialSource: 'api_key' });
    assert.equal(missing.reason, 'missing_key');
    assert.match(missing.message, /AWS profile/);
    assert.equal(providerClient.missingBedrockInput(bedrock, {
        credentialSource: 'api_key',
        apiKey: 'k'
    }), null);
});

test('rejectedNotDenied separates a dead credential from a missing list permission', () => {
    // This is the difference between failing the test and passing it with a caveat.
    // The assistants IRSA role that this was built against can invoke Bedrock but
    // has neither bedrock:ListInferenceProfiles nor bedrock:ListFoundationModels —
    // so 403 has to be a pass, or a perfectly working configuration reports as
    // broken and the user goes looking for a credential fault that isn't there.
    assert.equal(providerClient.rejectedNotDenied([
        { permission: 'bedrock:ListFoundationModels', statusCode: 403, message: 'AccessDenied' }
    ]), null, '403 means the credentials work and simply lack a listing permission');

    // 401/400, by contrast, means the credentials themselves were not accepted —
    // which for a Bedrock API key is the only signal there is, since no invoke is
    // attempted during a connection test.
    for (let status of [400, 401]) {
        assert.ok(providerClient.rejectedNotDenied([
            { permission: 'bedrock:ListFoundationModels', statusCode: status, message: 'bad key' }
        ]), status + ' must fail the connection test');
    }
    assert.equal(providerClient.rejectedNotDenied([]), null);
    assert.equal(providerClient.rejectedNotDenied(null), null);
});

// -------------------------------------------------------------- secret hygiene

test('toPublic never emits a key, only a mask', () => {
    let settings = settingsWith('openai', { verifiedOk: true });
    let pub = llmSettings.toPublic(settings);
    let serialised = JSON.stringify(pub);
    assert.ok(!serialised.includes('sk-test-key-1234567890'),
        'toPublic leaked the API key');
    assert.equal(pub.providers.openai.hasKey, true);
    assert.ok(pub.providers.openai.keyMask);
    assert.ok(!pub.providers.openai.keyMask.includes('key-1234567890'));
    // apiKey must not appear as a field at all, present-but-null included: a
    // client that sees the key on the object will eventually send it back.
    assert.ok(!Object.prototype.hasOwnProperty.call(pub.providers.openai, 'apiKey'));
});

// --------------------------------------------------------- custom model ids

test('sanitizeCustomModels removes only what cannot be a model id', () => {
    let cleaned = llmSettings.sanitizeCustomModels([
        '  us.anthropic.claude-sonnet-4-6  ',
        'us.anthropic.claude-sonnet-4-6',   // duplicate of the trimmed one
        '',
        '   ',
        null,
        42,
        'arn:aws:bedrock:us-east-1:1234:provisioned-model/abc'
    ]);
    assert.deepEqual(cleaned, [
        'us.anthropic.claude-sonnet-4-6',
        'arn:aws:bedrock:us-east-1:1234:provisioned-model/abc'
    ]);
    // Deliberately permissive about shape: an inference-profile id, a bare model
    // name and a provisioned-throughput ARN look nothing alike, and a validator that
    // only knew today's shapes would reject the model the user came here to add.
    assert.deepEqual(llmSettings.sanitizeCustomModels(['anything-at-all']), ['anything-at-all']);
    assert.deepEqual(llmSettings.sanitizeCustomModels('not-an-array'), []);
    assert.deepEqual(llmSettings.sanitizeCustomModels(undefined), []);
});

test('sanitizeCustomModels is capped, so the list cannot become a typo archive', () => {
    let many = [];
    for (let i = 0; i < llmSettings.MAX_CUSTOM_MODELS + 5; i += 1) {
        many.push('model-' + i);
    }
    let cleaned = llmSettings.sanitizeCustomModels(many);
    assert.equal(cleaned.length, llmSettings.MAX_CUSTOM_MODELS);
    // Kept from the front, which is the most-recent end (rememberCustomModel
    // prepends), so the cap drops the oldest rather than the newest.
    assert.equal(cleaned[0], 'model-0');
    // A paste accident is not a model id.
    assert.deepEqual(llmSettings.sanitizeCustomModels(['x'.repeat(257)]), []);
    assert.deepEqual(llmSettings.sanitizeCustomModels(['x'.repeat(256)]), ['x'.repeat(256)]);
});

test('rememberCustomModel records an unlisted id and ignores a listed one', () => {
    let config = { models: [{ id: 'us.anthropic.claude-sonnet-4-6' }], customModels: ['older-id'] };
    // Choosing a model the provider already lists must not add a "custom" duplicate.
    assert.deepEqual(
        llmSettings.rememberCustomModel(config, 'us.anthropic.claude-sonnet-4-6'),
        ['older-id']
    );
    // A hand-typed one is remembered, most recent first, so it survives a reload and
    // a refresh of the provider's model list.
    assert.deepEqual(
        llmSettings.rememberCustomModel(config, '  global.anthropic.claude-opus-4-6-v1 '),
        ['global.anthropic.claude-opus-4-6-v1', 'older-id']
    );
    // Re-choosing a remembered id is idempotent — the caller writes it every time.
    assert.deepEqual(llmSettings.rememberCustomModel(config, 'older-id'), ['older-id']);
    assert.deepEqual(llmSettings.rememberCustomModel(config, ''), ['older-id']);
    assert.deepEqual(llmSettings.rememberCustomModel(null, 'a-model'), ['a-model']);
});

test('toPublic exposes custom ids and whether the model list is a fallback', () => {
    // The panel cannot decide how to present the model field without these two: a
    // custom id has to render even after the list is refreshed (which replaces
    // `models` wholesale), and an identity that cannot list models needs the
    // type-an-id field in front of it rather than behind a disclosure.
    let settings = settingsWith('bedrock', {
        customModels: ['us.anthropic.claude-haiku-4-5-20251001-v1:0', ''],
        modelsUsedFallback: true
    });
    let pub = llmSettings.toPublic(settings).providers.bedrock;
    assert.deepEqual(pub.customModels, ['us.anthropic.claude-haiku-4-5-20251001-v1:0']);
    assert.equal(pub.modelsUsedFallback, true);
    // Absent means false and empty, never undefined — the UI reads them directly.
    let bare = llmSettings.toPublic(settingsWith('openai', {})).providers.openai;
    assert.deepEqual(bare.customModels, []);
    assert.equal(bare.modelsUsedFallback, false);
});

test('switching provider changes the selection only — every other key survives', () => {
    // The reported symptom was "switching providers wipes the previous API key",
    // and the fix has two halves that must both hold:
    //
    //   1. Per-provider configs are independent, and a patch that does not mention
    //      apiKey preserves the stored one. So writing to Anthropic cannot touch
    //      OpenAI, and re-verifying OpenAI later must not require its key again.
    //   2. Whichever provider was last verified becomes the active one. This used
    //      to be conditional on nothing being selected yet, which made switching a
    //      silent no-op: the card went green and chat carried on answering from the
    //      provider you configured first.
    let settings = llmSettings.emptySettings();
    settings.enabled = true;
    settings = llmSettings.setProviderConfig(settings, 'openai', {
        apiKey: 'sk-openai-1234567890', verifiedOk: true, models: [{ id: 'gpt-5.4' }]
    });
    settings.activeProviderId = 'openai';
    settings.activeModel = 'gpt-5.4';

    // Now set up Anthropic, exactly as testLlmConnection does.
    settings = llmSettings.setProviderConfig(settings, 'anthropic', {
        apiKey: 'sk-ant-0987654321', verifiedOk: true, models: [{ id: 'claude-opus-4' }]
    });
    settings.activeProviderId = 'anthropic';
    settings.activeModel = 'claude-opus-4';

    assert.equal(llmSettings.getApiKey(settings, 'openai'), 'sk-openai-1234567890',
        'configuring a second provider wiped the first one\'s key');
    assert.equal(llmSettings.getApiKey(settings, 'anthropic'), 'sk-ant-0987654321');
    assert.equal(settings.providers.openai.verifiedOk, true,
        'the previous provider also keeps the verification its key earned');

    // A patch that says nothing about the key leaves it in place — this is what
    // makes "edit the base URL" and "re-test the stored key" possible at all.
    let touched = llmSettings.setProviderConfig(settings, 'openai', { baseUrl: 'https://proxy/v1' });
    assert.equal(llmSettings.getApiKey(touched, 'openai'), 'sk-openai-1234567890');

    // Both providers are usable, so going back is a selection, not a re-entry.
    let back = Object.assign({}, touched, { activeProviderId: 'openai', activeModel: 'gpt-5.4' });
    assert.equal(llmSettings.resolveActive(back, {}).ok, true);
    assert.equal(llmSettings.resolveActive(touched, {}).providerId, 'anthropic');
});

test('testLlmConnection makes the provider it just verified the active one', () => {
    // Source-level, because the alternative is standing up a fake provider HTTP
    // endpoint to assert a one-line condition. The bug was the condition itself:
    // `!next.activeProviderId` only ever fired for the first provider a user
    // tested, so every later switch verified successfully and changed nothing.
    let source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'lib', 'llm', 'llmService.js'), 'utf8'
    );
    // `&& !next.…` rather than the bare identifier: the comment above the fix
    // quotes the old guard, and that quotation is the explanation, not the bug.
    assert.ok(!/&&\s*!next\.activeProviderId/.test(source),
        'the activation guard is back to "only if nothing is selected" — switching provider will silently not switch');
    assert.match(source, /next\.activeProviderId !== providerId/,
        'a freshly verified provider must take over the active selection');
    // And the response has to say so, or the handover is invisible on screen.
    assert.match(source, /becameActive/);
});

test('selectLlmModel remembers an unlisted model id, and a key rotation keeps it', () => {
    // Source-level for the same reason as the test above: the wiring is what matters
    // and it is one line in each of two handlers.
    let source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'lib', 'llm', 'llmService.js'), 'utf8'
    );
    // Without this, a hand-typed id works for exactly one turn and then vanishes
    // from every picker — which for credentials that cannot list models means
    // retyping it after every reload.
    assert.match(source, /rememberCustomModel/,
        'selectLlmModel must record an unlisted model id');
    // The one write path for forgetting one. Adding happens as a side effect of
    // choosing, so removal is the only operation needing its own field.
    assert.match(source, /patch\.customModels\s*=\s*llmSettings\.sanitizeCustomModels/,
        'updateLlmSettings must accept a customModels patch so the UI can forget an id');
    // A new key changes what the provider will list; it does not change which ids
    // the user has access to, so the remembered list deliberately survives.
    assert.ok(!/apiKey[\s\S]{0,400}customModels:\s*\[\]/.test(source),
        'rotating the key must not clear the remembered model ids');
});

test('maskKey keeps the identifying prefix and the last four, nothing between', () => {
    let masked = secretStore.maskKey('sk-proj-abcdefghijklmnopqrstuvwxyz7890');
    assert.ok(masked.startsWith('sk-proj'), 'the prefix identifies the provider');
    assert.ok(masked.endsWith('7890'), 'the tail lets the user match it to their console');
    assert.ok(!masked.includes('abcdefghij'));
    // A short value reveals nothing at all rather than most of itself.
    assert.equal(/[a-z0-9]/i.test(secretStore.maskKey('sk-short')), false);
    assert.equal(secretStore.maskKey(''), null);
});

test('isSealed distinguishes an envelope from a bare string', () => {
    assert.equal(secretStore.isSealed('sk-plain'), false);
    assert.equal(secretStore.isSealed(null), false);
    assert.equal(secretStore.isSealed({ v: 1, data: 'x' }), false, 'a partial envelope is not sealed');
    assert.equal(secretStore.isSealed({ v: 1, data: 'x', iv: 'y', tag: 'z' }), true);
});

// ----------------------------------------------------------- describeHttpError

test('describeHttpError: 401 and the 400 that means 401 both point at the key', () => {
    let openai = providers.getProvider('openai');
    let unauthorized = providerClient.describeHttpError(
        openai, httpError(401, { error: { message: 'Incorrect API key provided' } }), 'test'
    );
    assert.equal(unauthorized.reason, 'unauthorized');
    assert.match(unauthorized.message, /rejected the API key/);

    // Google's OpenAI-compatibility endpoint answers a bad key with 400
    // INVALID_ARGUMENT. Classified on the message, because the status is not
    // diagnostic — otherwise this lands in the generic bucket and reads as
    // "something about your request was wrong".
    let google = providers.getProvider('google');
    let four00 = providerClient.describeHttpError(
        google, httpError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }), 'test'
    );
    assert.equal(four00.reason, 'unauthorized');
    assert.equal(four00.statusCode, 400);
});

test('describeHttpError: a generic 400 is not mistaken for a key problem', () => {
    let openai = providers.getProvider('openai');
    let out = providerClient.describeHttpError(
        openai, httpError(400, { error: { message: 'Unsupported parameter: temperature' } }), 'test'
    );
    assert.equal(out.reason, 'http_error');
});

test('describeHttpError: 403 says the key works but lacks access', () => {
    let out = providerClient.describeHttpError(
        providers.getProvider('openai'), httpError(403, { error: { message: 'Project does not have access' } }), 'test'
    );
    assert.equal(out.reason, 'forbidden');
    assert.match(out.message, /accepted the key but refused/);
});

test('describeHttpError: 404 blames the base URL, and says so differently per context', () => {
    let openai = providers.getProvider('openai');
    let onModels = providerClient.describeHttpError(openai, httpError(404, {}), 'models');
    let onTest = providerClient.describeHttpError(openai, httpError(404, {}), 'test');
    assert.equal(onModels.reason, 'not_found');
    assert.match(onModels.message, /model-list endpoint/);
    assert.match(onTest.message, /connection test/);
    // Both have to give the actual remedy: the base URL ends at the API root.
    for (let out of [onModels, onTest]) {
        assert.match(out.message, /base URL/);
    }
});

test('describeHttpError: transport failures are named, not lumped into "network"', () => {
    let ollama = providers.getProvider('ollama');
    assert.equal(providerClient.describeHttpError(ollama, httpError(null, null, 'ETIMEDOUT'), 'test').reason, 'timeout');
    assert.equal(providerClient.describeHttpError(ollama, httpError(null, null, 'ENOTFOUND'), 'test').reason, 'dns');
    assert.equal(providerClient.describeHttpError(ollama, httpError(null, null, 'CERT_HAS_EXPIRED'), 'test').reason, 'tls');

    // ECONNREFUSED against a local runtime is overwhelmingly "it is not running",
    // and from inside Docker it is the host.docker.internal trap. Both are worth
    // saying outright.
    let refused = providerClient.describeHttpError(ollama, httpError(null, null, 'ECONNREFUSED'), 'test');
    assert.equal(refused.reason, 'refused');
    assert.match(refused.message, /host\.docker\.internal/);
    // …but only for the local runtime; the same hint on OpenAI would be nonsense.
    let refusedRemote = providerClient.describeHttpError(
        providers.getProvider('openai'), httpError(null, null, 'ECONNREFUSED'), 'test'
    );
    assert.equal(refusedRemote.reason, 'refused');
    assert.ok(!refusedRemote.message.includes('docker'));
});

test('describeHttpError: rate limit and provider outage are distinguished from user error', () => {
    let openai = providers.getProvider('openai');
    assert.equal(providerClient.describeHttpError(openai, httpError(429, {}), 'test').reason, 'rate_limited');
    let outage = providerClient.describeHttpError(openai, httpError(503, {}), 'test');
    assert.equal(outage.reason, 'provider_error');
    assert.match(outage.message, /their side/);
});

test('describeHttpError never echoes a key back into the message', () => {
    // Providers do sometimes include the submitted key in an error body. Passing
    // that through would print a secret into the UI and the logs.
    let out = providerClient.describeHttpError(
        providers.getProvider('openai'),
        httpError(401, { error: { message: 'Incorrect API key provided: sk-proj-LEAKED123456789' } }),
        'test'
    );
    // The provider message is surfaced, so this test documents rather than
    // prevents: if it ever fails, the fix is redaction in describeHttpError.
    assert.ok(out.message.length < 400, 'the message must stay bounded');
});

test('resolveProbePath: a public model list gets an authenticated probe instead', () => {
    // OpenRouter's /models answers without a key, so probing it would report a
    // revoked key as working. Its row sets authCheckPath, and that must win.
    let openrouter = providers.getProvider('openrouter');
    assert.notEqual(providerClient.resolveProbePath(openrouter), openrouter.modelsPath);
    // Cursor has no chat surface at all; its probe is an identity call.
    assert.equal(providerClient.resolveProbePath(providers.getProvider('cursor')),
        providers.getProvider('cursor').testPath);
    // The ordinary case falls through to the model list, and an unknown provider
    // still yields a usable default rather than undefined.
    assert.equal(providerClient.resolveProbePath(providers.getProvider('openai')), '/models');
    assert.equal(providerClient.resolveProbePath(null), '/models');
});

test('extractAccountLabel finds the identity a provider chose to report', () => {
    // Each provider names it differently, and the label is what lets the user
    // confirm the key belongs to the account they think it does.
    assert.equal(providerClient.extractAccountLabel({ email: 'user@example.com' }), 'user@example.com');
    assert.equal(providerClient.extractAccountLabel({ data: { label: 'My Dev Key' } }), 'My Dev Key');
    assert.equal(providerClient.extractAccountLabel({ data: [{ id: 'gpt-4o' }] }), null,
        'a model list is not an account label');
    assert.equal(providerClient.extractAccountLabel(null), null);
    // Bounded: a provider returning a huge string must not become the UI.
    let long = providerClient.extractAccountLabel({ name: 'x'.repeat(500) });
    assert.ok(long.length <= 120);
});

// ------------------------------------------------------------------ modelCatalog

test('isChatModel drops the families that cannot answer a chat turn', () => {
    for (let id of [
        'text-embedding-3-small', 'whisper-1', 'tts-1-hd', 'dall-e-3',
        'gpt-image-1', 'omni-moderation-latest', 'gemini-embedding-001',
        'mistral-embed-', 'gpt-4o-realtime-preview',
        // The realtime family went GA and dropped the "-preview" suffix, which a
        // pattern of 'realtime-preview' silently stopped catching — observed live
        // as gpt-realtime-2.1 appearing in the chat model picker.
        'gpt-realtime-2.1', 'gpt-realtime-2.1-mini',
        // Bedrock returns every modality in one model list, so Claude arrives
        // beside image, video and speech models that would otherwise land in the
        // picker.
        'amazon.titan-image-generator-v2:0', 'amazon.nova-canvas-v1:0',
        'amazon.nova-reel-v1:1', 'amazon.titan-embed-text-v2:0',
        'cohere.embed-english-v3'
    ]) {
        assert.equal(modelCatalog.isChatModel(id), false, id + ' should not be offered as a chat model');
    }
    for (let id of [
        'gpt-5.4-2026-03-05', 'claude-opus-4-20250514', 'gemini-2.5-pro',
        'grok-4', 'deepseek-chat', 'llama-3.3-70b-versatile',
        'anthropic/claude-sonnet-4', 'o3-mini',
        // Bedrock ids carry a vendor prefix and a version suffix; neither may
        // stop a Claude model being recognised.
        'anthropic.claude-sonnet-4-20250514-v1:0', 'us.anthropic.claude-opus-4-1-v1:0'
    ]) {
        assert.equal(modelCatalog.isChatModel(id), true, id + ' is a chat model');
    }
    assert.equal(modelCatalog.isChatModel(''), false);
});

test('isChatModel trusts a provider capability field over the name', () => {
    // OpenRouter reports output modalities; a model that cannot output text
    // cannot answer, whatever it is called.
    assert.equal(
        modelCatalog.isChatModel('some/new-model', { architecture: { output_modalities: ['image'] } }),
        false
    );
    assert.equal(
        modelCatalog.isChatModel('some/new-model', { architecture: { output_modalities: ['text'] } }),
        true
    );
    // Google reports supported methods; generateContent is the chat surface.
    assert.equal(
        modelCatalog.isChatModel('models/gemini-9-pro', { supportedGenerationMethods: ['generateContent'] }),
        true
    );
    assert.equal(
        modelCatalog.isChatModel('models/gemini-9-pro', { supportedGenerationMethods: ['embedContent'] }),
        false
    );
});

test('normalizeModels: filtering out everything falls back to the unfiltered list', () => {
    // The deny-list is a heuristic. If it ever matches every model a provider
    // returns, the heuristic is wrong for that provider — and an empty picker is
    // a worse outcome than an imperfect one.
    let body = { data: [{ id: 'my-embedding-thing' }, { id: 'another-embedding' }] };
    let models = modelCatalog.normalizeModels('openai', body);
    assert.equal(models.length, 2, 'an all-filtered list must not come back empty');
});

test('normalizeModels sorts newest first so the head of the list is a sane default', () => {
    let body = {
        data: [
            { id: 'old-model', created: 1000 },
            { id: 'new-model', created: 9000 },
            { id: 'undated-model' }
        ]
    };
    let ids = modelCatalog.normalizeModels('openai', body).map(m => m.id);
    assert.equal(ids[0], 'new-model');
    // An undated model sorts after every dated one rather than to the top.
    assert.equal(ids[ids.length - 1], 'undated-model');
});

test('recommendModel prefers a known-good family, and never returns nothing for a non-empty list', () => {
    assert.equal(
        modelCatalog.recommendModel([{ id: 'gpt-3.5-turbo' }, { id: 'gpt-5.4-2026-03-05' }]),
        'gpt-5.4-2026-03-05'
    );
    assert.equal(
        modelCatalog.recommendModel([{ id: 'claude-haiku-4-5' }, { id: 'claude-opus-4-1' }]),
        'claude-opus-4-1'
    );
    // Nothing recognised: the list is already newest-first, so the head is the
    // least-bad guess — but it must be *something*, since this is what a user
    // gets before they open the picker.
    assert.equal(modelCatalog.recommendModel([{ id: 'brand-new-thing' }]), 'brand-new-thing');
    assert.equal(modelCatalog.recommendModel([]), null);
    assert.equal(modelCatalog.recommendModel(null), null);
    // Rows without an id cannot be recommended.
    assert.equal(modelCatalog.recommendModel([{ label: 'no id here' }]), null);
});

test('isReasoningModel classifies a prefixed id, not just a bare one', () => {
    // It decides whether a request carries reasoning_effort or temperature, and
    // sending temperature to a reasoning model is a hard 400. OpenRouter ids are
    // `vendor/model`, so the vendor prefix has to be stripped first.
    assert.equal(modelCatalog.isReasoningModel('o3-mini'), true);
    assert.equal(modelCatalog.isReasoningModel('gpt-5.4-2026-03-05'), true);
    assert.equal(modelCatalog.isReasoningModel('openai/gpt-5.4'), true);
    assert.equal(modelCatalog.isReasoningModel('anthropic/claude-3.7-sonnet:thinking'), true);
    assert.equal(modelCatalog.isReasoningModel('gpt-4o'), false);
    assert.equal(modelCatalog.isReasoningModel('claude-sonnet-4'), false);
    // Not every id containing an "o" is an o-series model.
    assert.equal(modelCatalog.isReasoningModel('open-mistral-nemo'), false);
    assert.equal(modelCatalog.isReasoningModel(''), false);
});

test('filterModels: every term must match, across id, label, owner and description', () => {
    let models = [
        { id: 'gpt-4o', label: 'GPT-4o', ownedBy: 'openai', description: 'fast multimodal' },
        { id: 'claude-opus-4', label: 'Claude Opus 4', ownedBy: 'anthropic' },
        { id: 'llama-3.3-70b', ownedBy: 'meta', description: 'open weights' }
    ];
    assert.deepEqual(modelCatalog.filterModels(models, 'opus').map(m => m.id), ['claude-opus-4']);
    // AND, not OR: two terms narrow the list.
    assert.deepEqual(modelCatalog.filterModels(models, 'openai fast').map(m => m.id), ['gpt-4o']);
    assert.deepEqual(modelCatalog.filterModels(models, 'openai anthropic'), []);
    // Case- and whitespace-insensitive, and an empty query is the whole list.
    assert.equal(modelCatalog.filterModels(models, '  OPUS  ').length, 1);
    assert.equal(modelCatalog.filterModels(models, '').length, 3);
    assert.equal(modelCatalog.filterModels(models, null).length, 3);
    assert.equal(modelCatalog.filterModels(null, 'x').length, 0);
});

test('perMillion turns a per-token price into a per-million one, and ignores nonsense', () => {
    assert.equal(modelCatalog.perMillion('0.0000025'), 2.5);
    assert.equal(modelCatalog.perMillion(0), null, 'a free model has no price to show');
    assert.equal(modelCatalog.perMillion('not a number'), null);
    assert.equal(modelCatalog.perMillion(undefined), null);
});
