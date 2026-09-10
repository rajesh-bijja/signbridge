import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Form, InputGroup, Spinner, Table } from 'react-bootstrap'

import { s3BucketRegion, s3ListBuckets } from '../presignApi'
import ApiErrorAlert from '../ApiErrorAlert.jsx'
import { formatWhen } from './objectViewers.jsx'
import Pager from './Pager.jsx'

/**
 * The bucket list.
 *
 * ListBuckets has no server-side paging or filtering — S3 returns the whole
 * account in one response — so both happen here, where they are instant. That is
 * also why the filter can afford to be forgiving: matching every term anywhere in
 * the name, case-insensitively, costs nothing when the list is already in memory.
 *
 * Regions arrive with the listing — ListBuckets reports `BucketRegion` per bucket
 * as long as the request asks for a page size, which s3Client always does. The
 * lazy per-bucket GetBucketLocation below is now only a fallback, for an
 * S3-compatible endpoint that omits the field.
 */

const PAGE_SIZES = [10, 25, 50, 100]

/**
 * Match a bucket name the way a person means it: every term must appear
 * somewhere, case doesn't matter, and `*`/`?` work if you reach for them.
 * Returns a score so exact and prefix matches float to the top.
 */
export function matchName(name, query) {
  const haystack = String(name).toLowerCase()
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!terms.length) return 0

  let score = 0
  for (const term of terms) {
    if (term.includes('*') || term.includes('?')) {
      const pattern = new RegExp(
        `^${term.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`
      )
      if (!pattern.test(haystack)) return -1
      score += 5
      continue
    }
    const at = haystack.indexOf(term)
    if (at === -1) return -1
    // Exact name beats a prefix beats a match in the middle.
    if (haystack === term) score += 100
    else if (at === 0) score += 20
    else score += 10 - Math.min(9, at / 10)
  }
  return score
}

export default function S3BucketList({ profileName, authnMode, onOpenBucket }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [buckets, setBuckets] = useState([])
  const [owner, setOwner] = useState(null)
  const [query, setQuery] = useState('')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(0)
  const [regions, setRegions] = useState({})
  const [resolvingRegions, setResolvingRegions] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await s3ListBuckets(profileName, authnMode)
      setBuckets(data.buckets || [])
      setOwner(data.owner || null)
      // Any regions the server already knew (it caches them; buckets never move).
      const known = {}
      ;(data.buckets || []).forEach(bucket => {
        if (bucket.region) known[bucket.name] = bucket.region
      })
      setRegions(previous => ({ ...known, ...previous }))
    } catch (e) {
      setError(e.response?.data || { message: e.message })
    } finally {
      setLoading(false)
    }
  }, [profileName, authnMode])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    if (!query.trim()) return buckets
    return buckets
      .map(bucket => ({ bucket, score: matchName(bucket.name, query) }))
      .filter(entry => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.bucket)
  }, [buckets, query])

  useEffect(() => {
    setPage(0)
  }, [query, pageSize])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = filtered.slice(page * pageSize, page * pageSize + pageSize)

  // Named because the pager is rendered twice; both instances drive the same state.
  const previousPage = () => setPage(value => Math.max(0, value - 1))
  const nextPage = () => setPage(value => Math.min(pageCount - 1, value + 1))

  // Normally zero: the listing carries every region. Anything left is a bucket
  // whose endpoint didn't report one, and only those get the fallback call.
  const unresolved = current.filter(bucket => !regions[bucket.name])

  /** Resolve the regions for the buckets currently on screen, and only those. */
  const resolveVisibleRegions = useCallback(async () => {
    setResolvingRegions(true)
    for (const bucket of current) {
      if (regions[bucket.name]) continue
      try {
        const result = await s3BucketRegion(profileName, authnMode, bucket.name)
        setRegions(previous => ({ ...previous, [bucket.name]: result.region }))
      } catch {
        // GetBucketLocation is commonly denied by policy even when reading the
        // bucket is allowed. Not knowing the region is not an error here.
        setRegions(previous => ({ ...previous, [bucket.name]: '—' }))
      }
    }
    setResolvingRegions(false)
  }, [current, regions, profileName, authnMode])

  if (loading) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted py-4">
        <Spinner size="sm" animation="border" />
        Listing buckets for {profileName}…
      </div>
    )
  }

  if (error) {
    return <ApiErrorAlert error={error} profileName={profileName} onRetry={load} />
  }

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <InputGroup size="sm" style={{ maxWidth: 360 }}>
          <InputGroup.Text>Find a bucket</InputGroup.Text>
          <Form.Control
            autoFocus
            placeholder="any part of the name"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          {query && (
            <Button variant="outline-secondary" onClick={() => setQuery('')}>
              ✕
            </Button>
          )}
        </InputGroup>
        <span className="small text-muted">
          {query.trim()
            ? `${filtered.length} of ${buckets.length} buckets match`
            : `${buckets.length} buckets`}
          {owner && <> · owner {owner}</>}
        </span>
        <div className="ms-auto d-flex align-items-center gap-2">
          {unresolved.length > 0 && (
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={resolveVisibleRegions}
              disabled={resolvingRegions}
              title="This endpoint did not report a region for every bucket. Ask it per bucket instead."
            >
              {resolvingRegions
                ? 'Resolving regions…'
                : `Resolve ${unresolved.length} region${unresolved.length === 1 ? '' : 's'}`}
            </Button>
          )}
          <Button size="sm" variant="outline-secondary" onClick={load}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Paging, above the table as well as below it — see Pager.jsx. */}
      <Pager
        className="mb-2"
        summary={`Page ${page + 1} of ${pageCount}`}
        onPrevious={previousPage}
        onNext={nextPage}
        disablePrevious={page === 0}
        disableNext={page + 1 >= pageCount}
      />

      <div className="border rounded">
        <Table hover size="sm" className="mb-0 align-middle">
          <thead className="table-light">
            <tr>
              <th>Bucket</th>
              <th style={{ width: 180 }}>Region</th>
              <th style={{ width: 220 }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {current.map(bucket => (
              <tr
                key={bucket.name}
                style={{ cursor: 'pointer' }}
                onClick={() => onOpenBucket(bucket.name)}
              >
                <td>
                  <span aria-hidden="true" className="me-2">
                    🪣
                  </span>
                  <span className="font-monospace">{bucket.name}</span>
                </td>
                <td>
                  {regions[bucket.name] ? (
                    <Badge bg="light" text="dark" className="border font-monospace fw-normal">
                      {regions[bucket.name]}
                    </Badge>
                  ) : (
                    <span
                      className="text-muted small"
                      title="S3 did not report this bucket's region in the listing."
                    >
                      unknown
                    </span>
                  )}
                </td>
                <td className="small text-muted">{formatWhen(bucket.creationDate)}</td>
              </tr>
            ))}
            {!current.length && (
              <tr>
                <td colSpan={3} className="text-center text-muted py-4">
                  {buckets.length
                    ? 'No bucket name matches that.'
                    : 'This profile cannot see any buckets.'}
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>

      <Pager
        className="mt-2"
        summary={`Page ${page + 1} of ${pageCount}`}
        onPrevious={previousPage}
        onNext={nextPage}
        disablePrevious={page === 0}
        disableNext={page + 1 >= pageCount}
        pageSize={pageSize}
        pageSizes={PAGE_SIZES}
        onPageSize={setPageSize}
      />
    </div>
  )
}
