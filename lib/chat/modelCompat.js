'use strict';

/**
 * Model/endpoint compatibility for chat-completions calls.
 *
 * Two provider errors are not bugs in SignBridge and not fixable by retrying the
 * same request, but both arrive as an opaque provider dump that says nothing about
 * what the user should do next:
 *
 *   400 Function tools with reasoning_effort are not supported for <model> in
 *       /v1/chat/completions. To use function tools, use /v1/responses or set
 *       reasoning_effort to 'none'.
 *   404 This is not a chat model and thus not supported in the v1/chat/completions
 *       endpoint. Did you mean to use v1/completions?
 *
 * The first one is *recoverable* and the error text says how: send
 * reasoning_effort:'none'. Worth noticing that this fires even when SignBridge
 * sends no reasoning_effort at all — the model applies its own default, and that
 * default collides with function tools. So the fix is to send 'none' explicitly,
 * not to omit the parameter, which is why it cannot be handled by configuration.
 *
 * The second is *not* recoverable: a legacy completions model or a
 * responses-only model will never answer a chat turn. All SignBridge can do is
 * say which model it was and that a different one is needed. `modelCatalog` also
 * filters the known ids out of the picker; this is the backstop for the ones it
 * has not heard of.
 *
 * Everything here is a pure function over the error object so it is testable
 * without a provider, a key or a network.
 */

const REASONING_TOOLS_CONFLICT = 'reasoning_effort_with_tools';
const NOT_A_CHAT_MODEL = 'not_a_chat_model';
const RESPONSES_ONLY = 'responses_only';

function errorText(err) {
    if (!err) {
        return '';
    }
    let parts = [];
    if (err.message) {
        parts.push(String(err.message));
    }
    // The OpenAI SDK keeps the provider's own body on `error`; other providers
    // put it on `response.data`. Read both — the useful sentence is often only
    // in one of them.
    if (err.error && err.error.message) {
        parts.push(String(err.error.message));
    }
    if (err.response && err.response.data) {
        let data = err.response.data;
        if (typeof data === 'string') {
            parts.push(data);
        } else if (data.error && data.error.message) {
            parts.push(String(data.error.message));
        }
    }
    return parts.join(' ');
}

/**
 * classifyCompletionError(err) -> { kind, recoverable, message } | null
 *
 * `null` means "not one of these" — the caller must rethrow untouched rather than
 * dressing up an unrelated failure (a rate limit, a network drop) as a model
 * choice problem.
 */
function classifyCompletionError(err, model) {
    let text = errorText(err);
    if (!text) {
        return null;
    }
    let named = model ? '"' + model + '"' : 'This model';

    if (/reasoning[_ ]effort/i.test(text) && /tool/i.test(text)) {
        return {
            kind: REASONING_TOOLS_CONFLICT,
            recoverable: true,
            message: named + ' cannot use SignBridge\'s tools with reasoning turned on. ' +
                'Retrying with reasoning off.'
        };
    }
    if (/not a chat model/i.test(text) || /v1\/completions/i.test(text)) {
        return {
            kind: NOT_A_CHAT_MODEL,
            recoverable: false,
            message: named + ' is not a chat model — it only serves the older completions API, ' +
                'which SignBridge does not use. Pick a chat model in the model picker above the ' +
                'message box (or in Settings → AI features).'
        };
    }
    if (/v1\/responses/i.test(text)) {
        return {
            kind: RESPONSES_ONLY,
            recoverable: false,
            message: named + ' is only available on the provider\'s responses API, which ' +
                'SignBridge does not use. Pick a different model in the model picker above the ' +
                'message box (or in Settings → AI features).'
        };
    }
    return null;
}

/**
 * The retry params: reasoning explicitly off, and no temperature.
 *
 * Returns a new object — mutating the params the caller may still hold would make
 * a one-shot retry look like a permanent change to the request.
 */
function withReasoningDisabled(params) {
    let next = Object.assign({}, params || {});
    next.reasoning_effort = 'none';
    // A reasoning model that rejects tools+reasoning also rejects temperature, and
    // buildParams only sets one of the two — but the retry must be valid whichever
    // branch produced these params.
    delete next.temperature;
    return next;
}

/**
 * The message for a recoverable failure that failed again after the retry.
 * Separate from the optimistic "retrying" text above, because at this point the
 * only remaining advice is to choose another model.
 */
function exhaustedMessage(kind, model) {
    let named = model ? '"' + model + '"' : 'This model';
    if (kind === REASONING_TOOLS_CONFLICT) {
        return named + ' rejected SignBridge\'s tools even with reasoning turned off, so it ' +
            'cannot be used for chat here. Pick a different model in the model picker above the ' +
            'message box (or in Settings → AI features).';
    }
    return named + ' cannot answer this request. Pick a different model.';
}

module.exports = {
    REASONING_TOOLS_CONFLICT: REASONING_TOOLS_CONFLICT,
    NOT_A_CHAT_MODEL: NOT_A_CHAT_MODEL,
    RESPONSES_ONLY: RESPONSES_ONLY,
    errorText: errorText,
    classifyCompletionError: classifyCompletionError,
    withReasoningDisabled: withReasoningDisabled,
    exhaustedMessage: exhaustedMessage
};
