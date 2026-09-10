"use strict";

// The Cursor chat backend's decisions, without a CLI, a key or a network.
//
// lib/chat/cursorAgent.js answers a chat turn by spawning Cursor's local agent CLI
// and handing it SignBridge's own MCP tools. Almost nothing about that is
// observable from a unit test — but the parts that decide whether a turn works at
// all are pure functions, and each of them has already failed once during the
// spike in a way that produced no error message:
//
//   * a missing `--force` made the CLI wait for an approval no terminal can give:
//     the run hung for the full 300 s timeout and emitted zero events.
//   * `--stream-partial-output` is what makes the answer arrive as it is written;
//     without it the panel sits silent and then prints everything at once.
//   * the MCP server is declared in .cursor/mcp.json by *url*, not as a stdio
//     child. A stdio server is subject to Cursor's account-level MCP Network
//     Controls, which force it to run inside Cursor's sandbox — unavailable in a
//     container, so the CLI refuses to start it and the turn runs with no tools
//     while looking perfectly healthy. The self-signed cert that made the URL form
//     look impossible is handled by NODE_EXTRA_CA_CERTS on the child.
//   * the event vocabulary is Cursor's, not OpenAI's, and it was read off a real
//     stream. The fixtures below are that shape. If a mapping drifts, the symptom
//     is a missing token or a tool chip that never closes — never an exception.
//   * the system prompt goes out on the first turn only. Resent every turn it would
//     read as a fresh set of instructions arriving mid-conversation.
//
// And one hygiene rule with teeth: the API key is passed through the child's
// environment, never argv, so it cannot appear in `ps` output or in a logged
// command line. That is asserted both on the built argv and on the source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cursorAgent = require('../lib/chat/cursorAgent');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'chat', 'cursorAgent.js'), 'utf8'
);

// --------------------------------------------------------------------- buildArgs

test('buildArgs: headless streaming with forced approval, in that order', () => {
    let args = cursorAgent.buildArgs({
        prompt: 'list my profiles',
        model: 'auto-smart',
        workspace: '/tmp/ws',
        resumeChatId: 'chat-abc'
    });

    // --force is the one flag whose absence is unrecoverable: `-p` prompts for
    // approval per tool call and there is no terminal to answer.
    assert.ok(args.includes('--force'), 'a turn without --force hangs until the timeout');
    assert.ok(args.includes('--print'), 'headless mode is what makes this scriptable');
    assert.deepEqual(args.slice(0, 4),
        ['--print', '--output-format', 'stream-json', '--stream-partial-output']);
    assert.deepEqual(args.slice(-2, -1), ['chat-abc']);

    // The prompt is the final positional argument — the CLI takes it there, and a
    // flag appended after it would be read as part of the prompt.
    assert.equal(args[args.length - 1], 'list my profiles');

    for (let [flag, value] of [['--workspace', '/tmp/ws'], ['--model', 'auto-smart'], ['--resume', 'chat-abc']]) {
        let at = args.indexOf(flag);
        assert.ok(at > -1, flag + ' is missing');
        assert.equal(args[at + 1], value, flag + ' does not carry its value');
    }
});

test('buildArgs: a first turn passes no --resume, and text mode does not stream', () => {
    let first = cursorAgent.buildArgs({ prompt: 'hi', workspace: '/tmp/ws' });
    assert.ok(!first.includes('--resume'), 'a new conversation must not resume anything');
    assert.ok(!first.includes('--model'), 'no model means the CLI default, not an empty flag');
    assert.ok(first.includes('--stream-partial-output'));

    // The one-shot path (Summarize) has nothing to stream, and asking for partial
    // output in text mode is meaningless.
    let oneshot = cursorAgent.buildArgs({ prompt: 'summarize', outputFormat: 'text' });
    assert.deepEqual(oneshot.slice(0, 3), ['--print', '--output-format', 'text']);
    assert.ok(!oneshot.includes('--stream-partial-output'));
    assert.ok(oneshot.includes('--force'));
});

test('buildArgs: nothing secret can reach argv', () => {
    // buildArgs has no key parameter at all — this asserts a caller cannot smuggle
    // one in by passing it, which is how a credential ends up in `ps`.
    let args = cursorAgent.buildArgs({
        prompt: 'hi',
        apiKey: 'key_should_never_appear',
        env: { CURSOR_API_KEY: 'key_should_never_appear' }
    });
    assert.ok(!args.join(' ').includes('key_should_never_appear'));

    // And the spawn path puts it in the child's environment instead. Source
    // inspection, because the alternative is spawning the real CLI.
    assert.match(SOURCE, /env\.CURSOR_API_KEY = spec\.apiKey/,
        'the key must travel in the child environment');
    let pushes = SOURCE.match(/args\.push\([^)]*\)/g) || [];
    for (let push of pushes) {
        assert.ok(!/apiKey|API_KEY/i.test(push), 'a credential is being pushed into argv: ' + push);
    }
});

// ----------------------------------------------------------------- buildMcpConfig

test('buildMcpConfig: a url server, not a stdio child, and no credential', () => {
    let config = cursorAgent.buildMcpConfig({
        serverName: 'signbridge',
        apiBase: 'https://localhost:2443/signbridge'
    });
    let server = config.mcpServers.signbridge;
    assert.ok(server, 'the server is keyed by name — that name is also the tool prefix');

    // The url form is the whole point: a stdio entry is sandbox-gated by MCP
    // Network Controls and silently starts with no tools on any team that has the
    // policy on. Cursor's CLI only exempts entries that carry a url.
    assert.equal(server.url, 'https://localhost:2443/signbridge/mcp');
    assert.equal(server.command, undefined, 'a stdio command reintroduces the sandbox requirement');
    assert.equal(server.args, undefined);

    // A trailing slash on the configured base must not produce a '//mcp' path.
    assert.equal(
        cursorAgent.buildMcpConfig({ apiBase: 'https://localhost:2443/signbridge/' })
            .mcpServers[cursorAgent.MCP_SERVER_NAME].url,
        'https://localhost:2443/signbridge/mcp'
    );

    // SignBridge has no login, so the endpoint needs no credential. If one ever
    // appears here it is also readable by anything that can read the workspace.
    let serialised = JSON.stringify(config);
    assert.ok(!/api[_-]?key/i.test(serialised), 'the MCP config must carry no credential');
    assert.ok(!/secret|token/i.test(serialised));
});

test('buildMcpConfig: the server name defaults to the configured one', () => {
    let config = cursorAgent.buildMcpConfig({ apiBase: 'https://x/y' });
    assert.deepEqual(Object.keys(config.mcpServers), [cursorAgent.MCP_SERVER_NAME]);
});

// ---------------------------------------------------------------------- buildEnv

test('buildEnv: the key travels here, and TLS is widened by exactly one cert', () => {
    // A real file, because the cert is only added when it exists — an absent cert
    // must not put a bogus path in the environment, which Node treats as fatal.
    let certPath = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sb-cert-')), 'cert.pem');
    fs.writeFileSync(certPath, '-- not a real certificate --');

    let env = cursorAgent.buildEnv(
        { apiKey: 'crsr_test_key', certPath: certPath },
        { PATH: '/usr/bin', NODE_TLS_REJECT_UNAUTHORIZED: '0' }
    );

    assert.equal(env.CURSOR_API_KEY, 'crsr_test_key', 'the key reaches the child by env only');
    assert.equal(env.PATH, '/usr/bin', 'the inherited environment is otherwise preserved');

    // Adding a trust anchor, not removing verification. The child makes its own
    // authenticated calls to Cursor's API with the user's key on them, and an
    // inherited blanket opt-out would cover those too.
    assert.equal(env.NODE_EXTRA_CA_CERTS, certPath);
    assert.ok(!('NODE_TLS_REJECT_UNAUTHORIZED' in env),
        'an inherited TLS opt-out must not reach a process holding a credential');

    // No key configured yet (preflight, ensureMcpApproved) — no variable at all,
    // rather than an empty one the CLI would try to use.
    let keyless = cursorAgent.buildEnv({ certPath: certPath }, { PATH: '/usr/bin' });
    assert.ok(!('CURSOR_API_KEY' in keyless));

    // A missing cert file is not an error and not a guess.
    let noCert = cursorAgent.buildEnv({ certPath: '/nonexistent/signbridge-cert.pem' }, {});
    assert.ok(!('NODE_EXTRA_CA_CERTS' in noCert));
});

test('buildEnv is the only path the key takes, and nothing logs it', () => {
    // Source inspection: the spawn and the approval call must both build their
    // environment here, or one of them regains the inherited opt-out.
    assert.match(SOURCE, /let childEnv = buildEnv\(spec, process\.env\)/,
        'spawnTurn must build the child environment through buildEnv');
    assert.match(SOURCE, /env: buildEnv\(\{\}, process\.env\)/,
        'ensureMcpApproved must use the same environment, minus the key it does not need');

    // And no line that writes or logs may mention the key.
    let emitters = SOURCE.match(/(?:console\.\w+|writeFileSync)\([^\n]*/g) || [];
    for (let line of emitters) {
        assert.ok(!/apiKey|CURSOR_API_KEY/.test(line), 'a credential may be leaving: ' + line);
    }
});

// -------------------------------------------------------------------- buildPrompt

test('buildPrompt: the system prompt goes out once, on the first turn only', () => {
    let firstTurn = cursorAgent.buildPrompt({
        userMessage: 'list my profiles',
        serverName: 'signbridge'
    });
    // The same instructions the OpenAI-backed agent sends, so the two backends
    // behave alike about profiles, presign-vs-invoke and quick replies.
    assert.ok(firstTurn.includes('USER REQUEST:'));
    assert.ok(firstTurn.includes('list my profiles'));
    assert.ok(firstTurn.length > 1000, 'the first turn should carry the full system prompt');
    // And the namespaced tool names, which are the one thing the shared prompt
    // cannot know about.
    assert.ok(firstTurn.includes('signbridge-list_profiles'));

    let resumed = cursorAgent.buildPrompt({
        userMessage: 'and the second one?',
        resumeChatId: 'chat-abc'
    });
    assert.ok(resumed.includes('and the second one?'));
    assert.ok(!resumed.includes('signbridge-list_profiles'),
        'a resumed turn must not re-send the instructions as if they were new');
    assert.ok(resumed.length < 200, 'a resumed turn carries only the new message');
});

test('buildPrompt: the dashboard context note rides along on either kind of turn', () => {
    let note = 'Dashboard context: profile "dev" is selected.';
    for (let resumeChatId of [null, 'chat-abc']) {
        let prompt = cursorAgent.buildPrompt({
            userMessage: 'invoke it',
            contextNote: note,
            resumeChatId: resumeChatId
        });
        assert.ok(prompt.includes(note), 'context note lost when resumeChatId=' + resumeChatId);
        // Before the request, so it reads as context rather than as part of the ask.
        assert.ok(prompt.indexOf(note) < prompt.indexOf('USER REQUEST:'));
    }
});

test('buildToolNote: it fences off the access --force grants', () => {
    let note = cursorAgent.buildToolNote('sb');
    assert.ok(note.includes('sb-list_profiles'), 'the tool prefix follows the server name');
    // --force is Cursor's Run Everything switch, so the agent can also run shell
    // commands and touch files. The workspace is empty by design; say so rather
    // than letting it find out by trying.
    assert.match(note, /shell commands/);
    assert.match(note, /scratch directory/);
});

// --------------------------------------------------------------------- splitLines

test('splitLines: an event split across two chunks still parses', () => {
    // The bug this prevents is silent: half a JSON object parses as garbage and the
    // only symptom is a dropped token or a tool chip that never closes.
    let first = cursorAgent.splitLines('', '{"type":"assistant"}\n{"type":"res');
    assert.deepEqual(first.lines, ['{"type":"assistant"}']);
    assert.equal(first.rest, '{"type":"res');

    let second = cursorAgent.splitLines(first.rest, 'ult"}\n');
    assert.deepEqual(second.lines, ['{"type":"result"}']);
    assert.equal(second.rest, '');

    // Blank lines are dropped, not handed on as parse failures.
    assert.deepEqual(cursorAgent.splitLines('', '\n\n{"a":1}\n').lines, ['{"a":1}']);
    // Nothing complete yet: hold everything.
    let held = cursorAgent.splitLines('', '{"partial":');
    assert.deepEqual(held.lines, []);
    assert.equal(held.rest, '{"partial":');
});

// ------------------------------------------------------------------------ mapEvent

test('mapEvent: system/init yields the chat id that --resume takes', () => {
    let mapped = cursorAgent.mapEvent({
        type: 'system',
        subtype: 'init',
        session_id: '9f1c0e2a-1111-2222-3333-444455556666',
        model: 'auto-smart',
        cwd: '/tmp/ws'
    });
    assert.equal(mapped.kind, 'session');
    // Without this the next turn starts a fresh conversation and the thread
    // silently loses its context.
    assert.equal(mapped.chatId, '9f1c0e2a-1111-2222-3333-444455556666');
    assert.equal(mapped.model, 'auto-smart');

    // Other system subtypes have nothing to show.
    assert.equal(cursorAgent.mapEvent({ type: 'system', subtype: 'something-else' }), null);
});

test('mapEvent: assistant events are text deltas, not whole messages', () => {
    // Verified against a real stream: with --stream-partial-output each event
    // carries the next fragment, so the caller concatenates. Treating one as the
    // full message would show only the last fragment.
    let parts = ['You have ', '25 profiles', '.'];
    let text = parts.map(function (part) {
        return cursorAgent.mapEvent({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: part }] }
        });
    }).map(function (m) {
        assert.equal(m.kind, 'token');
        return m.text;
    }).join('');
    assert.equal(text, 'You have 25 profiles.');

    // A string content field (the shape the text format uses) works too.
    assert.equal(cursorAgent.mapEvent({ type: 'assistant', message: { content: 'hi' } }).text, 'hi');
    // An empty delta is nothing to show rather than an empty token.
    assert.equal(cursorAgent.mapEvent({ type: 'assistant', message: { content: [] } }), null);
});

// --------------------------------------------------- absorbAssistantText (echo)

test('absorbAssistantText: the block echo is dropped, so nothing prints twice', () => {
    // The shape of a real captured stream: a paragraph arrives as many small deltas
    // and is then repeated once in full, immediately before the next tool call or
    // the result. Concatenating everything doubled the answer in the panel — 834
    // streamed characters for a 417-character reply.
    let block = cursorAgent.EMPTY_TEXT_BLOCK;
    let printed = '';
    function feed(text) {
        let absorbed = cursorAgent.absorbAssistantText(block, text);
        block = absorbed.block;
        printed += absorbed.emit;
    }

    ['Plan', ': I', ' will call ', '`get_settings`', '.'].forEach(feed);
    assert.equal(printed, 'Plan: I will call `get_settings`.');
    feed('Plan: I will call `get_settings`.');      // the echo
    assert.equal(printed, 'Plan: I will call `get_settings`.', 'the echo must not print again');
    // And the echo closed the block, so the next paragraph starts clean.
    assert.deepEqual(block, cursorAgent.EMPTY_TEXT_BLOCK);
});

test('absorbAssistantText: a repeated short token is not mistaken for an echo', () => {
    // The reason the rule requires more than one delta: an answer ending "..." emits
    // the same character twice in a row, and dropping the second would corrupt text
    // to fix a formatting problem.
    let first = cursorAgent.absorbAssistantText(cursorAgent.EMPTY_TEXT_BLOCK, '.');
    assert.equal(first.emit, '.');
    let second = cursorAgent.absorbAssistantText(first.block, '.');
    assert.equal(second.emit, '.', 'a genuine repeat must survive');

    // A block delivered as one whole event (no deltas preceding it) is text, not an
    // echo — that is how the shortest answers arrive.
    let whole = cursorAgent.absorbAssistantText(cursorAgent.EMPTY_TEXT_BLOCK, 'Done.');
    assert.equal(whole.emit, 'Done.');
});

test('absorbAssistantText: an echo carrying unseen text emits only the remainder', () => {
    // If a delta is lost (output truncated, a chunk dropped) the echo is the only
    // copy of the missing words, so it closes the block but prints just the tail.
    let block = { buffer: 'Your settings ', deltas: 3 };
    let absorbed = cursorAgent.absorbAssistantText(block, 'Your settings are default.');
    assert.equal(absorbed.emit, 'are default.');
    assert.deepEqual(absorbed.block, cursorAgent.EMPTY_TEXT_BLOCK);

    // An empty delta changes nothing at all.
    let unchanged = cursorAgent.absorbAssistantText(block, '');
    assert.equal(unchanged.emit, '');
    assert.deepEqual(unchanged.block, block);
});

test('the final answer comes from the result event, not the concatenated deltas', () => {
    // Belt and braces for the same bug: the echo rule above is a guess about a CLI
    // shape, while `result` is the CLI's own complete answer and cannot double.
    assert.match(SOURCE, /let finalAnswer = resultText\.trim\(\) \? resultText : answer;/,
        'a turn with a result event must persist the result text');
});

test('mapEvent: an MCP tool call opens and closes a chip with the bare tool name', () => {
    let started = cursorAgent.mapEvent({
        type: 'tool_call',
        subtype: 'started',
        tool_call: {
            mcpToolCall: {
                args: {
                    toolName: 'list_profiles',
                    providerIdentifier: 'signbridge',
                    args: { userName: 'signbridgeuser' }
                }
            }
        }
    });
    assert.equal(started.kind, 'tool_start');
    // `toolName` over `name`: Cursor puts the bare name in the former and the
    // namespaced one in the latter, and the chip should read like the other
    // backend's — `list_profiles`, not `signbridge-list_profiles`.
    assert.equal(started.name, 'list_profiles');
    assert.deepEqual(started.arguments, { userName: 'signbridgeuser' });

    let completed = cursorAgent.mapEvent({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
            mcpToolCall: {
                args: { toolName: 'list_profiles' },
                result: { success: { content: [{ type: 'text', text: '25 profiles' }] } }
            }
        }
    });
    assert.equal(completed.kind, 'tool_end');
    assert.equal(completed.name, 'list_profiles');
    assert.equal(completed.ok, true);

    // A failed call closes the chip too — as failed, not as still running.
    let failed = cursorAgent.mapEvent({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: { mcpToolCall: { args: { toolName: 'invoke_api' }, result: { error: 'boom' } } }
    });
    assert.equal(failed.kind, 'tool_end');
    assert.equal(failed.ok, false);
});

test('describeToolCall: the CLI\'s own tools still produce a usable chip', () => {
    // The payload nests the call under a per-kind key, and ours is only one of
    // them. An unexpected kind must degrade to a name, not throw mid-stream.
    let shell = cursorAgent.describeToolCall({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { shellToolCall: { args: { command: 'ls' } } }
    });
    assert.equal(shell.kind, 'shellToolCall');
    assert.equal(shell.name, 'shell');
    assert.deepEqual(shell.arguments, {});

    // No payload at all: still an object with a string name.
    let bare = cursorAgent.describeToolCall({});
    assert.equal(typeof bare.name, 'string');
    assert.ok(bare.name.length > 0);
});

test('mapEvent: the result event is the canonical answer, and reports failure', () => {
    let ok = cursorAgent.mapEvent({
        type: 'result',
        subtype: 'success',
        result: 'You have 25 profiles.',
        duration_ms: 8421,
        is_error: false
    });
    assert.equal(ok.kind, 'result');
    assert.equal(ok.ok, true);
    // The fallback answer for a turn that streamed nothing.
    assert.equal(ok.text, 'You have 25 profiles.');
    assert.equal(ok.durationMs, 8421);
    assert.equal(ok.message, null);

    // is_error and subtype:'error' are both used; either one means failed.
    assert.equal(cursorAgent.mapEvent({ type: 'result', result: 'nope', is_error: true }).ok, false);
    let failed = cursorAgent.mapEvent({ type: 'result', subtype: 'error', result: 'model not found' });
    assert.equal(failed.ok, false);
    assert.ok(failed.message.includes('model not found'),
        'a failure has to keep the reason — it is what the user sees');
});

test('mapEvent: thinking is recognised but is not part of the answer', () => {
    // Recognised so it cannot be mistaken for assistant text (which would splice
    // the model's reasoning into the transcript), and deliberately not forwarded:
    // the OpenAI backend has no equivalent event.
    assert.equal(cursorAgent.mapEvent({ type: 'thinking', text: 'hmm' }).kind, 'thinking');
    assert.equal(cursorAgent.mapEvent({ type: 'thinking', subtype: 'completed' }).kind, 'thinking_end');
});

test('mapEvent: anything unrecognised is null, never a throw', () => {
    // The mapper runs on every line of an untrusted stream, so a new event type in
    // a CLI upgrade must be ignorable rather than fatal.
    for (let event of [null, undefined, 'a string', 42, {}, { type: 'brand_new_event' },
        { type: 'user', message: { content: 'echoed back' } }]) {
        assert.doesNotThrow(function () { cursorAgent.mapEvent(event); });
    }
    assert.equal(cursorAgent.mapEvent({ type: 'brand_new_event' }), null);
    assert.equal(cursorAgent.mapEvent('a string'), null);
});

// ------------------------------------------------------- self-healing detectors

test('looksLikeUnknownSession: a forgotten resume id is detected, not fatal', () => {
    // The turn is retried once without the resume id, so a stale id costs a retry
    // rather than the conversation.
    for (let text of ['Error: no such chat: abc', 'Chat not found', 'unknown chat id',
        'could not resume session: not found']) {
        assert.equal(cursorAgent.looksLikeUnknownSession(text), true, 'missed: ' + text);
    }
    for (let text of ['', null, 'You have 25 profiles.', 'AccessDenied calling sts:GetCallerIdentity']) {
        assert.equal(cursorAgent.looksLikeUnknownSession(text), false, 'false positive: ' + text);
    }
});

test('looksLikeMcpRejection: the exact string the CLI produced when unapproved', () => {
    // This is verbatim from the spike, and it arrives on a *successful* turn: the
    // agent answers while reporting it could not call the tool. Only the text
    // distinguishes it, which is why it is matched rather than an exit code.
    assert.equal(
        cursorAgent.looksLikeMcpRejection(
            "MCP call 'signbridge-list_profiles' was rejected by you."),
        true
    );
    assert.equal(cursorAgent.looksLikeMcpRejection('You have 25 profiles.'), false);
    assert.equal(cursorAgent.looksLikeMcpRejection(null), false);
});

test('the approval is granted by name, never blanket', () => {
    // --approve-mcps approves every MCP server in the user's own config — on a
    // developer machine that is their Slack, Jira and GitLab servers, silently
    // loaded into a SignBridge chat. One named approval is the smaller grant, and
    // this is the kind of regression that looks like a simplification.
    // Comments are excluded on purpose: the header explains at length why the flag
    // is not used, and that explanation is the thing keeping it out.
    let code = SOURCE.split('\n').filter(function (line) {
        return !/^\s*(\/\/|\*|\/\*)/.test(line);
    }).join('\n');
    assert.ok(!code.includes('--approve-mcps'),
        'blanket MCP approval would load the user\'s unrelated MCP servers');
    assert.match(SOURCE, /'mcp', 'enable', MCP_SERVER_NAME/);
});

// ------------------------------------------------------------------- workspace

test('the workspace is a scratch dir under the user artifacts, per thread', () => {
    let ws = cursorAgent._threadWorkspace('signbridgeuser', 'abc-123');
    // Per thread, not per turn: --resume resolves relative to the workspace, so a
    // fresh directory each turn would strand the conversation.
    assert.ok(ws.endsWith(path.join('cursorruns', 'abc-123')), ws);
    assert.ok(ws.includes('.signbridge'), 'the workspace must live under the base dir: ' + ws);

    // A threadId is a path segment, so it is sanitised: --force grants file access
    // in this directory, and it must not be able to name one outside the base dir.
    let escaped = cursorAgent._threadWorkspace('signbridgeuser', '../../../etc');
    assert.ok(!escaped.includes('..'), escaped);
    assert.ok(escaped.startsWith(path.dirname(ws)), escaped);
    // An empty or unusable id still resolves somewhere valid rather than to the
    // parent directory itself.
    assert.ok(cursorAgent._threadWorkspace('signbridgeuser', '///').endsWith('default'));
    assert.ok(cursorAgent._threadWorkspace('signbridgeuser', null).endsWith('default'));
});

// ------------------------------------------------------------------- guardrails

test('preflight reports a missing CLI instead of erroring', (t, done) => {
    // Same contract as sandboxRunner.preflight: "not installed" is a normal,
    // actionable state, because it is the default in the Docker deployment. If this
    // errored, Settings could not tell the user what to install.
    cursorAgent.invalidatePreflight();
    cursorAgent.preflight(function (err, status) {
        assert.equal(err, null, 'preflight must never error for a missing CLI');
        assert.equal(status.backend, 'cursor-agent');
        assert.equal(typeof status.ok, 'boolean');
        if (!status.ok) {
            assert.ok(status.message && status.message.length > 40,
                'an unusable backend has to say what to do about it');
        }
        done();
    });
});

test('preflight calls back exactly once when the CLI is missing', () => {
    // This is a fixed crash, not a style point. spawn() of a binary that does not
    // exist emits BOTH 'error' (ENOENT) and then 'close' (-2), so an unguarded
    // callback fired twice — and preflight's continuation in llmService is the whole
    // connection test plus its res.json(). The second response threw
    // ERR_HTTP_HEADERS_SENT from inside a callback and killed the process, so the
    // browser's NEXT request failed as "Network Error" with the real cause nowhere
    // near it. Precisely the failure a missing CLI is supposed to report calmly.
    //
    // Run in a child process with CURSOR_CLI_BIN pointed at a name that cannot
    // exist, because on a machine that has the CLI the ENOENT path never runs.
    let script = [
        'let a = require("./lib/chat/cursorAgent");',
        'let n = 0;',
        'a.invalidatePreflight();',
        'a.preflight(function () { n += 1; });',
        'setTimeout(function () { console.log("calls=" + n); }, 1500);'
    ].join('\n');
    let out = require('node:child_process').execFileSync(
        process.execPath, ['-e', script],
        {
            cwd: path.resolve(__dirname, '..'),
            env: Object.assign({}, process.env, {
                CURSOR_CLI_BIN: '/nonexistent/signbridge-no-such-agent'
            }),
            encoding: 'utf8'
        }
    );
    assert.match(out, /calls=1/, 'preflight must call back once, got: ' + out.trim());
});

test('the module never logs or persists the API key', () => {
    // The key is unsealed at spawn time and lives only in the child's env. Any
    // console.log or writeFileSync touching it would put it in a log file or in the
    // workspace, which is exactly what passing it via env avoids.
    let lines = SOURCE.split('\n');
    for (let line of lines) {
        if (/console\.log|writeFileSync/.test(line)) {
            assert.ok(!/apiKey|CURSOR_API_KEY/i.test(line),
                'a credential is being logged or written: ' + line.trim());
        }
    }
});
