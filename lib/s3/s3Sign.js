"use strict";

/**
 * s3Sign.js — AWS Signature Version 4 for Amazon S3, as pure functions.
 *
 * S3 World needs two things the dashboard presigners don't do:
 *
 *   1. **Header-signed requests** (Authorization header) for the calls that
 *      drive the browser — ListBuckets, ListObjectsV2, HeadObject, GetObject
 *      with a Range, PutObject, DeleteObjects. The existing lib/iam*.js and
 *      lib/sso*.js signers are shaped around the dashboard's single-request
 *      form, so this module is the reusable core instead.
 *   2. **Presigned URLs carrying response header overrides** —
 *      `response-content-type` / `response-content-disposition`. That pair is
 *      the whole reason "view in browser" works at all: S3 objects are very
 *      often stored as `application/octet-stream` (or with no ContentType), and
 *      a browser handed that will download rather than render. Overriding the
 *      response Content-Type at GET time makes the same bytes render inline
 *      without touching the stored object.
 *
 * Everything here is pure and clock-injected (`now` is always a parameter), so
 * test/s3Sign.test.js can pin it against AWS's published canonical examples.
 * The HMAC chain itself is NOT reimplemented — it comes from lib/sigv4.js, the
 * one place that math lives.
 */

const sigv4 = require('../sigv4');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const TERMINATOR = 'aws4_request';

// S3 accepts this in place of a body hash when the request travels over HTTPS.
// Used for presigned URLs (no body is known at signing time) and for streaming
// uploads where hashing the payload first would mean buffering all of it.
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

// SHA-256 of the empty string — the payload hash for every GET/HEAD/LIST.
const EMPTY_PAYLOAD_SHA256 = sigv4.sha256Hex('');

/**
 * Percent-encode per RFC 3986. encodeURIComponent leaves !'()* alone but AWS
 * expects them encoded, and a key containing any of them would otherwise
 * produce a signature mismatch.
 */
function encodeRfc3986(value) {
    return encodeURIComponent(String(value)).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );
}

/**
 * Canonical URI for a resource path. Each segment is encoded independently so
 * the '/' separators survive: S3 keys are opaque strings that routinely contain
 * spaces, '+', '#', '?', and non-ASCII characters, and every one of those has
 * to be encoded for the signature to match while still addressing the same key.
 *
 * Note S3 (unlike most services) does NOT double-encode the path.
 */
function canonicalizePath(resourcePath) {
    let raw = resourcePath == null ? '/' : String(resourcePath);
    if (raw === '' || raw === '/') {
        return '/';
    }
    if (raw.charAt(0) !== '/') {
        raw = '/' + raw;
    }
    // split('/') on a leading-slash string yields a leading '' which maps to ''
    // and rejoins as the leading slash — and a trailing '/' (a "folder" key)
    // survives the same way, which matters because `a/b/` and `a/b` are
    // different S3 keys.
    return raw.split('/').map(encodeRfc3986).join('/');
}

/**
 * Canonical query string: encoded name=value pairs sorted by name (then value),
 * joined with '&'. Undefined/null values are dropped; an empty-string value is
 * kept as `name=` because a valueless flag parameter still participates.
 */
function canonicalQueryString(query) {
    let pairs = [];
    Object.keys(query || {}).forEach(function (name) {
        let value = query[name];
        if (value === undefined || value === null) {
            return;
        }
        pairs.push([encodeRfc3986(name), encodeRfc3986(value)]);
    });
    pairs.sort(function (a, b) {
        if (a[0] !== b[0]) {
            return a[0] < b[0] ? -1 : 1;
        }
        if (a[1] === b[1]) {
            return 0;
        }
        return a[1] < b[1] ? -1 : 1;
    });
    return pairs.map(function (pair) {
        return pair[0] + '=' + pair[1];
    }).join('&');
}

/**
 * The two timestamp forms SigV4 needs, from an injected Date.
 * `dateTime` is ISO 8601 basic (20260902T101530Z); `date` is its YYYYMMDD head.
 */
function amzDates(now) {
    let iso = (now instanceof Date ? now : new Date(now)).toISOString();
    let dateTime = iso.replace(/[:\-]/g, '').replace(/\.\d{3}/, '');
    return { dateTime: dateTime, date: dateTime.slice(0, 8) };
}

function credentialScope(date, region) {
    return date + '/' + region + '/' + SERVICE + '/' + TERMINATOR;
}

/**
 * Canonical headers + signed headers list. Names are lower-cased, values are
 * trimmed with internal whitespace collapsed, and the set is sorted by name.
 */
function canonicalizeHeaders(headers) {
    let names = Object.keys(headers || {}).filter(function (name) {
        return headers[name] !== undefined && headers[name] !== null;
    }).map(function (name) {
        return name.toLowerCase();
    }).sort();

    let lookup = {};
    Object.keys(headers || {}).forEach(function (name) {
        lookup[name.toLowerCase()] = String(headers[name]).trim().replace(/\s+/g, ' ');
    });

    let canonical = names.map(function (name) {
        return name + ':' + lookup[name] + '\n';
    }).join('');

    return { canonicalHeaders: canonical, signedHeaders: names.join(';') };
}

function buildCanonicalRequest(parts) {
    return [
        parts.method.toUpperCase(),
        canonicalizePath(parts.path),
        canonicalQueryString(parts.query),
        parts.canonicalHeaders,
        parts.signedHeaders,
        parts.payloadHash
    ].join('\n');
}

function buildStringToSign(dateTime, scope, canonicalRequest) {
    return [
        ALGORITHM,
        dateTime,
        scope,
        sigv4.sha256Hex(canonicalRequest)
    ].join('\n');
}

/**
 * Sign a request with the Authorization header (the normal API-call form).
 *
 * @param {object} input
 *   method       HTTP verb
 *   host         request Host header, e.g. my-bucket.s3.us-east-1.amazonaws.com
 *   path         resource path, un-encoded (e.g. '/logs/2026/app log.txt')
 *   query        object of query parameters
 *   headers      extra headers to sign (host/x-amz-date/x-amz-content-sha256
 *                and the session token are added here, so callers don't)
 *   payloadHash  hex sha256 of the body; defaults to the empty-body hash
 *   region       AWS region of the bucket
 *   credentials  { accessKeyId, secretAccessKey, sessionToken? }
 *   now          Date used for the signature timestamps
 *
 * @returns {{ headers: object, canonicalRequest: string, stringToSign: string,
 *             signature: string, dateTime: string }}
 *          `headers` is the complete set to send.
 */
function signRequest(input) {
    let credentials = input.credentials || {};
    let region = input.region;
    let dates = amzDates(input.now || new Date());
    let payloadHash = input.payloadHash || EMPTY_PAYLOAD_SHA256;

    let headers = Object.assign({}, input.headers || {});
    headers.host = input.host;
    headers['x-amz-date'] = dates.dateTime;
    headers['x-amz-content-sha256'] = payloadHash;
    if (credentials.sessionToken) {
        headers['x-amz-security-token'] = credentials.sessionToken;
    }

    let canonicalized = canonicalizeHeaders(headers);
    let canonicalRequest = buildCanonicalRequest({
        method: input.method,
        path: input.path,
        query: input.query,
        canonicalHeaders: canonicalized.canonicalHeaders,
        signedHeaders: canonicalized.signedHeaders,
        payloadHash: payloadHash
    });

    let scope = credentialScope(dates.date, region);
    let stringToSign = buildStringToSign(dates.dateTime, scope, canonicalRequest);
    let signature = sigv4.sign(credentials.secretAccessKey, dates.date, region, SERVICE, stringToSign);

    headers.Authorization = ALGORITHM +
        ' Credential=' + credentials.accessKeyId + '/' + scope +
        ', SignedHeaders=' + canonicalized.signedHeaders +
        ', Signature=' + signature;

    return {
        headers: headers,
        canonicalRequest: canonicalRequest,
        stringToSign: stringToSign,
        signature: signature,
        dateTime: dates.dateTime
    };
}

/**
 * Build a presigned URL (credentials in the query string, nothing but Host
 * signed) — the form a browser can follow directly in a new tab.
 *
 * @param {object} input
 *   method             verb the URL will be used with (default GET)
 *   host, path         as in signRequest
 *   query              extra query parameters to include AND sign. This is
 *                      where `response-content-type` /
 *                      `response-content-disposition` go: they are ordinary
 *                      signed query parameters, so overriding them cannot be
 *                      tampered with after the fact.
 *   region, credentials, now  as in signRequest
 *   expiresInSeconds   X-Amz-Expires (caller is expected to have clamped it;
 *                      see lib/expiryUtils.js)
 *
 * @returns {string} the full https URL
 */
function presignUrl(input) {
    let credentials = input.credentials || {};
    let dates = amzDates(input.now || new Date());
    let scope = credentialScope(dates.date, input.region);
    let method = (input.method || 'GET').toUpperCase();

    // Only Host is signed. A presigned URL is followed by a browser, which we
    // cannot make send arbitrary headers, so anything else would be unusable.
    let headers = { host: input.host };
    let canonicalized = canonicalizeHeaders(headers);

    let query = Object.assign({}, input.query || {});
    query['X-Amz-Algorithm'] = ALGORITHM;
    query['X-Amz-Credential'] = credentials.accessKeyId + '/' + scope;
    query['X-Amz-Date'] = dates.dateTime;
    query['X-Amz-Expires'] = String(input.expiresInSeconds || 3600);
    query['X-Amz-SignedHeaders'] = canonicalized.signedHeaders;
    if (credentials.sessionToken) {
        // Signed (not appended afterwards): S3 rejects a presigned URL whose
        // security token was not part of the canonical query string.
        query['X-Amz-Security-Token'] = credentials.sessionToken;
    }

    let canonicalQuery = canonicalQueryString(query);
    let canonicalRequest = buildCanonicalRequest({
        method: method,
        path: input.path,
        query: query,
        canonicalHeaders: canonicalized.canonicalHeaders,
        signedHeaders: canonicalized.signedHeaders,
        payloadHash: UNSIGNED_PAYLOAD
    });
    let stringToSign = buildStringToSign(dates.dateTime, scope, canonicalRequest);
    let signature = sigv4.sign(credentials.secretAccessKey, dates.date, input.region, SERVICE, stringToSign);

    return 'https://' + input.host + canonicalizePath(input.path) + '?' +
        canonicalQuery + '&X-Amz-Signature=' + signature;
}

module.exports = {
    ALGORITHM: ALGORITHM,
    SERVICE: SERVICE,
    UNSIGNED_PAYLOAD: UNSIGNED_PAYLOAD,
    EMPTY_PAYLOAD_SHA256: EMPTY_PAYLOAD_SHA256,
    encodeRfc3986: encodeRfc3986,
    canonicalizePath: canonicalizePath,
    canonicalQueryString: canonicalQueryString,
    amzDates: amzDates,
    canonicalizeHeaders: canonicalizeHeaders,
    credentialScope: credentialScope,
    buildCanonicalRequest: buildCanonicalRequest,
    buildStringToSign: buildStringToSign,
    signRequest: signRequest,
    presignUrl: presignUrl
};
