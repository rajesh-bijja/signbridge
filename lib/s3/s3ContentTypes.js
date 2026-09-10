"use strict";

/**
 * s3ContentTypes.js — deciding what an object actually is, and how to show it.
 *
 * THE PROBLEM THIS SOLVES
 * You cannot trust an S3 object's stored Content-Type. Objects uploaded by the
 * CLI, by a Spark job, by a Lambda, or by any SDK that didn't bother, arrive as
 * `application/octet-stream` or `binary/octet-stream` — and a browser handed
 * `application/octet-stream` downloads the file instead of rendering it. That
 * single fact is why "view an S3 object in your browser" is normally a
 * download-then-open-locally chore.
 *
 * So the type is resolved from several sources, first match winning:
 *   1. the key's extension            — right the vast majority of the time, and
 *                                       the only signal that separates an .xlsx
 *                                       from a .jar (both are ZIPs)
 *   2. the object's leading bytes     — magic numbers, which cannot lie; used
 *                                       when the extension told us nothing
 *   3. the stored Content-Type        — used when it is specific, ignored when
 *                                       it is a generic placeholder
 *   4. a text sniff, then a plain binary default
 *
 * `basis` on the result reports which of them won.
 *
 * The result names a *viewer*, not just a MIME type: the UI needs to know
 * whether to hand the bytes to <img>, to a text pane, to a table, or to a hex
 * dump.
 *
 * SECURITY — `inlineSafe` is the one flag here with teeth. Object content is
 * untrusted input. Serving an attacker-controlled HTML or SVG file inline from
 * SignBridge's own origin would let it script against the app (read the DOM,
 * call the API with the user's session). So HTML and SVG are never inline-safe
 * from our origin: they render only inside a sandboxed iframe or via a presigned
 * URL, which puts them on the S3 origin instead. See s3World.js.
 */

// Viewer kinds the frontend knows how to render. Keep in step with
// frontend/src/components/s3/objectViewers.jsx.
const VIEWERS = {
    IMAGE: 'image',
    PDF: 'pdf',
    VIDEO: 'video',
    AUDIO: 'audio',
    TEXT: 'text',        // plain text / logs — read-only text pane
    CODE: 'code',        // text with a syntax mode
    JSON: 'json',        // pretty-printed + collapsible
    XML: 'xml',          // parsed into a collapsible element tree
    YAML: 'yaml',        // parsed into a collapsible key tree
    NDJSON: 'ndjson',    // one JSON document per line -> table
    MARKDOWN: 'markdown',
    CSV: 'csv',          // delimited -> table
    HTML: 'html',        // sandboxed iframe only
    PARQUET: 'parquet',  // decoded server-side -> table
    ARCHIVE: 'archive',  // listing of members
    OFFICE: 'office',    // xlsx/docx/pptx
    NOTEBOOK: 'notebook',
    BINARY: 'binary'     // hex + ASCII dump
};

// Generic types that carry no information. When the stored Content-Type is one
// of these we ignore it and trust the extension / magic bytes instead.
const GENERIC_CONTENT_TYPES = [
    'application/octet-stream',
    'binary/octet-stream',
    'application/x-www-form-urlencoded',
    'application/unknown',
    'content/unknown',
    ''
];

/**
 * extension -> { contentType, viewer, monacoLanguage? }
 *
 * `contentType` is what we tell the browser the bytes are, overriding whatever
 * S3 has stored. `viewer` is which component renders it.
 */
const EXTENSION_MAP = {
    // --- images: render natively ------------------------------------------
    png: { contentType: 'image/png', viewer: VIEWERS.IMAGE },
    jpg: { contentType: 'image/jpeg', viewer: VIEWERS.IMAGE },
    jpeg: { contentType: 'image/jpeg', viewer: VIEWERS.IMAGE },
    jpe: { contentType: 'image/jpeg', viewer: VIEWERS.IMAGE },
    gif: { contentType: 'image/gif', viewer: VIEWERS.IMAGE },
    webp: { contentType: 'image/webp', viewer: VIEWERS.IMAGE },
    avif: { contentType: 'image/avif', viewer: VIEWERS.IMAGE },
    bmp: { contentType: 'image/bmp', viewer: VIEWERS.IMAGE },
    ico: { contentType: 'image/x-icon', viewer: VIEWERS.IMAGE },
    // SVG is an image *and* a scripting context — see the security note above.
    svg: { contentType: 'image/svg+xml', viewer: VIEWERS.IMAGE, scriptable: true },
    // TIFF and HEIC are images no browser renders; the hex view is honest about
    // that rather than showing a broken-image icon.
    tif: { contentType: 'image/tiff', viewer: VIEWERS.BINARY, note: 'TIFF is not rendered by browsers — download to view.' },
    tiff: { contentType: 'image/tiff', viewer: VIEWERS.BINARY, note: 'TIFF is not rendered by browsers — download to view.' },
    heic: { contentType: 'image/heic', viewer: VIEWERS.BINARY, note: 'HEIC is only rendered by Safari — download to view elsewhere.' },
    psd: { contentType: 'image/vnd.adobe.photoshop', viewer: VIEWERS.BINARY },

    // --- documents ---------------------------------------------------------
    pdf: { contentType: 'application/pdf', viewer: VIEWERS.PDF },

    // --- video / audio: stream natively -----------------------------------
    mp4: { contentType: 'video/mp4', viewer: VIEWERS.VIDEO },
    m4v: { contentType: 'video/mp4', viewer: VIEWERS.VIDEO },
    webm: { contentType: 'video/webm', viewer: VIEWERS.VIDEO },
    ogv: { contentType: 'video/ogg', viewer: VIEWERS.VIDEO },
    mov: { contentType: 'video/quicktime', viewer: VIEWERS.VIDEO, note: 'QuickTime playback depends on the browser.' },
    mkv: { contentType: 'video/x-matroska', viewer: VIEWERS.VIDEO, note: 'Matroska playback depends on the browser.' },
    avi: { contentType: 'video/x-msvideo', viewer: VIEWERS.VIDEO, note: 'AVI is rarely playable in a browser.' },
    mp3: { contentType: 'audio/mpeg', viewer: VIEWERS.AUDIO },
    m4a: { contentType: 'audio/mp4', viewer: VIEWERS.AUDIO },
    wav: { contentType: 'audio/wav', viewer: VIEWERS.AUDIO },
    ogg: { contentType: 'audio/ogg', viewer: VIEWERS.AUDIO },
    oga: { contentType: 'audio/ogg', viewer: VIEWERS.AUDIO },
    flac: { contentType: 'audio/flac', viewer: VIEWERS.AUDIO },
    aac: { contentType: 'audio/aac', viewer: VIEWERS.AUDIO },

    // --- structured data: our own table viewers ---------------------------
    csv: { contentType: 'text/csv', viewer: VIEWERS.CSV },
    tsv: { contentType: 'text/tab-separated-values', viewer: VIEWERS.CSV },
    psv: { contentType: 'text/plain', viewer: VIEWERS.CSV },
    parquet: { contentType: 'application/vnd.apache.parquet', viewer: VIEWERS.PARQUET },
    pq: { contentType: 'application/vnd.apache.parquet', viewer: VIEWERS.PARQUET },
    ndjson: { contentType: 'application/x-ndjson', viewer: VIEWERS.NDJSON },
    jsonl: { contentType: 'application/x-ndjson', viewer: VIEWERS.NDJSON },
    json: { contentType: 'application/json', viewer: VIEWERS.JSON, monacoLanguage: 'json' },
    avro: { contentType: 'application/avro', viewer: VIEWERS.BINARY, note: 'Avro is a binary container — showing a hex preview.' },
    orc: { contentType: 'application/x-orc', viewer: VIEWERS.BINARY, note: 'ORC is a binary columnar format — showing a hex preview.' },

    // --- markup / text ----------------------------------------------------
    md: { contentType: 'text/markdown', viewer: VIEWERS.MARKDOWN },
    markdown: { contentType: 'text/markdown', viewer: VIEWERS.MARKDOWN },
    txt: { contentType: 'text/plain', viewer: VIEWERS.TEXT },
    text: { contentType: 'text/plain', viewer: VIEWERS.TEXT },
    log: { contentType: 'text/plain', viewer: VIEWERS.TEXT },
    out: { contentType: 'text/plain', viewer: VIEWERS.TEXT },
    err: { contentType: 'text/plain', viewer: VIEWERS.TEXT },
    html: { contentType: 'text/html', viewer: VIEWERS.HTML, scriptable: true },
    htm: { contentType: 'text/html', viewer: VIEWERS.HTML, scriptable: true },
    xhtml: { contentType: 'application/xhtml+xml', viewer: VIEWERS.HTML, scriptable: true },

    // --- code -------------------------------------------------------------
    js: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'javascript' },
    mjs: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'javascript' },
    cjs: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'javascript' },
    jsx: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'javascript' },
    ts: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'typescript' },
    tsx: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'typescript' },
    py: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'python' },
    rb: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'ruby' },
    java: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'java' },
    go: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'go' },
    rs: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'rust' },
    c: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'c' },
    h: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'c' },
    cpp: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'cpp' },
    cs: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'csharp' },
    php: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'php' },
    sh: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'shell' },
    bash: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'shell' },
    zsh: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'shell' },
    sql: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'sql' },
    // YAML gets the tree viewer, not the code viewer: a CloudFormation template or
    // a Kubernetes manifest is read by finding one branch, not by scrolling.
    yaml: { contentType: 'text/plain', viewer: VIEWERS.YAML, monacoLanguage: 'yaml' },
    yml: { contentType: 'text/plain', viewer: VIEWERS.YAML, monacoLanguage: 'yaml' },
    toml: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'ini' },
    ini: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'ini' },
    cfg: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'ini' },
    conf: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'ini' },
    properties: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'ini' },
    env: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'ini' },
    // XML family. The contentType stays text/plain because XML is not inline-safe
    // (a stylesheet can script), but the viewer parses it into a tree.
    xml: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    xsd: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    xsl: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    xslt: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    wsdl: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    rss: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    atom: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    plist: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    pom: { contentType: 'text/plain', viewer: VIEWERS.XML, monacoLanguage: 'xml' },
    tf: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'hcl' },
    tfvars: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'hcl' },
    dockerfile: { contentType: 'text/plain', viewer: VIEWERS.CODE, monacoLanguage: 'dockerfile' },
    ipynb: { contentType: 'application/json', viewer: VIEWERS.NOTEBOOK },

    // --- archives ---------------------------------------------------------
    zip: { contentType: 'application/zip', viewer: VIEWERS.ARCHIVE },
    jar: { contentType: 'application/java-archive', viewer: VIEWERS.ARCHIVE },
    gz: { contentType: 'application/gzip', viewer: VIEWERS.ARCHIVE },
    tgz: { contentType: 'application/gzip', viewer: VIEWERS.ARCHIVE },
    bz2: { contentType: 'application/x-bzip2', viewer: VIEWERS.ARCHIVE },
    xz: { contentType: 'application/x-xz', viewer: VIEWERS.ARCHIVE },
    zst: { contentType: 'application/zstd', viewer: VIEWERS.ARCHIVE },
    tar: { contentType: 'application/x-tar', viewer: VIEWERS.ARCHIVE },
    '7z': { contentType: 'application/x-7z-compressed', viewer: VIEWERS.ARCHIVE },
    rar: { contentType: 'application/vnd.rar', viewer: VIEWERS.ARCHIVE },

    // --- office -----------------------------------------------------------
    xlsx: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', viewer: VIEWERS.OFFICE },
    xls: { contentType: 'application/vnd.ms-excel', viewer: VIEWERS.OFFICE },
    docx: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', viewer: VIEWERS.OFFICE },
    doc: { contentType: 'application/msword', viewer: VIEWERS.OFFICE },
    pptx: { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', viewer: VIEWERS.OFFICE },
    ppt: { contentType: 'application/vnd.ms-powerpoint', viewer: VIEWERS.OFFICE }
};

/**
 * Magic-number signatures, checked when the extension is missing or the stored
 * type is generic. `offset` defaults to 0. The list is ordered most-specific
 * first because ZIP-based Office formats share ZIP's signature.
 */
const SIGNATURES = [
    { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], contentType: 'image/png', viewer: VIEWERS.IMAGE },
    { bytes: [0xff, 0xd8, 0xff], contentType: 'image/jpeg', viewer: VIEWERS.IMAGE },
    { ascii: 'GIF8', contentType: 'image/gif', viewer: VIEWERS.IMAGE },
    { ascii: 'RIFF', asciiAt: 8, ascii2: 'WEBP', contentType: 'image/webp', viewer: VIEWERS.IMAGE },
    { ascii: 'RIFF', asciiAt: 8, ascii2: 'WAVE', contentType: 'audio/wav', viewer: VIEWERS.AUDIO },
    { bytes: [0x42, 0x4d], contentType: 'image/bmp', viewer: VIEWERS.IMAGE },
    { bytes: [0x49, 0x49, 0x2a, 0x00], contentType: 'image/tiff', viewer: VIEWERS.BINARY },
    { bytes: [0x4d, 0x4d, 0x00, 0x2a], contentType: 'image/tiff', viewer: VIEWERS.BINARY },
    { ascii: '%PDF-', contentType: 'application/pdf', viewer: VIEWERS.PDF },
    // Parquet brackets its data with the 'PAR1' magic at both ends.
    { ascii: 'PAR1', contentType: 'application/vnd.apache.parquet', viewer: VIEWERS.PARQUET },
    { ascii: 'Obj', contentType: 'application/avro', viewer: VIEWERS.BINARY },
    { ascii: 'ORC', contentType: 'application/x-orc', viewer: VIEWERS.BINARY },
    { ascii: 'SQLite format 3', contentType: 'application/vnd.sqlite3', viewer: VIEWERS.BINARY },
    { ascii: 'ftyp', asciiAt: 4, contentType: 'video/mp4', viewer: VIEWERS.VIDEO },
    { bytes: [0x1a, 0x45, 0xdf, 0xa3], contentType: 'video/webm', viewer: VIEWERS.VIDEO },
    { ascii: 'OggS', contentType: 'audio/ogg', viewer: VIEWERS.AUDIO },
    { ascii: 'fLaC', contentType: 'audio/flac', viewer: VIEWERS.AUDIO },
    { ascii: 'ID3', contentType: 'audio/mpeg', viewer: VIEWERS.AUDIO },
    { bytes: [0x1f, 0x8b], contentType: 'application/gzip', viewer: VIEWERS.ARCHIVE },
    { bytes: [0x42, 0x5a, 0x68], contentType: 'application/x-bzip2', viewer: VIEWERS.ARCHIVE },
    { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a], contentType: 'application/x-xz', viewer: VIEWERS.ARCHIVE },
    { bytes: [0x28, 0xb5, 0x2f, 0xfd], contentType: 'application/zstd', viewer: VIEWERS.ARCHIVE },
    { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], contentType: 'application/x-7z-compressed', viewer: VIEWERS.ARCHIVE },
    { ascii: 'Rar!', contentType: 'application/vnd.rar', viewer: VIEWERS.ARCHIVE },
    // ZIP last of the containers: xlsx/docx/pptx/jar all start this way, so the
    // extension (checked first) is what distinguishes them.
    { bytes: [0x50, 0x4b, 0x03, 0x04], contentType: 'application/zip', viewer: VIEWERS.ARCHIVE },
    { ascii: 'ustar', asciiAt: 257, contentType: 'application/x-tar', viewer: VIEWERS.ARCHIVE },
    { bytes: [0x7f, 0x45, 0x4c, 0x46], contentType: 'application/x-elf', viewer: VIEWERS.BINARY },
    { bytes: [0xca, 0xfe, 0xba, 0xbe], contentType: 'application/java-vm', viewer: VIEWERS.BINARY }
];

function extensionOf(key) {
    let name = String(key || '').split('/').pop();
    // A dotfile with no other dot (".gitignore") has no extension; its whole
    // name is the hint, which the caller handles via `name` below.
    let dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) {
        return '';
    }
    return name.slice(dot + 1).toLowerCase();
}

function isGenericContentType(contentType) {
    if (!contentType) {
        return true;
    }
    let base = String(contentType).split(';')[0].trim().toLowerCase();
    return GENERIC_CONTENT_TYPES.indexOf(base) !== -1;
}

function matchesSignature(buffer, signature) {
    if (!buffer) {
        return false;
    }
    if (signature.bytes) {
        let offset = signature.offset || 0;
        if (buffer.length < offset + signature.bytes.length) {
            return false;
        }
        for (let i = 0; i < signature.bytes.length; i++) {
            if (buffer[offset + i] !== signature.bytes[i]) {
                return false;
            }
        }
        return true;
    }
    if (signature.ascii) {
        let at = signature.asciiAt != null && !signature.ascii2 ? signature.asciiAt : 0;
        if (buffer.length < at + signature.ascii.length) {
            return false;
        }
        if (buffer.slice(at, at + signature.ascii.length).toString('latin1') !== signature.ascii) {
            return false;
        }
        // RIFF containers: the discriminator sits at a second offset.
        if (signature.ascii2) {
            let at2 = signature.asciiAt;
            if (buffer.length < at2 + signature.ascii2.length) {
                return false;
            }
            return buffer.slice(at2, at2 + signature.ascii2.length).toString('latin1') === signature.ascii2;
        }
        return true;
    }
    return false;
}

function sniffSignature(buffer) {
    for (let i = 0; i < SIGNATURES.length; i++) {
        if (matchesSignature(buffer, SIGNATURES[i])) {
            return SIGNATURES[i];
        }
    }
    return null;
}

/**
 * Does this buffer look like text?
 *
 * A NUL byte is the classic tell — no text encoding except UTF-16/32 produces
 * one, and those announce themselves with a BOM. Beyond that, a high proportion
 * of bytes that are neither printable nor ordinary whitespace means binary.
 * Deliberately a heuristic over a sample, not a full decode: this runs on the
 * first few KB of what might be a multi-gigabyte object.
 */
function looksLikeText(buffer) {
    if (!buffer || buffer.length === 0) {
        return true;
    }
    let bom = detectBom(buffer);
    if (bom) {
        return true;
    }
    let sample = buffer.slice(0, Math.min(buffer.length, 8192));
    let suspicious = 0;
    for (let i = 0; i < sample.length; i++) {
        let byte = sample[i];
        if (byte === 0) {
            return false;
        }
        // Control characters other than tab, LF, CR, and form feed.
        if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
            suspicious++;
        }
    }
    return (suspicious / sample.length) < 0.1;
}

/**
 * Byte-order mark, if present. Returns { encoding, length } so the caller can
 * skip the mark before decoding — a leading U+FEFF renders as a stray glyph and
 * breaks JSON.parse on the first line.
 */
function detectBom(buffer) {
    if (!buffer || buffer.length < 2) {
        return null;
    }
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return { encoding: 'utf8', length: 3 };
    }
    // The UTF-32 marks MUST be tested before the UTF-16 ones: FF FE is a proper
    // prefix of the UTF-32LE mark FF FE 00 00, so checking UTF-16LE first would
    // misread every UTF-32LE file as UTF-16LE and decode it as interleaved NULs.
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xfe &&
        buffer[2] === 0x00 && buffer[3] === 0x00) {
        return { encoding: 'utf32le', length: 4 };
    }
    if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 &&
        buffer[2] === 0xfe && buffer[3] === 0xff) {
        return { encoding: 'utf32be', length: 4 };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
        return { encoding: 'utf16le', length: 2 };
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        return { encoding: 'utf16be', length: 2 };
    }
    return null;
}

/**
 * Decode a buffer to a string, honouring a BOM and falling back to latin1 when
 * the bytes are not valid UTF-8 (so a Windows-1252 log still reads sensibly
 * instead of filling with replacement characters).
 *
 * @returns {{ text: string, encoding: string }}
 */
function decodeText(buffer) {
    if (!buffer || buffer.length === 0) {
        return { text: '', encoding: 'utf8' };
    }
    let bom = detectBom(buffer);
    if (bom && (bom.encoding === 'utf32le' || bom.encoding === 'utf32be')) {
        // Neither Node nor TextDecoder can decode UTF-32, so read the code
        // points directly. Rare, but a file that announces itself with a BOM
        // deserves better than a hex dump.
        let body = buffer.slice(bom.length);
        let littleEndian = bom.encoding === 'utf32le';
        let out = '';
        for (let i = 0; i + 3 < body.length; i += 4) {
            let codePoint = littleEndian ? body.readUInt32LE(i) : body.readUInt32BE(i);
            // Surrogates and out-of-range values are not valid scalar values.
            if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
                out += '�';
            } else {
                out += String.fromCodePoint(codePoint);
            }
        }
        return { text: out, encoding: bom.encoding === 'utf32le' ? 'utf-32le' : 'utf-32be' };
    }
    if (bom && bom.encoding === 'utf16le') {
        return { text: buffer.slice(bom.length).toString('utf16le'), encoding: 'utf-16le' };
    }
    if (bom && bom.encoding === 'utf16be') {
        // Node has no utf16be decoder; swap the pairs and use utf16le.
        let swapped = Buffer.from(buffer.slice(bom.length));
        swapped.swap16();
        return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
    }
    let body = bom ? buffer.slice(bom.length) : buffer;
    let text = body.toString('utf8');
    // U+FFFD in the output means the bytes were not UTF-8. A couple can occur
    // legitimately at a truncated range boundary, so require a real proportion.
    let replacements = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0xfffd) {
            replacements++;
        }
    }
    if (replacements > 0 && replacements / text.length > 0.02) {
        return { text: body.toString('latin1'), encoding: 'latin1' };
    }
    return { text: text, encoding: 'utf8' };
}

/**
 * Which types are safe for the app's own origin to serve inline.
 *
 * The rule is narrow on purpose: anything that can execute script in the
 * browser's context (HTML, XHTML, SVG, XML with a stylesheet) is excluded, and
 * so is anything that a sniffing browser might *treat* as HTML. Everything else
 * inline-renders as an image, a video, a PDF or literal text, none of which can
 * reach back into the page.
 */
function isInlineSafe(contentType) {
    let base = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (base.indexOf('image/svg') === 0) {
        return false;
    }
    if (base === 'text/html' || base === 'application/xhtml+xml' || base === 'text/xml' ||
        base === 'application/xml') {
        return false;
    }
    return base.indexOf('image/') === 0 ||
        base.indexOf('video/') === 0 ||
        base.indexOf('audio/') === 0 ||
        base === 'application/pdf' ||
        base === 'text/plain';
}

/**
 * Resolve an object's type and viewer.
 *
 * @param {object} input
 *   key            the object key (extension is the primary hint)
 *   contentType    the Content-Type S3 has stored (may be generic/absent)
 *   head           Buffer of the object's first bytes, when available
 *   size           object size in bytes
 * @returns {object}
 *   contentType        what to tell the browser the bytes are
 *   storedContentType  what S3 said, for display
 *   viewer             one of VIEWERS
 *   monacoLanguage     syntax mode when viewer is 'code'
 *   inlineSafe         safe to serve inline from our own origin
 *   scriptable         content can execute script (HTML/SVG) — render sandboxed
 *   isText             the bytes decode as text
 *   basis              'extension' | 'signature' | 'stored' | 'text-sniff' | 'default'
 *   note               a caveat to show the user, when there is one
 */
function resolveObjectType(input) {
    input = input || {};
    let key = input.key || '';
    let extension = extensionOf(key);
    let name = String(key).split('/').pop().toLowerCase();
    let head = input.head || null;
    let storedContentType = input.contentType || null;

    let resolved = null;
    let basis = 'default';

    // 1. Extension — the strongest signal in practice, and the only one that
    //    can tell an .xlsx from a .jar (both are ZIPs).
    if (EXTENSION_MAP[extension]) {
        resolved = EXTENSION_MAP[extension];
        basis = 'extension';
    } else if (EXTENSION_MAP[name]) {
        // Extension-less names that are still recognisable: Dockerfile, .env.
        resolved = EXTENSION_MAP[name];
        basis = 'extension';
    } else if (name.charAt(0) === '.' && name.indexOf('.', 1) === -1) {
        // A dotfile (.gitignore, .bashrc) is text.
        resolved = { contentType: 'text/plain', viewer: VIEWERS.TEXT };
        basis = 'extension';
    }

    // 2. Magic bytes — used when the extension told us nothing, and also to
    //    correct an extension that disagrees with the actual content.
    if (!resolved && head) {
        let signature = sniffSignature(head);
        if (signature) {
            resolved = {
                contentType: signature.contentType,
                viewer: signature.viewer,
                note: 'Type identified from the file\'s contents (no recognisable extension).'
            };
            basis = 'signature';
        }
    }

    // 3. A specific stored Content-Type is better than nothing.
    if (!resolved && !isGenericContentType(storedContentType)) {
        let base = String(storedContentType).split(';')[0].trim().toLowerCase();
        let viewer = VIEWERS.BINARY;
        if (base.indexOf('image/') === 0) {
            viewer = VIEWERS.IMAGE;
        } else if (base.indexOf('video/') === 0) {
            viewer = VIEWERS.VIDEO;
        } else if (base.indexOf('audio/') === 0) {
            viewer = VIEWERS.AUDIO;
        } else if (base === 'application/pdf') {
            viewer = VIEWERS.PDF;
        } else if (base === 'application/json') {
            viewer = VIEWERS.JSON;
        } else if (base === 'text/html' || base === 'application/xhtml+xml') {
            viewer = VIEWERS.HTML;
        } else if (base === 'text/xml' || base === 'application/xml') {
            // An extension-less object stored with a real XML type still gets the
            // tree. `+xml` suffixes (svg, xhtml) are deliberately not included —
            // they are handled above, and they are script-capable.
            viewer = VIEWERS.XML;
        } else if (base === 'text/yaml' || base === 'application/yaml' ||
                   base === 'application/x-yaml' || base === 'text/x-yaml') {
            // YAML has had four content types over the years and objects in the
            // wild carry all of them; only `application/yaml` is registered.
            viewer = VIEWERS.YAML;
        } else if (base.indexOf('text/') === 0) {
            viewer = VIEWERS.TEXT;
        }
        resolved = { contentType: base, viewer: viewer };
        basis = 'stored';
    }

    // 4. Last resort: if it decodes as text, show it as text. A great many S3
    //    objects are extension-less text (logs, exports, manifests), and a hex
    //    dump of a readable file is a bad answer.
    let isText = head ? looksLikeText(head) : false;
    if (!resolved) {
        if (isText) {
            resolved = { contentType: 'text/plain', viewer: VIEWERS.TEXT };
            basis = 'text-sniff';
        } else {
            resolved = { contentType: 'application/octet-stream', viewer: VIEWERS.BINARY };
            basis = 'default';
        }
    }

    // A "text" verdict from the extension map is authoritative even when we have
    // no bytes yet; otherwise trust the sniff.
    let textViewers = [VIEWERS.TEXT, VIEWERS.CODE, VIEWERS.JSON, VIEWERS.XML,
        VIEWERS.YAML, VIEWERS.NDJSON, VIEWERS.MARKDOWN, VIEWERS.CSV, VIEWERS.HTML];
    if (textViewers.indexOf(resolved.viewer) !== -1) {
        isText = true;
    }

    return {
        contentType: resolved.contentType,
        storedContentType: storedContentType,
        viewer: resolved.viewer,
        monacoLanguage: resolved.monacoLanguage || null,
        inlineSafe: isInlineSafe(resolved.contentType) && !resolved.scriptable,
        scriptable: !!resolved.scriptable,
        isText: isText,
        extension: extension,
        basis: basis,
        note: resolved.note || null,
        size: input.size == null ? null : input.size
    };
}

/**
 * A Content-Disposition value. `attachment` forces a download; `inline` asks the
 * browser to render. The filename is quoted and stripped of quotes/newlines so a
 * crafted key cannot inject extra header directives.
 */
function contentDisposition(key, disposition) {
    let name = String(key || 'download').split('/').filter(Boolean).pop() || 'download';
    let safe = name.replace(/["\\\r\n]/g, '_');
    let value = (disposition === 'inline' ? 'inline' : 'attachment') + '; filename="' + safe + '"';
    // RFC 5987 form as well, so non-ASCII names survive.
    if (/[^\x20-\x7e]/.test(name)) {
        value += "; filename*=UTF-8''" + encodeURIComponent(name);
    }
    return value;
}

module.exports = {
    VIEWERS: VIEWERS,
    EXTENSION_MAP: EXTENSION_MAP,
    SIGNATURES: SIGNATURES,
    GENERIC_CONTENT_TYPES: GENERIC_CONTENT_TYPES,
    extensionOf: extensionOf,
    isGenericContentType: isGenericContentType,
    sniffSignature: sniffSignature,
    looksLikeText: looksLikeText,
    detectBom: detectBom,
    decodeText: decodeText,
    isInlineSafe: isInlineSafe,
    resolveObjectType: resolveObjectType,
    contentDisposition: contentDisposition
};
