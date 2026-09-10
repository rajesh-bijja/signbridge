"use strict";

// Pins the SigV4 signing primitives against AWS's own published canonical test
// vector for the GET iam.amazonaws.com ?Action=ListUsers example. If the HMAC
// chain or string-to-sign handling ever drifts, this fails immediately instead
// of every signed request silently becoming invalid.
//
// Reference vector (AWS SigV4 "Examples of signed requests" / Signature v4
// test suite, get-vanilla-query style):
//   AccessKey: AKIDEXAMPLE
//   SecretKey: wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
//   Region:    us-east-1   Service: iam   Date: 20150830T123600Z

const test = require('node:test');
const assert = require('node:assert/strict');

const sigv4 = require('../lib/sigv4');

const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const REGION = 'us-east-1';
const SERVICE = 'iam';
const AMZ_DATE = '20150830T123600Z';
const DATE_STAMP = '20150830';
const HOST = 'iam.amazonaws.com';

test('sha256Hex: empty string matches the well-known SHA-256 of ""', () => {
    assert.equal(
        sigv4.sha256Hex(''),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
});

test('getSignatureKey: derived key produces the AWS-published signature', () => {
    // Rebuild the canonical request and string-to-sign exactly as the AWS doc
    // example specifies, then sign it with our derived key.
    const method = 'GET';
    const canonicalUri = '/';
    const canonicalQuerystring = 'Action=ListUsers&Version=2010-05-08';
    const canonicalHeaders =
        'content-type:application/x-www-form-urlencoded; charset=utf-8\n' +
        'host:' + HOST + '\n' +
        'x-amz-date:' + AMZ_DATE + '\n';
    const signedHeaders = 'content-type;host;x-amz-date';
    const payloadHash = sigv4.sha256Hex('');

    const canonicalRequest = [
        method, canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaders, payloadHash
    ].join('\n');

    const credentialScope = DATE_STAMP + '/' + REGION + '/' + SERVICE + '/aws4_request';
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        AMZ_DATE,
        credentialScope,
        sigv4.sha256Hex(canonicalRequest)
    ].join('\n');

    const signature = sigv4.sign(SECRET, DATE_STAMP, REGION, SERVICE, stringToSign);

    assert.equal(
        signature,
        '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7'
    );
});

test('sign: is deterministic for identical inputs', () => {
    const sts = 'AWS4-HMAC-SHA256\n' + AMZ_DATE + '\nscope\nhash';
    const a = sigv4.sign(SECRET, DATE_STAMP, REGION, SERVICE, sts);
    const b = sigv4.sign(SECRET, DATE_STAMP, REGION, SERVICE, sts);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/); // 32-byte HMAC as hex
});

test('sign: different secret yields a different signature', () => {
    const sts = 'AWS4-HMAC-SHA256\n' + AMZ_DATE + '\nscope\nhash';
    const a = sigv4.sign(SECRET, DATE_STAMP, REGION, SERVICE, sts);
    const b = sigv4.sign(SECRET + 'x', DATE_STAMP, REGION, SERVICE, sts);
    assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// amzDates — the X-Amz-Date / credential-scope pair.
//
// Worth pinning for two reasons. It replaced moment in thirteen signers, so a
// format slip would break every presign and invoke path at once; and the failure
// mode is not an exception but a signature mismatch, which AWS reports as a
// credential error. The vector below is AWS's own published example timestamp
// (the same one the signing-key test above uses), so these assertions are
// anchored to the spec rather than to the implementation.
// ---------------------------------------------------------------------------

test('amzDates: matches AWS\'s published example timestamp', () => {
    const dates = sigv4.amzDates(new Date('2015-08-30T12:36:00.000Z'));
    assert.equal(dates.amzDate, '20150830T123600Z');
    assert.equal(dates.dateStamp, '20150830');
});

test('amzDates: is UTC and drops sub-second precision', () => {
    // A local-midnight date would roll the dateStamp a day either way if this
    // ever used local time, and X-Amz-Date has no fractional-seconds field.
    const dates = sigv4.amzDates(new Date('2026-12-31T23:59:59.999Z'));
    assert.equal(dates.amzDate, '20261231T235959Z');
    assert.equal(dates.dateStamp, '20261231');
});

test('amzDates: pads single-digit fields', () => {
    const dates = sigv4.amzDates(new Date('1999-06-05T09:08:07.006Z'));
    assert.equal(dates.amzDate, '19990605T090807Z');
    assert.equal(dates.dateStamp, '19990605');
});

test('amzDates: dateStamp is always the amzDate prefix', () => {
    // The credential scope must name the same day the string-to-sign does; if
    // these two were ever derived from separate clock reads they could straddle
    // midnight and produce a scope AWS rejects.
    for (const iso of ['2026-01-01T00:00:00.000Z', '2026-07-04T12:00:00.000Z',
                       '2026-11-09T23:59:59.000Z']) {
        const dates = sigv4.amzDates(new Date(iso));
        assert.equal(dates.amzDate.slice(0, 8), dates.dateStamp);
        assert.match(dates.amzDate, /^\d{8}T\d{6}Z$/);
    }
});

test('amzDates: defaults to now when given no clock', () => {
    // Every signer calls it with no argument.
    const before = sigv4.amzDates(new Date(Date.now() - 1000));
    const now = sigv4.amzDates();
    const after = sigv4.amzDates(new Date(Date.now() + 1000));
    assert.match(now.amzDate, /^\d{8}T\d{6}Z$/);
    assert.ok(now.amzDate >= before.amzDate && now.amzDate <= after.amzDate);
});
