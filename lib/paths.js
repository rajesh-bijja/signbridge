"use strict";

/**
 * paths.js
 *
 * Single source of truth for where SignBridge keeps its runtime files.
 *
 * Nothing is stored inside the project directory. Per-user artifacts (profiles,
 * history, favorites, collections, settings) and the self-signed TLS certs all
 * live under one fixed base directory in the user's home:
 *
 *   ~/.signbridge/
 *   ├── artifacts/
 *   │   └── userartifacts/{userName}/{profiles,history,favorites,...}
 *   └── keys/
 *       ├── <KEYNAME>
 *       └── <CERTNAME>
 *
 * The location is intentionally NOT configurable — it is always ~/.signbridge
 * (a dot-directory in the home of whoever runs the process). In Docker the app
 * runs as www-data with HOME=/var/www, so the base dir is /var/www/.signbridge,
 * which compose maps to the host's ~/.signbridge.
 */

let os = require('os');
let path = require('path');
let propertiesReader = require('properties-reader');
let pathSafety = require('./pathSafety');

let props = propertiesReader(path.resolve(__dirname, '../config.properties'));

// Fixed base directory that holds artifacts/ and keys/: ~/.signbridge.
function getBaseDir() {
    return path.join(os.homedir(), '.signbridge');
}

// <baseDir>/artifacts
function getArtifactsDir() {
    let name = props.get('server.artifactsDirName') || 'artifacts';
    return path.join(getBaseDir(), name);
}

// <baseDir>/artifacts/userartifacts
function getUserArtifactsDir() {
    let name = props.get('server.userArtifactsSubDir') || 'userartifacts';
    return path.join(getArtifactsDir(), name);
}

// <baseDir>/artifacts/userartifacts/{userName}
//
// The user name is server-side state — there is no login, and every route stamps
// it from config.properties via authConfig — so this check is not defending
// against a request. It defends against a `defaultUserName` in config.properties
// that contains a path separator, and against a future caller that passes
// something from a request without noticing this becomes a directory.
function getUserDir(userName) {
    let name = String(userName).toLowerCase();
    let segmentErr = pathSafety.assertSafeSegment(name, 'userName');
    if (segmentErr) {
        throw segmentErr;
    }
    return path.join(getUserArtifactsDir(), name);
}

// <baseDir>/keys
function getKeysDir() {
    let name = props.get('server.keysDirName') || 'keys';
    return path.join(getBaseDir(), name);
}

module.exports = {
    getBaseDir: getBaseDir,
    getArtifactsDir: getArtifactsDir,
    getUserArtifactsDir: getUserArtifactsDir,
    getUserDir: getUserDir,
    getKeysDir: getKeysDir
};
