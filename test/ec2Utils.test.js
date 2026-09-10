"use strict";

// Tests for the pure half of the EC2 instance-profile type.
//
// Everything that involves an actual SSH session or a live instance is I/O and
// is not tested here. What IS tested is the part that decides things: the remote
// command (must stay IMDSv2), the parse of its output, the "key or password,
// never both" rule, and the SSH failure messages — which are the entire value of
// the Test Connection button, since a bad message sends the user hunting in the
// wrong place.

const test = require('node:test');
const assert = require('node:assert/strict');

const ec2Utils = require('../lib/ec2Utils');

// ---------------------------------------------------------------------------
// Sample IMDS output, shaped exactly like the real thing.
// ---------------------------------------------------------------------------

const IDENTITY_DOCUMENT = {
    accountId: '123456789012',
    architecture: 'x86_64',
    availabilityZone: 'us-east-1c',
    imageId: 'ami-0abcdef1234567890',
    instanceId: 'i-0123456789abcdef0',
    instanceType: 'm5.xlarge',
    pendingTime: '2026-08-14T09:12:44Z',
    privateIp: '10.20.30.40',
    region: 'us-east-1',
    version: '2017-09-30'
};

const ROLE_NAME = 'example-terraform-ec2-default';

const IMDS_CREDENTIALS = {
    Code: 'Success',
    LastUpdated: '2026-09-02T10:00:00Z',
    Type: 'AWS-HMAC',
    AccessKeyId: 'ASIAEXAMPLEKEYID1234',
    SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    Token: 'IQoJb3JpZ2luX2VjEXAMPLETOKEN',
    Expiration: '2026-09-02T16:00:00Z'
};

function imdsStdout(parts) {
    const opts = parts || {};
    const identity = 'identity' in opts ? opts.identity : JSON.stringify(IDENTITY_DOCUMENT);
    const role = 'role' in opts ? opts.role : ROLE_NAME;
    const credentials = 'credentials' in opts ? opts.credentials : JSON.stringify(IMDS_CREDENTIALS);
    const lines = [
        '===SIGNBRIDGE_IDENTITY===',
        identity,
        '===SIGNBRIDGE_ROLE===',
        role,
        '===SIGNBRIDGE_CREDENTIALS===',
        credentials
    ];
    if (opts.truncated !== true) {
        lines.push('===SIGNBRIDGE_END===');
    }
    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// buildImdsCommand
// ---------------------------------------------------------------------------

test('buildImdsCommand: uses IMDSv2 — a token PUT with the TTL header', () => {
    const cmd = ec2Utils.buildImdsCommand();
    assert.match(cmd, /-X PUT "http:\/\/169\.254\.169\.254\/latest\/api\/token"/);
    assert.match(cmd, /X-aws-ec2-metadata-token-ttl-seconds: 21600/);
});

test('buildImdsCommand: every metadata read carries the session token', () => {
    // An IMDSv1 fallback would paper over a misconfiguration the user should see,
    // so no unauthenticated metadata read is allowed to creep in.
    const cmd = ec2Utils.buildImdsCommand();
    const metadataReads = cmd.split('\n').filter((line) => {
        return line.indexOf('169.254.169.254/latest/meta-data') >= 0 ||
            line.indexOf('169.254.169.254/latest/dynamic') >= 0;
    });
    assert.ok(metadataReads.length >= 3, 'expected identity, role and credential reads');
    for (const line of metadataReads) {
        assert.match(line, /X-aws-ec2-metadata-token: \$TOKEN/, 'unauthenticated IMDS read: ' + line);
    }
});

test('buildImdsCommand: reads the three documented IMDS paths', () => {
    const cmd = ec2Utils.buildImdsCommand();
    assert.ok(cmd.indexOf('/latest/dynamic/instance-identity/document') >= 0);
    assert.ok(cmd.indexOf('/latest/meta-data/iam/security-credentials/') >= 0);
    assert.match(cmd, /security-credentials\/"\$ROLE"/);
});

test('buildImdsCommand: tolerates an instance with no role instead of erroring', () => {
    // The credential read is guarded, so a role-less instance produces an empty
    // section that parseImdsOutput can explain, not a shell error.
    assert.match(ec2Utils.buildImdsCommand(), /if \[ -n "\$ROLE" \]/);
});

test('buildImdsCommand: is pure — same bytes every call', () => {
    assert.equal(ec2Utils.buildImdsCommand(), ec2Utils.buildImdsCommand());
});

// ---------------------------------------------------------------------------
// parseImdsOutput
// ---------------------------------------------------------------------------

test('parseImdsOutput: reads identity, role and credentials from real-shaped output', () => {
    const parsed = ec2Utils.parseImdsOutput(imdsStdout());
    assert.equal(parsed.roleName, ROLE_NAME);
    assert.equal(parsed.identity.instanceId, 'i-0123456789abcdef0');
    assert.equal(parsed.identity.region, 'us-east-1');
    assert.equal(parsed.credentials.AccessKeyId, IMDS_CREDENTIALS.AccessKeyId);
    assert.equal(parsed.credentials.Code, 'Success');
});

test('parseImdsOutput: tolerates surrounding shell noise (motd, sudo warnings)', () => {
    const noisy = 'Last login: Tue Sep  2 09:00:00 2026 from 10.0.0.1\n' +
        imdsStdout() +
        'Connection to 10.20.30.40 closed.\n';
    const parsed = ec2Utils.parseImdsOutput(noisy);
    assert.equal(parsed.roleName, ROLE_NAME);
});

test('parseImdsOutput: a truncated run says the commands did not complete', () => {
    assert.throws(
        () => ec2Utils.parseImdsOutput(imdsStdout({ truncated: true })),
        (err) => {
            assert.match(err.message, /did not complete/i);
            assert.match(err.message, /curl/);
            assert.equal(err.statusCode, 502);
            return true;
        }
    );
});

test('parseImdsOutput: no identity document blames IMDS, with a command to verify', () => {
    assert.throws(
        () => ec2Utils.parseImdsOutput(imdsStdout({ identity: '' })),
        (err) => {
            assert.match(err.message, /instance-identity document/);
            // The message must hand the user something to run on the box.
            assert.match(err.message, /curl -X PUT/);
            assert.equal(err.statusCode, 502);
            return true;
        }
    );
});

test('parseImdsOutput: unparseable identity is treated as absent, not crashed on', () => {
    assert.throws(
        () => ec2Utils.parseImdsOutput(imdsStdout({ identity: '<html>404 not found</html>' })),
        /instance-identity document/
    );
});

test('parseImdsOutput: no attached role names the instance and says what to do', () => {
    assert.throws(
        () => ec2Utils.parseImdsOutput(imdsStdout({ role: '' })),
        (err) => {
            assert.match(err.message, /No IAM role is attached to instance i-0123456789abcdef0/);
            assert.match(err.message, /Attach an instance profile/);
            // The user's mistake, not a server fault.
            assert.equal(err.statusCode, 400);
            return true;
        }
    );
});

test('parseImdsOutput: a non-Success credential Code is surfaced verbatim', () => {
    assert.throws(
        () => ec2Utils.parseImdsOutput(imdsStdout({
            credentials: JSON.stringify({ Code: 'AssumeRoleUnauthorizedAccess' })
        })),
        (err) => {
            assert.match(err.message, /Code=AssumeRoleUnauthorizedAccess/);
            assert.match(err.message, new RegExp(ROLE_NAME));
            return true;
        }
    );
});

test('parseImdsOutput: empty and null input do not throw a TypeError', () => {
    assert.throws(() => ec2Utils.parseImdsOutput(''), /did not complete/);
    assert.throws(() => ec2Utils.parseImdsOutput(null), /did not complete/);
    assert.throws(() => ec2Utils.parseImdsOutput(undefined), /did not complete/);
});

// ---------------------------------------------------------------------------
// toRoleCredentials / toInstanceMetadata / maskCredentials
// ---------------------------------------------------------------------------

test('toRoleCredentials: produces the same shape SSO does, expiration in epoch ms', () => {
    // This parity is the whole reason EC2 needed no new signer: the presigners
    // read `expiration` (ms) to cap X-Amz-Expires.
    const creds = ec2Utils.toRoleCredentials(IMDS_CREDENTIALS, ROLE_NAME);
    assert.equal(creds.accessKeyId, IMDS_CREDENTIALS.AccessKeyId);
    assert.equal(creds.secretAccessKey, IMDS_CREDENTIALS.SecretAccessKey);
    assert.equal(creds.sessionToken, IMDS_CREDENTIALS.Token);
    assert.equal(creds.expiration, Date.parse('2026-09-02T16:00:00Z'));
    assert.equal(typeof creds.expiration, 'number');
    assert.equal(creds.roleName, ROLE_NAME);
    assert.equal(creds.source, 'ec2_instance');
});

test('toRoleCredentials: an unparseable Expiration becomes null, not NaN', () => {
    // NaN would sail through `expiration - now` arithmetic and produce a
    // nonsensical presigned-URL cap.
    const creds = ec2Utils.toRoleCredentials(
        Object.assign({}, IMDS_CREDENTIALS, { Expiration: 'never' }), ROLE_NAME);
    assert.equal(creds.expiration, null);
});

test('toInstanceMetadata: keeps the documented identity fields', () => {
    const meta = ec2Utils.toInstanceMetadata(IDENTITY_DOCUMENT, ROLE_NAME);
    assert.deepEqual(meta, {
        instanceId: 'i-0123456789abcdef0',
        instanceType: 'm5.xlarge',
        accountId: '123456789012',
        region: 'us-east-1',
        availabilityZone: 'us-east-1c',
        imageId: 'ami-0abcdef1234567890',
        privateIp: '10.20.30.40',
        architecture: 'x86_64',
        iamRoleName: ROLE_NAME
    });
});

test('toInstanceMetadata: missing fields become null rather than undefined', () => {
    const meta = ec2Utils.toInstanceMetadata({}, null);
    for (const key of Object.keys(meta)) {
        assert.equal(meta[key], null, key + ' should be null');
    }
});

test('maskCredentials: never reveals the secret key or session token', () => {
    const masked = ec2Utils.maskCredentials(ec2Utils.toRoleCredentials(IMDS_CREDENTIALS, ROLE_NAME));
    const serialised = JSON.stringify(masked);
    assert.ok(serialised.indexOf(IMDS_CREDENTIALS.SecretAccessKey) < 0, 'secret key leaked');
    assert.ok(serialised.indexOf(IMDS_CREDENTIALS.Token) < 0, 'session token leaked');
    assert.equal(masked.secretAccessKey, '********');
    assert.equal(masked.sessionToken, '********');
    // The access key ID is partially shown so the user can tell which credential
    // they got.
    assert.equal(masked.accessKeyId, 'ASIA****1234');
    assert.equal(masked.roleName, ROLE_NAME);
});

test('maskCredentials: null in, null out', () => {
    assert.equal(ec2Utils.maskCredentials(null), null);
});

// ---------------------------------------------------------------------------
// validateSshConfig — the "key or password, never both" rule
// ---------------------------------------------------------------------------

const PEM_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n';

function sshProfile(overrides) {
    return Object.assign({
        ec2Host: '10.20.30.40',
        ec2SshUsername: 'ec2-user',
        ec2SshPrivateKey: PEM_KEY
    }, overrides || {});
}

test('validateSshConfig: a host + username + key is valid', () => {
    assert.equal(ec2Utils.validateSshConfig(sshProfile()), null);
});

test('validateSshConfig: a host + username + password is valid', () => {
    assert.equal(ec2Utils.validateSshConfig(sshProfile({
        ec2SshPrivateKey: null,
        ec2SshPassword: 'correct horse battery staple'
    })), null);
});

test('validateSshConfig: a hostname is accepted, not just an IP', () => {
    assert.equal(ec2Utils.validateSshConfig(sshProfile({
        ec2Host: 'ec2-1-2-3-4.compute-1.amazonaws.com'
    })), null);
});

test('validateSshConfig: rejects both a key and a password', () => {
    // The user's rule, stated explicitly: "either ssh key or ssh user password
    // would be provided but not both."
    const err = ec2Utils.validateSshConfig(sshProfile({ ec2SshPassword: 'hunter2' }));
    assert.ok(err instanceof Error);
    assert.match(err.message, /not both/);
});

test('validateSshConfig: rejects neither a key nor a password', () => {
    const err = ec2Utils.validateSshConfig(sshProfile({ ec2SshPrivateKey: '' }));
    assert.match(err.message, /either an SSH private key or an SSH password/);
});

test('validateSshConfig: whitespace-only key counts as absent', () => {
    const err = ec2Utils.validateSshConfig(sshProfile({ ec2SshPrivateKey: '   \n  ' }));
    assert.match(err.message, /either an SSH private key or an SSH password/);
});

test('validateSshConfig: names the missing host and username specifically', () => {
    assert.match(ec2Utils.validateSshConfig(sshProfile({ ec2Host: '' })).message,
        /EC2 host is required/);
    assert.match(ec2Utils.validateSshConfig(sshProfile({ ec2SshUsername: '' })).message,
        /SSH username is required/);
    // The username hint names real AMI defaults, since guessing it is a common
    // first failure.
    assert.match(ec2Utils.validateSshConfig(sshProfile({ ec2SshUsername: '' })).message,
        /ec2-user|ubuntu/);
});

test('validateSshConfig: catches a public key pasted instead of a private one', () => {
    const err = ec2Utils.validateSshConfig(sshProfile({
        ec2SshPrivateKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB user@host'
    }));
    assert.match(err.message, /PEM private key/);
    assert.match(err.message, /\.pub/);
});

test('validateSshConfig: accepts RSA and EC PEM headers too', () => {
    for (const header of ['RSA', 'EC', '']) {
        const key = '-----BEGIN ' + (header ? header + ' ' : '') + 'PRIVATE KEY-----\nx\n' +
            '-----END ' + (header ? header + ' ' : '') + 'PRIVATE KEY-----\n';
        assert.equal(ec2Utils.validateSshConfig(sshProfile({ ec2SshPrivateKey: key })), null,
            'should accept a ' + (header || 'PKCS#8') + ' key');
    }
});

test('validateSshConfig: returns an Error rather than throwing', () => {
    assert.ok(ec2Utils.validateSshConfig(null) instanceof Error);
    assert.ok(ec2Utils.validateSshConfig({}) instanceof Error);
});

// ---------------------------------------------------------------------------
// describeSshError — the message is the feature
// ---------------------------------------------------------------------------

test('describeSshError: DNS failure points at the hostname', () => {
    const msg = ec2Utils.describeSshError(
        Object.assign(new Error('getaddrinfo ENOTFOUND nope.example.com'), { code: 'ENOTFOUND' }),
        sshProfile({ ec2Host: 'nope.example.com' }));
    assert.match(msg, /Could not resolve "nope\.example\.com"/);
    assert.match(msg, /IP address/);
});

test('describeSshError: connection refused mentions sshd and the port', () => {
    const msg = ec2Utils.describeSshError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        sshProfile({ ec2SshPort: 2222 }));
    assert.match(msg, /refused by 10\.20\.30\.40:2222/);
    assert.match(msg, /sshd/);
});

test('describeSshError: a timeout blames the security group and network path', () => {
    // The single most common EC2 failure, and the one where a vague message costs
    // the most time.
    const msg = ec2Utils.describeSshError(
        Object.assign(new Error('Timed out while waiting for handshake'), { code: 'ETIMEDOUT' }),
        sshProfile());
    assert.match(msg, /security group/);
    assert.match(msg, /VPN/);
    assert.match(msg, /10\.20\.30\.40:22/);
});

test('describeSshError: auth failure advice differs for key vs password', () => {
    const authErr = new Error('All configured authentication methods failed');

    const keyMsg = ec2Utils.describeSshError(authErr, sshProfile());
    assert.match(keyMsg, /key pair the instance was launched with/);
    assert.match(keyMsg, /"ec2-user"/);

    const passwordMsg = ec2Utils.describeSshError(authErr, sshProfile({
        ec2SshPrivateKey: null, ec2SshPassword: 'hunter2'
    }));
    // Password auth is off by default on most AMIs — say so rather than letting
    // the user retype the password ten times.
    assert.match(passwordMsg, /disable password authentication/);
});

test('describeSshError: a passphrase-protected key says so', () => {
    const msg = ec2Utils.describeSshError(
        new Error('Encrypted private key detected, but no passphrase given'), sshProfile());
    assert.match(msg, /passphrase/);
});

test('describeSshError: an unparseable key asks for the whole file', () => {
    const msg = ec2Utils.describeSshError(new Error('Cannot parse privateKey: Unsupported key format'),
        sshProfile());
    assert.match(msg, /header and footer/);
});

test('describeSshError: an unrecognised failure still names host, port and cause', () => {
    const msg = ec2Utils.describeSshError(new Error('Unable to exchange encryption keys'), sshProfile());
    assert.match(msg, /10\.20\.30\.40:22/);
    assert.match(msg, /Unable to exchange encryption keys/);
});

test('describeSshError: survives a missing error and a missing profile', () => {
    assert.equal(typeof ec2Utils.describeSshError(null, null), 'string');
    assert.match(ec2Utils.describeSshError(null, null), /the instance/);
});

test('describeSshError: never echoes the SSH password back', () => {
    const msg = ec2Utils.describeSshError(new Error('All configured authentication methods failed'),
        sshProfile({ ec2SshPrivateKey: null, ec2SshPassword: 'sup3rs3cret' }));
    assert.ok(msg.indexOf('sup3rs3cret') < 0, 'password leaked into the error message');
});
