# Security policy

SignBridge is a **local developer tool**. It is meant to run on your laptop or
workstation, bind to loopback by default, and talk to MCP clients on the same
machine. It is **not** a multi-user server, not a hosted SaaS, and not something
you expose on a LAN or the public internet without putting real authentication
in front of it.

## Threat model

SignBridge has **no login**. Every HTTP route, Socket.IO channel, and MCP tool
runs as a single local user and can use every AWS profile the app can reach on
that machine.

**Network reachability is the access control.** If something can open
`https://localhost:2443/signbridge/` (or the cleartext MCP endpoint on port
2444), it can presign and invoke AWS APIs, browse S3, run Sandbox code with
your credentials, and call all MCP tools — exactly like you can in the
dashboard.

That is intentional for a personal SigV4 debugging tool. It is the wrong model
for a shared or remotely reachable deployment.

### Safe default

| Setting | Default | Purpose |
| --- | --- | --- |
| `[server] bindHost` | `127.0.0.1` | Listen on loopback only |
| Docker Compose publish | `127.0.0.1:2443` / `:2444` | Host port not exposed to the LAN |
| `Host` header check | Loopback + optional `allowedHosts` | DNS-rebinding defence |
| MCP over HTTP | Loopback or container only | Cleartext stays on the machine |

### When you are outside the intended model

Do **not** bind to `0.0.0.0` on a laptop on an office or café network unless
you understand that anyone who can reach the port gets your AWS profiles.

If you must run SignBridge on a shared host, put a reverse proxy with
authentication (mTLS, VPN, SSO gateway, etc.) in front of it, bind to
loopback behind that proxy, and treat the instance like root access to your
cloud accounts.

## What SignBridge stores locally

Runtime data lives under `~/.signbridge/` (outside the git repo):

- **AWS/REST profiles** — IAM keys, SSO state, SSH keys for EC2 profiles,
  bearer tokens, OAuth client secrets where configured
- **History and favorites** — past requests and responses (may include auth
  headers and bodies)
- **LLM provider keys** — sealed with AES-256-GCM (`lib/llm/secretStore.js`)
- **TLS private key** — self-signed cert for local HTTPS

These files are written **mode 0600** (owner only). Note that a file mode is
applied when the file is *created* — if your `~/.signbridge` predates a version
that set it, those files keep their old, wider mode. The Docker entrypoint
repairs them on every start; if you run with `npm start`, tighten them once:

```bash
chmod -R go-rwx ~/.signbridge
```

Protect `~/.signbridge` like you protect `~/.aws`.

SignBridge also writes outside `~/.signbridge` in two cases:

- **“Sync to AWS Config”** on an IAM/SSO profile writes it back to
  `~/.aws/config`, and IAM access keys to `~/.aws/credentials` (mode 0600).
- **AWS CLI mode** with an SSO profile caches the SSO access token in
  `~/.aws/sso/cache/`, the same place and mode (0600) the AWS CLI uses.

## MCP

Both MCP transports are local-first:

- **stdio** (`npx -y github:rajesh-bijja/signbridge`) — talks to SignBridge over
  loopback HTTPS
- **HTTP** (`http://localhost:2444/signbridge/mcp`) — cleartext on loopback
  because MCP clients cannot trust the self-signed certificate without a
  process-wide TLS opt-out

MCP tool results are scrubbed before they reach a model (`scrubForModel` in
`mcp/tools.mjs`). Routes that return live credentials as their entire payload
(`copyBearerToken`, `getRoleCredentialsForUser`, curl builder) are **not**
exposed as MCP tools.

An MCP client already **is** the model; SignBridge’s own Chat feature needs a
separate LLM key in Settings. MCP tools do not require that key.

## Powerful features (use on your machine only)

- **Sandbox** — runs your code in Docker with the selected profile’s AWS
  credentials. Optional Docker socket mount is equivalent to host root.
- **AWS CLI mode** — executes a shell script you provide, with profile creds
  in the environment.
- **Cursor chat backend** — headless agent with `--force` in an isolated scratch
  directory; still grants tool and shell access there.

These match the product’s purpose (debug what *your* credentials can do) but
assume a trusted local operator.

## Logging

Set `LOG_LEVEL=debug` only when debugging SigV4 mismatches. Debug output includes
signing traces; values are passed through `lib/redact.js` first so secrets,
session tokens, and API keys should not appear in logs. Treat `docker logs` like
any credential-bearing artifact before sharing.

## Dependencies

Run `npm audit` in the repo root and in `mcp/` periodically. The test suite
includes hygiene checks (`test/secretHygiene.test.js`, `test/llmSecretPermissions.test.js`)
but does not replace dependency monitoring.

## Reporting a vulnerability

If you believe you have found a security issue in SignBridge itself (not
misconfiguration of a public bind address), please report it privately through
[GitHub security advisories](https://github.com/rajesh-bijja/signbridge/security/advisories/new).

**Please do not open a public issue for a security report** — a public issue is
disclosure, and everyone running the tool sees it before there is a fix. If
advisories are unavailable to you for any reason, say so in a normal issue
*without the details* and you will be given a private channel.

Please include steps to reproduce, SignBridge version or commit, and whether
the scenario assumes the default loopback deployment or a non-default bind.

We aim to acknowledge reports within a few business days. SignBridge is a
personal open-source project; response times may vary.

## Supported versions

Only the latest release on the default branch receives security fixes. There is
no long-term support matrix — pin a commit or tag if you need stability.
