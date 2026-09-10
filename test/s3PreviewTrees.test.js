"use strict";

// The collapsible-tree previews: which viewer an object resolves to, and what the
// preview hands the client.
//
// The contract these pin down is the one the UI depends on: on success the client
// gets structure AND the original text (so a Raw tab costs no second request), and
// on failure it gets `kind:'text'` with a note saying why — never an empty tree
// presented as if it were the document.

const test = require('node:test');
const assert = require('node:assert/strict');

const { previewXml, previewYaml, previewJson, previewBuffer } =
    require('../lib/s3/s3Preview');
const { resolveObjectType, VIEWERS } = require('../lib/s3/s3ContentTypes');

test('XML and YAML extensions resolve to their tree viewers', () => {
    ['xml', 'xsd', 'wsdl', 'rss', 'plist'].forEach(ext => {
        assert.equal(resolveObjectType({ key: 'a/b.' + ext }).viewer, VIEWERS.XML, ext);
    });
    ['yaml', 'yml'].forEach(ext => {
        assert.equal(resolveObjectType({ key: 'a/b.' + ext }).viewer, VIEWERS.YAML, ext);
    });
});

test('a tree viewer means text, so the preview path reads it rather than hex-dumping', () => {
    assert.equal(resolveObjectType({ key: 'pom.xml' }).isText, true);
    assert.equal(resolveObjectType({ key: 'values.yaml' }).isText, true);
});

test('an extension-less object stored as XML or YAML still gets its tree', () => {
    assert.equal(resolveObjectType({ key: 'feed', contentType: 'application/xml' }).viewer,
        VIEWERS.XML);
    assert.equal(resolveObjectType({ key: 'manifest', contentType: 'application/x-yaml' }).viewer,
        VIEWERS.YAML);
});

test('SVG and XHTML are NOT routed to the XML tree', () => {
    // They are script-capable, and the XML viewer's job is not to be a second
    // rendering path for them. See isInlineSafe's allowlist.
    assert.notEqual(resolveObjectType({ key: 'logo.svg' }).viewer, VIEWERS.XML);
    assert.notEqual(resolveObjectType({ key: 'page.xhtml' }).viewer, VIEWERS.XML);
});

test('previewXml returns a tree plus the source text', () => {
    let preview = previewXml('<a x="1"><b>2</b></a>', {});
    assert.equal(preview.kind, 'xml');
    assert.equal(preview.valid, true);
    assert.equal(preview.root.name, 'a');
    assert.equal(preview.elementCount, 2);
    assert.equal(preview.text, '<a x="1"><b>2</b></a>', 'the Raw tab needs no second request');
    assert.equal(preview.note, null);
});

test('unparseable XML degrades to text with a reason, not to an empty tree', () => {
    let preview = previewXml('<a><b>1</c></a>', {});
    assert.equal(preview.kind, 'text');
    assert.equal(preview.valid, false);
    assert.equal(preview.monacoLanguage, 'xml');
    assert.match(preview.note, /Not well-formed XML/);
    assert.match(preview.note, /showing raw text/);
});

test('a ranged XML read keeps its partial tree and says so', () => {
    let preview = previewXml('<catalog><item><sku>1</sku></item><item><sku>2',
        { sourceTruncated: true });
    assert.equal(preview.kind, 'xml');
    assert.equal(preview.truncated, true);
    assert.match(preview.note, /still open/);
});

test('XML with no elements is text, not a tree of nothing', () => {
    let preview = previewXml('just words', {});
    assert.equal(preview.kind, 'text');
    assert.match(preview.note, /No XML elements/);
});

test('previewYaml returns documents plus the source text', () => {
    let source = 'kind: Service\nmetadata:\n  name: web\n';
    let preview = previewYaml(source, {});
    assert.equal(preview.kind, 'yaml');
    assert.equal(preview.valid, true);
    assert.equal(preview.documents.length, 1);
    assert.equal(preview.documents[0].children[1].children[0].value, 'web');
    assert.equal(preview.text, source);
});

test('a multi-document YAML preview keeps every document', () => {
    let preview = previewYaml('kind: A\n---\nkind: B\n', {});
    assert.equal(preview.documents.length, 2);
});

test('YAML that will not parse degrades to text with a reason', () => {
    let preview = previewYaml('a:\n\tb: 1', {});
    assert.equal(preview.kind, 'text');
    assert.equal(preview.valid, false);
    assert.equal(preview.monacoLanguage, 'yaml');
    assert.match(preview.note, /Could not parse as YAML/);
});

test('previewJson keeps text the client can parse for its own tree', () => {
    // The Tree tab is built client-side from preview.text, which is only safe
    // because the server already parsed it and re-serialised.
    let preview = previewJson('{"b":1,"a":[1,2]}', {});
    assert.equal(preview.kind, 'json');
    assert.equal(preview.valid, true);
    assert.deepEqual(JSON.parse(preview.text), { b: 1, a: [1, 2] });
});

test('previewBuffer dispatches XML and YAML to the tree previews', () => {
    let xml = previewBuffer(Buffer.from('<a><b>1</b></a>'), {
        resolvedType: resolveObjectType({ key: 'p.xml' })
    });
    assert.equal(xml.kind, 'xml');
    assert.equal(xml.encoding, 'utf8');

    let yaml = previewBuffer(Buffer.from('a:\n  b: 1\n'), {
        resolvedType: resolveObjectType({ key: 'v.yaml' })
    });
    assert.equal(yaml.kind, 'yaml');
    assert.equal(yaml.documents[0].children[0].key, 'a');
});

test('text whose content is JSON gets the JSON tree anyway', () => {
    // A real object in a real cf-templates bucket: a JSON CloudFormation template
    // named `.template`, an extension the map cannot classify. It resolved to plain
    // text and lost its structure for no reason other than its name.
    let body = '{"AWSTemplateFormatVersion":"2010-09-09","Resources":{"Role":{"Type":"AWS::IAM::Role"}}}';
    let buffer = Buffer.from(body);
    let preview = previewBuffer(buffer, {
        resolvedType: resolveObjectType({ key: 'stack.template', head: buffer })
    });
    assert.equal(preview.kind, 'json');
    assert.equal(JSON.parse(preview.text).Resources.Role.Type, 'AWS::IAM::Role');
});

test('the JSON upgrade does not misclassify text that merely starts with a brace', () => {
    let preview = previewBuffer(Buffer.from('{not json at all\nsecond line\n'), {
        resolvedType: resolveObjectType({ key: 'notes.txt' })
    });
    assert.equal(preview.kind, 'text');
});

test('a real CloudFormation template comes out with the shape it has on disk', () => {
    // The end-to-end sanity check: the deep-and-repetitive document this feature
    // exists for, including a tagged intrinsic, an inline block scalar full of
    // colons, and a compact list of mappings.
    let template = [
        'AWSTemplateFormatVersion: "2010-09-09"',
        'Description: >-',
        '  A stack with a bucket',
        '  and a function',
        'Resources:',
        '  Bucket:',
        '    Type: AWS::S3::Bucket',
        '    Properties:',
        '      BucketName: !Sub "${AWS::StackName}-data"',
        '      Tags:',
        '        - Key: env',
        '          Value: prod',
        '        - Key: owner',
        '          Value: platform',
        '  Fn:',
        '    Type: AWS::Lambda::Function',
        '    Properties:',
        '      Runtime: python3.11',
        '      Code:',
        '        ZipFile: |',
        '          def handler(event, context):',
        '              return {"statusCode": 200}',
        'Outputs:',
        '  BucketArn:',
        '    Value: !GetAtt Bucket.Arn'
    ].join('\n');

    let preview = previewYaml(template, {});
    assert.equal(preview.kind, 'yaml');
    let root = preview.documents[0];
    assert.deepEqual(root.children.map(child => child.key),
        ['AWSTemplateFormatVersion', 'Description', 'Resources', 'Outputs']);

    let resources = root.children[2];
    assert.deepEqual(resources.children.map(child => child.key), ['Bucket', 'Fn']);

    let bucketProps = resources.children[0].children[1];
    assert.equal(bucketProps.key, 'Properties');
    assert.equal(bucketProps.children[0].value, '!Sub "${AWS::StackName}-data"');

    let tags = bucketProps.children[1];
    assert.equal(tags.children.length, 2, 'two tags, not four keys');
    assert.deepEqual(tags.children[0].children.map(child => child.value), ['env', 'prod']);

    let zipFile = resources.children[1].children[1].children[1].children[0];
    assert.equal(zipFile.key, 'ZipFile');
    assert.match(zipFile.value, /^def handler/);
    assert.deepEqual(zipFile.children, [], 'python source is a value, not structure');

    assert.equal(root.children[3].children[0].children[0].value, '!GetAtt Bucket.Arn');
});
