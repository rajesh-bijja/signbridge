"use strict";

// The SigV4 credential scope's service name.
//
// Every signer used to read it off the hostname's first label. That is right for
// most of AWS and wrong whenever a service's botocore `signingName` differs from
// its `endpointPrefix` — the case that surfaced it being Bedrock, where
// `bedrock-runtime.<region>.amazonaws.com` must be signed as `bedrock` or AWS
// answers
//
//     401 Credential should be scoped to correct service: 'bedrock'.
//
// which names a credential and means a service name, so it sends you looking at
// the wrong thing. Every profile type failed identically, because the credentials
// were never the problem.
//
// Two properties are asserted here: the override table does its job, and the set of
// hostnames accepted is *unchanged* from the inline code this replaced — the module
// is a refactor plus a table, and a host shape that signed correctly before must
// still sign identically.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const awsSigningName = require('../lib/awsSigningName');

test('bedrock-runtime signs as bedrock', () => {
    const target = awsSigningName.resolveSigningTarget('bedrock-runtime.us-east-1.amazonaws.com');
    assert.strictEqual(target.serviceName, 'bedrock');
    assert.strictEqual(target.region, 'us-east-1');
    // The endpoint prefix is kept, because a log line naming both is the whole
    // difference between a quick diagnosis and a long one.
    assert.strictEqual(target.endpointPrefix, 'bedrock-runtime');
});

test('the region comes from the hostname, not a default', () => {
    // Bedrock model availability is regional, so signing us-east-1 for a
    // eu-central-1 host would fail in a way that looks like "model not available".
    const target = awsSigningName.resolveSigningTarget('bedrock-runtime.eu-central-1.amazonaws.com');
    assert.strictEqual(target.serviceName, 'bedrock');
    assert.strictEqual(target.region, 'eu-central-1');
});

test('a service whose signing name is its host prefix is unaffected', () => {
    for (const [host, service, region] of [
        ['dynamodb.us-east-1.amazonaws.com', 'dynamodb', 'us-east-1'],
        ['sts.us-west-2.amazonaws.com', 'sts', 'us-west-2'],
        ['monitoring.us-east-1.amazonaws.com', 'monitoring', 'us-east-1'],
        ['execute-api.ap-south-1.amazonaws.com', 'execute-api', 'ap-south-1']
    ]) {
        const target = awsSigningName.resolveSigningTarget(host);
        assert.strictEqual(target.serviceName, service, host);
        assert.strictEqual(target.region, region, host);
    }
});

test('the accepted host shapes are exactly the ones the inline code accepted', () => {
    // Global (3-label) host: service from the first label, region defaults.
    let target = awsSigningName.resolveSigningTarget('iam.amazonaws.com');
    assert.strictEqual(target.serviceName, 'iam');
    assert.strictEqual(target.region, awsSigningName.DEFAULT_REGION);

    // Virtual-host S3 without a region.
    target = awsSigningName.resolveSigningTarget('my-bucket.s3.amazonaws.com');
    assert.strictEqual(target.serviceName, 's3');
    assert.strictEqual(target.region, awsSigningName.DEFAULT_REGION);

    // Virtual-host S3 with a region: the region is the third label, not the second.
    target = awsSigningName.resolveSigningTarget('my-bucket.s3.eu-west-1.amazonaws.com');
    assert.strictEqual(target.serviceName, 's3');
    assert.strictEqual(target.region, 'eu-west-1');
});

test('an underivable host is refused with the original message', () => {
    // The presigners surface this text to the user, so it is part of the contract.
    for (const bad of ['', 'localhost', 'a.b', 'streams.dynamodb.us-east-1.amazonaws.com']) {
        const target = awsSigningName.resolveSigningTarget(bad);
        assert.ok(target.error, 'must be refused: ' + JSON.stringify(bad));
        assert.match(target.error, /Supported hostname format are/);
        assert.strictEqual(target.serviceName, undefined,
            'a refused host must not also carry a service name');
    }
});

test('signingNameFor is usable without inventing a hostname', () => {
    // The Bedrock chat client already knows its service; it should not have to
    // synthesise a host to ask what to sign.
    assert.strictEqual(awsSigningName.signingNameFor('bedrock-runtime'), 'bedrock');
    assert.strictEqual(awsSigningName.signingNameFor('BEDROCK-RUNTIME'), 'bedrock');
    assert.strictEqual(awsSigningName.signingNameFor('dynamodb'), 'dynamodb');
    assert.strictEqual(awsSigningName.signingNameFor(''), '');
    assert.strictEqual(awsSigningName.signingNameFor(null), '');
});

test('every override actually differs from its endpoint prefix', () => {
    // An entry mapping a prefix to itself is dead weight that reads as meaningful,
    // and a typo'd one silently breaks a service that works today.
    for (const prefix of Object.keys(awsSigningName.SIGNING_NAME_OVERRIDES)) {
        const signing = awsSigningName.SIGNING_NAME_OVERRIDES[prefix];
        assert.notStrictEqual(signing, prefix,
            prefix + ' maps to itself — remove it rather than listing it');
        assert.strictEqual(prefix, prefix.toLowerCase(),
            prefix + ' must be lower case; lookups are lower-cased');
        assert.ok(signing && typeof signing === 'string', prefix + ' needs a signing name');
    }
});

test('no signer derives the service from the hostname on its own any more', () => {
    // Four copies of that derivation is how they drifted out of agreement in the
    // first place. If one grows its own copy back, Bedrock breaks only in whichever
    // path that signer serves — presign works and invoke does not, or vice versa.
    for (const signer of ['ssoPost.js', 'iamPost.js', 'ssoPresigned.js', 'iamPresigned.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'lib', signer), 'utf8');
        assert.ok(/awsSigningName\.resolveSigningTarget\(/.test(source),
            signer + ' must resolve the signing name through the shared module');
        assert.ok(!/hostParts\s*\[\s*0\s*\]\s*\.toLowerCase\(\)/.test(source),
            signer + ' must not derive the service from the hostname itself');
    }
});
