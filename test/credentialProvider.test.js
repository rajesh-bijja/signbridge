"use strict";

// Tests for the single place that turns (profile, authnMode) into AWS
// credentials.
//
// Four call sites used to hand-roll this decision; they all delegate here now, so
// the mechanism-selection rule and the shape of the result are load-bearing for
// presign, invoke, S3 World, Sandbox and CLI mode at once. The parts that need no
// network — mechanism selection, region selection, IAM-user keys, the error
// messages for an unusable profile, and the session-token predicate the signers
// dispatch on — are all covered here.

const test = require('node:test');
const assert = require('node:assert/strict');

const credentialProvider = require('../lib/credentialProvider');

function profile(overrides) {
    return Object.assign({
        profileName: 'my-profile',
        supportedAuthnMechanisms: ['iam_user'],
        awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    }, overrides || {});
}

// ---------------------------------------------------------------------------
// resolveAuthnMode
// ---------------------------------------------------------------------------

test('resolveAuthnMode: the caller\'s explicit choice always wins', () => {
    assert.equal(
        credentialProvider.resolveAuthnMode(
            profile({ supportedAuthnMechanisms: ['sso_user', 'irsa'], defaultAuthnMode: 'sso_user' }),
            'irsa'),
        'irsa'
    );
});

test('resolveAuthnMode: lowercases the caller\'s choice', () => {
    // The dashboard sends the value straight from a select; MCP callers type it.
    assert.equal(credentialProvider.resolveAuthnMode(profile(), 'EC2_Instance'), 'ec2_instance');
});

test('resolveAuthnMode: falls back to the profile\'s stored default', () => {
    assert.equal(
        credentialProvider.resolveAuthnMode(profile({
            supportedAuthnMechanisms: ['sso_user', 'ec2_instance'],
            defaultAuthnMode: 'ec2_instance'
        }), null),
        'ec2_instance'
    );
});

test('resolveAuthnMode: ignores a stored default the profile no longer supports', () => {
    // Turning a mechanism off in the form must not leave the profile pointing at
    // it.
    assert.equal(
        credentialProvider.resolveAuthnMode(profile({
            supportedAuthnMechanisms: ['sso_user'],
            defaultAuthnMode: 'ec2_instance'
        }), null),
        'sso_user'
    );
});

test('resolveAuthnMode: otherwise the first AWS mechanism in declaration order', () => {
    // Which is why authnModes declares sso_user/iam_user ahead of ec2_instance and
    // irsa — a profile saved before those existed keeps behaving the same way.
    assert.equal(
        credentialProvider.resolveAuthnMode(
            profile({ supportedAuthnMechanisms: ['irsa', 'ec2_instance', 'iam_user'] }), null),
        'iam_user'
    );
    assert.equal(
        credentialProvider.resolveAuthnMode(
            profile({ supportedAuthnMechanisms: ['irsa', 'ec2_instance'] }), null),
        'ec2_instance'
    );
});

test('resolveAuthnMode: skips non-AWS mechanisms when picking a fallback', () => {
    assert.equal(
        credentialProvider.resolveAuthnMode(
            profile({ supportedAuthnMechanisms: ['generic', 'rest_bearer_token', 'irsa'] }), null),
        'irsa'
    );
});

test('resolveAuthnMode: null when the profile offers no AWS mechanism at all', () => {
    assert.equal(
        credentialProvider.resolveAuthnMode(
            profile({ supportedAuthnMechanisms: ['generic'] }), null),
        null
    );
    assert.equal(credentialProvider.resolveAuthnMode({ profileName: 'p' }, null), null);
    assert.equal(credentialProvider.resolveAuthnMode(null, null), null);
});

// ---------------------------------------------------------------------------
// resolveRegion
// ---------------------------------------------------------------------------

test('resolveRegion: an IRSA profile signs in its own configured region', () => {
    assert.equal(
        credentialProvider.resolveRegion({ irsaRegion: 'eu-west-1', region: 'us-west-2' }, 'irsa'),
        'eu-west-1'
    );
});

test('resolveRegion: an EC2 profile inherits the region IMDS reported', () => {
    // The instance's own region is a fact read off the box, not a guess.
    assert.equal(
        credentialProvider.resolveRegion(
            { ec2InstanceMetadata: { region: 'ap-south-1' } }, 'ec2_instance'),
        'ap-south-1'
    );
});

test('resolveRegion: falls through region, then ssoRegion, then us-east-1', () => {
    assert.equal(credentialProvider.resolveRegion({ region: 'us-west-2' }, 'iam_user'), 'us-west-2');
    assert.equal(credentialProvider.resolveRegion({ ssoRegion: 'eu-central-1' }, 'sso_user'),
        'eu-central-1');
    assert.equal(credentialProvider.resolveRegion({}, 'iam_user'), 'us-east-1');
});

test('resolveRegion: an EC2 profile with no metadata yet still resolves', () => {
    // Test Connection may not have run, so the metadata block can be absent.
    assert.equal(credentialProvider.resolveRegion({}, 'ec2_instance'), 'us-east-1');
    assert.equal(credentialProvider.resolveRegion({ ec2InstanceMetadata: {} }, 'ec2_instance'),
        'us-east-1');
});

// ---------------------------------------------------------------------------
// hasSessionToken — the predicate signers dispatch on
// ---------------------------------------------------------------------------

test('hasSessionToken: true only when a session token is actually present', () => {
    // Signers must branch on this rather than on the mode name: that is precisely
    // why SSO, EC2 and IRSA needed no new signer.
    assert.equal(credentialProvider.hasSessionToken({ sessionToken: 'IQoJb3JpZ2lu' }), true);
    assert.equal(credentialProvider.hasSessionToken({ accessKeyId: 'AKIA', secretAccessKey: 's' }),
        false);
    assert.equal(credentialProvider.hasSessionToken({ sessionToken: '' }), false);
    assert.equal(credentialProvider.hasSessionToken(null), false);
    assert.equal(credentialProvider.hasSessionToken(undefined), false);
});

// ---------------------------------------------------------------------------
// resolveAwsCredentials — the paths that need no network
// ---------------------------------------------------------------------------

test('resolveAwsCredentials: IAM user keys come back with no session token', (t, done) => {
    credentialProvider.resolveAwsCredentials(profile(), 'iam_user', (err, result) => {
        assert.equal(err, null);
        assert.equal(result.credentials.accessKeyId, 'AKIAIOSFODNN7EXAMPLE');
        assert.equal(result.credentials.sessionToken, undefined);
        assert.equal(credentialProvider.hasSessionToken(result.credentials), false);
        // Long-lived keys never expire, so nothing caps a presigned URL.
        assert.equal(result.expiresAtMs, null);
        assert.equal(result.temporary, false);
        assert.equal(result.authnMode, 'iam_user');
        assert.equal(result.profileName, 'my-profile');
        done();
    });
});

test('resolveAwsCredentials: an IAM profile with no keys says which field to fill', (t, done) => {
    credentialProvider.resolveAwsCredentials(
        profile({ awsSecretAccessKey: '' }), 'iam_user', (err) => {
            assert.match(err.message, /no IAM access key configured/);
            assert.match(err.message, /Edit the profile/);
            assert.equal(err.statusCode, 400);
            done();
        });
});

test('resolveAwsCredentials: a missing profile is a 400, not a crash', (t, done) => {
    credentialProvider.resolveAwsCredentials(null, 'iam_user', (err) => {
        assert.match(err.message, /No profile was provided/);
        assert.equal(err.statusCode, 400);
        done();
    });
});

test('resolveAwsCredentials: a REST-only profile is told AWS needs an AWS profile', (t, done) => {
    credentialProvider.resolveAwsCredentials(
        profile({ supportedAuthnMechanisms: ['generic'] }), null, (err) => {
            assert.match(err.message, /offers no AWS authentication mechanism/);
            // The message must name the four types that would work.
            assert.match(err.message, /IAM user, SSO, EC2 instance or IRSA/);
            assert.equal(err.statusCode, 400);
            done();
        });
});

test('resolveAwsCredentials: asking for a non-AWS mechanism lists the AWS ones', (t, done) => {
    credentialProvider.resolveAwsCredentials(profile(), 'rest_bearer_token', (err) => {
        assert.match(err.message, /does not provide AWS credentials/);
        assert.match(err.message, /ec2_instance/);
        assert.match(err.message, /irsa/);
        assert.equal(err.statusCode, 400);
        done();
    });
});

test('resolveAwsCredentials: asking for an unsupported mechanism names what the profile has',
    (t, done) => {
        // The commonest mistake once a profile can offer several mechanisms.
        credentialProvider.resolveAwsCredentials(
            profile({ supportedAuthnMechanisms: ['sso_user'] }), 'irsa', (err) => {
                assert.match(err.message, /does not support "irsa"/);
                assert.match(err.message, /It supports: sso_user/);
                assert.equal(err.statusCode, 400);
                done();
            });
    });

test('resolveAwsCredentials: never echoes the secret access key into an error', (t, done) => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    credentialProvider.resolveAwsCredentials(
        profile({ supportedAuthnMechanisms: ['generic'] }), 'iam_user', (err) => {
            assert.ok(err.message.indexOf(secret) < 0, 'secret leaked into the error message');
            done();
        });
});
