export function isS3Endpoint(endpoint) {
  if (!endpoint) return false
  try {
    const url = new URL(endpoint)
    const host = url.hostname.toLowerCase()
    return (
      host.includes('.s3.') ||
      host.startsWith('s3.') ||
      host.endsWith('.s3.amazonaws.com') ||
      host === 's3.amazonaws.com'
    )
  } catch {
    return String(endpoint).toLowerCase().includes('s3.')
  }
}

export function extractPresignedUrl(value) {
  if (!value) return null
  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value
    }
    const hrefMatch = value.match(/href=(https?:\/\/[^\s>"']+)/)
    if (hrefMatch) {
      return hrefMatch[1]
    }
  }
  return null
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Some invocations succeed at the HTTP layer (200) but carry an actionable
// application-level status in the body — most notably the AWS SSO device-code
// flow, which returns { statusCode: 401, headers: { verificationUriComplete },
// response: { message: <html blob> } }. The user must approve that verification
// URL. Detect that case and build our own sanitized, clickable link instead of
// trusting (and escaping) the server's raw HTML string.
// The device-approval URL out of any of the shapes the backend returns it in, or
// null when this response is not a pending authorization. Exported because the
// dashboard needs the bare URL for its Authorize button, not just the rendered
// text — and the detection rule must not drift between the two.
// The profile sub-forms (EC2, IRSA) and the discovery endpoints don't speak the
// presign/invoke envelope above: they answer a flat
// `{ success:false, message, verificationUriComplete? }`, sometimes as an axios
// rejection instead of a 200 body. describeError() normalises all of those into
// one shape so a caller never has to dig through `err.response.data` again.
//
// `authUrl` is only set when this really is a pending authorization, because it
// drives an "Authorize" button: a URL that happens to appear in some other error
// (a cluster endpoint, say) must be clickable but must NOT be offered as
// something to approve. So an explicit verificationUriComplete counts, and a bare
// URL in the text counts only when the text is talking about authorization.
const AUTH_TEXT = /authoriz|approve this sso session|aws sso login|device/i

export function describeError(err, fallback) {
  const data = (err && err.response && err.response.data) || null
  const source = data && typeof data === 'object' ? data : err && typeof err === 'object' ? err : {}
  const message =
    (typeof err === 'string' ? err : null) ||
    source.message ||
    (err && err.message) ||
    fallback ||
    'The request failed.'
  const explicit = source.verificationUriComplete || null
  const scraped = firstUrlIn(message)
  return {
    message: String(message),
    // Every URL in the text becomes a link; only some of them are approvable.
    url: explicit || scraped || null,
    authUrl: explicit || (scraped && AUTH_TEXT.test(message) ? scraped : null),
    statusCode: source.statusCode || (err && err.response && err.response.status) || null
  }
}

// Trailing punctuation is the trap here: "…approve at https://x/y?code=A-B, then"
// must not swallow the comma, or the link 404s.
export function firstUrlIn(text) {
  if (!text || typeof text !== 'string') return null
  const match = text.match(/https?:\/\/[^\s<>"']+/)
  if (!match) return null
  return match[0].replace(/[.,;:)\]}]+$/, '')
}

// Split a message around a URL so it can be rendered as text + link + text
// without dangerouslySetInnerHTML. Returns [before, url, after]; `url` is null
// when the message contains none.
export function splitAroundUrl(text, url) {
  const value = text == null ? '' : String(text)
  if (!url) return [value, null, '']
  const at = value.indexOf(url)
  if (at < 0) return [value, null, '']
  return [value.slice(0, at), url, value.slice(at + url.length)]
}

export function extractPendingAuthUrl(result) {
  if (!result || typeof result !== 'object') return null
  if (result.statusCode !== 401) return null
  return (
    result?.headers?.verificationUriComplete ||
    result?.verificationUriComplete ||
    extractPresignedUrl(result?.response?.message) ||
    extractPresignedUrl(result?.message) ||
    null
  )
}

export function formatPendingAuthResponse(result) {
  if (!result || typeof result !== 'object') return null

  const verificationUrl = extractPendingAuthUrl(result)

  if (verificationUrl) {
    const safeUrl = escapeHtml(verificationUrl)
    return {
      text:
        'Authorization pending. Approve the device code at:\n' +
        `${verificationUrl}\n` +
        'Then use the Retry button above — no need to reload the page.',
      html:
        '<p><strong>Authorization pending.</strong> Your AWS session needs approval. ' +
        'Approve the device code at the link below, then use the Retry button above.</p>' +
        `<p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a></p>`,
      raw: result
    }
  }

  return null
}

// Kept as an alias for the error/catch path; the backend currently returns the
// pending-auth case as HTTP 200 with a 401 body, but a real HTTP error carrying
// the same shape is handled identically.
export function formatErrorResponse(data) {
  return formatPendingAuthResponse(data)
}

// options.presignHasBody — true when the presigned request is a body-bearing
// (non-GET) call. Such a URL is NOT usable on its own (AWS query-protocol APIs
// like EC2 need the signed body, else they fail with "action missing"), so we
// intentionally do NOT render a clickable link — the "Copy Request as Curl"
// button provides the complete, runnable request instead.
export function formatApiResponse(result, options = {}) {
  const pendingAuth = formatPendingAuthResponse(result)
  if (pendingAuth) {
    return pendingAuth
  }

  const presignedRaw = result?.response?.preSignedUrl
  const presignedUrl = extractPresignedUrl(presignedRaw)
  if (presignedUrl) {
    if (options.presignHasBody) {
      return {
        text:
          'Presigned URL generated. This request has a body, so the raw URL ' +
          "alone won't work — use the \"Copy Request as Curl\" button to get " +
          'the complete, runnable request.',
        html: null,
        raw: result
      }
    }
    // GET / bodyless presign: the URL is self-contained, so show it as a single
    // clickable link (no duplicated plain-text copy below it).
    return {
      text: '',
      html: `<p><strong>Presigned URL:</strong> <a href="${presignedUrl}" target="_blank" rel="noopener noreferrer">${presignedUrl}</a></p>`,
      raw: result
    }
  }
  return {
    text: JSON.stringify(result, null, 2),
    html: null,
    raw: result
  }
}

export function buildAwsHeaders(endpoint, method, contentType, customContentType, customHeaders) {
  const headersObj = {}
  const isS3 = isS3Endpoint(endpoint)
  const isGet = (method || 'GET').toUpperCase() === 'GET'

  if (!(isS3 && isGet)) {
    if (contentType === 'custom' && customContentType) {
      headersObj['Content-Type'] = customContentType.toLowerCase()
    } else if (contentType && contentType !== 'Select Content-Type') {
      headersObj['Content-Type'] = contentType
    }
  }

  ;(customHeaders || []).forEach(header => {
    if (!header.key || !header.value) return
    const lowerKey = header.key.toLowerCase()
    if (isS3 && lowerKey === 'x-amz-target') return
    headersObj[header.key] = header.value
  })

  return headersObj
}
