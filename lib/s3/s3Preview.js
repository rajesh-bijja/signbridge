"use strict";

/**
 * s3Preview.js — turning object bytes into something a browser can show.
 *
 * The browser renders images, PDFs, video, audio and plain text on its own; for
 * those, S3 World just points it at the bytes with a corrected Content-Type.
 * This module handles everything else — the formats that are the actual reason
 * people give up and download the file:
 *
 *   CSV/TSV     -> columns + rows (a real delimited parser, not split(','))
 *   NDJSON      -> one row per line, union of keys as columns
 *   JSON        -> validated + pretty-printed, with a size guard
 *   Parquet     -> schema + rows, read through RANGED requests (see below)
 *   ZIP/JAR/TAR -> member listing with sizes
 *   XLSX/DOCX/PPTX -> sheet grids / document text, straight from the OOXML
 *   .ipynb      -> ordered cells with sources and text outputs
 *   anything    -> hex + ASCII dump
 *
 * Parsing happens on the SERVER, not in the browser, and that is a deliberate
 * choice rather than a convenience: a presigned URL fetched by client-side
 * JavaScript is a cross-origin request, so it needs a CORS policy on the bucket.
 * Most buckets have none, and asking a user to edit a bucket's CORS config
 * before they can look at a file would defeat the whole point. The server has no
 * such restriction, so it reads the bytes and hands the browser plain JSON.
 *
 * PARQUET AND RANGED READS — the nicest property here. hyparquet reads through
 * an "AsyncBuffer" (`{ byteLength, slice(start, end) }`), so backing that with
 * S3 range GETs means previewing the first rows of a 5 GB parquet file costs a
 * few KB: the footer, then only the column chunks actually needed. See
 * s3World.js for the S3-backed buffer.
 *
 * Every function is bounded. Row counts, cell widths, and byte budgets are all
 * capped, because "preview" must never mean "load a 10 GB object into Node".
 */

const s3ContentTypes = require('./s3ContentTypes');
const s3Xml = require('./s3Xml');
const s3Yaml = require('./s3Yaml');

// Preview budgets. Generous enough to be useful, small enough to stay snappy
// over a browser request.
const LIMITS = {
    MAX_ROWS: 500,
    MAX_COLUMNS: 200,
    MAX_CELL_CHARS: 2000,
    MAX_JSON_BYTES: 8 * 1024 * 1024,
    MAX_TEXT_CHARS: 2 * 1024 * 1024,
    MAX_ARCHIVE_ENTRIES: 2000,
    MAX_XML_NODES: 20000,
    MAX_XML_DEPTH: 256,
    MAX_YAML_NODES: 20000,
    MAX_YAML_DEPTH: 128,
    HEX_BYTES: 4096
};

// hyparquet is ESM-only and lib/ is CommonJS, so it loads through a cached
// dynamic import — the same approach server.js uses for the ESM MCP handler.
// require() of it would work on Node 22 but throw ERR_REQUIRE_ESM on the Node 20
// in the Docker image, i.e. it would fail only in production.
let hyparquetPromise = null;
function loadHyparquet() {
    if (!hyparquetPromise) {
        hyparquetPromise = import('hyparquet');
    }
    return hyparquetPromise;
}

// hyparquet handles uncompressed and Snappy on its own; GZip/Brotli/ZSTD/LZ4
// parquet — which Spark, Athena and pandas all produce — needs this add-on, or
// the read fails with an unsupported-codec error on very ordinary files.
let compressorsPromise = null;
function loadCompressors() {
    if (!compressorsPromise) {
        compressorsPromise = import('hyparquet-compressors').then(function (mod) {
            return mod.compressors;
        }).catch(function () {
            // Optional: without it, only uncompressed/Snappy parquet reads.
            return undefined;
        });
    }
    return compressorsPromise;
}

// fflate is CommonJS and small; a plain require is fine.
let fflate = null;
function loadFflate() {
    if (!fflate) {
        fflate = require('fflate');
    }
    return fflate;
}

function truncateCell(value) {
    if (value == null) {
        return null;
    }
    if (typeof value === 'string') {
        return value.length > LIMITS.MAX_CELL_CHARS
            ? value.slice(0, LIMITS.MAX_CELL_CHARS) + '…'
            : value;
    }
    if (typeof value === 'object') {
        // Nested structures (parquet structs/lists, JSON sub-objects) are shown
        // as compact JSON so a cell stays one line.
        let text = JSON.stringify(value);
        return text && text.length > LIMITS.MAX_CELL_CHARS
            ? text.slice(0, LIMITS.MAX_CELL_CHARS) + '…'
            : text;
    }
    // BigInt (parquet INT64) is not JSON-serialisable.
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

// ---------------------------------------------------------------------------
// Delimited text (CSV / TSV / PSV)
// ---------------------------------------------------------------------------

/**
 * Guess the delimiter by counting candidates outside quoted regions on the
 * first few lines. Header-only counting is unreliable — a single-column CSV of
 * sentences would look tab-delimited — so we prefer the candidate whose count is
 * both non-zero and *consistent* across lines.
 */
function detectDelimiter(text) {
    let candidates = [',', '\t', ';', '|'];
    let lines = text.split(/\r?\n/).filter(function (line) {
        return line.trim().length > 0;
    }).slice(0, 10);
    if (!lines.length) {
        return ',';
    }

    let best = ',';
    let bestScore = -1;
    candidates.forEach(function (candidate) {
        let counts = lines.map(function (line) {
            let count = 0;
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === '"') {
                    inQuotes = !inQuotes;
                } else if (!inQuotes && line[i] === candidate) {
                    count++;
                }
            }
            return count;
        });
        if (counts[0] === 0) {
            return;
        }
        // Consistency: how many lines agree with the first line's count.
        let agreeing = counts.filter(function (count) {
            return count === counts[0];
        }).length;
        let score = agreeing * 100 + counts[0];
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    });
    return best;
}

/**
 * RFC 4180 delimited parser: honours quoted fields, escaped quotes (""),
 * and newlines inside quotes. Stops after maxRows.
 *
 * @returns {{ rows: string[][], truncated: boolean, incompleteLastRow: boolean }}
 */
function parseDelimited(text, delimiter, maxRows) {
    let rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let truncated = false;
    let i = 0;

    function endField() {
        row.push(field);
        field = '';
    }
    function endRow() {
        endField();
        rows.push(row);
        row = [];
    }

    while (i < text.length) {
        let ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += ch;
            i++;
            continue;
        }
        if (ch === '"' && field.length === 0) {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === delimiter) {
            endField();
            i++;
            continue;
        }
        if (ch === '\n' || ch === '\r') {
            endRow();
            if (ch === '\r' && text[i + 1] === '\n') {
                i++;
            }
            i++;
            if (rows.length >= maxRows) {
                truncated = i < text.length;
                return { rows: rows, truncated: truncated, incompleteLastRow: false };
            }
            continue;
        }
        field += ch;
        i++;
    }

    // Trailing content with no final newline is still a row.
    let incompleteLastRow = false;
    if (field.length > 0 || row.length > 0) {
        endRow();
        // When the source text was itself a truncated byte range, the final row
        // is very likely cut mid-record; the caller flags that.
        incompleteLastRow = true;
    }

    return { rows: rows, truncated: truncated, incompleteLastRow: incompleteLastRow };
}

/**
 * Preview delimited text as a table.
 *
 * @param {string} text
 * @param {object} [options] { delimiter, maxRows, hasHeader, sourceTruncated }
 */
function previewDelimited(text, options) {
    options = options || {};
    let maxRows = options.maxRows || LIMITS.MAX_ROWS;
    let delimiter = options.delimiter || detectDelimiter(text);
    // +1 for the header row.
    let parsed = parseDelimited(text, delimiter, maxRows + 1);

    let allRows = parsed.rows;
    // A byte-range preview almost always ends mid-line. Dropping that last
    // partial row prevents a garbled final entry in the table.
    if (options.sourceTruncated && parsed.incompleteLastRow && allRows.length > 1) {
        allRows = allRows.slice(0, allRows.length - 1);
    }

    let hasHeader = options.hasHeader !== false;
    let headerRow = hasHeader && allRows.length ? allRows[0] : null;
    let dataRows = hasHeader ? allRows.slice(1) : allRows;

    let width = 0;
    allRows.forEach(function (r) {
        width = Math.max(width, r.length);
    });
    width = Math.min(width, LIMITS.MAX_COLUMNS);

    let columns = [];
    for (let c = 0; c < width; c++) {
        let name = headerRow && headerRow[c] != null && String(headerRow[c]).trim().length
            ? String(headerRow[c]).trim()
            : 'Column ' + (c + 1);
        columns.push({ name: name, index: c });
    }

    return {
        kind: 'table',
        format: delimiter === '\t' ? 'tsv' : (delimiter === ',' ? 'csv' : 'delimited'),
        delimiter: delimiter,
        columns: columns,
        rows: dataRows.slice(0, maxRows).map(function (r) {
            let out = [];
            for (let c = 0; c < width; c++) {
                out.push(truncateCell(r[c] == null ? null : r[c]));
            }
            return out;
        }),
        rowCount: dataRows.length,
        truncated: parsed.truncated || dataRows.length > maxRows || !!options.sourceTruncated,
        note: options.sourceTruncated
            ? 'Showing the first ' + Math.min(dataRows.length, maxRows) + ' rows from the start of the object.'
            : null
    };
}

// ---------------------------------------------------------------------------
// JSON / NDJSON
// ---------------------------------------------------------------------------

function previewJson(text, options) {
    options = options || {};
    if (text.length > LIMITS.MAX_JSON_BYTES) {
        return {
            kind: 'text',
            format: 'json',
            text: text.slice(0, LIMITS.MAX_TEXT_CHARS),
            truncated: true,
            // No size in the message: it would round to the budget itself and
            // read as "8 MB is over the 8 MB budget".
            note: 'This document is over the ' + formatBytes(LIMITS.MAX_JSON_BYTES) +
                ' parse budget, so it is shown as raw text rather than a tree.'
        };
    }
    try {
        let parsed = JSON.parse(text);
        return {
            kind: 'json',
            format: 'json',
            // Re-serialised with indentation: object key order is preserved and
            // the client gets something already readable.
            text: JSON.stringify(parsed, null, 2),
            valid: true,
            truncated: !!options.sourceTruncated,
            // An array of flat objects is much nicer as a table, so tell the UI
            // it has that option.
            tabular: tabulariseJson(parsed)
        };
    } catch (err) {
        return {
            kind: 'text',
            format: 'json',
            text: text.slice(0, LIMITS.MAX_TEXT_CHARS),
            valid: false,
            truncated: !!options.sourceTruncated,
            // A truncated read cannot produce a tree, so say what was read and
            // why — the object being over the read budget is the whole reason,
            // and "the JSON is incomplete" on its own reads like a broken viewer.
            note: options.sourceTruncated
                ? 'Only the first ' + formatBytes(text.length) +
                  (options.totalSize ? ' of ' + formatBytes(options.totalSize) : '') +
                  ' was read, so the JSON is incomplete and cannot be shown as a tree. ' +
                  'Download the object to read it in full.'
                : 'Not valid JSON: ' + err.message
        };
    }
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * XML as a tree, so the viewer can expand and collapse it.
 *
 * Mirrors previewJson's contract deliberately: on success the client gets
 * structure *and* the original text (so a Raw tab costs nothing); on failure it
 * degrades to the plain text viewer with a note saying why, rather than showing
 * an empty tree. See lib/s3/s3Xml.js for why the parse is hand-rolled.
 */
function previewXml(text, options) {
    options = options || {};
    let tree;
    try {
        tree = s3Xml.parseXml(text, {
            maxNodes: LIMITS.MAX_XML_NODES,
            maxDepth: LIMITS.MAX_XML_DEPTH
        });
    } catch (err) {
        return {
            kind: 'text',
            format: 'xml',
            monacoLanguage: 'xml',
            text: text.slice(0, LIMITS.MAX_TEXT_CHARS),
            valid: false,
            truncated: !!options.sourceTruncated,
            note: (options.sourceTruncated
                ? 'Only the start of this object was read. '
                : '') + 'Not well-formed XML (' + err.message + ') — showing raw text.'
        };
    }

    if (!tree.root) {
        return {
            kind: 'text',
            format: 'xml',
            monacoLanguage: 'xml',
            text: text.slice(0, LIMITS.MAX_TEXT_CHARS),
            valid: false,
            truncated: !!options.sourceTruncated,
            note: 'No XML elements found — showing raw text.'
        };
    }

    let notes = [];
    if (tree.incomplete) {
        notes.push('Only the start of this object was read, so the last elements are still open.');
    }
    if (tree.truncated) {
        notes.push('Stopped after ' + tree.nodeCount.toLocaleString() +
            ' nodes — the tree is partial.');
    }

    return {
        kind: 'xml',
        format: 'xml',
        monacoLanguage: 'xml',
        root: tree.root,
        nodeCount: tree.nodeCount,
        elementCount: tree.elementCount,
        declaration: tree.declaration,
        // Kept so the Raw tab and Copy need no second request.
        text: text,
        valid: true,
        truncated: tree.truncated || tree.incomplete || !!options.sourceTruncated,
        note: notes.length ? notes.join(' ') : null
    };
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/**
 * YAML as a tree. Same contract as previewXml — see lib/s3/s3Yaml.js for why the
 * parse keeps every scalar as source text instead of decoding it.
 */
function previewYaml(text, options) {
    options = options || {};
    let tree;
    try {
        tree = s3Yaml.parseYaml(text, {
            maxNodes: LIMITS.MAX_YAML_NODES,
            maxDepth: LIMITS.MAX_YAML_DEPTH
        });
    } catch (err) {
        return {
            kind: 'text',
            format: 'yaml',
            monacoLanguage: 'yaml',
            text: text.slice(0, LIMITS.MAX_TEXT_CHARS),
            valid: false,
            truncated: !!options.sourceTruncated,
            note: 'Could not parse as YAML (' + err.message + ') — showing raw text.'
        };
    }

    if (!tree.documents.length) {
        return {
            kind: 'text',
            format: 'yaml',
            monacoLanguage: 'yaml',
            text: text.slice(0, LIMITS.MAX_TEXT_CHARS),
            valid: false,
            truncated: !!options.sourceTruncated,
            note: 'No YAML structure found — showing raw text.'
        };
    }

    let notes = [];
    if (options.sourceTruncated) {
        notes.push('Only the start of this object was read, so the tree is partial.');
    }
    if (tree.truncated) {
        notes.push('Stopped after ' + tree.nodeCount.toLocaleString() +
            ' nodes — the tree is partial.');
    }

    return {
        kind: 'yaml',
        format: 'yaml',
        monacoLanguage: 'yaml',
        documents: tree.documents,
        nodeCount: tree.nodeCount,
        text: text,
        valid: true,
        truncated: tree.truncated || !!options.sourceTruncated,
        note: notes.length ? notes.join(' ') : null
    };
}

/**
 * If the value is an array of objects, produce a columns/rows view of it.
 * Returns null when a table would not make sense.
 */
function tabulariseJson(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }
    let objects = value.slice(0, LIMITS.MAX_ROWS);
    let allObjects = objects.every(function (entry) {
        return entry && typeof entry === 'object' && !Array.isArray(entry);
    });
    if (!allObjects) {
        return null;
    }
    return buildRowsFromObjects(objects, value.length);
}

/**
 * Columns are the union of keys across the sampled rows, in first-seen order —
 * NDJSON and JSON arrays routinely have optional fields, and taking only the
 * first record's keys would silently hide columns.
 */
function buildRowsFromObjects(objects, totalCount) {
    let columns = [];
    let seen = Object.create(null);
    objects.forEach(function (entry) {
        Object.keys(entry).forEach(function (key) {
            if (!seen[key] && columns.length < LIMITS.MAX_COLUMNS) {
                seen[key] = true;
                columns.push({ name: key, index: columns.length });
            }
        });
    });
    return {
        columns: columns,
        rows: objects.map(function (entry) {
            return columns.map(function (column) {
                return truncateCell(entry[column.name] === undefined ? null : entry[column.name]);
            });
        }),
        rowCount: totalCount == null ? objects.length : totalCount,
        truncated: (totalCount || objects.length) > objects.length
    };
}

function previewNdjson(text, options) {
    options = options || {};
    let lines = text.split(/\r?\n/);
    // A ranged read cuts the last line in half; drop it rather than reporting a
    // parse error the object does not actually have.
    if (options.sourceTruncated && lines.length > 1) {
        lines.pop();
    }
    let objects = [];
    let errors = 0;
    let scanned = 0;
    for (let i = 0; i < lines.length && objects.length < LIMITS.MAX_ROWS; i++) {
        let line = lines[i].trim();
        if (!line) {
            continue;
        }
        scanned++;
        try {
            let parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                objects.push(parsed);
            } else {
                objects.push({ value: parsed });
            }
        } catch (err) {
            errors++;
        }
    }
    if (!objects.length) {
        return {
            kind: 'text',
            format: 'ndjson',
            text: text.slice(0, LIMITS.MAX_TEXT_CHARS),
            note: 'No parsable JSON lines found — showing raw text.'
        };
    }
    let table = buildRowsFromObjects(objects, null);
    return Object.assign({ kind: 'table', format: 'ndjson' }, table, {
        truncated: !!options.sourceTruncated || objects.length >= LIMITS.MAX_ROWS,
        note: errors > 0 ? errors + ' of ' + scanned + ' lines could not be parsed as JSON.' : null
    });
}

// ---------------------------------------------------------------------------
// Parquet
// ---------------------------------------------------------------------------

/**
 * Preview a parquet file through an AsyncBuffer, so only the footer and the
 * needed column chunks are fetched.
 *
 * @param {object} asyncBuffer  { byteLength, slice(start, end) -> Promise<ArrayBuffer> }
 * @param {object} [options] { maxRows }
 * @returns {Promise<object>}
 */
async function previewParquet(asyncBuffer, options) {
    options = options || {};
    let maxRows = options.maxRows || LIMITS.MAX_ROWS;
    let hyparquet = await loadHyparquet();
    let compressors = await loadCompressors();

    let metadata = await hyparquet.parquetMetadataAsync(asyncBuffer);
    let schema = hyparquet.parquetSchema(metadata);
    let totalRows = Number(metadata.num_rows);
    let rowEnd = Math.min(totalRows, maxRows);

    // schema.children are the top-level columns. Nested groups are reported by
    // name with their physical type left null — the row values still show the
    // nested structure as JSON.
    let columns = (schema.children || []).map(function (child, index) {
        let element = child.element || {};
        return {
            name: element.name,
            index: index,
            type: element.converted_type || element.logical_type || element.type || null,
            optional: element.repetition_type === 'OPTIONAL'
        };
    }).slice(0, LIMITS.MAX_COLUMNS);

    let rows = [];
    if (rowEnd > 0) {
        let objects = await hyparquet.parquetReadObjects({
            file: asyncBuffer,
            metadata: metadata,
            compressors: compressors,
            rowStart: 0,
            rowEnd: rowEnd
        });
        rows = objects.map(function (entry) {
            return columns.map(function (column) {
                return truncateCell(entry[column.name] === undefined ? null : entry[column.name]);
            });
        });
    }

    // Row groups tell the user how the file is laid out — useful when deciding
    // whether a query engine will scan it efficiently.
    let rowGroups = (metadata.row_groups || []).length;
    let compression = null;
    if (metadata.row_groups && metadata.row_groups[0] && metadata.row_groups[0].columns &&
        metadata.row_groups[0].columns[0] && metadata.row_groups[0].columns[0].meta_data) {
        compression = metadata.row_groups[0].columns[0].meta_data.codec || null;
    }

    return {
        kind: 'table',
        format: 'parquet',
        columns: columns,
        rows: rows,
        rowCount: totalRows,
        truncated: totalRows > rowEnd,
        metadata: {
            rowGroups: rowGroups,
            createdBy: metadata.created_by || null,
            compression: compression,
            columnCount: (schema.children || []).length,
            keyValueMetadata: (metadata.key_value_metadata || []).reduce(function (acc, entry) {
                if (entry && entry.key) {
                    acc[entry.key] = entry.value;
                }
                return acc;
            }, {})
        },
        note: totalRows > rowEnd
            ? 'Showing the first ' + rowEnd + ' of ' + totalRows.toLocaleString('en-US') + ' rows.'
            : null
    };
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

/**
 * List the members of a ZIP-family archive (zip, jar, and the OOXML formats,
 * which are all ZIPs). Only the central directory is decoded, so member bodies
 * are never inflated.
 */
function previewZip(buffer) {
    let entries = [];
    let truncated = false;
    try {
        let unzipped = loadFflate().unzipSync(new Uint8Array(buffer), {
            // A filter that always returns false still walks the directory, so we
            // get the listing without inflating a single member.
            filter: function (file) {
                if (entries.length >= LIMITS.MAX_ARCHIVE_ENTRIES) {
                    truncated = true;
                    return false;
                }
                entries.push({
                    name: file.name,
                    size: file.originalSize == null ? null : file.originalSize,
                    compressedSize: file.compressedSize == null ? null : file.compressedSize,
                    isDirectory: /\/$/.test(file.name)
                });
                return false;
            }
        });
        void unzipped;
    } catch (err) {
        return {
            kind: 'error',
            format: 'zip',
            message: 'Could not read the archive directory: ' + err.message
        };
    }
    return {
        kind: 'archive',
        format: 'zip',
        entries: entries,
        entryCount: entries.length,
        truncated: truncated,
        note: 'Archive contents are listed, not extracted.'
    };
}

/**
 * List the members of a tar archive. Worth doing by hand — it is ~50 lines of
 * fixed-offset header reading and no dependency, and `.tar.gz` is how model
 * artifacts, Lambda bundles and log batches actually arrive in S3. Without this,
 * `foo.tar.gz` decompresses to a tar and then shows as a hex dump, which is a
 * strange place for the feature to give up.
 *
 * Only headers are read; member bodies are skipped over, never decoded.
 */
function previewTar(buffer) {
    const BLOCK = 512;
    let entries = [];
    let truncated = false;
    let offset = 0;
    // A GNU 'L' record carries the next entry's name when it exceeds 100 chars.
    let pendingLongName = null;

    function field(start, length) {
        let end = offset + start + length;
        let raw = buffer.slice(offset + start, Math.min(end, buffer.length)).toString('latin1');
        let nul = raw.indexOf('\0');
        return (nul === -1 ? raw : raw.slice(0, nul)).trim();
    }

    while (offset + BLOCK <= buffer.length) {
        let name = field(0, 100);
        if (!name && !field(345, 155)) {
            // Two zero blocks mark the end; a single one is enough to stop.
            break;
        }
        let sizeOctal = field(124, 12).replace(/[^0-7]/g, '');
        let size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
        if (!isFinite(size) || size < 0) {
            break;
        }
        let typeFlag = field(156, 1) || '0';
        let prefix = field(345, 155);
        let dataBlocks = Math.ceil(size / BLOCK) * BLOCK;

        if (typeFlag === 'L') {
            // The body is the long name for the entry that follows.
            pendingLongName = buffer
                .slice(offset + BLOCK, Math.min(offset + BLOCK + size, buffer.length))
                .toString('utf8')
                .replace(/\0+$/, '');
            offset += BLOCK + dataBlocks;
            continue;
        }
        if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'K') {
            // pax/GNU metadata records describe the next entry; skip them.
            offset += BLOCK + dataBlocks;
            continue;
        }

        if (entries.length >= LIMITS.MAX_ARCHIVE_ENTRIES) {
            truncated = true;
            break;
        }
        let fullName = pendingLongName || (prefix ? prefix + '/' + name : name);
        pendingLongName = null;
        entries.push({
            name: fullName,
            size: size,
            compressedSize: null,
            isDirectory: typeFlag === '5' || /\/$/.test(fullName)
        });
        offset += BLOCK + dataBlocks;
    }

    if (!entries.length) {
        return {
            kind: 'error',
            format: 'tar',
            message: 'No tar members found — the archive may be truncated or not a tar.'
        };
    }
    return {
        kind: 'archive',
        format: 'tar',
        entries: entries,
        entryCount: entries.length,
        truncated: truncated,
        note: 'Archive contents are listed, not extracted.'
    };
}

/**
 * gzip of a single file: inflate a bounded amount and preview what is inside.
 * Very common for S3 logs (`.log.gz`, `.json.gz`).
 */
function previewGzip(buffer, key) {
    let inflated;
    try {
        inflated = loadFflate().gunzipSync(new Uint8Array(buffer));
    } catch (err) {
        return {
            kind: 'error',
            format: 'gzip',
            message: 'Could not decompress: ' + err.message +
                (buffer.length < 1024 ? '' : ' (a ranged read of a gzip stream cannot be decompressed — try the full object)')
        };
    }
    let inner = Buffer.from(inflated);
    // Strip the .gz so the inner type is resolved from the real extension.
    let innerKey = String(key || '').replace(/\.(gz|tgz)$/i, '');
    if (/\.tgz$/i.test(String(key || ''))) {
        innerKey = innerKey + '.tar';
    }
    let innerType = s3ContentTypes.resolveObjectType({
        key: innerKey,
        head: inner.slice(0, 4096),
        size: inner.length
    });
    let nested = previewBuffer(inner, {
        key: innerKey,
        resolvedType: innerType,
        sourceTruncated: false
    });
    return Object.assign({}, nested, {
        decompressedFrom: 'gzip',
        decompressedSize: inner.length,
        note: 'Decompressed from gzip (' + formatBytes(buffer.length) + ' → ' + formatBytes(inner.length) + ').'
    });
}

// ---------------------------------------------------------------------------
// OOXML (xlsx / docx / pptx)
// ---------------------------------------------------------------------------
//
// These are ZIP containers of XML. Reading them directly with fflate avoids
// taking on `xlsx`: the only version published to npm is 0.18.5, which carries a
// known prototype-pollution advisory (CVE-2023-30533) and is exactly the kind of
// thing you do not want parsing untrusted files from someone's bucket. The
// trade-off is honest and stated in the UI — this extracts *values and text*,
// not formatting, formulas, charts or images.

function decodeXmlEntities(text) {
    return String(text)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, function (m, code) {
            return String.fromCharCode(parseInt(code, 10));
        })
        .replace(/&#x([0-9a-f]+);/gi, function (m, code) {
            return String.fromCharCode(parseInt(code, 16));
        })
        // Ampersand last, so &amp;lt; does not become <.
        .replace(/&amp;/g, '&');
}

/** Convert an A1-style cell reference to a zero-based column index. */
function columnIndexFromRef(ref) {
    let letters = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
    if (!letters) {
        return null;
    }
    let index = 0;
    let text = letters[1];
    for (let i = 0; i < text.length; i++) {
        index = index * 26 + (text.charCodeAt(i) - 64);
    }
    return index - 1;
}

function previewXlsx(buffer) {
    let files;
    try {
        files = loadFflate().unzipSync(new Uint8Array(buffer), {
            filter: function (file) {
                return file.name === 'xl/sharedStrings.xml' ||
                    file.name === 'xl/workbook.xml' ||
                    /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name);
            }
        });
    } catch (err) {
        return { kind: 'error', format: 'xlsx', message: 'Not a readable .xlsx: ' + err.message };
    }

    let decoder = function (name) {
        return files[name] ? Buffer.from(files[name]).toString('utf8') : null;
    };

    // Shared strings: xlsx stores most text once, and cells reference it by index.
    let sharedStrings = [];
    let sharedXml = decoder('xl/sharedStrings.xml');
    if (sharedXml) {
        let siMatches = sharedXml.match(/<si>[\s\S]*?<\/si>/g) || [];
        sharedStrings = siMatches.map(function (si) {
            // A string can be split across multiple <t> runs (rich text).
            let runs = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
            return runs.map(function (run) {
                return decodeXmlEntities(run.replace(/<t[^>]*>/, '').replace(/<\/t>/, ''));
            }).join('');
        });
    }

    // Sheet names, in workbook order.
    let sheetNames = [];
    let workbookXml = decoder('xl/workbook.xml');
    if (workbookXml) {
        let nameMatches = workbookXml.match(/<sheet[^>]*name="([^"]*)"/g) || [];
        sheetNames = nameMatches.map(function (entry) {
            let match = /name="([^"]*)"/.exec(entry);
            return match ? decodeXmlEntities(match[1]) : '';
        });
    }

    let sheetFileNames = Object.keys(files).filter(function (name) {
        return /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    }).sort(function (a, b) {
        let na = parseInt(/(\d+)/.exec(a)[1], 10);
        let nb = parseInt(/(\d+)/.exec(b)[1], 10);
        return na - nb;
    });

    let sheets = sheetFileNames.map(function (fileName, sheetIndex) {
        let xml = Buffer.from(files[fileName]).toString('utf8');
        let rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
        let truncated = rowMatches.length > LIMITS.MAX_ROWS + 1;
        let grid = [];
        let width = 0;

        rowMatches.slice(0, LIMITS.MAX_ROWS + 1).forEach(function (rowXml) {
            let cells = rowXml.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || [];
            let row = [];
            cells.forEach(function (cellXml) {
                let refMatch = /r="([A-Z]+\d+)"/.exec(cellXml);
                let columnIndex = refMatch ? columnIndexFromRef(refMatch[1]) : row.length;
                if (columnIndex == null || columnIndex >= LIMITS.MAX_COLUMNS) {
                    return;
                }
                let typeMatch = /t="([^"]*)"/.exec(cellXml);
                let type = typeMatch ? typeMatch[1] : 'n';
                let value = null;

                if (type === 'inlineStr') {
                    let runs = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
                    value = runs.map(function (run) {
                        return decodeXmlEntities(run.replace(/<t[^>]*>/, '').replace(/<\/t>/, ''));
                    }).join('');
                } else {
                    let vMatch = /<v>([\s\S]*?)<\/v>/.exec(cellXml);
                    let raw = vMatch ? decodeXmlEntities(vMatch[1]) : null;
                    if (type === 's') {
                        // Shared-string index.
                        let index = parseInt(raw, 10);
                        value = sharedStrings[index] == null ? null : sharedStrings[index];
                    } else if (type === 'b') {
                        value = raw === '1';
                    } else {
                        value = raw;
                    }
                }
                row[columnIndex] = truncateCell(value);
            });
            width = Math.max(width, row.length);
            grid.push(row);
        });

        // First row as the header, matching how spreadsheets are almost always used.
        let headerRow = grid.length ? grid[0] : [];
        let columns = [];
        for (let c = 0; c < width; c++) {
            let name = headerRow[c] != null && String(headerRow[c]).trim().length
                ? String(headerRow[c])
                : 'Column ' + (c + 1);
            columns.push({ name: name, index: c });
        }
        let dataRows = grid.slice(1).map(function (row) {
            let out = [];
            for (let c = 0; c < width; c++) {
                out.push(row[c] === undefined ? null : row[c]);
            }
            return out;
        });

        return {
            name: sheetNames[sheetIndex] || 'Sheet ' + (sheetIndex + 1),
            columns: columns,
            rows: dataRows,
            rowCount: dataRows.length,
            truncated: truncated
        };
    });

    if (!sheets.length) {
        return { kind: 'error', format: 'xlsx', message: 'No worksheets found in this workbook.' };
    }

    return {
        kind: 'sheets',
        format: 'xlsx',
        sheets: sheets,
        note: 'Cell values only — formatting, formulas and charts are not rendered.'
    };
}

/**
 * docx / pptx: pull the text out of the document XML. Paragraph and slide
 * boundaries are preserved so the result reads as prose rather than one blob.
 */
function previewOoxmlText(buffer, format) {
    let wanted = format === 'docx'
        ? function (file) { return file.name === 'word/document.xml'; }
        : function (file) { return /^ppt\/slides\/slide\d+\.xml$/.test(file.name); };

    let files;
    try {
        files = loadFflate().unzipSync(new Uint8Array(buffer), { filter: wanted });
    } catch (err) {
        return { kind: 'error', format: format, message: 'Not a readable .' + format + ': ' + err.message };
    }

    let names = Object.keys(files).sort(function (a, b) {
        let na = /(\d+)/.exec(a);
        let nb = /(\d+)/.exec(b);
        return na && nb ? parseInt(na[1], 10) - parseInt(nb[1], 10) : a.localeCompare(b);
    });
    if (!names.length) {
        return { kind: 'error', format: format, message: 'No document body found.' };
    }

    let sections = names.map(function (name, index) {
        let xml = Buffer.from(files[name]).toString('utf8');
        // <w:p> / <a:p> are paragraphs; <w:t> / <a:t> hold the runs of text.
        let paragraphs = (xml.match(/<(?:w|a):p(?:\s[^>]*)?>[\s\S]*?<\/(?:w|a):p>/g) || []).map(function (para) {
            let runs = para.match(/<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>/g) || [];
            return runs.map(function (run) {
                return decodeXmlEntities(run.replace(/<(?:w|a):t(?:\s[^>]*)?>/, '').replace(/<\/(?:w|a):t>/, ''));
            }).join('');
        }).filter(function (text) {
            return text.trim().length > 0;
        });
        return {
            title: format === 'pptx' ? 'Slide ' + (index + 1) : null,
            paragraphs: paragraphs
        };
    });

    let totalText = sections.reduce(function (sum, section) {
        return sum + section.paragraphs.join('\n').length;
    }, 0);

    return {
        kind: 'document',
        format: format,
        sections: sections,
        characterCount: totalText,
        note: 'Text content only — images, tables and formatting are not rendered.'
    };
}

// ---------------------------------------------------------------------------
// Jupyter notebooks
// ---------------------------------------------------------------------------

function previewNotebook(text) {
    let notebook;
    try {
        notebook = JSON.parse(text);
    } catch (err) {
        return { kind: 'error', format: 'ipynb', message: 'Not a valid notebook: ' + err.message };
    }
    let language = (notebook.metadata && notebook.metadata.kernelspec &&
        notebook.metadata.kernelspec.language) || 'python';

    let cells = (notebook.cells || []).slice(0, 200).map(function (cell, index) {
        let source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
        // Only text-shaped outputs are carried through; image payloads are named
        // rather than inlined, so the response stays small.
        let outputs = (cell.outputs || []).map(function (output) {
            if (output.output_type === 'stream') {
                return {
                    type: 'stream',
                    text: Array.isArray(output.text) ? output.text.join('') : String(output.text || '')
                };
            }
            if (output.output_type === 'error') {
                return {
                    type: 'error',
                    text: [output.ename, output.evalue].filter(Boolean).join(': ')
                };
            }
            let data = output.data || {};
            if (data['text/plain']) {
                return {
                    type: 'result',
                    text: Array.isArray(data['text/plain']) ? data['text/plain'].join('') : String(data['text/plain'])
                };
            }
            let imageKey = Object.keys(data).find(function (key) {
                return key.indexOf('image/') === 0;
            });
            if (imageKey) {
                return { type: 'image', text: '[' + imageKey + ' output]' };
            }
            return { type: output.output_type || 'output', text: '' };
        });
        return {
            index: index,
            cellType: cell.cell_type || 'code',
            source: source.length > LIMITS.MAX_CELL_CHARS * 5
                ? source.slice(0, LIMITS.MAX_CELL_CHARS * 5) + '\n…'
                : source,
            executionCount: cell.execution_count == null ? null : cell.execution_count,
            outputs: outputs
        };
    });

    return {
        kind: 'notebook',
        format: 'ipynb',
        language: language,
        cells: cells,
        cellCount: (notebook.cells || []).length,
        truncated: (notebook.cells || []).length > cells.length
    };
}

// ---------------------------------------------------------------------------
// Binary fallback
// ---------------------------------------------------------------------------

/**
 * Classic hex dump: offset, 16 bytes of hex, then the printable ASCII. The
 * honest answer for a format we cannot decode, and often enough to identify one.
 */
function hexDump(buffer, options) {
    options = options || {};
    let limit = Math.min(buffer.length, options.maxBytes || LIMITS.HEX_BYTES);
    let lines = [];
    for (let offset = 0; offset < limit; offset += 16) {
        let slice = buffer.slice(offset, Math.min(offset + 16, limit));
        let hex = [];
        let ascii = '';
        for (let i = 0; i < 16; i++) {
            if (i < slice.length) {
                hex.push(slice[i].toString(16).padStart(2, '0'));
                ascii += (slice[i] >= 0x20 && slice[i] < 0x7f) ? String.fromCharCode(slice[i]) : '.';
            } else {
                hex.push('  ');
                ascii += ' ';
            }
        }
        lines.push({
            offset: offset.toString(16).padStart(8, '0'),
            hex: hex.slice(0, 8).join(' ') + '  ' + hex.slice(8).join(' '),
            ascii: ascii
        });
    }
    return {
        kind: 'hex',
        format: 'binary',
        lines: lines,
        bytesShown: limit,
        truncated: buffer.length > limit
    };
}

function formatBytes(bytes) {
    if (bytes == null) {
        return 'unknown';
    }
    let units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Build a preview from bytes already in hand. Synchronous — the parquet path is
 * async and handled separately by the caller, because it reads from S3 itself.
 *
 * @param {Buffer} buffer
 * @param {object} options { key, resolvedType, sourceTruncated, totalSize }
 */
function previewBuffer(buffer, options) {
    options = options || {};
    let type = options.resolvedType || s3ContentTypes.resolveObjectType({
        key: options.key,
        head: buffer.slice(0, 4096),
        size: buffer.length
    });
    let viewers = s3ContentTypes.VIEWERS;

    // Archives first: a .json.gz is a gzip, not JSON, and the extension map
    // resolves it to the archive viewer.
    //
    // Dispatch on the resolved *contentType*, not the extension: the resolver may
    // have identified the format from magic bytes, in which case the extension is
    // whatever unhelpful thing the file was named (a Tableau .twbx is a zip, and
    // plenty of objects have no extension at all).
    if (type.viewer === viewers.ARCHIVE) {
        if (type.contentType === 'application/gzip') {
            return previewGzip(buffer, options.key);
        }
        if (type.contentType === 'application/zip' ||
            type.contentType === 'application/java-archive') {
            return previewZip(buffer);
        }
        if (type.contentType === 'application/x-tar') {
            return previewTar(buffer);
        }
        return Object.assign(hexDump(buffer, options), {
            note: (type.extension ? '.' + type.extension : 'These') +
                ' archives are not expanded — showing a hex preview. Download to extract.'
        });
    }

    if (type.viewer === viewers.OFFICE) {
        if (/spreadsheetml\.sheet$/.test(type.contentType)) {
            return previewXlsx(buffer);
        }
        if (/wordprocessingml\.document$/.test(type.contentType)) {
            return previewOoxmlText(buffer, 'docx');
        }
        if (/presentationml\.presentation$/.test(type.contentType)) {
            return previewOoxmlText(buffer, 'pptx');
        }
        return Object.assign(hexDump(buffer, options), {
            note: 'Legacy Office formats (.' + type.extension + ') are binary — download to open.'
        });
    }

    if (type.viewer === viewers.BINARY || !type.isText) {
        return Object.assign(hexDump(buffer, options), { note: type.note || null });
    }

    // From here on the content is text.
    let decoded = s3ContentTypes.decodeText(buffer);
    let text = decoded.text.length > LIMITS.MAX_TEXT_CHARS
        ? decoded.text.slice(0, LIMITS.MAX_TEXT_CHARS)
        : decoded.text;
    let textTruncated = decoded.text.length > LIMITS.MAX_TEXT_CHARS || !!options.sourceTruncated;

    if (type.viewer === viewers.CSV) {
        return Object.assign(previewDelimited(text, {
            sourceTruncated: options.sourceTruncated,
            delimiter: type.extension === 'tsv' ? '\t' : (type.extension === 'psv' ? '|' : null)
        }), { encoding: decoded.encoding });
    }
    if (type.viewer === viewers.NDJSON) {
        return Object.assign(previewNdjson(text, options), { encoding: decoded.encoding });
    }
    if (type.viewer === viewers.NOTEBOOK) {
        return Object.assign(previewNotebook(text), { encoding: decoded.encoding });
    }
    if (type.viewer === viewers.JSON) {
        // The full decoded text, not the MAX_TEXT_CHARS slice the text viewer
        // gets: JSON parses as a whole document or not at all, and previewJson
        // has its own (larger) budget. Slicing first would report a complete
        // object as incomplete and drop the tree.
        return Object.assign(previewJson(decoded.text, options), { encoding: decoded.encoding });
    }
    if (type.viewer === viewers.XML) {
        return Object.assign(previewXml(text, options), { encoding: decoded.encoding });
    }
    if (type.viewer === viewers.YAML) {
        return Object.assign(previewYaml(text, options), { encoding: decoded.encoding });
    }
    if (type.viewer === viewers.MARKDOWN) {
        return {
            kind: 'markdown',
            format: 'markdown',
            text: text,
            truncated: textTruncated,
            encoding: decoded.encoding
        };
    }
    if (type.viewer === viewers.HTML) {
        return {
            kind: 'html',
            format: 'html',
            text: text,
            truncated: textTruncated,
            encoding: decoded.encoding,
            // The client renders this in a sandboxed iframe, never inline.
            note: 'HTML is rendered in an isolated frame with scripts disabled.'
        };
    }

    // A last upgrade before giving up and showing lines: text whose *content* is a
    // JSON document gets the JSON tree. Plenty of real objects carry a JSON body
    // under an extension that says nothing — a CloudFormation `.template`, a
    // `.cfg`, no extension at all — and for those the extension map can only say
    // "text". This costs one parse attempt of an already-decoded string, and a
    // failure falls straight through.
    if ((type.viewer === viewers.TEXT || type.viewer === viewers.CODE) &&
        /^[[{]/.test(text.trimStart())) {
        let asJson = previewJson(decoded.text, options);
        if (asJson.kind === 'json') {
            return Object.assign(asJson, { encoding: decoded.encoding });
        }
    }

    return {
        kind: 'text',
        format: type.monacoLanguage || 'plaintext',
        monacoLanguage: type.monacoLanguage || 'plaintext',
        text: text,
        truncated: textTruncated,
        encoding: decoded.encoding,
        note: options.sourceTruncated
            ? 'Showing the first ' + formatBytes(buffer.length) +
              (options.totalSize ? ' of ' + formatBytes(options.totalSize) : '') + '.'
            : null
    };
}

module.exports = {
    LIMITS: LIMITS,
    detectDelimiter: detectDelimiter,
    parseDelimited: parseDelimited,
    previewDelimited: previewDelimited,
    previewJson: previewJson,
    previewXml: previewXml,
    previewYaml: previewYaml,
    previewNdjson: previewNdjson,
    previewParquet: previewParquet,
    previewZip: previewZip,
    previewTar: previewTar,
    previewGzip: previewGzip,
    previewXlsx: previewXlsx,
    previewOoxmlText: previewOoxmlText,
    previewNotebook: previewNotebook,
    previewBuffer: previewBuffer,
    buildRowsFromObjects: buildRowsFromObjects,
    tabulariseJson: tabulariseJson,
    hexDump: hexDump,
    formatBytes: formatBytes,
    columnIndexFromRef: columnIndexFromRef,
    decodeXmlEntities: decodeXmlEntities
};
