import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Dropdown,
  Form,
  InputGroup,
  ProgressBar,
  Spinner,
  Table
} from 'react-bootstrap'

import { useConfirm, usePrompt } from '../ConfirmDialog.jsx'
import {
  s3CancelSearch,
  s3CopyObjects,
  s3CreateFolder,
  s3DeleteObjects,
  s3ExplainSearch,
  s3ListObjects,
  s3PresignView,
  s3SearchObjects
} from '../presignApi'
import { getSocket, getUserName } from '../presignSocket'
import ApiErrorAlert from '../ApiErrorAlert.jsx'
import S3ObjectViewerModal from './S3ObjectViewer.jsx'
import S3UploadDialog, { filesFromDataTransfer } from './S3UploadDialog.jsx'
import { baseName, formatBytes, formatWhen, viewerIcon } from './objectViewers.jsx'
import Pager from './Pager.jsx'

/**
 * S3ObjectBrowser — drill down through a bucket, and find things in it.
 *
 * Browsing mirrors the console: ListObjectsV2 with `delimiter: '/'` turns S3's
 * flat keyspace into folders, one page at a time, with the continuation tokens
 * kept in a stack so Previous works (S3 only pages forwards).
 *
 * Search does not mirror the console, deliberately. The console filters one
 * level, by prefix, case-sensitively — so `report` will not find `Q3-report.csv`
 * or anything in a subfolder. Here, typing a word searches for it anywhere in the
 * key, case-insensitively, through the whole subtree, and the walk streams its
 * progress over Socket.IO so a search across a million keys is watchable and
 * stoppable. The extra syntax (globs, `-exclude`, `ext:`, `size>`, `modified>`)
 * is opt-in; see lib/s3/s3Search.js.
 *
 * A search also answers with folders, not only objects. "Where is the invoices
 * folder?" and "which files are called invoice?" are typed identically, so the
 * scope selector says which was meant, and any folder that matched is listed
 * above the objects with the object count and rolled-up size the walk observed.
 *
 * Uploading accepts a drop anywhere on this panel — files or whole folders — and
 * hands them to S3UploadDialog. Every failure, meanwhile, is reported through
 * ApiErrorAlert with a Retry that re-runs the operation that failed, because the
 * commonest failure here is an expired SSO session and recovering from one should
 * not cost the folder, the search and the selection a reload would discard.
 */

const PAGE_SIZES = [50, 100, 300, 1000]

/**
 * What the query is matched against. The whole key is the default because it is
 * the widest, but it answers two questions at once: against
 * `invoices/2026/summary.csv`, the word "invoices" is both a folder someone is
 * navigating to and a substring of the key. Narrowing says which one was meant.
 */
const SEARCH_SCOPES = [
  { value: 'both', label: 'Names + folders' },
  { value: 'name', label: 'Object names only' },
  { value: 'folder', label: 'Folder names only' }
]

// How each scope reads in the hint under the box, before a query is typed. Once
// there is one, the server's own explanation replaces this.
const SCOPE_HINTS = {
  both: 'key',
  name: "object's own name",
  folder: 'folder path'
}

// Examples shown under the search box. Discoverability by reading one line,
// rather than by finding documentation.
const SEARCH_EXAMPLES = [
  { query: 'report q3', hint: 'both words, anywhere in the key' },
  { query: '"final report"', hint: 'exact phrase' },
  { query: '*.parquet', hint: 'glob on the name' },
  { query: '-backup', hint: 'exclude' },
  { query: 'ext:csv,tsv', hint: 'by extension' },
  { query: 'size>10mb', hint: 'by size' },
  { query: 'modified>7d', hint: 'changed in the last week' }
]

/** Split a prefix into clickable breadcrumb segments. */
function crumbsFor(prefix) {
  const parts = String(prefix || '').split('/').filter(Boolean)
  let running = ''
  return parts.map(part => {
    running += `${part}/`
    return { label: part, prefix: running }
  })
}

export default function S3ObjectBrowser({
  profileName,
  authnMode,
  bucket,
  prefix,
  onNavigate,
  onLeaveBucket
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [folders, setFolders] = useState([])
  const [objects, setObjects] = useState([])
  const [pageSize, setPageSize] = useState(50)
  const [flatten, setFlatten] = useState(false)
  const [tokens, setTokens] = useState([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [isTruncated, setIsTruncated] = useState(false)
  const [nextToken, setNextToken] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(null) // a short label for the in-flight mutation
  const [notice, setNotice] = useState(null)
  // What the alert's Retry re-runs. Every failure path records the operation that
  // caused it, so an expired SSO session is recovered from in place.
  const [retryAction, setRetryAction] = useState(null)

  // --- search -------------------------------------------------------------
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('both')
  const [explain, setExplain] = useState(null)
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState(null)
  const [searchProgress, setSearchProgress] = useState(null)
  const searchIdRef = useRef(null)
  const abortRef = useRef(null)
  // Every run gets a number. A walk over a big bucket takes seconds, so a run
  // can be superseded (by a scope change, or a second click) while it is still
  // paging — and a late response must not overwrite the newer one's result, nor
  // clear the newer one's "searching" state.
  const runIdRef = useRef(0)

  // --- viewer -------------------------------------------------------------
  const [viewingKey, setViewingKey] = useState(null)

  // --- upload -------------------------------------------------------------
  const [uploadOpen, setUploadOpen] = useState(false)
  const [pendingUpload, setPendingUpload] = useState(null)
  const [dropActive, setDropActive] = useState(false)
  // dragenter/dragleave fire for every child element the pointer crosses, so the
  // overlay is driven by a depth count rather than by the last event seen.
  const dragDepth = useRef(0)

  const { confirm, confirmDialog } = useConfirm()
  const { prompt, promptDialog } = usePrompt()

  const identity = useMemo(() => ({ profileName, authnMode, bucket }), [profileName, authnMode, bucket])

  /**
   * Record a failure together with the operation that caused it, so Retry re-runs
   * exactly that. React reads a bare function passed to a setter as an updater,
   * hence the wrapper.
   */
  const failWith = useCallback((e, retry) => {
    setError(e.response?.data || { message: e.message })
    setRetryAction(() => retry || null)
  }, [])

  // -----------------------------------------------------------------------
  // Listing
  // -----------------------------------------------------------------------

  const listPage = useCallback(
    async (token, index) => {
      setLoading(true)
      setError(null)
      try {
        const data = await s3ListObjects({
          ...identity,
          prefix,
          // An empty delimiter flattens the whole subtree — the "show everything
          // under here" toggle. '/' is what produces the folder illusion.
          delimiter: flatten ? '' : '/',
          maxKeys: pageSize,
          continuationToken: token
        })
        setFolders(data.prefixes || [])
        setObjects(data.objects || [])
        setIsTruncated(!!data.isTruncated)
        setNextToken(data.continuationToken || null)
        setPageIndex(index)
      } catch (e) {
        failWith(e, () => listPage(token, index))
      } finally {
        setLoading(false)
      }
    },
    [identity, prefix, flatten, pageSize, failWith]
  )

  // Any change of folder, page size or flatten mode restarts paging: S3's
  // continuation tokens are only meaningful for the exact request that produced
  // them.
  useEffect(() => {
    setTokens([null])
    setSelected(new Set())
    setSearchResult(null)
    listPage(null, 0)
  }, [listPage])

  const refresh = useCallback(() => {
    listPage(tokens[pageIndex] || null, pageIndex)
  }, [listPage, tokens, pageIndex])

  const nextPage = () => {
    if (!nextToken) return
    setTokens(previous => {
      const copy = previous.slice(0, pageIndex + 1)
      copy.push(nextToken)
      return copy
    })
    listPage(nextToken, pageIndex + 1)
  }

  const previousPage = () => {
    if (pageIndex === 0) return
    listPage(tokens[pageIndex - 1] || null, pageIndex - 1)
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  // Explain the query as it is typed, so the syntax teaches itself. The scope goes
  // with it: the hint has to describe the search the Search button will run.
  useEffect(() => {
    if (!query.trim()) {
      setExplain(null)
      return
    }
    const timer = setTimeout(() => {
      s3ExplainSearch(query, false, scope)
        .then(setExplain)
        .catch(() => setExplain(null))
    }, 250)
    return () => clearTimeout(timer)
  }, [query, scope])

  // Progress for the running search (and for a long delete) arrives here.
  useEffect(() => {
    const socket = getSocket()
    const eventName = `event_s3_world_${getUserName()}`

    function onEvent(payload) {
      if (!payload) return
      if (payload.type === 'search_progress' && payload.searchId === searchIdRef.current) {
        setSearchProgress({ scanned: payload.scanned, matchCount: payload.matchCount })
        return
      }
      if (payload.type === 'delete_progress') {
        setBusy(`Deleting ${payload.deleted} of ${payload.total}…`)
        return
      }
      if (payload.type === 'copy_progress') {
        setBusy(`${payload.move ? 'Moving' : 'Copying'} ${payload.done} of ${payload.total}…`)
      }
    }

    socket.on(eventName, onEvent)
    return () => {
      socket.off(eventName, onEvent)
    }
  }, [])

  /**
   * Abandon whatever search is in flight. The client stops waiting for it and
   * the server stops walking — a superseded search would otherwise keep paging
   * through S3 for another ten seconds for an answer nobody will read.
   */
  const abandonInFlight = useCallback(() => {
    const controller = abortRef.current
    const searchId = searchIdRef.current
    abortRef.current = null
    searchIdRef.current = null
    if (controller) controller.abort()
    if (searchId) s3CancelSearch(searchId).catch(() => {})
  }, [])

  const runSearch = useCallback(
    async event => {
      event?.preventDefault()
      if (!query.trim()) {
        setSearchResult(null)
        return
      }
      // Starting a search always replaces the previous one, so a scope change
      // mid-walk takes effect instead of being dropped.
      abandonInFlight()

      const runId = runIdRef.current + 1
      runIdRef.current = runId
      const current = () => runIdRef.current === runId

      const searchId = `search-${runId}-${Date.now()}`
      const controller = new AbortController()
      searchIdRef.current = searchId
      abortRef.current = controller
      setSearching(true)
      setSearchProgress({ scanned: 0, matchCount: 0 })
      setSearchResult(null)
      setError(null)
      try {
        const data = await s3SearchObjects(
          { ...identity, prefix, query, scope, searchId },
          controller.signal
        )
        if (current()) setSearchResult(data)
      } catch (e) {
        if (current() && e.code !== 'ERR_CANCELED') {
          failWith(e, () => runSearch())
        }
      } finally {
        // Only the newest run owns this state; a superseded one leaving
        // `searching` false would put a Search button over a running walk.
        if (current()) {
          setSearching(false)
          searchIdRef.current = null
          abortRef.current = null
        }
      }
    },
    [identity, prefix, query, scope, abandonInFlight, failWith]
  )

  // Changing what is being searched re-runs it, so the results on screen always
  // answer the question the selector is asking. This has to fire *during* a
  // search too, not only over a finished one: a walk across a large bucket takes
  // seconds, and skipping the re-run left the selector saying "folders" while
  // the results (and their description) were still the previous scope's — which
  // read as the selector doing nothing at all.
  const searchIsActive = !!searchResult || searching
  // A search that has started but has nothing to show yet. The listing must not
  // reappear underneath it (see the table body).
  const searchPending = searching && !searchResult
  useEffect(() => {
    if (!searchIsActive) return
    runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const stopSearch = useCallback(async () => {
    const searchId = searchIdRef.current
    if (searchId) {
      // Ask the server to stop walking; it finishes the current page and returns
      // what it found, which is more useful than dropping the results.
      await s3CancelSearch(searchId).catch(() => {})
    }
  }, [])

  const clearSearch = () => {
    setQuery('')
    setSearchResult(null)
    setSearchProgress(null)
  }

  // -----------------------------------------------------------------------
  // Selection
  // -----------------------------------------------------------------------

  const rows = useMemo(() => {
    if (searchResult) {
      return [
        // Folders first: when the query was about a folder, the folder itself is
        // the answer — clicking it beats scrolling the objects inside it.
        ...(searchResult.folders || []).map(folder => ({
          kind: 'folder',
          key: folder.prefix,
          name: `${folder.relativePath}/`,
          objectCount: folder.objectCount,
          size: folder.size
        })),
        ...searchResult.matches.map(match => ({
          kind: 'object',
          key: match.key,
          name: match.relativeKey || match.name,
          size: match.size,
          lastModified: match.lastModified,
          storageClass: match.storageClass,
          viewer: match.viewer,
          contentType: match.contentType,
          parentPrefix: match.parentPrefix
        }))
      ]
    }
    // Nothing to select or show while a search is running — and in particular
    // not the browsed folder, which is not what the screen is about any more.
    if (searchPending) return []
    return [
      ...folders.map(folderPrefix => ({
        kind: 'folder',
        key: folderPrefix,
        name: folderPrefix.slice(prefix.length)
      })),
      ...objects.map(entry => ({
        kind: 'object',
        key: entry.key,
        name: entry.name || baseName(entry.key),
        size: entry.size,
        lastModified: entry.lastModified,
        storageClass: entry.storageClass,
        viewer: entry.viewer,
        contentType: entry.contentType,
        archived: entry.archived
      }))
    ]
  }, [searchResult, searchPending, folders, objects, prefix])

  const toggle = key => {
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allSelected = rows.length > 0 && rows.every(row => selected.has(row.key))
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map(row => row.key)))
  }

  const selectedRows = rows.filter(row => selected.has(row.key))
  const selectedObjects = selectedRows.filter(row => row.kind === 'object')
  const selectedFolders = selectedRows.filter(row => row.kind === 'folder')

  // -----------------------------------------------------------------------
  // Mutations
  // -----------------------------------------------------------------------

  const withBusy = useCallback(
    async (label, work) => {
      setBusy(label)
      setError(null)
      try {
        await work()
      } catch (e) {
        // Retrying re-runs the same work — which is what recovers a copy, move or
        // delete interrupted by an SSO session that expired mid-operation.
        failWith(e, () => withBusy(label, work))
      } finally {
        setBusy(null)
      }
    },
    [failWith]
  )

  const download = useCallback(
    async key => {
      const result = await s3PresignView({ ...identity, key, disposition: 'attachment' })
      const anchor = document.createElement('a')
      anchor.href = result.url
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    },
    [identity]
  )

  const downloadSelected = () =>
    withBusy('Preparing downloads…', async () => {
      for (const row of selectedObjects) {
        // Sequential: a burst of parallel navigations gets throttled by the
        // browser's own popup/download limits.
        await download(row.key)
      }
    })

  const createFolder = async () => {
    const folderName = await prompt({
      title: 'New folder',
      label: `Create a folder under ${bucket}/${prefix || ''}`,
      placeholder: 'folder-name'
    })
    if (!folderName) return
    await withBusy('Creating folder…', async () => {
      await s3CreateFolder({ ...identity, prefix, folderName })
      setNotice(`Created ${prefix}${folderName}/`)
      refresh()
    })
  }

  const openUpload = (items = null) => {
    setPendingUpload(items)
    setUploadOpen(true)
  }

  // -----------------------------------------------------------------------
  // Drag and drop
  // -----------------------------------------------------------------------

  // Only a drag carrying files is ours; dragging selected text across the table
  // must not put the page into a drop state.
  const dragHasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')

  const onDragEnter = event => {
    if (!dragHasFiles(event)) return
    dragDepth.current += 1
    setDropActive(true)
  }

  const onDragOver = event => {
    if (!dragHasFiles(event)) return
    // Without preventDefault the browser refuses the drop and navigates to the
    // file instead — the classic "my drop zone does nothing" bug.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDropActive(false)
  }

  const onDrop = event => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDropActive(false)
    filesFromDataTransfer(event.dataTransfer).then(items => {
      if (items.length) openUpload(items)
    })
  }

  // A file dropped outside the panel would otherwise be *opened* by the browser,
  // navigating away from the app and losing the folder, search and selection —
  // an expensive way to miss a target. Swallowed instead.
  useEffect(() => {
    const swallow = event => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  const deleteSelected = async () => {
    const folderCount = selectedFolders.length
    const message = folderCount
      ? `Delete ${selectedObjects.length} object(s) and everything under ${folderCount} folder(s)? ` +
        'Deleting a folder deletes every key beneath it, and this cannot be undone.'
      : `Delete ${selectedObjects.length} object(s)? This cannot be undone.`
    if (!(await confirm({ title: 'Delete from S3', message, confirmLabel: 'Delete' }))) return

    await withBusy('Deleting…', async () => {
      const result = await s3DeleteObjects({
        ...identity,
        keys: selectedObjects.map(row => row.key),
        prefixes: selectedFolders.map(row => row.key)
      })
      setSelected(new Set())
      setNotice(
        `Deleted ${result.deletedCount} of ${result.requested} keys` +
          (result.errors?.length ? `, ${result.errors.length} failed` : '.')
      )
      refresh()
    })
  }

  const copyOrMove = async isMove => {
    const destination = await prompt({
      title: isMove ? 'Move objects' : 'Copy objects',
      label: `Destination prefix within ${bucket} — a single / means the bucket root`,
      initialValue: prefix,
      placeholder: 'some/folder/',
      confirmLabel: isMove ? 'Move' : 'Copy'
    })
    if (destination == null) return
    // '/' is the way to say "the bucket root": the prompt cannot return an empty
    // string, and a leading slash would otherwise become a key literally named '/'.
    const trimmed = destination.replace(/^\/+/, '')
    const normalized = trimmed && !trimmed.endsWith('/') ? `${trimmed}/` : trimmed

    await withBusy(isMove ? 'Moving…' : 'Copying…', async () => {
      const result = await s3CopyObjects({
        ...identity,
        items: selectedObjects.map(row => ({ key: row.key })),
        destinationPrefix: normalized,
        move: isMove
      })
      setSelected(new Set())
      setNotice(
        result.message ||
          `${isMove && result.moved ? 'Moved' : 'Copied'} ${result.copied.length} object(s)` +
            (result.errors?.length ? `, ${result.errors.length} failed.` : '.')
      )
      refresh()
    })
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const crumbs = crumbsFor(prefix)

  const pageSummary =
    `Page ${pageIndex + 1} · ${folders.length} folders, ${objects.length} objects` +
    (isTruncated ? ' · more available' : '')

  return (
    <div
      className="position-relative"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Dropping anywhere on the panel uploads here — the console experience,
          and the only way to upload a folder without flattening it. The overlay
          takes no pointer events, or it would swallow the drop it announces. */}
      {dropActive && (
        <div
          className="position-absolute top-0 start-0 end-0 bottom-0 d-flex flex-column
            align-items-center justify-content-center border border-2 border-primary rounded
            bg-primary-subtle bg-opacity-75"
          style={{ borderStyle: 'dashed', zIndex: 5, pointerEvents: 'none' }}
        >
          <div className="fs-2" aria-hidden="true">
            ⬆
          </div>
          <div className="fw-semibold">Drop to upload</div>
          <div className="small font-monospace">
            {bucket}/{prefix}
          </div>
        </div>
      )}

      {/* Breadcrumb */}
      <nav className="d-flex flex-wrap align-items-center gap-1 small mb-2">
        <Button variant="link" size="sm" className="p-0 text-decoration-none" onClick={onLeaveBucket}>
          All buckets
        </Button>
        <span className="text-muted">/</span>
        <Button
          variant="link"
          size="sm"
          className="p-0 text-decoration-none font-monospace"
          onClick={() => onNavigate('')}
        >
          {bucket}
        </Button>
        {crumbs.map(crumb => (
          <span key={crumb.prefix} className="d-inline-flex align-items-center gap-1">
            <span className="text-muted">/</span>
            <Button
              variant="link"
              size="sm"
              className="p-0 text-decoration-none font-monospace"
              onClick={() => onNavigate(crumb.prefix)}
            >
              {crumb.label}
            </Button>
          </span>
        ))}
      </nav>

      {/* Search */}
      <Form onSubmit={runSearch} className="mb-2">
        <InputGroup size="sm">
          <InputGroup.Text>
            Search {prefix ? <span className="font-monospace ms-1">{prefix}</span> : 'this bucket'}
          </InputGroup.Text>
          <Form.Control
            placeholder="any part of a name — searches every subfolder"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          {/* What to match against. "invoices" is both a folder people look for
              and a word in file names, and those want different answers. */}
          <Form.Select
            value={scope}
            onChange={event => setScope(event.target.value)}
            style={{ maxWidth: 190 }}
            aria-label="What to search"
            title="Match the query against the object's own name, the folder path it sits in, or both"
          >
            {SEARCH_SCOPES.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Form.Select>
          {searching ? (
            <Button variant="outline-danger" onClick={stopSearch}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!query.trim()}>
              Search
            </Button>
          )}
          {(searchResult || query) && !searching && (
            <Button variant="outline-secondary" onClick={clearSearch}>
              Clear
            </Button>
          )}
        </InputGroup>
        <div className="small text-muted mt-1">
          {explain ? (
            <span>
              Will match {explain.description.charAt(0).toLowerCase()}
              {explain.description.slice(1)}
            </span>
          ) : (
            <span>
              Case-insensitive, matches anywhere in the {SCOPE_HINTS[scope]}, searches every
              subfolder. Try{' '}
              {SEARCH_EXAMPLES.map((example, index) => (
                <span key={example.query}>
                  {index ? ' · ' : ''}
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0 align-baseline font-monospace"
                    title={example.hint}
                    onClick={() => setQuery(example.query)}
                  >
                    {example.query}
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>
      </Form>

      {searching && (
        <div className="mb-2">
          <ProgressBar animated now={100} style={{ height: 4 }} />
          <div className="small text-muted mt-1">
            Searching {explain ? explain.description.charAt(0).toLowerCase() + explain.description.slice(1, -1) : query}
            {' · '}
            scanned {(searchProgress?.scanned || 0).toLocaleString()} keys ·{' '}
            {searchProgress?.matchCount || 0} matches so far
          </div>
        </div>
      )}

      {searchResult && (
        <Alert variant="light" className="border py-2 small d-flex flex-wrap gap-2 align-items-center">
          <strong>
            {searchResult.folderCount
              ? `${searchResult.folderCount} folder${searchResult.folderCount === 1 ? '' : 's'}, ` +
                `${searchResult.matchCount} object${searchResult.matchCount === 1 ? '' : 's'}`
              : `${searchResult.matchCount} match${searchResult.matchCount === 1 ? '' : 'es'}`}
          </strong>
          <span className="text-muted">
            from {searchResult.scanned.toLocaleString()} keys scanned in{' '}
            {(searchResult.elapsedMs / 1000).toFixed(1)}s · {searchResult.description}
          </span>
          {searchResult.folderLimitHit && (
            <Badge bg="warning" text="dark">
              folder list truncated
            </Badge>
          )}
          {searchResult.stopReason === 'scan-limit' && (
            <Badge bg="warning" text="dark">
              scan limit reached — narrow the prefix
            </Badge>
          )}
          {searchResult.stopReason === 'match-limit' && (
            <Badge bg="warning" text="dark">
              match limit reached
            </Badge>
          )}
          {searchResult.stopReason === 'cancelled' && <Badge bg="secondary">stopped</Badge>}
        </Alert>
      )}

      {/* Toolbar */}
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <Button
          size="sm"
          variant="primary"
          disabled={selectedObjects.length !== 1}
          onClick={() => setViewingKey(selectedObjects[0].key)}
        >
          View
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={!selectedObjects.length || !!busy}
          onClick={downloadSelected}
        >
          Download
        </Button>
        <Dropdown>
          {/* outline-secondary renders grey-on-white — the same colour Bootstrap
              gives a disabled button — so this menu read as inactive. */}
          <Dropdown.Toggle size="sm" variant="outline-primary" disabled={!!busy}>
            Actions
          </Dropdown.Toggle>
          <Dropdown.Menu>
            <Dropdown.Item onClick={createFolder}>New folder…</Dropdown.Item>
            <Dropdown.Item onClick={() => openUpload()}>Upload files or folders…</Dropdown.Item>
            <Dropdown.Divider />
            <Dropdown.Item disabled={!selectedObjects.length} onClick={() => copyOrMove(false)}>
              Copy to…
            </Dropdown.Item>
            <Dropdown.Item disabled={!selectedObjects.length} onClick={() => copyOrMove(true)}>
              Move to…
            </Dropdown.Item>
            <Dropdown.Divider />
            <Dropdown.Item
              className="text-danger"
              disabled={!selectedRows.length}
              onClick={deleteSelected}
            >
              Delete…
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown>
        <Form.Check
          type="switch"
          id="s3-flatten"
          className="ms-2"
          label="All objects under this prefix"
          checked={flatten}
          disabled={searchIsActive}
          onChange={event => setFlatten(event.target.checked)}
        />
        <div className="ms-auto d-flex align-items-center gap-2">
          {busy && (
            <span className="small text-muted d-inline-flex align-items-center gap-1">
              <Spinner size="sm" animation="border" /> {busy}
            </span>
          )}
          <Button size="sm" variant="outline-secondary" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {notice && (
        <Alert variant="success" className="py-2 small" dismissible onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      <ApiErrorAlert
        error={error}
        profileName={profileName}
        onRetry={retryAction || refresh}
        onDismiss={() => setError(null)}
      />

      {/* Paging, above the table as well as below it — see Pager.jsx. A page of
          1000 keys is several screens tall, and Next should never be a scroll
          away. A search is one result set, not a page, so it has no pager — and
          that includes while it is still running. */}
      {!searchIsActive && (
        <Pager
          className="mb-2"
          summary={pageSummary}
          onPrevious={previousPage}
          onNext={nextPage}
          disablePrevious={pageIndex === 0 || loading}
          disableNext={!nextToken || loading}
        />
      )}

      {/* Listing */}
      <div className="border rounded">
        <Table hover size="sm" className="mb-0 align-middle">
          <thead className="table-light">
            <tr>
              <th style={{ width: 36 }}>
                <Form.Check
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
              <th>{searchIsActive ? 'Key' : 'Name'}</th>
              <th style={{ width: 180 }}>Type</th>
              <th style={{ width: 110 }} className="text-end">
                Size
              </th>
              <th style={{ width: 200 }}>Last modified</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="text-center text-muted py-4">
                  <Spinner size="sm" animation="border" className="me-2" />
                  Listing…
                </td>
              </tr>
            )}
            {/* A search in flight owns this table. Falling back to the browsed
                folder here (which is what `rows` does without a result) made a
                re-run look like the search had been thrown away. */}
            {!loading && searchPending && (
              <tr>
                <td colSpan={6} className="text-center text-muted py-4">
                  <Spinner size="sm" animation="border" className="me-2" />
                  Searching {(searchProgress?.scanned || 0).toLocaleString()} keys so far…
                </td>
              </tr>
            )}
            {!loading &&
              !searchPending &&
              rows.map(row => (
                <tr key={row.key}>
                  <td>
                    <Form.Check
                      type="checkbox"
                      aria-label={`Select ${row.name}`}
                      checked={selected.has(row.key)}
                      onChange={() => toggle(row.key)}
                    />
                  </td>
                  <td className="text-break">
                    {row.kind === 'folder' ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="p-0 text-decoration-none font-monospace"
                        onClick={() => {
                          // Opening a matched folder is the point of searching for
                          // one, so it drops out of the result set into the tree.
                          clearSearch()
                          onNavigate(row.key)
                        }}
                      >
                        📁 {row.name}
                      </Button>
                    ) : (
                      <span className="d-inline-flex align-items-center gap-1">
                        <span aria-hidden="true">{viewerIcon(row.viewer)}</span>
                        <button
                          type="button"
                          className="btn btn-link btn-sm p-0 text-decoration-none font-monospace text-start"
                          onClick={() => setViewingKey(row.key)}
                        >
                          {row.name}
                        </button>
                        {row.archived && (
                          <Badge bg="secondary" title="Restore before this can be read">
                            {row.storageClass}
                          </Badge>
                        )}
                      </span>
                    )}
                    {searchResult && row.parentPrefix != null && (
                      <div className="small text-muted">
                        in{' '}
                        <button
                          type="button"
                          className="btn btn-link btn-sm p-0 align-baseline font-monospace"
                          onClick={() => {
                            clearSearch()
                            onNavigate(row.parentPrefix)
                          }}
                        >
                          {row.parentPrefix || `${bucket}/`}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="small text-muted font-monospace text-truncate" style={{ maxWidth: 180 }}>
                    {row.kind === 'folder' ? 'folder' : row.contentType}
                  </td>
                  {/* A matched folder carries what a browsed one cannot: the search
                      walked its whole subtree, so the count and rolled-up size are
                      already known and worth showing. */}
                  <td className="text-end small">
                    {row.size == null ? '—' : formatBytes(row.size)}
                  </td>
                  <td className="small text-muted">
                    {row.kind === 'object'
                      ? formatWhen(row.lastModified)
                      : row.objectCount != null &&
                        `${row.objectCount.toLocaleString()} object${row.objectCount === 1 ? '' : 's'}`}
                  </td>
                  <td className="text-end">
                    {row.kind === 'object' && (
                      <div className="d-flex gap-1 justify-content-end">
                        <Button size="sm" variant="outline-primary" onClick={() => setViewingKey(row.key)}>
                          View
                        </Button>
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          title="Download"
                          onClick={() => download(row.key)}
                        >
                          ↓
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            {!loading && !searchPending && !rows.length && (
              <tr>
                <td colSpan={6} className="text-center text-muted py-4">
                  {searchResult
                    ? 'Nothing matched. Try fewer words, or search from a shorter prefix.'
                    : 'This folder is empty.'}
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>

      {/* Paging — only meaningful for a listing; search returns one result set. */}
      {!searchIsActive && (
        <Pager
          className="mt-2"
          summary={pageSummary}
          onPrevious={previousPage}
          onNext={nextPage}
          disablePrevious={pageIndex === 0 || loading}
          disableNext={!nextToken || loading}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          onPageSize={setPageSize}
        />
      )}

      <S3UploadDialog
        show={uploadOpen}
        onHide={() => {
          setUploadOpen(false)
          setPendingUpload(null)
        }}
        identity={identity}
        prefix={prefix}
        pending={pendingUpload}
        onUploaded={count => {
          setNotice(`Uploaded ${count} object${count === 1 ? '' : 's'}.`)
          refresh()
        }}
      />

      <S3ObjectViewerModal
        show={!!viewingKey}
        onHide={() => setViewingKey(null)}
        profileName={profileName}
        authnMode={authnMode}
        bucket={bucket}
        objectKey={viewingKey}
      />
      {confirmDialog}
      {promptDialog}
    </div>
  )
}
