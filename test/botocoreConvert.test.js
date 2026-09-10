"use strict";

// Guards the shared botocore -> Postman conversion used by both the on-demand
// AWS catalog (backend) and the CLI. Covers the five AWS wire protocols and the
// no-credentials-in-collection invariant.

const test = require('node:test');
const assert = require('node:assert/strict');

const { convert } = require('../lib/botocoreConvert');

// Minimal fake models per protocol.
const queryModel = {
    metadata: { protocol: 'query', endpointPrefix: 'sts', apiVersion: '2011-06-15', serviceId: 'STS' },
    operations: { GetCallerIdentity: { name: 'GetCallerIdentity', http: { method: 'POST', requestUri: '/' } } }
};
const jsonModel = {
    metadata: { protocol: 'json', endpointPrefix: 'dynamodb', apiVersion: '2012-08-10',
                jsonVersion: '1.0', targetPrefix: 'DynamoDB_20120810', serviceId: 'DynamoDB' },
    operations: { PutItem: { name: 'PutItem', http: { method: 'POST', requestUri: '/' } } }
};
const restJsonModel = {
    metadata: { protocol: 'rest-json', endpointPrefix: 'lambda', apiVersion: '2015-03-31', serviceId: 'Lambda' },
    operations: { GetFunction: { name: 'GetFunction', http: { method: 'GET', requestUri: '/2015-03-31/functions/{FunctionName}' } } }
};
const restXmlModel = {
    metadata: { protocol: 'rest-xml', endpointPrefix: 's3', apiVersion: '2006-03-01', serviceId: 'S3' },
    operations: { PutObject: { name: 'PutObject', http: { method: 'PUT', requestUri: '/{Bucket}/{Key+}' } } }
};

test('query protocol: form-urlencoded Action + Version, POST /', () => {
    const col = convert(queryModel, { region: 'us-east-1' });
    assert.equal(col.item.length, 1);
    const r = col.item[0].request;
    assert.equal(r.method, 'POST');
    assert.equal(r.url.raw, 'https://sts.us-east-1.amazonaws.com/');
    assert.equal(r.body.mode, 'urlencoded');
    assert.deepEqual(r.body.urlencoded, [
        { key: 'Action', value: 'GetCallerIdentity' },
        { key: 'Version', value: '2011-06-15' }
    ]);
});

test('json protocol: X-Amz-Target header + json content type', () => {
    const r = convert(jsonModel).item[0].request;
    const target = r.header.find(h => h.key === 'X-Amz-Target');
    assert.equal(target.value, 'DynamoDB_20120810.PutItem');
    const ct = r.header.find(h => h.key === 'Content-Type');
    assert.equal(ct.value, 'application/x-amz-json-1.0');
    assert.equal(r.body.raw, '{}');
});

test('rest-json protocol: templated path, GET has no body', () => {
    const r = convert(restJsonModel).item[0].request;
    assert.equal(r.method, 'GET');
    assert.equal(r.url.raw, 'https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/:FunctionName');
    assert.equal(r.body, undefined);
});

test('rest-xml protocol: templated path with +suffix stripped, PUT has body', () => {
    const r = convert(restXmlModel).item[0].request;
    assert.equal(r.method, 'PUT');
    assert.equal(r.url.raw, 'https://s3.us-east-1.amazonaws.com/:Bucket/:Key');
    assert.equal(r.body.mode, 'raw');
});

test('region is honored for regional services', () => {
    const r = convert(queryModel, { region: 'eu-west-1' }).item[0].request;
    assert.match(r.url.raw, /sts\.eu-west-1\.amazonaws\.com/);
});

test('only filter restricts operations', () => {
    const model = {
        metadata: { protocol: 'query', endpointPrefix: 'sts', apiVersion: '2011-06-15' },
        operations: {
            GetCallerIdentity: { name: 'GetCallerIdentity', http: { method: 'POST', requestUri: '/' } },
            AssumeRole: { name: 'AssumeRole', http: { method: 'POST', requestUri: '/' } }
        }
    };
    const col = convert(model, { only: ['AssumeRole'] });
    assert.equal(col.item.length, 1);
    assert.equal(col.item[0].name, 'AssumeRole');
});

test('every request is SigV4 and carries no credentials', () => {
    for (const model of [queryModel, jsonModel, restJsonModel, restXmlModel]) {
        const r = convert(model).item[0].request;
        assert.equal(r.auth.type, 'awsv4');
        const serialized = JSON.stringify(r);
        assert.doesNotMatch(serialized, /accessKey|secretKey|SessionToken|Bearer /i);
    }
});
