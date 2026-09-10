"use strict";

// The single registry of authentication mechanisms a profile can offer.
//
// Every profile type is described here once — its enabling flag on the profile
// object, whether it yields AWS credentials, and whether those credentials are
// temporary (session-token bearing) or long-lived. Callers ask this module
// instead of hand-writing `authnMode === 'iam_user' || authnMode === 'sso_user'`
// chains, which is how adding EC2 / IRSA stayed a one-line change in each place
// rather than a fourth copy of the same branch.
//
// Pure and dependency-free on purpose: it is the thing every dispatch site
// agrees on, so it must be trivially testable (see test/authnModes.test.js).

// Declaration order also fixes the order of `supportedAuthnMechanisms` on a
// saved profile, so keep the two AWS "classic" modes first — existing profiles
// were written that way and the UI lists them in this order.
const AUTHN_MODES = [
    {
        mode: 'sso_user',
        flag: 'awsSsoUserEnabled',
        aws: true,
        // Temporary = the credential set carries a session token and an
        // expiration, so it must be refreshed and it caps presigned-URL life.
        temporary: true,
        // Written back to ~/.aws/config when the user opts in. Only the two
        // classic modes are representable there as a plain profile.
        awsConfigSyncable: true
    },
    {
        mode: 'iam_user',
        flag: 'awsIamUserEnabled',
        aws: true,
        temporary: false,
        awsConfigSyncable: true
    },
    {
        mode: 'ec2_instance',
        flag: 'ec2InstanceEnabled',
        aws: true,
        temporary: true,
        awsConfigSyncable: false
    },
    {
        mode: 'irsa',
        flag: 'irsaEnabled',
        aws: true,
        temporary: true,
        awsConfigSyncable: false
    },
    {
        mode: 'rest_basic_auth',
        flag: 'restBasicAuthEnabled',
        aws: false,
        temporary: false,
        awsConfigSyncable: false
    },
    {
        mode: 'rest_bearer_token',
        flag: 'restBearerTokenEnabled',
        aws: false,
        temporary: false,
        awsConfigSyncable: false
    },
    {
        mode: 'generic',
        flag: 'genericEnabled',
        aws: false,
        temporary: false,
        awsConfigSyncable: false
    }
];

const BY_MODE = {};
AUTHN_MODES.forEach((entry) => {
    BY_MODE[entry.mode] = entry;
});

// Every mode name, in declaration order.
const ALL_MODES = AUTHN_MODES.map((entry) => entry.mode);

// The modes that resolve to AWS credentials and can therefore sign SigV4
// requests (dashboard presign/invoke, S3 World, Sandbox, CLI passthrough).
const AWS_MODES = AUTHN_MODES.filter((entry) => entry.aws).map((entry) => entry.mode);

function describe(authnMode) {
    if (!authnMode) {
        return null;
    }
    return BY_MODE[String(authnMode).toLowerCase()] || null;
}

// Is this an AWS mode at all? Non-AWS modes (Basic/Bearer/Generic) have no AWS
// identity, which is what S3 World and Sandbox need to reject early.
function isAwsAuthnMode(authnMode) {
    let entry = describe(authnMode);
    return !!(entry && entry.aws);
}

// Do this mode's credentials expire (and therefore need refreshing, and cap
// X-Amz-Expires)? True for SSO, EC2 instance-profile and IRSA credentials.
function usesTemporaryCredentials(authnMode) {
    let entry = describe(authnMode);
    return !!(entry && entry.temporary);
}

// Can a profile using this mode be mirrored into ~/.aws/config? EC2 and IRSA
// profiles resolve credentials through SignBridge-specific machinery (SSH to an
// instance; a Kubernetes service-account token), so there is nothing the AWS CLI
// could do with them as a static profile entry.
function isAwsConfigSyncable(authnMode) {
    let entry = describe(authnMode);
    return !!(entry && entry.awsConfigSyncable);
}

// Turn the per-type boolean flags on a profile into its supportedAuthnMechanisms
// list. This is the one definition — createProfile and updateProfile both use
// it, which is also how `genericEnabled` stopped being dropped on update.
function deriveSupportedAuthnMechanisms(profileObj) {
    let mechanisms = [];
    if (!profileObj) {
        return mechanisms;
    }
    AUTHN_MODES.forEach((entry) => {
        if (profileObj[entry.flag]) {
            mechanisms.push(entry.mode);
        }
    });
    return mechanisms;
}

// Does this profile object enable at least one AWS mode? Used to decide whether
// "Sync to AWS Config" is even meaningful for it.
function profileHasAwsConfigSyncableMode(profileObj) {
    return deriveSupportedAuthnMechanisms(profileObj).some(isAwsConfigSyncable);
}

module.exports = {
    AUTHN_MODES: AUTHN_MODES,
    ALL_MODES: ALL_MODES,
    AWS_MODES: AWS_MODES,
    describe: describe,
    isAwsAuthnMode: isAwsAuthnMode,
    usesTemporaryCredentials: usesTemporaryCredentials,
    isAwsConfigSyncable: isAwsConfigSyncable,
    deriveSupportedAuthnMechanisms: deriveSupportedAuthnMechanisms,
    profileHasAwsConfigSyncableMode: profileHasAwsConfigSyncableMode
};
