"use strict";

// Tests for the three decisions in the S3 World request layer that are pure
// enough to pin down without a network: which viewing route an object takes, how
// long a presigned URL may live, and how a parquet AsyncBuffer turns hyparquet's
// exclusive-end slices into inclusive HTTP ranges.
//
// The route choice is a security decision, not a cosmetic one — "tab" means the
// bytes are navigated to on the S3 origin, so anything scriptable must never
// land there.

const test = require('node:test');
const assert = require('node:assert/strict');

const s3World = require('../lib/s3/s3World');
const s3Client = require('../lib/s3/s3Client');
const types = require('../lib/s3/s3ContentTypes');

function typeFor(key, contentType) {
    return types.resolveObjectType({ key: key, contentType: contentType });
}

// --- recommendView ----------------------------------------------------------

test('natively-renderable media opens as a tab on the S3 origin', () => {
    ['photo.png', 'doc.pdf', 'clip.mp4', 'track.mp3'].forEach(function (key) {
        let recommendation = s3World.recommendView(typeFor(key), { size: 10 }, 'virtual-hosted');
        assert.equal(recommendation.mode, 'tab', key + ' should open in a tab');
    });
});

test('scriptable content never opens as a tab, whatever the endpoint style', () => {
    // An HTML or SVG object is attacker-controlled markup. Navigating to it puts
    // it on an origin; the only safe answer is our own inert preview.
    ['page.html', 'icon.svg', 'doc.xhtml'].forEach(function (key) {
        let virtualHosted = s3World.recommendView(typeFor(key), {}, 'virtual-hosted');
        assert.equal(virtualHosted.mode, 'preview', key);
        assert.ok(virtualHosted.reason.includes('script'));

        let pathStyle = s3World.recommendView(typeFor(key), {}, 'path');
        assert.equal(pathStyle.mode, 'preview', key + ' (path style)');
    });
});

test('path style gets its own explanation, because the origin is shared', () => {
    // Path style collapses every bucket in a region onto one origin, so a hostile
    // object there is same-origin with every other bucket the user can read.
    let pathStyle = s3World.recommendView(typeFor('page.html'), {}, 'path');
    assert.ok(pathStyle.reason.includes('shared S3 endpoint'));
    let virtualHosted = s3World.recommendView(typeFor('page.html'), {}, 'virtual-hosted');
    assert.ok(virtualHosted.reason.includes('isolated frame'));
    assert.notEqual(pathStyle.reason, virtualHosted.reason);
});

test('formats we decode server-side are previewed, not navigated to', () => {
    ['data.csv', 'events.jsonl', 'config.json', 'notes.md', 'app.log',
        'part-0.parquet', 'book.xlsx', 'archive.zip'].forEach(function (key) {
        assert.equal(s3World.recommendView(typeFor(key), {}, 'virtual-hosted').mode, 'preview', key);
    });
});

test('an undecodable binary is previewed as hex, with the reason carried through', () => {
    let recommendation = s3World.recommendView(typeFor('scan.tiff'), {}, 'virtual-hosted');
    assert.equal(recommendation.mode, 'preview');
    assert.ok(recommendation.reason.includes('TIFF'),
        'the extension map\'s note should reach the user');
});

test('an unrestored archived object is download-only, and says why', () => {
    // Reading it would fail with InvalidObjectState; offering a viewer would just
    // produce a confusing error.
    ['GLACIER', 'DEEP_ARCHIVE'].forEach(function (storageClass) {
        let recommendation = s3World.recommendView(typeFor('old.csv'),
            { storageClass: storageClass }, 'virtual-hosted');
        assert.equal(recommendation.mode, 'download');
        assert.ok(recommendation.reason.includes(storageClass));
        assert.ok(recommendation.reason.includes('restored'));
    });
});

test('a restored archived object is viewable again', () => {
    let recommendation = s3World.recommendView(typeFor('old.csv'),
        { storageClass: 'GLACIER', restore: 'ongoing-request="false"' }, 'virtual-hosted');
    assert.equal(recommendation.mode, 'preview');
});

test('archived beats scriptable: the bytes are not readable at all', () => {
    let recommendation = s3World.recommendView(typeFor('page.html'),
        { storageClass: 'DEEP_ARCHIVE' }, 'virtual-hosted');
    assert.equal(recommendation.mode, 'download');
});

test('STANDARD and INTELLIGENT_TIERING are not treated as archived', () => {
    ['STANDARD', 'STANDARD_IA', 'INTELLIGENT_TIERING', 'ONEZONE_IA', undefined].forEach(function (storageClass) {
        let recommendation = s3World.recommendView(typeFor('photo.png'),
            { storageClass: storageClass }, 'virtual-hosted');
        assert.equal(recommendation.mode, 'tab', String(storageClass));
    });
});

// --- clampExpiry ------------------------------------------------------------

const NOW = Date.parse('2026-09-02T12:00:00Z');

test('clampExpiry defaults to an hour and holds the AWS bounds', () => {
    assert.equal(s3World.clampExpiry(undefined, null, NOW), 3600);
    assert.equal(s3World.clampExpiry(null, null, NOW), 3600);
    assert.equal(s3World.clampExpiry('not a number', null, NOW), 3600);
    assert.equal(s3World.clampExpiry(0, null, NOW), 3600);

    // SigV4 presigned URLs are valid for 1 second to 7 days; the UI offers
    // 1 minute to 12 hours, and anything outside that is clamped, not rejected.
    assert.equal(s3World.clampExpiry(1, null, NOW), 60);
    assert.equal(s3World.clampExpiry(-500, null, NOW), 60);
    assert.equal(s3World.clampExpiry(999999, null, NOW), 43200);
    assert.equal(s3World.clampExpiry(900, null, NOW), 900);
    assert.equal(s3World.clampExpiry('1800', null, NOW), 1800, 'a string from the query works');
});

test('clampExpiry caps to the session token\'s remaining life', () => {
    // A SigV4 request is valid only until the EARLIER of X-Amz-Expires and the
    // session token's own expiry, so a "12 hour" URL signed with a session that
    // dies in 10 minutes is a lie.
    let tenMinutes = NOW + 10 * 60 * 1000;
    assert.equal(s3World.clampExpiry(43200, tenMinutes, NOW), 600);
    assert.equal(s3World.clampExpiry(3600, tenMinutes, NOW), 600);
    // A shorter request than the session life is honoured as asked.
    assert.equal(s3World.clampExpiry(300, tenMinutes, NOW), 300);
});

test('clampExpiry never returns less than the 60s floor, even for a dying session', () => {
    assert.equal(s3World.clampExpiry(3600, NOW + 5000, NOW), 60);
});

test('an already-expired credential does not produce a zero or negative lifetime', () => {
    // The caller should have re-minted; if it did not, an unusable-but-valid
    // number is better than X-Amz-Expires=-30, which S3 rejects outright.
    assert.equal(s3World.clampExpiry(3600, NOW - 60000, NOW), 3600);
});

test('long expiries survive for IAM-user profiles, which have no session expiry', () => {
    assert.equal(s3World.clampExpiry(43200, null, NOW), 43200);
});

// --- planPreviewRead --------------------------------------------------------

const HEAD_BYTES = s3World.PREVIEW_HEAD_BYTES;

test('a stream format is previewed from its head however large the object', () => {
    // The whole point of the ranged preview: a 40 GB log opens instantly.
    ['app.log', 'rows.csv', 'events.ndjson'].forEach(function (key) {
        let plan = s3World.planPreviewRead(typeFor(key), { size: 40 * 1024 * 1024 * 1024 });
        assert.equal(plan.range, 'bytes=0-' + (HEAD_BYTES - 1), key);
        assert.equal(plan.wholeObject, false, key);
        assert.equal(plan.tooLarge, false, key);
    });
});

test('a JSON document over the head size is read whole, because a prefix will not parse', () => {
    // The regression this exists to prevent: range-reading a 600 KB .json makes
    // JSON.parse fail, and the viewer drops to raw text with no tree at all.
    let plan = s3World.planPreviewRead(typeFor('export.json'), { size: 600 * 1024 });
    assert.equal(plan.range, null);
    assert.equal(plan.wholeObject, true);
    assert.equal(plan.tooLarge, false);
});

test('XML and YAML are documents too — read whole while affordable', () => {
    ['pom.xml', 'values.yaml'].forEach(function (key) {
        let plan = s3World.planPreviewRead(typeFor(key), { size: 900 * 1024 });
        assert.equal(plan.range, null, key + ' should not be range-read');
        assert.equal(plan.wholeObject, true, key);
    });
});

test('a document past its decoder budget falls back to the head read, not an error', () => {
    // Reading 30 MB only for previewJson to hand back raw text would be waste,
    // and refusing outright would show nothing at all — so it degrades.
    let jsonPlan = s3World.planPreviewRead(typeFor('huge.json'), {
        size: s3World.DOCUMENT_BUDGETS.json + 1
    });
    assert.equal(jsonPlan.range, 'bytes=0-' + (HEAD_BYTES - 1));
    assert.equal(jsonPlan.tooLarge, false);

    let xmlPlan = s3World.planPreviewRead(typeFor('huge.xml'), {
        size: s3World.DOCUMENT_BUDGETS.xml + 1
    });
    assert.equal(xmlPlan.range, 'bytes=0-' + (HEAD_BYTES - 1));
});

test('a small object is read whole with no Range header at all', () => {
    let plan = s3World.planPreviewRead(typeFor('notes.txt'), { size: 2048 });
    assert.equal(plan.range, null);
    assert.equal(plan.wholeObject, false, 'not a document — it just happens to fit');
});

test('containers need every byte and are refused above the whole-object limit', () => {
    // A zip's central directory is at the end; a gzip will not inflate from a
    // prefix. There is no partial answer to give, so the limit is a hard one.
    ['bundle.zip', 'book.xlsx', 'analysis.ipynb'].forEach(function (key) {
        let ok = s3World.planPreviewRead(typeFor(key), { size: 1024 * 1024 });
        assert.equal(ok.range, null, key);
        assert.equal(ok.wholeObject, true, key);
        assert.equal(ok.tooLarge, false, key);

        let over = s3World.planPreviewRead(typeFor(key), {
            size: s3World.WHOLE_OBJECT_LIMIT + 1
        });
        assert.equal(over.tooLarge, true, key + ' over the limit');
    });
});

test('a gzip Content-Encoding forces a whole-object read whatever the extension says', () => {
    // The bytes on the wire are a gzip stream; a ranged read of one is garbage.
    let plan = s3World.planPreviewRead(typeFor('app.log'), {
        size: 40 * 1024 * 1024 * 1024,
        contentEncoding: 'gzip'
    });
    assert.equal(plan.wholeObject, true);
    assert.equal(plan.tooLarge, true, 'and it is far too large to read in full');
});

// --- s3AsyncBuffer ----------------------------------------------------------

test('s3AsyncBuffer converts exclusive-end slices into inclusive HTTP ranges', async () => {
    // hyparquet asks for [start, end); HTTP Range is inclusive at both ends. An
    // off-by-one here silently corrupts the parquet footer.
    let requests = [];
    let originalGetObject = s3Client.getObject;
    s3Client.getObject = function (credentials, options, callback) {
        requests.push(options.range);
        callback(null, { body: Buffer.alloc(4) });
    };
    try {
        let buffer = s3World.s3AsyncBuffer(
            { credentials: {}, bucketRegion: 'us-east-1' },
            { bucket: 'b', key: 'k.parquet' },
            1000
        );
        assert.equal(buffer.byteLength, 1000);

        await buffer.slice(0, 100);
        await buffer.slice(996, 1000);
        // An open-ended slice reads to the object's last byte.
        await buffer.slice(900);

        assert.deepEqual(requests, [
            'bytes=0-99',
            'bytes=996-999',
            'bytes=900-999'
        ]);
        assert.equal(buffer.bytesRead, 12, 'bytes read are accumulated for reporting');
    } finally {
        s3Client.getObject = originalGetObject;
    }
});

test('s3AsyncBuffer clamps past the end and short-circuits an empty slice', async () => {
    let requests = [];
    let originalGetObject = s3Client.getObject;
    s3Client.getObject = function (credentials, options, callback) {
        requests.push(options.range);
        callback(null, { body: Buffer.alloc(1) });
    };
    try {
        let buffer = s3World.s3AsyncBuffer(
            { credentials: {}, bucketRegion: 'us-east-1' },
            { bucket: 'b', key: 'k.parquet' },
            100
        );
        await buffer.slice(90, 500);
        assert.deepEqual(requests, ['bytes=90-99'], 'the range must not run past the object');

        // A zero-length or inverted range would be a malformed Range header, and
        // S3 answers those with a 416.
        let empty = await buffer.slice(50, 50);
        assert.equal(empty.byteLength, 0);
        let inverted = await buffer.slice(80, 20);
        assert.equal(inverted.byteLength, 0);
        assert.equal(requests.length, 1, 'no request is made for an empty slice');
    } finally {
        s3Client.getObject = originalGetObject;
    }
});

test('s3AsyncBuffer surfaces an S3 error as a rejection', async () => {
    let originalGetObject = s3Client.getObject;
    s3Client.getObject = function (credentials, options, callback) {
        callback(new Error('AccessDenied'));
    };
    try {
        let buffer = s3World.s3AsyncBuffer(
            { credentials: {}, bucketRegion: 'us-east-1' },
            { bucket: 'b', key: 'k.parquet' },
            100
        );
        await assert.rejects(buffer.slice(0, 10), /AccessDenied/);
    } finally {
        s3Client.getObject = originalGetObject;
    }
});

// --- limits -----------------------------------------------------------------

test('the read limits are the ones the handlers document', () => {
    // These bound how much of an object a preview may pull. If they drift, the
    // "showing the first N" messages and the refusal thresholds drift with them.
    assert.equal(s3World.PREVIEW_HEAD_BYTES, 512 * 1024);
    assert.equal(s3World.WHOLE_OBJECT_LIMIT, 32 * 1024 * 1024);
    assert.equal(s3World.UPLOAD_LIMIT_BYTES, 100 * 1024 * 1024);
    // S3's DeleteObjects accepts at most 1000 keys per call, and ListObjectsV2
    // returns at most 1000 per page — both are hard API limits, not preferences.
    assert.equal(s3World.SEARCH_DEFAULTS.pageSize, 1000);
});
