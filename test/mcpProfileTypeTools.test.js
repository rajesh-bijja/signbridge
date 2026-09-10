"use strict";

// MCP parity for the EC2 and IRSA profile types.
//
// Three kinds of drift are possible here and none of them break the build:
//
//   1. `AWS_AUTHN_MODES` in mcp/tools.mjs is a hand-kept copy of
//      lib/authnModes.js AWS_MODES (that module is CommonJS, this one is ESM, and
//      tool schemas are serialised to clients before any request runs). If the
//      backend gains a fifth AWS profile type, an MCP client would keep rejecting
//      it client-side with a zod error — and the user would be told the mechanism
//      does not exist rather than that the tool list is stale.
//   2. A discovery tool can post to a route nobody mounted. The tool then just
//      returns 404 to whoever is driving SignBridge from an IDE.
//   3. A profile field can exist in create_profile but not update_profile (they
//      used to be two copies of the same literal), so a profile could be created
//      with an IRSA cluster and then never edited.
//
// Plus the invariant that matters most: these tools name a profile and never
// carry a credential, so an SSH key or a session token cannot end up in an MCP
// transcript.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const authnModes = require('../lib/authnModes');

const DISCOVERY_TOOLS = [
    'test_ec2_connection',
    'list_irsa_clusters',
    'list_irsa_service_accounts',
    'describe_irsa_role',
    'test_irsa_connection'
];

// One input covering every discovery tool's required fields at once.
const SAMPLE_INPUT = {
    profileName: 'ec2-box',
    baseProfileName: 'admin-sso',
    baseAuthnMode: 'sso_user',
    clusterName: 'phoenix-eks',
    region: 'us-west-2',
    roleArn: 'arn:aws:iam::123456789012:role/phoenix-terraform-ec2-default',
    namespace: 'default',
    serviceAccount: 'my-app'
};

async function collect() {
    const tools = await import('../mcp/tools.mjs');
    const calls = [];
    const built = tools.buildTools({
        userName: 'signbridgeuser',
        callApi: async (apiPath, payload) => {
            calls.push({ apiPath, payload });
            return {};
        }
    });
    return {
        built,
        discovery: built.filter((tool) => DISCOVERY_TOOLS.indexOf(tool.name) >= 0),
        calls
    };
}

test('every AWS mechanism the backend supports is offered by the MCP tools', async () => {
    const { built } = await collect();
    const invoke = built.find((tool) => tool.name === 'invoke_api');
    const presign = built.find((tool) => tool.name === 'presign_url');

    for (const mode of authnModes.AWS_MODES) {
        assert.equal(invoke.schema.authnMode.safeParse(mode).success, true,
            'invoke_api rejects ' + mode);
        assert.equal(presign.schema.authnMode.safeParse(mode).success, true,
            'presign_url rejects ' + mode);
    }
    // And it is a closed set — a typo must fail client-side, not reach the API.
    assert.equal(invoke.schema.authnMode.safeParse('ec2').success, false);
});

test('the non-AWS mechanisms are still offered by invoke_api, and only there', async () => {
    const { built } = await collect();
    const invoke = built.find((tool) => tool.name === 'invoke_api');
    const presign = built.find((tool) => tool.name === 'presign_url');

    for (const mode of ['rest_basic_auth', 'rest_bearer_token', 'generic']) {
        assert.equal(invoke.schema.authnMode.safeParse(mode).success, true, mode);
        // Presigning is a SigV4 operation; a Basic Auth profile has nothing to sign with.
        assert.equal(presign.schema.authnMode.safeParse(mode).success, false, mode);
    }
});

test('an AWS invoke of any mechanism routes to the one SigV4 endpoint', async () => {
    // The whole reason EC2/IRSA needed no new signer: the backend resolves the
    // credentials and the signers branch on whether a session token came back.
    // If a mechanism ever got its own endpoint here, that design has been lost.
    const { built, calls } = await collect();
    const invoke = built.find((tool) => tool.name === 'invoke_api');

    for (const mode of authnModes.AWS_MODES) {
        await invoke.handler({
            profileName: 'p',
            authnMode: mode,
            method: 'GET',
            endpoint: 'https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15'
        });
        assert.equal(calls[calls.length - 1].apiPath, '/generateAuthResponseAndInvoke', mode);
        assert.equal(calls[calls.length - 1].payload.options.authnMode, mode);
    }
});

test('the EC2 and IRSA discovery tools all exist', async () => {
    const { built, discovery } = await collect();
    const names = built.map((tool) => tool.name);
    for (const expected of DISCOVERY_TOOLS) {
        assert.ok(names.includes(expected), 'missing MCP tool: ' + expected);
    }
    assert.equal(new Set(names).size, names.length, 'duplicate MCP tool name');
    assert.equal(discovery.length, DISCOVERY_TOOLS.length);
});

test('every endpoint a discovery tool posts to is mounted in server.js', async () => {
    const { discovery, calls } = await collect();

    for (const tool of discovery) {
        await tool.handler(SAMPLE_INPUT);
    }

    assert.equal(calls.length, discovery.length, 'a discovery tool did not call the API');
    for (const call of calls) {
        assert.ok(
            SERVER_SOURCE.includes("router.post('" + call.apiPath + "'"),
            'tool posts to an unmounted route: ' + call.apiPath
        );
    }
});

test('the discovery tools post top-level bodies, not { options }', async () => {
    // Unlike the older invoke routes, these handlers read req.body directly. A
    // payload nested under `options` would arrive as an empty request and fail
    // with "baseProfileName is required" no matter what the caller passed.
    const { discovery, calls } = await collect();
    for (const tool of discovery) {
        await tool.handler(SAMPLE_INPUT);
    }
    for (const call of calls) {
        assert.equal(call.payload.options, undefined,
            call.apiPath + ' nested its payload under options');
        assert.equal(call.payload.userName, 'signbridgeuser',
            'missing userName in ' + call.apiPath);
    }
});

test('the IRSA discovery tools carry through the values they were given', async () => {
    const { discovery, calls } = await collect();
    const clusters = discovery.find((tool) => tool.name === 'list_irsa_clusters');
    const accounts = discovery.find((tool) => tool.name === 'list_irsa_service_accounts');
    const role = discovery.find((tool) => tool.name === 'describe_irsa_role');

    await clusters.handler(SAMPLE_INPUT);
    assert.deepEqual(
        { base: calls[0].payload.baseProfileName, region: calls[0].payload.region },
        { base: 'admin-sso', region: 'us-west-2' }
    );

    await accounts.handler(SAMPLE_INPUT);
    assert.equal(calls[1].payload.clusterName, 'phoenix-eks');

    // namespace + serviceAccount are what turn describe_irsa_role's answer into a
    // subjectCheck; dropping them silently would downgrade it to "here are the
    // trusted subjects, work it out yourself".
    await role.handler(SAMPLE_INPUT);
    assert.equal(calls[2].payload.roleArn, SAMPLE_INPUT.roleArn);
    assert.equal(calls[2].payload.namespace, 'default');
    assert.equal(calls[2].payload.serviceAccount, 'my-app');
});

test('a discovery tool never accepts a credential', async () => {
    const { discovery } = await collect();
    for (const tool of discovery) {
        for (const field of Object.keys(tool.schema)) {
            assert.doesNotMatch(field, /secret|password|privateKey|passphrase|token/i,
                tool.name + ' accepts a credential field: ' + field);
        }
    }
});

test('create_profile and update_profile accept exactly the same fields', async () => {
    const { built } = await collect();
    const create = built.find((tool) => tool.name === 'create_profile');
    const update = built.find((tool) => tool.name === 'update_profile');
    assert.deepEqual(Object.keys(create.schema).sort(), Object.keys(update.schema).sort());
});

test('the profile tools accept every EC2 and IRSA field the backend reads', async () => {
    // The list is deliberately explicit rather than derived: it is the contract
    // between the form, the MCP schema and lib/ec2Utils + lib/irsaUtils. If a
    // field is renamed backend-side this test is where it should be noticed.
    const { built } = await collect();
    const create = built.find((tool) => tool.name === 'create_profile');
    const fields = Object.keys(create.schema);

    for (const field of [
        'ec2InstanceEnabled', 'ec2Host', 'ec2SshUsername', 'ec2SshPort',
        'ec2SshPrivateKey', 'ec2SshPrivateKeyPassphrase', 'ec2SshPassword',
        'irsaEnabled', 'irsaBaseProfileName', 'irsaBaseAuthnMode', 'irsaRegion',
        'irsaClusterName', 'irsaNamespace', 'irsaServiceAccount', 'irsaRoleArn',
        'irsaAudience'
    ]) {
        assert.ok(fields.includes(field), 'create_profile cannot set ' + field);
    }
});

test('create_profile explains the EC2 key-or-password rule and that IRSA needs no kubectl', async () => {
    // Both are things an LLM will otherwise get wrong: it will helpfully send a
    // key AND a password (which the backend rejects), and it will tell the user
    // to install kubectl (which they do not need).
    const { built } = await collect();
    const create = built.find((tool) => tool.name === 'create_profile');
    assert.match(create.description, /EITHER ec2SshPrivateKey[\s\S]*OR ec2SshPassword/);
    assert.match(create.description, /never both/i);

    const accounts = built.find((tool) => tool.name === 'list_irsa_service_accounts');
    assert.match(accounts.description, /kubectl is NOT required/);
});

test('invoke_aws_cli warns that --profile breaks EC2 and IRSA credentials', async () => {
    // awsCliUtils hands those credentials to the CLI through the environment, and
    // `--profile` makes the CLI ignore the environment entirely. An LLM adding
    // `--profile` out of habit produces a baffling "could not find profile".
    const { built } = await collect();
    const cli = built.find((tool) => tool.name === 'invoke_aws_cli');
    assert.match(cli.description, /do NOT put --profile/);
    assert.match(cli.description, /ec2_instance/);
    assert.match(cli.description, /irsa/);
});
