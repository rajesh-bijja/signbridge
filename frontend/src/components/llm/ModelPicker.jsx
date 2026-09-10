import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Dropdown, Form, Spinner } from 'react-bootstrap'
import { Link } from 'react-router-dom'

import { llmSettings, listLlmModels, selectLlmModel } from '../presignApi'
import { filterModels, formatContextLength, formatModelPricing } from '../../llmProviders'
// Routes live under the app's route prefix; a bare '/settings' hits the
// catch-all and lands on the dashboard instead.
import { appPath } from '../../appConfig'

/**
 * The Cursor-style provider + model chip used by Chat and Sandbox.
 *
 * Two things make it more than a dropdown. It shows *which* model is about to
 * answer, because with a dozen possible providers "the AI" is no longer a single
 * thing and a wrong-model answer is otherwise indistinguishable from a bad one. And
 * a change here persists to the same Settings document the Settings page edits —
 * via selectLlmModel, not local state — so the choice is the same choice
 * everywhere, which is what the feature is for.
 *
 * It deliberately does no configuration: no key fields, no connection tests. If
 * nothing is set up it says so and links to Settings, rather than growing a second
 * half-copy of that page.
 */
function ModelPicker({ onChange, onStatus, disabled = false, size = 'sm', align = 'start' }) {
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState(null)
  const [providers, setProviders] = useState([])
  const [active, setActive] = useState(null)
  const [query, setQuery] = useState('')
  const [providerId, setProviderId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const searchRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const data = await llmSettings()
      setSettings(data.settings || null)
      setProviders(data.providers || [])
      setActive(data.active || null)
      setProviderId(prev => prev || data.settings?.activeProviderId || null)
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Report the resolved selection upward so the caller can send it with the next
  // request — the server would fall back to the stored value anyway, but sending it
  // means a model just chosen applies to the very next message.
  //
  // Through a ref, and depending only on `active`: callers pass an inline arrow, so
  // depending on `onChange` itself would re-fire the effect on every parent render
  // it caused, which is an infinite loop rather than a wasted call.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    if (!onChangeRef.current) return
    onChangeRef.current(active?.ok ? { providerId: active.providerId, model: active.model } : null)
  }, [active])

  // Separately, report *why* there is no selection, so the caller can say so
  // before the user types rather than after a turn fails. A provider key is the
  // one thing the user must supply themselves — there is no environment variable
  // or config file that can supply it for them — so "nothing is configured" is
  // worth stating up front. Gated on `loading` so a slow settings fetch does not
  // flash a warning at someone who is fully set up.
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  useEffect(() => {
    if (!onStatusRef.current || loading) return
    onStatusRef.current({
      ok: !!active?.ok,
      needsSetup: !active?.ok,
      reason: active?.reason || null,
      message: active?.message || ''
    })
  }, [active, loading])

  // Only providers that can actually answer: a verified key, and not a row that
  // declares it does no inference. A provider answered by a local backend (Cursor)
  // belongs here — deliberately even when its last preflight found no CLI, because
  // `backendStatus` is only as fresh as the last Test connection and hiding a
  // provider the user has since installed is worse than a turn that fails with an
  // actionable 503.
  const usableProviders = useMemo(
    () =>
      providers.filter(
        p => p.inference !== false && settings?.providers?.[p.id]?.verifiedOk
      ),
    [providers, settings]
  )

  const shownProviderId = providerId || active?.providerId || usableProviders[0]?.id || null
  const shownConfig = settings?.providers?.[shownProviderId]
  // Ids the user typed in Settings are merged in here rather than kept in a section
  // of their own: by the time a model is remembered it is just a model, and a
  // two-section dropdown over a search box is more structure than this chip needs.
  const models = useMemo(() => {
    const listed = shownConfig?.models || []
    const seen = new Set(listed.map(m => m.id))
    const custom = (shownConfig?.customModels || [])
      .filter(id => !seen.has(id))
      .map(id => ({ id, label: id }))
    return custom.concat(listed)
  }, [shownConfig])
  const filtered = useMemo(() => filterModels(models, query), [models, query])
  // A model id can be typed straight into the search box, because for credentials
  // that cannot list models (a Bedrock role with InvokeModel and no List*) searching
  // a four-entry fallback list is not how the user reaches the model they want.
  const typedId = query.trim()
  const offerTypedId = !!typedId && !models.some(m => m.id === typedId)

  const handleSelect = async modelId => {
    if (!shownProviderId || !modelId) return
    setBusy(true)
    setError(null)
    try {
      const data = await selectLlmModel(shownProviderId, modelId)
      if (data?.settings) setSettings(data.settings)
      // Re-read rather than assuming: resolveActive is the server's decision, and
      // this chip's whole job is to show what will really be used.
      await load()
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not switch model')
    } finally {
      setBusy(false)
    }
  }

  const handleRefresh = async () => {
    if (!shownProviderId) return
    setBusy(true)
    setError(null)
    try {
      const data = await listLlmModels(shownProviderId)
      if (data?.success && data.settings) setSettings(data.settings)
      else if (data && !data.success) setError(data.message)
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <Button variant="outline-secondary" size={size} disabled>
        <Spinner animation="border" size="sm" className="me-1" /> Model
      </Button>
    )
  }

  // Nothing configured: a link, not a disabled control with no explanation.
  if (!active?.ok && !usableProviders.length) {
    return (
      <Button
        as={Link}
        to={appPath('/settings')}
        variant="outline-warning"
        size={size}
        title={active?.message || 'No AI provider is connected yet'}
      >
        Set up AI provider
      </Button>
    )
  }

  const label = active?.ok
    ? `${active.providerLabel} · ${active.model}`
    : 'Choose a model'

  // Which identity is answering. Only shown for a provider signed with an AWS
  // profile, where it is the single most important fact about the turn — the same
  // model id answers as a different IAM role depending on this, and nothing else
  // in the chat UI would say which.
  const credentialNote = active?.ok && active.credentialSource === 'aws_profile'
    ? `Signing as ${active.awsProfileName}${active.awsRegion ? ` in ${active.awsRegion}` : ''}`
    : null

  return (
    <Dropdown
      align={align}
      onToggle={open => {
        if (open) {
          setQuery('')
          setTimeout(() => searchRef.current?.focus(), 0)
        }
      }}
    >
      <Dropdown.Toggle
        variant="outline-secondary"
        size={size}
        disabled={disabled}
        title={credentialNote || 'Change the provider or model'}
      >
        {busy ? <Spinner animation="border" size="sm" className="me-1" /> : null}
        {label}
      </Dropdown.Toggle>

      <Dropdown.Menu style={{ minWidth: '22rem', maxWidth: '30rem' }}>
        {usableProviders.length > 1 && (
          <div className="px-3 pt-2 pb-1">
            <Form.Select
              size="sm"
              value={shownProviderId || ''}
              onChange={e => {
                setProviderId(e.target.value)
                setQuery('')
              }}
            >
              {usableProviders.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Form.Select>
          </div>
        )}

        <div className="px-3 pb-2 pt-1 d-flex gap-2 align-items-center">
          <Form.Control
            ref={searchRef}
            size="sm"
            type="search"
            placeholder="Search models, or type a model id…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            // The menu closes on any keystroke it treats as a shortcut otherwise.
            onKeyDown={e => e.stopPropagation()}
          />
          <Button
            variant="outline-secondary"
            size="sm"
            onClick={handleRefresh}
            disabled={busy}
            title="Refresh the model list"
          >
            ↻
          </Button>
        </div>

        {error && <div className="px-3 pb-2 small text-danger">{error}</div>}

        <div style={{ maxHeight: '18rem', overflowY: 'auto' }}>
          {offerTypedId && (
            <Dropdown.Item
              onClick={() => handleSelect(typedId)}
              className="d-flex flex-column align-items-start"
            >
              <span className="text-truncate">Use &ldquo;{typedId}&rdquo;</span>
              <small className="text-muted">A model id not in this list</small>
            </Dropdown.Item>
          )}
          {!filtered.length && !offerTypedId && (
            <div className="px-3 py-2 small text-muted">
              {models.length ? 'No model matches that search.' : 'No models available for this key.'}
            </div>
          )}
          {filtered.map(model => {
            const isActive =
              active?.ok && active.providerId === shownProviderId && active.model === model.id
            const meta = [formatContextLength(model.contextLength), formatModelPricing(model.pricing)]
              .filter(Boolean)
              .join(' · ')
            return (
              <Dropdown.Item
                key={model.id}
                active={isActive}
                onClick={() => handleSelect(model.id)}
                className="d-flex flex-column align-items-start"
              >
                <div className="d-flex w-100 justify-content-between align-items-center gap-2">
                  <span className="text-truncate">{model.label || model.id}</span>
                  {isActive && <Badge bg="success">in use</Badge>}
                </div>
                {meta && <small className="text-muted">{meta}</small>}
              </Dropdown.Item>
            )
          })}
        </div>

        <Dropdown.Divider />
        <Dropdown.Item as={Link} to={appPath('/settings')} className="small">
          Manage providers &amp; keys in Settings
        </Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown>
  )
}

export default ModelPicker
