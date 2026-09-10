import { useMemo, useState } from 'react'
import { Alert, Badge, Button, Form, Nav, Table } from 'react-bootstrap'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import StructureTree from './StructureTree'
import { archiveToTree, jsonToTree, xmlToTree, yamlToTree } from './treeAdapters'

/**
 * objectViewers — the render half of "view this object".
 *
 * The server decodes an object into one of a small number of shapes (see
 * lib/s3/s3Preview.js) and this module renders each one. The split is
 * deliberate: bytes are decoded where the credentials are, and the browser only
 * ever receives structured JSON, so no untrusted bytes are executed here.
 *
 * Keep the `kind` switch in `ObjectPreview` in step with the `kind:` values
 * s3Preview.js can return — 'table', 'json', 'xml', 'yaml', 'text', 'markdown',
 * 'html', 'archive', 'sheets', 'document', 'notebook', 'hex', 'error'.
 *
 * Anything nested is navigated, not scrolled: JSON, XML, YAML and archive members
 * all render through the shared `StructureTree` (with a per-format adapter in
 * treeAdapters.js), and notebook cells collapse individually. Each of those
 * viewers keeps a raw/flat tab, because "show me the actual bytes" is still a
 * legitimate thing to want.
 *
 * Two rules are security rules, not styling choices:
 *   - HTML is rendered only inside a sandboxed <iframe srcDoc>, never with
 *     dangerouslySetInnerHTML and never as a same-origin document.
 *   - Media (<img>/<video>/<audio>/PDF) is loaded only from a URL the server
 *     built, and only for types the server considers inline-safe. SVG is not one
 *     of them: it is script-capable, so it arrives as inert text instead.
 */

// How many rows of a table to put in the DOM at once. The server already caps
// what it sends; this keeps a 5000-row preview from janking the browser.
const ROW_RENDER_CAP = 500

// Long cell values are clipped in the grid — the full value is one click away in
// the cell's title, and copyable from the row expander.
const CELL_CLIP = 200

export function formatBytes(bytes) {
  if (bytes == null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

export function formatWhen(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

/** The last path segment of a key — the "file name" a user would recognise. */
export function baseName(key) {
  const parts = String(key || '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(key || '')
}

// Icon per viewer kind. Emoji rather than an icon font: no extra asset, and the
// list stays legible when the page is copied into a ticket.
const VIEWER_ICONS = {
  image: '🖼️',
  pdf: '📕',
  video: '🎬',
  audio: '🎵',
  text: '📄',
  code: '🧾',
  json: '🧬',
  xml: '🌳',
  yaml: '🪢',
  ndjson: '🧬',
  markdown: '📝',
  csv: '📊',
  html: '🌐',
  parquet: '🧱',
  archive: '🗜️',
  office: '📗',
  notebook: '📓',
  binary: '⬛'
}

export function viewerIcon(viewer) {
  return VIEWER_ICONS[viewer] || '📄'
}

/** A short, human label for what the object is. */
export function TypeBadge({ type }) {
  if (!type) return null
  return (
    <span className="d-inline-flex align-items-center gap-1">
      <span aria-hidden="true">{viewerIcon(type.viewer)}</span>
      <Badge bg="light" text="dark" className="border font-monospace fw-normal">
        {type.contentType}
      </Badge>
      {type.basis === 'signature' && (
        <Badge bg="info" title="Identified from the file's magic bytes, not its name or stored type">
          sniffed
        </Badge>
      )}
      {type.scriptable && (
        <Badge bg="warning" text="dark" title="Can contain scripts — shown inert">
          scriptable
        </Badge>
      )}
    </span>
  )
}

/** A note or a warning the decoder attached to the preview. */
function PreviewNote({ note, truncated }) {
  if (!note && !truncated) return null
  return (
    <div className="small text-muted mb-2">
      {truncated && <Badge bg="secondary" className="me-2">partial</Badge>}
      {note}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tables (csv/tsv, parquet, ndjson, xlsx sheets, tabularised JSON)
// ---------------------------------------------------------------------------

/**
 * The grid. Everything tabular funnels through here so a parquet file, a CSV and
 * an NDJSON log all get the same filter box, the same row numbers and the same
 * "copy as JSON" — the format stops mattering once it is a table.
 */
export function PreviewTable({ columns, rows, rowCount, truncated, note, meta }) {
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    if (!filter.trim()) return rows
    const needle = filter.toLowerCase()
    return rows.filter(row =>
      row.some(cell => cell != null && String(cell).toLowerCase().includes(needle))
    )
  }, [rows, filter])

  const shown = filtered.slice(0, ROW_RENDER_CAP)

  const copyJson = () => {
    const objects = filtered.map(row => {
      const out = {}
      columns.forEach((column, index) => {
        out[column.name] = row[index]
      })
      return out
    })
    navigator.clipboard?.writeText(JSON.stringify(objects, null, 2))
  }

  return (
    <div>
      <PreviewNote note={note} truncated={truncated} />
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <Form.Control
          size="sm"
          style={{ maxWidth: 260 }}
          placeholder="Filter rows…"
          value={filter}
          onChange={event => setFilter(event.target.value)}
        />
        <span className="small text-muted">
          {filter.trim()
            ? `${filtered.length} of ${rows.length} rows match`
            : `${rows.length} rows shown${rowCount != null && rowCount > rows.length ? ` of ${rowCount}` : ''}`}
          {' · '}
          {columns.length} columns
        </span>
        {meta}
        <Button size="sm" variant="outline-secondary" className="ms-auto" onClick={copyJson}>
          Copy as JSON
        </Button>
      </div>
      <div className="border rounded" style={{ maxHeight: '58vh', overflow: 'auto' }}>
        <Table size="sm" hover className="mb-0 align-middle">
          <thead className="table-light" style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr>
              <th className="text-end text-muted small" style={{ width: 56 }}>
                #
              </th>
              {columns.map((column, index) => (
                <th key={index} className="text-nowrap">
                  {column.name}
                  {column.type && (
                    <span className="text-muted fw-normal small ms-1">{column.type}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td className="text-end text-muted small font-monospace">{rowIndex + 1}</td>
                {columns.map((column, index) => (
                  <Cell key={index} value={row[index]} />
                ))}
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={columns.length + 1} className="text-muted text-center py-3">
                  No rows to show.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>
      {filtered.length > shown.length && (
        <div className="small text-muted mt-1">
          Showing the first {ROW_RENDER_CAP} of {filtered.length} matching rows.
        </div>
      )}
    </div>
  )
}

function Cell({ value }) {
  if (value == null) {
    return <td className="text-muted fst-italic small">null</td>
  }
  if (typeof value === 'boolean') {
    return <td className="font-monospace">{String(value)}</td>
  }
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return (
      <td className="font-monospace small text-nowrap" title={text}>
        {text.length > CELL_CLIP ? `${text.slice(0, CELL_CLIP)}…` : text}
      </td>
    )
  }
  const text = String(value)
  const numeric = typeof value === 'number'
  return (
    <td
      className={`text-nowrap${numeric ? ' font-monospace text-end' : ''}`}
      title={text.length > CELL_CLIP ? text : undefined}
    >
      {text.length > CELL_CLIP ? `${text.slice(0, CELL_CLIP)}…` : text}
    </td>
  )
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Plain text, logs and source. Line numbers and a "only lines containing…"
 * filter, because the single most common reason to open a text object in S3 is
 * to find something in a log.
 */
function TextViewer({ preview }) {
  const [wrap, setWrap] = useState(false)
  const [filter, setFilter] = useState('')

  const lines = useMemo(() => String(preview.text || '').split('\n'), [preview.text])
  const matching = useMemo(() => {
    if (!filter.trim()) return null
    const needle = filter.toLowerCase()
    return lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(entry => entry.line.toLowerCase().includes(needle))
  }, [lines, filter])

  const rendered = matching || lines.map((line, index) => ({ line, number: index + 1 }))

  return (
    <div>
      <PreviewNote note={preview.note} truncated={preview.truncated} />
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <Form.Control
          size="sm"
          style={{ maxWidth: 280 }}
          placeholder="Only lines containing…"
          value={filter}
          onChange={event => setFilter(event.target.value)}
        />
        <Form.Check
          type="switch"
          id="s3-text-wrap"
          label="Wrap"
          checked={wrap}
          onChange={event => setWrap(event.target.checked)}
        />
        <span className="small text-muted">
          {matching
            ? `${matching.length} of ${lines.length} lines match`
            : `${lines.length} lines`}
          {preview.encoding && preview.encoding !== 'utf8' && (
            <> · decoded as {preview.encoding}</>
          )}
          {preview.monacoLanguage && preview.monacoLanguage !== 'plaintext' && (
            <> · {preview.monacoLanguage}</>
          )}
        </span>
        <Button
          size="sm"
          variant="outline-secondary"
          className="ms-auto"
          onClick={() => navigator.clipboard?.writeText(preview.text || '')}
        >
          Copy
        </Button>
      </div>
      <div
        className="border rounded bg-body-tertiary"
        style={{ maxHeight: '58vh', overflow: 'auto' }}
      >
        <table className="mb-0 font-monospace small" style={{ width: '100%' }}>
          <tbody>
            {rendered.map(entry => (
              <tr key={entry.number}>
                <td
                  className="text-end text-muted pe-2 user-select-none"
                  style={{ width: 64, verticalAlign: 'top', borderRight: '1px solid var(--bs-border-color)' }}
                >
                  {entry.number}
                </td>
                <td
                  className="ps-2"
                  style={{
                    whiteSpace: wrap ? 'pre-wrap' : 'pre',
                    wordBreak: wrap ? 'break-word' : 'normal'
                  }}
                >
                  {entry.line || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Pretty-printed JSON, with a table view when the document is an array of flat
 * objects — which, for anything exported from a data pipeline, it usually is.
 */
/** The tab strip shared by every viewer that offers more than one way to read. */
function ViewTabs({ views, active, onSelect }) {
  if (views.length < 2) return null
  return (
    <Nav variant="pills" className="mb-2 gap-1" activeKey={active} onSelect={key => onSelect(key)}>
      {views.map(view => (
        <Nav.Item key={view.key}>
          <Nav.Link eventKey={view.key} className="py-1 px-2 small">
            {view.label}
          </Nav.Link>
        </Nav.Item>
      ))}
    </Nav>
  )
}

/**
 * JSON: a collapsible tree, plus the table and raw text that were already here.
 *
 * The tree is built in the browser from `preview.text`, which is safe precisely
 * because it is not the object's bytes — the server parsed the object and
 * re-serialised it (see previewJson), so this parse cannot fail on anything the
 * server accepted, and nothing untrusted is being evaluated. The alternative,
 * shipping a second nested representation alongside the text, would double the
 * response for no gain.
 */
function JsonViewer({ preview }) {
  const tree = useMemo(() => {
    try {
      return jsonToTree(JSON.parse(preview.text))
    } catch {
      return null
    }
  }, [preview.text])

  const views = [
    ...(preview.tabular ? [{ key: 'table', label: 'Table' }] : []),
    ...(tree ? [{ key: 'tree', label: 'Tree' }] : []),
    { key: 'text', label: 'Raw JSON' }
  ]
  const [view, setView] = useState(preview.tabular ? 'table' : tree ? 'tree' : 'text')

  return (
    <div>
      <PreviewNote note={preview.note} truncated={preview.truncated} />
      <ViewTabs views={views} active={view} onSelect={setView} />
      {view === 'table' && preview.tabular ? (
        <PreviewTable
          columns={preview.tabular.columns}
          rows={preview.tabular.rows}
          rowCount={preview.tabular.rowCount}
          truncated={preview.tabular.truncated}
        />
      ) : view === 'tree' && tree ? (
        <StructureTree nodes={tree} defaultDepth={2} />
      ) : (
        <TextViewer preview={{ ...preview, note: null }} />
      )}
    </div>
  )
}

/**
 * XML: the element tree the server parsed (lib/s3/s3Xml.js), or the raw document.
 *
 * Note what is NOT here — no rendering of the XML as a document. An object out of
 * a bucket is untrusted input and XML can carry a stylesheet; the tree shows the
 * markup's structure, which is what a viewer of a POM, a WSDL or a plist wants.
 */
function XmlViewer({ preview }) {
  const tree = useMemo(() => xmlToTree(preview.root), [preview.root])
  const [view, setView] = useState('tree')

  return (
    <div>
      <PreviewNote note={preview.note} truncated={preview.truncated} />
      <ViewTabs
        views={[
          { key: 'tree', label: 'Tree' },
          { key: 'text', label: 'Raw XML' }
        ]}
        active={view}
        onSelect={setView}
      />
      {view === 'tree' ? (
        <>
          {preview.declaration && (
            <div className="small text-muted font-monospace mb-1">{`<?xml ${preview.declaration}?>`}</div>
          )}
          <StructureTree
            nodes={tree}
            defaultDepth={3}
            filterPlaceholder="Filter — matches elements, attributes and text"
            toolbarExtras={
              <span className="text-muted small">
                {preview.elementCount?.toLocaleString()} elements
              </span>
            }
          />
        </>
      ) : (
        <TextViewer preview={{ ...preview, note: null, monacoLanguage: 'xml' }} />
      )}
    </div>
  )
}

/**
 * YAML: the key tree the server parsed (lib/s3/s3Yaml.js), or the raw document.
 *
 * The tree opens three levels deep by default rather than two, because the
 * documents this exists for (CloudFormation, Kubernetes, Helm values) put nothing
 * interesting above the third level.
 */
function YamlViewer({ preview }) {
  const tree = useMemo(() => yamlToTree(preview.documents), [preview.documents])
  const [view, setView] = useState('tree')
  const documentCount = (preview.documents || []).length

  return (
    <div>
      <PreviewNote note={preview.note} truncated={preview.truncated} />
      <ViewTabs
        views={[
          { key: 'tree', label: 'Tree' },
          { key: 'text', label: 'Raw YAML' }
        ]}
        active={view}
        onSelect={setView}
      />
      {view === 'tree' ? (
        <StructureTree
          nodes={tree}
          defaultDepth={3}
          filterPlaceholder="Filter — matches keys, values and comments"
          toolbarExtras={
            documentCount > 1 ? (
              <span className="text-muted small">{documentCount} documents</span>
            ) : null
          }
        />
      ) : (
        <TextViewer preview={{ ...preview, note: null, monacoLanguage: 'yaml' }} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Markdown / HTML
// ---------------------------------------------------------------------------

function MarkdownViewer({ preview }) {
  const [raw, setRaw] = useState(false)
  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-2">
        <Form.Check
          type="switch"
          id="s3-md-raw"
          label="Show source"
          checked={raw}
          onChange={event => setRaw(event.target.checked)}
        />
      </div>
      {raw ? (
        <TextViewer preview={preview} />
      ) : (
        <div
          className="border rounded p-3 bg-body"
          style={{ maxHeight: '58vh', overflow: 'auto' }}
        >
          {/* react-markdown does not render raw HTML unless rehype-raw is added,
              so embedded <script> in a README stays inert text. */}
          <Markdown remarkPlugins={[remarkGfm]}>{preview.text || ''}</Markdown>
        </div>
      )}
    </div>
  )
}

/**
 * HTML from a bucket is attacker-controlled markup, so it is rendered in a
 * sandboxed iframe with no allow-* tokens: no scripts, no forms, no same-origin
 * access, and (via the srcDoc + CSP) nothing loaded from the network.
 */
function HtmlViewer({ preview }) {
  const [rendered, setRendered] = useState(true)
  const guarded = useMemo(
    () =>
      `<!doctype html><meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
      String(preview.text || ''),
    [preview.text]
  )

  return (
    <div>
      <Alert variant="warning" className="py-2 small">
        {preview.note || 'HTML is rendered in an isolated frame with scripts disabled.'}
      </Alert>
      <div className="d-flex align-items-center gap-2 mb-2">
        <Form.Check
          type="switch"
          id="s3-html-rendered"
          label="Render in isolated frame"
          checked={rendered}
          onChange={event => setRendered(event.target.checked)}
        />
      </div>
      {rendered ? (
        <iframe
          title="Object preview"
          srcDoc={guarded}
          sandbox=""
          referrerPolicy="no-referrer"
          className="border rounded w-100 bg-white"
          style={{ height: '58vh' }}
        />
      ) : (
        <TextViewer preview={{ ...preview, note: null }} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Archives, spreadsheets, documents, notebooks, hex
// ---------------------------------------------------------------------------

/**
 * An archive listing, as the directory structure its paths imply.
 *
 * The flat list is kept as a second tab — it is the right view for "is this one
 * file in here", and it is what you want to scan when an archive is shallow. But a
 * 900-entry wheel or a tar of model checkpoints is a tree, and reading it as 900
 * slash-separated strings is the thing this feature exists to stop.
 */
function ArchiveViewer({ preview }) {
  const tree = useMemo(() => archiveToTree(preview.entries), [preview.entries])
  const [view, setView] = useState(tree.length ? 'tree' : 'flat')

  return (
    <div>
      <PreviewNote note={preview.note} truncated={preview.truncated} />
      <ViewTabs
        views={[
          { key: 'tree', label: 'Tree' },
          { key: 'flat', label: 'Flat list' }
        ]}
        active={view}
        onSelect={setView}
      />
      {view === 'tree' ? (
        <>
          <StructureTree
            nodes={tree}
            defaultDepth={1}
            filterPlaceholder="Filter — matches member names"
            emptyMessage="This archive has no readable members."
          />
          <div className="small text-muted mt-1">{preview.entryCount} entries.</div>
        </>
      ) : (
        <ArchiveFlatList preview={preview} />
      )}
    </div>
  )
}

function ArchiveFlatList({ preview }) {
  return (
    <div>
      <div className="border rounded" style={{ maxHeight: '58vh', overflow: 'auto' }}>
        <Table size="sm" hover className="mb-0 align-middle">
          <thead className="table-light" style={{ position: 'sticky', top: 0 }}>
            <tr>
              <th>Name</th>
              <th className="text-end">Size</th>
              <th className="text-end">Compressed</th>
            </tr>
          </thead>
          <tbody>
            {(preview.entries || []).map((entry, index) => (
              <tr key={index}>
                <td className="font-monospace small">
                  {entry.isDirectory ? '📁 ' : '📄 '}
                  {entry.name}
                </td>
                <td className="text-end small">
                  {entry.isDirectory ? '—' : formatBytes(entry.size)}
                </td>
                <td className="text-end small text-muted">
                  {entry.compressedSize == null ? '—' : formatBytes(entry.compressedSize)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <div className="small text-muted mt-1">{preview.entryCount} entries.</div>
    </div>
  )
}

/** xlsx: one tab per worksheet, each rendered through the shared grid. */
function SheetsViewer({ preview }) {
  const sheets = preview.sheets || []
  const [active, setActive] = useState(0)
  const sheet = sheets[active] || sheets[0]
  if (!sheet) return <Alert variant="secondary">This workbook has no readable sheets.</Alert>

  return (
    <div>
      <PreviewNote note={preview.note} />
      {sheets.length > 1 && (
        <Nav
          variant="tabs"
          className="mb-2"
          activeKey={String(active)}
          onSelect={key => setActive(Number(key))}
        >
          {sheets.map((entry, index) => (
            <Nav.Item key={index}>
              <Nav.Link eventKey={String(index)} className="py-1 px-2 small">
                {entry.name}
              </Nav.Link>
            </Nav.Item>
          ))}
        </Nav>
      )}
      <PreviewTable
        key={active}
        columns={sheet.columns}
        rows={sheet.rows}
        rowCount={sheet.rowCount}
        truncated={sheet.truncated}
      />
    </div>
  )
}

/** docx / pptx: the text, in reading order. */
function DocumentViewer({ preview }) {
  return (
    <div>
      <PreviewNote note={preview.note} />
      <div className="border rounded p-3 bg-body" style={{ maxHeight: '58vh', overflow: 'auto' }}>
        {(preview.sections || []).map((section, index) => (
          <section key={index} className={index ? 'mt-4' : ''}>
            {section.title && <h6 className="text-muted">{section.title}</h6>}
            {section.paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex} className="mb-2">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>
      <div className="small text-muted mt-1">
        {preview.characterCount?.toLocaleString()} characters of text.
      </div>
    </div>
  )
}

/** .ipynb: cells in order, with their captured text output. */
/** The first line of a cell, for the header of a collapsed one. */
function cellHeadline(cell) {
  const first = String(cell.source || '')
    .split('\n')
    .find(line => line.trim())
  if (!first) return '(empty cell)'
  return first.length > 90 ? `${first.slice(0, 90)}…` : first
}

/**
 * A notebook, with every cell collapsible.
 *
 * Notebooks are the format where "scroll to find it" hurts most: the cell you want
 * is usually below a few hundred lines of output from the cells you don't. Cells
 * start expanded (a notebook read top to bottom is the normal case) and Collapse
 * all turns the whole thing into a table of contents.
 */
function NotebookViewer({ preview }) {
  const cells = preview.cells || []
  const [collapsed, setCollapsed] = useState(() => new Set())

  const toggle = index =>
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  return (
    <div>
      <PreviewNote
        note={preview.truncated ? `Showing ${preview.cells.length} of ${preview.cellCount} cells.` : null}
        truncated={preview.truncated}
      />
      <div className="d-flex align-items-center gap-2 mb-2">
        <Button
          size="sm"
          variant="outline-secondary"
          onClick={() => setCollapsed(new Set())}
          disabled={collapsed.size === 0}
        >
          Expand all
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          onClick={() => setCollapsed(new Set(cells.map(cell => cell.index)))}
          disabled={collapsed.size === cells.length}
        >
          Collapse all
        </Button>
        <span className="small text-muted ms-auto">
          {cells.length} cell{cells.length === 1 ? '' : 's'}
          {collapsed.size ? ` · ${collapsed.size} collapsed` : ''}
        </span>
      </div>
      <div className="border rounded p-2 bg-body" style={{ maxHeight: '58vh', overflow: 'auto' }}>
        {cells.map(cell => {
          const isCollapsed = collapsed.has(cell.index)
          return (
          <div key={cell.index} className="mb-3">
            <div
              className="small text-muted mb-1 d-flex align-items-center gap-1"
              role="button"
              onClick={() => toggle(cell.index)}
              style={{ cursor: 'pointer' }}
              title={isCollapsed ? 'Expand this cell' : 'Collapse this cell'}
            >
              <span style={{ width: 12, fontSize: '0.7rem' }} aria-hidden="true">
                {isCollapsed ? '▸' : '▾'}
              </span>
              {cell.cellType === 'code' ? (
                <>
                  In [{cell.executionCount == null ? ' ' : cell.executionCount}] ·{' '}
                  {preview.language}
                </>
              ) : (
                cell.cellType
              )}
              {isCollapsed && (
                <span className="font-monospace text-truncate ms-2">{cellHeadline(cell)}</span>
              )}
            </div>
            {isCollapsed ? null : cell.cellType === 'markdown' ? (
              <div className="border-start ps-3">
                <Markdown remarkPlugins={[remarkGfm]}>{cell.source}</Markdown>
              </div>
            ) : (
              <pre className="border rounded bg-body-tertiary p-2 mb-1 small">{cell.source}</pre>
            )}
            {!isCollapsed &&
              (cell.outputs || []).map((output, index) => (
                <pre
                  key={index}
                  className={`border-start ps-2 mb-1 small ${
                    output.type === 'error' ? 'text-danger' : 'text-muted'
                  }`}
                >
                  {output.text}
                </pre>
              ))}
          </div>
          )
        })}
      </div>
    </div>
  )
}

/** The honest fallback: bytes, as bytes. */
function HexViewer({ preview }) {
  return (
    <div>
      <PreviewNote note={preview.note} truncated={preview.truncated} />
      <div
        className="border rounded bg-body-tertiary p-2 font-monospace small"
        style={{ maxHeight: '58vh', overflow: 'auto', whiteSpace: 'pre' }}
      >
        {(preview.lines || [])
          .map(line => `${line.offset}  ${line.hex.padEnd(48, ' ')}  ${line.ascii}`)
          .join('\n')}
      </div>
      <div className="small text-muted mt-1">
        {preview.bytesShown?.toLocaleString()} bytes shown
        {preview.truncated ? ' (truncated)' : ''}.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Images, video and audio, streamed through the object proxy — plus PDF, which
 * arrives as a presigned S3-origin URL because it has to be framed (see below).
 *
 * The proxy is what makes this work without any bucket configuration: a direct
 * fetch from the browser would need CORS on the bucket, and it only serves
 * `inline` for types on the server's allowlist, so nothing script-capable can
 * reach this element.
 */
export function MediaViewer({ type, url, object }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <Alert variant="secondary">
        The browser could not render this {type.contentType}. Open it in a new tab or download it.
      </Alert>
    )
  }

  const frame = { maxWidth: '100%', maxHeight: '58vh' }

  if (type.viewer === 'image') {
    return (
      <div className="text-center bg-body-tertiary border rounded p-2">
        <img src={url} alt={baseName(object?.key)} style={frame} onError={() => setFailed(true)} />
      </div>
    )
  }
  if (type.viewer === 'video') {
    return (
      <video controls src={url} className="w-100 border rounded bg-black" style={{ maxHeight: '58vh' }} onError={() => setFailed(true)} />
    )
  }
  if (type.viewer === 'audio') {
    return <audio controls src={url} className="w-100" onError={() => setFailed(true)} />
  }
  // PDF. An <object> falls back to its children when the document cannot be
  // rendered, which an <iframe> does not — so the fallback below is the honest
  // signal that something went wrong rather than a blank rectangle.
  //
  // `url` for a PDF is a presigned URL on the S3 origin, not the object proxy:
  // the proxy sends `frame-ancestors 'none'`, which blocks framing by design.
  // See the comment on the pdfUrl effect in S3ObjectViewer.jsx.
  return (
    <object data={url} type="application/pdf" className="w-100 border rounded" style={{ height: '58vh' }}>
      <Alert variant="secondary" className="mb-0">
        This PDF could not be displayed here. Use “Open in new tab” or download it.
      </Alert>
    </object>
  )
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Render whatever the server decoded. `preview` is the payload from
 * s3PreviewObject; `mediaUrl` is only needed for the media kinds, which have no
 * server-side decode step.
 */
export function ObjectPreview({ preview, type, object, mediaUrl }) {
  if (!preview && type && mediaUrl && ['image', 'pdf', 'video', 'audio'].includes(type.viewer)) {
    return <MediaViewer type={type} url={mediaUrl} object={object} />
  }
  if (!preview) return null

  switch (preview.kind) {
    case 'table':
      return (
        <PreviewTable
          columns={preview.columns}
          rows={preview.rows}
          rowCount={preview.rowCount}
          truncated={preview.truncated}
          note={preview.note}
          meta={
            preview.bytesRead != null && (
              <Badge
                bg="success-subtle"
                text="success-emphasis"
                className="border"
                title="How much of the object had to be transferred to build this preview"
              >
                read {formatBytes(preview.bytesRead)}
                {preview.metadata?.rowGroups != null &&
                  ` · ${preview.metadata.rowGroups} row group${preview.metadata.rowGroups === 1 ? '' : 's'}`}
              </Badge>
            )
          }
        />
      )
    case 'json':
      return <JsonViewer preview={preview} />
    case 'xml':
      return <XmlViewer preview={preview} />
    case 'yaml':
      return <YamlViewer preview={preview} />
    case 'markdown':
      return <MarkdownViewer preview={preview} />
    case 'html':
      return <HtmlViewer preview={preview} />
    case 'archive':
      return <ArchiveViewer preview={preview} />
    case 'sheets':
      return <SheetsViewer preview={preview} />
    case 'document':
      return <DocumentViewer preview={preview} />
    case 'notebook':
      return <NotebookViewer preview={preview} />
    case 'hex':
      return <HexViewer preview={preview} />
    case 'error':
      return (
        <Alert variant="warning" className="mb-0">
          {preview.message}
        </Alert>
      )
    case 'text':
    default:
      return <TextViewer preview={preview} />
  }
}

export default ObjectPreview
