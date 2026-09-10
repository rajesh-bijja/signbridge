"use strict";

/**
 * secretStore.js — encryption at rest for provider API keys.
 *
 * The keys this holds are live billing credentials, and the old design put one
 * of them in a .env file the user edits by hand — which is how a key ends up in
 * a screen share, a backup, or a `git add -A`. Moving them into the artifacts
 * directory only helps if they are not sitting there in plaintext, so they are
 * sealed with AES-256-GCM under a key generated on first use.
 *
 * The threat model, stated plainly because an over-claim here is worse than no
 * encryption at all:
 *
 *   Protects against  — casual disclosure. Keys are unreadable in the settings
 *                       file, so backups, screenshots, `cat`, log scrapes and an
 *                       accidental commit of the artifacts directory do not leak
 *                       a usable credential.
 *   Does NOT protect against — anyone who can read your home directory as you.
 *                       The unwrapping key lives at <keysDir>/llm-secret.key
 *                       (mode 0600) next to the data it unwraps, because there
 *                       is no passphrase prompt in a single-local-user app with
 *                       no login. A local attacker with your uid gets both.
 *
 * That is the same bargain every credential helper on a single-user machine
 * makes (aws/credentials, docker config, kubeconfig) and it is a strict
 * improvement on plaintext. Anything stronger needs an OS keychain, which is
 * out of reach from a Linux container.
 *
 * GCM, not CBC: an auth tag means a truncated or tampered ciphertext fails
 * loudly on open() instead of decrypting into garbage that gets sent to a
 * provider as a key.
 */

let crypto = require('crypto');
let fs = require('fs');
let path = require('path');
let paths = require('../paths');
let log = require('../logger').create('llm/secretStore');

const KEY_FILE_NAME = 'llm-secret.key';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;      // 96 bits, the GCM standard
const ENVELOPE_VERSION = 'v1';

function getKeyFilePath() {
    return path.join(paths.getKeysDir(), KEY_FILE_NAME);
}

// True when a mode grants anything at all to group or other. Pure, so the rule
// itself is testable without touching a filesystem.
function isTooPermissive(mode) {
    return (mode & 0o077) !== 0;
}

/**
 * Re-assert 0600 on an existing key file.
 *
 * Not paranoia — this shipped broken: docker-entrypoint.sh ran `chmod -R 775`
 * over the base dir on every container start, which walked straight over this
 * file and left the wrapping key world-readable with nothing anywhere failing.
 * Creating the file with the right mode is therefore not sufficient; the mode is
 * checked on every read, because a permissions regression is silent by nature
 * and the encryption of the settings file is worth exactly as much as this.
 *
 * Best-effort: a read-only mount is not a reason to refuse to start.
 */
function tightenKeyFile(keyPath) {
    try {
        let mode = fs.statSync(keyPath).mode & 0o777;
        if (isTooPermissive(mode)) {
            fs.chmodSync(keyPath, 0o600);
            log.warn('secretStore: ' + keyPath + ' was mode ' + mode.toString(8) +
                '; tightened to 600.');
        }
    } catch (err) {
        log.warn('secretStore: could not verify permissions on ' + keyPath + ': ' +
            (err && err.message));
    }
}

// Read the wrapping key, generating it on first use. Synchronous on purpose:
// every caller needs it before it can do anything, it is a single 32-byte read,
// and making it async would push the race onto every caller.
function loadOrCreateKey() {
    let keyPath = getKeyFilePath();
    try {
        let existing = fs.readFileSync(keyPath);
        tightenKeyFile(keyPath);
        // A truncated key file would otherwise produce a confusing crypto error
        // on every open; say what is actually wrong.
        if (existing.length === KEY_BYTES) {
            return existing;
        }
        let decoded = Buffer.from(existing.toString('utf8').trim(), 'base64');
        if (decoded.length === KEY_BYTES) {
            return decoded;
        }
        throw new Error('The LLM secret key file at ' + keyPath + ' is not a 32-byte key. ' +
            'Delete it to generate a new one — you will need to re-enter your provider API keys.');
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            throw err;
        }
    }
    let key = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    // 0600 before any bytes land, via the open mode rather than a later chmod —
    // a chmod after write leaves a window where the key is world-readable.
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
}

// Seal a plaintext secret. The envelope carries its own version and IV so the
// algorithm can change later without guessing at the format of old records.
function seal(plaintext) {
    if (plaintext === null || plaintext === undefined || plaintext === '') {
        return null;
    }
    let key = loadOrCreateKey();
    let iv = crypto.randomBytes(IV_BYTES);
    let cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    let tag = cipher.getAuthTag();
    return {
        v: ENVELOPE_VERSION,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: ciphertext.toString('base64')
    };
}

// Open a sealed envelope. Returns null rather than throwing when the envelope is
// absent or unreadable: a settings file that predates encryption, or one carried
// over from a machine whose key file did not come with it, must still load — the
// user is told to re-enter the key, not shown a stack trace on the settings page.
function open(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope.data) {
        return null;
    }
    try {
        let key = loadOrCreateKey();
        let decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        let plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.data, 'base64')),
            decipher.final()
        ]);
        return plaintext.toString('utf8');
    } catch (err) {
        return null;
    }
}

function isSealed(value) {
    return !!(value && typeof value === 'object' && value.v && value.data && value.iv && value.tag);
}

/**
 * The only representation of a key that may leave the server.
 *
 * Shows enough to recognise which key is configured — the prefix identifies the
 * provider and the last four let a user match it against the provider's console
 * list — and not enough to use. Short keys reveal nothing at all rather than
 * revealing most of themselves, which is the case a naive slice gets wrong.
 */
function maskKey(plaintext) {
    if (!plaintext) {
        return null;
    }
    let value = String(plaintext).trim();
    if (value.length <= 12) {
        return '•'.repeat(Math.max(value.length, 4));
    }
    // Keep the provider-identifying prefix (sk-proj-, sk-ant-, crsr_ …).
    let head = value.slice(0, 7);
    let tail = value.slice(-4);
    return head + '…' + '•'.repeat(4) + tail;
}

module.exports = {
    KEY_FILE_NAME: KEY_FILE_NAME,
    getKeyFilePath: getKeyFilePath,
    isTooPermissive: isTooPermissive,
    seal: seal,
    open: open,
    isSealed: isSealed,
    maskKey: maskKey
};
