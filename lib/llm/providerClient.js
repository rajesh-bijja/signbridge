"use strict";

/**
 * providerClient.js — talk to a provider's REST API: validate a key, list models.
 *
 * Two calls, both driven entirely by the registry row, which is what keeps
 * "add a provider" down to one table entry.
 *
 * The design decision worth naming is that **the probe endpoint is per provider,
 * not universally `/models`**. The obvious implementation tests a key by listing
 * models and calling a 200 a pass. That is wrong for OpenRouter, whose model list
 * is *public* — a revoked key would sail through the test and then fail on the
 * first chat turn, which is precisely the failure this feature exists to prevent.
 * So a row may declare `authCheckPath` (OpenRouter: `/key`) or `testPath`
 * (Cursor: `/v1/me`), and only when it declares neither does the model list serve
 * as the probe.
 *
 * The third: **Bedrock is not tested over HTTP from here.** It has no key-probe
 * endpoint and no model list on its runtime host, and with the profile credential
 * source there may be no key at all — so `testConnection` and `listModels` both
 * hand it to the branches at the bottom of this file, which resolve credentials
 * through `lib/credentialProvider.js` and read the Bedrock control plane. The
 * important consequence is that a *denied model list is a pass*: an EKS
 * service-account role scoped to inference has bedrock:InvokeModel and no
 * bedrock:List*, and refusing to verify it would lock out the exact credential the
 * profile source exists to support.
 *
 * The second decision: transport failures come back as *results*, not errors.
 * `cb(err)` is reserved for programming faults. A rejected key, an unreachable
 * host and a typo'd Azure endpoint are all normal, expected outcomes whose whole
 * value is the message shown to the user, and routing them through the error
 * channel would strip that message down to whatever axios happened to say.
 */

let axios = require('axios');
let providers = require('./providers');
let modelCatalog = require('./modelCatalog');
let bedrockConverse = require('./bedrockConverse');
let credentialProvider = require('../credentialProvider');

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Turn a failed request into a message a user can act on.
 *
 * Pure and exported so the mapping is testable without a network: every branch
 * here is a support question that would otherwise be asked, and the specific
 * ones (a base URL that resolves but has no /models; a key with the wrong
 * provider's prefix) are the ones a generic "request failed" hides.
 *
 * `context` is 'test' or 'models' — the same status means different things
 * depending on which call produced it.
 */
function describeHttpError(provider, err, context) {
    let label = (provider && provider.label) || 'the provider';
    let response = err && err.response;
    let status = response ? response.status : null;
    let body = response ? response.data : null;

    // Providers vary in where they put the human-readable reason.
    let providerMessage = '';
    if (body && typeof body === 'object') {
        providerMessage = (body.error && (body.error.message || body.error.type)) ||
            body.message || body.detail || '';
        if (!providerMessage && typeof body.error === 'string') {
            providerMessage = body.error;
        }
    } else if (typeof body === 'string' && body.trim() && body.length < 400) {
        providerMessage = body.trim();
    }

    let code = err && err.code;
    if (!status) {
        if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
            return {
                ok: false,
                reason: 'timeout',
                message: label + ' did not respond within ' + Math.round(DEFAULT_TIMEOUT_MS / 1000) +
                    ' seconds. Check the base URL and your network connection.'
            };
        }
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
            return {
                ok: false,
                reason: 'dns',
                message: 'The host for ' + label + ' could not be resolved. ' +
                    'Check the base URL for a typo.'
            };
        }
        if (code === 'ECONNREFUSED') {
            // Overwhelmingly the local-runtime case, so say the useful thing.
            let hint = provider && provider.id === 'ollama'
                ? ' Is Ollama running? From Docker, use http://host.docker.internal:11434/v1.'
                : '';
            return {
                ok: false,
                reason: 'refused',
                message: 'The connection to ' + label + ' was refused.' + hint
            };
        }
        if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
            code === 'SELF_SIGNED_CERT_IN_CHAIN') {
            return {
                ok: false,
                reason: 'tls',
                message: 'The TLS certificate presented by ' + label + ' could not be verified (' +
                    code + '). If you are behind a corporate proxy, its certificate must be trusted.'
            };
        }
        return {
            ok: false,
            reason: 'network',
            message: 'Could not reach ' + label + ': ' +
                ((err && err.message) || 'unknown network error') + '.'
        };
    }

    // Not every provider uses 401 for a bad key. Google's OpenAI-compatibility
    // endpoint answers a malformed key with `400 INVALID_ARGUMENT — "Please pass
    // a valid API key"` (verified), and left in the generic bucket that reads as
    // "something about my request was wrong" rather than "fix your key". Classify
    // on the message, since the status is not diagnostic here.
    if (status === 400 && /api[ _-]?key|unauthor|invalid.{0,20}(key|credential|token)/i
        .test(providerMessage)) {
        return {
            ok: false,
            statusCode: 400,
            reason: 'unauthorized',
            message: label + ' rejected the API key — ' + providerMessage +
                '. Check that you pasted the whole key and that it is for ' + label + '.'
        };
    }

    if (status === 401) {
        return {
            ok: false,
            statusCode: 401,
            reason: 'unauthorized',
            message: label + ' rejected the API key' +
                (providerMessage ? ' — ' + providerMessage : '') +
                '. Check that you pasted the whole key and that it has not been revoked.'
        };
    }
    if (status === 403) {
        return {
            ok: false,
            statusCode: 403,
            reason: 'forbidden',
            message: label + ' accepted the key but refused the request' +
                (providerMessage ? ' — ' + providerMessage : '') +
                '. The key may lack the permissions or model access this needs.'
        };
    }
    if (status === 404) {
        return {
            ok: false,
            statusCode: 404,
            reason: 'not_found',
            message: (context === 'models'
                ? label + ' has no model-list endpoint at the configured base URL'
                : label + ' returned 404 for the connection test') +
                '. The base URL is probably wrong — it should end at the API root ' +
                '(for example …/v1), not at a specific endpoint.'
        };
    }
    if (status === 429) {
        return {
            ok: false,
            statusCode: 429,
            reason: 'rate_limited',
            message: label + ' rate-limited the request' +
                (providerMessage ? ' — ' + providerMessage : '') + '. Try again in a moment.'
        };
    }
    if (status >= 500) {
        return {
            ok: false,
            statusCode: status,
            reason: 'provider_error',
            message: label + ' returned a server error (' + status + ')' +
                (providerMessage ? ' — ' + providerMessage : '') +
                '. This is on their side; try again shortly.'
        };
    }
    return {
        ok: false,
        statusCode: status,
        reason: 'http_error',
        message: label + ' returned HTTP ' + status +
            (providerMessage ? ' — ' + providerMessage : '') + '.'
    };
}

// Which path proves the key works. See the header: /models is the fallback, not
// the rule.
function resolveProbePath(provider) {
    if (!provider) {
        return '/models';
    }
    return provider.testPath || provider.authCheckPath || provider.modelsPath || '/models';
}

/**
 * A short, human label for whose account the key belongs to.
 *
 * Worth the small amount of shape-sniffing: "verified — rbijja@…" tells the user
 * *which* of their accounts they just wired up, which a bare green tick does not.
 * Absent for providers whose probe response says nothing about the caller.
 */
function extractAccountLabel(body) {
    if (!body || typeof body !== 'object') {
        return null;
    }
    let data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data))
        ? body.data : body;
    let candidates = [
        data.email, data.user_email, data.userEmail,
        data.label, data.name, data.display_name, data.organization,
        data.org_name, data.orgName, data.team, data.teamName
    ];
    for (let i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] === 'string' && candidates[i].trim()) {
            return candidates[i].trim().slice(0, 120);
        }
    }
    return null;
}

// Extra facts a probe response happens to carry, shown next to the verification
// tick. OpenRouter reports credit limits here, which is genuinely useful to see
// before you discover it mid-conversation.
function extractProbeDetails(body) {
    let data = (body && body.data && typeof body.data === 'object') ? body.data : body;
    if (!data || typeof data !== 'object') {
        return null;
    }
    let details = {};
    if (typeof data.limit === 'number' || data.limit === null) {
        details.limit = data.limit;
    }
    if (typeof data.usage === 'number') {
        details.usage = data.usage;
    }
    if (typeof data.is_free_tier === 'boolean') {
        details.freeTier = data.is_free_tier;
    }
    return Object.keys(details).length ? details : null;
}

function buildRequest(provider, config, urlPath, options) {
    let opts = options || {};
    let baseUrl = providers.resolveBaseUrl(provider, config);
    let headers = providers.buildAuthHeaders(provider, opts.apiKey || '');
    headers.Accept = 'application/json';
    return {
        method: opts.method || 'get',
        url: baseUrl + urlPath,
        headers: headers,
        timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
        responseType: 'json'
        // Deliberately leaving validateStatus at its default so a non-2xx
        // rejects: describeHttpError is where every failure is explained, and
        // accepting all statuses here would route them into the success path.
    };
}

/**
 * Validate a key against the provider.
 *
 * cb(null, { ok:true, statusCode, accountLabel, details }) on success,
 * cb(null, { ok:false, reason, message, statusCode }) on any expected failure.
 */
function testConnection(provider, config, cb) {
    if (!provider) {
        return cb(null, { ok: false, reason: 'unknown_provider', message: 'Unknown provider.' });
    }
    if (provider.kind === 'bedrock') {
        return testBedrockConnection(provider, config, cb);
    }
    let apiKey = (config && config.apiKey) ? String(config.apiKey).trim() : '';
    if (providers.needsApiKey(provider, config) && !apiKey) {
        return cb(null, {
            ok: false,
            reason: 'missing_key',
            message: 'Enter an API key for ' + provider.label + ' first.'
        });
    }
    let baseUrl = providers.resolveBaseUrl(provider, config);
    if (!baseUrl) {
        return cb(null, {
            ok: false,
            reason: 'missing_base_url',
            message: provider.label + ' needs a base URL' +
                (provider.baseUrlPlaceholder ? ' (for example ' + provider.baseUrlPlaceholder + ')' : '') +
                '.'
        });
    }

    let request = buildRequest(provider, config, resolveProbePath(provider), { apiKey: apiKey });
    axios(request).then(function (response) {
        let result = {
            ok: true,
            statusCode: response.status,
            accountLabel: extractAccountLabel(response.data),
            details: extractProbeDetails(response.data)
        };
        // Advisory only — the key worked, so a prefix we do not recognise means
        // our list of prefixes is stale, not that the user did anything wrong.
        if (apiKey && !providers.looksLikeKey(provider, apiKey)) {
            result.warning = 'The key does not start with the prefix ' + provider.label +
                ' usually issues, but it was accepted.';
        }
        return cb(null, result);
    }).catch(function (err) {
        return cb(null, describeHttpError(provider, err, 'test'));
    });
}

/**
 * List the models this key can use, normalised and filtered to chat models.
 *
 * cb(null, { ok:true, models, fetchedAt, total }) or cb(null, { ok:false, … }).
 */
function listModels(provider, config, cb) {
    if (!provider) {
        return cb(null, { ok: false, reason: 'unknown_provider', message: 'Unknown provider.' });
    }
    if (provider.kind === 'bedrock') {
        return listBedrockModelsFor(provider, config, cb);
    }
    let apiKey = (config && config.apiKey) ? String(config.apiKey).trim() : '';
    // A public model list is listable before a key exists, which lets the picker
    // show what is on offer while the user is still deciding.
    if (providers.needsApiKey(provider, config) && !apiKey && !provider.modelsPublic) {
        return cb(null, {
            ok: false,
            reason: 'missing_key',
            message: 'Add an API key for ' + provider.label + ' to list its models.'
        });
    }
    let baseUrl = providers.resolveBaseUrl(provider, config);
    if (!baseUrl) {
        return cb(null, {
            ok: false,
            reason: 'missing_base_url',
            message: provider.label + ' needs a base URL before its models can be listed.'
        });
    }
    if (!provider.modelsPath) {
        return cb(null, {
            ok: false,
            reason: 'no_model_list',
            message: provider.label + ' does not publish a model list.'
        });
    }

    let request = buildRequest(provider, config, provider.modelsPath, { apiKey: apiKey });
    axios(request).then(function (response) {
        let all = modelCatalog.normalizeModels(provider.modelsShape, response.data,
            { chatOnly: false });
        let chatModels = modelCatalog.normalizeModels(provider.modelsShape, response.data,
            { chatOnly: true });
        if (!chatModels.length) {
            return cb(null, {
                ok: false,
                reason: 'empty_model_list',
                message: provider.label + ' returned no models for this key. ' +
                    'The account may have no model access yet.'
            });
        }
        return cb(null, {
            ok: true,
            models: chatModels,
            total: all.length,
            fetchedAt: new Date().toISOString()
        });
    }).catch(function (err) {
        return cb(null, describeHttpError(provider, err, 'models'));
    });
}


// ---------------------------------------------------------------------------
// Bedrock
// ---------------------------------------------------------------------------

// Build the adapter for a config being *tested*, which is not necessarily the one
// saved — the user presses Test before Save, so the profile, region and key all
// come from the request. `config.userName` says whose profiles to look in; it is
// the local user either way, but reading it from the config keeps this function
// free of the request.
function bedrockClientFor(config) {
    let region = providers.resolveAwsRegion(providers.getProvider('bedrock'), config);
    if (providers.resolveCredentialSource(providers.getProvider('bedrock'), config) ===
        providers.CREDENTIAL_SOURCE.API_KEY) {
        return bedrockConverse.createBedrockClient({
            region: region,
            apiKey: String((config && config.apiKey) || '').trim()
        });
    }
    let userName = config && config.userName;
    let profileName = config && config.awsProfileName;
    let authnMode = (config && config.awsAuthnMode) || null;
    return bedrockConverse.createBedrockClient({
        region: region,
        resolveCredentials: function () {
            return new Promise(function (resolve, reject) {
                credentialProvider.resolveByProfileName(userName, profileName, authnMode,
                    function (err, resolved) {
                        if (err) {
                            return reject(err);
                        }
                        if (!resolved || !resolved.credentials) {
                            return reject(new Error('Profile "' + profileName +
                                '" did not yield AWS credentials.'));
                        }
                        return resolve(resolved.credentials);
                    });
            });
        }
    });
}

// What has to be present before Bedrock can be tested at all, as a result rather
// than an exception (see the header).
function missingBedrockInput(provider, config) {
    if (providers.usesAwsProfile(provider, config)) {
        if (!config || !config.awsProfileName) {
            return {
                ok: false,
                reason: 'missing_aws_profile',
                message: 'Choose which AWS profile should sign Bedrock calls.'
            };
        }
        if (!config.userName) {
            return {
                ok: false,
                reason: 'missing_user',
                message: 'Could not tell whose profiles to read.'
            };
        }
        return null;
    }
    if (!config || !String(config.apiKey || '').trim()) {
        return {
            ok: false,
            reason: 'missing_key',
            message: 'Enter a Bedrock API key, or switch to signing with an AWS profile.'
        };
    }
    return null;
}

// A credential failure, explained. An expired SSO session keeps its
// `verificationUriComplete` so Settings can offer the Authorize button that fixes
// it, exactly as the dashboard does — the commonest failure here is a session that
// needs re-approving, and "test failed" with no link is a dead end.
function describeCredentialFailure(config, err) {
    let result = {
        ok: false,
        reason: 'credentials_failed',
        message: 'Could not get AWS credentials from profile "' +
            ((config && config.awsProfileName) || '') + '": ' + (err && err.message ? err.message : err)
    };
    if (err && err.verificationUriComplete) {
        result.verificationUriComplete = err.verificationUriComplete;
    }
    if (err && err.ssoSessionExpired) {
        result.ssoSessionExpired = true;
    }
    return result;
}

// A 401 from the control plane means the credentials themselves were rejected, so
// nothing about this configuration works. A 403 means they are real and simply not
// allowed to *list* — which says nothing about invoking, and is the normal shape of
// an inference-scoped role.
function rejectedNotDenied(errors) {
    for (let entry of errors || []) {
        if (entry.statusCode === 401 || entry.statusCode === 400) {
            return entry;
        }
    }
    return null;
}

/**
 * Test Bedrock: prove the credentials resolve, then try to read the model list.
 *
 * Deliberately no test *invoke*. An invoke probe needs a model id, and the role
 * may well be authorised for the model the user intends and not for whichever one
 * we picked — so it would report a broken provider that works. The first chat turn
 * is where an invoke permission is genuinely exercised, and `bedrockError` already
 * explains a 403 there by naming bedrock:InvokeModel.
 */
function testBedrockConnection(provider, config, cb) {
    let missing = missingBedrockInput(provider, config);
    if (missing) {
        return cb(null, missing);
    }
    let usesProfile = providers.usesAwsProfile(provider, config);
    let region = providers.resolveAwsRegion(provider, config);
    let client;
    try {
        client = bedrockClientFor(config);
    } catch (buildErr) {
        return cb(null, {
            ok: false,
            reason: 'client_error',
            message: 'Could not set up the Bedrock client: ' + buildErr.message
        });
    }

    client.listModels().then(function (listed) {
        let rejected = rejectedNotDenied(listed.errors);
        if (rejected && !usesProfile) {
            // Only meaningful for the key source: a rejected key is a failed test.
            // With a profile, resolution already succeeded, so a 401 here would be
            // about the control plane rather than the credentials.
            return cb(null, {
                ok: false,
                reason: 'invalid_key',
                statusCode: rejected.statusCode,
                message: 'Bedrock did not accept this API key: ' + rejected.message
            });
        }
        let label = usesProfile
            ? config.awsProfileName + (config.awsAuthnMode ? ' (' + config.awsAuthnMode + ')' : '') +
                ' · ' + region
            : 'Bedrock API key · ' + region;
        let result = {
            ok: true,
            statusCode: 200,
            accountLabel: label,
            details: { region: region, modelCount: listed.models.length }
        };
        if (listed.usedFallback) {
            // A pass with a caveat, and the caveat names the permissions so the
            // user can widen the role if they want the real list.
            result.warning = listed.denied.length
                ? 'Credentials work, but this identity cannot list Bedrock models (' +
                    listed.denied.join(', ') + '), so a short list of current Claude ' +
                    'models is offered instead — and you can type any other model id ' +
                    'you have access to. Invoking is a separate permission and is not ' +
                    'affected.'
                : 'No Bedrock models are listed for this identity in ' + region +
                    ', so a short list of current Claude models is offered instead — ' +
                    'and you can type any other model id you have access to.';
        } else if (listed.denied.length) {
            result.warning = 'Partial model list: ' + listed.denied.join(', ') +
                ' was denied, so some models may be missing.';
        }
        return cb(null, result);
    }).catch(function (err) {
        if (usesProfile) {
            return cb(null, describeCredentialFailure(config, err));
        }
        return cb(null, {
            ok: false,
            reason: 'request_failed',
            statusCode: (err && (err.statusCode || err.status)) || null,
            message: 'Could not reach Bedrock in ' + region + ': ' + err.message
        });
    });
}

// The model list, same rules as the test: a denied listing degrades to the curated
// ids rather than failing, because the picker being empty is the only outcome that
// makes the provider unusable.
function listBedrockModelsFor(provider, config, cb) {
    let missing = missingBedrockInput(provider, config);
    if (missing) {
        return cb(null, missing);
    }
    let region = providers.resolveAwsRegion(provider, config);
    let client;
    try {
        client = bedrockClientFor(config);
    } catch (buildErr) {
        return cb(null, {
            ok: false,
            reason: 'client_error',
            message: 'Could not set up the Bedrock client: ' + buildErr.message
        });
    }
    client.listModels().then(function (listed) {
        let models = listed.models.map(function (model) {
            return {
                id: model.id,
                label: model.label || model.id,
                // The picker groups by owner elsewhere; for Bedrock the useful
                // distinction is inference profile vs foundation model, since only
                // the former works cross-region.
                owner: model.kind === 'inference-profile' ? 'inference profile' : 'foundation model'
            };
        });
        return cb(null, {
            ok: true,
            models: models,
            total: models.length,
            usedFallback: !!listed.usedFallback,
            denied: listed.denied || [],
            fetchedAt: new Date().toISOString()
        });
    }).catch(function (err) {
        if (providers.usesAwsProfile(provider, config)) {
            return cb(null, describeCredentialFailure(config, err));
        }
        return cb(null, {
            ok: false,
            reason: 'request_failed',
            message: 'Could not list Bedrock models in ' + region + ': ' + err.message
        });
    });
}

module.exports = {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    describeHttpError: describeHttpError,
    resolveProbePath: resolveProbePath,
    extractAccountLabel: extractAccountLabel,
    extractProbeDetails: extractProbeDetails,
    testConnection: testConnection,
    listModels: listModels,
    // Exported for tests: the input-validation and 401-vs-403 rules are the two
    // places this could silently either lock out a working role or bless a dead key.
    missingBedrockInput: missingBedrockInput,
    rejectedNotDenied: rejectedNotDenied
};
