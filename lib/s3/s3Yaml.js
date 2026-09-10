"use strict";

/**
 * s3Yaml.js — YAML into a tree the browser can expand and collapse.
 *
 * The same argument as s3Xml.js, for the format S3 buckets are actually full of:
 * CloudFormation and SAM templates, Kubernetes manifests, Helm values,
 * docker-compose files, OpenAPI specs, CI pipelines. All of them are deep, all of
 * them are read by hunting for one branch, and all of them are shown by every
 * other S3 browser as a flat wall of indented text.
 *
 * WHY HAND-ROLLED. No YAML library is a dependency here, and adding one to render
 * a *view* is the wrong trade: js-yaml is a deserialiser (it produces JS values,
 * so comments vanish, key order is only incidentally preserved, and `1.0`,
 * `on` and `2024-01-01` come back as a number, a boolean and a Date — none of
 * which is what the file says). A viewer must show the document, not a decoded
 * approximation of it. Every scalar here stays the exact source text.
 *
 * WHAT IS PARSED. Block YAML, which is what configuration is written in:
 * indentation-nested mappings, block sequences (`- `), compact nesting
 * (`- key: value`), block scalars (`|`, `>`, with `-`/`+`/indent indicators),
 * quoted keys and values, comments, multiple documents (`---`/`...`), and
 * anchors/aliases/tags kept verbatim as part of the text.
 *
 * WHAT IS NOT. Flow collections (`[a, b]`, `{a: 1}`) are kept as a single scalar
 * string rather than parsed into children. They are rare in the deep documents
 * this exists for, they are already readable on one line, and parsing them
 * properly means implementing the flow grammar. Multi-line plain scalars fold
 * onto their key. Nothing here resolves types, aliases or merge keys — a viewer
 * that silently substituted an anchor's contents would be showing a document the
 * bytes do not contain.
 *
 * Tabs used for indentation are illegal YAML and are treated as a parse failure,
 * because guessing a tab's width would invent a structure. As with XML, anything
 * unparseable throws and the caller falls back to showing raw text.
 *
 * Pure: a string in, a tree out. No I/O, no clock, no fs.
 */

const DEFAULTS = {
    maxNodes: 20000,
    maxDepth: 128
};

/**
 * Split a content line into its value and trailing comment.
 *
 * A '#' only starts a comment when it follows whitespace or begins the line, so
 * `path: /a#b` keeps its fragment and `url: http://x/#y` is not truncated. A '#'
 * inside quotes is likewise literal, which is why this scans rather than using
 * indexOf.
 */
function splitComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
        let ch = line.charAt(i);
        if (quote) {
            if (ch === '\\' && quote === '"') {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
            return { value: line.slice(0, i).trimEnd(), comment: line.slice(i + 1).trim() };
        }
    }
    return { value: line.trimEnd(), comment: null };
}

/**
 * Find the ':' that separates a mapping key from its value, or -1.
 *
 * Must skip colons inside quotes (`"a:b": 1`) and inside flow collections
 * (`ports: [80:80]`), and — the case that matters most in practice — must not
 * treat `http://host` as a key/value split. YAML requires the colon to be
 * followed by whitespace or end-of-line, and that rule is what makes URLs work.
 */
function findKeySeparator(text) {
    let quote = null;
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        let ch = text.charAt(i);
        if (quote) {
            if (ch === '\\' && quote === '"') {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '[' || ch === '{') {
            depth += 1;
            continue;
        }
        if (ch === ']' || ch === '}') {
            depth -= 1;
            continue;
        }
        if (ch === ':' && depth === 0) {
            let after = text.charAt(i + 1);
            if (after === '' || /\s/.test(after)) {
                return i;
            }
        }
    }
    return -1;
}

/** Quoted keys are shown unquoted — the quotes are syntax, not part of the name. */
function unquoteKey(key) {
    let trimmed = key.trim();
    if (trimmed.length >= 2) {
        let first = trimmed.charAt(0);
        if ((first === '"' || first === "'") && trimmed.charAt(trimmed.length - 1) === first) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

function indentWidth(line) {
    let i = 0;
    while (i < line.length && line.charAt(i) === ' ') {
        i += 1;
    }
    return i;
}

/** A block scalar header: `|`, `>`, with optional chomping and explicit indent. */
function isBlockScalar(value) {
    return /^[|>][+-]?[0-9]*$/.test(value.trim());
}

/**
 * True when the text after a key is only node properties — an anchor (`&name`) or
 * a tag (`!Type`) — and so the real value is the block indented below.
 *
 * `key: &anchor` reads like a leaf with the value "&anchor", and treating it that
 * way strands the whole block under it as siblings of its key. Which is not a
 * corner case: `&defaults` with a merge key is how every repeated block in a CI
 * pipeline or a docker-compose file is written. An alias (`*name`) is deliberately
 * excluded — that IS the value.
 */
function isPropertiesOnly(value) {
    let trimmed = value.trim();
    if (!trimmed) {
        return false;
    }
    return trimmed.split(/\s+/).every(function (token) {
        return token.charAt(0) === '&' || token.charAt(0) === '!';
    });
}

/**
 * Parse YAML into a tree.
 *
 * @param {string} text
 * @param {object} [options] { maxNodes, maxDepth }
 * @returns {object} {
 *   documents,     array of root nodes, one per `---` document
 *   nodeCount,
 *   truncated,     a bound was hit, so the tree is partial
 * }
 *
 * Node shapes (all carry `line`, the 1-based source line, so the viewer can show
 * it and the Raw tab can jump there):
 *   { type:'mapping',  key, value, comment, children:[], line }
 *   { type:'item',     value, comment, children:[], line }   a `- ` sequence entry
 *   { type:'scalar',   value, comment, line }                 a folded continuation
 *   { type:'comment',  comment, line }
 *
 * `value` on a mapping or item is the inline text after the key/dash, or null
 * when the value is the nested block below it. That is exactly the distinction
 * the UI needs: a node with a value and no children is a one-line leaf; a node
 * with children gets an expander.
 */
function parseYaml(text, options) {
    options = options || {};
    let maxNodes = options.maxNodes || DEFAULTS.maxNodes;
    let maxDepth = options.maxDepth || DEFAULTS.maxDepth;

    let lines = String(text == null ? '' : text).split(/\r?\n/);
    let documents = [];
    let nodeCount = 0;
    let truncated = false;

    // Current document root, and the open-node stack as {indent, node}.
    let current = null;
    let stack = [];
    // The most recently attached node, so a plain scalar continued on the next
    // line can fold onto the value it belongs to instead of becoming a sibling.
    let last = null;

    function fail(message, lineNumber) {
        let err = new Error(message + ' on line ' + lineNumber);
        err.yamlLine = lineNumber;
        throw err;
    }

    function startDocument() {
        current = { type: 'document', children: [], line: 0 };
        documents.push(current);
        stack = [];
    }

    /** Attach a node at the given indent, closing anything indented as deep or deeper. */
    function attach(node, indent) {
        while (stack.length && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
        let parent = stack.length ? stack[stack.length - 1].node : current;
        parent.children.push(node);
        nodeCount += 1;
        last = { indent: indent, node: node };
        return last;
    }

    function push(frame) {
        if (stack.length >= maxDepth) {
            truncated = true;
            return false;
        }
        stack.push(frame);
        return true;
    }

    for (let i = 0; i < lines.length; i += 1) {
        if (nodeCount >= maxNodes) {
            truncated = true;
            break;
        }

        let raw = lines[i];
        let lineNumber = i + 1;

        if (!raw.trim()) {
            continue;
        }

        // Tabs in indentation are illegal YAML; their width is unknowable, so any
        // structure derived from them would be a guess.
        if (/^[ ]*\t/.test(raw)) {
            fail('a tab in the indentation', lineNumber);
        }

        let indent = indentWidth(raw);
        let body = raw.slice(indent);

        // Document markers. `...` ends a document; the next `---` starts one.
        if (body === '---' || body.startsWith('--- ')) {
            startDocument();
            current.line = lineNumber;
            let rest = body.slice(3).trim();
            if (rest && rest.charAt(0) !== '#') {
                // `--- value` — a single-scalar document.
                let split = splitComment(rest);
                attach({ type: 'scalar', value: split.value, comment: split.comment,
                         line: lineNumber }, indent);
            }
            continue;
        }
        if (body === '...') {
            current = null;
            stack = [];
            continue;
        }

        if (!current) {
            startDocument();
        }

        if (body.charAt(0) === '#') {
            // A standalone comment. Kept, because in a config file the comment
            // above a key is often the only documentation there is.
            attach({ type: 'comment', comment: body.slice(1).trim(), line: lineNumber }, indent);
            continue;
        }

        let split = splitComment(body);
        let content = split.value;
        let comment = split.comment;
        if (!content) {
            if (comment !== null) {
                attach({ type: 'comment', comment: comment, line: lineNumber }, indent);
            }
            continue;
        }

        // A sequence entry, possibly with a mapping compacted onto the same line
        // (`- name: x`), which nests one level deeper than the dash.
        if (content === '-' || content.startsWith('- ')) {
            let inner = content.slice(1).trim();
            let item = { type: 'item', value: null, comment: comment, children: [], line: lineNumber };
            let frame = attach(item, indent);
            if (!push(frame)) {
                break;
            }
            if (!inner) {
                continue;
            }
            // The compact form: everything after `- ` is a child of the item, at an
            // indent just past the dash so following lines at that column join it.
            let innerIndent = indent + (content.length - content.slice(1).trimStart().length);
            let sep = findKeySeparator(inner);
            if (sep === -1) {
                item.value = inner;
                stack.pop();
                continue;
            }
            let key = unquoteKey(inner.slice(0, sep));
            let value = inner.slice(sep + 1).trim();
            let child = { type: 'mapping', key: key, value: null, comment: null,
                          children: [], line: lineNumber };
            let childFrame = attach(child, innerIndent);
            if (isBlockScalar(value)) {
                let block = readBlockScalar(lines, i, innerIndent, value);
                child.value = block.text;
                child.blockScalar = value;
                i = block.lastIndex;
                continue;
            }
            if (isPropertiesOnly(value)) {
                child.properties = value;
            } else if (value) {
                child.value = value;
                continue;
            }
            if (!push(childFrame)) {
                break;
            }
            continue;
        }

        let sep = findKeySeparator(content);
        if (sep === -1) {
            // Not a mapping and not a sequence entry. Indented under a node that
            // already has a value, this is a plain scalar continued across lines
            // (`key: some very` / `  long value`), so it folds onto that value
            // rather than becoming a phantom sibling.
            if (last && last.node.value && indent > last.indent) {
                last.node.value += ' ' + content;
                if (comment !== null && !last.node.comment) {
                    last.node.comment = comment;
                }
                continue;
            }
            attach({ type: 'scalar', value: content, comment: comment, line: lineNumber }, indent);
            continue;
        }

        let key = unquoteKey(content.slice(0, sep));
        let value = content.slice(sep + 1).trim();
        let node = { type: 'mapping', key: key, value: null, comment: comment,
                     children: [], line: lineNumber };
        let frame = attach(node, indent);

        if (isBlockScalar(value)) {
            // `|`/`>` — the following indented lines are the value, not structure.
            let block = readBlockScalar(lines, i, indent, value);
            node.value = block.text;
            node.blockScalar = value;
            i = block.lastIndex;
            continue;
        }
        if (isPropertiesOnly(value)) {
            // `key: &anchor` / `key: !Type` — the value is the block below.
            node.properties = value;
        } else if (value) {
            node.value = value;
            continue;
        }
        if (!push(frame)) {
            break;
        }
    }

    // Drop a trailing empty document (a file ending in `---`) and, in the common
    // single-document case, hand back one root rather than a wrapper.
    documents = documents.filter(function (doc) {
        return doc.children.length > 0;
    });

    return {
        documents: documents,
        nodeCount: nodeCount,
        truncated: truncated
    };
}

/**
 * Read a block scalar's body: every following line indented deeper than the
 * header's own indent. Returns the joined text and the index of the last line
 * consumed, so the main loop can skip past it.
 *
 * The content is returned as written (minus the common indent). Chomping and fold
 * indicators are recorded by the caller but not applied — a viewer should show
 * what is in the file, and applying `>` folding would rewrite it.
 */
function readBlockScalar(lines, headerIndex, headerIndent, header) {
    let explicit = /([0-9]+)/.exec(header.trim());
    let bodyIndent = explicit ? headerIndent + parseInt(explicit[1], 10) : null;
    let collected = [];
    let index = headerIndex;

    for (let i = headerIndex + 1; i < lines.length; i += 1) {
        let line = lines[i];
        if (!line.trim()) {
            // A blank line belongs to the block if the block continues after it.
            collected.push('');
            index = i;
            continue;
        }
        let indent = indentWidth(line);
        if (indent <= headerIndent) {
            break;
        }
        if (bodyIndent === null) {
            bodyIndent = indent;
        }
        collected.push(line.slice(Math.min(bodyIndent, indent)));
        index = i;
    }

    // Trailing blank lines were speculative — they may sit between this block and
    // the next key.
    while (collected.length && !collected[collected.length - 1].trim()) {
        collected.pop();
    }

    return { text: collected.join('\n'), lastIndex: Math.max(index, headerIndex) };
}

module.exports = {
    DEFAULTS: DEFAULTS,
    splitComment: splitComment,
    findKeySeparator: findKeySeparator,
    unquoteKey: unquoteKey,
    isPropertiesOnly: isPropertiesOnly,
    readBlockScalar: readBlockScalar,
    parseYaml: parseYaml
};
