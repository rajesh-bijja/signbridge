"use strict";

// Tests for the presigned-URL lifetime logic: the expiresInSeconds clamp, the
// SSO credential-life cap, and the cache-vs-refresh freshness decision. These
// guard the two real bugs that motivated this module (a too-small SSO refresh
// buffer, and a hardcoded X-Amz-Expires) from silently regressing.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MIN_EXPIRES_IN_SECONDS,
    MAX_EXPIRES_IN_SECONDS,
    DEFAULT_REFRESH_BUFFER_MS,
    clampExpiresInSeconds,
    capExpiryToCredentialLife,
    isSsoCredentialFresh
} = require('../lib/expiryUtils');

test('clampExpiresInSeconds: returns null when no preference expressed', () => {
    assert.equal(clampExpiresInSeconds(undefined), null);
    assert.equal(clampExpiresInSeconds(null), null);
    assert.equal(clampExpiresInSeconds(''), null);
    assert.equal(clampExpiresInSeconds('not-a-number'), null);
});

test('clampExpiresInSeconds: passes through in-range values', () => {
    assert.equal(clampExpiresInSeconds(3600), 3600);
    assert.equal(clampExpiresInSeconds('7200'), 7200);
    assert.equal(clampExpiresInSeconds(MIN_EXPIRES_IN_SECONDS), MIN_EXPIRES_IN_SECONDS);
    assert.equal(clampExpiresInSeconds(MAX_EXPIRES_IN_SECONDS), MAX_EXPIRES_IN_SECONDS);
});

test('clampExpiresInSeconds: clamps below the floor up to the minimum', () => {
    assert.equal(clampExpiresInSeconds(1), MIN_EXPIRES_IN_SECONDS);
    assert.equal(clampExpiresInSeconds(59), MIN_EXPIRES_IN_SECONDS);
    assert.equal(clampExpiresInSeconds(0), MIN_EXPIRES_IN_SECONDS);
    assert.equal(clampExpiresInSeconds(-100), MIN_EXPIRES_IN_SECONDS);
});

test('clampExpiresInSeconds: clamps above the ceiling down to 12h', () => {
    assert.equal(clampExpiresInSeconds(43201), MAX_EXPIRES_IN_SECONDS);
    assert.equal(clampExpiresInSeconds(999999), MAX_EXPIRES_IN_SECONDS);
});

test('clampExpiresInSeconds: floors fractional strings via parseInt', () => {
    assert.equal(clampExpiresInSeconds('3600.9'), 3600);
});

const NOW = 1_700_000_000_000; // fixed epoch ms; helpers take the clock as input

test('capExpiryToCredentialLife: leaves value untouched when credential outlives it', () => {
    const creds = { expiration: NOW + 4 * 3600 * 1000 }; // 4h of life
    assert.equal(capExpiryToCredentialLife(3600, creds, NOW), 3600);
});

test('capExpiryToCredentialLife: caps down to credential remaining life', () => {
    const creds = { expiration: NOW + 600 * 1000 }; // 10 min of life
    assert.equal(capExpiryToCredentialLife(3600, creds, NOW), 600);
});

test('capExpiryToCredentialLife: no expiration field means no cap (IAM-style)', () => {
    assert.equal(capExpiryToCredentialLife(43200, {}, NOW), 43200);
    assert.equal(capExpiryToCredentialLife(43200, null, NOW), 43200);
});

test('capExpiryToCredentialLife: already-expired credential is not capped to a negative', () => {
    // secondsUntilCredExpiry <= 0 → the guard skips capping; the signer will
    // fail loudly rather than emit a nonsensical negative X-Amz-Expires.
    const creds = { expiration: NOW - 1000 };
    assert.equal(capExpiryToCredentialLife(3600, creds, NOW), 3600);
});

test('isSsoCredentialFresh: fresh when all parts present and beyond the buffer', () => {
    const creds = {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiration: NOW + 10 * 60 * 1000 // 10 min out
    };
    assert.equal(isSsoCredentialFresh(creds, NOW, DEFAULT_REFRESH_BUFFER_MS), true);
});

test('isSsoCredentialFresh: stale when expiry falls inside the refresh buffer', () => {
    // This is the exact bug the 5-min buffer fixed: creds that are still
    // technically valid but expire in 2 min must be treated as stale, or we
    // sign a URL that dies almost immediately (AuthFailure).
    const creds = {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiration: NOW + 2 * 60 * 1000 // 2 min out, inside 5-min buffer
    };
    assert.equal(isSsoCredentialFresh(creds, NOW, DEFAULT_REFRESH_BUFFER_MS), false);
});

test('isSsoCredentialFresh: stale when any token part is missing', () => {
    const base = {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiration: NOW + 60 * 60 * 1000
    };
    assert.equal(isSsoCredentialFresh({ ...base, accessKeyId: undefined }, NOW, DEFAULT_REFRESH_BUFFER_MS), false);
    assert.equal(isSsoCredentialFresh({ ...base, secretAccessKey: undefined }, NOW, DEFAULT_REFRESH_BUFFER_MS), false);
    assert.equal(isSsoCredentialFresh({ ...base, sessionToken: undefined }, NOW, DEFAULT_REFRESH_BUFFER_MS), false);
});

test('isSsoCredentialFresh: stale when credentials are null/undefined', () => {
    assert.equal(isSsoCredentialFresh(null, NOW, DEFAULT_REFRESH_BUFFER_MS), false);
    assert.equal(isSsoCredentialFresh(undefined, NOW, DEFAULT_REFRESH_BUFFER_MS), false);
});

test('isSsoCredentialFresh: defaults to the 5-minute buffer when none supplied', () => {
    const creds = {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiration: NOW + 3 * 60 * 1000 // 3 min → inside default 5-min buffer
    };
    assert.equal(isSsoCredentialFresh(creds, NOW), false);
    assert.equal(DEFAULT_REFRESH_BUFFER_MS, 5 * 60 * 1000);
});
