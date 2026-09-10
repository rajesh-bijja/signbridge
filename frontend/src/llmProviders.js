/**
 * llmProviders.js — the frontend mirror of lib/llm/providers.js.
 *
 * Same relationship as authnModes.js has to lib/authnModes.js: the backend row is
 * authoritative and `/llmSettings` returns it, but the UI needs an ordering and a
 * shape it can render *before* that response arrives (and if it fails), so the ids
 * and labels are duplicated here. `test/llmProviders.test.js` pins the two lists
 * together so they cannot drift.
 *
 * Everything genuinely variable — base URLs, console links, notes, acquisition
 * capabilities — comes from the server response, not from here. This file holds
 * only what the UI needs to lay itself out.
 */

// Display order, matching the backend registry.
export const LLM_PROVIDER_ORDER = [
  'openai',
  'anthropic',
  'bedrock',
  'openrouter',
  'google',
  'cursor',
  'groq',
  'mistral',
  'deepseek',
  'xai',
  'azure-openai',
  'ollama'
]

export const LLM_PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  bedrock: 'AWS Bedrock (Claude)',
  openrouter: 'OpenRouter',
  google: 'Google Gemini',
  cursor: 'Cursor',
  groq: 'Groq',
  mistral: 'Mistral AI',
  deepseek: 'DeepSeek',
  xai: 'xAI (Grok)',
  'azure-openai': 'Azure OpenAI',
  ollama: 'Ollama (local)'
}

// How the user gets a key. Only two values, and that is the point: every provider
// that needs a key is set up the same way. SignBridge used to broker keys for two
// of them (an OpenRouter OAuth flow, an OpenAI admin-key mint) and no longer does
// — see the ACQUISITION comment in lib/llm/providers.js.
export const ACQUISITION = {
  CONSOLE: 'console',
  NONE: 'none'
}

// One line under each provider name, explaining what happens when you pick it.
export const ACQUISITION_SUMMARY = {
  [ACQUISITION.CONSOLE]: 'Create a key in the provider console and paste it here',
  [ACQUISITION.NONE]: 'No API key needed'
}

export function llmProviderLabel(providerId) {
  return LLM_PROVIDER_LABELS[providerId] || providerId || ''
}

/**
 * Order a server-supplied provider list by the display order above.
 *
 * Unknown ids go last rather than being dropped: a newer backend must not have
 * its providers hidden by an older bundle.
 */
export function sortProviders(providers) {
  const rows = Array.isArray(providers) ? [...providers] : []
  return rows.sort((a, b) => {
    const ai = LLM_PROVIDER_ORDER.indexOf(a.id)
    const bi = LLM_PROVIDER_ORDER.indexOf(b.id)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  })
}

/**
 * The model search used by the picker.
 *
 * Mirrors lib/llm/modelCatalog.filterModels — all whitespace-separated terms must
 * appear somewhere in the id, label or owner, case-insensitively — so typing
 * "claude sonnet" finds `anthropic/claude-sonnet-4` whichever order you type it.
 * Filtering client-side keeps it instant: the list is already in memory.
 */
export function filterModels(models, query) {
  const rows = Array.isArray(models) ? models : []
  const text = (query || '').trim().toLowerCase()
  if (!text) return rows
  const terms = text.split(/\s+/).filter(Boolean)
  return rows.filter(model => {
    const haystack = [model.id, model.label, model.ownedBy, model.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

// "$1.25/M in · $10/M out" — the shape every provider's pricing page uses, so it
// needs no legend.
export function formatModelPricing(pricing) {
  if (!pricing) return null
  const parts = []
  if (pricing.inputPerMillion != null) parts.push(`$${pricing.inputPerMillion}/M in`)
  if (pricing.outputPerMillion != null) parts.push(`$${pricing.outputPerMillion}/M out`)
  return parts.length ? parts.join(' · ') : null
}

export function formatContextLength(contextLength) {
  if (!contextLength) return null
  if (contextLength >= 1000000) return `${Math.round(contextLength / 100000) / 10}M context`
  if (contextLength >= 1000) return `${Math.round(contextLength / 1000)}K context`
  return `${contextLength} context`
}
