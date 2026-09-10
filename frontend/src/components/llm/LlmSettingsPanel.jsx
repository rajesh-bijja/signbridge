import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Autosuggest,
  Badge,
  Box,
  Button,
  Container,
  FormField,
  Header,
  Input,
  Link,
  Select,
  SegmentedControl,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Tiles,
  Toggle,
  TokenGroup
} from '@cloudscape-design/components'

import * as presignApi from '../presignApi'
import {
  ACQUISITION_SUMMARY,
  formatContextLength,
  formatModelPricing,
  sortProviders
} from '../../llmProviders'
import { awsModesOf, authnShortLabel } from '../../authnModes'

// Mirrors lib/llm/providers.js CREDENTIAL_SOURCE.
const AWS_PROFILE = 'aws_profile'
const API_KEY = 'api_key'

// Regions Bedrock is generally available in, as suggestions rather than a closed
// list — the field stays free text because Bedrock adds regions and a stale list
// would block a user from the one they have model access in.
const REGION_SUGGESTIONS = [
  'us-east-1', 'us-east-2', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-3',
  'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ca-central-1'
]

// "Configured" is not the same as "has a key": a provider signing with an AWS
// profile never has one, and reading its badge as unconfigured forever is worse
// than no badge at all.
function isConfigured(config) {
  if (!config) return false
  if (config.credentialSource === AWS_PROFILE) return !!config.awsProfileName
  return !!config.hasKey
}

function providerStatus(config) {
  if (!isConfigured(config)) return null
  if (config.verifiedOk) return { type: 'success', text: 'Verified' }
  if (config.verifiedError) return { type: 'error', text: 'Not verified' }
  return { type: 'pending', text: 'Not tested' }
}

// The one-line answer to "what am I signing up for?" on a tile. A provider with a
// chatBackend is set up like the others (paste a key) but *answers* differently —
// through a CLI that has to exist on this server — and that is worth knowing
// before clicking, not after the first chat turn fails.
function tileDescription(p) {
  if (p.inference === false) return 'Not usable for chat'
  // A provider that can sign with credentials already in SignBridge is set up in a
  // materially different way from one that needs a key, and that is the single most
  // useful thing to know before clicking the tile.
  if ((p.credentialSources || []).includes(AWS_PROFILE)) {
    return 'Sign with an AWS profile you already have here, or paste an API key'
  }
  const acquisition = ACQUISITION_SUMMARY[p.acquisition] || ''
  if (!p.chatBackend) return acquisition
  return [acquisition, `answers through the ${p.label} CLI on this server`]
    .filter(Boolean)
    .join(' · ')
}

function modelOption(model) {
  const meta = [formatContextLength(model.contextLength), formatModelPricing(model.pricing)]
    .filter(Boolean)
    .join(' · ')
  return {
    value: model.id,
    label: model.label || model.id,
    description: meta || (model.id !== (model.label || model.id) ? model.id : undefined)
  }
}

/**
 * The "Enable LLM" panel on the Settings page.
 *
 * Saves immediately rather than through the page's Save button, and that is
 * deliberate: testing a key and picking a model are each a round trip to the
 * provider whose result has to be stored to be useful. A staged form would mean
 * "your key verified — now press Save or lose it".
 *
 * Every provider is set up the same way, and the card says so in as many words:
 * paste a key you have (option 1), or open the provider's console, create one
 * there and come back (option 2). There is no third path where SignBridge
 * obtains the key for you — that existed for two providers and was removed
 * (see lib/llm/providers.js) because it made this one screen behave differently
 * depending on which tile you clicked, and put a credential that can create
 * more credentials through our hands for no benefit.
 *
 * Switching provider changes only which one answers. Keys already stored for
 * other providers stay stored, so going back to one is a click, not a re-entry.
 */
function LlmSettingsPanel() {
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState(null)
  const [providers, setProviders] = useState([])
  const [active, setActive] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const [selectedId, setSelectedId] = useState(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  // `null` means "not being edited", in which case the model field mirrors whatever
  // model is actually active. Tracking it that way rather than syncing a string on
  // every load keeps the field honest with no effect to get wrong: typing shows the
  // user's text, and applying (or abandoning) a choice goes back to mirroring.
  const [modelQuery, setModelQuery] = useState(null)
  const [busy, setBusy] = useState('')

  // Only used by a provider that can sign with an AWS profile (Bedrock). The
  // profile list is the same one the dashboard and S3 World use, so a profile only
  // has to be set up once for signing, browsing and inference.
  const [sourceDraft, setSourceDraft] = useState(API_KEY)
  const [profileDraft, setProfileDraft] = useState('')
  const [modeDraft, setModeDraft] = useState('')
  const [regionDraft, setRegionDraft] = useState('')
  const [awsProfiles, setAwsProfiles] = useState([])
  const [profilesError, setProfilesError] = useState(null)

  const applyResponse = useCallback(data => {
    if (data && data.settings) setSettings(data.settings)
    if (data && data.providers) setProviders(sortProviders(data.providers))
    if (data && data.active) setActive(data.active)
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await presignApi.llmSettings()
      applyResponse(data)
      // Land on whatever is in use, so the panel opens on the thing the user most
      // likely came to change.
      setSelectedId(prev => prev || (data.settings && data.settings.activeProviderId) || null)
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load the LLM settings')
    } finally {
      setLoading(false)
    }
  }, [applyResponse])

  useEffect(() => {
    load()
  }, [load])

  // Fetched once, not per provider: it is a small local read, and having the list
  // already there is what makes the profile source feel like picking rather than
  // configuring. A failure here is reported in place — it must not stop the rest of
  // the panel, since every other provider works without it.
  useEffect(() => {
    let cancelled = false
    presignApi
      .populateProfilesDetails()
      .then(data => {
        if (cancelled) return
        const rows = (Array.isArray(data) ? data : [])
          .map(profile => ({ profileName: profile.profileName, modes: awsModesOf(profile) }))
          .filter(entry => entry.profileName && entry.modes.length)
        setAwsProfiles(rows)
      })
      .catch(err => {
        if (!cancelled) setProfilesError(err.response?.data?.message || err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const provider = useMemo(
    () => providers.find(p => p.id === selectedId) || null,
    [providers, selectedId]
  )
  const config = useMemo(
    () => (settings && selectedId && settings.providers ? settings.providers[selectedId] : null) || null,
    [settings, selectedId]
  )
  const models = config?.models || []
  // Model ids the user typed in, kept separate from `models` server-side because
  // `models` is replaced wholesale on every refresh (see lib/llm/llmSettings.js).
  const customModels = config?.customModels || []
  // True when `models` is the curated fallback rather than this account's real
  // list — i.e. these credentials cannot list models. For that identity, typing an
  // id is the *normal* way to reach a model, so the field moves to the front and
  // the wording stops calling the list "available".
  const modelsUnlistable = !!config?.modelsUsedFallback
  // What the last Test connection found out about the module that answers this
  // provider's turns. It is persisted with the rest of the provider config rather
  // than held in component state, so reopening Settings still reports a missing
  // CLI instead of looking connected because the key verified.
  const backendStatus = (provider?.chatBackend && config?.backendStatus) || null

  // A provider offering one source renders no choice: a segmented control with a
  // single segment is noise, and every provider but Bedrock has exactly one.
  const credentialSources = provider?.credentialSources || []
  const hasSourceChoice = credentialSources.length > 1
  const usesProfile = credentialSources.includes(AWS_PROFILE) && sourceDraft === AWS_PROFILE
  // A provider whose endpoint is derived from a region rather than being a fixed
  // URL — only Bedrock, and the registry says so by carrying awsRegionDefault.
  // The region matters for *both* of its credential sources, since it is part of
  // the hostname the Converse call is made to, not part of the credential.
  const needsRegion = !!provider?.awsRegionDefault
  const modesForProfile = useMemo(
    () => awsProfiles.find(entry => entry.profileName === profileDraft)?.modes || [],
    [awsProfiles, profileDraft]
  )

  // Reset the per-provider drafts when the selection changes: a key typed for one
  // provider must never be submitted to another. Note this clears *drafts* only —
  // nothing is written, so looking at another provider's card cannot disturb the
  // key stored for this one.
  useEffect(() => {
    setKeyDraft('')
    // Back to mirroring, so the field shows the newly selected provider's model
    // rather than half an id typed for the previous one.
    setModelQuery(null)
    setBaseUrlDraft((config && config.baseUrl) || (provider && provider.baseUrl) || '')
    // The stored values win over the provider defaults, so reopening Settings shows
    // the profile actually in use rather than an empty form implying none is set.
    setSourceDraft(config?.credentialSource || provider?.defaultCredentialSource || API_KEY)
    setProfileDraft(config?.awsProfileName || '')
    setModeDraft(config?.awsAuthnMode || '')
    setRegionDraft(config?.awsRegion || provider?.awsRegionDefault || '')
    setError(null)
    setNotice(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // Choosing a profile that offers one mechanism should not then ask which one.
  useEffect(() => {
    if (!usesProfile) return
    if (modesForProfile.length && !modesForProfile.includes(modeDraft)) {
      setModeDraft(modesForProfile[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileDraft, modesForProfile.join(','), usesProfile])

  const enabled = !!settings?.enabled

  const call = async (label, fn) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      return await fn()
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'The request failed')
      return null
    } finally {
      setBusy('')
    }
  }

  const handleToggle = async checked => {
    const data = await call('toggle', () => presignApi.updateLlmSettings({ enabled: checked }))
    if (data) applyResponse(data)
  }

  const handleTest = async () => {
    const payload = { providerId: selectedId }
    if (keyDraft) payload.apiKey = keyDraft
    if (provider?.baseUrlEditable) payload.baseUrl = baseUrlDraft
    // Sent on every test, so Test also *saves* the profile just picked — a green
    // tick describing a configuration the next chat turn would not use is worse
    // than no tick. Each field is gated on the control that produced it, never on
    // a broader condition: an omitted field makes the server fall back to the
    // *stored* value (lib/llm/llmService.js configForRequest), so gating the
    // profile on `hasSourceChoice` would mean a provider offering aws_profile as
    // its only source rendered the picker, ignored it, and reported the previously
    // saved profile back as though it were the one just chosen.
    if (hasSourceChoice) payload.credentialSource = sourceDraft
    if (usesProfile) {
      payload.awsProfileName = profileDraft
      payload.awsAuthnMode = modeDraft
    }
    if (needsRegion) payload.awsRegion = regionDraft
    // Read before the response overwrites it, so the notice can name what was in
    // use a moment ago — a silent handover is how "I connected Claude and it
    // still answers as GPT" happens.
    const previousLabel = active?.ok && active.providerId !== selectedId ? active.providerLabel : null
    const data = await call('test', () => presignApi.testLlmConnection(payload))
    if (!data) return
    applyResponse(data)
    setKeyDraft('')
    if (!data.verified) {
      setError(data.message || (usesProfile
        ? 'The profile could not be used for Bedrock.'
        : 'The key was not accepted.'))
      return
    }
    const parts = [`${provider.label} is connected`]
    if (data.accountLabel) parts.push(`as ${data.accountLabel}`)
    if (data.modelCount) parts.push(`— ${data.modelCount} models available`)
    if (data.becameActive) {
      parts.push(
        `· Chat now uses ${provider.label}${data.recommendedModel ? ` (${data.recommendedModel})` : ''}`
      )
      if (previousLabel) parts.push(`instead of ${previousLabel}, whose key stays saved`)
    }
    // A verified key on a provider whose backend is missing is a half-success, and
    // the green notice must not claim otherwise — the detail is in the card below.
    if (data.backendStatus && !data.backendStatus.ok) {
      parts.push('· but chat cannot use it yet — see below')
    }
    // A pass with a caveat — most often "these credentials can invoke but cannot
    // list models". It belongs in the success notice, not an error: the provider is
    // usable, and hiding the reason the model list is short would just move the
    // question to "why are there only four models?".
    if (data.warning) parts.push(`· ${data.warning}`)
    setNotice(parts.join(' '))
    if (data.modelsError) {
      setError(`${usesProfile ? 'The profile works' : 'The key works'}, but the model list failed: ` +
        data.modelsError)
    }
    load()
  }

  const handleRefreshModels = async () => {
    const data = await call('models', () => presignApi.listLlmModels(selectedId))
    if (!data) return
    if (!data.success) {
      setError(data.message || 'Could not refresh the model list.')
      return
    }
    applyResponse(data)
    setNotice(`${data.modelCount} models available.`)
  }

  const handleRemoveKey = async () => {
    const data = await call('remove', () => presignApi.deleteLlmKey(selectedId))
    if (data) {
      applyResponse(data)
      setNotice(`The ${provider.label} key was removed.`)
      load()
    }
  }

  // One handler for both a listed model and an id the user typed: selectLlmModel
  // accepts any id and *remembers* an unlisted one, so an id reached by typing
  // survives a reload and a refresh of the provider's list without a second code
  // path here to keep in agreement.
  const handleSelectModel = async modelId => {
    const id = (modelId || '').trim()
    if (!id) return
    const data = await call('select', () => presignApi.selectLlmModel(selectedId, id))
    if (data) {
      applyResponse(data)
      // Back to mirroring the active model, which is now this one.
      setModelQuery(null)
      setNotice(`${provider.label} · ${id} is now in use everywhere.`)
      load()
    }
  }

  // Forgetting one goes through updateLlmSettings rather than selectLlmModel:
  // adding happens as a side effect of choosing, so removal is the only operation
  // that needs a way in of its own.
  const handleForgetCustomModel = async modelId => {
    const remaining = customModels.filter(id => id !== modelId)
    const data = await call('forget', () =>
      presignApi.updateLlmSettings({ providerId: selectedId, customModels: remaining })
    )
    if (data) {
      applyResponse(data)
      load()
    }
  }

  // --- render --------------------------------------------------------------

  if (loading) {
    return (
      <Container header={<Header variant="h2">AI features</Header>}>
        <Box padding="m">
          <Spinner /> Loading LLM settings…
        </Box>
      </Container>
    )
  }

  const status = providerStatus(config)
  const activeModelId =
    settings?.activeProviderId === selectedId ? settings.activeModel || '' : ''
  // The field shows the active model until the user starts typing. The id itself
  // rather than a friendly label, because the id is what gets sent to the provider
  // and what a user comparing this against the AWS console needs to see.
  const modelFieldValue = modelQuery === null ? activeModelId : modelQuery
  // Grouped so an id the user typed is visibly theirs, and so the heading can stop
  // promising the short fallback list is everything this account can reach.
  const modelOptionGroups = [
    models.length
      ? {
          label: modelsUnlistable ? 'Suggested model ids' : 'Available models',
          options: models.map(modelOption)
        }
      : null,
    customModels.length
      ? {
          label: 'Your model ids',
          options: customModels.map(id => ({
            value: id,
            label: id,
            description: 'Typed in, not from the provider list'
          }))
        }
      : null
  ].filter(Boolean)
  // Derived from the list rather than declared per provider, so it is always a
  // real id for this provider and region and cannot go stale in a registry.
  const modelIdPlaceholder = models.length ? models[0].id : 'Model id'

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Choose the AI provider and model that Chat and other AI features use. The key you supply here is the one SignBridge uses, stored encrypted on this machine — there is no config file to edit."
          actions={
            active?.ok ? (
              <Badge color="green">
                {active.providerLabel} · {active.model}
              </Badge>
            ) : null
          }
        >
          AI features
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Toggle checked={enabled} onChange={({ detail }) => handleToggle(detail.checked)}>
          Enable LLM
        </Toggle>

        {!enabled && (
          <Box color="text-body-secondary">
            Turn this on to configure a provider. Chat and the AI-assisted features stay hidden
            until a provider is connected.
          </Box>
        )}

        {enabled && (
          <SpaceBetween size="l">
            {error && (
              <Alert type="error" dismissible onDismiss={() => setError(null)}>
                {error}
              </Alert>
            )}
            {notice && (
              <Alert type="success" dismissible onDismiss={() => setNotice(null)}>
                {notice}
              </Alert>
            )}
            {/* A provider key is the one thing the user must supply for chat to
                work at all, and there is no environment variable or config file
                that can supply it for them — so when nothing is configured, say
                so here rather than letting the first chat turn fail with a 503
                the user has to go looking for. resolveActive's message names the
                exact next step. */}
            {!active?.ok && active?.message && <Alert type="warning">{active.message}</Alert>}

            <FormField
              label="Provider"
              description="Pick the AI tool you have (or want) an API key for."
            >
              <Tiles
                columns={3}
                value={selectedId}
                onChange={({ detail }) => setSelectedId(detail.value)}
                items={providers.map(p => {
                  const c = settings?.providers?.[p.id]
                  const tag = c?.verifiedOk
                    ? ' ✓'
                    : isConfigured(c)
                      ? ' ·'
                      : ''
                  return {
                    value: p.id,
                    label: p.label + tag,
                    description: tileDescription(p)
                  }
                })}
              />
            </FormField>

            {provider && (
              <Container
                header={
                  <Header
                    variant="h3"
                    // Not acquisitionNote: that is the "how do I get a key"
                    // instruction and it belongs beside option 2, not in the
                    // header where it reads as advice to someone who already
                    // has one.
                    description={provider.docsNote || undefined}
                    actions={
                      status ? <StatusIndicator type={status.type}>{status.text}</StatusIndicator> : null
                    }
                  >
                    {provider.label}
                  </Header>
                }
              >
                <SpaceBetween size="m">
                  {provider.inference === false && provider.inferenceNote && (
                    <Alert type="info">{provider.inferenceNote}</Alert>
                  )}
                  {/* A provider answered by a module works differently enough that
                      the card has to say so before the key field: it needs a CLI on
                      this server, and it runs with tool approval forced. Neither is
                      guessable from "paste your API key". */}
                  {provider.chatBackend && provider.backendNote && (
                    <Alert type="info" header={`How ${provider.label} answers`}>
                      {provider.backendNote}
                    </Alert>
                  )}
                  {/* A valid key says nothing about whether that CLI is present, so
                      the two are reported separately — a missing CLI must not read
                      as a rejected key, and vice versa. */}
                  {backendStatus && !backendStatus.ok && (
                    // The header names the provider rather than saying "not ready",
                    // which left the user asking what was not ready and why.
                    <Alert type="warning" header={`Chat cannot use ${provider.label} yet`}>
                      {backendStatus.message}
                    </Alert>
                  )}
                  {backendStatus?.ok && (
                    <Box color="text-body-secondary" fontSize="body-s">
                      Ready — <code>{backendStatus.cliBin}</code>
                      {backendStatus.cliVersion ? ` ${backendStatus.cliVersion}` : ''} is installed
                      on this server.
                    </Box>
                  )}
                  {config?.verifiedError && !config.verifiedOk && (
                    <Alert type="error">{config.verifiedError}</Alert>
                  )}

                  {provider.baseUrlEditable && (
                    <FormField
                      label={provider.baseUrlRequired ? 'Base URL *' : 'Base URL'}
                      description={
                        provider.baseUrlRequired
                          ? 'Required for this provider — it has no shared endpoint.'
                          : 'Leave as-is unless you run this behind a proxy or on another port.'
                      }
                    >
                      <Input
                        value={baseUrlDraft}
                        onChange={({ detail }) => setBaseUrlDraft(detail.value)}
                        placeholder={provider.baseUrlPlaceholder || provider.baseUrl}
                      />
                    </FormField>
                  )}

                  {/* How this provider authenticates. Rendered above the key card
                      because it decides whether the key card is even relevant:
                      signing with a profile needs no key at all. */}
                  {hasSourceChoice && (
                    <FormField
                      label="How should SignBridge authenticate?"
                      description="Bedrock accepts either. Signing with a profile keeps everything in your own AWS account and needs no key to create, rotate or store."
                    >
                      <SegmentedControl
                        selectedId={sourceDraft}
                        onChange={({ detail }) => setSourceDraft(detail.selectedId)}
                        options={[
                          { id: AWS_PROFILE, text: 'Sign with an AWS profile' },
                          { id: API_KEY, text: 'Use a Bedrock API key' }
                        ]}
                      />
                    </FormField>
                  )}

                  {/* Outside the profile block on purpose: the region is part of the
                      Bedrock hostname, so it applies to an API key exactly as much
                      as to a signing profile. Rendered only in the profile branch,
                      an API-key user could not set it at all and was stuck with
                      whatever region happened to be stored. */}
                  {needsRegion && (
                    <FormField
                      label="Region"
                      description="Bedrock model availability is per region, and model ids are region-scoped — so this is the region whose models you will see."
                    >
                      <Autosuggest
                        value={regionDraft}
                        onChange={({ detail }) => setRegionDraft(detail.value)}
                        options={REGION_SUGGESTIONS.map(region => ({ value: region }))}
                        placeholder={provider.awsRegionDefault || 'us-east-1'}
                        enteredTextLabel={value => `Use "${value}"`}
                        empty="Type any region"
                      />
                    </FormField>
                  )}

                  {usesProfile && (
                    <SpaceBetween size="m">
                      {profilesError && (
                        <Alert type="warning">Could not load your profiles: {profilesError}</Alert>
                      )}
                      <FormField
                        label="AWS profile"
                        description="Any AWS profile you already have here — IAM user, SSO role, EC2 instance role or EKS IRSA service account. Credentials are minted per request, so short-lived ones refresh on their own mid-conversation."
                      >
                        <Select
                          selectedOption={
                            profileDraft ? { value: profileDraft, label: profileDraft } : null
                          }
                          onChange={({ detail }) => setProfileDraft(detail.selectedOption.value)}
                          options={awsProfiles.map(entry => ({
                            value: entry.profileName,
                            label: entry.profileName,
                            description: entry.modes.map(authnShortLabel).join(' · ')
                          }))}
                          placeholder="Choose a profile"
                          filteringType="auto"
                          empty="No AWS profiles yet — add one on the Profiles page"
                        />
                      </FormField>

                      {/* Only asked when the profile genuinely offers more than one
                          mechanism; a single-mechanism profile answers it itself. */}
                      {modesForProfile.length > 1 && (
                        <FormField label="Mechanism">
                          <Select
                            selectedOption={
                              modeDraft
                                ? { value: modeDraft, label: authnShortLabel(modeDraft) }
                                : null
                            }
                            onChange={({ detail }) => setModeDraft(detail.selectedOption.value)}
                            options={modesForProfile.map(mode => ({
                              value: mode,
                              label: authnShortLabel(mode)
                            }))}
                          />
                        </FormField>
                      )}
                      {modesForProfile.length === 1 && (
                        <Box color="text-body-secondary" fontSize="body-s">
                          Signs as {authnShortLabel(modesForProfile[0])}.
                        </Box>
                      )}

                      <SpaceBetween direction="horizontal" size="xs">
                        <Button
                          variant="primary"
                          loading={busy === 'test'}
                          disabled={!profileDraft}
                          onClick={handleTest}
                        >
                          Save &amp; test
                        </Button>
                      </SpaceBetween>
                      <Box color="text-body-secondary" fontSize="body-s">
                        The role needs <code>bedrock:InvokeModel</code> and{' '}
                        <code>bedrock:InvokeModelWithResponseStream</code> on the models you use.
                        Listing models (<code>bedrock:ListFoundationModels</code>) is a separate
                        permission — without it a short list of current Claude models is offered
                        instead, and you can type any other model id you have access to. Chat
                        works either way.
                      </Box>
                    </SpaceBetween>
                  )}

                  {/* The whole setup, spelled out as two options, because the only
                      question a new user has here is "where does the key come
                      from?" and there are exactly two answers. Option 1 is the
                      field; option 2 is a link to the provider's own console and
                      an instruction to come back to option 1. Nothing in between:
                      SignBridge does not create or exchange a provider key. */}
                  {!provider.keyless && !usesProfile && (
                    <SpaceBetween size="m">
                      <Box variant="h5">Connect {provider.label}: do either one of these</Box>

                      <FormField
                        label="Option 1 — I already have an API key"
                        description={
                          config?.hasKey
                            ? `A key is stored for ${provider.label} (${config.keyMask}). Paste a new one to replace it, or just re-test the stored one.`
                            : `Paste it here and press Save & test. It is encrypted before it is written to disk and is never shown again.`
                        }
                      >
                        <SpaceBetween size="xs">
                          <Input
                            type="password"
                            value={keyDraft}
                            onChange={({ detail }) => setKeyDraft(detail.value)}
                            placeholder={provider.keyPlaceholder || 'Paste the API key'}
                          />
                          <SpaceBetween direction="horizontal" size="xs">
                            <Button
                              variant="primary"
                              loading={busy === 'test'}
                              disabled={!keyDraft && !config?.hasKey}
                              onClick={handleTest}
                            >
                              {keyDraft ? 'Save & test' : 'Test the stored key'}
                            </Button>
                            {config?.hasKey && (
                              <Button loading={busy === 'remove'} onClick={handleRemoveKey}>
                                Remove key
                              </Button>
                            )}
                          </SpaceBetween>
                        </SpaceBetween>
                      </FormField>

                      {provider.consoleUrl && (
                        <FormField
                          label="Option 2 — I don't have a key yet"
                          description={`Create one in ${provider.label}'s own console, then come back and paste it into option 1. SignBridge deliberately does not create the key for you — it is your account, your key and your billing.`}
                        >
                          <SpaceBetween size="xs">
                            <Link external href={provider.consoleUrl}>
                              Open {provider.label} API keys
                            </Link>
                            {provider.acquisitionNote && (
                              <Box color="text-body-secondary" fontSize="body-s">
                                {provider.acquisitionNote}
                              </Box>
                            )}
                          </SpaceBetween>
                        </FormField>
                      )}
                    </SpaceBetween>
                  )}

                  {provider.keyless && !usesProfile && (
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button variant="primary" loading={busy === 'test'} onClick={handleTest}>
                        Test connection
                      </Button>
                    </SpaceBetween>
                  )}

                  {/* Models come last because they only exist once the key works. */}
                  {config?.verifiedOk && provider.inference !== false && (
                    <SpaceBetween size="m">
                      <FormField
                        label="Model"
                        description={
                          models.length
                            ? modelsUnlistable
                              ? 'These credentials cannot list models, so the list below is a few current ids rather than everything you can reach. Pick one — or type any model id you have access to and choose Use "…". A cross-region inference profile, a foundation model id and a provisioned-throughput ARN all work.'
                              : `${models.length} chat models available${
                                  config.modelsFetchedAt
                                    ? `, listed ${new Date(config.modelsFetchedAt).toLocaleString()}`
                                    : ''
                                }. Type to search, or type an id the list does not show yet and choose Use "…".`
                            : 'No chat models were returned for this key. Type the id of one you have access to and choose Use "…".'
                        }
                        secondaryControl={
                          <Button
                            iconName="refresh"
                            loading={busy === 'models'}
                            onClick={handleRefreshModels}
                            ariaLabel="Refresh model list"
                          />
                        }
                      >
                        {/* One control, not a picker plus an "or type one" field
                            beside it. Typing an id the list does not contain offers
                            it as `Use "<id>"` at the top of the same dropdown, so
                            choosing a listed model and reaching an unlisted one are
                            the same gesture — which matters most for an identity
                            that cannot list models at all, where the unlisted case
                            is the normal one. Both go through selectLlmModel, and
                            the server remembers an unlisted id, so there is no
                            second code path. The id is deliberately not validated:
                            an inference profile, a bare model name and a
                            provisioned-throughput ARN look nothing alike, and a
                            shape check would reject the model the user came for. */}
                        <Autosuggest
                          value={modelFieldValue}
                          onChange={({ detail }) => setModelQuery(detail.value)}
                          onSelect={({ detail }) => handleSelectModel(detail.value)}
                          // Abandoning a half-typed id shows what is actually in use
                          // again, rather than leaving the field asserting a model
                          // nothing is configured with.
                          onBlur={() => setModelQuery(null)}
                          options={modelOptionGroups}
                          enteredTextLabel={value => `Use "${value}"`}
                          placeholder={modelIdPlaceholder}
                          loadingText="Loading models"
                          empty="No models to choose from — type the id of one you have access to"
                          disabled={busy === 'select'}
                          ariaLabel="Model"
                        />
                      </FormField>

                      {/* Adding an id happens by choosing it above, so this exists
                          only to forget one. Shown only when there is something to
                          forget, and phrased as ownership rather than as a second
                          way in. */}
                      {customModels.length > 0 && (
                        <FormField
                          label="Model ids you typed in"
                          description="Kept in the list above so they survive a reload and a refresh of the provider's list. Dismiss one to forget it."
                        >
                          <TokenGroup
                            items={customModels.map(id => ({ label: id, dismissLabel: `Forget ${id}` }))}
                            onDismiss={({ detail }) =>
                              handleForgetCustomModel(customModels[detail.itemIndex])
                            }
                          />
                        </FormField>
                      )}
                    </SpaceBetween>
                  )}
                </SpaceBetween>
              </Container>
            )}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  )
}

export default LlmSettingsPanel
