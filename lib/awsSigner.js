"use strict";

// Generic AWS SigV4 signing for the *control-plane* calls SignBridge makes on
// its own behalf — eks:DescribeCluster, iam:GetRole, sts:AssumeRoleWithWebIdentity,
// sts:GetCallerIdentity (presigned, for the EKS bearer token).
//
// Why a third signer: `lib/s3/s3Sign.js` hardcodes `SERVICE = 's3'` and its
// S3-specific payload conventions, and the `iam*`/`sso*` presigners are shaped
// around the dashboard's request/response contract. Neither can sign an
// arbitrary service call. This module is the small, service-parameterised
// version, and like s3Sign it is **pure and clock-injected** so the canonical
// request and the presigned URL can be pinned in tests without a network.
//
// All HMAC math goes through lib/sigv4.js — never reimplement it here.

const sigv4 = require('./sigv4');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const TERMINATOR = 'aws4_request';
const EMPTY_PAYLOAD_HASH = sigv4.sha256Hex('');

function encodeRFC3986(str) {
    return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) => {
        return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

// '20260903T101112Z' / '20260903' from a Date.
function amzDateTime(date) {
    return date.toISOString().replace(/[:\-]|\.\d{3}/g, '');
}

function amzDateStamp(date) {
    return amzDateTime(date).slice(0, 8);
}

// Canonical URI: each path segment percent-encoded, '/' preserved. The AWS spec
// asks for double encoding on non-S3 services, but that only differs for
// segments containing characters that need escaping; the control-plane paths we
// build are cluster names, namespaces and service-account names (DNS labels), so
// single encoding is byte-identical. Keep it that way — do not start putting
// arbitrary user text in these paths without revisiting this.
function canonicalUri(path) {
    if (!path || path === '/') {
        return '/';
    }
    let segments = path.split('/');
    return segments.map((segment) => {
        return segment === '' ? '' : encodeRFC3986(segment);
    }).join('/');
}

// Canonical query string from a plain object: RFC3986-encoded, sorted by
// encoded key name. Undefined/null values are dropped.
function canonicalQuery(query) {
    if (!query) {
        return '';
    }
    let pairs = [];
    Object.keys(query).forEach((key) => {
        let value = query[key];
        if (value == null) {
            return;
        }
        pairs.push([encodeRFC3986(key), encodeRFC3986(value)]);
    });
    pairs.sort((a, b) => {
        if (a[0] < b[0]) { return -1; }
        if (a[0] > b[0]) { return 1; }
        return a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0);
    });
    return pairs.map((pair) => pair[0] + '=' + pair[1]).join('&');
}

// Lowercase header names, trim values, sort. Returns { canonicalHeaders, signedHeaders }.
function canonicalHeaders(headers) {
    let normalized = {};
    Object.keys(headers || {}).forEach((name) => {
        let value = headers[name];
        if (value == null) {
            return;
        }
        normalized[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
    });
    let names = Object.keys(normalized).sort();
    return {
        canonicalHeaders: names.map((name) => name + ':' + normalized[name] + '\n').join(''),
        signedHeaders: names.join(';'),
        normalized: normalized
    };
}

function credentialScope(dateStamp, region, service) {
    return dateStamp + '/' + region + '/' + service + '/' + TERMINATOR;
}

function stringToSign(dateTime, scope, canonicalRequest) {
    return ALGORITHM + '\n' + dateTime + '\n' + scope + '\n' + sigv4.sha256Hex(canonicalRequest);
}

// Sign a request with the Authorization header (the normal, non-presigned form).
//
// input: { credentials:{accessKeyId,secretAccessKey,sessionToken?}, region,
//          service, method, host, path, query?, body?, headers?, now? }
// Returns { headers, canonicalRequest, stringToSign, authorization }.
function signRequest(input) {
    let now = input.now ? new Date(input.now) : new Date();
    let dateTime = amzDateTime(now);
    let dateStamp = amzDateStamp(now);
    let method = String(input.method || 'GET').toUpperCase();
    let body = input.body == null ? '' : input.body;
    let payloadHash = input.payloadHash || sigv4.sha256Hex(body);

    let headers = Object.assign({}, input.headers || {});
    headers['host'] = input.host;
    headers['x-amz-date'] = dateTime;
    headers['x-amz-content-sha256'] = payloadHash;
    if (input.credentials && input.credentials.sessionToken) {
        headers['x-amz-security-token'] = input.credentials.sessionToken;
    }

    let hdr = canonicalHeaders(headers);
    let canonicalRequest = [
        method,
        canonicalUri(input.path),
        canonicalQuery(input.query),
        hdr.canonicalHeaders,
        hdr.signedHeaders,
        payloadHash
    ].join('\n');

    let scope = credentialScope(dateStamp, input.region, input.service);
    let toSign = stringToSign(dateTime, scope, canonicalRequest);
    let signature = sigv4.sign(input.credentials.secretAccessKey, dateStamp, input.region, input.service, toSign);
    let authorization = ALGORITHM + ' ' +
        'Credential=' + input.credentials.accessKeyId + '/' + scope + ', ' +
        'SignedHeaders=' + hdr.signedHeaders + ', ' +
        'Signature=' + signature;

    let outHeaders = Object.assign({}, hdr.normalized);
    outHeaders['Authorization'] = authorization;
    delete outHeaders['host']; // Node's http sets Host itself from the request options.

    return {
        headers: outHeaders,
        canonicalRequest: canonicalRequest,
        stringToSign: toSign,
        signature: signature,
        authorization: authorization
    };
}

// Presign a request as a query-string-authenticated URL.
//
// `extraSignedHeaders` are headers whose *values* enter the signature but which
// the URL cannot carry — this is exactly how the EKS bearer token works: the
// cluster name travels as a signed `x-k8s-aws-id` header that the cluster's
// authenticator re-adds server-side before validating.
//
// Returns { url, canonicalRequest, stringToSign, signature }.
function presignUrl(input) {
    let now = input.now ? new Date(input.now) : new Date();
    let dateTime = amzDateTime(now);
    let dateStamp = amzDateStamp(now);
    let method = String(input.method || 'GET').toUpperCase();
    let scope = credentialScope(dateStamp, input.region, input.service);
    let payloadHash = input.payloadHash || EMPTY_PAYLOAD_HASH;

    let headers = Object.assign({}, input.extraSignedHeaders || {});
    headers['host'] = input.host;
    let hdr = canonicalHeaders(headers);

    let query = Object.assign({}, input.query || {});
    query['X-Amz-Algorithm'] = ALGORITHM;
    query['X-Amz-Credential'] = input.credentials.accessKeyId + '/' + scope;
    query['X-Amz-Date'] = dateTime;
    query['X-Amz-Expires'] = String(input.expiresInSeconds || 60);
    query['X-Amz-SignedHeaders'] = hdr.signedHeaders;
    if (input.credentials.sessionToken) {
        query['X-Amz-Security-Token'] = input.credentials.sessionToken;
    }

    let canonicalQueryString = canonicalQuery(query);
    let canonicalRequest = [
        method,
        canonicalUri(input.path),
        canonicalQueryString,
        hdr.canonicalHeaders,
        hdr.signedHeaders,
        payloadHash
    ].join('\n');

    let toSign = stringToSign(dateTime, scope, canonicalRequest);
    let signature = sigv4.sign(input.credentials.secretAccessKey, dateStamp, input.region, input.service, toSign);

    let url = 'https://' + input.host + canonicalUri(input.path) +
        '?' + canonicalQueryString +
        '&X-Amz-Signature=' + signature;

    return {
        url: url,
        canonicalRequest: canonicalRequest,
        stringToSign: toSign,
        signature: signature
    };
}

module.exports = {
    ALGORITHM: ALGORITHM,
    EMPTY_PAYLOAD_HASH: EMPTY_PAYLOAD_HASH,
    encodeRFC3986: encodeRFC3986,
    amzDateTime: amzDateTime,
    amzDateStamp: amzDateStamp,
    canonicalUri: canonicalUri,
    canonicalQuery: canonicalQuery,
    canonicalHeaders: canonicalHeaders,
    signRequest: signRequest,
    presignUrl: presignUrl
};
