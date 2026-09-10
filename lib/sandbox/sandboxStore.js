"use strict";

/**
 * sandboxStore.js
 *
 * Persistence for saved sandbox scripts, so work in the IDE survives a page
 * reload. File-backed under the user's artifacts dir, matching the rest of
 * SignBridge's storage model (no database, everything inspectable on disk):
 *
 *   <userDir>/sandbox/scripts/<scriptId>.json
 *
 * One JSON file per script, holding the code plus the language/profile it was
 * written against. Metadata listings never carry the code — the IDE lists names
 * and fetches a body only when a script is opened.
 *
 * Nothing secret is ever stored here: a script's *code* is the user's own text,
 * and the credentials it runs with are resolved per run from the selected
 * profile, never saved alongside it.
 */

const fs = require('fs');
const path = require('path');
const propertiesReader = require('properties-reader');
const { randomUUID: uuidv4 } = require('crypto');

const paths = require('../paths');
const sandboxRuntimes = require('./sandboxRuntimes');
let log = require('../logger').create('sandbox/sandboxStore');

const props = propertiesReader(path.resolve(__dirname, '../../config.properties'));

const SANDBOX_DIR_NAME = props.get('server.sandboxDirName') || 'sandbox';
const SCRIPTS_DIR_NAME = props.get('server.sandboxScriptsDirName') || 'scripts';

// A generous cap that still stops a runaway client from filling the disk.
const MAX_SCRIPTS_PER_USER = parseInt(props.get('sandbox.maxSavedScripts') || 200, 10);
const MAX_NAME_LENGTH = 120;

function scriptsDir(userName) {
    let dir = path.join(
        paths.getUserDir(String(userName).toLowerCase()),
        SANDBOX_DIR_NAME,
        SCRIPTS_DIR_NAME
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Script ids are generated, never client-supplied, and validated on the way back
 * in — a script id becomes a path segment, so this is what stops `../` from
 * escaping the scripts directory.
 */
const SCRIPT_ID_PATTERN = /^[a-f0-9]{32}$/;

function isValidScriptId(scriptId) {
    return typeof scriptId === 'string' && SCRIPT_ID_PATTERN.test(scriptId);
}

function scriptFile(userName, scriptId) {
    if (!isValidScriptId(scriptId)) {
        return null;
    }
    return path.join(scriptsDir(userName), scriptId + '.json');
}

function sanitizeName(name, runtimeId) {
    let value = String(name || '').replace(/[\r\n\t]/g, ' ').trim();
    if (!value) {
        let runtime = sandboxRuntimes.getRuntime(runtimeId);
        value = 'Untitled ' + (runtime ? runtime.label : 'script');
    }
    return value.slice(0, MAX_NAME_LENGTH);
}

function readScriptFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeScriptFile(file, script) {
    fs.writeFileSync(file, JSON.stringify(script, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Strip the code out of a stored script for list responses.
 */
function toMetadata(script) {
    return {
        scriptId: script.scriptId,
        name: script.name,
        runtimeId: script.runtimeId,
        profileName: script.profileName || null,
        authnMode: script.authnMode || null,
        codeLength: typeof script.code === 'string' ? script.code.length : 0,
        createdAt: script.createdAt,
        updatedAt: script.updatedAt,
        lastRunAt: script.lastRunAt || null,
        lastExitCode: typeof script.lastExitCode === 'number' ? script.lastExitCode : null
    };
}

/**
 * List a user's saved scripts, most recently updated first. Metadata only.
 */
function listScripts(userName) {
    let dir = scriptsDir(userName);
    let scripts = [];
    for (let entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.json')) {
            continue;
        }
        let script = readScriptFile(path.join(dir, entry));
        if (script && script.scriptId) {
            scripts.push(toMetadata(script));
        }
    }
    scripts.sort(function (a, b) {
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    return scripts;
}

/**
 * Read one script, code included. Returns null when it does not exist.
 */
function getScript(userName, scriptId) {
    let file = scriptFile(userName, scriptId);
    if (!file || !fs.existsSync(file)) {
        return null;
    }
    return readScriptFile(file);
}

/**
 * Create a new script.
 * @returns the stored script (code included)
 */
function createScript(userName, input) {
    input = input || {};
    if (!sandboxRuntimes.isSupportedRuntime(input.runtimeId)) {
        let error = new Error('sandbox: unsupported language "' + input.runtimeId + '"');
        error.statusCode = 400;
        throw error;
    }
    let existing = fs.readdirSync(scriptsDir(userName)).filter(function (f) {
        return f.endsWith('.json');
    });
    if (existing.length >= MAX_SCRIPTS_PER_USER) {
        let error = new Error('sandbox: you have reached the limit of ' + MAX_SCRIPTS_PER_USER +
            ' saved scripts. Delete one to save another.');
        error.statusCode = 400;
        throw error;
    }

    let now = new Date().toISOString();
    let script = {
        scriptId: uuidv4().replace(/-/g, ''),
        name: sanitizeName(input.name, input.runtimeId),
        runtimeId: sandboxRuntimes.getRuntime(input.runtimeId).id,
        code: typeof input.code === 'string' ? input.code : '',
        profileName: input.profileName || null,
        authnMode: input.authnMode || null,
        createdAt: now,
        updatedAt: now
    };
    writeScriptFile(scriptFile(userName, script.scriptId), script);
    return script;
}

/**
 * Update a script in place. Only the fields present in `input` are changed, so a
 * "rename" and a "save the code" are the same call with different payloads.
 */
function updateScript(userName, scriptId, input) {
    input = input || {};
    let file = scriptFile(userName, scriptId);
    if (!file || !fs.existsSync(file)) {
        return null;
    }
    let script = readScriptFile(file);
    if (!script) {
        return null;
    }

    if (input.runtimeId !== undefined) {
        if (!sandboxRuntimes.isSupportedRuntime(input.runtimeId)) {
            let error = new Error('sandbox: unsupported language "' + input.runtimeId + '"');
            error.statusCode = 400;
            throw error;
        }
        script.runtimeId = sandboxRuntimes.getRuntime(input.runtimeId).id;
    }
    if (input.name !== undefined) {
        script.name = sanitizeName(input.name, script.runtimeId);
    }
    if (input.code !== undefined) {
        script.code = typeof input.code === 'string' ? input.code : '';
    }
    if (input.profileName !== undefined) {
        script.profileName = input.profileName || null;
    }
    if (input.authnMode !== undefined) {
        script.authnMode = input.authnMode || null;
    }
    script.updatedAt = new Date().toISOString();
    writeScriptFile(file, script);
    return script;
}

/**
 * Record the outcome of a run against the script it came from, so the list can
 * show "last run" without the client having to track it. Best-effort: a failure
 * to annotate must never fail the run that just completed.
 */
function recordRun(userName, scriptId, result) {
    if (!isValidScriptId(scriptId)) {
        return false;
    }
    try {
        let file = scriptFile(userName, scriptId);
        if (!file || !fs.existsSync(file)) {
            return false;
        }
        let script = readScriptFile(file);
        if (!script) {
            return false;
        }
        script.lastRunAt = new Date().toISOString();
        script.lastExitCode = result && typeof result.exitCode === 'number' ? result.exitCode : null;
        // Deliberately NOT bumping updatedAt: running a script is not editing it,
        // and the list is ordered by edit time.
        writeScriptFile(file, script);
        return true;
    } catch (e) {
        log.warn('sandboxStore: could not record run for script ', scriptId, ': ', e.message);
        return false;
    }
}

function deleteScript(userName, scriptId) {
    let file = scriptFile(userName, scriptId);
    if (!file || !fs.existsSync(file)) {
        return false;
    }
    fs.unlinkSync(file);
    return true;
}

module.exports = {
    MAX_SCRIPTS_PER_USER: MAX_SCRIPTS_PER_USER,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    listScripts: listScripts,
    getScript: getScript,
    createScript: createScript,
    updateScript: updateScript,
    deleteScript: deleteScript,
    recordRun: recordRun,
    // Exported for tests.
    isValidScriptId: isValidScriptId,
    _sanitizeName: sanitizeName,
    _scriptsDir: scriptsDir
};
