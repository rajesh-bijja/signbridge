// Turn a request description into a runnable curl command string.
//
// SignBridge's "Copy as curl" shares the exact request with a teammate for
// debugging/triaging. We keep the formatting POSIX-shell-safe (single-quote
// every value, escaping embedded single quotes the standard '\'' way) so the
// command pastes and runs as-is.

// Single-quote a value for POSIX shells: wrap in '...', and turn any embedded
// ' into '\'' (close quote, escaped quote, reopen quote).
function shellQuote(value) {
  const s = String(value == null ? '' : value)
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// Build a curl command from { method, url, headers, body }.
//   - headers: plain object of header name -> value (optional)
//   - body: string (optional). Sent with --data-raw to preserve it verbatim.
// AWS presigned URLs already carry the signature in the query string, so a bare
// GET needs no headers; a non-GET presigned URL still needs its body supplied.
export function buildCurlCommand({ method = 'GET', url, headers = {}, body = null }) {
  const upper = (method || 'GET').toUpperCase()
  const parts = ['curl']
  if (upper !== 'GET') {
    parts.push('-X', upper)
  }
  parts.push(shellQuote(url))

  Object.keys(headers || {}).forEach(key => {
    const value = headers[key]
    if (value === undefined || value === null || value === '') return
    parts.push('-H', shellQuote(`${key}: ${value}`))
  })

  if (body != null && String(body).length > 0) {
    parts.push('--data-raw', shellQuote(body))
  }

  // Emit as a single-line command with backslash-newline continuations so it is
  // both copy-paste runnable and readable when it has several headers.
  return parts.reduce((acc, token, idx) => {
    if (idx === 0) return token
    // Keep flags attached to their value on the same line for readability.
    const prev = parts[idx - 1]
    const startsNewFlag = token === '-H' || token === '-X' || token === '--data-raw'
    if (startsNewFlag) {
      return acc + ' \\\n  ' + token
    }
    return acc + ' ' + token
  }, '')
}
