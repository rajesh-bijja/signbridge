/**
 * treeAdapters — turn a decoded preview into StructureTree nodes.
 *
 * One adapter per format, all producing the same node shape, so StructureTree
 * itself knows nothing about JSON, XML, YAML or zip members. See StructureTree.jsx
 * for the node contract.
 *
 * Two rules run through all of them:
 *
 *  - A node's `value` is the text the file contains, formatted for reading but
 *    never reinterpreted. A YAML `1.0` stays `1.0`; an XML element's text is what
 *    was between its tags. The one exception is JSON, where the server has already
 *    parsed the document, so strings are shown quoted to keep `"1"` and `1`
 *    distinguishable — which is the information a viewer of JSON needs most.
 *
 *  - `path` is the expression you would actually use to reach the node in that
 *    format's own idiom (`$.a.b[0]`, `/project/dependencies/dependency[2]`,
 *    `spec.template.containers[0].image`). Copying a path is the fastest route
 *    from "I found it in the viewer" to "I can query it in code", which is the
 *    whole reason the affordance is there.
 */

// A path segment is only safe in dotted form if it is a plain identifier;
// anything else is bracketed and quoted so the copied path still parses.
function dotted(base, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${base}.${key}`
    : `${base}[${JSON.stringify(key)}]`
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function jsonKind(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** How a JSON scalar reads in the tree: quoted strings, bare everything else. */
function jsonScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function jsonSummary(value) {
  if (Array.isArray(value)) {
    return value.length === 1 ? '1 item' : `${value.length} items`
  }
  const keys = Object.keys(value)
  return keys.length === 1 ? '1 key' : `${keys.length} keys`
}

/**
 * @param {*} value a parsed JSON value
 * @param {object} [options] { rootLabel }
 */
export function jsonToTree(value, options = {}) {
  const rootPath = options.rootPath || '$'

  function build(entryValue, label, path, id) {
    const kind = jsonKind(entryValue)
    if (kind !== 'object' && kind !== 'array') {
      return { id, path, label, value: jsonScalar(entryValue), badge: null, meta: null, children: [] }
    }

    const entries =
      kind === 'array'
        ? entryValue.map((item, index) => [String(index), item, `${path}[${index}]`, `[${index}]`])
        : Object.keys(entryValue).map(key => [key, entryValue[key], dotted(path, key), key])

    if (!entries.length) {
      // An empty container is a fact about the document, so it is shown rather
      // than rendered as an expander that opens onto nothing.
      return {
        id,
        path,
        label,
        value: kind === 'array' ? '[]' : '{}',
        badge: null,
        meta: null,
        children: []
      }
    }

    return {
      id,
      path,
      label,
      value: null,
      badge: kind === 'array' ? `[${entryValue.length}]` : null,
      meta: null,
      summary: jsonSummary(entryValue),
      children: entries.map(([, childValue, childPath, childLabel], index) =>
        build(childValue, childLabel, childPath, `${id}/${index}`)
      )
    }
  }

  const root = build(value, options.rootLabel || '', rootPath, 'json')
  // A top-level object or array is unwrapped: its keys are the tree, and a single
  // nameless root node above them would just cost a click.
  return root.children.length ? root.children : [root]
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

function xmlAttributeText(attributes) {
  if (!attributes || !attributes.length) return null
  return attributes
    .map(attribute => (attribute.value === null ? attribute.name : `${attribute.name}="${attribute.value}"`))
    .join(' ')
}

/** @param {object} root the `root` node from lib/s3/s3Xml.js */
export function xmlToTree(root) {
  if (!root) return []

  function build(node, path, id, siblingIndex) {
    if (node.type === 'element') {
      const elementChildren = node.children || []
      // Sibling elements of the same name get a 1-based index, XPath-style.
      const childPath = `${path}/${node.name}${siblingIndex > 0 ? `[${siblingIndex + 1}]` : ''}`
      const counts = new Map()
      return {
        id,
        path: childPath,
        label: `<${node.name}>`,
        value: node.text,
        badge: null,
        meta: xmlAttributeText(node.attributes),
        summary: elementChildren.length === 1 ? '1 child' : `${elementChildren.length} children`,
        children: elementChildren.map((child, index) => {
          let position = 0
          if (child.type === 'element') {
            position = counts.get(child.name) || 0
            counts.set(child.name, position + 1)
          }
          return build(child, childPath, `${id}/${index}`, position)
        })
      }
    }
    if (node.type === 'comment') {
      return { id, path: null, label: '', value: null, badge: null, meta: `<!-- ${node.text} -->`, children: [] }
    }
    if (node.type === 'pi') {
      return { id, path: null, label: `<?${node.name}?>`, value: node.text, badge: null, meta: null, children: [] }
    }
    if (node.type === 'cdata') {
      return { id, path: null, label: '', value: node.text, badge: 'CDATA', meta: null, children: [] }
    }
    return { id, path: null, label: '', value: node.text, badge: null, meta: null, children: [] }
  }

  return [build(root, '', 'xml', 0)]
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/** @param {object[]} documents the `documents` array from lib/s3/s3Yaml.js */
export function yamlToTree(documents) {
  const docs = documents || []

  function build(node, path, id, index) {
    if (node.type === 'comment') {
      return { id, path: null, label: '', value: null, badge: null, meta: `# ${node.comment}`, children: [] }
    }

    const isItem = node.type === 'item'
    const childPath = isItem ? `${path}[${index}]` : path ? dotted(path, node.key) : node.key
    const children = (node.children || []).filter(Boolean)

    let counter = -1
    return {
      id,
      path: childPath || null,
      label: isItem ? '-' : node.key,
      value: node.value,
      badge: node.blockScalar || (node.properties ? node.properties : null),
      meta: node.comment ? `# ${node.comment}` : null,
      summary: describeYamlChildren(children),
      children: children.map((child, childIndex) => {
        if (child.type === 'item') counter += 1
        return build(child, childPath, `${id}/${childIndex}`, counter)
      })
    }
  }

  function describeYamlChildren(children) {
    const items = children.filter(child => child.type === 'item').length
    if (items && items === children.length) {
      return items === 1 ? '1 item' : `${items} items`
    }
    const keys = children.filter(child => child.type === 'mapping').length
    return keys === 1 ? '1 key' : `${keys} keys`
  }

  const documentNodes = docs.map((doc, docIndex) => {
    let counter = -1
    const children = (doc.children || []).map((child, index) => {
      if (child.type === 'item') counter += 1
      return build(child, '', `yaml${docIndex}/${index}`, counter)
    })
    if (docs.length === 1) return children
    return [
      {
        id: `yamldoc${docIndex}`,
        path: null,
        label: `document ${docIndex + 1}`,
        value: null,
        badge: null,
        meta: null,
        summary: `${children.length} keys`,
        children
      }
    ]
  })

  return documentNodes.flat()
}

// ---------------------------------------------------------------------------
// Archive members
// ---------------------------------------------------------------------------

/**
 * A zip/tar listing is a flat array of paths, which is the least useful way to
 * read one: a 900-entry wheel or a model artifact is a directory structure, and
 * the question is almost always "what is under this folder", not "what is entry
 * 412". This rebuilds the hierarchy the paths imply, with each directory
 * aggregating the size and count beneath it.
 *
 * @param {object[]} entries `{ name, size, compressedSize, isDirectory }`
 */
export function archiveToTree(entries) {
  const root = { children: new Map(), size: 0, files: 0 }

  for (const entry of entries || []) {
    const parts = String(entry.name || '').split('/').filter(Boolean)
    if (!parts.length) continue
    const isDirectory = entry.isDirectory || String(entry.name).endsWith('/')
    let cursor = root
    parts.forEach((part, index) => {
      const last = index === parts.length - 1
      if (last && !isDirectory) {
        cursor.children.set(part, { leaf: entry, name: part })
        return
      }
      let next = cursor.children.get(part)
      if (!next || next.leaf) {
        next = { children: new Map(), size: 0, files: 0, name: part }
        cursor.children.set(part, next)
      }
      cursor = next
    })
  }

  // Roll sizes and counts up the tree, so a collapsed folder still tells you how
  // much is inside it.
  function total(node) {
    if (node.leaf) {
      return { size: node.leaf.size || 0, files: 1 }
    }
    let size = 0
    let files = 0
    for (const child of node.children.values()) {
      const sub = total(child)
      size += sub.size
      files += sub.files
    }
    node.size = size
    node.files = files
    return { size, files }
  }
  total(root)

  function build(node, path, id) {
    if (node.leaf) {
      return {
        id,
        path: node.leaf.name,
        label: `📄 ${node.name}`,
        value: null,
        badge: formatArchiveSize(node.leaf.size),
        meta:
          node.leaf.compressedSize == null
            ? null
            : `${formatArchiveSize(node.leaf.compressedSize)} compressed`,
        children: []
      }
    }
    const childPath = path ? `${path}/${node.name}` : node.name
    // Directories before files, then alphabetical — the order a file browser uses,
    // and the order that makes a deep archive scannable.
    const sorted = [...node.children.values()].sort((a, b) => {
      const aDir = a.leaf ? 1 : 0
      const bDir = b.leaf ? 1 : 0
      if (aDir !== bDir) return aDir - bDir
      return String(a.name).localeCompare(String(b.name))
    })
    return {
      id,
      path: childPath ? `${childPath}/` : null,
      label: `📁 ${node.name}`,
      value: null,
      badge: null,
      meta: `${node.files} file${node.files === 1 ? '' : 's'} · ${formatArchiveSize(node.size)}`,
      summary: `${node.children.size} entr${node.children.size === 1 ? 'y' : 'ies'}`,
      children: sorted.map((child, index) => build(child, childPath, `${id}/${index}`))
    }
  }

  const top = [...root.children.values()].sort((a, b) => {
    const aDir = a.leaf ? 1 : 0
    const bDir = b.leaf ? 1 : 0
    if (aDir !== bDir) return aDir - bDir
    return String(a.name).localeCompare(String(b.name))
  })
  return top.map((child, index) => build(child, '', `archive/${index}`))
}

function formatArchiveSize(bytes) {
  if (bytes == null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
