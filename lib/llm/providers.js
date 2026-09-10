"use strict";

/**
 * providers.js — the LLM provider registry.
 *
 * One row per provider, and adding a provider is *only* a row here (plus a
 * mirror entry in frontend/src/llmProviders.js for the labels). This is the same
 * shape as lib/authnModes.js for a reason: the alternative is a switch on
 * provider id in the settings handler, the test-connection handler, the
 * model-list handler and the chat client, which is four places that must agree
 * about base URLs and auth headers.
 *
 * What actually varies between providers is small:
 *
 *   1. baseUrl        — where requests go
 *   2. auth           — how the key is presented ('bearer' | 'x-api-key' | 'query' | 'basic' | 'none')
 *   3. modelsPath     — the model-list endpoint, and `modelsShape` its response shape
 *   4. consoleUrl     — where the user creates a key, when one is needed
 *
 * Everything else — chat completions, tool calling, streaming — is the OpenAI
 * wire format, because Anthropic, Google and Bedrock all publish
 * OpenAI-compatible endpoints and the rest of the field standardised on it. So
 * `kind: 'openai'` covers eleven of the twelve rows and there is exactly one
 * chat code path.
 *
 * The twelfth is Cursor, and it introduces the one other axis:
 *
 *   5. chatBackend    — a named module that answers a turn instead of an
 *                       OpenAI-shaped POST. Only Cursor sets it
 *                       ('cursor-agent' -> lib/chat/cursorAgent.js), because
 *                       Cursor sells an agent rather than model access. A row
 *                       with a chatBackend gets no OpenAI client at all
 *                       (lib/chat/llmClient.js skips construction) and
 *                       lib/chat/chatService.js dispatches to the module.
 *
 * Adding a *provider* is still just a row. Adding a chatBackend is a module and
 * a branch, so don't reach for one unless the provider genuinely has no
 * chat-completions endpoint.
 *
 * Declaration order is display order in the picker.
 */

// How a provider's key is obtained. Deliberately only two values:
//
//   'console' — the user creates the key in the provider's own console and
//               pastes it here. We deep-link straight to the page.
//   'none'    — no key at all (a local runtime).
//
// SignBridge is **not** a broker for provider credentials, and earlier versions
// were: OpenRouter had an OAuth/PKCE flow where SignBridge created a key on the
// user's behalf, and OpenAI had a "mint" flow where the user pasted an
// organisation admin key (sk-admin-…) so SignBridge could create a project
// service-account key from it. Both were removed on purpose. They were a
// man-in-the-middle between the user and their provider account: two more code
// paths that could hold a credential, one of them a credential that *creates
// more credentials*, in exchange for saving a copy-paste. They also made the
// setup story different for every provider, so the one screen a new user has to
// understand read differently depending on which row they clicked.
//
// The uniform flow is: paste a key you have, or follow the provider link,
// create one there, come back and paste it. Do not reintroduce a flow where
// SignBridge creates or exchanges a provider credential.
const ACQUISITION = {
    CONSOLE: 'console',
    NONE: 'none'
};

// Response shapes for model listing. 'openai' = { data: [{ id }] },
// 'anthropic' = { data: [{ id, display_name }] } (same envelope, richer rows),
// 'ollama' = { models: [{ name }] },
// 'cursor' = { items: [{ id, displayName, parameters, variants }] }.
const MODELS_SHAPE = {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    OLLAMA: 'ollama',
    CURSOR: 'cursor'
};

// Where a provider's credentials come from. Only Bedrock has a choice, because
// only Bedrock is an AWS service SignBridge already holds credentials for.
//
//   'api_key'     — a key the user pasted, sent as this provider's auth header.
//                   Every other provider is implicitly this.
//   'aws_profile' — SigV4-signed with a SignBridge profile (IAM user, SSO role,
//                   EC2 instance role, or EKS IRSA service account). No key is
//                   stored, and short-lived credentials are re-minted per request.
const CREDENTIAL_SOURCE = {
    API_KEY: 'api_key',
    AWS_PROFILE: 'aws_profile'
};

const PROVIDERS = [
    {
        id: 'openai',
        label: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        auth: 'bearer',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyPrefixes: ['sk-'],
        keyPlaceholder: 'sk-proj-…',
        consoleUrl: 'https://platform.openai.com/api-keys',
        signInUrl: 'https://platform.openai.com/login',
        acquisition: ACQUISITION.CONSOLE,
        docsNote: 'Chat, tool calling and Sandbox are all supported.'
    },
    {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        kind: 'openai',
        // Anthropic's OpenAI-SDK compatibility layer lives at the same /v1 root
        // as the native API, so one base URL serves both the native model list
        // and OpenAI-format chat completions.
        baseUrl: 'https://api.anthropic.com/v1',
        auth: 'x-api-key',
        extraHeaders: { 'anthropic-version': '2023-06-01' },
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.ANTHROPIC,
        inference: true,
        keyPrefixes: ['sk-ant-'],
        keyPlaceholder: 'sk-ant-api03-…',
        consoleUrl: 'https://platform.claude.com/settings/keys',
        signInUrl: 'https://platform.claude.com/login',
        acquisition: ACQUISITION.CONSOLE,
        // Checked against the Admin API reference: api_keys supports list, get
        // and update — there is no create. So a key cannot be minted for the
        // user, and the honest UI is a deep link plus a paste field.
        acquisitionNote: 'Anthropic has no API for creating API keys — its Admin API can list ' +
            'and revoke them but not create them. Create one in the Console and paste it here.',
        // Anthropic labels the OpenAI-compatible endpoint as a testing aid
        // rather than a production surface. Surfacing that is better than
        // letting someone discover it as flaky behaviour later.
        docsNote: 'Reached through Anthropic\'s OpenAI-compatibility endpoint, which Anthropic ' +
            'describes as intended for evaluation rather than production. Tool calling works; ' +
            'Claude-specific features (thinking, citations, prompt caching) are not exposed.'
    },
    {
        id: 'bedrock',
        label: 'AWS Bedrock (Claude)',
        // NOT 'openai', and that was measured rather than assumed. This row used
        // to point at bedrock-runtime's OpenAI-compatible surface
        // (/openai/v1/chat/completions) on the belief that it served Claude with a
        // Bedrock API key. Against the real service:
        //
        //   GET  /openai/v1/models        -> 404 <UnknownOperationException/>
        //   POST /openai/v1/chat/completions with a Claude model
        //                                 -> 404 "doesn't support this API"
        //
        // That endpoint only accepts the OpenAI-authored models Bedrock hosts
        // (openai.gpt-oss-*), and the 404 on /models is a routing error, so it is
        // absent for every credential kind. Claude on Bedrock is reachable only
        // through the native Converse API, so this row is served by the adapter in
        // lib/llm/bedrockConverse.js — which presents Converse as the one method
        // the agent calls, so the tool loop and streaming stay unchanged.
        kind: 'bedrock',
        // Two ways to authenticate, and the profile is the point of the feature:
        // SignBridge already mints credentials for IAM users, SSO roles, EC2
        // instance roles and EKS IRSA service accounts, and Converse accepts SigV4
        // from any of them. So Claude can be reached with the *same* role a service
        // uses in the cluster — no inference key to create, rotate or leak, and the
        // spend lands on the AWS account that owns the role.
        credentialSources: [CREDENTIAL_SOURCE.AWS_PROFILE, CREDENTIAL_SOURCE.API_KEY],
        defaultCredentialSource: CREDENTIAL_SOURCE.AWS_PROFILE,
        // Region is a first-class field rather than something buried in a base URL.
        // Bedrock model availability is regional and model ids are region-scoped,
        // so this is a setting a user changes, not deployment plumbing.
        awsRegionDefault: 'us-east-1',
        // Only used by the api_key source. A Bedrock API key is presented as a plain
        // bearer token — the credential the AWS SDKs read from
        // AWS_BEARER_TOKEN_BEDROCK — and Converse accepts it too.
        auth: 'bearer',
        inference: true,
        // No modelsPath: the runtime host has no model-list route at all. The list
        // comes from the Bedrock CONTROL plane (ListInferenceProfiles +
        // ListFoundationModels), which the adapter owns. Either call may be denied
        // while invoke still works — an inference-scoped IRSA role is exactly that
        // — so a denied listing degrades to a curated fallback instead of blocking
        // the provider.
        modelsFromBackend: true,
        // No keyPrefixes: Bedrock issues both short- and long-term keys and
        // documents no stable prefix, so a check here could only ever produce a
        // spurious warning on a working key.
        keyPlaceholder: 'Your Bedrock API key',
        consoleUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
        signInUrl: 'https://console.aws.amazon.com/bedrock/',
        acquisition: ACQUISITION.CONSOLE,
        acquisitionNote: 'Only needed if you are NOT using an AWS profile. In the Bedrock console ' +
            'open API keys and generate a long-term key (short-term keys expire after 12 hours). ' +
            'Using a profile instead needs no key at all.',
        docsNote: 'Claude in your own AWS account, signed with one of your existing SignBridge ' +
            'profiles — IAM user, SSO role, EC2 instance role or EKS IRSA service account. Prompts ' +
            'stay inside your AWS boundary, usage is billed to that account, and there is no ' +
            'inference key to manage. The role needs bedrock:InvokeModel and ' +
            'bedrock:InvokeModelWithResponseStream on the models you pick.'
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        kind: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        auth: 'bearer',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        // The model list is public — no key needed — so the picker can show
        // hundreds of models (and their pricing) before the user has signed in.
        // Which is exactly why this row needs an authCheckPath: a successful
        // GET /models proves nothing about the key here, so testing the
        // connection against it would report a revoked key as working.
        modelsPublic: true,
        authCheckPath: '/key',
        inference: true,
        keyPrefixes: ['sk-or-'],
        keyPlaceholder: 'sk-or-v1-…',
        consoleUrl: 'https://openrouter.ai/keys',
        signInUrl: 'https://openrouter.ai/auth',
        acquisition: ACQUISITION.CONSOLE,
        docsNote: 'One key reaches OpenAI, Anthropic, Google, Meta, Mistral, xAI, DeepSeek and ' +
            'more, so it is the fewest keys for the widest model list.'
    },
    {
        id: 'google',
        label: 'Google Gemini',
        kind: 'openai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        auth: 'bearer',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyPrefixes: ['AIza'],
        keyPlaceholder: 'AIza…',
        consoleUrl: 'https://aistudio.google.com/apikey',
        signInUrl: 'https://aistudio.google.com/',
        acquisition: ACQUISITION.CONSOLE,
        docsNote: 'Reached through Google\'s OpenAI-compatibility endpoint.'
    },
    {
        id: 'cursor',
        label: 'Cursor',
        kind: 'cursor',
        baseUrl: 'https://api.cursor.com',
        auth: 'bearer',
        testPath: '/v1/me',
        modelsPath: '/v1/models',
        modelsShape: MODELS_SHAPE.CURSOR,
        // The one row that is not an OpenAI-shaped endpoint, and the only one
        // with a chatBackend.
        //
        // Cursor sells an agent, not model access. Its HTTP API is the Cloud
        // Agents API — POST /v1/agents creates a durable agent, POST
        // /v1/agents/{id}/runs starts a run, GET .../runs/{id}/stream streams it
        // — and there is no chat-completions endpoint: nothing that takes
        // `messages` + `tools` and hands back `tool_calls` for lib/chat/agent.js
        // to execute, and nowhere to return the results if it did. So a Cursor
        // key cannot answer a turn the way the other eleven rows do, however
        // valid it is. This row used to say `inference: false` for that reason.
        //
        // The way in is the other direction, and it is now built. SignBridge is
        // itself an MCP server exposing every dashboard tool, and Cursor's agent
        // consumes MCP — so rather than borrowing a model from Cursor we lend
        // Cursor the tools and let its own loop drive the real dashboard. The
        // backend spawns the local `agent` CLI, which keeps the whole thing on
        // this machine: the MCP server is a stdio child talking to
        // https://localhost:2443, so nothing has to be reachable from Cursor's
        // infrastructure. That reachability was the blocking problem with the
        // cloud route for a localhost-only app with no login.
        //
        // See lib/chat/cursorAgent.js for what this costs: the CLI must be
        // installed on the SignBridge server, and headless tool calls need
        // `--force`, which is why the agent runs in an empty scratch directory.
        inference: true,
        chatBackend: 'cursor-agent',
        // Not a warning against choosing it — it is a real option — but the two
        // things that differ from every other row, said before the user picks it
        // rather than after a turn fails.
        // One sentence. This renders as an alert above the key field, and a user
        // deciding whether to click the tile needs the difference, not the design.
        // The rest (forced tool approval, the scratch workspace, globally approved
        // MCP servers) is in the README — a Settings card is not the place for it.
        backendNote: 'Cursor has no chat API, so SignBridge answers these turns by running the ' +
            'Cursor CLI on this server with SignBridge\'s own tools. Test connection checks for it.',
        keyPrefixes: ['crsr_'],
        keyPlaceholder: 'crsr_…',
        consoleUrl: 'https://cursor.com/dashboard/api',
        signInUrl: 'https://cursor.com/api/auth/login',
        acquisition: ACQUISITION.CONSOLE,
        docsNote: 'Key validated against GET /v1/me; models come from GET /v1/models. Answers ' +
            'through the local Cursor CLI driving SignBridge\'s MCP tools.'
    },
    {
        id: 'groq',
        label: 'Groq',
        kind: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        auth: 'bearer',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyPrefixes: ['gsk_'],
        keyPlaceholder: 'gsk_…',
        consoleUrl: 'https://console.groq.com/keys',
        signInUrl: 'https://console.groq.com/login',
        acquisition: ACQUISITION.CONSOLE
    },
    {
        id: 'mistral',
        label: 'Mistral AI',
        kind: 'openai',
        baseUrl: 'https://api.mistral.ai/v1',
        auth: 'bearer',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyPlaceholder: 'Your Mistral API key',
        consoleUrl: 'https://console.mistral.ai/api-keys',
        signInUrl: 'https://console.mistral.ai/',
        acquisition: ACQUISITION.CONSOLE
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        kind: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        auth: 'bearer',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyPrefixes: ['sk-'],
        keyPlaceholder: 'sk-…',
        consoleUrl: 'https://platform.deepseek.com/api_keys',
        signInUrl: 'https://platform.deepseek.com/sign_in',
        acquisition: ACQUISITION.CONSOLE
    },
    {
        id: 'xai',
        label: 'xAI (Grok)',
        kind: 'openai',
        baseUrl: 'https://api.x.ai/v1',
        auth: 'bearer',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyPrefixes: ['xai-'],
        keyPlaceholder: 'xai-…',
        consoleUrl: 'https://console.x.ai/',
        signInUrl: 'https://console.x.ai/',
        acquisition: ACQUISITION.CONSOLE
    },
    {
        id: 'azure-openai',
        label: 'Azure OpenAI',
        kind: 'openai',
        // Tenant-specific: there is no default host, and the model id is the
        // user's deployment name. So baseUrl is required input, not a default.
        baseUrl: '',
        baseUrlRequired: true,
        baseUrlPlaceholder: 'https://<resource>.openai.azure.com/openai/v1',
        auth: 'api-key',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyPlaceholder: 'Your Azure OpenAI key',
        consoleUrl: 'https://portal.azure.com/',
        acquisition: ACQUISITION.CONSOLE,
        docsNote: 'Enter your resource endpoint as the base URL. Models are your deployment names.'
    },
    {
        id: 'ollama',
        label: 'Ollama (local)',
        kind: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        baseUrlEditable: true,
        auth: 'none',
        modelsPath: '/models',
        modelsShape: MODELS_SHAPE.OPENAI,
        inference: true,
        keyless: true,
        acquisition: ACQUISITION.NONE,
        docsNote: 'No API key. Requires Ollama running locally with a tool-calling model pulled. ' +
            'From Docker, use http://host.docker.internal:11434/v1.'
    }
];

let byId = {};
PROVIDERS.forEach(function (p) {
    byId[p.id] = p;
});

function listProviders() {
    return PROVIDERS.slice();
}

function getProvider(id) {
    return byId[id] || null;
}

function isKnownProvider(id) {
    return !!byId[id];
}

// Providers that can actually answer a chat turn. Every current row can — but
// the distinction is kept rather than deleted, because it is the honest way to
// add a provider that sells something other than inference (embeddings, a
// vector store, an agent with no MCP support). Callers resolving a model for
// Chat must use this rather than listProviders(), so a row that cannot respond
// can never become the active one.
function listInferenceProviders() {
    return PROVIDERS.filter(function (p) {
        return p.inference !== false;
    });
}

// The named module that answers a turn for this provider, or null for the
// ordinary OpenAI-shaped path. See the `chatBackend` note in the header.
function getChatBackend(provider) {
    return (provider && provider.chatBackend) ? provider.chatBackend : null;
}

// The effective base URL for a provider given the user's saved config: an
// explicit override wins, else the registry default. Azure and Ollama are the
// reason overrides exist at all.
function resolveBaseUrl(provider, config) {
    let override = config && config.baseUrl ? String(config.baseUrl).trim() : '';
    if (override) {
        return override.replace(/\/+$/, '');
    }
    return (provider && provider.baseUrl ? provider.baseUrl : '').replace(/\/+$/, '');
}

// Whether a key *looks* like it belongs to this provider. Advisory only — it
// produces a warning, never a rejection. Providers rotate key formats without
// notice (OpenAI has shipped sk-, sk-proj-, sk-svcacct-), and refusing a key
// that would have worked is a worse failure than sending one that gets a clean
// 401 from the provider a second later.
function looksLikeKey(provider, key) {
    if (!provider || !key) {
        return true;
    }
    let prefixes = provider.keyPrefixes;
    if (!prefixes || !prefixes.length) {
        return true;
    }
    let value = String(key).trim();
    return prefixes.some(function (prefix) {
        return value.indexOf(prefix) === 0;
    });
}

// Auth headers for a provider+key. Kept here so the test-connection path, the
// model-list path and the chat client cannot disagree about, say, whether
// Anthropic wants `x-api-key` or `Authorization`.
function buildAuthHeaders(provider, apiKey) {
    let headers = {};
    if (provider && provider.extraHeaders) {
        Object.keys(provider.extraHeaders).forEach(function (name) {
            headers[name] = provider.extraHeaders[name];
        });
    }
    if (!provider || !apiKey || provider.auth === 'none') {
        return headers;
    }
    if (provider.auth === 'x-api-key') {
        headers['x-api-key'] = apiKey;
    } else if (provider.auth === 'api-key') {
        headers['api-key'] = apiKey;
    } else if (provider.auth === 'basic') {
        // Cursor's other APIs accept the key as the basic-auth username with an
        // empty password.
        headers.Authorization = 'Basic ' + Buffer.from(String(apiKey) + ':').toString('base64');
    } else {
        headers.Authorization = 'Bearer ' + apiKey;
    }
    return headers;
}

// The credential sources a provider offers, defaulting to the api-key-only shape
// every non-Bedrock row has. Returned as a list so the UI renders a choice only
// where one exists.
// Whether this provider needs a base URL before it can be used. A row that
// declares neither a default nor `baseUrlRequired` derives its endpoint itself —
// Bedrock builds it from the region, since the host carries the region and the
// path carries the model id. Demanding a base URL from such a row would be asking
// the user for something the adapter already knows.
function needsBaseUrl(provider) {
    if (!provider) {
        return false;
    }
    return !!(provider.baseUrl || provider.baseUrlRequired);
}

function listCredentialSources(provider) {
    if (provider && Array.isArray(provider.credentialSources) && provider.credentialSources.length) {
        return provider.credentialSources.slice();
    }
    if (provider && provider.keyless) {
        return [];
    }
    return [CREDENTIAL_SOURCE.API_KEY];
}

// Which source a saved config actually uses. A stored value only counts if the
// provider offers it, so a row that drops a source cannot leave a config pointing
// at one that no longer exists.
function resolveCredentialSource(provider, config) {
    let available = listCredentialSources(provider);
    if (!available.length) {
        return null;
    }
    let stored = config && config.credentialSource;
    if (stored && available.indexOf(stored) !== -1) {
        return stored;
    }
    if (provider && provider.defaultCredentialSource &&
        available.indexOf(provider.defaultCredentialSource) !== -1) {
        return provider.defaultCredentialSource;
    }
    return available[0];
}

function usesAwsProfile(provider, config) {
    return resolveCredentialSource(provider, config) === CREDENTIAL_SOURCE.AWS_PROFILE;
}

// Whether this provider+config needs a stored API key before it can be used.
// Replaces the bare `!apiKey && !provider.keyless` test that was repeated in
// resolveActive, testConnection and listModels — all three of which would
// otherwise demand a key from a Bedrock row that signs with a profile.
function needsApiKey(provider, config) {
    if (!provider || provider.keyless) {
        return false;
    }
    return !usesAwsProfile(provider, config);
}

// The AWS region for a provider+config. Only meaningful for a row that declares
// awsRegionDefault (Bedrock).
function resolveAwsRegion(provider, config) {
    let stored = config && config.awsRegion ? String(config.awsRegion).trim() : '';
    if (stored) {
        return stored;
    }
    return (provider && provider.awsRegionDefault) || '';
}

module.exports = {
    ACQUISITION: ACQUISITION,
    CREDENTIAL_SOURCE: CREDENTIAL_SOURCE,
    MODELS_SHAPE: MODELS_SHAPE,
    PROVIDERS: PROVIDERS,
    listProviders: listProviders,
    listInferenceProviders: listInferenceProviders,
    getChatBackend: getChatBackend,
    getProvider: getProvider,
    isKnownProvider: isKnownProvider,
    resolveBaseUrl: resolveBaseUrl,
    needsBaseUrl: needsBaseUrl,
    listCredentialSources: listCredentialSources,
    resolveCredentialSource: resolveCredentialSource,
    usesAwsProfile: usesAwsProfile,
    needsApiKey: needsApiKey,
    resolveAwsRegion: resolveAwsRegion,
    looksLikeKey: looksLikeKey,
    buildAuthHeaders: buildAuthHeaders
};
