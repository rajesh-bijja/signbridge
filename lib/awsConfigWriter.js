/**
 * awsConfigWriter.js
 *
 * Part of SignBridge. Licensed under the MIT License.
 *
 * Writes a SignBridge profile back into the user's `~/.aws/config` (and, for
 * IAM-key profiles, `~/.aws/credentials`) so the same profile can be used
 * outside of SignBridge — e.g. by the AWS CLI. This is the "Sync to AWS Config"
 * direction and is the mirror image of loadProfilesDaemon.js (which reads
 * `~/.aws/config` into runtime artifacts).
 *
 * Applies ONLY to AWS IAM User and AWS SSO User profiles. The write is a
 * key-level merge: existing profiles, comments, and unmanaged keys (e.g.
 * `output = json`) in the AWS files are preserved; only the target profile's
 * managed keys are added or updated.
 *
 * Security: this module never logs AWS access keys, secret keys, or any
 * credential values.
 */
"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const authnModes = require('./authnModes');
let log = require('./logger').create('awsConfigWriter');

// Docker fallback (matches loadProfilesDaemon.js): when the container's HOME
// does not resolve to a real ~/.aws, the host directory is bind-mounted here.
const MOUNTED_AWS_DIR = '/var/www/.aws';

// Resolve the AWS directory to write to. Prefer ~/.aws (which, inside Docker,
// already resolves to the bind-mounted host dir since HOME=/var/www), then the
// explicit mount, otherwise fall back to creating ~/.aws.
function resolveAwsDir() {
    let homeAwsDir = path.join(os.homedir(), '.aws');
    try {
        if (fs.existsSync(homeAwsDir) && fs.statSync(homeAwsDir).isDirectory()) {
            return homeAwsDir;
        }
    } catch (e) { /* fall through */ }
    try {
        if (fs.existsSync(MOUNTED_AWS_DIR) && fs.statSync(MOUNTED_AWS_DIR).isDirectory()) {
            return MOUNTED_AWS_DIR;
        }
    } catch (e) { /* fall through */ }
    return homeAwsDir;
}

// Parse an INI-style file into an ordered set of sections while retaining any
// leading (pre-section) content as a preamble. Comments and unmanaged keys are
// kept verbatim inside their section.
function parseIni(content) {
    let preamble = [];
    let sections = [];
    let current = null;
    let lines = content ? content.split(/\r?\n/) : [];
    for (let line of lines) {
        let trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            current = { header: trimmed, lines: [] };
            sections.push(current);
        } else if (current) {
            current.lines.push(line);
        } else {
            preamble.push(line);
        }
    }
    return { preamble: preamble, sections: sections };
}

function serializeIni(parsed) {
    let blocks = [];
    if (parsed.preamble.length) {
        let pre = parsed.preamble.join('\n').replace(/\n+$/, '');
        if (pre.trim()) {
            blocks.push(pre);
        }
    }
    for (let s of parsed.sections) {
        let body = s.lines.join('\n').replace(/\n+$/, '');
        blocks.push(body ? (s.header + '\n' + body) : s.header);
    }
    return blocks.join('\n\n') + '\n';
}

function getOrCreateSection(parsed, header) {
    let sec = parsed.sections.find((s) => s.header === header);
    if (!sec) {
        sec = { header: header, lines: [] };
        parsed.sections.push(sec);
    }
    return sec;
}

// Merge key/value pairs into a section: update the line for a key if present,
// otherwise append it. `kv` is an array of [key, value] entries.
function upsertKeys(sec, kv) {
    for (let [key, value] of kv) {
        let found = false;
        for (let i = 0; i < sec.lines.length; i++) {
            let m = sec.lines[i].match(/^(\s*)([A-Za-z0-9_]+)(\s*)=(.*)$/);
            if (m && m[2] === key) {
                sec.lines[i] = key + ' = ' + value;
                found = true;
                break;
            }
        }
        if (!found) {
            sec.lines.push(key + ' = ' + value);
        }
    }
}

/**
 * Sync a profile into ~/.aws/config (+ ~/.aws/credentials for IAM keys).
 *
 * @param {object} profile - profile object (post-create/update), expected to
 *   carry profileName plus IAM/SSO fields and the *Enabled flags.
 * @param {function} cb - cb(err). On success cb(null, { configFile, credentialsFile? }).
 */
function syncProfileToAwsConfig(profile, cb) {
    try {
        if (!profile || !profile.profileName) {
            return cb(new Error('syncProfileToAwsConfig: profileName is required'));
        }
        let isAwsProfile = authnModes.profileHasAwsConfigSyncableMode(profile);
        if (!isAwsProfile) {
            // Sync only applies to the AWS profile types that ~/.aws/config can
            // express — see authnModes.isAwsConfigSyncable.
            return cb(null, {});
        }

        let awsDir = resolveAwsDir();
        if (!fs.existsSync(awsDir)) {
            fs.mkdirSync(awsDir, { recursive: true });
        }

        let profileName = profile.profileName;
        let isDefault = profileName === 'default';

        // ----- config file -----
        let configFile = path.join(awsDir, 'config');
        let configHeader = isDefault ? '[default]' : '[profile ' + profileName + ']';
        let configContent = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf-8') : '';
        let configParsed = parseIni(configContent);
        let configSec = getOrCreateSection(configParsed, configHeader);

        let configKv = [];
        if (profile.awsSsoUserEnabled) {
            if (profile.ssoRegion) configKv.push(['sso_region', profile.ssoRegion]);
            if (profile.awsSsoStartUrl) configKv.push(['sso_start_url', profile.awsSsoStartUrl]);
            if (profile.awsSsoAccountId) configKv.push(['sso_account_id', profile.awsSsoAccountId]);
            if (profile.awsSsoRoleName) configKv.push(['sso_role_name', profile.awsSsoRoleName]);
        }
        if (profile.region) {
            configKv.push(['region', profile.region]);
        }
        // Default the AWS CLI output format so the profile is directly usable
        // outside SignBridge. upsertKeys only adds this when absent, so a user's
        // existing `output` value is preserved on re-sync.
        if (!configSec.lines.some((line) => /^\s*output\s*=/.test(line))) {
            configKv.push(['output', 'json']);
        }
        upsertKeys(configSec, configKv);
        fs.writeFileSync(configFile, serializeIni(configParsed), 'utf-8');

        let result = { configFile: configFile };

        // ----- credentials file (IAM keys only) -----
        if (profile.awsIamUserEnabled && profile.awsAccessKeyId && profile.awsSecretAccessKey) {
            let credentialsFile = path.join(awsDir, 'credentials');
            let credHeader = '[' + profileName + ']';
            let credContent = fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile, 'utf-8') : '';
            let credParsed = parseIni(credContent);
            let credSec = getOrCreateSection(credParsed, credHeader);
            upsertKeys(credSec, [
                ['aws_access_key_id', profile.awsAccessKeyId],
                ['aws_secret_access_key', profile.awsSecretAccessKey]
            ]);
            // Credentials must not be world/group readable.
            fs.writeFileSync(credentialsFile, serializeIni(credParsed), { encoding: 'utf-8', mode: 0o600 });
            result.credentialsFile = credentialsFile;
        }

        log.debug('syncProfileToAwsConfig: profile "' + profileName + '" synced to ' + configFile +
            (result.credentialsFile ? ' and ' + result.credentialsFile : ''));
        return cb(null, result);
    } catch (e) {
        log.error('syncProfileToAwsConfig: failed to sync profile to AWS config: ', e.message);
        return cb(e);
    }
}

// Remove a section (by exact header) from a parsed INI, if present. Returns
// true if a section was removed.
function removeSection(parsed, header) {
    let before = parsed.sections.length;
    parsed.sections = parsed.sections.filter((s) => s.header !== header);
    return parsed.sections.length !== before;
}

/**
 * Remove a profile from ~/.aws/config (+ ~/.aws/credentials). The mirror of
 * syncProfileToAwsConfig, used when a synced profile is deleted so the two
 * stores stay consistent. Only applies to AWS IAM User / AWS SSO User profiles.
 * Other profiles / a missing AWS file are a no-op (not an error).
 *
 * @param {object} profile - must carry profileName plus the *Enabled flags.
 * @param {function} cb - cb(err). On success cb(null, { removedFromConfig, removedFromCredentials }).
 */
function removeProfileFromAwsConfig(profile, cb) {
    try {
        if (!profile || !profile.profileName) {
            return cb(new Error('removeProfileFromAwsConfig: profileName is required'));
        }
        let isAwsProfile = authnModes.profileHasAwsConfigSyncableMode(profile);
        if (!isAwsProfile) {
            return cb(null, {});
        }

        let awsDir = resolveAwsDir();
        let profileName = profile.profileName;
        let isDefault = profileName === 'default';
        let result = { removedFromConfig: false, removedFromCredentials: false };

        // ----- config file -----
        let configFile = path.join(awsDir, 'config');
        if (fs.existsSync(configFile)) {
            let configParsed = parseIni(fs.readFileSync(configFile, 'utf-8'));
            let configHeader = isDefault ? '[default]' : '[profile ' + profileName + ']';
            if (removeSection(configParsed, configHeader)) {
                fs.writeFileSync(configFile, serializeIni(configParsed), 'utf-8');
                result.removedFromConfig = true;
            }
        }

        // ----- credentials file -----
        let credentialsFile = path.join(awsDir, 'credentials');
        if (fs.existsSync(credentialsFile)) {
            let credParsed = parseIni(fs.readFileSync(credentialsFile, 'utf-8'));
            if (removeSection(credParsed, '[' + profileName + ']')) {
                fs.writeFileSync(credentialsFile, serializeIni(credParsed), { encoding: 'utf-8', mode: 0o600 });
                result.removedFromCredentials = true;
            }
        }

        log.debug('removeProfileFromAwsConfig: profile "' + profileName + '" removed from AWS config' +
            ' (config=' + result.removedFromConfig + ', credentials=' + result.removedFromCredentials + ')');
        return cb(null, result);
    } catch (e) {
        log.error('removeProfileFromAwsConfig: failed to remove profile from AWS config: ', e.message);
        return cb(e);
    }
}

module.exports = {
    syncProfileToAwsConfig: syncProfileToAwsConfig,
    removeProfileFromAwsConfig: removeProfileFromAwsConfig,
    // exported for tests
    _parseIni: parseIni,
    _removeSection: removeSection,
    _serializeIni: serializeIni,
    _upsertKeys: upsertKeys,
    _resolveAwsDir: resolveAwsDir
};
