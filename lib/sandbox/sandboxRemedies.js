"use strict";

/**
 * sandboxRemedies.js
 *
 * The "what do I do about it" half of Sandbox diagnostics. A red squiggle tells
 * you something is wrong; a remedy tells you how to fix it. Every remedy is
 * derived from the error message alone — pure string matching, no fs/network —
 * so it is fully unit testable (see test/sandboxRemedies.test.js).
 *
 * Two layers:
 *
 *   suggestRemedy(marker, runtimeId)
 *       Attached to an individual editor marker by sandboxDiagnostics. When it
 *       returns a `replaceWord`, the IDE offers a real one-click Monaco quick
 *       fix that rewrites the identifier under the marker.
 *
 *   suggestOutputRemedies(runtimeId, output)
 *       Scans a whole run's output for failures that have no source line to
 *       point at — expired SSO sessions, denied IAM permissions, throttling.
 *       These surface as a banner above the console, because they are almost
 *       never a code bug and the fix happens outside the editor.
 *
 * Remedy shape:
 *   { title, detail, replaceWord? }
 *     title       - one short imperative line, shown as the quick-fix label
 *     detail      - a sentence or two of explanation, shown in the hover
 *     replaceWord - optional: the identifier to substitute at the marker
 */

const sandboxRuntimes = require('./sandboxRuntimes');

function remedy(title, detail, extra) {
    let value = { title: title, detail: detail };
    if (extra && extra.replaceWord) {
        value.replaceWord = extra.replaceWord;
    }
    return value;
}

/**
 * Human-readable list of what the sandbox image ships for a language, used in
 * "module not found" remedies so the user learns what IS available.
 */
function librariesFor(runtimeId) {
    let runtime = sandboxRuntimes.getRuntime(runtimeId);
    if (!runtime) {
        return '';
    }
    return runtime.libraries.join(', ');
}

/**
 * Pull a "Did you mean 'x'?" suggestion out of a message. Python 3.11+, tsc, and
 * javac all emit this, and it is the single most directly actionable hint there
 * is — it becomes a one-click fix.
 */
function extractDidYouMean(message) {
    // The three real forms, as emitted by the toolchains in the sandbox image:
    //   Python: Did you mean: 'boto3'?
    //   tsc:    Did you mean 'length'?
    //   tsc:    Did you mean to write 'Bucket'?
    //
    // The quotes are REQUIRED. tsc also writes compiler-flag hints such as
    // "Did you mean to set the 'moduleResolution' option to 'nodenext'?" — a
    // looser pattern captured the bare word "to" there and offered to rewrite
    // the user's identifier as "to".
    let match = /did you mean(?:\s+to\s+(?:write|use))?\s*:?\s*['"`]([A-Za-z_$][\w$.]*)['"`]/i
        .exec(message || '');
    return match ? match[1] : null;
}

/**
 * Pull the quoted module/package name out of an import error.
 */
function extractQuoted(message) {
    let match = /['"`]([^'"`]+)['"`]/.exec(message || '');
    return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Per-marker remedies
// ---------------------------------------------------------------------------

// Each entry: { test(message, marker), build(message, marker, runtimeId) }.
// Order matters — the first match wins, so put specific patterns before general.
const MARKER_RULES = [
    // --- an explicit spelling suggestion beats every other diagnosis --------
    // Whichever error class produced it, a quoted "Did you mean 'x'?" is the
    // single most actionable hint a compiler ever gives, and it is the only
    // remedy we can turn into a real one-click edit. It has to be checked before
    // the category rules below, or e.g. TS2561 ("... does not exist in type ...
    // Did you mean to write 'Bucket'?") gets classified as a plain type mismatch
    // and the fix is thrown away.
    {
        test: function (m) { return extractDidYouMean(m) !== null; },
        build: function (m) {
            let suggestion = extractDidYouMean(m);
            return remedy(
                "Change to '" + suggestion + "'",
                'The compiler found a close match for the identifier at this position.',
                { replaceWord: suggestion }
            );
        }
    },

    // --- imports / missing dependencies -----------------------------------
    {
        test: function (m) {
            return /ModuleNotFoundError|No module named|ERR_MODULE_NOT_FOUND|Cannot find module|TS2307/i.test(m);
        },
        build: function (m, marker, runtimeId) {
            let name = extractQuoted(m);
            return remedy(
                name ? 'Remove or replace the import of "' + name + '"' : 'Fix the import',
                'The sandbox image does not include' + (name ? ' "' + name + '"' : ' that package') +
                    '. It is preinstalled with: ' + librariesFor(runtimeId) + '. The sandbox has no ' +
                    'package manager at run time, so add the dependency to the sandbox image ' +
                    '(sandbox/Dockerfile) and rebuild it if you need it permanently.'
            );
        }
    },

    // --- unresolved names, with no spelling suggestion to offer -------------
    // (When there IS one, the rule above already handled it.)
    {
        test: function (m) {
            return /cannot find symbol|cannot find name|is not defined|NameError|TS2304|TS2551|TS2552|TS2561|does not exist (?:on|in) type/i.test(m);
        },
        build: function (m, marker) {
            let isJava = marker.source === 'javac';
            return remedy(
                'Declare it, import it, or fix the spelling',
                isJava
                    ? 'javac cannot resolve this symbol. Check the spelling, and make sure the ' +
                      'class is imported — the AWS SDK v2 classes live under ' +
                      'software.amazon.awssdk.services.<service>.'
                    : 'This name is not defined in scope. Check the spelling, or add the ' +
                      'assignment/import that introduces it.'
            );
        }
    },

    // --- unbalanced delimiters --------------------------------------------
    {
        test: function (m) { return /was never closed|unexpected EOF|missing \)|Unexpected end of input/i.test(m); },
        build: function (m) {
            let opener = extractQuoted(m);
            return remedy(
                'Close the open ' + (opener ? '"' + opener + '"' : 'bracket'),
                'A bracket, parenthesis, or quote opened here is never closed. The reported ' +
                    'line is where it was OPENED, which is often above where you were typing.'
            );
        }
    },

    // --- indentation -------------------------------------------------------
    {
        test: function (m) { return /IndentationError|TabError|unexpected indent|expected an indented block/i.test(m); },
        build: function (m) {
            return remedy(
                'Fix the indentation of this line',
                /TabError/i.test(m)
                    ? 'This file mixes tabs and spaces. Use spaces consistently (4 per level).'
                    : 'Python needs a consistent indent level. A block opened by a line ending ' +
                      'in ":" must be indented; sibling statements must line up exactly.'
            );
        }
    },

    // --- Java single-file launcher constraints -----------------------------
    {
        test: function (m) { return /is public, should be declared in a file named/i.test(m); },
        build: function () {
            return remedy(
                'Rename the class to ' + sandboxRuntimes.JAVA_CLASS_NAME,
                'The sandbox runs Java through the single-file source launcher, which requires ' +
                    'the public class to be named ' + sandboxRuntimes.JAVA_CLASS_NAME + '.',
                { replaceWord: sandboxRuntimes.JAVA_CLASS_NAME }
            );
        }
    },
    {
        test: function (m) { return /can't find main\(|main method not found|no main method/i.test(m); },
        build: function () {
            return remedy(
                'Add a public static void main(String[] args) method',
                'The single-file launcher needs an entry point: ' +
                    'public static void main(String[] args) inside class ' +
                    sandboxRuntimes.JAVA_CLASS_NAME + '.'
            );
        }
    },

    // --- type mismatches ---------------------------------------------------
    {
        test: function (m) { return /incompatible types|is not assignable to|TS2322|TS2345/i.test(m); },
        build: function (m) {
            return remedy(
                'Match the expected type',
                'The value here has a different type than the target expects. ' +
                    (/TS2345/.test(m)
                        ? 'Check the argument order and shape against the function signature.'
                        : 'Convert the value, or change the declared type.')
            );
        }
    },

    // --- await / async -----------------------------------------------------
    {
        test: function (m) { return /await is only valid|TS1308|top-level await/i.test(m); },
        build: function (m, marker, runtimeId) {
            let runtime = sandboxRuntimes.getRuntime(runtimeId);
            return remedy(
                'Use top-level await or wrap the call in an async function',
                'The sandbox runs ' + (runtime ? runtime.fileName : 'this file') +
                    ' as an ES module, so top-level await IS allowed at the outermost scope. ' +
                    'Inside a plain (non-async) function you must mark the function async.'
            );
        }
    },

    // --- unused / style ----------------------------------------------------
    {
        // tsc's actual wording is "'x' is declared but its value is never read";
        // javac/eslint-style tools say "never used". Both, plus the bare code.
        test: function (m) { return /is declared but never|never used|never read|TS6133|TS6196/i.test(m); },
        build: function () {
            return remedy('Remove the unused declaration', 'Nothing references this. Deleting it is safe.');
        }
    }
];

/**
 * Suggest a fix for a single marker. Returns null when nothing useful can be
 * said — an unhelpful remedy is worse than none, because it trains users to
 * ignore the hint.
 */
function suggestRemedy(marker, runtimeId) {
    if (!marker || !marker.message) {
        return null;
    }
    // Several rules key off a diagnostic code (TS2307, TS6133, ...) which tsc
    // reports in a separate field, not inside the message text. Appending it
    // makes those patterns work without every rule having to check two places.
    // It is safe to extract quoted names from: a code carries no quotes.
    let message = marker.code ? marker.message + ' ' + marker.code : marker.message;
    for (let rule of MARKER_RULES) {
        let matched = false;
        try {
            matched = rule.test(message, marker);
        } catch (e) {
            matched = false;
        }
        if (matched) {
            try {
                return rule.build(message, marker, runtimeId);
            } catch (e) {
                return null;
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Whole-output remedies (no source line to blame)
// ---------------------------------------------------------------------------

// These are the failures that dominate real AWS debugging sessions. Each is a
// banner-level hint: the code is usually fine, the environment isn't.
const OUTPUT_RULES = [
    {
        match: /ExpiredToken|ExpiredTokenException|token (?:has )?expired|The security token included in the request is expired/i,
        title: 'Your AWS session credentials have expired',
        detail: 'Re-authenticate on the host with "aws sso login --profile <your-profile>", then ' +
            'press Run again — the sandbox mints fresh credentials on every run, so no restart is needed.'
    },
    {
        match: /NoCredentialsError|Unable to locate credentials|UnrecognizedClientException|InvalidClientTokenId|credentials were not found/i,
        title: 'No usable AWS credentials reached the sandbox',
        detail: 'Pick a profile with the AWS IAM User or AWS SSO authentication mechanism before ' +
            'running. For an SSO profile, run "aws sso login --profile <your-profile>" on the host first.'
    },
    {
        match: /SignatureDoesNotMatch/i,
        title: 'The request signature did not match',
        detail: 'This usually means the access key and secret key belong to different credentials, ' +
            'or the profile stores a stale secret. Re-save the profile on the Profiles page.'
    },
    {
        match: /AccessDenied|AccessDeniedException|UnauthorizedOperation|not authorized to perform/i,
        title: 'The credentials worked, but the role lacks permission',
        detail: 'Authentication succeeded and the call was rejected by IAM. Check the action and ' +
            'resource named in the message against the role\'s policy — this is not a code error.'
    },
    {
        match: /Throttling|ThrottlingException|RequestLimitExceeded|TooManyRequestsException|Rate exceeded/i,
        title: 'AWS throttled the request',
        detail: 'You are calling faster than the service allows. Add a short sleep between calls, ' +
            'or use the SDK\'s built-in retry/pagination helpers instead of a tight loop.'
    },
    {
        match: /could not connect to the endpoint|EndpointConnectionError|getaddrinfo|ENOTFOUND|UnknownHostException|Network is unreachable/i,
        title: 'The sandbox could not reach the endpoint',
        detail: 'Check the region and endpoint spelling. If this host has no outbound internet ' +
            'access, the sandbox container inherits that restriction.'
    },
    {
        match: /AuthFailure/i,
        title: 'AWS rejected the credentials (AuthFailure)',
        detail: 'Most often a short-lived SSO credential that expired mid-run. Run again to mint a ' +
            'fresh one; if it persists, re-run "aws sso login" on the host.'
    },
    {
        match: /you must specify a region|NoRegionError|Unable to load region|region must be set/i,
        title: 'No AWS region was resolved',
        detail: 'Set a region on the profile, or pass one explicitly in code. The sandbox exports ' +
            'AWS_REGION and AWS_DEFAULT_REGION when the profile has one.'
    }
];

/**
 * Scan a whole run's combined output for environment-level problems. Returns an
 * array (possibly empty) of { title, detail } — de-duplicated, order preserved.
 */
function suggestOutputRemedies(runtimeId, output) {
    if (!output) {
        return [];
    }
    let text = String(output);
    let found = [];
    for (let rule of OUTPUT_RULES) {
        if (rule.match.test(text)) {
            found.push({ title: rule.title, detail: rule.detail });
        }
    }
    return found;
}

module.exports = {
    suggestRemedy: suggestRemedy,
    suggestOutputRemedies: suggestOutputRemedies,
    // Exported for tests.
    _extractDidYouMean: extractDidYouMean,
    _extractQuoted: extractQuoted
};
