"use strict";

/**
 * sandboxCredentials.js
 *
 * Translates a SignBridge profile into the environment every AWS SDK already
 * knows how to read. That is the whole trick behind Sandbox mode: we do not ask
 * the user to configure credentials in their code, and we do not teach three
 * SDKs about SignBridge. We export the standard variables, and boto3 / AWS SDK
 * for JavaScript / AWS SDK for Java each pick them up through their own default
 * provider chain with zero configuration.
 *
 * For every profile type but IAM-user the values are freshly minted, short-lived
 * credentials (the caller resolves them through lib/credentialProvider.js first —
 * SSO role credentials, EC2 instance-profile credentials read from IMDS over SSH,
 * or IRSA credentials from a Kubernetes service-account token), so a sandbox run
 * is never signed with a stale session.
 *
 * SECRET HYGIENE — this module is the one place secrets are shaped, so the rules
 * live here and are enforced by test/sandboxCredentials.test.js:
 *   - Values are returned in memory only. Never written to disk, never persisted
 *     to history, never included in an error message.
 *   - Callers must pass values to the container via the environment of the
 *     spawned docker process and reference them by NAME on the command line
 *     (`docker run -e AWS_SECRET_ACCESS_KEY`, no `=value`), so nothing lands in
 *     the process table. See sandboxRunner.js.
 *   - Anything logged or shown to the user must go through describeCredentials(),
 *     which masks. There is no code path that logs a raw value.
 */

const authnModes = require('../authnModes');

const DEFAULT_REGION = 'us-east-1';

// Names of the variables that carry secret material. Used to keep logging and
// the "what got injected" UI summary honest.
const SECRET_ENV_NAMES = ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

// Which mechanisms yield AWS credentials at all — see lib/authnModes.js. Kept as
// a re-export so callers (and the tests) have one name for the question.
function isAwsAuthnMode(authnMode) {
    return authnModes.isAwsAuthnMode(authnMode);
}

// What the user should do when a temporary credential set could not be resolved.
// Each mode fails for a different reason, and a generic "credentials missing" is
// useless: the fix for SSO is a CLI login, for EC2 it is an SSH/IMDS problem, for
// IRSA it is cluster access.
function temporaryCredentialAdvice(authnMode, profileName) {
    let name = profileName || '<profile>';
    if (authnMode === 'ec2_instance') {
        return 'sandbox: could not resolve EC2 instance credentials for profile "' + name +
            '". Open the profile and use Test Connection to check the SSH login and that IMDS is reachable ' +
            'from the instance.';
    }
    if (authnMode === 'irsa') {
        return 'sandbox: could not resolve IRSA credentials for profile "' + name +
            '". Open the profile and use Test Connection to check the cluster, service account and role trust policy.';
    }
    return 'sandbox: could not resolve SSO role credentials for profile "' + name +
        '". Run "aws sso login --profile ' + name + '" and try again.';
}

/**
 * Resolve the region for a run: an explicit override wins, then the profile's
 * own region, then the SSO region, then a safe default. Every AWS SDK errors out
 * without a region, so we always supply one.
 */
function resolveRegion(profile, overrideRegion) {
    let candidates = [
        overrideRegion,
        profile ? profile.region : null,
        profile ? profile.ssoRegion : null,
        DEFAULT_REGION
    ];
    for (let candidate of candidates) {
        if (candidate && String(candidate).trim().length > 0) {
            return String(candidate).trim();
        }
    }
    return DEFAULT_REGION;
}

/**
 * Build the environment for a sandbox run.
 *
 * @param {object} profile          the stored profile (may be null for a
 *                                  credential-free REST/generic run)
 * @param {string} authnMode        the selected authentication mechanism
 * @param {object} [roleCredentials] SSO role credentials from
 *                                  ssoUtils.getSecurityToken (sso_user only)
 * @param {object} [options]        { region }
 * @returns {{ env: object, hasAwsCredentials: boolean, region: string }}
 *
 * Throws when an AWS mode is selected but the profile cannot supply credentials
 * — failing loudly here is much clearer than letting the SDK inside the
 * container report "unable to locate credentials".
 */
function buildSandboxEnv(profile, authnMode, roleCredentials, options) {
    options = options || {};
    let region = resolveRegion(profile, options.region);

    // Baseline: region plus a couple of quality-of-life defaults that make SDK
    // output readable in a console. These are not secrets.
    let env = {
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
        AWS_PAGER: '',
        // Tag the caller so CloudTrail shows these calls came from SignBridge.
        AWS_EXECUTION_ENV: 'SignBridge-Sandbox',
        PYTHONUNBUFFERED: '1',
        // Keep SDKs from trying to read a mounted ~/.aws that isn't there.
        AWS_SDK_LOAD_CONFIG: '0'
    };

    if (!isAwsAuthnMode(authnMode)) {
        // REST / Basic / Bearer / generic: no AWS credentials to inject. The
        // sandbox is still fully usable for non-AWS HTTP work.
        return { env: env, hasAwsCredentials: false, region: region };
    }

    if (!profile) {
        throw new Error('sandbox: an AWS profile is required for authentication mechanism "' + authnMode + '"');
    }

    if (authnMode === 'iam_user') {
        if (!profile.awsAccessKeyId || !profile.awsSecretAccessKey) {
            throw new Error('sandbox: profile "' + profile.profileName +
                '" has no IAM access key / secret key configured. Add them on the Profiles page.');
        }
        env.AWS_ACCESS_KEY_ID = profile.awsAccessKeyId;
        env.AWS_SECRET_ACCESS_KEY = profile.awsSecretAccessKey;
        return { env: env, hasAwsCredentials: true, region: region };
    }

    // Every other AWS mode (sso_user, ec2_instance, irsa) produces the same STS
    // triple, and all three parts are required — an SDK given a key pair without
    // the session token fails with a baffling signature error.
    if (!roleCredentials || !roleCredentials.accessKeyId || !roleCredentials.secretAccessKey ||
        !roleCredentials.sessionToken) {
        throw new Error(temporaryCredentialAdvice(authnMode, profile.profileName));
    }
    env.AWS_ACCESS_KEY_ID = roleCredentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = roleCredentials.secretAccessKey;
    env.AWS_SESSION_TOKEN = roleCredentials.sessionToken;
    return { env: env, hasAwsCredentials: true, region: region };
}

/**
 * A safe, loggable / displayable summary of what was injected. Secret values are
 * replaced with a fixed mask — never a prefix, never a length, because both leak
 * information about the key.
 *
 * @returns {{ names: string[], region: string, hasAwsCredentials: boolean, masked: object }}
 */
function describeCredentials(buildResult) {
    let env = (buildResult && buildResult.env) || {};
    let names = Object.keys(env).sort();
    let masked = {};
    for (let name of names) {
        masked[name] = SECRET_ENV_NAMES.indexOf(name) !== -1 || name === 'AWS_ACCESS_KEY_ID'
            ? '********'
            : env[name];
    }
    return {
        names: names,
        region: (buildResult && buildResult.region) || null,
        hasAwsCredentials: !!(buildResult && buildResult.hasAwsCredentials),
        masked: masked
    };
}

/**
 * The credential expiry (epoch ms) that bounds this run, or null when the
 * credentials are long-lived IAM keys. The UI shows this so a user understands
 * why a long-running script might start failing part way through.
 */
function credentialExpiryMs(authnMode, roleCredentials) {
    if (!authnModes.usesTemporaryCredentials(authnMode) || !roleCredentials || !roleCredentials.expiration) {
        return null;
    }
    return roleCredentials.expiration;
}

module.exports = {
    DEFAULT_REGION: DEFAULT_REGION,
    SECRET_ENV_NAMES: SECRET_ENV_NAMES,
    isAwsAuthnMode: isAwsAuthnMode,
    temporaryCredentialAdvice: temporaryCredentialAdvice,
    resolveRegion: resolveRegion,
    buildSandboxEnv: buildSandboxEnv,
    describeCredentials: describeCredentials,
    credentialExpiryMs: credentialExpiryMs
};
