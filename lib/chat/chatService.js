"use strict";

// Chat orchestration: runs the tool-calling agent against a persistent thread and
// streams tokens + tool-call status to the user's Socket.IO connection.
//
// Request (POST /chat): { message, threadId?, activeProfile?, userName? }
//   - threadId omitted/unknown -> a new thread is created and returned.
// Response: { threadId, answer, toolCalls }  (the final answer is ALSO streamed
//   over Socket.IO as it is produced; the HTTP response is the canonical result.)
//
// A turn is answered one of two ways, decided by the resolved provider and
// nowhere else. Normally ./agent runs the tool loop here against an
// OpenAI-compatible endpoint. A provider whose registry row declares a
// `chatBackend` (only Cursor, which sells an agent rather than model access) is
// dispatched to that module through CHAT_BACKENDS instead — it owns the loop and
// gets SignBridge's tools over MCP. Everything either side of the call is
// deliberately shared: the same thread store, the same emitter, the same response
// shape, so the frontend cannot tell which backend answered.

let authConfig = require('../authConfig');
let appConfig = require('../appConfig');
let coreUtils = require('../coreUtils');
let llmClient = require('./llmClient');
let agent = require('./agent');
let cursorAgent = require('./cursorAgent');
let threadStore = require('./threadStore');
let log = require('../logger').create('chat/chatService');

// Providers whose turns are answered by a module instead of an OpenAI-shaped
// chat-completions call. The key is the `chatBackend` on the provider row.
const CHAT_BACKENDS = {
    'cursor-agent': cursorAgent
};

function getApiBase(req) {
    let host = req.get('host') || 'localhost:2443';
    return 'https://' + host + appConfig.getRouteBase();
}

/**
 * Resolve the provider/model/client for this request, answering the client
 * directly when it cannot be resolved.
 *
 * This replaced a pair of boolean gates (enabled? key present?). It has to be a
 * resolution rather than a check now, because there is no single global key to
 * test for: the answer depends on which provider the user configured, whether its
 * key verified, and whether a model is selected. The failure `reason` travels to
 * the client so the UI can offer the right next step — "open Settings and pick a
 * provider" is a different button from "your key was rejected".
 *
 * Returns the session on success, or null after having sent the response.
 */
async function resolveChatSession(req, res) {
    let userName = authConfig.resolveUserName(req.body && req.body.userName);
    let override = {
        providerId: (req.body && req.body.providerId) || null,
        model: (req.body && req.body.model) || null
    };
    let session = await llmClient.resolveSessionAsync(userName, override);
    if (!session.ok) {
        res.status(session.statusCode || 503).json({
            message: session.message,
            reason: session.reason,
            providerId: session.providerId || null,
            needsLlmSetup: session.reason !== 'disabled'
        });
        return null;
    }
    return session;
}

// Per-turn system note describing the dashboard's active profile, so the agent
// can use it when the user doesn't name a profile explicitly.
function buildContextNote(activeProfile) {
    if (activeProfile && activeProfile.profileName) {
        return 'Dashboard context: the user currently has profile "' + activeProfile.profileName +
            '" selected' + (activeProfile.authnMode ? ' with auth mode ' + activeProfile.authnMode : '') +
            '. This is only a hint. Do NOT assume it — unless the user explicitly names a profile, still ' +
            'list_profiles and ask the user to choose (you may present this one first as the current selection).';
    }
    return null;
}

// Build the streaming emitter that forwards agent events to the user's sockets.
// Each event carries the threadId so the client can route it to the right thread.
function buildEmitter(userName, threadId) {
    let event = 'event_chat_stream_' + userName;
    function emit(payload) {
        coreUtils.emitToUser(userName, event, Object.assign({ threadId: threadId }, payload));
    }
    return {
        token: function (text) { emit({ type: 'token', token: text }); },
        toolStart: function (info) { emit({ type: 'tool_start', name: info.name, arguments: info.arguments }); },
        toolEnd: function (info) { emit({ type: 'tool_end', name: info.name, ok: info.ok }); },
        error: function (message) { emit({ type: 'error', message: message }); }
    };
}

async function handleChat(req, res) {
    try {
        if (!req.body || !req.body.message) {
            return res.status(400).json({ message: 'message is required' });
        }
        let session = await resolveChatSession(req, res);
        if (!session) {
            return;
        }

        let userName = authConfig.resolveUserName(req.body.userName);
        let thread = threadStore.getOrCreateThread(userName, req.body.threadId);
        let emitter = buildEmitter(userName, thread.threadId);

        // Signal turn start (lets the client show a typing indicator immediately).
        coreUtils.emitToUser(userName, 'event_chat_stream_' + userName, {
            threadId: thread.threadId,
            type: 'start'
        });

        let turn = {
            apiBase: getApiBase(req),
            userName: userName,
            userMessage: req.body.message,
            priorMessages: thread.messages,
            contextNote: buildContextNote(req.body.activeProfile),
            emitter: emitter,
            session: session
        };

        let result;
        try {
            let backend = session.chatBackend ? CHAT_BACKENDS[session.chatBackend] : null;
            if (session.chatBackend && !backend) {
                throw new Error('This provider needs the "' + session.chatBackend +
                    '" chat backend, which this build does not have.');
            }
            if (backend) {
                // The backend owns the tool loop, so it needs the model name and
                // the id of its own prior conversation instead of a client.
                result = await backend.runTurnAsync(Object.assign({}, turn, {
                    threadId: thread.threadId,
                    model: session.model,
                    resumeChatId: thread.cursorChatId || null
                }));
                if (result.cursorChatId && result.cursorChatId !== thread.cursorChatId) {
                    // Persisted so the next turn continues the same conversation
                    // at the backend rather than starting over with no context.
                    threadStore.setMeta(userName, thread.threadId, {
                        cursorChatId: result.cursorChatId
                    });
                }
            } else {
                result = await agent.runTurn(turn);
            }
        } catch (agentErr) {
            log.error('chat agent error: ', agentErr.message);
            emitter.error(agentErr.message);
            // A backend that is not installed is a configuration problem, not a
            // failed turn — same 503 + needsLlmSetup contract as an unconfigured
            // provider, so the UI offers Settings instead of "try again".
            if (agentErr.cursorBackendNotReady) {
                return res.status(503).json({
                    threadId: thread.threadId,
                    message: agentErr.message,
                    reason: 'backend_not_ready',
                    providerId: session.providerId,
                    needsLlmSetup: true
                });
            }
            // The chosen model cannot serve tool-calling chat at all (a legacy
            // completions model, or one that only exists on the responses API).
            // Retrying is pointless and the fix is a different model, so this is a
            // 400 carrying the model, not a 500 — the panel offers the picker.
            if (agentErr.modelIncompatible) {
                return res.status(400).json({
                    threadId: thread.threadId,
                    message: agentErr.message,
                    reason: agentErr.compatKind,
                    providerId: session.providerId,
                    model: session.model,
                    needsModelChange: true
                });
            }
            return res.status(500).json({ threadId: thread.threadId, message: agentErr.message });
        }

        // Persist the full updated conversation (minus the leading system prompt,
        // which the agent re-adds each turn).
        let persisted = result.messages.filter(m => m.role !== 'system');
        threadStore.saveMessages(userName, thread.threadId, persisted);

        // Signal completion so the client can finalize the message.
        coreUtils.emitToUser(userName, 'event_chat_stream_' + userName, {
            threadId: thread.threadId,
            type: 'done',
            answer: result.answer,
            toolCalls: result.toolCalls
        });

        return res.status(200).json({
            threadId: thread.threadId,
            answer: result.answer,
            toolCalls: result.toolCalls,
            // Which model actually answered. The picker shows this, and it is the
            // server's resolution rather than the client's assumption — so an
            // override that was ignored, or an environment fallback, is visible.
            providerId: session.providerId,
            providerLabel: session.providerLabel,
            model: session.model,
            modelSource: session.source
        });
    } catch (err) {
        log.error('chat error: ', err.message);
        return res.status(500).json({ message: err.message });
    }
}

function handleListThreads(req, res) {
    try {
        let userName = authConfig.resolveUserName(req.body && req.body.userName);
        return res.status(200).json({ threads: threadStore.listThreads(userName) });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

function handleGetThread(req, res) {
    try {
        let userName = authConfig.resolveUserName(req.body && req.body.userName);
        let threadId = req.body && req.body.threadId;
        let thread = threadStore.getThread(userName, threadId);
        if (!thread) {
            return res.status(404).json({ message: 'Thread not found' });
        }
        // Return only conversational messages for display (skip tool plumbing).
        let visible = (thread.messages || []).filter(m =>
            (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0
        ).map(m => ({ role: m.role, content: m.content }));
        return res.status(200).json({
            threadId: thread.threadId,
            title: thread.title,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            messages: visible
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

function handleNewThread(req, res) {
    try {
        let userName = authConfig.resolveUserName(req.body && req.body.userName);
        let thread = threadStore.createThread(userName, null);
        return res.status(200).json({ threadId: thread.threadId, title: thread.title });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

function handleRenameThread(req, res) {
    try {
        let userName = authConfig.resolveUserName(req.body && req.body.userName);
        let threadId = req.body && req.body.threadId;
        let title = req.body && req.body.title;
        let thread = threadStore.renameThread(userName, threadId, title);
        if (!thread) {
            return res.status(400).json({ message: 'Could not rename: thread not found or title empty.' });
        }
        return res.status(200).json({ threadId: thread.threadId, title: thread.title });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

function handleDeleteThread(req, res) {
    try {
        let userName = authConfig.resolveUserName(req.body && req.body.userName);
        let threadId = req.body && req.body.threadId;
        let deleted = threadStore.deleteThread(userName, threadId);
        // A thread answered by the Cursor backend also owns a scratch workspace.
        // Deleting the thread has to take it with it, or an uninstall leaves one
        // directory per conversation behind.
        cursorAgent.removeThreadWorkspace(userName, threadId);
        return res.status(200).json({ deleted: deleted });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

// Summarize a chat session with the LLM (no tools — a single completion over the
// conversation text). Returns { threadId, summary }.
async function handleSummarizeThread(req, res) {
    try {
        let session = await resolveChatSession(req, res);
        if (!session) {
            return;
        }
        let userName = authConfig.resolveUserName(req.body && req.body.userName);
        let threadId = req.body && req.body.threadId;
        let thread = threadStore.getThread(userName, threadId);
        if (!thread) {
            return res.status(404).json({ message: 'Thread not found' });
        }

        // Flatten the conversation into plain text (skip tool plumbing / empty turns).
        let transcript = (thread.messages || [])
            .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content.trim())
            .join('\n\n');

        if (!transcript) {
            return res.status(200).json({ threadId: thread.threadId, summary: 'This chat has no messages to summarize yet.' });
        }
        if (transcript.length > 12000) {
            transcript = transcript.slice(0, 12000) + '\n...[truncated]';
        }

        let instruction = 'You summarize a SignBridge chat session. Produce a concise summary (a short paragraph, ' +
            'or up to 5 bullet points) covering what the user asked, which profiles/endpoints/tools were used, ' +
            'and the outcomes. Use Markdown. Do not invent details not present in the transcript.';

        let summary;
        let backend = session.chatBackend ? CHAT_BACKENDS[session.chatBackend] : null;
        if (session.chatBackend && !backend) {
            return res.status(503).json({
                message: 'This provider needs the "' + session.chatBackend +
                    '" chat backend, which this build does not have.'
            });
        }
        if (backend) {
            // No session.client exists for a backend provider, so this cannot go
            // through chat.completions. A one-shot, tool-less completion is
            // exactly what a summary is, and every backend provides one.
            let completed = await new Promise(function (resolve, reject) {
                backend.complete({
                    userName: userName,
                    model: session.model,
                    prompt: instruction + '\n\nSummarize this chat session:\n\n' + transcript
                }, function (err, out) {
                    if (err) {
                        return reject(err);
                    }
                    return resolve(out);
                });
            });
            summary = completed && completed.text;
        } else {
            let client = session.client;
            let params = session.buildParams({
                messages: [
                    { role: 'system', content: instruction },
                    { role: 'user', content: 'Summarize this chat session:\n\n' + transcript }
                ]
            });
            let completion = await client.chat.completions.create(params);
            summary = completion && completion.choices && completion.choices[0] &&
                completion.choices[0].message && completion.choices[0].message.content;
        }
        summary = (summary || '').trim() || 'No summary could be generated.';

        return res.status(200).json({ threadId: thread.threadId, title: thread.title, summary: summary });
    } catch (err) {
        log.error('chat summarize error: ', err.message);
        return res.status(500).json({ message: err.message });
    }
}

module.exports = {
    handleChat: handleChat,
    handleListThreads: handleListThreads,
    handleGetThread: handleGetThread,
    handleNewThread: handleNewThread,
    handleRenameThread: handleRenameThread,
    handleSummarizeThread: handleSummarizeThread,
    handleDeleteThread: handleDeleteThread
};
