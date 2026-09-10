"use strict";

/**
 * s3Client.js — the S3 operations S3 World needs, signed with lib/s3/s3Sign.js.
 *
 * This is a hand-rolled client rather than an SDK call, for the same reason the
 * rest of lib/ is: SignBridge *is* a signing tool, the signing path is the part
 * worth owning, and it keeps the runtime dependency-light and air-gappable.
 * Only the operations the browser actually drives are implemented.
 *
 * Callback style (`cb(err, result)`) to match the rest of lib/.
 *
 * REGION HANDLING — the thing that makes or breaks a real S3 client. A SigV4
 * signature is scoped to a region, and S3 answers a request aimed at the wrong
 * region with `301 PermanentRedirect` / `400 AuthorizationHeaderMalformed` and
 * an empty or unhelpful body. Both responses carry the true region in the
 * `x-amz-bucket-region` header, so instead of calling GetBucketLocation before
 * every operation we sign optimistically, and on a region mismatch we learn the
 * region from that header, cache it, and retry once. The cache means the cost is
 * paid at most once per bucket per process.
 */

const https = require('https');
const { parseString } = require('xml2js');

const s3Sign = require('./s3Sign');
const s3Endpoint = require('./s3Endpoint');
const sigv4 = require('../sigv4');

// Give up on a stuck socket rather than holding a browser request open forever.
const REQUEST_TIMEOUT_MS = 120000;

// bucket -> region, learned from a redirect or GetBucketLocation. Buckets do not
// move between regions, so this never needs invalidating.
const bucketRegionCache = new Map();

// Response bodies we buffer (listings, errors, previews) are bounded; a full
// object download uses the streaming path instead and is never buffered.
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

function cachedBucketRegion(bucket) {
    return bucketRegionCache.get(bucket) || null;
}

function rememberBucketRegion(bucket, region) {
    if (bucket && region) {
        bucketRegionCache.set(bucket, region);
    }
}

/**
 * Turn an S3 XML error body into an Error carrying the S3 code, plus a message
 * a user can act on. The raw S3 messages are accurate but assume you know the
 * API ("The specified key does not exist."), so the common ones are rewritten
 * in terms of what the user was trying to do.
 */
function s3Error(statusCode, body, context) {
    let code = '';
    let message = '';
    let match = /<Code>([^<]*)<\/Code>/.exec(body || '');
    if (match) {
        code = match[1];
    }
    let messageMatch = /<Message>([^<]*)<\/Message>/.exec(body || '');
    if (messageMatch) {
        message = messageMatch[1];
    }

    let friendly = message;
    let where = context && context.bucket
        ? ' for bucket "' + context.bucket + '"' + (context.key ? ', key "' + context.key + '"' : '')
        : '';

    if (code === 'AccessDenied' || statusCode === 403) {
        friendly = 'Access denied' + where + '. The profile\'s credentials are valid but lack permission for this ' +
            'operation (needs s3:' + (context && context.action ? context.action : 'GetObject') + ').';
    } else if (code === 'NoSuchBucket') {
        friendly = 'No such bucket: "' + (context ? context.bucket : '') + '".';
    } else if (code === 'NoSuchKey') {
        friendly = 'No such object: "' + (context ? context.key : '') + '".';
    } else if (code === 'ExpiredToken' || code === 'ExpiredTokenException') {
        friendly = 'The session credentials have expired. Run "aws sso login --profile ' +
            ((context && context.profileName) || '<profile>') + '" and try again.';
    } else if (code === 'InvalidAccessKeyId') {
        friendly = 'The access key on this profile is not recognised by AWS.';
    } else if (code === 'SignatureDoesNotMatch') {
        friendly = 'AWS rejected the request signature. Check the profile\'s secret access key.';
    } else if (!friendly) {
        friendly = 'S3 request failed with HTTP ' + statusCode + (code ? ' (' + code + ')' : '') + '.';
    }

    let err = new Error(friendly);
    err.statusCode = statusCode;
    err.s3Code = code;
    err.s3Message = message;
    return err;
}

/**
 * Issue one signed request. Does not retry and does not know about regions —
 * `request()` layers that on top.
 *
 * @param {object} spec
 *   method, host, path, query, headers, body (Buffer|string|null), region,
 *   credentials, payloadHash (optional), stream (boolean)
 * @param {function} cb  cb(err, { statusCode, headers, body|stream })
 */
function rawRequest(spec, cb) {
    let body = spec.body == null ? null : (Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body));
    let payloadHash = spec.payloadHash ||
        (body ? sigv4.sha256Hex(body) : s3Sign.EMPTY_PAYLOAD_SHA256);

    let headers = Object.assign({}, spec.headers || {});
    if (body) {
        headers['content-length'] = String(body.length);
    }

    let signed = s3Sign.signRequest({
        method: spec.method,
        host: spec.host,
        path: spec.path,
        query: spec.query || {},
        headers: headers,
        payloadHash: payloadHash,
        region: spec.region,
        credentials: spec.credentials,
        now: new Date()
    });

    let canonicalQuery = s3Sign.canonicalQueryString(spec.query || {});
    let requestPath = s3Sign.canonicalizePath(spec.path) + (canonicalQuery ? '?' + canonicalQuery : '');

    // `host` is set by the agent from the options; sending it again as a header
    // is harmless but noisy, and Node rejects a duplicate.
    let sendHeaders = Object.assign({}, signed.headers);
    delete sendHeaders.host;

    let req = https.request({
        method: spec.method,
        host: spec.host,
        path: requestPath,
        headers: sendHeaders,
        timeout: REQUEST_TIMEOUT_MS
    }, function (res) {
        let statusCode = res.statusCode;

        // Streaming caller (object download / in-app viewer proxy): hand back the
        // live response on success so bytes never land in this process's memory.
        if (spec.stream && statusCode >= 200 && statusCode < 300) {
            return cb(null, { statusCode: statusCode, headers: res.headers, stream: res });
        }

        let chunks = [];
        let total = 0;
        let aborted = false;
        res.on('data', function (chunk) {
            total += chunk.length;
            if (total > MAX_BUFFERED_BYTES) {
                aborted = true;
                res.destroy();
                return;
            }
            chunks.push(chunk);
        });
        res.on('end', function () {
            if (aborted) {
                return cb(new Error('S3 response exceeded the ' +
                    Math.round(MAX_BUFFERED_BYTES / (1024 * 1024)) + ' MB buffer limit'));
            }
            cb(null, {
                statusCode: statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            });
        });
        res.on('error', function (err) {
            if (!aborted) {
                cb(err);
            }
        });
    });

    req.on('timeout', function () {
        req.destroy(new Error('S3 request timed out after ' + (REQUEST_TIMEOUT_MS / 1000) + 's'));
    });
    req.on('error', function (err) {
        cb(err);
    });

    if (body) {
        req.write(body);
    }
    req.end();
}

/**
 * Issue a signed request against a bucket, resolving the region as needed and
 * retrying once if S3 tells us we guessed wrong.
 *
 * @param {object} spec  as rawRequest, plus `bucket`, `key`, `action`,
 *                       `profileName` (for error messages) and `region` as the
 *                       starting guess.
 */
function request(spec, cb) {
    let bucket = spec.bucket;
    let attemptRegion = cachedBucketRegion(bucket) || s3Endpoint.normalizeRegion(spec.region);

    function attempt(region, isRetry) {
        let endpoint = bucket
            ? s3Endpoint.bucketEndpoint(bucket, spec.key, region)
            : { host: s3Endpoint.serviceHost(region), path: spec.path || '/' };

        rawRequest({
            method: spec.method,
            host: endpoint.host,
            path: bucket ? endpoint.path : (spec.path || '/'),
            query: spec.query,
            headers: spec.headers,
            body: spec.body,
            payloadHash: spec.payloadHash,
            region: region,
            credentials: spec.credentials,
            stream: spec.stream
        }, function (err, response) {
            if (err) {
                return cb(err);
            }
            if (response.statusCode >= 200 && response.statusCode < 300) {
                rememberBucketRegion(bucket, region);
                response.region = region;
                return cb(null, response);
            }

            // Wrong-region: S3 names the right one in a header. Learn and retry.
            let trueRegion = response.headers && response.headers['x-amz-bucket-region'];
            if (!isRetry && trueRegion && trueRegion !== region) {
                rememberBucketRegion(bucket, trueRegion);
                return attempt(trueRegion, true);
            }

            let bodyText = response.body ? response.body.toString('utf8') : '';
            cb(s3Error(response.statusCode, bodyText, {
                bucket: bucket,
                key: spec.key,
                action: spec.action,
                profileName: spec.profileName
            }));
        });
    }

    attempt(attemptRegion, false);
}

function parseXml(buffer, cb) {
    parseString(buffer.toString('utf8'), { explicitArray: false, trim: true }, cb);
}

// xml2js with explicitArray:false collapses a single-element list into an
// object. Every S3 listing needs the array form.
//
// It also renders an *empty* element (`<Buckets/>`, which ListBuckets returns for
// an account with no buckets) as the empty string. That is not one nameless item,
// it is zero items — without this guard the caller maps over `['']` and produces a
// phantom row, or throws reading a field off a string.
function asArray(value) {
    if (value == null || value === '') {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// Asking for a page size is what makes S3 fill in BucketRegion (see the comment
// on listBuckets). 1000 is generous enough that almost every account is one call.
const LIST_BUCKETS_PAGE_SIZE = 1000;

// A guard, not a limit: 20 pages is 20 000 buckets, far past any real account.
// It exists because the loop trusts a token from the server, and an S3-compatible
// endpoint that echoed the same token forever would otherwise spin here.
const LIST_BUCKETS_MAX_PAGES = 20;

/**
 * Shape one parsed ListBuckets response. Pure, and exported for the tests: the
 * two things that can go wrong here are silent. xml2js with `explicitArray:false`
 * collapses a single `<Bucket>` into an object rather than a one-element array,
 * and `BucketRegion` is simply absent on responses that didn't ask for it.
 */
function bucketsFromListResult(result) {
    return asArray(result && result.Buckets && result.Buckets.Bucket).map(function (bucket) {
        return {
            name: bucket.Name,
            creationDate: bucket.CreationDate || null,
            region: bucket.BucketRegion || null
        };
    });
}

/**
 * ListBuckets — every bucket the credentials can see, across all regions.
 * cb(err, { owner, buckets: [{ name, creationDate, region }] })
 *
 * REGION comes back with the listing, which is not obvious from the API docs and
 * is the difference between a populated Region column and 41 rows of "not
 * resolved". S3 includes `BucketRegion` per bucket **only when the request
 * carries at least one valid parameter** — a bare `GET /` returns just Name,
 * CreationDate and BucketArn. So we always send `max-buckets`, which costs
 * nothing and turns what used to be one GetBucketLocation *per bucket* into
 * zero extra calls. The regions are also fed into the region cache, so the first
 * drill-down into an out-of-region bucket skips its wrong-region retry too.
 *
 * That same parameter opts into pagination, hence the loop; an endpoint that
 * ignores the parameter just returns everything on the first page, and a client
 * that doesn't follow the token would silently show only the first 1000 buckets.
 * S3 World then paginates and filters the full set client-side.
 */
function listBuckets(credentials, region, cb) {
    let buckets = [];
    let owner = null;
    let seenTokens = new Set();

    function readPage(token, pageNumber) {
        let query = { 'max-buckets': String(LIST_BUCKETS_PAGE_SIZE) };
        if (token) {
            query['continuation-token'] = token;
        }
        request({
            method: 'GET',
            path: '/',
            query: query,
            region: region,
            credentials: credentials,
            action: 'ListAllMyBuckets'
        }, function (err, response) {
            if (err) {
                return cb(err);
            }
            parseXml(response.body, function (parseErr, parsed) {
                if (parseErr) {
                    return cb(parseErr);
                }
                let result = (parsed && parsed.ListAllMyBucketsResult) || {};
                if (!owner && result.Owner) {
                    owner = result.Owner.DisplayName || result.Owner.ID;
                }
                bucketsFromListResult(result).forEach(function (bucket) {
                    // Learn it now so no later operation has to ask.
                    rememberBucketRegion(bucket.name, bucket.region);
                    bucket.region = bucket.region || cachedBucketRegion(bucket.name);
                    buckets.push(bucket);
                });

                // On ListBuckets the response's own ContinuationToken *is* the
                // next page's token (there is no separate NextContinuationToken),
                // and it is absent on the last page.
                let next = result.ContinuationToken || null;
                if (next && !seenTokens.has(next) && pageNumber < LIST_BUCKETS_MAX_PAGES) {
                    seenTokens.add(next);
                    return readPage(next, pageNumber + 1);
                }
                cb(null, { owner: owner, buckets: buckets });
            });
        });
    }

    readPage(null, 1);
}

/**
 * GetBucketLocation — the bucket's region. Used when the UI wants the region
 * without listing anything (the badge next to a bucket name).
 */
function getBucketRegion(credentials, bucket, region, cb) {
    let cached = cachedBucketRegion(bucket);
    if (cached) {
        return cb(null, cached);
    }
    request({
        method: 'GET',
        bucket: bucket,
        query: { location: '' },
        region: region,
        credentials: credentials,
        action: 'GetBucketLocation'
    }, function (err, response) {
        if (err) {
            return cb(err);
        }
        parseXml(response.body, function (parseErr, parsed) {
            if (parseErr) {
                return cb(parseErr);
            }
            let constraint = parsed && parsed.LocationConstraint;
            // <LocationConstraint/> (us-east-1) parses to '' or an empty object.
            let raw = typeof constraint === 'string' ? constraint : '';
            let resolved = s3Endpoint.normalizeRegion(raw);
            rememberBucketRegion(bucket, resolved);
            cb(null, resolved);
        });
    });
}

/**
 * ListObjectsV2 — one page of a "folder".
 *
 * With `delimiter: '/'` S3 rolls every key sharing a prefix up into a single
 * CommonPrefix, which is how the flat keyspace is presented as directories.
 * Omitting the delimiter walks the whole subtree instead, which is what search
 * uses.
 *
 * cb(err, { prefixes: string[], objects: [{key,name,size,lastModified,etag,storageClass}],
 *           isTruncated, continuationToken, keyCount, region })
 */
function listObjects(credentials, options, cb) {
    let query = {
        'list-type': '2',
        'prefix': options.prefix || '',
        'max-keys': String(options.maxKeys || 1000)
    };
    if (options.delimiter) {
        query.delimiter = options.delimiter;
    }
    if (options.continuationToken) {
        query['continuation-token'] = options.continuationToken;
    }
    if (options.startAfter) {
        query['start-after'] = options.startAfter;
    }
    if (options.fetchOwner) {
        query['fetch-owner'] = 'true';
    }

    request({
        method: 'GET',
        bucket: options.bucket,
        query: query,
        region: options.region,
        credentials: credentials,
        action: 'ListBucket',
        profileName: options.profileName
    }, function (err, response) {
        if (err) {
            return cb(err);
        }
        parseXml(response.body, function (parseErr, parsed) {
            if (parseErr) {
                return cb(parseErr);
            }
            let result = (parsed && parsed.ListBucketResult) || {};
            let prefix = options.prefix || '';

            let prefixes = asArray(result.CommonPrefixes).map(function (entry) {
                return entry.Prefix;
            }).filter(Boolean);

            let objects = asArray(result.Contents).map(function (entry) {
                let key = entry.Key;
                return {
                    key: key,
                    name: key.slice(prefix.length),
                    size: parseInt(entry.Size, 10) || 0,
                    lastModified: entry.LastModified || null,
                    etag: entry.ETag ? entry.ETag.replace(/"/g, '') : null,
                    storageClass: entry.StorageClass || null
                };
            }).filter(function (entry) {
                // The zero-byte marker object that represents the folder itself
                // (key === prefix) is an implementation detail, not an entry.
                return entry.key !== prefix;
            });

            cb(null, {
                bucket: options.bucket,
                prefix: prefix,
                prefixes: prefixes,
                objects: objects,
                isTruncated: String(result.IsTruncated) === 'true',
                continuationToken: result.NextContinuationToken || null,
                keyCount: parseInt(result.KeyCount, 10) || objects.length,
                region: response.region
            });
        });
    });
}

/**
 * HeadObject — metadata without the body: size, content type, storage class,
 * server-side encryption, user metadata.
 */
function headObject(credentials, options, cb) {
    request({
        method: 'HEAD',
        bucket: options.bucket,
        key: options.key,
        query: options.versionId ? { versionId: options.versionId } : {},
        region: options.region,
        credentials: credentials,
        action: 'GetObject',
        profileName: options.profileName
    }, function (err, response) {
        if (err) {
            return cb(err);
        }
        let headers = response.headers || {};
        let metadata = {};
        Object.keys(headers).forEach(function (name) {
            if (name.indexOf('x-amz-meta-') === 0) {
                metadata[name.slice('x-amz-meta-'.length)] = headers[name];
            }
        });
        cb(null, {
            bucket: options.bucket,
            key: options.key,
            size: parseInt(headers['content-length'], 10) || 0,
            contentType: headers['content-type'] || null,
            contentEncoding: headers['content-encoding'] || null,
            lastModified: headers['last-modified'] || null,
            etag: headers.etag ? headers.etag.replace(/"/g, '') : null,
            storageClass: headers['x-amz-storage-class'] || 'STANDARD',
            versionId: headers['x-amz-version-id'] || null,
            serverSideEncryption: headers['x-amz-server-side-encryption'] || null,
            kmsKeyId: headers['x-amz-server-side-encryption-aws-kms-key-id'] || null,
            // Restore state matters: a GLACIER/DEEP_ARCHIVE object cannot be read
            // at all until restored, and the viewer needs to say so plainly.
            restore: headers['x-amz-restore'] || null,
            metadata: metadata,
            region: response.region
        });
    });
}

/**
 * GetObject into memory, optionally a byte range.
 *
 * Range is what makes previewing a 10 GB log viable: `bytes=0-262143` returns
 * the first 256 KB with status 206 and the object's full length in
 * Content-Range, so the viewer can show the head and say how much is left.
 */
function getObject(credentials, options, cb) {
    let headers = {};
    if (options.range) {
        headers.range = options.range;
    }
    request({
        method: 'GET',
        bucket: options.bucket,
        key: options.key,
        query: options.versionId ? { versionId: options.versionId } : {},
        headers: headers,
        region: options.region,
        credentials: credentials,
        action: 'GetObject',
        profileName: options.profileName
    }, function (err, response) {
        if (err) {
            return cb(err);
        }
        let responseHeaders = response.headers || {};
        // Content-Range: "bytes 0-262143/10737418240" — the part after '/' is the
        // real object size, which Content-Length does not give us for a 206.
        let totalSize = null;
        let contentRange = responseHeaders['content-range'];
        if (contentRange) {
            let match = /\/(\d+)$/.exec(contentRange);
            if (match) {
                totalSize = parseInt(match[1], 10);
            }
        }
        cb(null, {
            body: response.body,
            statusCode: response.statusCode,
            contentType: responseHeaders['content-type'] || null,
            contentEncoding: responseHeaders['content-encoding'] || null,
            contentLength: parseInt(responseHeaders['content-length'], 10) || (response.body ? response.body.length : 0),
            totalSize: totalSize,
            partial: response.statusCode === 206,
            etag: responseHeaders.etag ? responseHeaders.etag.replace(/"/g, '') : null,
            lastModified: responseHeaders['last-modified'] || null,
            headers: responseHeaders,
            region: response.region
        });
    });
}

/**
 * GetObject as a stream — for the download/view proxy, where the bytes should
 * flow through to the browser without being buffered here.
 * cb(err, { stream, headers, statusCode })
 */
function getObjectStream(credentials, options, cb) {
    let headers = {};
    if (options.range) {
        headers.range = options.range;
    }
    request({
        method: 'GET',
        bucket: options.bucket,
        key: options.key,
        query: options.versionId ? { versionId: options.versionId } : {},
        headers: headers,
        region: options.region,
        credentials: credentials,
        action: 'GetObject',
        profileName: options.profileName,
        stream: true
    }, cb);
}

/**
 * PutObject. Also how a "folder" is created: an empty object whose key ends in
 * '/', which is exactly what the S3 console does.
 */
function putObject(credentials, options, cb) {
    let headers = {};
    if (options.contentType) {
        headers['content-type'] = options.contentType;
    }
    request({
        method: 'PUT',
        bucket: options.bucket,
        key: options.key,
        query: {},
        headers: headers,
        body: options.body == null ? Buffer.alloc(0) : options.body,
        region: options.region,
        credentials: credentials,
        action: 'PutObject',
        profileName: options.profileName
    }, function (err, response) {
        if (err) {
            return cb(err);
        }
        cb(null, {
            key: options.key,
            etag: response.headers && response.headers.etag ? response.headers.etag.replace(/"/g, '') : null,
            region: response.region
        });
    });
}

/**
 * CopyObject — the server-side copy that backs both Copy and Move (a move is a
 * copy followed by a delete; S3 has no rename).
 */
function copyObject(credentials, options, cb) {
    // x-amz-copy-source must be URL-encoded, and must include the bucket.
    let source = '/' + options.sourceBucket + '/' +
        String(options.sourceKey).split('/').map(s3Sign.encodeRfc3986).join('/');
    request({
        method: 'PUT',
        bucket: options.bucket,
        key: options.key,
        query: {},
        headers: { 'x-amz-copy-source': source },
        region: options.region,
        credentials: credentials,
        action: 'PutObject',
        profileName: options.profileName
    }, function (err, response) {
        if (err) {
            return cb(err);
        }
        cb(null, { key: options.key, region: response.region });
    });
}

/**
 * DeleteObjects — the batch form (POST ?delete with an XML manifest), capped by
 * S3 at 1000 keys per call. The caller chunks.
 */
function deleteObjects(credentials, options, cb) {
    let keys = options.keys || [];
    if (!keys.length) {
        return cb(null, { deleted: [], errors: [] });
    }

    function escapeXml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    let body = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        keys.map(function (key) {
            return '<Object><Key>' + escapeXml(key) + '</Key></Object>';
        }).join('') +
        '<Quiet>false</Quiet></Delete>';

    let bodyBuffer = Buffer.from(body, 'utf8');
    request({
        method: 'POST',
        bucket: options.bucket,
        query: { 'delete': '' },
        headers: {
            'content-type': 'application/xml',
            // DeleteObjects is one of the few S3 calls that requires a
            // Content-MD5 of the body; without it S3 answers 400.
            'content-md5': require('crypto').createHash('md5').update(bodyBuffer).digest('base64')
        },
        body: bodyBuffer,
        region: options.region,
        credentials: credentials,
        action: 'DeleteObject',
        profileName: options.profileName
    }, function (err, response) {
        if (err) {
            return cb(err);
        }
        parseXml(response.body, function (parseErr, parsed) {
            if (parseErr) {
                return cb(parseErr);
            }
            let result = (parsed && parsed.DeleteResult) || {};
            cb(null, {
                deleted: asArray(result.Deleted).map(function (entry) {
                    return entry.Key;
                }),
                errors: asArray(result.Error).map(function (entry) {
                    return { key: entry.Key, code: entry.Code, message: entry.Message };
                }),
                region: response.region
            });
        });
    });
}

/**
 * Presigned GET URL for an object, with optional response header overrides.
 *
 * @param {object} options
 *   bucket, key, region, expiresInSeconds
 *   responseContentType         sets `response-content-type` — the fix for
 *                               objects stored as application/octet-stream
 *   responseContentDisposition  'inline' to render in the tab, or
 *                               'attachment; filename="..."' to download
 */
function presignGetUrl(credentials, options) {
    let region = cachedBucketRegion(options.bucket) || s3Endpoint.normalizeRegion(options.region);
    let endpoint = s3Endpoint.bucketEndpoint(options.bucket, options.key, region);
    let query = {};
    if (options.responseContentType) {
        query['response-content-type'] = options.responseContentType;
    }
    if (options.responseContentDisposition) {
        query['response-content-disposition'] = options.responseContentDisposition;
    }
    if (options.versionId) {
        query.versionId = options.versionId;
    }
    return s3Sign.presignUrl({
        method: 'GET',
        host: endpoint.host,
        path: endpoint.path,
        query: query,
        region: region,
        credentials: credentials,
        expiresInSeconds: options.expiresInSeconds || 3600,
        now: new Date()
    });
}

module.exports = {
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    cachedBucketRegion: cachedBucketRegion,
    rememberBucketRegion: rememberBucketRegion,
    listBuckets: listBuckets,
    bucketsFromListResult: bucketsFromListResult,
    getBucketRegion: getBucketRegion,
    listObjects: listObjects,
    headObject: headObject,
    getObject: getObject,
    getObjectStream: getObjectStream,
    putObject: putObject,
    copyObject: copyObject,
    deleteObjects: deleteObjects,
    presignGetUrl: presignGetUrl,
    s3Error: s3Error
};
