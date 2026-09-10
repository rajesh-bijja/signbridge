"use strict";

/**
 * modelCatalog.js — turn each provider's model list into one shape, and drop the
 * models that cannot answer a chat turn.
 *
 * Pure: response object in, normalised array out. No I/O, so the awkward parts
 * (which models are chat models, how a provider names them) are unit-testable
 * without a key.
 *
 * The filtering is the part that matters. `GET /v1/models` on OpenAI returns
 * every model on the account — embeddings, transcription, text-to-speech, image
 * generation, moderation — and a picker offering `text-embedding-3-small` as a
 * chat model is simply broken. Providers do not flag capability consistently
 * (OpenRouter does, in `architecture.output_modalities`; OpenAI does not at
 * all), so this is a deny-list of families known not to do chat, applied on top
 * of any capability metadata the provider does give us.
 *
 * A deny-list, not an allow-list, is the deliberate choice: new model families
 * appear constantly and an allow-list would hide a model the day it ships, which
 * is the failure the user would actually notice. The cost of being wrong the
 * other way is one unusable entry in a searchable list.
 */

// Substrings that identify a non-chat model family across providers. Matched
// case-insensitively against the model id.
const NON_CHAT_PATTERNS = [
    'embedding', 'embed-', 'text-embedding',
    // 'realtime' rather than 'realtime-preview': the realtime family is a
    // bidirectional audio/WebSocket surface, not a chat-completions model, and it
    // outlived the "-preview" suffix (gpt-realtime-2.1 is GA).
    'whisper', 'transcribe', 'speech', 'tts', 'audio-preview', 'realtime',
    'dall-e', 'image-generation', 'gpt-image', 'imagen', 'stable-diffusion', 'flux',
    'moderation', 'omni-moderation', 'guard',
    'rerank', 'similarity', 'search-query', 'search-document',
    'codestral-embed', 'veo-', 'video',
    'aqa', 'gemini-embedding',
    // Bedrock hosts every modality behind one model list, so its image and video
    // families arrive alongside Claude. 'titan-embed' and 'cohere.embed' are
    // already caught by 'embed-'/'embedding' above; these are not.
    'image-generator', 'nova-canvas', 'nova-reel', 'nova-sonic'
];

// Models that answer on a DIFFERENT endpoint than chat-completions: the legacy
// /v1/completions family, and the ids OpenAI serves only on /v1/responses.
// Picking one produced the provider's own opaque rejection —
//   404 This is not a chat model and thus not supported in the v1/chat/completions endpoint
//   400 ... use /v1/responses ...
// — so they are dropped from the picker rather than left to fail at turn time.
// (lib/chat/modelCompat.js is the backstop for the ones not listed here.)
//
// Matched as a prefix of the *bare* id (after any "openai/" provider prefix), not
// as a substring, and that distinction is load-bearing: the tempting pattern
// '-instruct' would also delete `mistralai/mistral-7b-instruct` and every other
// instruct-tuned chat model on OpenRouter, which is a far worse outcome than one
// stale entry. A prefix also covers the dated variants (…-instruct-0914) for free.
const NON_CHAT_ENDPOINT_PREFIXES = [
    // Legacy /v1/completions
    'gpt-3.5-turbo-instruct',
    'davinci-002', 'babbage-002',
    'text-davinci-', 'text-curie-', 'text-babbage-', 'text-ada-',
    'code-davinci-', 'code-cushman-',
    // /v1/responses only
    'codex-mini', 'gpt-5-codex', 'computer-use-preview', 'o1-pro', 'o3-pro'
];

// Substring-matched for the same reason as NON_CHAT_PATTERNS: the deep-research
// family is responses-only and its ids carry the suffix, not a prefix
// (o3-deep-research, o4-mini-deep-research).
const NON_CHAT_ENDPOINT_SUBSTRINGS = ['deep-research'];

// Ids that are chat models despite matching a pattern above. Kept tiny on
// purpose — every entry is a place the heuristic was wrong.
const CHAT_ALLOW_EXACT = [];

// Strip a provider prefix like "openai/" so OpenRouter-style ids classify too.
function bareId(value) {
    return value.indexOf('/') >= 0 ? value.slice(value.lastIndexOf('/') + 1) : value;
}

function isChatModel(id, meta) {
    if (!id) {
        return false;
    }
    let value = String(id).toLowerCase();

    if (CHAT_ALLOW_EXACT.indexOf(value) >= 0) {
        return true;
    }

    // Wrong-endpoint models are excluded before any capability metadata is
    // consulted: they genuinely do output text, so a provider that reports
    // modalities would happily wave them through.
    let bare = bareId(value);
    let wrongEndpoint = NON_CHAT_ENDPOINT_PREFIXES.some(function (prefix) {
        return bare.indexOf(prefix) === 0;
    }) || NON_CHAT_ENDPOINT_SUBSTRINGS.some(function (part) {
        return bare.indexOf(part) >= 0;
    });
    if (wrongEndpoint) {
        return false;
    }

    // Trust explicit capability metadata over the name when a provider supplies
    // it. OpenRouter reports output modalities; a model that cannot output text
    // cannot answer a chat turn whatever it is called.
    if (meta && meta.architecture) {
        let outputs = meta.architecture.output_modalities;
        if (Array.isArray(outputs) && outputs.length && outputs.indexOf('text') < 0) {
            return false;
        }
    }
    // Google reports supported methods; generateContent is the chat surface.
    if (meta && Array.isArray(meta.supportedGenerationMethods)) {
        return meta.supportedGenerationMethods.indexOf('generateContent') >= 0;
    }

    return !NON_CHAT_PATTERNS.some(function (pattern) {
        return value.indexOf(pattern) >= 0;
    });
}

// Reasoning models take `reasoning_effort` and reject `temperature`. This is the
// same rule llmClient used, kept here so it applies to every provider's models
// rather than only to whatever was in config.properties.
function isReasoningModel(id) {
    if (!id) {
        return false;
    }
    let bare = bareId(String(id).toLowerCase());
    return /^o\d/.test(bare) ||
        bare.indexOf('o-') === 0 ||
        bare.indexOf('gpt-5') === 0 ||
        bare.indexOf('reasoning') >= 0 ||
        /(^|[^a-z])(thinking)([^a-z]|$)/.test(bare);
}

function toNumberOrNull(value) {
    let n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Per-1M-token price, which is the unit every provider's pricing page quotes.
// OpenRouter reports per-token strings like "0.00000004".
function perMillion(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    return Math.round(n * 1000000 * 10000) / 10000;
}

function normalizeOpenAi(body) {
    let rows = (body && Array.isArray(body.data)) ? body.data : [];
    return rows.map(function (row) {
        let id = row && (row.id || row.name);
        if (!id) {
            return null;
        }
        let model = {
            id: String(id),
            label: row.name && row.name !== id ? String(row.name) : String(id),
            contextLength: toNumberOrNull(row.context_length || row.context_window ||
                (row.top_provider && row.top_provider.context_length)),
            createdAt: row.created ? new Date(row.created * 1000).toISOString() : null,
            ownedBy: row.owned_by || null,
            chat: isChatModel(id, row),
            reasoning: isReasoningModel(id)
        };
        if (row.pricing) {
            let inputPrice = perMillion(row.pricing.prompt);
            let outputPrice = perMillion(row.pricing.completion);
            if (inputPrice !== null || outputPrice !== null) {
                model.pricing = { inputPerMillion: inputPrice, outputPerMillion: outputPrice };
            }
        }
        if (row.description) {
            model.description = String(row.description).slice(0, 300);
        }
        return model;
    }).filter(Boolean);
}

function normalizeAnthropic(body) {
    let rows = (body && Array.isArray(body.data)) ? body.data : [];
    return rows.map(function (row) {
        let id = row && row.id;
        if (!id) {
            return null;
        }
        let caps = row.capabilities || {};
        return {
            id: String(id),
            label: row.display_name ? String(row.display_name) : String(id),
            contextLength: toNumberOrNull(row.max_input_tokens),
            maxOutputTokens: toNumberOrNull(row.max_tokens),
            createdAt: row.created_at || null,
            ownedBy: 'anthropic',
            // Every model the Claude API lists is a chat model.
            chat: true,
            // Anthropic reports this properly, so use it rather than guessing
            // from the id.
            reasoning: !!(caps.thinking && caps.thinking.supported),
            supportsTools: caps.structured_outputs ? !!caps.structured_outputs.supported : true
        };
    }).filter(Boolean);
}

function normalizeOllama(body) {
    let rows = (body && Array.isArray(body.models)) ? body.models : [];
    return rows.map(function (row) {
        let id = row && (row.name || row.model);
        if (!id) {
            return null;
        }
        return {
            id: String(id),
            label: String(id),
            contextLength: null,
            ownedBy: 'ollama',
            chat: isChatModel(id, row),
            reasoning: isReasoningModel(id),
            local: true
        };
    }).filter(Boolean);
}

/**
 * Cursor's model list, which arrives as `{ items: [{ id, displayName, … }] }`.
 *
 * `items` is the envelope the live API actually returns — an earlier version read
 * only `models`/`data` and therefore normalised every response to an empty list,
 * i.e. the picker was silently blank for a perfectly good key. The other two keys
 * are kept as fallbacks rather than removed, since they cost one branch each.
 *
 * Every row is selectable: the ids here are exactly what the Cursor CLI's
 * `--model` flag takes, and this provider answers through that CLI
 * (`chatBackend: 'cursor-agent'`), so `chat: true` unconditionally — the same
 * call normalizeAnthropic makes, and for the same reason. Do not run these
 * through isChatModel(): Cursor's ids are display-ish names ("Auto",
 * `auto-smart`) rather than API model names, so the deny-list has no purchase on
 * them and could only produce false negatives.
 *
 * `variants` (a row's thinking/max siblings) is deliberately not expanded into
 * separate entries — the CLI accepts the base id, and inventing composite ids
 * that `--model` might reject would fail at turn time rather than here.
 */
function normalizeCursor(body) {
    let rows = [];
    if (body && Array.isArray(body.items)) {
        rows = body.items;
    } else if (body && Array.isArray(body.models)) {
        rows = body.models;
    } else if (body && Array.isArray(body.data)) {
        rows = body.data;
    }
    return rows.map(function (row) {
        let id = typeof row === 'string' ? row : (row && (row.id || row.name || row.model));
        if (!id) {
            return null;
        }
        return {
            id: String(id),
            label: (row && (row.displayName || row.display_name))
                ? String(row.displayName || row.display_name)
                : String(id),
            ownedBy: 'cursor',
            chat: true,
            reasoning: isReasoningModel(id)
        };
    }).filter(Boolean);
}

const NORMALIZERS = {
    openai: normalizeOpenAi,
    anthropic: normalizeAnthropic,
    ollama: normalizeOllama,
    cursor: normalizeCursor
};

/**
 * Normalise a provider's model-list response.
 *
 * `options.chatOnly` (default true) drops non-chat models. Sorting puts chat
 * models first, then newest, then alphabetical — a picker whose first entries
 * are the newest usable models needs no scrolling in the common case.
 */
function normalizeModels(shape, body, options) {
    let opts = options || {};
    let normalizer = NORMALIZERS[shape] || normalizeOpenAi;
    let models = normalizer(body);
    if (opts.chatOnly !== false) {
        let chatModels = models.filter(function (m) {
            return m.chat;
        });
        // If the filter removed everything, the heuristic is wrong for this
        // provider — an empty picker is a worse outcome than an imperfect one, so
        // fall back to the unfiltered list.
        models = chatModels.length ? chatModels : models;
    }
    return models.sort(function (a, b) {
        if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
            return a.createdAt < b.createdAt ? 1 : -1;
        }
        if (a.createdAt && !b.createdAt) {
            return -1;
        }
        if (!a.createdAt && b.createdAt) {
            return 1;
        }
        return a.id.localeCompare(b.id);
    });
}

/**
 * The search used by the model picker.
 *
 * Forgiving in the same way S3 World's search is, and for the same reason: a
 * search box that rejects input is worse than one that matches too much. Terms
 * are split on whitespace and ALL must appear somewhere in the id, label or
 * owner — so "claude opus" finds `anthropic/claude-opus-4` regardless of the
 * order typed, and "4o" finds `gpt-4o`. Case-insensitive throughout.
 */
function filterModels(models, query) {
    let rows = Array.isArray(models) ? models : [];
    let text = (query === null || query === undefined) ? '' : String(query).trim().toLowerCase();
    if (!text) {
        return rows.slice();
    }
    let terms = text.split(/\s+/).filter(Boolean);
    return rows.filter(function (model) {
        let haystack = [model.id, model.label, model.ownedBy, model.description]
            .filter(Boolean).join(' ').toLowerCase();
        return terms.every(function (term) {
            return haystack.indexOf(term) >= 0;
        });
    });
}

/**
 * Pick a sensible default when the user has verified a key but not yet chosen a
 * model.
 *
 * Making them choose from three hundred OpenRouter models before they can send a
 * message is the kind of "correctness" that reads as breakage, so the picker is
 * pre-filled and remains freely changeable. The preference list is ordered by
 * capability-for-this-workload — SignBridge's agent needs solid tool calling, so a
 * flagship beats a mini — and matched as a substring so it keeps working as
 * version suffixes change (`gpt-5.4-2026-03-05` matches `gpt-5`).
 *
 * `-mini`/`-nano`/`-lite`/`-8b` are deliberately *not* in the list: they are
 * matched only by the trailing fallbacks, so a small model is chosen when it is
 * all that is on offer, never in preference to a larger sibling.
 */
const PREFERRED_MODEL_PATTERNS = [
    'gpt-5', 'claude-opus', 'claude-sonnet', 'gemini-2.5-pro', 'gemini-2.0-pro',
    'grok-4', 'grok-3', 'deepseek-chat', 'deepseek-reasoner',
    'mistral-large', 'llama-3.3-70b', 'gpt-4.1', 'gpt-4o'
];

function recommendModel(models) {
    let rows = Array.isArray(models) ? models.filter(function (m) { return m && m.id; }) : [];
    if (!rows.length) {
        return null;
    }
    for (let i = 0; i < PREFERRED_MODEL_PATTERNS.length; i += 1) {
        let pattern = PREFERRED_MODEL_PATTERNS[i];
        let match = rows.find(function (model) {
            return String(model.id).toLowerCase().indexOf(pattern) >= 0;
        });
        if (match) {
            return match.id;
        }
    }
    // Nothing recognised — normalizeModels already sorted newest first, so the
    // head of the list is the least-bad guess.
    return rows[0].id;
}

module.exports = {
    NON_CHAT_PATTERNS: NON_CHAT_PATTERNS,
    NON_CHAT_ENDPOINT_PREFIXES: NON_CHAT_ENDPOINT_PREFIXES,
    PREFERRED_MODEL_PATTERNS: PREFERRED_MODEL_PATTERNS,
    recommendModel: recommendModel,
    isChatModel: isChatModel,
    isReasoningModel: isReasoningModel,
    normalizeModels: normalizeModels,
    filterModels: filterModels,
    perMillion: perMillion
};
