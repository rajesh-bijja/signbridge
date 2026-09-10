"use strict";

// Sandbox credential injection. This module decides what secrets cross into a
// container, so the tests here are mostly invariants rather than behaviours:
// non-AWS auth modes must get NO credentials, a partial credential set must
// fail loudly instead of producing a confusing AWS error at run time, and the
// describe* view that reaches the UI/history must never carry a secret value.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_REGION,
    SECRET_ENV_NAMES,
    isAwsAuthnMode,
    resolveRegion,
    buildSandboxEnv,
    describeCredentials,
    credentialExpiryMs
} = require('../lib/sandbox/sandboxCredentials');

// Obvious fakes. Nothing here is a real credential.
const FAKE_KEY = 'AKIAEXAMPLEFAKEKEY00';
const FAKE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const FAKE_TOKEN = 'FQoGZXIvYXdzEExampleSessionTokenValue==';

const IAM_PROFILE = {
    profileName: 'iam-dev',
    authnMode: 'iam_user',
    region: 'us-west-2',
    awsAccessKeyId: FAKE_KEY,
    awsSecretAccessKey: FAKE_SECRET
};

const SSO_PROFILE = { profileName: 'sso-dev', authnMode: 'sso_user', region: 'eu-west-1' };

const SSO_CREDS = {
    accessKeyId: FAKE_KEY,
    secretAccessKey: FAKE_SECRET,
    sessionToken: FAKE_TOKEN,
    expiration: 1_700_000_000_000
};

// ---------------------------------------------------------------------------
// auth-mode gating
// ---------------------------------------------------------------------------

test('only the two AWS-credential auth modes count as AWS', () => {
    assert.equal(isAwsAuthnMode('iam_user'), true);
    assert.equal(isAwsAuthnMode('sso_user'), true);
    // Bearer tokens and basic-auth passwords are NOT AWS credentials and must
    // never be turned into AWS_* environment variables.
    assert.equal(isAwsAuthnMode('rest_bearer_token'), false);
    assert.equal(isAwsAuthnMode('rest_basic_auth'), false);
    assert.equal(isAwsAuthnMode('generic'), false);
    assert.equal(isAwsAuthnMode(undefined), false);
});

// ---------------------------------------------------------------------------
// region resolution
// ---------------------------------------------------------------------------

test('resolveRegion prefers the explicit override, then profile, then SSO region', () => {
    assert.equal(resolveRegion(IAM_PROFILE, 'ap-south-1'), 'ap-south-1');
    assert.equal(resolveRegion(IAM_PROFILE, null), 'us-west-2');
    assert.equal(resolveRegion({ ssoRegion: 'eu-central-1' }, null), 'eu-central-1');
    assert.equal(resolveRegion({ region: 'us-east-2', ssoRegion: 'eu-central-1' }, null), 'us-east-2');
});

test('resolveRegion always yields a region — every AWS SDK errors without one', () => {
    assert.equal(resolveRegion(null, null), DEFAULT_REGION);
    assert.equal(resolveRegion({}, ''), DEFAULT_REGION);
    assert.equal(resolveRegion({ region: '   ' }, '  '), DEFAULT_REGION);
});

test('resolveRegion trims surrounding whitespace', () => {
    assert.equal(resolveRegion({ region: '  us-west-1  ' }, null), 'us-west-1');
});

// ---------------------------------------------------------------------------
// environment construction
// ---------------------------------------------------------------------------

test('non-AWS auth modes get a usable environment but zero credentials', () => {
    // The sandbox is still fully useful for plain REST work; it just must not
    // pretend to have AWS identity.
    for (const mode of ['generic', 'rest_basic_auth', 'rest_bearer_token']) {
        const built = buildSandboxEnv({ profileName: 'rest', region: 'us-east-1' }, mode, null, {});
        assert.equal(built.hasAwsCredentials, false);
        assert.equal(built.env.AWS_REGION, 'us-east-1');
        for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
            assert.equal(built.env[name], undefined, mode + ' leaked ' + name);
        }
    }
});

test('an IAM profile injects the long-lived key pair and no session token', () => {
    const built = buildSandboxEnv(IAM_PROFILE, 'iam_user', null, {});
    assert.equal(built.hasAwsCredentials, true);
    assert.equal(built.region, 'us-west-2');
    assert.equal(built.env.AWS_ACCESS_KEY_ID, FAKE_KEY);
    assert.equal(built.env.AWS_SECRET_ACCESS_KEY, FAKE_SECRET);
    assert.equal(built.env.AWS_SESSION_TOKEN, undefined);
});

test('an SSO profile injects all three parts of the temporary credential', () => {
    const built = buildSandboxEnv(SSO_PROFILE, 'sso_user', SSO_CREDS, {});
    assert.equal(built.hasAwsCredentials, true);
    assert.equal(built.env.AWS_ACCESS_KEY_ID, FAKE_KEY);
    assert.equal(built.env.AWS_SECRET_ACCESS_KEY, FAKE_SECRET);
    assert.equal(built.env.AWS_SESSION_TOKEN, FAKE_TOKEN);
});

test('an incomplete credential set fails with an actionable message', () => {
    // Injecting two of three parts produces an opaque SignatureDoesNotMatch
    // inside the container; failing here says what to actually do.
    assert.throws(
        () => buildSandboxEnv({ profileName: 'iam-dev', awsAccessKeyId: FAKE_KEY }, 'iam_user', null, {}),
        /Profiles page/
    );
    assert.throws(
        () => buildSandboxEnv(SSO_PROFILE, 'sso_user', { accessKeyId: FAKE_KEY, secretAccessKey: FAKE_SECRET }, {}),
        /aws sso login --profile sso-dev/
    );
    assert.throws(() => buildSandboxEnv(SSO_PROFILE, 'sso_user', null, {}), /aws sso login/);
});

test('an AWS auth mode with no profile at all is rejected', () => {
    assert.throws(() => buildSandboxEnv(null, 'iam_user', null, {}), /profile is required/);
    assert.throws(() => buildSandboxEnv(null, 'sso_user', SSO_CREDS, {}), /profile is required/);
});

test('the baseline environment sets both region variables and unbuffers output', () => {
    // AWS_REGION alone is not enough: boto3 reads AWS_DEFAULT_REGION. And
    // without PYTHONUNBUFFERED, print() output arrives only when the process
    // exits, which defeats live streaming.
    const built = buildSandboxEnv(IAM_PROFILE, 'iam_user', null, {});
    assert.equal(built.env.AWS_REGION, built.env.AWS_DEFAULT_REGION);
    assert.equal(built.env.PYTHONUNBUFFERED, '1');
    // No ~/.aws is mounted into the sandbox; telling the SDKs so avoids a
    // confusing "profile not found" when the user's code names a profile.
    assert.equal(built.env.AWS_SDK_LOAD_CONFIG, '0');
    // Paging would hang a non-interactive container.
    assert.equal(built.env.AWS_PAGER, '');
    // CloudTrail attribution: these calls came from SignBridge's sandbox.
    assert.equal(built.env.AWS_EXECUTION_ENV, 'SignBridge-Sandbox');
});

test('an explicit region override beats the profile for the injected env', () => {
    const built = buildSandboxEnv(IAM_PROFILE, 'iam_user', null, { region: 'ap-northeast-1' });
    assert.equal(built.region, 'ap-northeast-1');
    assert.equal(built.env.AWS_REGION, 'ap-northeast-1');
});

test('buildSandboxEnv tolerates a missing options object', () => {
    assert.equal(buildSandboxEnv(IAM_PROFILE, 'iam_user', null).env.AWS_REGION, 'us-west-2');
});

// ---------------------------------------------------------------------------
// the describe* view — this is what reaches the UI and the history record
// ---------------------------------------------------------------------------

test('describeCredentials masks every credential value', () => {
    // This object is serialised into the run response and the history entry.
    // A single unmasked field here would persist a live secret to disk.
    const described = describeCredentials(buildSandboxEnv(SSO_PROFILE, 'sso_user', SSO_CREDS, {}));
    const serialised = JSON.stringify(described);
    assert.equal(serialised.includes(FAKE_SECRET), false, 'secret access key leaked');
    assert.equal(serialised.includes(FAKE_TOKEN), false, 'session token leaked');
    assert.equal(serialised.includes(FAKE_KEY), false, 'access key id leaked');
    assert.equal(described.masked.AWS_SECRET_ACCESS_KEY, '********');
    assert.equal(described.masked.AWS_SESSION_TOKEN, '********');
    assert.equal(described.masked.AWS_ACCESS_KEY_ID, '********');
});

test('describeCredentials still shows the non-secret values, which are the useful ones', () => {
    const described = describeCredentials(buildSandboxEnv(IAM_PROFILE, 'iam_user', null, {}));
    assert.equal(described.masked.AWS_REGION, 'us-west-2');
    assert.equal(described.region, 'us-west-2');
    assert.equal(described.hasAwsCredentials, true);
    assert.deepEqual(described.names, described.names.slice().sort(), 'names should be sorted for a stable UI');
    assert.ok(described.names.includes('AWS_ACCESS_KEY_ID'));
});

test('every name in SECRET_ENV_NAMES is masked by describeCredentials', () => {
    const described = describeCredentials(buildSandboxEnv(SSO_PROFILE, 'sso_user', SSO_CREDS, {}));
    for (const name of SECRET_ENV_NAMES) {
        assert.equal(described.masked[name], '********', name + ' is listed as secret but was not masked');
    }
});

test('describeCredentials handles a credential-free build and a null input', () => {
    const rest = describeCredentials(buildSandboxEnv({}, 'generic', null, {}));
    assert.equal(rest.hasAwsCredentials, false);
    assert.equal(rest.names.includes('AWS_SECRET_ACCESS_KEY'), false);

    const empty = describeCredentials(null);
    assert.deepEqual(empty.names, []);
    assert.equal(empty.hasAwsCredentials, false);
    assert.equal(empty.region, null);
});

// ---------------------------------------------------------------------------
// expiry reporting
// ---------------------------------------------------------------------------

test('credentialExpiryMs reports an expiry only for SSO', () => {
    // IAM keys are long-lived: reporting an expiry for them would be a lie, and
    // the UI uses this to decide whether to warn about a mid-run expiry.
    assert.equal(credentialExpiryMs('sso_user', SSO_CREDS), 1_700_000_000_000);
    assert.equal(credentialExpiryMs('iam_user', SSO_CREDS), null);
    assert.equal(credentialExpiryMs('generic', null), null);
    assert.equal(credentialExpiryMs('sso_user', null), null);
    assert.equal(credentialExpiryMs('sso_user', { accessKeyId: FAKE_KEY }), null);
});
