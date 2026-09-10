import { Alert, Button } from 'react-bootstrap'

/**
 * The one error surface for the Bootstrap-styled parts of the app (S3 World and
 * Sandbox), because every failure that matters here has the same two useful
 * answers: do the thing the message asks for, then try again.
 *
 * The Retry is what makes it worth sharing. An expired SSO session fails with
 * "approve this SSO session at <url>, then come back and retry your operation" —
 * and without a button, "come back" meant reloading the browser, which throws
 * away the folder you had drilled into, the search you had run and the objects
 * you had selected. Authorize opens in a new tab; Retry re-runs the exact
 * operation that failed, in place.
 *
 * `error` is the server's error payload (`{ message, ssoSessionExpired,
 * verificationUriComplete }`) or a bare string. `onRetry` should re-run that
 * operation, not just reload the page.
 *
 * The dashboard deliberately does NOT use this component: it is a Cloudscape
 * surface, and a Bootstrap alert dropped into it looks like a bug. It renders
 * the same two buttons through Cloudscape's own Alert `action` slot.
 */
export default function ApiErrorAlert({
  error,
  profileName,
  onRetry,
  onDismiss,
  retryLabel = 'Retry',
  variant,
  className = ''
}) {
  if (!error) return null
  const payload = typeof error === 'string' ? { message: error } : error

  // Present only while a device authorization is still waiting to be approved.
  const authorizeUrl = payload.verificationUriComplete

  return (
    <Alert
      // A pending authorization is not a failure — it is a step the user has
      // still to take, so it reads as a warning rather than an error.
      variant={variant || (authorizeUrl ? 'warning' : 'danger')}
      className={`py-2 ${className}`}
      dismissible={!!onDismiss}
      onClose={onDismiss}
    >
      <div>{payload.message}</div>
      {payload.ssoSessionExpired && (
        <div className="small mt-1 font-monospace">aws sso login --profile {profileName}</div>
      )}
      <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
        {authorizeUrl && (
          <Button size="sm" variant="warning" href={authorizeUrl} target="_blank" rel="noreferrer">
            Authorize this SSO session ↗
          </Button>
        )}
        {onRetry && (
          <Button size="sm" variant={authorizeUrl ? 'outline-dark' : 'danger'} onClick={onRetry}>
            ↻ {retryLabel}
          </Button>
        )}
        {authorizeUrl && onRetry && (
          <span className="small text-muted">
            Approve it in the new tab, then Retry — no need to reload this page.
          </span>
        )}
      </div>
    </Alert>
  )
}
