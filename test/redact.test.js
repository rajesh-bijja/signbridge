"use strict";

/**
 * redact.test.js — that credentials do not reach the log.
 *
 * This is one of the regressions that keeps working perfectly while it is wrong:
 * printing an SSO token response to stdout breaks nothing, passes every other
 * test, and is only discovered when someone pastes `docker logs` into a ticket.
 * So the tests are half behavioural (the redactor masks the real payload shapes,
 * captured from the actual AWS responses) and half source inspection (the log
 * lines that used to print them are still wrapped).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const redact = require('../lib/redact');
const profileUtils = require('../lib/profileUtils');

function sourceOf(file) {
    return fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
}

// The four SSO/STS response shapes, with the field names AWS actually uses.
const STS_RESPONSE = {
    roleCredentials: {
        accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: 'IQoJb3JpZ2luX2VjEExampleSessionTokenValue',
        expiration: 1788888888000
    }
};

const TOKEN_RESPONSE = {
    accessToken: 'aoaAAAAAGgeXampleAccessToken',
    refreshToken: 'aorAAAAAGgeXampleRefreshToken',
    tokenType: 'Bearer',
    expiresIn: 28800
};

const REGISTER_CLIENT_RESPONSE = {
    clientId: 'Ex4mpleClientId',
    clientSecret: 'eyJraWQiOiJrZXktZXhhbXBsZSIsImVuYyI6IkExMjhH',
    clientSecretExpiresAt: 1790000000
};

const DEVICE_CODE_RESPONSE = {
    deviceCode: 'ExampleDeviceCodeValue',
    userCode: 'ABCD-EFGH',
    verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
    expiresIn: 600,
    interval: 1
};

test('the STS success body is a credential, and none of it survives a log', () => {
    let safe = redact.forLog(STS_RESPONSE);
    let printed = JSON.stringify(safe);
    assert.ok(!printed.includes('wJalrXUtnFEMI'), 'secretAccessKey reached the log');
    assert.ok(!printed.includes('IQoJb3JpZ2luX2Vj'), 'sessionToken reached the log');
    // accessKeyId is not a secret and is the most useful field for "which
    // credentials was that?", so it is masked rather than hidden.
    assert.equal(safe.roleCredentials.accessKeyId, 'ASIA****MPLE');
    // Everything non-secret is untouched, or the log line stops being useful and
    // someone removes the redaction rather than the log.
    assert.equal(safe.roleCredentials.expiration, 1788888888000);
});

test('the OIDC token response loses both tokens, refresh included', () => {
    let safe = redact.forLog(TOKEN_RESPONSE);
    assert.equal(safe.accessToken, redact.REDACTED);
    // The refresh token is the longest-lived credential in the SSO flow.
    assert.equal(safe.refreshToken, redact.REDACTED);
    assert.equal(safe.expiresIn, 28800);
    // `tokenType` is not a secret, and it is redacted anyway because the rule is a
    // substring match with no allowlist. That is the documented trade: an allowlist
    // is where the next leak would hide, and losing the word "Bearer" from a log
    // line costs nothing. Asserted rather than fixed, so the choice is deliberate.
    assert.equal(safe.tokenType, redact.REDACTED);
});

test('RegisterClient loses the client secret; the device code is a credential too', () => {
    let client = redact.forLog(REGISTER_CLIENT_RESPONSE);
    assert.equal(client.clientSecret, redact.REDACTED);
    assert.equal(client.clientId, 'Ex4mpleClientId');

    let device = redact.forLog(DEVICE_CODE_RESPONSE);
    // The device code is exchanged for an access token, so it is a bearer
    // credential and not merely an identifier.
    assert.equal(device.deviceCode, redact.REDACTED);
    // The user code and the verification link are shown to the user in the browser
    // anyway — hiding them would remove the only way to debug a stuck authorization.
    assert.equal(device.userCode, 'ABCD-EFGH');
    assert.match(device.verificationUriComplete, /device\.sso/);
});

test('a raw response body is redacted as a string, not only once parsed', () => {
    // The offending lines logged the body *before* JSON.parse, so an object-only
    // redactor would have masked the parsed copy and printed the plaintext above it.
    let body = JSON.stringify(STS_RESPONSE);
    let safe = redact.redactText(body);
    assert.ok(!safe.includes('wJalrXUtnFEMI'));
    assert.ok(!safe.includes('IQoJb3JpZ2luX2Vj'));
    // Still parseable, so the log line stays readable.
    assert.equal(JSON.parse(safe).roleCredentials.accessKeyId, 'ASIA****MPLE');
});

test('a body that is not valid JSON still loses its secrets', () => {
    // A truncated body, or an error page. Falling through to "print it raw" would
    // reintroduce the leak for exactly the case someone is debugging.
    let truncated = '{"accessToken": "aoaSuperSecretValue", "refreshToken": "aorSecret"';
    let safe = redact.redactText(truncated);
    assert.ok(!safe.includes('aoaSuperSecretValue'));
    assert.ok(!safe.includes('aorSecret'));
});

test('a presigned URL loses its signature and security token', () => {
    // tinyUrl echoes the long URL back, and a presigned URL carries the credential
    // in its query string.
    let url = 'https://bucket.s3.amazonaws.com/k?X-Amz-Credential=ASIAEXAMPLE%2F20260909%2Fus-east-1' +
        '&X-Amz-Security-Token=IQoJb3JpZ2luLONGTOKEN&X-Amz-Signature=abc123def456&X-Amz-Expires=3600';
    let safe = redact.redactText(url);
    assert.ok(!safe.includes('abc123def456'), 'the signature reached the log');
    assert.ok(!safe.includes('IQoJb3JpZ2luLONGTOKEN'), 'the security token reached the log');
    // The non-credential parameters survive, so the URL is still recognisable.
    assert.match(safe, /X-Amz-Expires=3600/);
});

test('key matching ignores case, dashes and underscores', () => {
    // One entry has to cover sessionToken, session_token and x-amz-security-token,
    // because these payloads come from four different APIs with three conventions.
    assert.ok(redact.isSecretKey('sessionToken'));
    assert.ok(redact.isSecretKey('session_token'));
    assert.ok(redact.isSecretKey('x-amz-security-token'));
    assert.ok(redact.isSecretKey('SecretAccessKey'));
    assert.ok(redact.isSecretKey('Authorization'));
    assert.ok(redact.isSecretKey('ec2SshPrivateKey'));
    // A credentials cache is a container, not a scalar secret: walked, not replaced,
    // so its masked accessKeyId and expiration survive.
    assert.ok(redact.isContainerKey('roleCredentials'));
    assert.ok(redact.isContainerKey('irsaRoleCredentials'));
    assert.ok(!redact.isContainerKey('sessionToken'));
    // Not secrets: an identifier, a region, a name.
    assert.ok(!redact.isSecretKey('profileName'));
    assert.ok(!redact.isSecretKey('ssoRegion'));
    assert.ok(!redact.isSecretKey('accessKeyId'));
    assert.ok(redact.isMaskedKey('awsAccessKeyId'));
});

test('redaction terminates on a cycle and on deep nesting', () => {
    // Log payloads here are whatever an HTTP client handed back, so this must not
    // be the thing that takes the server down.
    let a = { name: 'a' };
    a.self = a;
    let safe = redact.forLog(a);
    assert.equal(safe.name, 'a');
    assert.equal(safe.self, '[circular]');

    let deep = {};
    let cursor = deep;
    for (let i = 0; i < 40; i += 1) {
        cursor.next = {};
        cursor = cursor.next;
    }
    assert.doesNotThrow(function () { redact.forLog(deep); });
});

test('redactProfileForLog keeps its named fields and gains the substring backstop', () => {
    let safe = profileUtils.redactProfileForLog({
        profileName: 'my-profile',
        awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        ec2SshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
        roleCredentials: { secretAccessKey: 'nested-secret', sessionToken: 'nested-token' },
        // Not in SECRET_PROFILE_FIELDS: the point of the backstop is a field nobody
        // remembered to add to that list.
        someFutureAccessToken: 'unlisted-but-obviously-a-token'
    });
    let printed = JSON.stringify(safe);
    assert.ok(!printed.includes('wJalrXUtnFEMI'));
    assert.ok(!printed.includes('BEGIN OPENSSH'));
    assert.ok(!printed.includes('nested-secret'));
    assert.ok(!printed.includes('nested-token'));
    assert.ok(!printed.includes('unlisted-but-obviously-a-token'),
        'the substring backstop did not catch an unlisted token field');
    // The named pass replaces the whole cache with its own placeholder and the
    // generic pass then flattens that to '[redacted]' — the second pass cannot tell
    // a placeholder from a credential-shaped string, and guessing would be the wrong
    // way for it to err.
    assert.equal(safe.roleCredentials, redact.REDACTED);
    assert.equal(safe.profileName, 'my-profile');
    assert.equal(safe.awsAccessKeyId, 'AKIA****MPLE');
});

test('no ssoUtils log line prints a credential-bearing payload unwrapped', () => {
    // Source inspection, because the failure is silent: these eight lines each
    // printed a live credential to `docker logs`, and nothing anywhere failed.
    let source = sourceOf('ssoUtils.js');
    const MUST_BE_WRAPPED = [
        'registerClientResp',   // client secret
        'deviceCodeResp',       // device code
        'responseBody',         // raw STS + raw CreateToken body
        'responseJson',         // the parsed pair of the above
        'credsObjResp',         // the assembled creds object
        'profileReadObj',       // carries roleCredentials by the time it is logged
        'profileUpdateObj'
    ];
    let lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        let line = lines[i];
        if (line.trim().indexOf('//') === 0 || line.indexOf('console.log') === -1) {
            continue;
        }
        // Remove the wrapped forms first, so what remains is only an argument that
        // reaches the log raw. Matching "an identifier in parens" without this step
        // flags `redact.forLog(responseBody)` itself.
        let stripped = line
            .replace(/redact\.forLog\([^()]*\)/g, 'SAFE')
            .replace(/(?:profileUtils\.)?redactProfileForLog\([^()]*\)/g, 'SAFE');
        for (const name of MUST_BE_WRAPPED) {
            // The identifier as a whole word, i.e. as an argument rather than as
            // part of a longer name.
            let bare = new RegExp('[,\\s(]' + name + '\\s*[),]');
            if (bare.test(stripped)) {
                assert.fail('ssoUtils.js:' + (i + 1) + ' logs ' + name + ' unredacted: ' +
                    line.trim() + ' — wrap it in redact.forLog() or ' +
                    'profileUtils.redactProfileForLog()');
            }
        }
    }
    // And the wrapping is actually present, so the check above cannot pass simply
    // because the log lines were deleted and a future one added back raw.
    assert.match(source, /require\('\.\/redact'\)/);
    assert.match(source, /redact\.forLog\(responseBody\)/);
    assert.match(source, /profileUtils\.redactProfileForLog\(profileReadObj\)/);
});
