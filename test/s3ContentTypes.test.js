"use strict";

// Tests for object type resolution — the piece that decides whether an S3 object
// renders in the browser or downloads.
//
// The two things worth guarding here are correctness of the precedence order
// (extension, then magic bytes, then the stored type) and the inline-safety
// allowlist, which is a security boundary rather than a convenience.

const test = require('node:test');
const assert = require('node:assert/strict');

const types = require('../lib/s3/s3ContentTypes');
const VIEWERS = types.VIEWERS;

function bytes() {
    return Buffer.from(Array.prototype.slice.call(arguments));
}

// --- precedence -------------------------------------------------------------

test('the extension wins over a generic stored Content-Type', () => {
    // The whole point: a PNG stored as octet-stream must still render as an
    // image instead of downloading.
    let resolved = types.resolveObjectType({
        key: 'photos/cat.png',
        contentType: 'application/octet-stream'
    });
    assert.equal(resolved.contentType, 'image/png');
    assert.equal(resolved.viewer, VIEWERS.IMAGE);
    assert.equal(resolved.basis, 'extension');
    assert.equal(resolved.storedContentType, 'application/octet-stream',
        'what S3 said is still reported, for display');
});

test('binary/octet-stream is treated as generic too', () => {
    // The AWS CLI and some SDKs use this spelling.
    assert.equal(types.isGenericContentType('binary/octet-stream'), true);
    assert.equal(types.isGenericContentType('application/octet-stream'), true);
    assert.equal(types.isGenericContentType(''), true);
    assert.equal(types.isGenericContentType(null), true);
    assert.equal(types.isGenericContentType('image/png'), false);
    // A charset parameter must not defeat the comparison.
    assert.equal(types.isGenericContentType('application/octet-stream; charset=binary'), true);
});

test('magic bytes resolve an object with no usable extension', () => {
    let resolved = types.resolveObjectType({
        key: 'exports/part-00000',
        contentType: 'application/octet-stream',
        head: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    });
    assert.equal(resolved.contentType, 'image/png');
    assert.equal(resolved.basis, 'signature');
    assert.ok(resolved.note, 'the user should be told the type came from the bytes');
});

test('a specific stored Content-Type is used when nothing else identifies the object', () => {
    let resolved = types.resolveObjectType({
        key: 'data/blob',
        contentType: 'image/webp'
    });
    assert.equal(resolved.contentType, 'image/webp');
    assert.equal(resolved.viewer, VIEWERS.IMAGE);
    assert.equal(resolved.basis, 'stored');
});

test('an extension-less text object falls through to the text viewer, not a hex dump', () => {
    // Logs, manifests and exports are routinely extension-less. A hex dump of a
    // readable file is the wrong answer.
    let resolved = types.resolveObjectType({
        key: 'logs/access',
        contentType: '',
        head: Buffer.from('127.0.0.1 - - [02/Sep/2026] "GET / HTTP/1.1" 200\n')
    });
    assert.equal(resolved.viewer, VIEWERS.TEXT);
    assert.equal(resolved.basis, 'text-sniff');
    assert.equal(resolved.isText, true);
});

test('an unidentifiable binary object gets the hex viewer', () => {
    let resolved = types.resolveObjectType({
        key: 'data/blob',
        contentType: 'application/octet-stream',
        head: bytes(0x03, 0x00, 0x91, 0xfe, 0x22, 0x00, 0x00, 0x11)
    });
    assert.equal(resolved.viewer, VIEWERS.BINARY);
    assert.equal(resolved.basis, 'default');
    assert.equal(resolved.isText, false);
});

test('ZIP is checked last, so .xlsx and .jar are not both "archive"', () => {
    // All of xlsx/docx/pptx/jar begin with PK\x03\x04. Only the extension can
    // tell them apart, so the extension must be consulted first.
    let zipHead = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
    assert.equal(types.resolveObjectType({ key: 'report.xlsx', head: zipHead }).viewer, VIEWERS.OFFICE);
    assert.equal(types.resolveObjectType({ key: 'app.jar', head: zipHead }).viewer, VIEWERS.ARCHIVE);
    assert.equal(types.resolveObjectType({ key: 'notes.docx', head: zipHead }).viewer, VIEWERS.OFFICE);
    // With no extension at all, ZIP is the honest verdict.
    assert.equal(types.resolveObjectType({ key: 'blob', head: zipHead }).viewer, VIEWERS.ARCHIVE);
});

test('sniffSignature recognises the formats S3 buckets are actually full of', () => {
    assert.equal(types.sniffSignature(Buffer.from('PAR1')).viewer, VIEWERS.PARQUET);
    assert.equal(types.sniffSignature(Buffer.from('%PDF-1.7')).viewer, VIEWERS.PDF);
    assert.equal(types.sniffSignature(bytes(0x1f, 0x8b, 0x08)).contentType, 'application/gzip');
    assert.equal(types.sniffSignature(Buffer.from('Obj')).contentType, 'application/avro');
    assert.equal(types.sniffSignature(bytes(0xff, 0xd8, 0xff, 0xe0)).contentType, 'image/jpeg');
    assert.equal(types.sniffSignature(Buffer.from('nothing special')), null);
});

test('a RIFF container is disambiguated by its second marker', () => {
    let webp = Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBP')]);
    let wav = Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WAVE')]);
    assert.equal(types.sniffSignature(webp).contentType, 'image/webp');
    assert.equal(types.sniffSignature(wav).contentType, 'audio/wav');
});

test('names with no dot are still recognised: Dockerfile, dotfiles', () => {
    assert.equal(types.resolveObjectType({ key: 'build/Dockerfile' }).monacoLanguage, 'dockerfile');
    let dotfile = types.resolveObjectType({ key: 'repo/.gitignore' });
    assert.equal(dotfile.viewer, VIEWERS.TEXT);
});

test('extensionOf ignores a dotfile and a trailing dot', () => {
    assert.equal(types.extensionOf('a/b/c.tar.gz'), 'gz');
    assert.equal(types.extensionOf('a/.bashrc'), '');
    assert.equal(types.extensionOf('a/name.'), '');
    assert.equal(types.extensionOf('a/name'), '');
    assert.equal(types.extensionOf('A/B/C.CSV'), 'csv', 'extensions are matched case-insensitively');
});

// --- inline safety: this one is a security boundary -------------------------

test('HTML and SVG are never inline-safe from our own origin', () => {
    // Serving attacker-controlled HTML or SVG inline from SignBridge's origin
    // would give it access to the app's DOM and API session.
    assert.equal(types.isInlineSafe('text/html'), false);
    assert.equal(types.isInlineSafe('application/xhtml+xml'), false);
    assert.equal(types.isInlineSafe('image/svg+xml'), false);
    assert.equal(types.isInlineSafe('image/svg+xml; charset=utf-8'), false);
    assert.equal(types.isInlineSafe('text/xml'), false);
    assert.equal(types.isInlineSafe('application/xml'), false);
});

test('inert media types are inline-safe', () => {
    assert.equal(types.isInlineSafe('image/png'), true);
    assert.equal(types.isInlineSafe('video/mp4'), true);
    assert.equal(types.isInlineSafe('audio/mpeg'), true);
    assert.equal(types.isInlineSafe('application/pdf'), true);
    assert.equal(types.isInlineSafe('text/plain'), true);
    assert.equal(types.isInlineSafe('text/plain; charset=utf-8'), true);
});

test('anything not on the allowlist is not inline-safe', () => {
    // The allowlist is closed on purpose: an unrecognised type must not become
    // inline just because it looks harmless.
    assert.equal(types.isInlineSafe('application/octet-stream'), false);
    assert.equal(types.isInlineSafe('application/zip'), false);
    assert.equal(types.isInlineSafe('text/csv'), false);
    assert.equal(types.isInlineSafe(''), false);
    assert.equal(types.isInlineSafe(null), false);
});

test('resolveObjectType flags scriptable content and denies it inline', () => {
    let svg = types.resolveObjectType({ key: 'icons/logo.svg' });
    assert.equal(svg.scriptable, true);
    assert.equal(svg.inlineSafe, false);
    let html = types.resolveObjectType({ key: 'site/index.html' });
    assert.equal(html.scriptable, true);
    assert.equal(html.inlineSafe, false);
    assert.equal(html.viewer, VIEWERS.HTML);

    let png = types.resolveObjectType({ key: 'a.png' });
    assert.equal(png.scriptable, false);
    assert.equal(png.inlineSafe, true);
});

// --- BOM handling -----------------------------------------------------------

test('UTF-32 BOMs are detected before UTF-16, because FF FE is a prefix of both', () => {
    // FF FE 00 00 is UTF-32LE; testing UTF-16LE first would read every UTF-32LE
    // file as UTF-16 and produce interleaved NULs.
    assert.deepEqual(types.detectBom(bytes(0xff, 0xfe, 0x00, 0x00)),
        { encoding: 'utf32le', length: 4 });
    assert.deepEqual(types.detectBom(bytes(0x00, 0x00, 0xfe, 0xff)),
        { encoding: 'utf32be', length: 4 });
    // A genuine UTF-16LE file: FF FE followed by real content.
    assert.deepEqual(types.detectBom(bytes(0xff, 0xfe, 0x41, 0x00)),
        { encoding: 'utf16le', length: 2 });
});

test('detectBom finds the UTF-8 and UTF-16BE marks, and reports none when absent', () => {
    assert.deepEqual(types.detectBom(bytes(0xef, 0xbb, 0xbf, 0x41)), { encoding: 'utf8', length: 3 });
    assert.deepEqual(types.detectBom(bytes(0xfe, 0xff, 0x00, 0x41)), { encoding: 'utf16be', length: 2 });
    assert.equal(types.detectBom(Buffer.from('plain')), null);
    assert.equal(types.detectBom(Buffer.alloc(0)), null);
});

test('decodeText strips the BOM: a leading U+FEFF breaks JSON.parse', () => {
    let withBom = Buffer.concat([bytes(0xef, 0xbb, 0xbf), Buffer.from('{"a":1}')]);
    let decoded = types.decodeText(withBom);
    assert.equal(decoded.text, '{"a":1}');
    assert.doesNotThrow(function () { JSON.parse(decoded.text); });
});

test('decodeText handles UTF-16 in both byte orders', () => {
    let le = Buffer.concat([bytes(0xff, 0xfe), Buffer.from('hi', 'utf16le')]);
    assert.equal(types.decodeText(le).text, 'hi');

    let beBody = Buffer.from('hi', 'utf16le');
    beBody.swap16();
    let be = Buffer.concat([bytes(0xfe, 0xff), beBody]);
    let decoded = types.decodeText(be);
    assert.equal(decoded.text, 'hi');
    assert.equal(decoded.encoding, 'utf-16be');
});

test('decodeText decodes UTF-32, which neither Node nor TextDecoder supports', () => {
    let body = Buffer.alloc(8);
    body.writeUInt32LE(0x68, 0);        // 'h'
    body.writeUInt32LE(0x1f600, 4);     // an astral code point
    let decoded = types.decodeText(Buffer.concat([bytes(0xff, 0xfe, 0x00, 0x00), body]));
    assert.equal(decoded.text, 'h\u{1f600}');
    assert.equal(decoded.encoding, 'utf-32le');
});

test('decodeText falls back to latin1 for non-UTF-8 bytes rather than filling with U+FFFD', () => {
    // A Windows-1252 log should still read sensibly.
    let latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xa9, 0x20, 0xb0]);
    let decoded = types.decodeText(latin);
    assert.equal(decoded.encoding, 'latin1');
    assert.equal(decoded.text, 'café © °');
});

test('decodeText tolerates the odd replacement char from a truncated range read', () => {
    // Cutting a preview at 512 KB can slice a multi-byte character in half; that
    // must not demote the whole document to latin1.
    let text = Buffer.concat([Buffer.from('a'.repeat(500)), Buffer.from([0xe2, 0x82])]);
    assert.equal(types.decodeText(text).encoding, 'utf8');
});

// --- text sniffing ----------------------------------------------------------

test('looksLikeText rejects NUL bytes and accepts ordinary text', () => {
    assert.equal(types.looksLikeText(Buffer.from('hello\tworld\r\n')), true);
    assert.equal(types.looksLikeText(Buffer.from([0x68, 0x00, 0x69])), false);
    assert.equal(types.looksLikeText(Buffer.alloc(0)), true, 'an empty object is not binary');
    // A BOM is a positive signal even though UTF-16 is full of NULs.
    assert.equal(types.looksLikeText(bytes(0xff, 0xfe, 0x41, 0x00)), true);
});

test('looksLikeText rejects a buffer dense with control characters', () => {
    let control = Buffer.alloc(100);
    for (let i = 0; i < control.length; i++) {
        control[i] = i % 2 === 0 ? 0x41 : 0x01;
    }
    assert.equal(types.looksLikeText(control), false);
});

// --- Content-Disposition ----------------------------------------------------

test('contentDisposition uses only the last path segment', () => {
    assert.equal(types.contentDisposition('a/b/report.csv', 'attachment'),
        'attachment; filename="report.csv"');
    assert.equal(types.contentDisposition('a/b/report.csv', 'inline'),
        'inline; filename="report.csv"');
});

test('contentDisposition strips quotes and newlines so a key cannot inject headers', () => {
    // A key is an arbitrary string; CR/LF in a header value is response splitting.
    let value = types.contentDisposition('evil"\r\nX-Injected: 1.txt', 'inline');
    assert.ok(!value.includes('\r'));
    assert.ok(!value.includes('\n'));
    // Exactly two quotes: the ones we put there. The key's own quote is gone, so
    // it cannot close the filename parameter early and start a new directive.
    assert.equal((value.match(/"/g) || []).length, 2);
    assert.ok(value.startsWith('inline; filename="evil___X-Injected: 1.txt"'));
    // The control characters also triggered the RFC 5987 form, where they are
    // percent-encoded — still no raw CR/LF anywhere in the header value.
    assert.ok(value.includes("filename*=UTF-8''evil%22%0D%0A"));
});

test('contentDisposition adds the RFC 5987 form for non-ASCII names', () => {
    let value = types.contentDisposition('reports/résumé.pdf', 'attachment');
    assert.ok(value.includes("filename*=UTF-8''"));
    assert.ok(value.includes(encodeURIComponent('résumé.pdf')));
});

test('contentDisposition defaults to attachment, the safe choice', () => {
    assert.ok(types.contentDisposition('a.txt').startsWith('attachment;'));
    assert.ok(types.contentDisposition('a.txt', 'anything-else').startsWith('attachment;'));
    // A key that is all slashes still yields a usable filename.
    assert.equal(types.contentDisposition('///', 'inline'), 'inline; filename="download"');
});
