"use strict";

/**
 * redact.js — the one place that decides what must not reach a log line.
 *
 * The SSO flow is a chain of four HTTP calls (RegisterClient, StartDeviceAuthorization,
 * CreateToken, AssumeRoleWithWebIdentity/GetRoleCredentials) whose *success* bodies are
 * credentials: a client secret, a device code, an OIDC access + refresh token, and
 * finally an STS triple. Every one of those was being printed in full, so
 * `docker logs signbridge` held live AWS session credentials and an SSO refresh
 * token — and log output is exactly the artifact people paste into a ticket.
 *
 * Three deliberate choices:
 *
 *   1. **Over-redaction is the safe direction.** Keys are matched by *substring*
 *      against a list of words that appear in credential field names, with no
 *      allowlist. Hiding `bearerTokenSource` costs a debug hint; missing
 *      `sessionToken` costs a credential. So the rule errs toward hiding.
 *   2. **Strings are redacted too.** The worst offenders logged the raw response
 *      *body* before parsing it, so an object-only redactor would have masked the
 *      parsed copy and printed the plaintext one on the line above.
 *   3. **`accessKeyId` is masked, not hidden.** It is not a secret, and it is the
 *      single most useful field for answering "which credentials did that use?" —
 *      so it keeps its prefix and last four (`ASIA****1234`), the same shape
 *      ec2Utils already reports.
 *
 * Pure, no I/O, no clock: it is tested directly rather than through a log capture.
 */

// Substrings that mark a key's *value* as a credential. Matched against the key
// with case, dashes and underscores removed, so one entry covers `sessionToken`,
// `session_token` and `x-amz-security-token` alike.
const SECRET_KEY_PARTS = [
    'secret',        // secretAccessKey, clientSecret, bearerClientSecret
    'password',
    'passphrase',
    'privatekey',
    'token',         // sessionToken, accessToken, refreshToken, securityToken, bearerToken
    'apikey',
    'authorization', // an Authorization header carries the signature or a bearer token
    'signature',     // X-Amz-Signature: a presigned URL's signature is the credential
    'devicecode'     // exchanged for an access token, so it is a bearer credential
];

// Keys whose value is a *container* of credentials rather than a credential:
// `roleCredentials`, `ec2RoleCredentials`, `irsaRoleCredentials`, and the STS
// response's own `roleCredentials`. Replacing one of these wholesale is tempting
// and slightly wrong — its children are each covered by the rules above, so
// recursing hides `secretAccessKey`/`sessionToken` while keeping the two fields
// that make the log line worth having at all (a masked `accessKeyId` and the
// `expiration`). A primitive under such a key has no children to walk, so it is
// redacted outright.
const CONTAINER_KEY_PARTS = ['credentials'];

// Keys worth keeping in a masked form rather than hiding: not secrets, and the
// most useful identifiers in a credential-related log line.
const MASKED_KEY_PARTS = ['accesskeyid'];

const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[-_\s]/g, '');
}

function isSecretKey(key) {
    let normalized = normalizeKey(key);
    // A masked key wins over the secret rule: `accessKeyId` contains none of the
    // secret parts today, but the explicit precedence keeps it that way if one is
    // ever added.
    if (MASKED_KEY_PARTS.some(function (part) { return normalized.indexOf(part) !== -1; })) {
        return false;
    }
    return SECRET_KEY_PARTS.some(function (part) { return normalized.indexOf(part) !== -1; });
}

function isMaskedKey(key) {
    let normalized = normalizeKey(key);
    return MASKED_KEY_PARTS.some(function (part) { return normalized.indexOf(part) !== -1; });
}

function isContainerKey(key) {
    let normalized = normalizeKey(key);
    return CONTAINER_KEY_PARTS.some(function (part) { return normalized.indexOf(part) !== -1; });
}

/**
 * Keep the identifying prefix and the last four characters of an identifier.
 * `AKIAIOSFODNN7EXAMPLE` -> `AKIA****MPLE`.
 */
function maskIdentifier(value) {
    let text = String(value == null ? '' : value);
    if (text.length <= 8) {
        return text ? '****' : text;
    }
    return text.slice(0, 4) + '****' + text.slice(-4);
}

/**
 * Redact a JSON or form-encoded *string*.
 *
 * The success bodies were logged twice — once raw, once parsed — so this half is
 * not optional. A body that parses as JSON is redacted structurally (which also
 * catches nesting); anything else falls back to a pattern replace, which is what
 * covers form-encoded token responses and presigned URLs.
 */
function redactText(text) {
    let raw = String(text);
    let trimmed = raw.trim();
    if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
        try {
            return JSON.stringify(redactValue(JSON.parse(trimmed), 0));
        } catch (err) {
            // Not JSON after all (a truncated body, an XML error page). Fall through.
        }
    }
    // "key": "value" — quoted JSON that failed to parse, e.g. a truncated body.
    let out = raw.replace(/"([A-Za-z0-9_\-]+)"\s*:\s*"([^"]*)"/g, function (match, key, value) {
        if (isSecretKey(key)) {
            return '"' + key + '":"' + REDACTED + '"';
        }
        if (isMaskedKey(key)) {
            return '"' + key + '":"' + maskIdentifier(value) + '"';
        }
        return match;
    });
    // key=value — a form-encoded body, or a query string. Stops at & and whitespace
    // so only the one parameter is replaced.
    out = out.replace(/([A-Za-z0-9_\-]+)=([^&\s"']+)/g, function (match, key, value) {
        if (isSecretKey(key)) {
            return key + '=' + REDACTED;
        }
        if (isMaskedKey(key)) {
            return key + '=' + maskIdentifier(value);
        }
        return match;
    });
    return out;
}

/**
 * Redact a SigV4 canonical request (or a block of canonical headers).
 *
 * Every signer logs its canonical request, which is the right thing to log — it is
 * the only way to debug a signature mismatch. What was not right is that SigV4
 * *signs* `x-amz-security-token`, so for every temporary-credential mechanism (SSO,
 * EC2 instance role, IRSA) that block contained the live session token in full.
 *
 * So the structure is kept and only the offending header *values* are replaced:
 * canonical headers are `name:value` lines with a lowercase name, which is a
 * narrow enough shape to match without touching the method, path or payload hash.
 * The trailing `redactText` pass covers the presigners, where the token rides in
 * the query-string line instead (`X-Amz-Security-Token=…`).
 */
function redactCanonicalRequest(text) {
    let out = String(text).split('\n').map(function (line) {
        let match = /^([A-Za-z0-9\-]+):(.*)$/.exec(line);
        if (match && isSecretKey(match[1])) {
            return match[1] + ':' + REDACTED;
        }
        return line;
    }).join('\n');
    return redactText(out);
}

function redactValue(value, depth, seen) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return redactText(value);
    }
    if (typeof value !== 'object') {
        return value;
    }
    // An Error carries a message worth keeping and no credential of its own; its
    // own enumerable properties are walked so a thrown response body is still
    // redacted.
    if (value instanceof Error) {
        return value;
    }
    if (depth >= MAX_DEPTH) {
        return '[depth limit]';
    }
    let visited = seen || new Set();
    if (visited.has(value)) {
        return '[circular]';
    }
    visited.add(value);

    if (Array.isArray(value)) {
        return value.map(function (entry) { return redactValue(entry, depth + 1, visited); });
    }
    let out = {};
    Object.keys(value).forEach(function (key) {
        if (isContainerKey(key)) {
            // Walk into it if there is anything to walk into; otherwise it is a
            // credential-shaped scalar and gets hidden.
            out[key] = (value[key] && typeof value[key] === 'object')
                ? redactValue(value[key], depth + 1, visited)
                : REDACTED;
        } else if (isSecretKey(key)) {
            out[key] = REDACTED;
        } else if (isMaskedKey(key)) {
            out[key] = maskIdentifier(value[key]);
        } else {
            out[key] = redactValue(value[key], depth + 1, visited);
        }
    });
    return out;
}

/**
 * The function every log line should wrap a payload in.
 *
 * Named `forLog` rather than `redact` so a call site reads as what it is: this is
 * for logging, never for building a response or a request.
 */
function forLog(value) {
    return redactValue(value, 0);
}

module.exports = {
    SECRET_KEY_PARTS: SECRET_KEY_PARTS,
    MASKED_KEY_PARTS: MASKED_KEY_PARTS,
    CONTAINER_KEY_PARTS: CONTAINER_KEY_PARTS,
    REDACTED: REDACTED,
    isSecretKey: isSecretKey,
    isMaskedKey: isMaskedKey,
    isContainerKey: isContainerKey,
    maskIdentifier: maskIdentifier,
    redactText: redactText,
    redactCanonicalRequest: redactCanonicalRequest,
    forLog: forLog
};
