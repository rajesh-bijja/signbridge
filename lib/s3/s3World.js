"use strict";

/**
 * s3World.js — the Express layer for S3 World.
 *
 * S3 World is a browser for S3 that can actually *show* you what is in an
 * object. The console and every open-source S3 explorer stop at listing,
 * uploading and downloading; the moment you want to read a parquet file, a
 * gzipped log, a spreadsheet or a 4 GB NDJSON dump, you are downloading it to
 * your laptop and switching applications. This module closes that gap.
 *
 * Four things here are worth understanding before changing anything.
 *
 * 1. VIEWING TAKES TWO ROUTES, AND THE CHOICE IS A SECURITY DECISION.
 *    An S3 object is attacker-controlled bytes. HTML or SVG served inline from
 *    *our* origin would run with full access to SignBridge's DOM and storage —
 *    a UI that holds AWS credentials. So:
 *      - Natively-renderable, non-scriptable content (images, PDF, video,
 *        audio, plain text) opens as a presigned URL on the S3 origin. That is a
 *        different origin, holds no ambient credentials, and — because it is a
 *        top-level navigation — needs no bucket CORS configuration.
 *      - Everything else is decoded here and returned as JSON for an in-app
 *        viewer, so no untrusted bytes are ever executed anywhere.
 *      - The `s3Object` proxy exists for in-app <img>/<video> sources and
 *        downloads. It refuses to serve anything scriptable inline, and sends
 *        `nosniff` + a locked-down CSP on every response.
 *    `s3ContentTypes.isInlineSafe()` is the allowlist. Extend it with care.
 *
 * 2. WE PARSE ON THE SERVER, NOT IN THE BROWSER.
 *    Reading object bytes from client-side JavaScript is a cross-origin fetch,
 *    which requires a CORS policy on the bucket — and S3 World is aimed at
 *    buckets the user may not own. Doing the reads here means it works on any
 *    bucket the credentials can read, with no configuration.
 *
 * 3. PREVIEWS ARE RANGED, NOT WHOLE-OBJECT.
 *    Streaming formats (logs, source, CSV, NDJSON) are previewed from the first
 *    slice of the object (`PREVIEW_HEAD_BYTES`); single documents (JSON, XML,
 *    YAML) are read whole while affordable, because a prefix of one is not a
 *    document — see planPreviewRead(). Parquet goes further: hyparquet reads
 *    through an AsyncBuffer, so `s3AsyncBuffer()` below turns range GETs into
 *    the handful of reads needed for the footer and the first row group. A
 *    multi-gigabyte parquet previews in a few KB of traffic.
 *
 * 4. SEARCH IS RECURSIVE AND CANCELLABLE.
 *    The console's search filters one level, by prefix, case-sensitively. Ours
 *    walks the whole subtree (ListObjectsV2 with no delimiter) and matches with
 *    the s3Search language, reporting progress over Socket.IO so a search across
 *    a million keys is watchable and stoppable. See s3Search.js for the why.
 */

const s3Client = require('./s3Client');
const s3Endpoint = require('./s3Endpoint');
const s3Search = require('./s3Search');
const s3ContentTypes = require('./s3ContentTypes');
const s3Preview = require('./s3Preview');
const credentialProvider = require('../credentialProvider');
const coreUtils = require('../coreUtils');
const authConfig = require('../authConfig');

// How much of an object to read for a text/structured preview. Big enough that a
// CSV shows hundreds of rows and a log shows the interesting part; small enough
// that opening a 40 GB object is instant.
const PREVIEW_HEAD_BYTES = 512 * 1024;

// A whole-object read is only allowed below this, for formats that cannot be
// previewed from a prefix of the bytes (zip needs its trailing central
// directory; gzip cannot be inflated from a truncated stream; OOXML is a zip).
const WHOLE_OBJECT_LIMIT = 32 * 1024 * 1024;

// Formats that are one *document* rather than a stream of records, mapped to the
// largest object we will read in full for them. See planPreviewRead().
const DOCUMENT_BUDGETS = {};
DOCUMENT_BUDGETS[s3ContentTypes.VIEWERS.JSON] = s3Preview.LIMITS.MAX_JSON_BYTES;
DOCUMENT_BUDGETS[s3ContentTypes.VIEWERS.XML] = s3Preview.LIMITS.MAX_TEXT_CHARS;
DOCUMENT_BUDGETS[s3ContentTypes.VIEWERS.YAML] = s3Preview.LIMITS.MAX_TEXT_CHARS;

// Single-PutObject upload cap. S3 allows 5 GB in one PUT, but buffering that in
// Node is not acceptable; larger uploads need multipart, which is not built yet.
const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

// S3 caps DeleteObjects at 1000 keys per call.
const DELETE_BATCH_SIZE = 1000;

// Search guard rails. A recursive walk of a huge bucket must terminate.
const SEARCH_DEFAULTS = {
    maxKeysScanned: 200000,
    maxMatches: 1000,
    pageSize: 1000,
    progressEveryKeys: 5000,
    // Distinct folders a search will report. A folder list is a navigation aid,
    // so hundreds of them is already past the point of being useful.
    maxFolderMatches: 500
};

// In-flight searches, so the UI's Stop button can actually stop one.
// searchId -> { cancelled: boolean }
const activeSearches = new Map();

function badRequest(res, message) {
    return res.status(400).json({ message: message });
}

function fail(res, err, fallbackStatus) {
    let status = err && err.statusCode ? err.statusCode : (fallbackStatus || 400);
    return res.status(status).json({
        message: err && err.message ? err.message : 'S3 World: the request failed.',
        code: (err && err.code) || null,
        ssoSessionExpired: !!(err && err.ssoSessionExpired),
        verificationUriComplete: (err && err.verificationUriComplete) || null
    });
}

function emit(userName, payload) {
    try {
        coreUtils.emitToUser(userName, 'event_s3_world_' + userName, payload);
    } catch (e) {
        // Streaming is best-effort; the HTTP response is authoritative.
    }
}

/**
 * The request body carries `options` for POST routes; GET routes (the proxy) use
 * the query string. Either way the user comes from authConfig, never the client.
 */
function readOptions(req) {
    let source = (req.body && req.body.options) || req.query || {};
    return source;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Resolve SigV4 credentials for a profile.
 *
 * Delegates to lib/credentialProvider.js, which is the single place that knows
 * how each AWS profile type produces credentials: IAM long-lived keys, SSO role
 * credentials, EC2 instance-profile credentials fetched over SSH from IMDS, or
 * IRSA credentials from a Kubernetes service-account token. All but the first
 * carry a session token and an expiry, which the viewer uses to cap presigned
 * link lifetimes.
 *
 * Non-AWS profiles (Basic/Bearer/generic) have no S3 identity; the provider
 * rejects them with a message naming the mechanisms that would work, rather than
 * letting a confusing signing failure surface later.
 */
function resolveCredentials(userName, profileName, authnMode, cb) {
    if (!profileName) {
        let err = new Error('S3 World: choose an AWS profile first.');
        err.statusCode = 400;
        return cb(err);
    }
    credentialProvider.resolveByProfileName(userName, profileName, authnMode, function (err, resolved) {
        if (err) {
            err.statusCode = err.statusCode || 401;
            err.message = 'S3 World: ' + err.message;
            return cb(err);
        }
        return cb(null, {
            credentials: resolved.credentials,
            region: resolved.region || s3Endpoint.DEFAULT_REGION,
            profile: resolved.profile,
            // A SigV4 request dies with its session token no matter what
            // X-Amz-Expires says, so the viewer caps presigned-URL lifetimes to
            // this. null for IAM user keys, which do not expire.
            expiresAtMs: resolved.expiresAtMs
        });
    });
}

/** Resolve credentials, then the bucket's real region, then hand both back. */
function withBucket(userName, options, cb) {
    resolveCredentials(userName, options.profileName, options.authnMode, function (err, resolved) {
        if (err) {
            return cb(err);
        }
        if (!options.bucket) {
            let missing = new Error('S3 World: a bucket name is required.');
            missing.statusCode = 400;
            return cb(missing);
        }
        // Signing is region-scoped, so the bucket's region has to be known before
        // the first signature. s3Client caches it (buckets never move) and also
        // self-corrects from x-amz-bucket-region on a mismatch.
        let cached = s3Client.cachedBucketRegion(options.bucket);
        if (cached) {
            resolved.bucketRegion = cached;
            return cb(null, resolved);
        }
        s3Client.getBucketRegion(resolved.credentials, options.bucket, resolved.region,
            function (regionErr, region) {
                if (regionErr) {
                    // GetBucketLocation can be denied by policy while GetObject is
                    // allowed. Fall back to the profile region and let the
                    // request's own redirect-learning fix it.
                    resolved.bucketRegion = resolved.region;
                    return cb(null, resolved);
                }
                resolved.bucketRegion = region;
                cb(null, resolved);
            });
    });
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/**
 * List every bucket the credentials can see.
 *
 * ListBuckets has no server-side pagination or filtering — it returns the whole
 * account in one response — so paging and searching happen on the client, where
 * they are instant. That is also why the search box here can be forgiving:
 * there is no API round trip to make it expensive.
 */
function listBuckets(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    resolveCredentials(userName, options.profileName, options.authnMode, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.listBuckets(resolved.credentials, resolved.region, function (listErr, result) {
            if (listErr) {
                return fail(res, listErr);
            }
            res.status(200).json({
                buckets: result.buckets,
                owner: result.owner || null,
                profileName: options.profileName,
                region: resolved.region
            });
        });
    });
}

/**
 * The region for one bucket. Exposed on its own because the UI shows it in the
 * bucket list and it is worth resolving lazily rather than for every bucket in
 * an account of 500.
 */
function getBucketRegion(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    resolveCredentials(userName, options.profileName, options.authnMode, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.getBucketRegion(resolved.credentials, options.bucket, resolved.region,
            function (regionErr, region) {
                if (regionErr) {
                    return fail(res, regionErr);
                }
                res.status(200).json({ bucket: options.bucket, region: region });
            });
    });
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

/**
 * One page of a folder: sub-folders (CommonPrefixes) and objects.
 *
 * `delimiter` defaults to '/', which is what produces the folder illusion over
 * S3's flat keyspace. Passing an empty delimiter flattens the whole subtree —
 * the UI offers that as a "show all objects recursively" toggle.
 */
function listObjects(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        let delimiter = options.delimiter === undefined ? '/' : options.delimiter;
        s3Client.listObjects(resolved.credentials, {
            bucket: options.bucket,
            prefix: options.prefix || '',
            delimiter: delimiter || undefined,
            maxKeys: Math.min(parseInt(options.maxKeys, 10) || 1000, 1000),
            continuationToken: options.continuationToken || null,
            region: resolved.bucketRegion,
            profileName: options.profileName
        }, function (listErr, result) {
            if (listErr) {
                return fail(res, listErr);
            }
            // Decorate each object with what it is, so the list can show a type
            // icon and a "View" affordance without a second round trip. This is
            // extension-only resolution — no bytes are read to build a listing.
            let objects = result.objects.map(function (entry) {
                let type = s3ContentTypes.resolveObjectType({
                    key: entry.key,
                    contentType: null,
                    size: entry.size
                });
                return Object.assign({}, entry, {
                    contentType: type.contentType,
                    viewer: type.viewer,
                    // A hint, not a verdict: everything is viewable (a format we
                    // don't know still gets a hex dump), and an extension-less or
                    // oddly-named object may well resolve to a rich viewer once
                    // the preview reads its magic bytes.
                    hasRichViewer: type.viewer !== s3ContentTypes.VIEWERS.BINARY,
                    // GLACIER / DEEP_ARCHIVE objects cannot be read until
                    // restored; saying so up front avoids a confusing failure.
                    archived: entry.storageClass === 'GLACIER' ||
                        entry.storageClass === 'DEEP_ARCHIVE'
                });
            });
            res.status(200).json(Object.assign({}, result, { objects: objects }));
        });
    });
}

/**
 * Full metadata for one object, plus the resolved type and the recommended way
 * to view it. One round trip, because the UI needs all of it to open a viewer.
 *
 * The type resolution reads a small head of the object when the stored
 * Content-Type is generic (which, on S3, it very often is — anything uploaded by
 * the CLI without `--content-type` is application/octet-stream). Magic bytes and
 * the extension then decide, so a `.parquet` stored as octet-stream still opens
 * as a table.
 */
function headObject(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.headObject(resolved.credentials, {
            bucket: options.bucket,
            key: options.key,
            versionId: options.versionId || null,
            region: resolved.bucketRegion,
            profileName: options.profileName
        }, function (headErr, head) {
            if (headErr) {
                return fail(res, headErr);
            }

            function respond(headBytes) {
                let type = s3ContentTypes.resolveObjectType({
                    key: options.key,
                    contentType: head.contentType,
                    head: headBytes,
                    size: head.size
                });
                let endpoint = s3Endpoint.bucketEndpoint(options.bucket, options.key,
                    resolved.bucketRegion);
                res.status(200).json({
                    object: head,
                    type: type,
                    // Path-style is only used for bucket names S3's wildcard TLS
                    // cert cannot cover. It also collapses every bucket in the
                    // region into one origin, so the viewer must not render
                    // scriptable content from it — the UI shows this.
                    endpointStyle: endpoint.style,
                    recommendedView: recommendView(type, head, endpoint.style)
                });
            }

            if (head.size === 0) {
                return respond(Buffer.alloc(0));
            }
            if (!s3ContentTypes.isGenericContentType(head.contentType) &&
                s3ContentTypes.extensionOf(options.key)) {
                // Both the stored type and the extension are informative; no
                // need to spend a range GET on sniffing.
                return respond(null);
            }
            // Sniff: 4 KB is enough for every signature we know.
            s3Client.getObject(resolved.credentials, {
                bucket: options.bucket,
                key: options.key,
                versionId: options.versionId || null,
                range: 'bytes=0-4095',
                region: resolved.bucketRegion,
                profileName: options.profileName
            }, function (getErr, result) {
                respond(getErr ? null : result.body);
            });
        });
    });
}

/**
 * How should this object be opened? Three answers:
 *
 *   'tab'     — presigned URL on the S3 origin, opened in a new tab. The browser
 *               renders it natively and nothing untrusted touches our origin.
 *   'preview' — decoded here, rendered by an in-app viewer.
 *   'download'— we cannot show it; be honest and offer the file.
 */
function recommendView(type, head, endpointStyle) {
    let viewers = s3ContentTypes.VIEWERS;

    if (head && (head.storageClass === 'GLACIER' || head.storageClass === 'DEEP_ARCHIVE') &&
        !head.restore) {
        return {
            mode: 'download',
            reason: 'This object is in ' + head.storageClass +
                ' and must be restored before it can be read.'
        };
    }

    // Scriptable content never opens as a navigation from our origin, and only
    // opens from the S3 origin when that origin is bucket-specific.
    if (type.scriptable) {
        return {
            mode: 'preview',
            reason: endpointStyle === 'path'
                ? 'This file can contain scripts, and this bucket must use a shared S3 endpoint, so it is shown as inert text.'
                : 'This file can contain scripts, so it is shown in an isolated frame rather than opened directly.'
        };
    }

    if (type.viewer === viewers.IMAGE || type.viewer === viewers.PDF ||
        type.viewer === viewers.VIDEO || type.viewer === viewers.AUDIO) {
        return { mode: 'tab', reason: 'The browser renders this natively.' };
    }

    if (type.viewer === viewers.BINARY) {
        return {
            mode: 'preview',
            reason: type.note || 'No viewer for this format — showing a hex dump.'
        };
    }

    return { mode: 'preview', reason: null };
}

// ---------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------

/**
 * A presigned URL for viewing or downloading an object.
 *
 * The two signed overrides are the whole trick:
 *   response-content-type        replaces a wrong or missing stored Content-Type,
 *                                which is why an octet-stream PNG renders instead
 *                                of downloading.
 *   response-content-disposition 'inline' to render in the tab, 'attachment' to
 *                                save.
 * Both are inside the signature, so the URL holder cannot change them — and they
 * cannot be bolted onto an already-signed URL (that yields SignatureDoesNotMatch).
 *
 * Inline is granted only for the narrow allowlist in isInlineSafe(); everything
 * else is forced to attachment even if the caller asked for inline.
 */
function presignView(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.headObject(resolved.credentials, {
            bucket: options.bucket,
            key: options.key,
            versionId: options.versionId || null,
            region: resolved.bucketRegion,
            profileName: options.profileName
        }, function (headErr, head) {
            if (headErr) {
                return fail(res, headErr);
            }
            let type = s3ContentTypes.resolveObjectType({
                key: options.key,
                contentType: head.contentType,
                size: head.size
            });

            let wantsInline = options.disposition !== 'attachment';
            let inline = wantsInline && s3ContentTypes.isInlineSafe(type.contentType);
            let disposition = s3ContentTypes.contentDisposition(options.key,
                inline ? 'inline' : 'attachment');

            let expiresInSeconds = clampExpiry(options.expiresInSeconds, resolved.expiresAtMs);

            let url = s3Client.presignGetUrl(resolved.credentials, {
                bucket: options.bucket,
                key: options.key,
                versionId: options.versionId || null,
                region: resolved.bucketRegion,
                expiresInSeconds: expiresInSeconds,
                responseContentType: type.contentType,
                responseContentDisposition: disposition
            });

            res.status(200).json({
                url: url,
                contentType: type.contentType,
                storedContentType: head.contentType,
                disposition: inline ? 'inline' : 'attachment',
                inline: inline,
                expiresInSeconds: expiresInSeconds,
                size: head.size,
                note: !inline && wantsInline
                    ? 'This content type is not safe to render directly, so the link downloads instead.'
                    : null
            });
        });
    });
}

/**
 * Clamp a requested URL lifetime to something sane, and — for SSO — to the life
 * of the session token, because a SigV4 request is valid only until the earlier
 * of X-Amz-Expires and the token's own expiry. Handing back a "12 hour" URL
 * signed with a session that dies in 4 minutes is worse than useless.
 *
 * `nowMs` is injectable so the clamp stays testable without a fake clock.
 */
function clampExpiry(requested, credentialExpiryMs, nowMs) {
    let now = nowMs == null ? Date.now() : nowMs;
    let seconds = parseInt(requested, 10);
    if (!seconds || isNaN(seconds)) {
        seconds = 3600;
    }
    seconds = Math.max(60, Math.min(seconds, 43200));
    if (credentialExpiryMs) {
        let remaining = Math.floor((credentialExpiryMs - now) / 1000);
        if (remaining > 0 && remaining < seconds) {
            seconds = Math.max(60, remaining);
        }
    }
    return seconds;
}

/**
 * Stream object bytes through this server.
 *
 * A GET route, because it is used as an <img>/<video>/<iframe> source and as a
 * download target — contexts that cannot POST or set headers.
 *
 * This is the one place untrusted bytes are served from SignBridge's own origin,
 * so it is deliberately strict:
 *   - inline only for the isInlineSafe() allowlist; anything else, including
 *     everything scriptable, becomes an attachment
 *   - `X-Content-Type-Options: nosniff` so the declared type is authoritative
 *     and a polyglot file cannot be re-interpreted as HTML
 *   - a CSP that permits nothing to load and forbids framing
 */
function proxyObject(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    if (!options.bucket || !options.key) {
        return badRequest(res, 'S3 World: bucket and key are required.');
    }

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.headObject(resolved.credentials, {
            bucket: options.bucket,
            key: options.key,
            versionId: options.versionId || null,
            region: resolved.bucketRegion,
            profileName: options.profileName
        }, function (headErr, head) {
            if (headErr) {
                return fail(res, headErr);
            }
            let type = s3ContentTypes.resolveObjectType({
                key: options.key,
                contentType: head.contentType,
                size: head.size
            });
            let wantsInline = options.disposition === 'inline';
            let inline = wantsInline && s3ContentTypes.isInlineSafe(type.contentType);

            s3Client.getObjectStream(resolved.credentials, {
                bucket: options.bucket,
                key: options.key,
                versionId: options.versionId || null,
                // A browser can pass through a Range for video seeking.
                range: req.headers.range || null,
                region: resolved.bucketRegion,
                profileName: options.profileName
            }, function (streamErr, upstream) {
                if (streamErr) {
                    return fail(res, streamErr);
                }

                res.setHeader('Content-Type', inline
                    ? type.contentType
                    : 'application/octet-stream');
                res.setHeader('Content-Disposition',
                    s3ContentTypes.contentDisposition(options.key, inline ? 'inline' : 'attachment'));
                // Declared type is authoritative; no sniffing, no re-interpretation.
                res.setHeader('X-Content-Type-Options', 'nosniff');
                // Nothing this content references may load, and it may not be framed.
                res.setHeader('Content-Security-Policy',
                    "default-src 'none'; sandbox; frame-ancestors 'none'");
                res.setHeader('Cache-Control', 'private, no-store');

                let upstreamHeaders = upstream.headers || {};
                ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']
                    .forEach(function (name) {
                        if (upstreamHeaders[name]) {
                            res.setHeader(name, upstreamHeaders[name]);
                        }
                    });
                res.status(upstream.statusCode === 206 ? 206 : 200);

                upstream.stream.on('error', function () {
                    // Headers are already sent, so the only honest signal left is
                    // to break the connection.
                    res.destroy();
                });
                upstream.stream.pipe(res);
            });
        });
    });
}

/**
 * How much of an object to read before decoding it — pure, because this one
 * decision is what determines whether a preview is a viewer or an apology.
 *
 * Three kinds of format:
 *   - **Streams** (logs, source, CSV, NDJSON): a prefix is a valid sample, so
 *     read only `PREVIEW_HEAD_BYTES` and a 40 GB log opens instantly.
 *   - **Documents** (JSON, XML, YAML): the closing bytes are part of the syntax.
 *     A head read leaves JSON *unparseable* — which is why a 600 KB `.json` used
 *     to open as raw text saying "the JSON is incomplete", with no tree at all —
 *     and leaves XML/YAML ending mid-element. So read those whole while it is
 *     affordable. The ceiling is the decoder's own budget (`DOCUMENT_BUDGETS`)
 *     rather than `WHOLE_OBJECT_LIMIT`: past it the preview degrades to raw text
 *     anyway, and transferring 30 MB to say so is waste.
 *   - **Containers** (zip, gzip, OOXML, notebooks): not readable from a prefix at
 *     all (a zip's directory is at the end; a truncated gzip will not inflate),
 *     so they need every byte and are refused above `WHOLE_OBJECT_LIMIT`.
 *
 * @returns {{ range: string|null, wholeObject: boolean, tooLarge: boolean }}
 */
function planPreviewRead(type, head) {
    let viewer = type ? type.viewer : null;
    let size = (head && head.size) || 0;

    let needsWholeObject = viewer === s3ContentTypes.VIEWERS.ARCHIVE ||
        viewer === s3ContentTypes.VIEWERS.OFFICE ||
        viewer === s3ContentTypes.VIEWERS.NOTEBOOK ||
        (head && head.contentEncoding === 'gzip');
    if (needsWholeObject) {
        return { range: null, wholeObject: true, tooLarge: size > WHOLE_OBJECT_LIMIT };
    }

    // Byte size against a character budget is an approximation, and deliberately
    // the conservative one: multi-byte text only ever decodes to fewer chars.
    let budget = DOCUMENT_BUDGETS[viewer];
    if (budget != null && size <= budget) {
        return { range: null, wholeObject: true, tooLarge: false };
    }

    if (size > PREVIEW_HEAD_BYTES) {
        return {
            range: 'bytes=0-' + (PREVIEW_HEAD_BYTES - 1),
            wholeObject: false,
            tooLarge: false
        };
    }
    return { range: null, wholeObject: false, tooLarge: false };
}

/**
 * Decode an object into something an in-app viewer can render: a table, JSON, a
 * text buffer, an archive listing, a notebook, or a hex dump.
 *
 * The read strategy comes from planPreviewRead() above, except for parquet, which
 * reads through ranged requests driven by hyparquet — it fetches the footer and
 * only the column chunks it needs, so a multi-gigabyte file previews in a few KB.
 */
function previewObject(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.headObject(resolved.credentials, {
            bucket: options.bucket,
            key: options.key,
            versionId: options.versionId || null,
            region: resolved.bucketRegion,
            profileName: options.profileName
        }, function (headErr, head) {
            if (headErr) {
                return fail(res, headErr);
            }

            if ((head.storageClass === 'GLACIER' || head.storageClass === 'DEEP_ARCHIVE') &&
                !head.restore) {
                return res.status(409).json({
                    message: 'This object is in ' + head.storageClass +
                        ' storage and cannot be read until it is restored.'
                });
            }
            if (head.size === 0) {
                return res.status(200).json({
                    object: head,
                    type: s3ContentTypes.resolveObjectType({ key: options.key, size: 0 }),
                    preview: { kind: 'text', format: 'plaintext', text: '', truncated: false },
                    note: 'This object is empty (0 bytes).'
                });
            }

            // Resolve the type from a small head first, so the read strategy is
            // chosen from what the file actually is, not what it claims.
            s3Client.getObject(resolved.credentials, {
                bucket: options.bucket,
                key: options.key,
                versionId: options.versionId || null,
                range: 'bytes=0-4095',
                region: resolved.bucketRegion,
                profileName: options.profileName
            }, function (sniffErr, sniffed) {
                let type = s3ContentTypes.resolveObjectType({
                    key: options.key,
                    contentType: head.contentType,
                    head: sniffErr ? null : sniffed.body,
                    size: head.size
                });

                function done(preview) {
                    res.status(200).json({
                        object: head,
                        type: type,
                        preview: preview
                    });
                }

                // --- parquet: ranged reads, no download ------------------------
                if (type.viewer === s3ContentTypes.VIEWERS.PARQUET) {
                    let buffer = s3AsyncBuffer(resolved, options, head.size);
                    return s3Preview.previewParquet(buffer, {
                        maxRows: parseInt(options.maxRows, 10) || undefined
                    }).then(function (preview) {
                        done(Object.assign(preview, { bytesRead: buffer.bytesRead }));
                    }).catch(function (parquetErr) {
                        done({
                            kind: 'error',
                            format: 'parquet',
                            message: 'Could not read this parquet file: ' + parquetErr.message
                        });
                    });
                }

                // --- how much of it to read -----------------------------------
                let plan = planPreviewRead(type, head);

                if (plan.tooLarge) {
                    return done({
                        kind: 'error',
                        format: type.extension || 'binary',
                        message: 'This format has to be read in full, and the object is ' +
                            s3Preview.formatBytes(head.size) + ' — over the ' +
                            s3Preview.formatBytes(WHOLE_OBJECT_LIMIT) +
                            ' preview limit. Download it to open it.'
                    });
                }

                s3Client.getObject(resolved.credentials, {
                    bucket: options.bucket,
                    key: options.key,
                    versionId: options.versionId || null,
                    range: plan.range,
                    region: resolved.bucketRegion,
                    profileName: options.profileName
                }, function (getErr, result) {
                    if (getErr) {
                        return fail(res, getErr);
                    }
                    let preview;
                    try {
                        preview = s3Preview.previewBuffer(result.body, {
                            key: options.key,
                            resolvedType: type,
                            sourceTruncated: !!plan.range,
                            totalSize: head.size
                        });
                    } catch (previewErr) {
                        preview = {
                            kind: 'error',
                            format: type.extension || 'binary',
                            message: 'Could not decode this object: ' + previewErr.message
                        };
                    }
                    done(Object.assign(preview, { bytesRead: result.body.length }));
                });
            });
        });
    });
}

/**
 * An AsyncBuffer over an S3 object: `{ byteLength, slice(start, end) }`, the
 * interface hyparquet reads through. Each slice becomes a ranged GET, so reading
 * a parquet footer and one row group costs a couple of small requests instead of
 * downloading the file. `bytesRead` is tracked so the UI can show how little it
 * actually transferred — the most convincing thing about this feature.
 */
function s3AsyncBuffer(resolved, options, size) {
    let buffer = {
        byteLength: size,
        bytesRead: 0,
        slice: function (start, end) {
            let from = start == null ? 0 : Math.max(0, start);
            // hyparquet passes an exclusive end, or undefined for "to the end".
            let to = end == null ? size : Math.min(end, size);
            if (to <= from) {
                return Promise.resolve(new ArrayBuffer(0));
            }
            return new Promise(function (resolve, reject) {
                s3Client.getObject(resolved.credentials, {
                    bucket: options.bucket,
                    key: options.key,
                    versionId: options.versionId || null,
                    // HTTP ranges are inclusive at both ends.
                    range: 'bytes=' + from + '-' + (to - 1),
                    region: resolved.bucketRegion,
                    profileName: options.profileName
                }, function (err, result) {
                    if (err) {
                        return reject(err);
                    }
                    buffer.bytesRead += result.body.length;
                    let body = result.body;
                    resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
                });
            });
        }
    };
    return buffer;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Recursive, forgiving search across a prefix.
 *
 * ListObjectsV2 without a delimiter returns every key under the prefix, page by
 * page, which is the only way S3 offers to see a subtree. Matching happens here
 * with the s3Search language — substring, case-insensitive, anywhere in the key
 * by default (see s3Search.js for why the console's prefix-only filter is not
 * good enough).
 *
 * Progress is emitted over Socket.IO as pages come back, so a search across
 * hundreds of thousands of keys shows results as it finds them and can be
 * stopped. The HTTP response carries the final, authoritative result.
 *
 * `scope` ('name' | 'folder' | 'both') decides what the query is tested against.
 * Whenever folders are in scope the walk also reports the distinct folders that
 * matched, with a count and total size — because the answer to "where is the
 * invoices folder?" is a folder to click, not the ten thousand objects inside it.
 * S3 has no directory listing, so those folders are derived from the keys that
 * stream past anyway: each key's ancestor paths are tested once and remembered.
 */
function searchObjects(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    let searchId = String(options.searchId || ('search-' + Date.now()));
    let query = String(options.query || '');

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }

        let basePrefix = options.prefix || '';
        let scope = s3Search.normalizeScope(options.scope);
        let search = s3Search.buildSearch(query, {
            scope: scope,
            caseSensitive: !!options.caseSensitive
        });

        let limits = {
            maxKeysScanned: Math.min(parseInt(options.maxKeysScanned, 10) ||
                SEARCH_DEFAULTS.maxKeysScanned, 1000000),
            maxMatches: Math.min(parseInt(options.maxMatches, 10) ||
                SEARCH_DEFAULTS.maxMatches, 10000)
        };

        let state = { cancelled: false };
        activeSearches.set(searchId, state);

        let matches = [];
        let scanned = 0;
        let lastProgressAt = 0;
        let startedAt = Date.now();

        // Folder accounting. `judged` holds every distinct relative folder path
        // seen so far mapped to whether it matched, so each path is tested once
        // however many objects live under it; `folders` accumulates the hits.
        let judged = new Map();
        let folders = new Map();
        let folderLimitHit = false;

        /**
         * Test every ancestor folder of a matched-or-not key, once each, and
         * account the object against those that matched. Walking ancestors (not
         * just the immediate parent) is what makes a hit on `logs` report the
         * `logs` folder rather than the hundred date folders beneath it.
         */
        function accountFolders(relativeKey, size, isMarker) {
            let cut = relativeKey.lastIndexOf('/');
            if (cut === -1) {
                return; // an object at the search root has no folder
            }
            let segments = relativeKey.slice(0, cut).split('/');
            let path = '';
            for (let i = 0; i < segments.length; i++) {
                path = path ? path + '/' + segments[i] : segments[i];
                let matched = judged.get(path);
                if (matched === undefined) {
                    matched = search.matchesFolder({ relativePath: path });
                    judged.set(path, matched);
                }
                if (!matched) {
                    continue;
                }
                let record = folders.get(path);
                if (!record) {
                    if (folders.size >= SEARCH_DEFAULTS.maxFolderMatches) {
                        folderLimitHit = true;
                        continue;
                    }
                    record = {
                        prefix: basePrefix + path + '/',
                        relativePath: path,
                        name: segments[i],
                        objectCount: 0,
                        size: 0
                    };
                    folders.set(path, record);
                }
                // A folder marker is not an object, so it must not be counted as
                // one — but it is the only trace an empty folder leaves, and
                // finding those is something the console cannot do at all.
                if (!isMarker) {
                    record.objectCount++;
                    record.size += size || 0;
                }
            }
        }

        emit(userName, {
            type: 'search_start',
            searchId: searchId,
            bucket: options.bucket,
            prefix: basePrefix,
            scope: scope,
            description: search.description
        });

        function finish(stopReason, error) {
            activeSearches.delete(searchId);
            // Shallowest first, then alphabetical: the folder a person is looking
            // for is nearly always the outermost one that matched.
            let folderList = Array.from(folders.values()).sort(function (a, b) {
                let depth = a.relativePath.split('/').length - b.relativePath.split('/').length;
                return depth !== 0 ? depth : a.relativePath.localeCompare(b.relativePath);
            });
            let payload = {
                searchId: searchId,
                bucket: options.bucket,
                prefix: basePrefix,
                query: query,
                scope: scope,
                description: search.description,
                matches: matches,
                matchCount: matches.length,
                folders: folderList,
                folderCount: folderList.length,
                folderLimitHit: folderLimitHit,
                scanned: scanned,
                stopReason: stopReason,
                elapsedMs: Date.now() - startedAt,
                filters: search.parsed.filters,
                terms: search.parsed.terms.map(function (term) {
                    return { kind: term.kind, value: term.value, negated: term.negated };
                })
            };
            emit(userName, Object.assign({ type: 'search_complete' }, payload));
            if (error) {
                return fail(res, error);
            }
            res.status(200).json(payload);
        }

        function page(continuationToken) {
            if (state.cancelled) {
                return finish('cancelled');
            }
            s3Client.listObjects(resolved.credentials, {
                bucket: options.bucket,
                prefix: basePrefix,
                // No delimiter: walk the entire subtree, which is the point.
                delimiter: undefined,
                maxKeys: SEARCH_DEFAULTS.pageSize,
                continuationToken: continuationToken,
                region: resolved.bucketRegion,
                profileName: options.profileName
            }, function (listErr, result) {
                if (listErr) {
                    return finish('error', listErr);
                }

                for (let i = 0; i < result.objects.length; i++) {
                    let entry = result.objects[i];
                    scanned++;
                    let relativeKey = entry.key.slice(basePrefix.length);
                    let isMarker = entry.key.charAt(entry.key.length - 1) === '/' &&
                        entry.size === 0;
                    // Folder accounting is independent of whether the object
                    // itself matches: in 'folder' scope the query is about the
                    // path, and an ancestor can match when no leaf name does.
                    if (search.matchesFolder) {
                        accountFolders(relativeKey, entry.size, isMarker);
                    }
                    // Folder markers are not results.
                    if (isMarker) {
                        continue;
                    }
                    // `relativeKey` is what the user sees and what they mean when
                    // they type a fragment, so it is what globs are tested against.
                    let candidate = {
                        key: entry.key,
                        relativeKey: relativeKey,
                        name: entry.key.split('/').pop(),
                        size: entry.size,
                        lastModified: entry.lastModified,
                        storageClass: entry.storageClass,
                        etag: entry.etag
                    };
                    if (!search.matches(candidate)) {
                        continue;
                    }
                    let type = s3ContentTypes.resolveObjectType({
                        key: entry.key,
                        size: entry.size
                    });
                    matches.push(Object.assign(candidate, {
                        contentType: type.contentType,
                        viewer: type.viewer,
                        // Same hint as in a listing — extension-only, so it can
                        // be wrong in the object's favour once bytes are read.
                        hasRichViewer: type.viewer !== s3ContentTypes.VIEWERS.BINARY,
                        // The folder the match lives in, so the UI can offer
                        // "reveal in place".
                        parentPrefix: entry.key.slice(0, entry.key.lastIndexOf('/') + 1)
                    }));
                    if (matches.length >= limits.maxMatches) {
                        return finish('match-limit');
                    }
                }

                if (scanned - lastProgressAt >= SEARCH_DEFAULTS.progressEveryKeys ||
                    !result.isTruncated) {
                    lastProgressAt = scanned;
                    emit(userName, {
                        type: 'search_progress',
                        searchId: searchId,
                        scanned: scanned,
                        matchCount: matches.length,
                        folderCount: folders.size,
                        // A trickle of matches keeps a long search legible.
                        recent: matches.slice(-25)
                    });
                }

                if (scanned >= limits.maxKeysScanned) {
                    return finish('scan-limit');
                }
                if (!result.isTruncated || !result.continuationToken) {
                    return finish('complete');
                }
                page(result.continuationToken);
            });
        }

        page(options.continuationToken || null);
    });
}

/** Stop an in-flight search. The walk checks this between pages. */
function cancelSearch(req, res) {
    let options = readOptions(req);
    let state = activeSearches.get(String(options.searchId));
    if (state) {
        state.cancelled = true;
        return res.status(200).json({ cancelled: true, searchId: options.searchId });
    }
    res.status(200).json({ cancelled: false, searchId: options.searchId || null });
}

/**
 * Explain a query without running it. Backs the live hint under the search box,
 * so the syntax is discoverable by typing rather than by reading documentation.
 */
function explainSearch(req, res) {
    let options = readOptions(req);
    let parsed = s3Search.parseQuery(String(options.query || ''), {
        caseSensitive: !!options.caseSensitive,
        // The hint has to describe the search that will actually run, so it takes
        // the same scope the search box is set to.
        scope: options.scope
    });
    res.status(200).json({
        description: s3Search.describeQuery(parsed),
        scope: parsed.scope,
        isEmpty: parsed.isEmpty,
        terms: parsed.terms.map(function (term) {
            return { kind: term.kind, value: term.value, negated: term.negated };
        }),
        filters: parsed.filters,
        notes: parsed.notes
    });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a folder — a zero-byte object whose key ends in '/', which is exactly
 * what the S3 console does. S3 has no directories, so this marker is the only
 * way an empty folder can exist at all.
 */
function createFolder(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    let folderName = String(options.folderName || '').trim();
    if (!folderName) {
        return badRequest(res, 'S3 World: a folder name is required.');
    }
    if (folderName.indexOf('..') !== -1) {
        return badRequest(res, 'S3 World: a folder name cannot contain "..".');
    }
    let key = (options.prefix || '') + folderName.replace(/^\/+|\/+$/g, '') + '/';

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.putObject(resolved.credentials, {
            bucket: options.bucket,
            key: key,
            body: Buffer.alloc(0),
            region: resolved.bucketRegion,
            profileName: options.profileName
        }, function (putErr, result) {
            if (putErr) {
                return fail(res, putErr);
            }
            res.status(201).json({ key: key, etag: result.etag });
        });
    });
}

/**
 * Upload one object.
 *
 * The bytes arrive as a raw request body (see the route registration), not
 * base64 in JSON, so a 50 MB file does not become a 67 MB string. Single
 * PutObject only: above UPLOAD_LIMIT_BYTES this refuses rather than buffering,
 * because multipart upload is not implemented yet.
 */
function uploadObject(req, res) {
    let userName = authConfig.resolveUserName(req);
    // A raw-body route cannot carry JSON, so the parameters come from the query.
    let options = req.query || {};

    if (!options.bucket || !options.key) {
        return badRequest(res, 'S3 World: bucket and key are required.');
    }
    let body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length > UPLOAD_LIMIT_BYTES) {
        return res.status(413).json({
            message: 'S3 World: uploads are limited to ' +
                s3Preview.formatBytes(UPLOAD_LIMIT_BYTES) + ' per file.'
        });
    }

    // Give the object a real Content-Type on the way in, so it can be viewed
    // later without needing an override. This is the fix for the octet-stream
    // problem applied at the source.
    let type = s3ContentTypes.resolveObjectType({
        key: options.key,
        contentType: options.contentType,
        head: body.slice(0, 4096),
        size: body.length
    });

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        s3Client.putObject(resolved.credentials, {
            bucket: options.bucket,
            key: options.key,
            body: body,
            contentType: type.contentType,
            region: resolved.bucketRegion,
            profileName: options.profileName
        }, function (putErr, result) {
            if (putErr) {
                return fail(res, putErr);
            }
            res.status(201).json({
                key: options.key,
                etag: result.etag,
                size: body.length,
                contentType: type.contentType
            });
        });
    });
}

/**
 * Delete objects, and optionally whole folders.
 *
 * Deleting a "folder" means deleting every key under its prefix, because the
 * folder itself is not a thing. That is expanded here rather than in the UI so
 * the count shown to the user in the confirmation is the real count.
 */
function deleteObjects(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    let keys = Array.isArray(options.keys) ? options.keys.slice() : [];
    let prefixes = Array.isArray(options.prefixes) ? options.prefixes.slice() : [];
    if (!keys.length && !prefixes.length) {
        return badRequest(res, 'S3 World: nothing was selected to delete.');
    }

    withBucket(userName, options, function (err, resolved) {
        if (err) {
            return fail(res, err);
        }

        // Expand every selected folder into its keys first.
        function expandPrefixes(index, done) {
            if (index >= prefixes.length) {
                return done(null);
            }
            let collected = [];
            function page(token) {
                s3Client.listObjects(resolved.credentials, {
                    bucket: options.bucket,
                    prefix: prefixes[index],
                    delimiter: undefined,
                    maxKeys: 1000,
                    continuationToken: token,
                    region: resolved.bucketRegion,
                    profileName: options.profileName
                }, function (listErr, result) {
                    if (listErr) {
                        return done(listErr);
                    }
                    result.objects.forEach(function (entry) {
                        collected.push(entry.key);
                    });
                    // listObjects filters out the key equal to the prefix (the
                    // folder marker), but deleting the folder must remove it too.
                    if (collected.indexOf(prefixes[index]) === -1) {
                        collected.push(prefixes[index]);
                    }
                    if (result.isTruncated && result.continuationToken) {
                        return page(result.continuationToken);
                    }
                    keys = keys.concat(collected);
                    expandPrefixes(index + 1, done);
                });
            }
            page(null);
        }

        expandPrefixes(0, function (expandErr) {
            if (expandErr) {
                return fail(res, expandErr);
            }
            // De-duplicate: a user can select both a folder and a file inside it.
            keys = keys.filter(function (key, index) {
                return keys.indexOf(key) === index;
            });

            let deleted = [];
            let errors = [];

            function batch(offset) {
                if (offset >= keys.length) {
                    return res.status(200).json({
                        deleted: deleted,
                        deletedCount: deleted.length,
                        errors: errors,
                        requested: keys.length
                    });
                }
                let chunk = keys.slice(offset, offset + DELETE_BATCH_SIZE);
                s3Client.deleteObjects(resolved.credentials, {
                    bucket: options.bucket,
                    keys: chunk,
                    region: resolved.bucketRegion,
                    profileName: options.profileName
                }, function (deleteErr, result) {
                    if (deleteErr) {
                        return fail(res, deleteErr);
                    }
                    deleted = deleted.concat(result.deleted);
                    errors = errors.concat(result.errors);
                    emit(userName, {
                        type: 'delete_progress',
                        bucket: options.bucket,
                        deleted: deleted.length,
                        total: keys.length
                    });
                    batch(offset + DELETE_BATCH_SIZE);
                });
            }
            batch(0);
        });
    });
}

/**
 * Copy or move objects. A move is a server-side copy followed by a delete —
 * S3 has no rename, and pretending otherwise would hide the fact that a failed
 * move can leave both copies in place (which is why the response reports the two
 * phases separately).
 */
function copyObjects(req, res) {
    let userName = authConfig.resolveUserName(req);
    let options = readOptions(req);

    let items = Array.isArray(options.items) ? options.items : [];
    if (!items.length) {
        return badRequest(res, 'S3 World: nothing was selected to copy.');
    }
    let isMove = !!options.move;
    let destinationPrefix = options.destinationPrefix || '';

    withBucket(userName, Object.assign({}, options, {
        bucket: options.destinationBucket || options.bucket
    }), function (err, resolved) {
        if (err) {
            return fail(res, err);
        }
        let destinationBucket = options.destinationBucket || options.bucket;
        let copied = [];
        let errors = [];

        function next(index) {
            if (index >= items.length) {
                if (!isMove || !copied.length) {
                    return res.status(200).json({
                        copied: copied,
                        errors: errors,
                        moved: false,
                        deleted: []
                    });
                }
                // Only delete what actually copied.
                return s3Client.deleteObjects(resolved.credentials, {
                    bucket: options.bucket,
                    keys: copied.map(function (entry) {
                        return entry.sourceKey;
                    }),
                    region: s3Client.cachedBucketRegion(options.bucket) || resolved.bucketRegion,
                    profileName: options.profileName
                }, function (deleteErr, result) {
                    if (deleteErr) {
                        return res.status(207).json({
                            copied: copied,
                            errors: errors,
                            moved: false,
                            deleted: [],
                            message: 'Objects were copied but the originals could not be ' +
                                'deleted, so both copies still exist: ' + deleteErr.message
                        });
                    }
                    res.status(200).json({
                        copied: copied,
                        errors: errors,
                        moved: true,
                        deleted: result.deleted
                    });
                });
            }

            let item = items[index];
            let sourceKey = item.key;
            let name = sourceKey.split('/').filter(Boolean).pop();
            let destinationKey = item.destinationKey || (destinationPrefix + name);

            if (destinationBucket === options.bucket && destinationKey === sourceKey) {
                errors.push({
                    key: sourceKey,
                    message: 'Source and destination are the same.'
                });
                return next(index + 1);
            }

            s3Client.copyObject(resolved.credentials, {
                sourceBucket: options.bucket,
                sourceKey: sourceKey,
                bucket: destinationBucket,
                key: destinationKey,
                region: resolved.bucketRegion,
                profileName: options.profileName
            }, function (copyErr) {
                if (copyErr) {
                    errors.push({ key: sourceKey, message: copyErr.message });
                } else {
                    copied.push({ sourceKey: sourceKey, key: destinationKey });
                }
                emit(userName, {
                    type: 'copy_progress',
                    done: index + 1,
                    total: items.length,
                    move: isMove
                });
                next(index + 1);
            });
        }
        next(0);
    });
}

module.exports = {
    PREVIEW_HEAD_BYTES: PREVIEW_HEAD_BYTES,
    WHOLE_OBJECT_LIMIT: WHOLE_OBJECT_LIMIT,
    UPLOAD_LIMIT_BYTES: UPLOAD_LIMIT_BYTES,
    SEARCH_DEFAULTS: SEARCH_DEFAULTS,
    listBuckets: listBuckets,
    getBucketRegion: getBucketRegion,
    listObjects: listObjects,
    headObject: headObject,
    presignView: presignView,
    proxyObject: proxyObject,
    previewObject: previewObject,
    searchObjects: searchObjects,
    cancelSearch: cancelSearch,
    explainSearch: explainSearch,
    createFolder: createFolder,
    uploadObject: uploadObject,
    deleteObjects: deleteObjects,
    copyObjects: copyObjects,
    // Exported for tests: the pure decisions worth pinning down.
    recommendView: recommendView,
    clampExpiry: clampExpiry,
    planPreviewRead: planPreviewRead,
    DOCUMENT_BUDGETS: DOCUMENT_BUDGETS,
    s3AsyncBuffer: s3AsyncBuffer
};
