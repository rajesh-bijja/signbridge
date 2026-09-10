"use strict";

// Thin HTTPS client for the AWS control-plane calls SignBridge makes on its own
// behalf (eks, iam, sts) and for the Kubernetes API server (IRSA). Signing is
// delegated to lib/awsSigner.js; this module is only I/O, so nothing here needs
// a unit test — the decisions live in awsSigner / irsaUtils / ec2Utils.

const https = require('https');
const { parseString } = require('xml2js');
const awsSigner = require('./awsSigner');

const DEFAULT_TIMEOUT_MS = 30000;

function regionalHost(service, region) {
    return service + '.' + region + '.amazonaws.com';
}

// Global-ish endpoint for STS. We deliberately use the regional endpoint (the
// AWS default since 2023) so the signature region matches the host.
function stsHost(region) {
    return regionalHost('sts', region);
}

function request(options, cb) {
    let done = false;
    let finish = (err, result) => {
        if (done) { return; }
        done = true;
        cb(err, result);
    };

    let req = https.request({
        host: options.host,
        port: options.port || 443,
        method: options.method || 'GET',
        path: options.path,
        headers: options.headers || {},
        ca: options.ca,
        rejectUnauthorized: options.rejectUnauthorized !== false,
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS
    }, (res) => {
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
            finish(null, {
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            });
        });
    });
    req.on('timeout', () => {
        req.destroy(new Error('request to ' + options.host + ' timed out after ' + (options.timeoutMs || DEFAULT_TIMEOUT_MS) + 'ms'));
    });
    req.on('error', (err) => finish(err));
    if (options.body) {
        req.write(options.body);
    }
    req.end();
}

// SigV4-signed call to an AWS service. `query` is a plain object; `body` a string.
// cb(err, { statusCode, headers, body })
function callSigned(input, cb) {
    let host = input.host || regionalHost(input.service, input.region);
    let headers = Object.assign({}, input.headers || {});
    if (input.body && !headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = input.contentType || 'application/x-www-form-urlencoded; charset=utf-8';
    }
    let signed;
    try {
        signed = awsSigner.signRequest({
            credentials: input.credentials,
            region: input.region,
            service: input.service,
            method: input.method || 'GET',
            host: host,
            path: input.path || '/',
            query: input.query,
            body: input.body,
            headers: headers
        });
    } catch (signErr) {
        return cb(signErr);
    }
    let queryString = awsSigner.canonicalQuery(input.query);
    let outHeaders = signed.headers;
    if (input.body) {
        // Set after signing (Content-Length is not part of the signature). Without
        // it Node would use chunked transfer encoding, which the query-protocol
        // services reject.
        outHeaders['content-length'] = Buffer.byteLength(input.body);
    }
    request({
        host: host,
        method: input.method || 'GET',
        path: (input.path || '/') + (queryString ? '?' + queryString : ''),
        headers: outHeaders,
        body: input.body,
        timeoutMs: input.timeoutMs
    }, cb);
}

// Unsigned call to an AWS query-protocol service. Used for
// sts:AssumeRoleWithWebIdentity, which authenticates with the web identity token
// itself and must NOT be signed (the point of IRSA is that we hold no AWS
// credentials for the target role yet).
function callUnsigned(input, cb) {
    let host = input.host || regionalHost(input.service, input.region);
    let body = input.body || '';
    request({
        host: host,
        method: input.method || 'POST',
        path: input.path || '/',
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
            'content-length': Buffer.byteLength(body)
        },
        body: body,
        timeoutMs: input.timeoutMs
    }, cb);
}

// Kubernetes API server call. The cluster's CA (base64 DER/PEM from
// eks:DescribeCluster) is passed as `caPem` so TLS is verified properly rather
// than disabled.
function callKubernetes(input, cb) {
    let headers = Object.assign({
        'authorization': 'Bearer ' + input.token,
        'accept': 'application/json'
    }, input.headers || {});
    if (input.body) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(input.body);
    }
    request({
        host: input.host,
        port: input.port || 443,
        method: input.method || 'GET',
        path: input.path,
        headers: headers,
        body: input.body,
        ca: input.caPem,
        timeoutMs: input.timeoutMs
    }, cb);
}

// Parse an XML error/response body from a query-protocol service (sts, iam).
// cb(err, parsedObject)
function parseXml(body, cb) {
    parseString(body, { explicitArray: false, ignoreAttrs: true }, cb);
}

// Turn a non-2xx AWS response into a useful Error. Handles both the JSON shape
// (eks: {"message": "..."}) and the XML shape (sts/iam: <Error><Code/><Message/>).
function toAwsError(context, response) {
    let message = null;
    let code = null;
    let body = response && response.body ? response.body : '';
    if (body) {
        try {
            let parsed = JSON.parse(body);
            message = parsed.message || parsed.Message || null;
            code = parsed.__type || parsed.code || null;
        } catch (jsonErr) {
            let codeMatch = body.match(/<Code>([^<]*)<\/Code>/);
            let messageMatch = body.match(/<Message>([^<]*)<\/Message>/);
            code = codeMatch ? codeMatch[1] : null;
            message = messageMatch ? messageMatch[1] : null;
        }
    }
    let text = context + ' failed';
    if (response && response.statusCode) {
        text += ' (HTTP ' + response.statusCode + ')';
    }
    if (code) {
        text += ': ' + code;
    }
    if (message) {
        text += (code ? ' — ' : ': ') + message;
    }
    if (!code && !message && body) {
        text += ': ' + body.slice(0, 400);
    }
    let err = new Error(text);
    err.statusCode = response && response.statusCode ? response.statusCode : 400;
    err.awsErrorCode = code;
    return err;
}

module.exports = {
    regionalHost: regionalHost,
    stsHost: stsHost,
    callSigned: callSigned,
    callUnsigned: callUnsigned,
    callKubernetes: callKubernetes,
    parseXml: parseXml,
    toAwsError: toAwsError
};
