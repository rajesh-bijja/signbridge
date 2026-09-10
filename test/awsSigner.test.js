"use strict";

// Tests for the generic SigV4 signer used by the control-plane calls (eks:*,
// iam:*, sts:*) that the EC2 and IRSA profile types need.
//
// lib/sigv4.js already covers the HMAC chain against AWS's published vector;
// what this file pins is the canonicalisation around it, and specifically the
// two things IRSA depends on being exactly right:
//
//   * extraSignedHeaders — the EKS bearer token is only accepted because
//     x-k8s-aws-id is INSIDE the signature. If it silently stopped being signed,
//     the presigned URL would still look fine and the API server would return
//     401 with nothing to point at.
//   * a session token becomes X-Amz-Security-Token in the query string (presign)
//     and x-amz-security-token in the headers (signRequest) — temporary
//     credentials from SSO/EC2/IRSA are useless without it.

const test = require('node:test');
const assert = require('node:assert/strict');

const awsSigner = require('../lib/awsSigner');

const FIXED_NOW = Date.UTC(2026, 8, 2, 12, 34, 56); // 2026-09-02T12:34:56Z

const LONG_LIVED = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
};

const TEMPORARY = Object.assign({}, LONG_LIVED, {
    accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
    sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLE//////////wEaCXVzLWVhc3Qt'
});

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

test('amzDateTime / amzDateStamp: the two SigV4 date formats', () => {
    assert.equal(awsSigner.amzDateTime(new Date(FIXED_NOW)), '20260902T123456Z');
    assert.equal(awsSigner.amzDateStamp(new Date(FIXED_NOW)), '20260902');
});

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

test('encodeRFC3986: leaves unreserved characters alone, escapes the rest', () => {
    assert.equal(awsSigner.encodeRFC3986('abcXYZ019-_.~'), 'abcXYZ019-_.~');
    // The four that encodeURIComponent gets wrong for SigV4.
    assert.equal(awsSigner.encodeRFC3986("!'()*"), '%21%27%28%29%2A');
    assert.equal(awsSigner.encodeRFC3986('a/b'), 'a%2Fb');
    assert.equal(awsSigner.encodeRFC3986('a b'), 'a%20b');
});

test('canonicalUri: keeps path separators unescaped but escapes segment content', () => {
    assert.equal(awsSigner.canonicalUri('/clusters/my-cluster'), '/clusters/my-cluster');
    assert.equal(awsSigner.canonicalUri('/api/v1/namespaces/kube system/serviceaccounts'),
        '/api/v1/namespaces/kube%20system/serviceaccounts');
    // A missing or bare path canonicalises to '/'.
    assert.equal(awsSigner.canonicalUri(''), '/');
    assert.equal(awsSigner.canonicalUri(null), '/');
});

test('canonicalQuery: sorts by key and encodes values', () => {
    assert.equal(
        awsSigner.canonicalQuery({ Version: '2011-06-15', Action: 'GetCallerIdentity' }),
        'Action=GetCallerIdentity&Version=2011-06-15'
    );
    assert.equal(awsSigner.canonicalQuery({ a: 'x/y' }), 'a=x%2Fy');
    assert.equal(awsSigner.canonicalQuery({}), '');
});

test('canonicalHeaders: lowercases, trims and sorts', () => {
    const hdr = awsSigner.canonicalHeaders({
        'X-K8s-Aws-Id': '  my-cluster  ',
        'Host': 'sts.us-east-1.amazonaws.com'
    });
    assert.equal(hdr.signedHeaders, 'host;x-k8s-aws-id');
    assert.equal(hdr.canonicalHeaders,
        'host:sts.us-east-1.amazonaws.com\nx-k8s-aws-id:my-cluster\n');
});

// ---------------------------------------------------------------------------
// signRequest
// ---------------------------------------------------------------------------

test('signRequest: sets the SigV4 headers and an Authorization header', () => {
    const signed = awsSigner.signRequest({
        credentials: LONG_LIVED,
        region: 'us-east-1',
        service: 'eks',
        method: 'GET',
        host: 'eks.us-east-1.amazonaws.com',
        path: '/clusters',
        now: FIXED_NOW
    });
    assert.equal(signed.headers['x-amz-date'], '20260902T123456Z');
    assert.equal(signed.headers['x-amz-content-sha256'], awsSigner.EMPTY_PAYLOAD_HASH);
    assert.match(signed.headers['Authorization'],
        /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260902\/us-east-1\/eks\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
});

test('signRequest: does not return a host header for Node to reject', () => {
    // `host` must be part of the signature but must not be handed to http.request
    // as an explicit header — Node sets it from the connection.
    const signed = awsSigner.signRequest({
        credentials: LONG_LIVED,
        region: 'us-east-1',
        service: 'eks',
        method: 'GET',
        host: 'eks.us-east-1.amazonaws.com',
        path: '/clusters',
        now: FIXED_NOW
    });
    assert.equal(signed.headers['host'], undefined);
    assert.equal(signed.headers['Host'], undefined);
    // ...but it was signed.
    assert.match(signed.headers['Authorization'], /SignedHeaders=[^,]*host/);
});

test('signRequest: temporary credentials add x-amz-security-token, and it is signed', () => {
    const signed = awsSigner.signRequest({
        credentials: TEMPORARY,
        region: 'us-east-1',
        service: 'sts',
        method: 'POST',
        host: 'sts.us-east-1.amazonaws.com',
        path: '/',
        body: 'Action=GetCallerIdentity&Version=2011-06-15',
        now: FIXED_NOW
    });
    assert.equal(signed.headers['x-amz-security-token'], TEMPORARY.sessionToken);
    assert.match(signed.headers['Authorization'], /SignedHeaders=[^,]*x-amz-security-token/);
});

test('signRequest: long-lived keys carry no security token', () => {
    const signed = awsSigner.signRequest({
        credentials: LONG_LIVED,
        region: 'us-east-1',
        service: 'iam',
        method: 'GET',
        host: 'iam.amazonaws.com',
        path: '/',
        now: FIXED_NOW
    });
    assert.equal(signed.headers['x-amz-security-token'], undefined);
});

test('signRequest: the body is hashed into the signature', () => {
    const base = {
        credentials: LONG_LIVED,
        region: 'us-east-1',
        service: 'iam',
        method: 'POST',
        host: 'iam.amazonaws.com',
        path: '/',
        now: FIXED_NOW
    };
    const a = awsSigner.signRequest(Object.assign({}, base, { body: 'Action=GetRole&RoleName=a' }));
    const b = awsSigner.signRequest(Object.assign({}, base, { body: 'Action=GetRole&RoleName=b' }));
    assert.notEqual(a.headers['x-amz-content-sha256'], b.headers['x-amz-content-sha256']);
    assert.notEqual(a.headers['Authorization'], b.headers['Authorization']);
});

test('signRequest: is clock-injected — same inputs, same signature', () => {
    const input = {
        credentials: LONG_LIVED,
        region: 'us-east-1',
        service: 'eks',
        method: 'GET',
        host: 'eks.us-east-1.amazonaws.com',
        path: '/clusters',
        now: FIXED_NOW
    };
    assert.equal(
        awsSigner.signRequest(input).headers['Authorization'],
        awsSigner.signRequest(input).headers['Authorization']
    );
});

// ---------------------------------------------------------------------------
// presignUrl
// ---------------------------------------------------------------------------

function presignSts(overrides) {
    return awsSigner.presignUrl(Object.assign({
        credentials: LONG_LIVED,
        region: 'us-east-1',
        service: 'sts',
        method: 'GET',
        host: 'sts.us-east-1.amazonaws.com',
        path: '/',
        query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
        expiresInSeconds: 60,
        now: FIXED_NOW
    }, overrides || {}));
}

test('presignUrl: puts the SigV4 parameters in the query string', () => {
    const url = presignSts().url;
    assert.match(url, /^https:\/\/sts\.us-east-1\.amazonaws\.com\/\?/);
    assert.ok(url.indexOf('X-Amz-Algorithm=AWS4-HMAC-SHA256') > 0);
    assert.ok(url.indexOf('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260902%2Fus-east-1%2Fsts%2Faws4_request') > 0);
    assert.ok(url.indexOf('X-Amz-Date=20260902T123456Z') > 0);
    assert.ok(url.indexOf('X-Amz-Expires=60') > 0);
    assert.match(url, /&X-Amz-Signature=[0-9a-f]{64}$/);
});

test('presignUrl: extraSignedHeaders end up in SignedHeaders', () => {
    // This is the mechanism the EKS bearer token relies on: x-k8s-aws-id is not
    // in the URL, it is sent as a header, and the API server only accepts the
    // token if that header was covered by the signature.
    const result = presignSts({ extraSignedHeaders: { 'x-k8s-aws-id': 'my-cluster' } });
    assert.ok(result.url.indexOf('X-Amz-SignedHeaders=host%3Bx-k8s-aws-id') > 0, result.url);
    assert.match(result.canonicalRequest, /^x-k8s-aws-id:my-cluster$/m);
});

test('presignUrl: signing a different cluster name yields a different signature', () => {
    const a = presignSts({ extraSignedHeaders: { 'x-k8s-aws-id': 'cluster-a' } });
    const b = presignSts({ extraSignedHeaders: { 'x-k8s-aws-id': 'cluster-b' } });
    assert.notEqual(a.signature, b.signature);
});

test('presignUrl: temporary credentials add X-Amz-Security-Token to the query', () => {
    const url = presignSts({ credentials: TEMPORARY }).url;
    assert.ok(url.indexOf('X-Amz-Security-Token=') > 0);
    // Encoded, since a session token contains / and +.
    assert.ok(url.indexOf(TEMPORARY.sessionToken) < 0, 'session token should be percent-encoded');
});

test('presignUrl: defaults X-Amz-Expires to 60 seconds', () => {
    const url = presignSts({ expiresInSeconds: undefined }).url;
    assert.ok(url.indexOf('X-Amz-Expires=60') > 0);
});

test('presignUrl: query parameters are canonically ordered', () => {
    // Action before Version before every X-Amz-*, regardless of insertion order.
    const url = presignSts({ query: { Version: '2011-06-15', Action: 'GetCallerIdentity' } }).url;
    const query = url.slice(url.indexOf('?') + 1);
    assert.ok(query.indexOf('Action=') < query.indexOf('Version='));
    assert.ok(query.indexOf('Version=') < query.indexOf('X-Amz-Algorithm='));
});

test('presignUrl: never leaks the secret access key into the URL', () => {
    const url = presignSts({ credentials: TEMPORARY }).url;
    assert.ok(url.indexOf(TEMPORARY.secretAccessKey) < 0);
});

test('presignUrl: is clock-injected and deterministic', () => {
    assert.equal(presignSts().signature, presignSts().signature);
    assert.notEqual(presignSts().signature, presignSts({ now: FIXED_NOW + 1000 }).signature);
});
