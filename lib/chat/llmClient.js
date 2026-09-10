"use strict";

/**
 * llmClient.js — resolve the LLM to use for a request, and hand back a client.
 *
 * This used to be a config reader: one model from config.properties, one key from
 * the process environment, one cached OpenAI client for the life of the process. It
 * is now per-user and per-request, because the provider, key and model are settings
 * the user changes in the UI while the server is running — and a process-lifetime
 * cache would serve the old provider until a restart.
 *
 * What did *not* change: everything speaks the OpenAI wire format. Anthropic and
 * Google both publish OpenAI-compatible endpoints, and the rest of the field
 * standardised on it, so switching provider is a base URL and a key rather than a
 * second implementation of tool calling. See lib/llm/providers.js.
 *
 * Bedrock is the one provider that is not an OpenAI-shaped endpoint yet still runs
 * the loop here: Claude on Bedrock is only reachable through the native Converse
 * API, so `lib/llm/bedrockConverse.js` presents Converse *as* an OpenAI client and
 * this module hands that back instead of the SDK's. That is deliberately not a
 * `chatBackend` — Converse has first-class tool use, so the agent, the streaming
 * emitter and the thread store all work unchanged, whereas a backend would mean a
 * second copy of the tool loop. Its credentials come from a SignBridge profile
 * (IAM / SSO / EC2 instance role / EKS IRSA), resolved per request so short-lived
 * ones refresh mid-conversation.
 *
 * *Everything* about the LLM comes from the user's stored settings and nowhere
 * else (lib/llm/llmSettings.resolveActive): whether AI features are on at all,
 * the provider, the credential, the model, and the behavioural knobs (reasoning
 * effort, temperature, tool-iteration cap). This module reads no config file and
 * no environment variable, deliberately — anything it read here would be a value
 * the user cannot change from the Settings page without a restart, and a Settings
 * page that does not decide is worse than no Settings page. With nothing
 * configured, a turn fails with 503 + needsLlmSetup and the UI sends the user to
 * Settings → AI features.
 */

let crypto = require('crypto');
let OpenAI = require('openai');

let providers = require('../llm/providers');
let bedrockConverse = require('../llm/bedrockConverse');
let credentialProvider = require('../credentialProvider');
let llmSettings = require('../llm/llmSettings');
let modelCatalog = require('../llm/modelCatalog');

// Reasoning models take `reasoning_effort` and reject `temperature`. The rule now
// lives in modelCatalog so it applies to every provider's ids (including
// OpenRouter's `vendor/model` form), not just to whatever was in config.
function isReasoningModel(model) {
    return modelCatalog.isReasoningModel(model);
}

// Client cache keyed by endpoint + key fingerprint. Caching matters (the SDK sets
// up an HTTP agent per instance) but caching *one* client does not work any more:
// two providers, or a rotated key, must not share a connection configured for the
// old one. The key is hashed so a stray log of the cache keys cannot leak it.
let clientCache = new Map();

function cacheKey(baseUrl, apiKey) {
    let fingerprint = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
    return String(baseUrl || '') + '|' + fingerprint;
}

function buildClient(provider, baseUrl, apiKey) {
    let key = cacheKey(baseUrl, apiKey);
    let cached = clientCache.get(key);
    if (cached) {
        return cached;
    }
    let opts = {
        // Keyless local runtimes (Ollama) still need a non-empty string here: the
        // SDK refuses to construct without one, and the server ignores it.
        apiKey: apiKey || 'not-needed'
    };
    if (baseUrl) {
        opts.baseURL = baseUrl;
    }
    if (provider && provider.extraHeaders) {
        opts.defaultHeaders = Object.assign({}, provider.extraHeaders);
    }
    // OpenAI SDK v7 exports the constructor as .default under CommonJS interop.
    let Ctor = OpenAI.OpenAI || OpenAI.default || OpenAI;
    let client = new Ctor(opts);
    // Bounded so a long-lived process that has cycled through many keys does not
    // accumulate HTTP agents. Two or three live entries is the realistic ceiling.
    if (clientCache.size >= 8) {
        clientCache.clear();
    }
    clientCache.set(key, client);
    return client;
}

/**
 * Turn a resolved Bedrock configuration into a client the agent can call.
 *
 * Not cached, unlike the OpenAI clients above. That cache exists because the SDK
 * creates an HTTP agent per instance; the Converse adapter uses plain https
 * requests and holds nothing, so a fresh object per turn costs nothing and cannot
 * serve a stale region, profile or key after a settings change.
 *
 * Credentials are a *callback*, not a value: the adapter calls it per request, so a
 * one-hour SSO or IRSA credential is re-minted mid-conversation instead of the
 * chat dying partway through a long thread.
 */
function buildBedrockClient(userName, active) {
    let region = active.awsRegion || bedrockConverse.DEFAULT_REGION;
    if (active.credentialSource === providers.CREDENTIAL_SOURCE.API_KEY) {
        return bedrockConverse.createBedrockClient({ region: region, apiKey: active.apiKey });
    }
    return bedrockConverse.createBedrockClient({
        region: region,
        resolveCredentials: function () {
            return resolveProfileCredentials(userName, active.awsProfileName, active.awsAuthnMode);
        }
    });
}

// credentialProvider is the single dispatch point for every profile type, so this
// works for an IAM user, an SSO role, an EC2 instance role and an EKS IRSA service
// account without knowing which it got. Errors are passed through with their
// properties intact — notably `verificationUriComplete` and `ssoSessionExpired`,
// which are what let the chat surface an Authorize link instead of a dead end.
function resolveProfileCredentials(userName, profileName, authnMode) {
    return new Promise(function (resolve, reject) {
        credentialProvider.resolveByProfileName(userName, profileName, authnMode || null,
            function (err, resolved) {
                if (err) {
                    return reject(err);
                }
                if (!resolved || !resolved.credentials) {
                    return reject(new Error('Profile "' + profileName +
                        '" did not yield AWS credentials for Bedrock.'));
                }
                return resolve(resolved.credentials);
            });
    });
}

/**
 * Resolve the provider, model and client for a user.
 *
 * cb(null, session) where session is either
 *   { ok:true, client, model, providerId, providerLabel, source, buildParams }
 * or, for a provider that answers through a module rather than an
 * OpenAI-compatible endpoint,
 *   { ok:true, chatBackend, client:null, model, providerId, providerLabel, source }
 * or
 *   { ok:false, statusCode, message, reason }
 *
 * `buildParams` is on the session rather than on the module because the reasoning
 * -vs-temperature decision depends on the *resolved* model — with a global
 * getModel() it silently applied the config's model's rules to whichever model
 * was actually in use.
 *
 * `override` ({ providerId, model }) exists for the in-conversation model picker:
 * it lets a turn use the model just chosen without depending on the settings
 * write having landed first.
 */
function resolveSession(userName, override, cb) {
    let opts = override || {};
    // No enable check here: resolveActive owns it, because it owns every other
    // reason a turn cannot run and there must be exactly one place that decides.
    // A check here would be reading a *different* source (a config file) and would
    // therefore need a restart to change — see the module comment.
    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return cb(null, {
                ok: false,
                statusCode: 500,
                reason: 'settings_unreadable',
                message: 'Could not read your LLM settings: ' + err.message
            });
        }
        let effective = settings;
        if (opts.providerId || opts.model) {
            effective = Object.assign({}, settings);
            if (opts.providerId) {
                effective.activeProviderId = String(opts.providerId);
            }
            if (opts.model) {
                effective.activeModel = String(opts.model);
            }
        }
        let active = llmSettings.resolveActive(effective);
        if (!active.ok) {
            return cb(null, {
                ok: false,
                // 503: the service cannot act, and the fix is configuration. The
                // frontend keys its "open Settings" prompt off this status.
                statusCode: 503,
                reason: active.reason,
                message: active.message,
                providerId: active.providerId || null
            });
        }
        let provider = active.provider || providers.getProvider(active.providerId);

        // A provider with a chatBackend has no OpenAI-compatible endpoint, so
        // there is no client to build — constructing one would succeed (the SDK
        // does no I/O at construction) and then 404 on the first turn, which is a
        // worse failure than not having one. chatService dispatches on
        // `chatBackend`; the session deliberately carries no `client` so any code
        // path that forgets to branch fails loudly on the spot.
        if (active.chatBackend) {
            return cb(null, {
                ok: true,
                chatBackend: active.chatBackend,
                client: null,
                model: active.model,
                providerId: active.providerId,
                providerLabel: provider ? provider.label : active.providerId,
                source: active.source,
                baseUrl: active.baseUrl,
                maxToolIterations: active.maxToolIterations
                // No buildParams either: reasoning_effort/temperature are
                // parameters of a chat-completions call, and this backend makes
                // none. The backend owns its own knobs.
            });
        }

        let client;
        try {
            client = provider && provider.kind === 'bedrock'
                ? buildBedrockClient(userName, active)
                : buildClient(provider, active.baseUrl, active.apiKey);
        } catch (buildErr) {
            return cb(null, {
                ok: false,
                statusCode: 500,
                reason: 'client_error',
                message: 'Could not initialise the ' + (provider ? provider.label : 'LLM') +
                    ' client: ' + buildErr.message
            });
        }
        return cb(null, {
            ok: true,
            client: client,
            model: active.model,
            providerId: active.providerId,
            providerLabel: provider ? provider.label : active.providerId,
            source: active.source,
            baseUrl: active.baseUrl,
            // On the session, not read from a module-level config getter: the cap
            // is a setting the user can change mid-conversation, and the agent
            // takes it per turn.
            maxToolIterations: active.maxToolIterations,
            buildParams: function (extra) {
                let params = Object.assign({ model: active.model }, extra || {});
                // Bedrock takes neither knob in the OpenAI spelling: the adapter
                // maps `temperature` into inferenceConfig and has nowhere to put
                // `reasoning_effort`, which several Claude variants also reject
                // alongside a temperature. So send neither and let the model use
                // its own defaults.
                if (provider && provider.kind === 'bedrock') {
                    return params;
                }
                if (modelCatalog.isReasoningModel(active.model)) {
                    if (active.reasoningEffort) {
                        params.reasoning_effort = active.reasoningEffort;
                    }
                    // Reasoning models reject temperature — omit it.
                } else {
                    params.temperature = active.temperature;
                }
                return params;
            }
        });
    });
}

// Promise form, since every consumer is an async handler.
function resolveSessionAsync(userName, override) {
    return new Promise(function (resolve) {
        resolveSession(userName, override, function (err, session) {
            if (err) {
                return resolve({
                    ok: false,
                    statusCode: 500,
                    reason: 'resolve_error',
                    message: err.message
                });
            }
            return resolve(session);
        });
    });
}

module.exports = {
    isReasoningModel: isReasoningModel,
    resolveSession: resolveSession,
    resolveSessionAsync: resolveSessionAsync
};
