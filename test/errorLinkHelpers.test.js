'use strict';

// The frontend's error-normalising helpers. They are pure and exported
// precisely so this can be tested without a browser: the rule for "is this URL
// something the user can approve?" drives an Authorize button, and getting it
// wrong either hides a recoverable SSO prompt or invites the user to "approve"
// a cluster endpoint.
//
// frontend/ is ESM, so the module is loaded with dynamic import().

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(
    path.join(__dirname, '..', 'frontend', 'src', 'utils', 'awsRequestUtils.js')
).href;

let helpers = null;
test.before(async () => {
    helpers = await import(MODULE_URL);
});

const AUTH_URL = 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234';

test('firstUrlIn: finds a URL in a sentence', () => {
    assert.equal(helpers.firstUrlIn('go to https://example.com/x now'), 'https://example.com/x');
});

test('firstUrlIn: does not swallow trailing punctuation', () => {
    // "…approve at <url>, then come back" — a captured comma 404s the link.
    assert.equal(helpers.firstUrlIn(`approve at ${AUTH_URL}, then retry`), AUTH_URL);
    assert.equal(helpers.firstUrlIn(`approve at ${AUTH_URL}.`), AUTH_URL);
    assert.equal(helpers.firstUrlIn(`(see ${AUTH_URL})`), AUTH_URL);
});

test('firstUrlIn: returns null for text with no URL, and for non-strings', () => {
    assert.equal(helpers.firstUrlIn('nothing here'), null);
    assert.equal(helpers.firstUrlIn(''), null);
    assert.equal(helpers.firstUrlIn(null), null);
    assert.equal(helpers.firstUrlIn(42), null);
});

test('splitAroundUrl: splits into before / url / after', () => {
    const [before, url, after] = helpers.splitAroundUrl(`approve at ${AUTH_URL} then retry`, AUTH_URL);
    assert.equal(before, 'approve at ');
    assert.equal(url, AUTH_URL);
    assert.equal(after, ' then retry');
});

test('splitAroundUrl: with no URL the whole text is the "before" half', () => {
    assert.deepEqual(helpers.splitAroundUrl('plain failure', null), ['plain failure', null, '']);
    // A URL that is not actually in the text must not be invented into the output.
    assert.deepEqual(helpers.splitAroundUrl('plain failure', AUTH_URL), ['plain failure', null, '']);
    assert.deepEqual(helpers.splitAroundUrl(null, null), ['', null, '']);
});

test('describeError: reads an axios rejection body', () => {
    const described = helpers.describeError(
        { response: { status: 403, data: { message: 'forbidden by RBAC' } } },
        'fallback'
    );
    assert.equal(described.message, 'forbidden by RBAC');
    assert.equal(described.statusCode, 403);
    assert.equal(described.authUrl, null);
});

test('describeError: reads a flat failure body (HTTP 200, success:false)', () => {
    const described = helpers.describeError(
        { success: false, statusCode: 401, message: 'Authorization pending.', verificationUriComplete: AUTH_URL },
        'fallback'
    );
    assert.equal(described.statusCode, 401);
    assert.equal(described.url, AUTH_URL);
    // An explicit verificationUriComplete is always approvable.
    assert.equal(described.authUrl, AUTH_URL);
});

test('describeError: a bare URL is approvable only when the text is about authorization', () => {
    const auth = helpers.describeError({ message: `Authorization pending. Approve at ${AUTH_URL}` });
    assert.equal(auth.authUrl, AUTH_URL);

    const notAuth = helpers.describeError({
        message: `Could not reach the cluster endpoint https://ABC.gr7.us-east-1.eks.amazonaws.com`
    });
    // Still a link (clickable), but not something to "Authorize".
    assert.equal(notAuth.url, 'https://ABC.gr7.us-east-1.eks.amazonaws.com');
    assert.equal(notAuth.authUrl, null);
});

test('describeError: falls back when there is no message at all', () => {
    assert.equal(helpers.describeError(null, 'No clusters found.').message, 'No clusters found.');
    assert.equal(helpers.describeError({}, 'No clusters found.').message, 'No clusters found.');
    assert.equal(helpers.describeError(new Error('boom'), 'fallback').message, 'boom');
    assert.equal(helpers.describeError('a string error', 'fallback').message, 'a string error');
    // Never undefined — it is rendered directly.
    assert.equal(typeof helpers.describeError(null).message, 'string');
});
