"use strict";

// Tests for the server-side content decoders behind "view this object".
//
// These parsers run on bytes we did not produce, usually on a truncated byte
// range rather than a whole object, so the interesting cases are the awkward
// ones: a CSV with a newline inside a quoted field, an NDJSON stream whose last
// line was cut in half, a parquet file read through ranged requests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const preview = require('../lib/s3/s3Preview');

// --- delimited text ---------------------------------------------------------

test('detectDelimiter picks the separator that is consistent across lines', () => {
    assert.equal(detect('a,b,c\n1,2,3\n4,5,6'), ',');
    assert.equal(detect('a\tb\tc\n1\t2\t3'), '\t');
    assert.equal(detect('a;b;c\n1;2;3'), ';');
    assert.equal(detect('a|b|c\n1|2|3'), '|');

    function detect(text) {
        return preview.detectDelimiter(text);
    }
});

test('detectDelimiter is not fooled by commas inside a semicolon-separated file', () => {
    // European CSV: ';' separates, ',' is the decimal mark. Counting occurrences
    // alone would pick ','; consistency across lines picks ';'.
    let text = 'name;amount\nalpha;1,50\nbeta;2,75\ngamma;3,00';
    assert.equal(preview.detectDelimiter(text), ';');
});

test('detectDelimiter defaults to comma for a single column', () => {
    assert.equal(preview.detectDelimiter('justonecolumn\nvalue\nvalue'), ',');
    assert.equal(preview.detectDelimiter(''), ',');
});

test('parseDelimited honours quoted fields, doubled quotes and embedded newlines', () => {
    let text = 'name,note\n' +
        '"Smith, John","He said ""hi"""\n' +
        '"multi\nline","ok"\n';
    let parsed = preview.parseDelimited(text, ',', 100);
    assert.deepEqual(parsed.rows, [
        ['name', 'note'],
        ['Smith, John', 'He said "hi"'],
        ['multi\nline', 'ok']
    ]);
    assert.equal(parsed.truncated, false);
});

test('parseDelimited handles CRLF without leaving stray carriage returns', () => {
    let parsed = preview.parseDelimited('a,b\r\n1,2\r\n', ',', 100);
    assert.deepEqual(parsed.rows, [['a', 'b'], ['1', '2']]);
});

test('parseDelimited stops at maxRows and says so', () => {
    let text = 'h\n' + Array.from({ length: 50 }, function (_, i) { return String(i); }).join('\n') + '\n';
    let parsed = preview.parseDelimited(text, ',', 5);
    assert.equal(parsed.rows.length, 5);
    assert.equal(parsed.truncated, true);
});

test('parseDelimited flags a final row with no trailing newline', () => {
    // On a truncated range read, this row is very likely cut mid-record.
    let parsed = preview.parseDelimited('a,b\n1,2', ',', 100);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.incompleteLastRow, true);
});

test('previewDelimited builds a table with the first row as column names', () => {
    let result = preview.previewDelimited('id,name\n1,alpha\n2,beta\n');
    assert.equal(result.kind, 'table');
    assert.equal(result.format, 'csv');
    assert.deepEqual(result.columns.map(function (c) { return c.name; }), ['id', 'name']);
    assert.deepEqual(result.rows, [['1', 'alpha'], ['2', 'beta']]);
    assert.equal(result.rowCount, 2);
    assert.equal(result.truncated, false);
});

test('previewDelimited names unlabelled columns rather than leaving them blank', () => {
    let result = preview.previewDelimited('id,,name\n1,x,alpha\n');
    assert.deepEqual(result.columns.map(function (c) { return c.name; }),
        ['id', 'Column 2', 'name']);
});

test('previewDelimited pads short rows so the table stays rectangular', () => {
    // Ragged CSV is common; a jagged table breaks the grid.
    let result = preview.previewDelimited('a,b,c\n1,2\n');
    assert.deepEqual(result.rows, [['1', '2', null]]);
});

test('previewDelimited drops the cut last row when the source was truncated', () => {
    // Otherwise the table's final entry is a garbled half-record.
    let text = 'id,name\n1,alpha\n2,be';
    let whole = preview.previewDelimited(text);
    assert.equal(whole.rows.length, 2, 'without the flag the partial row is kept');

    let truncated = preview.previewDelimited(text, { sourceTruncated: true });
    assert.equal(truncated.rows.length, 1);
    assert.deepEqual(truncated.rows[0], ['1', 'alpha']);
    assert.equal(truncated.truncated, true);
    assert.ok(truncated.note.includes('first'));
});

test('previewDelimited reports tsv as its own format', () => {
    let result = preview.previewDelimited('a\tb\n1\t2\n', { delimiter: '\t' });
    assert.equal(result.format, 'tsv');
    assert.equal(result.delimiter, '\t');
});

// --- JSON -------------------------------------------------------------------

test('previewJson pretty-prints and preserves key order', () => {
    let result = preview.previewJson('{"z":1,"a":{"b":[1,2]}}');
    assert.equal(result.kind, 'json');
    assert.equal(result.valid, true);
    assert.ok(result.text.indexOf('"z"') < result.text.indexOf('"a"'),
        'key order must survive the round trip');
    assert.ok(result.text.includes('\n  '), 'output is indented');
});

test('previewJson tabularises an array of objects', () => {
    let result = preview.previewJson('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
    assert.ok(result.tabular);
    assert.deepEqual(result.tabular.columns.map(function (c) { return c.name; }), ['id', 'name']);
    assert.deepEqual(result.tabular.rows, [[1, 'a'], [2, 'b']]);
});

test('previewJson offers no table for shapes where one makes no sense', () => {
    assert.equal(preview.previewJson('{"a":1}').tabular, null);
    assert.equal(preview.previewJson('[1,2,3]').tabular, null);
    assert.equal(preview.previewJson('[]').tabular, null);
    assert.equal(preview.previewJson('[[1],[2]]').tabular, null, 'arrays of arrays are not records');
});

test('invalid JSON degrades to raw text with an explanation', () => {
    let result = preview.previewJson('{"a":');
    assert.equal(result.kind, 'text');
    assert.equal(result.valid, false);
    assert.ok(result.note.startsWith('Not valid JSON:'));
});

test('a truncated JSON read says it was truncated, not that the file is broken', () => {
    // Blaming the object for our own range read would be misleading — and the
    // note has to say how much was read of how much, because "incomplete" with
    // no numbers reads like the viewer is broken rather than the read bounded.
    let result = preview.previewJson('{"a":', { sourceTruncated: true, totalSize: 40 * 1024 * 1024 });
    assert.equal(result.valid, false);
    assert.ok(result.note.includes('Only the first'));
    assert.ok(result.note.includes('of 40.0 MB'), result.note);
    assert.ok(result.note.includes('Download'), 'says what to do instead');
    assert.ok(!result.note.includes('Not valid JSON'));
});

test('a JSON object bigger than the head read still gets a tree', () => {
    // The bug this pins: a .json over PREVIEW_HEAD_BYTES was range-read, so
    // JSON.parse failed and the viewer fell back to raw text with an apology —
    // no Tree, no Raw JSON tabs, on a perfectly valid document. previewBuffer
    // must therefore parse the whole decoded text, not the text-viewer slice.
    let rows = [];
    for (let i = 0; i < 20000; i++) {
        rows.push({ id: i, name: 'row-' + i, note: 'x'.repeat(40) });
    }
    let buffer = Buffer.from(JSON.stringify(rows), 'utf8');
    assert.ok(buffer.length > 512 * 1024, 'fixture must exceed the head-read size');

    let result = preview.previewBuffer(buffer, { key: 'export.json' });
    assert.equal(result.kind, 'json');
    assert.equal(result.valid, true);
    assert.equal(result.truncated, false);
    assert.equal(JSON.parse(result.text).length, rows.length, 'the client builds its tree from this');
});

test('JSON past the parse budget says so with sizes instead of blaming the object', () => {
    let oversized = 'x'.repeat(preview.LIMITS.MAX_JSON_BYTES + 1);
    let result = preview.previewJson(oversized);
    assert.equal(result.kind, 'text');
    assert.equal(result.truncated, true);
    assert.ok(result.note.includes('parse budget'), result.note);
    assert.ok(result.note.includes('8.0 MB'), result.note);
});

// --- NDJSON -----------------------------------------------------------------

test('previewNdjson takes the union of keys, so optional fields are not hidden', () => {
    // Taking the first record's keys is the obvious implementation and it loses
    // columns; NDJSON logs almost always have optional fields.
    let text = '{"a":1}\n{"a":2,"b":3}\n{"c":4}\n';
    let result = preview.previewNdjson(text);
    assert.equal(result.kind, 'table');
    assert.deepEqual(result.columns.map(function (c) { return c.name; }), ['a', 'b', 'c']);
    assert.deepEqual(result.rows, [[1, null, null], [2, 3, null], [null, null, 4]]);
});

test('previewNdjson skips blank lines and counts unparsable ones', () => {
    let result = preview.previewNdjson('{"a":1}\n\nnot json\n{"a":2}\n');
    assert.equal(result.rows.length, 2);
    assert.ok(result.note.includes('1 of 3 lines could not be parsed'));
});

test('previewNdjson drops the last line when the read was truncated', () => {
    let result = preview.previewNdjson('{"a":1}\n{"a":2}\n{"a":', { sourceTruncated: true });
    assert.equal(result.rows.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.note, null, 'the cut line is not reported as a parse error');
});

test('previewNdjson wraps scalar lines so they still render', () => {
    let result = preview.previewNdjson('1\n"two"\n');
    assert.deepEqual(result.columns.map(function (c) { return c.name; }), ['value']);
    assert.deepEqual(result.rows, [[1], ['two']]);
});

test('previewNdjson falls back to raw text when nothing parses', () => {
    let result = preview.previewNdjson('this is\njust a log file\n');
    assert.equal(result.kind, 'text');
    assert.ok(result.note.includes('No parsable JSON lines'));
});

test('buildRowsFromObjects reports the true total, not the sampled count', () => {
    let table = preview.buildRowsFromObjects([{ a: 1 }, { a: 2 }], 5000);
    assert.equal(table.rowCount, 5000);
    assert.equal(table.truncated, true);
});

// --- parquet ----------------------------------------------------------------

test('previewParquet reads schema and rows through a ranged AsyncBuffer', async () => {
    // The fixture is tiny, but the access pattern is the same one used against a
    // multi-gigabyte object: read the footer, then only the needed column chunks.
    let buffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.parquet'));
    let reads = [];
    let asyncBuffer = {
        byteLength: buffer.length,
        slice: function (start, end) {
            let to = end == null ? buffer.length : end;
            reads.push([start, to]);
            return Promise.resolve(buffer.buffer.slice(buffer.byteOffset + start, buffer.byteOffset + to));
        }
    };

    let result = await preview.previewParquet(asyncBuffer, { maxRows: 10 });
    assert.equal(result.kind, 'table');
    assert.equal(result.format, 'parquet');
    assert.deepEqual(result.columns.map(function (c) { return c.name; }),
        ['id', 'name', 'score', 'active']);
    assert.deepEqual(result.columns.map(function (c) { return c.type; }),
        ['INT32', 'UTF8', 'DOUBLE', 'BOOLEAN']);
    assert.equal(result.rowCount, 5);
    assert.deepEqual(result.rows[0], [1, 'alpha', 1.5, true]);
    assert.deepEqual(result.rows[4], [5, 'epsilon', 5.5, false]);
    assert.equal(result.truncated, false);
    assert.equal(result.metadata.rowGroups, 1);
    assert.equal(result.metadata.columnCount, 4);

    // The point of the AsyncBuffer: a handful of small reads, not the whole file.
    assert.ok(reads.length > 0 && reads.length < 10,
        'expected a few ranged reads, got ' + reads.length);
});

test('previewParquet caps rows and reports the true row count', async () => {
    let buffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.parquet'));
    let asyncBuffer = {
        byteLength: buffer.length,
        slice: function (start, end) {
            let to = end == null ? buffer.length : end;
            return Promise.resolve(buffer.buffer.slice(buffer.byteOffset + start, buffer.byteOffset + to));
        }
    };
    let result = await preview.previewParquet(asyncBuffer, { maxRows: 2 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rowCount, 5, 'the header shows how many rows the file really has');
    assert.equal(result.truncated, true);
    assert.ok(result.note.includes('first 2 of 5 rows'));
});

// --- gzip / zip -------------------------------------------------------------

test('previewGzip inflates and previews the content inside', () => {
    // `.json.gz` and `.log.gz` are everywhere in S3.
    let inner = '{"event":"login","user":"a"}\n{"event":"logout","user":"a"}\n';
    let gzipped = zlib.gzipSync(Buffer.from(inner));
    let result = preview.previewGzip(gzipped, 'logs/events.jsonl.gz');
    assert.equal(result.kind, 'table', 'the .jsonl inside should drive the viewer');
    assert.deepEqual(result.rows, [['login', 'a'], ['logout', 'a']]);
});

test('previewGzip strips only the .gz suffix when re-resolving the inner type', () => {
    let gzipped = zlib.gzipSync(Buffer.from('id,name\n1,alpha\n'));
    let result = preview.previewGzip(gzipped, 'exports/data.csv.gz');
    assert.equal(result.kind, 'table');
    assert.deepEqual(result.columns.map(function (c) { return c.name; }), ['id', 'name']);
});

test('a truncated gzip stream explains itself instead of failing opaquely', () => {
    // A ranged read of a gzip cannot be inflated — the user needs to be told
    // that, not shown a raw zlib error.
    // Incompressible bytes, so the gzip stream is genuinely longer than the cut.
    let gzipped = zlib.gzipSync(require('node:crypto').randomBytes(64 * 1024));
    let cut = gzipped.slice(0, 4096);
    assert.ok(cut.length < gzipped.length, 'the fixture must actually be truncated');
    let result = preview.previewGzip(cut, 'a.txt.gz');
    assert.equal(result.kind, 'error');
    assert.ok(result.message.includes('ranged read'));
});

test('previewZip lists members without inflating them', () => {
    // Built with fflate so the test needs no external fixture.
    let fflate = require('fflate');
    let zipped = Buffer.from(fflate.zipSync({
        'readme.txt': new Uint8Array(Buffer.from('hello')),
        'nested/': new Uint8Array(0),
        'nested/data.csv': new Uint8Array(Buffer.from('a,b\n1,2\n'))
    }));
    let result = preview.previewZip(zipped);
    assert.equal(result.kind, 'archive');
    let names = result.entries.map(function (e) { return e.name; });
    assert.ok(names.includes('readme.txt'));
    assert.ok(names.includes('nested/data.csv'));
    let directory = result.entries.find(function (e) { return e.name === 'nested/'; });
    assert.equal(directory.isDirectory, true);
    assert.ok(result.note.includes('not extracted'));
});

test('a corrupt archive reports a readable message rather than throwing', () => {
    let result = preview.previewZip(Buffer.from('PK and then nonsense'));
    assert.equal(result.kind, 'error');
    assert.ok(result.message.length > 0);
});

// --- notebooks --------------------------------------------------------------

test('previewNotebook returns cells with text outputs and names image payloads', () => {
    let notebook = {
        metadata: { kernelspec: { language: 'python' } },
        cells: [
            { cell_type: 'markdown', source: ['# Title\n'] },
            {
                cell_type: 'code',
                source: 'print("hi")\n',
                outputs: [
                    { output_type: 'stream', text: ['hi\n'] },
                    { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo…' } }
                ]
            }
        ]
    };
    let result = preview.previewNotebook(JSON.stringify(notebook));
    assert.equal(result.kind, 'notebook');
    assert.equal(result.language, 'python');
    assert.equal(result.cells.length, 2);
    assert.equal(result.cells[0].source, '# Title\n');

    let serialised = JSON.stringify(result);
    assert.ok(!serialised.includes('iVBORw0KGgo'),
        'base64 image payloads must not be shipped to the client');
});

test('a non-notebook .ipynb reports the parse error', () => {
    let result = preview.previewNotebook('not json');
    assert.equal(result.kind, 'error');
    assert.ok(result.message.includes('Not a valid notebook'));
});

// --- hex dump ---------------------------------------------------------------

test('hexDump lays out 16 bytes per line with printable ASCII alongside', () => {
    let buffer = Buffer.from('ABC DEF');
    let result = preview.hexDump(buffer);
    assert.equal(result.kind, 'hex');
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].offset, '00000000');
    assert.ok(result.lines[0].hex.startsWith('41 42 43 00 44 45 46'));
    assert.equal(result.lines[0].ascii.slice(0, 7), 'ABC.DEF',
        'a NUL renders as a dot, not as a control character');
    assert.equal(result.bytesShown, 7);
    assert.equal(result.truncated, false);
});

test('hexDump caps how much it shows and says it did', () => {
    let result = preview.hexDump(Buffer.alloc(10000), { maxBytes: 64 });
    assert.equal(result.bytesShown, 64);
    assert.equal(result.lines.length, 4);
    assert.equal(result.truncated, true);
});

// --- small helpers ----------------------------------------------------------

test('columnIndexFromRef decodes spreadsheet columns past Z', () => {
    // A1-style references are base-26 with no zero digit, so AA is 26, not 27.
    assert.equal(preview.columnIndexFromRef('A1'), 0);
    assert.equal(preview.columnIndexFromRef('Z9'), 25);
    assert.equal(preview.columnIndexFromRef('AA1'), 26);
    assert.equal(preview.columnIndexFromRef('AB10'), 27);
    assert.equal(preview.columnIndexFromRef('BA1'), 52);
    assert.equal(preview.columnIndexFromRef('a1'), 0, 'lowercase refs are tolerated');
    assert.equal(preview.columnIndexFromRef('123'), null);
    assert.equal(preview.columnIndexFromRef(null), null);
});

test('decodeXmlEntities resolves the ampersand last', () => {
    // Doing '&amp;' first would turn '&amp;lt;' into '<' instead of '&lt;'.
    assert.equal(preview.decodeXmlEntities('&amp;lt;'), '&lt;');
    assert.equal(preview.decodeXmlEntities('a &lt;b&gt; &quot;c&quot; &apos;d&apos;'),
        'a <b> "c" \'d\'');
    assert.equal(preview.decodeXmlEntities('&#65;&#x42;'), 'AB');
});

test('formatBytes reads the way a file browser does', () => {
    assert.equal(preview.formatBytes(0), '0 B');
    assert.equal(preview.formatBytes(512), '512 B');
    assert.equal(preview.formatBytes(1024), '1.0 KB');
    assert.equal(preview.formatBytes(1536), '1.5 KB');
    assert.equal(preview.formatBytes(15 * 1024 * 1024), '15.0 MB');
    assert.equal(preview.formatBytes(null), 'unknown');
});

// --- the dispatcher ---------------------------------------------------------

test('previewBuffer routes by resolved viewer, not by guesswork', () => {
    assert.equal(preview.previewBuffer(Buffer.from('id,name\n1,a\n'), { key: 'a.csv' }).kind, 'table');
    assert.equal(preview.previewBuffer(Buffer.from('{"a":1}'), { key: 'a.json' }).kind, 'json');
    assert.equal(preview.previewBuffer(Buffer.from('# Title'), { key: 'a.md' }).kind, 'markdown');
    assert.equal(preview.previewBuffer(Buffer.from('plain log line'), { key: 'a.log' }).kind, 'text');
    assert.equal(preview.previewBuffer(Buffer.from([0x00, 0x01, 0x02]), { key: 'a.bin' }).kind, 'hex');
});

test('previewBuffer treats a .json.gz as a gzip, not as JSON', () => {
    // The extension map resolves .gz to the archive viewer; getting this backwards
    // would try to JSON.parse compressed bytes.
    let gzipped = zlib.gzipSync(Buffer.from('{"a":1}'));
    let result = preview.previewBuffer(gzipped, { key: 'logs/a.json.gz' });
    assert.equal(result.kind, 'json');
    assert.equal(result.valid, true);
});

test('previewBuffer renders HTML only through the isolated-frame path', () => {
    let result = preview.previewBuffer(Buffer.from('<h1>hi</h1><script>alert(1)</script>'),
        { key: 'a.html' });
    assert.equal(result.kind, 'html');
    assert.ok(result.note.includes('isolated frame'),
        'the UI must be told this needs a sandboxed frame');
});

test('previewBuffer carries the code viewer language through for syntax highlighting', () => {
    let result = preview.previewBuffer(Buffer.from('def f(): pass\n'), { key: 'a.py' });
    assert.equal(result.kind, 'text');
    assert.equal(result.monacoLanguage, 'python');
});

test('previewBuffer reports how much of a large object it showed', () => {
    let result = preview.previewBuffer(Buffer.from('x'.repeat(1024)), {
        key: 'big.log',
        sourceTruncated: true,
        totalSize: 5 * 1024 * 1024
    });
    assert.equal(result.truncated, true);
    assert.ok(result.note.includes('1.0 KB'));
    assert.ok(result.note.includes('5.0 MB'));
});

test('previewBuffer reports the decoded encoding so the user knows what happened', () => {
    let latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    let result = preview.previewBuffer(latin, { key: 'a.txt' });
    assert.equal(result.encoding, 'latin1');
    assert.equal(result.text, 'café');
});

// --- tar ---------------------------------------------------------------------
//
// Built here rather than shipped as a fixture: a tar is fixed-offset ASCII
// headers, so constructing one in the test is both readable and exact.

function tarHeader(name, size, typeFlag) {
    let block = Buffer.alloc(512, 0);
    block.write(name.slice(0, 100), 0, 'latin1');
    block.write('000644 \0', 100, 'latin1');                 // mode
    block.write('0000000 \0', 108, 'latin1');                // uid
    block.write('0000000 \0', 116, 'latin1');                // gid
    block.write(size.toString(8).padStart(11, '0') + ' ', 124, 'latin1');
    block.write('00000000000 ', 136, 'latin1');              // mtime
    block.write(typeFlag || '0', 156, 'latin1');
    block.write('ustar\0' + '00', 257, 'latin1');
    // Checksum is computed with the field itself read as spaces.
    block.write('        ', 148, 'latin1');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += block[i];
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    return block;
}

function tarOf(members) {
    let parts = [];
    for (const member of members) {
        let body = Buffer.from(member.body || '', 'utf8');
        parts.push(tarHeader(member.name, body.length, member.typeFlag));
        if (body.length) {
            let padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
            body.copy(padded);
            parts.push(padded);
        }
    }
    parts.push(Buffer.alloc(1024, 0));   // end-of-archive
    return Buffer.concat(parts);
}

test('previewTar lists members and steps over their bodies', () => {
    let tar = tarOf([
        { name: 'model/config.json', body: '{"layers":12}' },
        { name: 'model/weights.bin', body: 'x'.repeat(600) },
        { name: 'model/', typeFlag: '5' }
    ]);
    let result = preview.previewTar(tar);
    assert.equal(result.kind, 'archive');
    assert.equal(result.format, 'tar');
    assert.deepEqual(result.entries.map(e => e.name),
        ['model/config.json', 'model/weights.bin', 'model/']);
    assert.equal(result.entries[0].size, 13);
    assert.equal(result.entries[1].size, 600);   // spans two blocks
    assert.equal(result.entries[2].isDirectory, true);
});

test('previewTar resolves a GNU long name instead of showing the placeholder', () => {
    // Names over 100 chars are carried in an 'L' record before the real entry;
    // reading only the header field would truncate them to './@LongLink'.
    let long = 'checkpoints/' + 'very-long-directory-name/'.repeat(5) + 'weights.safetensors';
    let tar = tarOf([
        { name: './@LongLink', body: long + '\0', typeFlag: 'L' },
        { name: long.slice(0, 100), body: 'w' }
    ]);
    let result = preview.previewTar(tar);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].name, long);
});

test('previewTar says so when the bytes are not a tar', () => {
    let result = preview.previewTar(Buffer.alloc(2048, 0));
    assert.equal(result.kind, 'error');
    assert.match(result.message, /truncated or not a tar/);
});

test('previewBuffer expands a .tar.gz to its member listing', () => {
    // The common shape for model artifacts and log bundles: gzip, then tar.
    let gzipped = zlib.gzipSync(tarOf([{ name: 'run/metrics.csv', body: 'a,b\n1,2\n' }]));
    let result = preview.previewBuffer(gzipped, { key: 'bundle.tar.gz' });
    assert.equal(result.kind, 'archive');
    assert.equal(result.format, 'tar');
    assert.equal(result.decompressedFrom, 'gzip');
    assert.equal(result.entries[0].name, 'run/metrics.csv');
});

test('an archive identified by its magic bytes is expanded, whatever it is named', () => {
    // A Tableau .twbx is a zip; so are .whl, .nupkg, .epub, and anything an
    // uploader named badly. Dispatching on the extension would hex-dump them.
    let fflate = require('fflate');
    let zipped = Buffer.from(fflate.zipSync({ 'Data/report.xml': Buffer.from('<x/>') }));
    let result = preview.previewBuffer(zipped, { key: 'dashboard.twbx' });
    assert.equal(result.kind, 'archive');
    assert.equal(result.format, 'zip');
    assert.equal(result.entries[0].name, 'Data/report.xml');
});

test('a tar with no usable extension is still recognised from its ustar magic', () => {
    let result = preview.previewBuffer(tarOf([{ name: 'a.txt', body: 'hi' }]), { key: 'archive' });
    assert.equal(result.kind, 'archive');
    assert.equal(result.format, 'tar');
});
