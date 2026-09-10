"use strict";

/**
 * llmSettings.js — file-backed LLM configuration for one local user.
 *
 * Lives at <userDir>/llm/settings.json, alongside the other per-user artifacts,
 * and is the *only* source of the whole LLM configuration — the on/off switch, the
 * provider, the credential, the model and the agent's behavioural knobs. Nothing
 * in config.properties, docker-compose.yml or the environment gates or overrides
 * any of it, and nothing needs a restart: a turn resolves the stored settings when
 * it runs, so a change made in Settings applies to the next message.
 *
 * That is a deliberate reversal. The switch and the knobs used to live in
 * config.properties [llm] (with an LLM_ENABLED override), which meant the toggle
 * on the Settings page was decorative — resolveActive never read it — while the
 * value that actually decided could only be changed by editing a file and
 * restarting the server. The credential was the same story in a worse form.
 *
 * Three rules the rest of the codebase depends on:
 *
 *   0. `resolveActive()` is the single decision point for "what will answer this
 *      turn", including whether anything will. Do not add a second gate anywhere,
 *      and do not read a config key or an environment variable for one.
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

function getLlmDir(userName) {
    return path.join(paths.getUserDir(userName), LLM_DIR_NAME);
}

function getSettingsFile(userName) {
    return path.join(getLlmDir(userName), SETTINGS_FILE_NAME);
}

// The agent's behavioural knobs, and their bounds.
//
// Every one of these is a number or a word that goes straight into a provider
// request, so a bad value is a 400 from the provider rather than a visible
// mistake in the form. They are clamped rather than rejected: a settings write
// that fails because temperature is 3 leaves the user with a Settings page that
// will not save and no indication of which field is at fault, whereas a clamp
// stores something usable and shows it back.
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];
const DEFAULT_REASONING_EFFORT = '';   // blank = whatever the provider defaults to
const DEFAULT_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const DEFAULT_MAX_TOOL_ITERATIONS = 8;
const MAX_TOOL_ITERATIONS_CEILING = 30;

// Pure, exported and used by both the write path (llmService) and the read path
// (resolveActive), so a hand-edited settings file cannot put a value into a
// request that the form would have refused.
function sanitizeReasoningEffort(value) {
    let effort = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    return REASONING_EFFORTS.indexOf(effort) === -1 ? DEFAULT_REASONING_EFFORT : effort;
}

function sanitizeTemperature(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) {
        return DEFAULT_TEMPERATURE;
    }
    return Math.min(MAX_TEMPERATURE, Math.max(0, n));
}

function sanitizeMaxToolIterations(value) {
    let n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) {
        return DEFAULT_MAX_TOOL_ITERATIONS;
    }
    return Math.min(MAX_TOOL_ITERATIONS_CEILING, n);
}

function emptySettings() {
    return {
        // Default on, because the switch is now the *only* switch: there is no
        // config key or environment variable behind it that a deployment could
        // have used to turn AI features on. A fresh install therefore reports the
        // useful `not_configured` ("pick a provider") rather than `disabled`
        // ("turn on a toggle, then pick a provider"), which is two steps to say
        // the same thing. Turning it off is a deliberate act in Settings, and it
        // sticks.
        enabled: true,
        activeProviderId: null,
        activeModel: null,
        // The agent's behavioural knobs. These used to be read from
        // config.properties at module load, which meant changing one was a file
        // edit and a restart. They are settings like everything else now.
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        temperature: DEFAULT_TEMPERATURE,
        maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
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
        // Sanitised on the way out as well as on the way in, so the form always
        // renders the value a turn would actually use.
        reasoningEffort: sanitizeReasoningEffort(settings && settings.reasoningEffort),
        temperature: sanitizeTemperature(settings && settings.temperature),
        maxToolIterations: sanitizeMaxToolIterations(settings && settings.maxToolIterations),
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
 * The stored settings are the ONLY source. There is deliberately no environment
 * fallback: a provider key read from the environment is a secret sitting in a
 * process listing, a shell history and whatever orchestrator template set it,
 * and it cannot be verified, masked, rotated or attributed to a provider the way
 * a key entered in Settings can. So an install with no configured provider is
 * `not_configured`, and the UI says exactly what to do about it rather than
 * quietly chatting as OpenAI with a key nobody chose in the app.
 *
 * That includes the on/off switch and the behavioural knobs, not just the
 * credential. `settings.enabled` is checked here and nowhere else, which is the
 * point: the switch the user sees in Settings is the switch that decides, it takes
 * effect on the next turn, and no config key or environment variable can gate it
 * or override it. It used to be read from config.properties by llmClient while
 * this function ignored the stored value entirely — so the toggle in the UI did
 * nothing and turning chat back on meant editing a file and restarting.
 *
 * Returns { ok, providerId, provider, model, apiKey, baseUrl, source,
 * reasoningEffort, temperature, maxToolIterations } or { ok:false, reason, ... }
 * with a message the UI can show verbatim.
 */
function resolveActive(settings) {
    let providerId = settings && settings.activeProviderId;

    // `enabled` is undefined only for a settings file written before it existed;
    // emptySettings() supplies `true` for a fresh one. Treating undefined as on
    // matches that default, so an upgrade does not silently turn chat off.
    let enabled = !settings || settings.enabled === undefined || settings.enabled === null
        ? true
        : !!settings.enabled;
    if (!enabled) {
        return {
            ok: false,
            reason: 'disabled',
            providerId: providerId || null,
            message: 'AI features are turned off. Turn on "Enable AI features" in ' +
                'Settings → AI features to use chat.'
        };
    }

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
                    '. Add one in Settings → AI features.'
            };
        }
        let baseUrl = providers.resolveBaseUrl(provider, config);
        if (!baseUrl && providers.needsBaseUrl(provider)) {
            return {
                ok: false,
                reason: 'missing_base_url',
                providerId: providerId,
                message: provider.label + ' needs a base URL. Set it in Settings → AI features.'
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
            chatBackend: providers.getChatBackend(provider),
            // The behavioural knobs travel with the resolution for the same reason
            // the credential does: they are per-request settings the user can
            // change while the server runs, so nothing downstream may cache them.
            reasoningEffort: sanitizeReasoningEffort(settings && settings.reasoningEffort),
            temperature: sanitizeTemperature(settings && settings.temperature),
            maxToolIterations: sanitizeMaxToolIterations(settings && settings.maxToolIterations)
        };
    }

    return {
        ok: false,
        reason: 'not_configured',
        message: 'No AI provider is configured. Open Settings → AI features, pick a provider ' +
            'and add its API key (or, for AWS Bedrock, sign with an AWS profile you already have).'
    };
}

module.exports = {
    LLM_DIR_NAME: LLM_DIR_NAME,
    SETTINGS_FILE_NAME: SETTINGS_FILE_NAME,
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
    rememberCustomModel: rememberCustomModel,
    REASONING_EFFORTS: REASONING_EFFORTS,
    MAX_TEMPERATURE: MAX_TEMPERATURE,
    MAX_TOOL_ITERATIONS_CEILING: MAX_TOOL_ITERATIONS_CEILING,
    DEFAULT_MAX_TOOL_ITERATIONS: DEFAULT_MAX_TOOL_ITERATIONS,
    sanitizeReasoningEffort: sanitizeReasoningEffort,
    sanitizeTemperature: sanitizeTemperature,
    sanitizeMaxToolIterations: sanitizeMaxToolIterations
};
