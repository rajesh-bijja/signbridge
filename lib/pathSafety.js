"use strict";

/**
 * pathSafety.js
 *
 * One rule, in one place: a value that arrived in a request may become a single
 * path segment and nothing more.
 *
 * SignBridge's stores are files, and the file name is usually an id or a name the
 * caller chose — a profile name, a history id, a favorite id, a thread id, a
 * script id. Every one of those is concatenated into a path, so every one of them
 * is a traversal unless something stops it:
 *
 *   getHistoryDetails { historyId: '../../llm/settings' }  -> reads any .json on disk
 *   deleteHistory     { historyId: '../../settings/settings' } -> deletes it
 *   addProfile        { profileName: '../../../../../tmp/x' } -> writes outside the base dir
 *
 * Two of the stores already had their own guard (`sandboxStore`'s
 * `SCRIPT_ID_PATTERN`, `threadStore`'s `isSafeThreadId`) and `coreUtils`'
 * collection delete had a third inside `splitImportedCollectionName`. Three
 * different rules in three files is how the fourth store ships without one, so
 * the rule lives here and the stores call it.
 *
 * The rule is deliberately about *shape*, not about a character allowlist. A
 * profile name is user-facing text — imported straight from `~/.aws/config`, so
 * it legitimately contains dots, spaces, `+` and `@` — and an allowlist tight
 * enough to be safe would reject profiles that already exist on the user's
 * machine. "Is its own basename, is not `.` or `..`, holds no separator and no
 * NUL" is the whole of what a path needs, and it cannot be narrowed by adding a
 * character to a list.
 *
 * Pure: no fs, no state, no clock. `resolveWithin` does string arithmetic on
 * paths and never touches the filesystem, so the tests need no fixtures.
 */

let path = require('path');

// Longest single path component ext4 and APFS accept. Also the point past which a
// name is not a name.
const MAX_SEGMENT_LENGTH = 255;

/**
 * True if `value` can be used as exactly one path component.
 */
function isSafeSegment(value) {
    if (typeof value !== 'string') {
        return false;
    }
    if (value.length === 0 || value.length > MAX_SEGMENT_LENGTH) {
        return false;
    }
    // A NUL truncates the path at the syscall boundary, so 'ok\0/../../etc' would
    // pass a naive suffix check and open something else entirely.
    if (value.indexOf('\0') !== -1) {
        return false;
    }
    if (value === '.' || value === '..') {
        return false;
    }
    // basename() drops everything up to the last separator, so a value that is not
    // its own basename carried one. On POSIX that catches '/' only, which is why
    // the backslash is checked explicitly — the app may be run on Windows, where
    // it is a separator too.
    if (value !== path.basename(value)) {
        return false;
    }
    if (value.indexOf('/') !== -1 || value.indexOf('\\') !== -1) {
        return false;
    }
    return true;
}

/**
 * An Error suitable for returning to a caller: 400, and it names the field rather
 * than echoing the value back into the response.
 */
function segmentError(label) {
    let err = new Error((label || 'value') + ' is not a valid name: it must be a single path'
        + ' component, with no directory separators and not "." or "..".');
    err.statusCode = 400;
    return err;
}

/**
 * `null` when `value` is a usable segment, otherwise the Error to hand back.
 * Shaped for the callback-style code in lib/: `let e = assertSafeSegment(id, 'historyId'); if (e) { return cb(e); }`
 */
function assertSafeSegment(value, label) {
    return isSafeSegment(value) ? null : segmentError(label);
}

/**
 * True if `candidate` resolves to `baseDir` itself or something under it.
 *
 * String arithmetic only — no realpath, so a symlink inside the base dir pointing
 * out of it is not caught here. That is deliberate: the base dir is created by
 * this app under the user's own home, and resolving links would make this
 * function touch the filesystem and stop being testable. The segment check above
 * is the primary defence; this is the backstop for a path assembled from more
 * than one part.
 */
function isWithin(baseDir, candidate) {
    let base = path.resolve(baseDir);
    let target = path.resolve(candidate);
    if (target === base) {
        return true;
    }
    return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * Join `segments` onto `baseDir`, validating each one, and throw if the result
 * would land outside `baseDir`.
 */
function resolveWithin(baseDir, ...segments) {
    for (let i = 0; i < segments.length; i++) {
        let err = assertSafeSegment(segments[i], 'path segment');
        if (err) {
            throw err;
        }
    }
    let target = path.resolve(path.join(baseDir, ...segments));
    if (!isWithin(baseDir, target)) {
        let err = new Error('resolved path escapes its base directory.');
        err.statusCode = 400;
        throw err;
    }
    return target;
}

module.exports = {
    MAX_SEGMENT_LENGTH: MAX_SEGMENT_LENGTH,
    isSafeSegment: isSafeSegment,
    assertSafeSegment: assertSafeSegment,
    isWithin: isWithin,
    resolveWithin: resolveWithin
};
