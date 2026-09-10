# signbridge-mcp

MCP server for [SignBridge](../README.md) — presign and invoke AWS SigV4 and REST
APIs, browse and read S3 objects, and run sandboxed code, from Claude Desktop,
Cursor, Codex or any other MCP client.

It is a **client of a running SignBridge instance**, not a standalone tool: it
holds no credentials and signs nothing itself. Every tool call is forwarded to
SignBridge's local HTTPS API, which resolves the named profile (IAM user, AWS SSO
role, EC2 instance role, or EKS IRSA service account) and does the work. So an
MCP tool call behaves exactly like the same action in the dashboard, and the
credentials never leave that process.

## Requirements

A running SignBridge — see the [main README](../README.md):

```bash
docker compose up --build -d
```

That is all. **No AI provider API key is needed for any tool here.** The key you
see in SignBridge's Settings → AI features buys inference for its own Chat page,
which has no model of its own — over MCP, your client is the model. These tools
only sign AWS requests and read local state.

## Configure your client

Nothing to install. Point the client at `npx`:

```json
{
  "mcpServers": {
    "signbridge": {
      "command": "npx",
      "args": ["-y", "signbridge-mcp"],
      "env": {
        "SIGNBRIDGE_API_BASE": "https://localhost:2443/signbridge",
        "SIGNBRIDGE_USER": "signbridgeuser"
      }
    }
  }
}
```

Both variables have those values as defaults, so `"env"` can be omitted for a
default install. There is no API key: SignBridge has no login, and this server
talks only to localhost.

Straight from a clone, without npm:

```json
{ "command": "node", "args": ["/absolute/path/to/signbridge/mcp/server.js"] }
```

Or from the GitHub repository without cloning:

```json
{
  "mcpServers": {
    "signbridge": {
      "command": "npx",
      "args": ["-y", "github:rajesh-bijja/signbridge"]
    }
  }
}
```

No subdirectory suffix: npm cannot install one directory of a repository, and
accepts `#main::path:mcp` while quietly installing the root anyway. So the root
declares this same bin. It does mean a git install builds the whole backend's
dependencies instead of the four used here.

Register **one** of these forms — two entries give your client two copies of
every tool.

### If you prefer one process

SignBridge also serves MCP over Streamable HTTP from the app itself, at
`http://localhost:2444/signbridge/mcp` — same tools, nothing extra to launch. That
port has no TLS and listens on loopback only, because MCP clients connect with
Node's `fetch`, which rejects SignBridge's self-signed certificate and says only
`fetch failed`. (`https://localhost:2443/signbridge/mcp` serves the same endpoint
for a client that can trust the cert.)

Use this stdio package for clients that only spawn local commands.

## Checking it works

```bash
npx signbridge-mcp --help      # usage and environment
npx signbridge-mcp --version
```

Running it with no arguments is correct but looks like a hang: it is waiting for
JSON-RPC on stdin. It prints one line to **stderr** naming the tool count, the API
base and the user; if SignBridge is unreachable it says so there too, and MCP
clients show that in their server logs. It keeps running either way, so starting
SignBridge afterwards needs no reconnect.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIGNBRIDGE_API_BASE` | `https://localhost:2443/signbridge` | Base URL of the SignBridge API |
| `SIGNBRIDGE_USER` | `signbridgeuser` | Whose profiles, history and settings to use |

SignBridge's certificate is self-signed and generated on first run, so this
server trusts it through its own HTTPS agent. Do **not** set
`NODE_TLS_REJECT_UNAUTHORIZED=0` — it is unnecessary here and disables
certificate verification for everything else the process talks to.

## What the tools cover

Full parity with the dashboard, in eleven groups: invoke and presign (all auth
mechanisms, plus AWS CLI passthrough), Sandbox (run or type-check Python /
JavaScript / TypeScript / Java against a profile's credentials), S3 World (list,
recursive search, read decoded object contents, upload, copy, delete), profiles,
EC2 and IRSA discovery, history, favorites, templates and the AWS service
catalog, settings, LLM model selection, and chat sessions.

There is deliberately no `chat` tool — your client would be paying a second model
to reach tools it already has. And `summarize_chat_session`, which reads a saved
Chat-page session, hands you the transcript to summarize yourself when SignBridge
has no provider configured, rather than failing and pointing at a Settings page
you may not be able to open.

Two things are deliberately **not** exposed, because a tool result becomes part of
the model's conversation history and with a hosted client leaves the machine:
anything whose entire return value is a live credential (the bearer-token copy,
the STS-triple fetch, and the "copy as curl" command, which carries a signed
`Authorization` header), and anything that writes or destroys an LLM provider API
key. Model *selection* is exposed; key management is not.

## License

MIT
