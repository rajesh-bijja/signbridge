"use strict";

// Tests for the S3 World search language.
//
// These are written as a direct contrast with the AWS console's object filter,
// which is prefix-only, case-sensitive, and searches a single level. Every
// "console would miss this" case below is a real thing a user typed and got
// nothing back for. The defaults are the feature; the syntax is the extra.

const test = require('node:test');
const assert = require('node:assert/strict');

const s3Search = require('../lib/s3/s3Search');

// A small, realistic keyspace spanning several folders and cases.
const NOW = Date.parse('2026-09-02T12:00:00Z');
const KEYS = [
    { key: 'logs/2026/08/app-server.log', size: 4096, lastModified: '2026-08-30T10:00:00Z' },
    { key: 'logs/2026/08/APP-CLIENT.LOG', size: 8192, lastModified: '2026-08-31T10:00:00Z' },
    { key: 'reports/2026/Q3-final-report.csv', size: 15 * 1024 * 1024, lastModified: '2026-09-01T10:00:00Z' },
    { key: 'reports/2026/q3_draft_report.csv', size: 2048, lastModified: '2026-06-01T10:00:00Z' },
    { key: 'exports/warehouse/part-00000.parquet', size: 500 * 1024 * 1024, lastModified: '2026-08-01T10:00:00Z' },
    { key: 'exports/warehouse/part-00001.parquet', size: 480 * 1024 * 1024, lastModified: '2026-08-01T10:00:00Z' },
    { key: 'backup/reports/Q3-final-report.csv', size: 15 * 1024 * 1024, lastModified: '2026-09-01T10:00:00Z' },
    { key: 'config/settings.yaml', size: 512, lastModified: '2026-01-15T10:00:00Z' }
];

function entries() {
    return KEYS.map(function (entry) {
        return Object.assign({}, entry, {
            name: entry.key.split('/').pop(),
            relativeKey: entry.key
        });
    });
}

function find(query, options) {
    let search = s3Search.buildSearch(query, Object.assign({ nowMs: NOW }, options || {}));
    return entries().filter(search.matches).map(function (entry) {
        return entry.key;
    });
}

// --- the defaults: what the console gets wrong -----------------------------

test('a bare word matches anywhere in the key, not just the start', () => {
    // The console anchors to the prefix, so "report" would not find
    // "Q3-final-report.csv". This is the single most-reported gap.
    let hits = find('report');
    assert.ok(hits.includes('reports/2026/Q3-final-report.csv'));
    assert.ok(hits.includes('reports/2026/q3_draft_report.csv'));
    assert.ok(hits.includes('backup/reports/Q3-final-report.csv'));
});

test('matching the middle or end of a name works', () => {
    assert.deepEqual(find('final'), [
        'reports/2026/Q3-final-report.csv',
        'backup/reports/Q3-final-report.csv'
    ]);
    // The tail of the name, with no leading context.
    assert.ok(find('00001').includes('exports/warehouse/part-00001.parquet'));
});

test('search is case-insensitive by default', () => {
    let hits = find('app');
    assert.ok(hits.includes('logs/2026/08/app-server.log'));
    assert.ok(hits.includes('logs/2026/08/APP-CLIENT.LOG'), 'uppercase key must match a lowercase query');
    // And the reverse direction.
    assert.ok(find('LOG').includes('logs/2026/08/app-server.log'));
});

test('caseSensitive:true is available for when it is actually wanted', () => {
    let hits = find('APP', { caseSensitive: true });
    assert.deepEqual(hits, ['logs/2026/08/APP-CLIENT.LOG']);
});

test('search is recursive: it crosses folder boundaries', () => {
    // "warehouse" is two levels down from the root.
    assert.equal(find('warehouse').length, 2);
});

test('an empty query matches everything rather than nothing', () => {
    assert.equal(find('').length, KEYS.length);
    assert.equal(find('   ').length, KEYS.length);
    assert.ok(s3Search.parseQuery('').isEmpty);
});

// --- multiple words --------------------------------------------------------

test('multiple words are AND-ed, in any order and any position', () => {
    assert.deepEqual(find('q3 final'), [
        'reports/2026/Q3-final-report.csv',
        'backup/reports/Q3-final-report.csv'
    ]);
    // Order does not matter.
    assert.deepEqual(find('final q3'), find('q3 final'));
});

test('a quoted phrase matches literally, spaces included', () => {
    let search = s3Search.buildSearch('"final-report"', { nowMs: NOW });
    assert.equal(search.parsed.terms.length, 1);
    assert.equal(search.parsed.terms[0].value, 'final-report');
    assert.ok(search.matches({ key: 'a/Q3-final-report.csv', name: 'Q3-final-report.csv' }));
    assert.ok(!search.matches({ key: 'a/final_report.csv', name: 'final_report.csv' }));
});

test('quoting disables glob interpretation', () => {
    // Unquoted this would be a glob; quoted it is a literal '*'.
    let parsed = s3Search.parseQuery('"a*b"');
    assert.equal(parsed.terms[0].kind, 'substring');
    assert.equal(parsed.terms[0].value, 'a*b');
});

// --- negation --------------------------------------------------------------

test('a leading dash excludes', () => {
    let hits = find('report -backup');
    assert.ok(hits.includes('reports/2026/Q3-final-report.csv'));
    assert.ok(!hits.includes('backup/reports/Q3-final-report.csv'));
});

test('negation alone means "everything except"', () => {
    let hits = find('-log');
    assert.ok(!hits.includes('logs/2026/08/app-server.log'));
    assert.ok(hits.includes('config/settings.yaml'));
});

// --- globs -----------------------------------------------------------------

test('* matches any run of characters and is tested against the name too', () => {
    // The glob is anchored, so testing only the full key would require
    // "*/*.parquet". Matching the name as well is what makes "*.parquet" work.
    let hits = find('*.parquet');
    assert.equal(hits.length, 2);
    assert.ok(hits.every(function (key) { return key.endsWith('.parquet'); }));
});

test('? matches exactly one character', () => {
    assert.deepEqual(find('part-0000?.parquet').length, 2);
    assert.equal(find('part-0?.parquet').length, 0);
});

test('a glob treats . as a literal, not "any character"', () => {
    // If '.' were regex-special, "*.log" would also match "appXlog".
    let regex = s3Search.globToRegExp('*.log', false);
    assert.ok(regex.test('app.log'));
    assert.ok(!regex.test('appXlog'));
});

test('globs are case-insensitive by default too', () => {
    assert.ok(find('*.log').includes('logs/2026/08/APP-CLIENT.LOG'));
});

// --- field filters ---------------------------------------------------------

test('ext: filters by extension and accepts a comma list', () => {
    assert.equal(find('ext:parquet').length, 2);
    assert.equal(find('ext:csv,yaml').length, 4);
    // A leading dot is tolerated.
    assert.equal(find('ext:.parquet').length, 2);
});

test('ext: combines with a term as an AND', () => {
    assert.deepEqual(find('report ext:csv -backup'), [
        'reports/2026/Q3-final-report.csv',
        'reports/2026/q3_draft_report.csv'
    ]);
});

test('size> and size< filter by byte size with binary units', () => {
    assert.equal(s3Search.parseSize('10mb'), 10 * 1024 * 1024);
    assert.equal(s3Search.parseSize('1k'), 1024);
    assert.equal(s3Search.parseSize('2.5gb'), Math.round(2.5 * 1024 * 1024 * 1024));
    assert.equal(s3Search.parseSize('nonsense'), null);

    let big = find('size>100mb');
    assert.equal(big.length, 2);
    assert.ok(big.every(function (key) { return key.endsWith('.parquet'); }));

    assert.deepEqual(find('size<1k'), ['config/settings.yaml']);
});

test('modified> means "changed more recently than", the intuitive reading', () => {
    // Literal timestamp comparison would invert this; users mean recency.
    let recent = find('modified>3d');
    assert.ok(recent.includes('reports/2026/Q3-final-report.csv'));
    assert.ok(!recent.includes('config/settings.yaml'));
});

test('modified< finds old objects, and absolute dates work', () => {
    let old = find('modified<2026-07-01');
    assert.ok(old.includes('config/settings.yaml'));
    assert.ok(old.includes('reports/2026/q3_draft_report.csv'));
    assert.ok(!old.includes('reports/2026/Q3-final-report.csv'));
});

test('parseTime handles relative ages and absolute dates, and rejects junk', () => {
    assert.equal(s3Search.parseTime('7d', NOW), NOW - 7 * 86400000);
    assert.equal(s3Search.parseTime('24h', NOW), NOW - 24 * 3600000);
    assert.equal(s3Search.parseTime('2026-01-01', NOW), Date.parse('2026-01-01'));
    assert.equal(s3Search.parseTime('later', NOW), null);
});

// --- regex -----------------------------------------------------------------

test('a /regex/ literal is honoured', () => {
    let hits = find('/part-\\d{5}\\.parquet/');
    assert.equal(hits.length, 2);
});

test('regex gets the i flag unless case sensitivity was requested', () => {
    assert.ok(find('/app-client/').includes('logs/2026/08/APP-CLIENT.LOG'));
    assert.equal(find('/app-client/', { caseSensitive: true }).length, 0);
});

test('an explicit flag in the literal is preserved', () => {
    let parsed = s3Search.parseQuery('/^logs/i');
    assert.equal(parsed.terms[0].kind, 'regex');
    assert.ok(parsed.terms[0].regex.flags.includes('i'));
});

// --- robustness: a search box must never reject input ----------------------

test('an invalid regex degrades to a substring search instead of erroring', () => {
    let parsed = s3Search.parseQuery('/[unclosed/');
    assert.equal(parsed.terms.length, 1);
    assert.equal(parsed.terms[0].kind, 'substring');
    assert.ok(parsed.notes.some(function (note) {
        return note.includes('not a valid regular expression');
    }));
});

test('an unterminated quote takes the rest of the input verbatim', () => {
    let parsed = s3Search.parseQuery('"final report');
    assert.equal(parsed.terms[0].value, 'final report');
});

test('an unrecognised field: prefix is searched as literal text', () => {
    // A key genuinely containing "foo:bar" must still be findable.
    let search = s3Search.buildSearch('foo:bar');
    assert.equal(search.parsed.terms[0].kind, 'substring');
    assert.ok(search.matches({ key: 'a/foo:bar.txt', name: 'foo:bar.txt' }));
});

test('a URL-shaped token is not mistaken for a field filter', () => {
    let parsed = s3Search.parseQuery('http://example.com');
    assert.equal(parsed.terms.length, 1);
    assert.equal(parsed.terms[0].kind, 'substring');
});

test('a bad size or date value falls back to substring instead of vanishing', () => {
    // "size>huge" is not a size; dropping it silently would return the whole
    // bucket and look like the filter was ignored.
    let parsed = s3Search.parseQuery('size>huge');
    assert.equal(parsed.terms.length, 1);
    assert.equal(parsed.terms[0].kind, 'substring');
    assert.deepEqual(parsed.filters, {});
});

// --- scope, tokenizing, description ---------------------------------------

test('scope:name restricts matching to the last path segment', () => {
    // "reports" appears in the folder path of the backup copy but not its name.
    let byName = find('reports', { scope: 'name' });
    assert.equal(byName.length, 0);
    assert.ok(find('reports', { scope: 'key' }).length > 0);
});

test('scope:folder matches the path an object sits in, not its name', () => {
    // The question "where is the reports folder?" and the question "which files
    // are called report?" are asked with the same word and want opposite answers.
    let byFolder = find('reports', { scope: 'folder' });
    assert.deepEqual(byFolder, [
        'reports/2026/Q3-final-report.csv',
        'reports/2026/q3_draft_report.csv',
        'backup/reports/Q3-final-report.csv'
    ]);

    // `report` is in the *name* of every one of those, and in the folder of none
    // (the folder is "reports"), so a folder search for the singular still hits
    // by substring — but a name-only word like "final" hits nothing.
    assert.deepEqual(find('final', { scope: 'folder' }), []);
});

test('scope:folder matches any ancestor, not just the immediate parent', () => {
    // `logs/2026/08/app-server.log` sits two levels below the folder named "logs".
    assert.equal(find('logs', { scope: 'folder' }).length, 2);
    assert.equal(find('2026', { scope: 'folder' }).length, 4);
});

test('an object at the bucket root has no folder, so folder scope skips it', () => {
    // config/settings.yaml is in a folder; a root-level key would not be.
    let rootLevel = [{ key: 'settings.yaml', name: 'settings.yaml', relativeKey: 'settings.yaml', size: 1 }];
    let search = s3Search.buildSearch('settings', { scope: 'folder' });
    assert.equal(rootLevel.filter(search.matches).length, 0);
    // The same key in name scope is found, which is the contrast that matters.
    assert.equal(rootLevel.filter(s3Search.buildSearch('settings', { scope: 'name' }).matches).length, 1);
});

test('scope:both is the default and a superset of the other two', () => {
    let both = find('reports');
    assert.deepEqual(both, find('reports', { scope: 'both' }));
    find('reports', { scope: 'name' }).forEach(key => assert.ok(both.includes(key)));
    find('reports', { scope: 'folder' }).forEach(key => assert.ok(both.includes(key)));
    // And it still matches across the separator, which neither narrow scope can:
    // "warehouse/part" spans the folder and the name.
    assert.equal(find('warehouse/part').length, 2);
    assert.equal(find('warehouse/part', { scope: 'name' }).length, 0);
    assert.equal(find('warehouse/part', { scope: 'folder' }).length, 0);
});

test('normalizeScope is forgiving, and never narrows on a bad value', () => {
    assert.equal(s3Search.normalizeScope('name'), 'name');
    assert.equal(s3Search.normalizeScope('FileName'), 'name');
    assert.equal(s3Search.normalizeScope('folder'), 'folder');
    assert.equal(s3Search.normalizeScope('directory'), 'folder');
    assert.equal(s3Search.normalizeScope('prefix'), 'folder');
    // 'key' is what 'both' used to be called, and must keep working.
    assert.equal(s3Search.normalizeScope('key'), 'both');
    // Anything unrecognised widens rather than hides results.
    ['', null, undefined, 'nonsense', 42].forEach(value => {
        assert.equal(s3Search.normalizeScope(value), 'both', String(value));
    });
});

test('folderPathOf strips the name and never leaves a trailing slash', () => {
    assert.equal(s3Search.folderPathOf({ relativeKey: 'a/b/c.csv' }), 'a/b');
    assert.equal(s3Search.folderPathOf({ relativeKey: 'c.csv' }), '');
    assert.equal(s3Search.folderPathOf({ key: 'a/c.csv' }), 'a');
    // A folder marker's own path is the folder it stands for.
    assert.equal(s3Search.folderPathOf({ relativeKey: 'a/b/' }), 'a/b');
});

test('the folder matcher answers "which folders matched", ignoring object filters', () => {
    let search = s3Search.buildSearch('reports size>10mb', { scope: 'folder', nowMs: NOW });
    assert.equal(typeof search.matchesFolder, 'function');
    // A folder has no size, so `size>10mb` must not disqualify it — otherwise every
    // query mixing a folder term with a size filter would report zero folders.
    assert.equal(search.matchesFolder({ relativePath: 'reports' }), true);
    assert.equal(search.matchesFolder({ relativePath: 'backup/reports' }), true);
    assert.equal(search.matchesFolder({ relativePath: 'logs' }), false);
    // ...while the object side of the same query still applies the size filter.
    assert.deepEqual(find('reports size>10mb', { scope: 'folder' }), [
        'reports/2026/Q3-final-report.csv',
        'backup/reports/Q3-final-report.csv'
    ]);
});

test('a folder list is not offered for a name-scoped search, or for a filter-only query', () => {
    // Asking about file names says nothing about folders; producing a folder list
    // anyway would be answering a question the user did not ask.
    assert.equal(s3Search.buildSearch('report', { scope: 'name' }).matchesFolder, null);
    // A query with no terms at all selects no folders rather than all of them.
    let filterOnly = s3Search.buildSearch('size>1mb', { scope: 'both', nowMs: NOW });
    assert.equal(filterOnly.matchesFolder({ relativePath: 'reports' }), false);
});

test('an excluded folder term keeps the exclusion, so -backup drops the copy', () => {
    assert.deepEqual(find('reports -backup', { scope: 'folder' }), [
        'reports/2026/Q3-final-report.csv',
        'reports/2026/q3_draft_report.csv'
    ]);
});

test('globs and regexes work in folder scope, against the path and the folder name', () => {
    // Anchored glob on the folder's own name.
    assert.equal(find('warehous?', { scope: 'folder' }).length, 2);
    // Anchored glob on the whole path.
    assert.equal(find('logs/*/08', { scope: 'folder' }).length, 2);

    // An anchored pattern is tested against the folder's own name too, which is
    // the two-subject rule that makes `q3` and `2026/q3` both work — so `^reports`
    // finds the nested copy as well, because *its* folder is named "reports".
    assert.equal(find('/^reports/', { scope: 'folder' }).length, 3);
    // To mean "only at the top", say something the bare name cannot satisfy.
    assert.deepEqual(find('/^reports\\//', { scope: 'folder' }), [
        'reports/2026/Q3-final-report.csv',
        'reports/2026/q3_draft_report.csv'
    ]);
});

test('the explanation says which of the three things is being searched', () => {
    assert.match(s3Search.describeQuery(s3Search.parseQuery('a', { scope: 'name' })),
        /^Objects whose file name /);
    assert.match(s3Search.describeQuery(s3Search.parseQuery('a', { scope: 'folder' })),
        /^Objects inside a folder whose path /);
    assert.match(s3Search.describeQuery(s3Search.parseQuery('a')),
        /^Objects whose name or folder path /);
});

test('tokenize keeps quotes, regex literals and negation intact', () => {
    let tokens = s3Search.tokenize('a "b c" -d /e f/ g');
    assert.deepEqual(tokens.map(function (t) { return t.value; }),
        ['a', 'b c', 'd', '/e f/', 'g']);
    assert.equal(tokens[1].quoted, true);
    assert.equal(tokens[2].negated, true);
    assert.equal(tokens[3].regexLiteral, true);
});

test('extensionOf ignores dotfiles and trailing dots', () => {
    assert.equal(s3Search.extensionOf('a/b/c.csv'), 'csv');
    assert.equal(s3Search.extensionOf('a/b/.gitignore'), '');
    assert.equal(s3Search.extensionOf('a/b/name.'), '');
    assert.equal(s3Search.extensionOf('a/b/name'), '');
    assert.equal(s3Search.extensionOf('a/b/archive.TAR.GZ'), 'gz');
});

test('describeQuery explains the query in plain English', () => {
    assert.equal(s3Search.describeQuery(s3Search.parseQuery('')),
        'Everything under this folder.');
    let description = s3Search.describeQuery(s3Search.parseQuery('report -backup ext:csv'));
    assert.ok(description.includes('contains'));
    assert.ok(description.includes('does not contain'));
    assert.ok(description.includes('.csv'));
});

test('the explanation restates size and age, rather than echoing what was typed', () => {
    // The explain line's whole job is to confirm the query was understood, so
    // "10mb" has to come back as a size and "7d" as a span of time. Echoing the
    // user's own characters would prove nothing.
    let sizes = s3Search.describeQuery(s3Search.parseQuery('size>10mb'));
    assert.ok(sizes.includes('larger than 10 MB'), sizes);
    assert.ok(s3Search.describeQuery(s3Search.parseQuery('size<1500'))
        .includes('smaller than 1.5 KB'));

    assert.ok(s3Search.describeQuery(s3Search.parseQuery('modified>7d'))
        .includes('modified in the last 7 days'));
    assert.ok(s3Search.describeQuery(s3Search.parseQuery('modified>1d'))
        .includes('modified in the last 1 day'));
    assert.ok(s3Search.describeQuery(s3Search.parseQuery('modified<2w'))
        .includes('modified more than 2 weeks ago'));

    // An absolute date is not a span, so it keeps the after/before phrasing.
    assert.ok(s3Search.describeQuery(s3Search.parseQuery('modified>2026-01-01'))
        .includes('modified after 2026-01-01'));
});
