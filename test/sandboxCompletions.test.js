"use strict";

// AWS autocomplete for the Sandbox IDE.
//
// The editor's AWS IntelliSense is generated from botocore's service models
// rather than from a language server, so the naming transforms below ARE the
// feature: botocore knows the operation as "DescribeRegions", and the user has
// to see `describe_regions` in Python, `describeRegions` in Java, and
// `DescribeRegionsCommand` in the JS SDK. Get a transform wrong and the editor
// confidently suggests a method that does not exist.
//
// The cases with real acronyms (DynamoDB, EC2, IoT, S3) are the ones that break
// naive implementations, so they are all pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_PARAMS_PER_OPERATION,
    listServiceNames,
    getLanguageGlobals,
    buildIndexFromModel,
    xformName,
    toCamelCase,
    splitWords,
    javaClientName,
    jsClientName,
    stripDocumentation,
    describeShapeType,
    extractParams
} = require('../lib/sandbox/sandboxCompletions');

// ---------------------------------------------------------------------------
// Python: boto3 snake_case (botocore's own xform_name)
// ---------------------------------------------------------------------------

test('xformName reproduces boto3 method names, acronyms included', () => {
    assert.equal(xformName('DescribeRegions'), 'describe_regions');
    assert.equal(xformName('ListBuckets'), 'list_buckets');
    assert.equal(xformName('GetCallerIdentity'), 'get_caller_identity');
    // The classic traps: a trailing acronym, and an acronym followed by a word.
    assert.equal(xformName('CreateVPC'), 'create_vpc');
    assert.equal(xformName('DescribeVPCs'), 'describe_vpcs');
    assert.equal(xformName('ListMFADevices'), 'list_mfa_devices');
    assert.equal(xformName('GetObjectACL'), 'get_object_acl');
    // Digits attach to the preceding word, as botocore does it.
    assert.equal(xformName('PutBucketACL'), 'put_bucket_acl');
});

test('xformName matches botocore on the names that break naive implementations', () => {
    // Each of these was a real divergence found by replaying every operation in
    // botocore's shipped models through the container's own xform_name. They
    // cover the three separate rules, so a regression in any one shows up here:
    //
    //   trailing plural acronym -> the [A-Z]{2,}s$ special case
    //   embedded digits         -> NO digit splitting (assign_ipv6, not ipv_6)
    //   irregular names         -> botocore's hardcoded _xform_cache table
    assert.equal(xformName('DescribeVPCs'), 'describe_vpcs');
    assert.equal(xformName('ListARNs'), 'list_arns');
    assert.equal(xformName('AssignIpv6Addresses'), 'assign_ipv6_addresses');
    assert.equal(xformName('ListHITsForQualificationType'), 'list_hits_for_qualification_type');
    assert.equal(xformName('CreateCachediSCSIVolume'), 'create_cached_iscsi_volume');
    assert.equal(xformName('CreateOAuth2Token'), 'create_oauth2_token');
    assert.equal(xformName('AssociateWhatsAppBusinessAccount'),
        'associate_whatsapp_business_account');
});

test('xformName honours a non-underscore separator, overrides included', () => {
    // botocore's own table carries a '-' copy of every irregular name, and those
    // copies are the underscore form with the separator swapped — so the
    // overrides must apply here too, not just to the snake_case form.
    assert.equal(xformName('DescribeRegions', '-'), 'describe-regions');
    assert.equal(xformName('DescribeVPCs', '-'), 'describe-vpcs');
    assert.equal(xformName('CreateOAuth2Token', '-'), 'create-oauth2-token');
    assert.equal(xformName('CreateCachediSCSIVolume', '-'), 'create-cached-iscsi-volume');
});

test('xformName leaves an already-snake_case name alone', () => {
    assert.equal(xformName('describe_regions'), 'describe_regions');
    assert.equal(xformName(''), '');
    assert.equal(xformName(null), '');
});

// ---------------------------------------------------------------------------
// JS / Java: camelCase
// ---------------------------------------------------------------------------

test('toCamelCase lower-cases only the leading acronym run, not the next word', () => {
    assert.equal(toCamelCase('DescribeRegions'), 'describeRegions');
    assert.equal(toCamelCase('GetCallerIdentity'), 'getCallerIdentity');
    // "DBInstances" must become "dbInstances", NOT "dBInstances" (naive
    // lower-first) and not "dbinstances" (whole-run lower-casing).
    assert.equal(toCamelCase('DBInstances'), 'dbInstances');
    assert.equal(toCamelCase('DBSnapshot'), 'dbSnapshot');
    assert.equal(toCamelCase('ACLName'), 'aclName');
});

test('toCamelCase handles an all-caps name and degenerate input', () => {
    assert.equal(toCamelCase('ACL'), 'acl');
    assert.equal(toCamelCase('S3'), 's3');
    assert.equal(toCamelCase(''), '');
    assert.equal(toCamelCase(null), '');
});

// ---------------------------------------------------------------------------
// word splitting (feeds the Java client class name)
// ---------------------------------------------------------------------------

test('splitWords keeps acronyms whole and splits on separators and case', () => {
    assert.deepEqual(splitWords('DynamoDB'), ['Dynamo', 'DB']);
    assert.deepEqual(splitWords('EC2'), ['EC2']);
    assert.deepEqual(splitWords('API Gateway'), ['API', 'Gateway']);
    assert.deepEqual(splitWords('elastic-load-balancing'), ['elastic', 'load', 'balancing']);
    assert.deepEqual(splitWords('secrets_manager'), ['secrets', 'manager']);
    assert.deepEqual(splitWords(''), []);
    assert.deepEqual(splitWords(null), []);
});

// ---------------------------------------------------------------------------
// client class names
// ---------------------------------------------------------------------------

test('javaClientName matches the AWS SDK v2 class names', () => {
    // The SDK title-cases each word, so DynamoDB becomes DynamoDbClient — the
    // name a naive "condense and capitalise" pass gets wrong.
    assert.equal(javaClientName('DynamoDB', 'dynamodb'), 'DynamoDbClient');
    assert.equal(javaClientName('EC2', 'ec2'), 'Ec2Client');
    assert.equal(javaClientName('S3', 's3'), 'S3Client');
    assert.equal(javaClientName('STS', 'sts'), 'StsClient');
    assert.equal(javaClientName('Lambda', 'lambda'), 'LambdaClient');
});

test('jsClientName matches the AWS SDK v3 class names', () => {
    // v3 preserves the serviceId casing, so DynamoDB stays DynamoDB.
    assert.equal(jsClientName('DynamoDB', 'dynamodb'), 'DynamoDBClient');
    assert.equal(jsClientName('EC2', 'ec2'), 'EC2Client');
    assert.equal(jsClientName('S3', 's3'), 'S3Client');
    assert.equal(jsClientName('STS', 'sts'), 'STSClient');
    // Multi-word service ids are condensed, matching the package's export.
    assert.equal(jsClientName('API Gateway', 'apigateway'), 'APIGatewayClient');
});

test('client-name helpers return null rather than a broken name for empty input', () => {
    assert.equal(javaClientName('', ''), null);
    assert.equal(jsClientName('', ''), null);
});

// ---------------------------------------------------------------------------
// documentation cleanup (this text goes into the hover card)
// ---------------------------------------------------------------------------

test('stripDocumentation turns botocore HTML into readable plain text', () => {
    const html =
        '<p>Describes the <i>Regions</i> that are enabled.</p>' +
        '<ul><li>First</li><li>Second</li></ul>' +
        '<p>See &lt;docs&gt; &amp; the guide.</p>';
    const text = stripDocumentation(html);
    // Tags must be gone. This is deliberately tag-shaped rather than a blanket
    // "no < anywhere": a decoded &lt; is legitimate content (asserted below).
    assert.doesNotMatch(text, /<\/?(p|i|b|ul|ol|li|div|code|a|br)\b[^>]*>/i,
        'raw HTML left in the hover text');
    assert.match(text, /Describes the Regions that are enabled/);
    assert.match(text, /- First/);
    assert.match(text, /<docs> & the guide/, 'HTML entities must be decoded');
});

test('stripDocumentation truncates on a word boundary with an ellipsis', () => {
    const long = stripDocumentation('<p>' + 'word '.repeat(400) + '</p>');
    assert.ok(long.length < 700, 'unbounded doc text would bloat every completion item');
    assert.match(long, /…$/);
    assert.doesNotMatch(long, /wor…$/, 'must not cut mid-word');
});

test('stripDocumentation handles missing documentation', () => {
    assert.equal(stripDocumentation(null), '');
    assert.equal(stripDocumentation(''), '');
});

// ---------------------------------------------------------------------------
// shape / parameter extraction
// ---------------------------------------------------------------------------

// A miniature botocore model, shaped exactly like the real ones.
const MODEL = {
    metadata: {
        serviceId: 'EC2',
        endpointPrefix: 'ec2',
        apiVersion: '2016-11-15',
        protocol: 'ec2',
        signingName: 'ec2'
    },
    operations: {
        DescribeRegions: {
            http: { method: 'POST', requestUri: '/' },
            documentation: '<p>Describes the Regions.</p>',
            input: { shape: 'DescribeRegionsRequest' }
        },
        CreateTags: {
            http: { method: 'POST', requestUri: '/' },
            documentation: '<p>Adds tags.</p>',
            input: { shape: 'CreateTagsRequest' }
        }
    },
    shapes: {
        DescribeRegionsRequest: {
            type: 'structure',
            members: {
                RegionNames: { shape: 'RegionNameStringList', documentation: '<p>The names.</p>' },
                DryRun: { shape: 'Boolean' },
                AllRegions: { shape: 'Boolean' }
            }
        },
        CreateTagsRequest: {
            type: 'structure',
            required: ['Resources', 'Tags'],
            members: {
                Resources: { shape: 'ResourceIdList' },
                Tags: { shape: 'TagList' },
                DryRun: { shape: 'Boolean' }
            }
        },
        RegionNameStringList: { type: 'list', member: { shape: 'String' } },
        ResourceIdList: { type: 'list', member: { shape: 'String' } },
        TagList: { type: 'list', member: { shape: 'Tag' } },
        Tag: { type: 'structure', members: { Key: { shape: 'String' }, Value: { shape: 'String' } } },
        TagMap: { type: 'map', key: { shape: 'String' }, value: { shape: 'String' } },
        String: { type: 'string' },
        Boolean: { type: 'boolean' },
        When: { type: 'timestamp' },
        Body: { type: 'blob' }
    }
};

test('describeShapeType renders container shapes in a form a user can read', () => {
    assert.equal(describeShapeType(MODEL, 'String'), 'string');
    assert.equal(describeShapeType(MODEL, 'Boolean'), 'boolean');
    assert.equal(describeShapeType(MODEL, 'When'), 'timestamp');
    assert.equal(describeShapeType(MODEL, 'Body'), 'blob');
    assert.equal(describeShapeType(MODEL, 'RegionNameStringList'), 'list<string>');
    assert.equal(describeShapeType(MODEL, 'TagList'), 'list<Tag>');
    assert.equal(describeShapeType(MODEL, 'TagMap'), 'map<string, string>');
    // A structure is named, not expanded — expanding it would recurse forever.
    assert.equal(describeShapeType(MODEL, 'Tag'), 'Tag');
    assert.equal(describeShapeType(MODEL, 'NoSuchShape'), 'unknown');
});

test('extractParams puts required parameters first, then sorts alphabetically', () => {
    // The IDE pre-fills required parameters into the call snippet, so their
    // order is what the user ends up typing around.
    const params = extractParams(MODEL, MODEL.operations.CreateTags);
    assert.deepEqual(params.map(p => p.name), ['Resources', 'Tags', 'DryRun']);
    assert.deepEqual(params.filter(p => p.required).map(p => p.name), ['Resources', 'Tags']);
    assert.equal(params[0].type, 'list<string>');
});

test('extractParams handles an operation with no input shape', () => {
    assert.deepEqual(extractParams(MODEL, { http: { method: 'POST' } }), []);
    assert.deepEqual(extractParams(MODEL, {}), []);
});

test('extractParams caps the parameter list', () => {
    // Some shapes have hundreds of members; a completion item cannot show them
    // all and an unbounded list would bloat the cached index.
    const members = {};
    for (let i = 0; i < MAX_PARAMS_PER_OPERATION + 25; i += 1) {
        members['Param' + String(i).padStart(3, '0')] = { shape: 'String' };
    }
    const model = {
        shapes: Object.assign({ Big: { type: 'structure', members: members } }, MODEL.shapes)
    };
    assert.equal(extractParams(model, { input: { shape: 'Big' } }).length, MAX_PARAMS_PER_OPERATION);
});

// ---------------------------------------------------------------------------
// the index the editor actually consumes
// ---------------------------------------------------------------------------

test('buildIndexFromModel produces every per-language name for each operation', () => {
    const index = buildIndexFromModel(MODEL, { service: 'ec2', label: 'Amazon EC2' });

    assert.equal(index.service, 'ec2');
    assert.equal(index.label, 'Amazon EC2');
    assert.equal(index.serviceId, 'EC2');
    assert.equal(index.apiVersion, '2016-11-15');
    assert.equal(index.operationCount, 2);

    const describe = index.operations.find(op => op.name === 'DescribeRegions');
    assert.equal(describe.python, 'describe_regions');
    assert.equal(describe.javascript, 'describeRegions');
    assert.equal(describe.java, 'describeRegions');
    assert.equal(describe.command, 'DescribeRegionsCommand');
    assert.equal(describe.http, 'POST /');
    assert.match(describe.documentation, /Describes the Regions/);
});

test('buildIndexFromModel names the client and package for each language', () => {
    const clients = buildIndexFromModel(MODEL, { service: 'ec2', label: 'Amazon EC2' }).clients;
    // boto3.client() takes the botocore directory name, not the serviceId.
    assert.equal(clients.python, 'ec2');
    assert.equal(clients.pythonModule, 'boto3');
    assert.equal(clients.javascript, 'EC2Client');
    assert.equal(clients.javascriptPackage, '@aws-sdk/client-ec2');
    assert.equal(clients.java, 'Ec2Client');
    assert.equal(clients.javaPackage, 'software.amazon.awssdk.services.ec2');
});

test('buildIndexFromModel sorts operations so completion order is stable', () => {
    const names = buildIndexFromModel(MODEL, { service: 'ec2' }).operations.map(op => op.name);
    assert.deepEqual(names, names.slice().sort());
});

test('buildIndexFromModel can omit parameters for a lighter index', () => {
    const withParams = buildIndexFromModel(MODEL, { service: 'ec2' });
    assert.ok(withParams.operations[0].params.length > 0);
    assert.ok(Array.isArray(withParams.operations[0].requiredParams));

    const without = buildIndexFromModel(MODEL, { service: 'ec2' }, { includeParams: false });
    assert.equal(without.operations[0].params, undefined);
});

test('buildIndexFromModel survives an empty or malformed model', () => {
    const empty = buildIndexFromModel({}, { service: 'ec2', label: 'Amazon EC2' });
    assert.equal(empty.operationCount, 0);
    assert.deepEqual(empty.operations, []);
    assert.equal(empty.service, 'ec2');
    assert.doesNotThrow(() => buildIndexFromModel(null, null));
});

// ---------------------------------------------------------------------------
// language globals and the service catalogue
// ---------------------------------------------------------------------------

test('language globals exist for every runtime that has AWS completions', () => {
    // These drive the "boto3." / "new " completions before any service is known.
    assert.ok(Object.keys(getLanguageGlobals('python')).length > 0);
    assert.deepEqual(getLanguageGlobals('ruby'), {});
    assert.deepEqual(getLanguageGlobals(undefined), {});
});

test('the service catalogue is populated and well formed', () => {
    // Backed by lib/aws-service-index.json; if that file went missing the
    // editor's service-name completions would silently be empty.
    const services = listServiceNames();
    assert.ok(services.length > 100, 'expected the full botocore service list, got ' + services.length);
    for (const entry of services.slice(0, 20)) {
        assert.equal(typeof entry.service, 'string');
        assert.ok(entry.service.length > 0);
        assert.equal(typeof entry.label, 'string');
    }
    assert.ok(services.some(s => s.service === 'ec2'));
    assert.ok(services.some(s => s.service === 's3'));
    assert.ok(services.some(s => s.service === 'sts'));
});
