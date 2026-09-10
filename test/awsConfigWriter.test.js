"use strict";

// Guards the "Sync to AWS Config" writer: the INI merge must preserve existing
// profiles, comments, and unmanaged keys while adding/updating only the target
// profile's managed keys. Also asserts IAM keys land in ~/.aws/credentials and
// non-AWS profiles are a no-op.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const writer = require('../lib/awsConfigWriter');

// --- pure INI helpers ---

test('parseIni/serializeIni: round-trips sections and preserves comments + unmanaged keys', () => {
    const input = '[profile a]\nregion = us-east-1\n# keep me\noutput = json\n';
    const parsed = writer._parseIni(input);
    assert.equal(parsed.sections.length, 1);
    assert.equal(parsed.sections[0].header, '[profile a]');
    const out = writer._serializeIni(parsed);
    assert.match(out, /# keep me/);
    assert.match(out, /output = json/);
    assert.match(out, /region = us-east-1/);
});

test('upsertKeys: updates an existing key in place and appends new ones', () => {
    const sec = { header: '[profile a]', lines: ['region = us-west-2', 'output = json'] };
    writer._upsertKeys(sec, [['region', 'us-east-1'], ['sso_role_name', 'Admin']]);
    assert.deepEqual(sec.lines, ['region = us-east-1', 'output = json', 'sso_role_name = Admin']);
});

// --- end-to-end write against a temp HOME ---

function withTempHome(run) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbaws-'));
    const realHomedir = os.homedir;
    os.homedir = () => tmp;
    try {
        return run(tmp);
    } finally {
        os.homedir = realHomedir;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

test('syncProfileToAwsConfig: SSO profile writes [profile x] to config, no credentials file', () => {
    withTempHome((home) => {
        const done = writer.syncProfileToAwsConfig.bind(null, {
            profileName: 'ssoprof',
            awsSsoUserEnabled: true,
            ssoRegion: 'us-east-1',
            awsSsoStartUrl: 'https://example.awsapps.com/start',
            awsSsoAccountId: '111122223333',
            awsSsoRoleName: 'Admin',
            region: 'us-east-1'
        });
        let cbErr, cbRes;
        done((e, r) => { cbErr = e; cbRes = r; });
        assert.equal(cbErr, null);
        const cfg = fs.readFileSync(path.join(home, '.aws', 'config'), 'utf-8');
        assert.match(cfg, /\[profile ssoprof\]/);
        assert.match(cfg, /sso_start_url = https:\/\/example\.awsapps\.com\/start/);
        assert.match(cfg, /sso_account_id = 111122223333/);
        assert.equal(fs.existsSync(path.join(home, '.aws', 'credentials')), false);
    });
});

test('syncProfileToAwsConfig: IAM profile writes region to config and keys to credentials (0600)', () => {
    withTempHome((home) => {
        let cbErr;
        writer.syncProfileToAwsConfig({
            profileName: 'iamprof',
            awsIamUserEnabled: true,
            awsAccessKeyId: 'AKIAEXAMPLE',
            awsSecretAccessKey: 'secretvalue',
            region: 'us-west-2'
        }, (e) => { cbErr = e; });
        assert.equal(cbErr, null);
        const cfg = fs.readFileSync(path.join(home, '.aws', 'config'), 'utf-8');
        assert.match(cfg, /\[profile iamprof\]/);
        assert.match(cfg, /region = us-west-2/);
        const credsPath = path.join(home, '.aws', 'credentials');
        const creds = fs.readFileSync(credsPath, 'utf-8');
        assert.match(creds, /\[iamprof\]/);
        assert.match(creds, /aws_access_key_id = AKIAEXAMPLE/);
        assert.match(creds, /aws_secret_access_key = secretvalue/);
        const mode = fs.statSync(credsPath).mode & 0o777;
        assert.equal(mode, 0o600);
    });
});

test('syncProfileToAwsConfig: merges into an existing config without clobbering other profiles', () => {
    withTempHome((home) => {
        const awsDir = path.join(home, '.aws');
        fs.mkdirSync(awsDir, { recursive: true });
        fs.writeFileSync(path.join(awsDir, 'config'),
            '[profile keepme]\nregion = eu-west-1\noutput = json\n', 'utf-8');
        writer.syncProfileToAwsConfig({
            profileName: 'newprof',
            awsSsoUserEnabled: true,
            ssoRegion: 'us-east-1',
            awsSsoStartUrl: 'https://x.awsapps.com/start',
            awsSsoAccountId: '999988887777',
            awsSsoRoleName: 'Dev',
            region: 'us-east-1'
        }, () => {});
        const cfg = fs.readFileSync(path.join(awsDir, 'config'), 'utf-8');
        assert.match(cfg, /\[profile keepme\]/);
        assert.match(cfg, /output = json/);
        assert.match(cfg, /\[profile newprof\]/);
    });
});

test('syncProfileToAwsConfig: "default" profile uses [default] header in config', () => {
    withTempHome((home) => {
        writer.syncProfileToAwsConfig({
            profileName: 'default',
            awsSsoUserEnabled: true,
            ssoRegion: 'us-east-1',
            awsSsoStartUrl: 'https://x.awsapps.com/start',
            awsSsoAccountId: '1',
            awsSsoRoleName: 'R',
            region: 'us-east-1'
        }, () => {});
        const cfg = fs.readFileSync(path.join(home, '.aws', 'config'), 'utf-8');
        assert.match(cfg, /\[default\]/);
        assert.doesNotMatch(cfg, /\[profile default\]/);
    });
});

test('syncProfileToAwsConfig: non-AWS profile is a no-op (no files written)', () => {
    withTempHome((home) => {
        let cbErr;
        writer.syncProfileToAwsConfig({
            profileName: 'restprof',
            genericEnabled: true,
            syncToAwsConfig: true
        }, (e) => { cbErr = e; });
        assert.equal(cbErr, null);
        assert.equal(fs.existsSync(path.join(home, '.aws', 'config')), false);
    });
});

test('syncProfileToAwsConfig: adds output = json by default, but preserves an existing output value', () => {
    withTempHome((home) => {
        // fresh profile -> output = json is added
        writer.syncProfileToAwsConfig({
            profileName: 'iamprof',
            awsIamUserEnabled: true,
            awsAccessKeyId: 'AKIAEXAMPLE',
            awsSecretAccessKey: 'secretvalue',
            region: 'us-west-2'
        }, () => {});
        let cfg = fs.readFileSync(path.join(home, '.aws', 'config'), 'utf-8');
        assert.match(cfg, /output = json/);

        // pre-existing output = text must not be overwritten on re-sync
        const awsDir = path.join(home, '.aws');
        fs.writeFileSync(path.join(awsDir, 'config'),
            '[profile keeper]\nregion = us-east-1\noutput = text\n', 'utf-8');
        writer.syncProfileToAwsConfig({
            profileName: 'keeper',
            awsSsoUserEnabled: true,
            ssoRegion: 'us-east-1',
            awsSsoStartUrl: 'https://x.awsapps.com/start',
            awsSsoAccountId: '1',
            awsSsoRoleName: 'R',
            region: 'us-east-1'
        }, () => {});
        cfg = fs.readFileSync(path.join(awsDir, 'config'), 'utf-8');
        assert.match(cfg, /output = text/);
        assert.doesNotMatch(cfg, /output = json/);
    });
});

test('removeSection: removes a matching section and reports whether it did', () => {
    const parsed = writer._parseIni('[profile a]\nregion = us-east-1\n[profile b]\nregion = us-west-2\n');
    assert.equal(writer._removeSection(parsed, '[profile a]'), true);
    assert.equal(parsed.sections.length, 1);
    assert.equal(parsed.sections[0].header, '[profile b]');
    assert.equal(writer._removeSection(parsed, '[profile missing]'), false);
});

test('removeProfileFromAwsConfig: removes IAM profile from config and credentials, leaves others', () => {
    withTempHome((home) => {
        const awsDir = path.join(home, '.aws');
        fs.mkdirSync(awsDir, { recursive: true });
        fs.writeFileSync(path.join(awsDir, 'config'),
            '[profile keepme]\nregion = eu-west-1\n[profile gone]\nregion = us-east-1\noutput = json\n', 'utf-8');
        fs.writeFileSync(path.join(awsDir, 'credentials'),
            '[keepme]\naws_access_key_id = A\naws_secret_access_key = B\n[gone]\naws_access_key_id = C\naws_secret_access_key = D\n', 'utf-8');

        let cbErr, cbRes;
        writer.removeProfileFromAwsConfig({
            profileName: 'gone',
            awsIamUserEnabled: true
        }, (e, r) => { cbErr = e; cbRes = r; });

        assert.equal(cbErr, null);
        assert.equal(cbRes.removedFromConfig, true);
        assert.equal(cbRes.removedFromCredentials, true);
        const cfg = fs.readFileSync(path.join(awsDir, 'config'), 'utf-8');
        assert.match(cfg, /\[profile keepme\]/);
        assert.doesNotMatch(cfg, /\[profile gone\]/);
        const creds = fs.readFileSync(path.join(awsDir, 'credentials'), 'utf-8');
        assert.match(creds, /\[keepme\]/);
        assert.doesNotMatch(creds, /\[gone\]/);
    });
});

test('removeProfileFromAwsConfig: non-AWS profile is a no-op', () => {
    withTempHome((home) => {
        const awsDir = path.join(home, '.aws');
        fs.mkdirSync(awsDir, { recursive: true });
        fs.writeFileSync(path.join(awsDir, 'config'), '[profile keepme]\nregion = eu-west-1\n', 'utf-8');
        let cbErr;
        writer.removeProfileFromAwsConfig({
            profileName: 'restprof',
            genericEnabled: true
        }, (e) => { cbErr = e; });
        assert.equal(cbErr, null);
        const cfg = fs.readFileSync(path.join(awsDir, 'config'), 'utf-8');
        assert.match(cfg, /\[profile keepme\]/);
    });
});
