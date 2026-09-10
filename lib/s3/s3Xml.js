"use strict";

/**
 * s3Xml.js — XML into a tree the browser can expand and collapse.
 *
 * XML previewed as flat text is the same problem as JSON previewed as flat text:
 * the structure is right there in the bytes and the viewer throws it away. This
 * turns the text into nodes, so a 4000-line CloudFormation template or a Maven
 * POM opens as something you can navigate instead of scroll.
 *
 * WHY HAND-ROLLED. xml2js is already a dependency (s3Client parses S3's own
 * responses with it), but it is the wrong tool here twice over. It is built to
 * turn XML into a *data object* — it drops document order unless coaxed with
 * `explicitChildren`/`preserveChildrenOrder`/`charsAsChildren`, and even then
 * mixed content and attributes come back in a shape that costs more to convert
 * faithfully than to tokenise from scratch. And `previewBuffer` is synchronous by
 * design, while xml2js hands results to a callback (synchronously today, by
 * implementation detail). A viewer needs order, attributes, comments and CDATA
 * exactly as written — which is a tokeniser's job, not a deserialiser's.
 *
 * The grammar is deliberately small: elements, attributes, text, CDATA,
 * comments, processing instructions, and DOCTYPE (skipped). That is all XML in
 * the wild needs for a *view*. Anything it cannot make sense of throws, and the
 * caller falls back to showing raw text — a half-parsed tree presented
 * confidently is worse than no tree.
 *
 * ENTITIES: the five predefined names and numeric character references are
 * decoded. Custom entities declared in a DOCTYPE are deliberately NOT expanded —
 * they are left as literal text. That is not a limitation to fix later: entity
 * expansion is the "billion laughs" denial-of-service, and an object out of an S3
 * bucket is untrusted input. Not expanding is what makes this parser safe to
 * point at anything, by construction rather than by limit-checking.
 *
 * Pure: a string in, a tree out. No I/O, no clock, no fs — so the tests are just
 * strings and assertions.
 */

// Bounds. A preview is not a document loader: a tree with 20 000 nodes is
// already past what anyone will read, and the depth cap stops a pathological
// document from growing the parse stack.
const DEFAULTS = {
    maxNodes: 20000,
    maxDepth: 256
};

const PREDEFINED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'"
};

/**
 * Decode the entity references a viewer must resolve to show text correctly.
 * Unknown names (i.e. custom DOCTYPE entities) are returned untouched — see the
 * note on billion laughs above.
 */
function decodeEntities(text) {
    if (text.indexOf('&') === -1) {
        return text;
    }
    return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z_][a-zA-Z0-9._-]*);/g,
        function (whole, body) {
            if (body.charAt(0) === '#') {
                let code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
                if (!isFinite(code) || code < 0 || code > 0x10FFFF) {
                    return whole;
                }
                try {
                    return String.fromCodePoint(code);
                } catch (err) {
                    return whole;
                }
            }
            let named = PREDEFINED_ENTITIES[body];
            return named === undefined ? whole : named;
        });
}

// XML names are broader than this in the spec (they allow most of Unicode), but
// a viewer only needs to know where the name *ends*, so "not a delimiter" is the
// useful test rather than "is a legal name character".
function isNameChar(ch) {
    return ch !== '' && !/[\s/>=<]/.test(ch);
}

/**
 * Parse XML into a tree.
 *
 * @param {string} text
 * @param {object} [options] { maxNodes, maxDepth }
 * @returns {object} {
 *   root,          the root element node (see below), or null for no element
 *   nodeCount,     nodes built
 *   elementCount,  of which elements
 *   truncated,     a bound was hit, so the tree is partial
 *   incomplete,    input ended with elements still open (a ranged read)
 *   declaration    the `<?xml …?>` text, if present
 * }
 *
 * Node shapes:
 *   { type:'element', name, attributes:[{name,value}], children:[], text }
 *   { type:'text'|'comment'|'cdata', text }
 *   { type:'pi', name, text }
 *
 * `text` on an element is set only when the element's content is *entirely*
 * text — the leaf case, which the UI renders on one line as `name  value`. An
 * element with element children keeps its text as `text` child nodes so mixed
 * content stays in document order.
 */
function parseXml(text, options) {
    options = options || {};
    let maxNodes = options.maxNodes || DEFAULTS.maxNodes;
    let maxDepth = options.maxDepth || DEFAULTS.maxDepth;

    let source = String(text == null ? '' : text);
    let length = source.length;
    let at = 0;

    let root = null;
    let stack = [];
    let nodeCount = 0;
    let elementCount = 0;
    let truncated = false;
    let declaration = null;

    function fail(message) {
        let err = new Error(message + ' at character ' + at);
        err.xmlPosition = at;
        throw err;
    }

    /** Append to the open element, or record the root. Text outside the root is
     *  dropped: whitespace and stray characters between the prolog and the root
     *  element are not content anyone wants to see in a tree. */
    function append(node) {
        nodeCount += 1;
        if (stack.length) {
            stack[stack.length - 1].children.push(node);
            return true;
        }
        if (node.type === 'element' && !root) {
            root = node;
            return true;
        }
        // A second root element means this is not one XML document. Concatenated
        // documents are a real thing in S3, but guessing at them would render a
        // structure the file does not have.
        if (node.type === 'element') {
            fail('a second root element <' + node.name + '>');
        }
        nodeCount -= 1;
        return false;
    }

    /** An element whose content is only text becomes a one-line leaf. */
    function foldTextOnly(element) {
        if (!element.children.length) {
            return;
        }
        let allText = element.children.every(function (child) {
            return child.type === 'text' || child.type === 'cdata';
        });
        if (allText) {
            element.text = element.children.map(function (child) {
                return child.text;
            }).join('');
            element.children = [];
        }
    }

    function indexOfOrFail(needle, what) {
        let end = source.indexOf(needle, at);
        if (end === -1) {
            fail('unterminated ' + what);
        }
        return end;
    }

    while (at < length) {
        if (nodeCount >= maxNodes) {
            truncated = true;
            break;
        }

        let next = source.indexOf('<', at);

        // Character data up to the next tag.
        if (next !== at) {
            let raw = next === -1 ? source.slice(at) : source.slice(at, next);
            let trimmed = raw.trim();
            if (trimmed) {
                append({ type: 'text', text: decodeEntities(trimmed) });
            }
            if (next === -1) {
                break;
            }
            at = next;
            continue;
        }

        if (source.startsWith('<!--', at)) {
            at += 4;
            let end = indexOfOrFail('-->', 'comment');
            append({ type: 'comment', text: source.slice(at, end).trim() });
            at = end + 3;
            continue;
        }

        if (source.startsWith('<![CDATA[', at)) {
            at += 9;
            let end = indexOfOrFail(']]>', 'CDATA section');
            // CDATA is literal by definition — no entity decoding here.
            append({ type: 'cdata', text: source.slice(at, end) });
            at = end + 3;
            continue;
        }

        if (source.startsWith('<!', at)) {
            // DOCTYPE and friends. Skipped rather than shown, but an internal DTD
            // subset (`[ … ]`) can contain '>' characters, so the naive scan to
            // the next '>' would stop in the middle of it.
            at += 2;
            let depth = 0;
            while (at < length) {
                let ch = source.charAt(at);
                if (ch === '[') {
                    depth += 1;
                } else if (ch === ']') {
                    depth -= 1;
                } else if (ch === '>' && depth <= 0) {
                    at += 1;
                    break;
                }
                at += 1;
            }
            continue;
        }

        if (source.startsWith('<?', at)) {
            at += 2;
            let end = indexOfOrFail('?>', 'processing instruction');
            let body = source.slice(at, end);
            let space = body.search(/\s/);
            let piName = space === -1 ? body : body.slice(0, space);
            let piText = space === -1 ? '' : body.slice(space + 1).trim();
            if (piName.toLowerCase() === 'xml' && !root && !stack.length) {
                // The declaration is metadata about the document, not content.
                declaration = piText;
            } else {
                append({ type: 'pi', name: piName, text: piText });
            }
            at = end + 2;
            continue;
        }

        if (source.startsWith('</', at)) {
            at += 2;
            let end = indexOfOrFail('>', 'closing tag');
            let name = source.slice(at, end).trim();
            let open = stack[stack.length - 1];
            if (!open) {
                fail('closing tag </' + name + '> with nothing open');
            }
            if (open.name !== name) {
                fail('closing tag </' + name + '> does not match <' + open.name + '>');
            }
            foldTextOnly(open);
            stack.pop();
            at = end + 1;
            continue;
        }

        // An open tag.
        at += 1;
        let nameStart = at;
        while (at < length && isNameChar(source.charAt(at))) {
            at += 1;
        }
        let name = source.slice(nameStart, at);
        if (!name) {
            fail('a tag with no name');
        }

        let element = { type: 'element', name: name, attributes: [], children: [], text: null };
        let selfClosing = false;

        // Attributes.
        for (;;) {
            while (at < length && /\s/.test(source.charAt(at))) {
                at += 1;
            }
            if (at >= length) {
                fail('unterminated tag <' + name + '>');
            }
            let ch = source.charAt(at);
            if (ch === '>') {
                at += 1;
                break;
            }
            if (ch === '/' && source.charAt(at + 1) === '>') {
                selfClosing = true;
                at += 2;
                break;
            }

            let attrStart = at;
            while (at < length && isNameChar(source.charAt(at))) {
                at += 1;
            }
            let attrName = source.slice(attrStart, at);
            if (!attrName) {
                fail('unexpected "' + ch + '" in tag <' + name + '>');
            }
            while (at < length && /\s/.test(source.charAt(at))) {
                at += 1;
            }
            let value = '';
            if (source.charAt(at) === '=') {
                at += 1;
                while (at < length && /\s/.test(source.charAt(at))) {
                    at += 1;
                }
                let quote = source.charAt(at);
                if (quote === '"' || quote === "'") {
                    at += 1;
                    let close = source.indexOf(quote, at);
                    if (close === -1) {
                        fail('unterminated attribute ' + attrName + ' in <' + name + '>');
                    }
                    // A quoted value may legally contain '>' — which is exactly
                    // why attributes are parsed here rather than by scanning the
                    // tag to the first '>'.
                    value = decodeEntities(source.slice(at, close));
                    at = close + 1;
                } else {
                    // Unquoted values are invalid XML, but they cost nothing to
                    // read and the alternative is discarding the whole tree.
                    let valueStart = at;
                    while (at < length && !/[\s/>]/.test(source.charAt(at))) {
                        at += 1;
                    }
                    value = decodeEntities(source.slice(valueStart, at));
                }
            } else {
                // A bare attribute name (HTML habit). Keep it, with no value.
                value = null;
            }
            element.attributes.push({ name: attrName, value: value });
        }

        // append() never rejects an element — a second root throws instead.
        append(element);
        elementCount += 1;
        if (!selfClosing) {
            if (stack.length >= maxDepth) {
                truncated = true;
                break;
            }
            stack.push(element);
        }
    }

    // Elements still open at the end of the input. This is the normal case for a
    // ranged preview — we only read the first chunk of the object — so the
    // partial tree is kept and flagged rather than thrown away.
    let incomplete = stack.length > 0;
    while (stack.length) {
        foldTextOnly(stack.pop());
    }

    return {
        root: root,
        nodeCount: nodeCount,
        elementCount: elementCount,
        truncated: truncated,
        incomplete: incomplete,
        declaration: declaration
    };
}

module.exports = {
    DEFAULTS: DEFAULTS,
    decodeEntities: decodeEntities,
    parseXml: parseXml
};
