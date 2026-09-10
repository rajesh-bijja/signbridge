"use strict";

// Tests for S3 endpoint resolution.
//
// Both decisions here fail in ways that look like something else: a dotted
// bucket name over virtual-hosted style fails TLS validation (which surfaces as
// a network error, not an S3 error), and a wrong region gets a 301 with an
// unhelpful body. So the rules are pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');

const s3Endpoint = require('../lib/s3/s3Endpoint');

test('an ordinary bucket uses virtual-hosted style on a regional host', () => {
    let endpoint = s3Endpoint.bucketEndpoint('my-bucket', 'a/b.txt', 'us-west-2');
    assert.equal(endpoint.host, 'my-bucket.s3.us-west-2.amazonaws.com');
    assert.equal(endpoint.path, '/a/b.txt');
    assert.equal(endpoint.style, 'virtual-hosted');
});

test('a dotted bucket name falls back to path style', () => {
    // S3 presents a single-label wildcard cert (*.s3.<region>.amazonaws.com), so
    // logs.example.com.s3... has two extra labels and fails cert validation.
    let endpoint = s3Endpoint.bucketEndpoint('logs.example.com', 'app.log', 'us-east-1');
    assert.equal(endpoint.host, 's3.us-east-1.amazonaws.com');
    assert.equal(endpoint.path, '/logs.example.com/app.log');
    assert.equal(endpoint.style, 'path');
});

test('names that are not DNS-compatible use path style', () => {
    assert.equal(s3Endpoint.isDnsCompatibleBucket('My-Bucket'), false, 'uppercase');
    assert.equal(s3Endpoint.isDnsCompatibleBucket('my_bucket'), false, 'underscore');
    assert.equal(s3Endpoint.isDnsCompatibleBucket('ab'), false, 'too short');
    assert.equal(s3Endpoint.isDnsCompatibleBucket('a'.repeat(64)), false, 'too long');
    assert.equal(s3Endpoint.isDnsCompatibleBucket('-leading'), false, 'leading hyphen');
    assert.equal(s3Endpoint.isDnsCompatibleBucket('trailing-'), false, 'trailing hyphen');
    assert.equal(s3Endpoint.isDnsCompatibleBucket('192.168.0.1'), false, 'IP shape');
    assert.equal(s3Endpoint.isDnsCompatibleBucket('my-bucket-123'), true);
    assert.equal(s3Endpoint.isDnsCompatibleBucket('a'.repeat(63)), true, '63 is the limit, inclusive');
});

test('a bucket-level call gets a path with no key', () => {
    let virtualHosted = s3Endpoint.bucketEndpoint('my-bucket', null, 'eu-west-1');
    assert.equal(virtualHosted.path, '/');
    // Path style still needs the bucket segment, with a trailing slash.
    let pathStyle = s3Endpoint.bucketEndpoint('my.bucket', null, 'eu-west-1');
    assert.equal(pathStyle.path, '/my.bucket/');
});

test('a folder key keeps its trailing slash: a/b/ and a/b are different objects', () => {
    let endpoint = s3Endpoint.bucketEndpoint('my-bucket', 'a/b/', 'us-east-1');
    assert.equal(endpoint.path, '/a/b/');
});

test('us-east-1 gets a regional host, never the global s3.amazonaws.com', () => {
    // The global endpoint redirects for buckets elsewhere and confuses region
    // learning; regional hosts are always correct.
    assert.equal(s3Endpoint.serviceHost('us-east-1'), 's3.us-east-1.amazonaws.com');
    assert.equal(s3Endpoint.bucketEndpoint('my-bucket', 'k', 'us-east-1').host,
        'my-bucket.s3.us-east-1.amazonaws.com');
});

test('GetBucketLocation aliases are normalised', () => {
    // The API returns an empty LocationConstraint for us-east-1 and the legacy
    // alias 'EU' for eu-west-1. Signing with either literal produces a 403.
    assert.equal(s3Endpoint.normalizeRegion(''), 'us-east-1');
    assert.equal(s3Endpoint.normalizeRegion('EU'), 'eu-west-1');
    assert.equal(s3Endpoint.normalizeRegion('ap-south-1'), 'ap-south-1');
});

test('a missing region falls back to the default rather than producing s3.undefined', () => {
    assert.equal(s3Endpoint.normalizeRegion(null), 'us-east-1');
    assert.equal(s3Endpoint.normalizeRegion(undefined), 'us-east-1');
    assert.equal(s3Endpoint.normalizeRegion('   '), 'us-east-1');
    assert.equal(s3Endpoint.serviceHost(undefined), 's3.us-east-1.amazonaws.com');
});

test('surrounding whitespace in a region is tolerated', () => {
    // Regions arrive from ~/.aws/config, where a stray space is easy to leave in.
    assert.equal(s3Endpoint.normalizeRegion(' us-west-2 '), 'us-west-2');
});
