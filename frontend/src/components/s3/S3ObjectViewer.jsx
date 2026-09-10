import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Dropdown, Form, Modal, Spinner } from 'react-bootstrap'

import { s3HeadObject, s3ObjectUrl, s3PresignView, s3PreviewObject } from '../presignApi'
import { appPath } from '../../appConfig'
import ApiErrorAlert from '../ApiErrorAlert.jsx'
import { MediaViewer, ObjectPreview, TypeBadge, baseName, formatBytes, formatWhen } from './objectViewers.jsx'

/**
 * S3ObjectViewer — "I want to see what is in this object", answered.
 *
 * The console can preview a handful of types and otherwise tells you to
 * download. This asks the server what the object actually is (extension, then
 * magic bytes, then the stored Content-Type) and then takes one of three routes,
 * which the server chooses in `recommendView`:
 *
 *   tab      the browser renders it natively (image, PDF, video, audio). Images,
 *            video and audio stream inline through the object proxy; a PDF has to
 *            be framed, so it is rendered from a presigned URL on the S3 origin —
 *            which is also what "Open in new tab" hands the browser.
 *   preview  decoded server-side into a table / JSON / text / listing and
 *            rendered by objectViewers.jsx. Nothing untrusted executes.
 *   download the bytes cannot be shown (Glacier, or a format with no viewer).
 *
 * The same body is used inside the modal on the browser page and on the
 * standalone /s3world/object page, so "open in a new tab" is a real tab with a
 * real URL rather than a second modal.
 */

// Offered lifetimes for a shareable presigned link. The floor and ceiling match
// what the backend clamps to (60 s .. 12 h); for an SSO profile the server may
// shorten any of these to the session token's own expiry, and says so.
const EXPIRY_CHOICES = [
  { label: '5 minutes', seconds: 300 },
  { label: '1 hour', seconds: 3600 },
  { label: '12 hours', seconds: 43200 }
]

// Mirrors clampExpiry() in lib/s3/s3World.js. Kept here so an out-of-range value
// is refused with an explanation instead of being silently clamped server-side —
// a link that quietly lasts 12 h when you asked for 20 is worse than a refusal.
const MIN_EXPIRY_SECONDS = 60
const MAX_EXPIRY_SECONDS = 43200

const EXPIRY_UNITS = {
  minutes: { seconds: 60, max: MAX_EXPIRY_SECONDS / 60 },
  hours: { seconds: 3600, max: MAX_EXPIRY_SECONDS / 3600 }
}

/** "45 min" / "2 h" — how long a link actually ended up lasting. */
function formatLifetime(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
  return `${Math.round(seconds / 60)} min`
}

export function ObjectViewerBody({
  profileName,
  authnMode,
  bucket,
  objectKey,
  versionId = null,
  standalone = false
}) {
  const [loading, setLoading] = useState(true)
  const [head, setHead] = useState(null) // { object, type, endpointStyle, recommendedView }
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [linkNote, setLinkNote] = useState(null)
  // A presign/copy failure is reported *beside* the preview, never instead of it:
  // losing the object you were reading because a link could not be minted would
  // be a poor trade. `linkRetry` re-runs the action that failed.
  const [linkError, setLinkError] = useState(null)
  const [linkRetry, setLinkRetry] = useState(null)
  // The "Custom…" expiry form, revealed from the Presigned link menu.
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState('30')
  const [customUnit, setCustomUnit] = useState('minutes')
  // Presigned URL used as the <object> source for a PDF. See the effect below.
  const [pdfUrl, setPdfUrl] = useState(null)
  // Bumped by Retry. Reading the object again is the whole recovery from an
  // expired SSO session, and it must not cost the user this modal or tab.
  const [attempt, setAttempt] = useState(0)

  const identity = useMemo(
    () => ({ profileName, authnMode, bucket, key: objectKey, versionId }),
    [profileName, authnMode, bucket, objectKey, versionId]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setHead(null)
    setPreview(null)
    setError(null)
    setLinkNote(null)
    setLinkError(null)
    setCustomOpen(false)
    setPdfUrl(null)
    ;(async () => {
      try {
        const meta = await s3HeadObject(identity)
        if (cancelled) return
        setHead(meta)
        // Media needs no decode step: it streams through the proxy. Everything
        // else is decoded on the server, where the credentials are.
        if (meta.recommendedView?.mode === 'preview') {
          const decoded = await s3PreviewObject(identity)
          if (cancelled) return
          setPreview(decoded.preview)
        }
      } catch (e) {
        if (!cancelled) setError(e.response?.data || { message: e.message })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [identity, attempt])

  // A PDF is the one natively-rendered type that has to be *framed* to show
  // inline, and framing is exactly what the object proxy refuses: it serves
  // untrusted bytes from SignBridge's own origin, so it sends
  // `frame-ancestors 'none'` (plus a full CSP sandbox) and the browser then
  // shows the <object> fallback instead of the document. Images, video and audio
  // are unaffected — <img>/<video> are not documents.
  //
  // So the PDF frame gets a presigned URL on the **S3 origin** instead — the same
  // URL "Open in new tab" hands the browser. Different origin, no access to this
  // app's DOM or API, no ambient credentials, and no bucket CORS needed (a frame
  // load is a navigation, not a fetch).
  const isPdf = head?.type?.viewer === 'pdf' && head?.recommendedView?.mode === 'tab'

  useEffect(() => {
    if (!isPdf) return
    let cancelled = false
    ;(async () => {
      try {
        const result = await s3PresignView({ ...identity, disposition: 'inline', expiresInSeconds: 3600 })
        if (!cancelled) setPdfUrl(result.url)
      } catch {
        // Presigning failed (an expired SSO session, say). Fall back to the proxy
        // URL: the browser will show the <object> fallback telling the user to
        // open it in a tab, which is honest rather than an endless spinner.
        if (!cancelled) setPdfUrl(s3ObjectUrl({ ...identity, disposition: 'inline' }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isPdf, identity])

  /** A presigned URL on the S3 origin — the thing SignBridge is for. */
  const presign = useCallback(
    async (disposition, expiresInSeconds) => {
      const result = await s3PresignView({ ...identity, disposition, expiresInSeconds })
      if (result.note) setLinkNote(result.note)
      else if (result.expiresInSeconds !== expiresInSeconds) {
        setLinkNote(
          `The link is valid for ${Math.round(result.expiresInSeconds / 60)} minutes — capped to ` +
            'the remaining life of this profile’s session credentials.'
        )
      }
      return result
    },
    [identity]
  )

  const openInTab = useCallback(async () => {
    if (head?.recommendedView?.mode === 'tab') {
      // Natively renderable: hand the browser a presigned URL on the S3 origin.
      // Different origin, no ambient credentials, no bucket CORS needed.
      const result = await presign('inline', 3600)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      return
    }
    // Everything else opens our own full-page viewer, so untrusted bytes are
    // still only ever rendered as decoded JSON.
    const query = new URLSearchParams({ profileName, bucket, key: objectKey })
    if (authnMode) query.set('authnMode', authnMode)
    if (versionId) query.set('versionId', versionId)
    window.open(`${appPath('/s3world/object')}?${query.toString()}`, '_blank', 'noopener,noreferrer')
  }, [head, presign, profileName, authnMode, bucket, objectKey, versionId])

  const download = useCallback(async () => {
    const result = await presign('attachment', 3600)
    const anchor = document.createElement('a')
    anchor.href = result.url
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }, [presign])

  const copyLink = useCallback(
    async seconds => {
      const result = await presign('inline', seconds)
      await navigator.clipboard?.writeText(result.url)
      setLinkNote(`Presigned link copied — valid for ${formatLifetime(result.expiresInSeconds)}.`)
    },
    [presign]
  )

  /**
   * Run a link action (open / download / copy) and keep its failure local.
   *
   * Presigning is the operation most likely to hit an expired SSO session, and
   * the useful answer is Authorize + Retry — so the error goes to `linkError`,
   * which renders the shared alert inline with a Retry that re-runs *this*
   * action rather than re-reading the object.
   */
  const runLinkAction = useCallback(async action => {
    setLinkError(null)
    try {
      await action()
    } catch (e) {
      setLinkError(e.response?.data || { message: e.message })
      setLinkRetry(() => () => runLinkAction(action))
    }
  }, [])

  const customSeconds = Math.round(
    Number(customValue) * (EXPIRY_UNITS[customUnit] || EXPIRY_UNITS.minutes).seconds
  )
  const customInvalid =
    !Number.isFinite(customSeconds) ||
    customSeconds < MIN_EXPIRY_SECONDS ||
    customSeconds > MAX_EXPIRY_SECONDS

  const copyCustomLink = useCallback(async () => {
    if (customInvalid) return
    await runLinkAction(() => copyLink(customSeconds))
    setCustomOpen(false)
  }, [customInvalid, customSeconds, runLinkAction, copyLink])

  if (loading) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted py-4">
        <Spinner size="sm" animation="border" />
        Reading {baseName(objectKey)}…
      </div>
    )
  }

  if (error) {
    return (
      <ApiErrorAlert
        error={error}
        profileName={profileName}
        onRetry={() => setAttempt(value => value + 1)}
        retryLabel="Read it again"
      />
    )
  }

  const type = head.type
  const mode = head.recommendedView?.mode
  const proxyUrl =
    mode === 'tab'
      ? s3ObjectUrl({ profileName, authnMode, bucket, key: objectKey, versionId, disposition: 'inline' })
      : null
  // A PDF is framed from the S3 origin; everything else streams through the proxy.
  const mediaUrl = isPdf ? pdfUrl : proxyUrl

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <TypeBadge type={type} />
        <span className="small text-muted">
          {formatBytes(head.object.size)}
          {head.object.lastModified && <> · modified {formatWhen(head.object.lastModified)}</>}
          {head.object.storageClass && head.object.storageClass !== 'STANDARD' && (
            <> · {head.object.storageClass}</>
          )}
        </span>
        {type.storedContentType && type.storedContentType !== type.contentType && (
          <Badge
            bg="secondary-subtle"
            text="secondary-emphasis"
            className="border"
            title={`S3 stores this object as ${type.storedContentType}; the viewer was chosen from the ${
              type.basis === 'signature' ? "file's magic bytes" : 'file name'
            } instead.`}
          >
            stored as {type.storedContentType}
          </Badge>
        )}
        <div className="ms-auto d-flex align-items-center gap-2">
          <Button size="sm" variant="outline-primary" onClick={() => runLinkAction(openInTab)}>
            Open in new tab
          </Button>
          <Dropdown>
            <Dropdown.Toggle size="sm" variant="outline-secondary">
              Presigned link
            </Dropdown.Toggle>
            <Dropdown.Menu align="end">
              <Dropdown.Header className="small">Copy a link valid for…</Dropdown.Header>
              {EXPIRY_CHOICES.map(choice => (
                <Dropdown.Item
                  key={choice.seconds}
                  onClick={() => {
                    setCustomOpen(false)
                    runLinkAction(() => copyLink(choice.seconds))
                  }}
                >
                  {choice.label}
                </Dropdown.Item>
              ))}
              <Dropdown.Divider />
              {/* The presets cover the common cases; "as long as this review call
                  lasts" does not. The form appears below the toolbar rather than
                  inside this menu, so the menu closes normally on every item. */}
              <Dropdown.Item onClick={() => setCustomOpen(true)}>Custom…</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
          <Button size="sm" variant="outline-secondary" onClick={() => runLinkAction(download)}>
            Download
          </Button>
        </div>
      </div>

      {customOpen && (
        <Form
          className="border rounded bg-body-tertiary p-2 mb-2"
          onSubmit={event => {
            event.preventDefault()
            copyCustomLink()
          }}
        >
          <div className="d-flex flex-wrap align-items-center gap-2">
            <span className="small fw-semibold">Link valid for</span>
            <Form.Control
              type="number"
              size="sm"
              min={1}
              max={EXPIRY_UNITS[customUnit].max}
              step={1}
              autoFocus
              value={customValue}
              onChange={event => setCustomValue(event.target.value)}
              isInvalid={!!customValue && customInvalid}
              style={{ width: 100 }}
              aria-label="Custom link lifetime"
            />
            <Form.Select
              size="sm"
              value={customUnit}
              onChange={event => setCustomUnit(event.target.value)}
              style={{ width: 120 }}
              aria-label="Lifetime unit"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </Form.Select>
            <Button size="sm" variant="primary" type="submit" disabled={customInvalid}>
              Copy link
            </Button>
            <Button size="sm" variant="link" className="text-muted" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <span className="small text-muted">
              {customInvalid
                ? `Between 1 minute and 12 hours (${EXPIRY_UNITS[customUnit].max} ${customUnit} max).`
                : `= ${formatLifetime(customSeconds)}`}
            </span>
          </div>
        </Form>
      )}

      <ApiErrorAlert
        error={linkError}
        profileName={profileName}
        onRetry={linkRetry}
        retryLabel="Try the link again"
        onDismiss={() => setLinkError(null)}
        className="small"
      />

      {head.recommendedView?.reason && mode !== 'tab' && (
        <div className="small text-muted mb-2">{head.recommendedView.reason}</div>
      )}
      {linkNote && (
        <Alert variant="info" className="py-2 small" dismissible onClose={() => setLinkNote(null)}>
          {linkNote}
        </Alert>
      )}

      {mode === 'download' ? (
        <Alert variant="secondary" className="mb-0">
          <div>{head.recommendedView.reason}</div>
          <Button size="sm" variant="primary" className="mt-2" onClick={() => runLinkAction(download)}>
            Download {baseName(objectKey)}
          </Button>
        </Alert>
      ) : isPdf && !mediaUrl ? (
        <div className="d-flex align-items-center gap-2 text-muted py-4">
          <Spinner size="sm" animation="border" />
          Preparing the PDF…
        </div>
      ) : (
        <ObjectPreview
          preview={preview}
          type={type}
          object={head.object}
          mediaUrl={mediaUrl}
        />
      )}

      {mode === 'tab' && !standalone && (
        <div className="small text-muted mt-2">
          {isPdf
            ? 'Rendered from a short-lived presigned URL on the S3 origin, so the PDF is isolated from this app.'
            : 'Streaming through SignBridge. “Open in new tab” hands the browser a presigned URL on the S3 origin instead.'}
        </div>
      )}
    </div>
  )
}

/** The same viewer, as a modal over the object browser. */
export default function S3ObjectViewerModal({ show, onHide, profileName, authnMode, bucket, objectKey }) {
  return (
    <Modal show={show} onHide={onHide} size="xl" scrollable centered>
      <Modal.Header closeButton>
        <Modal.Title className="h6 mb-0 text-truncate">
          <span className="text-muted">{bucket}/</span>
          {objectKey}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {show && objectKey && (
          <ObjectViewerBody
            profileName={profileName}
            authnMode={authnMode}
            bucket={bucket}
            objectKey={objectKey}
          />
        )}
      </Modal.Body>
    </Modal>
  )
}
