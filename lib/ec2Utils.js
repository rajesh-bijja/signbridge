"use strict";

// EC2 instance-profile credentials, fetched over SSH.
//
// The profile names an instance you can already SSH into (IP or hostname, a
// username, and either a private key or a password). SignBridge opens that SSH
// session and runs the IMDSv2 sequence *on the instance* — PUT a token, read the
// instance-identity document, read the attached role name, read that role's
// security credentials. What comes back is the ordinary temporary-credential
// triple, identical in shape to what SSO mints, so from the signers' point of
// view an EC2 profile is indistinguishable from an SSO one.
//
// Why this exists: debugging "works on the box, fails from my laptop" normally
// means SSHing in and running curl by hand. This makes the instance's own
// identity a profile you can presign and invoke with.
//
// Two invariants:
//   * IMDSv2 only. The token PUT is not optional — IMDSv1 is disabled on any
//     sanely configured instance, and falling back to it would paper over a
//     misconfiguration the user should see.
//   * Credentials never reach a log. The remote command's stdout carries the
//     secret key, so it is parsed and discarded, never console.logged, and the
//     API responses describe credentials only through maskCredentials().

let { Client } = require('ssh2');
let profileUtils = require('./profileUtils');
let expiryUtils = require('./expiryUtils');
let authConfig = require('./authConfig');
let log = require('./logger').create('ec2Utils');

const IMDS_BASE = 'http://169.254.169.254/latest';
const IMDS_TOKEN_TTL_SECONDS = 21600;
const DEFAULT_SSH_PORT = 22;
const SSH_READY_TIMEOUT_MS = 20000;
const EXEC_TIMEOUT_MS = 30000;

// Same policy as SSO: re-mint when less than this much life is left, rather than
// handing out a credential that dies mid-request.
let CREDENTIAL_REFRESH_BUFFER_MS = expiryUtils.DEFAULT_REFRESH_BUFFER_MS;
if (process.env.EC2_CREDENTIAL_REFRESH_BUFFER_MS) {
    let parsed = parseInt(process.env.EC2_CREDENTIAL_REFRESH_BUFFER_MS, 10);
    if (!isNaN(parsed) && parsed >= 0) {
        CREDENTIAL_REFRESH_BUFFER_MS = parsed;
    }
}

// Output markers. Chosen to be things no metadata value contains, so the parse
// is unambiguous even when a section is empty.
const MARK_IDENTITY = '===SIGNBRIDGE_IDENTITY===';
const MARK_ROLE = '===SIGNBRIDGE_ROLE===';
const MARK_CREDENTIALS = '===SIGNBRIDGE_CREDENTIALS===';
const MARK_END = '===SIGNBRIDGE_END===';

// The remote script. One exec instead of five round trips, and `set -u`-free on
// purpose: a missing role must produce an empty section we can explain, not a
// shell error the user has to decode.
//
// Pure (no arguments, no state) so a test can assert it stays IMDSv2.
function buildImdsCommand() {
    return [
        'TOKEN=$(curl -s -m 5 -X PUT "' + IMDS_BASE + '/api/token"' +
            ' -H "X-aws-ec2-metadata-token-ttl-seconds: ' + IMDS_TOKEN_TTL_SECONDS + '")',
        'ROLE=$(curl -s -m 5 -H "X-aws-ec2-metadata-token: $TOKEN" ' +
            IMDS_BASE + '/meta-data/iam/security-credentials/ | head -n 1)',
        'echo "' + MARK_IDENTITY + '"',
        'curl -s -m 5 -H "X-aws-ec2-metadata-token: $TOKEN" ' +
            IMDS_BASE + '/dynamic/instance-identity/document',
        'echo',
        'echo "' + MARK_ROLE + '"',
        'echo "$ROLE"',
        'echo "' + MARK_CREDENTIALS + '"',
        'if [ -n "$ROLE" ]; then curl -s -m 5 -H "X-aws-ec2-metadata-token: $TOKEN" ' +
            IMDS_BASE + '/meta-data/iam/security-credentials/"$ROLE"; fi',
        'echo',
        'echo "' + MARK_END + '"'
    ].join('\n');
}

function sectionBetween(text, startMarker, endMarker) {
    let start = text.indexOf(startMarker);
    if (start < 0) {
        return null;
    }
    start += startMarker.length;
    let end = endMarker ? text.indexOf(endMarker, start) : -1;
    let slice = end < 0 ? text.slice(start) : text.slice(start, end);
    return slice.trim();
}

// Parse the remote command's stdout into { identity, roleName, credentials }.
// Pure — this is where the interesting decisions live, so it is unit-tested with
// captured IMDS output instead of a live instance.
//
// Throws an Error with a user-facing message when the instance clearly has no
// usable instance profile; returns partial data (identity but no credentials)
// only when the shapes are genuinely ambiguous.
function parseImdsOutput(stdout) {
    let text = stdout == null ? '' : String(stdout);
    if (text.indexOf(MARK_END) < 0) {
        let err = new Error('The metadata commands did not complete on the instance. ' +
            'Check that `curl` is installed and that IMDS (169.254.169.254) is reachable from the instance.');
        err.statusCode = 502;
        throw err;
    }

    let identityRaw = sectionBetween(text, MARK_IDENTITY, MARK_ROLE);
    let roleName = sectionBetween(text, MARK_ROLE, MARK_CREDENTIALS);
    let credentialsRaw = sectionBetween(text, MARK_CREDENTIALS, MARK_END);

    let identity = null;
    if (identityRaw) {
        try {
            identity = JSON.parse(identityRaw);
        } catch (parseErr) {
            identity = null;
        }
    }
    if (!identity) {
        let err = new Error('IMDSv2 did not return an instance-identity document. ' +
            'The instance may have IMDS disabled, or the hop limit may be too low. ' +
            'Verify with: curl -X PUT "' + IMDS_BASE + '/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"');
        err.statusCode = 502;
        throw err;
    }

    if (!roleName) {
        let err = new Error('No IAM role is attached to instance ' + (identity.instanceId || '(unknown)') + '. ' +
            'Attach an instance profile to the instance, then test the connection again.');
        err.statusCode = 400;
        throw err;
    }

    let credentials = null;
    if (credentialsRaw) {
        try {
            credentials = JSON.parse(credentialsRaw);
        } catch (parseErr) {
            credentials = null;
        }
    }
    if (!credentials || credentials.Code !== 'Success' || !credentials.AccessKeyId) {
        let detail = credentials && credentials.Code ? ' IMDS returned Code=' + credentials.Code + '.' : '';
        let err = new Error('IMDS did not return usable credentials for role "' + roleName + '".' + detail);
        err.statusCode = 502;
        throw err;
    }

    return {
        identity: identity,
        roleName: roleName,
        credentials: credentials
    };
}

// Turn the IMDS credential JSON into SignBridge's credential shape
// (expiration in epoch ms, matching profile.roleCredentials for SSO).
function toRoleCredentials(imdsCredentials, roleName) {
    let expirationMs = Date.parse(imdsCredentials.Expiration);
    return {
        accessKeyId: imdsCredentials.AccessKeyId,
        secretAccessKey: imdsCredentials.SecretAccessKey,
        sessionToken: imdsCredentials.Token,
        expiration: isNaN(expirationMs) ? null : expirationMs,
        expirationReadable: imdsCredentials.Expiration || null,
        roleName: roleName,
        source: 'ec2_instance'
    };
}

// The subset of the instance-identity document worth keeping on the profile.
// Pure; also what the UI shows after a successful connection test.
function toInstanceMetadata(identity, roleName) {
    return {
        instanceId: identity.instanceId || null,
        instanceType: identity.instanceType || null,
        accountId: identity.accountId || null,
        region: identity.region || null,
        availabilityZone: identity.availabilityZone || null,
        imageId: identity.imageId || null,
        privateIp: identity.privateIp || null,
        architecture: identity.architecture || null,
        iamRoleName: roleName || null
    };
}

// Never return raw credentials to a client. This is the only shape the API and
// the UI ever see.
function maskCredentials(roleCredentials) {
    if (!roleCredentials) {
        return null;
    }
    let accessKeyId = roleCredentials.accessKeyId || '';
    return {
        accessKeyId: accessKeyId ? accessKeyId.slice(0, 4) + '****' + accessKeyId.slice(-4) : null,
        secretAccessKey: '********',
        sessionToken: '********',
        expiration: roleCredentials.expiration || null,
        expirationReadable: roleCredentials.expirationReadable || null,
        roleName: roleCredentials.roleName || null
    };
}

// Validate the SSH inputs. Returns an Error (not thrown) or null — pure, so the
// "key or password, never both" rule is unit-testable.
function validateSshConfig(profile) {
    if (!profile) {
        return new Error('profile not provided');
    }
    if (!profile.ec2Host) {
        return new Error('EC2 host is required — enter the instance IP address or hostname.');
    }
    if (!profile.ec2SshUsername) {
        return new Error('SSH username is required (for example ec2-user for Amazon Linux, ubuntu for Ubuntu).');
    }
    let hasKey = !!(profile.ec2SshPrivateKey && String(profile.ec2SshPrivateKey).trim());
    let hasPassword = !!(profile.ec2SshPassword && String(profile.ec2SshPassword).length);
    if (!hasKey && !hasPassword) {
        return new Error('Provide either an SSH private key or an SSH password.');
    }
    if (hasKey && hasPassword) {
        return new Error('Provide either an SSH private key or an SSH password, not both.');
    }
    if (hasKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(profile.ec2SshPrivateKey)) {
        return new Error('The SSH private key does not look like a PEM private key. ' +
            'Upload the .pem/.key file itself (it should start with "-----BEGIN ... PRIVATE KEY-----"), not a .pub file.');
    }
    return null;
}

// Map an ssh2 failure onto something the user can act on. Pure, and unit-tested:
// this message is the whole value of the "test connection" button.
function describeSshError(err, profile) {
    let raw = err && err.message ? err.message : 'unknown SSH error';
    let code = err && err.code ? err.code : null;
    let host = profile && profile.ec2Host ? profile.ec2Host : 'the instance';
    let port = (profile && profile.ec2SshPort) || DEFAULT_SSH_PORT;

    if (code === 'ENOTFOUND' || /getaddrinfo/i.test(raw)) {
        return 'Could not resolve "' + host + '". Check the hostname, or use the instance IP address.';
    }
    if (code === 'ECONNREFUSED') {
        return 'Connection refused by ' + host + ':' + port + '. sshd may not be running, or it listens on a different port.';
    }
    if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || /timed out/i.test(raw)) {
        return 'Timed out connecting to ' + host + ':' + port + '. The instance is unreachable from SignBridge — ' +
            'check the security group allows inbound SSH from this machine, and that you are on the right network/VPN.';
    }
    if (/All configured authentication methods failed/i.test(raw)) {
        let hint = profile && profile.ec2SshPassword
            ? 'Check the username and password (many AMIs disable password authentication entirely — use a key instead).'
            : 'Check the username and that this private key matches the key pair the instance was launched with.';
        return 'SSH authentication failed for user "' + ((profile && profile.ec2SshUsername) || '?') + '". ' + hint;
    }
    if (/Encrypted private key/i.test(raw) || /no passphrase given/i.test(raw)) {
        return 'The private key is passphrase-protected. Enter its passphrase, or use an unencrypted key.';
    }
    if (/Cannot parse privateKey/i.test(raw) || /Unsupported key format/i.test(raw)) {
        return 'The private key could not be parsed: ' + raw + '. ' +
            'OpenSSH-format keys are supported; make sure the whole file (including header and footer lines) was uploaded.';
    }
    return 'SSH connection to ' + host + ':' + port + ' failed: ' + raw;
}

// Open an SSH session, run the IMDS script, close. cb(err, { stdout, stderr }).
function runImdsOverSsh(profile, cb) {
    let configErr = validateSshConfig(profile);
    if (configErr) {
        configErr.statusCode = configErr.statusCode || 400;
        return cb(configErr);
    }

    let settled = false;
    let finish = (err, result) => {
        if (settled) { return; }
        settled = true;
        try {
            conn.end();
        } catch (endErr) {
            // best effort — the connection may already be gone
        }
        cb(err, result);
    };

    let conn = new Client();
    let connectConfig = {
        host: profile.ec2Host,
        port: parseInt(profile.ec2SshPort, 10) || DEFAULT_SSH_PORT,
        username: profile.ec2SshUsername,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        // Password auth only when a password was supplied; keyboard-interactive is
        // left off so a server offering it cannot turn into a silent hang.
        tryKeyboard: false
    };
    if (profile.ec2SshPrivateKey && String(profile.ec2SshPrivateKey).trim()) {
        connectConfig.privateKey = profile.ec2SshPrivateKey;
        if (profile.ec2SshPrivateKeyPassphrase) {
            connectConfig.passphrase = profile.ec2SshPrivateKeyPassphrase;
        }
    } else {
        connectConfig.password = profile.ec2SshPassword;
    }

    conn.on('ready', () => {
        conn.exec(buildImdsCommand(), (execErr, stream) => {
            if (execErr) {
                let err = new Error(describeSshError(execErr, profile));
                err.statusCode = 502;
                return finish(err);
            }
            let stdout = '';
            let stderr = '';
            let timer = setTimeout(() => {
                let err = new Error('The metadata commands did not finish within ' +
                    (EXEC_TIMEOUT_MS / 1000) + 's on ' + profile.ec2Host + '.');
                err.statusCode = 504;
                finish(err);
            }, EXEC_TIMEOUT_MS);
            stream.on('close', () => {
                clearTimeout(timer);
                finish(null, { stdout: stdout, stderr: stderr });
            });
            stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        });
    });
    conn.on('error', (connErr) => {
        let err = new Error(describeSshError(connErr, profile));
        err.statusCode = 502;
        err.ec2SshFailure = true;
        finish(err);
    });

    try {
        conn.connect(connectConfig);
    } catch (connectErr) {
        let err = new Error(describeSshError(connectErr, profile));
        err.statusCode = 400;
        finish(err);
    }
}

// Fetch a fresh credential set from the instance. cb(err, { roleCredentials, instanceMetadata }).
function fetchInstanceCredentials(profile, cb) {
    runImdsOverSsh(profile, (sshErr, result) => {
        if (sshErr) {
            return cb(sshErr);
        }
        let parsed;
        try {
            // NOTE: result.stdout contains the secret key — do not log it.
            parsed = parseImdsOutput(result.stdout);
        } catch (parseErr) {
            if (result.stderr && result.stderr.trim() && !parseErr.statusCode) {
                parseErr.message += ' Remote stderr: ' + result.stderr.trim().slice(0, 300);
            }
            parseErr.statusCode = parseErr.statusCode || 502;
            return cb(parseErr);
        }
        return cb(null, {
            roleCredentials: toRoleCredentials(parsed.credentials, parsed.roleName),
            instanceMetadata: toInstanceMetadata(parsed.identity, parsed.roleName)
        });
    });
}

// Persist the freshly minted credentials + captured metadata onto the profile so
// subsequent requests reuse them until they near expiry. Mirrors what ssoUtils
// does with roleCredentials, but under an EC2-specific key: a single profile may
// legitimately enable both SSO and EC2, and they must not overwrite each other.
function persistCredentials(profile, roleCredentials, instanceMetadata, cb) {
    let update = {
        profileName: profile.profileName,
        userName: profile.userName || authConfig.getDefaultUserName(),
        ec2RoleCredentials: roleCredentials,
        ec2InstanceMetadata: instanceMetadata
    };
    // The instance tells us its own region; adopt it as the profile's region when
    // the user has not set one, so signing works without extra typing.
    if (!profile.region && instanceMetadata && instanceMetadata.region) {
        update.region = instanceMetadata.region;
    }
    profileUtils.updateProfile(update, (updateErr) => {
        if (updateErr) {
            // A persistence failure must not fail the request — we already have
            // working credentials in hand; we just won't be able to cache them.
            log.warn('ec2Utils: could not cache instance credentials on profile ' +
                profile.profileName + ': ' + updateErr.message);
        }
        return cb(null);
    });
}

// The credential seam. Same contract as ssoUtils.getSecurityToken:
// cb(err, roleCredentials) with { accessKeyId, secretAccessKey, sessionToken, expiration }.
function getSecurityToken(profile, cb) {
    if (!profile || !profile.ec2InstanceEnabled) {
        let err = new Error('Profile "' + ((profile && profile.profileName) || '?') +
            '" is not an EC2 instance profile.');
        err.statusCode = 400;
        return cb(err);
    }
    if (expiryUtils.isSsoCredentialFresh(profile.ec2RoleCredentials, Date.now(), CREDENTIAL_REFRESH_BUFFER_MS)) {
        return cb(null, profile.ec2RoleCredentials);
    }
    fetchInstanceCredentials(profile, (fetchErr, fetched) => {
        if (fetchErr) {
            // Keep the SSH/IMDS diagnosis — it is the actionable part — but say
            // plainly which profile failed and what the user can do about it.
            let err = new Error('Could not obtain instance credentials for profile "' + profile.profileName +
                '". ' + fetchErr.message);
            err.statusCode = fetchErr.statusCode || 502;
            err.ec2CredentialFailure = true;
            return cb(err);
        }
        profile.ec2RoleCredentials = fetched.roleCredentials;
        profile.ec2InstanceMetadata = fetched.instanceMetadata;
        persistCredentials(profile, fetched.roleCredentials, fetched.instanceMetadata, () => {
            return cb(null, fetched.roleCredentials);
        });
    });
}

// POST /signbridge/testEc2Connection
//
// Body: { profileName } to test a saved profile, or { profile: {...} } to test
// the values currently in the form (so "save then test" works even before the
// user commits the profile). Reports the SSH result, the instance identity, and
// the role whose credentials were retrieved.
function testEc2Connection(req, res) {
    let userName = authConfig.resolveUserName();
    let body = req.body || {};
    let inlineProfile = body.profile;
    let profileName = body.profileName || (inlineProfile && inlineProfile.profileName);

    let runTest = (profile) => {
        fetchInstanceCredentials(profile, (fetchErr, fetched) => {
            if (fetchErr) {
                return res.status(fetchErr.statusCode || 502).json({
                    success: false,
                    message: fetchErr.message
                });
            }
            let respond = () => {
                return res.status(200).json({
                    success: true,
                    message: 'SSH connection to ' + profile.ec2Host + ' succeeded as "' + profile.ec2SshUsername +
                        '", and IMDSv2 returned credentials for instance role "' + fetched.instanceMetadata.iamRoleName + '".',
                    instanceMetadata: fetched.instanceMetadata,
                    credentials: maskCredentials(fetched.roleCredentials)
                });
            };
            // Cache on the saved profile when there is one; an unsaved form test
            // has nowhere to persist to, which is fine.
            if (profile.profileName && profile.__saved) {
                return persistCredentials(profile, fetched.roleCredentials, fetched.instanceMetadata, respond);
            }
            return respond();
        });
    };

    if (inlineProfile && (inlineProfile.ec2Host || !profileName)) {
        let candidate = Object.assign({}, inlineProfile);
        candidate.userName = userName;
        // The form may omit secrets when editing a saved profile (the UI does not
        // echo them back); fall back to the stored values in that case.
        if (profileName) {
            return profileUtils.searchProfile(userName, profileName, (searchErr, stored) => {
                if (!searchErr && stored) {
                    if (!candidate.ec2SshPrivateKey && !candidate.ec2SshPassword) {
                        candidate.ec2SshPrivateKey = stored.ec2SshPrivateKey;
                        candidate.ec2SshPrivateKeyPassphrase = stored.ec2SshPrivateKeyPassphrase;
                        candidate.ec2SshPassword = stored.ec2SshPassword;
                    }
                    candidate.__saved = true;
                }
                return runTest(candidate);
            });
        }
        return runTest(candidate);
    }

    if (!profileName) {
        return res.status(400).json({
            success: false,
            message: 'profileName (or an inline profile) is required to test an EC2 connection.'
        });
    }
    profileUtils.searchProfile(userName, profileName, (searchErr, profile) => {
        if (searchErr) {
            return res.status(searchErr.statusCode || 400).json({
                success: false,
                message: searchErr.message
            });
        }
        profile.__saved = true;
        return runTest(profile);
    });
}

module.exports = {
    CREDENTIAL_REFRESH_BUFFER_MS: CREDENTIAL_REFRESH_BUFFER_MS,
    DEFAULT_SSH_PORT: DEFAULT_SSH_PORT,
    buildImdsCommand: buildImdsCommand,
    parseImdsOutput: parseImdsOutput,
    toRoleCredentials: toRoleCredentials,
    toInstanceMetadata: toInstanceMetadata,
    maskCredentials: maskCredentials,
    validateSshConfig: validateSshConfig,
    describeSshError: describeSshError,
    fetchInstanceCredentials: fetchInstanceCredentials,
    getSecurityToken: getSecurityToken,
    testEc2Connection: testEc2Connection
};
