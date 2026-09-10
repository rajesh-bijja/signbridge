"use strict";

/**
 * loadProfilesDaemon.test.js
 *
 * One invariant: a completely successful startup must not log an ERROR.
 *
 * `isProfileAlreadyCreated` exists to ask whether a profile from ~/.aws has been
 * imported into the user's artifacts yet, and its whole implementation is a
 * `statSync` in a try/catch. So on a fresh base dir the expected answer — "no" —
 * arrives as ENOENT, and reporting that at ERROR level printed one alarming line
 * per profile (24, in the report that prompted this) during a startup in which
 * every one of those profiles was then imported successfully.
 *
 * That is worth a test rather than a fix alone, because the failure mode is
 * reversed: the noise does not break anything, so nobody removes it, and the
 * cost is that the log stops being a signal. The next real ERROR at startup is
 * one line in a screenful of expected ones.
 *
 * Source inspection, because the alternative is a fixture base dir and a log
 * spy for a branch that is three lines long.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function source(rel) {
    return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('a profile that has not been imported yet is not an error', function () {
    const code = source('lib/loadProfilesDaemon.js');

    assert.match(code, /e\.code === 'ENOENT'/,
        'the "not imported yet" case must be told apart from a real fault — it is the'
        + ' expected answer on a fresh ~/.signbridge, not a failure');

    // The specific line that produced the noise. `log.error(e.message)` in that
    // catch is indiscriminate: it cannot distinguish the answer from a fault.
    assert.doesNotMatch(code, /catch\s*\(e\)\s*\{\s*log\.error\(e\.message\)/,
        'the ENOENT branch must not log at ERROR — a fresh install logged one of these'
        + ' per profile while importing all of them successfully');

    // A genuine fault (EACCES, a directory where a file should be) still has to
    // be reported, or fixing the noise hides a real problem instead.
    assert.match(code, /log\.warn\('could not check whether profile/,
        'anything that is not ENOENT is a real fault and must still be reported');
});
