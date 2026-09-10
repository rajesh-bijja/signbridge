"use strict";

/**
 * sandboxService.js
 *
 * The Express layer for Sandbox mode — the third invocation mode alongside
 * Rest_Api and Cli. It ties together the pure sandbox modules and the rest of
 * SignBridge:
 *
 *   profile  -> sandboxCredentials -> sandboxRunner -> sandboxDiagnostics
 *                                          |
 *                                          +-> Socket.IO live output
 *                                          +-> invocation history
 *
 * Design notes
 *   - A sandbox run is a first-class invocation: it lands in history with
 *     invocationMode 'Sandbox', exactly like a Rest_Api or Cli invocation, so
 *     the History and Favorites pages work with it unchanged.
 *   - Output streams live over the same Socket.IO connection the chat uses
 *     (event `event_sandbox_stream_<userName>`), and the HTTP response carries
 *     the full result. A client that misses socket events still gets everything.
 *   - The code a user types is their own text and is stored in history. AWS
 *     secrets are NOT: they are resolved per run, held in memory, handed to the
 *     container by variable name, and never written to the history payload.
 */

const profileUtils = require('../profileUtils');
const credentialProvider = require('../credentialProvider');
const coreUtils = require('../coreUtils');
const authConfig = require('../authConfig');

const sandboxRuntimes = require('./sandboxRuntimes');
const sandboxCredentials = require('./sandboxCredentials');
const sandboxDiagnostics = require('./sandboxDiagnostics');
const sandboxRemedies = require('./sandboxRemedies');
const sandboxRunner = require('./sandboxRunner');
const sandboxStore = require('./sandboxStore');
const sandboxCompletions = require('./sandboxCompletions');
let log = require('../logger').create('sandbox/sandboxService');

const STREAM_EVENT_PREFIX = 'event_sandbox_stream_';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUser(req) {
    let options = (req.body && req.body.options) || {};
    return options.userName || (req.body && req.body.userName) || authConfig.resolveUserName();
}

function optionsOf(req) {
    return (req.body && req.body.options) || req.body || {};
}

function badRequest(res, message) {
    return res.status(400).json({ message: message });
}

/**
 * Emit a sandbox lifecycle/output event to every live socket of the user.
 * Best-effort: the HTTP response is always the authoritative result.
 */
function emit(userName, payload) {
    coreUtils.emitToUser(userName, STREAM_EVENT_PREFIX + userName, payload);
}

/**
 * Resolve the credentials for a run from the selected profile.
 * cb(err, { env, hasAwsCredentials, region, expiresAtMs, profile })
 *
 * Non-AWS modes (and "no profile selected") resolve successfully with no AWS
 * credentials — the sandbox is still fully usable for REST work.
 */
function resolveRunCredentials(userName, profileName, authnMode, region, cb) {
    if (!sandboxCredentials.isAwsAuthnMode(authnMode) || !profileName) {
        let built;
        try {
            built = sandboxCredentials.buildSandboxEnv(null, authnMode, null, { region: region });
        } catch (e) {
            return cb(e);
        }
        return cb(null, Object.assign({ expiresAtMs: null, profile: null }, built));
    }

    // One call covers all four AWS modes: IAM keys straight off the profile, or
    // freshly minted temporary credentials from SSO / EC2 IMDS / IRSA. The
    // provider owns the refresh buffer and the mode-specific "here's what to do"
    // guidance, so nothing here needs to know how a credential was obtained.
    credentialProvider.resolveByProfileName(userName, profileName, authnMode, function (credErr, resolved) {
        if (credErr) {
            credErr.statusCode = credErr.statusCode || 401;
            return cb(credErr);
        }
        let built;
        try {
            built = sandboxCredentials.buildSandboxEnv(resolved.profile, resolved.authnMode,
                resolved.credentials, { region: region });
        } catch (e) {
            return cb(e);
        }
        return cb(null, Object.assign({
            expiresAtMs: resolved.expiresAtMs,
            profile: resolved.profile
        }, built));
    });
}

/**
 * Build the history payload for a run. Deliberately explicit about what goes in:
 * everything here is written to disk, so it lists the fields one by one rather
 * than spreading the request options (which could pick up something secret if
 * the request shape ever changes).
 */
function historyPayload(options, runtime, result, credentialSummary) {
    return {
        userName: options.userName,
        profileName: options.profileName || 'None',
        authnMode: options.authnMode || 'generic',
        method: 'Sandbox',
        invocationMode: 'Sandbox',
        runtimeId: runtime.id,
        runtimeLabel: runtime.label,
        fileName: runtime.fileName,
        // The user's own source. No credentials appear here.
        code: options.code,
        scriptId: options.scriptId || null,
        region: credentialSummary ? credentialSummary.region : null,
        // Names only, never values.
        injectedEnv: credentialSummary ? credentialSummary.names : [],
        exitCode: result ? result.exitCode : null,
        durationMs: result ? result.durationMs : null,
        timedOut: result ? !!result.timedOut : false,
        cancelled: result ? !!result.cancelled : false
    };
}

// ---------------------------------------------------------------------------
// GET-ish metadata endpoints
// ---------------------------------------------------------------------------

/**
 * Everything the IDE needs to boot: the language registry, the current limits,
 * and whether Docker + the sandbox image are actually ready. Reporting
 * readiness here means the UI can show one clear setup message instead of
 * failing on the user's first Run.
 */
function getSandboxRuntimes(req, res) {
    sandboxRunner.preflight(function (err, status) {
        if (err) {
            return res.status(500).json({ message: err.message });
        }
        res.status(200).json({
            runtimes: sandboxRuntimes.describeRuntimes(),
            preflight: status,
            limits: {
                timeoutSeconds: Math.round(sandboxRunner.DEFAULT_TIMEOUT_MS / 1000),
                checkTimeoutSeconds: Math.round(sandboxRunner.CHECK_TIMEOUT_MS / 1000),
                maxCodeBytes: sandboxRunner.MAX_CODE_BYTES,
                maxOutputBytes: sandboxRunner.MAX_OUTPUT_BYTES,
                maxConcurrentRuns: sandboxRunner.MAX_CONCURRENT_RUNS_PER_USER,
                maxSavedScripts: sandboxStore.MAX_SCRIPTS_PER_USER
            },
            streamEvent: STREAM_EVENT_PREFIX + resolveUser(req)
        });
    });
}

/**
 * Starter code for a language/template.
 */
function getSandboxTemplate(req, res) {
    let options = optionsOf(req);
    let template = sandboxRuntimes.getTemplate(options.runtimeId, options.templateId);
    if (!template) {
        return badRequest(res, 'sandbox: unsupported language "' + options.runtimeId + '"');
    }
    res.status(200).json(template);
}

/**
 * Completion data for the editor.
 *
 *   { runtimeId }            -> language globals (the `boto3.` case) + service list
 *   { runtimeId, service }   -> the full operation index for that AWS service
 */
function getSandboxCompletions(req, res) {
    let options = optionsOf(req);
    let userName = resolveUser(req);
    let runtimeId = options.runtimeId;

    if (!options.service) {
        return res.status(200).json({
            runtimeId: runtimeId || null,
            globals: sandboxCompletions.getLanguageGlobals(runtimeId),
            services: sandboxCompletions.listServiceNames()
        });
    }

    sandboxCompletions.getServiceIndex(userName, options.service, {
        includeParams: options.includeParams !== false
    }).then(function (index) {
        res.status(200).json(index);
    }).catch(function (err) {
        res.status(err.statusCode || 502).json({
            message: 'sandbox: could not load the API model for "' + options.service + '": ' + err.message
        });
    });
}

// ---------------------------------------------------------------------------
// Run / check / cancel
// ---------------------------------------------------------------------------

/**
 * Execute the user's code in a sandbox container with the selected profile's
 * credentials. This is the "play button".
 */
function runSandbox(req, res) {
    let options = optionsOf(req);
    let userName = resolveUser(req);
    options.userName = userName;

    let runtime = sandboxRuntimes.getRuntime(options.runtimeId);
    if (!runtime) {
        return badRequest(res, 'sandbox: unsupported language "' + options.runtimeId +
            '". Supported: ' + sandboxRuntimes.listRuntimeIds().join(', '));
    }
    if (typeof options.code !== 'string' || options.code.trim().length === 0) {
        return badRequest(res, 'sandbox: there is no code to run.');
    }

    resolveRunCredentials(userName, options.profileName, options.authnMode, options.region,
        function (credErr, resolved) {
            if (credErr) {
                emit(userName, { type: 'error', message: credErr.message });
                return res.status(credErr.statusCode || 400).json({
                    message: credErr.message,
                    ssoSessionExpired: !!credErr.ssoSessionExpired,
                    verificationUriComplete: credErr.verificationUriComplete || null
                });
            }

            let credentialSummary = sandboxCredentials.describeCredentials(resolved);

            sandboxRunner.execute({
                userName: userName,
                runtimeId: runtime.id,
                code: options.code,
                mode: 'run',
                env: resolved.env,
                onStart: function (info) {
                    emit(userName, {
                        type: 'start',
                        runId: info.runId,
                        runtimeId: runtime.id,
                        region: credentialSummary.region,
                        hasAwsCredentials: credentialSummary.hasAwsCredentials,
                        injectedEnv: credentialSummary.names,
                        credentialsExpireAt: resolved.expiresAtMs || null
                    });
                },
                onOutput: function (chunk) {
                    emit(userName, {
                        type: 'output',
                        runId: chunk.runId,
                        stream: chunk.stream,
                        chunk: chunk.chunk
                    });
                }
            }, function (runErr, result) {
                if (runErr) {
                    emit(userName, { type: 'error', message: runErr.message });
                    return res.status(runErr.sandboxNotReady ? 503 : 400).json({
                        message: runErr.message,
                        preflight: runErr.preflight || null
                    });
                }

                // A non-zero exit means something went wrong: map it back to the
                // source line so the editor can underline it.
                let diagnostics = result.exitCode === 0
                    ? []
                    : sandboxDiagnostics.parseRuntimeDiagnostics(runtime.id, result.output);
                let outputRemedies = sandboxRemedies.suggestOutputRemedies(runtime.id, result.output);

                let response = {
                    runId: result.runId,
                    runtimeId: runtime.id,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    output: result.output,
                    durationMs: result.durationMs,
                    timedOut: result.timedOut,
                    cancelled: result.cancelled,
                    truncated: result.truncated,
                    diagnostics: diagnostics,
                    remedies: outputRemedies,
                    region: credentialSummary.region,
                    hasAwsCredentials: credentialSummary.hasAwsCredentials,
                    injectedEnv: credentialSummary.names,
                    credentialsExpireAt: resolved.expiresAtMs || null,
                    // Explain a kill so the console can say why, instead of
                    // showing a bare exit code.
                    stoppedReason: result.timedOut
                        ? 'The run exceeded the ' + Math.round(result.timeoutMs / 1000) + 's time limit and was stopped.'
                        : (result.cancelled ? 'The run was stopped.' : null)
                };

                emit(userName, Object.assign({ type: 'end' }, response, {
                    stdout: undefined, stderr: undefined, output: undefined
                }));

                if (options.scriptId) {
                    sandboxStore.recordRun(userName, options.scriptId, result);
                }

                // Two different questions, two different answers.
                //
                // History wants to know whether the user's INVOCATION worked, so a
                // non-zero exit is recorded as a failure there — that is what makes
                // a bad run findable in the history list.
                //
                // The HTTP status answers a narrower question: did this API call
                // succeed? It did. We accepted the request, ran the container, and
                // are returning a complete result with an `exitCode` field in it. A
                // Python traceback is the payload, not a protocol error. Returning
                // 400 here made axios reject a perfectly good response, so the UI
                // showed a bare "Request failed with status code 400" banner above
                // the very output that explained what went wrong.
                let historyStatusCode = result.exitCode === 0 ? 200 : 400;
                profileUtils.createHistory(
                    userName,
                    historyPayload(options, runtime, result, credentialSummary),
                    historyStatusCode,
                    {},
                    result.output,
                    function (historyErr) {
                        if (historyErr) {
                            log.warn('sandboxService: could not record history: ', historyErr.message);
                        }
                        res.status(200).json(response);
                    }
                );
            });
        });
}

/**
 * Syntax/type-check the code without running it — the "Validate" action, and
 * what the editor calls to refresh its red squiggles.
 *
 * No credentials are injected and the container gets no network: a check has no
 * business talking to AWS. This is also why it is safe to call frequently.
 */
function checkSandbox(req, res) {
    let options = optionsOf(req);
    let userName = resolveUser(req);

    let runtime = sandboxRuntimes.getRuntime(options.runtimeId);
    if (!runtime) {
        return badRequest(res, 'sandbox: unsupported language "' + options.runtimeId + '"');
    }
    if (typeof options.code !== 'string' || options.code.trim().length === 0) {
        return res.status(200).json({
            runtimeId: runtime.id,
            checkKind: runtime.checkKind,
            exitCode: 0,
            diagnostics: [],
            output: ''
        });
    }

    sandboxRunner.execute({
        userName: userName,
        runtimeId: runtime.id,
        code: options.code,
        mode: 'check',
        env: {}
    }, function (checkErr, result) {
        if (checkErr) {
            return res.status(checkErr.sandboxNotReady ? 503 : 400).json({
                message: checkErr.message,
                preflight: checkErr.preflight || null
            });
        }
        res.status(200).json({
            runId: result.runId,
            runtimeId: runtime.id,
            checkKind: runtime.checkKind,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            output: result.output,
            diagnostics: sandboxDiagnostics.parseCheckDiagnostics(runtime.id, result.output)
        });
    });
}

/**
 * Stop a run. The container is killed; the run's own handler reports the
 * partial output back through the original request.
 */
function cancelSandbox(req, res) {
    let options = optionsOf(req);
    let userName = resolveUser(req);
    if (!options.runId) {
        return badRequest(res, 'sandbox: runId is required to stop a run.');
    }
    let stopped = sandboxRunner.cancel(options.runId, userName);
    res.status(stopped ? 200 : 404).json({
        runId: options.runId,
        stopped: stopped,
        message: stopped ? 'Stopping the run.' : 'That run is no longer active.'
    });
}

// ---------------------------------------------------------------------------
// Saved scripts
// ---------------------------------------------------------------------------

function listSandboxScripts(req, res) {
    try {
        res.status(200).json({ scripts: sandboxStore.listScripts(resolveUser(req)) });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
}

function getSandboxScript(req, res) {
    let options = optionsOf(req);
    if (!options.scriptId) {
        return badRequest(res, 'sandbox: scriptId is required.');
    }
    try {
        let script = sandboxStore.getScript(resolveUser(req), options.scriptId);
        if (!script) {
            return res.status(404).json({ message: 'sandbox: that script no longer exists.' });
        }
        res.status(200).json(script);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
}

/**
 * Create or update, decided by the presence of a scriptId — one endpoint so the
 * IDE's Save button does not have to know which it is.
 */
function saveSandboxScript(req, res) {
    let options = optionsOf(req);
    let userName = resolveUser(req);
    try {
        if (options.scriptId) {
            let updated = sandboxStore.updateScript(userName, options.scriptId, options);
            if (!updated) {
                return res.status(404).json({ message: 'sandbox: that script no longer exists.' });
            }
            return res.status(200).json(updated);
        }
        res.status(200).json(sandboxStore.createScript(userName, options));
    } catch (e) {
        res.status(e.statusCode || 400).json({ message: e.message });
    }
}

function deleteSandboxScript(req, res) {
    let options = optionsOf(req);
    if (!options.scriptId) {
        return badRequest(res, 'sandbox: scriptId is required.');
    }
    try {
        let removed = sandboxStore.deleteScript(resolveUser(req), options.scriptId);
        if (!removed) {
            return res.status(404).json({ message: 'sandbox: that script no longer exists.' });
        }
        res.status(200).json({ scriptId: options.scriptId, deleted: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
}

module.exports = {
    STREAM_EVENT_PREFIX: STREAM_EVENT_PREFIX,
    getSandboxRuntimes: getSandboxRuntimes,
    getSandboxTemplate: getSandboxTemplate,
    getSandboxCompletions: getSandboxCompletions,
    runSandbox: runSandbox,
    checkSandbox: checkSandbox,
    cancelSandbox: cancelSandbox,
    listSandboxScripts: listSandboxScripts,
    getSandboxScript: getSandboxScript,
    saveSandboxScript: saveSandboxScript,
    deleteSandboxScript: deleteSandboxScript
};
