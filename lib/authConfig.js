"use strict";

// SignBridge has no login. Every request runs as a single local user whose
// identity comes from config.properties ([auth] section) or defaults below.

let path = require('path');
let propertiesReader = require('properties-reader');

let props = propertiesReader(path.resolve(__dirname, '../config.properties'));

const DEFAULT_USER_NAME = 'signbridgeuser';

function getDefaultUserName() {
    return props.get('auth.defaultUserName') || DEFAULT_USER_NAME;
}

function getDefaultDisplayName() {
    return props.get('auth.defaultDisplayName') || 'SignBridge User';
}

function getDefaultEmail() {
    return props.get('auth.defaultEmail') || (getDefaultUserName() + '@localhost');
}

function getDefaultUserSession() {
    return {
        userName: getDefaultUserName(),
        displayName: getDefaultDisplayName(),
        emailAddress: getDefaultEmail()
    };
}

// There is no per-request user; always resolve to the single local user.
function resolveUserName() {
    return getDefaultUserName().toLowerCase();
}

// Stamp the local user onto every relevant part of the request payload.
function applyDefaultUserToRequest(req) {
    if (req && req.body) {
        let defaultUserName = getDefaultUserName();
        req.body.userName = defaultUserName;
        if (req.body.options) {
            req.body.options.userName = defaultUserName;
        }
        if (req.body.profile) {
            req.body.profile.userName = defaultUserName;
        }
        if (req.body.settings) {
            req.body.settings.userName = defaultUserName;
        }
    }
}

function ensureOptionsUserName(options) {
    if (!options) {
        return {
            userName: getDefaultUserName()
        };
    }
    options.userName = getDefaultUserName();
    return options;
}

module.exports = {
    getDefaultUserName: getDefaultUserName,
    getDefaultDisplayName: getDefaultDisplayName,
    getDefaultEmail: getDefaultEmail,
    getDefaultUserSession: getDefaultUserSession,
    resolveUserName: resolveUserName,
    applyDefaultUserToRequest: applyDefaultUserToRequest,
    ensureOptionsUserName: ensureOptionsUserName
};
