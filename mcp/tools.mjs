// Shared MCP tool definitions for SignBridge.
//
// Every tool is a thin wrapper over the same local HTTPS API the dashboard
// uses, so MCP has full parity with the UI: invoke (all auth modes), presign,
// AWS CLI, Sandbox mode (run/check code in a container), and full CRUD for
// profiles, history, favorites, templates, scripts, and settings.
//
// This module is imported by BOTH transports:
//   - mcp/server.js         (stdio, for Claude Desktop / Cursor / Codex)
//   - mcp/mcpHttp.mjs        (Streamable HTTP, mounted inside the Express server)
//
// A tool definition is: { name, description, schema (zod raw shape), handler }.
// registerTools(server, ctx) wires them all onto an McpServer instance.
//
// NO TOOL HERE NEEDS AN AI PROVIDER KEY, and that is a property to preserve.
// SignBridge's provider key buys *inference* for its own Chat page, which has no
// model of its own. An MCP client already is a model, so these tools only sign
// AWS requests and read local state — the key is irrelevant to all of them. Two
// consequences: /chat is permanently excluded (a model paying a second model to
// reach tools it already has), and summarize_chat_session — the one tool that
// wanted a completion — falls back to handing the transcript to the caller
// instead of returning a 503 that sends the user to a Settings page they may not
// even be able to open. Adding a tool that fails without a key would quietly
// make "configure SignBridge in Codex and everything works" untrue.
//
// Parity is checked against server.js's route table, not assumed — and three
// routes the dashboard uses are deliberately absent, because their whole return
// value is a credential: /copyBearerToken (the bearer token itself),
// /getRoleCredentialsForUser (an STS triple) and /prepareCurlRequest (a curl
// command carrying a live Authorization header, and for AWS an
// x-amz-security-token; it flags itself containsLiveCredential). A tool result
// becomes part of a model's context, so with a hosted client those would leave the
// machine into a third party's conversation history. The LLM key-management routes
// are excluded for the mirrored reason — see the llm configuration section below.
// test/mcpToolParity.test.js pins both the coverage and the omissions.

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

// Mirrors lib/authnModes.js (ESM here, CommonJS there, and tool schemas are sent
// to clients up front — so the list has to be literal). Order matches the
// backend's declaration order.
const AWS_AUTHN_MODES = ['sso_user', 'iam_user', 'ec2_instance', 'irsa']
const AUTHN_MODES = [...AWS_AUTHN_MODES, 'rest_basic_auth', 'rest_bearer_token', 'generic']
// Sandbox languages. Kept in step with lib/sandbox/sandboxRuntimes.js RUNTIME_ORDER;
// this module is ESM and cannot require() that CommonJS registry, and the tool
// schemas are sent to clients up front, so the list has to be literal here.
const SANDBOX_RUNTIMES = ['python', 'javascript', 'typescript', 'java']

// The profile fields, shared by create_profile and update_profile. They were two
// copies of the same 20-line literal, which is precisely how EC2 and IRSA support
// would end up in one tool and not the other.
const PROFILE_FIELDS = {
  profileName: z.string(),
  // AWS SSO
  awsSsoUserEnabled: z.boolean().optional(),
  awsSsoStartUrl: z.string().optional(),
  awsSsoAccountId: z.string().optional(),
  awsSsoRoleName: z.string().optional(),
  ssoRegion: z.string().optional(),
  // AWS IAM
  awsIamUserEnabled: z.boolean().optional(),
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  region: z.string().optional(),
  // AWS EC2 instance role — credentials are read from the box's own IMDSv2 over SSH
  ec2InstanceEnabled: z.boolean().optional(),
  ec2Host: z.string().optional().describe('EC2 IP address or hostname'),
  ec2SshUsername: z.string().optional(),
  ec2SshPort: z.number().int().optional().describe('Defaults to 22'),
  ec2SshPrivateKey: z.string().optional().describe('PEM private key contents. Mutually exclusive with ec2SshPassword'),
  ec2SshPrivateKeyPassphrase: z.string().optional(),
  ec2SshPassword: z.string().optional().describe('SSH password. Mutually exclusive with ec2SshPrivateKey'),
  // AWS IRSA — an EKS service-account token exchanged for a role. kubectl is NOT required.
  irsaEnabled: z.boolean().optional(),
  irsaBaseProfileName: z.string().optional().describe('An sso_user/iam_user profile used only to reach EKS and read the role'),
  irsaBaseAuthnMode: z.enum(['sso_user', 'iam_user']).optional(),
  irsaRegion: z.string().optional().describe('Defaults to us-east-1'),
  irsaClusterName: z.string().optional(),
  irsaNamespace: z.string().optional(),
  irsaServiceAccount: z.string().optional(),
  irsaRoleArn: z.string().optional().describe('The role in the service account\'s eks.amazonaws.com/role-arn annotation'),
  irsaAudience: z.string().optional().describe('Leave unset to use whatever the role\'s trust policy requires (usually sts.amazonaws.com)'),
  // REST Basic
  restBasicAuthEnabled: z.boolean().optional(),
  basicAuthUsername: z.string().optional(),
  basicAuthPassword: z.string().optional(),
  // REST Bearer
  restBearerTokenEnabled: z.boolean().optional(),
  bearerTokenMode: z.enum(['static', 'oauth2']).optional(),
  bearerStaticToken: z.string().optional(),
  bearerTokenEndpoint: z.string().optional(),
  bearerTokenFields: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  bearerTokenResponseField: z.string().optional(),
  bearerAutoRenewOnExpiry: z.boolean().optional().describe('OAuth2 only: silently regenerate an expired token at invoke time instead of failing'),
  // Generic
  genericEnabled: z.boolean().optional()
}

// Map an authnMode to the backend invoke endpoint (same routing the dashboard
// and chat copilot use).
function invokeEndpointForAuthnMode(authnMode) {
  switch (authnMode) {
    case 'rest_basic_auth':
      return '/generateAuthResponseAndInvokeRestBasicAuth'
    case 'rest_bearer_token':
      return '/generateAuthResponseAndInvokeRestBearerToken'
    case 'generic':
      return '/generateAuthResponseAndInvokeGeneric'
    // Every AWS mechanism — IAM keys, SSO, EC2 instance role, IRSA — goes through
    // the one SigV4 endpoint; the backend resolves the credentials.
    case 'sso_user':
    case 'iam_user':
    case 'ec2_instance':
    case 'irsa':
    default:
      return '/generateAuthResponseAndInvoke'
  }
}

// --- What SignBridge will not hand to a model --------------------------------
//
// A tool result is not a log line and not a UI response: it becomes part of the
// model's context, so with a hosted client (Claude Desktop, Cursor, an IDE) it
// leaves this machine and lands in a third party's conversation history. The
// credentials SignBridge stores on the user's behalf must not travel that way —
// and they never need to, because every invoking tool names a *profile* and the
// server resolves the credentials itself. A model that can read
// `awsSecretAccessKey` gains nothing it can act on and everything it can spill.
//
// What made this concrete: `list_profiles` returned each profile verbatim,
// including the cached `irsaRoleCredentials` / `roleCredentials` STS triple —
// a live secret access key and session token, shipped to whichever LLM provider
// is answering. Nothing failed; the tool looked like it was working.
//
// Deliberately a NAMED-FIELD rule over SignBridge's own profile schema, and not
// the substring sweep lib/redact.js uses for logs. Object previews and invoked
// API response bodies pass through untouched, because that is the data the user
// asked the model to fetch: a config file with a `password` key in it is the
// answer to the question, and silently blanking it would make the tool lie. The
// line is ownership — SignBridge's stored secrets, never the user's content.
//
// (It is also self-contained on purpose. mcp/ is publishable on its own for the
// npx stdio path, so it cannot import lib/redact.js — same reason the authn-mode
// and runtime lists are literal copies here. test/mcpRedaction.test.js pins it.)
const REDACTED = '[redacted: SignBridge does not send stored credentials to a model]'

// Exact field names (compared lower-case) whose value is a secret SignBridge holds.
const SECRET_FIELDS = new Set([
  'awssecretaccesskey', 'secretaccesskey', 'sessiontoken',
  'ec2sshprivatekey', 'ec2sshprivatekeypassphrase', 'ec2sshpassword',
  'basicauthpassword', 'bearerstatictoken', 'apikey'
])

// Not secret, and worth keeping: it answers "which credentials was that?".
const MASKED_FIELDS = new Set(['accesskeyid', 'awsaccesskeyid'])

// Header names whose value is a credential, wherever a `headers` map appears
// (stored history and favorite requests can carry one the user typed by hand).
const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-amz-security-token'
])

function maskId(value) {
  const s = String(value)
  return s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-4)
}

// A bearerTokenFields row is {key, value} where the key is user-chosen
// (client_secret, password, refresh_token …), so this one pair is matched by
// substring — the field names are the OAuth spec's, not SignBridge's.
function isSecretishKey(key) {
  return /secret|password|passphrase|token|credential/i.test(String(key || ''))
}

export function scrubForModel(value, keyPath) {
  if (Array.isArray(value)) {
    return value.map(function (v) { return scrubForModel(v, keyPath) })
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (SECRET_FIELDS.has(lower)) {
      out[key] = val === null || val === undefined || val === '' ? val : REDACTED
    } else if (MASKED_FIELDS.has(lower)) {
      out[key] = val ? maskId(val) : val
    } else if (lower === 'headers' && val && typeof val === 'object' && !Array.isArray(val)) {
      const headers = {}
      for (const [h, hv] of Object.entries(val)) {
        headers[h] = SECRET_HEADERS.has(h.toLowerCase()) ? REDACTED : hv
      }
      out[key] = headers
    } else if (lower === 'bearertokenfields' && Array.isArray(val)) {
      out[key] = val.map(function (row) {
        return row && typeof row === 'object' && isSecretishKey(row.key)
          ? { ...row, value: REDACTED }
          : row
      })
    } else {
      out[key] = scrubForModel(val, lower)
    }
  }
  return out
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(scrubForModel(data), null, 2) }] }
}

function fail(err) {
  const message = err && (err.apiMessage || err.message) ? (err.apiMessage || err.message) : String(err)
  return { isError: true, content: [{ type: 'text', text: 'Error: ' + message }] }
}

// Did this call fail only because SignBridge has no AI provider of its own?
//
// Every route answers that case with 503 + needsLlmSetup, so the test is the flag
// and not the wording. Deliberately narrow: a tool may substitute its own answer
// for *this* failure, but a 404 or a real error must still surface as an error —
// silently returning something plausible instead would be worse than the 503.
function isLlmSetupError(err) {
  return !!(err && err.apiData && err.apiData.needsLlmSetup)
}

// Guard against protocol-less / non-URL endpoints (e.g. a history id or filename
// mistaken for an endpoint). Returns an error string to feed back to the caller,
// or null when the endpoint is a valid absolute http(s) URL.
function invalidEndpointMessage(endpoint) {
  if (typeof endpoint !== 'string' || !/^https?:\/\//i.test(endpoint.trim())) {
    return (
      'Invalid endpoint: "' + endpoint + '". endpoint must be a full absolute URL starting with http:// or https://. ' +
      'If you are re-invoking a past request, call get_history_details (or get_favorite_details) with the id to get the ' +
      'real endpoint — do not use a history id, filename, or partial path as the endpoint.'
    )
  }
  return null
}

// Build the tool list. `ctx` supplies { callApi(path, payload), userName }.
export function buildTools(ctx) {
  const { callApi, userName } = ctx

  const withUser = (obj = {}) => ({ userName, ...obj })

  return [
    // ---------------------------------------------------------------- invoke
    {
      name: 'invoke_api',
      description:
        'Invoke an AWS or REST API using a stored profile. authnMode selects how the request is authenticated: ' +
        'sso_user/iam_user/ec2_instance/irsa (AWS SigV4), rest_basic_auth, rest_bearer_token (static token or OAuth2 fetch), ' +
        'or generic (no auth). ' +
        'endpoint MUST be a full absolute URL including protocol (e.g. https://ec2.us-east-1.amazonaws.com/?Action=...). ' +
        'Never pass a history id, filename, or partial path as the endpoint — if re-invoking a past request, get the real ' +
        'endpoint from get_history_details first. Unlike presign_url this makes a REAL call and returns the actual status ' +
        'and body. To control the response format set an Accept header (e.g. {"Accept":"application/json"}); note AWS ' +
        'query-protocol services such as EC2/IAM/STS return XML regardless.',
      schema: {
        profileName: z.string().describe('Name of a stored profile'),
        authnMode: z.enum(AUTHN_MODES).default('sso_user'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
        endpoint: z.string().url().describe('Full absolute URL including https:// — not a history id or filename'),
        headers: z.record(z.string()).optional(),
        body: z.string().optional().describe('Request body (string; JSON should be pre-stringified)')
      },
      handler: async input => {
        const bad = invalidEndpointMessage(input.endpoint)
        if (bad) return fail(new Error(bad))
        const data = await callApi(invokeEndpointForAuthnMode(input.authnMode), {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            method: input.method,
            endpoint: input.endpoint,
            headers: input.headers || { 'content-type': 'application/json' },
            body: input.body
          })
        })
        return ok(data)
      }
    },
    {
      name: 'presign_url',
      description:
        'Generate a presigned URL for an AWS API endpoint (any AWS profile: sso_user, iam_user, ec2_instance, irsa). ' +
        'This ONLY produces a ' +
        'signed URL — it does NOT call the API: the result has statusCode 0 and a preSignedUrl and no real response ' +
        'body. If the user wants the actual response (e.g. "invoke", "re-invoke", "summarize the response"), use ' +
        'invoke_api instead. Presigned AWS query-protocol URLs (EC2/IAM/STS/…) return XML and cannot be forced to JSON. ' +
        'For every mechanism except iam_user the URL embeds temporary session credentials, so it stops working once those ' +
        'expire (an SSO session, the EC2 instance role\'s credentials, or the IRSA assumed-role session). ' +
        'Works for any method, not just GET: for POST/PUT/PATCH/DELETE the URL is signed with UNSIGNED-PAYLOAD, so the ' +
        'caller must send the request body themselves (e.g. curl -d ...) — the body is not baked into the URL. ' +
        'expiresInSeconds sets the URL lifetime (60..43200s; default 3600). NOTE: for any temporary-credential mechanism ' +
        '(sso_user, ec2_instance, irsa) the effective lifetime is capped to the session credential\'s remaining life ' +
        '(usually <= 1h), so large values will not extend it — use an iam_user profile for genuinely long-lived URLs.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
        endpoint: z.string().url(),
        expiresInSeconds: z.number().int().min(60).max(43200).default(3600)
      },
      handler: async input => {
        const bad = invalidEndpointMessage(input.endpoint)
        if (bad) return fail(new Error(bad))
        const data = await callApi('/generateAuthResponse', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            method: input.method,
            endpoint: input.endpoint,
            isUrlPresigningRequest: true,
            expiresInSeconds: input.expiresInSeconds
          })
        })
        return ok(data)
      }
    },
    {
      name: 'invoke_aws_cli',
      description:
        'Run an AWS CLI command through SignBridge (AWS CLI passthrough mode) using any stored AWS profile. ' +
        'IMPORTANT: do NOT put --profile in the command for ec2_instance or irsa profiles — those credentials are ' +
        'handed to the CLI through the environment, and a named profile makes the CLI ignore it and read ~/.aws/config ' +
        'instead.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        command: z.string().describe('AWS CLI command, e.g. "s3 ls" or "sts get-caller-identity"')
      },
      handler: async input => {
        const data = await callApi('/invokeCommand', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            command: input.command
          })
        })
        return ok(data)
      }
    },
    {
      name: 'test_bearer_token',
      description:
        'Test a Bearer Token profile (static or OAuth2 fetch). For OAuth2 it fetches a fresh token and reports ' +
        'availableTokens plus recommendedTokenField (access_token for client_credentials, id_token for password). ' +
        'Fails if the required token for the grant is absent. Run this before relying on an OAuth2 bearer profile.',
      schema: {
        profileName: z.string()
      },
      handler: async input => {
        const data = await callApi('/testBearerTokenConnection', {
          options: withUser({ profileName: input.profileName, authnMode: 'rest_bearer_token' })
        })
        return ok(data)
      }
    },

    // -------------------------------------------------------------- profiles
    {
      name: 'list_profiles',
      description: 'List all stored profiles.',
      schema: {},
      handler: async () => ok(await callApi('/populateProfilesDetails', withUser()))
    },
    {
      name: 'check_profile_exists',
      description: 'Check whether a profile with the given name already exists.',
      schema: { profileName: z.string() },
      handler: async input =>
        ok(await callApi('/checkProfileExists', { profile: withUser({ profileName: input.profileName }) }))
    },
    {
      name: 'create_profile',
      description:
        'Create a new profile. Enable one or more auth mechanisms via the *Enabled flags and provide the matching fields. ' +
        'SSO: awsSsoUserEnabled + awsSsoStartUrl/awsSsoAccountId/awsSsoRoleName/ssoRegion. ' +
        'IAM: awsIamUserEnabled + awsAccessKeyId/awsSecretAccessKey/region. ' +
        'EC2 instance role: ec2InstanceEnabled + ec2Host/ec2SshUsername and EITHER ec2SshPrivateKey (+ optional ' +
        'ec2SshPrivateKeyPassphrase) OR ec2SshPassword — never both. Verify with test_ec2_connection. ' +
        'IRSA: irsaEnabled + irsaBaseProfileName/irsaClusterName/irsaNamespace/irsaServiceAccount/irsaRoleArn ' +
        '(irsaRegion defaults to us-east-1). Discover the values with list_irsa_clusters then ' +
        'list_irsa_service_accounts, confirm the role with describe_irsa_role, and verify with test_irsa_connection. ' +
        'Basic: restBasicAuthEnabled + basicAuthUsername/basicAuthPassword. ' +
        'Bearer: restBearerTokenEnabled + bearerTokenMode ("static"|"oauth2"). For static set bearerStaticToken; ' +
        'for oauth2 set bearerTokenEndpoint, bearerTokenFields (list of {key,value}), bearerTokenResponseField ("access_token"|"id_token"), ' +
        'and optionally bearerAutoRenewOnExpiry (regenerate an expired token automatically at invoke time). ' +
        'Tip: for oauth2, call test_bearer_token first — it reports which token the endpoint actually returns and the ' +
        'recommended bearerTokenResponseField (access_token for client_credentials, id_token for password).',
      schema: PROFILE_FIELDS,
      handler: async input => ok(await callApi('/addProfileDetails', { profile: withUser({ ...input }) }))
    },
    {
      name: 'update_profile',
      description: 'Update an existing profile. Same fields as create_profile; profileName selects the profile to update.',
      schema: PROFILE_FIELDS,
      handler: async input => ok(await callApi('/updateProfileDetails', { profile: withUser({ ...input }) }))
    },
    {
      name: 'delete_profile',
      description: 'Delete a stored profile by name.',
      schema: { profileName: z.string() },
      handler: async input =>
        ok(await callApi('/deleteProfileDetails', { profile: withUser({ profileName: input.profileName }) }))
    },

    // ------------------------------------------- EC2 / IRSA profile discovery
    //
    // These five are the "how do I fill in the form" tools. None of them accepts
    // a credential: the profile is named and the server resolves it, exactly like
    // run_sandbox. They post top-level bodies (not { options }) because that is
    // what the backend handlers read.
    {
      name: 'test_ec2_connection',
      description:
        'Test an EC2 instance-role profile end to end: SSH to the box, then read its IMDSv2 instance identity and ' +
        'instance-role credentials. Returns the instance metadata (instanceId, instanceType, accountId, region, ' +
        'availabilityZone), the attached role name, and MASKED credentials — never the secret or session token. ' +
        'On failure the message says why (host unreachable, SSH auth rejected, no role attached, IMDS blocked), which ' +
        'is what to report back to the user. Run this after create_profile to confirm the profile actually works.',
      schema: {
        profileName: z.string().describe('Name of a stored profile with ec2InstanceEnabled')
      },
      handler: async input => ok(await callApi('/testEc2Connection', withUser({ profileName: input.profileName })))
    },
    {
      name: 'list_irsa_clusters',
      description:
        'List the EKS clusters visible to a base AWS profile — step 1 of building an IRSA profile. baseProfileName is ' +
        'an ordinary sso_user/iam_user profile used ONLY to reach EKS and IAM; the IRSA profile it helps create signs ' +
        'with its own assumed-role credentials. region defaults to us-east-1. Requires eks:ListClusters.',
      schema: {
        baseProfileName: z.string(),
        baseAuthnMode: z.enum(['sso_user', 'iam_user']).optional(),
        region: z.string().optional().describe('Defaults to us-east-1')
      },
      handler: async input =>
        ok(await callApi('/listIrsaClusters', withUser({
          baseProfileName: input.baseProfileName,
          baseAuthnMode: input.baseAuthnMode,
          region: input.region
        })))
    },
    {
      name: 'list_irsa_service_accounts',
      description:
        'List a cluster\'s IRSA-annotated service accounts — step 2 of building an IRSA profile. Returns every service ' +
        'account carrying an eks.amazonaws.com/role-arn annotation, as { namespace, name, roleArn }, which is exactly ' +
        'the namespace / serviceAccount / roleArn triple create_profile needs. This talks to the Kubernetes API ' +
        'directly using an EKS-signed token, so kubectl is NOT required. Requires eks:DescribeCluster plus RBAC to ' +
        'list service accounts.',
      schema: {
        baseProfileName: z.string(),
        baseAuthnMode: z.enum(['sso_user', 'iam_user']).optional(),
        clusterName: z.string(),
        region: z.string().optional().describe('Defaults to us-east-1')
      },
      handler: async input =>
        ok(await callApi('/listIrsaServiceAccounts', withUser({
          baseProfileName: input.baseProfileName,
          baseAuthnMode: input.baseAuthnMode,
          clusterName: input.clusterName,
          region: input.region
        })))
    },
    {
      name: 'describe_irsa_role',
      description:
        'Read an IRSA role\'s trust policy — step 3, the one that catches a misconfiguration before it becomes a ' +
        'confusing AccessDenied. Returns the audience the role actually requires (usually sts.amazonaws.com), the ' +
        'trusted subjects, the OIDC providers, and — when namespace and serviceAccount are given — a subjectCheck ' +
        'saying whether system:serviceaccount:<ns>:<sa> is among them. If iam:GetRole is denied it still succeeds with ' +
        'trustPolicyReadable:false and the default audience, so profile creation is never blocked on this.',
      schema: {
        baseProfileName: z.string(),
        baseAuthnMode: z.enum(['sso_user', 'iam_user']).optional(),
        roleArn: z.string(),
        namespace: z.string().optional().describe('Give this with serviceAccount to get a subjectCheck'),
        serviceAccount: z.string().optional()
      },
      handler: async input =>
        ok(await callApi('/describeIrsaRole', withUser({
          baseProfileName: input.baseProfileName,
          baseAuthnMode: input.baseAuthnMode,
          roleArn: input.roleArn,
          namespace: input.namespace,
          serviceAccount: input.serviceAccount
        })))
    },
    {
      name: 'test_irsa_connection',
      description:
        'Test an IRSA profile end to end — step 4: mint a service-account token from the cluster and exchange it via ' +
        'sts:AssumeRoleWithWebIdentity. Returns the cluster, the token\'s subject, the audience used, and MASKED ' +
        'credentials — never the secret or session token. A failure here names the step that broke (cluster ' +
        'unreachable, RBAC denied the token request, or the role\'s trust policy rejected the subject/audience).',
      schema: {
        profileName: z.string().describe('Name of a stored profile with irsaEnabled')
      },
      handler: async input => ok(await callApi('/testIrsaConnection', withUser({ profileName: input.profileName })))
    },

    // --------------------------------------------------------------- history
    {
      name: 'list_history',
      description:
        'List invocation history (most recent first), optionally filtered by request label. ' +
        'Returns SUMMARY metadata only: method, profileName, authnMode, requestStatus, executedDate, requestLabel, ' +
        'and executionDetailsFileName. The executionDetailsFileName (e.g. "ABC123.json") is an internal id — ' +
        'it is NOT an endpoint or URL. It has no full endpoint/headers/body. ' +
        'To re-invoke or inspect a past request, call get_history_details with that id first to get the real endpoint.',
      schema: { requestLabel: z.string().optional() },
      handler: async input => {
        const payload = withUser()
        if (input.requestLabel) payload.requestLabel = input.requestLabel
        return ok(await callApi('/populateHistoryDetails', payload))
      }
    },
    {
      name: 'get_history_details',
      description:
        'Get the FULL stored request and response for a single history entry, given its id ' +
        '(the executionDetailsFileName from list_history, with or without the ".json" suffix). ' +
        'Returns { request: { endpoint, method, profileName, authnMode, headers, body, ... }, response: { ... } }. ' +
        'Use this to obtain the real endpoint/headers/body before re-invoking a past request — never guess the endpoint.',
      schema: { historyId: z.string().describe('History id / executionDetailsFileName (".json" optional)') },
      handler: async input =>
        ok(await callApi('/getHistoryDetailsForTheGivenRequest', { profile: withUser({ historyId: input.historyId }) }))
    },
    {
      name: 'delete_history',
      description: 'Delete a history entry by its historyId.',
      schema: { historyId: z.string() },
      handler: async input =>
        ok(await callApi('/deleteHistoryDetailsForTheGivenRequest', { profile: withUser({ historyId: input.historyId }) }))
    },
    {
      name: 'label_history',
      description: 'Apply a label to a history entry.',
      schema: { historyId: z.string(), requestLabel: z.string() },
      handler: async input =>
        ok(
          await callApi('/applyLabelForTheGivenRequest', {
            profile: withUser({ historyId: input.historyId, requestLabel: input.requestLabel })
          })
        )
    },
    {
      name: 'add_history_to_favorites',
      description: 'Save a history entry to favorites.',
      schema: { historyId: z.string() },
      handler: async input => ok(await callApi('/addHistoryToFavorites', withUser({ historyId: input.historyId })))
    },

    // ------------------------------------------------------------- favorites
    {
      name: 'list_favorites',
      description:
        'List favorite requests (summary metadata only), optionally filtered by request label. ' +
        'Like list_history, the executionDetailsFileName is an internal id, not an endpoint. ' +
        'Call get_favorite_details with that id to get the real endpoint/headers/body before re-invoking.',
      schema: { requestLabel: z.string().optional() },
      handler: async input => {
        const payload = withUser()
        if (input.requestLabel) payload.requestLabel = input.requestLabel
        return ok(await callApi('/populateFavoriteDetails', payload))
      }
    },
    {
      name: 'get_favorite_details',
      description:
        'Get the FULL stored request and response for a single favorite entry, given its id ' +
        '(the executionDetailsFileName from list_favorites, with or without ".json"). ' +
        'Returns { request: { endpoint, method, profileName, authnMode, headers, body, ... }, response: { ... } }.',
      schema: { favoriteId: z.string().describe('Favorite id / executionDetailsFileName (".json" optional)') },
      handler: async input =>
        ok(await callApi('/getFavoriteDetailsForTheGivenRequest', { profile: withUser({ favoriteId: input.favoriteId }) }))
    },
    {
      name: 'delete_favorite',
      description: 'Delete a favorite by its favoriteId.',
      schema: { favoriteId: z.string() },
      handler: async input =>
        ok(await callApi('/deleteFavoriteDetailsForTheGivenRequest', { profile: withUser({ favoriteId: input.favoriteId }) }))
    },
    {
      name: 'label_favorite',
      description: 'Apply a label to a favorite.',
      schema: { favoriteId: z.string(), requestLabel: z.string() },
      handler: async input =>
        ok(
          await callApi('/applyLabelForTheGivenFavoriteRequest', {
            profile: withUser({ favoriteId: input.favoriteId, requestLabel: input.requestLabel })
          })
        )
    },

    // ---------------------------------------------------- templates/collections
    {
      name: 'list_collections',
      description: 'List imported templates/collections, optionally filtered by request label.',
      schema: { requestLabel: z.string().optional() },
      handler: async input => {
        const payload = withUser()
        if (input.requestLabel) payload.requestLabel = input.requestLabel
        return ok(await callApi('/populateCollectionsDetails', payload))
      }
    },
    {
      name: 'import_collection',
      description: 'Import a Postman-style collection. collectionPayload must be a JSON string.',
      schema: {
        collectionName: z.string(),
        collectionPayload: z.string().describe('Collection JSON, as a string')
      },
      handler: async input =>
        ok(
          await callApi('/importCollection', withUser({
            collectionName: input.collectionName,
            collectionPayload: input.collectionPayload
          }))
        )
    },
    {
      name: 'delete_collection',
      description: 'Delete an imported collection by its importedCollectionName.',
      schema: { importedCollectionName: z.string() },
      handler: async input =>
        ok(await callApi('/deleteCollection', withUser({ importedCollectionName: input.importedCollectionName })))
    },
    {
      name: 'delete_collection_request',
      description:
        'Delete ONE request from an imported collection, leaving the rest of the collection in place. Identify it by ' +
        'the requestDetailsFileName that list_collections returns for that request — delete_collection removes the ' +
        'whole collection instead.',
      schema: { requestDetailsFileName: z.string().describe('From list_collections') },
      handler: async input =>
        ok(await callApi('/deleteRequestFromCollection', withUser({
          requestDetailsFileName: input.requestDetailsFileName
        })))
    },
    {
      name: 'list_aws_catalog_services',
      description:
        'List every AWS service SignBridge can generate a request collection for, from the bundled botocore index: ' +
        '{ service, label, apiVersion }. There are several hundred, so pass `search` to filter by service name or ' +
        'label. Feed a service name to import_aws_catalog_service to turn its whole API into ready-to-sign requests.',
      schema: { search: z.string().optional().describe('Case-insensitive filter, e.g. "dynamo"') },
      handler: async input => {
        const data = await callApi('/awsCatalogServices', null, { method: 'get' })
        const services = (data && data.services) || []
        const needle = String(input.search || '').trim().toLowerCase()
        if (!needle) return ok({ serviceCount: services.length, services })
        const matches = services.filter(
          s =>
            String(s.service || '').toLowerCase().includes(needle) ||
            String(s.label || '').toLowerCase().includes(needle)
        )
        return ok({ serviceCount: matches.length, searchedFor: input.search, services: matches })
      }
    },
    {
      name: 'import_aws_catalog_service',
      description:
        'Generate and import a collection for one AWS service, so every operation that service has becomes a ' +
        'ready-to-sign request in Templates. Take the service name from list_aws_catalog_services (e.g. "dynamodb"). ' +
        'The botocore model is fetched once and cached under the user\'s artifacts, so the first import of a large ' +
        'service takes a few seconds and later ones are instant. Returns the imported collection name and how many ' +
        'requests it holds.',
      schema: {
        service: z.string().describe('Service name from list_aws_catalog_services, e.g. "dynamodb"'),
        region: z.string().optional().describe('Region baked into the generated endpoints (default us-east-1)')
      },
      handler: async input =>
        ok(await callApi('/importAwsCatalogService', withUser({ service: input.service, region: input.region })))
    },

    // -------------------------------------------------------------- settings
    {
      name: 'get_settings',
      description: 'Get the current user settings.',
      schema: {},
      handler: async () => ok(await callApi('/populateSettingsDetails', withUser()))
    },
    {
      name: 'update_settings',
      description: 'Update user settings. Pass the settings object to merge/save.',
      schema: { settings: z.record(z.any()) },
      handler: async input => ok(await callApi('/updateSettingsDetails', withUser({ settings: input.settings })))
    },

    // ----------------------------------------------------------- sandbox mode
    {
      name: 'list_sandbox_runtimes',
      description:
        'List the languages Sandbox mode can run (python, javascript, typescript, java) with their starter templates, ' +
        'the execution limits, and whether the sandbox is actually ready (Docker reachable + image built). ' +
        'Call this FIRST: if preflight.ok is false, run_sandbox will fail and the message says what to set up.',
      schema: {},
      handler: async () => ok(await callApi('/sandboxRuntimes', withUser()))
    },
    {
      name: 'get_sandbox_template',
      description:
        'Get runnable starter code for a Sandbox language. Use it as the base for run_sandbox rather than writing ' +
        'boilerplate from scratch — the template already builds the SDK client the way the sandbox expects.',
      schema: {
        runtimeId: z.enum(SANDBOX_RUNTIMES),
        templateId: z.string().optional().describe('Template id from list_sandbox_runtimes; defaults to the first')
      },
      handler: async input =>
        ok(await callApi('/sandboxTemplate', withUser({ runtimeId: input.runtimeId, templateId: input.templateId })))
    },
    {
      name: 'run_sandbox',
      description:
        'Run code against AWS in a throwaway container, using a stored profile\'s credentials. This is the ' +
        'code-first alternative to invoke_api: instead of hand-signing one request, write a few lines of boto3 / the ' +
        'AWS SDK / the Java SDK and get its real output. The SDKs are preinstalled; the profile\'s credentials are ' +
        'injected as environment variables, so do NOT put keys in the code. Prefer this for anything multi-step ' +
        '(paginate, filter, then summarize) and invoke_api for a single raw HTTP call. ' +
        'Returns stdout, stderr, exitCode, plus diagnostics (line/column of any error) and remedies. ' +
        'Requires an AWS profile (iam_user/sso_user) to reach AWS; without one the code still runs but has no ' +
        'credentials. Network is available; the workspace is read-only and the container is destroyed afterwards.',
      schema: {
        runtimeId: z.enum(SANDBOX_RUNTIMES),
        code: z.string().describe('The complete program to run (a single file)'),
        profileName: z.string().optional().describe('Stored profile whose credentials to inject'),
        authnMode: z.enum(AWS_AUTHN_MODES).optional().describe('Required with profileName for AWS access'),
        region: z.string().optional().describe('Overrides the profile region (default us-east-1)')
      },
      handler: async input =>
        ok(await callApi('/runSandbox', withUser({
          runtimeId: input.runtimeId,
          code: input.code,
          profileName: input.profileName,
          authnMode: input.authnMode,
          region: input.region
        })))
    },
    {
      name: 'check_sandbox',
      description:
        'Syntax/type-check Sandbox code WITHOUT running it (py_compile / node --check / tsc / javac). No credentials ' +
        'and no network, so it is cheap and safe to call repeatedly. Returns diagnostics with line, column, message ' +
        'and a suggested fix. Use this to fix your own code before spending a run.',
      schema: {
        runtimeId: z.enum(SANDBOX_RUNTIMES),
        code: z.string()
      },
      handler: async input =>
        ok(await callApi('/checkSandbox', withUser({ runtimeId: input.runtimeId, code: input.code })))
    },
    {
      name: 'list_sandbox_scripts',
      description: 'List saved Sandbox scripts (id, name, language, last run). Use get_sandbox_script for the code.',
      schema: {},
      handler: async () => ok(await callApi('/listSandboxScripts', withUser()))
    },
    {
      name: 'get_sandbox_script',
      description: 'Get a saved Sandbox script by id, including its full code and the profile it was last run with.',
      schema: { scriptId: z.string().describe('From list_sandbox_scripts') },
      handler: async input => ok(await callApi('/getSandboxScript', withUser({ scriptId: input.scriptId })))
    },
    {
      name: 'save_sandbox_script',
      description:
        'Save a Sandbox script so it appears in the dashboard\'s Sandbox page. Omit scriptId to create a new one; ' +
        'pass an existing scriptId to update it in place.',
      schema: {
        runtimeId: z.enum(SANDBOX_RUNTIMES),
        code: z.string(),
        name: z.string().optional().describe('Display name; defaults to "Untitled <Language>"'),
        scriptId: z.string().optional().describe('Update this script instead of creating a new one'),
        profileName: z.string().optional(),
        authnMode: z.enum(AWS_AUTHN_MODES).optional()
      },
      handler: async input =>
        ok(await callApi('/saveSandboxScript', withUser({
          scriptId: input.scriptId,
          runtimeId: input.runtimeId,
          code: input.code,
          name: input.name,
          profileName: input.profileName,
          authnMode: input.authnMode
        })))
    },
    {
      name: 'delete_sandbox_script',
      description: 'Permanently delete a saved Sandbox script by its id.',
      schema: { scriptId: z.string().describe('From list_sandbox_scripts') },
      handler: async input => ok(await callApi('/deleteSandboxScript', withUser({ scriptId: input.scriptId })))
    },

    // -------------------------------------------------------------- S3 World
    // The point of these, versus `invoke_aws_cli` with "s3 ls": preview_s3_object
    // returns an object's *contents* as structured JSON — a parquet file as rows,
    // a gzipped log as text, a tarball as a file list — and search_s3_objects
    // finds a key by any fragment of its name anywhere in a subtree, which
    // `aws s3 ls` cannot do.
    {
      name: 'list_s3_buckets',
      description:
        'List the S3 buckets an AWS profile can see, with each bucket\'s creation date. Start here when the user ' +
        'names no bucket, or names one only approximately.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user')
      },
      handler: async input =>
        ok(await callApi('/s3ListBuckets', {
          options: withUser({ profileName: input.profileName, authnMode: input.authnMode })
        }))
    },
    {
      name: 'list_s3_objects',
      description:
        'List one page of a bucket "folder": sub-folders (common prefixes) and objects, each with size, last-modified, ' +
        'storage class, resolved content type and whether it can be viewed. Pass the returned continuationToken to get ' +
        'the next page. delimiter defaults to "/" (folder view); pass "" to flatten the entire subtree. ' +
        'To FIND something by name, use search_s3_objects instead of paging through this.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        prefix: z.string().optional().describe('Folder to list, e.g. "logs/2026/" — empty for the bucket root'),
        delimiter: z.string().optional().describe('"/" for a folder view (default), "" to flatten the subtree'),
        maxKeys: z.number().int().min(1).max(1000).optional(),
        continuationToken: z.string().optional().describe('From a previous page of this same request')
      },
      handler: async input =>
        ok(await callApi('/s3ListObjects', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            prefix: input.prefix || '',
            delimiter: input.delimiter,
            maxKeys: input.maxKeys,
            continuationToken: input.continuationToken
          })
        }))
    },
    {
      name: 'search_s3_objects',
      description:
        'Find objects anywhere under a prefix by name. Unlike the AWS console (and `aws s3 ls`), matching is ' +
        'case-insensitive, matches any part of the key rather than only its start, and walks every sub-folder. ' +
        'Query syntax: bare words must all appear somewhere in the key; "quoted phrase" for an exact phrase; ' +
        '*.parquet for a glob on the name; -word to exclude; ext:csv,tsv by extension; size>10mb / size<1kb; ' +
        'modified>7d for recent changes. Returns matches (with full keys) plus how many keys were scanned and, when a ' +
        'limit stopped the walk, a stopReason — narrow the prefix if so. Unless scope is "name", the result also ' +
        'carries folders: every directory whose path matched, with its object count and total size — which is the ' +
        'right answer to "where is the X folder?" and is not expressible as `aws s3 ls`.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        query: z.string().describe('e.g. "report q3", "*.parquet -backup", "ext:csv size>10mb"'),
        prefix: z.string().optional().describe('Restrict the walk to this subtree — the fastest way to narrow a search'),
        scope: z.enum(['name', 'folder', 'both']).optional().describe(
          'What the query is matched against: "name" the object\'s own file name, "folder" the directory path it ' +
          'sits in, "both" the whole key (default). Use "folder" when the user is looking for a directory rather ' +
          'than a file, and "name" when a folder name would be a false positive.'
        ),
        caseSensitive: z.boolean().optional().describe('Default false; case-insensitive matching'),
        maxMatches: z.number().int().min(1).max(5000).optional(),
        maxKeysScanned: z.number().int().min(1000).optional().describe('Safety limit on how many keys to walk')
      },
      handler: async input =>
        ok(await callApi('/s3SearchObjects', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            query: input.query,
            prefix: input.prefix || '',
            scope: input.scope,
            caseSensitive: input.caseSensitive,
            maxMatches: input.maxMatches,
            maxKeysScanned: input.maxKeysScanned
          })
        }))
    },
    {
      name: 'explain_s3_search',
      description:
        'Explain how a search_s3_objects query will be interpreted — the parsed terms, the filters, the scope and any ' +
        'notes — WITHOUT walking the bucket. It touches no credentials and makes no S3 call, so it is free. Worth a ' +
        'call before an expensive search, because the query language deliberately degrades anything unparseable to a ' +
        'plain substring term rather than erroring: this is how to tell that "size>10mb" became a size filter and not ' +
        'a search for the literal text.',
      schema: {
        query: z.string(),
        scope: z.enum(['name', 'folder', 'both']).optional(),
        caseSensitive: z.boolean().optional()
      },
      handler: async input =>
        ok(await callApi('/s3ExplainSearch', {
          options: withUser({
            query: input.query,
            scope: input.scope,
            caseSensitive: input.caseSensitive
          })
        }))
    },
    {
      name: 'head_s3_object',
      description:
        'Get an object\'s metadata plus the type SignBridge resolved for it (from the extension, its magic bytes, or the ' +
        'stored Content-Type) and how it should be opened: "preview" (decodable — use preview_s3_object), "tab" ' +
        '(natively renderable — use presign_s3_object) or "download" (e.g. Glacier, not restored). Cheap; call it ' +
        'before preview_s3_object on an object of unknown type.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        key: z.string(),
        versionId: z.string().optional()
      },
      handler: async input =>
        ok(await callApi('/s3HeadObject', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            key: input.key,
            versionId: input.versionId
          })
        }))
    },
    {
      name: 'preview_s3_object',
      description:
        'READ AN OBJECT\'S CONTENTS without downloading it. The server decodes the object and returns structured JSON: ' +
        'preview.kind is "table" (csv/tsv/parquet/ndjson — with columns and rows), "json", "xml" (a parsed element ' +
        'tree in preview.root), "yaml" (parsed documents in preview.documents), "text" (including gzipped ' +
        'text and logs), "markdown", "sheets" (xlsx), "document" (docx/pptx), "notebook" (ipynb), "archive" (zip/tar ' +
        'file listing) or "hex" (binary). Only the first slice of the object is read, so previewing a multi-gigabyte ' +
        'file is cheap; preview.truncated says whether more remains. Use this to answer questions about what is IN a ' +
        'file. Images, PDF, video and audio have no textual preview — presign them instead.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        key: z.string(),
        versionId: z.string().optional(),
        maxRows: z.number().int().min(1).max(5000).optional().describe('Row cap for tabular formats')
      },
      handler: async input =>
        ok(await callApi('/s3PreviewObject', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            key: input.key,
            versionId: input.versionId,
            maxRows: input.maxRows
          })
        }))
    },
    {
      name: 'presign_s3_object',
      description:
        'Presigned URL for one S3 object, for sharing or for opening in a browser. disposition "inline" makes the ' +
        'browser render it (with a signed content-type override, so an image stored as application/octet-stream still ' +
        'displays); "attachment" makes it download. Anything scriptable (HTML, SVG, XML) is always served as an ' +
        'attachment. For SSO profiles the lifetime is capped to the session credential\'s remaining life, and the ' +
        'response says so in `note`.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        key: z.string(),
        versionId: z.string().optional(),
        disposition: z.enum(['inline', 'attachment']).default('inline'),
        expiresInSeconds: z.number().int().min(60).max(43200).default(3600)
      },
      handler: async input =>
        ok(await callApi('/s3PresignView', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            key: input.key,
            versionId: input.versionId,
            disposition: input.disposition,
            expiresInSeconds: input.expiresInSeconds
          })
        }))
    },
    {
      name: 'create_s3_folder',
      description:
        'Create a folder in a bucket by writing the zero-byte marker object S3 uses for one ("prefix/name/").',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        folderName: z.string(),
        prefix: z.string().optional().describe('Parent folder; empty for the bucket root')
      },
      handler: async input =>
        ok(await callApi('/s3CreateFolder', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            folderName: input.folderName,
            prefix: input.prefix || ''
          })
        }))
    },
    {
      name: 'upload_s3_object',
      description:
        'Write an object to S3. Pass UTF-8 text in `content`, or binary as base64 in `contentBase64` — exactly one of ' +
        'the two. The server resolves a real Content-Type from the key and the leading bytes, so the object is ' +
        'viewable afterwards instead of landing as application/octet-stream. This OVERWRITES an existing key with no ' +
        'warning: call head_s3_object first if that matters. Limited to 100 MB, and base64 inside a tool call is an ' +
        'expensive way to move a large file — for those, prefer Sandbox mode (run_sandbox) or the AWS CLI ' +
        '(invoke_aws_cli), which stream from disk.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        key: z.string().describe('Full destination key, e.g. "logs/2026/app.log"'),
        content: z.string().optional().describe('UTF-8 text to write'),
        contentBase64: z.string().optional().describe('Base64-encoded bytes, for anything not text'),
        contentType: z.string().optional().describe('Overrides the type resolved from the key and bytes')
      },
      handler: async input => {
        // Exactly one body source. Both, or neither, is a mistake worth naming:
        // silently preferring one would write an object the caller did not intend.
        // Note '' is a legitimate body — a zero-byte object is a real thing in S3.
        if ((input.content == null) === (input.contentBase64 == null)) {
          return fail(new Error(
            'Provide exactly one of content (UTF-8 text) or contentBase64 (binary bytes).'))
        }
        const body = input.contentBase64 != null
          ? Buffer.from(input.contentBase64, 'base64')
          : Buffer.from(String(input.content), 'utf8')
        // The one non-POST-JSON route: the bytes are the body, so the parameters
        // ride on the query string (see the s3UploadObject mount in server.js).
        return ok(await callApi('/s3UploadObject', body, {
          method: 'put',
          contentType: 'application/octet-stream',
          query: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            key: input.key,
            contentType: input.contentType
          })
        }))
      }
    },
    {
      name: 'delete_s3_objects',
      description:
        'Permanently delete objects. `keys` deletes exactly those objects; `prefixes` deletes EVERY key under each ' +
        'prefix, recursively. This cannot be undone (unless the bucket has versioning) — confirm with the user first, ' +
        'and prefer listing what will be deleted before deleting it.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string(),
        keys: z.array(z.string()).optional().describe('Exact object keys'),
        prefixes: z.array(z.string()).optional().describe('Delete everything under each of these, recursively')
      },
      handler: async input =>
        ok(await callApi('/s3DeleteObjects', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            keys: input.keys || [],
            prefixes: input.prefixes || []
          })
        }))
    },
    {
      name: 'copy_s3_objects',
      description:
        'Copy objects within a bucket, or to another bucket the profile can write. Set move=true to delete the ' +
        'originals after a successful copy (only what actually copied is deleted). Each item is {key} — the name is ' +
        'reused under destinationPrefix — or {key, destinationKey} to rename.',
      schema: {
        profileName: z.string(),
        authnMode: z.enum(AWS_AUTHN_MODES).default('sso_user'),
        bucket: z.string().describe('Source bucket'),
        items: z
          .array(z.object({ key: z.string(), destinationKey: z.string().optional() }))
          .describe('Objects to copy'),
        destinationPrefix: z.string().optional().describe('Target folder, e.g. "archive/2026/"'),
        destinationBucket: z.string().optional().describe('Defaults to the source bucket'),
        move: z.boolean().optional().describe('Delete the originals after copying')
      },
      handler: async input =>
        ok(await callApi('/s3CopyObjects', {
          options: withUser({
            profileName: input.profileName,
            authnMode: input.authnMode,
            bucket: input.bucket,
            items: input.items,
            destinationPrefix: input.destinationPrefix || '',
            destinationBucket: input.destinationBucket,
            move: !!input.move
          })
        }))
    },

    // --------------------------------------------------------- chat sessions
    {
      name: 'list_chat_sessions',
      description:
        'List saved AI chat sessions (most-recently-updated first) as summaries: threadId, title, messageCount, ' +
        'createdAt, updatedAt. Use a threadId with rename/summarize/delete_chat_session.',
      schema: {},
      handler: async () => ok(await callApi('/chatThreads', withUser()))
    },
    {
      name: 'get_chat_session',
      description:
        'Read a saved chat session: its title, timestamps, and the user/assistant messages in order (the tool-call ' +
        'plumbing is omitted). Use this to pick up what a past session actually established, rather than ' +
        'summarize_chat_session, which spends an LLM call to paraphrase it.',
      schema: { threadId: z.string().describe('The chat session id (from list_chat_sessions)') },
      handler: async input => ok(await callApi('/chatThread', withUser({ threadId: input.threadId })))
    },
    {
      name: 'rename_chat_session',
      description: 'Rename a saved chat session (its sidebar title). Provide the threadId and the new title.',
      schema: {
        threadId: z.string().describe('The chat session id (from list_chat_sessions)'),
        title: z.string().describe('New session title (max 120 chars)')
      },
      handler: async input =>
        ok(await callApi('/chatRenameThread', withUser({ threadId: input.threadId, title: input.title })))
    },
    {
      name: 'summarize_chat_session',
      description:
        'Summarize a saved chat session: what was asked, which profiles/endpoints/tools were used, and outcomes. ' +
        'Provide the threadId (from list_chat_sessions). No API key is needed — if SignBridge has no AI provider ' +
        'configured it returns the transcript with instructions for you to summarize it yourself.',
      schema: { threadId: z.string().describe('The chat session id to summarize') },
      handler: async input => {
        try {
          return ok(await callApi('/chatSummarizeThread', withUser({ threadId: input.threadId })))
        } catch (err) {
          if (!isLlmSetupError(err)) throw err
          // The one tool in this set that needed SignBridge's own AI provider key,
          // and the only one where that requirement was absurd: whoever is calling
          // is already a language model. Asking it to make us pay a second model to
          // paraphrase a transcript it can read itself is a 503 for no benefit — so
          // hand back the transcript and let the caller do the summarizing.
          const thread = await callApi('/chatThread', withUser({ threadId: input.threadId }))
          return ok({
            threadId: input.threadId,
            title: thread && thread.title,
            summary: null,
            summarizedBy: 'caller',
            reason:
              'SignBridge has no AI provider configured, so it did not write the summary itself. ' +
              'Nothing is wrong and nothing needs configuring — the transcript is below.',
            instruction:
              'Summarize the session below in a short paragraph or up to 5 bullet points: what the user asked, ' +
              'which profiles, endpoints and tools were used, and the outcomes. Use Markdown. ' +
              'Do not invent details that are not in the transcript.',
            messages: (thread && thread.messages) || []
          })
        }
      }
    },
    {
      name: 'delete_chat_session',
      description: 'Permanently delete a saved chat session by its threadId (from list_chat_sessions).',
      schema: { threadId: z.string().describe('The chat session id to delete') },
      handler: async input => ok(await callApi('/chatDeleteThread', withUser({ threadId: input.threadId })))
    },

    // ------------------------------------------------------- llm configuration
    // Read + model selection only. Supplying, creating or deleting a provider API
    // key is deliberately NOT exposed: those endpoints exist, but an MCP client is
    // an LLM, and no tool here should let it write a credential or mint one on the
    // user's account. Key management stays on the Settings page, where a human is.
    {
      name: 'list_llm_providers',
      description:
        'List the AI providers SignBridge can use for its own chat features, and the current LLM settings: which ' +
        'provider is active, which model is selected, which providers have a verified key, and how many models each ' +
        'offers. Returns no API keys (only a masked hint). Read-only.',
      schema: {},
      handler: async () => ok(await callApi('/llmSettings', withUser()))
    },
    {
      name: 'list_llm_models',
      description:
        'List the chat models a provider\'s stored key can actually use (id, label, context length, pricing where the ' +
        'provider reports it). Requires that provider to already have a verified key — set that up in Settings. ' +
        'Use the ids with set_llm_model.',
      schema: {
        providerId: z
          .string()
          .describe('Provider id from list_llm_providers, e.g. openai, anthropic, openrouter')
      },
      handler: async input => ok(await callApi('/listLlmModels', withUser({ providerId: input.providerId })))
    },
    {
      name: 'set_llm_model',
      description:
        'Choose the provider + model SignBridge uses for its AI features. The selection is persisted, so it applies ' +
        'to the Chat page and every other LLM-backed feature — not just the current conversation. Pass a model id ' +
        'from list_llm_models; omit providerId to change the model on the provider already active.',
      schema: {
        model: z.string().describe('Model id from list_llm_models'),
        providerId: z
          .string()
          .optional()
          .describe('Provider id; defaults to the currently active provider')
      },
      handler: async input =>
        ok(
          await callApi(
            '/selectLlmModel',
            withUser({ model: input.model, providerId: input.providerId })
          )
        )
    }
  ]
}

// Register all tools onto an McpServer instance. Handlers are wrapped so a
// thrown API error becomes an MCP error result rather than crashing the server.
export function registerTools(server, ctx) {
  const tools = buildTools(ctx)
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema, async input => {
      try {
        return await tool.handler(input)
      } catch (err) {
        return fail(err)
      }
    })
  }
  return tools.map(t => t.name)
}

// Convert a tool's zod raw shape to a JSON Schema object suitable for OpenAI
// function-calling. An empty shape becomes an empty-properties object schema.
function toolParametersSchema(shape) {
  if (!shape || Object.keys(shape).length === 0) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  // Use the default JSON Schema target (not 'openAi'): we do NOT use strict
  // function-calling, so optional fields must stay out of `required` — otherwise
  // the model is forced to supply e.g. a request body on a GET.
  const jsonSchema = zodToJsonSchema(z.object(shape), { $refStrategy: 'none' })
  // zod-to-json-schema adds a top-level $schema key OpenAI doesn't need.
  delete jsonSchema.$schema
  return jsonSchema
}

// Build the same 21 tools as OpenAI-compatible function-calling definitions,
// plus a name->handler map. This is what the AI chat agent uses so it has full
// dashboard/MCP parity from a single source of truth.
//
// Returns { definitions, handlers } where:
//   definitions — array of { type:'function', function:{ name, description, parameters } }
//   handlers    — { [name]: async (input) => rawApiData }  (returns the API JSON,
//                  NOT the MCP content wrapper, so the agent can inspect it)
export function buildOpenAiTools(ctx) {
  const tools = buildTools(ctx)
  const definitions = tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolParametersSchema(tool.schema)
    }
  }))
  const handlers = {}
  for (const tool of tools) {
    // Unwrap the MCP content envelope: the agent wants the raw API payload.
    handlers[tool.name] = async input => {
      const result = await tool.handler(input)
      if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
        try {
          return JSON.parse(result.content[0].text)
        } catch (e) {
          return result.content[0].text
        }
      }
      return result
    }
  }
  return { definitions, handlers }
}
