/**
 * curlUtils.js
 *
 * Part of SignBridge. Licensed under the MIT License.
 *
 * "Copy as curl" support. Produces a ready-to-run request description
 * ({ method, url, headers, body }) for a Dashboard request WITHOUT invoking it
 * and WITHOUT writing anything to history — so a developer can share the exact
 * call with a teammate for debugging/triaging.
 *
 * Two flavours are prepared here (the ones the browser cannot build itself):
 *   - AWS SigV4 "exact" header-signed request, for every AWS mechanism (IAM keys,
 *     SSO, EC2 instance role, IRSA) — credentials come from credentialProvider,
 *     so this path never needs to know which one produced them. This is the
 *     faithful reproduction of the request SignBridge would invoke: the same
 *     Authorization header, X-Amz-Date, x-amz-content-sha256, security token and
 *     body. It is only valid for a few minutes (SigV4 header signatures are
 *     short-lived), so it is meant for "run it right now" triage, not long-term
 *     sharing. For a long-lived shareable link the UI uses the presign engine.
 *   - REST Basic auth: embeds the real Authorization: Basic header the server
 *     holds, so the curl runs as-is. Flagged with containsLiveCredential.
 *
 * The AWS signing here deliberately reuses the shared, test-pinned primitives in
 * sigv4.js (the same ones every signer under lib/ uses) so the signature can
 * never silently diverge from the real invoke path. The canonical-request
 * assembly mirrors iamGet/ssoGet (GET) and iamPost/ssoPost (body-bearing
 * methods) exactly.
 */
"use strict";

const crypto = require('crypto');
const { randomUUID: uuidv4 } = require('crypto');
let url = require('url');
let sigv4 = require('./sigv4');
let profileUtils = require('./profileUtils');
let commonUtils = require('./commonUtils');
let restAuth = require('./restAuth');
let authConfig = require('./authConfig');
let authnModes = require('./authnModes');
let credentialProvider = require('./credentialProvider');
let log = require('./logger').create('curlUtils');

const FORM_URL_ENCODED_UTF8 = 'application/x-www-form-urlencoded;charset=UTF-8';
const FORM_URL_ENCODED_UTF8_2 = 'application/x-www-form-urlencoded; charset=UTF-8';
const FORM_URL_ENCODED_UTF8_3 = 'application/x-www-form-urlencoded; charset=utf-8';
const FORM_URL_ENCODED = 'application/x-www-form-urlencoded';

function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function isFormUrlEncoded(contentType) {
    if (!contentType) {
        return false;
    }
    let ct = contentType.toLowerCase();
    return ct === FORM_URL_ENCODED_UTF8.toLowerCase() ||
        ct === FORM_URL_ENCODED_UTF8_2.toLowerCase() ||
        ct === FORM_URL_ENCODED_UTF8_3.toLowerCase() ||
        ct === FORM_URL_ENCODED.toLowerCase();
}

// Parse endpoint into the fields the signers expect (host/pathname/query/path).
// Returns an Error on a bad protocol.
function parseEndpoint(endpoint) {
    let reqUrl = url.parse(endpoint);
    let protocol = reqUrl.protocol ? reqUrl.protocol.toLowerCase() : null;
    if (protocol !== 'https:' && protocol !== 'http:') {
        return new Error('Invalid protocol: [' + protocol + '] in endpoint');
    }
    return {
        protocol: protocol,
        host: reqUrl.hostname,
        path: reqUrl.path,
        pathname: reqUrl.pathname || '/',
        query: reqUrl.query || ''
    };
}

// Derive serviceName + region from an AWS host, mirroring the signers.
function resolveServiceAndRegion(host) {
    let hostParts = host.split('.');
    let serviceName = '';
    let region = 'us-east-1';
    if (hostParts.length == 4) {
        if (hostParts[1].toLowerCase() === 's3') {
            serviceName = hostParts[1].toLowerCase();
        } else {
            serviceName = hostParts[0].toLowerCase();
            region = hostParts[1].toLowerCase();
        }
    } else if (hostParts.length == 3) {
        serviceName = hostParts[0].toLowerCase();
    } else if (hostParts.length == 5 && hostParts[1].toLowerCase() === 's3') {
        serviceName = hostParts[1].toLowerCase();
        region = hostParts[2].toLowerCase();
    } else {
        return new Error('hostname provided: [' + host + ']. ' +
            'Supported hostname format are: [[service-code].[region-code].amazonaws.com] or ' +
            '[[bucket].s3.[region-code].amazonaws.com] or [[service-code].amazonaws.com] for S3');
    }
    return { serviceName: serviceName, region: region };
}

// Build the canonical URI path exactly as the signers do.
function buildCanonicalUriPath(pathname) {
    if (pathname === '/') {
        return '/';
    }
    let canonicalUriPath = '';
    let splitPaths = pathname.split('/');
    splitPaths.shift();
    for (let i = 0; i < splitPaths.length; i++) {
        if (splitPaths[i].length == 0) {
            canonicalUriPath += '/';
        } else {
            canonicalUriPath += '/';
            canonicalUriPath += encodeRFC3986URIComponent(splitPaths[i]);
        }
    }
    return canonicalUriPath;
}

// Build the canonical query string exactly as the signers do.
function buildCanonicalQueryString(query) {
    let queriesToBeProcessed = {};
    let queryParts = query.split('&');
    if (queryParts.length > 0 && queryParts[0] === '') {
        queryParts.shift();
    }
    let queryNames = [];
    for (let i = 0; i < queryParts.length; i++) {
        let querySubParts = queryParts[i].split('=');
        let eachQueryName = encodeRFC3986URIComponent(querySubParts[0]);
        queryNames.push(eachQueryName);
        queriesToBeProcessed[eachQueryName] = encodeRFC3986URIComponent(querySubParts[1]);
    }
    let sortedQueryNames = queryNames.sort();
    let canonicalQueryString = '';
    if (sortedQueryNames.length >= 1) {
        canonicalQueryString = sortedQueryNames[0] + '=' + queriesToBeProcessed[sortedQueryNames[0]];
    }
    for (let i = 1; i < sortedQueryNames.length; i++) {
        canonicalQueryString += '&' + sortedQueryNames[i] + '=' + queriesToBeProcessed[sortedQueryNames[i]];
    }
    return canonicalQueryString;
}

// Normalize the request body the same way the POST signers do: form-url-encoded
// bodies are re-encoded field by field; everything else is passed through.
function normalizePayload(body, contentType) {
    if (body == null) {
        return '';
    }
    if (isFormUrlEncoded(contentType)) {
        let payload = '';
        let payloadParts = body.split('&');
        if (payloadParts.length >= 1) {
            let sub = payloadParts[0].split('=');
            payload += encodeURIComponent(sub[0]) + '=' + encodeURIComponent(sub[1]);
        }
        for (let i = 1; i < payloadParts.length; i++) {
            let sub = payloadParts[i].split('=');
            payload += '&' + encodeURIComponent(sub[0]) + '=' + encodeURIComponent(sub[1]);
        }
        return payload;
    }
    return body;
}

// Produce the exact SigV4 header-signed request for an AWS profile, returning
// { method, url, headers, body } — the faithful reproduction of what the invoke
// path would send. `credentials` carries accessKeyId/secretAccessKey and, for
// SSO, sessionToken. `lowerHeaders` are the caller's extra headers (lowercased).
//
// Mirrors iamGet/ssoGet for GET and iamPost/ssoPost for body-bearing methods.
function buildAwsSignedRequest(options, credentials, lowerHeaders) {
    let algorithm = 'AWS4-HMAC-SHA256';
    let host = options.host;
    let sr = resolveServiceAndRegion(host);
    if (sr instanceof Error) {
        return sr;
    }
    let serviceName = sr.serviceName;
    let region = sr.region;
    let method = options.method.toUpperCase();
    let isGet = method === 'GET';

    let amzDates = sigv4.amzDates();
    let requestDateTime = amzDates.amzDate;
    let dateStamp = amzDates.dateStamp;
    let awsRequestTerminator = 'aws4_request';

    let canonicalUriPath = buildCanonicalUriPath(options.pathname);
    let canonicalQueryString = buildCanonicalQueryString(options.query);

    let contentType = lowerHeaders['content-type'];
    let payload = isGet ? '' : normalizePayload(options.body, contentType);
    if (payload == undefined) {
        payload = '';
    }
    let hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');

    let hasSecurityToken = !!(credentials && credentials.sessionToken);

    // Assemble the headers we sign. GET signs a minimal set; body-bearing methods
    // additionally sign the amz-sdk-* + content-length headers, matching the
    // existing signers so the reproduced request is byte-for-byte compatible.
    let headersToBeProcessed = {
        'host': host,
        'x-amz-content-sha256': hashedPayload,
        'x-amz-date': requestDateTime
    };
    if (!isGet) {
        headersToBeProcessed['amz-sdk-invocation-id'] = uuidv4();
        headersToBeProcessed['amz-sdk-request'] = 'attempt=1; max=4';
        headersToBeProcessed['content-length'] = payload.length;
    }
    if (hasSecurityToken) {
        headersToBeProcessed['x-amz-security-token'] = credentials.sessionToken;
    }
    // Fold in the caller's extra headers (already lowercased).
    Object.keys(lowerHeaders).forEach((k) => {
        // x-amz-expires only applies to presigned URLs, never to a header-signed
        // request; drop it so it is neither signed nor emitted.
        if (k === 'x-amz-expires') {
            return;
        }
        headersToBeProcessed[k] = lowerHeaders[k];
    });

    let sortedHeaders = Object.keys(headersToBeProcessed).sort();
    let canonicalHeaders = '';
    for (let i = 0; i < sortedHeaders.length; i++) {
        canonicalHeaders += sortedHeaders[i] + ':' + headersToBeProcessed[sortedHeaders[i]] + '\n';
    }
    let signedHeaders = sortedHeaders.join(';');

    let canonicalRequest = method + '\n' +
        canonicalUriPath + '\n' +
        canonicalQueryString + '\n' +
        canonicalHeaders + '\n' +
        signedHeaders + '\n' +
        hashedPayload;
    let hashedCanonicalRequest = sigv4.sha256Hex(canonicalRequest);

    let credentialScope = dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator;
    let stringToSign = algorithm + '\n' +
        requestDateTime + '\n' +
        credentialScope + '\n' +
        hashedCanonicalRequest;
    let signature = sigv4.sign(credentials.secretAccessKey, dateStamp, region, serviceName, stringToSign);

    let credential = 'Credential=' + credentials.accessKeyId + '/' + dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator;
    let authorizationHeader = algorithm + ' ' + credential + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    // Build the emitted header set. Host is dropped (curl derives it from the
    // URL). Everything else that was signed is emitted so the signature verifies.
    let emitted = {};
    Object.keys(headersToBeProcessed).forEach((k) => {
        if (k === 'host') {
            return;
        }
        emitted[k] = headersToBeProcessed[k];
    });
    emitted['Authorization'] = authorizationHeader;

    return {
        method: method,
        url: options.endpoint,
        headers: emitted,
        body: isGet ? null : payload
    };
}

// Extract + resolve the common option fields shared by all curl-prep flows.
// Returns { options } or an Error.
function extractOptions(req) {
    if (!req.body || !req.body.options) {
        return new Error('options not available in request payload');
    }
    let options = req.body.options;
    if (!options['userName']) {
        options['userName'] = authConfig.getDefaultUserName();
    }
    if (!options['endpoint']) {
        return new Error('endpoint not provided in options payload');
    }
    let resolved = commonUtils.resolveEndpoint(options['userName'], options['endpoint']);
    if (typeof resolved === 'string' && resolved.startsWith('ERROR:: ')) {
        return new Error(resolved);
    }
    options['endpoint'] = resolved;
    if (!options['method']) {
        return new Error('http method not provided in request payload');
    }
    if (!options['profileName']) {
        return new Error('profileName not provided in request payload');
    }
    // Lowercase headers, matching the signers' expectation.
    let lower = {};
    if (options['headers']) {
        Object.keys(options['headers']).forEach((k) => {
            lower[k.toLowerCase()] = options['headers'][k];
        });
    }
    options['headers'] = lower;
    // Stringify a JSON object body the same way the signers receive it.
    if (options['body'] && typeof options['body'] === 'object' &&
        !isFormUrlEncoded(lower['content-type'])) {
        options['body'] = JSON.stringify(options['body']);
    }
    let parsed = parseEndpoint(options['endpoint']);
    if (parsed instanceof Error) {
        return parsed;
    }
    Object.assign(options, parsed);
    return { options: options };
}

// What each AWS mechanism puts in the copied command, in the user's terms. The
// distinction matters: an IAM-user curl stops working because the *signature*
// aged out, whereas an SSO/EC2/IRSA curl also carries a session token that dies
// on its own schedule — so "re-copy it" and "re-authorize first" are different
// instructions.
const AWS_CURL_CREDENTIAL_DESCRIPTIONS = {
    iam_user: 'is signed with AWS SigV4 headers',
    sso_user: 'carries a short-lived AWS SSO session token',
    ec2_instance: 'carries a short-lived session token from the EC2 instance role',
    irsa: 'carries a short-lived session token from the IRSA web-identity exchange'
};

// Pure, so the wording can be pinned by tests: this note is the only thing that
// explains why a command that worked a minute ago now returns 403.
function awsCurlNote(resolved) {
    let mode = resolved && resolved.authnMode;
    let what = AWS_CURL_CREDENTIAL_DESCRIPTIONS[mode] || 'is signed with AWS SigV4 headers';
    return 'This curl ' + what + ' and is valid only for a few minutes. ' +
        'For a long-lived shareable request use "Copy as curl (shareable)".';
}

// POST /prepareCurlRequest — dispatches on authnMode and returns a request
// description for "Copy as curl". Never invokes the target and never writes
// history. Response shape:
//   { statusCode, response: { method, url, headers, body, containsLiveCredential, note } }
function prepareCurlRequest(req, res) {
    try {
        let extracted = extractOptions(req);
        if (extracted instanceof Error) {
            return res.status(400).json({ 'message': extracted.message });
        }
        let options = extracted.options;
        let authnMode = (options['authnMode'] || '').toLowerCase();

        // Every AWS mechanism takes one path: credentialProvider resolves the
        // credentials (IAM keys, an SSO role, the EC2 instance role over SSH, or
        // an IRSA web-identity exchange) and buildAwsSignedRequest signs with
        // whatever came back — it adds x-amz-security-token when there is one, so
        // it does not care which mechanism minted it.
        if (authnModes.isAwsAuthnMode(authnMode)) {
            credentialProvider.resolveByProfileName(options['userName'], options['profileName'], authnMode, (credErr, resolved) => {
                if (credErr) {
                    return res.status(200).json({
                        statusCode: credErr.statusCode || 401,
                        response: { message: credErr.message, verificationUriComplete: credErr.verificationUriComplete }
                    });
                }
                let built = buildAwsSignedRequest(options, resolved.credentials, options['headers']);
                if (built instanceof Error) {
                    return res.status(200).json({ statusCode: 400, response: { message: built.message } });
                }
                return res.status(200).json({
                    statusCode: 200,
                    response: Object.assign(built, {
                        containsLiveCredential: true,
                        note: awsCurlNote(resolved)
                    })
                });
            });
            return;
        }

        if (authnMode === 'rest_basic_auth') {
            profileUtils.searchProfile(options['userName'], options['profileName'], (searchErr, profile) => {
                if (searchErr) {
                    return res.status(200).json({ statusCode: searchErr.statusCode || 400, response: { message: searchErr.message } });
                }
                let basicAuthString = profile.basicAuthUsername + ':' + profile.basicAuthPassword;
                let base64BasicAuth = Buffer.from(basicAuthString, 'utf8').toString('base64');
                let headers = {};
                Object.keys(options['headers']).forEach((k) => { headers[k] = options['headers'][k]; });
                headers['Authorization'] = 'Basic ' + base64BasicAuth;
                return res.status(200).json({
                    statusCode: 200,
                    response: {
                        method: options['method'].toUpperCase(),
                        url: options['endpoint'],
                        headers: headers,
                        body: options['body'] || null,
                        containsLiveCredential: true,
                        note: 'This curl embeds a live Basic auth credential. Share carefully.'
                    }
                });
            });
            return;
        }

        if (authnMode === 'rest_bearer_token') {
            profileUtils.searchProfile(options['userName'], options['profileName'], (searchErr, profile) => {
                if (searchErr) {
                    return res.status(200).json({ statusCode: searchErr.statusCode || 400, response: { message: searchErr.message } });
                }
                restAuth.resolveBearerToken(profile, { errorOnExpiry: true }, (tokenErr, token) => {
                    if (tokenErr) {
                        return res.status(200).json({ statusCode: tokenErr.statusCode || 400, response: { message: tokenErr.message } });
                    }
                    let headers = {};
                    Object.keys(options['headers']).forEach((k) => { headers[k] = options['headers'][k]; });
                    headers['Authorization'] = 'Bearer ' + token;
                    return res.status(200).json({
                        statusCode: 200,
                        response: {
                            method: options['method'].toUpperCase(),
                            url: options['endpoint'],
                            headers: headers,
                            body: options['body'] || null,
                            containsLiveCredential: true,
                            note: 'This curl embeds a live bearer token. Share carefully.'
                        }
                    });
                });
            });
            return;
        }

        // generic (unsigned) — no credential to add; the browser can build this
        // itself, but we support it for completeness.
        if (authnMode === 'generic' || authnMode === '') {
            let headers = {};
            Object.keys(options['headers']).forEach((k) => { headers[k] = options['headers'][k]; });
            return res.status(200).json({
                statusCode: 200,
                response: {
                    method: options['method'].toUpperCase(),
                    url: options['endpoint'],
                    headers: headers,
                    body: options['body'] || null,
                    containsLiveCredential: false,
                    note: null
                }
            });
        }

        return res.status(200).json({ statusCode: 400, response: { message: 'invalid authnMode provided: ' + authnMode } });
    } catch (catchErr) {
        log.error('caught unexpected error in prepareCurlRequest: ', catchErr.message);
        return res.status(500).json({ 'message': catchErr.message });
    }
}

module.exports = {
    prepareCurlRequest: prepareCurlRequest,
    // exposed for unit testing
    awsCurlNote: awsCurlNote,
    buildAwsSignedRequest: buildAwsSignedRequest,
    buildCanonicalQueryString: buildCanonicalQueryString,
    buildCanonicalUriPath: buildCanonicalUriPath,
    normalizePayload: normalizePayload
};
