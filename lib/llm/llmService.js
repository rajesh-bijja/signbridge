"use strict";

/**
 * llmService.js — the Express layer for LLM configuration.
 *
 *   registry (providers.js)
 *        |
 *   settings (llmSettings.js) --seal--> secretStore.js
 *        |
 *        +-- providerClient.js  (validate a key, list models)
 *
 * The contract with the frontend, which the rest of the design depends on:
 *
 *   - **SignBridge never obtains a provider key on the user's behalf.** There is
 *     no OAuth broker and no "mint a key from your admin key" endpoint here;
 *     both existed and were removed. Every provider works the same way: paste a
 *     key, or follow the provider's link, create one there and come back. See
 *     the ACQUISITION comment in providers.js for the reasoning.
 *
 *   - **A key goes up, never down.** Every response about settings is built by
 *     `llmSettings.toPublic()`, which carries a mask and never a key. So the
 *     Settings page cannot leak a key into a screenshot, a browser devtools
 *     panel, or a client-side error report — and a client that wants to save an
 *     unrelated field simply omits `apiKey` rather than round-tripping the secret.
 *   - **Verification is stored, not recomputed.** Testing a key records
 *     `verifiedOk`/`verifiedAt`/`accountLabel` and the model list, so the Settings
 *     page and the chat model picker both render instantly from disk. A test is a
 *     user action, not a page load.
 *   - **A successful test fetches models in the same call.** The user's stated
 *     flow is "if it passes then show the list of models" — two round trips with a
 *     spinner between them is a worse version of the same thing.
 *   - **Selecting a model anywhere persists here.** That is what makes the picker
 *     in Chat and Sandbox and the choice in Settings the same setting rather than
 *     three that drift.
 */

let authConfig = require('../authConfig');
let providers = require('./providers');
let llmSettings = require('./llmSettings');
let providerClient = require('./providerClient');
let modelCatalog = require('./modelCatalog');

function resolveUser(req) {
    let body = (req && req.body) || {};
    let options = body.options || {};
    return options.userName || body.userName || authConfig.resolveUserName();
}

function bodyOf(req) {
    let body = (req && req.body) || {};
    return body.options && typeof body.options === 'object' ? body.options : body;
}

function fail(res, status, message, extra) {
    return res.status(status).json(Object.assign({ success: false, message: message }, extra || {}));
}

// The registry, minus anything only the server needs. The frontend keeps its own
// mirror for labels and ordering; this endpoint is what lets it show provider
// notes and acquisition capabilities without duplicating the prose.
function publicProvider(provider) {
    return {
        id: provider.id,
        label: provider.label,
        inference: provider.inference !== false,
        inferenceNote: provider.inferenceNote || null,
        // Set only for a provider answered by a module rather than an
        // OpenAI-compatible endpoint. The UI uses it to show how that provider
        // works and what it requires *before* the user commits to it — the two
        // things Cursor does differently (a CLI on the server, forced tool
        // approval) are not guessable from a key field.
        chatBackend: provider.chatBackend || null,
        backendNote: provider.backendNote || null,
        keyless: !!provider.keyless,
        keyPlaceholder: provider.keyPlaceholder || '',
        baseUrl: provider.baseUrl || '',
        baseUrlRequired: !!provider.baseUrlRequired,
        baseUrlEditable: !!(provider.baseUrlEditable || provider.baseUrlRequired),
        baseUrlPlaceholder: provider.baseUrlPlaceholder || '',
        consoleUrl: provider.consoleUrl || '',
        signInUrl: provider.signInUrl || '',
        acquisition: provider.acquisition,
        acquisitionNote: provider.acquisitionNote || null,
        docsNote: provider.docsNote || null,
        modelsPublic: !!provider.modelsPublic,
        // How this provider authenticates. Every row but Bedrock offers exactly
        // one source, and the panel renders no choice in that case — a radio group
        // with one option is noise. Bedrock offers signing with one of the user's
        // own AWS profiles, which needs a region as well.
        credentialSources: providers.listCredentialSources(provider),
        defaultCredentialSource: providers.resolveCredentialSource(provider, {}),
        awsRegionDefault: provider.awsRegionDefault || ''
    };
}

/**
 * The resolved "what will actually answer" summary, safe to send to a client.
 *
 * Every response that carries `settings` carries this too (see
 * respondWithSettings), because the clients fold both out of whatever came back:
 * a write that returned settings but not `active` left the Settings panel and the
 * model chip showing "no provider configured" immediately after a successful
 * test, and the only way to learn otherwise was another round trip.
 */
function publicActive(settings) {
    let active = llmSettings.resolveActive(settings);
    return {
        ok: !!active.ok,
        source: active.source || null,
        providerId: active.providerId || null,
        providerLabel: active.provider ? active.provider.label : null,
        model: active.model || null,
        reason: active.reason || null,
        message: active.message || null,
        // How this turn will authenticate. Carried because "which identity is
        // answering my chat?" otherwise has no answer anywhere in the UI, and for a
        // provider signed with a profile that is the most important fact about it.
        // Never a secret: a profile name and a region, or the string 'api_key'.
        credentialSource: active.credentialSource || null,
        awsProfileName: active.awsProfileName || null,
        awsRegion: active.awsRegion || null
    };
}

/**
 * Preflight the module that answers turns for this provider, if it has one.
 *
 * cb(backendStatus | null) — never an error, and never blocks the caller's own
 * work: "the Cursor CLI is not installed" is a normal, reportable state (the same
 * contract sandboxRunner.preflight has for a missing Docker socket), not a failed
 * request. The require is lazy so the LLM layer does not pull in the chat layer
 * for the eleven providers that have no backend.
 */
function checkChatBackend(provider, cbOnce) {
    // One-shot, because the continuation of this callback is the entire connection
    // test and its res.json(). A backend whose preflight called back twice used to
    // take the process down with ERR_HTTP_HEADERS_SENT (see runCli in
    // lib/chat/cursorAgent.js); that bug is fixed at the source, but a response is
    // not something to leave to the good behaviour of a subprocess wrapper.
    let answered = false;
    function cb(status) {
        if (answered) {
            return;
        }
        answered = true;
        return cbOnce(status);
    }

    let backendId = providers.getChatBackend(provider);
    if (!backendId) {
        return cb(null);
    }
    let backend;
    try {
        backend = require('../chat/cursorAgent');
    } catch (e) {
        return cb({
            ok: false,
            backend: backendId,
            message: 'This build does not have the "' + backendId + '" chat backend: ' + e.message
        });
    }
    // Test connection is the one place the cache must not answer: the reason
    // someone presses it again is that they just installed the missing CLI.
    backend.invalidatePreflight();
    return backend.preflight(function (err, status) {
        if (err) {
            return cb({ ok: false, backend: backendId, message: err.message });
        }
        return cb(status);
    });
}

function respondWithSettings(res, settings, extra) {
    return res.status(200).json(Object.assign({
        success: true,
        settings: llmSettings.toPublic(settings),
        active: publicActive(settings)
    }, extra || {}));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function getLlmProviders(req, res) {
    return res.status(200).json({
        success: true,
        providers: providers.listProviders().map(publicProvider)
    });
}

/**
 * Everything the Settings page and the model picker need in one call: the
 * registry, the saved settings, and — importantly — the *resolved* state. That
 * last part is why `active` is here: "why can't chat answer?" and "which model
 * would this turn use?" both have to be answerable from the UI without a second
 * round trip, and `resolveActive` is the only thing that knows.
 */
function getLlmSettings(req, res) {
    let userName = resolveUser(req);
    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return fail(res, 500, 'Could not read the LLM settings: ' + err.message);
        }
        return respondWithSettings(res, settings, {
            providers: providers.listProviders().map(publicProvider)
        });
    });
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Update settings.
 *
 * Everything is optional and only supplied fields are touched, because this one
 * endpoint serves the Enable toggle, the key field, the base-URL field and the
 * model picker — and a PUT-style whole-object save would let the model picker
 * silently clear a key it never received.
 */
// The non-secret provider fields that say how to authenticate: which source, and
// for the AWS-profile source which profile, mechanism and region. Listed once so
// the update handler, the test handler and the public shape cannot drift.
const AWS_CONFIG_FIELDS = ['credentialSource', 'awsProfileName', 'awsAuthnMode', 'awsRegion'];

function updateLlmSettings(req, res) {
    let userName = resolveUser(req);
    let body = bodyOf(req);
    let providerId = body.providerId ? String(body.providerId).trim() : '';

    if (providerId && !providers.isKnownProvider(providerId)) {
        return fail(res, 400, 'Unknown LLM provider "' + providerId + '".');
    }

    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return fail(res, 500, 'Could not read the LLM settings: ' + err.message);
        }
        let next = settings;

        // The master switch, and the only one there is: resolveActive reads this
        // value, so turning it off here stops the next turn with no restart and
        // nothing in a config file or the environment can override it.
        if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
            next = Object.assign({}, next, { enabled: !!body.enabled });
        }

        // The agent's behavioural knobs. Same optional-field pattern as everything
        // else here, and sanitised by llmSettings rather than validated inline: a
        // clamp stores something usable, whereas a 400 leaves the user with a
        // Settings page that will not save.
        if (Object.prototype.hasOwnProperty.call(body, 'reasoningEffort')) {
            next = Object.assign({}, next, {
                reasoningEffort: llmSettings.sanitizeReasoningEffort(body.reasoningEffort)
            });
        }
        if (Object.prototype.hasOwnProperty.call(body, 'temperature')) {
            next = Object.assign({}, next, {
                temperature: llmSettings.sanitizeTemperature(body.temperature)
            });
        }
        if (Object.prototype.hasOwnProperty.call(body, 'maxToolIterations')) {
            next = Object.assign({}, next, {
                maxToolIterations: llmSettings.sanitizeMaxToolIterations(body.maxToolIterations)
            });
        }

        if (providerId) {
            let patch = {};
            if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
                patch.apiKey = body.apiKey === null ? '' : String(body.apiKey).trim();
                // A new key has not been tested yet, and showing a stale green
                // tick beside an untested key is exactly the lie this feature is
                // meant to remove.
                patch.verifiedOk = false;
                patch.verifiedAt = null;
                patch.verifiedError = null;
                patch.models = [];
                patch.modelsFetchedAt = null;
                patch.modelsUsedFallback = false;
                patch.accountLabel = null;
                // customModels deliberately survives: the ids the user typed are
                // theirs, and a rotated key is no reason to make them type again.
            }
            if (Object.prototype.hasOwnProperty.call(body, 'baseUrl')) {
                patch.baseUrl = String(body.baseUrl || '').trim();
            }
            // The remembered hand-typed model ids, sent whole. This is how the UI
            // forgets one: a custom id is added by *using* it (selectLlmModel), so
            // removal is the only operation that needs its own way in, and sending
            // the list the user wants to keep is simpler on both sides than a
            // delete-one route whose only caller is a token's × button.
            if (Object.prototype.hasOwnProperty.call(body, 'customModels')) {
                patch.customModels = llmSettings.sanitizeCustomModels(body.customModels);
            }
            for (let field of AWS_CONFIG_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(body, field)) {
                    patch[field] = String(body[field] || '').trim();
                }
            }
            // Changing how a provider authenticates invalidates the verification
            // the *previous* way earned — a profile that works says nothing about
            // an API key, and vice versa. The stored key is deliberately left
            // alone: switching to a profile and back should not mean re-entering
            // it, the same principle as switching provider.
            if (Object.prototype.hasOwnProperty.call(body, 'credentialSource') ||
                Object.prototype.hasOwnProperty.call(body, 'awsProfileName') ||
                Object.prototype.hasOwnProperty.call(body, 'awsRegion')) {
                patch.verifiedOk = false;
                patch.verifiedAt = null;
                patch.verifiedError = null;
            }
            if (Object.keys(patch).length) {
                next = llmSettings.setProviderConfig(next, providerId, patch);
            }
        }

        // Choosing the active provider/model. `activeProviderId: null` clears it,
        // which leaves the install with no provider chosen — resolveActive then
        // reports `not_configured` and the UI says so. There is nothing to fall
        // back to, deliberately.
        if (Object.prototype.hasOwnProperty.call(body, 'activeProviderId')) {
            let active = body.activeProviderId ? String(body.activeProviderId).trim() : null;
            if (active && !providers.isKnownProvider(active)) {
                return fail(res, 400, 'Unknown LLM provider "' + active + '".');
            }
            let activeProvider = active ? providers.getProvider(active) : null;
            if (activeProvider && activeProvider.inference === false) {
                return fail(res, 400, activeProvider.label + ' cannot be used for chat. ' +
                    (activeProvider.inferenceNote || ''));
            }
            next = Object.assign({}, next, { activeProviderId: active });
            // Switching provider must not leave the previous provider's model id
            // selected — it would be sent to an API that has never heard of it.
            if (active !== settings.activeProviderId &&
                !Object.prototype.hasOwnProperty.call(body, 'activeModel')) {
                let activeConfig = llmSettings.getProviderConfig(next, active) || {};
                next = Object.assign({}, next, {
                    activeModel: modelCatalog.recommendModel(activeConfig.models || [])
                });
            }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'activeModel')) {
            next = Object.assign({}, next, {
                activeModel: body.activeModel ? String(body.activeModel).trim() : null
            });
        }

        llmSettings.save(userName, next, function (saveErr, saved) {
            if (saveErr) {
                return fail(res, 500, 'Could not save the LLM settings: ' + saveErr.message);
            }
            return respondWithSettings(res, saved);
        });
    });
}

/**
 * Select the provider+model to use, from anywhere in the app.
 *
 * A thin, intention-named wrapper over the same storage, because the Cursor-style
 * picker in Chat and Sandbox should not have to know the shape of the settings
 * document — and because "the model I picked in Chat is now what Settings shows"
 * is a requirement, not a side effect.
 */
function selectLlmModel(req, res) {
    let userName = resolveUser(req);
    let body = bodyOf(req);
    let model = body.model ? String(body.model).trim() : '';
    let providerId = body.providerId ? String(body.providerId).trim() : '';

    if (!model) {
        return fail(res, 400, 'No model was supplied.');
    }
    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return fail(res, 500, 'Could not read the LLM settings: ' + err.message);
        }
        let targetProviderId = providerId || settings.activeProviderId;
        if (!targetProviderId) {
            return fail(res, 400, 'Choose a provider before selecting a model.');
        }
        let provider = providers.getProvider(targetProviderId);
        if (!provider) {
            return fail(res, 400, 'Unknown LLM provider "' + targetProviderId + '".');
        }
        if (provider.inference === false) {
            return fail(res, 400, provider.label + ' cannot be used for chat. ' +
                (provider.inferenceNote || ''));
        }
        // A model the provider does not list is not an error: an identity that
        // cannot list models (a least-privilege Bedrock role) can still invoke them,
        // and a brand-new model is nobody's list until it is. So the id is accepted
        // and *remembered*, which is what stops the user retyping it after every
        // reload and every model-list refresh.
        let config = llmSettings.getProviderConfig(settings, targetProviderId) || {};
        let next = llmSettings.setProviderConfig(settings, targetProviderId, {
            customModels: llmSettings.rememberCustomModel(config, model)
        });
        next = Object.assign({}, next, {
            enabled: true,
            activeProviderId: targetProviderId,
            activeModel: model
        });
        llmSettings.save(userName, next, function (saveErr, saved) {
            if (saveErr) {
                return fail(res, 500, 'Could not save the model selection: ' + saveErr.message);
            }
            return respondWithSettings(res, saved, {
                providerId: targetProviderId,
                providerLabel: provider.label,
                model: model
            });
        });
    });
}

function deleteLlmKey(req, res) {
    let userName = resolveUser(req);
    let body = bodyOf(req);
    let providerId = body.providerId ? String(body.providerId).trim() : '';
    if (!providers.isKnownProvider(providerId)) {
        return fail(res, 400, 'Unknown LLM provider "' + providerId + '".');
    }
    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return fail(res, 500, 'Could not read the LLM settings: ' + err.message);
        }
        let next = llmSettings.setProviderConfig(settings, providerId, {
            apiKey: '',
            models: [],
            modelsFetchedAt: null,
            modelsUsedFallback: false,
            accountLabel: null,
            verifiedError: null
        });
        // Removing the key of the provider currently in use must also stand the
        // selection down, or chat would keep pointing at a provider it can no
        // longer authenticate to.
        if (next.activeProviderId === providerId) {
            next = Object.assign({}, next, { activeProviderId: null, activeModel: null });
        }
        llmSettings.save(userName, next, function (saveErr, saved) {
            if (saveErr) {
                return fail(res, 500, 'Could not remove the key: ' + saveErr.message);
            }
            return respondWithSettings(res, saved);
        });
    });
}

// ---------------------------------------------------------------------------
// Test + models
// ---------------------------------------------------------------------------

// Resolve the key to test with: an unsaved one from the request (so the user can
// test before committing), else the stored one.
function keyForRequest(settings, providerId, body) {
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey') && body.apiKey) {
        return String(body.apiKey).trim();
    }
    return llmSettings.getApiKey(settings, providerId);
}

// The configuration a test/list request should run against: whatever the request
// supplied, falling back to what is stored. `userName` rides along because a
// profile-signed provider (Bedrock) has to know whose profiles to read, and this
// object is never persisted — the patches written on success are built separately.
function configForRequest(settings, providerId, body, userName) {
    let stored = llmSettings.getProviderConfig(settings, providerId) || {};
    let baseUrl = Object.prototype.hasOwnProperty.call(body, 'baseUrl')
        ? String(body.baseUrl || '').trim()
        : (stored.baseUrl || '');
    let config = {
        apiKey: keyForRequest(settings, providerId, body),
        baseUrl: baseUrl,
        userName: userName
    };
    // Testing before saving has to work for these too, or choosing a profile and
    // pressing Test would silently test the previously saved one.
    for (let field of AWS_CONFIG_FIELDS) {
        config[field] = Object.prototype.hasOwnProperty.call(body, field)
            ? String(body[field] || '').trim()
            : (stored[field] || '');
    }
    return config;
}

/**
 * Test a key and, on success, fetch the models it can use — then persist all of
 * it, including the key if one was supplied inline.
 *
 * Persisting on success is the point: the user's next action is choosing a model,
 * and making them press Save first is a step that exists only because the code
 * was easier to write that way.
 */
function testLlmConnection(req, res) {
    let userName = resolveUser(req);
    let body = bodyOf(req);
    let providerId = body.providerId ? String(body.providerId).trim() : '';
    let provider = providers.getProvider(providerId);
    if (!provider) {
        return fail(res, 400, 'Unknown LLM provider "' + providerId + '".');
    }

    // A provider with a chatBackend has a second thing that can be broken, and a
    // valid key says nothing about it: for Cursor the turn is answered by a CLI
    // that has to be installed on this server. Checking it here is the difference
    // between learning that in Settings, next to the button you pressed, and
    // learning it when your first chat message fails.
    return checkChatBackend(provider, function (backendStatus) {
        return runConnectionTest(res, {
            userName: userName,
            body: body,
            providerId: providerId,
            provider: provider,
            backendStatus: backendStatus
        });
    });
}

// A test that passed with a profile the user had only just chosen must save that
// choice, or the green tick describes a configuration the next chat turn will not
// use. Same principle as persisting the key that was tested.
function applyTestedAwsFields(patch, body, config) {
    for (let field of AWS_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
            patch[field] = config[field];
        }
    }
    return patch;
}

function runConnectionTest(res, ctx) {
    let userName = ctx.userName;
    let body = ctx.body;
    let providerId = ctx.providerId;
    let provider = ctx.provider;
    let backendStatus = ctx.backendStatus;

    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return fail(res, 500, 'Could not read the LLM settings: ' + err.message);
        }
        let config = configForRequest(settings, providerId, body, userName);
        let suppliedKey = Object.prototype.hasOwnProperty.call(body, 'apiKey') && body.apiKey
            ? String(body.apiKey).trim() : null;

        providerClient.testConnection(provider, config, function (testErr, testResult) {
            if (testErr) {
                return fail(res, 500, 'The connection test failed: ' + testErr.message);
            }
            if (!testResult.ok) {
                // Record the failure so the page still explains itself after a
                // reload, and keep the key the user typed — deleting it because
                // it failed once would be hostile when the cause is a typo'd
                // base URL or an expired network.
                let patch = {
                    verifiedOk: false,
                    verifiedAt: new Date().toISOString(),
                    verifiedError: testResult.message,
                    backendStatus: backendStatus
                };
                if (suppliedKey) {
                    patch.apiKey = suppliedKey;
                }
                if (Object.prototype.hasOwnProperty.call(body, 'baseUrl')) {
                    patch.baseUrl = config.baseUrl;
                }
                applyTestedAwsFields(patch, body, config);
                let failed = llmSettings.setProviderConfig(settings, providerId, patch);
                return llmSettings.save(userName, failed, function () {
                    return res.status(200).json({
                        success: false,
                        verified: false,
                        providerId: providerId,
                        reason: testResult.reason,
                        statusCode: testResult.statusCode || null,
                        message: testResult.message,
                        backendStatus: backendStatus,
                        settings: llmSettings.toPublic(failed),
                        active: publicActive(failed)
                    });
                });
            }

            providerClient.listModels(provider, config, function (modelsErr, modelsResult) {
                let models = (modelsResult && modelsResult.ok) ? modelsResult.models : [];
                let patch = {
                    verifiedOk: true,
                    verifiedAt: new Date().toISOString(),
                    verifiedError: null,
                    accountLabel: testResult.accountLabel || null,
                    models: models,
                    modelsFetchedAt: (modelsResult && modelsResult.fetchedAt) || null,
                    // Whether that list is the account's own or the curated
                    // fallback. Persisted, not just reported, because the Settings
                    // page has to know it after a reload to keep the
                    // custom-model-id field in front of an identity that cannot
                    // list — otherwise the one control that user needs is hidden
                    // from exactly them.
                    modelsUsedFallback: !!(modelsResult && modelsResult.usedFallback),
                    backendStatus: backendStatus
                };
                if (suppliedKey) {
                    patch.apiKey = suppliedKey;
                }
                if (Object.prototype.hasOwnProperty.call(body, 'baseUrl')) {
                    patch.baseUrl = config.baseUrl;
                }
                applyTestedAwsFields(patch, body, config);
                let next = llmSettings.setProviderConfig(settings, providerId, patch);

                /**
                 * A provider that just verified becomes the one chat uses.
                 *
                 * This used to be conditional on nothing being selected yet
                 * (`!next.activeProviderId`), which made switching provider a
                 * two-step nobody could see: you pasted an Anthropic key, it
                 * verified, the card went green — and chat carried on talking to
                 * OpenAI, because the *first* provider you ever tested was still
                 * the active one. The user's expectation is the obvious one: the
                 * provider I just set up is the provider that answers.
                 *
                 * The switch is a switch of *selection only*. Every other
                 * provider keeps its sealed key, its verification and its model
                 * list (setProviderConfig writes one provider's entry and leaves
                 * the rest untouched), so going back to a previous provider is
                 * picking it again — never re-entering its key.
                 */
                let becameActive = false;
                if (provider.inference !== false && next.activeProviderId !== providerId) {
                    next = Object.assign({}, next, {
                        enabled: true,
                        activeProviderId: providerId,
                        activeModel: modelCatalog.recommendModel(models)
                    });
                    becameActive = true;
                } else if (next.activeProviderId === providerId && !next.activeModel) {
                    next = Object.assign({}, next, {
                        activeModel: modelCatalog.recommendModel(models)
                    });
                }

                llmSettings.save(userName, next, function (saveErr, saved) {
                    if (saveErr) {
                        return fail(res, 500, 'The key was verified but could not be saved: ' +
                            saveErr.message);
                    }
                    return res.status(200).json({
                        success: true,
                        verified: true,
                        providerId: providerId,
                        providerLabel: provider.label,
                        accountLabel: testResult.accountLabel || null,
                        details: testResult.details || null,
                        warning: testResult.warning || null,
                        // The key is good; this says whether the thing that
                        // answers turns is present. Reported separately so a
                        // missing CLI does not read as a rejected key.
                        backendStatus: backendStatus,
                        models: models,
                        modelCount: models.length,
                        modelsUsedFallback: !!(modelsResult && modelsResult.usedFallback),
                        // A verified key whose model list failed is a real state:
                        // say so rather than showing an empty picker.
                        modelsError: (modelsResult && !modelsResult.ok) ? modelsResult.message : null,
                        recommendedModel: modelCatalog.recommendModel(models),
                        becameActive: becameActive,
                        settings: llmSettings.toPublic(saved),
                        active: publicActive(saved)
                    });
                });
            });
        });
    });
}

/**
 * Refresh the model list. Separate from the test because providers add models
 * weekly and re-verifying a key that already works is the wrong thing to make
 * someone do to see them.
 */
function listLlmModels(req, res) {
    let userName = resolveUser(req);
    let body = bodyOf(req);
    let providerId = body.providerId ? String(body.providerId).trim() : '';
    let provider = providers.getProvider(providerId);
    if (!provider) {
        return fail(res, 400, 'Unknown LLM provider "' + providerId + '".');
    }
    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return fail(res, 500, 'Could not read the LLM settings: ' + err.message);
        }
        let config = configForRequest(settings, providerId, body, userName);
        providerClient.listModels(provider, config, function (modelsErr, result) {
            if (modelsErr) {
                return fail(res, 500, 'Could not list models: ' + modelsErr.message);
            }
            if (!result.ok) {
                return res.status(200).json({
                    success: false,
                    providerId: providerId,
                    reason: result.reason,
                    message: result.message
                });
            }
            let next = llmSettings.setProviderConfig(settings, providerId, {
                models: result.models,
                modelsFetchedAt: result.fetchedAt,
                modelsUsedFallback: !!result.usedFallback
            });
            llmSettings.save(userName, next, function () {
                return res.status(200).json({
                    success: true,
                    providerId: providerId,
                    models: result.models,
                    modelCount: result.models.length,
                    modelsUsedFallback: !!result.usedFallback,
                    fetchedAt: result.fetchedAt,
                    recommendedModel: modelCatalog.recommendModel(result.models),
                    settings: llmSettings.toPublic(next),
                    active: publicActive(next)
                });
            });
        });
    });
}


module.exports = {
    publicProvider: publicProvider,
    getLlmProviders: getLlmProviders,
    getLlmSettings: getLlmSettings,
    updateLlmSettings: updateLlmSettings,
    selectLlmModel: selectLlmModel,
    deleteLlmKey: deleteLlmKey,
    testLlmConnection: testLlmConnection,
    listLlmModels: listLlmModels
};
