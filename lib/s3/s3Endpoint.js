"use strict";

/**
 * s3Endpoint.js — where to send an S3 request, as pure functions.
 *
 * Two decisions live here, and both bite in the real world:
 *
 * 1. **Virtual-hosted vs path style.** Virtual-hosted
 *    (`bucket.s3.region.amazonaws.com`) is the modern default, but the TLS
 *    certificate S3 presents is a single-level wildcard `*.s3.region.amazonaws.com`.
 *    A bucket name containing a dot — extremely common for legacy
 *    `logs.example.com`-style buckets — produces a host with two extra labels,
 *    which the wildcard does NOT match, so the request fails certificate
 *    validation before S3 ever sees it. Those buckets must use path style
 *    (`s3.region.amazonaws.com/bucket/key`). Same for any name that isn't
 *    DNS-compatible (uppercase, underscores).
 *
 * 2. **Region.** A request for a bucket sent to the wrong region gets a 301
 *    PermanentRedirect with no usable body, and a SigV4 signature is region-
 *    scoped so it cannot simply be replayed elsewhere. So the caller must know
 *    the bucket's real region before signing; s3Client resolves and caches it
 *    via GetBucketLocation.
 */

// Region-scoped endpoints are always correct, including for us-east-1, so we
// never emit the global `s3.amazonaws.com`.
const DEFAULT_REGION = 'us-east-1';

// GetBucketLocation returns an empty LocationConstraint for us-east-1, and the
// legacy alias 'EU' for eu-west-1.
const LOCATION_ALIASES = {
    '': DEFAULT_REGION,
    'EU': 'eu-west-1'
};

/**
 * Is this bucket name safe to put in a hostname?
 * Lower-case alphanumerics and hyphens only, 3-63 chars, no dots (see the TLS
 * wildcard note above), not an IP-address shape.
 */
function isDnsCompatibleBucket(bucket) {
    let name = String(bucket || '');
    if (name.length < 3 || name.length > 63) {
        return false;
    }
    if (name.indexOf('.') !== -1) {
        return false;
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
        return false;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
        return false;
    }
    return true;
}

function normalizeRegion(region) {
    if (region == null) {
        return DEFAULT_REGION;
    }
    let value = String(region).trim();
    if (Object.prototype.hasOwnProperty.call(LOCATION_ALIASES, value)) {
        return LOCATION_ALIASES[value];
    }
    return value || DEFAULT_REGION;
}

/**
 * The service-level endpoint, used by operations that aren't bucket-scoped
 * (ListBuckets). Any region works for ListBuckets; we sign for the one given.
 */
function serviceHost(region) {
    return 's3.' + normalizeRegion(region) + '.amazonaws.com';
}

/**
 * Resolve host + un-encoded resource path for a bucket/key pair.
 *
 * @param {string} bucket
 * @param {string} [key]   object key, un-encoded; omit for bucket-level calls
 * @param {string} region
 * @returns {{ host: string, path: string, style: 'virtual-hosted'|'path' }}
 *          `path` is raw — s3Sign.canonicalizePath does the encoding, once.
 */
function bucketEndpoint(bucket, key, region) {
    let normalizedRegion = normalizeRegion(region);
    let objectKey = key == null ? '' : String(key);

    if (isDnsCompatibleBucket(bucket)) {
        return {
            host: bucket + '.s3.' + normalizedRegion + '.amazonaws.com',
            path: '/' + objectKey,
            style: 'virtual-hosted'
        };
    }

    return {
        host: serviceHost(normalizedRegion),
        path: '/' + bucket + (objectKey ? '/' + objectKey : '/'),
        style: 'path'
    };
}

module.exports = {
    DEFAULT_REGION: DEFAULT_REGION,
    LOCATION_ALIASES: LOCATION_ALIASES,
    isDnsCompatibleBucket: isDnsCompatibleBucket,
    normalizeRegion: normalizeRegion,
    serviceHost: serviceHost,
    bucketEndpoint: bucketEndpoint
};
