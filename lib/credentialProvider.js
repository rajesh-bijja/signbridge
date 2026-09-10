"use strict";

// The one place that turns (profile, authnMode) into AWS credentials.
//
// Before this module existed, four call sites each hand-rolled the same
// `if (authnMode === 'sso_user') ... else if (authnMode === 'iam_user') ... else 400`
// chain: lib/requestSigner.js (presign and invoke), lib/s3/s3World.js,
// lib/sandbox/sandboxService.js and lib/awsCliUtils.js. Adding EC2 and IRSA that
// way would have meant eight new branches that must stay in agreement about
// refresh buffers, error text and SSO authorize links. They now all call
// resolveAwsCredentials(), so a new AWS profile type is one entry in
// lib/authnModes.js plus one case here.
//
// The returned credential set is deliberately uniform:
//
//   { accessKeyId, secretAccessKey, sessionToken? }
//
// Downstream signers should branch on **whether a session token is present**,
// not on the mode that produced it. SSO, EC2 instance profiles and IRSA all
// yield the same STS triple, so the existing sso* signers carry them unchanged;
// only long-lived IAM user keys lack a token. That is why adding two profile
// types required no new signer.

let profileUtils = require('./profileUtils');
let authnModes = require('./authnModes');
let authConfig = require('./authConfig');
let ssoUtils = require('./ssoUtils');
let ec2Utils = require('./ec2Utils');
// NOTE: irsaUtils is required lazily inside resolveAwsCredentials. It needs this
// module to resolve its *base* profile's credentials, and requiring it at load
// time would close the cycle.

// Which mechanism to use when the caller did not name one. A profile can enable
// several; prefer the caller's choice, else the profile's stored default, else
// the first AWS mechanism it supports in authnModes declaration order (which
// keeps sso_user/iam_user winning for every profile that predates EC2/IRSA).
function resolveAuthnMode(profile, requestedAuthnMode) {
    let supported = (profile && profile.supportedAuthnMechanisms) || [];
    if (requestedAuthnMode) {
        return String(requestedAuthnMode).toLowerCase();
    }
    if (profile && profile.defaultAuthnMode && supported.indexOf(profile.defaultAuthnMode) >= 0) {
        return profile.defaultAuthnMode;
    }
    let firstAws = authnModes.AWS_MODES.find((mode) => supported.indexOf(mode) >= 0);
    return firstAws || null;
}

function unsupportedModeError(profile, authnMode) {
    let supported = (profile && profile.supportedAuthnMechanisms) || [];
    let awsSupported = supported.filter(authnModes.isAwsAuthnMode);
    let message;
    if (!authnMode) {
        message = 'Profile "' + (profile && profile.profileName) + '" offers no AWS authentication mechanism. ' +
            'AWS requests need an IAM user, SSO, EC2 instance or IRSA profile.';
    } else if (!authnModes.isAwsAuthnMode(authnMode)) {
        message = 'Authentication mechanism "' + authnMode + '" does not provide AWS credentials. ' +
            'Use one of: ' + authnModes.AWS_MODES.join(', ') + '.';
    } else if (supported.indexOf(authnMode) < 0) {
        message = 'Profile "' + (profile && profile.profileName) + '" does not support "' + authnMode + '". ' +
            'It supports: ' + (awsSupported.length ? awsSupported.join(', ') : 'no AWS mechanism') + '.';
    } else {
        message = 'Authentication mechanism "' + authnMode + '" is not implemented.';
    }
    let err = new Error(message);
    err.statusCode = 400;
    return err;
}

// Long-lived IAM user keys, straight off the profile. The only mode with no
// expiry and no session token.
function iamUserCredentials(profile) {
    if (!profile.awsAccessKeyId || !profile.awsSecretAccessKey) {
        let err = new Error('Profile "' + profile.profileName + '" has no IAM access key configured. ' +
            'Edit the profile and provide an access key ID and secret access key.');
        err.statusCode = 400;
        return { error: err };
    }
    return {
        credentials: {
            accessKeyId: profile.awsAccessKeyId,
            secretAccessKey: profile.awsSecretAccessKey
        }
    };
}

// The region to sign with, when the caller has no better idea (the dashboard
// parses it out of the endpoint host; S3 World and Sandbox rely on this).
function resolveRegion(profile, authnMode) {
    if (authnMode === 'irsa' && profile.irsaRegion) {
        return profile.irsaRegion;
    }
    if (authnMode === 'ec2_instance' && profile.ec2InstanceMetadata && profile.ec2InstanceMetadata.region) {
        return profile.ec2InstanceMetadata.region;
    }
    return profile.region || profile.ssoRegion || 'us-east-1';
}

function shapeResult(profile, authnMode, credentials, expiresAtMs) {
    return {
        credentials: credentials,
        // Convenience mirrors so callers don't reach back into the profile.
        region: resolveRegion(profile, authnMode),
        profile: profile,
        profileName: profile.profileName,
        authnMode: authnMode,
        // null for IAM user keys — they do not expire, so nothing caps a
        // presigned URL's lifetime.
        expiresAtMs: expiresAtMs == null ? null : expiresAtMs,
        temporary: authnModes.usesTemporaryCredentials(authnMode)
    };
}

// Resolve credentials for an already-loaded profile object.
// cb(err, { credentials, region, profile, profileName, authnMode, expiresAtMs, temporary })
//
// Errors keep whatever the underlying provider attached — notably
// `verificationUriComplete` (SSO device authorization) and `ssoSessionExpired`,
// which the UI turns into an Authorize button. Do not rewrap and drop those.
function resolveAwsCredentials(profile, requestedAuthnMode, cb) {
    if (!profile) {
        let err = new Error('No profile was provided.');
        err.statusCode = 400;
        return cb(err);
    }
    let authnMode = resolveAuthnMode(profile, requestedAuthnMode);
    if (!authnMode || !authnModes.isAwsAuthnMode(authnMode) ||
        ((profile.supportedAuthnMechanisms || []).indexOf(authnMode) < 0)) {
        return cb(unsupportedModeError(profile, authnMode));
    }

    if (authnMode === 'iam_user') {
        let iam = iamUserCredentials(profile);
        if (iam.error) {
            return cb(iam.error);
        }
        return cb(null, shapeResult(profile, authnMode, iam.credentials, null));
    }

    // Every remaining AWS mode mints/refreshes a temporary credential set and
    // exposes the same getSecurityToken(profile, cb) contract.
    let provider;
    if (authnMode === 'sso_user') {
        provider = ssoUtils;
    } else if (authnMode === 'ec2_instance') {
        provider = ec2Utils;
    } else if (authnMode === 'irsa') {
        provider = require('./irsaUtils');
    } else {
        return cb(unsupportedModeError(profile, authnMode));
    }

    provider.getSecurityToken(profile, (credErr, roleCredentials) => {
        if (credErr) {
            return cb(credErr);
        }
        if (!roleCredentials || !roleCredentials.accessKeyId) {
            let err = new Error('Profile "' + profile.profileName + '" returned no usable credentials for ' +
                authnMode + '.');
            err.statusCode = 502;
            return cb(err);
        }
        return cb(null, shapeResult(profile, authnMode, {
            accessKeyId: roleCredentials.accessKeyId,
            secretAccessKey: roleCredentials.secretAccessKey,
            sessionToken: roleCredentials.sessionToken,
            // `expiration` (epoch ms) travels *with* the credentials, not just in
            // the result envelope, because the presigners cap X-Amz-Expires to the
            // session token's remaining life via
            // expiryUtils.capExpiryToCredentialLife(expiresIn, credentials, now).
            // Drop it here and a 12-hour presigned URL would be issued against a
            // credential that dies in 20 minutes.
            expiration: roleCredentials.expiration
        }, roleCredentials.expiration));
    });
}

// Load a profile by name, then resolve. Used by callers that only have a name
// (chat/MCP, the IRSA base-profile lookup, the discovery handlers).
function resolveByProfileName(userName, profileName, requestedAuthnMode, cb) {
    let user = userName || authConfig.resolveUserName();
    if (!profileName) {
        let err = new Error('No profile name was provided.');
        err.statusCode = 400;
        return cb(err);
    }
    profileUtils.searchProfile(user, profileName, (searchErr, profile) => {
        if (searchErr) {
            return cb(searchErr);
        }
        return resolveAwsCredentials(profile, requestedAuthnMode, cb);
    });
}

// True when the credential set carries a session token, i.e. it must be signed
// with x-amz-security-token. This is the predicate signers should use instead of
// naming modes.
function hasSessionToken(credentials) {
    return !!(credentials && credentials.sessionToken);
}

module.exports = {
    resolveAuthnMode: resolveAuthnMode,
    resolveRegion: resolveRegion,
    resolveAwsCredentials: resolveAwsCredentials,
    resolveByProfileName: resolveByProfileName,
    hasSessionToken: hasSessionToken
};
