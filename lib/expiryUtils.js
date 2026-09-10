"use strict";

// Pure, side-effect-free helpers for presigned-URL lifetime decisions.
//
// These were extracted from requestSigner.js and the SSO presigners so the
// exact clamping / capping / freshness logic can be unit-tested in isolation
// (see test/expiryUtils.test.js). Keep them dependency-free and deterministic:
// callers pass the current time in, so tests need no clock mocking.

// AWS SigV4 allows an X-Amz-Expires between 1s and 12h. We clamp callers
// (UI / chat / MCP) to a saner 60s..43200s (12h) window.
const MIN_EXPIRES_IN_SECONDS = 60;
const MAX_EXPIRES_IN_SECONDS = 43200;

// Default refresh buffer: treat SSO role credentials with less than this much
// life left as already stale, so they are re-minted before we sign rather than
// producing a URL that fails almost immediately with AuthFailure.
const DEFAULT_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Translate a caller-supplied expiresInSeconds into a clamped integer suitable
// for the X-Amz-Expires header. Returns null when the input is absent or not a
// number, meaning "caller expressed no preference — leave the default alone".
function clampExpiresInSeconds(value) {
    if (value == null || value === '') {
        return null;
    }
    let requested = parseInt(value, 10);
    if (isNaN(requested)) {
        return null;
    }
    if (requested < MIN_EXPIRES_IN_SECONDS) {
        return MIN_EXPIRES_IN_SECONDS;
    }
    if (requested > MAX_EXPIRES_IN_SECONDS) {
        return MAX_EXPIRES_IN_SECONDS;
    }
    return requested;
}

// A request signed with temporary SSO credentials is valid only until the
// EARLIER of X-Amz-Expires and the session token's own expiration. Given the
// requested expiry (seconds) and the credential's expiration (epoch ms), return
// the effective X-Amz-Expires: capped down to the credential's remaining life
// when that is sooner, otherwise the requested value unchanged.
function capExpiryToCredentialLife(expiresInSeconds, roleCredentials, nowMs) {
    let expiresIn = expiresInSeconds;
    if (roleCredentials && roleCredentials.expiration) {
        let secondsUntilCredExpiry = Math.floor((roleCredentials.expiration - nowMs) / 1000);
        if (secondsUntilCredExpiry > 0 && secondsUntilCredExpiry < expiresIn) {
            return secondsUntilCredExpiry;
        }
    }
    return expiresIn;
}

// Decide whether cached SSO role credentials can be reused as-is, or must be
// re-minted. Fresh means: all three token parts present AND the expiration is
// at least `bufferMs` beyond `nowMs`.
function isSsoCredentialFresh(roleCredentials, nowMs, bufferMs) {
    if (bufferMs == null) {
        bufferMs = DEFAULT_REFRESH_BUFFER_MS;
    }
    let checkTime = nowMs + bufferMs;
    return !!(roleCredentials &&
        roleCredentials.accessKeyId &&
        roleCredentials.secretAccessKey &&
        roleCredentials.sessionToken &&
        roleCredentials.expiration >= checkTime);
}

module.exports = {
    MIN_EXPIRES_IN_SECONDS: MIN_EXPIRES_IN_SECONDS,
    MAX_EXPIRES_IN_SECONDS: MAX_EXPIRES_IN_SECONDS,
    DEFAULT_REFRESH_BUFFER_MS: DEFAULT_REFRESH_BUFFER_MS,
    clampExpiresInSeconds: clampExpiresInSeconds,
    capExpiryToCredentialLife: capExpiryToCredentialLife,
    isSsoCredentialFresh: isSsoCredentialFresh
};
