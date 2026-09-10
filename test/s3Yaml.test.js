"use strict";

// The YAML tokeniser behind the collapsible YAML viewer.
//
// A string in, a tree out — so, as with s3Xml, these tests are strings and
// assertions with no fixtures and no I/O. The cases are the ones where a naive
// "split on the first colon, count the spaces" parser produces a plausible-looking
// tree that misrepresents the file: URLs in values, comment characters inside
// quotes, block scalars whose contents look like structure, and the compact
// `- key: value` nesting that every Kubernetes manifest is made of.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseYaml, findKeySeparator, splitComment, unquoteKey } = require('../lib/s3/s3Yaml');

/** The single document's children, which is what almost every test wants. */
function rootOf(text, options) {
    let tree = parseYaml(text, options);
    return tree.documents[0];
}

test('nested mappings become nested nodes; leaves keep their value', () => {
    let root = rootOf([
        'apiVersion: apps/v1',
        'metadata:',
        '  name: web',
        '  labels:',
        '    app: web'
    ].join('\n'));

    assert.equal(root.children.length, 2);
    let apiVersion = root.children[0];
    assert.equal(apiVersion.key, 'apiVersion');
    assert.equal(apiVersion.value, 'apps/v1');
    assert.deepEqual(apiVersion.children, []);

    let metadata = root.children[1];
    assert.equal(metadata.value, null, 'a node whose value is the block below has no inline value');
    assert.equal(metadata.children.length, 2);
    assert.equal(metadata.children[1].key, 'labels');
    assert.equal(metadata.children[1].children[0].key, 'app');
});

test('a URL value is not split at its colon', () => {
    // The whole reason findKeySeparator requires whitespace after the colon.
    let root = rootOf('endpoint: https://s3.us-east-1.amazonaws.com/bucket');
    assert.equal(root.children[0].key, 'endpoint');
    assert.equal(root.children[0].value, 'https://s3.us-east-1.amazonaws.com/bucket');
});

test('a colon inside quotes or a flow collection is not a separator', () => {
    assert.equal(findKeySeparator('"a:b": 1'), 5);
    assert.equal(findKeySeparator('ports: [80:80, 443:443]'), 5);
    assert.equal(findKeySeparator('image: nginx:1.25'), 5);
    assert.equal(findKeySeparator('just a plain scalar'), -1);
});

test("a '#' only starts a comment after whitespace, and never inside quotes", () => {
    assert.deepEqual(splitComment('key: value # why'), { value: 'key: value', comment: 'why' });
    assert.deepEqual(splitComment('url: http://x/#frag'),
        { value: 'url: http://x/#frag', comment: null });
    assert.deepEqual(splitComment('pattern: "a # b"'),
        { value: 'pattern: "a # b"', comment: null });
});

test('sequence entries nest under their key', () => {
    let root = rootOf([
        'ports:',
        '  - 80',
        '  - 443'
    ].join('\n'));
    let ports = root.children[0];
    assert.equal(ports.children.length, 2);
    assert.deepEqual(ports.children.map(child => child.type), ['item', 'item']);
    assert.deepEqual(ports.children.map(child => child.value), ['80', '443']);
});

test('compact `- key: value` nesting keeps sibling keys under the same item', () => {
    // The shape of every container list in every Kubernetes manifest: the keys
    // after the dash belong to the item, not to the list.
    let root = rootOf([
        'containers:',
        '  - name: web',
        '    image: nginx:1.25',
        '    ports:',
        '      - containerPort: 80',
        '  - name: sidecar',
        '    image: envoy'
    ].join('\n'));

    let containers = root.children[0];
    assert.equal(containers.children.length, 2, 'two items, not four');

    let first = containers.children[0];
    assert.deepEqual(first.children.map(child => child.key), ['name', 'image', 'ports']);
    assert.equal(first.children[1].value, 'nginx:1.25');

    let containerPort = first.children[2].children[0].children[0];
    assert.equal(containerPort.key, 'containerPort');
    assert.equal(containerPort.value, '80');

    assert.equal(containers.children[1].children[0].value, 'sidecar');
});

test('block scalar contents are the value, not structure', () => {
    // `userData: |` followed by shell lines that contain colons and dashes. Parsed
    // as YAML they would become a fictitious subtree.
    let root = rootOf([
        'userData: |',
        '  #!/bin/bash',
        '  echo host: localhost',
        '  - not a list',
        'runtime: nodejs20.x'
    ].join('\n'));

    let userData = root.children[0];
    assert.equal(userData.blockScalar, '|');
    assert.equal(userData.value, '#!/bin/bash\necho host: localhost\n- not a list');
    assert.deepEqual(userData.children, [], 'the block is text, so it has no children');

    // And the key after the block is a sibling, not a descendant.
    assert.equal(root.children[1].key, 'runtime');
});

test('block scalar chomping and folding indicators are recorded, not applied', () => {
    let root = rootOf([
        'description: >-',
        '  first line',
        '  second line',
        'name: x'
    ].join('\n'));
    assert.equal(root.children[0].blockScalar, '>-');
    assert.equal(root.children[0].value, 'first line\nsecond line',
        'shown as written — folding it would rewrite the file');
    assert.equal(root.children[1].key, 'name');
});

test('multiple documents each get their own root', () => {
    let tree = parseYaml([
        'kind: Service',
        '---',
        'kind: Deployment',
        '---',
        'kind: Ingress'
    ].join('\n'));
    assert.equal(tree.documents.length, 3);
    assert.deepEqual(tree.documents.map(doc => doc.children[0].value),
        ['Service', 'Deployment', 'Ingress']);
});

test('a leading `---` does not produce an empty first document', () => {
    let tree = parseYaml('---\nkind: Service\n');
    assert.equal(tree.documents.length, 1);
    assert.equal(tree.documents[0].children[0].key, 'kind');
});

test('standalone comments are kept in place', () => {
    // In a config file the comment above a key is often its only documentation.
    let root = rootOf([
        '# what this stack does',
        'Resources:',
        '  # the bucket',
        '  Bucket:',
        '    Type: AWS::S3::Bucket'
    ].join('\n'));

    assert.equal(root.children[0].type, 'comment');
    assert.equal(root.children[0].comment, 'what this stack does');
    let resources = root.children[1];
    assert.equal(resources.children[0].type, 'comment');
    assert.equal(resources.children[1].key, 'Bucket');
    assert.equal(resources.children[1].children[0].value, 'AWS::S3::Bucket');
});

test('a trailing comment rides on its node', () => {
    let root = rootOf('replicas: 3 # scaled up for the launch');
    assert.equal(root.children[0].value, '3');
    assert.equal(root.children[0].comment, 'scaled up for the launch');
});

test('quoted keys lose their quotes; values keep theirs', () => {
    assert.equal(unquoteKey('"a:b"'), 'a:b');
    assert.equal(unquoteKey("'x y'"), 'x y');
    let root = rootOf('greeting: "hello: world"');
    assert.equal(root.children[0].value, '"hello: world"',
        'a value is shown as written, quotes included');
});

test('a plain scalar continued on the next line folds onto its key', () => {
    let root = rootOf([
        'description: a long sentence',
        '  that wraps across lines',
        'name: x'
    ].join('\n'));
    assert.equal(root.children[0].value, 'a long sentence that wraps across lines');
    assert.equal(root.children.length, 2, 'no phantom node for the continuation');
});

test('an anchor is a property of the block below, not a leaf value', () => {
    // `defaults: &defaults` read as a leaf would strand the whole anchored block
    // as siblings of its own key — and an anchor plus a merge key is how every
    // repeated block in a CI pipeline is written.
    let root = rootOf([
        'defaults: &defaults',
        '  retries: 3',
        '  timeout: 30',
        'job:',
        '  <<: *defaults'
    ].join('\n'));

    assert.equal(root.children.length, 2, 'two top-level keys, not four');
    let defaults = root.children[0];
    assert.equal(defaults.properties, '&defaults');
    assert.equal(defaults.value, null);
    assert.deepEqual(defaults.children.map(child => child.key), ['retries', 'timeout']);

    // An alias, by contrast, IS the value — substituting it would show a document
    // the bytes do not contain.
    assert.equal(root.children[1].children[0].key, '<<');
    assert.equal(root.children[1].children[0].value, '*defaults');
});

test('a tag before a block is a property too', () => {
    let root = rootOf([
        'Resource: !Sub',
        '  - arn:aws:s3:::${Bucket}',
        'Other: !Ref Bucket'
    ].join('\n'));
    assert.equal(root.children[0].properties, '!Sub');
    assert.equal(root.children[0].children.length, 1);
    // A tag with an inline value stays a leaf.
    assert.equal(root.children[1].value, '!Ref Bucket');
});

test('a tab in the indentation throws rather than guessing its width', () => {
    assert.throws(() => parseYaml('a:\n\tb: 1'), /tab in the indentation/);
});

test('flow collections stay on one line as a scalar', () => {
    // Documented limitation: readable already, and parsing them means implementing
    // the flow grammar.
    let root = rootOf('ports: [80, 443]\nlimits: {cpu: 1, memory: 512Mi}');
    assert.equal(root.children[0].value, '[80, 443]');
    assert.deepEqual(root.children[0].children, []);
    assert.equal(root.children[1].value, '{cpu: 1, memory: 512Mi}');
});

test('node and depth bounds stop a pathological document', () => {
    let wide = 'root:\n' + Array.from({ length: 500 }, (unused, i) => '  k' + i + ': ' + i).join('\n');
    let capped = parseYaml(wide, { maxNodes: 50 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.nodeCount <= 60, 'stopped near the cap, got ' + capped.nodeCount);

    let deep = Array.from({ length: 60 }, (unused, i) => ' '.repeat(i * 2) + 'k' + i + ':').join('\n');
    assert.equal(parseYaml(deep, { maxDepth: 10 }).truncated, true);
});

test('an empty or comment-only document yields nothing to show', () => {
    assert.deepEqual(parseYaml('').documents, []);
    assert.deepEqual(parseYaml('\n\n   \n').documents, []);
    assert.equal(parseYaml('# just a note\n').documents.length, 1,
        'a comment is still content worth showing');
});
