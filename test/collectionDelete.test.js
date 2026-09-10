"use strict";

// Deleting an imported collection.
//
// The reported failure: "could not locate the collection: 1788457090741_Aiops
// (2018-05-10)" — for a collection that was sitting on disk under exactly that
// name, and was listed in the Templates picker at the same moment.
//
// The cause was the shared `ignoreFunc` filter used by every other collection
// handler. It drops any file not ending in `.json`, which is right for the output
// directory (request details and metadata.json) and wrong for the input directory,
// where the file is named `<timestamp>_<collectionName>` and a collection imported
// from the AWS catalog gets its name from a service label with no extension at
// all. So the scan that was supposed to find the file could never see it, and
// only a collection whose name happened to end in `.json` was ever deletable.
//
// A wrong extension filter fails the same way every time and looks like missing
// data rather than a bug, so the guard is asserted against the source: delete must
// not reach for that scan again.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coreUtils = require('../lib/coreUtils');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'coreUtils.js'), 'utf8');

// The name from the bug report, verbatim: no extension, a space, and parentheses.
const AWS_CATALOG_NAME = '1788457090741_Aiops (2018-05-10)';

test('splitImportedCollectionName reads the timestamp off an extensionless name', () => {
    const parsed = coreUtils.splitImportedCollectionName(AWS_CATALOG_NAME);
    assert.ok(parsed, 'the AWS-catalog name from the bug report must parse');
    assert.strictEqual(parsed.timestamp, '1788457090741');
    assert.strictEqual(parsed.collectionName, 'Aiops (2018-05-10)');
});

test('splitImportedCollectionName keeps an underscore inside the collection name', () => {
    // Only the first underscore separates the timestamp; the rest belong to the
    // name the user gave the collection.
    const parsed = coreUtils.splitImportedCollectionName('1700000000000_my_collection.json');
    assert.strictEqual(parsed.timestamp, '1700000000000');
    assert.strictEqual(parsed.collectionName, 'my_collection.json');
});

test('splitImportedCollectionName refuses a name that is not <digits>_<name>', () => {
    for (const bad of ['', null, undefined, 'no-underscore', '_leading', 'abc_notatimestamp']) {
        assert.strictEqual(coreUtils.splitImportedCollectionName(bad), null,
            'must not parse: ' + String(bad));
    }
});

test('splitImportedCollectionName refuses a path, because delete builds a path from it', () => {
    // Delete joins this value onto the collections directory, so a separator or a
    // parent reference has to be rejected here rather than sanitised later.
    for (const bad of ['1700000000000_a/../../../etc/passwd', '../1700000000000_a',
            '1700000000000_a/b', '/tmp/1700000000000_a']) {
        assert.strictEqual(coreUtils.splitImportedCollectionName(bad), null,
            'must not parse: ' + bad);
    }
});

test('deleteCollection does not filter the input directory by extension', () => {
    // `ignoreFunc` is correct for the output directory and fatal for the input
    // one. If it comes back into the locate step, every AWS-catalog collection
    // becomes undeletable again with the same misleading message.
    const locate = SOURCE.slice(SOURCE.indexOf('function findCollectionTimestamp'),
        SOURCE.indexOf('function removeCollectionDir'));
    assert.ok(locate.length > 100, 'findCollectionTimestamp must exist');
    assert.ok(!/ignoreFunc/.test(locate),
        'locating the collection input file must not use the .json-only ignore filter');
    assert.ok(!/PROFILE_EXT/.test(locate),
        'locating the collection input file must not depend on a .json extension');

    const handler = SOURCE.slice(SOURCE.indexOf('function deleteCollection'),
        SOURCE.indexOf('function deleteRequestFromCollection'));
    assert.ok(/findCollectionTimestamp\(/.test(handler),
        'deleteCollection must locate the collection through findCollectionTimestamp');
    assert.ok(!/ignoreFunc/.test(handler),
        'deleteCollection must not reintroduce the extension-filtered scan');
});

test('deleteCollection reports the real error, not an undefined variable', () => {
    // Every error path in the old handler said `error.message` where the callback
    // parameter was `err`, so any genuine failure threw a ReferenceError inside a
    // callback instead of answering the request.
    const handler = SOURCE.slice(SOURCE.indexOf('function deleteCollection'),
        SOURCE.indexOf('function deleteRequestFromCollection'));
    assert.ok(!/\berror\.message\b/.test(handler),
        'deleteCollection must not reference an undeclared `error`');
});

// The locate step touches the filesystem, so give it a real directory laid out the
// way an import leaves one. A temp dir, not the user's artifacts.
function withCollectionsInputDir(layout, fn) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-collections-'));
    try {
        for (const timestampDir of Object.keys(layout)) {
            fs.mkdirSync(path.join(base, timestampDir), { recursive: true });
            for (const fileName of layout[timestampDir]) {
                fs.writeFileSync(path.join(base, timestampDir, fileName), '{}');
            }
        }
        return fn(base);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}

test('findCollectionTimestamp finds a collection stored without a .json name', () => {
    // The exact case from the bug report: this used to return nothing.
    withCollectionsInputDir({ '1788457090741': [AWS_CATALOG_NAME] }, (base) => {
        assert.strictEqual(coreUtils.findCollectionTimestamp(base, AWS_CATALOG_NAME),
            '1788457090741');
    });
});

test('findCollectionTimestamp still finds an uploaded .json collection', () => {
    withCollectionsInputDir({ '1700000000000': ['1700000000000_My Collection.json'] }, (base) => {
        assert.strictEqual(
            coreUtils.findCollectionTimestamp(base, '1700000000000_My Collection.json'),
            '1700000000000');
    });
});

test('findCollectionTimestamp picks the right one out of several collections', () => {
    withCollectionsInputDir({
        '1700000000000': ['1700000000000_First.json'],
        '1788457090741': [AWS_CATALOG_NAME],
        '1799999999999': ['1799999999999_Third (2020-01-01)']
    }, (base) => {
        assert.strictEqual(coreUtils.findCollectionTimestamp(base, AWS_CATALOG_NAME),
            '1788457090741');
        assert.strictEqual(
            coreUtils.findCollectionTimestamp(base, '1799999999999_Third (2020-01-01)'),
            '1799999999999');
    });
});

test('findCollectionTimestamp scans when the file is not under its own timestamp', () => {
    // A collection predating the naming convention, or moved by hand: the name
    // says one timestamp and the file lives under another. The scan is the reason
    // a mismatch degrades to "found" rather than "could not locate".
    withCollectionsInputDir({ '1600000000000': ['1788457090741_Legacy'] }, (base) => {
        assert.strictEqual(coreUtils.findCollectionTimestamp(base, '1788457090741_Legacy'),
            '1600000000000');
    });
});

test('findCollectionTimestamp returns null for a collection that is really absent', () => {
    withCollectionsInputDir({ '1788457090741': [AWS_CATALOG_NAME] }, (base) => {
        assert.strictEqual(coreUtils.findCollectionTimestamp(base, '1788457090741_Nope'), null);
        // A traversal attempt must not resolve to anything, even though the
        // referenced path exists.
        assert.strictEqual(
            coreUtils.findCollectionTimestamp(base, '1788457090741/' + AWS_CATALOG_NAME), null);
    });
});

test('findCollectionTimestamp returns null instead of throwing on a missing directory', () => {
    assert.strictEqual(
        coreUtils.findCollectionTimestamp(path.join(os.tmpdir(), 'sb-does-not-exist-' + Date.now()),
            AWS_CATALOG_NAME),
        null);
});
