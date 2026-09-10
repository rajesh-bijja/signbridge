"use strict";

/**
 * llmSettings.js — file-backed LLM configuration for one local user.
 *
 * Lives at <userDir>/llm/settings.json, alongside the other per-user artifacts,
 * and replaces LLM_API_KEY / [llm] as the *source of truth*. Both remain as a
 * fallback (see resolveActive) so an existing install and an air-gapped deploy
 * that only has environment variables keep working — a settings migration that
 * breaks running deployments is not an upgrade.
 *
 * Two rules the rest of the codebase depends on:
 *
 *   1. `load()` returns keys sealed; `resolveActive()` is the only function that
 *      returns a usable plaintext key, and nothing serialises its result to a
 *      client. `toPublic()` is what the frontend gets, and it carries masks.
 *   2. A provider's saved state is keyed by provider id and independent. Testing
 *      OpenAI must not disturb the OpenRouter key, because the whole point of
 *      the picker is switching between configured providers without re-entering
 *      anything.
 */

let fs = require('fs');
let path = require('path');
let paths = require('../paths');
let providers = require('./providers');
let secretStore = require('./secretStore');
let log = require('../logger').create('llm/llmSettings');

const LLM_DIR_NAME = 'llm';
const SETTINGS_FILE_NAME = 'settings.json';

// The model the legacy environment fallback uses when LLM_MODEL is unset.
//
// It needs a default of its own. The old code took the model from `llm.model` in
// config.properties; that key is gone now that the model is chosen per provider
// in Settings, which left the fallback resolving successfully with an empty model
// — and every provider answers an empty model with `400 you must provide a model
// parameter`. An install carrying nothing but LLM_API_KEY is exactly the case
// this fallback exists for, so it carries a working default rather than a
// technically-correct blank.
const DEFAULT_ENV_MODEL = 'gpt-5.4-2026-03-05';

function getLlmDir(userName) {
    return path.join(paths.getUserDir(userName), LLM_DIR_NAME);
}

function getSettingsFile(userName) {
    return path.join(getLlmDir(userName), SETTINGS_FILE_NAME);
}

function emptySettings() {
    return {
        enabled: false,
        activeProviderId: null,
        activeModel: null,
        providers: {},
        updatedAt: null
    };
}

// Read settings, tolerating absence and corruption. A settings file that fails
// to parse must not take the Settings page down — that is the one page the user
// would go to in order to fix it.
function load(userName, cb) {
    let file = getSettingsFile(userName);
    fs.readFile(file, 'utf8', function (err, contents) {
        if (err) {
            if (err.code === 'ENOENT') {
                return cb(null, emptySettings());
            }
            return cb(err);
        }
        let parsed;
        try {
            parsed = JSON.parse(contents);
        } catch (parseErr) {
            log.warn('llmSettings.load: ' + file + ' is not valid JSON; treating as empty.');
            return cb(null, emptySettings());
        }
        let settings = Object.assign(emptySettings(), parsed || {});
        if (!settings.providers || typeof settings.providers !== 'object') {
            settings.providers = {};
        }
        return cb(null, settings);
    });
}

function save(userName, settings, cb) {
    let dir = getLlmDir(userName);
    fs.mkdir(dir, { recursive: true }, function (mkErr) {
        if (mkErr) {
            return cb(mkErr);
        }
        let payload = Object.assign({}, settings, { updatedAt: new Date().toISOString() });
        // 0600: the file holds sealed keys, but the envelope plus a readable key
        // file is a usable credential, so do not widen the surface needlessly.
        fs.writeFile(getSettingsFile(userName), JSON.stringify(payload, null, 2), { mode: 0o600 },
            function (writeErr) {
                if (writeErr) {
                    return cb(writeErr);
                }
                return cb(null, payload);
            });
    });
}

// How many hand-typed model ids to keep per provider. A remembered list is what
// makes a custom id survive a page reload and a model-list refresh, but it is a
// convenience, not an archive — an uncapped list would quietly accumulate every
// typo the user ever made into the picker they are trying to choose from.
const MAX_CUSTOM_MODELS = 12;

/**
 * The custom model ids for a provider, cleaned.
 *
 * Pure and exported because this is the one place that decides what a model id may
 * be, and it is fed by a free-text field. Deliberately permissive about *shape*:
 * a Bedrock inference-profile id, a bare OpenAI model name and a provisioned
 * throughput ARN look nothing alike, and a validator that only accepted the shapes
 * that exist today would reject the very model the user is here to add. It only
 * removes what cannot be a model id at all — blanks, non-strings, duplicates — and
 * anything long enough to be a paste accident.
 */
function sanitizeCustomModels(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    let seen = {};
    let out = [];
    for (let entry of list) {
        let id = typeof entry === 'string' ? entry.trim() : (entry && entry.id ? String(entry.id).trim() : '');
        if (!id || id.length > 256 || seen[id]) {
            continue;
        }
        seen[id] = true;
        out.push(id);
        if (out.length >= MAX_CUSTOM_MODELS) {
            break;
        }
    }
    return out;
}

/**
 * Record a hand-typed model id, most recent first.
 *
 * Returns the stored list unchanged when the id is one the provider already lists,
 * so choosing a listed model never adds a "custom" entry that duplicates it.
 */
function rememberCustomModel(config, modelId) {
    let id = String(modelId || '').trim();
    let stored = sanitizeCustomModels((config && config.customModels) || []);
    if (!id) {
        return stored;
    }
    let listed = ((config && config.models) || []).some(function (model) {
        return model && model.id === id;
    });
    if (listed) {
        return stored;
    }
    return sanitizeCustomModels([id].concat(stored));
}

function getProviderConfig(settings, providerId) {
    if (!settings || !settings.providers) {
        return null;
    }
    return settings.providers[providerId] || null;
}

// The plaintext key for a provider, or '' when none is stored. The single point
// at which a secret is unsealed, so it is also the single place to audit.
function getApiKey(settings, providerId) {
    let config = getProviderConfig(settings, providerId);
    if (!config) {
        return '';
    }
    if (secretStore.isSealed(config.apiKey)) {
        return secretStore.open(config.apiKey) || '';
    }
    // A hand-edited settings file may carry a bare string. Accept it rather than
    // silently ignoring a key the user believes they configured; it gets sealed
    // on the next save.
    return typeof config.apiKey === 'string' ? config.apiKey : '';
}

/**
 * Merge one provider's configuration, sealing the key.
 *
 * `apiKey` semantics matter here and are easy to get wrong:
 *   undefined — leave the stored key alone (the caller is saving a base URL, or
 *               a model choice, and the browser never had the real key to send
 *               back). This is what makes "edit settings without re-entering the
 *               key" work.
 *   ''        — explicitly clear it.
 *   a string  — replace it.
 */
function setProviderConfig(settings, providerId, patch) {
    let next = Object.assign({}, settings);
    next.providers = Object.assign({}, settings.providers || {});
    let existing = next.providers[providerId] || {};
    let merged = Object.assign({}, existing, patch || {});

    if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
        if (patch.apiKey === '' || patch.apiKey === null) {
            delete merged.apiKey;
            // Left over from the removed key-brokering flows, where a key could
            // have arrived from an OAuth exchange or a mint call rather than from
            // the user's hands. Every key is pasted now, so the field says nothing
            // — dropped here so an old settings file loses it on the next write.
            delete merged.keySource;
            // A cleared key invalidates the verification that key earned.
            merged.verifiedOk = false;
            merged.verifiedAt = null;
        } else if (typeof patch.apiKey === 'string') {
            merged.apiKey = secretStore.seal(patch.apiKey);
        }
    } else {
        merged.apiKey = existing.apiKey;
    }

    next.providers[providerId] = merged;
    return next;
}

/**
 * The client-facing shape. Never contains a key.
 *
 * It carries `keyMask` and `hasKey` instead, which is what the UI actually needs:
 * enough to show "sk-proj-…••••fDIA — verified 2 minutes ago" and to decide
 * whether the field should read "Replace key" or "Add key".
 */
function toPublic(settings) {
    let out = {
        enabled: !!(settings && settings.enabled),
        activeProviderId: (settings && settings.activeProviderId) || null,
        activeModel: (settings && settings.activeModel) || null,
        updatedAt: (settings && settings.updatedAt) || null,
        providers: {}
    };
    let configured = (settings && settings.providers) || {};
    Object.keys(configured).forEach(function (providerId) {
        let config = configured[providerId] || {};
        let key = getApiKey(settings, providerId);
        out.providers[providerId] = {
            hasKey: !!key,
            keyMask: key ? secretStore.maskKey(key) : null,
            baseUrl: config.baseUrl || '',
            verifiedOk: !!config.verifiedOk,
            verifiedAt: config.verifiedAt || null,
            verifiedError: config.verifiedError || null,
            models: Array.isArray(config.models) ? config.models : [],
            modelsFetchedAt: config.modelsFetchedAt || null,
            // Model ids the user typed in. Kept separate from `models` rather than
            // merged into it, because `models` is replaced wholesale on every
            // refresh — a custom id merged in there would vanish the next time the
            // list was fetched, which is precisely when the user needs it least.
            customModels: sanitizeCustomModels(config.customModels),
            // True when `models` is the curated fallback rather than the account's
            // real list, i.e. this identity cannot list models. The panel uses it to
            // put the custom-model-id field in front of the user instead of behind
            // a disclosure, because for that identity typing an id is the *normal*
            // way to reach a model, not an edge case.
            modelsUsedFallback: !!config.modelsUsedFallback,
            accountLabel: config.accountLabel || null,
            // Where this provider's credentials come from, and — for the
            // 'aws_profile' source — which SignBridge profile signs the calls.
            // None of these are secrets (a profile *name*, a mechanism and a
            // region), and the panel cannot render the choice without them.
            // Resolved rather than echoed, so the UI shows the source and region
            // that would actually be used, not a blank meaning "the default".
            credentialSource: providers.resolveCredentialSource(
                providers.getProvider(providerId), config),
            credentialSources: providers.listCredentialSources(providers.getProvider(providerId)),
            awsProfileName: config.awsProfileName || '',
            awsAuthnMode: config.awsAuthnMode || '',
            awsRegion: providers.resolveAwsRegion(providers.getProvider(providerId), config),
            // Only set for a provider with a chatBackend (Cursor): the result of
            // the last preflight of the thing that answers turns — for Cursor,
            // whether its CLI is installed on this server. Persisted so Settings
            // can still report "the CLI is missing" after a reload, rather than
            // only in the response to the test that discovered it.
            backendStatus: config.backendStatus || null
        };
    });
    return out;
}

/**
 * Resolve what a chat/sandbox request should actually use.
 *
 * Order is deliberate: stored settings win, then the environment. That ordering
 * is what "we no longer rely on .env" means in practice — the env var is a
 * fallback for installs that have not configured a provider yet, not a
 * competing source that can override what the user picked in the UI.
 *
 * Returns { ok, providerId, provider, model, apiKey, baseUrl, source } or
 * { ok:false, reason, ... } with a message the UI can show verbatim.
 */
function resolveActive(settings, env) {
    let environment = env || process.env;
    let providerId = settings && settings.activeProviderId;

    if (providerId) {
        let provider = providers.getProvider(providerId);
        if (!provider) {
            return {
                ok: false,
                reason: 'unknown_provider',
                message: 'The configured LLM provider "' + providerId + '" is not recognised. ' +
                    'Pick a provider again in Settings.'
            };
        }
        if (provider.inference === false) {
            return {
                ok: false,
                reason: 'provider_not_inference',
                providerId: providerId,
                message: provider.label + ' cannot be used for chat. ' + (provider.inferenceNote || '')
            };
        }
        let config = getProviderConfig(settings, providerId) || {};
        // A provider may authenticate with a key or, for Bedrock, by signing with
        // one of the user's own AWS profiles. Which one is configured decides what
        // has to be present, so the source is resolved before either is demanded —
        // otherwise a profile-signed provider is refused for having no key.
        let credentialSource = providers.resolveCredentialSource(provider, config);
        let usesProfile = providers.usesAwsProfile(provider, config);
        let apiKey = usesProfile ? '' : getApiKey(settings, providerId);

        if (usesProfile && !config.awsProfileName) {
            return {
                ok: false,
                reason: 'missing_aws_profile',
                providerId: providerId,
                message: provider.label + ' is set to sign with an AWS profile, but no profile is ' +
                    'chosen. Pick one in Settings → AI features, or switch to an API key.'
            };
        }
        if (!usesProfile && providers.needsApiKey(provider, config) && !apiKey) {
            return {
                ok: false,
                reason: 'missing_key',
                providerId: providerId,
                message: 'No API key is stored for ' + provider.label +
                    '. Add one in Settings → Enable LLM.'
            };
        }
        let baseUrl = providers.resolveBaseUrl(provider, config);
        if (!baseUrl && providers.needsBaseUrl(provider)) {
            return {
                ok: false,
                reason: 'missing_base_url',
                providerId: providerId,
                message: provider.label + ' needs a base URL. Set it in Settings → Enable LLM.'
            };
        }
        let model = (settings && settings.activeModel) || '';
        if (!model) {
            return {
                ok: false,
                reason: 'missing_model',
                providerId: providerId,
                message: 'No model is selected for ' + provider.label + '. Pick one in Settings.'
            };
        }
        return {
            ok: true,
            source: 'settings',
            providerId: providerId,
            provider: provider,
            model: model,
            apiKey: apiKey,
            baseUrl: baseUrl,
            // Carried through so llmClient does not have to re-derive the same
            // decision from the settings file: 'api_key' or 'aws_profile', and for
            // the latter the profile to mint credentials from. `awsAuthnMode` may
            // be blank, which means "whichever mechanism the profile supports" —
            // credentialProvider already resolves that.
            credentialSource: credentialSource,
            awsProfileName: usesProfile ? config.awsProfileName : '',
            awsAuthnMode: usesProfile ? (config.awsAuthnMode || '') : '',
            awsRegion: providers.resolveAwsRegion(provider, config),
            // Non-null only for a provider that answers through a module instead
            // of an OpenAI-shaped endpoint (currently 'cursor-agent'). Carried on
            // the resolution rather than re-derived downstream, so llmClient and
            // chatService cannot disagree about which path a turn takes.
            chatBackend: providers.getChatBackend(provider)
        };
    }

    // Nothing configured in the UI — fall back to the legacy environment so an
    // existing deployment keeps chatting after this upgrade.
    if (environment.LLM_API_KEY) {
        let envProvider = providers.getProvider('openai');
        let envBase = environment.LLM_BASE_URL || (envProvider && envProvider.baseUrl);
        return {
            ok: true,
            source: 'env',
            providerId: 'openai',
            provider: envProvider,
            model: environment.LLM_MODEL || DEFAULT_ENV_MODEL,
            apiKey: environment.LLM_API_KEY,
            baseUrl: String(envBase || '').replace(/\/+$/, ''),
            // The fallback is always plain OpenAI with a pasted key, so never a
            // backend and never a profile — but the fields are present so callers
            // can read one shape regardless of which branch answered.
            credentialSource: providers.CREDENTIAL_SOURCE.API_KEY,
            awsProfileName: '',
            awsAuthnMode: '',
            awsRegion: '',
            chatBackend: null
        };
    }

    return {
        ok: false,
        reason: 'not_configured',
        message: 'No LLM provider is configured. Open Settings → Enable LLM to choose a provider ' +
            'and add or create an API key.'
    };
}

module.exports = {
    LLM_DIR_NAME: LLM_DIR_NAME,
    SETTINGS_FILE_NAME: SETTINGS_FILE_NAME,
    DEFAULT_ENV_MODEL: DEFAULT_ENV_MODEL,
    getSettingsFile: getSettingsFile,
    emptySettings: emptySettings,
    load: load,
    save: save,
    getProviderConfig: getProviderConfig,
    getApiKey: getApiKey,
    setProviderConfig: setProviderConfig,
    toPublic: toPublic,
    resolveActive: resolveActive,
    MAX_CUSTOM_MODELS: MAX_CUSTOM_MODELS,
    sanitizeCustomModels: sanitizeCustomModels,
    rememberCustomModel: rememberCustomModel
};
