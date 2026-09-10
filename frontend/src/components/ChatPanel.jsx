import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Form, Modal, Spinner } from 'react-bootstrap'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  sendChatMessage,
  newChatThread,
  getChatThread,
  populateSettingsDetails,
  updateSettingsDetails
} from './presignApi'
import { getSocket, getUserName } from './presignSocket'
// Every route is mounted under the app's route prefix, so a bare '/settings'
// matches nothing and the catch-all route sends the user to the dashboard —
// which is what these two links used to do.
import { appPath } from '../appConfig'
import ModelPicker from './llm/ModelPicker.jsx'

const WELCOME = {
  role: 'assistant',
  content:
    'Hi! I can presign URLs, invoke AWS & REST APIs, inspect your history and favorites, and explain recent failures — using the same SignBridge engine as the dashboard.\n\nAsk me something like *"presign a DescribeInstances call"* or *"re-run my last request and tell me what failed."* I\'ll ask which profile to use when it matters.',
  streaming: false
}

// Conversation starters shown on an empty chat. These are the built-in defaults;
// each user can edit/add/remove their own set, persisted in their settings.json
// under `chatSuggestions` (see loadSuggestions / saveSuggestions below).
const DEFAULT_SUGGESTIONS = [
  'Presign a DescribeInstances call on EC2 for 1 hour',
  'Show my last 3 requests and their status',
  'Re-invoke my most recent request and summarize the response',
  'Which of my profiles use SSO?'
]

// Pull an optional ```quickreplies fenced JSON block out of an assistant message.
// Returns { text, quickReplies } where text has the block removed and quickReplies
// is { prompt, options:[{label,value}] } or null. The agent uses this to ask the
// user to choose a profile / auth mechanism via clickable chips.
function parseQuickReplies(content) {
  if (!content || typeof content !== 'string') return { text: content, quickReplies: null }
  const match = content.match(/```quickreplies\s*([\s\S]*?)```/i)
  if (!match) return { text: content, quickReplies: null }
  let quickReplies = null
  try {
    const parsed = JSON.parse(match[1].trim())
    if (parsed && Array.isArray(parsed.options)) {
      quickReplies = parsed
    }
  } catch {
    quickReplies = null
  }
  const text = content.replace(match[0], '').trim()
  return { text, quickReplies }
}

// Render every link in chat Markdown so it opens in a new tab/window and never
// navigates away from (or disturbs) the current SignBridge session — e.g. an
// SSO "Authorize Access" link or a presigned URL.
const MARKDOWN_COMPONENTS = {
  a({ node, children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  }
}

// A single transcript message. Assistant messages render Markdown and may carry
// a live list of tool-call chips plus quick-reply buttons.
function Message({ message, onQuickReply, disabled }) {
  if (message.role === 'user') {
    return (
      <div className="d-flex justify-content-end mb-2">
        <div className="px-3 py-2 rounded bg-primary text-white" style={{ maxWidth: '85%' }}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
        </div>
      </div>
    )
  }

  const { text, quickReplies } = parseQuickReplies(message.content)

  return (
    <div className="d-flex justify-content-start mb-2">
      <div className="px-3 py-2 rounded bg-white border" style={{ maxWidth: '95%' }}>
        {message.tools && message.tools.length > 0 ? (
          <div className="d-flex flex-wrap gap-1 mb-2">
            {message.tools.map((tool, index) => (
              <Badge
                key={index}
                bg={tool.status === 'error' ? 'danger' : tool.status === 'running' ? 'warning' : 'success'}
                text={tool.status === 'running' ? 'dark' : undefined}
              >
                {tool.status === 'running' ? '⏳' : tool.status === 'error' ? '⚠' : '✓'} {tool.name}
              </Badge>
            ))}
          </div>
        ) : null}
        {text ? (
          <div className="chat-markdown small">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
          </div>
        ) : message.streaming ? (
          <Spinner animation="grow" size="sm" />
        ) : null}
        {quickReplies && !message.streaming ? (
          <div className="mt-2">
            {quickReplies.prompt ? <div className="small text-muted mb-1">{quickReplies.prompt}</div> : null}
            <div className="d-flex flex-wrap gap-1">
              {quickReplies.options.map((option, index) => (
                <Button
                  key={index}
                  size="sm"
                  variant="outline-primary"
                  disabled={disabled}
                  onClick={() => onQuickReply(option.value || option.label)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ChatPanel can run standalone (manages its own thread) or controlled by a parent
// page that owns the current threadId and a session list (the /chat page).
//   activeProfile   — the dashboard's selected profile (per-turn context for the agent)
//   threadId        — controlled current thread id (optional)
//   onThreadChange  — called with a new/started threadId so the parent can track it
//   onActivity      — called after a turn completes / new chat, so a sidebar can refresh
//   showNewChat     — show the built-in "New chat" header button (default true)
export default function ChatPanel({
  activeProfile,
  threadId: controlledThreadId,
  onThreadChange,
  onActivity,
  showNewChat = true
}) {
  const [messages, setMessages] = useState([WELCOME])
  // The provider+model the picker resolved, sent with each turn. Held in a ref as
  // well so submitMessage reads the current value without being re-created (and
  // without the socket effects that close over it going stale).
  const [modelChoice, setModelChoice] = useState(null)
  const modelChoiceRef = useRef(null)
  modelChoiceRef.current = modelChoice
  // Reported by ModelPicker once it has loaded the LLM settings. Chat is the one
  // feature that cannot work until the user supplies a provider API key of their
  // own, so say that here instead of letting them type a question and get a 503.
  const [llmStatus, setLlmStatus] = useState(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [needsSetup, setNeedsSetup] = useState(false)
  const [uncontrolledThreadId, setUncontrolledThreadId] = useState(null)

  // User-editable conversation starters (persisted in settings.json).
  const [suggestions, setSuggestions] = useState(DEFAULT_SUGGESTIONS)
  // When set, the starter editor modal is open. `drafts` holds the working copy.
  const [editingSuggestions, setEditingSuggestions] = useState(false)
  const [drafts, setDrafts] = useState(DEFAULT_SUGGESTIONS)
  const [savingSuggestions, setSavingSuggestions] = useState(false)

  const isControlled = controlledThreadId !== undefined
  const threadId = isControlled ? controlledThreadId : uncontrolledThreadId

  const scrollRef = useRef(null)
  const abortRef = useRef(null)
  // Index of the assistant message currently being streamed into.
  const streamingIndexRef = useRef(null)
  // Ignore stray socket events for turns we've abandoned (stop / unmount).
  const activeTurnRef = useRef(false)
  // The thread id events must match to be applied (guards against late events
  // from a previous thread after the user switches sessions).
  const currentThreadRef = useRef(threadId)

  const userName = useMemo(() => getUserName(), [])

  // Load this user's saved conversation starters. Fall back to the built-in
  // defaults when none are stored yet (or on any read error).
  useEffect(() => {
    let cancelled = false
    populateSettingsDetails()
      .then(data => {
        if (cancelled) return
        const stored = data?.chatSuggestions
        if (Array.isArray(stored)) {
          setSuggestions(stored)
        }
      })
      .catch(() => {
        // Keep defaults on error.
      })
    return () => {
      cancelled = true
    }
  }, [])

  function openSuggestionEditor() {
    // Seed the editor with the current set (or defaults if the user cleared them).
    setDrafts(suggestions.length ? suggestions.slice() : [''])
    setEditingSuggestions(true)
  }

  function updateDraft(index, value) {
    setDrafts(current => current.map((item, i) => (i === index ? value : item)))
  }

  function addDraft() {
    setDrafts(current => [...current, ''])
  }

  function removeDraft(index) {
    setDrafts(current => current.filter((_, i) => i !== index))
  }

  function resetDraftsToDefaults() {
    setDrafts(DEFAULT_SUGGESTIONS.slice())
  }

  async function saveSuggestions() {
    // Drop blank/whitespace-only entries and de-dupe while preserving order.
    const cleaned = []
    const seen = new Set()
    for (const item of drafts) {
      const trimmed = (item || '').trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      cleaned.push(trimmed)
    }
    setSavingSuggestions(true)
    setError('')
    try {
      await updateSettingsDetails({ chatSuggestions: cleaned })
      setSuggestions(cleaned)
      setEditingSuggestions(false)
    } catch (saveError) {
      setError(
        saveError.response?.data?.message ||
          saveError.message ||
          'Failed to save conversation starters.'
      )
    } finally {
      setSavingSuggestions(false)
    }
  }

  function setThreadId(next) {
    currentThreadRef.current = next
    if (isControlled) {
      if (onThreadChange) onThreadChange(next)
    } else {
      setUncontrolledThreadId(next)
    }
  }

  // When the controlled thread changes (sidebar navigation), load its transcript.
  useEffect(() => {
    if (!isControlled) return
    currentThreadRef.current = controlledThreadId
    let cancelled = false
    if (!controlledThreadId) {
      setMessages([WELCOME])
      setError('')
      return
    }
    getChatThread(controlledThreadId)
      .then(thread => {
        if (cancelled) return
        const loaded = (thread.messages || []).map(m => ({ role: m.role, content: m.content }))
        setMessages(loaded.length ? loaded : [WELCOME])
        setError('')
      })
      .catch(() => {
        if (!cancelled) setMessages([WELCOME])
      })
    return () => {
      cancelled = true
    }
  }, [controlledThreadId, isControlled])

  // Subscribe to this user's chat stream. Events: start, token, tool_start,
  // tool_end, error, done — each tagged with threadId.
  useEffect(() => {
    const socket = getSocket()
    const eventName = `event_chat_stream_${userName}`

    function updateStreamingMessage(mutator) {
      const index = streamingIndexRef.current
      if (index == null) return
      setMessages(current => {
        const next = current.slice()
        if (!next[index]) return current
        next[index] = mutator({ ...next[index] })
        return next
      })
    }

    function onStream(payload) {
      if (!activeTurnRef.current) return
      // Drop events for a thread the user has navigated away from.
      if (payload.threadId && currentThreadRef.current && payload.threadId !== currentThreadRef.current) return
      switch (payload.type) {
        case 'token':
          updateStreamingMessage(message => ({
            ...message,
            content: (message.content || '') + payload.token
          }))
          break
        case 'tool_start':
          updateStreamingMessage(message => ({
            ...message,
            tools: [...(message.tools || []), { name: payload.name, status: 'running' }]
          }))
          break
        case 'tool_end':
          updateStreamingMessage(message => {
            const tools = (message.tools || []).slice()
            // Mark the last running instance of this tool as done/errored.
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (tools[i].name === payload.name && tools[i].status === 'running') {
                tools[i] = { ...tools[i], status: payload.ok ? 'done' : 'error' }
                break
              }
            }
            return { ...message, tools }
          })
          break
        case 'error':
          setError(payload.message || 'Chat failed.')
          break
        default:
          break
      }
    }

    socket.on(eventName, onStream)
    return () => {
      socket.off(eventName, onStream)
    }
  }, [userName])

  // Keep the transcript scrolled to the newest message.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  async function submitMessage(text) {
    const userText = text.trim()
    if (!userText || loading) return

    setInput('')
    setError('')
    setNeedsSetup(false)
    setLoading(true)
    activeTurnRef.current = true

    // Append the user message + a placeholder assistant message to stream into.
    setMessages(current => {
      const next = [...current, { role: 'user', content: userText }]
      streamingIndexRef.current = next.length
      next.push({ role: 'assistant', content: '', tools: [], streaming: true })
      return next
    })

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const result = await sendChatMessage(
        userText,
        activeProfile,
        threadId,
        controller.signal,
        modelChoiceRef.current
      )
      if (result.threadId && result.threadId !== threadId) setThreadId(result.threadId)
      // Reconcile with the canonical answer from the HTTP response (covers any
      // tokens missed by the socket and marks the message complete).
      const index = streamingIndexRef.current
      setMessages(current => {
        const next = current.slice()
        if (next[index]) {
          next[index] = {
            ...next[index],
            content: result.answer || next[index].content || '(no response)',
            streaming: false
          }
        }
        return next
      })
      if (onActivity) onActivity(result.threadId || threadId)
    } catch (chatError) {
      // A user-initiated stop aborts the request; onStop already updated the UI.
      if (controller.signal.aborted) return
      const message =
        chatError.response?.data?.message || chatError.message || 'Chat request failed.'
      setError(message)
      // A 503 with needsLlmSetup means no usable provider/model — an error the user
      // can fix, so the alert offers the page that fixes it rather than just the text.
      // needsModelChange is the same idea one step further in: the provider works,
      // the chosen model cannot do tool-calling chat, and the picker is right here.
      const data = chatError.response?.data
      setNeedsSetup(!!data?.needsLlmSetup || !!data?.needsModelChange)
      const index = streamingIndexRef.current
      setMessages(current => {
        const next = current.slice()
        if (next[index]) {
          next[index] = { ...next[index], streaming: false }
          if (!next[index].content) {
            next.splice(index, 1)
          }
        }
        return next
      })
    } finally {
      activeTurnRef.current = false
      streamingIndexRef.current = null
      abortRef.current = null
      setLoading(false)
    }
  }

  function onSubmit(event) {
    event.preventDefault()
    submitMessage(input)
  }

  function onStop() {
    activeTurnRef.current = false
    if (abortRef.current) abortRef.current.abort()
    const index = streamingIndexRef.current
    if (index != null) {
      setMessages(current => {
        const next = current.slice()
        if (next[index]) {
          next[index] = { ...next[index], streaming: false }
          if (!next[index].content) next[index].content = '_Stopped._'
        }
        return next
      })
    }
    setLoading(false)
  }

  async function onNewChat() {
    if (loading) return
    try {
      const result = await newChatThread()
      setThreadId(result.threadId || null)
    } catch {
      setThreadId(null)
    }
    setMessages([WELCOME])
    setError('')
    if (onActivity) onActivity(null)
  }

  return (
    <Card className="h-100">
      <Card.Header className="d-flex justify-content-between align-items-center">
        <div>
          <strong>SignBridge Chat</strong>
          <div className="small text-muted">
            {activeProfile?.profileName
              ? `profile: ${activeProfile.profileName} (${activeProfile.authnMode})`
              : 'no dashboard profile selected — I\'ll ask which to use'}
          </div>
        </div>
        <div className="d-flex align-items-center gap-2">
          {/* Which model is about to answer, changeable in place. Persists to
              Settings, so the choice made here is the choice everywhere. */}
          <ModelPicker
            onChange={setModelChoice}
            onStatus={setLlmStatus}
            disabled={loading}
            align="end"
          />
          {showNewChat ? (
            <Button size="sm" variant="outline-secondary" onClick={onNewChat} disabled={loading}>
              New chat
            </Button>
          ) : null}
        </div>
      </Card.Header>
      <Card.Body className="d-flex flex-column gap-2">
        <div
          ref={scrollRef}
          className="flex-grow-1 overflow-auto border rounded p-2 bg-light"
          style={{ minHeight: 280 }}
        >
          {messages.map((message, index) => (
            <Message key={index} message={message} onQuickReply={submitMessage} disabled={loading} />
          ))}
        </div>

        {messages.length <= 1 ? (
          <div>
            <div className="d-flex justify-content-between align-items-center mb-1">
              <span className="small text-muted">Conversation starters</span>
              <Button
                size="sm"
                variant="link"
                className="p-0 text-decoration-none"
                onClick={openSuggestionEditor}
              >
                Edit
              </Button>
            </div>
            {suggestions.length ? (
              <div className="d-flex flex-wrap gap-1">
                {suggestions.map(suggestion => (
                  <Button
                    key={suggestion}
                    size="sm"
                    variant="outline-primary"
                    onClick={() => submitMessage(suggestion)}
                    disabled={loading}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="small text-muted">
                No conversation starters. Click <strong>Edit</strong> to add your own.
              </div>
            )}
          </div>
        ) : null}

        {llmStatus?.needsSetup && !error ? (
          <Alert variant="warning" className="mb-2 py-2 small">
            <strong>Chat needs an AI provider.</strong>{' '}
            {llmStatus.message ||
              'Pick a provider and add its API key to start chatting.'}{' '}
            <Alert.Link as={Link} to={appPath('/settings')}>
              Open Settings → AI features
            </Alert.Link>
            . SignBridge never ships a key of its own, and there is no environment
            variable or config file that can supply one — the key is yours, and it
            is stored encrypted on this machine.
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="danger" className="mb-0 py-1 small" dismissible onClose={() => setError('')}>
            {error}
            {needsSetup ? (
              <>
                {' '}
                <Alert.Link as={Link} to={appPath('/settings')}>
                  Open Settings to connect an AI provider
                </Alert.Link>
              </>
            ) : null}
          </Alert>
        ) : null}

        <Form onSubmit={onSubmit} className="d-flex gap-2">
          <Form.Control
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder="Ask SignBridge..."
            disabled={loading}
            autoComplete="off"
          />
          {loading ? (
            <Button type="button" variant="outline-danger" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              Send
            </Button>
          )}
        </Form>
      </Card.Body>

      <Modal show={editingSuggestions} onHide={() => setEditingSuggestions(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>Edit conversation starters</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="small text-muted mb-2">
            These are the quick-start prompts shown on a new chat. Add, edit, or remove
            them — they're saved to your settings and shown every time.
          </div>
          {drafts.length ? (
            <div className="d-flex flex-column gap-2">
              {drafts.map((draft, index) => (
                <div key={index} className="d-flex gap-2">
                  <Form.Control
                    value={draft}
                    onChange={event => updateDraft(index, event.target.value)}
                    placeholder="Enter a conversation starter"
                    autoComplete="off"
                  />
                  <Button
                    variant="outline-danger"
                    onClick={() => removeDraft(index)}
                    title="Remove"
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="small text-muted">No starters yet — add one below.</div>
          )}
          <div className="mt-2 d-flex gap-2">
            <Button size="sm" variant="outline-primary" onClick={addDraft}>
              + Add starter
            </Button>
            <Button size="sm" variant="outline-secondary" onClick={resetDraftsToDefaults}>
              Reset to defaults
            </Button>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            onClick={() => setEditingSuggestions(false)}
            disabled={savingSuggestions}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={saveSuggestions} disabled={savingSuggestions}>
            {savingSuggestions ? 'Saving…' : 'Save'}
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  )
}
