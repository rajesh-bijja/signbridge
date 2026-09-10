"use strict";

// Shaping a ListBuckets response.
//
// Two failure modes here are silent rather than loud, which is why they are
// pinned:
//
//   1. `BucketRegion` is only present when the request asked for a page size.
//      Drop that parameter from listBuckets and every Region column in S3 World
//      quietly reads "unknown" again — nothing errors.
//   2. xml2js runs with `explicitArray:false`, so an account with exactly one
//      bucket yields an object where every other account yields an array. Miss
//      that and the single-bucket case throws or lists nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bucketsFromListResult } = require('../lib/s3/s3Client');

test('regions come straight from the listing', () => {
    let buckets = bucketsFromListResult({
        Buckets: {
            Bucket: [
                { Name: 'logs-use1', CreationDate: '2022-08-22T05:16:07.000Z', BucketRegion: 'us-east-1' },
                { Name: 'assets-euw1', CreationDate: '2024-01-02T00:00:00.000Z', BucketRegion: 'eu-west-1' }
            ]
        }
    });
    assert.deepEqual(buckets, [
        { name: 'logs-use1', creationDate: '2022-08-22T05:16:07.000Z', region: 'us-east-1' },
        { name: 'assets-euw1', creationDate: '2024-01-02T00:00:00.000Z', region: 'eu-west-1' }
    ]);
});

test('a single bucket is still a list', () => {
    // explicitArray:false collapses one <Bucket> into an object.
    let buckets = bucketsFromListResult({
        Buckets: { Bucket: { Name: 'only-one', CreationDate: '2020-01-01T00:00:00.000Z', BucketRegion: 'us-west-1' } }
    });
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].name, 'only-one');
    assert.equal(buckets[0].region, 'us-west-1');
});

test('a missing region is null, not undefined or a guess', () => {
    // An S3-compatible endpoint (or a request without parameters) omits the
    // field. Reporting null lets the UI fall back to GetBucketLocation; inventing
    // the signing region would put a confidently wrong region on screen.
    let buckets = bucketsFromListResult({
        Buckets: { Bucket: [{ Name: 'no-region-reported' }] }
    });
    assert.deepEqual(buckets, [{ name: 'no-region-reported', creationDate: null, region: null }]);
});

test('an account with no buckets is an empty list', () => {
    assert.deepEqual(bucketsFromListResult({}), []);
    assert.deepEqual(bucketsFromListResult({ Buckets: '' }), []);
    assert.deepEqual(bucketsFromListResult(null), []);
});
