# Contributing to SignBridge

Thanks for your interest in improving SignBridge! This guide covers how to
get set up and the conventions to follow.

## Development setup

**Prerequisites:** Node.js 20+, and Docker (optional, for the container path and
required for Sandbox mode).

```bash
# Local config (gitignored; the template is tracked). This is the only
# config file — there is no .env, and no dotenv dependency.
cp config.properties.example config.properties

# Backend deps
npm install

# Frontend deps + dev server (proxies /signbridge to https://localhost:2443)
cd frontend && npm install && npm run dev

# MCP server deps — needed for the stdio transport and for the Cursor AI provider
cd mcp && npm install
```

TLS certs are generated automatically on first run (into
`~/.signbridge/keys/`), so no manual cert step is needed.
`./scripts/generate-certs.sh` is available if you want to regenerate them.

Run the backend (requires `frontend/dist` to exist — build it with
`cd frontend && npm run build`):

```bash
npm start                  # binds 127.0.0.1:2443
LOG_LEVEL=debug npm start   # full signing trace, hundreds of lines per request
```

Nothing is written inside the repo: all runtime state lives under
`~/.signbridge/`. If you need to start clean, delete that directory.

## Project conventions

- **Backend `lib/` is CommonJS** (`require` / `module.exports`, `"use strict"`).
  **Frontend and `mcp/` are ESM** (`import`). Match the file you're editing.
- **Log through `lib/logger.js`, never `console`.** It is levelled, sends
  `warn`/`error` to stderr, and passes every value through `lib/redact.js`.
  `test/logger.test.js` enforces this and pins the three deliberate exemptions.
- New backend endpoint: add the route in `server.js`, implement the handler in
  the appropriate `lib/` module, expose a client function in
  `frontend/src/components/presignApi.js` — and usually add a matching tool in
  `mcp/tools.mjs`. `test/mcpToolParity.test.js` fails on a route that has
  neither a tool nor a written reason for not having one.
- New SPA page: add the path to the `spaRoutes` array in `server.js` **and** the
  React route, or Express won't serve deep links on refresh. `spaRoutes` entries
  are exact paths, not prefixes.
- Build runtime paths through `lib/paths.js`, never from `os.homedir()`. If a
  request value becomes part of a path, run it through `lib/pathSafety.js` first.
- Read directory/file names and branding from `config.properties` (via
  `appConfig`) rather than hardcoding — the app is intentionally rebrandable.
- Keep signing math and expiry logic **pure and clock-injected** in
  `lib/sigv4.js` / `lib/expiryUtils.js` so it stays testable without a network
  mock. All four presigners route their signature through `lib/sigv4.js`; don't
  reintroduce inline HMAC chains.
- **Dependencies:** the backend is CommonJS, so an ESM-only runtime dependency
  cannot be `require()`d — it works on a modern local Node and throws
  `ERR_REQUIRE_ESM` in the image. Prefer a Node built-in where one exists (that
  is why there is no `uuid`). After changing a manifest, run
  `npm install --package-lock-only` and commit **both** the manifest and the
  lockfile: `npm ci` refuses to install when they disagree, which nothing local
  notices and every clean build fails on.

## Security

- **Never commit secrets.** `keys/`, `.aws/`, `data/` and `config.properties`
  are gitignored — keep it that way. Only `config.properties.example` is tracked.
- **No secret belongs in a config file or a doc.** LLM provider keys are entered
  in the app (Settings → AI features) and stored sealed with AES-256-GCM under
  `~/.signbridge`; `config.properties` has no `apiKey` field and must not grow
  one. `LLM_API_KEY` in the environment is a last-resort fallback for unattended
  deploys, not the configuration path.
- **Never log or persist AWS secret keys, session tokens or bearer tokens.**
  `lib/redact.js` is the one place that decides what must not reach a log line —
  wrap the payload (`redact.forLog`) rather than trimming the log.
- **HTTPS with a self-signed cert is an assumption, not a wart.** Loopback calls
  (the chat agent's own API calls, both MCP transports) use a **scoped**
  `https.Agent`. Never set `NODE_TLS_REJECT_UNAUTHORIZED` — it is process-wide
  and would cover everything else that process talks to.
- **SignBridge has no login, so the bound address is its access control.** The
  default is `127.0.0.1`. Don't add a sign-in flow, and don't change that
  default; resolve the user through `authConfig.resolveUserName()`.
- **No recursive `chmod` under `~/.signbridge`.** The TLS private key, the LLM
  wrapping key and the sealed settings are `0600` for a reason, and one broad
  `chmod -R` made all three world-readable with nothing failing anywhere.
  `test/llmSecretPermissions.test.js` guards it.
- If you find a security issue, please open a private report rather than a
  public issue.

## Before opening a PR

- **Run `npm test`.** It is Node's built-in runner with no extra dependencies and
  takes seconds. Several tests read source rather than calling it, because a
  missing redaction, a world-readable key file or an MCP tool that gained a
  credential parameter all keep working perfectly while they are wrong. If you
  add a check of that kind, strip comments first — these modules document their
  own rules in prose, and a naive regex matches the sentence describing the rule.
- Run `cd frontend && npm run build` to confirm the frontend compiles. If you
  touched a shared component or the chunking, also check that Monaco stayed off
  the critical path: `grep -c monaco dist/index.html` must be **0**.
- Keep changes focused and describe the motivation in the PR description.
- If you changed the comparison data, run `npm run docs:comparison` — the README
  block is generated from `frontend/src/data/comparison.mjs`, never hand-edited.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
