import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Form, Modal, ProgressBar, Spinner, Table } from 'react-bootstrap'

import { s3UploadObject } from '../presignApi'
import { formatBytes } from './objectViewers.jsx'
import ApiErrorAlert from '../ApiErrorAlert.jsx'

/**
 * S3UploadDialog — drop files (or whole folders) here.
 *
 * A file picker alone is the minimum, and it is what the browser gives you for
 * free; dragging is how people actually move files into S3, and it is the only
 * way to upload a *tree* without flattening it. So this queue accepts both, and
 * keeps each file's relative path: dropping `logs/2026/app.log` uploads it to
 * `<prefix>logs/2026/app.log`, not to `<prefix>app.log`.
 *
 * Two things it does that the plain loop it replaced could not: per-file progress
 * (a 90 MB upload with no feedback looks like a hang), and a failure that does
 * not throw away the rest of the queue — a failed file can be retried on its own,
 * which is what makes recovering from a mid-batch SSO expiry cheap.
 */

// Mirrors UPLOAD_LIMIT_BYTES in lib/s3/s3World.js — the server answers anything
// larger with a 413, and saying so before the bytes go on the wire is kinder.
const MAX_FILE_BYTES = 100 * 1024 * 1024

// A dropped folder can be enormous. This is a guard against queueing a home
// directory by accident, not a considered opinion about batch size.
const MAX_FILES = 500

/** Read one directory fully: readEntries() returns ~100 at a time until empty. */
function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = []
    const step = () => {
      reader.readEntries(batch => {
        if (!batch.length) return resolve(all)
        all.push(...batch)
        step()
      }, reject)
    }
    step()
  })
}

async function walkEntry(entry, base, out) {
  if (out.length >= MAX_FILES) return
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
    out.push({ file, path: `${base}${file.name}` })
    return
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader())
    for (const child of children) {
      await walkEntry(child, `${base}${entry.name}/`, out)
    }
  }
}

/**
 * Turn a drop into `{ file, path }` pairs, expanding directories.
 *
 * The entries have to be taken from the DataTransfer *synchronously* — it is
 * emptied once the drop handler returns — so every `webkitGetAsEntry()` happens
 * up front and only the walk is asynchronous.
 */
export async function filesFromDataTransfer(dataTransfer) {
  const entries = []
  const items = Array.from(dataTransfer?.items || [])
  for (const item of items) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  if (!entries.length) {
    // No entries API (or a drag that carried plain files only).
    return Array.from(dataTransfer?.files || []).map(file => ({
      file,
      path: file.webkitRelativePath || file.name
    }))
  }

  const out = []
  for (const entry of entries) {
    await walkEntry(entry, '', out)
  }
  return out
}

/** The same shape from an <input type="file">, folder picker included. */
export function filesFromInput(fileList) {
  return Array.from(fileList || []).map(file => ({
    file,
    path: file.webkitRelativePath || file.name
  }))
}

/** An error that every remaining file in the queue would hit too. */
function isCredentialError(payload) {
  return !!(
    payload &&
    (payload.ssoSessionExpired ||
      payload.verificationUriComplete ||
      payload.statusCode === 401 ||
      payload.statusCode === 403)
  )
}

let nextId = 0

export default function S3UploadDialog({
  show,
  onHide,
  identity,
  prefix,
  pending,
  onUploaded
}) {
  const [items, setItems] = useState([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)

  const addFiles = useCallback(intake => {
    if (!intake?.length) return
    setItems(previous => {
      const seen = new Set(previous.map(item => item.path))
      const additions = []
      for (const entry of intake) {
        if (seen.has(entry.path)) continue
        if (previous.length + additions.length >= MAX_FILES) break
        seen.add(entry.path)
        additions.push({
          id: (nextId += 1),
          file: entry.file,
          path: entry.path,
          // Refused up front rather than uploaded and rejected by the server.
          status: entry.file.size > MAX_FILE_BYTES ? 'too-large' : 'pending',
          loaded: 0,
          error: null
        })
      }
      return previous.concat(additions)
    })
  }, [])

  // A drop on the browser page behind this dialog arrives as a new batch.
  useEffect(() => {
    if (pending?.length) addFiles(pending)
  }, [pending, addFiles])

  // Closing the dialog empties the queue: a stale list of already-uploaded files
  // reappearing on the next upload would be worse than re-dropping them.
  useEffect(() => {
    if (!show) {
      setItems([])
      setError(null)
      setDragging(false)
    }
  }, [show])

  const update = useCallback((id, patch) => {
    setItems(previous => previous.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const counts = useMemo(() => {
    const queued = items.filter(item => item.status === 'pending' || item.status === 'error')
    return {
      queued: queued.length,
      failed: items.filter(item => item.status === 'error').length,
      done: items.filter(item => item.status === 'done').length,
      tooLarge: items.filter(item => item.status === 'too-large').length,
      bytes: queued.reduce((total, item) => total + item.file.size, 0)
    }
  }, [items])

  const uploadQueued = useCallback(async () => {
    const queue = items.filter(item => item.status === 'pending' || item.status === 'error')
    if (!queue.length) return
    setUploading(true)
    setError(null)
    let uploaded = 0
    try {
      for (const item of queue) {
        update(item.id, { status: 'uploading', loaded: 0, error: null })
        try {
          await s3UploadObject(
            {
              ...identity,
              key: `${prefix}${item.path}`,
              // The server re-resolves the type from the name and the first bytes,
              // so an object uploaded here is viewable later without an override.
              contentType: item.file.type || undefined
            },
            item.file,
            event => update(item.id, { loaded: event.loaded })
          )
          update(item.id, { status: 'done', loaded: item.file.size })
          uploaded += 1
        } catch (e) {
          const payload = e.response?.data || { message: e.message }
          update(item.id, { status: 'error', error: payload.message })
          setError(payload)
          if (isCredentialError(payload)) {
            // Every remaining file would fail the same way. Stop, let the user
            // authorize, and leave the rest queued for the Retry button.
            break
          }
        }
      }
    } finally {
      setUploading(false)
      if (uploaded) onUploaded?.(uploaded)
    }
  }, [items, identity, prefix, update, onUploaded])

  const onDrop = event => {
    event.preventDefault()
    setDragging(false)
    if (uploading) return
    filesFromDataTransfer(event.dataTransfer).then(addFiles)
  }

  const destination = `${identity.bucket}/${prefix || ''}`

  return (
    <Modal show={show} onHide={uploading ? undefined : onHide} size="lg" centered scrollable>
      <Modal.Header closeButton={!uploading}>
        <Modal.Title className="h6 mb-0">
          Upload to <span className="font-monospace">{destination}</span>
        </Modal.Title>
      </Modal.Header>
      {/* The handlers sit on the whole body, not just the dashed box: a drop that
          lands an inch off target would otherwise be handled by the browser,
          which navigates away from the app to display the file. */}
      <Modal.Body
        onDragOver={event => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div
          className={`border border-2 rounded text-center p-4 mb-3 ${
            dragging ? 'border-primary bg-primary-subtle' : 'border-secondary-subtle'
          }`}
          style={{ borderStyle: 'dashed', transition: 'background-color .15s' }}
        >
          <div className="fs-4" aria-hidden="true">
            ⬆
          </div>
          <div className="fw-semibold">Drag files or folders here</div>
          <div className="small text-muted mb-2">
            Folders keep their structure · up to {formatBytes(MAX_FILE_BYTES)} per file
          </div>
          <div className="d-inline-flex gap-2">
            <Button
              size="sm"
              variant="outline-primary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose files
            </Button>
            <Button
              size="sm"
              variant="outline-primary"
              disabled={uploading}
              onClick={() => folderInputRef.current?.click()}
            >
              Choose a folder
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="d-none"
            onChange={event => {
              addFiles(filesFromInput(event.target.files))
              event.target.value = ''
            }}
          />
          {/* webkitdirectory is non-standard but universally supported, and it is
              the only way to pick a tree; the files then carry
              webkitRelativePath, which is the same path a dropped folder gives. */}
          <input
            ref={folderInputRef}
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            className="d-none"
            onChange={event => {
              addFiles(filesFromInput(event.target.files))
              event.target.value = ''
            }}
          />
        </div>

        <ApiErrorAlert
          error={error}
          profileName={identity.profileName}
          onRetry={uploading ? null : uploadQueued}
          retryLabel={counts.failed ? `Retry ${counts.failed} failed` : 'Retry'}
          onDismiss={() => setError(null)}
        />

        {items.length > 0 && (
          <>
            <div className="d-flex flex-wrap align-items-center gap-2 small text-muted mb-1">
              <span>
                {items.length} file{items.length === 1 ? '' : 's'} · {counts.done} uploaded
                {counts.failed ? ` · ${counts.failed} failed` : ''}
                {counts.tooLarge ? ` · ${counts.tooLarge} too large` : ''}
              </span>
              {!uploading && items.length > counts.queued && (
                <Button
                  variant="link"
                  size="sm"
                  className="p-0"
                  onClick={() =>
                    setItems(previous =>
                      previous.filter(item => item.status === 'pending' || item.status === 'error')
                    )
                  }
                >
                  Clear finished
                </Button>
              )}
            </div>
            <div className="border rounded" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <Table size="sm" className="mb-0 align-middle">
                <tbody>
                  {items.map(item => (
                    <tr key={item.id}>
                      <td className="text-break font-monospace small">
                        {item.path}
                        {item.error && <div className="text-danger small">{item.error}</div>}
                      </td>
                      <td className="text-end small text-muted" style={{ width: 90 }}>
                        {formatBytes(item.file.size)}
                      </td>
                      <td style={{ width: 150 }}>
                        {item.status === 'uploading' && (
                          <ProgressBar
                            now={item.file.size ? (item.loaded / item.file.size) * 100 : 100}
                            style={{ height: 6 }}
                          />
                        )}
                        {item.status === 'done' && <Badge bg="success">uploaded</Badge>}
                        {item.status === 'error' && <Badge bg="danger">failed</Badge>}
                        {item.status === 'too-large' && (
                          <Badge bg="warning" text="dark">
                            over {formatBytes(MAX_FILE_BYTES)}
                          </Badge>
                        )}
                        {item.status === 'pending' && (
                          <span className="small text-muted">queued</span>
                        )}
                      </td>
                      <td className="text-end" style={{ width: 40 }}>
                        <Button
                          variant="link"
                          size="sm"
                          className="p-0 text-muted"
                          title="Remove from the queue"
                          disabled={uploading}
                          onClick={() =>
                            setItems(previous => previous.filter(other => other.id !== item.id))
                          }
                        >
                          ✕
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}

        {items.length >= MAX_FILES && (
          <div className="small text-warning-emphasis mt-2">
            Queue limit reached ({MAX_FILES} files). Upload these, then add the rest.
          </div>
        )}
        <Form.Text className="d-block mt-2">
          An object with the same key is overwritten.
        </Form.Text>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onHide} disabled={uploading}>
          {counts.done && !counts.queued ? 'Close' : 'Cancel'}
        </Button>
        <Button variant="primary" onClick={uploadQueued} disabled={uploading || !counts.queued}>
          {uploading ? (
            <>
              <Spinner size="sm" animation="border" className="me-2" />
              Uploading…
            </>
          ) : counts.failed && counts.failed === counts.queued ? (
            `Retry ${counts.failed} failed`
          ) : !counts.queued ? (
            'Upload'
          ) : (
            `Upload ${counts.queued} file${counts.queued === 1 ? '' : 's'} · ${formatBytes(counts.bytes)}`
          )}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
