"use strict";

/**
 * s3Search.js — the search language behind S3 World, as pure functions.
 *
 * WHY THIS EXISTS
 * The S3 console's object search is a *prefix* filter, and AWS used to document
 * the limits in its own words ("Searching for Objects by Prefix", since removed
 * from the user guide):
 *
 *   "the search string is case sensitive and must not contain the forward slash
 *    '/' character. Searches are scoped to objects at the root level of the
 *    bucket or to objects within a folder, not including the subfolders."
 *
 * So `report` finds `report-2026.csv` but not `Q3-report.csv`, `REPORT.csv`, or
 * `2026/q3/report.csv` one level down. In practice you can only find a file you
 * could already have found by reading the list. AWS's current answer to
 * "search my bucket" is to build an index with S3 Inventory or S3 Metadata and
 * query it from Athena — which is not an answer for someone who just wants to
 * find a file.
 *
 * The rules here invert those defaults. Typing a word searches for that word
 * ANYWHERE in the key, case-insensitively, RECURSIVELY from wherever you are.
 * Two words mean "both, in any order, in any position". Everything beyond that
 * is opt-in syntax that a user never has to learn:
 *
 *   report q3            both words appear somewhere in the key (AND)
 *   "final report"       the exact phrase, spaces included
 *   *.log                a glob, anchored to the whole name
 *   2026-0?-*            ? = one character, * = any run of characters
 *   -backup              exclude keys containing "backup"
 *   ext:csv,tsv          extension is one of these
 *   size>10mb            larger than 10 MB (also <, and k/kb/m/mb/g/gb/t/tb)
 *   modified>7d          changed in the last 7 days (also h, m, d, w, or a date)
 *   /^logs\/\d{4}\//     a regular expression, when you really do want one
 *
 * Anything unparseable degrades to a plain substring term rather than erroring:
 * a search box that rejects input is worse than one that finds too much.
 *
 * WHAT IS SEARCHED (the `scope`)
 * Matching anywhere in the whole key is the right default, but it conflates two
 * different questions. "Where is the invoices folder?" and "which files are called
 * invoice?" are asked with the same word and want different answers — and against
 * a key like `invoices/2026/summary.csv` the default answers both at once. So the
 * scope is explicit:
 *
 *   'name'    the object's own file name only (the last path segment)
 *   'folder'  the directory path the object sits in, and that folder's own name
 *   'both'    the whole key — the default, and a superset of the other two
 *
 * `'key'` is accepted as a synonym for `'both'` because that is what this module
 * called it before folder scope existed.
 *
 * The module is deliberately free of I/O — it turns a query string into a
 * predicate over `{ key, name, size, lastModified }`. The traversal that feeds
 * it lives in s3World.js, and the tests (test/s3Search.test.js) need no fixtures.
 */

// What a term is tested against. See "WHAT IS SEARCHED" above.
const SCOPES = { NAME: 'name', FOLDER: 'folder', BOTH: 'both' };

/**
 * Normalise a scope from the wire. Anything unrecognised becomes 'both', which
 * is the widest of the three: a bad scope should never silently hide results.
 */
function normalizeScope(value) {
    let text = String(value == null ? '' : value).trim().toLowerCase();
    if (text === SCOPES.NAME || text === 'object' || text === 'objectname' ||
        text === 'file' || text === 'filename') {
        return SCOPES.NAME;
    }
    if (text === SCOPES.FOLDER || text === 'directory' || text === 'dir' ||
        text === 'prefix' || text === 'path') {
        return SCOPES.FOLDER;
    }
    return SCOPES.BOTH;
}

// Multipliers for size suffixes. Binary (1024) because that is what every
// file browser shows and what users mean by "10 MB".
const SIZE_UNITS = {
    b: 1,
    k: 1024, kb: 1024,
    m: 1024 * 1024, mb: 1024 * 1024,
    g: 1024 * 1024 * 1024, gb: 1024 * 1024 * 1024,
    t: 1024 * 1024 * 1024 * 1024, tb: 1024 * 1024 * 1024 * 1024
};

// Multipliers for relative-age suffixes, in milliseconds.
const AGE_UNITS = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000
};

/**
 * Split a query into tokens, keeping "quoted phrases" intact and treating a
 * /regex/ as a single token (so a slash-delimited pattern containing spaces
 * survives).
 */
function tokenize(input) {
    let tokens = [];
    let text = String(input == null ? '' : input);
    let i = 0;
    while (i < text.length) {
        let ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            i++;
            continue;
        }
        // A leading '-' stays attached to its token so negation is preserved.
        let negated = false;
        if (ch === '-' && i + 1 < text.length && text[i + 1] !== ' ') {
            negated = true;
            i++;
            ch = text[i];
        }
        let value;
        if (ch === '"' || ch === "'") {
            let close = text.indexOf(ch, i + 1);
            if (close === -1) {
                // Unterminated quote: take the rest verbatim rather than failing.
                value = text.slice(i + 1);
                i = text.length;
            } else {
                value = text.slice(i + 1, close);
                i = close + 1;
            }
            tokens.push({ value: value, negated: negated, quoted: true });
            continue;
        }
        if (ch === '/') {
            // /pattern/flags — find the last unescaped slash in the token run.
            let end = i + 1;
            let closed = -1;
            while (end < text.length) {
                if (text[end] === '/' && text[end - 1] !== '\\') {
                    closed = end;
                    break;
                }
                end++;
            }
            if (closed !== -1) {
                let flagEnd = closed + 1;
                while (flagEnd < text.length && /[a-z]/.test(text[flagEnd])) {
                    flagEnd++;
                }
                tokens.push({ value: text.slice(i, flagEnd), negated: negated, regexLiteral: true });
                i = flagEnd;
                continue;
            }
            // No closing slash: fall through and treat it as an ordinary word.
        }
        let start = i;
        while (i < text.length && !/\s/.test(text[i])) {
            i++;
        }
        value = text.slice(start, i);
        if (value.length > 0) {
            tokens.push({ value: value, negated: negated, quoted: false });
        }
    }
    return tokens;
}

/**
 * Parse a size expression like `10mb` into bytes. Returns null when it isn't
 * one, so the caller can fall back to substring matching.
 */
function parseSize(text) {
    let match = /^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g|tb|t)?$/i.exec(String(text).trim());
    if (!match) {
        return null;
    }
    let unit = (match[2] || 'b').toLowerCase();
    return Math.round(parseFloat(match[1]) * SIZE_UNITS[unit]);
}

/**
 * Parse a time expression into an epoch-ms threshold. Accepts a relative age
 * (`7d`, `24h`) resolved against `nowMs`, or an absolute date the Date
 * constructor understands (`2026-01-01`). Returns null when it is neither.
 */
function parseTime(text, nowMs) {
    let value = String(text).trim();
    let relative = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|y)$/i.exec(value);
    if (relative) {
        let unit = relative[2].toLowerCase();
        return nowMs - parseFloat(relative[1]) * AGE_UNITS[unit];
    }
    let parsed = Date.parse(value);
    return isNaN(parsed) ? null : parsed;
}

// Units for rendering a byte count back to the user. Binary, matching parseSize.
const SIZE_LABELS = ['bytes', 'KB', 'MB', 'GB', 'TB'];

/**
 * Render a byte count the way the explain line should read: `size>10mb` becomes
 * "10 MB", not "10mb". The explanation exists to confirm we understood the query,
 * so echoing the user's own typing back proves nothing.
 */
function describeSize(bytes) {
    let index = 0;
    let value = bytes;
    while (value >= 1024 && index < SIZE_LABELS.length - 1) {
        value = value / 1024;
        index++;
    }
    let rounded = Math.round(value * 10) / 10;
    return rounded + ' ' + SIZE_LABELS[index];
}

const AGE_LABELS = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', y: 'year' };

/**
 * Render a relative age as words ("7 days"), or null if the value is an absolute
 * date — the caller phrases those differently ("modified after 2026-01-01").
 */
function describeAge(text) {
    let relative = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|y)$/i.exec(String(text).trim());
    if (!relative) {
        return null;
    }
    let amount = parseFloat(relative[1]);
    let unit = AGE_LABELS[relative[2].toLowerCase()];
    return amount + ' ' + unit + (amount === 1 ? '' : 's');
}

/**
 * Convert a glob to an anchored RegExp. Only * and ? are special — a glob is a
 * user convenience, not a second regex dialect, so every other character
 * (including '.') is matched literally.
 */
function globToRegExp(glob, caseSensitive) {
    let pattern = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp('^' + pattern + '$', caseSensitive ? '' : 'i');
}

function looksLikeGlob(text) {
    return text.indexOf('*') !== -1 || text.indexOf('?') !== -1;
}

/**
 * Parse a query string into a structured form.
 *
 * @param {string} input
 * @param {object} [options] { nowMs, caseSensitive, scope }
 * @returns {{ terms: Array, filters: object, notes: string[], scope, isEmpty: boolean }}
 *   terms: [{ kind: 'substring'|'glob'|'regex', value, negated, regex? }]
 *   filters: { extensions?: string[], minSize?, maxSize?, modifiedAfter?, modifiedBefore? }
 *   notes: human-readable descriptions of what was understood, for the UI
 */
function parseQuery(input, options) {
    options = options || {};
    let nowMs = options.nowMs == null ? Date.now() : options.nowMs;
    let caseSensitive = !!options.caseSensitive;

    let terms = [];
    let filters = {};
    let notes = [];

    tokenize(input).forEach(function (token) {
        let raw = token.value;

        // --- field filters: name:value -------------------------------------
        // Only recognised when the value is non-empty; `http://x` and a bare
        // `foo:` stay ordinary substrings.
        let field = /^([a-z]+)(:|>=|<=|>|<|=)(.+)$/i.exec(raw);
        if (field && !token.quoted && !token.regexLiteral) {
            let name = field[1].toLowerCase();
            let op = field[2];
            let value = field[3];

            if (name === 'ext' || name === 'extension' || name === 'type') {
                let extensions = value.split(',').map(function (ext) {
                    let cleaned = ext.trim().toLowerCase().replace(/^\./, '');
                    return cleaned;
                }).filter(Boolean);
                if (extensions.length) {
                    filters.extensions = (filters.extensions || []).concat(extensions);
                    notes.push('extension is ' + extensions.map(function (e) { return '.' + e; }).join(' or '));
                    return;
                }
            }

            if (name === 'size') {
                let bytes = parseSize(value);
                if (bytes !== null) {
                    if (op === '>' || op === '>=') {
                        filters.minSize = bytes;
                        notes.push('larger than ' + describeSize(bytes));
                    } else if (op === '<' || op === '<=') {
                        filters.maxSize = bytes;
                        notes.push('smaller than ' + describeSize(bytes));
                    } else {
                        filters.minSize = bytes;
                        filters.maxSize = bytes;
                        notes.push('exactly ' + describeSize(bytes));
                    }
                    return;
                }
            }

            if (name === 'modified' || name === 'age' || name === 'date') {
                let threshold = parseTime(value, nowMs);
                if (threshold !== null) {
                    // `modified>7d` reads as "modified more recently than 7 days
                    // ago", which is the intuitive reading and the opposite of a
                    // literal timestamp comparison.
                    let age = describeAge(value);
                    if (op === '>' || op === '>=') {
                        filters.modifiedAfter = threshold;
                        notes.push(age ? 'modified in the last ' + age : 'modified after ' + value);
                    } else if (op === '<' || op === '<=') {
                        filters.modifiedBefore = threshold;
                        notes.push(age ? 'modified more than ' + age + ' ago' : 'modified before ' + value);
                    }
                    return;
                }
            }
            // Unrecognised field: fall through to substring matching, so a key
            // that genuinely contains "foo:bar" is still findable.
        }

        // --- /regex/flags ---------------------------------------------------
        if (token.regexLiteral) {
            let match = /^\/(.*)\/([a-z]*)$/.exec(raw);
            if (match) {
                let flags = match[2] || '';
                if (!caseSensitive && flags.indexOf('i') === -1) {
                    flags += 'i';
                }
                try {
                    terms.push({
                        kind: 'regex',
                        value: match[1],
                        negated: token.negated,
                        regex: new RegExp(match[1], flags)
                    });
                    notes.push((token.negated ? 'does not match' : 'matches') + ' /' + match[1] + '/');
                    return;
                } catch (err) {
                    // Invalid pattern: treat the literal text as a substring.
                    notes.push('“' + raw + '” is not a valid regular expression — searching for it as text');
                }
            }
        }

        // --- glob -----------------------------------------------------------
        if (!token.quoted && looksLikeGlob(raw)) {
            terms.push({
                kind: 'glob',
                value: raw,
                negated: token.negated,
                regex: globToRegExp(raw, caseSensitive)
            });
            notes.push((token.negated ? 'does not match' : 'matches') + ' ' + raw);
            return;
        }

        // --- plain substring (the default, and the common case) -------------
        if (raw.length > 0) {
            terms.push({
                kind: 'substring',
                value: raw,
                negated: token.negated
            });
            notes.push((token.negated ? 'does not contain' : 'contains') + ' “' + raw + '”');
        }
    });

    return {
        terms: terms,
        filters: filters,
        notes: notes,
        caseSensitive: caseSensitive,
        // Carried on the parse so describeQuery can phrase the explanation for the
        // scope the search will actually run with, without a second argument.
        scope: normalizeScope(options.scope),
        isEmpty: terms.length === 0 && Object.keys(filters).length === 0
    };
}

/**
 * The path of the folder an entry sits in, relative to where the search started,
 * with no trailing slash — `logs/2026/08/app.log` gives `logs/2026/08`, and an
 * object at the root gives `''`.
 *
 * No trailing slash, so that a glob typed by a person works: a pattern ending in
 * `/08` should match that folder, and it cannot if the subject ends in a slash.
 */
function folderPathOf(entry) {
    let relative = String(
        (entry.relativeKey != null ? entry.relativeKey : entry.key) || ''
    );
    let cut = relative.lastIndexOf('/');
    return cut === -1 ? '' : relative.slice(0, cut);
}

/**
 * The text a term is tested against, per scope (see "WHAT IS SEARCHED" above).
 *
 * Two subjects rather than one, in every scope but 'name', because globs are
 * anchored: testing `*.log` against a full key would force the user to write a
 * leading directory wildcard (`* / *.log`, without the spaces). So the last
 * segment is always offered alongside the path, and a match on either counts.
 */
function subjectsFor(entry, scope) {
    let name = entry.name != null ? entry.name : String(entry.key || '').split('/').pop();
    if (scope === SCOPES.NAME) {
        return [name];
    }
    if (scope === SCOPES.FOLDER) {
        let folder = folderPathOf(entry);
        // The folder's own name as well as its full path, so `q3` and `2026/q3`
        // and `q?` all find the same folder. An object at the bucket root has no
        // folder at all, and must not match a folder query.
        if (!folder) {
            return [];
        }
        return [folder, folder.split('/').pop()];
    }
    return [entry.relativeKey != null ? entry.relativeKey : entry.key, name];
}

function matchesSubjects(term, subjects, caseSensitive) {
    for (let i = 0; i < subjects.length; i++) {
        let subject = String(subjects[i] == null ? '' : subjects[i]);
        if (term.kind === 'substring') {
            let haystack = caseSensitive ? subject : subject.toLowerCase();
            let needle = caseSensitive ? term.value : term.value.toLowerCase();
            if (haystack.indexOf(needle) !== -1) {
                return true;
            }
        } else if (term.regex && term.regex.test(subject)) {
            return true;
        }
    }
    return false;
}

function matchesTerm(term, entry, scope, caseSensitive) {
    return matchesSubjects(term, subjectsFor(entry, scope), caseSensitive);
}

function extensionOf(key) {
    let name = String(key || '').split('/').pop();
    let dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) {
        return '';
    }
    return name.slice(dot + 1).toLowerCase();
}

function matchesFilters(filters, entry) {
    if (filters.extensions && filters.extensions.indexOf(extensionOf(entry.key)) === -1) {
        return false;
    }
    if (filters.minSize != null && !(entry.size >= filters.minSize)) {
        return false;
    }
    if (filters.maxSize != null && !(entry.size <= filters.maxSize)) {
        return false;
    }
    if (filters.modifiedAfter != null || filters.modifiedBefore != null) {
        let modified = entry.lastModified instanceof Date
            ? entry.lastModified.getTime()
            : Date.parse(entry.lastModified);
        if (isNaN(modified)) {
            return false;
        }
        if (filters.modifiedAfter != null && modified < filters.modifiedAfter) {
            return false;
        }
        if (filters.modifiedBefore != null && modified > filters.modifiedBefore) {
            return false;
        }
    }
    return true;
}

/**
 * Compile a parsed query into a predicate.
 *
 * @param {object} parsed  from parseQuery
 * @param {object} [options] { scope: 'name'|'folder'|'both' }  default: the
 *   parse's own scope, else 'both'
 * @returns {function(entry): boolean}
 */
function compileMatcher(parsed, options) {
    options = options || {};
    let scope = normalizeScope(options.scope != null ? options.scope : parsed && parsed.scope);
    let caseSensitive = !!parsed.caseSensitive;

    return function (entry) {
        if (!entry || entry.key == null) {
            return false;
        }
        if (!matchesFilters(parsed.filters || {}, entry)) {
            return false;
        }
        let terms = parsed.terms || [];
        for (let i = 0; i < terms.length; i++) {
            let term = terms[i];
            let hit = matchesTerm(term, entry, scope, caseSensitive);
            // Negated terms are AND-ed as exclusions; positive terms are AND-ed
            // as requirements. No OR: two words meaning "either" would make
            // every multi-word search noisier, and `/a|b/` covers the rare case.
            if (term.negated ? hit : !hit) {
                return false;
            }
        }
        return true;
    };
}

/**
 * A predicate over folders, for the "matching folders" half of a search result.
 *
 * Only the terms apply. `size>10mb` and `modified>7d` describe an object, and a
 * folder in S3 is not an object at all — applying them here would silently drop
 * every folder from any query that happened to use one.
 *
 * @param {object} parsed  from parseQuery
 * @returns {function({ relativePath }): boolean}
 */
function compileFolderMatcher(parsed) {
    let caseSensitive = !!(parsed && parsed.caseSensitive);
    let terms = (parsed && parsed.terms) || [];

    return function (folder) {
        let path = String((folder && folder.relativePath) || '');
        if (!path) {
            return false;
        }
        let subjects = [path, path.split('/').pop()];
        for (let i = 0; i < terms.length; i++) {
            let hit = matchesSubjects(terms[i], subjects, caseSensitive);
            if (terms[i].negated ? hit : !hit) {
                return false;
            }
        }
        // An all-filters query ("size>10mb") says nothing about folders, so it
        // selects none rather than all of them.
        return terms.length > 0;
    };
}

// How each scope reads at the front of the explain line.
const SCOPE_LEAD_INS = {
    name: 'Objects whose file name ',
    folder: 'Objects inside a folder whose path ',
    both: 'Objects whose name or folder path '
};

/**
 * One-line plain-English summary of what a query will do, shown under the
 * search box so the syntax is discoverable without documentation.
 */
function describeQuery(parsed) {
    if (!parsed || parsed.isEmpty) {
        return 'Everything under this folder.';
    }
    let lead = SCOPE_LEAD_INS[normalizeScope(parsed.scope)];
    return lead + parsed.notes.join(', and ') + '.';
}

/**
 * Convenience: parse + compile in one call.
 */
function buildSearch(input, options) {
    let parsed = parseQuery(input, options);
    return {
        parsed: parsed,
        scope: parsed.scope,
        matches: compileMatcher(parsed, options),
        // Folders are only worth collecting when the query was about them.
        matchesFolder: parsed.scope === SCOPES.NAME ? null : compileFolderMatcher(parsed),
        description: describeQuery(parsed)
    };
}

module.exports = {
    SCOPES: SCOPES,
    SIZE_UNITS: SIZE_UNITS,
    AGE_UNITS: AGE_UNITS,
    normalizeScope: normalizeScope,
    folderPathOf: folderPathOf,
    tokenize: tokenize,
    parseSize: parseSize,
    parseTime: parseTime,
    globToRegExp: globToRegExp,
    parseQuery: parseQuery,
    compileMatcher: compileMatcher,
    compileFolderMatcher: compileFolderMatcher,
    describeQuery: describeQuery,
    buildSearch: buildSearch,
    extensionOf: extensionOf
};
