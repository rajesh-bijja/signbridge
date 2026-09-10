import axios from 'axios'

import { API_BASE, DEFAULT_USER_NAME } from '../appConfig'
import { getUsername } from '../session'

async function userName() {
  return (await getUsername()) || DEFAULT_USER_NAME
}

export const populateProfilesDetails = async () => {
  const response = await axios.post(`${API_BASE}/populateProfilesDetails`, {
    userName: await userName()
  })
  return response.data
}

export const addProfileDetails = async profile => {
  const response = await axios.post(`${API_BASE}/addProfileDetails`, {
    profile: { ...profile, userName: await userName() }
  })
  return response.data
}

export const updateProfileDetails = async profile => {
  const response = await axios.post(`${API_BASE}/updateProfileDetails`, {
    profile: { ...profile, userName: await userName() }
  })
  return response.data
}

export const deleteProfileDetails = async profile => {
  const response = await axios.post(`${API_BASE}/deleteProfileDetails`, {
    profile: { ...profile, userName: await userName() }
  })
  return response.data
}

export const checkProfileExists = async (profileName, authnMode) => {
  const response = await axios.post(`${API_BASE}/checkProfileExists`, {
    profile: { profileName, authnMode, userName: await userName() }
  })
  return response.data
}

export const populateHistoryDetails = async (requestLabel = null) => {
  const payload = { userName: await userName() }
  if (requestLabel) payload.requestLabel = requestLabel
  const response = await axios.post(`${API_BASE}/populateHistoryDetails`, payload)
  return response.data
}

export const deleteHistoryDetails = async historyId => {
  const response = await axios.post(`${API_BASE}/deleteHistoryDetailsForTheGivenRequest`, {
    profile: { historyId, userName: await userName() }
  })
  return response.data
}

export const addHistoryToFavorites = async historyId => {
  const response = await axios.post(`${API_BASE}/addHistoryToFavorites`, {
    userName: await userName(),
    historyId
  })
  return response.data
}

export const applyLabelForRequest = async (historyId, requestLabel) => {
  const response = await axios.post(`${API_BASE}/applyLabelForTheGivenRequest`, {
    profile: { historyId, requestLabel, userName: await userName() }
  })
  return response.data
}

export const populateFavoriteDetails = async (requestLabel = null) => {
  const payload = { userName: await userName() }
  if (requestLabel) payload.requestLabel = requestLabel
  const response = await axios.post(`${API_BASE}/populateFavoriteDetails`, payload)
  return response.data
}

export const deleteFavoriteDetails = async favoriteId => {
  const response = await axios.post(`${API_BASE}/deleteFavoriteDetailsForTheGivenRequest`, {
    profile: { favoriteId, userName: await userName() }
  })
  return response.data
}

export const applyLabelForFavorite = async (favoriteId, requestLabel) => {
  const response = await axios.post(`${API_BASE}/applyLabelForTheGivenFavoriteRequest`, {
    profile: { favoriteId, requestLabel, userName: await userName() }
  })
  return response.data
}

export const populateCollectionsDetails = async (requestLabel = null) => {
  const payload = { userName: await userName() }
  if (requestLabel) payload.requestLabel = requestLabel
  const response = await axios.post(`${API_BASE}/populateCollectionsDetails`, payload)
  return response.data
}

export const importCollection = async (collectionName, collectionPayload) => {
  const response = await axios.post(`${API_BASE}/importCollection`, {
    userName: await userName(),
    collectionName,
    collectionPayload
  })
  return response.data
}

// AWS catalog: the backend owns model fetching, conversion, and import. The
// client only lists services and asks to import one by name.
export const listAwsCatalog = async () => {
  const response = await axios.get(`${API_BASE}/awsCatalogServices`)
  return response.data
}

export const importAwsCatalogService = async (service, region = null) => {
  const payload = { userName: await userName(), service }
  if (region) payload.region = region
  const response = await axios.post(`${API_BASE}/importAwsCatalogService`, payload)
  return response.data
}

export const deleteCollection = async importedCollectionName => {
  const response = await axios.post(`${API_BASE}/deleteCollection`, {
    userName: await userName(),
    importedCollectionName
  })
  return response.data
}

// Delete a single request from its collection, keyed by its unique detail file
// name. Copies already in History/Favorites are unaffected.
export const deleteRequestFromCollection = async requestDetailsFileName => {
  const response = await axios.post(`${API_BASE}/deleteRequestFromCollection`, {
    userName: await userName(),
    requestDetailsFileName
  })
  return response.data
}

export const populateSettingsDetails = async () => {
  const response = await axios.post(`${API_BASE}/populateSettingsDetails`, {
    userName: await userName()
  })
  return response.data
}

export const updateSettingsDetails = async settings => {
  const response = await axios.post(`${API_BASE}/updateSettingsDetails`, {
    userName: await userName(),
    settings
  })
  return response.data
}

export const generateAuthResponse = async options => {
  const response = await axios.post(`${API_BASE}/generateAuthResponse`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

export const generateAuthResponseAndInvoke = async options => {
  const response = await axios.post(`${API_BASE}/generateAuthResponseAndInvoke`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

export const generateAuthResponseAndInvokeRestBasicAuth = async options => {
  const response = await axios.post(`${API_BASE}/generateAuthResponseAndInvokeRestBasicAuth`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

export const generateAuthResponseAndInvokeRestBearerToken = async options => {
  const response = await axios.post(`${API_BASE}/generateAuthResponseAndInvokeRestBearerToken`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

export const generateAuthResponseAndInvokeGeneric = async options => {
  const response = await axios.post(`${API_BASE}/generateAuthResponseAndInvokeGeneric`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

export const invokeCommand = async options => {
  const response = await axios.post(`${API_BASE}/invokeCommand`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

// --- Sandbox mode -----------------------------------------------------------
// The built-in IDE: write Python/JS/TS/Java and run it in a throwaway Docker
// container with the selected profile's AWS credentials already in scope.

// Language registry + limits + whether Docker and the sandbox image are ready.
export const getSandboxRuntimes = async () => {
  const response = await axios.post(`${API_BASE}/sandboxRuntimes`, {
    options: { userName: await userName() }
  })
  return response.data
}

// Starter code for a language/template.
export const getSandboxTemplate = async (runtimeId, templateId = null) => {
  const response = await axios.post(`${API_BASE}/sandboxTemplate`, {
    options: { runtimeId, templateId, userName: await userName() }
  })
  return response.data
}

// Completion data for the editor. Without `service`: language globals (what
// `boto3.` offers) plus the AWS service list. With `service`: that service's
// full operation index, built from its botocore model.
export const getSandboxCompletions = async (runtimeId, service = null) => {
  const response = await axios.post(`${API_BASE}/sandboxCompletions`, {
    options: { runtimeId, service, userName: await userName() }
  })
  return response.data
}

// Run the code. Output also streams over Socket.IO; this resolves with the
// complete result (stdout/stderr, exit code, diagnostics, remedies).
export const runSandbox = async (options, signal = null) => {
  const response = await axios.post(
    `${API_BASE}/runSandbox`,
    { options: { ...options, userName: await userName() } },
    signal ? { signal } : undefined
  )
  return response.data
}

// Syntax/type-check without running. No credentials, no network in the container.
export const checkSandbox = async (runtimeId, code, signal = null) => {
  const response = await axios.post(
    `${API_BASE}/checkSandbox`,
    { options: { runtimeId, code, userName: await userName() } },
    signal ? { signal } : undefined
  )
  return response.data
}

export const cancelSandbox = async runId => {
  const response = await axios.post(`${API_BASE}/cancelSandbox`, {
    options: { runId, userName: await userName() }
  })
  return response.data
}

export const listSandboxScripts = async () => {
  const response = await axios.post(`${API_BASE}/listSandboxScripts`, {
    options: { userName: await userName() }
  })
  return response.data
}

export const getSandboxScript = async scriptId => {
  const response = await axios.post(`${API_BASE}/getSandboxScript`, {
    options: { scriptId, userName: await userName() }
  })
  return response.data
}

// Create when `scriptId` is absent, update when present.
export const saveSandboxScript = async options => {
  const response = await axios.post(`${API_BASE}/saveSandboxScript`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

export const deleteSandboxScript = async scriptId => {
  const response = await axios.post(`${API_BASE}/deleteSandboxScript`, {
    options: { scriptId, userName: await userName() }
  })
  return response.data
}

// --- S3 World ---------------------------------------------------------------
// Browse buckets, search a subtree recursively, and view object contents. Every
// byte is read server-side: reading S3 from the browser would need a CORS policy
// on each bucket, and S3 World is aimed at buckets the user may not own.

const s3 = async (route, options = {}) => {
  const response = await axios.post(`${API_BASE}/${route}`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

export const s3ListBuckets = (profileName, authnMode) =>
  s3('s3ListBuckets', { profileName, authnMode })

export const s3BucketRegion = (profileName, authnMode, bucket) =>
  s3('s3BucketRegion', { profileName, authnMode, bucket })

// One page of a folder. `delimiter: ''` flattens the whole subtree instead of
// returning sub-folders as CommonPrefixes.
export const s3ListObjects = options => s3('s3ListObjects', options)

// Metadata + resolved type + how the object should be opened ('tab' | 'preview'
// | 'download'). One round trip, because the UI needs all three to act.
export const s3HeadObject = options => s3('s3HeadObject', options)

// A presigned URL on the S3 origin, with signed response-content-type and
// response-content-disposition overrides — which is what makes an octet-stream
// PNG render in a tab instead of downloading.
export const s3PresignView = options => s3('s3PresignView', options)

// Decode an object into a table / JSON / text / archive listing / hex dump.
export const s3PreviewObject = options => s3('s3PreviewObject', options)

// Recursive, forgiving search. Progress arrives over Socket.IO; this resolves
// with the final, authoritative result.
export const s3SearchObjects = (options, signal = null) =>
  axios
    .post(
      `${API_BASE}/s3SearchObjects`,
      { options: { ...options } },
      signal ? { signal } : undefined
    )
    .then(response => response.data)

export const s3CancelSearch = searchId => s3('s3CancelSearch', { searchId })

// Explain a query without running it — backs the live hint under the search box,
// so the syntax is discoverable by typing rather than by reading documentation.
// `scope` is passed through so the hint describes the search that will actually
// run ('name' | 'folder' | 'both').
export const s3ExplainSearch = (query, caseSensitive = false, scope = 'both') =>
  s3('s3ExplainSearch', { query, caseSensitive, scope })

export const s3CreateFolder = options => s3('s3CreateFolder', options)

export const s3DeleteObjects = options => s3('s3DeleteObjects', options)

export const s3CopyObjects = options => s3('s3CopyObjects', options)

/**
 * URL for the object-bytes proxy. A GET so it can be used as an <img>/<video>
 * source and as a download target — contexts that cannot POST or set headers.
 * The server refuses to serve anything scriptable inline whatever is asked for.
 */
export const s3ObjectUrl = ({
  profileName,
  authnMode,
  bucket,
  key,
  versionId = null,
  disposition = 'attachment'
}) => {
  const query = new URLSearchParams({ profileName, bucket, key, disposition })
  if (authnMode) query.set('authnMode', authnMode)
  if (versionId) query.set('versionId', versionId)
  return `${API_BASE}/s3Object?${query.toString()}`
}

/**
 * Upload one object. The bytes go up as a raw body rather than base64 in JSON,
 * so a 50 MB file does not become a 67 MB string; the parameters ride on the
 * query string because a raw-body route cannot also carry JSON.
 */
export const s3UploadObject = async (
  { profileName, authnMode, bucket, key, contentType },
  file,
  onProgress = null
) => {
  const query = new URLSearchParams({ profileName, bucket, key })
  if (authnMode) query.set('authnMode', authnMode)
  if (contentType) query.set('contentType', contentType)
  const response = await axios.put(`${API_BASE}/s3UploadObject?${query.toString()}`, file, {
    headers: { 'Content-Type': 'application/octet-stream' },
    onUploadProgress: onProgress || undefined
  })
  return response.data
}

// Test the bearer-token configuration for a profile. Pass `profile` inline to
// test an unsaved profile (pre-save check); otherwise the saved profile named
// by profileName is used.
export const testBearerTokenConnection = async (profileName, profile = null) => {
  const response = await axios.post(`${API_BASE}/testBearerTokenConnection`, {
    options: {
      profileName,
      profile,
      authnMode: 'rest_bearer_token',
      userName: await userName()
    }
  })
  return response.data
}

// --- EC2 instance-role profiles ---
// SSH to the instance with the form's credentials and read IMDSv2. Pass `profile`
// inline so an unsaved form can be tested before it is saved (the backend falls
// back to the stored secrets when the form omits them, which is what makes Test
// Connection work while editing a saved profile).
export const testEc2Connection = async (profileName, profile = null) => {
  const response = await axios.post(`${API_BASE}/testEc2Connection`, {
    profileName,
    profile,
    userName: await userName()
  })
  return response.data
}

// --- IRSA (EKS service account) profiles ---
// The form is a cascade: base AWS profile -> region -> cluster -> service
// account. Each step is a discovery call against the base profile's credentials;
// none of them needs kubectl on this host.
export const listIrsaClusters = async (baseProfileName, baseAuthnMode, region) => {
  const response = await axios.post(`${API_BASE}/listIrsaClusters`, {
    baseProfileName,
    baseAuthnMode,
    region,
    userName: await userName()
  })
  return response.data
}

export const listIrsaServiceAccounts = async (
  baseProfileName,
  baseAuthnMode,
  region,
  clusterName
) => {
  const response = await axios.post(`${API_BASE}/listIrsaServiceAccounts`, {
    baseProfileName,
    baseAuthnMode,
    region,
    clusterName,
    userName: await userName()
  })
  return response.data
}

// Reads the role's trust policy, so the form can show the audience the role
// actually requires and warn when the chosen service account is not one it
// trusts. Never fatal: an unreadable policy comes back as
// { trustPolicyReadable: false }.
export const describeIrsaRole = async (
  baseProfileName,
  baseAuthnMode,
  roleArn,
  namespace,
  serviceAccount
) => {
  const response = await axios.post(`${API_BASE}/describeIrsaRole`, {
    baseProfileName,
    baseAuthnMode,
    roleArn,
    namespace,
    serviceAccount,
    userName: await userName()
  })
  return response.data
}

// Runs the whole chain — cluster token, service-account token, STS
// assume-role-with-web-identity — and reports where it got to.
export const testIrsaConnection = async (profileName, profile = null) => {
  const response = await axios.post(`${API_BASE}/testIrsaConnection`, {
    profileName,
    profile,
    userName: await userName()
  })
  return response.data
}

export const copyBearerToken = async profileName => {
  const response = await axios.post(`${API_BASE}/copyBearerToken`, {
    options: {
      profileName,
      authnMode: 'rest_bearer_token',
      userName: await userName()
    }
  })
  return response.data
}

// Prepare (never invoke / never persist) the exact request for "Copy as curl".
// Returns { statusCode, response: { method, url, headers, body,
// containsLiveCredential, note, verificationUriComplete? } }.
export const prepareCurlRequest = async options => {
  const response = await axios.post(`${API_BASE}/prepareCurlRequest`, {
    options: { ...options, userName: await userName() }
  })
  return response.data
}

// `model` is { providerId, model } and is optional: the server falls back to the
// stored selection. It is sent anyway so a model chosen in the picker takes effect
// on the very next message, rather than on the one after the settings write lands.
export const sendChatMessage = async (
  message,
  activeProfile,
  threadId = null,
  signal = null,
  model = null
) => {
  const response = await axios.post(
    `${API_BASE}/chat`,
    {
      message,
      activeProfile,
      threadId,
      ...(model && model.providerId ? { providerId: model.providerId } : {}),
      ...(model && model.model ? { model: model.model } : {}),
      userName: await userName()
    },
    signal ? { signal } : undefined
  )
  return response.data
}

export const listChatThreads = async () => {
  const response = await axios.post(`${API_BASE}/chatThreads`, {
    userName: await userName()
  })
  return response.data
}

export const getChatThread = async threadId => {
  const response = await axios.post(`${API_BASE}/chatThread`, {
    threadId,
    userName: await userName()
  })
  return response.data
}

export const newChatThread = async () => {
  const response = await axios.post(`${API_BASE}/chatNewThread`, {
    userName: await userName()
  })
  return response.data
}

export const renameChatThread = async (threadId, title) => {
  const response = await axios.post(`${API_BASE}/chatRenameThread`, {
    threadId,
    title,
    userName: await userName()
  })
  return response.data
}

export const summarizeChatThread = async threadId => {
  const response = await axios.post(`${API_BASE}/chatSummarizeThread`, {
    threadId,
    userName: await userName()
  })
  return response.data
}

export const deleteChatThread = async threadId => {
  const response = await axios.post(`${API_BASE}/chatDeleteThread`, {
    threadId,
    userName: await userName()
  })
  return response.data
}

// --- LLM configuration (providers, keys, model selection) ---
// The provider list and the model list both come from the server: the registry is
// authoritative there, and the model list is whatever the user's own key can see.

export const llmProviders = async () => {
  const response = await axios.post(`${API_BASE}/llmProviders`, {
    userName: await userName()
  })
  return response.data
}

export const llmSettings = async () => {
  const response = await axios.post(`${API_BASE}/llmSettings`, {
    userName: await userName()
  })
  return response.data
}

// Patch-style: only the fields present are changed. Pass apiKey: '' to clear a key,
// or omit it entirely to leave the stored one alone — the two are different asks,
// which is why this does not spread a whole settings object.
export const updateLlmSettings = async patch => {
  const response = await axios.post(`${API_BASE}/updateLlmSettings`, {
    ...patch,
    userName: await userName()
  })
  return response.data
}

// What the in-conversation model picker calls. Persisting here rather than in
// component state is the point: choosing a model in Chat has to show up in
// Settings and in Sandbox too.
export const selectLlmModel = async (providerId, model) => {
  const response = await axios.post(`${API_BASE}/selectLlmModel`, {
    providerId,
    model,
    userName: await userName()
  })
  return response.data
}

export const deleteLlmKey = async providerId => {
  const response = await axios.post(`${API_BASE}/deleteLlmKey`, {
    providerId,
    userName: await userName()
  })
  return response.data
}

// Verifies the key AND fetches the model list in one round trip, because a key that
// verifies is immediately useless without models to choose from.
export const testLlmConnection = async ({ providerId, apiKey, baseUrl } = {}) => {
  const response = await axios.post(`${API_BASE}/testLlmConnection`, {
    providerId,
    // Omitted rather than sent empty: the server reads an absent apiKey as "keep
    // the stored one" and an empty string as "clear it", so `{ apiKey: '' }`
    // would delete the key of anyone who pressed Test without retyping it.
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    userName: await userName()
  })
  return response.data
}

export const listLlmModels = async (providerId, opts = {}) => {
  const response = await axios.post(`${API_BASE}/listLlmModels`, {
    providerId,
    ...opts,
    userName: await userName()
  })
  return response.data
}

// There is deliberately nothing here that creates a provider key. Keys are made
// by the user in the provider's own console and pasted into the field above —
// SignBridge is not a broker for someone else's credentials.
