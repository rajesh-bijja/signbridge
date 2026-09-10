"use strict";

// Tests for the S3 SigV4 signer.
//
// The anchor is AWS's own published example from "Authenticating Requests:
// Using Query Parameters" — same credentials, same clock, same expected
// signature. If any part of the canonicalisation drifts (path encoding, query
// sorting, the UNSIGNED-PAYLOAD marker, the credential scope), this test fails
// with a one-character difference in a hex string, which is exactly the kind of
// bug that is otherwise diagnosed by staring at a 403 from S3.

const test = require('node:test');
const assert = require('node:assert/strict');

const s3Sign = require('../lib/s3/s3Sign');

// AWS's documented example credentials. Not secrets — they appear verbatim in
// the AWS documentation and are the standard SigV4 test vector.
const AWS_EXAMPLE = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
};
const AWS_EXAMPLE_DATE = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));

test('presignUrl reproduces the AWS documented signature exactly', () => {
    let url = s3Sign.presignUrl({
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/test.txt',
        query: {},
        region: 'us-east-1',
        credentials: AWS_EXAMPLE,
        expiresInSeconds: 86400,
        now: AWS_EXAMPLE_DATE
    });

    assert.ok(url.includes(
        'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    ), 'signature must match the AWS published value; got ' + url);

    // The full URL, so parameter order and encoding are pinned too.
    assert.equal(url,
        'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('presignUrl signs only Host, because a browser cannot send other headers', () => {
    let url = s3Sign.presignUrl({
        method: 'GET',
        host: 'b.s3.us-east-1.amazonaws.com',
        path: '/k',
        query: {},
        region: 'us-east-1',
        credentials: AWS_EXAMPLE,
        expiresInSeconds: 900,
        now: AWS_EXAMPLE_DATE
    });
    assert.ok(url.includes('X-Amz-SignedHeaders=host'));
    assert.ok(!url.includes('x-amz-content-sha256'));
});

test('response header overrides land inside the signature, not appended after it', () => {
    // This is the mechanism that makes an octet-stream PNG render instead of
    // download. SigV4 covers every query parameter except X-Amz-Signature, so
    // these MUST be present at signing time — they cannot be bolted on later
    // (that yields SignatureDoesNotMatch), and the URL holder cannot alter them.
    let url = s3Sign.presignUrl({
        method: 'GET',
        host: 'b.s3.us-east-1.amazonaws.com',
        path: '/photo',
        query: {
            'response-content-type': 'image/png',
            'response-content-disposition': 'inline'
        },
        region: 'us-east-1',
        credentials: AWS_EXAMPLE,
        expiresInSeconds: 900,
        now: AWS_EXAMPLE_DATE
    });
    let signatureIndex = url.indexOf('X-Amz-Signature=');
    let overrideIndex = url.indexOf('response-content-type=');
    assert.ok(overrideIndex !== -1, 'override must be in the URL');
    assert.ok(overrideIndex < signatureIndex,
        'overrides must precede X-Amz-Signature, i.e. be part of the signed query');
    assert.ok(url.includes('response-content-type=image%2Fpng'));
});

test('changing an override changes the signature', () => {
    function sign(contentType) {
        return s3Sign.presignUrl({
            method: 'GET',
            host: 'b.s3.us-east-1.amazonaws.com',
            path: '/photo',
            query: { 'response-content-type': contentType },
            region: 'us-east-1',
            credentials: AWS_EXAMPLE,
            expiresInSeconds: 900,
            now: AWS_EXAMPLE_DATE
        });
    }
    let a = /X-Amz-Signature=([a-f0-9]+)/.exec(sign('image/png'))[1];
    let b = /X-Amz-Signature=([a-f0-9]+)/.exec(sign('text/plain'))[1];
    assert.notEqual(a, b, 'the overrides are covered by the signature, so they must affect it');
});

test('a session token is signed as a query parameter for presigned URLs', () => {
    let url = s3Sign.presignUrl({
        method: 'GET',
        host: 'b.s3.us-east-1.amazonaws.com',
        path: '/k',
        query: {},
        region: 'us-east-1',
        credentials: Object.assign({ sessionToken: 'TOKEN/WITH+CHARS=' }, AWS_EXAMPLE),
        expiresInSeconds: 900,
        now: AWS_EXAMPLE_DATE
    });
    assert.ok(url.includes('X-Amz-Security-Token=TOKEN%2FWITH%2BCHARS%3D'),
        'the token must be present and percent-encoded');
    assert.ok(url.indexOf('X-Amz-Security-Token=') < url.indexOf('X-Amz-Signature='),
        'the token is part of the signed query');
});

test('signRequest sends the session token as a header, not a query parameter', () => {
    let signed = s3Sign.signRequest({
        method: 'GET',
        host: 'b.s3.us-east-1.amazonaws.com',
        path: '/k',
        query: {},
        headers: {},
        region: 'us-east-1',
        credentials: Object.assign({ sessionToken: 'ABC' }, AWS_EXAMPLE),
        now: AWS_EXAMPLE_DATE
    });
    assert.equal(signed.headers['x-amz-security-token'], 'ABC');
    assert.ok(signed.headers.Authorization.includes('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token'),
        'a header that is sent must also be signed, or S3 rejects it');
    assert.ok(signed.headers.Authorization.startsWith('AWS4-HMAC-SHA256 Credential='));
    // Header-signed requests hash the body; only presigned URLs use the marker.
    assert.equal(signed.headers['x-amz-content-sha256'], s3Sign.EMPTY_PAYLOAD_SHA256);
});

// --- canonicalisation details that cause real 403s -------------------------

test('canonicalizePath encodes each segment but preserves slashes', () => {
    assert.equal(s3Sign.canonicalizePath('/a/b/c.txt'), '/a/b/c.txt');
    assert.equal(s3Sign.canonicalizePath('/my folder/my file.txt'),
        '/my%20folder/my%20file.txt');
    // A trailing slash identifies a folder marker and must survive.
    assert.equal(s3Sign.canonicalizePath('/folder/'), '/folder/');
});

test('canonicalizePath does not double-encode: S3 differs from other services', () => {
    // For S3 the path is encoded once. Encoding twice (which SigV4 requires for
    // most other AWS services) produces %2520 and a SignatureDoesNotMatch.
    assert.equal(s3Sign.canonicalizePath('/already%20encoded'), '/already%2520encoded');
    let once = s3Sign.canonicalizePath('/a b');
    assert.equal(once, '/a%20b');
    assert.ok(!once.includes('%2520'));
});

test('canonicalizePath leaves RFC 3986 unreserved characters alone', () => {
    assert.equal(s3Sign.canonicalizePath("/a-_.~b"), '/a-_.~b');
    // '+' is NOT unreserved and must be escaped, or a key containing it breaks.
    assert.equal(s3Sign.canonicalizePath('/a+b'), '/a%2Bb');
});

test('canonicalQueryString sorts by name then value and keeps empty values', () => {
    assert.equal(s3Sign.canonicalQueryString({ b: '2', a: '1' }), 'a=1&b=2');
    // `?delete` is sent as an empty-valued parameter and must be preserved.
    assert.equal(s3Sign.canonicalQueryString({ 'delete': '' }), 'delete=');
    // Undefined/null are dropped so callers can pass optional parameters freely.
    assert.equal(s3Sign.canonicalQueryString({ a: '1', b: undefined, c: null }), 'a=1');
});

test('canonicalQueryString sorts on the encoded name, not the raw one', () => {
    // Sorting must happen after encoding, per the SigV4 spec.
    let result = s3Sign.canonicalQueryString({ 'a b': '1', 'a-c': '2' });
    // '%' (0x25) sorts before '-' (0x2d), so the encoded 'a%20b' comes first.
    assert.equal(result, 'a%20b=1&a-c=2');
});

test('canonicalizeHeaders lowercases, trims, collapses whitespace and sorts', () => {
    let result = s3Sign.canonicalizeHeaders({
        'X-Amz-Date': '20130524T000000Z',
        'Host': ' example.com ',
        'Content-Type': 'text/plain;   charset=utf-8'
    });
    assert.equal(result.signedHeaders, 'content-type;host;x-amz-date');
    assert.ok(result.canonicalHeaders.includes('host:example.com\n'));
    assert.ok(result.canonicalHeaders.includes('content-type:text/plain; charset=utf-8\n'),
        'runs of whitespace inside a header value must collapse to one space');
});

test('amzDates produces the two formats the signature needs', () => {
    let dates = s3Sign.amzDates(new Date(Date.UTC(2026, 8, 2, 10, 15, 30)));
    assert.equal(dates.dateTime, '20260902T101530Z');
    assert.equal(dates.date, '20260902');
});

test('presigned URLs use the UNSIGNED-PAYLOAD marker', () => {
    // A browser fetching a presigned URL cannot compute a body hash, so S3
    // requires this literal in the canonical request.
    assert.equal(s3Sign.UNSIGNED_PAYLOAD, 'UNSIGNED-PAYLOAD');
});
