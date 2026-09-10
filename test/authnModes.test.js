"use strict";

// Tests for the authentication-mechanism registry.
//
// Every dispatch site (requestSigner, s3World, sandboxService, awsCliUtils,
// profileUtils, awsConfigWriter) now asks this module instead of hand-writing an
// `authnMode === '...'` chain, so a mistake here is a mistake everywhere. The
// two properties worth pinning are the classification of each mode (AWS?
// temporary? syncable to ~/.aws/config?) and the flags-to-mechanisms derivation,
// which is what a saved profile's supportedAuthnMechanisms comes from.

const test = require('node:test');
const assert = require('node:assert/strict');

const authnModes = require('../lib/authnModes');

test('ALL_MODES covers the seven profile types, AWS ones first', () => {
    assert.deepEqual(authnModes.ALL_MODES, [
        'sso_user',
        'iam_user',
        'ec2_instance',
        'irsa',
        'rest_basic_auth',
        'rest_bearer_token',
        'generic'
    ]);
});

test('AWS_MODES is exactly the four credential-yielding modes', () => {
    assert.deepEqual(authnModes.AWS_MODES, ['sso_user', 'iam_user', 'ec2_instance', 'irsa']);
});

test('declaration order keeps sso_user/iam_user ahead of the new types', () => {
    // credentialProvider.resolveAuthnMode falls back to the first AWS mode a
    // profile supports. Reordering this list would silently change which
    // mechanism an existing multi-mechanism profile defaults to.
    assert.ok(authnModes.AWS_MODES.indexOf('sso_user') < authnModes.AWS_MODES.indexOf('ec2_instance'));
    assert.ok(authnModes.AWS_MODES.indexOf('iam_user') < authnModes.AWS_MODES.indexOf('irsa'));
});

test('isAwsAuthnMode: true for AWS modes, false for REST modes and junk', () => {
    for (const mode of ['sso_user', 'iam_user', 'ec2_instance', 'irsa']) {
        assert.equal(authnModes.isAwsAuthnMode(mode), true, mode + ' should be an AWS mode');
    }
    for (const mode of ['rest_basic_auth', 'rest_bearer_token', 'generic']) {
        assert.equal(authnModes.isAwsAuthnMode(mode), false, mode + ' should not be an AWS mode');
    }
    assert.equal(authnModes.isAwsAuthnMode('nonsense'), false);
    assert.equal(authnModes.isAwsAuthnMode(null), false);
    assert.equal(authnModes.isAwsAuthnMode(undefined), false);
});

test('mode lookup is case-insensitive', () => {
    assert.equal(authnModes.isAwsAuthnMode('EC2_INSTANCE'), true);
    assert.equal(authnModes.usesTemporaryCredentials('IRSA'), true);
    assert.equal(authnModes.describe('Iam_User').mode, 'iam_user');
});

test('usesTemporaryCredentials: only long-lived IAM user keys are permanent', () => {
    // This predicate drives credential refresh AND the presigned-URL lifetime
    // cap. Marking a session-token mode as permanent would issue 12-hour URLs
    // against credentials that die in minutes.
    assert.equal(authnModes.usesTemporaryCredentials('sso_user'), true);
    assert.equal(authnModes.usesTemporaryCredentials('ec2_instance'), true);
    assert.equal(authnModes.usesTemporaryCredentials('irsa'), true);
    assert.equal(authnModes.usesTemporaryCredentials('iam_user'), false);
});

test('isAwsConfigSyncable: only the two classic modes are representable in ~/.aws/config', () => {
    assert.equal(authnModes.isAwsConfigSyncable('iam_user'), true);
    assert.equal(authnModes.isAwsConfigSyncable('sso_user'), true);
    // An EC2 profile means "SSH to a box and read IMDS"; an IRSA profile means
    // "mint a Kubernetes token". The AWS CLI can do neither from a static entry.
    assert.equal(authnModes.isAwsConfigSyncable('ec2_instance'), false);
    assert.equal(authnModes.isAwsConfigSyncable('irsa'), false);
    assert.equal(authnModes.isAwsConfigSyncable('generic'), false);
});

test('deriveSupportedAuthnMechanisms: maps flags to modes in declaration order', () => {
    assert.deepEqual(
        authnModes.deriveSupportedAuthnMechanisms({
            genericEnabled: true,
            awsIamUserEnabled: true,
            irsaEnabled: true,
            awsSsoUserEnabled: true
        }),
        ['sso_user', 'iam_user', 'irsa', 'generic']
    );
});

test('deriveSupportedAuthnMechanisms: includes genericEnabled', () => {
    // updateProfile used to omit this flag, so saving a Generic profile dropped
    // 'generic' from its mechanisms and the dashboard stopped offering it.
    assert.deepEqual(
        authnModes.deriveSupportedAuthnMechanisms({ genericEnabled: true }),
        ['generic']
    );
});

test('deriveSupportedAuthnMechanisms: the new flags are the documented ones', () => {
    assert.deepEqual(
        authnModes.deriveSupportedAuthnMechanisms({ ec2InstanceEnabled: true }),
        ['ec2_instance']
    );
    assert.deepEqual(
        authnModes.deriveSupportedAuthnMechanisms({ irsaEnabled: true }),
        ['irsa']
    );
});

test('deriveSupportedAuthnMechanisms: empty for no flags and for no profile', () => {
    assert.deepEqual(authnModes.deriveSupportedAuthnMechanisms({}), []);
    assert.deepEqual(authnModes.deriveSupportedAuthnMechanisms(null), []);
});

test('profileHasAwsConfigSyncableMode: gates the ~/.aws/config writer', () => {
    // Reads the flags (not supportedAuthnMechanisms), because create/update call
    // it with the incoming payload.
    assert.equal(authnModes.profileHasAwsConfigSyncableMode({ awsIamUserEnabled: true }), true);
    assert.equal(authnModes.profileHasAwsConfigSyncableMode({
        ec2InstanceEnabled: true, irsaEnabled: true
    }), false);
    // A profile that offers both still syncs — the syncable part is what gets
    // written.
    assert.equal(authnModes.profileHasAwsConfigSyncableMode({
        ec2InstanceEnabled: true, awsSsoUserEnabled: true
    }), true);
    assert.equal(authnModes.profileHasAwsConfigSyncableMode({ genericEnabled: true }), false);
    assert.equal(authnModes.profileHasAwsConfigSyncableMode({}), false);
    assert.equal(authnModes.profileHasAwsConfigSyncableMode(null), false);
});

test('every registry entry is fully specified', () => {
    for (const entry of authnModes.AUTHN_MODES) {
        assert.equal(typeof entry.mode, 'string');
        assert.ok(entry.mode.length > 0);
        assert.equal(typeof entry.flag, 'string');
        assert.ok(entry.flag.length > 0, entry.mode + ' needs an enabling flag');
        assert.equal(typeof entry.aws, 'boolean');
        assert.equal(typeof entry.temporary, 'boolean');
        assert.equal(typeof entry.awsConfigSyncable, 'boolean');
        // Nothing non-AWS can be temporary or syncable — those concepts only
        // exist for AWS credentials.
        if (!entry.aws) {
            assert.equal(entry.temporary, false, entry.mode);
            assert.equal(entry.awsConfigSyncable, false, entry.mode);
        }
    }
});

test('flags are unique — two modes sharing one would alias each other', () => {
    const flags = authnModes.AUTHN_MODES.map((e) => e.flag);
    assert.equal(new Set(flags).size, flags.length);
});
