"use strict";

/**
 * cursorAgent.js — the second chat backend: Cursor's local agent CLI, driven over
 * SignBridge's own MCP server.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A PROVIDER ROW
 *
 * Every other provider in lib/llm/providers.js is consumed the same way: an
 * OpenAI-shaped POST /chat/completions with `messages` + `tools`, and lib/chat/
 * agent.js runs the tool loop here, in this process. Cursor has no such endpoint.
 * Its public API is the Cloud Agents API (create an agent, start a run, stream the
 * run), which owns the loop itself and has no place to hand tool *results* back.
 * So a Cursor key cannot answer a turn through llmClient however valid it is —
 * which is what `inference:false` used to say on that row.
 *
 * The way in is the other direction. SignBridge is itself an MCP server exposing
 * its whole dashboard tool set (mcp/tools.mjs), and Cursor's agent — cloud or local —
 * consumes MCP. So instead of Cursor lending us a model, we lend Cursor the tools
 * and let its loop drive the real thing. The local CLI (`agent -p`) is the right
 * surface for that rather than the cloud API: the MCP server is a stdio child on
 * this machine talking to https://localhost:2443, so nothing has to be reachable
 * from Cursor's infrastructure, and a localhost-only app with no login stays
 * localhost-only. That was the whole design problem with the cloud route.
 *
 * Structurally this module is lib/sandbox/sandboxRunner.js: spawn a process,
 * stream its output, cap it, time it out, allow cancel — with the decisions
 * (argv, MCP config, event mapping, line splitting) kept as pure functions so
 * test/cursorAgent.test.js can assert them without a CLI, a key or a network.
 *
 * FOUR THINGS THAT ARE LOAD-BEARING
 *
 * 1. `--force` is mandatory, not a convenience. In headless mode (`-p`) the CLI
 *    asks for approval before each tool call and there is no terminal to answer;
 *    the spike hung for 300 s and produced nothing, and with `--trust` alone the
 *    agent reported "MCP call 'signbridge-list_profiles' was rejected by you".
 *    But `--force` is Cursor's Run Everything switch, so it also grants shell and
 *    file access in the working directory. Hence (2).
 *
 * 2. The working directory is an empty scratch dir under the user's artifacts,
 *    holding nothing but the generated .cursor/mcp.json and AGENTS.md. It is
 *    never the repo and never the user's home. Same reasoning as a Sandbox run
 *    getting a fresh workspace: the blast radius of "run everything" has to be a
 *    directory whose entire contents we wrote.
 *
 * 3. Declaring the MCP server is not the same as approving it. `.cursor/mcp.json`
 *    tells the CLI the server exists; a separate per-name approval in the user's
 *    CLI state decides whether it loads. Proved by bisection: same prompt, same
 *    config, unapproved server -> the agent found 0 profiles; after
 *    `agent mcp enable <name>` -> 25. So ensureMcpApproved() runs that one
 *    command, once. It deliberately does NOT pass `--approve-mcps`, which is a
 *    blanket approval of *every* server in the user's config — on a developer
 *    machine that is their Slack, Jira and GitLab servers, silently loaded into a
 *    SignBridge chat. One named approval is the smaller grant.
 *
 * 4. The key is never in argv. It is unsealed at spawn time and passed as
 *    CURSOR_API_KEY in the child's own environment, so it cannot appear in `ps`
 *    output or in a log of the command — the same invariant as
 *    sandboxCredentials.js.
 *
 * 5. The MCP server is declared as a URL, not as a stdio child, and the child is
 *    given NODE_EXTRA_CA_CERTS so it trusts SignBridge's self-signed certificate.
 *    A stdio server is subject to Cursor's account-level MCP Network Controls,
 *    which force it to run inside Cursor's sandbox — unavailable in a container,
 *    so the CLI silently starts the agent with no tools. See buildMcpConfig and
 *    buildEnv; this is the difference between the whole tool set and none of it.
 *
 * WHAT THIS BACKEND CANNOT DO
 *
 * The CLI has to be installed on the SignBridge *server*, because that is the
 * process that spawns it. The image installs it (see the Dockerfile), but a build
 * with --build-arg INSTALL_CURSOR_CLI=0, an offline build, or a local `npm start`
 * on a machine without it will not have it — so preflight() reports that as a
 * normal, actionable state (exactly as Sandbox reports a missing Docker socket)
 * rather than failing a turn later.
 */

let fs = require('fs');
let path = require('path');
let { spawn } = require('child_process');
let log = require('../logger').create('chat/cursorAgent');
let propertiesReader = require('properties-reader');
const { randomUUID: uuidv4 } = require('crypto');

let paths = require('../paths');
let authConfig = require('../authConfig');
let llmSettings = require('../llm/llmSettings');
let agentPrompt = require('./agent');

let props = propertiesReader(path.resolve(__dirname, '../../config.properties'));

function prop(key, fallback) {
    let value = props.get(key);
    return value === null || value === undefined || value === '' ? fallback : value;
}

// ---------------------------------------------------------------------------
// Configuration ([cursor] section of config.properties, env-overridable)
// ---------------------------------------------------------------------------

const CLI_BIN = process.env.CURSOR_CLI_BIN || prop('cursor.cliBin', 'agent');
const RUNS_DIR_NAME = prop('cursor.runsDirName', 'cursorruns');
// The MCP server name. It is also the tool-name prefix the agent sees
// (`signbridge-list_profiles`), and the name ensureMcpApproved() approves — so
// renaming it here renames all three together.
const MCP_SERVER_NAME = prop('cursor.mcpServerName', 'signbridge');
const TIMEOUT_MS = parseInt(prop('cursor.timeoutSeconds', 300), 10) * 1000;
const MAX_OUTPUT_BYTES = parseInt(prop('cursor.maxOutputBytes', 2097152), 10);
const MAX_CONCURRENT_RUNS_PER_USER = parseInt(prop('cursor.maxConcurrentRunsPerUser', 2), 10);

const CHAT_BACKEND_ID = 'cursor-agent';
const MCP_SERVER_SCRIPT = path.resolve(__dirname, '../../mcp/server.js');

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * What the agent needs to know that the shared SYSTEM_PROMPT cannot say.
 *
 * The tool names differ: over MCP, Cursor namespaces every tool by its server, so
 * `list_profiles` is `signbridge-list_profiles`. The rest is a fence around
 * `--force`: this agent *can* run shell commands and touch files, and there is
 * nothing in its working directory worth touching, so say so rather than leaving
 * it to discover that by trying.
 */
function buildToolNote(serverName) {
    let name = serverName || MCP_SERVER_NAME;
    return [
        'HOW YOUR TOOLS ARE NAMED HERE:',
        '- The SignBridge tools reach you through an MCP server named "' + name + '", so each tool is',
        '  called as "' + name + '-<tool>" — for example ' + name + '-list_profiles, ' + name + '-invoke_api,',
        '  ' + name + '-presign_url, ' + name + '-list_s3_buckets. Use those names.',
        '- Use ONLY those tools. Do not read, write or execute anything on the filesystem and do not run',
        '  shell commands: your working directory is an empty scratch directory created for this turn and',
        '  contains nothing relevant to the user. If something cannot be done with the "' + name + '-"',
        '  tools, say so plainly instead of working around it.',
        '- Answer in Markdown, and end your turn with your answer to the user — not with a plan.'
    ].join('\n');
}

/**
 * The prompt for one turn.
 *
 * First turn of a thread carries the full SignBridge system prompt (the same
 * string lib/chat/agent.js sends, so the two backends behave the same way about
 * profiles, presign-vs-invoke and quick replies). A resumed turn carries only the
 * new message: the transcript lives at Cursor's end behind `--resume`, and
 * re-sending the system prompt every turn would both waste it and read as a new
 * set of instructions mid-conversation.
 */
function buildPrompt(spec) {
    let parts = [];
    if (!spec.resumeChatId) {
        parts.push(agentPrompt.SYSTEM_PROMPT);
        parts.push('');
        parts.push(buildToolNote(spec.serverName));
    }
    if (spec.contextNote) {
        parts.push('');
        parts.push(spec.contextNote);
    }
    parts.push('');
    parts.push('USER REQUEST:');
    parts.push(String(spec.userMessage == null ? '' : spec.userMessage));
    return parts.join('\n');
}

// ---------------------------------------------------------------------------
// argv + MCP config (pure)
// ---------------------------------------------------------------------------

/**
 * Build the argv for `agent`.
 *
 * Pure, so test/cursorAgent.test.js can assert that `--force` is present (without
 * it a turn hangs forever waiting for an approval nobody can give) and that no
 * secret is ever an argument. The prompt IS an argument, which is fine — it is the
 * user's own message, not a credential.
 */
function buildArgs(spec) {
    let format = spec.outputFormat || 'stream-json';
    let args = ['--print', '--output-format', format];
    if (format === 'stream-json') {
        // Without this the assistant's text arrives only in the final `result`
        // event, i.e. the UI would sit silent for the whole turn and then print
        // everything at once.
        args.push('--stream-partial-output');
    }
    // See the header: mandatory in headless mode, and the reason the workspace is
    // an empty directory we created.
    args.push('--force');
    if (spec.workspace) {
        args.push('--workspace', String(spec.workspace));
    }
    if (spec.model) {
        args.push('--model', String(spec.model));
    }
    if (spec.resumeChatId) {
        args.push('--resume', String(spec.resumeChatId));
    }
    args.push(String(spec.prompt == null ? '' : spec.prompt));
    return args;
}

/**
 * The .cursor/mcp.json this backend writes into the scratch workspace.
 *
 * The URL transport, pointing at SignBridge's own in-process MCP endpoint — and
 * that choice is the difference between the agent having every SignBridge tool and having none.
 *
 * This started as a stdio child (`node mcp/server.js`) because the HTTP endpoint is
 * behind the auto-generated self-signed certificate and it looked like Cursor's MCP
 * client could not be told to accept it. Both halves of that turned out to be
 * wrong:
 *
 *   * A *stdio* MCP server is subject to Cursor's MCP Network Controls, an
 *     account-level policy that forces the server to run inside Cursor's own
 *     sandbox. That sandbox is not available inside a container, so on a team with
 *     the policy on, the CLI refuses to start the server at all — "requires
 *     sandboxing because MCP Network Controls are enabled, but the sandbox is not
 *     supported on this platform" — and the turn runs with zero tools while looking
 *     completely healthy. A URL server is not sandboxed and is unaffected.
 *   * The certificate is solvable without weakening anything: SignBridge spawns the
 *     CLI, so it can put NODE_EXTRA_CA_CERTS in its environment (see buildEnv) and
 *     the cert becomes trusted for this one process. That *adds* a trust anchor
 *     rather than turning verification off, so the CLI's own calls to Cursor's API
 *     keep validating normally — which NODE_TLS_REJECT_UNAUTHORIZED=0 would not.
 *
 * So the mcp/ dependencies are still needed (the endpoint is served by
 * mcp/mcpHttp.mjs, in this process), but nothing is spawned and no policy applies.
 *
 * Note what is NOT in here: any credential. SignBridge has no login, so the
 * endpoint needs nothing but its own URL.
 */
function buildMcpConfig(spec) {
    let apiBase = String(spec.apiBase || '').replace(/\/+$/, '');
    let servers = {};
    servers[spec.serverName || MCP_SERVER_NAME] = {
        url: apiBase + '/mcp'
    };
    return { mcpServers: servers };
}

// The self-signed cert the server is listening with, so the CLI can be told to
// trust it (see buildEnv). Same file server.js reads — resolved through
// lib/paths.js, never from os.homedir().
function serverCertPath() {
    let certName = prop('ssl.CERTNAME', 'signbridge_cert.pem');
    return path.join(paths.getKeysDir(), certName);
}

/**
 * The environment for the CLI child. Pure, so the two things that must be true of
 * it are testable: the key is here and nowhere else, and the certificate is trusted
 * by addition rather than by turning verification off.
 *
 * NODE_EXTRA_CA_CERTS is what lets the URL-transport MCP config work: the endpoint
 * is https://localhost:2443 with a self-signed cert, and adding that cert as a
 * trust anchor for this one child process leaves every other TLS check the CLI
 * makes — including its own calls to Cursor's API with the user's key on them —
 * fully verified. NODE_TLS_REJECT_UNAUTHORIZED=0 would have covered those too,
 * which is not a trade worth making to reach a loopback port.
 */
function buildEnv(spec, baseEnv) {
    let env = Object.assign({}, baseEnv || {});
    if (spec.apiKey) {
        env.CURSOR_API_KEY = spec.apiKey;
    }
    // Never inherited: an operator's global "skip TLS checks" must not silently
    // apply to a process holding a provider credential.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    let certPath = spec.certPath || serverCertPath();
    if (certPath && fs.existsSync(certPath)) {
        env.NODE_EXTRA_CA_CERTS = certPath;
    }
    return env;
}

// ---------------------------------------------------------------------------
// stream-json parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Split a chunk of NDJSON into whole lines, returning the incomplete tail.
 *
 * Its own function because the bug it prevents is silent: a JSON object split
 * across two `data` events parses as garbage, and the only symptom is a missing
 * token or a tool chip that never closes.
 */
function splitLines(buffered, chunk) {
    let data = String(buffered || '') + String(chunk || '');
    let lines = data.split('\n');
    let rest = lines.pop();
    return {
        lines: lines.filter(function (line) { return line.trim().length > 0; }),
        rest: rest
    };
}

// Pull the plain text out of an assistant/user message envelope.
function extractMessageText(message) {
    if (!message) {
        return '';
    }
    if (typeof message.content === 'string') {
        return message.content;
    }
    if (!Array.isArray(message.content)) {
        return '';
    }
    return message.content.map(function (part) {
        if (typeof part === 'string') {
            return part;
        }
        return (part && typeof part.text === 'string') ? part.text : '';
    }).join('');
}

/**
 * Describe a tool_call event.
 *
 * The payload nests the call under a per-kind key (`mcpToolCall` for ours, others
 * for the CLI's own shell/read tools), so the kind is read from the key rather
 * than assumed — an unexpected tool must still produce a usable chip instead of
 * throwing. `toolName` is preferred over `name` because Cursor puts the bare tool
 * name in the former and the namespaced one in the latter, and the UI should show
 * `list_profiles` like the other backend does.
 */
function describeToolCall(event) {
    let call = (event && event.tool_call) || {};
    let kindKey = Object.keys(call)[0] || null;
    let inner = kindKey ? (call[kindKey] || {}) : {};
    let args = inner.args || {};
    let name = args.toolName || args.name ||
        (kindKey ? String(kindKey).replace(/ToolCall$/, '') : 'tool');
    let result = inner.result || null;
    return {
        name: String(name),
        kind: kindKey,
        arguments: (args && typeof args.args === 'object' && args.args !== null) ? args.args : {},
        // A completed call reports either `success` or an error branch. Absent a
        // result (a `started` event) this reads false and is simply not used.
        ok: !!(result && result.success)
    };
}

/**
 * Map one stream-json event onto SignBridge's own vocabulary.
 *
 * Returns null for events with nothing to show, so the caller can `if (!mapped)
 * continue`. Kinds: session | token | thinking | thinking_end | tool_start |
 * tool_end | result | error.
 */
function mapEvent(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }
    let type = event.type;

    if (type === 'system') {
        if (event.subtype === 'init') {
            // session_id is the chat id `--resume` takes, which is how a thread
            // keeps its context across turns.
            return {
                kind: 'session',
                chatId: event.session_id || null,
                model: event.model || null,
                cwd: event.cwd || null
            };
        }
        return null;
    }
    if (type === 'assistant') {
        let text = extractMessageText(event.message);
        return text ? { kind: 'token', text: text } : null;
    }
    if (type === 'thinking') {
        if (event.subtype === 'completed') {
            return { kind: 'thinking_end' };
        }
        return { kind: 'thinking', text: String(event.text || '') };
    }
    if (type === 'tool_call') {
        let info = describeToolCall(event);
        if (event.subtype === 'completed') {
            return { kind: 'tool_end', name: info.name, ok: info.ok };
        }
        if (event.subtype === 'started') {
            return { kind: 'tool_start', name: info.name, arguments: info.arguments };
        }
        return null;
    }
    if (type === 'result') {
        let ok = event.is_error !== true && event.subtype !== 'error';
        return {
            kind: 'result',
            ok: ok,
            text: typeof event.result === 'string' ? event.result : '',
            durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
            message: ok ? null : String(event.result || event.message || 'The Cursor agent failed.')
        };
    }
    if (type === 'error') {
        return {
            kind: 'error',
            message: String(event.message || event.error || 'The Cursor agent reported an error.')
        };
    }
    return null;
}

/**
 * Drop the CLI's end-of-block echo, so a streamed answer is not printed twice.
 *
 * With --stream-partial-output the CLI streams a message block as many small
 * `assistant` deltas and then emits ONE more `assistant` event carrying that whole
 * block again. Concatenating everything therefore yields exactly double: the
 * captured stream behind this function streamed 834 characters for a 417-character
 * answer, with each paragraph appearing twice in the panel.
 *
 * There is no flag on the event to key off — the echo is shaped exactly like a
 * delta, and the one field that differed on the sample (`timestamp_ms`) was absent
 * only on the last of the two echoes. So the echo is identified by what it is: an
 * event whose text is the block that has just been streamed. Requiring the block to
 * have been built from more than one delta is what keeps a genuinely repeated short
 * token (".", then ".") from being swallowed.
 *
 * Pure reducer over `{ buffer, deltas }`, so the shape above is a unit test rather
 * than a live CLI run. Call `resetTextBlock()` at any non-token event: the echo
 * always lands before the next tool call or the final result.
 */
const EMPTY_TEXT_BLOCK = { buffer: '', deltas: 0 };

function absorbAssistantText(block, text) {
    let current = block || EMPTY_TEXT_BLOCK;
    let value = String(text === null || text === undefined ? '' : text);
    if (!value) {
        return { block: current, emit: '' };
    }
    if (current.deltas > 1 && value === current.buffer) {
        return { block: EMPTY_TEXT_BLOCK, emit: '' };
    }
    // The echo carrying more than we saw streamed (a delta lost to truncation, say)
    // still closes the block — emit only the part the user has not seen.
    if (current.deltas > 1 && value.length > current.buffer.length &&
            value.indexOf(current.buffer) === 0) {
        return { block: EMPTY_TEXT_BLOCK, emit: value.slice(current.buffer.length) };
    }
    return {
        block: { buffer: current.buffer + value, deltas: current.deltas + 1 },
        emit: value
    };
}

// A resume id the CLI no longer knows about must not lose the conversation, so
// the turn is retried once without it. Detected on text rather than an exit code
// because the CLI reports it as a normal failed result.
function looksLikeUnknownSession(text) {
    let value = String(text || '').toLowerCase();
    return value.indexOf('no such chat') >= 0 ||
        value.indexOf('chat not found') >= 0 ||
        value.indexOf('unknown chat') >= 0 ||
        (value.indexOf('resume') >= 0 && value.indexOf('not found') >= 0);
}

// The MCP approval can be revoked outside SignBridge (or approved for a different
// name), in which case the agent answers *successfully* while reporting that it
// could not call the tool. Self-heal: re-approve and run the turn again once.
function looksLikeMcpRejection(text) {
    let value = String(text || '').toLowerCase();
    return value.indexOf('rejected by you') >= 0 ||
        (value.indexOf('mcp') >= 0 && value.indexOf('not available') >= 0 &&
            value.indexOf(MCP_SERVER_NAME) >= 0);
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

function runsBaseDir(userName) {
    return path.join(paths.getUserDir(String(userName).toLowerCase()), RUNS_DIR_NAME);
}

// One workspace per thread, not per turn: `--resume` is resolved relative to the
// workspace, so a fresh directory each turn would strand the conversation. It
// still holds nothing but the two files written below.
function threadWorkspace(userName, threadId) {
    let safe = String(threadId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(runsBaseDir(userName), safe || 'default');
}

/**
 * Create (or refresh) the scratch workspace: .cursor/mcp.json and AGENTS.md.
 *
 * AGENTS.md is belt-and-braces — the system prompt is also prepended to the first
 * turn's text, which is the load-bearing path — but it costs nothing and covers
 * the case where a resumed session has drifted from its instructions.
 */
function prepareWorkspace(spec) {
    let workspace = threadWorkspace(spec.userName, spec.threadId);
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    let config = buildMcpConfig({
        serverName: spec.serverName || MCP_SERVER_NAME,
        apiBase: spec.apiBase
    });
    fs.writeFileSync(path.join(workspace, '.cursor', 'mcp.json'),
        JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'),
        '# SignBridge agent instructions\n\n' + buildToolNote(spec.serverName) + '\n',
        { mode: 0o600 });
    return workspace;
}

function removeThreadWorkspace(userName, threadId) {
    let workspace = threadWorkspace(userName, threadId);
    try {
        fs.rmSync(workspace, { recursive: true, force: true });
        return true;
    } catch (e) {
        log.warn('cursorAgent: could not remove ', workspace, ': ', e.message);
        return false;
    }
}

// Housekeeping on startup, mirroring sandboxRunner.cleanupStaleWorkspaces. Safe
// to run against live threads: the directory only ever holds generated files and
// is rewritten on the next turn.
function cleanupStaleWorkspaces(userName, maxAgeMs) {
    let cutoff = Date.now() - (maxAgeMs || 7 * 24 * 60 * 60 * 1000);
    let base = runsBaseDir(userName);
    if (!fs.existsSync(base)) {
        return 0;
    }
    let removed = 0;
    for (let entry of fs.readdirSync(base)) {
        let full = path.join(base, entry);
        try {
            let stats = fs.statSync(full);
            if (stats.isDirectory() && stats.mtimeMs < cutoff) {
                fs.rmSync(full, { recursive: true, force: true });
                removed += 1;
            }
        } catch (e) {
            // Opportunistic — a single failure is not worth reporting.
        }
    }
    return removed;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

let preflightCache = null;
const PREFLIGHT_TTL_MS = 30 * 1000;

/**
 * Run the CLI once for a short side command (--version, mcp enable).
 *
 * The `called` guard is not defensive style, it is the fix for a crash. When the
 * binary does not exist Node emits BOTH 'error' (ENOENT) and then 'close' (-2), so
 * an unguarded callback fires twice — and every caller here runs real work in it.
 * preflight() ran twice, so testLlmConnection responded twice, and the second
 * res.json() threw ERR_HTTP_HEADERS_SENT from inside a callback, killing the
 * process: the browser saw its *next* request fail as "Network Error" with the
 * actual cause nowhere near it. Exactly the failure the CLI being absent is
 * supposed to report calmly.
 */
function runCli(args, options, cb) {
    let opts = options || {};
    let called = false;
    function done(err, result) {
        if (called) {
            return;
        }
        called = true;
        cb(err, result);
    }
    let child;
    try {
        child = spawn(CLI_BIN, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: opts.cwd || undefined,
            env: opts.env || process.env
        });
    } catch (e) {
        return done(e);
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function (d) { stdout += d.toString(); });
    child.stderr.on('data', function (d) { stderr += d.toString(); });
    child.on('error', function (err) { done(err); });
    child.on('close', function (code) {
        done(null, { code: code, stdout: stdout, stderr: stderr });
    });
}

// Short on purpose: this is a status line in a Settings card, not a runbook. It
// says the one command to run and the one thing to do after. The background (why
// the CLI has to be on the server at all) belongs in the docs, not here.
const INSTALL_HINT = 'Install it on the SignBridge server, then restart SignBridge: ' +
    'curl https://cursor.com/install -fsS | bash';

/**
 * Is this backend usable at all? cb(null, { ok, cliAvailable, mcpReady, ... }).
 *
 * Never an error for "not installed" — that is a normal state with an actionable
 * message, the same contract as sandboxRunner.preflight(). Called from
 * llmService's Test connection so the user learns it in Settings rather than
 * discovering it when a chat turn fails.
 */
function preflight(cb) {
    if (preflightCache && (Date.now() - preflightCache.at) < PREFLIGHT_TTL_MS) {
        return cb(null, preflightCache.value);
    }
    function finish(value) {
        preflightCache = { at: Date.now(), value: value };
        return cb(null, value);
    }

    runCli(['--version'], {}, function (err, result) {
        if (err || !result || result.code !== 0) {
            let reason = (err && err.code === 'ENOENT')
                ? '"' + CLI_BIN + '" not found on the server.'
                : '"' + CLI_BIN + '" failed to run.';
            return finish({
                ok: false,
                backend: CHAT_BACKEND_ID,
                cliAvailable: false,
                mcpReady: false,
                cliBin: CLI_BIN,
                message: reason + ' ' + INSTALL_HINT
            });
        }

        let version = String(result.stdout || result.stderr || '').trim().split('\n')[0] || null;

        // The tools are served in-process by mcp/mcpHttp.mjs, which shares
        // mcp/'s own dependencies (mcp/package.json). Without them the endpoint
        // cannot answer and the agent simply reports no tools — a failure with no
        // visible cause, so check for it here instead.
        if (!fs.existsSync(MCP_SERVER_SCRIPT)) {
            return finish({
                ok: false,
                backend: CHAT_BACKEND_ID,
                cliAvailable: true,
                mcpReady: false,
                cliBin: CLI_BIN,
                cliVersion: version,
                message: 'Cursor CLI found, but SignBridge\'s MCP server is missing at ' +
                    MCP_SERVER_SCRIPT + '.'
            });
        }
        let sdkDir = path.resolve(path.dirname(MCP_SERVER_SCRIPT),
            'node_modules', '@modelcontextprotocol', 'sdk');
        if (!fs.existsSync(sdkDir)) {
            return finish({
                ok: false,
                backend: CHAT_BACKEND_ID,
                cliAvailable: true,
                mcpReady: false,
                cliBin: CLI_BIN,
                cliVersion: version,
                message: 'Cursor CLI found, but SignBridge\'s MCP tools are not installed — the agent ' +
                    'would start with no tools. Run once on the server: cd mcp && npm install'
            });
        }

        return finish({
            ok: true,
            backend: CHAT_BACKEND_ID,
            cliAvailable: true,
            mcpReady: true,
            cliBin: CLI_BIN,
            cliVersion: version,
            mcpServerName: MCP_SERVER_NAME,
            message: null
        });
    });
}

function invalidatePreflight() {
    preflightCache = null;
}

// ---------------------------------------------------------------------------
// MCP approval
// ---------------------------------------------------------------------------

// Approval is per machine and persists in the user's CLI state, so this is a
// once-per-process concern in the normal case. `force` re-runs it when a turn
// came back reporting a rejection.
let approvedServers = Object.create(null);

function ensureMcpApproved(workspace, force, cb) {
    if (approvedServers[MCP_SERVER_NAME] && !force) {
        return cb(null, { alreadyApproved: true });
    }
    // Run from the workspace so the CLI resolves the server from the
    // .cursor/mcp.json we just wrote. Idempotent, and a failure is not fatal:
    // the server may already be approved, and the turn's own output is the
    // authoritative signal either way.
    // Same env as a turn (minus the key, which approval does not need): if the CLI
    // validates the server while approving it, it has to be able to trust the cert.
    runCli(['mcp', 'enable', MCP_SERVER_NAME], {
        cwd: workspace,
        env: buildEnv({}, process.env)
    }, function (err, result) {
        approvedServers[MCP_SERVER_NAME] = true;
        if (err) {
            log.warn('cursorAgent: could not approve the "' + MCP_SERVER_NAME +
                '" MCP server: ', err.message);
            return cb(null, { approved: false, message: err.message });
        }
        return cb(null, {
            approved: result.code === 0,
            output: String(result.stdout || result.stderr || '').trim()
        });
    });
}

// ---------------------------------------------------------------------------
// Active-run registry
// ---------------------------------------------------------------------------

// runId -> { userName, threadId, child, timer, cancelled, timedOut }
const activeRuns = Object.create(null);

function activeRunCountForUser(userName) {
    let count = 0;
    for (let runId of Object.keys(activeRuns)) {
        if (activeRuns[runId].userName === userName) {
            count += 1;
        }
    }
    return count;
}

function killRun(runId, reason) {
    let record = activeRuns[runId];
    if (!record) {
        return false;
    }
    if (reason === 'cancel') {
        record.cancelled = true;
    }
    try {
        record.child.kill('SIGTERM');
    } catch (e) {
        // Already gone; the close handler still reports.
    }
    setTimeout(function () {
        if (activeRuns[runId] && record.child && !record.child.killed) {
            try {
                record.child.kill('SIGKILL');
            } catch (e) {
                // ignore
            }
        }
    }, 3000);
    return true;
}

function cancel(runId, userName) {
    let record = activeRuns[runId];
    if (!record) {
        return false;
    }
    if (userName && record.userName !== userName) {
        return false;
    }
    return killRun(runId, 'cancel');
}

// Cancel whatever is in flight for a thread. This is what the chat UI's Stop
// button reaches, because the client knows its threadId and not a runId.
function cancelThread(userName, threadId) {
    let stopped = 0;
    for (let runId of Object.keys(activeRuns)) {
        let record = activeRuns[runId];
        if (record.userName === userName && record.threadId === threadId) {
            if (killRun(runId, 'cancel')) {
                stopped += 1;
            }
        }
    }
    return stopped;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// The API key, unsealed at spawn time. Deliberately re-read here rather than
// carried on the session object that travels back through chatService into an
// HTTP response — the fewer places a plaintext key exists, the fewer places can
// leak it.
function loadApiKey(userName, cb) {
    llmSettings.load(userName, function (err, settings) {
        if (err) {
            return cb(err);
        }
        return cb(null, llmSettings.getApiKey(settings, 'cursor') || '');
    });
}

const NOOP_EMITTER = {
    token: function () {},
    toolStart: function () {},
    toolEnd: function () {},
    error: function () {}
};

/**
 * Run the CLI once and collect the turn.
 *
 * cb(err, { answer, chatId, toolCalls, exitCode, cancelled, timedOut, truncated })
 */
function spawnTurn(spec, cb) {
    let called = false;
    function done(err, result) {
        if (called) {
            return;
        }
        called = true;
        cb(err, result);
    }

    let emitter = spec.emitter || NOOP_EMITTER;
    let args = buildArgs({
        prompt: spec.prompt,
        model: spec.model,
        workspace: spec.workspace,
        resumeChatId: spec.resumeChatId,
        outputFormat: 'stream-json'
    });

    let childEnv = buildEnv(spec, process.env);

    let child;
    try {
        child = spawn(CLI_BIN, args, {
            // stdin closed, not inherited: the spike hung for the full timeout
            // with an open stdin because `-p` waits for it to close.
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: spec.workspace,
            env: childEnv
        });
    } catch (e) {
        return done(new Error('Cursor agent: failed to start "' + CLI_BIN + '": ' + e.message));
    }

    let runId = uuidv4().replace(/-/g, '');
    let record = {
        userName: spec.userName,
        threadId: spec.threadId,
        child: child,
        cancelled: false,
        timedOut: false,
        timer: null
    };
    activeRuns[runId] = record;

    let buffered = '';
    let stderr = '';
    let answer = '';
    let resultText = '';
    let chatId = null;
    let toolCalls = [];
    let failure = null;
    let bytes = 0;
    let truncated = false;
    let textBlock = EMPTY_TEXT_BLOCK;

    function handleEvent(event) {
        let mapped = mapEvent(event);
        if (!mapped) {
            return;
        }
        if (mapped.kind === 'token') {
            // See absorbAssistantText: the CLI repeats each block once it is done.
            let absorbed = absorbAssistantText(textBlock, mapped.text);
            textBlock = absorbed.block;
            if (absorbed.emit) {
                answer += absorbed.emit;
                emitter.token(absorbed.emit);
            }
            return;
        }
        // Any other event ends the current text block, and the echo (if there was
        // going to be one) has already arrived.
        textBlock = EMPTY_TEXT_BLOCK;
        if (mapped.kind === 'session') {
            chatId = mapped.chatId || chatId;
            return;
        }
        if (mapped.kind === 'tool_start') {
            toolCalls.push({ name: mapped.name, arguments: mapped.arguments, ok: null });
            emitter.toolStart({ name: mapped.name, arguments: mapped.arguments });
            return;
        }
        if (mapped.kind === 'tool_end') {
            for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
                if (toolCalls[i].name === mapped.name && toolCalls[i].ok === null) {
                    toolCalls[i].ok = mapped.ok;
                    break;
                }
            }
            emitter.toolEnd({ name: mapped.name, ok: mapped.ok });
            return;
        }
        if (mapped.kind === 'result') {
            resultText = mapped.text || '';
            if (!mapped.ok) {
                failure = mapped.message;
            }
            return;
        }
        if (mapped.kind === 'error') {
            failure = mapped.message;
        }
        // thinking / thinking_end are intentionally not forwarded: the OpenAI
        // backend has no equivalent, and the chat transcript is the answer.
    }

    child.stdout.on('data', function (d) {
        let chunk = d.toString();
        bytes += Buffer.byteLength(chunk, 'utf-8');
        if (bytes > MAX_OUTPUT_BYTES) {
            if (!truncated) {
                truncated = true;
                killRun(runId, 'truncated');
            }
            return;
        }
        let split = splitLines(buffered, chunk);
        buffered = split.rest;
        for (let line of split.lines) {
            let event;
            try {
                event = JSON.parse(line);
            } catch (e) {
                // Not every line is guaranteed to be JSON (a warning can land on
                // stdout); ignoring it is better than failing the turn.
                continue;
            }
            handleEvent(event);
        }
    });
    child.stderr.on('data', function (d) { stderr += d.toString(); });

    record.timer = setTimeout(function () {
        record.timedOut = true;
        killRun(runId, 'timeout');
    }, spec.timeoutMs || TIMEOUT_MS);

    child.on('error', function (err) {
        clearTimeout(record.timer);
        delete activeRuns[runId];
        if (err.code === 'ENOENT') {
            invalidatePreflight();
            return done(new Error('Chat through Cursor needs the Cursor agent CLI, and "' + CLI_BIN +
                '" was not found on the SignBridge server. ' + INSTALL_HINT));
        }
        return done(new Error('Cursor agent: ' + err.message));
    });

    child.on('close', function (exitCode) {
        clearTimeout(record.timer);
        let wasCancelled = record.cancelled;
        let wasTimedOut = record.timedOut;
        delete activeRuns[runId];

        // The final `result` event carries the CLI's own complete answer, and it is
        // preferred over the concatenated deltas precisely because it cannot be
        // affected by how those deltas are chunked or echoed (see
        // absorbAssistantText — that shape is the one thing here a CLI release could
        // change without warning). The streamed text is the fallback for a turn that
        // produced no result event, e.g. one that was cancelled mid-answer.
        let finalAnswer = resultText.trim() ? resultText : answer;

        return done(null, {
            runId: runId,
            answer: finalAnswer,
            resultText: resultText,
            chatId: chatId,
            toolCalls: toolCalls,
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            cancelled: wasCancelled,
            timedOut: wasTimedOut,
            truncated: truncated,
            failure: failure,
            stderr: stderr
        });
    });
}

/**
 * Run one chat turn through the Cursor agent.
 *
 * Same contract as lib/chat/agent.runTurn so chatService can branch on the
 * backend and nothing downstream changes: resolves to
 * { answer, messages, toolCalls, cursorChatId }, where `messages` is the full
 * conversation to persist.
 *
 * opts: { userName, threadId, userMessage, priorMessages, contextNote, emitter,
 *         apiBase, model, resumeChatId }
 */
function runTurn(opts, cb) {
    let userName = authConfig.resolveUserName(opts && opts.userName);
    let threadId = opts && opts.threadId;

    if (activeRunCountForUser(userName) >= MAX_CONCURRENT_RUNS_PER_USER) {
        return cb(new Error('You already have ' + MAX_CONCURRENT_RUNS_PER_USER +
            ' Cursor agent turns in flight. Wait for one to finish, or press Stop.'));
    }

    preflight(function (preErr, status) {
        if (preErr) {
            return cb(preErr);
        }
        if (!status.ok) {
            let error = new Error(status.message);
            error.cursorBackendNotReady = true;
            error.preflight = status;
            return cb(error);
        }

        loadApiKey(userName, function (keyErr, apiKey) {
            if (keyErr) {
                return cb(new Error('Could not read your Cursor API key: ' + keyErr.message));
            }
            if (!apiKey) {
                return cb(new Error('No Cursor API key is stored. Add one in Settings → AI features.'));
            }

            let workspace;
            try {
                workspace = prepareWorkspace({
                    userName: userName,
                    threadId: threadId,
                    apiBase: opts.apiBase,
                    serverName: MCP_SERVER_NAME
                });
            } catch (e) {
                return cb(new Error('Could not prepare the Cursor agent workspace: ' + e.message));
            }

            function attempt(resumeChatId, retriesLeft, forceApproval) {
                ensureMcpApproved(workspace, forceApproval, function () {
                    let prompt = buildPrompt({
                        userMessage: opts.userMessage,
                        contextNote: opts.contextNote,
                        resumeChatId: resumeChatId,
                        serverName: MCP_SERVER_NAME
                    });
                    spawnTurn({
                        userName: userName,
                        threadId: threadId,
                        workspace: workspace,
                        prompt: prompt,
                        model: opts.model,
                        resumeChatId: resumeChatId,
                        apiKey: apiKey,
                        emitter: opts.emitter,
                        timeoutMs: opts.timeoutMs
                    }, function (runErr, result) {
                        if (runErr) {
                            return cb(runErr);
                        }
                        if (result.cancelled) {
                            return finishTurn(result, 'Stopped.');
                        }
                        if (result.timedOut) {
                            return cb(new Error('The Cursor agent did not finish within ' +
                                Math.round((opts.timeoutMs || TIMEOUT_MS) / 1000) + ' seconds and was stopped.'));
                        }

                        let diagnostic = [result.failure, result.answer, result.stderr]
                            .filter(Boolean).join('\n');

                        // A resume id the CLI has forgotten: run the turn again
                        // as a fresh conversation rather than losing it.
                        if (retriesLeft > 0 && resumeChatId && looksLikeUnknownSession(diagnostic)) {
                            return attempt(null, retriesLeft - 1, false);
                        }
                        // The approval was revoked or never applied: re-approve
                        // and try once more.
                        if (retriesLeft > 0 && looksLikeMcpRejection(diagnostic)) {
                            return attempt(resumeChatId, retriesLeft - 1, true);
                        }
                        if (!result.answer && result.failure) {
                            return cb(new Error(result.failure));
                        }
                        if (!result.answer) {
                            return cb(new Error('The Cursor agent produced no output' +
                                (result.stderr ? ': ' + result.stderr.trim().slice(0, 500) : '.')));
                        }
                        return finishTurn(result, result.answer);
                    });
                });
            }

            function finishTurn(result, answer) {
                let messages = (opts.priorMessages || []).slice();
                messages.push({ role: 'user', content: String(opts.userMessage || '') });
                messages.push({ role: 'assistant', content: answer });
                return cb(null, {
                    answer: answer,
                    messages: messages,
                    toolCalls: (result.toolCalls || []).map(function (tc) {
                        return { name: tc.name, arguments: tc.arguments, ok: tc.ok !== false };
                    }),
                    cursorChatId: result.chatId || opts.resumeChatId || null
                });
            }

            attempt(opts.resumeChatId || null, 1, false);
        });
    });
}

function runTurnAsync(opts) {
    return new Promise(function (resolve, reject) {
        runTurn(opts, function (err, result) {
            if (err) {
                return reject(err);
            }
            return resolve(result);
        });
    });
}

/**
 * A single tool-less completion — what Summarize needs.
 *
 * It runs in its own scratch directory with NO .cursor/mcp.json, so the agent has
 * no SignBridge tools and nothing to call: the transcript is already in the
 * prompt. `--output-format text` because there is nothing to stream.
 */
function complete(opts, cb) {
    let userName = authConfig.resolveUserName(opts && opts.userName);
    preflight(function (preErr, status) {
        if (preErr) {
            return cb(preErr);
        }
        if (!status.ok) {
            let error = new Error(status.message);
            error.cursorBackendNotReady = true;
            return cb(error);
        }
        loadApiKey(userName, function (keyErr, apiKey) {
            if (keyErr || !apiKey) {
                return cb(new Error('No Cursor API key is stored. Add one in Settings → AI features.'));
            }
            let workspace = path.join(runsBaseDir(userName), '_oneshot',
                uuidv4().replace(/-/g, '').slice(0, 16));
            try {
                fs.mkdirSync(workspace, { recursive: true });
            } catch (e) {
                return cb(new Error('Could not prepare the Cursor agent workspace: ' + e.message));
            }

            let args = buildArgs({
                prompt: String(opts.prompt || ''),
                model: opts.model,
                workspace: workspace,
                outputFormat: 'text'
            });
            let childEnv = Object.assign({}, process.env, { CURSOR_API_KEY: apiKey });
            let child;
            try {
                child = spawn(CLI_BIN, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    cwd: workspace,
                    env: childEnv
                });
            } catch (e) {
                fs.rmSync(workspace, { recursive: true, force: true });
                return cb(new Error('Cursor agent: failed to start "' + CLI_BIN + '": ' + e.message));
            }
            let stdout = '';
            let stderr = '';
            let timer = setTimeout(function () {
                try {
                    child.kill('SIGKILL');
                } catch (e) {
                    // ignore
                }
            }, opts.timeoutMs || TIMEOUT_MS);
            child.stdout.on('data', function (d) { stdout += d.toString(); });
            child.stderr.on('data', function (d) { stderr += d.toString(); });
            child.on('error', function (err) {
                clearTimeout(timer);
                fs.rmSync(workspace, { recursive: true, force: true });
                return cb(new Error('Cursor agent: ' + err.message));
            });
            child.on('close', function () {
                clearTimeout(timer);
                try {
                    fs.rmSync(workspace, { recursive: true, force: true });
                } catch (e) {
                    // ignore
                }
                let text = stdout.trim();
                if (!text) {
                    return cb(new Error('The Cursor agent produced no output' +
                        (stderr ? ': ' + stderr.trim().slice(0, 500) : '.')));
                }
                return cb(null, { text: text });
            });
        });
    });
}

module.exports = {
    CHAT_BACKEND_ID: CHAT_BACKEND_ID,
    CLI_BIN: CLI_BIN,
    MCP_SERVER_NAME: MCP_SERVER_NAME,
    TIMEOUT_MS: TIMEOUT_MS,
    MAX_CONCURRENT_RUNS_PER_USER: MAX_CONCURRENT_RUNS_PER_USER,
    preflight: preflight,
    invalidatePreflight: invalidatePreflight,
    runTurn: runTurn,
    runTurnAsync: runTurnAsync,
    complete: complete,
    cancel: cancel,
    cancelThread: cancelThread,
    prepareWorkspace: prepareWorkspace,
    removeThreadWorkspace: removeThreadWorkspace,
    cleanupStaleWorkspaces: cleanupStaleWorkspaces,
    // Exported for tests: every decision this module makes that is worth pinning
    // is one of these pure functions.
    buildArgs: buildArgs,
    buildEnv: buildEnv,
    buildMcpConfig: buildMcpConfig,
    buildPrompt: buildPrompt,
    buildToolNote: buildToolNote,
    splitLines: splitLines,
    mapEvent: mapEvent,
    absorbAssistantText: absorbAssistantText,
    EMPTY_TEXT_BLOCK: EMPTY_TEXT_BLOCK,
    describeToolCall: describeToolCall,
    looksLikeUnknownSession: looksLikeUnknownSession,
    looksLikeMcpRejection: looksLikeMcpRejection,
    _threadWorkspace: threadWorkspace
};
