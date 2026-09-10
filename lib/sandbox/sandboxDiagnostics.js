"use strict";

/**
 * sandboxDiagnostics.js
 *
 * Turns raw compiler / interpreter output into structured editor markers so the
 * Sandbox IDE can underline the exact offending span and offer a remedy —
 * instead of dumping a stack trace in a console and leaving the user to read it.
 *
 * Two entry points:
 *
 *   parseCheckDiagnostics(runtimeId, output)   - output of the runtime's
 *       checkArgv (py_compile / node --check / tsc --noEmit / javac). This is
 *       what powers the red squiggles and the "Validate" action.
 *
 *   parseRuntimeDiagnostics(runtimeId, output) - output of a failed RUN. Maps a
 *       traceback / stack trace back to the line in the user's file, so a
 *       runtime error also highlights its source line.
 *
 * Everything here is PURE: string in, array of markers out. No fs, no network,
 * no child processes — see test/sandboxDiagnostics.test.js. Keep it that way;
 * when adding a language, add a parser here and test it against real captured
 * output rather than mocking a container.
 *
 * Marker shape (1-based line/column, matching Monaco's convention):
 *   { line, column, endLine, endColumn, severity, message, code, source, remedy }
 *
 * `remedy` is attached by sandboxRemedies.js and may be null.
 */

const remedies = require('./sandboxRemedies');
const sandboxRuntimes = require('./sandboxRuntimes');
let log = require('../logger').create('sandbox/sandboxDiagnostics');

const SEVERITY_ERROR = 'error';
const SEVERITY_WARNING = 'warning';

// Cap how many markers we return. A single missing brace can cascade into
// hundreds of diagnostics; the first handful are the actionable ones and an
// unbounded list would bloat the response and the editor gutter.
const MAX_DIAGNOSTICS = 50;

function toInt(value, fallback) {
    let parsed = parseInt(value, 10);
    return isNaN(parsed) ? fallback : parsed;
}

/**
 * Build a marker, normalising line/column and attaching a remedy.
 * Columns are clamped to >= 1 because some compilers report column 0.
 */
function makeMarker(fields) {
    let line = Math.max(1, toInt(fields.line, 1));
    let column = Math.max(1, toInt(fields.column, 1));
    let marker = {
        line: line,
        column: column,
        endLine: Math.max(line, toInt(fields.endLine, line)),
        endColumn: Math.max(column + 1, toInt(fields.endColumn, column + 1)),
        severity: fields.severity || SEVERITY_ERROR,
        message: (fields.message || '').trim(),
        code: fields.code || null,
        source: fields.source || null
    };
    marker.remedy = remedies.suggestRemedy(marker, fields.runtimeId);
    return marker;
}

/**
 * True when a diagnostic's file path refers to the user's own file rather than
 * a library. Only the user's file exists in the workspace, so anything else is
 * SDK-internal noise we must not try to mark up.
 */
function isUserFile(filePath, runtimeId) {
    if (!filePath) {
        return false;
    }
    let runtime = sandboxRuntimes.getRuntime(runtimeId);
    if (!runtime) {
        return false;
    }
    return filePath.indexOf(runtime.fileName) !== -1;
}

/**
 * Column from a caret/marker line, e.g. "        ^" or "     ^^^^".
 * Returns { column, endColumn } or null. Tabs count as one column, matching how
 * these tools emit the caret against the source line.
 */
function columnFromCaretLine(caretLine) {
    if (!caretLine) {
        return null;
    }
    let caretIndex = caretLine.indexOf('^');
    if (caretIndex === -1) {
        return null;
    }
    let carets = caretLine.slice(caretIndex).match(/^\^+/);
    let width = carets ? carets[0].length : 1;
    return { column: caretIndex + 1, endColumn: caretIndex + 1 + width };
}

// ---------------------------------------------------------------------------
// Python: py_compile / SyntaxError, and runtime tracebacks
// ---------------------------------------------------------------------------
//
//   File "/workspace/main.py", line 3
//     print("hello"
//                  ^
//   SyntaxError: '(' was never closed
//
const PYTHON_FILE_LINE = /^\s*File "([^"]+)", line (\d+)/;
const PYTHON_ERROR_LINE = /^\s*([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Warning|Interrupt))\s*:\s*(.*)$/;

function parsePython(output, runtimeId) {
    let lines = String(output).split(/\r?\n/);
    let markers = [];
    // Remember the most recent "File ..., line N" that points at the user's
    // file. In a traceback the LAST such frame is the one to highlight, and the
    // error message arrives after it.
    let pending = null;

    for (let i = 0; i < lines.length; i += 1) {
        let fileMatch = lines[i].match(PYTHON_FILE_LINE);
        if (fileMatch) {
            if (isUserFile(fileMatch[1], runtimeId)) {
                pending = { line: toInt(fileMatch[2], 1), column: 1, endColumn: null };
                // A caret may follow the echoed source line.
                let caret = columnFromCaretLine(lines[i + 2]) || columnFromCaretLine(lines[i + 1]);
                if (caret) {
                    pending.column = caret.column;
                    pending.endColumn = caret.endColumn;
                }
            } else {
                // A frame inside a library: keep any earlier user frame.
                pending = pending || null;
            }
            continue;
        }

        let errorMatch = lines[i].match(PYTHON_ERROR_LINE);
        if (errorMatch && pending) {
            markers.push(makeMarker({
                line: pending.line,
                column: pending.column,
                endColumn: pending.endColumn,
                severity: SEVERITY_ERROR,
                message: errorMatch[1] + ': ' + errorMatch[2],
                code: errorMatch[1],
                source: 'python',
                runtimeId: runtimeId
            }));
            pending = null;
        }
    }

    return markers;
}

// ---------------------------------------------------------------------------
// Node: `node --check` syntax errors and runtime stack traces
// ---------------------------------------------------------------------------
//
//   /workspace/main.mjs:3
//   console.log('x'
//                  ^
//
//   SyntaxError: missing ) after argument list
//
// Runtime traces instead look like:
//   at file:///workspace/main.mjs:5:11
//
// Both the header and the frames of an ES-module error are file:// URLs rather
// than bare paths, and a top-frame ESM location has no parenthesised call site
// ("    at file:///workspace/main.mjs:2:27"). Both forms have to be accepted or a
// runtime error in the most-used language produces no marker at all.
const NODE_HEADER_LINE = /^(?:file:\/\/)?(\/[^\s:]+):(\d+)$/;
const NODE_ERROR_LINE = /^\s*([A-Za-z_$][\w$]*(?:Error|Exception))\s*:\s*(.*)$/;
const NODE_STACK_FRAME = /(?:^|\s|\()(?:file:\/\/)?(\/[^\s:()]+):(\d+):(\d+)/;

function parseNode(output, runtimeId) {
    let lines = String(output).split(/\r?\n/);
    let markers = [];
    let pending = null;

    for (let i = 0; i < lines.length; i += 1) {
        let header = lines[i].match(NODE_HEADER_LINE);
        if (header && isUserFile(header[1], runtimeId)) {
            pending = { line: toInt(header[2], 1), column: 1, endColumn: null };
            let caret = columnFromCaretLine(lines[i + 2]) || columnFromCaretLine(lines[i + 1]);
            if (caret) {
                pending.column = caret.column;
                pending.endColumn = caret.endColumn;
            }
            continue;
        }

        // A stack frame gives line AND column directly.
        let frame = lines[i].match(NODE_STACK_FRAME);
        if (frame && isUserFile(frame[1], runtimeId) && !pending) {
            pending = {
                line: toInt(frame[2], 1),
                column: toInt(frame[3], 1),
                endColumn: null,
                fromFrame: true
            };
            continue;
        }

        let errorMatch = lines[i].match(NODE_ERROR_LINE);
        if (errorMatch) {
            // For a runtime trace the message comes BEFORE the frames, so hold
            // it and attach it to the first user frame we then find.
            if (pending) {
                markers.push(makeMarker({
                    line: pending.line,
                    column: pending.column,
                    endColumn: pending.endColumn,
                    severity: SEVERITY_ERROR,
                    message: errorMatch[1] + ': ' + errorMatch[2],
                    code: errorMatch[1],
                    source: 'node',
                    runtimeId: runtimeId
                }));
                pending = null;
            } else {
                // Look ahead for the first frame in the user's file.
                for (let j = i + 1; j < lines.length; j += 1) {
                    let laterFrame = lines[j].match(NODE_STACK_FRAME);
                    if (laterFrame && isUserFile(laterFrame[1], runtimeId)) {
                        markers.push(makeMarker({
                            line: toInt(laterFrame[2], 1),
                            column: toInt(laterFrame[3], 1),
                            severity: SEVERITY_ERROR,
                            message: errorMatch[1] + ': ' + errorMatch[2],
                            code: errorMatch[1],
                            source: 'node',
                            runtimeId: runtimeId
                        }));
                        break;
                    }
                }
            }
        }
    }

    return markers;
}

// ---------------------------------------------------------------------------
// TypeScript: tsc --noEmit
// ---------------------------------------------------------------------------
//
//   /workspace/main.mts(5,7): error TS2551: Property 'lenght' does not exist
//       on type 'string[]'. Did you mean 'length'?
//
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+)\s*:\s*(.*)$/;

function parseTypeScript(output, runtimeId) {
    let lines = String(output).split(/\r?\n/);
    let markers = [];

    for (let i = 0; i < lines.length; i += 1) {
        let match = lines[i].match(TSC_LINE);
        if (!match || !isUserFile(match[1], runtimeId)) {
            continue;
        }
        // tsc wraps long messages onto following indented lines; join them so
        // the "Did you mean 'x'?" hint isn't lost.
        let message = match[6];
        let j = i + 1;
        while (j < lines.length && /^\s{2,}\S/.test(lines[j]) && !TSC_LINE.test(lines[j])) {
            message += ' ' + lines[j].trim();
            j += 1;
        }
        markers.push(makeMarker({
            line: match[2],
            column: match[3],
            severity: match[4] === 'warning' ? SEVERITY_WARNING : SEVERITY_ERROR,
            message: message,
            code: match[5],
            source: 'tsc',
            runtimeId: runtimeId
        }));
    }

    return markers;
}

// ---------------------------------------------------------------------------
// Java: javac, and runtime stack traces
// ---------------------------------------------------------------------------
//
//   /workspace/Main.java:7: error: cannot find symbol
//           Sting s = "x";
//           ^
//     symbol:   class Sting
//     location: class Main
//   1 error
//
const JAVAC_LINE = /^(.+?):(\d+):\s*(error|warning)\s*:\s*(.*)$/;
const JAVA_STACK_FRAME = /at\s+[\w.$]+\(([\w$]+\.java):(\d+)\)/;
const JAVA_EXCEPTION_LINE = /^(?:Exception in thread "[^"]*"\s+)?([\w.$]*(?:Exception|Error))(?::\s*(.*))?$/;

function parseJava(output, runtimeId) {
    let lines = String(output).split(/\r?\n/);
    let markers = [];

    for (let i = 0; i < lines.length; i += 1) {
        let match = lines[i].match(JAVAC_LINE);
        if (match && isUserFile(match[1], runtimeId)) {
            let message = match[4];
            // javac's follow-up "  symbol: ..." / "  location: ..." lines carry
            // the detail that makes the message actionable.
            // javac's layout is: the error line, then an echo of the offending
            // source line, then a caret line pointing at the column, then
            // optional symbol:/location: detail. The echoed source line has to be
            // skipped over to reach the caret — it is the caret that carries the
            // column, and the column is what lets the editor underline the right
            // spot rather than the whole line.
            let caret = null;
            for (let j = i + 1; j < lines.length && j <= i + 6; j += 1) {
                if (JAVAC_LINE.test(lines[j]) || /^\d+\s+(error|warning)s?\s*$/.test(lines[j])) {
                    break;
                }
                if (/^\s*\^+\s*$/.test(lines[j])) {
                    caret = columnFromCaretLine(lines[j]);
                    continue;
                }
                if (/^\s{2,}(symbol|location|required|found|reason)\s*:/.test(lines[j])) {
                    message += ' (' + lines[j].trim() + ')';
                    continue;
                }
                // Anything else in this window is the echoed source line.
            }
            markers.push(makeMarker({
                line: match[2],
                column: caret ? caret.column : 1,
                endColumn: caret ? caret.endColumn : null,
                severity: match[3] === 'warning' ? SEVERITY_WARNING : SEVERITY_ERROR,
                message: message,
                code: null,
                source: 'javac',
                runtimeId: runtimeId
            }));
            continue;
        }

        // Runtime exception: message first, then frames.
        let exceptionMatch = lines[i].match(JAVA_EXCEPTION_LINE);
        if (exceptionMatch) {
            for (let j = i + 1; j < lines.length; j += 1) {
                let frame = lines[j].match(JAVA_STACK_FRAME);
                if (frame && isUserFile(frame[1], runtimeId)) {
                    markers.push(makeMarker({
                        line: frame[2],
                        column: 1,
                        severity: SEVERITY_ERROR,
                        message: exceptionMatch[1] + (exceptionMatch[2] ? ': ' + exceptionMatch[2] : ''),
                        code: exceptionMatch[1],
                        source: 'java',
                        runtimeId: runtimeId
                    }));
                    break;
                }
            }
        }
    }

    return markers;
}

const PARSERS = {
    python: parsePython,
    node: parseNode,
    typescript: parseTypeScript,
    java: parseJava
};

/**
 * De-duplicate markers on line+column+message. tsc in particular can repeat the
 * same diagnostic, and a traceback can name the same frame twice.
 */
function dedupe(markers) {
    let seen = Object.create(null);
    let unique = [];
    for (let marker of markers) {
        let key = marker.line + ':' + marker.column + ':' + marker.message;
        if (seen[key]) {
            continue;
        }
        seen[key] = true;
        unique.push(marker);
    }
    return unique.slice(0, MAX_DIAGNOSTICS);
}

function parseWith(parserName, output, runtimeId) {
    let parser = PARSERS[parserName];
    if (!parser || !output) {
        return [];
    }
    try {
        return dedupe(parser(output, runtimeId));
    } catch (e) {
        // A parser bug must never break a run — the raw output is still shown.
        log.warn('sandboxDiagnostics: parser "' + parserName + '" failed: ', e.message);
        return [];
    }
}

/**
 * Parse the output of a runtime's checkArgv (the Validate action).
 */
function parseCheckDiagnostics(runtimeId, output) {
    let runtime = sandboxRuntimes.getRuntime(runtimeId);
    if (!runtime) {
        return [];
    }
    return parseWith(runtime.diagnosticsParser, output, runtime.id);
}

/**
 * Parse the output of a failed RUN. Uses the same per-language parsers: each one
 * understands both its compiler's format and its runtime's traceback format.
 */
function parseRuntimeDiagnostics(runtimeId, output) {
    return parseCheckDiagnostics(runtimeId, output);
}

module.exports = {
    MAX_DIAGNOSTICS: MAX_DIAGNOSTICS,
    parseCheckDiagnostics: parseCheckDiagnostics,
    parseRuntimeDiagnostics: parseRuntimeDiagnostics,
    // Exported for tests / reuse.
    _columnFromCaretLine: columnFromCaretLine,
    _isUserFile: isUserFile
};
