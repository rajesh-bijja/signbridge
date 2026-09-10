#!/usr/bin/env node
// SignBridge MCP server — stdio transport.
//
// For AI tools that spawn an MCP server over stdio (Claude Desktop, Cursor,
// Codex). It is a thin client of the SignBridge HTTPS API; all tool
// definitions live in tools.mjs and are shared with the in-process HTTP
// transport (mcpHttp.mjs) mounted inside the Express server.
//
// If you prefer a single service, the HTTP transport at
// {API_BASE}/mcp is served by `node server.js` directly — no separate process.
//
// This file is also the published package's entry point (`npx signbridge-mcp`),
// which is why it depends on nothing outside mcp/: an installed copy has this
// file, tools.mjs and three npm packages, and no access to the repository. Adding
// an import of ../lib would work locally and break every installed client, so
// test/mcpPackaging.test.js forbids it.
//
// STDOUT IS THE JSON-RPC CHANNEL. A single stray console.log corrupts the stream
// and the client reports the server as broken, with nothing pointing at the print
// statement. Diagnostics go to stderr, which MCP clients surface in their logs.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import axios from 'axios'
import https from 'https'

import { registerTools } from './tools.mjs'

const VERSION = '1.0.0'
const API_BASE = process.env.SIGNBRIDGE_API_BASE || 'https://localhost:2443/signbridge'
const USER_NAME = process.env.SIGNBRIDGE_USER || 'signbridgeuser'

// The SignBridge server generates its own self-signed certificate on first run,
// so its cert is not in any trust store. Scoping the exception to this one agent
// is the whole point: NODE_TLS_REJECT_UNAUTHORIZED=0 would also disable
// verification for anything else this process talks to.
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

const USAGE = `signbridge-mcp ${VERSION} — MCP stdio server for SignBridge

Speaks MCP over stdin/stdout, so it is normally launched by an AI client rather
than by hand. It is a client of a running SignBridge instance; start that first
(docker compose up -d).

Environment:
  SIGNBRIDGE_API_BASE   SignBridge API base URL
                        (default ${API_BASE})
  SIGNBRIDGE_USER       SignBridge user name whose profiles and history to use
                        (default ${USER_NAME})

Client configuration (Claude Desktop, Cursor, Codex, ...):
  {
    "mcpServers": {
      "signbridge": {
        "command": "npx",
        "args": ["-y", "signbridge-mcp"],
        "env": { "SIGNBRIDGE_API_BASE": "https://localhost:2443/signbridge" }
      }
    }
  }

Options:
  --help, -h        print this and exit
  --version, -v     print the version and exit
`

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(VERSION + '\n')
  process.exit(0)
}

// A connection-level failure is the one error every user of this package hits
// first, and by default it arrives as "connect ECONNREFUSED 127.0.0.1:2443" —
// which the model relays as though the tool were broken. Name the actual cause.
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET',
  'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'
])

function describeTransportError(err) {
  if (!CONNECTION_CODES.has(err.code)) {
    return null
  }
  return `Cannot reach SignBridge at ${API_BASE} (${err.code}). Start SignBridge`
    + ' (docker compose up -d), or set'
    + ' SIGNBRIDGE_API_BASE if it is listening elsewhere. This is a connection'
    + ' failure, not a rejected request — no credentials or permissions are involved.'
}

// callApi(path, payload[, options]) — POST with a JSON body by default, which is
// what all but two routes are. `options` covers the exceptions rather than making
// every tool spell out a method it does not care about:
//   method      'post' (default) | 'get' | 'put'
//   query       query-string parameters (the upload route carries its parameters
//               there, because a raw-body route cannot also carry JSON)
//   contentType Content-Type for a raw (Buffer) body
async function callApi(pathName, payload, options) {
  const opts = options || {}
  const method = (opts.method || 'post').toLowerCase()
  const config = { httpsAgent }
  if (opts.query) config.params = opts.query
  if (opts.contentType) {
    config.headers = { 'Content-Type': opts.contentType }
    // A raw body is a file upload; axios would otherwise cap it well below the
    // server's own limit and report a client-side error that looks like a refusal.
    config.maxBodyLength = Infinity
    config.maxContentLength = Infinity
  }
  try {
    const url = `${API_BASE}${pathName}`
    const response = method === 'get'
      ? await axios.get(url, config)
      : await axios[method](url, payload, config)
    return response.data
  } catch (err) {
    // Surface the API's error message to the tool caller — plus the status and the
    // body, because some tools have a useful answer for a *particular* failure and
    // cannot tell which one it was from a message string. (summarize_chat_session
    // reads needsLlmSetup off apiData to fall back to the caller's own model.)
    const apiMessage = err.response && err.response.data && err.response.data.message
    const wrapped = new Error(apiMessage || describeTransportError(err) || err.message)
    wrapped.apiMessage = apiMessage
    wrapped.statusCode = (err.response && err.response.status) || 0
    wrapped.apiData = (err.response && err.response.data) || null
    throw wrapped
  }
}

const server = new McpServer({
  name: 'signbridge',
  version: VERSION
})

const toolNames = registerTools(server, { callApi, userName: USER_NAME })

const transport = new StdioServerTransport()
await server.connect(transport)

process.stderr.write(
  `signbridge-mcp ${VERSION}: ${toolNames.length} tools, API ${API_BASE}, user ${USER_NAME}\n`)

// Report an unreachable server once, at startup, rather than only on the first
// tool call — but do NOT exit over it. Clients spawn this process on their own
// schedule, often before SignBridge is up, and a client that sees the server exit
// marks it failed until the user notices and reconnects.
axios.get(`${API_BASE}/session`, { httpsAgent, timeout: 4000 })
  .catch(err => {
    const message = describeTransportError(err)
    if (message) process.stderr.write('signbridge-mcp: ' + message + '\n')
  })
