"use strict";

// The XML tokeniser behind the collapsible XML viewer.
//
// A string in, a tree out — so these tests are just strings and assertions, no
// fixtures and no I/O. The cases below are the ones where a naive
// "scan to the next '>'" parser produces a tree that looks plausible and is
// wrong, which is the failure mode worth pinning: a viewer that renders a
// confidently incorrect structure is worse than one that shows raw text.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXml, decodeEntities } = require('../lib/s3/s3Xml');

test('nesting, attributes and text-only leaves', () => {
    let tree = parseXml(
        '<project xmlns="http://maven.apache.org/POM/4.0.0">' +
        '<modelVersion>4.0.0</modelVersion>' +
        '<dependencies><dependency scope="test"><artifactId>junit</artifactId></dependency></dependencies>' +
        '</project>'
    );
    assert.equal(tree.root.name, 'project');
    assert.deepEqual(tree.root.attributes, [
        { name: 'xmlns', value: 'http://maven.apache.org/POM/4.0.0' }
    ]);
    assert.equal(tree.elementCount, 5);
    assert.equal(tree.incomplete, false);
    assert.equal(tree.truncated, false);

    // An element whose content is only text folds to a one-line leaf, which is
    // what lets the UI render `modelVersion  4.0.0` without an expander.
    let modelVersion = tree.root.children[0];
    assert.equal(modelVersion.text, '4.0.0');
    assert.deepEqual(modelVersion.children, []);

    let dependency = tree.root.children[1].children[0];
    assert.deepEqual(dependency.attributes, [{ name: 'scope', value: 'test' }]);
    assert.equal(dependency.children[0].name, 'artifactId');
});

test("a '>' inside an attribute value does not end the tag", () => {
    // The reason attributes are tokenised rather than found by scanning for '>'.
    let tree = parseXml('<rule match="a > b" action="deny"><note>ok</note></rule>');
    assert.deepEqual(tree.root.attributes, [
        { name: 'match', value: 'a > b' },
        { name: 'action', value: 'deny' }
    ]);
    assert.equal(tree.root.children.length, 1);
    assert.equal(tree.root.children[0].text, 'ok');
});

test("CDATA is literal, and '<' inside it is not a tag", () => {
    let tree = parseXml('<doc><![CDATA[if (a < b && c > d) { "&amp;" }]]></doc>');
    // Folded into the element's text, undecoded: CDATA means "these characters".
    assert.equal(tree.root.text, 'if (a < b && c > d) { "&amp;" }');
});

test('self-closing tags do not open a level', () => {
    let tree = parseXml('<config><flag name="x"/><flag name="y"/><child><leaf/></child></config>');
    assert.equal(tree.root.children.length, 3);
    assert.equal(tree.root.children[0].children.length, 0);
    assert.equal(tree.root.children[2].children[0].name, 'leaf');
    assert.equal(tree.incomplete, false);
});

test('comments and processing instructions are kept in order', () => {
    let tree = parseXml('<a><!-- why --><?php echo 1; ?><b>1</b></a>');
    assert.deepEqual(tree.root.children.map(child => child.type), ['comment', 'pi', 'element']);
    assert.equal(tree.root.children[0].text, 'why');
    assert.equal(tree.root.children[1].name, 'php');
});

test('the XML declaration is metadata, not a child node', () => {
    let tree = parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<a>1</a>');
    assert.equal(tree.declaration, 'version="1.0" encoding="UTF-8"');
    assert.equal(tree.root.name, 'a');
    assert.equal(tree.root.text, '1');
});

test("a DOCTYPE with an internal subset is skipped whole", () => {
    // The '>' characters inside `[ … ]` would end the DOCTYPE for a naive scan,
    // and the leftover DTD text would then be parsed as content.
    let tree = parseXml(
        '<!DOCTYPE note [<!ELEMENT note (to)><!ELEMENT to (#PCDATA)>]>' +
        '<note><to>Tove</to></note>'
    );
    assert.equal(tree.root.name, 'note');
    assert.equal(tree.root.children.length, 1);
    assert.equal(tree.root.children[0].text, 'Tove');
});

test('mixed content keeps text and elements interleaved', () => {
    let tree = parseXml('<p>Hello <b>world</b> and <i>others</i>.</p>');
    assert.deepEqual(tree.root.children.map(child => child.type),
        ['text', 'element', 'text', 'element', 'text']);
    assert.equal(tree.root.children[0].text, 'Hello');
    assert.equal(tree.root.text, null);
});

test('a ranged read is incomplete, not invalid', () => {
    // The preview reads only the head of a large object, so the last elements are
    // usually unclosed. Throwing that tree away would mean big XML never gets a
    // tree at all — exactly the files that need one most.
    let tree = parseXml('<catalog><item><sku>1</sku></item><item><sku>2');
    assert.equal(tree.incomplete, true);
    assert.equal(tree.root.name, 'catalog');
    assert.equal(tree.root.children.length, 2);
    assert.equal(tree.root.children[1].children[0].text, '2');
});

test('a mismatched closing tag throws rather than guessing', () => {
    assert.throws(() => parseXml('<a><b>1</c></a>'), /does not match <b>/);
    assert.throws(() => parseXml('<a>1</a></b>'), /nothing open/);
});

test('two root elements throw — that is not one document', () => {
    assert.throws(() => parseXml('<a>1</a><b>2</b>'), /second root element <b>/);
});

test('unterminated constructs throw', () => {
    assert.throws(() => parseXml('<a><!-- forever'), /unterminated comment/);
    assert.throws(() => parseXml('<a><![CDATA[forever'), /unterminated CDATA/);
    assert.throws(() => parseXml('<a attr="forever'), /unterminated attribute/);
});

test('node and depth bounds stop a pathological document', () => {
    let deep = '<a>'.repeat(50) + '</a>'.repeat(50);
    let bounded = parseXml(deep, { maxDepth: 10 });
    assert.equal(bounded.truncated, true);

    let wide = '<root>' + '<i>x</i>'.repeat(500) + '</root>';
    let capped = parseXml(wide, { maxNodes: 100 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.nodeCount <= 110, 'stopped near the cap, got ' + capped.nodeCount);
});

test('predefined and numeric entities decode; custom ones do not', () => {
    assert.equal(decodeEntities('a &lt;b&gt; &amp; c &quot;d&quot; &apos;e&apos;'),
        'a <b> & c "d" \'e\'');
    assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
    // A custom DOCTYPE entity is left literal on purpose: expanding it is the
    // billion-laughs amplification, and object bytes are untrusted input.
    assert.equal(decodeEntities('&lol1;'), '&lol1;');
    assert.equal(decodeEntities('&#x110000;'), '&#x110000;');
});

test('a billion-laughs document cannot amplify', () => {
    let bomb =
        '<!DOCTYPE lolz [<!ENTITY lol "lol">' +
        '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
        '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' +
        '<lolz>&lol3;</lolz>';
    let tree = parseXml(bomb);
    // The reference survives as text; nothing expands. Two nodes: the element
    // and its text child (counted before the text-only fold collapses it).
    assert.equal(tree.root.text, '&lol3;');
    assert.equal(tree.nodeCount, 2);
});

test('an empty or element-less document yields no root', () => {
    assert.equal(parseXml('').root, null);
    assert.equal(parseXml('   \n  ').root, null);
    assert.equal(parseXml('<?xml version="1.0"?>').root, null);
});
