"use strict";

// Core AWS Signature Version 4 primitives, extracted so they can be unit-tested
// against AWS's published canonical test vectors (see test/sigv4.test.js).
//
// These are the two steps that are identical across every signer in lib/:
//   1. derive the signing key   (HMAC chain: AWS4<secret> -> date -> region -> service -> aws4_request)
//   2. produce the hex signature (HMAC of the string-to-sign with that key)
// A regression in either silently breaks *every* presign/invoke path, so they
// are the highest-value thing to pin.

const crypto = require('crypto');

// Derive the SigV4 signing key. Returns a Buffer.
function getSignatureKey(secretAccessKey, dateStamp, region, serviceName) {
    let kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(dateStamp).digest();
    let kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    let kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
    let kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    return kSigning;
}

// Compute the final hex signature for a given string-to-sign.
function sign(secretAccessKey, dateStamp, region, serviceName, stringToSign) {
    let kSigning = getSignatureKey(secretAccessKey, dateStamp, region, serviceName);
    return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

// Convenience: SHA-256 hex digest (used for payload hashes and canonical-request hashes).
function sha256Hex(data) {
    return crypto.createHash('sha256').update(data == null ? '' : data).digest('hex');
}

// The two timestamps every SigV4 request carries, in the exact formats AWS
// requires: `amzDate` for X-Amz-Date / the string-to-sign, and `dateStamp` for
// the credential scope.
//
// This lives here rather than in each signer because thirteen files used to
// build the pair with moment (`moment().utc().format("YYYYMMDD[T]HHmmss[Z]")`),
// which meant a 300 KB legacy dependency for two substrings of an ISO 8601
// string — and, more to the point, thirteen private copies of a format that
// every signature in the app depends on. `toISOString()` is already exactly
// `YYYY-MM-DDTHH:mm:ss.sssZ` in UTC, so both formats are slices of it; taking
// them that way means there is no timezone handling to get wrong.
//
// `now` is injectable so this stays pure and testable, per the same rule as the
// rest of this module.
function amzDates(now) {
    let iso = (now || new Date()).toISOString();          // 2026-09-09T04:05:06.789Z
    let dateStamp = iso.slice(0, 10).replace(/-/g, '');   // 20260909
    let amzDate = dateStamp + 'T' + iso.slice(11, 19).replace(/:/g, '') + 'Z';
    return { amzDate: amzDate, dateStamp: dateStamp };
}

module.exports = {
    getSignatureKey: getSignatureKey,
    sign: sign,
    sha256Hex: sha256Hex,
    amzDates: amzDates
};
