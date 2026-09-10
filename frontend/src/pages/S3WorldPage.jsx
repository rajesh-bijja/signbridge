import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Badge, Button, Card, Form, InputGroup, Spinner, Table } from 'react-bootstrap'

import S3BucketList, { matchName } from '../components/s3/S3BucketList.jsx'
import S3ObjectBrowser from '../components/s3/S3ObjectBrowser.jsx'
import { populateProfilesDetails } from '../components/presignApi'
import { AWS_MODES, AUTHN_SHORT_LABELS as MODE_LABELS } from '../authnModes'

/**
 * S3 World — browse S3, and actually see what is in it.
 *
 * Three screens, one URL. Which one you get depends on how much has been chosen:
 * a profile, then a bucket, then a prefix. All of it lives in the query string
 * (`?profile=&authnMode=&bucket=&prefix=`), so a folder deep inside a bucket is a
 * link you can send to someone, and Back does what Back should do.
 *
 * Only AWS profiles appear in the picker: S3 World signs S3 calls, and a Basic
 * Auth or bearer-token profile has nothing to sign them with.
 */

/** Only profiles that can sign an AWS request, and only their AWS mechanisms. */
function awsProfiles(profiles) {
  return profiles
    .map(profile => ({
      profileName: profile.profileName,
      modes: (profile.supportedAuthnMechanisms || []).filter(mode => AWS_MODES.includes(mode)),
      region: profile.region || profile.awsRegion || null
    }))
    .filter(profile => profile.modes.length)
}

function ProfileGate({ profiles, loading, error, onChoose, onReload }) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return profiles
    return profiles
      .map(profile => ({ profile, score: matchName(profile.profileName, query) }))
      .filter(entry => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.profile)
  }, [profiles, query])

  if (loading) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted py-4">
        <Spinner size="sm" animation="border" />
        Loading profiles…
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="danger">
        <div>{error}</div>
        <Button size="sm" variant="outline-danger" className="mt-2" onClick={onReload}>
          Try again
        </Button>
      </Alert>
    )
  }

  if (!profiles.length) {
    return (
      <Alert variant="warning">
        No AWS profile is configured. S3 World needs an <strong>AWS IAM User</strong> or{' '}
        <strong>AWS SSO / IAM Identity Center</strong> profile — add one on the Profiles page, or
        mount <span className="font-monospace">~/.aws</span> so your existing profiles import
        automatically.
      </Alert>
    )
  }

  return (
    <Card>
      <Card.Body>
        <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
          <div>
            <div className="fw-semibold">Choose a profile</div>
            <div className="small text-muted">
              Buckets, listings and object reads are all signed with this profile’s credentials.
            </div>
          </div>
          <div className="ms-auto">
            <InputGroup size="sm" style={{ width: 260 }}>
              <Form.Control
                autoFocus
                placeholder="Filter profiles"
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
              {query && (
                <Button variant="outline-secondary" onClick={() => setQuery('')}>
                  ✕
                </Button>
              )}
            </InputGroup>
          </div>
        </div>

        <div className="border rounded">
          <Table hover size="sm" className="mb-0 align-middle">
            <tbody>
              {filtered.map(profile => (
                <tr key={profile.profileName}>
                  <td>
                    <span className="font-monospace">{profile.profileName}</span>
                    {profile.region && (
                      <Badge bg="light" text="dark" className="border fw-normal ms-2">
                        {profile.region}
                      </Badge>
                    )}
                  </td>
                  <td className="text-end">
                    {/* One button per AWS mechanism the profile offers, so a
                        profile that has both is a single click either way rather
                        than a second dropdown. */}
                    <div className="d-flex gap-2 justify-content-end">
                      {profile.modes.map(mode => (
                        <Button
                          key={mode}
                          size="sm"
                          variant="outline-primary"
                          onClick={() => onChoose(profile.profileName, mode)}
                        >
                          {MODE_LABELS[mode] || mode}
                        </Button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td className="text-center text-muted py-4">No profile name matches that.</td>
                </tr>
              )}
            </tbody>
          </Table>
        </div>
      </Card.Body>
    </Card>
  )
}

export default function S3WorldPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const profileName = searchParams.get('profile') || ''
  const authnMode = searchParams.get('authnMode') || ''
  const bucket = searchParams.get('bucket') || ''
  const prefix = searchParams.get('prefix') || ''

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await populateProfilesDetails()
      setProfiles(awsProfiles(Array.isArray(data) ? data : []))
    } catch (e) {
      setError(e.response?.data?.message || e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // A profile named in the URL only counts if it still exists and still offers
  // the mechanism asked for: a stale link must not start signing with something
  // else, or with nothing.
  const resolved = useMemo(() => {
    if (!profileName) return null
    const match = profiles.find(entry => entry.profileName === profileName)
    if (!match) return null
    const mode = match.modes.includes(authnMode) ? authnMode : match.modes[0]
    return { profileName: match.profileName, authnMode: mode }
  }, [profiles, profileName, authnMode])

  const update = useCallback(
    (next, { replace = false } = {}) => {
      const params = new URLSearchParams(searchParams)
      Object.entries(next).forEach(([key, value]) => {
        if (value) params.set(key, value)
        else params.delete(key)
      })
      setSearchParams(params, { replace })
    },
    [searchParams, setSearchParams]
  )

  const chooseProfile = (name, mode) =>
    update({ profile: name, authnMode: mode, bucket: '', prefix: '' })

  // Each navigation is a real history entry, so the browser Back button walks
  // back up the folder tree.
  const openBucket = name => update({ bucket: name, prefix: '' })
  const navigate = nextPrefix => update({ prefix: nextPrefix })
  const leaveBucket = () => update({ bucket: '', prefix: '' })

  return (
    <div className="pb-4">
      <div className="d-flex flex-wrap align-items-baseline gap-2 mb-3">
        <h4 className="mb-0">S3 World</h4>
        <span className="text-muted small">
          Browse buckets, search a whole subtree, and view an object’s contents in the browser —
          parquet, spreadsheets, gzipped logs, archives and images included.
        </span>
        {resolved && (
          <div className="ms-auto d-flex align-items-center gap-2">
            <Badge bg="success" className="fw-normal">
              {resolved.profileName} · {MODE_LABELS[resolved.authnMode] || resolved.authnMode}
            </Badge>
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => update({ profile: '', authnMode: '', bucket: '', prefix: '' })}
            >
              Change profile
            </Button>
          </div>
        )}
      </div>

      {!resolved && (
        <ProfileGate
          profiles={profiles}
          loading={loading}
          error={error}
          onChoose={chooseProfile}
          onReload={load}
        />
      )}

      {resolved && !bucket && (
        <S3BucketList
          key={`${resolved.profileName}:${resolved.authnMode}`}
          profileName={resolved.profileName}
          authnMode={resolved.authnMode}
          onOpenBucket={openBucket}
        />
      )}

      {resolved && bucket && (
        <S3ObjectBrowser
          key={`${resolved.profileName}:${resolved.authnMode}:${bucket}`}
          profileName={resolved.profileName}
          authnMode={resolved.authnMode}
          bucket={bucket}
          prefix={prefix}
          onNavigate={navigate}
          onLeaveBucket={leaveBucket}
        />
      )}
    </div>
  )
}
