import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Form } from 'react-bootstrap'

/**
 * StructureTree — one collapsible tree, four formats.
 *
 * JSON, XML, YAML and archive listings are all the same shape once decoded: a
 * nested thing you read by finding one branch. Every other S3 browser shows them
 * as flat text and leaves you scrolling a 4000-line CloudFormation template
 * looking for one resource. This is the navigation for all of them, so the
 * expand/collapse behaviour, the filter, and the copy-path affordance are written
 * once and behave identically wherever they appear.
 *
 * The format-specific part is an *adapter* (see treeAdapters.js) that turns a
 * preview into `Node`s. This component knows nothing about JSON or XML.
 *
 * Node shape:
 *   {
 *     id,        stable unique string (the path works)
 *     path,      what the copy button puts on the clipboard
 *     label,     the key / element / entry name
 *     value,     inline leaf text, or null when the value is the children
 *     badge,     a short type/count hint shown after the label
 *     meta,      dimmer trailing text (an XML attribute list, a YAML comment)
 *     summary,   what to show in place of collapsed children ('3 keys')
 *     children,  Node[]
 *   }
 *
 * Rendering is of *expanded* nodes only, which is what keeps a 20 000-node
 * document responsive: collapsed subtrees cost nothing until they are opened.
 * There is no virtual scroller and no CSS file — a tree of rows in a scroll box
 * is enough, and the alternative (Monaco's folding) is a 4.5 MB dependency this
 * page deliberately does not have.
 */

// Expand All on a huge document would put every node in the DOM at once. Past
// this many, expanding all is offered but bounded — the first N nodes open and a
// note says so, which is more useful than a frozen tab.
const EXPAND_ALL_CAP = 4000

// Long leaf values are clipped in the row; the full text is in the title and on
// the clipboard via the copy button.
const VALUE_CLIP = 400

function nodeHasChildren(node) {
  return Array.isArray(node.children) && node.children.length > 0
}

/** Every id down to `depth`, for the initial "open the top few levels" state. */
function idsToDepth(nodes, depth, into = new Set()) {
  if (depth <= 0) return into
  for (const node of nodes) {
    if (nodeHasChildren(node)) {
      into.add(node.id)
      idsToDepth(node.children, depth - 1, into)
    }
  }
  return into
}

function collectIds(nodes, into = new Set(), cap = Infinity) {
  for (const node of nodes) {
    if (into.size >= cap) return into
    if (nodeHasChildren(node)) {
      into.add(node.id)
      collectIds(node.children, into, cap)
    }
  }
  return into
}

function countNodes(nodes) {
  let total = 0
  for (const node of nodes) {
    total += 1
    if (nodeHasChildren(node)) total += countNodes(node.children)
  }
  return total
}

/**
 * Which nodes survive a filter, and which must be open to reveal them.
 *
 * A filter that only kept matching rows would hide the context that makes a match
 * meaningful — `name: web` matters because of the four keys above it. So an
 * ancestor of a match is kept and force-expanded. A match's own subtree is kept
 * too (the render walk treats everything below a match as visible), because
 * finding a branch and then not being able to open it is worse than not filtering.
 */
function applyFilter(nodes, needle) {
  const visible = new Set()
  const expand = new Set()
  const matched = new Set()

  function walk(node) {
    const haystack = `${node.label ?? ''} ${node.value ?? ''} ${node.meta ?? ''}`.toLowerCase()
    const selfMatch = haystack.includes(needle)
    let childMatch = false
    if (nodeHasChildren(node)) {
      for (const child of node.children) {
        if (walk(child)) childMatch = true
      }
    }
    if (selfMatch) matched.add(node.id)
    if (selfMatch || childMatch) {
      visible.add(node.id)
      if (childMatch) expand.add(node.id)
      return true
    }
    return false
  }

  nodes.forEach(walk)
  return { visible, expand, matched }
}

function TreeRow({ node, depth, expanded, onToggle, matched, onCopy, copied }) {
  const hasChildren = nodeHasChildren(node)
  const isOpen = hasChildren && expanded.has(node.id)
  const value = node.value == null ? null : String(node.value)
  const clipped = value != null && value.length > VALUE_CLIP
  const multiline = value != null && value.indexOf('\n') !== -1

  return (
    <div
      className={`d-flex align-items-start gap-1 py-0 ${matched ? 'bg-warning-subtle rounded' : ''}`}
      style={{ paddingLeft: depth * 14 }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="btn btn-link p-0 border-0 text-decoration-none text-secondary lh-1"
          style={{ width: 14, fontSize: '0.7rem' }}
          onClick={() => onToggle(node.id)}
          aria-expanded={isOpen}
          title={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? '▾' : '▸'}
        </button>
      ) : (
        <span style={{ width: 14 }} aria-hidden="true" />
      )}

      <div className="flex-grow-1 font-monospace" style={{ fontSize: '0.8rem', minWidth: 0 }}>
        <span
          className={hasChildren ? 'fw-semibold' : ''}
          role={hasChildren ? 'button' : undefined}
          onClick={hasChildren ? () => onToggle(node.id) : undefined}
          style={hasChildren ? { cursor: 'pointer' } : undefined}
        >
          {node.label}
        </span>
        {node.badge && <span className="text-primary-emphasis ms-1 small">{node.badge}</span>}
        {node.meta && (
          <span className="text-muted ms-1 small" title={node.meta}>
            {node.meta}
          </span>
        )}
        {value != null && (
          <>
            {node.label ? <span className="text-muted">: </span> : null}
            {multiline ? (
              <pre
                className="d-block mb-0 mt-1 p-2 bg-body-tertiary border rounded"
                style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', maxHeight: '18em', overflow: 'auto' }}
              >
                {clipped ? `${value.slice(0, VALUE_CLIP)}…` : value}
              </pre>
            ) : (
              <span className="text-success-emphasis" title={clipped ? value : undefined}>
                {clipped ? `${value.slice(0, VALUE_CLIP)}…` : value}
              </span>
            )}
          </>
        )}
        {hasChildren && !isOpen && node.summary && (
          <span
            className="text-muted ms-2 small"
            role="button"
            onClick={() => onToggle(node.id)}
            style={{ cursor: 'pointer' }}
          >
            {node.summary}
          </span>
        )}
      </div>

      {node.path && (
        <button
          type="button"
          className="btn btn-link p-0 border-0 text-decoration-none small text-muted"
          onClick={() => onCopy(node)}
          title={`Copy path: ${node.path}`}
          style={{ opacity: copied ? 1 : 0.35, fontSize: '0.7rem', whiteSpace: 'nowrap' }}
        >
          {copied ? 'copied' : 'path'}
        </button>
      )}
    </div>
  )
}

export default function StructureTree({
  nodes,
  defaultDepth = 2,
  filterPlaceholder = 'Filter — matches keys and values',
  emptyMessage = 'Nothing to show.',
  toolbarExtras = null
}) {
  const roots = useMemo(() => nodes || [], [nodes])
  const total = useMemo(() => countNodes(roots), [roots])

  const [expanded, setExpanded] = useState(() => idsToDepth(roots, defaultDepth))
  const [filter, setFilter] = useState('')
  const [copiedId, setCopiedId] = useState(null)
  const [expandNote, setExpandNote] = useState(null)

  // A different document means a different tree; carrying the old expansion set
  // over would leave a new object opened at arbitrary places (ids are paths, so
  // some of them collide). Keyed on a *signature* rather than on the array's
  // identity: a caller that rebuilds its nodes array each render would otherwise
  // reset the expansion on every render, i.e. nothing could be expanded at all.
  const signature = `${roots.length}:${total}:${roots.map(node => node.id).join(',')}`
  useEffect(() => {
    setExpanded(idsToDepth(roots, defaultDepth))
    setExpandNote(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, defaultDepth])

  const needle = filter.trim().toLowerCase()
  const filtered = useMemo(
    () => (needle ? applyFilter(roots, needle) : null),
    [roots, needle]
  )

  const toggle = useCallback(id => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const copyPath = useCallback(node => {
    const write = navigator.clipboard?.writeText?.(node.path)
    setCopiedId(node.id)
    setTimeout(() => setCopiedId(null), 1200)
    if (write?.catch) write.catch(() => {})
  }, [])

  const expandAll = useCallback(() => {
    const ids = collectIds(roots, new Set(), EXPAND_ALL_CAP)
    setExpanded(ids)
    setExpandNote(
      ids.size >= EXPAND_ALL_CAP
        ? `Expanded the first ${EXPAND_ALL_CAP.toLocaleString()} branches — this document is too large to open all at once.`
        : null
    )
  }, [roots])

  const collapseAll = useCallback(() => {
    setExpanded(new Set())
    setExpandNote(null)
  }, [])

  // Only expanded nodes are rendered; a filter force-opens the path to each match.
  const rows = useMemo(() => {
    const out = []
    const walk = (list, depth, insideMatch) => {
      for (const node of list) {
        if (filtered && !insideMatch && !filtered.visible.has(node.id)) continue
        const isMatch = !!filtered?.matched.has(node.id)
        out.push({ node, depth, matched: isMatch })
        const open = expanded.has(node.id) || (filtered && filtered.expand.has(node.id))
        if (nodeHasChildren(node) && open) {
          walk(node.children, depth + 1, insideMatch || isMatch)
        }
      }
    }
    walk(roots, 0, false)
    return out
  }, [roots, expanded, filtered])

  if (!roots.length) {
    return <div className="text-muted small">{emptyMessage}</div>
  }

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <Form.Control
          size="sm"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder={filterPlaceholder}
          style={{ maxWidth: 320 }}
        />
        <Button size="sm" variant="outline-secondary" onClick={expandAll}>
          Expand all
        </Button>
        <Button size="sm" variant="outline-secondary" onClick={collapseAll}>
          Collapse all
        </Button>
        {toolbarExtras}
        <span className="text-muted small ms-auto">
          {needle
            ? `${filtered.matched.size.toLocaleString()} of ${total.toLocaleString()} match`
            : `${total.toLocaleString()} nodes`}
        </span>
      </div>

      {expandNote && <div className="text-muted small mb-2">{expandNote}</div>}
      {needle && filtered.matched.size === 0 && (
        <div className="text-muted small mb-2">Nothing matches “{filter}”.</div>
      )}

      <div
        className="border rounded p-2 bg-body"
        style={{ maxHeight: '58vh', overflow: 'auto' }}
      >
        {rows.map(row => (
          <TreeRow
            key={row.node.id}
            node={row.node}
            depth={row.depth}
            expanded={expanded}
            onToggle={toggle}
            matched={row.matched}
            onCopy={copyPath}
            copied={copiedId === row.node.id}
          />
        ))}
      </div>
    </div>
  )
}
