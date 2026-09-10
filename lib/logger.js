"use strict";

/**
 * logger.js — the one place a log line is written, and the reason "never log a
 * secret" is now structural instead of a rule people have to remember.
 *
 * SignBridge had 532 `console.*` calls, 490 of them `console.log`, and most of
 * those were signing internals: canonical requests, headers, payloads, profile
 * objects, SSO/STS response bodies. Three things were wrong with that, and only
 * the first is the obvious one:
 *
 *   1. **Redaction was opt-in.** `lib/redact.js` exists precisely because those
 *      lines had been printing live session tokens, and the fix was to wrap the
 *      offending payloads at the call site. 77 of 532 call sites wrapped. Every
 *      log line added after that fix was one more chance to forget — and forgetting
 *      fails silently, which is the worst property a secret leak can have. So this
 *      logger passes **every argument** through `redact.forLog` before it is
 *      formatted. A new log line cannot leak a credential by omission; it would
 *      take deliberately reaching past the logger to `console.log`.
 *   2. **There was no volume control.** A single presign printed a few dozen
 *      lines including the full canonical request. That output is genuinely the
 *      only way to debug a signature mismatch, so deleting it would be worse than
 *      keeping it — but it should not be the default. It is now `debug`, off
 *      unless asked for, and the default `info` output is startup plus what
 *      actually went wrong.
 *   3. **Severity was not expressed.** `console.log('caught unexpected error…')`
 *      is an error; it looked exactly like a trace line, so nothing could be
 *      filtered or alerted on.
 *
 * No logging library. pino and winston are the obvious answers and both bring a
 * dependency tree into an app that was just taken to 19 direct dependencies and
 * zero advisories; what is actually needed here is four levels, one writer and
 * mandatory redaction. That is this file.
 *
 * Usage:
 *
 *     const log = require('./logger').create('ssoUtils');
 *     log.debug('canonicalRequest: [\n' + redact.redactCanonicalRequest(cr) + '\n]');
 *     log.error('error in invoke sts: ', err);
 *
 * Call sites that already wrap a payload in `redact.forLog` / `redactCanonicalRequest`
 * are left as they are: `forLog` is idempotent, the explicit wrap documents intent
 * at the point it matters, and `redactCanonicalRequest` does something this
 * logger's generic pass cannot (it understands `name:value` canonical header
 * lines). Belt and braces, with the braces being the part that cannot be forgotten.
 */

const util = require('util');
const path = require('path');
const redact = require('./redact');

// Ascending severity. A level prints when its rank is <= the active level's rank.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = 'info';

// Padded so the level column lines up and the eye can scan it.
const LABELS = { error: 'ERROR', warn: 'WARN ', info: 'INFO ', debug: 'DEBUG' };

let activeLevel = null;   // resolved lazily, so requiring this module reads nothing

/**
 * Resolve the level once, from the environment first and `config.properties`
 * second — the same precedence as everything else operator-facing here.
 *
 * The config read is wrapped because `config.properties` is gitignored: a fresh
 * clone that has not copied the template yet must still be able to run the test
 * suite, and a logger that throws on require would take the whole app with it.
 */
function resolveLevel() {
    let fromEnv = String(process.env.LOG_LEVEL || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, fromEnv)) {
        return fromEnv;
    }
    try {
        let propertiesReader = require('properties-reader');
        let props = propertiesReader(path.resolve(__dirname, '../config.properties'));
        let fromConfig = String(props.get('logging.level') || '').trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(LEVELS, fromConfig)) {
            return fromConfig;
        }
    } catch (err) {
        // No config file, or no [logging] section. The default is the answer.
    }
    return DEFAULT_LEVEL;
}

function getLevel() {
    if (activeLevel === null) {
        activeLevel = resolveLevel();
    }
    return activeLevel;
}

// Exposed for tests and for a future runtime control; not used at startup.
function setLevel(level) {
    let wanted = String(level || '').trim().toLowerCase();
    activeLevel = Object.prototype.hasOwnProperty.call(LEVELS, wanted) ? wanted : DEFAULT_LEVEL;
    return activeLevel;
}

function isEnabled(level) {
    return LEVELS[level] <= LEVELS[getLevel()];
}

/**
 * Render one argument the way `console.log` would, but redacted first.
 *
 * Strings pass through `redact.forLog` too (it routes them to `redactText`), which
 * is what catches a raw response body or a presigned URL interpolated straight
 * into the message — historically the most common way a credential reached a log
 * line, because the parsed copy was wrapped and the raw one above it was not.
 */
function formatArg(value) {
    let safe = redact.forLog(value);
    if (typeof safe === 'string') {
        return safe;
    }
    if (safe instanceof Error) {
        // The stack is the useful part, but only when someone asked for detail.
        return isEnabled('debug') && safe.stack ? safe.stack : (safe.message || String(safe));
    }
    if (safe === null || safe === undefined || typeof safe !== 'object') {
        return String(safe);
    }
    return util.inspect(safe, { depth: 4, breakLength: 120, colors: false });
}

/**
 * `console.log` separates arguments with a single space, and hundreds of the call
 * sites converted to this logger were written for that (`log.debug('host: ', h)`
 * reads correctly and produces one trailing space). Joining with a space keeps
 * every one of those lines looking exactly as it did.
 */
function write(level, scope, args) {
    let line = LABELS[level] + ' [' + scope + '] ' +
        args.map(formatArg).join(' ');
    let record = new Date().toISOString() + ' ' + line + '\n';
    // warn and error to stderr: a container's error stream is what gets watched,
    // and `console.log('caught unexpected error…')` used to bury these in stdout.
    if (level === 'error' || level === 'warn') {
        process.stderr.write(record);
    } else {
        process.stdout.write(record);
    }
}

/**
 * A logger scoped to one module, so a line names where it came from without every
 * message having to repeat it.
 */
function create(scope) {
    let name = String(scope || 'signbridge');
    function at(level) {
        return function () {
            if (!isEnabled(level)) {
                return;
            }
            write(level, name, Array.prototype.slice.call(arguments));
        };
    }
    return {
        scope: name,
        error: at('error'),
        warn: at('warn'),
        info: at('info'),
        debug: at('debug'),
        // For the handful of call sites that build an expensive string (a whole
        // canonical request) purely to log it.
        isDebug: function () { return isEnabled('debug'); }
    };
}

module.exports = {
    LEVELS: LEVELS,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    create: create,
    getLevel: getLevel,
    setLevel: setLevel,
    isEnabled: isEnabled
};
