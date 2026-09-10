// SignBridge MCP server — Streamable HTTP transport.
//
// Mounted INSIDE the Express server (see server.js) so a single `node server.js`
// process serves the UI, the REST API, and MCP together on the same port.
// AI clients that speak Streamable HTTP connect to {routeBase}/mcp.
//
// Runs statelessly: a fresh McpServer + transport is created per request, which
// keeps it simple and avoids session bookkeeping. Tool definitions are shared
// with the stdio server via tools.mjs.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import axios from 'axios'
import https from 'https'

import { registerTools } from './tools.mjs'

// Returns an Express handler for POST {routeBase}/mcp.
//   opts.apiBase  — base URL of this server's own API (e.g. https://localhost:2443/signbridge)
//   opts.userName — the single local user name
export function createMcpHttpHandler(opts) {
  const apiBase = opts.apiBase
  const userName = opts.userName
  // Loopback call to our own HTTPS API (self-signed cert).
  const httpsAgent = new https.Agent({ rejectUnauthorized: false })

  // Same contract as the stdio server's callApi (see mcp/server.js): POST with a
  // JSON body unless `options` names a method, query parameters or a raw body's
  // Content-Type. Both transports share tools.mjs, so both have to accept it.
  async function callApi(pathName, payload, options) {
    const opts = options || {}
    const method = (opts.method || 'post').toLowerCase()
    const config = { httpsAgent }
    if (opts.query) config.params = opts.query
    if (opts.contentType) {
      config.headers = { 'Content-Type': opts.contentType }
      config.maxBodyLength = Infinity
      config.maxContentLength = Infinity
    }
    try {
      const url = `${apiBase}${pathName}`
      const response = method === 'get'
        ? await axios.get(url, config)
        : await axios[method](url, payload, config)
      return response.data
    } catch (err) {
      // statusCode + apiData travel with the error for the same reason they do in
      // mcp/server.js: a tool may have a better answer for one specific failure.
      const apiMessage = err.response && err.response.data && err.response.data.message
      const wrapped = new Error(apiMessage || err.message)
      wrapped.apiMessage = apiMessage
      wrapped.statusCode = (err.response && err.response.status) || 0
      wrapped.apiData = (err.response && err.response.data) || null
      throw wrapped
    }
  }

  function buildServer() {
    const server = new McpServer({ name: 'signbridge-signbridge', version: '1.0.0' })
    registerTools(server, { callApi, userName })
    return server
  }

  return async function handleMcpRequest(req, res) {
    // Stateless: new server + transport per request.
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      console.error('MCP HTTP request error:', err.message)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        })
      }
    }
  }
}
